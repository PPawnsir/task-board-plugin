// dsh-agent-board — 结算≠停止根修（task-mv8wuznb）：一次性 run 落定后主动 interrupt 子会话
// 事故实证（ontology 2026-10-15）：卡 02:02 resolved / verdict 已落账，verifier 子会话仍持续写盘
// 空转到 10:16 被主窗口手杀——8 小时空烧。settle 只关账不杀会话，三盖齐修：
//   ① settleRunRecord 末尾补停（settleRun 的 completed/failed/incomplete 与 reapGhostRecs 幽灵回收
//      收尾的唯一汇合点——事故原形「board_verdict 落账 → 卡 resolved → rec 下轮被幽灵回收」即走这里）；
//   ② reconcileRoot 重启后扫「落定卡 + running 无 endedAt 留档 + 子会话仍活」的孤儿一次性 run 补停；
//   ③ board_verdict late 分支（卡已落定后收到 verdict）落账后按 actor（= 调用它的 verifier 子会话）补停。
// 边界（本文件锁定）：hook 点位不在本卡范围；continuable 豁免经 task-mvbeallq 收紧——仅「续跑位真在
// 本 child 手上」（活跃表新 rec 接管同会话 / resumeTarget 仍指向它）才豁免；continuable 但无续跑位的
// 落定（completed / noResume / 卡面留档被更新的 run 取代）同样补停，堵「续跑豁免」留下的残影续跑窗。
// 用例 A/B/C/F 跑在「真实 index.mjs apply(mockCtx)」上（与 integration.test.mjs 同一 harness），
// 用例 E 走 rpc 直调 harness（verify-timing.test.mjs 同款薄桩）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'
import { createRpc } from '../lib/rpc.mjs'
import { createDispatch } from '../lib/dispatch.mjs'

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
test('① verifier 一次性 run 正常结算 → interrupt 补停恰一枪；既有 dispose/关账不回归；continuable worker completed 落定亦补停（task-mvbeallq 收紧）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-ss-a', { pipeline: 'full', acceptance: 'npm test' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker continuable spawn 发生')
    var child = env.continuables[0]
    await env.waitFor(function () { var x = env.task('task-ss-a'); return x && x.status === 'in-progress' ? x : null }, '落卡 in-progress')
    // Worker 上报通道完成 → verifying（continuable rec 经 settleReportedRun 收尾——completed 落定
    // 无续跑位，task-mvbeallq 起同样补停，见下方断言）
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
    // continuable worker completed 落定 → 无续跑位 → 补停（task-mvbeallq 豁免收紧直证①）：
    // 上报即完成，会话留着只会残影空转（resumeTarget 只认超时/失败结局，completed 永不续跑）。
    await env.waitFor(function () { return stopsOn(env, child.childId).length >= 1 }, 'continuable worker completed 落定补停')
    assert.equal(stopsOn(env, child.childId).length, 1, '恰好一枪（settleReportedRun→settleRunRecord 尾序补停）')
    assert.equal(stopsOn(env, child.childId)[0].authority.kind, 'ancestor', 'authority 形状同款')
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

// ===== 边界：continuable worker 失败结算零新增 interrupt（豁免直证，task-mvbeallq 收紧后不回归）=====
// 失败落定（incomplete）→ resumeTarget 指向本 child = 续跑位在手 → 豁免成立：结算收尾只有
// endContinuable 那一枪（打断 turn、留存会话）；settleRunRecord 末尾的补停对它必须原样放行——
// 否则续跑语义（sendMessage 冷复活）被杀掉。
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

// ===== ① 收紧（task-mvbeallq）：continuable 旧 run 被重派取代（残影形状）→ 幽灵回收收尾补停旧子会话 =====
// ontology 残影事故形状：池故障后旧 run 已死，主窗口重派的新 Worker 占了认领位与最新留档；旧
// continuable 子会话若借「continuable 即跳」豁免续跑 = 残影与新 Worker 同批文件互踩。收紧后：
// resumeTarget 看最新留档（新 run 仍 running）→ 旧 child 无续跑位 → 幽灵回收收尾补停；
// 新 Worker 的留档/认领位/卡面状态一律不动。
test('① 收紧：continuable 旧 run 被重派取代（残影形状）→ 幽灵回收收尾补停旧子会话', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-ss-g', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'continuable spawn 发生')
    var child = env.continuables[0]
    await env.waitFor(function () { var x = env.task('task-ss-g'); return x && x.status === 'in-progress' && x.claimedBy === child.childId ? x : null }, '落卡 in-progress（旧 Worker 认领）')
    // 模拟主窗口重派：认领位易主 + 卡面追加一条更新的 worker 留档（新 run 仍 running）
    env.patchBoard(function (d) {
      var t = d.tasks.find(function (x) { return x.id === 'task-ss-g' })
      t.claimedBy = 'child-new-worker'
      t.runs.push({ role: 'worker', id: 'child-new-worker', at: new Date().toISOString(), outcome: 'running' })
    })
    await env.clock.advance(50) // 下一轮 poolCycle：旧 rec 认领位不符 → 幽灵回收 → settleRunRecord 收尾补停
    await env.waitFor(function () { return stopsOn(env, child.childId).length >= 1 }, '旧子会话残影被补停')
    assert.equal(stopsOn(env, child.childId).length, 1, '恰好一枪（回收路径无 endContinuable，唯补停）')
    assert.equal(stopsOn(env, child.childId)[0].authority.kind, 'ancestor', 'authority 形状同款')
    assert.equal(stopsOn(env, 'child-new-worker').length, 0, '补停目标只打旧残影，不误伤新 Worker')
    var t = await env.waitFor(function () { var x = env.task('task-ss-g'); return x && x.runs && x.runs[0] && x.runs[0].outcome === 'incomplete' ? x : null }, '旧留档关账 incomplete')
    assert.equal(t.status, 'in-progress', '卡面状态不被收尾改动（新 Worker 照常干活）')
    assert.equal(t.claimedBy, 'child-new-worker', '新 Worker 认领位不动')
    assert.equal(t.runs[t.runs.length - 1].outcome, 'running', '新 run 留档不被误关')
  } finally { await env.cleanup() }
})

// ===== 续跑健康闸 / 死会话哨兵（task-mvowb2hc 洞②③④）=====
// 原形（task-mvoutja4 实证）：glm-5.3-flash 提供商故障三连洞——洞②续跑不过健康闸（continuable 续跑
// 直接 sendMessage 旧会话，不重新过取模链，病模型照样续跑 38 分钟零产出）；洞③死会话续跑成僵尸
// running（续跑留档挂 running 但会话早已拆除，零结算通道可达，挂到人工终止）。修：tryResumeWorker
// 续跑前查目标会话模型健康（badModels 熔断 + modelCooldown 冷却，healthyModel 双闸），病模型 → 放弃
// 续跑改 fresh spawn 走健康取模链（resume-fallback 消息留痕）；sendMessage 返回后挂死会话哨兵（短延时
// 查活跃目录 listChildren），会话不在且从未观测到 running → 立即失败结算重派，不留 running 假相。
// 健康模型续跑行为逐字不变（洞④回归）。薄桩 harness：与 core.test.mjs mkContinuableDispatch 同形
// （真跑 poolCycle），另加 state 注入（种病模型）、记录式 timer（哨兵手动 fire）、listChildren 可剧本化。
var GATE_SID = 'session-test-gate-0000-0000-000000000000'
function mkGateTask(over) {
  return Object.assign({ id: 'g1', title: '续跑闸卡', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', history: [], messages: [] }, over || {})
}
function mkGateBoard(tasks) { return { version: 12, ownerSession: GATE_SID, boardMode: 'auto', tasks: tasks || [] } }
function mkGateDispatch(board, ctxOver, stateOver) {
  var listeners = []
  var timerCalls = []
  var notes = []
  var runs = {}
  var activeRuns = {}
  activeRuns[GATE_SID] = runs
  var state = Object.assign({ knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {} }, stateOver || {})
  state.activeRuns = activeRuns
  var base = {
    fs: {}, get: function () { return null },
    // 记录式 timer：timeout(cb, ms) 捕获回调与延迟，测试手动 fire（死亡哨兵 5s / 软臂 30min 都经这里）；
    // interval（15s 心跳）只登记不触发——本套用例手动跑 poolCycle，心跳不入 timerCalls 免污染哨兵过滤
    timer: {
      timeout: function (a, b) {
        if (typeof a === 'function') { var h = { cb: a, ms: b, cancelled: false }; timerCalls.push(h); return function () { h.cancelled = true } }
        return new Promise(function () {})
      },
      interval: function () { return function () {} },
    },
    effect: function (f) { var d = f(); return function () {} }, // 真实 effect 立即执行回调——事件订阅当场建立
    on: function (name, fn) { listeners.push({ name: name, fn: fn }); return function () {} },
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { return { id: 'run-x', result: new Promise(function () {}), dispose: async function () {} } },
      startContinuable: async function () { return { childId: 'child-new', messageId: 'm1' } },
    },
  }
  var dispatch = createDispatch(
    Object.assign(base, ctxOver || {}),
    state,
    {
      rt: async function () { return board }, wt: async function () {}, mutateLocked: async function (sid, fn) { return fn(board) }, kickCycle: function () {},
      rootForSession: function () { return { id: GATE_SID } },
      withTimeout: function (p) { return p }, runsFor: function () { return runs }, feedbackOn: function () { return true },
      pushSysNote: function (s, text, taskId) { notes.push({ sid: s, text: text, taskId: taskId }) },
      maybeNotify: function () {}, notifyTaskDone: function () {},
    })
  return { dispatch: dispatch, state: state, runs: runs, listeners: listeners, timerCalls: timerCalls, notes: notes, board: board }
}
var flushGate = async function () { for (var i = 0; i < 8; i++) await new Promise(function (r) { setImmediate(r) }) }
// 死会话哨兵的短延时臂（软臂 30min 被排除在窗口外；本桩无 llm 不挂探测臂）
function gateWatchArms(h) { return h.timerCalls.filter(function (c) { return c.ms > 0 && c.ms <= 60000 && !c.cancelled }) }
// 续跑目标行（原形留档形状：continuable + timeout/error + model 随留档）
function gateResumeRow(model) { return { role: 'worker', id: 'child-old', at: '2026-01-01T00:00:00.000Z', model: model, outcome: 'timeout/error', hardMin: 120, continuable: true } }

test('续跑健康闸①（task-mvowb2hc 洞②）：原模型已熔断 → 零续跑投递，改 fresh spawn 走健康取模链（fallback 命中+留痕）', async () => {
  var t = mkGateTask({ runs: [gateResumeRow('prov/glm-5.3-flash')] })
  var board = mkGateBoard([t])
  board.workerModel = 'prov/glm-5.3-flash'
  board.fallbackModels = ['prov/alt-model']
  var badModels = {}
  badModels[GATE_SID + '|prov/glm-5.3-flash'] = true
  var sent = []
  var h = mkGateDispatch(board, {
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { throw new Error('不该走一次性路径') },
      startContinuable: async function () { return { childId: 'child-new', messageId: 'm1' } },
      sendMessage: async function (p, cid, content, opts) { sent.push({ cid: cid, text: content[0].text }); return 'm2' },
    },
  }, { badModels: badModels })
  var origErr = console.error; console.error = function () {} // 压掉链跳过日志
  try {
    await h.dispatch.poolCycle(GATE_SID)
    await flushGate()
    assert.deepEqual(sent, [], '病模型零续跑投递（健康闸拦截，不再空烧病模型）')
    var note = (t.messages || []).find(function (m) { return m.kind === 'resume-fallback' })
    assert.ok(note, '续跑放弃留痕（resume-fallback 消息）')
    assert.match(note.text, /续跑放弃/)
    assert.match(note.text, /prov\/glm-5\.3-flash/)
    assert.equal(t.claimedBy, 'child-new', '回退 fresh spawn 落卡（新 Worker）')
    var last = t.runs[t.runs.length - 1]
    assert.equal(last.model, 'prov/alt-model', 'fresh spawn 走健康取模链：备用链命中首个健康者')
    assert.equal(last.modelSource, 'fallback', 'modelSource=fallback 留档')
  } finally { console.error = origErr }
})

test('续跑健康闸②（task-mvowb2hc 洞②）：原模型冷却中 → 同样放弃续跑改 fresh spawn（healthyModel 双闸覆盖冷却）', async () => {
  var t = mkGateTask({ runs: [gateResumeRow('prov/glm-5.3-flash')] })
  var board = mkGateBoard([t])
  board.workerModel = 'prov/glm-5.3-flash'
  var sent = []
  var cooldown = {}
  cooldown['prov/glm-5.3-flash'] = Date.now() + 60000
  var h = mkGateDispatch(board, {
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { throw new Error('不该走一次性路径') },
      startContinuable: async function () { return { childId: 'child-new', messageId: 'm1' } },
      sendMessage: async function (p, cid, content, opts) { sent.push({ cid: cid, text: content[0].text }); return 'm2' },
    },
  }, { modelCooldown: cooldown })
  var origErr = console.error; console.error = function () {}
  try {
    await h.dispatch.poolCycle(GATE_SID)
    await flushGate()
    assert.deepEqual(sent, [], '冷却中模型零续跑投递')
    var note = (t.messages || []).find(function (m) { return m.kind === 'resume-fallback' })
    assert.ok(note && /续跑放弃/.test(note.text), '续跑放弃留痕')
    assert.equal(t.claimedBy, 'child-new', '回退 fresh spawn（父模型兜底——冷却面不回试同档高位）')
  } finally { console.error = origErr }
})

test('续跑健康闸③（task-mvowb2hc 洞④回归）：健康模型续跑逐字不变——sendMessage 照发、rec 落闸、续跑行 model 补齐归因', async () => {
  var t = mkGateTask({ runs: [gateResumeRow('prov/glm-5.3-flash')] })
  var board = mkGateBoard([t])
  board.workerModel = 'prov/glm-5.3-flash'
  var sent = []
  var h = mkGateDispatch(board, {
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { throw new Error('健康模型续跑命中时不该走一次性路径') },
      startContinuable: async function () { throw new Error('续跑命中时不该 fresh spawn') },
      sendMessage: async function (p, cid, content, opts) { sent.push({ cid: cid, text: content[0].text, options: opts }); return 'm2' },
    },
  })
  await h.dispatch.poolCycle(GATE_SID)
  await flushGate()
  assert.equal(sent.length, 1, '健康模型照常续跑（零回归）')
  assert.equal(sent[0].cid, 'child-old', '冷复活目标是原子会话')
  assert.ok(sent[0].options && sent[0].options.signal, 'sendMessage 选项形态 { signal } 不变')
  var rec = h.runs['g1']
  assert.equal(rec.model, 'prov/glm-5.3-flash', '续跑 rec.model 补齐归因（原形恒空）')
  assert.equal(rec.resumed, true)
  assert.equal(rec.settled, false)
  assert.equal(t.runs[1].resume, true, '续跑留档照旧')
  assert.equal(t.runs[1].model, 'prov/glm-5.3-flash', '续跑行 model 落档（审计补齐）')
  assert.equal(t.claimedBy, 'child-old', '认领位回原子会话')
})

test('死会话哨兵（task-mvowb2hc 洞③）：sendMessage 返回但会话不在活跃目录 → 立即失败重派不留 running 假相', async () => {
  var t = mkGateTask({ runs: [gateResumeRow('prov/glm-5.3-flash')] })
  var board = mkGateBoard([t])
  board.workerModel = 'prov/glm-5.3-flash'
  var kids = [] // 会话不在活跃目录（死会话原形：宿主拆除后冷复活承诺落空）
  var h = mkGateDispatch(board, {
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { throw new Error('续跑命中时不该走一次性路径') },
      startContinuable: async function () { throw new Error('续跑命中时不该 fresh spawn') },
      sendMessage: async function (p, cid, content, opts) { return 'm2' },
      listChildren: async function () { return kids },
    },
  })
  await h.dispatch.poolCycle(GATE_SID)
  await flushGate()
  assert.equal(h.runs['g1'] && h.runs['g1'].resumed, true, '续跑先正常落闸（哨兵随后接管）')
  assert.equal(t.runs.length, 2, '首派 + 续跑各一条')
  assert.equal(t.runs[1].outcome, 'running', '续跑留档先挂 running（哨兵未触发前）')
  assert.ok(gateWatchArms(h).length >= 1, '死亡哨兵短延时臂在位')
  // 触发哨兵：会话不在活跃目录 → 立即失败结算重派（不留 running 假相）
  gateWatchArms(h).forEach(function (c) { c.cb() })
  await flushGate()
  assert.equal(t.status, 'pending', '立即失败重排（原形挂到人工终止，现立即收口）')
  assert.equal(t.retryCount, 1, '失败计数照旧')
  assert.equal(t.runs[1].outcome, 'timeout/error', '续跑留档立即关账（非 running 假相）')
  assert.equal(h.runs['g1'], undefined, '活跃 rec 摘除')
})

test('死会话哨兵·退位（task-mvowb2hc 洞③）：会话在活跃目录 / 已观测到 running → 不误杀（健康续跑零变化）', async () => {
  // Case A：listChildren 命中 child-old（会话真活）→ 哨兵触发但不结算
  var t = mkGateTask({ runs: [gateResumeRow('prov/glm-5.3-flash')] })
  var board = mkGateBoard([t])
  board.workerModel = 'prov/glm-5.3-flash'
  var h = mkGateDispatch(board, {
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { throw new Error('不该走一次性路径') },
      startContinuable: async function () { throw new Error('续跑命中时不该 fresh spawn') },
      sendMessage: async function (p, cid, content, opts) { return 'm2' },
      listChildren: async function () { return [{ id: 'child-old' }] },
    },
  })
  await h.dispatch.poolCycle(GATE_SID)
  await flushGate()
  gateWatchArms(h).forEach(function (c) { c.cb() })
  await flushGate()
  assert.equal(t.status, 'in-progress', '会话在活跃目录：哨兵退位不误杀')
  assert.equal(t.retryCount, undefined, '零失败计数')
  assert.equal(t.runs[1].outcome, 'running', '续跑留档不被误关')
  assert.ok(h.runs['g1'], '活跃 rec 保留（结算归事件/超时通道）')
  // Case B：会话不在目录但已观测到 running 事件（rec.ran=true，会话曾真跑）→ 哨兵退位
  var t2 = mkGateTask({ id: 'g2', runs: [gateResumeRow('prov/glm-5.3-flash')] })
  var board2 = mkGateBoard([t2])
  board2.workerModel = 'prov/glm-5.3-flash'
  var h2 = mkGateDispatch(board2, {
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { throw new Error('不该走一次性路径') },
      startContinuable: async function () { throw new Error('续跑命中时不该 fresh spawn') },
      sendMessage: async function (p, cid, content, opts) { return 'm2' },
      listChildren: async function () { return [] },
    },
  })
  await h2.dispatch.poolCycle(GATE_SID)
  await flushGate()
  h2.listeners[0].fn({ agent: { session: { id: 'child-old' } }, status: 'running' }) // 会话曾真跑起来
  assert.equal(h2.runs['g2'].ran, true)
  gateWatchArms(h2).forEach(function (c) { c.cb() })
  await flushGate()
  assert.equal(t2.status, 'in-progress', '已观测到 running：哨兵退位不误杀')
  assert.ok(h2.runs['g2'], '活跃 rec 保留（结算归事件/超时通道）')
  assert.equal(t2.runs[1].outcome, 'running', '续跑留档不被误关')
})
