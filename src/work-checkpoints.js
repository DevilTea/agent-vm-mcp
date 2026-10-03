import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function checkpointRoot(env = process.env) {
  return path.resolve(
    env.AGENT_WORK_CHECKPOINT_STATE_DIR ||
      path.join(
        env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state'),
        'agent-vm-mcp',
        'checkpoints',
      ),
  );
}

function checkpointFilename(root = checkpointRoot()) {
  return path.join(root, 'checkpoints.sqlite');
}

function openCheckpointStore(root = checkpointRoot()) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const filename = checkpointFilename(root);
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS checkpoints (' +
      'cwd TEXT NOT NULL, key TEXT NOT NULL, revision TEXT NOT NULL, value_json TEXT NOT NULL,' +
      'updated_at TEXT NOT NULL, PRIMARY KEY(cwd,key)' +
      ')',
  );
  fs.chmodSync(filename, 0o600);
  return { db, close: () => db.close() };
}

function canonicalCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error('cwd must be an absolute path');
  }
  return path.resolve(cwd);
}

function canonicalKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new Error('key must be a stable identifier with 1-128 characters');
  }
  return key;
}

function revisionFor(valueJson) {
  return 'sha256:' + createHash('sha256').update(valueJson).digest('hex');
}

export function checkpointGet({ cwd, key }) {
  const resolvedCwd = canonicalCwd(cwd);
  const stableKey = canonicalKey(key);
  const root = checkpointRoot();
  if (!fs.existsSync(checkpointFilename(root))) return null;
  const store = openCheckpointStore(root);
  try {
    const row = store.db.prepare(
      'SELECT cwd,key,revision,value_json,updated_at FROM checkpoints WHERE cwd=? AND key=?',
    ).get(resolvedCwd, stableKey);
    return row
      ? {
          cwd: row.cwd,
          key: row.key,
          revision: row.revision,
          value: JSON.parse(row.value_json),
          updatedAt: row.updated_at,
        }
      : null;
  } finally {
    store.close();
  }
}

export function checkpointList({ cwd, limit = 64 }) {
  const resolvedCwd = canonicalCwd(cwd);
  const root = checkpointRoot();
  if (!fs.existsSync(checkpointFilename(root))) return [];
  const store = openCheckpointStore(root);
  try {
    const rows = store.db.prepare(
      'SELECT cwd,key,revision,value_json,updated_at FROM checkpoints WHERE cwd=? ORDER BY updated_at DESC,key LIMIT ?',
    ).all(resolvedCwd, limit);
    return rows.map((row) => ({
      cwd: row.cwd,
      key: row.key,
      revision: row.revision,
      value: JSON.parse(row.value_json),
      updatedAt: row.updated_at,
    }));
  } finally {
    store.close();
  }
}

export function checkpointPut({ cwd, key, value, expectedRevision }) {
  const resolvedCwd = canonicalCwd(cwd);
  const stableKey = canonicalKey(key);
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined) throw new Error('checkpoint value must be JSON-serializable');
  if (Buffer.byteLength(valueJson) > 256 * 1024) throw new Error('checkpoint value exceeds 256 KiB');
  const revision = revisionFor(valueJson);
  const updatedAt = new Date().toISOString();
  const store = openCheckpointStore();
  try {

    store.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = store.db.prepare(
        'SELECT revision FROM checkpoints WHERE cwd=? AND key=?',
      ).get(resolvedCwd, stableKey);
      if (expectedRevision !== undefined) {
        const actual = existing?.revision ?? null;
        if (actual !== expectedRevision) {
          const error = new Error('checkpoint revision conflict');
          error.code = 'checkpoint_conflict';
          error.actualRevision = actual;
          error.details = { actualRevision: actual };
          throw error;
        }
      }
      store.db.prepare(
        'INSERT INTO checkpoints (cwd,key,revision,value_json,updated_at) VALUES (?,?,?,?,?) ' +
          'ON CONFLICT(cwd,key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json,updated_at=excluded.updated_at',
      ).run(resolvedCwd, stableKey, revision, valueJson, updatedAt);
      store.db.exec('COMMIT');
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
    return { cwd: resolvedCwd, key: stableKey, revision, value, updatedAt };
  } finally {
    store.close();
  }
}

export function checkpointDelete({ cwd, key, expectedRevision }) {
  const resolvedCwd = canonicalCwd(cwd);
  const stableKey = canonicalKey(key);
  const root = checkpointRoot();
  if (!fs.existsSync(checkpointFilename(root))) {
    if (expectedRevision !== undefined) {
      const error = new Error('checkpoint revision conflict');
      error.code = 'checkpoint_conflict';
      error.actualRevision = null;
      error.details = { actualRevision: null };
      throw error;
    }
    return { cwd: resolvedCwd, key: stableKey, deleted: false };
  }
  const store = openCheckpointStore(root);
  try {
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = store.db.prepare(
        'SELECT revision FROM checkpoints WHERE cwd=? AND key=?',
      ).get(resolvedCwd, stableKey);
      if (!existing) {
        if (expectedRevision !== undefined) {
          const error = new Error('checkpoint revision conflict');
          error.code = 'checkpoint_conflict';
          error.actualRevision = null;
          error.details = { actualRevision: null };
          throw error;
        }
        store.db.exec('COMMIT');
        return { cwd: resolvedCwd, key: stableKey, deleted: false };
      }
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        const error = new Error('checkpoint revision conflict');
        error.code = 'checkpoint_conflict';
        error.actualRevision = existing.revision;
        error.details = { actualRevision: existing.revision };
        throw error;
      }
      store.db.prepare('DELETE FROM checkpoints WHERE cwd=? AND key=?').run(resolvedCwd, stableKey);
      store.db.exec('COMMIT');
      return { cwd: resolvedCwd, key: stableKey, deleted: true };
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  } finally {
    store.close();
  }
}
