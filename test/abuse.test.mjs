// 中继的滥用止损开关：按来源 IP 的连接上限、IP 黑名单、/healthz 计数。
// 跑法：cd pilot/relay && npm test
// 这三个用例是 RESPONSIBLE_USE.md「技术护栏」表里运营方可操作的部分，改动 server.mjs
// 的 upgrade 处理时要让它们继续通过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')

/** 起一个中继，等到它打印 listening 再返回 */
async function startRelay(env) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, BIND: '127.0.0.1', WS_PATH: '/connector', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out += chunk
  })
  const deadline = Date.now() + 8000
  while (!out.includes('listening on')) {
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`中继没起来：${out}`)
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  return child
}

/** 依次尝试建连接，返回成功数；连接全部保留到断言之后由调用方关掉 */
function tryConnect(url, count) {
  const sockets = []
  return Promise.all(
    Array.from({ length: count }, () =>
      new Promise((resolve) => {
        const ws = new WebSocket(url)
        let settled = false
        const done = (ok) => {
          if (settled) return
          settled = true
          if (ok) sockets.push(ws)
          else ws.terminate()
          resolve(ok)
        }
        ws.on('open', () => done(true))
        ws.on('error', () => done(false))
        setTimeout(() => done(false), 3000).unref()
      })
    )
  ).then((results) => ({ opened: results.filter(Boolean).length, sockets }))
}

function closeAll(sockets) {
  for (const ws of sockets) {
    try {
      ws.terminate()
    } catch {
      // ignore
    }
  }
}

test('MAX_CONNECTIONS_PER_IP：超出来源上限的 upgrade 被直接拒绝', async () => {
  const child = await startRelay({ PORT: '18989', MAX_CONNECTIONS_PER_IP: '2' })
  try {
    const { opened, sockets } = await tryConnect('ws://127.0.0.1:18989/connector', 5)
    assert.equal(opened, 2, '只应放行 2 条，其余在 upgrade 阶段被拒')
    const health = await (await fetch('http://127.0.0.1:18989/healthz')).json()
    assert.equal(health.sources, 1, 'healthz 应报告 1 个来源地址')
    closeAll(sockets)
  } finally {
    child.kill()
    await once(child, 'exit')
  }
})

test('RELAY_BLOCK_IPS：名单内的来源一条都连不上，且 healthz 报告 blockedSources', async () => {
  const child = await startRelay({ PORT: '18990', RELAY_BLOCK_IPS: '127.0.0.1' })
  try {
    const { opened, sockets } = await tryConnect('ws://127.0.0.1:18990/connector', 3)
    assert.equal(opened, 0, '黑名单来源不应建立任何连接')
    closeAll(sockets)
    const health = await (await fetch('http://127.0.0.1:18990/healthz')).json()
    assert.equal(health.blockedSources, 1)
    assert.equal(health.sources, 0)
  } finally {
    child.kill()
    await once(child, 'exit')
  }
})

test('握手失败不占用来源配额', async () => {
  const child = await startRelay({ PORT: '18992', MAX_CONNECTIONS_PER_IP: '2' })
  try {
    // 路径合法但没有 Sec-WebSocket-Version 之类的头：ws 在 upgrade 阶段 abort，
    // 裸 socket 被销毁且不会产生 WebSocket 对象，配额必须原样退回。
    const malformed = (port) =>
      new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(
            'GET /connector HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
          )
        })
        socket.on('close', resolve)
        socket.on('error', resolve)
        socket.resume()
      })
    for (let i = 0; i < 4; i += 1) await malformed(18992)
    const health = await (await fetch('http://127.0.0.1:18992/healthz')).json()
    assert.equal(health.sources, 0, '非法握手被拒后不应留下来源计数')
    const { opened, sockets } = await tryConnect('ws://127.0.0.1:18992/connector', 2)
    assert.equal(opened, 2, '非法握手不应吃掉正常连接的配额')
    closeAll(sockets)
  } finally {
    child.kill()
    await once(child, 'exit')
  }
})

test('MAX_CONNECTIONS_PER_IP=0：关闭上限后不再计数', async () => {
  const child = await startRelay({ PORT: '18991', MAX_CONNECTIONS_PER_IP: '0' })
  try {
    const { opened, sockets } = await tryConnect('ws://127.0.0.1:18991/connector', 4)
    assert.equal(opened, 4, '上限关闭时应全部放行')
    closeAll(sockets)
  } finally {
    child.kill()
    await once(child, 'exit')
  }
})
