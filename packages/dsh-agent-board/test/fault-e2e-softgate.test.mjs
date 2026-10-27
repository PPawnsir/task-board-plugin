// ===== 故障 E2E：连败软闸——病模型第二次派发被跳，同卡第三次落到健康模型完成（真派发循环，task-mvqi3uj4-3）=====
// 背景：事故类「连败仍调度」（原形：glm-5.2「78s 报错一次+挂死一次」病了还被优先派发）的端到端回归。
// 机制锚点：healthyModel 连败软闸 recentRuns≥2 全败 → 不健康（dispatch.mjs L224-229；软熔断：不落
// badModels 黑名单，仅取模/续跑跳过）；recentRuns 由 observeModel 喂（L108-109，settleRunRecord L1261
// 每次可归因 run 落定喂给，滚动窗近 5 次）。档位槽=有序数组：槽内按序取首个健康模型（L648）——
// 首选病即次选赢（偏好序非故障序，不降级不绕链），modelSource 仍记 'lane'。
//
// 与 settle-stop-interrupt.test.mjs 续跑健康闸④（薄桩）差异：④ 是续跑路径单测（直种 modelHealth，
// 锁「放弃续跑改 fresh spawn」）；本卡验证「软闸 → 同卡落到健康模型完成」的**派发闭环**：跑在
// 真实 index.mjs apply(faultCtx) 全循环上（fault-e2e-circuit.test.mjs harness 同款：rpc create-task →
// clock.advance(50) 踢 poolCycle → waitFor 收敛），病模型真秒拆×2 喂 recentRuns（真 observeModel 链路，
// 非直种），第三次取模软闸拦下病模型改取槽内次选健康模型，次选正常交付（resolveWith 分段交付文本，
// integration.test.mjs L71 workerText 同款）→ 卡 verifying。
//
// 场景：laneModels.standard.worker=['prov/flaky','prov/good']（槽位有序数组，首选病次选健康），
// prov/flaky=instant-kill 持续（按模型命中——病模型每次 spawn 即秒拆，与 fault-e2e-circuit 同款接缝）。
// 建 size=standard 卡 → run1 取 flaky（槽内首选健康检查通过：recentRuns 空）秒拆 → 重派 run2 仍 flaky
// （recentRuns 1 败 <2 未达软闸线）秒拆 → run3 软闸拦下 flaky 改取 good（槽内次选赢，L648）→
// good 正常交付 → verifying。
//
// 断言（四条，对应任务口径）：
//   ① 三次 worker spawn 日志模型序列恰为 [prov/flaky, prov/flaky, prov/good]——软闸「第二次派发
//      跳过病模型」的端到端证据（观测点=故障层 spawn spec，非单测直读 state）；
//   ② run3 modelSource 留档='lane'（三次全是槽内命中：软闸=槽内健康判定，不走降档不绕链）；
//   ③ 卡未进 blocked：第三次成功 retryCount 成功路径清除（L1679）→ verifying（resolveApply full 档），
//      deliverable 随分段文本落卡，三次 run 全 fresh spawn（一次性路径零续跑干扰）；
//   ④ get-tasks RPC modelHealth 健康面：flaky recentRuns 滚动窗含败迹（2 条全败——observeModel 喂给
//      透出），且 state ≠ circuit/cooldown（2 连击 < 3 未达硬熔断线——软闸≠硬熔断语义分治）；
//      good recentRuns 含成功条目（第三次成功喂给）。
// 注意：拆机文案避开冷却嗅探关键词（连接/超时/网关/limit 等）——否则病模型被误登记冷却，软闸循环
// 会被冷却闸截断（熔断与冷却两张表各管各的，本场景只测连败软闸）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

var FLAKY = 'prov/flaky'
var GOOD = 'prov/good'
// 拆机原形文本（dispatch.mjs activation 拆除臂同款前缀；diagnostic 避开冷却嗅探关键词）
var TEARDOWN_TEXT = '子会话被宿主拆除（stopReason: error，宿主秒拆注入）'
// Worker 交付文本（integration.test.mjs L71 workerText 同款：分段格式，避开 [ESCALATE] 标记）
function workerText(tag) {
  return '## 开发描述\n完成 ' + tag + ' 的实现\n\n## 改动清单\n- src/' + tag + '.mjs：新增实现\n\n## 自测情况\nnpm test 全绿\n\n## diff 概要\n 1 file changed, 10 insertions(+)'
}

// ===== 故障层：llm 目录接缝 + 故障表按模型秒拆 + 次选健康 resolveWith 同款交付 =====
// 接缝①：故障层 llm 目录（prov/flaky + prov/good 在册）——set-board-config laneModels 槽位校验经
// enumModels 枚举 llm 清单（rpc.mjs，list-models 同源）放行；dispatch modelDirectory 同源数据面：
// 病模型在册 = outOfDir 不拦，才进得了取模链（目录闸放行的接缝）。
// 接缝②：故障表按模型命中（spec.request.agentOptions.model）——flaky 每次 spawn 即秒拆：
// activation.result 以拆机原形文本**裸字符串**立即拒绝（run.result 拒绝经 withTimeout race 臂
// finish(null, err) → settleRun → settleWorker 失败臂 → settleRunRecord observeModel 喂 recentRuns）。
// 次选 good 的 worker run 以 resolveWith 同款 output text 正常落定（分段交付文本 → 成功臂 → verifying）；
// verifier run 永不落定（卡停 verifying 不再推进——本场景只测 worker 闭环）。
// calls = spawn 日志观测点（断言①读 spec.request.agentOptions，不直读内部 state）。
function applyFaults(env) {
  var origGet = env.ctx.get
  env.ctx.get = function (name) {
    if (name === 'llm') {
      return {
        listProviders: function () { return [{ id: 'prov', name: 'prov' }] },
        listModels: async function (pid) { return pid === 'prov' ? [{ id: 'flaky', name: 'flaky' }, { id: 'good', name: 'good' }] : [] },
      }
    }
    return origGet(name)
  }
  var calls = []
  var n = 0
  env.ctx.subagents.startActivation = async function (spec) {
    calls.push(spec)
    var ao = spec.request && spec.request.agentOptions
    if (ao && ao.model && 'prov/' + ao.model === FLAKY) {
      // 拒绝值=拆机原形文本字符串：settleRun 的 errText=String(err) → isModelKillFailure 前缀命中；
      // 空窗 catch：race 臂挂载前的微任务窗口防 unhandled rejection（拒绝值另有 race 臂消费）
      var result = Promise.reject(TEARDOWN_TEXT)
      result.catch(function () {})
      return { childId: 'child-' + (++n), messageId: 'm' + n, result: result, dispose: async function () {} }
    }
    if (String(spec.label || '').indexOf('worker:') === 0) {
      // 次选健康：resolveWith 同款 output text 正常落定（settleRun 成功臂 → parseSections → verifying）
      return {
        childId: 'child-' + (++n), messageId: 'm' + n,
        result: Promise.resolve({ output: [{ type: 'text', text: workerText('softgate') }], stopReason: 'completed' }),
        dispose: async function () {},
      }
    }
    return { childId: 'child-' + (++n), messageId: 'm' + n, result: new Promise(function () {}), dispose: async function () {} }
  }
  return { calls: calls }
}

// 槽位有序数组写入 + 一次性回退开关（接缝的实证步骤）
async function writeBoardConfig(env) {
  // laneModels.standard.worker = ['prov/flaky','prov/good']（槽位有序数组，首选病次选健康）——
  // llm 目录在册 → set-board-config 槽位校验放行（接缝①实证步骤）
  var lm = await env.rpc('set-board-config', { sessionId: env.sid, key: 'laneModels', value: { standard: { worker: [FLAKY, GOOD] } } })
  assert.equal(lm.ok, true, '故障层 llm 目录在册 → set-board-config laneModels 槽位有序数组放行')
  // workerContinuable=false（一次性回退开关）：失败重派恒 fresh spawn（resumeTarget 对非 continuable
  // 恒空）——与 fault-e2e-circuit 同款：三连循环确定性收敛、零续跑干扰
  var wc = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerContinuable', value: false })
  assert.equal(wc.ok, true, 'workerContinuable=false（一次性回退开关）放行')
}

// 建卡封装：显式 description 避开空描述软提示；size=standard（槽内取模的前提）
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '故障E2E ' + id, description: '故障回归用例 ' + id }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  return r.task
}

function transitions(t) { return (t.history || []).map(function (h) { return h.from + '→' + h.to }) }
// 卡上 worker 角色的 runs 条目（pipeline=full 的 verifier spawn 晚于断言时点，全场景按 worker 过滤）
function workerRuns(t) { return (t.runs || []).filter(function (r) { return r.role === 'worker' }) }
// worker spawn 日志（label 前缀过滤——verifier spawn 不参与断言①）
function workerSpawns(calls) { return calls.filter(function (c) { return String(c.label || '').indexOf('worker:') === 0 }) }

// ===== 主场景：病模型秒拆×2 → 软闸拦下改取次选健康模型 → 正常交付 verifying（真 poolCycle 循环）=====
// 与 lane-models.test.mjs 连败软闸 S1/S2 的差异：S1/S2 是薄桩单测（直种 modelHealth、直调 spawnOneShot）；
// 本用例跑真 poolCycle 重派循环，recentRuns 由**真 observeModel 链路**喂（run.result 拒绝 → settleRun →
// settleRunRecord L1261），锁「软闸 → 同卡落到健康模型完成」的派发闭环。
test('故障E2E·连败软闸：病模型秒拆×2 喂 recentRuns → 第三次软闸拦下改取槽内次选健康模型正常交付 → verifying（真 poolCycle 循环）', async () => {
  var env = createMockCtx()
  try {
    var faults = applyFaults(env)
    plugin.apply(env.ctx)
    await writeBoardConfig(env)
    // 建 size=standard 卡（槽内取模前提：standard 槽命中 laneModels.standard.worker）→ 50ms 去抖踢 poolCycle
    await createTask(env, 'task-sg', { pipeline: 'full', size: 'standard' })
    await env.clock.advance(50)
    // 三个 waitFor 一律等「结算链尾」：settleWorker 的状态推进与 settleRunRecord 的 run 关账/
    // observeModel 喂给是两次持锁写（settleRun L1329 → L1338）——只等状态会撞上「pending 已落盘
    // 而 recentRuns 未喂」的窗口（与 fault-e2e-circuit「等链尾」同一口径）。
    // run1：槽内首选 flaky（healthyModel：recentRuns 空 → 健康检查通过）→ 秒拆
    var t = await env.waitFor(function () {
      var x = env.task('task-sg')
      return x && x.status === 'pending' && x.retryCount === 1 && x.runs && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null
    }, '秒拆#1 结算：run.result 拒绝 → settleWorker 失败臂回 pending 且 run 关账 timeout/error（等链尾）')
    assert.equal(workerSpawns(faults.calls).length, 1, '首拆一次 worker spawn')
    assert.equal(workerSpawns(faults.calls)[0].request.agentOptions.model, 'flaky', 'run1 取槽内首选 flaky（recentRuns 空：软闸线未达，健康检查通过）')
    assert.equal(workerRuns(t)[0].modelSource, 'lane', 'run1 modelSource=lane（槽内命中）')
    // run2：重派仍 flaky——recentRuns 1 败 < 2 未达软闸线，取模行为不变（「第二次派发不跳」对照面）
    await env.clock.advance(50)
    t = await env.waitFor(function () {
      var x = env.task('task-sg')
      var wr = x && x.runs ? workerRuns(x) : null
      return x && x.status === 'pending' && x.retryCount === 2 && wr && wr[1] && wr[1].outcome === 'timeout/error' ? x : null
    }, '秒拆#2 自动重派同样秒拆且关账（等链尾：此刻 recentRuns 已喂 2 败）')
    assert.equal(workerSpawns(faults.calls).length, 2, '两拆两次 worker spawn')
    assert.equal(workerSpawns(faults.calls)[1].request.agentOptions.model, 'flaky', 'run2 仍取 flaky（recentRuns 1 败 <2 未达软闸线）——软闸不提前拦的对照面')
    assert.equal(workerRuns(t)[1].modelSource, 'lane')
    // run3：软闸拦下 flaky（recentRuns ≥2 全败 → healthyModel false，L224-229）改取槽内次选 good（L648）→ 正常交付
    await env.clock.advance(50)
    t = await env.waitFor(function () {
      var x = env.task('task-sg')
      var wr = x && x.runs ? workerRuns(x) : null
      return x && x.status === 'verifying' && wr && wr[2] && wr[2].outcome === 'completed' ? x : null
    }, 'run3 软闸改取 good 正常交付 → verifying 且第三条 run 关账（等链尾）')
    // ===== ① 三次 spawn 日志模型序列恰为 [flaky, flaky, good]（软闸端到端证据）=====
    var ws = workerSpawns(faults.calls)
    assert.equal(ws.length, 3, '三次 worker spawn（不多不少）')
    assert.deepEqual(ws.map(function (c) { return 'prov/' + c.request.agentOptions.model }), [FLAKY, FLAKY, GOOD], 'spawn 日志模型序列恰为 [flaky, flaky, good]——第三次软闸拦下病模型改取次选（L648）')
    // ===== ② run3 modelSource 留档='lane' =====
    assert.deepEqual(workerRuns(t).map(function (r) { return r.modelSource }), ['lane', 'lane', 'lane'], '三次 modelSource 全=lane（软闸=槽内健康判定，不走降档不绕链）')
    assert.deepEqual(workerRuns(t).map(function (r) { return r.model }), [FLAKY, FLAKY, GOOD], '卡 runs 留档模型序列与 spawn 日志同序（留档审计面）')
    // ===== ③ 卡未进 blocked：第三次成功 retryCount 成功路径清除（L1679）→ verifying =====
    assert.equal(t.status, 'verifying', '卡 verifying（未进 blocked——第三次成功）')
    assert.ok(transitions(t).indexOf('→blocked') < 0, '全程零 blocked 流转（三连败语义未达：只拆 2 次）')
    assert.equal('retryCount' in t, false, 'retryCount 成功路径清除（L1679）')
    assert.equal('lastError' in t, false, 'lastError 成功路径一并清除（L1679）')
    assert.equal(transitions(t)[transitions(t).length - 1], 'in-progress→verifying', '流转方向 in-progress→verifying')
    assert.ok(t.deliverable && t.deliverable.summary && t.deliverable.summary.indexOf('softgate') >= 0, 'deliverable 随分段交付文本落卡（resolveWith 同款文本真走了成功臂）')
    assert.ok(workerRuns(t).every(function (r) { return !r.resume }), '三次重派全 fresh spawn（一次性路径零续跑干扰）')
    // ===== ④ get-tasks RPC modelHealth 健康面：recentRuns 滚动窗含败迹（若透出）=====
    var gt = await env.rpc('get-tasks', { sessionId: env.sid })
    var mh = gt.modelHealth || (gt.data && gt.data.modelHealth) || {}
    var flaky = mh[FLAKY]
    assert.ok(flaky && Array.isArray(flaky.recentRuns) && flaky.recentRuns.length === 2, '健康面透出 flaky recentRuns（observeModel 喂给，滚动窗 2 条）')
    assert.ok(flaky.recentRuns.every(function (r) { return r.ok === false }), 'flaky recentRuns 滚动窗含败迹（2 条全败——软闸数据源）')
    assert.ok(flaky.state !== 'circuit' && flaky.state !== 'cooldown', 'flaky 未进硬熔断/冷却（2 连击 < 3 未达 WORKER_MODEL_CIRCUIT_AFTER——软闸≠硬熔断语义分治）')
    var good = mh[GOOD]
    assert.ok(good && Array.isArray(good.recentRuns) && good.recentRuns.some(function (r) { return r.ok === true }), 'good recentRuns 含成功条目（第三次成功喂给）')
    assert.ok(good.state === 'healthy', 'good 健康面 healthy（成功 observeModel）')
  } finally { await env.cleanup() }
})

// ===== 接缝对照：槽位模型不在 llm 目录 → set-board-config laneModels 被目录闸拒写 =====
// 槽位值不在故障层 llm 目录 → enumModels 枚举不命中 → 拒写「非法模型 id」（不落脏值）——
// 不放行就永远进不了取模链，连败软闸回归无从谈起（与 fault-e2e-circuit workerModel 接缝对照同款，
// 本卡锁 laneModels 槽位写入路径）。
test('故障E2E·接缝对照：槽位模型不在 llm 目录 → set-board-config laneModels 被拒写（不落脏值）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx) // 默认 mock llm：listProviders 返回 []（空清单）
    var r = await env.rpc('set-board-config', { sessionId: env.sid, key: 'laneModels', value: { standard: { worker: [FLAKY, GOOD] } } })
    assert.equal(r.ok, false, '槽位模型不在 llm 目录 → 目录闸拒写')
    assert.ok(String(r.error || '').indexOf('非法模型 id') === 0, '报错带「非法模型 id」前缀（带合法清单样例）')
    var board = env.board()
    var lm = board && board.laneModels && board.laneModels.standard ? board.laneModels.standard.worker : []
    assert.equal(lm.length, 0, '看板不落脏值（槽位未写入）')
  } finally { await env.cleanup() }
})



