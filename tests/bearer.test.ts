import { beforeAll, describe, expect, it } from 'vitest';

let extractBearerToken: typeof import('../src/mcpApp.js').extractBearerToken;
let handleMcp: typeof import('../src/mcpApp.js').handleMcp;
let resolveUser: typeof import('../src/utils/userContext.js').resolveUser;

// Ayunis Core sends `Authorization: Bearer<token>` without the separating
// space; strict parsing turned every call into an anonymous one (-32001).

describe('extractBearerToken', () => {
  beforeAll(async () => {
    // mcpApp pulls in the tool registry, which needs a tenant at import time.
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'demo', name: 'Demo City', apiUrl: 'http://demo', apiKey: 'k1' },
    ]);
    process.env.MCP_AUTH_USERS = JSON.stringify([
      { mcpToken: 'tok123', name: 'Ayunis', tenant: 'demo' },
    ]);
    ({ extractBearerToken, handleMcp } = await import('../src/mcpApp.js'));
    ({ resolveUser } = await import('../src/utils/userContext.js'));
  });

  it('lets a space-less Bearer header through to tools/list', async () => {
    const ctx = resolveUser(extractBearerToken('Bearertok123'));
    expect(ctx.authenticated).toBe(true);
    const res = await handleMcp('tools/list', {}, 1, ctx);
    expect(res?.error).toBeUndefined();
    expect((res?.result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
  });

  it('still rejects a wrong token without the space', async () => {
    const ctx = resolveUser(extractBearerToken('Bearerwrong'));
    const res = await handleMcp('tools/list', {}, 1, ctx);
    expect(res?.error?.code).toBe(-32001);
  });

  it('keeps a token that itself starts with "bearer"', () => {
    expect(extractBearerToken('Bearerbearerxyz')).toBe('bearerxyz');
  });

  it('reads a standard Bearer header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('accepts a missing space after the scheme', () => {
    expect(extractBearerToken('Bearerabc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme and tolerates extra whitespace', () => {
    expect(extractBearerToken('bearer   abc123 ')).toBe('abc123');
    expect(extractBearerToken('BEARER\tabc123')).toBe('abc123');
  });

  it('takes the first value of a repeated header', () => {
    expect(extractBearerToken(['Bearer first', 'Bearer second'])).toBe('first');
  });

  it('rejects missing, empty or non-Bearer values', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(extractBearerToken('abc123')).toBeUndefined();
    expect(extractBearerToken('Bearer two tokens')).toBeUndefined();
  });
});
