# Upgrading to v1.2.3

1. **Back up first** (`npm run backup` or Admin, then Backups). Migrations 18 to 26 run on start.
2. **`VARIABLES_SECRET_KEY` is required in production.** v1.2.3 no longer falls back to
   `SESSION_SECRET` and refuses to start without it.
   - If you never set it, your stored secrets were encrypted with `SESSION_SECRET`.
     Set `VARIABLES_SECRET_KEY` to **the same value** as `SESSION_SECRET` and everything
     stays readable. You can then rotate `SESSION_SECRET` on its own.
   - To move to a brand new key later: take an encrypted backup, set the new key and
     restore the backup (restores re-encrypt under the current key).
3. **Placeholder values are now quoted** for the snippet's language (see
   `docs/playbooks.md`). Snippets that wrapped placeholders in quotes, such as
   `"{{NAME}}"`, should drop the quotes, or an admin can mark the variable raw.
4. **Agent auto-update** needs a signing key: see `docs/agent-updates.md`.
5. **Rollback:** restore the pre-upgrade backup and redeploy the v1.2.2 image.
