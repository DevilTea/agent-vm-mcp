import fs from 'node:fs/promises';
import path from 'node:path';

function validateFilename(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    path.basename(value) !== value
  ) {
    throw new Error(`${label} must be a plain filename.`);
  }
  return value;
}

async function pathExists(candidate) {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function validateDenyWorkspaceConfigFilesPolicyConfig(config, bridgeId) {
  const workspaceRootArgument = config.workspaceRootArgument ?? 'workspaceRoot';
  if (typeof workspaceRootArgument !== 'string' || workspaceRootArgument.length === 0) {
    throw new Error(
      `Call policy deny-workspace-config-files on bridge ${bridgeId} requires workspaceRootArgument to be a non-empty string.`,
    );
  }

  if (!Array.isArray(config.filenames) || config.filenames.length === 0) {
    throw new Error(
      `Call policy deny-workspace-config-files on bridge ${bridgeId} requires a non-empty filenames array.`,
    );
  }
  const filenames = config.filenames.map((filename, index) =>
    validateFilename(
      filename,
      `Call policy deny-workspace-config-files on bridge ${bridgeId} filenames[${index}]`,
    ),
  );

  return { workspaceRootArgument, filenames };
}

export function createDenyWorkspaceConfigFilesPolicy({ config, bridgeId }) {
  const { workspaceRootArgument, filenames } = validateDenyWorkspaceConfigFilesPolicyConfig(config, bridgeId);

  return {
    async beforeCall({ args }) {
      const workspaceRoot = args?.[workspaceRootArgument];
      if (workspaceRoot === undefined) return;
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
        throw new Error(`${workspaceRootArgument} must be a non-empty string.`);
      }

      const normalizedRoot = path.resolve(workspaceRoot);
      for (const filename of filenames) {
        if (await pathExists(path.join(normalizedRoot, filename))) {
          throw new Error(
            `Bridge ${bridgeId} rejected workspace ${JSON.stringify(normalizedRoot)} because repo-local ${filename} is not allowed.`,
          );
        }
      }
    },
  };
}
