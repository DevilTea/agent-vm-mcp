import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-operation-'));
const state = path.join(root, 'state');
const workspace = path.join(root, 'workspace');
await Promise.all([fs.mkdir(state), fs.mkdir(workspace)]);
const env = {
  ...process.env,
  AGENT_JOB_STATE_DIR: state,
  AGENT_JOB_MAX_CONCURRENT: '1',
};
process.env.AGENT_JOB_STATE_DIR = state;
const {
  jobList,
  operationCancel,
  operationList,
  operationPoll,
  operationResult,
  operationStart,
} = await import('../src/agent-jobs/client.js');
const managerPath = fileURLToPath(new URL('../src/agent-jobs/manager.js', import.meta.url));
let manager;
let log = '';

function startManager() {
  const child = spawn(process.execPath, [managerPath], {
    env,
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { log += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { log += chunk.toString('utf8'); });
  manager = child;
  return child;
}

async function ready() {
  for (let i = 0; i < 100; i += 1) {
    try {
      await operationList();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Manager did not start: ' + log);
}

async function stopManager(signal = 'SIGTERM') {
  if (!manager || manager.exitCode !== null) return;
  const current = manager;
  await new Promise((resolve) => {
    current.once('exit', resolve);
    current.kill(signal);
  });
}

async function waitFor(operationId, expected = 'terminal', deadlineMs = 10_000) {
  const end = Date.now() + deadlineMs;
  let last;
  while (Date.now() < end) {
    last = await operationPoll({ operationId, waitMs: 200 });
    if (expected === 'running' ? last.status === 'running' : !['queued', 'running'].includes(last.status)) {
      return last;
    }
  }
  throw new Error('Operation did not reach expected status: ' + JSON.stringify(last));
}

async function waitCleanup(operationId, deadlineMs = 8_000) {
  const end = Date.now() + deadlineMs;
  let last;
  while (Date.now() < end) {
    last = await operationResult({ operationId });
    if (!last.cleanupPending) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Operation cleanup did not finish: ' + JSON.stringify(last));
}

const migrationState = path.join(root, 'migration-state');
const migrationOutput = path.join(migrationState, 'legacy-output');
await fs.mkdir(migrationOutput, { recursive: true });
const legacyDb = new DatabaseSync(path.join(migrationState, 'jobs.sqlite'));
legacyDb.exec(
  'CREATE TABLE jobs (' +
    'id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, request_hash TEXT NOT NULL,' +
    'harness TEXT NOT NULL, cwd TEXT NOT NULL, task TEXT NOT NULL, skills TEXT NOT NULL,' +
    'policy_json TEXT,' +
    'timeout_ms INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER, pid_start TEXT,' +
    'child_pid INTEGER, child_pid_start TEXT,' +
    'created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, last_output_at TEXT,' +
    'exit_code INTEGER, signal TEXT, termination_reason TEXT, continuation_id TEXT,' +
    'cancel_requested INTEGER NOT NULL DEFAULT 0, cleanup_pending INTEGER NOT NULL DEFAULT 0, output_dir TEXT NOT NULL' +
    ')',
);
const legacyId = '00000000-0000-4000-8000-000000000001';
legacyDb.prepare(
  'INSERT INTO jobs (id,request_hash,harness,cwd,task,skills,timeout_ms,status,created_at,output_dir) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)',
).run(
  legacyId,
  'legacy-hash',
  'codex',
  workspace,
  'legacy task',
  '[]',
  5000,
  'completed',
  new Date().toISOString(),
  migrationOutput,
);
legacyDb.close();
const { openStore } = await import('../src/agent-jobs/store.js');
const migratedStore = openStore(migrationState);
try {
  const columns = new Set(
    migratedStore.db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name),
  );
  for (const column of ['job_kind', 'command_json', 'env_json', 'category', 'label']) {
    assert.ok(columns.has(column), 'Migration must add durable-operation column: ' + column);
  }
  assert.equal(migratedStore.get(legacyId).job_kind, 'agent');
} finally {
  migratedStore.close();
}

try {
  startManager();
  await ready();
  assert.equal((await operationList()).operations.length, 0);

  const first = await operationStart({
    cwd: workspace,
    argv: [process.execPath, '-e', "process.stdout.write('alpha\\n')"],
    timeoutMs: 5000,
    idempotencyKey: 'operation-lost-response',
    category: 'test',
    label: 'Lost response fixture',
  });
  assert.equal(first.accepted, true);
  assert.equal(first.kind, 'operation');
  assert.equal(first.category, 'test');
  assert.equal(first.label, 'Lost response fixture');
  assert.equal(first.outcome.command, 'pending');
  assert.equal(first.outcome.sideEffectsMayHaveOccurred, false);
  assert.equal(first.idempotencyKeyPresent, true);

  // Treat the first response as if the client lost it: retrying the same logical
  // request must rediscover the same durable operation, never execute a duplicate.
  const duplicate = await operationStart({
    cwd: workspace,
    argv: [process.execPath, '-e', "process.stdout.write('alpha\\n')"],
    timeoutMs: 5000,
    idempotencyKey: 'operation-lost-response',
    category: 'test',
    label: 'Lost response fixture',
  });
  assert.equal(duplicate.operationId, first.operationId);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    () => operationStart({
      cwd: workspace,
      argv: [process.execPath, '-e', "process.stdout.write('different\\n')"],
      timeoutMs: 5000,
      idempotencyKey: 'operation-lost-response',
      category: 'test',
      label: 'Lost response fixture',
    }),
    (error) => error.code === 'idempotency_conflict',
  );

  const envOrderFirst = await operationStart({
    cwd: workspace,
    argv: [process.execPath, '-e', "process.stdout.write(process.env.A + process.env.B + '\\n')"],
    env: { A: '1', B: '2' },
    timeoutMs: 5000,
    idempotencyKey: 'operation-env-order',
  });
  const envOrderRetry = await operationStart({
    cwd: workspace,
    argv: [process.execPath, '-e', "process.stdout.write(process.env.A + process.env.B + '\\n')"],
    env: { B: '2', A: '1' },
    timeoutMs: 5000,
    idempotencyKey: 'operation-env-order',
  });
  assert.equal(envOrderRetry.operationId, envOrderFirst.operationId);
  assert.equal(envOrderRetry.duplicate, true);
  assert.equal((await waitFor(envOrderFirst.operationId)).status, 'completed');

  await assert.rejects(
    () => operationStart({
      cwd: workspace,
      command: "printf 'must-not-start\\n'",
      env: { AGENT_JOB_RUN_ID: 'tampered' },
      timeoutMs: 5000,
    }),
    (error) => error.code === 'invalid_env',
  );

  const completed = await waitFor(first.operationId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.exitCode, 0);
  assert.deepEqual(completed.outcome, {
    command: 'succeeded', certainty: 'known', sideEffectsMayHaveOccurred: true,
  });
  const firstResult = await operationResult({ operationId: first.operationId });
  assert.equal(firstResult.stdout, 'alpha\n');
  assert.equal(firstResult.stderr, '');
  assert.ok(firstResult.outputFiles.stdout.endsWith('/stdout.log'));

  const firstPoll = await operationPoll({ operationId: first.operationId, waitMs: 0 });
  assert.equal(firstPoll.stdout.text, 'alpha\n');
  assert.equal(typeof firstPoll.cursor, 'string');
  const resumed = await operationPoll({
    operationId: first.operationId,
    cursor: firstPoll.cursor,
    waitMs: 0,
  });
  assert.equal(resumed.stdout.text, '');
  await assert.rejects(
    () => operationPoll({
      operationId: first.operationId,
      cursor: firstPoll.cursor,
      stdoutOffset: 0,
      waitMs: 0,
    }),
    (error) => error.code === 'CURSOR_OFFSET_CONFLICT',
  );

  const other = await operationStart({
    cwd: workspace,
    command: "printf 'other\\n'",
    timeoutMs: 5000,
    idempotencyKey: 'operation-other',
  });
  await assert.rejects(
    () => operationPoll({
      operationId: other.operationId,
      cursor: firstPoll.cursor,
      waitMs: 0,
    }),
    (error) => error.code === 'CURSOR_TARGET_MISMATCH',
  );
  assert.equal((await waitFor(other.operationId)).status, 'completed');

  const failing = await operationStart({
    cwd: workspace,
    argv: [process.execPath, '-e', "process.stderr.write('boom\\n'); process.exit(7)"],
    timeoutMs: 5000,
  });
  const failed = await waitFor(failing.operationId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 7);
  assert.deepEqual(failed.outcome, {
    command: 'not_succeeded', certainty: 'known', sideEffectsMayHaveOccurred: true,
  });
  assert.match((await operationResult({ operationId: failing.operationId })).stderr, /boom/);

  const missingExecutable = await operationStart({
    cwd: workspace,
    argv: ['/definitely/not/a/real/executable'],
    timeoutMs: 5000,
  });
  const missingExecutableResult = await waitFor(missingExecutable.operationId);
  assert.equal(missingExecutableResult.status, 'failed');
  assert.match(
    (await operationResult({ operationId: missingExecutable.operationId })).stderr,
    /ENOENT|no such file/i,
  );

  const timed = await operationStart({
    cwd: workspace,
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 1100,
  });
  assert.equal((await waitFor(timed.operationId)).status, 'timed_out');

  const cancellable = await operationStart({
    cwd: workspace,
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 5000,
  });
  assert.equal((await waitFor(cancellable.operationId, 'running')).status, 'running');
  assert.equal((await operationCancel({ operationId: cancellable.operationId })).cancellationRequested, true);
  assert.equal((await waitFor(cancellable.operationId)).status, 'cancelled');

  const restart = await operationStart({
    cwd: workspace,
    command: "printf 'before\\n'; sleep 2; printf 'after\\n'",
    timeoutMs: 5000,
    idempotencyKey: 'operation-manager-restart',
  });
  let running = await waitFor(restart.operationId, 'running');
  for (let i = 0; i < 30 && running.stdout.observedBytes === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    running = await operationPoll({ operationId: restart.operationId, waitMs: 0 });
  }
  assert.match(running.stdout.text, /before/);
  await stopManager('SIGKILL');
  startManager();
  await ready();
  const rediscovered = await operationList({ cwd: workspace });
  assert.ok(rediscovered.operations.some((operation) => operation.operationId === restart.operationId));
  assert.equal((await waitFor(restart.operationId, 'terminal', 10_000)).status, 'completed');
  assert.match((await operationResult({ operationId: restart.operationId })).stdout, /before\nafter/);

  const interruptedStart = await operationStart({
    cwd: workspace,
    command: "printf 'side-effect-started\\n'; sleep 10",
    timeoutMs: 5000,
    idempotencyKey: 'operation-worker-lost',
  });
  let interruptedRunning = await waitFor(interruptedStart.operationId, 'running');
  for (let i = 0; i < 40 && !interruptedRunning.childPid; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    interruptedRunning = await operationPoll({ operationId: interruptedStart.operationId, waitMs: 0 });
  }
  assert.ok(interruptedRunning.pid, 'Worker PID must be observable before fault injection');
  assert.ok(interruptedRunning.childPid, 'Command PID must be observable before fault injection');
  process.kill(interruptedRunning.pid, 'SIGKILL');
  const interrupted = await waitFor(interruptedStart.operationId, 'terminal', 10_000);
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.outcome, {
    command: 'unknown', certainty: 'unknown', sideEffectsMayHaveOccurred: true,
  });
  assert.match((await operationResult({ operationId: interruptedStart.operationId })).stdout, /side-effect-started/);
  await waitCleanup(interruptedStart.operationId);

  assert.equal((await jobList({ cwd: workspace })).jobs.length, 0,
    'Generic operations must not leak into agent_list');
  assert.ok((await operationList({ cwd: workspace })).operations.length >= 6);

  const bridgeConfig = path.join(root, 'bridges.json');
  const checkpointState = path.join(root, 'checkpoints');
  await fs.writeFile(bridgeConfig, '{"version":1,"bridges":[]}\n');
  const mcp = new Client({ name: 'durable-operation-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    cwd: workspace,
    env: {
      ...env,
      MCP_BRIDGES_CONFIG: bridgeConfig,
      AGENT_MCP_HOST: 'generic',
      AGENT_WORK_CHECKPOINT_STATE_DIR: checkpointState,
    },
    stderr: 'pipe',
  });
  await mcp.connect(transport);
  try {
    const textResult = (result) => {
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return JSON.parse(result.content.find((item) => item.type === 'text').text);
    };
    const mcpStarted = textResult(await mcp.callTool({
      name: 'operation_start',
      arguments: {
        cwd: workspace,
        command: "printf 'mcp-operation\\n'",
        timeoutMs: 5000,
        idempotencyKey: 'operation-mcp-surface',
        category: 'smoke',
      },
    }));
    const mcpDuplicate = textResult(await mcp.callTool({
      name: 'operation_start',
      arguments: {
        cwd: workspace,
        command: "printf 'mcp-operation\\n'",
        timeoutMs: 5000,
        idempotencyKey: 'operation-mcp-surface',
        category: 'smoke',
      },
    }));
    assert.equal(mcpDuplicate.operationId, mcpStarted.operationId);
    assert.equal(mcpDuplicate.duplicate, true);

    const mcpConflict = await mcp.callTool({
      name: 'operation_start',
      arguments: {
        cwd: workspace,
        command: "printf 'different-mcp-operation\\n'",
        timeoutMs: 5000,
        idempotencyKey: 'operation-mcp-surface',
        category: 'smoke',
      },
    });
    assert.equal(mcpConflict.isError, true);
    const mcpConflictError = JSON.parse(
      mcpConflict.content.find((item) => item.type === 'text').text,
    ).error;
    assert.equal(mcpConflictError.code, 'IDEMPOTENCY_CONFLICT');

    let mcpPolled;
    for (let i = 0; i < 30; i += 1) {
      mcpPolled = textResult(await mcp.callTool({
        name: 'operation_poll',
        arguments: { operationId: mcpStarted.operationId, waitMs: 250 },
      }));
      if (!['queued', 'running'].includes(mcpPolled.status)) break;
    }
    assert.equal(mcpPolled.status, 'completed');
    assert.equal(mcpPolled.outcome.command, 'succeeded');

    const status = textResult(await mcp.callTool({
      name: 'work_status',
      arguments: { cwd: workspace },
    }));
    assert.ok(status.durableOperations.some(
      (operation) => operation.operationId === mcpStarted.operationId,
    ));
  } finally {
    await mcp.close();
  }

  const offlineState = path.join(root, 'offline-job-service');
  const offlineMcp = new Client({ name: 'durable-operation-offline-smoke', version: '1.0.0' });
  const offlineTransport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    cwd: workspace,
    env: {
      ...env,
      AGENT_JOB_STATE_DIR: offlineState,
      MCP_BRIDGES_CONFIG: bridgeConfig,
      AGENT_MCP_HOST: 'generic',
      AGENT_WORK_CHECKPOINT_STATE_DIR: checkpointState,
    },
    stderr: 'pipe',
  });
  await offlineMcp.connect(offlineTransport);
  try {
    const offlineStatusResult = await offlineMcp.callTool({
      name: 'work_status',
      arguments: { cwd: workspace },
    });
    assert.equal(offlineStatusResult.isError, undefined, JSON.stringify(offlineStatusResult.content));
    const offlineStatus = JSON.parse(
      offlineStatusResult.content.find((item) => item.type === 'text').text,
    );
    assert.equal(offlineStatus.backgroundJobService.available, false);
    assert.equal(offlineStatus.backgroundJobService.error, 'agent_job_service_unavailable');
    assert.equal(typeof offlineStatus.backgroundJobService.message, 'string');
    assert.equal(
      offlineStatus.backgroundJobService.errors.agentJobs.error,
      'agent_job_service_unavailable',
    );
    assert.equal(
      offlineStatus.backgroundJobService.errors.operations.error,
      'agent_job_service_unavailable',
    );
  } finally {
    await offlineMcp.close();
  }

  console.log('PASS durable operations: migration, idempotent lost-response recovery, stable env hashing, ownership guards, failure/timeout/cancel, restart survival, offline recovery');
} finally {
  await stopManager();
  await fs.rm(root, { recursive: true, force: true });
}
