import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchMcp } from '../src/utils/mcpDispatch.js';
import type { DispatchOptions } from '../src/utils/mcpDispatch.js';
import type { Tool } from '../src/types/tool.js';
import type { UserContext } from '../src/utils/userContext.js';
import {
  toolsetForTool,
  STAFF_TOOLSETS,
  JURISDICTION_TOOLS,
} from '../src/toolsets.js';

const FORBIDDEN = -32003;

// Tenant pinning is the isolation boundary of the shared marketplace gateway:
// one token per organization, bound to exactly one tenant. The handler is a
// spy so we can assert which tenant the dispatch enforced before calling it.
const handler = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));

const registry = new Map<string, Tool>([
  [
    'list_requests',
    {
      definition: { name: 'list_requests', description: 'list', inputSchema: { type: 'object' } },
      handler,
    },
  ],
]);

const buildInstructions = vi.fn((ctx: UserContext) => (ctx.authenticated ? 'authed' : 'anon'));

const opts: DispatchOptions = {
  registry,
  serverInfo: { name: 'test', version: '0.0.0' },
  buildInstructions,
  toolsetForTool,
  isToolDeploymentEnabled: () => true,
  staffToolsets: STAFF_TOOLSETS,
  jurisdictionTools: JURISDICTION_TOOLS,
};

function call(args: Record<string, unknown>, tenant?: string) {
  const ctx: UserContext = { authenticated: true, role: 'citizen', tenant };
  return dispatchMcp('tools/call', { name: 'list_requests', arguments: args }, 1, ctx, opts);
}

describe('tenant pinning (dispatch)', () => {
  beforeEach(() => {
    handler.mockClear();
    buildInstructions.mockClear();
    // Auth gate must be open.
    process.env.MCP_AUTH_USERS = JSON.stringify([{ mcpToken: 'tok', name: 'T' }]);
  });

  it('pinned token, no tenant arg -> pin is enforced on the handler call', async () => {
    const res = await call({}, 'bonn');
    expect(res?.error).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ tenant: 'bonn' });
  });

  it('pinned token, own tenant arg -> allowed', async () => {
    const res = await call({ tenant: 'bonn' }, 'bonn');
    expect(res?.error).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ tenant: 'bonn' });
  });

  it('pinned token, foreign tenant arg -> FORBIDDEN, handler never called', async () => {
    const res = await call({ tenant: 'demo' }, 'bonn');
    expect(res?.error?.code).toBe(FORBIDDEN);
    expect(handler).not.toHaveBeenCalled();
  });

  it('pinned token, numeric foreign tenant arg -> FORBIDDEN (coercion-safe)', async () => {
    const res = await call({ tenant: 42 }, 'bonn');
    expect(res?.error?.code).toBe(FORBIDDEN);
    expect(handler).not.toHaveBeenCalled();
  });

  it('unpinned token -> tenant arg passes through untouched', async () => {
    const res = await call({ tenant: 'demo' }, undefined);
    expect(res?.error).toBeUndefined();
    expect(handler.mock.calls[0][0]).toMatchObject({ tenant: 'demo' });
  });

  it('initialize builds instructions from the caller context', async () => {
    const anon: UserContext = { authenticated: false };
    await dispatchMcp('initialize', {}, 1, anon, opts);
    expect(buildInstructions).toHaveBeenCalledWith(anon);
  });
});
