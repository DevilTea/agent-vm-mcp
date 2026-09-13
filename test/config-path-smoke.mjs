import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { builtinConfigPath, resolveConfigPath } from '../src/config-path.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-config-path-'));
try {
  const env = { HOME: path.join(root, 'home') };
  assert.equal(
    await resolveConfigPath({ filename: 'bridges.json', envName: 'MCP_BRIDGES_CONFIG', env }),
    builtinConfigPath('bridges.json'),
  );

  const xdgRoot = path.join(root, 'xdg');
  const xdgConfig = path.join(xdgRoot, 'agent-vm-mcp', 'bridges.json');
  await fs.mkdir(path.dirname(xdgConfig), { recursive: true });
  await fs.writeFile(xdgConfig, '{"version":1,"bridges":[]}\n');
  assert.equal(
    await resolveConfigPath({
      filename: 'bridges.json',
      envName: 'MCP_BRIDGES_CONFIG',
      env: { ...env, XDG_CONFIG_HOME: xdgRoot },
    }),
    xdgConfig,
  );

  const explicitEnvPath = path.join(root, 'does-not-need-to-exist.json');
  assert.equal(
    await resolveConfigPath({
      filename: 'bridges.json',
      envName: 'MCP_BRIDGES_CONFIG',
      env: { ...env, XDG_CONFIG_HOME: xdgRoot, MCP_BRIDGES_CONFIG: explicitEnvPath },
    }),
    explicitEnvPath,
  );

  const explicitOptionPath = path.join(root, 'explicit-option.json');
  assert.equal(
    await resolveConfigPath({
      filename: 'bridges.json',
      envName: 'MCP_BRIDGES_CONFIG',
      explicitPath: explicitOptionPath,
      env: { ...env, XDG_CONFIG_HOME: xdgRoot, MCP_BRIDGES_CONFIG: explicitEnvPath },
    }),
    explicitOptionPath,
  );

  console.log('PASS config path precedence');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
