#!/usr/bin/env bash
# Install the SnippyCode agent on Linux as a systemd service.
#
#   curl -fsSL https://snippycode.example/agent/install.sh | sudo bash -s -- \
#     --url https://snippycode.example --token sc_enroll_...
#
# Options: --name NAME  --allow-http  --uninstall
# Update an installed agent in place (keeps its enrollment):
#   curl -fsSL https://snippycode.example/agent/install.sh | sudo bash -s -- --upgrade
set -euo pipefail

URL=""
TOKEN=""
NAME=""
ALLOW_HTTP="0"
UNINSTALL="0"
UPGRADE="0"
AGENT_VERSION="1.3.0"
BIN="/usr/local/bin/snippycode-agent"
CONFIG="/etc/snippycode-agent.conf"
UNIT="/etc/systemd/system/snippycode-agent.service"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --allow-http) ALLOW_HTTP="1"; shift ;;
    --uninstall) UNINSTALL="1"; shift ;;
    --upgrade) UPGRADE="1"; shift ;;
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

echo "Enrolling $(hostname)"
response="$(curl -fsS -X POST "$URL/api/agent/enroll?format=env" \
  --data-urlencode "token=$TOKEN" \
  --data-urlencode "hostname=$(hostname)" \
  --data-urlencode "name=${NAME:-$(hostname)}" \
  --data-urlencode "os=linux" \
  --data-urlencode "arch=$(uname -m)" \
  --data-urlencode "version=$AGENT_VERSION")" || {
  echo "Enrollment failed. The token may be expired or already used." >&2
  exit 1
}

DEVICE_TOKEN="$(printf '%s\n' "$response" | sed -n 's/^DEVICE_TOKEN=//p')"
SITE="$(printf '%s\n' "$response" | sed -n 's/^SITE=//p')"

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
