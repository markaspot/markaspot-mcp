# Marketplace Gateway (mcp.mark-a-spot.com)

One shared bridge instance behind a single public URL, for marketplaces that
pin exactly one endpoint per integration (first consumer: Ayunis Core).
Customers enter one Bearer token in the marketplace UI; the URL is fixed in the
listing. Routing to the customer's backend happens inside this gateway.

This complements, not replaces, the per-tenant bridges: direct/Enterprise
customers keep their own `mcp.<tenant>...` instances (see `mcp.env.example`).

## Security model (why one URL is safe)

- **Gate-everything:** no anonymous access; every call needs a configured
  Bearer token (`src/utils/userContext.ts`).
- **Tenant pinning:** each token is bound to exactly one tenant. A call
  targeting a foreign tenant returns FORBIDDEN, and the pin overrides the
  `tenant` argument (`src/utils/mcpDispatch.ts`). The tenant parameter is
  convenience, never authority.
- **Jurisdiction pinning + toolsets:** tokens are additionally scoped to
  jurisdictions and to `read,intake,reporting`. `manage` stays off on the
  shared gateway; request-id writes cannot be confined by jurisdiction pinning
  and belong on a single-tenant Enterprise bridge.
- **Credential splitting:** the GeoReport API keys live only in
  `TENANTS_CONFIG` on the server. Marketplace and customers only ever see the
  MCP token; revoking it never compromises the backend key.
- **Scoped handshake:** `initialize` is open (pre-auth), so its instructions
  are built from the caller's context: anonymous handshakes get generic
  guidance, a pinned token sees only its own tenant. The tenant registry (=
  customer list) is never enumerable.
- **Known limitation, shared rate limit:** the Traefik limit is one bucket per
  router, i.e. shared by all gateway organizations (availability, not
  confidentiality). Scale `MCP_RATELIMIT_*` in the env file with the customer
  count; move to token-keyed limiting when volume justifies it.

## First deploy (cp1)

1. **DNS:** A-record `mcp.mark-a-spot.com` -> cp1 (same target as the other
   `*.mark-a-spot.com` services on the host). Traefik issues the certificate
   via the existing `letsencrypt` resolver on first request.
2. **Env file:** copy `gateway.env.example` to
   `/opt/markaspot-cloud/tenants/gateway.mcp.env`, `chmod 600`, replace the
   placeholder keys/token.
3. **Start** (from `/opt/markaspot-cloud`). `MCP_ENV_FILE` must be an ABSOLUTE
   path: the compose `env_file` (`${MCP_ENV_FILE:-./mcp.env}`) resolves relative
   to the compose file's directory (`/opt/mcp-bridge/deploy`), not the CWD, so a
   bare start looks for `/opt/mcp-bridge/deploy/mcp.env` and fails. This mirrors
   how `rollout-mcp.sh` starts the per-tenant bridges.

   ```bash
   MCP_ENV_FILE=/opt/markaspot-cloud/tenants/gateway.mcp.env \
     docker compose --env-file tenants/gateway.mcp.env -p gateway-mcp \
     -f /opt/mcp-bridge/deploy/docker-compose.mcp.yml up -d
   ```

4. **Smoke:**

   ```bash
   curl -s https://mcp.mark-a-spot.com/health
   # tools/list with a valid token succeeds:
   curl -s -X POST https://mcp.mark-a-spot.com/api/mcp \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   # without a token: AUTH_REQUIRED, never data
   # with token pinned to tenant A, args {"tenant":"b"}: FORBIDDEN
   ```

## Onboarding a tenant

```bash
./mcp-add-tenant.sh /opt/markaspot-cloud/tenants/gateway.mcp.env \
  --id bonn --name "Stadt Bonn" \
  --api-url http://bonn-nginx-1:8080 \
  --api-key "$CITIZEN_KEY" --staff-api-key "$STAFF_KEY" \
  --jurisdictions 1 --default-jurisdiction 1 --default-lang de
```

- Co-located cp1 tenants use the internal nginx hostname
  (`http://<tenant>-nginx-1:8080`, no public hairpin); self-hosted clients use
  their public HTTPS GeoReport URL.
- The script prints the generated Bearer token once; hand it to the customer
  over a secure channel. Then recreate the container (command is printed).
- Offboarding/rotation: remove or replace the tenant's entries in
  `TENANTS_CONFIG`/`MCP_AUTH_USERS` (env file backup is created on every script
  run) and recreate.
- The `.bak-*` backups hold plaintext secrets (owner-only via umask, but they
  accumulate); prune them once the change is verified.

## Marketplace notes (Ayunis)

- The listing pins `https://mcp.mark-a-spot.com` as the only endpoint; the URL
  living on the product domain doubles as the "is this really your
  application" proof asked for during review.
- Assumption to confirm with the marketplace: organizations can store one
  credential per integration and it is sent as `Authorization: Bearer <token>`.
  Transport is stateless JSON-RPC over `POST /api/mcp` (Streamable-HTTP
  compatible, JSON responses).
- The existing review/demo token keeps working; move the demo tenant onto the
  gateway so reviewers use the final URL from day one.
