# agent-vm-mcp

`agent-vm-mcp` is an MCP control plane for a dedicated Linux agent VM. It gives an MCP client shell-equivalent control of that VM, adds durable workspace and coding-agent orchestration, and can re-export tools from optional upstream MCP servers.

> [!WARNING]
> Access to this server is intentionally equivalent to shell access to the VM. The VM is the trust boundary. Do not expose this MCP endpoint to clients you would not trust with the VM, its credentials, mounted data, browser sessions, network reachability, Docker access, or SSH access.

## What it provides

The native MCP surface includes:

- finite shell execution with cancellation, bounded previews, and artifact spillover;
- bounded filesystem reads, deterministic directory listing, and strict unified-diff patching;
- managed Git repository stores and isolated Git worktrees;
- persistent interactive process sessions;
- persistent coding-agent orchestration through Herdr for supported harnesses such as Codex, Antigravity CLI, and Claude Code;
- CLI capability discovery and a read-only system maintenance audit;
- host-facing `skill_list`/`skill_read` access to the published dot-agents skill projection;
- opaque MCP artifact resources and host-native file/image presentation;
- upstream MCP bridging over stdio or Streamable HTTP, with tool filtering, prefixing, renaming, adapters, and call policies.

A clean checkout starts with **no upstream bridges enabled**. Playwright, LSP, browser takeover, tunnel integration, and coding harnesses are optional deployment features.

## Trust model

The supported model is deliberately simple:

> Give the agent a dedicated VM. The operator decides what that VM can reach; inside the VM, assume the agent can reach everything available to its Linux user.

`agent-vm-mcp` is **not** a sandbox, privilege boundary, multi-tenant isolation layer, or authorization broker between tools running inside the same VM. Path checks, ownership markers, bridge policies, Herdr workspace identity checks, and similar guards exist for orchestration correctness and accidental-cross-control prevention, not to protect secrets from a malicious process already running as the trusted VM user.

For the full security model, see [`SECURITY.md`](SECURITY.md).

## Quick start

Requirements:

- Node.js `24.20.0` or a compatible Node 24 release accepted by `package.json`;
- pnpm `11.25.0`.

Install and start the native core:

```bash
pnpm install --frozen-lockfile
pnpm start
```

The server communicates over stdio. With no machine-local configuration, the built-in bridge configuration is empty, so missing Playwright/LSP services do not prevent startup.

## Configuration

Machine-specific configuration belongs under:

```text
$XDG_CONFIG_HOME/agent-vm-mcp/
# or, when XDG_CONFIG_HOME is unset:
~/.config/agent-vm-mcp/
```

For file-based configuration, resolution is:

1. an explicit path supplied by the caller/runtime;
2. the corresponding environment-variable override;
3. the XDG machine-local file, when it exists;
4. the repository's built-in default under `config/`.

The main configuration files are:

| Purpose | XDG filename | Environment override |
| --- | --- | --- |
| MCP bridges | `bridges.json` | `MCP_BRIDGES_CONFIG` |
| CLI capabilities | `capabilities.json` | `AGENT_MCP_CAPABILITIES_CONFIG` |
| System audit | `system-audit.json` | `AGENT_MCP_SYSTEM_AUDIT_CONFIG` |
| Shared Playwright stdio proxy | `playwright-shared-proxy.json` | `PLAYWRIGHT_SHARED_PROXY_CONFIG` |

`AGENT_MCP_HOST` selects connection/deployment-specific host behavior. Supported values are `generic` (default) and `chatgpt`. Host-specific extensions are kept out of ordinary tool inputs; for example, ChatGPT file-input metadata is attached to `import_file` only when `AGENT_MCP_HOST=chatgpt`. The ChatGPT profile also enables the structured interaction adapter described below.

See [`config/README.md`](config/README.md) for bridge schema, fail-soft/fail-hard behavior, adapters, policies, capability discovery, system-audit configuration, and deployment examples.

## Bridge behavior

Every bridge is an optional integration. `enabled: true` means "attempt to connect and expose this integration at startup"; it does **not** make the upstream service a prerequisite for the native core.

The contract is:

> Invalid configuration fails startup. Unavailable integrations do not.

Examples of unavailable integrations include a missing stdio executable, connection refusal, an offline HTTP service, or an upstream handshake/tool-list failure. Those bridges are reported as `state: "unavailable"` by `mcp_bridge_status`, while other bridges and the native core continue.

Invalid JSON, unsupported config versions, duplicate bridge IDs, invalid adapter/policy configuration, unsupported transport definitions, and deterministic exported-tool collisions are startup errors. Partial bridge initialization is rolled back before the error escapes.

## MCP Skills (SEP-2640)

The canonical MCP-facing skill surface follows the [Final SEP-2640: Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640): the server declares the `io.modelcontextprotocol/skills` extension and exposes `skills/list`, `skills/get`, standard `resources/read`, and `resources/directory/read`. Skill identity is its URI, using `skill://<skill-name>` for a skill root and `skill://<skill-name>/<path>` for files and directories. Listings include complete parsed `SKILL.md` frontmatter and a digest/size manifest for every regular file; reads are lazy and bounded by the SEP limits.

The dot-agents projection is an internal publication snapshot, not a second protocol model. It is a version 1 directory containing `catalog.json` and `skills/<name>/...`; the catalog `source` must be `dot-agents`, and its tree hash is verified before content is served. Filesystem paths are never exposed.

The default projection root is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/dot-agents/skill-projection/v1/
```

Set `AGENT_MCP_SKILL_PROJECTION_ROOT` to use another projection root. The native `skill_list` and `skill_read` tools remain exposed as compatibility fallbacks for current ChatGPT behavior and delegate to the same validated registry where possible. They do not scan harness directories or infer or expose Codex system skills. Their optional `query` is a case-insensitive substring filter over skill names and descriptions; `skill_read` defaults to `SKILL.md` and reads bounded UTF-8 text from safe relative paths. Missing or invalid projections fail soft for this compatibility surface and do not prevent MCP startup. This repository has not verified that ChatGPT natively consumes SEP-2640, so no native-consumption support is claimed. Projection content is instructions/data, not executable capability.

## Structured user input

The interaction model is host-neutral. It currently supports single-select, multi-select, free-text, and boolean questions, with stable question/option IDs and optional recommendations. Select options can also set `allowCustomInput: true` (and optionally `customInputPlaceholder`) to require an inline free-form detail only when that option is selected; this works for both single- and multi-select questions without giving `other` any special protocol meaning. Host-specific rendering is implemented by adapters rather than encoded in the core request schema.

When `AGENT_MCP_HOST=chatgpt`, the server exposes `request_user_input` and binds it to an MCP Apps resource at `ui://agent-vm/request-user-input/v1.html`. The ChatGPT adapter uses the standard MCP Apps `ui/*` bridge and submits the completed form through `ui/message`, making the answers the next user turn. The tool result also contains a plain-text fallback, so the request remains understandable if the UI cannot render.
The ChatGPT view also persists draft and submitted form state in sandbox-local storage keyed by the immutable `interactionId`, so reopening the same interaction restores selections, text, custom option details, and submitted/read-only state. This is UI persistence only; the MCP server remains stateless, and hosts that deny sandbox storage still retain the normal in-memory behavior for the current mount.

The generic host does not expose `request_user_input` yet. Future hosts can register their own adapter against the same interaction model without adding host-specific fields to the public schema. The interaction tool itself is stateless: each call returns an immutable interaction ID and request payload, while the host carries the eventual user response in a later turn.

## Artifacts and host presentation

Artifacts use opaque process-local URIs such as:

```text
artifact://agent-vm/<id>
```

Artifact registration and user presentation are separate operations. Tool-generated artifacts such as oversized `exec` stdout/stderr are model/internal references by default: the tool result carries an opaque URI but does **not** attach a user-facing `resource_link`. The model can inspect text artifacts in bounded chunks with `read_artifact`; supported image artifacts can also be returned as standard MCP image content.

`present_file` explicitly registers and presents a VM file to the user. `present_artifact` explicitly presents an already-registered artifact. Those presentation tools return standard MCP `resource_link` content; small text files are additionally embedded as MCP resource content. Bridge adapters register output artifacts without automatically presenting file links, while image-producing adapters may attach standard MCP `image` content for same-turn model inspection.

Caller-owned files registered by `present_file` remain **live references**, not immutable snapshots. Their metadata describes the file when it was registered; a caller that mutates the underlying file later is changing what the live reference points to. Temporary spill files created by `exec` are artifact-store-owned and cleaned up on expiry or graceful shutdown.

Defaults:

- artifact TTL: 24 hours;
- maximum artifact read size: 50 MiB;
- `import_file` maximum download size: 256 MiB.

Override them with `AGENT_ARTIFACT_TTL_MS`, `AGENT_ARTIFACT_MAX_BYTES`, and `AGENT_FILE_IMPORT_MAX_BYTES`.

Both `read_file` and artifact resource reads enforce their source-size limit during I/O through one opened file descriptor rather than relying on a path-level `stat` followed by an unbounded `readFile`.

## Server and tool-catalog identity

`server_info` reports the identity of the **running MCP process**, including the package version, Git revision captured when that process started, dirty-tree state, host profile, PID, and start time. The revision is intentionally captured at server startup rather than read on every call, so a checkout that has been fast-forwarded before its old process is restarted cannot masquerade as the new deployment.

The same tool reports a deterministic SHA-256 identity for the active MCP action catalog. The hash covers the public tool definitions that matter to a host snapshot—name, title/description, input/output schemas, annotations, icons, execution metadata, and `_meta`—including connected bridge tools. Handler implementation changes alone do not change the catalog hash. `server_info` is excluded from its own hash to avoid self-reference.

The `server_info` tool description embeds the catalog marker that ChatGPT saw when it fetched that tool definition. Compare that embedded marker with `catalog.marker` returned by a live `server_info` call. If they differ, the running server and the host's frozen action snapshot disagree and the app actions should be refreshed. `catalog.toolNames` and the reported counts provide an additional sanity check.

## Workspaces and Git

`workspace_create` manages a shared bare repository store plus isolated Git worktrees. A workspace has its own working tree, index, and `HEAD`; objects, refs, tags, remotes, repository-level config, and stash remain shared within that repository store.

Defaults:

- repository store: `~/.local/share/agent-vm/repositories`;
- worktrees: `~/workspaces`.

Override them with `AGENT_REPOSITORY_ROOT` and `AGENT_WORKSPACE_ROOT`.

Workspace lifecycle does not install dependencies, trust repository toolchains, create task branches, commit/stash changes, start processes, or manage containers. Repository authentication stays with normal Git credential mechanisms. HTTP(S) clone URLs with embedded userinfo, query parameters, or fragments are rejected to reduce accidental credential persistence.

## Processes and coding agents

`process_*` tools manage generic interactive processes owned by the running MCP server. On graceful shutdown, managed process groups receive `SIGTERM` and are escalated to `SIGKILL` after a bounded grace period. These sessions are not persisted across server restarts.

Coding harnesses use a different lifecycle. `agent_start` launches supported harnesses through Herdr in dedicated Herdr workspaces. Production deployments can run Herdr as a separately managed service; `AGENT_HERDR_BOOTSTRAP=external` requires that arrangement, while `auto` allows development self-bootstrap.

Relevant settings include:

- `AGENT_HERDR_SESSION` — Herdr session name, default `agent-vm-mcp`;
- `AGENT_HERDR_BIN` — optional Herdr executable override;
- `AGENT_HERDR_BOOTSTRAP` — `auto` or `external`;
- `AGENT_STATE_DIR` — optional durable logical-agent metadata directory;
- `AGENT_CODEX_ENFORCED_MODEL` + `AGENT_CODEX_ENFORCED_EFFORT` — optional paired Codex launch policy. When both are set, omitted Codex overrides are filled with these values and any explicit mismatch is rejected; resume uses the same policy. `agent_capabilities` reports the effective policy.

`agent_prompt` distinguishes submission certainty from whether retrying the same task is useful. A definitely unsubmitted request reports `submission.state="not_submitted"` and `retrySafe=true`; once prompt submission may have begun, ambiguous timeout/cancellation/failure is treated as `possibly_submitted` and is not safe to auto-retry.

Workspace trust, authentication, command approval, and similar harness interactions are surfaced to the caller. The runtime does not silently approve them.

## Read-only maintenance audit

`system_audit` discovers installed tooling and reports update/health information without installing, fetching Git refs, restarting services, or otherwise mutating the VM.

For repositories, local ancestry is evaluated against the local tracking ref and reported as `in_sync`, `ahead`, `behind`, or `diverged` with counts. A live `git ls-remote` lookup, when requested, is reported separately as an observation of the current remote head; unequal hashes are not automatically labeled "behind".

Project dependency checks accept valid `pnpm outdated --format json` output even when pnpm exits non-zero, while a failed invocation with no usable JSON is surfaced as an audit error rather than an empty successful result.

## Optional Ubuntu deployment

The repository includes opinionated provisioning scripts for a dedicated Ubuntu VM. They are deployment helpers, not prerequisites for the portable native core.

The default deployment user is `agent`; set `AGENT_VM_USER` to use another existing user.

```bash
sudo ./scripts/provision-docker.sh
sudo ./scripts/provision-mise.sh
sudo ./scripts/provision-lsp.sh
sudo ./scripts/provision-browser-takeover.sh
```

The scripts currently provision or configure:

- Docker/Compose/Buildx;
- mise-managed Node, pnpm, and Herdr plus `agent-herdr.service`;
- a controlled read-only LSP integration under `/opt/language-server-mcp`;
- a pinned Playwright MCP + Chromium deployment under `/opt/playwright-mcp`, plus optional persistent browser/noVNC infrastructure and launchers.

`/opt/agent-vm-mcp` is the canonical deployment path for the optional systemd/browser takeover deployment. `scripts/provision-browser-takeover.sh` intentionally fails unless it is run from that checkout, because the installed shared-browser proxy launcher executes control-plane source from that stable path.

Tunnel software is **not** part of the core lifecycle. Example systemd drop-ins under `config/examples/systemd/` show how a separately managed tunnel service can depend on Herdr or browser services, but the MCP server and provisioners do not require an `agent-tunnel.service`.

For a complete illustrated setup, systemd, verification, and troubleshooting walkthrough, see [`docs/openai-secure-mcp-tunnel.md`](docs/openai-secure-mcp-tunnel.md).

A machine-specific Playwright/LSP bridge configuration is provided as `config/examples/bridges.playwright-lsp.json`; copy/adapt it into the XDG configuration directory rather than turning those integrations into source defaults.

### Browser takeover

The optional browser takeover setup uses a persistent Xvfb display plus loopback-only x11vnc/noVNC and a loopback-only shared Playwright MCP service. Tailscale, when provisioned, is intended only as stable reachability for ordinary OpenSSH; the VNC/noVNC listeners remain bound to loopback and can be reached through an SSH local forward.

Automation and human input to the shared browser should be treated as mutually exclusive at the orchestration level. There is no browser-takeover lease API in this version.

## Validation

Portable/core validation, suitable for GitHub-hosted Ubuntu CI:

```bash
pnpm test
```

This runs with no required external Playwright/LSP bridge services and verifies that the clean native core starts successfully.

Trusted Agent VM acceptance, including the configured live Playwright/LSP integrations:

```bash
pnpm smoke
```

Production dependency audit:

```bash
pnpm audit --prod
```

## License

ISC. See [`LICENSE`](LICENSE).
