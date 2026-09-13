import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/client/stdio';
import { fromJsonSchema } from '@modelcontextprotocol/server';

import { resolveConfigPath } from './config-path.js';
import { BridgeConfigError, loadBridgeConfig } from './mcp-bridge-config.js';
const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function bridgeErrorDetails(error) {
  return {
    code: error?.code ?? error?.cause?.code ?? null,
    message: error?.message ?? String(error),
  };
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
    return renamed;
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
      throw new BridgeConfigError(
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
      throw new BridgeConfigError(
        `Missing environment variable ${envName} required for HTTP header ${headerName}.`,
      );
    }
    headers[headerName] = value;
  }
  return headers;
}

function createTransport(bridge) {
  const transport = bridge.transport;
  if (transport.type === 'stdio') {
    return new StdioClientTransport({
      command: transport.command,
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
      new URL(transport.url),
      {
        ...(Object.keys(headers).length > 0
          ? { requestInit: { headers } }
          : {}),
        ...(authProvider ? { authProvider } : {}),
      },
    );
  }

  throw new BridgeConfigError(
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


export class McpBridgeManager {
  #server;
  #reservedToolNames;
  #configPath;
  #adapterFactory;
  #policyFactory;
  #bridgeValidator;
  #connections = [];
  #status = [];

  constructor({ server, reservedToolNames, configPath, adapterFactory, policyFactory, bridgeValidator }) {
    this.#server = server;
    this.#reservedToolNames = reservedToolNames;
    this.#configPath = configPath ?? null;
    this.#adapterFactory = adapterFactory;
    this.#policyFactory = policyFactory;
    this.#bridgeValidator = bridgeValidator;
  }

  async initialize() {
    this.#configPath = await resolveConfigPath({
      filename: 'bridges.json',
      envName: 'MCP_BRIDGES_CONFIG',
      explicitPath: this.#configPath,
    });
    const bridges = await loadBridgeConfig(this.#configPath);
    for (const bridge of bridges) {
      try {
        this.#bridgeValidator?.(bridge);
      } catch (error) {
        throw new BridgeConfigError(`Invalid extension configuration for bridge ${bridge.id}: ${error.message}`, {
          cause: error,
        });
      }
    }

    try {
      for (const bridge of bridges) {
        if (bridge.enabled === false) {
          this.#status.push({ id: bridge.id, enabled: false, state: 'disabled', tools: [] });
          continue;
        }

        await this.#connectBridge(bridge);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  #stageTool(bridge, tool, stagedNames) {
    const exportedName = exportedToolName(tool.name, bridge);
    if (stagedNames.has(exportedName)) {
      throw new BridgeConfigError(
        `MCP tool name collision: ${exportedName} from bridge ${bridge.id}. ` +
          'Set toolPrefix or renameTools in the bridge config.',
      );
    }
    stagedNames.add(exportedName);

    let baseConfig;
    try {
      baseConfig = {
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
    } catch (error) {
      // The upstream connected but supplied a tool definition we cannot expose.
      // Treat this integration as unavailable rather than blaming local config.
      const unavailable = new Error(
        `Unsupported tool schema from bridge ${bridge.id}.${tool.name}: ${error.message}`,
        { cause: error },
      );
      unavailable.bridgeUnavailable = true;
      throw unavailable;
    }

    let adapter;
    let policies;
    let config;
    try {
      adapter = this.#adapterFactory?.({ bridge, tool, exportedName }) ?? null;
      policies = this.#policyFactory?.({ bridge, tool, exportedName }) ?? [];
      if (!Array.isArray(policies)) {
        throw new Error(`Call policy factory for bridge ${bridge.id} must return an array.`);
      }
      config = adapter?.configureTool ? adapter.configureTool(baseConfig) : baseConfig;
    } catch (error) {
      throw new BridgeConfigError(
        `Invalid adapter/policy configuration for ${bridge.id}.${tool.name}: ${error.message}`,
        { cause: error },
      );
    }

    return { tool, exportedName, config, adapter, policies };
  }

  #registerStagedTool(bridge, client, staged) {
    const { tool, exportedName, config, adapter, policies } = staged;
    return this.#server.registerTool(exportedName, config, async (args, ctx) => {
      for (const policy of policies) {
        if (policy?.beforeCall) {
          await policy.beforeCall({ args: args ?? {}, ctx, tool, bridge });
        }
      }

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
  }

  async #markUnavailable(bridge, client, error) {
    await client.close().catch(() => {});
    this.#status.push({
      id: bridge.id,
      enabled: true,
      state: 'unavailable',
      transport: bridge.transport?.type ?? null,
      tools: [],
      error: bridgeErrorDetails(error),
    });
    console.error(`[mcp-bridge] ${bridge.id}: unavailable: ${error.message}`);
  }

  async #connectBridge(bridge) {
    let transport;
    try {
      transport = createTransport(bridge);
    } catch (error) {
      if (error instanceof BridgeConfigError) throw error;
      throw new BridgeConfigError(`Invalid transport configuration for bridge ${bridge.id}: ${error.message}`, {
        cause: error,
      });
    }

    const client = new Client({
      name: `agent-mcp-bridge-${bridge.id}`,
      version: '1.0.0',
    });

    try {
      await client.connect(transport);
    } catch (error) {
      await this.#markUnavailable(bridge, client, error);
      return;
    }

    let allTools;
    try {
      allTools = await listAllTools(client);
    } catch (error) {
      await this.#markUnavailable(bridge, client, error);
      return;
    }

    const exposedTools = allTools.filter((tool) => shouldExposeTool(tool.name, bridge));
    const stagedNames = new Set(this.#reservedToolNames);
    let stagedTools;
    try {
      stagedTools = exposedTools.map((tool) => this.#stageTool(bridge, tool, stagedNames));
    } catch (error) {
      await client.close().catch(() => {});
      if (error?.bridgeUnavailable) {
        this.#status.push({
          id: bridge.id,
          enabled: true,
          state: 'unavailable',
          transport: bridge.transport.type,
          tools: [],
          error: bridgeErrorDetails(error),
        });
        return;
      }
      if (error instanceof BridgeConfigError) throw error;
      throw new BridgeConfigError(`Invalid bridge configuration for ${bridge.id}: ${error.message}`, { cause: error });
    }

    const registrations = [];
    try {
      for (const staged of stagedTools) {
        const handle = this.#registerStagedTool(bridge, client, staged);
        registrations.push({ name: staged.exportedName, handle });
      }
    } catch (error) {
      for (const { handle } of registrations.reverse()) {
        try {
          handle.remove();
        } catch {
          // Best-effort rollback; startup will fail below.
        }
      }
      await client.close().catch(() => {});
      throw new BridgeConfigError(`Failed to register tools for bridge ${bridge.id}: ${error.message}`, { cause: error });
    }

    for (const { name } of registrations) this.#reservedToolNames.add(name);
    const mappings = stagedTools.map(({ tool, exportedName }) => ({ upstream: tool.name, exported: exportedName }));
    this.#connections.push({ id: bridge.id, client, transport, registrations });
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
  }

  status() {
    return {
      configPath: this.#configPath,
      bridges: this.#status,
    };
  }

  async close() {
    const connections = this.#connections.splice(0);
    for (const connection of connections) {
      for (const { name, handle } of [...(connection.registrations ?? [])].reverse()) {
        try {
          handle.remove();
        } catch {
          // Continue closing the rest of the manager even if a registration was already removed.
        }
        this.#reservedToolNames.delete(name);
      }
    }
    await Promise.allSettled(connections.map(({ client }) => client.close()));
  }
}
