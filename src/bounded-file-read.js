import fs from 'node:fs/promises';

const READ_CHUNK_BYTES = 64 * 1024;

export class BoundedFileReadError extends Error {
  constructor(code, { filePath, limitBytes, observedBytes = null, phase = null } = {}) {
    super(code);
    this.name = 'BoundedFileReadError';
    this.code = code;
    this.filePath = filePath ?? null;
    this.limitBytes = limitBytes ?? null;
    this.observedBytes = observedBytes;
    this.phase = phase;
  }
}

export async function readBoundedRegularFileHandle(handle, maxBytes, { filePath = null } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer.');
  }

  const stat = await handle.stat();
  if (!stat.isFile()) {
    throw new BoundedFileReadError('not_regular_file', { filePath, limitBytes: maxBytes, phase: 'stat' });
  }
  if (stat.size > maxBytes) {
    throw new BoundedFileReadError('too_large', {
      filePath,
      limitBytes: maxBytes,
      observedBytes: stat.size,
      phase: 'stat',
    });
  }

  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const remainingProbeBytes = maxBytes + 1 - totalBytes;
    if (remainingProbeBytes <= 0) break;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remainingProbeBytes));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw new BoundedFileReadError('too_large', {
        filePath,
        limitBytes: maxBytes,
        observedBytes: totalBytes,
        phase: 'read',
      });
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }

  return {
    data: Buffer.concat(chunks, totalBytes),
    stat,
  };
}

export async function readBoundedRegularFile(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r');
  try {
    return await readBoundedRegularFileHandle(handle, maxBytes, { filePath });
  } finally {
    await handle.close();
  }
}
