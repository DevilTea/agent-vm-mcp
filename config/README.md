# Configuration reference

`agent-vm-mcp` ships portable built-in defaults and keeps deployment-specific configuration outside the repository checkout.

## Resolution order

For file-based configuration, the runtime resolves:

1. an explicit path supplied by the caller/runtime;
2. the corresponding environment-variable override;
3. `$XDG_CONFIG_HOME/agent-vm-mcp/<file>` when `XDG_CONFIG_HOME` is set, or `~/.config/agent-vm-mcp/<file>` when it is not;
4. the built-in file under this repository's `config/` directory when that selected user-config file does not exist.

An explicit environment override is authoritative. If it points to a missing or invalid file, the runtime reports the error rather than silently falling back.

| Purpose | Filename | Environment override |
| --- | --- | --- |
| MCP bridges | `bridges.json` | `MCP_BRIDGES_CONFIG` |
| CLI capabilities | `capabilities.json` | `AGENT_MCP_CAPABILITIES_CONFIG` |
| System audit | `system-audit.json` | `AGENT_MCP_SYSTEM_AUDIT_CONFIG` |
| Shared Playwright stdio proxy | `playwright-shared-proxy.json` | `PLAYWRIGHT_SHARED_PROXY_CONFIG` |

The built-in `bridges.json` contains an empty bridge list. Machine-specific Playwright/LSP configuration is an optional example under `config/examples/`.

## MCP Skills (SEP-2640)

The canonical MCP-facing skill surface follows the [Final SEP-2640: Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640). It declares the `io.modelcontextprotocol/skills` extension and uses `skills/list`, `skills/get`, standard `resources/read`, and `resources/directory/read` with `skill://` URIs. Listings contain complete parsed `SKILL.md` frontmatter and a digest/size manifest for every regular file; reads are lazy and bounded by the SEP limits.

The dot-agents projection is an internal publication snapshot rather than a second protocol model. The native host-facing `skill_list` and `skill_read` tools remain compatibility fallbacks for current ChatGPT behavior and consume that published projection rather than scanning installed harness skill directories. The projection root defaults to:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/dot-agents/skill-projection/v1/
```

Override it with `AGENT_MCP_SKILL_PROJECTION_ROOT`. The root contains a version 1 `catalog.json` with `source: "dot-agents"` and `skills/<name>/...`; each catalog entry must provide a sorted `name`, `description`, `entrypoint: "SKILL.md"`, and `sha256:<64 lowercase hex digits>` hash. The adapter validates the root/catalog layout and tree hash at request time. Filesystem paths are not exposed. Absent or invalid published data is reported as unavailable without blocking MCP startup for the compatibility tools. This repository has not verified ChatGPT native SEP-2640 consumption, so no such support is claimed.

`skill_list` exposes availability, root source, and catalog metadata without filesystem paths, with an optional case-insensitive name/description query. Hosts should inspect it when reusable guidance may apply and then use `skill_read` for the selected skill. `skill_read` defaults to `SKILL.md` and permits only safe relative text reads within that skill, including references or scripts as text. Traversal, symlinks/escaping paths, non-regular files, binary/non-UTF-8 content, and reads above the 256 KiB bound are rejected. These skills are instructions/data, not executable capabilities; this surface does not expose Codex system skills.

## MCP bridges

A bridge exposes selected upstream MCP tools through the same server. Supported transports are stdio and Streamable HTTP.

### Semantics

All bridges are optional integrations. `enabled: true` means the runtime attempts to connect that integration during startup. It does not make the integration a prerequisite for the native core.

The contract is:

> Invalid configuration fails startup. Unavailable integrations do not.

An unavailable integration is recorded with `state: "unavailable"` and an error. Examples include:

- missing stdio executables;
- process startup failure;
- HTTP connection refusal/offline service;
- upstream connect/handshake failure;
- upstream `tools/list` failure.

Startup fails for deterministic local configuration errors, including:

- invalid JSON or unsupported config version;
- duplicate bridge IDs;
- invalid transport, adapter, or policy configuration;
- deterministic exported-tool name collisions.

Bridge tool definitions are staged before registration. If fatal initialization occurs after earlier bridges connected, registered tool handles and upstream clients are cleaned up before the error escapes.

There is intentionally no `required` field. A deployment supervisor or external health check can enforce that a particular optional integration must be available for that deployment.

### stdio example

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

### Streamable HTTP example

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

Tool names must be unique after prefixing/renaming.

## Tool result adapters

`toolAdapters` can decorate an upstream result without changing transport semantics. Adapter failures are fail-open: if post-processing fails, the original upstream result is returned.

The built-in `output-directory-artifact` adapter snapshots an output directory before a call, detects a created/changed matching file afterward, and registers it as an opaque `artifact://agent-vm/<id>` resource for model/internal access. It does not automatically attach a user-facing `resource_link`; use `present_artifact` when the file should be presented to the user. Images can still be attached as standard MCP `image` content for same-turn model inspection.

Example:

```json
{
  "toolAdapters": {
    "tool_that_writes_a_file": {
      "type": "output-directory-artifact",
      "outputDir": "/absolute/output/directory",
      "extensions": [".png"],
      "pathArgument": "filename",
      "workingDir": "/optional/working/directory",
      "mimeTypeArgument": "type",
      "mimeTypeMap": {
        "png": "image/png"
      }
    }
  }
}
```

No custom iframe/MCP App viewer is required; presentation is left to the MCP host's native handling of standard resources, resource links, and images.

## Call policies

`callPolicies` are pre-forwarding guardrails. Policy rejection is fail-closed for that call: the upstream tool is not invoked.

The built-in `deny-workspace-config-files` policy rejects a forwarded call when configured plain filenames exist directly under the supplied workspace root.

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

This is an orchestration/deployment policy, not a security boundary against another process already running as the same trusted VM user.

## Optional Playwright/LSP example

`config/examples/bridges.playwright-lsp.json` demonstrates the deployment used by the repository's live smoke test:

- Playwright over Streamable HTTP at a loopback service, exporting `browser_*` tools;
- screenshot artifact adaptation through standard MCP content;
- a stdio LSP MCP bridge with an `lsp_` prefix;
- an allow-list of read-oriented LSP tools;
- host-side rejection of repository-local `.lsp-mcp.json` / `.lsp-mcp.jsonc` before workspace-scoped LSP calls.

The example contains deployment paths such as `/opt/playwright-mcp`, `/opt/language-server-mcp`, and the default `agent` home. Adapt it before placing it in the XDG config directory.

## CLI capability discovery

`capabilities.json` is a curated agent-facing CLI catalog rather than a dump of every executable on `PATH`.

- `capabilities` combines runtime detection of the catalog with host/native MCP, process, coding-agent, and bridge information.
- `command_info` can inspect named commands on `PATH`; curated commands additionally receive category/summary/version metadata.
- `versionArgs` are executed directly without a shell only for curated entries.
- `probes` represent curated subcommands such as `docker compose version`.
- editing capability metadata does not require restarting the server; adding/removing MCP tools does.

The catalog describes useful capabilities to probe. A listed command being absent does not prevent native core startup.

## System maintenance audit

`system-audit.json` drives the read-only `system_audit` tool. The built-in file is generic: it has no machine-specific repositories, projects, services, or fixed installations.

Automatic discovery covers:

- installed mise tools;
- global npm packages;
- curated CLI entries;
- executable files in configured direct-executable directories;
- configured installations, services, repositories, and package-manager projects.

An installed item without a safe inferred update source, explicit `latestSources` entry, or `managedBy` owner is surfaced under `coverage.untracked` rather than silently disappearing.

### Repository state

Repository status separates local tracking ancestry from live remote observation.

Local `HEAD` vs the local tracking ref is reported as:

- `in_sync`;
- `ahead`;
- `behind`;
- `diverged`.

The audit uses local Git ancestry/counts for those states and does not fetch solely to classify them.

When `checkLatest` is enabled, `git ls-remote` observes the current remote branch head. That live hash is reported separately (`matchesHead`, `matchesTrackingHead`, `changedFromTracking`); an unequal live hash does not by itself imply that local `HEAD` is behind.

### pnpm project checks

`pnpm outdated --format json` commonly returns a non-zero exit code when updates exist. The audit therefore accepts non-empty valid JSON regardless of exit status. Invalid non-empty JSON or a failed command with no usable JSON becomes a source error; a successful empty result means no outdated packages.

### Adding explicit sources

Example GitHub release source:

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

Example important installation outside the normal discovery paths:

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

`command` installations reject direct probing of supported coding harness commands; harness inspection remains owned by the coding-agent runtime.

The audit is fail-soft for source/network failures: affected items remain visible with `sourceErrors` rather than aborting the entire audit. It never installs/upgrades packages, restarts services, or fetches Git refs.

## Host profile

`AGENT_CODEX_ENFORCED_MODEL` and `AGENT_CODEX_ENFORCED_EFFORT` are an optional paired deployment policy for Codex agents. Set both to force every MCP-managed Codex launch/resume to the specified model and reasoning effort. Callers may omit model/effort and receive the enforced values; explicit conflicting values fail with `agent_launch_policy_violation`. The policy is exposed through `agent_capabilities`.

`AGENT_MCP_HOST` is connection/deployment context rather than a normal tool argument.

Supported values:

- `generic` — default, no vendor-specific tool metadata;
- `chatgpt` — currently enables the OpenAI/ChatGPT file-input metadata needed by `import_file`.

Host-specific behavior should remain isolated here. Prefer standard MCP content/capabilities over host-name conditionals whenever possible.

## Deployment examples

The repository's Ubuntu provisioners remain opinionated and may create systemd units or `/opt/...` installations. Those are deployment choices, not portable source defaults.

`config/examples/systemd/` contains optional drop-ins showing how a separately managed tunnel service can depend on Herdr or browser services. The core runtime does not require or manage an `agent-tunnel.service`.
