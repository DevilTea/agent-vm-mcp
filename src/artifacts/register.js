import { ResourceTemplate } from '@modelcontextprotocol/server';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';

import { registerArtifactViewer } from '../apps/artifact-viewer.js';
import {
  ARTIFACT_READ_TOOL,
  ARTIFACT_RESULT_META_KEY,
  ARTIFACT_VIEWER_URI,
  PRESENT_FILE_TOOL,
} from './constants.js';
import { artifactIdFromUri } from './artifact-store.js';
import { isTextMimeType } from './mime.js';

const MAX_MODEL_TEXT_BYTES = 256 * 1024;

function artifactSummary(artifact) {
  return `Presented VM artifact ${artifact.name} (${artifact.mimeType}, ${artifact.size} bytes).`;
}

export async function registerArtifactSystem(server, artifactStore) {
  await registerArtifactViewer(server);

  let artifactReadToolCallCount = 0;
  registerAppTool(
    server,
    ARTIFACT_READ_TOOL,
    {
      title: 'Read VM artifact',
      description: 'Read an opaque agent-01 VM artifact for the Artifact Viewer app.',
      inputSchema: z.object({
        uri: z.string().min(1).describe('Opaque artifact://agent-vm URI from artifact metadata.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ uri }) => {
      const id = artifactIdFromUri(uri);
      if (!id) throw new Error(`Invalid artifact URI: ${uri}`);
      artifactReadToolCallCount += 1;
      console.error(`[artifact-viewer] artifact tool read #${artifactReadToolCallCount}: ${uri}`);
      const resource = await artifactStore.readResource(id);
      console.error(`[artifact-viewer] artifact tool return #${artifactReadToolCallCount}: ${resource.mimeType}`);
      return { content: [{ type: 'resource', resource }] };
    },
  );

  server.registerResource(
    'agent-vm-artifact',
    new ResourceTemplate('artifact://agent-vm/{id}', { list: undefined }),
    {
      title: 'Agent VM artifact',
      description: 'Opaque artifact resource backed by a file registered on agent-01 VM.',
    },
    async (uri) => {
      const id = artifactIdFromUri(uri);
      if (!id) throw new Error(`Invalid artifact URI: ${uri.href}`);
      return { contents: [await artifactStore.readResource(id)] };
    },
  );

  registerAppTool(
    server,
    PRESENT_FILE_TOOL,
    {
      title: 'Present VM file',
      description:
        'Present a regular file from agent-01 VM in the conversation as an artifact. ' +
        'The file is referenced by an opaque artifact URI; the VM path is not exposed to the viewer.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Absolute or working-directory-relative path to a regular file on the VM.'),
        name: z.string().min(1).max(255).optional().describe('Optional display/download filename. Defaults to the source basename.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: ARTIFACT_VIEWER_URI },
        'openai/outputTemplate': ARTIFACT_VIEWER_URI,
      },
    },
    async ({ path, name }) => {
      const artifact = await artifactStore.registerFile(path, {
        name,
        source: PRESENT_FILE_TOOL,
      });
      const content = [{ type: 'text', text: artifactSummary(artifact) }];

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
