import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { slimRequestList } from '../src/utils/requestShaping.js';

// Mock the API client so the list_requests handler never hits the network. The
// mock captures the GET call's url/params/headers so we can assert the upstream
// contract (meta+limit+cursor+Accept-Language).
const getMock = vi.fn();
vi.mock('../src/utils/apiClient.js', () => ({
  createApiClient: () => ({ get: getMock, post: vi.fn() }),
}));

import { listRequestsTool } from '../src/tools/listRequests.js';
import { resetTenantRegistry } from '../src/utils/tenantConfig.js';

describe('slimRequestList', () => {
  const fixture = {
    requests: [
      {
        service_request_id: 'r-1',
        title: 'Pothole on Main St',
        description: 'Deep pothole, dangerous for cyclists',
        address_string: 'Main St 1, Amsterdam',
        status: 'open',
        service_code: '001',
        service_name: 'Pothole',
        requested_datetime: '2026-06-01T10:00:00Z',
        lat: 52.37,
        long: 4.89,
        // Noise that must be dropped:
        extended_attributes: { detailed: 'lots of drupal stuff', vid: 99 },
        revision_id: 123,
        langcode: 'en',
        content_translation_source: 'und',
      },
    ],
    meta: { total: 134, returned: 1, next_cursor: 'CURSORX' },
  };

  it('keeps only the whitelist fields and drops extended_attributes + internals', () => {
    const slim = slimRequestList(fixture);
    const item = slim.requests[0] as Record<string, unknown>;
    expect(item).toMatchObject({
      service_request_id: 'r-1',
      title: 'Pothole on Main St',
      description: 'Deep pothole, dangerous for cyclists',
      address_string: 'Main St 1, Amsterdam',
      status: 'open',
      service_code: '001',
      service_name: 'Pothole',
      requested_datetime: '2026-06-01T10:00:00Z',
      lat: 52.37,
      long: 4.89,
    });
    expect(item).not.toHaveProperty('extended_attributes');
    expect(item).not.toHaveProperty('revision_id');
    expect(item).not.toHaveProperty('langcode');
    expect(item).not.toHaveProperty('content_translation_source');
  });

  it('surfaces total + cursor and a human-readable note', () => {
    const slim = slimRequestList(fixture);
    expect(slim.meta.total).toBe(134);
    expect(slim.meta.next_cursor).toBe('CURSORX');
    expect(slim.meta.note).toContain('showing 1 of 134');
    expect(slim.meta.note).toContain('CURSORX');
  });

  it('falls back to service_name for title when title is absent', () => {
    const slim = slimRequestList({ requests: [{ service_request_id: 'x', service_name: 'Graffiti' }], meta: {} });
    expect(slim.requests[0].title).toBe('Graffiti');
  });

  it('accepts a flat array (no meta wrapper)', () => {
    const slim = slimRequestList([{ service_request_id: 'a' }, { service_request_id: 'b' }]);
    expect(slim.requests).toHaveLength(2);
    expect(slim.meta.returned).toBe(2);
    expect(slim.meta.note).toBe('showing 2');
  });
});

describe('list_requests handler upstream contract', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ data: { requests: [], meta: { total: 0 } }, status: 200, statusText: 'OK' });
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'default', name: 'Default', apiUrl: 'http://backend', apiKey: 'k' },
    ]);
    resetTenantRegistry();
  });

  afterEach(() => {
    delete process.env.TENANTS_CONFIG;
    resetTenantRegistry();
  });

  it('always sends meta=true and the default limit of 20', async () => {
    await listRequestsTool.handler({});
    expect(getMock).toHaveBeenCalledOnce();
    const [, config] = getMock.mock.calls[0];
    expect(config.params.meta).toBe('true');
    expect(config.params.limit).toBe(20);
  });

  it('clamps an oversized limit to <= 50 in the upstream param', async () => {
    await listRequestsTool.handler({ limit: 9999 });
    const [, config] = getMock.mock.calls[0];
    expect(config.params.limit).toBeLessThanOrEqual(50);
    expect(config.params.limit).toBe(50);
  });

  it('maps lang "de" to an Accept-Language header', async () => {
    await listRequestsTool.handler({ lang: 'de' });
    const [, config] = getMock.mock.calls[0];
    expect(config.headers['Accept-Language']).toBe('de');
  });

  it('passes a cursor through to the upstream param', async () => {
    await listRequestsTool.handler({ cursor: 'NEXT123' });
    const [, config] = getMock.mock.calls[0];
    expect(config.params.cursor).toBe('NEXT123');
  });

  it('throws a teaching error listing both jurisdictions when several are served and none resolved', async () => {
    process.env.JURISDICTIONS = JSON.stringify([
      { id: '1', name: 'Amsterdam' },
      { id: '8', name: 'BCP Council' },
    ]);
    resetTenantRegistry();
    await expect(listRequestsTool.handler({})).rejects.toThrow(/jurisdiction_id required/);
    await expect(listRequestsTool.handler({})).rejects.toThrow(/Amsterdam/);
    await expect(listRequestsTool.handler({})).rejects.toThrow(/BCP Council/);
    expect(getMock).not.toHaveBeenCalled();
    delete process.env.JURISDICTIONS;
    resetTenantRegistry();
  });
});
