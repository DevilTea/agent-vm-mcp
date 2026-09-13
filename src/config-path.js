import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_CONFIG_DIR = 'agent-vm-mcp';
const BUILTIN_CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url));

function xdgConfigHome(env = process.env) {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  const home = env.HOME || os.homedir();
  return path.join(home, '.config');
}

export function builtinConfigPath(filename) {
  return path.join(BUILTIN_CONFIG_DIR, filename);
}

export async function resolveConfigPath({ filename, envName, explicitPath, env = process.env }) {
  if (explicitPath) return explicitPath;
  if (envName && env[envName]) return env[envName];

  const xdgPath = path.join(xdgConfigHome(env), APP_CONFIG_DIR, filename);
  try {
    await access(xdgPath);
    return xdgPath;
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }

  return builtinConfigPath(filename);
}
