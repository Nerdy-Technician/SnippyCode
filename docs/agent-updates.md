# Agent updates: signing, rollout and rollback

Linux agents (1.4.0 and later) update themselves only to a release that is
**signed offline** with an Ed25519 key. The server never holds the private
key. It serves the signed files and decides *who* is offered them, and each
agent checks the file itself.

**Windows agents do not update themselves.** Windows PowerShell/.NET has no
built-in Ed25519 verifier. Trusting an `openssl.exe` found on PATH while the
agent runs as SYSTEM would let a local user plant one (binary planting), so
Windows agents are never offered an update. Update them by re-running
`install.ps1` (or through your RMM/GPO) until a native verifier ships.

## What is signed

Each agent file has a manifest entry. The signature covers this exact text,
which the release script, the server and the agent all build the same way:

```
snippycode-agent-update/v1
file=snippycode-agent.sh
platform=linux
arch=any
version=1.5.0
sha256=<hex>
downgrade=0
```

So the version, platform, arch, checksum and downgrade permission cannot be
changed without breaking the signature.

## How a Linux update works

1. On each poll the server sends `X-Agent-Latest` only when the staged
   rollout (or a pin) includes the device.
2. The agent downloads `GET /api/agent/update`. This is authenticated with
   the device token and the hardware fingerprint header (via
   `requireAgent`, so a clone with a copied token gets 409 and must
   re-enrol). The headers carry the version, SHA-256, signature, platform,
   arch, downgrade flag and whether this device is pinned to that version.
3. The agent refuses the file unless **all** of these pass:
   - the SHA-256 matches and the platform is `linux`
   - the signature verifies against **any key embedded in the running
     agent** (`AGENT_UPDATE_PUBKEYS`, current plus standby). It is checked
     with `openssl pkeyutl -verify -rawin`, using only a root-owned,
     non-writable openssl at an absolute path (`/usr/bin`, `/bin`,
     `/usr/local/bin`), never one found through PATH
   - the version is **newer** than its own. An older version is accepted
     only when the device is pinned to it **and** the release was signed
     with `--allow-downgrade`
   - it parses (`bash -n`) and declares that version.
4. It downloads into a temporary file next to itself (so the swap is an
   atomic rename) and keeps the old script as `.prev`. It then runs the new
   script with `--self-test`, which calls `GET /api/agent/ping` with its
   token and fingerprint.
5. If the self-test fails, it restores `.prev`, records the failed version
   so it is not retried until a newer one appears, and reports the
   rollback. Every result goes to `POST /api/agent/update-result`, which is
   audited along with the version the server offered.

## Key management

- **Generate once**, on a trusted machine (not the SnippyCode server):
  `node scripts/agent-release.js keygen --out /secure/snippycode-signing`
  The private key is written mode 600, and the script refuses to write inside
  the repo. `*.pem` and `agent/release/` are git-ignored. `sign` refuses a
  key file that other users can read.
- **Keep the private key offline**: a password manager attachment, a hardware
  token or an encrypted USB stick, with one offline backup. Never put it in
  the repo, the database, CI for the server, or the server's `.env`. Keep a
  **standby key** generated the same way and stored separately.
- **Sign each release**:
  `node scripts/agent-release.js sign --key /secure/.../agent-signing.key.pem --next-pub /secure/standby.pub.pem`
  This embeds the signing key and the standby key into the agents, signs the
  manifest entries and writes everything to `agent/release/`.
  `node scripts/agent-release.js verify` checks the result.
- **Publish**: copy `agent/release/` to the server's `AGENT_RELEASE_DIR`
  (default `<app>/agent/release`), and set `AGENT_UPDATE_PUBLIC_KEYS` to
  the trusted public key(s) (PEM blocks or base64 DER, comma or newline
  separated). **In production the server offers nothing without it**, and
  it refuses any release whose signatures don't verify. New installs
  download the signed copy, so they carry the keys from the start.
- **Rotating**: if a standby key is already embedded, sign with it and drop
  the old one. Otherwise, sign ONE release with the old key while embedding
  the new key(s): `sign --key OLD.key.pem --embed-pub NEW.pub.pem` (check it
  with `verify --pub OLD.pub.pem`). After that, agents trust only the new
  key. Update `AGENT_UPDATE_PUBLIC_KEYS` to include both keys during the
  change.
- **If the private key leaks**: pause the rollout. Then sign a release with
  the standby key that embeds a new standby key, and roll it out. **If it's
  lost**: use the standby key, or reinstall agents with a new key.

## Staged rollout (default: canary first)

Admin → System → *Agent updates*, or the API (admins only):

- **Staged mode (default)**: only the `canary` ring is offered at first.
  `early` opens once at least 3 canary devices (or all of them, if fewer)
  are on the release with 5 healthy check-ins. Then the `percent` share of
  `stable` opens (default 25%) once `early` has done the same. The share is
  stable per device and version, so raising it only adds devices.
- **Any rollback pauses the rollout** for everyone. This is audited and sends
  a notification, and nothing more is offered until an admin resumes it.
- **Manual mode**: you set `rings` and `percent` yourself. Choosing
  everyone at once is an explicit admin action.
- `PUT /api/devices/:id/agent-update` `{ ring, pin }`. A pin wins over
  everything: the device gets exactly that version, even while paused, and
  moves down to it only if the release allows downgrades.
- Existing devices start in the `stable` ring. Put a few in `canary`.

## Moving existing (pre-1.4.0) agents over: the bootstrap window

Agents before 1.4.0 have no verifier. They update only by downloading
`/agent/snippycode-agent.sh` when a poll tells them to. That hop is **off**
unless all of these hold:

- an admin opens a bootstrap window (`bootstrapUntil`). It can last at most 30 days from the first time it is opened and cannot be re-armed after that,
- `AGENT_BOOTSTRAP_SHA256` in the server config matches the release's Linux
  agent, so only that exact signed 1.4.x build can be delivered
- the staged rollout includes the device (canary first)
- every offer is audited (`agent.bootstrap_offered`, once per device).

Limit: a 1.3.0 agent's download is not authenticated, because that agent
predates it. It is the same HTTPS origin and trust that 1.3.0 already gives
the server for jobs. Once on 1.4.x, every later update is signature-checked.
Windows agents are not bootstrapped. Reinstall them.

## Limits

- The self-test is a token and fingerprint ping. A version that passes it but
  breaks later is restarted by the service manager. Pin the device back to
  the previous version (with a downgrade-signed release) or reinstall.
