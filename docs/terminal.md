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

`user` is a local Linux account (`letters, digits, _, . and -`). An empty user means the
agent's own account. The agent switches only when it is root (`runuser`, otherwise `sudo -n`,
otherwise `su`). If it is not root, the switch is refused and the shell stays as it is.

Windows sessions run as the agent service account, usually SYSTEM. Switching users is refused:
doing it safely would need that account's password, and this does not ask for one or reuse a
stored remote-desktop password.

The same admin rule as the device shell applies (admins, or editors when
`DEVICE_SHELL_FOR_EDITORS=true`).

### What is audited

Opening a session, switching user, and closing a session are audited. Keystrokes are not stored.
The run history records one line for the session, not the transcript, so a password typed at a
prompt is not written to the database.

### Limits

One session per device. It closes after 15 minutes with no input and no output, or after 4 hours.
On Linux the helper is a real PTY, so `read`, `sudo`, and most y/n prompts work. Full-screen
programs (editors, `top`) are not supported. On Windows, stdin is connected but it is not a
ConPTY, so a program that insists on a real console can still refuse. An open Linux session does
not block other device tools. An open Windows session is pumped alongside polling; a one-shot job
still pauses the terminal while that job runs.
