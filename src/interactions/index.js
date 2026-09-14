import { REQUEST_USER_INPUT_TOOL } from './model.js';
import { registerChatgptInteractionAdapter } from './hosts/chatgpt.js';

export function interactionToolNamesForHost(hostProfile) {
  return hostProfile.interactionAdapter === 'chatgpt' ? [REQUEST_USER_INPUT_TOOL] : [];
}

export function registerInteractionsForHost(server, hostProfile) {
  if (hostProfile.interactionAdapter === null) return;

  if (hostProfile.interactionAdapter === 'chatgpt') {
    registerChatgptInteractionAdapter(server);
    return;
  }

  throw new Error(`Unsupported interaction adapter: ${hostProfile.interactionAdapter}`);
}
