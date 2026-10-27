// ===== 故障 E2E：秒拆三连 → 熔断拉黑 + 取模链跳过 + 卡三连败阻塞（真派发循环，task-mvqi3uj4-2）=====
// 背景：task-mvowb2hc 洞①（宿主秒拆喂熔断）的单测面已由 spawn-activation.test.mjs ⑩⑪⑫ 薄桩锁定
//（直调 spawnOneShot 手工喂 settle）。本文件补端到端回归：跑在「真实 index.mjs apply(faultCtx)」
// 全循环上（integration.test.mjs harness 同款：rpc create-task → clock.advance(50) 踢 poolCycle →
// waitFor 收敛），锁定「秒拆不喂熔断」的派发循环闭环——熔断拉黑后下一轮取模链真跳过病模型，
// 而非单点连击计数。
//
// 故障层两接缝（applyFaults）：
//   ① 故障 llm 目录：set-board-config 模型校验经 enumModels() 枚举 llm 清单（rpc.mjs，list-models
//      同源）——默认 mock-ctx 的 llm 记录器 listProviders 返回 []（空清单），'prov/sick' 不命中 →
//      拒写「非法模型 id」（rpc.mjs set-board-config 模型校验）。故障层必须先把 prov/sick + prov/alt
//      放进 llm 目录 set-board-config 才放行——这正是「目录闸」接缝的价值（dispatch 侧 modelDirectory
//      同源：候选在册 = outOfDir 不拦，病模型才进得了取模链）。
//   ② 故障表 + 新契约 activation：subagents 补 startActivation（hasActivationApi 探测点）→ 派发走
//      v0.2.1 新契约路径；faultTable 标 instant-kill 的模型（按 spec.request.agentOptions.model 命中）
//      spawn 即拆除——activation.result 以拆机原形文本立即拒绝（秒拒）。一次性路径（workerContinuable
//      =false）的 run.result 拒绝经 withTimeout race 臂 finish(null, err) → settleRun → settleWorker
//      失败臂（errText=String(err)，故故障值用拆机原形字符串注入，isModelKillFailure 前缀口径命中）
//      → feedModelFailure（dispatch.mjs L1665 接线）+ settleRunRecord 关账 timeout/error。
//      连击三连（L249 WORKER_MODEL_CIRCUIT_AFTER=3）→ badModels 拉黑 + pushSysNote 秒拆分态文案（L285）。
//
// 断言（四条，对应任务口径）：
//   ① 第三次秒拆后新卡（基建卡）spawn 日志的 agentOptions 不再带 prov/sick——badModels 熔断生效，
//      取模链跳过病模型命中备用链（fallbackModels=['prov/alt']），观测点=故障层记录的 spawn spec
//      （不是单测直读 state）；
//   ② 病模型卡 retryCount=3 → blocked（L1666 三连败语义不变）；
//   ③ 卡 runs 三条留档 outcome=timeout/error（model 全=prov/sick、modelSource=board，重派全 fresh spawn）；
//   ④ 回执冲刷后系统通知含「秒拆」分态文案（非挂死零产出文案，L285 vs L261 分态）。
//
// 为什么一次性回退开关（workerContinuable=false）：continuable 拆除臂路径的 runs 留档经幽灵回收
// 关 incomplete（reapGhostRecs 只补收尾），且失败重派会被续跑闸劫持（sendMessage 冷复活已死会话）——
// 一次性路径 run.result 拒绝经 race 臂关账 timeout/error（与挂死判死/一次性失败同一口径），重派恒
// fresh spawn（resumeTarget 对非 continuable 恒空），三连循环确定性收敛、零续跑干扰。
// 注意：connectivity 嗅探关键词（连接/超时/网关/limit 等）不进拆机文案——否则病模型被误登记冷却，
// 三连循环在第二拆就会被冷却闸截断（熔断与冷却两张表各管各的，本场景只测熔断）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

var SICK = 'prov/sick'
var ALT = 'prov/alt'
// 拆机原形文本（dispatch.mjs activation 拆除臂同款前缀；diagnostic 避开冷却嗅探关键词）
var TEARDOWN_TEXT = '子会话被宿主拆除（stopReason: error，宿主秒拆注入）'

// ===== 故障层：llm 目录接缝 + 故障表 activation 秒拆注入 =====
function applyFaults(env, faultTable) {
  faultTable = faultTable || {}
  // 接缝①：故障层 llm 目录（prov/sick + prov/alt 在册）——set-board-config 模型校验与 dispatch
  // modelDirectory 同源数据面；不加这层默认 mock llm 空清单 → set-board-config workerModel 拒写
  var origGet = env.ctx.get
  env.ctx.get = function (name) {
    if (name === 'llm') {
      return {
        listProviders: function () { return [{ id: 'prov', name: 'prov' }] },
        listModels: async function (pid) { return pid === 'prov' ? [{ id: 'sick', name: 'sick' }, { id: 'alt', name: 'alt' }] : [] },
      }
    }
    return origGet(name)
  }
  // 接缝②：新契约 activation（hasActivationApi 探测点）+ 故障表秒拆。
  // calls = spawn 日志观测点（断言①读 spec.request.agentOptions，不直读 state.badModels）。
  var calls = []
  var n = 0
  env.ctx.subagents.startActivation = async function (spec) {
    calls.push(spec)
    var ao = spec.request && spec.request.agentOptions
    if (ao && ao.model && faultTable['prov/' + ao.model] === 'instant-kill') {
      // 拒绝值=拆机原形文本字符串：settleRun 的 errText=String(err) → isModelKillFailure 前缀命中；
      // 空窗 catch：race 臂挂载前的微任务窗口防 unhandled rejection（拒绝值另有 race 臂消费）
      var result = Promise.reject(TEARDOWN_TEXT)
      result.catch(function () {})
      return { childId: 'child-' + (++n), messageId: 'm' + n, result: result, dispose: async function () {} }
    }
    return { childId: 'child-' + (++n), messageId: 'm' + n, result: new Promise(function () {}), dispose: async function () {} }
  }
  return { calls: calls }
}

// 三键写入（目录闸接缝的实证步骤）：workerModel + fallbackModels + workerContinuable
async function writeBoardConfig(env) {
  var wm = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerModel', value: SICK })
  assert.equal(wm.ok, true, '故障层 llm 目录在册 → set-board-config workerModel=prov/sick 放行')
  var fb = await env.rpc('set-board-config', { sessionId: env.sid, key: 'fallbackModels', value: [ALT] })
  assert.equal(fb.ok, true, 'fallbackModels=[prov/alt] 在册放行')
  var wc = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerContinuable', value: false })
  assert.equal(wc.ok, true, 'workerContinuable=false（一次性回退开关）')
}

// 建卡封装：显式 description 避开空描述软提示
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '故障E2E ' + id, description: '故障回归用例 ' + id }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  return r.task
}

function transitions(t) { return (t.history || []).map(function (h) { return h.from + '→' + h.to }) }

// ===== 主场景：秒拆三连 → 熔断拉黑 + 取模链跳过 + 三连败 blocked（真派发循环）=====
// 与 spawn-activation.test.mjs ⑩ 的差异：⑩ 是薄桩 mkActivationSubagents 单测（直调 spawnOneShot
// 手工喂 settle）；本用例跑真 poolCycle 重派循环（rpc create-task → clock.advance(50) 踢 poolCycle →
// settleWorker 失败臂 kickCycle → 下一轮 poolCycle 自动重派），验证「熔断 → 下轮取模跳过」闭环。
test('故障E2E·秒拆三连：activation.result 秒拒×3 → 熔断拉黑 + 新卡取模链跳过病模型 + 病卡三连败 blocked（真 poolCycle 循环）', async () => {
  var env = createMockCtx()
  try {
    var faults = applyFaults(env, { 'prov/sick': 'instant-kill' })
    plugin.apply(env.ctx)
    await writeBoardConfig(env)
    // 建病模型卡 → 50ms 去抖踢 poolCycle → spawn 于 sick → activation.result 秒拒 →
    // race 臂 finish(null, err) → settleRun → settleWorker 失败臂（L1665 feedModelFailure 连击 1）
    await createTask(env, 'task-s1', { pipeline: 'work' })
    await env.clock.advance(50)
    // 三个 waitFor 一律等「结算链尾」：settleWorker 的状态推进与 settleRunRecord 的 run 关账是两次
    // 持锁写（settleRun L1329 → L1338），只等状态会撞上「pending 已落盘而 run 留档还未关账」的窗口
    //（与集成套件「approved 落 resolved 且 verifier run 关账」同一口径）。
    var t = await env.waitFor(function () {
      var x = env.task('task-s1')
      return x && x.status === 'pending' && x.retryCount === 1 && x.runs && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null
    }, '秒拆#1 结算：activation.result 秒拒 → settleWorker 失败臂回 pending 且 run 关账 timeout/error（等链尾）')
    assert.equal(t.runs.length, 1, '首拆一条 run 留档')
    assert.equal(t.runs[0].outcome, 'timeout/error', '首拆关账 timeout/error（race 臂 → settleRun → settleRunRecord）')
    assert.ok(String(t.lastError).indexOf('被宿主拆除') >= 0, '失败原因落卡（lastError，排查三连败不靠猜）')
    assert.equal(env.continuables.length, 0, '一次性路径零 continuable 子会话')
    assert.equal(env.runs.length, 0, '一次性路径零一次性 start run（走 startActivation 新契约）')
    // 自动重派 ×2 同样秒拆（settleWorker 失败臂 kickCycle → 下一轮 poolCycle → fresh spawn 于 sick；
    // 板级候选只过 badModels 熔断闸不受连败软闸拦，连击 1/2 未达阈值照取板级 sick）
    await env.clock.advance(50)
    t = await env.waitFor(function () { var x = env.task('task-s1'); return x && x.status === 'pending' && x.retryCount === 2 && x.runs && x.runs[1] && x.runs[1].outcome === 'timeout/error' ? x : null }, '秒拆#2 自动重派同样秒拆且关账（等链尾）')
    assert.equal(t.runs.length, 2, '两拆两条留档')
    await env.clock.advance(50)
    t = await env.waitFor(function () { var x = env.task('task-s1'); return x && x.status === 'blocked' && x.retryCount === 3 && x.runs && x.runs[2] && x.runs[2].outcome === 'timeout/error' ? x : null }, '秒拆#3 → 三连败 blocked 且第三条 run 关账（等链尾）')
    // ===== ② 三连败语义逐项 =====
    assert.equal(t.status, 'blocked')
    assert.equal(t.retryCount, 3, '三次秒拆各计一次失败（L249 与熔断同一三击口径）')
    var trs = transitions(t)
    assert.equal(trs[trs.length - 1], 'in-progress→blocked', '第三拆流转方向 in-progress→blocked')
    var lastHist = t.history[t.history.length - 1]
    assert.ok(lastHist.note.indexOf('worker 失败 x3') === 0, '历史注记三连败（待人工介入）')
    // ===== ③ runs 三条留档 outcome=timeout/error（model 全=sick、modelSource=board、重派全 fresh spawn）=====
    assert.equal(t.runs.length, 3, '三次派发各留一条 run')
    assert.ok(t.runs.every(function (r) { return r.outcome === 'timeout/error' && r.endedAt }), '三条全部关账 timeout/error（有 endedAt）')
    assert.ok(t.runs.every(function (r) { return r.model === SICK && r.modelSource === 'board' }), '三次全部取板级 sick（板级候选只过 badModels，连败软闸不拦板级）')
    assert.ok(t.runs.every(function (r) { return !r.resume }), '三连重派全 fresh spawn（零续跑干扰）')
    // spawn 日志：三次全部 agentOptions={provider:'prov',model:'sick'}（故障命中前提成立）
    assert.equal(faults.calls.length, 3, '病模型卡共三次 spawn')
    assert.ok(faults.calls.every(function (c) { return c.request.agentOptions && c.request.agentOptions.model === 'sick' }), '三次 spawn 全部命中 sick（activation.result 秒拒前提）')
    // ===== ① 熔断后新卡（基建卡）：badModels 熔断生效，取模链跳过病模型命中备用 =====
    //（settleWorker 失败臂 feedModelFailure 连击 3 → badModels 拉黑；下一张新卡的取模链在 spawnOneShot
    // 消费 badModels → pickHealthyFallback 命中 prov/alt。观测点=spawn 日志的 agentOptions。）
    await createTask(env, 'task-s2', { pipeline: 'work' })
    await env.clock.advance(50)
    var spec = await env.waitFor(function () { return faults.calls.length >= 4 ? faults.calls[3] : null }, '基建卡 spawn 发生（取模链消费熔断名单）')
    assert.ok(spec.request.agentOptions, '基建卡 spawn 带 agentOptions')
    assert.deepEqual(spec.request.agentOptions, { provider: 'prov', model: 'alt' }, '取模链跳过病模型命中备用 prov/alt（观测点=spawn 日志 agentOptions）')
    assert.equal(spec.request.agentOptions.model.indexOf('sick'), -1, 'spawn 日志不再带 prov/sick（badModels 熔断生效）')
    t = await env.waitFor(function () { var x = env.task('task-s2'); return x && x.status === 'in-progress' && x.runs && x.runs[0] && x.runs[0].modelSource === 'fallback' ? x : null }, '基建卡落卡 in-progress 且 modelSource=fallback 留档')
    var fbMsg = (t.messages || []).filter(function (m) { return m.kind === 'fallback' })
    assert.equal(fbMsg.length, 1, '切备用留痕落卡（kind=fallback 消息）')
    assert.ok(fbMsg[0].text.indexOf(SICK) >= 0 && fbMsg[0].text.indexOf(ALT) >= 0, '留痕含原模型与备用模型')
    // ===== ④ 回执冲刷（45s 聚合窗）→ 系统通知含「秒拆」分态（非挂死零产出文案）=====
    // 熔断 pushSysNote 不带 taskId（与验收熔断同口径，不受任务回执冲刷丢弃），攒在 sysNotesBuf
    // 随回执 45s 聚合窗冲刷投递。病模型卡 3 拆派发回执 + 基建卡派发回执共 4 条 < 5 → 45s 窗口触发。
    await env.clock.advance(45000)
    var sent = await env.waitFor(function () { return env.sent.length >= 1 ? env.sent : null }, '45s 聚合窗冲刷投递（系统通知随回执出）')
    var allText = sent.map(function (m) { return (m.content || []).map(function (c) { return c.text || '' }).join('\n') }).join('\n')
    assert.ok(allText.indexOf('宿主秒拆') >= 0, '系统通知含秒拆分态文案（L285 缺省文案「即被宿主秒拆」）')
    assert.ok(allText.indexOf(SICK) >= 0, '通知点名病模型 prov/sick')
    assert.ok(allText.indexOf('挂死零产出') < 0, '非挂死分态文案（L261 HUNG_CIRCUIT_WHY，挂死≠秒拆）')
  } finally { await env.cleanup() }
})

// ===== 接缝对照：默认 llm 目录（空清单）下 set-board-config workerModel=prov/sick 被目录闸拒写 =====
// 病模型不在故障层 llm 目录 → enumModels 枚举空清单不命中 → 拒写「非法模型 id」（不落脏值）——
// 这正是故障层 llm 目录接缝的价值：不放行就永远进不了取模链，秒拆回归无从谈起。
test('故障E2E·接缝对照：病模型不在 llm 目录 → set-board-config workerModel 被目录闸拒写（不落脏值）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx) // 默认 mock llm：listProviders 返回 []（空清单）
    var r = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerModel', value: SICK })
    assert.equal(r.ok, false, '病模型不在 llm 目录 → 目录闸拒写')
    assert.ok(String(r.error || '').indexOf('非法模型 id') === 0, '报错带「非法模型 id」前缀（带合法清单样例）')
    var board = env.board()
    assert.ok(!board || !board.workerModel, '看板不落脏值（workerModel 未写入）')
  } finally { await env.cleanup() }
})
