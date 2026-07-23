#!/usr/bin/env bash
# mcp-add-tenant.sh - onboard one tenant onto a shared MCP gateway env file.
#
# Appends one entry to TENANTS_CONFIG and one tenant-pinned Bearer token to
# MCP_AUTH_USERS in the given env file (see gateway.env.example), then prints
# the generated token and the compose command to apply the change. The env file
# is backed up next to itself before editing. JSON editing is delegated to
# python3 (present on the cp1 host); the script refuses duplicate tenant ids.
#
# Usage:
#   mcp-add-tenant.sh <env-file> --id <tenant-id> --name <display-name> \
#     --api-url <georeport-url> --api-key <citizen-key> \
#     [--staff-api-key <staff-key>] [--jurisdictions <id,id,...>] \
#     [--default-jurisdiction <id>] [--default-lang <iso639-1>] \
#     [--toolsets read,intake,reporting] [--role staff|citizen] [--token <token>]
#
# Example (co-located cp1 tenant):
#   ./mcp-add-tenant.sh /opt/markaspot-cloud/tenants/gateway.mcp.env \
#     --id bonn --name "Stadt Bonn" --api-url http://bonn-nginx-1:8080 \
#     --api-key "$CITIZEN_KEY" --staff-api-key "$STAFF_KEY" \
#     --jurisdictions 1 --default-jurisdiction 1 --default-lang de
set -euo pipefail
# Everything this script creates (backups of the env file) holds plaintext
# secrets; make new files owner-only regardless of the caller's umask.
umask 077

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

[ $# -ge 1 ] || usage
ENV_FILE=$1
shift

TENANT_ID="" TENANT_NAME="" API_URL="" API_KEY="" STAFF_API_KEY=""
JURISDICTIONS="" DEFAULT_JURISDICTION="" DEFAULT_LANG=""
TOOLSETS="read,intake,reporting" ROLE="staff" TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --id) TENANT_ID=$2; shift 2 ;;
    --name) TENANT_NAME=$2; shift 2 ;;
    --api-url) API_URL=$2; shift 2 ;;
    --api-key) API_KEY=$2; shift 2 ;;
    --staff-api-key) STAFF_API_KEY=$2; shift 2 ;;
    --jurisdictions) JURISDICTIONS=$2; shift 2 ;;
    --default-jurisdiction) DEFAULT_JURISDICTION=$2; shift 2 ;;
    --default-lang) DEFAULT_LANG=$2; shift 2 ;;
    --toolsets) TOOLSETS=$2; shift 2 ;;
    --role) ROLE=$2; shift 2 ;;
    --token) TOKEN=$2; shift 2 ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "Env file not found: $ENV_FILE" >&2; exit 1; }
[ -n "$TENANT_ID" ] && [ -n "$TENANT_NAME" ] && [ -n "$API_URL" ] && [ -n "$API_KEY" ] || usage

if [ -z "$TOKEN" ]; then
  TOKEN=$(openssl rand -hex 32)
fi

BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d%H%M%S)"
cp "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP" 2>/dev/null || true

export ENV_FILE TENANT_ID TENANT_NAME API_URL API_KEY STAFF_API_KEY \
  JURISDICTIONS DEFAULT_JURISDICTION DEFAULT_LANG TOOLSETS ROLE TOKEN

python3 - <<'PYEOF'
import json, os, sys

env_file = os.environ['ENV_FILE']
with open(env_file) as f:
    lines = f.readlines()

def edit_json_line(key, mutate):
    prefix = key + '='
    for i, line in enumerate(lines):
        if line.startswith(prefix):
            value = line[len(prefix):].strip()
            data = json.loads(value) if value else []
            mutate(data)
            lines[i] = prefix + json.dumps(data, separators=(',', ':')) + '\n'
            return
    # Key not present yet: append it.
    data = []
    mutate(data)
    lines.append(prefix + json.dumps(data, separators=(',', ':')) + '\n')

tenant_id = os.environ['TENANT_ID']

def add_tenant(tenants):
    if any(t.get('id') == tenant_id for t in tenants):
        sys.exit(f"Tenant id already configured: {tenant_id}")
    entry = {
        'id': tenant_id,
        'name': os.environ['TENANT_NAME'],
        'apiUrl': os.environ['API_URL'],
        'apiKey': os.environ['API_KEY'],
    }
    if os.environ.get('STAFF_API_KEY'):
        entry['staffApiKey'] = os.environ['STAFF_API_KEY']
    if os.environ.get('DEFAULT_JURISDICTION'):
        entry['defaultJurisdiction'] = os.environ['DEFAULT_JURISDICTION']
    if os.environ.get('DEFAULT_LANG'):
        entry['defaultLang'] = os.environ['DEFAULT_LANG']
    tenants.append(entry)

def add_user(users):
    token = os.environ['TOKEN']
    if any(u.get('mcpToken') == token for u in users):
        sys.exit('Generated token collides with an existing one; rerun.')
    entry = {
        'mcpToken': token,
        'name': os.environ['TENANT_NAME'],
        'tenant': tenant_id,
        'role': os.environ['ROLE'],
        'allowedToolsets': os.environ['TOOLSETS'].split(','),
    }
    if os.environ.get('JURISDICTIONS'):
        entry['allowedJurisdictions'] = os.environ['JURISDICTIONS'].split(',')
    users.append(entry)

edit_json_line('TENANTS_CONFIG', add_tenant)
edit_json_line('MCP_AUTH_USERS', add_user)

with open(env_file, 'w') as f:
    f.writelines(lines)
PYEOF

echo
echo "Tenant '$TENANT_ID' added to $ENV_FILE (backup: $BACKUP)"
echo
echo "Bearer token for '$TENANT_NAME' (hand over via secure channel, then delete):"
echo
echo "  $TOKEN"
echo
echo "Apply the change (from /opt/markaspot-cloud):"
echo
# MCP_ENV_FILE must be ABSOLUTE: the compose env_file (${MCP_ENV_FILE:-./mcp.env})
# resolves relative to the compose file's dir (/opt/mcp-bridge/deploy), not the CWD.
echo "  MCP_ENV_FILE=$ENV_FILE \\"
echo "    docker compose --env-file $ENV_FILE -p gateway-mcp \\"
echo "    -f /opt/mcp-bridge/deploy/docker-compose.mcp.yml up -d --force-recreate"
echo
echo "Smoke: token pinned to '$TENANT_ID' must get FORBIDDEN on any other tenant."
