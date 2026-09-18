import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod/v4';

import {
  createSepSkillsAdapter,
  SEP_MAX_SKILL_RESOURCES,
  SEP_MAX_SKILL_TOTAL_BYTES,
} from '../src/sep-skills.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-sep-skills-'));
const projectionRoot = path.join(root, 'projection');
const skillsRoot = path.join(projectionRoot, 'skills');
const alphaRoot = path.join(skillsRoot, 'alpha');
const bridgeConfigPath = path.join(root, 'bridges.json');
const artifactPath = path.join(root, 'artifact.txt');

async function treeHash(rootPath) {
  const digest = createHash('sha256');
  async function walk(directory, relativeRoot) {
    const names = (await fs.readdir(directory)).sort();
    const directories = [];
    const files = [];
    for (const name of names) {
      const fullPath = path.join(directory, name);
      const stat = await fs.lstat(fullPath);
      if (stat.isDirectory()) directories.push([name, fullPath]);
      else if (stat.isFile()) files.push([name, fullPath]);
      else throw new Error(`fixture contains unsupported entry: ${fullPath}`);
    }
    for (const [name, fullPath] of directories) {
      const relative = path.posix.join(relativeRoot, name);
      digest.update(`D\0${relative}\0`);
      await walk(fullPath, relative);
    }
    for (const [name, fullPath] of files) {
      const relative = path.posix.join(relativeRoot, name);
      digest.update(`F\0${relative}\0`);
      digest.update(await fs.readFile(fullPath));
      digest.update('\0');
    }
  }
  await walk(rootPath, '');
  return `sha256:${digest.digest('hex')}`;
}

async function writeCatalog(entries) {
  const catalogEntries = entries ?? [{
    name: 'alpha',
    description: 'Alpha reusable guidance',
    entrypoint: 'SKILL.md',
    hash: await treeHash(alphaRoot),
  }];
  await fs.writeFile(
    path.join(projectionRoot, 'catalog.json'),
    `${JSON.stringify({ version: 1, source: 'dot-agents', skills: catalogEntries }, null, 2)}\n`,
    'utf8',
  );
}

async function writeCatalogAt(projectionPath, entries) {
  await fs.mkdir(projectionPath, { recursive: true });
  await fs.writeFile(
    path.join(projectionPath, 'catalog.json'),
    `${JSON.stringify({ version: 1, source: 'dot-agents', skills: entries }, null, 2)}\n`,
    'utf8',
  );
}

const alphaSkill = `---
name: alpha
description: Alpha reusable guidance
license: Apache-2.0
metadata:
  tags: one,two
  version: "2"
hidden: true
---
# Alpha

Use the alpha playbook.
`;
const guide = 'Read this reference when the alpha playbook points here.\n';
const binary = Buffer.from([0xff, 0xfe, 0x42]);

const skillEntrySchema = z.object({
  uri: z.string(),
  frontmatter: z.record(z.string(), z.any()),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
});
const skillsListResultSchema = z.object({
  skills: z.array(skillEntrySchema),
  ttlMs: z.number().int().nonnegative(),
  cacheScope: z.literal('private'),
  nextCursor: z.string().optional(),
});
const skillGetResultSchema = z.object({ skill: skillEntrySchema });
const readResultSchema = z.object({ contents: z.array(z.any()) });
const directoryResultSchema = z.object({
  resources: z.array(z.any()),
  nextCursor: z.string().optional(),
});

function parseToolResult(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

async function assertInvalidParams(request) {
  await assert.rejects(request, (error) => error?.code === -32602);
}

try {
  await fs.mkdir(path.join(alphaRoot, 'references'), { recursive: true });
  await fs.mkdir(path.join(alphaRoot, 'assets'), { recursive: true });
  await fs.mkdir(projectionRoot, { recursive: true });
  await fs.writeFile(path.join(alphaRoot, 'SKILL.md'), alphaSkill, 'utf8');
  await fs.writeFile(path.join(alphaRoot, 'references', 'guide.md'), guide, 'utf8');
  await fs.writeFile(path.join(alphaRoot, 'assets', 'icon.bin'), binary);
  await fs.writeFile(artifactPath, 'artifact resource\n', 'utf8');
  await writeCatalog();

  const env = { HOME: path.join(root, 'home'), AGENT_MCP_SKILL_PROJECTION_ROOT: projectionRoot };
  const adapter = createSepSkillsAdapter({ env });
  const directList = await adapter.listSkills();
  assert.equal(directList.resultType, 'complete');
  assert.equal(directList.ttlMs, 0);
  assert.equal(directList.cacheScope, 'private');
  assert.deepEqual(directList.skills[0].frontmatter, {
    name: 'alpha',
    description: 'Alpha reusable guidance',
    license: 'Apache-2.0',
    metadata: { tags: 'one,two', version: '2' },
    hidden: true,
  });
  assert.equal(directList.skills[0].resources.length, 3);
  assert.equal(new Set(directList.skills[0].resources.map((resource) => resource.uri)).size, 3);
  assert.equal(directList.skills[0].resources.reduce((total, resource) => total + resource.size, 0), Buffer.byteLength(alphaSkill) + Buffer.byteLength(guide) + binary.length);
  assert.equal((await adapter.getSkill({ uri: 'skill://alpha/SKILL.md' })).resultType, 'complete');
  assert.equal((await adapter.readDirectory({ uri: 'skill://alpha' })).resultType, 'complete');
  const directBinary = await adapter.readResource({ uri: 'skill://alpha/assets/icon.bin' });
  assert.equal(directBinary.contents[0].blob, binary.toString('base64'));
  assert.equal(directBinary.contents[0].text, undefined);

  await fs.appendFile(path.join(alphaRoot, 'references', 'guide.md'), 'tampered\n', 'utf8');
  await assert.rejects(adapter.listSkills(), (error) => error?.code === 'hash_mismatch');
  await fs.writeFile(path.join(alphaRoot, 'references', 'guide.md'), guide, 'utf8');
  await writeCatalog();

  const invalidFrontmatterCases = [
    ['name mismatch', alphaSkill.replace('name: alpha', 'name: wrong')],
    ['description too long', alphaSkill.replace('description: Alpha reusable guidance', `description: ${'d'.repeat(1025)}`)],
    ['compatibility empty', alphaSkill.replace('license: Apache-2.0', 'compatibility: ""\nlicense: Apache-2.0')],
    ['compatibility too long', alphaSkill.replace('license: Apache-2.0', `compatibility: ${'c'.repeat(501)}\nlicense: Apache-2.0`)],
    ['compatibility non-string', alphaSkill.replace('license: Apache-2.0', 'compatibility: 42\nlicense: Apache-2.0')],
    ['metadata non-string', alphaSkill.replace('tags: one,two', 'tags: [one, two]')],
    ['allowed-tools non-string', alphaSkill.replace('hidden: true', 'hidden: true\nallowed-tools:\n  - Read')],
    ['license non-string', alphaSkill.replace('license: Apache-2.0', 'license: 42')],
    ['empty body', alphaSkill.replace('# Alpha\n\nUse the alpha playbook.\n', ' \n\t\n')],
  ];
  for (const [label, content] of invalidFrontmatterCases) {
    await fs.writeFile(path.join(alphaRoot, 'SKILL.md'), content, 'utf8');
    await writeCatalog();
    await assert.rejects(adapter.listSkills(), (error) => error?.code === 'invalid_frontmatter', label);
  }
  await fs.writeFile(path.join(alphaRoot, 'SKILL.md'), alphaSkill, 'utf8');
  await writeCatalog();

  await writeCatalog([{ name: 'Bad_Name', description: 'Alpha reusable guidance', entrypoint: 'SKILL.md', hash: await treeHash(alphaRoot) }]);
  await assert.rejects(adapter.listSkills(), (error) => error?.code === 'invalid_catalog');
  await writeCatalog();

  await fs.writeFile(bridgeConfigPath, '{"version":1,"bridges":[]}\n', 'utf8');
const client = new Client(
    { name: 'sep-skills-smoke', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'src/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      AGENT_MCP_HOST: 'generic',
      MCP_BRIDGES_CONFIG: bridgeConfigPath,
    },
    stderr: 'pipe',
  });
  try {
    const initializeResult = await client.connect(transport);
    const capabilities = client.getServerCapabilities?.() ?? initializeResult?.capabilities;
    assert.deepEqual(capabilities?.resources && Object.prototype.hasOwnProperty.call(capabilities, 'resources'), true);
    assert.deepEqual(capabilities?.extensions?.['io.modelcontextprotocol/skills'], { directoryRead: true });

    const presented = await client.callTool({ name: 'present_file', arguments: { path: artifactPath } });
    const artifactLink = presented.content?.find((item) => item.type === 'resource_link');
    assert.equal(typeof artifactLink?.uri, 'string');
    const artifactRead = await client.request({ method: 'resources/read', params: { uri: artifactLink.uri } }, readResultSchema);
    assert.equal(artifactRead.contents[0].text, 'artifact resource\n');

    const list = await client.request({ method: 'skills/list', params: {} }, skillsListResultSchema);
    assert.equal(list.skills.length, 1);
    const skill = list.skills[0];
    assert.equal(skill.uri, 'skill://alpha/SKILL.md');
    assert.equal(skill.frontmatter.metadata.version, '2');
    assert.equal(skill.frontmatter.hidden, true);
    assert.equal(skill.resources.every((resource) => resource.digest.startsWith('sha256:')), true);

    const got = await client.request({ method: 'skills/get', params: { uri: skill.uri } }, skillGetResultSchema);
    assert.deepEqual(got.skill, skill);

    const textRead = await client.request({ method: 'resources/read', params: { uri: 'skill://alpha/SKILL.md' } }, readResultSchema);
    assert.equal(textRead.contents[0].mimeType, 'text/markdown');
    assert.equal(textRead.contents[0].text, alphaSkill);

    const binaryRead = await client.request({ method: 'resources/read', params: { uri: 'skill://alpha/assets/icon.bin' } }, readResultSchema);
    assert.equal(binaryRead.contents[0].mimeType, 'application/octet-stream');
    assert.equal(binaryRead.contents[0].blob, binary.toString('base64'));

    const rootDirectory = await client.request({ method: 'resources/directory/read', params: { uri: 'skill://alpha' } }, directoryResultSchema);
    assert.equal(rootDirectory.resources.find((resource) => resource.uri === 'skill://alpha/assets').mimeType, 'inode/directory');
    assert.ok(rootDirectory.resources.find((resource) => resource.uri === 'skill://alpha/SKILL.md'));
    const referencesDirectory = await client.request({ method: 'resources/directory/read', params: { uri: 'skill://alpha/references' } }, directoryResultSchema);
    assert.deepEqual(referencesDirectory.resources.map((resource) => resource.uri), ['skill://alpha/references/guide.md']);

    await assertInvalidParams(client.request({ method: 'skills/get', params: { uri: 'skill://missing/SKILL.md' } }, skillGetResultSchema));
    await assertInvalidParams(client.request({ method: 'resources/read', params: { uri: 'skill://alpha' } }, readResultSchema));
    await assertInvalidParams(client.request({ method: 'resources/read', params: { uri: 'skill://missing/file.txt' } }, readResultSchema));
    await assertInvalidParams(client.request({ method: 'resources/directory/read', params: { uri: 'skill://alpha/SKILL.md' } }, directoryResultSchema));

    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    assert.ok(tools.some((tool) => tool.name === 'skill_list'));
    assert.ok(tools.some((tool) => tool.name === 'skill_read'));
    const compatibilityList = parseToolResult(await client.callTool({ name: 'skill_list', arguments: {} }));
    assert.deepEqual(compatibilityList.entries.map((entry) => entry.name), ['alpha']);
    const compatibilityRead = parseToolResult(await client.callTool({ name: 'skill_read', arguments: { name: 'alpha' } }));
    assert.equal(compatibilityRead.content, alphaSkill);
    assert.equal(JSON.stringify(compatibilityList).includes(projectionRoot), false);
    assert.equal(JSON.stringify(compatibilityRead).includes(projectionRoot), false);
    assert.equal(JSON.stringify(list).includes(projectionRoot), false);
  } finally {
    await client.close().catch(() => {});
  }

  const boundaryProjectionRoot = path.join(root, 'boundary-projection');
  const boundarySkillRoot = path.join(boundaryProjectionRoot, 'skills', 'boundary');
  await fs.mkdir(boundarySkillRoot, { recursive: true });
  await fs.writeFile(path.join(boundarySkillRoot, 'SKILL.md'), '---\nname: boundary\ndescription: Boundary fixture\n---\n# Boundary\n', 'utf8');
  for (let index = 0; index < SEP_MAX_SKILL_RESOURCES - 1; index += 1) {
    await fs.writeFile(path.join(boundarySkillRoot, `${String(index).padStart(3, '0')}.txt`), 'x', 'utf8');
  }
  await writeCatalogAt(boundaryProjectionRoot, [{
    name: 'boundary',
    description: 'Boundary fixture',
    entrypoint: 'SKILL.md',
    hash: await treeHash(boundarySkillRoot),
  }]);
  const boundaryAdapter = createSepSkillsAdapter({ env: { AGENT_MCP_SKILL_PROJECTION_ROOT: boundaryProjectionRoot } });
  assert.equal((await boundaryAdapter.listSkills()).skills[0].resources.length, SEP_MAX_SKILL_RESOURCES);
  await fs.writeFile(path.join(boundarySkillRoot, `${String(SEP_MAX_SKILL_RESOURCES - 1).padStart(3, '0')}.txt`), 'x', 'utf8');
  await writeCatalogAt(boundaryProjectionRoot, [{
    name: 'boundary',
    description: 'Boundary fixture',
    entrypoint: 'SKILL.md',
    hash: await treeHash(boundarySkillRoot),
  }]);
  await assert.rejects(boundaryAdapter.listSkills(), (error) => error?.code === 'limit_exceeded');

  const totalProjectionRoot = path.join(root, 'total-projection');
  const totalSkillRoot = path.join(totalProjectionRoot, 'skills', 'total');
  await fs.mkdir(totalSkillRoot, { recursive: true });
  const totalFrontmatter = '---\nname: total\ndescription: Total fixture\n---\n# Total\n';
  await fs.writeFile(
    path.join(totalSkillRoot, 'SKILL.md'),
    Buffer.concat([Buffer.from(totalFrontmatter), Buffer.alloc(SEP_MAX_SKILL_TOTAL_BYTES - Buffer.byteLength(totalFrontmatter), 0x78)]),
  );
  await writeCatalogAt(totalProjectionRoot, [{
    name: 'total',
    description: 'Total fixture',
    entrypoint: 'SKILL.md',
    hash: await treeHash(totalSkillRoot),
  }]);
  const totalAdapter = createSepSkillsAdapter({ env: { AGENT_MCP_SKILL_PROJECTION_ROOT: totalProjectionRoot } });
  assert.equal((await totalAdapter.listSkills()).skills[0].resources[0].size, SEP_MAX_SKILL_TOTAL_BYTES);
  await fs.appendFile(path.join(totalSkillRoot, 'SKILL.md'), 'x', 'utf8');
  await writeCatalogAt(totalProjectionRoot, [{
    name: 'total',
    description: 'Total fixture',
    entrypoint: 'SKILL.md',
    hash: await treeHash(totalSkillRoot),
  }]);
  await assert.rejects(totalAdapter.listSkills(), (error) => error?.code === 'limit_exceeded');

  const unavailableAdapter = createSepSkillsAdapter({ env: { AGENT_MCP_SKILL_PROJECTION_ROOT: path.join(root, 'missing-projection') } });
  const unavailableList = await unavailableAdapter.listCompatibility();
  assert.equal(unavailableList.available, false);
  assert.equal(JSON.stringify(unavailableList).includes('missing-projection'), false);
  const unavailableRead = await unavailableAdapter.readCompatibility({ name: 'missing' });
  assert.equal(unavailableRead.available, false);
  assert.equal(JSON.stringify(unavailableRead).includes('missing-projection'), false);

  console.log('PASS SEP-2640 skills/list/get resources/read directory/read limits frontmatter compatibility');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
