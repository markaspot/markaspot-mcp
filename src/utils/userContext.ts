import { timingSafeEqual } from 'crypto';
import { logger } from './logger.js';
import { getAllTenants } from './tenantConfig.js';
import { expandToolsets, unknownToolsets } from '../toolsets.js';
import type { ToolsetId } from '../toolsets.js';

export type Role = 'citizen' | 'staff';

/**
 * A configured MCP user (entry in MCP_AUTH_USERS). The token is pinned to a
 * tenant and, for shared multi-jurisdiction backends, optionally to specific
 * jurisdictions, so one customer's token cannot reach another customer's data.
 */
interface McpUser {
  mcpToken: string;
  name: string;
  tenant?: string;
  role?: Role;
  allowedJurisdictions?: string[];
  // Tolerant at the read edge: tokens may carry canonical toolset IDs
  // (read/intake/manage/reporting) OR legacy persona aliases
  // (citizen/staff). resolveUser() normalizes to canonical.
  allowedToolsets?: string[];
}

export interface UserContext {
  authenticated: boolean;
  name?: string;
  tenant?: string;
  role?: Role;
  allowedJurisdictions?: string[];
  allowedToolsets?: ToolsetId[];
}

let userRegistry: McpUser[] | null = null;

function loadUsers(): McpUser[] {
  if (userRegistry !== null) return userRegistry;

  const usersJson = process.env.MCP_AUTH_USERS;
  if (usersJson) {
    try {
      const parsed = JSON.parse(usersJson);
      if (Array.isArray(parsed)) {
        userRegistry = parsed as McpUser[];
        for (const u of userRegistry) {
          if (u.allowedToolsets?.length) {
            const unknown = unknownToolsets(u.allowedToolsets);
            if (unknown.length) {
              logger.warn(
                `MCP token "${u.name ?? '?'}" lists unrecognized toolset id(s) (ignored): ` +
                  `${unknown.join(', ')}. If this leaves no valid toolset, the token has NO tool access.`,
              );
            }
          }
        }
        logger.info(`Loaded ${userRegistry.length} MCP auth user(s)`);
        return userRegistry;
      }
      logger.error('MCP_AUTH_USERS is not a JSON array; ignoring');
    } catch (e) {
      logger.error('Failed to parse MCP_AUTH_USERS', e);
    }
  }

  userRegistry = [];
  return userRegistry;
}

/** Reset cached registry (for testing or dynamic reload). */
export function resetUserRegistry(): void {
  userRegistry = null;
}

/** Constant-time comparison to avoid leaking token contents via timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True if any authentication is configured at all. When false, the dispatch
 * applies default-deny: no tool call is allowed. Fail closed, not open.
 */
export function isAuthConfigured(): boolean {
  return loadUsers().length > 0 || !!process.env.MCP_AUTH_TOKEN;
}

/**
 * Resolve a Bearer token to a user context. A missing or unknown token yields
 * `{ authenticated: false }`. A matching MCP_AUTH_USERS entry carries the
 * tenant/role/jurisdiction/toolset scope. The legacy single MCP_AUTH_TOKEN
 * authenticates as an unscoped operator (staff, no tenant pin); it should only
 * be used on single-tenant Enterprise bridges, never on a shared SaaS bridge.
 */
export function resolveUser(bearerToken?: string): UserContext {
  if (!bearerToken) return { authenticated: false };

  for (const u of loadUsers()) {
    if (safeEqual(u.mcpToken, bearerToken)) {
      return {
        authenticated: true,
        name: u.name,
        tenant: u.tenant,
        // Require an explicit role: the staff backend key is configured per
        // tenant (GEOREPORT_STAFF_API_KEY / TENANTS_CONFIG.staffApiKey), never
        // per token, so nothing here auto-promotes a token to 'staff'.
        role: u.role ?? 'citizen',
        allowedJurisdictions: u.allowedJurisdictions,
        // Normalize to canonical toolset IDs so the dispatch never sees a
        // persona alias. Undefined stays undefined (unscoped = all toolsets);
        // an explicit list is expanded (aliases) and unknowns dropped.
        allowedToolsets: u.allowedToolsets
          ? Array.from(expandToolsets(u.allowedToolsets))
          : undefined,
      };
    }
  }

  // Legacy single token: unscoped operator (no tenant/jurisdiction pin). Only
  // safe on a single-tenant bridge; refuse it when multiple tenants exist so a
  // misconfigured multi-tenant deployment cannot expose every tenant's data.
  const legacy = process.env.MCP_AUTH_TOKEN;
  if (legacy && safeEqual(legacy, bearerToken)) {
    if (getAllTenants().length > 1) {
      logger.error('MCP_AUTH_TOKEN rejected on a multi-tenant bridge; use MCP_AUTH_USERS.');
      return { authenticated: false };
    }
    return { authenticated: true, role: 'staff' };
  }

  return { authenticated: false };
}
