# SnippyCode v1.3.0 Release Notes

Release version: `v1.3.0`

## Highlights

- Variables redesign: Global (admin-only), Site and User scopes with one clear override order: snippet default, global, site, device, user, runtime prompt.
- New tabbed Variables page with "Used in" lists and in-app help, and a resolved-values preview in the snippet editor (pick a site or device, see each value and where it came from).
- Secrets stay masked everywhere and are now encrypted bound to their row.

## Upgrading to v1.3.0

- Migration 27 runs automatically at startup, in one transaction. It re-encrypts existing secret variables bound to their row, so `VARIABLES_SECRET_KEY` must be set (it already is if you followed the v1.2.4 notes). If it cannot read a secret, it changes nothing and startup stops: fix the key and restart.
- Behaviour change: only admins and owners can change or reveal Global (formerly "team") variables. Editors who managed team values need an admin, or should move those values to Site scope.
- Rollback: redeploy the v1.2.5 image. Bound secrets need v1.3.0 to read them, so restore the pre-upgrade backup if you roll back.

# SnippyCode v1.2.5 Release Notes

Release version: `v1.2.5`

## Highlights

- UI: cleaner, roomier typography and spacing. Inter with a full system font fallback, 16px body text at a 1.5 line height, larger buttons, inputs and small labels, and more padding in tables and cards. Brand colours and themes are unchanged.
- Includes everything in v1.2.4: the Runbooks page crash fix, refused quoted placeholders, strict CSRF and the non-root image.

## Upgrading to v1.2.5

- No new migrations and no configuration changes. Pull the new image and restart.
- Coming from v1.2.3 or older, follow the v1.2.4 steps below first (data volume `chown` to uid 1000 and `VARIABLES_SECRET_KEY`).
- Rollback: redeploy the v1.2.4 image.

# SnippyCode v1.2.4 Release Notes

Release version: `v1.2.4`

## Highlights

- Fix: the Runbooks page no longer crashes (blank page) for editors, admins and owners.
- Security: placeholders inside quotes or substitutions are refused at save and run time; affected snippets show a warning and are listed in Admin > System.
- Security: strict CSRF token on every cookie-session write.
- Security: the Docker image runs as the non-root `node` user.
- `VARIABLES_SECRET_KEY` is in `.env.example`, and the compose example fails fast without it.

## Upgrading to v1.2.4

- Back up the database first (`docker exec <container> node build/backupCli.js create`). No new migrations.
- The image now runs as uid 1000 (`node`). Give the existing data volume to that user once, before starting v1.2.4:
  `docker compose run --rm --user root --entrypoint chown snippycode -R node:node /app/data`
- Make sure `VARIABLES_SECRET_KEY` is set (keep your current value; changing it makes stored secrets unreadable). Using `${VARIABLES_SECRET_KEY:?}` in compose stops a start without it.
- List snippets with quoted placeholders: `docker compose exec snippycode node build/quotedPlaceholdersReport.js`, then remove the quotes around those placeholders.
- Rollback: redeploy the v1.2.3 image (no schema changes). Volume ownership can stay as is.

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
