import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchMcp } from '../src/utils/mcpDispatch.js';
import type { DispatchOptions } from '../src/utils/mcpDispatch.js';
import type { Tool } from '../src/types/tool.js';
import type { UserContext } from '../src/utils/userContext.js';
import { resolveUser, resetUserRegistry } from '../src/utils/userContext.js';
import { resetTenantRegistry } from '../src/utils/tenantConfig.js';
import {
  toolsetForTool,
  isToolDeploymentEnabled,
  STAFF_TOOLSETS,
  JURISDICTION_TOOLS,
  resetToolsetCache,
} from '../src/toolsets.js';

const FORBIDDEN = -32003;

// A spy handler so we can assert the dispatch actually reached the tool (i.e.
// gating passed) without any network.
const getStatsHandler = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
const updateRequestHandler = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));

const registry = new Map<string, Tool>([
  [
    'get_stats',
    {
      definition: { name: 'get_stats', description: 'stats', inputSchema: { type: 'object' } },
      handler: getStatsHandler,
    },
  ],
  [
    'update_request',
    {
      definition: { name: 'update_request', description: 'update', inputSchema: { type: 'object' } },
      handler: updateRequestHandler,
    },
  ],
]);

const opts: DispatchOptions = {
  registry,
  serverInfo: { name: 'test', version: '0.0.0' },
  buildInstructions: () => 'test',
  toolsetForTool,
  // Enable everything for these tests; we are exercising role gating, not
  // deployment scoping.
  isToolDeploymentEnabled: () => true,
  staffToolsets: STAFF_TOOLSETS,
  jurisdictionTools: JURISDICTION_TOOLS,
};

function call(name: string, ctx: UserContext) {
  return dispatchMcp('tools/call', { name, arguments: {} }, 1, ctx, opts);
}

describe('dispatch role gating', () => {
  beforeEach(() => {
    resetUserRegistry();
    resetTenantRegistry();
    resetToolsetCache();
    getStatsHandler.mockClear();
    updateRequestHandler.mockClear();
    // Auth must be configured for the dispatch to leave the gate open.
    process.env.MCP_AUTH_USERS = JSON.stringify([
      { mcpToken: 'tok', name: 'Test' },
    ]);
  });

  afterEach(() => {
    delete process.env.MCP_AUTH_USERS;
    delete process.env.TENANTS_CONFIG;
    resetUserRegistry();
    resetTenantRegistry();
  });

  it('get_stats: role citizen -> FORBIDDEN (reporting is staff-only)', async () => {
    const ctx: UserContext = { authenticated: true, role: 'citizen' };
    const res = await call('get_stats', ctx);
    expect(res?.error?.code).toBe(FORBIDDEN);
    expect(getStatsHandler).not.toHaveBeenCalled();
  });

  it('get_stats: role staff -> reaches the (mocked) handler', async () => {
    const ctx: UserContext = { authenticated: true, role: 'staff' };
    const res = await call('get_stats', ctx);
    expect(res?.error).toBeUndefined();
    expect(getStatsHandler).toHaveBeenCalledOnce();
  });

  it('update_request: role citizen -> FORBIDDEN (manage is staff-only)', async () => {
    const ctx: UserContext = { authenticated: true, role: 'citizen' };
    const res = await call('update_request', ctx);
    expect(res?.error?.code).toBe(FORBIDDEN);
    expect(updateRequestHandler).not.toHaveBeenCalled();
  });

  it('get_stats: role citizen WITH reporting in allowedToolsets -> still FORBIDDEN', async () => {
    // Documents the deliberate breaking change: reporting is in the toolset scope
    // but is a STAFF toolset, so role:staff is required regardless. A citizen
    // token granted reporting (the old inconsistent Ayunis config) is rejected;
    // the fix is role:staff, not widening the toolset list.
    const ctx: UserContext = {
      authenticated: true,
      role: 'citizen',
      allowedToolsets: ['read', 'intake', 'reporting'],
    };
    const res = await call('get_stats', ctx);
    expect(res?.error?.code).toBe(FORBIDDEN);
    expect(getStatsHandler).not.toHaveBeenCalled();
  });
});

describe('resolveUser no-auto-promote', () => {
  beforeEach(() => {
    resetUserRegistry();
    resetTenantRegistry();
  });

  afterEach(() => {
    delete process.env.MCP_AUTH_USERS;
    delete process.env.TENANTS_CONFIG;
    resetUserRegistry();
    resetTenantRegistry();
  });

  it('defaults to citizen even when the tenant has a staffApiKey configured', () => {
    // The staff backend key lives on the tenant, never on the token. A token
    // without an explicit role must NOT be promoted to staff just because a
    // staff key exists somewhere.
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'demo', name: 'Demo', apiUrl: 'http://x', apiKey: 'k', staffApiKey: 'STAFFKEY' },
    ]);
    process.env.MCP_AUTH_USERS = JSON.stringify([
      { mcpToken: 'tok', name: 'No Role', tenant: 'demo' },
    ]);
    resetUserRegistry();
    resetTenantRegistry();

    const ctx = resolveUser('tok');
    expect(ctx.authenticated).toBe(true);
    expect(ctx.role).toBe('citizen');
  });
});
