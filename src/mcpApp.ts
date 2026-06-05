// Shared MCP application wiring. The self-hosted Express server (src/server.ts)
// and the dev-only SSE server (src/index.ts) both go through handleMcp(), so the
// auth model, tool registry and dispatch behavior cannot diverge between the
// two transports.

import {
  listServicesTool,
  listRequestsTool,
  getRequestTool,
  createRequestTool,
  searchLocationTool,
  uploadImageTool,
  prepareUploadTool,
  checkUploadTool,
  updateRequestTool,
  addCommentTool,
  listTenantsTool,
  getStatsTool,
} from './tools/index.js';
import type { Tool } from './types/tool.js';
import type { UserContext } from './utils/userContext.js';
import { dispatchMcp } from './utils/mcpDispatch.js';
import type { JsonRpcResponse, JsonRpcId } from './utils/mcpDispatch.js';
import {
  toolsetForTool,
  isToolDeploymentEnabled,
  STAFF_TOOLSETS,
  JURISDICTION_TOOLS,
} from './toolsets.js';
import { getAllTenants } from './utils/tenantConfig.js';

const SERVER_INFO = { name: 'georeport-mcp', version: '0.2.0' };

// Single source of truth for the tool registry.
const toolRegistry = new Map<string, Tool>([
  ['list_services', listServicesTool],
  ['list_requests', listRequestsTool],
  ['get_request', getRequestTool],
  ['create_request', createRequestTool],
  ['search_location', searchLocationTool],
  ['upload_image', uploadImageTool],
  ['prepare_upload', prepareUploadTool],
  ['check_upload', checkUploadTool],
  ['update_request', updateRequestTool],
  ['add_comment', addCommentTool],
  ['list_tenants', listTenantsTool],
  ['get_stats', getStatsTool],
]);

/** Build the initialize instructions from tenant config and jurisdictions. */
function buildInstructions(): string {
  const tenants = getAllTenants();
  const tenantNames = tenants.map((t) => t.name).join(', ');

  let jurisdictionInfo = '';
  const jurisdictionsJson = process.env.JURISDICTIONS;
  if (jurisdictionsJson) {
    try {
      const jurisdictions = JSON.parse(jurisdictionsJson) as Array<{ id: string; name: string }>;
      jurisdictionInfo =
        ` Available jurisdictions (cities): ${jurisdictions.map((j) => `${j.name} (jurisdiction_id=${j.id})`).join(', ')}.` +
        ` Always pass the appropriate jurisdiction_id when calling list_services, list_requests, get_stats or create_request.`;
    } catch {
      /* ignore parse errors */
    }
  }

  return (
    `You are connected to the GeoReport MCP Bridge, a citizen reporting system based on the Open311/GeoReport v2 standard. ` +
    `Connected to: ${tenantNames}.${jurisdictionInfo} ` +
    `Use list_services to see report categories, list_requests to browse existing reports, ` +
    `create_request to file new reports (requires lat/long from search_location and a service_code from list_services). ` +
    `For photo attachments, use prepare_upload to generate a browser upload link (do NOT use upload_image in chat). ` +
    `Always call search_location first to get coordinates when a user mentions a location. ` +
    `Pass the user's conversation language as the \`lang\` parameter (ISO 639-1, e.g. "de", "nl") on every tool that accepts it, so categories, labels and status come back localized. ` +
    `For analytical questions (totals, "how many open per category?", status or category breakdowns) call get_stats; do NOT list_requests and count the rows by hand. ` +
    `list_requests is a browse tool: it returns a slim, paginated list (default 20, max 50); page with the returned cursor and use get_request for full detail.`
  );
}

/** Extract a Bearer token from an Authorization header value. */
export function extractBearerToken(authorization?: string | string[]): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return undefined;
}

/**
 * Handle a single JSON-RPC request through the shared dispatch (auth gate,
 * default-deny, tenant + jurisdiction pinning, toolset scoping). Returns a
 * response object, or null for notifications.
 */
export async function handleMcp(
  method: string,
  params: unknown,
  id: JsonRpcId,
  userContext: UserContext,
): Promise<JsonRpcResponse | null> {
  return dispatchMcp(method, params, id, userContext, {
    registry: toolRegistry,
    serverInfo: SERVER_INFO,
    buildInstructions,
    toolsetForTool,
    isToolDeploymentEnabled,
    staffToolsets: STAFF_TOOLSETS,
    jurisdictionTools: JURISDICTION_TOOLS,
  });
}

export { toolRegistry, SERVER_INFO };
