#!/bin/sh
set -e

# Pull + roll out the GeoReport MCP bridge across all tenant stacks on cp1.
#
# Model: ONE image (markaspot/markaspot-mcp:latest) built + pushed by the
# markaspot-mcp CI (Docker Hardened Image base, needs dhi.io creds — cp1 does NOT
# build it), then run as a per-tenant service. Each tenant bridge is configured by
# its own env file at tenants/<tenant>.mcp.env and gets a namespaced project/router
# so the bridges never collide on Traefik.
#
# This script is meant to live on cp1 under /opt/markaspot-cloud/ (next to
# deploy.sh). It expects the mcp-bridge repo checked out at $MCP_REPO only for the
# compose file; adjust MCP_REPO to the real path.
#
# Usage:
#   ./rollout-mcp.sh pull               # pull the latest markaspot/markaspot-mcp image
#   ./rollout-mcp.sh up <tenant>        # start/refresh one tenant bridge (pulls first)
#   ./rollout-mcp.sh up                 # start/refresh ALL tenant bridges
#   ./rollout-mcp.sh down <tenant>      # stop one tenant bridge
#   ./rollout-mcp.sh ps                 # status of all bridges
#   ./rollout-mcp.sh logs <tenant>      # follow one tenant bridge
#
# A "tenant bridge" is any tenants/<tenant>.mcp.env file.

CLOUD_DIR="${CLOUD_DIR:-/opt/markaspot-cloud}"
MCP_REPO="${MCP_REPO:-/opt/mcp-bridge}"          # checkout of this repo on cp1
COMPOSE_FILE="${MCP_REPO}/deploy/docker-compose.mcp.yml"
IMAGE="markaspot/markaspot-mcp:latest"

COMMAND="${1:-ps}"
TENANT="$2"

pull_image() {
  echo "Pulling ${IMAGE} from Docker Hub..."
  docker pull "${IMAGE}"
  echo "Done: ${IMAGE}"
}

bridge_up() {
  t="$1"
  env_file="${CLOUD_DIR}/tenants/${t}.mcp.env"
  if [ ! -f "$env_file" ]; then
    echo "ERROR: ${env_file} not found"; exit 1
  fi
  echo "Starting bridge for tenant '${t}'..."
  # Pull first so 'up' always lands the freshly published (hardened) image,
  # not a stale locally-cached :latest.
  MCP_ENV_FILE="$env_file" \
    docker compose --env-file "$env_file" -p "${t}-mcp" -f "$COMPOSE_FILE" pull
  MCP_ENV_FILE="$env_file" \
    docker compose --env-file "$env_file" -p "${t}-mcp" -f "$COMPOSE_FILE" up -d
  docker compose --env-file "$env_file" -p "${t}-mcp" -f "$COMPOSE_FILE" ps
}

bridge_down() {
  t="$1"
  env_file="${CLOUD_DIR}/tenants/${t}.mcp.env"
  echo "Stopping bridge for tenant '${t}'..."
  MCP_ENV_FILE="$env_file" \
    docker compose --env-file "$env_file" -p "${t}-mcp" -f "$COMPOSE_FILE" down
}

list_tenants() {
  ls "${CLOUD_DIR}"/tenants/*.mcp.env 2>/dev/null \
    | sed 's|.*/||;s|\.mcp\.env$||'
}

case "$COMMAND" in
  pull)
    pull_image
    ;;
  up)
    if [ -n "$TENANT" ]; then
      bridge_up "$TENANT"
    else
      for t in $(list_tenants); do bridge_up "$t"; done
    fi
    ;;
  down)
    if [ -n "$TENANT" ]; then
      bridge_down "$TENANT"
    else
      for t in $(list_tenants); do bridge_down "$t"; done
    fi
    ;;
  logs)
    [ -z "$TENANT" ] && { echo "logs needs a tenant"; exit 1; }
    docker compose -p "${TENANT}-mcp" -f "$COMPOSE_FILE" logs -f
    ;;
  ps)
    for t in $(list_tenants); do
      echo "=== ${t}-mcp ==="
      docker compose -p "${t}-mcp" -f "$COMPOSE_FILE" ps
    done
    ;;
  *)
    echo "Commands: pull | up [tenant] | down [tenant] | logs <tenant> | ps"
    exit 1
    ;;
esac
