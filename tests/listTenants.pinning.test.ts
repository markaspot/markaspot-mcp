import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserContext } from '../src/utils/userContext.js';

// list_tenants must be safe by construction on a shared gateway: even when a
// deployment enables the manage toolset, a tenant-pinned token must not be
// able to enumerate the tenant registry (= customer list). Modules are
// re-imported per test because the tenant registry caches TENANTS_CONFIG.

describe('list_tenants tenant scoping', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'demo', name: 'Demo City', apiUrl: 'http://demo', apiKey: 'k1' },
      { id: 'bonn', name: 'Stadt Bonn', apiUrl: 'http://bonn', apiKey: 'k2' },
    ]);
    process.env.MCP_AUTH_USERS = JSON.stringify([{ mcpToken: 'tok', name: 'T' }]);
    process.env.ENABLED_TOOLSETS = 'read,intake,manage,reporting';
  });

  async function listTenants(ctx: UserContext) {
    const { handleMcp } = await import('../src/mcpApp.js');
    const res = await handleMcp('tools/call', { name: 'list_tenants', arguments: {} }, 1, ctx);
    expect(res?.error).toBeUndefined();
    const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
    return JSON.parse(text) as { count: number; tenants: Array<{ id: string }> };
  }

  it('pinned staff token sees only its own tenant even with manage enabled', async () => {
    const result = await listTenants({ authenticated: true, role: 'staff', tenant: 'bonn' });
    expect(result.count).toBe(1);
    expect(result.tenants.map((t) => t.id)).toEqual(['bonn']);
  });

  it('unpinned operator token sees the full registry', async () => {
    const result = await listTenants({ authenticated: true, role: 'staff' });
    expect(result.count).toBe(2);
  });
});
