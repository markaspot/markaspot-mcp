import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.fn();
vi.mock('../src/utils/apiClient.js', () => ({
  createApiClient: () => ({ post: postMock }),
}));

import { createRequestTool } from '../src/tools/createRequest.js';
import { resetTenantRegistry } from '../src/utils/tenantConfig.js';

const report = {
  service_code: '001',
  lat: 52.37,
  long: 4.89,
  description: 'Pothole near the crossing',
  jurisdiction_id: 4,
};

describe('create_request validation after the Zod upgrade', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue({ data: { service_request_id: 'r-1' } });
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'default', name: 'Default', apiUrl: 'http://backend', apiKey: 'test-key' },
    ]);
    resetTenantRegistry();
  });

  afterEach(() => {
    delete process.env.TENANTS_CONFIG;
    resetTenantRegistry();
  });

  it('forwards arbitrary string attributes as Open311 form fields', async () => {
    await createRequestTool.handler({ ...report, attributes: { surface: 'asphalt', width: '2' } });
    expect(postMock).toHaveBeenCalledOnce();
    const [url, payload] = postMock.mock.calls[0];
    expect(url).toBe('/georeport/v2/requests.json');
    const body = new URLSearchParams(payload);
    expect(body.get('attribute[surface]')).toBe('asphalt');
    expect(body.get('attribute[width]')).toBe('2');
    expect(body.get('jurisdiction_id')).toBe('4');
  });

  it('accepts a report without optional attributes', async () => {
    await createRequestTool.handler(report);
    expect(postMock).toHaveBeenCalledOnce();
  });

  it.each([2, null, { nested: 'value' }])('rejects a non-string attribute before calling the backend: %j', async value => {
    await expect(createRequestTool.handler({ ...report, attributes: { width: value } })).rejects.toHaveProperty('name', 'ZodError');
    expect(postMock).not.toHaveBeenCalled();
  });
});
