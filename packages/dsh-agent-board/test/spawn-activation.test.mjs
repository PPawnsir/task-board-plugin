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

test('startActivation⑥：新契约路径在源码层接线（startActivation 调用点 + 双 delivery 常量）', async () => {
  var { readFileSync } = await import('node:fs')
  var src = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  assert.match(src, /subagents\.startActivation\(\{ provider: providerName, label: req\.label, request: activationRequestOf\(req\), signal: req\.signal, delivery: 'parent' \}\)/)
  assert.match(src, /delivery: 'caller' \}\)\)/)
  assert.match(src, /function hasActivationApi\(subagents\)/)
  assert.match(src, /function activationAsRun\(act\)/)
  assert.match(src, /function activationRequestOf\(req\)/)
})
