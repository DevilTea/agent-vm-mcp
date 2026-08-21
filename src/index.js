import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { McpBridgeManager } from './mcp-bridge.js';
import { collectCapabilities, inspectCommands } from './capabilities.js';
import { createBridgeToolAdapterFactory } from './adapters/index.js';
import { ArtifactStore } from './artifacts/artifact-store.js';
import { PRESENT_FILE_TOOL } from './artifacts/constants.js';
import { registerArtifactSystem } from './artifacts/register.js';

const MAX_EXEC_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROCESS_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_SESSIONS = 32;
const DEFAULT_MAX_FILE_IMPORT_BYTES = 256 * 1024 * 1024;

function positiveIntegerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

const MAX_FILE_IMPORT_BYTES = positiveIntegerFromEnv('AGENT_FILE_IMPORT_MAX_BYTES', DEFAULT_MAX_FILE_IMPORT_BYTES);

class BoundedStreamBuffer {
  #buffer = Buffer.alloc(0);
  #baseOffset = 0;

  append(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, input]);

    if (this.#buffer.length > MAX_PROCESS_STREAM_BYTES) {
      const dropped = this.#buffer.length - MAX_PROCESS_STREAM_BYTES;
      this.#buffer = this.#buffer.subarray(dropped);
      this.#baseOffset += dropped;
    }
  }

  read(offset) {
    const requestedOffset = offset ?? this.#baseOffset;
    const effectiveOffset = Math.max(requestedOffset, this.#baseOffset);
    const relativeOffset = effectiveOffset - this.#baseOffset;
    const data = this.#buffer.subarray(relativeOffset);

    return {
      text: data.toString('utf8'),
      requestedOffset,
      startOffset: effectiveOffset,
      nextOffset: this.#baseOffset + this.#buffer.length,
      truncatedBeforeOffset: requestedOffset < this.#baseOffset,
    };
  }
}

const processes = new Map();

function jsonResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function appendLimited(current, chunk, maxBytes) {
  if (current.length >= maxBytes) {
    return current;
  }

  return Buffer.concat([
    current,
    chunk.subarray(0, maxBytes - current.length),
  ]);
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

function executeCommand({ command, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: cwd ?? process.env.HOME,
      env: {
        ...process.env,
        ...env,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_EXEC_OUTPUT_BYTES) {
        stdoutTruncated = true;
      }
      stdout = appendLimited(stdout, chunk, MAX_EXEC_OUTPUT_BYTES);
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length + chunk.length > MAX_EXEC_OUTPUT_BYTES) {
        stderrTruncated = true;
      }
      stderr = appendLimited(stderr, chunk, MAX_EXEC_OUTPUT_BYTES);
    });

    const finish = (exitCode, signal, extraError = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString('utf8'),
        stderr: `${stderr.toString('utf8')}${extraError}`.trim(),
        stdoutTruncated,
        stderrTruncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.on('error', (error) => {
      finish(null, null, `\n${error.stack ?? error.message}`);
    });

    child.on('close', (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
}

function pruneFinishedProcesses() {
  if (processes.size < MAX_PROCESS_SESSIONS) return;

  const finished = [...processes.values()]
    .filter((session) => session.exitedAt !== null)
    .sort((a, b) => a.exitedAt - b.exitedAt);

  while (processes.size >= MAX_PROCESS_SESSIONS && finished.length > 0) {
    processes.delete(finished.shift().id);
  }
}

function getProcessSession(processId) {
  const session = processes.get(processId);
  if (!session) {
    throw new Error(`Unknown processId: ${processId}`);
  }
  return session;
}

function startPersistentProcess({ command, cwd, env }) {
  pruneFinishedProcesses();
  if (processes.size >= MAX_PROCESS_SESSIONS) {
    throw new Error(`Process session limit reached (${MAX_PROCESS_SESSIONS}). Kill or let existing processes exit first.`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: cwd ?? process.env.HOME,
      env: {
        ...process.env,
        ...env,
      },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session = {
      id: randomUUID(),
      command,
      cwd: cwd ?? process.env.HOME,
      child,
      stdout: new BoundedStreamBuffer(),
      stderr: new BoundedStreamBuffer(),
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      signal: null,
    };

    const onErrorBeforeSpawn = (error) => {
      reject(error);
    };

    child.once('error', onErrorBeforeSpawn);
    child.once('spawn', () => {
      child.off('error', onErrorBeforeSpawn);
      processes.set(session.id, session);

      child.stdout.on('data', (chunk) => session.stdout.append(chunk));
      child.stderr.on('data', (chunk) => session.stderr.append(chunk));
      child.on('error', (error) => session.stderr.append(`\n${error.stack ?? error.message}\n`));
      child.on('close', (exitCode, signal) => {
        session.exitCode = exitCode;
        session.signal = signal;
        session.exitedAt = Date.now();
      });

      resolve(session);
    });
  });
}

function processSummary(session) {
  return {
    processId: session.id,
    pid: session.child.pid,
    command: session.command,
    cwd: session.cwd,
    running: session.exitedAt === null,
    exitCode: session.exitCode,
    signal: session.signal,
    startedAt: new Date(session.startedAt).toISOString(),
    exitedAt: session.exitedAt === null ? null : new Date(session.exitedAt).toISOString(),
  };
}

function stopManagedProcesses() {
  for (const session of processes.values()) {
    if (session.exitedAt === null) {
      killProcessGroup(session.child, 'SIGTERM');
    }
  }
}

const activeBridgeManagers = new Set();
const NATIVE_TOOL_NAMES = new Set([
  'exec',
  'process_start',
  'process_read',
  'process_write',
  'process_kill',
  'mcp_bridge_status',
  'capabilities',
  'command_info',
  'import_file',
  PRESENT_FILE_TOOL,
]);

async function shutdown() {
  stopManagedProcesses();
  await Promise.allSettled(
    [...activeBridgeManagers].map((manager) => manager.close()),
  );
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

async function createServer() {
  const server = new McpServer({
    name: 'agent-vm-control',
    version: '0.4.0',
  });
  const artifactStore = new ArtifactStore();
  await registerArtifactSystem(server, artifactStore);

  server.registerTool(
    'exec',
    {
      description:
        'Execute an arbitrary shell command on the dedicated disposable Linux agent VM. ' +
        'Use this for commands that complete on their own. For servers, watchers, REPLs, or other long-running/interactive commands, use process_start instead.',
      inputSchema: z.object({
        command: z.string().min(1).describe('Shell command to execute with bash -lc.'),
        cwd: z.string().optional().describe('Working directory. Defaults to the agent user home directory.'),
        env: z.record(z.string(), z.string()).optional().describe('Additional environment variables.'),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(600_000)
          .default(120_000)
          .describe('Maximum execution time in milliseconds.'),
      }),
    },
    async (args) => jsonResult(await executeCommand(args)),
  );

  server.registerTool(
    'import_file',
    {
      description:
        'Import a ChatGPT-hosted file into the agent VM without routing file bytes through model context.',
      inputSchema: z.object({
        file: z.object({
          download_url: z.string().url(),
          file_id: z.string().min(1),
          mime_type: z.string().optional(),
          file_name: z.string().optional(),
        }),
        destination: z.string().min(1).optional(),
        cwd: z.string().optional(),
        overwrite: z.boolean().default(false),
      }),
      _meta: { 'openai/fileParams': ['file'] },
    },
    async ({ file, destination, cwd, overwrite }) => {
      const response = await fetch(file.download_url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`Failed to download provided file: HTTP ${response.status}`);

      const contentLengthHeader = response.headers.get('content-length');
      const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
      if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_FILE_IMPORT_BYTES) {
        throw new Error(`Provided file exceeds the ${MAX_FILE_IMPORT_BYTES}-byte import limit.`);
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > MAX_FILE_IMPORT_BYTES) {
        throw new Error(`Provided file exceeds the ${MAX_FILE_IMPORT_BYTES}-byte import limit.`);
      }

      const safeName = (file.file_name ?? 'upload.bin').replace(/[^A-Za-z0-9._-]/g, '_');
      const baseDir = cwd ?? process.env.HOME;
      const resolvedPath = destination
        ? path.resolve(baseDir, destination)
        : path.join(baseDir, 'inbox', `${randomUUID()}-${safeName}`);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, data, { flag: overwrite ? 'w' : 'wx', mode: 0o600 });

      return jsonResult({
        fileId: file.file_id,
        fileName: file.file_name ?? null,
        mimeType: file.mime_type ?? response.headers.get('content-type'),
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        path: resolvedPath,
      });
    },
  );

  server.registerTool(
    'command_info',
    {
      description:
        'Inspect whether named CLI commands are available on the VM. Curated commands also include category, summary, and detected version metadata.',
      inputSchema: z.object({
        names: z
          .array(z.string().regex(/^[A-Za-z0-9_.+-]+$/))
          .min(1)
          .max(32)
          .describe('CLI command names to inspect via PATH lookup.'),
      }),
    },
    async ({ names }) => jsonResult({ commands: await inspectCommands(names) }),
  );

  server.registerTool(
    'process_start',
    {
      description:
        'Start a long-running or interactive shell command and keep it alive across MCP tool calls. Returns a processId for process_read, process_write, and process_kill.',
      inputSchema: z.object({
        command: z.string().min(1).describe('Shell command to start with bash -lc.'),
        cwd: z.string().optional().describe('Working directory. Defaults to the agent user home directory.'),
        env: z.record(z.string(), z.string()).optional().describe('Additional environment variables.'),
      }),
    },
    async (args) => {
      const session = await startPersistentProcess(args);
      return jsonResult(processSummary(session));
    },
  );

  server.registerTool(
    'process_read',
    {
      description:
        'Read incremental stdout/stderr and status from a process started by process_start. Pass the returned next offsets on later reads to receive only new output.',
      inputSchema: z.object({
        processId: z.string().uuid(),
        stdoutOffset: z.number().int().min(0).optional(),
        stderrOffset: z.number().int().min(0).optional(),
      }),
    },
    async ({ processId, stdoutOffset, stderrOffset }) => {
      const session = getProcessSession(processId);
      return jsonResult({
        ...processSummary(session),
        stdout: session.stdout.read(stdoutOffset),
        stderr: session.stderr.read(stderrOffset),
      });
    },
  );

  server.registerTool(
    'process_write',
    {
      description: 'Write to stdin of a running process started by process_start.',
      inputSchema: z.object({
        processId: z.string().uuid(),
        input: z.string(),
        appendNewline: z.boolean().default(false),
      }),
    },
    async ({ processId, input, appendNewline }) => {
      const session = getProcessSession(processId);
      if (session.exitedAt !== null || !session.child.stdin.writable) {
        throw new Error(`Process ${processId} is not running or stdin is closed.`);
      }

      const data = appendNewline ? `${input}\n` : input;
      await new Promise((resolve, reject) => {
        session.child.stdin.write(data, (error) => (error ? reject(error) : resolve()));
      });

      return jsonResult({ processId, bytesWritten: Buffer.byteLength(data) });
    },
  );

  server.registerTool(
    'process_kill',
    {
      description: 'Send SIGTERM, SIGINT, or SIGKILL to a process group started by process_start.',
      inputSchema: z.object({
        processId: z.string().uuid(),
        signal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']).default('SIGTERM'),
      }),
    },
    async ({ processId, signal }) => {
      const session = getProcessSession(processId);
      if (session.exitedAt === null) {
        killProcessGroup(session.child, signal);
      }
      return jsonResult({ ...processSummary(session), requestedSignal: signal });
    },
  );

  const bridgeManager = new McpBridgeManager({
    server,
    reservedToolNames: new Set(NATIVE_TOOL_NAMES),
    adapterFactory: createBridgeToolAdapterFactory({ artifactStore }),
  });
  await bridgeManager.initialize();
  activeBridgeManagers.add(bridgeManager);

  server.registerTool(
    'capabilities',
    {
      description:
        'Discover the VM execution environment: host/runtime details, curated CLI capabilities, native MCP tools, and connected upstream MCP bridges.',
    },
    async () =>
      jsonResult(
        await collectCapabilities({
          nativeTools: NATIVE_TOOL_NAMES,
          bridgeStatus: bridgeManager.status(),
        }),
      ),
  );

  server.registerTool(
    'mcp_bridge_status',
    {
      description:
        'Report configured upstream MCP bridges, their connection state, and forwarded tool-name mappings.',
    },
    async () => jsonResult(bridgeManager.status()),
  );

  const originalClose = server.close.bind(server);
  let closed = false;
  server.close = async () => {
    if (closed) return;
    closed = true;
    stopManagedProcesses();
    activeBridgeManagers.delete(bridgeManager);
    await bridgeManager.close();
    await originalClose();
  };

  return server;
}

void serveStdio(createServer);
console.error('agent-vm-control MCP server v0.4.0 running on stdio');
