// Request-shaping helpers: pure, side-effect-free, easy to unit test. They keep
// the LLM-friendly behavior (language resolution, forgiving jurisdiction
// resolution + teaching errors, response slimming + pagination notes) out of the
// individual tool handlers so the rules live in one place and stay consistent.
//
// IMPORTANT: the dispatch engine (mcpDispatch.ts) already pins a token's
// jurisdiction onto enforced.jurisdiction_id BEFORE the handler runs. These
// helpers only ADD the tenant-default stage and forgiving coercion; they never
// override an already-resolved value.

import { getAllJurisdictions } from './tenantConfig.js';

/**
 * Resolve the effective language: explicit arg -> per-tenant default ->
 * undefined (let the backend pick its own default). ISO 639-1 codes; we do not
 * validate the code here (the backend ignores unknown ones).
 */
export function resolveLang(argLang?: string, tenantDefaultLang?: string): string | undefined {
  if (argLang && argLang.trim()) return argLang.trim();
  if (tenantDefaultLang && tenantDefaultLang.trim()) return tenantDefaultLang.trim();
  return undefined;
}

/**
 * Map a resolved language to the GeoReport backend's Accept-Language header.
 * Returns an empty object when no language is set, so callers can spread it
 * unconditionally into a headers object.
 */
export function acceptLanguageHeaders(lang?: string): Record<string, string> {
  return lang ? { 'Accept-Language': lang } : {};
}

/**
 * Forgiving jurisdiction resolution. Precedence:
 *   1. explicit arg (string or number, coerced to string)
 *   2. per-tenant default
 *   3. undefined
 * The dispatch has already set the TOKEN stage onto args.jurisdiction_id when a
 * token is jurisdiction-pinned, so an existing value is respected and only the
 * tenant-default stage is added on top. Never overrides an already-set value.
 */
export function resolveJurisdiction(
  args: { jurisdiction_id?: string | number },
  tenantDefault?: string,
): string | undefined {
  const raw = args?.jurisdiction_id;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return String(raw).trim();
  }
  if (tenantDefault && String(tenantDefault).trim() !== '') {
    return String(tenantDefault).trim();
  }
  return undefined;
}

/**
 * Teaching error for a missing jurisdiction_id. Lists the jurisdictions this
 * deployment actually serves (from the JURISDICTIONS env, surfaced via
 * getAllJurisdictions) so the model can pick one and retry instead of getting a
 * raw 400. Returns an Error so the handler can `throw` it.
 */
export function jurisdictionRequiredError(): Error {
  const jurisdictions = getAllJurisdictions();
  const served = jurisdictions
    .map((j) => `${j.name} (jurisdiction_id=${j.id})`)
    .join(', ');
  const hint = served
    ? ` This deployment serves: ${served}.`
    : '';
  return new Error(`jurisdiction_id required; pass one to scope the request.${hint}`);
}

/**
 * Guard for jurisdiction-scoped tools. When the deployment serves more than one
 * jurisdiction (JURISDICTIONS env has 2+) and none has been resolved for this
 * call, throw a teaching error listing the choices instead of letting the
 * backend return a raw 400. A single-jurisdiction (or unconfigured) deployment
 * needs no choice, so it is left to fall through unscoped.
 */
export function requireJurisdiction(resolved?: string): void {
  if (resolved) return;
  if (getAllJurisdictions().length > 1) {
    throw jurisdictionRequiredError();
  }
}

// Fields kept for a slimmed list item. Everything else (extended_attributes,
// Drupal internals like revision_id/langcode/vid/content_translation_*) is
// dropped. Full detail is available on demand via get_request.
interface SlimRequestItem {
  service_request_id?: string;
  title?: string;
  // description + address_string are useful in a management/manage list view and
  // are not a PII regress: get_request already returns these same fields
  // unredacted to the same caller, so including them here just avoids an N+1
  // get_request roundtrip per row.
  description?: string;
  address_string?: string;
  status?: string;
  service_code?: string;
  service_name?: string;
  requested_datetime?: string;
  lat?: number | string;
  long?: number | string;
  // A single (or comma-separated) image URL. Already rewritten to the public
  // frontend image proxy by transformMediaUrls() before slimming, so the list
  // carries loadable thumbnails without an N+1 get_request per row.
  media_url?: string;
}

export interface SlimRequestList {
  requests: SlimRequestItem[];
  meta: {
    total?: number;
    returned: number;
    next_cursor?: string;
    note: string;
  };
}

/** Map one raw upstream request object to the whitelisted slim shape. */
function slimItem(raw: Record<string, any>): SlimRequestItem {
  const item: SlimRequestItem = {
    service_request_id: raw.service_request_id,
    // Prefer an explicit title, fall back to the service name for a label.
    title: raw.title ?? raw.service_name,
    description: raw.description,
    address_string: raw.address_string,
    status: raw.status,
    service_code: raw.service_code,
    service_name: raw.service_name,
    requested_datetime: raw.requested_datetime,
    lat: raw.lat,
    long: raw.long,
    media_url: raw.media_url,
  };
  // Drop keys that came back undefined so the slim object stays tight.
  for (const k of Object.keys(item) as (keyof SlimRequestItem)[]) {
    if (item[k] === undefined) delete item[k];
  }
  return item;
}

/**
 * Slim a list-requests response. Accepts either the backend's
 * `{ requests: [...], meta: {...} }` shape OR a flat array of request objects.
 * Returns only whitelisted fields per item plus a compact pagination meta with a
 * human-readable hint the model can act on.
 */
export function slimRequestList(raw: any): SlimRequestList {
  const isWrapped = raw && typeof raw === 'object' && Array.isArray(raw.requests);
  const items: Record<string, any>[] = isWrapped
    ? raw.requests
    : Array.isArray(raw)
      ? raw
      : [];
  const meta = (isWrapped && raw.meta && typeof raw.meta === 'object') ? raw.meta : {};

  const requests = items.map(slimItem);
  const returned = requests.length;
  const total: number | undefined =
    typeof meta.total === 'number' ? meta.total : undefined;
  const next_cursor: string | undefined =
    typeof meta.next_cursor === 'string' && meta.next_cursor ? meta.next_cursor : undefined;

  let note: string;
  if (total !== undefined && next_cursor) {
    note = `showing ${returned} of ${total}; continue with cursor=${next_cursor}`;
  } else if (total !== undefined) {
    note = `showing ${returned} of ${total}`;
  } else if (next_cursor) {
    note = `showing ${returned}; more available, continue with cursor=${next_cursor}`;
  } else {
    note = `showing ${returned}`;
  }

  return {
    requests,
    meta: {
      ...(total !== undefined ? { total } : {}),
      returned,
      ...(next_cursor ? { next_cursor } : {}),
      note,
    },
  };
}
