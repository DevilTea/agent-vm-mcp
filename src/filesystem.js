import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { readBoundedRegularFile } from './bounded-file-read.js';

const MAX_READ_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_FILES = 1_024;
const MAX_GIT_DIAGNOSTIC_BYTES = 256 * 1024;
const REVISION_PREFIX = 'sha256:';

const activeFilesystemMutations = new Set();

function resolveFromCwd(inputPath, cwd) {
  return path.resolve(cwd ?? process.env.HOME, inputPath);
}

function splitLinesPreservingNewlines(text) {
  if (text.length === 0) return [];
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function contentRevision(data) {
  return `${REVISION_PREFIX}${createHash('sha256').update(data).digest('hex')}`;
}

export async function readTextFile({ path: inputPath, cwd, startLine = 1, endLine }) {
  if (endLine !== undefined && endLine < startLine) {
    throw new Error('endLine must be greater than or equal to startLine.');
  }

  const resolvedPath = resolveFromCwd(inputPath, cwd);
  let data;
  try {
    ({ data } = await readBoundedRegularFile(resolvedPath, MAX_READ_SOURCE_BYTES));
  } catch (error) {
    if (error?.code === 'not_regular_file') {
      throw new Error(`Not a regular file: ${resolvedPath}`);
    }
    if (error?.code === 'too_large') {
      const size = error.phase === 'stat' ? `${error.observedBytes} bytes` : `more than ${MAX_READ_SOURCE_BYTES} bytes`;
      throw new Error(
        `File is ${size}; read_file supports files up to ${MAX_READ_SOURCE_BYTES} bytes. Use shell tools for larger files.`,
      );
    }
    throw error;
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
    revision: contentRevision(data),
    nextLine: truncated ? returnedEndLine + 1 : null,
  };
}


function assertRelativeEditPath(inputPath) {
  if (path.isAbsolute(inputPath)) throw new Error(`edit_files path must be relative to cwd: ${inputPath}`);
  const normalized = path.normalize(inputPath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`edit_files path escapes cwd or does not name a file: ${inputPath}`);
  }
  return normalized;
}

async function assertNoSymlinkComponents(root, relativePath) {
  const parts = relativePath.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`edit_files target does not exist: ${relativePath}`);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`edit_files refuses symlink path components: ${relativePath}`);
    }
  }
}

function exactMatchSummary(text, needle) {
  const firstIndexes = [];
  let count = 0;
  let from = 0;
  while (from <= text.length - needle.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    if (firstIndexes.length < 8) firstIndexes.push(index);
    from = index + needle.length;
  }
  return { count, firstIndexes };
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function requireExactOccurrences({ text, needle, expected, filePath, operationIndex, label }) {
  const { count, firstIndexes } = exactMatchSummary(text, needle);
  if (count !== expected) {
    const lines = firstIndexes.map((index) => lineNumberAt(text, index));
    const location = lines.length > 0 ? ` Matches start on line(s): ${lines.join(', ')}.` : '';
    throw new Error(
      `edit_files ${filePath} operation ${operationIndex + 1}: expected ${expected} exact ${label} match(es), found ${count}.${location}`,
    );
  }
  return firstIndexes;
}

function applyTextEdits(text, edits, filePath) {
  let next = text;
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (edit.type === 'replace') {
      requireExactOccurrences({
        text: next,
        needle: edit.oldText,
        expected: edit.expectedOccurrences ?? 1,
        filePath,
        operationIndex: index,
        label: 'oldText',
      });
      next = next.split(edit.oldText).join(edit.newText);
      continue;
    }

    const [anchorIndex] = requireExactOccurrences({
      text: next,
      needle: edit.anchor,
      expected: 1,
      filePath,
      operationIndex: index,
      label: 'anchor',
    });
    if (edit.type === 'insert_before') {
      next = `${next.slice(0, anchorIndex)}${edit.text}${next.slice(anchorIndex)}`;
      continue;
    }
    if (edit.type === 'insert_after') {
      const insertionIndex = anchorIndex + edit.anchor.length;
      next = `${next.slice(0, insertionIndex)}${edit.text}${next.slice(insertionIndex)}`;
      continue;
    }
    throw new Error(`Unsupported edit_files operation: ${edit.type}`);
  }
  return next;
}

async function readEditableFile(resolvedPath, relativePath) {
  let data;
  try {
    ({ data } = await readBoundedRegularFile(resolvedPath, MAX_READ_SOURCE_BYTES));
  } catch (error) {
    if (error?.code === 'not_regular_file') throw new Error(`edit_files target is not a regular file: ${relativePath}`);
    if (error?.code === 'too_large') {
      throw new Error(`edit_files target exceeds ${MAX_READ_SOURCE_BYTES} bytes: ${relativePath}`);
    }
    throw error;
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new Error(`edit_files target is not valid UTF-8 text: ${relativePath}`);
  }
  return { data, text, revision: contentRevision(data) };
}

async function cleanupPaths(paths) {
  await Promise.allSettled(paths.map((target) => fs.rm(target, { force: true })));
}

export async function editTextFiles({ cwd, files }, requestSignal) {
  const resolvedCwd = path.resolve(cwd ?? process.env.HOME);
  const cwdStat = await fs.stat(resolvedCwd);
  if (!cwdStat.isDirectory()) throw new Error(`edit_files cwd is not a directory: ${resolvedCwd}`);

  const plans = [];
  const seenPaths = new Set();

  for (const file of files) {
    const relativePath = assertRelativeEditPath(file.path);
    if (seenPaths.has(relativePath)) throw new Error(`edit_files path appears more than once: ${relativePath}`);
    seenPaths.add(relativePath);

    const resolvedPath = path.resolve(resolvedCwd, relativePath);
    if (!resolvedPath.startsWith(`${resolvedCwd}${path.sep}`)) {
      throw new Error(`edit_files path escapes cwd: ${file.path}`);
    }

    await assertNoSymlinkComponents(resolvedCwd, relativePath);
    const current = await readEditableFile(resolvedPath, relativePath);
    if (file.ifMatch !== undefined && file.ifMatch !== current.revision) {
      throw new Error(
        `edit_files revision mismatch for ${relativePath}: expected ${file.ifMatch}, actual ${current.revision}.`,
      );
    }

    const nextText = applyTextEdits(current.text, file.edits, relativePath);
    const nextData = Buffer.from(nextText, 'utf8');
    if (nextData.length > MAX_READ_SOURCE_BYTES) {
      throw new Error(`edit_files result exceeds ${MAX_READ_SOURCE_BYTES} bytes: ${relativePath}`);
    }
    plans.push({
      relativePath,
      resolvedPath,
      current,
      nextData,
      nextRevision: contentRevision(nextData),
      editCount: file.edits.length,
    });
  }

  requestSignal?.throwIfAborted();
  const mutation = commitTextEditPlans(plans, resolvedCwd);
  activeFilesystemMutations.add(mutation);
  try {
    return await mutation;
  } finally {
    activeFilesystemMutations.delete(mutation);
  }
}

async function commitTextEditPlans(plans, resolvedCwd) {
  const temporaryPaths = [];
  const backupPaths = [];
  try {
    for (const plan of plans) {
      const stat = await fs.stat(plan.resolvedPath);
      const token = randomUUID();
      plan.tempPath = path.join(path.dirname(plan.resolvedPath), `.${path.basename(plan.resolvedPath)}.edit-${token}.tmp`);
      plan.backupPath = path.join(path.dirname(plan.resolvedPath), `.${path.basename(plan.resolvedPath)}.edit-${token}.bak`);
      await fs.writeFile(plan.tempPath, plan.nextData, { mode: stat.mode & 0o777 });
      temporaryPaths.push(plan.tempPath);
      backupPaths.push(plan.backupPath);
    }

    for (const plan of plans) {
      await assertNoSymlinkComponents(resolvedCwd, plan.relativePath);
      const latest = await readEditableFile(plan.resolvedPath, plan.relativePath);
      if (latest.revision !== plan.current.revision) {
        throw new Error(
          `edit_files target changed during validation for ${plan.relativePath}: expected ${plan.current.revision}, actual ${latest.revision}.`,
        );
      }
    }

    try {
      for (const plan of plans) {
        await fs.rename(plan.resolvedPath, plan.backupPath);
        plan.backedUp = true;
        await fs.rename(plan.tempPath, plan.resolvedPath);
        plan.installed = true;
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const plan of [...plans].reverse()) {
        if (!plan.backedUp) continue;
        try {
          if (plan.installed) await fs.rm(plan.resolvedPath, { force: true });
          await fs.rename(plan.backupPath, plan.resolvedPath);
          plan.backedUp = false;
        } catch (rollbackError) {
          rollbackErrors.push(`${plan.relativePath}: ${rollbackError.message}`);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${error.message} Rollback also failed: ${rollbackErrors.join('; ')}`);
      }
      throw error;
    }

    await cleanupPaths(backupPaths);
  } finally {
    await cleanupPaths(temporaryPaths);
  }

  return {
    cwd: resolvedCwd,
    files: plans.map((plan) => ({
      path: plan.relativePath,
      beforeRevision: plan.current.revision,
      revision: plan.nextRevision,
      bytes: plan.nextData.length,
      edits: plan.editCount,
    })),
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

function patchPathStyle(header) {
  const value = header.trimStart();
  if (value === '/dev/null' || value.startsWith('/dev/null\t')) return 'null';
  if (value.startsWith('a/') || value.startsWith('"a/')) return 'git-old';
  if (value.startsWith('b/') || value.startsWith('"b/')) return 'git-new';
  return 'cwd';
}

function patchHeaderPairs(patch) {
  const lines = patch.split('\n');
  const pairs = [];
  for (let index = 0; index + 2 < lines.length; index += 1) {
    const oldLine = lines[index];
    const newLine = lines[index + 1];
    const nextLine = lines[index + 2];
    if (!oldLine.startsWith('--- ') || !newLine.startsWith('+++ ') || !nextLine.startsWith('@@')) continue;
    pairs.push({ oldStyle: patchPathStyle(oldLine.slice(4)), newStyle: patchPathStyle(newLine.slice(4)) });
  }
  return pairs;
}

function inferPatchPathStyle(patch, requestedStyle = 'auto') {
  if (requestedStyle === 'cwd' || requestedStyle === 'git') return requestedStyle;
  if (requestedStyle !== 'auto') throw new Error(`Unsupported patch path style: ${requestedStyle}`);

  const hasGitDiffHeader = patch.split('\n').some((line) => (
    line.startsWith('diff --git a/') || line.startsWith('diff --git "a/')
  ));
  const headerPairs = patchHeaderPairs(patch);
  const pairIsGitLike = ({ oldStyle, newStyle }) => (
    (oldStyle === 'null' || oldStyle === 'git-old') &&
    (newStyle === 'null' || newStyle === 'git-new') &&
    !(oldStyle === 'null' && newStyle === 'null')
  );
  const hasCwdPair = headerPairs.some((pair) => !pairIsGitLike(pair));
  const hasGitLikePair = headerPairs.some(pairIsGitLike);

  if (hasGitDiffHeader) {
    if (hasCwdPair) {
      throw new Error('Patch mixes git diff metadata with cwd-relative file headers. Use one path style per patch.');
    }
    return 'git';
  }
  if (hasGitLikePair) {
    throw new Error(
      'Patch path style is ambiguous: a/ and b/ may be real cwd-relative directories or synthetic git prefixes. ' +
      'Set pathStyle to "cwd" or "git" explicitly.',
    );
  }
  return 'cwd';
}

function patchStripComponents(pathStyle) {
  return pathStyle === 'git' ? 1 : 0;
}

function strictGitApplyArgs({ check, stripComponents }) {
  return [
    'apply',
    `-p${stripComponents}`,
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

function runGitApply({ cwd, patch, check, stripComponents, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal, 'Patch validation cancelled.'));
      return;
    }

    const child = spawn('git', strictGitApplyArgs({ check, stripComponents }), {
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

export async function applyUnifiedPatch({ patch, cwd, pathStyle = 'auto' }, requestSignal) {
  const patchBytes = Buffer.byteLength(patch, 'utf8');
  if (patchBytes > MAX_PATCH_BYTES) {
    throw new Error(`Patch is ${patchBytes} bytes; apply_patch supports at most ${MAX_PATCH_BYTES} bytes.`);
  }

  const resolvedCwd = path.resolve(cwd ?? process.env.HOME);
  const cwdStat = await fs.stat(resolvedCwd);
  if (!cwdStat.isDirectory()) throw new Error(`Patch cwd is not a directory: ${resolvedCwd}`);
  const resolvedPathStyle = inferPatchPathStyle(patch, pathStyle);
  const stripComponents = patchStripComponents(resolvedPathStyle);

  const numstat = await runGitApply({
    cwd: resolvedCwd,
    patch,
    check: true,
    stripComponents,
    signal: requestSignal,
  });
  const files = parseNumstat(numstat);
  requestSignal?.throwIfAborted();

  const commit = runGitApply({
    cwd: resolvedCwd,
    patch,
    check: false,
    stripComponents,
    signal: undefined,
  });
  activeFilesystemMutations.add(commit);
  try {
    await commit;
  } finally {
    activeFilesystemMutations.delete(commit);
  }

  return {
    cwd: resolvedCwd,
    bytes: patchBytes,
    pathStyle: resolvedPathStyle,
    files,
  };
}

export async function waitForFilesystemMutations() {
  await Promise.allSettled([...activeFilesystemMutations]);
}
