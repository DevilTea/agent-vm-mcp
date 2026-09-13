import { ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  READ_ARTIFACT_TOOL,
  ARTIFACT_RESULT_META_KEY,
  PRESENT_ARTIFACT_TOOL,
  PRESENT_FILE_TOOL,
} from './constants.js';
import {
  artifactIdFromUri,
  DEFAULT_TEXT_READ_BYTES,
  MAX_TEXT_READ_BYTES,
} from './artifact-store.js';
import { isTextMimeType } from './mime.js';

const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;

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

async function presentationContent(artifactStore, artifact) {
  const content = [
    { type: 'text', text: artifactSummary(artifact) },
    artifactResourceLink(artifact),
  ];
  if (isTextMimeType(artifact.mimeType) && artifact.size <= MAX_TEXT_READ_BYTES) {
    const resource = await artifactStore.readResource(artifact.id);
    content.push({ type: 'resource', resource });
  }
  return content;
}

function registeredArtifact(artifactStore, uri) {
  const id = artifactIdFromUri(uri);
  if (!id) throw new Error(`Invalid artifact URI: ${uri}`);
  return artifactStore.publicMetadata(artifactStore.get(id));
}

export async function registerArtifactSystem(server, artifactStore) {
  server.registerTool(
    READ_ARTIFACT_TOOL,
    {
      title: 'Read VM artifact',
      description:
        'Read an opaque VM artifact for model/internal use without presenting it to the user. ' +
        'Text is returned in bounded UTF-8 chunks; use nextOffset to continue. Supported images are returned as standard MCP image content. ' +
        'Use present_artifact only when user-facing file presentation is intended.',
      inputSchema: z.object({
        uri: z.string().min(1).describe('Opaque artifact://agent-vm URI returned by another tool.'),
        offset: z.number().int().min(0).default(0).describe('Requested byte offset for a text artifact. If it lands inside a UTF-8 code point, reading advances to the next code-point boundary; startOffset reports the actual start.'),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_TEXT_READ_BYTES)
          .default(DEFAULT_TEXT_READ_BYTES)
          .describe('Maximum UTF-8 bytes returned for a text chunk.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ uri, offset, maxBytes }) => {
      const artifact = registeredArtifact(artifactStore, uri);
      if (artifact.mimeType.startsWith('image/')) {
        const resource = await artifactStore.readResource(artifact.id, {
          maxBytes: MAX_MODEL_IMAGE_BYTES,
          maxBytesLabel: 'model image limit',
        });
        if (resource.blob === undefined) throw new Error(`Image artifact did not produce image content: ${artifact.id}`);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ artifact }, null, 2) },
            { type: 'image', data: resource.blob, mimeType: artifact.mimeType },
          ],
        };
      }
      if (!isTextMimeType(artifact.mimeType)) {
        throw new Error(
          `read_artifact supports text and image artifacts; unsupported binary MIME type ${artifact.mimeType} cannot be returned to the model.`,
        );
      }
      return {
        content: [
          { type: 'text', text: JSON.stringify(await artifactStore.readText(artifact.id, { offset, maxBytes }), null, 2) },
        ],
      };
    },
  );

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
        'Explicitly present a regular file from the Agent VM to the user as an opaque MCP resource link. ' +
        'Do not use this for model-only inspection; register/read internal artifacts instead. The VM filesystem path is not exposed.',
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
      const artifact = await artifactStore.registerFile(path, { name, source: PRESENT_FILE_TOOL });
      return {
        content: await presentationContent(artifactStore, artifact),
        _meta: { [ARTIFACT_RESULT_META_KEY]: artifact },
      };
    },
  );

  server.registerTool(
    PRESENT_ARTIFACT_TOOL,
    {
      title: 'Present VM artifact',
      description:
        'Explicitly present an already-registered opaque VM artifact to the user as an MCP resource link. ' +
        'Use the artifact URI returned by another tool. Use read_artifact instead for model-only inspection.',
      inputSchema: z.object({
        uri: z.string().min(1).describe('Opaque artifact://agent-vm URI returned by another tool.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ uri }) => {
      const artifact = registeredArtifact(artifactStore, uri);
      return {
        content: await presentationContent(artifactStore, artifact),
        _meta: { [ARTIFACT_RESULT_META_KEY]: artifact },
      };
    },
  );
}
