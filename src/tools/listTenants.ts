import { Tool } from '../types/tool.js';
import { getAllTenants } from '../utils/tenantConfig.js';
import { logger } from '../utils/logger.js';

export const listTenantsTool: Tool = {
  definition: {
    name: 'list_tenants',
    description:
      'List available tenants (cities/instances). ' +
      'Use the returned tenant ID as the "tenant" parameter in other tools.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  handler: async () => {
    logger.info('Listing available tenants');

    const tenants = getAllTenants();

    // Return tenant info without exposing API keys or internal URLs
    const safeTenants = tenants.map(t => ({
      id: t.id,
      name: t.name,
      has_staff_key: !!t.staffApiKey,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: safeTenants.length,
            tenants: safeTenants,
          }, null, 2),
        },
      ],
    };
  },
};
