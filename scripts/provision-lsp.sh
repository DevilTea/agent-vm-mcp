#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root, for example: sudo $0" >&2
  exit 1
fi

if [[ ! -x /usr/bin/mise ]]; then
  echo "mise is required; run scripts/provision-mise.sh first." >&2
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
config_template="$repo_root/config/lsp-mcp.json.template"

node_version=24.20.0
lsp_mcp_version=0.3.1
typescript_language_server_version=5.3.0
typescript_version=6.0.3

node_spec="node@$node_version"
lsp_mcp_spec="npm:language-server-mcp@$lsp_mcp_version"
typescript_language_server_spec="npm:typescript-language-server@$typescript_language_server_version"
typescript_spec="npm:typescript@$typescript_version"

run_as_agent() {
  sudo -u "$agent_user" env \
    HOME="$agent_home" \
    USER="$agent_user" \
    LOGNAME="$agent_user" \
    XDG_CONFIG_HOME="$agent_home/.config" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
}

for spec in "$node_spec" "$lsp_mcp_spec" "$typescript_language_server_spec" "$typescript_spec"; do
  run_as_agent env MISE_NPM_PACKAGE_MANAGER=pnpm /usr/bin/mise install "$spec"
done

resolve_command() {
  local spec=$1
  local command=$2
  run_as_agent /usr/bin/mise exec "$spec" -- sh -c 'command -v "$1"' sh "$command"
}

node_root=$(run_as_agent /usr/bin/mise where "$node_spec")
node_bin="$node_root/bin/node"
lsp_mcp_bin=$(resolve_command "$lsp_mcp_spec" language-server-mcp)
typescript_language_server_bin=$(resolve_command "$typescript_language_server_spec" typescript-language-server)
typescript_root=$(run_as_agent /usr/bin/mise where "$typescript_spec")
tsserver=$(find -L "$typescript_root" -type f -path '*/typescript/lib/tsserver.js' -print -quit)

for executable in "$node_bin" "$lsp_mcp_bin" "$typescript_language_server_bin"; do
  if [[ ! -x $executable ]]; then
    echo "Expected executable is missing: $executable" >&2
    exit 1
  fi
done
if [[ -z $tsserver || ! -f $tsserver ]]; then
  echo "Pinned TypeScript tsserver.js was not found under $typescript_root" >&2
  exit 1
fi
if [[ ! -r $config_template ]]; then
  echo "Missing LSP MCP config template: $config_template" >&2
  exit 1
fi

lsp_config_dir="$agent_home/.config/lsp-mcp"
lsp_config="$lsp_config_dir/config.json"
install -d -m 0755 -o "$agent_user" -g "$agent_group" "$lsp_config_dir"
python3 - "$config_template" "$lsp_config" "$typescript_language_server_bin" "$tsserver" <<'PY'
import json
import pathlib
import sys

template_path, output_path, typescript_server, tsserver = sys.argv[1:]
data = json.loads(pathlib.Path(template_path).read_text())

def replace(value):
    if value == "__TYPESCRIPT_LANGUAGE_SERVER__":
        return typescript_server
    if value == "__TSSERVER__":
        return tsserver
    if isinstance(value, dict):
        return {key: replace(item) for key, item in value.items()}
    if isinstance(value, list):
        return [replace(item) for item in value]
    return value

pathlib.Path(output_path).write_text(json.dumps(replace(data), indent=2) + "\n")
PY
chown "$agent_user:$agent_group" "$lsp_config"
chmod 0644 "$lsp_config"

install_root=/opt/language-server-mcp
install -d -m 0755 -o root -g root "$install_root"
cat > "$install_root/start.sh" <<EOF_START
#!/usr/bin/env bash
set -euo pipefail

export HOME="$agent_home"
export XDG_CONFIG_HOME="$agent_home/.config"
export PATH="$(dirname "$node_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

exec "$lsp_mcp_bin"
EOF_START
chown root:root "$install_root/start.sh"
chmod 0755 "$install_root/start.sh"

python3 -m json.tool "$lsp_config" >/dev/null
"$node_bin" --version
printf 'language-server-mcp=%s\n' "$lsp_mcp_version"
printf 'typescript-language-server=%s\n' "$typescript_language_server_version"
printf 'typescript=%s\n' "$typescript_version"
printf 'launcher=%s\n' "$install_root/start.sh"
printf 'config=%s\n' "$lsp_config"
