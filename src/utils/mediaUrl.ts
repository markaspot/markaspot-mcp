// Rewrites GeoReport `media_url` values to the public frontend image proxy.
//
// Why: the Mark-a-Spot Nuxt frontend already rewrites Drupal file URLs to its
// own `/api/images/...` proxy (see frontend server/utils/media-url.ts), so the
// browser never loads raw backend file URLs. MCP / GeoReport consumers (e.g.
// Ayunis or other MCP clients) bypass the frontend and get the RAW upstream `media_url`,
// which on a containerized backend is an internal, non-resolvable host
// (e.g. `http://demo-nginx-1:8080/sites/default/files/...`). This module mirrors
// the frontend transform but emits an ABSOLUTE URL (frontend host +
// `/api/images/<drupal-file-path>`) because an MCP client cannot resolve a
// relative path.
//
// It is a no-op when no frontend base URL is configured for the tenant, so the
// behavior is backward compatible: an unconfigured deployment passes media URLs
// through untouched.

const IMAGE_PROXY_PATH = '/api/images';

/**
 * Extract the core Drupal file path (`sites/<site>/files/...` or
 * `system/files/...`) from a URL path, stripping the host and any reverse-proxy
 * prefix like `/management/`. Returns the path from the LAST valid files-dir
 * marker (mirrors the greedy regex this replaced) or null when none is present.
 *
 * Implemented as a linear scan with a bounded marker pattern (a single `[^/]+`,
 * no nested quantifiers) instead of a `(?:^|.*\/)(...)` regex whose greedy
 * `.*\/` prefix backtracks O(n^2) (ReDoS) on long non-matching input a
 * misbehaving backend could send. A fresh regex per call keeps it
 * concurrency-safe (no shared lastIndex state).
 */
function extractDrupalFilePath(path: string): string | null {
  const marker = /(?:sites\/(?:[^/]+\/)?files|system\/files)\//g;
  let lastIndex = -1;
  for (const m of path.matchAll(marker)) {
    if (typeof m.index === 'number') lastIndex = m.index;
  }
  return lastIndex === -1 ? null : path.slice(lastIndex);
}

/** Drop trailing slashes so path segments join cleanly. */
function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Rewrite one media URL to an absolute frontend image-proxy URL.
 *
 * Returns the input unchanged when:
 *  - no `frontendBase` is configured (no-op / backward compatible),
 *  - the URL is empty,
 *  - the URL already points at the image proxy (idempotent),
 *  - the URL is not a recognizable Drupal file URL (conservative: never guess).
 */
export function rewriteMediaUrl(originalUrl: string, frontendBase?: string): string {
  if (!frontendBase || !frontendBase.trim()) return originalUrl;
  if (!originalUrl || !originalUrl.trim()) return originalUrl;

  const base = normalizeBase(frontendBase.trim());
  // Defense-in-depth: only emit proxy URLs for an http(s) base. A misconfigured
  // non-HTTP base (bad scheme, relative path) skips the rewrite rather than
  // emitting a malformed URL to MCP clients.
  try {
    const scheme = new URL(base).protocol;
    if (scheme !== 'http:' && scheme !== 'https:') return originalUrl;
  } catch {
    return originalUrl;
  }
  const proxyPrefix = `${base}${IMAGE_PROXY_PATH}`;

  // Already proxied (absolute or relative) -> leave as-is, do not double-proxy.
  if (originalUrl.startsWith(proxyPrefix) || originalUrl.startsWith(IMAGE_PROXY_PATH)) {
    return originalUrl;
  }

  const toProxy = (filePath: string): string => `${proxyPrefix}/${filePath.replace(/^\/+/, '')}`;

  try {
    if (/^https?:\/\//i.test(originalUrl)) {
      // Full URL with scheme+host: pull the Drupal file path out of the pathname.
      // Note: .pathname intentionally drops any query string (e.g. a style
      // derivative's `?itok=`), mirroring the frontend util (media-url.ts). The
      // GeoReport media_url is the original public file (no token), so this is a
      // non-issue in practice; the relative branch below keeps any query tail.
      const path = extractDrupalFilePath(new URL(originalUrl).pathname);
      if (path) return toProxy(path);
      // Not a recognizable Drupal file URL: don't guess, leave it untouched.
      return originalUrl;
    }

    // Relative path (with or without leading slash) containing a files dir. Any
    // query string rides along in the captured tail (preserved on purpose).
    const path = extractDrupalFilePath(originalUrl);
    if (path) return toProxy(path);

    // Unrecognized shape: conservative, leave unchanged.
    return originalUrl;
  } catch {
    // Malformed URL etc.: never throw out of a response shaper.
    return originalUrl;
  }
}

/** Rewrite the `media_url` field on one request item (handles comma-separated lists). */
function rewriteItem(item: unknown, frontendBase: string): void {
  if (
    item &&
    typeof item === 'object' &&
    typeof (item as Record<string, unknown>).media_url === 'string'
  ) {
    const obj = item as Record<string, string>;
    if (!obj.media_url) return;
    obj.media_url = obj.media_url
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => rewriteMediaUrl(u, frontendBase))
      .join(',');
  }
}

/**
 * Rewrite every `media_url` in a GeoReport response to the public frontend image
 * proxy. Handles the wrapped `{ requests: [...] }` shape, a flat array, and a
 * single request object. Mutates and returns the same object.
 *
 * No-op (returns the input untouched) when `frontendBase` is unset, so callers
 * can apply it unconditionally.
 */
export function transformMediaUrls<T>(data: T, frontendBase?: string): T {
  if (!frontendBase || !frontendBase.trim()) return data;
  if (!data || typeof data !== 'object') return data;

  const d = data as Record<string, unknown>;
  if (Array.isArray(d)) {
    d.forEach((item) => rewriteItem(item, frontendBase));
  } else if (Array.isArray(d.requests)) {
    (d.requests as unknown[]).forEach((item) => rewriteItem(item, frontendBase));
  } else {
    rewriteItem(d, frontendBase);
  }
  return data;
}
