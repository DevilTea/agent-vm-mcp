#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bridge_config="$repo_root/config/bridges.json"
shared_launcher="$repo_root/config/playwright-start-shared.sh.template"
isolated_launcher="$repo_root/config/playwright-start-isolated.sh.template"
x_unit="$repo_root/config/systemd/agent-browser-x.service.template"
playwright_unit="$repo_root/config/systemd/agent-playwright-shared.service.template"
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

require_literal "$bridge_config" '"type": "streamable-http"'
require_literal "$bridge_config" '"url": "http://localhost:8931/mcp"'
reject_literal "$bridge_config" '"command": "/opt/playwright-mcp/start.sh"'

require_literal "$shared_launcher" 'export DISPLAY=:99'
require_literal "$shared_launcher" '--user-data-dir "@AGENT_HOME@/.local/share/playwright-mcp/profile"'
require_literal "$shared_launcher" '--output-dir "@AGENT_HOME@/.local/share/playwright-mcp/output"'
require_literal "$shared_launcher" '--host 127.0.0.1'
require_literal "$shared_launcher" '--port 8931'
require_literal "$shared_launcher" '--shared-browser-context'
reject_literal "$shared_launcher" '--headless'
reject_literal "$shared_launcher" '--isolated'

require_literal "$isolated_launcher" '--headless'
require_literal "$isolated_launcher" '--isolated'
require_literal "$isolated_launcher" '--output-dir "@AGENT_HOME@/.local/share/playwright-mcp/fresh-output"'
reject_literal "$isolated_launcher" '--user-data-dir'
reject_literal "$isolated_launcher" '--shared-browser-context'

require_literal "$playwright_unit" 'Requires=agent-browser-x.service'
require_literal "$playwright_unit" 'After=agent-browser-x.service'
require_literal "$playwright_unit" 'ExecStart=/opt/playwright-mcp/start-shared.sh'
require_literal "$playwright_unit" 'Restart=always'

require_literal "$x_unit" 'ExecStart=/usr/bin/Xvfb :99'
require_literal "$x_unit" '-nolisten tcp'
require_literal "$x_unit" 'ExecStartPost=/usr/bin/timeout 5s /bin/sh -c'
require_literal "$x_unit" '/usr/bin/xdpyinfo -display :99'
require_literal "$x_unit" 'Restart=always'

require_literal "$vnc_unit" 'Wants=agent-browser-x.service'
require_literal "$vnc_unit" '-listen 127.0.0.1'
require_literal "$vnc_unit" '-no6'
require_literal "$vnc_unit" '-rfbportv6 0'
require_literal "$vnc_unit" '-rfbport 5900'

require_literal "$novnc_unit" 'Wants=agent-browser-vnc.service'
require_literal "$novnc_unit" '127.0.0.1:6080 127.0.0.1:5900'

require_literal "$tunnel_dropin" 'Requires=agent-browser-x.service agent-playwright-shared.service'
require_literal "$tunnel_dropin" 'After=agent-browser-x.service agent-playwright-shared.service'

for package in novnc websockify x11-utils x11vnc xvfb tailscale; do
  require_literal "$provisioner" "$package"
done
require_literal "$provisioner" 'systemctl enable --now tailscaled.service'
require_literal "$provisioner" 'systemctl enable agent-playwright-shared.service'
reject_literal "$provisioner" 'systemctl enable --now agent-playwright-shared.service'
if grep -Eq '^[[:space:]]*tailscale[[:space:]]+(up|serve|ssh)([[:space:]]|$)' "$provisioner"; then
  echo "Provisioner must not enroll Tailscale, expose noVNC with tailscale serve, or enable Tailscale SSH." >&2
  exit 1
fi
require_literal "$vnc_unit" 'Restart=always'
require_literal "$novnc_unit" 'Restart=always'

echo "PASS browser takeover deployment contract"
