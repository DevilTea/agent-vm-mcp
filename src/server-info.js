import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as z from 'zod/v4';

export const SERVER_INFO_TOOL = 'server_info';
export const SERVER_INFO_SCHEMA_VERSION = 1;
const GIT_TIMEOUT_MS = 2_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function schemaJson(schema, mode) {
  if (schema === undefined) {
    return mode === 'input' ? { type: 'object', properties: {} } : undefined;
  }
  const standardJsonSchema = schema?.['~standard']?.jsonSchema?.[mode];
  if (typeof standardJsonSchema === 'function') {
    return standardJsonSchema();
  }
  if (schema && typeof schema === 'object') return canonicalize(schema);
  try {
    return z.toJSONSchema(schema);
  } catch {
    return canonicalize(schema);
  }
}

function catalogTool(name, config = {}) {
  return canonicalize({
    name,
    title: config.title,
    description: config.description,
    inputSchema: schemaJson(config.inputSchema, 'input'),
    outputSchema: schemaJson(config.outputSchema, 'output'),
    annotations: config.annotations,
    icons: config.icons,
    execution: config.execution,
    _meta: config._meta,
  });
}

export function catalogIdentityFromTools(tools, { exclude = [SERVER_INFO_TOOL] } = {}) {
  const excluded = new Set(exclude);
  const projected = tools
    .filter((tool) => !excluded.has(tool.name))
    .map((tool) => catalogTool(tool.name, tool))
    .sort((left, right) => compareStrings(left.name, right.name));
  const hash = createHash('sha256').update(stableJson(projected)).digest('hex');
  return {
    algorithm: 'sha256',
    hash,
    marker: `sha256:${hash}`,
    hashedToolCount: projected.length,
    excludedTools: [...excluded].sort(compareStrings),
  };
}

export class ToolCatalogTracker {
  #tools = new Map();

  instrument(server) {
    const registerTool = server.registerTool.bind(server);
    server.registerTool = (name, config, handler) => {
      const registered = registerTool(name, config, handler);
      const entry = { name, registered };
      this.#tools.set(name, entry);

      const remove = registered.remove.bind(registered);
      registered.remove = (...args) => {
        const result = remove(...args);
        this.#tools.delete(entry.name);
        return result;
      };

      const update = registered.update.bind(registered);
      registered.update = (updates) => {
        const previousName = entry.name;
        const result = update(updates);
        if (updates?.name !== undefined && updates.name !== previousName) {
          this.#tools.delete(previousName);
          if (updates.name) {
            entry.name = updates.name;
            this.#tools.set(entry.name, entry);
          }
        }
        return result;
      };

      return registered;
    };
    return server;
  }

  #enabledTools() {
    return [...this.#tools.values()]
      .filter(({ registered }) => registered.enabled !== false)
      .map(({ name, registered }) => catalogTool(name, registered));
  }

  identity() {
    return catalogIdentityFromTools(this.#enabledTools());
  }

  toolNames() {
    return this.#enabledTools().map((tool) => tool.name).sort(compareStrings);
  }

  totalToolCount() {
    return this.#enabledTools().length;
  }
}

function capture(command, args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const append = (current, chunk) => {
      if (current.length >= MAX_GIT_OUTPUT_BYTES) return current;
      return Buffer.concat([current, chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - current.length)]);
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    const finish = ({ code = null, timedOut = false, spawnError = null } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: spawnError === null && !timedOut && code === 0,
        code,
        timedOut,
        stdout: stdout.toString('utf8').trim(),
        stderr: stderr.toString('utf8').trim(),
      });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true });
    }, timeoutMs);
    timer.unref();

    child.once('error', (error) => finish({ spawnError: error }));
    child.once('close', (code) => finish({ code }));
  });
}

export async function captureServerRuntimeIdentity({
  name = 'agent-vm-control',
  version,
  projectRoot = PROJECT_ROOT,
  hostKind,
  startedAt = new Date(),
} = {}) {
  const packagePath = path.join(projectRoot, 'package.json');
  let packageVersion = version ?? null;
  try {
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    packageVersion = packageJson.version ?? packageVersion;
  } catch {
    // Version supplied by the server remains authoritative when package metadata is unavailable.
  }

  let revision = process.env.AGENT_MCP_REVISION?.trim() || null;
  let dirty = null;
  let gitAvailable = false;
  if (!revision) {
    const head = await capture('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    if (head.ok && /^[0-9a-f]{40}$/i.test(head.stdout)) {
      revision = head.stdout;
      gitAvailable = true;
    }
  } else {
    gitAvailable = true;
  }

  const status = await capture('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: projectRoot });
  if (status.ok) {
    gitAvailable = true;
    dirty = status.stdout.length > 0;
  }

  return {
    schemaVersion: SERVER_INFO_SCHEMA_VERSION,
    name,
    version: packageVersion,
    revision,
    dirty,
    gitAvailable,
    hostKind: hostKind ?? 'generic',
    pid: process.pid,
    startedAt: startedAt.toISOString(),
  };
}

export function serverInfoToolDescription(marker) {
  return (
    'Report the running MCP server/deployment identity and current tool-catalog identity. ' +
    `Catalog snapshot marker: ${marker}. ` +
    'Compare this marker from the tool definition with catalog.marker returned by the call. ' +
    'If they differ, the host is using a stale/frozen tool snapshot. Treat that mismatch as a terminal boundary: do not call or rediscover any other tools from this server in the current workflow; return control to the user and refresh the app actions before further MCP work.'
  );
}

export function buildServerInfo({ runtime, catalogTracker }) {
  const catalog = catalogTracker.identity();
  return {
    server: runtime,
    catalog: {
      schemaVersion: SERVER_INFO_SCHEMA_VERSION,
      ...catalog,
      totalToolCount: catalogTracker.totalToolCount(),
      toolNames: catalogTracker.toolNames(),
      freshnessRule: 'tool-definition marker must equal catalog.marker; mismatch means the host tool snapshot is stale',
    },
  };
}
