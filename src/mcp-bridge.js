import fs from 'node:fs/promises';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/client/stdio';
import { fromJsonSchema } from '@modelcontextprotocol/server';

const DEFAULT_CONFIG_PATH = '/opt/agent-mcp/config/bridges.json';
const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function patternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAny(name, patterns) {
  return patterns.some((pattern) => patternToRegExp(pattern).test(name));
}

function shouldExposeTool(toolName, bridge) {
  const include = bridge.includeTools ?? ['*'];
  const exclude = bridge.excludeTools ?? [];
  return matchesAny(toolName, include) && !matchesAny(toolName, exclude);
}

function exportedToolName(toolName, bridge) {
  const renamed = bridge.renameTools?.[toolName];
  if (renamed !== undefined) {
    return assertString(renamed, `bridge ${bridge.id} renameTools.${toolName}`);
  }

  const prefix = bridge.toolPrefix ?? `${bridge.id}_`;
  return `${prefix}${toolName}`;
}

function resolvedChildEnvironment(transport) {
  const env = getDefaultEnvironment();

  for (const name of transport.inheritEnv ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  for (const [name, value] of Object.entries(transport.env ?? {})) {
    env[name] = String(value);
  }

  for (const [targetName, sourceName] of Object.entries(transport.envFrom ?? {})) {
    const value = process.env[sourceName];
    if (value === undefined) {
      throw new Error(
        `Missing environment variable ${sourceName} required for child env ${targetName}.`,
      );
    }
    env[targetName] = value;
  }

  return env;
}

function resolvedHttpHeaders(transport) {
  const headers = { ...(transport.headers ?? {}) };
  for (const [headerName, envName] of Object.entries(transport.headersFromEnv ?? {})) {
    const value = process.env[envName];
    if (value === undefined) {
      throw new Error(
        `Missing environment variable ${envName} required for HTTP header ${headerName}.`,
      );
    }
    headers[headerName] = value;
  }
  return headers;
}

function createTransport(bridge) {
  const transport = bridge.transport;
  if (!transport || typeof transport !== 'object') {
    throw new Error(`Bridge ${bridge.id} is missing transport configuration.`);
  }

  if (transport.type === 'stdio') {
    return new StdioClientTransport({
      command: assertString(transport.command, `bridge ${bridge.id} transport.command`),
      args: transport.args ?? [],
      cwd: transport.cwd,
      env: resolvedChildEnvironment(transport),
      stderr: 'inherit',
      maxBufferSize: transport.maxBufferSize,
    });
  }

  if (transport.type === 'streamable-http') {
    const headers = resolvedHttpHeaders(transport);
    const bearerTokenEnv = transport.bearerTokenEnv;
    const authProvider = bearerTokenEnv
      ? {
          token: async () => {
            const token = process.env[bearerTokenEnv];
            if (!token) {
              throw new Error(
                `Missing bearer token environment variable ${bearerTokenEnv} for bridge ${bridge.id}.`,
              );
            }
            return token;
          },
        }
      : undefined;

    return new StreamableHTTPClientTransport(
      new URL(assertString(transport.url, `bridge ${bridge.id} transport.url`)),
      {
        ...(Object.keys(headers).length > 0
          ? { requestInit: { headers } }
          : {}),
        ...(authProvider ? { authProvider } : {}),
      },
    );
  }

  throw new Error(
    `Unsupported transport type ${JSON.stringify(transport.type)} for bridge ${bridge.id}.`,
  );
}

async function listAllTools(client) {
  const tools = [];
  let cursor;

  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
}

async function loadBridgeConfig(configPath) {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (raw.version !== 1 || !Array.isArray(raw.bridges)) {
    throw new Error(`Unsupported MCP bridge config in ${configPath}. Expected version 1.`);
  }

  const ids = new Set();
  for (const bridge of raw.bridges) {
    const id = assertString(bridge.id, 'bridge.id');
    if (ids.has(id)) throw new Error(`Duplicate MCP bridge id: ${id}`);
    ids.add(id);
  }

  return raw.bridges;
}

export class McpBridgeManager {
  #server;
  #reservedToolNames;
  #configPath;
  #adapterFactory;
  #connections = [];
  #status = [];

  constructor({ server, reservedToolNames, configPath, adapterFactory }) {
    this.#server = server;
    this.#reservedToolNames = reservedToolNames;
    this.#configPath = configPath ?? process.env.MCP_BRIDGES_CONFIG ?? DEFAULT_CONFIG_PATH;
    this.#adapterFactory = adapterFactory;
  }

  async initialize() {
    const bridges = await loadBridgeConfig(this.#configPath);

    for (const bridge of bridges) {
      if (bridge.enabled === false) {
        this.#status.push({ id: bridge.id, enabled: false, state: 'disabled', tools: [] });
        continue;
      }

      await this.#connectBridge(bridge);
    }
  }

  async #connectBridge(bridge) {
    const transport = createTransport(bridge);
    const client = new Client({
      name: `agent-mcp-bridge-${bridge.id}`,
      version: '1.0.0',
    });

    try {
      await client.connect(transport);
      const allTools = await listAllTools(client);
      const exposedTools = allTools.filter((tool) => shouldExposeTool(tool.name, bridge));
      const mappings = [];

      for (const tool of exposedTools) {
        const exportedName = exportedToolName(tool.name, bridge);
        if (this.#reservedToolNames.has(exportedName)) {
          throw new Error(
            `MCP tool name collision: ${exportedName} from bridge ${bridge.id}. ` +
              'Set toolPrefix or renameTools in the bridge config.',
          );
        }
        this.#reservedToolNames.add(exportedName);

        const baseConfig = {
          ...(tool.title !== undefined ? { title: tool.title } : {}),
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: fromJsonSchema(tool.inputSchema ?? EMPTY_OBJECT_SCHEMA),
          ...(tool.outputSchema !== undefined
            ? { outputSchema: fromJsonSchema(tool.outputSchema) }
            : {}),
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
          ...(tool.icons !== undefined ? { icons: tool.icons } : {}),
          ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
        };
        const adapter = this.#adapterFactory?.({ bridge, tool, exportedName }) ?? null;
        const config = adapter?.configureTool
          ? adapter.configureTool(baseConfig)
          : baseConfig;

        this.#server.registerTool(exportedName, config, async (args, ctx) => {
          let adapterState;
          if (adapter?.beforeCall) {
            try {
              adapterState = await adapter.beforeCall({ args: args ?? {}, ctx });
            } catch (error) {
              console.error(
                `[mcp-bridge] ${bridge.id}.${tool.name}: adapter beforeCall failed: ${error.message}`,
              );
            }
          }

          const result = await client.callTool(
            {
              name: tool.name,
              arguments: args ?? {},
            },
            {
              signal: ctx.mcpReq.signal,
              toolDefinition: tool,
            },
          );

          if (!adapter?.afterCall) return result;
          try {
            return await adapter.afterCall({
              args: args ?? {},
              ctx,
              result,
              state: adapterState,
            });
          } catch (error) {
            console.error(
              `[mcp-bridge] ${bridge.id}.${tool.name}: adapter afterCall failed: ${error.message}`,
            );
            return result;
          }
        });

        mappings.push({ upstream: tool.name, exported: exportedName });
      }

      this.#connections.push({ id: bridge.id, client, transport });
      this.#status.push({
        id: bridge.id,
        enabled: true,
        state: 'connected',
        transport: bridge.transport.type,
        server: client.getServerVersion() ?? null,
        tools: mappings,
      });

      console.error(
        `[mcp-bridge] ${bridge.id}: connected, forwarding ${mappings.length}/${allTools.length} tools`,
      );
    } catch (error) {
      await client.close().catch(() => {});
      throw new Error(`Failed to initialize MCP bridge ${bridge.id}: ${error.message}`, {
        cause: error,
      });
    }
  }

  status() {
    return {
      configPath: this.#configPath,
      bridges: this.#status,
    };
  }

  async close() {
    const connections = this.#connections.splice(0);
    await Promise.allSettled(connections.map(({ client }) => client.close()));
  }
}
