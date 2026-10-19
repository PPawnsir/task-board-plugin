// dsh-agent-board — 迟到 verdict 三连根修（task-mvf7nve8）
// 事故实证：Verifier 调 board_verdict 漏带 verdict 字段（undefined 落账），被 lateRejected=!approved
// 当驳回 → err 级「迟到驳回」误报 + 同一结论多次落账重复投递（J2 task-mvf2lpzk 4 次 / H2 task-mveljjwd 3 次）。
// 三连逐一锁：① 入参校验（缺/非法 verdict 拒收带指引+零落账）② 通知分态（approved=✅迟到复核 /
// rejected=🚨迟到驳回，banner 只 rejected 亮）③ 同指纹（taskId+by+verdict）去重零重复通知。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRpc } from '../lib/rpc.mjs'
import * as core from '../lib/core.mjs'
import { createNotify } from '../lib/notify.mjs'
import { computeRuntimeHealthHints } from '../lib/health.mjs'

const FULL_SID = 'session-mock-trio-00000000-0001'

function mkTask(over) { return Object.assign({ id: 't1', title: 'T', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null, history: [], messages: [] }, over || {}) }
function mkBoard(tasks) { return { version: 11, ownerSession: FULL_SID, boardMode: 'auto', verifyUserGuide: true, tasks: tasks || [] } }

// RPC/工具直调 harness（与 verify-timing.test.mjs 同款，加 notifyLateApprove 捕获）
function mkHarness(board, extra) {
  const state = { handlers: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {}, poolHealth: {} }
  const tools = {}
  const calls = { lateRejects: [], lateApproves: [] }
  const ctx = { tools: { register(t) { tools[t.name] = t } }, effect() {}, webServer: { register() { return () => {} } } }
  const deps = Object.assign({
    getActorId: () => 'verifier-child-1', resolveRoot: (x) => x,
    toolSessionId: () => FULL_SID, rpcSessionId: () => FULL_SID,
    rootForSession: () => null, deriveWorkMode: () => 'solo',
    runsFor: () => ({}),
    rt: async () => board, mutateLocked: (sid, fn) => fn(board),
    maybeNotify: () => {}, notifyTaskDone: () => {},
    spawnOneShot: () => {}, accumulateRunUsage: () => {}, readContextPack: async () => null,
    pushSysNote: () => {}, sessionCwd: () => '',
    hasActiveRun: () => false,
    notifyLateReject: (sid, t) => { calls.lateRejects.push(t.id) },
    notifyLateApprove: (sid, t) => { calls.lateApproves.push(t.id) },
  }, extra || {})
  createRpc(ctx, state, deps)
  return { tools: tools, calls: calls, state: state }
}

// ===== ① 入参校验：缺 verdict / 非法值 → 拒收带指引 + 零落账零通知 =====
test('① board_verdict 缺 verdict / 非法值：拒收带指引，不落账不通知（verifying 卡与已落定卡同口径）', async () => {
  // verifying 卡：缺 verdict
  const b1 = mkBoard([mkTask({ id: 'k1', status: 'verifying' })])
  const h1 = mkHarness(b1)
  const r1 = await h1.tools['board_verdict'].execute({ taskId: 'k1', summary: '全过' }, {})
  assert.equal(r1.ok, false)
  assert.match(r1.error, /verdict 必须是 approved 或 rejected（收到：undefined），请带正确字段重调/)
  assert.equal(b1.tasks[0].status, 'verifying', '状态不动')
  assert.equal(b1.tasks[0].verification, undefined, '零落账：无 verification')
  assert.equal(b1.tasks[0].lateVerdict, undefined, '零落账：无 lateVerdict')
  // 已落定卡：非法值 verdict → 同样拒收（迟到分支也被闸）
  const b2 = mkBoard([mkTask({ id: 'k2', status: 'resolved', resolvedAt: '2026-01-01T00:01:00Z' })])
  const h2 = mkHarness(b2)
  const r2 = await h2.tools['board_verdict'].execute({ taskId: 'k2', verdict: 'pass', summary: '全过' }, {})
  assert.equal(r2.ok, false)
  assert.match(r2.error, /verdict 必须是 approved 或 rejected（收到：pass）/)
  assert.equal(b2.tasks[0].lateVerdict, undefined, '零落账：非法 verdict 不落 lateVerdict')
  assert.equal(b2.tasks[0].verification, undefined, '零落账：不补建 verification')
  assert.deepEqual(h2.calls.lateRejects, [], '零通知：无迟到驳回')
  assert.deepEqual(h2.calls.lateApproves, [], '零通知：无迟到复核')
  assert.equal(h2.state.poolHealth[FULL_SID], undefined, '零通知：去重指纹也未写')
  // 纯函数闸：lateVerdictApply 非法 verdict 直返 invalid，一字不落
  const t3 = mkTask({ id: 'k3', status: 'resolved' })
  const r3 = core.lateVerdictApply(t3, undefined, 's', 'c', null, 'at', 'by', true)
  assert.equal(r3.invalid, true); assert.match(r3.error, /收到：undefined/)
  assert.equal(t3.lateVerdict, undefined); assert.equal(t3.verification, undefined)
  // 人工通道不受此限：task_verify 正常走（schema 枚举之外的运行时不拦主窗口）
  const b4 = mkBoard([mkTask({ id: 'k4', status: 'verifying' })])
  const h4 = mkHarness(b4)
  const r4 = await h4.tools['task_verify'].execute({ taskId: 'k4', verdict: 'approved' }, {})
  assert.equal(r4.ok, true); assert.equal(b4.tasks[0].status, 'resolved')
})

// ===== ② approved 迟到：notice 级「✅ 迟到复核」通知，非 err 级「🚨 迟到驳回」=====
test('② approved 迟到：通知走 notifyLateApprove（✅ 迟到复核），不触 notifyLateReject，无 lateRejectNote', async () => {
  const board = mkBoard([mkTask({ id: 'a1', status: 'resolved', resolvedAt: '2026-01-01T00:01:00Z' })])
  const h = mkHarness(board)
  const r = await h.tools['board_verdict'].execute({ taskId: 'a1', verdict: 'approved', summary: '复跑全过', checks: '## 核对项\n- ok' }, {})
  assert.equal(r.ok, true); assert.equal(r.late, true); assert.equal(r.lateRejected, false)
  assert.equal(board.tasks[0].lateVerdict.verdict, 'approved')
  assert.deepEqual(h.calls.lateApproves, ['a1'], 'approved 迟到 → ✅ 迟到复核通知')
  assert.deepEqual(h.calls.lateRejects, [], 'approved 迟到绝不触 🚨 迟到驳回')
  assert.equal(h.state.poolHealth[FULL_SID].lateRejectNote, undefined, 'health banner 不为 approved 亮')
  // notify 本体文案：✅ 迟到复核 · 维持原判（全过追认），非 err 措辞
  const sent = []
  const notify = createNotify({}, {}, { rt: async () => board, rootForSession: () => ({ followup: (m) => sent.push(m) }), withTimeout: (p) => p, isDispatched: () => false })
  notify.notifyLateApprove(FULL_SID, board.tasks[0])
  assert.equal(sent.length, 1)
  const txt = sent[0].content[0].text
  assert.match(txt, /✅ \[任务看板\] 迟到复核：a1 维持原判（全过追认）/)
  assert.match(txt, /复跑全过/)
  assert.ok(!/🚨|迟到驳回/.test(txt), 'approved 通知无 err 级措辞')
  assert.equal(sent[0].source.summary, '迟到复核: a1')
})

// ===== ③ 同指纹去重：二次落账零重复通知 =====
test('③ 同指纹（taskId+by+verdict）二次落账：通知只投一次；不同 verdict 指纹不同 → 各投一次', async () => {
  const board = mkBoard([mkTask({ id: 'd1', status: 'resolved', resolvedAt: '2026-01-01T00:01:00Z' })])
  const h = mkHarness(board)
  await h.tools['board_verdict'].execute({ taskId: 'd1', verdict: 'approved', summary: '第一次' }, {})
  await h.tools['board_verdict'].execute({ taskId: 'd1', verdict: 'approved', summary: '第二次（同指纹重投）' }, {})
  await h.tools['board_verdict'].execute({ taskId: 'd1', verdict: 'approved', summary: '第三次（同指纹重投）' }, {})
  assert.deepEqual(h.calls.lateApproves, ['d1'], '同指纹三次落账只投一次通知')
  assert.equal(h.state.poolHealth[FULL_SID].lastLateNotice, 'd1|verifier-child-1|approved', '指纹 = taskId+by+verdict')
  // 指纹变（verdict 翻驳回）→ 新通知照投（reject 通道）
  await h.tools['board_verdict'].execute({ taskId: 'd1', verdict: 'rejected', summary: '翻驳回' }, {})
  assert.deepEqual(h.calls.lateRejects, ['d1'], '指纹不同 → rejected 通知照投')
  // 驳回同指纹重投 → 也去重
  await h.tools['board_verdict'].execute({ taskId: 'd1', verdict: 'rejected', summary: '驳回重投' }, {})
  assert.deepEqual(h.calls.lateRejects, ['d1'], 'rejected 同指纹重投零重复')
})

// ===== ④ rejected 迟到不回归：维持 err「🚨 迟到驳回」+ lateRejectNote =====
test('④ rejected 迟到（卡已 approved）：维持 err 级「🚨 迟到驳回」通知 + healthHint 不回归', async () => {
  const board = mkBoard([mkTask({ id: 'r1', status: 'resolved', resolvedAt: '2026-01-01T00:01:00Z' })])
  const h = mkHarness(board)
  const r = await h.tools['board_verdict'].execute({ taskId: 'r1', verdict: 'rejected', summary: '单测红', checks: '## 核对项\n- 红' }, {})
  assert.equal(r.ok, true); assert.equal(r.late, true); assert.equal(r.lateRejected, true)
  assert.deepEqual(h.calls.lateRejects, ['r1'])
  assert.deepEqual(h.calls.lateApproves, [], 'rejected 绝不触 ✅ 迟到复核')
  assert.equal(h.state.poolHealth[FULL_SID].lateRejectNote.taskId, 'r1', 'err banner 数据源照写')
  // notify 本体文案：🚨 迟到驳回
  const sent = []
  const notify = createNotify({}, {}, { rt: async () => board, rootForSession: () => ({ followup: (m) => sent.push(m) }), withTimeout: (p) => p, isDispatched: () => false })
  notify.notifyLateReject(FULL_SID, board.tasks[0])
  assert.equal(sent.length, 1)
  assert.match(sent[0].content[0].text, /🚨 \[任务看板\] 迟到驳回：r1 你批早了但 Verifier 验出红的/)
})

// ===== ⑤ health banner 只 rejected 亮 =====
test('⑤ health err banner：lateRejectNote 只在 rejected 路径出现，computeRuntimeHealthHints 如实透出', () => {
  // 无 lateRejectNote（approved 迟到的盘面）→ 无迟到 banner
  const b1 = mkBoard([mkTask({ id: 'h1', status: 'resolved', lateVerdict: { verdict: 'approved', by: 'v', at: 'x' } })])
  const o1 = computeRuntimeHealthHints(b1, { bornAt: Date.now(), lastLateNotice: 'h1|v|approved' }, { capW: 0, alive: false })
  assert.ok(!o1.hints.some(function (x) { return /迟到/.test(x.text) }), 'approved 迟到盘面零迟到 banner')
  // 有 lateRejectNote（rejected 迟到）→ err 级 banner
  const b2 = mkBoard([mkTask({ id: 'h2', status: 'resolved' })])
  const o2 = computeRuntimeHealthHints(b2, { bornAt: Date.now(), lateRejectNote: { taskId: 'h2', at: Date.now() } }, { capW: 0, alive: false })
  const hit = o2.hints.find(function (x) { return /迟到驳回/.test(x.text) })
  assert.ok(hit, 'rejected 迟到 → banner 亮')
  assert.equal(hit.level, 'err')
  assert.match(hit.text, /迟到驳回：h2 你批早了但 Verifier 验出红的/)
})
