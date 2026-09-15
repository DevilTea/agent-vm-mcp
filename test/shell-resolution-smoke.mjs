import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { resolveBashExecutable } from '../src/shell.js';

function parseJsonToolResult(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
  return JSON.parse(text);
}

const projectRoot = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-shell-resolution-'));
const bin = path.join(root, 'bin');
await fs.mkdir(bin, { recursive: true });

const hostBash = await resolveBashExecutable();
const isolatedBash = path.join(bin, 'bash');
await fs.symlink(hostBash, isolatedBash);

const isolatedEnv = {
  ...process.env,
  PATH: bin,
};

assert.equal(
  await resolveBashExecutable(isolatedEnv),
  isolatedBash,
  'bash resolution did not honor the server PATH',
);

const client = new Client({ name: 'shell-resolution-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, 'src/index.js')],
  cwd: projectRoot,
  env: isolatedEnv,
  stderr: 'pipe',
});

let processId = null;

try {
  await client.connect(transport);

  const capabilities = parseJsonToolResult(
    await client.callTool({ name: 'capabilities', arguments: {} }),
  );
  assert.equal(
    capabilities.execution?.shell,
    isolatedBash,
    'capabilities did not report the resolved execution shell',
  );

  const executed = parseJsonToolResult(
    await client.callTool({
      name: 'exec',
      arguments: {
        command: "printf 'exec-shell-ok'",
        env: { PATH: '/definitely-not-a-shell-path' },
      },
    }),
  );
  assert.equal(executed.exitCode, 0);
  assert.equal(executed.stdout, 'exec-shell-ok');

  const started = parseJsonToolResult(
    await client.callTool({
      name: 'process_start',
      arguments: {
        command: "IFS= read -r line; printf 'process:%s' \"$line\"",
        env: { PATH: '/definitely-not-a-shell-path' },
      },
    }),
  );
  processId = started.processId;

  await client.callTool({
    name: 'process_write',
    arguments: { processId, input: 'shell-ok', appendNewline: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const read = parseJsonToolResult(
    await client.callTool({ name: 'process_read', arguments: { processId } }),
  );
  assert.equal(read.stdout.text, 'process:shell-ok');

  console.log(`PASS execution shell resolution path=${isolatedBash}`);
} finally {
  if (processId) {
    await client.callTool({ name: 'process_kill', arguments: { processId, signal: 'SIGTERM' } }).catch(() => {});
  }
  await client.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
