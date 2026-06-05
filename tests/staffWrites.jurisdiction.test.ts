import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Mock the API client so the write handlers never hit the network. The mock
// captures the POST call's url/body so we can assert jurisdiction_id lands in the
// upstream form-encoded body (the multi-jurisdiction 400 fix).
const postMock = vi.fn();
vi.mock('../src/utils/apiClient.js', () => ({
  createApiClient: () => ({ get: vi.fn(), post: postMock }),
}));

import { updateRequestTool } from '../src/tools/updateRequest.js';
import { addCommentTool } from '../src/tools/addComment.js';
import { resetTenantRegistry } from '../src/utils/tenantConfig.js';

/** Parse the last POST call's form-encoded string body into params. */
function lastBody(): URLSearchParams {
  const [, body] = postMock.mock.calls[postMock.mock.calls.length - 1];
  return new URLSearchParams(String(body));
}

describe('staff write tools pass jurisdiction_id into the upstream body', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue({ data: { service_request_id: 'r-1' }, status: 200, statusText: 'OK' });
    // Single tenant with a staff key (writes need a staff key).
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'default', name: 'Default', apiUrl: 'http://backend', apiKey: 'k', staffApiKey: 'STAFFKEY' },
    ]);
    resetTenantRegistry();
  });

  afterEach(() => {
    delete process.env.TENANTS_CONFIG;
    delete process.env.JURISDICTIONS;
    resetTenantRegistry();
  });

  it('update_request: jurisdiction_id lands in the form body', async () => {
    await updateRequestTool.handler({ request_id: 'r-1', status: 'closed', jurisdiction_id: '4' });
    expect(postMock).toHaveBeenCalledOnce();
    const [url] = postMock.mock.calls[0];
    expect(url).toBe('/georeport/v2/requests/r-1.json');
    const body = lastBody();
    expect(body.get('jurisdiction_id')).toBe('4');
    expect(body.get('status')).toBe('closed');
  });

  it('update_request: numeric jurisdiction_id is coerced to string in the body', async () => {
    await updateRequestTool.handler({ request_id: 'r-1', status: 'open', jurisdiction_id: 4 });
    expect(lastBody().get('jurisdiction_id')).toBe('4');
  });

  it('add_comment: jurisdiction_id lands in the form body alongside the comment', async () => {
    await addCommentTool.handler({ request_id: 'r-9', comment: 'on it', jurisdiction_id: '1' });
    expect(postMock).toHaveBeenCalledOnce();
    const body = lastBody();
    expect(body.get('jurisdiction_id')).toBe('1');
    expect(body.get('status_notes')).toBe('on it');
  });

  it('update_request: no jurisdiction_id on a multi-jurisdiction deployment -> teaching error, no upstream call', async () => {
    process.env.JURISDICTIONS = JSON.stringify([
      { id: '1', name: 'Amsterdam' },
      { id: '4', name: 'Stadsdeel Noord' },
    ]);
    resetTenantRegistry();
    await expect(
      updateRequestTool.handler({ request_id: 'r-1', status: 'closed' }),
    ).rejects.toThrow(/jurisdiction_id required/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('add_comment: no jurisdiction_id on a multi-jurisdiction deployment -> teaching error, no upstream call', async () => {
    process.env.JURISDICTIONS = JSON.stringify([
      { id: '1', name: 'Amsterdam' },
      { id: '4', name: 'Stadsdeel Noord' },
    ]);
    resetTenantRegistry();
    await expect(
      addCommentTool.handler({ request_id: 'r-1', comment: 'x' }),
    ).rejects.toThrow(/jurisdiction_id required/);
    expect(postMock).not.toHaveBeenCalled();
  });
});
