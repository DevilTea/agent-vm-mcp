import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import * as z from 'zod/v4';

import {
  SERVER_INFO_TOOL,
  ToolCatalogTracker,
  buildServerInfo,
  captureServerRuntimeIdentity,
  catalogIdentityFromTools,
  serverInfoToolDescription,
} from '../src/server-info.js';

const execFileAsync = promisify(execFile);

function fakeServer() {
  return {
    tools: new Map(),
    registerTool(name, config, handler) {
      const tool = {
        name,
        ...config,
        handler,
        enabled: true,
        disable() { this.enabled = false; },
        enable() { this.enabled = true; },
        remove: () => { this.tools.delete(tool.name); },
        update: (updates) => {
          if (updates.name !== undefined && updates.name !== tool.name) {
            this.tools.delete(tool.name);
            tool.name = updates.name;
            if (tool.name) this.tools.set(tool.name, tool);
          }
          if (updates.title !== undefined) tool.title = updates.title;
          if (updates.description !== undefined) tool.description = updates.description;
          if (updates.paramsSchema !== undefined) tool.inputSchema = updates.paramsSchema;
          if (updates.outputSchema !== undefined) tool.outputSchema = updates.outputSchema;
          if (updates.annotations !== undefined) tool.annotations = updates.annotations;
          if (updates.icons !== undefined) tool.icons = updates.icons;
          if (updates._meta !== undefined) tool._meta = updates._meta;
          if (updates.enabled !== undefined) tool.enabled = updates.enabled;
        },
      };
      this.tools.set(name, tool);
      return tool;
    },
  };
}

function makeTracked(registrations) {
  const server = fakeServer();
  const tracker = new ToolCatalogTracker();
  tracker.instrument(server);
  for (const [name, config] of registrations) {
    server.registerTool(name, config, async () => ({ content: [] }));
  }
  return { server, tracker };
}

const configA = {
  description: 'first',
  inputSchema: z.object({ value: z.string(), count: z.number().int().optional() }),
  annotations: { readOnlyHint: true },
};
const configB = {
  description: 'second',
  inputSchema: z.object({ flag: z.boolean().default(false) }),
};

const forward = makeTracked([
  ['alpha', configA],
  ['beta', configB],
]);
const reverse = makeTracked([
  ['beta', configB],
  ['alpha', configA],
]);
assert.deepEqual(forward.tracker.identity(), reverse.tracker.identity(), 'catalog hash must ignore registration order');

const unicodeForward = makeTracked([
  ['ä-tool', configA],
  ['Z-tool', configB],
  ['_tool', configB],
]);
const unicodeReverse = makeTracked([
  ['_tool', configB],
  ['Z-tool', configB],
  ['ä-tool', configA],
]);
assert.equal(
  unicodeForward.tracker.identity().hash,
  unicodeReverse.tracker.identity().hash,
  'catalog hash must use a locale-independent ordering for non-ASCII names',
);

const changedDescription = makeTracked([
  ['alpha', { ...configA, description: 'changed' }],
  ['beta', configB],
]);
assert.notEqual(
  changedDescription.tracker.identity().hash,
  forward.tracker.identity().hash,
  'description changes must change catalog hash',
);

const changedSchema = makeTracked([
  ['alpha', { ...configA, inputSchema: z.object({ value: z.number() }) }],
  ['beta', configB],
]);
assert.notEqual(
  changedSchema.tracker.identity().hash,
  forward.tracker.identity().hash,
  'input schema changes must change catalog hash',
);

const handlerOnly = fakeServer();
const handlerTracker = new ToolCatalogTracker();
handlerTracker.instrument(handlerOnly);
handlerOnly.registerTool('alpha', configA, async () => ({ content: [{ type: 'text', text: 'different implementation' }] }));
handlerOnly.registerTool('beta', configB, async () => ({ content: [] }));
assert.equal(
  handlerTracker.identity().hash,
  forward.tracker.identity().hash,
  'handler-only implementation changes must not require a host catalog refresh',
);

const lifecycle = makeTracked([
  ['keep', configA],
  ['remove-me', configB],
  ['toggle-me', configB],
]);
const initialLifecycleHash = lifecycle.tracker.identity().hash;
lifecycle.server.tools.get('remove-me').remove();
assert.equal(lifecycle.tracker.totalToolCount(), 2, 'removed tools must leave the tracked catalog');
assert.notEqual(lifecycle.tracker.identity().hash, initialLifecycleHash, 'removing a tool must change the catalog hash');
lifecycle.server.tools.get('toggle-me').disable();
assert.deepEqual(lifecycle.tracker.toolNames(), ['keep'], 'disabled tools must not appear in the active catalog');
lifecycle.server.tools.get('toggle-me').enable();
assert.deepEqual(lifecycle.tracker.toolNames(), ['keep', 'toggle-me'], 're-enabled tools must return to the catalog');
const beforeUpdate = lifecycle.tracker.identity().hash;
lifecycle.server.tools.get('toggle-me').update({ description: 'updated description' });
assert.notEqual(lifecycle.tracker.identity().hash, beforeUpdate, 'tool updates must change the catalog hash');

const baseMarker = forward.tracker.identity().marker;
forward.server.registerTool(
  SERVER_INFO_TOOL,
  { description: serverInfoToolDescription(baseMarker), inputSchema: z.object({}) },
  async () => ({ content: [] }),
);
assert.equal(forward.tracker.identity().marker, baseMarker, 'server_info must be excluded from its own catalog hash');
assert.equal(forward.tracker.totalToolCount(), 3);
assert.deepEqual(forward.tracker.toolNames(), ['alpha', 'beta', SERVER_INFO_TOOL]);

const runtime = {
  schemaVersion: 1,
  name: 'agent-vm-control',
  version: '0.5.0',
  revision: '0'.repeat(40),
  dirty: false,
  gitAvailable: true,
  hostKind: 'chatgpt',
  pid: 123,
  startedAt: '2026-09-14T00:00:00.000Z',
};
const info = buildServerInfo({ runtime, catalogTracker: forward.tracker });
assert.equal(info.catalog.marker, baseMarker);
assert.equal(info.catalog.totalToolCount, 3);
assert.match(serverInfoToolDescription(baseMarker), new RegExp(baseMarker.replace(':', '\\:')));
assert.match(serverInfoToolDescription(baseMarker), /terminal boundary/);
assert.match(serverInfoToolDescription(baseMarker), /do not call or rediscover any other tools/);

const listToolsProjection = [...forward.server.tools.values()].map(({ handler: _handler, ...tool }) => tool);
assert.equal(
  catalogIdentityFromTools(listToolsProjection).hash,
  forward.tracker.identity().hash,
  'tracker hash must match the same public catalog projection',
);

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-server-info-'));
try {
  await fs.writeFile(path.join(runtimeRoot, 'package.json'), '{"name":"fixture","version":"9.8.7"}\n');
  await fs.writeFile(path.join(runtimeRoot, 'tracked.txt'), 'one\n');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: runtimeRoot });
  await execFileAsync('git', ['config', 'user.name', 'Server Info Smoke'], { cwd: runtimeRoot });
  await execFileAsync('git', ['config', 'user.email', 'server-info-smoke@example.invalid'], { cwd: runtimeRoot });
  await execFileAsync('git', ['add', 'package.json', 'tracked.txt'], { cwd: runtimeRoot });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: runtimeRoot });

  const firstRuntime = await captureServerRuntimeIdentity({
    name: 'fixture-server',
    version: 'fallback-version',
    projectRoot: runtimeRoot,
    hostKind: 'chatgpt',
    startedAt: new Date('2026-09-14T00:00:00.000Z'),
  });
  const firstRevisionSnapshot = firstRuntime.revision;
  assert.equal(firstRuntime.version, '9.8.7');
  assert.match(firstRuntime.revision, /^[0-9a-f]{40}$/i);
  assert.equal(firstRuntime.dirty, false);
  assert.equal(firstRuntime.hostKind, 'chatgpt');
  assert.equal(firstRuntime.startedAt, '2026-09-14T00:00:00.000Z');

  const untrackedPath = path.join(runtimeRoot, 'untracked.txt');
  await fs.writeFile(untrackedPath, 'untracked\n');
  const untrackedRuntime = await captureServerRuntimeIdentity({
    name: 'fixture-server',
    version: 'fallback-version',
    projectRoot: runtimeRoot,
  });
  assert.equal(untrackedRuntime.revision, firstRevisionSnapshot);
  assert.equal(untrackedRuntime.dirty, true, 'untracked files must make the runtime tree dirty');
  await fs.rm(untrackedPath);

  await fs.writeFile(path.join(runtimeRoot, 'tracked.txt'), 'dirty\n');
  const dirtyRuntime = await captureServerRuntimeIdentity({
    name: 'fixture-server',
    version: 'fallback-version',
    projectRoot: runtimeRoot,
  });
  assert.equal(dirtyRuntime.revision, firstRevisionSnapshot);
  assert.equal(dirtyRuntime.dirty, true);

  await execFileAsync('git', ['commit', '-am', 'second'], { cwd: runtimeRoot });
  const secondRuntime = await captureServerRuntimeIdentity({
    name: 'fixture-server',
    version: 'fallback-version',
    projectRoot: runtimeRoot,
  });
  assert.notEqual(secondRuntime.revision, firstRevisionSnapshot);
  assert.equal(secondRuntime.dirty, false);
  assert.equal(
    firstRuntime.revision,
    firstRevisionSnapshot,
    'previously captured runtime identity must not change when the checkout advances',
  );
} finally {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
}

const nonGitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-server-info-nongit-'));
const previousRevisionOverride = process.env.AGENT_MCP_REVISION;
try {
  delete process.env.AGENT_MCP_REVISION;
  await fs.writeFile(path.join(nonGitRoot, 'package.json'), '{"name":"fixture","version":"1.2.3"}\n');
  const nonGitRuntime = await captureServerRuntimeIdentity({
    name: 'fixture-server',
    version: 'fallback-version',
    projectRoot: nonGitRoot,
  });
  assert.equal(nonGitRuntime.version, '1.2.3');
  assert.equal(nonGitRuntime.revision, null);
  assert.equal(nonGitRuntime.dirty, null);
  assert.equal(nonGitRuntime.gitAvailable, false);
} finally {
  if (previousRevisionOverride === undefined) delete process.env.AGENT_MCP_REVISION;
  else process.env.AGENT_MCP_REVISION = previousRevisionOverride;
  await fs.rm(nonGitRoot, { recursive: true, force: true });
}

console.log('PASS server info catalog identity');
