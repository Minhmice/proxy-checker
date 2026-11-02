#!/usr/bin/env bash
# ==============================================================================
# Proxy Checker Pi Bootstrap / Installation Script
# Idempotent: safe to run multiple times.
# ==============================================================================

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "[install] Error: This script must be run as root (use sudo)."
  exit 1
fi

DEPLOY_DIR="${DEPLOY_DIR:-/opt/proxyfleet}"
DATA_DIR="${APP_DATA_DIR:-/var/lib/proxyfleet}"
BACKUP_DIR="${APP_BACKUP_DIR:-${DEPLOY_DIR}/backups}"

echo "=========================================================="
echo " Proxy Checker Pi Deployment Setup: $DEPLOY_DIR"
echo "=========================================================="

# 1. Prerequisite checks
echo "[install] Checking prerequisites..."
for cmd in node npm git curl systemctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[install] Error: Required command '$cmd' not found. Please install it first."
    exit 1
  fi
done

NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "[install] Error: Node.js >= 22 required (found $(node -v))."
  exit 1
fi

ARCH="$(uname -m)"
echo "[install] System architecture: $ARCH, Node.js: $(node -v)"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "x86_64" ]]; then
  echo "[install] Warning: Architecture $ARCH is not 64-bit. better-sqlite3 v13 prebuilts require linux-arm64 or linux-x64."
fi

# 2. Setup persistent data directories
echo "[install] Setting up data directories..."
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chmod 750 "$DATA_DIR"

# 3. Environment configuration
cd "$DEPLOY_DIR"
if [[ ! -f "$DEPLOY_DIR/.env" ]]; then
  echo "[install] Creating initial .env from .env.example..."
  cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
  echo "[install] NOTICE: Generated $DEPLOY_DIR/.env. Update it with your secrets!"
else
  chmod 600 "$DEPLOY_DIR/.env"
  echo "[install] Existing .env file found; preserving secrets."
fi

# Install build dependencies and compile before starting services.
echo "[install] Installing dependencies..."
npm ci --include=dev --prefer-offline --no-audit --no-fund
echo "[install] Building Next.js production bundle..."
NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_MAX_OLD_SPACE_SIZE:-1024}" npm run build

# 4. Make scripts executable
chmod +x "$DEPLOY_DIR/deploy/pi/deploy.sh"

# 5. Install systemd service & timer units
echo "[install] Installing systemd units..."
cp "$DEPLOY_DIR/deploy/systemd/proxy-control-dashboard.service" /etc/systemd/system/
cp "$DEPLOY_DIR/deploy/systemd/proxy-checker-deploy.service" /etc/systemd/system/
cp "$DEPLOY_DIR/deploy/systemd/proxy-checker-deploy.timer" /etc/systemd/system/

systemctl daemon-reload

# 6. Enable and start services
echo "[install] Enabling and starting services..."
systemctl enable proxy-control-dashboard.service
systemctl enable proxy-checker-deploy.timer

systemctl restart proxy-control-dashboard.service
systemctl restart proxy-checker-deploy.timer

echo "=========================================================="
echo " Proxy Checker installed successfully!"
echo " Service status: systemctl status proxy-control-dashboard"
echo " Timer status:   systemctl status proxy-checker-deploy.timer"
echo " Deploy logs:    journalctl -u proxy-checker-deploy -f"
echo " Dashboard logs: journalctl -u proxy-control-dashboard -f"
echo "=========================================================="
