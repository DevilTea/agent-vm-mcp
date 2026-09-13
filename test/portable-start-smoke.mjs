import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const projectRoot = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-portable-start-'));
const home = path.join(root, 'home');
const xdgConfig = path.join(root, 'config');
const xdgState = path.join(root, 'state');
const workspaceRoot = path.join(root, 'workspaces');
const repositoryRoot = path.join(root, 'repositories');
await Promise.all([
  fs.mkdir(home, { recursive: true }),
  fs.mkdir(xdgConfig, { recursive: true }),
  fs.mkdir(xdgState, { recursive: true }),
]);

const env = { ...process.env };
for (const name of [
  'MCP_BRIDGES_CONFIG',
  'AGENT_MCP_CAPABILITIES_CONFIG',
  'AGENT_MCP_SYSTEM_AUDIT_CONFIG',
]) delete env[name];
Object.assign(env, {
  HOME: home,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_STATE_HOME: xdgState,
  AGENT_WORKSPACE_ROOT: workspaceRoot,
  AGENT_REPOSITORY_ROOT: repositoryRoot,
  AGENT_HERDR_BIN: path.join(root, 'missing-herdr'),
  AGENT_HERDR_BOOTSTRAP: 'external',
});

const client = new Client({ name: 'portable-start-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, 'src/index.js')],
  cwd: projectRoot,
  env,
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const names = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    names.push(...page.tools.map((tool) => tool.name));
    cursor = page.nextCursor;
  } while (cursor);

  for (const native of ['exec', 'read_file', 'agent_start', 'present_file', 'mcp_bridge_status']) {
    assert.ok(names.includes(native), `missing native tool: ${native}`);
  }
  assert.equal(names.some((name) => name.startsWith('browser_')), false, 'portable defaults unexpectedly expose Playwright');
  assert.equal(names.some((name) => name.startsWith('lsp_')), false, 'portable defaults unexpectedly expose LSP');

  const status = await client.callTool({ name: 'mcp_bridge_status', arguments: {} });
  const text = status.content?.find((item) => item.type === 'text')?.text ?? '';
  assert.deepEqual(JSON.parse(text).bridges, []);

  console.log(`PASS portable default startup tools=${names.length}`);
} finally {
  await client.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
