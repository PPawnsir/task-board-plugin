// ===== 档位动态修正（task-mvnesb3j）：board_report.sizeHint 自报 + 下次派发生效 =====
// 断言清单（对应任务验收口径）：
//   ① sizeHint 枚举校验 + 状态门禁（resolved/archived/pending 拒收）
//   ② 同值幂等跳过（零写入零留痕；缺省=standard 语义）
//   ③ 不同才写入：t.size + history + messages 双留痕（审计：谁在哪次 run 把档位改成什么）
//   ④ verifier 侧受理（verifying 卡 kind=progress 专报通道；判定来源记 Verifier）
//   ⑤ 生效链路钉死：改 size → 下一次 spawnOneShot 换新档模型（零接线确认；worker 重试与 verifier 派发同链）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRpc } from '../lib/rpc.mjs'
import { createDispatch } from '../lib/dispatch.mjs'

var SID = 'session-test-0000-0000-000000000000'

// ===== RPC harness（与 lane-models.test.mjs 同形，自含一份避免跨测试文件耦合）=====
function mkRpcHandlers(board, extra, ctxExtra) {
  var state = { handlers: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {} }
  var tools = {}
  var ctx = Object.assign({ tools: { register: function (t) { tools[t.name] = t } }, effect: function () {}, webServer: { register: function () { return function () {} } } }, ctxExtra || {})
  var deps = Object.assign({
    getActorId: function () { return 'tester' }, resolveRoot: function (x) { return x },
    toolSessionId: function () { return SID }, rpcSessionId: function () { return SID },
    rootForSession: function () { return null }, deriveWorkMode: function () { return 'solo' }, runsFor: function () { return [] },
    rt: async function () { return board }, mutateLocked: async function (sid, fn) { return fn(board) },
    maybeNotify: function () {}, notifyTaskDone: function () {},
    spawnOneShot: function () {}, accumulateRunUsage: function () {}, readContextPack: async function () { return null },
    pushSysNote: function () {}, sessionCwd: function () { return '' },
  }, extra || {})
  createRpc(ctx, state, deps)
  state.handlers.__tools = tools
  return state.handlers
}

function mkTask(over) {
  return Object.assign({ id: 't1', title: 'T', description: '', status: 'in-progress', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: 'spawn-pending', claimedAt: null, createdAt: '2026-01-01T00:00:00Z', history: [], messages: [] }, over || {})
}

// ===== ① 枚举校验 + 状态门禁 =====
test('sizeHint①：非法枚举值拒收；resolved/archived/pending 卡拒收（仅 in-progress/verifying 受理）', async function () {
  var board = { version: 12, tasks: [mkTask()] }
  var br = mkRpcHandlers(board).__tools['board_report']
  // 非法枚举值（in-progress 卡也拒，校验先于一切）
  var r = await br.execute({ taskId: 't1', kind: 'progress', question: 'q', sizeHint: 'ultra' })
  assert.equal(r.ok, false)
  assert.match(r.error, /非法 sizeHint/)
  assert.equal('size' in board.tasks[0], false, '非法值不落卡')
  // resolved 拒收
  board.tasks[0].status = 'resolved'
  var r2 = await br.execute({ taskId: 't1', kind: 'progress', sizeHint: 'heavy' })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /仅 in-progress\/verifying 受理/)
  // archived 拒收
  board.tasks[0].status = 'archived'
  var r3 = await br.execute({ taskId: 't1', kind: 'progress', sizeHint: 'heavy' })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /仅 in-progress\/verifying 受理/)
  // pending 拒收（未在执行的卡没有「执行中发现」的语义）
  board.tasks[0].status = 'pending'
  var r4 = await br.execute({ taskId: 't1', kind: 'progress', sizeHint: 'heavy' })
  assert.equal(r4.ok, false)
  assert.match(r4.error, /仅 in-progress\/verifying 受理/)
  assert.equal('size' in board.tasks[0], false, '三次拒收均不落卡')
  assert.equal(board.tasks[0].messages.length, 0, '拒收零留痕')
})

// ===== ② 同值幂等 =====
test('sizeHint②：同值幂等——与现档相同跳过（零 history/messages 留痕；缺省=standard 语义）', async function () {
  var board = { version: 12, tasks: [mkTask()] } // 无 size 字段 = standard 语义
  var br = mkRpcHandlers(board).__tools['board_report']
  var r = await br.execute({ taskId: 't1', kind: 'progress', question: '档位与实际相符', sizeHint: 'standard' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.sizeHint, { skipped: true, size: 'standard' })
  assert.equal('size' in board.tasks[0], false, '同值不写字段（保持缺省标档语义）')
  assert.equal(board.tasks[0].history.length, 0, '幂等跳过零 history')
  assert.equal(board.tasks[0].messages.filter(function (m) { return m.kind === 'size-hint' }).length, 0, '幂等跳过零 size-hint 消息')
  // 显式 standard 档再报 standard 同样幂等
  board.tasks[0].size = 'standard'
  var r2 = await br.execute({ taskId: 't1', kind: 'progress', sizeHint: 'standard' })
  assert.equal(r2.ok, true)
  assert.deepEqual(r2.sizeHint, { skipped: true, size: 'standard' })
  assert.equal(board.tasks[0].history.length, 0, '显式档同值同样零留痕')
})

// ===== ③ 双留痕 =====
test('sizeHint③：不同才写入——t.size + history + messages 双留痕（谁在哪次 run 把档位改成什么）', async function () {
  var board = { version: 12, tasks: [mkTask()] }
  var br = mkRpcHandlers(board).__tools['board_report']
  var r = await br.execute({ taskId: 't1', kind: 'progress', question: '实际力度跨模块', sizeHint: 'heavy' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.sizeHint, { applied: true, from: 'standard', to: 'heavy' })
  var t = board.tasks[0]
  assert.equal(t.size, 'heavy')
  // history 留痕：actor=上报者 + note 记档位变迁与判定来源
  var hLast = t.history[t.history.length - 1]
  assert.equal(hLast.actor, 'tester')
  assert.equal(hLast.from, 'in-progress')
  assert.equal(hLast.to, 'in-progress')
  assert.match(hLast.note, /档位自修正：standard→heavy（Worker 执行中判定）/)
  // messages 同款留痕
  var sm = t.messages.filter(function (m) { return m.kind === 'size-hint' })
  assert.equal(sm.length, 1)
  assert.match(sm[0].text, /standard→heavy/)
  assert.equal(sm[0].by, 'tester')
  // 与 progress 通道叠加不互斥：进展消息照常落
  assert.ok(t.lastProgress && t.lastProgress.text.indexOf('实际力度跨模块') >= 0)
  // 再降档：heavy→light 同样留痕（幂等闸门只挡同值）；纯 sizeHint 不带 question 也受理
  var r2 = await br.execute({ taskId: 't1', kind: 'progress', sizeHint: 'light' })
  assert.equal(r2.ok, true)
  assert.deepEqual(r2.sizeHint, { applied: true, from: 'heavy', to: 'light' })
  assert.equal(t.size, 'light')
  assert.equal(t.messages.filter(function (m) { return m.kind === 'size-hint' }).length, 2)
  assert.match(t.history[t.history.length - 1].note, /档位自修正：heavy→light/)
})

// ===== ④ verifier 侧受理 =====
test('sizeHint④：verifier 侧受理——verifying 卡 kind=progress 专报通道（判定来源记 Verifier）', async function () {
  var board = { version: 12, tasks: [mkTask({ status: 'verifying', size: 'heavy' })] }
  var br = mkRpcHandlers(board).__tools['board_report']
  var r = await br.execute({ taskId: 't1', kind: 'progress', sizeHint: 'standard' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.sizeHint, { applied: true, from: 'heavy', to: 'standard' })
  var t = board.tasks[0]
  assert.equal(t.size, 'standard')
  assert.match(t.history[t.history.length - 1].note, /档位自修正：heavy→standard（Verifier 验收中判定）/)
  assert.equal(t.messages.filter(function (m) { return m.kind === 'size-hint' }).length, 1)
  assert.match(t.messages.filter(function (m) { return m.kind === 'size-hint' })[0].text, /Verifier 验收中判定/)
  // parity：verifying 卡不带 sizeHint 的 progress 仍按原门禁拒收（专报通道只受理 sizeHint）
  var r2 = await br.execute({ taskId: 't1', kind: 'progress', question: 'x' })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /not in-progress/)
  // parity：verifying 卡同值幂等同样成立
  var r3 = await br.execute({ taskId: 't1', kind: 'progress', sizeHint: 'standard' })
  assert.equal(r3.ok, true)
  assert.deepEqual(r3.sizeHint, { skipped: true, size: 'standard' })
  assert.equal(t.messages.filter(function (m) { return m.kind === 'size-hint' }).length, 1, '幂等不重复留痕')
})

// ===== ⑤ 生效链路：spawnOneShot 每次 spawn 现读 t.size——改 size 后下一次 spawn 换新档模型 =====
// 断言「改 size → 下一次 spawn 用新档模型」零接线：spawnOneShot 的取模链现读传入任务快照的 t.size，
// 重试/续跑/verifier 派发共用 spawnOneShot，故 sizeHint 落卡后对下一次 spawn 全部自动生效。
// dispatch harness 与 lane-models.test.mjs ④同形（mkActivationSubagents 记录 spec）。
function mkDispatch(board, ctxOver, stateOver) {
  return createDispatch(
    Object.assign({ fs: {}, effect: function () {}, get: function () { return null } }, ctxOver || {}),
    Object.assign({ knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} }, stateOver || {}),
    {
      rt: async function () { return board },
      wt: async function () {},
      mutateLocked: async function (sid, fn) { return fn(board) },
      kickCycle: function () {},
      rootForSession: function () { return { id: SID } },
      sessionCwd: function () { return '' }, withTimeout: function (p) { return p }, runsFor: function () { return ({}) }, feedbackOn: function () { return true },
      pushSysNote: function () {}, maybeNotify: function () {}, notifyTaskDone: function () {},
    })
}
function mkActivationSubagents(calls) {
  return {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function (spec) {
      calls.push(spec)
      return { childId: 'child-' + calls.length, messageId: 'msg-' + calls.length, result: new Promise(function () {}), dispose: async function () {} }
    },
    // 刻意不带 start/startContinuable：误走旧路径必然 TypeError 炸出
  }
}

test('sizeHint⑤：改 size → 下一次 spawn 用新档模型（worker 重试/verifier 派发同链路，零接线）', async function () {
  var task = mkTask({}) // in-progress + claimedBy='spawn-pending'（worker spawn 闸门占位形态），无 size = 标档语义
  var board = Object.assign({ version: 12, tasks: [task], workerModel: 'bw/board-w', verifierModel: 'bv/board-v', laneModels: { light: { worker: '', verifier: '' }, standard: { worker: '', verifier: '' }, heavy: { worker: 'lw/lane-w', verifier: 'lv/lane-v' } } })
  // 第一次 spawn：无 size（standard lane 空串不命中）→ 落板级 workerModel
  var calls1 = []
  var sr1 = await mkDispatch(board, { subagents: mkActivationSubagents(calls1) }).spawnOneShot(SID, task, 'worker')
  assert.ok(sr1)
  assert.deepEqual(calls1[0].request.agentOptions, { provider: 'bw', model: 'board-w' }, '首 spawn 标档落板级模型')
  assert.equal(sr1.modelSource, 'board')
  // sizeHint 落卡（Worker 执行中自修正 standard→heavy）
  task.size = 'heavy'
  // 第二次 spawn（失败重试/续跑同链路）：现读 t.size → 命中 heavy lane
  var calls2 = []
  var sr2 = await mkDispatch(board, { subagents: mkActivationSubagents(calls2) }).spawnOneShot(SID, task, 'worker')
  assert.ok(sr2)
  assert.deepEqual(calls2[0].request.agentOptions, { provider: 'lw', model: 'lane-w' }, '下一次 spawn 自动吃新档')
  assert.equal(sr2.modelSource, 'lane')
  assert.notDeepEqual(calls2[0].request.agentOptions, calls1[0].request.agentOptions, '档位修正后模型确实切换')
  // verifier 派发同链路：也现读新档（验收驳回重派场景的下一任 Worker/Verifier 档位同此口径）
  var calls3 = []
  var sr3 = await mkDispatch(board, { subagents: mkActivationSubagents(calls3) }).spawnOneShot(SID, task, 'verifier')
  assert.ok(sr3)
  assert.deepEqual(calls3[0].request.agentOptions, { provider: 'lv', model: 'lane-v' }, 'verifier 派发同吃新档')
  assert.equal(sr3.modelSource, 'lane')
})
