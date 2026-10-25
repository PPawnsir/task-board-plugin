// ===== 力度路由地基（task-mvnemvf5）：卡级 size/model 字段 + 板级 laneModels 三档路由表 + 四级取模链 =====
// 断言清单（对应任务验收口径）：
//   ① cfg/seed/normalizeBoard 的 laneModels 缺省与脏值归一；存量卡零迁移（不补 size/model）
//   ② set-board-config laneModels 部分合并 + 非法模型拒写（整体不落半截）+ configLog 审计行
//   ③ task_update 工具 + update-task RPC 的 size（枚举校验拒写）/model（合法清单校验，空串=清除）
//   ④ spawnOneShot 四级取模优先级（card→lane→board→parent，桩断言 agentOptions）+ modelSource 留档
//      + badModels 熔断逐跳降级
//   ⑤ get-tasks 透出 laneModels 归一形态
import test from 'node:test'
import assert from 'node:assert/strict'
import { cfg, seed, normalizeBoard } from '../lib/core.mjs'
import { createRpc } from '../lib/rpc.mjs'
import { createDispatch } from '../lib/dispatch.mjs'

var SID = 'session-test-0000-0000-000000000000'
var DEFAULT_LANES = { light: { worker: '', verifier: '' }, standard: { worker: '', verifier: '' }, heavy: { worker: '', verifier: '' } }

// ===== ① cfg/seed/normalizeBoard 缺省与脏值归一 =====
test('地基①：seed/cfg/normalizeBoard 的 laneModels 缺省同形、脏值收敛、存量卡零迁移', function () {
  assert.deepEqual(seed(SID).laneModels, DEFAULT_LANES, 'seed 落三档×双角色全空缺省')
  assert.deepEqual(cfg({}).laneModels, DEFAULT_LANES, '老看板缺字段 → cfg 补全空缺省')
  // 部分键 + 脏值收敛（trim / 非字符串→空串 / 未知档与非对象档位丢弃）
  var c = cfg({ laneModels: { heavy: { worker: ' gsmoma/kimi-k3.1-pro ', verifier: 42 }, light: 'junk', ultra: { worker: 'x/y' } } })
  assert.deepEqual(c.laneModels, { light: { worker: '', verifier: '' }, standard: { worker: '', verifier: '' }, heavy: { worker: 'gsmoma/kimi-k3.1-pro', verifier: '' } })
  // normalizeBoard 读路径兜底
  var d = { version: 12, tasks: [] }
  normalizeBoard(d)
  assert.deepEqual(d.laneModels, DEFAULT_LANES, 'normalizeBoard 归一缺省')
  var d2 = { version: 12, tasks: [], laneModels: { standard: { worker: 'a/b' } } }
  normalizeBoard(d2)
  assert.deepEqual(d2.laneModels.standard, { worker: 'a/b', verifier: '' }, 'normalizeBoard 保留合法槽位')
  // 存量卡零迁移：normalizeBoard 不给任务补 size/model（缺字段=标档语义）
  var d3 = { version: 12, tasks: [{ id: 't1', title: 'T' }] }
  normalizeBoard(d3)
  assert.equal('size' in d3.tasks[0], false)
  assert.equal('model' in d3.tasks[0], false)
})

// ===== RPC harness（与 core.test.mjs mkRpcHandlers 同形，自含一份避免跨测试文件耦合）=====
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
function mkLlmCtx(modelsByProvider) {
  // 对齐宿主 llm 服务契约（listProviders/listModels），与 set-board-config 模型校验测试同款
  return {
    get: function (name) {
      if (name !== 'llm') return null
      return {
        listProviders: function () { return Object.keys(modelsByProvider).map(function (id) { return { id: id, name: id } }) },
        listModels: async function (p) { return modelsByProvider[p] || [] },
      }
    },
  }
}
var MOCK_MODELS = { deepseek: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }], kimi: [{ id: 'kimi-k2' }] }

// ===== ② set-board-config laneModels：部分合并 + 拒写 + 审计 =====
test('地基②：set-board-config laneModels 部分合并 + 非法模型整体拒写 + configLog 审计行', async function () {
  var board = { version: 12, tasks: [], configLog: [], laneModels: JSON.parse(JSON.stringify(DEFAULT_LANES)) }
  board.laneModels.heavy.worker = 'deepseek/deepseek-chat'
  var h = mkRpcHandlers(board, {}, mkLlmCtx(MOCK_MODELS))
  // 部分合并：只给 heavy.verifier → heavy.worker 保留，其他档不动
  var r = await h['set-board-config']({ key: 'laneModels', value: { heavy: { verifier: 'kimi/kimi-k2' } } })
  assert.equal(r.ok, true)
  assert.deepEqual(board.laneModels.heavy, { worker: 'deepseek/deepseek-chat', verifier: 'kimi/kimi-k2' }, '只合显式给出的槽位')
  assert.deepEqual(board.laneModels.light, { worker: '', verifier: '' }, '未给槽位保留现值')
  // configLog 审计行：key='laneModels'，to=合并后全量
  var log = board.configLog[board.configLog.length - 1]
  assert.equal(log.key, 'laneModels')
  assert.deepEqual(log.to, board.laneModels, '审计 to 记合并后全量')
  assert.equal(log.actor, 'tester')
  // 空串=清槽（恢复继承下一级）
  var r2 = await h['set-board-config']({ key: 'laneModels', value: { heavy: { verifier: '' } } })
  assert.equal(r2.ok, true)
  assert.equal(board.laneModels.heavy.verifier, '')
  assert.equal(board.laneModels.heavy.worker, 'deepseek/deepseek-chat')
  // 非法模型整体拒写（不落半截合并结果）
  var before = JSON.stringify(board.laneModels)
  var r3 = await h['set-board-config']({ key: 'laneModels', value: { light: { worker: 'kimi/kimi-k2' }, heavy: { worker: 'kimi/kimi-k3' } } })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /非法模型 id: kimi\/kimi-k3/)
  assert.equal(JSON.stringify(board.laneModels), before, '任一槽位非法 → 整体拒写')
  // 未知档位 / 未知角色键 / 非对象形态 → fail-loud
  var r4 = await h['set-board-config']({ key: 'laneModels', value: { ultra: { worker: 'kimi/kimi-k2' } } })
  assert.equal(r4.ok, false); assert.match(r4.error, /未知档位: ultra/)
  var r5 = await h['set-board-config']({ key: 'laneModels', value: { heavy: { reviewer: 'kimi/kimi-k2' } } })
  assert.equal(r5.ok, false); assert.match(r5.error, /未知角色键: reviewer/)
  var r6 = await h['set-board-config']({ key: 'laneModels', value: 'heavy' })
  assert.equal(r6.ok, false); assert.match(r6.error, /部分合并对象/)
  // llm 缺失（老宿主）降级放行 + 老看板缺 laneModels 字段时以归一缺省为合并基座
  var board2 = { version: 12, tasks: [] }
  var hNo = mkRpcHandlers(board2, {}, { get: function () { return null } })
  var r7 = await hNo['set-board-config']({ key: 'laneModels', value: { light: { worker: 'whatever/display' } } })
  assert.equal(r7.ok, true)
  assert.deepEqual(board2.laneModels.light, { worker: 'whatever/display', verifier: '' })
  assert.deepEqual(board2.laneModels.standard, { worker: '', verifier: '' }, '合并基座带全量形态')
})

// ===== ③ task_update 工具 + update-task RPC：size/model 校验与清除 =====
test('地基③：task_update/update-task 支持 size（枚举拒写）与 model（清单校验，空串=清除）', async function () {
  var board = { version: 12, tasks: [{ id: 't1', title: 'T', description: 'd', status: 'pending', priority: 'medium', tags: [], dependsOn: [], context: { files: [], notes: '' } }] }
  var h = mkRpcHandlers(board, {}, mkLlmCtx(MOCK_MODELS))
  var tu = h.__tools['task_update']
  // size：合法三档落卡
  var r = await tu.execute({ taskId: 't1', size: 'heavy' })
  assert.equal(r.ok, true); assert.equal(board.tasks[0].size, 'heavy')
  // size：非法拒写
  var r2 = await tu.execute({ taskId: 't1', size: 'ultra' })
  assert.equal(r2.ok, false); assert.match(r2.error, /非法 size/); assert.equal(board.tasks[0].size, 'heavy')
  // size：空串清除（删字段=回标档语义）
  var r3 = await tu.execute({ taskId: 't1', size: '' })
  assert.equal(r3.ok, true); assert.equal('size' in board.tasks[0], false)
  // model：合法 id 落卡
  var r4 = await tu.execute({ taskId: 't1', model: 'kimi/kimi-k2' })
  assert.equal(r4.ok, true); assert.equal(board.tasks[0].model, 'kimi/kimi-k2')
  // model：非法 id 拒写
  var r5 = await tu.execute({ taskId: 't1', model: 'kimi/kimi-k3' })
  assert.equal(r5.ok, false); assert.match(r5.error, /非法模型 id/); assert.equal(board.tasks[0].model, 'kimi/kimi-k2')
  // model：空串清除
  var r6 = await tu.execute({ taskId: 't1', model: '' })
  assert.equal(r6.ok, true); assert.equal('model' in board.tasks[0], false)
  // update-task RPC 同口径（双通道）
  var r7 = await h['update-task']({ taskId: 't1', size: 'light', model: 'deepseek/deepseek-chat' })
  assert.equal(r7.ok, true); assert.equal(board.tasks[0].size, 'light'); assert.equal(board.tasks[0].model, 'deepseek/deepseek-chat')
  var r8 = await h['update-task']({ taskId: 't1', size: 'huge' })
  assert.equal(r8.ok, false); assert.match(r8.error, /非法 size/)
  var r9 = await h['update-task']({ taskId: 't1', model: 'bad/id' })
  assert.equal(r9.ok, false); assert.match(r9.error, /非法模型 id/)
  assert.equal(board.tasks[0].model, 'deepseek/deepseek-chat', '拒写不污染卡面')
})

// ===== ④ spawnOneShot 四级取模链（桩断言 agentOptions + modelSource 留档 + 熔断降级）=====
// dispatch harness 与 spawn-activation.test.mjs 同形（mkActivationSubagents 记录 spec）
function mkTask(over) {
  return Object.assign({ id: 't1', title: 'T', description: '', status: 'in-progress', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: 'spawn-pending', claimedAt: null, createdAt: '2026-01-01T00:00:00Z', history: [], messages: [] }, over || {})
}
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
function laneBoard(taskOver, boardOver) {
  return Object.assign({ version: 12, tasks: [mkTask(taskOver)], workerModel: 'bw/board-w', verifierModel: 'bv/board-v', laneModels: { light: { worker: '', verifier: '' }, standard: { worker: '', verifier: '' }, heavy: { worker: 'lw/lane-w', verifier: 'lv/lane-v' } } }, boardOver || {})
}

test('地基④a：四级取模优先级 card→lane→board→parent（agentOptions + run.modelSource 留档）', async function () {
  // card 级最高优先（即便 size 也命中 lane）
  var calls = []
  var b1 = laneBoard({ model: 'cm/card-m', size: 'heavy' })
  var sr = await mkDispatch(b1, { subagents: mkActivationSubagents(calls) }).spawnOneShot(SID, b1.tasks[0], 'worker')
  assert.ok(sr)
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'cm', model: 'card-m' }, '卡级特例直取')
  assert.equal(b1.tasks[0].runs[0].modelSource, 'card')
  assert.equal(sr.modelSource, 'card')
  // lane 级：无卡级特例 + size=heavy → laneModels.heavy.worker
  calls = []
  var b2 = laneBoard({ size: 'heavy' })
  await mkDispatch(b2, { subagents: mkActivationSubagents(calls) }).spawnOneShot(SID, b2.tasks[0], 'worker')
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'lw', model: 'lane-w' }, 'lane 命中 worker 槽')
  assert.equal(b2.tasks[0].runs[0].modelSource, 'lane')
  // verifier 查 lane 的 verifier 槽
  calls = []
  var b2v = laneBoard({ size: 'heavy' })
  await mkDispatch(b2v, { subagents: mkActivationSubagents(calls) }).spawnOneShot(SID, b2v.tasks[0], 'verifier')
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'lv', model: 'lane-v' }, 'verifier 命中 lane verifier 槽')
  assert.equal(b2v.tasks[0].runs[0].modelSource, 'lane')
  // board 级：无 size → 板级 workerModel（现状兜底）
  calls = []
  var b3 = laneBoard({})
  await mkDispatch(b3, { subagents: mkActivationSubagents(calls) }).spawnOneShot(SID, b3.tasks[0], 'worker')
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'bw', model: 'board-w' })
  assert.equal(b3.tasks[0].runs[0].modelSource, 'board')
  // lane 槽空串 = 该跳不命中，降 board
  calls = []
  var b3b = laneBoard({ size: 'light' })
  await mkDispatch(b3b, { subagents: mkActivationSubagents(calls) }).spawnOneShot(SID, b3b.tasks[0], 'worker')
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'bw', model: 'board-w' }, 'lane 空串槽位不命中')
  assert.equal(b3b.tasks[0].runs[0].modelSource, 'board')
  // parent 级：全无覆盖 → 不挂 agentOptions（父模型，现状）
  calls = []
  var b4 = laneBoard({}, { workerModel: '', verifierModel: '' })
  await mkDispatch(b4, { subagents: mkActivationSubagents(calls) }).spawnOneShot(SID, b4.tasks[0], 'worker')
  assert.equal(calls[0].request.agentOptions, undefined)
  assert.equal(b4.tasks[0].runs[0].modelSource, 'parent')
})

test('地基④b：badModels 熔断逐跳降级——命中跳过该候选走下一跳，全熔断回 parent', async function () {
  var origErr = console.error; console.error = function () {} // 压掉熔断降级日志
  try {
    var calls = []
    var bad = {}
    bad[SID + '|cm/card-m'] = true // card 级熔断
    bad[SID + '|lw/lane-w'] = true // lane 级也熔断
    var b = laneBoard({ model: 'cm/card-m', size: 'heavy' })
    await mkDispatch(b, { subagents: mkActivationSubagents(calls) }, { badModels: bad }).spawnOneShot(SID, b.tasks[0], 'worker')
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'bw', model: 'board-w' }, 'card/lane 双熔断降 board')
    assert.equal(b.tasks[0].runs[0].modelSource, 'board')
    // 全链熔断 → parent（不挂 agentOptions）
    calls = []
    bad[SID + '|bw/board-w'] = true
    var b2 = laneBoard({ model: 'cm/card-m', size: 'heavy' })
    await mkDispatch(b2, { subagents: mkActivationSubagents(calls) }, { badModels: bad }).spawnOneShot(SID, b2.tasks[0], 'worker')
    assert.equal(calls[0].request.agentOptions, undefined, '全链熔断回父模型')
    assert.equal(b2.tasks[0].runs[0].modelSource, 'parent')
  } finally { console.error = origErr }
})

// ===== ⑤ get-tasks 透出 laneModels 归一形态 =====
test('地基⑤：get-tasks 透出 laneModels（老看板缺字段透全空缺省，部分落盘透归一形态）', async function () {
  var board = { version: 12, tasks: [] }
  var h = mkRpcHandlers(board)
  var d = await h['get-tasks']({})
  assert.deepEqual(d.laneModels, DEFAULT_LANES, '老看板缺字段透出全空缺省')
  board.laneModels = { heavy: { worker: 'a/b' } }
  var d2 = await h['get-tasks']({})
  assert.deepEqual(d2.laneModels, { light: { worker: '', verifier: '' }, standard: { worker: '', verifier: '' }, heavy: { worker: 'a/b', verifier: '' } }, '脏形态读出即归一')
})

