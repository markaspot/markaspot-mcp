import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { createApiClient } from '../utils/apiClient.js';
import { getJurisdictionApiKey, getTenantDefaultJurisdiction, getTenantDefaultLang, getTenantFrontendBaseUrl } from '../utils/tenantConfig.js';
import {
  resolveLang,
  acceptLanguageHeaders,
  resolveJurisdiction,
  requireJurisdiction,
  slimRequestList,
} from '../utils/requestShaping.js';
import { transformMediaUrls } from '../utils/mediaUrl.js';
import { logger } from '../utils/logger.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const inputSchema = z.object({
  status: z.enum(['open', 'closed', 'in_process']).optional(),
  service_code: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  lat: z.number().optional(),
  long: z.number().optional(),
  radius: z.number().optional(),
  // Conversation language (ISO 639-1) -> Accept-Language for localized taxonomy.
  lang: z.string().optional(),
  // Bounded page size. Default small; clamp hard so the model cannot pull the
  // whole 134-row backend default in one response.
  limit: z.number().int().positive().optional(),
  // Opaque cursor from a previous page's meta.next_cursor.
  cursor: z.string().optional(),
  tenant: z.string().optional(),
  // Forgiving: accept string or number, coerce to string.
  jurisdiction_id: z.union([z.string(), z.number()]).transform(String).optional(),
});

export const listRequestsTool: Tool = {
  definition: {
    name: 'list_requests',
    description:
      'Browse a few recent service requests (reports). Returns a SLIM list (id, ' +
      'title, status, service code/name, datetime, lat/long) with pagination, not ' +
      'full detail. Defaults to 20 results (max 50); page with the returned ' +
      'cursor. This is a BROWSE tool: for analytical questions ("how many open ' +
      'per category?", totals, breakdowns) use get_stats instead of listing and ' +
      'counting by hand. Pass the user\'s conversation language as `lang` (ISO ' +
      '639-1) for localized labels. Use jurisdiction_id to scope to a city; if the ' +
      'deployment serves several and none is pinned, you must supply one. Call ' +
      'get_request for the full detail of a single report.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed', 'in_process'] },
        service_code: { type: 'string', description: 'Filter by service/category code' },
        start_date: { type: 'string', format: 'date-time' },
        end_date: { type: 'string', format: 'date-time' },
        lat: { type: 'number' },
        long: { type: 'number' },
        radius: { type: 'number' },
        lang: { type: 'string', description: 'Conversation language (ISO 639-1, e.g. "de", "nl"). Localizes labels/status.' },
        limit: { type: 'number', description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response\'s meta.next_cursor.' },
        tenant: { type: 'string', description: 'Tenant ID for multi-tenant setups (optional)' },
        jurisdiction_id: { type: ['string', 'number'], description: 'Filter by jurisdiction/city (e.g. "1" for Amsterdam)' },
      },
    },
  },
  handler: async (args: unknown) => {
    try {
      const { tenant, jurisdiction_id, lang, limit, cursor, ...filters } = inputSchema.parse(args || {});

      // Forgiving jurisdiction: dispatch may already have pinned it; otherwise
      // fall back to a per-tenant default. May still be undefined (single
      // backend without multi-jurisdiction), which is fine for list_requests.
      const resolvedJurisdiction = resolveJurisdiction(
        { jurisdiction_id },
        getTenantDefaultJurisdiction(tenant),
      );
      // Teaching error (not a raw 400) when several jurisdictions are served and
      // none was resolved.
      requireJurisdiction(resolvedJurisdiction);
      const resolvedLang = resolveLang(lang, getTenantDefaultLang(tenant));

      const apiKeyOverride = getJurisdictionApiKey(resolvedJurisdiction);
      const client = createApiClient({ tenantId: tenant, apiKeyOverride });

      // Always cap the page and request meta: the backend default is 100, and
      // without meta we get no total/cursor to paginate with.
      const clampedLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const params: Record<string, unknown> = {
        ...filters,
        meta: 'true',
        limit: clampedLimit,
      };
      if (resolvedJurisdiction) params.jurisdiction_id = resolvedJurisdiction;
      if (cursor) params.cursor = cursor;

      const headers = acceptLanguageHeaders(resolvedLang);

      logger.info('Fetching requests from GeoReport v2 API', {
        jurisdiction_id: resolvedJurisdiction,
        limit: clampedLimit,
        has_cursor: !!cursor,
        lang: resolvedLang,
      });
      const response = await client.get('/georeport/v2/requests.json', { params, headers });

      // Rewrite media URLs to the public frontend image proxy BEFORE slimming,
      // so the slim list carries a loadable thumbnail (no-op when unconfigured).
      transformMediaUrls(response.data, getTenantFrontendBaseUrl(tenant));

      // Slim + paginate. Drupal internals and extended_attributes are dropped;
      // a note tells the model how much it is seeing and how to continue.
      const slim = slimRequestList(response.data);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(slim, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Error fetching requests', error);
      throw error;
    }
  },
};
