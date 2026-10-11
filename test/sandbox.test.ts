import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxCommand, detectSandbox, runSnippetCode } from '../src/utils/runSnippet';

const bash = { bin: 'bash', ext: 'sh', image: 'bash:5' };
const sandbox = detectSandbox();

describe('sandbox commands', () => {
  test('docker runs without network, capabilities, or a writable root', () => {
    const plan = buildSandboxCommand('docker', bash, '/tmp/x/snippet.sh');
    const args = plan.args.join(' ');

    assert.equal(plan.command, 'docker');
    assert.equal(plan.codeOnStdin, true);
    assert.match(args, /--network none/);
    assert.match(args, /--memory 256m/);
    assert.match(args, /--pids-limit 64/);
    assert.match(args, /--read-only/);
    assert.match(args, /--cap-drop ALL/);
    assert.match(args, /--user 65534:65534/);
    assert.match(args, /--security-opt no-new-privileges/);
  });

  test('bubblewrap unshares everything and clears the environment', () => {
    const plan = buildSandboxCommand('bwrap', bash, '/tmp/x/snippet.sh');
    const args = plan.args.join(' ');

    assert.equal(plan.command, 'bwrap');
    assert.match(args, /--unshare-all/);
    assert.doesNotMatch(args, /--share-net/);
    assert.match(args, /--clearenv/);
    assert.match(args, /--ro-bind \/tmp\/x\/snippet\.sh \/work\/snippet\.sh/);
  });
});

describe('sandboxed runs', { skip: sandbox.mode === 'bwrap' ? false : `bubblewrap is not usable here (${sandbox.reason})` }, () => {
  test('cannot see the server environment, home, or network', async () => {
    process.env.SESSION_SECRET_CANARY = 'canary-value-123';
    const result = await runSnippetCode(
      'bash',
      [
        'cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n" | grep -c canary-value-123 || true',
        'ls /home 2>&1 | head -1',
        '(exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null && echo NET || echo NONET',
        'id -u'
      ].join('\n')
    );

    assert.equal(result.sandbox, 'bwrap');
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '0',
      "ls: cannot access '/home': No such file or directory",
      'NONET',
      '65534'
    ]);
  });

  test('a timeout kills everything the snippet started', async () => {
    process.env.SNIPPET_RUN_TIMEOUT_MS = '1500';
    const result = await runSnippetCode('bash', 'sleep 30 & echo started; wait');
    delete process.env.SNIPPET_RUN_TIMEOUT_MS;

    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, 'started\n');
  });
});
