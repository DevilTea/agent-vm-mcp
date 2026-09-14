import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { ProtocolError, ProtocolErrorCode, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { parseDocument } from 'yaml';

import { readBoundedRegularFileHandle } from './bounded-file-read.js';
import {
  DEFAULT_SKILL_ENTRYPOINT,
  DEFAULT_MAX_SKILL_READ_BYTES,
  SKILL_PROJECTION_VERSION,
  SkillProjectionError,
  resolveSkillProjectionRoot,
  validateSkillCatalog,
} from './skill-projection.js';

export const SEP_SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
export const SEP_SKILLS_LIST_METHOD = 'skills/list';
export const SEP_SKILLS_GET_METHOD = 'skills/get';
export const SEP_DIRECTORY_READ_METHOD = 'resources/directory/read';
export const SEP_MAX_SKILL_RESOURCES = 512;
export const SEP_MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024;

const TREE_HASH_CHUNK_BYTES = 64 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_URI_LENGTH = 4_096;
const PAGE_SIZE = 16;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROC_SELF_FD_ROOT = '/proc/self/fd';

const MIME_TYPES = new Map([
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.mjs', 'text/javascript'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.py', 'text/x-python'],
  ['.sh', 'application/x-sh'],
  ['.svg', 'image/svg+xml'],
  ['.ts', 'text/typescript'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xml', 'application/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.zip', 'application/zip'],
]);

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-sh',
  'text/css',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/typescript',
  'text/x-python',
  'text/yaml',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringCharacterLength(value) {
  return Array.from(value).length;
}

function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPathWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function projectionError(code, message, cause) {
  return new SkillProjectionError(code, message, cause === undefined ? {} : { cause });
}

function normalizeProjectionFsError(error, message) {
  if (error instanceof SkillProjectionError) return error;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return projectionError('missing', message, error);
  return projectionError('invalid_projection', message, error);
}

async function assertDirectory(filePath, label) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    throw normalizeProjectionFsError(error, `Projection ${label} is missing.`);
  }
  if (stat.isSymbolicLink()) throw projectionError('invalid_projection', `Projection ${label} must not be a symlink.`);
  if (!stat.isDirectory()) throw projectionError('invalid_projection', `Projection ${label} must be a directory.`);
  return stat;
}

async function assertRegularFile(filePath, label) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    throw normalizeProjectionFsError(error, `Projection ${label} is missing.`);
  }
  if (stat.isSymbolicLink()) throw projectionError('invalid_projection', `Projection ${label} must not be a symlink.`);
  if (!stat.isFile()) throw projectionError('invalid_projection', `Projection ${label} must be a regular file.`);
  return stat;
}

async function assertOpenedFileWithinRoot(handle, rootRealPath) {
  let resolvedPath;
  try {
    resolvedPath = await fs.realpath(path.join(PROC_SELF_FD_ROOT, String(handle.fd)));
  } catch (error) {
    throw projectionError('descriptor_unavailable', 'Unable to resolve the opened projected file descriptor.', error);
  }
  if (!isPathWithin(rootRealPath, resolvedPath)) {
    throw projectionError('unsafe_path', 'Opened projected file resolved outside the validated skill root.');
  }
}

async function readBoundedFile(filePath, maxBytes, rootRealPath) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    await assertOpenedFileWithinRoot(handle, rootRealPath);
    return await readBoundedRegularFileHandle(handle, maxBytes, { filePath });
  } catch (error) {
    if (error?.code === 'ELOOP') throw projectionError('symlink', 'Projected skill file must not be a symlink.', error);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decodeUtf8(data, label, errorCode = 'invalid_utf8') {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch (error) {
    throw projectionError(errorCode, `Projected skill file ${label} is not valid UTF-8 text.`, error);
  }
}

function assertJsonValue(value, label, depth = 0) {
  if (depth > 64) throw projectionError('invalid_frontmatter', `${label} is nested too deeply.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw projectionError('invalid_frontmatter', `${label} contains a non-finite number.`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, depth + 1);
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${label}.${key}`, depth + 1);
    return;
  }
  throw projectionError('invalid_frontmatter', `${label} contains a value that cannot be represented as JSON.`);
}

function parseFrontmatter(data, skillName) {
  const text = decodeUtf8(data, DEFAULT_SKILL_ENTRYPOINT, 'invalid_frontmatter');
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw projectionError('invalid_frontmatter', `Projected skill ${skillName} must begin with YAML frontmatter.`);
  if (text.slice(match[0].length).trim().length === 0) {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} must contain Markdown body content after its frontmatter.`);
  }

  let document;
  try {
    document = parseDocument(match[1], {
      maxAliasCount: 0,
      schema: 'core',
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} has invalid YAML frontmatter.`, error);
  }
  if (document.errors.length > 0) {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} has invalid YAML frontmatter: ${document.errors[0].message}`);
  }

  let frontmatter;
  try {
    frontmatter = document.toJS({ mapAsMap: false, maxAliasCount: 0 });
  } catch (error) {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter cannot be represented as JSON.`, error);
  }
  if (!isPlainObject(frontmatter)) throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter must be a YAML object.`);
  assertJsonValue(frontmatter, `Projected skill ${skillName} frontmatter`);
  if (
    typeof frontmatter.name !== 'string' ||
    stringCharacterLength(frontmatter.name) < 1 ||
    stringCharacterLength(frontmatter.name) > 64 ||
    !SKILL_NAME_PATTERN.test(frontmatter.name)
  ) {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter has an invalid name.`);
  }
  if (
    typeof frontmatter.description !== 'string' ||
    stringCharacterLength(frontmatter.description) < 1 ||
    stringCharacterLength(frontmatter.description) > 1024
  ) {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter has an invalid description.`);
  }
  if (frontmatter.name !== skillName) {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter name must match the skill directory name.`);
  }
  if (Object.hasOwn(frontmatter, 'license') && typeof frontmatter.license !== 'string') {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter license must be a string.`);
  }
  if (Object.hasOwn(frontmatter, 'compatibility')) {
    if (
      typeof frontmatter.compatibility !== 'string' ||
      stringCharacterLength(frontmatter.compatibility) < 1 ||
      stringCharacterLength(frontmatter.compatibility) > 500
    ) {
      throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter compatibility must be a 1-500 character string.`);
    }
  }
  if (Object.hasOwn(frontmatter, 'metadata')) {
    if (!isPlainObject(frontmatter.metadata) || Object.entries(frontmatter.metadata).some(([, value]) => typeof value !== 'string')) {
      throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter metadata must map string keys to string values.`);
    }
  }
  if (Object.hasOwn(frontmatter, 'allowed-tools') && typeof frontmatter['allowed-tools'] !== 'string') {
    throw projectionError('invalid_frontmatter', `Projected skill ${skillName} frontmatter allowed-tools must be a string.`);
  }
  return frontmatter;
}

function encodeSegment(segment) {
  return encodeURIComponent(segment);
}

function skillRootUri(skillName) {
  return `skill://${encodeSegment(skillName)}`;
}

function skillPathUri(skillName, relativePath = '') {
  if (relativePath === '') return skillRootUri(skillName);
  return `${skillRootUri(skillName)}/${relativePath.split('/').map(encodeSegment).join('/')}`;
}

function mimeTypeFor(relativePath) {
  if (relativePath === DEFAULT_SKILL_ENTRYPOINT) return 'text/markdown';
  return MIME_TYPES.get(path.posix.extname(relativePath).toLocaleLowerCase('en-US')) ?? 'application/octet-stream';
}

function isTextualResource(resource, data) {
  if (TEXT_MIME_TYPES.has(resource.mimeType)) {
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
      return true;
    } catch {
      return false;
    }
  }
  if (resource.mimeType !== 'application/octet-stream' || data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return false;
  }
  let controlBytes = 0;
  for (const byte of data) {
    if ((byte < 0x09 || (byte > 0x0d && byte < 0x20)) && byte !== 0x1b) controlBytes += 1;
  }
  return controlBytes / Math.max(data.length, 1) < 0.01;
}

function validateTreeName(name, skillName) {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw projectionError('invalid_projection', `Projected skill ${skillName} contains an unsafe path component.`);
  }
}

async function hashRegularFile(filePath, relativePath, skillRealPath, skillName, treeDigest, totalBytes) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    await assertOpenedFileWithinRoot(handle, skillRealPath);
    const initialStat = await handle.stat();
    if (!initialStat.isFile()) throw projectionError('invalid_projection', `Projected skill file ${relativePath} must be regular.`);
    if (!Number.isSafeInteger(initialStat.size)) throw projectionError('invalid_projection', `Projected skill file ${relativePath} has an unsafe size.`);
    if (totalBytes + initialStat.size > SEP_MAX_SKILL_TOTAL_BYTES) {
      throw projectionError('limit_exceeded', `Projected skill ${skillName} exceeds the ${SEP_MAX_SKILL_TOTAL_BYTES}-byte total size limit.`);
    }

    const fileDigest = createHash('sha256');
    const chunks = relativePath === DEFAULT_SKILL_ENTRYPOINT ? [] : null;
    const buffer = Buffer.allocUnsafe(TREE_HASH_CHUNK_BYTES);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      size += bytesRead;
      fileDigest.update(chunk);
      treeDigest.update(chunk);
      if (chunks) chunks.push(Buffer.from(chunk));
      if (totalBytes + size > SEP_MAX_SKILL_TOTAL_BYTES) {
        throw projectionError('limit_exceeded', `Projected skill ${skillName} exceeds the ${SEP_MAX_SKILL_TOTAL_BYTES}-byte total size limit.`);
      }
    }
    const finalStat = await handle.stat();
    if (size !== initialStat.size || finalStat.size !== initialStat.size) {
      throw projectionError('invalid_projection', `Projected skill file ${relativePath} changed while it was being validated.`);
    }
    return {
      data: chunks ? Buffer.concat(chunks, size) : null,
      size,
      digest: `sha256:${fileDigest.digest('hex')}`,
    };
  } catch (error) {
    if (error instanceof SkillProjectionError) throw error;
    if (error?.code === 'ELOOP') throw projectionError('invalid_projection', `Projected skill file ${relativePath} must not be a symlink.`, error);
    throw projectionError('invalid_projection', `Unable to hash projected skill file ${relativePath}.`, error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function scanSkillTree(skillDirectory, skillRealPath, skillName) {
  const treeDigest = createHash('sha256');
  const files = [];
  const directories = [];
  let totalBytes = 0;
  let entrypointData = null;

  async function walk(directory, relativeRoot) {
    let names;
    try {
      names = (await fs.readdir(directory)).sort(compareStrings);
    } catch (error) {
      throw projectionError('invalid_projection', `Unable to enumerate projected skill ${skillName}.`, error);
    }
    const record = {
      relativePath: relativeRoot,
      uri: skillPathUri(skillName, relativeRoot),
      filePath: directory,
      children: [],
    };
    directories.push(record);

    const childDirectories = [];
    const childFiles = [];
    for (const name of names) {
      validateTreeName(name, skillName);
      const fullPath = path.join(directory, name);
      let stat;
      try {
        stat = await fs.lstat(fullPath);
      } catch (error) {
        throw projectionError('invalid_projection', `Unable to inspect projected skill ${skillName}.`, error);
      }
      if (stat.isSymbolicLink()) throw projectionError('invalid_projection', `Projected skill ${skillName} must not contain symlinks.`);
      if (stat.isDirectory()) childDirectories.push([name, fullPath]);
      else if (stat.isFile()) childFiles.push([name, fullPath]);
      else throw projectionError('invalid_projection', `Projected skill ${skillName} contains a non-regular entry.`);
    }

    for (const [name, fullPath] of childDirectories) {
      const relativePath = path.posix.join(relativeRoot, name);
      treeDigest.update(`D\0${relativePath}\0`);
      const child = await walk(fullPath, relativePath);
      record.children.push({ kind: 'directory', name, directory: child });
    }
    for (const [name, fullPath] of childFiles) {
      const relativePath = path.posix.join(relativeRoot, name);
      if (files.length >= SEP_MAX_SKILL_RESOURCES) {
        throw projectionError('limit_exceeded', `Projected skill ${skillName} exceeds the ${SEP_MAX_SKILL_RESOURCES}-resource limit.`);
      }
      treeDigest.update(`F\0${relativePath}\0`);
      const hashed = await hashRegularFile(fullPath, relativePath, skillRealPath, skillName, treeDigest, totalBytes);
      totalBytes += hashed.size;
      const resource = {
        relativePath,
        filePath: fullPath,
        uri: skillPathUri(skillName, relativePath),
        name: relativePath === DEFAULT_SKILL_ENTRYPOINT ? skillName : name,
        mimeType: mimeTypeFor(relativePath),
        digest: hashed.digest,
        size: hashed.size,
      };
      files.push(resource);
      if (relativePath === DEFAULT_SKILL_ENTRYPOINT) entrypointData = hashed.data;
      record.children.push({ kind: 'file', name, resource });
      treeDigest.update('\0');
    }
    record.children.sort((a, b) => compareStrings(a.name, b.name));
    return record;
  }

  const rootDirectory = await walk(skillDirectory, '');
  files.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
  directories.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
  return { files, directories, rootDirectory, entrypointData, totalBytes, treeHash: `sha256:${treeDigest.digest('hex')}` };
}

async function readCatalog(rootPath, rootRealPath) {
  const catalogPath = path.join(rootPath, 'catalog.json');
  await assertRegularFile(catalogPath, 'catalog.json');
  let data;
  try {
    ({ data } = await readBoundedFile(catalogPath, MAX_CATALOG_BYTES, rootRealPath));
  } catch (error) {
    throw projectionError('invalid_catalog', error?.code === 'too_large' ? 'Projection catalog is too large.' : 'Unable to read projection catalog.', error);
  }
  let catalog;
  try {
    catalog = JSON.parse(decodeUtf8(data, 'catalog.json'));
  } catch (error) {
    if (error instanceof SkillProjectionError) throw projectionError('invalid_catalog', 'Projection catalog must be valid UTF-8 JSON.', error);
    throw projectionError('invalid_catalog', 'Projection catalog must be valid JSON.', error);
  }
  try {
    return validateSkillCatalog(catalog);
  } catch (error) {
    if (error instanceof SkillProjectionError) throw error;
    throw projectionError('invalid_catalog', 'Projection catalog is invalid.', error);
  }
}

export async function loadProjectionSnapshot({ env = process.env } = {}) {
  const rootInfo = resolveSkillProjectionRoot(env);
  try {
    await assertDirectory(rootInfo.root, 'root');
    const rootRealPath = await fs.realpath(rootInfo.root);
    const skillsRoot = path.join(rootInfo.root, 'skills');
    await assertDirectory(skillsRoot, 'skills directory');
    const skillsRealPath = await fs.realpath(skillsRoot);
    if (!isPathWithin(rootRealPath, skillsRealPath)) throw projectionError('invalid_projection', 'Projection skills directory escapes the projection root.');

    const catalog = await readCatalog(rootInfo.root, rootRealPath);
    const skills = [];
    for (const entry of catalog.entries) {
      const skillDirectory = path.join(skillsRoot, entry.name);
      await assertDirectory(skillDirectory, `skill ${entry.name}`);
      const skillRealPath = await fs.realpath(skillDirectory);
      if (!isPathWithin(skillsRealPath, skillRealPath)) throw projectionError('invalid_projection', `Projected skill ${entry.name} escapes the skills directory.`);
      const scanned = await scanSkillTree(skillDirectory, skillRealPath, entry.name);
      if (scanned.treeHash !== entry.hash) throw projectionError('hash_mismatch', `Projected skill ${entry.name} does not match its catalog hash.`);
      const entrypoint = scanned.files.find((file) => file.relativePath === DEFAULT_SKILL_ENTRYPOINT);
      if (!entrypoint || scanned.entrypointData === null) throw projectionError('invalid_projection', `Projected skill ${entry.name} is missing ${DEFAULT_SKILL_ENTRYPOINT}.`);
      const frontmatter = parseFrontmatter(scanned.entrypointData, entry.name);
      if (frontmatter.description !== entry.description) throw projectionError('invalid_catalog', `Projection catalog description for ${entry.name} does not match SKILL.md frontmatter.`);

      const resourceMap = new Map(scanned.files.map((resource) => [resource.uri, resource]));
      const directoryMap = new Map(scanned.directories.map((directory) => [directory.uri, directory]));
      entrypoint.description = frontmatter.description;
      skills.push({
        name: entry.name,
        description: entry.description,
        entrypoint: entry.entrypoint,
        hash: entry.hash,
        uri: entrypoint.uri,
        frontmatter,
        resources: scanned.files,
        directories: scanned.directories,
        resourceMap,
        directoryMap,
        skillRealPath,
      });
    }
    return { ...rootInfo, producerSource: catalog.source, rootRealPath, skillsRoot, skillsRealPath, entries: catalog.entries, skills };
  } catch (error) {
    throw normalizeProjectionFsError(error, 'Unable to validate the dot-agents skill projection.');
  }
}

function publicSkillEntry(skill) {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: skill.resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
  };
}

function publicResource(resource) {
  return {
    uri: resource.uri,
    name: resource.name,
    mimeType: resource.mimeType,
    ...(resource.description === undefined ? {} : { description: resource.description }),
  };
}

function encodeCursor(kind, offset) {
  return Buffer.from(JSON.stringify({ kind, offset })).toString('base64url');
}

function decodeCursor(cursor, kind, length) {
  if (cursor === undefined) return 0;
  if (!CURSOR_PATTERN.test(cursor)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid cursor for ${kind}.`);
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid cursor for ${kind}.`);
  }
  if (!isObject(decoded) || decoded.kind !== kind || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || decoded.offset > length) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid cursor for ${kind}.`);
  }
  return decoded.offset;
}

function pageItems(items, cursor, kind, pageSize) {
  const offset = decodeCursor(cursor, kind, items.length);
  const page = items.slice(offset, offset + pageSize);
  return { page, ...(offset + page.length < items.length ? { nextCursor: encodeCursor(kind, offset + page.length) } : {}) };
}

async function readResourceBytes(resource, skillRealPath, maxBytes) {
  const relativeParts = resource.relativePath.split('/');
  let current = skillRealPath;
  try {
    for (const part of relativeParts) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw projectionError('symlink', `Projected skill path ${resource.relativePath} must not contain symlinks.`);
      if (current !== resource.filePath && !stat.isDirectory()) throw projectionError('not_directory', `Projected skill path ${resource.relativePath} contains a non-directory component.`);
    }
  } catch (error) {
    if (error instanceof SkillProjectionError) throw error;
    throw projectionError('read_failed', `Unable to inspect projected skill file ${resource.relativePath}.`, error);
  }
  let targetRealPath;
  try {
    targetRealPath = await fs.realpath(resource.filePath);
  } catch (error) {
    throw projectionError('read_failed', `Unable to resolve projected skill file ${resource.relativePath}.`, error);
  }
  if (!isPathWithin(skillRealPath, targetRealPath)) throw projectionError('unsafe_path', 'Opened projected file resolved outside the validated skill root.');
  let data;
  try {
    ({ data } = await readBoundedFile(resource.filePath, maxBytes, skillRealPath));
  } catch (error) {
    if (error?.code === 'too_large') throw projectionError('too_large', `Projected skill file ${resource.relativePath} exceeds its read limit.`, error);
    if (error instanceof SkillProjectionError) throw error;
    throw projectionError('read_failed', `Unable to read projected skill file ${resource.relativePath}.`, error);
  }
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  if (data.length !== resource.size || digest !== resource.digest) throw projectionError('verification_failed', `Projected skill file ${resource.relativePath} changed after its manifest was created.`);
  return data;
}

export function createSepSkillsAdapter({ env = process.env, maxReadBytes = DEFAULT_MAX_SKILL_READ_BYTES } = {}) {
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) throw new TypeError('maxReadBytes must be a positive safe integer.');

  const rootInfo = resolveSkillProjectionRoot(env);

  async function listSkills({ cursor } = {}) {
    const snapshot = await loadProjectionSnapshot({ env });
    const { page, nextCursor } = pageItems(snapshot.skills, cursor, SEP_SKILLS_LIST_METHOD, PAGE_SIZE);
    return {
      resultType: 'complete',
      skills: page.map(publicSkillEntry),
      ttlMs: 0,
      cacheScope: 'private',
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async function getSkill({ uri } = {}) {
    const snapshot = await loadProjectionSnapshot({ env });
    const skill = snapshot.skills.find((candidate) => candidate.uri === uri);
    if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill URI: ${uri}.`);
    return { resultType: 'complete', skill: publicSkillEntry(skill) };
  }

  async function readResource({ uri } = {}) {
    if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Resource URI is invalid.');
    const snapshot = await loadProjectionSnapshot({ env });
    for (const skill of snapshot.skills) {
      const resource = skill.resourceMap.get(uri);
      if (!resource) continue;
      const data = await readResourceBytes(resource, skill.skillRealPath, SEP_MAX_SKILL_TOTAL_BYTES);
      if (isTextualResource(resource, data)) return { contents: [{ uri, mimeType: resource.mimeType, text: decodeUtf8(data, resource.relativePath) }] };
      return { contents: [{ uri, mimeType: resource.mimeType, blob: data.toString('base64') }] };
    }
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown or non-file resource URI: ${uri}.`);
  }

  async function readDirectory({ uri, cursor } = {}) {
    if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Directory URI is invalid.');
    const snapshot = await loadProjectionSnapshot({ env });
    for (const skill of snapshot.skills) {
      const directory = skill.directoryMap.get(uri);
      if (!directory) continue;
      const children = directory.children.map((child) => child.kind === 'directory'
        ? { uri: child.directory.uri, name: child.name, mimeType: 'inode/directory' }
        : publicResource(child.resource));
      const { page, nextCursor } = pageItems(children, cursor, SEP_DIRECTORY_READ_METHOD, PAGE_SIZE);
      return { resultType: 'complete', resources: page, ...(nextCursor === undefined ? {} : { nextCursor }) };
    }
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown or non-directory resource URI: ${uri}.`);
  }

  async function listCompatibility({ query } = {}) {
    try {
      const snapshot = await loadProjectionSnapshot({ env });
      const normalizedQuery = typeof query === 'string' && query.trim().length > 0 ? query.trim().toLocaleLowerCase('en-US') : null;
      const skills = normalizedQuery === null
        ? snapshot.skills
        : snapshot.skills.filter((skill) =>
          skill.name.toLocaleLowerCase('en-US').includes(normalizedQuery) ||
          skill.description.toLocaleLowerCase('en-US').includes(normalizedQuery),
        );
      return {
        version: SKILL_PROJECTION_VERSION,
        available: true,
        source: snapshot.producerSource,
        rootSource: snapshot.source,
        ...(normalizedQuery === null ? {} : { query: query.trim() }),
        entries: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          entrypoint: skill.entrypoint,
          hash: skill.hash,
        })),
      };
    } catch (error) {
      const reason = error instanceof SkillProjectionError ? error.code : 'unavailable';
      const message = error instanceof SkillProjectionError ? error.publicMessage : 'Unable to inspect the dot-agents skill projection.';
      return {
        version: SKILL_PROJECTION_VERSION,
        available: false,
        source: 'dot-agents',
        rootSource: rootInfo.source,
        entries: [],
        reason,
        message: `Dot-agents skill projection unavailable: ${message}`,
        ...(typeof query === 'string' && query.trim() ? { query: query.trim() } : {}),
      };
    }
  }

  async function readCompatibility({ name, path: requestedPath = DEFAULT_SKILL_ENTRYPOINT } = {}) {
    const relativePath = requestedPath;
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0') || relativePath.includes('\\') || path.posix.isAbsolute(relativePath) || relativePath.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
      throw projectionError('unsafe_path', 'skill_read path must be a safe relative POSIX path.');
    }
    let snapshot;
    try {
      snapshot = await loadProjectionSnapshot({ env });
    } catch (error) {
      const reason = error instanceof SkillProjectionError ? error.code : 'unavailable';
      const message = error instanceof SkillProjectionError ? error.publicMessage : 'Unable to inspect the dot-agents skill projection.';
      return {
        version: SKILL_PROJECTION_VERSION,
        available: false,
        source: 'dot-agents',
        rootSource: rootInfo.source,
        entries: [],
        reason,
        message: `Dot-agents skill projection unavailable: ${message}`,
        name,
        path: relativePath,
        content: null,
      };
    }
    const skill = snapshot.skills.find((candidate) => candidate.name === name);
    if (!skill) throw projectionError('unknown_skill', `Unknown projected skill: ${name}.`);
    const resource = skill.resources.find((candidate) => candidate.relativePath === relativePath);
    if (!resource) throw projectionError('unknown_file', `Unknown projected skill file ${relativePath}.`);
    const data = await readResourceBytes(resource, skill.skillRealPath, maxReadBytes);
    if (!isTextualResource(resource, data)) throw projectionError('binary', `Projected skill file ${relativePath} appears to be binary.`);
    return {
      version: SKILL_PROJECTION_VERSION,
      available: true,
      source: snapshot.producerSource,
      rootSource: snapshot.source,
      name: skill.name,
      description: skill.description,
      path: relativePath,
      entrypoint: skill.entrypoint,
      hash: skill.hash,
      bytes: data.length,
      content: decodeUtf8(data, relativePath),
    };
  }

  return { listSkills, getSkill, readResource, readDirectory, listCompatibility, readCompatibility };
}

export function registerSepSkillsExtension(server, adapter = createSepSkillsAdapter()) {
  const protocol = server.server ?? server;
  protocol.registerCapabilities({
    resources: {},
    extensions: {
      [SEP_SKILLS_EXTENSION]: { directoryRead: true },
    },
  });

  const paginatedParams = z.object({ cursor: z.string().max(256).optional() });
  const skillResource = z.object({
    uri: z.string(),
    digest: z.string(),
    size: z.number().int().nonnegative(),
  });
  const skillEntry = z.object({
    uri: z.string(),
    frontmatter: z.record(z.string(), z.any()),
    resources: z.array(skillResource),
  });
  const resourceMetadata = z.object({
    uri: z.string(),
    name: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  });

  protocol.setRequestHandler(
    SEP_SKILLS_LIST_METHOD,
    {
      params: paginatedParams,
      result: z.object({
        resultType: z.literal('complete'),
        skills: z.array(skillEntry),
        ttlMs: z.literal(0),
        cacheScope: z.literal('private'),
        nextCursor: z.string().optional(),
      }),
    },
    async (params) => adapter.listSkills(params),
  );
  protocol.setRequestHandler(
    SEP_SKILLS_GET_METHOD,
    {
      params: z.object({ uri: z.string().min(1).max(MAX_URI_LENGTH) }),
      result: z.object({ resultType: z.literal('complete'), skill: skillEntry }),
    },
    async (params) => adapter.getSkill(params),
  );
  server.registerResource(
    'agent-vm-skill',
    new ResourceTemplate('skill://{skill}/{+path}', { list: undefined }),
    {
      title: 'Agent VM skill file',
      description: 'A file from a projected Agent VM skill.',
    },
    async (uri) => adapter.readResource({ uri: uri.href }),
  );
  protocol.setRequestHandler(
    SEP_DIRECTORY_READ_METHOD,
    {
      params: paginatedParams.extend({ uri: z.string().min(1).max(MAX_URI_LENGTH) }),
      result: z.object({ resultType: z.literal('complete'), resources: z.array(resourceMetadata), nextCursor: z.string().optional() }),
    },
    async (params) => adapter.readDirectory(params),
  );
  return adapter;
}
