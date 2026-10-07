// dsh-agent-board — 集成套件前半（task-muxpgc6u 无头基建卡2）：全链路 / 驳回重派 / dependsOn 接续 / touches 排他
// 四场景全部跑在「真实 index.mjs apply(mockCtx)」上（卡1 harness），不改生产代码；
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
// 每个写操作后 advance(50) 触发一轮 poolCycle；15s 心跳 / 25s 歧义去抖 / 45s 回执聚合 /
// 30min 软超时 / 120min 硬超时在本套件推进幅度（单场景 ≤300ms 虚拟）内永不触发。
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
