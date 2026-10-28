import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL_IDLE_MS,
  TERMINAL_MAX_MS,
  TERMINAL_OUTPUT_CAP,
  assertOsUser,
  assertShell,
  exchangeTerminal,
  expireSessionIfNeeded,
  openTerminalSession,
  pushTerminalInput,
  requestTerminalClose,
  requestTerminalSignal,
  requestTerminalUser,
  resetTerminalSessions,
  sessionForDevice,
  terminalSpec,
  waitForTerminalOutput
} from '../src/utils/terminalSession';

describe('terminal sessions', () => {
  beforeEach(() => resetTerminalSessions());

  test('account names are allow-listed and Windows cannot switch', () => {
    assert.equal(assertOsUser('alice', 'linux'), 'alice');
    assert.equal(assertOsUser(' ec2-user ', 'linux'), 'ec2-user');
    assert.equal(assertOsUser('', 'linux'), '');
    for (const bad of ['root;id', '$(id)', '../root', '-rf', 'Alice', 'user name']) {
      assert.throws(() => assertOsUser(bad, 'linux'), /account name/);
    }
    assert.throws(() => assertOsUser('alice', 'windows'), /service account/);
    assert.equal(assertShell('sh', 'linux'), 'sh');
    assert.throws(() => assertShell('zsh', 'linux'), /Unknown shell/);
    assert.equal(terminalSpec('bash', 'alice'), 'v=1\nshell=bash\nuser=alice\n');
  });

  test('keystrokes are delivered once and do not stay queued', async () => {
    const session = openTerminalSession({ deviceId: 1, jobId: 9, os: 'linux', shell: 'bash', user: '' });
    pushTerminalInput(session, 'y\r');
    const first = await exchangeTerminal(session, { alive: true, user: 'root', privileged: true, tty: true }, 0);
    assert.equal(Buffer.from(first.input, 'base64').toString('utf8'), 'y\r');
    assert.equal(session.status, 'open');
    const second = await exchangeTerminal(session, { alive: true }, 0);
    assert.equal(second.input, '');
  });

  test('a waiting agent receives input that arrives mid-poll', async () => {
    const session = openTerminalSession({ deviceId: 2, jobId: 10, os: 'linux', shell: 'bash', user: 'root' });
    const pending = exchangeTerminal(session, { alive: true, privileged: true }, 2000);
    await new Promise(resolve => setTimeout(resolve, 30));
    pushTerminalInput(session, 'n');
    const instruction = await pending;
    assert.equal(Buffer.from(instruction.input, 'base64').toString('utf8'), 'n');
  });

  test('output is appended for the browser and trimmed output forces a reset', async () => {
    const session = openTerminalSession({ deviceId: 3, jobId: 11, os: 'linux', shell: 'bash', user: '' });
    await exchangeTerminal(session, { alive: true, output: Buffer.from('Password: ').toString('base64'), tty: true }, 0);
    const view = await waitForTerminalOutput(session, 0, 0);
    assert.equal(view.output, 'Password: ');
    assert.equal(view.tty, true);
    const tail = await waitForTerminalOutput(session, view.next, 0);
    assert.equal(tail.output, '');
    assert.equal(tail.reset, false);

    const chunk = Buffer.from('x'.repeat(200_000)).toString('base64');
    await exchangeTerminal(session, { alive: true, output: chunk }, 0);
    await exchangeTerminal(session, { alive: true, output: chunk }, 0);
    const reset = await waitForTerminalOutput(session, 0, 0);
    assert.equal(reset.reset, true);
    assert.ok(reset.output.length <= TERMINAL_OUTPUT_CAP);
  });

  test('user switch is queued once, and a non-root agent is refused', async () => {
    const session = openTerminalSession({ deviceId: 4, jobId: 12, os: 'linux', shell: 'bash', user: '' });
    await exchangeTerminal(session, { alive: true, privileged: false, user: 'agent' }, 0);
    assert.throws(() => requestTerminalUser(session, 'root'), /not root/);

    const root = openTerminalSession({ deviceId: 5, jobId: 13, os: 'linux', shell: 'bash', user: 'root' });
    await exchangeTerminal(root, { alive: true, privileged: true, user: 'root' }, 0);
    assert.equal(requestTerminalUser(root, 'alice'), 'alice');
    requestTerminalSignal(root, 'INT');
    const instruction = await exchangeTerminal(root, { alive: true }, 0);
    assert.equal(instruction.user, 'alice');
    assert.equal(instruction.signal, 'INT');
    const again = await exchangeTerminal(root, { alive: true }, 0);
    assert.equal(again.user, null);
    assert.equal(again.signal, null);
  });

  test('one open session per device, and closing wakes the agent', async () => {
    const session = openTerminalSession({ deviceId: 6, jobId: 14, os: 'linux', shell: 'bash', user: '' });
    const same = openTerminalSession({ deviceId: 6, jobId: 99, os: 'linux', shell: 'sh', user: 'alice' });
    assert.equal(same.id, session.id);
    assert.equal(same.jobId, 14);
    const pending = exchangeTerminal(session, { alive: true }, 2000);
    requestTerminalClose(session);
    const instruction = await pending;
    assert.equal(instruction.close, true);
    assert.equal(session.status, 'open');

    const starting = openTerminalSession({ deviceId: 60, jobId: 61, os: 'linux', shell: 'bash', user: '' });
    requestTerminalClose(starting);
    assert.equal(starting.status, 'closed');
    assert.equal(sessionForDevice(60), null);
  });

  test('idle, silence and the time limit close a live session', async () => {
    const session = openTerminalSession({ deviceId: 7, jobId: 15, os: 'linux', shell: 'bash', user: '' });
    await exchangeTerminal(session, { alive: true, privileged: true, user: 'root' }, 0);
    assert.equal(expireSessionIfNeeded(session, Date.now() + 20_000), null);
    assert.match(expireSessionIfNeeded(session, Date.now() + 30_000) || '', /stopped answering/);

    const idle = openTerminalSession({ deviceId: 8, jobId: 16, os: 'linux', shell: 'bash', user: '' });
    await exchangeTerminal(idle, { alive: true }, 0);
    assert.match(expireSessionIfNeeded(idle, Date.now() + TERMINAL_IDLE_MS + 1000) || '', /15 minutes/);

    const limited = openTerminalSession({ deviceId: 9, jobId: 17, os: 'linux', shell: 'bash', user: '' });
    assert.match(expireSessionIfNeeded(limited, Date.now() + TERMINAL_MAX_MS + 1000) || '', /4 hour/);
  });
});
