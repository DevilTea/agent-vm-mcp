import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_SESSION_NAME = 'agent-vm-mcp';
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const WORKSPACE_CLEANUP_DISCOVERY_MS = 5_000;
const METADATA_LOCK_TIMEOUT_MS = 5_000;
const METADATA_LOCK_STALE_MS = 10_000;
const NATIVE_LAUNCH_LOCK_TIMEOUT_MS = DEFAULT_START_TIMEOUT_MS + 5_000;
const NATIVE_LAUNCH_LOCK_STALE_MS = DEFAULT_START_TIMEOUT_MS + 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_AGENT_READ_LINES = 1_000;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID_PATTERN = /^agent-[0-9a-f]{26}$/;
const READY_STATUSES = new Set(['idle', 'done']);
const BOOTSTRAP_MODES = new Set(['auto', 'external']);
const AGENT_METADATA_VERSION = 2;
const PROMPT_COMPLETION_VERSION = 1;
const PROMPT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROMPT_COMPLETION_STATES = new Set(['in_flight', 'completed', 'uncertain']);
const TERMINAL_METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TERMINAL_METADATA_RECORDS = 100;
const TERMINAL_METADATA_LIFECYCLES = new Set(['orphaned', 'quarantined']);
const LIFECYCLE_STATES = new Set(['active', 'starting', 'suspending', 'suspended', 'resuming', 'stopping', 'orphaned', 'quarantined']);
const CODEX_SUPPORTED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CODEX_POLICY = Object.freeze({ model: 'gpt-5.6-luna', effort: 'max' });
const CODEX_PROVENANCE_VERSION = 1;
const CODEX_PROFILE_PREFIX = 'agent-vm-mcp-';
const CODEX_PROFILE_SUFFIX = '.config.toml';
const CODEX_MANAGED_DEVELOPER_INSTRUCTIONS =
  'This is an agent-vm-mcp-managed Codex session. Every downstream Codex delegation, including x-review, must use model gpt-5.6-luna with reasoning effort max. This is the managed session policy and overrides model-routing defaults that would select Terra, Sol, or another effort. If a delegation API accepts model or reasoning_effort, pass gpt-5.6-luna and max explicitly.';

let sessionBootstrapPromise = null;
const promptOperations = new Map();
const promptAgentsInFlight = new Set();
const lifecycleLocks = new Map();

function homeDirectory() {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is required for agent runtime management.');
  return home;
}

function configuredHerdrExecutable() {
  return process.env.AGENT_HERDR_BIN || 'herdr';
}

function herdrBootstrapMode() {
  const mode = process.env.AGENT_HERDR_BOOTSTRAP || 'auto';
  if (!BOOTSTRAP_MODES.has(mode)) {
    throw new Error('AGENT_HERDR_BOOTSTRAP must be either auto or external.');
  }
  return mode;
}

function herdrSessionName() {
  const name = process.env.AGENT_HERDR_SESSION || DEFAULT_SESSION_NAME;
  if (!SESSION_NAME_PATTERN.test(name)) {
    throw new Error('AGENT_HERDR_SESSION must contain only letters, numbers, dot, underscore, or hyphen.');
  }
  return name;
}

function codexLaunchPolicy() {
  return {
    enforced: true,
    scope: 'mcp-managed-agent_start-agent_resume',
    model: CODEX_POLICY.model,
    effort: CODEX_POLICY.effort,
    downstream: {
      model: CODEX_POLICY.model,
      effort: CODEX_POLICY.effort,
      enforcement: 'profile-defaults-and-managed-developer-instructions',
      immutable: false,
      residualLimitation:
        'Codex CLI 0.153.2 has no immutable deny-override primitive for subagent model or reasoning effort; an explicit in-session subagent override can still bypass these defaults.',
    },
  };
}

function applyHarnessLaunchPolicy({ harness, model, effort }) {
  if (harness !== 'codex') return { model, effort };
  const policy = codexLaunchPolicy();

  if (model !== undefined && model !== policy.model) {
    const error = new Error(
      `Codex launch policy requires model ${policy.model}; requested model ${model} is forbidden on this deployment.`,
    );
    error.code = 'agent_launch_policy_violation';
    throw error;
  }
  if (effort !== undefined && effort !== policy.effort) {
    const error = new Error(
      `Codex launch policy requires effort ${policy.effort}; requested effort ${effort} is forbidden on this deployment.`,
    );
    error.code = 'agent_launch_policy_violation';
    throw error;
  }

  return { model: policy.model, effort: policy.effort };
}

function harnessDefinitions() {
  const home = homeDirectory();
  return {
    codex: {
      command: 'codex',
      skillRoot: path.join(home, '.agents', 'skills'),
      resume: {
        supported: true,
        syntax: 'codex resume <SESSION_ID>',
      },
      supportsModel: true,
      supportsEffort: true,
      startupGraceMs: 0,
      supportedEfforts: CODEX_SUPPORTED_EFFORTS,
      buildArgs({ model, effort, profile }) {
        const args = [];
        if (model) args.push('--model', model);
        if (effort) args.push('--config', `model_reasoning_effort=${JSON.stringify(effort)}`);
        if (profile) args.push('--profile', profile);
        return args;
      },
      buildResumeArgs({ nativeSessionId, model, effort, profile }) {
        return ['resume', nativeSessionId, ...this.buildArgs({ model, effort, profile })];
      },
    },
    agy: {
      command: 'agy',
      skillRoot: path.join(home, '.gemini', 'antigravity-cli', 'skills'),
      resume: {
        supported: true,
        syntax: 'agy --conversation <CONVERSATION_ID>',
      },
      supportsModel: true,
      supportsEffort: true,
      startupGraceMs: 2_000,
      supportedEfforts: ['low', 'medium', 'high'],
      buildArgs({ model, effort }) {
        const args = [];
        if (model) args.push('--model', model);
        if (effort) args.push('--effort', effort);
        return args;
      },
      buildResumeArgs({ nativeSessionId, model, effort }) {
        return ['--conversation', nativeSessionId, ...this.buildArgs({ model, effort })];
      },
    },
    claude: {
      command: 'claude',
      skillRoot: path.join(home, '.claude', 'skills'),
      resume: {
        supported: false,
        reason: 'Claude Code is declared but no safely verified native resume syntax is available in this deployment.',
      },
      supportsModel: true,
      supportsEffort: false,
      startupGraceMs: 0,
      supportedEfforts: [],
      buildArgs({ model, effort }) {
        if (effort) throw new Error('Claude effort overrides are not supported by agent-vm-mcp yet.');
        return model ? ['--model', model] : [];
      },
      buildResumeArgs() {
        throw new Error('Claude Code native resume is not safely verified; suspend is unavailable for Claude agents.');
      },
    },
  };
}

function metadataDirectory() {
  return process.env.AGENT_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(homeDirectory(), '.local', 'state'), 'agent-vm-mcp');
}

function metadataPath() {
  return path.join(metadataDirectory(), 'agents.json');
}

async function readAgentMetadata() {
  try {
    const text = await fs.readFile(metadataPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || ![1, AGENT_METADATA_VERSION].includes(parsed.version) || !parsed.agents || typeof parsed.agents !== 'object') {
      throw new Error('Agent metadata has an unsupported format.');
    }
    for (const record of Object.values(parsed.agents)) {
      if (!record?.agentId || !LIFECYCLE_STATES.has(record.lifecycle)) {
        throw new Error('Agent metadata contains an invalid logical-agent record.');
      }
    }
    if (parsed.completions !== undefined && (!parsed.completions || typeof parsed.completions !== 'object' || Array.isArray(parsed.completions))) {
      throw new Error('Agent metadata contains an invalid prompt completion store.');
    }
    for (const [requestId, record] of Object.entries(parsed.completions ?? {})) {
      if (
        requestId !== record?.requestId ||
        !record?.requestId ||
        !PROMPT_REQUEST_ID_PATTERN.test(record.requestId) ||
        !PROMPT_COMPLETION_STATES.has(record.state) ||
        typeof record.agentId !== 'string' ||
        record.agentId.length === 0
      ) {
        throw new Error('Agent metadata contains an invalid prompt completion record.');
      }
    }
    return { ...parsed, version: AGENT_METADATA_VERSION, completions: parsed.completions ?? {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: AGENT_METADATA_VERSION, agents: {}, completions: {} };
    const wrapped = new Error(`Unable to read durable agent metadata: ${error.message}`);
    wrapped.code = 'agent_metadata_unreadable';
    throw wrapped;
  }
}

async function writeAgentMetadata(metadata) {
  await fs.mkdir(metadataDirectory(), { recursive: true, mode: 0o700 });
  const temporaryPath = `${metadataPath()}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, metadataPath());
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    const wrapped = new Error(`Unable to write durable agent metadata: ${error.message}`);
    wrapped.code = 'agent_metadata_unwritable';
    throw wrapped;
  }
}

function metadataLockPath() {
  return `${metadataPath()}.lock`;
}

function lockOwnerIsAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

async function readDirectoryLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    return parsed && typeof parsed.token === 'string' ? parsed : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function acquireDirectoryLock(lockPath, { timeoutMs, staleMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(metadataDirectory(), { recursive: true, mode: 0o700 });
  while (Date.now() < deadline) {
    const owner = { pid: process.pid, token: randomUUID() };
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      } catch (ownerError) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw ownerError;
      }
      return async () => {
        const currentOwner = await readDirectoryLockOwner(lockPath);
        if (!currentOwner || currentOwner.pid !== owner.pid || currentOwner.token !== owner.token) return;
        await fs.rm(lockPath, { recursive: true, force: false }).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          const currentOwner = await readDirectoryLockOwner(lockPath);
          if (!currentOwner || !lockOwnerIsAlive(currentOwner)) {
            await fs.rm(lockPath, { recursive: true, force: false });
            continue;
          }
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const error = new Error(`Timed out acquiring lock: ${lockPath}`);
  error.code = lockPath === metadataLockPath() ? 'agent_metadata_lock_timeout' : 'agent_native_launch_lock_timeout';
  throw error;
}

async function acquireMetadataLock() {
  return await acquireDirectoryLock(metadataLockPath(), {
    timeoutMs: METADATA_LOCK_TIMEOUT_MS,
    staleMs: METADATA_LOCK_STALE_MS,
  });
}

async function acquireNativeLaunchLock() {
  return await acquireDirectoryLock(path.join(metadataDirectory(), 'native-launch.lock'), {
    timeoutMs: NATIVE_LAUNCH_LOCK_TIMEOUT_MS,
    staleMs: NATIVE_LAUNCH_LOCK_STALE_MS,
  });
}

function isDetachedTerminalMetadata(record) {
  return Boolean(
    record &&
    TERMINAL_METADATA_LIFECYCLES.has(record.lifecycle) &&
    !record.runtimeAgentId &&
    !record.runtimeWorkspaceId &&
    !record.quarantineRuntime
  );
}

function terminalMetadataTimestamp(record) {
  const value = record?.terminalAt ?? record?.updatedAt;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? parsed : null;
}

function pruneDetachedTerminalMetadata(metadata, nowMs = Date.now()) {
  const removable = Object.entries(metadata.agents)
    .filter(([agentId, record]) => agentId === record?.agentId && isDetachedTerminalMetadata(record))
    .map(([agentId, record]) => ({ agentId, record, timestamp: terminalMetadataTimestamp(record) }))
    .filter(({ timestamp }) => timestamp !== null && timestamp <= nowMs);
  const removedIds = new Set();

  for (const { agentId, timestamp } of removable) {
    if (nowMs - timestamp >= TERMINAL_METADATA_RETENTION_MS) removedIds.add(agentId);
  }

  const retained = removable
    .filter(({ agentId }) => !removedIds.has(agentId))
    .sort((left, right) => right.timestamp - left.timestamp);
  for (const { agentId } of retained.slice(MAX_TERMINAL_METADATA_RECORDS)) removedIds.add(agentId);

  if (removedIds.size === 0) return { metadata, removedIds: [] };
  for (const agentId of removedIds) delete metadata.agents[agentId];
  return { metadata, removedIds: [...removedIds] };
}

async function collectAgentMetadata() {
  const release = await acquireMetadataLock();
  try {
    const metadata = await readAgentMetadata();
    const collected = pruneDetachedTerminalMetadata(metadata);
    if (collected.removedIds.length > 0) await writeAgentMetadata(collected.metadata);
    return collected.metadata;
  } finally {
    await release();
  }
}

async function updateAgentMetadata(agentId, update) {
  return await mutateAgentMetadata((metadata) => {
    const current = metadata.agents[agentId] ?? null;
    const next = typeof update === 'function' ? update(current) : update;
    if (next === null) delete metadata.agents[agentId];
    else metadata.agents[agentId] = next;
    return next;
  });
}

async function mutateAgentMetadata(mutator) {
  const release = await acquireMetadataLock();
  try {
    const metadata = await readAgentMetadata();
    metadata.completions ??= {};
    const result = await mutator(metadata);
    pruneDetachedTerminalMetadata(metadata);
    await writeAgentMetadata(metadata);
    return result;
  } finally {
    await release();
  }
}

function normalizePromptRequestId(value) {
  if (value === undefined) return randomUUID();
  if (typeof value !== 'string' || !PROMPT_REQUEST_ID_PATTERN.test(value)) {
    const error = new Error('requestId must be a stable single-line identifier up to 128 characters.');
    error.code = 'agent_invalid_request_id';
    throw error;
  }
  return value;
}

function promptRequestFingerprint({ agentId, task, skills, wait, until }) {
  return createHash('sha256')
    .update(JSON.stringify({ agentId, task, skills, wait, until }), 'utf8')
    .digest('hex');
}

function promptSubmissionMarker(completionId) {
  return `agent-vm-mcp-request:${completionId}`;
}

function promptCompletionBlocksDifferentRequest(record) {
  if (!record) return false;
  if (record.state === 'in_flight' || record.state === 'uncertain') return true;
  const disposition = record.result?.runtimeDisposition?.action;
  return disposition === 'pending' || disposition === 'cleanup_failed';
}

function blockingPromptCompletion(metadata, agentId, excludeRequestId = null) {
  return Object.values(metadata.completions ?? {})
    .filter((record) => record.agentId === agentId && record.requestId !== excludeRequestId)
    .find((record) => promptCompletionBlocksDifferentRequest(record)) ?? null;
}

function promptCompletionBlocksLifecycleMutation(record) {
  return record?.state === 'in_flight' || record?.state === 'uncertain';
}

function blockingPromptLifecycleCompletion(metadata, agentId) {
  return Object.values(metadata.completions ?? {})
    .filter((record) => record.agentId === agentId)
    .find((record) => promptCompletionBlocksLifecycleMutation(record)) ?? null;
}

function promptLifecycleBlockedError(agentId, record) {
  const error = new Error(`Agent ${agentId} has unresolved prompt request ${record?.requestId ?? 'unknown'} and cannot change runtime lifecycle.`);
  error.code = 'agent_prompt_in_flight';
  error.existingRequestId = record?.requestId ?? null;
  return error;
}

async function reserveLifecycleTransition(
  agentId,
  { from, to, runtimeAgentId = undefined, runtimeWorkspaceId = undefined },
) {
  return await mutateAgentMetadata((metadata) => {
    const current = metadata.agents[agentId] ?? null;
    if (!current || current.lifecycle !== from) {
      const error = new Error(`Agent ${agentId} changed lifecycle before ${to} could be reserved.`);
      error.code = 'agent_invalid_transition';
      throw error;
    }
    if (
      (runtimeAgentId !== undefined && current.runtimeAgentId !== runtimeAgentId) ||
      (runtimeWorkspaceId !== undefined && current.runtimeWorkspaceId !== runtimeWorkspaceId)
    ) {
      const error = new Error(`Agent ${agentId} changed runtime generation before ${to} could be reserved.`);
      error.code = 'agent_runtime_generation_changed';
      throw error;
    }
    const busy = blockingPromptLifecycleCompletion(metadata, agentId);
    if (busy) throw promptLifecycleBlockedError(agentId, busy);
    const next = {
      ...current,
      lifecycle: to,
      updatedAt: new Date().toISOString(),
    };
    metadata.agents[agentId] = next;
    return next;
  });
}

async function verifyPromptClaimGeneration(record, signal, timeoutMs) {
  const metadata = await readAgentMetadata();
  const logical = metadata.agents[record.agentId] ?? null;
  if (
    logical && (
      logical.lifecycle !== 'active' ||
      logical.runtimeAgentId !== record.runtimeAgentId ||
      logical.runtimeWorkspaceId !== record.runtimeWorkspaceId
    )
  ) {
    const error = new Error(`Agent ${record.agentId} changed runtime generation before prompt dispatch.`);
    error.code = 'agent_runtime_generation_changed';
    throw error;
  }
  const owned = await requireOwnedAgent(record.agentId, { signal, timeoutMs });
  if (
    owned.runtimeAgentId !== record.runtimeAgentId ||
    owned.workspace.workspace_id !== record.runtimeWorkspaceId ||
    owned.agent.workspace_id !== record.runtimeWorkspaceId
  ) {
    const error = new Error(`Agent ${record.agentId} changed runtime generation before prompt dispatch.`);
    error.code = 'agent_runtime_generation_changed';
    throw error;
  }
  return owned;
}

function promptCompletionNeedsReconciliation(record) {
  if (record?.state === 'in_flight' || record?.state === 'uncertain') return true;
  return Boolean(record?.wait && record.state === 'completed' && ['pending', 'cleanup_failed'].includes(record.result?.runtimeDisposition?.action));
}

function promptCompletionResponse(record, { recovered = false } = {}) {
  if (record.state === 'in_flight') {
    return {
      accepted: null,
      requestId: record.requestId,
      completionId: record.completionId,
      recovered,
      resultState: record.state,
      submission: { state: 'possibly_submitted', retrySafe: false, waitCompleted: false },
      error: {
        code: 'agent_prompt_recovery_pending',
        message: `Prompt request ${record.requestId} is still in flight or its completion is not yet observable. Do not automatically retry it.`,
        retryable: false,
      },
      agent: null,
      transcript: '',
    };
  }
  return {
    ...(record.result ?? {
      accepted: null,
      submission: { state: 'possibly_submitted', retrySafe: false, waitCompleted: false },
      agent: null,
      transcript: '',
    }),
    requestId: record.requestId,
    completionId: record.completionId,
    recovered,
    resultState: record.state,
    acknowledged: record.acknowledgedAt !== null,
  };
}

async function claimPromptCompletion(request) {
  return await mutateAgentMetadata((metadata) => {
    const existing = metadata.completions[request.requestId] ?? null;
    if (existing) {
      if (existing.agentId !== request.agentId || existing.fingerprint !== request.fingerprint) {
        return { kind: 'conflict', record: existing };
      }
      return { kind: 'existing', record: existing };
    }

    const busy = blockingPromptCompletion(metadata, request.agentId);
    if (busy) return { kind: 'busy', record: busy };

    const logical = metadata.agents[request.agentId] ?? null;
    if (
      logical && (
        logical.lifecycle !== 'active' ||
        logical.runtimeAgentId !== request.runtimeAgentId ||
        logical.runtimeWorkspaceId !== request.runtimeWorkspaceId
      )
    ) return { kind: 'generation_mismatch', record: logical };

    const now = new Date().toISOString();
    const completionId = randomUUID();
    const record = {
      version: PROMPT_COMPLETION_VERSION,
      completionId,
      requestId: request.requestId,
      fingerprint: request.fingerprint,
      agentId: request.agentId,
      harness: request.harness,
      cwd: request.cwd,
      runtimeAgentId: request.runtimeAgentId,
      runtimeWorkspaceId: request.runtimeWorkspaceId,
      initialStateChangeSeq: request.initialStateChangeSeq ?? null,
      skills: request.skills,
      wait: request.wait,
      until: request.until,
      state: 'in_flight',
      dispatchState: 'dispatching',
      submissionMarker: promptSubmissionMarker(completionId),
      ownerPid: process.pid,
      createdAt: now,
      submittedAt: null,
      completedAt: null,
      updatedAt: now,
      acknowledgedAt: null,
      result: null,
    };
    metadata.completions[request.requestId] = record;
    return { kind: 'claimed', record };
  });
}

async function updatePromptCompletion(requestId, update) {
  return await mutateAgentMetadata((metadata) => {
    const current = metadata.completions[requestId] ?? null;
    if (!current) return null;
    const next = typeof update === 'function' ? update(current) : update;
    if (next === null) delete metadata.completions[requestId];
    else metadata.completions[requestId] = next;
    return next;
  });
}

async function readPromptCompletion(requestId) {
  const metadata = await readAgentMetadata();
  return metadata.completions[requestId] ?? null;
}

function runtimeObservation(snapshot, record) {
  const runtimeAgentId = record.runtimeAgentId;
  if (!runtimeAgentId || !snapshot) return 'ambiguous';
  const agents = (snapshot.agents ?? []).filter((agent) => agent.name === runtimeAgentId);
  const labeledWorkspaces = (snapshot.workspaces ?? []).filter((workspace) => workspace.label === runtimeAgentId);
  const recordedWorkspaces = record.runtimeWorkspaceId
    ? (snapshot.workspaces ?? []).filter((workspace) => workspace.workspace_id === record.runtimeWorkspaceId)
    : [];
  if (labeledWorkspaces.length > 1 || recordedWorkspaces.length > 1) return 'ambiguous';
  if (
    record.runtimeWorkspaceId &&
    ((labeledWorkspaces.length === 1 && labeledWorkspaces[0].workspace_id !== record.runtimeWorkspaceId) ||
      (recordedWorkspaces.length === 1 && recordedWorkspaces[0].label !== runtimeAgentId))
  ) return 'ambiguous';
  const workspaces = labeledWorkspaces.length === 1
    ? labeledWorkspaces
    : recordedWorkspaces;
  if (agents.length === 0 && workspaces.length === 0) return 'absent';
  if (agents.length === 0 && workspaces.length === 1) return { status: 'orphan', workspace: workspaces[0] };
  if (agents.length !== 1 || workspaces.length !== 1) return 'ambiguous';
  const [agent] = agents;
  const [workspace] = workspaces;
  return agent.workspace_id === workspace.workspace_id && workspace.label === runtimeAgentId
    ? { status: 'owned', agent, workspace }
    : 'ambiguous';
}

async function closeExactlyOwnedWorkspace(runtimeAgentId, workspace, signal) {
  if (!workspace?.workspace_id || workspace.label !== runtimeAgentId) return false;
  const verify = await runHerdr(['workspace', 'get', workspace.workspace_id], { timeoutMs: 5_000, signal });
  if (!verify.ok || verify.result.workspace?.label !== runtimeAgentId) return false;
  const outcome = await runHerdr(['workspace', 'close', workspace.workspace_id], { timeoutMs: 30_000, signal });
  if (!outcome.ok) return false;
  return true;
}

async function quarantineCodexRecord(record, reason, snapshot = null, signal) {
  const now = new Date().toISOString();
  const next = {
    ...record,
    lifecycle: 'quarantined',
    policyStatus: 'unverified',
    quarantineReason: reason,
    terminalAt: record.lifecycle === 'quarantined' ? (record.terminalAt ?? now) : now,
    updatedAt: now,
  };

  if (snapshot && record.runtimeAgentId) {
    const observation = runtimeObservation(snapshot, record);
    if (observation === 'absent') {
      next.runtimeAgentId = null;
      next.runtimeWorkspaceId = null;
    } else if (observation?.status === 'owned' || observation?.status === 'orphan') {
      const closed = await closeExactlyOwnedWorkspace(record.runtimeAgentId, observation.workspace, signal);
      if (closed) {
        next.runtimeAgentId = null;
        next.runtimeWorkspaceId = null;
        next.lastRuntimeAgentId = record.runtimeAgentId;
        next.lastWorkspaceId = observation.workspace.workspace_id;
      } else {
        next.quarantineRuntime = {
          runtimeAgentId: record.runtimeAgentId,
          workspaceId: observation.workspace.workspace_id,
          closeAttempted: true,
        };
      }
    } else if (observation === 'ambiguous') {
      next.quarantineRuntime = {
        runtimeAgentId: record.runtimeAgentId,
        workspaceId: record.runtimeWorkspaceId ?? null,
        closeAttempted: false,
      };
    }
  }
  return await updateAgentMetadata(record.agentId, next);
}

async function reconcileAgentMetadata(snapshot = null, signal) {
  let metadata = await readAgentMetadata();
  if (!snapshot) return metadata;
  for (const record of Object.values(metadata.agents)) {
    if (record.harness === 'codex' && ['active', 'starting', 'suspending', 'suspended', 'resuming', 'stopping'].includes(record.lifecycle)) {
      const compliance = await verifyCodexProvenance(record);
      if (!compliance.ok) {
        await quarantineCodexRecord(record, compliance.reason, snapshot, signal);
        continue;
      }
    }
    if (record.lifecycle === 'active') {
      const observation = runtimeObservation(snapshot, record);
      if (observation === 'absent') {
        await updateAgentMetadata(record.agentId, (current) => {
          if (!current || current.lifecycle !== 'active' || current.runtimeAgentId !== record.runtimeAgentId) return current;
          const recoverable = Boolean(current.resumable && current.nativeSessionId);
          return {
            ...current,
            lifecycle: recoverable ? 'suspended' : 'orphaned',
            runtimeAgentId: null,
            runtimeWorkspaceId: null,
            lastRuntimeAgentId: current.runtimeAgentId ?? current.lastRuntimeAgentId ?? null,
            lastWorkspaceId: current.runtimeWorkspaceId ?? current.lastWorkspaceId ?? null,
            ...(recoverable ? {} : { orphanedReason: 'runtime_absent', terminalAt: new Date().toISOString() }),
            updatedAt: new Date().toISOString(),
          };
        });
      } else if (observation?.status === 'orphan') {
        const closed = await closeExactlyOwnedWorkspace(record.runtimeAgentId, observation.workspace, signal);
        if (closed) {
          await updateAgentMetadata(record.agentId, (current) => {
            if (!current || current.lifecycle !== 'active' || current.runtimeAgentId !== record.runtimeAgentId) return current;
            const recoverable = Boolean(current.resumable && current.nativeSessionId);
            return {
              ...current,
              lifecycle: recoverable ? 'suspended' : 'orphaned',
              runtimeAgentId: null,
              runtimeWorkspaceId: null,
              lastRuntimeAgentId: current.runtimeAgentId ?? current.lastRuntimeAgentId ?? null,
              lastWorkspaceId: observation.workspace.workspace_id,
              ...(recoverable ? {} : { orphanedReason: 'runtime_agent_missing', terminalAt: new Date().toISOString() }),
              updatedAt: new Date().toISOString(),
            };
          });
        }
      }
      continue;
    }
    if (record.lifecycle === 'stopping') {
      const observation = runtimeObservation(snapshot, record);
      if (observation === 'ambiguous') continue;
      if (observation === 'absent') {
        await updateAgentMetadata(record.agentId, (current) => (
          current?.lifecycle === 'stopping' && current.runtimeAgentId === record.runtimeAgentId ? null : current
        ));
        continue;
      }
      if (observation?.status === 'orphan' || observation?.status === 'owned') {
        const closed = await closeExactlyOwnedWorkspace(record.runtimeAgentId, observation.workspace, signal);
        if (!closed) continue;
        await updateAgentMetadata(record.agentId, (current) => (
          current?.lifecycle === 'stopping' && current.runtimeAgentId === record.runtimeAgentId ? null : current
        ));
      }
      continue;
    }
    if (record.lifecycle !== 'suspending' && record.lifecycle !== 'resuming') continue;
    const observation = runtimeObservation(snapshot, record);
    if (observation?.status === 'orphan') {
      const closed = await closeExactlyOwnedWorkspace(record.runtimeAgentId, observation.workspace, signal);
      if (!closed) continue;
      await updateAgentMetadata(record.agentId, (current) => {
        if (!current || current.lifecycle !== record.lifecycle || current.runtimeAgentId !== record.runtimeAgentId) return current;
        return {
          ...current,
          lifecycle: 'suspended',
          runtimeAgentId: null,
          runtimeWorkspaceId: null,
          lastRuntimeAgentId: record.runtimeAgentId,
          lastWorkspaceId: observation.workspace.workspace_id,
          updatedAt: new Date().toISOString(),
        };
      });
      continue;
    }
    if (observation === 'ambiguous') continue;
    const lifecycle = observation === 'absent' ? 'suspended' : observation.status === 'owned' ? 'active' : null;
    if (!lifecycle) continue;
    await updateAgentMetadata(record.agentId, (current) => {
      if (!current || current.lifecycle !== record.lifecycle || current.runtimeAgentId !== record.runtimeAgentId) return current;
      return {
        ...current,
        lifecycle,
        runtimeAgentId: lifecycle === 'active' ? current.runtimeAgentId : null,
        runtimeWorkspaceId: lifecycle === 'active' ? (current.runtimeWorkspaceId ?? observation.workspace.workspace_id) : null,
        lastRuntimeAgentId: lifecycle === 'active' ? current.lastRuntimeAgentId ?? null : current.runtimeAgentId ?? current.lastRuntimeAgentId ?? null,
        lastWorkspaceId: lifecycle === 'active' ? current.lastWorkspaceId ?? null : current.runtimeWorkspaceId ?? current.lastWorkspaceId ?? null,
        updatedAt: new Date().toISOString(),
      };
    });
  }
  metadata = await readAgentMetadata();
  return metadata;
}

async function reconcileBeforeOperation(signal, { timeoutMs = 2_000, reconcileCompletions = true } = {}) {
  const metadata = await collectAgentMetadata();
  const hasPendingPromptCompletion = Object.values(metadata.completions ?? {}).some(promptCompletionNeedsReconciliation);
  if (!hasPendingPromptCompletion && !Object.values(metadata.agents).some((record) => (
    record.lifecycle === 'active' ||
    record.lifecycle === 'starting' ||
    record.lifecycle === 'suspending' ||
    record.lifecycle === 'resuming' ||
    record.lifecycle === 'stopping' ||
    (record.harness === 'codex' && record.lifecycle === 'suspended')
  ))) return metadata;
  const snapshot = await snapshotOutcome({ signal, timeoutMs: Math.max(1, timeoutMs) });
  if (!snapshot.ok) return metadata;
  await reconcileAgentMetadata(snapshot.result.snapshot, signal);
  if (reconcileCompletions) await reconcilePromptCompletions(snapshot.result.snapshot);
  return await collectAgentMetadata();
}

async function withLifecycleLock(agentId, operation) {
  const previous = lifecycleLocks.get(agentId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  lifecycleLocks.set(agentId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleLocks.get(agentId) === current) lifecycleLocks.delete(agentId);
  }
}

function appendLimited(current, chunk) {
  if (current.length >= MAX_COMMAND_OUTPUT_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_COMMAND_OUTPUT_BYTES - current.length)]);
}

function processAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // The leader may have changed process groups; fall back to the direct child.
  }
  if (!processAlive(child)) return;
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

function runProgram(command, args, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        spawnError: error,
      });
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let escalationTimer = null;
    let hardStopTimer = null;

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (code, processSignal, spawnError = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal: processSignal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        cancelled,
        spawnError,
      });
    };

    const terminate = (reason) => {
      if (settled || timedOut || cancelled) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      killProcessGroup(child, 'SIGTERM');
      escalationTimer = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, 2_000);
      hardStopTimer = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
        finish(child.exitCode, child.signalCode);
      }, 2_500);
    };

    const onAbort = () => terminate('cancelled');
    const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);
    timeoutTimer.unref?.();

    if (signal?.aborted) terminate('cancelled');
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, processSignal) => {
      if ((timedOut || cancelled) && processGroupAlive(child.pid)) return;
      finish(code, processSignal);
    });
  });
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function herdrFailure(result, args) {
  const payload = parseJson(result.stderr) ?? parseJson(result.stdout);
  const structured = payload?.error;
  const spawnMessage = result.spawnError
    ? `${result.spawnError.code ?? 'spawn_failed'}: ${result.spawnError.message}`
    : null;
  return {
    code:
      structured?.code ??
      (result.spawnError ? 'spawn_failed' : result.timedOut ? 'timeout' : result.cancelled ? 'cancelled' : 'herdr_failed'),
    message:
      structured?.message ??
      spawnMessage ??
      (result.stderr.trim() || result.stdout.trim() || `herdr ${args.join(' ')} failed with code ${result.code}`),
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    spawnErrorCode: result.spawnError?.code ?? null,
  };
}

function herdrPreSpawnFailure(code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
      exitCode: null,
      signal: null,
      timedOut: code === 'deadline_exceeded',
      cancelled: code === 'cancelled',
      spawnErrorCode: null,
    },
    process: null,
  };
}

async function runHerdr(
  args,
  { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, signal, json = true, deadlineAt = null } = {},
) {
  const configured = configuredHerdrExecutable();
  const executable = await resolveExecutable(configured);
  if (!executable) {
    return herdrPreSpawnFailure(
      'herdr_unavailable',
      `Herdr executable is unavailable or not an executable regular file: ${configured}`,
    );
  }
  if (signal?.aborted) {
    return herdrPreSpawnFailure(
      'cancelled',
      'Herdr command was not started because the operation was cancelled before spawn.',
    );
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return herdrPreSpawnFailure(
      'deadline_exceeded',
      `Herdr command was not started because its submission deadline elapsed before spawn: ${args.join(' ')}.`,
    );
  }
  const fullArgs = ['--session', herdrSessionName(), ...args];
  const result = await runProgram(executable, fullArgs, { timeoutMs, signal });
  if (result.spawnError || result.code !== 0 || result.timedOut || result.cancelled) {
    return { ok: false, error: herdrFailure(result, args), process: result };
  }

  if (!json) return { ok: true, text: result.stdout, process: result };
  const payload = parseJson(result.stdout);
  if (!payload || payload.result === undefined) {
    return {
      ok: false,
      error: {
        code: 'invalid_herdr_response',
        message: `Herdr returned non-JSON or unexpected output for ${args.join(' ')}.`,
        exitCode: result.code,
        signal: result.signal,
        timedOut: false,
        cancelled: false,
      },
      process: result,
    };
  }
  return { ok: true, result: payload.result, process: result };
}

function attachCleanupFailure(error, cleanup) {
  if (!cleanup) return error;
  error.cleanup = cleanup;
  if (error.herdr) error.herdr.cleanup = cleanup;

  const code = cleanup.code ?? 'cleanup_failed';
  const message = cleanup.message ?? 'unknown cleanup error';
  const context = [
    cleanup.stage ? `stage=${cleanup.stage}` : null,
    cleanup.workspaceId ? `workspaceId=${cleanup.workspaceId}` : null,
    cleanup.retrySafe !== undefined ? `retrySafe=${cleanup.retrySafe}` : null,
  ].filter(Boolean);
  const summary = `cleanup also failed (${code}: ${message}${context.length ? `; ${context.join(', ')}` : ''})`;
  if (!error.message.includes(summary)) error.message = `${error.message}; ${summary}`;
  return error;
}

function throwHerdrFailure(outcome) {
  const error = new Error(`${outcome.error.code}: ${outcome.error.message}`);
  error.herdr = outcome.error;
  attachCleanupFailure(error, outcome.error.cleanup);
  throw error;
}

async function executableFile(candidate) {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return null;
    await fs.access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

async function findExecutable(name) {
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = await executableFile(path.join(directory, name));
    if (candidate) return candidate;
  }
  return null;
}

async function resolveExecutable(name) {
  if (path.isAbsolute(name) || name.includes(path.sep)) {
    return await executableFile(path.resolve(name));
  }
  return await findExecutable(name);
}

function nativeSessionIdFromAgent(agent) {
  const value = agent?.native_session_id ?? agent?.nativeSessionId ?? agent?.conversation_id ?? agent?.conversationId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function findRecentFiles(root, suffix) {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(candidate);
    }
  };
  await visit(root);
  return files;
}

async function captureNativeSessionSnapshot(harness, cwd, { codexHome = null } = {}) {
  const home = homeDirectory();
  if (harness === 'codex') {
    const files = await findRecentFiles(path.join(codexHome ?? path.join(home, '.codex'), 'sessions'), '.jsonl');
    const sessions = new Map();
    for (const file of files) {
      let firstLine;
      try {
        firstLine = (await fs.readFile(file, 'utf8')).split(/\r?\n/, 1)[0];
      } catch {
        continue;
      }
      const record = parseJson(firstLine);
      const payload = record?.payload;
      if (record?.type !== 'session_meta' || payload?.cwd !== cwd) continue;
      const timestamp = Date.parse(payload.timestamp ?? record.timestamp ?? '') || 0;
      const sessionId = payload.session_id ?? payload.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      let stat = null;
      try { stat = await fs.stat(file); } catch { /* The session may be rotating. */ }
      sessions.set(sessionId, {
        sessionId,
        timestamp,
        file,
        fingerprint: stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` : file,
      });
    }
    return sessions;
  }

  if (harness === 'agy') {
    const historyPath = path.join(home, '.gemini', 'antigravity-cli', 'history.jsonl');
    let lines;
    try {
      lines = (await fs.readFile(historyPath, 'utf8')).split(/\r?\n/);
    } catch (error) {
      if (error?.code === 'ENOENT') return new Map();
      throw error;
    }
    const sessions = new Map();
    for (const line of lines) {
      const record = parseJson(line);
      const timestamp = Number(record?.timestamp);
      if (record?.workspace !== cwd || !Number.isFinite(timestamp)) continue;
      if (typeof record.conversationId === 'string' && record.conversationId.length > 0) {
        sessions.set(record.conversationId, { sessionId: record.conversationId, timestamp });
      }
    }
    return sessions;
  }
  return new Map();
}

async function discoverNativeSessionId(before, harness, cwd, startedAt, options = {}) {
  let lastCandidates = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const after = await captureNativeSessionSnapshot(harness, cwd, options);
    lastCandidates = [...after.values()].filter((candidate) => (
      !before.has(candidate.sessionId) && candidate.timestamp + 5_000 >= startedAt
    ));
    if (lastCandidates.length > 1) {
      return { sessionId: null, attribution: 'ambiguous', candidates: lastCandidates.map(({ sessionId }) => sessionId) };
    }
    if (lastCandidates.length === 1) {
      if (attempt >= 2) return { sessionId: lastCandidates[0].sessionId, attribution: 'verified' };
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { sessionId: null, attribution: 'unavailable', candidates: [] };
}

async function inspectVersion(executable) {
  if (!executable) return null;
  const result = await runProgram(executable, ['--version'], { timeoutMs: 2_000 });
  if (result.spawnError || result.code !== 0 || result.timedOut || result.cancelled) return null;
  const text = `${result.stdout}\n${result.stderr}`;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

async function scanSkills(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillFile = path.join(root, entry.name, 'SKILL.md');
      try {
        const stat = await fs.stat(skillFile);
        if (stat.isFile()) skills.push(entry.name);
      } catch {
        // Ignore non-skill directories.
      }
    }
    return skills.sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function validateModel(model) {
  if (model === undefined) return;
  if (!model || model.length > 128 || model.includes('\0') || /[\r\n]/.test(model)) {
    throw new Error('model must be a non-empty single-line identifier up to 128 characters.');
  }
}

function codexHomeDirectory() {
  const configured = process.env.CODEX_HOME?.trim();
  return path.resolve(configured || path.join(homeDirectory(), '.codex'));
}

function codexProfileName(agentId) {
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error(`Invalid MCP-managed agent ID for Codex profile: ${agentId}`);
  return `${CODEX_PROFILE_PREFIX}${agentId}`;
}

function codexProfilePath(codexHome, profileName) {
  return path.join(codexHome, `${profileName}${CODEX_PROFILE_SUFFIX}`);
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function codexProfileContent() {
  return [
    `model = ${JSON.stringify(CODEX_POLICY.model)}`,
    `model_reasoning_effort = ${JSON.stringify(CODEX_POLICY.effort)}`,
    `developer_instructions = ${JSON.stringify(CODEX_MANAGED_DEVELOPER_INSTRUCTIONS)}`,
    '',
    '[agents]',
    `default_subagent_model = ${JSON.stringify(CODEX_POLICY.model)}`,
    `default_subagent_reasoning_effort = ${JSON.stringify(CODEX_POLICY.effort)}`,
    '',
  ].join('\n');
}

function isAllowedCodexProfileContent(content) {
  const expected = codexProfileContent();
  if (content === expected) return true;
  if (!content.startsWith(expected)) return false;

  const lines = content.slice(expected.length).split(/\r?\n/);
  let index = 0;
  let trustBlocks = 0;
  while (index < lines.length) {
    while (index < lines.length && lines[index] === '') index += 1;
    if (index >= lines.length) break;
    if (!/^\[projects\."(?:[^"\\]|\\.)+"\]$/.test(lines[index])) return false;
    index += 1;
    if (lines[index] !== 'trust_level = "trusted"') return false;
    index += 1;
    trustBlocks += 1;
  }
  return trustBlocks > 0;
}

async function prepareCodexProvenance(agentId) {
  const codexHome = codexHomeDirectory();
  const profileName = codexProfileName(agentId);
  const profilePath = codexProfilePath(codexHome, profileName);
  const content = codexProfileContent();
  const profileSha256 = sha256Text(content);

  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  let existing = null;
  try {
    existing = await fs.readFile(profilePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing !== null && existing !== content) {
    const conflict = new Error(`Codex managed profile already exists with different content: ${profilePath}`);
    conflict.code = 'agent_codex_profile_conflict';
    throw conflict;
  }
  if (existing === null) {
    const temporaryPath = `${profilePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, profilePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    version: CODEX_PROVENANCE_VERSION,
    managedBy: 'agent-vm-mcp',
    policy: { ...CODEX_POLICY },
    codexHome,
    profileName,
    profilePath,
    profileSha256,
    developerInstructionsSha256: sha256Text(CODEX_MANAGED_DEVELOPER_INSTRUCTIONS),
  };
}

async function verifyCodexProvenance(record) {
  const provenance = record?.codexProvenance;
  if (record?.harness !== 'codex') return { ok: true };
  if (record.model !== CODEX_POLICY.model || record.effort !== CODEX_POLICY.effort) {
    return { ok: false, reason: 'durable root model/effort provenance does not match the fixed Codex policy.' };
  }
  if (
    !provenance ||
    provenance.version !== CODEX_PROVENANCE_VERSION ||
    provenance.managedBy !== 'agent-vm-mcp' ||
    provenance.policy?.model !== CODEX_POLICY.model ||
    provenance.policy?.effort !== CODEX_POLICY.effort ||
    typeof provenance.codexHome !== 'string' ||
    !path.isAbsolute(provenance.codexHome) ||
    provenance.codexHome !== codexHomeDirectory() ||
    provenance.profileName !== codexProfileName(record.agentId) ||
    provenance.profilePath !== codexProfilePath(provenance.codexHome, provenance.profileName) ||
    provenance.profileSha256 !== sha256Text(codexProfileContent()) ||
    provenance.developerInstructionsSha256 !== sha256Text(CODEX_MANAGED_DEVELOPER_INSTRUCTIONS)
  ) {
    return { ok: false, reason: 'durable Codex policy/profile provenance is absent or mismatched.' };
  }

  let content;
  try {
    content = await fs.readFile(provenance.profilePath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `managed Codex profile could not be read: ${error.message}` };
  }
  if (!isAllowedCodexProfileContent(content)) {
    return { ok: false, reason: 'managed Codex profile fingerprint does not match the fixed policy.' };
  }
  return { ok: true, provenance };
}

function codexPolicyError(record, reason) {
  const error = new Error(`MCP-managed Codex agent ${record?.agentId ?? 'unknown'} is quarantined: ${reason}`);
  error.code = 'agent_codex_policy_unverified';
  error.retryable = false;
  error.policy = codexLaunchPolicy();
  return error;
}

async function resolveCwd(cwd) {
  if (!cwd || cwd.includes('\0') || /[\r\n]/.test(cwd)) {
    throw new Error('cwd must be a non-empty directory path without control characters.');
  }
  const resolved = await fs.realpath(path.resolve(cwd));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
  return resolved;
}

async function spawnHerdrServer() {
  const executable = await resolveExecutable(configuredHerdrExecutable());
  if (!executable) {
    const error = new Error(`Herdr executable is unavailable or not executable: ${configuredHerdrExecutable()}`);
    error.code = 'herdr_unavailable';
    throw error;
  }
  const child = spawn(executable, ['--session', herdrSessionName(), 'server'], {
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', () => {});
  child.unref();
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function timeoutError(message = 'The operation timed out.') {
  const error = new Error(message);
  error.code = 'timeout';
  return error;
}

function sleepWithSignal(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForOperation(
  promise,
  signal,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  timeoutMessage = 'The operation timed out.',
) {
  if (signal?.aborted) throw abortError();
  let onAbort = null;
  let timeoutTimer = null;
  const racers = [promise];

  if (signal) {
    racers.push(new Promise((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }

  racers.push(new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => reject(timeoutError(timeoutMessage)), Math.max(1, timeoutMs));
  }));

  try {
    return await Promise.race(racers);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function waitForShared(promise, signal, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  return await waitForOperation(
    promise,
    signal,
    timeoutMs,
    'Timed out waiting for the shared Herdr session.',
  );
}

async function ensureHerdrSession(signal, { timeoutMs = 2_000 } = {}) {
  signal?.throwIfAborted?.();
  const boundedTimeoutMs = Math.max(1, Math.min(2_000, timeoutMs));
  const snapshot = await runHerdr(['api', 'snapshot'], { timeoutMs: boundedTimeoutMs, signal });
  if (snapshot.ok) return snapshot.result.snapshot;

  if (herdrBootstrapMode() === 'external') {
    const error = new Error(
      `Herdr session ${herdrSessionName()} is not available in external bootstrap mode: ${snapshot.error.message}`,
    );
    error.herdr = snapshot.error;
    error.code = 'herdr_session_unavailable';
    throw error;
  }

  if (!sessionBootstrapPromise) {
    sessionBootstrapPromise = (async () => {
      const recheck = await runHerdr(['api', 'snapshot'], { timeoutMs: 2_000 });
      if (recheck.ok) return recheck.result.snapshot;
      await spawnHerdrServer();
      const deadline = Date.now() + 5_000;
      let lastError = recheck.error;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const probe = await runHerdr(['api', 'snapshot'], { timeoutMs: 1_000 });
        if (probe.ok) return probe.result.snapshot;
        lastError = probe.error;
      }
      const error = new Error(`Failed to start Herdr session ${herdrSessionName()}: ${lastError?.message ?? 'unknown error'}`);
      error.herdr = lastError;
      throw error;
    })().finally(() => {
      sessionBootstrapPromise = null;
    });
  }
  return await waitForShared(sessionBootstrapPromise, signal, timeoutMs);
}

function normalizeAgent(agent, logical = null) {
  return {
    agentId: logical?.agentId ?? agent.name,
    logicalSessionId: logical?.agentId ?? agent.name,
    runtimeAgentId: agent.name,
    lifecycle: logical?.lifecycle ?? 'active',
    harness: agent.agent ?? null,
    status: agent.agent_status ?? 'unknown',
    interactiveReady: Boolean(agent.interactive_ready),
    cwd: agent.cwd ?? null,
    foregroundCwd: agent.foreground_cwd ?? null,
    workspaceId: agent.workspace_id ?? null,
    tabId: agent.tab_id ?? null,
    paneId: agent.pane_id ?? null,
    stateChangeSeq: agent.state_change_seq ?? null,
    nativeSessionId: logical?.nativeSessionId ?? nativeSessionIdFromAgent(agent),
    nativeSessionAttribution: logical?.nativeSessionAttribution ?? (logical ? 'unavailable' : 'legacy_backend_reported'),
    legacy: logical?.legacy ?? logical === null,
    resumable: Boolean(logical?.resumable ?? false),
    ...(logical?.harness === 'codex' ? {
      policyStatus: logical.policyStatus ?? 'unverified',
      codexPolicy: logical.codexProvenance?.policy ?? null,
    } : {}),
  };
}

function ownedAgentRecords(snapshot, metadata = { agents: {} }, { includeTransitional = false } = {}) {
  const durableByRuntimeId = new Map(
    Object.values(metadata.agents ?? {})
      .filter((record) => typeof record?.runtimeAgentId === 'string')
      .map((record) => [record.runtimeAgentId, record]),
  );
  const workspaceById = new Map(
    (snapshot.workspaces ?? [])
      .filter((workspace) => typeof workspace.workspace_id === 'string' && workspace.workspace_id.length > 0)
      .map((workspace) => [workspace.workspace_id, workspace]),
  );
  return (snapshot.agents ?? [])
    .filter((agent) => {
      if (!AGENT_ID_PATTERN.test(agent.name ?? '')) return false;
      if (typeof agent.workspace_id !== 'string' || agent.workspace_id.length === 0) return false;
      const durable = durableByRuntimeId.get(agent.name);
      if (
        durable &&
        durable.lifecycle !== 'active' &&
        !(includeTransitional && ['starting', 'suspending', 'resuming', 'stopping'].includes(durable.lifecycle))
      ) return false;
      const workspace = workspaceById.get(agent.workspace_id);
      return Boolean(workspace && workspace.label === agent.name && workspace.workspace_id === agent.workspace_id);
    })
    .map((agent) => ({
      agent,
      workspace: workspaceById.get(agent.workspace_id),
      logical: durableByRuntimeId.get(agent.name) ?? (metadata.agents?.[agent.name]?.lifecycle === 'active' ? metadata.agents[agent.name] : null),
    }));
}

function ownedAgentRecord(snapshot, agentId, metadata = { agents: {} }) {
  return ownedAgentRecords(snapshot, metadata).find(({ agent, logical }) => agent.name === agentId || logical?.agentId === agentId) ?? null;
}

async function requireOwnedAgent(
  agentId,
  { signal, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, allowUnverifiedLegacyCodex = false } = {},
) {
  const metadata = await readAgentMetadata();
  const durable = metadata.agents[agentId] ?? null;
  if (durable?.lifecycle === 'quarantined') {
    throw codexPolicyError(durable, durable.quarantineReason ?? 'policy provenance is unavailable.');
  }
  if (durable?.harness === 'codex' && durable.lifecycle === 'active') {
    const compliance = await verifyCodexProvenance(durable);
    if (!compliance.ok) {
      await quarantineCodexRecord(durable, compliance.reason, null, signal);
      throw codexPolicyError(durable, compliance.reason);
    }
  }
  const snapshot = await ensureHerdrSession(signal, { timeoutMs });
  const owned = ownedAgentRecord(snapshot, agentId, metadata);
  if (!owned) {
    const error = new Error(`Agent ${agentId} is not an MCP-managed Herdr agent.`);
    error.code = 'agent_not_managed';
    throw error;
  }
  if (!owned.logical && owned.agent?.agent === 'codex' && !allowUnverifiedLegacyCodex) {
    throw codexPolicyError(
      { agentId },
      'legacy Codex session has no durable MCP-managed launch provenance and cannot be used after policy enforcement.',
    );
  }
  return {
    ...owned,
    logical: owned.logical ?? {
      agentId: owned.agent.name,
      harness: owned.agent.agent ?? null,
      cwd: owned.agent.cwd ?? null,
      nativeSessionId: nativeSessionIdFromAgent(owned.agent),
      nativeSessionAttribution: 'legacy_backend_reported',
      legacy: true,
      resumable: false,
      lifecycle: 'active',
      runtimeAgentId: owned.agent.name,
    },
    runtimeAgentId: owned.agent.name,
  };
}

function normalizeInteractionText(text) {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
}

function interactionExcerpt(text) {
  const normalized = normalizeInteractionText(text);
  return normalized.slice(Math.max(0, normalized.length - 2_000));
}

function extractCommandApproval(text) {
  const normalized = normalizeInteractionText(text);
  const lines = normalized.split('\n');
  let promptIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/Would you like to run the following command\?/i.test(lines[index])) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex === -1) return null;

  let commandIndex = -1;
  for (let index = promptIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\$\s+/.test(lines[index])) {
      commandIndex = index;
      break;
    }
  }
  if (commandIndex === -1) return null;

  const parts = [lines[commandIndex].replace(/^\s*\$\s+/, '').trim()];
  for (let index = commandIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^(?:›|Press enter\b|\d+\.\s)/i.test(line)) break;
    parts.push(line);
  }
  const command = parts.join(' ').replace(/\s+/g, ' ').trim();
  return command || null;
}

function simpleReadOnlyCommand(segment) {
  const command = segment.trim();
  if (!command) return false;
  if (/^git\s+(?:status|ls-files|rev-parse)\b/.test(command)) return true;
  if (/^git\s+branch\s+--show-current(?:\s|$)/.test(command)) return true;
  if (/^(?:grep|nl|cat|head|tail|wc|pwd|ls|stat|readlink)\b/.test(command)) return true;
  if (/^command\s+-v(?:\s|$)/.test(command)) return true;
  return false;
}

function readOnlyCommandHint(command) {
  if (!command) return null;
  if (/[;&|><`]/.test(command) || command.includes('$(')) return null;
  return simpleReadOnlyCommand(command) ? true : null;
}

function interactionDecision(kind, text, { command = null, securitySensitive = null } = {}) {
  const readOnly = kind === 'command_approval' ? readOnlyCommandHint(command) : null;
  return {
    kind,
    requiresDecision: true,
    ...(command ? { command } : {}),
    riskHints: {
      readOnly,
      workspaceMutation: readOnly === true ? false : null,
      securitySensitive,
    },
    excerpt: interactionExcerpt(text),
  };
}

function detectInteraction(text, status) {
  if (/Do you trust the contents of (?:this directory|this project)\?/i.test(text) || /Yes, I trust this folder/i.test(text)) {
    return interactionDecision('workspace_trust', text, { securitySensitive: true });
  }
  if (/authentication required|log in to continue|open .*browser.*sign in|enter .*code.*sign in/i.test(text)) {
    return interactionDecision('authentication', text, { securitySensitive: true });
  }
  if (/requires permission to read, edit, and execute files here/i.test(text)) {
    return interactionDecision('permission', text, { securitySensitive: true });
  }
  if (/Would you like to run the following command\?/i.test(text)) {
    return interactionDecision('command_approval', text, { command: extractCommandApproval(text) });
  }
  if (status === 'blocked') {
    return interactionDecision('blocked', text);
  }
  return null;
}

function detectTransientState(text) {
  if (/Verifying your account|finishing verifying your account eligibility|Signing in\.\.\./i.test(text)) {
    return { kind: 'harness_settling', retryable: true, excerpt: interactionExcerpt(text) };
  }
  return null;
}

async function readAgentTextOutcome(agentId, { source = 'recent-unwrapped', lines = 120, signal, timeoutMs } = {}) {
  const safeLines = Math.max(1, Math.min(MAX_AGENT_READ_LINES, lines));
  return await runHerdr(
    ['agent', 'read', agentId, '--source', source, '--lines', String(safeLines)],
    { timeoutMs: timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, signal, json: false },
  );
}

async function readAgentText(agentId, options = {}) {
  const outcome = await readAgentTextOutcome(agentId, options);
  if (!outcome.ok) throwHerdrFailure(outcome);
  return outcome.text;
}

async function getAgentState(
  agentId,
  { signal, includeInteraction = true, verifyOwnership = true, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {},
) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const ownedBefore = verifyOwnership
    ? await requireOwnedAgent(agentId, { signal, timeoutMs: remainingMs() })
    : null;
  const runtimeAgentId = ownedBefore?.runtimeAgentId ?? agentId;
  const outcome = await runHerdr(['agent', 'get', runtimeAgentId], { timeoutMs: remainingMs(), signal });
  if (!outcome.ok) throwHerdrFailure(outcome);
  const agent = normalizeAgent(outcome.result.agent, ownedBefore?.logical);
  if (ownedBefore && (agent.runtimeAgentId !== ownedBefore.runtimeAgentId || agent.workspaceId !== ownedBefore.workspace.workspace_id)) {
    const error = new Error(`Agent ${agentId} changed workspace during ownership verification.`);
    error.code = 'agent_not_managed';
    throw error;
  }
  if (!includeInteraction) {
    if (verifyOwnership) await requireOwnedAgent(agentId, { signal, timeoutMs: remainingMs() });
    return { ...agent, interaction: null, transient: null, screenReliable: true };
  }

  const read = await readAgentTextOutcome(runtimeAgentId, {
    source: 'visible',
    lines: 120,
    signal,
    timeoutMs: remainingMs(),
  });
  if (verifyOwnership) await requireOwnedAgent(agentId, { signal, timeoutMs: remainingMs() });
  if (!read.ok) {
    return {
      ...agent,
      interaction: null,
      transient: null,
      screenReliable: false,
      screenError: read.error,
    };
  }
  return {
    ...agent,
    interaction: detectInteraction(read.text, agent.status),
    transient: detectTransientState(read.text),
    screenReliable: true,
    screenError: null,
  };
}

function readinessFailure(state) {
  if (state.interaction) {
    return {
      code: 'interaction_required',
      message: `Agent ${state.agentId} requires an orchestration policy decision before a task can be submitted.`,
      retryable: false,
    };
  }
  if (state.transient) {
    return {
      code: 'agent_not_settled',
      message: `Agent ${state.agentId} is still settling and is not ready for task submission.`,
      retryable: true,
    };
  }
  if (!state.screenReliable) {
    return {
      code: 'agent_screen_unreliable',
      message: `Agent ${state.agentId} visible terminal could not be read reliably; task was not submitted.`,
      retryable: true,
    };
  }
  if (!state.interactiveReady || !READY_STATUSES.has(state.status)) {
    return {
      code: 'agent_not_ready',
      message: `Agent ${state.agentId} is not ready for task submission (status=${state.status}, interactiveReady=${state.interactiveReady}).`,
      retryable: state.status !== 'blocked',
    };
  }
  return null;
}

async function waitForAgentSettled(agentId, { signal, maxWaitMs = 10_000, verifyOwnership = true } = {}) {
  const deadline = Date.now() + maxWaitMs;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  let state = await getAgentState(agentId, {
    signal,
    includeInteraction: true,
    verifyOwnership,
    timeoutMs: Math.min(DEFAULT_COMMAND_TIMEOUT_MS, remainingMs()),
  });
  while (!state.interaction && state.transient && Date.now() < deadline) {
    signal?.throwIfAborted?.();
    await sleepWithSignal(Math.min(250, remainingMs()), signal);
    if (Date.now() >= deadline) break;
    state = await getAgentState(agentId, {
      signal,
      includeInteraction: true,
      verifyOwnership,
      timeoutMs: Math.min(DEFAULT_COMMAND_TIMEOUT_MS, remainingMs()),
    });
  }
  return state;
}

function promptPreflightError(code, message, { retryable = false, cause } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (cause !== undefined) error.cause = cause;
  return error;
}

async function validateSkills(harness, skills) {
  const definition = harnessDefinitions()[harness];
  if (!definition) {
    throw promptPreflightError('unsupported_harness', `Unsupported harness: ${harness}`);
  }

  let discovered;
  try {
    discovered = await scanSkills(definition.skillRoot);
  } catch (error) {
    throw promptPreflightError(
      'skill_discovery_failed',
      `Failed to discover installed skills for harness ${harness}: ${error.message}`,
      { retryable: true, cause: error },
    );
  }

  const available = new Set(discovered);
  for (const skill of skills) {
    if (!SKILL_NAME_PATTERN.test(skill)) {
      throw promptPreflightError('invalid_skill_name', `Invalid skill name: ${skill}`);
    }
    if (!available.has(skill)) {
      throw promptPreflightError(
        'skill_not_installed',
        `Skill ${skill} is not installed for harness ${harness}.`,
      );
    }
  }
}

function promptWithSkills(task, skills) {
  if (skills.length === 0) return task;
  return `Use the following installed skills for this task: ${skills.join(', ')}. Read and follow each skill's SKILL.md before acting.\n\n${task}`;
}

async function snapshotOutcome({ signal, timeoutMs = 2_000 } = {}) {
  return await runHerdr(['api', 'snapshot'], { timeoutMs, signal });
}

async function cleanupWorkspaceById(workspaceId) {
  const close = await runHerdr(['workspace', 'close', workspaceId], { timeoutMs: 5_000 });
  if (close.ok) return { cleaned: true, workspaceId, observed: true };
  return {
    cleaned: false,
    workspaceId,
    observed: true,
    error: {
      ...close.error,
      stage: 'workspace_close',
      workspaceId,
      retrySafe: true,
    },
  };
}

async function cleanupWorkspaceByLabel(agentId, { waitMs = WORKSPACE_CLEANUP_DISCOVERY_MS } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    const snapshot = await snapshotOutcome({ timeoutMs: 2_000 });
    if (!snapshot.ok) {
      return {
        cleaned: false,
        workspaceId: null,
        observed: false,
        error: {
          ...snapshot.error,
          stage: 'workspace_discovery',
          workspaceId: null,
          retrySafe: true,
        },
      };
    }
    const workspace = (snapshot.result.snapshot.workspaces ?? []).find((candidate) => candidate.label === agentId);
    if (workspace) return await cleanupWorkspaceById(workspace.workspace_id);
    if (Date.now() >= deadline) {
      return {
        cleaned: true,
        workspaceId: null,
        observed: false,
        bestEffort: true,
        discoveryWaitMs: Math.max(0, waitMs),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}

async function recoverOwnedAgent(agentId) {
  const snapshot = await snapshotOutcome({ timeoutMs: 2_000 });
  if (!snapshot.ok) return null;
  const metadata = await readAgentMetadata();
  const owned = ownedAgentRecords(snapshot.result.snapshot, metadata, { includeTransitional: true })
    .find(({ agent, logical }) => agent.name === agentId || logical?.agentId === agentId) ?? null;
  if (!owned) return null;
  const runtimeAgentId = owned.agent.name;
  const get = await runHerdr(['agent', 'get', runtimeAgentId], { timeoutMs: 2_000 });
  if (!get.ok) return null;
  const agent = normalizeAgent(get.result.agent, owned.logical);
  const read = await readAgentTextOutcome(runtimeAgentId, { source: 'visible', lines: 120, timeoutMs: 2_000 });
  const transcript = read.ok ? read.text : '';
  return {
    agent: {
      ...agent,
      interaction: read.ok ? detectInteraction(transcript, agent.status) : null,
      transient: read.ok ? detectTransientState(transcript) : null,
      screenReliable: read.ok,
      screenError: read.ok ? null : read.error,
    },
    transcript,
  };
}

async function safePromptDiagnostics(agentId) {
  const recovered = await recoverOwnedAgent(agentId).catch(() => null);
  if (!recovered) return { agent: null, transcript: '' };
  const read = await readAgentTextOutcome(recovered.agent.runtimeAgentId, { source: 'recent-unwrapped', lines: 160, timeoutMs: 2_000 });
  return { agent: recovered.agent, transcript: read.ok ? read.text : recovered.transcript };
}

function promptCompletionEvidence(record, runtimeAgent, transcript = '') {
  return (
    Number.isSafeInteger(record.initialStateChangeSeq) &&
    Number.isSafeInteger(runtimeAgent?.state_change_seq) &&
    runtimeAgent.state_change_seq > record.initialStateChangeSeq &&
    typeof record.submissionMarker === 'string' &&
    record.submissionMarker.length > 0 &&
    transcript.includes(record.submissionMarker)
  );
}

function uncertainPromptResult(record, diagnostics = { agent: null, transcript: '' }, cause = null) {
  return {
    accepted: null,
    requestId: record.requestId,
    completionId: record.completionId,
    submission: { state: 'possibly_submitted', retrySafe: false, waitCompleted: false },
    error: {
      code: 'agent_prompt_outcome_unknown',
      message: 'Prompt submission may have occurred, but completion could not be confirmed. Do not automatically retry this task.',
      retryable: false,
      ...(cause ? { cause } : {}),
    },
    agent: diagnostics.agent ?? null,
    transcript: diagnostics.transcript ?? '',
  };
}

function recoveredPromptResult(record, diagnostics) {
  const status = diagnostics.agent?.status ?? 'unknown';
  if (!record.wait) {
    return {
      accepted: true,
      requestId: record.requestId,
      completionId: record.completionId,
      submission: { state: 'submitted', retrySafe: false, waitCompleted: false },
      ...(record.skills?.length ? { skills: record.skills } : { skills: [] }),
      agent: diagnostics.agent,
      transcript: diagnostics.transcript,
      runtimeDisposition: { action: 'retained', reason: 'wait_disabled', status },
    };
  }
  return {
    accepted: null,
    requestId: record.requestId,
    completionId: record.completionId,
    submission: { state: 'possibly_submitted', retrySafe: false, waitCompleted: status === 'done' },
    ...(record.skills?.length ? { skills: record.skills } : { skills: [] }),
    agent: diagnostics.agent,
    transcript: diagnostics.transcript,
    runtimeDisposition: status === 'done'
      ? { action: 'pending', status: 'done' }
      : { action: 'retained', reason: 'recovered_terminal_state', status },
    error: {
      code: 'agent_prompt_completion_recovered',
      message: 'The prompt submission marker was observed after the original response became uncertain; use this durable result and do not submit a duplicate task.',
      retryable: false,
      ...(record.result?.error?.cause ? { cause: record.result.error.cause } : {}),
    },
  };
}

function completionResultForDonePrompt(record, diagnostics, { recoveredFromUncertain = false } = {}) {
  const result = {
    accepted: recoveredFromUncertain ? null : true,
    requestId: record.requestId,
    submission: recoveredFromUncertain
      ? { state: 'possibly_submitted', retrySafe: false, waitCompleted: false }
      : { state: 'submitted', retrySafe: false, waitCompleted: record.wait },
    ...(record.skills?.length ? { skills: record.skills } : { skills: [] }),
    agent: diagnostics.agent,
    transcript: diagnostics.transcript,
    runtimeDisposition: { action: 'pending', status: 'done' },
  };
  if (recoveredFromUncertain) {
    result.error = {
      code: 'agent_prompt_completion_recovered',
      message: 'Herdr reached done after the original prompt response became uncertain; recover the durable result and do not submit a duplicate task.',
      retryable: false,
      ...(record.result?.error?.cause ? { cause: record.result.error.cause } : {}),
    };
  }
  return result;
}

async function persistPromptCompletion(requestId, result, { finalStatus = 'done' } = {}) {
  const completedAt = new Date().toISOString();
  return await updatePromptCompletion(requestId, (current) => {
    if (!current) return current;
    if (
      current.state === 'completed' &&
      !['pending', 'cleanup_failed'].includes(current.result?.runtimeDisposition?.action)
    ) return current;
    return {
      ...current,
      state: 'completed',
      finalStatus,
      completedAt: current.completedAt ?? completedAt,
      updatedAt: completedAt,
      result,
    };
  });
}

async function reconcilePromptCompletionRecord(record, snapshot, { allowLocal = false } = {}) {
  if (!promptCompletionNeedsReconciliation(record)) return;
  const localOperation = promptOperations.get(record.agentId);
  if (!allowLocal && localOperation?.requestId === record.requestId) return;
  const ownerAlive = Boolean(Number.isInteger(record.ownerPid) && lockOwnerIsAlive({ pid: record.ownerPid }));
  if (record.state === 'in_flight' && ownerAlive && !allowLocal) return;

  const metadata = await readAgentMetadata();
  const logical = metadata.agents[record.agentId] ?? null;
  const observation = runtimeObservation(snapshot, record);
  if (!logical) {
    if (record.state === 'completed' && observation === 'absent' && record.result) {
      await persistPromptCompletion(record.requestId, {
        ...record.result,
        runtimeDisposition: { action: 'already_finalized', lifecycle: null },
      });
    } else if (record.state === 'in_flight' && !ownerAlive) {
      await updatePromptCompletion(record.requestId, (current) => current?.state === 'in_flight' ? {
        ...current,
        state: 'uncertain',
        updatedAt: new Date().toISOString(),
        result: uncertainPromptResult(current),
      } : current);
    }
    return;
  }
  if (
    record.state === 'completed' &&
    ['suspended', 'orphaned', 'quarantined'].includes(logical.lifecycle) &&
    !logical.runtimeAgentId &&
    observation === 'absent' &&
    record.result
  ) {
    await persistPromptCompletion(record.requestId, {
      ...record.result,
      runtimeDisposition: { action: 'already_finalized', lifecycle: logical.lifecycle },
    });
    return;
  }
  if (
    logical.lifecycle !== 'active' ||
    logical.runtimeAgentId !== record.runtimeAgentId ||
    logical.runtimeWorkspaceId !== record.runtimeWorkspaceId
  ) {
    if (record.state === 'in_flight' && !ownerAlive) {
      await updatePromptCompletion(record.requestId, (current) => current?.state === 'in_flight' ? {
        ...current,
        state: 'uncertain',
        updatedAt: new Date().toISOString(),
        result: uncertainPromptResult(current),
      } : current);
    }
    return;
  }
  if (observation?.status !== 'owned') {
    if (record.state === 'in_flight' && !ownerAlive) {
      await updatePromptCompletion(record.requestId, (current) => current?.state === 'in_flight' ? {
        ...current,
        state: 'uncertain',
        updatedAt: new Date().toISOString(),
        result: uncertainPromptResult(current),
      } : current);
    }
    return;
  }

  const diagnostics = await safePromptDiagnostics(record.agentId);
  const evidence = promptCompletionEvidence(record, observation.agent, diagnostics.transcript);
  if (!evidence) {
    if (record.state === 'in_flight' && !ownerAlive) {
      await updatePromptCompletion(record.requestId, (current) => current?.state === 'in_flight' ? {
        ...current,
        state: 'uncertain',
        updatedAt: new Date().toISOString(),
        result: uncertainPromptResult(current, diagnostics),
      } : current);
    }
    return;
  }

  if (!record.wait) {
    await persistPromptCompletion(record.requestId, recoveredPromptResult(record, diagnostics), {
      finalStatus: diagnostics.agent?.status ?? 'unknown',
    });
    return;
  }

  if (!READY_STATUSES.has(diagnostics.agent?.status)) {
    if (record.state === 'in_flight' && !ownerAlive) {
      await updatePromptCompletion(record.requestId, (current) => current?.state === 'in_flight' ? {
        ...current,
        state: 'uncertain',
        updatedAt: new Date().toISOString(),
        result: uncertainPromptResult(current, diagnostics),
      } : current);
    }
    return;
  }

  if (diagnostics.agent.status !== 'done') {
    await persistPromptCompletion(record.requestId, recoveredPromptResult(record, diagnostics), {
      finalStatus: diagnostics.agent.status,
    });
    return;
  }

  const recoveredFromUncertain = record.state === 'uncertain' || record.state === 'in_flight';
  const durableResult = record.state === 'completed' && record.result
    ? {
        ...record.result,
        agent: record.result.agent ?? diagnostics.agent,
        transcript: record.result.transcript || diagnostics.transcript,
        runtimeDisposition: { action: 'pending', status: 'done' },
      }
    : completionResultForDonePrompt(record, diagnostics, { recoveredFromUncertain });
  const persisted = await persistPromptCompletion(record.requestId, durableResult);
  if (!persisted || persisted.result?.runtimeDisposition?.action !== 'pending') return;

  const nativeSessionRefresh = await refreshNativeSessionAfterPrompt(record.agentId, diagnostics.agent);
  if (nativeSessionRefresh.state === 'error') {
    durableResult.runtimeDisposition = {
      action: 'retained',
      reason: 'native_session_refresh_failed',
      status: diagnostics.agent.status,
      error: nativeSessionRefresh.error,
    };
    await persistPromptCompletion(record.requestId, durableResult);
    return;
  }
  if (nativeSessionRefresh.state === 'ambiguous') {
    durableResult.runtimeDisposition = {
      action: 'retained',
      reason: 'native_session_ambiguous',
      status: diagnostics.agent.status,
      candidates: nativeSessionRefresh.candidates,
    };
    await persistPromptCompletion(record.requestId, durableResult);
    return;
  }

  durableResult.runtimeDisposition = await finalizeCompletedPromptRuntime(
    record.agentId,
    diagnostics.agent,
    undefined,
    {
      alreadyReconciled: true,
      expectedRuntimeAgentId: record.runtimeAgentId,
      expectedRuntimeWorkspaceId: record.runtimeWorkspaceId,
    },
  );
  await persistPromptCompletion(record.requestId, durableResult);
}

async function reconcilePromptCompletions(snapshot) {
  if (!snapshot) return;
  const metadata = await readAgentMetadata();
  for (const record of Object.values(metadata.completions ?? {})) {
    try {
      await reconcilePromptCompletionRecord(record, snapshot);
    } catch {
      // Leave the durable request and runtime untouched when completion recovery is uncertain.
    }
  }
}

export async function agentCapabilities({ signal } = {}) {
  const definitions = harnessDefinitions();
  let metadata = await collectAgentMetadata();
  const configuredHerdr = configuredHerdrExecutable();
  const herdrPath = await resolveExecutable(configuredHerdr);
  const herdrAvailable = herdrPath !== null;
  const bootstrapMode = herdrBootstrapMode();
  let herdrVersion = null;
  let runtimeError = null;
  if (herdrAvailable) herdrVersion = await inspectVersion(herdrPath);

  let session = { name: herdrSessionName(), running: false, agents: [] };
  if (herdrAvailable && herdrVersion) {
    let snapshot = await snapshotOutcome({ signal, timeoutMs: 2_000 });
    if (snapshot.ok) {
      metadata = await reconcileAgentMetadata(snapshot.result.snapshot, signal);
      await reconcilePromptCompletions(snapshot.result.snapshot);
      metadata = await collectAgentMetadata();
      const refreshedSnapshot = await snapshotOutcome({ signal, timeoutMs: 2_000 });
      if (refreshedSnapshot.ok) snapshot = refreshedSnapshot;
      session = {
        name: herdrSessionName(),
        running: true,
        agents: ownedAgentRecords(snapshot.result.snapshot, metadata).map(({ agent, logical }) => ({
          ...normalizeAgent(agent, logical),
          resume: definitions[logical?.harness ?? agent.agent]?.resume ?? { supported: false },
          resumable: Boolean(logical?.resumable),
        })),
      };
    } else {
      runtimeError = snapshot.error;
    }
  } else if (!herdrAvailable) {
    runtimeError = {
      code: 'herdr_unavailable',
      message: `Herdr executable is unavailable or not executable: ${configuredHerdr}`,
    };
  } else {
    runtimeError = {
      code: 'herdr_version_probe_failed',
      message: `Herdr version probe failed: ${configuredHerdr}`,
    };
  }

  const harnesses = [];
  for (const [kind, definition] of Object.entries(definitions)) {
    const executable = await findExecutable(definition.command);
    harnesses.push({
      kind,
      command: definition.command,
      available: executable !== null,
      path: executable,
      version: await inspectVersion(executable),
      supportsModel: definition.supportsModel,
      supportsEffort: definition.supportsEffort,
      supportedEfforts: definition.supportedEfforts,
      launchPolicy: kind === 'codex' ? codexLaunchPolicy() : { enforced: false },
      skills: await scanSkills(definition.skillRoot),
      resume: definition.resume,
    });
  }

  const activeLogicalIds = new Set(session.agents.map((agent) => agent.agentId));
  for (const logical of Object.values(metadata.agents)) {
    if (!logical?.agentId || activeLogicalIds.has(logical.agentId)) continue;
    if (['starting', 'suspended', 'suspending', 'resuming', 'orphaned', 'quarantined'].includes(logical.lifecycle)) {
      session.agents.push({
        agentId: logical.agentId,
        logicalSessionId: logical.agentId,
        runtimeAgentId: logical.runtimeAgentId ?? null,
        lifecycle: logical.lifecycle,
        harness: logical.harness,
        status: logical.lifecycle === 'suspended' ? 'suspended' : logical.lifecycle,
        interactiveReady: false,
        cwd: logical.cwd,
        foregroundCwd: null,
        workspaceId: null,
        tabId: null,
        paneId: null,
        stateChangeSeq: null,
        nativeSessionId: logical.nativeSessionId ?? null,
        nativeSessionAttribution: logical.nativeSessionAttribution ?? 'unavailable',
        legacy: false,
        resumable: Boolean(
          logical.resumable &&
          logical.policyStatus !== 'unverified' &&
          definitions[logical.harness]?.resume?.supported,
        ),
        ...(logical.harness === 'codex' ? {
          policyStatus: logical.policyStatus ?? 'unverified',
          codexPolicy: logical.codexProvenance?.policy ?? null,
        } : {}),
        resume: definitions[logical.harness]?.resume ?? { supported: false },
      });
    }
  }
  return {
    runtime: {
      kind: 'herdr',
      available: herdrAvailable && herdrVersion !== null,
      path: herdrPath,
      version: herdrVersion,
      bootstrapMode,
      error: runtimeError,
      session,
    },
    harnesses,
  };
}

async function startAgentRuntime(
  {
    agentId,
    runtimeAgentId,
    harness,
    cwd,
    model,
    effort,
    timeoutMs = DEFAULT_START_TIMEOUT_MS,
    nativeSessionId = null,
    codexProvenance = null,
    resuming = false,
  },
  signal,
) {
  const definitions = harnessDefinitions();
  const definition = definitions[harness];
  if (!definition) throw new Error(`Unsupported harness: ${harness}`);
  ({ model, effort } = applyHarnessLaunchPolicy({ harness, model, effort }));
  validateModel(model);
  if (effort && !definition.supportedEfforts.includes(effort)) {
    throw new Error(`Effort ${effort} is not supported for harness ${harness}.`);
  }
  const executable = await findExecutable(definition.command);
  if (!executable) throw new Error(`Harness ${harness} is not installed or not available in PATH.`);
  const resolvedCwd = await resolveCwd(cwd);
  await ensureHerdrSession(signal, { timeoutMs: Math.min(2_000, timeoutMs) });

  if (harness === 'codex') {
    codexProvenance = codexProvenance ?? await prepareCodexProvenance(agentId);
    const compliance = await verifyCodexProvenance({
      agentId,
      harness,
      model,
      effort,
      codexProvenance,
    });
    if (!compliance.ok) throw codexPolicyError({ agentId }, compliance.reason);
  }

  let workspaceId = null;
  let cleanupAttempt = null;
  let nativeLaunchRelease = null;
  let launchMetadataWritten = false;
  if (!resuming) nativeLaunchRelease = await acquireNativeLaunchLock();
  try {
    if (!resuming && harness === 'codex') {
      await updateAgentMetadata(agentId, {
        version: AGENT_METADATA_VERSION,
        agentId,
        harness,
        cwd: resolvedCwd,
        model: model ?? null,
        effort: effort ?? null,
        codexProvenance,
        policyStatus: 'verified',
        nativeSessionId: null,
        nativeSessionAttribution: 'unavailable',
        resumable: false,
        runtimeAgentId,
        runtimeWorkspaceId: null,
        lifecycle: 'starting',
        updatedAt: new Date().toISOString(),
      });
      launchMetadataWritten = true;
    }

    const create = await runHerdr(
      [
        'workspace',
        'create',
        '--cwd',
        resolvedCwd,
        '--label',
        runtimeAgentId,
        '--no-focus',
        ...(harness === 'codex' ? ['--env', `CODEX_HOME=${codexProvenance.codexHome}`] : []),
      ],
      { timeoutMs, signal },
    );
    if (!create.ok) {
      cleanupAttempt = await cleanupWorkspaceByLabel(runtimeAgentId).catch((error) => ({
        cleaned: false,
        error: {
          code: 'cleanup_failed',
          message: error.message,
          stage: 'workspace_discovery',
          workspaceId: null,
          retrySafe: true,
        },
      }));
      throwHerdrFailure(create);
    }

    const createdWorkspaceId = create.result?.workspace?.workspace_id;
    const createdWorkspaceLabel = create.result?.workspace?.label;
    const rootPaneWorkspaceId = create.result?.root_pane?.workspace_id;
    const paneId = create.result?.root_pane?.pane_id;
    if (typeof createdWorkspaceId !== 'string' || createdWorkspaceId.length === 0) {
      const error = new Error('Herdr workspace create response did not include a valid workspace_id.');
      error.code = 'invalid_herdr_response';
      error.herdr = { code: 'invalid_herdr_response', message: error.message };
      throw error;
    }
    if (
      createdWorkspaceLabel !== runtimeAgentId ||
      rootPaneWorkspaceId !== createdWorkspaceId ||
      typeof paneId !== 'string' ||
      paneId.length === 0
    ) {
      const error = new Error('Herdr workspace create response failed workspace identity validation.');
      error.code = 'invalid_herdr_response';
      error.herdr = {
        code: 'invalid_herdr_response',
        message: error.message,
        workspaceId: createdWorkspaceId,
        workspaceLabel: createdWorkspaceLabel ?? null,
        rootPaneWorkspaceId: rootPaneWorkspaceId ?? null,
      };
      throw error;
    }
    workspaceId = createdWorkspaceId;

    if (!resuming && harness === 'codex') {
      await updateAgentMetadata(agentId, (current) => current ? {
        ...current,
        runtimeWorkspaceId: workspaceId,
        updatedAt: new Date().toISOString(),
      } : current);
    }

    const harnessArgs = resuming
      ? definition.buildResumeArgs({ nativeSessionId, model, effort, profile: codexProvenance?.profileName })
      : definition.buildArgs({ model, effort, profile: codexProvenance?.profileName });
    const startArgs = [
      'agent',
      'start',
      runtimeAgentId,
      '--kind',
      harness,
      '--pane',
      paneId,
      '--timeout',
      String(timeoutMs),
    ];
    if (harnessArgs.length > 0) startArgs.push('--', ...harnessArgs);

    const nativeSnapshotBefore = resuming ? null : await captureNativeSessionSnapshot(harness, resolvedCwd, {
      codexHome: codexProvenance?.codexHome,
    });
    const nativeLaunchStartedAt = Date.now();
    const start = await runHerdr(startArgs, { timeoutMs: timeoutMs + 2_000, signal });
    if (!start.ok) {
      const recoveredNativeSessionId = nativeSessionId ?? nativeSessionIdFromAgent(start.result?.agent);
      const recoveredMetadata = {
        version: AGENT_METADATA_VERSION,
        agentId,
        harness,
        cwd: resolvedCwd,
        model: model ?? null,
        effort: effort ?? null,
        ...(harness === 'codex' ? { codexProvenance, policyStatus: 'verified' } : {}),
        nativeSessionId: recoveredNativeSessionId,
        nativeSessionAttribution: recoveredNativeSessionId ? 'backend_reported' : 'unavailable',
        nativeSessionStartedAt: new Date(nativeLaunchStartedAt).toISOString(),
        resumable: Boolean(recoveredNativeSessionId && definition.resume.supported),
        runtimeAgentId,
        runtimeWorkspaceId: workspaceId,
        lifecycle: 'active',
        updatedAt: new Date().toISOString(),
      };
      const recovered = await recoverOwnedAgent(runtimeAgentId);
      if (recovered) {
        await nativeLaunchRelease?.();
        nativeLaunchRelease = null;
        await updateAgentMetadata(agentId, recoveredMetadata);
        const logicalRecovered = await recoverOwnedAgent(agentId);
        return {
          agent: logicalRecovered?.agent ?? recovered.agent,
          startup: {
            ready: false,
            error: start.error,
            interaction: logicalRecovered?.agent.interaction ?? recovered.agent.interaction,
            transient: logicalRecovered?.agent.transient ?? recovered.agent.transient,
          },
          transcript: logicalRecovered?.transcript ?? recovered.transcript,
        };
      }
      throwHerdrFailure(start);
    }

    const backendNativeSessionId = nativeSessionIdFromAgent(start.result?.agent);
    const nativeDiscovery = resuming
      ? { sessionId: nativeSessionId, attribution: 'verified' }
      : backendNativeSessionId
        ? { sessionId: backendNativeSessionId, attribution: 'backend_reported' }
        : await discoverNativeSessionId(nativeSnapshotBefore, harness, resolvedCwd, nativeLaunchStartedAt, {
          codexHome: codexProvenance?.codexHome,
        });
    await updateAgentMetadata(agentId, {
      version: AGENT_METADATA_VERSION,
      agentId,
      harness,
      cwd: resolvedCwd,
      model: model ?? null,
      effort: effort ?? null,
      ...(harness === 'codex' ? { codexProvenance, policyStatus: 'verified' } : {}),
      nativeSessionId: nativeDiscovery.sessionId,
      nativeSessionAttribution: nativeDiscovery.attribution,
      nativeSessionStartedAt: resuming ? null : new Date(nativeLaunchStartedAt).toISOString(),
      resumable: Boolean(nativeDiscovery.sessionId && definition.resume.supported),
      runtimeAgentId,
      runtimeWorkspaceId: workspaceId,
      lifecycle: 'active',
      updatedAt: new Date().toISOString(),
    });
    if (!resuming) launchMetadataWritten = true;
    await nativeLaunchRelease?.();
    nativeLaunchRelease = null;

    if (definition.startupGraceMs > 0) {
      signal?.throwIfAborted?.();
      await sleepWithSignal(Math.min(definition.startupGraceMs, timeoutMs), signal);
    }

    try {
      const settled = await waitForAgentSettled(agentId, {
        signal,
        maxWaitMs: Math.min(10_000, timeoutMs),
        verifyOwnership: true,
      });
      const transcript = await readAgentText(settled.runtimeAgentId, {
        source: 'visible',
        lines: 120,
        signal,
        timeoutMs: Math.min(DEFAULT_COMMAND_TIMEOUT_MS, timeoutMs),
      });
      const failure = readinessFailure(settled);
      return {
        agent: settled,
        startup: {
          ready: failure === null,
          error: failure,
          interaction: settled.interaction,
          transient: settled.transient,
        },
        transcript,
      };
    } catch (error) {
      const recovered = await recoverOwnedAgent(agentId);
      if (recovered) {
        return {
          agent: recovered.agent,
          startup: {
            ready: false,
            error: {
              code: error.code ?? error.herdr?.code ?? 'startup_observation_failed',
              message: error.message,
            },
            interaction: recovered.agent.interaction,
            transient: recovered.agent.transient,
          },
          transcript: recovered.transcript,
        };
      }
      throw error;
    }
  } catch (error) {
    if (nativeLaunchRelease) {
      await nativeLaunchRelease().catch(() => {});
      nativeLaunchRelease = null;
    }
    if (!cleanupAttempt?.cleaned) {
      cleanupAttempt = await (workspaceId !== null
        ? cleanupWorkspaceById(workspaceId)
        : cleanupWorkspaceByLabel(runtimeAgentId)
      ).catch((cleanupError) => ({
        cleaned: false,
        error: {
          code: 'cleanup_failed',
          message: cleanupError.message,
          stage: workspaceId !== null ? 'workspace_close' : 'workspace_discovery',
          workspaceId,
          retrySafe: true,
        },
      }));
    }
    if (!cleanupAttempt.cleaned) attachCleanupFailure(error, cleanupAttempt.error);
    if (launchMetadataWritten && !resuming) {
      if (cleanupAttempt.cleaned) {
        await updateAgentMetadata(agentId, null).catch(() => {});
      } else {
        await updateAgentMetadata(agentId, (current) => current ? {
          ...current,
          lifecycle: 'quarantined',
          policyStatus: 'unverified',
          quarantineReason: `Codex launch failed and cleanup was not confirmed: ${error.message}`,
          terminalAt: current.terminalAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } : current).catch(() => {});
      }
    }
    throw error;
  }
}

export async function agentStart({ harness, cwd, model, effort, timeoutMs = DEFAULT_START_TIMEOUT_MS }, signal) {
  const agentId = `agent-${randomUUID().replaceAll('-', '').slice(0, 26)}`;
  return await withLifecycleLock(agentId, async () => await startAgentRuntime(
    { agentId, runtimeAgentId: agentId, harness, cwd, model, effort, timeoutMs },
    signal,
  ));
}

// Kept outside the MCP tool surface so the metadata serialization contract can be tested without a harness.
export async function __testUpdateAgentMetadata(agentId, update) {
  return await updateAgentMetadata(agentId, update);
}

export async function __testCollectAgentMetadata() {
  return await collectAgentMetadata();
}

export async function agentGet({ agentId }, signal) {
  const metadata = await reconcileBeforeOperation(signal);
  const durable = metadata.agents[agentId];
  if (durable && durable.lifecycle !== 'active') {
    return durableAgentState(durable, harnessDefinitions()[durable.harness]);
  }
  return await getAgentState(agentId, { signal, includeInteraction: true, verifyOwnership: true });
}

export async function agentRead({ agentId, source = 'recent-unwrapped', lines = 120 }, signal) {
  const owned = await requireOwnedAgent(agentId, { signal });
  const text = await readAgentText(owned.runtimeAgentId, { source, lines, signal });
  await requireOwnedAgent(agentId, { signal });
  return { agentId, source, lines: Math.max(1, Math.min(MAX_AGENT_READ_LINES, lines)), text };
}

async function refreshNativeSessionAfterPrompt(agentId, completedAgent, signal) {
  if (completedAgent?.status !== 'done') return { state: 'skipped' };

  try {
    const metadata = await readAgentMetadata();
    const record = metadata.agents[agentId] ?? null;
    if (!record || record.lifecycle !== 'active' || record.nativeSessionId) return { state: 'skipped' };

    const definition = harnessDefinitions()[record.harness];
    if (!definition?.resume?.supported) return { state: 'unsupported' };

    const owned = await requireOwnedAgent(agentId, { signal, timeoutMs: 5_000 });
    const backendNativeSessionId = nativeSessionIdFromAgent(owned.agent);
    let discovery = backendNativeSessionId
      ? { sessionId: backendNativeSessionId, attribution: 'backend_reported' }
      : null;

    if (!discovery) {
      const startedAt = Date.parse(record.nativeSessionStartedAt ?? '');
      if (!Number.isFinite(startedAt)) return { state: 'unavailable' };
      discovery = await discoverNativeSessionId(new Map(), record.harness, record.cwd, startedAt, {
        codexHome: record.codexProvenance?.codexHome,
      });
    }

    if (!discovery.sessionId) {
      if (discovery.attribution === 'ambiguous') {
        await updateAgentMetadata(agentId, (current) => (
          current && current.lifecycle === 'active' && !current.nativeSessionId
            ? { ...current, nativeSessionAttribution: 'ambiguous', resumable: false, updatedAt: new Date().toISOString() }
            : current
        ));
        return { state: 'ambiguous', candidates: discovery.candidates ?? [] };
      }
      return { state: 'unavailable' };
    }

    await updateAgentMetadata(agentId, (current) => (
      current && current.lifecycle === 'active' && !current.nativeSessionId
        ? {
            ...current,
            nativeSessionId: discovery.sessionId,
            nativeSessionAttribution: discovery.attribution,
            resumable: true,
            updatedAt: new Date().toISOString(),
          }
        : current
    ));
    return { state: 'resolved', sessionId: discovery.sessionId, attribution: discovery.attribution };
  } catch (error) {
    return {
      state: 'error',
      error: {
        code: error?.herdr?.code ?? error?.code ?? 'native_session_refresh_failed',
        message: error?.message ?? String(error),
      },
    };
  }
}

async function finalizeCompletedPromptRuntime(
  agentId,
  completedAgent,
  signal,
  { alreadyReconciled = false, expectedRuntimeAgentId = null, expectedRuntimeWorkspaceId = null } = {},
) {
  if (completedAgent?.status !== 'done') {
    return { action: 'retained', reason: 'status_not_done', status: completedAgent?.status ?? 'unknown' };
  }

  try {
    return await withLifecycleLock(agentId, async () => {
      const metadata = alreadyReconciled ? await collectAgentMetadata() : await reconcileBeforeOperation(signal);
      const record = metadata.agents[agentId] ?? null;
      if (!record || record.lifecycle !== 'active') {
        return {
          action: 'already_finalized',
          lifecycle: record?.lifecycle ?? null,
        };
      }
      if (
        (expectedRuntimeAgentId && record.runtimeAgentId !== expectedRuntimeAgentId) ||
        (expectedRuntimeWorkspaceId && record.runtimeWorkspaceId !== expectedRuntimeWorkspaceId)
      ) {
        return {
          action: 'retained',
          reason: 'runtime_generation_changed',
          status: completedAgent?.status ?? 'unknown',
        };
      }

      const owned = await requireOwnedAgent(agentId, { signal, timeoutMs: 5_000 });
      if (
        (expectedRuntimeAgentId && owned.runtimeAgentId !== expectedRuntimeAgentId) ||
        (expectedRuntimeWorkspaceId && owned.workspace.workspace_id !== expectedRuntimeWorkspaceId)
      ) {
        return {
          action: 'retained',
          reason: 'runtime_generation_changed',
          status: owned.agent.agent_status ?? 'unknown',
        };
      }
      if (owned.agent.agent_status !== 'done') {
        return {
          action: 'retained',
          reason: 'status_changed',
          status: owned.agent.agent_status ?? 'unknown',
        };
      }

      const workspaceId = owned.workspace.workspace_id;
      const verify = await runHerdr(['workspace', 'get', workspaceId], { timeoutMs: 5_000, signal });
      if (!verify.ok) throwHerdrFailure(verify);
      if (verify.result.workspace?.label !== owned.runtimeAgentId) {
        const error = new Error(`Workspace ${workspaceId} is no longer owned by runtime agent ${owned.runtimeAgentId}.`);
        error.code = 'agent_not_managed';
        throw error;
      }

      const latest = await requireOwnedAgent(agentId, { signal, timeoutMs: 5_000 });
      if (
        latest.runtimeAgentId !== owned.runtimeAgentId ||
        latest.workspace.workspace_id !== workspaceId ||
        latest.agent.workspace_id !== workspaceId ||
        (expectedRuntimeAgentId && latest.runtimeAgentId !== expectedRuntimeAgentId) ||
        (expectedRuntimeWorkspaceId && latest.workspace.workspace_id !== expectedRuntimeWorkspaceId)
      ) {
        const error = new Error(`Agent ${agentId} changed workspace before completion cleanup.`);
        error.code = 'agent_not_managed';
        throw error;
      }
      if (latest.agent.agent_status !== 'done') {
        return {
          action: 'retained',
          reason: 'status_changed',
          status: latest.agent.agent_status ?? 'unknown',
        };
      }

      const definition = harnessDefinitions()[record.harness];
      const resumable = Boolean(record.resumable && record.nativeSessionId && definition?.resume?.supported);
      if (resumable) {
        await updateAgentMetadata(agentId, {
          ...record,
          lifecycle: 'suspending',
          runtimeWorkspaceId: workspaceId,
          updatedAt: new Date().toISOString(),
        });
        const outcome = await runHerdr(['workspace', 'close', workspaceId], { timeoutMs: 30_000, signal });
        if (!outcome.ok) throwHerdrFailure(outcome);
        await verifyRuntimeClosed(owned.runtimeAgentId, workspaceId);
        await updateAgentMetadata(agentId, {
          ...record,
          lifecycle: 'suspended',
          runtimeAgentId: null,
          runtimeWorkspaceId: null,
          lastRuntimeAgentId: owned.runtimeAgentId,
          lastWorkspaceId: workspaceId,
          updatedAt: new Date().toISOString(),
        });
        return {
          action: 'suspended',
          agentId,
          harness: record.harness,
          workspaceId,
          runtimeAgentId: owned.runtimeAgentId,
          nativeSessionId: record.nativeSessionId,
        };
      }

      const outcome = await runHerdr(['workspace', 'close', workspaceId], { timeoutMs: 30_000, signal });
      if (!outcome.ok) throwHerdrFailure(outcome);
      await verifyRuntimeClosed(owned.runtimeAgentId, workspaceId);
      await updateAgentMetadata(agentId, null);
      return {
        action: 'stopped',
        agentId,
        harness: record.harness,
        workspaceId,
        runtimeAgentId: owned.runtimeAgentId,
        discarded: true,
      };
    });
  } catch (error) {
    const metadata = await readAgentMetadata().catch(() => null);
    return {
      action: 'cleanup_failed',
      lifecycle: metadata?.agents?.[agentId]?.lifecycle ?? null,
      error: {
        code: error?.herdr?.code ?? error?.code ?? 'agent_completion_cleanup_failed',
        message: error?.message ?? String(error),
        retryable: true,
      },
    };
  }
}

function normalizePromptRequest({ agentId, task, skills = [], wait = true, until = [], timeoutMs = 120_000, requestId }) {
  const normalizedRequestId = normalizePromptRequestId(requestId);
  const normalized = { agentId, task, skills, wait, until, timeoutMs, requestId: normalizedRequestId };
  return { ...normalized, fingerprint: promptRequestFingerprint(normalized) };
}

function promptBusyResponse({ agentId, requestId, record }) {
  return {
    accepted: null,
    requestId,
    submission: { state: 'possibly_submitted', retrySafe: false, waitCompleted: false },
    error: {
      code: 'agent_prompt_in_flight',
      message: `Agent ${agentId} already has prompt request ${record?.requestId ?? 'another request'} in flight or awaiting completion. The new task was not submitted; do not automatically retry it.`,
      retryable: false,
      ...(record?.requestId ? { existingRequestId: record.requestId } : {}),
    },
    agent: null,
    transcript: '',
  };
}

function promptRequestConflictResponse({ requestId, record }) {
  return {
    accepted: null,
    requestId,
    submission: { state: 'possibly_submitted', retrySafe: false, waitCompleted: false },
    error: {
      code: 'agent_prompt_request_conflict',
      message: `Prompt request ${requestId} was already used for a different task payload; refusing to submit an ambiguous duplicate.`,
      retryable: false,
      existingRequestId: record?.requestId ?? requestId,
    },
    agent: null,
    transcript: '',
  };
}

async function joinPromptOperation(operation, signal, timeoutMs) {
  try {
    return await waitForOperation(operation.promise, signal, timeoutMs, 'Timed out waiting for the existing prompt request.');
  } catch (error) {
    const recovered = await readPromptCompletion(operation.requestId).catch(() => null);
    if (recovered && recovered.state !== 'in_flight') return promptCompletionResponse(recovered, { recovered: true });
    throw error;
  }
}

async function runAgentPrompt(
  { agentId, task, skills = [], wait = true, until = [], timeoutMs = 120_000, requestId, fingerprint },
  signal,
) {
  if (!wait && until.length > 0) throw new Error('until requires wait=true.');

  const preflightRetryable = (error) => {
    if (typeof error?.retryable === 'boolean') return error.retryable;
    const code = error?.herdr?.code ?? error?.code;
    return ['timeout', 'deadline_exceeded', 'herdr_unavailable', 'spawn_failed'].includes(code);
  };
  const notSubmitted = (error, { agent = null, transcript = '', retryable = preflightRetryable(error) } = {}) => ({
    accepted: false,
    requestId,
    submission: { state: 'not_submitted', retrySafe: true, waitCompleted: false },
    error: {
      code: 'agent_prompt_not_submitted',
      message: 'Prompt was not submitted because Agent Runtime preflight failed.',
      retryable,
      cause: error?.herdr ?? {
        code: error?.code ?? 'agent_preflight_failed',
        message: error?.message ?? String(error),
      },
    },
    agent,
    transcript,
  });
  const throwIfCancelled = (error) => {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
  };

  let existing = await readPromptCompletion(requestId);
  if (existing) {
    if (existing.agentId !== agentId || existing.fingerprint !== fingerprint) {
      return promptRequestConflictResponse({ requestId, record: existing });
    }
    if (promptCompletionNeedsReconciliation(existing)) {
      await reconcileBeforeOperation(signal, { timeoutMs: Math.min(2_000, timeoutMs) }).catch(() => {});
      existing = await readPromptCompletion(requestId) ?? existing;
    }
    return promptCompletionResponse(existing, { recovered: true });
  }

  const preflightDeadline = Date.now() + Math.min(10_000, timeoutMs);
  try {
    await reconcileBeforeOperation(signal, { timeoutMs: Math.min(2_000, timeoutMs) });
  } catch (error) {
    throwIfCancelled(error);
    return notSubmitted(error);
  }
  const metadataAfterReconcile = await readAgentMetadata();
  const durableBusy = blockingPromptCompletion(metadataAfterReconcile, agentId, requestId);
  if (durableBusy) return promptBusyResponse({ agentId, requestId, record: durableBusy });
  const remainingPreflightMs = () => {
    const remaining = preflightDeadline - Date.now();
    if (remaining <= 0) throw timeoutError('Agent prompt preflight timed out before submission.');
    return remaining;
  };

  let before;
  try {
    before = await waitForAgentSettled(agentId, {
      signal,
      maxWaitMs: remainingPreflightMs(),
      verifyOwnership: true,
    });
  } catch (error) {
    throwIfCancelled(error);
    return notSubmitted(error);
  }

  const gate = readinessFailure(before);
  if (gate) {
    let transcript = '';
    if (Date.now() < preflightDeadline) {
      const diagnostic = await readAgentTextOutcome(before.runtimeAgentId, {
        source: 'recent-unwrapped',
        lines: 120,
        signal,
        timeoutMs: Math.min(2_000, remainingPreflightMs()),
      });
      transcript = diagnostic.ok ? diagnostic.text : '';
    }
    return {
      accepted: false,
      requestId,
      submission: { state: 'not_submitted', retrySafe: true, waitCompleted: false },
      error: gate,
      agent: before,
      transcript,
    };
  }

  try {
    await waitForOperation(
      validateSkills(before.harness, skills),
      signal,
      remainingPreflightMs(),
      'Agent prompt preflight timed out while validating skills.',
    );
  } catch (error) {
    throwIfCancelled(error);
    return notSubmitted(error, { agent: before });
  }

  let finalState;
  try {
    finalState = await getAgentState(agentId, {
      signal,
      includeInteraction: true,
      verifyOwnership: true,
      timeoutMs: Math.min(DEFAULT_COMMAND_TIMEOUT_MS, remainingPreflightMs()),
    });
    remainingPreflightMs();
  } catch (error) {
    throwIfCancelled(error);
    return notSubmitted(error, { agent: before });
  }

  const finalGate = readinessFailure(finalState);
  if (finalGate) {
    return {
      accepted: false,
      requestId,
      submission: { state: 'not_submitted', retrySafe: true, waitCompleted: false },
      error: finalGate,
      agent: finalState,
      transcript: '',
    };
  }

  const prompt = promptWithSkills(task, skills);
  const args = ['agent', 'prompt', finalState.runtimeAgentId, prompt];
  if (wait) args.push('--wait');
  for (const status of until) args.push('--until', status);
  if (wait) args.push('--timeout', String(timeoutMs));

  try {
    remainingPreflightMs();
  } catch (error) {
    return notSubmitted(error, { agent: finalState });
  }

  const claim = await claimPromptCompletion({
    requestId,
    fingerprint,
    agentId,
    harness: finalState.harness,
    cwd: finalState.cwd,
    runtimeAgentId: finalState.runtimeAgentId,
    runtimeWorkspaceId: finalState.workspaceId,
    initialStateChangeSeq: finalState.stateChangeSeq,
    skills,
    wait,
    until,
  });
  if (claim.kind === 'conflict') return promptRequestConflictResponse({ requestId, record: claim.record });
  if (claim.kind === 'busy') return promptBusyResponse({ agentId, requestId, record: claim.record });
  if (claim.kind === 'existing') return promptCompletionResponse(claim.record, { recovered: true });
  if (claim.kind === 'generation_mismatch') {
    const error = new Error(`Agent ${agentId} changed runtime generation before prompt claim.`);
    error.code = 'agent_runtime_generation_changed';
    return notSubmitted(error, { agent: finalState, retryable: true });
  }

  try {
    await verifyPromptClaimGeneration(claim.record, signal, Math.min(DEFAULT_COMMAND_TIMEOUT_MS, remainingPreflightMs()));
  } catch (error) {
    throwIfCancelled(error);
    await updatePromptCompletion(requestId, (current) => (
      current?.completionId === claim.record.completionId && current.state === 'in_flight' ? null : current
    ));
    return notSubmitted(error, { agent: finalState, retryable: true });
  }

  args[3] = `${prompt}\n\n[${claim.record.submissionMarker}]`;
  const outcome = await runHerdr(args, {
    timeoutMs: wait ? timeoutMs + 2_000 : 10_000,
    signal,
    deadlineAt: preflightDeadline,
  });
  if (outcome.process !== null && !outcome.process?.spawnError) {
    await updatePromptCompletion(requestId, (current) => current?.completionId === claim.record.completionId ? {
      ...current,
      dispatchState: 'started',
      submittedAt: current.submittedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } : current);
  }
  if (!outcome.ok) {
    const diagnostics = await safePromptDiagnostics(agentId);
    if (outcome.process === null || outcome.process?.spawnError || outcome.error?.code === 'herdr_unavailable') {
      await updatePromptCompletion(requestId, (current) => current?.state === 'in_flight' ? null : current);
      return notSubmitted(
        Object.assign(new Error('Prompt was not submitted because the Herdr command could not be started.'), {
          herdr: outcome.error,
        }),
        diagnostics,
      );
    }
    const uncertain = {
      accepted: null,
      requestId,
      completionId: claim.record.completionId,
      submission: {
        state: 'possibly_submitted',
        retrySafe: false,
        waitCompleted: false,
      },
      error: {
        code: 'agent_prompt_outcome_unknown',
        message: 'Prompt submission may have occurred, but completion could not be confirmed. Do not automatically retry this task.',
        retryable: false,
        cause: outcome.error,
      },
      agent: diagnostics.agent,
      transcript: diagnostics.transcript,
    };
    await updatePromptCompletion(requestId, (current) => current?.state === 'in_flight' ? {
      ...current,
      state: 'uncertain',
      updatedAt: new Date().toISOString(),
      result: uncertain,
    } : current);
    if (wait && READY_STATUSES.has(diagnostics.agent?.status)) {
      const snapshot = await snapshotOutcome({ timeoutMs: 5_000 });
      if (snapshot.ok) {
        await reconcilePromptCompletionRecord(
          await readPromptCompletion(requestId) ?? {
            ...claim.record,
            state: 'uncertain',
            result: uncertain,
          },
          snapshot.result.snapshot,
          { allowLocal: true },
        );
        const recovered = await readPromptCompletion(requestId);
        if (recovered?.state === 'completed') {
          if (signal?.aborted && recovered.finalStatus === 'done') throw abortError();
          return promptCompletionResponse(recovered, { recovered: true });
        }
      }
    }
    return uncertain;
  }

  await updatePromptCompletion(requestId, (current) => current?.completionId === claim.record.completionId ? {
    ...current,
    dispatchState: 'confirmed',
    submittedAt: current.submittedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } : current);
  const diagnostics = await safePromptDiagnostics(agentId);
  const nativeSessionRefresh = wait
    ? await refreshNativeSessionAfterPrompt(agentId, diagnostics.agent)
    : { state: 'skipped' };
  const shouldFinalize = wait && diagnostics.agent?.status === 'done' && !['error', 'ambiguous'].includes(nativeSessionRefresh.state);
  const runtimeDisposition = !wait
    ? { action: 'retained', reason: 'wait_disabled', status: diagnostics.agent?.status ?? 'unknown' }
    : nativeSessionRefresh.state === 'error'
      ? {
          action: 'retained',
          reason: 'native_session_refresh_failed',
          status: diagnostics.agent?.status ?? 'unknown',
          error: nativeSessionRefresh.error,
        }
      : nativeSessionRefresh.state === 'ambiguous'
        ? {
            action: 'retained',
            reason: 'native_session_ambiguous',
            status: diagnostics.agent?.status ?? 'unknown',
            candidates: nativeSessionRefresh.candidates,
          }
        : shouldFinalize
          ? { action: 'pending', status: 'done' }
          : { action: 'retained', reason: 'status_not_done', status: diagnostics.agent?.status ?? 'unknown' };
  const completed = {
    accepted: true,
    requestId,
    completionId: claim.record.completionId,
    submission: { state: 'submitted', retrySafe: false, waitCompleted: wait },
    skills,
    agent: diagnostics.agent,
    transcript: diagnostics.transcript,
    runtimeDisposition,
  };
  await persistPromptCompletion(requestId, completed, {
    finalStatus: diagnostics.agent?.status ?? 'unknown',
  });
  if (shouldFinalize) {
    completed.runtimeDisposition = await finalizeCompletedPromptRuntime(
      agentId,
      diagnostics.agent,
      undefined,
      {
        alreadyReconciled: true,
        expectedRuntimeAgentId: claim.record.runtimeAgentId,
        expectedRuntimeWorkspaceId: claim.record.runtimeWorkspaceId,
      },
    );
    await persistPromptCompletion(requestId, completed, {
      finalStatus: diagnostics.agent?.status ?? 'done',
    });
  }
  if (signal?.aborted) throw abortError();
  return completed;
}

export async function agentPrompt(args, signal) {
  const request = normalizePromptRequest(args);
  const existing = promptOperations.get(request.agentId);
  if (existing) {
    if (existing.requestId !== request.requestId || existing.fingerprint !== request.fingerprint) {
      return promptBusyResponse({
        agentId: request.agentId,
        requestId: request.requestId,
        record: { requestId: existing.requestId },
      });
    }
    return await joinPromptOperation(existing, signal, request.timeoutMs);
  }

  const operation = runAgentPrompt(request, signal);
  const entry = {
    requestId: request.requestId,
    fingerprint: request.fingerprint,
    promise: operation,
  };
  promptOperations.set(request.agentId, entry);
  promptAgentsInFlight.add(request.agentId);
  try {
    return await operation;
  } finally {
    if (promptOperations.get(request.agentId) === entry) promptOperations.delete(request.agentId);
    promptAgentsInFlight.delete(request.agentId);
  }
}

export async function agentPromptResult({ requestId, agentId, ack = false }, signal) {
  if (requestId !== undefined && (typeof requestId !== 'string' || !PROMPT_REQUEST_ID_PATTERN.test(requestId))) {
    const error = new Error('requestId must be a stable single-line identifier up to 128 characters.');
    error.code = 'agent_invalid_request_id';
    throw error;
  }
  if (requestId === undefined && !agentId) {
    const error = new Error('agent_prompt_result requires requestId or agentId.');
    error.code = 'agent_result_identity_required';
    throw error;
  }

  let metadata = await readAgentMetadata();
  let record = requestId ? metadata.completions[requestId] ?? null : null;
  if ((record && promptCompletionNeedsReconciliation(record)) || (!record && agentId)) {
    await reconcileBeforeOperation(signal, { timeoutMs: 2_000 }).catch(() => {});
    metadata = await readAgentMetadata();
    record = requestId ? metadata.completions[requestId] ?? null : null;
  }
  if (!record && agentId) {
    const candidates = Object.values(metadata.completions)
      .filter((candidate) => candidate.agentId === agentId && !candidate.acknowledgedAt)
      .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''));
    if (candidates.length > 1) {
      return {
        found: false,
        agentId,
        state: 'ambiguous',
        candidates: candidates.map((candidate) => ({
          requestId: candidate.requestId,
          completionId: candidate.completionId,
          state: candidate.state,
          updatedAt: candidate.updatedAt,
        })),
      };
    }
    record = candidates[0] ?? null;
  }
  if (!record || (agentId && record.agentId !== agentId)) {
    return { found: false, requestId: requestId ?? null, agentId: agentId ?? null, state: 'not_found' };
  }

  if (ack && record.state === 'in_flight') {
    return {
      found: true,
      completion: {
        completionId: record.completionId,
        requestId: record.requestId,
        agentId: record.agentId,
        state: record.state,
        acknowledged: false,
        completedAt: record.completedAt,
      },
      result: promptCompletionResponse(record, { recovered: true }),
      acked: false,
      ackError: {
        code: 'agent_result_not_complete',
        message: 'The durable prompt result is not complete and cannot be acknowledged yet.',
      },
    };
  }

  if (ack && !record.acknowledgedAt) {
    record = await updatePromptCompletion(record.requestId, (current) => current ? {
      ...current,
      acknowledgedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } : current) ?? record;
  }
  return {
    found: true,
    completion: {
      completionId: record.completionId,
      requestId: record.requestId,
      agentId: record.agentId,
      state: record.state,
      acknowledged: record.acknowledgedAt !== null,
      completedAt: record.completedAt,
      updatedAt: record.updatedAt,
    },
    result: promptCompletionResponse(record, { recovered: true }),
    acked: Boolean(ack),
  };
}

export async function agentSendKeys({ agentId, keys }, signal) {
  const state = await getAgentState(agentId, {
    signal,
    includeInteraction: false,
    verifyOwnership: true,
    timeoutMs: 5_000,
  });
  const outcome = await runHerdr(['agent', 'send-keys', state.runtimeAgentId, ...keys], { timeoutMs: 10_000, signal });
  if (!outcome.ok) throwHerdrFailure(outcome);
  await sleepWithSignal(250, signal);
  return await getAgentState(agentId, { signal, includeInteraction: true, verifyOwnership: true, timeoutMs: 5_000 });
}

function durableAgentState(record, definition) {
  return {
    agentId: record.agentId,
    logicalSessionId: record.agentId,
    runtimeAgentId: record.runtimeAgentId ?? null,
    lifecycle: record.lifecycle,
    harness: record.harness,
    status: record.lifecycle === 'suspended' ? 'suspended' : record.lifecycle,
    interactiveReady: false,
    cwd: record.cwd,
    foregroundCwd: null,
    workspaceId: null,
    tabId: null,
    paneId: null,
    stateChangeSeq: null,
    nativeSessionId: record.nativeSessionId ?? null,
    nativeSessionAttribution: record.nativeSessionAttribution ?? 'unavailable',
    legacy: false,
    resumable: Boolean(
      record.resumable &&
      record.policyStatus !== 'unverified' &&
      definition?.resume?.supported,
    ),
    interaction: null,
    transient: null,
    screenReliable: false,
    screenError: null,
    ...(record.harness === 'codex' ? {
      policyStatus: record.policyStatus ?? 'unverified',
      codexPolicy: record.codexProvenance?.policy ?? null,
    } : {}),
    resume: definition?.resume ?? { supported: false },
  };
}

async function verifyRuntimeClosed(runtimeAgentId, workspaceId) {
  const snapshot = await snapshotOutcome({ timeoutMs: 5_000 });
  if (!snapshot.ok) throwHerdrFailure(snapshot);
  const workspacePresent = (snapshot.result.snapshot.workspaces ?? []).some((workspace) => workspace.workspace_id === workspaceId);
  const agentPresent = (snapshot.result.snapshot.agents ?? []).some((agent) => agent.name === runtimeAgentId);
  if (workspacePresent || agentPresent) {
    const error = new Error(`Herdr runtime ${runtimeAgentId} was not fully closed during suspend.`);
    error.code = 'agent_runtime_close_unconfirmed';
    throw error;
  }
}

export async function agentSuspend({ agentId }, signal) {
  return await withLifecycleLock(agentId, async () => {
    const metadata = await reconcileBeforeOperation(signal, { reconcileCompletions: false });
    let record = metadata.agents[agentId];
    if (!record) {
      await requireOwnedAgent(agentId, { signal, timeoutMs: 5_000 });
      const error = new Error(`Legacy agent ${agentId} has no durable native session metadata; restart it under the new runtime to enable suspend/resume.`);
      error.code = 'agent_native_session_unavailable';
      throw error;
    }
    const definition = record ? harnessDefinitions()[record.harness] : null;
    if (record?.harness === 'codex') {
      const compliance = await verifyCodexProvenance(record);
      if (!compliance.ok) {
        await quarantineCodexRecord(record, compliance.reason, null, signal);
        throw codexPolicyError(record, compliance.reason);
      }
    }
    if (record?.lifecycle === 'suspended') {
      return { agentId, harness: record.harness, suspended: true, alreadySuspended: true, runtimeAgentId: null };
    }
    if (record && record.lifecycle !== 'active') {
      const error = new Error(`Agent ${agentId} is in lifecycle state ${record.lifecycle} and cannot be suspended.`);
      error.code = 'agent_invalid_transition';
      throw error;
    }
    if (!definition?.resume?.supported) {
      const error = new Error(definition?.resume?.reason ?? `Harness ${record?.harness ?? 'unknown'} does not support verified native resume.`);
      error.code = 'agent_resume_unsupported';
      throw error;
    }
    if (!record?.nativeSessionId) {
      const reason = record.nativeSessionAttribution === 'ambiguous' ? 'native session attribution is ambiguous' : 'no verified native session ID is available';
      const error = new Error(`Agent ${agentId} has ${reason}; suspend would not be safely resumable.`);
      error.code = 'agent_native_session_unavailable';
      throw error;
    }
    const durablePromptInFlight = blockingPromptLifecycleCompletion(metadata, agentId);
    if (promptAgentsInFlight.has(agentId) || durablePromptInFlight) {
      throw promptLifecycleBlockedError(agentId, durablePromptInFlight ?? { requestId: 'process-local' });
    }

    const owned = await requireOwnedAgent(agentId, { signal, timeoutMs: 5_000 });
    if (!READY_STATUSES.has(owned.agent.agent_status)) {
      const error = new Error(`Agent ${agentId} is not suspendable while Herdr status is ${owned.agent.agent_status}. Finish or settle the task first.`);
      error.code = 'agent_not_suspendable';
      throw error;
    }
    const workspaceId = owned.workspace.workspace_id;
    const verify = await runHerdr(['workspace', 'get', workspaceId], { timeoutMs: 5_000, signal });
    if (!verify.ok) throwHerdrFailure(verify);
    if (verify.result.workspace?.label !== owned.runtimeAgentId) {
      const error = new Error(`Workspace ${workspaceId} is no longer owned by runtime agent ${owned.runtimeAgentId}.`);
      error.code = 'agent_not_managed';
      throw error;
    }

    await reserveLifecycleTransition(agentId, {
      from: 'active',
      to: 'suspending',
      runtimeAgentId: owned.runtimeAgentId,
      runtimeWorkspaceId: workspaceId,
    });
    const outcome = await runHerdr(['workspace', 'close', workspaceId], { timeoutMs: 30_000, signal });
    if (!outcome.ok) {
      throwHerdrFailure(outcome);
    }
    await verifyRuntimeClosed(owned.runtimeAgentId, workspaceId);
    await updateAgentMetadata(agentId, {
      ...record,
      lifecycle: 'suspended',
      runtimeAgentId: null,
      runtimeWorkspaceId: null,
      lastRuntimeAgentId: owned.runtimeAgentId,
      lastWorkspaceId: workspaceId,
      updatedAt: new Date().toISOString(),
    });
    return {
      agentId,
      harness: record.harness,
      workspaceId,
      runtimeAgentId: owned.runtimeAgentId,
      suspended: true,
    };
  });
}

export async function agentResume({ agentId }, signal) {
  return await withLifecycleLock(agentId, async () => {
    const metadata = await reconcileBeforeOperation(signal, { reconcileCompletions: false });
    const record = metadata.agents[agentId];
    if (!record) {
      const error = new Error(`Agent ${agentId} is not a durable MCP-managed logical agent.`);
      error.code = 'agent_not_managed';
      throw error;
    }
    const blockingPrompt = blockingPromptLifecycleCompletion(metadata, agentId);
    if (blockingPrompt) throw promptLifecycleBlockedError(agentId, blockingPrompt);
    const definition = harnessDefinitions()[record.harness];
    if (record.harness === 'codex') {
      const compliance = await verifyCodexProvenance(record);
      if (!compliance.ok) {
        await quarantineCodexRecord(record, compliance.reason, null, signal);
        throw codexPolicyError(record, compliance.reason);
      }
    }
    if (record.lifecycle === 'active') {
      const state = await getAgentState(agentId, { signal, includeInteraction: true, verifyOwnership: true });
      return { ...state, resumed: false, alreadyResumed: true };
    }
    if (record.lifecycle !== 'suspended') {
      const error = new Error(`Agent ${agentId} is in lifecycle state ${record.lifecycle} and cannot be resumed.`);
      error.code = 'agent_invalid_transition';
      throw error;
    }
    if (!definition?.resume?.supported) {
      const error = new Error(definition?.resume?.reason ?? `Harness ${record.harness} does not support verified native resume.`);
      error.code = 'agent_resume_unsupported';
      throw error;
    }
    if (!record.nativeSessionId) {
      const error = new Error(`Agent ${agentId} has no durable native ${record.harness} session ID and cannot be resumed safely.`);
      error.code = 'agent_native_session_unavailable';
      throw error;
    }
    const runtimeAgentId = `agent-${randomUUID().replaceAll('-', '').slice(0, 26)}`;
    const reserved = await reserveLifecycleTransition(agentId, {
      from: 'suspended',
      to: 'resuming',
      runtimeAgentId: null,
      runtimeWorkspaceId: null,
    });
    await updateAgentMetadata(agentId, {
      ...reserved,
      runtimeAgentId,
      runtimeWorkspaceId: null,
      updatedAt: new Date().toISOString(),
    });
    try {
      const result = await startAgentRuntime({
        agentId,
        runtimeAgentId,
        harness: record.harness,
        cwd: record.cwd,
        model: record.model ?? undefined,
        effort: record.effort ?? undefined,
        codexProvenance: record.codexProvenance ?? null,
        nativeSessionId: record.nativeSessionId,
        resuming: true,
      }, signal);
      return { ...result, resumed: true, logicalAgentId: agentId, nativeSessionId: record.nativeSessionId };
    } catch (error) {
      if (!error?.cleanup) {
        await updateAgentMetadata(agentId, {
          ...record,
          lifecycle: 'suspended',
          runtimeAgentId: null,
          runtimeWorkspaceId: null,
          lastRuntimeAgentId: runtimeAgentId,
          updatedAt: new Date().toISOString(),
        }).catch(() => {});
      }
      throw error;
    }
  });
}

export async function agentStop({ agentId }, signal) {
  return await withLifecycleLock(agentId, async () => {
  const metadata = await reconcileBeforeOperation(signal, { reconcileCompletions: false });
  const blockingPrompt = blockingPromptLifecycleCompletion(metadata, agentId);
  if (blockingPrompt) throw promptLifecycleBlockedError(agentId, blockingPrompt);
  const durable = metadata.agents[agentId];
  if (['orphaned', 'quarantined'].includes(durable?.lifecycle) && !durable.runtimeAgentId) {
    await updateAgentMetadata(agentId, null);
    return {
      agentId,
      harness: durable.harness,
      workspaceId: durable.lastWorkspaceId ?? null,
      runtimeAgentId: null,
      stopped: true,
      discarded: true,
    };
  }
  if (durable?.lifecycle === 'starting' || durable?.lifecycle === 'suspending' || durable?.lifecycle === 'resuming' || durable?.lifecycle === 'stopping' || durable?.lifecycle === 'quarantined') {
    const snapshot = await snapshotOutcome({ signal, timeoutMs: 5_000 });
    if (!snapshot.ok) throwHerdrFailure(snapshot);
    const observation = runtimeObservation(snapshot.result.snapshot, durable);
    if (observation === 'ambiguous') {
      const error = new Error(`Agent ${agentId} has ambiguous transitional runtime/workspace ownership; stop will not touch it.`);
      error.code = 'agent_ambiguous_ownership';
      throw error;
    }
    if (observation === 'absent') {
      await updateAgentMetadata(agentId, null);
      return {
        agentId,
        harness: durable.harness,
        workspaceId: durable.lastWorkspaceId ?? null,
        runtimeAgentId: null,
        stopped: true,
        discarded: true,
      };
    }
    if (observation?.status === 'orphan' || observation?.status === 'owned') {
      const closed = await closeExactlyOwnedWorkspace(durable.runtimeAgentId, observation.workspace, signal);
      if (!closed) {
        const error = new Error(`Agent ${agentId} transitional runtime could not be safely closed; metadata was retained.`);
        error.code = 'agent_runtime_close_unconfirmed';
        throw error;
      }
      await updateAgentMetadata(agentId, null);
      return {
        agentId,
        harness: durable.harness,
        workspaceId: observation.workspace.workspace_id,
        runtimeAgentId: durable.runtimeAgentId,
        stopped: true,
        discarded: true,
      };
    }
  }
  if (durable?.lifecycle === 'suspended') {
    await updateAgentMetadata(agentId, null);
    return {
      agentId,
      harness: durable.harness,
      workspaceId: durable.lastWorkspaceId ?? null,
      runtimeAgentId: null,
      stopped: true,
      discarded: true,
    };
  }
  if (durable && durable.lifecycle !== 'active') {
    const error = new Error(`Agent ${agentId} is in lifecycle state ${durable.lifecycle} and cannot be stopped safely.`);
    error.code = 'agent_invalid_transition';
    throw error;
  }
  const owned = await requireOwnedAgent(agentId, {
    signal,
    timeoutMs: 5_000,
    allowUnverifiedLegacyCodex: true,
  });
  const agent = normalizeAgent(owned.agent);
  const workspaceId = owned.workspace.workspace_id;
  const verify = await runHerdr(['workspace', 'get', workspaceId], { timeoutMs: 5_000, signal });
  if (!verify.ok) throwHerdrFailure(verify);
  if (verify.result.workspace?.label !== owned.runtimeAgentId) {
    const error = new Error(`Workspace ${workspaceId} is no longer owned by runtime agent ${owned.runtimeAgentId}.`);
    error.code = 'agent_not_managed';
    throw error;
  }

  const latest = await requireOwnedAgent(agentId, {
    signal,
    timeoutMs: 5_000,
    allowUnverifiedLegacyCodex: true,
  });
  if (latest.workspace.workspace_id !== workspaceId || latest.agent.workspace_id !== workspaceId) {
    const error = new Error(`Agent ${agentId} changed workspace before stop.`);
    error.code = 'agent_not_managed';
    throw error;
  }

  if (durable) {
    await reserveLifecycleTransition(agentId, {
      from: 'active',
      to: 'stopping',
      runtimeAgentId: owned.runtimeAgentId,
      runtimeWorkspaceId: workspaceId,
    });
  }
  const outcome = await runHerdr(['workspace', 'close', workspaceId], { timeoutMs: 30_000, signal });
  if (!outcome.ok) throwHerdrFailure(outcome);
  await updateAgentMetadata(agentId, null);
  return {
    agentId,
    harness: agent.harness,
    workspaceId,
    stopped: true,
  };
  });
}
