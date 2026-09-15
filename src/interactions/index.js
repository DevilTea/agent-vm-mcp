import {
  CHATGPT_INTERACTION_TOOL_NAMES,
  registerChatgptInteractionAdapter,
} from './hosts/chatgpt.js';

export function interactionToolNamesForHost(hostProfile) {
  return hostProfile.interactionAdapter === 'chatgpt' ? CHATGPT_INTERACTION_TOOL_NAMES : [];
}

export async function registerInteractionsForHost(server, hostProfile) {
  if (hostProfile.interactionAdapter === null) return null;

  if (hostProfile.interactionAdapter === 'chatgpt') {
    return await registerChatgptInteractionAdapter(server);
  }

  throw new Error(`Unsupported interaction adapter: ${hostProfile.interactionAdapter}`);
}
