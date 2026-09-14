const HOST_KINDS = new Set(['generic', 'chatgpt']);

export function resolveHostProfile(env = process.env) {
  const kind = env.AGENT_MCP_HOST || 'generic';
  if (!HOST_KINDS.has(kind)) {
    throw new Error(`AGENT_MCP_HOST must be one of: ${[...HOST_KINDS].join(', ')}.`);
  }

  return {
    kind,
    importFileToolMeta: kind === 'chatgpt' ? { 'openai/fileParams': ['file'] } : undefined,
    interactionAdapter: kind === 'chatgpt' ? 'chatgpt' : null,
  };
}
