import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const node = '/home/agent/.local/share/pnpm/bin/node';
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
    'browser_navigate',
    'browser_snapshot',
  ];
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
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
  if (!capabilityData.mcp?.nativeTools?.includes('command_info')) throw new Error('native tool capability missing');
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

  console.log(`PASS tools=${names.length} playwrightForwarded=${playwright.tools.length}`);
} finally {
  await client.close();
}
