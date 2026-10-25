// ===== RATE_LIMIT 额度冷却（task-mvneq4kk）：限流嗅探登记 + 冷却期取模链自动降档 =====
// 原形事故（2026-10-24 实证）：worker 撞 glm 5h 限额（429 报错带「限额将在 2026-10-24 17:42:51 重置」
// 结构化文本），子会话死掉重派还是同一个模型继续撞。
// 断言清单（对应任务验收口径）：
//   ① parseRateLimit 四形态：英文带 reset 时间 / 中文带「重置」时间 / 无时间（30min 保守缺省）/ 非限流文本（null）
//   ② 冷却登记双路径：spawn extras 回退臂 e 文本（spawn 秒死）+ settleWorker 失败臂 errText（continuable 死子，
//      activation.result 拆除兜底臂带上来的诊断文本同路）；max 收敛只延不缩
//   ③ 冷却期取模降档：heavy 冷却 → standard（modelSource='cooldown-downgrade' + 卡 messages 留痕）；
//      全链冷却 → 父模型兜底；badModels 熔断面不受污染
//   ④ 过期冷却惰性清除，不再降档
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatch, parseRateLimit } from '../lib/dispatch.mjs'

var SID = 'session-test-0000-0000-000000000000'
// 本地时区构造的固定重置时刻（与 parseRateLimit 的本地时区解析口径一致，跨 TZ 稳定）
var FIXED = new Date(2026, 9, 24, 17, 42, 51).getTime()

function mkTask(over) {
  return Object.assign({ id: 't1', title: 'T', description: '', status: 'in-progress', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: 'spawn-pending', claimedAt: null, createdAt: '2026-01-01T00:00:00Z', history: [], messages: [] }, over || {})
}
// dispatch harness 与 lane-models.test.mjs 同形（自含一份避免跨测试文件耦合）
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
// 完整 state（各键同 ref 合入 createDispatch）：测试要直读 badModels/modelCooldown 时必须用它
function mkState(over) {
  return Object.assign({ knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {}, modelCooldown: {} }, over || {})
}
function mkActivationSubagents(calls, opts) {
  opts = opts || {}
  return {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function (spec) {
      calls.push(spec)
      if (opts.failFirst) { opts.failFirst = false; throw opts.failErr || new Error('UNKNOWN_MODEL') }
      return { childId: 'child-' + calls.length, messageId: 'msg-' + calls.length, result: opts.result || new Promise(function () {}), dispose: async function () {} }
    },
    interrupt: function () {},
    // 刻意不带 start/startContinuable：误走旧路径必然 TypeError 炸出
  }
}
function laneBoard(taskOver, boardOver) {
  return Object.assign({ version: 12, tasks: [mkTask(taskOver)], workerModel: 'bw/board-w', verifierModel: 'bv/board-v', laneModels: { light: { worker: 'lw/light-w', verifier: '' }, standard: { worker: 'sw/std-w', verifier: '' }, heavy: { worker: 'hw/heavy-w', verifier: '' } } }, boardOver || {})
}

// ===== ① parseRateLimit 四形态 =====
test('冷却①：parseRateLimit 中英文/带时间/不带时间四形态', function () {
  // 英文带 reset 时间 → 精确 ts
  var en = parseRateLimit('HTTP 429: rate limit exceeded. Quota resets at 2026-10-24 17:42:51.')
  assert.ok(en, '英文限流命中')
  assert.equal(en.until, FIXED, '英文 reset 时间解析为精确 ts')
  assert.equal(en.parsed, true)
  // 中文带「重置」时间（glm 原形事故实证形态）→ 精确 ts
  var zh = parseRateLimit('429 RATE_LIMIT: 当前账户额度已用尽，限额将在 2026-10-24 17:42:51 重置')
  assert.ok(zh, '中文限流命中')
  assert.equal(zh.until, FIXED, '中文「重置」时间解析为精确 ts')
  assert.equal(zh.parsed, true)
  // 无时间（英文 429 裸文本）→ 30min 保守缺省
  var before = Date.now()
  var bare = parseRateLimit('429 Too Many Requests: rate limit exceeded')
  var after = Date.now()
  assert.ok(bare, '裸 429 命中')
  assert.equal(bare.parsed, false)
  assert.ok(bare.until >= before + 30 * 60000 && bare.until <= after + 30 * 60000, '无时间 → now+30min 缺省')
  // 无时间（中文关键词「限额」「额度」）→ 同样缺省
  var zhBare = parseRateLimit('当前账户限额已用完，请稍后再试（额度不足）')
  assert.ok(zhBare && zhBare.parsed === false && zhBare.until > Date.now(), '中文无时间 → 缺省')
  // 非限流文本 → null
  assert.equal(parseRateLimit('UNKNOWN_MODEL: kimi/kimi-k3'), null, 'UNKNOWN_MODEL 不嗅探')
  assert.equal(parseRateLimit('provider timeout after 30s'), null, '超时不嗅探')
  assert.equal(parseRateLimit(''), null)
  assert.equal(parseRateLimit(null), null)
})

// ===== ② 冷却登记双路径 =====
test('冷却②a：spawn extras 回退臂——首败 e 文本命中限流即登记（spawn 秒死场景）', async function () {
  var board = laneBoard({})
  var state = mkState()
  var calls = []
  var sub = mkActivationSubagents(calls, { failFirst: true, failErr: new Error('429 RATE_LIMIT: 限额将在 2026-10-24 17:42:51 重置') })
  var origErr = console.error; console.error = function () {} // 压掉回退/登记日志
  try {
    var sr = await mkDispatch(board, { subagents: sub }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr, '剥覆盖重试后 spawn 成功')
    assert.equal(calls.length, 2, '首败后剥 agentOptions 重试一次')
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'bw', model: 'board-w' }, '首次带 board 级覆盖模型')
    assert.equal(calls[1].request.agentOptions, undefined, '重试剥光')
    assert.equal(state.modelCooldown['bw/board-w'], FIXED, 'e 文本嗅探 → 冷却登记到精确重置时间')
    assert.equal(Object.keys(state.badModels).length, 0, '冷却不污染 badModels 熔断面')
  } finally { console.error = origErr }
})

test('冷却②b：settleWorker 失败臂——continuable 死子（activation 拆除兜底）errText 嗅探登记', async function () {
  var board = laneBoard({})
  var state = mkState()
  var settle = null
  var actResult = new Promise(function (res) { settle = res })
  var calls = []
  var sub = mkActivationSubagents(calls, { result: actResult })
  var origErr = console.error; console.error = function () {}
  try {
    var dispatch = mkDispatch(board, { subagents: sub }, state)
    var sr = await dispatch.spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr && sr.continuable, 'worker 走 continuable')
    // 模拟宿主拆除（rate-limit turn/end error）：result 以 stopReason=error + diagnostic 落定
    settle({ output: [], stopReason: 'error', diagnostic: '429 RATE_LIMIT: 当前账户额度已用尽，限额将在 2026-10-24 17:42:51 重置' })
    await new Promise(function (r) { setTimeout(r, 30) })
    var t = board.tasks[0]
    assert.equal(state.modelCooldown['bw/board-w'], FIXED, '拆除兜底臂 errText 嗅探 → 冷却登记到精确重置时间')
    assert.ok((t.retryCount || 0) >= 1, '既有失败语义不变（retryCount 落账）')
    assert.equal(t.status, 'pending', '失败回收重新排队')
  } finally { console.error = origErr }
})

// ===== ③ 冷却期取模降档 =====
test('冷却③a：heavy 档模型冷却中 → 降 standard（agentOptions + modelSource/messages 留痕）', async function () {
  var board = laneBoard({ size: 'heavy' })
  var state = mkState({ modelCooldown: { 'hw/heavy-w': Date.now() + 3600000 } }) // heavy 档冷却 1h
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'sw', model: 'std-w' }, 'heavy 冷却 → 降一档取 standard 槽')
    assert.equal(sr.modelSource, 'cooldown-downgrade', 'run 留档 modelSource=cooldown-downgrade')
    assert.equal(board.tasks[0].runs[0].modelSource, 'cooldown-downgrade', '卡上 run 条目同留痕')
    var msgs = board.tasks[0].messages || []
    var cm = msgs.filter(function (m) { return m.kind === 'cooldown' })
    assert.equal(cm.length, 1, '卡 messages 记一条降档留痕')
    assert.match(cm[0].text, /原档模型 hw\/heavy-w 冷却中（至 \d{2}:\d{2}）/, '留痕含原档模型与冷却截止 HH:mm')
    assert.match(cm[0].text, /本 run 降档为 sw\/std-w/, '留痕含降档目标')
    assert.equal(Object.keys(state.badModels).length, 0, '降档不动 badModels')
  } finally { console.error = origErr }
})

test('冷却③b：heavy+standard+light 全链冷却 → 父模型兜底（不挂 agentOptions）', async function () {
  var board = laneBoard({ size: 'heavy' })
  var state = mkState({ modelCooldown: { 'hw/heavy-w': Date.now() + 3600000, 'sw/std-w': Date.now() + 3600000, 'lw/light-w': Date.now() + 3600000 } })
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.equal(calls[0].request.agentOptions, undefined, '全链冷却到底 → 父模型兜底')
    assert.equal(sr.modelSource, 'cooldown-downgrade')
    var cm = (board.tasks[0].messages || []).filter(function (m) { return m.kind === 'cooldown' })
    assert.equal(cm.length, 1)
    assert.match(cm[0].text, /本 run 降档为 父模型/)
  } finally { console.error = origErr }
})

// ===== ④ 过期冷却惰性清除 =====
test('冷却④：过期冷却项惰性清除，不再降档（原档直取 + 无留痕）', async function () {
  var board = laneBoard({ size: 'heavy' })
  var state = mkState({ modelCooldown: { 'hw/heavy-w': Date.now() - 1000 } }) // 已过期
  var calls = []
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(calls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(calls[0].request.agentOptions, { provider: 'hw', model: 'heavy-w' }, '过期冷却不拦原档')
    assert.equal(sr.modelSource, 'lane', '取模链照常命中 lane（非降档）')
    assert.equal(state.modelCooldown['hw/heavy-w'], undefined, '过期项被惰性清除')
    var cm = (board.tasks[0].messages || []).filter(function (m) { return m.kind === 'cooldown' })
    assert.equal(cm.length, 0, '无降档留痕')
  } finally { console.error = origErr }
})
