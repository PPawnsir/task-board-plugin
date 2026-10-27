// ===== 故障 E2E：目录失效——运行中删模型，取模跳过留痕并落健康候选（task-mvqi3uj4-5）=====
// 背景：事故类「删模型仍派」——原形：本体板已删除的失效模型钉在卡级特例上还在被派。本文件锁
// 「卡级特例不豁免存在闸」的端到端回归（真 index.mjs apply(faultCtx) 全循环，fault-e2e-circuit
// harness 同款：rpc 建卡/配板 → clock.advance(50) 踢 poolCycle → waitFor 收敛）。
//
// 机制锚点（lib/dispatch.mjs）：
//   · modelDirectory 每次 spawnOneShot 现取不缓存（L162-178）：模型从宿主配置删除/改名要当轮生效；
//   · outOfDir 存在闸（L182）：目录可得且模型不在目录 → true（配置已失效）；dir=null 恒 false；
//   · traceStaleModel 留痕（L187-207）：卡 messages 记 kind='stale-model'（⚠️ 配置已失效文案），
//     per 模型+文本去重（L200-202，重派不刷屏）+ 健康表 observedNote 落「配置已失效」分态（L192）；
//   · 卡级特例不豁免存在闸（L662-665 注释）：候选循环先过 outOfDir 再过 badModels——卡级只豁免
//     健康闸（连败软闸/熔断/冷却），原形「钉在卡级特例上的失效模型」正是从这里漏走的。
//
// 场景（先含后删，正是合法写路径的盲区）：故障层 llm 目录初始含 prov/gone + prov/good；卡级
// model='prov/gone' 走 update-task（合法清单校验 cardModelErr→enumModels→llm 目录在册放行——
// ⚠️ create-task 不落 model 字段：args.model 仅 update-task 处理（rpc.mjs update-task 句柄），
// 「先含」的唯一合法写入口）→ 首轮派发前 h.directory.remove('prov/gone')（fault-provider 可变
// 目录，shrink 即刻生效）→ poolCycle 派发：outOfDir 命中卡级候选 → traceStaleModel 留痕 → 降下一跳：
//   · 无 lane/board 配置 → parent 裸请求（用例①：含重派去重——推进第二轮 poolCycle 仍恰一条留痕）；
//   · board workerModel=prov/good → 落健康候选 good（用例②：含健康表 observedNote 分态断言）。
// 反例（用例③）：目录不可得（llm 服务摘走 listProviders 抛错 → modelDirectory 返回 null）→
// 目录闸整体跳过不误伤（L158-161 保守语义），prov/gone 照常派发、零留痕——锁「不误伤」分支。
//
// 断言（对应任务口径）：
//   ① spawn 日志无 prov/gone（带卡级特例也被存在闸拦下）——观测点=fault-provider spawnLog
//      （agentOptions 复合串重构面）+ env.runs[].req（真请求对象），不直读内部状态；
//   ② 卡 messages 恰一条 stale-model 留痕（重派不刷屏：第二轮 poolCycle 后仍恰一条，去重 L200-202）；
//   ③ 健康表 observedNote 落「配置已失效」分态（get-tasks 透出则断：fallbackModels 使 prov/gone 进入
//      configuredModelIds 公开视图；用例①无 board 配置不透出，按口径「不透出则略」，由用例②承担）；
//   ④ 卡最终在替代模型上正常推进到 resolved（零死锁零空转）。
//
// 为什么一次性回退开关（workerContinuable=false，fault-e2e-circuit 同款）：一次性路径重试恒
// fresh spawn（runs 留档无 continuable 标记 → resumeTarget 恒空，tryResumeWorker 整段短路），
// 结算确定性由 run.result 驱动（failWith/resolveWith），重派循环确定性收敛、零续跑干扰。
// 为什么关探测（probeEnabled=false，仅用例②）：主动探测 observeModel 会以「主动探测通过」覆盖
// observedNote——本场景只测目录闸分态，探测面由 fault-provider.test.mjs 观测面⑤b 单独覆盖。
// 注意：boom 失败文本刻意避开模型面失败前缀（isModelKillFailure）与冷却嗅探关键词——单纯 worker
// 失败只 retryCount+1 回 pending，熔断/冷却两张表零污染（本场景只测目录闸，两张表各管各的）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import { installFaults } from './helpers/fault-provider.mjs'
import * as plugin from '../index.mjs'

var GONE = 'prov/gone'
var GOOD = 'prov/good'
// traceStaleModel 原文（dispatch.mjs L199 / L192 逐字——回归锁文案分态，措辞变更应被断言拦下）
var STALE_TEXT = '⚠️ 配置已失效：' + GONE + '（已从模型目录移除），本 run 取模跳过'
var STALE_NOTE = '配置已失效（已从模型目录移除）'

// 卡 messages 里的 stale-model 留痕
function staleMsgs(t) { return ((t && t.messages) || []).filter(function (m) { return m && m.kind === 'stale-model' }) }

// 建卡封装（显式 description 避开空描述软提示；pipeline=work 只做不验，验证面不被 Verifier 干扰）
async function createTask(env, id) {
  var r = await env.rpc('create-task', { sessionId: env.sid, id: id, title: '故障E2E 目录失效 ' + id, description: '目录失效回归用例 ' + id, pipeline: 'work' })
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  return r.task
}
// 先含：卡级 model 特例走合法写路径（update-task cardModelErr → enumModels → llm 目录在册放行）
async function pinCardModel(env, id) {
  var r = await env.rpc('update-task', { sessionId: env.sid, taskId: id, model: GONE })
  assert.equal(r.ok, true, '先含：目录在册 → update-task model=' + GONE + ' 合法放行（cardModelErr 经 llm 目录）')
  assert.equal(env.task(id).model, GONE, '卡级特例落卡（t.model）')
}

// ===== 用例①：主场景·无 lane/board 配置 → parent 裸请求兜底 + 重派去重 + 正常推进（真 poolCycle 两轮）=====
test('故障E2E·目录失效主场景：卡级特例先含后删 → 存在闸拦下（spawn 无 prov/gone）+ parent 裸请求 + 重派去重恰一条留痕 + resolved', async () => {
  var env = createMockCtx()
  try {
    // 故障层：llm 目录初始含 prov/gone + prov/good（可变目录，shrink 即刻生效，每次现取不缓存）；
    // programs=[] 纯观察面（spawn 逐字委托 + 日志留痕），无故障程序干扰目录闸单线回归
    var h = installFaults(env, { directory: [GONE, GOOD], programs: [] })
    plugin.apply(env.ctx)
    var wc = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerContinuable', value: false })
    assert.equal(wc.ok, true, 'workerContinuable=false（一次性回退开关，重试恒 fresh spawn）')
    await createTask(env, 'task-d1')
    await pinCardModel(env, 'task-d1')
    // ===== 后删：首轮派发前 shrink（目录仍含 prov/good 非空 → outOfDir 闸生效，非保守跳过）=====
    h.directory.remove(GONE)
    assert.equal(h.directory.has(GONE), false, '后删：prov/gone 已从目录移除')
    assert.equal(h.directory.has(GOOD), true, '目录仍非空（prov/good 在册）→ outOfDir 闸生效')
    // ===== 首轮派发：poolCycle → spawnOneShot 现取目录 → outOfDir 命中卡级候选 → 留痕 → parent 裸请求 =====
    await env.clock.advance(50)
    var run1 = await env.waitFor(function () { return env.runs.length >= 1 ? env.runs[0] : null }, '首轮 spawn 发生')
    // ===== ① spawn 日志无 prov/gone：带卡级特例也被存在闸拦下，降 parent 裸请求 =====
    assert.equal(h.spawnLog.length, 1, '首轮恰一次 spawn')
    assert.equal(h.spawnLog[0].model, '', 'spawn 无 agentOptions（parent 裸请求——卡级特例被存在闸拦下）')
    assert.ok(h.spawnLog.every(function (e) { return e.model.indexOf('gone') < 0 }), '①spawn 日志无 prov/gone')
    assert.equal(run1.req.agentOptions, undefined, 'run 真请求不带 agentOptions（parent 裸请求）')
    assert.equal(env.continuables.length, 0, '一次性路径零 continuable 子会话')
    // ===== ② 卡 messages 恰一条 stale-model 留痕（traceStaleModel 原文）=====
    // 落卡与 claimedBy 换真实 run id 是两笔写——waitFor 等到 claimedBy 换完（与 fault-provider 缺省①同口径）
    var t = await env.waitFor(function () {
      var x = env.task('task-d1')
      return x && x.status === 'in-progress' && x.claimedBy === run1.id && staleMsgs(x).length >= 1 ? x : null
    }, 'stale-model 留痕落卡且 claimedBy=run id')
    assert.equal(staleMsgs(t).length, 1, '恰一条 stale-model 留痕')
    assert.equal(staleMsgs(t)[0].text, STALE_TEXT, '留痕=⚠️ 配置已失效文案（traceStaleModel L199 原文）')
    // 等链尾：失败臂状态推进（settleWorker）与 run 留档关账（settleRunRecord）是两次持锁写——
    // 只等状态会撞上「pending 已落盘而 runs[0] 还停在 running」的窗口（fault-e2e-circuit 同口径）
    run1.failWith('boom')
    t = await env.waitFor(function () {
      var x = env.task('task-d1')
      return x && x.status === 'pending' && x.retryCount === 1 && x.runs && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null
    }, '首轮失败结算：boom 单纯重试（熔断/冷却零污染）回 pending 且 run 关账 timeout/error')
    assert.equal(t.runs[0].modelSource, 'parent', '取模链降到底：modelSource=parent 随 run 留档')
    // ===== ②续段：重派不刷屏（per 模型+文本去重 L200-202）=====
    // 失败臂 kickCycle → 第二轮 poolCycle → 卡级候选再次 outOfDir → traceStaleModel 去重（同文本零改动）
    await env.clock.advance(50)
    var run2 = await env.waitFor(function () { return env.runs.length >= 2 ? env.runs[1] : null }, '第二轮重派 spawn（fresh，模型仍目录外）')
    assert.equal(h.spawnLog.length, 2, '第二轮恰一次 spawn')
    assert.equal(h.spawnLog[1].model, '', '重派同样降 parent 裸请求（卡级特例仍被存在闸拦下）')
    t = env.task('task-d1')
    assert.equal(staleMsgs(t).length, 1, '②重派后仍恰一条 stale-model（per 模型+文本去重 L200-202，重派不刷屏）')
    assert.ok(!t.messages.some(function (m) { return m.kind === 'fallback' || m.kind === 'cooldown' }), '零 fallback/cooldown 留痕（本场景只测目录闸）')
    // ===== ④ 卡在替代模型（parent 裸请求）上正常推进：零死锁零空转 =====
    run2.resolveWith('## 开发描述\n目录失效回归完成')
    t = await env.waitFor(function () {
      var x = env.task('task-d1')
      return x && x.status === 'resolved' && x.runs && x.runs[1] && x.runs[1].outcome === 'completed' ? x : null
    }, '④替代模型上推进到 resolved 且 run 关账 completed（零死锁零空转）')
    assert.equal(t.runs.length, 2, '两轮各一条 run 留档')
    assert.ok(t.runs.every(function (r) { return r.model === '' && r.modelSource === 'parent' }), '两轮全 parent 裸请求（model=父模型空串、modelSource=parent）')
  } finally { await env.cleanup() }
})

// ===== 用例②：主场景·board workerModel=prov/good → 落健康候选 + 健康表 observedNote「配置已失效」分态 =====
test('故障E2E·目录失效主场景②：board workerModel=prov/good 落到 good（spawn 无 prov/gone）+ 健康表 observedNote 落「配置已失效」分态 + resolved', async () => {
  var env = createMockCtx()
  try {
    var h = installFaults(env, { directory: [GONE, GOOD], programs: [] })
    plugin.apply(env.ctx)
    // 板级配置（目录在册放行=先含的一部分）：workerModel=prov/good + fallbackModels=[prov/gone]——
    // 备用链带失效模型是生产常见形态；同时让 prov/gone 进入 get-tasks 公开健康视图的
    // configuredModelIds（modelHealthView 只透出板级配置模型），③分态断言才有观测面
    var wm = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerModel', value: GOOD })
    assert.equal(wm.ok, true, 'workerModel=prov/good 目录在册放行')
    var fb = await env.rpc('set-board-config', { sessionId: env.sid, key: 'fallbackModels', value: [GONE] })
    assert.equal(fb.ok, true, 'fallbackModels=[prov/gone] 目录在册放行（备用链带失效模型=生产常见形态）')
    var wc = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerContinuable', value: false })
    assert.equal(wc.ok, true, 'workerContinuable=false（一次性面）')
    var pe = await env.rpc('set-board-config', { sessionId: env.sid, key: 'probeEnabled', value: false })
    assert.equal(pe.ok, true, 'probeEnabled=false（探测会以「主动探测通过」覆盖 observedNote，关掉聚焦目录闸分态）')
    await createTask(env, 'task-d2')
    await pinCardModel(env, 'task-d2')
    h.directory.remove(GONE)
    assert.equal(h.directory.has(GONE), false, '后删：prov/gone 已移除')
    // 首轮派发：cands=[card prov/gone, board prov/good] → mi=0 outOfDir 命中 → 留痕 → continue →
    // mi=1 prov/good 目录内在册且健康 → 落 board 候选（不经 fallback 链：无熔断/冷却命中）
    await env.clock.advance(50)
    var run1 = await env.waitFor(function () { return env.runs.length >= 1 ? env.runs[0] : null }, 'spawn 发生')
    // ===== ① spawn 落健康候选 prov/good，无 prov/gone =====
    assert.equal(h.spawnLog.length, 1, '恰一次 spawn')
    assert.equal(h.spawnLog[0].model, GOOD, '落 board 候选 prov/good')
    assert.ok(h.spawnLog.every(function (e) { return e.model.indexOf('gone') < 0 }), '①spawn 日志无 prov/gone（带卡级特例也被存在闸拦下）')
    assert.deepEqual(run1.req.agentOptions, { provider: 'prov', model: 'good' }, 'run 真请求带 agentOptions={provider:prov,model:good}')
    // ===== ② 恰一条 stale-model 留痕（card 候选被闸拦下）=====
    var t = await env.waitFor(function () {
      var x = env.task('task-d2')
      return x && x.status === 'in-progress' && x.claimedBy === run1.id && staleMsgs(x).length >= 1 ? x : null
    }, 'stale-model 留痕落卡且 claimedBy=run id')
    assert.equal(staleMsgs(t).length, 1, '恰一条 stale-model 留痕')
    assert.equal(staleMsgs(t)[0].text, STALE_TEXT, '留痕=⚠️ 配置已失效文案（traceStaleModel L199 原文）')
    assert.ok(!t.messages.some(function (m) { return m.kind === 'fallback' }), '零 fallback 留痕（目录闸直落 board 候选，不经熔断/冷却切换分支）')
    // ===== ③ 健康表 observedNote 落「配置已失效」分态（get-tasks 透出则断）=====
    var gt = await env.rpc('get-tasks', { sessionId: env.sid })
    var mh = gt.modelHealth || (gt.data && gt.data.modelHealth) || {}
    assert.ok(mh[GONE], 'prov/gone 在公开健康视图（fallbackModels 进 configuredModelIds）')
    assert.equal(mh[GONE].note, STALE_NOTE, '③observedNote 落「配置已失效」分态（traceStaleModel L192 原文）')
    // ===== ④ 卡在替代模型 prov/good 上正常推进（零死锁零空转）=====
    run1.resolveWith('## 开发描述\n目录失效回归完成')
    t = await env.waitFor(function () {
      var x = env.task('task-d2')
      return x && x.status === 'resolved' && x.runs && x.runs[0] && x.runs[0].outcome === 'completed' ? x : null
    }, '④替代模型上推进到 resolved 且 run 关账 completed')
    assert.equal(t.runs[0].model, GOOD, 'run 落 prov/good')
    assert.equal(t.runs[0].modelSource, 'board', 'modelSource=board 随 run 留档')
  } finally { await env.cleanup() }
})

// ===== 用例③：反例·目录不可得（llm 服务摘走 listProviders 抛错）→ 目录闸整体跳过不误伤 =====
// modelDirectory 的保守语义（L158-161；L167 catch → null）：目录不可得时 outOfDir 恒 false（L182），
// 目录闸整体跳过，只留连败软闸生效——prov/gone 照常派发、零 stale-model 留痕（不误伤不误报）。
test('故障E2E·目录失效反例：目录不可得 → 目录闸整体跳过不误伤，prov/gone 照常派发（零留痕）+ 正常推进', async () => {
  var env = createMockCtx()
  try {
    var h = installFaults(env, { directory: [GONE, GOOD], programs: [] })
    plugin.apply(env.ctx)
    var wc = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerContinuable', value: false })
    assert.equal(wc.ok, true, 'workerContinuable=false（一次性面）')
    await createTask(env, 'task-d3')
    await pinCardModel(env, 'task-d3') // 先含（此时目录在册，合法放行）
    // 目录不可得注入：llm 服务摘走 listProviders（抛错）——包装 installFaults 之后的 ctx.get('llm')
    var withFaultGet = env.ctx.get
    env.ctx.get = function (name) {
      if (name === 'llm') {
        return {
          listProviders: function () { throw new Error('llm 服务已摘除 listProviders（目录不可得注入）') },
          listModels: async function () { return [] },
        }
      }
      return withFaultGet(name)
    }
    // 首轮派发：modelDirectory → listProviders 抛错 → catch → null（L167）→ outOfDir 恒 false（L182）
    // → 目录闸整体跳过 → 卡级特例 prov/gone 照常入链 → 派发在 prov/gone 上（不误伤）
    await env.clock.advance(50)
    var run1 = await env.waitFor(function () { return env.runs.length >= 1 ? env.runs[0] : null }, 'spawn 发生')
    assert.equal(h.spawnLog.length, 1, '恰一次 spawn')
    assert.equal(h.spawnLog[0].model, GONE, '不误伤：prov/gone 照常派发（目录闸整体跳过，L158-161 保守语义）')
    assert.deepEqual(run1.req.agentOptions, { provider: 'prov', model: 'gone' }, 'run 真请求带 agentOptions={provider:prov,model:gone}')
    var t = await env.waitFor(function () {
      var x = env.task('task-d3')
      return x && x.status === 'in-progress' && x.claimedBy === run1.id ? x : null
    }, '卡已派发 in-progress 且 claimedBy=run id')
    assert.equal(staleMsgs(t).length, 0, '零 stale-model 留痕（dir=null → traceStaleModel 不触发，不误报）')
    assert.equal(t.runs[0].model, GONE, 'run 落 prov/gone')
    assert.equal(t.runs[0].modelSource, 'card', 'modelSource=card（卡级特例正常入链）')
    // 收尾：正常完成，零死锁零空转
    run1.resolveWith('## 开发描述\n反例用例完成')
    t = await env.waitFor(function () {
      var x = env.task('task-d3')
      return x && x.status === 'resolved' && x.runs && x.runs[0] && x.runs[0].outcome === 'completed' ? x : null
    }, '正常推进到 resolved 且 run 关账 completed（零死锁）')
  } finally { await env.cleanup() }
})
