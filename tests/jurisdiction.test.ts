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

  it('multiple allowed, no arg -> teaching tool error listing both', async () => {
    const res = await call({}, ['1', '8']);
    expect(res?.error).toBeUndefined();
    expect(res?.result?.isError).toBe(true);
    expect(res?.result?.content[0].text).toContain('allowed: 1, 8');
    expect(handler).not.toHaveBeenCalled();
  });

  it('numeric arg within allowed -> coerced to string and enforced', async () => {
    const res = await call({ jurisdiction_id: 8 }, ['1', '8']);
    expect(res?.error).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ jurisdiction_id: '8' });
  });

  it('arg outside allowed -> denied as tool error, handler never called', async () => {
    const res = await call({ jurisdiction_id: '99' }, ['1', '8']);
    expect(res?.error).toBeUndefined();
    expect(res?.result?.isError).toBe(true);
    expect(res?.result?.content[0].text).toMatch(/not allowed.*allowed: 1, 8/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler failure -> tool error with the message, not a JSON-RPC error', async () => {
    handler.mockRejectedValueOnce(new Error('upstream down'));
    const res = await call({}, ['1']);
    expect(res?.error).toBeUndefined();
    expect(res?.result).toEqual({ content: [{ type: 'text', text: 'upstream down' }], isError: true });
  });
});

describe('jurisdiction hint in tools/list', () => {
  const schemaRegistry = new Map<string, Tool>([
    [
      'list_requests',
      {
        definition: {
          name: 'list_requests',
          description: 'list',
          inputSchema: {
            type: 'object',
            properties: { jurisdiction_id: { type: 'string', description: 'Filter by city.' } },
          },
        },
        handler,
      },
    ],
  ]);
  const listOpts: DispatchOptions = { ...opts, registry: schemaRegistry };
  const list = (allowedJurisdictions?: string[]) =>
    dispatchMcp('tools/list', {}, 1, { authenticated: true, role: 'citizen', allowedJurisdictions }, listOpts);
  const desc = (res: any) => res?.result?.tools[0].inputSchema.properties.jurisdiction_id.description;

  beforeEach(() => {
    process.env.MCP_AUTH_USERS = JSON.stringify([{ mcpToken: 'tok', name: 'T' }]);
  });

  it('multiple allowed -> property and tool description name them as required', async () => {
    const res: any = await list(['1', '8']);
    expect(desc(res)).toBe('Required for this token: pass one of jurisdiction_id 1, 8. Omitting it fails.');
    expect(res.result.tools[0].description).toBe('list\n\nFor this token: Required for this token: pass one of jurisdiction_id 1, 8. Omitting it fails.');
  });

  it('single allowed -> says it is applied automatically', async () => {
    expect(desc(await list(['1']))).toBe('This token is limited to jurisdiction_id 1; it is applied automatically when omitted.');
  });

  it('unscoped token -> definition untouched, registry not mutated', async () => {
    expect(desc(await list())).toBe('Filter by city.');
    await list(['1']);
    const stored = schemaRegistry.get('list_requests')!.definition;
    expect((stored.inputSchema as any).properties.jurisdiction_id.description).toBe('Filter by city.');
    expect(stored.description).toBe('list');
  });
});
