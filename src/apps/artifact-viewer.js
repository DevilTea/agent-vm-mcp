import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

import { ARTIFACT_READ_TOOL, ARTIFACT_RESULT_META_KEY, ARTIFACT_VIEWER_URI } from '../artifacts/constants.js';

const require = createRequire(import.meta.url);
const APP_BUNDLE_PATH = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
const RELAY_PROBE_URI = 'probe://agent-vm/artifact-viewer';
const RELAY_PROBE_TOOL = 'artifact_viewer_relay_probe';

function viewerClientSource(appSymbol) {
  return `
const ArtifactApp = ${appSymbol};
const ARTIFACT_META_KEY = ${JSON.stringify(ARTIFACT_RESULT_META_KEY)};
const app = new ArtifactApp(
  { name: 'agent-vm-artifact-viewer', version: '1.0.0' },
  {},
  { autoResize: true },
);

const root = document.getElementById('root');
let currentArtifact = null;
let currentResource = null;
let currentFile = null;
let currentObjectUrl = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return (index === 0 ? String(value) : value.toFixed(value >= 10 ? 1 : 2)) + ' ' + units[index];
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function resourceToFile(resource, artifact) {
  const parts = resource.blob !== undefined
    ? [base64ToBytes(resource.blob)]
    : [resource.text ?? ''];
  return new File(parts, artifact.name, { type: artifact.mimeType });
}

function revokeCurrentObjectUrl() {
  if (!currentObjectUrl) return;
  URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = null;
}

function currentFileObjectUrl() {
  if (!currentFile) throw new Error('Artifact file is not loaded.');
  if (!currentObjectUrl) currentObjectUrl = URL.createObjectURL(currentFile);
  return currentObjectUrl;
}

function isTextMime(mimeType) {
  return mimeType.startsWith('text/') ||
    ['application/json', 'application/ld+json', 'application/x-ndjson', 'application/yaml', 'application/xml', 'application/javascript'].includes(mimeType) ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml');
}

const WIDGET_STATE_PRIVATE_KEY = 'io.deviltea.agent-vm/artifact-viewer';

function isArtifactMetadata(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.uri === 'string' &&
    value.uri.startsWith('artifact://agent-vm/') &&
    typeof value.name === 'string' &&
    typeof value.mimeType === 'string' &&
    Number.isFinite(value.size)
  );
}

function artifactFromToolResponseMetadata() {
  const metadata = window.openai?.toolResponseMetadata;
  if (!metadata || typeof metadata !== 'object') return null;

  const candidates = [
    metadata?.mcp_tool_result?._meta?.[ARTIFACT_META_KEY],
    metadata?.mcp_tool_result?.result?._meta?.[ARTIFACT_META_KEY],
    metadata?.call_tool_result?._meta?.[ARTIFACT_META_KEY],
    metadata?.call_tool_result?.result?._meta?.[ARTIFACT_META_KEY],
    metadata?._meta?.[ARTIFACT_META_KEY],
    metadata?.[ARTIFACT_META_KEY],
  ];
  return candidates.find(isArtifactMetadata) ?? null;
}

function artifactFromHostState() {
  const responseArtifact = artifactFromToolResponseMetadata();
  if (responseArtifact) return responseArtifact;

  const persisted = window.openai?.widgetState?.[WIDGET_STATE_PRIVATE_KEY]?.artifact;
  return isArtifactMetadata(persisted) ? persisted : null;
}

function persistArtifactWidgetState(artifact) {
  if (!window.openai?.setWidgetState) return;
  try {
    const current = window.openai.widgetState;
    const state = current && typeof current === 'object' && !Array.isArray(current)
      ? current
      : {};
    window.openai.setWidgetState({
      ...state,
      [WIDGET_STATE_PRIVATE_KEY]: { version: 1, artifact },
    });
  } catch (error) {
    console.warn('Artifact widget-state persistence failed', error);
  }
}

async function restoreArtifactFromHostState() {
  if (currentArtifact) return true;
  const artifact = artifactFromHostState();
  if (!artifact) return false;
  await handleArtifact(artifact);
  return true;
}

async function ensureCurrentResource() {
  if (currentResource) return currentResource;
  if (!currentArtifact) throw new Error('No artifact is selected.');
  const result = await app.callServerTool(
    { name: ${JSON.stringify(ARTIFACT_READ_TOOL)}, arguments: { uri: currentArtifact.uri } },
    { timeout: 20000 },
  );
  if (result?.isError) throw new Error('Artifact read tool returned an error.');
  const resource = result?.content?.find((item) => item.type === 'resource')?.resource;
  if (!resource) throw new Error('Artifact read tool returned no resource content.');
  currentResource = resource;
  currentFile = resourceToFile(resource, currentArtifact);
  return resource;
}

function setStatus(message, kind = '') {
  const status = document.getElementById('status');
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function renderShell(artifact) {
  root.replaceChildren();

  const card = document.createElement('main');
  card.className = 'card';

  const header = document.createElement('header');
  const titleWrap = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = artifact.name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = artifact.mimeType + ' · ' + formatBytes(artifact.size);
  titleWrap.append(title, meta);

  header.append(titleWrap);

  const preview = document.createElement('section');
  preview.id = 'preview';
  preview.className = 'preview';
  const loading = document.createElement('div');
  loading.className = 'placeholder';
  loading.textContent = 'Loading artifact…';
  preview.append(loading);

  const status = document.createElement('div');
  status.id = 'status';
  status.className = 'status';

  card.append(header, preview, status);
  root.append(card);
}

function renderResource(resource, artifact) {
  const preview = document.getElementById('preview');
  preview.replaceChildren();
  preview.classList.remove('image-preview');

  if (artifact.mimeType.startsWith('image/') && resource.blob !== undefined) {
    preview.classList.add('image-preview');
    const image = document.createElement('img');
    image.alt = artifact.name;
    image.src = currentFileObjectUrl();
    preview.append(image);
    return;
  }

  if (resource.text !== undefined) {
    const pre = document.createElement('pre');
    pre.textContent = resource.text;
    preview.append(pre);
    return;
  }

  renderFileCard(preview);
}

function renderFileCard(preview = document.getElementById('preview')) {
  preview.replaceChildren();
  const fileCard = document.createElement('div');
  fileCard.className = 'file-card';
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = 'FILE';
  const message = document.createElement('span');
  message.textContent = 'Preview is not available for this file type. Use the host-provided artifact link when available.';
  fileCard.append(icon, message);
  preview.append(fileCard);
}

async function handleArtifact(artifact) {
  revokeCurrentObjectUrl();
  currentArtifact = artifact;
  currentResource = null;
  currentFile = null;
  persistArtifactWidgetState(artifact);
  renderShell(artifact);

  if (!artifact.mimeType.startsWith('image/') && !isTextMime(artifact.mimeType)) {
    renderFileCard();
    setStatus('Artifact ready. Use the host-provided artifact link to open the original file.', 'muted');
    return;
  }

  try {
    const resource = await ensureCurrentResource();
    renderResource(resource, artifact);
    setStatus('Artifact ready.', 'muted');
  } catch (error) {
    const preview = document.getElementById('preview');
    preview.replaceChildren();
    const message = document.createElement('div');
    message.className = 'placeholder error';
    message.textContent = 'Unable to read artifact: ' + (error?.message ?? String(error));
    preview.append(message);
    setStatus('Artifact resource unavailable.', 'error');
  }
}

app.addEventListener('toolresult', (result) => {
  const artifact = result?._meta?.[ARTIFACT_META_KEY] ?? artifactFromHostState();
  if (isArtifactMetadata(artifact)) {
    void handleArtifact(artifact);
  } else {
    root.innerHTML = '<main class="card"><div class="placeholder">This tool result did not include an artifact.</div></main>';
  }
});

window.addEventListener('openai:set_globals', () => {
  if (!currentArtifact) void restoreArtifactFromHostState();
});

app.onteardown = () => {
  revokeCurrentObjectUrl();
  return {};
};

try {
  await app.connect();
  if (!currentArtifact && !(await restoreArtifactFromHostState())) {
    root.innerHTML = '<main class="card"><div class="placeholder">Waiting for artifact result…</div></main>';
  }
} catch (error) {
  root.innerHTML = '<main class="card"><div class="placeholder error">Artifact viewer failed to connect to the host.</div></main>';
  console.error(error);
}
`;
}

function viewerStyles() {
  return `
:root {
  font-family: var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  color-scheme: light dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: transparent; color: var(--color-text-primary, CanvasText); }
.card {
  border: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 18%, transparent));
  border-radius: var(--border-radius-lg, 12px);
  overflow: hidden;
  background: var(--color-background-primary, Canvas);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border-tertiary, color-mix(in srgb, CanvasText 12%, transparent));
}
strong { display: block; overflow-wrap: anywhere; }
.meta, .status { font-size: 12px; color: var(--color-text-secondary, GrayText); }
.meta { margin-top: 3px; }
.preview { max-height: min(640px, 70vh); overflow: auto; }
.preview.image-preview { max-height: none; overflow: visible; }
.preview img { display: block; width: 100%; height: auto; }
.preview pre {
  margin: 0;
  padding: 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.5 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.placeholder, .file-card { padding: 24px 14px; color: var(--color-text-secondary, GrayText); }
.file-card { display: flex; align-items: center; gap: 12px; }
.file-icon { font: 700 11px var(--font-mono, monospace); padding: 7px; border: 1px solid currentColor; border-radius: 5px; }
.status { min-height: 31px; padding: 8px 14px; border-top: 1px solid var(--color-border-tertiary, color-mix(in srgb, CanvasText 10%, transparent)); }
.status[data-kind="success"] { color: var(--color-text-success, inherit); }
.status[data-kind="warning"] { color: var(--color-text-warning, inherit); }
.status[data-kind="error"], .error { color: var(--color-text-danger, inherit); }
@media (max-width: 520px) {
  header { align-items: flex-start; flex-direction: column; }
}
`;
}

async function buildViewerHtml() {
  const appBundle = await fs.readFile(APP_BUNDLE_PATH, 'utf8');
  const appExport = appBundle.match(/([A-Za-z_$][\w$]*) as App(?=[,}])/);
  if (!appExport) throw new Error('Could not locate App export in ext-apps bundle.');

  const appSymbol = appExport[1];
  const moduleSource = `${appBundle}\n${viewerClientSource(appSymbol)}`.replaceAll('</script', '<\/script');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${viewerStyles()}</style>
</head>
<body>
<div id="root"><main class="card"><div class="placeholder">Connecting artifact viewer…</div></main></div>
<script type="module">${moduleSource}</script>
</body>
</html>`;
}

let viewerResourceReadCount = 0;

export async function registerArtifactViewer(server) {
  const html = await buildViewerHtml();
  let relayProbeReadCount = 0;
  let relayProbeToolCallCount = 0;
  server.registerTool(
    RELAY_PROBE_TOOL,
    {
      description: 'Tiny app-only tool used to validate MCP App tool relay.',
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => {
      relayProbeToolCallCount += 1;
      console.error(`[artifact-viewer] tiny tool probe call #${relayProbeToolCallCount}: ${RELAY_PROBE_TOOL}`);
      const result = {
        content: [{ type: 'text', text: 'artifact-viewer-tool-relay-ok' }],
      };
      console.error(`[artifact-viewer] tiny tool probe return #${relayProbeToolCallCount}: artifact-viewer-tool-relay-ok`);
      return result;
    },
  );
  server.registerResource(
    'agent-vm-artifact-viewer-relay-probe',
    RELAY_PROBE_URI,
    {
      title: 'Artifact Viewer relay probe',
      description: 'Tiny plain-text resource used to validate MCP App resource relay.',
      mimeType: 'text/plain',
    },
    async () => {
      relayProbeReadCount += 1;
      console.error(`[artifact-viewer] tiny relay probe read #${relayProbeReadCount}: ${RELAY_PROBE_URI}`);
      const result = {
        contents: [
          {
            uri: RELAY_PROBE_URI,
            mimeType: 'text/plain',
            text: 'artifact-viewer-relay-ok',
          },
        ],
      };
      console.error(`[artifact-viewer] tiny relay probe return #${relayProbeReadCount}: artifact-viewer-relay-ok`);
      return result;
    },
  );

  registerAppResource(
    server,
    'agent-vm-artifact-viewer',
    ARTIFACT_VIEWER_URI,
    {
      title: 'Agent VM artifact viewer',
      description: 'Preview and download artifacts produced on agent-01 VM.',
    },
    async () => {
      viewerResourceReadCount += 1;
      console.error(`[artifact-viewer] resource read #${viewerResourceReadCount}: ${ARTIFACT_VIEWER_URI}`);
      return {
        contents: [
          {
            uri: ARTIFACT_VIEWER_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: { prefersBorder: false },
            },
          },
        ],
      };
    },
  );
}
