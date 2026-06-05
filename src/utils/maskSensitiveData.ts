// Utility function to mask sensitive data in any object/string
// Uses WeakSet to prevent infinite recursion on circular references

// Substrings that mark a credential-bearing field name. Matched case-insensitively
// against object keys. 'authorization' (not 'auth') avoids masking 'author'.
const SENSITIVE_KEY_NEEDLES = [
  'api_key', 'apikey', 'token', 'password', 'secret',
  'staffkey', 'authorization', 'bearer', 'credential',
];

export function maskSensitiveData(data: any, seen: WeakSet<object> = new WeakSet()): any {
  if (typeof data === 'string') {
    return data
      .replace(/api_key["\s]*[:=]["\s]*[a-zA-Z0-9]+/gi, 'api_key=***')
      .replace(
        /("(?:api_key|apiKey|token|access_token|refresh_token|staffKey|authorization|bearer|secret)":\s*")[^"]+/gi,
        '$1***',
      );
  }

  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    if (seen.has(data)) return '[Circular]';
    seen.add(data);
    return data.map(item => maskSensitiveData(item, seen));
  }

  if (typeof data === 'object') {
    // Check for circular reference
    if (seen.has(data)) {
      return '[Circular]';
    }
    seen.add(data);

    const masked: Record<string, any> = {};
    for (const key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;

      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEY_NEEDLES.some((needle) => lowerKey.includes(needle))) {
        masked[key] = '***';
      } else {
        masked[key] = maskSensitiveData(data[key], seen);
      }
    }
    return masked;
  }

  return data;
}