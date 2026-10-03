import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const MAX_JOB_TIMEOUT_MS = 8 * 60 * 60 * 1000;
export const MAX_POLL_WAIT_MS = 15_000;
export const DEFAULT_POLL_WAIT_MS = 10_000;
export const TERMINAL = new Set(['completed', 'failed', 'ambiguous', 'cancelled', 'timed_out', 'interrupted']);
export const JOB_KIND_AGENT = 'agent';
export const JOB_KIND_OPERATION = 'operation';

export function stateRoot(env = process.env) {
  return path.resolve(env.AGENT_JOB_STATE_DIR || path.join(
    env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state'),
    'agent-vm-mcp', 'jobs',
  ));
}

export function socketPath(env = process.env) {
  return path.resolve(env.AGENT_JOB_SOCKET_PATH || path.join(stateRoot(env), 'jobd.sock'));
}

export function processStartTicks(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return fields[19] ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19] : null;
  } catch {
    return null;
  }
}

export function sameProcess(job) {
  return job.pid != null && job.pid_start != null &&
    processStartTicks(job.pid) === job.pid_start;
}

export function summary(job) {
  return {
    runId: job.id,
    kind: job.job_kind || JOB_KIND_AGENT,
    harness: job.harness,
    cwd: job.cwd,
    status: job.status,
    accepted: true,
    processAlive: job.status === 'running' && sameProcess(job),
    pid: job.pid,
    childPid: job.child_pid,
    exitCode: job.exit_code,
    signal: job.signal,
    startedAt: job.started_at,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    lastActivityAt: job.last_output_at || job.started_at || job.created_at,
    lastOutputAt: job.last_output_at,
    timeoutMs: job.timeout_ms,
    terminationReason: job.termination_reason,
    cancellationRequested: Boolean(job.cancel_requested),
    cleanupPending: Boolean(job.cleanup_pending),
    continuationId: job.continuation_id,
    policy: job.policy_json ? JSON.parse(job.policy_json) : null,
    outputFiles: {
      stdout: path.join(job.output_dir, 'stdout.log'),
      stderr: path.join(job.output_dir, 'stderr.log'),
      events: path.join(job.output_dir, 'events.jsonl'),
      invalidLines: path.join(job.output_dir, 'invalid.jsonl'),
    },
  };
}

function operationOutcome(job) {
  if (job.status === 'queued') {
    return { command: 'pending', certainty: 'known', sideEffectsMayHaveOccurred: false };
  }
  if (job.status === 'running') {
    return { command: 'pending', certainty: 'known', sideEffectsMayHaveOccurred: true };
  }
  if (job.status === 'completed') {
    return { command: 'succeeded', certainty: 'known', sideEffectsMayHaveOccurred: true };
  }
  if (job.status === 'interrupted') {
    return { command: 'unknown', certainty: 'unknown', sideEffectsMayHaveOccurred: true };
  }
  return { command: 'not_succeeded', certainty: 'known', sideEffectsMayHaveOccurred: true };
}

export function operationSummary(job) {
  const command = job.command_json ? JSON.parse(job.command_json) : null;
  return {
    operationId: job.id,
    kind: JOB_KIND_OPERATION,
    category: job.category || null,
    label: job.label || null,
    cwd: job.cwd,
    status: job.status,
    accepted: true,
    processAlive: job.status === 'running' && sameProcess(job),
    pid: job.pid,
    childPid: job.child_pid,
    exitCode: job.exit_code,
    signal: job.signal,
    startedAt: job.started_at,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    lastActivityAt: job.last_output_at || job.started_at || job.created_at,
    lastOutputAt: job.last_output_at,
    timeoutMs: job.timeout_ms,
    terminationReason: job.termination_reason,
    cancellationRequested: Boolean(job.cancel_requested),
    cleanupPending: Boolean(job.cleanup_pending),
    command,
    outcome: operationOutcome(job),
    idempotencyKeyPresent: job.idempotency_key !== null,
    outputFiles: {
      stdout: path.join(job.output_dir, 'stdout.log'),
      stderr: path.join(job.output_dir, 'stderr.log'),
    },
  };
}

export function openStore(root = stateRoot()) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const filename = path.join(root, 'jobs.sqlite');
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS jobs (' +
    'id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, request_hash TEXT NOT NULL,' +
    'harness TEXT NOT NULL, cwd TEXT NOT NULL, task TEXT NOT NULL, skills TEXT NOT NULL,' +
    'policy_json TEXT,' +
    'timeout_ms INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER, pid_start TEXT,' +
    'child_pid INTEGER, child_pid_start TEXT,' +
    'created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, last_output_at TEXT,' +
    'exit_code INTEGER, signal TEXT, termination_reason TEXT, continuation_id TEXT,' +
    'cancel_requested INTEGER NOT NULL DEFAULT 0, cleanup_pending INTEGER NOT NULL DEFAULT 0, output_dir TEXT NOT NULL' +
    '); CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status,created_at);'
  );
  const columns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name));
  for (const [name, definition] of [
    ['job_kind', "TEXT NOT NULL DEFAULT 'agent'"],
    ['command_json', 'TEXT'],
    ['env_json', 'TEXT'],
    ['category', 'TEXT'],
    ['label', 'TEXT'],
  ]) {
    if (!columns.has(name)) db.exec('ALTER TABLE jobs ADD COLUMN ' + name + ' ' + definition);
  }
  db.exec('CREATE INDEX IF NOT EXISTS jobs_by_kind_status ON jobs(job_kind,status,created_at);');
  fs.chmodSync(filename, 0o600);
  return {
    root,
    db,
    get(id) {
      return db.prepare('SELECT * FROM jobs WHERE id=?').get(id) || null;
    },
    list({ cwd, limit = 64, kind } = {}) {
      if (cwd && kind) return db.prepare(
        'SELECT * FROM jobs WHERE cwd=? AND job_kind=? ORDER BY created_at DESC LIMIT ?'
      ).all(path.resolve(cwd), kind, limit);
      if (cwd) return db.prepare(
        'SELECT * FROM jobs WHERE cwd=? ORDER BY created_at DESC LIMIT ?'
      ).all(path.resolve(cwd), limit);
      if (kind) return db.prepare(
        'SELECT * FROM jobs WHERE job_kind=? ORDER BY created_at DESC LIMIT ?'
      ).all(kind, limit);
      return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
    },
    queued() {
      return db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 64").all();
    },
    running() {
      return db.prepare("SELECT * FROM jobs WHERE status='running' ORDER BY created_at").all();
    },
    cleanupPending() {
      return db.prepare("SELECT * FROM jobs WHERE cleanup_pending=1 ORDER BY created_at").all();
    },
    requestCleanup(id) {
      db.prepare('UPDATE jobs SET cleanup_pending=1 WHERE id=?').run(id);
    },
    finishCleanup(id) {
      db.prepare('UPDATE jobs SET cleanup_pending=0 WHERE id=?').run(id);
    },
    create(input) {
      const canonical = {
        harness: input.harness,
        cwd: path.resolve(input.cwd),
        task: input.task,
        skills: input.skills || [],
        timeoutMs: input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
      };
      const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      const key = input.idempotencyKey || null;
      if (key !== null) {
        const existing = db.prepare('SELECT * FROM jobs WHERE idempotency_key=?').get(key);
        if (existing) {
          if (existing.job_kind !== JOB_KIND_AGENT || existing.request_hash !== digest) {
            const error = new Error('idempotencyKey already belongs to a different request');
            error.code = 'idempotency_conflict';
            throw error;
          }
          return { job: existing, duplicate: true };
        }
      }
      const policy = input.harness === 'codex' ? {
        model: process.env.AGENT_CODEX_ENFORCED_MODEL || 'gpt-5.6-luna',
        effort: process.env.AGENT_CODEX_ENFORCED_EFFORT || 'max',
      } : null;
      const id = randomUUID();
      const directory = path.join(root, id);
      fs.mkdirSync(directory, { mode: 0o700 });
      const createdAt = new Date().toISOString();
      try {
        db.prepare(
          'INSERT INTO jobs (id,idempotency_key,request_hash,job_kind,harness,cwd,task,skills,policy_json,timeout_ms,status,created_at,output_dir) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(id,key,digest,JOB_KIND_AGENT,canonical.harness,canonical.cwd,canonical.task,
          JSON.stringify(canonical.skills),policy === null ? null : JSON.stringify(policy),
          canonical.timeoutMs,'queued',createdAt,directory);
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      return { job: this.get(id), duplicate: false };
    },
    createOperation(input) {
      const canonicalEnv = Object.fromEntries(
        Object.entries(input.env || {}).sort(([left], [right]) => left.localeCompare(right)),
      );
      const canonical = {
        kind: JOB_KIND_OPERATION,
        cwd: path.resolve(input.cwd),
        command: input.command,
        env: canonicalEnv,
        timeoutMs: input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        category: input.category || null,
        label: input.label || null,
      };
      const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      const key = input.idempotencyKey || null;
      if (key !== null) {
        const existing = db.prepare('SELECT * FROM jobs WHERE idempotency_key=?').get(key);
        if (existing) {
          if (existing.job_kind !== JOB_KIND_OPERATION || existing.request_hash !== digest) {
            const error = new Error('idempotencyKey already belongs to a different request');
            error.code = 'idempotency_conflict';
            throw error;
          }
          return { job: existing, duplicate: true };
        }
      }
      const id = randomUUID();
      const directory = path.join(root, id);
      fs.mkdirSync(directory, { mode: 0o700 });
      const createdAt = new Date().toISOString();
      try {
        db.prepare(
          'INSERT INTO jobs (id,idempotency_key,request_hash,job_kind,harness,cwd,task,skills,policy_json,timeout_ms,status,created_at,output_dir,command_json,env_json,category,label) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(id,key,digest,JOB_KIND_OPERATION,'command',canonical.cwd,'','[]',null,
          canonical.timeoutMs,'queued',createdAt,directory,JSON.stringify(canonical.command),
          JSON.stringify(canonical.env),canonical.category,canonical.label);
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      return { job: this.get(id), duplicate: false };
    },
    markStarted(id, pid, ticks) {
      db.prepare(
        "UPDATE jobs SET status='running',started_at=?,pid=?,pid_start=? WHERE id=? AND status='queued'"
      ).run(new Date().toISOString(),pid,ticks,id);
    },
    markChild(id, pid, ticks) {
      db.prepare(
        "UPDATE jobs SET child_pid=?,child_pid_start=? WHERE id=? AND status='running'"
      ).run(pid,ticks,id);
    },
    markOutput(id, continuationId = null) {
      db.prepare(
        "UPDATE jobs SET last_output_at=?,continuation_id=COALESCE(?,continuation_id) WHERE id=? AND status='running'"
      ).run(new Date().toISOString(),continuationId,id);
    },
    finish(id, status, { exitCode = null, signal = null, reason = null, continuationId = null } = {}) {
      db.prepare(
        "UPDATE jobs SET status=?,finished_at=?,exit_code=?,signal=?,termination_reason=?,continuation_id=COALESCE(?,continuation_id) WHERE id=? AND status IN ('running','queued')"
      ).run(status,new Date().toISOString(),exitCode,signal,reason,continuationId,id);
    },
    requestCancel(id) {
      db.prepare("UPDATE jobs SET cancel_requested=1,cleanup_pending=CASE WHEN status='running' THEN 1 ELSE cleanup_pending END WHERE id=?").run(id);
    },
    close() {
      db.close();
    },
  };
}
