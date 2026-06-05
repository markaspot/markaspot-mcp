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

// list_requests is a read/jurisdiction-scoped tool; the handler is a spy so we
// can assert which jurisdiction_id the dispatch enforced before calling it.
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

const opts: DispatchOptions = {
  registry,
  serverInfo: { name: 'test', version: '0.0.0' },
  buildInstructions: () => 'test',
  toolsetForTool,
  isToolDeploymentEnabled: () => true,
  staffToolsets: STAFF_TOOLSETS,
  jurisdictionTools: JURISDICTION_TOOLS,
};

function call(args: Record<string, unknown>, allowedJurisdictions: string[]) {
  const ctx: UserContext = { authenticated: true, role: 'citizen', allowedJurisdictions };
  return dispatchMcp('tools/call', { name: 'list_requests', arguments: args }, 1, ctx, opts);
}

describe('jurisdiction pinning (dispatch)', () => {
  beforeEach(() => {
    handler.mockClear();
    // Auth gate must be open.
    process.env.MCP_AUTH_USERS = JSON.stringify([{ mcpToken: 'tok', name: 'T' }]);
  });

  it('single allowed jurisdiction, no arg -> enforces that one', async () => {
    const res = await call({}, ['1']);
    expect(res?.error).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ jurisdiction_id: '1' });
  });

  it('multiple allowed, no arg -> teaching error listing both', async () => {
    const res = await call({}, ['1', '8']);
    expect(res?.error?.code).toBe(FORBIDDEN);
    expect(res?.error?.message).toContain('1');
    expect(res?.error?.message).toContain('8');
    expect(handler).not.toHaveBeenCalled();
  });

  it('numeric arg within allowed -> coerced to string and enforced', async () => {
    const res = await call({ jurisdiction_id: 8 }, ['1', '8']);
    expect(res?.error).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ jurisdiction_id: '8' });
  });

  it('arg outside allowed -> FORBIDDEN', async () => {
    const res = await call({ jurisdiction_id: '99' }, ['1', '8']);
    expect(res?.error?.code).toBe(FORBIDDEN);
    expect(handler).not.toHaveBeenCalled();
  });
});
