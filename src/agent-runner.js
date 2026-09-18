import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

import { inspectCommands } from './capabilities.js';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const CODEX_MODEL = 'gpt-5.6-luna';
const CODEX_EFFORT = 'max';

function appendBounded(buffer, chunk) {
  const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buffer.length >= MAX_CAPTURE_BYTES) return buffer;
  return Buffer.concat([buffer, input.subarray(0, MAX_CAPTURE_BYTES - buffer.length)]);
}

function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

function taskWithSkills(task, skills) {
  if (!skills?.length) return task;
  return `Use the following installed skills for this task: ${skills.join(', ')}. Read and follow each skill's SKILL.md before acting.\n\n${task}`;
}

function parseJsonLines(text) {
  const events = [];
  const invalidLines = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      invalidLines.push(trimmed);
    }
  }
  return { events, invalidLines };
}

function deepContinuationId(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.thread_id === 'string') return value.thread_id;
  if (typeof value.conversation_id === 'string') return value.conversation_id;
  for (const nested of Object.values(value)) {
    const found = deepContinuationId(nested);
    if (found) return found;
  }
  return null;
}

function invocationFor(harness, task, timeoutMs) {
  if (harness === 'codex') {
    return {
      args: [
        'exec',
        '--json',
        '--model',
        CODEX_MODEL,
        '--config',
        `model_reasoning_effort="${CODEX_EFFORT}"`,
        task,
      ],
      output: 'jsonl',
      policy: { model: CODEX_MODEL, effort: CODEX_EFFORT },
    };
  }
  if (harness === 'agy') {
    return {
      args: [
        '-p',
        task,
        '--output-format',
        'stream-json',
        '--print-timeout',
        `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`,
      ],
      output: 'jsonl',
      policy: null,
    };
  }
  const error = new Error(`Unsupported coding harness: ${harness}`);
  error.code = 'unsupported_harness';
  throw error;
}

async function assertDirectory(cwd) {
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) {
    const error = new Error(`Agent cwd is not a directory: ${cwd}`);
    error.code = 'invalid_agent_cwd';
    throw error;
  }
}

export async function agentCapabilities() {
  const commands = await inspectCommands(['codex', 'agy', 'tmux']);
  const byName = new Map(commands.map((command) => [command.name, command]));
  const harnesses = ['codex', 'agy'].map((kind) => {
    const command = byName.get(kind);
    return {
      kind,
      available: Boolean(command?.available),
      path: command?.path ?? null,
      version: command?.version ?? null,
      execution: 'bounded-process',
      structuredOutput: true,
      continuation: kind === 'codex' ? 'native-thread-id' : 'native-conversation-id',
      ...(kind === 'codex' ? { fixedPolicy: { model: CODEX_MODEL, effort: CODEX_EFFORT } } : {}),
    };
  });
  const tmux = byName.get('tmux');
  return {
    runtime: {
      kind: 'bounded-process',
      semanticAuthority: 'process-exit-and-structured-output',
      persistentAgentState: false,
    },
    harnesses,
    interactiveFallback: {
      kind: 'tmux',
      available: Boolean(tmux?.available),
      path: tmux?.path ?? null,
      version: tmux?.version ?? null,
      semanticStateInference: false,
    },
  };
}

export async function agentRun(
  {
    harness,
    cwd,
    task,
    skills = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  },
  signal,
) {
  await assertDirectory(cwd);
  signal?.throwIfAborted?.();

  const [command] = await inspectCommands([harness]);
  if (!command?.available || !command.path) {
    const error = new Error(`Coding harness is unavailable: ${harness}`);
    error.code = 'harness_unavailable';
    throw error;
  }

  const prompt = taskWithSkills(task, skills);
  const invocation = invocationFor(harness, prompt, timeoutMs);
  const startedAt = new Date().toISOString();

  return await new Promise((resolve, reject) => {
    const child = spawn(command.path, invocation.args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });

    const finish = (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);

      const stdoutText = stdout.toString('utf8');
      const stderrText = stderr.toString('utf8');
      const parsed = parseJsonLines(stdoutText);
      const continuationId = parsed.events.map(deepContinuationId).find(Boolean) ?? null;
      const emptySuccess = code === 0 && stdoutText.trim().length === 0;
      const status = cancelled
        ? 'cancelled'
        : timedOut
          ? 'timed_out'
          : code === 0 && !emptySuccess
            ? 'completed'
            : code === 0
              ? 'ambiguous'
              : 'failed';

      resolve({
        harness,
        status,
        exitCode: code,
        signal: exitSignal,
        startedAt,
        finishedAt: new Date().toISOString(),
        timeoutMs,
        continuationId,
        policy: invocation.policy,
        stdout: stdoutText,
        stderr: stderrText,
        structured: {
          format: invocation.output,
          events: parsed.events,
          invalidLines: parsed.invalidLines,
        },
        outputTruncated: stdout.length >= MAX_CAPTURE_BYTES || stderr.length >= MAX_CAPTURE_BYTES,
      });
    };

    const terminate = (reason) => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'cancel') cancelled = true;
      killProcessGroup(child, 'SIGTERM');
      setTimeout(() => {
        if (!settled) killProcessGroup(child, 'SIGKILL');
      }, 2_000).unref();
    };

    const onAbort = () => terminate('cancel');
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    timer.unref();

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(error);
    });
    child.once('close', finish);
  });
}
