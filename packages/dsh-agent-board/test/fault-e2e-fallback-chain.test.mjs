// ===== 故障 E2E：降级链按序走完——限流冷却驱动 lane→备用链→C5 降档→parent 全链留痕（真派发循环，task-mvqi3uj4-6）=====
// 背景：事故类「连败仍调度/冷却不降档」的链序面端到端回归。机制锚点：四级取模链 card→lane→board→parent
//（dispatch.mjs L616-654）、fallbackModels 备用链两段消费点（熔断 L666-683 / 冷却 L698-712）、
// C5 冷却降档链 heavy→standard→light（L714-735）、modelSource 留档（L450/L680/L702）。
//
// 与 rate-limit-cooldown.test.mjs ③（薄桩 createDispatch 直调、直种 modelCooldown）差异：本卡验证
//「冷却登记 → 下一轮真派发链自动绕行」闭环——跑在真实 index.mjs apply(faultCtx) 全循环上
//（fault-e2e-circuit/softgate 同款 harness：rpc create-task → clock.advance(50) 踢 poolCycle →
// waitFor 收敛），冷却表条目全部由**真 spawn 失败的嗅探臂**（L826-828 spawn 秒死臂）登记，非直种。
//
// 场景（限流档驱动，全链真实可走）：laneModels.heavy.worker=['prov/a']、fallbackModels=['prov/b','prov/c']、
// laneModels.standard.worker=['prov/d']、light 空槽；故障表 a/b/c/d=rate-limit，「限额将在 <未来时刻> 重置」
// 文本（重置时刻在抛出时现算、须晚于 now 才在冷却窗内——parseModelCooldown 本地时区解析口径见
// rate-limit-cooldown.test.mjs L23-24 FIXED 先例）。
// 任务口径「故障表 a/b/d」的偏差说明：c 必须同入限流表——c 若不限流，会在备用链扫描中健康命中、
// 链序永远到不了 C5 降档（「扫备用链全冷却 → 降档」不成立）；c 入表后备用链两跳都是冷却跳过，
// 与任务链序叙事「扫备用链 b 也冷却」同一机制（冷却闸跳过，非目录闸）。
//
// 为什么需要暖场卡 W1：modelCooldown 纯内存不持久化（index.mjs L46）、无 RPC 可种——冷却条目唯一
// 真实登记路径是真 spawn 失败的嗅探臂。主卡 run1 只能登记 a（lane 槽首选撞 429）；b/c/d 的冷却须由
// 暖场卡 W1 的真派发链逐一撞出来（每轮 429 秒死 → 裸请求回收 → 失败臂回 pending → 真重派），随后
// 主卡重派一轮内走完全链。
//
// 全链时序（第一幕）：
//   M run1：lane 槽取 a（健康）→ 覆盖 a → 429 秒死 → L826-828 嗅探登记 a → 裸请求父模型兜底照走
//           [spawn 模型序列 = [a, 无覆盖(parent)]]（断言①）
//   W1 run1：a 冷却 → 备用链 b 健康 → 覆盖 b → 429 秒死 → 登记 b（L709 fallback 留痕在 W1 卡）
//   W1 run2：a+b 冷却 → 备用链 b 冷却跳过、c 健康命中 → 覆盖 c → 429 秒死 → 登记 c
//   W1 run3：a+b+c 冷却 → 备用链链尽 → C5 降档 standard 槽 d → 覆盖 d → 429 秒死 → 登记 d
//   M 重派：a 冷却 → 备用链 b/c 全冷却 → C5 降档 d 也冷却 → light 空槽 → **parent 兜底**
//           （spawn 日志无 agentOptions，modelSource='cooldown-downgrade'，L739 留痕「降档为 父模型」）
// 第二幕：故障表 b 改正常 → b 冷却墙钟过期（惰性清除）→ 新卡重派 → a 冷却 → 备用链命中 b
//   （modelSource='fallback' + 卡 messages「🔀 原模型 prov/a 冷却中（至 HH:mm），切备用 prov/b」L709 逐字）
//
// 断言（四条，对应任务口径）：
//   ① 第一幕 run1 spawn 模型序列=[a, 无覆盖(parent)]，卡 messages 有冷却留痕（⏳ 额度冷却至 HH:mm，L151）；
//   ② 第二幕 spawn 落 b，fallback 留痕文案逐字匹配（L709 冷却分态，非熔断分态）；
//   ③ 健康表 a/b/d 呈 cooldown 态（get-tasks modelHealthView 透出，until=嗅探登记的重置时刻）；
//   ④ badModels 面零污染：健康面零 circuit + 重派取模链对 a 的跳过文案是「冷却中」分态（若进熔断会是
//      「熔断中」L676）+ b 冷却过期后仍被备用链重新取用（限流不进熔断的直接行为反例——熔断=拉黑到
//      重启不自愈，重取即零污染证据）。
// 注意：裸请求回收文本（测试驱动失败臂）避开冷却嗅探关键词（连接/超时/网关/限额/额度等）与
// isModelKillFailure 前缀——否则误登记冷却/喂连败熔断，链序面被污染（与 fault-e2e-circuit 同款注意）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'
import { parseModelCooldown } from '../lib/dispatch.mjs'

var A = 'prov/a', B = 'prov/b', C = 'prov/c', D = 'prov/d'
// 重置时刻偏移（抛出时现算）：a/c/d 长窗（+30min，两幕内恒冷却）；b 短窗（+10s，第二幕前墙钟过期）
var OFFSETS = {}
OFFSETS[A] = 30 * 60000
OFFSETS[B] = 10 * 1000
OFFSETS[C] = 30 * 60000
OFFSETS[D] = 30 * 60000
// 本地时区格式化（parseModelCooldown 本地解析口径，跨 TZ 稳定——rate-limit-cooldown L23-24 先例同款）
function pad(n) { return ('0' + n).slice(-2) }
function fmtLocal(ts) {
  var d = new Date(ts)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}
function hhmm(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
// 裸请求回收文本：避开 RATE_LIMIT_RE（429/RATE_LIMIT/rate.?limit/限额/额度）与 CONNECTIVITY_RE
//（ENOTFOUND/…/网关/连接/超时）全部关键词及 isModelKillFailure 前缀——否则误登记冷却/喂连败熔断
var BARE_KILL_TEXT = '测试驱动回收：裸请求子会话结束（非模型面故障）'

// ===== 故障层：llm 目录接缝 + 故障表限流注入（spawn 秒死臂）+ 裸请求可测回收 =====
// 接缝①：llm 目录（a/b/c/d 在册）——set-board-config laneModels/fallbackModels 槽位校验经 enumModels
// 放行；dispatch modelDirectory 同源数据面（目录闸不拦在册模型）。刻意不提供 llm.stream → 主动探测
// 整体跳过（dispatch.mjs L355 门），不干扰链序面。
// 接缝②：故障表按模型命中（spec.request.agentOptions.model）——rate-limit 模型的**带覆盖 spawn 直接
// 抛错**（activation 未建即失败 → L826-828 嗅探臂登记冷却 + 本轮回退裸请求父模型照走）；裸请求（无
// agentOptions=父模型）默认挂起，测试按需回收触发失败臂重派（等结算链尾再踢下一轮）。
// calls = spawn 日志观测点（断言读 spec.request.agentOptions，不直读内部 state）。
function applyFaults(env) {
  var table = {}
  var origGet = env.ctx.get
  env.ctx.get = function (name) {
    if (name === 'llm') {
      return {
        listProviders: function () { return [{ id: 'prov', name: 'prov' }] },
        listModels: async function (pid) {
          return pid === 'prov'
            ? [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }, { id: 'd', name: 'd' }]
            : []
        },
      }
    }
    return origGet(name)
  }
  var calls = []
  var thrown = {}      // 每模型实际抛出的 429 文本（重置时刻抛出时现算——断言用它反推精确冷却截止）
  var bareHandles = [] // 裸请求（父模型兜底 spawn）result 的测试回收句柄，与 calls 中裸调用同序
  var n = 0
  env.ctx.subagents.startActivation = async function (spec) {
    calls.push(spec)
    var ao = spec.request && spec.request.agentOptions
    if (ao && ao.model && table['prov/' + ao.model] === 'rate-limit') {
      var text = '429 RATE_LIMIT: 当前账户额度已用尽，限额将在 ' + fmtLocal(Date.now() + OFFSETS['prov/' + ao.model]) + ' 重置'
      thrown['prov/' + ao.model] = text
      throw new Error(text)
    }
    var settle
    var result = new Promise(function (res, rej) { settle = rej })
    result.catch(function () {}) // 空窗 catch：防回收句柄触发前的微任务窗口 unhandled rejection
    if (!ao) bareHandles.push(settle)
    return { childId: 'child-' + (++n), messageId: 'm' + n, result: result, dispose: async function () {} }
  }
  return { table: table, calls: calls, thrown: thrown, bareHandles: bareHandles }
}

// 槽位/备用链/一次性回退开关写入（接缝的实证步骤）：heavy 槽 [a]、standard 槽 [d]、light 空槽、
// 备用链 [b, c]（llm 目录在册 → set-board-config 槽位校验放行）
async function writeBoardConfig(env) {
  var lm = await env.rpc('set-board-config', { sessionId: env.sid, key: 'laneModels', value: { heavy: { worker: [A] }, standard: { worker: [D] }, light: { worker: [] } } })
  assert.equal(lm.ok, true, '故障层 llm 目录在册 → set-board-config laneModels 三档（light 空槽）放行')
  var fb = await env.rpc('set-board-config', { sessionId: env.sid, key: 'fallbackModels', value: [B, C] })
  assert.equal(fb.ok, true, 'fallbackModels=[prov/b, prov/c] 在册放行')
  var wc = await env.rpc('set-board-config', { sessionId: env.sid, key: 'workerContinuable', value: false })
  assert.equal(wc.ok, true, 'workerContinuable=false（一次性回退开关）放行：重派恒 fresh spawn，三连循环确定性收敛')
}

// 建卡封装：显式 description 避开空描述软提示
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '故障E2E ' + id, description: '故障回归用例 ' + id }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  return r.task
}
// 卡上 worker 角色的 runs 条目（pipeline=work 零 verifier spawn，按 role 过滤为防御性口径）
function workerRuns(t) { return (t.runs || []).filter(function (r) { return r.role === 'worker' }) }
// worker spawn 日志（label 前缀过滤）
function workerSpawns(calls) { return calls.filter(function (c) { return String(c.label || '').indexOf('worker:') === 0 }) }
function cooldownMsgs(t) { return (t.messages || []).filter(function (m) { return m.kind === 'cooldown' }) }
function fallbackMsgs(t) { return (t.messages || []).filter(function (m) { return m.kind === 'fallback' }) }
function healthOf(env) {
  return env.rpc('get-tasks', { sessionId: env.sid }).then(function (gt) { return gt.modelHealth || (gt.data && gt.data.modelHealth) || {} })
}

// ===== 主场景：限流冷却登记 → 备用链全冷却 → C5 降档 → light 空 → parent 兜底 → b 恢复后备用链命中
//（真 poolCycle 循环；三个 waitFor 一律等「结算链尾」——settleWorker 状态推进与 settleRunRecord run
// 关账/嗅探留痕是两次持锁写，只等状态会撞上中间窗口，与 fault-e2e-circuit/softgate 同一口径）
test('故障E2E·降级链：run1 限流秒死登记 a 冷却 → 重派备用链全冷却 → C5 降档 d 也冷却 → light 空 → parent 兜底 → b 恢复后备用链命中（真 poolCycle 循环）', async () => {
  var env = createMockCtx()
  try {
    var faults = applyFaults(env)
    faults.table[A] = 'rate-limit'; faults.table[B] = 'rate-limit'; faults.table[C] = 'rate-limit'; faults.table[D] = 'rate-limit'
    plugin.apply(env.ctx)
    await writeBoardConfig(env)
    // ===== 第一幕·run1：heavy 卡 lane 槽取 prov/a（健康）→ 覆盖 a → 429 秒死 → L826-828 嗅探登记
    // a 冷却 → 本轮回退裸请求（父模型）照走 [spawn 模型序列 = [a, 无覆盖(parent)]]（断言①）
    await createTask(env, 'task-m1', { pipeline: 'work', size: 'heavy' })
    await env.clock.advance(50)
    var calls = await env.waitFor(function () { return workerSpawns(faults.calls).length >= 2 ? faults.calls : null }, 'run1 两连 spawn：a 429 秒死 + 裸请求父模型兜底（等链尾）')
    var ws = workerSpawns(calls)
    assert.deepEqual(ws[0].request.agentOptions, { provider: 'prov', model: 'a' }, 'run1 首连带 lane 槽 prov/a 覆盖（healthyModel：a 尚无冷却信号，槽内首选健康检查通过）')
    assert.equal(ws[1].request.agentOptions, undefined, 'run1 次连剥光 agentOptions——L826-828 spawn 秒死臂：本轮回退裸请求（父模型）照走')
    // ① 冷却登记留痕（L151 限流分态文案逐字：⏳ 额度冷却至 HH:mm）
    var aUntil = parseModelCooldown(faults.thrown[A]).until
    assert.ok(aUntil > Date.now(), '重置时刻晚于 now → a 在冷却窗内（限流档驱动前提）')
    var m1 = await env.waitFor(function () { var x = env.task('task-m1'); return x && cooldownMsgs(x).length >= 1 ? x : null }, 'a 冷却登记落卡留痕（等链尾）')
    assert.equal(cooldownMsgs(m1)[0].text, '⏳ 模型 prov/a 额度冷却至 ' + hhmm(aUntil), 'L151 限流留痕文案逐字（⏳ 额度冷却至 HH:mm）')
    assert.equal(cooldownMsgs(m1)[0].by, 'system', '冷却留痕 by=system')
    assert.ok(m1.status === 'in-progress', 'run1 裸请求父模型兜底照走（卡 in-progress，本轮未失败）')

    // ===== 第一幕·暖场 W1：真派发链把 b/c/d 逐一登记冷却（冷却表纯内存无 RPC 可种，唯一真实登记
    // 路径是真 spawn 失败的嗅探臂；W1 每轮 429 秒死 → 裸请求回收 → 失败臂回 pending → 真重派）
    await createTask(env, 'task-w1', { pipeline: 'work', size: 'heavy' })
    await env.clock.advance(50)
    // W1 run1：a 冷却 → 备用链 b 健康 → 覆盖 b（L709 fallback 留痕在 W1 卡）→ 429 秒死 → 登记 b → 裸请求
    calls = await env.waitFor(function () { return workerSpawns(faults.calls).length >= 4 ? faults.calls : null }, 'W1 run1：a 冷却 → 备用链命中 b（下一轮真派发链自动绕行的首证）')
    ws = workerSpawns(calls)
    assert.deepEqual(ws[2].request.agentOptions, { provider: 'prov', model: 'b' }, 'W1 run1 覆盖落到备用链首位 prov/b（a 冷却 → pickHealthyFallback 命中）')
    assert.ok(faults.thrown[B], 'b 429 秒死（故障表限流）→ 嗅探臂登记 b 冷却')
    faults.bareHandles[1](new Error(BARE_KILL_TEXT)) // 回收 W1 run1 裸请求 → 失败臂回 pending
    var w1 = await env.waitFor(function () { var x = env.task('task-w1'); var wr = x && x.runs ? workerRuns(x) : []; return x && x.status === 'pending' && x.retryCount === 1 && wr[0] && wr[0].outcome === 'timeout/error' ? x : null }, 'W1 裸请求回收 → 失败臂回 pending 且 run 关账（等链尾）')
    assert.equal(workerRuns(w1)[0].modelSource, 'fallback', 'W1 run1 run 留档 modelSource=fallback（备用链命中）')
    // W1 run2：a+b 冷却 → 备用链 b 冷却跳过、c 健康命中 → 覆盖 c → 429 秒死 → 登记 c → 裸请求
    await env.clock.advance(50)
    calls = await env.waitFor(function () { return workerSpawns(faults.calls).length >= 6 ? faults.calls : null }, 'W1 run2：备用链 b 冷却跳过 → c 命中（链序保持）')
    ws = workerSpawns(calls)
    assert.deepEqual(ws[4].request.agentOptions, { provider: 'prov', model: 'c' }, 'W1 run2 覆盖落到备用链次位 prov/c（b 冷却跳过，链序=配置水位优先序）')
    faults.bareHandles[2](new Error(BARE_KILL_TEXT)) // 回收 W1 run2 裸请求 → 失败臂回 pending
    await env.waitFor(function () { var x = env.task('task-w1'); return x && x.status === 'pending' && x.retryCount === 2 ? x : null }, 'W1 run2 裸请求回收 → pending（等链尾）')
    // W1 run3：a+b+c 冷却 → 备用链链尽 → C5 降档 standard 槽 d → 覆盖 d → 429 秒死 → 登记 d → 裸请求（不再回收，W1 停在 in-progress）
    await env.clock.advance(50)
    calls = await env.waitFor(function () { return workerSpawns(faults.calls).length >= 8 ? faults.calls : null }, 'W1 run3：备用链链尽 → C5 降档命中 standard 槽 d')
    ws = workerSpawns(calls)
    assert.deepEqual(ws[6].request.agentOptions, { provider: 'prov', model: 'd' }, 'W1 run3 覆盖落到 C5 降档 standard 槽 prov/d（备用链链尽后才降档，链序正确）')
    assert.ok(faults.thrown[D], 'd 429 秒死（故障表限流）→ 嗅探臂登记 d 冷却')
    var w1b = await env.waitFor(function () { var x = env.task('task-w1'); return x && cooldownMsgs(x).length >= 4 ? x : null }, 'W1 三轮冷却登记留痕齐（等链尾）')
    // W1 卡上链序留痕全谱：fallback 命中 2 条（b/c）+ C5 降档 1 条（d）+ 额度冷却登记 3 条（b/c/d）
    assert.equal(fallbackMsgs(w1b).length, 2, 'W1 备用链命中留痕 2 条（b、c——L709 冷却分态文案）')
    assert.equal(cooldownMsgs(w1b).filter(function (m) { return m.text.indexOf('降档为') >= 0 }).length, 1, 'W1 C5 降档留痕 1 条（d——L739）')
    assert.equal(cooldownMsgs(w1b).filter(function (m) { return m.text.indexOf('额度冷却至') >= 0 }).length, 3, 'W1 额度冷却登记留痕 3 条（b、c、d——L151）')

    // ===== 第一幕·主卡重派：a 冷却 → 备用链 b/c 全冷却 → C5 降档 d 也冷却 → light 空槽 → parent 兜底
    //（spawn 日志无 agentOptions；modelSource='cooldown-downgrade'；L739 留痕「降档为 父模型」）
    faults.bareHandles[0](new Error(BARE_KILL_TEXT)) // 回收 M run1 裸请求 → 失败臂回 pending
    await env.waitFor(function () { var x = env.task('task-m1'); var wr = x && x.runs ? workerRuns(x) : []; return x && x.status === 'pending' && x.retryCount === 1 && wr[0] && wr[0].outcome === 'timeout/error' ? x : null }, 'M run1 裸请求回收 → 失败臂回 pending 且 run 关账（等链尾）')
    await env.clock.advance(50)
    calls = await env.waitFor(function () { return workerSpawns(faults.calls).length >= 9 ? faults.calls : null }, 'M 重派：全链冷却 → parent 兜底 spawn（等链尾）')
    ws = workerSpawns(calls)
    assert.equal(ws.length, 9, '第一幕共 9 次 worker spawn（M run1 2 + W1 三轮 6 + M 重派 1）')
    assert.equal(ws[8].request.agentOptions, undefined, '重派 spawn 日志无 agentOptions——a 冷却 → 备用链 b/c 全冷却 → C5 降档 d 冷却 → light 空槽 → parent 兜底')
    var m1r = await env.waitFor(function () { var x = env.task('task-m1'); var wr = x && x.runs ? workerRuns(x) : []; return x && x.status === 'in-progress' && wr[1] && wr[1].modelSource ? x : null }, 'M 重派 run 留档（等链尾）')
    assert.equal(workerRuns(m1r)[1].modelSource, 'cooldown-downgrade', '重派 run 留档 modelSource=cooldown-downgrade（C5 降档链走完落 parent）')
    assert.equal(workerRuns(m1r)[1].model, '', '重派 run 留档 model 空（parent 兜底无模型归因，L691）')
    var cdAll = cooldownMsgs(m1r)
    assert.equal(cdAll.length, 2, 'M 卡冷却留痕 2 条（run1 登记 a + 重派 C5 降档）')
    assert.equal(cdAll[1].text, '⏳ 原档模型 prov/a 冷却中（至 ' + hhmm(aUntil) + '），本 run 降档为 父模型', 'L739 C5 降档到 parent 文案逐字（备用链全冷却 → light 空槽）')
    // ③ 健康表 a/b/d 呈 cooldown 态（get-tasks modelHealthView 透出；重置时刻未过 → cooldown 现算）
    var mh1 = await healthOf(env)
    assert.equal(mh1[A].state, 'cooldown', '健康面 a cooldown 态')
    assert.equal(mh1[A].until, aUntil, '健康面 until = 嗅探登记的重置时刻（精确 ts）')
    assert.ok(mh1[A].note.indexOf('额度限流') >= 0, '健康面 note 分态=额度限流（非连接分态）')
    assert.equal(mh1[B].state, 'cooldown', '健康面 b cooldown 态')
    assert.equal(mh1[D].state, 'cooldown', '健康面 d cooldown 态')
    // ④ badModels 面零污染（第一幕校验）：健康面零 circuit——限流只进冷却表，不落 badModels 熔断
    assert.ok(mh1[A].state !== 'circuit' && mh1[B].state !== 'circuit' && mh1[D].state !== 'circuit', '健康面零 circuit（限流只进冷却，熔断面零污染）')

    // ===== 第二幕：b 换健康（故障表改为 b 正常）→ b 冷却墙钟过期（惰性清除）→ 新卡重派 →
    // a 冷却 → 备用链命中 b（modelSource='fallback' + L709 文案逐字）
    faults.table[B] = 'ok' // 故障表 b 正常（冷却表不动——墙钟过期自动退出冷却）
    var bOk = await env.waitFor(async function () { return healthOf(env).then(function (mh) { return mh[B] && mh[B].state !== 'cooldown' ? mh[B] : null }) }, 'b 冷却墙钟过期（重置时刻已过，健康面退出 cooldown——惰性清除口径）', 25000)
    assert.ok(bOk && bOk.state !== 'cooldown', 'b 冷却过期且未熔断（限流不进 badModels 的行为前提）')
    await createTask(env, 'task-a2', { pipeline: 'work', size: 'heavy' })
    await env.clock.advance(50)
    calls = await env.waitFor(function () { return workerSpawns(faults.calls).length >= 10 ? faults.calls : null }, '第二幕 spawn 发生（a 冷却 → 备用链命中 b）')
    ws = workerSpawns(calls)
    // ② 第二幕 spawn 落 b
    assert.deepEqual(ws[9].request.agentOptions, { provider: 'prov', model: 'b' }, '第二幕 spawn 落备用链首位 prov/b（a 冷却 → 下一轮真派发链自动绕行闭环）')
    var a2 = await env.waitFor(function () { var x = env.task('task-a2'); var wr = x && x.runs ? workerRuns(x) : []; return x && x.status === 'in-progress' && wr[0] && wr[0].modelSource === 'fallback' ? x : null }, '第二幕卡 modelSource=fallback 留档（等链尾）')
    assert.equal(workerRuns(a2)[0].model, B, '第二幕 run 留档 model=prov/b')
    var fb2 = fallbackMsgs(a2)
    assert.equal(fb2.length, 1, '第二幕 fallback 留痕一条')
    // ② fallback 留痕文案逐字匹配（L709 冷却分态——若 a 进了熔断会是「熔断中」L676，分态即④的反证）
    assert.equal(fb2[0].text, '🔀 原模型 prov/a 冷却中（至 ' + hhmm(aUntil) + '），切备用 prov/b', 'L709 fallback 留痕文案逐字匹配（原模型 prov/a 冷却中…切备用 prov/b）')
    // ④ badModels 面零污染（第二幕收口）：健康面零 circuit + b 冷却过期后仍被备用链重新取用
    //（calls[9] 落 b——若限流进了熔断，b 会被 badModels 拉黑永不复用；重取即零污染的直接行为反例）
    var mh2 = await healthOf(env)
    var ids4 = [A, B, C, D]
    for (var i4 = 0; i4 < ids4.length; i4++) {
      assert.ok(mh2[ids4[i4]] && mh2[ids4[i4]].state !== 'circuit', '健康面零 circuit：' + ids4[i4] + '（限流只进冷却不进熔断）')
    }
  } finally { await env.cleanup() }
})
