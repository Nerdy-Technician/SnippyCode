#!/usr/bin/env bash
# SnippyCode agent for Linux.
#
# Polls SnippyCode for jobs queued for this device, runs them here, and sends
# back the output. Installed and started by install.sh; settings live in
# /etc/snippycode-agent.conf (URL, DEVICE_TOKEN, ALLOW_HTTP).
set -uo pipefail

AGENT_VERSION="1.4.0"
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

run_job() {
  local id="$1" language="$2" timeout_ms="$3" file="$4"
  local out="$WORK/job-$id.out" err="$WORK/job-$id.err"
  local interpreter exit_code timed_out="false" started duration seconds

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
