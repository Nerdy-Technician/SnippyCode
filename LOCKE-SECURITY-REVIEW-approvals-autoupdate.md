# Security review: approvals.patch, autoupdate.patch, rook2.patch
Reviewer: Locke · 2026-10-11 · read-only, no commits, no live services touched.
Scratch trees: /workspace/locke-snippy-review/tree (bulk-enrol + approvals + autoupdate applied; identical to the rebase working tree) and /workspace/locke-snippy-review/rook2 (copy of /workspace/snippycode-rook2). Line numbers refer to those trees.

## Verdict
- **approvals.patch: CHANGES REQUIRED.** The atomic claim, the no-self-approval rule, single use and expiry are solid. Two High gaps defeat the point of the gate, though: the approved code is not bound (TOCTOU), and the size check can be bypassed with a site-wide run.
- **autoupdate.patch: APPROVE WITH FIXES.** Verify-before-install is correct, and no path installs a file that failed its checks. Fix the downgrade gap and the Windows openssl lookup before you enable it on Windows. Make canary the default.
- **rook2.patch: DO NOT MERGE.** A token holder can bypass the fingerprint check just by omitting the fingerprint. Clones get full access the moment they are created.

## Build and tests
| Tree | tsc (server) | Server tests |
|---|---|---|
| approvals+autoupdate | pass | 82/82 pass |
| rook2 | pass | 86 pass, 0 fail, 1 skipped |
Note: `npm test` fails on Node 20 because `node --test '.test-build/test/**/*.test.js'` is not expanded ("Could not find"). I ran the tests with the shell glob `.test-build/test/*.test.js` instead. Fix the script (use Node 22+, or the shell glob). The client tests were not run.

---
## approvals.patch

### High
**A1. TOCTOU: the approved code is not bound.** `src/controllers/snippets.ts:789` (`runSnippet`) and `src/utils/approvalReplay.ts:15`: on approval, the request is replayed through the handler, which re-reads the snippet, runbook or schedule *at execution time*. The held payload only holds siteId/deviceIds/variables (`snippets.ts` holdForApproval). An editor can request a run of benign code and wait for the admin to read it. They then edit the snippet (or a runbook step, or the schedule) before approval, and the admin approves code they never saw. Site-mode targets are also re-resolved, so the device set can grow.
*Fix:* when requesting, store `contentHash = sha256(language + code + resolved variables + sorted target ids)`, plus the snippet/runbook `updatedAt` or version. Show the code to the approver. At execution, recompute the hash and fail with `approval.stale` on a mismatch. Better still, execute the frozen copy kept in the encrypted payload.

**A2. The "large run" gate can be bypassed with a site-wide run.** `snippets.ts:917`: a site-scoped run passes `targets=[{type:'site'}]`, so `targetCount=1` and it never trips `deviceThreshold`, however many devices the site has. Runbooks hard-code `targetCount: 1` (`runbooks.ts:~407`).
*Fix:* count the devices the run will actually reach (site devices, policy devices) on the server, and use that same number again at execution time.

### Medium
**A3. Classification is a manual flag, so it is easy to evade.** `dangerous` is set per snippet/runbook (`snippets.ts:726-753`). An editor can copy a flagged snippet into a new, unflagged one, or paste the code into an ad-hoc run, and run it without approval. *Fix:* inherit the flag on duplicate/fork. Add server-side content rules (regex/denylist: `rm -rf`, `format`, `Remove-Item -Recurse`, `diskpart`, `reg delete`, credential dumps). Optionally offer "all runs from editors need approval".

**A4. Schedule-triggered approvals have no requester.** `utils/approvals.ts:187,225`: `requestedBy` is null for schedule runs, so the admin who created or last edited the schedule can approve its run. *Fix:* record `requestedBy = schedule.updatedBy` (the last editor) and apply the self-approval rule to it. Also apply A1's hash to the schedule definition.

**A5. One admin can switch the whole gate off.** `controllers/approvals.ts:98` with `cleanApprovalSettings`: any admin can set `enabled:false` or a high threshold, run, and turn it back on. This is audited, but it still lets one person do it alone. *Fix:* restrict to the owner (or require a second admin), emit a high-severity notification, and set a floor on `deviceThreshold`.

**A6. No tenant/site scoping of approvers.** `isAdminRole` (`siteAccess.ts:9`) is global admin/owner, so site admins can't approve and global admins approve everything. This is fine for a single tenant. If site admins or companies come later, add approver scoping by `approval.siteId`.

### Low
- **A7. Self-approval only compares the user id** (`approvals.ts:187`). The same human with a second admin account, or an API key belonging to another admin, is not detectable. This is inherent to the design. Mitigations: audit both identities, and alert when requester and approver share an IP or session (`ipAddress` is already stored).
- **A8. Execution runs synchronously inside the approve request.** Expiry is enforced atomically at claim time (`approvals.ts:194-197`: `status='pending' AND expiresAt > now`), and execution starts immediately, so it is effectively enforced at execution. Keep it that way, and never queue an approved run for later without rechecking `expiresAt`.

### Info (verified good)
- The atomic conditional UPDATE means only one decision wins (no approve/deny race). The payload is cleared after execution, so **an approval can't be replayed for several runs**. The replay marker is a Symbol on the request object (`approvalReplay.ts:8`), so a client can't forge it.
- The payload is encrypted at rest and never returned by `approvalJson`.
- Audit entries exist for requested, approved, denied, executed, failed, expired and settings_changed, and for dangerous flag changes. Only admins can clear the flag.

---
## autoupdate.patch

### High
**U1. Windows: `openssl.exe` is resolved through PATH while the agent runs as SYSTEM.** `agent/snippycode-agent.ps1:118,125,138`: `Get-Command openssl` will run the first `openssl.exe` on the machine PATH. Many installers add user-writable directories, so a local user can plant an `openssl.exe` that always "verifies". That gives code execution as SYSTEM as soon as the server, or anyone with a MITM, serves a payload. Even without a planted binary, the trust anchor depends on a third-party binary. *Fix:* verify natively. On PowerShell 7 / .NET 8+ there is no built-in Ed25519, so embed a small verifier (a C# Ed25519 verify via `Add-Type`, or ship a signed helper exe), or sign the .ps1 files with Authenticode and use `Get-AuthenticodeSignature` with a pinned thumbprint. At the very least, use an absolute path that is checked as owned by Administrators/SYSTEM and not writable by Users. Don't enable auto-update on Windows until this is done.

### Medium
**U2. No downgrade protection, and the signature doesn't cover the metadata.** `utils/agentRelease.ts:21-22,72` sign only the file bytes. The agent checks `latest != AGENT_VERSION` and that the file's `AGENT_VERSION` matches the header (`snippycode-agent.sh:180,269`), but never that it is *newer*. A compromised server, or a CDN/TLS MITM, can therefore serve any older signed release, with its known bugs. Embedding the version inside the signed file prevents version-label lies, and the filename prevents a .sh/.ps1 swap only implicitly. *Fix:* sign a canonical manifest `{version, file, platform, sha256, minVersion}`. On the agent, refuse `version <= AGENT_VERSION` unless the server response carries an explicit pin flag *and* the signed manifest allows it (a signed "allowDowngradeTo"). Keep a monotonic "highest seen" in the agent config.

**U3. No key rotation or revocation.** The public key is a single embedded string (`snippycode-agent.sh:12`), and `AGENT_UPDATE_PUBLIC_KEY` on the server is optional (`agentRelease.ts:64`; without it the server only checks SHA-256). *Fix:* embed a list of keys (current plus next). Support a signed "key-rollover" release that can only be signed by an existing key. Make the server refuse to offer releases when `AGENT_UPDATE_PUBLIC_KEY` is unset in production. Document an offline backup of the key.

**U4. The default rollout is all-at-once.** `agentRelease.ts:43`: `DEFAULT_ROLLOUT` offers every ring 100%. See the answer to Q2 below.

### Low
- **U5. The swap is not atomic, and `.prev` handling.** `snippycode-agent.sh:183-191`: `$WORK/agent.new` is `mv`'d onto `$self`. If `$WORK` is on another filesystem this is copy+unlink, not atomic. *Fix:* download into a temp file created with `mktemp` in `dirname $self`, then `mv -f`. `$WORK` is 0700, which is good, and `.prev` is a local copy of the running file, so it doesn't need re-verifying. Make sure `$self.prev` is not a pre-existing symlink (`rm -f` before `cp`).
- **U6. The health check is weak, and there's a rollback loop.** `--self-test` (`sh:36-39`) only pings `/api/agent/ping`, so a new agent with a broken poll loop passes. A failing version is retried after every restart, because `update_tried` is in memory only (`sh:252,269`). That is a loop, but a bounded one. *Fix:* persist the failed version in a state file and skip it until the server offers a newer one. Extend the self-test to call `/next?dry=1`.
- **U7. `submitUpdateResult` trusts the agent for its version.** `controllers/agentUpdate.ts:79-83` sets `agentVersion` from the agent's own report. This is acceptable because it only affects what is offered, but log the claimed version against the offered one.

### Info (verified good)
- Ordering is checksum, then signature, then `bash -n`, then the version match, and only then install. Every failure returns before `mv`, so **no path installs a file that failed its checks**. The server also refuses to offer a release whose checksum or signature fails (`agentRelease.ts:56-81`).
- RBAC: changes to rings, rollout and pins need `requireMinimumRole('admin')` (`routes/devices.ts:41-43,56`) and are audited with before/after (`agentUpdate.ts:121,151`).
- Signing script (`scripts/agent-release.js:50-56`): the key directory is created 0700, the private key is written 0600, and only the public key is printed. The private key is never logged. Recommend adding `--key` from stdin or a hardware token, and refusing to run when the key file mode is wider than 0600.

### Answers to Nibbles's three questions
1. **Unsigned first hop from 1.3.0: acceptable as a one-time bootstrap, with mitigations.** The risk is that 1.3.0 has no verifier, so whoever controls the server's TLS endpoint during that hop installs arbitrary code on every agent as root/SYSTEM. That is the same trust 1.3.0 already gives the server for jobs, so it adds little new exposure *if* the hop comes from the authenticated API rather than a CDN. Mitigations:
   - serve the bootstrap only from `/api/agent/update`, device-token-authenticated, never from a CDN or static path
   - check it with the SHA-256 header from that same authenticated response, against a hash pinned in the server code or config for the bootstrap build
   - make the bootstrap build signed, so that from then on everything is verified
   - roll it out to canary first
   - expire the bootstrap path after N days, or once every device reports ≥ the verifying version, then refuse unsigned updates outright
   - audit every bootstrap delivery
   
   Pinning the TLS host or certificate isn't possible for already-deployed 1.3.0 agents, so the bootstrap build should add cert/host pinning as an option for later updates.
2. **Default rollout: canary-first.** Change the default to `{rings:['canary'], percent:0}`. Auto-advance (or prompt the admin to advance) to `early`, and then a percentage of `stable`, only after N canary devices (for example ≥3, or 100% of canary) report `agent.updated` and stay healthy for at least M check-ins or 24h. Auto-pause when any `update_rolled_back` happens in the current ring. Make "all-at-once" an explicit admin choice.
3. **Windows `openssl.exe` on PATH: yes, that's a problem, and a security one, not only a usability one.** See U1: it is binary planting that leads to SYSTEM. Use a native or bundled verifier, or Authenticode with a pinned thumbprint, or at least an absolute path with ACL checks. Until then, keep auto-update disabled on Windows.

---
## rook2.patch (migration 25)

### High
**R1. You can bypass the fingerprint check by omitting it.** `rook2/src/controllers/devices.ts:924`: `if (!fingerprint) return 'ok'`. A stolen token used without `x-agent-fingerprint`/`?fingerprint=` passes `requireAgent` (line 580) and gets full device access. *Fix:* once `device.fingerprint` is set, require a matching fingerprint on every request, and reject when it is missing or malformed.

**R2. The fingerprint is client-supplied, so it can be spoofed, and it is not authentication.** It is `sha256(machine-id, MACs, …)`, which anyone who copied the disk or config can compute or read, and it is sent in a query string (`agent/snippycode-agent.sh:253`), where it lands in proxy and access logs. An attacker with the token just sends the original fingerprint and impersonates the device. It detects *accidental* clones (VM templates) but gives no protection against theft. *Fix:* treat it only as clone detection. For theft resistance, give each device an asymmetric key generated at enrol (in the TPM or keystore where possible), sign requests or use challenge-response, and rotate the device token on each re-key. Move the fingerprint to a header, never the query string.

**R3. Clones get full access immediately.** `devices.ts:1005-1030`: the clone is created as a normal active device in the source's site. `possibleDuplicate` is only a UI hint (`devices.ts:143`), and `requireAgent` doesn't gate on it. So it receives site/policy schedule jobs, script bodies, resolved variables or secrets, and runbooks, and its runs can fall under approvals as a normal target. *Fix:* create clones with `status='pending_approval'`. In `requireAgent`, allow only `/ping` and `/facts` (or nothing) until an admin approves. Exclude them from site/policy target resolution and from secret resolution. Better still, drop self-service clone-enrol and require a fresh enrolment token or admin approval, as the planned design note says.

**R4. A leaked token can mint clones without a bound.** 5 per source per hour (`devices.ts:998`) is ~120/day per stolen token, and unlimited over time. Each one only needs a new random 64-hex fingerprint. *Fix:* set a lifetime cap per source (for example 3 total, then admin), add a global/site cap, require that the source has been seen recently, and alert the admins on every clone. Combined with R3, a single leaked token currently gives an unbounded fleet of fully privileged devices.

### Medium
**R5. Rate-limit race.** The count reads `audit_logs` inside the transaction (`devices.ts:~990-998`), but the audit row is written *after* commit, outside it. The row lock on the source serialises transactions, but a commit happens before its audit row exists. So N parallel requests with different fingerprints can each see count < 5. *Fix:* count from `devices WHERE clonedFrom = :id AND createdAt > now()-1h` inside the locked transaction, or insert the audit row inside the transaction before the check. The unique index (`clonedFrom, fingerprint`) does correctly stop duplicate fingerprints.

**R6. TOFU fingerprint capture.** `checkFingerprint` records the first fingerprint it sees for existing devices (`devices.ts:925-927`). Right after migration, every legacy device is unbound, so whoever polls first with a stolen token binds *their* fingerprint and locks out the real agent (which then gets 409 and reenrol_required). *Fix:* bind only via the enrol or an authenticated agent upgrade, alert on first binding, and give admins a "reset fingerprint" action.

**R7. Refused attempts count toward the limit.** An attacker can DoS legitimate clone recovery for a device. This is minor, but count only successes for the cap and rate-limit refusals separately per IP.

### Low
- **R8. secretBox** (`src/utils/secretBox.ts:11-48`):
  - The key comes from `VARIABLES_SECRET_KEY`, falls back to `SESSION_SECRET`, and then to a hard-coded `dev-only-change-me` outside production. It is a SHA-256 of the material, not a KDF, which is acceptable for high-entropy keys only.
  - The nonce is a random 12-byte value per encryption (good). AES-GCM with an auth tag.
  - **There is no AAD**, so ciphertexts can be swapped between schedules, variables and approval payloads by anyone with DB write access.
  - *Fix:* AAD = `table:id:field:key`, plus a key id in the prefix (`enc:v2:<kid>:`) for rotation. Refuse the dev fallback unless `NODE_ENV=test`, and refuse to start when `SESSION_SECRET` is the only key.
  - Values that look like `enc:v1:` are passed through on encrypt and decrypt, so a user-typed value with that prefix is stored as plaintext and may throw on read. Escape them or reject them.
- **R9. Migration safety** (`src/db/migrations/25_clone_identity_schedule_encryption.ts`):
  - The backfill is idempotent (good). However, it isn't wrapped in a transaction: if the key is missing in production, `encryptSecret` throws after the columns are added, leaving a half-migrated state.
  - `down` decrypts back to plaintext, which is intended but should be documented as a secret-exposure step.
  - It loads every schedule into memory; batch it if you expect large tables.
  - *Fix:* run in `queryInterface.sequelize.transaction`, and check the key first.

### Info
- **Edit fetch** (`src/controllers/schedules.ts:434-446`): editors only, audited as `schedule.variables_viewed` with actor and IP. Good. Consider admin-only, or per-variable "secret" flags, so editors don't see every value.
- **Middleware coverage:** every `/api/agent/*` route except `/enroll` and `/clone-enroll` goes through `requireAgent`. There are no websocket routes. rook2 is based *before* autoupdate, so after the rebase confirm that `/update` and `/update-result` (which use `requireAgent`) get the check too. They will, because the check is in the middleware, but add a test.
- The revoked source gets 403 and is audited (good). The source device is never modified (good).

### Clone-enrol design note (raised before the patch landed, and confirmed by R1–R4)
A copied device token plus any new fingerprint mints a new device, so a stolen token becomes extra enrolled devices. Require **admin approval or a fresh enrolment token** to activate a clone. Until approval: no jobs, no scripts, no secrets, no schedules, no approvals participation. Add a per-source lifetime cap and a global rate limit, audit and alert on every attempt, and auto-revoke all clones when the source token is revoked or rotated.
