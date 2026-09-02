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
Playwright deliberately uses an empty prefix because its upstream tool names already use the `browser_` namespace. The production Playwright bridge uses Streamable HTTP at `http://localhost:8931/mcp`; `agent-playwright-shared.service` binds the server to IPv4 loopback and owns the persistent profile independently of `agent-tunnel.service`. Coding harnesses that need a clean browser start `/opt/playwright-mcp/start-isolated.sh` as their own stdio MCP process instead of attaching to the shared profile.

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

## Fail-closed call policies

`callPolicies` are pre-forwarding guardrails. Unlike result adapters, policy failures are **fail-closed**: if a policy rejects or errors, the upstream MCP tool is not invoked.

The `deny-workspace-config-files` policy reads a configured workspace-root argument and rejects the call when any configured plain filename exists directly under that root. The default LSP bridge uses it to reject `.lsp-mcp.json` and `.lsp-mcp.jsonc` before `language-server-mcp` can load project-controlled server commands.

```json
{
  "callPolicies": [
    {
      "type": "deny-workspace-config-files",
      "workspaceRootArgument": "workspaceRoot",
      "filenames": [".lsp-mcp.json", ".lsp-mcp.jsonc"]
    }
  ]
}
```

This is intentionally separate from `toolAdapters`: adapters decorate observable results and are fail-open, while policies enforce whether a call may reach an upstream server.

## Read-only LSP bridge

The default `lsp` bridge launches `/opt/language-server-mcp/start.sh`, prefixes exported tools with `lsp_`, and forwards only these upstream tools:

- `hover`, `signature_help`
- `declaration`, `definition`, `type_definition`, `implementation`, `references`
- `document_symbols`, `workspace_symbols`, `diagnostics`
- `call_hierarchy_prepare`, `call_hierarchy_incoming`, `call_hierarchy_outgoing`
- `type_hierarchy_prepare`, `type_hierarchy_supertypes`, `type_hierarchy_subtypes`
- `list_servers`, `search_servers`, `server_status`

Mutation and unrestricted execution surfaces such as rename/formatting/code actions, raw `request`/`notify`, `execute_command`, completion breadth, and server lifecycle mutation tools are not exported. Workspace-scoped calls retain the upstream `workspaceRoot` argument; `agent-vm-mcp` does not introduce a global active workspace.

The deployment-owned `~/.config/lsp-mcp/config.json` is created by `scripts/provision-lsp.sh`. It disables managed downloads and LSP command execution and keeps external-workspace access disabled. A missing language server therefore fails observably instead of being downloaded automatically. Repository-local LSP MCP configuration is not trusted in this version and is denied by the host-side call policy above.

# CLI capability discovery

`capabilities.json` is the curated, agent-facing CLI catalog. It is intentionally not a dump of every executable on `PATH`.

- `capabilities` combines runtime detection of this catalog with host, native MCP, persistent-process, and bridge information.
- `command_info` can inspect any safe command name on `PATH`; commands in the catalog additionally receive category, summary, and version metadata.
- `versionArgs` are executed directly (without a shell) only for curated entries.
- Optional `probes` describe curated CLI invocations that are not standalone executables, such as `docker compose version`. Each probe names a real `command` on `PATH` plus direct `args`; `capabilities` reports the probe as available only when that invocation exits successfully. Probes do not change `command_info` semantics or synthesize fake commands on `PATH`.
- Capability metadata is read on each tool call, so editing `capabilities.json` does not require a service restart. Adding/removing MCP tools still requires one so the MCP tool schema can be rediscovered.
- Override the catalog path with `AGENT_MCP_CAPABILITIES_CONFIG` when needed.


# System maintenance audit

`system-audit.json` drives the read-only `system_audit` native MCP tool. The audit is deliberately split between **automatic discovery** and a small declarative exception map so that adding software to the VM does not require maintaining a second hard-coded checklist.

Automatic discovery covers:

- all installed mise tools from `mise ls --json`, including inactive installed versions; non-`npm:` tools use `mise latest` by default and `npm:<package>` tools use the npm registry;
- all global npm packages from `npm ls -g --depth=0 --json`, with npm registry latest-version lookup inferred automatically;
- every CLI declared in `capabilities.json`; coding harness versions come from the existing agent runtime inspection path and are never raw-launched by `system_audit`;
- executable files in `directExecutableDirs` (by default `~/.local/bin` and `/usr/local/bin`), with obvious backup/temp names ignored;
- configured important installations, service health, Git repository cleanliness/remote HEAD, APT upgrades, and project dependency drift.

The coverage contract is explicit: any installed discovered item without an inferred source, a configured `latestSources` entry, or a `managedBy` owner is returned in `coverage.untracked`. A new tool therefore cannot silently disappear from maintenance reporting. `coverage.trackedCount`, `updateSourceKnownCount`, `managedElsewhereCount`, and `untrackedCount` make that invariant easy to monitor.

## Adding a future tool

In the common cases, do nothing beyond installing it:

1. A tool installed through mise is discovered automatically.
2. A package installed globally through npm is discovered automatically.
3. A new curated CLI added to `capabilities.json` is automatically included.
4. A custom executable dropped in one of `directExecutableDirs` is automatically included.

Only add an explicit mapping when the audit can see the tool but cannot safely infer how to check its latest release. Put that mapping under `latestSources`; supported source kinds include npm, mise, and GitHub Releases. For example:

```json
{
  "latestSources": {
    "example-cli": {
      "kind": "github-release",
      "repo": "owner/example-cli",
      "stripPrefix": "v"
    }
  }
}
```

For an important binary outside the automatic directories, add a declarative `installations` entry instead of teaching the audit code about that specific tool:

```json
{
  "installations": [
    {
      "id": "example-system-cli",
      "kind": "command",
      "command": "example-system-cli",
      "args": ["--version"],
      "managedBy": "apt/system"
    }
  ]
}
```

`command` installations explicitly reject `codex`, `agy`, and `claude`; harness inspection remains owned by `agent_capabilities`. `npm-project` installations can represent fixed deployments such as `/opt/playwright-mcp` and automatically infer their npm update source.

`latestSources` overrides inferred sources, which is useful for keeping a pinned major track (for example `node@24` or `pnpm@11`) instead of comparing against an unrelated next major. `coverage.managedElsewhere` can mark a discovered executable as intentionally maintained by another audited surface such as a Git repository.

The tool is fail-soft: registry/network/repository failures are collected in `sourceErrors` and leave the affected item `unknown` rather than aborting the whole audit. `checkLatest: false` skips latest/remote lookups while retaining local inventory and health checks. The audit never installs, upgrades, restarts, fetches Git refs, or otherwise mutates the VM.
