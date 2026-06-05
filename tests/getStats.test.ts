import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Mock the API client so the get_stats handler never hits the network. The mock
// captures the GET call's url/params so we can assert endpoint routing + the
// category-limit clamp.
const getMock = vi.fn();
vi.mock('../src/utils/apiClient.js', () => ({
  createApiClient: () => ({ get: getMock, post: vi.fn() }),
}));

import { getStatsTool } from '../src/tools/getStats.js';
import { resetTenantRegistry } from '../src/utils/tenantConfig.js';

describe('get_stats handler', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ data: {}, status: 200, statusText: 'OK' });
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'default', name: 'Default', apiUrl: 'http://backend', apiKey: 'k', staffApiKey: 's' },
    ]);
    resetTenantRegistry();
  });

  afterEach(() => {
    delete process.env.TENANTS_CONFIG;
    resetTenantRegistry();
  });

  it('routes breakdown=status to stats.json with no limit param', async () => {
    await getStatsTool.handler({ jurisdiction_id: '1' });
    const [url, config] = getMock.mock.calls[0];
    expect(url).toBe('/georeport/v2/stats.json');
    expect(config.params.limit).toBeUndefined();
  });

  it('routes breakdown=category to stats/categories.json with the default limit', async () => {
    await getStatsTool.handler({ breakdown: 'category', jurisdiction_id: '1' });
    const [url, config] = getMock.mock.calls[0];
    expect(url).toBe('/georeport/v2/stats/categories.json');
    expect(config.params.limit).toBe(10);
  });

  it('clamps an oversized category limit to <= 50', async () => {
    await getStatsTool.handler({ breakdown: 'category', limit: 9999, jurisdiction_id: '1' });
    const [, config] = getMock.mock.calls[0];
    expect(config.params.limit).toBeLessThanOrEqual(50);
    expect(config.params.limit).toBe(50);
  });
});
