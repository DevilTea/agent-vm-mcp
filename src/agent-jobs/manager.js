import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_JOB_TIMEOUT_MS, DEFAULT_POLL_WAIT_MS, JOB_KIND_AGENT, JOB_KIND_OPERATION,
  MAX_JOB_TIMEOUT_MS, MAX_POLL_WAIT_MS, TERMINAL, openStore, operationSummary,
  processStartTicks, sameProcess, socketPath, stateRoot, summary,
} from './store.js';

const root = stateRoot();
const socket = socketPath();
const store = openStore(root);
const maxConcurrent = Number(process.env.AGENT_JOB_MAX_CONCURRENT || 2);
if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
  throw new Error('AGENT_JOB_MAX_CONCURRENT must be an integer from 1 to 8');
}
const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));
let scheduling = false;
const launching = new Set();
const cleanupStarted = new Map();

function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = status;
  throw error;
}

function validateIdempotencyKey(input) {
  if (input.idempotencyKey !== undefined &&
      (typeof input.idempotencyKey !== 'string' ||
       input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128)) {
    fail('invalid_idempotency_key', 'idempotencyKey must have 1-128 characters');
  }
}

function validateTimeout(input) {
  const timeoutMs = input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_JOB_TIMEOUT_MS) {
    fail('invalid_timeout', 'timeoutMs must be within 1000 and ' + MAX_JOB_TIMEOUT_MS);
  }
  return timeoutMs;
}

function validateCwd(input) {
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) {
    fail('invalid_cwd', 'cwd must be an absolute directory');
  }
  const directory = path.resolve(input.cwd);
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    fail('invalid_cwd', 'Working directory does not exist: ' + directory);
  }
  return directory;
}

function validateStart(input) {
  if (!input || typeof input !== 'object') fail('invalid_input', 'Expected a job request');
  if (!['codex', 'agy'].includes(input.harness)) fail('invalid_harness', 'Unsupported harness');
  const directory = validateCwd(input);
  if (typeof input.task !== 'string' || input.task.length < 1 || input.task.length > 100_000) {
    fail('invalid_task', 'task must have 1-100000 characters');
  }
  if (!Array.isArray(input.skills || []) || (input.skills || []).length > 16 ||
      !(input.skills || []).every((name) => typeof name === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))) {
    fail('invalid_skills', 'skills must contain at most 16 valid names');
  }
  const timeoutMs = validateTimeout(input);
  validateIdempotencyKey(input);
  return {
    harness: input.harness, cwd: directory, task: input.task,
    skills: input.skills || [], timeoutMs,
    idempotencyKey: input.idempotencyKey,
  };
}

function validateOperationStart(input) {
  if (!input || typeof input !== 'object') fail('invalid_input', 'Expected an operation request');
  const directory = validateCwd(input);
  const timeoutMs = validateTimeout(input);
  validateIdempotencyKey(input);

  const hasShell = typeof input.command === 'string';
  const hasArgv = Array.isArray(input.argv);
  if (hasShell === hasArgv) fail('invalid_command', 'Exactly one of command or argv is required');

  let command;
  if (hasShell) {
    if (input.command.length < 1 || input.command.length > 100_000 || input.command.includes('\0')) {
      fail('invalid_command', 'command must have 1-100000 characters and no NUL bytes');
    }
    command = { mode: 'shell', command: input.command };
  } else {
    if (input.argv.length < 1 || input.argv.length > 1024 ||
        !input.argv.every((part) => typeof part === 'string' && !part.includes('\0'))) {
      fail('invalid_command', 'argv must contain 1-1024 NUL-free strings');
    }
    const argvBytes = input.argv.reduce((total, part) => total + Buffer.byteLength(part), 0);
    if (argvBytes > 256 * 1024) fail('invalid_command', 'argv exceeds 256 KiB');
    command = { mode: 'argv', argv: input.argv };
  }

  const environment = input.env ?? {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('invalid_env', 'env must be an object of string values');
  }
  const entries = Object.entries(environment);
  if (entries.length > 128 || !entries.every(([key, value]) =>
      typeof value === 'string' && key.length > 0 && !key.includes('=') &&
      !key.includes('\0') && !key.startsWith('AGENT_JOB_') && !value.includes('\0'))) {
    fail('invalid_env', 'env must contain at most 128 NUL-free string entries with valid names; AGENT_JOB_* is reserved');
  }
  if (Buffer.byteLength(JSON.stringify(environment)) > 256 * 1024) {
    fail('invalid_env', 'env exceeds 256 KiB');
  }

  if (input.category !== undefined &&
      (typeof input.category !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(input.category))) {
    fail('invalid_category', 'category must be a compact stable identifier');
  }
  if (input.label !== undefined &&
      (typeof input.label !== 'string' || input.label.length < 1 ||
       input.label.length > 200 || input.label.includes('\0'))) {
    fail('invalid_label', 'label must have 1-200 characters and no NUL bytes');
  }

  return {
    cwd: directory,
    command,
    env: environment,
    timeoutMs,
    idempotencyKey: input.idempotencyKey,
    category: input.category,
    label: input.label,
  };
}

function groupMembership(job) {
  // A PID/PGID may be reused after the original worker exits. Scan only
  // processes in the original worker's group AND session, and require the
  // unpredictable per-job environment marker inherited by worker/children.
  // Fail closed on an unmarked group member instead of signalling an
  // unrelated session. Only Linux /proc is supported by the VM runtime.
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!job.pid_start?.startsWith(bootId + ':')) return { owned: [], unverified: false };
  const owned = [];
  let unverified = false;
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
    try {
      const pid = Number(entry.name);
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      if (['Z','X'].includes(fields[0]) ||
          Number(fields[2]) !== job.pid || Number(fields[3]) !== job.pid) continue;
      const environment = fs.readFileSync('/proc/' + pid + '/environ');
      if (environment.includes(Buffer.from('AGENT_JOB_RUN_ID=' + job.id + '\0'))) {
        owned.push({ pid, ticks: processStartTicks(pid) });
      } else {
        unverified = true;
      }
    } catch (error) {
      // A process that has exited during inspection is not a remaining
      // member. Inaccessible live process metadata remains unverified.
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unverified = true;
    }
  }
  return { owned, unverified };
}

function cleanupOwnedGroup(job, signal) {
  const { owned, unverified } = groupMembership(job);
  if (owned.length === 0) return { found: false, unverified };
  // Never signal the stale process-group ID from this cleanup path:
  // its former leader may have exited and the numeric PGID could be reused.
  // Only target independently verified, marked, living member PIDs.
  // If some members cannot be identified, keep cleanup_pending observable.
  for (const member of owned) {
    if (!member.ticks || processStartTicks(member.pid) !== member.ticks) continue;
    try { process.kill(member.pid, signal); } catch { /* gone */ }
  }
  return { found: true, unverified };
}

function signalJob(job, reason) {
  if (!sameProcess(job)) return false;
  if (reason === 'timeout') {
    store.db.prepare(
      "UPDATE jobs SET termination_reason='timeout',cleanup_pending=1 WHERE id=? AND status='running' AND termination_reason IS NULL"
    ).run(job.id);
  } else {
    store.requestCleanup(job.id);
  }
  if (!cleanupStarted.has(job.id)) cleanupStarted.set(job.id, Date.now());
  // The live worker's PID+start ticks are verified, so its PGID cannot
  // belong to another process group until the worker exits.
  try { process.kill(-job.pid, 'SIGTERM'); }
  catch { return false; }
  return true;
}

function reconcile() {
  for (const job of store.running()) {
    if (!sameProcess(job)) {
      store.requestCleanup(job.id);
      store.finish(job.id,
        job.cancel_requested ? 'cancelled' :
        job.termination_reason === 'timeout' ? 'timed_out' : 'interrupted',
        { reason: job.cancel_requested ? 'cancel' : job.termination_reason || 'worker_lost' });
      continue;
    }
    if (job.cancel_requested && !job.cleanup_pending) signalJob(job, 'cancel');
    else if (!job.termination_reason &&
        Date.now() >= Date.parse(job.started_at) + job.timeout_ms) {
      signalJob(job, 'timeout');
    }
  }
  for (const job of store.cleanupPending()) {
    const now = Date.now();
    if (!cleanupStarted.has(job.id)) cleanupStarted.set(job.id, now);
    const signal = now - cleanupStarted.get(job.id) >= 2_000 ? 'SIGKILL' : 'SIGTERM';
    const check = cleanupOwnedGroup(job, signal);
    // Do not silently mark cleanup complete when a member could not be
    // verified. Keep cleanup_pending visible to operators for inspection.
    if (!check.found && !check.unverified) {
      store.finishCleanup(job.id);
      cleanupStarted.delete(job.id);
    }
  }
}

function schedule() {
  if (scheduling) return;
  scheduling = true;
  try {
    reconcile();
    let available = maxConcurrent - store.running().length - launching.size;
    if (available < 1) return;
    for (const job of store.queued()) {
      if (available < 1) break;
      if (launching.has(job.id)) continue;
      launching.add(job.id);
      const workerLog = fs.openSync(path.join(job.output_dir, 'worker.log'), 'a', 0o600);
      let child;
      try {
        child = spawn(process.execPath, [workerPath, job.id], {
          cwd: job.cwd,
          env: { ...process.env, AGENT_JOB_STATE_DIR: root, AGENT_JOB_RUN_ID: job.id },
          stdio: ['ignore', workerLog, workerLog],
          detached: true,
        });
      } catch (error) {
        launching.delete(job.id);
        store.finish(job.id, 'failed', { reason: 'worker_spawn_error' });
        fs.appendFileSync(path.join(job.output_dir, 'worker.log'), error.stack || String(error));
        fs.closeSync(workerLog);
        continue;
      }
      fs.closeSync(workerLog);
      child.once('error', (error) => {
        launching.delete(job.id);
        const current = store.get(job.id);
        if (current?.status === 'queued' || current?.status === 'running') {
          store.finish(job.id, 'failed', { reason: 'worker_spawn_error' });
        }
        fs.appendFileSync(path.join(job.output_dir, 'worker.log'), '\n' +
          (error.stack || error.message) + '\n');
      });
      child.once('spawn', () => {
        launching.delete(job.id);
        const current = store.get(job.id);
        if (current?.status !== 'queued') {
          try { child.kill('SIGTERM'); } catch { /* no process */ }
          return;
        }
        const ticks = processStartTicks(child.pid);
        if (!ticks) {
          store.finish(job.id, 'failed', { reason: 'worker_identity_unavailable' });
          try { child.kill('SIGTERM'); } catch { /* no process */ }
          return;
        }
        store.markStarted(job.id, child.pid, ticks);
        child.unref();
      });
      available -= 1;
    }
  } finally {
    scheduling = false;
  }
}

async function readBytes(filename, offset = 0, max = 64 * 1024, tail = false) {
  try {
    const file = await fsp.open(filename, 'r');
    try {
      const stats = await file.stat();
      const size = stats.size;
      const start = tail ? Math.max(0, size - max) : Math.min(offset, size);
      const length = Math.min(max, size - start);
      if (!length) return { text: '', startOffset: start, nextOffset: start,
        observedBytes: size, truncatedBeforeOffset: tail ? start > 0 : offset > size };
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, start);
      return {
        text: buffer.toString('utf8'),
        startOffset: start, nextOffset: start + length,
        observedBytes: size,
        truncatedBeforeOffset: tail ? start > 0 : false,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { text: '', startOffset: offset, nextOffset: offset,
      observedBytes: 0, truncatedBeforeOffset: false };
  }
}

async function readEvents(filename, offset = 0, max = 256 * 1024, tail = false) {
  let file;
  try { file = await fsp.open(filename, 'r'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      items: [], requestedOffset: offset, startOffset: offset,
      nextOffset: offset, truncatedBeforeOffset: false,
    };
  }
  try {
    const size = (await file.stat()).size;
    const initialStart = tail ? Math.max(0, size - max) : Math.min(offset, size);
    let start = initialStart;
    const buffer = Buffer.alloc(Math.min(max, size - start));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let data = buffer.subarray(0, bytesRead);
    const truncatedBeforeOffset = tail && start > 0;

    if (tail && start > 0) {
      // Discard the clipped JSONL prefix by raw byte position, not a UTF-8
      // decoded character length (which may include replacement characters).
      const firstNewline = data.indexOf(0x0a);
      if (firstNewline === -1) {
        return { items: [], requestedOffset: offset, startOffset: start,
          nextOffset: size, truncatedBeforeOffset: true };
      }
      start += firstNewline + 1;
      data = data.subarray(firstNewline + 1);
    }

    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      if (!tail && size > initialStart + bytesRead) {
        // An individual event larger than the 256KiB per-call budget cannot
        // fit inline. Advance past its newline; the full source file remains
        // available through outputFiles. A bounded scan avoids unbounded reads.
        const scan = Buffer.alloc(64 * 1024);
        let cursor = initialStart + bytesRead;
        const scanLimit = Math.min(size, cursor + 8 * 1024 * 1024);
        while (cursor < scanLimit) {
          const { bytesRead: n } = await file.read(
            scan, 0, Math.min(scan.length, scanLimit - cursor), cursor,
          );
          if (!n) break;
          const newline = scan.subarray(0, n).indexOf(0x0a);
          if (newline !== -1) {
            return { items: [], requestedOffset: offset, startOffset: start,
              nextOffset: cursor + newline + 1, truncatedBeforeOffset: true,
              oversizedLine: true };
          }
          cursor += n;
        }
        return { items: [], requestedOffset: offset, startOffset: start,
          nextOffset: cursor, truncatedBeforeOffset: true,
          oversizedLine: true };
      }
      // A not-yet-complete JSONL record must be reread later, not skipped.
      return { items: [], requestedOffset: offset, startOffset: start,
        nextOffset: start, truncatedBeforeOffset };
    }

    const complete = data.subarray(0, lastNewline + 1);
    const items = [];
    for (const line of complete.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line)); }
      catch { items.push(line); }
    }
    return {
      items, requestedOffset: offset, startOffset: start,
      nextOffset: start + complete.length, truncatedBeforeOffset,
    };
  } finally {
    await file.close();
  }
}

function queueDiagnostics(job) {
  if (job.status !== 'queued') return null;
  const queuedJobs = store.queued();
  const index = queuedJobs.findIndex((candidate) => candidate.id === job.id);
  const runningJobs = store.running().length;
  const launchingJobs = launching.size;
  const occupied = runningJobs + launchingJobs;
  const reason = launching.has(job.id)
    ? 'worker_starting'
    : occupied >= maxConcurrent
      ? 'capacity'
      : 'scheduler_pending';

  return {
    position: index >= 0 ? index + 1 : null,
    ahead: index >= 0 ? index : null,
    runningJobs,
    launchingJobs,
    maxConcurrent,
    reason,
  };
}

function managedSummary(job) {
  const base = job.job_kind === JOB_KIND_OPERATION ? operationSummary(job) : summary(job);
  return { ...base, queue: queueDiagnostics(job) };
}

async function snapshot(job, offsets = {}, mode = 'poll') {
  const base = managedSummary(job);
  const files = base.outputFiles;
  const isOperation = job.job_kind === JOB_KIND_OPERATION;

  if (mode === 'result') {
    const [stdout, stderr] = await Promise.all([
      readBytes(files.stdout, 0, 256 * 1024, true),
      readBytes(files.stderr, 0, 128 * 1024, true),
    ]);
    if (isOperation) {
      return {
        ...base,
        stdout: stdout.text,
        stderr: stderr.text,
        outputTruncated: stdout.truncatedBeforeOffset || stderr.truncatedBeforeOffset,
        output: {
          stdout: { observedBytes: stdout.observedBytes },
          stderr: { observedBytes: stderr.observedBytes },
        },
      };
    }

    const [events, invalid] = await Promise.all([
      readEvents(files.events, 0, 256 * 1024, true),
      readEvents(files.invalidLines, 0, 64 * 1024, true),
    ]);
    return {
      ...base, stdout: stdout.text, stderr: stderr.text,
      structured: { format: 'jsonl', events: events.items, invalidLines: invalid.items },
      outputTruncated: stdout.truncatedBeforeOffset || stderr.truncatedBeforeOffset ||
        events.truncatedBeforeOffset || invalid.truncatedBeforeOffset,
      output: { stdout: { observedBytes: stdout.observedBytes },
        stderr: { observedBytes: stderr.observedBytes },
        structuredEvents: { retainedFromOffset: events.startOffset },
        invalidLines: { retainedFromOffset: invalid.startOffset } },
    };
  }

  const [stdout, stderr] = await Promise.all([
    readBytes(files.stdout, offsets.stdoutOffset || 0),
    readBytes(files.stderr, offsets.stderrOffset || 0),
  ]);
  if (isOperation) {
    return {
      ...base,
      stdout: { ...stdout, requestedOffset: offsets.stdoutOffset || 0 },
      stderr: { ...stderr, requestedOffset: offsets.stderrOffset || 0 },
    };
  }

  const [events, invalid] = await Promise.all([
    readEvents(files.events, offsets.eventOffset || 0),
    readEvents(files.invalidLines, offsets.invalidLineOffset || 0),
  ]);
  return {
    ...base,
    stdout: { ...stdout, requestedOffset: offsets.stdoutOffset || 0 },
    stderr: { ...stderr, requestedOffset: offsets.stderrOffset || 0 },
    structured: {
      format: 'jsonl',
      events, invalidLines: invalid,
    },
  };
}

function hasEvidence(value, offsets) {
  return value.stdout.nextOffset > (offsets.stdoutOffset || 0) ||
    value.stderr.nextOffset > (offsets.stderrOffset || 0) ||
    value.structured.events.nextOffset > (offsets.eventOffset || 0) ||
    value.structured.invalidLines.nextOffset > (offsets.invalidLineOffset || 0);
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk.toString('utf8');
    if (data.length > 512 * 1024) fail('too_large', 'Request exceeds limit', 413);
  }
  try { return JSON.parse(data || '{}'); }
  catch { fail('invalid_json', 'Invalid JSON'); }
}

function jobOr404(id, expectedKind = null) {
  const job = store.get(id);
  if (!job || (expectedKind !== null && job.job_kind !== expectedKind)) {
    fail('not_found', 'Unknown job ID', 404);
  }
  return job;
}

async function serve(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'agent-jobd', maxConcurrent,
        queued: store.queued().length, running: store.running().length });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const input = validateStart(await body(req));
      const result = store.create(input);
      schedule();
      return json(res, 200, { ...managedSummary(store.get(result.job.id)),
        duplicate: result.duplicate });
    }
    if (req.method === 'GET' && url.pathname === '/jobs') {
      const limit = Number(url.searchParams.get('limit') || 64);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) fail('invalid_limit', 'limit must be 1-128');
      return json(res, 200, { jobs: store.list({
        cwd: url.searchParams.get('cwd') || undefined, limit, kind: JOB_KIND_AGENT,
      }).map(managedSummary) });
    }
    if (req.method === 'POST' && url.pathname === '/operations') {
      const input = validateOperationStart(await body(req));
      const result = store.createOperation(input);
      schedule();
      return json(res, 200, { ...managedSummary(store.get(result.job.id)),
        duplicate: result.duplicate });
    }
    if (req.method === 'GET' && url.pathname === '/operations') {
      const limit = Number(url.searchParams.get('limit') || 64);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) fail('invalid_limit', 'limit must be 1-128');
      return json(res, 200, { operations: store.list({
        cwd: url.searchParams.get('cwd') || undefined, limit, kind: JOB_KIND_OPERATION,
      }).map(managedSummary) });
    }

    const operationMatch = url.pathname.match(/^\/operations\/([0-9a-fA-F-]{36})(?:\/(poll|result|cancel))?$/);
    if (operationMatch) {
      const id = operationMatch[1];
      const action = operationMatch[2];
      if (req.method === 'GET' && action === 'result') {
        return json(res, 200, await snapshot(jobOr404(id, JOB_KIND_OPERATION), {}, 'result'));
      }
      if (req.method === 'GET' && action === 'poll') {
        const offsets = {};
        for (const key of ['stdoutOffset','stderrOffset']) {
          const value = Number(url.searchParams.get(key) || 0);
          if (!Number.isSafeInteger(value) || value < 0) fail('invalid_offset', 'Invalid ' + key);
          offsets[key] = value;
        }
        const waitMs = Number(url.searchParams.get('waitMs') || DEFAULT_POLL_WAIT_MS);
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_POLL_WAIT_MS) {
          fail('invalid_wait', 'waitMs must be 0-15000');
        }
        const started = Date.now();
        let job = jobOr404(id, JOB_KIND_OPERATION);
        let current = await snapshot(job, offsets);
        const hasOperationEvidence = () =>
          current.stdout.nextOffset > (offsets.stdoutOffset || 0) ||
          current.stderr.nextOffset > (offsets.stderrOffset || 0);
        while (waitMs > 0 && (job.status === 'queued' || job.status === 'running') &&
            !hasOperationEvidence() && Date.now() - started < waitMs && !res.destroyed) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(250, waitMs - (Date.now() - started))));
          job = jobOr404(id, JOB_KIND_OPERATION);
          current = await snapshot(job, offsets);
        }
        current.poll = { requestedWaitMs: waitMs, waitedMs: Date.now() - started,
          wakeReason: TERMINAL.has(job.status) ? 'terminal' :
            hasOperationEvidence() ? 'activity' : 'timeout' };
        return json(res, 200, current);
      }
      if (req.method === 'GET' && !action) {
        return json(res, 200, managedSummary(jobOr404(id, JOB_KIND_OPERATION)));
      }
      if (req.method === 'POST' && action === 'cancel') {
        const job = jobOr404(id, JOB_KIND_OPERATION);
        if (TERMINAL.has(job.status)) return json(res, 200, {
          ...managedSummary(job), cancellationRequested: false });
        store.requestCancel(id);
        if (job.status === 'queued') store.finish(id, 'cancelled', { reason: 'cancel' });
        else signalJob(store.get(id), 'cancel');
        return json(res, 200, { ...managedSummary(store.get(id)), cancellationRequested: true });
      }
      fail('not_found', 'Unknown endpoint', 404);
    }

    const match = url.pathname.match(/^\/jobs\/([0-9a-fA-F-]{36})(?:\/(poll|result|cancel))?$/);
    if (!match) fail('not_found', 'Unknown endpoint', 404);
    const id = match[1];
    const operation = match[2];
    if (req.method === 'GET' && operation === 'result') {
      return json(res, 200, await snapshot(jobOr404(id, JOB_KIND_AGENT), {}, 'result'));
    }
    if (req.method === 'GET' && operation === 'poll') {
      const offsets = {};
      for (const [key, query] of [
        ['stdoutOffset','stdoutOffset'],['stderrOffset','stderrOffset'],
        ['eventOffset','eventOffset'],['invalidLineOffset','invalidLineOffset'],
      ]) {
        const value = Number(url.searchParams.get(query) || 0);
        if (!Number.isSafeInteger(value) || value < 0) fail('invalid_offset', 'Invalid ' + key);
        offsets[key] = value;
      }
      const waitMs = Number(url.searchParams.get('waitMs') || DEFAULT_POLL_WAIT_MS);
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_POLL_WAIT_MS) {
        fail('invalid_wait', 'waitMs must be 0-15000');
      }
      const started = Date.now();
      let job = jobOr404(id, JOB_KIND_AGENT);
      let current = await snapshot(job, offsets);
      while (waitMs > 0 && (job.status === 'queued' || job.status === 'running') &&
          !hasEvidence(current, offsets) &&
          Date.now() - started < waitMs && !res.destroyed) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, waitMs - (Date.now() - started))));
        job = jobOr404(id, JOB_KIND_AGENT);
        current = await snapshot(job, offsets);
      }
      current.poll = { requestedWaitMs: waitMs, waitedMs: Date.now() - started,
        wakeReason: TERMINAL.has(job.status) ? 'terminal' :
          hasEvidence(current, offsets) ? 'activity' : 'timeout' };
      return json(res, 200, current);
    }
    if (req.method === 'GET' && !operation) {
      return json(res, 200, managedSummary(jobOr404(id, JOB_KIND_AGENT)));
    }
    if (req.method === 'POST' && operation === 'cancel') {
      const job = jobOr404(id, JOB_KIND_AGENT);
      if (TERMINAL.has(job.status)) return json(res, 200, {
        ...managedSummary(job), cancellationRequested: false });
      store.requestCancel(id);
      if (job.status === 'queued') store.finish(id, 'cancelled', { reason: 'cancel' });
      else signalJob(store.get(id), 'cancel');
      return json(res, 200, { ...managedSummary(store.get(id)), cancellationRequested: true });
    }
    fail('not_found', 'Unknown endpoint', 404);
  } catch (error) {
    const code = error.code === 'idempotency_conflict' ? 409 : error.httpStatus || 500;
    if (code === 500) console.error(error.stack || error.message);
    if (!res.headersSent) json(res, code, { error: error.code || 'internal_error',
      message: code === 500 ? 'Internal job manager error' : error.message });
  }
}

async function start() {
  const parent = path.dirname(socket);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  await fsp.chmod(parent, 0o700);
  // Never unlink a live manager's socket: a second instance must fail closed.
  if (fs.existsSync(socket)) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.request({ socketPath: socket, path: '/health', timeout: 1000 },
          (res) => { res.resume(); resolve(); });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('socket probe timed out')));
        request.end();
      });
      throw new Error('Another agent-jobd is already serving ' + socket);
    } catch (error) {
      if (error.message.startsWith('Another agent-jobd')) throw error;
      if (!['ECONNREFUSED','ENOENT'].includes(error.code)) throw error;
      await fsp.unlink(socket);
    }
  }
  schedule();
  const server = http.createServer((req, res) => { void serve(req, res); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await fsp.chmod(socket, 0o600);
  const interval = setInterval(schedule, 1000);
  console.log('agent-jobd listening at ' + socket);
  let stopping = false;
  for (const signal of ['SIGTERM','SIGINT']) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      clearInterval(interval);
      // Do not let in-flight 15s polls outlive systemd's 10s stop budget.
      // Workers are independent of HTTP requests: callers can reconnect
      // and resume with the same runId and last known stream offsets.
      server.close(() => {
        if (fs.existsSync(socket)) fs.unlinkSync(socket);
        store.close();
        process.exit(0);
      });
      server.closeAllConnections();
      // Detached workers remain alive across manager restart.
    });
  }
}

start().catch((error) => {
  console.error(error.stack || error.message);
  store.close();
  process.exitCode = 1;
});
