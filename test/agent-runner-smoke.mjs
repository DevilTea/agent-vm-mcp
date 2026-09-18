import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentCancel,
  agentCapabilities,
  agentPoll,
  agentResult,
  agentRun,
  agentRunsSnapshot,
  agentStart,
  stopAgentRuns,
} from '../src/agent-runner.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runner-smoke-'));
const bin = path.join(root, 'bin');
const work = path.join(root, 'work');
await fs.mkdir(bin);
await fs.mkdir(work);

const originalPath = process.env.PATH;
process.env.PATH = `${bin}:${originalPath}`;

async function executable(name, source) {
  const target = path.join(bin, name);
  await fs.writeFile(target, source, { mode: 0o755 });
  return target;
}

await executable(
  'codex',
  `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli test"
  exit 0
fi
case "$*" in
  *pollable*)
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-pollable"}'
    sleep 0.15
    printf '%s' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
    ;;
  *cancellable*)
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-cancellable"}'
    sleep 5
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"unexpected"}}'
    ;;
  *timeout-race*)
    trap '' TERM
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-timeout-race"}'
    sleep 5
    ;;
  *timeout-case*)
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-timeout"}'
    sleep 5
    ;;
  *)
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-test"}'
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
    ;;
esac
`,
);

await executable(
  'agy',
  `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy test"
  exit 0
fi
printf '%s\\n' '{"event":"init","conversation_id":"conversation-test"}'
printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"done"}}'
`,
);

function nextOffsets(poll) {
  return {
    stdoutOffset: poll.stdout.nextOffset,
    stderrOffset: poll.stderr.nextOffset,
    eventOffset: poll.structured.events.nextOffset,
    invalidLineOffset: poll.structured.invalidLines.nextOffset,
  };
}

try {
  const capabilities = await agentCapabilities();
  assert.equal(capabilities.runtime.kind, 'managed-bounded-process');
  assert.equal(capabilities.runtime.persistentAgentState, false);
  assert.equal(capabilities.runtime.rediscoverableRuns, true);
  assert.equal(capabilities.runtime.persistentAcrossServerRestart, false);
  assert.equal(capabilities.runtime.pollWaitMs.max, 15_000);
  assert.equal(capabilities.harnesses.find(({ kind }) => kind === 'codex')?.available, true);
  assert.equal(capabilities.harnesses.find(({ kind }) => kind === 'agy')?.available, true);

  const codexResult = await agentRun({
    harness: 'codex',
    cwd: work,
    task: 'Perform one bounded task.',
    timeoutMs: 5_000,
  });
  assert.equal(codexResult.status, 'completed');
  assert.equal(codexResult.exitCode, 0);
  assert.equal(codexResult.continuationId, 'thread-test');
  assert.deepEqual(codexResult.policy, { model: 'gpt-5.6-luna', effort: 'max' });
  assert.equal(codexResult.structured.events.length, 2);

  const agyResult = await agentRun({
    harness: 'agy',
    cwd: work,
    task: 'Perform one bounded task.',
    skills: ['x-review'],
    timeoutMs: 5_000,
  });
  assert.equal(agyResult.status, 'completed');
  assert.equal(agyResult.exitCode, 0);
  assert.equal(agyResult.continuationId, 'conversation-test');
  assert.equal(agyResult.policy, null);
  assert.equal(agyResult.structured.events.length, 2);

  const started = await agentStart({
    harness: 'codex',
    cwd: work,
    task: 'pollable',
    timeoutMs: 5_000,
  });
  assert.equal(started.status, 'running');
  assert.equal(started.processAlive, true);

  let offsets = {};
  const seenEvents = [];
  let terminalPoll = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const poll = await agentPoll({
      runId: started.runId,
      ...offsets,
      waitMs: 1_000,
    });
    seenEvents.push(...poll.structured.events.items);
    offsets = nextOffsets(poll);
    if (!poll.processAlive) {
      terminalPoll = poll;
      break;
    }
  }
  assert.ok(terminalPoll, 'pollable run never reached terminal state');
  assert.equal(terminalPoll.status, 'completed');
  assert.ok(
    seenEvents.some((event) => event.type === 'thread.started'),
    'poll did not expose the intermediate thread.started event',
  );

  const retained = agentResult({ runId: started.runId });
  assert.equal(retained.status, 'completed');
  assert.equal(retained.continuationId, 'thread-pollable');
  assert.equal(retained.structured.events.length, 2);
  assert.equal(retained.structured.events.at(-1)?.type, 'item.completed');

  const futureOffsetPoll = await agentPoll({
    runId: started.runId,
    stdoutOffset: Number.MAX_SAFE_INTEGER,
    stderrOffset: Number.MAX_SAFE_INTEGER,
    eventOffset: Number.MAX_SAFE_INTEGER,
    invalidLineOffset: Number.MAX_SAFE_INTEGER,
    waitMs: 0,
  });
  assert.equal(futureOffsetPoll.stdout.startOffset, futureOffsetPoll.stdout.nextOffset);
  assert.equal(futureOffsetPoll.stderr.startOffset, futureOffsetPoll.stderr.nextOffset);
  assert.equal(futureOffsetPoll.structured.events.startOffset, futureOffsetPoll.structured.events.nextOffset);
  assert.equal(futureOffsetPoll.structured.invalidLines.startOffset, futureOffsetPoll.structured.invalidLines.nextOffset);
  assert.ok(
    agentRunsSnapshot({ cwd: work }).some((run) => run.runId === started.runId && run.status === 'completed'),
    'terminal run was not retained for rediscovery',
  );

  const cancellable = await agentStart({
    harness: 'codex',
    cwd: work,
    task: 'cancellable',
    timeoutMs: 5_000,
  });
  const cancelled = await agentCancel({ runId: cancellable.runId });
  assert.equal(cancelled.cancellationRequested, true);
  assert.equal(agentResult({ runId: cancellable.runId }).status, 'cancelled');

  const timeoutRace = await agentStart({
    harness: 'codex',
    cwd: work,
    task: 'timeout-race',
    timeoutMs: 50,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const timedOutBeforeCancel = agentResult({ runId: timeoutRace.runId });
  assert.equal(timedOutBeforeCancel.terminationReason, 'timeout');
  assert.equal(timedOutBeforeCancel.processAlive, true);
  const cancelAfterTimeout = await agentCancel({ runId: timeoutRace.runId });
  assert.equal(cancelAfterTimeout.cancellationRequested, false);
  let timeoutRacePoll;
  do {
    timeoutRacePoll = await agentPoll({
      runId: timeoutRace.runId,
      waitMs: 1_000,
      ...(timeoutRacePoll ? nextOffsets(timeoutRacePoll) : {}),
    });
  } while (timeoutRacePoll.processAlive);
  assert.equal(timeoutRacePoll.status, 'timed_out');
  assert.equal(timeoutRacePoll.terminationReason, 'timeout');

  const timeoutCase = await agentStart({
    harness: 'codex',
    cwd: work,
    task: 'timeout-case',
    timeoutMs: 50,
  });
  let timeoutPoll;
  do {
    timeoutPoll = await agentPoll({
      runId: timeoutCase.runId,
      waitMs: 1_000,
      ...(timeoutPoll ? nextOffsets(timeoutPoll) : {}),
    });
  } while (timeoutPoll.processAlive);
  assert.equal(timeoutPoll.status, 'timed_out');

  console.log('PASS managed pollable agent runner');
} finally {
  await stopAgentRuns();
  process.env.PATH = originalPath;
  await fs.rm(root, { recursive: true, force: true });
}
