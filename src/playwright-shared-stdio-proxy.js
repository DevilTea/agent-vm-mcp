import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { McpBridgeManager } from './mcp-bridge.js';
import { resolveConfigPath } from './config-path.js';

async function createServer() {
  const server = new McpServer({
    name: 'playwright-shared-stdio-proxy',
    version: '1.0.0',
  });
  const configPath = await resolveConfigPath({
    filename: 'playwright-shared-proxy.json',
    envName: 'PLAYWRIGHT_SHARED_PROXY_CONFIG',
  });
  const bridgeManager = new McpBridgeManager({
    server,
    reservedToolNames: new Set(),
    configPath,
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
