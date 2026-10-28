#!/usr/bin/env bash
# SnippyCode agent for Linux.
#
# Polls SnippyCode for jobs queued for this device, runs them here, and sends
# back the output. Installed and started by install.sh; settings live in
# /etc/snippycode-agent.conf (URL, DEVICE_TOKEN, ALLOW_HTTP).
set -uo pipefail

AGENT_VERSION="1.5.0"
# Ed25519 public keys (base64 DER, space-separated: current and next) that
# updates must be signed with. Filled in by scripts/agent-release.js when a
# release is signed; empty = no updates.
AGENT_UPDATE_PUBKEYS=""
CONFIG="${SNIPPYCODE_AGENT_CONFIG:-/etc/snippycode-agent.conf}"
WORK="${SNIPPYCODE_AGENT_WORK:-/var/lib/snippycode-agent}"
# Enough for full software lists and event logs
MAX_OUTPUT_BYTES=1048576

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if [ ! -r "$CONFIG" ]; then
  log "Missing $CONFIG. Run install.sh first."
  exit 1
fi

URL=""
DEVICE_TOKEN=""
ALLOW_HTTP="0"
# Set AUTO_UPDATE="0" in the config to stop the agent updating itself
AUTO_UPDATE="1"
# shellcheck source=/dev/null
. "$CONFIG"
URL="${URL%/}"

# Stable agent ID written by install.sh; sent with every poll so the server
# can register it on this device (no re-enrolment needed)
AGENT_ID_FILE="${SNIPPYCODE_AGENT_ID_FILE:-/etc/snippycode-agent/agent-id}"
AGENT_ID=""
if [ -r "$AGENT_ID_FILE" ]; then AGENT_ID="$(tr -dc 'a-f0-9-' < "$AGENT_ID_FILE")"; fi
if [ "${#AGENT_ID}" -ne 36 ] && [ -r /proc/sys/kernel/random/uuid ]; then
  AGENT_ID="$(cat /proc/sys/kernel/random/uuid)"
  mkdir -p "$(dirname "$AGENT_ID_FILE")" 2>/dev/null && chmod 700 "$(dirname "$AGENT_ID_FILE")" 2>/dev/null
  (umask 077 && printf '%s\n' "$AGENT_ID" > "$AGENT_ID_FILE") 2>/dev/null || true
fi

# Hardware fingerprint: sha256 of machine ID, sorted physical MACs and the
# board serial where readable. Only the hash ever leaves this machine.
hardware_fingerprint() {
  local mid="" macs="" serial="" iface
  for f in /etc/machine-id /var/lib/dbus/machine-id; do
    if [ -r "$f" ]; then mid="$(tr -d '[:space:]' < "$f")"; break; fi
  done
  for iface in /sys/class/net/*; do
    [ -e "$iface/device" ] && [ -r "$iface/address" ] || continue
    macs="$macs$(tr -d '[:space:]' < "$iface/address" | tr 'A-F' 'a-f')"$'\n'
  done
  macs="$(printf '%s' "$macs" | sort -u | tr '\n' ',')"
  if [ -r /sys/class/dmi/id/product_serial ]; then serial="$(tr -d '[:space:]' < /sys/class/dmi/id/product_serial)"; fi
  printf '%s|%s|%s' "$mid" "$macs" "$serial" | sha256sum | cut -d' ' -f1
}
FINGERPRINT="$(hardware_fingerprint)"

# Health check used after an update: the new script runs, reads the config,
# and the server accepts its token on this hardware (fingerprint checked). Exit 0 = healthy.
if [ "${1:-}" = "--self-test" ]; then
  curl -fsS --max-time 20 -o /dev/null -H "Authorization: Bearer $DEVICE_TOKEN" \
    -H "X-Agent-Fingerprint: $FINGERPRINT" "$URL/api/agent/ping"
  exit $?
fi

# The server refused this token on this hardware (a cloned disk or VM).
# Swap it for a new device at the same site via clone self-enrol: no
# enrolment token is kept on disk. The original device is never touched.
reenrol() {
  local response new_token new_id
  response="$(curl -fsS --max-time 30 -X POST "$URL/api/agent/clone-enroll?format=env" \
    -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Agent-Fingerprint: $FINGERPRINT" \
    --data-urlencode "agentId=$AGENT_ID" \
    --data-urlencode "hostname=$(hostname)" \
    --data-urlencode "version=$AGENT_VERSION")" || {
    log "Clone enrolment was refused. Rerun install.sh --reset-id with an enrolment token."
    return 1
  }
  new_token="$(printf '%s\n' "$response" | sed -n 's/^DEVICE_TOKEN=//p' | tr -dc 'A-Za-z0-9_-')"
  new_id="$(printf '%s\n' "$response" | sed -n 's/^AGENT_ID=//p' | tr -dc 'a-f0-9-')"
  [ -n "$new_token" ] || { log "Clone enrolment returned no device token"; return 1; }
  if [ "${#new_id}" -eq 36 ]; then
    (umask 077 && printf '%s\n' "$new_id" > "$AGENT_ID_FILE") || return 1
    AGENT_ID="$new_id"
  fi
  sed -i "s/^DEVICE_TOKEN=.*/DEVICE_TOKEN=\"$new_token\"/" "$CONFIG" || return 1
  DEVICE_TOKEN="$new_token"
  log "Enrolled this clone as its own device; it stays idle until an admin approves it"
}

if [ -z "$URL" ] || [ -z "$DEVICE_TOKEN" ]; then
  log "URL and DEVICE_TOKEN must be set in $CONFIG"
  exit 1
fi

case "$URL" in
  https://*) ;;
  http://localhost*|http://127.*|http://\[::1\]*) ;;
  http://*)
    if [ "$ALLOW_HTTP" != "1" ]; then
      log "Refusing to fetch jobs over plain HTTP from $URL. Jobs can contain secrets; use HTTPS or set ALLOW_HTTP=1."
      exit 1
    fi
    ;;
  *) log "URL must start with https://"; exit 1 ;;
esac

mkdir -p "$WORK"
chmod 700 "$WORK"

now_ms() { date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 )); }

capabilities() {
  local found=""
  for bin in bash sh python3 node pwsh; do
    command -v "$bin" >/dev/null 2>&1 && found="$found$bin,"
  done
  # Interactive terminals need python3. One-shot jobs do not.
  command -v python3 >/dev/null 2>&1 && found="${found}pty,"
  printf '%s' "${found%,}"
}

interpreter_for() {
  case "$1" in
    bash|shell) echo "bash" ;;
    sh) echo "sh" ;;
    python) echo "python3" ;;
    javascript|js) echo "node" ;;
    powershell) echo "pwsh" ;;
    *) echo "" ;;
  esac
}

header() { grep -i "^$1:" "$2" | tail -1 | cut -d: -f2- | tr -d ' \r'; }

# What this machine is, for the device card in SnippyCode
send_facts() {
  local os_name kernel cpus mem_total mem_available disk uptime_s ip tz
  os_name="$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-}") || true)"
  [ -n "$os_name" ] || os_name="$(uname -s)"
  kernel="$(uname -r)"
  cpus="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"
  mem_total="$(awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null)"
  mem_available="$(awk '/^MemAvailable:/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null)"
  disk="$(df -Pk / 2>/dev/null | awk 'NR == 2 {printf "%.1f %.1f", $2 / 1048576, $3 / 1048576}')"
  uptime_s="$(cut -d. -f1 /proc/uptime 2>/dev/null)"
  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  tz="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo "")"
  read -r load1 load5 load15 _ < /proc/loadavg 2>/dev/null || true

  curl -fsS --max-time 20 -o /dev/null \
    -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Agent-Fingerprint: $FINGERPRINT" \
    --data-urlencode "osName=$os_name" \
    --data-urlencode "kernel=$kernel" \
    --data-urlencode "cpus=$cpus" \
    --data-urlencode "memTotalMb=${mem_total:-0}" \
    --data-urlencode "memAvailableMb=${mem_available:-0}" \
    --data-urlencode "diskTotalGb=${disk%% *}" \
    --data-urlencode "diskUsedGb=${disk##* }" \
    --data-urlencode "uptimeSeconds=${uptime_s:-0}" \
    --data-urlencode "ip=$ip" \
    --data-urlencode "timezone=$tz" \
    --data-urlencode "load1=${load1:-}" \
    --data-urlencode "load5=${load5:-}" \
    --data-urlencode "load15=${load15:-}" \
    --data-urlencode "hostname=$(hostname)" \
    --data-urlencode "version=$AGENT_VERSION" \
    "$URL/api/agent/facts" || log "Could not send system facts"
}

# Signed self-update. The new agent must match the server's SHA-256 AND carry
# a valid Ed25519 signature from the key embedded above (checked with
# openssl), parse, and report the expected version. The current script is
# kept as .prev; if the new one fails its health check it is put back.
report_update() {
  curl -fsS --max-time 20 -o /dev/null -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Agent-Fingerprint: $FINGERPRINT" \
    --data-urlencode "from=$1" --data-urlencode "to=$2" --data-urlencode "ok=$3" --data-urlencode "detail=$4" \
    "$URL/api/agent/update-result" || true
}

# openssl only from a root-owned, non-writable system path, never via PATH
trusted_openssl() {
  local candidate owner mode
  for candidate in /usr/bin/openssl /bin/openssl /usr/local/bin/openssl; do
    [ -x "$candidate" ] && [ ! -L "$candidate" ] || continue
    owner="$(stat -c '%u' "$candidate" 2>/dev/null)"; mode="$(stat -c '%a' "$candidate" 2>/dev/null)"
    [ "$owner" = "0" ] || continue
    case "$mode" in *[2367]?|*?[2367]) continue ;; esac
    echo "$candidate"; return 0
  done
  return 1
}

# True when $1 is a strictly newer version than $2
version_newer() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

# The signed manifest entry: file, platform, arch, version, sha256 and the
# downgrade flag are all covered by the signature, so none can be swapped.
signed_message() {
  printf 'snippycode-agent-update/v1\nfile=snippycode-agent.sh\nplatform=linux\narch=%s\nversion=%s\nsha256=%s\ndowngrade=%s\n' "$1" "$2" "$3" "$4"
}

verify_signature() {
  local message="$1" sig_b64="$2" openssl key rc=1 pem="$WORK/update.pub.pem" sig="$WORK/update.sig" msg="$WORK/update.msg"
  openssl="$(trusted_openssl)" || return 1
  [ -n "$AGENT_UPDATE_PUBKEYS" ] || return 1
  printf '%s' "$message" > "$msg"
  printf '%s' "$sig_b64" | "$openssl" base64 -d -A > "$sig" 2>/dev/null || { rm -f "$msg" "$sig"; return 1; }
  for key in $AGENT_UPDATE_PUBKEYS; do
    { echo "-----BEGIN PUBLIC KEY-----"; echo "$key"; echo "-----END PUBLIC KEY-----"; } > "$pem"
    if "$openssl" pkeyutl -verify -pubin -inkey "$pem" -rawin -in "$msg" -sigfile "$sig" >/dev/null 2>&1; then rc=0; break; fi
  done
  rm -f "$pem" "$sig" "$msg"
  return $rc
}

self_update() {
  local latest="$1" self dir new prev headers want_sum got_sum sig version arch platform downgrade pinned failed_file
  [ "$AUTO_UPDATE" = "1" ] || return 0
  self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  dir="$(dirname "$self")"
  [ -w "$self" ] && [ -w "$dir" ] || { log "Agent $latest is available but $self is not writable"; return 0; }
  if [ -z "$AGENT_UPDATE_PUBKEYS" ] || ! trusted_openssl >/dev/null; then
    log "Agent $latest is available, but updates need a signed release and a root-owned openssl; reinstall to update"
    return 0
  fi
  # A version that failed its health check is not retried until a newer one appears
  failed_file="$WORK/update-failed"
  if [ -r "$failed_file" ] && [ "$(cat "$failed_file")" = "$latest" ]; then return 0; fi

  # Same directory as the agent, so the final mv is an atomic rename
  new="$(mktemp "$dir/.snippycode-agent.XXXXXX")" || return 0
  prev="$self.prev"
  headers="$WORK/update.headers"
  if ! curl -fsS --max-time 60 -D "$headers" -o "$new" -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Agent-Fingerprint: $FINGERPRINT" \
    "$URL/api/agent/update?file=snippycode-agent.sh"; then
    rm -f "$new" "$headers"; log "Could not download agent $latest"; return 0
  fi
  version="$(header x-agent-version "$headers")"
  want_sum="$(header x-agent-sha256 "$headers")"
  sig="$(header x-agent-signature "$headers")"
  platform="$(header x-agent-platform "$headers")"
  arch="$(header x-agent-arch "$headers")"
  downgrade="$(header x-agent-downgrade "$headers")"
  pinned="$(header x-agent-pinned "$headers")"
  rm -f "$headers"
  got_sum="$(sha256sum "$new" 2>/dev/null | cut -d' ' -f1)"
  case "$downgrade" in 1) ;; *) downgrade=0 ;; esac

  if [ ! -s "$new" ] || [ -z "$want_sum" ] || [ "$got_sum" != "$want_sum" ] || [ "$platform" != "linux" ]; then
    log "Agent $latest failed its checksum; not installed"; report_update "$AGENT_VERSION" "${version:-$latest}" 0 "checksum mismatch"
  elif ! verify_signature "$(signed_message "${arch:-any}" "$version" "$got_sum" "$downgrade")" "$sig"; then
    log "Agent $latest has no valid signature; not installed"; report_update "$AGENT_VERSION" "${version:-$latest}" 0 "bad signature"
  elif ! version_newer "$version" "$AGENT_VERSION" && ! { [ "$pinned" = "1" ] && [ "$downgrade" = "1" ]; }; then
    log "Refusing agent $version: not newer than $AGENT_VERSION"; report_update "$AGENT_VERSION" "$version" 0 "downgrade refused"
  elif ! bash -n "$new" || ! grep -q "^AGENT_VERSION=\"$version\"$" "$new"; then
    log "Agent $latest did not check out; not installed"; report_update "$AGENT_VERSION" "$version" 0 "parse or version check"
  else
    rm -f "$prev"
    cp -p "$self" "$prev"
    chmod 755 "$new"
    mv -f "$new" "$self"
    if "$self" --self-test; then
      rm -f "$failed_file"
      log "Updated from $AGENT_VERSION to $version (previous kept at $prev); restarting"
      report_update "$AGENT_VERSION" "$version" 1 ""
      exec "$self"
    fi
    mv -f "$prev" "$self"
    printf '%s' "$version" > "$failed_file"
    log "Agent $version failed its health check; rolled back to $AGENT_VERSION"
    report_update "$AGENT_VERSION" "$version" 0 "health check failed, rolled back"
  fi
  rm -f "$new"
}

# The interactive helper is a copy of agent/pty_session.py. Keep them identical.
extract_pty_helper() {
  local dest="$1"
  cat > "$dest" <<'SNIPPY_PTY_PY'
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


def spawn_argv(shell, user):
    argv = list(SHELLS[shell])
    if not user or user == current_user():
        return argv
    if os.geteuid() != 0:
        raise PermissionError(user)
    if not user_exists(user):
        raise LookupError(user)
    if shutil.which("runuser"):
        return ["runuser", "-u", user, "--", *argv]
    if shutil.which("sudo"):
        return ["sudo", "-n", "-u", user, "--", *argv]
    # Login shell: su picks the account's shell, not ours. Last resort.
    return ["su", "-", user]


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
            note += (
                "\r\nSnippyCode: cannot switch to %s; this agent is not root (running as %s).\r\n"
                % (requested, current_user())
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
    try:
        pid, fd = spawn(shell, user)
    except PermissionError:
        return report_and_exit(
            bridge,
            current_user(),
            "SnippyCode: this agent is not root, so it cannot run as %s. It is running as %s."
            % (user, current_user()),
            1,
        )
    except LookupError:
        return report_and_exit(bridge, current_user(), "SnippyCode: there is no local account named %s." % user, 1)
    except (OSError, ValueError) as exc:
        return report_and_exit(bridge, current_user(), "SnippyCode: could not start the shell: %s" % exc, 127)

    started = time.time()
    last_io = started
    exit_code = 0
    message = ""
    pending = ("SnippyCode terminal (%s, account %s). Keystrokes go to this shell.\r\n" % (shell, active)).encode()
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
SNIPPY_PTY_PY
  chmod 700 "$dest"
}

# Language "pty" only. One-shot jobs stay in run_job with stdin closed.
run_pty_job() {
  local id="$1" file="$2"
  local helper="$WORK/pty_session.py"
  local out="$WORK/job-$id.pty.out" err="$WORK/job-$id.pty.err"
  local started duration exit_code=0 attempt py=""
  : > "$out"
  : > "$err"
  started="$(now_ms)"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is not installed, so this device cannot open an interactive terminal." > "$err"
    exit_code=127
  else
    extract_pty_helper "$helper"
    # A non-zero python exit must not skip the result post (the agent runs with set -e).
    SNIPPYCODE_URL="$URL" SNIPPYCODE_TOKEN="$DEVICE_TOKEN" SNIPPYCODE_FINGERPRINT="$FINGERPRINT" \
      python3 -u "$helper" "$id" "$file" >"$out" 2>"$err" &
    py=$!
    trap 'kill "$py" 2>/dev/null || true' TERM INT
    wait "$py" || exit_code=$?
    trap - TERM INT
  fi
  duration=$(( $(now_ms) - started ))
  # The helper usually reports the result itself. A second post is ignored.
  for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 60 \
      -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Agent-Fingerprint: $FINGERPRINT" \
      -F "exitCode=$exit_code" \
      -F "durationMs=$duration" \
      -F "timedOut=false" \
      -F "stdout=@$out;type=text/plain" \
      -F "stderr=@$err;type=text/plain" \
      "$URL/api/agent/jobs/$id/result" >/dev/null; then
      break
    fi
    log "Could not send the result of terminal job $id (attempt $attempt)"
    sleep $(( attempt * 5 ))
  done
  rm -f "$file" "$out" "$err"
  log "Terminal job $id finished with exit code $exit_code"
}

run_job() {
  local id="$1" language="$2" timeout_ms="$3" file="$4"
  local out="$WORK/job-$id.out" err="$WORK/job-$id.err"
  local interpreter exit_code timed_out="false" started duration seconds

  # Interactive session. Runs in the background so one-shot jobs still run.
  if [ "$language" = "pty" ]; then
    if [ -n "${PTY_PID:-}" ]; then
      kill "$PTY_PID" 2>/dev/null || true
    fi
    run_pty_job "$id" "$file" &
    PTY_PID=$!
    log "Interactive terminal job $id started"
    return 0
  fi

  interpreter="$(interpreter_for "$language")"
  started="$(now_ms)"
  seconds=$(( (timeout_ms + 999) / 1000 ))

  if [ -z "$interpreter" ] || ! command -v "$interpreter" >/dev/null 2>&1; then
    : > "$out"
    echo "This device cannot run $language (no ${interpreter:-interpreter} installed)." > "$err"
    exit_code=127
  else
    (cd "$WORK" && timeout --kill-after=5 "${seconds}s" "$interpreter" "$file" </dev/null >"$out" 2>"$err")
    exit_code=$?
    if [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ]; then
      timed_out="true"
      echo "Timed out after ${seconds}s on the device." >> "$err"
    fi
  fi

  duration=$(( $(now_ms) - started ))

  for stream in "$out" "$err"; do
    if [ "$(wc -c < "$stream")" -gt "$MAX_OUTPUT_BYTES" ]; then
      head -c "$MAX_OUTPUT_BYTES" "$stream" > "$stream.cut" && mv "$stream.cut" "$stream"
      printf '\n...[truncated on the device]\n' >> "$stream"
    fi
  done

  local attempt
  for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 60 \
      -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Agent-Fingerprint: $FINGERPRINT" \
      -F "exitCode=$exit_code" \
      -F "durationMs=$duration" \
      -F "timedOut=$timed_out" \
      -F "stdout=@$out;type=text/plain" \
      -F "stderr=@$err;type=text/plain" \
      "$URL/api/agent/jobs/$id/result" >/dev/null; then
      break
    fi
    log "Could not send the result of job $id (attempt $attempt)"
    sleep $(( attempt * 5 ))
  done

  rm -f "$file" "$out" "$err"
  log "Job $id ($language) finished with exit code $exit_code"
}

log "SnippyCode agent $AGENT_VERSION polling $URL"
PTY_PID=""
cleanup_pty() {
  if [ -n "${PTY_PID:-}" ]; then
    kill "$PTY_PID" 2>/dev/null || true
  fi
}
trap cleanup_pty EXIT
backoff=5
facts_at=0
update_tried=""

while true; do
  # Every 2 minutes: feeds monitors and the trend graphs
  if [ $(( $(date +%s) - facts_at )) -ge 120 ]; then
    send_facts
    facts_at="$(date +%s)"
  fi

  headers="$WORK/next.headers"
  body="$WORK/next.body"
  status="$(curl -sS --max-time 45 -o "$body" -D "$headers" -w '%{http_code}' \
    -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Agent-Fingerprint: $FINGERPRINT" \
    "$URL/api/agent/next?wait=25&version=$AGENT_VERSION&caps=$(capabilities)&agentId=$AGENT_ID")" || status="000"

  # Update between jobs, and try each new version only once
  latest="$(header x-agent-latest "$headers" 2>/dev/null)"
  if [ -n "$latest" ] && [ "$latest" != "$AGENT_VERSION" ] && [ "$latest" != "$update_tried" ] && [ "$status" = "204" ]; then
    update_tried="$latest"
    self_update "$latest"
  fi

  case "$status" in
    200)
      id="$(header x-job-id "$headers")"
      language="$(header x-job-language "$headers")"
      timeout_ms="$(header x-job-timeout-ms "$headers")"
      case "$id" in ''|*[!0-9]*) log "Ignoring a job with a bad id"; continue ;; esac
      case "$timeout_ms" in ''|*[!0-9]*) timeout_ms=300000 ;; esac
      file="$WORK/job-$id.script"
      mv "$body" "$file"
      chmod 700 "$file"
      log "Running job $id ($language)"
      run_job "$id" "$language" "$timeout_ms" "$file"
      backoff=5
      ;;
    204)
      backoff=5
      ;;
    409)
      if [ -n "$(header x-reenrol-required "$headers" 2>/dev/null)" ]; then
        log "The server says this device token belongs to other hardware; re-enrolling"
        reenrol || sleep 300
      else
        sleep "$backoff"
      fi
      ;;
    401|403)
      log "The device token was rejected (revoked?). Retrying in 5 minutes."
      sleep 300
      ;;
    *)
      log "SnippyCode is not reachable (HTTP $status). Retrying in ${backoff}s."
      sleep "$backoff"
      backoff=$(( backoff < 60 ? backoff * 2 : 60 ))
      ;;
  esac
  rm -f "$headers" "$body"
done
