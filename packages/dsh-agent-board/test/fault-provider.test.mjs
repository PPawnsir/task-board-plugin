// dsh-agent-board — 可编程故障供应商层测试（test/fault-provider.test.mjs）
// 锁五档行为 + 必备观测面（验收口径）：
//   ① 秒拆文本前缀匹配 isModelKillFailure 口径——e2e 熔断旅程三连拉黑锁全链（badModels 只认模型面失败）
//   ② 限流文本能被 parseModelCooldown 命中（中文带重置形态）——e2e 冷却登记锁全链
//   ③ 目录 shrink 后 listModels/listProviders 反映（运行中可变，每次现取不缓存）
//   ④ spawn 日志逐条留痕（model 复合格式重构 = 取模链拆分点的逆操作）
//   ⑤ 缺省 createMockCtx 零故障表时行为与现状一致（hasActivationApi 路径保全 + 抽样 integration 断言路径）
//   ⑥ hang 挂死（result 永不落定 + 真日志文件 writeChildLog 布局 + 零事件）
//   ⑦ empty 空响应（output text=''; continuable 面空文本失败结算）
//   ⑧ slow 慢响应（虚拟时钟延时后正常落定）
//   ⑨ 次数窗口（times: N 前 N 次命中后自愈）
//   ⑩ llm.stream 桩（probeModel 消费口径：finish/stop 健康、finish/error+failure.message 失败）
// 端到端用例全部跑在「真实 index.mjs apply(mockCtx)」上：installFaults 必须先于 plugin.apply；
// 每用例独立 mockCtx + 独立临时 HOME，互不污染（顶层用例默认串行，严禁并行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import { installFaults } from './helpers/fault-provider.mjs'
import { parseModelCooldown } from '../lib/dispatch.mjs'
import * as plugin from '../index.mjs'

// 把 os.homedir() 钉到本用例临时 HOME（Windows 认 USERPROFILE——事件结算读子会话日志的
// findRunLog 回退路径 os.homedir()/.dsh/sessions 才能命中 <home> 下的故障日志）
function pinHomedir(env) {
  var had = Object.prototype.hasOwnProperty.call(process.env, 'USERPROFILE')
  var prev = process.env.USERPROFILE
  process.env.USERPROFILE = env.home
  return function () { if (had) process.env.USERPROFILE = prev; else delete process.env.USERPROFILE }
}
// 故障日志文件路径（writeChildLog 布局：<home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd）
function childLogPath(env, childId, bucket) {
  return path.join(env.home, '.dsh', 'sessions', bucket || 'test-bucket', childId, 'session.v4.jsonl.zstd')
}
// 建卡封装（显式 description 避开空描述软提示；pipeline=work 只做不验，验证旅程不被 Verifier 干扰）
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '故障注入任务 ' + id, description: 'fault-provider 用例 ' + id, pipeline: 'work' }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  return r.task
}
// 捕获 result 的拒绝值（裸字符串）：防御性空 catch 已由 provider 就地挂好，这里追加消费者取文本
async function rejectionOf(result) {
  var text = null
  result.catch(function (e) { text = String(e) })
  await new Promise(function (r) { setImmediate(r) })
  return text
}

// ===== 缺省①：createMockCtx 零故障时行为与现状逐字一致（零回归红线）=====
test('缺省①：零 installFaults——subagents 无 startActivation（hasActivationApi 路径保全）+ 抽样 integration 断言路径', async () => {
  var env = createMockCtx()
  try {
    assert.ok(typeof env.ctx.subagents.startActivation !== 'function', '缺省 subagents 不得带 startActivation（spawn 路径不翻）')
    assert.equal(env.faults, undefined, '缺省无 faults 观测面')
    plugin.apply(env.ctx)
    await createTask(env, 'task-z1')
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn 发生（老 startContinuable 路径）')
    assert.equal(env.continuables[0].label, 'worker:task-z1', 'spawn label 形如 worker:<taskId>')
    assert.equal(env.runs.length, 0, 'Worker 走 continuable 面，不动一次性 start')
    var t = await env.waitFor(function () { var x = env.task('task-z1'); return x && x.status === 'in-progress' && x.claimedBy === env.continuables[0].childId ? x : null }, '落卡 in-progress 且 claimedBy=childId')
    assert.ok(t.runs && t.runs[0] && t.runs[0].continuable === true, 'run 留档 continuable=true（既有口径不变）')
  } finally { await env.cleanup() }
})

// ===== 缺省②：installFaults 无 programs = 纯观察面（spawn 逐字委托 + 日志留痕 + llm 缺省空目录）=====
test('缺省②：installFaults 无 programs——spawn 逐字委托、日志留痕、llm 目录缺省空（行为与现状一致）', async () => {
  var env = createMockCtx()
  try {
    var h = installFaults(env, { programs: [] })
    plugin.apply(env.ctx)
    assert.equal(h.activation, false, '缺省不合成 startActivation（activation opt-in 缺省 false）')
    assert.ok(typeof env.ctx.subagents.startActivation !== 'function', '无 programs 时同样不加 startActivation')
    await createTask(env, 'task-z2')
    await env.clock.advance(50)
    await env.waitFor(function () { return h.spawnLog.length >= 1 }, 'worker spawn 日志留痕')
    var e = h.spawnLog[0]
    assert.equal(e.method, 'startContinuable', 'method 留痕')
    assert.equal(e.delivery, 'continuable', 'delivery 留痕（老 continuable 路径）')
    assert.equal(e.label, 'worker:task-z2', 'label 留痕')
    assert.equal(e.provider, 'mock-provider', 'provider 留痕')
    assert.equal(e.model, '', '无 modelOverride = 父模型（model 复合串为空）')
    assert.equal(e.fault, null, '无程序命中 → fault=null')
    assert.equal(env.continuables[0].label, 'worker:task-z2', 'spawn 逐字委托（原 label）')
    assert.ok(String(env.continuables[0].childId).indexOf('fault-child-') !== 0, '委托路径不产合成 childId')
    var llm = env.ctx.get('llm')
    assert.deepEqual(llm.listProviders(), [], '缺省目录空 → listProviders []（与原 recorder 一致）')
    assert.deepEqual(await llm.listModels('mock-provider'), [], '缺省目录空 → listModels []')
    assert.equal(Object.keys(h.directory.current()).length, 0, '缺省目录映射为空')
    assert.ok(env.llm.listProviders >= 1, 'llm 调用留痕计数照常累加（原记录器口径）')
  } finally { await env.cleanup() }
})
// ===== 五档③：one-shot start 路径五档行为（秒拆/限流/空/慢/挂 + 结果面形态 + spawn 日志逐条）=====
test('五档③：one-shot start 路径——秒拆/限流/空/慢/挂 各档行为 + 结果面形态 + spawn 日志逐条留痕', async () => {
  var env = createMockCtx()
  try {
    var FIXED = new Date(2026, 9, 27, 19, 0, 0).getTime()
    var h = installFaults(env, { programs: [
      { type: 'instant-kill', diagnostic: 'mock-fault: unit' },
      { type: 'rate-limit', resetAt: FIXED },
      { type: 'empty' },
      { type: 'slow', delayMs: 100, text: 'slow 交付' },
      { type: 'hang' },
    ] })
    var sub = env.ctx.subagents
    // ① instant-kill：result 以裸字符串拒，前缀锚定 isModelKillFailure 口径
    var run1 = await sub.start('p', { label: 'worker:t1' })
    assert.equal(run1.__fault, 'instant-kill', '__fault 留档')
    var t1 = await rejectionOf(run1.result)
    assert.ok(t1 !== null && t1.indexOf('子会话被宿主拆除（stopReason: error') === 0, '秒拆前缀（isModelKillFailure 锚定口径，裸字符串不被 Error: 前缀污染）')
    assert.ok(t1.indexOf('子会话被宿主拆除（stopReason: completed') !== 0, 'stopReason 非 completed（计入熔断）')
    assert.ok(t1.indexOf('mock-fault: unit') > 0, 'diagnostic 落文本')
    // ④ rate-limit：裸字符串拒 + parseModelCooldown 中文带重置命中（精确 until）
    var run2 = await sub.start('p', { label: 'worker:t2' })
    var t2 = await rejectionOf(run2.result)
    assert.ok(t2 !== null && t2.indexOf('429') === 0, '429 开头')
    var hit = parseModelCooldown(t2)
    assert.ok(hit && hit.kind === 'rate-limit' && hit.parsed === true, '限流文本被 parseModelCooldown 命中（中文带重置形态）')
    assert.equal(hit.until, FIXED, '重置时刻 = 程序 resetAt（本地时区精确 ts）')
    // ③ empty：落定 output text=''
    var run3 = await sub.start('p', { label: 'worker:t3' })
    var r3 = await run3.result
    assert.equal(r3.stopReason, 'completed', '空响应 stopReason=completed')
    assert.equal(r3.output[0].text, '', '空响应 output text=\'\'')
    // ⑤ slow：延时（虚拟时钟）后正常落定
    var run4 = await sub.start('p', { label: 'worker:t4' })
    var settledEarly = false
    run4.result.then(function () { settledEarly = true })
    await new Promise(function (r5) { setImmediate(r5) })
    assert.equal(settledEarly, false, '延时未到不落定（虚拟时钟掌控）')
    await env.clock.advance(150)
    var r4 = await run4.result
    assert.equal(r4.stopReason, 'completed')
    assert.equal(r4.output[0].text, 'slow 交付', '延时后正常落定（可编程延时）')
    // ② hang：result 永不落定零事件 + 真日志文件（writeChildLog 布局）
    var run5 = await sub.start('p', { label: 'worker:t5' })
    var settled5 = false
    run5.result.then(function () { settled5 = true })
    await new Promise(function (r6) { setTimeout(r6, 30) })
    assert.equal(settled5, false, '挂死永不落定')
    var lp = childLogPath(env, run5.id)
    assert.ok(fs.existsSync(lp), '挂死真日志文件已写（<home>/.dsh/sessions/<桶>/<runId>/session.v4.jsonl.zstd）')
    assert.ok(fs.statSync(lp).size > 0, '日志文件非空（零产出检测 logSizeOf 有基线）')
    // spawn 日志：5 条逐条留痕（model 复合格式重构 + fault 分档）
    assert.equal(h.spawnLog.length, 5, 'spawn 日志逐条留痕')
    assert.deepEqual(h.spawnLog.map(function (e) { return e.method }), ['start', 'start', 'start', 'start', 'start'])
    assert.deepEqual(h.spawnLog.map(function (e) { return e.fault }), ['instant-kill', 'rate-limit', 'empty', 'slow', 'hang'])
    assert.deepEqual(h.spawnLog.map(function (e) { return e.label }), ['worker:t1', 'worker:t2', 'worker:t3', 'worker:t4', 'worker:t5'])
  } finally { await env.cleanup() }
})

// ===== 次数窗口④：times: 2 → 前 2 次秒拆后自愈（第 3 次起逐字委托原 start）=====
test('次数窗口④：times: 2——前 2 次秒拆后自愈（连败软闸/恢复旅程场景）', async () => {
  var env = createMockCtx()
  try {
    var h = installFaults(env, { programs: [{ type: 'instant-kill', times: 2 }] })
    var sub = env.ctx.subagents
    var run1 = await sub.start('p', { label: 'worker:t1' })
    await assert.rejects(function () { return run1.result }, function (e) { return String(e).indexOf('子会话被宿主拆除') === 0 }, '第 1 次秒拆')
    var run2 = await sub.start('p', { label: 'worker:t2' })
    await assert.rejects(function () { return run2.result }, function (e) { return String(e).indexOf('子会话被宿主拆除') === 0 }, '第 2 次秒拆')
    var run3 = await sub.start('p', { label: 'worker:t3' })
    assert.equal(run3.__fault, undefined, '第 3 次起自愈（无 __fault）')
    assert.ok(String(run3.id).indexOf('fault-run-') !== 0, '第 3 次起逐字委托原 start（原 run id 形态）')
    assert.ok(typeof run3.resolveWith === 'function', '委托 run 保留原结算驱动器')
    run3.resolveWith('自愈交付')
    var r3 = await run3.result
    assert.equal(r3.output[0].text, '自愈交付', '委托 run 的测试驱动结算照常可用')
    assert.deepEqual(h.spawnLog.map(function (e) { return e.fault }), ['instant-kill', 'instant-kill', null], 'spawn 日志 fault 分档（前 2 后自愈）')
    assert.equal(h.programs[0].used, 2, '次数窗口消耗 2 次')
    assert.equal(h.programs[0].done, true, 'times 用尽即 done（自愈）')
  } finally { await env.cleanup() }
})
// ===== 观测面⑤：llm 目录可编程且运行中可变（shrink/add 即刻生效，每次现取不缓存）=====
test('观测面⑤：llm 目录可编程且运行中可变——shrink/add 即刻生效（每次现取不缓存）', async () => {
  var env = createMockCtx()
  try {
    var h = installFaults(env, { directory: ['prov-a/model-a', 'prov-a/model-b', 'prov-b/model-x'] })
    var llm = env.ctx.get('llm')
    assert.deepEqual(llm.listProviders().map(function (p) { return p.id }), ['prov-a', 'prov-b'], '目录 → provider 清单（首段 slash 拆分）')
    assert.deepEqual((await llm.listModels('prov-a')).map(function (m) { return m.id }), ['model-a', 'model-b'], 'provider → model 清单')
    assert.deepEqual((await llm.listModels('prov-b')).map(function (m) { return m.id }), ['model-x'])
    // 运行中 shrink：listModels 每次现取不缓存（目录失效场景靠中途 shrink 实现）
    h.directory.remove('prov-a/model-b')
    assert.deepEqual((await llm.listModels('prov-a')).map(function (m) { return m.id }), ['model-a'], 'shrink 后 listModels 反映')
    assert.equal(h.directory.has('prov-a/model-b'), false, 'has 反映 shrink')
    h.directory.add('prov-a/model-c')
    assert.deepEqual((await llm.listModels('prov-a')).map(function (m) { return m.id }), ['model-a', 'model-c'], 'add 即刻生效')
    h.directory.set(['prov-z/only'])
    assert.deepEqual(llm.listProviders().map(function (p) { return p.id }), ['prov-z'], 'set 整体替换')
    // 目录失效闸 e2e 在下方独立用例；这里锁 API 面本身
    assert.ok(typeof h.directory.remove === 'function' && typeof h.directory.add === 'function', '目录操作面在位')
  } finally { await env.cleanup() }
})

// ===== 观测面⑤b：llm.stream 桩（probeModel 消费口径：finish/stop 健康、finish/error+failure.message 失败）=====
test('观测面⑤b：llm.stream 桩——健康 finish/stop、per-model error+failure.message、文本可被 parseModelCooldown 命中', async () => {
  var env = createMockCtx()
  try {
    installFaults(env, {
      directory: { 'prov-a/model-a': true, 'prov-a/bad-m': true },
      stream: { 'prov-a/bad-m': { kind: 'error', message: '429 RATE_LIMIT: 限额将在 2026-10-27 19:00:00 重置' } },
    })
    var llm = env.ctx.get('llm')
    // 健康：finish/stop（probeModel 消费口径——证明模型链路可用）
    var ok = []
    for await (var c of llm.stream({ provider: 'prov-a', model: 'model-a', messages: [], maxTokens: 1 })) ok.push(c)
    assert.equal(ok.length, 1, '健康流单 finish 帧')
    assert.equal(ok[0].type, 'finish')
    assert.equal(ok[0].reason.kind, 'stop', '健康 = finish/stop')
    // 失败：finish/error + failure.message（probeModel 读 failure.message 为失败文本）
    var bad = []
    for await (var c2 of llm.stream({ provider: 'prov-a', model: 'bad-m', messages: [], maxTokens: 1 })) bad.push(c2)
    assert.equal(bad[0].type, 'finish')
    assert.equal(bad[0].reason.kind, 'error', '失败 = finish/error')
    assert.ok(String(bad[0].reason.failure.message).indexOf('429 RATE_LIMIT') === 0, 'failure.message 携带故障文本')
    // probeModel 消费口径复演：failure.message 文本可被 parseModelCooldown 命中（冷却登记链路可用）
    var hit = parseModelCooldown(bad[0].reason.failure.message)
    assert.ok(hit && hit.kind === 'rate-limit' && hit.parsed === true, 'stream 失败文本可进冷却登记链路')
    assert.equal(env.llm.streams.length, 2, 'stream 调用留痕（prov/model 复合串）')
    assert.equal(env.llm.streams[1].model, 'prov-a/bad-m', 'stream 留痕按复合串拼回')
  } finally { await env.cleanup() }
})
// ===== e2e⑥：秒拆三连熔断旅程（activation 契约一次性面）——kill 前缀全链命中 + badModels 拉黑 + 取模链跳模型 =====
// 一次性面（workerContinuable:false）：失败重试恒为 fresh spawn（one-shot 无续跑资格，不经
// tryResumeWorker）；kill 以 run.result 裸字符串拒 → settleRun String(err) 直接前缀命中 isModelKillFailure。
test('e2e⑥：秒拆三连熔断旅程——kill 前缀全链命中 + badModels 拉黑 + 任务 blocked + 取模链跳模型', async () => {
  var env = createMockCtx()
  var restoreHome = pinHomedir(env)
  try {
    var h = installFaults(env, { activation: true, programs: [{ type: 'instant-kill', times: 3 }] })
    plugin.apply(env.ctx)
    await createTask(env, 'task-kill')
    env.patchBoard(function (d) { d.workerModel = 'prov/glm-kill'; d.workerContinuable = false }) // 一次性面：重试恒 fresh spawn
    for (var round = 1; round <= 3; round++) {
      await env.clock.advance(50)
      await env.waitFor(function () { return h.spawnLog.length >= round }, '第 ' + round + ' 轮 spawn')
      var e = h.spawnLog[round - 1]
      assert.equal(e.method, 'startActivation', 'activation 契约（opt-in 后 spawn 翻到新路径）')
      assert.equal(e.delivery, 'caller', '一次性面走 delivery=caller（run.result 结算）')
      assert.equal(e.model, 'prov/glm-kill', '取模链命中板级模型（agentOptions 复合串重构）')
      assert.equal(e.fault, 'instant-kill', '故障程序命中留痕')
      if (round < 3) await env.waitFor(function () { var x = env.task('task-kill'); return x && x.retryCount === round ? x : null }, '第 ' + round + ' 轮失败结算（retryCount）')
    }
    // 3 连 → 任务 blocked（worker 失败 x3）+ badModels 拉黑（isModelKillFailure 前缀全链命中）
    var t = await env.waitFor(function () { var x = env.task('task-kill'); return x && x.status === 'blocked' ? x : null }, '三连失败 blocked')
    assert.equal(t.retryCount, 3, 'retryCount 计满 3')
    assert.ok(String(t.lastError).indexOf('子会话被宿主拆除（stopReason: error') === 0, 'lastError 前缀（run.result 裸字符串拒 → String(err) 口径，isModelKillFailure 命中）')
    // 熔断拉黑（badModels 只认模型面失败）：下一张同模型任务的 spawn 跳过该模型（父模型兜底 → model=''）
    await createTask(env, 'task-after')
    await env.clock.advance(50)
    await env.waitFor(function () { return h.spawnLog.length >= 4 }, '熔断后 spawn')
    assert.equal(h.spawnLog[3].model, '', '熔断模型被取模链跳过（父模型兜底，agentOptions 不挂）——kill 前缀喂进熔断的全链证明')
    assert.equal(h.spawnLog[3].fault, null, 'times: 3 已自愈（第 4 次 spawn 无故障）')
    // 健康面 circuit 状态（get-tasks modelHealthView 公开口径）
    var gt = await env.rpc('get-tasks', { sessionId: env.sid })
    var mh = gt.modelHealth || (gt.data && gt.data.modelHealth) || {}
    assert.equal(mh['prov/glm-kill'] && mh['prov/glm-kill'].state, 'circuit', '健康面 circuit 状态（badModels 拉黑公开可见）')
  } finally { restoreHome(); await env.cleanup() }
})

// ===== e2e⑦：限流旅程——429 文本全链被 parseModelCooldown 命中（冷却登记 + 卡 messages 留痕 + 取模链跳过）=====
test('e2e⑦：限流旅程——429 文本全链命中（冷却登记 + 卡 messages 额度冷却留痕 + 取模链跳模型 + 健康面 cooldown）', async () => {
  var env = createMockCtx()
  var restoreHome = pinHomedir(env)
  try {
    var h = installFaults(env, { activation: true, programs: [{ type: 'rate-limit', resetInMs: 5 * 60000 }] })
    plugin.apply(env.ctx)
    await createTask(env, 'task-rl')
    env.patchBoard(function (d) { d.workerModel = 'prov/glm-rl' })
    await env.clock.advance(50)
    await env.waitFor(function () { return h.spawnLog.length >= 1 }, '第 1 轮 spawn')
    assert.equal(h.spawnLog[0].model, 'prov/glm-rl', '取模链命中板级模型')
    assert.equal(h.spawnLog[0].fault, 'rate-limit', '限流程序命中留痕')
    // 失败结算 → 冷却登记（settleWorker 失败臂 sniffModelCooldown②，先写卡）→ 失败臂重排（retryCount+1）。
    // 两笔是分开的持锁写——waitFor 必须同时等到 retryCount 与冷却留痕（不能捕获中间态快照）。
    var t = await env.waitFor(function () { var x = env.task('task-rl'); return x && x.retryCount === 1 && x.messages && x.messages.some(function (m) { return m.kind === 'cooldown' }) ? x : null }, '冷却登记 + 失败结算落卡')
    var cm = t.messages.filter(function (m) { return m.kind === 'cooldown' })[0]
    assert.ok(cm.text.indexOf('额度冷却至') >= 0, '限流分态留痕（「额度冷却至 HH:mm」）')
    assert.equal(t.retryCount, 1, '失败结算 retryCount+1')
    // 取模链冷却跳过：重派 spawn 走父模型兜底（cooldown → 降档链空 → parent）
    await env.clock.advance(50)
    await env.waitFor(function () { return h.spawnLog.length >= 2 }, '冷却后重派 spawn')
    assert.equal(h.spawnLog[1].model, '', '冷却模型被取模链跳过（父模型兜底）——429 文本进冷却表的全链证明')
    assert.equal(h.spawnLog[1].fault, null, 'times 缺省=1 已自愈')
    // 健康面 cooldown 状态 + until 精确 ts（重置时刻可编程）
    var gt = await env.rpc('get-tasks', { sessionId: env.sid })
    var mh = gt.modelHealth || (gt.data && gt.data.modelHealth) || {}
    var entry = mh['prov/glm-rl']
    assert.ok(entry && entry.state === 'cooldown', '健康面 cooldown 状态')
    assert.ok(entry.until > Date.now() && entry.until <= Date.now() + 6 * 60000, 'until ≈ now+5min（重置时刻可编程）')
  } finally { restoreHome(); await env.cleanup() }
})
// ===== e2e⑧：挂死旅程（缺省 continuable 路径）——childId 返回零事件 + 真日志文件 + rec 挂 running =====
test('e2e⑧：挂死旅程（缺省 continuable 路径）——childId 返回零事件 + 真日志文件（writeChildLog 布局）+ 持续 running 假相', async () => {
  var env = createMockCtx()
  var restoreHome = pinHomedir(env)
  try {
    var h = installFaults(env, { programs: [{ type: 'hang' }] })
    plugin.apply(env.ctx)
    await createTask(env, 'task-hang')
    env.patchBoard(function (d) { d.workerModel = 'prov/glm-hang' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, '挂死 spawn 发生')
    var c = env.continuables[0]
    assert.equal(c.label, 'worker:task-hang')
    assert.equal(c.__fault, 'hang', '挂死程序命中（__fault 留档）')
    await env.waitFor(function () { var x = env.task('task-hang'); return x && x.status === 'in-progress' ? x : null }, '落卡 in-progress')
    // 真日志文件（挂死零产出检测 hungZeroOutputSweep 的 logSizeOf 基线）
    var lp = childLogPath(env, c.childId)
    assert.ok(fs.existsSync(lp) && fs.statSync(lp).size > 0, '挂死真日志文件（<home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd）')
    // 零事件：推进多轮虚拟时间也不结算（无 running→idle 重放、result 永不落定）
    await env.clock.advance(200)
    var t2 = env.task('task-hang')
    assert.equal(t2.status, 'in-progress', '零事件——挂死 run 持续 running 假相（不报错不结算）')
    assert.equal(h.spawnLog[0].fault, 'hang')
    assert.equal(h.spawnLog[0].model, 'prov/glm-hang')
  } finally { restoreHome(); await env.cleanup() }
})

// ===== e2e⑨：空响应旅程（缺省 continuable 路径）——空 assistant 日志 + idle 重放 → 空文本失败结算重排 =====
test('e2e⑨：空响应旅程（缺省 continuable 路径）——空 assistant 日志 + idle 重放 → 空文本按失败结算重排', async () => {
  var env = createMockCtx()
  var restoreHome = pinHomedir(env)
  try {
    var h = installFaults(env, { programs: [{ type: 'empty' }] })
    plugin.apply(env.ctx)
    await createTask(env, 'task-empty')
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'spawn 发生')
    var c = env.continuables[0]
    assert.equal(c.__fault, 'empty')
    // 空响应：settleContinuable 读到空文本按失败结算（pending 重排，绝不当成空完成推进 verifying）
    var t = await env.waitFor(function () { var x = env.task('task-empty'); return x && x.retryCount === 1 ? x : null }, '空文本失败结算（retryCount 1）')
    assert.ok(t.lastError, '失败原因落卡留痕')
    assert.equal(t.status, 'pending', '失败 → 重新排队')
    assert.ok(h.spawnLog[0].fault === 'empty' && h.spawnLog[0].method === 'startContinuable')
  } finally { restoreHome(); await env.cleanup() }
})
// ===== 五档⑩：activation 契约各档行为 + delivery 记录 + teardown 形态 =====
test('五档⑩：activation 契约（opt-in）——startActivation 各档行为 + delivery 记录 + teardown 拆除落定形态', async () => {
  var env = createMockCtx()
  try {
    var FIXED = new Date(2026, 9, 27, 20, 0, 0).getTime()
    var h = installFaults(env, {
      activation: true,
      healthyText: 'activation 健康交付',
      programs: [
        { type: 'instant-kill', diagnostic: 'act-kill' },
        { type: 'rate-limit', resetAt: FIXED, form: 'teardown' },
        { type: 'empty' },
        { type: 'slow', delayMs: 80, text: 'act slow 交付' },
        { type: 'hang' },
      ],
    })
    var sub = env.ctx.subagents
    // ① instant-kill：result 裸字符串拒（前缀口径同 one-shot；activation 拒绝臂包「子会话 activation 异常：」仍命中）
    var act1 = await sub.startActivation({ provider: 'p', label: 'worker:t1', request: { prompt: 'x' }, delivery: 'parent' })
    assert.equal(act1.__fault, 'instant-kill')
    var t1 = await rejectionOf(act1.result)
    assert.ok(t1 !== null && t1.indexOf('子会话被宿主拆除（stopReason: error') === 0, '秒拆前缀')
    // ④ rate-limit teardown 形态：result 以 { stopReason:'error', diagnostic } 落定（dispatch 拆除臂构造前缀）
    var act2 = await sub.startActivation({ provider: 'p', label: 'worker:t2', request: { prompt: 'x' }, delivery: 'parent' })
    var r2 = await act2.result
    assert.equal(r2.stopReason, 'error', 'teardown 落定 stopReason=error')
    assert.ok(String(r2.diagnostic).indexOf('429 RATE_LIMIT') === 0, 'diagnostic 携带限流文本')
    var tornText = '子会话被宿主拆除（stopReason: error，' + r2.diagnostic + '）'
    var hit2 = parseModelCooldown(tornText)
    assert.ok(hit2 && hit2.kind === 'rate-limit' && hit2.parsed === true && hit2.until === FIXED, 'teardown 文本经拆除臂构造后仍被 parseModelCooldown 命中（精确 ts）')
    // ③ empty：写空 assistant 日志 + idle 重放（result 不落定——parked 正常完成语义）
    var act3 = await sub.startActivation({ provider: 'p', label: 'worker:t3', request: { prompt: 'x' }, delivery: 'parent' })
    assert.ok(fs.existsSync(childLogPath(env, act3.childId)), '空响应日志已写')
    var s3 = false
    act3.result.then(function () { s3 = true })
    await new Promise(function (r) { setTimeout(r, 30) })
    assert.equal(s3, false, '空响应 parked——result 不落定')
    // ⑤ slow：延时后写健康日志 + idle 重放
    var act4 = await sub.startActivation({ provider: 'p', label: 'worker:t4', request: { prompt: 'x' }, delivery: 'parent' })
    await new Promise(function (r) { setTimeout(r, 30) })
    assert.ok(!fs.existsSync(childLogPath(env, act4.childId)), '延时未到日志未写')
    await env.clock.advance(150)
    await new Promise(function (r) { setTimeout(r, 30) })
    assert.ok(fs.existsSync(childLogPath(env, act4.childId)), 'slow 健康日志延时后写入')
    // ② hang：日志 + 永不落定
    var act5 = await sub.startActivation({ provider: 'p', label: 'worker:t5', request: { prompt: 'x' }, delivery: 'parent' })
    assert.ok(fs.existsSync(childLogPath(env, act5.childId)), '挂死日志已写')
    var s5 = false
    act5.result.then(function () { s5 = true })
    await new Promise(function (r) { setTimeout(r, 30) })
    assert.equal(s5, false, '挂死永不落定')
    // delivery='caller'：一次性面——健康合成 result 正常落定（无故障时）
    var act6 = await sub.startActivation({ provider: 'p', label: 'verifier:t6', request: { prompt: 'x' }, delivery: 'caller' })
    var r6 = await act6.result
    assert.equal(r6.output[0].text, 'activation 健康交付', 'caller 面健康合成 result 正常落定')
    // spawn 日志：delivery/method/fault 逐条
    assert.deepEqual(h.spawnLog.map(function (e) { return e.delivery }), ['parent', 'parent', 'parent', 'parent', 'parent', 'caller'], 'delivery 逐条留痕')
    assert.deepEqual(h.spawnLog.map(function (e) { return e.fault }), ['instant-kill', 'rate-limit', 'empty', 'slow', 'hang', null], 'fault 分档逐条留痕')
  } finally { await env.cleanup() }
})

// ===== 五档⑪：老 startContinuable（无 result 承诺）——instant-kill/rate-limit 只能 spawn 层拒 =====
test('五档⑪：老 startContinuable——instant-kill/rate-limit spawn 层拒（throw，不产子会话）', async () => {
  var env = createMockCtx()
  try {
    var h = installFaults(env, { programs: [{ type: 'instant-kill' }, { type: 'rate-limit' }] })
    var sub = env.ctx.subagents
    await assert.rejects(function () { return sub.startContinuable({ provider: 'p', label: 'worker:t1', request: {} }) }, function (e) { return e.message.indexOf('子会话被宿主拆除（stopReason: error') === 0 }, '秒拆 spawn 层拒（e.message 前缀）')
    await assert.rejects(function () { return sub.startContinuable({ provider: 'p', label: 'worker:t2', request: {} }) }, function (e) { return e.message.indexOf('429') === 0 }, '限流 spawn 层拒')
    assert.deepEqual(h.spawnLog.map(function (e) { return e.fault }), ['instant-kill', 'rate-limit'], 'spawn 日志留痕')
    assert.equal(env.continuables.length, 0, 'spawn 层拒不产子会话（dispatch catch 冷却嗅探①通道消费）')
  } finally { await env.cleanup() }
})

// ===== 剧本⑫：match 过滤（role/method）+ 多程序按序共存 =====
test('剧本⑫：match 过滤（role/method）+ 多程序按序共存（first-match-wins + times 自愈）', async () => {
  var env = createMockCtx()
  try {
    var h = installFaults(env, { programs: [
      { type: 'instant-kill', times: 1, match: { role: 'verifier' } },
      { type: 'slow', delayMs: 50, match: { method: 'start' } },
    ] })
    var sub = env.ctx.subagents
    var w1 = await sub.start('p', { label: 'worker:t1' }) // slow 命中（method=start）
    await env.clock.advance(100)
    var r1 = await w1.result
    assert.equal(r1.stopReason, 'completed', 'slow 命中后正常落定')
    var v1 = await sub.start('p', { label: 'verifier:t1' }) // instant-kill 命中（role=verifier）
    await assert.rejects(function () { return v1.result }, function (e) { return String(e).indexOf('子会话被宿主拆除') === 0 }, 'verifier 角色过滤命中秒拆')
    var w2 = await sub.start('p', { label: 'worker:t2' }) // slow 已自愈 → 委托原 start
    assert.equal(w2.__fault, undefined, 'times 用尽后自愈（逐字委托）')
    assert.deepEqual(h.spawnLog.map(function (e) { return e.fault }), ['slow', 'instant-kill', null], '多程序按序消费留痕')
  } finally { await env.cleanup() }
})

// ===== 观测面⑬：目录失效闸 e2e——中途 shrink 后下一 spawn 跳过目录外模型（outOfDir 闸）=====
test('观测面⑬：目录失效闸 e2e——中途 shrink 后下一 spawn 跳过目录外模型（stale-model 留痕落卡）', async () => {
  var env = createMockCtx()
  try {
    var h = installFaults(env, { directory: { 'prov/m1': true, 'prov/m2': true }, programs: [] })
    plugin.apply(env.ctx)
    await createTask(env, 'task-da')
    env.patchBoard(function (d) { d.tasks[0].model = 'prov/m1' })
    await env.clock.advance(50)
    await env.waitFor(function () { return h.spawnLog.length >= 1 }, 'spawn a')
    assert.equal(h.spawnLog[0].model, 'prov/m1', '目录内模型正常命中')
    h.directory.remove('prov/m1') // 中途 shrink（目录失效：目录仍有 prov/m2 非空 → outOfDir 闸生效）
    await createTask(env, 'task-db')
    env.patchBoard(function (d) { d.tasks[1].model = 'prov/m1' })
    await env.clock.advance(50)
    await env.waitFor(function () { return h.spawnLog.length >= 2 }, 'spawn b')
    assert.equal(h.spawnLog[1].model, '', '目录外模型被 outOfDir 闸跳过（父模型兜底）')
    var tb = await env.waitFor(function () { var x = env.task('task-db'); return x && x.messages && x.messages.some(function (m) { return m.kind === 'stale-model' }) ? x : null }, 'stale-model 留痕落卡')
    assert.ok(tb.messages.some(function (m) { return m.kind === 'stale-model' && m.text.indexOf('prov/m1') >= 0 }), 'stale-model 留痕带模型 id')
  } finally { await env.cleanup() }
})
