import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { McpBridgeManager } from './mcp-bridge.js';
import { collectCapabilities, inspectCommands } from './capabilities.js';
import { createBridgeToolAdapterFactory } from './adapters/index.js';
import { ArtifactStore } from './artifacts/artifact-store.js';
import { PRESENT_FILE_TOOL } from './artifacts/constants.js';
import { registerArtifactSystem } from './artifacts/register.js';
import { applyUnifiedPatch, listDirectory, readTextFile, waitForFilesystemMutations } from './filesystem.js';

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

function executeCommand({ command, cwd, env, timeoutMs }, requestSignal) {
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
    let cancelled = false;
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

    const terminate = (reason) => {
      if (settled || timedOut || cancelled) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      clearTimeout(timeoutTimer);
      killProcessGroup(child, 'SIGTERM');
      setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000).unref();
    };

    const onAbort = () => terminate('cancelled');

    const finish = (exitCode, signal, extraError = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      requestSignal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString('utf8'),
        stderr: `${stderr.toString('utf8')}${extraError}`.trim(),
        stdoutTruncated,
        stderrTruncated,
      });
    };

    const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);

    if (requestSignal?.aborted) {
      terminate('cancelled');
    } else {
      requestSignal?.addEventListener('abort', onAbort, { once: true });
    }

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

function startPersistentProcess({ command, cwd, env }, requestSignal) {
  pruneFinishedProcesses();
  if (processes.size >= MAX_PROCESS_SESSIONS) {
    throw new Error(`Process session limit reached (${MAX_PROCESS_SESSIONS}). Kill or let existing processes exit first.`);
  }
  if (requestSignal?.aborted) {
    throw requestSignal.reason ?? new Error('process_start cancelled before spawn.');
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
    let committed = false;
    let settled = false;

    const cleanupPreCommit = () => {
      requestSignal?.removeEventListener('abort', onAbort);
    };
    const rejectBeforeCommit = (error) => {
      if (settled || committed) return;
      settled = true;
      cleanupPreCommit();
      reject(error);
    };
    const onAbort = () => {
      if (committed || settled) return;
      killProcessGroup(child, 'SIGTERM');
      setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000).unref();
      rejectBeforeCommit(requestSignal.reason ?? new Error('process_start cancelled before registration.'));
    };
    const onErrorBeforeSpawn = (error) => rejectBeforeCommit(error);

    requestSignal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', onErrorBeforeSpawn);
    child.once('spawn', () => {
      if (settled || requestSignal?.aborted) {
        if (!settled) onAbort();
        return;
      }

      committed = true;
      settled = true;
      cleanupPreCommit();
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

function waitForProcessExit(session) {
  if (session.exitedAt !== null) return Promise.resolve();
  return new Promise((resolve) => session.child.once('close', resolve));
}

function waitForDelay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function stopManagedProcesses() {
  const running = [...processes.values()].filter((session) => session.exitedAt === null);
  if (running.length === 0) return;

  for (const session of running) {
    killProcessGroup(session.child, 'SIGTERM');
  }

  await Promise.race([
    Promise.all(running.map((session) => waitForProcessExit(session))),
    waitForDelay(2_000),
  ]);

  const survivors = running.filter((session) => session.exitedAt === null);
  for (const session of survivors) {
    killProcessGroup(session.child, 'SIGKILL');
  }

  if (survivors.length > 0) {
    await Promise.race([
      Promise.all(survivors.map((session) => waitForProcessExit(session))),
      waitForDelay(500),
    ]);
  }
}

const activeBridgeManagers = new Set();
const NATIVE_TOOL_NAMES = new Set([
  'exec',
  'read_file',
  'list_directory',
  'apply_patch',
  'process_start',
  'process_list',
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
  await waitForFilesystemMutations();
  await stopManagedProcesses();
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
    async (args, ctx) => jsonResult(await executeCommand(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'read_file',
    {
      description:
        'Read a bounded UTF-8 text file or 1-based line range with structured line metadata. Use shell tools for binary or very large files.',
      inputSchema: z.object({
        path: z.string().min(1).describe('File path. Relative paths are resolved against cwd.'),
        cwd: z.string().optional().describe('Base directory. Defaults to the agent user home directory.'),
        startLine: z.number().int().min(1).default(1).describe('First line to return, using 1-based indexing.'),
        endLine: z.number().int().min(1).optional().describe('Inclusive last line to return.'),
      }),
    },
    async (args) => jsonResult(await readTextFile(args)),
  );

  server.registerTool(
    'list_directory',
    {
      description:
        'List one directory level as deterministic structured name/type entries, including dotfiles. This tool is intentionally non-recursive.',
      inputSchema: z.object({
        path: z.string().min(1).default('.').describe('Directory path. Relative paths are resolved against cwd.'),
        cwd: z.string().optional().describe('Base directory. Defaults to the agent user home directory.'),
      }),
    },
    async (args) => jsonResult(await listDirectory(args)),
  );

  server.registerTool(
    'apply_patch',
    {
      description:
        'Apply a strict standard unified diff relative to cwd. All hunks are validated before mutation; context mismatch rejects the entire patch without fuzzy or partial fallback.',
      inputSchema: z.object({
        patch: z.string().min(1).describe('Standard unified diff to validate and apply.'),
        cwd: z.string().optional().describe('Patch root directory. Defaults to the agent user home directory.'),
      }),
    },
    async (args, ctx) => jsonResult(await applyUnifiedPatch(args, ctx.mcpReq.signal)),
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
    async ({ file, destination, cwd, overwrite }, ctx) => {
      const requestSignal = ctx.mcpReq.signal;
      const response = await fetch(file.download_url, {
        redirect: 'follow',
        signal: requestSignal,
      });
      if (!response.ok) throw new Error(`Failed to download provided file: HTTP ${response.status}`);
      if (response.body === null) throw new Error('Provided file download returned no response body.');

      const contentLengthHeader = response.headers.get('content-length');
      const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
      if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_FILE_IMPORT_BYTES) {
        await response.body.cancel();
        throw new Error(`Provided file exceeds the ${MAX_FILE_IMPORT_BYTES}-byte import limit.`);
      }

      const safeName = (file.file_name ?? 'upload.bin').replace(/[^A-Za-z0-9._-]/g, '_');
      const baseDir = cwd ?? process.env.HOME;
      const resolvedPath = destination
        ? path.resolve(baseDir, destination)
        : path.join(baseDir, 'inbox', `${randomUUID()}-${safeName}`);
      const parentDir = path.dirname(resolvedPath);
      await fs.mkdir(parentDir, { recursive: true });

      const tempPath = path.join(parentDir, `.${path.basename(resolvedPath)}.import-${randomUUID()}`);
      const hash = createHash('sha256');
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_FILE_IMPORT_BYTES) {
            callback(new Error(`Provided file exceeds the ${MAX_FILE_IMPORT_BYTES}-byte import limit.`));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      try {
        await pipeline(
          Readable.fromWeb(response.body),
          limiter,
          createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
          { signal: requestSignal },
        );
        requestSignal.throwIfAborted();

        if (overwrite) {
          await fs.rename(tempPath, resolvedPath);
        } else {
          await fs.link(tempPath, resolvedPath);
          await fs.unlink(tempPath);
        }
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }

      return jsonResult({
        fileId: file.file_id,
        fileName: file.file_name ?? null,
        mimeType: file.mime_type ?? response.headers.get('content-type'),
        bytes,
        sha256: hash.digest('hex'),
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
    async (args, ctx) => {
      const session = await startPersistentProcess(args, ctx.mcpReq.signal);
      return jsonResult(processSummary(session));
    },
  );

  server.registerTool(
    'process_list',
    {
      description:
        'List process sessions created by process_start so persistent processes can be rediscovered across MCP client or conversation changes.',
    },
    async () =>
      jsonResult({
        processes: [...processes.values()]
          .sort((a, b) => a.startedAt - b.startedAt)
          .map((session) => processSummary(session)),
      }),
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
    await waitForFilesystemMutations();
    await stopManagedProcesses();
    activeBridgeManagers.delete(bridgeManager);
    await bridgeManager.close();
    await originalClose();
  };

  return server;
}

void serveStdio(createServer);
console.error('agent-vm-control MCP server v0.4.0 running on stdio');
