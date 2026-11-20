// 生命周期状态转移表断言（task-mwk47az1）：
//   ① LIFECYCLE_TRANSITIONS 覆盖全部合法转移（规格逐条，via 标签同验）
//   ② 六推进点（claimApply/resolveApply/verifyApply/maybeAutoCloseParent/parentKickOnDispatch/
//      applyDecomposeProposal）全部查表断言（源码级）
//   ③ 非法转移（如 draft→resolved）被查表拒绝（findTransition null + assertTransition 抛错）
//   ④ 既有断言全绿由 npm test 整体承担（本文件即其中一员）
// 边界：运行期检测器与更广断言族是后续子卡，本文件只锁表与注册关系。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as lc from '../lib/lifecycle.mjs'
import * as core from '../lib/core.mjs'
import * as policy from '../lib/policy.mjs'

function srcOf(f) { return readFileSync(new URL(f, import.meta.url), 'utf8') }

// ===== ① 表覆盖全部合法转移（规格逐条；via 标签命中同验）=====
const SPEC = [
  ['draft', 'pending', 'publish'],          // 草稿发布入池
  ['draft', 'pending', 'decompose'],        // 拆解物化推进（父卡只推一格）
  ['pending', 'in-progress', 'claim'],      // 领取
  ['pending', 'in-progress', 'dispatch'],   // poolCycle 派发占位
  ['pending', 'in-progress', 'parentKick'], // 首个子卡派发（父卡）
  ['in-progress', 'verifying', 'resolve'],  // Worker 完成/提交验证（full）
  ['in-progress', 'blocked', 'blocked'],   // 失败×3 / 人工提交阻塞 / hook 失败
  ['in-progress', 'pending', 'reclaim'],    // run 丢失回收/失败重试/驳回重派/终止/裁决回池
  ['verifying', 'resolved', 'verify-approved'],   // 验收通过
  ['verifying', 'in-progress', 'verify-rejected'],// 驳回重派
  ['in-progress', 'verifying', 'parentAuto'],     // 全部子卡落定（full/work 父卡收口）
  ['in-progress', 'resolved', 'parentAuto'],      // 全部子卡落定（direct 父卡直接收口）
  ['verifying', 'verifying', 'parentAuto'],       // 父卡已 verifying 的幂等维持
  ['resolved', 'archived', 'archive'],      // 归档
  ['draft', 'cancelled', 'cancel'],         // 取消放行面（draft/pending/blocked）
  ['pending', 'cancelled', 'cancel'],
  ['blocked', 'cancelled', 'cancel'],
  ['in-progress', 'cancelled', 'cancel'],   // 仅 spawn-pending 派发占位态
]
test('①转移表覆盖全部合法转移：规格逐条查表命中且 via 标签相符', () => {
  for (const [f, t, v] of SPEC) {
    const e = lc.findTransition(f, t, v)
    assert.ok(e, '缺边: ' + f + ' → ' + t + '（via ' + v + '）')
    assert.ok(e.via.includes(v), 'via 标签不符: ' + f + ' → ' + t + ' 期望 ' + v + '，实得 ' + e.via)
  }
})

test('①表完整性：边引用的状态全部合法（from/to ∈ 8 态；通配仅限 from===to 自环）', () => {
  assert.deepEqual(lc.LIFECYCLE_CORE_STATES, ['draft', 'pending', 'in-progress', 'verifying', 'resolved', 'blocked'], '6 状态口径')
  assert.equal(lc.LIFECYCLE_STATES.length, 8, '全集 8 态（含 cancelled/archived 终态汇）')
  for (const e of lc.LIFECYCLE_TRANSITIONS) {
    const fs = Array.isArray(e.from) ? e.from : [e.from]
    for (const f of fs) if (f !== '*') assert.ok(lc.LIFECYCLE_STATES.includes(f), '未知 from: ' + f + '（边 ' + JSON.stringify(e.via) + '）')
    if (e.to !== '*') assert.ok(lc.LIFECYCLE_STATES.includes(e.to), '未知 to: ' + e.to)
    if (e.to === '*') { assert.equal(e.from, '*', '通配 to 仅允许与通配 from 同用（同态自环）'); assert.ok(e.via.includes('audit-self'), '通配自环必须带 audit-self 标签') }
  }
  assert.ok(lc.LIFECYCLE_TRANSITIONS.length >= SPEC.length, '表边数不少于规格清单')
})

// ===== ② 六推进点全部查表断言（源码级：推进点改 status 前有 assertTransition 调用）=====
test('②六推进点注册在表上（源码级断言）', () => {
  const cs = srcOf('../lib/core.mjs')
  const ps = srcOf('../lib/policy.mjs')
  assert.match(cs, /import \{ assertTransition \} from '\.\/lifecycle\.mjs'/, 'core 接表')
  assert.match(ps, /import \{ assertTransition \} from '\.\/lifecycle\.mjs'/, 'policy 接表')
  assert.match(cs, /export function claimApply\([^)]*\)[^\n]*assertTransition\(ps, 'in-progress', 'claim'\)[^\n]*t\.status = 'in-progress'/, 'claimApply 查表')
  assert.match(cs, /export function resolveApply\([^)]*\)[^\n]*assertTransition\(ps, status, 'resolve'\); t\.status = status/, 'resolveApply 查表')
  assert.match(cs, /export function verifyApply\([^)]*\)[^\n]*assertTransition\(ps, verdict === 'approved' \? 'resolved' : 'in-progress', 'verify'\)/, 'verifyApply 查表')
  assert.match(cs, /assertTransition\(p\.status, p\.status, 'parentAuto'\)/, 'maybeAutoCloseParent：hook-post 延迟收口同态断言')
  assert.match(cs, /assertTransition\(p\.status, 'resolved', 'parentAuto'\)[\s\S]{0,20}p\.status = 'resolved'/, 'maybeAutoCloseParent：direct 父卡收口断言')
  assert.match(cs, /assertTransition\(p\.status, 'verifying', 'parentAuto'\)[\s\S]{0,20}p\.status = 'verifying'/, 'maybeAutoCloseParent：full/work 父卡收口断言')
  assert.match(cs, /export function parentKickOnDispatch\([^)]*\)[^\n]*assertTransition\(p\.status, 'in-progress', 'parentKick'\)[^\n]*p\.status = 'in-progress'/, 'parentKickOnDispatch 查表')
  assert.match(ps, /assertTransition\(ps0, 'pending', 'decompose'\)[\s\S]{0,20}t\.status = 'pending'/, 'applyDecomposeProposal 查表')
})

// ===== ③ 非法转移被查表拒绝 =====
const ILLEGAL = [
  ['draft', 'resolved'], ['draft', 'in-progress'], ['draft', 'verifying'],
  ['resolved', 'in-progress'], ['resolved', 'verifying'],
  ['archived', 'in-progress'], ['archived', 'verifying'],
  ['cancelled', 'in-progress'],
  ['verifying', 'blocked'], ['blocked', 'verifying'],
]
test('③非法转移被查表拒绝：findTransition 为 null + assertTransition 开发期抛错', () => {
  for (const [f, t] of ILLEGAL) {
    assert.equal(lc.findTransition(f, t), null, '不该有边: ' + f + ' → ' + t)
    assert.throws(() => lc.assertTransition(f, t, 'test'), /非法状态转移/, '应抛错: ' + f + ' → ' + t)
  }
})

test('③推进点实例：非 verifying 卡走 verifyApply → 开发期抛错且状态不变', () => {
  const t = { id: 'x', title: 'X', status: 'draft', parentId: null, history: [] }
  assert.throws(() => core.verifyApply({ tasks: [t] }, t, 'v', 'approved', ''), /非法状态转移: draft → resolved/)
  assert.equal(t.status, 'draft', '抛错先于改状态（死胡同零落账）')
})

// ===== 合法流零行为变化（六推进点经断言后照常落状态）=====
function mkT(o) {
  return Object.assign({ id: 't1', title: 'T', status: 'pending', parentId: null, pipeline: 'full', claimedBy: null, claimedAt: null, history: [], messages: [] }, o)
}
test('合法流冒烟：六推进点照常落状态（断言零干扰）', () => {
  const t1 = mkT({}); core.claimApply({ tasks: [t1] }, t1, 'w', 'test'); assert.equal(t1.status, 'in-progress')
  const t2 = mkT({ status: 'blocked' }); core.claimApply({ tasks: [t2] }, t2, 'w', 'test'); assert.equal(t2.status, 'in-progress', 'blocked 领取复工（CLAIMABLE 含 blocked）')
  const t3 = mkT({ status: 'in-progress' }); core.resolveApply({ tasks: [t3] }, t3, 'w', 'verifying', 'done'); assert.equal(t3.status, 'verifying', 'full 档 → verifying')
  const t4 = mkT({ status: 'in-progress', pipeline: 'work' }); core.resolveApply({ tasks: [t4] }, t4, 'w', 'verifying', 'done'); assert.equal(t4.status, 'resolved', 'work 档强改 → resolved')
  const t5 = mkT({ status: 'verifying' }); core.verifyApply({ tasks: [t5] }, t5, 'v', 'approved', 'ok'); assert.equal(t5.status, 'resolved')
  const t6 = mkT({ status: 'verifying' }); core.verifyApply({ tasks: [t6] }, t6, 'v', 'rejected', 'bad'); assert.equal(t6.status, 'in-progress')
  const ep = mkT({ id: 'ep', status: 'in-progress', pipeline: 'direct' })
  const c1 = mkT({ id: 'c1', parentId: 'ep', status: 'resolved' })
  core.maybeAutoCloseParent({ tasks: [ep, c1] }, c1); assert.equal(ep.status, 'resolved', 'direct 父卡收口')
  const ep2 = mkT({ id: 'ep2', status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: 'idle' } } })
  const c2 = mkT({ id: 'c2a', parentId: 'ep2', status: 'resolved' })
  core.maybeAutoCloseParent({ tasks: [ep2, c2] }, c2); assert.equal(ep2.status, 'in-progress', 'post 闸门延迟收口（同态维持）'); assert.equal(ep2.hooks.post.pending, true)
  const ep3 = mkT({ id: 'ep3', status: 'pending' })
  const c3 = mkT({ id: 'c3', parentId: 'ep3', status: 'pending' })
  core.parentKickOnDispatch({ tasks: [ep3, c3] }, c3); assert.equal(ep3.status, 'in-progress')
  const src = mkT({ id: 'src', status: 'draft', messages: [] })
  const r = policy.applyDecomposeProposal({ tasks: [src] }, src, { verdict: 'split', children: [{ title: 'B', description: '', size: 'standard', touches: [], acceptance: 'a' }] }, '2026-01-01T00:00:00Z')
  assert.equal(r.ok, true); assert.equal(src.status, 'pending', '物化推进 draft→pending')
})

// ===== 死胡同检测器 sweepStuckCards（task-mwk481xj）：六类「应推进但没推进」形态 =====
// （⑥ 由 task-mwkb7djc 补：pending + direct 父卡 + 子卡全落定 → 直接收口 resolved——②类排除 direct
//   而 maybeAutoCloseParent 要求父卡 in-progress，二者叠加留下的盲区，实证 task-mwk0daqx 停死）
// 断言族：①六类各构造一例 → 全部识别 ②可自动推进的（①②③⑥）被正确推进 ③只上报的（④⑤b）产生
// pushSysNote 且不自动改状态（⑤a task-mwogc5nu：僵尸验收立即检测+自动重派 Verifier，失败转 blocked）
// ④正常卡不误报 ⑤源码级挂点/查表断言锁。直调纯函数 + 薄桩 poolCycle
//（mkGateDispatch 同款形态：真跑 createDispatch.poolCycle，stub 掉 IO/计时器）双面覆盖。
import { createDispatch, sweepStuckCards } from '../lib/dispatch.mjs'

var SID = 'session-test-stk1-0000-0000-000000000000'
function mkCard(over) {
  return Object.assign({ id: 'k1', title: '死胡同卡', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, subtaskStrategy: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', history: [], messages: [] }, over || {})
}
function mkBoard(tasks) { return { version: 12, ownerSession: SID, boardMode: 'auto', tasks: tasks || [] } }
function mkDispatch(board, ctxOver, depsOver) {
  var notes = []
  var runs = {}
  var activeRuns = {}
  activeRuns[SID] = runs
  var state = { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {} }
  state.activeRuns = activeRuns
  var base = {
    fs: {}, get: function () { return null },
    timer: {
      timeout: function (a) { if (typeof a === 'function') { return function () {} } return new Promise(function () {}) },
      interval: function () { return function () {} },
    },
    effect: function (f) { var d = f(); return function () {} },
    on: function () { return function () {} },
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { return { id: 'run-x', result: new Promise(function () {}), dispose: async function () {} } },
      startContinuable: async function () { return { childId: 'child-new', messageId: 'm1' } },
    },
  }
  var dispatch = createDispatch(
    Object.assign(base, ctxOver || {}),
    state,
    Object.assign({
      rt: async function () { return board }, wt: async function () {}, mutateLocked: async function (sid, fn) { return fn(board) }, kickCycle: function () {},
      rootForSession: function () { return { id: SID } },
      withTimeout: function (p) { return p }, runsFor: function () { return runs }, feedbackOn: function () { return true },
      pushSysNote: function (s, text, taskId) { notes.push({ sid: s, text: text, taskId: taskId }) },
      maybeNotify: function () {}, notifyTaskDone: function () {},
    }, depsOver || {}))
  return { dispatch: dispatch, state: state, runs: runs, notes: notes, board: board }
}
var flush = async function () { for (var i = 0; i < 8; i++) await new Promise(function (r) { setImmediate(r) }) }
var ago = function (ms) { return new Date(Date.now() - ms).toISOString() }
var cycle = async function (h) { await h.dispatch.poolCycle(SID); await flush() }

// ===== ①类：draft 父卡 + 拆解物化子卡（proposalOf）→ 回归锁推进 pending；手动草稿子卡不误触 =====
test('死胡同①：draft 父卡带物化子卡 → 推进 pending（decompose 边查表）；手动 parentId 草稿子卡不触发', async () => {
  var p1 = mkCard({ id: 'p1', status: 'draft', title: '物化父卡' })
  var c1 = mkCard({ id: 'c1', parentId: 'p1', status: 'draft', proposalOf: 'p1' })
  var p2 = mkCard({ id: 'p2', status: 'draft', title: '手动组装父卡' }) // Team 草稿组装：合法人工态
  var c2 = mkCard({ id: 'c2', parentId: 'p2', status: 'draft' })
  var h = mkDispatch(mkBoard([p1, c1, p2, c2]))
  await cycle(h)
  assert.equal(p1.status, 'pending', '物化父卡推一格 draft→pending（回归锁）')
  assert.equal(c1.status, 'draft', '子卡照旧 draft（确认发布归主窗口）')
  var last = p1.history[p1.history.length - 1]
  assert.ok(last && last.from === 'draft' && last.to === 'pending', 'history 留痕 draft→pending')
  assert.match(String(last.note || ''), /回归锁/, '留痕带回归锁口径')
  assert.equal(p2.status, 'draft', '手动草稿组装父卡不动（无 proposalOf=合法人工态）')
  assert.equal(c2.status, 'draft', '手动子卡不动')
  assert.deepEqual(h.notes, [], '①类自动推进不产生系统通知（ah 留痕即审计）')
})

// ===== ②类：pending 父卡 + 子卡全发布 + 非 direct → 首见宽限后 parentKick；宽限内/闸门未开不动 =====
test('死胡同②：pending 父卡子卡全发布 → 首见记时不动，宽限满后 parentKick 推 in-progress；子卡全落定顺手收口', async () => {
  var p = mkCard({ id: 'p2', status: 'pending', title: '钉死父卡', assignMode: 'manual' })
  var c1 = mkCard({ id: 's1', parentId: 'p2', status: 'pending', assignMode: 'manual' }) // manual 指派子卡：永不自动派发 → parentKick 永不触发的原形
  var c2 = mkCard({ id: 's2', parentId: 'p2', status: 'pending', assignMode: 'manual' })
  var h = mkDispatch(mkBoard([p, c1, c2]))
  await cycle(h)
  assert.equal(p.status, 'pending', '首见只记 pendingKickSince，不动状态（吞发布→派发瞬态）')
  assert.ok(p.pendingKickSince, '首见标记落卡')
  p.pendingKickSince = ago(130000) // 回拨持久标记跨过 120s 宽限（虚拟时钟推不动 Date.now，与挂死检测同款可测性）
  await cycle(h)
  assert.equal(p.status, 'in-progress', '宽限满 → parentKickOnDispatch 推 in-progress（既有推进点）')
  var last = p.history[p.history.length - 1]
  assert.ok(last && last.from === 'pending' && last.to === 'in-progress', 'history 走 parentKick 边')
  assert.match(String(last.note || ''), /首个子任务派发/, '复用 parentKickOnDispatch 原文案（不新写状态变更）')
  // 子卡全落定形态：kick 后没有未来 settle 事件 → 就地 maybeAutoCloseParent 收口
  var p3 = mkCard({ id: 'p3', status: 'pending', title: '落定父卡', assignMode: 'manual' })
  var s3 = mkCard({ id: 's3', parentId: 'p3', status: 'resolved' })
  var h3 = mkDispatch(mkBoard([p3, s3]))
  p3.pendingKickSince = ago(130000)
  await cycle(h3)
  assert.equal(p3.status, 'verifying', 'kick → 全子卡落定 → maybeAutoCloseParent 收口 verifying（full 管线）')
  assert.ok(p3.resolvedAt, '收口留 resolvedAt')
})

test('死胡同②反例：draft 子卡未全发布 / pre 闸门未开 / direct 父卡 / 活跃 run——一律不 kick 不记时', async () => {
  var pa = mkCard({ id: 'pa', status: 'pending', assignMode: 'manual' })
  var sa = mkCard({ id: 'sa', parentId: 'pa', status: 'draft' }) // 有 draft 子卡=未全发布
  var pb = mkCard({ id: 'pb', status: 'pending', assignMode: 'manual', hooks: { pre: { enabled: true, prompt: '准备', state: 'idle' } } })
  var sb = mkCard({ id: 'sb', parentId: 'pb', status: 'pending', assignMode: 'manual' }) // pre 闸门关着=串行等待
  var pc = mkCard({ id: 'pc', status: 'pending', pipeline: 'direct', assignMode: 'manual' })
  var sc = mkCard({ id: 'sc', parentId: 'pc', status: 'pending', assignMode: 'manual' }) // direct 父卡（规格排除）
  var pd = mkCard({ id: 'pd', status: 'pending', assignMode: 'manual' })
  var sd = mkCard({ id: 'sd', parentId: 'pd', status: 'pending', assignMode: 'manual' })
  var h = mkDispatch(mkBoard([pa, sa, pb, sb, pc, sc, pd, sd]))
  h.runs['pd'] = { id: 'r-dec', role: 'decomposer', taskId: 'pd', settled: false } // 拆解官在跑=有事在途
  await cycle(h)
  assert.equal(pa.status, 'pending'); assert.ok(!pa.pendingKickSince, 'draft 子卡在：不记时不 kick')
  assert.equal(pb.status, 'pending'); assert.ok(!pb.pendingKickSince, 'pre 闸门未开：串行等待不判死胡同')
  assert.equal(pc.status, 'pending'); assert.ok(!pc.pendingKickSince, 'direct 父卡规格排除')
  assert.equal(pd.status, 'pending'); assert.ok(!pd.pendingKickSince, '父卡有活跃 run（拆解官）：不判')
  assert.deepEqual(h.notes, [], '零通知')
})

// ===== ③类：叶卡 in-progress 无认领无活跃 run（僵尸）→ 2min 后复刻 isOrphan 回收回 pending =====
test('死胡同③：in-progress 僵尸叶卡（无 claimedBy 无 run）→ 回收 pending（reclaim 边）；有认领/有 run/容器卡不误收', async () => {
  var z = mkCard({ id: 'z1', status: 'in-progress', assignMode: 'manual', history: [{ from: 'pending', to: 'in-progress', timestamp: ago(130000), actor: 'system', note: '认领' }] })
  var keep1 = mkCard({ id: 'k-claim', status: 'in-progress', assignMode: 'manual', claimedBy: SID, claimedAt: ago(130000) }) // 主会话认领（isOrphan 豁免面）
  var keep2 = mkCard({ id: 'k-run', status: 'in-progress', assignMode: 'manual', claimedBy: 'run-x', claimedAt: ago(130000) }) // 活跃 run 盖着
  var keep3 = mkCard({ id: 'k-parent', status: 'in-progress', assignMode: 'manual' }) // 容器卡：父卡 in-progress 无认领=parentKick 正常形态
  var keep3c = mkCard({ id: 'k-parent-c', parentId: 'k-parent', status: 'pending', assignMode: 'manual' })
  var h = mkDispatch(mkBoard([z, keep1, keep2, keep3, keep3c]))
  h.runs['k-run'] = { id: 'run-x', role: 'worker', taskId: 'k-run', settled: false }
  await cycle(h)
  assert.equal(z.status, 'pending', '僵尸叶卡回收 pending（reclaim 边查表）')
  assert.equal(z.claimedBy, null); assert.equal(z.claimedAt, null, '认领位清干净')
  var last = z.history[z.history.length - 1]
  assert.ok(last && last.from === 'in-progress' && last.to === 'pending', 'history 走 reclaim 边')
  assert.equal(keep1.status, 'in-progress', '主会话认领卡不动（isOrphan 豁免面 + 本检测器都盖不到）')
  assert.equal(keep2.status, 'in-progress', '活跃 run 盖着不回收（归事件/超时通道）')
  assert.equal(keep3.status, 'in-progress', '容器卡不回收（收口归 maybeAutoCloseParent）')
  assert.deepEqual(h.notes, [], '③类自动推进零通知')
  // 宽限内不收：刚发生 in-progress 转移（history 时间戳新鲜）
  var fresh = mkCard({ id: 'z2', status: 'in-progress', assignMode: 'manual', history: [{ from: 'pending', to: 'in-progress', timestamp: ago(30000), actor: 'system', note: '认领' }] })
  var h2 = mkDispatch(mkBoard([fresh]))
  await cycle(h2)
  assert.equal(fresh.status, 'in-progress', '宽限 120s 未满不收（防误吃在途转移）')
})

// ===== ④类：verifying + post hook 卡 running 超 hardMin → 只 pushSysNote 上报，不自动推进 =====
test('死胡同④：verifying 父卡 post hook 卡死（running 超 hardMin 无活跃 run）→ 上报不动状态；节流 24h；有活跃 run 不报', async () => {
  var t = mkCard({ id: 'h4', status: 'verifying', title: '卡死收口父卡', assignMode: 'manual', resolvedAt: ago(130000),
    hooks: { post: { enabled: true, prompt: '收口', state: 'running' } }, verifierRun: 'run-old', verifierRunAt: ago(181 * 60000) }) // 181min > hardMin 120min
  var h = mkDispatch(mkBoard([t]))
  await cycle(h)
  assert.equal(h.notes.length, 1, '④只上报：产生一条系统通知')
  assert.match(h.notes[0].text, /死胡同检测/, '汇总通知头')
  assert.match(h.notes[0].text, /h4/, '带卡 id')
  assert.match(h.notes[0].text, /收口 hook 卡在 running 超 120 分钟/, '带判定口径（hardMin 默认 120min）')
  assert.match(h.notes[0].text, /人工裁决/, '带建议动作')
  assert.equal(h.notes[0].taskId, 'h4', '单条发现附 taskId（投递前过期校验用）')
  assert.equal(t.status, 'verifying', '不自动推进：状态原位')
  assert.equal(t.hooks.post.state, 'running', '不自动收口：hook 状态原位（需人裁决）')
  assert.ok(t.stuckNotedAt, '节流时间戳落卡')
  await cycle(h)
  assert.equal(h.notes.length, 1, '节流：24h 内同卡不重复上报（心跳 15s 一轮零刷屏）')
  // 活跃 run 盖着（verifier 正在同卡验收，recIsLive 存活形态：verifying + verifierRun 匹配 rec.id）→ 不报
  var t2 = mkCard({ id: 'h4b', status: 'verifying', assignMode: 'manual', resolvedAt: ago(130000),
    hooks: { post: { enabled: true, prompt: '收口', state: 'running' } }, verifierRun: 'run-2', verifierRunAt: ago(181 * 60000) })
  var h2 = mkDispatch(mkBoard([t2]))
  h2.runs['h4b'] = { id: 'run-2', role: 'verifier', taskId: 'h4b', settled: false }
  await cycle(h2)
  assert.deepEqual(h2.notes, [], '有活跃 run（Verifier 正在验收本卡）：busy 守卫不报')
  // 锚点新鲜（刚 spawn 不久）→ 不报
  var t3 = mkCard({ id: 'h4c', status: 'verifying', assignMode: 'manual', resolvedAt: ago(130000),
    hooks: { post: { enabled: true, prompt: '收口', state: 'running' } }, verifierRun: 'run-3', verifierRunAt: ago(60000) })
  var h3 = mkDispatch(mkBoard([t3]))
  await cycle(h3)
  assert.deepEqual(h3.notes, [], 'verifierRunAt 未超 hardMin：不报（宁少勿多）')
})

// ===== ⑤类（task-mwogc5nu 僵尸 Verifying 自动恢复）：阈值 24h→2h + ⑤a 立即检测自动重派 + 失败转 blocked =====
// ⑤b 超时上报（不可自动恢复形态——manual 指派归人工）：只上报；fresh/frozen/占位在途不报
test('死胡同⑤b：verifying 超 2h 无 Verifier run（不可自动恢复形态）→ 上报不动状态；新鲜/frozen/spawn-pending 不误报', async () => {
  var t = mkCard({ id: 'v5', status: 'verifying', title: '验收卡住卡', assignMode: 'manual', resolvedAt: ago(3 * 3600000) }) // 3h > 2h（manual 指派=不可自动重派形态，阈值 task-mwogc5nu 24h→2h）
  var h = mkDispatch(mkBoard([t]))
  await cycle(h)
  assert.equal(h.notes.length, 1, '⑤b 只上报：产生一条系统通知')
  assert.match(h.notes[0].text, /v5/, '带卡 id')
  assert.match(h.notes[0].text, /超 2h 无 Verifier run/, '带判定口径（2h 新阈值）')
  assert.match(h.notes[0].text, /board_verdict/, '带建议动作')
  assert.equal(t.status, 'verifying', '不自动推进：状态原位（验收归人）')
  assert.ok(!t.verifierRun, 'manual 指派卡不自动重派 Verifier（人意图优先，⑤a 分流排除）')
  assert.ok(t.stuckNotedAt, '节流时间戳落卡')
  var t2 = mkCard({ id: 'v5b', status: 'verifying', assignMode: 'manual', resolvedAt: ago(1 * 3600000) }) // 1h < 2h
  var t3 = mkCard({ id: 'v5c', status: 'verifying', assignMode: 'manual', resolvedAt: ago(3 * 3600000), frozen: true, frozenAt: ago(3 * 3600000) }) // 裁决挂起：有人裁决通道
  var t4 = mkCard({ id: 'v5d', status: 'verifying', assignMode: 'manual', resolvedAt: ago(3 * 3600000), verifierRun: 'spawn-pending', verifierRunAt: ago(30000) }) // 占位在途：归占位回收
  var h2 = mkDispatch(mkBoard([t2, t3, t4]))
  await cycle(h2)
  assert.deepEqual(h2.notes, [], '未满 2h / frozen（人裁决通道）/ spawn-pending（占位回收辖区）：一律不报')
  assert.equal(t3.status, 'verifying', 'frozen 不动')
})

// ===== ⑤a（task-mwogc5nu 断言②③）：verifying && verifierRun=null && 无活跃 run → 立即检测（不等 2h 阈值）+ 自动重派 Verifier =====
test('死胡同⑤a：僵尸验收（verifying 无 Verifier run 无活跃 run，过 2min 宽限）→ 立即检测并自动重派 Verifier（产生新 verifierRun）', async () => {
  var t = mkCard({ id: 'rv1', status: 'verifying', title: '僵尸验收卡', resolvedAt: ago(130000) }) // 130s > 120s 宽限；mkCard 缺省 assignMode=auto/pipeline=full = 可派形态
  var h = mkDispatch(mkBoard([t]))
  await cycle(h)
  assert.equal(t.status, 'verifying', '状态原位（重派的是 Verifier，不推进卡面状态）')
  assert.equal(t.verifierRun, 'run-x', '自动重派产生新 verifierRun（占位换真实 run id）')
  assert.ok(h.runs['rv1'] && h.runs['rv1'].role === 'verifier', '活跃 run 表登记 verifier rec（占验证位）')
  var last = t.history[t.history.length - 1]
  assert.match(String(last && last.note || ''), /僵尸验收立即检测/, '留痕带立即检测口径')
  assert.ok(String(h.board.dispatchInfo || '').indexOf('verify rv1') < 0, '主派发路径见占位/活跃 rec 即跳过（不双派）')
  assert.equal(h.notes.length, 1, '恢复回执一条')
  assert.match(h.notes[0].text, /僵尸验收自动恢复：已重新派发 Verifier（run run-x）/, '带新 run id 的恢复回执')
  // 幂等：下一轮 sweep（verifierRun 已是真实 id）不再命中 ⑤a，无重复重派
  await cycle(h)
  assert.equal(t.verifierRun, 'run-x', '幂等：已有 Verifier run 不再重派')
  assert.equal(h.notes.length, 1, '第二轮零新增通知')
})

test('死胡同⑤a 宽限防线：新鲜验收（< 2min）不判僵尸——正常派发路径同轮派上 Verifier（⑤a 零越权接管）', async () => {
  var t = mkCard({ id: 'rv2', status: 'verifying', title: '新鲜验收卡', resolvedAt: ago(30000) }) // 30s < 120s 宽限：resolve→下轮派发的正常瞬态
  var h = mkDispatch(mkBoard([t]))
  await cycle(h)
  assert.equal(t.verifierRun, 'run-x', '正常路径照常派发（非 ⑤a 接管）')
  assert.ok(String(h.board.dispatchInfo || '').indexOf('verify rv2') >= 0, 'dispatchInfo 走正常 verify 通道（⑤a 未抢）')
  assert.ok(!t.history.some(function (x) { return /僵尸验收/.test(String(x && x.note || '')) }), '零僵尸误判留痕')
  assert.deepEqual(h.notes, [], '正常派发零系统通知')
})

// ===== ⑤a 失败臂（task-mwogc5nu 断言③④）：自动重派 Verifier spawn 失败 → 转 blocked 挂明确原因（不再无限等待） =====
test('死胡同⑤a 失败臂：Verifier 重派 spawn 失败 → 转 blocked + escalation/lastError 明确原因；两跳链走表上既有边', async () => {
  var t = mkCard({ id: 'rv3', status: 'verifying', title: '恢复失败卡', resolvedAt: ago(130000) })
  var h = mkDispatch(mkBoard([t]), {
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { throw new Error('spawn 通道故障') }, // 两次尝试（外挂参数回退重试）都失败 → spawnOneShot 返回 null
    },
  })
  await cycle(h)
  assert.equal(t.status, 'blocked', '自动恢复失败 → 转 blocked（不再无限等待重试）')
  assert.ok(t.escalation && /僵尸验收自动恢复失败/.test(String(t.escalation.question)), 'escalation 挂明确原因（人工裁决入口）')
  assert.match(String(t.lastError || ''), /僵尸验收自动恢复失败/, 'lastError 落卡（详情页最近失败行）')
  assert.ok(!t.verifierRun, '占位清干净（不留死占位）')
  var hs = t.history
  assert.equal(hs[hs.length - 2].from, 'verifying', '两跳链第一跳起点 verifying')
  assert.equal(hs[hs.length - 2].to, 'in-progress', '两跳链第一跳走表上既有 verify-rejected 边')
  assert.equal(hs[hs.length - 1].from, 'in-progress', '两跳链第二跳起点 in-progress')
  assert.equal(hs[hs.length - 1].to, 'blocked', '两跳链第二跳走表上既有 blocked 边（与 settle 驳回×3 同款）')
  assert.equal(h.notes.length, 1, '失败回执一条')
  assert.match(h.notes[0].text, /僵尸验收自动恢复失败.*已转 blocked/, '失败回执带去向')
  // blocked 终局：下一轮 sweep 不再判 ⑤（blocked 在扫描排除面），无循环重试
  await cycle(h)
  assert.equal(t.status, 'blocked', 'blocked 即终局（人工接管），不再自动重派')
  assert.equal(h.notes.length, 1, '第二轮零新增通知（不无限循环）')
})

// ===== ⑤a 守卫：maxVerifiers=0 / 验证位全忙——不自动重派（尊重并发配置），归⑤b 超时口径 =====
test('死胡同⑤a 守卫：maxVerifiers=0（纯函数直调）与验证位全忙（活跃 ≥ maxVerifiers）不判僵尸不重派', async () => {
  var t0 = mkCard({ id: 'rv4', status: 'verifying', resolvedAt: ago(130000) })
  var out0 = sweepStuckCards(mkBoard([t0]), {}, Date.now(), { hardTimeoutMin: 120, maxVerifiers: 0 }) // c.maxVerifiers=0：⑤a 分流要求验证位有空
  assert.deepEqual(out0.reverify, [], 'maxV=0：不收集重派（配置语义优先，归⑤b 超时上报口径）')
  assert.equal(out0.changed, false, '零写盘')
  assert.ok(!t0.verifierRun, '占位不置')
  var other = mkCard({ id: 'rv5o', status: 'verifying', verifierRun: 'run-v9', resolvedAt: ago(3600000) }) // 别的卡在验收（占满唯一验证位）
  var t = mkCard({ id: 'rv5', status: 'verifying', resolvedAt: ago(130000) })
  var b = mkBoard([other, t]); b.maxVerifiers = 1
  var h = mkDispatch(b)
  h.runs['rv5o'] = { id: 'run-v9', role: 'verifier', taskId: 'rv5o', settled: false } // activeV=1 ≥ maxV=1
  await cycle(h)
  assert.ok(!t.verifierRun, '验证位全忙：不重派（不超并发上限，等正常派发轮转）')
  assert.equal(t.status, 'verifying', '状态原位')
  assert.deepEqual(h.notes, [], '零通知')
})

// ===== ⑥类（task-mwkb7djc）：pending + direct 父卡 + 子卡全落定 → 直接收口 resolved（②类盲区） =====
test('死胡同⑥：pending direct 父卡 + 子卡全落定 → 一轮直接收口 resolved（不经 verifying）；子卡未全落定不误动', async () => {
  // 实证形态 task-mwk0daqx：子卡手动建、父卡 draft 时子卡已派发，父卡后 publish 成 pending，
  // 子卡全落定后无任何未来事件够得到它（parentKick 要「首个子卡派发」时机且 direct 被②排除，
  // maybeAutoCloseParent 又要求父卡 in-progress）。
  var epic = mkCard({ id: 'e6', status: 'pending', pipeline: 'direct', title: '亲办容器史诗' })
  var e1 = mkCard({ id: 'e6-1', parentId: 'e6', status: 'resolved' })
  var e2 = mkCard({ id: 'e6-2', parentId: 'e6', status: 'cancelled' }) // 人主动取消=该子范围已了结
  var e3 = mkCard({ id: 'e6-3', parentId: 'e6', status: 'archived' })  // 归档=人的显式了结（同 isChildSettled 口径）
  var h = mkDispatch(mkBoard([epic, e1, e2, e3]))
  await cycle(h)
  assert.equal(epic.status, 'resolved', '⑥识别并直接收口 resolved（direct 不进派发池，verifying 够不到）')
  assert.ok(epic.resolvedAt, 'resolvedAt 落卡')
  assert.equal(epic.resolution, 'all subtasks resolved', '复用既有收口文案（maybeAutoCloseParent 原文案）')
  var last = epic.history[epic.history.length - 1]
  assert.ok(last && last.from === 'in-progress' && last.to === 'resolved', 'history 走既有 parentAuto 收口边')
  assert.match(String(last.note || ''), /direct 父卡直接收口/, '留痕口径=既有 direct 分支（不新写状态语义）')
  var kick = epic.history[epic.history.length - 2]
  assert.ok(kick && kick.from === 'pending' && kick.to === 'in-progress', '先走既有 parentKick 边（复用 parentKickOnDispatch）')
  assert.match(String(kick.note || ''), /首个子任务派发/, '复用 parentKickOnDispatch 原文案')
  assert.deepEqual(h.notes, [], '⑥自动收口零通知（ah 留痕即审计）')
  // 反例族：子卡未全落定（pending/draft/blocked）→ 不动、不记 pendingKickSince、不进 in-progress
  // （子卡 assignMode=manual：否则池派发该子卡会经 parentKick 把父卡推 in-progress，那是②类正常语义，
  //  与本类判定无关——本组只想看⑥分支自己动没动）
  var p = mkCard({ id: 'p6', status: 'pending', pipeline: 'direct' })
  var c1 = mkCard({ id: 'p6-1', parentId: 'p6', status: 'resolved' })
  var c2 = mkCard({ id: 'p6-2', parentId: 'p6', status: 'pending', assignMode: 'manual' })
  var c3 = mkCard({ id: 'p6-3', parentId: 'p6', status: 'draft' })
  var p2 = mkCard({ id: 'p6b', status: 'pending', pipeline: 'direct' })
  var b1 = mkCard({ id: 'p6b-1', parentId: 'p6b', status: 'blocked' }) // blocked=未了结（isChildSettled 口径）
  var p3 = mkCard({ id: 'p6c', status: 'pending', pipeline: 'direct' }) // 零子卡：空容器不判（无可了结集合）
  var h2 = mkDispatch(mkBoard([p, c1, c2, c3, p2, b1, p3]))
  await cycle(h2)
  assert.equal(p.status, 'pending', '子卡未全落定：direct 父卡原位不动（不误收口）')
  assert.ok(!p.pendingKickSince, 'direct 不参与②类首见记时（⑥是独立分支）')
  assert.equal(p2.status, 'pending', 'blocked 子卡不算了结：不收口')
  assert.equal(p3.status, 'pending', '零子卡 direct 父卡不判（无终态集可凑齐）')
  assert.deepEqual(h2.notes, [], '反例零通知')
})

test('死胡同⑥守卫与并集：busy/frozen/escalation 不收口；纯⑥死板预筛放行；非 direct 仍走②类', async () => {
  // 只有「pending direct 父卡 + 全落定子卡」的板：预筛必须放行——否则锁外就被过滤，⑥永远扫不到
  var only = mkCard({ id: 'o6', status: 'pending', pipeline: 'direct' })
  var oc = mkCard({ id: 'o6-1', parentId: 'o6', status: 'resolved' })
  var h = mkDispatch(mkBoard([only, oc]))
  await cycle(h)
  assert.equal(only.status, 'resolved', '预筛放行：纯 direct 死板也能被扫到并收口（本卡修法的另一半）')

  var bz = mkCard({ id: 'b6', status: 'pending', pipeline: 'direct' })
  var bzc = mkCard({ id: 'b6-1', parentId: 'b6', status: 'resolved' })
  var fz = mkCard({ id: 'f6', status: 'pending', pipeline: 'direct', frozen: true, frozenAt: ago(3600000) })
  var fzc = mkCard({ id: 'f6-1', parentId: 'f6', status: 'resolved' })
  var es = mkCard({ id: 'x6', status: 'pending', pipeline: 'direct', escalation: { question: '歧义待裁决' } })
  var esc = mkCard({ id: 'x6-1', parentId: 'x6', status: 'resolved' })
  var h2 = mkDispatch(mkBoard([bz, bzc, fz, fzc, es, esc]))
  h2.runs['b6'] = { id: 'run-b6', role: 'decomposer', taskId: 'b6', settled: false } // 活跃 run=有事在途
  await cycle(h2)
  assert.equal(bz.status, 'pending', '有活跃 run：不自动动卡（与②同款 busy 守卫）')
  assert.equal(fz.status, 'pending', 'frozen（裁决挂起）：不动，归人通道')
  assert.equal(es.status, 'pending', 'escalation（歧义待裁决）：不动，归人通道')
  assert.deepEqual(h2.notes, [], '守卫态零通知')

  // ③ 非 direct 父卡不受⑥影响：仍走②类（首见记时 → 宽限满 parentKick 推 in-progress → 全落定收口）
  var np = mkCard({ id: 'n6', status: 'pending', assignMode: 'manual' })
  var nc = mkCard({ id: 'n6-1', parentId: 'n6', status: 'resolved' })
  var h3 = mkDispatch(mkBoard([np, nc]))
  await cycle(h3)
  assert.equal(np.status, 'pending', '非 direct：首见只记时（②类口径，⑥不接管）')
  assert.ok(np.pendingKickSince, '②类首见标记落卡（⑥零干扰）')
  np.pendingKickSince = ago(130000)
  await cycle(h3)
  assert.equal(np.status, 'verifying', '②类宽限满 → parentKick → 全落定收口 verifying（非 direct 路径零变化）')
})

// ===== ⑥源码锁：分支/预筛支存在；maybeAutoCloseParent 的 in-progress 门槛零改动（边界纪律硬锁）=====
test('死胡同⑥源码锁：direct 收口分支 + 预筛 direct 支；maybeAutoCloseParent 门槛与 direct 分支原文未动', () => {
  const ds = srcOf('../lib/dispatch.mjs')
  assert.match(ds, /t\.pipeline === 'direct' && kids\.length > 0/, '⑥类分支存在（pending direct 父卡 + 子卡全落定）')
  assert.match(ds, /t\.pipeline === 'direct' && kids\.every\(function \(k\) \{ return core\.isChildSettled\(k\) \}\)/, '预筛补 direct 全落定支（否则锁外预筛即过滤掉，⑥扫不到）')
  assert.match(ds, /parentKickOnDispatch\(d, dchild\)/, '⑥复用既有推进点 parentKickOnDispatch（不新写状态语义）')
  assert.match(ds, /core\.maybeAutoCloseParent\(d, dchild\)/, '⑥复用既有收口点（core 限定引用：解构行被 core.test.mjs 源码锁死）')
  assert.match(ds, /t\.pipeline !== 'direct'/, '②类 non-direct 守卫原封未动（两分支并列不重叠）')
  const coreSrc = srcOf('../lib/core.mjs')
  assert.match(coreSrc, /if \(!p \|\| p\.status !== 'in-progress'\) return null/, '边界：maybeAutoCloseParent 的 in-progress 门槛零改动（正常 parentKick 链口径不动）')
  assert.match(coreSrc, /if \(p\.pipeline === 'direct'\) \{/, 'direct 直接 resolved 的既有分支原文（⑥消费的就是它）')
})

// ===== 五类同板一轮全识别（头条断言）：①②③推进 + ④⑤汇总上报，互不牵连 =====
test('死胡同总装：五类各构造一例，一轮 poolCycle 全识别——①②③自动推进、④⑤一条汇总通知且状态原位', async () => {
  var p1 = mkCard({ id: 'p1', status: 'draft' })
  var c1 = mkCard({ id: 'c1', parentId: 'p1', status: 'draft', proposalOf: 'p1' }) // ①物化残留
  var p2 = mkCard({ id: 'p2', status: 'pending', assignMode: 'manual' })
  p2.pendingKickSince = ago(130000)
  var c2 = mkCard({ id: 'c2', parentId: 'p2', status: 'pending', assignMode: 'manual' }) // ②钉死父卡
  var z = mkCard({ id: 'z1', status: 'in-progress', assignMode: 'manual', history: [{ from: 'pending', to: 'in-progress', timestamp: ago(130000), actor: 'system', note: '认领' }] }) // ③僵尸
  var h4 = mkCard({ id: 'h4', status: 'verifying', assignMode: 'manual', resolvedAt: ago(130000), hooks: { post: { enabled: true, prompt: '收口', state: 'running' } }, verifierRun: 'run-old', verifierRunAt: ago(181 * 60000) }) // ④hook 卡死
  var v5 = mkCard({ id: 'v5', status: 'verifying', assignMode: 'manual', resolvedAt: ago(25 * 3600000) }) // ⑤验收卡住
  var normal = mkCard({ id: 'nm', status: 'pending', assignMode: 'manual' }) // 正常待办卡：同板在场的对照组
  var h = mkDispatch(mkBoard([p1, c1, p2, c2, z, h4, v5, normal]))
  await cycle(h)
  assert.equal(p1.status, 'pending', '①识别并推进')
  assert.equal(p2.status, 'in-progress', '②识别并推进（parentKick）')
  assert.equal(z.status, 'pending', '③识别并回收')
  assert.equal(h4.status, 'verifying', '④识别但只上报（状态原位）')
  assert.equal(h4.hooks.post.state, 'running', '④不自动收口')
  assert.equal(v5.status, 'verifying', '⑤识别但只上报（状态原位）')
  assert.equal(normal.status, 'pending', '正常卡零牵连')
  assert.equal(h.notes.length, 1, '④⑤ 汇总为一条通知（不逐卡轰炸）')
  assert.match(h.notes[0].text, /2 张卡需人工裁决/, '汇总计数')
  assert.ok(h.notes[0].text.indexOf('h4') >= 0 && h.notes[0].text.indexOf('v5') >= 0, '两发现都在同一条汇总里')
  assert.equal(h.notes[0].taskId, undefined, '多发现汇总不附单卡 taskId')
})

// ===== 正常板不误报：Team 组装/瞬态/在跑/新鲜验收全在场 → 一轮零推进零通知 =====
test('死胡同误报防线：正常板（草稿组装/发布瞬态/主会话认领/在跑 run/新鲜验收）一轮零推进零通知', async () => {
  var asm = mkCard({ id: 'asm', status: 'draft' }) // Team 草稿组装（主窗口刻意保持 draft）
  var asmc = mkCard({ id: 'asmc', parentId: 'asm', status: 'draft' })
  var pub = mkCard({ id: 'pub', status: 'pending', assignMode: 'manual' }) // 发布瞬态：子卡全发布但宽限未满（parentKick 由下轮派发自然触发）
  var pubc = mkCard({ id: 'pubc', parentId: 'pub', status: 'pending', assignMode: 'manual' })
  var own = mkCard({ id: 'own', status: 'in-progress', assignMode: 'manual', claimedBy: SID, claimedAt: ago(130000) }) // 主会话认领
  var wrk = mkCard({ id: 'wrk', status: 'in-progress', claimedBy: 'run-x', claimedAt: ago(130000) }) // Worker 在跑
  var ver = mkCard({ id: 'ver', status: 'verifying', assignMode: 'manual', resolvedAt: ago(3600000), verifierRun: 'run-v', verifierRunAt: ago(3600000) }) // Verifier 在跑
  var fresh = mkCard({ id: 'fresh', status: 'verifying', assignMode: 'manual', resolvedAt: ago(3600000) }) // 新鲜验收 1h
  var h = mkDispatch(mkBoard([asm, asmc, pub, pubc, own, wrk, ver, fresh]))
  h.runs['wrk'] = { id: 'run-x', role: 'worker', taskId: 'wrk', settled: false }
  h.runs['ver'] = { id: 'run-v', role: 'verifier', taskId: 'ver', settled: false }
  await cycle(h)
  assert.equal(asm.status, 'draft', '草稿组装不动')
  assert.equal(pub.status, 'pending', '发布瞬态不动（首见记时，宽限 120s 内不 kick）')
  assert.ok(pub.pendingKickSince, '瞬态记时是检测簿记（非误报）')
  assert.equal(own.status, 'in-progress', '主会话认领不动')
  assert.equal(wrk.status, 'in-progress', '在跑 run 不动')
  assert.equal(ver.status, 'verifying', 'Verifier 在跑不动')
  assert.equal(fresh.status, 'verifying', '新鲜验收不动')
  assert.deepEqual(h.notes, [], '正常板零系统通知')
})

// ===== 源码级挂点/查表断言锁（与②六推进点同族：检测器推进点也全部接表）=====
test('死胡同源码锁：sweepStuckCards 纯函数 + poolCycleBody 挂点 + 推进点查表断言 + 常量化 + ⑤a 自动重派接线', () => {
  const ds = srcOf('../lib/dispatch.mjs')
  assert.match(ds, /import \{ assertTransition \} from '\.\/lifecycle\.mjs'/, 'dispatch 接表')
  assert.match(ds, /export function sweepStuckCards\(d, runs, now, c\)/, '检测器纯函数导出（锁内零 IO 形态）')
  assert.match(ds, /var STUCK_GRACE_MS = 120000/, '②③宽限 120s 常量化（对齐 2min 回收口径）')
  assert.match(ds, /var STUCK_VERIFY_MS = 7200000/, '⑤b 超时阈值 2h 常量化（task-mwogc5nu 24h→2h）')
  assert.match(ds, /var STUCK_NOTE_EVERY_MS = 86400000/, '④⑤b上报节流 24h 常量化')
  // ⑤a 僵尸验收自动恢复（task-mwogc5nu）：立即检测 + 占位收集 + 锁外重派 + 失败转 blocked 接线锁
  assert.match(ds, /now - vAt >= STUCK_GRACE_MS/, '⑤a 立即检测宽限复用②③ 2min 口径（不等 2h 阈值）')
  assert.match(ds, /out\.reverify\.push\(t\)/, '⑤a 僵尸验收收集重派清单（锁内置占位）')
  assert.match(ds, /await redispatchStuckVerifier\(sid, res\.reverify\[rvi\]\)/, '⑤a 锁外重派接线（stuckSweep 内逐张 spawn）')
  assert.match(ds, /rec = await spawnOneShot\(sid, t, 'verifier'\)/, '⑤a 重派走 spawnOneShot verifier 派发路径（与主派发同源）')
  assert.match(ds, /t2\.verifierRun = String\(rec\.id\)/, '⑤a 重派成功占位换真实 run id（产生新 verifierRun）')
  assert.match(ds, /assertTransition\(psV, 'in-progress', 'verify-rejected'\)/, '⑤a 失败臂走表上既有 verify-rejected 边（verifying→in-progress）')
  assert.match(ds, /assertTransition\(psB, 'blocked', 'blocked'\)/, '⑤a 失败臂走表上既有 blocked 边（in-progress→blocked 两跳链，不动转移表）')
  assert.match(ds, /t2\.escalation = \{ question: why, at: new Date\(\)\.toISOString\(\), by: 'system' \}/, '⑤a 失败臂 escalation 挂明确原因')
  assert.match(ds, /assertTransition\(ps0, 'pending', 'decompose'\)/, '①走表上既有 decompose 边（推进点查表）')
  assert.match(ds, /assertTransition\(ps1, 'pending', 'reclaim'\)/, '③走表上既有 reclaim 边（推进点查表）')
  assert.match(ds, /parentKickOnDispatch\(d, child\)/, '②调既有推进点 parentKickOnDispatch')
  assert.match(ds, /maybeAutoCloseParent\(d, child\)/, '②收口调既有推进点 maybeAutoCloseParent')
  assert.match(ds, /stuckN = await stuckSweep\(sid, runs, snap\)/, 'poolCycleBody 挂点（挂死检测之后）')
  assert.match(ds, /if \(stuckN > 0\) \{ try \{ snap = await rt\(sid\) \} catch \(_\) \{\} \}/, '推进后重读快照（与幽灵回收同款纪律）')
  assert.match(ds, /res = sweepStuckCards\(d, runs, Date\.now\(\), cfg\(d\)\)/, '锁内扫描（cfg 取锁内新鲜 d）')
  assert.match(ds, /return res\.changed \? d : null/, '零改动返回 null 不写盘（安静板纪律）')
  assert.match(ds, /死胡同检测：' \+ res\.findings\.length/, '④⑤汇总一条通知（不逐卡轰炸）')
})

// ====================================================================
// ①补全（task-mwk48jsw）：合法转移断言族——表上每条边的「初始状态+事件→终态」
// 前两层（表覆盖/六推进点/死胡同检测器）由子卡1/2 落地；本段补齐其余推进面：
//   A 面·core 纯函数推进点：archiveApply / cancelApply / applyHookSettle（第七推进点：
//     post 收口完成 in-progress→verifying）/ maybeAutoCloseParent 幂等早退 / resolve 兼容面
//   B 面·RPC 事件级（mock-ctx 真 index.mjs apply + 真 POST 路由）：publish / reset / batch-undo
//   C 面·settle/rpc/dispatch 写点源码锁：reclaim 族（驳回重派/终止/spawn 失败/裁决回池/isOrphan）
//     与 blocked×3、同态维持写点逐条配对表边（行为级由 integration 九场景+本文件 B 面双覆盖）
// ====================================================================
test('①补全A·归档族：resolved→archived / cancelled→archived / in-progress 僵尸→archived / 级联子卡 archive-cascade / 末子卡归档触发父卡收口', () => {
  var t1 = mkT({ status: 'resolved' })
  var r1 = core.archiveApply({ tasks: [t1] }, t1, 'main', 'archived')
  assert.equal(r1.ok, true)
  assert.equal(t1.status, 'archived', 'resolved --archive--> archived')
  assert.ok(t1.archivedAt, 'archivedAt 落卡')
  assert.equal(t1.history[t1.history.length - 1].from, 'resolved')
  assert.equal(t1.history[t1.history.length - 1].to, 'archived', 'history 走 archive 边')
  var t2 = mkT({ status: 'cancelled' })
  core.archiveApply({ tasks: [t2] }, t2, 'main', 'archived')
  assert.equal(t2.status, 'archived', 'cancelled --archive--> archived（B 组恢复边：归档门禁放行面含 cancelled）')
  var t3 = mkT({ status: 'in-progress' })
  core.archiveApply({ tasks: [t3] }, t3, 'main', 'archived')
  assert.equal(t3.status, 'archived', 'in-progress 僵尸 --archive--> archived（v1.7.1 放行面；活跃 run 门禁在 rpc 层）')
  // 级联：父卡归档级联未归档子卡（archive-cascade 边），已归档子卡幂等不动
  var p = mkT({ id: 'ca-p', status: 'resolved' })
  var c1 = mkT({ id: 'ca-c1', parentId: 'ca-p', status: 'pending' })
  var c2 = mkT({ id: 'ca-c2', parentId: 'ca-p', status: 'archived' })
  var r2 = core.archiveApply({ tasks: [p, c1, c2] }, p, 'main', 'archived')
  assert.equal(r2.childrenArchived, 1, '只级联未归档子卡')
  assert.equal(c1.status, 'archived', 'pending 子卡 --archive-cascade--> archived')
  assert.match(String(c1.history[c1.history.length - 1].note), /cascade/, '级联留痕')
  assert.equal(c2.status, 'archived', '已归档子卡幂等不动')
  // 末子卡归档触发父卡收口（isChildSettled 计入 archived：交错 resolve+archive 序列的收口保险）
  var pe = mkT({ id: 'ae-p', status: 'in-progress' })
  var k1 = mkT({ id: 'ae-c1', parentId: 'ae-p', status: 'resolved' })
  var k2 = mkT({ id: 'ae-c2', parentId: 'ae-p', status: 'resolved' })
  var r3 = core.archiveApply({ tasks: [pe, k1, k2] }, k2, 'main', 'archived')
  assert.equal(r3.parentUpdated, true, '归档路径触发父卡收口')
  assert.equal(pe.status, 'verifying', 'full 管线父卡收口 verifying')
  assert.ok(pe.resolvedAt, '收口留 resolvedAt')
})

test('①补全B·取消族：draft/pending/blocked --cancel--> cancelled + in-progress spawn-pending 占位（认领位回退）+ 取消子卡触发父卡收口', () => {
  var GATE = ['draft', 'pending', 'blocked'] // cancelGate 放行面（门禁在 rpc 层，core 落状态）
  for (var gi = 0; gi < GATE.length; gi++) {
    var t = mkT({ status: GATE[gi] })
    core.cancelApply({ tasks: [t] }, t, 'main', '放弃')
    assert.equal(t.status, 'cancelled', GATE[gi] + ' --cancel--> cancelled')
    assert.ok(t.cancelledAt, 'cancelledAt 落卡')
    assert.equal(t.resolvedAt, null, '取消清 resolvedAt')
    assert.equal(t.history[t.history.length - 1].from, GATE[gi])
    assert.equal(t.history[t.history.length - 1].to, 'cancelled', 'history 走 cancel 边')
  }
  // in-progress 仅 spawn-pending 派发占位态放行（真在跑须先 terminate）；占位取消清认领位不留死占位
  var sp = mkT({ status: 'in-progress', claimedBy: 'spawn-pending', claimedAt: '2026-01-01T00:00:00Z' })
  core.cancelApply({ tasks: [sp] }, sp, 'main', '取消占位')
  assert.equal(sp.status, 'cancelled', 'in-progress(spawn-pending 占位) --cancel--> cancelled')
  assert.equal(sp.claimedBy, null, '占位认领位清干净')
  assert.equal(sp.claimedAt, null)
  // 取消子卡触发父卡收口（isChildSettled 计入 cancelled——手动取消的子任务不把 epic 钉死）
  var pe = mkT({ id: 'cx-p', status: 'in-progress' })
  var k1 = mkT({ id: 'cx-c1', parentId: 'cx-p', status: 'resolved' })
  var k2 = mkT({ id: 'cx-c2', parentId: 'cx-p', status: 'pending' })
  var r = core.cancelApply({ tasks: [pe, k1, k2] }, k2, 'main', '放弃该子任务')
  assert.equal(r.parentUpdated, true, '取消路径触发父卡收口')
  assert.equal(pe.status, 'verifying', 'cancelled 计入终态集 → full 父卡收口')
})

test('①补全C·hook 结算族：pre 失败 pending→blocked（hook-failed 边）/ post 失败 in-progress→blocked / post 完成 in-progress→verifying（parentAuto 收口同款）/ pre 完成开闸零转移 / done 幂等', () => {
  // pre 失败：父卡尚在 pending（未到首个子卡派发）→ blocked 挂歧义等人裁决
  var p1 = mkT({ id: 'hk1', status: 'pending', hooks: { pre: { enabled: true, prompt: '准备', state: 'running', runId: 'r1' } } })
  var r1 = core.applyHookSettle({ tasks: [p1] }, 'hk1', 'pre', false, '', 'r1', '准备失败')
  assert.equal(r1.blocked, true)
  assert.equal(p1.status, 'blocked', 'pending --hook-failed--> blocked')
  assert.equal(p1.hooks.pre.state, 'failed')
  assert.ok(p1.escalation, '挂歧义等人裁决（重试/跳过/放弃）')
  assert.equal(p1.history[p1.history.length - 1].from, 'pending')
  assert.equal(p1.history[p1.history.length - 1].to, 'blocked', 'history 走 hook-failed 边')
  // post 失败：父卡 in-progress（post 闸门 running 延迟收口中）→ blocked
  var p2 = mkT({ id: 'hk2', status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: 'running', runId: 'r2', pending: true } } })
  var r2 = core.applyHookSettle({ tasks: [p2] }, 'hk2', 'post', false, '', 'r2', '收口失败')
  assert.equal(r2.blocked, true)
  assert.equal(p2.status, 'blocked', 'in-progress --blocked(hook run 失败)--> blocked')
  // post 完成：in-progress → verifying（applyHookSettle 收口完成，与 maybeAutoCloseParent 同边）
  var p3 = mkT({ id: 'hk3', status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: 'running', runId: 'r3', pending: true } } })
  var r3 = core.applyHookSettle({ tasks: [p3] }, 'hk3', 'post', true, '收口完成', 'r3')
  assert.equal(r3.closed, true)
  assert.equal(p3.status, 'verifying', 'in-progress --parentAuto(post 收口完成)--> verifying')
  assert.ok(p3.resolvedAt, '收口留 resolvedAt')
  assert.equal(p3.hooks.post.state, 'done')
  assert.equal(p3.history[p3.history.length - 1].from, 'in-progress')
  assert.equal(p3.history[p3.history.length - 1].to, 'verifying', 'history 走 parentAuto 边')
  // pre 完成：只开闸不动状态（同态审计）
  var p4 = mkT({ id: 'hk4', status: 'pending', hooks: { pre: { enabled: true, prompt: '准备', state: 'running', runId: 'r4' } } })
  var r4 = core.applyHookSettle({ tasks: [p4] }, 'hk4', 'pre', true, '完成', 'r4')
  assert.equal(r4.preDone, true)
  assert.equal(p4.status, 'pending', 'pre 完成只开闸：零转移')
  // 幂等：点位已 done，迟到失败不覆盖不改状态
  var r5 = core.applyHookSettle({ tasks: [p4] }, 'hk4', 'pre', false, '', 'r5', '迟到失败')
  assert.equal(r5.already, true, 'done 后幂等早退')
  assert.equal(p4.status, 'pending', '迟到失败零影响')
})

test('①补全D·parentAuto 幂等早退：verifying 父卡 maybeAutoCloseParent 返回 null 零写账（表上 verifying→verifying 维持边=无转移无留痕）', () => {
  var pe = mkT({ id: 'iv-p', status: 'verifying', resolvedAt: '2026-01-01T00:00:00Z' })
  var c = mkT({ id: 'iv-c', parentId: 'iv-p', status: 'resolved' })
  var hLen = pe.history.length
  var r = core.maybeAutoCloseParent({ tasks: [pe, c] }, c)
  assert.equal(r, null, '幂等早退：已 verifying 不重放')
  assert.equal(pe.status, 'verifying', '状态维持')
  assert.equal(pe.history.length, hLen, '早退零写账（「维持」= 无转移记录）')
})

test('①补全E·resolve 纯函数兼容面 + pending→resolved via 锁：跳级仅 work/强改面（resolve）登记，验收通道无边', () => {
  var t1 = mkT({ status: 'pending' })
  core.resolveApply({ tasks: [t1] }, t1, 'w', 'verifying', 'r')
  assert.equal(t1.status, 'verifying', 'pending --resolve--> verifying（B 组契约边；生产 RPC/结算通道均有 in-progress 门禁）')
  var t2 = mkT({ status: 'pending', pipeline: 'work' })
  core.resolveApply({ tasks: [t2] }, t2, 'w', 'verifying', 'r')
  assert.equal(t2.status, 'resolved', 'pending --resolve(work 强改)--> resolved（core.test.mjs 直调用例锁定面）')
  var e = lc.findTransition('pending', 'resolved')
  assert.ok(e, 'pending→resolved 边在表（B 组兼容面）')
  assert.deepEqual(e.via, ['resolve'], 'via 仅 resolve（work 强改面）——验收（verify）通道从 pending 出发零边，跳级拒绝见③补全')
})

test('①补全F·同态审计自环：八态 findTransition(s,s) 全命中（ah 留痕不转移，from===to 恒合法）', () => {
  for (var i = 0; i < lc.LIFECYCLE_STATES.length; i++) {
    var s = lc.LIFECYCLE_STATES[i]
    var e = lc.findTransition(s, s)
    assert.ok(e, s + ' 自环命中（同态留痕恒合法）')
    var w = lc.findTransition(s, s, 'audit-self')
    assert.ok(w && w.via.indexOf('audit-self') >= 0, s + ' 命中通配 audit-self 自环')
  }
})

// ===== ①补全 B 面：RPC 事件级（mock-ctx 真 index.mjs apply + 真 POST 路由）=====
// 初始状态用 patchBoard 构造，事件走用户真实入口（batch-op/update-task/batch-undo/
// resolve-task/verify-task），断言终态——比源码锁更强的行为级「初始状态+事件→终态」。
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

test('①补全G·publish 事件级：draft --batch-op publish--> pending（history 走 publish 边）；非草稿跳过附原因不熔断', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await env.rpc('create-task', { sessionId: env.sid, id: 'pb1', title: '草稿发布卡', description: '生命周期断言族用例' })
    await env.rpc('create-task', { sessionId: env.sid, id: 'pb2', title: '已发布卡', description: '生命周期断言族用例' })
    env.patchBoard(function (d) { d.tasks.find(function (x) { return x.id === 'pb1' }).status = 'draft' }) // 构造初始态 draft
    var r = await env.rpc('batch-op', { sessionId: env.sid, op: 'publish', ids: ['pb1', 'pb2'] })
    assert.equal(r.ok, true)
    assert.equal(r.done, 1, '仅草稿翻卡')
    assert.deepEqual(r.skipped, ['pb2'], '非草稿进 skipped')
    assert.match(String((r.reasons || {}).pb2), /仅草稿可发布/, '拒因落 reasons')
    var t = env.task('pb1')
    assert.equal(t.status, 'pending', 'draft --publish--> pending')
    var last = t.history[t.history.length - 1]
    assert.equal(last.from, 'draft')
    assert.equal(last.to, 'pending', 'history 走 publish 边')
    assert.match(String(last.note), /batch publish/)
  } finally { await env.cleanup() }
})

test('①补全H·reset 事件级：verifying/resolved/cancelled/archived/blocked --update-task resetToPending--> pending（reset 边无状态门禁）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    var states = ['verifying', 'resolved', 'cancelled', 'archived', 'blocked']
    for (var i = 0; i < states.length; i++) await env.rpc('create-task', { sessionId: env.sid, id: 'rs' + i, title: '复位卡' + i, description: '生命周期断言族用例' })
    env.patchBoard(function (d) {
      for (var i = 0; i < states.length; i++) {
        var t = d.tasks.find(function (x) { return x.id === 'rs' + i })
        t.status = states[i] // 构造初始态
        t.history = [{ from: 'pending', to: states[i], timestamp: '2026-01-01T00:00:00Z', actor: 'test', note: '构造初始态' }]
      }
    })
    for (var j = 0; j < states.length; j++) {
      var r = await env.rpc('update-task', { sessionId: env.sid, taskId: 'rs' + j, resetToPending: true })
      assert.equal(r.ok, true, states[j] + ' 复位 ok')
      var t = env.task('rs' + j)
      assert.equal(t.status, 'pending', states[j] + ' --reset--> pending')
      assert.equal(t.claimedBy, null, '认领位清干净')
      var last = t.history[t.history.length - 1]
      assert.equal(last.from, states[j], 'history 起点=复位前状态')
      assert.equal(last.to, 'pending', 'history 走 reset 边')
    }
  } finally { await env.cleanup() }
})

test('①补全I·batch-undo 事件级：archived --撤销批量归档--> resolved / cancelled（快照态恢复，终态汇可逆面）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await env.rpc('create-task', { sessionId: env.sid, id: 'bu1', title: '撤销归档卡一', description: '生命周期断言族用例' })
    await env.rpc('create-task', { sessionId: env.sid, id: 'bu2', title: '撤销归档卡二', description: '生命周期断言族用例' })
    env.patchBoard(function (d) {
      d.tasks.find(function (x) { return x.id === 'bu1' }).status = 'archived' // 构造初始态（快照态 resolved）
      d.tasks.find(function (x) { return x.id === 'bu2' }).status = 'archived' // 构造初始态（快照态 cancelled）
    })
    var r = await env.rpc('batch-undo', { sessionId: env.sid, snapshot: { op: 'archive', items: [
      { id: 'bu1', priority: 'medium', status: 'resolved' },
      { id: 'bu2', priority: 'medium', status: 'cancelled' },
    ] } })
    assert.equal(r.ok, true)
    assert.equal(r.done, 2)
    assert.deepEqual(r.skipped, [])
    var t1 = env.task('bu1')
    assert.equal(t1.status, 'resolved', 'archived --batch-undo--> resolved')
    assert.ok(!t1.archivedAt, '归档时间戳撤净')
    assert.equal(t1.history[t1.history.length - 1].from, 'archived')
    assert.equal(t1.history[t1.history.length - 1].to, 'resolved', 'history 走 batch-undo 边')
    var t2 = env.task('bu2')
    assert.equal(t2.status, 'cancelled', 'archived --batch-undo--> cancelled')
  } finally { await env.cleanup() }
})

// ===== ①补全 C 面：settle/rpc/dispatch 侧推进点源码锁（与②六推进点同族）=====
// 六推进点之外的状态写点全部在 settle/rpc/dispatch 三文件：每条写点锁「源码在位 +
// (from,to) 在表上」——新增写点绕表即在本族红灯（行为级由 integration 套件九场景 +
// 本文件 B 面事件级双重覆盖，这里补的是写点↔表边的配对完整性）。
test('①补全J·reclaim 族写点锁：in-progress→pending 全部写点（驳回重派/失败重排/手动终止/spawn 失败/裁决回池/isOrphan 回收）逐条配对表边', () => {
  const ss = srcOf('../lib/settle.mjs')
  const rs = srcOf('../lib/rpc.mjs')
  const ds = srcOf('../lib/dispatch.mjs')
  assert.match(ss, /ah\(t, 'in-progress', 'pending', 'system', '驳回重派：新 Worker 将携带驳回原因继续'\)/, '驳回重派第二跳（verify-rejected 落 in-progress 后回池）')
  assert.match(ss, /ah\(t, ps2, 'pending', String\(rec\.id\), 'worker 失败（/, 'worker 失败 <3 重排')
  assert.match(rs, /ah\(t, ps, 'pending', actor, '手动终止，任务重新排队'\)/, '手动终止回池')
  assert.match(rs, /ah\(t2, 'in-progress', 'pending', 'system', 'spawn 失败'\)/, 'spawn 失败回退（rpc 工具通道）')
  assert.match(rs, /act === 'hold' \? '带裁决挂起冻结（不参与自动派发）' : '带裁决重新排队'/, '裁决回池（resume/hold 双态）')
  assert.match(ds, /ah\(t, 'in-progress', 'pending', 'system', '执行 run 已结束\/丢失，回收重新排队'\)/, 'isOrphan 孤儿回收')
  assert.match(ds, /t\.claimedBy === 'spawn-pending'\) \{ t\.status = 'pending'/, 'spawn 失败占位回退（dispatch 侧）')
  assert.ok(lc.findTransition('in-progress', 'pending'), '(in-progress, pending) 在表（reclaim 族）')
})

test('①补全K·blocked 与同态维持写点锁：×3 挂起（worker/verifier 双通道）+ escalate/审查重试同态留痕，逐条配对表边', () => {
  const ss = srcOf('../lib/settle.mjs')
  const rs = srcOf('../lib/rpc.mjs')
  assert.match(ss, /ah\(t, ps, 'blocked', String\(rec\.id\), 'worker 失败 x/, 'worker 失败×3 挂起（settle）')
  assert.match(ss, /ah\(t, 'in-progress', 'blocked', 'system', 'worker 失败 x/, '野跑 worker 失败×3 挂起')
  assert.match(ss, /ah\(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x/, 'verifier 驳回×3 挂起（settle）')
  assert.match(rs, /ah\(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x/, 'verifier 驳回×3 挂起（board_verdict 工具通道）')
  assert.match(ss, /ah\(t, 'in-progress', 'in-progress', String\(rec\.id\), 'worker 上报歧义（文本通道），待主窗口裁决'\)/, 'escalate 同态维持')
  assert.match(ss, /ah\(t, 'verifying', 'verifying', 'system', 'verifier 未给出有效结论，重新排队审查 \('/, 'verifier 审查重试同态维持')
  assert.match(ss, /ah\(t, 'verifying', 'verifying', 'system', 'verifier 野跑超硬超时，重新排队审查 \('/, '野跑审查重试同态维持')
  assert.match(rs, /ah\(t, 'verifying', 'verifying', actor, '手动终止审查，等待新 verifier 接手'\)/, '手动终止审查同态维持（换 verifier 不换状态）')
  assert.ok(lc.findTransition('in-progress', 'blocked'), '(in-progress, blocked) 在表（blocked 边）')
  assert.ok(lc.findTransition('in-progress', 'in-progress'), '(in-progress, in-progress) 在表（escalate 自环）')
  assert.ok(lc.findTransition('verifying', 'verifying'), '(verifying, verifying) 在表（审查重试自环）')
})

// ===== ③补全（task-mwk48jsw）：非法转移拒绝扩充 + 验收通道跳级拒绝 =====
// 三层收口：非法 (from,to) 配对逐条拒（表级）+ 验收通道唯一入口（via 级）+
// 边界门禁（事件级：resolve/verify 双通道前置状态闸——pending 卡直落 resolved 被系统边界拒绝）。
// 注意 pending→resolved 的表级现实：B 组兼容面登记了 resolve（work 强改面）边（①补全E 已锁
// via 仅 ['resolve']）；「跳过 verifying」的验收路径在表上零边（本段 via 级锁）+ RPC 门禁拒（事件级锁）。
const ILLEGAL_MORE = [
  ['draft', 'blocked', '草稿无 run 不挂阻塞（blocked 只从执行态/挂起面进入）'],
  ['cancelled', 'resolved', '取消卡不可直接复活为已验收'],
  ['resolved', 'cancelled', '已验收不可取消（终态收口走归档）'],
  ['verifying', 'cancelled', '验收中不可取消（先裁决/终止再动）'],
  ['blocked', 'resolved', '阻塞卡不可直接跳验收完成（先复工再走 resolve）'],
  ['archived', 'blocked', '归档终态不可再挂起'],
]
test('③补全·非法转移扩充：六对终态/跳级配对被查表拒绝', () => {
  for (const [f, t, why] of ILLEGAL_MORE) {
    assert.equal(lc.findTransition(f, t), null, '不该有边: ' + f + ' → ' + t + '（' + why + '）')
    assert.throws(() => lc.assertTransition(f, t, 'test'), /非法状态转移/, '应抛错: ' + f + ' → ' + t)
  }
})

test('③补全·验收通道唯一入口：to=resolved 且 via 带 verify 标签的边必须从 verifying 出发（pending/in-progress 跳级 approval 无边）', () => {
  for (const e of lc.LIFECYCLE_TRANSITIONS) {
    if (e.to !== 'resolved') continue
    for (const v of e.via) {
      if (String(v).indexOf('verify') !== 0) continue // 只查 verify* 系事件（verify-approved 等）
      var fs = Array.isArray(e.from) ? e.from : [e.from]
      for (const f of fs) assert.equal(f, 'verifying', 'verify 系事件只许从 verifying 出发: ' + f + ' → resolved（via ' + v + '）跳级')
    }
  }
})

test('③补全·边界门禁事件级：pending 卡 resolve-task 拒（not in-progress）/ verify-task 拒（not verifying）——跳级直落 resolved 被系统边界拒绝', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await env.rpc('create-task', { sessionId: env.sid, id: 'gk1', title: '跳级卡', description: '生命周期断言族用例' }) // 初始态 pending
    var r1 = await env.rpc('resolve-task', { sessionId: env.sid, taskId: 'gk1', status: 'verifying', resolution: '跳级' })
    assert.equal(r1.ok, false, 'pending 卡不经执行直提验证：拒')
    assert.match(String(r1.error), /not in-progress/)
    var r2 = await env.rpc('verify-task', { sessionId: env.sid, taskId: 'gk1', verdict: 'approved' })
    assert.equal(r2.ok, false, 'pending 卡跳过 verifying 直落 resolved：拒')
    assert.match(String(r2.error), /not verifying/)
    assert.equal(env.task('gk1').status, 'pending', '两次跳级尝试状态零漂移')
  } finally { await env.cleanup() }
})
