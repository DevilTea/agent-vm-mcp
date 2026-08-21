#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$repo_root/config/playwright-start-headed.sh.template"
x_unit="$repo_root/config/systemd/agent-browser-x.service.template"
vnc_unit="$repo_root/config/systemd/agent-browser-vnc.service.template"
novnc_unit="$repo_root/config/systemd/agent-browser-novnc.service.template"
tunnel_dropin="$repo_root/config/systemd/agent-tunnel-browser.conf"
provisioner="$repo_root/scripts/provision-browser-takeover.sh"

require_literal() {
  local file=$1
  local literal=$2
  grep -Fq -- "$literal" "$file" || {
    echo "Missing required browser takeover contract in $file: $literal" >&2
    exit 1
  }
}

reject_literal() {
  local file=$1
  local literal=$2
  if grep -Fq -- "$literal" "$file"; then
    echo "Forbidden browser takeover contract in $file: $literal" >&2
    exit 1
  fi
}

require_literal "$launcher" 'export DISPLAY=:99'
require_literal "$launcher" '--user-data-dir "@AGENT_HOME@/.local/share/playwright-mcp/profile"'
require_literal "$launcher" '--output-dir "@AGENT_HOME@/.local/share/playwright-mcp/output"'
reject_literal "$launcher" '--headless'

require_literal "$x_unit" 'ExecStart=/usr/bin/Xvfb :99'
require_literal "$x_unit" '-nolisten tcp'
require_literal "$x_unit" 'ExecStartPost=/usr/bin/timeout 5s /bin/sh -c'
require_literal "$x_unit" '/usr/bin/xdpyinfo -display :99'
require_literal "$x_unit" 'Restart=always'

require_literal "$vnc_unit" 'Wants=agent-browser-x.service'
require_literal "$vnc_unit" '-listen 127.0.0.1'
require_literal "$vnc_unit" '-no6'
require_literal "$vnc_unit" '-rfbport 5900'

require_literal "$novnc_unit" 'Wants=agent-browser-vnc.service'
require_literal "$novnc_unit" '127.0.0.1:6080 127.0.0.1:5900'

require_literal "$tunnel_dropin" 'Requires=agent-browser-x.service'
require_literal "$tunnel_dropin" 'After=agent-browser-x.service'

for package in novnc websockify x11-utils x11vnc xvfb tailscale; do
  require_literal "$provisioner" "$package"
done
require_literal "$provisioner" 'systemctl enable --now tailscaled.service'
if grep -Eq '^[[:space:]]*tailscale[[:space:]]+(up|serve|ssh)([[:space:]]|$)' "$provisioner"; then
  echo "Provisioner must not enroll Tailscale, expose noVNC with tailscale serve, or enable Tailscale SSH." >&2
  exit 1
fi
require_literal "$vnc_unit" 'Restart=always'
require_literal "$novnc_unit" 'Restart=always'

echo "PASS browser takeover deployment contract"
