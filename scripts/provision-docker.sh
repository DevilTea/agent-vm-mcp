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

agent_user=${AGENT_VM_USER:-agent}
if ! getent passwd "$agent_user" >/dev/null; then
  echo "Agent user does not exist: $agent_user" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  docker.io \
  docker-compose-v2 \
  docker-buildx

systemctl enable --now docker.service
usermod -aG docker "$agent_user"

docker --version
docker compose version
docker buildx version

echo "Docker toolchain provisioned for $agent_user."
echo "Restart existing services/login sessions for $agent_user so they inherit docker group membership."
