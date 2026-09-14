import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';

import {
  INTERACTION_SCHEMA_VERSION,
  REQUEST_USER_INPUT_TOOL,
  formatInteractionFallback,
  interactionRequestSchema,
  interactionResultSchema,
} from '../model.js';

const CHATGPT_INTERACTION_RESOURCE_NAME = 'Agent VM structured user input';
const CHATGPT_UI_PATH = new URL('./chatgpt-app.html', import.meta.url);
const CHATGPT_UI_HTML = readFileSync(CHATGPT_UI_PATH, 'utf8');
const CHATGPT_UI_RESOURCE_META = {
  'openai/widgetPrefersBorder': true,
  ui: {
    prefersBorder: true,
  },
};
const CHATGPT_UI_REVISION = createHash('sha256')
  .update(CHATGPT_UI_HTML)
  .update('\0')
  .update(JSON.stringify(CHATGPT_UI_RESOURCE_META))
  .digest('hex')
  .slice(0, 12);
export const CHATGPT_INTERACTION_RESOURCE_URI =
  `ui://agent-vm/request-user-input/v1-${CHATGPT_UI_REVISION}.html`;

export function registerChatgptInteractionAdapter(server) {
  registerAppResource(
    server,
    CHATGPT_INTERACTION_RESOURCE_NAME,
    CHATGPT_INTERACTION_RESOURCE_URI,
    {
      description: 'Inline structured question form used by request_user_input.',
      _meta: CHATGPT_UI_RESOURCE_META,
    },
    async () => ({
      contents: [
        {
          uri: CHATGPT_INTERACTION_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: CHATGPT_UI_HTML,
          _meta: CHATGPT_UI_RESOURCE_META,
        },
      ],
    }),
  );

  registerAppTool(
    server,
    REQUEST_USER_INPUT_TOOL,
    {
      title: 'Request user input',
      description:
        'Present a compact structured form when the user must make a real choice or provide information before the discussion can continue. ' +
        'Use this for architecture, design, issue, planning, or other decisions with meaningful tradeoffs. Prefer 1-4 focused questions, concise options, and mark at most one recommendation when you have one. ' +
        'Prefer single_select for binary choices too; boolean remains available only for compatibility with existing callers. ' +
        'Do not use it when you can safely make a reversible decision yourself. After calling this tool, wait for the form response instead of answering the questions yourself.',
      inputSchema: interactionRequestSchema,
      outputSchema: interactionResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: CHATGPT_INTERACTION_RESOURCE_URI,
          visibility: ['model'],
        },
        'openai/toolInvocation/invoking': 'Preparing questions…',
        'openai/toolInvocation/invoked': 'Questions ready.',
      },
    },
    async (request) => {
      const interactionId = randomUUID();
      const structuredContent = {
        schemaVersion: INTERACTION_SCHEMA_VERSION,
        interactionId,
        request,
      };
      return {
        structuredContent,
        content: [
          {
            type: 'text',
            text: formatInteractionFallback(request, interactionId),
          },
        ],
      };
    },
  );
}
