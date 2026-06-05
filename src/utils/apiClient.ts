import { logger } from './logger.js';
import { getTenant } from './tenantConfig.js';

export interface ApiClientOptions {
  tenantId?: string;
  apiKeyOverride?: string;
}

export interface RequestConfig {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface ApiResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
}

/**
 * Error that mirrors the shape of an axios error so existing consumers keep
 * working: `api/mcp.ts` and `listServices.ts` read `error.response.{status,
 * statusText,data}` to format messages. On network/timeout errors `response`
 * is undefined and `request` is set, so callers fall back to `error.message`.
 */
export class ApiError extends Error {
  response?: { status: number; statusText: string; data: unknown; config: { url: string } };
  request?: boolean;

  constructor(
    message: string,
    response?: ApiError['response'],
    isRequestError = false,
  ) {
    super(message);
    this.name = 'ApiError';
    if (response) this.response = response;
    if (isRequestError) this.request = true;
  }
}

export interface ApiClient {
  get<T = any>(url: string, config?: RequestConfig): Promise<ApiResponse<T>>;
  post<T = any>(url: string, data?: string | object, config?: RequestConfig): Promise<ApiResponse<T>>;
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * True only for genuine *.ddev.site hosts. A proper hostname check (not a
 * substring match) so that a hostile URL like https://x.ddev.site.attacker.com
 * does NOT qualify, since its hostname ends in .attacker.com.
 */
function isDdevHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ddev.site' || host.endsWith('.ddev.site');
  } catch {
    return false;
  }
}

/**
 * Factory: creates a fetch-based client configured for a specific tenant and
 * auth level. Replaces the previous axios instance while preserving its
 * interface (`.get`/`.post` returning `{data,status,statusText}`, throwing on
 * non-2xx) and behavior (api_key injection, 30s timeout).
 *
 * When tenantId is omitted, uses the default (first) tenant.
 * apiKeyOverride lets staff tools inject the staff API key.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const tenant = getTenant(options.tenantId);
  const apiKey = options.apiKeyOverride || tenant.apiKey;
  const baseURL = tenant.apiUrl;

  // DDEV serves self-signed certs. The previous axios client used a per-instance
  // httpsAgent with rejectUnauthorized:false; native fetch has no equivalent
  // option (and undici is not importable here), so TLS verification is disabled
  // process-wide. This is gated twice so it can never weaken production traffic:
  //   1. only outside production (NODE_ENV !== 'production')
  //   2. only for a genuine *.ddev.site backend host (not a substring match)
  // NOTE: this remains process-wide for the local Express dev server, so in
  // local dev it also relaxes TLS for other outbound calls (e.g. Nominatim).
  // Acceptable for local development; never active in production.
  if (
    process.env.NODE_ENV !== 'production' &&
    isDdevHost(baseURL) &&
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
  ) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    logger.warn('TLS verification disabled for local ddev.site backend (development only)');
  }

  async function request<T>(
    method: 'GET' | 'POST',
    url: string,
    data?: string | object,
    config: RequestConfig = {},
  ): Promise<ApiResponse<T>> {
    const isGeoreport = url.includes('/georeport/v2/');
    const params: Record<string, unknown> = { ...(config.params || {}) };
    const headers: Record<string, string> = { ...(config.headers || {}) };

    // api_key injection, mirroring the old request interceptor:
    // - GET: api_key as query param
    // - POST with object body: api_key merged into the body
    // - POST with string body (form-encoded): left untouched, the tool adds api_key itself
    // - non-georeport URLs: api_key as X-API-Key header
    if (apiKey && isGeoreport) {
      if (method === 'GET') {
        params.api_key = apiKey;
      } else if (data && typeof data === 'object') {
        data = { ...(data as Record<string, unknown>), api_key: apiKey };
      }
    } else if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    // Serialize the POST body once.
    let body: string | undefined;
    if (method === 'POST' && data !== undefined) {
      if (typeof data === 'string') {
        body = data;
      } else {
        body = JSON.stringify(data);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    // Build the absolute URL with query string.
    const fullUrl = new URL(url.startsWith('http') ? url : baseURL.replace(/\/+$/, '') + url);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        fullUrl.searchParams.set(key, String(value));
      }
    }

    const cleanUrl = fullUrl.toString().replace(/api_key=[^&]*/g, 'api_key=***');
    logger.debug(`API Request: ${method} ${cleanUrl}`);

    // Timeout via AbortController (axios used a 30s instance timeout).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const onNetworkError = (err: unknown): never => {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const message = aborted
        ? `timeout of ${DEFAULT_TIMEOUT_MS}ms exceeded`
        : (err instanceof Error ? err.message : 'Network error');
      logger.error('API No Response', message);
      throw new ApiError(message, undefined, true);
    };

    let res: Response;
    try {
      res = await fetch(fullUrl, { method, headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      return onNetworkError(err);
    }

    // Read the body while the timeout is still armed, so a backend that flushes
    // headers fast but stalls the body still hits the 30s abort (axios bounded
    // the whole response, not just the headers).
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      return onNetworkError(err);
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown = text;
    const contentType = res.headers.get('content-type') || '';
    const looksJson = text.trim().startsWith('{') || text.trim().startsWith('[');
    if (contentType.includes('application/json') || looksJson) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    logger.debug(`API Response: ${res.status} ${cleanUrl}`);

    // Mirror axios: throw on non-2xx with an axios-shaped error.
    if (!res.ok) {
      logger.error(`API Error Response: ${res.status} ${cleanUrl}`, { data: parsed });
      throw new ApiError(
        `Request failed with status code ${res.status}`,
        { status: res.status, statusText: res.statusText, data: parsed, config: { url: cleanUrl } },
      );
    }

    return { data: parsed as T, status: res.status, statusText: res.statusText };
  }

  return {
    get: (url, config) => request('GET', url, undefined, config),
    post: (url, data, config) => request('POST', url, data, config),
  };
}

// Default singleton for backward compatibility
export const apiClient = createApiClient();
