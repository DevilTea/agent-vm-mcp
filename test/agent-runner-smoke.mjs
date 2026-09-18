import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { agentCapabilities, agentRun } from '../src/agent-runner.js';

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
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-test"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
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

await executable(
  'tmux',
  `#!/bin/sh
echo "tmux test"
`,
);

try {
  const capabilities = await agentCapabilities();
  assert.equal(capabilities.runtime.kind, 'bounded-process');
  assert.equal(capabilities.runtime.persistentAgentState, false);
  assert.equal(capabilities.interactiveFallback.kind, 'tmux');
  assert.equal(capabilities.interactiveFallback.semanticStateInference, false);
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

  console.log('PASS bounded agent runner');
} finally {
  process.env.PATH = originalPath;
  await fs.rm(root, { recursive: true, force: true });
}
