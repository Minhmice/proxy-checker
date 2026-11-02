# Syntax=docker/dockerfile:1
# Multi-stage Dockerfile for Raspberry Pi (linux/arm64, linux/arm/v7) & x86_64 (linux/amd64)

# ------------------------------------------------------------------------------
# Stage 1: Node.js Dependencies & Next.js Production Build
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS node-builder
WORKDIR /app

# Install native build tools for better-sqlite3 and native modules on ARM/x86
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
RUN npm run typecheck
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 2: Production Runtime (Optimized for Raspberry Pi & Linux)
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /opt/proxyfleet

# Install runtime utilities for health checks and backup sync.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    procps \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/.next-build ./.next-build
COPY --from=node-builder /app/src ./src
COPY --from=node-builder /app/scripts ./scripts
COPY --from=node-builder /app/next.config.mjs ./next.config.mjs
COPY --from=node-builder /app/tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
ENV PORT=1300
ENV APP_DATA_DIR=/var/lib/proxyfleet
ENV APP_BACKUP_DIR=/opt/proxyfleet/backups

RUN mkdir -p /var/lib/proxyfleet /opt/proxyfleet/backups && chmod 700 /var/lib/proxyfleet /opt/proxyfleet/backups

EXPOSE 1300

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f --max-time 5 http://127.0.0.1:1300/api/health || exit 1

CMD ["node", "--import", "tsx", "src/server/server.ts"]
