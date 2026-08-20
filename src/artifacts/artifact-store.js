import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { inferMimeType, isTextMimeType } from './mime.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_URI_PREFIX = 'artifact://agent-vm/';

function positiveIntegerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

export class ArtifactStore {
  #artifacts = new Map();
  #maxBytes;
  #ttlMs;

  constructor({
    maxBytes = positiveIntegerFromEnv('AGENT_ARTIFACT_MAX_BYTES', DEFAULT_MAX_BYTES),
    ttlMs = positiveIntegerFromEnv('AGENT_ARTIFACT_TTL_MS', DEFAULT_TTL_MS),
  } = {}) {
    this.#maxBytes = maxBytes;
    this.#ttlMs = ttlMs;
  }

  cleanup(now = Date.now()) {
    for (const [id, artifact] of this.#artifacts) {
      if (artifact.expiresAtMs <= now) this.#artifacts.delete(id);
    }
  }

  async registerFile(filePath, { name, mimeType, source } = {}) {
    this.cleanup();

    const resolvedPath = await fs.realpath(filePath);
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
      createdAtMs: now,
      expiresAtMs: now + this.#ttlMs,
    };
    this.#artifacts.set(id, artifact);
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
    const currentStat = await fs.stat(artifact.path);
    if (!currentStat.isFile()) throw new Error(`Artifact is no longer a regular file: ${id}`);
    if (currentStat.size > this.#maxBytes) {
      throw new Error(`Artifact grew beyond the ${this.#maxBytes}-byte limit: ${id}`);
    }
    const data = await fs.readFile(artifact.path);
    if (data.length > this.#maxBytes) {
      throw new Error(`Artifact grew beyond the ${this.#maxBytes}-byte limit while reading: ${id}`);
    }

    const base = {
      uri: `${ARTIFACT_URI_PREFIX}${artifact.id}`,
      mimeType: artifact.mimeType,
    };
    return isTextMimeType(artifact.mimeType)
      ? { ...base, text: data.toString('utf8') }
      : { ...base, blob: data.toString('base64') };
  }
}

export function artifactIdFromUri(uri) {
  const value = typeof uri === 'string' ? uri : uri.href;
  if (!value.startsWith(ARTIFACT_URI_PREFIX)) return null;
  const id = value.slice(ARTIFACT_URI_PREFIX.length);
  return /^art-[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export { ARTIFACT_URI_PREFIX, DEFAULT_MAX_BYTES, DEFAULT_TTL_MS };
