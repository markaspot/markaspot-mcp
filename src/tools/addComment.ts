import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { createApiClient } from '../utils/apiClient.js';
import { getApiKey } from '../utils/authContext.js';
import { getTenantDefaultJurisdiction } from '../utils/tenantConfig.js';
import { resolveJurisdiction, requireJurisdiction } from '../utils/requestShaping.js';
import { logger } from '../utils/logger.js';
import { maskSensitiveData } from '../utils/maskSensitiveData.js';

const inputSchema = z.object({
  // Interpolated into the URL path: restrict to path-safe characters.
  request_id: z.string().regex(/^[A-Za-z0-9._-]+$/, 'invalid request_id'),
  comment: z.string(),
  tenant: z.string().optional(),
  // Multi-jurisdiction backends require jurisdiction_id even on writes, or they
  // answer 400 "jurisdiction_id required". Forgiving (string or number), mirrors
  // the read tools and update_request.
  jurisdiction_id: z.union([z.string(), z.number()]).transform(String).optional(),
});

export const addCommentTool: Tool = {
  definition: {
    name: 'add_comment',
    description:
      'Add a comment to a service request without changing its status (staff only). ' +
      'This is a convenience wrapper around update_request that only sets status_notes. ' +
      'jurisdiction_id is required for multi-jurisdiction backends; pass the report\'s jurisdiction.',
    inputSchema: {
      type: 'object',
      required: ['request_id', 'comment'],
      properties: {
        request_id: { type: 'string', description: 'The ID of the service request' },
        comment: { type: 'string', description: 'The comment text to add' },
        tenant: { type: 'string', description: 'Tenant ID for multi-tenant setups (optional)' },
        jurisdiction_id: { type: ['string', 'number'], description: 'The report\'s jurisdiction/city ID. Required for multi-jurisdiction backends.' },
      },
    },
  },
  handler: async (args: unknown) => {
    try {
      const data = inputSchema.parse(args);
      const { request_id, comment, tenant, jurisdiction_id } = data;

      // Forgiving jurisdiction resolution (arg -> tenant default), mirroring the
      // read tools, with a teaching error instead of a silent backend 400 when a
      // multi-jurisdiction deployment gets no jurisdiction_id.
      const resolvedJurisdiction = resolveJurisdiction(
        { jurisdiction_id },
        getTenantDefaultJurisdiction(tenant),
      );
      requireJurisdiction(resolvedJurisdiction);

      const staffKey = getApiKey('staff', tenant);
      const client = createApiClient({ tenantId: tenant, apiKeyOverride: staffKey });

      logger.info('Adding comment to service request', { request_id, jurisdiction_id: resolvedJurisdiction });

      const formData = new URLSearchParams();
      formData.append('api_key', staffKey);
      if (resolvedJurisdiction) {
        formData.append('jurisdiction_id', resolvedJurisdiction);
      }
      formData.append('status_notes', comment);

      const response = await client.post(
        `/georeport/v2/requests/${request_id}.json`,
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const maskedData = maskSensitiveData(response.data);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              request_id,
              comment,
              data: maskedData,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Error adding comment', error);

      if (error instanceof Error) {
        error.message = maskSensitiveData(error.message);
      }

      throw error;
    }
  },
};
