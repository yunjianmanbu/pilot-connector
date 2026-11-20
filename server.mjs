#!/usr/bin/env node
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

/**
 * Pilot cloud connector.
 *
 * A blind WebSocket relay for Pilot Link. The desktop opens an outbound host
 * channel to a room; a phone joins the same room. The relay only forwards
 * opaque frames, keeps no conversation data, and never receives E2E keys.
 *
 * Two independent gates stand in front of that: a secret WebSocket path
 * (`WS_PATH`, unguessable instead of the default `/connector`) and an optional
 * admission code (`RELAY_ACCESS_KEYS` / `RELAY_ACCESS_STRICT`) carried as
 * `access` on relay.hello. The code never reaches the E2E layer, is not a
 * per-room secret, and is checked before any room is created.
 *
 * Protocol (all frames are JSON):
 *   client -> relay.hello   { role: 'host'|'phone', room, key, protocol, access? }
 *   relay  -> relay.ready   { role, protocol }
 *   phone  -> relay.frame   { data: <opaque frame> }
 *   relay  -> host          { type:'relay.frame', cid, data }
 *   host   -> relay.send    { cid, data }
 *   relay  -> phone         <data verbatim>
 *   host   -> relay.close   { cid, code, reason }
 *   relay  -> host          { type:'relay.peer-open'|'relay.peer-close', cid }
 *   relay  -> client        { type:'relay.error', message, fatal? }
 */

const PORT = Number(process.env.PORT || 8787)
const BIND = process.env.BIND || '127.0.0.1'
const WS_PATH = process.env.WS_PATH || '/connector'
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 10_000)
const MAX_PHONES_PER_ROOM = 4
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_MESSAGES_PER_MINUTE = 900
const PENDING_PHONE_MS = 90_000
// A desktop relay socket can drop for a second or two without the desktop
// itself going away. Keep phone sockets alive for a short grace period so a
// transient host reconnect does not show up as "电脑已离线" on every phone.
const HOST_GRACE_CONFIG = Number(process.env.HOST_GRACE_MS)
const HOST_GRACE_MS =
  Number.isFinite(HOST_GRACE_CONFIG) && HOST_GRACE_CONFIG >= 0 ? HOST_GRACE_CONFIG : 30_000
// While the host is away, buffer only control frames (hello / proof /
// pair.join). Business frames are dropped so a request cannot execute after
// the phone has already timed out and shown an error to the user.
const MAX_PENDING_FRAMES = 32
const HEARTBEAT_MS = 25_000
// Mobile links regularly miss a single pong. Terminating on the first miss
// looks like a random disconnect on the phone; tolerate a few in a row.
const HEARTBEAT_MISS_LIMIT = 3
const ROOM_RE = /^[A-Za-z0-9_-]{16,128}$/
const KEY_RE = /^[A-Za-z0-9_-]{22,128}$/
const ID_RE = /^[A-Za-z0-9_-]{8,80}$/
// `id:secret`. The id names a device or a household so one code can be revoked
// without touching the others; the secret is the part that matters.
const ACCESS_KEY_RE = /^([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]{16,128})$/

// ---- Abuse containment ----
// The connector never reads frame payloads, so an operator's only levers are
// connection accounting and a static blocklist. That is a deliberate limit:
// investigating what a source was transferring would break the blind-relay
// promise for every other user. MAX_CONNECTIONS_PER_IP=0 disables the cap;
// 64 is generous for a household or a small office behind one NAT.
const MAX_CONNECTIONS_PER_IP = Number(process.env.MAX_CONNECTIONS_PER_IP ?? 64)
const IP_CONNECTION_LIMIT =
  Number.isFinite(MAX_CONNECTIONS_PER_IP) && MAX_CONNECTIONS_PER_IP > 0 ? MAX_CONNECTIONS_PER_IP : 0
const BLOCKED_IPS = new Set(
  String(process.env.RELAY_BLOCK_IPS || '')
    .split(',')
    .map((value) => normalizeIp(value.trim()))
    .filter(Boolean)
)
const ipConnections = new Map()

// ---- L1 admission ----
// Deliberately weak and deliberately simple: one shared code per device group,
// no accounts, no enrolment. It keeps a leaked URL from turning the relay into
// free bandwidth. It does NOT protect message contents (E2E does) and it does
// not survive someone handing over the full connection string.
const ACCESS_KEYS = new Map()
const ACCESS_STRICT = parseFlag(process.env.RELAY_ACCESS_STRICT)
const accessStats = { anonymous: 0, rejected: 0 }
const ANONYMOUS_LOG_INTERVAL_MS = 60_000
let lastAnonymousLogAt = 0

const rooms = new Map()

function parseFlag(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return text === '1' || text === 'true' || text === 'yes' || text === 'on'
}

for (const entry of String(process.env.RELAY_ACCESS_KEYS || '').split(',')) {
  const text = entry.trim()
  if (!text) continue
  const match = ACCESS_KEY_RE.exec(text)
  if (!match) {
    console.error(
      '[pilot-connector] RELAY_ACCESS_KEYS 里的条目格式不正确，应为 id:secret（secret 至少 16 个字符）：' +
        text.slice(0, 40),
    )
    process.exit(1)
  }
  if (ACCESS_KEYS.has(match[1])) {
    console.error(`[pilot-connector] RELAY_ACCESS_KEYS 里 id 重复：${match[1]}`)
    process.exit(1)
  }
  ACCESS_KEYS.set(match[1], match[2])
}
if (ACCESS_STRICT && ACCESS_KEYS.size === 0) {
  // Strict mode with no codes is an outage, not a policy: refuse to start
  // instead of silently locking every device out.
  console.error('[pilot-connector] RELAY_ACCESS_STRICT 已开启但没有配置 RELAY_ACCESS_KEYS')
  process.exit(1)
}

function normalizeIp(value) {
  const ip = String(value || '')
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

function isLoopback(ip) {
  return ip === '::1' || ip === 'localhost' || ip.startsWith('127.')
}

/**
 * The address the connection is accounted against.
 * Behind nginx / Caddy the socket is always the proxy, so trust the *last*
 * X-Forwarded-For entry (the one the proxy appended) — a client-supplied
 * header cannot move the count onto someone else. Direct (non-loopback)
 * connections are accounted by their own address.
 */
function clientIp(request) {
  const remote = normalizeIp(request.socket?.remoteAddress)
  if (!isLoopback(remote)) return remote
  const forwarded = String(request.headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => normalizeIp(value.trim()))
    .filter(Boolean)
  return forwarded.length ? forwarded[forwarded.length - 1] : remote
}

function takeIpSlot(ip) {
  const used = ipConnections.get(ip) || 0
  if (IP_CONNECTION_LIMIT && used >= IP_CONNECTION_LIMIT) return false
  ipConnections.set(ip, used + 1)
  return true
}

function releaseIpSlot(ip) {
  if (!ip) return
  const used = (ipConnections.get(ip) || 0) - 1
  if (used > 0) ipConnections.set(ip, used)
  else ipConnections.delete(ip)
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8')
  const b = Buffer.from(String(right), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Decide whether this socket may take part in the room protocol.
 *
 * With no codes configured the relay behaves exactly like 0.2.2 (open), so a
 * self-hoster who never opts in sees no change. With codes configured but
 * strict off, an anonymous (or wrong-code) socket is still admitted so a
 * rollout cannot lock out devices that have not been updated yet; it is only
 * counted and logged. Strict rejects the handshake with 4009.
 */
function authorize(socket, value) {
  if (ACCESS_KEYS.size === 0) return true
  const text = typeof value === 'string' ? value.trim() : ''
  if (text) {
    const match = ACCESS_KEY_RE.exec(text)
    const expected = match ? ACCESS_KEYS.get(match[1]) : undefined
    if (expected && safeEqual(expected, match[2])) {
      socket.accessId = match[1]
      return true
    }
    accessStats.rejected += 1
    reject(socket, '连接器准入码不正确')
    return false
  }
  if (ACCESS_STRICT) {
    accessStats.rejected += 1
    reject(socket, '连接器要求准入码')
    return false
  }
  accessStats.anonymous += 1
  const now = Date.now()
  if (now - lastAnonymousLogAt >= ANONYMOUS_LOG_INTERVAL_MS) {
    lastAnonymousLogAt = now
    const ip = normalizeIp(socket.clientIp || '') || 'unknown'
    console.warn(
      `[pilot-connector] 收到无准入码的连接（来源 ${ip}），当前 RELAY_ACCESS_STRICT=0 仍放行；` +
        '各端都更新后请把它设为 1。',
    )
  }
  return true
}

function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(text)
}

function send(socket, frame) {
  if (socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

function sendRaw(socket, text) {
  if (socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(text)
    return true
  } catch {
    return false
  }
}

function closeSocket(socket, code, reason) {
  try {
    socket.close(code, String(reason || '').slice(0, 120))
  } catch {
    try {
      socket.terminate()
    } catch {
      // ignore
    }
  }
}

function reject(socket, message, fatal = true) {
  send(socket, { type: 'relay.error', message: String(message).slice(0, 200), fatal })
  closeSocket(socket, 4009, message)
}

function createRoom(roomId, key) {
  if (rooms.size >= MAX_ROOMS) return null
  const room = {
    id: roomId,
    key,
    host: null,
    // Identifies one desktop process across relay-socket reconnects. A new
    // value means the desktop restarted, so phones must re-authenticate.
    hostInstance: '',
    hostGraceTimer: null,
    pending: [],
    phones: new Map(),
    createdAt: Date.now(),
  }
  rooms.set(roomId, room)
  return room
}

function clearHostGrace(room) {
  if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer)
  room.hostGraceTimer = null
}

function deleteRoomIfEmpty(room) {
  if (!room.host && room.phones.size === 0 && rooms.get(room.id) === room) {
    clearHostGrace(room)
    room.pending = []
    rooms.delete(room.id)
  }
}

function resetPhones(room, message) {
  const text = String(message || '电脑已重新连接，请稍后重试').slice(0, 120)
  for (const phone of room.phones.values()) {
    clearTimeout(phone.pendingTimer)
    send(phone.socket, { type: 'relay.error', message: text })
    closeSocket(phone.socket, 4001, text)
  }
  room.phones.clear()
  room.pending = []
}

function flushPending(room) {
  if (!room.host) return
  const pending = room.pending
  room.pending = []
  for (const item of pending) {
    if (!room.phones.has(item.cid)) continue
    send(room.host, { type: 'relay.frame', cid: item.cid, data: item.data })
  }
}

function hostPeerOpen(room, phone) {
  if (!room.host) return
  send(room.host, { type: 'relay.peer-open', cid: phone.cid })
}

function hostPeerClose(room, phone) {
  if (!room.host) return
  send(room.host, { type: 'relay.peer-close', cid: phone.cid })
}

function attachPhone(room, socket) {
  if (room.phones.size >= MAX_PHONES_PER_ROOM) {
    reject(socket, '这个配对已有太多连接，请稍后重试')
    return null
  }
  const phone = {
    cid: randomUUID(),
    socket,
    pendingTimer: null,
  }
  phone.pendingTimer = setTimeout(() => {
    if (!room.host) {
      send(socket, { type: 'relay.error', message: '电脑当前离线，请确认 Pilot 已开启' })
      closeSocket(socket, 4001, 'host offline')
    }
  }, PENDING_PHONE_MS)
  room.phones.set(phone.cid, phone)
  socket.cid = phone.cid
  socket.room = room
  socket.role = 'phone'
  send(socket, { type: 'relay.ready', role: 'phone', protocol: 1 })
  hostPeerOpen(room, phone)
  return phone
}

function attachHost(room, socket, hostInstance) {
  const previous = room.host
  const sameDesktop = Boolean(hostInstance) && hostInstance === room.hostInstance
  const hadPhones = room.phones.size > 0
  clearHostGrace(room)
  if (previous && previous !== socket) {
    // A reconnecting desktop replaces its old half-dead socket. The old close
    // handler checks room.host before touching room state.
    room.host = socket
    send(previous, { type: 'relay.error', message: '连接器已建立新的主机通道', fatal: true })
    closeSocket(previous, 4001, 'replaced')
  } else {
    room.host = socket
  }
  room.hostInstance = hostInstance
  socket.room = room
  socket.role = 'host'
  send(socket, { type: 'relay.ready', role: 'host', protocol: 1 })
  if (!hadPhones) return
  if (!sameDesktop) {
    // The desktop process restarted. Phone sockets point at the old process
    // state, so ask them to reconnect and authenticate against the new one.
    resetPhones(room, '电脑已重新连接，请稍后重试')
    return
  }
  flushPending(room)
  for (const phone of room.phones.values()) hostPeerOpen(room, phone)
}

function handleHello(socket, frame) {
  const role = frame.role
  const roomId = frame.room
  const key = frame.key
  if (role !== 'host' && role !== 'phone') {
    reject(socket, '连接器身份不正确')
    return
  }
  if (typeof roomId !== 'string' || !ROOM_RE.test(roomId)) {
    reject(socket, '连接器房间标识不正确')
    return
  }
  if (!authorize(socket, frame.access)) return
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    reject(socket, '连接器房间密钥不正确')
    return
  }
  let room = rooms.get(roomId)
  if (room && room.key !== key) {
    reject(socket, '连接器房间密钥不匹配')
    return
  }
  if (!room) {
    room = createRoom(roomId, key)
    if (!room) {
      reject(socket, '连接器繁忙，请稍后重试')
      return
    }
  }
  socket.authed = true
  if (role === 'host') {
    const instance =
      typeof frame.hostInstance === 'string' && ID_RE.test(frame.hostInstance)
        ? frame.hostInstance
        : ''
    attachHost(room, socket, instance)
  } else {
    const phone = attachPhone(room, socket)
    if (phone) {
      socket.phone = phone
    }
  }
}

function handlePhoneFrame(socket, frame) {
  const room = socket.room
  if (!room || socket.role !== 'phone') return
  const data = frame.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  if (!room.host) {
    // Keep the phone link alive while the host reconnects. The phone's own
    // app-level ping is answered here; the relay only echoes liveness, never
    // business data.
    if (data.type === 'ping') {
      send(socket, { type: 'pong', t: Date.now() })
      return
    }
    if (
      (data.type === 'hello' || data.type === 'hello.proof' || data.type === 'pair.join') &&
      room.pending.length < MAX_PENDING_FRAMES
    ) {
      room.pending.push({ cid: socket.cid, data, at: Date.now() })
    }
    return
  }
  send(room.host, { type: 'relay.frame', cid: socket.cid, data })
}

function handleHostFrame(socket, frame) {
  const room = socket.room
  if (!room || socket.role !== 'host' || room.host !== socket) return
  const cid = frame.cid
  if (typeof cid !== 'string' || !ID_RE.test(cid)) return
  const phone = room.phones.get(cid)
  if (!phone) return
  if (frame.type === 'relay.send') {
    const data = frame.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    let text
    try {
      text = JSON.stringify(data)
    } catch {
      return
    }
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) return
    sendRaw(phone.socket, text)
    return
  }
  if (frame.type === 'relay.close') {
    const code = Number.isSafeInteger(frame.code) ? Math.min(4999, Math.max(1000, frame.code)) : 1000
    closeSocket(phone.socket, code, frame.reason || 'closed by host')
  }
}

function handleMessage(socket, raw) {
  if (socket.rateStart === undefined || Date.now() - socket.rateStart > 60_000) {
    socket.rateStart = Date.now()
    socket.rateCount = 0
  }
  socket.rateCount += 1
  if (socket.rateCount > MAX_MESSAGES_PER_MINUTE) {
    closeSocket(socket, 4008, 'rate limit')
    return
  }
  let frame
  try {
    frame = JSON.parse(raw.toString('utf8'))
  } catch {
    reject(socket, '消息格式不正确')
    return
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    reject(socket, '消息格式不正确')
    return
  }
  if (!socket.authed) {
    if (frame.type !== 'relay.hello') {
      reject(socket, '请先完成连接器握手')
      return
    }
    socket.helloAttempts = (socket.helloAttempts || 0) + 1
    if (socket.helloAttempts > 6) {
      reject(socket, '握手次数过多')
      return
    }
    handleHello(socket, frame)
    return
  }
  if (socket.role === 'phone') {
    if (frame.type === 'relay.frame') handlePhoneFrame(socket, frame)
    return
  }
  if (socket.role === 'host') {
    if (frame.type === 'relay.send' || frame.type === 'relay.close') {
      handleHostFrame(socket, frame)
    }
  }
}

function handleClose(socket) {
  socket.authed = false
  const room = socket.room
  if (!room) return
  if (socket.role === 'host') {
    if (room.host !== socket) return
    room.host = null
    if (room.phones.size === 0) {
      room.pending = []
      deleteRoomIfEmpty(room)
      return
    }
    clearHostGrace(room)
    room.hostGraceTimer = setTimeout(() => {
      room.hostGraceTimer = null
      if (room.host || rooms.get(room.id) !== room) return
      resetPhones(room, '电脑已离线，稍后会自动重连')
      deleteRoomIfEmpty(room)
    }, HOST_GRACE_MS)
    room.hostGraceTimer.unref?.()
  } else if (socket.role === 'phone') {
    const phone = socket.phone
    if (phone && room.phones.get(phone.cid) === phone) {
      clearTimeout(phone.pendingTimer)
      room.phones.delete(phone.cid)
      hostPeerClose(room, phone)
    }
  }
  deleteRoomIfEmpty(room)
}

const server = createServer((request, response) => {
  let pathname = '/'
  try {
    pathname = new URL(request.url || '/', 'http://pilot.local').pathname
  } catch {
    response.writeHead(400)
    response.end()
    return
  }
  if (request.method === 'GET' && pathname === '/healthz') {
    let hosts = 0
    let phones = 0
    for (const room of rooms.values()) {
      if (room.host) hosts += 1
      phones += room.phones.size
    }
    json(response, 200, {
      ok: true,
      app: 'pilot-connector',
      rooms: rooms.size,
      hosts,
      phones,
      sources: ipConnections.size,
      blockedSources: BLOCKED_IPS.size,
      access: {
        strict: ACCESS_STRICT,
        codes: ACCESS_KEYS.size,
        anonymous: accessStats.anonymous,
        rejected: accessStats.rejected,
      },
    })
    return
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('Not found')
})

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_FRAME_BYTES,
  perMessageDeflate: false,
  clientTracking: true,
})

server.on('upgrade', (request, socket, head) => {
  let pathname = ''
  try {
    pathname = new URL(request.url || '/', 'http://pilot.local').pathname
  } catch {
    socket.destroy()
    return
  }
  if (pathname !== WS_PATH) {
    socket.destroy()
    return
  }
  const ip = clientIp(request)
  if (BLOCKED_IPS.has(ip)) {
    socket.destroy()
    return
  }
  // handleUpgrade invokes its callback synchronously, so the slot checked here
  // is taken before the next upgrade event is processed.
  if (!takeIpSlot(ip)) {
    socket.destroy()
    return
  }
  // A handshake ws rejects (missing Sec-WebSocket-Key, wrong version, ...) is
  // aborted by destroying the raw socket, and no WebSocket is ever created, so
  // the 'close' handler below never runs. Without this the slot would leak on
  // every malformed upgrade and eventually lock the source out for good.
  let upgraded = false
  socket.once('close', () => {
    if (!upgraded) releaseIpSlot(ip)
  })
  wss.handleUpgrade(request, socket, head, (ws) => {
    upgraded = true
    ws.clientIp = ip
    wss.emit('connection', ws, request)
  })
})

wss.on('connection', (socket) => {
  socket.isAlive = true
  socket.missedHeartbeats = 0
  socket.authed = false
  socket.on('pong', () => {
    socket.isAlive = true
    socket.missedHeartbeats = 0
  })
  socket.on('message', (raw) => {
    socket.isAlive = true
    socket.missedHeartbeats = 0
    try {
      handleMessage(socket, raw)
    } catch {
      reject(socket, '连接器处理消息失败')
    }
  })
  socket.on('close', () => {
    releaseIpSlot(socket.clientIp)
    try {
      handleClose(socket)
    } catch {
      // never let cleanup take down the process
    }
  })
  socket.on('error', () => {
    // close follows
  })
})

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive) {
      socket.missedHeartbeats = 0
    } else {
      socket.missedHeartbeats = (socket.missedHeartbeats || 0) + 1
    }
    if (socket.missedHeartbeats >= HEARTBEAT_MISS_LIMIT) {
      socket.terminate()
      continue
    }
    socket.isAlive = false
    try {
      socket.ping()
    } catch {
      // ignore
    }
  }
}, HEARTBEAT_MS)
heartbeat.unref?.()

function shutdown(signal) {
  console.log(`pilot-connector shutting down (${signal})`)
  clearInterval(heartbeat)
  for (const socket of wss.clients) {
    try {
      socket.close(1001, 'server shutting down')
    } catch {
      // ignore
    }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(PORT, BIND, () => {
  console.log(`pilot-connector listening on ${BIND}:${PORT}${WS_PATH}`)
})
