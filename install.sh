#!/usr/bin/env bash
#
# Pilot Link 中继器一键安装脚本（Ubuntu / Debian）
#
#   curl -fsSL https://download.medpilot.cc/pilot/connector/install.sh \
#     | sudo bash -s -- --domain relay.example.com --email you@example.com
#
# 不填 --domain 时只在本机 127.0.0.1:8789 启动，适合已有反向代理的机器。
# 中继器只转发端到端加密的密文，不保存会话，也不持有配对密钥。

set -euo pipefail

VERSION="${PILOT_CONNECTOR_VERSION:-0.2.3}"
BASE_URL="${PILOT_CONNECTOR_BASE_URL:-https://download.medpilot.cc/pilot/connector}"
NODE_VERSION="${NODE_VERSION:-22.12.0}"
NODE_MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"
INSTALL_DIR="${INSTALL_DIR:-/opt/pilot-connector}"
SERVICE_USER="${SERVICE_USER:-pilot}"
PORT="${PORT:-8789}"
BIND="${BIND:-127.0.0.1}"
# 空值 = 自动生成一条不可猜的路径（/c/<32 位十六进制>）。
WS_PATH="${WS_PATH:-}"
# 空值 = 自动生成一条 home:<32 位十六进制> 准入码。
ACCESS_KEYS="${RELAY_ACCESS_KEYS:-}"
ACCESS_STRICT="${RELAY_ACCESS_STRICT:-0}"
MAX_CONNECTIONS_PER_IP="${MAX_CONNECTIONS_PER_IP:-12}"
MAX_ROOMS="${MAX_ROOMS:-500}"
DOMAIN=""
EMAIL=""
SETUP_NGINX=1

usage() {
  cat <<'EOF'
用法：install.sh [选项]

  --domain <域名>   同时配置 nginx 与 Let's Encrypt 证书，输出 wss:// 地址
  --email <邮箱>    申请证书使用的邮箱（与 --domain 同时使用）
  --port <端口>     中继器监听端口（默认 8789）
  --bind <地址>     监听地址（默认 127.0.0.1，建议只监听回环）
  --dir <目录>      安装目录（默认 /opt/pilot-connector）
  --version <版本>  中继器版本（默认 0.2.3）
  --path <路径>     WebSocket 路径（默认自动生成 /c/<32 位十六进制>）
  --access-key <id:secret>  准入码（默认自动生成 home:<随机值>，可逗号分隔多条）
  --strict          强制要求准入码；不加则只记录不拦截（便于灰度）
  --no-nginx        即使提供域名，也不自动配置 nginx
  -h, --help        显示帮助

环境变量：
  NODE_VERSION     需要安装的 Node.js 版本（默认 22.12.0）
  NODE_MIRROR      Node.js 下载镜像（默认 https://nodejs.org/dist）
  PILOT_CONNECTOR_BASE_URL  安装包与校验文件所在目录
  RELAY_ACCESS_KEYS / RELAY_ACCESS_STRICT / MAX_CONNECTIONS_PER_IP / MAX_ROOMS
                   与上面同名命令行参数等价，直接写进 systemd 环境变量
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --email)
      EMAIL="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --bind)
      BIND="${2:-}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --path)
      WS_PATH="${2:-}"
      shift 2
      ;;
    --access-key)
      ACCESS_KEYS="${2:-}"
      shift 2
      ;;
    --strict)
      ACCESS_STRICT=1
      shift
      ;;
    --no-nginx)
      SETUP_NGINX=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 运行（例如 sudo bash install.sh）。" >&2
  exit 1
fi

if [ -n "$DOMAIN" ] && [ -z "$EMAIL" ]; then
  echo "--domain 需要同时提供 --email，用于申请 HTTPS 证书。" >&2
  exit 1
fi

if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$'; then
  echo "域名格式不正确：$DOMAIN" >&2
  exit 1
fi
if [ -n "$EMAIL" ] && ! printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$'; then
  echo "邮箱格式不正确：$EMAIL" >&2
  exit 1
fi
case "$PORT" in
  ''|*[!0-9]*)
    echo "端口必须是数字：$PORT" >&2
    exit 1
    ;;
esac
if ! printf '%s' "$BIND" | grep -Eq '^[A-Za-z0-9.:-]+$'; then
  echo "监听地址格式不正确：$BIND" >&2
  exit 1
fi
case "$WS_PATH" in
  /*) ;;
  *)
    echo "WebSocket 路径必须以 / 开头：$WS_PATH" >&2
    exit 1
    ;;
esac

if [ -z "$WS_PATH" ]; then
  WS_PATH="/c/$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
if [ -z "$ACCESS_KEYS" ]; then
  ACCESS_KEYS="home:$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
case "$ACCESS_STRICT" in
  0|1) ;;
  *)
    echo "RELAY_ACCESS_STRICT 只能是 0 或 1：$ACCESS_STRICT" >&2
    exit 1
    ;;
esac
if ! printf '%s' "$ACCESS_KEYS" | grep -Eq '^[A-Za-z0-9_-]+:[A-Za-z0-9_-]{16,128}(,[A-Za-z0-9_-]+:[A-Za-z0-9_-]{16,128})*$'; then
  echo "准入码格式不正确，应为 id:secret（secret 至少 16 个字符），多条用逗号分隔：$ACCESS_KEYS" >&2
  exit 1
fi

case "$(uname -s)" in
  Linux) ;;
  *)
    echo "当前脚本只支持 Linux；Windows 请下载 Windows 包并运行 install.ps1。" >&2
    exit 1
    ;;
esac

need_command() {
  command -v "$1" >/dev/null 2>&1
}

if ! need_command curl; then
  if need_command apt-get; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
  else
    echo "缺少 curl，请先安装后重试。" >&2
    exit 1
  fi
fi

node_ok() {
  need_command node || return 1
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number)
    process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)
  ' >/dev/null 2>&1
}

install_node() {
  echo "→ 安装 Node.js v${NODE_VERSION}…"
  case "$(uname -m)" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *)
      echo "不支持的 CPU 架构：$(uname -m)；请手动安装 Node.js 22.12+。" >&2
      exit 1
      ;;
  esac
  local package="node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"
  local temp
  temp="$(mktemp -d)"
  curl -fsSL "${NODE_MIRROR}/v${NODE_VERSION}/${package}" -o "${temp}/${package}"
  tar -xzf "${temp}/${package}" -C /usr/local --strip-components=1
  rm -rf "${temp}"
  hash -r
}

if ! node_ok; then
  install_node
fi

if ! need_command systemctl; then
  echo "当前系统没有 systemd，请手动运行 node ${INSTALL_DIR}/server.mjs。" >&2
  exit 1
fi

echo "→ 下载 Pilot Connector v${VERSION}…"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT
PACKAGE="pilot-connector-${VERSION}-linux.tar.gz"
curl -fsSL "${BASE_URL}/${PACKAGE}" -o "${TEMP_DIR}/${PACKAGE}"
curl -fsSL "${BASE_URL}/${PACKAGE}.sha256" -o "${TEMP_DIR}/${PACKAGE}.sha256"

echo "→ 校验 SHA-256…"
(
  cd "${TEMP_DIR}"
  sha256sum -c "${PACKAGE}.sha256"
)

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

echo "→ 安装到 ${INSTALL_DIR}…"
rm -rf "${INSTALL_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${INSTALL_DIR}"
tar -xzf "${TEMP_DIR}/${PACKAGE}" -C "${INSTALL_DIR}" --strip-components=1
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

NODE_BIN="$(command -v node)"
cat >/etc/systemd/system/pilot-connector.service <<EOF
[Unit]
Description=Pilot Link cloud connector
Documentation=https://pilot.medpilot.cc/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=BIND=${BIND}
Environment=WS_PATH=${WS_PATH}
Environment=RELAY_ACCESS_KEYS=${ACCESS_KEYS}
Environment=RELAY_ACCESS_STRICT=${ACCESS_STRICT}
Environment=MAX_CONNECTIONS_PER_IP=${MAX_CONNECTIONS_PER_IP}
Environment=MAX_ROOMS=${MAX_ROOMS}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${INSTALL_DIR}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pilot-connector

echo "→ 等待健康检查…"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 0.5
done

if [ "${healthy}" -ne 1 ]; then
  echo "中继器没有通过健康检查。查看日志：journalctl -u pilot-connector -n 80 --no-pager" >&2
  exit 1
fi

if [ -n "${DOMAIN}" ] && [ "${SETUP_NGINX}" -eq 1 ]; then
  echo "→ 配置 nginx 与 HTTPS 证书：${DOMAIN}"
  if ! need_command nginx || ! need_command certbot; then
    if need_command apt-get; then
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
    else
      echo "请手动安装 nginx 与 certbot，然后把 /connector 反向代理到 127.0.0.1:${PORT}。" >&2
      exit 1
    fi
  fi

  cat >/etc/nginx/sites-available/pilot-connector <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location = ${WS_PATH} {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        access_log off;
    }

    location = /healthz {
        proxy_pass http://127.0.0.1:${PORT}/healthz;
        access_log off;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/pilot-connector /etc/nginx/sites-enabled/pilot-connector
  nginx -t
  systemctl reload nginx

  certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" --redirect
  echo ""
  echo "✓ 中继器已就绪：wss://${DOMAIN}${WS_PATH}#k=${ACCESS_KEYS}"
  if [ "${ACCESS_STRICT}" -eq 1 ]; then
    echo "  准入码已强制生效（RELAY_ACCESS_STRICT=1）。把上面整条连接串粘到 Pilot 的「手机连接 → 自建中继器 → 中继地址」。"
  else
    echo "  准入码目前只记录不拦截（RELAY_ACCESS_STRICT=0）。把上面整条连接串粘到 Pilot 的中继地址，"
    echo "  确认各端都能连上后，把 /etc/systemd/system/pilot-connector.service 里的 RELAY_ACCESS_STRICT 改成 1，"
    echo "  再执行 systemctl daemon-reload && systemctl restart pilot-connector。"
  fi
  echo "  #k= 之后是准入码，不要单独发出去；换密码就改这里的 RELAY_ACCESS_KEYS 并重启。"
else
  echo ""
  echo "✓ 中继器已启动：http://${BIND}:${PORT}${WS_PATH}"
  echo "  手机连接要求 wss://。请用 nginx / Caddy 反向代理并配置 TLS（location = ${WS_PATH}），"
  echo "  然后把 wss://你的域名${WS_PATH}#k=${ACCESS_KEYS} 填到 Pilot 的中继地址。"
fi

echo "  服务管理：systemctl status pilot-connector / journalctl -u pilot-connector -f"
