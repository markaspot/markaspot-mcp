import { logger } from './logger.js';

export interface TenantConfig {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  staffApiKey?: string;
  // Optional per-tenant defaults used by the request-shaping helpers. They feed
  // the "tenant default" precedence stage between an explicit arg and the
  // backend default (see requestShaping.ts). A single-jurisdiction tenant can
  // set defaultJurisdiction so the model never has to supply it; defaultLang
  // localizes taxonomy/labels when the model omits `lang`.
  defaultJurisdiction?: string;
  defaultLang?: string;
  // Public base URL of the Nuxt frontend for this tenant (e.g.
  // "https://demo.mark-a-spot.com"). When set, GeoReport `media_url` values are
  // rewritten to the frontend's public image proxy (<base>/api/images/...) so
  // external MCP consumers get a loadable, optimized image URL instead of the
  // raw internal backend file URL. Falls back to the FRONTEND_BASE_URL env.
  frontendBaseUrl?: string;
}

let tenantRegistry: TenantConfig[] | null = null;

function loadTenants(): TenantConfig[] {
  if (tenantRegistry !== null) return tenantRegistry;

  const tenantsJson = process.env.TENANTS_CONFIG;
  if (tenantsJson) {
    try {
      tenantRegistry = JSON.parse(tenantsJson);
      logger.info(`Loaded ${tenantRegistry!.length} tenant(s) from TENANTS_CONFIG`);
      return tenantRegistry!;
    } catch (e) {
      logger.error('Failed to parse TENANTS_CONFIG', e);
    }
  }

  // Fallback: single-tenant from individual env vars
  const apiUrl = process.env.GEOREPORT_SERVER_URL || process.env.MARKASPOT_API_URL;
  const apiKey = process.env.GEOREPORT_API_KEY || process.env.MARKASPOT_API_TOKEN;

  if (apiUrl && apiKey) {
    tenantRegistry = [{
      id: 'default',
      name: process.env.TENANT_NAME || 'Default',
      apiUrl,
      apiKey,
      staffApiKey: process.env.GEOREPORT_STAFF_API_KEY,
      frontendBaseUrl: process.env.FRONTEND_BASE_URL,
    }];
  } else {
    tenantRegistry = [];
  }

  return tenantRegistry;
}

export function getTenant(tenantId?: string): TenantConfig {
  const tenants = loadTenants();

  if (!tenantId || tenantId === 'default') {
    if (tenants.length === 0) {
      throw new Error('No tenants configured. Set TENANTS_CONFIG or GEOREPORT_SERVER_URL.');
    }
    return tenants[0];
  }

  const tenant = tenants.find(t => t.id === tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantId}. Available: ${tenants.map(t => t.id).join(', ')}`);
  }
  return tenant;
}

export function getAllTenants(): TenantConfig[] {
  return loadTenants();
}

/**
 * Per-tenant default jurisdiction, if configured. Used as a fallback when a
 * tool call omits jurisdiction_id and the token is not pinned to exactly one.
 * Returns undefined when no tenant is configured (callers treat that as "no
 * default").
 */
export function getTenantDefaultJurisdiction(tenantId?: string): string | undefined {
  try {
    return getTenant(tenantId).defaultJurisdiction;
  } catch {
    return undefined;
  }
}

/**
 * Per-tenant default language (ISO 639-1), if configured. Used as the middle
 * precedence stage for `lang` (explicit arg -> tenant default -> backend
 * default).
 */
export function getTenantDefaultLang(tenantId?: string): string | undefined {
  try {
    return getTenant(tenantId).defaultLang;
  } catch {
    return undefined;
  }
}

/**
 * Public frontend base URL for a tenant, used to rewrite GeoReport `media_url`
 * to the frontend image proxy. Precedence: per-tenant `frontendBaseUrl` ->
 * FRONTEND_BASE_URL env. Returns undefined when neither is set (media URLs pass
 * through untouched).
 */
export function getTenantFrontendBaseUrl(tenantId?: string): string | undefined {
  try {
    return getTenant(tenantId).frontendBaseUrl ?? process.env.FRONTEND_BASE_URL;
  } catch {
    return process.env.FRONTEND_BASE_URL;
  }
}

/**
 * Reset cached registry (for testing or dynamic reload).
 */
export function resetTenantRegistry(): void {
  tenantRegistry = null;
  jurisdictionRegistry = null;
}

// --- Jurisdiction support ---
// Each jurisdiction on a single backend can have its own API key.
// Configured via JURISDICTIONS env var:
// [{"id":"1","name":"Amsterdam","apiKey":"abc"},{"id":"8","name":"BCP Council","apiKey":"xyz"}]

export interface JurisdictionConfig {
  id: string;
  name: string;
  apiKey?: string;
}

let jurisdictionRegistry: JurisdictionConfig[] | null = null;

function loadJurisdictions(): JurisdictionConfig[] {
  if (jurisdictionRegistry !== null) return jurisdictionRegistry;

  const json = process.env.JURISDICTIONS;
  if (json) {
    try {
      jurisdictionRegistry = JSON.parse(json);
      return jurisdictionRegistry!;
    } catch (e) {
      logger.error('Failed to parse JURISDICTIONS', e);
    }
  }
  jurisdictionRegistry = [];
  return jurisdictionRegistry;
}

/**
 * Get the API key for a specific jurisdiction, if configured.
 * Returns undefined if no jurisdiction-specific key exists (falls back to tenant default).
 */
export function getJurisdictionApiKey(jurisdictionId?: string): string | undefined {
  if (!jurisdictionId) return undefined;
  const jurisdictions = loadJurisdictions();
  const jur = jurisdictions.find(j => j.id === jurisdictionId);
  return jur?.apiKey;
}

export function getAllJurisdictions(): JurisdictionConfig[] {
  return loadJurisdictions();
}
