import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { createApiClient } from '../utils/apiClient.js';
import { getJurisdictionApiKey, getTenantDefaultJurisdiction, getTenantDefaultLang } from '../utils/tenantConfig.js';
import { resolveLang, acceptLanguageHeaders, resolveJurisdiction, requireJurisdiction } from '../utils/requestShaping.js';
import { maskSensitiveData } from '../utils/maskSensitiveData.js';
import { logger } from '../utils/logger.js';

const inputSchema = z.object({
  tenant: z.string().optional(),
  lang: z.string().optional(),
  jurisdiction_id: z.union([z.string(), z.number()]).transform(String).optional(),
});

export const listServicesTool: Tool = {
  definition: {
    name: 'list_services',
    description:
      'List the report categories (services) available for filing a report, e.g. ' +
      'pothole, graffiti, lighting, with their service_code. Call this BEFORE ' +
      'create_request to pick a valid service_code (and to read any required ' +
      'attributes for services with metadata=true). Pass the user\'s conversation ' +
      'language as `lang` (ISO 639-1) so category names come back localized. Use ' +
      'jurisdiction_id to scope to a specific city or district; omit it to use the ' +
      'token default or to discover which jurisdictions the deployment serves.',
    inputSchema: {
      type: 'object',
      properties: {
        tenant: { type: 'string', description: 'Tenant ID for multi-tenant setups (optional)' },
        lang: { type: 'string', description: 'Conversation language (ISO 639-1, e.g. "de", "nl") for localized category names.' },
        jurisdiction_id: { type: ['string', 'number'], description: 'Filter by jurisdiction/city ID. Omit to use the token default or to discover available jurisdictions.' },
      },
    },
  },
  handler: async (args: unknown) => {
    try {
      const { tenant, lang, jurisdiction_id } = inputSchema.parse(args || {});
      const resolvedJurisdiction = resolveJurisdiction(
        { jurisdiction_id },
        getTenantDefaultJurisdiction(tenant),
      );
      requireJurisdiction(resolvedJurisdiction);
      const resolvedLang = resolveLang(lang, getTenantDefaultLang(tenant));

      const apiKeyOverride = getJurisdictionApiKey(resolvedJurisdiction);
      const client = createApiClient({ tenantId: tenant, apiKeyOverride });

      const params: Record<string, string> = {};
      if (resolvedJurisdiction) params.jurisdiction_id = resolvedJurisdiction;
      const headers = acceptLanguageHeaders(resolvedLang);

      logger.info('Fetching services from GeoReport v2 API', { jurisdiction_id: resolvedJurisdiction, lang: resolvedLang });
      const response = await client.get('/georeport/v2/services.json', { params, headers });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(maskSensitiveData(response.data), null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Error fetching services', error);

      if (error.response) {
        const errorMessage = `API Error: ${error.response.status} ${error.response.statusText}. ${JSON.stringify(maskSensitiveData(error.response.data))}`;
        logger.error(errorMessage);
        throw new Error(errorMessage);
      }

      throw error;
    }
  },
};
