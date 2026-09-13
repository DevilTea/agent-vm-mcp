import fs from 'node:fs/promises';

export class BridgeConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'BridgeConfigError';
  }
}

function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new BridgeConfigError(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeConfigError(`${label} must be an object.`);
  }
  return value;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value)) throw new BridgeConfigError(`${label} must be an array.`);
  for (const [index, item] of value.entries()) assertString(item, `${label}[${index}]`);
  return value;
}

function assertStringMap(value, label) {
  assertPlainObject(value, label);
  for (const [key, item] of Object.entries(value)) {
    if (!key) throw new BridgeConfigError(`${label} must not contain an empty key.`);
    assertString(item, `${label}.${key}`);
  }
  return value;
}

function validateBridgeDefinition(bridge, index) {
  assertPlainObject(bridge, `bridges[${index}]`);
  const id = assertString(bridge.id, `bridges[${index}].id`);

  if (bridge.enabled !== undefined && typeof bridge.enabled !== 'boolean') {
    throw new BridgeConfigError(`bridge ${id} enabled must be a boolean.`);
  }
  if (bridge.toolPrefix !== undefined) assertString(bridge.toolPrefix, `bridge ${id} toolPrefix`, { allowEmpty: true });
  if (bridge.includeTools !== undefined) assertStringArray(bridge.includeTools, `bridge ${id} includeTools`);
  if (bridge.excludeTools !== undefined) assertStringArray(bridge.excludeTools, `bridge ${id} excludeTools`);
  if (bridge.renameTools !== undefined) assertStringMap(bridge.renameTools, `bridge ${id} renameTools`);
  if (bridge.toolAdapters !== undefined) assertPlainObject(bridge.toolAdapters, `bridge ${id} toolAdapters`);
  if (bridge.callPolicies !== undefined && !Array.isArray(bridge.callPolicies)) {
    throw new BridgeConfigError(`bridge ${id} callPolicies must be an array.`);
  }

  const transport = assertPlainObject(bridge.transport, `bridge ${id} transport`);
  if (transport.type === 'stdio') {
    assertString(transport.command, `bridge ${id} transport.command`);
    if (transport.args !== undefined) assertStringArray(transport.args, `bridge ${id} transport.args`);
    if (transport.cwd !== undefined) assertString(transport.cwd, `bridge ${id} transport.cwd`);
    if (transport.inheritEnv !== undefined) assertStringArray(transport.inheritEnv, `bridge ${id} transport.inheritEnv`);
    if (transport.env !== undefined) assertStringMap(transport.env, `bridge ${id} transport.env`);
    if (transport.envFrom !== undefined) assertStringMap(transport.envFrom, `bridge ${id} transport.envFrom`);
    if (
      transport.maxBufferSize !== undefined &&
      (!Number.isSafeInteger(transport.maxBufferSize) || transport.maxBufferSize <= 0)
    ) {
      throw new BridgeConfigError(`bridge ${id} transport.maxBufferSize must be a positive safe integer.`);
    }
  } else if (transport.type === 'streamable-http') {
    const rawUrl = assertString(transport.url, `bridge ${id} transport.url`);
    try {
      new URL(rawUrl);
    } catch (error) {
      throw new BridgeConfigError(`Invalid URL for bridge ${id}: ${error.message}`, { cause: error });
    }
    if (transport.headers !== undefined) assertStringMap(transport.headers, `bridge ${id} transport.headers`);
    if (transport.headersFromEnv !== undefined) {
      assertStringMap(transport.headersFromEnv, `bridge ${id} transport.headersFromEnv`);
    }
    if (transport.bearerTokenEnv !== undefined) {
      assertString(transport.bearerTokenEnv, `bridge ${id} transport.bearerTokenEnv`);
    }
  } else {
    throw new BridgeConfigError(
      `Unsupported transport type ${JSON.stringify(transport.type)} for bridge ${id}.`,
    );
  }

  return bridge;
}

export async function loadBridgeConfig(configPath) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BridgeConfigError(`Invalid JSON in MCP bridge config ${configPath}: ${error.message}`, { cause: error });
    }
    throw error;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || !Array.isArray(raw.bridges)) {
    throw new BridgeConfigError(`Unsupported MCP bridge config in ${configPath}. Expected version 1.`);
  }

  const ids = new Set();
  for (const [index, candidate] of raw.bridges.entries()) {
    const bridge = validateBridgeDefinition(candidate, index);
    if (ids.has(bridge.id)) throw new BridgeConfigError(`Duplicate MCP bridge id: ${bridge.id}`);
    ids.add(bridge.id);
  }

  return raw.bridges;
}
