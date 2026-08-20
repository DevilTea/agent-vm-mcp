#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/agent
export PATH=/home/agent/.local/share/pnpm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

NODE=/home/agent/.local/share/pnpm/bin/node
WORKDIR="$(mktemp -d /tmp/agent-mcp-playwright-smoke.XXXXXX)"
OUTPUT_DIR="${PLAYWRIGHT_MCP_OUTPUT_DIR:-$WORKDIR/output}"
WORKING_DIR="${PLAYWRIGHT_MCP_WORKING_DIR:-$WORKDIR/work}"
rm -rf "$OUTPUT_DIR" "$WORKING_DIR"
mkdir -p "$OUTPUT_DIR" "$WORKING_DIR"
trap 'rm -rf "$WORKDIR" "$OUTPUT_DIR" "$WORKING_DIR"' EXIT

cd /opt/playwright-mcp
BROWSER_EXECUTABLE="$($NODE --input-type=module -e "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())")"
cd "$WORKING_DIR"

"$NODE" /opt/playwright-mcp/node_modules/@playwright/mcp/cli.js \
  --headless \
  --executable-path "$BROWSER_EXECUTABLE" \
  --user-data-dir "$WORKDIR/profile" \
  --output-dir "$OUTPUT_DIR"
