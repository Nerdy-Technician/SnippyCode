#!/usr/bin/env node
// Copy agent/pty_session.py and agent/pty_session.ps1 into the single-file agents.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, text) => fs.writeFileSync(path.join(root, file), text);

const sh = read('agent/snippycode-agent.sh');
const open = "<<'SNIPPY_PTY_PY'\n";
const start = sh.indexOf(open) + open.length;
const end = sh.indexOf('\nSNIPPY_PTY_PY\n', start) + 1;
let py = read('agent/pty_session.py');
if (!py.endsWith('\n')) py += '\n';
write('agent/snippycode-agent.sh', sh.slice(0, start) + py + sh.slice(end));

const ps = read('agent/snippycode-agent.ps1');
const b64 = fs.readFileSync(path.join(root, 'agent/pty_session.ps1')).toString('base64');
const lines = b64.match(/.{1,100}/g).map(part => `  '${part}'`).join('\n');
const next = ps.replace(/\$PtyHelperB64 = @\(\n[\s\S]*?\n\) -join ''/, `$PtyHelperB64 = @(\n${lines}\n) -join ''`);
write('agent/snippycode-agent.ps1', next);
