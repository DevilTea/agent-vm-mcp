import fs from 'node:fs/promises';
import path from 'node:path';

import { ARTIFACT_RESULT_META_KEY } from '../artifacts/constants.js';

async function statFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return {
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function snapshotDirectory(outputDir, extensions) {
  let entries;
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }

  const normalizedExtensions = new Set(extensions.map((extension) => extension.toLowerCase()));
  const snapshot = new Map();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .filter((entry) => normalizedExtensions.has(path.extname(entry.name).toLowerCase()))
      .map(async (entry) => {
        const file = await statFile(path.join(outputDir, entry.name));
        if (file) snapshot.set(entry.name, file);
      }),
  );
  return snapshot;
}

function isChanged(previous, current) {
  return Boolean(
    current &&
      (!previous ||
        previous.size !== current.size ||
        previous.mtimeMs !== current.mtimeMs ||
        previous.ctimeMs !== current.ctimeMs),
  );
}

function changedFiles(before, after) {
  const changed = [];
  for (const [name, current] of after) {
    if (isChanged(before.get(name), current)) changed.push(current);
  }
  return changed.sort((left, right) => right.mtimeMs - left.mtimeMs || right.ctimeMs - left.ctimeMs);
}

function explicitOutputPath(args, config) {
  if (!config.pathArgument) return null;
  const value = args?.[config.pathArgument];
  if (typeof value !== 'string' || value.length === 0) return null;
  if (path.isAbsolute(value)) return path.normalize(value);
  const workingDir = config.workingDir ?? config.outputDir;
  return path.resolve(workingDir, value);
}

function configuredMimeType(args, config) {
  if (!config.mimeTypeArgument || !config.mimeTypeMap) return undefined;
  const value = args?.[config.mimeTypeArgument];
  return typeof value === 'string' ? config.mimeTypeMap[value] : undefined;
}

export function validateOutputDirectoryArtifactConfig(config, bridgeId, toolName) {
  if (!config.outputDir || typeof config.outputDir !== 'string') {
    throw new Error(`Adapter for ${bridgeId}.${toolName} requires outputDir.`);
  }
  const extensions = config.extensions ?? ['.png', '.jpg', '.jpeg', '.webp'];
  if (
    !Array.isArray(extensions) ||
    extensions.length === 0 ||
    extensions.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    throw new Error(`Adapter for ${bridgeId}.${toolName} requires a non-empty extensions array.`);
  }
  for (const key of ['pathArgument', 'workingDir', 'mimeTypeArgument']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].length === 0)) {
      throw new Error(`Adapter ${key} for ${bridgeId}.${toolName} must be a non-empty string.`);
    }
  }
  if (config.mimeTypeMap !== undefined) {
    if (!config.mimeTypeMap || typeof config.mimeTypeMap !== 'object' || Array.isArray(config.mimeTypeMap)) {
      throw new Error(`Adapter mimeTypeMap for ${bridgeId}.${toolName} must be an object.`);
    }
    for (const [key, value] of Object.entries(config.mimeTypeMap)) {
      if (!key || typeof value !== 'string' || value.length === 0) {
        throw new Error(`Adapter mimeTypeMap for ${bridgeId}.${toolName} must contain non-empty string values.`);
      }
    }
  }
  if ((config.mimeTypeArgument === undefined) !== (config.mimeTypeMap === undefined)) {
    throw new Error(`Adapter for ${bridgeId}.${toolName} requires mimeTypeArgument and mimeTypeMap together.`);
  }
  return { extensions };
}

export function createOutputDirectoryArtifactAdapter({ artifactStore, config, bridgeId, toolName }) {
  const { extensions } = validateOutputDirectoryArtifactConfig(config, bridgeId, toolName);

  return {
    async beforeCall({ args }) {
      const explicitPath = explicitOutputPath(args, config);
      return {
        directory: await snapshotDirectory(config.outputDir, extensions),
        explicitPath,
        explicitFile: explicitPath ? await statFile(explicitPath) : null,
      };
    },

    async afterCall({ args, result, state }) {
      if (result?.isError || !state?.directory) return result;

      let latest = null;
      if (state.explicitPath) {
        const currentExplicitFile = await statFile(state.explicitPath);
        if (isChanged(state.explicitFile, currentExplicitFile)) latest = currentExplicitFile;
      }

      if (!latest) {
        const after = await snapshotDirectory(config.outputDir, extensions);
        [latest] = changedFiles(state.directory, after);
      }
      if (!latest) return result;

      const artifact = await artifactStore.registerFile(latest.path, {
        mimeType: configuredMimeType(args, config),
        source: `${bridgeId}.${toolName}`,
      });

      let content = [
        ...(result.content ?? []).filter(
          (item) => !(item.type === 'resource_link' && item.uri === artifact.uri),
        ),
        { type: 'text', text: JSON.stringify({ artifact }, null, 2) },
      ];
      if (artifact.mimeType.startsWith('image/') && !content.some((item) => item.type === 'image')) {
        const resource = await artifactStore.readResource(artifact.id);
        if (resource.blob !== undefined) {
          content = [
            ...content,
            { type: 'image', data: resource.blob, mimeType: artifact.mimeType },
          ];
        }
      }

      console.error(
        `[artifact] registered ${bridgeId}.${toolName} artifact=${artifact.uri} content=[${content.map((item) => item.type).join(',')}]`,
      );

      return {
        ...result,
        content,
        _meta: {
          ...(result._meta ?? {}),
          [ARTIFACT_RESULT_META_KEY]: artifact,
        },
      };
    },
  };
}
