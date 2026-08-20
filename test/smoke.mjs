import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const node = '/home/agent/.local/share/pnpm/bin/node';
const artifactMetaKey = 'io.deviltea.agent-vm/artifact';
const artifactViewerUri = 'ui://agent-vm/artifact-viewer-v12.html';
const presentFilePath = '/tmp/agent-mcp-present-file-smoke.txt';
const viewerScriptPath = '/tmp/agent-mcp-artifact-viewer-smoke.mjs';
const execFileAsync = promisify(execFile);
const client = new Client({ name: 'agent-mcp-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: node,
  args: ['/opt/agent-mcp/src/index.js'],
  cwd: '/home/agent',
  env: {
    ...process.env,
    MCP_BRIDGES_CONFIG: '/opt/agent-mcp/test/bridges.smoke.json',
  },
  stderr: 'inherit',
});

try {
  await fs.writeFile(presentFilePath, 'artifact smoke text\nline two\n', 'utf8');
  await client.connect(transport);

  const allTools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    allTools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  const names = allTools.map((tool) => tool.name);
  const required = [
    'exec',
    'process_start',
    'process_read',
    'process_write',
    'process_kill',
    'mcp_bridge_status',
    'capabilities',
    'command_info',
    'present_file',
    'browser_navigate',
    'browser_snapshot',
    'browser_take_screenshot',
  ];
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
  }
  if (names.includes('browser_screenshot_poc')) {
    throw new Error('Legacy browser_screenshot_poc should not be registered');
  }

  const presentFileTool = allTools.find((tool) => tool.name === 'present_file');
  if (presentFileTool?._meta?.ui?.resourceUri !== artifactViewerUri) {
    throw new Error('present_file UI resource metadata missing');
  }
  if (presentFileTool?._meta?.['openai/outputTemplate'] !== artifactViewerUri) {
    throw new Error('present_file outputTemplate compatibility alias missing');
  }

  const screenshotTool = allTools.find((tool) => tool.name === 'browser_take_screenshot');
  if (screenshotTool?._meta?.ui?.resourceUri !== artifactViewerUri) {
    throw new Error('browser_take_screenshot artifact viewer metadata missing');
  }

  const viewerResource = await client.readResource({ uri: artifactViewerUri });
  const viewerHtml = viewerResource.contents?.[0]?.text ?? '';
  if (viewerResource.contents?.[0]?.mimeType !== 'text/html;profile=mcp-app') {
    throw new Error('Artifact Viewer MCP Apps MIME type missing');
  }
  for (const snippet of [
    'callServerTool',
    'artifact_viewer_read',
    'Loading artifact',
    'widgetState',
    'setWidgetState',
    'toolResponseMetadata',
    'openai:set_globals',
    'currentFileObjectUrl',
    'image-preview',
  ]) {
    if (!viewerHtml.includes(snippet)) throw new Error(`Artifact Viewer missing ${snippet}`);
  }
  if (viewerHtml.includes('await app.readServerResource')) {
    throw new Error('Artifact Viewer v12 should not call resources/read from the app');
  }
  for (const forbidden of ['artifact_viewer_resolve', 'Make visible to model']) {
    if (viewerHtml.includes(forbidden)) throw new Error(`Artifact Viewer v12 still contains unsafe/obsolete path: ${forbidden}`);
  }
  for (const forbidden of [
    'downloadCurrentArtifact',
    'Open original image in a new tab',
    "imageLink.target = '_blank'",
    'anchor.download =',
  ]) {
    if (viewerHtml.includes(forbidden)) throw new Error(`Artifact Viewer v12 still contains iframe-blob external action: ${forbidden}`);
  }
  const relayProbeTool = allTools.find((tool) => tool.name === 'artifact_viewer_relay_probe');
  if (relayProbeTool?._meta?.ui?.visibility?.[0] !== 'app') {
    throw new Error('Artifact Viewer relay probe tool should be app-only');
  }
  const relayProbeResult = await client.callTool({ name: 'artifact_viewer_relay_probe', arguments: {} });
  const relayProbeText = relayProbeResult.content?.find((item) => item.type === 'text')?.text ?? '';
  if (relayProbeText !== 'artifact-viewer-tool-relay-ok') {
    throw new Error('Artifact Viewer tool relay probe handler failed');
  }

  const artifactReadTool = allTools.find((tool) => tool.name === 'artifact_viewer_read');
  if (artifactReadTool?._meta?.ui?.visibility?.[0] !== 'app') {
    throw new Error('artifact_viewer_read should be app-only');
  }
  if (names.includes('artifact_viewer_resolve')) {
    throw new Error('Unsafe request-id artifact resolver should not be registered');
  }

  if (viewerHtml.includes('pikacss-small.jpg')) {
    throw new Error('Artifact Viewer still contains the screenshot POC fixture');
  }
  const viewerScript = viewerHtml.match(/<script type="module">([\s\S]*)<\/script>/)?.[1];
  if (!viewerScript) throw new Error('Artifact Viewer module script missing');
  await fs.writeFile(viewerScriptPath, viewerScript, 'utf8');
  await execFileAsync(node, ['--check', viewerScriptPath]);

  const presented = await client.callTool({
    name: 'present_file',
    arguments: { path: presentFilePath, name: 'smoke.txt' },
  });
  const textArtifact = presented._meta?.[artifactMetaKey];
  if (!textArtifact?.uri?.startsWith('artifact://agent-vm/art-')) {
    throw new Error('present_file artifact metadata missing');
  }
  if (textArtifact.name !== 'smoke.txt' || textArtifact.mimeType !== 'text/plain') {
    throw new Error('present_file artifact metadata incorrect');
  }
  if (JSON.stringify(textArtifact).includes(presentFilePath)) {
    throw new Error('present_file leaked VM filesystem path');
  }
  const embeddedText = presented.content?.find((item) => item.type === 'resource')?.resource?.text;
  if (!embeddedText?.includes('artifact smoke text')) {
    throw new Error('present_file did not expose small text content to the model');
  }
  const textResource = await client.readResource({ uri: textArtifact.uri });
  if (textResource.contents?.[0]?.text !== 'artifact smoke text\nline two\n') {
    throw new Error('Text artifact resource round-trip failed');
  }

  const textToolRead = await client.callTool({
    name: 'artifact_viewer_read',
    arguments: { uri: textArtifact.uri },
  });
  const textToolResource = textToolRead.content?.find((item) => item.type === 'resource')?.resource;
  if (textToolResource?.text !== 'artifact smoke text\nline two\n') {
    throw new Error('Text artifact tool relay round-trip failed');
  }

  const commandInfo = await client.callTool({
    name: 'command_info',
    arguments: { names: ['git', 'pnpm', 'definitely-not-an-agent-command'] },
  });
  const commandInfoText = commandInfo.content?.find((item) => item.type === 'text')?.text ?? '';
  const inspectedCommands = JSON.parse(commandInfoText).commands;
  const git = inspectedCommands.find((command) => command.name === 'git');
  const pnpm = inspectedCommands.find((command) => command.name === 'pnpm');
  const missing = inspectedCommands.find((command) => command.name === 'definitely-not-an-agent-command');
  if (!git?.available || !git.curated || !git.version) throw new Error('git command_info failed');
  if (!pnpm?.available || !pnpm.curated || !pnpm.version) throw new Error('pnpm command_info failed');
  if (missing?.available || missing?.curated) throw new Error('missing command_info failed');

  const capabilities = await client.callTool({ name: 'capabilities', arguments: {} });
  const capabilitiesText = capabilities.content?.find((item) => item.type === 'text')?.text ?? '';
  const capabilityData = JSON.parse(capabilitiesText);
  if (!capabilityData.execution?.persistentProcesses) throw new Error('persistent process capability missing');
  if (!capabilityData.mcp?.nativeTools?.includes('present_file')) throw new Error('present_file capability missing');
  if (!capabilityData.runtimes?.some((runtime) => runtime.name === 'node' && runtime.available)) {
    throw new Error('node runtime capability missing');
  }

  const status = await client.callTool({ name: 'mcp_bridge_status', arguments: {} });
  const statusText = status.content?.find((item) => item.type === 'text')?.text ?? '';
  const parsed = JSON.parse(statusText);
  const playwright = parsed.bridges.find((bridge) => bridge.id === 'playwright');
  if (playwright?.state !== 'connected') throw new Error('Playwright bridge not connected');

  const navigate = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  });
  const navText = navigate.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
  if (!navText.includes('Example Domain')) throw new Error('browser_navigate smoke failed');

  const screenshot = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: { type: 'png', scale: 'css' },
  });
  if (screenshot.isError) throw new Error('browser_take_screenshot smoke returned an error');
  const screenshotArtifact = screenshot._meta?.[artifactMetaKey];
  if (!screenshotArtifact?.uri?.startsWith('artifact://agent-vm/art-')) {
    throw new Error('browser_take_screenshot artifact metadata missing');
  }
  if (!screenshotArtifact.name.endsWith('.png') || screenshotArtifact.mimeType !== 'image/png') {
    throw new Error('browser_take_screenshot artifact metadata incorrect');
  }
  const sameTurnImage = screenshot.content?.find((item) => item.type === 'image');
  if (sameTurnImage?.mimeType !== 'image/png' || !sameTurnImage.data?.startsWith('iVBORw0KGgo')) {
    throw new Error('browser_take_screenshot did not expose standard MCP image content');
  }
  const artifactLink = screenshot.content?.find((item) => item.type === 'resource_link');
  if (
    artifactLink?.uri !== screenshotArtifact.uri ||
    artifactLink?.name !== screenshotArtifact.name ||
    artifactLink?.mimeType !== screenshotArtifact.mimeType ||
    artifactLink?.size !== screenshotArtifact.size
  ) {
    throw new Error('browser_take_screenshot did not expose matching MCP resource_link content');
  }
  const screenshotResource = await client.readResource({ uri: screenshotArtifact.uri });
  const pngBlob = screenshotResource.contents?.[0]?.blob ?? '';
  if (!pngBlob.startsWith('iVBORw0KGgo')) {
    throw new Error('Screenshot artifact binary round-trip failed');
  }

  const screenshotToolRead = await client.callTool({
    name: 'artifact_viewer_read',
    arguments: { uri: screenshotArtifact.uri },
  });
  const screenshotToolResource = screenshotToolRead.content?.find((item) => item.type === 'resource')?.resource;
  if (!screenshotToolResource?.blob?.startsWith('iVBORw0KGgo')) {
    throw new Error('Screenshot artifact tool relay round-trip failed');
  }

  const explicitScreenshot = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: { filename: 'smoke-explicit.webp', type: 'webp', scale: 'css' },
  });
  const explicitArtifact = explicitScreenshot._meta?.[artifactMetaKey];
  if (explicitArtifact?.name !== 'smoke-explicit.webp' || explicitArtifact.mimeType !== 'image/webp') {
    throw new Error('Explicit screenshot filename adapter failed');
  }
  const explicitResource = await client.readResource({ uri: explicitArtifact.uri });
  if (!(explicitResource.contents?.[0]?.blob?.length > 100)) {
    throw new Error('Explicit screenshot artifact resource missing');
  }

  const started = await client.callTool({
    name: 'process_start',
    arguments: { command: "read line; echo got:$line; sleep 30" },
  });
  const startedText = started.content?.find((item) => item.type === 'text')?.text ?? '';
  const processId = JSON.parse(startedText).processId;
  await client.callTool({
    name: 'process_write',
    arguments: { processId, input: 'hello', appendNewline: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const read = await client.callTool({
    name: 'process_read',
    arguments: { processId },
  });
  const readText = read.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!JSON.parse(readText).stdout.text.includes('got:hello')) {
    throw new Error('persistent process smoke failed');
  }
  await client.callTool({
    name: 'process_kill',
    arguments: { processId, signal: 'SIGTERM' },
  });

  console.log(
    `PASS tools=${names.length} playwrightForwarded=${playwright.tools.length} artifact=${screenshotArtifact.name}`,
  );
} finally {
  await client.close();
  await fs.rm(presentFilePath, { force: true });
  await fs.rm(viewerScriptPath, { force: true });
}
