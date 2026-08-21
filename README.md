# agent-vm-mcp

MCP server for controlling a dedicated Linux agent VM and forwarding tools from pluggable upstream MCP servers.

> [!WARNING]
> This server intentionally exposes arbitrary command execution and persistent process control. Treat access to it as equivalent to shell access to the VM and do not expose it to untrusted clients.

## Features

- Execute finite shell commands with bounded output, timeouts, and MCP-request cancellation.
- Read/list files structurally and apply strict unified diffs without fuzzy fallback.
- Start, rediscover, read, write to, and terminate persistent/interactive processes.
- Discover curated CLI capabilities available on the VM.
- Bridge tools from upstream MCP servers over stdio or Streamable HTTP.
- Filter, prefix, and rename bridged tools while rejecting name collisions.
- Forward Playwright MCP tools through the same MCP endpoint.
- Present VM files as opaque MCP artifacts with preview/download UI.
- Automatically attach Playwright screenshots to the conversation and expose images to ChatGPT vision when supported.

## Native tools

- `exec`
- `read_file`
- `list_directory`
- `apply_patch`
- `import_file`
- `command_info`
- `present_file`
- `process_start`
- `process_list`
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

For the dedicated Ubuntu Agent VM, provision the container toolchain with:

```bash
sudo ./scripts/provision-docker.sh
```

The script installs Ubuntu's `docker.io`, `docker-compose-v2`, and `docker-buildx` packages, enables the Docker service, and grants the dedicated `agent` user access to the local Unix socket through the `docker` group. Existing long-running services or login sessions must be restarted after first adding the group so they inherit the new supplementary group.

## Run

```bash
pnpm start
```

The server communicates over stdio.

## Configuration

- `config/capabilities.json` defines the curated CLI catalog exposed to agents.
- `config/bridges.json` defines upstream MCP servers and forwarded tools.

See [`config/README.md`](config/README.md) for bridge configuration, environment forwarding, and capability discovery details.

The default bridge configuration expects the local Playwright MCP launcher at `/opt/playwright-mcp/start.sh`. Its `browser_take_screenshot` tool is adapted into the generic artifact channel. Adjust `config/bridges.json` for other deployments.

Artifact resources are opaque, process-local references with a 24-hour default TTL and a 50 MiB default size limit. Override these with `AGENT_ARTIFACT_TTL_MS` and `AGENT_ARTIFACT_MAX_BYTES`.

ChatGPT-hosted files can be imported into the VM with `import_file`; file bytes are streamed from the host-provided short-lived URL rather than passed through model context. Imports are limited to 256 MiB by default; override with `AGENT_FILE_IMPORT_MAX_BYTES`. Downloads are written to a same-directory temporary file and only committed after successful completion, so cancellation does not leave a partial destination.

`read_file` and `list_directory` are intentionally bounded, non-search filesystem primitives for high-frequency coding reads. `apply_patch` uses strict `git apply` validation and apply passes: it does not enable recounting, 3-way merge, rejected-hunk files, unsafe paths, whitespace-insensitive context matching, or fuzzy fallback. Applicability failures are zero-write; this is not a claim of cross-file crash-atomic filesystem transactions. Patch validation honors MCP cancellation, while the mutation phase is allowed to finish once launched and is awaited during graceful server shutdown.

Process sessions created by `process_start` are in-memory resources owned by the running `agent-vm-mcp` process. Use `process_list` to rediscover them across MCP client or conversation changes. On graceful server shutdown, running managed process groups receive `SIGTERM` and are escalated to `SIGKILL` after a bounded grace period. Sessions are not recoverable across server restarts; abnormal-exit cleanup belongs to the deployment supervisor/cgroup rather than a persisted PID/PGID registry.

## Validation

Run the smoke test:

```bash
pnpm smoke
```

The smoke test starts the server with a Playwright bridge stub and validates the native and forwarded tool surface.
