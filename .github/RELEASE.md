# SnippyCode v1.0.0 Release Notes

Release version: `v1.0.0`

## Highlights

- Rebranded the app to SnippyCode with refreshed public assets, favicon, PWA icons, and app metadata.
- Added forced authentication with first-run owner setup, local login, roles, MFA, OIDC setup, and profile avatars.
- Added admin workflows for users, OIDC, GitHub sync, import/export, server tasks, and audit logs.
- Added raw snippet links with per-snippet token generation, revocation, and regeneration.
- Added GitHub sync support for private snippet libraries, including dry-run and conflict handling.
- Added a production Docker image that serves the built React client from the Node API container.
- Added Docker Compose deployment with PostgreSQL healthchecks and an optional backup profile.

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

- Set a strong `SESSION_SECRET` before running in production.
- Use PostgreSQL for persistent storage; the bundled Compose file creates and healthchecks it.
- If upgrading from older local development data, run a backup before applying migrations.
- After the first launch on an empty database, complete the owner setup wizard before importing snippets.

## Release Checklist

1. Update `package.json` version if needed.
2. Update the release version at the top of this `.github/RELEASE.md`.
3. Update this `.github/RELEASE.md` with user-facing changes.
4. Run `npm run build:tsc`.
5. Run `npm run build --prefix client`.
6. Create and push a SemVer tag, for example `v1.0.0`, or push a `package.json` version bump to `main`.
