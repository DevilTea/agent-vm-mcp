import { McpServer, Server } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const mode = process.argv[2] ?? 'normal';

if (mode === 'list-failure') {
  const server = new Server(
    { name: 'bridge-list-failure-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', async () => {
    throw new Error('synthetic listTools failure');
  });
  await server.connect(new StdioServerTransport());
} else {
  void serveStdio(() => {
    const server = new McpServer({ name: 'bridge-fixture', version: '1.0.0' });
    for (const name of ['one', 'two']) {
      server.registerTool(
        name,
        { inputSchema: z.object({ value: z.string().optional() }) },
        async ({ value }) => ({ content: [{ type: 'text', text: `${name}:${value ?? ''}` }] }),
      );
    }
    return server;
  });
}
