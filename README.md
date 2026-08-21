# agent-vm-mcp

MCP server for controlling a dedicated Linux agent VM and forwarding tools from pluggable upstream MCP servers.

> [!WARNING]
> This server intentionally exposes arbitrary command execution and persistent process control. Treat access to it as equivalent to shell access to the VM and do not expose it to untrusted clients.

## Features

- Execute finite shell commands with bounded head/tail previews, oversized stdout/stderr artifacts, timeouts, and MCP-request cancellation.
- Read/list files structurally and apply strict unified diffs without fuzzy fallback.
- Create, rediscover, and explicitly remove isolated Git worktree workspaces backed by shared repository storage.
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
- `workspace_create`
- `workspace_list`
- `workspace_delete`
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

- Node.js 24.19.0
- pnpm 11.22.0

The dedicated Agent VM provisions both through `mise`; repository-local mise configuration may override the fallback versions only after explicit trust.

## Install

```bash
pnpm install --frozen-lockfile
```

For the dedicated Ubuntu Agent VM, provision the container toolchain with:

```bash
sudo ./scripts/provision-docker.sh
```

The script installs Ubuntu's `docker.io`, `docker-compose-v2`, and `docker-buildx` packages, enables the Docker service, and grants the dedicated `agent` user access to the local Unix socket through the `docker` group. Existing long-running services or login sessions must be restarted after first adding the group so they inherit the new supplementary group.

Provision the versioned developer toolchain with:

```bash
sudo ./scripts/provision-mise.sh
```

The mise provisioner installs mise through the Ubuntu-supported PPA path, installs the exact Agent VM fallback versions (Node `24.19.0`, pnpm `11.22.0`), configures non-interactive shims, and migrates the systemd/tunnel/Playwright launch paths away from the legacy pnpm-managed Node executable. It does **not** restart `agent-tunnel.service` because doing so terminates the active MCP connection. Restart and validate the service separately, then remove the old pnpm-managed executable/global Node environment with:

```bash
sudo ./scripts/provision-mise.sh --cleanup-legacy
```

The global mise policy enables paranoid trust checking and disables implicit installation and system-runtime fallback. Before provisioning a repository-local mise toolchain, inspect its committed mise files as ordinary repository content, then explicitly trust and install them:

```bash
mise trust --show
mise trust ./mise.toml
mise install
```

Do not make `workspace_create` trust or install project toolchains. A workspace is only repository/worktree lifecycle; toolchain trust and installation remain explicit follow-up actions.

Provision the read-only LSP code-intelligence bridge after mise is available:

```bash
sudo ./scripts/provision-lsp.sh
```

The LSP provisioner installs exact mise-owned versions of `language-server-mcp` (`0.3.1`), `typescript-language-server` (`5.3.0`), and TypeScript (`6.0.3`). It writes a controlled launcher at `/opt/language-server-mcp/start.sh` and deployment-owned user configuration at `~/.config/lsp-mcp/config.json`. The launcher pins the control-plane Node runtime instead of resolving through a task workspace. Re-running the provisioner is intended to be idempotent.

The controlled LSP configuration disables managed language-server downloads, disables `workspace/executeCommand`, disallows external-workspace file edits, and configures TypeScript as a manually provisioned system server. Project-local `.lsp-mcp.json` and `.lsp-mcp.jsonc` files are rejected by `agent-vm-mcp` before workspace-scoped LSP calls are forwarded; there is no automatic trust path in this version. Native `apply_patch` remains the mutation mechanism.

Provisioning does not restart `agent-tunnel.service`. After deploying a bridge/config change, restart the service separately and verify `mcp_bridge_status` plus representative `lsp_` calls.

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

Artifact resources are opaque, process-local references with a 24-hour default TTL and a 50 MiB default size limit. Override these with `AGENT_ARTIFACT_TTL_MS` and `AGENT_ARTIFACT_MAX_BYTES`. Files registered by callers such as `present_file` remain caller-owned; temporary spill files created by `exec` are artifact-store-owned and are removed on expiry or graceful server shutdown.

Finite `exec` keeps stdout and stderr separate. Streams up to 128 KiB remain inline unchanged; larger streams return a 64 KiB head + 64 KiB tail preview, exact observed-byte counts, and a separate opaque artifact per oversized stream. The artifact contains the complete stream while it fits within `AGENT_ARTIFACT_MAX_BYTES`; if the stream exceeds that hard bound, artifact metadata explicitly reports truncation while the inline preview still preserves the true final 64 KiB. Cancelled requests discard any unpublished spill file rather than leaving an unreachable artifact behind. Persistent `process_*` output keeps its independent bounded ring-buffer semantics.

ChatGPT-hosted files can be imported into the VM with `import_file`; file bytes are streamed from the host-provided short-lived URL rather than passed through model context. Imports are limited to 256 MiB by default; override with `AGENT_FILE_IMPORT_MAX_BYTES`. Downloads are written to a same-directory temporary file and only committed after successful completion, so cancellation does not leave a partial destination.

`read_file` and `list_directory` are intentionally bounded, non-search filesystem primitives for high-frequency coding reads. `apply_patch` uses strict `git apply` validation and apply passes: it does not enable recounting, 3-way merge, rejected-hunk files, unsafe paths, whitespace-insensitive context matching, or fuzzy fallback. Applicability failures are zero-write; this is not a claim of cross-file crash-atomic filesystem transactions. Patch validation honors MCP cancellation, while the mutation phase is allowed to finish once launched and is awaited during graceful server shutdown.

Managed workspaces use shared bare Git repository stores plus isolated Git worktrees. `workspace_create` creates a detached worktree for both default and explicit revisions, returning an immutable server-generated workspace ID and a path that existing tools can use as `cwd`. `workspace_list` reconstructs state from the managed filesystem layout and Git worktree metadata rather than an MCP-local registry. `workspace_delete` refuses dirty worktrees unless `force: true` is explicit and never implicitly removes branches, repository caches, processes, or containers.

The default managed roots are `~/.local/share/agent-vm/repositories` for shared bare repositories and `~/workspaces` for worktrees. Deployments/tests may override them with `AGENT_REPOSITORY_ROOT` and `AGENT_WORKSPACE_ROOT`. Repository authentication stays with normal Git mechanisms such as `gh auth git-credential` or SSH; HTTP(S) clone URLs containing embedded userinfo, query parameters, or fragments are rejected so credentials are not persisted in repository config. `workspace_list` also redacts those URL components if an origin is later changed out-of-band.

Git worktrees are **working-tree isolation, not full-clone isolation**. Each workspace has its own working tree, index, and `HEAD`, while objects, refs/branches, tags, remotes, repository-level config, and stash remain shared within the repository store. Lifecycle operations are serialized per repository; Git remains authoritative for branch/worktree locking and out-of-band shell operations.

Workspace creation owns repository bootstrap/fetch and worktree creation only. It does not install dependencies, create task branches, commit/stash changes, start processes, manage containers, or bootstrap projects. Creation cancellation cleans pre-commit partial work; once destructive `workspace_delete` removal begins, request cancellation no longer interrupts that mutation and graceful server shutdown waits for it to finish.

Process sessions created by `process_start` are in-memory resources owned by the running `agent-vm-mcp` process. Use `process_list` to rediscover them across MCP client or conversation changes. On graceful server shutdown, running managed process groups receive `SIGTERM` and are escalated to `SIGKILL` after a bounded grace period. Sessions are not recoverable across server restarts; abnormal-exit cleanup belongs to the deployment supervisor/cgroup rather than a persisted PID/PGID registry.

## Validation

Run the smoke test:

```bash
pnpm smoke
```

The smoke test starts the server with a Playwright bridge stub and validates the native and forwarded tool surface.
