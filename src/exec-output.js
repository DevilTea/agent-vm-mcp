import fs from 'node:fs/promises';

export const DEFAULT_EXEC_HEAD_BYTES = 64 * 1024;
export const DEFAULT_EXEC_TAIL_BYTES = 64 * 1024;

function appendHead(current, input, maxBytes) {
  if (current.length >= maxBytes) return current;
  return Buffer.concat([current, input.subarray(0, maxBytes - current.length)]);
}

function appendTail(current, input, maxBytes) {
  if (input.length >= maxBytes) {
    return Buffer.from(input.subarray(input.length - maxBytes));
  }

  const keepCurrent = Math.min(current.length, maxBytes - input.length);
  return Buffer.concat([current.subarray(current.length - keepCurrent), input]);
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer.subarray(offset));
    if (bytesWritten <= 0) throw new Error('Failed to make progress while writing exec output artifact.');
    offset += bytesWritten;
  }
}

export class ExecOutputCapture {
  #artifactStore;
  #headBytes;
  #tailBytes;
  #inlineBytes;
  #inline = Buffer.alloc(0);
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #observedBytes = 0;
  #inlineTruncated = false;
  #artifactPath = null;
  #artifactHandle = null;
  #artifactBytes = 0;
  #consumed = false;
  #finalized = false;

  constructor({
    artifactStore,
    headBytes = DEFAULT_EXEC_HEAD_BYTES,
    tailBytes = DEFAULT_EXEC_TAIL_BYTES,
  }) {
    if (!artifactStore) throw new Error('ExecOutputCapture requires an artifactStore.');
    if (!Number.isSafeInteger(headBytes) || headBytes <= 0) throw new Error('headBytes must be a positive safe integer.');
    if (!Number.isSafeInteger(tailBytes) || tailBytes <= 0) throw new Error('tailBytes must be a positive safe integer.');

    this.#artifactStore = artifactStore;
    this.#headBytes = headBytes;
    this.#tailBytes = tailBytes;
    this.#inlineBytes = headBytes + tailBytes;
  }

  get observedBytes() {
    return this.#observedBytes;
  }

  async consume(readable) {
    if (this.#consumed) throw new Error('Exec output stream was already consumed.');
    this.#consumed = true;

    try {
      for await (const chunk of readable) {
        await this.#append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } finally {
      await this.#closeArtifactHandle();
    }
  }

  async #append(input) {
    if (input.length === 0) return;
    this.#observedBytes += input.length;

    if (!this.#inlineTruncated && this.#observedBytes <= this.#inlineBytes) {
      this.#inline = Buffer.concat([this.#inline, input]);
      return;
    }

    if (!this.#inlineTruncated) {
      this.#inlineTruncated = true;
      this.#head = appendHead(this.#head, this.#inline, this.#headBytes);
      this.#head = appendHead(this.#head, input, this.#headBytes);
      this.#tail = appendTail(this.#tail, this.#inline, this.#tailBytes);
      this.#tail = appendTail(this.#tail, input, this.#tailBytes);

      await this.#ensureArtifactHandle();
      await this.#appendArtifact(this.#inline);
      await this.#appendArtifact(input);
      this.#inline = Buffer.alloc(0);
      return;
    }

    this.#tail = appendTail(this.#tail, input, this.#tailBytes);
    await this.#appendArtifact(input);
  }

  async #ensureArtifactHandle() {
    if (this.#artifactHandle) return;
    this.#artifactPath = await this.#artifactStore.createOwnedTempPath('exec-stream.log');
    this.#artifactHandle = await fs.open(this.#artifactPath, 'wx', 0o600);
  }

  async #appendArtifact(input) {
    const remaining = this.#artifactStore.maxBytes - this.#artifactBytes;
    if (remaining <= 0) return;
    const part = input.subarray(0, remaining);
    if (part.length === 0) return;
    await writeAll(this.#artifactHandle, part);
    this.#artifactBytes += part.length;
  }

  async #closeArtifactHandle() {
    if (!this.#artifactHandle) return;
    const handle = this.#artifactHandle;
    this.#artifactHandle = null;
    await handle.close();
  }

  async finalize({ name, source, publishArtifact = true }) {
    if (this.#finalized) throw new Error('Exec output capture was already finalized.');
    this.#finalized = true;
    await this.#closeArtifactHandle();

    let artifact = null;
    const artifactTruncated = this.#inlineTruncated && this.#observedBytes > this.#artifactStore.maxBytes;

    if (this.#inlineTruncated && this.#artifactPath) {
      const artifactPath = this.#artifactPath;
      this.#artifactPath = null;
      if (publishArtifact) {
        try {
          artifact = await this.#artifactStore.registerOwnedFile(artifactPath, {
            name,
            mimeType: 'text/plain',
            source,
          });
        } catch (error) {
          await fs.rm(artifactPath, { force: true }).catch(() => {});
          throw error;
        }
      } else {
        await fs.rm(artifactPath, { force: true }).catch(() => {});
      }
    }

    const text = this.#inlineTruncated
      ? `${this.#head.toString('utf8')}\n[... ${this.#observedBytes - this.#head.length - this.#tail.length} bytes omitted from inline preview ...]\n${this.#tail.toString('utf8')}`
      : this.#inline.toString('utf8');

    return {
      text,
      observedBytes: this.#observedBytes,
      inlineTruncated: this.#inlineTruncated,
      artifact,
      artifactTruncated,
    };
  }

  async discard() {
    await this.#closeArtifactHandle().catch(() => {});
    if (!this.#artifactPath) return;
    const artifactPath = this.#artifactPath;
    this.#artifactPath = null;
    await fs.rm(artifactPath, { force: true }).catch(() => {});
  }
}
