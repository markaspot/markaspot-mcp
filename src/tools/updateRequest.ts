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
  status: z.enum(['open', 'closed', 'in_process']).optional(),
  status_notes: z.string().optional(),
  agency_responsible: z.string().optional(),
  revision_log_message: z.string().optional(),
  tenant: z.string().optional(),
  // Multi-jurisdiction backends require jurisdiction_id even on writes, or they
  // answer 400 "jurisdiction_id required". Forgiving (string or number), mirrors
  // the read tools. NOTE: this token is NOT jurisdiction-pinned (the dispatch
  // blocks request-id writes for pinned tokens), so the value comes from the arg
  // or the tenant default, never from the dispatch.
  jurisdiction_id: z.union([z.string(), z.number()]).transform(String).optional(),
});

export const updateRequestTool: Tool = {
  definition: {
    name: 'update_request',
    description:
      'Update a service request (staff only). Change status, add notes, or assign agency. ' +
      'Requires a staff API key with "access open311 advanced properties" permission. ' +
      'jurisdiction_id is required for multi-jurisdiction backends; pass the report\'s jurisdiction.',
    inputSchema: {
      type: 'object',
      required: ['request_id'],
      properties: {
        request_id: { type: 'string', description: 'The ID of the service request to update' },
        status: { type: 'string', enum: ['open', 'closed', 'in_process'], description: 'New status' },
        status_notes: { type: 'string', description: 'Status update note (visible to reporter)' },
        agency_responsible: { type: 'string', description: 'Responsible agency or department' },
        revision_log_message: { type: 'string', description: 'Internal revision log message' },
        tenant: { type: 'string', description: 'Tenant ID for multi-tenant setups (optional)' },
        jurisdiction_id: { type: ['string', 'number'], description: 'The report\'s jurisdiction/city ID. Required for multi-jurisdiction backends.' },
      },
    },
  },
  handler: async (args: unknown) => {
    try {
      const data = inputSchema.parse(args);
      // jurisdiction_id is a scoping param, not an update field, so it is pulled
      // out before the "at least one field" check.
      const { request_id, tenant, jurisdiction_id, ...updateFields } = data;

      // Require at least one update field
      if (Object.keys(updateFields).length === 0) {
        throw new Error('At least one field to update is required (status, status_notes, agency_responsible, or revision_log_message).');
      }

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

      logger.info('Updating service request', {
        request_id,
        jurisdiction_id: resolvedJurisdiction,
        fields: Object.keys(updateFields),
      });

      // Build form-encoded body with api_key
      const formData = new URLSearchParams();
      formData.append('api_key', staffKey);
      if (resolvedJurisdiction) {
        formData.append('jurisdiction_id', resolvedJurisdiction);
      }

      for (const [key, value] of Object.entries(updateFields)) {
        if (value !== undefined) {
          formData.append(key, String(value));
        }
      }

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
              updated_fields: Object.keys(updateFields),
              data: maskedData,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Error updating service request', error);

      if (error instanceof Error) {
        error.message = maskSensitiveData(error.message);
      }

      throw error;
    }
  },
};
