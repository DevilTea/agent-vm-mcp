import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'work-checkpoint-'));
const state = path.join(root, 'checkpoint-state');
const workspaceA = path.join(root, 'workspace-a');
const workspaceB = path.join(root, 'workspace-b');
await Promise.all([fs.mkdir(workspaceA), fs.mkdir(workspaceB)]);
process.env.AGENT_WORK_CHECKPOINT_STATE_DIR = state;

const {
  checkpointDelete,
  checkpointGet,
  checkpointList,
  checkpointPut,
} = await import('../src/work-checkpoints.js');

try {
  assert.equal(await fs.stat(root).then(() => true), true);
  assert.equal(checkpointGet({ cwd: workspaceA, key: 'workflow' }), null);
  assert.deepEqual(checkpointList({ cwd: workspaceA }), []);
  await assert.rejects(
    () => fs.stat(state),
    (error) => error.code === 'ENOENT',
    'Read-only checkpoint queries must not create state on disk',
  );

  assert.throws(
    () => checkpointGet({ cwd: 'relative/workspace', key: 'workflow' }),
    /absolute path/,
  );
  assert.throws(
    () => checkpointList({ cwd: 'relative/workspace' }),
    /absolute path/,
  );

  assert.throws(
    () => checkpointPut({
      cwd: 'relative/workspace',
      key: 'workflow',
      value: { invalid: true },
      expectedRevision: null,
    }),
    /absolute path/,
  );
  await assert.rejects(
    () => fs.stat(state),
    (error) => error.code === 'ENOENT',
    'Invalid checkpoint writes must validate before creating state',
  );

  const created = checkpointPut({
    cwd: workspaceA,
    key: 'workflow',
    value: {
      goal: 'durable recovery',
      currentStep: 'verify',
      activeOperations: ['op-1'],
      next: 'review',
    },
    expectedRevision: null,
  });
  assert.match(created.revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(created.value.currentStep, 'verify');

  const readBack = checkpointGet({ cwd: workspaceA, key: 'workflow' });
  assert.equal(readBack.revision, created.revision);
  assert.deepEqual(readBack.value, created.value);

  await assert.rejects(
    async () => checkpointPut({
      cwd: workspaceA,
      key: 'workflow',
      value: { currentStep: 'stale overwrite' },
      expectedRevision: null,
    }),
    (error) => error.code === 'checkpoint_conflict' && error.actualRevision === created.revision,
  );

  const updated = checkpointPut({
    cwd: workspaceA,
    key: 'workflow',
    value: {
      ...created.value,
      currentStep: 'review',
      next: 'commit',
    },
    expectedRevision: created.revision,
  });
  assert.notEqual(updated.revision, created.revision);
  assert.equal(checkpointGet({ cwd: workspaceA, key: 'workflow' }).value.next, 'commit');

  checkpointPut({
    cwd: workspaceA,
    key: 'secondary',
    value: { note: 'another checkpoint' },
    expectedRevision: null,
  });
  checkpointPut({
    cwd: workspaceB,
    key: 'workflow',
    value: { goal: 'other workspace' },
    expectedRevision: null,
  });
  const listA = checkpointList({ cwd: workspaceA });
  assert.equal(listA.length, 2);
  assert.ok(listA.every((checkpoint) => checkpoint.cwd === path.resolve(workspaceA)));
  assert.equal(checkpointList({ cwd: workspaceB }).length, 1);

  await assert.rejects(
    async () => checkpointDelete({
      cwd: workspaceA,
      key: 'workflow',
      expectedRevision: created.revision,
    }),
    (error) => error.code === 'checkpoint_conflict' && error.actualRevision === updated.revision,
  );

  assert.deepEqual(
    checkpointDelete({
      cwd: workspaceA,
      key: 'workflow',
      expectedRevision: updated.revision,
    }),
    { cwd: path.resolve(workspaceA), key: 'workflow', deleted: true },
  );
  assert.equal(checkpointGet({ cwd: workspaceA, key: 'workflow' }), null);
  assert.throws(
    () => checkpointDelete({
      cwd: workspaceA,
      key: 'workflow',
      expectedRevision: updated.revision,
    }),
    (error) => error.code === 'checkpoint_conflict' && error.actualRevision === null,
  );
  assert.equal(checkpointDelete({ cwd: workspaceA, key: 'workflow' }).deleted, false);

  const emptyState = path.join(root, 'never-created-checkpoint-state');
  process.env.AGENT_WORK_CHECKPOINT_STATE_DIR = emptyState;
  assert.throws(
    () => checkpointDelete({
      cwd: workspaceA,
      key: 'missing',
      expectedRevision: updated.revision,
    }),
    (error) => error.code === 'checkpoint_conflict' && error.actualRevision === null,
  );
  await assert.rejects(
    () => fs.stat(emptyState),
    (error) => error.code === 'ENOENT',
    'Guarded delete against missing storage must not create state',
  );
  process.env.AGENT_WORK_CHECKPOINT_STATE_DIR = state;

  console.log('PASS work checkpoints: read-only absence, create-only CAS, revision conflicts, scoped listing, guarded delete');
} finally {
  delete process.env.AGENT_WORK_CHECKPOINT_STATE_DIR;
  await fs.rm(root, { recursive: true, force: true });
}
