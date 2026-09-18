import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { resolveHostProfile } from '../src/host-profile.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-host-profile-'));
const bridgesPath = path.join(root, 'bridges.json');
await fs.writeFile(bridgesPath, '{"version":1,"bridges":[]}\n');

async function profileFor(hostKind) {
  const client = new Client({ name: `host-profile-${hostKind ?? 'generic'}`, version: '1.0.0' });
  const env = {
    ...process.env,
    HOME: root,
    MCP_BRIDGES_CONFIG: bridgesPath,
  };
  if (hostKind === null) delete env.AGENT_MCP_HOST;
  else env.AGENT_MCP_HOST = hostKind;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'src/index.js')],
    cwd: projectRoot,
    env,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return { tools, capabilities: client.getServerCapabilities?.() };
  } finally {
    await client.close().catch(() => {});
  }
}

try {
  assert.throws(
    () => resolveHostProfile({ AGENT_MCP_HOST: 'unknown-host' }),
    /AGENT_MCP_HOST must be one of/,
  );

  const generic = await profileFor(null);
  const genericImport = generic.tools.find((tool) => tool.name === 'import_file');
  assert.ok(genericImport, 'generic import_file tool missing');
  assert.equal(genericImport._meta?.['openai/fileParams'], undefined, 'generic host leaked OpenAI file metadata');
  assert.ok(generic.tools.some((tool) => tool.name === 'skill_list'), 'generic host lost skill_list');
  assert.ok(generic.tools.some((tool) => tool.name === 'skill_read'), 'generic host lost skill_read');
  assert.deepEqual(generic.capabilities?.extensions?.['io.modelcontextprotocol/skills'], { directoryRead: true });

  const chatgpt = await profileFor('chatgpt');
  const chatgptImport = chatgpt.tools.find((tool) => tool.name === 'import_file');
  assert.ok(chatgptImport, 'ChatGPT import_file tool missing');
  assert.deepEqual(chatgptImport._meta?.['openai/fileParams'], ['file']);
  assert.equal(chatgpt.tools.some((tool) => tool.name === 'skill_list'), false, 'ChatGPT host exposed skill_list');
  assert.equal(chatgpt.tools.some((tool) => tool.name === 'skill_read'), false, 'ChatGPT host exposed skill_read');
  assert.equal(chatgpt.capabilities?.extensions?.['io.modelcontextprotocol/skills'], undefined, 'ChatGPT host exposed SEP skills');

  console.log('PASS host-specific file-input and skill-surface policy');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
