# Agent identity, clones and fingerprints

Each agent has three identifiers:

- **Agent ID**: a random UUID created on first run (`/etc/snippycode-agent/agent-id`,
  `%ProgramData%\SnippyCode\agent-id`). Re-enrolment matches on it.
  `install.sh --reset-id` / `install.ps1 -ResetId` throws it away.
- **Device token**: the secret the agent authenticates with.
- **Hardware fingerprint**: a sha256 of machine-id/MachineGuid, the sorted physical
  MAC addresses and the board/BIOS serial. Only the hash is sent, and only in the
  `X-Agent-Fingerprint` header (never in a URL, so it stays out of proxy logs).

## What the fingerprint is for

It **detects accidental clones**: a VM template, golden image or copied disk that carries
another machine's agent ID and device token. Once a device has a fingerprint, every
device-token request must carry the same one. A missing or different fingerprint gets
`409 reenrol_required` and an audit entry, and the original device is not touched.

It is **not authentication and does not stop token theft**. Anyone who copied the token
can read or recompute the fingerprint and replay the header. Treat a leaked device
token as a leaked credential: revoke the device.

## Clones

A clone that gets `reenrol_required` calls `POST /api/agent/clone-enroll` with its copied
device token and new fingerprint. The server creates a **new, inactive device**
(`status: pending_approval`, `clonedFrom` = the original) with its own agent ID and token,
and notifies admins. Until an admin approves it (`POST /api/devices/:id/approve-clone`),
or a fresh enrolment token for the same site activates it, it gets no jobs, scripts,
secrets or schedule values; its polls return idle. `POST /api/devices/:id/deny-clone`
revokes it and deletes its token.

Limits: one clone per (source device, fingerprint); `CLONE_MAX_PER_SOURCE` clones per
source over its lifetime (default 20); `CLONE_ENROLL_PER_HOUR` per source (default 5) and
`CLONE_GLOBAL_PER_HOUR` across the instance (default 50). Refused attempts are audited but
not counted. Revoked or pending sources cannot clone.

## Devices enrolled before fingerprints

Their first fingerprint is bound on first contact. It is trusted when it comes from the
device's last known address, or within 7 days of the upgrade. Otherwise it is still bound
(the agent keeps working) but the device is marked `fingerprintPendingReview` and admins
get an alert.
