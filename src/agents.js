import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_SESSION_NAME = 'agent-vm-mcp';
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const WORKSPACE_CLEANUP_DISCOVERY_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_AGENT_READ_LINES = 1_000;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID_PATTERN = /^agent-[0-9a-f]{26}$/;
const READY_STATUSES = new Set(['idle', 'done']);
const BOOTSTRAP_MODES = new Set(['auto', 'external']);

let sessionBootstrapPromise = null;
const promptAgentsInFlight = new Set();

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

function harnessDefinitions() {
  const home = homeDirectory();
  return {
    codex: {
      command: 'codex',
      skillRoot: path.join(home, '.agents', 'skills'),
      supportsModel: true,
      supportsEffort: true,
      startupGraceMs: 0,
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      buildArgs({ model, effort }) {
        const args = [];
        if (model) args.push('--model', model);
        if (effort) args.push('--config', `model_reasoning_effort=${JSON.stringify(effort)}`);
        return args;
      },
    },
    agy: {
      command: 'agy',
      skillRoot: path.join(home, '.gemini', 'antigravity-cli', 'skills'),
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
    },
    claude: {
      command: 'claude',
      skillRoot: path.join(home, '.claude', 'skills'),
      supportsModel: true,
      supportsEffort: false,
      startupGraceMs: 0,
      supportedEfforts: [],
      buildArgs({ model, effort }) {
        if (effort) throw new Error('Claude effort overrides are not supported by agent-vm-mcp yet.');
        return model ? ['--model', model] : [];
      },
    },
  };
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

function normalizeAgent(agent) {
  return {
    agentId: agent.name,
    harness: agent.agent ?? null,
    status: agent.agent_status ?? 'unknown',
    interactiveReady: Boolean(agent.interactive_ready),
    cwd: agent.cwd ?? null,
    foregroundCwd: agent.foreground_cwd ?? null,
    workspaceId: agent.workspace_id ?? null,
    tabId: agent.tab_id ?? null,
    paneId: agent.pane_id ?? null,
    stateChangeSeq: agent.state_change_seq ?? null,
  };
}

function ownedAgentRecords(snapshot) {
  const workspaceById = new Map(
    (snapshot.workspaces ?? [])
      .filter((workspace) => typeof workspace.workspace_id === 'string' && workspace.workspace_id.length > 0)
      .map((workspace) => [workspace.workspace_id, workspace]),
  );
  return (snapshot.agents ?? [])
    .filter((agent) => {
      if (!AGENT_ID_PATTERN.test(agent.name ?? '')) return false;
      if (typeof agent.workspace_id !== 'string' || agent.workspace_id.length === 0) return false;
      const workspace = workspaceById.get(agent.workspace_id);
      return Boolean(workspace && workspace.label === agent.name && workspace.workspace_id === agent.workspace_id);
    })
    .map((agent) => ({ agent, workspace: workspaceById.get(agent.workspace_id) }));
}

function ownedAgentRecord(snapshot, agentId) {
  return ownedAgentRecords(snapshot).find(({ agent }) => agent.name === agentId) ?? null;
}

async function requireOwnedAgent(agentId, { signal, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  const snapshot = await ensureHerdrSession(signal, { timeoutMs });
  const owned = ownedAgentRecord(snapshot, agentId);
  if (!owned) {
    const error = new Error(`Agent ${agentId} is not an MCP-managed Herdr agent.`);
    error.code = 'agent_not_managed';
    throw error;
  }
  return owned;
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
  const outcome = await runHerdr(['agent', 'get', agentId], { timeoutMs: remainingMs(), signal });
  if (!outcome.ok) throwHerdrFailure(outcome);
  const agent = normalizeAgent(outcome.result.agent);
  if (ownedBefore && agent.workspaceId !== ownedBefore.workspace.workspace_id) {
    const error = new Error(`Agent ${agentId} changed workspace during ownership verification.`);
    error.code = 'agent_not_managed';
    throw error;
  }
  if (!includeInteraction) {
    if (verifyOwnership) await requireOwnedAgent(agentId, { signal, timeoutMs: remainingMs() });
    return { ...agent, interaction: null, transient: null, screenReliable: true };
  }

  const read = await readAgentTextOutcome(agentId, {
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

async function validateSkills(harness, skills) {
  const definition = harnessDefinitions()[harness];
  if (!definition) throw new Error(`Unsupported harness: ${harness}`);
  const available = new Set(await scanSkills(definition.skillRoot));
  for (const skill of skills) {
    if (!SKILL_NAME_PATTERN.test(skill)) throw new Error(`Invalid skill name: ${skill}`);
    if (!available.has(skill)) throw new Error(`Skill ${skill} is not installed for harness ${harness}.`);
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
  const owned = ownedAgentRecord(snapshot.result.snapshot, agentId);
  if (!owned) return null;
  const get = await runHerdr(['agent', 'get', agentId], { timeoutMs: 2_000 });
  if (!get.ok) return null;
  const agent = normalizeAgent(get.result.agent);
  const read = await readAgentTextOutcome(agentId, { source: 'visible', lines: 120, timeoutMs: 2_000 });
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
  const read = await readAgentTextOutcome(agentId, { source: 'recent-unwrapped', lines: 160, timeoutMs: 2_000 });
  return { agent: recovered.agent, transcript: read.ok ? read.text : recovered.transcript };
}

export async function agentCapabilities({ signal } = {}) {
  const definitions = harnessDefinitions();
  const configuredHerdr = configuredHerdrExecutable();
  const herdrPath = await resolveExecutable(configuredHerdr);
  const herdrAvailable = herdrPath !== null;
  const bootstrapMode = herdrBootstrapMode();
  let herdrVersion = null;
  let runtimeError = null;
  if (herdrAvailable) herdrVersion = await inspectVersion(herdrPath);

  let session = { name: herdrSessionName(), running: false, agents: [] };
  if (herdrAvailable && herdrVersion) {
    const snapshot = await snapshotOutcome({ signal, timeoutMs: 2_000 });
    if (snapshot.ok) {
      session = {
        name: herdrSessionName(),
        running: true,
        agents: ownedAgentRecords(snapshot.result.snapshot).map(({ agent }) => normalizeAgent(agent)),
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
      skills: await scanSkills(definition.skillRoot),
    });
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

export async function agentStart({ harness, cwd, model, effort, timeoutMs = DEFAULT_START_TIMEOUT_MS }, signal) {
  const definitions = harnessDefinitions();
  const definition = definitions[harness];
  if (!definition) throw new Error(`Unsupported harness: ${harness}`);
  validateModel(model);
  if (effort && !definition.supportedEfforts.includes(effort)) {
    throw new Error(`Effort ${effort} is not supported for harness ${harness}.`);
  }
  const executable = await findExecutable(definition.command);
  if (!executable) throw new Error(`Harness ${harness} is not installed or not available in PATH.`);
  const resolvedCwd = await resolveCwd(cwd);
  await ensureHerdrSession(signal, { timeoutMs: Math.min(2_000, timeoutMs) });

  const agentId = `agent-${randomUUID().replaceAll('-', '').slice(0, 26)}`;
  let workspaceId = null;
  let cleanupAttempt = null;
  try {
    const create = await runHerdr(
      ['workspace', 'create', '--cwd', resolvedCwd, '--label', agentId, '--no-focus'],
      { timeoutMs, signal },
    );
    if (!create.ok) {
      cleanupAttempt = await cleanupWorkspaceByLabel(agentId).catch((error) => ({
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
      createdWorkspaceLabel !== agentId ||
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

    const harnessArgs = definition.buildArgs({ model, effort });
    const startArgs = [
      'agent',
      'start',
      agentId,
      '--kind',
      harness,
      '--pane',
      paneId,
      '--timeout',
      String(timeoutMs),
    ];
    if (harnessArgs.length > 0) startArgs.push('--', ...harnessArgs);

    const start = await runHerdr(startArgs, { timeoutMs: timeoutMs + 2_000, signal });
    if (!start.ok) {
      const recovered = await recoverOwnedAgent(agentId);
      if (recovered) {
        return {
          agent: recovered.agent,
          startup: {
            ready: false,
            error: start.error,
            interaction: recovered.agent.interaction,
            transient: recovered.agent.transient,
          },
          transcript: recovered.transcript,
        };
      }
      throwHerdrFailure(start);
    }

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
      const transcript = await readAgentText(agentId, {
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
    if (!cleanupAttempt?.cleaned) {
      cleanupAttempt = await (workspaceId !== null
        ? cleanupWorkspaceById(workspaceId)
        : cleanupWorkspaceByLabel(agentId)
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
    throw error;
  }
}

export async function agentGet({ agentId }, signal) {
  return await getAgentState(agentId, { signal, includeInteraction: true, verifyOwnership: true });
}

export async function agentRead({ agentId, source = 'recent-unwrapped', lines = 120 }, signal) {
  await requireOwnedAgent(agentId, { signal });
  const text = await readAgentText(agentId, { source, lines, signal });
  await requireOwnedAgent(agentId, { signal });
  return { agentId, source, lines: Math.max(1, Math.min(MAX_AGENT_READ_LINES, lines)), text };
}

export async function agentPrompt(
  { agentId, task, skills = [], wait = true, until = [], timeoutMs = 120_000 },
  signal,
) {
  if (!wait && until.length > 0) throw new Error('until requires wait=true.');

  const notSubmitted = (error, { agent = null, transcript = '' } = {}) => ({
    accepted: false,
    submission: { state: 'not_submitted', retrySafe: true, waitCompleted: false },
    error: {
      code: 'agent_prompt_not_submitted',
      message: 'Prompt was not submitted because Agent Runtime preflight failed.',
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

  if (promptAgentsInFlight.has(agentId)) {
    return notSubmitted(Object.assign(new Error(`Agent ${agentId} already has a prompt in flight.`), {
      code: 'agent_prompt_in_flight',
    }));
  }
  promptAgentsInFlight.add(agentId);

  try {
    const preflightDeadline = Date.now() + Math.min(10_000, timeoutMs);
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
        const diagnostic = await readAgentTextOutcome(agentId, {
          source: 'recent-unwrapped',
          lines: 120,
          signal,
          timeoutMs: Math.min(2_000, remainingPreflightMs()),
        });
        transcript = diagnostic.ok ? diagnostic.text : '';
      }
      return {
        accepted: false,
        submission: { state: 'not_submitted', retrySafe: Boolean(gate.retryable), waitCompleted: false },
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
      if (error?.code === 'timeout') return notSubmitted(error, { agent: before });
      throw error;
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
        submission: { state: 'not_submitted', retrySafe: Boolean(finalGate.retryable), waitCompleted: false },
        error: finalGate,
        agent: finalState,
        transcript: '',
      };
    }

    const prompt = promptWithSkills(task, skills);
    const args = ['agent', 'prompt', agentId, prompt];
    if (wait) args.push('--wait');
    for (const status of until) args.push('--until', status);
    if (wait) args.push('--timeout', String(timeoutMs));

    try {
      remainingPreflightMs();
    } catch (error) {
      return notSubmitted(error, { agent: finalState });
    }

    const outcome = await runHerdr(args, {
      timeoutMs: wait ? timeoutMs + 2_000 : 10_000,
      signal,
      deadlineAt: preflightDeadline,
    });
    if (!outcome.ok) {
      const diagnostics = await safePromptDiagnostics(agentId);
      if (outcome.process === null || outcome.process?.spawnError || outcome.error?.code === 'herdr_unavailable') {
        return notSubmitted(
          Object.assign(new Error('Prompt was not submitted because the Herdr command could not be started.'), {
            herdr: outcome.error,
          }),
          diagnostics,
        );
      }
      return {
        accepted: null,
        submission: {
          state: 'possibly_submitted',
          retrySafe: false,
          waitCompleted: false,
        },
        error: {
          code: 'agent_prompt_outcome_unknown',
          message: 'Prompt submission may have occurred, but completion could not be confirmed. Do not automatically retry this task.',
          cause: outcome.error,
        },
        agent: diagnostics.agent,
        transcript: diagnostics.transcript,
      };
    }

    const diagnostics = await safePromptDiagnostics(agentId);
    return {
      accepted: true,
      submission: { state: 'submitted', retrySafe: false, waitCompleted: wait },
      skills,
      agent: diagnostics.agent,
      transcript: diagnostics.transcript,
    };
  } finally {
    promptAgentsInFlight.delete(agentId);
  }
}

export async function agentSendKeys({ agentId, keys }, signal) {
  await getAgentState(agentId, {
    signal,
    includeInteraction: false,
    verifyOwnership: true,
    timeoutMs: 5_000,
  });
  const outcome = await runHerdr(['agent', 'send-keys', agentId, ...keys], { timeoutMs: 10_000, signal });
  if (!outcome.ok) throwHerdrFailure(outcome);
  await sleepWithSignal(250, signal);
  return await getAgentState(agentId, { signal, includeInteraction: true, verifyOwnership: true, timeoutMs: 5_000 });
}

export async function agentStop({ agentId }, signal) {
  const owned = await requireOwnedAgent(agentId, { signal, timeoutMs: 5_000 });
  const agent = normalizeAgent(owned.agent);
  const workspaceId = owned.workspace.workspace_id;
  const verify = await runHerdr(['workspace', 'get', workspaceId], { timeoutMs: 5_000, signal });
  if (!verify.ok) throwHerdrFailure(verify);
  if (verify.result.workspace?.label !== agentId) {
    const error = new Error(`Workspace ${workspaceId} is no longer owned by agent ${agentId}.`);
    error.code = 'agent_not_managed';
    throw error;
  }

  const latest = await requireOwnedAgent(agentId, { signal, timeoutMs: 5_000 });
  if (latest.workspace.workspace_id !== workspaceId || latest.agent.workspace_id !== workspaceId) {
    const error = new Error(`Agent ${agentId} changed workspace before stop.`);
    error.code = 'agent_not_managed';
    throw error;
  }

  const outcome = await runHerdr(['workspace', 'close', workspaceId], { timeoutMs: 30_000, signal });
  if (!outcome.ok) throwHerdrFailure(outcome);
  return {
    agentId,
    harness: agent.harness,
    workspaceId,
    stopped: true,
  };
}
