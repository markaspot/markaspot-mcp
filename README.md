# MCP Server for GeoReport v2 (Open311)

This MCP server enables LLM frontends (any MCP-capable client, custom agents) to interact with any GeoReport v2/Open311 compliant backend using the Model Context Protocol (MCP).

## Quick Start

### Connect a local MCP client (for testing)

A stdio-only MCP client cannot talk to a remote HTTPS server directly. The
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) adapter bridges the gap:
the client launches it locally, and it forwards MCP traffic to the deployed server
over HTTPS, attaching your Bearer token.

Add the server to your MCP client's configuration file (the exact path depends on
the client; for stdio clients it is typically a JSON config under the client's
application support directory):

```json
{
  "mcpServers": {
    "georeport-demo": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-server-host>/api/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer <YOUR_BEARER_TOKEN>"
      }
    }
  }
}
```

Notes:

- The token lives in `env`, not inline in `--header`, to dodge `mcp-remote`'s
  space-in-argument quirk and keep the secret out of the args list.
- The token is the access key: no token, no access (gate-everything). It also
  pins which jurisdictions and toolsets the session may use, so knowing the URL
  alone grants nothing.
- Needs Node (for `npx`); the first launch downloads `mcp-remote`.
- To run it purely locally, start it yourself (`pnpm run build && node dist/server.js`)
  and point the same config at `http://127.0.0.1:3100/api/mcp` instead.

Then **fully quit and reopen your MCP client** (most clients load MCP servers only at
startup). In a new chat the server's tools should appear; try
*"List the service categories for jurisdiction 1."*

**Live demo endpoint:** `https://mcp.demo.mark-a-spot.com/api/mcp`
(EU/DSGVO, TLS via Traefik+Let's Encrypt; requires a valid Bearer token)

## Architecture

```
MCP client / agent
        |
    mcp-remote (stdio <-> HTTPS adapter)
        |
POST /api/mcp  (JSON-RPC, stateless)
        |
  src/server.ts  (Express, production entrypoint)
        |
  src/mcpApp.ts  (shared handleMcp() + Bearer extraction)
        |
  GeoReport v2 backend (Open311)
```

**Transport:** stateless JSON-RPC over HTTP `POST /api/mcp`. No SSE, no sessions.
The dev server (`src/index.ts`, `pnpm run dev`) uses Express+SSE and is not for production.

## Tools

The server ships 12 tools. Which are visible to a client depends on the toolset configuration for that deployment:

| Tool | Toolset | Description |
|------|---------|-------------|
| `list_services` | read | Available report categories |
| `list_requests` | read | Service requests with filters: status, service_code, date range, location + radius |
| `get_request` | read | Single request details by ID |
| `search_location` | read | Geocode addresses to coordinates via Nominatim |
| `create_request` | intake | Create new service request (service_code, lat, long, description, optional media_url) |
| `prepare_upload` | intake | Generate a one-time browser upload URL and token |
| `upload_image` | intake | Direct base64 image upload |
| `check_upload` | intake | Poll upload status by token |
| `update_request` | manage | Change status, add notes, assign agency |
| `add_comment` | manage | Add comment without changing status |
| `list_tenants` | manage | Show configured tenants |
| `get_stats` | reporting | Aggregated KPI statistics (read-only) |

**Toolsets** (`ENABLED_TOOLSETS`, comma-separated) are cut by function, not persona:
- `read` (baseline): browse tools (`list_services`, `list_requests`, `get_request`, `search_location`)
- `intake` (baseline): file reports and attach photos (`create_request` + upload helpers); covers citizen self-service and staff on-behalf
- `manage` (opt-in): staff write/admin (`update_request`, `add_comment`, `list_tenants`); requires `role: staff`
- `reporting` (opt-in): staff KPI analytics (`get_stats`); requires `role: staff`

`read` + `intake` are the default baseline for any valid token. Legacy persona aliases (`citizen`, `staff`) still resolve for backward compatibility.

The demo deployment enables `read,intake,reporting` and exposes 9 tools (no write tools, no `list_tenants`).

## Auth Model: Gate-Everything

**Default-deny.** No token means no access, including read-only tools.

**`MCP_AUTH_USERS`** is a JSON array mapping Bearer tokens to scoped permissions:

```json
[
  {
    "mcpToken": "<REPLACE_RANDOM_TOKEN>",
    "name": "Display Name",
    "tenant": "demo",
    "role": "staff",
    "allowedJurisdictions": ["1", "8"],
    "allowedToolsets": ["read", "intake", "reporting"]
  }
]
```

**Jurisdiction pinning** is the primary isolation mechanism. A token with
`allowedJurisdictions: ["1", "8"]` cannot reach jurisdiction 5, even if the caller
sends `jurisdiction_id: 5` explicitly. The dispatch rejects unknown jurisdictions; it
never silently overwrites them.

**Toolset scoping** (`allowedToolsets`) further restricts which tools the token
may call, independent of what the deployment enables globally.

**Legacy single token** (`MCP_AUTH_TOKEN`): unscoped operator access, staff role, no
jurisdiction pin. Only safe on a single-tenant server; rejected automatically on
multi-tenant deployments.

Generate tokens with: `openssl rand -hex 32`

## Photo Upload Flow

Standard Open311 requires an external `media_url`. The server provides a browser-assisted
upload flow so agents can attach photos without clipboard access:

1. Agent calls `prepare_upload` and receives an upload URL + token.
2. Agent presents the URL to the user. User opens it in a browser, previews the photo, and confirms.
3. Agent polls `check_upload` until `status: ready`.
4. Agent uses the returned `media_url` in `create_request`.

Photos are stored on the local filesystem (`UPLOAD_DIR=/data/uploads`, Docker volume).
TTL is 10 minutes. The GeoReport backend downloads `media_url` into its own storage at
`create_request` time; the server copy is dispensable afterwards.

## Multi-Tenant

The server targets **one backend stack** (one or more jurisdictions on one GeoReport v2
instance). It is not a central multiplexer across unrelated backends.

**Single-tenant:**

```env
GEOREPORT_SERVER_URL=https://your-georeport-server.com
GEOREPORT_API_KEY=citizen_key
GEOREPORT_STAFF_API_KEY=staff_key
```

**Multi-tenant** (`TENANTS_CONFIG` overrides single-tenant vars):

```env
TENANTS_CONFIG='[
  {
    "id": "demo",
    "name": "Demo City",
    "apiUrl": "https://demo.example.com",
    "apiKey": "citizen_key",
    "staffApiKey": "staff_key"
  }
]'
```

Tools accept an optional `tenant` parameter to target a specific tenant. Use
`list_tenants` (staff toolset) for discovery.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEOREPORT_SERVER_URL` | yes (single-tenant) | | GeoReport v2 base URL |
| `GEOREPORT_API_KEY` | yes (single-tenant) | | Citizen API key |
| `GEOREPORT_STAFF_API_KEY` | no | | Staff API key for update/comment tools |
| `TENANTS_CONFIG` | no | | JSON array for multi-tenant mode (overrides single-tenant vars) |
| `MCP_AUTH_USERS` | no | | JSON array mapping Bearer tokens to scoped permissions |
| `MCP_AUTH_TOKEN` | no | | Legacy single shared MCP auth token (single-tenant only) |
| `ENABLED_TOOLSETS` | no | `read,intake` | Comma-separated toolset IDs to expose |
| `MCP_SERVER_PORT` | no | `3100` | Express listen port |
| `PUBLIC_URL` | no | | Base URL for upload link generation |
| `UPLOAD_DIR` | no | `/data/uploads` | Local filesystem path for photo store |
| `UPLOAD_STORAGE` | no | `fs` | Storage backend (`fs` only) |
| `LOG_LEVEL` | no | `info` | Winston log level |

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Docker healthcheck + uptime monitoring |
| `POST` | `/api/mcp` | JSON-RPC MCP endpoint (requires `Authorization: Bearer <token>`) |
| `GET` | `/api/upload/:token` | Browser upload page (one-time, 10 min TTL) |
| `POST` | `/api/upload/:token` | Upload handler (base64 image body) |

Testing the MCP endpoint:

```bash
# Health check
curl https://<your-server-host>/health

# Tool listing (requires Bearer token)
curl -X POST https://<your-server-host>/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deployment: Docker Hardened Image

Production runs as a Docker Hardened Image (`dhi.io/node:24`), pnpm 11, non-root (UID 1000).

```bash
# Build (requires DHI subscription for dhi.io/node:24)
pnpm run build            # tsup bundles src/server.ts -> dist/server.js

# Run with Docker
docker run --rm \
  -p 3100:3100 \
  -v mcp-uploads:/data/uploads \
  -e TENANTS_CONFIG='...' \
  -e MCP_AUTH_USERS='...' \
  -e ENABLED_TOOLSETS=read,intake,reporting \
  markaspot/markaspot-mcp:latest
```

Production deployments use `deploy/docker-compose.mcp.yml` behind Traefik with TLS.
Tenant env comes from `tenants/<tenant>.mcp.env` (chmod 600, not committed).

See `deploy/mcp.env.example` for a complete annotated environment template.

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode (Express + SSE, dev-only)
pnpm run dev

# Build for production
pnpm run build            # output: dist/server.js

# Type checking
pnpm run typecheck

# Linting
pnpm run lint

# Tests
pnpm test
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `401 Unauthorized` | Bearer token missing or not in `MCP_AUTH_USERS` |
| `403 Forbidden` | Jurisdiction or toolset not in token's allowed scope |
| `405 Method Not Allowed` | Use `POST` for `/api/mcp`, not `GET` |
| Tool not visible | Check `ENABLED_TOOLSETS` and `allowedToolsets` on the token |
| Empty tool responses | Test GeoReport API directly; check `GEOREPORT_SERVER_URL` |
| `isAuthConfigured: false` | `MCP_AUTH_USERS` missing or empty; add at least one user |

## Security

- Bearer tokens are compared with `crypto.timingSafeEqual` to prevent timing attacks.
- Uploaded images are validated against file magic bytes (not client-claimed MIME type).
- `/uploads` serves files with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- CORS is enabled only on `/api/mcp`; upload and health endpoints are same-origin-only.
- No credentials are logged; the winston logger redacts secrets.
- HTTPS required for production.

## Related projects

This MCP server is part of the [Mark-a-Spot](https://mark-a-spot.com) ecosystem and is
backend-agnostic: it works against any GeoReport v2 / Open311 compliant backend.

- **[markaspot/markaspot](https://github.com/markaspot/markaspot)** — the Drupal GeoReport v2 / Open311 backend this server talks to (GPL-2.0-or-later)
- **[CivicSpot](https://civicspot.io)** — hosted, self-service edition of Mark-a-Spot; the quickest way to get a compatible GeoReport backend without self-hosting Drupal

The hosted MCP/chat integration with staff workflows is part of Mark-a-Spot Enterprise. See [mark-a-spot.com](https://mark-a-spot.com).

## License

Open source under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later). You may use, modify, and self-host markaspot-mcp freely.
If you run a modified version as a network service, the AGPL requires you to
make your modified source available to its users. See the LICENSE file.

## Maintained by

Built and maintained by [Civic Patches GmbH](https://mark-a-spot.com), Brühl, Germany.
For commercial support, hosting, or the Mark-a-Spot Enterprise edition, see [mark-a-spot.com](https://mark-a-spot.com).
