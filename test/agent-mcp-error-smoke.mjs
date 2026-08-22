import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-mcp-error-smoke-'));
const bin = path.join(root, 'bin');
const statePath = path.join(root, 'snapshot-count');
const herdrPath = path.join(bin, 'herdr');
const codexPath = path.join(bin, 'codex');
const bridgeConfigPath = path.join(root, 'bridges.json');

await fs.mkdir(bin, { recursive: true });
await fs.writeFile(statePath, '0\n', 'utf8');
await fs.writeFile(bridgeConfigPath, `${JSON.stringify({ version: 1, bridges: [] })}\n`, 'utf8');
await fs.writeFile(codexPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
await fs.writeFile(
  herdrPath,
  `#!/usr/bin/env bash
set -euo pipefail
state=${JSON.stringify(statePath)}
if [[ \"\${1:-}\" == \"--version\" ]]; then
  echo 'herdr fake-0.8.2'
  exit 0
fi
if [[ \"\${1:-}\" != \"--session\" || -z \"\${2:-}\" ]]; then
  printf '%s\\n' '{\"error\":{\"code\":\"bad_args\",\"message\":\"missing session\"}}' >&2
  exit 1
fi
shift 2
if [[ \"\${1:-}\" == \"api\" && \"\${2:-}\" == \"snapshot\" ]]; then
  count=$(cat \"$state\")
  count=$((count + 1))
  printf '%s\\n' \"$count\" > \"$state\"
  if [[ \"$count\" -eq 1 ]]; then
    printf '%s\\n' '{\"id\":\"fake\",\"result\":{\"type\":\"session_snapshot\",\"snapshot\":{\"agents\":[],\"workspaces\":[],\"tabs\":[],\"panes\":[],\"layouts\":[]}}}'
    exit 0
  fi
  printf '%s\\n' '{\"error\":{\"code\":\"cleanup_snapshot_failed\",\"message\":\"cleanup snapshot unavailable\"},\"id\":\"fake\"}' >&2
  exit 1
fi
if [[ \"\${1:-}\" == \"workspace\" && \"\${2:-}\" == \"create\" ]]; then
  printf '%s\\n' '{\"error\":{\"code\":\"create_boom\",\"message\":\"workspace create exploded\"},\"id\":\"fake\"}' >&2
  exit 1
fi
printf '%s\\n' '{\"error\":{\"code\":\"unsupported\",\"message\":\"unexpected fake Herdr command\"},\"id\":\"fake\"}' >&2
exit 1
`,
  { mode: 0o755 },
);

const client = new Client({ name: 'agent-mcp-error-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, 'src/index.js')],
  cwd: projectRoot,
  env: {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    MCP_BRIDGES_CONFIG: bridgeConfigPath,
    AGENT_MCP_CAPABILITIES_CONFIG: path.join(projectRoot, 'config/capabilities.json'),
    AGENT_HERDR_BIN: herdrPath,
    AGENT_HERDR_SESSION: 'mcp-error-smoke',
    AGENT_HERDR_BOOTSTRAP: 'external',
  },
  stderr: 'inherit',
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'agent_start',
    arguments: { harness: 'codex', cwd: root, timeoutMs: 5_000 },
  });
  if (!result.isError) throw new Error('agent_start cleanup failure unexpectedly succeeded');
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!text.includes('create_boom: workspace create exploded')) {
    throw new Error(`MCP error lost original Agent Runtime failure: ${text}`);
  }
  for (const expected of [
    'cleanup also failed (cleanup_snapshot_failed: cleanup snapshot unavailable',
    'stage=workspace_discovery',
    'retrySafe=true',
  ]) {
    if (!text.includes(expected)) throw new Error(`MCP error lost cleanup failure detail ${expected}: ${text}`);
  }
  console.log('PASS agent MCP cleanup error propagation');
} finally {
  await client.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
