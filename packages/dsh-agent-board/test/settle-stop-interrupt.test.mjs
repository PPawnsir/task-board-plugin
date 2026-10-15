// dsh-agent-board — 结算≠停止根修（task-mv8wuznb）：一次性 run 落定后主动 interrupt 子会话
// 事故实证（ontology 2026-10-15）：卡 02:02 resolved / verdict 已落账，verifier 子会话仍持续写盘
// 空转到 10:16 被主窗口手杀——8 小时空烧。settle 只关账不杀会话，三盖齐修：
//   ① settleRunRecord 末尾补停（settleRun 的 completed/failed/incomplete 与 reapGhostRecs 幽灵回收
//      收尾的唯一汇合点——事故原形「board_verdict 落账 → 卡 resolved → rec 下轮被幽灵回收」即走这里）；
//   ② reconcileRoot 重启后扫「落定卡 + running 无 endedAt 留档 + 子会话仍活」的孤儿一次性 run 补停；
//   ③ board_verdict late 分支（卡已落定后收到 verdict）落账后按 actor（= 调用它的 verifier 子会话）补停。
// 边界（本文件锁定）：continuable worker 豁免——endContinuable 的 interrupt 是「打断 turn、留存会话
// 供续跑」，语义相反；hook 点位不在本卡范围。
// 用例 A/B/C/F 跑在「真实 index.mjs apply(mockCtx)」上（与 integration.test.mjs 同一 harness），
// 用例 E 走 rpc 直调 harness（verify-timing.test.mjs 同款薄桩）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'
import { createRpc } from '../lib/rpc.mjs'

// ===== 测试工具（与 integration.test.mjs 同形）=====
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '补停任务 ' + id, description: '结算≠停止根修用例 ' + id }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  return r.task
}
function runsOf(t, role) { return (t.runs || []).filter(function (r) { return r.role === role }) }
function stopsOn(env, childId) { return env.interrupts.filter(function (x) { return x.childId === childId }) }
// Verifier 结论文本：行首锚定 APPROVED（parseVerdict 口径）
var APPROVE_TEXT = 'APPROVED\n\n## 验证概要\n验收脚本独立复跑通过\n\n## 核对项\n- npm test 全绿'

// ===== ① 一次性 run 正常结算（completed，run.result 通道）→ 子会话收到 interrupt 补停 =====
test('① verifier 一次性 run 正常结算 → interrupt 补停恰一枪；既有 dispose/关账不回归；continuable worker 豁免', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-ss-a', { pipeline: 'full', acceptance: 'npm test' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker continuable spawn 发生')
    var child = env.continuables[0]
    await env.waitFor(function () { var x = env.task('task-ss-a'); return x && x.status === 'in-progress' ? x : null }, '落卡 in-progress')
    // Worker 上报通道完成 → verifying（continuable rec 经 settleReportedRun 收尾——此路必须零补停）
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-ss-a', kind: 'complete', summary: '实现', changes: '改了 a', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep.ok, true)
    await env.clock.advance(50)
    var vrun = await env.waitFor(function () { return env.lastRun('verifier:task-ss-a') }, 'verifier 一次性 spawn 发生')
    // Verifier run.result 落定（正常 completed 路径）→ settleRun → dispose + settleVerifier + 补停
    vrun.resolveWith(APPROVE_TEXT)
    // 直等补停记录（结算链尾序：关账/落卡在先，补停在 settleRunRecord 末尾）
    await env.waitFor(function () { return stopsOn(env, vrun.id).length >= 1 }, 'verifier 结算后 interrupt 补停')
    assert.equal(stopsOn(env, vrun.id).length, 1, '恰好补停一枪（dispose 之外的增量，无重复）')
    assert.equal(stopsOn(env, vrun.id)[0].authority.kind, 'ancestor', 'authority 形状与 endContinuable/doTerminate 同款')
    assert.ok(vrun.disposed, '既有 dispose 收尾不变（补停是增量不是替代）')
    // 结算流程不回归：卡 resolved + verifier run 关账 completed
    await env.waitFor(function () { var x = env.task('task-ss-a'); return x && x.status === 'resolved' && runsOf(x, 'verifier')[0] && runsOf(x, 'verifier')[0].outcome === 'completed' ? x : null }, 'resolved 且 verifier run 关账 completed')
    // continuable worker 豁免：board_report 收尾（settleReportedRun→settleRunRecord）不对它补枪
    assert.equal(stopsOn(env, child.childId).length, 0, 'continuable worker 零 interrupt（续跑语义要留会话）')
  } finally { await env.cleanup() }
})

// ===== ① 一次性 worker（workerContinuable=false 回退开关）失败结算 → interrupt 补停（盖 failed 路径）=====
test('① 一次性 worker（回退开关关）失败结算 → interrupt 补停；失败重排语义不回归', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    var cf = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerContinuable', value: false })
    assert.equal(cf.ok, true, '回退开关落盘')
    await createTask(env, 'task-ss-b', { pipeline: 'work' })
    await env.clock.advance(50)
    var wrun = await env.waitFor(function () { return env.lastRun('worker:task-ss-b') }, '一次性 worker spawn（开关关 → 不动 continuable 面）')
    assert.equal(env.continuables.length, 0, '回退开关下不走 startContinuable')
    await env.waitFor(function () { var x = env.task('task-ss-b'); return x && x.status === 'in-progress' && x.claimedBy === wrun.id ? x : null }, '落卡 in-progress')
    // 失败落定（timeout/error）：补停同样要盖到——失败≠可以留着子会话空转
    wrun.failWith(new Error('boom'))
    await env.waitFor(function () { return stopsOn(env, wrun.id).length >= 1 }, '失败结算也补停（failed 落定路径）')
    var t = await env.waitFor(function () { var x = env.task('task-ss-b'); return x && x.status === 'pending' && x.runs && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null }, '失败回 pending 且关账 timeout/error（不回归）')
    assert.equal(t.retryCount, 1, '失败计数照旧')
    assert.equal(stopsOn(env, wrun.id).length, 1, '恰好一枪')
  } finally { await env.cleanup() }
})

// ===== ① 事故原形：board_verdict 正常分支落 resolved → 活跃 rec 下轮被幽灵回收 → 收尾补停 =====
// 这是 8h 空烧的真实路径：verdict 经工具通道落账即 resolved，但 run.result 永不落定（turn 未结束），
// settleRun 跑不到、dispose 永不触发；rec 在下轮 poolCycle 被 reapGhostRecs 按「卡面失活」摘除——
// 修复前这里只关账不停会话，修复后 settleRunRecord 末尾补一枪 interrupt。
test('① 事故原形：工具通道 verdict 落 resolved 后，幽灵回收收尾时 interrupt 补停该 verifier', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-ss-c', { pipeline: 'full', acceptance: 'npm test' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn')
    await env.waitFor(function () { var x = env.task('task-ss-c'); return x && x.status === 'in-progress' ? x : null }, '落卡 in-progress')
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-ss-c', kind: 'complete', summary: '实现', changes: '改了 c', selfTest: 'ok', diffStat: '' })
    assert.equal(rep.ok, true)
    await env.clock.advance(50)
    var vrun = await env.waitFor(function () { return env.lastRun('verifier:task-ss-c') }, 'verifier spawn')
    // 工具通道正常分支（卡 verifying → resolved）。注意：本例永不 resolveWith——run.result 不落定，
    // 正是事故原形「空转中的 verifier 先交了 verdict」。
    var vd = await env.tools.get('board_verdict').execute({ taskId: 'task-ss-c', verdict: 'approved', summary: '复跑通过', checks: '## 核对项\n- ok' })
    assert.equal(vd.ok, true)
    await env.waitFor(function () { var x = env.task('task-ss-c'); return x && x.status === 'resolved' ? x : null }, 'verdict 落 resolved')
    assert.equal(stopsOn(env, vrun.id).length, 0, '正常分支 verdict 落账瞬间不补停（③只管 late 分支；此处证明补停来自幽灵回收收尾）')
    await env.clock.advance(50) // 下一轮 poolCycle：卡 resolved ≠ verifying → rec 失活被 reap → settleRunRecord 收尾
    await env.waitFor(function () { return stopsOn(env, vrun.id).length >= 1 }, '幽灵回收收尾时 interrupt 补停（事故原形路径）')
    await env.waitFor(function () { var x = env.task('task-ss-c'); return x && runsOf(x, 'verifier')[0] && runsOf(x, 'verifier')[0].outcome === 'completed' ? x : null }, 'verifier run 由幽灵回收关账 completed')
    assert.equal(stopsOn(env, vrun.id).length, 1, '恰好一枪')
  } finally { await env.cleanup() }
})

// ===== ② reconcile 孤儿补停（重启场景）：落定卡 + running 留档 + 子会话仍活 → interrupt =====
// 重启把内存 rec 清零后，① 的补停再也打不到这些会话；reconcile 顺手按 listChildren 目录补枪。
// 豁免边界同卡锁定：continuable worker 留档不打（留存续跑语义）；已死会话（不在目录）不打（杀无可杀）。
test('② reconcile 孤儿补停：活着的孤儿 verifier/一次性 worker 被 interrupt；continuable 与死会话豁免', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-ss-d1', { pipeline: 'work' }) // 只为建出看板文件（不 advance，不触发派发）
    // 直接改板构造重启后现场：落定卡上挂 running 无 endedAt 的留档（内存 rec 早已随重启清零）
    env.patchBoard(function (d) {
      var t1 = d.tasks.find(function (x) { return x.id === 'task-ss-d1' })
      t1.status = 'resolved'; t1.resolvedAt = new Date().toISOString()
      t1.runs = [
        { role: 'verifier', id: 'child-orphan-v', at: '2026-01-01T00:00:00Z', outcome: 'running' },
        { role: 'worker', id: 'child-orphan-cont', at: '2026-01-01T00:00:00Z', outcome: 'running', continuable: true },
        { role: 'worker', id: 'child-orphan-w', at: '2026-01-01T00:00:00Z', outcome: 'running' },
      ]
      var t2 = JSON.parse(JSON.stringify(t1))
      t2.id = 'task-ss-d2'; t2.title = '补停任务 task-ss-d2'
      t2.runs = [{ role: 'verifier', id: 'child-orphan-dead', at: '2026-01-01T00:00:00Z', outcome: 'running' }]
      d.tasks.push(t2)
    })
    // 宿主目录：v / cont / w 仍活；dead 已死（不在列）
    env.children.push({ id: 'child-orphan-v' }, { id: 'child-orphan-cont' }, { id: 'child-orphan-w' })
    await env.clock.tick() // 手动触发一次心跳 → poolCycle → 首轮 reconcile（本 host 生命周期只做一次）
    await env.waitFor(function () {
      return stopsOn(env, 'child-orphan-v').length >= 1 && stopsOn(env, 'child-orphan-w').length >= 1
    }, '活着的孤儿 verifier 与一次性 worker 均被补停')
    assert.equal(stopsOn(env, 'child-orphan-cont').length, 0, 'continuable worker 留档豁免（留存续跑语义）')
    assert.equal(stopsOn(env, 'child-orphan-dead').length, 0, '已死会话不补枪（杀无可杀，留档归 sweepZombieRuns 关账）')
    assert.equal(env.interrupts[0].authority.kind, 'ancestor', 'authority 形状同款')
    // 等链尾再 cleanup：同轮 sweepZombieRuns 会把这些僵尸留档关账（stale-closed）落盘——不等它
    // 会撞上 cleanup 删目录的在飞写盘（ENOENT 噪音，harness 纪律见 headless-smoke 同名注记）。
    await env.waitFor(function () {
      var x = env.task('task-ss-d1'); var y = env.task('task-ss-d2')
      return x && y && x.runs.every(function (r) { return r.outcome === 'stale-closed' }) && y.runs.every(function (r) { return r.outcome === 'stale-closed' }) ? true : null
    }, '同轮僵尸留档关账落盘')
  } finally { await env.cleanup() }
})

// ===== ③ board_verdict late 分支补停：卡已落定后收到 verdict → 按 actor 补停该 verifier =====
// 实证：verifier 迟到交付 verdict 落账后又空转 8h——此时它的 rec 早已被幽灵回收，① 打不到，
// 只有 late 分支能按 actor（能调工具即证明还活着）补停。
var LATE_SID = 'session-mock-late-00000000-0001'
function mkLateTask(over) { return Object.assign({ id: 'lt1', title: 'T', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null, history: [], messages: [] }, over || {}) }
function mkLateBoard(tasks) { return { version: 11, ownerSession: LATE_SID, boardMode: 'auto', verifyUserGuide: true, tasks: tasks || [] } }
// 薄桩 harness（verify-timing.test.mjs 同款）：直捕 tools 表；subagents.interrupt / rootForSession 可剧本化
function mkLateHarness(board, opts) {
  opts = opts || {}
  var state = { handlers: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {}, poolHealth: {} }
  var tools = {}
  var interrupts = []
  var parent = { id: LATE_SID }
  var ctx = {
    tools: { register: function (t) { tools[t.name] = t } },
    effect: function () {},
    webServer: { register: function () { return function () {} } },
  }
  if (!opts.noSubagents) ctx.subagents = { interrupt: function (id, auth) { interrupts.push({ id: id, auth: auth }) } }
  createRpc(ctx, state, {
    getActorId: function () { return opts.actor || 'verifier-child-99' },
    resolveRoot: function () { return LATE_SID },
    toolSessionId: function () { return LATE_SID }, rpcSessionId: function () { return LATE_SID },
    rootForSession: function () { return opts.noRoot ? null : parent },
    deriveWorkMode: function () { return 'solo' },
    runsFor: function () { return {} },
    rt: async function () { return board }, mutateLocked: function (sid, fn) { return fn(board) },
    maybeNotify: function () {}, notifyTaskDone: function () {},
    spawnOneShot: function () {}, accumulateRunUsage: function () {}, readContextPack: async function () { return null },
    pushSysNote: function () {}, sessionCwd: function () { return '' },
    hasActiveRun: function () { return false }, notifyLateReject: function () {},
  })
  return { tools: tools, interrupts: interrupts }
}

test('③ 迟到 verdict 落账后 interrupt 该 verifier 子会话（actor = 调用者）', async () => {
  var board = mkLateBoard([mkLateTask({ id: 'lt1', status: 'resolved', verifiedAt: '2026-01-01T00:01:00Z' })])
  var h = mkLateHarness(board)
  var r = await h.tools['board_verdict'].execute({ taskId: 'lt1', verdict: 'approved', summary: '迟到复跑通过', checks: '## 核对项\n- ok' })
  assert.equal(r.ok, true); assert.equal(r.late, true)
  assert.equal(h.interrupts.length, 1, 'late 落账后补停一枪')
  assert.equal(h.interrupts[0].id, 'verifier-child-99', '补停目标 = 调用者（迟到 verifier 子会话）')
  assert.equal(h.interrupts[0].auth.kind, 'ancestor', 'authority 形状同款')
  assert.equal(h.interrupts[0].auth.agent.id, LATE_SID, '以本板 root 授权')
  assert.ok(board.tasks[0].lateVerdict, '迟到落账本体不回归（lateVerdict 照常落卡）')
  assert.equal(board.tasks[0].status, 'resolved', '卡状态不被改写')
})

test('③ 守卫：主窗口手调（actor=root）/ unknown / 无 interrupt 能力 / 无活 root → 不补停也不炸', async () => {
  // 主窗口手工补录迟到结论：actor=root sid，绝不能打断自己
  var b1 = mkLateBoard([mkLateTask({ id: 'g1', status: 'resolved', verifiedAt: 'x' })])
  var h1 = mkLateHarness(b1, { actor: LATE_SID })
  var r1 = await h1.tools['board_verdict'].execute({ taskId: 'g1', verdict: 'approved', summary: 's' })
  assert.equal(r1.ok, true); assert.equal(r1.late, true)
  assert.equal(h1.interrupts.length, 0, 'actor=root 不补停（防误伤主窗口）')
  // 无调用栈（actor=unknown）：目标不可知，跳过
  var b2 = mkLateBoard([mkLateTask({ id: 'g2', status: 'resolved', verifiedAt: 'x' })])
  var h2 = mkLateHarness(b2, { actor: 'unknown' })
  var r2 = await h2.tools['board_verdict'].execute({ taskId: 'g2', verdict: 'approved', summary: 's' })
  assert.equal(r2.ok, true); assert.equal(r2.late, true)
  assert.equal(h2.interrupts.length, 0, 'actor=unknown 不补停')
  // 宿主无 interrupt 能力（老宿主）：静默跳过，late 落账不受影响
  var b3 = mkLateBoard([mkLateTask({ id: 'g3', status: 'resolved', verifiedAt: 'x' })])
  var h3 = mkLateHarness(b3, { noSubagents: true })
  var r3 = await h3.tools['board_verdict'].execute({ taskId: 'g3', verdict: 'rejected', summary: 's', checks: 'c' })
  assert.equal(r3.ok, true); assert.equal(r3.late, true); assert.equal(r3.lateRejected, true)
  // 无活 root 可授权（root 已死/重建窗口）：跳过
  var b4 = mkLateBoard([mkLateTask({ id: 'g4', status: 'resolved', verifiedAt: 'x' })])
  var h4 = mkLateHarness(b4, { noRoot: true })
  var r4 = await h4.tools['board_verdict'].execute({ taskId: 'g4', verdict: 'approved', summary: 's' })
  assert.equal(r4.ok, true); assert.equal(r4.late, true)
  assert.equal(h4.interrupts.length, 0, '无活 root 不补停')
})

// ===== 边界：continuable worker 结算零新增 interrupt（豁免直证）=====
// continuable 的结算收尾只有 endContinuable 那一枪（打断 turn、留存会话）；settleRunRecord 末尾的
// 补停对它必须原样放行——否则续跑语义（sendMessage 冷复活）被杀掉。
test('边界：continuable worker 失败结算仅 endContinuable 一枪（settleRunRecord 补停豁免）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-ss-f', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'continuable spawn 发生')
    var child = env.continuables[0]
    await env.waitFor(function () { var x = env.task('task-ss-f'); return x && x.status === 'in-progress' ? x : null }, '落卡 in-progress')
    // 事件通道失败结算（空文本）：settleContinuable → settleRun → endContinuable（一枪）→ settleRunRecord（豁免）
    env.emitStatus(child.childId, 'running')
    env.emitStatus(child.childId, 'idle')
    await env.waitFor(function () { var x = env.task('task-ss-f'); return x && x.status === 'pending' && x.runs && x.runs[0] && x.runs[0].outcome === 'incomplete' ? x : null }, '失败重排 pending 且关账 incomplete')
    await env.waitFor(function () { return stopsOn(env, child.childId).length >= 1 }, 'endContinuable 的留存 interrupt 到达')
    await new Promise(function (r) { setTimeout(r, 50) }) // 给结算链尾留收敛窗口（补停若有漏网必在此时露头）
    assert.equal(stopsOn(env, child.childId).length, 1, '仍只有 endContinuable 一枪：settleRunRecord 的补停对 continuable 原样放行')
  } finally { await env.cleanup() }
})
