# Pi Router Cutover Inventory — 2026-10-27

## Topology evidence

- `192.168.1.54` and `100.74.116.125` identify `minhmice-pi-1`, Linux `aarch64`, user `minhmice`.
- Both addresses expose the same 9Router process (`/usr/local/bin/9router`, port `20128`, PID `12497` at inspection time).
- `100.73.175.42` identifies a separate Linux `x86_64` host, user `netnut`; SSH inspection confirmed `9router.service enabled enabled`, process `/usr/bin/node /usr/local/lib/node_modules/9router/cli.js --tray --skip-update -p 20128`, and port `20128` listening.
- `9router.minhmice.com` did not resolve through the inspected DNS resolver at cutover time. Public DNS returned Cloudflare IPv6 addresses only through `nslookup -type=AAAA`; HTTP health request could not resolve locally. Domain is not treated as verified until DNS/HTTPS is rechecked.

## Authenticated pool/account snapshot

Captured through project client against each live router URL:

| Route | Pools | Accounts | Active accounts | Pool IDs shared with Pi |
|---|---:|---:|---:|---:|
| `http://192.168.1.54:20128` | 8 | 18 | 4 | — |
| `http://100.74.116.125:20128` | 8 | 18 | 4 | all 8 |
| `http://100.73.175.42:20128` | 8 | 18 | 8 | 3 shared socks pools only |

Pi pool endpoints include `128.199.202.122:3128`, `139.162.78.109:3128`, `159.203.61.169:8080`, `176.111.37.216:39811`, `34.43.46.91:443`, and shared `100.71.252.27:10001-10003` socks pools. Old host has distinct endpoints `176.111.37.5:39811`, `103.237.102.191:11111`, `146.190.80.158:9090`, `128.199.116.219:9090`, `89.167.124.218:8888`, plus the three shared socks pools.

## Cutover decision

- Do not treat LAN and Tailscale Pi routes as independent routers.
- Do not blindly replay or merge old-host mutations: old pool IDs are instance-local, and active account state differs.
- Preserve this evidence before any host removal. Pool/account migration requires explicit endpoint-level import and account-to-Pi-pool ID translation, followed by health/quota verification.
