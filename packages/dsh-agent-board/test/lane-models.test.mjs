// ===== 力度路由地基（task-mvnemvf5）：卡级 size/model 字段 + 板级 laneModels 三档路由表 + 四级取模链 =====
// ===== 槽位有序数组化（task-mvnxckhq）：槽位 string → string[]（有序=同档优先序，第一位=首选）=====
// 断言清单（对应任务验收口径）：
//   ① cfg/seed/normalizeBoard 的 laneModels 缺省与脏值归一——归一化三形态（字符串→单元素数组 /
//      数组逐项滤脏保序 / 脏值→空数组）；存量卡零迁移（不补 size/model）；老看板单字符串槽位读入即归一
//   ② set-board-config laneModels 部分合并 + 槽位值 string|string[]（数组逐项校验，任一非法整包拒写）
//      + 非法模型拒写（整体不落半截）+ configLog 审计行
//   ③ task_update 工具 + update-task RPC 的 size（枚举校验拒写）/model（合法清单校验，空串=清除）
//   ④ spawnOneShot 四级取模优先级（card→lane→board→parent，桩断言 agentOptions）+ modelSource 留档
//      + badModels 熔断逐跳降级；④c 槽内按序取首个健康（首选冷却/熔断→次选赢）；槽内全病→fallback/降档链照旧
//   ⑤ get-tasks 透出 laneModels 归一形态（槽位数组）
import test from 'node:test'
import assert from 'node:assert/strict'
import { cfg, seed, normalizeBoard } from '../lib/core.mjs'
import { createRpc } from '../lib/rpc.mjs'
import { createDispatch } from '../lib/dispatch.mjs'

var SID = 'session-test-0000-0000-000000000000'
var DEFAULT_LANES = { light: { worker: [], verifier: [] }, standard: { worker: [], verifier: [] }, heavy: { worker: [], verifier: [] } }

// ===== ① cfg/seed/normalizeBoard 缺省与脏值归一（槽位=有序数组三形态）=====
test('地基①：seed/cfg/normalizeBoard 的 laneModels 缺省同形（空数组）、归一化三形态、存量卡零迁移', function () {
  assert.deepEqual(seed(SID).laneModels, DEFAULT_LANES, 'seed 落三档×双角色全空数组缺省')
  assert.deepEqual(cfg({}).laneModels, DEFAULT_LANES, '老看板缺字段 → cfg 补全空数组缺省')
  // 归一化三形态（task-mvnxckhq）：
  //   形态1 字符串 → 单元素数组（trim）——老版本数据零迁移；空串 → 空数组（=继承下一级，与旧空串语义逐字一致）
  //   形态2 数组 → 逐项滤脏保序（非字符串项丢弃 / trim / 空串项丢弃）
  //   形态3 脏值（非对象档 / 非串非数组槽位 / 未知档）→ 同形空数组
  var c = cfg({ laneModels: { heavy: { worker: ' gsmoma/kimi-k3.1-pro ', verifier: 42 }, light: 'junk', ultra: { worker: 'x/y' } } })
  assert.deepEqual(c.laneModels, { light: { worker: [], verifier: [] }, standard: { worker: [], verifier: [] }, heavy: { worker: ['gsmoma/kimi-k3.1-pro'], verifier: [] } }, '字符串→单元素数组 + 槽位脏值→空数组')
  var cArr = cfg({ laneModels: { standard: { worker: [' a/b ', 42, '', null, 'c/d'], verifier: ' v/x ' }, heavy: { worker: '' } } })
  assert.deepEqual(cArr.laneModels.standard, { worker: ['a/b', 'c/d'], verifier: ['v/x'] }, '数组逐项滤脏保序（第一位=首选）')
  assert.deepEqual(cArr.laneModels.heavy.worker, [], '空串→空数组（清槽/继承下一级）')
  // normalizeBoard 读路径兜底
  var d = { version: 12, tasks: [] }
  normalizeBoard(d)
  assert.deepEqual(d.laneModels, DEFAULT_LANES, 'normalizeBoard 归一缺省')
  var d2 = { version: 12, tasks: [], laneModels: { standard: { worker: 'a/b' } } }
  normalizeBoard(d2)
  assert.deepEqual(d2.laneModels.standard, { worker: ['a/b'], verifier: [] }, 'normalizeBoard 老单字符串槽位→单元素数组（零迁移）')
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

// ===== ② set-board-config laneModels：部分合并 + 槽位 string|string[] + 逐项拒写 + 审计 =====
test('地基②：set-board-config laneModels 部分合并 + 槽位值字符串/数组 + 非法整体拒写 + configLog 审计行', async function () {
  var board = { version: 12, tasks: [], configLog: [], laneModels: JSON.parse(JSON.stringify(DEFAULT_LANES)) }
  board.laneModels.heavy.worker = ['deepseek/deepseek-chat']
  var h = mkRpcHandlers(board, {}, mkLlmCtx(MOCK_MODELS))
  // 部分合并：只给 heavy.verifier（字符串→单元素数组落盘）→ heavy.worker 保留，其他档不动
  var r = await h['set-board-config']({ key: 'laneModels', value: { heavy: { verifier: 'kimi/kimi-k2' } } })
  assert.equal(r.ok, true)
  assert.deepEqual(board.laneModels.heavy, { worker: ['deepseek/deepseek-chat'], verifier: ['kimi/kimi-k2'] }, '只合显式给出的槽位（字符串归一为单元素数组）')
  assert.deepEqual(board.laneModels.light, { worker: [], verifier: [] }, '未给槽位保留现值')
  // configLog 审计行：key='laneModels'，to=合并后全量
  var log = board.configLog[board.configLog.length - 1]
  assert.equal(log.key, 'laneModels')
  assert.deepEqual(log.to, board.laneModels, '审计 to 记合并后全量')
  assert.equal(log.actor, 'tester')
  // 数组写入（同档优先序）：逐项 trim 保序落盘（第一位=首选）+ 审计行
  var rArr = await h['set-board-config']({ key: 'laneModels', value: { standard: { worker: [' kimi/kimi-k2 ', 'deepseek/deepseek-reasoner'] } } })
  assert.equal(rArr.ok, true)
  assert.deepEqual(board.laneModels.standard.worker, ['kimi/kimi-k2', 'deepseek/deepseek-reasoner'], '数组写入逐项 trim 保序')
  var logArr = board.configLog[board.configLog.length - 1]
  assert.equal(logArr.key, 'laneModels')
  assert.deepEqual(logArr.to.standard.worker, ['kimi/kimi-k2', 'deepseek/deepseek-reasoner'], '数组写入落审计行（to=归一后实际落盘值）')
  // 空串/空数组=清槽（恢复继承下一级）
  var r2 = await h['set-board-config']({ key: 'laneModels', value: { heavy: { verifier: '' } } })
  assert.equal(r2.ok, true)
  assert.deepEqual(board.laneModels.heavy.verifier, [], '空串→空数组清槽')
  assert.deepEqual(board.laneModels.heavy.worker, ['deepseek/deepseek-chat'])
  var r2b = await h['set-board-config']({ key: 'laneModels', value: { standard: { worker: [] } } })
  assert.equal(r2b.ok, true)
  assert.deepEqual(board.laneModels.standard.worker, [], '空数组=清槽')
  // 非法模型整体拒写（不落半截合并结果）——字符串形态
  var before = JSON.stringify(board.laneModels)
  var r3 = await h['set-board-config']({ key: 'laneModels', value: { light: { worker: 'kimi/kimi-k2' }, heavy: { worker: 'kimi/kimi-k3' } } })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /非法模型 id: kimi\/kimi-k3/)
  assert.equal(JSON.stringify(board.laneModels), before, '任一槽位非法 → 整体拒写')
  // 数组形态逐项校验：任一非法项 → 整包拒写
  var r3b = await h['set-board-config']({ key: 'laneModels', value: { standard: { worker: ['kimi/kimi-k2', 'kimi/kimi-k3'] } } })
  assert.equal(r3b.ok, false)
  assert.match(r3b.error, /非法模型 id: kimi\/kimi-k3/)
  assert.equal(JSON.stringify(board.laneModels), before, '数组任一项非法 → 整包拒写')
  // 数组脏项 fail-loud：非字符串项 / 空串项（清槽请传 [] 或 ''）
  var r3c = await h['set-board-config']({ key: 'laneModels', value: { standard: { worker: ['kimi/kimi-k2', 42] } } })
  assert.equal(r3c.ok, false); assert.match(r3c.error, /laneModels\.standard\.worker\[1\] 需为字符串/)
  var r3d = await h['set-board-config']({ key: 'laneModels', value: { standard: { worker: ['  '] } } })
  assert.equal(r3d.ok, false); assert.match(r3d.error, /为空串/)
  assert.equal(JSON.stringify(board.laneModels), before, '脏项拒写不污染现值')
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
  assert.deepEqual(board2.laneModels.light, { worker: ['whatever/display'], verifier: [] })
  assert.deepEqual(board2.laneModels.standard, { worker: [], verifier: [] }, '合并基座带全量形态')
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

// ===== ④c 槽位有序数组（task-mvnxckhq 同档优先序）：按序取首个健康；槽内全病 → fallback/降档链照旧 =====
// 偏好序非故障序：槽内第一位=首选，按序取第一个「不过 badModels 熔断、不在 modelCooldown 冷却」的模型；
// 槽内全病 → 首项代表入链，由既有熔断/冷却分支照旧消费 fallbackModels → 降档 → parent（既有链逐字不动）。
function laneArrBoard(taskOver, laneArr, boardOver) {
  // 档位槽以**数组形态**落板（有序=偏好序，第一位=首选）；其余与 laneBoard 同形
  var lm = { light: { worker: [], verifier: [] }, standard: { worker: [], verifier: [] }, heavy: { worker: [], verifier: [] } }
  for (var k in (laneArr || {})) lm[k] = laneArr[k]
  return Object.assign({ version: 12, tasks: [mkTask(taskOver)], workerModel: 'bw/board-w', verifierModel: 'bv/board-v', laneModels: lm }, boardOver || {})
}

test('地基④c-1：槽内有序——首选健康取首选（modelSource=lane）；老单字符串槽位行为逐字不变（零迁移）', async function () {
  // 数组槽：首选健康 → 首选赢
  var calls = []
  var b1 = laneArrBoard({ size: 'heavy' }, { heavy: { worker: ['lw/first', 'lw/second'], verifier: [] } })
  var sr = await mkDispatch(b1, { subagents: mkActivationSubagents(calls) }).spawnOneShot(SID, b1.tasks[0], 'worker')
  assert.ok(sr)
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'lw', model: 'first' }, '首选健康 → 首选')
  assert.equal(sr.modelSource, 'lane')
  assert.equal(b1.tasks[0].runs[0].modelSource, 'lane', 'modelSource 语义不变（lane）')
  // 零迁移：老看板单字符串槽位（normalizeLaneSlot 归一为单元素数组）→ 取模结果与旧形态逐字一致
  calls = []
  var b2 = laneBoard({ size: 'heavy' }) // laneBoard heavy.worker='lw/lane-w' 单字符串老形态
  await mkDispatch(b2, { subagents: mkActivationSubagents(calls) }).spawnOneShot(SID, b2.tasks[0], 'worker')
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'lw', model: 'lane-w' }, '老单字符串槽位直取（零迁移）')
  assert.equal(b2.tasks[0].runs[0].modelSource, 'lane')
})

test('地基④c-2：首选冷却 → 次选赢（按序取首个健康，不降级不绕链）', async function () {
  var calls = []
  var b = laneArrBoard({ size: 'heavy' }, { heavy: { worker: ['lw/first', 'lw/second'], verifier: [] } })
  var state = { modelCooldown: { 'lw/first': Date.now() + 3600000 } } // 首选冷却 1h，次选健康
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(b, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, b.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'lw', model: 'second' }, '首选冷却 → 次选赢')
    assert.equal(sr.modelSource, 'lane', '仍记 lane 跳（不走冷却降档）')
    assert.equal((b.tasks[0].messages || []).filter(function (m) { return m.kind === 'fallback' || m.kind === 'cooldown' }).length, 0, '无 fallback/降档留痕')
  } finally { console.error = origErr }
})

test('地基④c-3：首选熔断 → 次选赢（健康双闸同规）；verifier 列同规则', async function () {
  var origErr = console.error; console.error = function () {}
  try {
    var calls = []
    var b = laneArrBoard({ size: 'heavy' }, { heavy: { worker: ['lw/first', 'lw/second'], verifier: [] } })
    var bad = {}; bad[SID + '|lw/first'] = true // 首选熔断
    var sr = await mkDispatch(b, { subagents: mkActivationSubagents(calls) }, { badModels: bad }).spawnOneShot(SID, b.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'lw', model: 'second' }, '首选熔断 → 次选赢')
    assert.equal(sr.modelSource, 'lane')
    // verifier 列同规则：verifier 槽首选冷却 → 次选赢
    var calls2 = []
    var b2 = laneArrBoard({ size: 'heavy' }, { heavy: { worker: [], verifier: ['lv/first', 'lv/second'] } })
    var sr2 = await mkDispatch(b2, { subagents: mkActivationSubagents(calls2) }, { modelCooldown: { 'lv/first': Date.now() + 3600000 } }).spawnOneShot(SID, b2.tasks[0], 'verifier')
    assert.ok(sr2)
    assert.deepEqual(calls2[0].request.agentOptions, { provider: 'lv', model: 'second' }, 'verifier 槽首选冷却 → 次选赢')
    assert.equal(sr2.modelSource, 'lane')
  } finally { console.error = origErr }
})

test('地基④c-4：槽内全病（冷却）→ fallback 链照旧消费；无 fallback → C5 降档链照旧', async function () {
  var origErr = console.error; console.error = function () {}
  try {
    // 形态1：槽内全冷却 + 有备用链 → 切首个健康备用（与单槽冷却同口径，既有链逐字不动）
    var calls = []
    var b1 = laneArrBoard({ size: 'heavy' }, { heavy: { worker: ['lw/first', 'lw/second'], verifier: [] } }, { fallbackModels: ['fb/fb-a'] })
    var st1 = { modelCooldown: { 'lw/first': Date.now() + 3600000, 'lw/second': Date.now() + 3600000 } }
    var sr1 = await mkDispatch(b1, { subagents: mkActivationSubagents(calls) }, st1).spawnOneShot(SID, b1.tasks[0], 'worker')
    assert.ok(sr1)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'fb', model: 'fb-a' }, '槽内全病 → fallback 链照旧消费')
    assert.equal(sr1.modelSource, 'fallback')
    var fb1 = (b1.tasks[0].messages || []).filter(function (m) { return m.kind === 'fallback' })
    assert.equal(fb1.length, 1, '切备用留痕照旧')
    // 形态2：槽内全冷却 + 无备用链 → C5 降档链照旧（standard 槽命中，modelSource=cooldown-downgrade）
    var calls2 = []
    var b2 = laneArrBoard({ size: 'heavy' }, { heavy: { worker: ['lw/first', 'lw/second'], verifier: [] }, standard: { worker: ['sw/std-w'], verifier: [] } })
    var st2 = { modelCooldown: { 'lw/first': Date.now() + 3600000, 'lw/second': Date.now() + 3600000 } }
    var sr2 = await mkDispatch(b2, { subagents: mkActivationSubagents(calls2) }, st2).spawnOneShot(SID, b2.tasks[0], 'worker')
    assert.ok(sr2)
    assert.deepEqual(calls2[0].request.agentOptions, { provider: 'sw', model: 'std-w' }, '无备用 → 降档链照旧')
    assert.equal(sr2.modelSource, 'cooldown-downgrade')
  } finally { console.error = origErr }
})

test('地基④c-5：槽内全病（熔断）→ 无备用降下一跳照旧（board）', async function () {
  var origErr = console.error; console.error = function () {}
  try {
    var calls = []
    var b = laneArrBoard({ size: 'heavy' }, { heavy: { worker: ['lw/first', 'lw/second'], verifier: [] } })
    var bad = {}; bad[SID + '|lw/first'] = true; bad[SID + '|lw/second'] = true // 槽内全熔断
    var sr = await mkDispatch(b, { subagents: mkActivationSubagents(calls) }, { badModels: bad }).spawnOneShot(SID, b.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'bw', model: 'board-w' }, '槽内全熔断无备用 → 降下一跳（board）')
    assert.equal(sr.modelSource, 'board')
  } finally { console.error = origErr }
})

test('地基④c-6：降档链目标槽同按序取首个健康（降档槽首选冷却 → 该槽次选赢）', async function () {
  var origErr = console.error; console.error = function () {}
  try {
    var calls = []
    var b = laneArrBoard({ size: 'heavy' }, {
      heavy: { worker: ['hw/heavy-w'], verifier: [] },
      standard: { worker: ['sw/a', 'sw/b'], verifier: [] },
    })
    var st = { modelCooldown: { 'hw/heavy-w': Date.now() + 3600000, 'sw/a': Date.now() + 3600000 } } // 原档冷却 + 降档槽首选冷却
    var sr = await mkDispatch(b, { subagents: mkActivationSubagents(calls) }, st).spawnOneShot(SID, b.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'sw', model: 'b' }, '降档槽首选冷却 → 该槽次选赢')
    assert.equal(sr.modelSource, 'cooldown-downgrade')
  } finally { console.error = origErr }
})

// ===== ⑤ get-tasks 透出 laneModels 归一形态 =====
test('地基⑤：get-tasks 透出 laneModels（老看板缺字段透全空数组缺省，部分落盘透归一形态）', async function () {
  var board = { version: 12, tasks: [] }
  var h = mkRpcHandlers(board)
  var d = await h['get-tasks']({})
  assert.deepEqual(d.laneModels, DEFAULT_LANES, '老看板缺字段透出全空数组缺省')
  board.laneModels = { heavy: { worker: 'a/b' } } // 老落盘单字符串形态
  var d2 = await h['get-tasks']({})
  assert.deepEqual(d2.laneModels, { light: { worker: [], verifier: [] }, standard: { worker: [], verifier: [] }, heavy: { worker: ['a/b'], verifier: [] } }, '老/脏形态读出即归一（字符串→单元素数组）')
})

// ===== 备用模型链（task-mvnqxlpn）：板级 fallbackModels 有序链（额度到顶跨供应商切换）=====
// 原形事故：2026-10-24 glm 撞 5h 限额，重派还是 glm 继续撞——C5 只做同表降档，缺跨供应商备用链。
// 断言清单（对应任务验收口径）：
//   F1 cfg/seed/normalizeBoard 的 fallbackModels 缺省 [] 与脏值收敛（非数组/非字符串项/空串）
//   F2 set-board-config fallbackModels 数组校验 + 非法模型整包拒写（带清单）+ configLog 审计行
//   F3 候选冷却/熔断 → 切首个健康备用（agentOptions + modelSource='fallback' + 卡 messages 留痕）；
//      备用链逐项过健康检查（跳过不健康项）；verifier 角色同链
//   F4 备用链全不健康 → 原 C5 降档链 → parent 兜底完整回退序
//   F5 无 fallbackModels（缺字段/显式空链）时行为与现状逐字一致（零回归）

// ===== F1 cfg/seed/normalizeBoard 缺省与脏值 =====
test('备用链F1：seed/cfg/normalizeBoard 的 fallbackModels 缺省 [] 与脏值收敛', function () {
  assert.deepEqual(seed(SID).fallbackModels, [], 'seed 落空数组缺省')
  assert.deepEqual(cfg({}).fallbackModels, [], '老看板缺字段 → cfg 补空数组')
  assert.deepEqual(cfg({ fallbackModels: 'junk' }).fallbackModels, [], '非数组 → 空数组')
  assert.deepEqual(cfg({ fallbackModels: [' gsmoma/kimi/kimi-k3 ', 42, '', null, 'kimi-coding/k3.1-pro'] }).fallbackModels, ['gsmoma/kimi/kimi-k3', 'kimi-coding/k3.1-pro'], 'trim + 非字符串/空串丢弃，保序')
  var d = { version: 12, tasks: [], fallbackModels: 'junk' }
  normalizeBoard(d)
  assert.deepEqual(d.fallbackModels, [], 'normalizeBoard 脏值收敛为空数组')
  var d2 = { version: 12, tasks: [], fallbackModels: ['x/y'] }
  normalizeBoard(d2)
  assert.deepEqual(d2.fallbackModels, ['x/y'], 'normalizeBoard 保留合法链')
})

// ===== F2 set-board-config fallbackModels：数组校验 + 整包拒写 + 审计 =====
test('备用链F2：set-board-config fallbackModels 数组校验 + 非法整包拒写 + configLog 审计行', async function () {
  var board = { version: 12, tasks: [], configLog: [], fallbackModels: [] }
  var h = mkRpcHandlers(board, {}, mkLlmCtx(MOCK_MODELS))
  // 合法数组写入（逐项 trim 落盘）
  var r = await h['set-board-config']({ key: 'fallbackModels', value: ['deepseek/deepseek-chat', ' kimi/kimi-k2 '] })
  assert.equal(r.ok, true)
  assert.deepEqual(board.fallbackModels, ['deepseek/deepseek-chat', 'kimi/kimi-k2'], '逐项 trim 落盘保序')
  var log = board.configLog[board.configLog.length - 1]
  assert.equal(log.key, 'fallbackModels')
  assert.deepEqual(log.to, ['deepseek/deepseek-chat', 'kimi/kimi-k2'], '审计 to 记落盘值')
  assert.equal(log.actor, 'tester')
  // 空数组=清链
  var r2 = await h['set-board-config']({ key: 'fallbackModels', value: [] })
  assert.equal(r2.ok, true)
  assert.deepEqual(board.fallbackModels, [], '空数组=清链')
  // 任一非法模型 → 整包拒写（不落半截，错误带合法清单）
  var r3 = await h['set-board-config']({ key: 'fallbackModels', value: ['kimi/kimi-k2', 'kimi/kimi-k3'] })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /非法模型 id: kimi\/kimi-k3/)
  assert.match(r3.error, /合法清单/, '拒写带合法清单')
  assert.deepEqual(board.fallbackModels, [], '整包拒写不污染现值')
  // 非数组 / 非字符串项 / 空串项 → fail-loud
  var r4 = await h['set-board-config']({ key: 'fallbackModels', value: 'kimi/kimi-k2' })
  assert.equal(r4.ok, false); assert.match(r4.error, /字符串数组/)
  var r5 = await h['set-board-config']({ key: 'fallbackModels', value: ['kimi/kimi-k2', 42] })
  assert.equal(r5.ok, false); assert.match(r5.error, /fallbackModels\[1\] 需为字符串/)
  var r6 = await h['set-board-config']({ key: 'fallbackModels', value: ['  '] })
  assert.equal(r6.ok, false); assert.match(r6.error, /为空串/)
  // llm 缺失（老宿主）降级放行
  var board2 = { version: 12, tasks: [] }
  var hNo = mkRpcHandlers(board2, {}, { get: function () { return null } })
  var r7 = await hNo['set-board-config']({ key: 'fallbackModels', value: ['whatever/display'] })
  assert.equal(r7.ok, true)
  assert.deepEqual(board2.fallbackModels, ['whatever/display'])
  // get-tasks 透出归一形态（缺字段透空数组）
  var g1 = await h['get-tasks']({})
  assert.deepEqual(g1.fallbackModels, [], 'get-tasks 透出空数组')
})

// ===== F3 候选冷却/熔断 → 切首个健康备用 =====
test('备用链F3a：候选冷却中 → 切首个健康备用（agentOptions + modelSource=\'fallback\' + messages 留痕）', async function () {
  var board = laneBoard({ size: 'heavy' }, { fallbackModels: ['fb/fb-a', 'fb/fb-b'] })
  var state = { modelCooldown: { 'lw/lane-w': Date.now() + 3600000 } } // heavy 档 lane 候选冷却 1h
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'fb', model: 'fb-a' }, '冷却 → 切首个健康备用（不降档）')
    assert.equal(sr.modelSource, 'fallback', 'run 留档 modelSource=fallback')
    assert.equal(board.tasks[0].runs[0].modelSource, 'fallback', '卡上 run 条目同留痕')
    var fb = (board.tasks[0].messages || []).filter(function (m) { return m.kind === 'fallback' })
    assert.equal(fb.length, 1, '卡 messages 记一条切备用留痕')
    assert.match(fb[0].text, /原模型 lw\/lane-w 冷却中（至 \d{2}:\d{2}），切备用 fb\/fb-a/, '留痕含原模型+冷却截止+备用目标')
    assert.equal((board.tasks[0].messages || []).filter(function (m) { return m.kind === 'cooldown' }).length, 0, '不再走降档链（无 cooldown 留痕）')
  } finally { console.error = origErr }
})

test('备用链F3b：候选熔断中 → 切首个健康备用（不再降下一跳）', async function () {
  var bad = {}
  bad[SID + '|cm/card-m'] = true // card 级特例熔断
  var board = laneBoard({ model: 'cm/card-m', size: 'heavy' }, { fallbackModels: ['fb/fb-a'] })
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, { badModels: bad }).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'fb', model: 'fb-a' }, 'card 熔断 → 切备用（不再降 lane 级）')
    assert.equal(sr.modelSource, 'fallback')
    var fb = (board.tasks[0].messages || []).filter(function (m) { return m.kind === 'fallback' })
    assert.equal(fb.length, 1)
    assert.match(fb[0].text, /原模型 cm\/card-m 熔断中，切备用 fb\/fb-a/)
  } finally { console.error = origErr }
})

test('备用链F3c：备用链逐项过健康检查——跳过冷却/熔断项取下一个健康者（保序）', async function () {
  var board = laneBoard({ size: 'heavy' }, { fallbackModels: ['fb/fb-a', 'fb/fb-b', 'fb/fb-c'] })
  var bad = {}
  bad[SID + '|fb/fb-b'] = true // 链第二项熔断
  var state = { badModels: bad, modelCooldown: { 'lw/lane-w': Date.now() + 3600000, 'fb/fb-a': Date.now() + 3600000 } } // 原候选与链首项都冷却
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'fb', model: 'fb-c' }, '跳过冷却 fb-a 与熔断 fb-b，取 fb-c')
    assert.equal(sr.modelSource, 'fallback')
  } finally { console.error = origErr }
})

test('备用链F3d：verifier 角色同走备用链（板级 verifierModel 冷却 → 切备用）', async function () {
  var board = laneBoard({}, { fallbackModels: ['fb/fb-v'] })
  var state = { modelCooldown: { 'bv/board-v': Date.now() + 3600000 } } // 板级 verifierModel 冷却
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'verifier')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'fb', model: 'fb-v' }, 'verifier 候选冷却 → 切备用')
    assert.equal(sr.modelSource, 'fallback')
    assert.equal(board.tasks[0].runs[0].modelSource, 'fallback')
  } finally { console.error = origErr }
})

// ===== F4 备用链全不健康 → 原降档链 → parent 兜底完整回退序 =====
var FULL_LANES = { light: { worker: 'lw/light-w', verifier: '' }, standard: { worker: 'sw/std-w', verifier: '' }, heavy: { worker: 'hw/heavy-w', verifier: '' } }
test('备用链F4a：备用链全不健康 → 回原 C5 降档链（命中 standard + cooldown-downgrade 留痕）', async function () {
  var board = laneBoard({ size: 'heavy' }, { laneModels: JSON.parse(JSON.stringify(FULL_LANES)), fallbackModels: ['fb/fb-a'] })
  var state = { modelCooldown: { 'hw/heavy-w': Date.now() + 3600000, 'fb/fb-a': Date.now() + 3600000 } } // 原档与备用都冷却
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'sw', model: 'std-w' }, '备用链尽 → 降档命中 standard 槽')
    assert.equal(sr.modelSource, 'cooldown-downgrade', '链尽走原降档留痕（非 fallback）')
    var fb = (board.tasks[0].messages || []).filter(function (m) { return m.kind === 'fallback' })
    assert.equal(fb.length, 0, '无备用命中 → 无 fallback 留痕')
    var cm = (board.tasks[0].messages || []).filter(function (m) { return m.kind === 'cooldown' })
    assert.equal(cm.length, 1, '降档留痕照旧')
    assert.match(cm[0].text, /本 run 降档为 sw\/std-w/)
  } finally { console.error = origErr }
})

test('备用链F4b：备用链+降档链全尽 → parent 兜底（不挂 agentOptions）', async function () {
  var board = laneBoard({ size: 'heavy' }, { laneModels: JSON.parse(JSON.stringify(FULL_LANES)), fallbackModels: ['fb/fb-a', 'fb/fb-b'] })
  var cd = { 'hw/heavy-w': Date.now() + 3600000, 'sw/std-w': Date.now() + 3600000, 'lw/light-w': Date.now() + 3600000, 'fb/fb-a': Date.now() + 3600000 }
  var bad = {}
  bad[SID + '|fb/fb-b'] = true // 链尾熔断（覆盖「冷却+熔断混合链尽」）
  var state = { modelCooldown: cd, badModels: bad }
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.equal(calls[0].request.agentOptions, undefined, '备用链+降档链全尽 → 父模型兜底')
    assert.equal(sr.modelSource, 'cooldown-downgrade')
    var cm = (board.tasks[0].messages || []).filter(function (m) { return m.kind === 'cooldown' })
    assert.equal(cm.length, 1)
    assert.match(cm[0].text, /本 run 降档为 父模型/)
  } finally { console.error = origErr }
})

// ===== F5 无 fallbackModels（缺字段/显式空链）时行为与现状逐字一致（零回归）=====
test('备用链F5：无备用链配置时冷却降档/熔断降跳与现状逐字一致', async function () {
  var origErr = console.error; console.error = function () {}
  try {
    // 形态1：板无 fallbackModels 字段（老看板）+ heavy 冷却 → 降 standard（与冷却③a 同形态）
    var board = laneBoard({ size: 'heavy' }, { laneModels: JSON.parse(JSON.stringify(FULL_LANES)) })
    var state = { modelCooldown: { 'hw/heavy-w': Date.now() + 3600000 } }
    var calls = []
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'sw', model: 'std-w' }, '缺字段：冷却照旧降档')
    assert.equal(sr.modelSource, 'cooldown-downgrade')
    assert.equal((board.tasks[0].messages || []).filter(function (m) { return m.kind === 'fallback' }).length, 0, '无备用链留痕')
    // 形态2：显式空链 fallbackModels: [] → 同上（空链=无链）
    var board2 = laneBoard({ size: 'heavy' }, { laneModels: JSON.parse(JSON.stringify(FULL_LANES)), fallbackModels: [] })
    var calls2 = []
    var sr2 = await mkDispatch(board2, { subagents: mkActivationSubagents(calls2) }, { modelCooldown: { 'hw/heavy-w': Date.now() + 3600000 } }).spawnOneShot(SID, board2.tasks[0], 'worker')
    assert.deepEqual(calls2[0].request.agentOptions, { provider: 'sw', model: 'std-w' }, '显式空链：冷却照旧降档')
    assert.equal(sr2.modelSource, 'cooldown-downgrade')
    // 形态3：无备用链时熔断降跳照旧（card 熔断 → lane，不切备用）
    var bad = {}
    bad[SID + '|cm/card-m'] = true
    var board3 = laneBoard({ model: 'cm/card-m', size: 'heavy' }, { laneModels: JSON.parse(JSON.stringify(FULL_LANES)) })
    var calls3 = []
    var sr3 = await mkDispatch(board3, { subagents: mkActivationSubagents(calls3) }, { badModels: bad }).spawnOneShot(SID, board3.tasks[0], 'worker')
    assert.deepEqual(calls3[0].request.agentOptions, { provider: 'hw', model: 'heavy-w' }, 'card 熔断降 lane（现状不变）')
    assert.equal(sr3.modelSource, 'lane')
    assert.equal((board3.tasks[0].messages || []).filter(function (m) { return m.kind === 'fallback' }).length, 0)
  } finally { console.error = origErr }
})

