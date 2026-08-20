import { createOutputDirectoryArtifactAdapter } from './output-directory-artifact.js';

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
