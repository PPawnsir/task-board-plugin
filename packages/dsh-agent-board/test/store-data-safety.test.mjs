// dsh-agent-board — 看板数据安全 P0 根修测试（task-mv0bl9vg）
// 三件套：① 原子写盘（tmp+fsync+rename+unlink 兜底）② 腐坏隔离可见化（err hint + notify）
//         ③ 自动 salvage 截断抢救（JSON.parse 报错 position 截断法）。
// 全部跑在真实 index.mjs apply(mockCtx) 上；每个用例独立 mockCtx + 独立临时 HOME（HOME 是进程级，严禁并行）。
// 建卡后不推进虚拟时钟 → 不触发派发，无 worker spawn 噪声。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

function boardFile(env) { return path.join(env.home, '.dsh', 'tasks-' + env.sid + '.json') }

// 建卡封装：显式 description 避开空描述软提示
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '数据安全卡 ' + id, description: '看板数据安全根修测试' }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  return r.task
}

// ===== ① 原子写：源码断言 + 行为级（rename 瞬断后旧文件不被撕裂）=====
test('① 原子写（源码级）：store.mjs 写盘含 tmp+fsync+rename+unlink 兜底', () => {
  var sto = fs.readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  assert.match(sto, /async function writeTmpFsync/)        // fsync 专用写 tmp helper
  assert.match(sto, /fh\.sync\(\)/)                         // fsync 落盘（先于 rename）
  assert.match(sto, /fsNode\.promises\.rename\(tmp, p\)/)   // tmp → rename 覆盖目标
  assert.match(sto, /unlinkRetry\(p, 6\)/)                  // 直覆失败降级 unlink 兜底
  assert.match(sto, /降级 unlink\+rename/)                  // 降级记录（不静默）
})

test('① 原子写（行为级）：rename 瞬断（EBUSY 一次）→ 旧文件全程完整，退避重试后写回', async () => {
  var env = createMockCtx()
  plugin.apply(env.ctx)
  var origRename = fs.promises.rename
  try {
    await createTask(env, 'a1')
    var p = boardFile(env)
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).tasks.length, 1, '初始一张卡，文件是完整 JSON')
    // 注入一次瞬断：首次 rename 到主板路径时同步读盘取证 → 抛 EBUSY；之后恢复原样
    var injected = false
    var duringRename = null
    fs.promises.rename = async function (from, to) {
      if (!injected && String(to) === p) {
        injected = true
        duringRename = fs.readFileSync(p, 'utf8')           // 瞬断时刻主板文件内容取证
        var e = new Error('EBUSY injected'); e.code = 'EBUSY'; throw e
      }
      return origRename.call(fs.promises, from, to)
    }
    await createTask(env, 'a2')
    var after = JSON.parse(fs.readFileSync(p, 'utf8'))
    assert.equal(after.tasks.length, 2, '退避重试后写盘成功，最终内容完整（未撕裂）')
    assert.ok(injected, '瞬断确实被注入')
    assert.equal(JSON.parse(duringRename).tasks.length, 1, '瞬断时刻旧文件仍是完整旧 JSON（rename 原子，绝不半写）')
  } finally {
    fs.promises.rename = origRename
    await env.cleanup()
  }
})

// ===== ② 腐坏隔离：坏文件 → 隔离 .corrupt + err hint + notify（不再静默）=====
test('② 腐坏隔离：无法抢救的坏文件 → 隔离留档 + err hint + notify owner', async () => {
  var env = createMockCtx()
  plugin.apply(env.ctx)
  try {
    await createTask(env, 'b1')
    var p = boardFile(env)
    // 构造「无法抢救」的坏文件：单对象中部截断（无 position 可截 → salvage 失败 → 隔离）
    fs.writeFileSync(p, '{"ownerSession":"' + env.sid + '","tasks":[{"id":"x"}', 'utf8')
    var d = await env.rpc('get-tasks', { sessionId: env.sid })
    assert.ok(Array.isArray(d.tasks) && d.tasks.length === 0, '隔离后空板重启')
    var errHint = (d.healthHints || []).find(function (h) { return h && h.level === 'err' })
    assert.ok(errHint, '隔离产出 err 级 hint')
    assert.match(errHint.text, /腐坏已隔离/)
    assert.match(errHint.text, /\.corrupt-/)
    var corrupts = fs.readdirSync(path.join(env.home, '.dsh')).filter(function (f) { return f.indexOf('.corrupt-') >= 0 })
    assert.equal(corrupts.length, 1, '坏文件已改名 .corrupt-<ts> 留档')
    var msg = env.sent.find(function (m) { return m && m.content && /腐坏已隔离/.test(m.content[0].text) })
    assert.ok(msg, 'notify 通知 owner 会话（不再静默）')
  } finally { await env.cleanup() }
})

// ===== ③ 自动 salvage：完整 JSON + 撕裂残片 → 截断抢救出第一段完整板 =====
test('③ 自动 salvage：完整 JSON 尾部夹杂撕裂残片 → 截断抢救出第一段完整板并写回', async () => {
  var env = createMockCtx()
  plugin.apply(env.ctx)
  try {
    await createTask(env, 'c1')
    await createTask(env, 'c2')
    await createTask(env, 'c3')
    var p = boardFile(env)
    var good = fs.readFileSync(p, 'utf8')
    assert.equal(JSON.parse(good).tasks.length, 3, '前置：三张卡落盘')
    // 构造真实腐坏样本形态：完整 JSON 尾部夹杂「另一版本残片」（未闭合的第二个 JSON 值）
    var torn = good + '{"ownerSession":"' + env.sid + '","tasks":[{"id":"c4","title":"撕裂残片","status":"pend'
    fs.writeFileSync(p, torn, 'utf8')
    var d = await env.rpc('get-tasks', { sessionId: env.sid })
    assert.equal(d.tasks.length, 3, '抢救出完整第一段（3 张卡），丢弃撕裂残片')
    var after = JSON.parse(fs.readFileSync(p, 'utf8'))
    assert.equal(after.tasks.length, 3, '抢救结果已原子写回主板文件（不再反复 poison）')
    var errHint = (d.healthHints || []).find(function (h) { return h && h.level === 'err' })
    assert.ok(errHint, '抢救产出 err 级 hint')
    assert.match(errHint.text, /抢救保留 3 张卡/)
    var corrupts = fs.readdirSync(path.join(env.home, '.dsh')).filter(function (f) { return f.indexOf('.corrupt-') >= 0 })
    assert.equal(corrupts.length, 1, '原始撕裂文件已留档 .corrupt-<ts>')
    var msg = env.sent.find(function (m) { return m && m.content && /抢救/.test(m.content[0].text) })
    assert.ok(msg, 'notify 通知 owner（抢救型）')
  } finally { await env.cleanup() }
})
