import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { rewriteMediaUrl, transformMediaUrls } from '../src/utils/mediaUrl.js';

const BASE = 'https://demo.mark-a-spot.com';
const PROXY = `${BASE}/api/images`;

describe('rewriteMediaUrl', () => {
  it('rewrites a raw internal backend file URL to the absolute frontend proxy', () => {
    const raw = 'http://demo-nginx-1:8080/sites/default/files/parking.jpg';
    expect(rewriteMediaUrl(raw, BASE)).toBe(`${PROXY}/sites/default/files/parking.jpg`);
  });

  it('strips a reverse-proxy prefix like /management/', () => {
    const raw = 'http://management.demo.mark-a-spot.com/management/sites/default/files/a/b.png';
    expect(rewriteMediaUrl(raw, BASE)).toBe(`${PROXY}/sites/default/files/a/b.png`);
  });

  it('handles image-style derivatives', () => {
    const raw = 'http://demo-nginx-1:8080/sites/default/files/styles/large/public/x.jpg';
    expect(rewriteMediaUrl(raw, BASE)).toBe(`${PROXY}/sites/default/files/styles/large/public/x.jpg`);
  });

  it('handles a relative Drupal files path', () => {
    expect(rewriteMediaUrl('/sites/default/files/y.jpg', BASE)).toBe(`${PROXY}/sites/default/files/y.jpg`);
    expect(rewriteMediaUrl('sites/default/files/z.jpg', BASE)).toBe(`${PROXY}/sites/default/files/z.jpg`);
  });

  it('normalizes a trailing slash on the base (no double slash)', () => {
    expect(rewriteMediaUrl('http://h/sites/default/files/p.jpg', `${BASE}/`)).toBe(
      `${PROXY}/sites/default/files/p.jpg`,
    );
  });

  it('is a no-op when no frontend base is configured (backward compatible)', () => {
    const raw = 'http://demo-nginx-1:8080/sites/default/files/parking.jpg';
    expect(rewriteMediaUrl(raw, undefined)).toBe(raw);
    expect(rewriteMediaUrl(raw, '')).toBe(raw);
    expect(rewriteMediaUrl(raw, '   ')).toBe(raw);
  });

  it('is idempotent for an already-proxied URL (absolute or relative)', () => {
    const abs = `${PROXY}/sites/default/files/parking.jpg`;
    expect(rewriteMediaUrl(abs, BASE)).toBe(abs);
    expect(rewriteMediaUrl('/api/images/sites/default/files/parking.jpg', BASE)).toBe(
      '/api/images/sites/default/files/parking.jpg',
    );
  });

  it('leaves an empty value untouched', () => {
    expect(rewriteMediaUrl('', BASE)).toBe('');
  });

  it('leaves a non-Drupal URL untouched (conservative: never guess)', () => {
    const ext = 'https://cdn.example.com/photo.jpg';
    expect(rewriteMediaUrl(ext, BASE)).toBe(ext);
  });

  it('preserves a query string on a relative path (itok survives)', () => {
    expect(rewriteMediaUrl('sites/default/files/styles/large/public/x.jpg?itok=abc', BASE)).toBe(
      `${PROXY}/sites/default/files/styles/large/public/x.jpg?itok=abc`,
    );
  });

  it('drops the query string on an absolute URL (mirrors the frontend util)', () => {
    expect(rewriteMediaUrl('http://demo-nginx-1:8080/sites/default/files/x.jpg?itok=abc', BASE)).toBe(
      `${PROXY}/sites/default/files/x.jpg`,
    );
  });

  it('strips a /management/ prefix on a relative path too', () => {
    expect(rewriteMediaUrl('/management/system/files/x.png', BASE)).toBe(`${PROXY}/system/files/x.png`);
  });

  it('leaves a malformed absolute URL untouched (never throws out of the shaper)', () => {
    expect(rewriteMediaUrl('https://[', BASE)).toBe('https://[');
  });

  it('skips the rewrite when the configured base is not an http(s) URL', () => {
    const raw = 'http://demo-nginx-1:8080/sites/default/files/x.jpg';
    expect(rewriteMediaUrl(raw, 'javascript:alert(1)')).toBe(raw);
    expect(rewriteMediaUrl(raw, '/relative/base')).toBe(raw);
  });

  it('handles a pathological no-match input without catastrophic backtracking', () => {
    // ~12KB of separators that never form a files dir. The old greedy
    // `(?:^|.*\/)` prefix backtracked O(n^2) on this; the linear scan returns
    // fast (vitest's per-test timeout is the real ReDoS guard).
    const pathological = 'abc/def/ghi/'.repeat(1000) + 'notfiles/x.jpg';
    expect(rewriteMediaUrl(pathological, BASE)).toBe(pathological);
  });

  it('captures the whole path when "sites/" recurs after the files dir', () => {
    // Greedy-regex parity: a filename that itself contains "sites/" must not
    // truncate the capture to the trailing, invalid marker.
    expect(rewriteMediaUrl('/sites/default/files/sites/other.jpg', BASE)).toBe(
      `${PROXY}/sites/default/files/sites/other.jpg`,
    );
  });
});

describe('transformMediaUrls', () => {
  it('rewrites media_url in a wrapped { requests: [...] } response', () => {
    const data = {
      requests: [
        { service_request_id: 'r-1', media_url: 'http://demo-nginx-1:8080/sites/default/files/a.jpg' },
        { service_request_id: 'r-2' },
      ],
      meta: { total: 2 },
    };
    transformMediaUrls(data, BASE);
    expect(data.requests[0].media_url).toBe(`${PROXY}/sites/default/files/a.jpg`);
    expect(data.requests[1]).not.toHaveProperty('media_url');
  });

  it('rewrites each URL in a comma-separated media_url list', () => {
    const data = {
      media_url:
        'http://demo-nginx-1:8080/sites/default/files/a.jpg, http://demo-nginx-1:8080/sites/default/files/b.jpg',
    };
    transformMediaUrls(data, BASE);
    expect(data.media_url).toBe(
      `${PROXY}/sites/default/files/a.jpg,${PROXY}/sites/default/files/b.jpg`,
    );
  });

  it('rewrites a flat array of items', () => {
    const data = [{ media_url: 'http://demo-nginx-1:8080/sites/default/files/a.jpg' }];
    transformMediaUrls(data, BASE);
    expect(data[0].media_url).toBe(`${PROXY}/sites/default/files/a.jpg`);
  });

  it('rewrites a single request object', () => {
    const data = { service_request_id: 'r-9', media_url: 'http://demo-nginx-1:8080/sites/default/files/a.jpg' };
    transformMediaUrls(data, BASE);
    expect(data.media_url).toBe(`${PROXY}/sites/default/files/a.jpg`);
  });

  it('is a no-op when no frontend base is set', () => {
    const raw = 'http://demo-nginx-1:8080/sites/default/files/a.jpg';
    const data = { requests: [{ media_url: raw }] };
    transformMediaUrls(data, undefined);
    expect(data.requests[0].media_url).toBe(raw);
  });

  it('tolerates non-object input', () => {
    expect(transformMediaUrls(null, BASE)).toBeNull();
    expect(transformMediaUrls('x' as unknown, BASE)).toBe('x');
  });
});

// Tool-level wiring: the rewrite must actually be applied by list_requests and
// get_request when FRONTEND_BASE_URL is configured for the (single) tenant.
const getMock = vi.fn();
vi.mock('../src/utils/apiClient.js', () => ({
  createApiClient: () => ({ get: getMock, post: vi.fn() }),
}));

import { listRequestsTool } from '../src/tools/listRequests.js';
import { getRequestTool } from '../src/tools/getRequest.js';
import { resetTenantRegistry } from '../src/utils/tenantConfig.js';

function parseToolJson(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0].text);
}

describe('media_url rewrite wiring in tools', () => {
  beforeEach(() => {
    getMock.mockReset();
    process.env.GEOREPORT_SERVER_URL = 'http://demo-nginx-1:8080';
    process.env.GEOREPORT_API_KEY = 'test-key';
    process.env.FRONTEND_BASE_URL = BASE;
    resetTenantRegistry();
  });

  afterEach(() => {
    delete process.env.GEOREPORT_SERVER_URL;
    delete process.env.GEOREPORT_API_KEY;
    delete process.env.FRONTEND_BASE_URL;
    resetTenantRegistry();
  });

  it('list_requests carries a rewritten media_url in the slim list', async () => {
    getMock.mockResolvedValue({
      data: {
        requests: [
          {
            service_request_id: '485-2026',
            title: 'Parking Meter Repair',
            status: 'open',
            media_url: 'http://demo-nginx-1:8080/sites/default/files/meter.jpg',
          },
        ],
        meta: { total: 1 },
      },
    });
    const out = parseToolJson(await listRequestsTool.handler({}));
    expect(out.requests[0].media_url).toBe(`${PROXY}/sites/default/files/meter.jpg`);
  });

  it('get_request rewrites media_url in the full detail', async () => {
    getMock.mockResolvedValue({
      data: {
        service_request_id: '485-2026',
        title: 'Parking Meter Repair',
        media_url: 'http://demo-nginx-1:8080/sites/default/files/meter.jpg',
      },
    });
    const out = parseToolJson(await getRequestTool.handler({ request_id: '485-2026' }));
    expect(out.media_url).toBe(`${PROXY}/sites/default/files/meter.jpg`);
  });

  it('list_requests rewrites every URL of a comma-separated media_url through slim', async () => {
    getMock.mockResolvedValue({
      data: {
        requests: [
          {
            service_request_id: '485-2026',
            status: 'open',
            media_url:
              'http://demo-nginx-1:8080/sites/default/files/a.jpg, http://demo-nginx-1:8080/sites/default/files/b.jpg',
          },
        ],
        meta: { total: 1 },
      },
    });
    const out = parseToolJson(await listRequestsTool.handler({}));
    expect(out.requests[0].media_url).toBe(
      `${PROXY}/sites/default/files/a.jpg,${PROXY}/sites/default/files/b.jpg`,
    );
  });
});
