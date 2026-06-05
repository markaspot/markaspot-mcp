import { getTenant } from './tenantConfig.js';

export type AuthLevel = 'citizen' | 'staff';

/**
 * Returns the appropriate API key for the given auth level and tenant.
 * Staff level requires a separate GEOREPORT_STAFF_API_KEY (or staffApiKey in TENANTS_CONFIG).
 */
export function getApiKey(level: AuthLevel, tenantId?: string): string {
  const tenant = getTenant(tenantId);

  if (level === 'staff') {
    const staffKey = tenant.staffApiKey;
    if (!staffKey) {
      throw new Error(
        `No staff API key configured${tenantId ? ` for tenant "${tenantId}"` : ''}. ` +
        'Set GEOREPORT_STAFF_API_KEY or include staffApiKey in TENANTS_CONFIG.'
      );
    }
    return staffKey;
  }

  return tenant.apiKey;
}
