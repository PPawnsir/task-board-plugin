// ===== 故障 E2E：恢复旅程收口——秒拆 ×2 → 连败软闸跳 good → continuable 交付 → verifying → verifier 一次性 approved → resolved（健康模型收口，task-mvqi3uj4-7）=====
// 前序：task-mvqi3uj4-2 秒拆三连熔断（fault-e2e-circuit，一次性面 workerContinuable=false 恒 fresh spawn，
// 终局 blocked）。本卡补「健康模型上的完整旅程」：同一套基建故障层（helpers/fault-provider.mjs），
// 走 continuable 缺省路径全循环——卡最终在健康模型上交付、验收、resolved，把「故障注入→真派发→看板
// 行为」串成一条永久回归。本文件是「每起生产事故落端到端场景」的模板范式：后续新事故类照本文件
// 结构加文件即可。
//
// 机制锚点：
//   · worker continuable 缺省开（dispatch.mjs L800 useContinuable = role==='worker' && workerContinuable!==false）
//     → Worker 恒走 continuable 面（v0.2.1 宿主契约：startActivation delivery='parent'，结算走 agent/status 事件）；
//   · verifier 恒一次性（L774 useContinuable 只对 worker 开）→ delivery='caller'，run.result 结算；
//   · 秒拆故障在 continuable 面走 activation.result 拒绝臂（dispatch.mjs activation 拆除臂）→ settleWorker
//     失败臂（isModelKillFailure 经「子会话 activation 异常：」前缀命中）→ 重排 pending + 熔断连击+1
//     （2 连 < 3 不拉黑，软闸接管）；
//   · 连败软闸（task-mvd3li6）：healthyModel 四闸之 recentRuns ≥2 全败（settleRunRecord 每次结算喂给
//     observeModel）→ 软熔断不落 badModels 黑名单，仅取模/续跑跳过——本旅程 run3 靠它跳过 flaky 取次选 good；
//   · board_report/board_verdict 工具通道 + settleRunRecord 补停（settle-stop-interrupt.test.mjs ①事故原形
//     路径）：completed 落定无续跑位 → 结算收尾补停 interrupt；
//   · history 流转断言 transitions()（integration.test.mjs L80 同款）。
//
// 旅程（真派发循环：rpc create-task → clock.advance(50) 踢 poolCycle → waitFor 收敛）：
//   laneModels.standard.worker=['prov/flaky','prov/good']（llm 目录接缝：set-board-config 槽位校验与
//   dispatch modelDirectory 同源，两模型必须先在册）；flaky=instant-kill 次数窗口=前 2 次（基建卡能力）；
//   建卡（pipeline=full + acceptance 任意字符串 + size=standard——档位链命中前提，L640 if (sz && laneCfg[sz])）
//   → run1 flaky 秒拆 → run2 flaky 秒拆 → run3 软闸跳 good → continuable 交付（writeChildLog 写分段交付文本
//   + emitStatus 'running'→'idle' 事件通道结算，integration c/d 先例）→ verifying → verifier 一次性 spawn
//   （无故障，run.result 落定 APPROVE_TEXT——fault 层 healthyText=该文本，与 mock resolveWith 同口径）
//   → resolved。
//
// 断言（五条，对应任务口径）：
//   ① history 全序列 created→pending→in-progress→pending→in-progress→pending→in-progress→verifying→resolved
//     逐段在案（两次秒拆重排 + 交付 + 验收，无缺段无多余段）；
//   ② spawn 模型序列 [flaky,flaky,good] + verifier spawn 各在其位（fault 层 spawnLog 观测点 + 卡 runs 留档）；
//   ③ 终态 resolved 且 verifier 留档 outcome=completed（run 关账 + endedAt）；
//   ④ 活跃面零残留（幽灵 rec 零遗留：推进 2 轮 poolCycle 后 poolStatus 零行 + 卡面 runs 零 running）；
//   ⑤ 交付物 deliverable.summary 非空（settleContinuable 文本兜底真读子会话日志——这正是 mock 编不出的接缝）。
//
// 续跑劫持接缝（fault-e2e-circuit「为什么一次性回退开关」同款论证）：秒拆后卡面留档经幽灵回收关账
// incomplete+continuable → 重派被续跑闸劫持（tryResumeWorker sendMessage 冷复活已死会话）。真宿主对
// 被拆除 activation 的冷复活按 NOT_RESUMABLE reject（dispatch.mjs tryResumeWorker「不可复活时 reject →
// 这里转成 fallback」）；mock sendMessage 是纯记录器（永不拒）——测试显式覆写为 reject 模拟真宿主语义：
// 续跑 fallback（resume-fallback 留痕）→ fresh spawn。两次秒拆由此都走 fresh spawn（次数窗口前 2 次
// 逐次消耗）；第二次重派再被续跑健康闸（recentRuns ≥2 全败，task-mvd3li6 软闸同款判定）拦下改
// fresh spawn，档位链软闸跳 flaky 取 good——两级「绕行」都在旅程里。
//
// autoIdle:false 的取舍：健康 continuable activation 缺省会自动写 healthyText 日志并重放 idle
//（fault-provider scheduleIdle）——关掉它让交付由测试显式驱动（writeChildLog + emitStatus），
// 断言⑤才有「真读日志」的接缝价值；healthyText 仍被 healthy activation 写一次子会话日志，
// 测试的 writeChildLog 同路径覆盖，settleContinuable 读到的必是测试写的交付文本。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import { installFaults } from './helpers/fault-provider.mjs'
import * as plugin from '../index.mjs'

var zstdOk = typeof zlib.zstdCompressSync === 'function'

var FLAKY = 'prov/flaky'
var GOOD = 'prov/good'
// 秒拆诊断文本：刻意避开冷却嗅探关键词（连接/超时/网关/socket/50x 等，dispatch.mjs CONNECTIVITY_RE）——
// 否则病模型被误登记冷却，软闸在第二拆前就被冷却闸截断（熔断/冷却/软闸三张表各管各的）。
var KILL_DIAG = '宿主秒拆注入（e2e 恢复旅程）'
// Verifier 结论文本：行首锚定 APPROVED（parseVerdict 口径），分段供 parseSections 提取
//（integration.test.mjs L76 同款口径：verifySummary 认「验证概要」，checks 认「核对项」）
var APPROVE_TEXT = 'APPROVED\n\n## 验证概要\n验收脚本独立复跑通过\n\n## 核对项\n- npm test 全绿'

// ===== 测试工具（integration.test.mjs 同形）=====
// 一帧 v4 日志：多帧 zstd 顺序拼接，帧内 jsonl（readLogFrames 同形）
function frameOf(events) { return zlib.zstdCompressSync(Buffer.from(events.map(function (e) { return JSON.stringify(e) }).join('\n') + '\n', 'utf8')) }
// 写 continuable 子会话日志（settleContinuable 文本兜底数据源）：<home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd
function writeChildLog(env, childId, text) {
  var dir = path.join(env.home, '.dsh', 'sessions', 'test-bucket', childId)
  fs.mkdirSync(dir, { recursive: true })
  var ev = { type: 'assistant/message', time: Date.now(), seq: 1, data: { message: { content: [{ type: 'text', text: text }] } } }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frameOf([ev]))
}
// os.homedir() 钉到临时 HOME（Windows 认 USERPROFILE 不认 HOME）：事件结算的 findRunLog 回退路径
//（usage.mjs L29 os.homedir()/.dsh/sessions）才命中本用例临时目录
function pinHomedir(env) {
  var had = Object.prototype.hasOwnProperty.call(process.env, 'USERPROFILE')
  var prev = process.env.USERPROFILE
  process.env.USERPROFILE = env.home
  return function () { if (had) process.env.USERPROFILE = prev; else delete process.env.USERPROFILE }
}
// 建卡封装：显式 description 避开空描述软提示
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '恢复旅程 ' + id, description: '故障E2E恢复用例 ' + id }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  return r.task
}
// history 流转序列（integration.test.mjs L80 同款）
function transitions(t) { return (t.history || []).map(function (h) { return h.from + '→' + h.to }) }
// 补停记录（settle-stop-interrupt 同形）
function stopsOn(env, childId) { return env.interrupts.filter(function (x) { return x.childId === childId }) }
// Worker 交付文本（事件通道文本兜底用）：分段格式，避开 [ESCALATE] 标记
function workerText(tag) {
  return '## 开发描述\n完成 ' + tag + ' 的实现\n\n## 改动清单\n- src/' + tag + '.mjs：新增实现\n\n## 自测情况\nnpm test 全绿\n\n## diff 概要\n 1 file changed, 10 insertions(+)'
}

// ===== 主场景：秒拆×2 → 软闸跳 good → 事件通道交付 → verifier 一次性 approved → resolved（健康模型收口）=====
test('故障E2E·恢复旅程：秒拆×2→连败软闸跳 good→事件通道交付 verifying→verifier 一次性 approved→resolved（健康模型收口）', async (t) => {
  if (!zstdOk) { t.skip('zstdCompressSync unavailable'); return }
  var env = createMockCtx()
  var restoreHome = pinHomedir(env)
  try {
    // 基建卡故障层（helpers/fault-provider.mjs）：activation 契约（spawn 翻到 startActivation，v0.2.1
    // 宿主路径）+ llm 目录（目录闸接缝）+ instant-kill 次数窗口=前 2 次；autoIdle:false = 交付由测试
    // 显式驱动（见头注释）。诊断文本避开冷却关键词（见 KILL_DIAG 注）。
    var h = installFaults(env, {
      activation: true,
      autoIdle: false,
      directory: [FLAKY, GOOD],
      healthyText: APPROVE_TEXT,
      programs: [{ type: 'instant-kill', times: 2, diagnostic: KILL_DIAG, match: { role: 'worker' } }],
    })
    plugin.apply(env.ctx)
    // 续跑劫持接缝：秒拆后留档 incomplete+continuable → 重派被续跑闸劫持（sendMessage 冷复活已死
    // 会话）。真宿主对被拆除 activation 的冷复活按 NOT_RESUMABLE reject（tryResumeWorker「不可复活时
    // reject → 转成 fallback」）；mock sendMessage 是纯记录器永不拒——显式覆写为 reject 模拟真宿主，
    // 续跑 fallback → fresh spawn，[flaky,flaky,good] 三次 fresh spawn 才成立。
    env.ctx.subagents.sendMessage = async function () {
      throw new Error('NOT_RESUMABLE: 子会话已被宿主拆除（秒拆注入），不可冷复活')
    }
    // 目录闸接缝：两模型先在册 → laneModels 槽位校验放行（rpc enumModels 与 dispatch modelDirectory 同源）
    var lm = await env.rpc('set-board-config', { sessionId: env.sid, key: 'laneModels', value: { standard: { worker: [FLAKY, GOOD] } } })
    assert.equal(lm.ok, true, '故障层 llm 目录在册 → set-board-config laneModels 槽位放行')
    // 建卡：pipeline=full + acceptance（任意字符串，验收由 mock verifier 文本通道）+ size=standard
    //（档位链命中前提：dispatch.mjs L640 if (sz && laneCfg[sz])——缺 size 不查档位表）
    await createTask(env, 'task-rec', { pipeline: 'full', acceptance: 'node --test test/fault-e2e-recovery.test.mjs', size: 'standard' })

    // ===== run1：flaky 秒拆（activation.result 秒拒 → activation 异常兜底臂 → settleWorker 失败臂重排）=====
    // waitFor 一律等「结算链尾」：spawn 留痕在先、失败重排在后——与 fault-e2e-circuit 同款纪律。
    await env.clock.advance(50)
    var t1 = await env.waitFor(function () {
      var x = env.task('task-rec')
      return x && x.status === 'pending' && x.retryCount === 1 && x.runs && x.runs.length === 1 && x.runs[0].model === FLAKY && h.spawnLog.length >= 1 && h.spawnLog[0].model === FLAKY ? x : null
    }, 'run1 flaky 秒拆：重排 pending 且 spawn 于 prov/flaky')
    assert.equal(h.spawnLog[0].method, 'startActivation', 'continuable 面走 activation 契约（worker continuable 缺省开，L800）')
    assert.equal(h.spawnLog[0].delivery, 'parent', 'continuable 面 delivery=parent（结算走事件通道）')
    assert.equal(h.spawnLog[0].fault, 'instant-kill', '故障程序命中（次数窗口 1/2）')
    assert.ok(String(t1.lastError).indexOf('被宿主拆除') >= 0, '失败原因落卡（lastError，排查不靠猜）')
    assert.equal(t1.runs[0].modelSource, 'lane', 'modelSource=lane（档位链命中）')
    assert.equal(env.runs.length, 0, 'Worker 走 continuable/activation 面，零一次性 start（L774 对偶：start 只留给 verifier）')

    // ===== run2：NOT_RESUMABLE fallback → fresh spawn flaky 秒拆 ×2 =====
    //（run1 留档经幽灵回收关账 incomplete+continuable → 重派被续跑闸劫持 → sendMessage reject →
    // resume-fallback 留痕 → fresh spawn；recentRuns 1 败 < 2 未达软闸线 → 档位链首位 flaky 仍被选中）
    await env.clock.advance(50)
    var t2 = await env.waitFor(function () {
      var x = env.task('task-rec')
      return x && x.status === 'pending' && x.retryCount === 2 && x.runs && x.runs[0] && x.runs[0].outcome === 'incomplete' && x.runs[1] && x.runs[1].model === FLAKY && x.messages && x.messages.some(function (m) { return m.kind === 'resume-fallback' }) && h.spawnLog.length >= 2 && h.spawnLog[1].model === FLAKY ? x : null
    }, 'run2 flaky 秒拆 ×2：续跑 fallback（NOT_RESUMABLE）→ fresh spawn 仍取 flaky（连败 1 次未达软闸线）')
    assert.ok(t2.runs[0].endedAt, 'run1 留档关账有 endedAt（reapGhostRecs → settleRunRecord 只补收尾）')
    var fb1 = t2.messages.filter(function (m) { return m.kind === 'resume-fallback' })
    assert.equal(fb1.length, 1, '续跑 fallback 留痕恰一条（NOT_RESUMABLE → 已回退全新 Worker 重跑）')
    assert.ok(fb1[0].text.indexOf('断点续跑不可用') === 0, 'fallback 留痕文本口径（先写说明再 spawn）')
    assert.equal(t2.runs[1].modelSource, 'lane', 'run2 仍取档位链首位（recentRuns 1 败 < 2 未达软闸线）')

    // ===== run3：续跑健康闸（recentRuns ≥2 全败）拦下重派 → fresh spawn 档位链软闸跳 good =====
    await env.clock.advance(50)
    var t3 = await env.waitFor(function () {
      var x = env.task('task-rec')
      return x && x.status === 'in-progress' && x.runs && x.runs[1].outcome === 'incomplete' && x.runs[2] && x.runs[2].model === GOOD && h.spawnLog.length >= 3 && h.spawnLog[2].model === GOOD ? x : null
    }, 'run3 软闸跳 good：recentRuns 2 全败 → 续跑健康闸拦下重派 + healthyModel 拦下 flaky，槽内次选 prov/good 接手')
    assert.equal(h.spawnLog[2].fault, null, '第 3 次 spawn 无故障（次数窗口已耗尽 + 软闸跳病模型）')
    var fb2 = t3.messages.filter(function (m) { return m.kind === 'resume-fallback' })
    assert.equal(fb2.length, 2, '第二次重派续跑同样 fallback 留痕（共两条）')
    assert.ok(fb2[1].text.indexOf('续跑放弃') >= 0 && fb2[1].text.indexOf(FLAKY) >= 0, '第二次 fallback=续跑健康闸（recentRuns ≥2 全败 → 续跑放弃，点名原模型）')
    assert.equal(t3.runs[2].modelSource, 'lane', 'run3 modelSource=lane（软闸槽内跳过，非降级非绕链）')
    assert.equal(h.programs[0].used, 2, '次数窗口消耗 2 次（基建卡能力）')
    assert.equal(h.programs[0].done, true, 'times 用尽即 done（自愈）')

    // ===== continuable 交付（事件通道，integration c/d 先例）：writeChildLog + emitStatus running→idle =====
    // 健康子会话识别：fault 层合成 activation 带 __fault（秒拆命中）留档，健康 spawn __fault=null。
    var workerKids = env.continuables.filter(function (c) { return c.label === 'worker:task-rec' && !c.__fault })
    assert.equal(workerKids.length, 1, '健康 continuable 子会话恰一个（fault 层合成 childId）')
    var goodChild = workerKids[0].childId
    writeChildLog(env, goodChild, workerText('task-rec'))
    env.emitStatus(goodChild, 'running')
    env.emitStatus(goodChild, 'idle')
    var t3b = await env.waitFor(function () {
      var x = env.task('task-rec')
      return x && x.status === 'verifying' && x.deliverable && x.deliverable.summary && x.runs && x.runs[2] && x.runs[2].outcome === 'completed' ? x : null
    }, '事件通道交付：settleContinuable 文本兜底真读子会话日志 → deliverable.summary → verifying（full 档）')
    assert.equal(t3b.deliverable.summary, '完成 task-rec 的实现', '⑤ 交付物走文本分段解析（settleContinuable 真读日志——mock 编不出的接缝）')
    assert.ok(t3b.deliverable.changes, 'changes 段解析非空')
    assert.ok(t3b.deliverable.selfTest, 'selfTest 段解析非空')
    assert.ok(t3b.runs[2].endedAt, 'run3 关账 completed（settleRunRecord）')
    assert.equal(t3b.runs[2].continuable, true, 'run3 continuable 留档')
    assert.equal(t3b.runs[2].model, GOOD, 'run3 模型=prov/good')

    // ===== verifier 一次性 spawn（无故障）：run.result 落定 APPROVE_TEXT → approved → resolved =====
    //（fault 层 healthyText=APPROVE_TEXT：delivery='caller' 健康合成 result 正常落定——与 mock
    // resolveWith(APPROVE_TEXT) 同口径，run.result 结算 → settleVerifier parseVerdict。）
    await env.clock.advance(50)
    var t4 = await env.waitFor(function () {
      var x = env.task('task-rec')
      return x && x.status === 'resolved' && x.verification && x.verification.verdict === 'approved' && x.runs && x.runs.length === 4 && x.runs[3] && x.runs[3].outcome === 'completed' ? x : null
    }, 'verifier 一次性 spawn（无故障）run.result=APPROVE_TEXT → approved → resolved 且 run 关账 completed')
    var verifyKid = env.continuables.filter(function (c) { return c.label === 'verifier:task-rec' })[0]
    assert.ok(verifyKid, 'verifier activation 在 fault 层留痕')
    assert.equal(h.spawnLog[3].label, 'verifier:task-rec', 'verifier spawn 各在其位')
    assert.equal(h.spawnLog[3].delivery, 'caller', 'verifier 恒一次性面（L774）delivery=caller')
    assert.equal(h.spawnLog[3].fault, null, 'verifier spawn 无故障（次数窗口已耗尽 + match worker 不命中）')
    assert.equal(h.spawnLog[3].model, '', 'verifier 不进档位链 → 父模型（无 agentOptions）')
    assert.equal(t4.runs[3].id, verifyKid.childId, 'verifier run id 归因到 activation childId')
    assert.equal(t4.verification.summary, '验收脚本独立复跑通过', 'L76 口径结论文本解析（verifySummary）')
    assert.ok(t4.verifiedAt && t4.verifiedBy, '验收留痕 verifiedAt/verifiedBy')
    assert.ok(t4.resolvedAt, 'resolvedAt 落卡')

    // ===== ① history 全流转序列逐段在案 =====
    assert.deepEqual(transitions(t4), [
      'created→pending', 'pending→in-progress', 'in-progress→pending',
      'pending→in-progress', 'in-progress→pending',
      'pending→in-progress', 'in-progress→verifying', 'verifying→resolved',
    ], '① history 全序列：两次秒拆重排 + 交付 verifying + 验收 resolved 逐段在案')
    // ===== ② spawn 模型序列 [flaky,flaky,good] + verifier 各在其位 =====
    assert.deepEqual(h.spawnLog.map(function (e) { return e.model }), [FLAKY, FLAKY, GOOD, ''], '② spawn 模型序列 [flaky,flaky,good] + verifier 父模型')
    assert.deepEqual(h.spawnLog.map(function (e) { return e.fault }), ['instant-kill', 'instant-kill', null, null], '② fault 分档：前 2 秒拆后自愈，verifier 无故障')
    assert.deepEqual(h.spawnLog.map(function (e) { return e.method }), ['startActivation', 'startActivation', 'startActivation', 'startActivation'], '② 全程 activation 契约')
    assert.ok(t4.runs.slice(0, 3).every(function (r) { return r.modelSource === 'lane' }), '三次 worker 取模全命中档位链（lane）')
    assert.equal(t4.runs[3].modelSource, 'parent', 'verifier modelSource=parent')
    // ===== ③ 终态 resolved 且 verifier 留档 outcome=completed =====
    assert.equal(t4.status, 'resolved', '③ 终态 resolved')
    assert.equal(t4.runs[3].outcome, 'completed', '③ verifier 留档 outcome=completed')
    assert.ok(t4.runs[3].endedAt, '③ verifier 关账有 endedAt')

    // ===== ④ 活跃面零残留（幽灵 rec 零遗留）=====
    await env.clock.advance(50)
    await env.clock.advance(50) // 推进 2 轮 poolCycle：卡 resolved → 空闲快进，池状态归零
    var b = env.board()
    assert.equal((b.poolStatus.workers || []).length, 0, '④ poolStatus.workers 零残留')
    assert.equal((b.poolStatus.verifiers || []).length, 0, '④ poolStatus.verifiers 零残留')
    var t5 = env.task('task-rec')
    assert.ok(t5.runs.every(function (r) { return r.outcome !== 'running' }), '④ 卡面 runs 零 running 行（幽灵 rec 零遗留）')
    assert.ok(t5.runs.every(function (r) { return r.endedAt }), '④ 全部留档关账（有 endedAt）')
    assert.ok(t5.deliverable && t5.deliverable.summary, '⑤ deliverable.summary 非空（复锚定）')

    // ===== 加餐：结算≠停止根修补停（settle-stop-interrupt ①通道）——completed 落定无续跑位 → 补停 =====
    await env.waitFor(function () { return stopsOn(env, goodChild).length >= 1 }, 'continuable worker completed 落定补停（settleRunRecord 末尾）')
    // ===== 加餐：软闸不落硬黑名单（连败软闸 vs 熔断语义分治）=====
    var gt = await env.rpc('get-tasks', { sessionId: env.sid })
    var mh = gt.modelHealth || (gt.data && gt.data.modelHealth) || {}
    var fe = mh[FLAKY]
    assert.ok(fe && fe.state !== 'circuit', '连败软闸不落 badModels 黑名单（软熔断仅取模跳过，与硬熔断语义分治）')
    assert.ok(Array.isArray(fe.recentRuns) && fe.recentRuns.length >= 2 && fe.recentRuns.every(function (r) { return !r.ok }), '健康表 recentRuns ≥2 全败（软闸数据源）')
  } finally { restoreHome(); await env.cleanup() }
})


