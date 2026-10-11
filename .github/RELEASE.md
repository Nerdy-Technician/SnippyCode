# SnippyCode v1.2.3 Release Notes

Release version: `v1.2.3`

## Highlights

- New: bulk enrolment with reusable, expiring tokens (default 7 days, max 365) and admin-only re-enrolment.
- New: device-targeted schedules (individual devices, sites, shared coloured tags) with per-device run history.
- New: two-way GitHub sync with conflict detection, backups and no silent overwrites (off by default).
- New: typed snippet variables with run-time prompts; schedule values encrypted at rest.
- New: approval for risky runs, voided automatically if the code, values or targets change.
- New: signed agent auto-update for Linux with staged rollout and automatic rollback pause.
- New: stable agent IDs with automatic clone handling for golden images.
- Missed schedule runs are skipped and logged; run output is kept for 90 days.

## Upgrading to v1.2.3

- Back up the database first (`npm run backup`, `docker exec <container> node build/backupCli.js` in Docker, or the admin UI). Migrations 18 to 26 run on start.
- `VARIABLES_SECRET_KEY` is required in production; the server refuses to start without it and no longer falls back to `SESSION_SECRET`. If you relied on the fallback, set `VARIABLES_SECRET_KEY` to your current `SESSION_SECRET` value so existing secrets stay readable. Existing schedule values are encrypted on upgrade.
- Placeholder values are now quoted for the snippet's language; drop quotes written around placeholders (`"{{NAME}}"` becomes `{{NAME}}`). See `docs/upgrading-v1.2.3.md`.
- Agent auto-update needs a release signing key: generate it offline with `scripts/agent-release.js`, set `AGENT_UPDATE_PUBLIC_KEYS` on the server and keep the private key off the server. See `docs/agent-updates.md`.
- Rollback: restore the pre-upgrade backup and redeploy the v1.2.2 image; migrations are not reversed automatically.

# SnippyCode v1.2.2 Release Notes

Release version: `v1.2.2`

## Highlights

- New: sites, devices and a Linux/Windows agent. Enrol devices with one-time tokens, collect device facts, run device tools, and queue snippets on devices.
- New: runbooks (ordered multi-step runs), run history, and cron schedules with preview and run-now.
- New: global and per-site variables, encrypted secret variables and `{{template}}` substitution in snippets.
- New: monitoring policies with patch windows, auto-resolving alerts and device metrics.
- New: outgoing webhooks (Discord, Slack, generic) with delivery history.
- New: backups from the admin UI and the `snippycode-backup` CLI (`npm run backup`), optionally encrypted.
- Snippets: favourites, usage stats, meaning search, linting and a command palette.
- `/raw/:slug` fills `{{variables}}` before serving (`?render=0` returns the stored template) and sends `X-Content-SHA256`.

See `CHANGELOG.md` for the full list.

## Included from v1.2.1 and v1.2.0

- Public `/s/` page layout fix, share link fixes, PowerShell remote execute, About page, `PUBLIC_BASE_URL`, and CI checks. See `CHANGELOG.md`.

## Container Image

The GitHub release workflow publishes a multi-architecture image to GitHub Container Registry:

```text
ghcr.io/nerdy-technician/snippycode:latest
ghcr.io/nerdy-technician/snippycode:vX.Y.Z
ghcr.io/nerdy-technician/snippycode:X.Y.Z
ghcr.io/nerdy-technician/snippycode:X.Y
```

Supported platforms:

- `linux/amd64`
- `linux/arm64`

## Upgrade Notes

- v1.2.2: database migrations 10 to 15 run on startup (variables, sites, runbooks, runs, devices, schedules, webhooks, monitoring). Back up first.
- v1.2.2: set `VARIABLES_SECRET_KEY` once and keep it; it encrypts secret variables (falls back to `SESSION_SECRET` when empty).
- v1.2.1: no database migration or configuration change.
- No database migration.
- `/raw/:slug` now answers `404` instead of `401` when a private snippet is requested without a valid token, so private snippets look the same as missing ones. Valid snippet tokens and the admin raw API key work as before.
- Snippets that were unpublished by the bug stay private. Make them public again from the snippet page.
- Set `PUBLIC_BASE_URL` (for example `https://snippycode.example.com`) if share links should use a different URL from the one in your browser.

## Release Checklist

1. Update `package.json` version if needed.
2. Update the release version at the top of this `.github/RELEASE.md`.
3. Update this `.github/RELEASE.md` with user-facing changes.
4. Run `npm run lint`, `npm run typecheck` and `npm test`.
5. Run `npm run build`.
6. Create and push a SemVer tag, for example `v1.2.0`, or push a `package.json` version bump to `main`.
