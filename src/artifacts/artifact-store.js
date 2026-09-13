import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readBoundedRegularFile } from '../bounded-file-read.js';
import { inferMimeType, isTextMimeType } from './mime.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_URI_PREFIX = 'artifact://agent-vm/';
const DEFAULT_OWNED_PARENT = path.join(os.tmpdir(), 'agent-vm-artifacts');

function positiveIntegerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class ArtifactStore {
  #artifacts = new Map();
  #maxBytes;
  #ttlMs;
  #ownedRoot;
  #cleanupTimer = null;
  #pendingCleanup = new Set();
  #closed = false;

  constructor({
    maxBytes = positiveIntegerFromEnv('AGENT_ARTIFACT_MAX_BYTES', DEFAULT_MAX_BYTES),
    ttlMs = positiveIntegerFromEnv('AGENT_ARTIFACT_TTL_MS', DEFAULT_TTL_MS),
    ownedRoot = path.join(DEFAULT_OWNED_PARENT, `store-${process.pid}-${randomUUID()}`),
  } = {}) {
    this.#maxBytes = maxBytes;
    this.#ttlMs = ttlMs;
    this.#ownedRoot = path.resolve(ownedRoot);
  }

  get maxBytes() {
    return this.#maxBytes;
  }

  async createOwnedTempPath(suffix = '') {
    if (this.#closed) throw new Error('Artifact store is closed.');
    const safeSuffix = suffix.replace(/[^A-Za-z0-9._-]/g, '_');
    await fs.mkdir(this.#ownedRoot, { recursive: true, mode: 0o700 });
    return path.join(this.#ownedRoot, `owned-${randomUUID()}${safeSuffix ? `-${safeSuffix}` : ''}`);
  }

  #scheduleOwnedDelete(filePath) {
    let cleanupPromise;
    cleanupPromise = fs
      .rm(filePath, { force: true })
      .catch((error) => {
        console.error(`[artifact-store] failed to remove owned artifact ${filePath}: ${error.message}`);
      })
      .finally(() => this.#pendingCleanup.delete(cleanupPromise));
    this.#pendingCleanup.add(cleanupPromise);
  }

  #scheduleCleanupTimer() {
    if (this.#cleanupTimer) {
      clearTimeout(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    if (this.#closed || this.#artifacts.size === 0) return;

    let nextExpiry = Infinity;
    for (const artifact of this.#artifacts.values()) {
      nextExpiry = Math.min(nextExpiry, artifact.expiresAtMs);
    }
    const delay = Math.max(1, Math.min(nextExpiry - Date.now(), 2_147_483_647));
    this.#cleanupTimer = setTimeout(() => {
      this.#cleanupTimer = null;
      this.cleanup();
    }, delay);
    this.#cleanupTimer.unref();
  }

  cleanup(now = Date.now()) {
    for (const [id, artifact] of this.#artifacts) {
      if (artifact.expiresAtMs > now) continue;
      this.#artifacts.delete(id);
      if (artifact.owned) this.#scheduleOwnedDelete(artifact.path);
    }
    this.#scheduleCleanupTimer();
  }

  async waitForCleanup() {
    await Promise.allSettled([...this.#pendingCleanup]);
  }

  async registerFile(filePath, { name, mimeType, source } = {}) {
    return this.#registerFile(filePath, { name, mimeType, source, owned: false });
  }

  async registerOwnedFile(filePath, { name, mimeType, source } = {}) {
    return this.#registerFile(filePath, { name, mimeType, source, owned: true });
  }

  async #registerFile(filePath, { name, mimeType, source, owned }) {
    if (this.#closed) throw new Error('Artifact store is closed.');
    this.cleanup();

    const resolvedPath = await fs.realpath(filePath);
    if (owned) {
      const resolvedOwnedRoot = await fs.realpath(this.#ownedRoot);
      if (!isPathWithin(resolvedOwnedRoot, resolvedPath)) {
        throw new Error(`Owned artifact path is outside the artifact store directory: ${filePath}`);
      }
    }

    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Artifact path is not a regular file: ${filePath}`);
    }
    if (stat.size > this.#maxBytes) {
      throw new Error(
        `Artifact is ${stat.size} bytes, exceeding the ${this.#maxBytes}-byte limit.`,
      );
    }

    const displayName = name ?? path.basename(resolvedPath);
    if (
      path.basename(displayName) !== displayName ||
      /[\\/\0\r\n]/.test(displayName) ||
      displayName === '.' ||
      displayName === '..'
    ) {
      throw new Error('Artifact display name must be a plain filename without path separators or control characters.');
    }

    const id = `art-${randomUUID()}`;
    const now = Date.now();
    const artifact = {
      id,
      path: resolvedPath,
      name: displayName,
      mimeType: mimeType ?? inferMimeType(resolvedPath),
      size: stat.size,
      source: source ?? null,
      owned,
      createdAtMs: now,
      expiresAtMs: now + this.#ttlMs,
    };
    this.#artifacts.set(id, artifact);
    this.#scheduleCleanupTimer();
    return this.publicMetadata(artifact);
  }

  get(id) {
    this.cleanup();
    const artifact = this.#artifacts.get(id);
    if (!artifact) throw new Error(`Unknown or expired artifact: ${id}`);
    return artifact;
  }

  publicMetadata(artifactOrId) {
    const artifact = typeof artifactOrId === 'string' ? this.get(artifactOrId) : artifactOrId;
    return {
      id: artifact.id,
      name: artifact.name,
      mimeType: artifact.mimeType,
      size: artifact.size,
      uri: `${ARTIFACT_URI_PREFIX}${artifact.id}`,
      ...(artifact.source ? { source: artifact.source } : {}),
      expiresAt: new Date(artifact.expiresAtMs).toISOString(),
    };
  }

  async readResource(id) {
    const artifact = this.get(id);
    let data;
    try {
      ({ data } = await readBoundedRegularFile(artifact.path, this.#maxBytes));
    } catch (error) {
      if (error?.code === 'not_regular_file') {
        throw new Error(`Artifact is no longer a regular file: ${id}`);
      }
      if (error?.code === 'too_large') {
        const suffix = error.phase === 'read' ? ' while reading' : '';
        throw new Error(`Artifact grew beyond the ${this.#maxBytes}-byte limit${suffix}: ${id}`);
      }
      throw error;
    }

    const base = {
      uri: `${ARTIFACT_URI_PREFIX}${artifact.id}`,
      mimeType: artifact.mimeType,
    };
    return isTextMimeType(artifact.mimeType)
      ? { ...base, text: data.toString('utf8') }
      : { ...base, blob: data.toString('base64') };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#cleanupTimer) {
      clearTimeout(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }

    for (const artifact of this.#artifacts.values()) {
      if (artifact.owned) this.#scheduleOwnedDelete(artifact.path);
    }
    this.#artifacts.clear();
    await this.waitForCleanup();
    await fs.rm(this.#ownedRoot, { recursive: true, force: true });
  }
}

export function artifactIdFromUri(uri) {
  const value = typeof uri === 'string' ? uri : uri.href;
  if (!value.startsWith(ARTIFACT_URI_PREFIX)) return null;
  const id = value.slice(ARTIFACT_URI_PREFIX.length);
  return /^art-[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export { ARTIFACT_URI_PREFIX, DEFAULT_MAX_BYTES, DEFAULT_TTL_MS };
