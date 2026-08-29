# SnippyCode v1.1.0 Release Notes

Release version: `v1.1.0`

## Highlights

- Restore any previous snippet version. History now snapshots tags correctly, and the current snippet is saved first so a restore can be undone.
- Compare the current snippet with a previous version in a visual diff, then restore from the snippet detail page.
- Search titles, documentation, and code from Home and the library. Filters such as `lang:typescript`, `tags:ui,react`, and `collection:homelab` still work. Esc clears the search instead of silently showing recent snippets.
- Browse the library by collection, language, or tag. Filters and sort (last updated, title, language) are shareable in the URL. Editors can rename a collection across every snippet in it.
- Duplicate a snippet from the card or detail page, not only from the editor command palette.
- Preview markdown documentation in the editor with Write and Preview tabs.
- Press `/` to focus search and `n` to open a new snippet.
- Navigation and snippet actions follow your role. Viewers can read, search, and copy; editors can create and restore; Admin stays hidden unless you are an admin or owner. Your profile shows the real role name.
- Admins can change a user's role or delete an account. The last owner cannot be demoted or deleted. The leftover `user` role is treated as editor.
- Admins can connect OpenAI Codex and Claude Code by signing in with ChatGPT and Claude from Admin → AI Assist. Editors can generate snippet code, markdown docs, and tags from the editor. Tokens stay on the server.
- Admins can import all snippets from a running original Snippet Box instance (pawelmalak/snippet-box `GET /api/snippets`) from Admin → Library, with the same preview and confirm flow as JSON import.
- The editor command palette can copy a curl command, copy the raw URL, open version history, and jump to library search.
- Optional public snippet pages at `/s/:slug`. Public snippets can also be fetched at `/raw/:slug` without a token. Snippets stay private until an editor turns this on.
- Editors can run bash, Python, and Node snippets on the server when `SNIPPET_RUN_ENABLED=true`. Runs are timed out and written to the audit log.
- `snippycode` CLI lists, searches, and prints snippets using the admin raw API key.
- Client runs on React 18 with Create React App 5.
- Generate, copy, and revoke an admin raw API key for CI. Curl can fetch raw snippets with `?key=` or the `x-api-key` header. Per-snippet tokens still work on their own.
- Copy a ready-made `curl -fsSL` command from each snippet. Regenerating a token warns that other browsers and previous copies stop working.
- SnippyCode identifiers are used for the session cookie, OIDC cookie, MFA issuer, GitHub User-Agent, JSON export filename, and default local database URL.

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

- Sign in again after upgrade. The session cookie name changed from `snippysafe_session` to `snippycode_session`.
- Set a strong `SESSION_SECRET` before running in production.
- Use PostgreSQL for persistent storage; the bundled Compose file creates and healthchecks it.
- If you previously generated a snippet raw token in the browser, it is migrated automatically. Regenerating still invalidates copies stored in other browsers.
- After the first launch on an empty database, complete the owner setup wizard before importing snippets.
- To migrate from original Snippet Box, open Admin → Library, enter the live instance URL (and API key if required), preview, then confirm.
- Accounts that still had the leftover `user` role are mapped to `editor` on startup.
- Public pages are off per snippet. Existing snippets stay private until you mark them public.
- Server-side run stays off until you set `SNIPPET_RUN_ENABLED=true`.
- Codex and Claude Code stay off until an admin signs in with ChatGPT and Claude from Admin → AI Assist.

## Release Checklist

1. Update `package.json` version if needed.
2. Update the release version at the top of this `.github/RELEASE.md`.
3. Update this `.github/RELEASE.md` with user-facing changes.
4. Run `npm run build:tsc`.
5. Run `npm run build --prefix client`.
6. Create and push a SemVer tag, for example `v1.1.0`, or push a `package.json` version bump to `main`.
