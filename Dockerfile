# GeoReport MCP bridge - Docker Hardened Image build (self-hosted).
#
# Mirrors the Mark-a-Spot frontend Dockerfile: DHI base, pnpm 11 via corepack,
# frozen-lockfile install, build, then `pnpm prune --prod`. The runtime stage is
# a shell-less DHI image (no apk/busybox -> kills the base-layer CVEs) and ships
# only the minified bundle + the pruned prod node_modules (cors/dotenv/express/
# winston/zod), none of which pull in the picomatch/brace-expansion/ip-address
# devDependency transitives that the scanner flagged.

# Build Stage - Docker Hardened Image with dev tools (shell + corepack).
FROM dhi.io/node:24-dev AS builder

WORKDIR /build

# Install pnpm via npm. The updated dhi.io/node:24-dev image creates corepack's
# pnpm shim without an execute bit (`/usr/bin/pnpm: Permission denied`, exit 126),
# so `corepack enable` is unusable there; `npm install -g` produces a proper
# executable. Version pinned to match packageManager in package.json.
RUN npm install -g pnpm@11.1.2

# Install all deps (incl. dev) against the committed lockfile. pnpm-workspace.yaml
# carries `allowBuilds: esbuild: true` so tsup's esbuild binary is built; without
# it pnpm 11 blocks the postinstall and the bundle step fails.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# Bundle src/server.ts -> dist/server.js (minified ESM) via tsup.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Strip devDependencies so only the 5 runtime deps remain in node_modules.
# --ignore-scripts: prod deps have no build step we depend on at runtime.
RUN pnpm prune --prod --ignore-scripts

# Stage the upload directory here (the -dev stage has a shell) so it can be
# copied into the shell-less runtime image with the right ownership. A named
# volume mounted onto an image path inherits that path's ownership, so it must
# already belong to UID 1000 or the non-root server cannot write photos.
RUN mkdir -p /staging/data/uploads


# Production Stage - Docker Hardened Image (minimal, no shell, no apk/busybox).
FROM dhi.io/node:24

WORKDIR /app

ENV NODE_ENV=production \
    MCP_SERVER_PORT=3100 \
    UPLOAD_DIR=/data/uploads

# Copy the minified bundle and the pruned prod node_modules (DHI runs as UID 1000).
COPY --from=builder --chown=1000:1000 /build/dist ./dist
COPY --from=builder --chown=1000:1000 /build/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /build/package.json ./package.json

# Local filesystem blob store for the photo-upload flow. The directory is staged
# in the builder and copied with UID 1000 ownership (no RUN in the shell-less
# runtime stage). Mounted as a named volume in deploy/docker-compose.mcp.yml.
COPY --from=builder --chown=1000:1000 /staging/data /data

VOLUME ["/data/uploads"]

EXPOSE 3100

# Run as the non-root DHI node user.
USER 1000

# Node-based healthcheck: DHI has no shell/wget. Node 24 ships a global fetch().
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Long-running Express server: JSON-RPC MCP endpoint + /health + upload route.
CMD ["node", "dist/server.js"]
