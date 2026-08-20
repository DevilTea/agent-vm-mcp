# agent-vm-mcp

MCP server for controlling a dedicated Linux agent VM and forwarding tools from pluggable upstream MCP servers.

> [!WARNING]
> This server intentionally exposes arbitrary command execution and persistent process control. Treat access to it as equivalent to shell access to the VM and do not expose it to untrusted clients.

## Features

- Execute finite shell commands with bounded output and timeouts.
- Start, read, write to, and terminate persistent/interactive processes.
- Discover curated CLI capabilities available on the VM.
- Bridge tools from upstream MCP servers over stdio or Streamable HTTP.
- Filter, prefix, and rename bridged tools while rejecting name collisions.
- Forward Playwright MCP tools through the same MCP endpoint.

## Native tools

- `exec`
- `command_info`
- `process_start`
- `process_read`
- `process_write`
- `process_kill`
- `capabilities`
- `mcp_bridge_status`

Additional tools can be exported by configured MCP bridges.

## Requirements

- Node.js
- pnpm 11

## Install

```bash
pnpm install --frozen-lockfile
```

## Run

```bash
pnpm start
```

The server communicates over stdio.

## Configuration

- `config/capabilities.json` defines the curated CLI catalog exposed to agents.
- `config/bridges.json` defines upstream MCP servers and forwarded tools.

See [`config/README.md`](config/README.md) for bridge configuration, environment forwarding, and capability discovery details.

The default bridge configuration expects the local Playwright MCP launcher at `/opt/playwright-mcp/start.sh`. Adjust `config/bridges.json` for other deployments.

## Validation

Run the smoke test:

```bash
pnpm smoke
```

The smoke test starts the server with a Playwright bridge stub and validates the native and forwarded tool surface.
