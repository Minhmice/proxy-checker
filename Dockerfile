# Syntax=docker/dockerfile:1
# Multi-stage Dockerfile for Raspberry Pi (linux/arm64, linux/arm/v7) & x86_64 (linux/amd64)

# ------------------------------------------------------------------------------
# Stage 1: Build ProxyFleet Go Agent Binaries
# ------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS agent-builder
WORKDIR /workspace/agent

RUN apk add --no-cache git make

COPY agent/go.mod ./
COPY agent/cmd/ ./cmd/
COPY agent/internal/ ./internal/

# Build multi-arch agent binaries with stripped symbols for minimal footprint
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/proxyfleet-agent-linux-amd64 ./cmd/proxyfleet-agent && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/proxyfleet-agent-linux-arm64 ./cmd/proxyfleet-agent && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags="-s -w" -o /out/proxyfleet-agent-linux-armv7 ./cmd/proxyfleet-agent

# ------------------------------------------------------------------------------
# Stage 2: Node.js Dependencies & Next.js Production Build
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
# Copy prebuilt agent binaries into bin/
COPY --from=agent-builder /out/* ./bin/

ENV NODE_ENV=production
RUN npm run typecheck
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 3: Production Runtime (Optimized for Raspberry Pi & Linux)
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /opt/proxyfleet

# Install runtime utilities: WireGuard, iptables/nftables, 3proxy (if available), curl, jq
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    wireguard-tools \
    iproute2 \
    iptables \
    procps \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/.next-build ./.next-build
COPY --from=node-builder /app/src ./src
COPY --from=node-builder /app/bin ./bin
COPY --from=node-builder /app/scripts ./scripts
COPY --from=node-builder /app/next.config.mjs ./next.config.mjs
COPY --from=node-builder /app/tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
ENV PORT=1300
ENV APP_DATA_DIR=/var/lib/proxyfleet

RUN mkdir -p /var/lib/proxyfleet /etc/proxyfleet /etc/3proxy && chmod 700 /var/lib/proxyfleet

EXPOSE 1300

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:1300/api/health || exit 1

CMD ["node", "--import", "tsx", "src/server/server.ts"]
