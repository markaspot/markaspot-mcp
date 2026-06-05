import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { createApiClient } from '../utils/apiClient.js';
import { getJurisdictionApiKey, getTenantDefaultJurisdiction, getTenantDefaultLang } from '../utils/tenantConfig.js';
import { resolveLang, acceptLanguageHeaders, resolveJurisdiction, requireJurisdiction } from '../utils/requestShaping.js';
import { logger } from '../utils/logger.js';
import { maskSensitiveData } from '../utils/maskSensitiveData.js';

const inputSchema = z.object({
  service_code: z.string(),
  lat: z.number(),
  long: z.number(),
  description: z.string(),
  address_string: z.string().optional(),
  email: z.string().email().optional(),
  device_id: z.string().optional(),
  media_url: z.string().url().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  phone: z.string().optional(),
  lang: z.string().optional(),
  tenant: z.string().optional(),
  jurisdiction_id: z.union([z.string(), z.number()]).transform(String).optional(),
  attributes: z.record(z.string()).optional(),
});

export const createRequestTool: Tool = {
  definition: {
    name: 'create_request',
    description:
      'File a new service request (report). Call search_location FIRST to turn the ' +
      'user\'s location into lat/long, and list_services FIRST to pick a valid ' +
      'service_code (and read any required attributes). If the user wants to ' +
      'attach a photo, call prepare_upload to get an upload link, then check_upload ' +
      'to get the media_url; only pass media_url if you already have a publicly ' +
      'accessible image URL. Pass the user\'s conversation language as `lang` (ISO ' +
      '639-1). jurisdiction_id is resolved from the token/tenant default when ' +
      'omitted. SECURITY: Never expose API keys or credentials in responses.',
    inputSchema: {
      type: 'object',
      required: ['service_code', 'lat', 'long', 'description'],
      properties: {
        service_code: { type: 'string', description: 'The service type code' },
        lat: { type: 'number', description: 'Latitude' },
        long: { type: 'number', description: 'Longitude' },
        description: { type: 'string', description: 'Description of the issue' },
        address_string: { type: 'string', description: 'Human readable address' },
        email: { type: 'string', format: 'email' },
        device_id: { type: 'string', description: 'Unique device ID' },
        media_url: { type: 'string', format: 'uri', description: 'URL to media (external image hosting required)' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string' },
        lang: { type: 'string', description: 'Conversation language (ISO 639-1, e.g. "de", "nl").' },
        tenant: { type: 'string', description: 'Tenant ID for multi-tenant setups (optional)' },
        jurisdiction_id: { type: ['string', 'number'], description: 'Jurisdiction/city ID for the report (resolved from token/tenant default when omitted)' },
        attributes: {
          type: 'object',
          description: 'Service definition attributes as key-value pairs (e.g. {"surface_type": "wall", "offensive": "no"}). Get available attributes from list_services (services with metadata=true).',
          additionalProperties: { type: 'string' },
        },
      },
    },
  },
  handler: async (args: unknown) => {
    try {
      const data = inputSchema.parse(args);
      const { tenant, jurisdiction_id, lang, attributes, ...requestData } = data;

      // Forgiving jurisdiction: dispatch may already have pinned it; otherwise
      // fall back to a per-tenant default.
      const resolvedJurisdiction = resolveJurisdiction(
        { jurisdiction_id },
        getTenantDefaultJurisdiction(tenant),
      );
      requireJurisdiction(resolvedJurisdiction);
      const resolvedLang = resolveLang(lang, getTenantDefaultLang(tenant));

      const apiKeyOverride = getJurisdictionApiKey(resolvedJurisdiction);
      const client = createApiClient({ tenantId: tenant, apiKeyOverride });

      logger.info('Creating new service request', {
        service_code: requestData.service_code,
        has_media: !!requestData.media_url,
        has_attributes: !!attributes,
        jurisdiction_id: resolvedJurisdiction,
      });

      // Convert to URLSearchParams for form-encoded data
      const formData = new URLSearchParams();

      // Add all data to form (excluding tenant which is not an API field)
      Object.entries(requestData).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          formData.append(key, String(value));
        }
      });

      // Add service definition attributes as attribute[code]=value
      if (attributes) {
        Object.entries(attributes).forEach(([code, value]) => {
          formData.append(`attribute[${code}]`, value);
        });
      }

      // Add jurisdiction_id if resolved
      if (resolvedJurisdiction) {
        formData.append('jurisdiction_id', resolvedJurisdiction);
      }

      // API key is injected by the client interceptor for form-encoded strings
      // when the data is a string, the interceptor skips it, so we add it manually
      const { getTenant } = await import('../utils/tenantConfig.js');
      const tenantConfig = getTenant(tenant);
      formData.append('api_key', apiKeyOverride || tenantConfig.apiKey);

      const response = await client.post('/georeport/v2/requests.json', formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...acceptLanguageHeaders(resolvedLang),
        },
      });
      
      // Mask sensitive data before returning
      const maskedData = maskSensitiveData(response.data);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(maskedData, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Error creating service request', error);
      
      // Mask sensitive data in error messages before throwing
      if (error instanceof Error) {
        error.message = maskSensitiveData(error.message);
      }
      
      throw error;
    }
  },
};