# SnippyCode v1.2.0 Release Notes

Release version: `v1.2.0`

## Highlights

- Fixed: shared links (`/s/:slug`) stopped working after an unrelated change. Pinning a snippet from a library view that was loaded before the snippet was made public, or any update that did not resend the public flag (another tab, a script, the API), silently turned the snippet private again. Pin and public toggles now change only that flag, and updates keep fields they do not send.
- Fixed: the pin on a snippet page did nothing after a page reload.
- Fixed: the logo on public `/s/` pages rendered at full size and pushed the snippet below the fold.
- Slugs with dots, such as `purge-onedrive-from-windows.powershell` or `1.5`, are always looked up as slugs. Only plain whole numbers are treated as snippet ids.
- New: PowerShell remote execute. Public PowerShell snippets show a copyable `irm https://<host>/raw/<slug> | iex` one-liner on the share dialog and the public page, with a safety note. Only run scripts you trust; this runs the code directly on your machine.
- `/raw/:slug` returns the snippet body only, as `text/plain; charset=utf-8` with `nosniff` and `no-store`.
- Making a snippet public or private is written to the audit log (`snippet.visibility_changed`).
- New: an About page at `/about`, linked from the navigation bar and public snippet pages. It shows the version, the main features, and links to the source code and release notes. Anyone can open it; no sign-in needed.
- New optional `PUBLIC_BASE_URL` setting for share links and the one-liner.
- CI now runs lint, typecheck, tests and build on every pull request and push to `main`, plus a Docker image build check.

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
