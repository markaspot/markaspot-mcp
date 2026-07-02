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
  handler: async (args: unknown) => {
    logger.info('Listing available tenants');

    // The dispatch overwrites args.tenant with the token's pin before this
    // handler runs (mcpDispatch enforced.tenant). Honoring it here makes the
    // tool safe by construction on shared multi-tenant gateways: a pinned
    // token can never enumerate the tenant registry (= customer list), no
    // matter which toolsets a deployment enables. Unpinned operator tokens
    // (single-tenant Enterprise bridges) still see the full registry.
    const { tenant } = (args ?? {}) as { tenant?: unknown };
    let tenants = getAllTenants();
    if (tenant) {
      tenants = tenants.filter(t => t.id === String(tenant));
    }

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
