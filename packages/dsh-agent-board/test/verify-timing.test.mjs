// dsh-agent-board — 验收时序三洞根修（用户 n-mv0ebretgv1o）：task_verify 抢跑守卫 + 归档门禁查活跃 run + 迟到 verdict 落账
// 事故：主窗口在 Verifier 活跃期 task_verify 抢批（早 0.4s）+ 归档，Verifier 的 verdict/自测指南被静默吞掉、无回执。
// 三洞逐一锁：① 抢跑守卫（force 通道）② 归档门禁查活跃 run ③ 迟到 verdict 落 lateVerdict/回执/userTest 补挂。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRpc } from '../lib/rpc.mjs'
import { createDispatch } from '../lib/dispatch.mjs'
import * as core from '../lib/core.mjs'

const FULL_SID = 'session-mock-timing-00000000-0001'

function mkTask(over) { return Object.assign({ id: 't1', title: 'T', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null, history: [], messages: [] }, over || {}) }
function mkBoard(tasks) { return { version: 11, ownerSession: FULL_SID, boardMode: 'auto', verifyUserGuide: true, tasks: tasks || [] } }

function waitFor(fn, label, ms) {
  var t0 = Date.now(); var cap = ms || 2000
  var p = function () { return new Promise(function (r) { setTimeout(r, 5) }) }
  return (async function () {
    for (;;) {
      var v; try { v = await fn() } catch (_) { v = null }
      if (v) return v
      if (Date.now() - t0 > cap) throw new Error('waitFor 超时（' + cap + 'ms）: ' + (label || '(未命名)'))
      await p()
    }
  })()
}

// ===== RPC/工具直调 harness（board_verdict / task_verify / archive-task / batch-op 三洞行为）=====
function mkRpcHarness(board, runsTable, extra, ctxExtra) {
  const state = { handlers: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {}, poolHealth: {} }
  const tools = {}
  const lateRejects = []
  const ctx = Object.assign({ tools: { register(t) { tools[t.name] = t } }, effect() {}, webServer: { register() { return () => {} } } }, ctxExtra || {})
  const deps = Object.assign({
    getActorId: () => 'tester', resolveRoot: (x) => x,
    toolSessionId: () => FULL_SID, rpcSessionId: () => FULL_SID,
    rootForSession: () => null, deriveWorkMode: () => 'solo',
    runsFor: (sid) => (runsTable[sid] || {}),
    rt: async () => board, mutateLocked: (sid, fn) => fn(board),
    maybeNotify: () => {}, notifyTaskDone: () => {},
    spawnOneShot: () => {}, accumulateRunUsage: () => {}, readContextPack: async () => null,
    pushSysNote: () => {}, sessionCwd: () => '',
    hasActiveRun: () => false,
    notifyLateReject: (sid, t) => { lateRejects.push({ sid: sid, id: t.id }) },
  }, extra || {})
  createRpc(ctx, state, deps)
  state.handlers.__tools = tools
  state.handlers.__lateRejects = lateRejects
  state.handlers.__state = state
  return state.handlers
}

// ===== dispatch harness（settleVerifier 文本通道迟到落账）=====
function mkSettleHarness(board) {
  var runs = {}
  var resolveRun = null
  var boardRef = { b: board }
  var lateRejects = []
  var state = { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {}, poolHealth: {} }
  var ctx = {
    fs: {}, effect: function () {}, get: function () { return null }, timer: null,
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { return { id: 'run-v1', result: new Promise(function (res) { resolveRun = res }), dispose: async function () {} } },
    },
  }
  var dispatch = createDispatch(ctx, state, {
    rt: async function () { return boardRef.b }, wt: async function () {}, mutateLocked: async function (sid, fn) { return fn(boardRef.b) },
    kickCycle: function () {}, rootForSession: function () { return { id: FULL_SID } }, sessionCwd: function () { return '' },
    withTimeout: function (p) { return p }, runsFor: function () { return runs }, feedbackOn: function () { return true }, epicSplitOn: function () { return true },
    pushSysNote: function () {}, maybeNotify: function () {}, notifyTaskDone: function () {},
    notifyLateReject: function (sid, t) { lateRejects.push(t.id) },
  })
  return { dispatch: dispatch, state: state, lateRejects: lateRejects, settle: function (text) { resolveRun({ output: [{ type: 'text', text: text }], stopReason: 'completed' }) } }
}

// ===== ① task_verify / verify-task 抢跑守卫 =====
test('① 抢跑守卫：verifier 活跃 → task_verify 工具 + verify-task RPC 拦截；force:true 放行；已 settled 不拦', async () => {
  // RPC 通道：活跃 verifier rec → 拦截
  const board = mkBoard([mkTask({ id: 'v1', status: 'verifying' })])
  const runs = { [FULL_SID]: { 'v1': { id: 'run-v1', role: 'verifier', settled: false } } }
  const h = mkRpcHarness(board, runs)
  const r = await h['verify-task']({ taskId: 'v1', verdict: 'approved' })
  assert.equal(r.ok, false)
  assert.match(r.error, /Verifier 还在跑（run run-v1）/); assert.match(r.error, /force:true/)
  assert.equal(board.tasks[0].status, 'verifying') // 未放行，状态不动
  // RPC 通道：force:true → 放行
  const r2 = await h['verify-task']({ taskId: 'v1', verdict: 'approved', force: true })
  assert.equal(r2.ok, true); assert.equal(board.tasks[0].status, 'resolved')
  // 工具通道同口径
  const board2 = mkBoard([mkTask({ id: 'v2', status: 'verifying' })])
  const runs2 = { [FULL_SID]: { 'v2': { id: 'run-v2', role: 'verifier', settled: false } } }
  const h2 = mkRpcHarness(board2, runs2)
  const r3 = await h2.__tools['task_verify'].execute({ taskId: 'v2', verdict: 'approved' }, {})
  assert.equal(r3.ok, false); assert.match(r3.error, /Verifier 还在跑（run run-v2）/); assert.equal(r3.verifierActive, 'run-v2')
  const r4 = await h2.__tools['task_verify'].execute({ taskId: 'v2', verdict: 'approved', force: true }, {})
  assert.equal(r4.ok, true); assert.equal(board2.tasks[0].status, 'resolved')
  // 已 settled 的 rec（Verifier 已结束）→ 不拦截
  const board3 = mkBoard([mkTask({ id: 'v3', status: 'verifying' })])
  const runs3 = { [FULL_SID]: { 'v3': { id: 'run-v3', role: 'verifier', settled: true } } }
  const h3 = mkRpcHarness(board3, runs3)
  const r5 = await h3['verify-task']({ taskId: 'v3', verdict: 'approved' })
  assert.equal(r5.ok, true)
})

// ===== ② 归档门禁查活跃 run =====
test('② 归档门禁：resolved 卡有活跃 verifier run（内存 rec / 卡面 running 留档）→ 拒绝；无活跃 run 放行', async () => {
  // 内存活跃表（最实时）
  const board = mkBoard([mkTask({ id: 'a1', status: 'resolved', verifiedAt: '2026-01-01T00:01:00Z', verifiedBy: 'tester', verifierRun: 'run-v' })])
  const runs = { [FULL_SID]: { 'a1': { id: 'run-v', role: 'verifier', settled: false } } }
  const h = mkRpcHarness(board, runs)
  const r = await h['archive-task']({ taskId: 'a1' })
  assert.equal(r.ok, false)
  assert.match(r.error, /有活跃 run（verifier run-v 仍在跑）/); assert.match(r.error, /等它落定或先 terminate/)
  assert.equal(board.tasks[0].status, 'resolved') // 未归档
  // 卡面 runs 留档兜底（无内存 rec，但 outcome running 且无 endedAt 且 id 匹配 verifierRun）
  const board2 = mkBoard([mkTask({ id: 'a2', status: 'resolved', verifiedAt: 'x', verifierRun: 'run-v2', runs: [{ role: 'verifier', id: 'run-v2', outcome: 'running' }] })])
  const h2 = mkRpcHarness(board2, {})
  const r2 = await h2['archive-task']({ taskId: 'a2' })
  assert.equal(r2.ok, false); assert.match(r2.error, /有活跃 run（verifier run-v2 仍在跑）/)
  // resolved 无活跃 run → 放行（既有行为不破）
  const board3 = mkBoard([mkTask({ id: 'a3', status: 'resolved' })])
  const h3 = mkRpcHarness(board3, {})
  const r3 = await h3['archive-task']({ taskId: 'a3' })
  assert.equal(r3.ok, true); assert.equal(board3.tasks[0].status, 'archived')
  // batch-op archive 同门禁
  const board4 = mkBoard([mkTask({ id: 'b1', status: 'resolved', verifierRun: 'run-b', runs: [{ role: 'verifier', id: 'run-b', outcome: 'running' }] }), mkTask({ id: 'b2', status: 'resolved' })])
  const h4 = mkRpcHarness(board4, {})
  const r4 = await h4['batch-op']({ op: 'archive', ids: ['b1', 'b2'] })
  assert.equal(r4.ok, true); assert.equal(r4.done, 1)
  assert.deepEqual(r4.skipped, ['b1']); assert.match(r4.reasons['b1'], /有活跃 run/)
})

// ===== ② 归档门禁 × terminate 语义死结回归（Verifier 驳回回归根修）=====
test('② 回归：terminate verifier → verifierRun 认领位清空，归档不再误判活跃（此前永久无法归档死结）', async () => {
  const board = mkBoard([mkTask({ id: 'a4', status: 'verifying', verifierRun: 'run-vX', runs: [{ role: 'verifier', id: 'run-vX', outcome: 'running' }] })])
  const runs = { [FULL_SID]: { 'a4': { id: 'run-vX', role: 'verifier', settled: false } } }
  const h = mkRpcHarness(board, runs)
  // 终止：内存表摘除 + 认领位清空（与 in-progress 清 claimedBy 同口径）
  const r = await h['terminate-agent']({ taskId: 'a4' })
  assert.equal(r.ok, true); assert.equal(r.terminated, 'verifier:a4')
  assert.equal(board.tasks[0].verifierRun, null)
  assert.equal(board.tasks[0].verifierRunAt, undefined)
  // 终止后主窗口补批（无需 force：已无活跃 verifier）→ resolved
  const r2 = await h.__tools['task_verify'].execute({ taskId: 'a4', verdict: 'approved' }, {})
  assert.equal(r2.ok, true); assert.equal(board.tasks[0].status, 'resolved')
  // 归档：修复前这里会因卡面 run-vX 仍 running 而误报「有活跃 run」并永久拒绝
  const r3 = await h['archive-task']({ taskId: 'a4' })
  assert.equal(r3.ok, true); assert.equal(board.tasks[0].status, 'archived')
})

test('② 回归：无活跃 rec 的 stale verifying 卡（terminate 空转场景）→ terminate 仍清 verifierRun，解除死结', async () => {
  const board = mkBoard([mkTask({ id: 'a5', status: 'verifying', verifierRun: 'run-vX', runs: [{ role: 'verifier', id: 'run-vX', outcome: 'running' }] })])
  const h = mkRpcHarness(board, {}) // 内存表空：rec 已不在（重启/已摘），正是报错文案推荐「先 terminate」却空转的场景
  const r = await h['terminate-agent']({ taskId: 'a5' })
  assert.equal(r.ok, true); assert.equal(r.terminated, 'no-active-run')
  assert.equal(board.tasks[0].verifierRun, null) // 认领位仍被清空 → 卡面兜底不再误判
  const r2 = await h.__tools['task_verify'].execute({ taskId: 'a5', verdict: 'approved' }, {})
  assert.equal(r2.ok, true); assert.equal(board.tasks[0].status, 'resolved')
  const r3 = await h['archive-task']({ taskId: 'a5' })
  assert.equal(r3.ok, true); assert.equal(board.tasks[0].status, 'archived')
})

// ===== ② 死结窗口根修（task-mv1pqy27）：terminate 认领位清理与状态无关 + 关 run 结局 terminated =====
test('② 死结窗口：resolved/cancelled 态 terminate（rec 仍在内存表）→ 认领位清 + run 关账，立即 archive 放行', async () => {
  // resolved 态窗口：卡已 resolved，但 verifier run 的 rec 还挂在内存表（~50ms 结算窗口）
  const board = mkBoard([mkTask({ id: 'a6', status: 'resolved', verifierRun: 'run-vX', runs: [{ role: 'verifier', id: 'run-vX', outcome: 'running' }] })])
  const runs = { [FULL_SID]: { 'a6': { id: 'run-vX', role: 'verifier', settled: false } } }
  const closed = []
  const h = mkRpcHarness(board, runs, { closeRunHistory: async (sid, taskId, runId, outcome) => { closed.push({ taskId: taskId, runId: runId, outcome: outcome }); var tt = board.tasks.find(function (x) { return x.id === taskId }); if (tt && Array.isArray(tt.runs)) { var rr = tt.runs[tt.runs.length - 1]; if (rr && rr.id === runId && rr.outcome === 'running') { rr.outcome = outcome; rr.endedAt = '2026-01-01T00:00:01Z' } } } })
  const r = await h['terminate-agent']({ taskId: 'a6' })
  assert.equal(r.ok, true); assert.equal(r.terminated, 'verifier:a6')
  assert.equal(board.tasks[0].verifierRun, null) // 状态无关：resolved 态也清 verifierRun（旧代码只在 verifying 清 → 死结）
  assert.deepEqual(closed, [{ taskId: 'a6', runId: 'run-vX', outcome: 'terminated' }]) // 关 run 结局 terminated
  assert.equal(board.tasks[0].runs[0].outcome, 'terminated')
  const r3 = await h['archive-task']({ taskId: 'a6' })
  assert.equal(r3.ok, true); assert.equal(board.tasks[0].status, 'archived') // 立即 archive 放行（修复前永久拒）

  // cancelled 态窗口：worker run 的 rec 仍在内存表，claimedBy 仍指已终止 run（closeRunHistory 未注入 = no-op 兜底，只靠认领位清）
  const board2 = mkBoard([mkTask({ id: 'a7', status: 'cancelled', claimedBy: 'run-wX', claimedAt: '2026-01-01T00:00:00Z', runs: [{ role: 'worker', id: 'run-wX', outcome: 'running' }] })])
  const runs2 = { [FULL_SID]: { 'a7': { id: 'run-wX', role: 'worker', settled: false } } }
  const h2 = mkRpcHarness(board2, runs2)
  const rw = await h2['terminate-agent']({ taskId: 'a7' })
  assert.equal(rw.ok, true); assert.equal(rw.terminated, 'worker:a7')
  assert.equal(board2.tasks[0].claimedBy, null); assert.equal(board2.tasks[0].claimedAt, null) // 状态无关：cancelled 态也清 claimedBy
  const rw3 = await h2['archive-task']({ taskId: 'a7' })
  assert.equal(rw3.ok, true); assert.equal(board2.tasks[0].status, 'archived') // 取消卡立即 archive 放行
})

// ===== ③④⑤ 迟到 verdict 落账（工具通道 board_verdict）=====
test('③ 迟到 approved：board_verdict 落到已 resolved 卡 → 落 lateVerdict，不炸、状态不动', async () => {
  const board = mkBoard([mkTask({ id: 'l1', status: 'resolved', verifiedAt: '2026-01-01T00:01:00Z' })])
  const h = mkRpcHarness(board, {})
  const r = await h.__tools['board_verdict'].execute({ taskId: 'l1', verdict: 'approved', summary: '复跑通过', checks: '## 核对项\n- ok' }, {})
  assert.equal(r.ok, true); assert.equal(r.late, true); assert.equal(r.lateRejected, false)
  const t = board.tasks[0]
  assert.equal(t.status, 'resolved') // 状态不动
  assert.equal(t.lateVerdict.verdict, 'approved')
  assert.equal(t.lateVerdict.summary, '复跑通过')
  assert.match(t.lateVerdict.note, /迟到结论：卡在落定后收到/)
  // 已落定卡上的 board_verdict 不触发正常回执/重派（返回体带 late 旗即可，无报错）
})

test('④ 迟到 rejected + 卡已 approved：board_verdict → err 通知 + healthHint（lateRejectNote）', async () => {
  const board = mkBoard([mkTask({ id: 'l2', status: 'resolved', verifiedAt: '2026-01-01T00:01:00Z' })])
  const h = mkRpcHarness(board, {})
  const r = await h.__tools['board_verdict'].execute({ taskId: 'l2', verdict: 'rejected', summary: '单测没过', checks: '## 核对项\n- 红' }, {})
  assert.equal(r.ok, true); assert.equal(r.late, true); assert.equal(r.lateRejected, true)
  const t = board.tasks[0]
  assert.equal(t.lateVerdict.verdict, 'rejected')
  // err 通知已投（notifyLateReject 捕获，直投 owner 不走回执聚合）
  assert.equal(h.__lateRejects.length, 1); assert.equal(h.__lateRejects[0].id, 'l2')
  // healthHint 落点（poolHealth.lateRejectNote，health.mjs computeRuntimeHealthHints 现算透出）
  assert.equal(h.__state.poolHealth[FULL_SID].lateRejectNote.taskId, 'l2')
})

test('⑤ userTest 补挂：迟到结论带 userTest → 补挂 t.verification.userTest；开关关则不挂', async () => {
  const ut = { gist: '改了验收时序', steps: ['打开看板'], expect: '看到提示', tier: 'ui' }
  const board = mkBoard([mkTask({ id: 'l3', status: 'resolved', verifiedAt: '2026-01-01T00:01:00Z' })])
  const h = mkRpcHarness(board, {})
  await h.__tools['board_verdict'].execute({ taskId: 'l3', verdict: 'rejected', summary: 'x', userTest: ut }, {})
  const t = board.tasks[0]
  assert.ok(t.lateVerdict.userTest, 'lateVerdict 挂 userTest')
  assert.ok(t.verification, '原 verification 缺 → 补建')
  assert.equal(t.verification.userTest.gist, '改了验收时序')
  assert.equal(t.verification.verdict, 'rejected') // 补建的 verification 用迟到结论的 verdict 兜底，非空
  // 开关关 → 不挂 userTest、不补建 verification
  const board2 = mkBoard([mkTask({ id: 'l4', status: 'resolved', verifiedAt: 'x' })]); board2.verifyUserGuide = false
  const h2 = mkRpcHarness(board2, {})
  await h2.__tools['board_verdict'].execute({ taskId: 'l4', verdict: 'rejected', summary: 'x', userTest: ut }, {})
  const t2 = board2.tasks[0]
  assert.equal(t2.lateVerdict.userTest, undefined)
  assert.equal(t2.verification, undefined)
})

// ===== ③④ 迟到 verdict 落账（文本通道 settleVerifier）=====
test('③④ settleVerifier 迟到：主窗口抢批 resolved 后 Verifier 迟到 REJECTED → 落 lateVerdict + 通知 + healthHint', async () => {
  const t = mkTask({ id: 's1', status: 'verifying' })
  const board = mkBoard([t])
  const h = mkSettleHarness(board)
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(t.verifierRun, 'run-v1') // 已派 Verifier
  // 主窗口抢批（早于 verifier 结算）：直接把卡置 resolved（等价 task_verify force approved，不写 t.verification）
  t.status = 'resolved'; t.verifiedAt = '2026-01-01T00:01:00Z'; t.verifiedBy = 'tester'
  h.settle('REJECTED: 交付物与验收脚本不符\n\n## 测试概要\nnpm test 未跑通\n\n## 核对项\n- 断言①红')
  await waitFor(function () { return t.lateVerdict }, 'settleVerifier 迟到落 lateVerdict')
  assert.equal(t.lateVerdict.verdict, 'rejected')
  assert.match(t.lateVerdict.summary, /npm test 未跑通/)
  assert.match(t.lateVerdict.checks, /断言①红/)
  assert.match(t.lateVerdict.note, /迟到结论/)
  // err 通知 + healthHint
  assert.equal(h.lateRejects.length, 1); assert.equal(h.lateRejects[0], 's1')
  assert.equal(h.state.poolHealth[FULL_SID].lateRejectNote.taskId, 's1')
  // 状态不被迟到的驳回改写（仍 resolved，不再回 pending 重派）
  assert.equal(t.status, 'resolved')
})

test('settleVerifier 迟到落账：工具通道已落账（verification.by === rec.id）→ 不重复落 lateVerdict', async () => {
  const t = mkTask({ id: 's2', status: 'verifying' })
  const board = mkBoard([t])
  const h = mkSettleHarness(board)
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(t.verifierRun, 'run-v1')
  // 模拟 board_verdict 工具通道已落账（by = 本 run 的 rec.id）并推进到 resolved
  t.verification = { verdict: 'approved', summary: 'OK', checks: '', at: '2026-01-01T00:01:00Z', by: 'run-v1' }
  t.status = 'resolved'; t.verifiedAt = '2026-01-01T00:01:00Z'
  h.settle('APPROVED: ok')
  await new Promise(function (r) { setTimeout(r, 50) }) // 给结算链一点时间跑完，确认不落 lateVerdict
  assert.equal(t.lateVerdict, undefined)
  assert.equal(t.verification.verdict, 'approved') // 原结论不被覆盖
})

// ===== terminate 假杀根修（task-mv8jfu1v，事故实证 n-mv8cfndmvfcv）=====
// 三洞：① 无 rec 也杀——in-progress + claimedBy（continuable 末条留档 running 且 id 一致）照样
//   interrupt 补杀 + 关账卡面 running 留档；② interrupt 抛错/核验未过 → err 级 pushSysNote +
//   healthHint（poolHealth.terminateFailNote）；③ hold:true → 同一次落账连带 assignMode=manual。
function mkTermBoard(taskId, childId) {
  return mkBoard([mkTask({ id: taskId, status: 'in-progress', claimedBy: childId, claimedAt: '2026-01-01T00:00:00Z', runs: [{ role: 'worker', id: childId, at: '2026-01-01T00:00:00Z', outcome: 'running', continuable: true }] })])
}
function mkCloseRunHistory(board, closed) {
  // 与生产 dispatch.closeRunHistory 同口径：只关 outcome==='running' 的条目
  return async (sid, taskId, runId, outcome) => { closed.push({ taskId: taskId, runId: runId, outcome: outcome }); var tt = board.tasks.find(function (x) { return x.id === taskId }); if (tt && Array.isArray(tt.runs)) { for (var i = tt.runs.length - 1; i >= 0; i--) { var rr = tt.runs[i]; if (rr && rr.id === runId && rr.outcome === 'running') { rr.outcome = outcome; rr.endedAt = '2026-01-01T00:00:01Z'; break } } } }
}

test('假杀根修①：无 rec 但 in-progress+claimedBy（continuable 留档 running）→ 照样 interrupt 补杀 + 关账 terminated + 核验过零告警', async () => {
  const parent = { id: FULL_SID }
  const interrupts = [], closed = [], sysNotes = []
  const board = mkTermBoard('zk1', 'child-zombie')
  const h = mkRpcHarness(board, {}, { // 内存表空：rec 已不在（结算竞态/清扫器先摘）——事故原形
    rootForSession: () => parent,
    closeRunHistory: mkCloseRunHistory(board, closed),
    pushSysNote: (sid, text) => sysNotes.push(text),
  }, { subagents: { interrupt: (id, auth) => interrupts.push({ id: id, auth: auth }), listChildren: async () => [] } })
  const r = await h['terminate-agent']({ taskId: 'zk1' })
  assert.equal(r.ok, true); assert.equal(r.terminated, 'worker:zk1') // 补杀命中，不再 no-active-run 空转
  assert.equal('killUnconfirmed' in r, false)
  assert.deepEqual(interrupts, [{ id: 'child-zombie', auth: { kind: 'ancestor', agent: parent } }]) // 按 claimedBy 补杀
  assert.deepEqual(closed, [{ taskId: 'zk1', runId: 'child-zombie', outcome: 'terminated' }]) // 卡面 running 留档被关账
  assert.equal(board.tasks[0].runs[0].outcome, 'terminated')
  assert.equal(board.tasks[0].status, 'pending'); assert.equal(board.tasks[0].claimedBy, null)
  assert.deepEqual(sysNotes, []) // listChildren 核验通过（子会话已不在目录）→ 零告警
  assert.equal(h.__state.poolHealth[FULL_SID], undefined)
})

test('假杀根修①边界：状态可疑宁可不动——一次性留档（无 continuable）/ 认领位与留档不一致 / spawn-pending 占位，均不补杀', async () => {
  const interrupts = []
  const ctxX = { subagents: { interrupt: (id) => interrupts.push(id), listChildren: async () => [] } }
  // 一次性 run（无 continuable 标记）：run 随宿主进程生死，无持久会话可补杀
  const b1 = mkBoard([mkTask({ id: 'os1', status: 'in-progress', claimedBy: 'run-1', runs: [{ role: 'worker', id: 'run-1', outcome: 'running' }] })])
  const h1 = mkRpcHarness(b1, {}, { rootForSession: () => ({ id: FULL_SID }) }, ctxX)
  const r1 = await h1['terminate-agent']({ taskId: 'os1' })
  assert.equal(r1.terminated, 'no-active-run'); assert.deepEqual(interrupts, [])
  assert.equal(b1.tasks[0].status, 'pending'); assert.equal(b1.tasks[0].claimedBy, null) // 翻卡兜底不变
  // 认领位与末条留档 id 不一致（状态可疑）→ 不动
  const b2 = mkBoard([mkTask({ id: 'mm1', status: 'in-progress', claimedBy: 'child-B', runs: [{ role: 'worker', id: 'child-A', outcome: 'running', continuable: true }] })])
  const h2 = mkRpcHarness(b2, {}, { rootForSession: () => ({ id: FULL_SID }) }, ctxX)
  const r2 = await h2['terminate-agent']({ taskId: 'mm1' })
  assert.equal(r2.terminated, 'no-active-run'); assert.deepEqual(interrupts, [])
  // spawn-pending 在途占位：无会话可杀（在途 spawn 归落闸重验弃权路径管，集成场景 k/m 锁定）
  const b3 = mkBoard([mkTask({ id: 'sp1', status: 'in-progress', claimedBy: 'spawn-pending' })])
  const h3 = mkRpcHarness(b3, {}, { rootForSession: () => ({ id: FULL_SID }) }, ctxX)
  const r3 = await h3['terminate-agent']({ taskId: 'sp1' })
  assert.equal(r3.terminated, 'no-active-run'); assert.deepEqual(interrupts, [])
})

test('假杀根修②a：有 rec 的 continuable terminate，interrupt 抛错 → err 通知 + healthHint（不再静默跳过）', async () => {
  const sysNotes = []
  const board = mkTermBoard('kf1', 'child-live')
  const runs = { [FULL_SID]: { 'kf1': { id: 'child-live', childId: 'child-live', continuable: true, ran: true, run: null, role: 'worker', taskId: 'kf1', startedAt: Date.now(), model: '', settled: false } } }
  const h = mkRpcHarness(board, runs, {
    rootForSession: () => ({ id: FULL_SID }),
    pushSysNote: (sid, text) => sysNotes.push(text),
  }, { subagents: { interrupt: () => { throw new Error('UNAUTHORIZED: not a live descendant') } } })
  const r = await h['terminate-agent']({ taskId: 'kf1' })
  assert.equal(r.ok, true); assert.equal(r.terminated, 'worker:kf1')
  assert.equal(r.killUnconfirmed, 'child-live')
  assert.equal(sysNotes.length, 1)
  assert.match(sysNotes[0], /终止未生效/); assert.match(sysNotes[0], /interrupt 抛错/)
  assert.match(sysNotes[0], /interrupt_agent（agent_id: child-live）补刀/)
  assert.deepEqual(h.__state.poolHealth[FULL_SID].terminateFailNote.taskId, 'kf1')
  assert.equal(h.__state.poolHealth[FULL_SID].terminateFailNote.childId, 'child-live')
})

test('假杀根修②b：无 rec 补杀后核验未过（子会话仍在 listChildren 目录）→ err 通知 + healthHint', async () => {
  const sysNotes = [], interrupts = []
  const board = mkTermBoard('kf2', 'child-z2')
  const h = mkRpcHarness(board, {}, {
    rootForSession: () => ({ id: FULL_SID }),
    pushSysNote: (sid, text) => sysNotes.push(text),
  }, { subagents: { interrupt: (id) => interrupts.push(id), listChildren: async () => [{ id: 'child-z2', mode: 'continuable' }] } })
  const r = await h['terminate-agent']({ taskId: 'kf2' })
  assert.equal(r.ok, true); assert.equal(r.terminated, 'worker:kf2')
  assert.deepEqual(interrupts, ['child-z2']) // 补杀信号已发
  assert.equal(r.killUnconfirmed, 'child-z2')
  assert.equal(sysNotes.length, 1); assert.match(sysNotes[0], /核验未过/)
  assert.equal(h.__state.poolHealth[FULL_SID].terminateFailNote.taskId, 'kf2')
})

test('假杀根修②c：宿主无 interrupt/listChildren 能力 → 补杀按未生效可见化（老宿主不再静默）', async () => {
  const sysNotes = []
  const board = mkTermBoard('kf3', 'child-z3')
  const h = mkRpcHarness(board, {}, { rootForSession: () => ({ id: FULL_SID }), pushSysNote: (sid, text) => sysNotes.push(text) }, { subagents: {} })
  const r = await h['terminate-agent']({ taskId: 'kf3' })
  assert.equal(r.ok, true)
  assert.equal(r.killUnconfirmed, 'child-z3')
  assert.equal(sysNotes.length, 1); assert.match(sysNotes[0], /无 interrupt 能力或无活 root/)
  assert.equal(h.__state.poolHealth[FULL_SID].terminateFailNote.taskId, 'kf3')
})

test('假杀根修③：hold=true → 同一次落账 pending+assignMode=manual 原子完成（pickDispatch 不再选中本卡）', async () => {
  // 工具通道（task_terminate hold:true）
  const board = mkBoard([mkTask({ id: 'hd1', status: 'in-progress', claimedBy: 'run-w', runs: [{ role: 'worker', id: 'run-w', outcome: 'running' }] })])
  const runs = { [FULL_SID]: { 'hd1': { id: 'run-w', run: { dispose: async () => {} }, role: 'worker', taskId: 'hd1', startedAt: Date.now(), model: '', settled: false } } }
  const h = mkRpcHarness(board, runs)
  const r = await h.__tools['task_terminate'].execute({ taskId: 'hd1', hold: true }, {})
  assert.equal(r.ok, true)
  const t = board.tasks[0]
  assert.equal(t.status, 'pending'); assert.equal(t.claimedBy, null)
  assert.equal(t.assignMode, 'manual') // 同一 mutateLocked 连带转手动——终止+停派原子
  assert.ok(t.history.some(function (x) { return /hold：连带转手动派发/.test(x.note || '') }))
  assert.equal(core.pickDispatch({ tasks: [t] }, 1, 0, null).pendings.length, 0, 'manual 闸门：下轮 poolCycle 不派')
  // RPC 通道（terminate-agent hold:true）同口径
  const boardR = mkBoard([mkTask({ id: 'hd3', status: 'in-progress', claimedBy: 'run-w3', runs: [{ role: 'worker', id: 'run-w3', outcome: 'running' }] })])
  const runsR = { [FULL_SID]: { 'hd3': { id: 'run-w3', run: { dispose: async () => {} }, role: 'worker', taskId: 'hd3', startedAt: Date.now(), model: '', settled: false } } }
  const hR = mkRpcHarness(boardR, runsR)
  await hR['terminate-agent']({ taskId: 'hd3', hold: true })
  assert.equal(boardR.tasks[0].assignMode, 'manual')
  // 对照：不带 hold 的终止仍回 auto（旧行为逐字不破）→ pickDispatch 照常选中
  const board2 = mkBoard([mkTask({ id: 'hd2', status: 'in-progress', claimedBy: 'run-w2', runs: [{ role: 'worker', id: 'run-w2', outcome: 'running' }] })])
  const runs2 = { [FULL_SID]: { 'hd2': { id: 'run-w2', run: { dispose: async () => {} }, role: 'worker', taskId: 'hd2', startedAt: Date.now(), model: '', settled: false } } }
  const h2 = mkRpcHarness(board2, runs2)
  const r2 = await h2['terminate-agent']({ taskId: 'hd2' })
  assert.equal(r2.ok, true)
  assert.equal(board2.tasks[0].assignMode, 'auto')
  assert.equal(core.pickDispatch({ tasks: [board2.tasks[0]] }, 1, 0, null).pendings.length, 1, '无 hold：回 pending 后照常自动重派')
})

// ===== 纯函数口径：lateVerdictApply wasApproved 判定 =====
test('lateVerdictApply：wasApproved 口径（resolved / archived-from-resolved / archived-from-cancelled）', () => {
  // resolved → approved
  const t1 = mkTask({ id: 'p1', status: 'resolved', verifiedAt: 'x' })
  assert.equal(core.lateVerdictApply(t1, 'rejected', 's', 'c', null, 'at', 'by', true).wasApproved, true)
  // archived 且带 verifiedAt → approved
  const t2 = mkTask({ id: 'p2', status: 'archived', verifiedAt: 'x' })
  assert.equal(core.lateVerdictApply(t2, 'rejected', 's', 'c', null, 'at', 'by', true).wasApproved, true)
  // archived 无 approved 痕迹（从 cancelled 归档）→ 非 approved
  const t3 = mkTask({ id: 'p3', status: 'archived' })
  assert.equal(core.lateVerdictApply(t3, 'rejected', 's', 'c', null, 'at', 'by', true).wasApproved, false)
  // cancelled → 非 approved
  const t4 = mkTask({ id: 'p4', status: 'cancelled' })
  assert.equal(core.lateVerdictApply(t4, 'rejected', 's', 'c', null, 'at', 'by', true).wasApproved, false)
  // approved verdict → lateRejected false
  const t5 = mkTask({ id: 'p5', status: 'resolved', verifiedAt: 'x' })
  const r5 = core.lateVerdictApply(t5, 'approved', 's', 'c', null, 'at', 'by', true)
  assert.equal(r5.lateRejected, false); assert.equal(r5.wasApproved, true)
})
