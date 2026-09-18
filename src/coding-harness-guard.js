const CODING_HARNESS_COMMANDS = new Set(['codex', 'agy', 'claude']);
const SAFE_HARNESS_PROBES = new Set(['--help', '-h', '--version', '-V', 'help', 'version']);

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

function unwrapHarnessCommand(words) {
  let index = 0;
  while (index < words.length && (words[index] === '!' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1;

  while (index < words.length) {
    const wrapper = words[index];
    if (wrapper === 'command') {
      if (words[index + 1]?.startsWith('-')) return null;
      index += 1;
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

export function assertNoRawCodingHarnessLaunch(command, surface) {
  for (const segment of splitShellCommandSegments(command)) {
    const harness = unwrapHarnessCommand(shellWords(segment));
    if (!harness) continue;
    if (harness.args.length > 0 && SAFE_HARNESS_PROBES.has(harness.args[0])) continue;
    const error = new Error(
      `${surface} must not launch the ${harness.name} coding harness for agent work. ` +
        'Use agent_run for bounded coding-agent work. For exceptional interactive work, launch the harness behind an explicit tmux session and inspect raw TUI output instead of inferring semantic state.',
    );
    error.code = 'raw_coding_harness_launch_forbidden';
    throw error;
  }
}

