import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { McpBridgeManager } from './mcp-bridge.js';

const DEFAULT_CONFIG_PATH = '/opt/agent-mcp/config/playwright-shared-proxy.json';

async function createServer() {
  const server = new McpServer({
    name: 'playwright-shared-stdio-proxy',
    version: '1.0.0',
  });
  const bridgeManager = new McpBridgeManager({
    server,
    reservedToolNames: new Set(),
    configPath: process.env.PLAYWRIGHT_SHARED_PROXY_CONFIG ?? DEFAULT_CONFIG_PATH,
  });

  await bridgeManager.initialize();

  const originalClose = server.close.bind(server);
  let closed = false;
  server.close = async () => {
    if (closed) return;
    closed = true;
    await bridgeManager.close();
    await originalClose();
  };

  return server;
}

void serveStdio(createServer);
console.error('Playwright shared stdio proxy running');
