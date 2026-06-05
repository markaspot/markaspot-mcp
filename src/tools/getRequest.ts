import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { createApiClient } from '../utils/apiClient.js';
import { getJurisdictionApiKey, getTenantDefaultJurisdiction, getTenantDefaultLang, getTenantFrontendBaseUrl } from '../utils/tenantConfig.js';
import { resolveLang, acceptLanguageHeaders, resolveJurisdiction, requireJurisdiction } from '../utils/requestShaping.js';
import { transformMediaUrls } from '../utils/mediaUrl.js';
import { maskSensitiveData } from '../utils/maskSensitiveData.js';
import { logger } from '../utils/logger.js';

const inputSchema = z.object({
  // Interpolated into the URL path, so restrict to path-safe characters to
  // prevent query/path/traversal injection (no / ? # or whitespace).
  request_id: z.string().regex(/^[A-Za-z0-9._-]+$/, 'invalid request_id'),
  tenant: z.string().optional(),
  lang: z.string().optional(),
  jurisdiction_id: z.union([z.string(), z.number()]).transform(String).optional(),
});

export const getRequestTool: Tool = {
  definition: {
    name: 'get_request',
    description:
      'Get the full detail of a single service request by its ID. Use this after ' +
      'list_requests (which returns a slim list) when the user wants everything ' +
      'about one report. Pass the user\'s conversation language as `lang` (ISO ' +
      '639-1) for localized status/labels. On multi-jurisdiction backends, pass ' +
      'jurisdiction_id (it is resolved from the token/tenant default when omitted).',
    inputSchema: {
      type: 'object',
      required: ['request_id'],
      properties: {
        request_id: { type: 'string', description: 'The ID of the service request' },
        tenant: { type: 'string', description: 'Tenant ID for multi-tenant setups (optional)' },
        lang: { type: 'string', description: 'Conversation language (ISO 639-1, e.g. "de", "nl") for localized labels.' },
        jurisdiction_id: { type: ['string', 'number'], description: 'Jurisdiction/city ID (optional)' },
      },
    },
  },
  handler: async (args: unknown) => {
    try {
      const { request_id, tenant, lang, jurisdiction_id } = inputSchema.parse(args);
      const resolvedJurisdiction = resolveJurisdiction(
        { jurisdiction_id },
        getTenantDefaultJurisdiction(tenant),
      );
      requireJurisdiction(resolvedJurisdiction);
      const resolvedLang = resolveLang(lang, getTenantDefaultLang(tenant));

      const apiKeyOverride = getJurisdictionApiKey(resolvedJurisdiction);
      const client = createApiClient({ tenantId: tenant, apiKeyOverride });

      // Multi-jurisdiction backends require jurisdiction_id as a query param,
      // same as list_requests. Without it the API returns 400.
      const params: Record<string, string> = {};
      if (resolvedJurisdiction) params.jurisdiction_id = resolvedJurisdiction;
      const headers = acceptLanguageHeaders(resolvedLang);

      logger.info('Fetching request details', { request_id, jurisdiction_id: resolvedJurisdiction, lang: resolvedLang });
      const response = await client.get(`/georeport/v2/requests/${request_id}.json`, { params, headers });

      // Rewrite raw backend media_url (internal host) to the public frontend
      // image proxy so MCP consumers can actually load the image. No-op when no
      // frontend base URL is configured for this tenant.
      const data = transformMediaUrls(response.data, getTenantFrontendBaseUrl(tenant));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(maskSensitiveData(data), null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Error fetching request details', error);
      throw error;
    }
  },
};
