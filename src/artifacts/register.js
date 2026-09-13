import { ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  ARTIFACT_RESULT_META_KEY,
  PRESENT_FILE_TOOL,
} from './constants.js';
import { artifactIdFromUri } from './artifact-store.js';
import { isTextMimeType } from './mime.js';

const MAX_MODEL_TEXT_BYTES = 256 * 1024;

function artifactSummary(artifact) {
  return `Presented VM artifact ${artifact.name} (${artifact.mimeType}, ${artifact.size} bytes).`;
}

function artifactResourceLink(artifact) {
  return {
    type: 'resource_link',
    uri: artifact.uri,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
  };
}

export async function registerArtifactSystem(server, artifactStore) {
  server.registerResource(
    'agent-vm-artifact',
    new ResourceTemplate('artifact://agent-vm/{id}', { list: undefined }),
    {
      title: 'Agent VM artifact',
      description: 'Opaque artifact resource backed by a registered Agent VM file.',
    },
    async (uri) => {
      const id = artifactIdFromUri(uri);
      if (!id) throw new Error(`Invalid artifact URI: ${uri.href}`);
      return { contents: [await artifactStore.readResource(id)] };
    },
  );

  server.registerTool(
    PRESENT_FILE_TOOL,
    {
      title: 'Present VM file',
      description:
        'Present a regular file from the Agent VM as an opaque MCP artifact resource. ' +
        'The VM filesystem path is not exposed in artifact metadata.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Absolute or working-directory-relative path to a regular file on the VM.'),
        name: z.string().min(1).max(255).optional().describe('Optional display filename. Defaults to the source basename.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, name }) => {
      const artifact = await artifactStore.registerFile(path, {
        name,
        source: PRESENT_FILE_TOOL,
      });
      const content = [
        { type: 'text', text: artifactSummary(artifact) },
        artifactResourceLink(artifact),
      ];

      if (isTextMimeType(artifact.mimeType) && artifact.size <= MAX_MODEL_TEXT_BYTES) {
        const resource = await artifactStore.readResource(artifact.id);
        content.push({ type: 'resource', resource });
      }

      return {
        content,
        _meta: {
          [ARTIFACT_RESULT_META_KEY]: artifact,
        },
      };
    },
  );
}
