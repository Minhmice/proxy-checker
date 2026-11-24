# Antigravity account rotation and token telemetry dashboard

One Node.js application: a Next.js dashboard that syncs with **9Router**, tracks Gemini session quotas across Antigravity accounts, manages single-account autonomous quota rotation, and displays real-time model token analytics.

## Single-Account Antigravity Rotation

- **Single active account:** Keeps exactly one Antigravity account active globally across configured 9Router endpoints at steady state.
- **Sampled threshold:** Each account activation receives an integer quota threshold uniformly sampled between 10% and 20% inclusive, persisted across restarts and maintenance cycles.
- **Quota rotation:** When the active account's Gemini session quota drops to or below its persisted threshold (or an account error occurs), a standby account with >20% quota and earliest reset duration is activated.
- **Safe handoff:** The successor is verified active before deactivating the predecessor. If activation fails or no eligible standby exists, the current account remains active.

## Settings

Open **Settings** in the dashboard to configure 9Router credentials, autonomous rotation daemon interval, Git backups, and master control password. Values are stored in `data/settings.json` and apply immediately. Server listens on port `1300`.

On first install, copy `.env.example` to `.env` to bootstrap — settings are then seeded into `data/settings.json` automatically.

## Tooling & Architecture Operations

The application uses an integrated modern toolchain:
- **API Server:** [Hono](https://hono.dev) mounted inside the native Node.js HTTP server; Next.js handles pages, assets, and webpack-HMR.
- **Database:** [Drizzle ORM](https://orm.drizzle.team) with `better-sqlite3` over domain SQLite databases (`data/antigravity-rotation.sqlite3`, `data/fleet.sqlite3`).
- **Linter & Formatter:** [Biome v2](https://biomejs.dev) as the single code quality tool.
- **API Mocking:** [MSW v3](https://mswjs.io) with strict separation: opt-in development browser worker (`NEXT_PUBLIC_ENABLE_API_MOCKS=true`) and Node test suite interception. Never activated in production builds.
- **Accessibility:** [Axe-core](https://www.deque.com/axe/) via Playwright scanning dashboard routes against WCAG 2.0 / 2.1 A and AA standards.

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

If a deployment fails after the service has restarted, the deploy script stops the service and leaves databases untouched. A snapshot taken before deployment can be older than data written by the new release and must not be restored blindly.

1. Stop and confirm all application and external database writers are stopped.
2. Preserve the entire current data directory, including SQLite `-wal` and `-shm` files, before attempting recovery.
3. Inspect the current schema, preserved files, and the pre-deployment snapshot path reported in the deploy log. Decide on an offline recovery plan before changing data.
4. Restart only after confirming that the release and database schema are compatible.

## Run without Docker

1. Copy `.env.example` to `.env` and set at minimum:
   - `CONTROL_PASSWORD` — dashboard login
   - `NINEROUTER_PASSWORD` — **9Router dashboard password**
   - `NINEROUTER_URL` — default `https://9router.minhmice.com`
2. From the project root, run `npm install` and `npm run dev`.
3. Open `http://localhost:1300`, enter the control password, and view dashboard analytics.

## Environment variables

`.env` is optional after the first run — use **Settings** in the dashboard instead. These variables bootstrap `data/settings.json` on first start:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONTROL_PASSWORD` | — | Required dashboard/API auth (first run) |
| `NINEROUTER_URL` | `https://9router.minhmice.com` | 9Router base URL |
| `NINEROUTER_PASSWORD` | — | 9Router dashboard login password |
| `NINEROUTER_API_KEY` | — | Optional legacy Bearer key |

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
