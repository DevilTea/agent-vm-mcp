#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
  echo "Run as root: sudo $0 [MCP_INSTALL_ROOT]" >&2
  exit 2
fi

agent_user=$(printenv AGENT_VM_USER || true)
if [[ -z "$agent_user" ]]; then agent_user=agent; fi
getent passwd "$agent_user" >/dev/null || { echo "Unknown agent user: $agent_user" >&2; exit 1; }
agent_home=$(getent passwd "$agent_user" | cut -d: -f6)
agent_group=$(id -gn "$agent_user")
if (( $# > 0 )); then mcp_root="$1"; else mcp_root=/opt/agent-vm-mcp; fi
mcp_root=$(realpath "$mcp_root")
[[ -f "$mcp_root/src/agent-jobs/manager.js" ]] || {
  echo "Deploy the V1 source to $mcp_root before provisioning agent-jobd." >&2
  exit 1
}
repo_root=$(cd "$(dirname "$0")/.." && pwd)
shims="$agent_home/.local/share/mise/shims"
control_node=$(runuser -u "$agent_user" -- env \
  "HOME=$agent_home" "XDG_CONFIG_HOME=$agent_home/.config" \
  "PATH=$shims:/usr/local/bin:/usr/bin:/bin" mise which node)
[[ -x "$control_node" ]] || { echo "Pinned control-plane Node is unavailable: $control_node" >&2; exit 1; }

install -d -m 0700 -o "$agent_user" -g "$agent_group" \
  "$agent_home/.local/state/agent-vm-mcp/jobs"
AGENT_USER="$agent_user" AGENT_GROUP="$agent_group" AGENT_HOME="$agent_home" \
MISE_SHIMS="$shims" AGENT_MCP_ROOT="$mcp_root" CONTROL_NODE="$control_node" \
  python3 "$repo_root/scripts/render-systemd-template.py" \
    "$repo_root/config/systemd/agent-jobd.service.template" \
    /etc/systemd/system/agent-jobd.service

# The tunnel remains available if the job manager is temporarily unhealthy.
install -d -m 0755 /etc/systemd/system/agent-tunnel.service.d
cat > /etc/systemd/system/agent-tunnel.service.d/50-agent-jobd.conf <<'UNIT'
[Unit]
Wants=agent-jobd.service
After=agent-jobd.service
UNIT

systemctl daemon-reload
systemctl enable --now agent-jobd.service
systemctl is-active --quiet agent-jobd.service
echo "agent-jobd is active. Restart agent-tunnel only after tests and deployment checks."
