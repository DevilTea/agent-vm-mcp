import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentCapabilities,
  agentGet,
  agentPrompt,
  agentRead,
  agentSendKeys,
  agentStart,
  agentStop,
} from '../src/agents.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-agents-smoke-'));
const home = path.join(root, 'home');
const bin = path.join(root, 'bin');
const statePath = path.join(root, 'herdr-state.json');
const herdrPath = path.join(bin, 'herdr');

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
  `${JSON.stringify({ running: true, nextWorkspace: 1, workspaces: {}, agents: {} }, null, 2)}\n`,
  'utf8',
);

const fakeHerdr = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const statePath = process.env.AGENT_HERDR_FAKE_STATE;
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
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
  const n = state.nextWorkspace++;
  const workspaceId = 'w' + n;
  const paneId = workspaceId + ':p1';
  const tabId = workspaceId + ':t1';
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
  const workspaceRecord = { workspace, paneId, tabId, cwd };
  if (state.delayCreateAfterFailure) {
    writeState(state);
    const delayedCode = "const fs=require('fs');const statePath=process.env.AGENT_DELAY_STATE;const record=JSON.parse(process.env.AGENT_DELAY_RECORD);setTimeout(()=>{const delayedState=JSON.parse(fs.readFileSync(statePath,'utf8'));delayedState.workspaces[record.workspace.workspace_id]=record;fs.writeFileSync(statePath,JSON.stringify(delayedState,null,2)+'\\n');},1250);";
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
  for (const [name, agent] of Object.entries(state.agents)) {
    if (agent.workspace_id === workspaceId) delete state.agents[name];
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
    transcript: 'READY',
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
  const prompt = args[3];
  agent.transcript += '\n> ' + prompt + '\nFAKE_RESPONSE';
  agent.state_change_seq += 2;
  writeState(state);
  if (state.promptFailure === 'after_mutation') fail('agent_prompt_stalled', 'prompt submitted but wait stalled');
  if (state.promptFailure === 'hang_after_mutation') setInterval(() => {}, 60_000);
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
};
process.env.HOME = home;
process.env.PATH = `${bin}:${previous.PATH}`;
process.env.AGENT_HERDR_BIN = herdrPath;
process.env.AGENT_HERDR_SESSION = 'fake-session';
process.env.AGENT_HERDR_FAKE_STATE = statePath;

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

  const codex = await agentStart({
    harness: 'codex',
    cwd: root,
    model: 'gpt-5.6-luna',
    effort: 'max',
    timeoutMs: 10_000,
  });
  if (!codex.startup.ready || codex.agent.harness !== 'codex') throw new Error('Codex fake agent did not start');
  let state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const codexLaunch = state.agents[codex.agent.agentId].launch_args;
  if (
    JSON.stringify(codexLaunch) !==
    JSON.stringify(['--model', 'gpt-5.6-luna', '--config', 'model_reasoning_effort="max"'])
  ) {
    throw new Error(`Unexpected Codex launch args: ${JSON.stringify(codexLaunch)}`);
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
  if (notReady.accepted !== false || notReady.submission?.state !== 'not_submitted' || notReady.error?.code !== 'agent_not_ready') {
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
  if (ambiguous.accepted !== null || ambiguous.submission?.state !== 'possibly_submitted' || ambiguous.submission?.retrySafe !== false) {
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
    timeoutMs: 250,
  });
  let firstPromptObserved = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
    serializedSecond.accepted !== false ||
    serializedSecond.submission?.state !== 'not_submitted' ||
    serializedSecond.error?.cause?.code !== 'agent_prompt_in_flight'
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

  try {
    await agentPrompt({
      agentId: codex.agent.agentId,
      task: 'Should fail.',
      skills: ['missing-skill'],
      wait: true,
      timeoutMs: 10_000,
    });
    throw new Error('Missing skill unexpectedly succeeded');
  } catch (error) {
    if (!String(error.message).includes('not installed')) throw error;
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
  if (blocked.accepted || blocked.error?.code !== 'interaction_required') {
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
  if (finalCapabilities.runtime.session.agents.length !== 0) throw new Error('Fake agents leaked after stop');
  console.log('agent runtime smoke PASS');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
}
