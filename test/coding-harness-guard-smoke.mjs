import { assertNoRawCodingHarnessArgv, assertNoRawCodingHarnessLaunch } from '../src/coding-harness-guard.js';

function expectAllowed(command) {
  assertNoRawCodingHarnessLaunch(command, 'test');
}

function expectBlocked(command, harness, options = {}) {
  try {
    assertNoRawCodingHarnessLaunch(command, 'test', options);
  } catch (error) {
    if (error?.code !== 'raw_coding_harness_launch_forbidden') {
      throw new Error(`Unexpected guard error for ${JSON.stringify(command)}: ${error?.stack ?? error}`);
    }
    if (!error.message.includes(harness) || !error.message.includes('agent_start')) {
      throw new Error(`Guard error did not identify ${harness} and agent_start: ${error.message}`);
    }
    return;
  }
  throw new Error(`Expected raw coding harness launch to be blocked: ${command}`);
}

for (const [command, harness] of [
  ['codex exec --ephemeral -', 'codex'],
  ['agy --print="review this"', 'agy'],
  ['claude -p "review this"', 'claude'],
  ['env FOO=1 codex exec --ephemeral -', 'codex'],
  ['/usr/bin/env FOO=1 codex exec --ephemeral -', 'codex'],
  ['/usr/bin/env -C /tmp codex exec --ephemeral -', 'codex'],
  ['sudo -n -u agent codex exec --ephemeral -', 'codex'],
  ['/usr/bin/sudo --user=agent agy --print hello', 'agy'],
  ['nohup /home/agent/.local/bin/agy --print hello &', 'agy'],
  ['( cd /tmp && codex exec --ephemeral - ) &', 'codex'],
  ['ROOT=/tmp; cd "$ROOT"; agy --mode plan --print hello &', 'agy'],
  ["bash -lc 'codex exec --ephemeral -'", 'codex'],
  ["sh -c 'agy --print hello'", 'agy'],
  ["fish --command='codex exec --ephemeral do-work'", 'codex'],
  ['command -- codex exec --ephemeral -', 'codex'],
  ['command -p codex exec --ephemeral -', 'codex'],
  ['command -p -- codex exec --ephemeral -', 'codex'],
  ['exec -a fake codex exec --ephemeral -', 'codex'],
  ["bash -lc 'exec -a fake codex exec --ephemeral -'", 'codex'],
  ['sudo -r role codex exec --ephemeral -', 'codex'],
  ['sudo -t type agy --print review', 'agy'],
]) {
  expectBlocked(command, harness);
}

for (const [argv, harness] of [
  [['codex', 'exec', '--ephemeral', '-'], 'codex'],
  [['/usr/bin/env', 'FOO=1', '/usr/local/bin/agy', '--print', 'hello'], 'agy'],
  [['/usr/bin/env', '-C', '/tmp', 'codex', 'exec', '--ephemeral', '-'], 'codex'],
  [['sudo', '-n', '-u', 'agent', 'claude', '-p', 'review'], 'claude'],
  [['/bin/bash', '-lc', 'codex exec --ephemeral -'], 'codex'],
  [['/bin/bash', '-lc', 'exec -a fake codex exec --ephemeral -'], 'codex'],
  [['/usr/bin/fish', '--command=codex exec --ephemeral do-work'], 'codex'],
  [['/usr/bin/env', 'FOO=1', '/usr/bin/fish', '--command=agy --print review'], 'agy'],
  [['sudo', '-r', 'role', 'codex', 'exec', '--ephemeral', '-'], 'codex'],
]) {
  try {
    assertNoRawCodingHarnessArgv(argv, 'test');
  } catch (error) {
    if (error?.code !== 'raw_coding_harness_launch_forbidden') {
      throw new Error(`Unexpected argv guard error for ${JSON.stringify(argv)}: ${error?.stack ?? error}`);
    }
    if (!error.message.includes(harness) || !error.message.includes('agent_start')) {
      throw new Error(`Argv guard error did not identify ${harness} and agent_start: ${error.message}`);
    }
    continue;
  }
  throw new Error(`Expected raw coding harness argv launch to be blocked: ${JSON.stringify(argv)}`);
}

for (const argv of [
  ['/usr/bin/env', '-S', 'codex exec --ephemeral do-work'],
  ['/usr/bin/env', '--split-string=agy --print review'],
]) {
  try {
    assertNoRawCodingHarnessArgv(argv, 'test');
  } catch (error) {
    if (error?.code !== 'unsafe_command_wrapper') {
      throw new Error(`Unexpected env split-string guard error for ${JSON.stringify(argv)}: ${error?.stack ?? error}`);
    }
    continue;
  }
  throw new Error(`Expected env split-string wrapper to be rejected: ${JSON.stringify(argv)}`);
}

for (const command of [
  'sudo --future-option value codex exec --ephemeral -',
  'exec --future-option codex exec --ephemeral -',
]) {
  try {
    assertNoRawCodingHarnessLaunch(command, 'test');
  } catch (error) {
    if (error?.code !== 'unsafe_command_wrapper') {
      throw new Error(`Unexpected fail-closed wrapper error for ${JSON.stringify(command)}: ${error?.stack ?? error}`);
    }
    continue;
  }
  throw new Error(`Expected unknown wrapper option to fail closed: ${command}`);
}

for (const command of [
  "tmux new-session -d -s reviewer 'codex'",
  'screen -dmS reviewer codex',
  "script -q -c 'codex' /dev/null",
  "bash -lc 'tmux new-session -d -s reviewer'",
  'command -- tmux new-session -d -s reviewer',
  'command -p -- tmux new-session -d -s reviewer',
]) {
  try {
    assertNoRawCodingHarnessLaunch(command, 'test', { forbidInteractiveTerminalCommands: true });
  } catch (error) {
    if (error?.code !== 'interactive_terminal_launch_forbidden') {
      throw new Error(`Unexpected interactive-terminal guard error for ${JSON.stringify(command)}: ${error?.stack ?? error}`);
    }
    continue;
  }
  throw new Error(`Expected interactive terminal launch to be blocked: ${command}`);
}

for (const command of [
  ['codex --version'],
  ['agy --help'],
  ['claude -h'],
  ['command -v codex'],
  ['command -V codex'],
  ['command -pv codex'],
  ['which agy'],
  ["printf '%s\\n' 'codex exec --ephemeral'"],
  ["grep -Rni 'agy --print' src"],
].flat()) {
  expectAllowed(command);
}

for (const argv of [
  ['codex', '--version'],
  ['/usr/bin/env', 'FOO=1', 'agy', '--help'],
  ['sudo', '-n', 'claude', '-h'],
  ['/usr/bin/printf', '%s', 'codex exec --ephemeral'],
]) {
  assertNoRawCodingHarnessArgv(argv, 'test');
}

console.log('PASS coding harness raw-launch guard');
