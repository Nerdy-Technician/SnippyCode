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
