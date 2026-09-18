import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_FILESYSTEM_ENTRIES = 5_000;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.pnpm', '.cache', '.turbo']);

function captureCommand(command, args, cwd, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;

    const append = (buffer, chunk) => {
      if (buffer.length >= MAX_COMMAND_BYTES) return buffer;
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      return Buffer.concat([buffer, input.subarray(0, MAX_COMMAND_BYTES - buffer.length)]);
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        stdout: stdout.toString('utf8'),
        stderr: error.message,
      });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    });
  });
}

async function gitSummary(cwd) {
  const status = await captureCommand(
    'git',
    ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'],
    cwd,
  );

  if (status.exitCode !== 0) {
    return {
      available: false,
      error: status.timedOut
        ? 'git status timed out'
        : status.stderr.trim() || 'not a Git worktree',
    };
  }

  const [head, root] = await Promise.all([
    captureCommand('git', ['rev-parse', 'HEAD'], cwd),
    captureCommand('git', ['rev-parse', '--show-toplevel'], cwd),
  ]);
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const branchSummary = lines[0]?.startsWith('## ') ? lines[0].slice(3) : null;

  return {
    available: true,
    root: root.exitCode === 0 ? root.stdout.trim() : null,
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    branchSummary,
    dirty: lines.slice(branchSummary === null ? 0 : 1).length > 0,
    changedPathCount: lines.slice(branchSummary === null ? 0 : 1).length,
  };
}

async function filesystemSummary(cwd) {
  const resolved = path.resolve(cwd);
  const rootStat = await fs.stat(resolved);
  if (!rootStat.isDirectory()) throw new Error(`work_status cwd is not a directory: ${resolved}`);

  let latestMtimeMs = rootStat.mtimeMs;
  let scannedEntries = 0;
  let truncated = false;
  const stack = [resolved];

  while (stack.length > 0 && !truncated) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scannedEntries >= MAX_FILESYSTEM_ENTRIES) {
        truncated = true;
        break;
      }
      scannedEntries += 1;

      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);

      try {
        const stat = await fs.lstat(target);
        latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
      } catch {
        continue;
      }

      if (entry.isDirectory()) stack.push(target);
    }
  }

  return {
    latestMtimeAt: new Date(latestMtimeMs).toISOString(),
    scannedEntries,
    truncated,
    skippedDirectories: [...SKIPPED_DIRECTORIES],
  };
}

export async function collectWorkStatus({ cwd, agentRuns, managedProcesses }) {
  const resolvedCwd = cwd ? path.resolve(cwd) : null;
  const [git, filesystem] = resolvedCwd
    ? await Promise.all([gitSummary(resolvedCwd), filesystemSummary(resolvedCwd)])
    : [null, null];

  return {
    observedAt: new Date().toISOString(),
    cwd: resolvedCwd,
    agentRuns,
    managedProcesses,
    git,
    filesystem,
  };
}
