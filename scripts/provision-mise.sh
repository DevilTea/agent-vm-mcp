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
agent_config_root="$agent_home/.config"
mise_config_dir="$agent_config_root/mise"
mise_config="$mise_config_dir/config.toml"
mise_data_dir="$agent_home/.local/share/mise"
mise_shims="$mise_data_dir/shims"
node_version=24.20.0
pnpm_version=11.25.0
herdr_version=0.8.2
herdr_session=agent-vm-mcp
node_bin="$mise_data_dir/installs/node/$node_version/bin/node"
node_bin_dir="$(dirname "$node_bin")"
node_corepack_bin="$node_bin_dir/corepack"
pnpm_bin="$mise_data_dir/installs/pnpm/$pnpm_version/pnpm"
herdr_bin="$mise_data_dir/installs/herdr/$herdr_version/herdr"
herdr_service_template="$repo_root/config/systemd/agent-herdr.service.template"
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
fi

# Ubuntu 26.04 can opt into architecture variants such as amd64v3. Third-party
# repositories may not publish variant indexes, so pin the mise PPA to the
# baseline dpkg architecture without disabling variants for Ubuntu's own repos.
baseline_arch=$(dpkg --print-architecture)
python3 - "$baseline_arch" <<'PY_ARCH'
from pathlib import Path
import re
import sys

arch = sys.argv[1]
root = Path('/etc/apt/sources.list.d')
uri = 'ppa.launchpadcontent.net/jdxcode/mise/ubuntu'

for path in root.glob('*.sources'):
    text = path.read_text()
    if uri not in text:
        continue
    stanzas = re.split(r'(\n\s*\n)', text)
    changed = False
    for index in range(0, len(stanzas), 2):
        stanza = stanzas[index]
        if uri not in stanza:
            continue
        if re.search(r'^Architectures:', stanza, flags=re.MULTILINE):
            stanza = re.sub(
                r'^Architectures:.*$',
                f'Architectures: {arch}',
                stanza,
                flags=re.MULTILINE,
            )
        else:
            lines = stanza.splitlines()
            insert_at = next(
                (i + 1 for i, line in enumerate(lines) if line.startswith('Components:')),
                len(lines),
            )
            lines.insert(insert_at, f'Architectures: {arch}')
            stanza = '\n'.join(lines)
        stanzas[index] = stanza
        changed = True
    if changed:
        path.write_text(''.join(stanzas))

for path in root.glob('*.list'):
    lines = path.read_text().splitlines()
    changed = False
    for index, line in enumerate(lines):
        if uri not in line or not line.lstrip().startswith('deb '):
            continue
        option_match = re.match(r'^(\s*deb\s+)\[([^]]*)\](.*)$', line)
        if option_match:
            options = option_match.group(2).split()
            replaced = False
            for option_index, option in enumerate(options):
                if option.startswith('arch='):
                    options[option_index] = f'arch={arch}'
                    replaced = True
            if not replaced:
                options.append(f'arch={arch}')
            line = f"{option_match.group(1)}[{' '.join(options)}]{option_match.group(3)}"
        else:
            line = re.sub(r'^(\s*deb)\s+', rf'\1 [arch={arch}] ', line, count=1)
        lines[index] = line
        changed = True
    if changed:
        path.write_text('\n'.join(lines) + '\n')
PY_ARCH

apt-get update
apt-get install -y --no-install-recommends mise

# The dedicated agent must own its XDG config root so tools such as Herdr and
# browser runtimes can create their own sibling configuration directories.
install -d -m 0755 -o "$agent_user" -g "$agent_group" "$agent_config_root"
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

# A legacy `corepack enable` can leave pnpm/pnpx shims inside the pinned Node
# installation. Those binaries precede the standalone mise-managed pnpm in
# mise's tool PATH and silently route `pnpm` through Corepack. Disable only
# pnpm's Corepack shims before rebuilding mise shims so the dedicated pnpm
# tool remains the resolved provider.
if [[ -x $node_corepack_bin ]]; then
  run_as_agent env \
    PATH="$node_bin_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$node_corepack_bin" disable pnpm --install-directory "$node_bin_dir"
fi
run_as_agent /usr/bin/mise reshim

if [[ ! -x $node_bin ]]; then
  echo "Pinned mise-managed Node executable is missing: $node_bin" >&2
  exit 1
fi
if [[ ! -x $pnpm_bin ]]; then
  echo "Pinned mise-managed pnpm executable is missing: $pnpm_bin" >&2
  exit 1
fi
if [[ ! -x $herdr_bin ]]; then
  echo "Pinned mise-managed Herdr executable is missing: $herdr_bin" >&2
  exit 1
fi
if [[ ! -r $herdr_service_template ]]; then
  echo "Missing repo-managed Herdr systemd template." >&2
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

tool_path="$mise_shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
run_as_agent env PATH="$tool_path" node --version
resolved_pnpm_path=$(run_as_agent /usr/bin/mise which pnpm)
resolved_pnpm_version=$(run_as_agent env PATH="$tool_path" pnpm --version)
if [[ $resolved_pnpm_path != "$pnpm_bin" || $resolved_pnpm_version != "$pnpm_version" ]]; then
  echo "Pinned pnpm resolution mismatch: expected $pnpm_bin ($pnpm_version), got $resolved_pnpm_path ($resolved_pnpm_version)" >&2
  exit 1
fi
printf 'pnpm %s (%s)\n' "$resolved_pnpm_version" "$resolved_pnpm_path"
run_as_agent env PATH="$tool_path" herdr --version

if $cleanup_legacy; then
  stale_refs=$(rg -l --fixed-strings "$legacy_pnpm_bin" \
    /etc/systemd/system \
    /opt/playwright-mcp \
    /opt/agent-vm-mcp 2>/dev/null || true)
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
echo "Herdr runtime service installed and enabled; start/restart it separately when using external bootstrap."
