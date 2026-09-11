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

cleanup_legacy=false
case ${1:-} in
  "") ;;
  --cleanup-legacy) cleanup_legacy=true ;;
  *)
    echo "Usage: sudo $0 [--cleanup-legacy]" >&2
    exit 2
    ;;
esac

agent_user=${AGENT_VM_USER:-agent}
agent_passwd=$(getent passwd "$agent_user" || true)
if [[ -z $agent_passwd ]]; then
  echo "Agent user does not exist: $agent_user" >&2
  exit 1
fi

agent_home=$(cut -d: -f6 <<<"$agent_passwd")
agent_group=$(id -gn "$agent_user")
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mise_config_source="$repo_root/config/agent-mise.toml"
mise_config_dir="$agent_home/.config/mise"
mise_config="$mise_config_dir/config.toml"
mise_data_dir="$agent_home/.local/share/mise"
mise_shims="$mise_data_dir/shims"
node_version=24.20.0
pnpm_version=11.25.0
herdr_version=0.8.2
herdr_session=agent-vm-mcp
node_bin="$mise_data_dir/installs/node/$node_version/bin/node"
herdr_bin="$mise_data_dir/installs/herdr/$herdr_version/herdr"
herdr_service_template="$repo_root/config/systemd/agent-herdr.service.template"
herdr_tunnel_dropin_template="$repo_root/config/systemd/agent-tunnel-herdr.conf.template"
legacy_pnpm_bin="$agent_home/.local/share/pnpm/bin"
legacy_node="$legacy_pnpm_bin/node"

if [[ ! -r $mise_config_source ]]; then
  echo "Missing mise config template: $mise_config_source" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends software-properties-common ca-certificates curl

if ! grep -RqsE '(^|/)jdxcode/mise' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
  add-apt-repository -y ppa:jdxcode/mise
  apt-get update
fi
apt-get install -y --no-install-recommends mise

install -d -m 0755 -o "$agent_user" -g "$agent_group" "$mise_config_dir"
install -m 0644 -o "$agent_user" -g "$agent_group" "$mise_config_source" "$mise_config"

run_as_agent() {
  sudo -u "$agent_user" env \
    HOME="$agent_home" \
    USER="$agent_user" \
    LOGNAME="$agent_user" \
    XDG_CONFIG_HOME="$agent_home/.config" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
}

run_as_agent /usr/bin/mise install "node@$node_version" "pnpm@$pnpm_version" "herdr@$herdr_version"
run_as_agent /usr/bin/mise reshim

if [[ ! -x $node_bin ]]; then
  echo "Pinned mise-managed Node executable is missing: $node_bin" >&2
  exit 1
fi
if [[ ! -x $herdr_bin ]]; then
  echo "Pinned mise-managed Herdr executable is missing: $herdr_bin" >&2
  exit 1
fi
if [[ ! -r $herdr_service_template || ! -r $herdr_tunnel_dropin_template ]]; then
  echo "Missing repo-managed Herdr systemd templates." >&2
  exit 1
fi

replace_literal_if_present() {
  local file=$1
  local old=$2
  local new=$3

  [[ -f $file ]] || return 0

  if grep -Fq -- "$old" "$file"; then
    OLD=$old NEW=$new python3 - "$file" <<'PY'
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
old = os.environ["OLD"]
new = os.environ["NEW"]
text = path.read_text()
path.write_text(text.replace(old, new))
PY
  fi
}

replace_literal_if_present \
  /etc/systemd/system/agent-tunnel.service \
  "$legacy_pnpm_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$mise_shims:$agent_home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

replace_literal_if_present \
  "$agent_home/.config/tunnel-client/agent-01.yaml" \
  "$legacy_node" \
  "$node_bin"

for playwright_launcher in \
  /opt/playwright-mcp/start.sh \
  /opt/playwright-mcp/start-shared.sh \
  /opt/playwright-mcp/start-isolated.sh; do
  replace_literal_if_present \
    "$playwright_launcher" \
    "$legacy_pnpm_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$mise_shims:$agent_home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  replace_literal_if_present \
    "$playwright_launcher" \
    "$legacy_node" \
    "$node_bin"
done

render_systemd_template() {
  local source=$1
  local destination=$2
  AGENT_USER="$agent_user" \
  AGENT_GROUP="$agent_group" \
  AGENT_HOME="$agent_home" \
  MISE_SHIMS="$mise_shims" \
  HERDR_BIN="$herdr_bin" \
  HERDR_SESSION="$herdr_session" \
  python3 "$repo_root/scripts/render-systemd-template.py" "$source" "$destination"
  chmod 0644 "$destination"
}

render_systemd_template "$herdr_service_template" /etc/systemd/system/agent-herdr.service
render_systemd_template \
  "$herdr_tunnel_dropin_template" \
  /etc/systemd/system/agent-tunnel.service.d/20-herdr.conf

bashrc="$agent_home/.bashrc"
if [[ -f $bashrc ]]; then
  AGENT_HOME="$agent_home" python3 - "$bashrc" <<'PY'
import os
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
home = os.environ["AGENT_HOME"]
text = path.read_text()
text = re.sub(r"\n?# pnpm\n.*?# pnpm end\n?", "\n", text, flags=re.DOTALL)
text = re.sub(r"\n?# agent-vm mise shims\n.*?# agent-vm mise shims end\n?", "\n", text, flags=re.DOTALL)
text = text.rstrip() + f'''\n\n# agent-vm mise shims\nexport PATH="{home}/.local/share/mise/shims:$PATH"\n# agent-vm mise shims end\n'''
path.write_text(text)
PY
  chown "$agent_user:$agent_group" "$bashrc"
fi

systemctl daemon-reload
systemctl enable agent-herdr.service

run_as_agent env PATH="$mise_shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" node --version
run_as_agent env PATH="$mise_shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" pnpm --version
run_as_agent env PATH="$mise_shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" herdr --version

if $cleanup_legacy; then
  stale_refs=$(rg -l --fixed-strings "$legacy_pnpm_bin" \
    /etc/systemd/system \
    "$agent_home/.config/tunnel-client" \
    /opt/playwright-mcp \
    /opt/agent-mcp 2>/dev/null || true)
  if [[ -n $stale_refs ]]; then
    echo "Refusing legacy cleanup while active deployment paths still reference $legacy_pnpm_bin:" >&2
    printf '%s\n' "$stale_refs" >&2
    exit 1
  fi

  rm -rf "$legacy_pnpm_bin" "$agent_home/.local/share/pnpm/global"
  echo "Removed legacy pnpm-managed executable/global Node environment."
else
  echo "Legacy pnpm-managed files are intentionally retained until live validation succeeds."
  echo "After validation, rerun with --cleanup-legacy."
fi

echo "mise toolchain provisioned for $agent_user."
echo "Herdr runtime service/drop-in installed; production MCP is configured for external Herdr bootstrap."
echo "Restart agent-tunnel.service separately to activate the migrated control-plane environment."
