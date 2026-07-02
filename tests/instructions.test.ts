import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserContext } from '../src/utils/userContext.js';

// The initialize handshake is open (pre-auth), so its instructions must be
// scoped to the caller: on a shared multi-tenant gateway the tenant registry
// is the customer list. Modules are re-imported per test because the tenant
// registry caches TENANTS_CONFIG on first load.

describe('initialize instructions scoping (mcpApp)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'demo', name: 'Demo City', apiUrl: 'http://demo', apiKey: 'k1' },
      { id: 'bonn', name: 'Stadt Bonn', apiUrl: 'http://bonn', apiKey: 'k2' },
    ]);
    process.env.MCP_AUTH_USERS = JSON.stringify([
      { mcpToken: 'tok', name: 'Bonn', tenant: 'bonn' },
    ]);
    delete process.env.JURISDICTIONS;
  });

  async function initialize(ctx: UserContext): Promise<string> {
    const { handleMcp } = await import('../src/mcpApp.js');
    const res = await handleMcp('initialize', {}, 1, ctx);
    return (res?.result as { instructions: string }).instructions;
  }

  it('anonymous handshake never enumerates tenants', async () => {
    const instructions = await initialize({ authenticated: false });
    expect(instructions).not.toContain('Demo City');
    expect(instructions).not.toContain('Stadt Bonn');
    expect(instructions).not.toContain('Connected to');
  });

  it('tenant-pinned token sees only its own tenant', async () => {
    const instructions = await initialize({ authenticated: true, tenant: 'bonn' });
    expect(instructions).toContain('Stadt Bonn');
    expect(instructions).not.toContain('Demo City');
  });

  it('unpinned operator token sees the full registry', async () => {
    const instructions = await initialize({ authenticated: true });
    expect(instructions).toContain('Stadt Bonn');
    expect(instructions).toContain('Demo City');
  });

  it('jurisdiction-pinned token sees only its allowed jurisdictions', async () => {
    process.env.JURISDICTIONS = JSON.stringify([
      { id: '1', name: 'Amsterdam' },
      { id: '8', name: 'BCP Council' },
    ]);
    const instructions = await initialize({
      authenticated: true,
      tenant: 'bonn',
      allowedJurisdictions: ['1'],
    });
    expect(instructions).toContain('Amsterdam');
    expect(instructions).not.toContain('BCP Council');
  });

  it('anonymous handshake hides jurisdictions too', async () => {
    process.env.JURISDICTIONS = JSON.stringify([{ id: '1', name: 'Amsterdam' }]);
    const instructions = await initialize({ authenticated: false });
    expect(instructions).not.toContain('Amsterdam');
  });
});
