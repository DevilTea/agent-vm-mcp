import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { toolError } from './tool-errors.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const WORKSPACE_ID_PATTERN = /^ws-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const repositoryLocks = new Map();
const idempotencyLocks = new Map();
const activeMutations = new Set();

function homeDirectory() {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is required for workspace management.');
  return home;
}

function repositoryRoot() {
  return path.resolve(
    process.env.AGENT_REPOSITORY_ROOT ?? path.join(homeDirectory(), '.local', 'share', 'agent-vm', 'repositories'),
  );
}

function workspaceRoot() {
  return path.resolve(process.env.AGENT_WORKSPACE_ROOT ?? path.join(homeDirectory(), 'workspaces'));
}

function appendLimited(current, chunk) {
  if (current.length >= MAX_GIT_OUTPUT_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - current.length)]);
}

function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

function runGit(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, cancellable = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    const terminate = (reason) => {
      if (settled || timedOut || cancelled) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      killProcessGroup(child, 'SIGTERM');
      setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000).unref();
    };
    const onAbort = () => {
      if (cancellable) terminate('cancelled');
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (code, processSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result = {
        code,
        signal: processSignal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        cancelled,
      };
      if (code === 0 && !timedOut && !cancelled) {
        resolve(result);
        return;
      }
      const reason = cancelled
        ? 'cancelled'
        : timedOut
          ? `timed out after ${timeoutMs}ms`
          : `exited with code ${code}${processSignal ? ` (${processSignal})` : ''}`;
      const detail = result.stderr.trim() || result.stdout.trim();
      const error = new Error(`git ${args[0] ?? ''} ${reason}${detail ? `: ${detail}` : ''}`);
      error.git = result;
      reject(error);
    };

    const timer = timeoutMs === null ? null : setTimeout(() => terminate('timeout'), timeoutMs);
    if (signal?.aborted && cancellable) {
      terminate('cancelled');
    } else if (cancellable) {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', finish);
  });
}

function normalizeRepositorySource(repository) {
  const source = repository.trim();
  if (!source) throw new Error('repository must not be empty.');
  if (source.includes('\0') || /[\r\n]/.test(source)) {
    throw new Error('repository contains invalid control characters.');
  }
  if (source.startsWith('-')) throw new Error('repository must not start with a Git option prefix.');

  if (/^https?:\/\//i.test(source)) {
    const parsed = new URL(source);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(
        'HTTP(S) repository URLs must not contain embedded credentials, query parameters, or fragments; use Git credential helpers instead.',
      );
    }
    return parsed.toString();
  }

  if (path.isAbsolute(source) || source.startsWith('./') || source.startsWith('../')) {
    return path.resolve(source);
  }

  return source;
}

function repositoryKey(source) {
  return createHash('sha256').update(source).digest('hex');
}

function repositoryDisplay(source) {
  if (!/^https?:\/\//i.test(source)) {
    return { repository: source, repositoryCredentialsRedacted: false };
  }

  try {
    const parsed = new URL(source);
    const redacted = Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return { repository: parsed.toString(), repositoryCredentialsRedacted: redacted };
  } catch {
    return { repository: '[invalid HTTP(S) repository URL]', repositoryCredentialsRedacted: true };
  }
}

function remainingTimeout(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('workspace_create timed out.');
  return Math.max(1, remaining);
}

async function withRepositoryLock(key, signal, callback) {
  const previous = repositoryLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  repositoryLocks.set(key, tail);

  await previous;
  try {
    signal?.throwIfAborted();
    return await callback();
  } finally {
    release();
    if (repositoryLocks.get(key) === tail) repositoryLocks.delete(key);
  }
}

function trackMutation(promise) {
  activeMutations.add(promise);
  promise.finally(() => activeMutations.delete(promise)).catch(() => {});
  return promise;
}

async function bootstrapRepository(source, key, deadline, signal) {
  const root = repositoryRoot();
  const finalPath = path.join(root, `${key}.git`);
  await fs.mkdir(root, { recursive: true });

  try {
    const stat = await fs.stat(finalPath);
    if (!stat.isDirectory()) throw new Error(`Repository store path is not a directory: ${finalPath}`);
    return { path: finalPath, created: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const tempPath = path.join(root, `.tmp-${key}-${randomUUID()}.git`);
  try {
    await runGit(['init', '--bare', tempPath], {
      timeoutMs: remainingTimeout(deadline),
      signal,
    });
    await runGit(['-C', tempPath, 'remote', 'add', 'origin', source], {
      timeoutMs: remainingTimeout(deadline),
      signal,
    });
    await runGit(
      ['-C', tempPath, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      { timeoutMs: remainingTimeout(deadline), signal },
    );
    await runGit(['-C', tempPath, 'fetch', '--prune', '--tags', 'origin'], {
      timeoutMs: remainingTimeout(deadline),
      signal,
    });
    await runGit(['-C', tempPath, 'remote', 'set-head', 'origin', '-a'], {
      timeoutMs: remainingTimeout(deadline),
      signal,
    });
    await fs.rename(tempPath, finalPath);
    return { path: finalPath, created: true };
  } catch (error) {
    await fs.rm(tempPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function refreshRepository(repoPath, deadline, signal) {
  await runGit(['-C', repoPath, 'fetch', '--prune', '--tags', 'origin'], {
    timeoutMs: remainingTimeout(deadline),
    signal,
  });
  await runGit(['-C', repoPath, 'remote', 'set-head', 'origin', '-a'], {
    timeoutMs: remainingTimeout(deadline),
    signal,
  });
}

async function resolveCommit(repoPath, revision, deadline, signal) {
  const target = revision?.trim() || 'origin/HEAD';
  if (target.includes('\0') || /[\r\n]/.test(target)) throw new Error('revision contains invalid control characters.');

  const candidates = [];
  if (revision !== undefined && !target.startsWith('refs/') && !target.startsWith('origin/') && !/^[0-9a-f]{40,64}$/i.test(target)) {
    candidates.push(`refs/remotes/origin/${target}`);
  }
  candidates.push(target);

  let result = null;
  for (const candidate of candidates) {
    try {
      result = await runGit(
        ['-C', repoPath, 'rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`],
        { timeoutMs: remainingTimeout(deadline), signal },
      );
      break;
    } catch (error) {
      if (candidate === target || !error?.git || error.git.timedOut || error.git.cancelled) throw error;
    }
  }

  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`Git returned an invalid commit id for revision ${target}.`);
  return { target, commit };
}

async function cleanupFailedWorktree(repoPath, workspacePath) {
  await runGit(['-C', repoPath, 'worktree', 'remove', '--force', workspacePath], {
    timeoutMs: 30_000,
    cancellable: false,
  }).catch(() => {});
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  await runGit(['-C', repoPath, 'worktree', 'prune'], {
    timeoutMs: 30_000,
    cancellable: false,
  }).catch(() => {});
}

async function inspectWorkspaceEntry(id, workspacePath, signal) {
  try {
    const stat = await fs.lstat(workspacePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('managed workspace entry is not a real directory.');
    }
    const common = await runGit(['-C', workspacePath, 'rev-parse', '--git-common-dir'], { signal });
    const commonDir = path.resolve(workspacePath, common.stdout.trim());
    const expectedRoot = `${repositoryRoot()}${path.sep}`;
    if (!commonDir.startsWith(expectedRoot) || !commonDir.endsWith('.git')) {
      throw new Error(`worktree common directory is outside the managed repository root: ${commonDir}`);
    }
    const key = path.basename(commonDir, '.git');
    const [head, branchResult, status, source] = await Promise.all([
      runGit(['-C', workspacePath, 'rev-parse', '--verify', 'HEAD'], { signal }),
      runGit(['-C', workspacePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { signal }).catch((error) => {
        if (error.git?.code === 1) return null;
        throw error;
      }),
      runGit(['-C', workspacePath, 'status', '--porcelain=v1', '-z'], { signal }),
      runGit(['-C', commonDir, 'remote', 'get-url', 'origin'], { signal }),
    ]);
    const display = repositoryDisplay(source.stdout.trim());
    return {
      id,
      path: workspacePath,
      state: 'ready',
      repositoryKey: key,
      ...display,
      head: head.stdout.trim(),
      branch: branchResult?.stdout.trim() || null,
      dirty: status.stdout.length > 0,
    };
  } catch (error) {
    return {
      id,
      path: workspacePath,
      state: 'invalid',
      error: error.message,
    };
  }
}

function idempotencyDirectory() {
  return path.join(workspaceRoot(), '.idempotency');
}

function idempotencyLockDirectory() {
  return path.join(idempotencyDirectory(), '.locks');
}

function idempotencyLockPath(idempotencyKey) {
  const name = createHash('sha256').update(idempotencyKey).digest('hex');
  return path.join(idempotencyLockDirectory(), `${name}.lock`);
}

async function processStartTicks(pid) {
  try {
    const value = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = value.lastIndexOf(')');
    if (close < 0) return null;
    const fields = value.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
    throw error;
  }
}

async function lockOwnerIsAlive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner?.startTicks !== 'string') return false;
  return (await processStartTicks(owner.pid)) === owner.startTicks;
}

async function waitForLockRetry(deadline, signal) {
  signal?.throwIfAborted();
  const delay = Math.min(50, remainingTimeout(deadline));
  await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('workspace_create cancelled.'));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
}

async function tryPublishIdempotencyLock(lockPath, owner) {
  const tempPath = `${lockPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await fs.link(tempPath, lockPath);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function withCrossProcessIdempotencyLock(idempotencyKey, deadline, signal, callback) {
  await ensureIdempotencyDirectory();
  await fs.mkdir(idempotencyLockDirectory(), { recursive: true, mode: 0o700 });
  await fs.chmod(idempotencyLockDirectory(), 0o700);

  const lockPath = idempotencyLockPath(idempotencyKey);
  const token = randomUUID();
  const startTicks = await processStartTicks(process.pid);
  if (startTicks === null) {
    throw toolError('IDEMPOTENCY_LOCK_FAILED', 'Could not determine current process identity for workspace idempotency locking.');
  }
  const owner = {
    version: 1,
    token,
    pid: process.pid,
    startTicks,
    createdAt: Date.now(),
    deadline,
  };

  while (true) {
    signal?.throwIfAborted();
    remainingTimeout(deadline);
    if (await tryPublishIdempotencyLock(lockPath, owner)) break;

    let stale = false;
    try {
      const rawOwner = await fs.readFile(lockPath, 'utf8');
      let existingOwner = null;
      try {
        existingOwner = JSON.parse(rawOwner);
      } catch {
        // A published lock file is written completely before it is linked into place.
        // Malformed contents therefore cannot represent a valid active owner.
        stale = true;
      }
      if (existingOwner !== null) stale = !(await lockOwnerIsAlive(existingOwner));
    } catch (inspectError) {
      if (inspectError?.code === 'ENOENT') continue;
      throw inspectError;
    }

    if (stale) {
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fs.rename(lockPath, stalePath);
        await fs.rm(stalePath, { force: true });
        continue;
      } catch (cleanupError) {
        if (cleanupError?.code === 'ENOENT') continue;
        throw cleanupError;
      }
    }
    await waitForLockRetry(deadline, signal);
  }

  try {
    return await callback();
  } finally {
    try {
      const currentOwner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (currentOwner?.token === token) await fs.rm(lockPath, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function validateIdempotencyKey(idempotencyKey) {
  if (idempotencyKey === undefined) return null;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
    throw toolError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must have 1-128 characters.');
  }
  return idempotencyKey;
}

async function withIdempotencyLock(idempotencyKey, callback) {
  const previous = idempotencyLocks.get(idempotencyKey) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  idempotencyLocks.set(idempotencyKey, tail);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (idempotencyLocks.get(idempotencyKey) === tail) idempotencyLocks.delete(idempotencyKey);
  }
}

function idempotencyRequestHash({ source, revision, createBranch }) {
  return createHash('sha256').update(JSON.stringify({
    repository: source,
    revision: revision?.trim() || null,
    createBranch: createBranch ?? null,
  })).digest('hex');
}

function idempotencyRecordPath(idempotencyKey) {
  const name = createHash('sha256').update(idempotencyKey).digest('hex');
  return path.join(idempotencyDirectory(), `${name}.json`);
}

function validateIdempotencyRecord(record, recordPath) {
  const validIntent = record?.intent &&
    WORKSPACE_ID_PATTERN.test(record.intent.id ?? '') &&
    typeof record.intent.path === 'string' &&
    typeof record.intent.repositoryKey === 'string' &&
    (record.intent.branch === null || typeof record.intent.branch === 'string');
  const validReadyResult = record?.state !== 'ready' ||
    (record.result?.id === record.intent?.id && record.result?.path === record.intent?.path);
  if (
    !record ||
    record.version !== 2 ||
    typeof record.requestHash !== 'string' ||
    !['pending', 'ready'].includes(record.state) ||
    !validIntent ||
    !validReadyResult
  ) {
    throw toolError('IDEMPOTENCY_STATE_INVALID', 'Stored workspace idempotency state is invalid.', {
      idempotencyKeyHash: path.basename(recordPath, '.json'),
    });
  }
  return record;
}

async function readIdempotencyRecord(idempotencyKey) {
  const recordPath = idempotencyRecordPath(idempotencyKey);
  try {
    return validateIdempotencyRecord(
      JSON.parse(await fs.readFile(recordPath, 'utf8')),
      recordPath,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'IDEMPOTENCY_STATE_INVALID') throw error;
    throw toolError('IDEMPOTENCY_STATE_INVALID', 'Stored workspace idempotency state is invalid.', {
      idempotencyKeyHash: path.basename(recordPath, '.json'),
    }, error);
  }
}

async function ensureIdempotencyDirectory() {
  const directory = idempotencyDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return directory;
}

async function createIdempotencyRecord(idempotencyKey, record) {
  await ensureIdempotencyDirectory();
  const recordPath = idempotencyRecordPath(idempotencyKey);
  const tempPath = `${recordPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await fs.link(tempPath, recordPath);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function updateIdempotencyRecord(idempotencyKey, record) {
  await ensureIdempotencyDirectory();
  const recordPath = idempotencyRecordPath(idempotencyKey);
  const tempPath = `${recordPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(tempPath, recordPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function workspacePathExists(workspacePath) {
  try {
    await fs.lstat(workspacePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function recoveredWorkspaceResult(inspected, revision) {
  return {
    id: inspected.id,
    path: inspected.path,
    repositoryKey: inspected.repositoryKey,
    repository: inspected.repository,
    repositoryCredentialsRedacted: inspected.repositoryCredentialsRedacted,
    revision: revision?.trim() || 'origin/HEAD',
    head: inspected.head,
    branch: inspected.branch,
  };
}

async function refExists(repoPath, ref, deadline, signal) {
  try {
    await runGit(['-C', repoPath, 'show-ref', '--verify', '--quiet', ref], {
      timeoutMs: remainingTimeout(deadline),
      signal,
    });
    return true;
  } catch (error) {
    if (error?.git?.code === 1 && !error.git.timedOut && !error.git.cancelled) return false;
    throw error;
  }
}

async function validateCreateBranch(repoPath, createBranch, deadline, signal) {
  if (createBranch === undefined) return null;
  if (typeof createBranch !== 'string' || createBranch.length < 1 || createBranch.length > 255) {
    throw toolError('INVALID_BRANCH', 'createBranch must have 1-255 characters.');
  }
  try {
    await runGit(['check-ref-format', `refs/heads/${createBranch}`], {
      timeoutMs: remainingTimeout(deadline),
      signal,
    });
  } catch (error) {
    throw toolError('INVALID_BRANCH', `Invalid Git branch name: ${createBranch}`, { branch: createBranch }, error);
  }

  const [localExists, remoteExists] = await Promise.all([
    refExists(repoPath, `refs/heads/${createBranch}`, deadline, signal),
    refExists(repoPath, `refs/remotes/origin/${createBranch}`, deadline, signal),
  ]);
  if (localExists || remoteExists) {
    throw toolError('BRANCH_EXISTS', `Branch already exists: ${createBranch}`, {
      branch: createBranch,
      local: localExists,
      remote: remoteExists,
    });
  }
  return createBranch;
}

async function createOwnedBranchRef(repoPath, branch, commit, deadline) {
  if (branch === null) return false;
  const ref = `refs/heads/${branch}`;
  try {
    await trackMutation(runGit(['-C', repoPath, 'update-ref', ref, commit, ''], {
      timeoutMs: remainingTimeout(deadline),
      cancellable: false,
    }));
    return true;
  } catch (error) {
    if (await refExists(repoPath, ref, deadline)) {
      throw toolError('BRANCH_EXISTS', `Branch already exists: ${branch}`, {
        branch,
        local: true,
        remote: await refExists(repoPath, `refs/remotes/origin/${branch}`, deadline),
      }, error);
    }
    throw error;
  }
}

async function deleteOwnedBranchRef(repoPath, branch, commit) {
  if (branch === null) return;
  await trackMutation(runGit(
    ['-C', repoPath, 'update-ref', '-d', `refs/heads/${branch}`, commit],
    { timeoutMs: 30_000, cancellable: false },
  )).catch(() => {});
}

export async function workspaceCreate(
  { repository, revision, createBranch, idempotencyKey, timeoutMs = DEFAULT_TIMEOUT_MS },
  signal,
) {
  const source = normalizeRepositorySource(repository);
  const key = repositoryKey(source);
  const stableKey = validateIdempotencyKey(idempotencyKey);
  const requestHash = idempotencyRequestHash({ source, revision, createBranch });
  const deadline = Date.now() + timeoutMs;

  const create = async (id) => {
    return await withRepositoryLock(key, signal, async () => {
      const repositoryStore = await bootstrapRepository(source, key, deadline, signal);
      const repoPath = repositoryStore.path;
      const origin = (await runGit(['-C', repoPath, 'remote', 'get-url', 'origin'], {
        timeoutMs: remainingTimeout(deadline),
        signal,
      })).stdout.trim();
      if (origin !== source) {
        throw toolError('REPOSITORY_SOURCE_MISMATCH', `Repository key collision or source mismatch for ${key}.`, {
          repositoryKey: key,
        });
      }
      if (!repositoryStore.created) {
        await refreshRepository(repoPath, deadline, signal);
      }

      const resolved = await resolveCommit(repoPath, revision, deadline, signal);
      const branch = await validateCreateBranch(repoPath, createBranch, deadline, signal);
      const root = workspaceRoot();
      const workspacePath = path.join(root, id);
      await fs.mkdir(root, { recursive: true });
      signal?.throwIfAborted();

      const branchOwned = await createOwnedBranchRef(repoPath, branch, resolved.commit, deadline);
      if (signal?.aborted) {
        if (branchOwned) await deleteOwnedBranchRef(repoPath, branch, resolved.commit);
        signal.throwIfAborted();
      }

      const worktreeArgs = ['-C', repoPath, 'worktree', 'add'];
      if (branch === null) worktreeArgs.push('--detach', workspacePath, resolved.commit);
      else worktreeArgs.push(workspacePath, branch);
      const mutation = runGit(worktreeArgs, {
        timeoutMs: remainingTimeout(deadline),
        signal,
      });
      try {
        await trackMutation(mutation);
      } catch (error) {
        await cleanupFailedWorktree(repoPath, workspacePath);
        if (branchOwned) await deleteOwnedBranchRef(repoPath, branch, resolved.commit);
        throw error;
      }

      return {
        id,
        path: workspacePath,
        repositoryKey: key,
        ...repositoryDisplay(source),
        revision: resolved.target,
        head: resolved.commit,
        branch,
      };
    });
  };

  if (stableKey === null) {
    return { ...(await create(`ws-${randomUUID()}`)), duplicate: false };
  }

  return await withIdempotencyLock(stableKey, async () => withCrossProcessIdempotencyLock(
    stableKey,
    deadline,
    signal,
    async () => {
    let existing = await readIdempotencyRecord(stableKey);
    let recordCreated = false;

    if (existing === null) {
      const id = `ws-${randomUUID()}`;
      const intent = {
        id,
        path: path.join(workspaceRoot(), id),
        repositoryKey: key,
        branch: createBranch ?? null,
      };
      const pending = { version: 2, requestHash, state: 'pending', intent };
      recordCreated = await createIdempotencyRecord(stableKey, pending);
      existing = recordCreated ? pending : await readIdempotencyRecord(stableKey);
      if (existing === null) {
        throw toolError('IDEMPOTENCY_STATE_INVALID', 'Workspace idempotency state disappeared during creation.');
      }
    }

    if (existing.requestHash !== requestHash) {
      throw toolError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different workspace request.');
    }

    const expectedPath = path.join(workspaceRoot(), existing.intent.id);
    if (
      existing.intent.repositoryKey !== key ||
      existing.intent.path !== expectedPath ||
      existing.intent.branch !== (createBranch ?? null)
    ) {
      throw toolError('IDEMPOTENCY_STATE_INVALID', 'Stored workspace idempotency intent does not match the request.', {
        workspaceId: existing.intent.id,
      });
    }

    const validateRecovered = async () => {
      const inspected = await inspectWorkspaceEntry(existing.intent.id, existing.intent.path, signal);
      if (
        inspected.state !== 'ready' ||
        inspected.repositoryKey !== key ||
        inspected.branch !== (createBranch ?? null)
      ) {
        throw toolError('IDEMPOTENCY_STALE', 'The workspace for this idempotencyKey no longer exists or is invalid.', {
          workspaceId: existing.intent.id,
        });
      }
      return inspected;
    };

    if (existing.state === 'ready') {
      await validateRecovered();
      return { ...existing.result, duplicate: true };
    }

    if (await workspacePathExists(existing.intent.path)) {
      const inspected = await validateRecovered();
      const result = recoveredWorkspaceResult(inspected, revision);
      try {
        await updateIdempotencyRecord(stableKey, { ...existing, state: 'ready', result });
      } catch (error) {
        throw toolError(
          'IDEMPOTENCY_PERSIST_FAILED',
          'Recovered workspace exists, but its idempotency state could not be finalized. Retry with the same idempotencyKey.',
          { workspaceId: result.id },
          error,
        );
      }
      return { ...result, duplicate: true };
    }

    const result = await create(existing.intent.id);
    try {
      await updateIdempotencyRecord(stableKey, { ...existing, state: 'ready', result });
    } catch (error) {
      throw toolError(
        'IDEMPOTENCY_PERSIST_FAILED',
        'Workspace was created, but its idempotency state could not be finalized. Retry with the same idempotencyKey.',
        { workspaceId: result.id },
        error,
      );
    }
    return { ...result, duplicate: !recordCreated };
    },
  ));
}

export async function workspaceList() {
  const root = workspaceRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { workspaces: [] };
    throw error;
  }

  const candidates = entries
    .filter((entry) => entry.name.startsWith('ws-'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const workspaces = await Promise.all(
    candidates.map((entry) => {
      const workspacePath = path.join(root, entry.name);
      if (!entry.isDirectory() || !WORKSPACE_ID_PATTERN.test(entry.name)) {
        return {
          id: entry.name,
          path: workspacePath,
          state: 'invalid',
          error: 'managed workspace entry has an invalid identity or is not a directory.',
        };
      }
      return inspectWorkspaceEntry(entry.name, workspacePath);
    }),
  );
  return { workspaces };
}

export async function workspaceDelete({ workspaceId, force = false }, signal) {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw toolError('INVALID_WORKSPACE_ID', `Invalid workspaceId: ${workspaceId}`, { workspaceId });
  }
  const workspacePath = path.join(workspaceRoot(), workspaceId);
  const inspected = await inspectWorkspaceEntry(workspaceId, workspacePath, signal);
  if (inspected.state !== 'ready') {
    throw toolError('WORKSPACE_INVALID', `Workspace ${workspaceId} is not a valid managed Git worktree: ${inspected.error}`, { workspaceId });
  }

  return await withRepositoryLock(inspected.repositoryKey, signal, async () => {
    const current = await inspectWorkspaceEntry(workspaceId, workspacePath, signal);
    if (current.state !== 'ready') {
      throw toolError('WORKSPACE_INVALID', `Workspace ${workspaceId} became invalid: ${current.error}`, { workspaceId });
    }
    if (current.dirty && !force) {
      throw toolError('WORKSPACE_DIRTY', `Workspace ${workspaceId} is dirty; pass force: true to discard its changes.`, { workspaceId });
    }
    signal?.throwIfAborted();

    const args = ['-C', path.join(repositoryRoot(), `${current.repositoryKey}.git`), 'worktree', 'remove'];
    if (force) args.push('--force');
    args.push(workspacePath);
    // Destructive mutation commit point: once launched, request cancellation must not interrupt it.
    await trackMutation(runGit(args, { timeoutMs: null, cancellable: false }));
    return {
      workspaceId,
      path: workspacePath,
      deleted: true,
      forced: force,
    };
  });
}

export async function waitForWorkspaceMutations() {
  await Promise.allSettled([...activeMutations]);
}
