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

// ===== 死胡同检测器 sweepStuckCards（task-mwk481xj）：五类「应推进但没推进」形态 =====
// 断言族：①五类各构造一例 → 全部识别 ②可自动推进的（①②③）被正确推进 ③只上报的（④⑤）产生
// pushSysNote 且不自动改状态 ④正常卡不误报 ⑤源码级挂点/查表断言锁。直调纯函数 + 薄桩 poolCycle
//（mkGateDispatch 同款形态：真跑 createDispatch.poolCycle，stub 掉 IO/计时器）双面覆盖。
import { createDispatch } from '../lib/dispatch.mjs'

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

// ===== ⑤类：verifying 超 24h 无 verifierRun → 只上报；fresh/frozen/占位在途不报 =====
test('死胡同⑤：verifying 超 24h 无 Verifier run → 上报不动状态；新鲜/frozen/spawn-pending 不误报', async () => {
  var t = mkCard({ id: 'v5', status: 'verifying', title: '验收卡住卡', assignMode: 'manual', resolvedAt: ago(25 * 3600000) }) // 25h > 24h
  var h = mkDispatch(mkBoard([t]))
  await cycle(h)
  assert.equal(h.notes.length, 1, '⑤只上报：产生一条系统通知')
  assert.match(h.notes[0].text, /v5/, '带卡 id')
  assert.match(h.notes[0].text, /超 24h 无 Verifier run/, '带判定口径')
  assert.match(h.notes[0].text, /board_verdict/, '带建议动作')
  assert.equal(t.status, 'verifying', '不自动推进：状态原位（验收归人）')
  assert.ok(t.stuckNotedAt, '节流时间戳落卡')
  var t2 = mkCard({ id: 'v5b', status: 'verifying', assignMode: 'manual', resolvedAt: ago(20 * 3600000) }) // 20h < 24h
  var t3 = mkCard({ id: 'v5c', status: 'verifying', assignMode: 'manual', resolvedAt: ago(25 * 3600000), frozen: true, frozenAt: ago(25 * 3600000) }) // 裁决挂起：有人裁决通道
  var t4 = mkCard({ id: 'v5d', status: 'verifying', assignMode: 'manual', resolvedAt: ago(25 * 3600000), verifierRun: 'spawn-pending', verifierRunAt: ago(30000) }) // 占位在途：归占位回收
  var h2 = mkDispatch(mkBoard([t2, t3, t4]))
  await cycle(h2)
  assert.deepEqual(h2.notes, [], '未满 24h / frozen（人裁决通道）/ spawn-pending（占位回收辖区）：一律不报')
  assert.equal(t3.status, 'verifying', 'frozen 不动')
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
test('死胡同源码锁：sweepStuckCards 纯函数 + poolCycleBody 挂点 + 推进点查表断言 + 常量化', () => {
  const ds = srcOf('../lib/dispatch.mjs')
  assert.match(ds, /import \{ assertTransition \} from '\.\/lifecycle\.mjs'/, 'dispatch 接表')
  assert.match(ds, /export function sweepStuckCards\(d, runs, now, c\)/, '检测器纯函数导出（锁内零 IO 形态）')
  assert.match(ds, /var STUCK_GRACE_MS = 120000/, '②③宽限 120s 常量化（对齐 2min 回收口径）')
  assert.match(ds, /var STUCK_VERIFY_MS = 86400000/, '⑤ 24h 阈值常量化')
  assert.match(ds, /var STUCK_NOTE_EVERY_MS = 86400000/, '④⑤上报节流 24h 常量化')
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
