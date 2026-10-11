#!/usr/bin/env bash
# Install the SnippyCode agent on Linux as a systemd service.
#
#   curl -fsSL https://snippycode.example/agent/install.sh | sudo bash -s -- \
#     --url https://snippycode.example --token sc_enroll_...
#
# The token can be single-use or a reusable bulk enrolment token: run the
# same command on many machines and each gets its own device. Running it
# again on a machine reuses that machine's device (matched by machine ID).
#
# Options: --name NAME  --allow-http  --uninstall
#   --reset-id  delete and regenerate this machine's agent ID (e.g. after
#               cloning a disk image), so it enrols as a new device
# Update an installed agent in place (keeps its enrollment):
#   curl -fsSL https://snippycode.example/agent/install.sh | sudo bash -s -- --upgrade
set -euo pipefail

URL=""
TOKEN=""
NAME=""
ALLOW_HTTP="0"
UNINSTALL="0"
UPGRADE="0"
RESET_ID="0"
AGENT_VERSION="1.3.0"
BIN="${SNIPPYCODE_AGENT_BIN:-/usr/local/bin/snippycode-agent}"
CONFIG="${SNIPPYCODE_AGENT_CONFIG:-/etc/snippycode-agent.conf}"
UNIT="${SNIPPYCODE_AGENT_UNIT:-/etc/systemd/system/snippycode-agent.service}"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --allow-http) ALLOW_HTTP="1"; shift ;;
    --uninstall) UNINSTALL="1"; shift ;;
    --upgrade) UPGRADE="1"; shift ;;
    --reset-id) RESET_ID="1"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (sudo)." >&2
  exit 1
fi

if [ "$UNINSTALL" = "1" ]; then
  systemctl disable --now snippycode-agent 2>/dev/null || true
  rm -f "$UNIT" "$BIN" "$CONFIG"
  rm -rf /var/lib/snippycode-agent
  systemctl daemon-reload 2>/dev/null || true
  echo "SnippyCode agent removed. Revoke the device in SnippyCode too."
  exit 0
fi

if [ "$UPGRADE" = "1" ]; then
  [ -r "$CONFIG" ] || { echo "No agent is installed here ($CONFIG is missing)." >&2; exit 1; }
  # shellcheck source=/dev/null
  . "$CONFIG"
  URL="${URL%/}"
  echo "Updating the agent from $URL"
  curl -fsSL "$URL/agent/snippycode-agent.sh" -o "$BIN.tmp"
  bash -n "$BIN.tmp"
  chmod 755 "$BIN.tmp"
  mv "$BIN.tmp" "$BIN"
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    [ -f "$UNIT" ] && chmod 644 "$UNIT" && systemctl daemon-reload
    systemctl restart snippycode-agent
  fi
  echo "Updated to $(sed -n 's/^AGENT_VERSION="\(.*\)"/\1/p' "$BIN"). The device keeps its enrollment."
  exit 0
fi

if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
  echo "Usage: install.sh --url https://snippycode.example --token sc_enroll_..." >&2
  exit 1
fi

for tool in curl timeout; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

case "$URL" in
  https://*|http://localhost*|http://127.*) ;;
  http://*)
    if [ "$ALLOW_HTTP" != "1" ]; then
      echo "Jobs can contain secrets, so the agent only talks HTTPS. Use --allow-http to override." >&2
      exit 1
    fi
    ;;
  *) echo "--url must start with https://" >&2; exit 1 ;;
esac

echo "Downloading the agent from $URL"
curl -fsSL "$URL/agent/snippycode-agent.sh" -o "$BIN.tmp"
chmod 755 "$BIN.tmp"
mv "$BIN.tmp" "$BIN"

MACHINE_ID=""
for file in /etc/machine-id /var/lib/dbus/machine-id; do
  if [ -r "$file" ]; then MACHINE_ID="$(tr -d '[:space:]' < "$file")"; break; fi
done

# Stable random agent ID, created once and kept across re-installs
AGENT_ID_DIR="${SNIPPYCODE_AGENT_ID_DIR:-/etc/snippycode-agent}"
AGENT_ID_FILE="$AGENT_ID_DIR/agent-id"
AGENT_ID=""
if [ "$RESET_ID" = "1" ]; then
  echo "Resetting the agent ID"
  rm -f "$AGENT_ID_FILE"
fi
if [ -r "$AGENT_ID_FILE" ]; then AGENT_ID="$(tr -dc 'a-f0-9-' < "$AGENT_ID_FILE")"; fi
if [ "${#AGENT_ID}" -ne 36 ]; then
  if [ -r /proc/sys/kernel/random/uuid ]; then
    AGENT_ID="$(cat /proc/sys/kernel/random/uuid)"
  else
    AGENT_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | sed 's/^\(.\{8\}\)\(.\{4\}\).\(.\{3\}\).\(.\{3\}\)\(.\{12\}\).*/\1-\2-4\3-a\4-\5/')"
  fi
  mkdir -p "$AGENT_ID_DIR"
  chmod 700 "$AGENT_ID_DIR"
  (umask 077 && printf '%s\n' "$AGENT_ID" > "$AGENT_ID_FILE")
fi
chmod 600 "$AGENT_ID_FILE"

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

echo "Enrolling $(hostname)"
response="$(curl -fsS -X POST "$URL/api/agent/enroll?format=env" \
  -H "X-Agent-Fingerprint: $FINGERPRINT" \
  --data-urlencode "token=$TOKEN" \
  --data-urlencode "hostname=$(hostname)" \
  --data-urlencode "machineId=$MACHINE_ID" \
  --data-urlencode "agentId=$AGENT_ID" \
  --data-urlencode "name=${NAME:-$(hostname)}" \
  --data-urlencode "os=linux" \
  --data-urlencode "arch=$(uname -m)" \
  --data-urlencode "version=$AGENT_VERSION")" || {
  echo "Enrollment failed. The token may be expired, revoked or used up." >&2
  exit 1
}

DEVICE_TOKEN="$(printf '%s\n' "$response" | sed -n 's/^DEVICE_TOKEN=//p')"
SITE="$(printf '%s\n' "$response" | sed -n 's/^SITE=//p')"
NEW_AGENT_ID="$(printf '%s\n' "$response" | sed -n 's/^AGENT_ID=//p' | tr -dc 'a-f0-9-')"
# A clone gets a fresh agent ID from the server: keep it from now on
if [ "${#NEW_AGENT_ID}" -eq 36 ] && [ "$NEW_AGENT_ID" != "$AGENT_ID" ]; then
  echo "This machine looks like a clone; it was given its own agent ID."
  (umask 077 && printf '%s\n' "$NEW_AGENT_ID" > "$AGENT_ID_FILE")
  AGENT_ID="$NEW_AGENT_ID"
fi

if [ -z "$DEVICE_TOKEN" ]; then
  echo "Enrollment did not return a device token." >&2
  exit 1
fi

umask 077
cat > "$CONFIG" <<CONF
URL="$URL"
DEVICE_TOKEN="$DEVICE_TOKEN"
ALLOW_HTTP="$ALLOW_HTTP"
CONF
chmod 600 "$CONFIG"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > "$UNIT" <<UNITFILE
[Unit]
Description=SnippyCode agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$BIN
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNITFILE
  # The unit holds no secrets (those are in $CONFIG); systemd expects it readable
  chmod 644 "$UNIT"
  systemctl daemon-reload
  systemctl enable --now snippycode-agent
  echo "Installed. This device is enrolled at site '$SITE' and the agent is running."
  echo "Logs: journalctl -u snippycode-agent -f"
else
  echo "Installed and enrolled at site '$SITE', but systemd was not found."
  echo "Start the agent with: $BIN"
fi
