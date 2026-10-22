# Proxy control dashboard

One Node.js application: a Next.js dashboard that syncs with **9Router proxy pools**, performs health-checks directly via 9Router, activates the top 20 on 9Router, and shows a clean Active / Reserve view (dead proxies hidden).

## Standalone safety auditor

The independent `src/auditor/` API and `proxy-audit` CLI evaluate proxy transport security, privacy, reputation, and reliability without changing 9Router pools. See [Proxy Safety Auditor](docs/PROXY_AUDITOR.md) for installation, CLI/API examples, security assumptions, score explanations, and limitations.

```sh
npm run proxy-audit -- check "http://proxy.example.com:8080" --json
```

## Dashboard Safety Auditor

Open **Safety Auditor** (`/auditor`) in the sidebar for full visual proxy safety auditing:
- **Single & Bulk Audits:** Paste a single connection string or drop a `.txt` proxy file.
- **Background Execution & History:** Jobs execute in the background with real-time polling, cancellation, and server-side history retention (up to 50 jobs).
- **Evidence Inspection:** Click any audit result to inspect full TLS, DNS, header origin-leak, connectivity timings, and reputation provider breakdowns in an interactive slide-over drawer.
- **Sanitized Exports:** Download full JSON or formula-injection-safe CSV results without leaking proxy credentials.
- Audits never mutate 9Router pools automatically.

## Settings (recommended)

After the first run, open **Settings** in the dashboard to change 9Router credentials, sync interval, health-check concurrency, control password, and more. Values are stored in `data/settings.json` and apply immediately. Server always listens on port `1300`.

On first install, copy `.env.example` to `.env` to bootstrap — settings are then seeded into `data/settings.json` automatically.

## Tooling & Architecture Operations

The application uses an integrated modern toolchain:
- **API Server:** [Hono](https://hono.dev) mounted inside the native Node.js HTTP server; Next.js handles pages, assets, and webpack-HMR.
- **Database:** [Drizzle ORM](https://orm.drizzle.team) with `better-sqlite3` over domain SQLite databases (`data/proxies.sqlite3`, `data/fleet.sqlite3`, `data/antigravity-rotation.sqlite3`).
- **Linter & Formatter:** [Biome v2](https://biomejs.dev) as the single code quality tool.
- **API Mocking:** [MSW v3](https://mswjs.io) with strict separation: opt-in development browser worker (`NEXT_PUBLIC_ENABLE_API_MOCKS=true`) and Node test suite interception. Never activated in production builds.
- **Accessibility:** [Axe-core](https://www.deque.com/axe/) via Playwright scanning all 14 dashboard routes against WCAG 2.0 / 2.1 A and AA standards.

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

# Run authenticated accessibility audit across all dashboard routes
npm run test:a11y

# Backup SQLite databases safely before migrations (using VACUUM INTO and exclusive lease)
npm run db:preflight -- <data-dir> <backup-dir>

# Verify database schema and table row digests
npm run db:verify -- <before-dir> <after-dir>
```

### Rollback Procedure

If a failure is encountered after deploying a database migration:
1. Stop the application server process immediately.
2. Preserve the current database files in `data/` for post-mortem diagnostics.
3. Restore the preflight backup copies created via `npm run db:preflight`.
4. Redeploy the prior known-good Git commit.
5. Re-run `npm test` and `npm run test:a11y` to verify system health.
## Run without Docker

1. Copy `.env.example` to `.env` and set at minimum:
   - `CONTROL_PASSWORD` — minhmiceProxy dashboard login
   - `NINEROUTER_PASSWORD` — **9Router dashboard password** (same password you use at `/login`)
   - `NINEROUTER_URL` — default `https://9router.minhmice.com`
2. From the project root, run `npm install` and `npm run dev`.
3. Open `http://localhost:1300`, enter the control password, then use **Settings** or **Sync & rank top 20**.

## Detailed proxy diagnostics

Open **Diagnostics** in the dashboard to choose any `.txt` list under `input/` with configurable sample scopes:

- Choose preset scopes (**10%**, **30%**, **50%**, **100%**) or enter a custom sample count. If both count and percent are provided, count takes precedence.
- Sampled endpoints are checked through two targets:
  - `ip-api.com` for target status, exit IP, country, ISP, and proxy/hosting classification.
  - `httpbin.org/anything` for common forwarding-header leakage (`Forwarded`, `Via`, `X-Forwarded-For`, `X-Real-IP`, and related headers).

Summary metrics display complete verified/failed aggregates across the full run, while evidence displays the latest 500 checked results with expandable error traces, search, and status filters. Select successful results and choose **Promote selected** to activate matching pools on 9Router.
For production, run `npm run build` and `npm start` under a process manager such as systemd or PM2.

## 9Router sync and remote tracking lifecycle

- **Auth:** Logs into 9Router via `POST /api/auth/login` and reuses the `auth_token` session cookie for `/api/proxy-pools`.
- **Automatic Cooldown & Tracking:** Automatic sync runs no more than once every 6 hours (minimum `NINEROUTER_SYNC_MINUTES = 360`). A background tracker polls 9Router every 60 seconds and on dashboard load to keep active/reserve state and remote test metadata strictly synchronized.
- **Sync Now (Force Sync):** Triggering **Sync now** forces a 9Router health-check pass across all pools via `POST /api/proxy-pools/{id}/test`.
- **Confirmed-Dead Auto-Removal:** When 9Router health check confirms a proxy failure (`ok: false`), it is immediately deactivated on 9Router and deleted via `DELETE /api/proxy-pools/{id}`. The record is retained locally as read-only history in the **Removed** tab.
- **Top 20 Ranking & Renaming:** Verified survivors are ranked by ascending latency, the top 20 are toggled Active on 9Router while the rest remain in Reserve, and pools are automatically renamed from highest rank down to 1 so rank 1 is applied last.
- **Tiers:** Active (top latency, enabled on 9Router), Reserve (backup pools, disabled on 9Router), Removed (deleted from 9Router, retained locally).
State is stored in `data/pool-state.json` (gitignored).

## Legacy input/ workflow

Proxy lists in `input/` are still checked in the background. The old **Apply best to 9Router** env-file path (`runtime/9router-proxy.env`) remains available via API but is no longer the primary UI.

## Environment variables

`.env` is optional after the first run — use **Settings** in the dashboard instead. These variables bootstrap `data/settings.json` on first start:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONTROL_PASSWORD` | — | Required minhmiceProxy dashboard/API auth (first run) |
| `NINEROUTER_URL` | `https://9router.minhmice.com` | 9Router base URL |
| `NINEROUTER_PASSWORD` | — | 9Router dashboard login password (recommended) |
| `NINEROUTER_API_KEY` | — | Optional legacy Bearer key (usually does not work for management API) |
| `ACTIVE_POOL_LIMIT` | `20` | Max active proxies on 9Router |
| `NINEROUTER_SYNC_MINUTES` | `360` | Auto-sync interval (minimum 6 hours) |
| `CHECK_CONCURRENCY` | `10` | Parallel proxy checks during sync |
| `CHECK_TIMEOUT_MS` | `6000` | Per-proxy connect/read timeout (dead proxies wait up to this long) |
| `PROXY_TTL_MINUTES` | `15` | Re-check interval for `input/` lists |
