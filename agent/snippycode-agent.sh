#!/usr/bin/env bash
# SnippyCode agent for Linux.
#
# Polls SnippyCode for jobs queued for this device, runs them here, and sends
# back the output. Installed and started by install.sh; settings live in
# /etc/snippycode-agent.conf (URL, DEVICE_TOKEN, ALLOW_HTTP).
set -uo pipefail

AGENT_VERSION="1.3.0"
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
    -H "Authorization: Bearer $DEVICE_TOKEN" \
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

# Replace this script with the server's newer agent and restart. The new
# file must parse and report the expected version before it is swapped in.
self_update() {
  local latest="$1" self new
  [ "$AUTO_UPDATE" = "1" ] || return 0
  self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  [ -w "$self" ] || { log "Agent $latest is available but $self is not writable"; return 0; }

  new="$WORK/agent.new"
  if curl -fsSL --max-time 60 "$URL/agent/snippycode-agent.sh" -o "$new" \
    && bash -n "$new" \
    && grep -q "^AGENT_VERSION=\"$latest\"" "$new"; then
    chmod 755 "$new"
    mv "$new" "$self"
    log "Updated from $AGENT_VERSION to $latest; restarting"
    exec "$self"
  fi

  rm -f "$new"
  log "Update to $latest failed; staying on $AGENT_VERSION"
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
      -H "Authorization: Bearer $DEVICE_TOKEN" \
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
    -H "Authorization: Bearer $DEVICE_TOKEN" \
    "$URL/api/agent/next?wait=25&version=$AGENT_VERSION&caps=$(capabilities)")" || status="000"

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
