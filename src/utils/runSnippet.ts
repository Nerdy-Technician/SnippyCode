import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

type Runner = {
  bin: string;
  ext: string;
  /** Docker image used in the docker sandbox */
  image: string;
};

const RUNNERS: { [language: string]: Runner } = {
  bash: { bin: 'bash', ext: 'sh', image: 'bash:5' },
  sh: { bin: 'bash', ext: 'sh', image: 'bash:5' },
  shell: { bin: 'bash', ext: 'sh', image: 'bash:5' },
  python: { bin: 'python3', ext: 'py', image: 'python:3.12-alpine' },
  javascript: { bin: 'node', ext: 'js', image: 'node:22-alpine' },
  js: { bin: 'node', ext: 'js', image: 'node:22-alpine' },
  powershell: { bin: 'pwsh', ext: 'ps1', image: 'mcr.microsoft.com/powershell:lts-alpine-3.20' }
};

const MAX_OUTPUT = 64_000;
const MAX_CODE = 50_000;

export type SandboxMode = 'bwrap' | 'docker' | 'none';

export interface RunResult {
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  language: string;
  sandbox: SandboxMode;
}

export const isSnippetRunEnabled = (): boolean =>
  process.env.SNIPPET_RUN_ENABLED === 'true';

export const snippetRunTimeoutMs = (): number => {
  const timeout = Number(process.env.SNIPPET_RUN_TIMEOUT_MS) || 15000;

  return Math.min(Math.max(timeout, 1000), 60_000);
};

const memoryLimitMb = (): number =>
  Math.min(Math.max(Number(process.env.SNIPPET_RUN_MEMORY_MB) || 256, 32), 4096);

const processLimit = (): number =>
  Math.min(Math.max(Number(process.env.SNIPPET_RUN_MAX_PROCESSES) || 64, 4), 1024);

const networkAllowed = (): boolean => process.env.SNIPPET_RUN_NETWORK === 'true';

const onPath = (bin: string): boolean =>
  String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')
    .split(delimiter)
    .some(dir => dir && existsSync(join(dir, bin)));

// Sandbox detection --------------------------------------------------------

let detected: { mode: SandboxMode; reason: string } | null = null;

const probe = (command: string, args: string[]): boolean => {
  try {
    const result = spawnSync(command, args, { timeout: 8000, stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
};

const bwrapWorks = (): boolean =>
  onPath('bwrap') &&
  probe('bwrap', [
    '--die-with-parent',
    '--unshare-all',
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    'true'
  ]);

const dockerWorks = (): boolean =>
  onPath('docker') && probe('docker', ['version', '--format', '{{.Server.Version}}']);

/**
 * SNIPPET_RUN_SANDBOX: 'auto' (default) tries bubblewrap, then Docker, then
 * runs without isolation. 'bwrap', 'docker', or 'none' force a mode.
 */
export const detectSandbox = (refresh = false): { mode: SandboxMode; reason: string } => {
  if (detected && !refresh) {
    return detected;
  }

  const wanted = String(process.env.SNIPPET_RUN_SANDBOX || 'auto').toLowerCase();

  if (wanted === 'none') {
    detected = { mode: 'none', reason: 'Disabled with SNIPPET_RUN_SANDBOX=none' };
  } else if (wanted === 'bwrap') {
    detected = bwrapWorks()
      ? { mode: 'bwrap', reason: 'bubblewrap' }
      : { mode: 'none', reason: 'SNIPPET_RUN_SANDBOX=bwrap but bubblewrap cannot create namespaces here' };
  } else if (wanted === 'docker') {
    detected = dockerWorks()
      ? { mode: 'docker', reason: 'Docker' }
      : { mode: 'none', reason: 'SNIPPET_RUN_SANDBOX=docker but the Docker daemon is not reachable' };
  } else if (bwrapWorks()) {
    detected = { mode: 'bwrap', reason: 'bubblewrap (auto)' };
  } else if (dockerWorks()) {
    detected = { mode: 'docker', reason: 'Docker (auto)' };
  } else {
    detected = {
      mode: 'none',
      reason: 'No sandbox available: install bubblewrap or give SnippyCode access to Docker'
    };
  }

  return detected;
};

export const snippetRunLanguages = (): string[] => {
  const { mode } = detectSandbox();

  // Docker brings its own interpreters; otherwise they must be installed here
  return Object.keys(RUNNERS).filter(
    language => mode === 'docker' || onPath(RUNNERS[language].bin)
  );
};

export const runnerPublicSettings = () => {
  const sandbox = detectSandbox();

  return {
    enabled: isSnippetRunEnabled(),
    languages: snippetRunLanguages(),
    timeoutMs: snippetRunTimeoutMs(),
    sandbox: sandbox.mode,
    sandboxReason: sandbox.reason,
    memoryMb: memoryLimitMb(),
    network: networkAllowed()
  };
};

// Command building ---------------------------------------------------------

export interface SandboxCommand {
  command: string;
  args: string[];
  /** Code is written to stdin instead of a file (docker) */
  codeOnStdin: boolean;
  containerName?: string;
}

// ulimit keeps memory, processes and file size in check inside the sandbox.
// Node reserves a large address space up front, so it gets a heap cap instead.
const limitedExec = (runner: Runner, file: string): string[] => {
  const kb = memoryLimitMb() * 1024;
  const vm = runner.bin === 'node' || runner.bin === 'pwsh' ? '' : `ulimit -v ${kb} 2>/dev/null; `;
  const nodeHeap = runner.bin === 'node' ? ` --max-old-space-size=${memoryLimitMb()}` : '';

  return [
    '/bin/sh',
    '-c',
    // dash spells the process limit -p, bash and busybox -u
    `${vm}ulimit -u ${processLimit()} 2>/dev/null || ulimit -p ${processLimit()} 2>/dev/null; ulimit -f 10240 2>/dev/null; exec ${runner.bin}${nodeHeap} "$0"`,
    file
  ];
};

export const buildSandboxCommand = (
  mode: SandboxMode,
  runner: Runner,
  hostFile: string
): SandboxCommand => {
  if (mode === 'docker') {
    const containerName = `snippycode-run-${randomBytes(6).toString('hex')}`;
    const inner = `/tmp/snippet.${runner.ext}`;
    const nodeHeap = runner.bin === 'node' ? ` --max-old-space-size=${memoryLimitMb()}` : '';

    return {
      command: 'docker',
      codeOnStdin: true,
      containerName,
      args: [
        'run', '--rm', '-i',
        '--name', containerName,
        '--network', networkAllowed() ? 'bridge' : 'none',
        '--memory', `${memoryLimitMb()}m`,
        '--memory-swap', `${memoryLimitMb()}m`,
        '--cpus', '1',
        '--pids-limit', String(processLimit()),
        '--read-only',
        '--tmpfs', '/tmp:rw,size=64m,exec',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', '65534:65534',
        '--env', 'HOME=/tmp',
        '--workdir', '/tmp',
        runner.image,
        'sh', '-c', `cat > ${inner}; exec ${runner.bin}${nodeHeap} ${inner} </dev/null`
      ]
    };
  }

  const inner = `/work/snippet.${runner.ext}`;

  if (mode === 'bwrap') {
    const bind = (flag: string, path: string, target = path) =>
      existsSync(path) ? [flag, path, target] : [];

    return {
      command: 'bwrap',
      codeOnStdin: false,
      args: [
        '--die-with-parent',
        '--new-session',
        '--unshare-all',
        ...(networkAllowed() ? ['--share-net'] : []),
        '--uid', '65534',
        '--gid', '65534',
        ...bind('--ro-bind', '/usr'),
        ...bind('--ro-bind', '/bin'),
        ...bind('--ro-bind', '/sbin'),
        ...bind('--ro-bind', '/lib'),
        ...bind('--ro-bind', '/lib64'),
        ...bind('--ro-bind', '/lib32'),
        ...bind('--ro-bind', '/etc/alternatives'),
        ...bind('--ro-bind', '/etc/ssl'),
        ...bind('--ro-bind', '/etc/ca-certificates'),
        ...(networkAllowed() ? bind('--ro-bind', '/etc/resolv.conf') : []),
        '--proc', '/proc',
        '--dev', '/dev',
        '--tmpfs', '/tmp',
        '--dir', '/work',
        '--ro-bind', hostFile, inner,
        '--chdir', '/tmp',
        '--clearenv',
        '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
        '--setenv', 'HOME', '/tmp',
        '--setenv', 'LANG', 'C.UTF-8',
        ...limitedExec(runner, inner)
      ]
    };
  }

  const [shell, ...rest] = limitedExec(runner, hostFile);
  return { command: shell, args: rest, codeOnStdin: false };
};

// Running ------------------------------------------------------------------

const capped = () => {
  let value = '';
  let dropped = false;

  return {
    add: (chunk: Buffer) => {
      if (value.length < MAX_OUTPUT) {
        value += chunk.toString('utf8');
      } else {
        dropped = true;
      }
    },
    text: () =>
      value.length > MAX_OUTPUT || dropped
        ? `${value.slice(0, MAX_OUTPUT)}\n...[truncated]`
        : value
  };
};

export const runSnippetCode = async (language: string, code: string): Promise<RunResult> => {
  const key = language.trim().toLowerCase();
  const runner = RUNNERS[key];

  if (!runner) {
    throw new Error(`Running ${language || 'this language'} on the server is not supported`);
  }

  if (!code.trim()) {
    throw new Error('Snippet has no code to run');
  }

  if (code.length > MAX_CODE) {
    throw new Error('Snippet is too large to run on the server');
  }

  const { mode } = detectSandbox();

  if (mode !== 'docker' && !onPath(runner.bin)) {
    throw new Error(`${runner.bin} is not installed on the SnippyCode server`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'snippycode-run-'));
  const file = join(dir, `snippet.${runner.ext}`);
  const timeoutMs = snippetRunTimeoutMs();

  try {
    // Readable by the sandbox user (65534) but private to the directory
    await writeFile(file, code, { mode: 0o644 });
    const plan = buildSandboxCommand(mode, runner, file);

    return await new Promise<RunResult>(resolve => {
      const child = spawn(plan.command, plan.args, {
        cwd: dir,
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: dir,
          LANG: 'C.UTF-8'
        } as unknown as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group, so a timeout kills everything the snippet started
        detached: mode !== 'docker'
      });

      if (plan.codeOnStdin) {
        child.stdin.end(code);
      } else {
        child.stdin.end();
      }

      const stdout = capped();
      const stderr = capped();
      let timedOut = false;

      const kill = () => {
        if (plan.containerName) {
          spawn('docker', ['kill', plan.containerName], { stdio: 'ignore' }).on('error', () => undefined);
        }

        try {
          if (child.pid && mode !== 'docker') {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          child.kill('SIGKILL');
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);

      child.stdout.on('data', stdout.add);
      child.stderr.on('data', stderr.add);

      child.on('error', err => {
        clearTimeout(timer);
        resolve({
          ok: false,
          timedOut: false,
          exitCode: null,
          stdout: '',
          stderr: err.message,
          language: key,
          sandbox: mode
        });
      });

      child.on('close', exitCode => {
        clearTimeout(timer);

        // Anything the snippet left running in its group goes too
        if (mode !== 'docker' && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }

        resolve({
          ok: !timedOut && exitCode === 0,
          timedOut,
          exitCode: timedOut ? null : exitCode,
          stdout: stdout.text(),
          stderr: timedOut
            ? `${stderr.text()}\nProcess timed out after ${timeoutMs}ms`
            : stderr.text(),
          language: key,
          sandbox: mode
        });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
