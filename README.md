# agent-vm-mcp

MCP server for controlling a dedicated Linux agent VM and forwarding tools from pluggable upstream MCP servers.

> [!WARNING]
> This server intentionally exposes arbitrary command execution and persistent process control. Treat access to it as equivalent to shell access to the VM and do not expose it to untrusted clients.

## Features

- Execute finite shell commands with bounded head/tail previews, oversized stdout/stderr artifacts, timeouts, and MCP-request cancellation.
- Read/list files structurally and apply strict unified diffs without fuzzy fallback.
- Create, rediscover, and explicitly remove isolated Git worktree workspaces backed by shared repository storage.
- Start, rediscover, read, write to, and terminate persistent/interactive processes.
- Orchestrate persistent coding-agent sessions through Herdr, including Codex, Antigravity CLI, and Claude Code when installed.
- Discover curated CLI capabilities available on the VM.
- Audit VM tool/update coverage, service health, repository freshness, APT updates, and project dependency drift with `system_audit`.
- Bridge tools from upstream MCP servers over stdio or Streamable HTTP.
- Filter, prefix, and rename bridged tools while rejecting name collisions.
- Forward Playwright MCP tools through the same MCP endpoint.
- Run the persistent Playwright browser on a private virtual display that can be viewed through an SSH-forwarded, loopback-only noVNC path.
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
- `agent_capabilities`
- `agent_start`
- `agent_get`
- `agent_read`
- `agent_prompt`
- `agent_send_keys`
- `agent_suspend`
- `agent_resume`
- `agent_stop`
- `import_file`
- `command_info`
- `system_audit`
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

- Node.js 24.20.0
- pnpm 11.25.0
- Herdr 0.8.2

The dedicated Agent VM provisions these through `mise`; repository-local mise configuration may override the fallback versions only after explicit trust. Coding harnesses are optional runtime dependencies: `agent_start` currently supports Codex (`codex`), Antigravity CLI (`agy`), and Claude Code (`claude`) when the corresponding executable is installed.

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

The mise provisioner installs mise through the Ubuntu-supported PPA path, installs the exact Agent VM fallback versions (Node `24.20.0`, pnpm `11.25.0`, Herdr `0.8.2`), configures non-interactive shims, and migrates the systemd/tunnel/Playwright launch paths away from the legacy pnpm-managed Node executable. It does **not** restart `agent-tunnel.service` because doing so terminates the active MCP connection. Restart and validate the service separately, then remove the old pnpm-managed executable/global Node environment with:

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

Provision browser human takeover after Playwright MCP and mise are installed:

```bash
sudo ./scripts/provision-browser-takeover.sh
```

The browser takeover provisioner installs a persistent `Xvfb` display, loopback-only `x11vnc` and noVNC/websockify services, Tailscale, a loopback-only shared Playwright MCP service, and separate launchers for a fresh browser and a shared-browser stdio transport proxy. The shared service uses the existing persistent profile, runs headed on `DISPLAY=:99`, listens only on `127.0.0.1:8931`, and enables Playwright MCP's shared browser context so multiple MCP clients can intentionally operate the same logged-in browser state. The fresh launcher uses `--isolated --headless` without a user-data directory, so each stdio client gets a clean disposable browser state. The stdio proxy opens no browser of its own; it forwards tools to the shared service over Streamable HTTP for harnesses whose remote MCP client cannot speak that transport directly. The provisioner starts the display/VNC/noVNC services and `tailscaled`, but only **enables** `agent-playwright-shared.service`; it deliberately does not start that service or restart `agent-tunnel.service`, so provisioning cannot steal the persistent profile from an already-running tunnel-owned Playwright process. Activate the new topology only during an idle window by restarting the tunnel after provisioning.

Tailscale is only a stable reachability layer for ordinary OpenSSH. Do not expose VNC/noVNC with `tailscale serve`, Tailscale SSH, a tailnet listener, a LAN listener, or a public listener. Enroll the VM separately as the operator, then create a normal SSH local forward from the machine where the browser will be viewed:

```bash
ssh -L 6080:127.0.0.1:6080 agent@<tailscale-host>
```

With that SSH session open, browse to `http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale`. `x11vnc` listens only on `127.0.0.1:5900`, websockify listens only on `127.0.0.1:6080`, and X TCP listening is disabled. Browser takeover v1 is intentionally IPv4-loopback-only; IPv6 access is unsupported. The noVNC view is the same virtual display containing the Playwright-controlled Chromium instance; it is not a second browser/profile.

Human and automation input are mutually exclusive by contract. Stop issuing `browser_*` interactions while the operator is controlling the noVNC session, then resume automation only after the operator has finished. v1 intentionally has no takeover lock/lease MCP API.

## Run

```bash
pnpm start
```

The server communicates over stdio.

## Configuration

- `config/capabilities.json` defines the curated CLI catalog exposed to agents.
- `config/system-audit.json` defines special update sources, important command-based installations, services, repositories, and projects for the read-only `system_audit` tool.
- `config/bridges.json` defines upstream MCP servers and forwarded tools.
- `AGENT_HERDR_SESSION` selects the persistent Herdr session name used by the native agent runtime (default `agent-vm-mcp`).
- `AGENT_HERDR_BIN` optionally overrides the Herdr executable, primarily for controlled deployment/testing. Bare names resolve through `PATH`; absolute or relative path overrides must resolve to an executable regular file.
- `AGENT_HERDR_BOOTSTRAP` controls session bootstrap: `external` requires a separately managed Herdr service and never spawns it from MCP, while `auto` allows development self-bootstrap (default).
- `AGENT_STATE_DIR` optionally overrides the directory for durable logical-agent metadata (`agents.json`); otherwise `$XDG_STATE_HOME/agent-vm-mcp` or `~/.local/state/agent-vm-mcp` is used.

See [`config/README.md`](config/README.md) for bridge configuration, environment forwarding, and capability discovery details.

`system_audit` is intentionally discovery-first rather than a fixed checklist. It automatically inventories every installed mise tool, global npm package, curated CLI, and executable found in the configured VM-local binary directories. npm and mise entries get inferred latest-version sources automatically. System-path curated commands are treated as APT-managed. A newly discovered custom tool with no safe inferred/configured latest source is never dropped: it appears in `coverage.untracked` until a mapping is added to `config/system-audit.json`. This makes audit coverage degrade visibly instead of silently as the VM grows.

The default bridge configuration connects to the shared Playwright MCP service at `http://localhost:8931/mcp`; the service itself binds only to `127.0.0.1`. Its `browser_take_screenshot` tool is adapted into the generic artifact channel. `/opt/playwright-mcp/start-isolated.sh` remains available for coding harnesses that need a fresh browser without the persistent profile. Adjust `config/bridges.json` for other deployments.

Codex/Agy browser MCP registrations on the dedicated Agent VM are machine-local runtime configuration, not portable dot-agents canonical configuration. Do not add these endpoints to `dot-agents/harnesses/*`. Codex MCP entries may live directly in `~/.codex/config.toml` or, preferably on this VM, in the non-Git `~/.config/dot-agents/overrides/codex.toml`; dot-agents only patches its managed TOML keys and preserves unrelated MCP entries. Antigravity's `~/.gemini/config/mcp_config.json` is outside the dot-agents managed settings surface and is likewise VM-local. Existing harness processes are not restarted when these files are prepared; new sessions pick up the configuration after it is materialized.

Artifact resources are opaque, process-local references with a 24-hour default TTL and a 50 MiB default size limit. Override these with `AGENT_ARTIFACT_TTL_MS` and `AGENT_ARTIFACT_MAX_BYTES`. Files registered by callers such as `present_file` remain caller-owned; temporary spill files created by `exec` are artifact-store-owned and are removed on expiry or graceful server shutdown.

Finite `exec` keeps stdout and stderr separate. Streams up to 128 KiB remain inline unchanged; larger streams return a 64 KiB head + 64 KiB tail preview, exact observed-byte counts, and a separate opaque artifact per oversized stream. The artifact contains the complete stream while it fits within `AGENT_ARTIFACT_MAX_BYTES`; if the stream exceeds that hard bound, artifact metadata explicitly reports truncation while the inline preview still preserves the true final 64 KiB. Cancelled requests discard any unpublished spill file rather than leaving an unreachable artifact behind. Persistent `process_*` output keeps its independent bounded ring-buffer semantics.

ChatGPT-hosted files can be imported into the VM with `import_file`; file bytes are streamed from the host-provided short-lived URL rather than passed through model context. Imports are limited to 256 MiB by default; override with `AGENT_FILE_IMPORT_MAX_BYTES`. Downloads are written to a same-directory temporary file and only committed after successful completion, so cancellation does not leave a partial destination.

`read_file` and `list_directory` are intentionally bounded, non-search filesystem primitives for high-frequency coding reads. `apply_patch` uses strict `git apply` validation and apply passes: it does not enable recounting, 3-way merge, rejected-hunk files, unsafe paths, whitespace-insensitive context matching, or fuzzy fallback. Applicability failures are zero-write; this is not a claim of cross-file crash-atomic filesystem transactions. Patch validation honors MCP cancellation, while the mutation phase is allowed to finish once launched and is awaited during graceful server shutdown.

Managed workspaces use shared bare Git repository stores plus isolated Git worktrees. `workspace_create` creates a detached worktree for both default and explicit revisions, returning an immutable server-generated workspace ID and a path that existing tools can use as `cwd`. `workspace_list` reconstructs state from the managed filesystem layout and Git worktree metadata rather than an MCP-local registry. `workspace_delete` refuses dirty worktrees unless `force: true` is explicit and never implicitly removes branches, repository caches, processes, or containers.

The default managed roots are `~/.local/share/agent-vm/repositories` for shared bare repositories and `~/workspaces` for worktrees. Deployments/tests may override them with `AGENT_REPOSITORY_ROOT` and `AGENT_WORKSPACE_ROOT`. Repository authentication stays with normal Git mechanisms such as `gh auth git-credential` or SSH; HTTP(S) clone URLs containing embedded userinfo, query parameters, or fragments are rejected so credentials are not persisted in repository config. `workspace_list` also redacts those URL components if an origin is later changed out-of-band.

Git worktrees are **working-tree isolation, not full-clone isolation**. Each workspace has its own working tree, index, and `HEAD`, while objects, refs/branches, tags, remotes, repository-level config, and stash remain shared within the repository store. Lifecycle operations are serialized per repository; Git remains authoritative for branch/worktree locking and out-of-band shell operations.

Workspace creation owns repository bootstrap/fetch and worktree creation only. It does not install dependencies, create task branches, commit/stash changes, start processes, manage containers, or bootstrap projects. Creation cancellation cleans pre-commit partial work; once destructive `workspace_delete` removal begins, request cancellation no longer interrupts that mutation and graceful server shutdown waits for it to finish.

Process sessions created by `process_start` are in-memory resources owned by the running `agent-vm-mcp` process. Use `process_list` to rediscover them across MCP client or conversation changes. On graceful server shutdown, running managed process groups receive `SIGTERM` and are escalated to `SIGKILL` after a bounded grace period. Command cancellation uses the same process-group strategy and falls back to killing the direct child if the original process group no longer exists. A descendant that intentionally creates a new session/process group can escape that PGID; hard containment of such detached descendants belongs to the deployment supervisor/cgroup. Sessions are not recoverable across server restarts; abnormal-exit cleanup belongs to the deployment supervisor/cgroup rather than a persisted PID/PGID registry.


The native coding-agent runtime is deliberately different from `process_*`. It uses one named persistent Herdr server session (default `agent-vm-mcp`) and creates one dedicated Herdr workspace per MCP-managed coding agent. Production uses the repo-managed `agent-herdr.service`, outside the `agent-tunnel.service` cgroup, and the tunnel drop-in sets `AGENT_HERDR_BOOTSTRAP=external`; therefore MCP reconnects or tunnel-service restarts do not own or terminate Herdr. Development defaults to `AGENT_HERDR_BOOTSTRAP=auto`, which may self-bootstrap a missing Herdr session. `agent_start` creates a workspace rooted at the requested `cwd`, launches the selected harness in the workspace root pane, and returns a logical `agent-` ID. Durable metadata at `$XDG_STATE_HOME/agent-vm-mcp/agents.json` (or `$AGENT_STATE_DIR/agents.json` when configured) separates that logical ID and native harness session ID from the ephemeral `runtimeAgentId` and workspace ID. Native session continuity is recorded only when the backend reports an ID or a launch-time before/after snapshot produces exactly one new same-cwd session; ambiguous or unavailable attribution is never guessed. Failed/ambiguous workspace creation is compensated by polling for the generated label for a bounded five-second discovery window and closing any observed workspace; a server-side mutation that appears after that window remains a best-effort cleanup limitation. An agent is considered MCP-managed only when its Herdr workspace label exactly equals its runtime agent ID and the workspace IDs match; no MCP-local ownership registry is required. Operations re-check that marker around reads/state inspection and immediately before mutations where practical. Herdr 0.8.2 does not expose an atomic conditional `label + workspace_id + mutation` primitive, so the final ownership check and `send-keys`/workspace close are not transactional. This is an accidental-cross-control guard inside the shared session, not a security boundary against another process running as the same Linux user, which can access the same Herdr socket directly. `agent_stop` explicitly closes only the target agent's dedicated Herdr workspace and discards its logical metadata.

Keep the Herdr runtime alive while a task is active. At a clear task/turn boundary, use `agent_suspend` only after the runtime is `idle` or `done`; it closes the dedicated workspace/process but retains the native session for continuation. Use `agent_resume` to create a fresh runtime and continue that exact native session, and use `agent_capabilities` to discover suspended logical agents. If the MCP process stops during a suspend/resume transition, the next inspection reconciles the durable transitional record against exact Herdr runtime/workspace ownership; ambiguous snapshots remain transitional and are not claimed as active. Use `agent_start` for independent work and `agent_stop` when the logical session is truly abandoned. The bridge currently verifies native resume for Codex with `codex resume <SESSION_ID>` and Agy with `agy --conversation <CONVERSATION_ID>`. Claude Code is declared for start/model discovery, but suspend/resume is rejected until a safe native resume command is verified for the installed CLI.

Coding harnesses are an explicit exception to the generic shell-process tools: agent work using Codex, Antigravity CLI (`agy`), or Claude Code must be started with `agent_start`, especially for long-running, parallel, or cross-turn work. Do not background these harnesses through `exec` or run them through `process_start`; those lifecycles are owned by the MCP process/request model rather than the separately supervised Herdr service. The server rejects common direct or simply wrapped raw harness launches through `exec` / `process_start` while still allowing harmless metadata probes such as `--help` and `--version`. This rejection is an orchestration guardrail, not a shell security boundary: arbitrary Bash can encode indirect execution in ways a lightweight detector cannot safely classify, so callers must still follow the `agent_start` contract rather than treating parser evasion as supported behavior.

`agent_capabilities` is read-only: it reports Herdr availability/version/session state, installed supported harnesses, active and suspended logical agents, runtime/native IDs, lifecycle state, resumable/legacy status, and the installed skill names visible to each harness. It also reports per-harness native resume support and syntax. Agents created before durable metadata existed remain usable for get/read/prompt/stop, but are reported as active legacy non-resumable agents; `agent_suspend` rejects them rather than inferring a native session, so restart/recreate them under the new runtime to gain suspend/resume. Skills are discovered from the harness-native deployment roots (`~/.agents/skills` for Codex, `~/.gemini/antigravity-cli/skills` for Antigravity CLI, and `~/.claude/skills` for Claude Code). `agent_prompt.skills` validates requested names against the selected harness before submission, then tells the harness to read and follow those installed `SKILL.md` files; the MCP server does not copy skill bodies into tool arguments or silently choose skills on the caller's behalf.

Workspace trust, login, permission, command-approval, and other interactive gates are never auto-approved by the runtime. Detected gates are exposed as `interaction.requiresDecision=true`: this means the orchestration layer must make a policy decision, **not** that every harness prompt automatically requires a human. The MCP runtime supplies decision context and conservative `riskHints`; for recognized command approvals it also exposes the visible command and marks `readOnly=true` / `workspaceMutation=false` only for a narrow set of confidently read-only inspection forms. Unknown or compound-risk cases remain `null`, and all hints are advisory rather than authorization. The orchestrator is responsible for applying the caller's delegation policy—for example, it may decide low-risk/read-only actions autonomously when permitted while escalating destructive, trust-expanding, authentication/secret, production-impacting, or otherwise high-risk actions. Before `agent_prompt` types a task, the runtime requires a readable visible terminal, `interactive_ready=true`, and a settled Herdr state (`idle` or `done`), in addition to checking known interaction/transient gates. Preflight rejection returns `submission.state=not_submitted`. Failure to start the Herdr prompt process is also definitely `not_submitted` and retry-safe. Once the Herdr prompt process has started, timeout/cancellation/nonzero or otherwise ambiguous completion is treated as `possibly_submitted` with `retrySafe=false`, because `agent prompt --wait` submits before it waits; callers must inspect the returned diagnostics instead of automatically retrying and duplicating work. `agent_send_keys` is intentionally limited to bounded navigation/control keys (`enter`, `esc`, arrows, `tab`, `backspace`); the orchestrator should use it only after its policy decision authorizes the specific visible interaction. Arbitrary task text must go through `agent_prompt`. Herdr lifecycle state is useful orchestration metadata, not proof that the requested engineering work succeeded: callers should still inspect the transcript and verify repository/tests/artifacts as appropriate.

Optional model/effort overrides are translated by the harness adapter. Codex accepts model plus `low|medium|high|xhigh|max|ultra`; Antigravity CLI accepts model plus `low|medium|high`; Claude Code currently accepts a model override but this MCP version intentionally does not expose an unverified Claude effort override. Omitting overrides leaves each harness's synchronized user defaults in effect.

## Validation

Run the smoke test:

```bash
pnpm smoke
```

The smoke test starts the server with a Playwright bridge stub and validates the native and forwarded tool surface.
