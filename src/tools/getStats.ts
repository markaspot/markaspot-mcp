import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { createApiClient } from '../utils/apiClient.js';
import {
  getJurisdictionApiKey,
  getTenant,
  getTenantDefaultJurisdiction,
  getTenantDefaultLang,
} from '../utils/tenantConfig.js';
import {
  resolveLang,
  acceptLanguageHeaders,
  resolveJurisdiction,
  requireJurisdiction,
} from '../utils/requestShaping.js';
import { logger } from '../utils/logger.js';

const DEFAULT_CATEGORY_LIMIT = 10;
const MAX_CATEGORY_LIMIT = 50;

const inputSchema = z.object({
  // status -> /stats.json (per-status counts); category -> /stats/categories.json
  // (per-category counts). status is the default situational overview.
  breakdown: z.enum(['status', 'category']).optional(),
  lang: z.string().optional(),
  // Caps the number of category rows returned (category breakdown only).
  limit: z.number().int().positive().optional(),
  jurisdiction_id: z.union([z.string(), z.number()]).transform(String).optional(),
  tenant: z.string().optional(),
  group_filter: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});

/**
 * Read-only ANSWER tool. Computes aggregates server-side over ALL matching
 * reports (true totals, not a sample), so the model never has to list and count
 * by hand. `breakdown=status` hits /georeport/v2/stats.json
 * (`{ total, stats: [{ status, count }] }`); `breakdown=category` hits
 * /georeport/v2/stats/categories.json (per-category counts). Supports
 * jurisdiction scoping and a reporting window. No personal data. Part of the
 * optional "reporting" toolset (staff analytics).
 *
 * Language note: only the category breakdown localizes its labels. The backend
 * translates category names (getCategoryStats) but returns status labels in the
 * default language regardless of Accept-Language, so `lang` is meaningful for
 * breakdown=category only.
 *
 * NOTE (verify in smoke test): the dashboard fetches these endpoints after admin
 * login, so they may require an elevated (staff) key on the backend. We prefer
 * the tenant staff key here; if rejected, the configured citizen/jurisdiction
 * key is the fallback.
 */
export const getStatsTool: Tool = {
  definition: {
    name: 'get_stats',
    description:
      'Read-only analytics: server-side aggregated report counts for a ' +
      'jurisdiction. breakdown="status" (default) gives a true total plus ' +
      'per-status counts; breakdown="category" gives per-category counts. Use ' +
      'this for analytical questions ("how many open reports?", "which category ' +
      'has the most?", status/category breakdowns); do NOT call list_requests and ' +
      'count by hand. Returns true totals (not a sample) and no personal data. ' +
      'Pass the user\'s conversation language as `lang` (ISO 639-1) to localize the ' +
      'CATEGORY labels when breakdown="category"; status labels are not localized.',
    inputSchema: {
      type: 'object',
      properties: {
        breakdown: {
          type: 'string',
          enum: ['status', 'category'],
          description: 'Aggregate by report status (default) or by service category.',
        },
        lang: { type: 'string', description: 'Conversation language (ISO 639-1, e.g. "de", "nl"). Localizes CATEGORY labels for breakdown="category"; status labels are not localized.' },
        limit: { type: 'number', description: `Max category rows (category breakdown only, default ${DEFAULT_CATEGORY_LIMIT}, max ${MAX_CATEGORY_LIMIT}).` },
        jurisdiction_id: { type: ['string', 'number'], description: 'Filter by jurisdiction/city' },
        tenant: { type: 'string', description: 'Tenant ID for multi-tenant setups (optional)' },
        group_filter: { type: 'string', description: 'Optional server-side filter group (as used by the dashboard)' },
        start_date: { type: 'string', format: 'date-time', description: 'Optional start of the reporting window' },
        end_date: { type: 'string', format: 'date-time', description: 'Optional end of the reporting window' },
      },
    },
  },
  handler: async (args: unknown) => {
    const {
      breakdown,
      lang,
      limit,
      jurisdiction_id,
      tenant,
      group_filter,
      start_date,
      end_date,
    } = inputSchema.parse(args || {});

    const resolvedJurisdiction = resolveJurisdiction(
      { jurisdiction_id },
      getTenantDefaultJurisdiction(tenant),
    );
    requireJurisdiction(resolvedJurisdiction);
    const resolvedLang = resolveLang(lang, getTenantDefaultLang(tenant));

    // The stats endpoints typically need an elevated key (the dashboard fetches
    // them after admin login), so prefer the tenant staff key, then a
    // jurisdiction-specific key, then the tenant default.
    const apiKeyOverride = getTenant(tenant).staffApiKey || getJurisdictionApiKey(resolvedJurisdiction);
    const client = createApiClient({ tenantId: tenant, apiKeyOverride });

    const byCategory = breakdown === 'category';
    const endpoint = byCategory
      ? '/georeport/v2/stats/categories.json'
      : '/georeport/v2/stats.json';

    const params: Record<string, unknown> = {};
    if (resolvedJurisdiction) params.jurisdiction_id = resolvedJurisdiction;
    if (group_filter) params.group_filter = group_filter;
    if (start_date) params.start_date = start_date;
    if (end_date) params.end_date = end_date;
    // Clamp the category page like list_requests so a staff token cannot pull
    // an unbounded category list.
    if (byCategory) params.limit = Math.min(limit ?? DEFAULT_CATEGORY_LIMIT, MAX_CATEGORY_LIMIT);

    const headers = acceptLanguageHeaders(resolvedLang);

    logger.info('Fetching stats', {
      breakdown: byCategory ? 'category' : 'status',
      jurisdiction_id: resolvedJurisdiction,
      group_filter,
      start_date,
      end_date,
      lang: resolvedLang,
    });
    const response = await client.get(endpoint, { params, headers });

    // Backend returns aggregated counts (server-side totals). status:
    // { total, stats: [{ status, count }] }; category: per-category counts.
    return {
      content: [
        { type: 'text', text: JSON.stringify(response.data, null, 2) },
      ],
    };
  },
};
