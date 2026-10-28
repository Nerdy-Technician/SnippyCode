import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer, Server } from 'http';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AddressInfo } from 'net';
import {
  exchangeTerminal,
  openTerminalSession,
  pushTerminalInput,
  requestTerminalClose,
  requestTerminalUser,
  resetTerminalSessions
} from '../src/utils/terminalSession';

const helper = join(process.cwd(), 'agent/pty_session.py');

const childEnv = (url: string): NodeJS.ProcessEnv =>
  ({
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    SNIPPYCODE_URL: url,
    SNIPPYCODE_TOKEN: 'sc_dev_test',
    SNIPPYCODE_FINGERPRINT: ''
  }) as unknown as NodeJS.ProcessEnv;

const waitFor = async (read: () => string, pattern: RegExp, timeoutMs = 8000): Promise<string> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = read();
    if (pattern.test(text)) return text;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${pattern}. Have:\n${read().slice(-800)}`);
};

describe('pty relay', () => {
  let server: Server;
  let output = '';
  const dir = mkdtempSync(join(tmpdir(), 'snippy-pty-'));

  beforeEach(async () => {
    resetTerminalSessions();
    output = '';
    const session = openTerminalSession({ deviceId: 1, jobId: 42, os: 'linux', shell: 'bash', user: '' });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const instruction = await exchangeTerminal(
          session,
          {
            output: body.output,
            user: body.user,
            alive: body.alive !== false,
            privileged: body.privileged,
            tty: body.tty,
            exitCode: body.exitCode,
            message: body.message
          },
          Math.min(Number(new URL(req.url || '', 'http://127.0.0.1').searchParams.get('wait')) || 0, 2) * 1000
        );
        output = session.output;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: instruction }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    resetTerminalSessions();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('a prompt reads the answer from the browser', async () => {
    const spec = join(dir, 'spec');
    writeFileSync(spec, 'v=1\nshell=bash\nuser=\n');
    const port = (server.address() as AddressInfo).port;
    const child = spawn('python3', [helper, '42', spec], {
      env: childEnv(`http://127.0.0.1:${port}`)
    });
    const exited = new Promise<number | null>(resolve => child.on('exit', resolve));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    try {
      await waitFor(() => output, /[#$] /);
      const session = openTerminalSession({ deviceId: 1, jobId: 42, os: 'linux', shell: 'bash', user: '' });
      pushTerminalInput(session, 'read -p "Continue? " answer; printf "got:%s\\n" "$answer"\r');
      await waitFor(() => output, /Continue\?/);
      pushTerminalInput(session, 'y\r');
      const text = await waitFor(() => output, /got:y/);
      assert.match(text, /got:y/);
      if (process.getuid?.() !== 0) {
        assert.equal(session.privileged, false);
        assert.throws(() => requestTerminalUser(session, 'root'), /not root/);
      }

      requestTerminalClose(session);
      assert.equal(await exited, 0);
    } finally {
      child.kill('SIGTERM');
    }
    assert.equal(stderr.includes('Traceback'), false, stderr);
  });

  test('refuses an account the agent cannot become', async () => {
    const spec = join(dir, 'spec-user');
    const user = process.getuid?.() === 0 ? 'nosuch-snippy-user' : 'root';
    writeFileSync(spec, `v=1\nshell=bash\nuser=${user}\n`);
    const port = (server.address() as AddressInfo).port;
    const child = spawn('python3', [helper, '42', spec], {
      env: childEnv(`http://127.0.0.1:${port}`)
    });
    const exited = new Promise<number | null>(resolve => child.on('exit', resolve));
    try {
      const text = await waitFor(() => output, /not root|no local account/);
      assert.match(text, user === 'root' ? /not root/ : /no local account/);
      assert.equal(await exited, 1);
    } finally {
      child.kill('SIGTERM');
    }
  });
});
