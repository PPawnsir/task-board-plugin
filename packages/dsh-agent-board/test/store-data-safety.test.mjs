// dsh-agent-board — 看板数据安全 P0 根修测试（task-mv0bl9vg）
// 三件套：① 原子写盘（tmp+fsync+rename+unlink 兜底）② 腐坏隔离可见化（err hint + notify）
//         ③ 自动 salvage 截断抢救（JSON.parse 报错 position 截断法）。
// 全部跑在真实 index.mjs apply(mockCtx) 上；每个用例独立 mockCtx + 独立临时 HOME（HOME 是进程级，严禁并行）。
// 建卡后不推进虚拟时钟 → 不触发派发，无 worker spawn 噪声。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'
import { createStore, shouldFsyncNow, FSYNC_THROTTLE_MS } from '../lib/store.mjs'
import { boardHome } from '../lib/core.mjs'

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

// ===== ④ P1 根修（task-mv1e17x9）：tmp 唯一名 + 四条锁外写路径归一（原子写时代撕裂根修）=====

// 直连 store 层的最小环境：只测 wt() 原子写 / tmp 残件清理，不拉起整个插件。
// 独立接管 process.env.HOME（与 createMockCtx 同款纪律：HOME 是进程级，用例串行 + finally 恢复）。
function makeRawStore() {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-board-wt-'))
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  var prevHome = process.env.HOME
  var hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME')
  process.env.HOME = home
  var state = { fileLocks: {}, cyclePending: {}, poolHealth: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {} }
  var store = createStore({}, state, { sessionCwd: function () { return home } })
  return {
    store: store, home: home,
    cleanup: function () {
      if (hadHome) process.env.HOME = prevHome
      else delete process.env.HOME
      try { fs.rmSync(home, { recursive: true, force: true }) } catch (_) {}
    },
  }
}

test('④ tmp 唯一名（源码级）：wt() 的 tmp 名 = pid + 时间戳 + 进程内自增序号', () => {
  var sto = fs.readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  assert.match(sto, /process\.pid/)          // tmp 名含 pid（跨进程也唯一）
  assert.match(sto, /Date\.now\(\)/)          // 含时间戳
  assert.match(sto, /\+\+tmpSeq/)             // 含进程内自增序号（同 ms 并发也唯一）
  assert.match(sto, /\+ '\.tmp'/)             // 仍是 .tmp 后缀
  assert.match(sto, /var tmpSeq = 0/)         // 序号计数器声明（模块级，跨 store 实例共享）
})

test('④ tmp 唯一名（行为级）：两个并发 3MB 写后文件必是其中一份完整 JSON，且无 .tmp 残件', async () => {
  var env = makeRawStore()
  var sid = 'session-wt-' + Date.now().toString(36)
  try {
    var fillerA = 'A'.repeat(3 * 1024 * 1024)
    var fillerB = 'B'.repeat(3 * 1024 * 1024)
    var dA = { ownerSession: sid, tasks: [], marker: 'A', filler: fillerA }
    var dB = { ownerSession: sid, tasks: [], marker: 'B', filler: fillerB }
    var a = JSON.stringify(dA), b = JSON.stringify(dB)
    await Promise.all([env.store.wt(sid, dA), env.store.wt(sid, dB)])
    var p = path.join(env.home, '.dsh', 'tasks-' + sid + '.json')
    var final = fs.readFileSync(p, 'utf8')
    assert.ok(final === a || final === b, '最终文件必是其中一份完整 JSON（不是拼接怪）')
    var leftovers = fs.readdirSync(path.join(env.home, '.dsh')).filter(function (f) { return /\.tmp$/.test(f) })
    assert.equal(leftovers.length, 0, '成功写盘后无 .tmp 残件')
  } finally { env.cleanup() }
})

test('④ 无 .tmp 残件（行为级）：rename 非瞬时失败后清理自己的 tmp', async () => {
  var env = makeRawStore()
  var sid = 'session-wt-fail-' + Date.now().toString(36)
  var origRename = fs.promises.rename
  try {
    var p = path.join(env.home, '.dsh', 'tasks-' + sid + '.json')
    await env.store.wt(sid, { ownerSession: sid, tasks: [] })           // 先正常写一次
    assert.ok(fs.existsSync(p), '前置：主板已落盘')
    fs.promises.rename = async function () { var e = new Error('EIO injected'); e.code = 'EIO'; throw e }
    try { await env.store.wt(sid, { ownerSession: sid, tasks: [] }) } catch (_) {}
    var leftovers = fs.readdirSync(path.join(env.home, '.dsh')).filter(function (f) { return /\.tmp$/.test(f) })
    assert.equal(leftovers.length, 0, 'rename 失败后无 .tmp 残件（残件已被清理）')
  } finally {
    fs.promises.rename = origRename
    env.cleanup()
  }
})

test('④ 锁归一（源码级）：四条锁外写路径全部归一进 withLock，dispatch 不再直写 wt', () => {
  var sto = fs.readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  var disp = fs.readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  // 锁感知写回 + 不可重入死锁说明必须显式存在
  assert.match(sto, /function lockAware\(sid, locked, fn\)/)
  assert.match(sto, /withLock 是简单 promise 链，不可重入/)
  assert.match(sto, /async function adoptBoard\(sid, cand, cwd, locked\)/)
  assert.match(sto, /async function recoverCorrupt\(sid, raw, locked\)/)
  assert.match(sto, /return lockAware\(sid, locked, async function \(\)/)
  assert.match(sto, /await rt\(sid, true\)/)                          // mutateLocked 锁内调用 rt 传 true
  // poolCycle 空闲快进清理：不再直写 wt，改走 mutateLocked（锁内重读重判）
  assert.doesNotMatch(disp, /await wt\(/)
  assert.doesNotMatch(disp, /deps\.wt/)
  assert.match(disp, /mutateLocked\(sid, function \(d\) \{/)
})

test('④ poolCycle 空闲清理（行为级）：残留忙碌 poolStatus 经锁被清空', async () => {
  var env = createMockCtx()
  plugin.apply(env.ctx)
  try {
    await createTask(env, 'idle1')                                      // 建卡 + touchSession 入 knownSessions
    // 模拟 DSH 重启：内存 runs 已空、文件里残留重启前的忙碌快照 + 无活跃任务 → 走空闲快进清理
    env.patchBoard(function (d) {
      d.tasks = []
      d.poolStatus = { workers: [{ id: 'ghost-w', taskId: 'x', role: 'worker' }], verifiers: [{ id: 'ghost-v', taskId: 'y', role: 'verifier' }] }
    })
    await env.clock.tick()                                              // 触发 15s 心跳 → poolCycle → 空闲清理
    await env.waitFor(function () {
      var b = env.board()
      return b && b.poolStatus.workers.length === 0 && b.poolStatus.verifiers.length === 0
    })
    var b = env.board()
    assert.equal(b.poolStatus.workers.length + b.poolStatus.verifiers.length, 0, '残留忙碌 poolStatus 已被清空')
  } finally { await env.cleanup() }
})

// ===== ⑤ mock 板泄漏拒写闸（task-mvo9ca58，巡检 n-mvo4y8ojzr3y）=====
// 场景：teardown（disposers 跑过、HOME 复原）后，迟到的真实 setTimeout 去抖/退避链尾才触发写盘，
// boardDirName() 按已复原 HOME 现算 → mock 板落真根（实证 91 个 tasks-session-mock-*.json 污染真 ~/.dsh）。
// 修法：state.deactivated 停用闸——createStore 自注册 ctx.effect disposer 落闸，落闸后 wt() 拒写
// **新板文件**（已有板 salvage/继承写回不受限）。原子写主链不动。

test('⑤ 泄漏闸（单元级）：deactivated 后拒写新板文件，已有板 salvage 写不受限', async () => {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-board-gate-'))
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  var prevHome = process.env.HOME
  var hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME')
  process.env.HOME = home
  var state = { fileLocks: {}, cyclePending: {}, poolHealth: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {} }
  var store = createStore({}, state, { sessionCwd: function () { return home } })
  try {
    var sid = 'session-wt-gate-' + Date.now().toString(36)
    var p = path.join(home, '.dsh', 'tasks-' + sid + '.json')
    await store.wt(sid, { ownerSession: sid, tasks: [] })
    assert.ok(fs.existsSync(p), '未停用：新板正常落盘（闸不误伤正常路径）')
    state.deactivated = true // 模拟插件 disposers 已跑（teardown）
    // 已有板写回（salvage/继承路径同属此类）不受限——救命写不拦
    await store.wt(sid, { ownerSession: sid, tasks: [{ id: 'salv1' }] })
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).tasks.length, 1, '已停用：已有板 salvage 写回不受限')
    // 新板文件拒写
    var sid2 = sid + '-late'
    var p2 = path.join(home, '.dsh', 'tasks-' + sid2 + '.json')
    await assert.rejects(store.wt(sid2, { ownerSession: sid2, tasks: [] }), /deactivated/, '已停用：新板文件拒写')
    assert.ok(!fs.existsSync(p2), '拒写后磁盘无新板文件')
  } finally {
    if (hadHome) process.env.HOME = prevHome
    else delete process.env.HOME
    try { fs.rmSync(home, { recursive: true, force: true }) } catch (_) {}
  }
})

test('⑤ 泄漏闸（集成级）：cleanup 后立即迟到写——停用闸拒写，真根不出现新 mock 板文件', async () => {
  var env = createMockCtx()
  plugin.apply(env.ctx)
  var realTarget = null
  var cleaned = false
  try {
    await createTask(env, 'g1')
    assert.ok(fs.existsSync(boardFile(env)), '前置：临时 HOME 里本板已落盘')
    await env.cleanup() // disposers 跑 → 停用闸落（接线实证点）；100ms 静默窗；HOME 复原；删临时目录
    cleaned = true
    // cleanup 后 boardHome() 即真根（HOME 已复原）；env.sid 是唯一 mock id，真根必无此文件
    realTarget = path.join(boardHome(), 'tasks-' + env.sid + '.json')
    assert.ok(!fs.existsSync(realTarget), '前置：真根本无此 mock 板文件')
    // 模拟「cleanup 后立即 kickCycle」式迟到触发：mock 宿主 cleanup 不摘工具表，task_create 仍可达，
    // 其 mutateLocked → wt 写盘路径按已复原 HOME 现算——正是泄漏根因路径
    var tool = env.tools.get('task_create')
    assert.ok(tool && typeof tool.execute === 'function', '前置：task_create 工具已注册')
    var errText = ''
    try {
      var r = await tool.execute({ sessionId: env.sid, id: 'late1', title: '迟到写探针', description: 'teardown 后迟到写' })
      errText = r && r.ok !== true && r.error ? String(r.error) : ''
    } catch (e) { errText = String(e) }
    assert.match(errText, /deactivated|已停用/, '迟到写被停用闸拒写（错误可见、不静默）')
    assert.ok(!fs.existsSync(realTarget), '真根未出现新 mock 板文件（泄漏根治）')
  } finally {
    // 回归兜底：闸若失效把板写进了真根，这里清污——测试失败不该变成真根残留
    try { if (realTarget && fs.existsSync(realTarget)) fs.unlinkSync(realTarget) } catch (_) {}
    if (!cleaned) await env.cleanup()
  }
})

// ===== ⑥ .tmp 原子写孤儿清扫（task-mvo9ca58，巡检 n-mvo4y8iyv3r0）=====
// wt() 崩溃窗口（强杀发生在 rename 前）留 tasks-*.json.<pid>.<ts>-<seq>.tmp 残件无人清（实证 336KB
// 残件滞留 4 天）。修法：读盘列举 tasks-* 时（findAdoptableBoardFile 的 readdirSync）顺手 unlink
// mtime 早于 now-1h 的 tasks-*.tmp——1h 视界远长于存活写的 tmp 生命周期（崩溃安全），只扫本目录。

test('⑥ .tmp 孤儿清扫（行为级）：超 1h 残件读盘后消失，新 tmp 与非同族文件不动', async () => {
  var env = makeRawStore()
  try {
    var dsh = path.join(env.home, '.dsh')
    var oldTmp = path.join(dsh, 'tasks-session-dead.json.43320.1761000000000-1.tmp')
    var newTmp = path.join(dsh, 'tasks-session-live.json.43320.1761000000001-2.tmp')
    var alienTmp = path.join(dsh, 'notes-index.json.9999.1761000000002-1.tmp') // 非 tasks- 前缀
    fs.writeFileSync(oldTmp, '{"tasks":[{"id":"x"', 'utf8') // 崩溃残件（截断的半片 JSON）
    fs.writeFileSync(newTmp, '{"tasks":[{"id":"y"', 'utf8')
    fs.writeFileSync(alienTmp, '1', 'utf8')
    var twoHoursAgo = new Date(Date.now() - 2 * 3600000)
    fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo) // mtime 拉到 2h 前（>1h 视界）
    fs.utimesSync(alienTmp, twoHoursAgo, twoHoursAgo)
    // 触发读盘列举：rt 一个无板 sid → ENOENT → findAdoptableBoardFile → readdirSync + 顺手清扫
    await env.store.rt('session-wt-sweep-' + Date.now().toString(36))
    assert.ok(!fs.existsSync(oldTmp), '超 1h 的 tasks-*.tmp 孤儿已被清扫')
    assert.ok(fs.existsSync(newTmp), '新 tmp 不动（存活写的 tmp 生命周期远短于 1h，但宁可不碰）')
    assert.ok(fs.existsSync(alienTmp), '非 tasks- 前缀文件不动（边界：只扫看板同族残件）')
  } finally { env.cleanup() }
})

test('⑥ .tmp 孤儿清扫（源码级）：清扫挂在读盘列举点 + 1h 视界 + 只认 tasks-*.tmp 同族', () => {
  var sto = fs.readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  assert.match(sto, /function sweepTmpOrphans\(home, files\)/)   // 清扫 helper 存在
  assert.match(sto, /TMP_ORPHAN_MS = 3600000/)                   // 1 小时视界（崩溃安全）
  assert.match(sto, /f\.indexOf\('tasks-'\) !== 0 \|\| f\.slice\(-4\) !== '\.tmp'/) // 只认 tasks-*.tmp 同族
  assert.match(sto, /sweepTmpOrphans\(home, files\)/)            // 挂在读盘列举点
  assert.match(sto, /state\.deactivated && !fsNode\.existsSync\(p\)/) // 停用闸落点（新板才拒，已有板放行）
})

// ===== ⑦ fsync 节流：800ms 窗口合并冲刷 + 尾随补刷（task-mw0f2zh4）=====
// 微基准实测单次写 ~262ms 中 fsync 占 ~223ms（85%，NTFS 大文件冲刷固有代价）且 wt 锁内串行排队放大。
// 修法：窗口（800ms）内多次写只在窗口首写全量冲刷，窗内写跳过 tmp fsync（rename 原子性逐字不动），
// 尾随定时器 800ms 后对**当前**板文件补一次 fsync；ctx.timer 缺席（老宿主/测试桩）逐字回退每写全量。
// 掉电数据窗口 0 → ≤800ms（用户拍板；进程崩溃不受影响：页缓存属于 OS，rename 原子性 + salvage 兜底仍在）。

test('⑦ 节流决策纯函数：shouldFsyncNow 首写=true / 窗内=false / 窗外=true / 窗边=恰好算窗外', () => {
  assert.equal(FSYNC_THROTTLE_MS, 800, '窗口常量 = 800ms（模块级，不做配置面）')
  assert.equal(shouldFsyncNow(0, 1000, FSYNC_THROTTLE_MS), true, '无记录（首写）→ 全量冲')
  assert.equal(shouldFsyncNow(undefined, 1000, FSYNC_THROTTLE_MS), true, 'undefined（首写）→ 全量冲')
  assert.equal(shouldFsyncNow(1000, 1000 + FSYNC_THROTTLE_MS - 1, FSYNC_THROTTLE_MS), false, '窗内（差 1ms）→ 跳过本次 fsync')
  assert.equal(shouldFsyncNow(1000, 1000 + FSYNC_THROTTLE_MS, FSYNC_THROTTLE_MS), true, '窗边（差值恰好=窗口）→ 全量冲（保守偏向落盘）')
  assert.equal(shouldFsyncNow(1000, 1000 + FSYNC_THROTTLE_MS + 5000, FSYNC_THROTTLE_MS), true, '窗外 → 全量冲')
})

test('⑦ 节流（源码级）：常量+wt 节流分支+尾随补刷接线+timer 缺席回退全量', () => {
  var sto = fs.readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  assert.match(sto, /var FSYNC_THROTTLE_MS = 800/)                              // 模块级窗口常量
  assert.match(sto, /export function shouldFsyncNow\(lastMs, nowMs, intervalMs\)/)  // 节流判据纯函数（可单测）
  assert.match(sto, /shouldFsyncNow\(lastFsyncMs\[sid\], nowMs, FSYNC_THROTTLE_MS\)/)  // wt 内节流决策
  assert.match(sto, /async function writeTmpPlain/)                              // 跳过 fsync 的 tmp 写（writeTmpFsync 原样保留）
  assert.match(sto, /if \(fsyncNow\) await writeTmpFsync\(tmp, c\)/)            // 全量路径：fsync 仍在 rename 前
  assert.match(sto, /else await writeTmpPlain\(tmp, c\)/)                       // 节流路径：跳过 fsync
  assert.match(sto, /armTrailingFsync\(sid, tm\)/)                               // 节流写挂尾随补刷臂
  assert.match(sto, /clearTrailingFsync\(sid\)/)                                 // 全量冲刷作废挂起臂
  assert.match(sto, /tm\.timeout\(FSYNC_THROTTLE_MS\)/)                         // 尾随定时器接线（promise 形态=kickCycle 同款）
  assert.match(sto, /\.then\(go, go\)/)                                         // 双臂兜底：reject 也补刷（kickCycle 教训同源）
  assert.match(sto, /fsNode\.openSync\(p, 'r\+'\)/)                             // 尾随打开当前板文件
  assert.match(sto, /fsNode\.fsyncSync\(fh\)/)                                 // 尾随对当前文件补 fsync
  assert.match(sto, /console\.error\('\[task-board\] 尾随 fsync 补刷失败/)     // 失败只记录不抛（OS writeback 兜底）
  // 回退：ctx.timer 缺席（老宿主/测试桩）→ throttle 恒 false → fsyncNow 恒 true = 每写全量 fsync 老行为
  assert.match(sto, /var throttle = !!\(tm && typeof tm\.timeout === 'function'\)/)
  // 原子性红线逐字不动：rename 原子链 + EPERM/EBUSY 退避 + unlink 降级
  assert.match(sto, /fsNode\.promises\.rename\(tmp, p\)/)
  assert.match(sto, /code === 'EPERM' \|\| code === 'EBUSY'/)
  assert.match(sto, /降级 unlink\+rename/)
})

// 直连 store 的节流测试环境：假 timer（promise 形态——测试手动驱动落定）+ 独立临时 HOME（同 makeRawStore 纪律）。
// Date.now 由各用例自行劫持（store 的节流判据/尾随臂时刻全走墙钟——虚拟化后窗口推进免真实 sleep）。
function makeThrottleEnv() {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-board-fsync-'))
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  var prevHome = process.env.HOME
  var hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME')
  process.env.HOME = home
  var timers = [] // 已挂尾随臂：{ ms, resolve, }——resolve 由用例手动驱动（模拟 800ms 到期）
  var fakeTimer = {
    timeout: function (ms) { return new Promise(function (resolve) { timers.push({ ms: ms, resolve: resolve }) }) },
  }
  var state = { fileLocks: {}, cyclePending: {}, poolHealth: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {} }
  var store = createStore({ timer: fakeTimer }, state, { sessionCwd: function () { return home } })
  return {
    store: store, home: home, timers: timers,
    cleanup: function () {
      if (hadHome) process.env.HOME = prevHome
      else delete process.env.HOME
      try { fs.rmSync(home, { recursive: true, force: true }) } catch (_) {}
    },
  }
}

// 观测探针：包 fs.promises.open 记 tmp 写的 FileHandle.sync 次数（全量冲刷路径），返回计数器对象；
// 用毕 finally 必须还原 fs.promises.open（node:test 同文件内用例串行，无并行互踩）。
function wrapFsyncSync() {
  var r = { syncCalls: 0 }
  var origOpen = fs.promises.open
  fs.promises.open = async function (tp, mode) {
    var fh = await origOpen.call(fs.promises, tp, mode)
    var origSync = fh.sync.bind(fh)
    fh.sync = async function () { r.syncCalls++; return origSync() }
    return fh
  }
  r.restore = function () { fs.promises.open = origOpen }
  return r
}

test('⑦ 节流（行为级）：首写全量、窗内写跳 fsync 只挂一个尾随臂、臂到期补 fsync 当前文件、窗外全量作废挂起臂', async () => {
  var env = makeThrottleEnv()
  var realNow = Date.now
  var fakeNow = 1700000000000
  Date.now = function () { return fakeNow }
  var probe = wrapFsyncSync()
  var fsyncCalls = 0 // 尾随补刷次数（fsyncSync）；全量冲刷走 FileHandle.sync（probe.syncCalls）
  var origFsyncSync = fs.fsyncSync
  fs.fsyncSync = function (fd) { fsyncCalls++; return origFsyncSync.call(fs, fd) }
  try {
    var sid = 'session-fsync-' + Date.now().toString(36)
    var p = path.join(env.home, '.dsh', 'tasks-' + sid + '.json')
    var read = function () { return JSON.parse(fs.readFileSync(p, 'utf8')).tasks.length }
    // 首写（T0）：全量冲刷，不挂尾随臂
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'f1' }] })
    assert.equal(probe.syncCalls, 1, '首写全量 fsync（writeTmpFsync 的 fh.sync）')
    assert.equal(env.timers.length, 0, '首写全量冲刷，不挂尾随臂')
    assert.equal(read(), 1, '首写落盘内容完整')
    // 窗内二写（T100）：跳过 fsync + 挂一个 800ms 尾随臂
    fakeNow += 100
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'f1' }, { id: 'f2' }] })
    assert.equal(probe.syncCalls, 1, '窗内写跳过 fsync（无新增 fh.sync）')
    assert.equal(env.timers.length, 1, '窗内节流写挂一个尾随臂')
    assert.equal(env.timers[0].ms, 800, '尾随臂延迟 = FSYNC_THROTTLE_MS')
    assert.equal(read(), 2, '节流写 rename 照常——内容即时可见（只是没冲盘）')
    // 窗内三写（T200）：复用挂起臂，不叠加
    fakeNow += 100
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] })
    assert.equal(env.timers.length, 1, '窗内再写不叠加尾随臂（窗口尾统一补一次）')
    assert.equal(read(), 3, '节流写内容即时可见')
    // 尾随臂到期：对当前板文件补一次 fsync（此刻正位上就是最新内容）
    env.timers[0].resolve()
    await new Promise(function (r) { setImmediate(r) }) // 微任务链跑完 go
    assert.equal(fsyncCalls, 1, '尾随臂到期对当前板文件 fsync 一次（fsyncSync）')
    assert.equal(read(), 3, '补刷不改内容（fsync 无数据改动）')
    // 尾随臂触发后的窗内新写（T300）：重新挂臂
    fakeNow += 100
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'f4' }] })
    assert.equal(env.timers.length, 2, '臂触发后窗内新写重新挂臂')
    // 窗外写（T1101，距上次全量冲刷记录 T200 已 901ms）：全量冲刷 + 作废挂起臂
    fakeNow += FSYNC_THROTTLE_MS + 1
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'f5' }] })
    assert.equal(probe.syncCalls, 2, '窗外写回归全量 fsync')
    assert.equal(env.timers.length, 2, '全量冲刷写不挂新臂')
    assert.equal(read(), 1, '窗外写内容正确')
    env.timers[1].resolve() // 被作废的臂落定 → 空转
    await new Promise(function (r) { setImmediate(r) })
    assert.equal(fsyncCalls, 1, '已作废的尾随臂落定空转（不再补 fsync）')
  } finally {
    Date.now = realNow
    fs.fsyncSync = origFsyncSync
    probe.restore()
    env.cleanup()
  }
})

test('⑦ 尾随补刷失败不抛（行为级）：板文件缺席时 fire 只记录不炸，链路无恙', async () => {
  var env = makeThrottleEnv()
  var realNow = Date.now
  var fakeNow = 1700000000000
  Date.now = function () { return fakeNow }
  try {
    var sid = 'session-fsync-err-' + Date.now().toString(36)
    var p = path.join(env.home, '.dsh', 'tasks-' + sid + '.json')
    await env.store.wt(sid, { ownerSession: sid, tasks: [] })                    // 首写全量
    fakeNow += 100
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'x' }] })       // 窗内节流写挂臂
    fs.unlinkSync(p)                                                           // 构造 fire 时文件缺席（ENOENT）
    env.timers[0].resolve()
    await new Promise(function (r) { setImmediate(r) })
    // 走到这里 = fire 未抛（失败只 console.error：数据仍在页缓存/该文件已不存在，OS writeback 兜底）
    assert.ok(!fs.existsSync(p), 'fire 失败确实发生在文件缺席时')
    // 链路无恙：后续写照常（文件重建，内容正确）
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'y' }] })
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).tasks.length, 1, 'fire 失败后链路无恙，后续写正常')
  } finally {
    Date.now = realNow
    env.cleanup()
  }
})

test('⑦ ctx.timer 缺席回退（行为级）：无 timer 测试桩逐字回退每写全量 fsync', async () => {
  var env = makeRawStore() // 既有直连环境：ctx={}（无 ctx.timer）——老宿主/测试桩同款
  var probe = wrapFsyncSync()
  try {
    var sid = 'session-wt-legacy-' + Date.now().toString(36)
    var p = path.join(env.home, '.dsh', 'tasks-' + sid + '.json')
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'l1' }] })
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'l1' }, { id: 'l2' }] })
    await env.store.wt(sid, { ownerSession: sid, tasks: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }] })
    assert.equal(probe.syncCalls, 3, '无 timer 桩：每写都全量 fsync（老行为逐字回退，不因节流抖动）')
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).tasks.length, 3, '连续写全部正常落盘')
  } finally {
    probe.restore()
    env.cleanup()
  }
})
