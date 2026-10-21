import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ArtifactStore } from '../src/artifacts/artifact-store.js';
import { runSshOperation, validateSshConfig } from '../src/ssh.js';

const execAsync = promisify(execFile);
const sshd = '/usr/sbin/sshd';
const sftp = '/usr/lib/openssh/sftp-server';
try {
  await Promise.all([fs.access(sshd), fs.access(sftp)]);
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log('SKIP OpenSSH loopback integration: sshd or sftp-server unavailable');
    process.exit(0);
  }
  throw error;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-ssh-real-'));
let child;
let agentChild;
const store = new ArtifactStore({ ownedRoot: path.join(root, 'artifacts') });
let serverStderr = '';
try {
  const key = path.join(root, 'identity');
  const hostKey = path.join(root, 'hostkey');
  await execAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  await execAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const knownHosts = path.join(root, 'known_hosts');
  const keyFields = (await fs.readFile(hostKey + '.pub', 'utf8')).trim().split(' ');
  await fs.writeFile(knownHosts, `[127.0.0.1]:${port} ${keyFields[0]} ${keyFields[1]}\n`);
  const sshdConfig = path.join(root, 'sshd_config');
  await fs.writeFile(sshdConfig, [
    'ListenAddress 127.0.0.1',
    `Port ${port}`,
    `HostKey ${hostKey}`,
    `AuthorizedKeysFile ${key}.pub`,
    `PidFile ${root}/sshd.pid`,
    'StrictModes no',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'UsePAM no',
    'PermitTTY no',
    'AllowTcpForwarding no',
    'AllowAgentForwarding no',
    `AllowUsers ${os.userInfo().username}`,
    `Subsystem sftp ${sftp}`,
    'LogLevel ERROR',
  ].join('\n') + '\n');
  child = spawn(sshd, ['-D', '-e', '-f', sshdConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => { serverStderr += chunk.toString('utf8').slice(0, 1024); });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) break;
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (connected) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Temporary loopback sshd failed to start: ${serverStderr}`);
  const config = validateSshConfig({
    version: 1,
    identities: { temporary: { type: 'file', path: key } },
    hosts: {
      local: {
        host: '127.0.0.1',
        user: os.userInfo().username,
        port,
        identity: 'temporary',
        knownHostsFile: knownHosts,
      },
    },
  });
  const args = { artifactStore: store, auditPath: path.join(root, 'audit.jsonl') };
  const remote = (operation, input) => runSshOperation(config, { target: 'local', operation, ...input }, args);
  const exec = await remote('exec', { command: "printf 'ssh-integration-ok\\n'" });
  assert.equal(exec.exitCode, 0, `SSH failed: ${exec.stderr}`);
  assert.equal(exec.stdout.trim(), 'ssh-integration-ok');

  const agentSocket = path.join(root, 'agent.sock');
  agentChild = spawn('ssh-agent', ['-D', '-a', agentSocket], { stdio: ['ignore', 'ignore', 'pipe'] });
  let agentReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (agentChild.exitCode !== null) break;
    try {
      await fs.stat(agentSocket);
      agentReady = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(agentReady, 'Temporary ssh-agent failed to start');
  const agentEnv = { ...process.env, SSH_AUTH_SOCK: agentSocket };
  await execAsync('ssh-add', [key], { env: agentEnv });
  const agentConfig = validateSshConfig({
    version: 1,
    identities: { temporaryAgent: { type: 'agent' } },
    hosts: {
      local: {
        host: '127.0.0.1',
        user: os.userInfo().username,
        port,
        identity: 'temporaryAgent',
        knownHostsFile: knownHosts,
      },
    },
  });
  const agentExec = await runSshOperation(agentConfig, {
    operation: 'exec', target: 'local', command: "printf 'ssh-agent-ok\\n'",
  }, { ...args, env: agentEnv, auditPath: path.join(root, 'agent-audit.jsonl') });
  assert.equal(agentExec.exitCode, 0, `SSH-agent auth failed: ${agentExec.stderr}`);
  assert.equal(agentExec.stdout.trim(), 'ssh-agent-ok');
  const src = path.join(root, 'source.txt');
  const dst = path.join(root, 'downloaded.txt');
  const remotePath = path.join(root, 'remote.txt');
  await fs.writeFile(src, 'round-trip verified\n');
  const upload = await remote('upload', { localPath: src, remotePath });
  assert.equal(upload.exitCode, 0, `SFTP upload failed: ${upload.stderr}`);
  assert.equal(await fs.readFile(remotePath, 'utf8'), 'round-trip verified\n');
  const download = await remote('download', { localPath: dst, remotePath });
  assert.equal(download.exitCode, 0, `SFTP download failed: ${download.stderr}`);
  assert.equal(await fs.readFile(dst, 'utf8'), 'round-trip verified\n');

  const emptyHosts = path.join(root, 'untrusted_known_hosts');
  await fs.writeFile(emptyHosts, '');
  const badConfig = validateSshConfig({
    ...config, hosts: { local: { ...config.hosts.local, knownHostsFile: emptyHosts } },
  });
  const rejected = await runSshOperation(badConfig, {
    operation: 'exec', target: 'local', command: 'echo should-not-run',
  }, args);
  assert.notEqual(rejected.exitCode, 0, 'Missing known host pin must refuse connection');
  assert.match(rejected.stderr, /Host key verification failed|No ED25519 host key is known/i);
  console.log('PASS real OpenSSH loopback exec/upload/download/host-key rejection');
} finally {
  agentChild?.kill('SIGTERM');
  child?.kill('SIGTERM');
  if (child?.exitCode === null) await new Promise((resolve) => {
    child.once('close', resolve);
    setTimeout(resolve, 2_000).unref();
  });
  await store.close();
  await fs.rm(root, { recursive: true, force: true });
}
