import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { inspectCommands } from './capabilities.js';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_STRUCTURED_ENTRIES = 10_000;
const MAX_AGENT_RUNS = 64;
const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_AGENT_POLL_WAIT_MS = 10_000;
export const MAX_AGENT_POLL_WAIT_MS = 15_000;
const CODEX_MODEL = 'gpt-5.6-luna';
const CODEX_EFFORT = 'max';

class BoundedStreamBuffer {
  #buffer = Buffer.alloc(0);
  #baseOffset = 0;
  #observedBytes = 0;

  append(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#observedBytes += input.length;
    this.#buffer = Buffer.concat([this.#buffer, input]);

    if (this.#buffer.length > MAX_CAPTURE_BYTES) {
      const dropped = this.#buffer.length - MAX_CAPTURE_BYTES;
      this.#buffer = this.#buffer.subarray(dropped);
      this.#baseOffset += dropped;
    }
  }

  read(offset) {
    const requestedOffset = offset ?? this.#baseOffset;
    const endOffset = this.#baseOffset + this.#buffer.length;
    const effectiveOffset = Math.min(Math.max(requestedOffset, this.#baseOffset), endOffset);
    const relativeOffset = effectiveOffset - this.#baseOffset;
    const data = this.#buffer.subarray(relativeOffset);

    return {
      text: data.toString('utf8'),
      requestedOffset,
      startOffset: effectiveOffset,
      nextOffset: this.#baseOffset + this.#buffer.length,
      truncatedBeforeOffset: requestedOffset < this.#baseOffset,
      observedBytes: this.#observedBytes,
    };
  }

  get observedBytes() {
    return this.#observedBytes;
  }

  get truncated() {
    return this.#baseOffset > 0;
  }
}

class BoundedEntryBuffer {
  #entries = [];
  #baseOffset = 0;

  append(value) {
    this.#entries.push(value);
    if (this.#entries.length > MAX_STRUCTURED_ENTRIES) {
      const dropped = this.#entries.length - MAX_STRUCTURED_ENTRIES;
      this.#entries.splice(0, dropped);
      this.#baseOffset += dropped;
    }
  }

  read(offset) {
    const requestedOffset = offset ?? this.#baseOffset;
    const endOffset = this.#baseOffset + this.#entries.length;
    const effectiveOffset = Math.min(Math.max(requestedOffset, this.#baseOffset), endOffset);
    const relativeOffset = effectiveOffset - this.#baseOffset;

    return {
      items: this.#entries.slice(relativeOffset),
      requestedOffset,
      startOffset: effectiveOffset,
      nextOffset: this.#baseOffset + this.#entries.length,
      truncatedBeforeOffset: requestedOffset < this.#baseOffset,
    };
  }
}

const runs = new Map();

function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

function taskWithSkills(task, skills) {
  if (!skills?.length) return task;
  return `Use the following installed skills for this task: ${skills.join(', ')}. Read and follow each skill's SKILL.md before acting.\n\n${task}`;
}

function deepContinuationId(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.thread_id === 'string') return value.thread_id;
  if (typeof value.conversation_id === 'string') return value.conversation_id;
  for (const nested of Object.values(value)) {
    const found = deepContinuationId(nested);
    if (found) return found;
  }
  return null;
}

function invocationFor(harness, task, timeoutMs) {
  if (harness === 'codex') {
    return {
      args: [
        'exec',
        '--json',
        '--model',
        CODEX_MODEL,
        '--config',
        `model_reasoning_effort="${CODEX_EFFORT}"`,
        task,
      ],
      output: 'jsonl',
      policy: { model: CODEX_MODEL, effort: CODEX_EFFORT },
    };
  }
  if (harness === 'agy') {
    return {
      args: [
        '-p',
        task,
        '--output-format',
        'stream-json',
        '--print-timeout',
        `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`,
      ],
      output: 'jsonl',
      policy: null,
    };
  }
  const error = new Error(`Unsupported coding harness: ${harness}`);
  error.code = 'unsupported_harness';
  throw error;
}

async function assertDirectory(cwd) {
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) {
    const error = new Error(`Agent cwd is not a directory: ${cwd}`);
    error.code = 'invalid_agent_cwd';
    throw error;
  }
}

function pruneFinishedRuns() {
  if (runs.size < MAX_AGENT_RUNS) return;

  const finished = [...runs.values()]
    .filter((run) => run.finishedAt !== null)
    .sort((a, b) => a.finishedAt - b.finishedAt);

  while (runs.size >= MAX_AGENT_RUNS && finished.length > 0) {
    runs.delete(finished.shift().runId);
  }
}

function getRun(runId) {
  const run = runs.get(runId);
  if (!run) {
    const error = new Error(`Unknown agent runId: ${runId}`);
    error.code = 'unknown_agent_run';
    throw error;
  }
  return run;
}

function markActivity(run, { output = false } = {}) {
  const now = Date.now();
  run.lastActivityAt = now;
  if (output) run.lastOutputAt = now;
  run.activityVersion += 1;
  run.events.emit('activity');
}

function consumeStructuredText(run, text, { flush = false } = {}) {
  run.structuredRemainder += text;
  const lines = run.structuredRemainder.split(/\r?\n/);
  const tail = lines.pop() ?? '';
  run.structuredRemainder = flush ? '' : tail;
  if (flush && tail) lines.push(tail);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      run.structuredEvents.append(value);
      run.continuationId ??= deepContinuationId(value);
    } catch {
      run.invalidLines.append(trimmed);
    }
  }
}

function finishRun(run, exitCode, exitSignal) {
  if (run.finishedAt !== null) return;

  clearTimeout(run.timeoutTimer);
  clearTimeout(run.escalationTimer);
  consumeStructuredText(run, run.stdoutDecoder.end(), { flush: true });

  run.exitCode = exitCode;
  run.signal = exitSignal;
  run.finishedAt = Date.now();

  const emptySuccess = exitCode === 0 && run.stdout.observedBytes === 0;
  run.status = run.cancelled
    ? 'cancelled'
    : run.timedOut
      ? 'timed_out'
      : exitCode === 0 && !emptySuccess
        ? 'completed'
        : exitCode === 0
          ? 'ambiguous'
          : 'failed';

  markActivity(run);
  run.resolveDone();
}

function terminateRun(run, reason) {
  if (run.finishedAt !== null || run.terminationReason !== null) return false;
  run.terminationReason = reason;
  run.timedOut = reason === 'timeout';
  run.cancelled = reason === 'cancel';

  killProcessGroup(run.child, 'SIGTERM');
  if (!run.escalationTimer) {
    run.escalationTimer = setTimeout(() => {
      if (run.finishedAt === null) killProcessGroup(run.child, 'SIGKILL');
    }, 2_000);
    run.escalationTimer.unref();
  }
  markActivity(run);
  return true;
}

function runSummary(run) {
  return {
    runId: run.runId,
    pid: run.child.pid,
    harness: run.harness,
    cwd: run.cwd,
    status: run.status,
    processAlive: run.finishedAt === null,
    exitCode: run.exitCode,
    signal: run.signal,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
    lastActivityAt: new Date(run.lastActivityAt).toISOString(),
    lastOutputAt: run.lastOutputAt === null ? null : new Date(run.lastOutputAt).toISOString(),
    timeoutMs: run.timeoutMs,
    terminationReason: run.terminationReason,
    continuationId: run.continuationId,
    policy: run.policy,
  };
}

function runIncrementalSnapshot(run, { stdoutOffset, stderrOffset, eventOffset, invalidLineOffset }) {
  return {
    ...runSummary(run),
    stdout: run.stdout.read(stdoutOffset),
    stderr: run.stderr.read(stderrOffset),
    structured: {
      format: run.outputFormat,
      events: run.structuredEvents.read(eventOffset),
      invalidLines: run.invalidLines.read(invalidLineOffset),
    },
  };
}

function runFullResult(run) {
  const stdout = run.stdout.read(0);
  const stderr = run.stderr.read(0);
  const events = run.structuredEvents.read(0);
  const invalidLines = run.invalidLines.read(0);

  return {
    ...runSummary(run),
    stdout: stdout.text,
    stderr: stderr.text,
    structured: {
      format: run.outputFormat,
      events: events.items,
      invalidLines: invalidLines.items,
    },
    outputTruncated:
      run.stdout.truncated ||
      run.stderr.truncated ||
      events.truncatedBeforeOffset ||
      invalidLines.truncatedBeforeOffset,
    output: {
      stdout: {
        observedBytes: stdout.observedBytes,
        retainedFromOffset: stdout.startOffset,
      },
      stderr: {
        observedBytes: stderr.observedBytes,
        retainedFromOffset: stderr.startOffset,
      },
      structuredEvents: {
        retainedFromOffset: events.startOffset,
        nextOffset: events.nextOffset,
      },
      invalidLines: {
        retainedFromOffset: invalidLines.startOffset,
        nextOffset: invalidLines.nextOffset,
      },
    },
  };
}

function hasUnreadEvidence(run, offsets) {
  const snapshot = runIncrementalSnapshot(run, offsets);
  return (
    snapshot.stdout.text.length > 0 ||
    snapshot.stderr.text.length > 0 ||
    snapshot.structured.events.items.length > 0 ||
    snapshot.structured.invalidLines.items.length > 0
  );
}

function waitForRunActivity(run, previousVersion, waitMs, signal) {
  if (run.finishedAt !== null || run.activityVersion !== previousVersion || waitMs === 0) {
    return Promise.resolve('activity');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      run.events.off('activity', onActivity);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(reason);
    };
    const onActivity = () => finish('activity');
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new Error('agent_poll cancelled.'));
    };

    run.events.on('activity', onActivity);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => finish('timeout'), waitMs);
    timer.unref();

    if (run.finishedAt !== null || run.activityVersion !== previousVersion) finish('activity');
  });
}

export async function agentCapabilities() {
  const commands = await inspectCommands(['codex', 'agy']);
  const byName = new Map(commands.map((command) => [command.name, command]));
  const harnesses = ['codex', 'agy'].map((kind) => {
    const command = byName.get(kind);
    return {
      kind,
      available: Boolean(command?.available),
      path: command?.path ?? null,
      version: command?.version ?? null,
      execution: 'managed-bounded-process',
      structuredOutput: true,
      continuation: kind === 'codex' ? 'native-thread-id' : 'native-conversation-id',
      ...(kind === 'codex' ? { fixedPolicy: { model: CODEX_MODEL, effort: CODEX_EFFORT } } : {}),
    };
  });
  return {
    runtime: {
      kind: 'managed-bounded-process',
      semanticAuthority: 'process-exit-and-structured-output',
      persistentAgentState: false,
      rediscoverableRuns: true,
      persistentAcrossServerRestart: false,
      pollWaitMs: {
        default: DEFAULT_AGENT_POLL_WAIT_MS,
        max: MAX_AGENT_POLL_WAIT_MS,
      },
    },
    harnesses,
  };
}

export async function agentStart(
  {
    harness,
    cwd,
    task,
    skills = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  },
  signal,
) {
  const resolvedCwd = path.resolve(cwd);
  await assertDirectory(resolvedCwd);
  signal?.throwIfAborted?.();

  pruneFinishedRuns();
  if (runs.size >= MAX_AGENT_RUNS) {
    const error = new Error(`Agent run limit reached (${MAX_AGENT_RUNS}); active runs must finish before starting another.`);
    error.code = 'agent_run_limit_reached';
    throw error;
  }

  const [command] = await inspectCommands([harness]);
  if (!command?.available || !command.path) {
    const error = new Error(`Coding harness is unavailable: ${harness}`);
    error.code = 'harness_unavailable';
    throw error;
  }

  const prompt = taskWithSkills(task, skills);
  const invocation = invocationFor(harness, prompt, timeoutMs);

  return await new Promise((resolve, reject) => {
    const child = spawn(command.path, invocation.args, {
      cwd: resolvedCwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const startedAt = Date.now();
    let resolveDone;
    const done = new Promise((doneResolve) => {
      resolveDone = doneResolve;
    });
    const run = {
      runId: randomUUID(),
      harness,
      cwd: resolvedCwd,
      child,
      timeoutMs,
      policy: invocation.policy,
      outputFormat: invocation.output,
      stdout: new BoundedStreamBuffer(),
      stderr: new BoundedStreamBuffer(),
      stdoutDecoder: new StringDecoder('utf8'),
      structuredRemainder: '',
      structuredEvents: new BoundedEntryBuffer(),
      invalidLines: new BoundedEntryBuffer(),
      continuationId: null,
      status: 'running',
      startedAt,
      finishedAt: null,
      lastActivityAt: startedAt,
      lastOutputAt: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      terminationReason: null,
      timeoutTimer: null,
      escalationTimer: null,
      activityVersion: 0,
      events: new EventEmitter(),
      done,
      resolveDone,
    };

    let committed = false;
    let spawnSettled = false;

    const cleanupPreCommit = () => {
      signal?.removeEventListener?.('abort', onAbort);
      child.off('error', onSpawnError);
    };

    const rejectBeforeCommit = (error) => {
      if (spawnSettled || committed) return;
      spawnSettled = true;
      cleanupPreCommit();
      reject(error);
    };

    const onAbort = () => {
      if (committed || spawnSettled) return;
      killProcessGroup(child, 'SIGTERM');
      setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000).unref();
      rejectBeforeCommit(signal.reason ?? new Error('agent_start cancelled before registration.'));
    };

    const onSpawnError = (error) => rejectBeforeCommit(error);

    child.stdout.on('data', (chunk) => {
      run.stdout.append(chunk);
      consumeStructuredText(run, run.stdoutDecoder.write(chunk));
      markActivity(run, { output: true });
    });
    child.stderr.on('data', (chunk) => {
      run.stderr.append(chunk);
      markActivity(run, { output: true });
    });
    child.on('error', (error) => {
      if (!committed) return;
      run.stderr.append(`\n${error.stack ?? error.message}\n`);
      markActivity(run, { output: true });
    });
    child.on('close', (exitCode, exitSignal) => finishRun(run, exitCode, exitSignal));

    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.once('error', onSpawnError);
    child.once('spawn', () => {
      if (spawnSettled || signal?.aborted) {
        if (!spawnSettled) onAbort();
        return;
      }

      committed = true;
      spawnSettled = true;
      cleanupPreCommit();
      runs.set(run.runId, run);

      run.timeoutTimer = setTimeout(() => terminateRun(run, 'timeout'), timeoutMs);
      run.timeoutTimer.unref();

      resolve(runSummary(run));
    });
  });
}

export async function agentPoll(
  {
    runId,
    stdoutOffset,
    stderrOffset,
    eventOffset,
    invalidLineOffset,
    waitMs = DEFAULT_AGENT_POLL_WAIT_MS,
  },
  signal,
) {
  signal?.throwIfAborted?.();
  const run = getRun(runId);
  const offsets = { stdoutOffset, stderrOffset, eventOffset, invalidLineOffset };
  const startedWaitingAt = Date.now();
  let wakeReason = run.finishedAt !== null ? 'terminal' : 'already-readable';

  if (run.finishedAt === null && !hasUnreadEvidence(run, offsets)) {
    const previousVersion = run.activityVersion;
    wakeReason = await waitForRunActivity(run, previousVersion, waitMs, signal);
  }

  return {
    ...runIncrementalSnapshot(run, offsets),
    poll: {
      requestedWaitMs: waitMs,
      waitedMs: Date.now() - startedWaitingAt,
      wakeReason: run.finishedAt !== null ? 'terminal' : wakeReason,
    },
  };
}

export function agentResult({ runId }) {
  return runFullResult(getRun(runId));
}

export async function agentCancel({ runId }) {
  const run = getRun(runId);
  const requested = terminateRun(run, 'cancel');
  if (requested) {
    await Promise.race([
      run.done,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_500);
        timer.unref();
      }),
    ]);
  }

  return {
    ...runSummary(run),
    cancellationRequested: requested,
  };
}

export function agentRunsSnapshot({ cwd, limit = MAX_AGENT_RUNS } = {}) {
  const resolvedCwd = cwd ? path.resolve(cwd) : null;
  return [...runs.values()]
    .filter((run) => resolvedCwd === null || run.cwd === resolvedCwd)
    .sort((a, b) => {
      const activeDelta = Number(a.finishedAt !== null) - Number(b.finishedAt !== null);
      if (activeDelta !== 0) return activeDelta;
      return b.startedAt - a.startedAt;
    })
    .slice(0, limit)
    .map((run) => runSummary(run));
}

export async function agentRun(args, signal) {
  const started = await agentStart(args, signal);
  const run = getRun(started.runId);

  const onAbort = () => terminateRun(run, 'cancel');
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) terminateRun(run, 'cancel');
    await run.done;
    return runFullResult(run);
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export async function stopAgentRuns() {
  const running = [...runs.values()].filter((run) => run.finishedAt === null);
  if (running.length === 0) return;

  for (const run of running) terminateRun(run, 'cancel');

  await Promise.race([
    Promise.all(running.map((run) => run.done)),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_500);
      timer.unref();
    }),
  ]);

  for (const run of running) {
    if (run.finishedAt === null) killProcessGroup(run.child, 'SIGKILL');
  }
}
