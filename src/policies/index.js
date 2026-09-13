import {
  createDenyWorkspaceConfigFilesPolicy,
  validateDenyWorkspaceConfigFilesPolicyConfig,
} from './deny-workspace-config-files.js';

export function validateBridgeCallPolicies(bridge) {
  const configs = bridge.callPolicies ?? [];
  if (!Array.isArray(configs)) {
    throw new Error(`callPolicies on bridge ${bridge.id} must be an array.`);
  }
  configs.forEach((config, index) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`callPolicies[${index}] on bridge ${bridge.id} must be an object.`);
    }
    if (config.type === 'deny-workspace-config-files') {
      validateDenyWorkspaceConfigFilesPolicyConfig(config, bridge.id);
      return;
    }
    throw new Error(`Unsupported call policy type ${JSON.stringify(config.type)} on bridge ${bridge.id}.`);
  });
}

export function createBridgeCallPolicyFactory() {
  return ({ bridge }) => {
    validateBridgeCallPolicies(bridge);
    return (bridge.callPolicies ?? []).map((config) => {
      if (config.type === 'deny-workspace-config-files') {
        return createDenyWorkspaceConfigFilesPolicy({ config, bridgeId: bridge.id });
      }
      throw new Error(`Unsupported call policy type ${JSON.stringify(config.type)} on bridge ${bridge.id}.`);
    });
  };
}
