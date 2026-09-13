import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BoundedFileReadError,
  readBoundedRegularFile,
  readBoundedRegularFileHandle,
} from '../src/bounded-file-read.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-bounded-read-'));
try {
  const smallPath = path.join(root, 'small.txt');
  await fs.writeFile(smallPath, 'small file\n');
  const small = await readBoundedRegularFile(smallPath, 1024);
  assert.equal(small.data.toString('utf8'), 'small file\n');

  const largePath = path.join(root, 'large.bin');
  await fs.writeFile(largePath, Buffer.alloc(1025, 0x61));
  await assert.rejects(
    readBoundedRegularFile(largePath, 1024),
    (error) => error instanceof BoundedFileReadError && error.code === 'too_large' && error.phase === 'stat',
  );

  await assert.rejects(
    readBoundedRegularFile(root, 1024),
    (error) => error instanceof BoundedFileReadError && error.code === 'not_regular_file',
  );

  // Simulate a file that was small at fstat time but grows while this same open
  // descriptor is being read. The reader must stop after observing byte limit+1.
  const limit = 10;
  let suppliedBytes = 0;
  const requestedLengths = [];
  const growingHandle = {
    async stat() {
      return { isFile: () => true, size: 1 };
    },
    async read(buffer, offset, length) {
      requestedLengths.push(length);
      const available = limit + 1 - suppliedBytes;
      const bytesRead = Math.min(length, Math.max(0, available));
      buffer.fill(0x62, offset, offset + bytesRead);
      suppliedBytes += bytesRead;
      return { bytesRead, buffer };
    },
  };
  await assert.rejects(
    readBoundedRegularFileHandle(growingHandle, limit),
    (error) =>
      error instanceof BoundedFileReadError &&
      error.code === 'too_large' &&
      error.phase === 'read' &&
      error.observedBytes === limit + 1,
  );
  assert.equal(suppliedBytes, limit + 1);
  assert.ok(requestedLengths.every((length) => length <= limit + 1));

  console.log('PASS bounded same-FD file reads');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
