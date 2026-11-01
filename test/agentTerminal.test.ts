import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const linux = readFileSync(join(root, 'agent/snippycode-agent.sh'), 'utf8');
const windows = readFileSync(join(root, 'agent/snippycode-agent.ps1'), 'utf8');
const helper = readFileSync(join(root, 'agent/pty_session.py'), 'utf8');
const winHelper = readFileSync(join(root, 'agent/pty_session.ps1'));

describe('agent terminal wiring', () => {
  test('one-shot jobs still run with stdin closed and PowerShell -NonInteractive', () => {
    assert.match(linux, /"\$interpreter" "\$file" <\/dev\/null/);
    assert.match(windows, /-NoProfile -NonInteractive -ExecutionPolicy Bypass -File/);
    assert.match(linux, /if \[ "\$language" = "pty" \]/);
    assert.match(windows, /if \(\$language -eq 'pty'\)/);
  });

  test('the shell agent embeds the python helper unchanged', () => {
    const start = linux.indexOf("<<'SNIPPY_PTY_PY'\n");
    const end = linux.indexOf('\nSNIPPY_PTY_PY\n', start);
    assert.ok(start > 0 && end > start);
    const embedded = linux.slice(start + "<<'SNIPPY_PTY_PY'\n".length, end + 1);
    assert.equal(embedded, helper.endsWith('\n') ? helper : `${helper}\n`);
  });

  test('agents advertise pty and identify as 1.5.0', () => {
    assert.match(linux, /AGENT_VERSION="1\.5\.0"/);
    assert.match(linux, /found="\$\{found\}pty,"/);
    assert.match(windows, /\$AgentVersion = '1\.5\.0'/);
    assert.match(windows, /@\('powershell', 'cmd', 'pty'\)/);
  });

  test('the Windows agent embeds the ConPTY helper unchanged and runs it out of process', () => {
    const block = windows.match(/\$PtyHelperB64 = @\(\n([\s\S]*?)\n\) -join ''/);
    assert.ok(block);
    const b64 = block[1].replace(/[\s']/g, '');
    assert.ok(Buffer.from(b64, 'base64').equals(winHelper));
    const text = winHelper.toString('utf8');
    assert.match(text, /CreatePseudoConsole/);
    assert.match(text, /ResizePseudoConsole/);
    assert.match(text, /WTSQueryUserToken/);
    assert.match(windows, /Start-Process -FilePath 'powershell\.exe'/);
  });

  test('the Linux helper switches with sudo -n or su when the agent is not root', () => {
    assert.match(helper, /"sudo", "-n", "-u", user, "--", "true"/);
    assert.match(helper, /su - %s/);
  });
});
