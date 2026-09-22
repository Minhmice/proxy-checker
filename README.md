# Proxy control dashboard

One Node.js application: a Next.js dashboard plus a native TCP checker that syncs with **9Router proxy pools**, health-checks them in parallel, activates the top 50 on 9Router, and shows a clean Active / Reserve view (dead proxies hidden).

## Standalone safety auditor

The independent `src/auditor/` API and `proxy-audit` CLI evaluate proxy transport security, privacy, reputation, and reliability without changing 9Router pools. See [Proxy Safety Auditor](docs/PROXY_AUDITOR.md) for installation, CLI/API examples, security assumptions, score explanations, and limitations.

```sh
npm run proxy-audit -- check "http://proxy.example.com:8080" --json
```

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

Open **Diagnostics** in the dashboard to choose any `.txt` list under `input/` with configurable sample scopes:

- Choose preset scopes (**10%**, **30%**, **50%**, **100%**) or enter a custom sample count. If both count and percent are provided, count takes precedence.
- Sampled endpoints are checked through two targets:
  - `ip-api.com` for target status, exit IP, country, ISP, and proxy/hosting classification.
  - `httpbin.org/anything` for common forwarding-header leakage (`Forwarded`, `Via`, `X-Forwarded-For`, `X-Real-IP`, and related headers).

Summary metrics display complete verified/failed aggregates across the full run, while evidence displays the latest 500 checked results with expandable error traces, search, and status filters. Select successful results and choose **Promote selected** to activate matching pools on 9Router.
For production, run `npm run build` and `npm start` under a process manager such as systemd or PM2.

## 9Router sync and testing lifecycle

- **Auth:** Logs into 9Router via `POST /api/auth/login` and reuses the `auth_token` session cookie for `/api/proxy-pools`.
- **Manual & Batch Testing:** Select proxies on the **Proxies** page and click **Test selected**, or trigger **Test now** per row. Tests return HTTP 202 immediately and run in the background under configured concurrency without blocking the operator UI.
- **Confirmed-Dead Auto-Removal:** When a proxy fails its initial check, it is retried immediately. Two consecutive failures on the same endpoint confirm the pool dead: minhmiceProxy deletes it from 9Router via `DELETE /api/proxy-pools/{id}`, retains the record locally in the **Removed** tab, and surfaces an automatic removal notification.
- **Post-Sync Recovery Recheck:** Following each sync, previously removed endpoints are rechecked in the background. If a dead endpoint recovers, it transitions to **Revived · ready to restore**.
- **Manual Restoration:** Revived proxies can be restored to 9Router through the row action menu. Restoration creates an inactive remote pool in the **Reserve** tier. Merely removed proxies cannot be restored until verified usable.
- **Renaming:** Rename proxy pools via the action menu. For linked or delete-failed pools, 9Router is updated first. If 9Router returns 404, identity reconciles against remote pools and raises a 409 conflict while keeping the local name intact.
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
| `ACTIVE_POOL_LIMIT` | `50` | Max active proxies on 9Router |
| `NINEROUTER_SYNC_MINUTES` | `60` | Auto-sync interval |
| `CHECK_CONCURRENCY` | `10` | Parallel proxy checks during sync |
| `CHECK_TIMEOUT_MS` | `6000` | Per-proxy connect/read timeout (dead proxies wait up to this long) |
| `PROXY_TTL_MINUTES` | `15` | Re-check interval for `input/` lists |
