import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { ArtifactStore } from '../src/artifacts/artifact-store.js';
import { catalogIdentityFromTools } from '../src/server-info.js';

const liveIntegrations = process.env.AGENT_VM_SMOKE_LIVE_INTEGRATIONS === '1';
const hostKind = process.env.AGENT_MCP_HOST ?? 'generic';
const node = process.execPath;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(projectRoot, 'src/index.js');
const smokeBridgeConfig = `/tmp/agent-mcp-bridges-smoke-${process.pid}.json`;
const artifactExpiryRoot = `/tmp/agent-mcp-artifact-expiry-${process.pid}`;
const artifactBorrowedPath = `/tmp/agent-mcp-artifact-borrowed-${process.pid}.txt`;
const artifactUtf8Root = `/tmp/agent-mcp-artifact-utf8-${process.pid}`;
const artifactUtf8Path = `/tmp/agent-mcp-artifact-utf8-${process.pid}.txt`;
const artifactOwnedParent = '/tmp/agent-vm-artifacts';
const smokeArtifactMaxBytes = 256 * 1024;
const artifactMetaKey = 'io.deviltea.agent-vm/artifact';
const presentFilePath = '/tmp/agent-mcp-present-file-smoke.txt';
const presentBinaryPath = '/tmp/agent-mcp-present-file-smoke.bin';
const importedFilePath = '/tmp/agent-mcp-import-file-smoke.txt';
const cancelledImportPath = '/tmp/agent-mcp-import-file-cancelled.txt';
const execCancelPidPath = '/tmp/agent-mcp-exec-cancel.pid';
const execCancelMarkerPath = '/tmp/agent-mcp-exec-cancel.marker';
const shutdownProcessPidPath = '/tmp/agent-mcp-shutdown-process.pid';
const filesystemRoot = `/tmp/agent-mcp-filesystem-smoke-${process.pid}`;
const filesystemOutsideRoot = `/tmp/agent-mcp-filesystem-outside-${process.pid}`;
const gitShimDir = `/tmp/agent-mcp-git-shim-${process.pid}`;
const gitValidationTriggerPath = `/tmp/agent-mcp-git-validation-trigger-${process.pid}`;
const gitValidationPidPath = `/tmp/agent-mcp-git-validation-pid-${process.pid}`;
const workspaceRoot = `/tmp/agent-mcp-workspaces-${process.pid}`;
const checkpointStateRoot = `/tmp/agent-mcp-checkpoints-${process.pid}`;
const repositoryRoot = `/tmp/agent-mcp-repositories-${process.pid}`;
const workspaceSeedRoot = `/tmp/agent-mcp-workspace-seed-${process.pid}`;
const workspaceOrigin = `/tmp/agent-mcp-workspace-origin-${process.pid}.git`;
const workspaceCancelOrigin = `/tmp/agent-mcp-workspace-cancel-origin-${process.pid}.git`;
const workspaceConcurrencyTriggerPath = `/tmp/agent-mcp-workspace-concurrency-${process.pid}`;
const workspaceConcurrencyLockDir = `/tmp/agent-mcp-workspace-concurrency-lock-${process.pid}`;
const workspaceConcurrencyOverlapPath = `/tmp/agent-mcp-workspace-concurrency-overlap-${process.pid}`;
const workspaceCrossProcessTriggerPath = `/tmp/agent-mcp-workspace-cross-process-${process.pid}`;
const workspaceCrossProcessAddLogPath = `/tmp/agent-mcp-workspace-cross-process-adds-${process.pid}`;
const workspaceBranchRaceTriggerPath = `/tmp/agent-mcp-workspace-branch-race-${process.pid}`;
const workspaceBranchRaceReleasePath = `/tmp/agent-mcp-workspace-branch-race-release-${process.pid}`;
const workspaceBranchRacePidPath = `/tmp/agent-mcp-workspace-branch-race-pid-${process.pid}`;
const workspaceOwnedBranchTriggerPath = `/tmp/agent-mcp-workspace-owned-branch-${process.pid}`;
const workspaceOwnedBranchReadyPath = `/tmp/agent-mcp-workspace-owned-branch-ready-${process.pid}`;
const workspaceOwnedBranchReleasePath = `/tmp/agent-mcp-workspace-owned-branch-release-${process.pid}`;
const workspaceWorktreeAddTriggerPath = `/tmp/agent-mcp-workspace-add-trigger-${process.pid}`;
const workspaceWorktreeAddPidPath = `/tmp/agent-mcp-workspace-add-pid-${process.pid}`;
const workspaceWorktreeRemoveTriggerPath = `/tmp/agent-mcp-workspace-remove-trigger-${process.pid}`;
const workspaceWorktreeRemovePidPath = `/tmp/agent-mcp-workspace-remove-pid-${process.pid}`;
const workspaceRediscoveryBridgesConfig = `/tmp/agent-mcp-workspace-bridges-${process.pid}.json`;
const lspSmokeRoot = `/tmp/agent-mcp-lsp-smoke-${process.pid}`;
const lspWorkspaceA = path.join(lspSmokeRoot, 'workspace-a');
const lspWorkspaceB = path.join(lspSmokeRoot, 'workspace-b');
const lspDeniedWorkspace = path.join(lspSmokeRoot, 'workspace-denied');
const lspMissingWorkspace = path.join(lspSmokeRoot, 'workspace-missing-server');
const lspDeniedMarker = path.join(lspSmokeRoot, 'repo-config-command-executed.marker');
const lspManagedCacheRoot = path.join(process.env.HOME ?? '/home/agent', '.cache/lsp-mcp/servers');
const importPayload = Buffer.from('file ingress smoke\n', 'utf8');
let importServer;
let clientClosed = false;
const execFileAsync = promisify(execFile);
const client = new Client({ name: 'agent-mcp-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: node,
  args: [serverEntry],
  cwd: projectRoot,
  env: {
    ...process.env,
    PATH: `${gitShimDir}:${process.env.PATH}`,
    MCP_BRIDGES_CONFIG: smokeBridgeConfig,
    AGENT_MCP_CAPABILITIES_CONFIG: path.join(projectRoot, 'config/capabilities.json'),
    AGENT_ARTIFACT_MAX_BYTES: String(smokeArtifactMaxBytes),
    AGENT_WORKSPACE_ROOT: workspaceRoot,
    AGENT_REPOSITORY_ROOT: repositoryRoot,
    AGENT_WORK_CHECKPOINT_STATE_DIR: checkpointStateRoot,
    AGENT_MCP_HOST: hostKind,
  },
  stderr: 'inherit',
});

try {
  const bridgeFixture = liveIntegrations
    ? (await fs.readFile(path.join(projectRoot, 'test/bridges.smoke.json'), 'utf8')).replace(
        '/opt/agent-vm-mcp/test/playwright-start-smoke.sh',
        path.join(projectRoot, 'test/playwright-start-smoke.sh'),
      )
    : '{"version":1,"bridges":[]}\n';
  await fs.writeFile(smokeBridgeConfig, bridgeFixture, 'utf8');

  await fs.rm(artifactExpiryRoot, { recursive: true, force: true });
  await fs.rm(artifactBorrowedPath, { force: true });
  await fs.writeFile(artifactBorrowedPath, 'borrowed survives expiry\n', 'utf8');
  const expiryStore = new ArtifactStore({ maxBytes: 1024, ttlMs: 25, ownedRoot: artifactExpiryRoot });
  const ownedExpiryPath = await expiryStore.createOwnedTempPath('expiry.txt');
  await fs.writeFile(ownedExpiryPath, 'owned expires\n', 'utf8');
  const ownedExpiryArtifact = await expiryStore.registerOwnedFile(ownedExpiryPath, { name: 'expiry.txt' });
  const borrowedExpiryArtifact = await expiryStore.registerFile(artifactBorrowedPath, { name: 'borrowed.txt' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expiryStore.cleanup();
  await expiryStore.waitForCleanup();
  for (const artifact of [ownedExpiryArtifact, borrowedExpiryArtifact]) {
    try {
      expiryStore.get(artifact.id);
      throw new Error('expired artifact remained registered');
    } catch (error) {
      if (!String(error?.message).includes('Unknown or expired artifact')) throw error;
    }
  }
  try {
    await fs.access(ownedExpiryPath);
    throw new Error('owned artifact file survived TTL cleanup');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if ((await fs.readFile(artifactBorrowedPath, 'utf8')) !== 'borrowed survives expiry\n') {
    throw new Error('artifact expiry deleted a borrowed caller-owned file');
  }
  await expiryStore.close();

  await fs.rm(artifactUtf8Root, { recursive: true, force: true });
  await fs.writeFile(artifactUtf8Path, 'A😀B', 'utf8');
  const utf8Store = new ArtifactStore({ maxBytes: 1024, ttlMs: 60_000, ownedRoot: artifactUtf8Root });
  const utf8Artifact = await utf8Store.registerFile(artifactUtf8Path, { name: 'utf8.txt' });
  const utf8MidCodePoint = await utf8Store.readText(utf8Artifact.id, { offset: 2, maxBytes: 1 });
  if (
    utf8MidCodePoint.requestedOffset !== 2 ||
    utf8MidCodePoint.startOffset !== 5 ||
    utf8MidCodePoint.text !== 'B' ||
    utf8MidCodePoint.nextOffset !== 6 ||
    !utf8MidCodePoint.done
  ) {
    throw new Error('Artifact UTF-8 range read did not advance an in-code-point offset safely');
  }
  await utf8Store.close();
  await fs.rm(artifactUtf8Path, { force: true });

  await fs.writeFile(presentFilePath, 'artifact smoke text\nline two\n', 'utf8');
  await fs.writeFile(presentBinaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]));
  await fs.rm(importedFilePath, { force: true });
  await fs.rm(cancelledImportPath, { force: true });
  await fs.rm(execCancelPidPath, { force: true });
  await fs.rm(execCancelMarkerPath, { force: true });
  await fs.rm(shutdownProcessPidPath, { force: true });
  await fs.rm(filesystemRoot, { recursive: true, force: true });
  await fs.rm(filesystemOutsideRoot, { recursive: true, force: true });
  await fs.rm(gitShimDir, { recursive: true, force: true });
  await fs.rm(gitValidationTriggerPath, { force: true });
  await fs.rm(gitValidationPidPath, { force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(repositoryRoot, { recursive: true, force: true });
  await fs.rm(checkpointStateRoot, { recursive: true, force: true });
  await fs.rm(workspaceSeedRoot, { recursive: true, force: true });
  await fs.rm(workspaceOrigin, { recursive: true, force: true });
  await fs.rm(workspaceCancelOrigin, { recursive: true, force: true });
  await fs.rm(workspaceConcurrencyTriggerPath, { force: true });
  await fs.rm(workspaceConcurrencyLockDir, { recursive: true, force: true });
  await fs.rm(workspaceConcurrencyOverlapPath, { force: true });
  await fs.rm(workspaceCrossProcessTriggerPath, { force: true });
  await fs.rm(workspaceCrossProcessAddLogPath, { force: true });
  await fs.rm(workspaceBranchRaceTriggerPath, { force: true });
  await fs.rm(workspaceBranchRaceReleasePath, { force: true });
  await fs.rm(workspaceBranchRacePidPath, { force: true });
  await fs.rm(workspaceOwnedBranchTriggerPath, { force: true });
  await fs.rm(workspaceOwnedBranchReadyPath, { force: true });
  await fs.rm(workspaceOwnedBranchReleasePath, { force: true });
  await fs.rm(workspaceWorktreeAddTriggerPath, { force: true });
  await fs.rm(workspaceWorktreeAddPidPath, { force: true });
  await fs.rm(workspaceWorktreeRemoveTriggerPath, { force: true });
  await fs.rm(workspaceWorktreeRemovePidPath, { force: true });
  await fs.rm(workspaceRediscoveryBridgesConfig, { force: true });
  if (liveIntegrations) {
    await fs.rm(lspSmokeRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(lspWorkspaceA, 'src'), { recursive: true });
    await fs.mkdir(path.join(lspWorkspaceB, 'src'), { recursive: true });
    await fs.mkdir(path.join(lspDeniedWorkspace, 'src'), { recursive: true });
    await fs.mkdir(lspMissingWorkspace, { recursive: true });
    const lspTsconfig = JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
      include: ['src/**/*.ts'],
    });
    await fs.writeFile(path.join(lspWorkspaceA, 'tsconfig.json'), `${lspTsconfig}\n`, 'utf8');
    await fs.writeFile(path.join(lspWorkspaceA, 'src/lib.ts'), "export function greet(name: string): string { return `hello ${name}`; }\n", 'utf8');
    await fs.writeFile(
      path.join(lspWorkspaceA, 'src/main.ts'),
      "import { greet } from './lib.js';\nconst value: string = greet('alpha');\nconst broken: number = 'wrong';\nconsole.log(value, broken);\n",
      'utf8',
    );
    await fs.writeFile(path.join(lspWorkspaceB, 'tsconfig.json'), `${lspTsconfig}\n`, 'utf8');
    await fs.writeFile(path.join(lspWorkspaceB, 'src/lib.ts'), 'export function square(value: number): number { return value * value; }\n', 'utf8');
    await fs.writeFile(
      path.join(lspWorkspaceB, 'src/main.ts'),
      "import { square } from './lib.js';\nconst result: number = square(4);\nconsole.log(result);\n",
      'utf8',
    );
    await fs.writeFile(path.join(lspDeniedWorkspace, 'src/main.ts'), 'const denied = 1;\n', 'utf8');
    await fs.writeFile(
      path.join(lspDeniedWorkspace, '.lsp-mcp.json'),
      `${JSON.stringify({
        lsp: {
          servers: {
            malicious: {
              command: '/bin/sh',
              args: ['-c', `touch ${lspDeniedMarker}; exit 1`],
              languageIds: ['typescript'],
              extensions: ['.ts'],
            },
          },
        },
      })}\n`,
      'utf8',
    );
    await fs.writeFile(path.join(lspMissingWorkspace, 'fixture.yaml'), 'key: value\n', 'utf8');
  }
  await fs.mkdir(filesystemRoot, { recursive: true });
  await fs.mkdir(filesystemOutsideRoot, { recursive: true });
  await fs.mkdir(gitShimDir, { recursive: true });
  const gitShim = `#!/usr/bin/env bash
set -eu
checking=0
for arg in "$@"; do
  if [[ "$arg" == "--check" ]]; then checking=1; fi
done
if [[ "$checking" == "1" && -f "${gitValidationTriggerPath}" ]]; then
  echo $$ > "${gitValidationPidPath}"
  sleep 30
fi
args=" $* "
if [[ -f "${workspaceConcurrencyTriggerPath}" && "$args" == *" fetch "* ]]; then
  if ! mkdir "${workspaceConcurrencyLockDir}" 2>/dev/null; then
    echo overlap > "${workspaceConcurrencyOverlapPath}"
    exit 97
  fi
  sleep 0.2
  set +e
  /usr/bin/git "$@"
  status=$?
  set -e
  rmdir "${workspaceConcurrencyLockDir}" 2>/dev/null || true
  exit $status
fi
if [[ -f "${workspaceCrossProcessTriggerPath}" && "$args" == *" worktree add "* ]]; then
  echo $$ >> "${workspaceCrossProcessAddLogPath}"
  sleep 0.3
fi
if [[ -f "${workspaceBranchRaceTriggerPath}" && "$args" == *" update-ref refs/heads/feat/workspace-race "* ]]; then
  echo $$ > "${workspaceBranchRacePidPath}"
  while [[ ! -f "${workspaceBranchRaceReleasePath}" ]]; do sleep 0.02; done
fi
if [[ -f "${workspaceOwnedBranchTriggerPath}" && "$args" == *" update-ref refs/heads/feat/workspace-owned-cleanup "* ]]; then
  set +e
  /usr/bin/git "$@"
  status=$?
  set -e
  if [[ "$status" == "0" ]]; then
    echo $$ > "${workspaceOwnedBranchReadyPath}"
    while [[ ! -f "${workspaceOwnedBranchReleasePath}" ]]; do sleep 0.02; done
  fi
  exit $status
fi
if [[ -f "${workspaceWorktreeAddTriggerPath}" && "$args" == *" worktree add "* ]]; then
  echo $$ > "${workspaceWorktreeAddPidPath}"
  sleep 30
fi
if [[ -f "${workspaceWorktreeRemoveTriggerPath}" && "$args" == *" worktree remove "* ]]; then
  echo $$ > "${workspaceWorktreeRemovePidPath}"
  sleep 0.5
fi
exec /usr/bin/git "$@"
`;
  await fs.writeFile(`${gitShimDir}/git`, gitShim, { mode: 0o755 });
  await fs.mkdir(`${filesystemRoot}/subdir`);
  await fs.writeFile(`${filesystemRoot}/a.txt`, 'one\ntwo\nthree\n', 'utf8');
  await fs.writeFile(`${filesystemRoot}/.hidden`, 'hidden\n', 'utf8');
  await fs.writeFile(`${filesystemRoot}/binary.bin`, Buffer.from([0xff, 0xfe, 0xfd]));
  await fs.writeFile(
    `${filesystemRoot}/large.txt`,
    Array.from({ length: 400 }, (_, index) => `${String(index).padStart(4, '0')}:${'x'.repeat(1018)}\n`).join(''),
    'utf8',
  );
  await fs.writeFile(`${filesystemOutsideRoot}/outside.txt`, 'outside\n', 'utf8');
  await fs.symlink('a.txt', `${filesystemRoot}/link.txt`);
  await fs.symlink(filesystemOutsideRoot, `${filesystemRoot}/outside-link`);
  await fs.mkdir(workspaceSeedRoot, { recursive: true });
  await execFileAsync('/usr/bin/git', ['init', '-b', 'main', workspaceSeedRoot]);
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'config', 'user.name', 'Workspace Smoke']);
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'config', 'user.email', 'workspace-smoke@example.com']);
  await fs.writeFile(`${workspaceSeedRoot}/fixture.txt`, 'v1\n', 'utf8');
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'add', 'fixture.txt']);
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'commit', '-m', 'v1']);
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'tag', 'v1']);
  await fs.writeFile(`${workspaceSeedRoot}/fixture.txt`, 'main\n', 'utf8');
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'commit', '-am', 'main']);
  await execFileAsync('/usr/bin/git', ['init', '--bare', workspaceOrigin]);
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'remote', 'add', 'origin', workspaceOrigin]);
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'push', 'origin', 'main', '--tags']);
  await execFileAsync('/usr/bin/git', ['-C', workspaceOrigin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await execFileAsync('/usr/bin/git', ['clone', '--bare', workspaceOrigin, workspaceCancelOrigin]);
  await client.connect(transport);

  const allTools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    allTools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  const names = allTools.map((tool) => tool.name);
  const required = [
    'exec',
    'read_file',
    'edit_files',
    'list_directory',
    'apply_patch',
    'workspace_create',
    'workspace_list',
    'workspace_delete',
    'agent_capabilities',
    'agent_start',
    'agent_poll',
    'agent_result',
    'agent_cancel',
    'agent_list',
    'agent_run',
    'operation_start',
    'operation_poll',
    'operation_result',
    'operation_cancel',
    'operation_list',
    'work_checkpoint_get',
    'work_checkpoint_put',
    'work_checkpoint_list',
    'work_checkpoint_delete',
    'work_status',
    'import_file',
    'process_start',
    'process_list',
    'process_read',
    'process_write',
    'process_kill',
    'mcp_bridge_status',
    'capabilities',
    'command_info',
    'system_audit',
    'server_info',
    'read_artifact',
    'present_artifact',
    'present_file',
    ...(liveIntegrations
      ? [
          'browser_navigate',
          'browser_snapshot',
          'browser_take_screenshot',
          'lsp_hover',
          'lsp_definition',
          'lsp_references',
          'lsp_document_symbols',
          'lsp_workspace_symbols',
          'lsp_diagnostics',
          'lsp_server_status',
        ]
      : []),
  ];
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
  }
  if (names.includes('browser_screenshot_poc')) {
    throw new Error('Legacy browser_screenshot_poc should not be registered');
  }

  const toolByName = new Map(allTools.map((tool) => [tool.name, tool]));
  const agentStartTool = toolByName.get('agent_start');
  if (!agentStartTool) throw new Error('agent_start schema missing');
  const agentStartProperties = agentStartTool.inputSchema?.properties ?? {};
  for (const property of ['harness', 'cwd', 'task', 'skills', 'timeoutMs']) {
    if (!(property in agentStartProperties)) throw new Error(`agent_start schema missing property: ${property}`);
  }
  if (!agentStartTool.description?.includes('agent_poll')) {
    throw new Error('agent_start description must direct the caller to polling');
  }

  const agentPollTool = toolByName.get('agent_poll');
  if (!agentPollTool) throw new Error('agent_poll schema missing');
  const pollWaitMaximum = agentPollTool.inputSchema?.properties?.waitMs?.maximum;
  if (pollWaitMaximum !== 15_000) throw new Error(`agent_poll waitMs maximum mismatch: ${pollWaitMaximum}`);

  const agentRunTool = toolByName.get('agent_run');
  if (!agentRunTool) throw new Error('agent_run schema missing');
  const agentRunProperties = agentRunTool.inputSchema?.properties ?? {};
  for (const property of ['harness', 'cwd', 'task', 'skills', 'timeoutMs']) {
    if (!(property in agentRunProperties)) throw new Error(`agent_run schema missing property: ${property}`);
  }
  if (agentRunProperties.timeoutMs?.maximum !== 30_000) {
    throw new Error('agent_run must stay hard-capped as a short blocking compatibility surface');
  }
  if (!agentRunTool.description?.includes('agent_start')) {
    throw new Error('agent_run description must prefer agent_start');
  }

  const operationStartTool = toolByName.get('operation_start');
  if (!operationStartTool) throw new Error('operation_start schema missing');
  const operationStartProperties = operationStartTool.inputSchema?.properties ?? {};
  for (const property of ['command', 'argv', 'cwd', 'env', 'timeoutMs', 'idempotencyKey', 'category', 'label']) {
    if (!(property in operationStartProperties)) {
      throw new Error(`operation_start schema missing property: ${property}`);
    }
  }
  if (!operationStartTool.description?.includes('idempotencyKey')) {
    throw new Error('operation_start must document safe retry with idempotencyKey');
  }

  const operationPollTool = toolByName.get('operation_poll');
  if (operationPollTool?.inputSchema?.properties?.waitMs?.maximum !== 15_000) {
    throw new Error('operation_poll waitMs maximum must be 15000');
  }
  if (!toolByName.get('work_checkpoint_put')?.description?.includes('expectedRevision')) {
    throw new Error('work_checkpoint_put must document optimistic revision guarding');
  }

  const execTool = toolByName.get('exec');
  if (!execTool?.description?.includes('agent_start')) {
    throw new Error('exec description does not redirect coding-harness work to agent_start');
  }
  if (!execTool?.description?.includes('operation_start')) {
    throw new Error('exec description must redirect recoverable finite work to operation_start');
  }
  const processStartTool = toolByName.get('process_start');
  if (!processStartTool?.description?.includes('agent_start')) {
    throw new Error('process_start description does not prefer agent_start');
  }
  if (!processStartTool?.description?.includes('operation_start')) {
    throw new Error('process_start must distinguish durable finite operations from process sessions');
  }

  const workStatus = await client.callTool({
    name: 'work_status',
    arguments: { cwd: workspaceSeedRoot },
  });
  if (workStatus.isError) throw new Error('work_status failed for a Git workspace');
  const workStatusText = workStatus.content?.find((item) => item.type === 'text')?.text ?? '';
  const workStatusValue = JSON.parse(workStatusText);
  if (!workStatusValue.git?.available || workStatusValue.git?.head === null) {
    throw new Error('work_status did not report Git evidence');
  }
  if (!workStatusValue.filesystem?.latestMtimeAt) {
    throw new Error('work_status did not report filesystem activity');
  }
  if (!Array.isArray(workStatusValue.agentRuns) ||
      !Array.isArray(workStatusValue.durableOperations) ||
      !Array.isArray(workStatusValue.managedProcesses) ||
      !Array.isArray(workStatusValue.checkpoints)) {
    throw new Error('work_status did not report managed recovery collections');
  }

  const checkpointCreatedResult = await client.callTool({
    name: 'work_checkpoint_put',
    arguments: {
      cwd: workspaceSeedRoot,
      key: 'smoke',
      value: { currentStep: 'verify', next: 'finish' },
      expectedRevision: null,
    },
  });
  if (checkpointCreatedResult.isError) throw new Error('work_checkpoint_put create failed');
  const checkpointCreated = JSON.parse(
    checkpointCreatedResult.content?.find((item) => item.type === 'text')?.text ?? '{}',
  ).checkpoint;
  if (!/^sha256:[0-9a-f]{64}$/.test(checkpointCreated?.revision ?? '')) {
    throw new Error('work_checkpoint_put did not return a content revision');
  }

  const checkpointReadResult = await client.callTool({
    name: 'work_checkpoint_get',
    arguments: { cwd: workspaceSeedRoot, key: 'smoke' },
  });
  if (checkpointReadResult.isError) throw new Error('work_checkpoint_get failed');
  const checkpointRead = JSON.parse(
    checkpointReadResult.content?.find((item) => item.type === 'text')?.text ?? '{}',
  ).checkpoint;
  if (checkpointRead?.value?.next !== 'finish') {
    throw new Error('work_checkpoint_get did not round-trip checkpoint value');
  }

  const staleCheckpoint = await client.callTool({
    name: 'work_checkpoint_put',
    arguments: {
      cwd: workspaceSeedRoot,
      key: 'smoke',
      value: { currentStep: 'stale' },
      expectedRevision: null,
    },
  });
  if (!staleCheckpoint.isError) {
    throw new Error('work_checkpoint_put must reject stale create-only writes');
  }
  const staleCheckpointError = JSON.parse(
    staleCheckpoint.content?.find((item) => item.type === 'text')?.text ?? '{}',
  ).error;
  if (staleCheckpointError?.code !== 'CHECKPOINT_CONFLICT' ||
      staleCheckpointError?.details?.actualRevision !== checkpointCreated.revision) {
    throw new Error('work_checkpoint_put conflict must expose current revision');
  }

  const checkpointStatusResult = await client.callTool({
    name: 'work_status',
    arguments: { cwd: workspaceSeedRoot },
  });
  if (checkpointStatusResult.isError) throw new Error('work_status failed after checkpoint creation');
  const checkpointStatusValue = JSON.parse(
    checkpointStatusResult.content?.find((item) => item.type === 'text')?.text ?? '{}',
  );
  if (!checkpointStatusValue.checkpoints.some((item) => item.key === 'smoke')) {
    throw new Error('work_status did not surface durable workflow checkpoints');
  }

  await fs.writeFile(path.join(checkpointStateRoot, 'checkpoints.sqlite'), 'not-a-sqlite-database');
  const degradedStatusResult = await client.callTool({
    name: 'work_status',
    arguments: { cwd: workspaceSeedRoot },
  });
  if (degradedStatusResult.isError) {
    throw new Error('work_status must fail soft when checkpoint storage is unreadable');
  }
  const degradedStatusValue = JSON.parse(
    degradedStatusResult.content?.find((item) => item.type === 'text')?.text ?? '{}',
  );
  if (!degradedStatusValue.git?.available || degradedStatusValue.checkpointStore?.available !== false) {
    throw new Error('work_status did not preserve Git evidence while surfacing checkpoint-store failure');
  }

  const expectedLspTools = [
    'lsp_hover',
    'lsp_signature_help',
    'lsp_declaration',
    'lsp_definition',
    'lsp_type_definition',
    'lsp_implementation',
    'lsp_references',
    'lsp_document_symbols',
    'lsp_workspace_symbols',
    'lsp_diagnostics',
    'lsp_call_hierarchy_prepare',
    'lsp_call_hierarchy_incoming',
    'lsp_call_hierarchy_outgoing',
    'lsp_type_hierarchy_prepare',
    'lsp_type_hierarchy_supertypes',
    'lsp_type_hierarchy_subtypes',
    'lsp_list_servers',
    'lsp_search_servers',
    'lsp_server_status',
  ].sort();
  const actualLspTools = names.filter((name) => name.startsWith('lsp_')).sort();
  if (liveIntegrations) {
    if (JSON.stringify(actualLspTools) !== JSON.stringify(expectedLspTools)) {
      throw new Error(`Unexpected LSP tool surface: ${actualLspTools.join(',')}`);
    }
  } else if (actualLspTools.length !== 0 || names.some((name) => name.startsWith('browser_'))) {
    throw new Error('Portable smoke unexpectedly exposed optional LSP/Playwright tools');
  }
  for (const forbidden of [
    'lsp_rename',
    'lsp_format_document',
    'lsp_code_actions',
    'lsp_execute_command',
    'lsp_request',
    'lsp_notify',
    'lsp_stop_server',
    'lsp_stop_workspace',
    'lsp_completion',
  ]) {
    if (names.includes(forbidden)) throw new Error(`Forbidden LSP tool was exported: ${forbidden}`);
  }

  const parseJsonToolResult = (result) => {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error('Expected JSON text tool result');
    return JSON.parse(text);
  };
  const expectToolFailure = async (name, argumentsValue, options) => {
    try {
      const result = await client.callTool({ name, arguments: argumentsValue }, options);
      if (result.isError) return;
    } catch {
      return;
    }
    throw new Error(`${name} unexpectedly succeeded`);
  };

  const agentCapabilitiesResult = parseJsonToolResult(
    await client.callTool({ name: 'agent_capabilities', arguments: {} }),
  );
  if (agentCapabilitiesResult.runtime?.kind !== 'durable-background-service') throw new Error('agent_capabilities runtime kind mismatch');
  if (!Array.isArray(agentCapabilitiesResult.harnesses)) throw new Error('agent_capabilities harnesses missing');

  await expectToolFailure('workspace_create', {
    repository: 'https://token@example.com/repository.git',
  });

  await expectToolFailure('workspace_create', {
    repository: 'https://example.com/repository.git?token=secret',
  });

  const defaultWorkspace = parseJsonToolResult(
    await client.callTool({
      name: 'workspace_create',
      arguments: { repository: workspaceOrigin, timeoutMs: 30_000 },
    }),
  );
  if (defaultWorkspace.branch !== null || defaultWorkspace.revision !== 'origin/HEAD') {
    throw new Error('workspace_create default checkout was not detached at remote HEAD');
  }
  if ((await fs.readFile(`${defaultWorkspace.path}/fixture.txt`, 'utf8')) !== 'main\n') {
    throw new Error('workspace_create default checkout resolved the wrong revision');
  }

  const tagWorkspace = parseJsonToolResult(
    await client.callTool({
      name: 'workspace_create',
      arguments: { repository: workspaceOrigin, revision: 'v1', timeoutMs: 30_000 },
    }),
  );
  if (tagWorkspace.head === defaultWorkspace.head) {
    throw new Error('workspace_create explicit tag did not resolve independently from remote HEAD');
  }
  if ((await fs.readFile(`${tagWorkspace.path}/fixture.txt`, 'utf8')) !== 'v1\n') {
    throw new Error('workspace_create tag checkout resolved the wrong content');
  }

  const branchWorkspaceArgs = {
    repository: workspaceOrigin,
    revision: 'origin/main',
    createBranch: 'feat/workspace-smoke',
    idempotencyKey: 'workspace-smoke-branch',
    timeoutMs: 30_000,
  };
  const branchWorkspace = parseJsonToolResult(await client.callTool({
    name: 'workspace_create',
    arguments: branchWorkspaceArgs,
  }));
  if (branchWorkspace.branch !== 'feat/workspace-smoke' || branchWorkspace.duplicate !== false) {
    throw new Error('workspace_create createBranch did not create the requested new branch');
  }
  const concurrentIdempotencyArgs = {
    repository: workspaceOrigin,
    revision: 'v1',
    idempotencyKey: 'workspace-smoke-concurrent',
    timeoutMs: 30_000,
  };
  const [concurrentIdempotentA, concurrentIdempotentB] = await Promise.all([
    client.callTool({ name: 'workspace_create', arguments: concurrentIdempotencyArgs }),
    client.callTool({ name: 'workspace_create', arguments: concurrentIdempotencyArgs }),
  ]).then((results) => results.map(parseJsonToolResult));
  if (
    concurrentIdempotentA.id !== concurrentIdempotentB.id ||
    [concurrentIdempotentA.duplicate, concurrentIdempotentB.duplicate].filter(Boolean).length !== 1
  ) {
    throw new Error('workspace_create concurrent idempotent retry created duplicate workspaces');
  }
  const crossProcessClient = new Client({ name: 'agent-mcp-cross-process', version: '1.0.0' });
  const crossProcessTransport = new StdioClientTransport({
    command: node,
    args: [serverEntry],
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${gitShimDir}:${process.env.PATH}`,
      MCP_BRIDGES_CONFIG: smokeBridgeConfig,
      AGENT_MCP_CAPABILITIES_CONFIG: path.join(projectRoot, 'config/capabilities.json'),
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      AGENT_REPOSITORY_ROOT: repositoryRoot,
      AGENT_MCP_HOST: hostKind,
    },
    stderr: 'inherit',
  });
  let crossProcessWorkspace;
  try {
    await crossProcessClient.connect(crossProcessTransport);
    await fs.writeFile(workspaceCrossProcessTriggerPath, '1\n', 'utf8');
    const crossProcessArgs = {
      repository: workspaceOrigin,
      revision: 'v1',
      idempotencyKey: 'workspace-smoke-cross-process',
      timeoutMs: 30_000,
    };
    const [crossA, crossB] = await Promise.all([
      client.callTool({ name: 'workspace_create', arguments: crossProcessArgs }),
      crossProcessClient.callTool({ name: 'workspace_create', arguments: crossProcessArgs }),
    ]).then((results) => results.map(parseJsonToolResult));
    if (
      crossA.id !== crossB.id ||
      [crossA.duplicate, crossB.duplicate].filter(Boolean).length !== 1
    ) {
      throw new Error('workspace_create cross-process idempotency did not converge on one workspace');
    }
    const addLog = (await fs.readFile(workspaceCrossProcessAddLogPath, 'utf8')).trim().split(/\n+/).filter(Boolean);
    if (addLog.length !== 1) {
      throw new Error(`workspace_create cross-process idempotency executed ${addLog.length} worktree adds`);
    }
    crossProcessWorkspace = crossA;
  } finally {
    await fs.rm(workspaceCrossProcessTriggerPath, { force: true });
    await crossProcessClient.close();
  }
  parseJsonToolResult(await client.callTool({
    name: 'workspace_delete',
    arguments: { workspaceId: crossProcessWorkspace.id },
  }));
  const staleLockKey = 'workspace-smoke-stale-lock';
  const staleLockHash = createHash('sha256').update(staleLockKey).digest('hex');
  const staleLockPath = path.join(workspaceRoot, '.idempotency', '.locks', `${staleLockHash}.lock`);
  await fs.mkdir(path.dirname(staleLockPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    staleLockPath,
    `${JSON.stringify({
      version: 1,
      token: 'dead-owner',
      pid: 2_147_483_647,
      startTicks: '0',
      createdAt: Date.now() - 60_000,
      deadline: Date.now() + 60_000,
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const staleLockWorkspace = parseJsonToolResult(await client.callTool({
    name: 'workspace_create',
    arguments: {
      repository: workspaceOrigin,
      revision: 'v1',
      idempotencyKey: staleLockKey,
      timeoutMs: 30_000,
    },
  }));
  if (staleLockWorkspace.duplicate !== false) {
    throw new Error('workspace_create stale idempotency lock recovery returned an unexpected duplicate');
  }
  if (await fs.access(staleLockPath).then(() => true, () => false)) {
    throw new Error('workspace_create left the recovered idempotency lock behind');
  }
  parseJsonToolResult(await client.callTool({
    name: 'workspace_delete',
    arguments: { workspaceId: staleLockWorkspace.id },
  }));
  const duplicateBranchWorkspace = parseJsonToolResult(await client.callTool({
    name: 'workspace_create',
    arguments: branchWorkspaceArgs,
  }));
  if (duplicateBranchWorkspace.id !== branchWorkspace.id || duplicateBranchWorkspace.duplicate !== true) {
    throw new Error('workspace_create idempotencyKey did not return the original workspace');
  }
  const branchIdempotencyRecordPath = path.join(
    workspaceRoot,
    '.idempotency',
    `${createHash('sha256').update(branchWorkspaceArgs.idempotencyKey).digest('hex')}.json`,
  );
  const readyIdempotencyRecord = JSON.parse(await fs.readFile(branchIdempotencyRecordPath, 'utf8'));
  if (readyIdempotencyRecord.version !== 2 || readyIdempotencyRecord.state !== 'ready') {
    throw new Error('workspace_create did not persist v2 ready idempotency state');
  }
  const { result: _discardedReadyResult, ...pendingIdempotencyRecord } = readyIdempotencyRecord;
  await fs.writeFile(
    branchIdempotencyRecordPath,
    `${JSON.stringify({ ...pendingIdempotencyRecord, state: 'pending' })}\n`,
    { mode: 0o600 },
  );
  const recoveredBranchWorkspace = parseJsonToolResult(await client.callTool({
    name: 'workspace_create',
    arguments: branchWorkspaceArgs,
  }));
  if (recoveredBranchWorkspace.id !== branchWorkspace.id || recoveredBranchWorkspace.duplicate !== true) {
    throw new Error('workspace_create did not recover a committed workspace from pending idempotency state');
  }
  const recoveredIdempotencyRecord = JSON.parse(await fs.readFile(branchIdempotencyRecordPath, 'utf8'));
  if (
    recoveredIdempotencyRecord.state !== 'ready' ||
    recoveredIdempotencyRecord.result?.id !== branchWorkspace.id
  ) {
    throw new Error('workspace_create did not finalize recovered idempotency state');
  }
  const idempotencyConflict = await client.callTool({
    name: 'workspace_create',
    arguments: { ...branchWorkspaceArgs, revision: 'v1' },
  });
  if (!idempotencyConflict.isError || parseJsonToolResult(idempotencyConflict).error?.code !== 'IDEMPOTENCY_CONFLICT') {
    throw new Error('workspace_create idempotency conflict was not a structured failure');
  }
  const branchExists = await client.callTool({
    name: 'workspace_create',
    arguments: {
      repository: workspaceOrigin,
      revision: 'origin/main',
      createBranch: 'feat/workspace-smoke',
      timeoutMs: 30_000,
    },
  });
  if (!branchExists.isError || parseJsonToolResult(branchExists).error?.code !== 'BRANCH_EXISTS') {
    throw new Error('workspace_create existing branch was not rejected');
  }

  const sharedRepositoryPath = `${repositoryRoot}/${defaultWorkspace.repositoryKey}.git`;
  await fs.writeFile(workspaceBranchRaceTriggerPath, '1\n', 'utf8');
  const branchRaceCreate = client.callTool({
    name: 'workspace_create',
    arguments: {
      repository: workspaceOrigin,
      revision: 'origin/main',
      createBranch: 'feat/workspace-race',
      timeoutMs: 30_000,
    },
  });
  let branchRacePid;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      branchRacePid = Number((await fs.readFile(workspaceBranchRacePidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(branchRacePid)) throw new Error('workspace createBranch race did not reach worktree add');
  await execFileAsync('/usr/bin/git', [
    '-C', sharedRepositoryPath, 'branch', 'feat/workspace-race', defaultWorkspace.head,
  ]);
  await fs.writeFile(workspaceBranchRaceReleasePath, '1\n', 'utf8');
  const branchRaceResult = await branchRaceCreate;
  if (!branchRaceResult.isError) throw new Error('workspace createBranch race unexpectedly succeeded');
  const preservedBranch = (await execFileAsync('/usr/bin/git', [
    '-C', sharedRepositoryPath, 'rev-parse', '--verify', 'refs/heads/feat/workspace-race',
  ])).stdout.trim();
  if (preservedBranch !== defaultWorkspace.head) {
    throw new Error('workspace createBranch failure did not preserve the concurrently-created branch');
  }
  await execFileAsync('/usr/bin/git', ['-C', sharedRepositoryPath, 'branch', '-D', 'feat/workspace-race']);
  await fs.rm(workspaceBranchRaceTriggerPath, { force: true });
  await fs.rm(workspaceBranchRaceReleasePath, { force: true });
  await fs.rm(workspaceBranchRacePidPath, { force: true });
  await fs.rm(workspaceOwnedBranchTriggerPath, { force: true });
  await fs.rm(workspaceOwnedBranchReadyPath, { force: true });
  await fs.rm(workspaceOwnedBranchReleasePath, { force: true });
  const ownedCleanupKey = 'workspace-smoke-owned-branch-cleanup';
  const ownedCleanupHash = createHash('sha256').update(ownedCleanupKey).digest('hex');
  const ownedCleanupRecordPath = path.join(workspaceRoot, '.idempotency', `${ownedCleanupHash}.json`);
  await fs.writeFile(workspaceOwnedBranchTriggerPath, '1\n', 'utf8');
  const ownedCleanupCreate = client.callTool({
    name: 'workspace_create',
    arguments: {
      repository: workspaceOrigin,
      revision: 'origin/main',
      createBranch: 'feat/workspace-owned-cleanup',
      idempotencyKey: ownedCleanupKey,
      timeoutMs: 30_000,
    },
  });
  let ownedBranchReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fs.access(workspaceOwnedBranchReadyPath);
      ownedBranchReady = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!ownedBranchReady) throw new Error('workspace owned-branch cleanup fixture did not create the branch ref');
  const ownedCleanupRecord = JSON.parse(await fs.readFile(ownedCleanupRecordPath, 'utf8'));
  const ownedCleanupWorkspacePath = ownedCleanupRecord.intent?.path;
  if (typeof ownedCleanupWorkspacePath !== 'string') {
    throw new Error('workspace owned-branch cleanup fixture could not recover pending workspace path');
  }
  await execFileAsync('/usr/bin/git', [
    '-C', sharedRepositoryPath, 'update-ref', 'refs/heads/feat/workspace-owned-cleanup', tagWorkspace.head, defaultWorkspace.head,
  ]);
  await fs.mkdir(ownedCleanupWorkspacePath, { recursive: true });
  await fs.writeFile(path.join(ownedCleanupWorkspacePath, 'block-worktree-add'), 'occupied\n', 'utf8');
  await fs.writeFile(workspaceOwnedBranchReleasePath, '1\n', 'utf8');
  const ownedCleanupResult = await ownedCleanupCreate;
  if (!ownedCleanupResult.isError) {
    throw new Error('workspace owned-branch cleanup fixture unexpectedly created a worktree');
  }
  const movedOwnedBranch = (await execFileAsync('/usr/bin/git', [
    '-C', sharedRepositoryPath, 'rev-parse', '--verify', 'refs/heads/feat/workspace-owned-cleanup',
  ])).stdout.trim();
  if (movedOwnedBranch !== tagWorkspace.head) {
    throw new Error('workspace failure cleanup deleted or changed a branch whose OID was moved by another actor');
  }
  await execFileAsync('/usr/bin/git', ['-C', sharedRepositoryPath, 'branch', '-D', 'feat/workspace-owned-cleanup']);
  await fs.rm(ownedCleanupRecordPath, { force: true });
  await fs.rm(workspaceOwnedBranchTriggerPath, { force: true });
  await fs.rm(workspaceOwnedBranchReadyPath, { force: true });
  await fs.rm(workspaceOwnedBranchReleasePath, { force: true });
  await execFileAsync('/usr/bin/git', ['-C', sharedRepositoryPath, 'update-ref', 'refs/heads/main', defaultWorkspace.head]);
  await fs.writeFile(`${workspaceSeedRoot}/fixture.txt`, 'remote-main\n', 'utf8');
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'commit', '-am', 'remote main']);
  await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'push', 'origin', 'main']);
  const remoteMainHead = (await execFileAsync('/usr/bin/git', ['-C', workspaceSeedRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const remoteBranchWorkspace = parseJsonToolResult(
    await client.callTool({
      name: 'workspace_create',
      arguments: { repository: workspaceOrigin, revision: 'main', timeoutMs: 30_000 },
    }),
  );
  if (remoteBranchWorkspace.revision !== 'main' || remoteBranchWorkspace.head !== remoteMainHead) {
    throw new Error('workspace_create unqualified branch did not prefer the freshly fetched remote branch');
  }
  if ((await fs.readFile(`${remoteBranchWorkspace.path}/fixture.txt`, 'utf8')) !== 'remote-main\n') {
    throw new Error('workspace_create unqualified branch checked out stale local branch content');
  }

  await fs.writeFile(workspaceConcurrencyTriggerPath, '1\n', 'utf8');
  const [concurrentResultA, concurrentResultB] = await Promise.all([
    client.callTool({
      name: 'workspace_create',
      arguments: { repository: workspaceOrigin, revision: 'origin/main', timeoutMs: 30_000 },
    }),
    client.callTool({
      name: 'workspace_create',
      arguments: { repository: workspaceOrigin, revision: defaultWorkspace.head, timeoutMs: 30_000 },
    }),
  ]);
  await fs.rm(workspaceConcurrencyTriggerPath, { force: true });
  const concurrentWorkspaceA = parseJsonToolResult(concurrentResultA);
  const concurrentWorkspaceB = parseJsonToolResult(concurrentResultB);
  if (
    concurrentWorkspaceA.id === concurrentWorkspaceB.id ||
    concurrentWorkspaceA.repositoryKey !== defaultWorkspace.repositoryKey ||
    concurrentWorkspaceB.repositoryKey !== defaultWorkspace.repositoryKey
  ) {
    throw new Error('concurrent workspace creation did not reuse the repository store safely');
  }
  try {
    await fs.access(workspaceConcurrencyOverlapPath);
    throw new Error('same-repository workspace lifecycle operations overlapped despite repository locking');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const repositoryEntries = (await fs.readdir(repositoryRoot)).filter((name) => name.endsWith('.git'));
  if (repositoryEntries.length !== 1) throw new Error('workspace repository store was not deduplicated');

  await execFileAsync('/usr/bin/git', [
    '-C',
    sharedRepositoryPath,
    'remote',
    'set-url',
    'origin',
    'https://secret-user:secret-pass@example.com/repository.git?token=secret#fragment',
  ]);
  const redactedWorkspaceList = parseJsonToolResult(
    await client.callTool({ name: 'workspace_list', arguments: {} }),
  ).workspaces;
  const redactedWorkspace = redactedWorkspaceList.find((workspace) => workspace.id === defaultWorkspace.id);
  if (
    !redactedWorkspace?.repositoryCredentialsRedacted ||
    redactedWorkspace.repository !== 'https://example.com/repository.git' ||
    JSON.stringify(redactedWorkspace).includes('secret')
  ) {
    throw new Error('workspace_list leaked embedded repository credentials');
  }
  await execFileAsync('/usr/bin/git', ['-C', sharedRepositoryPath, 'remote', 'set-url', 'origin', workspaceOrigin]);

  const beforeCancelledAdd = parseJsonToolResult(
    await client.callTool({ name: 'workspace_list', arguments: {} }),
  ).workspaces.filter((workspace) => workspace.state === 'ready').length;
  await fs.writeFile(workspaceWorktreeAddTriggerPath, '1\n', 'utf8');
  const addAbortController = new AbortController();
  const cancelledAdd = client.callTool(
    {
      name: 'workspace_create',
      arguments: { repository: workspaceOrigin, timeoutMs: 30_000 },
    },
    { signal: addAbortController.signal },
  );
  let addPid;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      addPid = Number((await fs.readFile(workspaceWorktreeAddPidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(addPid)) throw new Error('workspace_create cancellation worktree add did not start');
  addAbortController.abort();
  let addWasCancelled = false;
  try {
    await cancelledAdd;
  } catch {
    addWasCancelled = true;
  }
  if (!addWasCancelled) throw new Error('workspace_create cancellation did not reject the client call');
  await fs.rm(workspaceWorktreeAddTriggerPath, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterCancelledAdd = parseJsonToolResult(
    await client.callTool({ name: 'workspace_list', arguments: {} }),
  ).workspaces.filter((workspace) => workspace.state === 'ready').length;
  if (afterCancelledAdd !== beforeCancelledAdd) {
    throw new Error('workspace_create cancellation left a registered workspace');
  }

  await fs.writeFile(workspaceConcurrencyTriggerPath, '1\n', 'utf8');
  const bootstrapAbortController = new AbortController();
  const cancelledBootstrap = client.callTool(
    {
      name: 'workspace_create',
      arguments: { repository: workspaceCancelOrigin, timeoutMs: 30_000 },
    },
    { signal: bootstrapAbortController.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  bootstrapAbortController.abort();
  let bootstrapWasCancelled = false;
  try {
    await cancelledBootstrap;
  } catch {
    bootstrapWasCancelled = true;
  }
  if (!bootstrapWasCancelled) throw new Error('workspace repository bootstrap cancellation did not reject');
  await fs.rm(workspaceConcurrencyTriggerPath, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const storesAfterCancelledBootstrap = (await fs.readdir(repositoryRoot)).filter((name) => name.endsWith('.git'));
  if (storesAfterCancelledBootstrap.length !== 1) {
    throw new Error('cancelled repository bootstrap published a partial repository store');
  }
  if ((await fs.readdir(repositoryRoot)).some((name) => name.startsWith('.tmp-'))) {
    throw new Error('cancelled repository bootstrap left a temporary repository store');
  }

  await fs.mkdir(`${workspaceRoot}/ws-invalid-state`);
  const listedWithInvalid = parseJsonToolResult(
    await client.callTool({ name: 'workspace_list', arguments: {} }),
  ).workspaces;
  if (!listedWithInvalid.some((workspace) => workspace.id === 'ws-invalid-state' && workspace.state === 'invalid')) {
    throw new Error('workspace_list silently ignored malformed managed state');
  }
  await fs.rm(`${workspaceRoot}/ws-invalid-state`, { recursive: true, force: true });

  await fs.writeFile(workspaceRediscoveryBridgesConfig, '{\"version\":1,\"bridges\":[]}\n', 'utf8');
  const rediscoveryClient = new Client({ name: 'agent-mcp-workspace-rediscovery', version: '1.0.0' });
  const rediscoveryTransport = new StdioClientTransport({
    command: node,
    args: [serverEntry],
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${gitShimDir}:${process.env.PATH}`,
      MCP_BRIDGES_CONFIG: workspaceRediscoveryBridgesConfig,
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      AGENT_REPOSITORY_ROOT: repositoryRoot,
    },
    stderr: 'inherit',
  });
  try {
    await rediscoveryClient.connect(rediscoveryTransport);
    const rediscovered = parseJsonToolResult(
      await rediscoveryClient.callTool({ name: 'workspace_list', arguments: {} }),
    ).workspaces.filter((workspace) => workspace.state === 'ready');
    if (rediscovered.length !== 7 || rediscovered.some((workspace) => workspace.repositoryKey !== defaultWorkspace.repositoryKey)) {
      throw new Error('workspace_list did not reconstruct durable state in a fresh MCP process');
    }
    const rediscoveredIdempotent = parseJsonToolResult(await rediscoveryClient.callTool({
      name: 'workspace_create',
      arguments: branchWorkspaceArgs,
    }));
    if (rediscoveredIdempotent.id !== branchWorkspace.id || rediscoveredIdempotent.duplicate !== true) {
      throw new Error('workspace_create idempotency state did not survive MCP restart');
    }
  } finally {
    await rediscoveryClient.close();
  }

  await fs.writeFile(`${defaultWorkspace.path}/dirty.txt`, 'dirty\n', 'utf8');
  const dirtyDelete = await client.callTool({
    name: 'workspace_delete',
    arguments: { workspaceId: defaultWorkspace.id },
  });
  if (!dirtyDelete.isError || parseJsonToolResult(dirtyDelete).error?.code !== 'WORKSPACE_DIRTY') {
    throw new Error('workspace_delete dirty workspace was not a structured failure');
  }
  if (!(await fs.stat(defaultWorkspace.path)).isDirectory()) {
    throw new Error('workspace_delete removed a dirty workspace without force');
  }
  parseJsonToolResult(
    await client.callTool({
      name: 'workspace_delete',
      arguments: { workspaceId: defaultWorkspace.id, force: true },
    }),
  );

  await fs.writeFile(workspaceWorktreeRemoveTriggerPath, '1\n', 'utf8');
  const removeAbortController = new AbortController();
  const cancelledRemove = client.callTool(
    {
      name: 'workspace_delete',
      arguments: { workspaceId: tagWorkspace.id },
    },
    { signal: removeAbortController.signal },
  );
  let removePid;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      removePid = Number((await fs.readFile(workspaceWorktreeRemovePidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(removePid)) throw new Error('workspace_delete mutation did not start');
  removeAbortController.abort();
  let removeResponseCancelled = false;
  try {
    await cancelledRemove;
  } catch {
    removeResponseCancelled = true;
  }
  if (!removeResponseCancelled) throw new Error('workspace_delete cancelled response unexpectedly completed');
  await fs.rm(workspaceWorktreeRemoveTriggerPath, { force: true });
  let tagWorkspaceRemoved = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fs.access(tagWorkspace.path);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      tagWorkspaceRemoved = true;
      break;
    }
  }
  if (!tagWorkspaceRemoved) throw new Error('workspace_delete cancellation interrupted committed removal');

  for (const workspace of [branchWorkspace, concurrentIdempotentA, remoteBranchWorkspace, concurrentWorkspaceA, concurrentWorkspaceB]) {
    parseJsonToolResult(
      await client.callTool({ name: 'workspace_delete', arguments: { workspaceId: workspace.id } }),
    );
  }
  const finalWorkspaceList = parseJsonToolResult(
    await client.callTool({ name: 'workspace_list', arguments: {} }),
  ).workspaces;
  if (finalWorkspaceList.length !== 0) throw new Error('workspace lifecycle smoke left managed workspaces behind');

  const rangedRead = parseJsonToolResult(
    await client.callTool({
      name: 'read_file',
      arguments: { path: 'a.txt', cwd: filesystemRoot, startLine: 2, endLine: 3 },
    }),
  );
  if (
    rangedRead.content !== 'two\nthree\n' ||
    rangedRead.startLine !== 2 ||
    rangedRead.endLine !== 3 ||
    rangedRead.totalLines !== 3 ||
    rangedRead.truncated ||
    rangedRead.locator?.cwd !== filesystemRoot ||
    rangedRead.locator?.path !== 'a.txt' ||
    rangedRead.revision !== `sha256:${createHash('sha256').update('one\ntwo\nthree\n').digest('hex')}`
  ) {
    throw new Error('read_file ranged read metadata/content/revision failed');
  }

  const largeRead = parseJsonToolResult(
    await client.callTool({
      name: 'read_file',
      arguments: { path: 'large.txt', cwd: filesystemRoot },
    }),
  );
  if (!largeRead.truncated || !Number.isSafeInteger(largeRead.nextLine) || largeRead.bytes > 256 * 1024) {
    throw new Error('read_file bounded response metadata failed');
  }
  await expectToolFailure('read_file', { path: 'binary.bin', cwd: filesystemRoot });
  await expectToolFailure('read_file', { path: 'subdir', cwd: filesystemRoot });

  const directory = parseJsonToolResult(
    await client.callTool({
      name: 'list_directory',
      arguments: { path: '.', cwd: filesystemRoot },
    }),
  );
  const expectedDirectoryEntries = [
    ['.hidden', 'file'],
    ['a.txt', 'file'],
    ['binary.bin', 'file'],
    ['large.txt', 'file'],
    ['link.txt', 'symlink'],
    ['outside-link', 'symlink'],
    ['subdir', 'directory'],
  ];
  if (
    JSON.stringify(directory.entries.map(({ name, type }) => [name, type])) !==
    JSON.stringify(expectedDirectoryEntries)
  ) {
    throw new Error('list_directory deterministic structured listing failed');
  }

  await fs.writeFile(`${filesystemRoot}/edit-a.txt`, 'alpha\nmiddle\nomega\n', 'utf8');
  await fs.writeFile(`${filesystemRoot}/edit-b.txt`, 'dup\ndup\n', 'utf8');

  const editARead = parseJsonToolResult(
    await client.callTool({
      name: 'read_file',
      arguments: { path: 'edit-a.txt', cwd: filesystemRoot },
    }),
  );
  const editResult = parseJsonToolResult(
    await client.callTool({
      name: 'edit_files',
      arguments: {
        cwd: filesystemRoot,
        files: [{
          path: 'edit-a.txt',
          ifMatch: editARead.revision,
          edits: [
            { type: 'replace', oldText: 'alpha', newText: 'ALPHA' },
            { type: 'insert_before', anchor: 'middle\n', text: 'before\n' },
            { type: 'insert_after', anchor: 'omega\n', text: 'after\n' },
          ],
        }],
      },
    }),
  );
  const editedA = 'ALPHA\nbefore\nmiddle\nomega\nafter\n';
  if (
    (await fs.readFile(`${filesystemRoot}/edit-a.txt`, 'utf8')) !== editedA ||
    editResult.files.length !== 1 ||
    editResult.files[0]?.path !== 'edit-a.txt' ||
    editResult.files[0]?.beforeRevision !== editARead.revision ||
    editResult.files[0]?.revision !== `sha256:${createHash('sha256').update(editedA).digest('hex')}` ||
    editResult.files[0]?.edits !== 3
  ) {
    throw new Error('edit_files ordered exact edits or revision metadata failed');
  }

  const editAAfter = parseJsonToolResult(
    await client.callTool({
      name: 'read_file',
      arguments: { path: 'edit-a.txt', cwd: filesystemRoot },
    }),
  );
  if (editAAfter.revision !== editResult.files[0].revision) {
    throw new Error('edit_files result revision did not match subsequent read_file revision');
  }

  const staleEdit = await client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [{
        path: 'edit-a.txt',
        ifMatch: editARead.revision,
        edits: [{ type: 'replace', oldText: 'ALPHA', newText: 'STALE-WRITE' }],
      }],
    },
  });
  if (!staleEdit.isError) throw new Error('edit_files stale ifMatch unexpectedly succeeded');
  const staleEditError = parseJsonToolResult(staleEdit).error;
  if (
    staleEditError?.code !== 'FILE_CHANGED' ||
    staleEditError?.details?.path !== 'edit-a.txt' ||
    staleEditError?.details?.expectedRevision !== editARead.revision ||
    staleEditError?.details?.actualRevision !== editResult.files[0].revision
  ) {
    throw new Error(`edit_files structured FILE_CHANGED error failed: ${JSON.stringify(staleEditError)}`);
  }
  if ((await fs.readFile(`${filesystemRoot}/edit-a.txt`, 'utf8')) !== editedA) {
    throw new Error('edit_files stale ifMatch modified target');
  }

  const editBBefore = await fs.readFile(`${filesystemRoot}/edit-b.txt`, 'utf8');
  await expectToolFailure('edit_files', {
    cwd: filesystemRoot,
    files: [
      {
        path: 'edit-a.txt',
        edits: [{ type: 'replace', oldText: 'ALPHA', newText: 'SHOULD-NOT-COMMIT' }],
      },
      {
        path: 'edit-b.txt',
        edits: [{ type: 'replace', oldText: 'dup', newText: 'ambiguous' }],
      },
    ],
  });
  if (
    (await fs.readFile(`${filesystemRoot}/edit-a.txt`, 'utf8')) !== editedA ||
    (await fs.readFile(`${filesystemRoot}/edit-b.txt`, 'utf8')) !== editBBefore
  ) {
    throw new Error('edit_files multi-file validation failure was not zero-write');
  }

  const multiReplace = parseJsonToolResult(
    await client.callTool({
      name: 'edit_files',
      arguments: {
        cwd: filesystemRoot,
        files: [{
          path: 'edit-b.txt',
          edits: [{ type: 'replace', oldText: 'dup', newText: 'DUP', expectedOccurrences: 2 }],
        }],
      },
    }),
  );
  if (
    (await fs.readFile(`${filesystemRoot}/edit-b.txt`, 'utf8')) !== 'DUP\nDUP\n' ||
    multiReplace.files[0]?.edits !== 1
  ) {
    throw new Error('edit_files explicit multiple replacement failed');
  }

  await expectToolFailure('edit_files', {
    cwd: filesystemRoot,
    files: [{
      path: '../escape.txt',
      edits: [{ type: 'replace', oldText: 'x', newText: 'y' }],
    }],
  });
  await expectToolFailure('edit_files', {
    cwd: filesystemRoot,
    files: [{
      path: 'link.txt',
      edits: [{ type: 'replace', oldText: 'one', newText: 'SYMLINK-WRITE' }],
    }],
  });
  await expectToolFailure('edit_files', {
    cwd: filesystemRoot,
    files: [{
      path: 'outside-link/outside.txt',
      edits: [{ type: 'replace', oldText: 'outside', newText: 'ESCAPED' }],
    }],
  });
  if (
    (await fs.readFile(`${filesystemRoot}/a.txt`, 'utf8')) !== 'one\ntwo\nthree\n' ||
    (await fs.readFile(`${filesystemOutsideRoot}/outside.txt`, 'utf8')) !== 'outside\n'
  ) {
    throw new Error('edit_files symlink protection failed');
  }

  const createResult = parseJsonToolResult(await client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [{ action: 'create', path: 'created-by-edit.txt', content: 'created\n' }],
    },
  }));
  const createdRevision = `sha256:${createHash('sha256').update('created\n').digest('hex')}`;
  if (
    (await fs.readFile(`${filesystemRoot}/created-by-edit.txt`, 'utf8')) !== 'created\n' ||
    createResult.files[0]?.action !== 'create' ||
    createResult.files[0]?.beforeRevision !== null ||
    createResult.files[0]?.revision !== createdRevision ||
    createResult.files[0]?.bytesBefore !== 0 ||
    createResult.files[0]?.bytesAfter !== 8
  ) {
    throw new Error('edit_files create action failed');
  }
  const createExisting = await client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [{ action: 'create', path: 'created-by-edit.txt', content: 'overwrite\n' }],
    },
  });
  if (!createExisting.isError || parseJsonToolResult(createExisting).error?.code !== 'FILE_EXISTS') {
    throw new Error('edit_files create unexpectedly overwrote an existing file');
  }

  const deleteResult = parseJsonToolResult(await client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [{ action: 'delete', path: 'created-by-edit.txt', ifMatch: createdRevision }],
    },
  }));
  if (
    await fs.access(`${filesystemRoot}/created-by-edit.txt`).then(() => true, () => false) ||
    deleteResult.files[0]?.action !== 'delete' ||
    deleteResult.files[0]?.beforeRevision !== createdRevision ||
    deleteResult.files[0]?.revision !== null ||
    deleteResult.files[0]?.bytesAfter !== 0
  ) {
    throw new Error('edit_files delete action failed');
  }
  const deleteSymlink = await client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [{ action: 'delete', path: 'link.txt', ifMatch: rangedRead.revision }],
    },
  });
  if (!deleteSymlink.isError || parseJsonToolResult(deleteSymlink).error?.code !== 'SYMLINK_PATH') {
    throw new Error('edit_files delete followed a symlink target');
  }
  if ((await fs.readFile(`${filesystemRoot}/a.txt`, 'utf8')) !== 'one\ntwo\nthree\n') {
    throw new Error('edit_files symlink delete modified the linked target');
  }

  await fs.writeFile(`${filesystemRoot}/mixed-edit.txt`, 'before\n', 'utf8');
  await fs.writeFile(`${filesystemRoot}/mixed-delete.txt`, 'delete\n', 'utf8');
  const mixedDeleteRead = parseJsonToolResult(await client.callTool({
    name: 'read_file',
    arguments: { path: 'mixed-delete.txt', cwd: filesystemRoot },
  }));
  const mixedFailure = await client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [
        { path: 'mixed-edit.txt', edits: [{ type: 'replace', oldText: 'before', newText: 'after' }] },
        { action: 'create', path: 'mixed-create.txt', content: 'new\n' },
        { action: 'delete', path: 'mixed-delete.txt', ifMatch: `sha256:${'0'.repeat(64)}` },
      ],
    },
  });
  if (!mixedFailure.isError || parseJsonToolResult(mixedFailure).error?.code !== 'FILE_CHANGED') {
    throw new Error('edit_files mixed preflight failure did not report FILE_CHANGED');
  }
  if (
    (await fs.readFile(`${filesystemRoot}/mixed-edit.txt`, 'utf8')) !== 'before\n' ||
    (await fs.readFile(`${filesystemRoot}/mixed-delete.txt`, 'utf8')) !== 'delete\n' ||
    await fs.access(`${filesystemRoot}/mixed-create.txt`).then(() => true, () => false)
  ) {
    throw new Error('edit_files mixed preflight failure was not zero-write');
  }
  const mixedSuccess = parseJsonToolResult(await client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [
        { path: 'mixed-edit.txt', edits: [{ type: 'replace', oldText: 'before', newText: 'after' }] },
        { action: 'create', path: 'mixed-create.txt', content: 'new\n' },
        { action: 'delete', path: 'mixed-delete.txt', ifMatch: mixedDeleteRead.revision },
      ],
    },
  }));
  if (
    (await fs.readFile(`${filesystemRoot}/mixed-edit.txt`, 'utf8')) !== 'after\n' ||
    (await fs.readFile(`${filesystemRoot}/mixed-create.txt`, 'utf8')) !== 'new\n' ||
    await fs.access(`${filesystemRoot}/mixed-delete.txt`).then(() => true, () => false) ||
    mixedSuccess.files.map((file) => file.action).join(',') !== 'edit,create,delete'
  ) {
    throw new Error('edit_files mixed edit/create/delete commit failed');
  }
  const createThroughSymlink = await client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [{ action: 'create', path: 'outside-link/created.txt', content: 'escape\n' }],
    },
  });
  if (!createThroughSymlink.isError || parseJsonToolResult(createThroughSymlink).error?.code !== 'SYMLINK_PATH') {
    throw new Error('edit_files create followed a symlink parent');
  }
  if (await fs.access(`${filesystemOutsideRoot}/created.txt`).then(() => true, () => false)) {
    throw new Error('edit_files create escaped cwd through a symlink parent');
  }

  const raceParent = `${filesystemRoot}/race-parent`;
  const raceMovedParent = `${filesystemOutsideRoot}/race-parent-moved`;
  const raceRedirect = `${filesystemOutsideRoot}/race-redirect`;
  await fs.rm(raceParent, { recursive: true, force: true });
  await fs.rm(raceMovedParent, { recursive: true, force: true });
  await fs.rm(raceRedirect, { recursive: true, force: true });
  await fs.mkdir(raceParent);
  await fs.mkdir(raceRedirect);
  let raceWatcher;
  let raceTimer;
  const parentSwap = new Promise((resolve, reject) => {
    const finish = (callback) => {
      if (raceTimer !== undefined) clearTimeout(raceTimer);
      raceWatcher?.close();
      callback();
    };
    raceWatcher = watch(raceParent, (_event, filename) => {
      if (typeof filename !== 'string' || !filename.includes('.edit-') || !filename.endsWith('.tmp')) return;
      raceWatcher.close();
      raceWatcher = undefined;
      (async () => {
        await fs.rename(raceParent, raceMovedParent);
        await fs.symlink(raceRedirect, raceParent);
      })().then(() => finish(resolve), (error) => finish(() => reject(error)));
    });
    raceTimer = setTimeout(() => finish(() => reject(new Error('edit_files parent-swap fixture did not observe a temp file'))), 5_000);
  });
  const parentSwapCall = client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: Array.from({ length: 64 }, (_, index) => ({
        action: 'create',
        path: `race-parent/file-${index}.txt`,
        content: `${'x'.repeat(128 * 1024)}\n`,
      })),
    },
  });
  const [parentSwapResult] = await Promise.all([parentSwapCall, parentSwap]);
  const parentSwapError = parseJsonToolResult(parentSwapResult).error;
  if (
    !parentSwapResult.isError ||
    !['SYMLINK_PATH', 'PARENT_NOT_FOUND'].includes(parentSwapError?.code)
  ) {
    throw new Error(`edit_files parent-swap race was not rejected safely: ${JSON.stringify(parseJsonToolResult(parentSwapResult))}`);
  }
  const redirectedEntries = await fs.readdir(raceRedirect);
  if (redirectedEntries.length !== 0) {
    throw new Error(`edit_files parent-swap race touched redirect tree: ${redirectedEntries.join(',')}`);
  }
  const movedEntries = await fs.readdir(raceMovedParent);
  if (movedEntries.some((name) => name.includes('.edit-') || name.startsWith('file-'))) {
    throw new Error(`edit_files parent-swap race left mutation artifacts: ${movedEntries.join(',')}`);
  }
  await fs.rm(raceParent, { force: true });
  await fs.rm(raceMovedParent, { recursive: true, force: true });
  await fs.rm(raceRedirect, { recursive: true, force: true });

  const singleRaceParent = `${filesystemRoot}/single-race-parent`;
  const singleRaceMovedParent = `${filesystemOutsideRoot}/single-race-parent-moved`;
  const singleRaceRedirect = `${filesystemOutsideRoot}/single-race-redirect`;
  await fs.rm(singleRaceParent, { recursive: true, force: true });
  await fs.rm(singleRaceMovedParent, { recursive: true, force: true });
  await fs.rm(singleRaceRedirect, { recursive: true, force: true });
  await fs.mkdir(singleRaceParent);
  await fs.mkdir(singleRaceRedirect);
  let singleRaceWatcher;
  let singleRaceTimer;
  const singleParentSwap = new Promise((resolve, reject) => {
    const finish = (callback) => {
      if (singleRaceTimer !== undefined) clearTimeout(singleRaceTimer);
      singleRaceWatcher?.close();
      callback();
    };
    singleRaceWatcher = watch(singleRaceParent, (_event, filename) => {
      if (typeof filename !== 'string' || !filename.includes('.edit-') || !filename.endsWith('.tmp')) return;
      singleRaceWatcher.close();
      singleRaceWatcher = undefined;
      (async () => {
        await fs.rename(singleRaceParent, singleRaceMovedParent);
        await fs.symlink(singleRaceRedirect, singleRaceParent);
      })().then(() => finish(resolve), (error) => finish(() => reject(error)));
    });
    singleRaceTimer = setTimeout(
      () => finish(() => reject(new Error('single edit_files parent-swap fixture did not observe a temp file'))),
      5_000,
    );
  });
  const singleParentSwapCall = client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [{
        action: 'create',
        path: 'single-race-parent/file.txt',
        content: `${'s'.repeat(4 * 1024 * 1024)}\n`,
      }],
    },
  });
  const [singleParentSwapResult] = await Promise.all([singleParentSwapCall, singleParentSwap]);
  const singleParentSwapError = parseJsonToolResult(singleParentSwapResult).error;
  if (
    !singleParentSwapResult.isError ||
    !['PARENT_MOVED', 'CWD_MOVED', 'SYMLINK_PATH', 'PARENT_NOT_FOUND'].includes(singleParentSwapError?.code)
  ) {
    throw new Error(`single edit_files parent-swap race was not rejected safely: ${JSON.stringify(parseJsonToolResult(singleParentSwapResult))}`);
  }
  const singleRedirectEntries = await fs.readdir(singleRaceRedirect);
  if (singleRedirectEntries.length !== 0) {
    throw new Error(`single edit_files parent-swap race touched redirect tree: ${singleRedirectEntries.join(',')}`);
  }
  const singleMovedEntries = await fs.readdir(singleRaceMovedParent);
  if (singleMovedEntries.some((name) => name.includes('.edit-') || name === 'file.txt')) {
    throw new Error(`single edit_files parent-swap race left mutation artifacts: ${singleMovedEntries.join(',')}`);
  }
  await fs.rm(singleRaceParent, { force: true });
  await fs.rm(singleRaceMovedParent, { recursive: true, force: true });
  await fs.rm(singleRaceRedirect, { recursive: true, force: true });

  const modeRaceParent = `${filesystemRoot}/mode-race-parent`;
  await fs.rm(modeRaceParent, { recursive: true, force: true });
  await fs.mkdir(modeRaceParent);
  const modeRacePath = `${modeRaceParent}/mode.txt`;
  const modeRaceOriginal = `before\n${'m'.repeat(4 * 1024 * 1024)}\n`;
  await fs.writeFile(modeRacePath, modeRaceOriginal, { mode: 0o644 });
  await fs.chmod(modeRacePath, 0o644);
  let modeRaceWatcher;
  let modeRaceTimer;
  const modeChanged = new Promise((resolve, reject) => {
    const finish = (callback) => {
      if (modeRaceTimer !== undefined) clearTimeout(modeRaceTimer);
      modeRaceWatcher?.close();
      callback();
    };
    modeRaceWatcher = watch(modeRaceParent, (_event, filename) => {
      if (typeof filename !== 'string' || !filename.includes('.edit-') || !filename.endsWith('.tmp')) return;
      modeRaceWatcher.close();
      modeRaceWatcher = undefined;
      fs.chmod(modeRacePath, 0o600).then(() => finish(resolve), (error) => finish(() => reject(error)));
    });
    modeRaceTimer = setTimeout(
      () => finish(() => reject(new Error('edit_files mode-race fixture did not observe a temp file'))),
      5_000,
    );
  });
  const modeRaceCall = client.callTool({
    name: 'edit_files',
    arguments: {
      cwd: filesystemRoot,
      files: [{
        path: 'mode-race-parent/mode.txt',
        edits: [{ type: 'replace', oldText: 'before', newText: 'after' }],
      }],
    },
  });
  const [modeRaceResult] = await Promise.all([modeRaceCall, modeChanged]);
  if (modeRaceResult.isError) {
    throw new Error(`edit_files mode race unexpectedly failed: ${JSON.stringify(parseJsonToolResult(modeRaceResult))}`);
  }
  if (((await fs.stat(modeRacePath)).mode & 0o777) !== 0o600) {
    throw new Error('edit_files restored stale preflight permissions over a concurrent chmod');
  }
  await fs.rm(modeRaceParent, { recursive: true, force: true });

  const cleanupRaceParent = `${filesystemRoot}/cleanup-race-parent`;
  await fs.rm(cleanupRaceParent, { recursive: true, force: true });
  await fs.mkdir(cleanupRaceParent);
  const cleanupRaceCount = 32;
  const cleanupRaceFiles = [];
  for (let index = 0; index < cleanupRaceCount; index += 1) {
    const content = `delete-${index}\n`;
    const relativePath = `cleanup-race-parent/delete-${index}.txt`;
    await fs.writeFile(path.join(filesystemRoot, relativePath), content, 'utf8');
    cleanupRaceFiles.push({
      action: 'delete',
      path: relativePath,
      ifMatch: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
  }
  const cleanupWriteRemoved = (async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const entries = await fs.readdir(cleanupRaceParent);
      const backups = entries.filter((name) => name.includes('.edit-') && name.endsWith('.bak'));
      if (backups.length === cleanupRaceCount) {
        await fs.chmod(cleanupRaceParent, 0o555);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('edit_files cleanup-race fixture did not observe all backup files');
  })();
  const cleanupRaceCall = client.callTool({
    name: 'edit_files',
    arguments: { cwd: filesystemRoot, files: cleanupRaceFiles },
  });
  const [cleanupRaceResult] = await Promise.all([cleanupRaceCall, cleanupWriteRemoved]);
  await fs.chmod(cleanupRaceParent, 0o755);
  const cleanupRaceError = parseJsonToolResult(cleanupRaceResult).error;
  if (!cleanupRaceResult.isError || cleanupRaceError?.code !== 'CLEANUP_FAILED') {
    throw new Error(`edit_files backup cleanup failure was not observable: ${JSON.stringify(parseJsonToolResult(cleanupRaceResult))}`);
  }
  const cleanupBackups = cleanupRaceError?.details?.backups;
  if (!Array.isArray(cleanupBackups) || cleanupBackups.length !== cleanupRaceCount) {
    throw new Error(`edit_files CLEANUP_FAILED did not report all recovery paths: ${JSON.stringify(cleanupRaceError)}`);
  }
  for (const backup of cleanupBackups) {
    if (typeof backup.backupPath !== 'string' || !backup.backupPath.startsWith('cleanup-race-parent/')) {
      throw new Error(`edit_files CLEANUP_FAILED reported an invalid recovery path: ${JSON.stringify(backup)}`);
    }
    if (!(await fs.stat(path.join(filesystemRoot, backup.backupPath))).isFile()) {
      throw new Error(`edit_files cleanup failure did not preserve reported backup: ${backup.backupPath}`);
    }
  }
  for (let index = 0; index < cleanupRaceCount; index += 1) {
    if (await fs.access(`${cleanupRaceParent}/delete-${index}.txt`).then(() => true, () => false)) {
      throw new Error('edit_files cleanup failure unexpectedly restored a deleted target');
    }
  }
  await fs.rm(cleanupRaceParent, { recursive: true, force: true });

  const cwdRelativePatch = `--- subdir/direct.txt
+++ subdir/direct.txt
@@ -1 +1 @@
-before
+after
`;
  await fs.writeFile(`${filesystemRoot}/subdir/direct.txt`, 'before\n', 'utf8');
  const cwdRelativeResult = parseJsonToolResult(
    await client.callTool({
      name: 'apply_patch',
      arguments: { patch: cwdRelativePatch, cwd: filesystemRoot },
    }),
  );
  if (
    (await fs.readFile(`${filesystemRoot}/subdir/direct.txt`, 'utf8')) !== 'after\n' ||
    cwdRelativeResult.pathStyle !== 'cwd' ||
    cwdRelativeResult.files[0]?.path !== 'subdir/direct.txt'
  ) {
    throw new Error('apply_patch cwd-relative path handling failed');
  }

  const exactPatch = `--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;
  const appliedPatch = parseJsonToolResult(
    await client.callTool({
      name: 'apply_patch',
      arguments: { patch: exactPatch, cwd: filesystemRoot, pathStyle: 'git' },
    }),
  );
  if (
    (await fs.readFile(`${filesystemRoot}/a.txt`, 'utf8')) !== 'one\nTWO\nthree\n' ||
    appliedPatch.pathStyle !== 'git' ||
    appliedPatch.files.length !== 1 ||
    appliedPatch.files[0].path !== 'a.txt' ||
    appliedPatch.files[0].additions !== 1 ||
    appliedPatch.files[0].deletions !== 1
  ) {
    throw new Error('apply_patch exact patch failed');
  }

  await fs.mkdir(`${filesystemRoot}/b`, { recursive: true });
  const ambiguousCreatePatch = `--- /dev/null
+++ b/ambiguous.txt
@@ -0,0 +1 @@
+cwd-b-directory
`;
  await expectToolFailure('apply_patch', { patch: ambiguousCreatePatch, cwd: filesystemRoot });
  if (
    await fs.access(`${filesystemRoot}/ambiguous.txt`).then(() => true, () => false) ||
    await fs.access(`${filesystemRoot}/b/ambiguous.txt`).then(() => true, () => false)
  ) {
    throw new Error('apply_patch ambiguous auto path style was not zero-write');
  }
  const explicitCwdCreate = parseJsonToolResult(
    await client.callTool({
      name: 'apply_patch',
      arguments: { patch: ambiguousCreatePatch, cwd: filesystemRoot, pathStyle: 'cwd' },
    }),
  );
  if (
    explicitCwdCreate.pathStyle !== 'cwd' ||
    (await fs.readFile(`${filesystemRoot}/b/ambiguous.txt`, 'utf8')) !== 'cwd-b-directory\n' ||
    await fs.access(`${filesystemRoot}/ambiguous.txt`).then(() => true, () => false)
  ) {
    throw new Error('apply_patch explicit cwd path style targeted the wrong path');
  }

  const explicitGitCreate = parseJsonToolResult(
    await client.callTool({
      name: 'apply_patch',
      arguments: { patch: ambiguousCreatePatch, cwd: filesystemRoot, pathStyle: 'git' },
    }),
  );
  if (
    explicitGitCreate.pathStyle !== 'git' ||
    (await fs.readFile(`${filesystemRoot}/ambiguous.txt`, 'utf8')) !== 'cwd-b-directory\n'
  ) {
    throw new Error('apply_patch explicit git path style did not strip synthetic prefixes');
  }

  await fs.writeFile(`${filesystemRoot}/marker-lines.txt`, 'before\n-- old\nafter\n', 'utf8');
  const markerContentPatch = `diff --git a/marker-lines.txt b/marker-lines.txt
--- a/marker-lines.txt
+++ b/marker-lines.txt
@@ -1,3 +1,3 @@
 before
--- old
+++ new
 after
`;
  const markerContentResult = parseJsonToolResult(
    await client.callTool({
      name: 'apply_patch',
      arguments: { patch: markerContentPatch, cwd: filesystemRoot },
    }),
  );
  if (
    markerContentResult.pathStyle !== 'git' ||
    (await fs.readFile(`${filesystemRoot}/marker-lines.txt`, 'utf8')) !== 'before\n++ new\nafter\n'
  ) {
    throw new Error('apply_patch misclassified hunk content as file headers');
  }

  const mixedStylePatch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-TWO
+two
 three
--- subdir/direct.txt
+++ subdir/direct.txt
@@ -1 +1 @@
-after
+before
`;
  await expectToolFailure('apply_patch', { patch: mixedStylePatch, cwd: filesystemRoot });
  if (
    (await fs.readFile(`${filesystemRoot}/a.txt`, 'utf8')) !== 'one\nTWO\nthree\n' ||
    (await fs.readFile(`${filesystemRoot}/subdir/direct.txt`, 'utf8')) !== 'after\n'
  ) {
    throw new Error('apply_patch mixed path style failure was not zero-write');
  }

  await fs.writeFile(`${filesystemRoot}/offset.txt`, 'zero\none\ntwo\nthree\n', 'utf8');
  const offsetPatch = `--- a/offset.txt
+++ b/offset.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;
  await expectToolFailure('apply_patch', { patch: offsetPatch, cwd: filesystemRoot, pathStyle: 'git' });
  if ((await fs.readFile(`${filesystemRoot}/offset.txt`, 'utf8')) !== 'zero\none\ntwo\nthree\n') {
    throw new Error('apply_patch offset mismatch modified target');
  }

  await fs.writeFile(`${filesystemRoot}/multi-a.txt`, 'a1\na2\n', 'utf8');
  await fs.writeFile(`${filesystemRoot}/multi-b.txt`, 'b1\nb2\n', 'utf8');
  const multiFailurePatch = `--- a/multi-a.txt
+++ b/multi-a.txt
@@ -1,2 +1,2 @@
 a1
-a2
+A2
--- a/multi-b.txt
+++ b/multi-b.txt
@@ -1,2 +1,2 @@
 WRONG
-b2
+B2
`;
  await expectToolFailure('apply_patch', { patch: multiFailurePatch, cwd: filesystemRoot, pathStyle: 'git' });
  if (
    (await fs.readFile(`${filesystemRoot}/multi-a.txt`, 'utf8')) !== 'a1\na2\n' ||
    (await fs.readFile(`${filesystemRoot}/multi-b.txt`, 'utf8')) !== 'b1\nb2\n'
  ) {
    throw new Error('apply_patch multi-file failure was not zero-write');
  }

  await fs.writeFile(`${filesystemRoot}/delete.txt`, 'delete-me\n', 'utf8');
  const createDeletePatch = `--- /dev/null
+++ created.txt
@@ -0,0 +1 @@
+created
--- delete.txt
+++ /dev/null
@@ -1 +0,0 @@
-delete-me
`;
  await client.callTool({
    name: 'apply_patch',
    arguments: { patch: createDeletePatch, cwd: filesystemRoot },
  });
  if ((await fs.readFile(`${filesystemRoot}/created.txt`, 'utf8')) !== 'created\n') {
    throw new Error('apply_patch create failed');
  }
  try {
    await fs.access(`${filesystemRoot}/delete.txt`);
    throw new Error('apply_patch delete failed');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await fs.writeFile(`${filesystemRoot}/mode-only.txt`, 'mode\n', { mode: 0o644 });
  const modeOnlyPatch = `diff --git a/mode-only.txt b/mode-only.txt
old mode 100644
new mode 100755
`;
  await client.callTool({
    name: 'apply_patch',
    arguments: { patch: modeOnlyPatch, cwd: filesystemRoot },
  });
  if (((await fs.stat(`${filesystemRoot}/mode-only.txt`)).mode & 0o777) !== 0o755) {
    throw new Error('apply_patch git-style mode-only patch failed');
  }

  const traversalName = `agent-mcp-traversal-${process.pid}.txt`;
  const traversalPatch = `--- /dev/null
+++ b/../${traversalName}
@@ -0,0 +1 @@
+escape
`;
  await expectToolFailure('apply_patch', { patch: traversalPatch, cwd: filesystemRoot, pathStyle: 'git' });
  try {
    await fs.access(`/tmp/${traversalName}`);
    throw new Error('apply_patch traversal escaped cwd');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const symlinkEscapePatch = `--- a/outside-link/outside.txt
+++ b/outside-link/outside.txt
@@ -1 +1 @@
-outside
+escaped
`;
  await expectToolFailure('apply_patch', { patch: symlinkEscapePatch, cwd: filesystemRoot, pathStyle: 'git' });
  if ((await fs.readFile(`${filesystemOutsideRoot}/outside.txt`, 'utf8')) !== 'outside\n') {
    throw new Error('apply_patch followed a symlink outside cwd');
  }

  await fs.writeFile(`${filesystemRoot}/cancel.txt`, 'before\n', 'utf8');
  const cancellationPatch = `--- a/cancel.txt
+++ b/cancel.txt
@@ -1 +1 @@
-before
+after
`;
  await fs.writeFile(gitValidationTriggerPath, '1\n', 'utf8');
  const patchAbortController = new AbortController();
  const cancellablePatch = client.callTool(
    {
      name: 'apply_patch',
      arguments: { patch: cancellationPatch, cwd: filesystemRoot, pathStyle: 'git' },
    },
    { signal: patchAbortController.signal },
  );
  let validationPid;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      validationPid = Number((await fs.readFile(gitValidationPidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(validationPid)) {
    throw new Error('apply_patch cancellation validation subprocess did not start');
  }
  patchAbortController.abort();
  let patchWasCancelled = false;
  try {
    await cancellablePatch;
  } catch {
    patchWasCancelled = true;
  }
  if (!patchWasCancelled) throw new Error('apply_patch cancellation did not reject the client call');
  await fs.rm(gitValidationTriggerPath, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if ((await fs.readFile(`${filesystemRoot}/cancel.txt`, 'utf8')) !== 'before\n') {
    throw new Error('apply_patch cancellation during validation mutated target');
  }

  const importFileTool = allTools.find((tool) => tool.name === 'import_file');
  const importFileParams = importFileTool?._meta?.['openai/fileParams'];
  if (hostKind === 'chatgpt') {
    if (allTools.some((tool) => tool.name === 'skill_list' || tool.name === 'skill_read')) {
      throw new Error('ChatGPT host unexpectedly exposes projected-skill compatibility tools');
    }
    if (importFileParams?.[0] !== 'file') {
      throw new Error('import_file ChatGPT fileParams metadata missing');
    }
  } else if (importFileParams !== undefined) {
    throw new Error('generic host unexpectedly exposes ChatGPT fileParams metadata');
  }

  importServer = http.createServer((request, response) => {
    if (request.url === '/fixture') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': String(importPayload.length),
      });
      response.end(importPayload);
      return;
    }

    if (request.url === '/slow-fixture') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      response.write(chunk);
      const timer = setInterval(() => response.write(chunk), 50);
      timer.unref();
      response.once('close', () => clearInterval(timer));
      return;
    }

    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    importServer.once('error', reject);
    importServer.listen(0, '127.0.0.1', resolve);
  });
  const importAddress = importServer.address();
  if (!importAddress || typeof importAddress === 'string') throw new Error('import_file smoke server failed to listen');
  const imported = await client.callTool({
    name: 'import_file',
    arguments: {
      file: {
        download_url: `http://127.0.0.1:${importAddress.port}/fixture`,
        file_id: 'file-smoke',
        mime_type: 'text/plain',
        file_name: 'fixture.txt',
      },
      destination: importedFilePath,
    },
  });
  const importedText = imported.content?.find((item) => item.type === 'text')?.text ?? '';
  const importedResult = JSON.parse(importedText);
  const expectedImportHash = createHash('sha256').update(importPayload).digest('hex');
  if (
    importedResult.path !== importedFilePath ||
    importedResult.bytes !== importPayload.length ||
    importedResult.sha256 !== expectedImportHash ||
    (await fs.readFile(importedFilePath, 'utf8')) !== importPayload.toString('utf8')
  ) {
    throw new Error('import_file smoke failed');
  }

  await fs.writeFile(cancelledImportPath, 'preserve-existing-destination\n', 'utf8');
  const importAbortController = new AbortController();
  const cancelledImport = client.callTool(
    {
      name: 'import_file',
      arguments: {
        file: {
          download_url: `http://127.0.0.1:${importAddress.port}/slow-fixture`,
          file_id: 'file-cancel-smoke',
          mime_type: 'application/octet-stream',
          file_name: 'cancel.bin',
        },
        destination: cancelledImportPath,
        overwrite: true,
      },
    },
    { signal: importAbortController.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 125));
  importAbortController.abort();
  let importWasCancelled = false;
  try {
    await cancelledImport;
  } catch {
    importWasCancelled = true;
  }
  if (!importWasCancelled) throw new Error('import_file cancellation did not reject the client call');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if ((await fs.readFile(cancelledImportPath, 'utf8')) !== 'preserve-existing-destination\n') {
    throw new Error('import_file cancellation modified the existing destination');
  }
  const cancelledImportTempPrefix = `.${cancelledImportPath.split('/').at(-1)}.import-`;
  if ((await fs.readdir('/tmp')).some((name) => name.startsWith(cancelledImportTempPrefix))) {
    throw new Error('import_file cancellation left a temporary file');
  }

  const smallExec = parseJsonToolResult(
    await client.callTool({
      name: 'exec',
      arguments: { command: "printf 'small-out'; printf 'small-err' >&2" },
    }),
  );
  if (
    smallExec.stdout !== 'small-out' ||
    smallExec.stderr !== 'small-err' ||
    smallExec.stdoutBytes !== Buffer.byteLength('small-out') ||
    smallExec.stderrBytes !== Buffer.byteLength('small-err') ||
    smallExec.stdoutTruncated ||
    smallExec.stderrTruncated ||
    smallExec.stdoutArtifact !== null ||
    smallExec.stderrArtifact !== null
  ) {
    throw new Error('small exec output no longer preserves inline compatibility/metadata');
  }

  const expectedLargeStdout = `BEGIN_ARTIFACT_TEST\n${'o'.repeat(200_000)}\nEND_ARTIFACT_TEST\n`;
  const expectedLargeStderr = `ERR_HEAD\n${'e'.repeat(150_000)}\nERR_TAIL\n`;
  const largeExecResult = await client.callTool({
    name: 'exec',
    arguments: {
      command:
        `${node} -e "process.stdout.write('BEGIN_ARTIFACT_TEST\\n'+'o'.repeat(200000)+'\\nEND_ARTIFACT_TEST\\n');` +
        `process.stderr.write('ERR_HEAD\\n'+'e'.repeat(150000)+'\\nERR_TAIL\\n')"`,
    },
  });
  const largeExec = parseJsonToolResult(largeExecResult);
  if (
    !largeExec.stdoutTruncated ||
    !largeExec.stderrTruncated ||
    largeExec.stdoutBytes !== Buffer.byteLength(expectedLargeStdout) ||
    largeExec.stderrBytes !== Buffer.byteLength(expectedLargeStderr) ||
    !largeExec.stdout.startsWith('BEGIN_ARTIFACT_TEST\n') ||
    !largeExec.stdout.endsWith('\nEND_ARTIFACT_TEST\n') ||
    !largeExec.stderr.startsWith('ERR_HEAD\n') ||
    !largeExec.stderr.endsWith('\nERR_TAIL') ||
    !largeExec.stdout.includes('bytes omitted from inline preview') ||
    !largeExec.stderr.includes('bytes omitted from inline preview')
  ) {
    throw new Error('large exec head/tail preview or observed-byte metadata is incorrect');
  }
  if (
    !largeExec.stdoutArtifact ||
    !largeExec.stderrArtifact ||
    largeExec.stdoutArtifact.truncated ||
    largeExec.stderrArtifact.truncated ||
    largeExec.stdoutArtifact.observedBytes !== largeExec.stdoutBytes ||
    largeExec.stderrArtifact.observedBytes !== largeExec.stderrBytes ||
    largeExec.stdoutArtifact.uri === largeExec.stderrArtifact.uri
  ) {
    throw new Error('large exec did not expose independent complete stdout/stderr artifacts');
  }
  const largeLinks = largeExecResult.content?.filter((item) => item.type === 'resource_link') ?? [];
  if (largeLinks.length !== 0) {
    throw new Error('large exec artifacts unexpectedly exposed user-facing resource links');
  }
  const largeStdoutHeadResult = await client.callTool({
    name: 'read_artifact',
    arguments: { uri: largeExec.stdoutArtifact.uri, offset: 0, maxBytes: 64 },
  });
  const largeStdoutHead = JSON.parse(
    largeStdoutHeadResult.content?.find((item) => item.type === 'text')?.text ?? '{}',
  );
  if (
    largeStdoutHead.uri !== largeExec.stdoutArtifact.uri ||
    !largeStdoutHead.text.startsWith('BEGIN_ARTIFACT_TEST\n') ||
    largeStdoutHead.nextOffset !== 64 ||
    largeStdoutHead.done ||
    largeStdoutHeadResult.content?.some((item) => item.type === 'resource_link')
  ) {
    throw new Error('Oversized exec artifact head was not available through bounded model-only reads');
  }
  const tailOffset = Math.max(0, largeExec.stdoutArtifact.size - 64);
  const largeStdoutTailResult = await client.callTool({
    name: 'read_artifact',
    arguments: { uri: largeExec.stdoutArtifact.uri, offset: tailOffset, maxBytes: 64 },
  });
  const largeStdoutTail = JSON.parse(
    largeStdoutTailResult.content?.find((item) => item.type === 'text')?.text ?? '{}',
  );
  if (
    largeStdoutTail.uri !== largeExec.stdoutArtifact.uri ||
    !largeStdoutTail.text.endsWith('END_ARTIFACT_TEST\n') ||
    !largeStdoutTail.done ||
    largeStdoutTailResult.content?.some((item) => item.type === 'resource_link')
  ) {
    throw new Error('Oversized exec artifact tail was not available through bounded model-only reads');
  }
  await expectToolFailure('read_artifact', {
    uri: 'artifact://agent-vm/art-00000000-0000-4000-8000-000000000000',
  });
  await expectToolFailure('read_artifact', { uri: '/tmp/not-an-artifact.txt' });
  const explicitlyPresentedExecArtifact = await client.callTool({
    name: 'present_artifact',
    arguments: { uri: largeExec.stdoutArtifact.uri },
  });
  const explicitExecLink = explicitlyPresentedExecArtifact.content?.find((item) => item.type === 'resource_link');
  if (explicitExecLink?.uri !== largeExec.stdoutArtifact.uri) {
    throw new Error('present_artifact did not explicitly expose the existing exec artifact');
  }
  const largeStdoutResource = await client.readResource({ uri: largeExec.stdoutArtifact.uri });
  const largeStderrResource = await client.readResource({ uri: largeExec.stderrArtifact.uri });
  if (
    largeStdoutResource.contents?.[0]?.text !== expectedLargeStdout ||
    largeStderrResource.contents?.[0]?.text !== expectedLargeStderr
  ) {
    throw new Error('complete exec artifact round-trip failed');
  }

  const expectedHardStdout = `HARD_HEAD\n${'z'.repeat(300_000)}\nHARD_TAIL\n`;
  const hardExecResult = await client.callTool({
    name: 'exec',
    arguments: {
      command: `${node} -e "process.stdout.write('HARD_HEAD\\n'+'z'.repeat(300000)+'\\nHARD_TAIL\\n')"`,
    },
  });
  const hardExec = parseJsonToolResult(hardExecResult);
  if (
    !hardExec.stdoutTruncated ||
    hardExec.stdoutBytes !== Buffer.byteLength(expectedHardStdout) ||
    !hardExec.stdout.endsWith('\nHARD_TAIL\n') ||
    !hardExec.stdoutArtifact?.truncated ||
    hardExec.stdoutArtifact.size !== smokeArtifactMaxBytes ||
    hardExec.stdoutArtifact.capturedBytes !== smokeArtifactMaxBytes ||
    hardExec.stdoutArtifact.hardLimitBytes !== smokeArtifactMaxBytes ||
    hardExec.stdoutArtifact.observedBytes !== hardExec.stdoutBytes ||
    hardExec.stderrArtifact !== null
  ) {
    throw new Error('exec artifact hard-bound metadata/tail preservation is incorrect');
  }
  const hardStdoutResource = await client.readResource({ uri: hardExec.stdoutArtifact.uri });
  if (
    hardStdoutResource.contents?.[0]?.text?.length !== smokeArtifactMaxBytes ||
    !hardStdoutResource.contents[0].text.startsWith('HARD_HEAD\n')
  ) {
    throw new Error('bounded exec artifact did not retain the expected stream prefix');
  }

  const timeoutExec = await client.callTool({
    name: 'exec',
    arguments: {
      command: `${node} -e "process.stdout.write('t'.repeat(150000))"; sleep 5`,
      timeoutMs: 1000,
    },
  });
  const timeoutExecText = timeoutExec.content?.find((item) => item.type === 'text')?.text ?? '';
  const timeoutExecResult = JSON.parse(timeoutExecText);
  if (
    !timeoutExecResult.timedOut ||
    timeoutExecResult.cancelled ||
    !timeoutExecResult.stdoutTruncated ||
    timeoutExecResult.stdoutBytes !== 150_000 ||
    !timeoutExecResult.stdoutArtifact ||
    timeoutExecResult.stdoutArtifact.truncated
  ) {
    throw new Error('exec timeout/cancellation diagnostics or spill preservation are incorrect');
  }

  const execAbortController = new AbortController();
  const cancellableExec = client.callTool(
    {
      name: 'exec',
      arguments: {
        command:
          `${node} -e "process.stdout.write('c'.repeat(150000))"; ` +
          `trap 'echo terminated > ${execCancelMarkerPath}; exit 0' TERM; ` +
          `echo $$ > ${execCancelPidPath}; while :; do sleep 1; done`,
        timeoutMs: 10_000,
      },
    },
    { signal: execAbortController.signal },
  );
  let execPid;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      execPid = Number((await fs.readFile(execCancelPidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(execPid)) throw new Error('exec cancellation command did not start');
  execAbortController.abort();
  let execWasCancelled = false;
  try {
    await cancellableExec;
  } catch {
    execWasCancelled = true;
  }
  if (!execWasCancelled) throw new Error('exec cancellation did not reject the client call');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.access(execCancelMarkerPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if ((await fs.readFile(execCancelMarkerPath, 'utf8')).trim() !== 'terminated') {
    throw new Error('exec cancellation did not terminate the process group');
  }
  const execExitDeadline = Date.now() + 2_000;
  let execStillAlive = true;
  while (Date.now() < execExitDeadline) {
    try {
      process.kill(execPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      execStillAlive = false;
      break;
    }
  }
  if (execStillAlive) {
    throw new Error('exec cancellation left the shell process running');
  }

  const artifactReadTool = allTools.find((tool) => tool.name === 'read_artifact');
  if (!artifactReadTool) throw new Error('read_artifact tool missing');
  const presentArtifactTool = allTools.find((tool) => tool.name === 'present_artifact');
  if (!presentArtifactTool) throw new Error('present_artifact tool missing');
  const presentFileTool = allTools.find((tool) => tool.name === 'present_file');
  if (!presentFileTool) throw new Error('present_file tool missing');
  for (const tool of [artifactReadTool, presentArtifactTool, presentFileTool]) {
    if (tool._meta?.ui?.resourceUri || tool._meta?.['openai/outputTemplate']) {
      throw new Error(`${tool.name} still exposes obsolete Artifact Viewer metadata`);
    }
  }
  if (names.includes('artifact_viewer_read') || names.includes('artifact_viewer_relay_probe')) {
    throw new Error('Obsolete Artifact Viewer tools are still registered');
  }

  const screenshotTool = allTools.find((tool) => tool.name === 'browser_take_screenshot');
  if (liveIntegrations) {
    if (!screenshotTool) throw new Error('browser_take_screenshot tool missing in live integration mode');
    if (screenshotTool._meta?.ui?.resourceUri || screenshotTool._meta?.['openai/outputTemplate']) {
      throw new Error('browser_take_screenshot still exposes obsolete Artifact Viewer metadata');
    }
  }

  const presented = await client.callTool({
    name: 'present_file',
    arguments: { path: presentFilePath, name: 'smoke.txt' },
  });
  const textArtifact = presented._meta?.[artifactMetaKey];
  if (!textArtifact?.uri?.startsWith('artifact://agent-vm/art-')) {
    throw new Error('present_file artifact metadata missing');
  }
  if (textArtifact.name !== 'smoke.txt' || textArtifact.mimeType !== 'text/plain') {
    throw new Error('present_file artifact metadata incorrect');
  }
  if (JSON.stringify(textArtifact).includes(presentFilePath)) {
    throw new Error('present_file leaked VM filesystem path');
  }
  const textLink = presented.content?.find((item) => item.type === 'resource_link');
  if (
    textLink?.uri !== textArtifact.uri ||
    textLink?.name !== textArtifact.name ||
    textLink?.mimeType !== textArtifact.mimeType ||
    textLink?.size !== textArtifact.size
  ) {
    throw new Error('present_file did not expose a matching MCP resource_link for text');
  }
  const embeddedText = presented.content?.find((item) => item.type === 'resource')?.resource?.text;
  if (!embeddedText?.includes('artifact smoke text')) {
    throw new Error('present_file did not expose small text content to the model');
  }
  const textResource = await client.readResource({ uri: textArtifact.uri });
  if (textResource.contents?.[0]?.text !== 'artifact smoke text\nline two\n') {
    throw new Error('Text artifact resource round-trip failed');
  }

  const presentedBinary = await client.callTool({
    name: 'present_file',
    arguments: { path: presentBinaryPath, name: 'smoke.bin' },
  });
  const binaryArtifact = presentedBinary._meta?.[artifactMetaKey];
  const binaryLink = presentedBinary.content?.find((item) => item.type === 'resource_link');
  if (
    binaryArtifact?.name !== 'smoke.bin' ||
    binaryLink?.uri !== binaryArtifact?.uri ||
    binaryLink?.name !== 'smoke.bin' ||
    binaryLink?.size !== 4
  ) {
    throw new Error('present_file did not expose a matching MCP resource_link for binary content');
  }
  if (presentedBinary.content?.some((item) => item.type === 'resource')) {
    throw new Error('Binary present_file unexpectedly embedded the full resource inline');
  }
  const binaryResource = await client.readResource({ uri: binaryArtifact.uri });
  if (binaryResource.contents?.[0]?.blob !== Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('base64')) {
    throw new Error('Binary present_file resource round-trip failed');
  }

  const serverInfoTool = allTools.find((tool) => tool.name === 'server_info');
  if (!serverInfoTool) throw new Error('server_info tool missing');
  const serverInfo = parseJsonToolResult(await client.callTool({ name: 'server_info', arguments: {} }));
  if (
    serverInfo.server?.name !== 'agent-vm-control' ||
    serverInfo.server?.version !== '0.6.0' ||
    typeof serverInfo.server?.startedAt !== 'string' ||
    typeof serverInfo.server?.pid !== 'number'
  ) {
    throw new Error('server_info runtime identity is incomplete');
  }
  if (
    !/^sha256:[0-9a-f]{64}$/.test(serverInfo.catalog?.marker ?? '') ||
    serverInfo.catalog?.totalToolCount !== allTools.length ||
    serverInfo.catalog?.hashedToolCount !== allTools.length - 1 ||
    !Array.isArray(serverInfo.catalog?.toolNames) ||
    serverInfo.catalog.toolNames.length !== allTools.length ||
    !serverInfo.catalog.toolNames.includes('server_info')
  ) {
    throw new Error('server_info catalog identity is incomplete');
  }
  if (!serverInfoTool.description?.includes(serverInfo.catalog.marker)) {
    throw new Error('server_info tool-definition marker does not match the running catalog marker');
  }
  const observedCatalogIdentity = catalogIdentityFromTools(allTools);
  if (observedCatalogIdentity.hash !== serverInfo.catalog.hash) {
    throw new Error('server_info catalog hash does not match the actual tools/list projection');
  }
  if (serverInfo.server.revision !== null && !/^[0-9a-f]{40}$/i.test(serverInfo.server.revision)) {
    throw new Error('server_info revision is not a full Git commit hash');
  }

  const commandInfoNames = ['git', 'pnpm', 'definitely-not-an-agent-command'];
  if (liveIntegrations) commandInfoNames.splice(1, 0, 'mise');
  const commandInfo = await client.callTool({
    name: 'command_info',
    arguments: { names: commandInfoNames },
  });
  const commandInfoText = commandInfo.content?.find((item) => item.type === 'text')?.text ?? '';
  const inspectedCommands = JSON.parse(commandInfoText).commands;
  const git = inspectedCommands.find((command) => command.name === 'git');
  const mise = inspectedCommands.find((command) => command.name === 'mise');
  const pnpm = inspectedCommands.find((command) => command.name === 'pnpm');
  const missing = inspectedCommands.find((command) => command.name === 'definitely-not-an-agent-command');
  if (!git?.available || !git.curated || !git.version) throw new Error('git command_info failed');
  if (liveIntegrations && (!mise?.available || !mise.curated || !mise.version)) {
    throw new Error('mise command_info failed');
  }
  if (!pnpm?.available || !pnpm.curated || !pnpm.version) throw new Error('pnpm command_info failed');
  if (missing?.available || missing?.curated) throw new Error('missing command_info failed');

  const capabilities = await client.callTool({ name: 'capabilities', arguments: {} });
  const capabilitiesText = capabilities.content?.find((item) => item.type === 'text')?.text ?? '';
  const capabilityData = JSON.parse(capabilitiesText);
  if (!capabilityData.execution?.persistentProcesses) throw new Error('persistent process capability missing');
  for (const name of ['read_artifact', 'present_artifact', 'present_file']) {
    if (!capabilityData.mcp?.nativeTools?.includes(name)) throw new Error(`${name} capability missing`);
  }
  if (!capabilityData.runtimes?.some((runtime) => runtime.name === 'node' && runtime.available)) {
    throw new Error('node runtime capability missing');
  }
  if (liveIntegrations) {
    if (!capabilityData.runtimes?.some((runtime) => runtime.name === 'mise' && runtime.available)) {
      throw new Error('mise runtime capability missing');
    }
    const docker = capabilityData.cli?.categories?.container?.find((command) => command.name === 'docker');
    if (!docker?.available || !docker.version) throw new Error('docker capability missing');
    const compose = capabilityData.cli?.probes?.find((probe) => probe.name === 'docker-compose');
    if (!compose?.available || !compose.version) throw new Error('docker compose capability missing');
    const buildx = capabilityData.cli?.probes?.find((probe) => probe.name === 'docker-buildx');
    if (!buildx?.available || !buildx.version) throw new Error('docker buildx capability missing');
  }

  const status = await client.callTool({ name: 'mcp_bridge_status', arguments: {} });
  const statusText = status.content?.find((item) => item.type === 'text')?.text ?? '';
  const parsed = JSON.parse(statusText);
  let liveSummary = null;
  if (liveIntegrations) {
    const playwright = parsed.bridges.find((bridge) => bridge.id === 'playwright');
    if (playwright?.state !== 'connected') throw new Error('Playwright bridge not connected');
    const lsp = parsed.bridges.find((bridge) => bridge.id === 'lsp');
    if (lsp?.state !== 'connected' || lsp.tools?.length !== expectedLspTools.length) {
      throw new Error('LSP bridge not connected with the expected read-only surface');
    }
    const capabilityLsp = capabilityData.mcp?.bridges?.find((bridge) => bridge.id === 'lsp');
    if (capabilityLsp?.state !== 'connected' || capabilityLsp.tools?.length !== expectedLspTools.length) {
      throw new Error('LSP bridge capability metadata missing');
    }
    liveSummary = { playwrightTools: playwright.tools.length, lspTools: lsp.tools.length, artifactName: null };
  } else if (parsed.bridges.length !== 0) {
    throw new Error(`Portable smoke unexpectedly connected bridges: ${parsed.bridges.map((bridge) => bridge.id).join(',')}`);
  }

  if (liveIntegrations) {
  const lspConfig = JSON.parse(await fs.readFile(path.join(process.env.HOME, '.config/lsp-mcp/config.json'), 'utf8'));
  if (
    lspConfig.downloads?.enabled !== false ||
    lspConfig.commands?.enabled !== false ||
    lspConfig.security?.allowExternalFiles !== false ||
    lspConfig.lsp?.servers?.typescript?.profile !== 'system'
  ) {
    throw new Error('Controlled LSP MCP safety configuration is not enforced');
  }

  const lspCall = async (name, args) => {
    const tool = allTools.find((candidate) => candidate.name === name);
    return client.callTool(
      { name, arguments: args },
      tool ? { toolDefinition: tool } : undefined,
    );
  };
  const lspJson = async (name, args) => parseJsonToolResult(await lspCall(name, args));
  const lspEventually = async (name, args, predicate, description, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        lastValue = await lspJson(name, args);
        lastError = null;
        if (predicate(lastValue)) return lastValue;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const detail = lastError
      ? String(lastError?.stack ?? lastError)
      : JSON.stringify(lastValue).slice(0, 2_000);
    throw new Error(`${description} within ${timeoutMs}ms; last=${detail}`);
  };
  const workspaceAMain = path.join(lspWorkspaceA, 'src/main.ts');
  const workspaceALib = path.join(lspWorkspaceA, 'src/lib.ts');
  const workspaceBMain = path.join(lspWorkspaceB, 'src/main.ts');

  const hoverAArgs = {
    workspaceRoot: lspWorkspaceA,
    filePath: workspaceAMain,
    line: 2,
    character: 23,
  };
  await lspEventually(
    'lsp_hover',
    hoverAArgs,
    (value) => JSON.stringify(value).includes('greet'),
    'LSP hover did not become ready in workspace A',
  );

  await lspEventually(
    'lsp_definition',
    hoverAArgs,
    (value) => JSON.stringify(value).includes(workspaceALib),
    'LSP definition did not resolve workspace A declaration',
  );

  const referencesAArgs = {
    ...hoverAArgs,
    includeDeclaration: true,
  };
  await lspEventually(
    'lsp_references',
    referencesAArgs,
    (value) => {
      const text = JSON.stringify(value);
      return text.includes(workspaceAMain) && text.includes(workspaceALib);
    },
    'LSP references did not include workspace A usage and declaration',
  );

  await lspEventually(
    'lsp_document_symbols',
    { workspaceRoot: lspWorkspaceA, filePath: workspaceALib },
    (value) => JSON.stringify(value).includes('greet'),
    'LSP document symbols did not become ready in workspace A',
  );

  await lspEventually(
    'lsp_workspace_symbols',
    { workspaceRoot: lspWorkspaceA, filePath: workspaceAMain, query: 'greet' },
    (value) => {
      const text = JSON.stringify(value);
      return text.includes('greet') && !text.includes(lspWorkspaceB);
    },
    'LSP workspace symbols did not stabilize for workspace A',
  );

  await lspEventually(
    'lsp_diagnostics',
    { workspaceRoot: lspWorkspaceA, filePath: workspaceAMain },
    (value) => {
      const text = JSON.stringify(value);
      return text.includes('Type') || text.includes('assignable');
    },
    'LSP diagnostics did not report the intentional TypeScript error',
  );

  await lspEventually(
    'lsp_hover',
    { workspaceRoot: lspWorkspaceB, filePath: workspaceBMain, line: 2, character: 24 },
    (value) => {
      const text = JSON.stringify(value);
      return text.includes('square') && !text.includes('greet');
    },
    'LSP workspace B hover did not stabilize',
  );

  await lspEventually(
    'lsp_workspace_symbols',
    { workspaceRoot: lspWorkspaceB, filePath: workspaceBMain, query: 'square' },
    (value) => {
      const text = JSON.stringify(value);
      return text.includes('square') && !text.includes(lspWorkspaceA);
    },
    'LSP workspace B symbols did not stabilize',
  );

  await expectToolFailure('lsp_hover', {
    workspaceRoot: lspDeniedWorkspace,
    filePath: path.join(lspDeniedWorkspace, 'src/main.ts'),
    line: 1,
    character: 7,
    serverId: 'malicious',
  });
  try {
    await fs.access(lspDeniedMarker);
    throw new Error('Repo-local LSP config command executed despite host deny policy');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await fs.rename(
    path.join(lspDeniedWorkspace, '.lsp-mcp.json'),
    path.join(lspDeniedWorkspace, '.lsp-mcp.jsonc'),
  );
  await expectToolFailure('lsp_hover', {
    workspaceRoot: lspDeniedWorkspace,
    filePath: path.join(lspDeniedWorkspace, 'src/main.ts'),
    line: 1,
    character: 7,
    serverId: 'malicious',
  });
  try {
    await fs.access(lspDeniedMarker);
    throw new Error('Repo-local JSONC LSP config command executed despite host deny policy');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const missingCacheBefore = await fs.readdir(lspManagedCacheRoot).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const missingServer = await lspCall('lsp_hover', {
    workspaceRoot: lspMissingWorkspace,
    filePath: path.join(lspMissingWorkspace, 'fixture.yaml'),
    line: 1,
    character: 1,
    serverId: 'yaml-language-server',
  });
  const missingServerText = missingServer.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n') ?? '';
  let missingServerJson = null;
  try {
    missingServerJson = JSON.parse(missingServerText);
  } catch {
    // A protocol-level error result is also an observable failure path.
  }
  const missingServerFailedObservably = Boolean(
    missingServerJson?.ok === false &&
    missingServerJson?.results?.acquisition?.ok === false &&
    /downloads are disabled/i.test(missingServerJson.results.acquisition.error ?? ''),
  );
  if (!missingServer.isError && !missingServerFailedObservably) {
    throw new Error(`Missing LSP server did not fail observably: ${missingServerText}`);
  }
  const missingCacheAfter = await fs.readdir(lspManagedCacheRoot).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  if (JSON.stringify(missingCacheAfter.sort()) !== JSON.stringify(missingCacheBefore.sort())) {
    throw new Error('Missing LSP server triggered a managed download despite downloads.enabled=false');
  }

  const navigate = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  });
  const navText = navigate.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
  if (!navText.includes('Example Domain')) throw new Error('browser_navigate smoke failed');

  const screenshot = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: { type: 'png', scale: 'css' },
  });
  if (screenshot.isError) throw new Error('browser_take_screenshot smoke returned an error');
  const screenshotArtifact = screenshot._meta?.[artifactMetaKey];
  if (!screenshotArtifact?.uri?.startsWith('artifact://agent-vm/art-')) {
    throw new Error('browser_take_screenshot artifact metadata missing');
  }
  if (!screenshotArtifact.name.endsWith('.png') || screenshotArtifact.mimeType !== 'image/png') {
    throw new Error('browser_take_screenshot artifact metadata incorrect');
  }
  const sameTurnImage = screenshot.content?.find((item) => item.type === 'image');
  if (sameTurnImage?.mimeType !== 'image/png' || !sameTurnImage.data?.startsWith('iVBORw0KGgo')) {
    throw new Error('browser_take_screenshot did not expose standard MCP image content');
  }
  const artifactLink = screenshot.content?.find((item) => item.type === 'resource_link');
  if (artifactLink) {
    throw new Error('browser_take_screenshot unexpectedly exposed a user-facing resource_link');
  }
  const modelImageRead = await client.callTool({
    name: 'read_artifact',
    arguments: { uri: screenshotArtifact.uri },
  });
  const modelImage = modelImageRead.content?.find((item) => item.type === 'image');
  if (modelImage?.mimeType !== 'image/png' || !modelImage.data?.startsWith('iVBORw0KGgo')) {
    throw new Error('read_artifact did not return the screenshot for model-only image inspection');
  }
  const screenshotResource = await client.readResource({ uri: screenshotArtifact.uri });
  const pngBlob = screenshotResource.contents?.[0]?.blob ?? '';
  if (!pngBlob.startsWith('iVBORw0KGgo')) {
    throw new Error('Screenshot artifact binary round-trip failed');
  }

  const explicitScreenshot = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: { filename: 'smoke-explicit.webp', type: 'webp', scale: 'css' },
  });
  const explicitArtifact = explicitScreenshot._meta?.[artifactMetaKey];
  if (explicitArtifact?.name !== 'smoke-explicit.webp' || explicitArtifact.mimeType !== 'image/webp') {
    throw new Error('Explicit screenshot filename adapter failed');
  }
  const explicitResource = await client.readResource({ uri: explicitArtifact.uri });
  if (!(explicitResource.contents?.[0]?.blob?.length > 100)) {
    throw new Error('Explicit screenshot artifact resource missing');
  }
  liveSummary.artifactName = screenshotArtifact.name;
  }

  const blockedRawExec = await client.callTool({
    name: 'exec',
    arguments: { command: 'env REVIEW=1 codex exec --ephemeral -' },
  });
  if (!blockedRawExec.isError) throw new Error('exec unexpectedly allowed raw Codex agent work');
  const blockedRawExecText = blockedRawExec.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!blockedRawExecText.includes('agent_start')) {
    throw new Error('exec raw-harness rejection did not direct the caller to agent_start');
  }

  const blockedRawProcess = await client.callTool({
    name: 'process_start',
    arguments: { command: 'nohup /usr/local/bin/agy --print review &' },
  });
  if (!blockedRawProcess.isError) throw new Error('process_start unexpectedly allowed raw Agy agent work');
  const blockedRawProcessText = blockedRawProcess.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!blockedRawProcessText.includes('agent_start')) {
    throw new Error('process_start raw-harness rejection did not direct the caller to agent_start');
  }

  if (hostKind === 'chatgpt') {
    const blockedTmuxExec = await client.callTool({
      name: 'exec',
      arguments: { command: 'tmux -V' },
    });
    if (!blockedTmuxExec.isError) throw new Error('ChatGPT exec unexpectedly allowed tmux');

    const blockedTmuxProcess = await client.callTool({
      name: 'process_start',
      arguments: { command: "bash -lc 'tmux new-session -d -s forbidden'" },
    });
    if (!blockedTmuxProcess.isError) throw new Error('ChatGPT process_start unexpectedly allowed nested tmux');
  }

  const harmlessHarnessMention = await client.callTool({
    name: 'exec',
    arguments: { command: "printf '%s\\n' 'codex exec --ephemeral'" },
  });
  if (harmlessHarnessMention.isError) {
    throw new Error('exec guard rejected a harmless non-command harness mention');
  }

  const argvExec = parseJsonToolResult(await client.callTool({
    name: 'exec',
    arguments: { argv: ['/usr/bin/printf', '%s|%s\\n', 'hello world', '$HOME'] },
  }));
  if (argvExec.stdout !== 'hello world|$HOME\n' || argvExec.exitCode !== 0) {
    throw new Error('exec argv mode did not preserve literal arguments');
  }
  await expectToolFailure('exec', { command: 'true', argv: ['/usr/bin/true'] });
  const blockedRawArgvExec = await client.callTool({
    name: 'exec',
    arguments: { argv: ['codex', 'exec', '--ephemeral', 'do work'] },
  });
  const blockedRawArgvText = blockedRawArgvExec.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!blockedRawArgvExec.isError || !blockedRawArgvText.includes('agent_start')) {
    throw new Error('exec argv mode bypassed the raw coding-harness guard');
  }
  const blockedWrappedRawArgvExec = await client.callTool({
    name: 'exec',
    arguments: { argv: ['/usr/bin/env', 'REVIEW=1', 'codex', 'exec', '--ephemeral', 'do work'] },
  });
  const blockedWrappedRawArgvText = blockedWrappedRawArgvExec.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!blockedWrappedRawArgvExec.isError || !blockedWrappedRawArgvText.includes('agent_start')) {
    throw new Error('exec argv env wrapper bypassed the raw coding-harness guard');
  }
  const blockedEnvChdirArgvExec = await client.callTool({
    name: 'exec',
    arguments: { argv: ['/usr/bin/env', '-C', '/tmp', 'codex', 'exec', '--ephemeral', 'do work'] },
  });
  const blockedEnvChdirText = blockedEnvChdirArgvExec.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!blockedEnvChdirArgvExec.isError || !blockedEnvChdirText.includes('agent_start')) {
    throw new Error('exec argv env -C wrapper bypassed the raw coding-harness guard');
  }
  const blockedEnvSplitArgvExec = await client.callTool({
    name: 'exec',
    arguments: { argv: ['/usr/bin/env', '-S', 'codex exec --ephemeral do-work'] },
  });
  if (
    !blockedEnvSplitArgvExec.isError ||
    parseJsonToolResult(blockedEnvSplitArgvExec).error?.code !== 'UNSAFE_COMMAND_WRAPPER'
  ) {
    throw new Error('exec argv env -S wrapper was not rejected fail-closed');
  }
  const blockedNestedRawArgvExec = await client.callTool({
    name: 'exec',
    arguments: { argv: ['/bin/bash', '-lc', 'codex exec --ephemeral do-work'] },
  });
  const blockedNestedRawArgvText = blockedNestedRawArgvExec.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!blockedNestedRawArgvExec.isError || !blockedNestedRawArgvText.includes('agent_start')) {
    throw new Error('exec argv nested-shell mode bypassed the raw coding-harness guard');
  }

  const started = await client.callTool({
    name: 'process_start',
    arguments: { command: "read line; echo got:$line; sleep 30" },
  });
  const startedText = started.content?.find((item) => item.type === 'text')?.text ?? '';
  const processId = JSON.parse(startedText).processId;
  const processList = await client.callTool({ name: 'process_list', arguments: {} });
  const processListText = processList.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!JSON.parse(processListText).processes.some((process) => process.processId === processId)) {
    throw new Error('process_list did not rediscover a managed process');
  }
  await client.callTool({
    name: 'process_write',
    arguments: { processId, input: 'hello', appendNewline: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const read = await client.callTool({
    name: 'process_read',
    arguments: { processId },
  });
  const readData = parseJsonToolResult(read);
  if (!readData.stdout.text.includes('got:hello') || typeof readData.cursor !== 'string') {
    throw new Error('persistent process smoke or cursor creation failed');
  }
  const resumedRead = parseJsonToolResult(await client.callTool({
    name: 'process_read',
    arguments: { processId, cursor: readData.cursor },
  }));
  if (resumedRead.stdout.text !== '' || resumedRead.stderr.text !== '') {
    throw new Error('process_read cursor replayed already-consumed output');
  }
  const cursorConflict = await client.callTool({
    name: 'process_read',
    arguments: { processId, cursor: readData.cursor, stdoutOffset: 0 },
  });
  if (!cursorConflict.isError || parseJsonToolResult(cursorConflict).error?.code !== 'CURSOR_OFFSET_CONFLICT') {
    throw new Error('process_read cursor/offset conflict was not a structured failure');
  }
  const secondStarted = parseJsonToolResult(await client.callTool({
    name: 'process_start',
    arguments: { command: 'sleep 30' },
  }));
  const cursorMismatch = await client.callTool({
    name: 'process_read',
    arguments: { processId: secondStarted.processId, cursor: readData.cursor },
  });
  if (!cursorMismatch.isError || parseJsonToolResult(cursorMismatch).error?.code !== 'CURSOR_TARGET_MISMATCH') {
    throw new Error('process_read cursor target mismatch was not rejected');
  }
  await client.callTool({
    name: 'process_kill',
    arguments: { processId: secondStarted.processId, signal: 'SIGTERM' },
  });
  await client.callTool({
    name: 'process_kill',
    arguments: { processId, signal: 'SIGTERM' },
  });

  await client.callTool({
    name: 'process_start',
    arguments: {
      command: `trap '' TERM; echo $$ > ${shutdownProcessPidPath}; while :; do sleep 30; done`,
    },
  });
  let shutdownProcessPid;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      shutdownProcessPid = Number((await fs.readFile(shutdownProcessPidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(shutdownProcessPid)) {
    throw new Error('graceful shutdown smoke process did not start');
  }

  const serverPid = transport.pid;
  if (!Number.isSafeInteger(serverPid)) {
    throw new Error('MCP stdio server PID unavailable for graceful shutdown smoke');
  }

  let serverOwnedDirs = [];
  try {
    serverOwnedDirs = (await fs.readdir(artifactOwnedParent)).filter((name) =>
      name.startsWith(`store-${serverPid}-`),
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (serverOwnedDirs.length !== 1) {
    throw new Error('exec-owned artifact store directory was not discoverable before shutdown');
  }
  const serverOwnedFiles = await fs.readdir(path.join(artifactOwnedParent, serverOwnedDirs[0]));
  if (serverOwnedFiles.length !== 4) {
    throw new Error(
      `expected exactly four retained exec spill artifacts before shutdown, found ${serverOwnedFiles.length}`,
    );
  }

  const shutdownStartedAt = Date.now();
  process.kill(serverPid, 'SIGTERM');

  let managedProcessExited = false;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    try {
      process.kill(shutdownProcessPid, 0);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      managedProcessExited = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!managedProcessExited) {
    throw new Error('graceful shutdown left a managed process running');
  }
  if (Date.now() - shutdownStartedAt > 3_500) {
    throw new Error('managed-process graceful shutdown exceeded bounded TERM→KILL window');
  }

  let serverExited = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(serverPid, 0);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      serverExited = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!serverExited) throw new Error('MCP server did not exit after SIGTERM');
  try {
    await fs.access(path.join(artifactOwnedParent, serverOwnedDirs[0]));
    throw new Error('graceful shutdown left exec-owned artifact files behind');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await client.close();
  clientClosed = true;

  if (liveIntegrations) {
    console.log(
      `PASS live tools=${names.length} playwrightForwarded=${liveSummary.playwrightTools} lspForwarded=${liveSummary.lspTools} artifact=${liveSummary.artifactName}`,
    );
  } else {
    console.log(`PASS portable tools=${names.length} bridges=0`);
  }
} finally {
  if (!clientClosed) await client.close();
  await fs.rm(smokeBridgeConfig, { force: true });
  await fs.rm(artifactExpiryRoot, { recursive: true, force: true });
  await fs.rm(artifactBorrowedPath, { force: true });
  await fs.rm(presentFilePath, { force: true });
  await fs.rm(presentBinaryPath, { force: true });
  await fs.rm(importedFilePath, { force: true });
  await fs.rm(cancelledImportPath, { force: true });
  await fs.rm(execCancelPidPath, { force: true });
  await fs.rm(execCancelMarkerPath, { force: true });
  await fs.rm(shutdownProcessPidPath, { force: true });
  await fs.rm(filesystemRoot, { recursive: true, force: true });
  await fs.rm(filesystemOutsideRoot, { recursive: true, force: true });
  await fs.rm(gitShimDir, { recursive: true, force: true });
  await fs.rm(gitValidationTriggerPath, { force: true });
  await fs.rm(gitValidationPidPath, { force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(repositoryRoot, { recursive: true, force: true });
  await fs.rm(checkpointStateRoot, { recursive: true, force: true });
  await fs.rm(workspaceSeedRoot, { recursive: true, force: true });
  await fs.rm(workspaceOrigin, { recursive: true, force: true });
  await fs.rm(workspaceCancelOrigin, { recursive: true, force: true });
  await fs.rm(workspaceConcurrencyTriggerPath, { force: true });
  await fs.rm(workspaceConcurrencyLockDir, { recursive: true, force: true });
  await fs.rm(workspaceConcurrencyOverlapPath, { force: true });
  await fs.rm(workspaceCrossProcessTriggerPath, { force: true });
  await fs.rm(workspaceCrossProcessAddLogPath, { force: true });
  await fs.rm(workspaceBranchRaceTriggerPath, { force: true });
  await fs.rm(workspaceBranchRaceReleasePath, { force: true });
  await fs.rm(workspaceBranchRacePidPath, { force: true });
  await fs.rm(workspaceOwnedBranchTriggerPath, { force: true });
  await fs.rm(workspaceOwnedBranchReadyPath, { force: true });
  await fs.rm(workspaceOwnedBranchReleasePath, { force: true });
  await fs.rm(workspaceWorktreeAddTriggerPath, { force: true });
  await fs.rm(workspaceWorktreeAddPidPath, { force: true });
  await fs.rm(workspaceWorktreeRemoveTriggerPath, { force: true });
  await fs.rm(workspaceWorktreeRemovePidPath, { force: true });
  await fs.rm(workspaceRediscoveryBridgesConfig, { force: true });
  await fs.rm(lspSmokeRoot, { recursive: true, force: true });
  if (importServer) await new Promise((resolve) => importServer.close(resolve));
}
