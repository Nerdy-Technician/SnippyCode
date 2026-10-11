# Writing runbooks (playbooks)

SnippyCode calls them **runbooks**. Other tools call the same thing a playbook. A runbook is an
ordered list of steps that you run against a site, or against one device in a site. Each
step either runs a snippet or is a manual checklist item for a person.

A worked example is in [`examples/linux-disk-cleanup.runbook.json`](examples/linux-disk-cleanup.runbook.json).

## Structure

A runbook has a title (required, up to 200 characters), a description, and up to 100 steps.
This is the body `POST /api/runbooks` takes, and the same as the Runbooks page editor:

```json
{
  "title": "Linux disk cleanup",
  "description": "What it does and which variables it reads.",
  "steps": [
    { "snippetId": 12, "title": "Report disk usage", "note": "Shown to whoever runs it." },
    { "title": "Check services", "note": "No snippet: a manual step." }
  ]
}
```

- Each step needs a `snippetId`, a `title`, or both. A step with no snippet is manual: someone
  marks it done or skipped.
- Steps run in order. A failing step stops a scheduled run (status `failed`). In a run
  started by hand, you can retry, skip or reset the step.
- If you edit a runbook while a run is in progress, steps that are still there (sent back
  with their `id`) keep their progress.

Steps point at snippets, so the code lives in your snippet library, where it is versioned,
linted and reusable. Runbooks can't be imported from a file, but snippets can, so the
example file is in two parts:

1. `snippets`: the library JSON format. Import it from **Admin → Library → Import JSON**
   (`POST /api/admin/import`). The import ignores the extra `runbook` key.
2. `runbook`: the runbook, with each step naming its snippet by title (`"snippet": "..."`).
   Create it on the Runbooks page and pick those snippets, or `POST /api/runbooks` with
   each `snippet` title swapped for that snippet's `snippetId`.

## Interpreters

A step runs its snippet's `language`:

| Language | Runs with |
| --- | --- |
| `bash`, `sh`, `shell` | bash |
| `python` | python3 |
| `javascript`, `js` | node |
| `powershell` | pwsh (on Windows agents, Windows PowerShell) |

Runs go to a device's agent when the run targets a device. Otherwise they run on the server,
which needs `SNIPPET_RUN_ENABLED=true` and that interpreter installed (or the Docker
sandbox). Agents report which interpreters they have, and a step whose language a device
can't run fails on that device. A non-zero exit code fails the step, so use `set -euo
pipefail` in bash and `exit 1` for "this needs a person".

## Variables and `{{templates}}`

> **Values are quoted for you.** Every value is inserted as one quoted literal
> for the snippet's language: POSIX single quotes for bash/sh, single quotes with
> doubled quote characters for PowerShell, a JSON string for Python and
> JavaScript. Batch (cmd) values that contain quotes, newlines or `% ! ^ & | < > ( )`
> are refused. So write placeholders **bare**: `MOUNT={{CLEANUP_MOUNT:/}}` or
> `Get-Item -Path {{PATH}}`, not `"{{CLEANUP_MOUNT}}"`. A value can never break out
> into extra commands. Typed variables are checked first: a `number` must look like
> a number, a `boolean` like true/false, and a `choice` must be one of its options.
> An admin can mark a definition **raw** to insert it as written (for example a
> list of flags). Raw is never imported from GitHub sync, and a non-admin who edits
> the code clears it.


Snippets use placeholders: `{{NAME}}` or `{{NAME:default}}`. Names are UPPER_SNAKE_CASE
(`^[A-Z][A-Z0-9_]{0,63}$`), so `{{ name }}` (Mustache, Jinja, Helm) and `${{ ... }}`
(GitHub Actions) are left alone. When a value is needed, the first source that has one
wins:

1. values entered when the run starts
2. your **personal** variables
3. **site** variables (for the run's site)
4. **team** variables
5. the inline default after the `:`

Device runs also get `DEVICE_NAME`, `DEVICE_HOSTNAME`, `DEVICE_IP`, `DEVICE_OS` and
`DEVICE_SITE`. A placeholder with no value and no default is left as it is, so give
sensible defaults (`{{LOG_RETENTION_DAYS:14}}`) and list the variables in the
description.

### Variable definitions

A snippet can also *define* its variables (Variables section of the snippet
editor, or a `variables` list in JSON). Each has a `name`, a `type`
(`string`, `number`, `boolean`, `choice` with `choices`, or `secret-ref` with
`ref` naming a saved variable), a `default`, `required` and a `description`.
Manual runs ask for required values and check types; schedules refuse to save
without them; runbook steps can set a value per step or pass one through with
`{{OTHER_NAME}}`. A `secret-ref` never holds a value: it is read from the
saved (encrypted) variable at run time. The editor offers to add placeholders
it finds in the script and flags definitions the script never uses.

## Secrets

Create a variable with **Secret** ticked (`isSecret: true`) to store it encrypted. Secret
values go into the script only when the run happens. They are masked as `••••••` in step
output and never shown in the editor. A secret you can't read stays as `{{NAME}}` instead
of falling back to a default, so the step fails rather than running with the wrong value.
Never paste credentials into snippet code; the editor warns when it spots common token
formats.

## Targeting sites and devices

- **By hand:** open the runbook, choose **Run**, pick a site and optionally one device in it
  (`POST /api/runbooks/:id/runs` with `siteId` and `deviceId`). You need access to that
  site.
- Site variables come from the chosen site, so one runbook can serve every client, each
  with its own values.

## Running and scheduling

- From the run page you can **Run**, **Done**, **Skip** or **Reset** each step. History is
  under Runbooks → Runs.
- **Scheduling:** create a schedule with target **Runbook** and a cron expression with a
  time zone. Choose the sites (specific sites; admins can also use a site tag, all sites or
  a monitoring policy), and whether it runs on the server or on each site's devices. Each
  target gets its own unattended run.
- In an unattended run, a manual step (or one nothing can run) pauses the run with status
  `attention` and sends a notification. A failed step ends the run as `failed`. Choose
  whether the schedule notifies on failure, always or never.

## Tips

- Keep steps small and safe to repeat. Start with a read-only "report" step and finish with
  a "verify" step that exits non-zero when the goal wasn't met.
- Put a guard variable on destructive steps (`CLEANUP_DOCKER:yes`) so a site can turn
  them off with a site variable instead of a separate runbook.
- Check before you rely on a tool (`command -v docker`), and skip cleanly when it isn't
  there.
- Use manual steps for judgement calls, but remember that they pause scheduled runs.
- Test against a single device with a run started by hand before you schedule a runbook
  across sites.
