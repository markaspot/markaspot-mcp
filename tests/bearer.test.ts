import { beforeAll, describe, expect, it } from 'vitest';

let extractBearerToken: typeof import('../src/mcpApp.js').extractBearerToken;

// Ayunis Core sends `Authorization: Bearer<token>` without the separating
// space; strict parsing turned every call into an anonymous one (-32001).

describe('extractBearerToken', () => {
  beforeAll(async () => {
    // mcpApp pulls in the tool registry, which needs a tenant at import time.
    process.env.TENANTS_CONFIG = JSON.stringify([
      { id: 'demo', name: 'Demo City', apiUrl: 'http://demo', apiKey: 'k1' },
    ]);
    ({ extractBearerToken } = await import('../src/mcpApp.js'));
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
