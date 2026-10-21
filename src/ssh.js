import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveConfigPath } from './config-path.js';
import { ExecOutputCapture } from './exec-output.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const TARGET_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/;
const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/;
// SCP uses SFTP in modern OpenSSH; restrict remote paths so they are also
// unambiguous/safe if a remote implementation interprets them as shell text.
const REMOTE_PATH = /^\/[A-Za-z0-9_./@+=,-]+$/;

export class SshConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SshConfigError';
  }
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SshConfigError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new SshConfigError(`Unknown ${label} property: ${key}`);
  }
}

function requiredString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new SshConfigError(`Invalid ${label}.`);
  }
  return value;
}

function absoluteFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) {
    throw new SshConfigError(`${label} must be an absolute filesystem path.`);
  }
  return value;
}

export function validateSshConfig(raw) {
  object(raw, 'SSH config');
  exactKeys(raw, ['version', 'hosts', 'identities'], 'SSH config');
  if (raw.version !== 1) throw new SshConfigError('SSH config version must be 1.');
  const identities = object(raw.identities ?? {}, 'identities');
  for (const [name, identity] of Object.entries(identities)) {
    requiredString(name, 'identity name', TARGET_NAME);
    object(identity, `identity ${name}`);
    exactKeys(identity, ['type', 'path'], `identity ${name}`);
    if (identity.type !== 'agent' && identity.type !== 'file') {
      throw new SshConfigError(`identity ${name} type must be agent or file.`);
    }
    if (identity.type === 'file') absoluteFile(identity.path, `identity ${name} path`);
    if (identity.type === 'agent' && identity.path !== undefined) {
      throw new SshConfigError(`identity ${name} of type agent must not have a path.`);
    }
  }
  const hosts = object(raw.hosts, 'hosts');
  for (const [name, host] of Object.entries(hosts)) {
    requiredString(name, 'target name', TARGET_NAME);
    object(host, `host ${name}`);
    exactKeys(host, ['host', 'user', 'port', 'identity', 'knownHostsFile'], `host ${name}`);
    requiredString(host.host, `host ${name} hostname`, HOST_NAME);
    requiredString(host.user, `host ${name} user`, USER_NAME);
    if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) {
      throw new SshConfigError(`host ${name} port must be 1..65535.`);
    }
    const identity = host.identity ?? 'default';
    requiredString(identity, `host ${name} identity`, TARGET_NAME);
    if (identity !== 'default' && !Object.hasOwn(identities, identity)) {
      throw new SshConfigError(`host ${name} uses unknown identity ${identity}.`);
    }
    if (host.knownHostsFile !== undefined) {
      absoluteFile(host.knownHostsFile, `host ${name} knownHostsFile`);
      if (/\s/.test(host.knownHostsFile)) throw new SshConfigError(`host ${name} knownHostsFile must not contain whitespace.`);
    }
  }
  return raw;
}

export async function loadSshConfig({ env = process.env, configPath } = {}) {
  const filename = await resolveConfigPath({
    filename: 'ssh.json',
    envName: 'AGENT_MCP_SSH_CONFIG',
    explicitPath: configPath,
    env,
  });
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SshConfigError(`Invalid JSON in SSH config ${filename}`, { cause: error });
    throw error;
  }
  return validateSshConfig(raw);
}

function targetFromConfig(config, name) {
  if (!Object.hasOwn(config.hosts, name)) throw new SshConfigError(`Unknown SSH target: ${name}`);
  return config.hosts[name];
}

function identityFromConfig(config, target) {
  const name = target.identity ?? 'default';
  return config.identities[name] ?? { type: 'agent' };
}

function knownHostsFile(target, env) {
  const filename = target.knownHostsFile ?? path.join(env.HOME || os.homedir(), '.ssh', 'known_hosts');
  // OpenSSH can parse spaces in UserKnownHostsFile as multiple locations.
  if (/\s/.test(filename)) throw new SshConfigError('knownHostsFile must not contain whitespace.');
  return filename;
}

export function sshTargets(config) {
  return Object.entries(config.hosts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, target]) => ({
      name,
      host: target.host,
      user: target.user,
      port: target.port ?? 22,
      operations: ['exec', 'upload', 'download'],
    }));
}

function connectionOptions(config, target, env) {
  const identity = identityFromConfig(config, target);
  const opts = [
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHostsFile(target, env)}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'UpdateHostKeys=no',
    '-o', 'CanonicalizeHostname=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ProxyCommand=none',
    '-o', 'ProxyJump=none',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'Tunnel=no',
    '-o', 'ControlMaster=no',
    '-o', 'PasswordAuthentication=no',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'GSSAPIAuthentication=no',
    '-o', 'HostbasedAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1',
    '-o', 'LogLevel=ERROR',
  ];
  if (identity.type === 'file') {
    opts.push('-o', 'IdentitiesOnly=yes', '-i', identity.path);
  } else {
    // Agent identities are allowed, but implicit ~/.ssh/id_* files are not.
    // With IdentitiesOnly=no (the OpenSSH default), IdentityFile=none keeps
    // public-key authentication restricted to identities offered by the agent.
    opts.push('-o', 'IdentityFile=none');
  }
  return opts;
}

function assertRemotePath(remotePath) {
  if (typeof remotePath !== 'string' || !REMOTE_PATH.test(remotePath) ||
      remotePath.split('/').includes('..') || remotePath.split('/').includes('.')) {
    throw new SshConfigError('remotePath must be an absolute path without shell metacharacters or traversal.');
  }
  return remotePath;
}

function assertLocalPath(localPath) {
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || localPath.includes('\0') || localPath.includes('\n')) {
    throw new SshConfigError('localPath must be an absolute filesystem path.');
  }
  return localPath;
}

function killGroup(child, signal) {
  if (child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* Process has exited. */ }
  }
  try { child.kill(signal); } catch { /* Process has exited. */ }
}

function defaultAuditPath(env) {
  const home = env.HOME || os.homedir();
  const state = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(state, 'agent-vm-mcp', 'ssh-audit.jsonl');
}

async function appendAudit(entry, auditPath) {
  await fs.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  const handle = await fs.open(auditPath, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(entry)}\n`);
  } finally {
    await handle.close();
  }
}

async function executeTransport({ program, argv, timeoutMs, signal, artifactStore, source, env }) {
  const started = Date.now();
  // Do not spawn a remote command for a request already cancelled by its caller.
  if (signal?.aborted) {
    return {
      exitCode: null, signal: null, timedOut: false, cancelled: true, durationMs: 0,
      stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
      stdoutTruncated: false, stderrTruncated: false,
      stdoutArtifact: null, stderrArtifact: null, errorCode: null,
    };
  }
  const child = spawn(program, argv, {
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutCapture = new ExecOutputCapture({ artifactStore });
  const stderrCapture = new ExecOutputCapture({ artifactStore });
  let timedOut = false;
  let cancelled = false;
  let spawnError = null;
  let settled = false;
  let killTimer = null;
  const terminate = (reason) => {
    if (settled || timedOut || cancelled) return;
    timedOut = reason === 'timeout';
    cancelled = reason === 'cancelled';
    killGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => {
      if (!settled) killGroup(child, 'SIGKILL');
    }, 2_000);
    killTimer.unref();
  };
  const onAbort = () => terminate('cancelled');
  const timer = setTimeout(() => terminate('timeout'), timeoutMs);
  if (signal?.aborted) terminate('cancelled');
  else signal?.addEventListener('abort', onAbort, { once: true });
  const closed = new Promise((resolve) => {
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (exitCode, exitSignal) => {
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, signal: exitSignal });
    });
  });
  const drain = (capture, readable) => capture.consume(readable).catch((error) => {
    killGroup(child, 'SIGKILL');
    throw error;
  });
  const stdoutDrain = drain(stdoutCapture, child.stdout);
  const stderrDrain = drain(stderrCapture, child.stderr);
  try {
    const [{ exitCode, signal: exitSignal }] = await Promise.all([closed, stdoutDrain, stderrDrain]);
    const publishArtifact = !cancelled && !signal?.aborted;
    const id = randomUUID();
    const [stdout, stderr] = await Promise.all([
      stdoutCapture.finalize({ name: `ssh-${id}-stdout.log`, source: `${source}.stdout`, publishArtifact }),
      stderrCapture.finalize({ name: `ssh-${id}-stderr.log`, source: `${source}.stderr`, publishArtifact }),
    ]);
    const summary = (capture) => capture.artifact ? {
      ...capture.artifact,
      truncated: capture.artifactTruncated,
      observedBytes: capture.observedBytes,
      capturedBytes: capture.artifact.size,
      hardLimitBytes: artifactStore.maxBytes,
    } : null;
    return {
      exitCode, signal: exitSignal, timedOut, cancelled,
      durationMs: Date.now() - started,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: stdout.observedBytes, stderrBytes: stderr.observedBytes,
      stdoutTruncated: stdout.inlineTruncated, stderrTruncated: stderr.inlineTruncated,
      stdoutArtifact: summary(stdout), stderrArtifact: summary(stderr),
      errorCode: spawnError?.code ?? null,
      ...(spawnError ? { error: `SSH transport could not start: ${spawnError.code || 'unknown error'}` } : {}),
    };
  } catch (error) {
    killGroup(child, 'SIGKILL');
    await Promise.allSettled([closed, stdoutDrain, stderrDrain]);
    await Promise.allSettled([stdoutCapture.discard(), stderrCapture.discard()]);
    throw error;
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** SSH calls are request-scoped and non-interactive. Audit is written before and after execution. */
export async function runSshOperation(config, args, {
  artifactStore, signal, env = process.env,
  auditPath = defaultAuditPath(env),
  sshBinary = 'ssh', scpBinary = 'scp',
} = {}) {
  if (!artifactStore) throw new TypeError('runSshOperation requires an artifactStore.');
  const { operation, target: name } = args;
  const target = targetFromConfig(config, name);
  const identity = identityFromConfig(config, target);
  const remote = target.host;
  const port = target.port ?? 22;
  let program;
  let argv;
  let commandSha256;
  const common = connectionOptions(config, target, env);
  if (operation === 'exec') {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0')) {
      throw new SshConfigError('command must be a non-empty string without NUL.');
    }
    commandSha256 = createHash('sha256').update(args.command).digest('hex');
    program = sshBinary;
    argv = [...common, '-T', '-n', '-p', String(port), '-l', target.user, remote, args.command];
  } else if (operation === 'upload' || operation === 'download') {
    const local = assertLocalPath(args.localPath);
    const remotePath = assertRemotePath(args.remotePath);
    if (operation === 'upload') {
      const stat = await fs.stat(local);
      if (!stat.isFile()) throw new SshConfigError('Upload source must be a regular file.');
    }
    program = scpBinary;
    const scpHost = remote.includes(':') ? `[${remote}]` : remote;
    const destination = `${target.user}@${scpHost}:${remotePath}`;
    argv = [...common, '-B', '-P', String(port), '--', ...(operation === 'upload'
      ? [local, destination]
      : [destination, local])];
  } else {
    throw new SshConfigError(`Unsupported SSH operation: ${operation}`);
  }
  // Resolve referenced credential material before recording or starting a remote attempt.
  if (identity.type === 'file') await fs.access(identity.path);
  const knownHosts = knownHostsFile(target, env);
  await fs.access(knownHosts);
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new SshConfigError('timeoutMs must be between 1000 and 600000.');
  }
  const id = randomUUID();
  const base = { id, target: name, operation, ...(commandSha256 ? { commandSha256 } : {}) };
  await appendAudit({ ...base, phase: 'started', at: new Date().toISOString() }, auditPath);
  let outcome;
  try {
    outcome = await executeTransport({
      program, argv, timeoutMs, signal, artifactStore, source: `ssh.${operation}`, env,
    });
  } catch (error) {
    try {
      await appendAudit({
        ...base, phase: 'failed', at: new Date().toISOString(), errorCode: error.code ?? 'internal_error',
      }, auditPath);
    } catch (auditError) {
      // Preserve the original execution failure rather than masking it with
      // a secondary audit failure.
      error.auditErrorCode = auditError.code ?? 'audit_write_failed';
    }
    throw error;
  }

  try {
    await appendAudit({
      ...base, phase: 'finished', at: new Date().toISOString(),
      exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut,
      cancelled: outcome.cancelled, errorCode: outcome.errorCode,
      durationMs: outcome.durationMs,
    }, auditPath);
  } catch (error) {
    // The remote side effect may already have happened. Return its real result
    // with an explicit audit warning so the caller does not blindly retry.
    return {
      id, target: name, operation, ...outcome,
      auditStatus: 'completion_write_failed',
      auditErrorCode: error.code ?? 'audit_write_failed',
    };
  }
  return { id, target: name, operation, ...outcome, auditStatus: 'complete' };
}
