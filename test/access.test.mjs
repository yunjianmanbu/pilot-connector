// L1 准入码：RELAY_ACCESS_KEYS / RELAY_ACCESS_STRICT 与随机路径。
// 跑法：cd pilot/pilot-connector && npm test
//
// 这组用例是「地址被贴到公开博客后陌生人直接能用」这条防线的回归：改
// server.mjs 的 authorize() 或 upgrade 里的路径判定时必须继续通过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')

const ROOM = 'roomForAdmissionTest01'
const ROOM_KEY = 'roomKeyForAdmissionTest0123'
const GOOD_KEY = 'home:0123456789abcdef0123456789abcdef'

/** 起一个中继，等到它打印 listening（或按预期退出）再返回 */
async function startRelay(env, expectExit = false) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, BIND: '127.0.0.1', WS_PATH: '/connector', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out += chunk
  })
  child.stderr.on('data', (chunk) => {
    out += chunk
  })
  if (expectExit) {
    const code = await Promise.race([
      once(child, 'exit').then(([value]) => value),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ])
    return { child, code, out: () => out }
  }
  const deadline = Date.now() + 8000
  while (!out.includes('listening on')) {
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`中继没起来：${out}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return { child, code: 0, out: () => out }
}

async function stopRelay(handle) {
  if (handle.child.exitCode === null) {
    handle.child.kill()
    await once(handle.child, 'exit')
  }
}

/**
 * 打开一条连接并发送 relay.hello，返回 { opened, type, message, code }。
 * opened=false 表示 upgrade 阶段就被销毁（随机路径不对时就是这样）。
 */
function hello(url, frame) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const result = { opened: false, type: '', message: '', code: 0 }
    const finish = () => {
      try {
        ws.terminate()
      } catch {
        // ignore
      }
      resolve(result)
    }
    ws.on('open', () => {
      result.opened = true
      ws.send(JSON.stringify(frame))
    })
    ws.on('message', (raw) => {
      let parsed
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        return
      }
      result.type = parsed.type
      result.message = parsed.message || ''
      // relay.error 后面紧跟一条 4009 close；等 close 事件再收尾，否则
      // 拿到的 code 会一直是 0。
      if (parsed.type === 'relay.ready') finish()
    })
    ws.on('close', (code) => {
      result.code = code
      finish()
    })
    ws.on('error', () => finish())
    setTimeout(finish, 4000).unref()
  })
}

const hostHello = (access) => ({
  type: 'relay.hello',
  role: 'host',
  room: ROOM,
  key: ROOM_KEY,
  protocol: 1,
  ...(access === undefined ? {} : { access }),
})

test('没配准入码时行为与 0.2.2 完全一致（自建者不配也不受影响）', async () => {
  const relay = await startRelay({ PORT: '19010' })
  try {
    const result = await hello('ws://127.0.0.1:19010/connector', hostHello())
    assert.equal(result.opened, true)
    assert.equal(result.type, 'relay.ready')
    const health = await (await fetch('http://127.0.0.1:19010/healthz')).json()
    assert.equal(health.access.codes, 0)
    assert.equal(health.access.strict, false)
  } finally {
    await stopRelay(relay)
  }
})

test('配了准入码但 STRICT=0：无票仍放行但计入 anonymous', async () => {
  const relay = await startRelay({ PORT: '19011', RELAY_ACCESS_KEYS: GOOD_KEY })
  try {
    const result = await hello('ws://127.0.0.1:19011/connector', hostHello())
    assert.equal(result.type, 'relay.ready', '灰度期不能把还没升级的设备挡在外面')
    const health = await (await fetch('http://127.0.0.1:19011/healthz')).json()
    assert.equal(health.access.anonymous, 1)
    assert.equal(health.access.rejected, 0)
    assert.match(relay.out(), /无准入码的连接/, '灰度期应在日志里留下可观察的一行')
  } finally {
    await stopRelay(relay)
  }
})

test('STRICT=1：无票握手被 4009 拒绝，正确准入码放行', async () => {
  const relay = await startRelay({
    PORT: '19012',
    RELAY_ACCESS_KEYS: GOOD_KEY,
    RELAY_ACCESS_STRICT: '1',
  })
  try {
    const anonymous = await hello('ws://127.0.0.1:19012/connector', hostHello())
    assert.equal(anonymous.opened, true, 'WebSocket 升级本身是成功的，拒绝发生在房间分配之前')
    assert.equal(anonymous.type, 'relay.error')
    assert.equal(anonymous.code, 4009)
    assert.equal(anonymous.message, '连接器要求准入码')

    const withKey = await hello('ws://127.0.0.1:19012/connector', hostHello(GOOD_KEY))
    assert.equal(withKey.type, 'relay.ready')

    const health = await (await fetch('http://127.0.0.1:19012/healthz')).json()
    assert.equal(health.access.strict, true)
    assert.equal(health.access.rejected, 1)
    assert.equal(health.rooms, 0, '连接全部断开后不应留下空房间')
  } finally {
    await stopRelay(relay)
  }
})

test('准入码错误、id 不存在、只有 secret 都会被拒', async () => {
  const relay = await startRelay({
    PORT: '19013',
    RELAY_ACCESS_KEYS: GOOD_KEY,
    RELAY_ACCESS_STRICT: '1',
  })
  try {
    for (const value of [
      'home:ffffffffffffffffffffffffffffffff',
      'other:0123456789abcdef0123456789abcdef',
      '0123456789abcdef0123456789abcdef',
    ]) {
      const result = await hello('ws://127.0.0.1:19013/connector', hostHello(value))
      assert.equal(result.type, 'relay.error', `应拒绝：${value}`)
      assert.equal(result.code, 4009)
    }
  } finally {
    await stopRelay(relay)
  }
})

test('多条准入码：删掉一条只让那台设备失效', async () => {
  const relay = await startRelay({
    PORT: '19014',
    RELAY_ACCESS_KEYS: `${GOOD_KEY},desk:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    RELAY_ACCESS_STRICT: '1',
  })
  try {
    const home = await hello('ws://127.0.0.1:19014/connector', hostHello(GOOD_KEY))
    assert.equal(home.type, 'relay.ready')
    const desk = await hello(
      'ws://127.0.0.1:19014/connector',
      hostHello('desk:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    )
    assert.equal(desk.type, 'relay.ready')
  } finally {
    await stopRelay(relay)
  }
})

test('随机路径：旧默认 /connector 直接连不上', async () => {
  const relay = await startRelay({ PORT: '19015', WS_PATH: '/c/9f3a2c7e18b46d05af3c72e95d1406b8' })
  try {
    const wrong = await hello('ws://127.0.0.1:19015/connector', hostHello())
    assert.equal(wrong.opened, false, '不是 WS_PATH 的路径应在 upgrade 阶段被销毁')
    const right = await hello(
      'ws://127.0.0.1:19015/c/9f3a2c7e18b46d05af3c72e95d1406b8',
      hostHello(),
    )
    assert.equal(right.type, 'relay.ready')
  } finally {
    await stopRelay(relay)
  }
})

test('准入码条目格式不对或 STRICT=1 却没配码时直接拒绝启动', async () => {
  const bad = await startRelay({ PORT: '19016', RELAY_ACCESS_KEYS: 'no-separator' }, true)
  assert.notEqual(bad.code, 0)
  assert.match(bad.out(), /RELAY_ACCESS_KEYS/)

  const empty = await startRelay(
    { PORT: '19017', RELAY_ACCESS_STRICT: '1' },
    true,
  )
  assert.notEqual(empty.code, 0)
  assert.match(empty.out(), /RELAY_ACCESS_STRICT/)
})

test('id 重复会让部署脚本的轮换出错，启动时直接报错', async () => {
  const dup = await startRelay(
    {
      PORT: '19018',
      RELAY_ACCESS_KEYS: `${GOOD_KEY},home:ffffffffffffffffffffffffffffffff`,
    },
    true,
  )
  assert.notEqual(dup.code, 0)
  assert.match(dup.out(), /id 重复/)
})
