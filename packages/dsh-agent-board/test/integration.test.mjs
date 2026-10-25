// dsh-agent-board — 集成套件（无头基建卡2 前半 + 卡3 后半）：
//   前半（a-d）：全链路 / 驳回重派 / dependsOn 接续 / touches 排他
//   后半（e-i，task-muxpgq5b）：仲裁冻结时钟推进 / 回执聚合过滤 / 歧义去抖 / progress / 孤儿回收
//   竞态根修（k-m，task-mv6c7cdm）：terminate×续跑在途落闸弃权 / 正常续跑不回归 / fresh spawn 在途弃权
//   依赖后补根修（n-o，task-mv9yupm4）：publish 后补 dependsOn 撞在途 spawn 落闸否决+依赖落定重派 /
//   update-task 在飞卡写依赖 warning 软提示（pending 卡不带）
//   开工计划闸口（p，task-mvneoyba）：『计划改动：』前缀 progress 自动比对 touches 边界——
//   全合规/部分越界/无 touches 三路径 + 越界三通道警示（卡 messages+主窗口通知+返回体 warning）+ 幂等
// 九场景全部跑在「真实 index.mjs apply(mockCtx)」上（卡1 harness），不改生产代码；
// 每用例独立 mockCtx + 独立临时 HOME，互不污染（HOME env 是进程级，顶层用例默认串行，严禁并行）。
//
// 结算双通道各半（任务要求）：
//   上报通道（board_report 工具直调——mock tools.register 捕获的 handler）：场景 a / b
//   事件通道（agent/status 的 running→idle → settleContinuable 文本兜底）：场景 c / d
// 事件通道文本兜底的前提：settleContinuable 从子会话 v4 日志读助手文本。生产经 findRunLog 回退
// os.homedir()/.dsh/sessions——Windows 下 os.homedir() 认 USERPROFILE 不认 HOME，故 c/d 两例把
// USERPROFILE 也钉到本用例临时 HOME（pinHomedir），再往 <home>/.dsh/sessions/<桶>/<childId>/
// session.v4.jsonl.zstd 写真 zstd 帧（与 usage 单测同形），事件结算即可读到本轮交付文本。
//
// 时钟纪律：看板时间戳仍走真实墙钟（Date.now 不动），kickCycle 的 50ms 去抖走虚拟时钟——
// 每个写操作后 advance(50) 触发一轮 poolCycle。前半（a-d）单场景推进 ≤300ms 虚拟，所有长窗口
// 均不触发；后半（e-i）开始主动跨窗断言：25s 歧义去抖（g）、45s 回执聚合（f）、15s 心跳轮
// （e 的幽灵回收 / i 的孤儿扫描）。30min 软超时 / 120min 硬超时仍远超推进幅度（单场景 ≤45s
// 虚拟），永不触发。注意 isOrphan 的 2min 门槛锚的是真实墙钟（Date.now），场景 i 用 patchBoard
// 把 claimedAt 按真实时间倒推 3 分钟来构造孤儿——虚拟时钟只负责把 poolCycle 推到扫描窗口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

var zstdOk = typeof zlib.zstdCompressSync === 'function'

// ===== 测试工具 =====
// 一帧 v4 日志（与 lib/usage.mjs readLogFrames 同形：多帧 zstd 顺序拼接，帧内 jsonl）
function frameOf(events) { return zlib.zstdCompressSync(Buffer.from(events.map(function (e) { return JSON.stringify(e) }).join('\n') + '\n', 'utf8')) }

// 写一份 continuable 子会话日志：内含一条 assistant/message 文本帧（settleContinuable 的文本兜底数据源）。
// 布局与真实一致 <home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd（findRunLog 按桶探测）。
function writeChildLog(env, childId, text) {
  var dir = path.join(env.home, '.dsh', 'sessions', 'test-bucket', childId)
  fs.mkdirSync(dir, { recursive: true })
  var ev = { type: 'assistant/message', time: Date.now(), seq: 1, data: { message: { content: [{ type: 'text', text: text }] } } }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frameOf([ev]))
}

// 把 os.homedir() 钉到本用例临时 HOME（Windows 下认 USERPROFILE）；返回恢复闭包（finally 里先于 cleanup 调）
function pinHomedir(env) {
  var had = Object.prototype.hasOwnProperty.call(process.env, 'USERPROFILE')
  var prev = process.env.USERPROFILE
  process.env.USERPROFILE = env.home
  return function () { if (had) process.env.USERPROFILE = prev; else delete process.env.USERPROFILE }
}

// 建卡封装：显式 description 避开空描述软提示；其余字段按需透传
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '集成任务 ' + id, description: '集成套件用例 ' + id }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  assert.equal(r.task.status, 'pending', '非 Team 模式即建即 pending: ' + id)
  return r.task
}

// Worker 交付文本（事件通道文本兜底用）：分段格式，避开 [ESCALATE] 标记
function workerText(tag) {
  return '## 开发描述\n完成 ' + tag + ' 的实现\n\n## 改动清单\n- src/' + tag + '.mjs：新增实现\n\n## 自测情况\nnpm test 全绿\n\n## diff 概要\n 1 file changed, 10 insertions(+)'
}
// Verifier 结论文本：行首锚定 APPROVED/REJECTED（parseVerdict 口径），分段供 parseSections 提取
//（verifySummary 只认「测试概要|验证概要|审查概要」标题，checks 只认「核对项|核验项|检查项」——标题口径别写错）
var APPROVE_TEXT = 'APPROVED\n\n## 验证概要\n验收脚本独立复跑通过\n\n## 核对项\n- npm test 全绿'
var REJECT_TEXT = 'REJECTED\n\n## 验证概要\n验收脚本未通过：缺关键断言\n\n## 核对项\n- npm test 未见运行记录'

// history 流转序列（['created→pending', 'pending→in-progress', ...]），供全路径逐项断言
function transitions(t) { return (t.history || []).map(function (h) { return h.from + '→' + h.to }) }

// 取卡上某角色的 runs 条目
function runsOf(t, role) { return (t.runs || []).filter(function (r) { return r.role === role }) }

// 事件通道完成一个 continuable Worker turn：先写子会话日志（交付文本），再重放 running→idle
async function settleViaEvents(env, childId, tag) {
  writeChildLog(env, childId, workerText(tag))
  env.emitStatus(childId, 'running')
  env.emitStatus(childId, 'idle')
}

// ===== 场景 a：全链路（上报通道）=====
// 创建 → 自动派发（continuable spawn）→ Worker board_report 完成 → verifying →
// Verifier 自动派发（一次性 run）→ APPROVED → resolved。状态机全路径 status/history/runs 逐项断言。
test('集成a·全链路：创建→自动派发→Worker board_report 完成→Verifier approved→resolved（上报通道）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-a1', { pipeline: 'full', acceptance: 'npm test' })
    // 自动派发：kickCycle 50ms 去抖 → poolCycle → continuable spawn
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn 发生')
    var child = env.continuables[0]
    assert.equal(child.label, 'worker:task-a1', 'spawn label 形如 worker:<taskId>')
    assert.equal(env.runs.length, 0, 'Worker 走 continuable 面，不动一次性 start')
    var t = await env.waitFor(function () { var x = env.task('task-a1'); return x && x.status === 'in-progress' && x.claimedBy === child.childId ? x : null }, '落卡 in-progress 且 claimedBy=childId')
    assert.deepEqual(transitions(t), ['created→pending', 'pending→in-progress'], '创建+占位 claim 两段历史')
    assert.equal(t.runs.length, 1)
    assert.equal(t.runs[0].role, 'worker')
    assert.equal(t.runs[0].outcome, 'running', '在跑 run 记录 outcome=running')
    assert.equal(t.runs[0].continuable, true)
    // Worker 上报通道：board_report 工具直调（mock tools.register 捕获的 handler）
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-a1', kind: 'complete', summary: '实现全链路', changes: '改了 a', selfTest: 'npm test 全绿', diffStat: ' 1 file changed' })
    assert.equal(rep.ok, true)
    assert.equal(rep.task.status, 'verifying', 'full 档上报完成 → verifying')
    t = env.task('task-a1')
    assert.equal(t.deliverable.summary, '实现全链路', '交付物随工具参数落卡')
    assert.equal(t.deliverable.selfTest, 'npm test 全绿')
    // 上报通道收尾三件套之一：该轮 continuable run 记录当场关账（execute 内已 await settleReportedRun）
    assert.equal(t.runs[0].outcome, 'completed', 'board_report 落定即关账，不等 idle 事件')
    assert.ok(t.runs[0].endedAt, '关账写 endedAt')
    // Verifier 自动派发（一次性 run 路径，run.result 结算）
    await env.clock.advance(50)
    var vrun = await env.waitFor(function () { return env.lastRun('verifier:task-a1') }, 'verifier spawn 发生')
    assert.equal(vrun.req.label, 'verifier:task-a1')
    t = await env.waitFor(function () { var x = env.task('task-a1'); return x && x.verifierRun === vrun.id ? x : null }, 'verifierRun 占位换成真实 run id')
    assert.equal(t.status, 'verifying')
    // Verifier 批准 → resolved（waitFor 必须等到整条结算链尾：状态推进与 run 关账是两次持锁写，
    // 只等 status 会撞上「resolved 已落盘而 verifier run 还未关账」的窗口——与卡1 冒烟同口径）
    vrun.resolveWith(APPROVE_TEXT)
    t = await env.waitFor(function () { var x = env.task('task-a1'); return x && x.status === 'resolved' && runsOf(x, 'verifier')[0] && runsOf(x, 'verifier')[0].outcome === 'completed' ? x : null }, 'approved 落 resolved 且 verifier run 关账')
    // ===== 状态机全路径逐项 =====
    assert.deepEqual(transitions(t), ['created→pending', 'pending→in-progress', 'in-progress→verifying', 'verifying→resolved'], '全链路流转序列')
    assert.equal(t.verification.verdict, 'approved')
    assert.equal(t.verification.summary, '验收脚本独立复跑通过')
    assert.ok(t.verifiedAt && t.verifiedBy, '验收留痕 verifiedAt/verifiedBy')
    assert.ok(t.resolvedAt, 'resolvedAt 落卡')
    assert.equal(t.runs.length, 2, 'worker + verifier 各一条 run 留档')
    var vr = runsOf(t, 'verifier')
    assert.equal(vr.length, 1)
    assert.equal(vr[0].outcome, 'completed', 'verifier run 也关账 completed')
    assert.equal(vr[0].id, vrun.id)
    assert.equal(env.continuables.length, 1, '全程只有一个 Worker 子会话')
    assert.equal(env.runs.length, 1, '全程只有一条一次性 verifier run')
  } finally { await env.cleanup() }
})

// ===== 场景 b：驳回重派（上报通道）=====
// Worker board_report 完成 → Verifier REJECTED → 任务回 pending + 驳回包落 messages →
// 去抖后自动重派新 Worker（首轮 completed 无续跑资格 → fresh spawn，且驳回包随 prompt 注入）→
// 第二轮完成 → approved → resolved。
test('集成b·驳回重派：Verifier rejected→回 pending+驳回包落 messages→自动重派→approved（上报通道）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-b1', { pipeline: 'full', acceptance: 'npm test' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, '第一轮 worker spawn')
    var child1 = env.continuables[0]
    await env.waitFor(function () { var x = env.task('task-b1'); return x && x.status === 'in-progress' && x.claimedBy === child1.childId ? x : null }, '第一轮落卡 in-progress')
    // 第一轮 Worker 上报完成 → verifying
    var rep1 = await env.tools.get('board_report').execute({ taskId: 'task-b1', kind: 'complete', summary: '第一版交付', changes: '改了 b', selfTest: 'npm test 全绿（谎报）', diffStat: '' })
    assert.equal(rep1.ok, true)
    await env.clock.advance(50)
    var vrun1 = await env.waitFor(function () { return env.lastRun('verifier:task-b1') }, 'verifier spawn')
    // Verifier 驳回 → 回 pending + 驳回包落 messages + rejectCount=1
    //（等链尾：pending 落盘在先、verifier run 关账在后，一并等齐再断言）
    vrun1.resolveWith(REJECT_TEXT)
    var t = await env.waitFor(function () { var x = env.task('task-b1'); return x && x.status === 'pending' && runsOf(x, 'verifier')[0] && runsOf(x, 'verifier')[0].outcome === 'completed' ? x : null }, '驳回后回 pending 且 verifier run 关账')
    assert.equal(t.rejectCount, 1)
    assert.equal(t.claimedBy, null, '驳回后认领位清空待重派')
    var rej = (t.messages || []).filter(function (m) { return m.kind === 'rejection' })
    assert.equal(rej.length, 1, '驳回包落一条 kind=rejection 消息')
    assert.ok(rej[0].text.indexOf('验收驳回 · 验收脚本未通过：缺关键断言') === 0, '驳回包带 summary')
    assert.ok(rej[0].text.indexOf('核对项') >= 0, '驳回包带 checks 全量')
    assert.deepEqual(transitions(t), ['created→pending', 'pending→in-progress', 'in-progress→verifying', 'verifying→in-progress', 'in-progress→pending'], '驳回流转序列（verifying→in-progress→pending 两段）')
    assert.equal(t.runs.length, 2)
    assert.equal(runsOf(t, 'worker')[0].outcome, 'completed')
    assert.equal(runsOf(t, 'verifier')[0].outcome, 'completed', '驳回的 verifier run 本身正常关账')
    // 去抖后自动重派：首轮 run 结局=completed 无续跑资格 → fresh spawn（不发 sendMessage）
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 2 }, '重派新 worker spawn')
    var child2 = env.continuables[1]
    assert.equal(child2.label, 'worker:task-b1')
    assert.equal(env.sendMessages.length, 0, '结局 completed 不走断点续跑（无 sendMessage 冷复活）')
    assert.ok(child2.request.prompt[0].text.indexOf('验收驳回') >= 0, '驳回包随 messages 注入新 Worker 首条 prompt')
    t = await env.waitFor(function () { var x = env.task('task-b1'); return x && x.status === 'in-progress' && x.claimedBy === child2.childId ? x : null }, '第二轮落卡 in-progress')
    // 第二轮 Worker 上报完成 → Verifier 批准 → resolved
    var rep2 = await env.tools.get('board_report').execute({ taskId: 'task-b1', kind: 'complete', summary: '返工后交付', changes: '补上断言', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep2.ok, true)
    await env.clock.advance(50)
    var vrun2 = await env.waitFor(function () { var v = env.lastRun('verifier:task-b1'); return v && v !== vrun1 ? v : null }, '第二轮 verifier spawn')
    vrun2.resolveWith(APPROVE_TEXT)
    t = await env.waitFor(function () { var x = env.task('task-b1'); return x && x.status === 'resolved' && x.runs && x.runs.length === 4 && x.runs.every(function (r) { return r.outcome === 'completed' }) ? x : null }, '第二轮 approved 落 resolved 且全部 run 关账')
    // ===== 全路径逐项 =====
    assert.deepEqual(transitions(t), ['created→pending', 'pending→in-progress', 'in-progress→verifying', 'verifying→in-progress', 'in-progress→pending', 'pending→in-progress', 'in-progress→verifying', 'verifying→resolved'], '驳回重派全流转序列')
    assert.equal(t.runs.length, 4, '两轮 worker + 两轮 verifier 各留档')
    assert.ok(t.runs.every(function (r) { return r.outcome === 'completed' }), '四条 run 全部关账 completed')
    assert.equal(runsOf(t, 'worker').length, 2)
    assert.equal(runsOf(t, 'verifier').length, 2)
    assert.equal(env.continuables.length, 2, '两轮 Worker 各一个子会话（fresh spawn）')
    assert.equal(env.runs.length, 2, '两轮 Verifier 各一条一次性 run')
  } finally { await env.cleanup() }
})

// ===== 场景 c：dependsOn 门控 + 依赖完成后自动接续（事件通道）=====
// B dependsOn [A]：A 未 resolved 时 B 不参与派发；A 经事件通道落定 resolved 后，下一轮 cycle 自动派 B。
test('集成c·dependsOn：B 门控不派→A 事件通道完成→B 自动接续（事件通道）', async (t) => {
  if (!zstdOk) { t.skip('zstdCompressSync unavailable'); return }
  var env = createMockCtx()
  var restoreHome = pinHomedir(env) // 事件通道文本兜底读 os.homedir()/.dsh/sessions —— 钉到临时 HOME
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-ca', { pipeline: 'work' })
    await createTask(env, 'task-cb', { pipeline: 'work', dependsOn: ['task-ca'] })
    // 同一次去抖窗口只跑一轮 cycle：A 可派、B 被门控
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'A spawn 发生')
    assert.equal(env.continuables[0].label, 'worker:task-ca', '先派依赖 A')
    await env.waitFor(function () { var x = env.task('task-ca'); return x && x.status === 'in-progress' ? x : null }, 'A 落卡 in-progress')
    // 门控断言：B 留在 pending、无认领、无 spawn、无多余历史
    var tb = env.task('task-cb')
    assert.equal(tb.status, 'pending', '依赖未落定 → B 门控在 pending')
    assert.equal(tb.claimedBy, null)
    assert.equal(env.continuables.length, 1, 'B 未派发（depsSatisfied 拦截）')
    assert.deepEqual(transitions(tb), ['created→pending'], 'B 只有创建历史')
    // A 事件通道完成（work 档文本兜底直落 resolved）
    //（等链尾：resolved 落盘在先、run 关账在后——settleRunRecord 是第二次持锁写，一并等齐）
    var childA = env.continuables[0].childId
    await settleViaEvents(env, childA, 'A')
    var ta = await env.waitFor(function () { var x = env.task('task-ca'); return x && x.status === 'resolved' && x.runs && x.runs[0] && x.runs[0].outcome === 'completed' ? x : null }, 'A 事件结算落 resolved 且 run 关账')
    assert.equal(ta.deliverable.summary, '完成 A 的实现', '交付物走文本分段解析')
    assert.equal(ta.runs[0].outcome, 'completed', '事件通道同样关账 completed')
    assert.equal(ta.runs[0].continuable, true)
    assert.deepEqual(transitions(ta), ['created→pending', 'pending→in-progress', 'in-progress→resolved'], 'A 全流转（work 档无 verifying）')
    // 依赖落定 → 下一轮 cycle 自动接续派 B
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 2 }, 'B 自动接续 spawn')
    assert.equal(env.continuables[1].label, 'worker:task-cb', 'A resolved 后 B 被自动派发')
    tb = await env.waitFor(function () { var x = env.task('task-cb'); return x && x.status === 'in-progress' && x.claimedBy === env.continuables[1].childId ? x : null }, 'B 落卡 in-progress')
    // B 同样走事件通道完成
    await settleViaEvents(env, env.continuables[1].childId, 'B')
    tb = await env.waitFor(function () { var x = env.task('task-cb'); return x && x.status === 'resolved' && x.runs && x.runs[0] && x.runs[0].outcome === 'completed' ? x : null }, 'B 事件结算落 resolved 且 run 关账')
    assert.deepEqual(transitions(tb), ['created→pending', 'pending→in-progress', 'in-progress→resolved'], 'B 全流转')
    assert.equal(tb.runs[0].outcome, 'completed')
    assert.equal(env.runs.length, 0, 'work 档无 verifier，不动一次性 start')
  } finally { restoreHome(); await env.cleanup() }
})

// ===== 场景 d：touches 排他拦截 + waitingForTouches 标注 + 落定放行（事件通道）=====
// A/B 声明同一路径 touches：同轮 cycle A 先派（同优先级按创建先后），B 进 blockedTouches →
// waitingForTouches=['task-da'] 落卡展示；A 经事件通道落定 resolved（锁随状态释放）后 B 自动放行。
test('集成d·touches 排他：同路径 B 被挡+waitingForTouches 标注→A 落定→B 放行（事件通道）', async (t) => {
  if (!zstdOk) { t.skip('zstdCompressSync unavailable'); return }
  var env = createMockCtx()
  var restoreHome = pinHomedir(env)
  try {
    plugin.apply(env.ctx)
    // contextNotes 避调研门禁 warning（touches 非空的软提示，不阻断但保持输出干净）
    await createTask(env, 'task-da', { pipeline: 'work', touches: ['src/shared.mjs'], contextNotes: '调研：shared.mjs 是公共模块' })
    await createTask(env, 'task-db', { pipeline: 'work', touches: ['src/shared.mjs'], contextNotes: '调研：同上' })
    // 同轮 cycle：A 被派并即刻成为持有者，B 冲突进 blockedTouches
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'A spawn 发生')
    assert.equal(env.continuables[0].label, 'worker:task-da', '同优先级按创建先后派 A')
    await env.waitFor(function () { var x = env.task('task-da'); return x && x.status === 'in-progress' ? x : null }, 'A 落卡 in-progress')
    // 排他拦截断言：B pending + waitingForTouches 标注持有者 + 未派发
    var tb = env.task('task-db')
    assert.equal(tb.status, 'pending', 'touches 冲突 → B 拦截在 pending')
    assert.equal(tb.claimedBy, null)
    assert.deepEqual(tb.waitingForTouches, ['task-da'], 'waitingForTouches 标注持有者任务 id')
    assert.equal(env.continuables.length, 1, 'B 未派发（同轮 holds 动态增长拦下）')
    assert.deepEqual(transitions(tb), ['created→pending'], 'B 只有创建历史')
    // A 落定（事件通道，work 档直落 resolved）→ touches 锁随状态流转释放
    var childA = env.continuables[0].childId
    await settleViaEvents(env, childA, 'A')
    var ta = await env.waitFor(function () { var x = env.task('task-da'); return x && x.status === 'resolved' && x.runs && x.runs[0] && x.runs[0].outcome === 'completed' ? x : null }, 'A 事件结算落 resolved 且 run 关账')
    assert.deepEqual(transitions(ta), ['created→pending', 'pending→in-progress', 'in-progress→resolved'], 'A 全流转')
    // 落定放行：下一轮 cycle B 自动派发，waitingForTouches 展示态清除
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 2 }, 'B 放行 spawn')
    assert.equal(env.continuables[1].label, 'worker:task-db', 'A 落定后 B 自动放行')
    tb = await env.waitFor(function () { var x = env.task('task-db'); return x && x.status === 'in-progress' && x.claimedBy === env.continuables[1].childId ? x : null }, 'B 落卡 in-progress')
    assert.ok(!tb.waitingForTouches, '放行后 waitingForTouches 展示态清除（不留 🔒 假象）')
    // B 完成：同样走事件通道
    await settleViaEvents(env, env.continuables[1].childId, 'B')
    tb = await env.waitFor(function () { var x = env.task('task-db'); return x && x.status === 'resolved' && x.runs && x.runs[0] && x.runs[0].outcome === 'completed' ? x : null }, 'B 事件结算落 resolved 且 run 关账')
    assert.deepEqual(transitions(tb), ['created→pending', 'pending→in-progress', 'in-progress→resolved'], 'B 全流转')
    assert.equal(tb.runs[0].outcome, 'completed')
    assert.equal(env.runs.length, 0, 'work 档无 verifier')
  } finally { restoreHome(); await env.cleanup() }
})

// ===== 场景 e：仲裁 hold 冻结 → 虚拟时钟推进 40s 不派发 → unfreeze → 派发（时钟推进主线）=====
// 本卡核心用例：hold 裁决后冻结卡必须在「去抖轮 + 两轮 15s 心跳」的 poolCycle 里全程被
// pickDispatch 跳过（!t.frozen 闸）；unfreeze 后 mutateLocked 默认 kickCycle（50ms 去抖）立即补派。
// 附带两个时钟真推进的硬证据：① 首轮 Worker 的失联 rec 被 poolCycle 幽灵回收关账 incomplete
// （卡面 pending ≠ in-progress → recIsLive=false）；② 25s 歧义去抖到点但 escalation 已被裁决
// 清除 → 投递前重查跳过（过期回声不投）。解冻后派发走续跑冷复活（首轮 continuable + incomplete
// 有续跑资格）→ sendMessage 唤醒原子会话，裁决答案随 messages 原文注入续跑指令。
test('集成e·仲裁冻结：hold 冻结→推进 40s 全程不派发→unfreeze→解冻即派（冷复活续跑）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-e1', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn 发生')
    var child = env.continuables[0]
    await env.waitFor(function () { var x = env.task('task-e1'); return x && x.status === 'in-progress' && x.claimedBy === child.childId ? x : null }, '落卡 in-progress')
    // Worker 上报歧义 → escalation 落卡（25s 歧义去抖通知同步挂起，去抖本体断言在场景 g）
    var esc = await env.tools.get('board_report').execute({ taskId: 'task-e1', kind: 'escalate', question: '方案 A 与方案 B 如何取舍？' })
    assert.equal(esc.ok, true)
    assert.equal(esc.escalated, true)
    // 主窗口裁决 action=hold：in-progress 回 pending + frozen 三字段落卡 + 裁决消息入 messages
    //（hold 走 skipKick——冻结任务本就不该派发，省一次无意义 poolCycle）
    var arb = await env.tools.get('task_arbitrate').execute({ taskId: 'task-e1', answer: '按方案 A 做', action: 'hold' })
    assert.equal(arb.ok, true)
    assert.equal(arb.action, 'hold')
    assert.equal(arb.frozen, true)
    var t = env.task('task-e1')
    assert.equal(t.status, 'pending', 'hold 裁决把 in-progress 打回 pending')
    assert.equal(t.frozen, true, 'frozen 落卡')
    assert.ok(t.frozenAt && t.frozenBy, 'frozenAt/frozenBy 留痕')
    assert.equal(t.claimedBy, null, '认领位清空待补上下文')
    assert.ok(!t.escalation, '裁决后 escalation 已清')
    var arbMsg = (t.messages || []).filter(function (m) { return m.kind === 'arbitration' })
    assert.equal(arbMsg.length, 1, '裁决答案落一条 kind=arbitration 消息')
    assert.equal(arbMsg[0].text, '按方案 A 做')
    assert.equal(arbMsg[0].action, 'hold')
    // ===== 虚拟时钟推进 40s（跨去抖轮 + 15s/30s 两轮心跳 + 25s 歧义去抖点）：冻结卡全程不派发 =====
    await env.clock.advance(40000)
    // 硬证据①：时钟推进下 poolCycle 真实跑过——首轮 run 已被幽灵回收关账 incomplete
    t = await env.waitFor(function () { var x = env.task('task-e1'); return x && x.runs && x.runs[0] && x.runs[0].outcome === 'incomplete' ? x : null }, 'poolCycle 幽灵回收关账首轮 run（时钟真推进的证明）')
    assert.equal(t.status, 'pending', '40s 推进后冻结卡仍 pending')
    assert.equal(t.frozen, true, '冻结贯穿多轮 poolCycle')
    assert.equal(env.continuables.length, 1, '冻结窗口内零新 spawn（pickDispatch 跳过 frozen）')
    assert.equal(env.sendMessages.length, 0, '冻结窗口内零续跑投递')
    // 硬证据②：25s 歧义去抖到点，但 escalation 已被裁决清掉 → deliverEscalation 投递前重查跳过
    assert.equal(env.sent.length, 0, '歧义通知过期不投（投递前重查看板）')
    // ===== unfreeze 解冻 → 默认 kickCycle（50ms 去抖）→ 立即补派 =====
    var unf = await env.tools.get('task_update').execute({ taskId: 'task-e1', unfreeze: true })
    assert.equal(unf.ok, true)
    assert.ok(!env.task('task-e1').frozen, '解冻后 frozen 清除')
    await env.clock.advance(50)
    // 首轮 run 结局 incomplete + continuable → 有续跑资格 → sendMessage 冷复活原子会话（不新建）
    await env.waitFor(function () { return env.sendMessages.length >= 1 }, '解冻后派发发生（续跑冷复活）')
    assert.equal(env.continuables.length, 1, '续跑不新建子会话')
    assert.equal(env.sendMessages[0].childId, child.childId, '冷复活目标是首轮 Worker 子会话')
    var resumeText = env.sendMessages[0].content[0].text
    assert.ok(resumeText.indexOf('断点续跑') >= 0, '续跑指令落薄框架文案')
    assert.ok(resumeText.indexOf('按方案 A 做') >= 0, '裁决答案随 messages 原文注入续跑指令')
    t = await env.waitFor(function () { var x = env.task('task-e1'); return x && x.status === 'in-progress' && x.claimedBy === child.childId ? x : null }, '解冻后落卡 in-progress（认领位=原子会话）')
    assert.equal(t.runs.length, 2, '首派 + 续跑各留一条 run')
    assert.equal(t.runs[1].resume, true, '第二条是续跑记录')
    assert.equal(t.runs[1].outcome, 'running')
    assert.deepEqual(transitions(t), ['created→pending', 'pending→in-progress', 'in-progress→in-progress', 'in-progress→in-progress', 'in-progress→pending', 'pending→pending', 'pending→pending', 'pending→in-progress'], '冻结/解冻全流转序列（上报歧义+裁决+回pending+冻结+解冻+重派）')
  } finally { await env.cleanup() }
})

// ===== 场景 f：回执 45s 聚合 + 投递前过滤（移植 _scratch/verify-flush-filter.mjs 的已验证场景）=====
// 两张 work 档卡同窗口完成：f1 在投递前被人归档（已知悉）→ 回执吞掉；f2 resolved 保留。
// 窗口未到点零投递（聚合闸）；到点 flush 投递前重读看板：f1 的「已派发+完成」两条都被过滤
// （archived 丢弃 / 非 in-progress 离场），f2 的派发回执同样离场过滤——四条入队只投一条摘要。
test('集成f·回执聚合过滤：45s 窗口聚合为一条，已归档任务回执被吞，存活任务保留', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-f1', { pipeline: 'work' })
    await createTask(env, 'task-f2', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 2 }, '两卡同轮派发')
    // 派发即回执 ×2 已入 45s 聚合队列——窗口未到点，主窗口零打扰
    assert.equal(env.sent.length, 0, '聚合窗口未到点不投递')
    // 两张卡先后 board_report 完成（work 档直落 resolved，完成回执入同一聚合队列）
    var rep1 = await env.tools.get('board_report').execute({ taskId: 'task-f1', kind: 'complete', summary: 'f1 交付', changes: '改了 f1', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep1.ok, true)
    assert.equal(rep1.task.status, 'resolved')
    var rep2 = await env.tools.get('board_report').execute({ taskId: 'task-f2', kind: 'complete', summary: 'f2 交付', changes: '改了 f2', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep2.ok, true)
    assert.equal(env.sent.length, 0, '窗口到点前完成回执同样压着不投')
    // 投递前人去归档了 f1（已知悉）→ 它的回执该被吞
    var arc = await env.rpc('archive-task', { sessionId: env.sid, taskId: 'task-f1' })
    assert.equal(arc.ok, true, 'resolved 可归档')
    assert.equal(env.task('task-f1').status, 'archived')
    // ===== 45s 聚合窗口到点 → flushReceipts 投递前重读看板过滤 =====
    await env.clock.advance(45000)
    await env.waitFor(function () { return env.sent.length >= 1 }, '聚合窗口到点投递')
    assert.equal(env.sent.length, 1, '四条回执（派发×2+完成×2）聚合为一条摘要')
    var text = env.sent[0].content[0].text
    assert.equal(env.sent[0].source.form, 'recall', '回执是 recall 形态（背景回执，非指令）')
    assert.ok(text.indexOf('回执摘要（1 条）') >= 0, '计数用过滤后存活条数')
    assert.ok(text.indexOf('(task-f2)') >= 0, 'f2 完成回执保留')
    assert.ok(text.indexOf('(task-f1)') < 0, '已归档的 f1 回执被吞')
    assert.ok(text.indexOf('已派发') < 0, 'f1 归档 / f2 resolved 都非 in-progress → 派发回执全部离场过滤')
    assert.ok(text.indexOf('f2 交付') >= 0, '保留项带 summary')
    assert.equal(env.task('task-f2').status, 'resolved')
  } finally { await env.cleanup() }
})

// ===== 场景 g：歧义通知 25s 去抖——连报两次只投最新一条 =====
// 同一任务 25s 窗口内两次上报歧义：第一次调度被第二次顶替（escNotifyTimers 身份不匹配静默丢弃），
// 到点只投一条且内容是最新疑问（deliverEscalation 投递时才读 escalation.question）。
test('集成g·歧义去抖：25s 窗口内连报两次，只投最新一条', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-g1', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn 发生')
    await env.waitFor(function () { var x = env.task('task-g1'); return x && x.status === 'in-progress' ? x : null }, '落卡 in-progress')
    // 第一次上报（去抖调度 T1 挂起）
    var esc1 = await env.tools.get('board_report').execute({ taskId: 'task-g1', kind: 'escalate', question: '第一问：旧疑问（应被顶替）' })
    assert.equal(esc1.ok, true)
    // 同一虚拟时刻第二次上报（T1 被 T2 顶替；escalation.question 覆盖为最新）
    var esc2 = await env.tools.get('board_report').execute({ taskId: 'task-g1', kind: 'escalate', question: '第二问：最新疑问（应投递）' })
    assert.equal(esc2.ok, true)
    assert.equal(env.sent.length, 0, '去抖窗口未到点零投递')
    // 推进 25s：T1 到点身份不匹配丢弃；T2 到点投递最新疑问
    await env.clock.advance(25000)
    await env.waitFor(function () { return env.sent.length >= 1 }, '去抖到点投递')
    assert.equal(env.sent.length, 1, '连报两次只投一条（旧调度被顶替丢弃）')
    var msg = env.sent[0]
    var text = msg.content[0].text
    assert.ok(text.indexOf('Worker 上报歧义') >= 0, '歧义裁决通知投递')
    assert.ok(text.indexOf('第二问：最新疑问') >= 0, '投递的是最新疑问')
    assert.ok(text.indexOf('第一问') < 0, '旧疑问不出现')
    assert.equal(msg.source.form, 'notice', '歧义通知是 notice 形态（带一行 summary）')
    // 通知路径不碰卡面状态：仍 in-progress + escalation 待裁决
    var t = env.task('task-g1')
    assert.equal(t.status, 'in-progress')
    assert.ok(t.escalation, 'escalation 仍在等裁决')
    assert.equal(t.escalation.question, '第二问：最新疑问（应投递）', '卡面留的是最新疑问')
  } finally { await env.cleanup() }
})

// ===== 场景 h：progress 上报落 lastProgress（覆盖式，静默不通知）=====
// 里程碑通道定位：长任务「还在正确路上」的轻量证明——覆盖式落 lastProgress、messages 留审计轨，
// 不写 ah 历史（防刷屏）、不进回执聚合、不通知主窗口、不触发 run 关账。
test('集成h·progress 上报：lastProgress 覆盖式落卡，不进历史/不通知/不结算', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-h1', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn 发生')
    var t = await env.waitFor(function () { var x = env.task('task-h1'); return x && x.status === 'in-progress' ? x : null }, '落卡 in-progress')
    // 第一条里程碑进展
    var p1 = await env.tools.get('board_report').execute({ taskId: 'task-h1', kind: 'progress', question: '里程碑一：骨架已落地' })
    assert.equal(p1.ok, true)
    assert.equal(p1.progress.text, '里程碑一：骨架已落地')
    assert.ok(p1.progress.at)
    // 第二条覆盖第一条
    var p2 = await env.tools.get('board_report').execute({ taskId: 'task-h1', kind: 'progress', question: '里程碑二：断言全绿' })
    assert.equal(p2.ok, true)
    t = env.task('task-h1')
    assert.equal(t.lastProgress.text, '里程碑二：断言全绿', 'lastProgress 覆盖式只留最新')
    assert.ok(t.lastProgress.at)
    var pmsgs = (t.messages || []).filter(function (m) { return m.kind === 'progress' })
    assert.equal(pmsgs.length, 2, '两条进展都落 messages 审计轨')
    assert.equal(pmsgs[1].text, '里程碑二：断言全绿')
    assert.equal(t.status, 'in-progress', 'progress 不推进状态')
    assert.deepEqual(transitions(t), ['created→pending', 'pending→in-progress'], 'progress 不写 ah 历史（防刷屏）')
    assert.equal(t.runs[0].outcome, 'running', 'progress 不触发 run 关账')
    assert.equal(env.sent.length, 0, 'progress 静默——不通知主窗口、不进回执聚合')
    // 空白摘要拒绝
    var p3 = await env.tools.get('board_report').execute({ taskId: 'task-h1', kind: 'progress', question: '   ' })
    assert.equal(p3.ok, false, '空白进展摘要被拒')
    // 去抖轮过后状态依旧（progress 写盘带的 kickCycle 不扰池）
    await env.clock.advance(50)
    t = env.task('task-h1')
    assert.equal(t.status, 'in-progress')
    assert.equal(t.lastProgress.text, '里程碑二：断言全绿')
    assert.equal(env.continuables.length, 1, 'progress 全程不惹派发')
  } finally { await env.cleanup() }
})

// ===== 场景 i：孤儿回收——isOrphan 路径经 poolCycle（推进时钟等孤儿扫描窗口）=====
// patchBoard 构造「in-progress + claimedBy=已死子会话 + 无活跃 rec + claimedAt 超 2min」的孤儿卡。
// 两个构造细节：① isOrphan 的 2min 门槛锚真实墙钟（poolCycle 里 now=Date.now()），claimedAt 按真实
// 时间倒推 3 分钟；② runs 留空——让首轮 reconcile 不掺和（它只认「末条 worker run continuable 且
// outcome=running」的卡），回收必须走 isOrphan 路径。assignMode=manual 钉住同轮重派：pickDispatch
// 跳过本卡，断言稳定在「回 pending」本身。
test('集成i·孤儿回收：in-progress 无活跃 rec 的卡推进时钟后回 pending', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-i1', { pipeline: 'work' })
    // 构造孤儿卡：执行 run 已死（无活跃 rec、无 runs 留档）、认领于 3 分钟前（真实墙钟倒推）
    env.patchBoard(function (d) {
      var t = d.tasks.find(function (x) { return x.id === 'task-i1' })
      t.status = 'in-progress'
      t.claimedBy = 'child-ghost-9'
      t.claimedAt = new Date(Date.now() - 180000).toISOString()
      t.assignMode = 'manual' // 防回收后同轮自动重派——本场景断言的是「回收回 pending」本身
    })
    var t = env.task('task-i1')
    assert.equal(t.status, 'in-progress', '构造生效：孤儿卡停在 in-progress')
    // 推进时钟过孤儿扫描窗口：建卡 kickCycle 的 50ms 去抖轮即扫到；再跨一轮 15s 心跳兜底
    await env.clock.advance(15000)
    t = await env.waitFor(function () { var x = env.task('task-i1'); return x && x.status === 'pending' ? x : null }, '孤儿回收回 pending')
    assert.equal(t.claimedBy, null, '认领位清空')
    assert.equal(t.claimedAt, null, 'claimedAt 清空')
    var trs = transitions(t)
    assert.equal(trs[trs.length - 1], 'in-progress→pending', '回收流转方向')
    var lastHist = t.history[t.history.length - 1]
    assert.equal(lastHist.actor, 'system')
    assert.equal(lastHist.note, '执行 run 已结束/丢失，回收重新排队', 'isOrphan 回收的历史注记（区别于 reconcile 的「重启后执行会话已丢失」）')
    // 回收轮 dispatchInfo 留痕 + manual 钉住无重派
    assert.ok((env.board().dispatchInfo || '').indexOf('reclaim task-i1') >= 0, 'dispatchInfo 留 reclaim 痕迹')
    assert.equal(env.continuables.length, 0, 'manual 钉住：回收后同轮不重派')
    assert.equal(env.sendMessages.length, 0)
    assert.equal(env.sent.length, 0, '孤儿回收的系统通知攒在 sysNotesBuf 等回执冲刷，不单独投递')
  } finally { await env.cleanup() }
})

// ===== 场景 j：归档数据源全量——老归档（>7 天）与仪表盘同口径，get-tasks 全量返回 =====
// 归档 tab 空 vs 仪表盘 68 的根因锁定（反馈 n-muyg3e0m9z7i）：归档 tab 数据源必须与仪表盘「已归档」
// 计数同源（state.tasks 全量，无 7 日窗口、无字段缺失）。host 侧 get-tasks 本就返回全量含归档，
// 本用例锁死这条数据源契约：建卡→resolve→archive（含 archivedAt>7 天前构造）→断言归档数据源含该卡。
test('集成j·归档数据源全量：老归档(>7天)与仪表盘同口径，get-tasks 返回全部归档', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    // 新归档 + 老归档各一张：先建卡再 resolve 再 archive（省去派发链路，直接走到可归档态）
    await createTask(env, 'task-j1', { pipeline: 'work' })
    await createTask(env, 'task-j2', { pipeline: 'work' })
    env.patchBoard(function (d) {
      d.tasks.forEach(function (t) { if (t.id === 'task-j1' || t.id === 'task-j2') { t.status = 'resolved'; t.resolvedAt = new Date(Date.now() - 86400000).toISOString() } })
    })
    var a1 = await env.rpc('archive-task', { sessionId: env.sid, taskId: 'task-j1' })
    var a2 = await env.rpc('archive-task', { sessionId: env.sid, taskId: 'task-j2' })
    assert.equal(a1.ok, true, 'task-j1 可归档')
    assert.equal(a2.ok, true, 'task-j2 可归档')
    // 构造老归档：task-j1 归档于 20 天前（>7 天），task-j2 归档于现在
    env.patchBoard(function (d) {
      var j1 = d.tasks.find(function (x) { return x.id === 'task-j1' })
      j1.archivedAt = new Date(Date.now() - 20 * 86400000).toISOString()
    })
    // 归档数据源（get-tasks 全量）：两张归档都在，老归档（>7 天）不被窗口滤掉
    var d = await env.rpc('get-tasks', { sessionId: env.sid, includeArchived: true })
    var arch = d.tasks.filter(function (t) { return t.status === 'archived' })
    assert.equal(arch.length, 2, '归档数据源含全部归档（全量，无 7 日窗口）')
    assert.ok(arch.some(function (t) { return t.id === 'task-j1' && new Date(Date.now()) - new Date(t.archivedAt) > 7 * 86400000 }), '老归档（>7 天）仍在归档数据源')
    assert.ok(arch.some(function (t) { return t.id === 'task-j2' }), '新归档也在归档数据源')
    // 归档字段完整：archivedAt 已落卡（客户端按归档时间倒序的数据源字段不缺）
    assert.ok(arch.every(function (t) { return !!t.archivedAt }), '每张归档卡都带 archivedAt')
    // 与仪表盘口径一致：仪表盘「已归档」= state.tasks 里 status==='archived' 的计数，二者同源同值
    var d2 = await env.rpc('get-tasks', { sessionId: env.sid })
    assert.equal(d2.tasks.filter(function (t) { return t.status === 'archived' }).length, 2, '无 includeArchived 时同样全量（与仪表盘计数同源）')
  } finally { await env.cleanup() }
})

// ===== 场景 k：terminate × 续跑在途竞态根修①（task-mv6c7cdm，实证 n-mv65bhk0mg5w）=====
// 竞态时序复刻：首轮 Worker 失败回 pending（留档 incomplete+continuable 有续跑资格）→ 重派轮
// sendMessage 冷复活挂起（在途窗口）→ terminate 恰好落进窗口（活跃表无 rec，interrupt 打不到、
// 关账轮不到，只把卡翻回 pending）→ 放行 sendMessage。修复前：续跑照旧落闸（注册 rec+落留档），
// 下一轮 cycle 又把 pending 卡 fresh spawn → 同卡双 run。修复后：落闸前锁内重验发现卡面已翻走 →
// 弃权三件套（interrupt 刚复活的子会话 + 旧留档立 noResume + 不注册/不落档），下一轮 fresh spawn
// 新 Worker——同卡同秒最多一个 spawn 落闸。
test('集成k·terminate竞态①：续跑 spawn 在途被 terminate → 落闸锁内重验弃权（interrupt+noResume），同卡不再双 run', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-k1', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, '首轮 worker spawn 发生')
    var child1 = env.continuables[0].childId
    await env.waitFor(function () { var x = env.task('task-k1'); return x && x.status === 'in-progress' && x.claimedBy === child1 ? x : null }, '落卡 in-progress')
    // 首轮失败（不写子会话日志 → 空文本按失败重排）→ pending + 留档 incomplete（有续跑资格）
    env.emitStatus(child1, 'running')
    env.emitStatus(child1, 'idle')
    await env.waitFor(function () { var x = env.task('task-k1'); return x && x.status === 'pending' && x.runs && x.runs[0] && x.runs[0].outcome === 'incomplete' ? x : null }, '失败回 pending 且留档 incomplete')
    // ===== 构造竞态时序：续跑 sendMessage 挂起，在途窗口由测试掌控 =====
    var origSend = env.ctx.subagents.sendMessage
    var releaseResume = null
    env.ctx.subagents.sendMessage = function (parent, childId, content) {
      env.sendMessages.push({ parent: parent, childId: childId, content: content })
      return new Promise(function (res) { releaseResume = function () { res({ ok: true }) } })
    }
    // 触发重派轮：占位 claim → tryResumeWorker → sendMessage 在途挂起
    await env.clock.advance(50)
    await env.waitFor(function () { return env.sendMessages.length >= 1 }, '续跑 sendMessage 已发出（在途挂起）')
    var t = env.task('task-k1')
    assert.equal(t.status, 'in-progress')
    assert.equal(t.claimedBy, 'spawn-pending', '续跑在途时占位仍在')
    // ===== terminate 落进在途窗口（竞态前提：活跃表无 rec，拦不住在途 spawn）=====
    var term = await env.rpc('terminate-agent', { sessionId: env.sid, taskId: 'task-k1' })
    assert.equal(term.ok, true)
    assert.equal(term.terminated, 'no-active-run', '竞态前提成立：terminate 看不到在途续跑（无 rec 可 interrupt）')
    t = env.task('task-k1')
    assert.equal(t.status, 'pending', 'terminate 把卡翻回 pending')
    assert.equal(t.claimedBy, null, 'terminate 清掉占位')
    // ===== 放行 sendMessage → 落闸锁内重验：卡面已翻走 → 弃权 =====
    releaseResume()
    await env.waitFor(function () { return env.interrupts.some(function (x) { return x.childId === child1 }) }, '弃权即 interrupt 刚复活的子会话（防空跑烧上下文）')
    t = await env.waitFor(function () { var x = env.task('task-k1'); return x && x.runs && x.runs[0] && x.runs[0].noResume === true ? x : null }, '旧留档立 noResume（与 terminate 命中同语义：不再续跑）')
    // 弃权零落闸：不注册 rec、不落续跑留档、不新建子会话
    assert.equal(env.continuables.length, 1, '弃权不新建子会话')
    assert.equal(t.runs.length, 1, '弃权不落续跑留档（仍只有首轮一条）')
    assert.equal(t.status, 'pending')
    assert.equal(t.claimedBy, null)
    // ===== 下一轮 cycle：noResume 关掉续跑资格 → fresh spawn 新 Worker（单 run 落闸）=====
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 2 }, '重派 fresh spawn 发生')
    var child2 = env.continuables[1].childId
    assert.notEqual(child2, child1, '新 Worker 是新会话（旧子按 terminate 语义废弃）')
    assert.equal(env.sendMessages.length, 1, '续跑只有被弃权的那一次（noResume 挡住二次复活）')
    t = await env.waitFor(function () { var x = env.task('task-k1'); return x && x.status === 'in-progress' && x.claimedBy === child2 ? x : null }, '新 Worker 落卡 in-progress')
    assert.equal(t.runs.length, 2, '首轮 + 新 Worker 各一条留档（双 run 不再现：任一时刻最多一条在跑）')
    assert.ok(!t.runs[1].resume, '第二条是新 spawn 留档（非续跑记录）')
    // 新 Worker 正常完成 → 全链单 run 收口
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-k1', kind: 'complete', summary: '重跑交付', changes: '改了 k', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep.ok, true)
    t = await env.waitFor(function () { var x = env.task('task-k1'); return x && x.status === 'resolved' && x.runs[1].outcome === 'completed' ? x : null }, 'work 档直落 resolved 且 run 关账')
  } finally { await env.cleanup() }
})

// ===== 场景 l：terminate 竞态根修②（正常 resume 不回归）=====
// 同样的「失败回 pending → 重派续跑」主线，但无 terminate 落窗：闸门必须以锁内新鲜快照放行——
// sendMessage 冷复活照常落闸（rec 注册 + 续跑留档 resume:true），续跑轮可正常交付收口。
test('集成l·terminate竞态②：正常续跑不回归——无 terminate 时闸门放行，冷复活照常落闸并交付', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-l1', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, '首轮 worker spawn 发生')
    var child1 = env.continuables[0].childId
    await env.waitFor(function () { var x = env.task('task-l1'); return x && x.status === 'in-progress' && x.claimedBy === child1 ? x : null }, '落卡 in-progress')
    // 首轮失败 → pending + incomplete（有续跑资格）。
    // 注意：失败结算本身就会 interrupt 一次（卡2 设计：打断当前 turn、留存会话供续跑）——
    // 闸门不误伤的判据是「续跑全程不再新增 interrupt」，先记下基数。
    env.emitStatus(child1, 'running')
    env.emitStatus(child1, 'idle')
    await env.waitFor(function () { var x = env.task('task-l1'); return x && x.status === 'pending' && x.runs && x.runs[0] && x.runs[0].outcome === 'incomplete' ? x : null }, '失败回 pending')
    var interruptBase = env.interrupts.length
    assert.equal(interruptBase, 1, '失败结算的 interrupt 留存（卡2 既有语义）')
    // 正常重派：无 terminate → 续跑闸门放行（锁内快照：in-progress + 占位 + resumeTarget 指向原子会话）
    await env.clock.advance(50)
    await env.waitFor(function () { return env.sendMessages.length >= 1 }, '续跑 sendMessage 发出')
    assert.equal(env.sendMessages[0].childId, child1, '冷复活目标是首轮 Worker 子会话')
    assert.equal(env.continuables.length, 1, '续跑不新建子会话')
    var t = await env.waitFor(function () { var x = env.task('task-l1'); return x && x.status === 'in-progress' && x.claimedBy === child1 && x.runs && x.runs.length === 2 ? x : null }, '续跑落闸：认领位回原子会话 + 续跑留档')
    assert.equal(t.runs[1].resume, true, '第二条是续跑记录')
    assert.equal(t.runs[1].outcome, 'running')
    assert.ok(!t.runs[0].noResume, '正常路径不留 noResume 旗（续跑资格不受损）')
    // 续跑轮正常交付（上报通道）→ resolved + run 关账
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-l1', kind: 'complete', summary: '续跑交付', changes: '改了 l', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep.ok, true)
    t = await env.waitFor(function () { var x = env.task('task-l1'); return x && x.status === 'resolved' && x.runs[1].outcome === 'completed' ? x : null }, '续跑轮交付落 resolved 且关账')
    // task-mvbeallq 豁免收紧：completed 落定无续跑位（resumeTarget 只认超时/失败结局）→ settleRunRecord
    // 尾序补停一枪（残影治理①）；除此之外续跑全程（闸门/落闸/结算）零新增 interrupt——不误伤仍成立。
    await env.waitFor(function () { return env.interrupts.length >= interruptBase + 1 }, 'completed 落定补停在位')
    assert.equal(env.interrupts.length, interruptBase + 1, '续跑全程仅补停一枪（completed 无续跑位），闸门不误伤')
    assert.equal(env.interrupts[env.interrupts.length - 1].childId, child1, '补停目标=续跑轮子会话（打断 turn 不销毁会话）')
    assert.equal(env.interrupts[env.interrupts.length - 1].authority.kind, 'ancestor', 'authority 形状同款')
  } finally { await env.cleanup() }
})

// ===== 场景 m：terminate 竞态根修③（fresh spawn 臂）=====
// 首派 spawn 在途（startContinuable 挂起）被 terminate：修复前 spawn 返回后照旧落闸（rec+留档），
// 与 terminate 后的重派轮形成双 run；修复后落闸弃权——新建子会话立刻 interrupt、不落档不注册，
// 下一轮 cycle 重新 fresh spawn，全程单 run。
test('集成m·terminate竞态③：fresh spawn 在途被 terminate → 落闸弃权（interrupt 新建子会话），下一轮单 run 收口', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    // 首单 startContinuable 挂起：spawn 在途窗口由测试掌控；放行后后续 spawn 直通
    var origStartC = env.ctx.subagents.startContinuable
    var spawnHold = null
    var releaseSpawn = null
    env.ctx.subagents.startContinuable = function (o) {
      if (!spawnHold) return origStartC(o)
      return spawnHold.then(function () { return origStartC(o) })
    }
    spawnHold = new Promise(function (res) { releaseSpawn = res })
    await createTask(env, 'task-m1', { pipeline: 'work' })
    await env.clock.advance(50)
    // 占位已 claim、spawn 在途挂起（startContinuable 未返回）
    await env.waitFor(function () { var x = env.task('task-m1'); return x && x.status === 'in-progress' && x.claimedBy === 'spawn-pending' ? x : null }, '占位 claim 落卡，spawn 在途')
    // terminate 落进在途窗口（竞态前提：活跃表无 rec）
    var term = await env.rpc('terminate-agent', { sessionId: env.sid, taskId: 'task-m1' })
    assert.equal(term.ok, true)
    assert.equal(term.terminated, 'no-active-run', '竞态前提成立：terminate 看不到在途 spawn')
    var t = env.task('task-m1')
    assert.equal(t.status, 'pending', 'terminate 把卡翻回 pending')
    assert.equal(t.claimedBy, null)
    // 放行 spawn → 落闸重验：卡面已翻走 → 弃权（新建子会话立刻 interrupt，不注册不落档）
    spawnHold = null
    releaseSpawn()
    await env.waitFor(function () { return env.continuables.length >= 1 && env.interrupts.some(function (x) { return x.childId === env.continuables[0].childId }) }, '弃权即 interrupt 刚建子会话')
    t = env.task('task-m1')
    assert.equal(t.status, 'pending')
    assert.equal(t.claimedBy, null)
    assert.ok(!t.runs || t.runs.length === 0, '弃权不落 run 留档（本次派发在卡面从未存在过）')
    // 下一轮 cycle：正常 fresh spawn（闸门放行）→ 单 run 落卡
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 2 }, '重派 fresh spawn 发生')
    var child2 = env.continuables[1].childId
    assert.notEqual(child2, env.continuables[0].childId)
    t = await env.waitFor(function () { var x = env.task('task-m1'); return x && x.status === 'in-progress' && x.claimedBy === child2 ? x : null }, '新 Worker 落卡 in-progress')
    assert.equal(t.runs.length, 1, '只有一条真实落闸的留档（被弃权的首派零痕迹）')
    // 正常完成 → resolved（单 run 收口）
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-m1', kind: 'complete', summary: '重跑交付', changes: '改了 m', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep.ok, true)
    t = await env.waitFor(function () { var x = env.task('task-m1'); return x && x.status === 'resolved' && x.runs[0].outcome === 'completed' ? x : null }, 'resolved 收口且 run 关账')
  } finally { await env.cleanup() }
})

// ===== 场景 n：dependsOn 后补撞在途 spawn 根修①（task-mv9yupm4，ontology 实证 n-mv8zdii54ajf）=====
// 竞态时序复刻：B 空依赖 publish → 立即被 claim 占位、spawn 在途挂起 → update-task 后补
// dependsOn=[F1]（写入成功+warning 软提示，但 F1 未 resolved）→ 放行 spawn。修复前：落闸不验依赖，
// 卡照跑（depsSatisfied 只闸 pickDispatch 挑候选一刻，闸不到在途窗口）。修复后：落闸锁内重验
// depsSatisfied=false → 弃权（interrupt 新建子会话 + 不落档不注册）+ 占位回退 pending；F1 落定后
// 下一轮 cycle 正常派发 B，全程单 run 收口。
test('集成n·dependsOn后补①：publish 后补依赖撞在途 spawn → 落闸否决回 pending，依赖落定后正常派发', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    // spawn 挂起只针对 B（按 label 过滤）：依赖 F1 的派发不受影响
    var origStartC = env.ctx.subagents.startContinuable
    var spawnHold = null
    var releaseSpawn = null
    env.ctx.subagents.startContinuable = function (o) {
      if (o && o.label === 'worker:task-nb' && spawnHold) return spawnHold.then(function () { return origStartC(o) })
      return origStartC(o)
    }
    // 依赖 F1 先建先派（在跑未 resolved → 后补的依赖处于未满足态）
    await createTask(env, 'task-na', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'F1 spawn 发生')
    var childF1 = env.continuables[0].childId
    await env.waitFor(function () { var x = env.task('task-na'); return x && x.status === 'in-progress' && x.claimedBy === childF1 ? x : null }, 'F1 落卡 in-progress')
    // B 空依赖 publish → 立即被 claim，spawn 在途挂起（在途窗口由测试掌控）
    spawnHold = new Promise(function (res) { releaseSpawn = res })
    await createTask(env, 'task-nb', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { var x = env.task('task-nb'); return x && x.status === 'in-progress' && x.claimedBy === 'spawn-pending' ? x : null }, 'B 占位 claim 落卡，spawn 在途')
    // ===== 在途窗口内后补依赖（撞窗）：写入成功（不拒写）+ warning 软提示（在飞卡）=====
    var upd = await env.rpc('update-task', { sessionId: env.sid, taskId: 'task-nb', dependsOn: ['task-na'] })
    assert.equal(upd.ok, true, '后补依赖写入成功（软提示不拒写）')
    assert.equal(upd.warning, '卡已在执行中，依赖变更不影响本次 run', '在飞卡写依赖带 warning 字段')
    assert.deepEqual(env.task('task-nb').dependsOn, ['task-na'], '依赖已落卡')
    // ===== 放行 spawn → 落闸锁内重验 depsSatisfied=false → 否决 =====
    spawnHold = null
    releaseSpawn()
    await env.waitFor(function () { return env.continuables.length >= 2 }, 'B 的被否 spawn 实际建过子会话')
    var childB1 = env.continuables[1].childId
    await env.waitFor(function () { return env.interrupts.some(function (x) { return x.childId === childB1 }) }, '被否 spawn 的新建子会话立刻 interrupt（防空跑烧上下文）')
    var tb = await env.waitFor(function () { var x = env.task('task-nb'); return x && x.status === 'pending' && !x.claimedBy ? x : null }, '依赖否决：占位条件化回退 pending')
    assert.ok(!tb.runs || tb.runs.length === 0, '被否派发不落 run 留档（在卡面从未存在过）')
    assert.deepEqual(transitions(tb), ['created→pending', 'pending→in-progress', 'in-progress→pending'], '占位 claim + 否决回退两段历史')
    // 依赖未落定期间不再重派 B（pickDispatch 的 depsSatisfied 门控接管）
    await env.clock.advance(50)
    assert.equal(env.continuables.length, 2, '依赖未满足：B 不再重派')
    assert.equal(env.sendMessages.length, 0, 'B 无留档可续（续跑通道不触发）')
    // ===== 依赖落定 → 下一轮正常派发 B（断言②）=====
    var repF1 = await env.tools.get('board_report').execute({ taskId: 'task-na', kind: 'complete', summary: 'F1 交付', changes: '改了 na', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(repF1.ok, true)
    await env.waitFor(function () { var x = env.task('task-na'); return x && x.status === 'resolved' ? x : null }, 'F1 resolved（work 档直落）')
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 3 }, '依赖落定后 B 正常派发')
    var childB2 = env.continuables[2].childId
    assert.notEqual(childB2, childB1, '重派是新子会话（被弃的已 interrupt 废弃，不留续跑资格）')
    tb = await env.waitFor(function () { var x = env.task('task-nb'); return x && x.status === 'in-progress' && x.claimedBy === childB2 ? x : null }, 'B 重新落卡 in-progress')
    assert.equal(tb.runs.length, 1, 'B 只有一条真实落闸留档（被否决的派发零痕迹）')
    assert.ok(!tb.runs[0].resume, 'fresh spawn 留档（无续跑资格可续）')
    // B 正常完成 → 全链单 run 收口
    var repB = await env.tools.get('board_report').execute({ taskId: 'task-nb', kind: 'complete', summary: 'B 交付', changes: '改了 nb', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(repB.ok, true)
    tb = await env.waitFor(function () { var x = env.task('task-nb'); return x && x.status === 'resolved' && x.runs[0].outcome === 'completed' ? x : null }, 'B resolved 收口且 run 关账')
    assert.deepEqual(transitions(tb), ['created→pending', 'pending→in-progress', 'in-progress→pending', 'pending→in-progress', 'in-progress→resolved'], '否决回退后重派全流转序列')
  } finally { await env.cleanup() }
})

// ===== 场景 o：dependsOn 后补根修②（task-mv9yupm4）：update-task warning 边界 =====
// warning 软提示只在「在飞卡」（in-progress 含 spawn-pending 占位 / verifying）写依赖时出现；
// pending 卡写依赖是正常编辑路径，不带 warning。verifying 与 in-progress 同一条件分支（场景 n
// 已覆盖 spawn-pending 形态，本场景补在跑 run 形态 + pending 反例 + 工具/RPC 双通道同口径）。
test('集成o·dependsOn后补②：update-task 在飞卡写依赖带 warning（pending 卡不带，双通道同口径）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-oa', { pipeline: 'work' })
    await createTask(env, 'task-ob', { pipeline: 'work', dependsOn: ['task-oa'] })
    await env.clock.advance(50)
    await env.waitFor(function () { var x = env.task('task-oa'); return x && x.status === 'in-progress' ? x : null }, 'oa 落卡 in-progress（真实 run 在跑）')
    assert.equal(env.task('task-ob').status, 'pending', 'ob 被 depsSatisfied 门控在 pending')
    // pending 卡写依赖 → 正常编辑，无 warning 字段
    var r1 = await env.rpc('update-task', { sessionId: env.sid, taskId: 'task-ob', dependsOn: ['task-oa'] })
    assert.equal(r1.ok, true)
    assert.ok(!('warning' in r1), 'pending 卡写依赖不带 warning 字段')
    // in-progress（真实 run 在跑）卡写依赖 → warning（RPC 通道）
    var r2 = await env.rpc('update-task', { sessionId: env.sid, taskId: 'task-oa', dependsOn: [] })
    assert.equal(r2.ok, true)
    assert.equal(r2.warning, '卡已在执行中，依赖变更不影响本次 run', '在飞卡写依赖带 warning（RPC 通道）')
    // task_update 工具通道同口径（两份内联拷贝行为一致）
    var r3 = await env.tools.get('task_update').execute({ taskId: 'task-oa', dependsOn: [] })
    assert.equal(r3.ok, true)
    assert.equal(r3.warning, '卡已在执行中，依赖变更不影响本次 run', '在飞卡写依赖带 warning（工具通道）')
    // 收尾：oa 上报完成（ob 留 pending 不派，cleanup 直接拆环境）
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-oa', kind: 'complete', summary: 'oa 交付', changes: '改了 oa', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep.ok, true)
    await env.waitFor(function () { var x = env.task('task-oa'); return x && x.status === 'resolved' ? x : null }, 'oa resolved 收口')
  } finally { await env.cleanup() }
})

// ===== 场景 p：开工计划闸口（task-mvneoyba）——『计划改动：』前缀 progress 自动比对 touches 边界 =====
// 三路径：全合规（记过闸行，不打扰主窗口）/ 部分越界（卡 messages + 主窗口通知 + 返回体 warning 三通道，
// 只警示不阻断）/ 无 touches（跳过比对直接过）。幂等：同一越界计划重复上报，闸口行与通知都不重复。
test('集成p·开工计划闸口：全合规/部分越界/无 touches 三路径 + 三通道警示 + 幂等', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-p1', { pipeline: 'work', touches: ['lib/core.mjs', 'test/**'] })
    await createTask(env, 'task-p2', { pipeline: 'work' }) // 无 touches 卡
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 2 }, '两卡同轮派发')
    await env.waitFor(function () { var x = env.task('task-p1'); return x && x.status === 'in-progress' ? x : null }, 'p1 落卡 in-progress')
    await env.waitFor(function () { var x = env.task('task-p2'); return x && x.status === 'in-progress' ? x : null }, 'p2 落卡 in-progress')

    // ===== ① 全合规：计划文件均在 touches 内 =====
    var planText = '计划改动：lib/core.mjs\ntest/core.test.mjs'
    var g1 = await env.tools.get('board_report').execute({ taskId: 'task-p1', kind: 'progress', question: planText })
    assert.equal(g1.ok, true)
    assert.ok(!('warning' in g1), '全合规不带 warning')
    assert.deepEqual(g1.planGate, { files: 2, outside: [] }, '全合规 planGate 视图')
    assert.equal(g1.progress.text, planText, '计划上报放宽 200 字限制（清单全文落卡）')
    var t1 = env.task('task-p1')
    var gates1 = (t1.messages || []).filter(function (m) { return m.kind === 'plan-gate' })
    assert.equal(gates1.length, 1, '过闸记一行 plan-gate')
    assert.match(gates1[0].text, /计划闸口已过（2 个文件均在 touches 内）/)
    assert.equal(t1.status, 'in-progress', '闸口比对不推进状态')

    // ===== ② 部分越界：三通道警示，只警示不阻断 =====
    var g2 = await env.tools.get('board_report').execute({ taskId: 'task-p1', kind: 'progress', question: '计划改动：lib/core.mjs\nlib/rpc.mjs' })
    assert.equal(g2.ok, true, '越界不阻断执行（工具调用照常成功）')
    assert.deepEqual(g2.planGate.outside, ['lib/rpc.mjs'], '越界清单落返回体')
    assert.match(g2.warning, /计划改动越界：lib\/rpc\.mjs 不在本卡 touches 内/, '通道③：返回体 warning（Worker 直接可见）')
    assert.ok(!g2.planGateNotify, '通知字段锁外带出后即删，不进返回体')
    t1 = env.task('task-p1')
    var oobLines = (t1.messages || []).filter(function (m) { return m.kind === 'plan-gate' && m.text.indexOf('计划改动越界') >= 0 })
    assert.equal(oobLines.length, 1, '通道①：卡 messages 追加 ⚠️ 警示行')
    assert.match(oobLines[0].text, /⚠️ 计划改动越界：lib\/rpc\.mjs 不在 touches（lib\/core\.mjs、test\/\*\*）内/)
    assert.equal(t1.status, 'in-progress', '越界警示不阻断——任务照常执行')

    // ===== 幂等：同一越界计划重复上报，闸口行不重复记、不二次通知 =====
    var g2b = await env.tools.get('board_report').execute({ taskId: 'task-p1', kind: 'progress', question: '计划改动：lib/core.mjs\nlib/rpc.mjs' })
    assert.equal(g2b.ok, true)
    assert.match(g2b.warning, /计划改动越界/, '重复上报返回体仍带 warning（Worker 每次都能自纠）')
    t1 = env.task('task-p1')
    oobLines = (t1.messages || []).filter(function (m) { return m.kind === 'plan-gate' && m.text.indexOf('计划改动越界') >= 0 })
    assert.equal(oobLines.length, 1, '同内容闸口行幂等防刷屏')

    // ===== 通道②：主窗口通知（系统异常通道，随 45s 回执聚合窗投递，带任务现状过滤）=====
    await env.clock.advance(45000)
    await env.waitFor(function () { return env.sent.length >= 1 }, '聚合窗到点投递')
    var delivered = env.sent.map(function (m) { return m.content[0].text }).join('\n')
    assert.ok(delivered.indexOf('⚠️ task-p1 计划改动越界：lib/rpc.mjs 不在 touches 内——可 task_intervene 纠正或放行') >= 0, '主窗口通知含越界明细与处置入口')
    assert.ok(delivered.indexOf('（投递时状态：进行中）') >= 0, '带 taskId 的警示标注投递时任务现状')
    assert.equal(delivered.split('计划改动越界：lib/rpc.mjs 不在 touches 内').length - 1, 1, '幂等：同一越界只通知一次')

    // ===== 空清单：有前缀没解析到路径 → 返回体 warning 自纠正，不通知主窗口 =====
    var g3 = await env.tools.get('board_report').execute({ taskId: 'task-p1', kind: 'progress', question: '计划改动：' })
    assert.equal(g3.ok, true)
    assert.equal(g3.planGate.files, 0)
    assert.match(g3.warning, /计划改动清单为空/)

    // ===== ③ 无 touches 卡：跳过比对直接过 =====
    var g4 = await env.tools.get('board_report').execute({ taskId: 'task-p2', kind: 'progress', question: '计划改动：any/where.mjs' })
    assert.equal(g4.ok, true)
    assert.equal(g4.planGate.skipped, true, '无 touches → skipped 标记')
    assert.ok(!('warning' in g4), '跳过比对不带 warning')
    var t2 = env.task('task-p2')
    var gates2 = (t2.messages || []).filter(function (m) { return m.kind === 'plan-gate' })
    assert.equal(gates2.length, 1)
    assert.match(gates2[0].text, /本卡未声明 touches，跳过比对直接过（1 个文件）/)

    // ===== 普通 progress 不受闸口影响：无 planGate 字段、200 字限制照旧 =====
    var longText = '里程碑：' + 'x'.repeat(300)
    var g5 = await env.tools.get('board_report').execute({ taskId: 'task-p1', kind: 'progress', question: longText })
    assert.equal(g5.ok, true)
    assert.ok(!('planGate' in g5), '非『计划改动：』前缀不进闸口比对')
    assert.equal(g5.progress.text.length, 200, '普通进展仍按 200 字截断')

    // ===== 路径归一：./ 前缀 + Windows 反斜杠归一后去重并合规 =====
    var g6 = await env.tools.get('board_report').execute({ taskId: 'task-p1', kind: 'progress', question: '计划改动：./lib/core.mjs，lib\\core.mjs' })
    assert.equal(g6.ok, true)
    assert.deepEqual(g6.planGate, { files: 1, outside: [] }, '归一后去重为 1 个文件且合规')
    t1 = env.task('task-p1')
    var passLines = (t1.messages || []).filter(function (m) { return m.kind === 'plan-gate' && m.text.indexOf('计划闸口已过') >= 0 })
    assert.equal(passLines.length, 2, '两次不同清单的过闸各记一行（2 文件 + 1 文件）')
    assert.equal(t1.status, 'in-progress', '全程不阻断执行')
  } finally { await env.cleanup() }
})

// ===== 场景 q：续跑前清场（task-mvnyk55n，停泊残影防唤醒）=====
// 原形：ontology EW-B 卡一卡 6 个存活 worker 子会话，被终止/弃权的留存会话 8 小时后被误唤醒与现任
// 并行。修法：tryResumeWorker 冷复活目标子会话前，对同卡 runs 留档里其他 continuable childId 逐个
// interrupt 清场（目标不收——它正是本轮要复活的）。
// 构造：child1 失败留存 → noResume 易主 → fresh spawn child2 → child2 也失败（child1 成停泊残影）
// → 重派轮续跑 child2：清场必打 child1、不打 child2。
function stopsOnChild(env, childId) { return env.interrupts.filter(function (x) { return x.childId === childId }) }
// ===== 原子补丁写（task-mvnyk55n 集成q flake 根修，2026-10-26 实证）=====
// 失败签名：console 打「board file corrupt, quarantined」+ waitFor 超时「noResume 挡住续跑」——
// 看板被隔离成空板，后续派发链整链停摆。机制（代码级实证 + Verifier 探针双确认）：
//   mock-ctx 的 env.patchBoard 是「readFileSync 改改写 + writeFileSync 直写」（mock-ctx.mjs:313-318），
//   而生产上插件自身写板一律走 store.wt 原子写（tmp+fsync+rename，task-mv1e17x9）——**直写形态在生产
//   根本不存在**。continuable 结算尾链（accumulateRunUsage 的 rt 读 dispatch.mjs:1176、stopSettledOneShot
//   的 rt 读 dispatch.mjs:922，均为 task-muwkhqf8/task-mvbeallq 存量）在 waitFor 收敛后仍挂在 libuv
//   线程池上在飞；此刻测试同步 writeFileSync 截断+重写，线程池读交付撕裂内容 → JSON.parse 失败 →
//   recoverCorrupt 隔离 → 空板 → 15s 超时。rename 原子性保证读侧只见旧版或新版、永不见半份——
//   本 helper 让测试补丁写服从宿主同款原子写不变式（根修测试基建失真，非加睡眠稳测试）。
//   Windows 上 rename 覆盖正位时若正位被在飞读句柄占着会 EPERM/EBUSY（store.wt 同款实证）→ 退避重试。
async function patchBoardAtomic(env, fn) {
  var p = path.join(env.home, '.dsh', 'tasks-' + env.sid + '.json')
  var d = JSON.parse(fs.readFileSync(p, 'utf8'))
  fn(d)
  var tmp = p + '.' + process.pid + '.' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(d), 'utf8')
  for (var i = 0; i < 200; i++) {
    try { fs.renameSync(tmp, p); return }
    catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { await new Promise(function (r) { setTimeout(r, 10) }); continue }
      try { fs.unlinkSync(tmp) } catch (_) {}
      throw e
    }
  }
  // 重试耗尽（理论上在飞读不会挂 2s）：降级 unlink+rename，与 store.wt 的 Windows 兜底同纪律。
  try { fs.unlinkSync(p) } catch (_) {}
  fs.renameSync(tmp, p)
}
test('集成q·续跑前清场：冷复活目标前 interrupt 同卡其他停泊 continuable 子会话，目标 childId 不收', async () => {
  var env = createMockCtx()
  // 本场景三段派发链（spawn→失败→fresh spawn→失败→续跑）是全套件 waitFor 密度最高的一条，
  // 全量 npm test 并行进程负载下真实 I/O 收敛显著变慢（实测 5s 默认上限偶发超时）——统一放宽到 15s。
  var W = 15000
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-q1', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, '首轮 worker spawn 发生', W)
    var child1 = env.continuables[0].childId
    await env.waitFor(function () { var x = env.task('task-q1'); return x && x.status === 'in-progress' && x.claimedBy === child1 ? x : null }, '落卡 in-progress', W)
    // 首轮失败（空文本按失败重排）→ pending + incomplete；endContinuable 留存一枪，续跑位在手豁免补停
    env.emitStatus(child1, 'running')
    env.emitStatus(child1, 'idle')
    await env.waitFor(function () { var x = env.task('task-q1'); return x && x.status === 'pending' && x.runs && x.runs[0] && x.runs[0].outcome === 'incomplete' ? x : null }, '首轮失败回 pending', W)
    // 相对断言（≥1）：endContinuable 的留存一枪同步先于落盘（settleRun 内 997→1004→1013 序），必在；
    // 但结算末尾 stopSettledOneShot 的异步补停臂（fire-and-forget，await rt 读锁外快照）可能在
    // noResume 易主/child2 落卡后才落定——resumeTarget 不再指向 child1，豁免失效会再补一枪
    // （dispatch.mjs:928，既有幂等清理，产品行为无错）。本测试只断言「清场相对基数 +1」，绝对枪数不当基线。
    assert.ok(stopsOnChild(env, child1).length >= 1, '失败结算留存 interrupt 至少一枪')
    // 构造「child1 被取代」现场：旧留档立 noResume（续跑资格关闭）→ 下轮 fresh spawn 新 Worker。
    // 补丁写必须走原子写（patchBoardAtomic）：child1 结算尾链的 rt 读此刻仍可能在飞，
    // env.patchBoard 的非原子直写会被它撕裂读成半截 JSON → 看板隔离 → 后续派发链停摆（本场景历史红签名）。
    await patchBoardAtomic(env, function (d) { var t = d.tasks.find(function (x) { return x.id === 'task-q1' }); t.runs[0].noResume = true })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 2 }, 'noResume 挡住续跑 → fresh spawn 新 Worker', W)
    var child2 = env.continuables[1].childId
    await env.waitFor(function () { var x = env.task('task-q1'); return x && x.status === 'in-progress' && x.claimedBy === child2 ? x : null }, '新 Worker 落卡', W)
    // 新 Worker 也失败 → child2 持续跑位；child1 自此是停泊残影（留存但续跑位不在手）
    env.emitStatus(child2, 'running')
    env.emitStatus(child2, 'idle')
    await env.waitFor(function () { var x = env.task('task-q1'); return x && x.status === 'pending' && x.runs && x.runs[1] && x.runs[1].outcome === 'incomplete' ? x : null }, '新 Worker 失败回 pending', W)
    // 静默窗（真实时间 300ms，与集成r 同款约定）：让 child1/child2 结算末尾 stopSettledOneShot 的
    // 迟到补停充分跑完再取基数——该臂是 fire-and-forget 链（不随任何 waitFor 条件收敛），
    // 全量并行负载下 rt 快照读可能跨过 noResume 易主/child2 落卡才落定，给残影 child1 补一枪。
    // 等尘埃落定后取 base，下方「清场 = base+1 / 目标 = base」的相对断言才不与异步臂赛跑。
    await new Promise(function (r) { setTimeout(r, 300) })
    var base1 = stopsOnChild(env, child1).length
    var base2 = stopsOnChild(env, child2).length
    assert.ok(base1 >= 1, '清场前 child1 至少有失败结算一枪（补停臂若迟到落定已被基数吸收）')
    assert.ok(base2 >= 1, 'child2 失败结算留存至少一枪')
    // ===== 重派轮：续跑 child2 → 清场先 interrupt 残影 child1；目标 child2 不收 =====
    await env.clock.advance(50)
    await env.waitFor(function () { return env.sendMessages.some(function (m) { return m.childId === child2 }) }, '续跑 sendMessage 冷复活 child2', W)
    var t = await env.waitFor(function () { var x = env.task('task-q1'); return x && x.status === 'in-progress' && x.claimedBy === child2 && x.runs && x.runs.length === 3 ? x : null }, '续跑落闸：认领位回 child2 + 续跑留档', W)
    assert.equal(t.runs[2].resume, true, '第三条是续跑记录')
    assert.equal(stopsOnChild(env, child1).length, base1 + 1, '续跑前清场：旧停泊子会话 child1 收到 interrupt（防误唤醒）')
    assert.equal(stopsOnChild(env, child2).length, base2, '目标 childId 不收清场 interrupt（它正被冷复活）')
    // 续跑轮正常交付收口（清场不伤续跑本体）
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-q1', kind: 'complete', summary: '续跑交付', changes: '改了 q', selfTest: 'npm test 全绿', diffStat: '' })
    assert.equal(rep.ok, true)
    t = await env.waitFor(function () { var x = env.task('task-q1'); return x && x.status === 'resolved' && x.runs[2].outcome === 'completed' ? x : null }, '续跑轮交付落 resolved 且关账', W)
  } finally { await env.cleanup() }
})

// ===== 场景 r：hold 终止 × activation.result 联动结算竞态（task-mvnyk55n 驳回根修）=====
// 驳回原形（Verifier 临时探针实证）：doTerminate(hold) 的 dispose 按宿主契约落定 activation.result，
// 而 doTerminate 摘 runsFor 表项时未立 rec.settled → dispatch 拆除结算兜底臂抢在 hold 落账前把
// 手动终止误记成一次 Worker 失败（retryCount+1 / lastError=子会话被宿主拆除 / 「worker 失败…重新排队」；
// 卡已有 retryCount=2 时直接被打成 blocked）。根修：doTerminate 摘表即立 rec.settled 首胜旗
// （兜底臂 settled 判因此等价归属守卫）。本场景用真实 apply(mockCtx) 链路 + 宿主同构
// startActivation 桩（dispose 拆除时落定 result，stopReason=aborted）复刻全竞态。
test('集成r·hold终止结算竞态：dispose 落定 activation.result 不抢结——零 retryCount/lastError 误记，停派语义纯净', async () => {
  var env = createMockCtx()
  var W = 15000
  try {
    // 新契约宿主桩（与真实宿主同构：dispose 拆除子会话 → activation.result 以 stopReason=aborted 落定）
    var activations = []
    env.ctx.subagents.startActivation = async function (spec) {
      var settle = {}
      var act = {
        childId: 'child-a' + (activations.length + 1),
        messageId: 'ma' + (activations.length + 1),
        label: spec.label,
        disposed: false,
        result: new Promise(function (res, rej) { settle.res = res; settle.rej = rej }),
        dispose: async function () { act.disposed = true; settle.res({ output: [], stopReason: 'aborted' }) },
      }
      activations.push(act)
      return act
    }
    plugin.apply(env.ctx)
    await createTask(env, 'task-r1', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return activations.length >= 1 }, 'worker spawn 走新契约 startActivation', W)
    var act1 = activations[0]
    await env.waitFor(function () { var x = env.task('task-r1'); return x && x.status === 'in-progress' && x.claimedBy === act1.childId ? x : null }, '落卡 in-progress', W)
    // ===== 主场景：hold 终止 → dispose 销毁 + result 落定（竞态窗口）=====
    var term = await env.rpc('terminate-agent', { sessionId: env.sid, taskId: 'task-r1', hold: true })
    assert.equal(term.ok, true)
    assert.equal(term.terminated, 'worker:task-r1')
    assert.equal(act1.disposed, true, 'hold 终止走 dispose 销毁')
    assert.ok(env.interrupts.some(function (x) { return x.childId === act1.childId }), 'dispose 前 interrupt 打断当前 turn')
    var t = await env.waitFor(function () { var x = env.task('task-r1'); return x && x.status === 'pending' && x.assignMode === 'manual' ? x : null }, 'hold 落账：pending + manual', W)
    // 兜底臂的误结算是 fire-and-forget 链（不随 RPC 返回）——给足真实时间窗让任何迟到结算充分跑完再断言
    await new Promise(function (r) { setTimeout(r, 300) })
    t = env.task('task-r1')
    assert.equal(t.retryCount || 0, 0, '兜底臂未抢结：无 retryCount 误加')
    assert.equal(t.lastError, undefined, '无「子会话被宿主拆除」lastError 误落')
    assert.equal(t.status, 'pending', 'hold 终止停派语义纯净（不被失败臂翻动）')
    assert.equal(t.assignMode, 'manual')
    assert.ok(!t.history.some(function (h) { return /worker 失败/.test(h.note || '') }), 'history 无「worker 失败…重新排队」误记')
    assert.ok(t.history.some(function (h) { return /手动终止，任务重新排队/.test(h.note || '') }), '终止落账本身在列')
    assert.equal(t.runs[0].outcome, 'terminated', 'run 留档关账 terminated（非失败形态）')
    await env.clock.advance(50)
    await new Promise(function (r) { setTimeout(r, 50) })
    assert.equal(activations.length, 1, 'manual 闸门：不再自动重派')
    assert.equal(env.sendMessages.length, 0, '零续跑投递')
    // ===== 加强形态：retryCount=2 的卡被 hold 终止——修复前竞态会直接打成 blocked =====
    await createTask(env, 'task-r2', { pipeline: 'work' })
    await env.clock.advance(50)
    await env.waitFor(function () { return activations.length >= 2 }, '第二张卡 worker spawn', W)
    var act2 = activations[1]
    await env.waitFor(function () { var x = env.task('task-r2'); return x && x.status === 'in-progress' && x.claimedBy === act2.childId ? x : null }, 'task-r2 落卡 in-progress', W)
    // 落卡 waitFor 收敛时 spawn 链尾（recordRunHistory 写盘）可能仍在飞——先给 100ms 真实静默窗让其落完，
    // 再走原子补丁写（防直写被在飞读撕裂/防补丁读改写在飞写丢失），与集成q 同一纪律。
    await new Promise(function (r) { setTimeout(r, 100) })
    await patchBoardAtomic(env, function (d) { var x = d.tasks.find(function (y) { return y.id === 'task-r2' }); x.retryCount = 2; x.lastError = '前两次失败留痕' })
    var term2 = await env.rpc('terminate-agent', { sessionId: env.sid, taskId: 'task-r2', hold: true })
    assert.equal(term2.ok, true)
    await env.waitFor(function () { var x = env.task('task-r2'); return x && x.status === 'pending' && x.assignMode === 'manual' ? x : null }, 'task-r2 hold 落账', W)
    await new Promise(function (r) { setTimeout(r, 300) })
    var t2 = env.task('task-r2')
    assert.equal(t2.status, 'pending', 'retryCount=2 的卡 hold 终止不得被打成 blocked')
    assert.equal(t2.retryCount, 2, '终止不加失败计数')
    assert.equal(t2.lastError, '前两次失败留痕', '既有 lastError 不被「子会话被宿主拆除」覆盖')
    assert.ok(!t2.history.some(function (h) { return /worker 失败|待人工介入/.test(h.note || '') }), '无失败/阻塞误记')
  } finally { await env.cleanup() }
})
