import { assertNoRawCodingHarnessLaunch } from '../src/coding-harness-guard.js';

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
  ['nohup /home/agent/.local/bin/agy --print hello &', 'agy'],
  ['( cd /tmp && codex exec --ephemeral - ) &', 'codex'],
  ['ROOT=/tmp; cd "$ROOT"; agy --mode plan --print hello &', 'agy'],
  ["bash -lc 'codex exec --ephemeral -'", 'codex'],
  ["sh -c 'agy --print hello'", 'agy'],
  ['command -- codex exec --ephemeral -', 'codex'],
  ['command -p codex exec --ephemeral -', 'codex'],
  ['command -p -- codex exec --ephemeral -', 'codex'],
]) {
  expectBlocked(command, harness);
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

console.log('PASS coding harness raw-launch guard');
