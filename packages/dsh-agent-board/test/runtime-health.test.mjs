// dsh-agent-board — 运行时健康自检单测（test/runtime-health.test.mjs，task-muxhrkbg）
// 覆盖任务书六断言：①冻结场景 hint 出现（mock 时间戳过期）②正常场景不亮 ③无卡可派（全被锁/依赖/frozen 等）不误报
//   ④settle 静默 hint 黄级 ⑤幽灵回收 hint 一次性 ⑥host 挂点源码断言。
// 被测对象 = health.computeRuntimeHealthHints（纯函数：board + 心跳记录 rt + {capW, now, alive} → {hints, consumeReapNote}）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computeRuntimeHealthHints } from '../lib/health.mjs'

var MIN = 60000

// 造卡：默认是「无任何阻塞原因可派发」的 pending 卡
// （无 claimedBy/frozen/assignMode=manual/pipeline=direct/dependsOn/escalation/parentId——pickDispatch 全闸门放行）
function mkPending(extra) {
  return Object.assign({ id: 't-pending', title: '待派发', status: 'pending', priority: 'medium', touches: [], createdAt: '2026-01-01T00:00:00.000Z' }, extra || {})
}

// ===== ① 派发循环心跳：冻结场景 =====
test('① 冻结场景：有可派卡 + 有空位 + 上次成功轮 >5min → 亮条（warn 级 + 🔴 前缀）', function () {
  var now = Date.now()
  var board = { tasks: [mkPending()] }
  var rt = { bornAt: now - 30 * MIN, poolLastOkAt: now - 12 * MIN }
  var r = computeRuntimeHealthHints(board, rt, { capW: 2, now: now })
  assert.equal(r.hints.length, 1)
  assert.equal(r.hints[0].level, 'warn')
  assert.ok(r.hints[0].text.indexOf('派发循环疑似冻结') >= 0)
  assert.ok(r.hints[0].text.indexOf('已 12 分钟无派发') >= 0)
  assert.ok(r.hints[0].text.indexOf('🔴') >= 0) // client 零改动约束下「红条」由文案前缀表达
  assert.equal(r.consumeReapNote, false)
})

test('① poolLastOkAt 缺失时退 bornAt：host 重启后心跳全断，5min 宽限后照样亮条', function () {
  var now = Date.now()
  var board = { tasks: [mkPending()] }
  var r = computeRuntimeHealthHints(board, { bornAt: now - 8 * MIN }, { capW: 1, now: now })
  assert.equal(r.hints.length, 1)
  assert.ok(r.hints[0].text.indexOf('派发循环疑似冻结') >= 0)
  // bornAt 新鲜（刚见到本板，首轮 cycle 还没来得及跑完）→ 不误报
  assert.deepEqual(computeRuntimeHealthHints(board, { bornAt: now - 10 * 1000 }, { capW: 1, now: now }).hints, [])
})

// ===== ② 正常场景不亮 =====
test('② 正常场景不亮：心跳新鲜 / 无空位 / 死会话 / rt 缺失 / 空板', function () {
  var now = Date.now()
  var board = { tasks: [mkPending()] }
  // 心跳新鲜（30s 前成功跑过一轮）
  assert.deepEqual(computeRuntimeHealthHints(board, { bornAt: now - 60 * MIN, poolLastOkAt: now - 30 * 1000 }, { capW: 2, now: now }), { hints: [], consumeReapNote: false })
  // 无空位（capW=0：manual 模式或池满）——心跳再旧也不是冻结
  assert.deepEqual(computeRuntimeHealthHints(board, { bornAt: now - 60 * MIN, poolLastOkAt: now - 60 * MIN }, { capW: 0, now: now }).hints, [])
  // root 不存活（alive:false）：死会话本就不该派发，不是冻结
  assert.deepEqual(computeRuntimeHealthHints(board, { bornAt: now - 60 * MIN, poolLastOkAt: now - 60 * MIN }, { capW: 2, now: now, alive: false }).hints, [])
  // rt 缺失 → 无法判定，全不亮
  assert.deepEqual(computeRuntimeHealthHints(board, undefined, { capW: 2, now: now }), { hints: [], consumeReapNote: false })
  // 空板（无任何卡）
  assert.deepEqual(computeRuntimeHealthHints({ tasks: [] }, { bornAt: now - 60 * MIN, poolLastOkAt: now - 60 * MIN }, { capW: 2, now: now }).hints, [])
})

// ===== ③ 无卡可派（全被挡住）不误报 =====
test('③ 无卡可派不误报：touches 锁全挡 / 依赖未满足 / frozen·歧义·manual·direct', function () {
  var now = Date.now()
  // 心跳过期 + 有空位，但所有 pending 卡都有阻塞原因 → 不该亮「冻结」
  var staleRt = { bornAt: now - 30 * MIN, poolLastOkAt: now - 30 * MIN, settleLastOkAt: now }
  // touches 冲突：持有者 in-progress+claimedBy 持锁，候选同路径被挡进 blockedTouches（不算「可派发」）
  var locked = { tasks: [
    mkPending({ id: 'holder', status: 'in-progress', claimedBy: 'w1', touches: ['src/a.js'] }),
    mkPending({ id: 'cand', touches: ['src/a.js'] }),
  ] }
  assert.deepEqual(computeRuntimeHealthHints(locked, staleRt, { capW: 2, now: now }).hints, [])
  // 依赖未满足（depsSatisfied 挡住）
  var depBlocked = { tasks: [
    mkPending({ id: 'dep', status: 'in-progress', claimedBy: 'w2' }),
    mkPending({ id: 'cand', dependsOn: ['dep'] }),
  ] }
  assert.deepEqual(computeRuntimeHealthHints(depBlocked, staleRt, { capW: 2, now: now }).hints, [])
  // frozen / escalation / manual / direct 全部不属于自动派发范围
  var misc = { tasks: [
    mkPending({ id: 'f', frozen: true }),
    mkPending({ id: 'e', escalation: { reason: 'x' } }),
    mkPending({ id: 'm', assignMode: 'manual' }),
    mkPending({ id: 'd', pipeline: 'direct' }),
  ] }
  assert.deepEqual(computeRuntimeHealthHints(misc, staleRt, { capW: 2, now: now }).hints, [])
  // 反证：同一心跳下只要混进一张真正可派的卡就立即亮条（锁/依赖挡的是别的卡不影响它）
  var mixed = { tasks: locked.tasks.concat([mkPending({ id: 'free' })]) }
  var r = computeRuntimeHealthHints(mixed, staleRt, { capW: 2, now: now })
  assert.equal(r.hints.length, 1)
  assert.ok(r.hints[0].text.indexOf('派发循环疑似冻结') >= 0)
})

// ===== ④ settle 通道存活监护（黄级）=====
test('④ settle 静默 >30min + 有在跑卡 → 黄级 warn；新鲜 / 无在跑卡 / 死会话不亮', function () {
  var now = Date.now()
  var board = { tasks: [mkPending({ id: 'run1', status: 'in-progress', claimedBy: 'w1' })] }
  var r = computeRuntimeHealthHints(board, { bornAt: now - 90 * MIN, poolLastOkAt: now, settleLastOkAt: now - 41 * MIN }, { capW: 1, now: now })
  assert.equal(r.hints.length, 1)
  assert.equal(r.hints[0].level, 'warn') // 黄级
  assert.ok(r.hints[0].text.indexOf('结算通道长时间无活动') >= 0)
  assert.ok(r.hints[0].text.indexOf('已 41 分钟') >= 0)
  // settle 通道新鲜（5min 前有成功结算）→ 不亮
  assert.deepEqual(computeRuntimeHealthHints(board, { bornAt: now - 90 * MIN, poolLastOkAt: now, settleLastOkAt: now - 5 * MIN }, { capW: 1, now: now }).hints, [])
  // 无 in-progress 卡 → 即使 settle 从不活动也不亮（没有该结算的东西）
  var noRun = { tasks: [mkPending()] }
  assert.deepEqual(computeRuntimeHealthHints(noRun, { bornAt: now - 90 * MIN, poolLastOkAt: now, settleLastOkAt: now - 90 * MIN }, { capW: 1, now: now }).hints, [])
  // 死会话（alive:false）→ 不判 settle
  assert.deepEqual(computeRuntimeHealthHints(board, { bornAt: now - 90 * MIN, poolLastOkAt: now, settleLastOkAt: now - 90 * MIN }, { capW: 1, now: now, alive: false }).hints, [])
  // settleLastOkAt 缺失退 bornAt：bornAt 41min 前 → 亮（宽限期自首次见到本板起算）
  var r2 = computeRuntimeHealthHints(board, { bornAt: now - 41 * MIN, poolLastOkAt: now }, { capW: 1, now: now })
  assert.equal(r2.hints.length, 1)
  assert.ok(r2.hints[0].text.indexOf('结算通道长时间无活动') >= 0)
})

// ===== ⑤ 幽灵回收 hint 一次性 =====
test('⑤ 幽灵回收 hint 一次性：读到即消费（consumeReapNote）；过期未读不亮但照清', function () {
  var now = Date.now()
  var rt = { bornAt: now, reapNote: { n: 3, at: now - 10 * 1000 } }
  var r1 = computeRuntimeHealthHints({ tasks: [] }, rt, { capW: 0, now: now })
  assert.equal(r1.hints.length, 1)
  assert.equal(r1.hints[0].level, 'info')
  assert.ok(r1.hints[0].text.indexOf('本轮回收 3 个幽灵活跃表项') >= 0)
  assert.equal(r1.consumeReapNote, true)
  // 模拟 rpc 消费（delete rt.reapNote）后第二次调用 → 不再出现（一次性）
  delete rt.reapNote
  var r2 = computeRuntimeHealthHints({ tasks: [] }, rt, { capW: 0, now: now })
  assert.equal(r2.hints.length, 0)
  assert.equal(r2.consumeReapNote, false)
  // 过期（>90s 保鲜期）未读：不亮条，但仍要求消费（不留在 state 里发酵）
  var stale = { bornAt: now, reapNote: { n: 2, at: now - 120 * 1000 } }
  var r3 = computeRuntimeHealthHints({ tasks: [] }, stale, { capW: 0, now: now })
  assert.equal(r3.hints.length, 0)
  assert.equal(r3.consumeReapNote, true)
})

// ===== 组合场景：多条同时命中时的展示顺序（进行中的事故优先于历史留痕）=====
test('组合场景顺序：①冻结 > ②settle > ③幽灵回收', function () {
  var now = Date.now()
  var board = { tasks: [mkPending(), mkPending({ id: 'run1', status: 'in-progress', claimedBy: 'w1' })] }
  var rt = { bornAt: now - 90 * MIN, poolLastOkAt: now - 20 * MIN, settleLastOkAt: now - 50 * MIN, reapNote: { n: 1, at: now - 5000 } }
  var r = computeRuntimeHealthHints(board, rt, { capW: 1, now: now })
  assert.equal(r.hints.length, 3)
  assert.ok(r.hints[0].text.indexOf('派发循环疑似冻结') >= 0)
  assert.ok(r.hints[1].text.indexOf('结算通道长时间无活动') >= 0)
  assert.ok(r.hints[2].text.indexOf('幽灵活跃表项') >= 0)
  assert.equal(r.consumeReapNote, true)
})

// ===== ⑥ host 挂点源码断言 =====
test('⑥ host 挂点源码断言：dispatch 心跳打点 / rpc 接线 / index state 容器', function () {
  var srcDispatch = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  assert.ok(srcDispatch.indexOf('poolLastOkAt') >= 0, 'dispatch.mjs 应有 poolCycle 成功轮心跳打点')
  assert.ok(srcDispatch.indexOf('settleLastOkAt') >= 0, 'dispatch.mjs 应有 settleRunRecord 打点')
  assert.ok(srcDispatch.indexOf('reapNote') >= 0, 'dispatch.mjs 应有幽灵回收一次性记录打点')
  assert.ok(srcDispatch.indexOf('dispatchOk') >= 0, 'dispatch.mjs 应有成功派发计数')
  var srcRpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  assert.ok(srcRpc.indexOf('computeRuntimeHealthHints') >= 0, 'rpc.mjs get-tasks 应接线运行时 hint')
  assert.ok(srcRpc.indexOf('consumeReapNote') >= 0, 'rpc.mjs 应执行 reapNote 一次性消费')
  var srcIndex = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.ok(srcIndex.indexOf('poolHealth') >= 0, 'index.mjs state 应构建 poolHealth 容器')
})
