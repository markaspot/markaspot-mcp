import { ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import { createApiClient } from '../utils/apiClient.js';
import { logger } from '../utils/logger.js';
import { getAllTenants } from '../utils/tenantConfig.js';

// Resource definitions
export const servicesResource: ResourceTemplate = {
  uriTemplate: 'georeport://services',
  name: 'GeoReport Services',
  description: 'Live list of available report categories and services',
  mimeType: 'application/json'
};

export const recentRequestsResource: ResourceTemplate = {
  uriTemplate: 'georeport://requests/recent',
  name: 'Recent Reports',
  description: 'Latest service requests and reports',
  mimeType: 'application/json'
};

export const statsResource: ResourceTemplate = {
  uriTemplate: 'georeport://stats',
  name: 'GeoReport Statistics',
  description: 'Platform statistics and metrics',
  mimeType: 'application/json'
};

export const configResource: ResourceTemplate = {
  uriTemplate: 'georeport://config',
  name: 'API Configuration',
  description: 'Current API configuration and status (includes tenant info)',
  mimeType: 'application/json'
};

// Resource handlers
export async function handleResourceRead(uri: string): Promise<any> {
  logger.info(`Reading resource: ${uri}`);

  try {
    switch (uri) {
      case 'georeport://services':
        return await getServicesResource();

      case 'georeport://requests/recent':
        return await getRecentRequestsResource();

      case 'georeport://stats':
        return await getStatsResource();

      case 'georeport://config':
        return await getConfigResource();

      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  } catch (error) {
    logger.error(`Resource read error: ${uri}`, error);
    throw error;
  }
}

async function getServicesResource() {
  const client = createApiClient();
  const response = await client.get('/georeport/v2/services.json');

  return {
    contents: [
      {
        uri: 'georeport://services',
        mimeType: 'application/json',
        text: JSON.stringify({
          metadata: {
            title: 'GeoReport Services',
            description: 'Available report categories and service types',
            updated: new Date().toISOString(),
            count: response.data.length
          },
          services: response.data
        }, null, 2)
      }
    ]
  };
}

async function getRecentRequestsResource() {
  const client = createApiClient();
  const response = await client.get('/georeport/v2/requests.json', {
    params: {
      limit: 20,
      sort: 'requested_datetime',
      order: 'desc'
    }
  });

  return {
    contents: [
      {
        uri: 'georeport://requests/recent',
        mimeType: 'application/json',
        text: JSON.stringify({
          metadata: {
            title: 'Recent Service Requests',
            description: 'Latest 20 reports and their status',
            updated: new Date().toISOString(),
            count: response.data.length
          },
          requests: response.data
        }, null, 2)
      }
    ]
  };
}

async function getStatsResource() {
  try {
    const client = createApiClient();
    const response = await client.get('/georeport/v2/requests.json', {
      params: { limit: 100 }
    });

    const requests = response.data;
    const statusCounts = requests.reduce((acc: any, req: any) => {
      acc[req.status] = (acc[req.status] || 0) + 1;
      return acc;
    }, {});

    const serviceCounts = requests.reduce((acc: any, req: any) => {
      acc[req.service_name] = (acc[req.service_name] || 0) + 1;
      return acc;
    }, {});

    return {
      contents: [
        {
          uri: 'georeport://stats',
          mimeType: 'application/json',
          text: JSON.stringify({
            metadata: {
              title: 'GeoReport Statistics',
              description: 'Platform usage statistics and metrics',
              updated: new Date().toISOString(),
              period: 'Last 100 requests'
            },
            stats: {
              total_requests: requests.length,
              status_distribution: statusCounts,
              service_distribution: serviceCounts,
              most_recent: requests[0]?.requested_datetime,
              oldest_in_sample: requests[requests.length - 1]?.requested_datetime
            }
          }, null, 2)
        }
      ]
    };
  } catch (error) {
    logger.error('Error generating stats', error);
    return {
      contents: [
        {
          uri: 'georeport://stats',
          mimeType: 'application/json',
          text: JSON.stringify({
            error: 'Unable to generate statistics',
            message: error instanceof Error ? error.message : 'Unknown error'
          }, null, 2)
        }
      ]
    };
  }
}

async function getConfigResource() {
  const tenants = getAllTenants();

  return {
    contents: [
      {
        uri: 'georeport://config',
        mimeType: 'application/json',
        text: JSON.stringify({
          metadata: {
            title: 'MCP Bridge Configuration',
            description: 'Current API configuration and status',
            updated: new Date().toISOString()
          },
          config: {
            api_configured: !!(process.env.GEOREPORT_SERVER_URL || process.env.MARKASPOT_API_URL || process.env.TENANTS_CONFIG),
            has_token: !!(process.env.GEOREPORT_API_KEY || process.env.MARKASPOT_API_TOKEN || process.env.TENANTS_CONFIG),
            has_staff_key: !!(process.env.GEOREPORT_STAFF_API_KEY),
            has_auth_users: !!(process.env.MCP_AUTH_USERS),
            multi_tenant: tenants.length > 1,
            tenant_count: tenants.length,
            tenants: tenants.map(t => ({ id: t.id, name: t.name })),
            node_env: process.env.NODE_ENV || 'production',
            version: '0.2.0'
          }
        }, null, 2)
      }
    ]
  };
}

export const allResources = [
  servicesResource,
  recentRequestsResource,
  statsResource,
  configResource
];
