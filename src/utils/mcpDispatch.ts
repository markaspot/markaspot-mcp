import type { Tool } from '../types/tool.js';
import type { UserContext } from './userContext.js';
import { isAuthConfigured } from './userContext.js';
import { maskSensitiveData } from './maskSensitiveData.js';
import { logger } from './logger.js';

// Product-agnostic MCP dispatch. It owns the security model (gate-everything,
// default-deny, tenant + jurisdiction pinning, toolset scoping) and returns
// plain JSON-RPC response objects, so any transport (stateless HTTP handler,
// Express, SSE) can adapt it. The product-specific bits (which tools exist,
// which toolset a tool belongs to, which are switched on) are injected, so the
// same engine serves Mark-a-Spot, CivicSpot and later beantragt.ai.

export type JsonRpcId = string | number | null | undefined;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface DispatchOptions {
  registry: Map<string, Tool>;
  serverInfo: { name: string; version: string };
  // Receives the caller's context so instructions can be scoped to it: on a
  // shared multi-tenant gateway the tenant registry is the customer list and
  // must not be enumerable through the (open) initialize handshake.
  buildInstructions: (ctx: UserContext) => string | Promise<string>;
  toolsetForTool: (name: string) => string;
  isToolDeploymentEnabled: (name: string) => boolean;
  staffToolsets: Set<string>;
  // Tools that operate on jurisdiction-scoped data and accept a jurisdiction_id
  // filter. For these, a jurisdiction-pinned token MUST resolve to an allowed
  // jurisdiction (see the pinning block below). Other tools (search_location,
  // list_tenants, upload helpers) are not jurisdiction-bound and are skipped.
  jurisdictionTools: Set<string>;
}

const AUTH_REQUIRED = -32001;
const FORBIDDEN = -32003;
const NOT_FOUND = -32601;
const SERVER_ERROR = -32000;

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Tools visible to a user: deployment-enabled AND within the user's toolset scope. */
function visibleTools(opts: DispatchOptions, ctx: UserContext): Tool[] {
  const allowed = ctx.allowedToolsets ? new Set<string>(ctx.allowedToolsets) : null;
  return Array.from(opts.registry.values()).filter((t) => {
    const name = t.definition.name;
    if (!opts.isToolDeploymentEnabled(name)) return false;
    if (allowed && !allowed.has(opts.toolsetForTool(name))) return false;
    return true;
  });
}

/**
 * Dispatch a single JSON-RPC request. Returns a response object, or null for
 * notifications (no reply expected).
 */
export async function dispatchMcp(
  method: string,
  params: any,
  id: JsonRpcId,
  ctx: UserContext,
  opts: DispatchOptions,
): Promise<JsonRpcResponse | null> {
  // Notifications (e.g. notifications/initialized) carry no reply.
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return null;
  }

  // initialize is open: the handshake must succeed before the client can send
  // its token. Instructions are therefore built from the caller's context:
  // unauthenticated handshakes get generic guidance only, tenant-pinned tokens
  // see their own tenant, never the full registry.
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: opts.serverInfo,
      instructions: await opts.buildInstructions(ctx),
    });
  }

  // Everything past here is gated. Default-deny when no auth is configured.
  if (!isAuthConfigured()) {
    return fail(id, AUTH_REQUIRED, 'Server has no authentication configured; tool access is disabled.');
  }
  if (!ctx.authenticated) {
    return fail(id, AUTH_REQUIRED, 'Authentication required. Provide a valid Bearer token.');
  }

  if (method === 'tools/list') {
    return ok(id, { tools: visibleTools(opts, ctx).map((t) => t.definition) });
  }

  // Some clients probe discovery methods even when initialize does not
  // advertise them. Keep these responses empty: the dev-only resource and
  // prompt modules do not enforce this dispatcher's tenant and auth scoping.
  if (method === 'resources/list') {
    return ok(id, { resources: [] });
  }
  if (method === 'resources/templates/list') {
    return ok(id, { resourceTemplates: [] });
  }
  if (method === 'prompts/list') {
    return ok(id, { prompts: [] });
  }

  if (method === 'tools/call') {
    const name: string = params?.name;
    const args: Record<string, any> = params?.arguments ?? {};

    const tool = opts.registry.get(name);
    if (!tool) return fail(id, NOT_FOUND, `Unknown tool: ${name}`);
    if (!opts.isToolDeploymentEnabled(name)) {
      return fail(id, NOT_FOUND, `Tool '${name}' is not enabled on this server.`);
    }

    const toolset = opts.toolsetForTool(name);
    if (ctx.allowedToolsets && !ctx.allowedToolsets.includes(toolset as any)) {
      return fail(id, FORBIDDEN, `Tool '${name}' is not permitted for this token.`);
    }
    if (opts.staffToolsets.has(toolset)) {
      if (ctx.role !== 'staff') {
        return fail(id, FORBIDDEN, `Tool '${name}' requires staff privileges.`);
      }
      // Staff write tools (update_request, add_comment) key off request_id and
      // carry no jurisdiction_id, so the bridge cannot confine them to a token's
      // allowed jurisdictions. Refuse jurisdiction-scoped tokens here: staff
      // writes belong on a single-tenant Enterprise bridge where the tenant pin
      // already isolates the backend.
      if (
        ctx.allowedJurisdictions &&
        ctx.allowedJurisdictions.length > 0 &&
        !opts.jurisdictionTools.has(name)
      ) {
        return fail(
          id,
          FORBIDDEN,
          `Tool '${name}' is not available to jurisdiction-scoped tokens; jurisdiction isolation cannot be enforced on request-id operations.`,
        );
      }
    }

    const enforced: Record<string, any> = { ...args };

    // Tenant pinning: a token bound to a tenant may not target another.
    if (ctx.tenant) {
      if (args.tenant && String(args.tenant) !== ctx.tenant) {
        return fail(id, FORBIDDEN, 'Access denied: token is bound to a different tenant.');
      }
      enforced.tenant = ctx.tenant;
    }

    // Jurisdiction pinning: restrict to the token's allowed jurisdictions.
    // Only enforced on tools that are actually jurisdiction-scoped, otherwise we
    // would wrongly reject tools that take no jurisdiction_id (search_location,
    // upload helpers, list_tenants).
    if (
      ctx.allowedJurisdictions &&
      ctx.allowedJurisdictions.length > 0 &&
      opts.jurisdictionTools.has(name)
    ) {
      const requested = args.jurisdiction_id ? String(args.jurisdiction_id) : undefined;
      if (requested) {
        if (!ctx.allowedJurisdictions.includes(requested)) {
          return fail(id, FORBIDDEN, 'Access denied: jurisdiction not allowed for this token.');
        }
        enforced.jurisdiction_id = requested;
      } else if (ctx.allowedJurisdictions.length === 1) {
        // Exactly one allowed jurisdiction: default to it.
        enforced.jurisdiction_id = ctx.allowedJurisdictions[0];
      } else {
        // Multiple allowed and none requested: do NOT fall through unfiltered
        // (that would leak every jurisdiction). Force the caller to choose.
        return fail(
          id,
          FORBIDDEN,
          `jurisdiction_id is required for this token; allowed: ${ctx.allowedJurisdictions.join(', ')}`,
        );
      }
    }

    try {
      const result = await tool.handler(enforced);
      return ok(id, result);
    } catch (e: any) {
      logger.error(`Tool execution error: ${name}`, e);
      const message = e?.response
        ? `API Error: ${e.response.status} ${e.response.statusText}. ${JSON.stringify(maskSensitiveData(e.response.data))}`
        : maskSensitiveData(e?.message ?? 'Unknown error');
      return fail(id, SERVER_ERROR, typeof message === 'string' ? message : 'Tool execution failed');
    }
  }

  // Other requests without an id are notifications.
  if (id === undefined || id === null) return null;

  return fail(id, NOT_FOUND, `Method not found: ${method}`);
}
