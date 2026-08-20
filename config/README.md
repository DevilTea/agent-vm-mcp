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
  "renameTools": {},
  "toolAdapters": {
    "tool_that_writes_a_file": {
      "type": "output-directory-artifact",
      "outputDir": "/absolute/output/directory",
      "extensions": [".png"]
    }
  }
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

## Tool result adapters

`toolAdapters` is an optional bridge extension point. An adapter can decorate a forwarded tool definition and observe the call before/after the upstream MCP invocation without changing the bridge transport itself.

`output-directory-artifact` snapshots an output directory before the upstream call, detects the newest created/changed matching file afterward, registers it as an opaque `artifact://agent-vm/<id>` resource, and attaches the generic Artifact Viewer to the tool result. Adapter failures are fail-open: the original upstream tool result is returned unchanged.

Adapter options:

- `outputDir`: required directory used for automatic output discovery.
- `extensions`: file extensions eligible for directory discovery.
- `pathArgument`: optional tool argument containing an explicit output filename/path.
- `workingDir`: base directory for a relative `pathArgument`; defaults to `outputDir`.
- `mimeTypeArgument` + `mimeTypeMap`: optionally derive a MIME type from a tool argument instead of relying only on filename extension.

The default Playwright bridge applies this adapter only to `browser_take_screenshot`. Playwright writes unnamed screenshots to its configured output directory, while an explicit relative `filename` is resolved against the Playwright MCP working directory; the adapter handles both cases.

# CLI capability discovery

`capabilities.json` is the curated, agent-facing CLI catalog. It is intentionally not a dump of every executable on `PATH`.

- `capabilities` combines runtime detection of this catalog with host, native MCP, persistent-process, and bridge information.
- `command_info` can inspect any safe command name on `PATH`; commands in the catalog additionally receive category, summary, and version metadata.
- `versionArgs` are executed directly (without a shell) only for curated entries.
- Capability metadata is read on each tool call, so editing `capabilities.json` does not require a service restart. Adding/removing MCP tools still requires one so the MCP tool schema can be rediscovered.
- Override the catalog path with `AGENT_MCP_CAPABILITIES_CONFIG` when needed.
