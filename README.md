# Pilot Connector

**English** | [中文](README.zh-CN.md)


[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/yunjianmanbu/pilot-connector?color=blue)](https://github.com/yunjianmanbu/pilot-connector/releases)
[![Discussions](https://img.shields.io/badge/discussions-open-2ea44f.svg)](https://github.com/yunjianmanbu/pilot/discussions)


A blind cloud relay for piloting your phone. It forwards WebSocket frames by room only — it never
stores messages and never holds the end-to-end keys.
**There is no public relay run by the Pilot project** — to reach your phone across networks,
deploy your own.

## Download

- Linux: <https://download.medpilot.cc/pilot/connector/pilot-connector-0.2.1-linux.tar.gz>
- Windows: <https://download.medpilot.cc/pilot/connector/pilot-connector-0.2.1-windows.zip>
- One-line installer: <https://download.medpilot.cc/pilot/connector/install.sh>

Both packages ship `server.mjs`, the `ws` dependency and systemd / nginx samples; Node.js >= 22.12
is required. Each archive has a matching `.sha256` file so you can verify it after downloading.

## One-line install on a cloud box (Ubuntu / Debian)

Run as root on the server (the domain must already resolve to it, with 80/443 open):

```bash
curl -fsSL https://download.medpilot.cc/pilot/connector/install.sh \
  | sudo bash -s -- --domain relay.example.com --email you@example.com
```

The script will:

1. install Node.js 22.12+ if it is missing;
2. download the connector and verify its SHA-256;
3. create the `pilot` system user, `/opt/pilot-connector` and a systemd service;
4. configure nginx to reverse-proxy `/connector` to `127.0.0.1:8789`;
5. obtain an HTTPS certificate with certbot and print `wss://relay.example.com/connector`.

Put the printed address into Pilot under "Phone connection → Self-hosted relay → Relay address".

Without a domain you can start it locally first:

```bash
curl -fsSL https://download.medpilot.cc/pilot/connector/install.sh | sudo bash
```

Then terminate TLS yourself with nginx / Caddy and configure `wss://.../connector`.

## Start manually

```bash
npm install --omit=dev
PORT=8789 BIND=127.0.0.1 WS_PATH=/connector node server.mjs
```

Health check: `curl http://127.0.0.1:8789/healthz`

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Listening port (the installer defaults to `8789`) |
| `BIND` | `127.0.0.1` | Listening address; bind to loopback and let nginx proxy to it |
| `WS_PATH` | `/connector` | WebSocket upgrade path |
| `HOST_GRACE_MS` | `30000` | Grace period that keeps the phone connection after the desktop drops |

## Connection recovery

When the desktop relay socket drops briefly, the connector does not kick the phone immediately: it
keeps the phone WebSocket for the grace period, answers the phone's heartbeats on the desktop's
behalf, and waits for the desktop to rejoin the same room. The desktop may send a stable
`hostInstance` in `relay.hello`; the same value means the same process reconnecting, so the phone
connection resumes seamlessly, while a different value (desktop rebooted) makes the connector have
the phone re-handshake instead of leaving a fake-online connection behind. Business frames during
the grace period are dropped, and only `hello` / `hello.proof` / `pair.join` are buffered, so a
command is never executed after the phone has already timed out.

## Windows

Unzip and run in that directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The script will:

1. check for Node.js 22.12+;
2. generate `run-connector.cmd`;
3. create a scheduled task `PilotConnector` that starts at user logon;
4. health-check `http://127.0.0.1:8789/healthz`.

Windows also needs a reverse proxy for `wss://` (nginx / Caddy / IIS all work); then put
`wss://your-domain/connector` into Pilot. To uninstall:

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

The service runs as the `www` user on `127.0.0.1:8789` by default. If you use another user or path,
update the service file accordingly. The one-line installer generates a variant that runs as the
`pilot` user.

## nginx

Add this to the HTTPS server block (see `deploy/nginx-connector.conf` for the full sample):

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

## Configure it in Pilot

Open "Phone connection" on the desktop, fill `wss://your-domain/connector` into "Self-hosted relay"
and save. Saving drops the old relay room, and the next pairing QR code uses the new address. Leave
it empty to connect over the local network only.

You can also override it with an environment variable (takes precedence over the setting):

```bash
PILOT_RELAY_URL=wss://relay.example.com/connector
```

## Security model

- The connector only forwards ciphertext; pairing tokens and phone session keys never cross the
  server in plaintext.
- Frame contents are not logged; only runtime state such as connection counts is kept.
- At most 4 phones per room, 1 MB per frame, with rate limiting on messages.
- Room keys are generated on the desktop and handed over through a one-time QR code; the connector
  only enforces room isolation.

## License

[Apache License 2.0](LICENSE). Self-hosting or commercially hosting a relay needs no extra
permission and no publication of your modified source — keep [`NOTICE`](NOTICE) and you are done.
