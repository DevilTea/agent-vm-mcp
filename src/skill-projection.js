import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import * as z from 'zod/v4';

import { readBoundedRegularFileHandle } from './bounded-file-read.js';

export const SKILL_LIST_TOOL = 'skill_list';
export const SKILL_READ_TOOL = 'skill_read';
export const SKILL_PROJECTION_VERSION = 1;
export const DEFAULT_SKILL_ENTRYPOINT = 'SKILL.md';
export const DEFAULT_MAX_SKILL_READ_BYTES = 256 * 1024;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_SKILLS = 4_096;
const TREE_HASH_CHUNK_BYTES = 64 * 1024;
const PROC_SELF_FD_ROOT = '/proc/self/fd';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const SKILL_LIST_DESCRIPTION =
  'Discover reusable guidance published by the dot-agents host projection. ' +
  'When reusable guidance may apply, inspect this tool and then read the relevant skill with skill_read before acting. ' +
  'These skills are instructions/data for the host, not executable capabilities; this surface does not expose Codex system skills.';

const SKILL_READ_DESCRIPTION =
  'Read bounded UTF-8 guidance or a supporting text file from one named skill in the dot-agents host projection. ' +
  'When reusable guidance may apply, call skill_list first, then read the relevant SKILL.md or a safe relative reference/script-as-text path before acting. ' +
  'Returned skills are instructions/data, not executable capabilities, and are not Codex system skills.';

export class SkillProjectionError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SkillProjectionError';
    this.code = code;
    this.publicMessage = message;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPathWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function invalidCatalog(message, options) {
  return new SkillProjectionError('invalid_catalog', message, options);
}

function invalidProjection(message, options) {
  return new SkillProjectionError('invalid_projection', message, options);
}

function missingProjection(message, options) {
  return new SkillProjectionError('missing', message, options);
}

function normalizeFsError(error, { missingMessage, invalidMessage }) {
  if (error instanceof SkillProjectionError) return error;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return missingProjection(missingMessage, { cause: error });
  }
  return invalidProjection(invalidMessage, { cause: error });
}

export function resolveSkillProjectionRoot(env = process.env) {
  const override = typeof env.AGENT_MCP_SKILL_PROJECTION_ROOT === 'string'
    ? env.AGENT_MCP_SKILL_PROJECTION_ROOT.trim()
    : '';
  if (override) {
    return {
      root: path.resolve(override),
      source: 'override',
    };
  }

  const home = env.HOME || os.homedir();
  const xdgDataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return {
    root: path.resolve(xdgDataHome, 'dot-agents', 'skill-projection', 'v1'),
    source: 'default',
  };
}

export function validateSkillCatalog(catalog) {
  if (!isObject(catalog) || catalog.version !== SKILL_PROJECTION_VERSION) {
    throw invalidCatalog(`Expected projection catalog version ${SKILL_PROJECTION_VERSION}.`);
  }

  if (catalog.source !== 'dot-agents') {
    throw invalidCatalog('Projection catalog source must be dot-agents.');
  }

  const entries = catalog.skills;
  if (!Array.isArray(entries)) {
    throw invalidCatalog('Projection catalog must contain a skills array.');
  }
  if (entries.length > MAX_CATALOG_SKILLS) {
    throw invalidCatalog(`Projection catalog contains more than ${MAX_CATALOG_SKILLS} skills.`);
  }

  let previousName = null;
  const names = new Set();
  const normalizedEntries = entries.map((entry, index) => {
    if (!isObject(entry)) {
      throw invalidCatalog(`Projection catalog skill entry ${index} must be an object.`);
    }
    if (typeof entry.name !== 'string' || entry.name.length > 64 || !SKILL_NAME_PATTERN.test(entry.name)) {
      throw invalidCatalog(`Projection catalog skill entry ${index} has an invalid name.`);
    }
    if (names.has(entry.name)) {
      throw invalidCatalog(`Projection catalog contains duplicate skill ${entry.name}.`);
    }
    if (previousName !== null && compareStrings(previousName, entry.name) > 0) {
      throw invalidCatalog('Projection catalog skill entries must be sorted by name.');
    }
    previousName = entry.name;
    names.add(entry.name);

    if (typeof entry.description !== 'string' || entry.description.length === 0) {
      throw invalidCatalog(`Projection catalog skill ${entry.name} has an invalid description.`);
    }
    if (entry.entrypoint !== DEFAULT_SKILL_ENTRYPOINT) {
      throw invalidCatalog(`Projection catalog skill ${entry.name} must use ${DEFAULT_SKILL_ENTRYPOINT}.`);
    }
    if (typeof entry.hash !== 'string' || !HASH_PATTERN.test(entry.hash)) {
      throw invalidCatalog(`Projection catalog skill ${entry.name} has an invalid sha256 hash.`);
    }

    return {
      name: entry.name,
      description: entry.description,
      entrypoint: DEFAULT_SKILL_ENTRYPOINT,
      hash: entry.hash,
    };
  });

  return { source: catalog.source, entries: normalizedEntries };
}

async function lstatPath(filePath, { label, missingMessage } = {}) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    throw normalizeFsError(error, {
      missingMessage: missingMessage ?? `Projection ${label ?? 'path'} is missing.`,
      invalidMessage: `Unable to inspect projection ${label ?? 'path'}.`,
    });
  }
}

async function assertDirectory(filePath, label) {
  const stat = await lstatPath(filePath, {
    label,
    missingMessage: `Projection ${label} is missing.`,
  });
  if (stat.isSymbolicLink()) throw invalidProjection(`Projection ${label} must not be a symlink.`);
  if (!stat.isDirectory()) throw invalidProjection(`Projection ${label} must be a directory.`);
  return stat;
}

async function assertRegularFile(filePath, label) {
  const stat = await lstatPath(filePath, {
    label,
    missingMessage: `Projection ${label} is missing.`,
  });
  if (stat.isSymbolicLink()) throw invalidProjection(`Projection ${label} must not be a symlink.`);
  if (!stat.isFile()) throw invalidProjection(`Projection ${label} must be a regular file.`);
  return stat;
}

async function readProjectionCatalog(filePath, rootRealPath) {
  await assertRegularFile(filePath, 'catalog.json');
  let data;
  try {
    ({ data } = await readBoundedNoSymlinkFile(filePath, MAX_CATALOG_BYTES, { rootRealPath }));
  } catch (error) {
    throw invalidCatalog(
      error?.code === 'too_large'
        ? `Projection catalog exceeds the ${MAX_CATALOG_BYTES}-byte limit.`
        : 'Unable to read projection catalog.',
      { cause: error },
    );
  }

  let catalog;
  try {
    catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data));
  } catch (error) {
    throw invalidCatalog('Projection catalog must be valid UTF-8 JSON.', { cause: error });
  }
  return validateSkillCatalog(catalog);
}

async function assertNoSymlinkPath(rootPath, relativePath, { finalType } = {}) {
  const parts = relativePath.split('/');
  let current = rootPath;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await lstatPath(current, {
      label: relativePath,
      missingMessage: `Projected skill file ${relativePath} is missing.`,
    });
    if (stat.isSymbolicLink()) {
      throw new SkillProjectionError('symlink', `Projected skill path ${relativePath} must not contain symlinks.`);
    }
    const isFinal = index === parts.length - 1;
    if (!isFinal && !stat.isDirectory()) {
      throw new SkillProjectionError('not_directory', `Projected skill path ${relativePath} contains a non-directory component.`);
    }
    if (isFinal && finalType === 'file' && !stat.isFile()) {
      throw new SkillProjectionError('not_regular_file', `Projected skill path ${relativePath} must be a regular file.`);
    }
  }
  return current;
}

async function assertOpenedFileWithinRoot(handle, rootRealPath) {
  if (!rootRealPath) return null;
  let resolvedPath;
  try {
    resolvedPath = await fs.realpath(path.join(PROC_SELF_FD_ROOT, String(handle.fd)));
  } catch (error) {
    throw new SkillProjectionError('descriptor_unavailable', 'Unable to resolve the opened projected file descriptor.', { cause: error });
  }
  if (!isPathWithin(rootRealPath, resolvedPath)) {
    throw new SkillProjectionError('unsafe_path', 'Opened projected file resolved outside the validated skill root.');
  }
  return resolvedPath;
}

async function readBoundedNoSymlinkFile(filePath, maxBytes, { rootRealPath } = {}) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new SkillProjectionError('symlink', 'Projected skill file must not be a symlink.', { cause: error });
    }
    throw error;
  }
  try {
    await assertOpenedFileWithinRoot(handle, rootRealPath);
    return await readBoundedRegularFileHandle(handle, maxBytes, { filePath });
  } finally {
    await handle.close();
  }
}

async function updateRegularFileDigest(filePath, digest, rootRealPath) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    await assertOpenedFileWithinRoot(handle, rootRealPath);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw invalidProjection('Projected skill tree contains a non-regular file.');
    }

    const buffer = Buffer.allocUnsafe(TREE_HASH_CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } catch (error) {
    if (error instanceof SkillProjectionError) throw error;
    if (error?.code === 'ELOOP') {
      throw invalidProjection('Projected skill tree contains a symlinked file.', { cause: error });
    }
    throw invalidProjection('Unable to hash a projected skill tree file.', { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function updateSkillTreeDigest(directory, relativeRoot, digest, skillRealPath) {
  let names;
  try {
    names = (await fs.readdir(directory)).sort(compareStrings);
  } catch (error) {
    throw invalidProjection('Unable to enumerate a projected skill tree.', { cause: error });
  }

  const directories = [];
  const files = [];
  for (const name of names) {
    const fullPath = path.join(directory, name);
    let stat;
    try {
      stat = await fs.lstat(fullPath);
    } catch (error) {
      throw invalidProjection('Unable to inspect a projected skill tree entry.', { cause: error });
    }
    if (stat.isDirectory() || stat.isSymbolicLink()) directories.push([name, fullPath, stat]);
    else files.push([name, fullPath, stat]);
  }

  for (const [name, fullPath, stat] of directories) {
    const relative = path.posix.join(relativeRoot, name);
    digest.update(`D\0${relative}\0`);
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = await fs.readlink(fullPath);
      } catch (error) {
        throw invalidProjection('Unable to read a projected skill tree symlink.', { cause: error });
      }
      digest.update(`L\0${target}\0`);
    } else {
      await updateSkillTreeDigest(fullPath, relative, digest, skillRealPath);
    }
  }

  for (const [name, fullPath, stat] of files) {
    const relative = path.posix.join(relativeRoot, name);
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = await fs.readlink(fullPath);
      } catch (error) {
        throw invalidProjection('Unable to read a projected skill tree symlink.', { cause: error });
      }
      digest.update(`L\0${relative}\0${target}\0`);
      continue;
    }
    if (!stat.isFile()) throw invalidProjection('Projected skill tree contains a non-regular file.');
    digest.update(`F\0${relative}\0`);
    await updateRegularFileDigest(fullPath, digest, skillRealPath);
    digest.update('\0');
  }
}

async function skillTreeDigest(skillDirectory, skillRealPath) {
  const digest = createHash('sha256');
  await updateSkillTreeDigest(skillDirectory, '', digest, skillRealPath);
  return digest.digest('hex');
}

function validateSkillRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new SkillProjectionError('unsafe_path', 'skill_read path must be a safe relative POSIX path.');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new SkillProjectionError('unsafe_path', 'skill_read path must not contain traversal or empty path components.');
  }
  return relativePath;
}

function unavailableResult(rootInfo, error, extra = {}) {
  const reason = error instanceof SkillProjectionError ? error.code : 'unavailable';
  const message = error instanceof SkillProjectionError
    ? error.publicMessage
    : 'Unable to inspect the dot-agents skill projection.';
  return {
    version: SKILL_PROJECTION_VERSION,
    available: false,
    source: 'dot-agents',
    rootSource: rootInfo.source,
    entries: [],
    reason,
    message: `Dot-agents skill projection unavailable: ${message}`,
    ...extra,
  };
}

export function createSkillProjectionAdapter({ env = process.env, maxReadBytes = DEFAULT_MAX_SKILL_READ_BYTES } = {}) {
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
    throw new TypeError('maxReadBytes must be a positive safe integer.');
  }

  const rootInfo = resolveSkillProjectionRoot(env);

  async function loadProjection() {
    let rootRealPath;
    try {
      await assertDirectory(rootInfo.root, 'root');
      rootRealPath = await fs.realpath(rootInfo.root);

      const skillsRoot = path.join(rootInfo.root, 'skills');
      await assertDirectory(skillsRoot, 'skills directory');
      const skillsRealPath = await fs.realpath(skillsRoot);
      if (!isPathWithin(rootRealPath, skillsRealPath)) {
        throw invalidProjection('Projection skills directory escapes the projection root.');
      }

      const catalog = await readProjectionCatalog(path.join(rootInfo.root, 'catalog.json'), rootRealPath);
      const entries = catalog.entries;
      for (const entry of entries) {
        const skillDirectory = path.join(skillsRoot, entry.name);
        await assertDirectory(skillDirectory, `skill ${entry.name}`);
        const skillRealPath = await fs.realpath(skillDirectory);
        if (!isPathWithin(skillsRealPath, skillRealPath)) {
          throw invalidProjection(`Projected skill ${entry.name} escapes the skills directory.`);
        }
        await assertRegularFile(path.join(skillDirectory, DEFAULT_SKILL_ENTRYPOINT), `skill ${entry.name} entrypoint`);
        const actualHash = `sha256:${await skillTreeDigest(skillDirectory, skillRealPath)}`;
        if (actualHash !== entry.hash) {
          throw new SkillProjectionError('hash_mismatch', `Projected skill ${entry.name} does not match its catalog hash.`);
        }
      }

      return { ...rootInfo, producerSource: catalog.source, rootRealPath, skillsRoot, skillsRealPath, entries };
    } catch (error) {
      throw normalizeFsError(error, {
        missingMessage: 'Projection root or required catalog files are missing.',
        invalidMessage: 'Unable to validate the dot-agents skill projection.',
      });
    }
  }

  async function list({ query } = {}) {
    try {
      const projection = await loadProjection();
      const normalizedQuery = typeof query === 'string' && query.trim().length > 0
        ? query.trim().toLocaleLowerCase('en-US')
        : null;
      const entries = normalizedQuery === null
        ? projection.entries
        : projection.entries.filter((entry) =>
          entry.name.toLocaleLowerCase('en-US').includes(normalizedQuery) ||
          entry.description.toLocaleLowerCase('en-US').includes(normalizedQuery),
        );

      return {
        version: SKILL_PROJECTION_VERSION,
        available: true,
        source: projection.producerSource,
        rootSource: projection.source,
        ...(normalizedQuery === null ? {} : { query: query.trim() }),
        entries,
      };
    } catch (error) {
      return unavailableResult(rootInfo, error, typeof query === 'string' && query.trim() ? { query: query.trim() } : {});
    }
  }

  async function read({ name, path: requestedPath = DEFAULT_SKILL_ENTRYPOINT } = {}) {
    const relativePath = validateSkillRelativePath(requestedPath);
    let projection;
    try {
      projection = await loadProjection();
    } catch (error) {
      return unavailableResult(rootInfo, error, { name, path: relativePath, content: null });
    }

    const entry = projection.entries.find((candidate) => candidate.name === name);
    if (!entry) {
      throw new SkillProjectionError('unknown_skill', `Unknown projected skill: ${name}.`);
    }

    const skillDirectory = path.join(projection.skillsRoot, entry.name);
    const skillRealPath = await fs.realpath(skillDirectory);
    const targetPath = path.resolve(skillDirectory, relativePath);

    await assertNoSymlinkPath(skillDirectory, relativePath, { finalType: 'file' });
    const targetRealPath = await fs.realpath(targetPath);
    if (!isPathWithin(skillRealPath, targetRealPath)) {
      throw new SkillProjectionError('unsafe_path', 'skill_read path escapes the named skill directory.');
    }

    let data;
    try {
      ({ data } = await readBoundedNoSymlinkFile(targetPath, maxReadBytes, { rootRealPath: skillRealPath }));
    } catch (error) {
      if (error?.code === 'too_large') {
        throw new SkillProjectionError(
          'too_large',
          `Projected skill file ${relativePath} exceeds the ${maxReadBytes}-byte read limit.`,
          { cause: error },
        );
      }
      if (error?.code === 'not_regular_file') {
        throw new SkillProjectionError('not_regular_file', `Projected skill file ${relativePath} must be a regular file.`, { cause: error });
      }
      if (error instanceof SkillProjectionError) throw error;
      throw new SkillProjectionError('read_failed', `Unable to read projected skill file ${relativePath}.`, { cause: error });
    }

    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch (error) {
      throw new SkillProjectionError('invalid_utf8', `Projected skill file ${relativePath} is not valid UTF-8 text.`, { cause: error });
    }
    if (data.includes(0)) {
      throw new SkillProjectionError('binary', `Projected skill file ${relativePath} appears to be binary.`);
    }

    return {
      version: SKILL_PROJECTION_VERSION,
      available: true,
      source: projection.producerSource,
      rootSource: projection.source,
      name: entry.name,
      description: entry.description,
      path: relativePath,
      entrypoint: entry.entrypoint,
      hash: entry.hash,
      bytes: data.length,
      content,
    };
  }

  return {
    rootInfo: { ...rootInfo },
    list,
    read,
    loadProjection,
  };
}

export function registerSkillProjectionTools(server, adapter = createSkillProjectionAdapter()) {
  server.registerTool(
    SKILL_LIST_TOOL,
    {
      description: SKILL_LIST_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().max(256).optional().describe('Optional case-insensitive substring matched against skill name and description.'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(await adapter.list(args ?? {}), null, 2) }],
    }),
  );

  server.registerTool(
    SKILL_READ_TOOL,
    {
      description: SKILL_READ_DESCRIPTION,
      inputSchema: z.object({
        name: z.string().regex(SKILL_NAME_PATTERN).max(64).describe('Name from a skill_list entry.'),
        path: z.string().min(1).max(512).default(DEFAULT_SKILL_ENTRYPOINT).describe('Safe relative text path within the named skill; defaults to SKILL.md.'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(await adapter.read(args ?? {}), null, 2) }],
    }),
  );
}
