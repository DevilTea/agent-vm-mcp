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
import {
  agentCapabilities,
  agentGet,
  agentPrompt,
  agentRead,
  agentSendKeys,
  agentStart,
  agentStop,
  agentSuspend,
  agentResume,
} from './agents.js';
import { collectCapabilities, inspectCommands } from './capabilities.js';
import { collectSystemAudit } from './system-audit.js';
import { createBridgeToolAdapterFactory, validateBridgeToolAdapters } from './adapters/index.js';
import { createBridgeCallPolicyFactory, validateBridgeCallPolicies } from './policies/index.js';
import { ArtifactStore } from './artifacts/artifact-store.js';
import {
  READ_ARTIFACT_TOOL,
  PRESENT_ARTIFACT_TOOL,
  PRESENT_FILE_TOOL,
} from './artifacts/constants.js';
import { registerArtifactSystem } from './artifacts/register.js';
import { ExecOutputCapture } from './exec-output.js';
import { assertNoRawCodingHarnessLaunch } from './coding-harness-guard.js';
import { resolveHostProfile } from './host-profile.js';
import {
  SERVER_INFO_TOOL,
  ToolCatalogTracker,
  buildServerInfo,
  captureServerRuntimeIdentity,
  serverInfoToolDescription,
} from './server-info.js';
import { applyUnifiedPatch, listDirectory, readTextFile, waitForFilesystemMutations } from './filesystem.js';
import { workspaceCreate, workspaceDelete, workspaceList, waitForWorkspaceMutations } from './workspaces.js';

const MAX_PROCESS_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_SESSIONS = 32;
const DEFAULT_MAX_FILE_IMPORT_BYTES = 256 * 1024 * 1024;
const SERVER_NAME = 'agent-vm-control';
const SERVER_VERSION = '0.5.0';

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

async function executeCommand({ command, cwd, env, timeoutMs }, requestSignal, artifactStore) {
  assertNoRawCodingHarnessLaunch(command, 'exec');
  const startedAt = Date.now();
  const executionArtifactId = randomUUID();
  const child = spawn('/bin/bash', ['-lc', command], {
    cwd: cwd ?? process.env.HOME,
    env: {
      ...process.env,
      ...env,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutCapture = new ExecOutputCapture({ artifactStore });
  const stderrCapture = new ExecOutputCapture({ artifactStore });
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let spawnError = null;

  const terminate = (reason) => {
    if (settled || timedOut || cancelled) return;
    timedOut = reason === 'timeout';
    cancelled = reason === 'cancelled';
    clearTimeout(timeoutTimer);
    killProcessGroup(child, 'SIGTERM');
    setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000).unref();
  };

  const onAbort = () => terminate('cancelled');
  const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);

  if (requestSignal?.aborted) {
    terminate('cancelled');
  } else {
    requestSignal?.addEventListener('abort', onAbort, { once: true });
  }

  const closePromise = new Promise((resolve) => {
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (exitCode, signal) => {
      settled = true;
      resolve({ exitCode, signal });
    });
  });

  const guardCapture = (promise) =>
    promise.catch((error) => {
      killProcessGroup(child, 'SIGKILL');
      throw error;
    });
  const stdoutConsume = guardCapture(stdoutCapture.consume(child.stdout));
  const stderrConsume = guardCapture(stderrCapture.consume(child.stderr));

  try {
    const [{ exitCode, signal }] = await Promise.all([
      closePromise,
      stdoutConsume,
      stderrConsume,
    ]);
    clearTimeout(timeoutTimer);
    requestSignal?.removeEventListener('abort', onAbort);

    const publishArtifact = !cancelled && !requestSignal?.aborted;
    const [stdoutResult, stderrResult] = await Promise.all([
      stdoutCapture.finalize({
        name: `exec-${executionArtifactId}-stdout.log`,
        source: 'exec.stdout',
        publishArtifact,
      }),
      stderrCapture.finalize({
        name: `exec-${executionArtifactId}-stderr.log`,
        source: 'exec.stderr',
        publishArtifact,
      }),
    ]);

    const artifactResult = (capture) =>
      capture.artifact
        ? {
            ...capture.artifact,
            truncated: capture.artifactTruncated,
            observedBytes: capture.observedBytes,
            capturedBytes: capture.artifact.size,
            hardLimitBytes: artifactStore.maxBytes,
          }
        : null;

    const extraError = spawnError ? `\n${spawnError.stack ?? spawnError.message}` : '';
    return {
      exitCode,
      signal,
      timedOut,
      cancelled,
      durationMs: Date.now() - startedAt,
      stdout: stdoutResult.text,
      stderr: `${stderrResult.text}${extraError}`.trim(),
      stdoutBytes: stdoutResult.observedBytes,
      stderrBytes: stderrResult.observedBytes,
      stdoutTruncated: stdoutResult.inlineTruncated,
      stderrTruncated: stderrResult.inlineTruncated,
      stdoutArtifact: artifactResult(stdoutResult),
      stderrArtifact: artifactResult(stderrResult),
    };
  } catch (error) {
    clearTimeout(timeoutTimer);
    requestSignal?.removeEventListener('abort', onAbort);
    killProcessGroup(child, 'SIGKILL');
    await Promise.allSettled([stdoutConsume, stderrConsume, closePromise]);
    await Promise.allSettled([stdoutCapture.discard(), stderrCapture.discard()]);
    throw error;
  }
}

function execResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
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
  assertNoRawCodingHarnessLaunch(command, 'process_start');
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
const activeArtifactStores = new Set();
const NATIVE_TOOL_NAMES = new Set([
  'exec',
  'read_file',
  'list_directory',
  'apply_patch',
  'workspace_create',
  'workspace_list',
  'workspace_delete',
  'agent_capabilities',
  'agent_start',
  'agent_get',
  'agent_read',
  'agent_prompt',
  'agent_send_keys',
  'agent_suspend',
  'agent_resume',
  'agent_stop',
  'process_start',
  'process_list',
  'process_read',
  'process_write',
  'process_kill',
  'mcp_bridge_status',
  'capabilities',
  'command_info',
  'system_audit',
  'import_file',
  SERVER_INFO_TOOL,
  READ_ARTIFACT_TOOL,
  PRESENT_ARTIFACT_TOOL,
  PRESENT_FILE_TOOL,
]);

async function shutdown() {
  await waitForFilesystemMutations();
  await waitForWorkspaceMutations();
  await stopManagedProcesses();
  await Promise.allSettled(
    [...activeBridgeManagers].map((manager) => manager.close()),
  );
  await Promise.allSettled(
    [...activeArtifactStores].map((store) => store.close()),
  );
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

async function createServer() {
  const hostProfile = resolveHostProfile();
  const catalogTracker = new ToolCatalogTracker();
  const server = catalogTracker.instrument(new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  }));
  const runtimeIdentity = await captureServerRuntimeIdentity({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    hostKind: hostProfile.kind,
  });
  const artifactStore = new ArtifactStore();
  activeArtifactStores.add(artifactStore);
  await registerArtifactSystem(server, artifactStore);

  server.registerTool(
    'exec',
    {
      description:
        'Execute an arbitrary shell command on the dedicated disposable Linux agent VM. ' +
        'Oversized stdout/stderr use bounded head/tail previews plus opaque model-only artifacts readable with read_artifact. ' +
        'Use this for commands that complete on their own. For servers, watchers, REPLs, or other long-running/interactive commands, use process_start instead. ' +
        'Do not launch Codex, Antigravity CLI (agy), or Claude Code agent work through exec; use agent_start so coding agents run in persistent Herdr workspaces. Harmless --help/--version probes remain allowed.',
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
    async (args, ctx) => execResult(await executeCommand(args, ctx.mcpReq.signal, artifactStore)),
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
    'workspace_create',
    {
      description:
        'Create an isolated managed Git worktree backed by shared repository storage. Returns an immutable workspace ID and path for use as cwd with existing tools.',
      inputSchema: z.object({
        repository: z.string().min(1).describe('Git clone source. HTTP(S) URLs must not contain embedded userinfo, query parameters, or fragments; use Git credential helpers instead.'),
        revision: z.string().min(1).optional().describe('Optional Git commit-ish. Defaults to the remote default branch.'),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(600_000)
          .default(120_000)
          .describe('Maximum time for repository bootstrap/fetch and worktree creation.'),
      }),
    },
    async (args, ctx) => jsonResult(await workspaceCreate(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'workspace_list',
    {
      description:
        'Rediscover managed Git workspaces from durable filesystem and Git worktree state, including repository, HEAD/branch, and dirty status.',
    },
    async () => jsonResult(await workspaceList()),
  );

  server.registerTool(
    'workspace_delete',
    {
      description:
        'Remove a managed Git worktree by immutable workspace ID. Dirty workspaces are refused unless force is explicitly true.',
      inputSchema: z.object({
        workspaceId: z
          .string()
          .regex(/^ws-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
        force: z.boolean().default(false).describe('Discard dirty workspace content when true.'),
      }),
    },
    async (args, ctx) => jsonResult(await workspaceDelete(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'agent_capabilities',
    {
      description:
        'Discover the Herdr agent runtime, configured persistent session, installed coding harnesses, active and suspended MCP-managed logical agents, native/runtime IDs, lifecycle states, resumability/legacy status, and per-harness installed skills/resume support.',
      inputSchema: z.object({}),
    },
    async (_args, ctx) => jsonResult(await agentCapabilities({ signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'agent_start',
    {
      description:
        'Start a persistent interactive coding agent in a dedicated Herdr workspace. Use this, not exec or process_start, for coding-harness work; it is required for long-running, parallel, or cross-turn Codex/agy/Claude tasks. Production persistence requires the separately managed Herdr service; startup trust/auth prompts are reported, never auto-approved.',
      inputSchema: z.object({
        harness: z.enum(['codex', 'agy', 'claude']).describe('Coding harness to launch.'),
        cwd: z.string().min(1).describe('Existing directory to use as the agent workspace.'),
        model: z.string().min(1).max(128).optional().describe('Optional harness model override.'),
        effort: z
          .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
          .optional()
          .describe('Optional reasoning-effort override; supported values vary by harness.'),
        timeoutMs: z
          .number()
          .int()
          .min(5_000)
          .max(300_000)
          .default(60_000)
          .describe('Maximum time to wait for interactive harness startup.'),
      }),
    },
    async (args, ctx) => jsonResult(await agentStart(args, ctx.mcpReq.signal)),
  );

  const agentIdSchema = z
    .string()
    .regex(/^agent-[0-9a-f]{26}$/)
    .describe('MCP-managed persistent agent ID returned by agent_start.');

  server.registerTool(
    'agent_get',
    {
      description:
        'Inspect one MCP-managed Herdr agent, including lifecycle state and detected interactions that require an orchestration policy decision. requiresDecision means the caller must apply its delegation policy; it does not imply automatic human escalation.',
      inputSchema: z.object({ agentId: agentIdSchema }),
    },
    async (args, ctx) => jsonResult(await agentGet(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'agent_read',
    {
      description:
        'Read bounded terminal transcript from an MCP-managed Herdr agent. Use recent-unwrapped for orchestration-oriented text inspection.',
      inputSchema: z.object({
        agentId: agentIdSchema,
        source: z
          .enum(['visible', 'recent', 'recent-unwrapped', 'detection'])
          .default('recent-unwrapped'),
        lines: z.number().int().min(1).max(1_000).default(120),
      }),
    },
    async (args, ctx) => jsonResult(await agentRead(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'agent_prompt',
    {
      description:
        'Submit a task to an MCP-managed coding agent after a positive readiness check. Preflight or pre-spawn rejection is not submitted; timeout/cancellation after Herdr starts is possibly submitted and unsafe to auto-retry.',
      inputSchema: z.object({
        agentId: agentIdSchema,
        task: z.string().min(1).max(100_000).refine((task) => !task.includes('\0'), 'task must not contain NUL characters'),
        skills: z
          .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
          .max(16)
          .default([]),
        wait: z.boolean().default(true),
        until: z
          .array(z.enum(['idle', 'working', 'blocked', 'done', 'unknown']))
          .max(5)
          .default([]),
        timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
      }),
    },
    async (args, ctx) => jsonResult(await agentPrompt(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'agent_send_keys',
    {
      description:
        'Send only bounded control/navigation keys to an MCP-managed agent terminal after the orchestrator has inspected the current interaction and determined the action is authorized under the caller delegation policy. The runtime does not grant approval or decide whether human escalation is required. Arbitrary text must use agent_prompt instead.',
      inputSchema: z.object({
        agentId: agentIdSchema,
        keys: z
          .array(z.enum(['enter', 'esc', 'up', 'down', 'left', 'right', 'tab', 'backspace']))
          .min(1)
          .max(16),
      }),
    },
    async (args, ctx) => jsonResult(await agentSendKeys(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'agent_suspend',
    {
      description:
        'Suspend an idle or finished MCP-managed logical agent by closing its dedicated Herdr workspace while retaining a uniquely attributed native harness session ID. Use at a task/turn boundary to release runtime resources; legacy agents and sessions without verified native attribution fail clearly. This is distinct from agent_stop, which discards the logical agent.',
      inputSchema: z.object({ agentId: agentIdSchema }),
    },
    async (args, ctx) => jsonResult(await agentSuspend(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'agent_resume',
    {
      description:
        'Resume a suspended logical coding-agent session by creating a fresh Herdr workspace and launching the harness with its verified native session/conversation ID. This continues the same conversation; start a new agent for independent work. Fails clearly when native resume is unavailable.',
      inputSchema: z.object({ agentId: agentIdSchema }),
    },
    async (args, ctx) => jsonResult(await agentResume(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'agent_stop',
    {
      description:
        'Stop an MCP-managed agent with destructive terminal semantics: close its dedicated Herdr workspace when active, or discard its durable logical metadata when suspended. This never stops the shared Herdr session or other agents.',
      inputSchema: z.object({ agentId: agentIdSchema }),
    },
    async (args, ctx) => jsonResult(await agentStop(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    'import_file',
    {
      description:
        'Import a host-provided file into the Agent VM without routing file bytes through model context.',
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
      ...(hostProfile.importFileToolMeta ? { _meta: hostProfile.importFileToolMeta } : {}),
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
        'Start a long-running or interactive non-agent shell command and keep it alive across MCP tool calls. Returns a processId for process_read, process_write, and process_kill. Do not use process_start for Codex, Antigravity CLI (agy), or Claude Code agent work; use agent_start because Herdr provides dedicated parallel workspaces and survives MCP/conversation lifecycle changes.',
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
    policyFactory: createBridgeCallPolicyFactory(),
    bridgeValidator: (bridge) => {
      validateBridgeToolAdapters(bridge);
      validateBridgeCallPolicies(bridge);
    },
  });
  await bridgeManager.initialize();
  activeBridgeManagers.add(bridgeManager);

  server.registerTool(
    'system_audit',
    {
      description:
        'Run a read-only Agent VM maintenance audit: auto-discover managed/custom tools, check update sources, service/repository health, APT updates, and project dependency drift. Unknown newly discovered tools are surfaced in coverage.untracked instead of being silently omitted.',
      inputSchema: z.object({
        checkLatest: z
          .boolean()
          .default(true)
          .describe('When true, query configured/inferred latest-version and remote-repository sources. No updates are installed.'),
      }),
    },
    async ({ checkLatest }, ctx) =>
      jsonResult(
        await collectSystemAudit({
          checkLatest,
          signal: ctx.mcpReq.signal,
          agentRuntime: await agentCapabilities({ signal: ctx.mcpReq.signal }),
          bridgeStatus: bridgeManager.status(),
        }),
      ),
  );

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

  const catalogMarker = catalogTracker.identity().marker;
  server.registerTool(
    SERVER_INFO_TOOL,
    {
      description: serverInfoToolDescription(catalogMarker),
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => jsonResult(buildServerInfo({ runtime: runtimeIdentity, catalogTracker })),
  );

  const originalClose = server.close.bind(server);
  let closed = false;
  server.close = async () => {
    if (closed) return;
    closed = true;
    await waitForFilesystemMutations();
    await waitForWorkspaceMutations();
    await stopManagedProcesses();
    activeBridgeManagers.delete(bridgeManager);
    await bridgeManager.close();
    activeArtifactStores.delete(artifactStore);
    await artifactStore.close();
    await originalClose();
  };

  return server;
}

void serveStdio(createServer);
console.error(`${SERVER_NAME} MCP server v${SERVER_VERSION} running on stdio`);
