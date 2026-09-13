#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
service="$repo_root/config/systemd/agent-herdr.service.template"
tunnel_example="$repo_root/config/examples/systemd/agent-tunnel-herdr.conf.template"
provision="$repo_root/scripts/provision-mise.sh"

[[ -r $service && -r $tunnel_example ]]
grep -Fq 'ExecStart=@HERDR_BIN@ --session @HERDR_SESSION@ server' "$service"
grep -Fq 'Environment=PATH=@MISE_SHIMS@:@AGENT_HOME@/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' "$service"
! grep -Fq 'agent-tunnel.service' "$service"
grep -Fq '/etc/systemd/system/agent-herdr.service' "$provision"
! grep -Fq '/etc/systemd/system/agent-tunnel.service' "$provision"
! grep -Fq '.config/tunnel-client' "$provision"
grep -Fq 'systemctl daemon-reload' "$provision"
grep -Fq 'systemctl enable agent-herdr.service' "$provision"
grep -Fq 'install -d -m 0755 -o "$agent_user" -g "$agent_group" "$agent_config_root"' "$provision"

# Optional tunnel integration remains an example, not something the core provisioner installs.
grep -Fq 'Requires=agent-herdr.service' "$tunnel_example"
grep -Fq 'After=agent-herdr.service' "$tunnel_example"
grep -Fq 'Environment=AGENT_HERDR_BOOTSTRAP=external' "$tunnel_example"

verify_root=$(mktemp -d)
trap 'rm -rf "$verify_root"' EXIT
AGENT_USER=agent \
AGENT_GROUP=agent \
AGENT_HOME=/home/agent \
MISE_SHIMS=/home/agent/.local/share/mise/shims \
HERDR_BIN=/bin/true \
HERDR_SESSION=agent-vm-mcp \
python3 "$repo_root/scripts/render-systemd-template.py" \
  "$service" "$verify_root/agent-herdr.service"

grep -Fq '/home/agent/.local/bin' "$verify_root/agent-herdr.service"
unit_path="$verify_root:/etc/systemd/system:/usr/local/lib/systemd/system:/usr/lib/systemd/system:/lib/systemd/system"
if ! SYSTEMD_UNIT_PATH="$unit_path" systemd-analyze verify agent-herdr.service >/dev/null 2>"$verify_root/verify.err"; then
  cat "$verify_root/verify.err" >&2
  exit 1
fi

echo 'PASS Herdr deployment contract'
