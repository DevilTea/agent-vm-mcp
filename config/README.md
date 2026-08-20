# MCP bridges

`bridges.json` declares upstream MCP servers whose tools are re-exported by `agent-mcp`.
A bridge is connected during `agent-mcp` startup; changing the config therefore requires restarting `agent-tunnel.service`.

## stdio example

```json
{
  "id": "example",
  "enabled": true,
  "transport": {
    "type": "stdio",
    "command": "/absolute/path/to/mcp-server",
    "args": [],
    "cwd": "/optional/working/directory",
    "inheritEnv": ["OPTIONAL_PARENT_VARIABLE"],
    "env": { "STATIC_VALUE": "value" },
    "envFrom": { "CHILD_TOKEN": "PARENT_TOKEN" }
  },
  "toolPrefix": "example_",
  "includeTools": ["*"],
  "excludeTools": [],
  "renameTools": {}
}
```

## Streamable HTTP example

```json
{
  "id": "remote",
  "enabled": true,
  "transport": {
    "type": "streamable-http",
    "url": "https://example.test/mcp",
    "headers": { "X-Static": "value" },
    "headersFromEnv": { "X-API-Key": "REMOTE_MCP_API_KEY" },
    "bearerTokenEnv": "REMOTE_MCP_BEARER_TOKEN"
  },
  "toolPrefix": "remote_"
}
```

Tool names must be unique after prefixing/renaming. Startup fails on collisions instead of silently shadowing tools.
Playwright deliberately uses an empty prefix because its upstream tool names already use the `browser_` namespace.

# CLI capability discovery

`capabilities.json` is the curated, agent-facing CLI catalog. It is intentionally not a dump of every executable on `PATH`.

- `capabilities` combines runtime detection of this catalog with host, native MCP, persistent-process, and bridge information.
- `command_info` can inspect any safe command name on `PATH`; commands in the catalog additionally receive category, summary, and version metadata.
- `versionArgs` are executed directly (without a shell) only for curated entries.
- Capability metadata is read on each tool call, so editing `capabilities.json` does not require a service restart. Adding/removing MCP tools still requires one so the MCP tool schema can be rediscovered.
- Override the catalog path with `AGENT_MCP_CAPABILITIES_CONFIG` when needed.
