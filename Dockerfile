# syntax=docker/dockerfile:1
#
# MCPocket — single-process image: web dashboard, REST API and MCP (Streamable
# HTTP + legacy SSE) served by one Next.js standalone server, plus the bundled
# stdio proxy (bin/mcpocket-stdio.mjs). Build: `docker compose build` or
#   docker build -t mcpocket:latest .

ARG NODE_VERSION=22.23.4

# --- deps: install exact dependencies from the lockfile ---------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
# Workspace manifests first so `npm ci` can link @mcpocket/core.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
RUN npm ci --no-audit --no-fund

# --- builder: Next.js standalone build + single-file stdio proxy ------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:stdio

# --- runner: minimal runtime, non-root --------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
LABEL org.opencontainers.image.title="MCPocket" \
      org.opencontainers.image.description="Persistent storage and coordination for AI agents." \
      org.opencontainers.image.url="https://mcpocket.io"
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DRIVER=json \
    DATA_DIR=/app/data \
    SEED_FILE=/app/mock/seed.json

# `node` (uid 1000) ships with the official image. The data directory is
# created owned by it so a fresh named volume inherits writable ownership.
RUN mkdir -p /app/data && chown node:node /app/data

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/mock/seed.json ./mock/seed.json
COPY --from=builder /app/dist/mcpocket-stdio.mjs ./bin/mcpocket-stdio.mjs

USER node
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.js"]
