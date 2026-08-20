#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/agent
export PATH=/home/agent/.local/share/pnpm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

NODE=/home/agent/.local/share/pnpm/bin/node
WORKDIR="$(mktemp -d /tmp/agent-mcp-playwright-smoke.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

cd /opt/playwright-mcp
BROWSER_EXECUTABLE="$($NODE --input-type=module -e "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())")"

"$NODE" /opt/playwright-mcp/node_modules/@playwright/mcp/cli.js \
  --headless \
  --executable-path "$BROWSER_EXECUTABLE" \
  --user-data-dir "$WORKDIR/profile" \
  --output-dir "$WORKDIR/output"
