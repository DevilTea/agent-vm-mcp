import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
  SKILL_LIST_TOOL,
  SKILL_READ_TOOL,
  createSkillProjectionAdapter,
  registerSkillProjectionTools,
  resolveSkillProjectionRoot,
} from '../src/skill-projection.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-skill-projection-'));
const projectionRoot = path.join(root, 'projection');
const skillsRoot = path.join(projectionRoot, 'skills');
const alphaRoot = path.join(skillsRoot, 'alpha');
const outsideRoot = path.join(root, 'outside');
async function treeHash(rootPath) {
  const digest = createHash('sha256');
  async function walk(directory, relativeRoot) {
    const names = (await fs.readdir(directory)).sort();
    const directories = [];
    const files = [];
    for (const name of names) {
      const fullPath = path.join(directory, name);
      const stat = await fs.lstat(fullPath);
      if (stat.isDirectory() || stat.isSymbolicLink()) directories.push([name, fullPath, stat]);
      else files.push([name, fullPath, stat]);
    }
    for (const [name, fullPath, stat] of directories) {
      const relative = path.posix.join(relativeRoot, name);
      digest.update(`D\0${relative}\0`);
      if (stat.isSymbolicLink()) digest.update(`L\0${await fs.readlink(fullPath)}\0`);
      else await walk(fullPath, relative);
    }
    for (const [name, fullPath, stat] of files) {
      const relative = path.posix.join(relativeRoot, name);
      if (stat.isSymbolicLink()) digest.update(`L\0${relative}\0${await fs.readlink(fullPath)}\0`);
      else {
        digest.update(`F\0${relative}\0`);
        digest.update(await fs.readFile(fullPath));
        digest.update('\0');
      }
    }
  }
  await walk(rootPath, '');
  return `sha256:${digest.digest('hex')}`;
}

async function alphaEntry() {
  return {
    name: 'alpha',
    description: 'Alpha reusable guidance',
    entrypoint: 'SKILL.md',
    hash: await treeHash(alphaRoot),
  };
}

async function writeAlphaCatalog() {
  await writeCatalog([await alphaEntry()]);
}

async function writeCatalog(entries) {
  await fs.writeFile(
    path.join(projectionRoot, 'catalog.json'),
    `${JSON.stringify({ version: 1, source: 'dot-agents', skills: entries }, null, 2)}\n`,
    'utf8',
  );
}

function parseToolResult(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'tool result did not contain text JSON');
  return JSON.parse(text);
}

const alphaContent = '# Alpha\nUse the alpha playbook.\n';
const guideContent = 'Read this reference when the alpha playbook points here.\n';
const scriptContent = '#!/bin/sh\nprintf text-only\n';

try {
  const defaultRoot = resolveSkillProjectionRoot({
    HOME: path.join(root, 'home'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
  });
  assert.equal(defaultRoot.source, 'default');
  assert.equal(defaultRoot.root, path.join(root, 'xdg-data', 'dot-agents', 'skill-projection', 'v1'));

  await fs.mkdir(path.join(alphaRoot, 'references'), { recursive: true });
  await fs.mkdir(path.join(alphaRoot, 'scripts'), { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.writeFile(path.join(alphaRoot, 'SKILL.md'), alphaContent, 'utf8');
  await fs.writeFile(path.join(alphaRoot, 'references', 'guide.md'), guideContent, 'utf8');
  await fs.writeFile(path.join(alphaRoot, 'scripts', 'plan.sh'), scriptContent, 'utf8');
  await fs.writeFile(path.join(outsideRoot, 'outside.md'), 'outside\n', 'utf8');
  await writeAlphaCatalog();

  const env = {
    HOME: path.join(root, 'home'),
    AGENT_MCP_SKILL_PROJECTION_ROOT: projectionRoot,
  };
  const adapter = createSkillProjectionAdapter({ env });

  const listed = await adapter.list();
  assert.equal(listed.available, true);
  assert.equal(listed.source, 'dot-agents');
  assert.equal(listed.rootSource, 'override');
  assert.deepEqual(listed.entries, [await alphaEntry()]);
  assert.equal(JSON.stringify(listed).includes(projectionRoot), false, 'skill_list leaked a filesystem path');

  const query = await adapter.list({ query: 'REUSABLE' });
  assert.deepEqual(query.entries.map((entry) => entry.name), ['alpha']);
  assert.equal(query.query, 'REUSABLE');
  assert.deepEqual((await adapter.list({ query: 'not-present' })).entries, []);

  const readEntrypoint = await adapter.read({ name: 'alpha' });
  assert.equal(readEntrypoint.available, true);
  assert.equal(readEntrypoint.name, 'alpha');
  assert.equal(readEntrypoint.path, 'SKILL.md');
  assert.equal(readEntrypoint.hash, (await alphaEntry()).hash);
  assert.equal(readEntrypoint.content, alphaContent);

  const readReference = await adapter.read({ name: 'alpha', path: 'references/guide.md' });
  assert.equal(readReference.path, 'references/guide.md');
  assert.equal(readReference.content, guideContent);
  const readScriptAsText = await adapter.read({ name: 'alpha', path: 'scripts/plan.sh' });
  assert.equal(readScriptAsText.content, scriptContent);

  await fs.appendFile(path.join(alphaRoot, 'references', 'guide.md'), 'tampered\n', 'utf8');
  const hashMismatch = await adapter.list();
  assert.equal(hashMismatch.available, false);
  assert.equal(hashMismatch.reason, 'hash_mismatch');
  await fs.writeFile(path.join(alphaRoot, 'references', 'guide.md'), guideContent, 'utf8');
  await writeAlphaCatalog();

  await assert.rejects(
    adapter.read({ name: 'alpha', path: '../outside/outside.md' }),
    (error) => error.code === 'unsafe_path',
  );
  await fs.symlink(path.join(outsideRoot, 'outside.md'), path.join(alphaRoot, 'references', 'escape.md'));
  await writeAlphaCatalog();
  await assert.rejects(
    adapter.read({ name: 'alpha', path: 'references/escape.md' }),
    (error) => error.code === 'symlink',
  );
  await fs.unlink(path.join(alphaRoot, 'references', 'escape.md'));
  await writeAlphaCatalog();

  await fs.writeFile(path.join(alphaRoot, 'references', 'large.txt'), 'x'.repeat(33), 'utf8');
  await writeAlphaCatalog();
  await assert.rejects(
    createSkillProjectionAdapter({ env, maxReadBytes: 32 }).read({ name: 'alpha', path: 'references/large.txt' }),
    (error) => error.code === 'too_large',
  );
  await fs.rm(path.join(alphaRoot, 'references', 'large.txt'));
  await fs.writeFile(path.join(alphaRoot, 'references', 'invalid.bin'), Buffer.from([0xff, 0xfe]));
  await writeAlphaCatalog();
  await assert.rejects(
    adapter.read({ name: 'alpha', path: 'references/invalid.bin' }),
    (error) => error.code === 'invalid_utf8',
  );
  await fs.rm(path.join(alphaRoot, 'references', 'invalid.bin'));
  await fs.writeFile(path.join(alphaRoot, 'references', 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]));
  await writeAlphaCatalog();
  await assert.rejects(
    adapter.read({ name: 'alpha', path: 'references/binary.bin' }),
    (error) => error.code === 'binary',
  );

  const missing = createSkillProjectionAdapter({
    env: { HOME: path.join(root, 'missing-home'), AGENT_MCP_SKILL_PROJECTION_ROOT: path.join(root, 'missing') },
  });
  const missingList = await missing.list();
  assert.equal(missingList.available, false);
  assert.equal(missingList.source, 'dot-agents');
  assert.equal(missingList.rootSource, 'override');
  assert.equal(missingList.reason, 'missing');
  assert.match(missingList.message, /unavailable/i);
  const missingRead = await missing.read({ name: 'alpha' });
  assert.equal(missingRead.available, false);
  assert.equal(missingRead.content, null);

  await fs.rm(path.join(alphaRoot, 'references', 'binary.bin'));
  await writeAlphaCatalog();

  await fs.writeFile(path.join(projectionRoot, 'catalog.json'), '{"version":2,"source":"dot-agents","skills":[]}\n', 'utf8');
  const invalidList = await adapter.list();
  assert.equal(invalidList.available, false);
  assert.equal(invalidList.reason, 'invalid_catalog');
  assert.match(invalidList.message, /version/i);
  await fs.writeFile(path.join(projectionRoot, 'catalog.json'), '{"version":1,"source":"other","skills":[]}\n', 'utf8');
  const invalidSource = await adapter.list();
  assert.equal(invalidSource.available, false);
  assert.equal(invalidSource.reason, 'invalid_catalog');
  assert.match(invalidSource.message, /source/i);
  await writeCatalog([{ ...(await alphaEntry()), name: 'Bad_Name' }]);
  const invalidName = await adapter.list();
  assert.equal(invalidName.available, false);
  assert.equal(invalidName.reason, 'invalid_catalog');
  assert.match(invalidName.message, /invalid name/i);
  await writeAlphaCatalog();

  const registrations = [];
  registerSkillProjectionTools({
    registerTool(name, config, handler) {
      registrations.push({ name, config, handler });
    },
  }, adapter);
  assert.deepEqual(registrations.map(({ name }) => name), [SKILL_LIST_TOOL, SKILL_READ_TOOL]);
  for (const registration of registrations) {
    assert.equal(registration.config.annotations.readOnlyHint, true);
    assert.match(registration.config.description, /skill_list|skill_read|instructions\/data/);
  }

  const bridgeConfigPath = path.join(root, 'bridges.json');
  await fs.writeFile(bridgeConfigPath, '{"version":1,"bridges":[]}\n', 'utf8');
  const client = new Client({ name: 'skill-projection-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'src/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      MCP_BRIDGES_CONFIG: bridgeConfigPath,
      AGENT_HERDR_BIN: path.join(root, 'missing-herdr'),
      AGENT_HERDR_BOOTSTRAP: 'external',
    },
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
    const toolNames = tools.map((tool) => tool.name);
    assert.ok(toolNames.includes(SKILL_LIST_TOOL), 'skill_list missing from native tool catalog');
    assert.ok(toolNames.includes(SKILL_READ_TOOL), 'skill_read missing from native tool catalog');
    assert.match(tools.find((tool) => tool.name === SKILL_LIST_TOOL).description, /dot-agents/);
    assert.deepEqual(parseToolResult(await client.callTool({ name: SKILL_LIST_TOOL, arguments: {} })).entries.map((entry) => entry.name), ['alpha']);
    assert.equal(parseToolResult(await client.callTool({ name: SKILL_READ_TOOL, arguments: { name: 'alpha' } })).content, alphaContent);

    const capabilities = parseToolResult(await client.callTool({ name: 'capabilities', arguments: {} }));
    assert.ok(capabilities.mcp.nativeTools.includes(SKILL_LIST_TOOL));
    assert.ok(capabilities.mcp.nativeTools.includes(SKILL_READ_TOOL));
  } finally {
    await client.close().catch(() => {});
  }

  console.log('PASS dot-agents skill projection list/read/security/catalog registration');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
