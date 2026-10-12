# Variables

Write `{{NAME}}` or `{{NAME:default}}` in a snippet. When it runs, SnippyCode fills each placeholder from the first place that has a value, **highest first**:

1. **Runtime prompt**: what you type when you run or copy the snippet (or a runbook step or schedule value).
2. **User**: your own values. Only you see them.
3. **Device**: `DEVICE_*` values when running on a device.
4. **Site**: values for the chosen site.
5. **Global**: values for everyone.
6. **Snippet default**: the `:default` in the placeholder or the variable's definition.

Nothing found? The placeholder is left as-is and a required variable stops the run.

## Scopes and who can change them

| Scope  | Who can see it            | Who can change it                      |
|--------|---------------------------|----------------------------------------|
| Global | everyone who can sign in  | admins and owners                      |
| Site   | people with site access   | editors with access to that site       |
| User   | only you                  | only you                               |

## Secrets

Tick **Secret** for passwords and tokens. Secret values are encrypted at rest (bound to their row, so a copied ciphertext can't be reused), never sent in lists or previews (you see `••••••`), left out of public links, and masked in run output. They're decrypted only when something runs, or when someone allowed to edit that variable presses **Reveal** (global and site reveals are audited).

## Resolved preview

In the snippet editor, open **Resolved values**, pick a site or device, and see each variable's value and where it came from. Secrets stay masked.

## Used in

Each variable lists the snippets, runbooks and schedules that use it, so you can see what a change affects before you make it.

## Upgrading from 1.2

"Team" values are now **Global** and "My values" are now **User**; nothing moves. Global values are now admin-only (editors could change them before). Migration 27 re-encrypts existing secrets bound to their row; set `VARIABLES_SECRET_KEY` before upgrading.
