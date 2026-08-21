import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const WORKSPACE_ID_PATTERN = /^ws-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const repositoryLocks = new Map();
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
  const result = await runGit(
    ['-C', repoPath, 'rev-parse', '--verify', '--end-of-options', `${target}^{commit}`],
    { timeoutMs: remainingTimeout(deadline), signal },
  );
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

export async function workspaceCreate({ repository, revision, timeoutMs = DEFAULT_TIMEOUT_MS }, signal) {
  const source = normalizeRepositorySource(repository);
  const key = repositoryKey(source);
  const deadline = Date.now() + timeoutMs;

  return await withRepositoryLock(key, signal, async () => {
    const repositoryStore = await bootstrapRepository(source, key, deadline, signal);
    const repoPath = repositoryStore.path;
    const origin = (await runGit(['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeoutMs: remainingTimeout(deadline),
      signal,
    })).stdout.trim();
    if (origin !== source) {
      throw new Error(`Repository key collision or source mismatch for ${key}.`);
    }
    if (!repositoryStore.created) {
      await refreshRepository(repoPath, deadline, signal);
    }

    const resolved = await resolveCommit(repoPath, revision, deadline, signal);
    const id = `ws-${randomUUID()}`;
    const root = workspaceRoot();
    const workspacePath = path.join(root, id);
    await fs.mkdir(root, { recursive: true });
    signal?.throwIfAborted();

    const mutation = runGit(['-C', repoPath, 'worktree', 'add', '--detach', workspacePath, resolved.commit], {
      timeoutMs: remainingTimeout(deadline),
      signal,
    });
    try {
      await trackMutation(mutation);
    } catch (error) {
      await cleanupFailedWorktree(repoPath, workspacePath);
      throw error;
    }

    return {
      id,
      path: workspacePath,
      repositoryKey: key,
      ...repositoryDisplay(source),
      revision: resolved.target,
      head: resolved.commit,
      branch: null,
    };
  });
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
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error(`Invalid workspaceId: ${workspaceId}`);
  const workspacePath = path.join(workspaceRoot(), workspaceId);
  const inspected = await inspectWorkspaceEntry(workspaceId, workspacePath, signal);
  if (inspected.state !== 'ready') {
    throw new Error(`Workspace ${workspaceId} is not a valid managed Git worktree: ${inspected.error}`);
  }

  return await withRepositoryLock(inspected.repositoryKey, signal, async () => {
    const current = await inspectWorkspaceEntry(workspaceId, workspacePath, signal);
    if (current.state !== 'ready') {
      throw new Error(`Workspace ${workspaceId} became invalid: ${current.error}`);
    }
    if (current.dirty && !force) {
      throw new Error(`Workspace ${workspaceId} is dirty; pass force: true to discard its changes.`);
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
