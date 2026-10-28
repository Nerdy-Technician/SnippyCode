#!/usr/bin/env python3
# SNIPPYCODE_PTY_HELPER
"""PTY bridge for one SnippyCode terminal session.

One-shot jobs never call this. The agent runs it only for language "pty",
with a spec file of shell= and user= lines. It posts output and long-polls
for keystrokes on /api/agent/jobs/<id>/tty.
"""
import base64
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

USER_RE = re.compile(r"^[a-z_][a-z0-9_.-]{0,31}$")
SHELLS = {"bash": ["bash", "-i"], "sh": ["sh", "-i"]}
MAX_SECONDS = 4 * 60 * 60
IDLE_SECONDS = 15 * 60


def log(message):
    sys.stderr.write(message.rstrip() + "\n")
    sys.stderr.flush()


def parse_spec(path):
    shell, user = "bash", ""
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if line.startswith("shell="):
                shell = line.split("=", 1)[1].strip()
            elif line.startswith("user="):
                user = line.split("=", 1)[1].strip()
    if shell not in SHELLS:
        shell = "bash"
    if user and (not USER_RE.match(user) or ".." in user or user[0] in ".-"):
        raise ValueError("refusing account name")
    return shell, user


def current_user():
    try:
        return subprocess.check_output(["id", "-un"], text=True, timeout=5).strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def user_exists(user):
    try:
        return subprocess.call(["id", user], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5) == 0
    except (OSError, subprocess.SubprocessError):
        return False


def sudo_allowed(user):
    """True when sudo lets this account become user without a password."""
    if not shutil.which("sudo"):
        return False
    try:
        return (
            subprocess.call(
                ["sudo", "-n", "-u", user, "--", "true"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


def spawn_argv(shell, user):
    """argv for the shell, or raise PermissionError when only su (password) can switch."""
    argv = list(SHELLS[shell])
    if not user or user == current_user():
        return argv
    if not user_exists(user):
        raise LookupError(user)
    if os.geteuid() == 0:
        if shutil.which("runuser"):
            return ["runuser", "-u", user, "--", *argv]
        if shutil.which("sudo"):
            return ["sudo", "-n", "-u", user, "--", *argv]
        # Login shell: su picks the account's shell, not ours. Last resort.
        return ["su", "-", user]
    if sudo_allowed(user):
        return ["sudo", "-n", "-u", user, "-H", "--", *argv]
    raise PermissionError(user)


def foreground_user(fd):
    """Account of whatever runs in the foreground of the terminal (su, sudo -i, ...)."""
    try:
        import pwd

        pgid = os.tcgetpgrp(fd)
        with open("/proc/%d/status" % pgid, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("Uid:"):
                    return pwd.getpwuid(int(line.split()[1])).pw_name
    except (OSError, KeyError, ValueError, IndexError, ImportError):
        pass
    return ""


def su_command(user):
    """Typed into the running shell so a wrong password drops back to it."""
    return ("su - %s\r" % user).encode()


def spawn(shell, user):
    argv = spawn_argv(shell, user)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        try:
            os.chdir("/")
        except OSError:
            pass
        try:
            os.execvp(argv[0], argv)
        except OSError as exc:
            os.write(2, ("SnippyCode: could not start %s: %s\n" % (argv[0], exc)).encode())
            os._exit(127)
    return pid, fd


def set_winsize(fd, rows, cols):
    if rows < 1 or cols < 1:
        return
    try:
        import fcntl
        import struct
        import termios

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except (OSError, ImportError):
        pass


def exit_status(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


def kill_child(pid):
    if not pid:
        return
    try:
        os.killpg(pid, signal.SIGHUP)
    except (OSError, ProcessLookupError):
        pass
    try:
        os.waitpid(pid, 0)
    except (OSError, ChildProcessError):
        pass


class Bridge:
    def __init__(self, job_id):
        self.job_id = job_id
        self.url = os.environ["SNIPPYCODE_URL"].rstrip("/")
        self.token = os.environ["SNIPPYCODE_TOKEN"]
        self.fingerprint = os.environ.get("SNIPPYCODE_FINGERPRINT", "")
        self.failures = 0

    def exchange(self, output, user, alive, exit_code, message):
        payload = {
            "output": base64.b64encode(output).decode("ascii"),
            "user": user,
            "alive": alive,
            "privileged": os.geteuid() == 0,
            "tty": True,
            "exitCode": exit_code,
            "message": message,
        }
        data = json.dumps(payload).encode("utf-8")
        headers = {
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
        }
        if self.fingerprint:
            headers["X-Agent-Fingerprint"] = self.fingerprint
        request = urllib.request.Request(
            "%s/api/agent/jobs/%s/tty?wait=0.4" % (self.url, self.job_id),
            data=data,
            method="POST",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8"))
            self.failures = 0
            return body.get("data") or {}
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 409, 410):
                return {"close": True, "input": "", "signal": None, "user": None}
            self.failures += 1
            log("terminal exchange HTTP %s" % exc.code)
            return None
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            self.failures += 1
            log("terminal exchange failed: %s" % exc)
            return None


def read_ready(fd, timeout):
    """Bytes from the PTY, b'' on timeout, or None on EOF."""
    try:
        ready, _, _ = select.select([fd], [], [], timeout)
    except (OSError, ValueError):
        return None
    if fd not in ready:
        return b""
    try:
        data = os.read(fd, 32768)
    except OSError:
        return None
    return data if data else None


def collect_output(fd, initial):
    chunk = initial
    deadline = time.time() + (0.08 if chunk else 0.35)
    while time.time() < deadline and len(chunk) < 32768:
        part = read_ready(fd, max(0.01, deadline - time.time()))
        if part is None:
            return chunk, True
        if not part:
            if chunk:
                break
            continue
        chunk += part
        deadline = min(deadline, time.time() + 0.05)
    return chunk, False


def apply_instruction(fd, pid, shell, active, instruction):
    note = b""
    raw = b""
    encoded = instruction.get("input") or ""
    if encoded:
        try:
            raw = base64.b64decode(encoded)
        except (ValueError, TypeError):
            raw = b""
    if raw and fd is not None:
        try:
            os.write(fd, raw)
        except OSError as exc:
            note += ("\r\nSnippyCode: could not write to the shell: %s\r\n" % exc).encode()
    sig = instruction.get("signal")
    if sig == "INT" and pid:
        try:
            os.killpg(pid, signal.SIGINT)
        except OSError:
            pass
    elif sig == "TERM" and pid:
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass
    requested = (instruction.get("user") or "").strip()
    if requested and requested != active:
        try:
            new_pid, new_fd = spawn(shell, requested)
        except PermissionError:
            # Not root and no passwordless sudo: su asks for the password in this terminal.
            if fd is not None:
                try:
                    os.write(fd, su_command(requested))
                except OSError:
                    pass
            note += (
                "\r\nSnippyCode: this agent runs as %s, so switching to %s uses su. "
                "Type %s's password at the prompt; exit returns here.\r\n" % (current_user(), requested, requested)
            ).encode()
        except LookupError:
            note += ("\r\nSnippyCode: there is no local account named %s.\r\n" % requested).encode()
        except (OSError, ValueError) as exc:
            note += ("\r\nSnippyCode: could not switch user: %s\r\n" % exc).encode()
        else:
            kill_child(pid)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            pid, fd = new_pid, new_fd
            active = requested
            note += ("\r\nSnippyCode: switched to %s\r\n" % requested).encode()
    try:
        rows = int(instruction.get("rows") or 0)
        cols = int(instruction.get("cols") or 0)
    except (TypeError, ValueError):
        rows, cols = 0, 0
    if rows and cols and fd is not None:
        set_winsize(fd, rows, cols)
        if pid:
            try:
                os.killpg(pid, signal.SIGWINCH)
            except OSError:
                pass
    return fd, pid, active, note


def report_and_exit(bridge, user, message, code):
    bridge.exchange(message.encode() + b"\r\n", user, False, code, message)
    return code


def main():
    if len(sys.argv) != 3 or not sys.argv[1].isdigit():
        log("usage: pty_session.py JOB_ID SPEC")
        return 2
    try:
        shell, user = parse_spec(sys.argv[2])
    except (OSError, ValueError) as exc:
        log(str(exc))
        return 2
    bridge = Bridge(sys.argv[1])
    active = user or current_user()
    via_su = False
    try:
        pid, fd = spawn(shell, user)
    except PermissionError:
        # Open as the agent account and let su ask for the password in the terminal.
        via_su = True
        active = current_user()
        try:
            pid, fd = spawn(shell, "")
        except (OSError, ValueError) as exc:
            return report_and_exit(bridge, active, "SnippyCode: could not start the shell: %s" % exc, 127)
    except LookupError:
        return report_and_exit(bridge, current_user(), "SnippyCode: there is no local account named %s." % user, 1)
    except (OSError, ValueError) as exc:
        return report_and_exit(bridge, current_user(), "SnippyCode: could not start the shell: %s" % exc, 127)

    started = time.time()
    last_io = started
    exit_code = 0
    message = ""
    pending = ("SnippyCode terminal (%s, account %s). Keystrokes go to this shell.\r\n" % (shell, active)).encode()
    if via_su:
        pending += (
            "SnippyCode: this agent is not root and sudo needs a password, so it runs su for %s. "
            "Type the password at the prompt.\r\n" % user
        ).encode()
        try:
            os.write(fd, su_command(user))
        except OSError:
            pass
    try:
        while True:
            now = time.time()
            if now - started > MAX_SECONDS:
                message = "The session reached the 4 hour limit."
                break
            if now - last_io > IDLE_SECONDS:
                message = "The session was closed after 15 minutes with nothing typed and no output."
                break
            if bridge.failures >= 8:
                message = "The session lost contact with SnippyCode."
                break

            chunk, eof = collect_output(fd, pending)
            pending = b""
            if chunk:
                last_io = time.time()
            active = foreground_user(fd) or active
            instruction = bridge.exchange(chunk, active, True, None, "")
            if instruction is None:
                time.sleep(0.4)
                continue
            if instruction.get("close"):
                message = "Session closed."
                break
            fd, pid, active, note = apply_instruction(fd, pid, shell, active, instruction)
            pending = note
            if note:
                last_io = time.time()
            if eof or not pid:
                message = "The shell exited."
                if pid:
                    try:
                        waited, status = os.waitpid(pid, os.WNOHANG)
                        if waited:
                            exit_code = exit_status(status)
                    except (OSError, ChildProcessError):
                        pass
                    pid = 0
                break
            try:
                waited, status = os.waitpid(pid, os.WNOHANG)
            except (OSError, ChildProcessError):
                waited, status = 0, 0
            if waited:
                exit_code = exit_status(status)
                message = "The shell exited."
                pid = 0
                break
    finally:
        kill_child(pid)
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        bridge.exchange(b"", active, False, exit_code, message)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
