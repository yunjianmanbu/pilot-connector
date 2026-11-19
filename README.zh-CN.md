# Pilot Connector

[English](README.md) | **中文**

**官网与下载：** <https://pilot.medpilot.cc/zh.html#connector-download> —— 截图、演示视频与各平台安装包。

Pilot 手机连接的云端盲中继。它只按房间转发 WebSocket 帧，不保存消息，也不持有端到端密钥。
**Pilot 官方不提供公共中继服务**，需要跨网络使用手机连接时请自行部署。

## 下载

- Linux：<https://download.medpilot.cc/pilot/connector/pilot-connector-0.2.1-linux.tar.gz>
- Windows：<https://download.medpilot.cc/pilot/connector/pilot-connector-0.2.1-windows.zip>
- 一键安装脚本：<https://download.medpilot.cc/pilot/connector/install.sh>

两个包都包含 `server.mjs`、`ws` 依赖、systemd / nginx 示例；需要 Node.js >= 22.12。
安装包旁提供同名 `.sha256`，下载后可自行校验。

## 云服务器一键安装（Ubuntu / Debian）

在云服务器上以 root 执行（域名需已解析到该服务器，并开放 80/443）：

```bash
curl -fsSL https://download.medpilot.cc/pilot/connector/install.sh \
  | sudo bash -s -- --domain relay.example.com --email you@example.com
```

脚本会：

1. 缺少 Node.js 22.12+ 时自动安装；
2. 下载中继器并校验 SHA-256；
3. 创建 `pilot` 系统用户、`/opt/pilot-connector` 与 systemd 服务；
4. 配置 nginx，把 `/connector` 反向代理到 `127.0.0.1:8789`；
5. 用 certbot 申请 HTTPS 证书，最后输出 `wss://relay.example.com/connector`。

把输出的地址填到 Pilot 的「手机连接 → 自建中继器 → 中继地址」。

没有域名时可以只在本机启动：

```bash
curl -fsSL https://download.medpilot.cc/pilot/connector/install.sh | sudo bash
```

之后自行用 nginx / Caddy 配置 TLS，再填写 `wss://.../connector`。

## 手动启动

```bash
npm install --omit=dev
PORT=8789 BIND=127.0.0.1 WS_PATH=/connector node server.mjs
```

健康检查：`curl http://127.0.0.1:8789/healthz`

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口（安装脚本默认 `8789`） |
| `BIND` | `127.0.0.1` | 监听地址，建议只监听回环并由 nginx 反代 |
| `WS_PATH` | `/connector` | WebSocket 升级路径 |
| `HOST_GRACE_MS` | `30000` | 电脑端断开后保留手机连接的宽限期 |

## 连接恢复

电脑端的中继套接字短暂断开时，中继器不会立刻踢掉手机：宽限期内保留手机
WebSocket，替电脑回应手机的心跳，等电脑端重新连回同一个房间。电脑端可在
`relay.hello` 中带上稳定的 `hostInstance`；值相同表示同一进程重连，手机连接
无缝续接，值不同（电脑重启）则中继器让手机重新握手，避免留下假在线连接。
宽限期内的业务帧会被丢弃，只缓冲 `hello` / `hello.proof` / `pair.join`，
避免手机已经超时后指令才被执行。

## Windows

解压后在该目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：

1. 检查 Node.js 22.12+；
2. 生成 `run-connector.cmd`；
3. 创建当前用户登录时自动启动的计划任务 `PilotConnector`；
4. 健康检查 `http://127.0.0.1:8789/healthz`。

Windows 同样需要反向代理提供 `wss://`（nginx / Caddy / IIS 均可），再把
`wss://你的域名/connector` 填到 Pilot。卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## systemd

```bash
useradd --system --home /opt/pilot-connector --shell /usr/sbin/nologin pilot
mkdir -p /opt/pilot-connector
cp server.mjs package.json /opt/pilot-connector/
cd /opt/pilot-connector && npm install --omit=dev
cp deploy/pilot-connector.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pilot-connector
```

服务默认以 `www` 用户运行、监听 `127.0.0.1:8789`。如使用其他用户或路径，请同步修改 service 文件。
一键安装脚本会生成使用 `pilot` 用户的版本。

## nginx

在 HTTPS server 中加入（完整示例见 `deploy/nginx-connector.conf`）：

```nginx
location = /connector {
    proxy_pass http://127.0.0.1:8789;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    access_log off;
}
```

## 在 Pilot 中配置

打开电脑端「手机连接」，在「自建中继器」中填写 `wss://你的域名/connector` 并保存。
保存后会断开旧中继房间，下一次生成配对二维码时使用新地址。留空则只在同一局域网内连接。

也可以用环境变量覆盖（优先级高于设置）：

```bash
PILOT_RELAY_URL=wss://relay.example.com/connector
```

## 安全边界

- 连接器只转发密文，配对 token 与手机会话密钥不会以明文经过服务器。
- 不记录帧内容；只保留连接数等运行状态。
- 每房间最多 4 台手机，单帧上限 1 MB，并对消息速率做限制。
- 房间密钥由桌面端生成，经一次性二维码传递；连接器只做房间隔离。

## License

[Apache License 2.0](LICENSE)。自建或对外提供中继服务无需额外授权，也无需公开改造后的
源码，保留 [`NOTICE`](NOTICE) 即可。
