import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { openStore, processStartTicks } from './store.js';

function continuationId(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.thread_id === 'string') return value.thread_id;
  if (typeof value.conversation_id === 'string') return value.conversation_id;
  for (const part of Object.values(value)) {
    const found = continuationId(part);
    if (found) return found;
  }
  return null;
}

function invocation(job) {
  const task = JSON.parse(job.skills).length
    ? 'Use the following installed skills for this task: ' +
      JSON.parse(job.skills).join(', ') +
      '. Read and follow each skill SKILL.md before acting.\n\n' + job.task
    : job.task;
  if (job.harness === 'codex') {
    const policy = JSON.parse(job.policy_json);
    if (!policy || typeof policy.model !== 'string' || typeof policy.effort !== 'string') {
      throw new Error('Missing persisted Codex policy for job ' + job.id);
    }
    return {
      command: process.env.AGENT_JOB_CODEX_BIN || 'codex',
      args: ['exec', '--json', '--model', policy.model,
        '--config', 'model_reasoning_effort="' + policy.effort + '"', task],
    };
  }
  if (job.harness === 'agy') {
    return {
      command: process.env.AGENT_JOB_AGY_BIN || 'agy',
      args: ['--dangerously-skip-permissions', '-p', task, '--output-format', 'stream-json',
        '--print-timeout', Math.ceil(job.timeout_ms / 1000) + 's'],
    };
  }
  throw new Error('Unsupported harness: ' + job.harness);
}

function classifyAgyResult(event) {
  if (!event) return { status: 'ambiguous', reason: 'agy_missing_terminal_result' };
  const result = event.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { status: 'ambiguous', reason: 'agy_malformed_terminal_result' };
  }
  if (result.status === 'ERROR') return { status: 'failed', reason: 'agy_result_error' };
  if (result.status !== 'SUCCESS' || !Array.isArray(result.denied_actions)) {
    return { status: 'ambiguous', reason: 'agy_malformed_terminal_result' };
  }
  if (result.denied_actions.length > 0) {
    return { status: 'failed', reason: 'agy_denied_actions' };
  }
  return { status: 'completed', reason: null };
}

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error('Missing job ID');
  const store = openStore();
  let job = store.get(id);
  if (!job) throw new Error('Unknown job ID');
  // The manager commits the worker PID before this worker starts the harness.
  for (let attempt = 0; job.status === 'queued' && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = store.get(id);
  }
  if (job.status !== 'running' || job.pid !== process.pid) {
    store.close();
    throw new Error('Worker launch was not committed');
  }

  const stdout = await fs.open(job.output_dir + '/stdout.log', 'a', 0o600);
  const stderr = await fs.open(job.output_dir + '/stderr.log', 'a', 0o600);
  const events = await fs.open(job.output_dir + '/events.jsonl', 'a', 0o600);
  const invalid = await fs.open(job.output_dir + '/invalid.jsonl', 'a', 0o600);
  let reason = null;
  let child = null;
  let killTimer = null;
  let lastActivity = 0;
  let currentContinuationId = null;
  let stdoutBytes = 0;
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  let agyTerminalEvent = null;

  function reportOutput() {
    const now = Date.now();
    if (now - lastActivity >= 750) {
      store.markOutput(id, currentContinuationId);
      lastActivity = now;
    }
  }

  async function parseLines(text, flush = false) {
    remainder += text;
    const lines = remainder.split(/\r?\n/);
    remainder = flush ? '' : lines.pop() || '';
    if (flush && remainder) lines.push(remainder);
    if (!flush && remainder.length > 2 * 1024 * 1024) {
      lines.push(remainder);
      remainder = '';
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        currentContinuationId ||= continuationId(event);
        if (job.harness === 'agy' && event && typeof event === 'object' &&
            event.event === 'result') {
          agyTerminalEvent = event;
        }
        await events.write(JSON.stringify(event) + '\n');
      } catch {
        await invalid.write(JSON.stringify(line) + '\n');
      }
    }
  }

  function terminate(terminationReason) {
    if (reason !== null) return;
    reason = terminationReason;
    if (child && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      killTimer = setTimeout(() => {
        if (child && child.exitCode === null) {
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }
      }, 2000);
      killTimer.unref();
    }
  }

  process.on('SIGTERM', () => { const current = store.get(id); terminate(current?.cancel_requested ? 'cancel' : current?.termination_reason === 'timeout' ? 'timeout' : 'interrupted'); });
  process.on('SIGINT', () => { const current = store.get(id); terminate(current?.cancel_requested ? 'cancel' : current?.termination_reason === 'timeout' ? 'timeout' : 'interrupted'); });

  const timeout = setTimeout(() => terminate('timeout'), job.timeout_ms);
  timeout.unref();
  let exitCode = null;
  let exitSignal = null;
  let spawnError = null;

  try {
    const command = invocation(job);
    if (reason !== null || store.get(id)?.cancel_requested) {
      throw new Error('Worker was cancelled before harness startup');
    }
    child = spawn(command.command, command.args, {
      cwd: job.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('spawn', () => {
      const ticks = processStartTicks(child.pid);
      if (ticks) store.markChild(id, child.pid, ticks);
    });
    if (reason !== null || store.get(id)?.cancel_requested) terminate(reason || 'cancel');
    const stdoutTask = (async () => {
      for await (const chunk of child.stdout) {
        stdoutBytes += chunk.length;
        await stdout.write(chunk);
        await parseLines(decoder.write(chunk));
        reportOutput();
      }
      await parseLines(decoder.end(), true);
    })();
    const stderrTask = (async () => {
      for await (const chunk of child.stderr) {
        await stderr.write(chunk);
        reportOutput();
      }
    })();
    const result = await new Promise((resolve) => {
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    exitCode = result.code;
    exitSignal = result.signal;
    await Promise.all([stdoutTask, stderrTask]);
    if (spawnError) await stderr.write('\n' + (spawnError.stack || spawnError.message) + '\n');
  } catch (error) {
    spawnError = error;
    await stderr.write('\n' + (error.stack || error.message) + '\n');
  } finally {
    clearTimeout(timeout);
    clearTimeout(killTimer);
    // Close all output files before publishing a terminal status.
    await Promise.all([stdout.close(), stderr.close(), events.close(), invalid.close()]);
    reportOutput();
    const requestedCancel = Boolean(store.get(id)?.cancel_requested);
    const agyClassification = job.harness === 'agy' && !spawnError && exitCode === 0
      ? classifyAgyResult(agyTerminalEvent) : null;
    const status = requestedCancel || reason === 'cancel' ? 'cancelled' :
      reason === 'timeout' ? 'timed_out' :
      reason === 'interrupted' ? 'interrupted' :
      spawnError || exitCode !== 0 ? 'failed' :
      job.harness === 'agy' ? agyClassification.status :
      stdoutBytes === 0 ? 'ambiguous' : 'completed';
    const agyReason = job.harness !== 'agy' ? null :
      spawnError ? 'agy_spawn_error' :
      exitCode === null ? 'agy_exit_signal' :
      exitCode !== 0 ? 'agy_nonzero_exit' :
      agyClassification?.reason || null;
    store.finish(id, status, {
      exitCode,
      signal: exitSignal,
      reason: requestedCancel ? 'cancel' : reason || agyReason,
      continuationId: currentContinuationId,
    });
    store.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
