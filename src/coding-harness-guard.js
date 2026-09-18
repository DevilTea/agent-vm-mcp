const CODING_HARNESS_COMMANDS = new Set(['codex', 'agy', 'claude']);
const SAFE_HARNESS_PROBES = new Set(['--help', '-h', '--version', '-V', 'help', 'version']);
const SHELL_COMMANDS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh']);
const INTERACTIVE_TERMINAL_COMMANDS = new Set(['tmux', 'screen', 'script']);

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

function unwrapHarnessCommand(words) {
  let index = 0;
  while (index < words.length && (words[index] === '!' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1;

  while (index < words.length) {
    const wrapper = words[index];
    if (wrapper === 'command') {
      const nextIndex = advancePastCommandWrapper(words, index);
      if (nextIndex === null) return null;
      index = nextIndex;
      continue;
    }
    if (wrapper === 'exec' || wrapper === 'nohup' || wrapper === 'setsid') {
      index += 1;
      while (words[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (wrapper === 'env') {
      index += 1;
      while (words[index]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
      continue;
    }
    break;
  }

  const executable = words[index];
  if (!executable) return null;
  const name = executable.split('/').at(-1);
  if (!CODING_HARNESS_COMMANDS.has(name)) return null;
  return { name, args: words.slice(index + 1) };
}

function executableName(words) {
  let index = 0;
  while (index < words.length && (words[index] === '!' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1;

  while (index < words.length) {
    const wrapper = words[index];
    if (wrapper === 'command') {
      const nextIndex = advancePastCommandWrapper(words, index);
      if (nextIndex === null) return { name: null, args: [] };
      index = nextIndex;
      continue;
    }
    if (wrapper === 'exec' || wrapper === 'nohup' || wrapper === 'setsid') {
      index += 1;
      while (words[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (wrapper === 'env') {
      index += 1;
      while (words[index]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
      continue;
    }
    break;
  }

  const executable = words[index];
  if (!executable) return { name: null, args: [] };
  return { name: executable.split('/').at(-1), args: words.slice(index + 1) };
}

function shellCommandArgument(name, args) {
  if (!SHELL_COMMANDS.has(name)) return null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--command') return args[index + 1] ?? null;
    if (/^-[^-]*c/.test(arg)) return args[index + 1] ?? null;
  }
  return null;
}

export function assertNoRawCodingHarnessLaunch(
  command,
  surface,
  { forbidInteractiveTerminalCommands = false } = {},
) {
  for (const segment of splitShellCommandSegments(command)) {
    const words = shellWords(segment);
    const executable = executableName(words);
    if (forbidInteractiveTerminalCommands && INTERACTIVE_TERMINAL_COMMANDS.has(executable.name)) {
      const error = new Error(
        `${surface} must not launch interactive terminal sessions through ${executable.name} on this host. ` +
          'Use process_start for generic long-running processes and agent_start/agent_poll for coding-agent work.',
      );
      error.code = 'interactive_terminal_launch_forbidden';
      throw error;
    }

    const nestedShellCommand = shellCommandArgument(executable.name, executable.args);
    if (nestedShellCommand !== null) {
      assertNoRawCodingHarnessLaunch(nestedShellCommand, surface, { forbidInteractiveTerminalCommands });
    }

    const harness = unwrapHarnessCommand(words);
    if (!harness) continue;
    if (harness.args.length > 0 && SAFE_HARNESS_PROBES.has(harness.args[0])) continue;
    const error = new Error(
      `${surface} must not launch the ${harness.name} coding harness for agent work. ` +
        'Use agent_start for normal bounded coding-agent work and agent_run only for short blocking tasks. Raw harness TUI execution is not a supported fallback.',
    );
    error.code = 'raw_coding_harness_launch_forbidden';
    throw error;
  }
}

