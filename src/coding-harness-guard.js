const CODING_HARNESS_COMMANDS = new Set(['codex', 'agy', 'claude']);
const SAFE_HARNESS_PROBES = new Set(['--help', '-h', '--version', '-V', 'help', 'version']);
const SHELL_COMMANDS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh']);
const INTERACTIVE_TERMINAL_COMMANDS = new Set(['tmux', 'screen', 'script']);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '-C', '-D', '-g', '-h', '-p', '-R', '-T', '-U', '-u', '-a', '-c', '-r', '-t',
  '--auth-type', '--chdir', '--chroot', '--close-from', '--command-timeout', '--group', '--host',
  '--login-class', '--other-user', '--prompt', '--role', '--type', '--user',
]);
const SUDO_OPTIONS_WITHOUT_VALUE = new Set([
  '-A', '-b', '-B', '-e', '-E', '-H', '-i', '-K', '-k', '-l', '-n', '-S', '-s', '-V', '-v',
  '--askpass', '--background', '--bell', '--edit', '--help', '--login', '--non-interactive',
  '--preserve-env', '--remove-timestamp', '--reset-timestamp', '--shell', '--stdin', '--validate', '--version',
]);
const ENV_OPTIONS_WITH_VALUE = new Set(['-C', '-u', '--chdir', '--unset', '--argv0']);
const ENV_OPTIONS_WITHOUT_VALUE = new Set([
  '-i', '-0', '-v', '--ignore-environment', '--null', '--debug', '--list-signal-handling',
  '--help', '--version',
]);

function commandBasename(value) {
  return typeof value === 'string' ? value.split('/').at(-1) : null;
}

function splitShellCommandSegments(command) {
  const segments = [];
  let start = 0;
  let quote = null;
  let escaped = false;

  const push = (end) => {
    const segment = command.slice(start, end).trim();
    if (segment) segments.push(segment);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\n' || char === ';' || char === '&' || char === '|' || char === '(' || char === ')' || char === '{' || char === '}') {
      push(index);
      if ((char === '&' || char === '|') && command[index + 1] === char) index += 1;
      start = index + 1;
    }
  }
  push(command.length);
  return segments;
}

function shellWords(segment) {
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  let active = false;
  const push = () => {
    if (!active) return;
    words.push(word);
    word = '';
    active = false;
  };

  for (const char of segment) {
    if (quote === "'") {
      active = true;
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      active = true;
      if (escaped) {
        word += char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (escaped) {
      active = true;
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      active = true;
      escaped = true;
    } else if (char === "'" || char === '"') {
      active = true;
      quote = char;
    } else if (/\s/.test(char)) {
      push();
    } else {
      active = true;
      word += char;
    }
  }
  push();
  return words;
}

function advancePastCommandWrapper(words, index) {
  index += 1;

  while (index < words.length) {
    const option = words[index];
    if (option === '--') return index + 1;
    if (!option.startsWith('-') || option === '-') return index;

    const flags = option.slice(1);
    if (flags.includes('v') || flags.includes('V')) return null;
    if (/^p+$/.test(flags)) {
      index += 1;
      continue;
    }

    return null;
  }

  return index;
}

function unsafeCommandWrapper(message) {
  const error = new Error(message);
  error.code = 'unsafe_command_wrapper';
  throw error;
}

function advancePastExecWrapper(words, index) {
  index += 1;
  while (index < words.length) {
    const value = words[index];
    if (value === '--') return index + 1;
    if (!value?.startsWith('-') || value === '-') return index;
    if (value === '-a') {
      if (index + 1 >= words.length) unsafeCommandWrapper('exec -a requires an argv[0] value.');
      index += 2;
      continue;
    }
    if (/^-[cl]+$/.test(value)) {
      index += 1;
      continue;
    }
    unsafeCommandWrapper(`Unsupported exec wrapper option on guarded execution surface: ${value}`);
  }
  return index;
}

function advancePastSudoWrapper(words, index) {
  index += 1;
  while (index < words.length) {
    const value = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value ?? '')) {
      index += 1;
      continue;
    }
    if (value === '--') return index + 1;
    if (!value?.startsWith('-') || value === '-') return index;

    const optionName = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
    if (SUDO_OPTIONS_WITH_VALUE.has(optionName)) {
      if (value.includes('=')) {
        index += 1;
        continue;
      }
      if (index + 1 >= words.length) unsafeCommandWrapper(`sudo option ${value} requires a value.`);
      index += 2;
      continue;
    }
    if (
      SUDO_OPTIONS_WITHOUT_VALUE.has(value) ||
      value.startsWith('--preserve-env=') ||
      /^-[ABbeEHikKlnSsVv]+$/.test(value)
    ) {
      index += 1;
      continue;
    }
    unsafeCommandWrapper(`Unsupported sudo wrapper option on guarded execution surface: ${value}`);
  }
  return index;
}

function unsafeEnvWrapper(message) {
  unsafeCommandWrapper(message);
}

function advancePastEnvWrapper(words, index) {
  index += 1;
  while (index < words.length) {
    const value = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value ?? '')) {
      index += 1;
      continue;
    }
    if (value === '--') return index + 1;
    if (!value?.startsWith('-') || value === '-') return index;

    const optionName = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
    if (optionName === '-S' || optionName === '--split-string') {
      unsafeEnvWrapper('env -S/--split-string is not allowed on guarded execution surfaces because it reparses a command string.');
    }
    if (ENV_OPTIONS_WITH_VALUE.has(optionName)) {
      if (value.includes('=')) {
        index += 1;
        continue;
      }
      if (index + 1 >= words.length) unsafeEnvWrapper(`env option ${value} requires a value.`);
      index += 2;
      continue;
    }
    if (ENV_OPTIONS_WITHOUT_VALUE.has(value)) {
      index += 1;
      continue;
    }
    if (
      value.startsWith('--block-signal') ||
      value.startsWith('--default-signal') ||
      value.startsWith('--ignore-signal')
    ) {
      index += 1;
      continue;
    }
    unsafeEnvWrapper(`Unsupported env wrapper option on guarded execution surface: ${value}`);
  }
  return index;
}

function unwrapHarnessCommand(words) {
  let index = 0;
  while (index < words.length && (words[index] === '!' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1;

  while (index < words.length) {
    const wrapper = commandBasename(words[index]);
    if (wrapper === 'command') {
      const nextIndex = advancePastCommandWrapper(words, index);
      if (nextIndex === null) return null;
      index = nextIndex;
      continue;
    }
    if (wrapper === 'exec') {
      index = advancePastExecWrapper(words, index);
      continue;
    }
    if (wrapper === 'nohup' || wrapper === 'setsid') {
      index += 1;
      while (words[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (wrapper === 'env') {
      index = advancePastEnvWrapper(words, index);
      continue;
    }
    if (wrapper === 'sudo') {
      index = advancePastSudoWrapper(words, index);
      continue;
    }
    break;
  }

  const executable = words[index];
  if (!executable) return null;
  const name = commandBasename(executable);
  if (!CODING_HARNESS_COMMANDS.has(name)) return null;
  return { name, args: words.slice(index + 1) };
}

function executableName(words) {
  let index = 0;
  while (index < words.length && (words[index] === '!' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1;

  while (index < words.length) {
    const wrapper = commandBasename(words[index]);
    if (wrapper === 'command') {
      const nextIndex = advancePastCommandWrapper(words, index);
      if (nextIndex === null) return { name: null, args: [] };
      index = nextIndex;
      continue;
    }
    if (wrapper === 'exec') {
      index = advancePastExecWrapper(words, index);
      continue;
    }
    if (wrapper === 'nohup' || wrapper === 'setsid') {
      index += 1;
      while (words[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (wrapper === 'env') {
      index = advancePastEnvWrapper(words, index);
      continue;
    }
    if (wrapper === 'sudo') {
      index = advancePastSudoWrapper(words, index);
      continue;
    }
    break;
  }

  const executable = words[index];
  if (!executable) return { name: null, args: [] };
  return { name: commandBasename(executable), args: words.slice(index + 1) };
}

function shellCommandArguments(name, args) {
  if (!SHELL_COMMANDS.has(name)) return [];
  const commands = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--command') {
      if (args[index + 1] !== undefined) commands.push(args[index + 1]);
      continue;
    }
    if (arg.startsWith('--command=')) {
      commands.push(arg.slice('--command='.length));
      continue;
    }
    if (/^-[^-]*c/.test(arg)) {
      if (args[index + 1] !== undefined) commands.push(args[index + 1]);
      if (arg.startsWith('-c') && arg.length > 2) commands.push(arg.slice(2));
    }
  }
  return [...new Set(commands)];
}

function assertCommandWords(words, surface, { forbidInteractiveTerminalCommands = false } = {}) {
  const executable = executableName(words);
  if (forbidInteractiveTerminalCommands && INTERACTIVE_TERMINAL_COMMANDS.has(executable.name)) {
    const error = new Error(
      `${surface} must not launch interactive terminal sessions through ${executable.name} on this host. ` +
        'Use process_start for generic long-running processes and agent_start/agent_poll for coding-agent work.',
    );
    error.code = 'interactive_terminal_launch_forbidden';
    throw error;
  }

  for (const nestedShellCommand of shellCommandArguments(executable.name, executable.args)) {
    assertNoRawCodingHarnessLaunch(nestedShellCommand, surface, { forbidInteractiveTerminalCommands });
  }

  const harness = unwrapHarnessCommand(words);
  if (!harness) return;
  if (harness.args.length > 0 && SAFE_HARNESS_PROBES.has(harness.args[0])) return;
  const error = new Error(
    `${surface} must not launch the ${harness.name} coding harness for agent work. ` +
      'Use agent_start for normal bounded coding-agent work and agent_run only for short blocking tasks. Raw harness TUI execution is not a supported fallback.',
  );
  error.code = 'raw_coding_harness_launch_forbidden';
  throw error;
}

export function assertNoRawCodingHarnessArgv(argv, surface, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || argv[0].length === 0) {
    const error = new Error(`${surface} argv must contain a non-empty executable.`);
    error.code = 'invalid_argv';
    throw error;
  }
  assertCommandWords(argv, surface, options);
}

export function assertNoRawCodingHarnessLaunch(command, surface, options = {}) {
  for (const segment of splitShellCommandSegments(command)) {
    assertCommandWords(shellWords(segment), surface, options);
  }
}

