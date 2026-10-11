#!/usr/bin/env node
/*
 * Signed SnippyCode agent releases (run on the release machine, not the server).
 *
 *   node scripts/agent-release.js keygen --out /secure/dir
 *     Makes an Ed25519 key pair: agent-signing.key.pem (private, 0600) and
 *     agent-signing.pub.pem. Refuses to write inside this repository.
 *
 *   node scripts/agent-release.js sign --key /secure/dir/agent-signing.key.pem [--out agent/release]
 *     Embeds the public key in both agents, then writes them with their
 *     SHA-256 and Ed25519 signature to manifest.json in --out (default
 *     agent/release, git-ignored). Copy that folder to the server's
 *     AGENT_RELEASE_DIR. The private key is only read, never copied.
 *
 *   Options: --next-pub FILE (standby key, repeatable), --allow-downgrade
 *   (pinned devices may move down to this release), --arch NAME.
 *
 *   node scripts/agent-release.js sign --key OLD.key.pem --embed-pub NEW.pub.pem
 *     Key rotation: signed with the old key (which agents trust today), with
 *     the new public key embedded, so the next release can use the new key.
 *
 *   node scripts/agent-release.js verify [--out agent/release] [--pub file]
 *     Checks the manifest: checksums, signatures, versions.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const command = args[0];
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : undefined;
};
const opts = name => args.flatMap((arg, i) => (arg === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
/** Must match src/utils/agentRelease.ts signedMessage and the agent's signed_message */
const message = e =>
  `snippycode-agent-update/v1\nfile=${e.file}\nplatform=${e.platform}\narch=${e.arch}\nversion=${e.version}\nsha256=${e.sha256}\ndowngrade=${e.downgrade ? 1 : 0}\n`;
const die = message => {
  console.error(message);
  process.exit(1);
};

const FILES = {
  'snippycode-agent.sh': { platform: 'linux', version: /^AGENT_VERSION="([^"]+)"$/m, key: /^AGENT_UPDATE_PUBKEYS="[^"]*"$/m, line: k => `AGENT_UPDATE_PUBKEYS="${k}"` },
  'snippycode-agent.ps1': { platform: 'windows', version: /^\$AgentVersion = '([^']+)'$/m, key: /^\$AgentUpdatePublicKeys = '[^']*'$/m, line: k => `$AgentUpdatePublicKeys = '${k}'` }
};

/** The public key as one line of base64 (DER SubjectPublicKeyInfo) */
const publicKeyLine = key => (key.type === 'public' ? key : crypto.createPublicKey(key)).export({ type: 'spki', format: 'der' }).toString('base64');

if (command === 'keygen') {
  const out = path.resolve(opt('out') || die('--out <dir> is required'));
  if ((out + path.sep).startsWith(repo + path.sep)) die('Refusing to write keys inside the repository.');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(out, 'agent-signing.key.pem');
  // 'wx' creates the file atomically and fails if it exists: no check-then-write race
  try {
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') die(`${keyFile} already exists; not overwriting.`);
    throw err;
  }
  fs.writeFileSync(path.join(out, 'agent-signing.pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  console.log(`Private key: ${keyFile} (keep offline)\nPublic key line: ${publicKeyLine(publicKey)}`);
} else if (command === 'sign') {
  const keyPath = opt('key') || die('--key <private key file> is required');
  const out = path.resolve(opt('out') || path.join(repo, 'agent', 'release'));
  if (process.platform !== 'win32' && (fs.statSync(keyPath).mode & 0o077)) die(`${keyPath} is readable by others; chmod 600 it first.`);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') die('The key must be Ed25519.');
  // Keys the agents will trust from now on: --embed-pub replaces the list
  // (rotation: sign with the OLD key, embed the NEW one(s)); --next-pub adds
  // a standby key next to the signing key.
  const embedded = opts('embed-pub').length
    ? opts('embed-pub').map(file => publicKeyLine(crypto.createPublicKey(fs.readFileSync(file))))
    : [publicKeyLine(privateKey), ...opts('next-pub').map(file => publicKeyLine(crypto.createPublicKey(fs.readFileSync(file))))];
  const downgrade = args.includes('--allow-downgrade');
  const arch = opt('arch') || 'any';
  fs.mkdirSync(out, { recursive: true });
  const manifest = { version: '', files: {}, publicKeys: embedded, signedBy: publicKeyLine(privateKey), signedAt: new Date().toISOString() };
  for (const [name, rule] of Object.entries(FILES)) {
    let text = fs.readFileSync(path.join(repo, 'agent', name), 'utf8');
    const version = (text.match(rule.version) || [])[1] || die(`${name}: no version line`);
    if (manifest.version && manifest.version !== version) die(`Agent versions differ (${manifest.version} vs ${version}).`);
    manifest.version = version;
    if (!rule.key.test(text)) die(`${name}: no public key line to fill`);
    text = text.replace(rule.key, rule.line(embedded.join(' ')));
    const bytes = Buffer.from(text, 'utf8');
    fs.writeFileSync(path.join(out, name), bytes, { mode: 0o644 });
    const entry = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), platform: rule.platform, arch, downgrade };
    manifest.files[name] = { ...entry, signature: crypto.sign(null, Buffer.from(message({ file: name, version, ...entry })), privateKey).toString('base64') };
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Signed agent ${manifest.version} into ${out}. Put the public key(s) in AGENT_UPDATE_PUBLIC_KEYS on the server (required in production).`);
} else if (command === 'verify') {
  const out = path.resolve(opt('out') || path.join(repo, 'agent', 'release'));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  // During a rotation the embedded keys are the new ones; pass --pub OLD.pub.pem
  const keys = opt('pub')
    ? [crypto.createPublicKey(fs.readFileSync(opt('pub')))]
    : [crypto.createPublicKey({ key: Buffer.from(manifest.signedBy, 'base64'), format: 'der', type: 'spki' })];
  for (const [name, entry] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(out, name));
    const sum = crypto.createHash('sha256').update(bytes).digest('hex');
    const msg = Buffer.from(message({ file: name, version: manifest.version, ...entry }));
    const ok = sum === entry.sha256 && keys.some(key => crypto.verify(null, msg, key, Buffer.from(entry.signature, 'base64')));
    console.log(`${ok ? 'ok  ' : 'BAD '} ${name}`);
    if (!ok) process.exitCode = 1;
  }
} else {
  die('Usage: agent-release.js keygen --out DIR | sign --key FILE [--out DIR] | verify [--out DIR] [--pub FILE]');
}
