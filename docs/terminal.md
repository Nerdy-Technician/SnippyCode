# Device terminal

The device page has two ways to run a shell. Both stay available.

## One command at a time

`POST /api/devices/:id/tools/shell` with `{ "args": { "code", "shell", "cwd", "terminal": true } }`
queues a normal agent job. The agent runs it with **stdin closed** (`</dev/null` on Linux,
`-NonInteractive` on Windows) and posts stdout and stderr when it exits. Automation, files,
services and every other tool use this path. It does not read a prompt.

Each of these commands is stored in the audit log. On Linux the working folder carries over.
The command's exit code is the exit code of the command, not of the folder marker printed after it.

## Interactive session

Agents that report the `pty` capability (Linux agents 1.5.0 with `python3`, and Windows agents
1.5.0) can open a session. Older agents keep the one-command terminal until they are upgraded.
Auto-update does not ship 1.5.0 until a release is signed; install or upgrade the agent by hand
in the meantime.

| Request | Who | What |
| --- | --- | --- |
| `POST /api/devices/:id/terminal/session` | browser | `{ "shell": "bash"\|"sh"\|"powershell"\|"cmd", "user": "alice" }` opens a session, or returns the one already open |
| `GET /api/devices/:id/terminal/session?since=&wait=&cols=&rows=` | browser | Output since `since`. Holds up to `wait` seconds |
| `POST .../terminal/session/input` | browser | `{ "session", "data" }` keystrokes, including answers to prompts |
| `POST .../terminal/session/signal` | browser | `{ "session", "signal": "INT"\|"TERM" }` |
| `POST .../terminal/session/user` | browser | `{ "session", "user" }` switch account |
| `POST .../terminal/session/close` | browser | End the shell |
| `POST /api/agent/jobs/:id/tty?wait=` | agent | `{ "output" (base64), "user", "alive", "privileged", "tty", "exitCode", "message" }` |

`user` is a local account. An empty user means the agent's own account.

On Linux (`letters, digits, _, . and -`): a root agent switches with `runuser` (or `sudo -n`, or `su`).
A non-root agent uses `sudo -n -u <user>` when sudoers allows it without a password; otherwise it
types `su - <user>` into the session so the account's password is asked for in the terminal, and
`exit` returns to the agent account. The account shown is whoever owns the foreground process.

On Windows the agent (SYSTEM) can open the shell as any user who is signed in, at the console or
over remote desktop, using that session's token. No password is asked for or stored. Users who are
not signed in are refused with a clear message. "Load accounts" lists signed-in users (`quser`).

The same admin rule as the device shell applies (admins, or editors when
`DEVICE_SHELL_FOR_EDITORS=true`).

### What is audited

Opening a session, switching user, and closing a session are audited. Keystrokes are not stored.
The run history records one line for the session, not the transcript, so a password typed at a
prompt is not written to the database.

### Limits

One session per device. It closes after 15 minutes with no input and no output, or after 4 hours.
The browser side is a real terminal emulator (xterm.js), and the window size is passed to the
device, so full-screen programs (`vim`, `top`, `less`, `htop`) work.

On Linux the helper is a real PTY. On Windows 10 1809 / Server 2019 and later the helper is a
ConPTY pseudo console, so console-only prompts, full-screen programs and Ctrl+C behave as they do
locally. Older Windows builds fall back to redirected pipes and say so when the session opens.

On both platforms the session runs in its own helper process, so one-shot jobs (other tools,
automation) keep running while a session is open and do not pause it.
