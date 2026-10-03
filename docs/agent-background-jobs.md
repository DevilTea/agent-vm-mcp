# Durable agent jobs — V1 operator guide

V1 moves long Codex and agy work into `agent-jobd`, a separate systemd-managed VM service. The chat-facing MCP process is only a control plane. Neither a long-lived tool request nor ChatGPT continuing to generate is required for a job to finish.

The same durable scheduler and SQLite store also back generic finite `operation_*` commands. This guide remains focused on coding-agent policy; see [`durable-recovery.md`](durable-recovery.md) for generic lost-response recovery, operation semantics, and workflow checkpoints.

## Architecture and acceptance

- The manager listens on a private mode-0600 Unix socket at `~/.local/state/agent-vm-mcp/jobs/jobd.sock`; its parent is mode 0700.
- SQLite (WAL) durably stores queued/running/terminal metadata and idempotency keys. Each job writes `stdout.log`, `stderr.log`, `events.jsonl`, `invalid.jsonl` and `worker.log` in a per-run mode-0700 directory. Read full logs on the VM; `agent_result` returns only bounded tail previews.
- The manager spawns each worker into its own detached process group. The systemd unit uses `KillMode=process`, so restarting the manager **does not terminate the worker group**. Worker process identity includes the Linux boot ID and process start ticks, avoiding PID reuse after restarts.
- On manager restart, live workers keep executing. Dead workers formerly marked running are marked `interrupted` (or `cancelled`/`timed_out` if that was already recorded). Queued work starts when capacity is available; an interrupted previously-running job is **not** automatically retried.
- Default concurrency is 2 independent jobs (`AGENT_JOB_MAX_CONCURRENT=2`, allowed range 1–8), two-hour per-job deadline (`timeoutMs`), maximum eight hours. A quiet worker remains active while its process is alive and inside its deadline. Queue wait is not counted toward the deadline.
- Existing `agent_run` remains the short blocking compatibility path. `process_*` tools remain in-process and **are not** made persistent by this feature.
- V1 does not do group scheduling, reviewer synthesis, task dependencies, automatic completion notifications or automatic retries.

### agy background permission and completion policy

For V1 durable background jobs only, the worker invokes agy in non-interactive `-p` stream-JSON mode with `--dangerously-skip-permissions`. This is scoped to the durable worker; it does not change interactive agy defaults or the short blocking `agent_run` path.

This flag does not sandbox the VM account. The agent account's existing privileges remain available, including access to paths outside the requested worktree. Treat the worktree and task as trusted input, and review the full logs and artifacts accordingly.

An agy job is marked `completed` only when it exits successfully and emits a terminal JSONL `event:"result"` with `result.status:"SUCCESS"` and no denied actions (agy may omit `result.denied_actions` entirely, or return an empty array). A present non-array value remains `ambiguous`. A structured success is evidence that the CLI reported success, not proof that the task is correct; verify the requested files, tests, and other task-specific evidence independently. Missing or malformed terminal results stay `ambiguous`, and terminal errors or denied actions are failures.

## Deployment on Ubuntu

Deploy this repository to the stable runtime checkout at `/opt/agent-vm-mcp` and install production dependencies. The provisioner requires root and an already deployed source directory:

```bash
cd /opt/agent-vm-mcp
pnpm install --frozen-lockfile
pnpm test
sudo ./scripts/provision-agent-jobs.sh
sudo systemctl status agent-jobd.service --no-pager
```

The provisioner renders `config/systemd/agent-jobd.service.template` with the installed non-root Agent VM user, pinned Node binary and runtime path, then enables the system service. It adds a `Wants`/`After` drop-in for an existing optional `agent-tunnel.service`; tunnel startup is still allowed if the manager becomes temporarily unavailable.

Check `/etc/systemd/system/agent-jobd.service` and align `AGENT_CODEX_ENFORCED_MODEL` / `AGENT_CODEX_ENFORCED_EFFORT` deliberately with your MCP deployment policy. **Changing dot-agents defaults does not override a fixed MCP/manager policy.**

After service health and isolated tests pass, restart the optional tunnel once, then refresh ChatGPT's Agent VM app actions: the new tool catalog includes `agent_list` and changed `agent_start` inputs. A previously frozen tool snapshot must not be used after a catalog-changing deployment.

## Calling from ChatGPT

Start individual work in independent read-only Git worktrees pinned to the same review commit. Always supply a stable unique `idempotencyKey` if you might retry a submission:

```json
{
  "harness": "codex",
  "cwd": "/home/agent/workspaces/review-pr-17",
  "task": "Review the pinned commit; write structured findings to REVIEW.md. Do not modify product code.",
  "timeoutMs": 7200000,
  "idempotencyKey": "widget-pr17-commitSHA-codex-security-v1"
}
```

`agent_start` returns `accepted` plus a persistent `runId`. `status` is `queued` or `running`; neither implies that the work is finished. Queued summaries include capacity/position diagnostics. Use `agent_list({cwd})` to recover IDs later, and call `agent_poll({runId})` once to obtain an opaque `cursor`; pass that cursor back on later polls for bounded incremental stdout/stderr/JSONL output. The older per-stream offsets remain supported for compatibility but cannot be combined with `cursor`. Use `agent_result({runId})` for terminal status and log paths, or `agent_cancel({runId})` when needed. A completed process still needs actual review of its output.

A caller can submit separate reviewer jobs without waiting for each to finish. The manager enforces aggregate VM concurrency. V1 deliberately leaves coordination and cross-review synthesis to the caller.

## Operations and recovery

```bash
sudo systemctl is-active agent-jobd.service
sudo journalctl -u agent-jobd.service -n 100 --no-pager
sudo systemctl restart agent-jobd.service   # live workers continue
ls -la ~/.local/state/agent-vm-mcp/jobs/
```

If `agent_start` returns a transport error, inspect service health and retry **with the same idempotency key**: the previous request may already have committed. If the manager is down, legacy `agent_run` still works as a short synchronous compatibility path, but never use raw `exec`/`process_start` to bypass coding-agent lifecycle controls.

Do not remove the jobs state directory or SQLite WAL files while the manager/workers are active. Back up the entire directory (ideally after clean shutdown, or use SQLite's online backup API for its database) if long-term result retention is needed. Disk usage and completed-job retention are operator-managed in V1; review them periodically.

When a host returns a catalog snapshot mismatch, **stop using that MCP connection** and refresh the app actions after the tunnel restart. Running VM jobs remain independent and can be recovered after reconnecting.
