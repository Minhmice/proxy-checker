#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# ProxyFleet Worker Agent Installer
# ==============================================================================

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: This script must be run as root (e.g. via sudo)." >&2
  exit 1
fi

SERVER=""
TOKEN=""
NODE_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      SERVER="${2:-}"
      shift $(( $# >= 2 ? 2 : 1 ))
      ;;
    --token)
      TOKEN="${2:-}"
      shift $(( $# >= 2 ? 2 : 1 ))
      ;;
    --node-name)
      NODE_NAME="${2:-}"
      shift $(( $# >= 2 ? 2 : 1 ))
      ;;
    -h|--help)
      echo "Usage: $0 --server <CONTROL_URL> --token <ENROLLMENT_TOKEN> [--node-name <NAME>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${SERVER}" ]]; then
  echo "Error: --server is required" >&2
  exit 1
fi

if [[ -z "${TOKEN}" && ! -f /etc/proxyfleet/state.json ]]; then
  echo "Error: --token is required for initial enrollment" >&2
  exit 1
fi

if [[ -z "${NODE_NAME}" ]]; then
  NODE_NAME="$(hostname -s 2>/dev/null || hostname)"
fi

echo "=== [ProxyFleet] Starting Worker Node Installation ==="
echo "Controller: ${SERVER}"
echo "Node Name:  ${NODE_NAME}"

# 1. Detect OS
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  echo "Detected OS: ${NAME} ${VERSION_ID:-}"
else
  echo "Warning: /etc/os-release not found. Proceeding with standard Linux setup."
fi

# 2. Detect Architecture
ARCH_RAW="$(uname -m)"
USERLAND_ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
case "${USERLAND_ARCH:-${ARCH_RAW}}" in
  amd64|x86_64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  armhf|armv7l|armv7|arm) ARCH="armv7" ;;
  *)
    echo "Error: Unsupported userland architecture ${USERLAND_ARCH:-${ARCH_RAW}}" >&2
    exit 1
    ;;
esac
if [[ "${ARCH}" == "arm64" && "$(getconf LONG_BIT)" == "32" ]]; then
  ARCH="armv7"
fi
echo "Detected architecture: kernel=${ARCH_RAW}, userland=${USERLAND_ARCH:-unknown}, binary=${ARCH}"

# 3. Install System Dependencies
echo "Installing prerequisites via apt..."
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || true
  # Install core packages (never abort entire script if 3proxy is not available in debian repository)
  apt-get install -y -qq curl jq wireguard wireguard-tools nftables iproute2 build-essential git make >/dev/null || \
    apt-get install -y -qq curl jq wireguard wireguard-tools nftables iproute2 >/dev/null || true

  # Check if 3proxy package is installable, otherwise install from source
  if ! command -v 3proxy >/dev/null 2>&1; then
    if apt-cache show 3proxy >/dev/null 2>&1; then
      apt-get install -y -qq 3proxy >/dev/null || true
    fi
  fi
fi

# 3.1 Ensure 3proxy is available (Fallback to Native Source Build if absent)
if ! command -v 3proxy >/dev/null 2>&1 && [[ ! -x "/usr/local/bin/3proxy" ]] && [[ ! -x "/usr/bin/3proxy" ]]; then
  echo "Package '3proxy' not found in apt repository. Building 3proxy natively from source..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y -qq build-essential git make gcc >/dev/null || true
  fi

  BUILD_TMP="$(mktemp -d)"
  if git clone --depth 1 https://github.com/3proxy/3proxy.git "${BUILD_TMP}/3proxy" >/dev/null 2>&1; then
    (
      cd "${BUILD_TMP}/3proxy"
      make -f Makefile.Linux -j1 >/dev/null 2>&1 || make -f Makefile.Linux >/dev/null 2>&1
      if [[ -f "bin/3proxy" ]]; then
        install -m 755 bin/3proxy /usr/local/bin/3proxy
        echo "Successfully built and installed 3proxy to /usr/local/bin/3proxy"
      fi
    )
    rm -rf "${BUILD_TMP}"
  fi
fi

PROXY_BIN=""
if command -v 3proxy >/dev/null 2>&1; then
  PROXY_BIN="$(command -v 3proxy)"
elif [[ -x "/usr/local/bin/3proxy" ]]; then
  PROXY_BIN="/usr/local/bin/3proxy"
elif [[ -x "/usr/bin/3proxy" ]]; then
  PROXY_BIN="/usr/bin/3proxy"
else
  echo "Error: 3proxy is unavailable; install it before enrolling this node." >&2
  exit 1
fi
echo "Using 3proxy binary: ${PROXY_BIN}"
# 4. Create Directory Layout
mkdir -p /etc/proxyfleet
chmod 700 /etc/proxyfleet
mkdir -p /etc/3proxy
chmod 755 /etc/3proxy
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard

# 5. Download / Install proxyfleet-agent Binary
BINARY_DEST="/usr/local/bin/proxyfleet-agent"
DOWNLOAD_URL="${SERVER%/}/bin/proxyfleet-agent-linux-${ARCH}"

echo "Fetching agent binary from ${DOWNLOAD_URL}..."
if ! curl -fsSL -o "${BINARY_DEST}.tmp" "${DOWNLOAD_URL}"; then
  # Check if binary is present locally
  if [[ -f "./bin/proxyfleet-agent-linux-${ARCH}" ]]; then
    echo "Using local binary ./bin/proxyfleet-agent-linux-${ARCH}"
    cp "./bin/proxyfleet-agent-linux-${ARCH}" "${BINARY_DEST}.tmp"
  else
    echo "Error: Failed to download agent binary from ${DOWNLOAD_URL}" >&2
    exit 1
  fi
fi

chmod 755 "${BINARY_DEST}.tmp"
if ! "${BINARY_DEST}.tmp" --version; then
  rm -f "${BINARY_DEST}.tmp"
  echo "Error: Downloaded agent cannot run on this userland; existing binary preserved." >&2
  exit 1
fi
mv -f "${BINARY_DEST}.tmp" "${BINARY_DEST}"
echo "Agent binary installed to ${BINARY_DEST}"

# 6. Bootstrap Initial 3proxy Configuration if absent
if [[ ! -f /etc/3proxy/3proxy.cfg ]]; then
  cat << 'EOF' > /etc/3proxy/3proxy.cfg
# Default empty 3proxy configuration managed by proxyfleet-agent
nserver 1.1.1.1
nserver 8.8.8.8
nscache 65536
timeouts 1 5 30 60 180 1800 15 60
EOF
  chmod 600 /etc/3proxy/3proxy.cfg
fi

# 7. Configure Systemd Service for 3proxy
cat << EOF > /etc/systemd/system/3proxy.service
[Unit]
Description=3proxy Tiny Proxy Server
After=network-online.target

[Service]
Type=simple
ExecStart=${PROXY_BIN:-/usr/local/bin/3proxy} /etc/3proxy/3proxy.cfg
ExecReload=/bin/kill -SIGUSR1 \$MAINPID
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# 8. Configure Systemd Service for proxyfleet-agent
systemd_arg() {
  local value="$1"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "Error: Service arguments cannot contain line breaks." >&2
    exit 1
  fi
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  value="${value//\$/\$\$}"
  printf '"%s"' "$value"
}
SERVER_ARG="$(systemd_arg "${SERVER}")"
NODE_ARG="$(systemd_arg "${NODE_NAME}")"
TOKEN_ARG=""
if [[ -n "${TOKEN}" ]]; then
  TOKEN_ARG="--token $(systemd_arg "${TOKEN}")"
fi

cat << EOF > /etc/systemd/system/proxyfleet-agent.service
[Unit]
Description=ProxyFleet Node Worker Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BINARY_DEST} --server ${SERVER_ARG} --node-name ${NODE_ARG} --config-dir /etc/proxyfleet --proxy-config /etc/3proxy/3proxy.cfg ${TOKEN_ARG}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

chmod 600 /etc/systemd/system/proxyfleet-agent.service
chmod 644 /etc/systemd/system/3proxy.service

# 9. Firewall Configuration (nftables)
# Restrict proxy ports (20000-39999) to WireGuard overlay (10.77.0.0/24) and loopback
cat << 'EOF' > /etc/nftables-proxyfleet.conf
table inet proxyfleet {
  chain input {
    type filter hook input priority 0; policy accept;
    # Only traffic arriving through the owned tunnel may reach managed ports.
    # Allow proxy traffic arriving via Tailscale overlay or loopback
    iifname "tailscale0" tcp dport 20000-39999 accept
    ip saddr 100.64.0.0/10 tcp dport 20000-39999 accept
    iif "lo" tcp dport 20000-39999 accept
    tcp dport 20000-39999 drop
  }
}
EOF

if ! command -v nft >/dev/null 2>&1; then
  echo "Error: nftables is required to protect managed listener ports." >&2
  exit 1
fi
nft -f /etc/nftables-proxyfleet.conf

# 10. Enable and Start Services
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable 3proxy.service
  systemctl enable proxyfleet-agent.service
  # Agent provisions its owned overlay before applying and starting 3proxy.
  systemctl restart proxyfleet-agent.service
  echo "=== [ProxyFleet] Services enabled and started successfully ==="
else
  echo "Error: This installer requires systemd for managed services." >&2
  exit 1
fi

echo "=== [ProxyFleet] Installation Complete for Node: ${NODE_NAME} ==="
