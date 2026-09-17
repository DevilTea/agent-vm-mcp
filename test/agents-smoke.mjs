import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  agentCapabilities,
  agentGet,
  agentPrompt,
  agentPromptResult,
  agentRead,
  agentSendKeys,
  agentStart,
  agentStop,
  agentSuspend,
  agentResume,
} from '../src/agents.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-agents-smoke-'));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.join(root, 'home');
const bin = path.join(root, 'bin');
const statePath = path.join(root, 'herdr-state.json');
const herdrPath = path.join(bin, 'herdr');
const metadataPath = path.join(home, '.local', 'state', 'agent-vm-mcp', 'agents.json');
const execFileAsync = promisify(execFile);

await fs.mkdir(bin, { recursive: true });
await fs.mkdir(home, { recursive: true });

for (const skillRoot of [
  path.join(home, '.agents', 'skills'),
  path.join(home, '.gemini', 'antigravity-cli', 'skills'),
  path.join(home, '.claude', 'skills'),
]) {
  await fs.mkdir(path.join(skillRoot, 'commit'), { recursive: true });
  await fs.writeFile(path.join(skillRoot, 'commit', 'SKILL.md'), '# commit\n', 'utf8');
}

for (const [name, version] of [
  ['codex', 'codex-cli fake-1.0'],
  ['agy', 'agy fake-1.0'],
  ['claude', 'claude fake-1.0'],
]) {
  const executable = path.join(bin, name);
  await fs.writeFile(executable, `#!/usr/bin/env bash\necho '${version}'\n`, { mode: 0o755 });
}

await fs.writeFile(
  statePath,
  `${JSON.stringify({ running: true, nextWorkspace: 1, workspaces: {}, agents: {}, sessions: {} }, null, 2)}\n`,
  'utf8',
);

const fakeHerdr = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const statePath = process.env.AGENT_HERDR_FAKE_STATE;
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (state) => {
  const temporaryPath = statePath + '.tmp-' + process.pid;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temporaryPath, statePath);
};
const emit = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ error: { code, message }, id: 'fake' }) + '\n');
  process.exit(1);
};

let args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('herdr fake-0.8.2');
  process.exit(0);
}
if (args[0] !== '--session' || !args[1]) fail('bad_args', 'missing --session');
const sessionName = args[1];
args = args.slice(2);
let state = readState();
if (!state.running && args[0] !== 'server') fail('connect_failed', 'session is stopped');

if (args[0] === 'server') {
  state.running = true;
  writeState(state);
  process.exit(0);
} else if (args[0] === 'api' && args[1] === 'snapshot') {
  if (state.failNextSnapshotCount > 0) {
    state.failNextSnapshotCount -= 1;
    writeState(state);
    fail('snapshot_failed_once', 'synthetic first cleanup snapshot failure');
  } else if (state.hangSnapshot) setInterval(() => {}, 60_000);
  else {
    if (state.armSlowExecutableResolveAfterFinalOwnership && state.finalReadSeen) {
      state.slowNextExecutableResolve = true;
      delete state.armSlowExecutableResolveAfterFinalOwnership;
      delete state.finalReadSeen;
      writeState(state);
    }
    emit('cli:api:snapshot', {
      type: 'session_snapshot',
      snapshot: {
        version: 'fake-0.8.2',
        protocol: 20,
        agents: Object.values(state.agents),
        workspaces: Object.values(state.workspaces).map((w) => w.workspace),
        tabs: [],
        panes: [],
        layouts: [],
        focused_workspace_id: null,
        focused_tab_id: null,
        focused_pane_id: null,
      },
    });
  }
} else if (args[0] === 'workspace' && args[1] === 'create') {
  const cwd = args[args.indexOf('--cwd') + 1];
  const label = args[args.indexOf('--label') + 1];
  if (state.delayWorkspaceCreateForLabel === label || state.delayNextWorkspaceCreateMs) {
    delete state.delayWorkspaceCreateForLabel;
    const delayMs = Number(state.delayNextWorkspaceCreateMs ?? state.delayWorkspaceCreateMs ?? 1_000);
    delete state.delayNextWorkspaceCreateMs;
    writeState(state);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    state = readState();
  }
  const n = state.nextWorkspace++;
  const workspaceId = 'w' + n;
  const paneId = workspaceId + ':p1';
  const tabId = workspaceId + ':t1';
  const workspaceEnv = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--env') continue;
    const [key, ...value] = String(args[index + 1] ?? '').split('=');
    if (key) workspaceEnv[key] = value.join('=');
  }
  const workspace = {
    workspace_id: workspaceId,
    active_tab_id: tabId,
    agent_status: 'unknown',
    focused: false,
    label,
    number: n,
    pane_count: 1,
    tab_count: 1,
  };
  const workspaceRecord = { workspace, paneId, tabId, cwd, env: workspaceEnv };
  if (state.delayCreateAfterFailure) {
    writeState(state);
    const delayedCode = "const fs=require('fs');const statePath=process.env.AGENT_DELAY_STATE;const record=JSON.parse(process.env.AGENT_DELAY_RECORD);setTimeout(()=>{const delayedState=JSON.parse(fs.readFileSync(statePath,'utf8'));delayedState.workspaces[record.workspace.workspace_id]=record;const temporaryPath=statePath+'.tmp-delayed-'+process.pid;fs.writeFileSync(temporaryPath,JSON.stringify(delayedState,null,2)+'\\n');fs.renameSync(temporaryPath,statePath);},1250);";
    const delayed = spawn(process.execPath, ['-e', delayedCode], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AGENT_DELAY_STATE: statePath, AGENT_DELAY_RECORD: JSON.stringify(workspaceRecord) },
    });
    delayed.unref();
    fail('create_failed_before_delayed_mutation', 'workspace will be created after client failure');
  }
  state.workspaces[workspaceId] = workspaceRecord;
  writeState(state);
  if (state.failCreateAfterMutation || state.failCreateAfterMutationAndFirstCleanupSnapshot) {
    if (state.failCreateAfterMutationAndFirstCleanupSnapshot) {
      state.failNextSnapshotCount = 1;
      delete state.failCreateAfterMutationAndFirstCleanupSnapshot;
      writeState(state);
    }
    fail('create_failed_after_mutation', 'workspace was created before failure');
  }
  const responseWorkspace = { ...workspace };
  if (state.omitWorkspaceIdInCreate) delete responseWorkspace.workspace_id;
  if (state.mismatchWorkspaceLabelInCreate) responseWorkspace.label = 'unexpected-label';
  const responseRootPane = { workspace_id: workspaceId, tab_id: tabId, pane_id: paneId, cwd, agent_status: 'unknown' };
  if (state.mismatchRootPaneWorkspaceIdInCreate) responseRootPane.workspace_id = 'unexpected-workspace';
  emit('cli:workspace:create', {
    type: 'workspace_created',
    workspace: responseWorkspace,
    tab: { workspace_id: workspaceId, tab_id: tabId, pane_count: 1 },
    root_pane: responseRootPane,
  });
} else if (args[0] === 'workspace' && args[1] === 'get') {
  const workspaceId = args[2];
  const record = state.workspaces[workspaceId];
  if (!record) fail('workspace_not_found', 'workspace not found');
  const responseWorkspace = { ...record.workspace };
  if (state.renameWorkspaceAfterGetFor === workspaceId) {
    record.workspace.label = 'raced-away';
    delete state.renameWorkspaceAfterGetFor;
    writeState(state);
  }
  emit('cli:workspace:get', { type: 'workspace_info', workspace: responseWorkspace });
} else if (args[0] === 'workspace' && args[1] === 'close') {
  const workspaceId = args[2];
  if (state.delayWorkspaceCloseFor === workspaceId) {
    delete state.delayWorkspaceCloseFor;
    const delayMs = Number(state.delayWorkspaceCloseMs ?? 1_000);
    writeState(state);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    state = readState();
  }
  if (state.failWorkspaceCloseFor === workspaceId) fail('workspace_close_failed', 'synthetic workspace close failure');
  for (const [name, agent] of Object.entries(state.agents)) {
    if (agent.workspace_id === workspaceId) {
      state.sessions ??= {};
      state.sessions[agent.native_session_id] = { transcript: agent.transcript };
      delete state.agents[name];
    }
  }
  delete state.workspaces[workspaceId];
  writeState(state);
  emit('cli:workspace:close', { type: 'ok' });
} else if (args[0] === 'agent' && args[1] === 'start') {
  const name = args[2];
  const kind = args[args.indexOf('--kind') + 1];
  const paneId = args[args.indexOf('--pane') + 1];
  const workspace = Object.values(state.workspaces).find((w) => w.paneId === paneId);
  if (!workspace) fail('missing_pane', 'pane not found');
  const separator = args.indexOf('--');
  const launchArgs = separator === -1 ? [] : args.slice(separator + 1);
  const resumeIndex = launchArgs.findIndex((arg) => arg === 'resume' || arg === '--conversation');
  const nativeSessionId = resumeIndex === -1
    ? kind + '-session-' + name
    : launchArgs[resumeIndex + 1];
  if (state.emitAmbiguousNativeSessions && kind === 'codex') {
    const sessionDirectory = path.join(workspace.env.CODEX_HOME ?? path.join(process.env.HOME, '.codex'), 'sessions', '2099', '01', '01');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    for (const suffix of ['a', 'b']) {
      const candidateId = 'ambiguous-' + name + '-' + process.pid + '-' + suffix;
      const candidatePath = path.join(sessionDirectory, candidateId + '.jsonl');
      fs.writeFileSync(candidatePath, JSON.stringify({
        type: 'session_meta',
        payload: { id: candidateId, session_id: candidateId, cwd: workspace.cwd, timestamp: new Date().toISOString() },
      }) + '\n');
    }
  } else if (state.emitSingleNativeSession && kind === 'codex') {
    const sessionDirectory = path.join(workspace.env.CODEX_HOME ?? path.join(process.env.HOME, '.codex'), 'sessions', '2099', '01', '01');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    const candidateId = 'single-' + name + '-' + process.pid;
    fs.writeFileSync(path.join(sessionDirectory, candidateId + '.jsonl'), JSON.stringify({
      type: 'session_meta',
      payload: { id: candidateId, session_id: candidateId, cwd: workspace.cwd, timestamp: new Date().toISOString() },
    }) + '\n');
  }
  state.sessions ??= {};
  const agent = {
    agent: kind,
    agent_status: 'idle',
    cwd: workspace.cwd,
    foreground_cwd: workspace.cwd,
    interactive_ready: true,
    name,
    pane_id: paneId,
    revision: 1,
    state_change_seq: 1,
    tab_id: workspace.tabId,
    terminal_id: 'term-' + name,
    workspace_id: workspace.workspace.workspace_id,
    ...(state.omitNativeSessionId ? {} : { native_session_id: nativeSessionId }),
    transcript: state.sessions[nativeSessionId]?.transcript ?? 'READY',
    launch_args: launchArgs,
    sent_keys: [],
  };
  state.agents[name] = agent;
  writeState(state);
  emit('cli:agent:start', { type: 'agent_started', agent, argv: [kind, ...launchArgs] });
} else if (args[0] === 'agent' && args[1] === 'get') {
  const agent = state.agents[args[2]];
  if (!agent) fail('agent_not_found', 'agent not found');
  if (state.renameWorkspaceDuringGetFor === args[2]) {
    state.workspaces[agent.workspace_id].workspace.label = 'raced-away';
    delete state.renameWorkspaceDuringGetFor;
    writeState(state);
  }
  emit('cli:agent:get', { type: 'agent_info', agent });
} else if (args[0] === 'agent' && args[1] === 'read') {
  const agent = state.agents[args[2]];
  if (!agent) fail('agent_not_found', 'agent not found');
  if (state.failReadFor === args[2]) fail('read_failed', 'visible terminal unavailable');
  if (state.renameWorkspaceDuringReadFor === args[2]) {
    state.workspaces[agent.workspace_id].workspace.label = 'raced-away';
    delete state.renameWorkspaceDuringReadFor;
    writeState(state);
  }
  if (state.markWorkingAfterReadFor === args[2]) {
    agent.agent_status = 'working';
    delete state.markWorkingAfterReadFor;
    writeState(state);
  }
  if (state.armSlowExecutableResolveAfterFinalOwnership === args[2]) {
    state.visibleReadsUntilSlowResolve = (state.visibleReadsUntilSlowResolve ?? 2) - 1;
    if (state.visibleReadsUntilSlowResolve <= 0) {
      state.finalReadSeen = true;
      delete state.visibleReadsUntilSlowResolve;
    }
    writeState(state);
  }
  if (state.hangReadFor === args[2]) setInterval(() => {}, 60_000);
  else process.stdout.write(agent.transcript);
} else if (args[0] === 'agent' && args[1] === 'prompt') {
  const agent = state.agents[args[2]];
  if (!agent) fail('agent_not_found', 'agent not found');
  if (state.delayBeforePromptMutationFor === args[2]) {
    delete state.delayBeforePromptMutationFor;
    writeState(state);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    fail('prompt_not_mutated', 'synthetic crash window before prompt mutation');
  }
  const prompt = args[3];
  state.promptCount = (state.promptCount ?? 0) + 1;
  agent.transcript += '\n> ' + prompt + '\nFAKE_RESPONSE';
  agent.state_change_seq += 2;
  if (state.promptResultStatus) agent.agent_status = state.promptResultStatus;
  if (state.createCodexSessionOnPromptFor === args[2] && agent.agent === 'codex') {
    const workspace = state.workspaces[agent.workspace_id];
    const codexHome = workspace?.env?.CODEX_HOME ?? path.join(process.env.HOME, '.codex');
    const sessionId = 'late-session-' + agent.name;
    const sessionDirectory = path.join(codexHome, 'sessions', '2099', '01', '02');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDirectory, sessionId + '.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: sessionId, id: sessionId, cwd: agent.cwd, timestamp: new Date().toISOString() },
      }) + '\n',
    );
  }
  state.sessions ??= {};
  state.sessions[agent.native_session_id] = { transcript: agent.transcript };
  writeState(state);
  if (state.delayPromptResponseFor === args[2]) {
    delete state.delayPromptResponseFor;
    const delayMs = Number(state.delayPromptResponseMs ?? 1_000);
    writeState(state);
    setTimeout(() => emit('cli:agent:prompt', { type: 'agent_prompted', agent }), delayMs);
  } else if (state.promptFailure === 'after_mutation') fail('agent_prompt_stalled', 'prompt submitted but wait stalled');
  else if (state.promptFailure === 'hang_after_mutation') setInterval(() => {}, 60_000);
  else if (state.promptFailure === 'hang_with_descendant') {
    const descendant = spawn(process.execPath, ['-e', 'process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    state.descendantPid = descendant.pid;
    writeState(state);
    setInterval(() => {}, 60_000);
  } else emit('cli:agent:prompt', { type: 'agent_prompted', agent });
} else if (args[0] === 'agent' && args[1] === 'send-keys') {
  const agent = state.agents[args[2]];
  if (!agent) fail('agent_not_found', 'agent not found');
  agent.sent_keys.push(...args.slice(3));
  if (agent.transcript.includes('Do you trust the contents of this project?') && args.slice(3).includes('enter')) {
    agent.transcript = 'READY AFTER TRUST';
  }
  writeState(state);
  emit('cli:agent:send-keys', { type: 'ok' });
} else {
  fail('unsupported', sessionName + ': ' + args.join(' '));
}
`;
await fs.writeFile(herdrPath, fakeHerdr, { mode: 0o755 });

const previous = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  AGENT_HERDR_BIN: process.env.AGENT_HERDR_BIN,
  AGENT_HERDR_SESSION: process.env.AGENT_HERDR_SESSION,
  AGENT_HERDR_FAKE_STATE: process.env.AGENT_HERDR_FAKE_STATE,
  AGENT_HERDR_BOOTSTRAP: process.env.AGENT_HERDR_BOOTSTRAP,
  AGENT_CODEX_ENFORCED_MODEL: process.env.AGENT_CODEX_ENFORCED_MODEL,
  AGENT_CODEX_ENFORCED_EFFORT: process.env.AGENT_CODEX_ENFORCED_EFFORT,
};
process.env.HOME = home;
process.env.PATH = `${bin}:${previous.PATH}`;
process.env.AGENT_HERDR_BIN = herdrPath;
process.env.AGENT_HERDR_SESSION = 'fake-session';
process.env.AGENT_HERDR_FAKE_STATE = statePath;
// These legacy deployment variables must not control the built-in MCP policy.
process.env.AGENT_CODEX_ENFORCED_MODEL = 'gpt-5.6-terra';
process.env.AGENT_CODEX_ENFORCED_EFFORT = 'ultra';

try {
  const capabilities = await agentCapabilities();
  if (!capabilities.runtime.available || !capabilities.runtime.session.running) {
    throw new Error('agentCapabilities did not discover fake Herdr runtime');
  }
  for (const harness of capabilities.harnesses) {
    if (!harness.available || !harness.skills.includes('commit')) {
      throw new Error(`agentCapabilities did not discover ${harness.kind} or its skills`);
    }
  }
  const codexCapability = capabilities.harnesses.find((harness) => harness.kind === 'codex');
  if (
    codexCapability?.launchPolicy?.enforced !== true ||
    codexCapability.launchPolicy.model !== 'gpt-5.6-luna' ||
    codexCapability.launchPolicy.effort !== 'max'
  ) {
    throw new Error(`agentCapabilities did not expose enforced Codex policy: ${JSON.stringify(codexCapability?.launchPolicy)}`);
  }

  try {
    await agentStart({ harness: 'codex', cwd: root, model: 'gpt-5.6-terra', effort: 'max', timeoutMs: 10_000 });
    throw new Error('Forbidden Codex model unexpectedly started');
  } catch (error) {
    if (error?.code !== 'agent_launch_policy_violation' || !String(error.message).includes('gpt-5.6-luna')) throw error;
  }

  try {
    await agentStart({ harness: 'codex', cwd: root, model: 'gpt-5.6-luna', effort: 'high', timeoutMs: 10_000 });
    throw new Error('Forbidden Codex effort unexpectedly started');
  } catch (error) {
    if (error?.code !== 'agent_launch_policy_violation' || !String(error.message).includes('effort max')) throw error;
  }

  const codex = await agentStart({
    harness: 'codex',
    cwd: root,
    timeoutMs: 10_000,
  });
  if (!codex.startup.ready || codex.agent.harness !== 'codex') throw new Error('Codex fake agent did not start');
  let state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const codexLaunch = state.agents[codex.agent.agentId].launch_args;
  if (
    JSON.stringify(codexLaunch) !==
    JSON.stringify([
      '--model',
      'gpt-5.6-luna',
      '--config',
      'model_reasoning_effort="max"',
      '--profile',
      `agent-vm-mcp-${codex.agent.agentId}`,
    ])
  ) {
    throw new Error(`Unexpected Codex launch args: ${JSON.stringify(codexLaunch)}`);
  }
  const codexWorkspace = state.workspaces[state.agents[codex.agent.agentId].workspace_id];
  const codexProfilePath = path.join(home, '.codex', `agent-vm-mcp-${codex.agent.agentId}.config.toml`);
  const codexProfile = await fs.readFile(codexProfilePath, 'utf8');
  if (codexWorkspace.env?.CODEX_HOME !== path.join(home, '.codex')) {
    throw new Error(`MCP Codex workspace did not receive scoped CODEX_HOME: ${JSON.stringify(codexWorkspace.env)}`);
  }
  for (const requiredLine of [
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "max"',
    'default_subagent_model = "gpt-5.6-luna"',
    'default_subagent_reasoning_effort = "max"',
    'x-review',
    'model-routing',
  ]) {
    if (!codexProfile.includes(requiredLine)) throw new Error(`Managed Codex profile omitted ${requiredLine}`);
  }
  const codexMetadata = JSON.parse(await fs.readFile(path.join(home, '.local', 'state', 'agent-vm-mcp', 'agents.json'), 'utf8')).agents[codex.agent.agentId];
  if (
    codexMetadata.lifecycle !== 'active' ||
    codexMetadata.policyStatus !== 'verified' ||
    codexMetadata.codexProvenance?.policy?.model !== 'gpt-5.6-luna' ||
    codexMetadata.codexProvenance?.policy?.effort !== 'max' ||
    codexMetadata.codexProvenance?.profilePath !== codexProfilePath ||
    codexMetadata.codexProvenance?.profileSha256?.length !== 64
  ) {
    throw new Error(`MCP Codex provenance was not durably persisted: ${JSON.stringify(codexMetadata)}`);
  }

  await fs.appendFile(
    codexProfilePath,
    `\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`,
    'utf8',
  );
  const trustedCodex = await agentGet({ agentId: codex.agent.agentId });
  if (trustedCodex.policyStatus !== 'verified' || trustedCodex.lifecycle !== 'active') {
    throw new Error(`Codex-owned project trust state invalidated managed policy provenance: ${JSON.stringify(trustedCodex)}`);
  }

  const prompted = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'Commit the verified change.',
    skills: ['commit'],
    wait: true,
    timeoutMs: 10_000,
  });
  if (!prompted.accepted || !prompted.transcript.includes('Use the following installed skills for this task: commit.')) {
    throw new Error('Skill-aware prompt was not submitted');
  }
  if (!prompted.transcript.includes('Commit the verified change.')) throw new Error('Task text missing from prompt transcript');
  if (prompted.submission?.state !== 'submitted') throw new Error('Successful prompt did not report submitted state');
  if (prompted.runtimeDisposition?.action !== 'retained' || prompted.runtimeDisposition.reason !== 'status_not_done') {
    throw new Error(`Idle prompt was unexpectedly finalized: ${JSON.stringify(prompted.runtimeDisposition)}`);
  }

  const lostResponseAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const lostResponseRuntimeId = lostResponseAgent.agent.runtimeAgentId;
  state.promptResultStatus = 'done';
  state.delayPromptResponseFor = lostResponseRuntimeId;
  state.delayPromptResponseMs = 5_000;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const lostResponseController = new AbortController();
  const lostResponsePromise = agentPrompt({
    agentId: lostResponseAgent.agent.agentId,
    requestId: 'lost-response-1',
    task: 'LOST_RESPONSE_TASK',
    wait: true,
    timeoutMs: 10_000,
  }, lostResponseController.signal);
  let lostResponseDone = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state.agents[lostResponseRuntimeId]?.agent_status === 'done' && state.agents[lostResponseRuntimeId].transcript.includes('LOST_RESPONSE_TASK')) {
      lostResponseDone = true;
      break;
    }
  }
  if (!lostResponseDone) throw new Error('Lost-response test never observed Herdr done before cancellation');
  lostResponseController.abort();
  let lostResponseCancelled = false;
  try {
    await lostResponsePromise;
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.code !== 'ABORT_ERR') throw error;
    lostResponseCancelled = true;
  }
  if (!lostResponseCancelled) throw new Error('Caller cancellation after completion unexpectedly returned the normal MCP response');
  const lostResponseResult = await agentPromptResult({ requestId: 'lost-response-1' });
  if (
    !lostResponseResult.found ||
    lostResponseResult.completion?.state !== 'completed' ||
    !lostResponseResult.result?.transcript.includes('LOST_RESPONSE_TASK') ||
    lostResponseResult.result?.runtimeDisposition?.action !== 'suspended'
  ) {
    throw new Error(`Cancelled completed prompt was not durably recoverable: ${JSON.stringify(lostResponseResult)}`);
  }
  const lostResponseAck = await agentPromptResult({ requestId: 'lost-response-1', ack: true });
  if (!lostResponseAck.acked || !lostResponseAck.completion?.acknowledged) throw new Error('Durable completion acknowledgement was not persisted');
  await agentStop({ agentId: lostResponseAgent.agent.agentId });
  const stoppedRecovery = await agentPromptResult({ requestId: 'lost-response-1' });
  if (!stoppedRecovery.found || !stoppedRecovery.result?.transcript.includes('LOST_RESPONSE_TASK')) {
    throw new Error('Acknowledged completion was lost after logical agent stop');
  }

  const restartedRecoveryAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const restartedRecoveryRuntimeId = restartedRecoveryAgent.agent.runtimeAgentId;
  state.promptResultStatus = 'done';
  state.delayPromptResponseFor = restartedRecoveryRuntimeId;
  state.delayPromptResponseMs = 5_000;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const childEnv = { ...process.env };
  delete childEnv.CODEX_HOME;
  const crashedOwnerSource = `
import { agentPrompt } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
await agentPrompt({
  agentId: ${JSON.stringify(restartedRecoveryAgent.agent.agentId)},
  requestId: 'restart-recovery-1',
  task: 'RESTART_RECOVERY_TASK',
  wait: true,
  timeoutMs: 10_000,
});
`;
  const crashedOwner = spawn(process.execPath, ['--input-type=module', '-e', crashedOwnerSource], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let crashedOwnerStderr = '';
  crashedOwner.stderr.on('data', (chunk) => { crashedOwnerStderr += chunk.toString('utf8'); });
  let restartedDone = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const transcript = state.agents[restartedRecoveryRuntimeId]?.transcript ?? '';
    if (state.agents[restartedRecoveryRuntimeId]?.agent_status === 'done' && transcript.includes('RESTART_RECOVERY_TASK') && transcript.includes('agent-vm-mcp-request:')) {
      restartedDone = true;
      break;
    }
  }
  if (!restartedDone) {
    crashedOwner.kill('SIGKILL');
    throw new Error(`Process-recovery test never observed Herdr done/marker: ${crashedOwnerStderr}`);
  }
  crashedOwner.kill('SIGKILL');
  await new Promise((resolve) => crashedOwner.once('exit', resolve));
  const recoveryProbeSource = `
import { agentCapabilities, agentPromptResult } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
const capabilities = await agentCapabilities();
const result = await agentPromptResult({ requestId: 'restart-recovery-1' });
process.stdout.write(JSON.stringify({ capabilities: capabilities.runtime.session, result }));
`;
  const recoveryProbe = await execFileAsync(process.execPath, ['--input-type=module', '-e', recoveryProbeSource], {
    cwd: root,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  });
  const { capabilities: restartedCapabilities, result: restartedResult } = JSON.parse(recoveryProbe.stdout);
  if (
    restartedCapabilities.agents.some((agent) => agent.agentId === restartedRecoveryAgent.agent.agentId && agent.lifecycle === 'active') ||
    !restartedResult.found ||
    restartedResult.completion?.state !== 'completed' ||
    !restartedResult.result?.transcript.includes('RESTART_RECOVERY_TASK') ||
    !['suspended', 'stopped'].includes(restartedResult.result?.runtimeDisposition?.action)
  ) {
    throw new Error(`Active+done reconciliation did not persist before cleanup: ${JSON.stringify(restartedResult)}`);
  }
  await agentPromptResult({ requestId: 'restart-recovery-1', ack: true });
  await agentStop({ agentId: restartedRecoveryAgent.agent.agentId });

  const crashBeforeDispatchAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const crashBeforeDispatchRuntimeId = crashBeforeDispatchAgent.agent.runtimeAgentId;
  delete state.promptResultStatus;
  delete state.promptFailure;
  state.delayBeforePromptMutationFor = crashBeforeDispatchRuntimeId;
  const crashBeforeDispatchCount = state.promptCount ?? 0;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const crashBeforeDispatchSource = `
import { agentPrompt } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
await agentPrompt({
  agentId: ${JSON.stringify(crashBeforeDispatchAgent.agent.agentId)},
  requestId: 'crash-before-dispatch-1',
  task: 'MUST_NOT_BE_FALSELY_ATTRIBUTED',
  wait: true,
  timeoutMs: 10_000,
});
`;
  const crashBeforeDispatchOwner = spawn(process.execPath, ['--input-type=module', '-e', crashBeforeDispatchSource], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let crashBeforeDispatchArmed = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (metadata.completions?.['crash-before-dispatch-1']?.state === 'in_flight' && state.delayBeforePromptMutationFor === undefined) {
      crashBeforeDispatchArmed = true;
      break;
    }
  }
  if (!crashBeforeDispatchArmed) {
    crashBeforeDispatchOwner.kill('SIGKILL');
    throw new Error('Crash-before-dispatch test never reached durable claim/pre-mutation window');
  }
  crashBeforeDispatchOwner.kill('SIGKILL');
  await new Promise((resolve) => crashBeforeDispatchOwner.once('exit', resolve));
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const crashRuntime = state.agents[crashBeforeDispatchRuntimeId];
  crashRuntime.agent_status = 'done';
  crashRuntime.state_change_seq += 2;
  crashRuntime.transcript += '\nUNRELATED_STATE_CHANGE';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const crashBeforeDispatchResultSource = `
import { agentPromptResult } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
process.stdout.write(JSON.stringify(await agentPromptResult({ requestId: 'crash-before-dispatch-1' })));
`;
  const crashBeforeDispatchResult = JSON.parse((await execFileAsync(process.execPath, ['--input-type=module', '-e', crashBeforeDispatchResultSource], {
    cwd: root,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout);
  if (
    !crashBeforeDispatchResult.found ||
    crashBeforeDispatchResult.completion?.state !== 'uncertain' ||
    crashBeforeDispatchResult.result?.accepted !== null ||
    crashBeforeDispatchResult.result?.transcript?.includes('agent-vm-mcp-request:')
  ) {
    throw new Error(`Crash before prompt mutation was falsely attributed as submitted: ${JSON.stringify(crashBeforeDispatchResult)}`);
  }
  const crashBeforeDispatchAck = await agentPromptResult({ requestId: 'crash-before-dispatch-1', ack: true });
  if (!crashBeforeDispatchAck.acked || crashBeforeDispatchAck.completion?.state !== 'uncertain') {
    throw new Error(`Uncertain result acknowledgement changed safety state: ${JSON.stringify(crashBeforeDispatchAck)}`);
  }
  const crashBeforeDispatchDifferent = await agentPrompt({
    agentId: crashBeforeDispatchAgent.agent.agentId,
    requestId: 'crash-before-dispatch-2',
    task: 'MUST_STAY_BLOCKED_AFTER_UNCERTAIN_ACK',
    wait: true,
    timeoutMs: 5_000,
  });
  const crashBeforeDispatchSame = await agentPrompt({
    agentId: crashBeforeDispatchAgent.agent.agentId,
    requestId: 'crash-before-dispatch-1',
    task: 'MUST_NOT_BE_FALSELY_ATTRIBUTED',
    wait: true,
    timeoutMs: 5_000,
  });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (
    crashBeforeDispatchDifferent.error?.code !== 'agent_prompt_in_flight' ||
    crashBeforeDispatchSame.resultState !== 'uncertain' ||
    state.promptCount !== crashBeforeDispatchCount ||
    state.agents[crashBeforeDispatchRuntimeId].transcript.includes('MUST_STAY_BLOCKED_AFTER_UNCERTAIN_ACK')
  ) {
    throw new Error(`Uncertain request did not remain fail-closed/idempotent after acknowledgement: ${JSON.stringify({ crashBeforeDispatchDifferent, crashBeforeDispatchSame, promptCount: state.promptCount })}`);
  }
  const crashBeforeDispatchMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  const crashBeforeDispatchMarker = crashBeforeDispatchMetadata.completions['crash-before-dispatch-1'].submissionMarker;
  state.agents[crashBeforeDispatchRuntimeId].transcript += `\n[${crashBeforeDispatchMarker}]`;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const crashBeforeDispatchResolved = await agentPromptResult({ requestId: 'crash-before-dispatch-1' });
  if (crashBeforeDispatchResolved.completion?.state !== 'completed' || !crashBeforeDispatchResolved.result?.transcript.includes(crashBeforeDispatchMarker)) {
    throw new Error(`Submission marker did not resolve previously uncertain crash result: ${JSON.stringify(crashBeforeDispatchResolved)}`);
  }
  await agentStop({ agentId: crashBeforeDispatchAgent.agent.agentId });

  const noWaitCrashAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const noWaitCrashRuntimeId = noWaitCrashAgent.agent.runtimeAgentId;
  delete state.promptResultStatus;
  delete state.promptFailure;
  state.delayPromptResponseFor = noWaitCrashRuntimeId;
  state.delayPromptResponseMs = 5_000;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const noWaitCrashSource = `
import { agentPrompt } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
await agentPrompt({
  agentId: ${JSON.stringify(noWaitCrashAgent.agent.agentId)},
  requestId: 'wait-false-crash-1',
  task: 'WAIT_FALSE_CRASH_TASK',
  wait: false,
  timeoutMs: 10_000,
});
`;
  const noWaitCrashOwner = spawn(process.execPath, ['--input-type=module', '-e', noWaitCrashSource], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let noWaitCrashSubmitted = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if ((state.agents[noWaitCrashRuntimeId]?.transcript ?? '').includes('WAIT_FALSE_CRASH_TASK') && (state.agents[noWaitCrashRuntimeId]?.transcript ?? '').includes('agent-vm-mcp-request:')) {
      noWaitCrashSubmitted = true;
      break;
    }
  }
  if (!noWaitCrashSubmitted) {
    noWaitCrashOwner.kill('SIGKILL');
    throw new Error('wait=false crash test never observed prompt submission marker');
  }
  noWaitCrashOwner.kill('SIGKILL');
  await new Promise((resolve) => noWaitCrashOwner.once('exit', resolve));
  const noWaitCrashResultSource = `
import { agentPromptResult } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
process.stdout.write(JSON.stringify(await agentPromptResult({ requestId: 'wait-false-crash-1' })));
`;
  const noWaitCrashResult = JSON.parse((await execFileAsync(process.execPath, ['--input-type=module', '-e', noWaitCrashResultSource], {
    cwd: root,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout);
  if (
    noWaitCrashResult.completion?.state !== 'completed' ||
    noWaitCrashResult.result?.accepted !== true ||
    noWaitCrashResult.result?.submission?.waitCompleted !== false ||
    noWaitCrashResult.result?.runtimeDisposition?.reason !== 'wait_disabled' ||
    !noWaitCrashResult.result?.transcript.includes('WAIT_FALSE_CRASH_TASK')
  ) {
    throw new Error(`wait=false owner crash did not converge to durable result: ${JSON.stringify(noWaitCrashResult)}`);
  }
  await agentStop({ agentId: noWaitCrashAgent.agent.agentId });

  const joinedAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.promptFailure = 'hang_after_mutation';
  const joinedCountBefore = state.promptCount ?? 0;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const joinedFirst = agentPrompt({
    agentId: joinedAgent.agent.agentId,
    requestId: 'same-request-1',
    task: 'SAME_REQUEST_TASK',
    wait: true,
    timeoutMs: 1_000,
  });
  let joinedSubmitted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state.agents[joinedAgent.agent.agentId]?.transcript.includes('SAME_REQUEST_TASK')) {
      joinedSubmitted = true;
      break;
    }
  }
  if (!joinedSubmitted) throw new Error('Same-request join test never observed the first submission');
  const joinedSecond = await agentPrompt({
    agentId: joinedAgent.agent.agentId,
    requestId: 'same-request-1',
    task: 'SAME_REQUEST_TASK',
    wait: true,
    timeoutMs: 5_000,
  });
  const joinedFirstResult = await joinedFirst;
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (
    state.promptCount !== joinedCountBefore + 1 ||
    joinedSecond.requestId !== 'same-request-1' ||
    joinedFirstResult.requestId !== 'same-request-1' ||
    joinedSecond.error?.code !== joinedFirstResult.error?.code
  ) {
    throw new Error(`Same request was not joined/idempotently recovered: ${JSON.stringify({ joinedFirstResult, joinedSecond, promptCount: state.promptCount })}`);
  }
  const joinedConflict = await agentPrompt({
    agentId: joinedAgent.agent.agentId,
    requestId: 'same-request-1',
    task: 'DIFFERENT_PAYLOAD_FOR_SAME_REQUEST_ID',
    wait: true,
    timeoutMs: 5_000,
  });
  if (joinedConflict.error?.code !== 'agent_prompt_request_conflict') {
    throw new Error(`Same request identity accepted a different payload: ${JSON.stringify(joinedConflict)}`);
  }
  delete state.promptFailure;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await agentStop({ agentId: joinedAgent.agent.agentId });

  const generationFenceAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const generationFenceRuntimeId = generationFenceAgent.agent.runtimeAgentId;
  const generationFenceWorkspaceId = state.agents[generationFenceRuntimeId].workspace_id;
  const generationFenceCount = state.promptCount ?? 0;
  const originalReadFileForGenerationFence = fs.readFile;
  let generationFenceInjected = false;
  fs.readFile = async (candidate, ...args) => {
    const value = await originalReadFileForGenerationFence(candidate, ...args);
    if (!generationFenceInjected && path.resolve(String(candidate)) === path.resolve(metadataPath)) {
      const text = typeof value === 'string' ? value : value.toString('utf8');
      const metadata = JSON.parse(text);
      if (metadata.completions?.['generation-before-dispatch-1']?.state === 'in_flight') {
        generationFenceInjected = true;
        metadata.agents[generationFenceAgent.agent.agentId].runtimeWorkspaceId = 'w-generation-raced';
        await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
        return typeof value === 'string' ? `${JSON.stringify(metadata, null, 2)}\n` : Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
      }
    }
    return value;
  };
  let generationFenceResult;
  try {
    generationFenceResult = await agentPrompt({
      agentId: generationFenceAgent.agent.agentId,
      requestId: 'generation-before-dispatch-1',
      task: 'MUST_NOT_DISPATCH_AFTER_GENERATION_CHANGE',
      wait: true,
      timeoutMs: 10_000,
    });
  } finally {
    fs.readFile = originalReadFileForGenerationFence;
  }
  if (!generationFenceInjected) throw new Error('Generation-before-dispatch race was not injected after durable claim');
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (
    generationFenceResult.accepted !== false ||
    generationFenceResult.submission?.state !== 'not_submitted' ||
    generationFenceResult.error?.cause?.code !== 'agent_runtime_generation_changed' ||
    state.promptCount !== generationFenceCount ||
    state.agents[generationFenceRuntimeId].transcript.includes('MUST_NOT_DISPATCH_AFTER_GENERATION_CHANGE')
  ) {
    throw new Error(`Generation changed after claim but prompt was not failed closed: ${JSON.stringify({ generationFenceResult, promptCount: state.promptCount })}`);
  }
  let generationFenceMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  if (generationFenceMetadata.completions?.['generation-before-dispatch-1']) {
    throw new Error('Generation-mismatched pre-dispatch claim was not removed as definitely not submitted');
  }
  generationFenceMetadata.agents[generationFenceAgent.agent.agentId].runtimeAgentId = generationFenceRuntimeId;
  generationFenceMetadata.agents[generationFenceAgent.agent.agentId].runtimeWorkspaceId = generationFenceWorkspaceId;
  generationFenceMetadata.agents[generationFenceAgent.agent.agentId].lifecycle = 'active';
  await fs.writeFile(metadataPath, `${JSON.stringify(generationFenceMetadata, null, 2)}\n`, 'utf8');
  await agentStop({ agentId: generationFenceAgent.agent.agentId });

  const cleanupGenerationAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const cleanupGenerationRuntimeId = cleanupGenerationAgent.agent.runtimeAgentId;
  const cleanupGenerationWorkspaceId = state.agents[cleanupGenerationRuntimeId].workspace_id;
  state.promptResultStatus = 'done';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const originalReadFileForCleanupGeneration = fs.readFile;
  let cleanupGenerationInjected = false;
  fs.readFile = async (candidate, ...args) => {
    const value = await originalReadFileForCleanupGeneration(candidate, ...args);
    if (!cleanupGenerationInjected && path.resolve(String(candidate)) === path.resolve(metadataPath)) {
      const text = typeof value === 'string' ? value : value.toString('utf8');
      const metadata = JSON.parse(text);
      const completion = metadata.completions?.['cleanup-generation-race-1'];
      if (completion?.state === 'completed' && completion.result?.runtimeDisposition?.action === 'pending') {
        cleanupGenerationInjected = true;
        metadata.agents[cleanupGenerationAgent.agent.agentId].runtimeAgentId = 'agent-ffffffffffffffffffffffffff';
        metadata.agents[cleanupGenerationAgent.agent.agentId].runtimeWorkspaceId = 'w-new-generation';
        await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
        return typeof value === 'string' ? `${JSON.stringify(metadata, null, 2)}\n` : Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
      }
    }
    return value;
  };
  let cleanupGenerationResult;
  try {
    cleanupGenerationResult = await agentPrompt({
      agentId: cleanupGenerationAgent.agent.agentId,
      requestId: 'cleanup-generation-race-1',
      task: 'COMPLETE_BUT_DO_NOT_CLOSE_NEW_GENERATION',
      wait: true,
      timeoutMs: 10_000,
    });
  } finally {
    fs.readFile = originalReadFileForCleanupGeneration;
  }
  if (!cleanupGenerationInjected) throw new Error('Cleanup generation race was not injected after durable completion persistence');
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (
    cleanupGenerationResult.runtimeDisposition?.action !== 'retained' ||
    cleanupGenerationResult.runtimeDisposition?.reason !== 'runtime_generation_changed' ||
    !state.agents[cleanupGenerationRuntimeId] ||
    !state.workspaces[cleanupGenerationWorkspaceId]
  ) {
    throw new Error(`Completion cleanup touched or failed to fence a newer generation: ${JSON.stringify({ cleanupGenerationResult, state })}`);
  }
  let cleanupGenerationMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  cleanupGenerationMetadata.agents[cleanupGenerationAgent.agent.agentId].runtimeAgentId = cleanupGenerationRuntimeId;
  cleanupGenerationMetadata.agents[cleanupGenerationAgent.agent.agentId].runtimeWorkspaceId = cleanupGenerationWorkspaceId;
  cleanupGenerationMetadata.agents[cleanupGenerationAgent.agent.agentId].lifecycle = 'active';
  await fs.writeFile(metadataPath, `${JSON.stringify(cleanupGenerationMetadata, null, 2)}\n`, 'utf8');
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.promptResultStatus;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await agentStop({ agentId: cleanupGenerationAgent.agent.agentId });

  const busyAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.promptFailure = 'hang_after_mutation';
  const busyCountBefore = state.promptCount ?? 0;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const busyController = new AbortController();
  const busyFirst = agentPrompt({
    agentId: busyAgent.agent.agentId,
    requestId: 'busy-request-1',
    task: 'BUSY_FIRST_TASK',
    wait: true,
    timeoutMs: 10_000,
  }, busyController.signal);
  let busySubmitted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state.agents[busyAgent.agent.agentId]?.transcript.includes('BUSY_FIRST_TASK')) {
      busySubmitted = true;
      break;
    }
  }
  if (!busySubmitted) throw new Error('Different-request busy test never observed the first submission');
  const busySecond = await agentPrompt({
    agentId: busyAgent.agent.agentId,
    requestId: 'busy-request-2',
    task: 'BUSY_SECOND_TASK',
    wait: true,
    timeoutMs: 5_000,
  });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (
    busySecond.error?.code !== 'agent_prompt_in_flight' ||
    busySecond.submission?.state !== 'possibly_submitted' ||
    state.promptCount !== busyCountBefore + 1 ||
    state.agents[busyAgent.agent.agentId].transcript.includes('BUSY_SECOND_TASK')
  ) {
    throw new Error(`Different prompt was not rejected as busy/uncertain: ${JSON.stringify({ busySecond, promptCount: state.promptCount })}`);
  }
  const crossProcessBusySource = `
import { agentPrompt } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
const result = await agentPrompt({ agentId: ${JSON.stringify(busyAgent.agent.agentId)}, requestId: 'busy-cross-process-2', task: 'BUSY_CROSS_PROCESS_TASK', wait: true, timeoutMs: 5_000 });
process.stdout.write(JSON.stringify(result));
`;
  const crossProcessBusy = JSON.parse((await execFileAsync(process.execPath, ['--input-type=module', '-e', crossProcessBusySource], {
    cwd: root,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout);
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (
    crossProcessBusy.error?.code !== 'agent_prompt_in_flight' ||
    crossProcessBusy.submission?.state !== 'possibly_submitted' ||
    state.promptCount !== busyCountBefore + 1 ||
    state.agents[busyAgent.agent.agentId].transcript.includes('BUSY_CROSS_PROCESS_TASK')
  ) {
    throw new Error(`Different process was not rejected by durable busy state: ${JSON.stringify({ crossProcessBusy, promptCount: state.promptCount })}`);
  }
  const lifecycleBusySource = `
import { agentStop, agentSuspend } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
const agentId = ${JSON.stringify(busyAgent.agent.agentId)};
const result = {};
for (const [name, fn] of [['stop', agentStop], ['suspend', agentSuspend]]) {
  try {
    await fn({ agentId });
    result[name] = { ok: true };
  } catch (error) {
    result[name] = { ok: false, code: error?.code ?? error?.herdr?.code ?? null, message: error?.message ?? String(error) };
  }
}
process.stdout.write(JSON.stringify(result));
`;
  const lifecycleBusy = JSON.parse((await execFileAsync(process.execPath, ['--input-type=module', '-e', lifecycleBusySource], {
    cwd: root,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout);
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (
    lifecycleBusy.stop?.code !== 'agent_prompt_in_flight' ||
    lifecycleBusy.suspend?.code !== 'agent_prompt_in_flight' ||
    !state.agents[busyAgent.agent.runtimeAgentId] ||
    !state.workspaces[state.agents[busyAgent.agent.runtimeAgentId].workspace_id]
  ) {
    throw new Error(`Cross-process lifecycle mutation escaped prompt fence: ${JSON.stringify({ lifecycleBusy, state })}`);
  }
  busyController.abort();
  await busyFirst.catch(() => {});
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.promptFailure;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await agentStop({ agentId: busyAgent.agent.agentId });

  const completedResumable = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const completedResumableRuntimeId = completedResumable.agent.runtimeAgentId;
  const completedResumableWorkspaceId = state.agents[completedResumableRuntimeId].workspace_id;
  state.promptResultStatus = 'done';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const completedResumablePrompt = await agentPrompt({
    agentId: completedResumable.agent.agentId,
    task: 'COMPLETE_AND_SUSPEND',
    wait: true,
    timeoutMs: 10_000,
  });
  if (completedResumablePrompt.runtimeDisposition?.action !== 'suspended') {
    throw new Error(`Completed resumable prompt was not auto-suspended: ${JSON.stringify(completedResumablePrompt.runtimeDisposition)}`);
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const completedResumableMetadata = JSON.parse(await fs.readFile(path.join(home, '.local', 'state', 'agent-vm-mcp', 'agents.json'), 'utf8')).agents[completedResumable.agent.agentId];
  if (
    state.agents[completedResumableRuntimeId] ||
    state.workspaces[completedResumableWorkspaceId] ||
    completedResumableMetadata?.lifecycle !== 'suspended' ||
    !completedResumableMetadata.nativeSessionId
  ) {
    throw new Error('Completed resumable prompt did not release runtime while preserving durable resume metadata');
  }
  delete state.promptResultStatus;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await agentStop({ agentId: completedResumable.agent.agentId });

  const cleanupFenceAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const cleanupFenceRuntimeId = cleanupFenceAgent.agent.runtimeAgentId;
  const cleanupFenceWorkspaceId = state.agents[cleanupFenceRuntimeId].workspace_id;
  state.promptResultStatus = 'done';
  state.delayWorkspaceCloseFor = cleanupFenceWorkspaceId;
  state.delayWorkspaceCloseMs = 1_500;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}
`, 'utf8');
  const cleanupFencePromptPromise = agentPrompt({
    agentId: cleanupFenceAgent.agent.agentId,
    requestId: 'cleanup-transition-fence-1',
    task: 'COMPLETE_WITH_CONCURRENT_STOP_ATTEMPT',
    wait: true,
    timeoutMs: 10_000,
  });
  let cleanupTransitionObserved = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const current = metadata.agents[cleanupFenceAgent.agent.agentId];
    if (current?.lifecycle === 'suspending' && current.transitionId && current.transitionOwnerPid === process.pid) {
      cleanupTransitionObserved = true;
      break;
    }
  }
  if (!cleanupTransitionObserved) throw new Error('Completion cleanup never exposed its owned suspending transition');
  const cleanupStopSource = `
import { agentStop } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
try {
  await agentStop({ agentId: ${JSON.stringify(cleanupFenceAgent.agent.agentId)} });
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? error?.herdr?.code ?? null, message: error?.message ?? String(error) }));
}
`;
  const cleanupConcurrentStop = JSON.parse((await execFileAsync(process.execPath, ['--input-type=module', '-e', cleanupStopSource], {
    cwd: root,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout);
  if (cleanupConcurrentStop.ok || cleanupConcurrentStop.code !== 'agent_lifecycle_in_flight') {
    throw new Error(`Concurrent stop was not fenced from completion cleanup: ${JSON.stringify(cleanupConcurrentStop)}`);
  }
  const cleanupFencePrompt = await cleanupFencePromptPromise;
  if (cleanupFencePrompt.runtimeDisposition?.action !== 'suspended') {
    throw new Error(`Fenced completion cleanup did not finish normally: ${JSON.stringify(cleanupFencePrompt.runtimeDisposition)}`);
  }
  const cleanupFenceMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents[cleanupFenceAgent.agent.agentId];
  if (
    cleanupFenceMetadata?.lifecycle !== 'suspended' ||
    cleanupFenceMetadata.transitionId !== undefined ||
    cleanupFenceMetadata.transitionOwnerPid !== undefined
  ) {
    throw new Error(`Completion cleanup transition did not settle cleanly: ${JSON.stringify(cleanupFenceMetadata)}`);
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.promptResultStatus;
  delete state.delayWorkspaceCloseFor;
  delete state.delayWorkspaceCloseMs;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}
`, 'utf8');
  await agentStop({ agentId: cleanupFenceAgent.agent.agentId });

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.omitNativeSessionId = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const completedNonResumable = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const completedNonResumableRuntimeId = completedNonResumable.agent.runtimeAgentId;
  const completedNonResumableWorkspaceId = state.agents[completedNonResumableRuntimeId].workspace_id;
  delete state.omitNativeSessionId;
  state.promptResultStatus = 'done';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const completedNonResumablePrompt = await agentPrompt({
    agentId: completedNonResumable.agent.agentId,
    task: 'COMPLETE_AND_STOP',
    wait: true,
    timeoutMs: 10_000,
  });
  if (completedNonResumablePrompt.runtimeDisposition?.action !== 'stopped' || !completedNonResumablePrompt.runtimeDisposition.discarded) {
    throw new Error(`Completed non-resumable prompt was not auto-stopped: ${JSON.stringify(completedNonResumablePrompt.runtimeDisposition)}`);
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const completedNonResumableMetadata = JSON.parse(await fs.readFile(path.join(home, '.local', 'state', 'agent-vm-mcp', 'agents.json'), 'utf8')).agents[completedNonResumable.agent.agentId];
  if (state.agents[completedNonResumableRuntimeId] || state.workspaces[completedNonResumableWorkspaceId] || completedNonResumableMetadata) {
    throw new Error('Completed non-resumable prompt left runtime or durable metadata behind');
  }
  delete state.promptResultStatus;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.omitNativeSessionId = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const lateCodexSession = await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const lateCodexRuntimeId = lateCodexSession.agent.runtimeAgentId;
  const lateCodexWorkspaceId = state.agents[lateCodexRuntimeId].workspace_id;
  delete state.omitNativeSessionId;
  state.promptResultStatus = 'done';
  state.createCodexSessionOnPromptFor = lateCodexRuntimeId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const lateCodexPrompt = await agentPrompt({
    agentId: lateCodexSession.agent.agentId,
    task: 'CREATE_LATE_NATIVE_SESSION',
    wait: true,
    timeoutMs: 10_000,
  });
  if (lateCodexPrompt.runtimeDisposition?.action !== 'suspended') {
    throw new Error(`Late Codex native session was not discovered before completion cleanup: ${JSON.stringify(lateCodexPrompt.runtimeDisposition)}`);
  }
  const lateCodexNativeSessionId = `late-session-${lateCodexRuntimeId}`;
  const lateCodexMetadata = JSON.parse(await fs.readFile(path.join(home, '.local', 'state', 'agent-vm-mcp', 'agents.json'), 'utf8')).agents[lateCodexSession.agent.agentId];
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (
    state.agents[lateCodexRuntimeId] ||
    state.workspaces[lateCodexWorkspaceId] ||
    lateCodexMetadata?.lifecycle !== 'suspended' ||
    lateCodexMetadata.nativeSessionId !== lateCodexNativeSessionId ||
    lateCodexMetadata.nativeSessionAttribution !== 'verified' ||
    lateCodexMetadata.resumable !== true
  ) {
    throw new Error(`Late Codex native session attribution was not durably preserved: ${JSON.stringify(lateCodexMetadata)}`);
  }
  delete state.promptResultStatus;
  delete state.createCodexSessionOnPromptFor;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const lateCodexResumed = await agentResume({ agentId: lateCodexSession.agent.agentId });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const lateCodexResumedRuntime = state.agents[lateCodexResumed.agent.runtimeAgentId];
  if (!lateCodexResumedRuntime || !lateCodexResumedRuntime.launch_args.includes(lateCodexNativeSessionId)) {
    throw new Error('Late-discovered Codex native session was not used for resume');
  }
  await agentStop({ agentId: lateCodexSession.agent.agentId });

  const noWaitDone = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.promptResultStatus = 'done';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const noWaitDonePrompt = await agentPrompt({
    agentId: noWaitDone.agent.agentId,
    task: 'DONE_BUT_DONT_WAIT',
    wait: false,
    timeoutMs: 10_000,
  });
  if (noWaitDonePrompt.runtimeDisposition?.action !== 'retained' || noWaitDonePrompt.runtimeDisposition.reason !== 'wait_disabled') {
    throw new Error(`wait=false prompt was unexpectedly auto-finalized: ${JSON.stringify(noWaitDonePrompt.runtimeDisposition)}`);
  }
  delete state.promptResultStatus;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await agentStop({ agentId: noWaitDone.agent.agentId });

  const cleanupFailureAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const cleanupFailureWorkspaceId = state.agents[cleanupFailureAgent.agent.runtimeAgentId].workspace_id;
  state.promptResultStatus = 'done';
  state.failWorkspaceCloseFor = cleanupFailureWorkspaceId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const cleanupFailurePrompt = await agentPrompt({
    agentId: cleanupFailureAgent.agent.agentId,
    task: 'COMPLETE_WITH_CLEANUP_FAILURE',
    wait: true,
    timeoutMs: 10_000,
  });
  if (!cleanupFailurePrompt.accepted || cleanupFailurePrompt.runtimeDisposition?.action !== 'cleanup_failed') {
    throw new Error(`Completion cleanup failure corrupted successful prompt semantics: ${JSON.stringify(cleanupFailurePrompt)}`);
  }
  const cleanupFailureMetadata = JSON.parse(await fs.readFile(path.join(home, '.local', 'state', 'agent-vm-mcp', 'agents.json'), 'utf8')).agents[cleanupFailureAgent.agent.agentId];
  if (cleanupFailureMetadata?.lifecycle !== 'suspending') {
    throw new Error(`Completion cleanup failure did not retain recoverable transitional metadata: ${JSON.stringify(cleanupFailureMetadata)}`);
  }
  const cleanupFailureResult = await agentPromptResult({ requestId: cleanupFailurePrompt.requestId });
  if (
    !cleanupFailureResult.found ||
    cleanupFailureResult.completion?.state !== 'completed' ||
    !cleanupFailureResult.result?.transcript.includes('COMPLETE_WITH_CLEANUP_FAILURE') ||
    cleanupFailureResult.result?.runtimeDisposition?.action !== 'cleanup_failed'
  ) {
    throw new Error(`Completion result was not durable before cleanup recovery: ${JSON.stringify(cleanupFailureResult)}`);
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.promptResultStatus;
  delete state.failWorkspaceCloseFor;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await agentStop({ agentId: cleanupFailureAgent.agent.agentId });

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const ownedWorkspaceId = state.agents[codex.agent.agentId].workspace_id;
  state.workspaces[ownedWorkspaceId].workspace.label = 'not-owned-by-mcp';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await agentGet({ agentId: codex.agent.agentId });
    throw new Error('Ownership mismatch unexpectedly succeeded');
  } catch (error) {
    if (!String(error.message).includes('not an MCP-managed')) throw error;
  }
  const filteredCapabilities = await agentCapabilities();
  if (filteredCapabilities.runtime.session.agents.some((agent) => agent.agentId === codex.agent.agentId)) {
    throw new Error('Ownership-mismatched agent leaked through capabilities');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.workspaces[ownedWorkspaceId].workspace.label = codex.agent.agentId;
  state.renameWorkspaceDuringReadFor = codex.agent.agentId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await agentRead({ agentId: codex.agent.agentId, source: 'visible', lines: 20 });
    throw new Error('Ownership race during read unexpectedly returned transcript');
  } catch (error) {
    if (!String(error.message).includes('not an MCP-managed')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.workspaces[ownedWorkspaceId].workspace.label = codex.agent.agentId;
  delete state.renameWorkspaceDuringReadFor;
  state.agents[codex.agent.agentId].interactive_ready = false;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const notReady = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_NOT_READY',
    wait: true,
    timeoutMs: 10_000,
  });
  if (
    notReady.accepted !== false ||
    notReady.submission?.state !== 'not_submitted' ||
    notReady.submission?.retrySafe !== true ||
    notReady.error?.code !== 'agent_not_ready' ||
    notReady.error?.retryable !== true
  ) {
    throw new Error('interactive_ready=false was not positively gated');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.agents[codex.agent.agentId].transcript.includes('MUST_NOT_SUBMIT_NOT_READY')) {
    throw new Error('Not-ready task reached agent transcript');
  }
  state.agents[codex.agent.agentId].interactive_ready = true;
  state.agents[codex.agent.agentId].agent_status = 'unknown';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const unknownState = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_UNKNOWN',
    wait: true,
    timeoutMs: 10_000,
  });
  if (unknownState.accepted !== false || unknownState.error?.code !== 'agent_not_ready') {
    throw new Error('unknown agent state was not gated');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.agents[codex.agent.agentId].agent_status = 'idle';
  state.failReadFor = codex.agent.agentId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const unreadable = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_UNREADABLE',
    wait: true,
    timeoutMs: 10_000,
  });
  if (unreadable.accepted !== false || unreadable.error?.code !== 'agent_screen_unreliable') {
    throw new Error('Unreadable visible terminal was not gated');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.failReadFor;
  state.promptFailure = 'after_mutation';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const ambiguous = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'AMBIGUOUS_SUBMISSION',
    wait: true,
    timeoutMs: 10_000,
  });
  if (
    ambiguous.accepted !== null ||
    ambiguous.submission?.state !== 'possibly_submitted' ||
    ambiguous.submission?.retrySafe !== false ||
    ambiguous.error?.retryable !== false
  ) {
    throw new Error('Post-invocation prompt failure was not reported as possibly submitted');
  }
  if (!ambiguous.transcript.includes('AMBIGUOUS_SUBMISSION')) throw new Error('Ambiguous submission diagnostics lost transcript evidence');
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.promptFailure;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const spawnRejected = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'NUL\0TASK',
    wait: true,
    timeoutMs: 10_000,
  });
  if (
    spawnRejected.accepted !== false ||
    spawnRejected.submission?.state !== 'not_submitted' ||
    spawnRejected.submission?.retrySafe !== true ||
    spawnRejected.error?.code !== 'agent_prompt_not_submitted'
  ) throw new Error('Pre-spawn prompt failure was not reported as definitely not submitted');

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.promptFailure = 'hang_after_mutation';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const timedOutPrompt = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'TIMEOUT_AFTER_SUBMISSION',
    wait: true,
    timeoutMs: 1_000,
  });
  if (
    timedOutPrompt.accepted !== null ||
    timedOutPrompt.submission?.state !== 'possibly_submitted' ||
    timedOutPrompt.submission?.retrySafe !== false ||
    timedOutPrompt.error?.cause?.timedOut !== true
  ) throw new Error('Actual prompt timeout was not reported as possibly submitted');
  if (!timedOutPrompt.transcript.includes('TIMEOUT_AFTER_SUBMISSION')) {
    throw new Error('Timed-out prompt diagnostics lost submission evidence');
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.promptFailure = 'hang_after_mutation';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const promptController = new AbortController();
  const cancelledPromptPromise = agentPrompt(
    { agentId: codex.agent.agentId, task: 'CANCEL_AFTER_SUBMISSION', wait: true, timeoutMs: 10_000 },
    promptController.signal,
  );
  const cancelDeadline = Date.now() + 2_000;
  while (Date.now() < cancelDeadline) {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state.agents[codex.agent.agentId].transcript.includes('CANCEL_AFTER_SUBMISSION')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!state.agents[codex.agent.agentId].transcript.includes('CANCEL_AFTER_SUBMISSION')) {
    throw new Error('Cancellation test never observed prompt submission');
  }
  promptController.abort();
  const cancelledPrompt = await cancelledPromptPromise;
  if (
    cancelledPrompt.accepted !== null ||
    cancelledPrompt.submission?.state !== 'possibly_submitted' ||
    cancelledPrompt.submission?.retrySafe !== false ||
    cancelledPrompt.error?.cause?.cancelled !== true
  ) throw new Error('Actual post-submission cancellation was not reported as possibly submitted');

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.promptFailure = 'hang_with_descendant';
  delete state.descendantPid;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const descendantTimeout = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'TIMEOUT_WITH_SIGTERM_IGNORING_DESCENDANT',
    wait: true,
    timeoutMs: 1_000,
  });
  if (descendantTimeout.accepted !== null || descendantTimeout.error?.cause?.timedOut !== true) {
    throw new Error('Descendant timeout scenario did not report unknown submission outcome');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const descendantPid = state.descendantPid;
  if (!Number.isInteger(descendantPid) || descendantPid <= 1) throw new Error('Descendant PID was not recorded');
  const descendantDeadline = Date.now() + 2_000;
  let descendantAlive = true;
  while (Date.now() < descendantDeadline) {
    try {
      process.kill(descendantPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (error) {
      if (error?.code === 'ESRCH') {
        descendantAlive = false;
        break;
      }
      throw error;
    }
  }
  if (descendantAlive) {
    try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    throw new Error('SIGTERM-ignoring descendant survived runProgram process-group escalation');
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.promptFailure = 'hang_with_descendant';
  delete state.descendantPid;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const descendantCancelController = new AbortController();
  const descendantCancelPromise = agentPrompt({
    agentId: codex.agent.agentId,
    task: 'CANCEL_WITH_SIGTERM_IGNORING_DESCENDANT',
    wait: true,
    timeoutMs: 10_000,
  }, descendantCancelController.signal);
  const descendantCancelStartDeadline = Date.now() + 2_000;
  let cancelledDescendantPid = null;
  while (Date.now() < descendantCancelStartDeadline) {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (Number.isInteger(state.descendantPid) && state.descendantPid > 1) {
      cancelledDescendantPid = state.descendantPid;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!cancelledDescendantPid) {
    descendantCancelController.abort();
    await descendantCancelPromise.catch(() => {});
    throw new Error('Cancellation descendant scenario never recorded its child PID');
  }
  descendantCancelController.abort();
  const descendantCancelled = await descendantCancelPromise;
  if (descendantCancelled.accepted !== null || descendantCancelled.error?.cause?.cancelled !== true) {
    throw new Error('Descendant cancellation scenario did not report unknown submission outcome');
  }
  const cancelledDescendantDeadline = Date.now() + 2_000;
  let cancelledDescendantAlive = true;
  while (Date.now() < cancelledDescendantDeadline) {
    try {
      process.kill(cancelledDescendantPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (error) {
      if (error?.code === 'ESRCH') {
        cancelledDescendantAlive = false;
        break;
      }
      throw error;
    }
  }
  if (cancelledDescendantAlive) {
    try { process.kill(cancelledDescendantPid, 'SIGKILL'); } catch {}
    throw new Error('SIGTERM-ignoring descendant survived cancellation escalation');
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.promptFailure;
  delete state.descendantPid;
  state.hangReadFor = codex.agent.agentId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const preflightStartedAt = Date.now();
  const boundedPreflight = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_PREFLIGHT_TIMEOUT',
    wait: true,
    timeoutMs: 250,
  });
  const preflightElapsedMs = Date.now() - preflightStartedAt;
  if (
    boundedPreflight.accepted !== false ||
    boundedPreflight.submission?.state !== 'not_submitted' ||
    boundedPreflight.submission?.retrySafe !== true ||
    !['agent_screen_unreliable', 'agent_prompt_not_submitted'].includes(boundedPreflight.error?.code)
  ) {
    throw new Error('Timed-out readiness read did not fail closed as not_submitted');
  }
  if (preflightElapsedMs > 2_000) {
    throw new Error(`Readiness preflight exceeded bounded timeout: ${preflightElapsedMs}ms`);
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.hangReadFor;
  state.hangSnapshot = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const snapshotPreflightStartedAt = Date.now();
  const snapshotPreflight = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_SNAPSHOT_TIMEOUT',
    wait: true,
    timeoutMs: 250,
  });
  const snapshotPreflightElapsedMs = Date.now() - snapshotPreflightStartedAt;
  if (
    snapshotPreflight.accepted !== false ||
    snapshotPreflight.submission?.state !== 'not_submitted' ||
    snapshotPreflight.submission?.retrySafe !== true ||
    snapshotPreflight.error?.cause?.code !== 'timeout'
  ) {
    throw new Error('Timed-out ownership snapshot was not reported as retry-safe not_submitted');
  }
  if (snapshotPreflightElapsedMs > 2_000) {
    throw new Error(`Ownership snapshot preflight exceeded bounded timeout: ${snapshotPreflightElapsedMs}ms`);
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.hangSnapshot;
  state.armSlowExecutableResolveAfterFinalOwnership = codex.agent.agentId;
  state.visibleReadsUntilSlowResolve = 2;
  state.agents[codex.agent.agentId].agent_status = 'idle';
  state.agents[codex.agent.agentId].interactive_ready = true;
  state.agents[codex.agent.agentId].transcript = 'READY BEFORE SPAWN DEADLINE';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const originalStat = fs.stat;
  fs.stat = async (candidate, ...args) => {
    if (path.resolve(String(candidate)) === path.resolve(herdrPath)) {
      const current = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (current.slowNextExecutableResolve) {
        delete current.slowNextExecutableResolve;
        await fs.writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
    }
    return await originalStat(candidate, ...args);
  };
  let deadlineBeforeSpawn;
  try {
    deadlineBeforeSpawn = await agentPrompt({
      agentId: codex.agent.agentId,
      task: 'MUST_NOT_SPAWN_AFTER_PREFLIGHT_DEADLINE',
      wait: true,
      timeoutMs: 1_000,
    });
  } finally {
    fs.stat = originalStat;
  }
  if (
    deadlineBeforeSpawn.accepted !== false ||
    deadlineBeforeSpawn.submission?.state !== 'not_submitted' ||
    deadlineBeforeSpawn.submission?.retrySafe !== true ||
    deadlineBeforeSpawn.error?.cause?.code !== 'deadline_exceeded'
  ) {
    throw new Error('Executable resolution crossing the preflight deadline did not fail closed before spawn');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.agents[codex.agent.agentId].transcript.includes('MUST_NOT_SPAWN_AFTER_PREFLIGHT_DEADLINE')) {
    throw new Error('Prompt process spawned after the absolute preflight deadline elapsed');
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.agents[codex.agent.agentId].agent_status = 'idle';
  state.agents[codex.agent.agentId].interactive_ready = true;
  state.agents[codex.agent.agentId].transcript = 'READY BEFORE FINAL GATE';
  state.markWorkingAfterReadFor = codex.agent.agentId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const racedReadiness = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_AFTER_READINESS_RACE',
    wait: true,
    timeoutMs: 2_000,
  });
  if (
    racedReadiness.accepted !== false ||
    racedReadiness.submission?.state !== 'not_submitted' ||
    racedReadiness.error?.code !== 'agent_not_ready'
  ) {
    throw new Error('Final readiness gate did not fail closed after agent state changed');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.agents[codex.agent.agentId].transcript.includes('MUST_NOT_SUBMIT_AFTER_READINESS_RACE')) {
    throw new Error('Prompt was submitted after readiness changed during preflight');
  }
  state.agents[codex.agent.agentId].agent_status = 'idle';
  state.agents[codex.agent.agentId].transcript = 'READY FOR SERIALIZATION';
  state.promptFailure = 'hang_after_mutation';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const serializedFirst = agentPrompt({
    agentId: codex.agent.agentId,
    task: 'FIRST_SERIALIZED_PROMPT',
    wait: true,
    timeoutMs: 1_000,
  });
  let firstPromptObserved = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state.agents[codex.agent.agentId].transcript.includes('FIRST_SERIALIZED_PROMPT')) {
      firstPromptObserved = true;
      break;
    }
  }
  if (!firstPromptObserved) throw new Error('First serialized prompt never reached fake Herdr');
  const serializedSecond = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_CONCURRENT_PROMPT',
    wait: true,
    timeoutMs: 1_000,
  });
  if (
    serializedSecond.accepted !== null ||
    serializedSecond.submission?.state !== 'possibly_submitted' ||
    serializedSecond.submission?.retrySafe !== false ||
    serializedSecond.error?.retryable !== false ||
    serializedSecond.error?.code !== 'agent_prompt_in_flight'
  ) {
    throw new Error('Concurrent prompt was not rejected by per-agent serialization');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.agents[codex.agent.agentId].transcript.includes('MUST_NOT_SUBMIT_CONCURRENT_PROMPT')) {
    throw new Error('Concurrent prompt reached Herdr despite per-agent serialization');
  }
  await serializedFirst;
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.promptFailure;
  state.agents[codex.agent.agentId].agent_status = 'idle';
  state.agents[codex.agent.agentId].transcript = 'READY';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const missingSkill = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_MISSING_SKILL',
    skills: ['missing-skill'],
    wait: true,
    timeoutMs: 10_000,
  });
  if (
    missingSkill.accepted !== false ||
    missingSkill.submission?.state !== 'not_submitted' ||
    missingSkill.submission?.retrySafe !== true ||
    missingSkill.error?.code !== 'agent_prompt_not_submitted' ||
    missingSkill.error?.retryable !== false ||
    missingSkill.error?.cause?.code !== 'skill_not_installed'
  ) {
    throw new Error('Missing skill did not return structured non-retryable preflight with duplicate-safe submission state');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.agents[codex.agent.agentId].transcript.includes('MUST_NOT_SUBMIT_MISSING_SKILL')) {
    throw new Error('Missing-skill task reached agent transcript');
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.agents[codex.agent.agentId].transcript = 'Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const blocked = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'Must not be typed into trust dialog.',
    wait: true,
    timeoutMs: 10_000,
  });
  if (
    blocked.accepted ||
    blocked.submission?.state !== 'not_submitted' ||
    blocked.submission?.retrySafe !== true ||
    blocked.error?.code !== 'interaction_required' ||
    blocked.error?.retryable !== false
  ) {
    throw new Error('Trust interaction was not guarded');
  }
  if (blocked.agent.interaction?.kind !== 'workspace_trust') throw new Error('Trust interaction kind was not detected');
  if (blocked.agent.interaction?.requiresDecision !== true) throw new Error('Trust interaction did not require a policy decision');
  if ('requiresUserAction' in blocked.agent.interaction) throw new Error('Legacy requiresUserAction leaked into interaction contract');
  if (blocked.agent.interaction?.riskHints?.securitySensitive !== true) {
    throw new Error('Workspace trust interaction was not marked security-sensitive');
  }

  const afterKeys = await agentSendKeys({ agentId: codex.agent.agentId, keys: ['enter'] });
  if (afterKeys.interaction !== null) throw new Error('Trust interaction was not cleared by approved control key');
  const read = await agentRead({ agentId: codex.agent.agentId, source: 'visible', lines: 20 });
  if (!read.text.includes('READY AFTER TRUST')) throw new Error('agentRead did not return fake transcript');
  const got = await agentGet({ agentId: codex.agent.agentId });
  if (got.status !== 'idle') throw new Error('agentGet returned unexpected state');

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.agents[codex.agent.agentId].agent_status = 'blocked';
  state.agents[codex.agent.agentId].transcript = [
    'Would you like to run the following command?',
    '',
    'Environment: local',
    '',
    'Reason: inspect the current working tree',
    '',
    '$ git status --short',
    '',
    '› 1. Yes, proceed (y)',
    '  2. No (esc)',
  ].join('\n');
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const readOnlyDecision = await agentGet({ agentId: codex.agent.agentId });
  if (readOnlyDecision.interaction?.kind !== 'command_approval') throw new Error('Command approval was not detected');
  if (readOnlyDecision.interaction?.requiresDecision !== true) throw new Error('Command approval did not require a policy decision');
  if (readOnlyDecision.interaction?.command !== 'git status --short') {
    throw new Error(`Command approval extraction mismatch: ${readOnlyDecision.interaction?.command}`);
  }
  if (readOnlyDecision.interaction?.riskHints?.readOnly !== true || readOnlyDecision.interaction?.riskHints?.workspaceMutation !== false) {
    throw new Error('Confident read-only command approval did not expose conservative risk hints');
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.agents[codex.agent.agentId].transcript = [
    'Would you like to run the following command?',
    '',
    '$ git reset --hard HEAD',
    '',
    '› 1. Yes, proceed (y)',
  ].join('\n');
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const unknownRiskDecision = await agentGet({ agentId: codex.agent.agentId });
  if (unknownRiskDecision.interaction?.kind !== 'command_approval') throw new Error('Mutating command approval was not detected');
  if (unknownRiskDecision.interaction?.riskHints?.readOnly !== null || unknownRiskDecision.interaction?.riskHints?.workspaceMutation !== null) {
    throw new Error('Runtime overclaimed authorization-relevant risk hints for a mutating command');
  }

  for (const unclassifiedCommand of [
    'git status --short && git ls-files --others --exclude-standard',
    'git diff --check',
    'git diff --output=/tmp/diff.txt',
    'git diff --ext-diff',
    'git diff --textconv',
    "rg --pre 'touch /tmp/pwn' needle file",
    "sed -n 's/x/touch \/tmp\/pwn/e' file",
    'sed -n -i backup.txt',
  ]) {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.agents[codex.agent.agentId].transcript = [
      'Would you like to run the following command?',
      '',
      `$ ${unclassifiedCommand}`,
      '',
      '› 1. Yes, proceed (y)',
    ].join('\n');
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const unclassifiedDecision = await agentGet({ agentId: codex.agent.agentId });
    if (unclassifiedDecision.interaction?.riskHints?.readOnly !== null) {
      throw new Error(`Runtime overclaimed read-only risk hint for intentionally unclassified command: ${unclassifiedCommand}`);
    }
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.agents[codex.agent.agentId].agent_status = 'idle';
  state.agents[codex.agent.agentId].transcript = 'READY';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const validPromptHerdrPath = process.env.AGENT_HERDR_BIN;
  process.env.AGENT_HERDR_BIN = path.join(root, 'missing-herdr-during-prompt');
  const unavailablePrompt = await agentPrompt({
    agentId: codex.agent.agentId,
    task: 'MUST_NOT_SUBMIT_WITHOUT_HERDR',
    wait: true,
    timeoutMs: 1_000,
  });
  process.env.AGENT_HERDR_BIN = validPromptHerdrPath;
  if (
    unavailablePrompt.accepted !== false ||
    unavailablePrompt.submission?.state !== 'not_submitted' ||
    unavailablePrompt.submission?.retrySafe !== true ||
    unavailablePrompt.error?.cause?.code !== 'herdr_unavailable'
  ) {
    throw new Error('Unavailable Herdr preflight did not become retry-safe not_submitted');
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const sentKeysBeforeRace = state.agents[codex.agent.agentId].sent_keys.length;
  state.renameWorkspaceDuringGetFor = codex.agent.agentId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await agentSendKeys({ agentId: codex.agent.agentId, keys: ['tab'] });
    throw new Error('Ownership race before send-keys unexpectedly mutated the agent');
  } catch (error) {
    if (!String(error.message).includes('not an MCP-managed')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.agents[codex.agent.agentId].sent_keys.length !== sentKeysBeforeRace) {
    throw new Error('send-keys mutated the agent after ownership changed during preflight');
  }
  state.workspaces[ownedWorkspaceId].workspace.label = codex.agent.agentId;
  delete state.renameWorkspaceDuringGetFor;
  state.renameWorkspaceAfterGetFor = ownedWorkspaceId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await agentStop({ agentId: codex.agent.agentId });
    throw new Error('Ownership race before stop unexpectedly closed the workspace');
  } catch (error) {
    if (!String(error.message).includes('not an MCP-managed')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (!state.workspaces[ownedWorkspaceId]) throw new Error('stop closed workspace after ownership changed');
  state.workspaces[ownedWorkspaceId].workspace.label = codex.agent.agentId;
  delete state.renameWorkspaceAfterGetFor;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await agentStop({ agentId: codex.agent.agentId });

  const resumeFenceAgent = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  const resumeFenceInitialRuntimeId = resumeFenceAgent.agent.runtimeAgentId;
  if (!(await agentSuspend({ agentId: resumeFenceAgent.agent.agentId })).suspended) {
    throw new Error('Resume fence fixture did not suspend');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.delayNextWorkspaceCreateMs = 1_500;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}
`, 'utf8');
  const resumeFencePromise = agentResume({ agentId: resumeFenceAgent.agent.agentId });
  let resumeTransitionObserved = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const current = metadata.agents[resumeFenceAgent.agent.agentId];
    if (
      current?.lifecycle === 'resuming' &&
      current.transitionId &&
      current.transitionOwnerPid === process.pid &&
      current.runtimeAgentId &&
      current.runtimeAgentId !== resumeFenceInitialRuntimeId
    ) {
      resumeTransitionObserved = true;
      break;
    }
  }
  if (!resumeTransitionObserved) throw new Error('Resume never exposed its owned resuming transition');
  const resumeStopSource = `
import { agentStop } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, 'src', 'agents.js')).href)};
try {
  await agentStop({ agentId: ${JSON.stringify(resumeFenceAgent.agent.agentId)} });
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? error?.herdr?.code ?? null, message: error?.message ?? String(error) }));
}
`;
  const resumeConcurrentStop = JSON.parse((await execFileAsync(process.execPath, ['--input-type=module', '-e', resumeStopSource], {
    cwd: root,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout);
  if (resumeConcurrentStop.ok || resumeConcurrentStop.code !== 'agent_lifecycle_in_flight') {
    throw new Error(`Concurrent stop was not fenced from live resume: ${JSON.stringify(resumeConcurrentStop)}`);
  }
  const resumeFenceResult = await resumeFencePromise;
  if (!resumeFenceResult.resumed || resumeFenceResult.agent.runtimeAgentId === resumeFenceInitialRuntimeId) {
    throw new Error(`Fenced resume did not complete normally: ${JSON.stringify(resumeFenceResult)}`);
  }
  const resumeFenceMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents[resumeFenceAgent.agent.agentId];
  if (
    resumeFenceMetadata?.lifecycle !== 'active' ||
    resumeFenceMetadata.runtimeAgentId !== resumeFenceResult.agent.runtimeAgentId ||
    resumeFenceMetadata.transitionId !== undefined ||
    resumeFenceMetadata.transitionOwnerPid !== undefined
  ) {
    throw new Error(`Resume transition did not settle cleanly: ${JSON.stringify(resumeFenceMetadata)}`);
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.delayNextWorkspaceCreateMs;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}
`, 'utf8');
  await agentStop({ agentId: resumeFenceAgent.agent.agentId });

  const agy = await agentStart({
    harness: 'agy',
    cwd: root,
    model: 'gemini-3.7-flash-high',
    effort: 'high',
    timeoutMs: 10_000,
  });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const agyLaunch = state.agents[agy.agent.agentId].launch_args;
  if (JSON.stringify(agyLaunch) !== JSON.stringify(['--model', 'gemini-3.7-flash-high', '--effort', 'high'])) {
    throw new Error(`Unexpected agy launch args: ${JSON.stringify(agyLaunch)}`);
  }
  await agentStop({ agentId: agy.agent.agentId });

  const resumable = await agentStart({
    harness: 'codex',
    cwd: root,
    model: 'gpt-5.6-luna',
    effort: 'max',
    timeoutMs: 10_000,
  });
  await agentPrompt({ agentId: resumable.agent.agentId, task: 'PERSIST_THIS_NATIVE_SESSION', timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const resumableRuntimeId = resumable.agent.runtimeAgentId;
  const resumableWorkspaceId = state.agents[resumableRuntimeId].workspace_id;
  const resumableNativeSessionId = state.agents[resumableRuntimeId].native_session_id;
  const suspended = await agentSuspend({ agentId: resumable.agent.agentId });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (!suspended.suspended || state.agents[resumableRuntimeId] || state.workspaces[resumableWorkspaceId]) {
    throw new Error('agent_suspend did not close the ephemeral runtime workspace/process');
  }
  if (!(await agentSuspend({ agentId: resumable.agent.agentId })).alreadySuspended) {
    throw new Error('repeated suspend was not idempotent');
  }
  const suspendedMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents[resumable.agent.agentId];
  if (suspendedMetadata.lifecycle !== 'suspended' || suspendedMetadata.nativeSessionId !== resumableNativeSessionId || suspendedMetadata.runtimeAgentId !== null) {
    throw new Error('agent_suspend did not persist logical/native metadata separately from runtime identity');
  }
  const discoveredSuspended = await agentCapabilities();
  const discoveredRecord = discoveredSuspended.runtime.session.agents.find((agent) => agent.agentId === resumable.agent.agentId);
  if (!discoveredRecord || discoveredRecord.lifecycle !== 'suspended' || discoveredRecord.nativeSessionId !== resumableNativeSessionId) {
    throw new Error('agent_capabilities did not discover the suspended logical agent');
  }
  const freshAgentsModule = await import(`../src/agents.js?fresh=${Date.now()}`);
  const freshProcessDiscovery = await freshAgentsModule.agentCapabilities();
  if (!freshProcessDiscovery.runtime.session.agents.some((agent) => agent.agentId === resumable.agent.agentId && agent.lifecycle === 'suspended')) {
    throw new Error('durable suspended metadata was not discoverable from a fresh MCP module instance');
  }
  const resumed = await agentResume({ agentId: resumable.agent.agentId });
  if (!resumed.resumed || resumed.agent.runtimeAgentId === resumableRuntimeId || resumed.agent.agentId !== resumable.agent.agentId) {
    throw new Error('agent_resume did not create a fresh runtime identity for the same logical agent');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const resumedRuntime = state.agents[resumed.agent.runtimeAgentId];
  if (
    !resumedRuntime ||
    JSON.stringify(resumedRuntime.launch_args) !==
      JSON.stringify([
        'resume',
        resumableNativeSessionId,
        '--model',
        'gpt-5.6-luna',
        '--config',
        'model_reasoning_effort="max"',
        '--profile',
        `agent-vm-mcp-${resumable.agent.agentId}`,
      ]) ||
    !resumedRuntime.transcript.includes('PERSIST_THIS_NATIVE_SESSION')
  ) {
    throw new Error('agent_resume did not preserve the enforced Codex model/effort or restore its transcript');
  }
  resumedRuntime.agent_status = 'working';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await agentSuspend({ agentId: resumable.agent.agentId });
    throw new Error('working agent was unexpectedly suspendable');
  } catch (error) {
    if (error?.code !== 'agent_not_suspendable') throw error;
  }
  resumedRuntime.agent_status = 'idle';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await agentPrompt({ agentId: resumable.agent.agentId, task: 'CONTINUE_THE_SAME_NATIVE_SESSION', timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (!state.agents[resumed.agent.runtimeAgentId].transcript.includes('CONTINUE_THE_SAME_NATIVE_SESSION')) {
    throw new Error('resumed logical agent did not accept continuation');
  }
  if (!(await agentSuspend({ agentId: resumable.agent.agentId })).suspended) {
    throw new Error('suspend after continuation failed');
  }
  await agentResume({ agentId: resumable.agent.agentId });
  const resumedAgain = await agentGet({ agentId: resumable.agent.agentId });
  await agentStop({ agentId: resumedAgain.agentId });

  const mismatchedProvenance = await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
  await agentSuspend({ agentId: mismatchedProvenance.agent.agentId });
  const mismatchedMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents[mismatchedProvenance.agent.agentId];
  await fs.appendFile(mismatchedMetadata.codexProvenance.profilePath, '# unexpected mutation\n', 'utf8');
  try {
    await agentResume({ agentId: mismatchedProvenance.agent.agentId });
    throw new Error('Codex resume with a mutated managed profile unexpectedly succeeded');
  } catch (error) {
    if (error?.code !== 'agent_codex_policy_unverified') throw error;
  }
  const quarantinedMismatch = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents[mismatchedProvenance.agent.agentId];
  if (quarantinedMismatch?.lifecycle !== 'quarantined' || quarantinedMismatch.policyStatus !== 'unverified') {
    throw new Error('Mismatched Codex provenance was not durably quarantined');
  }
  await agentStop({ agentId: mismatchedProvenance.agent.agentId });

  const agyResumable = await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 });
  await agentPrompt({ agentId: agyResumable.agent.agentId, task: 'PERSIST_THIS_AGY_CONVERSATION', timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const agyNativeSessionId = state.agents[agyResumable.agent.runtimeAgentId].native_session_id;
  await agentSuspend({ agentId: agyResumable.agent.agentId });
  const agyResumed = await agentResume({ agentId: agyResumable.agent.agentId });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const agyRuntime = state.agents[agyResumed.agent.runtimeAgentId];
  if (!agyRuntime || JSON.stringify(agyRuntime.launch_args) !== JSON.stringify(['--conversation', agyNativeSessionId]) || !agyRuntime.transcript.includes('PERSIST_THIS_AGY_CONVERSATION')) {
    throw new Error('agent_resume did not use Agy --conversation with the same native conversation');
  }
  await agentStop({ agentId: agyResumable.agent.agentId });

  const discardable = await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
  await agentSuspend({ agentId: discardable.agent.agentId });
  const discarded = await agentStop({ agentId: discardable.agent.agentId });
  if (!discarded.stopped || !discarded.discarded || JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents[discardable.agent.agentId]) {
    throw new Error('agent_stop did not discard suspended logical metadata');
  }

  const claude = await agentStart({ harness: 'claude', cwd: root, timeoutMs: 10_000 });
  try {
    await agentSuspend({ agentId: claude.agent.agentId });
    throw new Error('Claude suspend unexpectedly claimed native resume support');
  } catch (error) {
    if (error?.code !== 'agent_resume_unsupported') throw error;
  }
  await agentStop({ agentId: claude.agent.agentId });

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.emitAmbiguousNativeSessions = true;
  state.omitNativeSessionId = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const ambiguousOne = await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
  const ambiguousTwo = await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.emitAmbiguousNativeSessions;
  delete state.omitNativeSessionId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const ambiguousMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents;
  for (const ambiguous of [ambiguousOne, ambiguousTwo]) {
    const record = ambiguousMetadata[ambiguous.agent.agentId];
    if (!record || record.nativeSessionId !== null || record.resumable !== false || record.nativeSessionAttribution !== 'ambiguous') {
      throw new Error('Ambiguous same-cwd native sessions were incorrectly attributed to a logical agent');
    }
    if (ambiguous.agent.agentId === ambiguousOne.agent.agentId) {
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      state.promptResultStatus = 'done';
      await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      const ambiguousCompleted = await agentPrompt({
        agentId: ambiguous.agent.agentId,
        task: 'AMBIGUOUS_SESSION_MUST_REMAIN',
        wait: true,
        timeoutMs: 10_000,
      });
      if (
        ambiguousCompleted.runtimeDisposition?.action !== 'retained' ||
        ambiguousCompleted.runtimeDisposition.reason !== 'native_session_ambiguous'
      ) {
        throw new Error(`Ambiguous completed agent was destructively finalized: ${JSON.stringify(ambiguousCompleted.runtimeDisposition)}`);
      }
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      delete state.promptResultStatus;
      await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    }
    try {
      await agentSuspend({ agentId: ambiguous.agent.agentId });
      throw new Error('Ambiguous native session was unexpectedly suspendable');
    } catch (error) {
      if (error?.code !== 'agent_native_session_unavailable') throw error;
    }
    await agentStop({ agentId: ambiguous.agent.agentId });
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.emitSingleNativeSession = true;
  state.omitNativeSessionId = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const [concurrentOne, concurrentTwo] = await Promise.all([
    agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 }),
    agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 }),
  ]);
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.emitSingleNativeSession;
  delete state.omitNativeSessionId;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const concurrentNativeIds = [concurrentOne.agent.nativeSessionId, concurrentTwo.agent.nativeSessionId];
  if (concurrentNativeIds.some((id) => !id) || new Set(concurrentNativeIds).size !== 2 || concurrentOne.agent.nativeSessionAttribution !== 'verified' || concurrentTwo.agent.nativeSessionAttribution !== 'verified') {
    throw new Error(`Concurrent same-cwd starts did not receive distinct verified native sessions: ${JSON.stringify(concurrentNativeIds)}`);
  }
  await agentStop({ agentId: concurrentOne.agent.agentId });
  await agentStop({ agentId: concurrentTwo.agent.agentId });

  const recoveryIds = [
    'agent-11111111111111111111111111',
    'agent-22222222222222222222222222',
    'agent-33333333333333333333333333',
    'agent-44444444444444444444444444',
    'agent-55555555555555555555555555',
  ];
  const recoveryRuntimeIds = [
    'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa',
    'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb',
    'agent-cccccccccccccccccccccccccc',
    'agent-dddddddddddddddddddddddddd',
    'agent-99999999999999999999999999',
  ];
  const recoveryWorkspaceIds = ['recovery-w1', 'recovery-w2', 'recovery-w3', 'recovery-w4', 'recovery-orphan-w5'];
  const recoveryLifecycle = ['suspending', 'suspending', 'resuming', 'resuming', 'resuming'];
  const recoveryMetadata = { version: 1, agents: {} };
  for (let index = 0; index < recoveryIds.length; index += 1) {
    recoveryMetadata.agents[recoveryIds[index]] = {
      version: 1,
      agentId: recoveryIds[index],
      harness: 'agy',
      cwd: root,
      model: null,
      effort: null,
      nativeSessionId: `recovery-native-${index}`,
      nativeSessionAttribution: 'verified',
      resumable: true,
      runtimeAgentId: recoveryRuntimeIds[index],
      runtimeWorkspaceId: recoveryWorkspaceIds[index],
      lifecycle: recoveryLifecycle[index],
      updatedAt: new Date().toISOString(),
    };
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  for (const index of [0, 2]) {
    const workspaceId = recoveryWorkspaceIds[index];
    const runtimeAgentId = recoveryRuntimeIds[index];
    state.workspaces[workspaceId] = {
      workspace: { workspace_id: workspaceId, label: runtimeAgentId, number: 1 },
      paneId: `${workspaceId}:p1`,
      tabId: `${workspaceId}:t1`,
      cwd: root,
    };
    state.agents[runtimeAgentId] = {
      agent: 'agy', agent_status: 'idle', cwd: root, foreground_cwd: root,
      interactive_ready: true, name: runtimeAgentId, pane_id: `${workspaceId}:p1`,
      tab_id: `${workspaceId}:t1`, terminal_id: `term-${runtimeAgentId}`,
      workspace_id: workspaceId, transcript: 'RECOVERY READY', native_session_id: `recovery-native-${index}`,
    };
  }
  state.workspaces[recoveryWorkspaceIds[4]] = {
    workspace: { workspace_id: recoveryWorkspaceIds[4], label: recoveryRuntimeIds[4], number: 1 },
    paneId: `${recoveryWorkspaceIds[4]}:p1`, tabId: `${recoveryWorkspaceIds[4]}:t1`, cwd: root,
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(recoveryMetadata, null, 2)}\n`, 'utf8');
  const recoveryModule = await import(`../src/agents.js?recovery=${Date.now()}`);
  const recoveredCapabilities = await recoveryModule.agentCapabilities();
  const recoveredMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents;
  for (const [index, agentId] of recoveryIds.entries()) {
    const expectedLifecycle = index === 0 || index === 2 ? 'active' : 'suspended';
    if (recoveredMetadata[agentId]?.lifecycle !== expectedLifecycle) {
      throw new Error(`Crash reconciliation did not resolve recovery record ${agentId}`);
    }
    const discovered = recoveredCapabilities.runtime.session.agents.find((agent) => agent.agentId === agentId);
    if (!discovered || discovered.lifecycle !== expectedLifecycle) {
      throw new Error(`Crash reconciliation did not expose ${agentId} with ${expectedLifecycle} lifecycle`);
    }
  }
  const orphanState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (orphanState.workspaces[recoveryWorkspaceIds[4]] || orphanState.agents[recoveryRuntimeIds[4]]) {
    throw new Error('Resuming crash reconciliation left the exact orphan workspace behind');
  }
  for (const agentId of recoveryIds) await recoveryModule.agentStop({ agentId });

  const staleAbsentId = `agent-${'a'.repeat(26)}`;
  const staleAbsentRuntimeId = `agent-${'b'.repeat(26)}`;
  const staleAbsentWorkspaceId = 'stale-active-absent-workspace';
  const staleRecoverableId = 'agent-12121212121212121212121212';
  const staleRecoverableRuntimeId = 'agent-34343434343434343434343434';
  const staleRecoverableWorkspaceId = 'stale-active-recoverable-workspace';
  const staleOrphanId = `agent-${'c'.repeat(26)}`;
  const staleOrphanRuntimeId = `agent-${'d'.repeat(26)}`;
  const staleOrphanWorkspaceId = 'stale-active-orphan-workspace';
  const staleAmbiguousId = `agent-${'e'.repeat(26)}`;
  const staleAmbiguousRuntimeId = `agent-${'f'.repeat(26)}`;
  const staleAmbiguousWorkspaceIds = ['stale-active-ambiguous-1', 'stale-active-ambiguous-2'];
  for (const [agentId, runtimeAgentId, runtimeWorkspaceId] of [
    [staleAbsentId, staleAbsentRuntimeId, staleAbsentWorkspaceId],
    [staleOrphanId, staleOrphanRuntimeId, staleOrphanWorkspaceId],
    [staleAmbiguousId, staleAmbiguousRuntimeId, staleAmbiguousWorkspaceIds[0]],
  ]) {
    await recoveryModule.__testUpdateAgentMetadata(agentId, {
      version: 2,
      agentId,
      harness: 'agy',
      cwd: root,
      model: null,
      effort: null,
      nativeSessionId: null,
      nativeSessionAttribution: 'unavailable',
      resumable: false,
      runtimeAgentId,
      runtimeWorkspaceId,
      lifecycle: 'active',
      updatedAt: new Date().toISOString(),
    });
  }
  await recoveryModule.__testUpdateAgentMetadata(staleRecoverableId, {
    version: 2,
    agentId: staleRecoverableId,
    harness: 'agy',
    cwd: root,
    model: null,
    effort: null,
    nativeSessionId: 'stale-recoverable-native-session',
    nativeSessionAttribution: 'backend_reported',
    resumable: true,
    runtimeAgentId: staleRecoverableRuntimeId,
    runtimeWorkspaceId: staleRecoverableWorkspaceId,
    lifecycle: 'active',
    updatedAt: new Date().toISOString(),
  });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.workspaces[staleOrphanWorkspaceId] = {
    workspace: { workspace_id: staleOrphanWorkspaceId, label: staleOrphanRuntimeId, number: 1 },
    paneId: `${staleOrphanWorkspaceId}:p1`, tabId: `${staleOrphanWorkspaceId}:t1`, cwd: root,
  };
  for (const workspaceId of staleAmbiguousWorkspaceIds) {
    state.workspaces[workspaceId] = {
      workspace: { workspace_id: workspaceId, label: staleAmbiguousRuntimeId, number: 1 },
      paneId: `${workspaceId}:p1`, tabId: `${workspaceId}:t1`, cwd: root,
    };
  }
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const staleCapabilities = await recoveryModule.agentCapabilities();
  const staleMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents;
  for (const [agentId, runtimeAgentId] of [
    [staleAbsentId, staleAbsentRuntimeId],
    [staleOrphanId, staleOrphanRuntimeId],
  ]) {
    const record = staleMetadata[agentId];
    if (record?.lifecycle !== 'orphaned' || record.runtimeAgentId !== null || record.lastRuntimeAgentId !== runtimeAgentId) {
      throw new Error(`Stale active metadata did not reconcile to orphaned: ${JSON.stringify(record)}`);
    }
    const discovered = staleCapabilities.runtime.session.agents.find((agent) => agent.agentId === agentId);
    if (!discovered || discovered.lifecycle !== 'orphaned') {
      throw new Error(`Orphaned logical agent was not exposed by capabilities: ${agentId}`);
    }
  }
  const recoverableRecord = staleMetadata[staleRecoverableId];
  if (
    recoverableRecord?.lifecycle !== 'suspended' ||
    recoverableRecord.runtimeAgentId !== null ||
    recoverableRecord.nativeSessionId !== 'stale-recoverable-native-session' ||
    recoverableRecord.resumable !== true
  ) {
    throw new Error(`Recoverable stale active metadata did not reconcile to suspended: ${JSON.stringify(recoverableRecord)}`);
  }
  const recoverableDescription = staleCapabilities.runtime.session.agents.find((agent) => agent.agentId === staleRecoverableId);
  if (!recoverableDescription || recoverableDescription.lifecycle !== 'suspended' || recoverableDescription.resumable !== true) {
    throw new Error(`Recoverable stale active logical agent was not exposed as suspended: ${JSON.stringify(recoverableDescription)}`);
  }
  if (staleMetadata[staleAmbiguousId]?.lifecycle !== 'active') {
    throw new Error('Ambiguous stale active ownership was mutated during reconciliation');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.workspaces[staleOrphanWorkspaceId]) {
    throw new Error('Stale active reconciliation left an exactly-owned orphan workspace behind');
  }
  for (const workspaceId of staleAmbiguousWorkspaceIds) {
    if (!state.workspaces[workspaceId]) throw new Error('Ambiguous workspace was unexpectedly closed');
  }
  const orphanedGet = await recoveryModule.agentGet({ agentId: staleAbsentId });
  if (orphanedGet.lifecycle !== 'orphaned' || orphanedGet.runtimeAgentId !== null) {
    throw new Error(`agent_get did not expose durable orphaned state: ${JSON.stringify(orphanedGet)}`);
  }
  await recoveryModule.agentStop({ agentId: staleAbsentId });
  await recoveryModule.agentStop({ agentId: staleOrphanId });
  await recoveryModule.agentStop({ agentId: staleRecoverableId });
  await recoveryModule.__testUpdateAgentMetadata(staleAmbiguousId, null);
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  for (const workspaceId of staleAmbiguousWorkspaceIds) delete state.workspaces[workspaceId];
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const cleanedStaleMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents;
  if (
    cleanedStaleMetadata[staleAbsentId] ||
    cleanedStaleMetadata[staleOrphanId] ||
    cleanedStaleMetadata[staleRecoverableId] ||
    cleanedStaleMetadata[staleAmbiguousId]
  ) {
    throw new Error('Orphaned/suspended/ambiguous reconciliation fixtures were not cleaned up');
  }

  const missingProvenanceId = 'agent-66666666666666666666666666';
  const missingProvenanceRuntimeId = 'agent-77777777777777777777777777';
  const missingProvenanceWorkspaceId = 'missing-provenance-workspace';
  await recoveryModule.__testUpdateAgentMetadata(missingProvenanceId, {
    version: 1,
    agentId: missingProvenanceId,
    harness: 'codex',
    cwd: root,
    model: 'gpt-5.6-luna',
    effort: 'max',
    nativeSessionId: 'missing-provenance-native',
    nativeSessionAttribution: 'verified',
    resumable: true,
    runtimeAgentId: missingProvenanceRuntimeId,
    runtimeWorkspaceId: missingProvenanceWorkspaceId,
    lifecycle: 'active',
    updatedAt: new Date().toISOString(),
  });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.workspaces[missingProvenanceWorkspaceId] = {
    workspace: { workspace_id: missingProvenanceWorkspaceId, label: missingProvenanceRuntimeId, number: 1 },
    paneId: `${missingProvenanceWorkspaceId}:p1`, tabId: `${missingProvenanceWorkspaceId}:t1`, cwd: root,
  };
  state.agents[missingProvenanceRuntimeId] = {
    agent: 'codex', agent_status: 'idle', cwd: root, foreground_cwd: root,
    interactive_ready: true, name: missingProvenanceRuntimeId,
    pane_id: `${missingProvenanceWorkspaceId}:p1`, tab_id: `${missingProvenanceWorkspaceId}:t1`,
    terminal_id: `term-${missingProvenanceRuntimeId}`, workspace_id: missingProvenanceWorkspaceId,
    transcript: 'MISSING PROVENANCE READY',
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const missingProvenanceCapabilities = await recoveryModule.agentCapabilities();
  const missingProvenanceMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents[missingProvenanceId];
  const missingProvenanceDescription = missingProvenanceCapabilities.runtime.session.agents.find((agent) => agent.agentId === missingProvenanceId);
  if (
    missingProvenanceMetadata?.lifecycle !== 'quarantined' ||
    missingProvenanceMetadata.runtimeAgentId !== null ||
    missingProvenanceDescription?.lifecycle !== 'quarantined' ||
    missingProvenanceDescription.policyStatus !== 'unverified'
  ) {
    throw new Error('Persistent MCP Codex metadata without provenance was not fail-closed/quarantined');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.workspaces[missingProvenanceWorkspaceId] || state.agents[missingProvenanceRuntimeId]) {
    throw new Error('Quarantine did not close the exactly owned noncompliant Codex workspace');
  }
  try {
    await recoveryModule.agentResume({ agentId: missingProvenanceId });
    throw new Error('Codex resume without durable provenance unexpectedly succeeded');
  } catch (error) {
    if (error?.code !== 'agent_codex_policy_unverified') throw error;
  }
  await recoveryModule.agentStop({ agentId: missingProvenanceId });

  const legacyId = 'agent-eeeeeeeeeeeeeeeeeeeeeeeeee';
  const legacyWorkspaceId = 'legacy-workspace';
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.workspaces[legacyWorkspaceId] = {
    workspace: { workspace_id: legacyWorkspaceId, label: legacyId, number: 1 },
    paneId: `${legacyWorkspaceId}:p1`, tabId: `${legacyWorkspaceId}:t1`, cwd: root,
  };
  state.agents[legacyId] = {
    agent: 'codex', agent_status: 'idle', cwd: root, foreground_cwd: root,
    interactive_ready: true, name: legacyId, pane_id: `${legacyWorkspaceId}:p1`,
    tab_id: `${legacyWorkspaceId}:t1`, terminal_id: `term-${legacyId}`,
    workspace_id: legacyWorkspaceId, transcript: 'LEGACY READY',
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rm(metadataPath, { force: true });
  const legacyModule = await import(`../src/agents.js?legacy=${Date.now()}`);
  const legacyCapabilities = await legacyModule.agentCapabilities();
  const legacyDescription = legacyCapabilities.runtime.session.agents.find((agent) => agent.agentId === legacyId);
  if (!legacyDescription || legacyDescription.lifecycle !== 'active' || legacyDescription.legacy !== true || legacyDescription.resumable !== false) {
    throw new Error('Legacy active agent was not exposed as active non-resumable metadata');
  }
  for (const operation of [
    () => legacyModule.agentGet({ agentId: legacyId }),
    () => legacyModule.agentRead({ agentId: legacyId, source: 'visible', lines: 20 }),
    () => legacyModule.agentSuspend({ agentId: legacyId }),
  ]) {
    try {
      await operation();
      throw new Error('Legacy Codex agent unexpectedly remained usable without durable policy provenance');
    } catch (error) {
      if (error?.code !== 'agent_codex_policy_unverified') throw error;
    }
  }
  await legacyModule.agentStop({ agentId: legacyId });

  await fs.rm(metadataPath, { force: true });
  const metadataModuleA = await import(`../src/agents.js?metadata-a=${Date.now()}`);
  const metadataModuleB = await import(`../src/agents.js?metadata-b=${Date.now()}`);
  const concurrentMetadataA = {
    version: 1, agentId: 'agent-f1111111111111111111111111', harness: 'agy', cwd: root,
    nativeSessionId: 'metadata-native-a', nativeSessionAttribution: 'verified', resumable: true,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'suspended', updatedAt: new Date().toISOString(),
  };
  const concurrentMetadataB = {
    version: 1, agentId: 'agent-f2222222222222222222222222', harness: 'agy', cwd: root,
    nativeSessionId: 'metadata-native-b', nativeSessionAttribution: 'verified', resumable: true,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'suspended', updatedAt: new Date().toISOString(),
  };
  await Promise.all([
    metadataModuleA.__testUpdateAgentMetadata(concurrentMetadataA.agentId, concurrentMetadataA),
    metadataModuleB.__testUpdateAgentMetadata(concurrentMetadataB.agentId, concurrentMetadataB),
  ]);
  const concurrentMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents;
  if (!concurrentMetadata[concurrentMetadataA.agentId] || !concurrentMetadata[concurrentMetadataB.agentId]) {
    throw new Error('Concurrent fresh-module metadata mutations lost an independent agent record');
  }
  const metadataLockPath = `${metadataPath}.lock`;
  await fs.mkdir(metadataLockPath);
  const staleLockTime = new Date(Date.now() - 15_000);
  await fs.utimes(metadataLockPath, staleLockTime, staleLockTime);
  await metadataModuleA.__testUpdateAgentMetadata('agent-f4444444444444444444444444', {
    version: 1, agentId: 'agent-f4444444444444444444444', harness: 'agy', cwd: root,
    nativeSessionId: 'metadata-native-stale-lock', nativeSessionAttribution: 'verified', resumable: true,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'suspended', updatedAt: new Date().toISOString(),
  });
  if (await fs.stat(metadataLockPath).then(() => true, () => false)) throw new Error('Stale metadata lock was not reclaimed');

  await fs.mkdir(metadataLockPath);
  await fs.writeFile(
    path.join(metadataLockPath, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, token: 'active-metadata-lock-test' })}\n`,
    'utf8',
  );
  await fs.utimes(metadataLockPath, staleLockTime, staleLockTime);
  try {
    await metadataModuleA.__testUpdateAgentMetadata('agent-f6666666666666666666666666', {
      version: 2, agentId: 'agent-f6666666666666666666666666', harness: 'agy', cwd: root,
      nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
      runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'orphaned', updatedAt: new Date().toISOString(),
    });
    throw new Error('Live metadata lock was incorrectly reclaimed');
  } catch (error) {
    if (error?.code !== 'agent_metadata_lock_timeout') throw error;
  } finally {
    await fs.rm(metadataLockPath, { recursive: true, force: true });
  }

  const gcNow = Date.now();
  const gcOld = new Date(gcNow - 31 * 24 * 60 * 60 * 1_000).toISOString();
  const gcRecentBase = gcNow - 60_000;
  const gcMetadata = { version: 2, agents: {} };
  const gcExpiredOrphanId = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';
  const gcExpiredQuarantineId = 'agent-abbbbbbbbbbbbbbbbbbbbbbbbb';
  const gcProtectedQuarantineId = 'agent-accccccccccccccccccccccccc';
  const gcProtectedSuspendedId = 'agent-addddddddddddddddddddddddd';
  const gcInvalidTimestampId = 'agent-aeeeeeeeeeeeeeeeeeeeeeeeee';
  const gcNumericTimestampId = 'agent-aeffffffffffffffffffffffff';
  const gcFutureTimestampId = 'agent-afeeeeeeeeeeeeeeeeeeeeeeee';
  const gcMismatchedMapKey = 'agent-b0000000000000000000000000';
  const gcMismatchedRecordId = 'agent-b1111111111111111111111111';
  gcMetadata.agents[gcExpiredOrphanId] = {
    version: 2, agentId: gcExpiredOrphanId, harness: 'agy', cwd: root,
    nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'orphaned', updatedAt: gcOld,
  };
  gcMetadata.agents[gcExpiredQuarantineId] = {
    version: 2, agentId: gcExpiredQuarantineId, harness: 'codex', cwd: root,
    nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'quarantined', updatedAt: gcOld,
  };
  gcMetadata.agents[gcProtectedQuarantineId] = {
    version: 2, agentId: gcProtectedQuarantineId, harness: 'codex', cwd: root,
    nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
    runtimeAgentId: 'agent-11111111111111111111111111', runtimeWorkspaceId: 'gc-protected-workspace',
    lifecycle: 'quarantined', updatedAt: gcOld,
  };
  gcMetadata.agents[gcProtectedSuspendedId] = {
    version: 2, agentId: gcProtectedSuspendedId, harness: 'agy', cwd: root,
    nativeSessionId: 'gc-suspended-native', nativeSessionAttribution: 'verified', resumable: true,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'suspended', updatedAt: gcOld,
  };
  gcMetadata.agents[gcInvalidTimestampId] = {
    version: 2, agentId: gcInvalidTimestampId, harness: 'agy', cwd: root,
    nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'orphaned', updatedAt: 'not-a-date',
  };
  gcMetadata.agents[gcNumericTimestampId] = {
    version: 2, agentId: gcNumericTimestampId, harness: 'agy', cwd: root,
    nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'orphaned', updatedAt: 0,
  };
  gcMetadata.agents[gcFutureTimestampId] = {
    version: 2, agentId: gcFutureTimestampId, harness: 'agy', cwd: root,
    nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'orphaned',
    updatedAt: new Date(gcNow + 24 * 60 * 60 * 1_000).toISOString(),
  };
  gcMetadata.agents[gcMismatchedMapKey] = {
    version: 2, agentId: gcMismatchedRecordId, harness: 'agy', cwd: root,
    nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'orphaned', updatedAt: gcOld,
  };
  const gcRecentIds = [];
  for (let index = 0; index < 105; index += 1) {
    const agentId = `agent-${(index + 1_000).toString(16).padStart(26, '0')}`;
    gcRecentIds.push(agentId);
    gcMetadata.agents[agentId] = {
      version: 2, agentId, harness: 'agy', cwd: root,
      nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
      runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'orphaned',
      updatedAt: new Date(gcRecentBase + index).toISOString(),
    };
  }
  await fs.writeFile(metadataPath, `${JSON.stringify(gcMetadata, null, 2)}\n`, 'utf8');
  await metadataModuleA.__testCollectAgentMetadata();
  let collectedGcMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents;
  if (collectedGcMetadata[gcExpiredOrphanId] || collectedGcMetadata[gcExpiredQuarantineId]) {
    throw new Error('Expired detached terminal metadata was not garbage-collected');
  }
  if (
    !collectedGcMetadata[gcProtectedQuarantineId] ||
    !collectedGcMetadata[gcProtectedSuspendedId] ||
    !collectedGcMetadata[gcInvalidTimestampId] ||
    !collectedGcMetadata[gcNumericTimestampId] ||
    !collectedGcMetadata[gcFutureTimestampId] ||
    collectedGcMetadata[gcMismatchedMapKey]?.agentId !== gcMismatchedRecordId
  ) {
    throw new Error('Metadata GC removed a protected or timestamp-uncertain record');
  }
  const retainedRecentIds = gcRecentIds.filter((agentId) => collectedGcMetadata[agentId]);
  if (retainedRecentIds.length !== 100 || gcRecentIds.slice(0, 5).some((agentId) => collectedGcMetadata[agentId])) {
    throw new Error('Metadata GC did not retain exactly the 100 most recent detached terminal records');
  }
  const gcNewestWriteId = 'agent-afffffffffffffffffffffffff';
  await metadataModuleA.__testUpdateAgentMetadata(gcNewestWriteId, {
    version: 2, agentId: gcNewestWriteId, harness: 'agy', cwd: root,
    nativeSessionId: null, nativeSessionAttribution: 'unavailable', resumable: false,
    runtimeAgentId: null, runtimeWorkspaceId: null, lifecycle: 'orphaned', updatedAt: new Date().toISOString(),
  });
  collectedGcMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents;
  const detachedWithValidTimestamp = Object.entries(collectedGcMetadata).filter(([agentId, record]) => {
    const timestamp = record.terminalAt ?? record.updatedAt;
    const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    return (
      agentId === record.agentId &&
      ['orphaned', 'quarantined'].includes(record.lifecycle) &&
      !record.runtimeAgentId &&
      !record.runtimeWorkspaceId &&
      !record.quarantineRuntime &&
      Number.isFinite(parsed) &&
      new Date(parsed).toISOString() === timestamp &&
      parsed <= Date.now()
    );
  });
  if (detachedWithValidTimestamp.length !== 100 || !collectedGcMetadata[gcNewestWriteId]) {
    throw new Error('Metadata writes did not enforce the detached terminal history cap');
  }
  await fs.rm(metadataPath, { force: true });
  const ambiguousTransitionId = 'agent-f3333333333333333333333333';
  const ambiguousTransitionRuntimeId = 'agent-ffffffffffffffffffffffffff';
  const ambiguousTransitionWorkspaceId = 'ambiguous-transition-workspace';
  await metadataModuleA.__testUpdateAgentMetadata(ambiguousTransitionId, {
    version: 1, agentId: ambiguousTransitionId, harness: 'agy', cwd: root,
    nativeSessionId: 'transition-native', nativeSessionAttribution: 'verified', resumable: true,
    runtimeAgentId: ambiguousTransitionRuntimeId, runtimeWorkspaceId: ambiguousTransitionWorkspaceId,
    lifecycle: 'suspending', updatedAt: new Date().toISOString(),
  });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.workspaces[ambiguousTransitionWorkspaceId] = {
    workspace: { workspace_id: ambiguousTransitionWorkspaceId, label: 'not-the-recorded-runtime', number: 1 },
    paneId: `${ambiguousTransitionWorkspaceId}:p1`, tabId: `${ambiguousTransitionWorkspaceId}:t1`, cwd: root,
  };
  state.agents[ambiguousTransitionRuntimeId] = {
    agent: 'agy', agent_status: 'idle', cwd: root, foreground_cwd: root,
    interactive_ready: true, name: ambiguousTransitionRuntimeId,
    pane_id: `${ambiguousTransitionWorkspaceId}:p1`, tab_id: `${ambiguousTransitionWorkspaceId}:t1`,
    terminal_id: `term-${ambiguousTransitionRuntimeId}`, workspace_id: ambiguousTransitionWorkspaceId, transcript: 'AMBIGUOUS',
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await metadataModuleA.agentSuspend({ agentId: ambiguousTransitionId });
    throw new Error('Ambiguous transitional metadata was unexpectedly treated as active');
  } catch (error) {
    if (error?.code !== 'agent_invalid_transition') throw error;
  }
  try {
    await metadataModuleA.agentStop({ agentId: ambiguousTransitionId });
    throw new Error('agent_stop unexpectedly touched ambiguous transitional ownership');
  } catch (error) {
    if (error?.code !== 'agent_ambiguous_ownership') throw error;
  }
  const orphanStopId = 'agent-f5555555555555555555555555';
  const orphanStopRuntimeId = 'agent-88888888888888888888888888';
  const orphanStopWorkspaceId = 'orphan-stop-workspace';
  await metadataModuleB.__testUpdateAgentMetadata(orphanStopId, {
    version: 1, agentId: orphanStopId, harness: 'agy', cwd: root,
    nativeSessionId: 'orphan-stop-native', nativeSessionAttribution: 'verified', resumable: true,
    runtimeAgentId: orphanStopRuntimeId, runtimeWorkspaceId: orphanStopWorkspaceId,
    lifecycle: 'resuming', updatedAt: new Date().toISOString(),
  });
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.workspaces[orphanStopWorkspaceId] = {
    workspace: { workspace_id: orphanStopWorkspaceId, label: orphanStopRuntimeId, number: 1 },
    paneId: `${orphanStopWorkspaceId}:p1`, tabId: `${orphanStopWorkspaceId}:t1`, cwd: root,
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const orphanStopped = await metadataModuleA.agentStop({ agentId: orphanStopId });
  if (!orphanStopped.discarded || JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents[orphanStopId]) {
    throw new Error('agent_stop did not close and discard an exactly identified orphan transitional workspace');
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.workspaces[orphanStopWorkspaceId]) throw new Error('agent_stop left a transitional orphan workspace behind');
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.workspaces[ambiguousTransitionWorkspaceId];
  delete state.agents[ambiguousTransitionRuntimeId];
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rm(metadataPath, { force: true });

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const workspaceCountBeforeMissingWorkspaceId = Object.keys(state.workspaces).length;
  state.omitWorkspaceIdInCreate = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
    throw new Error('Missing workspace_id response unexpectedly started an agent');
  } catch (error) {
    if (!String(error.message).includes('valid workspace_id')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.omitWorkspaceIdInCreate;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (Object.keys(state.workspaces).length !== workspaceCountBeforeMissingWorkspaceId) {
    throw new Error('Malformed workspace create response leaked a workspace');
  }

  for (const malformedIdentityFlag of ['mismatchWorkspaceLabelInCreate', 'mismatchRootPaneWorkspaceIdInCreate']) {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const workspaceCountBeforeMalformedIdentity = Object.keys(state.workspaces).length;
    state[malformedIdentityFlag] = true;
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try {
      await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
      throw new Error(`${malformedIdentityFlag} unexpectedly started an agent`);
    } catch (error) {
      if (!String(error.message).includes('workspace identity validation')) throw error;
    }
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    delete state[malformedIdentityFlag];
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    if (Object.keys(state.workspaces).length !== workspaceCountBeforeMalformedIdentity) {
      throw new Error(`${malformedIdentityFlag} leaked a workspace`);
    }
  }

  const malformedOwnedAgentId = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.workspaces.malformed = {
    workspace: { label: malformedOwnedAgentId, workspace_id: null },
    paneId: 'malformed:p1',
    tabId: 'malformed:t1',
    cwd: root,
  };
  state.agents[malformedOwnedAgentId] = {
    agent: 'codex',
    agent_status: 'idle',
    cwd: root,
    foreground_cwd: root,
    interactive_ready: true,
    name: malformedOwnedAgentId,
    pane_id: 'malformed:p1',
    revision: 1,
    state_change_seq: 1,
    tab_id: 'malformed:t1',
    terminal_id: 'term-malformed',
    workspace_id: null,
    transcript: 'READY',
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await agentGet({ agentId: malformedOwnedAgentId });
    throw new Error('Null workspace IDs unexpectedly satisfied managed-agent ownership');
  } catch (error) {
    if (!String(error.message).includes('not an MCP-managed')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.workspaces.malformed;
  delete state.agents[malformedOwnedAgentId];
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const workspaceCountBeforeSyntheticAbort = Object.keys(state.workspaces).length;
  const metadataCountBeforeSyntheticAbort = Object.keys(JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents).length;
  let abortChecks = 0;
  const syntheticAbortSignal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {},
    throwIfAborted() {
      abortChecks += 1;
      if (abortChecks === 2) {
        const error = new Error('synthetic post-create abort');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        throw error;
      }
    },
  };
  try {
    await agentStart({ harness: 'agy', cwd: root, timeoutMs: 10_000 }, syntheticAbortSignal);
    throw new Error('Synthetic post-create abort unexpectedly succeeded');
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (Object.keys(state.workspaces).length !== workspaceCountBeforeSyntheticAbort) {
    throw new Error('Post-create exception leaked an agent workspace');
  }
  const metadataCountAfterSyntheticAbort = Object.keys(JSON.parse(await fs.readFile(metadataPath, 'utf8')).agents).length;
  if (metadataCountAfterSyntheticAbort !== metadataCountBeforeSyntheticAbort) {
    throw new Error('Post-create exception leaked durable logical-agent metadata');
  }

  const workspaceCountBeforeFailedCreate = Object.keys(state.workspaces).length;
  state.failCreateAfterMutation = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const failedCreateStartedAt = Date.now();
  try {
    await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
    throw new Error('Create-after-mutation failure unexpectedly succeeded');
  } catch (error) {
    if (!String(error.message).includes('create_failed_after_mutation')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.failCreateAfterMutation;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (Object.keys(state.workspaces).length !== workspaceCountBeforeFailedCreate) {
    throw new Error('Partial workspace creation was not compensated');
  }
  const failedCreateElapsedMs = Date.now() - failedCreateStartedAt;
  if (failedCreateElapsedMs > 4_000) {
    throw new Error(`Successful compensating cleanup was redundantly retried: ${failedCreateElapsedMs}ms`);
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const workspaceCountBeforeRecoveredCleanup = Object.keys(state.workspaces).length;
  state.failCreateAfterMutationAndFirstCleanupSnapshot = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  let recoveredCleanupError = null;
  try {
    await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
    throw new Error('Create failure with recovered cleanup unexpectedly succeeded');
  } catch (error) {
    recoveredCleanupError = error;
    if (!String(error.message).includes('create_failed_after_mutation')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (Object.keys(state.workspaces).length !== workspaceCountBeforeRecoveredCleanup) {
    throw new Error('Recovered second cleanup attempt leaked a workspace');
  }
  if (
    recoveredCleanupError?.cleanup !== undefined ||
    recoveredCleanupError?.herdr?.cleanup !== undefined ||
    String(recoveredCleanupError?.message).includes('cleanup also failed')
  ) {
    throw new Error('Recovered cleanup left stale failure metadata on the thrown create error');
  }

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const workspaceCountBeforeDelayedCreate = Object.keys(state.workspaces).length;
  state.delayCreateAfterFailure = true;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
    throw new Error('Delayed create failure unexpectedly succeeded');
  } catch (error) {
    if (!String(error.message).includes('create_failed_before_delayed_mutation')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.delayCreateAfterFailure;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (Object.keys(state.workspaces).length !== workspaceCountBeforeDelayedCreate) {
    throw new Error('Delayed workspace mutation escaped compensating cleanup polling');
  }

  const validHerdrPath = process.env.AGENT_HERDR_BIN;
  const relativeHerdrPath = path.relative(process.cwd(), validHerdrPath);
  process.env.AGENT_HERDR_BIN = relativeHerdrPath;
  const relativeCapabilities = await agentCapabilities();
  if (!relativeCapabilities.runtime.available) throw new Error('Relative AGENT_HERDR_BIN did not resolve consistently');

  process.env.AGENT_HERDR_BIN = bin;
  const directoryCapabilities = await agentCapabilities();
  if (directoryCapabilities.runtime.available !== false || directoryCapabilities.runtime.error?.code !== 'herdr_unavailable') {
    throw new Error('Directory AGENT_HERDR_BIN was not rejected as unavailable');
  }

  process.env.AGENT_HERDR_BIN = path.join(root, 'definitely-not-executable-herdr');
  const unavailableCapabilities = await agentCapabilities();
  if (unavailableCapabilities.runtime.available !== false || unavailableCapabilities.runtime.error?.code !== 'herdr_unavailable') {
    throw new Error('Invalid absolute AGENT_HERDR_BIN did not become structured unavailable capability');
  }
  process.env.AGENT_HERDR_BIN = validHerdrPath;

  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.running = false;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  process.env.AGENT_HERDR_BOOTSTRAP = 'external';
  try {
    await agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
    throw new Error('External bootstrap unexpectedly self-started Herdr');
  } catch (error) {
    if (!String(error.message).includes('external bootstrap mode')) throw error;
  }
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (state.running !== false) throw new Error('External bootstrap mutated fake Herdr state');

  process.env.AGENT_HERDR_BOOTSTRAP = 'auto';
  const firstController = new AbortController();
  const firstBootstrap = agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 }, firstController.signal);
  const secondBootstrap = agentStart({ harness: 'codex', cwd: root, timeoutMs: 10_000 });
  setTimeout(() => firstController.abort(), 5);
  let firstBootstrapCancelled = false;
  try {
    await firstBootstrap;
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.code !== 'ABORT_ERR' && !String(error.message).includes('aborted')) throw error;
    firstBootstrapCancelled = true;
  }
  if (!firstBootstrapCancelled) throw new Error('First shared-bootstrap caller was not actually canceled');
  const survivingBootstrap = await secondBootstrap;
  if (!survivingBootstrap.agent?.agentId) throw new Error('Second bootstrap waiter was canceled by first caller');
  await agentStop({ agentId: survivingBootstrap.agent.agentId });
  delete process.env.AGENT_HERDR_BOOTSTRAP;

  const finalCapabilities = await agentCapabilities();
  if (finalCapabilities.runtime.session.agents.length !== 0) throw new Error(`Fake agents leaked after stop: ${JSON.stringify(finalCapabilities.runtime.session.agents)}`);
  console.log('agent runtime smoke PASS');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
}
