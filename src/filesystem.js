import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const MAX_READ_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_FILES = 1_024;
const MAX_GIT_DIAGNOSTIC_BYTES = 256 * 1024;

const activePatchCommits = new Set();

function resolveFromCwd(inputPath, cwd) {
  return path.resolve(cwd ?? process.env.HOME, inputPath);
}

function splitLinesPreservingNewlines(text) {
  if (text.length === 0) return [];
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export async function readTextFile({ path: inputPath, cwd, startLine = 1, endLine }) {
  if (endLine !== undefined && endLine < startLine) {
    throw new Error('endLine must be greater than or equal to startLine.');
  }

  const resolvedPath = resolveFromCwd(inputPath, cwd);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${resolvedPath}`);
  if (stat.size > MAX_READ_SOURCE_BYTES) {
    throw new Error(
      `File is ${stat.size} bytes; read_file supports files up to ${MAX_READ_SOURCE_BYTES} bytes. Use shell tools for larger files.`,
    );
  }

  const data = await fs.readFile(resolvedPath);
  if (data.length > MAX_READ_SOURCE_BYTES) {
    throw new Error(
      `File is ${data.length} bytes; read_file supports files up to ${MAX_READ_SOURCE_BYTES} bytes. Use shell tools for larger files.`,
    );
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new Error(`File is not valid UTF-8 text: ${resolvedPath}`);
  }

  const lines = splitLinesPreservingNewlines(text);
  const totalLines = lines.length;
  if (startLine > totalLines + 1) {
    throw new Error(`startLine ${startLine} is beyond EOF; file has ${totalLines} lines.`);
  }

  const requestedEndLine = Math.min(endLine ?? totalLines, totalLines);
  let content = '';
  let contentBytes = 0;
  let returnedEndLine = startLine - 1;
  let truncated = false;

  for (let lineNumber = startLine; lineNumber <= requestedEndLine; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (contentBytes + lineBytes > MAX_READ_OUTPUT_BYTES) {
      if (returnedEndLine < startLine) {
        throw new Error(
          `Line ${lineNumber} exceeds the ${MAX_READ_OUTPUT_BYTES}-byte inline read limit. Use shell tools for this file.`,
        );
      }
      truncated = true;
      break;
    }
    content += line;
    contentBytes += lineBytes;
    returnedEndLine = lineNumber;
  }

  return {
    path: resolvedPath,
    content,
    startLine,
    endLine: returnedEndLine,
    totalLines,
    bytes: contentBytes,
    truncated,
    nextLine: truncated ? returnedEndLine + 1 : null,
  };
}

function directoryEntryType(entry) {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

export async function listDirectory({ path: inputPath = '.', cwd }) {
  const resolvedPath = resolveFromCwd(inputPath, cwd);
  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new Error(
      `Directory contains ${entries.length} entries; list_directory supports at most ${MAX_DIRECTORY_ENTRIES}. Use shell tools for larger directories.`,
    );
  }

  entries.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

  return {
    path: resolvedPath,
    entries: entries.map((entry) => ({
      name: entry.name,
      type: directoryEntryType(entry),
    })),
  };
}

function appendLimited(current, chunk, maxBytes) {
  if (current.length >= maxBytes) return current;
  return Buffer.concat([current, chunk.subarray(0, maxBytes - current.length)]);
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

function abortReason(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function strictGitApplyArgs({ check }) {
  return [
    'apply',
    '--no-unsafe-paths',
    '--no-3way',
    '--no-reject',
    '--no-recount',
    '--no-ignore-space-change',
    '--no-ignore-whitespace',
    '--no-allow-overlap',
    '--no-inaccurate-eof',
    '--whitespace=nowarn',
    ...(check ? ['--check', '--numstat', '-z'] : []),
    '-',
  ];
}

function runGitApply({ cwd, patch, check, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal, 'Patch validation cancelled.'));
      return;
    }

    const child = spawn('git', strictGitApplyArgs({ check }), {
      cwd,
      env: process.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer = null;

    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_PATCH_BYTES) stdoutTruncated = true;
      stdout = appendLimited(stdout, chunk, MAX_PATCH_BYTES);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length + chunk.length > MAX_GIT_DIAGNOSTIC_BYTES) stderrTruncated = true;
      stderr = appendLimited(stderr, chunk, MAX_GIT_DIAGNOSTIC_BYTES);
    });
    child.stdin.on('error', () => {
      // A cancelled/failed git process may close stdin before the patch is fully written.
    });

    const onAbort = () => {
      if (settled || cancelled) return;
      cancelled = true;
      killProcessGroup(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000);
      forceKillTimer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };

    child.once('error', (error) => finish(error));
    child.once('close', (exitCode, exitSignal) => {
      if (cancelled) {
        finish(abortReason(signal, 'Patch validation cancelled.'));
        return;
      }
      if (exitCode !== 0) {
        const diagnostic = stderr.toString('utf8').trim();
        const suffix = stderrTruncated ? '\n[diagnostic truncated]' : '';
        finish(
          new Error(
            `git apply ${check ? 'validation' : 'commit'} failed with exit code ${exitCode}` +
              `${exitSignal ? ` (${exitSignal})` : ''}: ${diagnostic || 'no diagnostic output'}${suffix}`,
          ),
        );
        return;
      }
      if (stdoutTruncated) {
        finish(new Error('git apply validation output exceeded the bounded parser limit.'));
        return;
      }
      finish(null, stdout);
    });

    child.stdin.end(patch, 'utf8');
  });
}

function parseNumstat(buffer) {
  const files = [];
  for (const record of buffer.toString('utf8').split('\0')) {
    if (record.length === 0) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab) {
      throw new Error('Unexpected git apply --numstat output.');
    }

    const additionsToken = record.slice(0, firstTab);
    const deletionsToken = record.slice(firstTab + 1, secondTab);
    const filePath = record.slice(secondTab + 1);
    const parseCount = (token) => {
      if (token === '-') return null;
      if (!/^\d+$/.test(token)) throw new Error('Unexpected git apply --numstat count.');
      const value = Number(token);
      if (!Number.isSafeInteger(value)) throw new Error('git apply --numstat count exceeds safe integer range.');
      return value;
    };
    if (filePath.length === 0) throw new Error('Unexpected empty path in git apply --numstat output.');
    files.push({
      path: filePath,
      additions: parseCount(additionsToken),
      deletions: parseCount(deletionsToken),
    });
  }

  if (files.length > MAX_PATCH_FILES) {
    throw new Error(`Patch touches ${files.length} files; apply_patch supports at most ${MAX_PATCH_FILES}.`);
  }
  return files;
}

export async function applyUnifiedPatch({ patch, cwd }, requestSignal) {
  const patchBytes = Buffer.byteLength(patch, 'utf8');
  if (patchBytes > MAX_PATCH_BYTES) {
    throw new Error(`Patch is ${patchBytes} bytes; apply_patch supports at most ${MAX_PATCH_BYTES} bytes.`);
  }

  const resolvedCwd = path.resolve(cwd ?? process.env.HOME);
  const cwdStat = await fs.stat(resolvedCwd);
  if (!cwdStat.isDirectory()) throw new Error(`Patch cwd is not a directory: ${resolvedCwd}`);

  const numstat = await runGitApply({
    cwd: resolvedCwd,
    patch,
    check: true,
    signal: requestSignal,
  });
  const files = parseNumstat(numstat);
  requestSignal?.throwIfAborted();

  const commit = runGitApply({
    cwd: resolvedCwd,
    patch,
    check: false,
    signal: undefined,
  });
  activePatchCommits.add(commit);
  try {
    await commit;
  } finally {
    activePatchCommits.delete(commit);
  }

  return {
    cwd: resolvedCwd,
    bytes: patchBytes,
    files,
  };
}

export async function waitForFilesystemMutations() {
  await Promise.allSettled([...activePatchCommits]);
}
