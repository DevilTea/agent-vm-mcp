import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { ArtifactStore } from '../src/artifacts/artifact-store.js';
import { loadSshConfig, runSshOperation, sshTargets, validateSshConfig } from '../src/ssh.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-ssh-smoke-'));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = path.join(root, 'ssh-audit.jsonl');
const knownHosts = path.join(root, 'known_hosts');
const keyFile = path.join(root, 'keyfile');
const sshPath = path.join(root, 'ssh');
const scpPath = path.join(root, 'scp');
const trace = path.join(root, 'argv.log');
const payload = path.join(root, 'test payload.txt');
const configPath = path.join(root, 'ssh.json');
const source = await fs.readFile(path.join(projectRoot, 'config/ssh.json'), 'utf8');
assert.deepEqual(sshTargets(validateSshConfig(JSON.parse(source))), []);
const config = {
  version: 1,
  identities: { local: { type: 'file', path: keyFile }, session: { type: 'agent' } },
  hosts: {
    nas: { host: '192.0.2.11', user: 'backup', port: 2200, identity: 'local', knownHostsFile: knownHosts },
    vm: { host: 'example.invalid', user: 'agent', identity: 'session', knownHostsFile: knownHosts },
  },
};
let transport;
let client;
const store = new ArtifactStore({ ownedRoot: path.join(root, 'artifacts') });
try {
  await fs.writeFile(knownHosts, 'fixture known hosts\n');
  await fs.writeFile(keyFile, 'not-a-real-key\n', { mode: 0o600 });
  await fs.writeFile(payload, 'file contents\n');
  await fs.writeFile(configPath, JSON.stringify(config));
  // A deterministic child-process fixture: stdout echoes the remote command and
  // arguments are recorded without involving SSH credentials or the network.
  const fixture = `#!/bin/sh
printf '%s\\n' '--CALL--' "$@" >> "$SSH_FIXTURE_TRACE"
if [ "$1" = "force_error" ]; then exit 14; fi
for arg do
  if [ "$arg" = "slow" ]; then sleep 3; fi
  if [ "$arg" = "emit-error" ]; then echo "remote refused" >&2; exit 7; fi
  if [ "$arg" = "audit-fail" ]; then chmod 400 "$SSH_FIXTURE_AUDIT"; fi
done
echo "fixture stdout"
exit 0
`;
  for (const binary of [sshPath, scpPath]) {
    await fs.writeFile(binary, fixture, { mode: 0o755 });
  }

  assert.deepEqual(sshTargets(config).map(({ name }) => name), ['nas', 'vm']);
  for (const invalid of [
    { ...config, version: 2 },
    { ...config, hosts: { x: { ...config.hosts.nas, host: '-oProxyCommand=evil' } } },
    { ...config, hosts: { x: { ...config.hosts.nas, identity: 'missing' } } },
    { ...config, hosts: { x: { ...config.hosts.nas, port: 100000 } } },
    { ...config, hosts: { x: { ...config.hosts.nas, privateKey: 'secret' } } },
    { ...config, hosts: { x: { ...config.hosts.nas, knownHostsFile: '/tmp/with spaces/known_hosts' } } },
    { ...config, identities: { local: { type: 'file', path: 'relative-key' } } },
  ]) assert.throws(() => validateSshConfig(invalid));

  assert.deepEqual(await loadSshConfig({ configPath }), config);
  const defaultKeyConfig = validateSshConfig({ ...config, identities: { ...config.identities, default: { type: 'file', path: keyFile } }, hosts: { defaulted: { host: 'localhost', user: 'agent', knownHostsFile: knownHosts } } });
  assert.equal(sshTargets(defaultKeyConfig)[0].name, 'defaulted');
  await assert.rejects(() => loadSshConfig({ configPath: path.join(root, 'missing') }), { code: 'ENOENT' });
  await assert.rejects(() => runSshOperation(config, { operation: 'exec', target: 'unlisted', command: 'date' },
    { artifactStore: store }), /Unknown SSH target/);
  const env = { ...process.env, HOME: root, SSH_FIXTURE_TRACE: trace, SSH_FIXTURE_AUDIT: log };
  const exec = (operation, args) => runSshOperation(config,
    { operation, target: 'nas', ...args }, {
      artifactStore: store, env, auditPath: log, sshBinary: sshPath, scpBinary: scpPath,
    });
  const secretCommand = 'echo secret=DO_NOT_PERSIST';
  const result = await exec('exec', { command: secretCommand });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.auditStatus, 'complete');
  assert.match(result.stdout, /fixture stdout/);
  const traceText = await fs.readFile(trace, 'utf8');
  for (const mandatory of [
    'StrictHostKeyChecking=yes', 'UserKnownHostsFile=' + knownHosts,
    'BatchMode=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes',
    'PasswordAuthentication=no', 'IdentitiesOnly=yes', keyFile,
    '-T', '-n', '-l', 'backup', '-p', '2200', '192.0.2.11', secretCommand,
  ]) assert.ok(traceText.includes(mandatory), mandatory);
  assert.ok(!traceText.includes('StrictHostKeyChecking=no'));

  const traceBeforeAgent = await fs.readFile(trace, 'utf8');
  const agentResult = await runSshOperation(config, {
    operation: 'exec', target: 'vm', command: 'agent-only',
  }, {
    artifactStore: store, env, auditPath: path.join(root, 'agent-audit.jsonl'), sshBinary: sshPath,
  });
  assert.equal(agentResult.exitCode, 0);
  const agentInvocation = (await fs.readFile(trace, 'utf8')).slice(traceBeforeAgent.length);
  assert.ok(agentInvocation.includes('IdentityFile=none'), 'agent identity must suppress implicit ~/.ssh/id_* keys');
  assert.ok(!agentInvocation.includes('IdentitiesOnly=yes'), 'agent identity must remain able to offer agent keys');

  const traceBeforeMissingStore = await fs.readFile(trace, 'utf8');
  await assert.rejects(runSshOperation(config, {
    operation: 'exec', target: 'nas', command: 'must-not-spawn-without-store',
  }, {
    env, auditPath: path.join(root, 'missing-store-audit.jsonl'), sshBinary: sshPath,
  }), /requires an artifactStore/);
  assert.equal(await fs.readFile(trace, 'utf8'), traceBeforeMissingStore, 'Missing artifact store must fail before spawn');

  const failure = await exec('exec', { command: 'emit-error' });
  assert.equal(failure.exitCode, 7);
  assert.match(failure.stderr, /remote refused/);
  const timed = await exec('exec', { command: 'slow', timeoutMs: 1_000 });
  assert.equal(timed.timedOut, true);
  assert.notEqual(timed.exitCode, 0);
  const controller = new AbortController();
  const cancelledCall = runSshOperation(config, { operation: 'exec', target: 'nas', command: 'slow' }, {
    artifactStore: store, env, auditPath: log, sshBinary: sshPath, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  const cancelled = await cancelledCall;
  assert.equal(cancelled.cancelled, true);
  const preAborted = new AbortController();
  preAborted.abort();
  const traceBefore = await fs.readFile(trace, 'utf8');
  const noSpawn = await runSshOperation(config, { operation: 'exec', target: 'nas', command: 'must-not-start' }, {
    artifactStore: store, env, auditPath: log, sshBinary: sshPath, signal: preAborted.signal,
  });
  assert.equal(noSpawn.cancelled, true);
  assert.equal(noSpawn.exitCode, null);
  assert.equal(await fs.readFile(trace, 'utf8'), traceBefore, 'Pre-aborted operation must not spawn ssh');

  const uploaded = await exec('upload', { localPath: payload, remotePath: '/var/tmp/archive.bin' });
  assert.equal(uploaded.exitCode, 0);
  const downloaded = await exec('download', { localPath: path.join(root, 'local.txt'), remotePath: '/var/tmp/archive.bin' });
  assert.equal(downloaded.exitCode, 0);
  const argumentsText = await fs.readFile(trace, 'utf8');
  assert.match(argumentsText, /backup@192\.0\.2\.11:\/var\/tmp\/archive\.bin/);
  assert.match(argumentsText, /-P\n2200/);
  for (const remotePath of ['relative', '/../../etc/passwd', '/tmp/file name', '/tmp/x;id', '/tmp/*']) {
    await assert.rejects(exec('upload', { localPath: payload, remotePath }), /remotePath/);
  }
  await assert.rejects(exec('upload', { localPath: path.join(root, 'absent'), remotePath: '/a' }), { code: 'ENOENT' });
  await assert.rejects(exec('download', { localPath: '../relative', remotePath: '/a' }), /localPath/);

  const audit = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 14);
  assert.equal(audit[0].phase, 'started');
  assert.equal(audit[1].phase, 'finished');
  assert.equal(audit[0].commandSha256, createHash('sha256').update(secretCommand).digest('hex'));
  assert.equal(audit[3].exitCode, 7);
  assert.equal(audit[5].timedOut, true);
  assert.equal(audit[5].signal, 'SIGTERM');
  assert.equal(audit[7].cancelled, true);
  assert.equal(audit[7].signal, 'SIGTERM');
  assert.equal(audit[9].cancelled, true);
  assert.equal(audit[9].signal, null);
  assert.ok(!(await fs.readFile(log, 'utf8')).includes('DO_NOT_PERSIST'));
  assert.equal((await fs.stat(log)).mode & 0o777, 0o600);

  // A failed completion audit must not conceal a successful remote side effect.
  const auditFailure = await exec('exec', { command: 'audit-fail' });
  assert.equal(auditFailure.exitCode, 0);
  assert.equal(auditFailure.auditStatus, 'completion_write_failed');
  assert.equal(auditFailure.auditErrorCode, 'EACCES');
  await fs.chmod(log, 0o600);

  // Failure to record the initial audit event must fail closed before spawn.
  const beforePreflight = await fs.readFile(trace, 'utf8');
  await fs.writeFile(path.join(root, 'audit-parent-blocker'), 'not a directory');
  await assert.rejects(runSshOperation(config, {
    operation: 'exec', target: 'nas', command: 'should-never-run',
  }, {
    artifactStore: store, env, auditPath: path.join(root, 'audit-parent-blocker', 'audit.jsonl'),
    sshBinary: sshPath,
  }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(trace, 'utf8'), beforePreflight);

  // Validate the real MCP tool catalog and its argument-to-handler integration.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'src/index.js')],
    cwd: projectRoot,
    stderr: 'pipe',
    env: {
      ...env, PATH: `${root}:${process.env.PATH}`, AGENT_MCP_SSH_CONFIG: configPath,
      XDG_STATE_HOME: path.join(root, 'state'),
      MCP_BRIDGES_CONFIG: path.join(projectRoot, 'config/bridges.json'),
    },
  });
  client = new Client({ name: 'ssh-smoke', version: '1.0.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  for (const tool of ['ssh_targets', 'ssh_exec', 'ssh_upload', 'ssh_download']) {
    assert.ok(tools.some(({ name }) => name === tool), tool);
  }
  const execTool = tools.find(({ name }) => name === 'ssh_exec');
  const uploadTool = tools.find(({ name }) => name === 'ssh_upload');
  const downloadTool = tools.find(({ name }) => name === 'ssh_download');
  for (const tool of [execTool, uploadTool, downloadTool]) {
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, true);
    assert.equal(tool.annotations?.idempotentHint, false);
    assert.equal(tool.annotations?.openWorldHint, true);
  }
  const toolResponse = await client.callTool({ name: 'ssh_targets', arguments: {} });
  const targets = JSON.parse(toolResponse.content[0].text).targets;
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map(({ name }) => name), ['nas', 'vm']);
  assert.ok(!JSON.stringify(targets).includes(keyFile));
  const execResponse = await client.callTool({ name: 'ssh_exec', arguments: { target: 'nas', command: 'uname -s' } });
  assert.equal(JSON.parse(execResponse.content[0].text).exitCode, 0);
  const rejected = await client.callTool({ name: 'ssh_exec', arguments: { target: 'arbitrary', command: 'id' } });
  assert.equal(rejected.isError, true);
  assert.ok(!(await fs.readFile(path.join(root, 'state/agent-vm-mcp/ssh-audit.jsonl'), 'utf8')).includes('uname -s'));
  console.log('PASS first-class SSH config/exec/transfers/audit/MCP');
} finally {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  await store.close();
  await fs.rm(root, { recursive: true, force: true });
}
