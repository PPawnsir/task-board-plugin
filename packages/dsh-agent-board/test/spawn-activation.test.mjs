// ===== DSH v0.2.1 宿主 startActivation 双兼容路径专测（2026-10-24 宿主 API 重构实证）=====
// 背景：v0.2.1 宿主把 subagents.start(provider,req) 与 subagents.startContinuable(spec)
// 统一替换为 subagents.startActivation(spec{provider,label,request,signal,delivery})。
// 本文件钉死新路径的四个契约面：
//   ① worker（continuable）→ delivery='parent' + request 剥 label/signal + childId 透出
//   ② verifier（一次性）→ delivery='caller' + Activation 适配成旧 run 形状 {id,result,dispose}
//   ③ 新路径不携带 persona/toolFilter（v0.2.1 已收进 agentPreset 体系）
//   ④ agentOptions 传递 + UNKNOWN_MODEL 首次失败 → 剥覆盖重试（模型回退语义不回归）
//   ⑤ 老宿主桩（无 startActivation）仍走 start/startContinuable（双路径判别直证）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatch } from '../lib/dispatch.mjs'

var SID = 'session-test-0000-0000-000000000000'

function mkTask(over) {
  return Object.assign({ id: 't1', title: 'T', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', history: [], messages: [] }, over || {})
}
function mkBoard(tasks) { return { version: 11, ownerSession: 's1', boardMode: 'auto', tasks: tasks || [] } }

function mkDispatch(board, ctxOver) {
  var dispatch = createDispatch(
    Object.assign({ fs: {}, effect: function () {}, get: function () { return null } }, ctxOver || {}),
    { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} },
    {
      rt: async () => board,
      wt: async () => {},
      mutateLocked: async (sid, fn) => fn(board),
      kickCycle: () => {},
      rootForSession: () => ({ id: SID }),
      sessionCwd: () => '', withTimeout: (p) => p, runsFor: () => ({}), feedbackOn: () => true,
      pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
    })
  return dispatch
}

// 新宿主桩：startActivation 记录 spec，返回可控 Activation
function mkActivationSubagents(calls, opts) {
  opts = opts || {}
  return {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function (spec) {
      calls.push(spec)
      if (opts.failFirst) { opts.failFirst = false; throw new Error('UNKNOWN_MODEL') }
      return {
        childId: 'child-' + calls.length,
        messageId: 'msg-' + calls.length,
        result: new Promise(function () {}),
        dispose: async function () { (opts.disposed = opts.disposed || []).push(spec.label) },
      }
    },
    // 新宿主桩刻意**不带** start/startContinuable——若代码误走旧路径必然 TypeError 炸出
  }
}

test('startActivation①：worker 走 delivery=parent + request 剥 label/signal + childId 透出', async () => {
  var board = mkBoard([mkTask({ status: 'in-progress', claimedBy: 'spawn-pending' })]) // 占位态：worker 落闸（spawnGateOk）需要
  var calls = []
  var dispatch = mkDispatch(board, { subagents: mkActivationSubagents(calls) })
  var t = board.tasks[0]
  var sr = await dispatch.spawnOneShot(SID, t, 'worker')
  assert.ok(sr, 'spawn 成功返回 rec')
  assert.equal(calls.length, 1)
  var spec = calls[0]
  assert.equal(spec.delivery, 'parent', 'continuable 必须 parent 投递（结算留言旧行为）')
  assert.equal(spec.label, 'worker:t1')
  assert.equal(spec.provider, 'p1')
  assert.ok(spec.request, 'request 存在')
  assert.equal(spec.request.label, undefined, 'request 不携带 label（新契约 Omit）')
  assert.equal(spec.request.signal, undefined, 'request 不携带 signal（新契约 Omit）')
  assert.ok(Array.isArray(spec.request.prompt), 'prompt 透传')
  assert.ok(spec.signal, 'signal 在 spec 顶层')
  assert.equal(String(sr.id), 'child-1', 'rec.id = activation childId')
  assert.equal(sr.continuable, true, 'worker 缺省 continuable')
})

test('startActivation②：verifier 走 delivery=caller + Activation 适配旧 run 形状 {id,result,dispose}', async () => {
  var board = mkBoard([mkTask()])
  var opts = {}
  var calls = []
  var subagents = mkActivationSubagents(calls, opts)
  var dispatch = mkDispatch(board, { subagents: subagents })
  var sr = await dispatch.spawnOneShot(SID, board.tasks[0], 'verifier')
  assert.ok(sr, 'verifier spawn 成功')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].delivery, 'caller', '一次性必须 caller 投递（不惊动父会话）')
  var run = sr.run
  assert.equal(String(run.id), 'child-1', '适配 run.id = activation childId')
  assert.ok(run.result instanceof Promise, '适配 run.result 是 Promise')
  assert.equal(typeof run.dispose, 'function', '适配 run.dispose 存在')
  await run.dispose()
  assert.deepEqual(opts.disposed, ['verifier:t1'], 'dispose 透传到 activation.dispose')
})

test('startActivation③：verifier 加餐 persona/toolFilter 不进新契约 request', async () => {
  var board = mkBoard([mkTask()])
  var calls = []
  var dispatch = mkDispatch(board, { subagents: mkActivationSubagents(calls) })
  await dispatch.spawnOneShot(SID, board.tasks[0], 'verifier')
  var spec = calls[0]
  assert.equal(spec.request.persona, undefined, 'persona 不在新契约面（v0.2.1 收进 agentPreset）')
  assert.equal(spec.request.toolFilter, undefined, 'toolFilter 不在新契约面')
})

test('startActivation④：agentOptions 传递 + UNKNOWN_MODEL 首败 → 剥覆盖重试（模型回退不回归）', async () => {
  var board = mkBoard([mkTask({ status: 'in-progress', claimedBy: 'spawn-pending' })])
  board.workerModel = 'gsmoma/kimi/kimi-k3'
  var opts = { failFirst: true }
  var calls = []
  var origErr = console.error; console.error = function () {} // 压掉回退日志
  try {
    var dispatch = mkDispatch(board, { subagents: mkActivationSubagents(calls, opts) })
    var sr = await dispatch.spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr, '回退后 spawn 成功')
    assert.equal(calls.length, 2, '首败后重试一次')
    var first = calls[0].request.agentOptions
    assert.deepEqual(first, { provider: 'gsmoma', model: 'kimi/kimi-k3' }, '复合 id 拆 provider/model 透传')
    assert.equal(calls[1].request.agentOptions, undefined, '重试剥掉模型覆盖')
  } finally { console.error = origErr }
})

test('startActivation⑤：老宿主桩（无 startActivation）仍走 start/startContinuable（双路径判别）', async () => {
  var board = mkBoard([mkTask()])
  var used = []
  var oldSubagents = {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    start: async function () { used.push('start'); return { id: 'run-1', result: new Promise(function () {}), dispose: async function () {} } },
    startContinuable: async function () { used.push('startContinuable'); return { childId: 'child-old', messageId: 'm1' } },
  }
  var dispatch = mkDispatch(board, { subagents: oldSubagents })
  await dispatch.spawnOneShot(SID, board.tasks[0], 'worker')
  await dispatch.spawnOneShot(SID, board.tasks[0], 'verifier')
  assert.deepEqual(used, ['startContinuable', 'start'], '老宿主逐字走旧双路径')
})

test('startActivation⑤b：continuable 兜底臂——activation.result 拆除落定 → settleWorker 失败结算（rate-limit 原形）', async () => {
  var board = mkBoard([mkTask({ status: 'in-progress', claimedBy: 'spawn-pending' })])
  var settle = null
  var actResult = new Promise(function (res) { settle = res })
  var subagents = {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function () {
      return { childId: 'child-1', messageId: 'm1', result: actResult, dispose: async function () {} }
    },
    interrupt: function () {},
  }
  var dispatch = createDispatch(
    { fs: {}, effect: function () {}, get: function () { return null }, subagents: subagents },
    { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} },
    {
      rt: async () => board,
      wt: async () => {},
      mutateLocked: async (sid, fn) => fn(board),
      kickCycle: () => {},
      rootForSession: () => ({ id: SID }),
      sessionCwd: () => '', withTimeout: (p) => p, runsFor: () => ({}), feedbackOn: () => true,
      pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
    })
  var sr = await dispatch.spawnOneShot(SID, board.tasks[0], 'worker')
  assert.ok(sr, 'spawn 成功')
  // 模拟宿主拆除（rate-limit turn/end error）：result 以 stopReason=error 落定
  settle({ output: [], stopReason: 'error', diagnostic: '429 RATE_LIMIT' })
  await new Promise(function (r) { setTimeout(r, 30) })
  var t = board.tasks[0]
  assert.ok((t.retryCount || 0) >= 1, '失败结算落 retryCount（settleWorker 失败臂实证）')
  assert.ok(t.lastError && String(t.lastError).indexOf('拆除') >= 0, 'lastError 记拆除原因')
  assert.equal(t.status, 'pending', '失败回收重新排队（retryCount<3 回 pending）')
  // 幂等：同 rec 再落定不再二次结算
  var rc = t.retryCount
  settle({ output: [], stopReason: 'error' })
  await new Promise(function (r) { setTimeout(r, 30) })
  assert.equal(t.retryCount, rc, 'settled 首胜旗挡重复落定')
})

test('startActivation⑥：新契约路径在源码层接线（startActivation 调用点 + 双 delivery 常量）', async () => {
  var { readFileSync } = await import('node:fs')
  var src = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  assert.match(src, /subagents\.startActivation\(\{ provider: providerName, label: req\.label, request: activationRequestOf\(req\), signal: req\.signal, delivery: 'parent' \}\)/)
  assert.match(src, /delivery: 'caller' \}\)\)/)
  assert.match(src, /function hasActivationApi\(subagents\)/)
  assert.match(src, /function activationAsRun\(act\)/)
  assert.match(src, /function activationRequestOf\(req\)/)
})

// ===== 落闸弃权损毁（task-mvnyk55n）：veto 对 continuable 子会话不再只 interrupt 留存 =====
// 原形：ontology EW-B 卡一卡 6 个存活 worker 子会话——弃权/终止的 interrupt 留存会话随
// 「编辑→重派」循环淤积成停泊残影，且可被续跑/投递链路误唤醒与现任并行。
// 修法：veto 时新契约路径（activation 在手）先 interrupt 再 dispose 销毁；老契约路径保持
// interrupt 不变；dispose 失败降级 interrupt 留存（记 console.error，不阻断弃权）。
test('startActivation⑦：落闸弃权新契约路径 → 先 interrupt 再 activation.dispose 销毁（不停泊）', async () => {
  var board = mkBoard([mkTask()]) // pending 无占位 → 落闸锁内重验必否决（过期快照=弃权原形）
  var calls = []
  var opts = {}
  var interrupts = []
  var subagents = mkActivationSubagents(calls, opts)
  subagents.interrupt = function (id, auth) { interrupts.push({ id: id, auth: auth }) }
  var dispatch = mkDispatch(board, { subagents: subagents })
  var origErr = console.error; console.error = function () {} // 压掉弃权日志
  try {
    var sr = await dispatch.spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr && sr.vetoed === true, '闸门否决 → 弃权返回')
    assert.equal(interrupts.length, 1, 'dispose 前先 interrupt 打断当前 turn（停损信号先行）')
    assert.equal(interrupts[0].id, 'child-1', 'interrupt 目标=刚建的子会话')
    assert.equal(interrupts[0].auth.kind, 'ancestor', 'authority 形状同款')
    assert.deepEqual(opts.disposed, ['worker:t1'], 'veto 场景 dispose 被调用（销毁而非留存淤积）')
  } finally { console.error = origErr }
})

test('startActivation⑧：落闸弃权老契约路径（无 startActivation）→ 保持 interrupt 留存不变', async () => {
  var board = mkBoard([mkTask()])
  var interrupts = []
  var oldSubagents = {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startContinuable: async function () { return { childId: 'child-old', messageId: 'm1' } },
    interrupt: function (id) { interrupts.push(id) },
  }
  var dispatch = mkDispatch(board, { subagents: oldSubagents })
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await dispatch.spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr && sr.vetoed === true, '老契约路径闸门否决同样弃权')
    assert.deepEqual(interrupts, ['child-old'], '老契约无 activation 可 dispose → interrupt 留存逐字不变')
  } finally { console.error = origErr }
})

test('startActivation⑨：落闸弃权 dispose 失败 → 降级 interrupt 留存（记 console.error，不阻断弃权）', async () => {
  var board = mkBoard([mkTask()])
  var interrupts = []
  var subagents = {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function () {
      return { childId: 'child-x', messageId: 'm1', result: new Promise(function () {}), dispose: async function () { throw new Error('dispose boom') } }
    },
    interrupt: function (id) { interrupts.push(id) },
  }
  var dispatch = mkDispatch(board, { subagents: subagents })
  var errLines = []
  var origErr = console.error; console.error = function () { errLines.push(Array.prototype.join.call(arguments, ' ')) }
  try {
    var sr = await dispatch.spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr && sr.vetoed === true, 'dispose 失败不阻断弃权返回')
    assert.deepEqual(interrupts, ['child-x'], 'interrupt 已先行送达 → dispose 失败即降级为留存形态')
    assert.ok(errLines.some(function (l) { return l.indexOf('落闸弃权 dispose 失败') >= 0 && l.indexOf('dispose boom') >= 0 }), '失败记 console.error 留痕')
  } finally { console.error = origErr }
})

// ===== 宿主秒拆喂熔断（task-mvowb2hc 洞①）：stopReason:error 拆除计入熔断连击 =====
// 原形（task-mvoutja4 实证）：glm-5.3-flash spawn 后 1 秒「子会话被宿主拆除（stopReason: error）」×3——
// 该失败形态此前不计入 badModels，熔断永不触发，档位链每轮重派都再选同一个坏模型。修：settleWorker
// 失败臂把「宿主拆除/activation 异常」归类为模型面失败喂连击表，连续 3 次才拉黑（熔断语义不变：
// badModels 落黑名单 → 取模链跳过 + 健康表 circuit）；worker 自己的失误（空文本失败）不计，成功 run 归零。
// 薄桩 harness：与 mkDispatch 同形，另加 runs 表持久（settleReportedRun 消费）+ state/notes/事件可观测。
function mkCircuitDispatch(board, ctxOver, stateOver) {
  var notes = []
  var listeners = []
  // runs 表必须与 state.activeRuns[SID] **同一对象**（core.test.mjs mkContinuableDispatch 同款）：
  // spawnOneShot 经 runsFor 写 rec，agent/status 监听器经 state.activeRuns[sid] 读 rec——两处不同
  // 形状（一个按 taskId 键、一个按 sid 键）事件通道就永远命中不到。
  var runs = {}
  var activeRuns = {}
  activeRuns[SID] = runs
  var state = Object.assign({ knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: activeRuns }, stateOver || {})
  var dispatch = createDispatch(
    Object.assign({
      fs: {},
      // 真 cordis 的 ctx.effect 立即执行回调取 disposer——桩里必须照做，否则 ctx.on 永不被触达，事件通道测不到
      effect: function (f) { var d = f(); return function () {} },
      get: function () { return null },
      on: function (name, fn) { listeners.push({ name: name, fn: fn }); return function () {} },
    }, ctxOver || {}),
    state,
    {
      rt: async () => board,
      wt: async () => {},
      mutateLocked: async (sid, fn) => fn(board),
      kickCycle: () => {},
      rootForSession: () => ({ id: SID }),
      sessionCwd: () => '', withTimeout: (p) => p, runsFor: () => runs, feedbackOn: () => true,
      pushSysNote: function (s, text, taskId) { notes.push({ sid: s, text: text, taskId: taskId }) },
      maybeNotify: () => {}, notifyTaskDone: () => {},
    })
  return { dispatch: dispatch, state: state, notes: notes, listeners: listeners, runs: runs }
}
// 每次调用返回可控 Activation，result 的 settle 函数按序推入 settles
function mkSettleActivationSubagents(settles) {
  var n = 0
  return {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function (spec) {
      return { childId: 'child-' + (++n), messageId: 'm' + n, result: new Promise(function (res) { settles.push(res) }), dispose: async function () {} }
    },
    interrupt: function () {},
  }
}
// 拆除落定诊断文本用「internal error」：不命中限流/连接冷却嗅探（隔离熔断连击单一变量）
var CIRCUIT_MODEL = 'prov/glm-5.3-flash'
var CIRCUIT_FALLBACK = 'prov/alt-model'

test('startActivation⑩（task-mvowb2hc 洞①）：宿主秒拆（stopReason:error）三连 → 熔断拉黑 + 下一轮链跳过备用模型', async () => {
  var board = mkBoard([mkTask({ status: 'in-progress', claimedBy: 'spawn-pending' })])
  board.workerModel = CIRCUIT_MODEL
  board.fallbackModels = [CIRCUIT_FALLBACK]
  var settles = []
  var h = mkCircuitDispatch(board, { subagents: mkSettleActivationSubagents(settles) })
  var t = board.tasks[0]
  var origErr = console.error; console.error = function () {} // 压掉失败结算日志
  try {
    for (var round = 1; round <= 3; round++) {
      t.status = 'in-progress'; t.claimedBy = 'spawn-pending' // 每轮重置占位（失败结算回 pending 后可再派）
      var sr = await h.dispatch.spawnOneShot(SID, t, 'worker')
      assert.ok(sr, '第 ' + round + ' 轮 spawn 成功')
      settles[round - 1]({ output: [], stopReason: 'error', diagnostic: 'internal error' })
      await new Promise(function (r) { setTimeout(r, 30) })
      if (round < 3) assert.equal(Object.keys(h.state.badModels).length, 0, '第 ' + round + ' 连未达阈值不拉黑')
    }
    assert.equal(h.state.badModels[SID + '|' + CIRCUIT_MODEL], true, '三连秒拆 → 熔断拉黑（连击 3 次计满）')
    assert.ok(h.notes.some(function (x) { return x.text.indexOf(CIRCUIT_MODEL) >= 0 && x.text.indexOf('熔断') >= 0 }), '熔断系统通知在位（与验收熔断同口径）')
    // 链跳过：下一轮 spawn 不再选坏模型——备用链命中首个健康者（熔断语义不变，链照旧消费 badModels）
    t.status = 'in-progress'; t.claimedBy = 'spawn-pending'
    var sr4 = await h.dispatch.spawnOneShot(SID, t, 'worker')
    assert.ok(sr4 && String(sr4.id), '第 4 轮 spawn 成功')
    assert.equal(sr4.model, CIRCUIT_FALLBACK, '坏模型被链跳过（fallback 命中）')
    assert.equal(sr4.modelSource, 'fallback', 'modelSource=fallback 留档')
    var fbMsg = (t.messages || []).find(function (m) { return m.kind === 'fallback' })
    assert.ok(fbMsg && fbMsg.text.indexOf(CIRCUIT_MODEL) >= 0, '切备用留痕落卡')
  } finally { console.error = origErr }
})

test('startActivation⑪（task-mvowb2hc 洞①）：两连拆不拉黑 + 成功 run 归零连击（「连续」语义不回归）', async () => {
  var board = mkBoard([mkTask({ status: 'in-progress', claimedBy: 'spawn-pending' })])
  board.workerModel = CIRCUIT_MODEL
  var settles = []
  var h = mkCircuitDispatch(board, { subagents: mkSettleActivationSubagents(settles) })
  var t = board.tasks[0]
  var origErr = console.error; console.error = function () {}
  try {
    for (var round = 1; round <= 2; round++) {
      t.status = 'in-progress'; t.claimedBy = 'spawn-pending'
      await h.dispatch.spawnOneShot(SID, t, 'worker')
      settles[round - 1]({ output: [], stopReason: 'error', diagnostic: 'internal error' })
      await new Promise(function (r) { setTimeout(r, 30) })
    }
    assert.equal(Object.keys(h.state.badModels).length, 0, '两连拆不拉黑（未达 3 连阈值）')
    // 成功 run 归零连击：上报通道 completed 结算（settleReportedRun → settleRunRecord → resetModelFailure）
    var rep = await h.dispatch.settleReportedRun(SID, t.id, { outcome: 'completed' })
    assert.equal(rep, true, '成功结算走通（连击归零消费点）')
    // 再一拆：连击从 1 重新起算 → 不拉黑
    t.status = 'in-progress'; t.claimedBy = 'spawn-pending'
    await h.dispatch.spawnOneShot(SID, t, 'worker')
    settles[2]({ output: [], stopReason: 'error', diagnostic: 'internal error' })
    await new Promise(function (r) { setTimeout(r, 30) })
    assert.equal(Object.keys(h.state.badModels).length, 0, '成功归零后单拆不再拉黑（连续语义）')
  } finally { console.error = origErr }
})

test('startActivation⑫（task-mvowb2hc 洞①边界）：worker 空文本失败（非模型面）×3 不喂熔断；completed 停止码拆除不计', async () => {
  var flush = async function () { for (var i = 0; i < 5; i++) await new Promise(function (r) { setImmediate(r) }) }
  // A：worker 自己的失误（事件通道空文本失败，errText='error' 非模型面）×3 → 照旧阻塞，badModels 恒空
  var boardA = mkBoard([mkTask()])
  boardA.workerModel = CIRCUIT_MODEL
  var hA = mkCircuitDispatch(boardA, { subagents: mkSettleActivationSubagents([]) })
  var tA = boardA.tasks[0]
  var origErr = console.error; console.error = function () {} // 压掉「未读到 assistant 文本」与失败日志
  try {
    for (var round = 1; round <= 3; round++) {
      await hA.dispatch.poolCycle(SID)
      var cid = 'child-' + round
      hA.listeners[0].fn({ agent: { session: { id: cid } }, status: 'running' }) // rec.ran 唯一来源
      hA.listeners[0].fn({ agent: { session: { id: cid } }, status: 'idle' })
      await flush()
      assert.equal(Object.keys(hA.state.badModels).length, 0, '第 ' + round + ' 次空文本失败不喂熔断')
    }
    assert.equal(tA.status, 'blocked', '三连失败照旧阻塞（既有 retryCount 语义不变）')
    assert.equal(Object.keys(hA.state.badModels).length, 0, 'worker 失误不计入熔断连击（好模型不背锅）')
  } finally { console.error = origErr }
  // B：activation.result 以 stopReason=completed 落定（收尾性拆除）→ 失败结算照旧，但不计入模型面连击
  var boardB = mkBoard([mkTask({ status: 'in-progress', claimedBy: 'spawn-pending' })])
  boardB.workerModel = CIRCUIT_MODEL
  var settles = []
  var hB = mkCircuitDispatch(boardB, { subagents: mkSettleActivationSubagents(settles) })
  var tB = boardB.tasks[0]
  try {
    for (var r2 = 1; r2 <= 3; r2++) {
      tB.status = 'in-progress'; tB.claimedBy = 'spawn-pending'
      await hB.dispatch.spawnOneShot(SID, tB, 'worker')
      settles[r2 - 1]({ output: [], stopReason: 'completed', diagnostic: 'parked teardown after completion' })
      await new Promise(function (r) { setTimeout(r, 30) })
    }
    assert.equal(Object.keys(hB.state.badModels).length, 0, 'completed 停止码拆除不计入模型面连击')
  } finally { console.error = origErr }
})
