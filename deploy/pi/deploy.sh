#!/usr/bin/env bash
# ==============================================================================
# Proxy Checker Pi Auto-Deploy Script
#
# Pull-based deployment:
# 1. Acquires exclusive flock
# 2. Fetches origin/$DEPLOY_BRANCH
# 3. Compares local SHA vs remote SHA (no-op if up to date)
# 4. Stops the service and snapshots SQLite before touching code
# 5. Fast-forward pull
# 6. Runs npm ci only if lockfile changed
# 7. Next.js production build with constrained Node memory for Pi
# 8. Starts systemd service
# 9. Healthcheck retry loop (30s)
# 10. Automatic rollback on healthcheck failure
# ==============================================================================

set -euo pipefail

# 1. Non-blocking exclusive lock
LOCK_FILE="/tmp/proxy-checker-deploy.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[deploy] $(date -Iseconds) Another deploy is currently in progress. Exiting."
  exit 0
fi

# 2. Config & Defaults
DEPLOY_DIR="${DEPLOY_DIR:-/opt/proxyfleet}"
ENV_FILE="${DEPLOY_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  # Load env without exporting internal comments
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-proxy-control-dashboard}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:1300/api/health}"
NODE_MEM="${NODE_BUILD_MAX_OLD_SPACE_SIZE:-1024}"
MAX_HEALTH_ATTEMPTS=15
HEALTH_INTERVAL=2

cd "$DEPLOY_DIR"

# Ensure git safe directory for service user
git config --global --add safe.directory "$DEPLOY_DIR" 2>/dev/null || true

# 3. Fetch & Compare
echo "[deploy] $(date -Iseconds) Fetching origin/$DEPLOY_BRANCH..."
git fetch origin "$DEPLOY_BRANCH" --quiet

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$DEPLOY_BRANCH")"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  echo "[deploy] Up to date at $LOCAL_SHA. No deployment needed."
  exit 0
fi

echo "[deploy] New commit detected: $LOCAL_SHA -> $REMOTE_SHA"

# 4. Stop writers before taking a pre-deployment snapshot or changing the release.
export APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/proxyfleet}"
export APP_BACKUP_DIR="${APP_BACKUP_DIR:-${DEPLOY_DIR}/backups}"
INITIAL_STATE="$(systemctl show "$SERVICE_NAME" --property=ActiveState --value)"
case "$INITIAL_STATE" in
  active) SERVICE_WAS_ACTIVE=1 ;;
  inactive|failed) SERVICE_WAS_ACTIVE=0 ;;
  *) echo "[deploy] CRITICAL: Service state is $INITIAL_STATE; refusing deployment."; exit 1 ;;
esac

stop_service() {
  local state pid
  if ! systemctl stop "$SERVICE_NAME"; then
    echo "[deploy] CRITICAL: Failed to stop $SERVICE_NAME; refusing further changes."
    return 1
  fi
  state="$(systemctl show "$SERVICE_NAME" --property=ActiveState --value)" || return 1
  pid="$(systemctl show "$SERVICE_NAME" --property=MainPID --value)" || return 1
  if [[ "$state" != "inactive" || "$pid" != "0" ]]; then
    echo "[deploy] CRITICAL: Service not confirmed stopped (state=$state, PID=$pid)."
    return 1
  fi
}

abort_before_changes() {
  echo "[deploy] CRITICAL: $1; deployment aborted."
  if [[ "$SERVICE_WAS_ACTIVE" -eq 1 ]] && ! systemctl start "$SERVICE_NAME"; then
    echo "[deploy] CRITICAL: Could not restart original service; manual intervention required."
  fi
  exit 1
}

stop_service || exit 1
if [[ "$(git rev-parse HEAD)" != "$LOCAL_SHA" ]] || ! git diff --quiet -- || ! git diff --cached --quiet --; then
  abort_before_changes "Repository changed or has tracked local changes"
fi

SNAPSHOT_ROOT="${APP_DATA_DIR%/}-deploy-snapshots"
if ! (umask 077 && mkdir -p "$SNAPSHOT_ROOT") || ! SNAPSHOT_DIR="$(mktemp -d "${SNAPSHOT_ROOT}/predeploy.XXXXXXXX")"; then
  abort_before_changes "Could not create isolated snapshot directory"
fi
export DEPLOY_SNAPSHOT_DIR="$SNAPSHOT_DIR"
if [[ ! -f "src/server/backup/backup-service.ts" ]]; then
  abort_before_changes "Backup service unavailable"
fi
echo "[deploy] Creating pre-deployment snapshot at $SNAPSHOT_DIR..."
if ! NODE_ENV=production node --import tsx --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  import { createBackupSnapshot } from "./src/server/backup/backup-service.js";
  const dataDir = process.env.APP_DATA_DIR;
  const backupDir = process.env.DEPLOY_SNAPSHOT_DIR;
  const res = createBackupSnapshot({ backupDir, dataDir });
  if (!res.ok) {
    console.error("Backup snapshot errors:", (res.errors || []).join("; "));
    process.exit(1);
  }
  const required = ["proxies.sqlite3", "antigravity-rotation.sqlite3"];
  if (process.env.ANTIGRAVITY_AUTHORITY_PRIVATE_KEY_PATH) required.push("router-sync.sqlite3");
  for (const name of ["proxies.sqlite3", "antigravity-rotation.sqlite3", "router-sync.sqlite3"]) {
    const entry = `databases/${name}`;
    const exists = fs.existsSync(path.join(dataDir, name));
    if ((required.includes(name) && !exists) ||
        (exists && (!res.manifest.files.some(file => file.name === entry) || !fs.existsSync(path.join(backupDir, entry))))) {
      console.error(`Backup snapshot missing ${name}`);
      process.exit(1);
    }
  }
'; then
  abort_before_changes "Pre-deployment snapshot failed (retained at $SNAPSHOT_DIR)"
fi

# 5. Prepare rollback artifacts.
PREV_SHA="$LOCAL_SHA"
if [[ -d ".next-build" ]] && ! cp -r .next-build "$SNAPSHOT_DIR/.next-build"; then
  abort_before_changes "Could not preserve previous build"
fi
RESTART_ATTEMPTED=0
DEPENDENCIES_CHANGED=0

rollback() {
  local reason="$1"
  echo "[deploy] CRITICAL: Deployment failed ($reason). Rolling back release files to $PREV_SHA..."
  if ! stop_service; then
    echo "[deploy] CRITICAL: Service state unsafe; no rollback attempted. Manual intervention required."
    exit 1
  fi
  if ! git diff --quiet -- || ! git diff --cached --quiet --; then
    echo "[deploy] CRITICAL: Tracked changes appeared during deployment; rollback stopped to preserve them."
    exit 1
  fi
  local current_sha
  if ! current_sha="$(git rev-parse HEAD)" || [[ "$current_sha" != "$PREV_SHA" && "$current_sha" != "$REMOTE_SHA" ]]; then
    echo "[deploy] CRITICAL: HEAD changed unexpectedly or could not be read; rollback stopped to preserve commits."
    exit 1
  fi
  if ! git reset --merge "$PREV_SHA"; then
    echo "[deploy] CRITICAL: Release rollback refused; preserve local changes and intervene manually."
    exit 1
  fi
  if [[ -d "$SNAPSHOT_DIR/.next-build" ]]; then
    rm -rf .next-build
    mv "$SNAPSHOT_DIR/.next-build" .next-build
  fi
  if [[ "$DEPENDENCIES_CHANGED" -eq 1 ]]; then
    echo "[deploy] Restoring dependencies for rollback commit..."
    if ! npm ci --include=dev --prefer-offline --no-audit --no-fund; then
      echo "[deploy] CRITICAL: Dependency rollback failed; service remains stopped."
      exit 1
    fi
  fi
  if [[ "$RESTART_ATTEMPTED" -eq 1 ]]; then
    echo "[deploy] CRITICAL: Service remains stopped; database may contain writes from the new release."
    echo "[deploy] No database restore was attempted. Review data/schema and snapshot $SNAPSHOT_DIR before manual recovery."
  elif [[ "$SERVICE_WAS_ACTIVE" -eq 1 ]]; then
    if ! systemctl start "$SERVICE_NAME"; then
      echo "[deploy] CRITICAL: Could not restart original service; manual intervention required."
    fi
  fi
  exit 1
}

# 6. Pull updates (fast-forward only)
echo "[deploy] Pulling changes (ff-only)..."
if ! git pull --ff-only origin "$DEPLOY_BRANCH"; then
  rollback "git pull --ff-only failed (divergent branch)"
fi

# 7. Check dependencies
if git diff --name-only "$PREV_SHA" HEAD | grep -qE "(package\.json|package-lock\.json)" || [[ ! -d "node_modules" ]]; then
  DEPENDENCIES_CHANGED=1
  echo "[deploy] Dependencies changed. Running npm ci..."
  if ! npm ci --include=dev --prefer-offline --no-audit --no-fund; then
    rollback "npm ci failed"
  fi
else
  echo "[deploy] Dependencies unchanged. Skipping npm ci."
fi

# 8. Build Next.js
echo "[deploy] Building Next.js production bundle (NODE_OPTIONS=--max-old-space-size=$NODE_MEM)..."
if ! NODE_OPTIONS="--max-old-space-size=$NODE_MEM" npm run build; then
  rollback "npm run build failed"
fi

# 9. Restart Systemd Service
RESTART_ATTEMPTED=1
echo "[deploy] Restarting systemd service: $SERVICE_NAME..."
if ! systemctl restart "$SERVICE_NAME"; then
  rollback "systemctl restart failed"
fi

# 10. Healthcheck
echo "[deploy] Verifying service health at $HEALTH_URL..."
HEALTHY=0
for ((i=1; i<=MAX_HEALTH_ATTEMPTS; i++)); do
  sleep "$HEALTH_INTERVAL"
  HTTP_CODE="$(curl -s --max-time 5 -o /tmp/deploy-health.json -w "%{http_code}" "$HEALTH_URL" || echo "000")"
  if [[ "$HTTP_CODE" == "200" ]] && grep -q '"ok":true' /tmp/deploy-health.json 2>/dev/null; then
    HEALTHY=1
    break
  fi
  echo "[deploy] Health check attempt $i/$MAX_HEALTH_ATTEMPTS failed (HTTP $HTTP_CODE)..."
done

if [[ "$HEALTHY" -ne 1 ]]; then
  rollback "Health check failed after $MAX_HEALTH_ATTEMPTS attempts"
fi

# 11. Keep the database snapshot for manual recovery, but discard the copied build.
rm -rf "$SNAPSHOT_DIR/.next-build"
echo "[deploy] SUCCESS: Successfully deployed $REMOTE_SHA at $(date -Iseconds)."
