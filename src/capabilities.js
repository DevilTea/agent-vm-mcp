import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { resolveConfigPath } from './config-path.js';
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const VERSION_TIMEOUT_MS = 2_000;

async function loadConfig() {
  const configPath = await resolveConfigPath({
    filename: 'capabilities.json',
    envName: 'AGENT_MCP_CAPABILITIES_CONFIG',
  });
  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  if (parsed?.version !== 1 || !Array.isArray(parsed.commands)) {
    throw new Error(`Invalid capability config: ${configPath}`);
  }
  if (parsed.probes !== undefined && !Array.isArray(parsed.probes)) {
    throw new Error(`Invalid capability probes: ${configPath}`);
  }

  const names = new Set();
  for (const command of parsed.commands) {
    if (!command || typeof command.name !== 'string' || command.name.length === 0) {
      throw new Error(`Capability config contains an invalid command entry: ${configPath}`);
    }
    if (names.has(command.name)) {
      throw new Error(`Capability config contains duplicate command ${command.name}`);
    }
    names.add(command.name);
  }

  const probeNames = new Set();
  for (const probe of parsed.probes ?? []) {
    if (
      !probe ||
      typeof probe.name !== 'string' ||
      probe.name.length === 0 ||
      typeof probe.command !== 'string' ||
      probe.command.length === 0 ||
      !Array.isArray(probe.args) ||
      probe.args.some((arg) => typeof arg !== 'string')
    ) {
      throw new Error(`Capability config contains an invalid probe entry: ${configPath}`);
    }
    if (probeNames.has(probe.name)) {
      throw new Error(`Capability config contains duplicate probe ${probe.name}`);
    }
    probeNames.add(probe.name);
  }

  return { config: parsed, configPath };
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

function captureInvocation(executable, args) {
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

    const finish = ({ code = null, timedOut = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const firstLine = output
        .toString('utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      resolve({
        succeeded: !timedOut && code === 0,
        firstLine: firstLine ?? null,
      });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true });
    }, VERSION_TIMEOUT_MS);

    child.once('error', () => finish());
    child.once('close', (code) => finish({ code }));
  });
}

async function captureVersion(executable, args) {
  return (await captureInvocation(executable, args)).firstLine;
}

export async function inspectCommands(names, { config: providedConfig } = {}) {
  const config = providedConfig ?? (await loadConfig()).config;
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

async function inspectProbes(probes) {
  return await Promise.all(
    probes.map(async (definition) => {
      const executable = await findExecutable(definition.command);
      const result = executable
        ? await captureInvocation(executable, definition.args)
        : { succeeded: false, firstLine: null };

      return {
        name: definition.name,
        command: definition.command,
        args: definition.args,
        available: result.succeeded,
        path: executable,
        version: result.succeeded ? result.firstLine : null,
        category: definition.category ?? null,
        summary: definition.summary ?? null,
      };
    }),
  );
}

export async function collectCapabilities({ nativeTools, bridgeStatus, executionShell }) {
  const { config, configPath } = await loadConfig();
  const commands = await inspectCommands(config.commands.map((command) => command.name), { config });
  const probes = await inspectProbes(config.probes ?? []);
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
      shell: executionShell,
      persistentProcesses: true,
    },
    runtimes,
    cli: {
      configPath,
      curatedCount: commands.length,
      availableCount: commands.filter((command) => command.available).length,
      categories,
      probes,
      availableProbeCount: probes.filter((probe) => probe.available).length,
    },
    mcp: {
      nativeTools: [...nativeTools],
      bridges: bridgeStatus.bridges,
    },
  };
}
