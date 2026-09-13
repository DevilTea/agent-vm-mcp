import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateBridgeToolAdapters } from '../src/adapters/index.js';
import { McpBridgeManager } from '../src/mcp-bridge.js';
import { validateBridgeCallPolicies } from '../src/policies/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-bridge-lifecycle-'));
const fixture = path.resolve(import.meta.dirname, 'mcp-bridge-fixture.mjs');

class FakeHostServer {
  tools = new Map();

  registerTool(name, config, handler) {
    if (this.tools.has(name)) throw new Error(`duplicate host tool ${name}`);
    const record = { name, config, handler };
    this.tools.set(name, record);
    let removed = false;
    return {
      remove: () => {
        if (removed) return;
        removed = true;
        if (this.tools.get(name) === record) this.tools.delete(name);
      },
    };
  }
}

const bridgeValidator = (bridge) => {
  validateBridgeToolAdapters(bridge);
  validateBridgeCallPolicies(bridge);
};

async function managerFor(config, { reserved = new Set(['native']), bridgeValidator: validator = bridgeValidator } = {}) {
  const configPath = path.join(root, `bridges-${Math.random().toString(16).slice(2)}.json`);
  await fs.writeFile(configPath, `${JSON.stringify({ version: 1, bridges: config }, null, 2)}\n`);
  const server = new FakeHostServer();
  const manager = new McpBridgeManager({
    server,
    reservedToolNames: reserved,
    configPath,
    bridgeValidator: validator,
  });
  return { manager, server, reserved };
}

const normalBridge = (id, extra = {}) => ({
  id,
  enabled: true,
  transport: { type: 'stdio', command: process.execPath, args: [fixture, 'normal'] },
  ...extra,
});

try {
  {
    const { manager, server } = await managerFor([
      {
        id: 'missing',
        enabled: true,
        transport: { type: 'stdio', command: path.join(root, 'missing-upstream'), args: [] },
      },
      {
        id: 'offline-http',
        enabled: true,
        transport: { type: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
      },
      {
        id: 'list-failure',
        enabled: true,
        transport: { type: 'stdio', command: process.execPath, args: [fixture, 'list-failure'] },
      },
      normalBridge('healthy'),
    ]);
    await manager.initialize();
    const status = manager.status().bridges;
    for (const id of ['missing', 'offline-http', 'list-failure']) {
      const bridge = status.find((entry) => entry.id === id);
      assert.equal(bridge?.state, 'unavailable', `${id} should be fail-soft unavailable`);
      assert.ok(bridge?.error?.message, `${id} should expose an error`);
    }
    assert.equal(status.find((entry) => entry.id === 'healthy')?.state, 'connected');
    assert.deepEqual([...server.tools.keys()].sort(), ['healthy_one', 'healthy_two']);
    await manager.close();
    assert.equal(server.tools.size, 0, 'manager.close must unregister forwarded tools');
  }

  {
    const reserved = new Set(['native']);
    const { manager, server } = await managerFor([
      normalBridge('first', { toolPrefix: 'shared_' }),
      normalBridge('second', { toolPrefix: 'shared_' }),
    ], { reserved });
    await assert.rejects(manager.initialize(), /MCP tool name collision: shared_one/);
    assert.equal(server.tools.size, 0, 'fatal later bridge must remove earlier registered tools');
    assert.deepEqual([...reserved], ['native'], 'fatal cleanup must restore reserved names');
  }

  {
    const { manager, server } = await managerFor([
      {
        ...normalBridge('invalid-adapter'),
        toolAdapters: { one: { type: 'not-supported' } },
      },
    ]);
    await assert.rejects(manager.initialize(), /Unsupported tool adapter type/);
    assert.equal(server.tools.size, 0, 'invalid extension config must fail before registration');
  }

  {
    const { manager } = await managerFor([
      {
        ...normalBridge('invalid-shape'),
        includeTools: 'one',
      },
    ]);
    await assert.rejects(manager.initialize(), /includeTools must be an array/);
  }

  {
    const duplicate = normalBridge('duplicate');
    const { manager } = await managerFor([duplicate, { ...duplicate }]);
    await assert.rejects(manager.initialize(), /Duplicate MCP bridge id/);
  }

  console.log('PASS MCP bridge fail-soft/fail-hard lifecycle');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
