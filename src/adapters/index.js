import {
  createOutputDirectoryArtifactAdapter,
  validateOutputDirectoryArtifactConfig,
} from './output-directory-artifact.js';

export function validateBridgeToolAdapters(bridge) {
  const configs = bridge.toolAdapters ?? {};
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
    throw new Error(`toolAdapters on bridge ${bridge.id} must be an object.`);
  }
  for (const [toolName, config] of Object.entries(configs)) {
    if (!toolName || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`toolAdapters.${toolName || '<empty>'} on bridge ${bridge.id} must be an object.`);
    }
    if (config.type === 'output-directory-artifact') {
      validateOutputDirectoryArtifactConfig(config, bridge.id, toolName);
      continue;
    }
    throw new Error(`Unsupported tool adapter type ${JSON.stringify(config.type)} for ${bridge.id}.${toolName}.`);
  }
}

export function createBridgeToolAdapterFactory({ artifactStore }) {
  return ({ bridge, tool }) => {
    const config = bridge.toolAdapters?.[tool.name];
    if (!config) return null;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`toolAdapters.${tool.name} on bridge ${bridge.id} must be an object.`);
    }

    if (config.type === 'output-directory-artifact') {
      return createOutputDirectoryArtifactAdapter({
        artifactStore,
        config,
        bridgeId: bridge.id,
        toolName: tool.name,
      });
    }

    throw new Error(
      `Unsupported tool adapter type ${JSON.stringify(config.type)} for ${bridge.id}.${tool.name}.`,
    );
  };
}
