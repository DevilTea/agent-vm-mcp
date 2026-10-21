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
| SSH targets | `ssh.json` | `AGENT_MCP_SSH_CONFIG` |
| CLI capabilities | `capabilities.json` | `AGENT_MCP_CAPABILITIES_CONFIG` |
| System audit | `system-audit.json` | `AGENT_MCP_SYSTEM_AUDIT_CONFIG` |
| Shared Playwright stdio proxy | `playwright-shared-proxy.json` | `PLAYWRIGHT_SHARED_PROXY_CONFIG` |

The built-in `bridges.json` contains an empty bridge list. Machine-specific Playwright/LSP configuration is an optional example under `config/examples/`.

## Native SSH targets

`ssh_targets`, `ssh_exec`, `ssh_upload`, and `ssh_download` are native, config-driven tools. This feature uses the **same VM trust boundary** as the local `exec` tool: a caller already authorized to run local shell commands can independently run the OpenSSH client. SSH target registration is an orchestration affordance, not a security sandbox or per-agent authorization layer.

Use `ssh.json` (override: `AGENT_MCP_SSH_CONFIG`) under the standard configuration resolution rules. The built-in default is `{"version":1,"hosts":{},"identities":{}}`, so no target or secret is configured out of the box.

Example `~/.config/agent-vm-mcp/ssh.json`:

```json
{
  "version": 1,
  "identities": {
    "homelab-key": {
      "type": "file",
      "path": "/home/agent/.ssh/id_ed25519_homelab"
    },
    "session": { "type": "agent" }
  },
  "hosts": {
    "nas": {
      "host": "192.168.50.20",
      "user": "homelab",
      "port": 22,
      "identity": "homelab-key",
      "knownHostsFile": "/home/agent/.ssh/known_hosts"
    }
  }
}
```

- Only targets declared in `hosts` are accepted. `host` must be a literal IP address or hostname; tools do not accept caller-provided hostnames, usernames, credentials, or ports. `port` defaults to 22.
- `identity` references the `identities` registry. Omitted identity or `"default"` uses the OpenSSH default agent/environment unless `identities.default` is explicitly configured. `"type":"file"` references an **absolute private key file path**, not inline private key contents; `"type":"agent"` uses identities offered by the existing OpenSSH authentication agent while explicitly disabling implicit `~/.ssh/id_*` identity files. V1 intentionally has no password provider.
- `knownHostsFile` is an optional absolute path without whitespace; by default it is `$HOME/.ssh/known_hosts`. The file must exist before a remote operation. Host keys are checked with `StrictHostKeyChecking=yes`; unknown or changed host keys will fail instead of being enrolled automatically. Enroll known hosts in advance, verifying the fingerprint through an independent trusted channel. The server never runs `ssh-keyscan` to trust a new key automatically.
- The server reads and validates the registry **at startup**. Invalid configuration fails startup, whereas absent/empty built-in configuration is valid. Restart the MCP server after changing targets.
- All operations use OpenSSH with a blank user config (`-F /dev/null`) to avoid inheriting unreviewed ProxyCommand/forwarding rules, disable PTY and agent forwarding, disable interactive password prompting, and clear local forwarding. Connection setup is limited to 10 seconds; the per-call total `timeoutMs` defaults to 120,000, with a 1,000–600,000 ms range. Cancellation/timeout terminate the local client process group.
- `ssh_exec` executes a **single non-interactive remote shell command string**, returning stdout/stderr, exit status, timeout/cancellation and bounded artifact metadata. The command can invoke remote programs with side effects; review remote privileges accordingly.
- Transfers use OpenSSH `scp` (modern SFTP mode, no legacy `-O`). `localPath` must be absolute on the **Agent VM**. `remotePath` must be absolute and use conservative ASCII filename characters (no spaces, metacharacters, or `.`/`..` traversal). `ssh_upload` accepts only a local regular file. Upload/download may overwrite destination files or leave partial files on failure/cancellation; there is no implicit atomic rename or rollback.
- Remote executions are request-scoped rather than durable operations. If a response is lost, a remote command may have executed despite an absent result; inspect the remote machine and audit entries before retrying a potentially side-effecting command.
- Audited metadata is appended with private permissions to `${XDG_STATE_HOME:-$HOME/.local/state}/agent-vm-mcp/ssh-audit.jsonl`. Each remote attempt records target, operation, request ID, timestamps and outcome/exit status/signal; commands are represented by their SHA-256 digest, not plaintext. Neither credentials, command contents, stdout/stderr nor transfer file paths are written to the audit log. An audit write failure before execution prevents the remote call. Log retention and rotation are deployment responsibilities.
  If the **completion** audit write fails after the remote operation has already run, the tool returns the actual SSH result with `auditStatus: "completion_write_failed"` and a short `auditErrorCode` rather than hiding potentially completed side effects behind a generic tool failure. Normal results have `auditStatus: "complete"`.

Example MCP calls:

```json
{"tool":"ssh_targets","arguments":{}}
{"tool":"ssh_exec","arguments":{"target":"nas","command":"uname -a","timeoutMs":15000}}
{"tool":"ssh_upload","arguments":{"target":"nas","localPath":"/home/agent/export/archive.tar","remotePath":"/volume1/backups/archive.tar"}}
{"tool":"ssh_download","arguments":{"target":"nas","remotePath":"/volume1/logs/status.txt","localPath":"/home/agent/status.txt"}}
```

For an unattended dedicated VM identity, generate or keep a locally protected Ed25519 key, configure an identity entry with `type: "file"` and its absolute path, then enroll only its `.pub` file on each target. The VM's dedicated `id_ed25519_agent_vm_mcp` key, when present, is not automatically picked up by OpenSSH; include its absolute path in each target's named identity. Key-based authentication does not imply host-key trust: separately verify and enroll the remote server's host fingerprint in the configured known-hosts file.

A deterministic mock SSH/MCP smoke test is part of `pnpm test`. When an ephemeral local `sshd` and SFTP subsystem are available, run `pnpm test:ssh:real` for optional real OpenSSH loopback exec/upload/download and host-key rejection coverage, with disposable test keys; this does not contact homelab targets.

## MCP Skills (SEP-2640)

The canonical MCP-facing skill surface follows the [Final SEP-2640: Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640). It declares the `io.modelcontextprotocol/skills` extension and uses `skills/list`, `skills/get`, standard `resources/read`, and `resources/directory/read` with `skill://` URIs. Listings contain complete parsed `SKILL.md` frontmatter and a digest/size manifest for every regular file; reads are lazy and bounded by the SEP limits.

The dot-agents projection is an internal publication snapshot rather than a second protocol model. The generic host profile may consume the published projection through SEP-2640 and native `skill_list`/`skill_read` compatibility tools. The ChatGPT profile intentionally exposes neither surface. The projection root defaults to:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/dot-agents/skill-projection/v1/
```

Override it with `AGENT_MCP_SKILL_PROJECTION_ROOT`. The root contains a version 1 `catalog.json` with `source: "dot-agents"` and `skills/<name>/...`; each catalog entry must provide a sorted `name`, `description`, `entrypoint: "SKILL.md"`, and `sha256:<64 lowercase hex digits>` hash. The adapter validates the root/catalog layout and tree hash at request time. Filesystem paths are not exposed. Absent or invalid published data is reported as unavailable without blocking MCP startup for the compatibility tools. This repository has not verified ChatGPT native SEP-2640 consumption, so no such support is claimed.

On hosts that enable projected skills, `skill_list` exposes availability and catalog metadata while `skill_read` provides bounded safe text reads. The ChatGPT host does not register this surface or the SEP-2640 skill extension.

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

For curated commands that are also selected by mise, the audit keeps the version observed from the executable that `PATH` actually resolves instead of overwriting it with mise metadata. If that resolved version differs from mise's active/configured version, the item is reported with `status: "mismatch"`, a structured `versionMismatch`, and is included in the top-level `mismatches` list / `summary.mismatches` count. This catches provider collisions such as a stale Node/Corepack `pnpm` shim shadowing the separately pinned mise pnpm.

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

MCP coding-agent work uses an independent `agent-jobd` process: `agent_start` commits a durable background job, and `agent_poll`, `agent_result`, `agent_list`, and `agent_cancel` operate through its private Unix socket. The 15-second maximum poll is a request latency limit, not a job runtime limit; the default job timeout is two hours and the maximum is eight hours. The manager retains SQLite job state and full output files after an MCP restart, and independently running workers are not terminated by a manager restart. Lost workers are marked interrupted and never automatically retried. See [`../docs/agent-background-jobs.md`](../docs/agent-background-jobs.md) for deployment and recovery.

The existing short blocking `agent_run` remains capped at 30 seconds and uses the legacy bounded in-process runner. The Codex model policy is still `gpt-6-luna` / `max` in the current default service deployment (independent of dot-agents defaults); update the systemd service environment and the legacy runner policy together when deliberately changing that invariant. Antigravity runs use non-interactive print mode and structured stream output. The caller owns multi-reviewer decomposition, progress reporting, Git/workspace verification, and continuation policy.

Raw harness TUI execution is not a fallback path. On the ChatGPT host, `exec`/`process_start` reject `tmux`, `screen`, and `script`; coding harnesses must be invoked through the managed `agent_*` tools.

`AGENT_MCP_HOST` is connection/deployment context rather than a normal tool argument.

Supported values:

- `generic` — default, no vendor-specific tool metadata;
- `chatgpt` — enables OpenAI/ChatGPT file-input metadata and structured interactions, disables projected-skill/SEP skill exposure, and forbids interactive terminal session launchers through generic shell tools.

Host-specific behavior should remain isolated here. Prefer standard MCP content/capabilities over host-name conditionals whenever possible.

## Deployment examples

The repository's Ubuntu provisioners remain opinionated and may create systemd units or `/opt/...` installations. Those are deployment choices, not portable source defaults.

`config/examples/systemd/` contains optional drop-ins showing how a separately managed tunnel service can depend on browser services. The core runtime does not require or manage an `agent-tunnel.service`.
