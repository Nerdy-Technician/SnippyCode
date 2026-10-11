# Changelog

All notable changes to SnippyCode are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
