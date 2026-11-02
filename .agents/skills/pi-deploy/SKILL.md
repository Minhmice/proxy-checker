---
name: pi-deploy
description: Project-only skill for proxy-checker. When the user says "chuyển sang pi", "switch to pi", "làm trên pi", "chạy trên pi", "deploy lên pi" or any request to move work to the Raspberry Pi, immediately stop local work and do it on the Pi (minhmice-pi-1) over SSH. Use for deploy, run, restart, logs, status, and debugging on the Pi.
---

# Pi handoff (proxy-checker)

"Chuyển sang pi" = Pi is now the execution target. Do NOT ask where, how, or whether to deploy. Do NOT keep working locally. Run the steps below.

## Facts (verified)

| Item | Value |
|---|---|
| Host | `minhmice-pi-1`, `aarch64`, Node `/usr/local/bin/node` (not `/usr/bin/node`) |
| SSH creds | `PI_SSH_HOST` / `PI_SSH_USER` / `PI_SSH_PASS` in local `.env` |
| App dir | `DEPLOY_DIR` (default `/opt/proxyfleet`), not a git checkout |
| Service | `proxy-control-dashboard` (systemd, port 1300, user root) |
| Data | `/var/lib/proxyfleet` (`APP_DATA_DIR`), backups in `${DEPLOY_DIR}/backups` (`/opt/proxyfleet/backups`) |
| Pi `.env` | Lives on the Pi. Never overwritten by sync. |

Sudo on the Pi needs the password via stdin; the helper handles it.

## Procedure

1. **Stop local instance first.** Instances sharing proxies must not run together:
   `node scripts/dev-stop.mjs`
2. **Sync, build, restart, health-check in one command:**
   `node .agents/skills/pi-deploy/scripts/pi.mjs sync`
   - Uploads the working tree (including uncommitted changes), excluding `node_modules`, `data`, `.git`, build caches, `.env`.
   - Runs `npm ci` only if `package-lock.json` changed or `node_modules` is missing.
   - Builds on the Pi, installs the systemd unit, restarts, waits for `/api/health` 200.
   - Build failure leaves the running service untouched.
   - Add `--no-build` for non-UI changes only if the user asks.
3. **Verify:** `node .agents/skills/pi-deploy/scripts/pi.mjs status` must show `active` and `health:200`.
4. **Report** what ran and the status output. If it failed, include the exact error and `pi.mjs logs 40`.

## Other Pi work

Use the helper for everything on the Pi, never local equivalents:

```sh
node .agents/skills/pi-deploy/scripts/pi.mjs status
node .agents/skills/pi-deploy/scripts/pi.mjs logs 100
node .agents/skills/pi-deploy/scripts/pi.mjs exec "<command in DEPLOY_DIR>"
node .agents/skills/pi-deploy/scripts/pi.mjs sudo "systemctl restart proxy-control-dashboard"
```

Authenticated API check from this machine (Bearer token = `CONTROL_PASSWORD`):
`curl -H "Authorization: Bearer <CONTROL_PASSWORD>" http://<PI_SSH_HOST>:1300/api/ninerouter/nodes`

## Rules

- Never print `.env` values or the SSH password in output.
- Never run the app locally and on the Pi at the same time.
- Never overwrite the Pi's `.env` or `/var/lib/proxyfleet` data.
- `deploy/pi/install.sh` and the `proxy-checker-deploy.timer` auto-pull assume a git checkout with `origin/main`. The Pi currently runs an uploaded tree, so the timer is not installed. Do not enable it unless the user asks; it would overwrite the uploaded tree with `main`.
- Git-based flow (README "Deploy lên Raspberry Pi") only if the user explicitly asks to deploy from `main`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `status=203/EXEC` | Unit hardcodes a missing node path. Unit must use `/usr/bin/env node`. |
| `Permission denied` on `install.sh` | Upload lost exec bit. Run via `bash`, or `chmod +x`. |
| Health never 200 | `pi.mjs logs 80`; check Pi `.env` has all keys from `.env.example`. |
| API 401 | Auth is `Authorization: Bearer <CONTROL_PASSWORD>`, not a custom header. |
