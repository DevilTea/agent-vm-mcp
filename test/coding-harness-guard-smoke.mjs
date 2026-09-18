import { assertNoRawCodingHarnessLaunch } from '../src/coding-harness-guard.js';

function expectAllowed(command) {
  assertNoRawCodingHarnessLaunch(command, 'test');
}

function expectBlocked(command, harness) {
  try {
    assertNoRawCodingHarnessLaunch(command, 'test');
  } catch (error) {
    if (error?.code !== 'raw_coding_harness_launch_forbidden') {
      throw new Error(`Unexpected guard error for ${JSON.stringify(command)}: ${error?.stack ?? error}`);
    }
    if (!error.message.includes(harness) || !error.message.includes('agent_run')) {
      throw new Error(`Guard error did not identify ${harness} and agent_run: ${error.message}`);
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
]) {
  expectBlocked(command, harness);
}

for (const command of [
  ['codex --version'],
  ['agy --help'],
  ['claude -h'],
  ['command -v codex'],
  ['which agy'],
  ["printf '%s\\n' 'codex exec --ephemeral'"],
  ["grep -Rni 'agy --print' src"],
].flat()) {
  expectAllowed(command);
}

console.log('PASS coding harness raw-launch guard');
