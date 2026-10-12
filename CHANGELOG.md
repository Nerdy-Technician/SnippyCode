# Changelog

All notable changes to SnippyCode are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-10-12

### Added
- Variables redesign: **Global** (admin-only), **Site** and **User** scopes. Values resolve as snippet default, then global, site, device, user, then the runtime prompt.
- Tabbed Variables page (Global / Site / User) with a site picker, per-variable "Used in" lists (snippets, runbooks, schedules) and in-app help (`docs/variables.md`, `/api/help/variables`).
- Resolved preview in the snippet editor: pick a site or device and see each value and the scope it came from (`GET /api/variables/preview`). Secrets stay masked.
- `GET /api/variables/usage`.

### Changed
- Global (formerly "team") variables can only be created, changed, revealed or deleted by admins and owners; editors keep site variables for sites they can access. The API accepts the old `team` / `personal` scope names and still returns `team`, `personal` and `canEditTeam` alongside `global`, `user` and `canEditGlobal`.
- Scheduled snippets resolve the schedule owner's user values, as scheduled runbooks already did.

### Security
- Secret variable values are encrypted bound to their row (AES-GCM AAD `variables:<id>:value`), so a ciphertext copied to another row fails to decrypt. Portable backups decrypt and re-bind them.
- Migration 27 (one transaction, safe to re-run) re-encrypts existing secrets bound to their row, clears `siteId` on rows that also had a `userId` (they were always treated as user values) and adds a one-scope-per-row check constraint.

## [1.2.5] - 2026-10-12

### Changed
- Typography and spacing pass: a full system font stack after Inter (`system-ui`, Segoe UI, Roboto, Helvetica, Arial, sans-serif), 16px body text with a 1.5 line height, 15px buttons, inputs and menus, and a 13px floor for badges, labels and meta text (was as small as 11px).
- Shared spacing scale (`--sb-space-1` to `--sb-space-6`) and text sizes (`--sb-text-xs/sm/md`) as theme variables, with roomier table cells, card bodies and headers, and vertically centred table rows.

### Fixed
- Includes the v1.2.4 Runbooks crash fix (`GET /api/sites` read as `{ sites, canManage }` or a bare list), covered by client tests.

## [1.2.4] - 2026-10-12

### Fixed
- Runbooks page no longer crashes for editors and above: the example runbook panel read `GET /api/sites` as a bare list instead of `{ sites, canManage }`.

### Security
- Placeholders written inside quotes, backticks, `$( )`, `${ }`, heredocs, here-strings, triple-quoted strings or template literals are refused at save and at run time (values are already quoted), unless an admin marks the variable raw. Affected snippets show a warning and are listed in Admin > System, `GET /api/snippets/quoted-placeholders` and `node build/quotedPlaceholdersReport.js`.
- Strict CSRF: every write on the session cookie must send the XSRF token, even without Origin or Sec-Fetch-Site. Agent and API-key requests are unchanged.
- The Docker image runs as the unprivileged `node` user (uid 1000). Existing data volumes need a one-off `chown` (see upgrade notes).

### Changed
- `VARIABLES_SECRET_KEY` is documented in `.env.example` and the compose example fails fast with `${VARIABLES_SECRET_KEY:?}` when it is missing.

## [1.2.3] - 2026-10-11

### Added
- Bulk enrolment: reusable enrolment tokens with max uses, expiry (default 7 days, max 365), revoke, use count and last-used tracking; unlimited tokens are allowed but always expire. "Bulk enrol" panel, token list and updated installers.
- Re-enrolment is admin-only and does not count as a token use; re-enrolling a known machine with a token is refused (409, audited) unless the token allows it or an admin approves.
- Site admin picker on the site members screen.
- Device-targeted schedules: run a snippet or a runbook on devices picked individually, by site and/or by tag, resolved at run time, with per-schedule history and per-device results.
- Shared coloured tags with a tag manager; schedules target tags by ID.
- Two-way GitHub sync: separate auto-upload and auto-download toggles (off by default, owner-only), one shared interval, conflict detection with conflict-flagged copies (never silent overwrites), conservative deletes, backups before downloads, snippet tag sync and paging past 1,000 files.
- Snippet variables: typed variable definitions (string, number, boolean, choice, secret-ref), placeholder auto-detection, import, run-time prompts and validation, runbook step values and schedule values.
- In-app runbook guide and a one-click "Import example runbook" button; example playbook and `docs/playbooks.md`.
- Approval for risky runs: dangerous or large runs wait for an admin, with content hashing so an approval is void if the code, values or targets change, site-scoped approvers, no self-approval, and owner-only settings.
- Agent auto-update (Linux): signed manifest (Ed25519, SHA-256, version, platform, arch), key rotation, downgrade protection, canary then early then stable rollout with automatic pause on rollback, per-device ring and pin, and a time-limited bootstrap for older agents.
- Stable agent IDs with automatic clone handling for golden images, hashed hardware fingerprints, `--reset-id` / `-ResetId` installer options and an admin "clear duplicate" action.
- CI: migration checks (fresh and upgrade from v1.2.2), agent script checks (shellcheck, PSScriptAnalyzer), Node 20/22/24 test matrix, coverage artifacts, PR title lint, Docker image scan, production `npm audit` and a licence check.

### Changed
- Missed schedule runs are skipped and logged in run history and the audit log.
- Run output is deleted after 90 days by a configurable daily cleanup job.
- Stored schedule values are encrypted at rest with `VARIABLES_SECRET_KEY`.
- Server tests run on Node 20 (no shell glob needed).

### Security
- Schedules: editing, deleting, running or reading the values of a schedule needs access to every site and device it currently targets (others get 404, audited); new targets are checked on save; runs reach only the sites both the creator and the last editor can access; a schedule nobody owns does not run; shared device tags across sites are admin-only.
- Placeholder values are type-checked and quoted for the snippet's language (POSIX shell, PowerShell, Python/JavaScript; batch metacharacters refused). Admins can mark a variable raw.
- Clones are activated only by an admin approval or a single-use activation token made for that clone; revoking a device revokes its pending clones (and approved ones on request); approval and activation are refused once the source is revoked.
- Fingerprint bindings from an unexpected address are flagged for review, also during the first 7 days; admins can approve or reset the binding.
- The agent bootstrap window can no longer be re-armed past 30 days from first use.
- Approval payloads are encrypted with `enc:v2` bound to their row.
- Production requires `VARIABLES_SECRET_KEY` and no longer falls back to `SESSION_SECRET`.
- A schedule run whose approval went stale is closed as failed.

### Migrations
- 18 to 26: device schedules, GitHub auto-sync, run approvals, snippet variables, shared tags, agent identity, agent auto-update, clone identity and schedule value encryption, clone activation tokens.

## [1.2.2] - 2026-10-11

### Added
- Sites: group devices, snippets and secrets per site, with site membership and access checks.
- Devices: enrol devices with one-time enrolment tokens, collect device facts, run device tools and revoke devices; new Devices and Device detail pages.
- Agent: Linux (bash) and Windows (PowerShell) agents plus installers that poll for queued jobs, run them and report output and facts.
- Runbooks: ordered multi-step runbooks with step-by-step run tracking.
- Runs: run history for snippets and runbooks, with a run modal and output view.
- Schedules: cron-based schedules with preview and "run now".
- Variables: global and per-site variables, encrypted secret variables (`VARIABLES_SECRET_KEY`) and `{{template}}` substitution in snippets.
- Monitoring: policies that apply monitors and patch windows to devices, self-opening and self-resolving alerts, and device metrics trends.
- Notifications: outgoing webhooks (Discord, Slack, generic) with delivery history.
- Backups: create, list and restore (optionally encrypted) backups from the admin UI and the new `snippycode-backup` CLI (`npm run backup`).
- Snippets: favourites, usage stats, meaning search, AI assist modal, snippet linting and a command palette.
- CI: GitHub Actions workflow running the test suite against Postgres 16.
- Tests: server tests (`node --test`) and client tests, via `npm test`.
- Database migrations 10 to 15: variables and usage, sites/secrets/runs/runbooks, agents/schedules/notifications, device facts, device tools, monitoring policies.

### Changed
- Reworked the snippet runner, server bootstrap (`src/app.ts`), navigation and admin pages to support the features above.
- `/raw/:slug` now fills `{{variables}}` before serving (add `?render=0` for the stored template) and sends an `X-Content-SHA256` header. Public snippets get only query and default values; site, team and secret values need a snippet token or the raw API key. Private snippets without a valid token still answer `404`.

## [1.2.1] - 2026-09-30

### Fixed
- Public `/s/` pages: title and actions cards share a row and the code gets its own full-width row, so the code is no longer pushed far down the page. Public pages also show tags and last-updated time.

## [1.2.0] - 2026-09-30

### Added
- PowerShell remote execute one-liner (`irm .../raw/<slug> | iex`) for public PowerShell snippets.
- About page at `/about`.
- Optional `PUBLIC_BASE_URL` setting for share links.
- Audit log entry when a snippet is made public or private.
- CI: lint, typecheck, tests, build and a Docker image build check; security scanning and Dependabot.

### Fixed
- Shared links (`/s/:slug`) no longer turn private after unrelated updates; pin and public toggles change only that flag.
- Pin state survives a page reload; the logo on public pages no longer renders full size.
- Slugs containing dots are always treated as slugs.

### Changed
- `/raw/:slug` answers `404` instead of `401` for private snippets without a valid token, and serves `text/plain` with `nosniff` and `no-store`.
