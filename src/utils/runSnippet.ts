import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

type Runner = {
  bin: string;
  ext: string;
};

const RUNNERS: { [language: string]: Runner } = {
  bash: { bin: 'bash', ext: 'sh' },
  sh: { bin: 'bash', ext: 'sh' },
  shell: { bin: 'bash', ext: 'sh' },
  python: { bin: 'python3', ext: 'py' },
  javascript: { bin: 'node', ext: 'js' },
  js: { bin: 'node', ext: 'js' }
};

const MAX_OUTPUT = 64_000;
const MAX_CODE = 50_000;

export const isSnippetRunEnabled = (): boolean =>
  process.env.SNIPPET_RUN_ENABLED === 'true';

export const snippetRunTimeoutMs = (): number => {
  const timeout = Number(process.env.SNIPPET_RUN_TIMEOUT_MS) || 15000;

  return Math.min(Math.max(timeout, 1000), 60_000);
};

export const snippetRunLanguages = (): string[] => Object.keys(RUNNERS);

export const runnerPublicSettings = () => ({
  enabled: isSnippetRunEnabled(),
  languages: snippetRunLanguages(),
  timeoutMs: snippetRunTimeoutMs()
});

const clip = (value: string): string =>
  value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n...[truncated]` : value;

export const runSnippetCode = async (
  language: string,
  code: string
): Promise<{
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  language: string;
}> => {
  const runner = RUNNERS[language.trim().toLowerCase()];

  if (!runner) {
    throw new Error(
      `Running ${language || 'this language'} on the server is not supported`
    );
  }

  if (!code.trim()) {
    throw new Error('Snippet has no code to run');
  }

  if (code.length > MAX_CODE) {
    throw new Error('Snippet is too large to run on the server');
  }

  const dir = await mkdtemp(join(tmpdir(), 'snippycode-run-'));
  const file = join(dir, `snippet.${runner.ext}`);

  try {
    await writeFile(file, code, { mode: 0o600 });

    return await new Promise(resolve => {
      const child = spawn(runner.bin, [file], {
        cwd: dir,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: dir,
          LANG: 'C'
        } as unknown as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      child.stdin.end();

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, snippetRunTimeoutMs());

      child.stdout.on('data', chunk => {
        stdout += String(chunk);
      });
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
      });

      child.on('error', err => {
        clearTimeout(timer);
        resolve({
          ok: false,
          timedOut: false,
          exitCode: null,
          stdout: '',
          stderr: err.message,
          language: language.trim().toLowerCase()
        });
      });

      child.on('close', code => {
        clearTimeout(timer);
        resolve({
          ok: !timedOut && code === 0,
          timedOut,
          exitCode: timedOut ? null : code,
          stdout: clip(stdout),
          stderr: timedOut
            ? clip(`${stderr}\nProcess timed out after ${snippetRunTimeoutMs()}ms`)
            : clip(stderr),
          language: language.trim().toLowerCase()
        });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
