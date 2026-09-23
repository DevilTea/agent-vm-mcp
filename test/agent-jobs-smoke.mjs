import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-job-v1-'));
const bin = path.join(root, 'bin');
const state = path.join(root, 'state');
const workspace = path.join(root, 'workspace');
await Promise.all([fs.mkdir(bin), fs.mkdir(state), fs.mkdir(workspace)]);
const fakeCodex = path.join(bin, 'codex');
await fs.writeFile(fakeCodex, [
  '#!/bin/sh',
  'case "$*" in',
  ' *timeout-sentinel*) sleep 10 ;;',
  ' *orphan-sentinel*) echo \'{"type":"thread.started","thread_id":"orphan-thread"}\'; sleep 10 ;;',
  ' *stubborn-sentinel*) (trap "" TERM; sleep 30) >/dev/null 2>&1 </dev/null & echo \'{"type":"thread.started","thread_id":"stubborn-thread"}\'; sleep 30 ;;',
  ' *failed-sentinel*) echo "synthetic failure" >&2; exit 2 ;;',
  ' *partial-sentinel*) printf \'{"type":"thread.started","thread_id":"partial-thread"}\'; sleep 1; printf "\\n" ;;',
  ' *large-sentinel*) head -c 900000 /dev/zero | tr "\\000" x; printf "\\n" ;;',
  ' *cancel-sentinel*) echo \'{"type":"thread.started","thread_id":"cancel-thread"}\'; sleep 10 ;;',
  ' *restart-sentinel*) echo \'{"type":"thread.started","thread_id":"restart-thread"}\'; sleep 2; echo \'{"type":"turn.completed","status":"done"}\' ;;',
  ' *) echo \'{"type":"thread.started","thread_id":"test-thread"}\'; echo \'{"type":"turn.completed","status":"done"}\' ;;',
  'esac',
  ''
].join('\n'), { mode: 0o755 });
const fakeAgy = path.join(bin, 'agy');
const agyArgsLog = path.join(root, 'agy-args.log');
await fs.writeFile(fakeAgy, String.raw`#!/bin/sh
printf '%s\n' "$@" >> "$AGENT_JOB_AGY_ARGS_LOG"
case "$*" in
  *agy-success-sentinel*)
    printf '%s\n' '{"event":"init","conversation_id":"agy-success-conversation"}'
    printf '%s\n' '{"event":"tool","status":"ERROR","error":"recoverable fixture error"}'
    printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"done","denied_actions":[]}}'
    ;;
  *agy-omitted-denied-sentinel*)
    printf '%s\n' '{"event":"init","conversation_id":"agy-omitted-conversation"}'
    printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"done"}}'
    ;;
  *agy-error-sentinel*)
    printf '%s\n' '{"event":"init","conversation_id":"agy-error-conversation"}'
    printf '%s\n' '{"event":"result","result":{"status":"ERROR","response":"failed","denied_actions":[]}}'
    ;;
  *agy-denied-sentinel*)
    printf '%s\n' '{"event":"init","conversation_id":"agy-denied-conversation"}'
    printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"blocked","denied_actions":["write_file"]}}'
    ;;
  *agy-malformed-denied-sentinel*)
    printf '%s\n' '{"event":"init","conversation_id":"agy-malformed-conversation"}'
    printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"bad","denied_actions":null}}'
    ;;
  *agy-missing-sentinel*)
    printf '%s\n' '{"event":"init","conversation_id":"agy-missing-conversation"}'
    ;;
  *agy-nonzero-sentinel*)
    printf '%s\n' '{"event":"init","conversation_id":"agy-nonzero-conversation"}'
    printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"done","denied_actions":[]}}'
    exit 3
    ;;
  *)
    printf '%s\n' '{"event":"init","conversation_id":"agy-default-conversation"}'
    printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"done","denied_actions":[]}}'
    ;;
esac
`, { mode: 0o755 });
const env = {
  ...process.env,
  AGENT_JOB_STATE_DIR: state,
  AGENT_JOB_MAX_CONCURRENT: '1',
  AGENT_JOB_CODEX_BIN: fakeCodex,
  AGENT_JOB_AGY_BIN: fakeAgy,
  AGENT_JOB_AGY_ARGS_LOG: agyArgsLog,
};
process.env.AGENT_JOB_STATE_DIR = state;
const { jobHealth, jobStart, jobList, jobPoll, jobResult, jobCancel } =
  await import('../src/agent-jobs/client.js');
const managerPath = fileURLToPath(new URL('../src/agent-jobs/manager.js', import.meta.url));
let manager;
let log = '';

function startManager() {
  const child = spawn(process.execPath, [managerPath], {
    env, cwd: workspace, stdio: ['ignore','pipe','pipe'],
  });
  child.stdout.on('data', (chunk) => { log += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { log += chunk.toString('utf8'); });
  manager = child;
  return child;
}
async function ready() {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await jobHealth()).ok) return;
    } catch { /* retry until the server is listening */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Manager did not start: ' + log);
}
async function stopManager() {
  if (!manager || manager.exitCode !== null) return;
  const current = manager;
  await new Promise((resolve) => {
    current.once('exit', resolve);
    current.kill('SIGTERM');
  });
}
async function waitCleanup(id, deadlineMs = 6_000) {
  const end = Date.now() + deadlineMs;
  let job;
  do {
    job = await jobResult({ runId: id });
    if (!job.cleanupPending) return job;
    await new Promise((resolve) => setTimeout(resolve, 125));
  } while (Date.now() < end);
  assert.equal(job.cleanupPending, false, 'Persisted cleanup must finish for job ' + id);
  return job;
}

async function waitFor(id, terminal = true, deadlineMs = 10_000) {
  const end = Date.now() + deadlineMs;
  let last;
  while (Date.now() < end) {
    last = await jobPoll({ runId: id, waitMs: 200 });
    if (terminal ? !['queued','running'].includes(last.status) : last.status === 'running') return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Job did not reach expected status: ' + JSON.stringify(last));
}

try {
  startManager();
  await ready();
  const initial = await jobHealth();
  assert.equal(initial.maxConcurrent, 1);
  assert.equal((await jobList()).jobs.length, 0);

  const first = await jobStart({
    harness: 'codex', cwd: workspace, task: 'quick-sentinel',
    timeoutMs: 5000, idempotencyKey: 'test-unique-quick',
  });
  assert.equal(first.accepted, true);
  assert.deepEqual(first.policy, { model: 'gpt-5.6-luna', effort: 'max' });
  const duplicate = await jobStart({
    harness: 'codex', cwd: workspace, task: 'quick-sentinel',
    timeoutMs: 5000, idempotencyKey: 'test-unique-quick',
  });
  assert.equal(duplicate.runId, first.runId);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(() => jobStart({
    harness: 'codex', cwd: workspace, task: 'changed-sentinel',
    timeoutMs: 5000, idempotencyKey: 'test-unique-quick',
  }), (error) => error.code === 'idempotency_conflict');
  assert.equal((await waitFor(first.runId)).status, 'completed');
  const result = await jobResult({ runId: first.runId });
  assert.equal(result.status, 'completed');
  assert.equal(result.continuationId, 'test-thread');
  assert.match(result.stdout, /thread.started/);
  assert.ok(result.outputFiles.stdout.endsWith('/stdout.log'));
  assert.match(await fs.readFile(result.outputFiles.events, 'utf8'), /turn.completed/);
  const snapshot = await jobPoll({ runId: first.runId, waitMs: 0 });
  assert.equal(snapshot.structured.events.items.length, 2);
  const resumed = await jobPoll({
    runId: first.runId, waitMs: 0,
    stdoutOffset: snapshot.stdout.nextOffset,
    stderrOffset: snapshot.stderr.nextOffset,
    eventOffset: snapshot.structured.events.nextOffset,
    invalidLineOffset: snapshot.structured.invalidLines.nextOffset,
  });
  assert.deepEqual(resumed.structured.events.items, []);

  const restartJob = await jobStart({
    harness: 'codex', cwd: workspace, task: 'restart-sentinel',
    timeoutMs: 5000, idempotencyKey: 'test-restart',
  });
  assert.equal((await waitFor(restartJob.runId, false)).status, 'running');
  const queued = await jobStart({
    harness: 'codex', cwd: workspace, task: 'queued-sentinel',
    timeoutMs: 5000, idempotencyKey: 'test-queued',
  });
  assert.equal(queued.status, 'queued');
  const waitQueuedStarted = Date.now();
  const queuedWait = await jobPoll({ runId: queued.runId, waitMs: 250 });
  assert.equal(queuedWait.status, 'queued');
  assert.ok(Date.now() - waitQueuedStarted >= 175, 'Queued jobs should long-poll instead of spin');
  assert.equal((await jobCancel({ runId: queued.runId })).status, 'cancelled');
  // Simulate an unexpected manager crash, not just graceful shutdown:
  // the detached worker must survive and remain discoverable after restart.
  const crashedManager = manager;
  await new Promise((resolve) => {
    crashedManager.once('exit', resolve);
    crashedManager.kill('SIGKILL');
  });
  startManager();
  await ready();
  const afterRestart = await jobList({ cwd: workspace });
  assert.ok(afterRestart.jobs.some((item) => item.runId === restartJob.runId));
  const finished = await waitFor(restartJob.runId, true, 10_000);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal((await jobResult({ runId: restartJob.runId })).continuationId, 'restart-thread');

  // Fail-closed process identity: stale metadata must never terminate an
  // unrelated session leader merely because it has the recorded numeric PID.
  await stopManager();
  const foreign = spawn('/bin/sleep', ['15'], {
    detached: true, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    foreign.once('spawn', resolve);
    foreign.once('error', reject);
  });
  try {
    const { openStore } = await import('../src/agent-jobs/store.js');
    const direct = openStore(state);
    try {
      const inserted = direct.create({
        harness: 'codex', cwd: workspace, task: 'must-not-run-foreign', timeoutMs: 5000,
      });
      direct.db.prepare(
        "UPDATE jobs SET status='running',pid=?,pid_start=?,started_at=? WHERE id=?"
      ).run(foreign.pid,
        (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() + ':1',
        new Date().toISOString(), inserted.job.id);
      startManager();
      await ready();
      const victim = await waitFor(inserted.job.id);
      assert.equal(victim.status, 'interrupted');
      await new Promise((resolve) => setTimeout(resolve, 2400));
      assert.equal(foreign.exitCode, null,
        'Stale PID metadata must not kill an unrelated detached process');
      assert.equal((await jobResult({ runId: inserted.job.id })).cleanupPending, true,
        'Unverified process groups must be surfaced, not silently treated as cleaned');
    } finally {
      direct.close();
    }
  } finally {
    try { process.kill(-foreign.pid, 'SIGTERM'); } catch { /* fixture finished */ }
    await new Promise((resolve) => foreign.once('exit', resolve));
  }

  const cancelJob = await jobStart({
    harness: 'codex', cwd: workspace, task: 'cancel-sentinel',
    timeoutMs: 5000,
  });
  await waitFor(cancelJob.runId, false);
  assert.equal((await jobCancel({ runId: cancelJob.runId })).cancellationRequested, true);
  assert.equal((await waitFor(cancelJob.runId)).status, 'cancelled');
  await waitCleanup(cancelJob.runId);
  const stubbornJob = await jobStart({
    harness: 'codex', cwd: workspace, task: 'stubborn-sentinel', timeoutMs: 5000,
  });
  let stubborn = await waitFor(stubbornJob.runId, false);
  for (let n=0; n<40 && !stubborn.childPid; n+=1) {
    await new Promise((resolve) => setTimeout(resolve, 75));
    stubborn = await jobPoll({ runId: stubbornJob.runId, waitMs: 0 });
  }
  assert.ok(stubborn.childPid);
  assert.equal((await jobCancel({ runId: stubbornJob.runId })).cancellationRequested, true);
  assert.equal((await waitFor(stubbornJob.runId)).status, 'cancelled');
  await waitCleanup(stubbornJob.runId, 9_000);
  const timedJob = await jobStart({
    harness: 'codex', cwd: workspace, task: 'timeout-sentinel',
    timeoutMs: 1100,
  });
  assert.equal((await waitFor(timedJob.runId)).status, 'timed_out');
  await waitCleanup(timedJob.runId);
  await stopManager();
  startManager();
  await ready();
  assert.equal((await jobResult({ runId: timedJob.runId })).status, 'timed_out');

  const orphanJob = await jobStart({
    harness: 'codex', cwd: workspace, task: 'orphan-sentinel', timeoutMs: 5000,
  });
  let orphan;
  const outputDeadline = Date.now() + 3500;
  do {
    orphan = await jobPoll({ runId: orphanJob.runId, waitMs: 100 });
  } while (orphan.stdout.observedBytes === 0 && Date.now() < outputDeadline);
  assert.ok(orphan.stdout.observedBytes > 0, 'Orphan fixture must start its child');
  const childDeadline = Date.now() + 2000;
  while (!orphan.childPid && Date.now() < childDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    orphan = await jobPoll({ runId: orphanJob.runId, waitMs: 0 });
  }
  assert.ok(orphan.childPid, 'Fault injection must verify an actual live harness child');
  const orphanPid = orphan.pid;
  process.kill(orphanPid, 'SIGKILL'); // kill only the worker, not its process group
  assert.equal((await waitFor(orphanJob.runId)).status, 'interrupted');
  function livingDescendants() {
    let live = 0;
    for (const dirent of fsSync.readdirSync('/proc', { withFileTypes: true })) {
      if (!dirent.isDirectory() || !/^[0-9]+$/.test(dirent.name)) continue;
      try {
        const stat = fsSync.readFileSync('/proc/' + dirent.name + '/stat', 'utf8');
        const parts = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
        if (parts[0] !== 'Z' && parts[0] !== 'X' &&
            Number(parts[2]) === orphanPid && Number(parts[3]) === orphanPid) live += 1;
      } catch { /* procfs race */ }
    }
    return live;
  }
  // A crashed worker must not leave a command running behind the job manager.
  for (let i = 0; i < 50 && livingDescendants() !== 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(livingDescendants(), 0, 'Orphaned harness descendants must be terminated');
  await waitCleanup(orphanJob.runId);

  const failedJob = await jobStart({
    harness: 'codex', cwd: workspace, task: 'failed-sentinel', timeoutMs: 5000,
  });
  assert.equal((await waitFor(failedJob.runId)).status, 'failed');
  assert.match((await jobResult({ runId: failedJob.runId })).stderr, /synthetic failure/);
  const agyJob = await jobStart({
    harness: 'agy', cwd: workspace, task: 'agy-success-sentinel', timeoutMs: 5000,
  });
  const agyFinished = await waitFor(agyJob.runId);
  assert.equal(agyFinished.status, 'completed');
  assert.equal((await jobResult({ runId: agyJob.runId })).continuationId, 'agy-success-conversation');
  const agyArgs = (await fs.readFile(agyArgsLog, 'utf8')).split('\n').filter(Boolean);
  assert.ok(agyArgs.includes('--dangerously-skip-permissions'),
    'Durable agy invocation must include its permission flag');
  assert.ok(agyArgs.includes('-p'), 'Durable agy invocation must remain non-interactive -p mode');

  // Real agy SUCCESS omits denied_actions when no permission was denied.
  const agyOmittedJob = await jobStart({
    harness: 'agy', cwd: workspace, task: 'agy-omitted-denied-sentinel', timeoutMs: 5000,
  });
  const agyOmitted = await waitFor(agyOmittedJob.runId);
  assert.equal(agyOmitted.status, 'completed');
  assert.equal(agyOmitted.exitCode, 0);

  const agyErrorJob = await jobStart({
    harness: 'agy', cwd: workspace, task: 'agy-error-sentinel', timeoutMs: 5000,
  });
  const agyError = await waitFor(agyErrorJob.runId);
  assert.equal(agyError.status, 'failed');
  assert.equal(agyError.exitCode, 0);
  assert.equal(agyError.terminationReason, 'agy_result_error');

  const agyDeniedJob = await jobStart({
    harness: 'agy', cwd: workspace, task: 'agy-denied-sentinel', timeoutMs: 5000,
  });
  const agyDenied = await waitFor(agyDeniedJob.runId);
  assert.equal(agyDenied.status, 'failed');
  assert.equal(agyDenied.exitCode, 0);
  assert.equal(agyDenied.terminationReason, 'agy_denied_actions');

  const agyMalformedDeniedJob = await jobStart({
    harness: 'agy', cwd: workspace, task: 'agy-malformed-denied-sentinel', timeoutMs: 5000,
  });
  const agyMalformedDenied = await waitFor(agyMalformedDeniedJob.runId);
  assert.equal(agyMalformedDenied.status, 'ambiguous');
  assert.equal(agyMalformedDenied.exitCode, 0);
  assert.equal(agyMalformedDenied.terminationReason, 'agy_malformed_terminal_result');

  const agyMissingJob = await jobStart({
    harness: 'agy', cwd: workspace, task: 'agy-missing-sentinel', timeoutMs: 5000,
  });
  const agyMissing = await waitFor(agyMissingJob.runId);
  assert.equal(agyMissing.status, 'ambiguous');
  assert.equal(agyMissing.exitCode, 0);
  assert.equal(agyMissing.terminationReason, 'agy_missing_terminal_result');

  const agyNonzeroJob = await jobStart({
    harness: 'agy', cwd: workspace, task: 'agy-nonzero-sentinel', timeoutMs: 5000,
  });
  const agyNonzero = await waitFor(agyNonzeroJob.runId);
  assert.equal(agyNonzero.status, 'failed');
  assert.equal(agyNonzero.exitCode, 3);
  assert.equal(agyNonzero.terminationReason, 'agy_nonzero_exit');

  const partialJob = await jobStart({
    harness: 'codex', cwd: workspace, task: 'partial-sentinel', timeoutMs: 5000,
  });
  await waitFor(partialJob.runId, false);
  const beforeNewline = await jobPoll({ runId: partialJob.runId, waitMs: 0 });
  assert.equal(beforeNewline.structured.events.items.length, 0, 'Incomplete JSONL records must not be consumed');
  assert.equal(beforeNewline.structured.events.nextOffset, 0, 'Incomplete JSONL byte offset must not advance');
  assert.equal((await waitFor(partialJob.runId)).status, 'completed');
  const afterNewline = await jobPoll({ runId: partialJob.runId, eventOffset: 0, waitMs: 0 });
  assert.equal(afterNewline.structured.events.items[0].thread_id, 'partial-thread');

  const largeJob = await jobStart({
    harness: 'codex', cwd: workspace, task: 'large-sentinel', timeoutMs: 5000,
  });
  assert.equal((await waitFor(largeJob.runId)).status, 'completed');
  const largeResult = await jobResult({ runId: largeJob.runId });
  assert.equal(largeResult.outputTruncated, true, 'Inline preview must reveal truncation');
  assert.equal((await fs.stat(largeResult.outputFiles.stdout)).size, 900001,
    'Complete output must remain on disk even if the inline preview truncates');
  const giantInvalid = await jobPoll({ runId: largeJob.runId, invalidLineOffset: 0, waitMs: 0 });
  assert.equal(giantInvalid.structured.invalidLines.oversizedLine, true);
  assert.ok(giantInvalid.structured.invalidLines.nextOffset > 0);

  const all = await jobList({ cwd: workspace });
  assert.equal(all.jobs.length, 18);

  const bridgeConfig = path.join(root, 'bridges.json');
  await fs.writeFile(bridgeConfig, '{"version":1,"bridges":[]}\n');
  const mcpEnv = { ...env, AGENT_MCP_HOST: 'generic', MCP_BRIDGES_CONFIG: bridgeConfig };
  async function connectMcp() {
    const client = new Client({ name: 'durable-jobs-smoke', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
      cwd: workspace, env: mcpEnv, stderr: 'pipe',
    });
    await client.connect(transport);
    return client;
  }
  function toolContent(result) {
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return JSON.parse(result.content.find((item) => item.type === 'text').text);
  }
  let mcp = await connectMcp();
  const caps = toolContent(await mcp.callTool({ name: 'agent_capabilities', arguments: {} }));
  assert.equal(caps.runtime.kind, 'durable-background-service');
  assert.equal(caps.runtime.service.ok, true);
  const startedFromMcp = toolContent(await mcp.callTool({
    name: 'agent_start',
    arguments: { harness: 'codex', cwd: workspace, task: 'mcp-sentinel',
      timeoutMs: 5000, idempotencyKey: 'mcp-smoke-request' },
  }));
  assert.equal(startedFromMcp.accepted, true);
  let mcpPolled;
  for (let i = 0; i < 30; i += 1) {
    mcpPolled = toolContent(await mcp.callTool({
      name: 'agent_poll', arguments: { runId: startedFromMcp.runId, waitMs: 300 },
    }));
    if (mcpPolled.status === 'completed') break;
  }
  assert.equal(mcpPolled.status, 'completed');
  const mcpResult = toolContent(await mcp.callTool({
    name: 'agent_result', arguments: { runId: startedFromMcp.runId },
  }));
  assert.equal(mcpResult.continuationId, 'test-thread');
  assert.ok(mcpResult.outputFiles.events);
  const mcpInFlight = toolContent(await mcp.callTool({
    name: 'agent_start',
    arguments: { harness: 'codex', cwd: workspace, task: 'restart-sentinel',
      timeoutMs: 5000, idempotencyKey: 'mcp-disconnect-while-running' },
  }));
  // An in-flight 15-second poll must not prevent a graceful manager
  // shutdown inside the systemd unit's 10-second stop budget.
  let initialPoll = await jobPoll({ runId: mcpInFlight.runId, waitMs: 0 });
  for (let n = 0; n < 20 && initialPoll.stdout.observedBytes === 0; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    initialPoll = await jobPoll({ runId: mcpInFlight.runId, waitMs: 0 });
  }
  assert.equal(initialPoll.status, 'running', 'Long-poll fixture must still be active');
  const pendingLongPoll = jobPoll({
    runId: mcpInFlight.runId,
    stdoutOffset: initialPoll.stdout.nextOffset,
    stderrOffset: initialPoll.stderr.nextOffset,
    eventOffset: initialPoll.structured.events.nextOffset,
    invalidLineOffset: initialPoll.structured.invalidLines.nextOffset,
    waitMs: 15_000,
  }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const shutdownAt = Date.now();
  await stopManager();
  assert.ok(Date.now() - shutdownAt < 2000,
    'An in-flight long poll must not delay graceful manager shutdown');
  await pendingLongPoll;
  await mcp.close();
  startManager();
  await ready();
  mcp = await connectMcp();
  assert.equal((await waitFor(mcpInFlight.runId)).status, 'completed',
    'Closing the MCP transport and restarting jobd must not cancel a durable worker');
  try {
    const rediscovered = toolContent(await mcp.callTool({
      name: 'agent_list', arguments: { cwd: workspace },
    }));
    assert.ok(rediscovered.jobs.some((job) => job.runId === startedFromMcp.runId));
    const repeated = toolContent(await mcp.callTool({
      name: 'agent_start',
      arguments: { harness: 'codex', cwd: workspace, task: 'mcp-sentinel',
        timeoutMs: 5000, idempotencyKey: 'mcp-smoke-request' },
    }));
    assert.equal(repeated.runId, startedFromMcp.runId);
    assert.equal(repeated.duplicate, true);
  } finally {
    await mcp.close();
  }

  console.log('PASS durable background jobs: idempotency, persisted outputs, service and MCP restart survival, queued/running cancellation, timeout, MCP lifecycle');
} finally {
  await stopManager();
  await fs.rm(root, { recursive: true, force: true });
}
