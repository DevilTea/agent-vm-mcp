#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root, for example: sudo $0" >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "/etc/os-release is required" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ ${ID:-} != "ubuntu" ]]; then
  echo "Unsupported distribution: ${ID:-unknown}; this provisioner currently targets Ubuntu." >&2
  exit 1
fi
if [[ -z ${VERSION_CODENAME:-} ]]; then
  echo "Ubuntu VERSION_CODENAME is required for Tailscale repository provisioning." >&2
  exit 1
fi

agent_user=${AGENT_VM_USER:-agent}
agent_passwd=$(getent passwd "$agent_user" || true)
if [[ -z $agent_passwd ]]; then
  echo "Agent user does not exist: $agent_user" >&2
  exit 1
fi

agent_home=$(cut -d: -f6 <<<"$agent_passwd")
agent_group=$(id -gn "$agent_user")
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
canonical_control_plane_root=/opt/agent-vm-mcp
if [[ $repo_root != "$canonical_control_plane_root" ]]; then
  echo "Browser takeover provisioning requires agent-vm-mcp to be deployed at $canonical_control_plane_root." >&2
  echo "Current checkout: $repo_root" >&2
  exit 1
fi
node_version=24.20.0
mise_data_dir="$agent_home/.local/share/mise"
mise_shims="$mise_data_dir/shims"
node_bin="$mise_data_dir/installs/node/$node_version/bin/node"
playwright_shared_launcher_source="$repo_root/config/playwright-start-shared.sh.template"
playwright_shared_proxy_launcher_source="$repo_root/config/playwright-start-shared-proxy.sh.template"
playwright_isolated_launcher_source="$repo_root/config/playwright-start-isolated.sh.template"
systemd_template_dir="$repo_root/config/systemd"

for required in \
  "$playwright_shared_launcher_source" \
  "$playwright_shared_proxy_launcher_source" \
  "$playwright_isolated_launcher_source" \
  "$repo_root/config/playwright-shared-proxy.json" \
  "$systemd_template_dir/agent-browser-x.service.template" \
  "$systemd_template_dir/agent-browser-vnc.service.template" \
  "$systemd_template_dir/agent-browser-novnc.service.template" \
  "$systemd_template_dir/agent-playwright-shared.service.template"; do
  if [[ ! -r $required ]]; then
    echo "Missing deployment template: $required" >&2
    exit 1
  fi
done

if [[ ! -x $node_bin ]]; then
  echo "Pinned mise-managed Node executable is missing: $node_bin" >&2
  echo "Run scripts/provision-mise.sh first." >&2
  exit 1
fi
if [[ ! -f /opt/playwright-mcp/node_modules/@playwright/mcp/cli.js ]]; then
  echo "Playwright MCP is not installed at /opt/playwright-mcp." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  novnc \
  websockify \
  x11-utils \
  x11vnc \
  xvfb

tailscale_keyring=/usr/share/keyrings/tailscale-archive-keyring.gpg
tailscale_list=/etc/apt/sources.list.d/tailscale.list
tailscale_base="https://pkgs.tailscale.com/stable/ubuntu"

tmp_keyring=$(mktemp)
tmp_list=$(mktemp)
trap 'rm -f "$tmp_keyring" "$tmp_list"' EXIT
curl -fsSL "$tailscale_base/$VERSION_CODENAME.noarmor.gpg" -o "$tmp_keyring"
curl -fsSL "$tailscale_base/$VERSION_CODENAME.tailscale-keyring.list" -o "$tmp_list"
install -m 0644 -o root -g root "$tmp_keyring" "$tailscale_keyring"
install -m 0644 -o root -g root "$tmp_list" "$tailscale_list"

apt-get update
apt-get install -y --no-install-recommends tailscale

render_template() {
  local source=$1
  local destination=$2
  local mode=${3:-0644}

  AGENT_USER="$agent_user" \
  AGENT_GROUP="$agent_group" \
  AGENT_HOME="$agent_home" \
  MISE_SHIMS="$mise_shims" \
  NODE_BIN="$node_bin" \
    python3 - "$source" "$destination" <<'PY'
import os
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
text = source.read_text()
replacements = {
    "@AGENT_USER@": os.environ["AGENT_USER"],
    "@AGENT_GROUP@": os.environ["AGENT_GROUP"],
    "@AGENT_HOME@": os.environ["AGENT_HOME"],
    "@MISE_SHIMS@": os.environ["MISE_SHIMS"],
    "@NODE_BIN@": os.environ["NODE_BIN"],
}
for placeholder, value in replacements.items():
    text = text.replace(placeholder, value)
if "@AGENT_" in text or "@MISE_" in text or "@NODE_" in text:
    raise SystemExit(f"unresolved deployment placeholder in {source}")
destination.write_text(text)
PY
  chown root:root "$destination"
  chmod "$mode" "$destination"
}

render_template "$systemd_template_dir/agent-browser-x.service.template" /etc/systemd/system/agent-browser-x.service
render_template "$systemd_template_dir/agent-browser-vnc.service.template" /etc/systemd/system/agent-browser-vnc.service
render_template "$systemd_template_dir/agent-browser-novnc.service.template" /etc/systemd/system/agent-browser-novnc.service
render_template "$systemd_template_dir/agent-playwright-shared.service.template" /etc/systemd/system/agent-playwright-shared.service

render_template "$playwright_shared_launcher_source" /opt/playwright-mcp/start-shared.sh 0755
render_template "$playwright_shared_proxy_launcher_source" /opt/playwright-mcp/start-shared-proxy.sh 0755
render_template "$playwright_isolated_launcher_source" /opt/playwright-mcp/start-isolated.sh 0755

systemctl daemon-reload
systemctl enable --now agent-browser-x.service
systemctl enable --now agent-browser-vnc.service
systemctl enable --now agent-browser-novnc.service
systemctl enable agent-playwright-shared.service
systemctl enable --now tailscaled.service

systemctl is-active --quiet agent-browser-x.service
systemctl is-active --quiet agent-browser-vnc.service
systemctl is-active --quiet agent-browser-novnc.service
systemctl is-active --quiet tailscaled.service

echo "Browser takeover dependencies provisioned for $agent_user."
echo "Tailscale enrollment remains explicit; run tailscale up separately as the operator when ready."
echo "Shared Playwright MCP was installed and enabled but not started."
echo "Start agent-playwright-shared.service separately during an idle window after confirming no other process owns the persistent browser profile."
