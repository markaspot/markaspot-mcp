#!/bin/sh
# MCP Bridge startup script for a local MCP client

# Set HOME environment variable if not set
export HOME=${HOME:-/tmp}

# Local dev only: DDEV serves a self-signed cert, so outbound HTTPS to the local
# backend fails verification. This is OFF by default and must be opted into
# explicitly (MCP_DEV_INSECURE_TLS=1). Never set it in any deployed environment:
# it disables TLS cert validation for the whole process and enables MITM.
if [ "${MCP_DEV_INSECURE_TLS:-}" = "1" ]; then
  export NODE_TLS_REJECT_UNAUTHORIZED=0
fi

cd /var/www/html/mcp-bridge

# Ensure dependencies are installed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..." >&2
  pnpm install --frozen-lockfile >&2
fi

# Ensure the project is built
if [ ! -f dist/server.js ]; then
  echo "Building project..." >&2
  pnpm run build >&2
fi

# Start the MCP server in production mode
NODE_ENV=production exec node dist/server.js
