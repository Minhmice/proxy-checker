# Antigravity account rotation and token telemetry dashboard

One Node.js app: Next.js dashboard syncing with **9Router**. Track session quotas across Antigravity and Codex accounts, run independent two-account autonomous quota rotation per provider, show real-time model token analytics.

## Two-Account Antigravity and Codex Rotation

- **Independent groups:** Antigravity and Codex (`codex` provider) rotate independently. Each keeps two active accounts when eligible accounts exist. Healthy incumbents stay active. No proxies; Claude accounts untouched.
- **Sampled threshold:** Each account activation gets integer quota threshold uniformly sampled 5%-10% inclusive, persisted across restarts and maintenance cycles.
- **Session quota only:** Decisions use session quota percentage. Weekly quota display only (hidden for Codex), never used for decisions.
- **Exhausted Codex sessions:** Fresh session telemetry stays readable at 0% even if 9Router keeps its usage-limit 429 error. Such accounts stay ineligible until session quota exceeds 20%; auth and telemetry failures still report errors.
- **Quota rotation:** At persisted session threshold (or account error), replace account with same-provider standby having session above 20%; pick highest session percentage, then earliest session reset.
- **Safe handoff:** Verify successor active before deactivating predecessor. If activation fails, write fails, or no eligible standby exists, current account stays active.
- **Dashboard:** Account Status card and sidebar quota widget label each account by provider (no provider = Antigravity) and show per-provider active counts from `/api/antigravity/status`.
- **Rotation feedback:** Open dashboard shows brief dither-flame toast when quota polling observes confirmed replacement. Opening dashboard does not replay past rotations.
- **Refresh status:** Dashboard and sidebar share one quota snapshot. Failed refresh keeps last known values labeled stale, never reports success.

## Settings

Open **Settings** to configure 9Router credentials, autonomous rotation daemon toggle and interval (one shared toggle/schedule for Antigravity and Codex), Git backups, master control password. Stored in `data/settings.json`, apply immediately. Server listens on port `1300`.

Unsaved Settings edits stay in memory across dashboard navigation. Restore and sign-out warn before discarding drafts. Backup status shows refresh failures, distinguishes last known values from current data.

First install: copy `.env.example` to `.env` to bootstrap; settings then seeded into `data/settings.json` automatically.

## Session loading animation

Pixel loader in `src/components/ui/loading-animation.tsx` runs while session check or sign-in redirect pending. Does not delay navigation. Open **Help → UI Components → Pixel loader demo** for scroll, assemble, Replay sequence. Reduced motion keeps session figure still, skips animated demo transition.

Demo frames sampled from third-party footage. Replace `BUILTIN_FRAMES` with cleared 66×53 packed frames before public release (or supply cleared `frames` in every usage).

## Tooling & Architecture Operations

Integrated modern toolchain:
- **API Server:** [Hono](https://hono.dev) mounted inside the native Node.js HTTP server; Next.js handles pages, assets, and webpack-HMR.
- **Database:** [Drizzle ORM](https://orm.drizzle.team) with `better-sqlite3` over domain SQLite databases (`data/antigravity-rotation.sqlite3`, `data/fleet.sqlite3`).
- **Linter & Formatter:** [Biome v2](https://biomejs.dev) as the single code quality tool.
- **API Mocking:** [MSW v3](https://mswjs.io), strict separation: opt-in dev browser worker (`NEXT_PUBLIC_ENABLE_API_MOCKS=true`) and Node test suite interception. Never active in production builds.
- **Accessibility:** [Axe-core](https://www.deque.com/axe/) via Playwright scans dashboard routes against WCAG 2.0 / 2.1 A and AA.

### Verification and Operational Commands

```sh
# Typecheck
npm run typecheck

# Lint and format checks (Biome)
npm run lint
npm run format:check

# Run full test suite (Node test runner)
npm test

# Build production bundle
npm run build

# Run MSW browser contract suite
npm run test:msw-browser

# Run authenticated accessibility audit across dashboard routes
npm run test:a11y

# Backup SQLite databases safely before migrations (using VACUUM INTO and exclusive lease)
npm run db:preflight -- <data-dir> <backup-dir>

# Verify database schema and table row digests
npm run db:verify -- <before-dir> <after-dir>
```

### Rollback Procedure

If deploy fails after service restart, deploy script stops service and leaves databases untouched. Pre-deploy snapshot can be older than data written by new release; do not restore blindly.

1. Stop and confirm all application and external database writers stopped.
2. Preserve entire current data directory, including SQLite `-wal` and `-shm` files, before recovery.
3. Inspect current schema, preserved files, and pre-deploy snapshot path from deploy log. Decide offline recovery plan before changing data.
4. Restart only after confirming release and database schema compatible.

## Run without Docker

1. Copy `.env.example` to `.env`, set at minimum:
   - `CONTROL_PASSWORD` — dashboard login
   - `NINEROUTER_PASSWORD` — **9Router dashboard password**
   - `NINEROUTER_URL` — default `https://9router.minhmice.com`
2. From project root run `npm install` and `npm run dev`.
3. Open `http://localhost:1300`, enter control password, view dashboard analytics.
   Dev also supports `http://127.0.0.1:1300`. Next.js owns HMR WebSocket upgrade listener; do not add second custom listener.

## Environment variables

`.env` optional after first run; use **Settings** instead. These variables bootstrap `data/settings.json` on first start:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONTROL_PASSWORD` | — | Required dashboard/API auth (first run) |
| `NINEROUTER_URL` | `https://9router.minhmice.com` | 9Router base URL |
| `NINEROUTER_PASSWORD` | — | 9Router dashboard login password |
| `NINEROUTER_API_KEY` | — | Optional legacy Bearer key |
| `SPOTIFY_CLIENT_ID` | — | Spotify app client id (public, PKCE; no secret). Register `http://127.0.0.1:<PORT>/api/spotify/callback` as its redirect URI; Spotify rejects `localhost`. |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:<PORT>/api/spotify/callback` | Override when served over HTTPS behind a proxy |

## Deploy lên Raspberry Pi (Auto-pull via systemd)

Pi tự động kiểm tra nhánh `main` qua `systemd.timer` (mỗi 60 giây). Khi có commit mới, script dừng service, tạo snapshot riêng trước khi pull/build và chỉ tiếp tục nếu snapshot thành công. Nếu lỗi trước restart, script hoàn nguyên code/build; nếu lỗi sau restart, script dừng service và yêu cầu kiểm tra database thủ công, không tự restore snapshot.

1. **Clone & Cài đặt lần đầu trên Pi (SSH vào Pi):**
```sh
sudo mkdir -p /opt/proxyfleet && sudo chown -R $USER:$USER /opt/proxyfleet
git clone <repo-url> /opt/proxyfleet
cd /opt/proxyfleet
cp .env.example .env
sudo ./deploy/pi/install.sh
```

2. **Kiểm tra trạng thái:**
```sh
systemctl status proxy-control-dashboard
systemctl status proxy-checker-deploy.timer
journalctl -u proxy-checker-deploy -f
```
