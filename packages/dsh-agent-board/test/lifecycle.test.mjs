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
