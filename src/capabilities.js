import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_CONFIG_PATH = '/opt/agent-mcp/config/capabilities.json';
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const VERSION_TIMEOUT_MS = 2_000;

function configPath() {
  return process.env.AGENT_MCP_CAPABILITIES_CONFIG ?? DEFAULT_CONFIG_PATH;
}

async function loadConfig() {
  const parsed = JSON.parse(await readFile(configPath(), 'utf8'));
  if (parsed?.version !== 1 || !Array.isArray(parsed.commands)) {
    throw new Error(`Invalid capability config: ${configPath()}`);
  }

  const names = new Set();
  for (const command of parsed.commands) {
    if (!command || typeof command.name !== 'string' || command.name.length === 0) {
      throw new Error(`Capability config contains an invalid command entry: ${configPath()}`);
    }
    if (names.has(command.name)) {
      throw new Error(`Capability config contains duplicate command ${command.name}`);
    }
    names.add(command.name);
  }

  return parsed;
}

async function findExecutable(name) {
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function captureVersion(executable, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = Buffer.alloc(0);
    let settled = false;

    const append = (chunk) => {
      if (output.length >= MAX_VERSION_OUTPUT_BYTES) return;
      output = Buffer.concat([
        output,
        chunk.subarray(0, MAX_VERSION_OUTPUT_BYTES - output.length),
      ]);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const firstLine = output
        .toString('utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      resolve(firstLine ?? null);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, VERSION_TIMEOUT_MS);

    child.once('error', finish);
    child.once('close', finish);
  });
}

export async function inspectCommands(names) {
  const config = await loadConfig();
  const definitions = new Map(config.commands.map((command) => [command.name, command]));

  return await Promise.all(
    names.map(async (name) => {
      const definition = definitions.get(name) ?? null;
      const executable = await findExecutable(name);
      const version =
        executable && Array.isArray(definition?.versionArgs)
          ? await captureVersion(executable, definition.versionArgs)
          : null;

      return {
        name,
        curated: definition !== null,
        available: executable !== null,
        path: executable,
        version,
        category: definition?.category ?? null,
        summary: definition?.summary ?? null,
      };
    }),
  );
}

export async function collectCapabilities({ nativeTools, bridgeStatus }) {
  const config = await loadConfig();
  const commands = await inspectCommands(config.commands.map((command) => command.name));
  const runtimes = commands.filter((command) => command.category === 'runtime');
  const categories = {};

  for (const command of commands) {
    const category = command.category ?? 'other';
    (categories[category] ??= []).push(command);
  }

  return {
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      home: process.env.HOME ?? null,
    },
    execution: {
      shell: '/bin/bash',
      persistentProcesses: true,
    },
    runtimes,
    cli: {
      configPath: configPath(),
      curatedCount: commands.length,
      availableCount: commands.filter((command) => command.available).length,
      categories,
    },
    mcp: {
      nativeTools: [...nativeTools],
      bridges: bridgeStatus.bridges,
    },
  };
}
