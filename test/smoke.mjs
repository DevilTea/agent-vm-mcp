import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const node = '/home/agent/.local/share/pnpm/bin/node';
const artifactMetaKey = 'io.deviltea.agent-vm/artifact';
const artifactViewerUri = 'ui://agent-vm/artifact-viewer-v12.html';
const presentFilePath = '/tmp/agent-mcp-present-file-smoke.txt';
const viewerScriptPath = '/tmp/agent-mcp-artifact-viewer-smoke.mjs';
const importedFilePath = '/tmp/agent-mcp-import-file-smoke.txt';
const cancelledImportPath = '/tmp/agent-mcp-import-file-cancelled.txt';
const execCancelPidPath = '/tmp/agent-mcp-exec-cancel.pid';
const execCancelMarkerPath = '/tmp/agent-mcp-exec-cancel.marker';
const shutdownProcessPidPath = '/tmp/agent-mcp-shutdown-process.pid';
const filesystemRoot = `/tmp/agent-mcp-filesystem-smoke-${process.pid}`;
const filesystemOutsideRoot = `/tmp/agent-mcp-filesystem-outside-${process.pid}`;
const gitShimDir = `/tmp/agent-mcp-git-shim-${process.pid}`;
const gitValidationTriggerPath = `/tmp/agent-mcp-git-validation-trigger-${process.pid}`;
const gitValidationPidPath = `/tmp/agent-mcp-git-validation-pid-${process.pid}`;
const importPayload = Buffer.from('file ingress smoke\n', 'utf8');
let importServer;
let clientClosed = false;
const execFileAsync = promisify(execFile);
const client = new Client({ name: 'agent-mcp-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: node,
  args: ['/opt/agent-mcp/src/index.js'],
  cwd: '/home/agent',
  env: {
    ...process.env,
    PATH: `${gitShimDir}:${process.env.PATH}`,
    MCP_BRIDGES_CONFIG: '/opt/agent-mcp/test/bridges.smoke.json',
  },
  stderr: 'inherit',
});

try {
  await fs.writeFile(presentFilePath, 'artifact smoke text\nline two\n', 'utf8');
  await fs.rm(importedFilePath, { force: true });
  await fs.rm(cancelledImportPath, { force: true });
  await fs.rm(execCancelPidPath, { force: true });
  await fs.rm(execCancelMarkerPath, { force: true });
  await fs.rm(shutdownProcessPidPath, { force: true });
  await fs.rm(filesystemRoot, { recursive: true, force: true });
  await fs.rm(filesystemOutsideRoot, { recursive: true, force: true });
  await fs.rm(gitShimDir, { recursive: true, force: true });
  await fs.rm(gitValidationTriggerPath, { force: true });
  await fs.rm(gitValidationPidPath, { force: true });
  await fs.mkdir(filesystemRoot, { recursive: true });
  await fs.mkdir(filesystemOutsideRoot, { recursive: true });
  await fs.mkdir(gitShimDir, { recursive: true });
  const gitShim = `#!/usr/bin/env bash
set -eu
checking=0
for arg in "$@"; do
  if [[ "$arg" == "--check" ]]; then checking=1; fi
done
if [[ "$checking" == "1" && -f "${gitValidationTriggerPath}" ]]; then
  echo $$ > "${gitValidationPidPath}"
  sleep 30
fi
exec /usr/bin/git "$@"
`;
  await fs.writeFile(`${gitShimDir}/git`, gitShim, { mode: 0o755 });
  await fs.mkdir(`${filesystemRoot}/subdir`);
  await fs.writeFile(`${filesystemRoot}/a.txt`, 'one\ntwo\nthree\n', 'utf8');
  await fs.writeFile(`${filesystemRoot}/.hidden`, 'hidden\n', 'utf8');
  await fs.writeFile(`${filesystemRoot}/binary.bin`, Buffer.from([0xff, 0xfe, 0xfd]));
  await fs.writeFile(
    `${filesystemRoot}/large.txt`,
    Array.from({ length: 400 }, (_, index) => `${String(index).padStart(4, '0')}:${'x'.repeat(1018)}\n`).join(''),
    'utf8',
  );
  await fs.writeFile(`${filesystemOutsideRoot}/outside.txt`, 'outside\n', 'utf8');
  await fs.symlink('a.txt', `${filesystemRoot}/link.txt`);
  await fs.symlink(filesystemOutsideRoot, `${filesystemRoot}/outside-link`);
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
    'read_file',
    'list_directory',
    'apply_patch',
    'import_file',
    'process_start',
    'process_list',
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

  const parseJsonToolResult = (result) => {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error('Expected JSON text tool result');
    return JSON.parse(text);
  };
  const expectToolFailure = async (name, argumentsValue, options) => {
    try {
      const result = await client.callTool({ name, arguments: argumentsValue }, options);
      if (result.isError) return;
    } catch {
      return;
    }
    throw new Error(`${name} unexpectedly succeeded`);
  };

  const rangedRead = parseJsonToolResult(
    await client.callTool({
      name: 'read_file',
      arguments: { path: 'a.txt', cwd: filesystemRoot, startLine: 2, endLine: 3 },
    }),
  );
  if (
    rangedRead.content !== 'two\nthree\n' ||
    rangedRead.startLine !== 2 ||
    rangedRead.endLine !== 3 ||
    rangedRead.totalLines !== 3 ||
    rangedRead.truncated
  ) {
    throw new Error('read_file ranged read metadata/content failed');
  }

  const largeRead = parseJsonToolResult(
    await client.callTool({
      name: 'read_file',
      arguments: { path: 'large.txt', cwd: filesystemRoot },
    }),
  );
  if (!largeRead.truncated || !Number.isSafeInteger(largeRead.nextLine) || largeRead.bytes > 256 * 1024) {
    throw new Error('read_file bounded response metadata failed');
  }
  await expectToolFailure('read_file', { path: 'binary.bin', cwd: filesystemRoot });
  await expectToolFailure('read_file', { path: 'subdir', cwd: filesystemRoot });

  const directory = parseJsonToolResult(
    await client.callTool({
      name: 'list_directory',
      arguments: { path: '.', cwd: filesystemRoot },
    }),
  );
  const expectedDirectoryEntries = [
    ['.hidden', 'file'],
    ['a.txt', 'file'],
    ['binary.bin', 'file'],
    ['large.txt', 'file'],
    ['link.txt', 'symlink'],
    ['outside-link', 'symlink'],
    ['subdir', 'directory'],
  ];
  if (
    JSON.stringify(directory.entries.map(({ name, type }) => [name, type])) !==
    JSON.stringify(expectedDirectoryEntries)
  ) {
    throw new Error('list_directory deterministic structured listing failed');
  }

  const exactPatch = `--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;
  const appliedPatch = parseJsonToolResult(
    await client.callTool({
      name: 'apply_patch',
      arguments: { patch: exactPatch, cwd: filesystemRoot },
    }),
  );
  if (
    (await fs.readFile(`${filesystemRoot}/a.txt`, 'utf8')) !== 'one\nTWO\nthree\n' ||
    appliedPatch.files.length !== 1 ||
    appliedPatch.files[0].path !== 'a.txt' ||
    appliedPatch.files[0].additions !== 1 ||
    appliedPatch.files[0].deletions !== 1
  ) {
    throw new Error('apply_patch exact patch failed');
  }

  await fs.writeFile(`${filesystemRoot}/offset.txt`, 'zero\none\ntwo\nthree\n', 'utf8');
  const offsetPatch = `--- a/offset.txt
+++ b/offset.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;
  await expectToolFailure('apply_patch', { patch: offsetPatch, cwd: filesystemRoot });
  if ((await fs.readFile(`${filesystemRoot}/offset.txt`, 'utf8')) !== 'zero\none\ntwo\nthree\n') {
    throw new Error('apply_patch offset mismatch modified target');
  }

  await fs.writeFile(`${filesystemRoot}/multi-a.txt`, 'a1\na2\n', 'utf8');
  await fs.writeFile(`${filesystemRoot}/multi-b.txt`, 'b1\nb2\n', 'utf8');
  const multiFailurePatch = `--- a/multi-a.txt
+++ b/multi-a.txt
@@ -1,2 +1,2 @@
 a1
-a2
+A2
--- a/multi-b.txt
+++ b/multi-b.txt
@@ -1,2 +1,2 @@
 WRONG
-b2
+B2
`;
  await expectToolFailure('apply_patch', { patch: multiFailurePatch, cwd: filesystemRoot });
  if (
    (await fs.readFile(`${filesystemRoot}/multi-a.txt`, 'utf8')) !== 'a1\na2\n' ||
    (await fs.readFile(`${filesystemRoot}/multi-b.txt`, 'utf8')) !== 'b1\nb2\n'
  ) {
    throw new Error('apply_patch multi-file failure was not zero-write');
  }

  await fs.writeFile(`${filesystemRoot}/delete.txt`, 'delete-me\n', 'utf8');
  const createDeletePatch = `--- /dev/null
+++ b/created.txt
@@ -0,0 +1 @@
+created
--- a/delete.txt
+++ /dev/null
@@ -1 +0,0 @@
-delete-me
`;
  await client.callTool({
    name: 'apply_patch',
    arguments: { patch: createDeletePatch, cwd: filesystemRoot },
  });
  if ((await fs.readFile(`${filesystemRoot}/created.txt`, 'utf8')) !== 'created\n') {
    throw new Error('apply_patch create failed');
  }
  try {
    await fs.access(`${filesystemRoot}/delete.txt`);
    throw new Error('apply_patch delete failed');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const traversalName = `agent-mcp-traversal-${process.pid}.txt`;
  const traversalPatch = `--- /dev/null
+++ b/../${traversalName}
@@ -0,0 +1 @@
+escape
`;
  await expectToolFailure('apply_patch', { patch: traversalPatch, cwd: filesystemRoot });
  try {
    await fs.access(`/tmp/${traversalName}`);
    throw new Error('apply_patch traversal escaped cwd');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const symlinkEscapePatch = `--- a/outside-link/outside.txt
+++ b/outside-link/outside.txt
@@ -1 +1 @@
-outside
+escaped
`;
  await expectToolFailure('apply_patch', { patch: symlinkEscapePatch, cwd: filesystemRoot });
  if ((await fs.readFile(`${filesystemOutsideRoot}/outside.txt`, 'utf8')) !== 'outside\n') {
    throw new Error('apply_patch followed a symlink outside cwd');
  }

  await fs.writeFile(`${filesystemRoot}/cancel.txt`, 'before\n', 'utf8');
  const cancellationPatch = `--- a/cancel.txt
+++ b/cancel.txt
@@ -1 +1 @@
-before
+after
`;
  await fs.writeFile(gitValidationTriggerPath, '1\n', 'utf8');
  const patchAbortController = new AbortController();
  const cancellablePatch = client.callTool(
    {
      name: 'apply_patch',
      arguments: { patch: cancellationPatch, cwd: filesystemRoot },
    },
    { signal: patchAbortController.signal },
  );
  let validationPid;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      validationPid = Number((await fs.readFile(gitValidationPidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(validationPid)) {
    throw new Error('apply_patch cancellation validation subprocess did not start');
  }
  patchAbortController.abort();
  let patchWasCancelled = false;
  try {
    await cancellablePatch;
  } catch {
    patchWasCancelled = true;
  }
  if (!patchWasCancelled) throw new Error('apply_patch cancellation did not reject the client call');
  await fs.rm(gitValidationTriggerPath, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if ((await fs.readFile(`${filesystemRoot}/cancel.txt`, 'utf8')) !== 'before\n') {
    throw new Error('apply_patch cancellation during validation mutated target');
  }

  const importFileTool = allTools.find((tool) => tool.name === 'import_file');
  if (importFileTool?._meta?.['openai/fileParams']?.[0] !== 'file') {
    throw new Error('import_file fileParams metadata missing');
  }

  importServer = http.createServer((request, response) => {
    if (request.url === '/fixture') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': String(importPayload.length),
      });
      response.end(importPayload);
      return;
    }

    if (request.url === '/slow-fixture') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      response.write(chunk);
      const timer = setInterval(() => response.write(chunk), 50);
      timer.unref();
      response.once('close', () => clearInterval(timer));
      return;
    }

    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    importServer.once('error', reject);
    importServer.listen(0, '127.0.0.1', resolve);
  });
  const importAddress = importServer.address();
  if (!importAddress || typeof importAddress === 'string') throw new Error('import_file smoke server failed to listen');
  const imported = await client.callTool({
    name: 'import_file',
    arguments: {
      file: {
        download_url: `http://127.0.0.1:${importAddress.port}/fixture`,
        file_id: 'file-smoke',
        mime_type: 'text/plain',
        file_name: 'fixture.txt',
      },
      destination: importedFilePath,
    },
  });
  const importedText = imported.content?.find((item) => item.type === 'text')?.text ?? '';
  const importedResult = JSON.parse(importedText);
  const expectedImportHash = createHash('sha256').update(importPayload).digest('hex');
  if (
    importedResult.path !== importedFilePath ||
    importedResult.bytes !== importPayload.length ||
    importedResult.sha256 !== expectedImportHash ||
    (await fs.readFile(importedFilePath, 'utf8')) !== importPayload.toString('utf8')
  ) {
    throw new Error('import_file smoke failed');
  }

  await fs.writeFile(cancelledImportPath, 'preserve-existing-destination\n', 'utf8');
  const importAbortController = new AbortController();
  const cancelledImport = client.callTool(
    {
      name: 'import_file',
      arguments: {
        file: {
          download_url: `http://127.0.0.1:${importAddress.port}/slow-fixture`,
          file_id: 'file-cancel-smoke',
          mime_type: 'application/octet-stream',
          file_name: 'cancel.bin',
        },
        destination: cancelledImportPath,
        overwrite: true,
      },
    },
    { signal: importAbortController.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 125));
  importAbortController.abort();
  let importWasCancelled = false;
  try {
    await cancelledImport;
  } catch {
    importWasCancelled = true;
  }
  if (!importWasCancelled) throw new Error('import_file cancellation did not reject the client call');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if ((await fs.readFile(cancelledImportPath, 'utf8')) !== 'preserve-existing-destination\n') {
    throw new Error('import_file cancellation modified the existing destination');
  }
  const cancelledImportTempPrefix = `.${cancelledImportPath.split('/').at(-1)}.import-`;
  if ((await fs.readdir('/tmp')).some((name) => name.startsWith(cancelledImportTempPrefix))) {
    throw new Error('import_file cancellation left a temporary file');
  }

  const timeoutExec = await client.callTool({
    name: 'exec',
    arguments: { command: 'sleep 5', timeoutMs: 1000 },
  });
  const timeoutExecText = timeoutExec.content?.find((item) => item.type === 'text')?.text ?? '';
  const timeoutExecResult = JSON.parse(timeoutExecText);
  if (!timeoutExecResult.timedOut || timeoutExecResult.cancelled) {
    throw new Error('exec timeout/cancellation diagnostics are incorrect');
  }

  const execAbortController = new AbortController();
  const cancellableExec = client.callTool(
    {
      name: 'exec',
      arguments: {
        command:
          `trap 'echo terminated > ${execCancelMarkerPath}; exit 0' TERM; ` +
          `echo $$ > ${execCancelPidPath}; while :; do sleep 1; done`,
        timeoutMs: 10_000,
      },
    },
    { signal: execAbortController.signal },
  );
  let execPid;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      execPid = Number((await fs.readFile(execCancelPidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(execPid)) throw new Error('exec cancellation command did not start');
  execAbortController.abort();
  let execWasCancelled = false;
  try {
    await cancellableExec;
  } catch {
    execWasCancelled = true;
  }
  if (!execWasCancelled) throw new Error('exec cancellation did not reject the client call');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.access(execCancelMarkerPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if ((await fs.readFile(execCancelMarkerPath, 'utf8')).trim() !== 'terminated') {
    throw new Error('exec cancellation did not terminate the process group');
  }
  try {
    process.kill(execPid, 0);
    throw new Error('exec cancellation left the shell process running');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
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
  const processList = await client.callTool({ name: 'process_list', arguments: {} });
  const processListText = processList.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!JSON.parse(processListText).processes.some((process) => process.processId === processId)) {
    throw new Error('process_list did not rediscover a managed process');
  }
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

  await client.callTool({
    name: 'process_start',
    arguments: {
      command: `trap '' TERM; echo $$ > ${shutdownProcessPidPath}; while :; do sleep 30; done`,
    },
  });
  let shutdownProcessPid;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      shutdownProcessPid = Number((await fs.readFile(shutdownProcessPidPath, 'utf8')).trim());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!Number.isSafeInteger(shutdownProcessPid)) {
    throw new Error('graceful shutdown smoke process did not start');
  }

  const serverPid = transport.pid;
  if (!Number.isSafeInteger(serverPid)) {
    throw new Error('MCP stdio server PID unavailable for graceful shutdown smoke');
  }

  const shutdownStartedAt = Date.now();
  process.kill(serverPid, 'SIGTERM');

  let managedProcessExited = false;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    try {
      process.kill(shutdownProcessPid, 0);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      managedProcessExited = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!managedProcessExited) {
    throw new Error('graceful shutdown left a managed process running');
  }
  if (Date.now() - shutdownStartedAt > 3_500) {
    throw new Error('managed-process graceful shutdown exceeded bounded TERM→KILL window');
  }

  let serverExited = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(serverPid, 0);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      serverExited = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!serverExited) throw new Error('MCP server did not exit after SIGTERM');

  await client.close();
  clientClosed = true;

  console.log(
    `PASS tools=${names.length} playwrightForwarded=${playwright.tools.length} artifact=${screenshotArtifact.name}`,
  );
} finally {
  if (!clientClosed) await client.close();
  await fs.rm(presentFilePath, { force: true });
  await fs.rm(viewerScriptPath, { force: true });
  await fs.rm(importedFilePath, { force: true });
  await fs.rm(cancelledImportPath, { force: true });
  await fs.rm(execCancelPidPath, { force: true });
  await fs.rm(execCancelMarkerPath, { force: true });
  await fs.rm(shutdownProcessPidPath, { force: true });
  await fs.rm(filesystemRoot, { recursive: true, force: true });
  await fs.rm(filesystemOutsideRoot, { recursive: true, force: true });
  await fs.rm(gitShimDir, { recursive: true, force: true });
  await fs.rm(gitValidationTriggerPath, { force: true });
  await fs.rm(gitValidationPidPath, { force: true });
  if (importServer) await new Promise((resolve) => importServer.close(resolve));
}
