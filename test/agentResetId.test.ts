/**
 * install.sh --reset-id and clone handling at script level: a fake curl and
 * id stand in for the server and root, and every path points at a temp dir.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', '..', 'agent', 'install.sh');

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-reset-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
  // CI runners have a real systemd; the installer must never touch it in a test
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Fake server: logs the enrol fields and answers with $FAKE_AGENT_ID (or echoes it)
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
out=""; enroll=0; agent=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --data-urlencode) case "$2" in agentId=*) agent="\${2#agentId=}" ;; esac; shift 2 ;;
    -H) case "$2" in X-Agent-Fingerprint:*) echo "\${2#X-Agent-Fingerprint: }" > "$LOG.fp" ;; esac; shift 2 ;;
    *enroll*) enroll=1; shift ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then echo '#!/bin/sh' > "$out"; exit 0; fi
if [ "$enroll" = 1 ]; then
  echo "$agent" >> "$LOG"
  printf 'DEVICE_ID=1\\nDEVICE_TOKEN=sc_dev_test\\nSITE=office\\nAGENT_ID=%s\\n' "\${FAKE_AGENT_ID:-$agent}"
fi
`,
    { mode: 0o755 }
  );
  const run = (args: string[], extra: Record<string, string> = {}) =>
    execFileSync('bash', [SCRIPT, '--url', 'https://sc.example', '--token', 'sc_enroll_x', ...args], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        LOG: path.join(dir, 'enrol.log'),
        SNIPPYCODE_AGENT_ID_DIR: path.join(dir, 'id'),
        SNIPPYCODE_AGENT_BIN: path.join(dir, 'agent'),
        SNIPPYCODE_AGENT_CONFIG: path.join(dir, 'agent.conf'),
        SNIPPYCODE_AGENT_UNIT: path.join(dir, 'unit'),
        ...extra
      } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8'
    });
  const stored = () => fs.readFileSync(path.join(dir, 'id', 'agent-id'), 'utf8').trim();
  return { dir, run, stored };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('install.sh agent ID', { skip: process.platform === 'win32' ? 'bash only' : false }, () => {
  test('keeps the ID on re-install and regenerates it with --reset-id', () => {
    const { dir, run, stored } = setup();
    run([]);
    const first = stored();
    assert.match(first, UUID);
    assert.equal((fs.statSync(path.join(dir, 'id', 'agent-id')).mode & 0o777).toString(8), '600');
    run([]);
    assert.equal(stored(), first, 're-install keeps the agent ID');
    run(['--reset-id']);
    assert.notEqual(stored(), first, '--reset-id gives a new one');
    assert.match(stored(), UUID);
    const sent = fs.readFileSync(path.join(dir, 'enrol.log'), 'utf8').trim().split('\n');
    assert.deepEqual(sent.slice(0, 2), [first, first]);
    assert.equal(sent[2], stored());
    // Only a sha256 hash is sent, never the raw machine ID
    assert.match(fs.readFileSync(path.join(dir, 'enrol.log.fp'), 'utf8').trim(), /^[0-9a-f]{64}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stores the fresh agent ID the server gives a clone', () => {
    const { dir, run, stored } = setup();
    run([]);
    const fresh = '12345678-1234-4123-8123-123456789abc';
    run([], { FAKE_AGENT_ID: fresh });
    assert.equal(stored(), fresh);
    // No enrolment token is ever kept on the device
    assert.ok(!fs.readFileSync(path.join(dir, 'agent.conf'), 'utf8').includes('sc_enroll_'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the agents send the fingerprint in a header, never in a URL', () => {
    for (const file of ['snippycode-agent.sh', 'install.sh', 'snippycode-agent.ps1', 'install.ps1']) {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', file), 'utf8');
      assert.ok(!/[?&]fingerprint=/.test(text), `${file} puts the fingerprint in a URL`);
      assert.ok(!/fingerprint\s*=\s*\$[Ff]ingerprint|"fingerprint=\$FINGERPRINT"/.test(text), `${file} sends it in the body`);
      assert.match(text, /X-Agent-Fingerprint/);
    }
  });
});
