import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { logger } from './utils/logger.js';
import {
  createRequestTool,
  getRequestTool,
  listRequestsTool,
  listServicesTool,
  searchLocationTool,
  prepareUploadTool,
  uploadImageTool,
  checkUploadTool,
  updateRequestTool,
  addCommentTool,
  listTenantsTool,
  getStatsTool,
} from './tools/index.js';
import { allResources, handleResourceRead } from './resources/index.js';
import { allPrompts, handleGetPrompt } from './prompts/index.js';

dotenv.config();

const PORT = process.env.MCP_SERVER_PORT || 3100;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// All tools in a single registry for DRY registration
const toolRegistry = new Map([
  ['list_services', listServicesTool],
  ['list_requests', listRequestsTool],
  ['get_request', getRequestTool],
  ['create_request', createRequestTool],
  ['search_location', searchLocationTool],
  ['prepare_upload', prepareUploadTool],
  ['upload_image', uploadImageTool],
  ['check_upload', checkUploadTool],
  ['update_request', updateRequestTool],
  ['add_comment', addCommentTool],
  ['list_tenants', listTenantsTool],
  ['get_stats', getStatsTool],
]);

// Initialize MCP Server
const server = new Server(
  {
    name: 'mcp-bridge-georeport',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Array.from(toolRegistry.values()).map(t => t.definition),
  };
});

// Register resource handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: allResources,
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  return await handleResourceRead(uri);
});

// Register prompt handlers
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: allPrompts,
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await handleGetPrompt(name, args);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const tool = toolRegistry.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Legacy SSE/dev transport: gate-everything at the connection level. The
    // /sse endpoint rejects connections without a valid MCP_AUTH_TOKEN, so when
    // a token is configured every call here comes from an authenticated
    // connection. Without it, refuse all tool calls (default-deny). Per-token
    // tenant/jurisdiction pinning is only available on the stateless path
    // (api/mcp.ts / src/server.ts).
    if (!process.env.MCP_AUTH_TOKEN) {
      throw new Error(
        `Tool '${name}' requires authentication. Set MCP_AUTH_TOKEN to enable tool access on this transport.`
      );
    }

    return await tool.handler(args);
  } catch (error) {
    logger.error(`Tool execution error: ${name}`, error);
    return {
      content: [
        {
          type: 'text',
          text: `Error executing tool ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
});

// Create Express app
const app = express();

// Add middleware
app.use(cors());
app.use(express.json());

// Set up health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'mcp-bridge-georeport',
    version: '0.2.0',
    timestamp: new Date().toISOString(),
  });
});

// Start MCP server with SSE transport
async function main() {
  // Map to store active SSE transports by session ID
  const transports = new Map<string, SSEServerTransport>();

  // Handle SSE connections
  app.get('/sse', async (req, res) => {
    // Optional: Check for authorization token from a remote MCP client
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.MCP_AUTH_TOKEN;

    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      logger.warn('Unauthorized SSE connection attempt');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    logger.info('SSE client connected');

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Create SSE transport with absolute URL for message endpoint
    const messageUrl = `${PUBLIC_URL}/message`;
    const transport = new SSEServerTransport(messageUrl, res);
    await transport.start();

    // Store transport by session ID
    transports.set(transport.sessionId, transport);

    // Connect to MCP server
    await server.connect(transport);
    logger.info(`MCP session started: ${transport.sessionId}`);

    // Clean up on disconnect
    req.on('close', () => {
      transports.delete(transport.sessionId);
      logger.info(`MCP session ended: ${transport.sessionId}`);
    });
  });

  // Handle POST messages
  app.post('/message', async (req, res) => {
    const sessionId = req.headers['x-session-id'] as string;

    if (!sessionId || !transports.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.handlePostMessage(req, res);
  });

  // Start the HTTP server
  const httpServer = app.listen(PORT, () => {
    logger.info(`MCP Bridge HTTP server listening on port ${PORT}`);
    logger.info(`SSE endpoint available at ${PUBLIC_URL}/sse`);
    logger.info(`Message endpoint available at ${PUBLIC_URL}/message`);
    logger.info(`For a remote MCP client, use this URL: ${PUBLIC_URL}/sse`);
  });
}

main().catch((error) => {
  logger.error('Failed to start MCP Bridge', error);
  process.exit(1);
});
