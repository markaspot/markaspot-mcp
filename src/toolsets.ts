// Toolsets group tools so an operator can optionally expose them per deployment.
// This keeps the dispatch product-agnostic: the registry defines which tools
// EXIST, the toolset config defines which are SWITCHED ON. A different product
// (e.g. beantragt.ai) ships its own toolset map and tools; the dispatch engine
// and auth model stay the same.
//
// Toolsets are cut by FUNCTION, not by persona:
//   read       browse: list_services, list_requests, get_request, search_location
//   intake     self-service + on-behalf: create_request + upload helpers
//   manage     staff write/admin: update_request, add_comment, list_tenants
//   reporting  staff analytics: get_stats
// read + intake are the baseline for any valid token; role:staff additionally
// unlocks manage + reporting. Personas are composed from these (see
// TOOLSET_ALIASES) so the old citizen/staff persona labels still resolve.

import { logger } from './utils/logger.js';

export type ToolsetId = 'read' | 'intake' | 'manage' | 'reporting';

export const ALL_TOOLSETS: ToolsetId[] = ['read', 'intake', 'manage', 'reporting'];

// Tool name -> toolset. A tool not listed defaults to 'read' (the safe baseline).
const TOOL_TOOLSET: Record<string, ToolsetId> = {
  // read: browse-only, available to any authenticated token.
  list_services: 'read',
  list_requests: 'read',
  get_request: 'read',
  search_location: 'read',
  // intake: filing reports (citizen self-service AND staff on-behalf, e.g. a
  // call-center agent), plus the photo-upload helpers that feed create_request.
  create_request: 'intake',
  prepare_upload: 'intake',
  upload_image: 'intake',
  check_upload: 'intake',
  // manage: staff write/admin. update_request/add_comment alter other people's
  // reports; list_tenants enumerates every configured tenant (id, name,
  // has_staff_key), so none of these belong in a public baseline.
  update_request: 'manage',
  add_comment: 'manage',
  list_tenants: 'manage',
  // reporting: aggregate KPIs (answer-tool). Staff-only analytics.
  get_stats: 'reporting',
};

// Toolsets considered "staff" (privileged). Calling a tool in one of these
// requires role === 'staff'. read + intake stay open as the baseline; manage +
// reporting are the only real security boundary (alter other people's reports
// and see aggregate reporting).
export const STAFF_TOOLSETS = new Set<string>(['manage', 'reporting']);

// Tools that operate on jurisdiction-scoped data and accept a jurisdiction_id
// filter. The dispatch enforces jurisdiction pinning only for these (so a
// jurisdiction-scoped token must resolve to an allowed jurisdiction); tools not
// listed here are not jurisdiction-bound. NOTE: update_request/add_comment key
// off request_id and do NOT filter by jurisdiction, so jurisdiction-level
// isolation does not cover them; keep those token-scoped per tenant instead.
export const JURISDICTION_TOOLS = new Set<string>([
  'list_services',
  'list_requests',
  'get_request',
  'create_request',
  'get_stats',
]);

export function toolsetForTool(name: string): ToolsetId {
  return TOOL_TOOLSET[name] ?? 'read';
}

// --- Backward compatibility: persona aliases ---
// The previous model exposed citizen/staff personas. Existing token
// and deployment config still uses those names, so we keep them as aliases that
// expand to the canonical functional toolsets. New config should prefer the
// canonical IDs directly.
export const TOOLSET_ALIASES: Record<string, ToolsetId[]> = {
  citizen: ['read', 'intake'],
  staff: ['read', 'intake', 'manage', 'reporting'],
};

const CANONICAL = new Set<string>(ALL_TOOLSETS);

/**
 * Normalize a loose list of toolset names (canonical IDs and/or persona
 * aliases, any casing tolerated at the edge) into the canonical set. Canonical
 * IDs pass through; aliases expand; anything unknown is discarded so a stray
 * value can never widen access.
 */
export function expandToolsets(ids: string[]): Set<ToolsetId> {
  const out = new Set<ToolsetId>();
  for (const raw of ids) {
    const id = raw.trim();
    if (CANONICAL.has(id)) {
      out.add(id as ToolsetId);
      continue;
    }
    const alias = TOOLSET_ALIASES[id];
    if (Array.isArray(alias)) {
      for (const t of alias) out.add(t);
    }
    // unknown -> dropped
  }
  return out;
}

/**
 * The subset of `ids` that are neither canonical toolset IDs nor known persona
 * aliases, i.e. the values expandToolsets() silently drops. Used at config-load
 * time to warn operators about typos or removed aliases (e.g. a legacy alias
 * that no longer resolves) instead of failing silently.
 */
export function unknownToolsets(ids: string[]): string[] {
  return ids
    .map((s) => s.trim())
    .filter((id) => id.length > 0 && !CANONICAL.has(id) && !Array.isArray(TOOLSET_ALIASES[id]));
}

/**
 * Toolsets enabled for this deployment, from ENABLED_TOOLSETS (comma-separated).
 * Accepts both the canonical IDs (read/intake/manage/reporting) and the legacy
 * persona aliases (citizen/staff), normalizing to canonical. When
 * nothing valid is configured, defaults to the read+intake baseline so a public
 * bridge does not expose manage/reporting unless the operator switches them on.
 */
let enabledCache: Set<ToolsetId> | null = null;

export function enabledToolsets(): Set<ToolsetId> {
  if (enabledCache) return enabledCache;
  const raw = process.env.ENABLED_TOOLSETS;
  if (raw) {
    const ids = raw.split(',');
    const unknown = unknownToolsets(ids);
    if (unknown.length) {
      logger.warn(
        `ENABLED_TOOLSETS contains unrecognized toolset id(s) (ignored): ${unknown.join(', ')}. ` +
          `Valid ids: read, intake, manage, reporting.`,
      );
    }
    const expanded = expandToolsets(ids);
    enabledCache = expanded.size > 0 ? expanded : new Set<ToolsetId>(['read', 'intake']);
  } else {
    enabledCache = new Set<ToolsetId>(['read', 'intake']);
  }
  return enabledCache;
}

export function resetToolsetCache(): void {
  enabledCache = null;
}

/** Is this tool exposed by the current deployment's enabled toolsets? */
export function isToolDeploymentEnabled(name: string): boolean {
  return enabledToolsets().has(toolsetForTool(name));
}
