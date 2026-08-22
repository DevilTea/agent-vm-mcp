#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
service="$repo_root/config/systemd/agent-herdr.service.template"
dropin="$repo_root/config/systemd/agent-tunnel-herdr.conf.template"
provision="$repo_root/scripts/provision-mise.sh"

[[ -r $service && -r $dropin ]]
grep -Fq 'ExecStart=@HERDR_BIN@ --session @HERDR_SESSION@ server' "$service"
grep -Fq 'Before=agent-tunnel.service' "$service"
grep -Fq 'Environment=PATH=@MISE_SHIMS@:@AGENT_HOME@/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' "$service"
grep -Fq 'Requires=agent-herdr.service' "$dropin"
grep -Fq 'After=agent-herdr.service' "$dropin"
grep -Fq 'Environment=AGENT_HERDR_BOOTSTRAP=external' "$dropin"
grep -Fq 'Environment=PATH=@MISE_SHIMS@:@AGENT_HOME@/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' "$dropin"
grep -Fq 'Environment=AGENT_HERDR_SESSION=@HERDR_SESSION@' "$dropin"
grep -Fq 'Environment=AGENT_HERDR_BIN=@HERDR_BIN@' "$dropin"
grep -Fq '/etc/systemd/system/agent-herdr.service' "$provision"
grep -Fq '/etc/systemd/system/agent-tunnel.service.d/20-herdr.conf' "$provision"
grep -Fq 'systemctl daemon-reload' "$provision"
grep -Fq 'systemctl enable agent-herdr.service' "$provision"

reload_line=$(grep -nF 'systemctl daemon-reload' "$provision" | tail -1 | cut -d: -f1)
enable_line=$(grep -nF 'systemctl enable agent-herdr.service' "$provision" | tail -1 | cut -d: -f1)
[[ $reload_line -lt $enable_line ]]

# The tunnel must depend on the separately supervised service, never launch Herdr itself.
if grep -Eq '^Exec(Start|StartPre)=.*herdr' "$dropin"; then
  echo 'tunnel drop-in must not launch Herdr' >&2
  exit 1
fi

verify_root=$(mktemp -d)
trap 'rm -rf "$verify_root"' EXIT
AGENT_USER=agent \
AGENT_GROUP=agent \
AGENT_HOME=/home/agent \
MISE_SHIMS=/home/agent/.local/share/mise/shims \
HERDR_BIN=/home/agent/.local/share/mise/installs/herdr/0.8.2/herdr \
HERDR_SESSION=agent-vm-mcp \
python3 "$repo_root/scripts/render-systemd-template.py" \
  "$service" "$verify_root/agent-herdr.service"

AGENT_USER=agent \
AGENT_GROUP=agent \
AGENT_HOME=/home/agent \
MISE_SHIMS=/home/agent/.local/share/mise/shims \
HERDR_BIN=/home/agent/.local/share/mise/installs/herdr/0.8.2/herdr \
HERDR_SESSION=agent-vm-mcp \
python3 "$repo_root/scripts/render-systemd-template.py" \
  "$dropin" "$verify_root/agent-tunnel.service.d/20-herdr.conf"

grep -Fq '/home/agent/.local/bin' "$verify_root/agent-herdr.service"
grep -Fq '/home/agent/.local/bin' "$verify_root/agent-tunnel.service.d/20-herdr.conf"

printf '%s\n' \
  '[Unit]' \
  'Description=agent tunnel verification stub' \
  '' \
  '[Service]' \
  'Type=simple' \
  'ExecStart=/bin/true' \
  > "$verify_root/agent-tunnel.service"

unit_path="$verify_root:/etc/systemd/system:/usr/local/lib/systemd/system:/usr/lib/systemd/system:/lib/systemd/system"
if ! SYSTEMD_UNIT_PATH="$unit_path" systemd-analyze verify agent-herdr.service agent-tunnel.service >/dev/null 2>"$verify_root/verify.err"; then
  cat "$verify_root/verify.err" >&2
  exit 1
fi

echo 'PASS Herdr deployment contract'
