# Proxy control dashboard

One Node.js application: a Next.js dashboard plus a native TCP checker that syncs with **9Router proxy pools**, health-checks them in parallel, activates the top 50 on 9Router, and shows a clean Active / Reserve view (dead proxies hidden).

## Settings (recommended)

After the first run, open **Settings** in the dashboard to change 9Router credentials, sync interval, health-check concurrency, control password, and more. Values are stored in `data/settings.json` and apply immediately. Server always listens on port `1300`.

On first install, copy `.env.example` to `.env` to bootstrap — settings are then seeded into `data/settings.json` automatically.

## Run without Docker

1. Copy `.env.example` to `.env` and set at minimum:
   - `CONTROL_PASSWORD` — minhmiceProxy dashboard login
   - `NINEROUTER_PASSWORD` — **9Router dashboard password** (same password you use at `/login`)
   - `NINEROUTER_URL` — default `https://9router.minhmice.com`
2. From the project root, run `npm install` and `npm run dev`.
3. Open `http://localhost:1300`, enter the control password, then use **Settings** or **Sync & rank top 50**.

## Detailed proxy diagnostics

Open **Diagnostics** in the dashboard to choose any `.txt` list under `input/`. Each run samples exactly 30% of the unique endpoints in that list (minimum one when the list is non-empty), so the diagnostic pass does not test the whole list every time. Each sampled endpoint is checked through two targets:

- `ip-api.com` for target status, exit IP, country, ISP, and proxy/hosting classification.
- `httpbin.org/anything` for common forwarding-header leakage (`Forwarded`, `Via`, `X-Forwarded-For`, `X-Real-IP`, and related headers).

Results are persisted in `data/diagnostics.json`. Select successful results and choose **Promote selected to 9Router** to activate matching pools already present in 9Router. Endpoints that are not already in 9Router are reported as skipped rather than silently created with an unverified API contract.

For production, run `npm run build` and `npm start` under a process manager such as systemd or PM2.

## 9Router sync

- **Auth:** Logs into 9Router via `POST /api/auth/login` and reuses the `auth_token` session cookie for `/api/proxy-pools`. The Endpoint **API Keys** (`sk-...`) are for `/v1` LLM routes only — use dashboard password instead.
- **Manual:** Click **Sync & rank top 50** on the dashboard.
- **Automatic:** Every `NINEROUTER_SYNC_MINUTES` (default 60) when `NINEROUTER_PASSWORD` is set.
- **Flow:** Pull pools from `GET /api/proxy-pools` → parallel health check → rank by latency → activate top `ACTIVE_POOL_LIMIT` (default 50) via `PUT /api/proxy-pools/{id}`.
- **Tiers:** Active (shown + enabled on 9Router), Reserve (shown but disabled), Dead (hidden).

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
| `ACTIVE_POOL_LIMIT` | `50` | Max active proxies on 9Router |
| `NINEROUTER_SYNC_MINUTES` | `60` | Auto-sync interval |
| `CHECK_CONCURRENCY` | `10` | Parallel proxy checks during sync |
| `CHECK_TIMEOUT_MS` | `6000` | Per-proxy connect/read timeout (dead proxies wait up to this long) |
| `PROXY_TTL_MINUTES` | `15` | Re-check interval for `input/` lists |
