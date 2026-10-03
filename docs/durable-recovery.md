# Durable recovery model

Long-running orchestration must not treat an MCP/tool response lifetime as the lifetime of the work it started. A lost response, client disconnect, or request timeout is an observation failure; it is not evidence that a command failed, succeeded, or never started.

## Failure domains

Keep these states separate:

1. **Operation failure** — the underlying command exits non-zero, is cancelled, times out, or cannot start.
2. **Observation failure** — the MCP/client loses a response while durable work may continue normally.
3. **Orchestration failure** — a scheduler, coding harness, quota, or other coordinator cannot continue work.
4. **Conversation failure** — the model/UI turn ends before it can report or reconcile current state.

The recovery APIs exist so (2) and (4) do not require replaying side-effecting work.

## Execution lifetimes

| Surface | Lifetime | Use for | Recovery |
| --- | --- | --- | --- |
| `exec` | MCP request | short finite commands | none; request loss may cancel/terminate work |
| `operation_*` | durable job service | finite commands that are long, side-effecting, or unsafe to duplicate | operation ID, idempotency key, persisted logs/state |
| `process_*` | MCP server process | interactive/service-like sessions | rediscoverable only while the same MCP server remains alive |
| `agent_*` | durable job service | bounded Codex/agy work | run ID, idempotency key, structured output |

Do not use `process_start` as a substitute for durable finite work. Process sessions are intentionally not persisted across MCP server restarts.

## Durable finite operations

`operation_start` accepts either a shell `command` or literal `argv`, plus an absolute `cwd`, optional environment overrides, timeout, category/label metadata, and an optional `idempotencyKey`.

All cwd-scoped recovery APIs use absolute paths so persisted identities never depend on the current directory of a daemon or later MCP process. Environment keys under the `AGENT_JOB_*` prefix are reserved for durable-worker ownership/lifecycle metadata and cannot be overridden by an operation.

The start request commits a durable record before the worker executes the command. The job service owns the worker independently from the initiating MCP request.

Use the returned `operationId` with:

- `operation_poll` for incremental stdout/stderr and state, using its opaque cursor;
- `operation_result` for the current/terminal persisted snapshot and log paths;
- `operation_list` to rediscover operations after an interrupted turn or restart;
- `operation_cancel` to request bounded termination.

### Safe retry after a lost start response

If a logical operation could be retried after a transport failure, always supply one stable idempotency key.

An identical retry with the same key returns the existing operation. Reusing the key for different inputs is rejected. Do **not** generate a new key merely because the first tool response was lost; a new key means a new execution.

This protects against the most dangerous ambiguity:

```text
client starts side-effecting command
        |
        v
job service persists + starts it
        |
        v
response is lost
        |
        +--> command may still be running or may already have finished
```

The correct next action is rediscovery/reconciliation, not replay.

## Status and side effects

The operation's `outcome` field makes command-level certainty explicit:

| Status | outcome.command | certainty | What it proves |
| --- | --- | --- | --- |
| `queued` | `pending` | known | command has not been released to execution yet |
| `running` | `pending` | known | command is active; side effects may already exist |
| `completed` | `succeeded` | known | command exited zero and the terminal record was persisted |
| `interrupted` | `unknown` | unknown | worker identity was lost before confirmed completion |
| `failed` / `cancelled` / `timed_out` | `not_succeeded` | known | zero-exit completion was not confirmed |

For every started state, external or partial side effects may have occurred. A non-success status does **not** prove that no Git push, HTTP request, file write, download, deployment step, or other side effect happened.

Generic durable operations deliberately do not guess command-specific external truth. After an uncertain or failed operation, reconcile the authoritative external system before issuing a new logical operation. Examples include remote Git refs, an existing pull request, a destination checksum, an API resource ID, or a CI run.

## Restart and worker-loss semantics

The MCP process, `agent-jobd`, and detached workers have separate lifetimes.

- Restarting the MCP server does not cancel durable operations.
- Restarting `agent-jobd` reattaches to workers that still match their Linux PID/start-time identity.
- A lost worker is marked `interrupted`; it is never silently replayed.
- Orphan cleanup targets only independently verified job-owned processes and fails closed when ownership cannot be proven.
- SQLite state and stdout/stderr logs remain available after terminal completion and service restart.

These rules prefer an explicit uncertain result over accidental duplicate execution.

## Workflow checkpoints

Durable operations solve execution recovery; they do not answer the higher-level question "what step was the conversation trying to do next?"

`work_checkpoint_*` provides small durable records scoped by exact `cwd` and a stable key. A checkpoint can hold data such as:

```json
{
  "goal": "finish pre-release verification",
  "currentStep": "browser contract",
  "completed": ["unit tests", "package smoke"],
  "activeOperations": ["<operation-id>"],
  "next": "inspect terminal result, then review diff"
}
```

Checkpoint data is **intent/state for orchestration**, not evidence that an external effect occurred. Recovery should read the checkpoint, rediscover referenced durable work, and reconcile actual execution state before advancing it.

`work_checkpoint_put` supports optimistic concurrency with `expectedRevision`:

- omit it for an unconditional write;
- pass `null` for create-only;
- pass the last observed SHA-256 revision to update only if the checkpoint has not changed.

Stale updates are rejected with `CHECKPOINT_CONFLICT` and the current revision in error details.

Read-only `get/list` calls do not create checkpoint storage when none exists.

## Unified recovery snapshot

`work_status` is the first recovery call when a conversation or tool sequence ends unexpectedly. With a `cwd`, it reports:

- durable coding-agent jobs;
- durable command operations;
- current MCP-owned process sessions;
- workflow checkpoints;
- Git HEAD/branch/dirty evidence;
- bounded filesystem activity.

It reports observable evidence only. It does not claim that the ChatGPT UI is stuck, that a quiet process is dead, or that a checkpoint proves completion.

`work_status` is fail-soft across its evidence sources. If the durable job service or checkpoint store is unavailable/corrupt, the remaining Git/filesystem/process evidence is still returned; `backgroundJobService` and `checkpointStore` expose the corresponding source error instead of turning the whole recovery snapshot into a failure.

A robust recovery sequence is:

1. call `work_status` for the workspace;
2. inspect existing operation/run IDs before starting anything new;
3. poll/result any active durable work;
4. if state is uncertain, reconcile the relevant external authority;
5. update the workflow checkpoint;
6. only then start the next logical operation.

## Design invariant

The central invariant is:

> Transport failure must never imply operation failure, and recovery must never require blind replay of side-effecting work.

Durable identity, idempotent start, persisted completion evidence, and explicit workflow checkpoints make interrupted orchestration resumable without coupling the mechanism to Git, tests, downloads, CI, deployments, or any other particular task type.
