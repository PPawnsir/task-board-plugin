// dsh-agent-board 纯逻辑单元测试 — node --test packages/dsh-agent-board/test/
// 覆盖：状态机流转 / 依赖校验与环检测 / 管线分类 / 输出解析 / prompt 构建 / 派发决策 / 孤儿回收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import * as core from '../lib/core.mjs'
// 粒度治理（软闸门）住在 lib/policy.mjs（策略层，纯函数）、usage 聚合住在 lib/usage.mjs，
// 均由 index.mjs 薄壳 re-export（对外契约不变），这里仍从 index.mjs 导入直接断言
import { suggestSplitOf, withSplitHint, SUGGEST_SPLIT_TEXT, TASK_SIZE_CONTRACT, TEAM_SPLIT_RULE, splitRuleOf } from '../index.mjs'
import { aggregateUsageSummary, readRunUsage, findRunLog, effectiveTokens, taskEffectiveTokens } from '../index.mjs'
import { createRpc } from '../lib/rpc.mjs'
// no-root 刷屏根治（task-muuf0o7a）专项：会话层幻影板防线 + 派发层 root 闸门直调断言
import { createSession, isFullSessionId } from '../lib/session.mjs'
import { createDispatch } from '../lib/dispatch.mjs'
import { createNotify } from '../lib/notify.mjs'
// host 端源码拼接（Phase 2 模块化后：薄壳 index.mjs + lib/*.mjs 领域模块），供源码级接线断言
const HOST_SOURCES = ['../index.mjs', '../lib/policy.mjs', '../lib/usage.mjs', '../lib/session.mjs', '../lib/store.mjs', '../lib/notify.mjs', '../lib/dispatch.mjs', '../lib/rpc.mjs']
function hostSrc() { return HOST_SOURCES.map(function (f) { return readFileSync(new URL(f, import.meta.url), 'utf8') }).join('\n') }

function mkTask(over) { return Object.assign({ id: 't1', title: 'T', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null, history: [], messages: [] }, over || {}) }
function mkBoard(tasks) { return { version: 11, ownerSession: 's1', boardMode: 'auto', tasks: tasks || [] } }

// ===== 状态机 =====
test('claimApply: pending → in-progress，记 history', () => {
  const t = mkTask(); const d = mkBoard([t])
  core.claimApply(d, t, 'actor1', 'test')
  assert.equal(t.status, 'in-progress'); assert.equal(t.claimedBy, 'actor1')
  assert.equal(t.history.length, 1); assert.equal(t.history[0].to, 'in-progress')
})

test('claimCheck: 非可认领状态拒绝', () => {
  const t = mkTask({ status: 'verifying' }); const d = mkBoard([t])
  assert.match(core.claimCheck(d, t, 'a'), /cannot claim/)
})

test('claimCheck: 已被他人认领拒绝（in-progress 首先被 CLAIMABLE 拦住）', () => {
  const t = mkTask({ status: 'in-progress', claimedBy: 'other' }); const d = mkBoard([t])
  assert.match(core.claimCheck(d, t, 'a'), /cannot claim/) // CLAIMABLE 只含 pending/blocked，in-progress 先被拦
  // claimedBy 分支的实际生效场景：blocked 状态被他人认领后重派
  const t2 = mkTask({ status: 'blocked', claimedBy: 'other' }); const d2 = mkBoard([t2])
  assert.equal(core.claimCheck(d2, t2, 'a'), null) // blocked 可重派（claimedBy 分支只在 in-progress 才有意义）
})

test('claimCheck: 手动模式+指定 assignee 拒绝他人', () => {
  const t = mkTask({ assignMode: 'manual', assignee: 'bob' }); const d = mkBoard([t])
  assert.match(core.claimCheck(d, t, 'alice'), /assigned to bob/)
  assert.equal(core.claimCheck(d, t, 'bob'), null)
})

test('claimCheck: 超过 MAX_CLAIMED 拒绝', () => {
  const mine = [1, 2, 3].map(i => mkTask({ id: 'm' + i, status: 'in-progress', claimedBy: 'me' }))
  const t = mkTask({ id: 'new' }); const d = mkBoard(mine.concat([t]))
  assert.match(core.claimCheck(d, t, 'me'), /max 3 active/)
})

test('resolveApply: full 档 → verifying；work/direct 档 → 直接 resolved', () => {
  const tf = mkTask({ pipeline: 'full' }); core.resolveApply(mkBoard([tf]), tf, 'w', 'verifying', 'done')
  assert.equal(tf.status, 'verifying')
  const tw = mkTask({ pipeline: 'work' }); core.resolveApply(mkBoard([tw]), tw, 'w', 'verifying', 'done')
  assert.equal(tw.status, 'resolved')
})

test('verifyApply: approved → resolved；rejected → 回 in-progress', () => {
  const t = mkTask({ status: 'verifying' }); core.verifyApply(mkBoard([t]), t, 'v', 'approved', 'ok')
  assert.equal(t.status, 'resolved'); assert.ok(t.verifiedAt)
  const t2 = mkTask({ status: 'verifying' }); core.verifyApply(mkBoard([t2]), t2, 'v', 'rejected', 'bad')
  assert.equal(t2.status, 'in-progress'); assert.equal(t2.resolution, null)
})

test('子任务全 resolved → 父任务自动 verifying', () => {
  const p = mkTask({ id: 'p', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'p', status: 'verifying' })
  const c2 = mkTask({ id: 'c2', parentId: 'p', status: 'resolved' })
  const d = mkBoard([p, c1, c2])
  const r = core.verifyApply(d, c1, 'v', 'approved')
  assert.equal(r.parentUpdated, true); assert.equal(p.status, 'verifying')
})

// ===== 史诗自动收口补漏（task-muuoduri）：work 管线子任务也要收口 =====
// 实证 bug：resolveApply 先把非 full 管线的 status 由 verifying 改写成 resolved，
// 旧的父卡检查绑在 `status === 'verifying'` 分支上 → work 档子任务（无 Verifier）永不触发父卡收口，
// epic 永久卡 in-progress。修法：判定抽成共享 helper maybeAutoCloseParent，resolveApply 落定后无条件调用。
test('史诗收口①：work 管线子任务 resolve → 父卡自动转 verifying（核心回归）', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' }) // epic 父卡（pipeline=direct，不下池）
  const c = mkTask({ id: 'c1', parentId: 'epic', status: 'in-progress', pipeline: 'work' })
  const d = mkBoard([p, c])
  const r = core.resolveApply(d, c, 'w', 'verifying', 'done')
  assert.equal(c.status, 'resolved')       // work 档：resolve 即落 resolved（无 Verifier）
  assert.equal(r.parentUpdated, true)      // 父卡收口被触发（旧实现此处为 undefined → 永久卡死）
  assert.equal(p.status, 'verifying')
  assert.equal(p.resolution, 'all subtasks resolved')
  assert.equal(p.history[p.history.length - 1].actor, 'system')
})

test('史诗收口②：full 档子任务 verify approved 收口仍然成立（既有防回归）', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c = mkTask({ id: 'c1', parentId: 'epic', status: 'verifying', pipeline: 'full' })
  const d = mkBoard([p, c])
  const r = core.verifyApply(d, c, 'v', 'approved', 'ok')
  assert.equal(r.parentUpdated, true)
  assert.equal(p.status, 'verifying')
})

test('史诗收口③：cancelled 子任务计入终态完成集 → 父卡也能收口', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  const c2 = mkTask({ id: 'c2', parentId: 'epic', status: 'cancelled' })
  const c3 = mkTask({ id: 'c3', parentId: 'epic', status: 'in-progress', pipeline: 'work' })
  const d = mkBoard([p, c1, c2, c3])
  assert.equal(core.isChildSettled(c1), true)
  assert.equal(core.isChildSettled(c2), true)  // 人主动取消 = 该子任务范围已了结
  assert.equal(core.isChildSettled(c3), false)
  assert.equal(core.isChildSettled(mkTask({ status: 'archived' })), true) // 归档=人的显式了结，计入终态集（反馈 n-muw706h1uymy 根修：交错归档不再卡死父卡）
  const r = core.resolveApply(d, c3, 'w', 'verifying', 'done')
  assert.equal(r.parentUpdated, true)
  assert.equal(p.status, 'verifying')
})

test('史诗收口④：仍有 pending/in-progress 子任务 → 不收口', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'epic', status: 'in-progress', pipeline: 'work' })
  const c2 = mkTask({ id: 'c2', parentId: 'epic', status: 'pending' })
  const d = mkBoard([p, c1, c2])
  const r = core.resolveApply(d, c1, 'w', 'verifying', 'done')
  assert.equal(c1.status, 'resolved')
  assert.equal('parentUpdated' in r, false)
  assert.equal(p.status, 'in-progress') // 未被误收口
})

test('史诗收口⑤：父卡已 verifying/resolved → 幂等不重复触发（无副作用）', () => {
  const c = mkTask({ id: 'c1', parentId: 'epic', status: 'in-progress', pipeline: 'work' })
  const pv = mkTask({ id: 'epic', status: 'verifying' })
  const dv = mkBoard([pv, c])
  assert.equal(core.maybeAutoCloseParent(dv, c), null)
  assert.equal(pv.history.length, 0) // 无 history 追加 = 零副作用
  const pr = mkTask({ id: 'epic', status: 'resolved' })
  const dr = mkBoard([pr, c])
  assert.equal(core.maybeAutoCloseParent(dr, c), null)
  assert.equal(pr.history.length, 0)
  // 无 parentId（顶层任务）与父卡不存在 → 一律 null
  assert.equal(core.maybeAutoCloseParent(mkBoard([mkTask({ id: 'lonely' })]), mkTask({ id: 'lonely' })), null)
  assert.equal(core.maybeAutoCloseParent(mkBoard([c]), c), null) // 父卡不在板上（悬空引用）
})

test('史诗收口⑥：checkParentAuto 兼容名委托共享 helper（单一判定口径）', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  const d = mkBoard([p, c])
  const got = core.checkParentAuto(d, c)
  assert.equal(got, p)
  assert.equal(p.status, 'verifying')
  assert.equal(p.resolution, 'all subtasks resolved') // 口径文案统一（旧 resolveApply 分支的 'all subtasks done' 已退役）
})

// ===== 史诗自动收口漏触发根修（task-mux3uvx3，反馈 n-muw706h1uymy，2026-10-06 实证）=====
// 实证根因（repro 脚本逐条复现，嫌疑点逐个排除）：
//   ① isChildSettled 旧口径不含 archived——「resolve 一张归档一张」的交错序列下，末子卡 resolve
//      时兄卡已归档，`s.every(isChildSettled)` 永远凑不齐（resolveApply/verifyApply 的父卡钩子
//      其实都跑了，是口径让它哑火）；
//   ② archive 路径（task_archive 工具 / archive-task RPC）旧实现为内联代码，从不调用父卡检查——
//      末子卡归档这一下补不上收口（僵尸子卡直接出清链路更是一直缺这钩子）。
// 嫌疑排除：settleVerifier→verifyApply 路径的父卡钩子（checkParentAuto）一直在，非挂点。
// 修法：isChildSettled 计入 archived（与 childStats 进度口径同源）+ archiveApply 共享 helper
// （归档落定唯一入口）尾部挂 maybeAutoCloseParent。
test('史诗收口⑦：交错 resolve+archive 序列——末子卡 resolve 时兄卡已归档也能收口（根因复现①）', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'epic', status: 'in-progress', pipeline: 'work' })
  const c2 = mkTask({ id: 'c2', parentId: 'epic', status: 'in-progress', pipeline: 'work' })
  const c3 = mkTask({ id: 'c3', parentId: 'epic', status: 'in-progress', pipeline: 'work' })
  const d = mkBoard([p, c1, c2, c3])
  core.resolveApply(d, c1, 'w', 'verifying', 'done'); core.archiveApply(d, c1, 'tester')
  assert.equal(c1.status, 'archived')
  assert.equal(p.status, 'in-progress') // 未凑齐不收口（c2/c3 仍在跑）
  core.resolveApply(d, c2, 'w', 'verifying', 'done'); core.archiveApply(d, c2, 'tester')
  assert.equal(p.status, 'in-progress')
  const r = core.resolveApply(d, c3, 'w', 'verifying', 'done') // 此刻 c1/c2 已 archived
  assert.equal(r.parentUpdated, true)  // 旧口径此处为 undefined → epic 永久卡死
  assert.equal(p.status, 'verifying')
  assert.equal(p.resolution, 'all subtasks resolved')
})

test('史诗收口⑧：archiveApply 归档路径本身触发父卡检查——末子卡归档即收口（根因复现②，僵尸出清链路）', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  const c2 = mkTask({ id: 'c2', parentId: 'epic', status: 'in-progress', claimedBy: null })
  const d = mkBoard([p, c1, c2])
  const r = core.archiveApply(d, c2, 'tester') // c2 从僵尸 in-progress 直接归档（v1.7.1 archiveErr 放行面）
  assert.equal(c2.status, 'archived'); assert.ok(c2.archivedAt)
  assert.equal(r.parentUpdated, true)  // 归档这一下补齐收口（旧实现无父卡钩子）
  assert.equal(p.status, 'verifying')
  assert.equal(p.resolution, 'all subtasks resolved')
  // 顶层卡归档（无 parentId）不触父卡检查、返回体无 parentUpdated
  const solo = mkTask({ id: 'solo', status: 'resolved' })
  const r2 = core.archiveApply(mkBoard([solo]), solo, 'tester')
  assert.equal(solo.status, 'archived'); assert.equal('parentUpdated' in r2, false)
})

test('史诗收口⑨：archiveApply 级联归档父卡不误触收口 + history/note 口径保持', () => {
  // 父卡归档 → 级联子卡；父卡自身无 parentId（maybeAutoCloseParent 第一闸门拦），
  // 级联子卡也不做父卡检查（父卡已 archived 非 in-progress，检查也必返回 null）——零意外流转
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  const c2 = mkTask({ id: 'c2', parentId: 'epic', status: 'in-progress', claimedBy: null })
  const d = mkBoard([p, c1, c2])
  const r = core.archiveApply(d, p, 'tester', 'manual archive')
  assert.equal(p.status, 'archived')
  assert.equal(r.childrenArchived, 2)
  assert.equal(c1.status, 'archived'); assert.equal(c2.status, 'archived')
  assert.equal('parentUpdated' in r, false)
  assert.equal(p.history[0].note, 'manual archive') // note 参数透传（RPC 'manual archive' / 工具 'archived'）
  assert.equal(c2.history[c2.history.length - 1].note, 'cascade')
})

test('史诗收口⑩：post hook 未收口的 epic 走归档路径同样只挂闸门不转 verifying（hooks 语义不变）', () => {
  const epi = mkTask({ id: 'epic', status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: 'idle' } } })
  const c1 = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  const c2 = mkTask({ id: 'c2', parentId: 'epic', status: 'resolved' })
  const d = mkBoard([epi, c1, c2])
  const r = core.archiveApply(d, c2, 'tester') // 末子卡归档触发父卡检查
  assert.equal(r.parentUpdated, true)          // 检查跑了（返回父卡）
  assert.equal(epi.status, 'in-progress')      // 但不直接转 verifying——post 闸门照旧
  assert.equal(epi.hooks.post.pending, true)
  assert.equal(epi.hooks.post.state, 'running')
  assert.equal(epi.resolution, undefined)
  // post 已 done 的 epic：归档路径正常收口（与 resolve/verify 路径同口径）
  const e2 = mkTask({ id: 'e2', status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: 'done' } } })
  const k1 = mkTask({ id: 'k1', parentId: 'e2', status: 'archived' })
  const k2 = mkTask({ id: 'k2', parentId: 'e2', status: 'resolved' })
  const d2 = mkBoard([e2, k1, k2])
  const r2 = core.archiveApply(d2, k2, 'tester')
  assert.equal(r2.parentUpdated, true)
  assert.equal(e2.status, 'verifying')
})

// ===== 依赖 =====
test('validateDeps: 自引用/不存在/成环 全拒绝', () => {
  const a = mkTask({ id: 'a' }); const b = mkTask({ id: 'b', dependsOn: ['a'] })
  const d = mkBoard([a, b])
  assert.match(core.validateDeps(d, 'a', ['a']), /self-dependency/)
  assert.match(core.validateDeps(d, 'a', ['ghost']), /not found/)
  // a 依赖 b，b 已依赖 a → 成环
  const d2 = mkBoard([mkTask({ id: 'a', dependsOn: ['b'] }), mkTask({ id: 'b', dependsOn: ['a'] })])
  assert.match(core.validateDeps(d2, 'a', ['b']), /circular/)
})

test('depsSatisfied: resolved/archived 算满足，其余不算', () => {
  const dep = mkTask({ id: 'dep', status: 'resolved' })
  const t = mkTask({ dependsOn: ['dep'] }); const d = mkBoard([dep, t])
  assert.equal(core.depsSatisfied(d, t), true)
  dep.status = 'in-progress'
  assert.equal(core.depsSatisfied(d, t), false)
  dep.status = 'archived'
  assert.equal(core.depsSatisfied(d, t), true)
})

test('depsCancelled: 依赖被取消 → true', () => {
  const dep = mkTask({ id: 'dep', status: 'cancelled' })
  const t = mkTask({ dependsOn: ['dep'] })
  assert.equal(core.depsCancelled(mkBoard([dep, t]), t), true)
})

// ===== 管线分类 =====
test('classifyPipeline: 验收脚本→full；问答→direct；文档→work；兜底 full', () => {
  assert.equal(core.classifyPipeline(mkTask({ acceptance: 'npm test' })), 'full')
  assert.equal(core.classifyPipeline(mkTask({ title: '解释一下这个函数' })), 'direct')
  assert.equal(core.classifyPipeline(mkTask({ title: '整理 API 文档' })), 'work')
  assert.equal(core.classifyPipeline(mkTask({ title: '实现登录功能' })), 'full')
})

// ===== 输出解析 =====
test('parseSections: 分段解析', () => {
  const out = core.parseSections('前言\n## 开发描述\n做了 A\n## 改动清单\n改了 x.js\n## 自测情况\nnpm test pass')
  assert.equal(out.summary, '做了 A'); assert.equal(out.changes, '改了 x.js'); assert.equal(out.selfTest, 'npm test pass')
  assert.deepEqual(core.parseSections(''), {})
  assert.deepEqual(core.parseSections('没有分段的纯文本'), {})
})

test('cfg: 两级超时默认值/夹取/hard≥soft（软超时只提醒，硬超时兜底）', () => {
  assert.equal(core.cfg({}).softTimeoutMin, 30)
  assert.equal(core.cfg({}).hardTimeoutMin, 120)
  assert.equal(core.cfg({ softTimeoutMin: 45, hardTimeoutMin: 240 }).softTimeoutMin, 45)
  assert.equal(core.cfg({ softTimeoutMin: 0 }).softTimeoutMin, 30) // 0 → 默认
  assert.equal(core.cfg({ softTimeoutMin: 9999 }).softTimeoutMin, 480) // 上限夹取
  assert.equal(core.cfg({ hardTimeoutMin: 99999 }).hardTimeoutMin, 1440)
  // hard 不得低于 soft，避免硬超时早于软提醒触发
  assert.equal(core.cfg({ softTimeoutMin: 300, hardTimeoutMin: 60 }).hardTimeoutMin, 300)
})

test('seed: 新看板自带两级超时默认值', () => {
  const s = core.seed('session-x')
  assert.equal(s.softTimeoutMin, 30)
  assert.equal(s.hardTimeoutMin, 120)
})

test('parseSections: diff 概要分段解析（Worker 变更概要 → deliverable.diff）', () => {
  const s = core.parseSections('## 开发描述\n做了\n## diff 概要\n gen.py | 3 + ++')
  assert.equal(s.diff, 'gen.py | 3 + ++')
  assert.equal(s.summary, '做了')
})

// ===== Verifier 自测指南（verifyUserGuide，task-muxyyvg0）：契约解析 / 开关门禁 / 落账 =====
test('自测指南①：parseSections 收「## 自测指南」段 → userTest 四字段 + tier 三档', () => {
  // ui 档：四字段齐全（编号列表 steps）
  const s1 = core.parseSections('## 验证概要\n通过\n\n## 自测指南\ngist: 看板卡片加了徽章\ntier: ui\nsteps:\n1. 打开看板面板\n2. 看卡片标题右侧\nexpect: 应看到绿色徽章')
  assert.ok(s1.userTest, '自测指南段必须解析出 userTest')
  assert.equal(s1.userTest.gist, '看板卡片加了徽章')
  assert.equal(s1.userTest.tier, 'ui')
  assert.deepEqual(s1.userTest.steps, ['打开看板面板', '看卡片标题右侧'])
  assert.equal(s1.userTest.expect, '应看到绿色徽章')
  // metric 档 + 横杠列表 + 全角冒号
  const s2 = core.parseSections('## 自测指南\ngist： Token 区多了主窗口行\ntier：metric\nsteps:\n- 打开仪表盘\n- 看 Token 区\nexpect: 出现「主窗口（本会话）」行')
  assert.equal(s2.userTest.tier, 'metric')
  assert.deepEqual(s2.userTest.steps, ['打开仪表盘', '看 Token 区'])
  // internal 档：steps 可空，expect 写「验证靠测试套件」
  const s3 = core.parseSections('## 自测指南\ngist: host 聚合口径修正\ntier: internal\nexpect: 验证靠测试套件')
  assert.equal(s3.userTest.tier, 'internal')
  assert.deepEqual(s3.userTest.steps, [])
  // tier 非法/脏值 → 归 internal（最保守档，不伪造用户可感知面）
  const s4 = core.parseSections('## 自测指南\ngist: x\ntier: 界面级\nexpect: y')
  assert.equal(s4.userTest.tier, 'internal')
  // 「## 自测情况」（Worker 段）不串进 userTest；「## 自测指南」不串进 selfTest（标题口径隔离）
  const s5 = core.parseSections('## 自测情况\nnpm test pass')
  assert.equal(s5.selfTest, 'npm test pass'); assert.equal(s5.userTest, undefined)
  const s6 = core.parseSections('## 自测指南\ngist: g\ntier: ui\nexpect: e')
  assert.equal(s6.selfTest, undefined); assert.ok(s6.userTest)
  // 缺段 → 字段不挂
  assert.equal(core.parseSections('## 验证概要\n通过').userTest, undefined)
  // 段体四字段全空 → 不挂字段（视为没交指南）
  assert.equal(core.parseSections('## 自测指南\n（无）').userTest, undefined)
})

test('自测指南②：normalizeUserTest 归一（非对象/空指南→null；tier 归档；长度封顶）', () => {
  assert.equal(core.normalizeUserTest(null), null)
  assert.equal(core.normalizeUserTest('ui'), null)
  assert.equal(core.normalizeUserTest({}), null) // 空指南不落
  assert.equal(core.normalizeUserTest({ gist: '   ', steps: [], expect: '' }), null)
  const ut = core.normalizeUserTest({ gist: ' 改了 x ', steps: [' 第一步 ', '', null, '第二步'], expect: ' 看到 y ', tier: 'UI' })
  assert.deepEqual(ut, { gist: '改了 x', steps: ['第一步', '第二步'], expect: '看到 y', tier: 'ui' })
  assert.equal(core.normalizeUserTest({ gist: 'g', tier: 'ui（界面可操作）' }).tier, 'ui') // tier 取首词
  assert.equal(core.normalizeUserTest({ gist: 'g', tier: 'bogus' }).tier, 'internal') // 非法归 internal
  assert.equal(core.normalizeUserTest({ gist: 'g' }).tier, 'internal') // 缺省归 internal
  // 封顶：gist ≤300 / expect ≤600 / steps ≤12 条每条 ≤300
  const big = core.normalizeUserTest({ gist: 'g'.repeat(400), expect: 'e'.repeat(700), steps: Array(20).fill('s'.repeat(400)) })
  assert.equal(big.gist.length, 300); assert.equal(big.expect.length, 600)
  assert.equal(big.steps.length, 12); assert.equal(big.steps[0].length, 300)
})

test('自测指南③：buildVerifierPrompt 开关门禁——默认含指南段+诚实护栏；显式 false 整段消失', () => {
  const t = mkTask({ id: 'tx', status: 'verifying' })
  const on = core.buildVerifierPrompt(t, '')
  assert.match(on, /## 自测指南/)                    // 指南段在 prompt 里
  assert.match(on, /gist: <一句人话/)                // 四字段格式
  assert.match(on, /tier: ui \| metric \| internal/) // 三档分级
  assert.match(on, /诚实护栏/)                       // 诚实护栏写进 prompt
  assert.match(on, /不许编造没验过的操作/)
  assert.match(on, /验证靠测试套件/)                 // internal 档口径
  assert.match(on, /userTest 参数/)                  // 工具通道说明
  assert.ok(on.indexOf('结论契约') < on.indexOf('自测指南（给用户看的验收指引'), '指南段追加在 prompt 末尾（结论契约之后）')
  const off = core.buildVerifierPrompt(t, '', false) // 开关关 → 整段不进 prompt（省 token）
  assert.doesNotMatch(off, /自测指南/)
  assert.doesNotMatch(off, /userTest/)
  assert.match(off, /结论契约/) // 其余契约逐字不变
  assert.equal(core.buildVerifierPrompt(t, ''), on) // 缺省第三参 = 开
})

test('自测指南④：文本结算落账——开关开 userTest 落 t.verification；开关关不挂字段（端到端真 settle）', async () => {
  const GUIDE = '\n\n## 自测指南\ngist: 卡片加了徽章\ntier: ui\nsteps:\n1. 打开看板\n2. 看徽章\nexpect: 看到绿徽章'
  async function waitVerification(t) { // 与 waitRej 同口径：轮询等 settle 链尾，防固定 sleep 抖动
    var t0 = Date.now()
    while (Date.now() - t0 < 2000) { if (t.verification && t.status === 'resolved') return true; await new Promise(function (r) { setTimeout(r, 5) }) }
    return !!(t.verification && t.status === 'resolved')
  }
  // 开关开（缺省）：APPROVED + 指南段 → userTest 落 t.verification
  const t1 = mkTask({ id: 'ug1', status: 'verifying' })
  const h1 = mkVerifierSettleDispatch(mkBoard([t1]))
  await h1.dispatch.poolCycle(FULL_SID)
  h1.settle('APPROVED\n\n## 验证概要\n复跑通过' + GUIDE)
  assert.equal(await waitVerification(t1), true)
  assert.deepEqual(t1.verification.userTest, { gist: '卡片加了徽章', steps: ['打开看板', '看徽章'], expect: '看到绿徽章', tier: 'ui' })
  // 开关关：输出即使带指南段也不挂字段（省 token 口径的落账侧门禁）
  const t2 = mkTask({ id: 'ug2', status: 'verifying' })
  const board2 = mkBoard([t2]); board2.verifyUserGuide = false
  const h2 = mkVerifierSettleDispatch(board2)
  await h2.dispatch.poolCycle(FULL_SID)
  h2.settle('APPROVED\n\n## 验证概要\n复跑通过' + GUIDE)
  assert.equal(await waitVerification(t2), true)
  assert.equal(t2.verification.userTest, undefined, '开关关 → 落账不挂 userTest')
  // 开关开但缺段 → 不挂字段
  const t3 = mkTask({ id: 'ug3', status: 'verifying' })
  const h3 = mkVerifierSettleDispatch(mkBoard([t3]))
  await h3.dispatch.poolCycle(FULL_SID)
  h3.settle('APPROVED\n\n## 验证概要\n复跑通过')
  assert.equal(await waitVerification(t3), true)
  assert.equal(t3.verification.userTest, undefined, '缺段 → 不挂 userTest')
})

test('自测指南⑤：board_verdict 工具通道——userTest 参数落账 + 开关门禁 + 非法 tier 归 internal', async () => {
  const UT = { gist: '报告多了自测清单', steps: ['打开仪表盘', '点生成报告'], expect: '报告含「本版自测清单」段', tier: 'ui' }
  const b1 = mkBoard([mkTask({ id: 'g1', status: 'verifying' })])
  const r1 = await mkRpcHandlers(b1).__tools['board_verdict'].execute({ taskId: 'g1', verdict: 'approved', summary: '通过', userTest: UT }, {})
  assert.equal(r1.ok, true)
  assert.deepEqual(b1.tasks[0].verification.userTest, UT, '工具通道 userTest 原样落账（归一后）')
  // 开关关：参数带了也不挂字段
  const b2 = mkBoard([mkTask({ id: 'g2', status: 'verifying' })]); b2.verifyUserGuide = false
  await mkRpcHandlers(b2).__tools['board_verdict'].execute({ taskId: 'g2', verdict: 'approved', summary: '通过', userTest: UT }, {})
  assert.equal(b2.tasks[0].verification.userTest, undefined, '开关关 → 工具通道也不挂 userTest')
  // 非法 tier 归 internal；空指南（全空字段）不落
  const b3 = mkBoard([mkTask({ id: 'g3', status: 'verifying' })])
  await mkRpcHandlers(b3).__tools['board_verdict'].execute({ taskId: 'g3', verdict: 'approved', summary: '通过', userTest: { gist: '内部重构', tier: ' bogus ', expect: '验证靠测试套件' } }, {})
  assert.equal(b3.tasks[0].verification.userTest.tier, 'internal')
  const b4 = mkBoard([mkTask({ id: 'g4', status: 'verifying' })])
  await mkRpcHandlers(b4).__tools['board_verdict'].execute({ taskId: 'g4', verdict: 'approved', summary: '通过', userTest: { gist: '  ', steps: [] } }, {})
  assert.equal(b4.tasks[0].verification.userTest, undefined, '空指南不落字段')
})

test('自测指南⑥：cfg/seed/normalizeBoard 三处默认开——老看板缺字段补 true，显式 false 才关', () => {
  assert.equal(core.cfg({}).verifyUserGuide, true)            // 缺省开
  assert.equal(core.cfg({ verifyUserGuide: false }).verifyUserGuide, false)
  assert.equal(core.cfg({ verifyUserGuide: 0 }).verifyUserGuide, true) // 脏值非 false → 开（!== false 口径）
  assert.equal(core.seed('s-x').verifyUserGuide, true)        // 新板种子自带
  const old = { poolStatus: { workers: [], verifiers: [] }, tasks: [] } // 老看板无字段
  core.normalizeBoard(old)
  assert.equal(old.verifyUserGuide, true)                     // 读路径补 true
  const off = { verifyUserGuide: false, tasks: [] }
  core.normalizeBoard(off)
  assert.equal(off.verifyUserGuide, false)                    // 显式 false 不被覆盖
})


test('parseVerdict: 行首锚定，历史提及不误判', () => {
  assert.equal(core.parseVerdict('APPROVED: 通过'), 'APPROVED')
  assert.equal(core.parseVerdict('REJECTED: 不达标'), 'REJECTED')
  assert.equal(core.parseVerdict('> APPROVED\n引用块里的也算'), 'APPROVED') // 引用块前缀允许
  assert.equal(core.parseVerdict('上次被 REJECTED 了，这次我觉得行'), null) // 非行首锚定 → 不误判
  assert.equal(core.parseVerdict(''), null)
})

test('isEscalation: [ESCALATE] 标记', () => {
  assert.equal(core.isEscalation('[ESCALATE] 缺少需求'), true)
  assert.equal(core.isEscalation('正常完成'), false)
})

test('outputText: ContentBlock[] 提取文本', () => {
  assert.equal(core.outputText({ output: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(core.outputText(null), '')
  assert.equal(core.outputText({}), '')
})

// ===== prompt 构建 =====
test('buildWorkerPrompt: 注入 taskId/描述/验收脚本/过程记录', () => {
  const t = mkTask({ id: 'tx', description: '做个功能', acceptance: 'npm test', history: [{ note: '驳回: 缺测试', timestamp: '2026-01-01' }] })
  const p = core.buildWorkerPrompt(t)
  assert.match(p, /taskId: tx/); assert.match(p, /做个功能/); assert.match(p, /npm test/); assert.match(p, /驳回: 缺测试/); assert.match(p, /board_report/)
})

test('buildWorkerPrompt: 不自动注入 context.files/docs（由主窗口写入 description）', () => {
  const t = mkTask({ id: 'ctx', context: { instructions: '看 README', files: ['src/x.js'], docs: ['设计文档'], relatedTasks: ['task-a'], prerequisites: 'Node 22+' } })
  const p = core.buildWorkerPrompt(t)
  assert.match(p, /看 README/)          // instructions 注入（主窗口写的指引）
  assert.doesNotMatch(p, /src\/x\.js/)  // files 不自动注入
  assert.doesNotMatch(p, /设计文档/)    // docs 不自动注入
  assert.doesNotMatch(p, /task-a/)      // relatedTasks 不自动注入
  assert.doesNotMatch(p, /Node 22/)     // prerequisites 不自动注入
})

test('buildWorkerPrompt: 注入 messages（裁决答案/干预指令/歧义原文——系统管理的生命周期记录）', () => {
  const t = mkTask({ id: 'msg', messages: [{ kind: 'arbitration', text: '用方案B', at: '2026-01-01', by: 'main' }, { kind: 'intervention', text: '注意边界', at: '2026-01-02', by: 'main' }] })
  const p = core.buildWorkerPrompt(t)
  assert.match(p, /用方案B/); assert.match(p, /注意边界/); assert.match(p, /arbitration/); assert.match(p, /intervention/)
})

test('buildVerifierPrompt: 注入交付物 + 验收脚本 + messages', () => {
  const t = mkTask({ id: 'tx', acceptance: 'npm test', deliverable: { summary: '做完了', changes: 'x.js', selfTest: 'pass' }, messages: [{ kind: 'arbitration', text: '方案B', at: '2026-01-01', by: 'main' }] })
  const p = core.buildVerifierPrompt(t)
  assert.match(p, /做完了/); assert.match(p, /npm test/); assert.match(p, /board_verdict/); assert.match(p, /方案B/)
})

test('buildWorkerPrompt: git 纪律红线（禁还原命令）注入，verifier prompt 不注入（源码断言）', () => {
  const t = mkTask({ id: 'g1' })
  const p = core.buildWorkerPrompt(t)
  assert.match(p, /git 纪律红线/)
  assert.match(p, /禁止 git checkout \/ git restore \/ git reset --hard \/ git clean 等还原命令/)
  assert.match(p, /会冲掉并行 Worker 与你自己的未提交在途编辑/)
  assert.match(p, /确实需要干净基线时用 board_report（kind=escalate）上报/)
  // verifier prompt 不动
  const pv = core.buildVerifierPrompt(t)
  assert.doesNotMatch(pv, /git 纪律红线/)
  assert.doesNotMatch(pv, /reset --hard/)
  // 源码级：条款只在 buildWorkerPrompt 体内（切片边界到 buildVerifierPrompt 之前），不在 buildVerifierPrompt 体内
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  const wBody = coreSrc.slice(coreSrc.indexOf('export function buildWorkerPrompt'), coreSrc.indexOf('export function buildVerifierPrompt'))
  assert.ok(wBody.length > 500, 'buildWorkerPrompt 切片成功')
  assert.match(wBody, /git 纪律红线/)
  assert.match(wBody, /git reset --hard/)
  const vBody = coreSrc.slice(coreSrc.indexOf('export function buildVerifierPrompt'), coreSrc.indexOf('export function buildHookPrompt'))
  assert.doesNotMatch(vBody, /git 纪律红线/)
})

// ===== 预研上下文段（瘦身分离形态，task-muvjs392）：笔记全文 + 文件清单，不含文件内容本体 =====
// 形态：### 主窗口调研笔记（全文 ≤8000 字符）\n…\n\n### 调研文件清单（- 路径:L起-L止 — 一句用途）
test('buildContextPackSection: 空清单返回空串', () => {
  assert.equal(core.buildContextPackSection([]), '')
  assert.equal(core.buildContextPackSection(null), '')
  assert.equal(core.buildContextPackSection(undefined), '')
})

test('parseContextFileEntry: 路径/锚点归一 + 可选「 — 一句用途」', () => {
  assert.deepEqual(core.parseContextFileEntry('src/a.js'), { path: 'src/a.js', file: 'src/a.js', usage: '' })
  assert.deepEqual(core.parseContextFileEntry('src/a.js:L2350-L2420'), { path: 'src/a.js:L2350-L2420', file: 'src/a.js', usage: '' })
  // 第二段 L 可省略 → 归一成 :L10-L20（清单里给 Worker 的行号形态统一）
  assert.deepEqual(core.parseContextFileEntry('src/a.js:L10-20'), { path: 'src/a.js:L10-L20', file: 'src/a.js', usage: '' })
  // 「 — 一句用途」（em dash 两侧空格）：用途与路径/锚点一起剥出来
  assert.deepEqual(core.parseContextFileEntry('lib/x.mjs:L112-L116 — 派发引擎锚点行段'), { path: 'lib/x.mjs:L112-L116', file: 'lib/x.mjs', usage: '派发引擎锚点行段' })
  assert.deepEqual(core.parseContextFileEntry('docs/a.md — 设计文档'), { path: 'docs/a.md', file: 'docs/a.md', usage: '设计文档' })
  // Windows 盘符 + 锚点 + 用途共存
  assert.deepEqual(core.parseContextFileEntry('C:\\w\\a.js:L100-L200 — 入口'), { path: 'C:\\w\\a.js:L100-L200', file: 'C:\\w\\a.js', usage: '入口' })
  // 非法锚点剥掉（不误导子代理去读空段）；空串安全
  assert.deepEqual(core.parseContextFileEntry('a.js:L0'), { path: 'a.js', file: 'a.js', usage: '' })
  assert.deepEqual(core.parseContextFileEntry(''), { path: '', file: '', usage: '' })
})

test('buildContextPackSection: 文件清单行（路径+行号+用途），不含内容本体', () => {
  const s = core.buildContextPackSection([
    { path: 'src/a.ts:L1-L40', usage: '状态机主循环' },
    { path: 'docs/b.md' },
  ])
  assert.match(s, /调研文件清单/); assert.match(s, /不要全量盲读/)
  assert.match(s, /- src\/a\.ts:L1-L40 — 状态机主循环/)
  assert.match(s, /- docs\/b\.md/)              // 无用途 → 只给路径行号
  // 条目上的老字段（content/truncated/meta/outline）一律不再被消费：正文绝不进清单
  const s2 = core.buildContextPackSection([
    { path: 'src/big.js:L2350-L2420', usage: '目标段', content: 'const LEGACY_BODY = 1', truncated: true, meta: '锚点行段：共 3800 行，已注入 L2350–L2420', outline: ['L12: export function foo()'] },
  ])
  assert.match(s2, /- src\/big\.js:L2350-L2420 — 目标段/)
  assert.doesNotMatch(s2, /LEGACY_BODY/)        // 文件内容本体不进 prompt
  assert.doesNotMatch(s2, /结构索引/)           // 不再附结构索引块
  assert.doesNotMatch(s2, /锚点行段：共 3800 行/) // 不再有读盘产出的 meta
})

test('buildContextPackSection: 裸字符串条目兼容（老调用方零改）+ 清单与笔记同现', () => {
  const s = core.buildContextPackSection(['src/x.js'], '结论：先改 A 再改 B')
  assert.match(s, /- src\/x\.js/)
  assert.match(s, /主窗口调研笔记/); assert.match(s, /结论：先改 A 再改 B/)
})

test('buildWorkerPrompt/buildVerifierPrompt: 预研清单进 prompt（笔记全文 + 清单行，不含文件内容本体）', () => {
  const pack = core.buildContextPackSection(
    [{ path: 'lib/core.mjs:L100-L140', usage: '清单组装与锚点归一', content: 'export function buildContextPackSection(files, notes) {' }],
    '根因：调研包随快照每轮重发 6×48.8K 字符'
  )
  const t = mkTask({ id: 'pk' })
  const pw = core.buildWorkerPrompt(t, pack)
  assert.match(pw, /### 主窗口调研笔记/); assert.match(pw, /根因：调研包随快照每轮重发 6×48\.8K 字符/)  // 笔记全文
  assert.match(pw, /- lib\/core\.mjs:L100-L140 — 清单组装与锚点归一/)                                 // 清单行（含行号+用途）
  assert.match(pw, /按需用 read 工具自行读取/)                                                       // 自取指引
  assert.doesNotMatch(pw, /export function buildContextPackSection/)                                 // 文件内容本体不在 prompt
  const pv = core.buildVerifierPrompt(t, pack)
  assert.match(pv, /- lib\/core\.mjs:L100-L140 — 清单组装与锚点归一/)
  assert.doesNotMatch(pv, /export function buildContextPackSection/)
  // 不传 pack 时不出现该段（无清单 parity：与注入迁移前逐字同形）
  assert.doesNotMatch(core.buildWorkerPrompt(t), /调研文件清单/)
  assert.doesNotMatch(core.buildVerifierPrompt(t), /调研文件清单/)
  assert.doesNotMatch(core.buildWorkerPrompt(t), /主窗口调研笔记/)
})

test('buildContextPackSection: {{ }} 插值净化（严格插值时代遗留口径，封闭变换）', () => {
  const s = core.buildContextPackSection([{ path: 'src/tpl.vue' }], '<div>{{ msg }}</div>')
  assert.doesNotMatch(s, /\{\{/)          // 不允许残留插值触发器
  assert.match(s, /\{ \{ msg \}\}/)        // 内容可读性保留
})

test('buildContextPackSection: 三连花括号（Python f-string）封闭净化', () => {
  // 真实事故：f"{{{lo}}}" 经 replace(/\{\{/g,'{ {') 变成 "{ {{lo}}}"——替换结果自己又造出 {{
  const s = core.buildContextPackSection([], 'quant = f"{{{lo}}}" + f"{{{lo},{hi}}}"')
  assert.doesNotMatch(s, /\{\{/)           // 净化必须是封闭变换
  assert.match(s, /\{ \{ \{lo\}\}\}/)      // 可读性保留
  // 五连括号 + 单括号混合
  const s2 = core.buildContextPackSection([], 'a{{{{{b}}}}}{c}{{d}}')
  assert.doesNotMatch(s2, /\{\{/)
})

test('buildContextPackSection: 笔记（思路/原始需求）注入 + 净化 + 清单同现', () => {
  const s = core.buildContextPackSection([{ path: 'a.js:L1-L9', usage: '入口' }], '用户原话：要做成{{可配置}}的')
  assert.match(s, /主窗口调研笔记/)
  assert.match(s, /用户原话：要做成\{ \{可配置\}\}的/)  // 笔记里的 {{}} 也被净化
  assert.match(s, /- a\.js:L1-L9 — 入口/)              // 清单行同时存在
})

test('buildContextPackSection: 仅笔记无文件也可注入（不出现清单段）', () => {
  const s = core.buildContextPackSection([], '思路：先改 A 再改 B')
  assert.match(s, /主窗口调研笔记/); assert.match(s, /先改 A 再改 B/)
  assert.doesNotMatch(s, /调研文件清单/)
  assert.equal(core.buildContextPackSection([], ''), '')
  assert.equal(core.buildContextPackSection(null, '  '), '')
})

test('注入迁移（task-muvjs392）：清单进首条 prompt，注入区块通道与认领机制全清零（源码级断言）', () => {
  const src = hostSrc()
  // ① 通道退役：不再注册 systemPrompt.context 动态注入段（Team 引导段 section 照旧在位）
  assert.doesNotMatch(src, /task-board:context-pack/)
  assert.doesNotMatch(src, /packByChild|pendingPacks/)
  assert.doesNotMatch(src, /sysPrompt\.context\(/)
  assert.match(src, /name: 'task-board:team-mode'/)
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(idx, /packByChild|pendingPacks/)   // state 容器本体清零
  // ② 派发侧零读盘：不再读文件、不再切段/附索引、不再按会话工作区解析
  assert.doesNotMatch(dsp, /packByChild|pendingPacks|packNote/)
  assert.doesNotMatch(dsp, /ctx\.fs|fs\.readText|sliceLines|buildFileOutline/)
  // ③ 瘦身清单本体直接拼进 worker/verifier 两态 prompt（三态其余不变：hook 仍走 buildHookPrompt）
  assert.match(dsp, /buildWorkerPrompt\(t, pack, cfg\(dsnap\)\.feedbackEnabled\)/)
  assert.match(dsp, /buildVerifierPrompt\(t, pack, cfg\(dsnap\)\.verifyUserGuide\)/)
  assert.match(dsp, /buildHookPrompt\(t, role === 'hook-pre' \? 'pre' : 'post', kids\)/)
  // ④ readContextPack = 组装清单（不再 await 读盘）——派发点与 rpc 预览点都直接调用
  assert.match(dsp, /function readContextPack\(t\) \{/)
  assert.match(dsp, /return buildContextPackSection\(files, notes\.slice\(0, 8000\)\)/)
})

test('task_preview_context / preview-context：返回瘦身清单形态（笔记全文 + 清单行；无文件正文）', async () => {
  // 真实 readContextPack 出自 dispatch（组装清单，零 IO）：用最小 ctx/deps 造一份
  const dispatch = createDispatch(
    { effect: function () {}, get: function () { return null } },
    { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} },
    {
      rt: async () => mkBoard([]), wt: async () => {}, mutateLocked: async (sid, fn) => fn(mkBoard([])), kickCycle: () => {},
      rootForSession: () => null, withTimeout: (p) => p, runsFor: () => ({}), feedbackOn: () => true,
      pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
    })
  const h = mkRpcHandlers(mkBoard([]), { readContextPack: dispatch.readContextPack })
  const files = ['lib/core.mjs:L1-L60 — 清单组装与锚点归一', 'lib/dispatch.mjs']
  const r1 = await h.__tools['task_preview_context'].execute({ contextFiles: files, contextNotes: '结论：先改 A' })
  assert.equal(r1.ok, true); assert.equal(r1.empty, false)
  assert.match(r1.pack, /### 主窗口调研笔记/); assert.match(r1.pack, /结论：先改 A/)
  assert.match(r1.pack, /- lib\/core\.mjs:L1-L60 — 清单组装与锚点归一/)
  assert.match(r1.pack, /- lib\/dispatch\.mjs/)
  assert.doesNotMatch(r1.pack, /export function buildContextPackSection/)  // 正文不进预览（0.1.7 起不再读盘）
  const r2 = await h['preview-context']({ contextFiles: files })
  assert.equal(r2.ok, true); assert.equal(r2.filesCount, 2)
  assert.match(r2.pack, /- lib\/core\.mjs:L1-L60 — 清单组装与锚点归一/)
  assert.equal((await h['preview-context']({})).ok, false)  // 两样都不给 → 明确报错（既有口径）
})

test('派发接线：Worker 首条 prompt 带瘦身清单（笔记全文 + 清单行），不含文件内容本体', async () => {
  // 真跑一次 spawn（poolCycle → spawnOneShot → buildWorkerPrompt），捕获子代理实收 prompt。
  // ctx.fs 只给空对象：清单组装若还试图读盘会立刻炸——顺带锁定「IO 清零」。
  const t = mkTask({ id: 'c1', status: 'pending', context: { files: ['lib/core.mjs:L100-L140 — 清单组装与锚点归一'], notes: '调研结论：走瘦身分离，文件正文由我自己 read' } })
  const h = mkHookDispatch(mkBoard([t]))
  await h.dispatch.poolCycle(FULL_SID)
  // Worker 默认走 continuable 路径（workerContinuable 缺省 true）：从 spawnedContinuable 取实收 prompt
  const w = h.spawnedContinuable.find((s) => s.label === 'worker:c1')
  assert.ok(w, 'Worker 已按真实派发路径 spawn（continuable）')
  assert.match(w.text, /### 主窗口调研笔记/); assert.match(w.text, /调研结论：走瘦身分离，文件正文由我自己 read/)  // 笔记全文
  assert.match(w.text, /### 调研文件清单/); assert.match(w.text, /- lib\/core\.mjs:L100-L140 — 清单组装与锚点归一/)        // 清单行
  assert.match(w.text, /按需用 read 工具自行读取，不要全量盲读/)                                                            // 自取指引
  assert.doesNotMatch(w.text, /export function buildContextPackSection/)                                                    // 文件内容本体不在 prompt
  assert.doesNotMatch(w.text, /通过「上下文注入」区提供/)                                                                    // 旧指引句已退役
})

// ===== 锚点行段解析（②，零依赖纯正则，Windows 盘符冒号不得误判）=====
test('parseAnchorPath: 无锚点原样返回', () => {
  assert.deepEqual(core.parseAnchorPath('src/a.js'), { file: 'src/a.js', from: null, to: null })
  assert.deepEqual(core.parseAnchorPath(''), { file: '', from: null, to: null })
  // 盘符无锚点：冒号在最前，不触发
  assert.deepEqual(core.parseAnchorPath('C:\\Users\\x\\a.js'), { file: 'C:\\Users\\x\\a.js', from: null, to: null })
})

test('parseAnchorPath: 单行与行段锚点', () => {
  assert.deepEqual(core.parseAnchorPath('src/a.js:L2350'), { file: 'src/a.js', from: 2350, to: null })
  assert.deepEqual(core.parseAnchorPath('src/a.js:L2350-L2420'), { file: 'src/a.js', from: 2350, to: 2420 })
  // 第二段 L 可省略
  assert.deepEqual(core.parseAnchorPath('src/a.js:L10-20'), { file: 'src/a.js', from: 10, to: 20 })
})

test('parseAnchorPath: Windows 盘符 + 锚点共存', () => {
  assert.deepEqual(core.parseAnchorPath('C:\\Users\\x\\a.js:L100-L200'), { file: 'C:\\Users\\x\\a.js', from: 100, to: 200 })
  assert.deepEqual(core.parseAnchorPath('D:/deepseek-work/b.mjs:L5'), { file: 'D:/deepseek-work/b.mjs', from: 5, to: null })
})

test('parseAnchorPath: 非法锚点剥掉并标记 invalidAnchor（调用方回退头部）', () => {
  var r1 = core.parseAnchorPath('a.js:L0')
  assert.equal(r1.file, 'a.js'); assert.equal(r1.from, null); assert.equal(r1.invalidAnchor, true)
  var r2 = core.parseAnchorPath('a.js:L5-L2')  // to < from
  assert.equal(r2.from, null); assert.equal(r2.invalidAnchor, true)
  // 完全不成形的尾巴（:Lab）不匹配锚点正则 → 按无锚点处理，路径原样保留
  var r3 = core.parseAnchorPath('a.js:Lab')
  assert.equal(r3.file, 'a.js:Lab'); assert.equal(r3.from, null); assert.equal(r3.invalidAnchor, undefined)
})

// ===== 按行切段（②，行号 1 起、from/to 皆含）=====
test('sliceLines: 正常切段', () => {
  var c = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
  var s = core.sliceLines(c, 2, 4)
  assert.equal(s.text, 'l2\nl3\nl4')
  assert.equal(s.totalLines, 5); assert.equal(s.injectedFrom, 2); assert.equal(s.injectedTo, 4)
  assert.equal(s.capped, false); assert.equal(s.invalid, false)
  // to 省略 → 到文末
  var s2 = core.sliceLines(c, 4, null)
  assert.equal(s2.text, 'l4\nl5'); assert.equal(s2.injectedTo, 5)
  // from 为 null → 全量（头部注入口径）
  var s3 = core.sliceLines(c, null)
  assert.equal(s3.text, c); assert.equal(s3.injectedFrom, 1); assert.equal(s3.injectedTo, 5)
})

test('sliceLines: 超界无效 / to 超尾收敛', () => {
  var c = ['l1', 'l2', 'l3'].join('\n')
  var bad = core.sliceLines(c, 99, null)
  assert.equal(bad.invalid, true); assert.equal(bad.text, ''); assert.equal(bad.totalLines, 3)
  assert.equal(core.sliceLines(c, 0, 2).invalid, true)   // from < 1
  assert.equal(core.sliceLines(c, 3, 2).invalid, true)   // to < from
  // to 写超了 → 收敛到文末，不算无效
  var ok = core.sliceLines(c, 2, 9999)
  assert.equal(ok.invalid, false); assert.equal(ok.injectedTo, 3); assert.equal(ok.text, 'l2\nl3')
})

test('sliceLines: 400 行段长上限', () => {
  var lines = []
  for (var i = 1; i <= 1000; i++) lines.push('row' + i)
  var s = core.sliceLines(lines.join('\n'), 1, null)
  assert.equal(s.capped, true); assert.equal(s.injectedFrom, 1); assert.equal(s.injectedTo, 400)
  assert.equal(s.text.split('\n').length, 400); assert.equal(s.totalLines, 1000)
  // 段内不超上限不标记
  var s2 = core.sliceLines(lines.join('\n'), 500, 600)
  assert.equal(s2.capped, false); assert.equal(s2.injectedTo, 600)
})

// ===== 结构索引（①④，逐行正则，宁可漏检不可误切）=====
test('buildFileOutline: JS 函数/类/箭头赋值', () => {
  var c = [
    'import os from "node:os"',
    'export function foo(a, b) {',
    '  return a + b',
    '}',
    'class Bar {',
    '}',
    'baz = async function () {}',
    'qux = async (x) => x',
    'const plain = 42',
    // 规格正则不含 var/let/const 前缀赋值形态——宁可漏检不可误切（var baz = ... 不入索引）
    'var prefixed = function () {}',
  ].join('\n')
  var o = core.buildFileOutline(c)
  assert.deepEqual(o, ['L2: export function foo(a, b) {', 'L5: class Bar {', 'L7: baz = async function () {}', 'L8: qux = async (x) => x'])
})

test('buildFileOutline: Markdown 标题 + 签名超 80 字符截断', () => {
  var longSig = 'function ' + 'a'.repeat(100) + '() {'
  var c = ['# 标题', '正文', '## 小节', '####### 七级不算标题', longSig].join('\n')
  var o = core.buildFileOutline(c)
  assert.equal(o[0], 'L1: # 标题'); assert.equal(o[1], 'L3: ## 小节')
  assert.equal(o.length, 3)  // 七级 # 不匹配；长签名收进来但截断
  assert.ok(o[2].startsWith('L5: function ')); assert.equal(o[2].length, 'L5: '.length + 81); assert.ok(o[2].endsWith('…'))
})

test('buildFileOutline: 40 条上限 + 省略标注', () => {
  var lines = []
  for (var i = 1; i <= 50; i++) lines.push('function f' + i + '() {}')
  var o = core.buildFileOutline(lines.join('\n'))
  assert.equal(o.length, 41)  // 40 条 + 1 条省略标注
  assert.equal(o[0], 'L1: function f1() {}')
  assert.equal(o[39], 'L40: function f40() {}')
  assert.match(o[40], /另有 10 条结构省略/)
  // 不超上限无省略标注
  var o2 = core.buildFileOutline(['function only() {}'].join('\n'))
  assert.deepEqual(o2, ['L1: function only() {}'])
})

// ===== 派发决策 =====
test('pickDispatch: 优先级排序 + 并发上限 + 排除项', () => {
  const tasks = [
    mkTask({ id: 'lo', priority: 'low', createdAt: '2026-01-02' }),
    mkTask({ id: 'hi', priority: 'critical', createdAt: '2026-01-03' }),
    mkTask({ id: 'claimed', claimedBy: 'someone' }),
    mkTask({ id: 'manual', assignMode: 'manual' }),
    mkTask({ id: 'direct', pipeline: 'direct' }),
    mkTask({ id: 'esc', escalation: { question: 'q' } }),
  ]
  const d = mkBoard(tasks)
  const r = core.pickDispatch(d, 3, 0, null)
  assert.deepEqual(r.pendings.map(t => t.id), ['hi', 'lo']) // critical 优先，claimed/manual/direct/escalation 全排除
  assert.equal(r.verifs.length, 0) // capV=0
  const r2 = core.pickDispatch(d, 1, 0, null)
  assert.equal(r2.pendings.length, 1) // cap 生效
})

test('pickDispatch: 依赖未满足不派发', () => {
  const dep = mkTask({ id: 'dep', status: 'in-progress' })
  const t = mkTask({ id: 'w8', dependsOn: ['dep'] })
  const r = core.pickDispatch(mkBoard([dep, t]), 5, 0, null)
  assert.equal(r.pendings.length, 0)
  dep.status = 'resolved'
  const r2 = core.pickDispatch(mkBoard([dep, t]), 5, 0, null)
  assert.equal(r2.pendings.length, 1)
})

test('pickDispatch: verifying 只派 full 档，排除 escalation 和忙中', () => {
  const tasks = [
    mkTask({ id: 'vf', status: 'verifying', pipeline: 'full' }),
    mkTask({ id: 'vw', status: 'verifying', pipeline: 'work' }),
    mkTask({ id: 've', status: 'verifying', pipeline: 'full', escalation: { question: 'q' } }),
    mkTask({ id: 'vb', status: 'verifying', pipeline: 'full' }),
  ]
  const r = core.pickDispatch(mkBoard(tasks), 0, 5, { vb: true })
  assert.deepEqual(r.verifs.map(t => t.id), ['vf']) // work 档不派审、escalation 不派、忙中不派
})

test('pickDispatch: verifying spawn-pending 占位不重复派发（防双 Verifier）', () => {
  const tasks = [
    mkTask({ id: 'vp', status: 'verifying', pipeline: 'full', verifierRun: 'spawn-pending' }),
    mkTask({ id: 'vd', status: 'verifying', pipeline: 'full', verifierRun: '12345' }), // 有真实 run id 但 run 已死（崩溃恢复场景）→ 应重派
    mkTask({ id: 'vn', status: 'verifying', pipeline: 'full' }), // 从未派发 → 应派
  ]
  const r = core.pickDispatch(mkBoard(tasks), 0, 5, null)
  assert.deepEqual(r.verifs.map(t => t.id), ['vd', 'vn'])
  // 占位 + 忙中双重排除
  const r2 = core.pickDispatch(mkBoard(tasks), 0, 5, { vd: true })
  assert.deepEqual(r2.verifs.map(t => t.id), ['vn'])
})

test('pickDispatch: frozen（裁决挂起冻结）不参与任何自动派发', () => {
  const tasks = [
    mkTask({ id: 'fz', frozen: true }), // pending 冻结 → 不派 Worker
    mkTask({ id: 'nz' }), // 普通 pending → 应派
    mkTask({ id: 'fv', status: 'verifying', pipeline: 'full', frozen: true }), // verifying 冻结 → 不派 Verifier
    mkTask({ id: 'nv', status: 'verifying', pipeline: 'full' }), // 普通 verifying → 应派
  ]
  const r = core.pickDispatch(mkBoard(tasks), 5, 5, null)
  assert.deepEqual(r.pendings.map(t => t.id), ['nz'])
  assert.deepEqual(r.verifs.map(t => t.id), ['nv'])
  // 解冻（unfreeze-task 清 frozen）后立即恢复可派发
  delete tasks[0].frozen; delete tasks[2].frozen
  const r2 = core.pickDispatch(mkBoard(tasks), 5, 5, null)
  assert.deepEqual(r2.pendings.map(t => t.id).sort(), ['fz', 'nz'])
  assert.deepEqual(r2.verifs.map(t => t.id).sort(), ['fv', 'nv'])
})

// ===== touches 文件级排他：glob 最小匹配器 =====
test('patOverlap: 完全相同路径冲突 + 归一化（\\ → /、去 ./ 前缀与尾 /）', () => {
  assert.equal(core.patOverlap('src/a.js', 'src/a.js'), true)
  assert.equal(core.patOverlap('src\\a.js', 'src/a.js'), true)   // 反斜杠归一化
  assert.equal(core.patOverlap('./src/a.js', 'src/a.js'), true) // ./ 前缀
  assert.equal(core.patOverlap('src/', 'src'), true)            // 尾 / 归一化
  assert.equal(core.patOverlap('src/a.js', 'src/b.js'), false)
  // 空/非字符串不冲突（脏声明不该误拦一切）
  assert.equal(core.patOverlap('', 'src/a.js'), false)
  assert.equal(core.patOverlap(null, 'src/a.js'), false)
  assert.equal(core.patOverlap(undefined, 'a.js'), false)
})

test('patOverlap: dir/** 目录覆盖（含两侧都 /** 时前缀互相包含）', () => {
  assert.equal(core.patOverlap('src/**', 'src/a.js'), true)
  assert.equal(core.patOverlap('src/a.js', 'src/**'), true)          // 对称
  assert.equal(core.patOverlap('src/**', 'src/deep/nested/b.js'), true)
  assert.equal(core.patOverlap('src/**', 'src2/a.js'), false)        // 前缀必须带 /
  assert.equal(core.patOverlap('src/**', 'lib/a.js'), false)
  assert.equal(core.patOverlap('src/**', 'src2/**'), false)
  assert.equal(core.patOverlap('src/**', 'src/**'), true)
  assert.equal(core.patOverlap('src/sub/**', 'src/**'), true)        // 前缀互相包含
  assert.equal(core.patOverlap('**/*.js', 'src/a.js'), false)        // '*.js' 只按扩展名后缀匹配，不展开目录通配
  assert.equal(core.patOverlap('**/*.js', 'src/a.ts'), false)
  assert.equal(core.patOverlap('**/lib/**', '**/lib/core.mjs'), true) // 复合 glob 的 dir 段（一侧是另一侧前缀）
})

test('patOverlap: *.ext 后缀（两侧 *.ext 比扩展名；*.ext vs 具体文件看 endsWith）', () => {
  assert.equal(core.patOverlap('*.js', 'src/a.js'), true)
  assert.equal(core.patOverlap('src/a.js', '*.js'), true)
  assert.equal(core.patOverlap('*.js', 'a.js'), true)
  assert.equal(core.patOverlap('*.js', '*.js'), true)
  assert.equal(core.patOverlap('*.js', '*.ts'), false)
  assert.equal(core.patOverlap('*.js', 'src/a.ts'), false)  // 扩展名不同 → 不冲突
  assert.equal(core.patOverlap('*.jsx', 'src/a.js'), false) // 后缀比对是整段（'a.js' 不以 '.jsx' 结尾）
})

test('patOverlap: 裸文件名（无 /）只与另一侧 basename 相等才算冲突', () => {
  assert.equal(core.patOverlap('index.mjs', 'index.mjs'), true)
  assert.equal(core.patOverlap('a/core.mjs', 'core.mjs'), false) // 具体路径不参与裸名规则
  assert.equal(core.patOverlap('core.mjs', 'a/core.mjs'), false)
  assert.equal(core.patOverlap('src/a.js', 'lib/a.js'), false)   // 同 basename 不同目录
  assert.equal(core.patOverlap('src/a.js', 'src/lib'), false)    // 含 / 时只比目录包含（'src/a.js' 不在 'src/lib/' 下）
})

test('touchesConflict: 与锁持有者逐条比对，返回冲突持有者 id', () => {
  const holds = [
    { id: 'h1', touches: ['src/**'] },
    { id: 'h2', touches: ['docs/x.md'] },
  ]
  assert.deepEqual(core.touchesConflict({ id: 'w1', touches: ['src/a.js'] }, holds), ['h1'])
  assert.deepEqual(core.touchesConflict({ id: 'w2', touches: ['lib/a.js'] }, holds), [])
  assert.deepEqual(core.touchesConflict({ id: 'w3', touches: ['docs/x.md', 'src/b.js'] }, holds), ['h1', 'h2'])
  assert.deepEqual(core.touchesConflict({ id: 'w4' }, holds), [])          // 没声明 touches = 不参与排他
  assert.deepEqual(core.touchesConflict({ id: 'h1', touches: ['src/a.js'] }, holds), []) // 不和自己冲突
})

test('holdsFiles: in-progress(claimedBy) / verifying 两态持有文件锁，resolved/cancelled/归档即放', () => {
  const tasks = [
    mkTask({ id: 'live', status: 'in-progress', claimedBy: 'run-1', touches: ['src/**'] }),
    mkTask({ id: 'notouch', status: 'in-progress', claimedBy: 'run-2' }),
    mkTask({ id: 'noclaim', status: 'in-progress' }),
    mkTask({ id: 'pending', status: 'pending', touches: ['src/a.js'] }),
    // 锁只护「正在写」的阶段：in-progress→verifying 不断锁（驳回会回 in-progress 继续改同一批文件）
    mkTask({ id: 'verifying', status: 'verifying', touches: ['src/b.js'] }),
    // task-muwbtee1 / 用户 2026-10-06 裁决：状态流转到已完成（resolved）即放锁，未归档也放；
    // cancelled（放弃语义）与 archived（归档=纯收纳动作）同样不持锁。
    mkTask({ id: 'resolved', status: 'resolved', touches: ['src/c.js'] }),
    mkTask({ id: 'cancelled', status: 'cancelled', touches: ['src/d.js'] }),
    mkTask({ id: 'archived', status: 'archived', touches: ['src/e.js'] }),
    mkTask({ id: 'empty', status: 'in-progress', claimedBy: 'run-3', touches: [] }),
  ]
  const holds = core.holdsFiles(mkBoard(tasks))
  assert.deepEqual(holds.map(h => h.id), ['live', 'verifying'])
  assert.deepEqual(holds[0].touches, ['src/**'])
  assert.deepEqual(core.holdsFiles(null), [])
})

// ===== touches 锁随工作态：resolved 即放（task-muwbtee1；用户 2026-10-06 裁决，回调 task-muv7c8ja）四类断言 =====
test('touches 持锁①：resolved（未归档）即放锁 → 同 touches 候选下一轮自动放行', () => {
  const holder = mkTask({ id: 'holder', status: 'resolved', touches: ['src/**'] })
  const cand = mkTask({ id: 'cand', touches: ['src/a.js'], createdAt: '2026-01-02' })
  const r = core.pickDispatch(mkBoard([holder, cand]), 5, 0, null)
  assert.deepEqual(r.pendings.map(t => t.id), ['cand'])   // 完成即放：候选不再被 resolved 卡滞留
  assert.deepEqual(r.blockedTouches, [])                  // 不产生「等 resolved 卡」的等待展示态
  // 不依赖候选自身状态：resolved 不持锁只与状态口径有关（归档与否无关）
  assert.deepEqual(core.holdsFiles(mkBoard([holder])), [])
})

test('touches 持锁②：归档回归纯收纳动作——archived 与 resolved 一样不持锁（不再是唯一真释放点）', () => {
  const holder = mkTask({ id: 'holder', status: 'resolved', touches: ['src/**'] })
  const cand = mkTask({ id: 'cand', touches: ['src/a.js'], createdAt: '2026-01-02' })
  assert.deepEqual(core.pickDispatch(mkBoard([holder, cand]), 5, 0, null).pendings.map(t => t.id), ['cand'])
  holder.status = 'archived'                                                              // 归档只是收纳
  const r = core.pickDispatch(mkBoard([holder, cand]), 5, 0, null)
  assert.deepEqual(r.pendings.map(t => t.id), ['cand'])   // 放行结果与 resolved 态逐字相同（幂等无影响）
  assert.deepEqual(r.blockedTouches, [])
  assert.deepEqual(core.holdsFiles(mkBoard([holder])), [])
})

test('touches 持锁③：cancelled 立即放锁（放弃语义=不再产出，不堵同批文件）', () => {
  const holder = mkTask({ id: 'holder', status: 'in-progress', claimedBy: 'run-1', touches: ['src/**'] })
  const cand = mkTask({ id: 'cand', touches: ['src/a.js'], createdAt: '2026-01-02' })
  assert.deepEqual(core.pickDispatch(mkBoard([holder, cand]), 5, 0, null).blockedTouches, [{ id: 'cand', conflicts: ['holder'] }])
  holder.status = 'cancelled'
  assert.deepEqual(core.holdsFiles(mkBoard([holder])), [])                 // 取消即放锁（不等归档）
  const r = core.pickDispatch(mkBoard([holder, cand]), 5, 0, null)
  assert.deepEqual(r.pendings.map(t => t.id), ['cand'])
  assert.deepEqual(r.blockedTouches, [])
})

test('touches 持锁④：verifying 持锁拦候选，但 Verifier 派发（verifs）照常不受影响', () => {
  const vt = mkTask({ id: 'vt', status: 'verifying', pipeline: 'full', touches: ['src/**'] })
  const cand = mkTask({ id: 'cand', touches: ['src/a.js'], createdAt: '2026-01-02' })
  const r = core.pickDispatch(mkBoard([vt, cand]), 5, 5, null)
  assert.deepEqual(r.blockedTouches, [{ id: 'cand', conflicts: ['vt'] }])  // verifying 仍持锁
  assert.deepEqual(r.verifs.map(t => t.id), ['vt'])                       // 只读的 Verifier 不被 touches 拦
  // 驳回会回 in-progress 继续改同一批文件 → 锁在 verifying 期间不能断（放锁点是 resolved，不是 verifying）
  assert.deepEqual(core.holdsFiles(mkBoard([vt])).map(h => h.id), ['vt'])
})

// ===== touches 锁生命周期·派发级集成（真跑 poolCycle，不是纯函数级断言）=====
// e2e 场景 T 的本机等价物：场景 T 需要在宿主进程里跑（宿主须先加载新代码，见 task-muwbtee1 上报），
// 这里用真 poolCycle + 真 resolveApply 把同一条语义链在本机钉死——
// A（in-progress + claimedBy）持锁 → B（touches 重叠）本轮不派 + waitingForTouches 标注；
// A 落到 resolved（**不归档**）→ 下一轮 poolCycle 直接派 B，并清掉等待展示态。
test('poolCycle 集成：A resolved 即放锁 → B 下一轮被派发且 waitingForTouches 被清（e2e 场景 T 等价断言）', async () => {
  const SID = 'session-test-0000-0000-000000000000'
  const board = Object.assign(mkBoard([
    mkTask({ id: 'A', status: 'in-progress', claimedBy: 'run-1', claimedAt: new Date().toISOString(), touches: ['e2e-lock/x.txt'] }),
    mkTask({ id: 'B', touches: ['e2e-lock/**'], createdAt: '2026-01-02' }),
  ]), { maxWorkers: 3 })
  // 真 spawnOneShot：provider 可用 + startContinuable 返回不结算的 run（本用例只看「能不能拿到锁」）
  const ctxOver = { subagents: { list: () => ['p1'], getProvider: () => ({ inheritsParentContext: false }), start: async () => ({ id: 'run-2', dispose() {}, result: new Promise(function () {}) }), startContinuable: async () => ({ childId: 'child-1', messageId: 'msg-1' }) } }
  const { dispatch } = mkDispatch(board, { rootForSession: () => ({ id: SID }) }, ctxOver)
  // 第 1 轮：A 持锁（in-progress + claimedBy）→ B 被拦下并在卡上标注在等谁
  await dispatch.poolCycle(SID)
  const A = board.tasks.find(t => t.id === 'A'), B = board.tasks.find(t => t.id === 'B')
  assert.equal(A.status, 'in-progress')
  assert.equal(B.status, 'pending')
  assert.deepEqual(B.waitingForTouches, ['A'])
  // A 完成：resolveApply 落 resolved，**不归档**（新口径的释放点就在这一步的状态流转）
  core.resolveApply(board, A, 'run-1', 'resolved', 'done', 'worker 文本上报完成')
  assert.equal(A.status, 'resolved')
  // 第 2 轮：状态已流转到完成 → 锁即放 → B 被派发、等待展示态被清（归档与否无关）
  await dispatch.poolCycle(SID)
  assert.notEqual(B.status, 'pending')
  assert.equal(B.waitingForTouches, undefined)
})

test('touches 锁生命周期接线（源码级）：holdsFiles 两态口径 + 承接关系注释 + 无 resolved/归档放锁残留', () => {
  const src = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  // ① 两态持锁口径写在 holdsFiles 里（verifying 与 in-progress+claimedBy；resolved 已移出持锁集合）
  assert.match(src, /var holds = t\.status === 'verifying' \|\| \(t\.status === 'in-progress' && !!t\.claimedBy\)/)
  // ② 旧「锁持到归档」三态口径已退役（verifying||resolved 的耦合判定与「持锁三态」标题都不再存在）
  assert.doesNotMatch(src, /t\.status === 'verifying' \|\| t\.status === 'resolved'/)
  assert.doesNotMatch(src, /持锁三态/)
  // ③ 新口径 + 决策来源日期（用户指令）落款在注释里，防口径漂移
  assert.match(src, /状态流转到已完成（resolved）即放锁/)
  assert.match(src, /用户 2026-10-06 裁决/)
  // ④ 承接关系（主窗口即时门禁纪律 + 史诗 post-hook）写进注释——窗口期不再靠长持锁兜底
  assert.match(src, /主窗口即时门禁纪律/)
  assert.match(src, /史诗 post-hook/)
  // ⑤ 派发层不再有「resolved 时放锁」的动作调用（旧实现 releaseTouchesOnly 不存在）；
  //    并写明锁是随状态现算的派生量、没有显式放锁点（resolved 由下一轮 tick 自然放行）
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(dsp, /releaseTouchesOnly/)
  assert.match(dsp, /resolved\/cancelled\/archived 即放/)
})

test('README 双份同步记录 touches 锁随工作态口径（状态流转到 resolved 即释放）', () => {
  const pkg = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.equal(pkg, root) // 两份 README 必须字节一致（npm run sync-readme 的约束）
  for (const s of ['锁随工作态', 'in-progress', 'verifying', 'resolved', 'cancelled', '归档']) {
    assert.ok(pkg.includes(s), 'README 应记录 touches 锁口径：' + s)
  }
  assert.ok(!pkg.includes('锁持到归档'), 'README 不应再记录「锁持到归档」旧口径')
})

test('README 定位段：agent 团队持久台账与治理层关键词存在（台账/治理层/审计台/流水线归机器）+ 双份逐字一致', () => {
  const pkg = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.equal(pkg, root) // 两份 README 必须字节一致（npm run sync-readme 的约束）
  for (const s of ['agent 团队的持久台账与治理层', '台账', '治理层', '审计台', '流水线归机器，审计台归人', '验收独立复跑', '适合谁']) {
    assert.ok(root.includes(s), 'README 定位段应含关键词：' + s)
  }
})

// ===== 派发决策（touches 拦截）=====
test('pickDispatch: touches 与活动任务冲突 → 不进 pendings，记入 blockedTouches', () => {
  const tasks = [
    mkTask({ id: 'holder', status: 'in-progress', claimedBy: 'run-1', touches: ['src/**'] }),
    mkTask({ id: 'clash', touches: ['src/a.js'], createdAt: '2026-01-01' }),
    mkTask({ id: 'free', touches: ['lib/a.js'], createdAt: '2026-01-02' }),
    mkTask({ id: 'untouched', createdAt: '2026-01-03' }), // 没声明 touches → 不被拦
  ]
  const r = core.pickDispatch(mkBoard(tasks), 5, 0, null)
  assert.deepEqual(r.pendings.map(t => t.id).sort(), ['free', 'untouched'])
  assert.deepEqual(r.blockedTouches, [{ id: 'clash', conflicts: ['holder'] }])
})

test('pickDispatch: verifying 持有文件锁（锁未断），但 verifier 派发（verifs）不受 touches 影响', () => {
  const tasks = [
    // verifying 仍持锁（驳回会回 in-progress 继续改同一批文件；放锁点是状态流转到 resolved，
    // 不是 in-progress→verifying——用户 2026-10-06 裁决）
    mkTask({ id: 'vt', status: 'verifying', pipeline: 'full', claimedBy: 'run-1', touches: ['src/**'] }),
    mkTask({ id: 'w1', touches: ['src/a.js'] }),
  ]
  const r = core.pickDispatch(mkBoard(tasks), 5, 5, null)
  assert.deepEqual(r.pendings, [])                             // 被 verifying 任务拦住，本轮不派
  assert.deepEqual(r.blockedTouches, [{ id: 'w1', conflicts: ['vt'] }])
  assert.deepEqual(r.verifs.map(t => t.id), ['vt'])            // Verifier 照常派（只读，不参与排他）
  // 反向：pending 任务声明 touches 也不影响 verifs 派发
  const tasks2 = [mkTask({ id: 'w2', touches: ['src/**'] }), mkTask({ id: 'v2', status: 'verifying', pipeline: 'full' })]
  const r2 = core.pickDispatch(mkBoard(tasks2), 5, 5, null)
  assert.deepEqual(r2.verifs.map(t => t.id), ['v2'])
})

test('pickDispatch: 未声明 touches 的任务不做任何拦截；同一轮内已派发任务立即成为锁持有者', () => {
  // 无锁持有者时，声明了 touches 的任务照常派发（锁只在 in-progress 时持有）
  const solo = mkBoard([mkTask({ id: 'solo', touches: ['src/**'] })])
  const r1 = core.pickDispatch(solo, 5, 0, null)
  assert.deepEqual(r1.pendings.map(t => t.id), ['solo'])
  assert.deepEqual(r1.blockedTouches, [])
  // 同一轮拿两个候选：第一个把 src/ 纳入锁，第二个声明重叠 → 本轮只派第一个
  const d = mkBoard([
    mkTask({ id: 'one', touches: ['src/a.js'], priority: 'critical', createdAt: '2026-01-01' }),
    mkTask({ id: 'two', touches: ['src/**'], createdAt: '2026-01-02' }),
  ])
  const r2 = core.pickDispatch(d, 5, 0, null)
  assert.deepEqual(r2.pendings.map(t => t.id), ['one'])
  assert.deepEqual(r2.blockedTouches, [{ id: 'two', conflicts: ['one'] }])
})

test('pickDispatch: frozen/dependsOn/escalation 优先级不变（touches 拦截附加在原有过滤之后）', () => {
  const tasks = [
    mkTask({ id: 'holder', status: 'in-progress', claimedBy: 'run-1', touches: ['src/**'] }),
    mkTask({ id: 'fz', frozen: true, touches: ['src/a.js'] }),                 // 冻结 → 既有语义直接排除，不记 blockedTouches
    // dep 的 touches 走 lib/：只验「依赖未满足被既有语义排除」，不与 clash 抢同一把锁
    // （holder 落到 resolved 后 dep 的依赖即满足、会被派发并拿下 src/a.js，抢锁会掩盖本条想验的语义）
    mkTask({ id: 'dep', dependsOn: ['holder'], touches: ['lib/a.js'] }),
    mkTask({ id: 'esc', escalation: { question: 'q' }, touches: ['src/a.js'] }),// 待裁决 → 排除
    mkTask({ id: 'clash', touches: ['src/a.js'] }),                            // 唯一被 touches 拦下的
  ]
  const r = core.pickDispatch(mkBoard(tasks), 5, 0, null)
  assert.deepEqual(r.pendings, [])
  assert.deepEqual(r.blockedTouches, [{ id: 'clash', conflicts: ['holder'] }])
  // 锁释放点（用户 2026-10-06 裁决）：verifying 仍持锁（驳回会回 in-progress 继续改同一批文件）；
  // 状态流转到 resolved 才真释放（resolved/归档都不再持锁），被拦任务下一轮自动恢复可派发
  const b2 = mkBoard(tasks)
  b2.tasks[0].status = 'verifying'
  const r2 = core.pickDispatch(b2, 5, 0, null)
  assert.deepEqual(r2.blockedTouches, [{ id: 'clash', conflicts: ['holder'] }])  // verifying 仍持锁
  b2.tasks[0].status = 'resolved'
  const r3 = core.pickDispatch(b2, 5, 0, null)
  assert.ok(r3.pendings.map(t => t.id).indexOf('clash') >= 0)
  assert.deepEqual(r3.blockedTouches, [])
  b2.tasks[0].status = 'archived'   // 归档幂等：已放锁态下结果逐字不变（归档回归纯收纳动作）
  const r4 = core.pickDispatch(b2, 5, 0, null)
  assert.ok(r4.pendings.map(t => t.id).indexOf('clash') >= 0)
  assert.deepEqual(r4.blockedTouches, [])
})
test('normalizeBoard: touches 脏值（非数组）收敛为空数组，缺字段任务照常', () => {
  const legacy = { tasks: [{ id: 'a', touches: 'src/a.js' }, { id: 'b' }, { id: 'c', touches: ['src/c.js'] }] }
  const d = core.normalizeBoard(legacy)
  assert.deepEqual(d.tasks[0].touches, [])
  assert.equal(d.tasks[1].touches, undefined) // 缺字段不动（老看板文件兼容）
  assert.deepEqual(d.tasks[2].touches, ['src/c.js'])
})

// ===== 孤儿回收 =====
test('isOrphan: 认领者非主会话 + 无活跃 run + 超 2 分钟', () => {
  const old = new Date(Date.now() - 200000).toISOString()
  const t = mkTask({ status: 'in-progress', claimedBy: 'run-123', claimedAt: old })
  const d = mkBoard([t])
  assert.equal(core.isOrphan(d, t, {}, Date.now()), true)
  assert.equal(core.isOrphan(d, t, { t1: {} }, Date.now()), false) // 有活跃 run
  t.claimedBy = 's1' // 主会话自己认领的
  assert.equal(core.isOrphan(d, t, {}, Date.now()), false)
  t.claimedBy = 'run-123'; t.escalation = { question: 'q' }
  assert.equal(core.isOrphan(d, t, {}, Date.now()), false) // 待裁决的不回收
  delete t.escalation; t.claimedAt = new Date().toISOString()
  assert.equal(core.isOrphan(d, t, {}, Date.now()), false) // 刚认领不超 2 分钟
})

// ===== 种子与配置 =====
test('seed: 初始看板结构', () => {
  const d = core.seed('s1')
  assert.equal(d.ownerSession, 's1'); assert.equal(d.boardMode, 'auto'); assert.deepEqual(d.tasks, [])
  assert.ok(core.vt(d))
  // poolStatus 必须存在——task_list 工具输出它，undefined 会被 lossless-JSON 校验拒
  assert.deepEqual(d.poolStatus, { workers: [], verifiers: [] })
})

test('normalizeBoard: 旧文件补 poolStatus', () => {
  const legacy = { tasks: [] }
  const d = core.normalizeBoard(legacy)
  assert.deepEqual(d.poolStatus, { workers: [], verifiers: [] })
  // 已有合法 poolStatus 不动
  const ok = { tasks: [], poolStatus: { workers: [{ id: 'w1' }], verifiers: [] } }
  assert.equal(core.normalizeBoard(ok).poolStatus.workers[0].id, 'w1')
  // 残缺的 poolStatus（缺 verifiers 数组）也修复
  const broken = { tasks: [], poolStatus: { workers: [] } }
  assert.deepEqual(core.normalizeBoard(broken).poolStatus, { workers: [], verifiers: [] })
})

test('cfg: 边界夹紧', () => {
  const c = core.cfg({ minWorkers: -1, maxWorkers: 99, minVerifiers: 99, maxVerifiers: -1 })
  assert.equal(c.minWorkers, 0); assert.equal(c.maxWorkers, 10); assert.equal(c.minVerifiers, 5); assert.equal(c.maxVerifiers, 0)
})

// ===== 回归：PRIO_RANK 使用一致性 =====
test('PRIO_RANK: 与 pickDispatch 排序一致', () => {
  // PRIO_RANK 必须有 4 档，且值与 pickDispatch 的 sort 逻辑一致
  assert.equal(core.PRIO_RANK.critical, 4); assert.equal(core.PRIO_RANK.high, 3)
  assert.equal(core.PRIO_RANK.medium, 2); assert.equal(core.PRIO_RANK.low, 1)
  // pickDispatch 优先级排序验证（已在前面测过，这里确认 PRIO_RANK 可用）
  const d = mkBoard([mkTask({ id: 'lo', priority: 'low' }), mkTask({ id: 'hi', priority: 'critical' })])
  const r = core.pickDispatch(d, 5, 0, null)
  assert.equal(r.pendings[0].id, 'hi') // critical 排前面
})

// ===== 回归：outputText 对各种 SubagentResult 形态 =====
test('outputText: 各种 ContentBlock 形态', () => {
  assert.equal(core.outputText({ output: [{ type: 'text', text: 'hello' }] }), 'hello')
  assert.equal(core.outputText({ output: [] }), '')
  assert.equal(core.outputText({ output: [{ type: 'tool_use' }] }), '') // 无 text block
  assert.equal(core.outputText({ stopReason: 'completed' }), '') // 无 output 字段
  assert.equal(core.outputText(undefined), '')
  assert.equal(core.outputText(null), '')
})

// ===== 回归：isOrphan 边界 =====
test('isOrphan: cancelled 状态不回收（不在 in-progress）', () => {
  const t = mkTask({ status: 'cancelled', claimedBy: 'run-x', claimedAt: new Date(Date.now() - 999999).toISOString() })
  assert.equal(core.isOrphan(mkBoard([t]), t, {}, Date.now()), false)
})
test('isOrphan: 刚 claim 的（<2min）不回收', () => {
  const t = mkTask({ status: 'in-progress', claimedBy: 'run-x', claimedAt: new Date().toISOString() })
  assert.equal(core.isOrphan(mkBoard([t]), t, {}, Date.now()), false)
})

// ===== 任务粒度治理（软闸门：只提示，绝不阻断）=====
test('suggestSplitOf: 常规粒度任务不提示（返回空串）', () => {
  assert.equal(suggestSplitOf(mkTask({ title: '改按钮文案', description: '把按钮文案从 A 改成 B，肉眼确认' })), '')
  assert.equal(suggestSplitOf(mkTask()), '')
  assert.equal(suggestSplitOf(undefined), '')
})

test('suggestSplitOf: description 超过 500 字符触发建议（恰好 500 不触发）', () => {
  assert.equal(suggestSplitOf(mkTask({ description: 'x'.repeat(500) })), '')
  assert.equal(suggestSplitOf(mkTask({ description: 'x'.repeat(501) })), SUGGEST_SPLIT_TEXT)
})

test('suggestSplitOf: 命中史诗特征词触发建议（title / description 任一命中）', () => {
  assert.equal(suggestSplitOf(mkTask({ title: '全量重构派发引擎' })), SUGGEST_SPLIT_TEXT)
  assert.equal(suggestSplitOf(mkTask({ title: 'T', description: '把整个看板 UI 做一遍' })), SUGGEST_SPLIT_TEXT)
  assert.equal(suggestSplitOf(mkTask({ title: 'T', description: '系统级改造' })), SUGGEST_SPLIT_TEXT)
})

test('suggestSplitOf: 建议文案含 10~30 分钟粒度与拆分出口', () => {
  assert.match(SUGGEST_SPLIT_TEXT, /10~30 分钟/)
  assert.match(SUGGEST_SPLIT_TEXT, /parentId/)
  assert.match(SUGGEST_SPLIT_TEXT, /收窄边界/)
})

test('withSplitHint: 命中时才附加 suggestSplit，未命中返回体形态不变（老调用方无感）', () => {
  const big = withSplitHint({ ok: true, task: {} }, mkTask({ title: '全量重写' }))
  assert.equal(big.suggestSplit, SUGGEST_SPLIT_TEXT)
  const small = withSplitHint({ ok: true, task: {} }, mkTask({ title: '改个错别字' }))
  assert.deepEqual(Object.keys(small), ['ok', 'task']) // 不附加 suggestSplit
  assert.equal(small.suggestSplit, undefined)
})

test('粒度治理接线：工具描述/Team 提示词/双出口返回体均已落地（源码级轻量断言）', () => {
  const src = hostSrc()
  assert.match(TASK_SIZE_CONTRACT, /建议粒度：单任务 10~30 分钟/)
  assert.match(TASK_SIZE_CONTRACT, /epic 卡/)
  assert.match(TEAM_SPLIT_RULE, /大任务必须拆分/)
  assert.match(TEAM_SPLIT_RULE, /pipeline 传 direct/)
  assert.match(TEAM_SPLIT_RULE, /parentId=父卡 id/)
  assert.match(TEAM_SPLIT_RULE, /checkParentAuto/)
  assert.ok(src.includes("' + TASK_SIZE_CONTRACT")) // task_create 工具描述已拼接契约
  // Team 提示词第 6 条改经 epicSplit 门禁出口注入（task-muuxcj6y）：缺省 true 时逐字回到开关前形态
  assert.ok(src.includes('splitRuleOf(epicSplitOn(String(agent.id)))'))
  assert.equal((src.match(/withSplitHint\(\{ ok: true, task: t \}, t, cfg\(d\)\.epicSplit\)/g) || []).length, 2) // task_create 工具 + create-task RPC
  assert.match(src, /全量\|整体\|系统级\|全面\|重构\|所有模块\|整个/) // 史诗特征词表在位
  assert.match(src, /SPLIT_DESC_LIMIT = 500/)                        // 500 字符阈值在位
})

// ===== create-task 空 description 软警告（E 卡）=====
// 轻量 RPC 直调 harness：mock ctx（tools/effect/webServer）+ deps 最小面，直接调 handlers['create-task']
// extra 可覆盖默认 deps（如 epic 预检用例注入 pushSysNote 捕获 / sessionCwd 解析根）
// 幻影板防线（task-muuf0o7a）落地后，create-task 对不完整短 id 直接报错——mock 默认 sid
// 必须是完整形态（session-xxxx-xxxx-...），否则全量 create-task 用例会被防线拦住。
const FULL_SID = 'session-test-0000-0000-000000000000'
function mkRpcHandlers(board, extra, ctxExtra) {
  const state = { handlers: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {} }
  const tools = {} // 工具通道捕获：双通道接线测试经 __tools['task_create'].execute(...) 直调
  const ctx = Object.assign({ tools: { register(t) { tools[t.name] = t } }, effect() {}, webServer: { register() { return () => {} } } }, ctxExtra || {})
  const deps = Object.assign({
    getActorId: () => 'tester', resolveRoot: (x) => x,
    toolSessionId: () => FULL_SID, rpcSessionId: () => FULL_SID,
    rootForSession: () => null, deriveWorkMode: () => 'solo', runsFor: () => [],
    rt: async () => board, mutateLocked: (sid, fn) => fn(board),
    maybeNotify: () => {}, notifyTaskDone: () => {},
    spawnOneShot: () => {}, accumulateRunUsage: () => {}, readContextPack: async () => null,
    pushSysNote: () => {}, sessionCwd: () => '',
  }, extra || {})
  createRpc(ctx, state, deps)
  state.handlers.__tools = tools
  return state.handlers
}
const EMPTY_DESC_WARNING = '任务描述为空——Worker 只能凭标题猜需求，建议补一句目标/约束'

test('create-task RPC: description 空白（空串 / 纯空格）→ 创建成功且响应附 warning 软警告', async () => {
  let board = mkBoard([])
  let r = await mkRpcHandlers(board)['create-task']({ title: 'T', description: '' })
  assert.equal(r.ok, true); assert.equal(r.warning, EMPTY_DESC_WARNING)
  assert.equal(board.tasks.length, 1) // 软警告不拦截创建
  board = mkBoard([])
  r = await mkRpcHandlers(board)['create-task']({ title: 'T', description: '   ' }) // 纯空格同样视为空白（trim 判定）
  assert.equal(r.ok, true); assert.equal(r.warning, EMPTY_DESC_WARNING)
  assert.equal(board.tasks.length, 1)
})

test('create-task RPC: description 非空 → 响应无 warning 字段（返回体形态不变，老调用方无感）', async () => {
  const board = mkBoard([])
  const r = await mkRpcHandlers(board)['create-task']({ title: 'T', description: '把按钮文案从 A 改成 B，肉眼确认' })
  assert.equal(r.ok, true)
  assert.equal('warning' in r, false)
  assert.equal(board.tasks.length, 1)
})

// ===== 调研门禁（task-mute6zpw）：warning 族扩展 + epic 发布预检 + 读包失败落卡 =====
// 纯函数口径在 core.mjs（isTreeGlob/createTaskWarnings/epicPrecheck/epicPrecheckNote）；
// 这里既测纯函数矩阵，也经 mkRpcHandlers 直调验证双通道接线（warning 合并、publish 预检投递）。

test('isTreeGlob: 仅「以 /** 结尾或恰为 **」算整树 glob', () => {
  for (const p of ['**', 'src/**', './src/**', 'src\\**', 'a/b/**']) assert.equal(core.isTreeGlob(p), true, p)
  for (const p of ['src/*', 'src/**/*.mjs', '*.mjs', 'src/x.mjs', '', '**x']) assert.equal(core.isTreeGlob(p), false, p)
})

test('createTaskWarnings: 触发/不触发矩阵（pipeline × touches × 调研上下文）', () => {
  // ① description 空白（沿用 E 卡既有文案，逐字一致）
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: ' ' })), [EMPTY_DESC_WARNING])
  // ② full/work + touches 非空 + contextFiles/contextNotes 皆空 → 无调研上下文警告
  const noCtx = core.createTaskWarnings(mkTask({ description: 'd', pipeline: 'full', touches: ['lib/a.mjs'] }))
  assert.equal(noCtx.length, 1); assert.match(noCtx[0], /未附调研上下文/)
  const work = core.createTaskWarnings(mkTask({ description: 'd', pipeline: 'work', touches: ['lib/a.mjs'] }))
  assert.equal(work.length, 1); assert.match(work[0], /未附调研上下文/)
  // 有 contextFiles 或 contextNotes 任一 → ②不触发
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: 'd', touches: ['lib/a.mjs'], context: { files: ['lib/a.mjs'], notes: '' } })), [])
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: 'd', touches: ['lib/a.mjs'], context: { files: [], notes: '结论' } })), [])
  // pipeline=direct 或 touches 为空 → ②③都不触发
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: 'd', pipeline: 'direct', touches: ['src/**'] })), [])
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: 'd', touches: [] })), [])
  // ③ 整树 glob（与 ② 同现时的数组序：② 在前 ③ 在后）
  const both = core.createTaskWarnings(mkTask({ description: 'd', touches: ['src/**'] }))
  assert.equal(both.length, 2); assert.match(both[0], /未附调研上下文/); assert.match(both[1], /整树 glob/)
  // 有调研上下文时只剩 ③
  const globOnly = core.createTaskWarnings(mkTask({ description: 'd', touches: ['src/**'], context: { files: [], notes: 'n' } }))
  assert.equal(globOnly.length, 1); assert.match(globOnly[0], /整树 glob/)
})

test('create-task RPC: touches 非空且无调研上下文 → warning 附「未附调研上下文」（软提示不拦截）', async () => {
  const board = mkBoard([])
  const r = await mkRpcHandlers(board)['create-task']({ title: '改 lib/x.mjs 的返回值', description: '明确描述', touches: ['lib/x.mjs'] })
  assert.equal(r.ok, true); assert.match(r.warning, /未附调研上下文/); assert.equal(board.tasks.length, 1)
})

test('create-task RPC: 整树 glob → warning 附「整树 glob」；pipeline=direct 不触发 a/b', async () => {
  let board = mkBoard([])
  let r = await mkRpcHandlers(board)['create-task']({ title: '调整 src 目录的一批样式', description: 'd', touches: ['src/**'], contextNotes: '已调研' })
  assert.equal(r.ok, true); assert.match(r.warning, /整树 glob/); assert.ok(!/未附调研上下文/.test(r.warning))
  board = mkBoard([])
  r = await mkRpcHandlers(board)['create-task']({ title: '改 src 下某个开关', description: 'd', pipeline: 'direct', touches: ['src/**'] })
  assert.equal(r.ok, true); assert.equal('warning' in r, false)
})

test('create-task RPC: 空描述 + 无调研上下文 + 整树 glob → 三条合并为一条 warning（；分隔）', async () => {
  const board = mkBoard([])
  const r = await mkRpcHandlers(board)['create-task']({ title: '改 src 一批文件', description: '', touches: ['src/**'] })
  assert.equal(r.ok, true)
  assert.match(r.warning, /任务描述为空/); assert.match(r.warning, /未附调研上下文/); assert.match(r.warning, /整树 glob/)
  assert.equal(r.warning.split('；').length, 3)
})

// ===== 任务起草 lint（proposal n-muwlpbspl3w2）：四规则 lintWarnings[]，不阻塞 =====
// 与「调研门禁」（createTaskWarnings，瞬态 warning）正交：这是起草质量持久诊断（存 task.lintWarnings[]，
// get-tasks 透出、详情页 ⚠️ 行）。纯函数 draftLint 在 core.mjs，双仓库歧义读盘经 io 注入。

test('touchDirPrefix: 剥 glob 尾段得目录前缀（裸文件名/纯 ** 无锚点 → 空）', () => {
  assert.equal(core.touchDirPrefix('packages/dsh-agent-board/**'), 'packages/dsh-agent-board')
  assert.equal(core.touchDirPrefix('src/**'), 'src')
  assert.equal(core.touchDirPrefix('src/x.mjs'), 'src')
  assert.equal(core.touchDirPrefix('a/b/c.mjs'), 'a/b')
  assert.equal(core.touchDirPrefix('core.mjs'), '')   // 裸文件名无目录锚点，不参与判重
  assert.equal(core.touchDirPrefix('**'), '')
})

test('ambiguousTouch: ≥2 子目录同名命中 → 返回相对路径原文；绝对路径/盘符/裸名/缺 io → null', () => {
  const two = { root: 'ws', subdirs: ['task-board-plugin', 'task-board-federation', 'other'], dirExists: (p) => p === path.join('ws', 'task-board-plugin', 'packages/dsh-agent-board') || p === path.join('ws', 'task-board-federation', 'packages/dsh-agent-board') }
  assert.equal(core.ambiguousTouch(['packages/dsh-agent-board/core.mjs'], two), 'packages/dsh-agent-board/core.mjs')
  const one = { root: 'ws', subdirs: ['task-board-plugin', 'other'], dirExists: (p) => p === path.join('ws', 'task-board-plugin', 'packages/dsh-agent-board') }
  assert.equal(core.ambiguousTouch(['packages/dsh-agent-board/core.mjs'], one), null)
  assert.equal(core.ambiguousTouch(['/abs/pkg/core.mjs'], two), null)          // 绝对路径不判
  assert.equal(core.ambiguousTouch(['C:\\abs\\pkg\\core.mjs'], two), null)     // 盘符不判
  assert.equal(core.ambiguousTouch(['core.mjs'], two), null)                  // 裸文件名不判
  assert.equal(core.ambiguousTouch(['src/**'], null), null)                   // 缺 io → 零 IO 安全
  assert.equal(core.ambiguousTouch(['src/**'], { subdirs: ['a', 'b'] }), null) // 缺 dirExists → 退化为不触发
})

test('draftLint: 四规则各一触发 + 各一不触发（纯函数矩阵）', () => {
  const io2 = { root: 'ws', subdirs: ['a', 'b'], dirExists: (p) => p === path.join('ws', 'a', 'pkg') || p === path.join('ws', 'b', 'pkg') }
  // ① 整树 glob：触发 / 不触发（精确到文件级不触发）
  const t1 = mkTask({ title: '修复样式', description: 'd', acceptance: 'node --test', touches: ['src/**'] })
  assert.ok(core.draftLint(t1).includes(core.TREE_GLOB_LINT))
  assert.ok(!core.draftLint(mkTask({ title: '修复样式', description: 'd', acceptance: 'node --test', touches: ['src/x.mjs'] })).includes(core.TREE_GLOB_LINT))
  // ② 双仓库歧义：触发 / 不触发（目录前缀在两个子目录下都存在才算歧义）
  const t2 = mkTask({ title: '修复 x', description: 'd', acceptance: 'node --test', touches: ['pkg/core.mjs'] })
  assert.match(core.draftLint(t2, io2).find((w) => w.indexOf(core.AMBIGUOUS_PATH_LINT) === 0), /pkg\/core\.mjs/)
  const io1 = { root: 'ws', subdirs: ['a', 'b'], dirExists: (p) => p === path.join('ws', 'a', 'pkg') }
  assert.equal(core.draftLint(t2, io1).find((w) => w.indexOf(core.AMBIGUOUS_PATH_LINT) === 0), undefined)
  // ③ full 无验收：触发 / 不触发（work 档或有验收不触发）
  assert.ok(core.draftLint(mkTask({ title: '修复 x', description: 'd', pipeline: 'full', acceptance: '' })).includes(core.FULL_NO_ACCEPTANCE_LINT))
  assert.ok(!core.draftLint(mkTask({ title: '修复 x', description: 'd', pipeline: 'work', acceptance: '' })).includes(core.FULL_NO_ACCEPTANCE_LINT))
  assert.ok(!core.draftLint(mkTask({ title: '修复 x', description: 'd', pipeline: 'full', acceptance: 'node --test' })).includes(core.FULL_NO_ACCEPTANCE_LINT))
  // ④ 标题缺动词 / 描述空：触发 / 不触发
  const t4 = mkTask({ title: '看板规则', description: 'd', acceptance: 'node --test' })
  assert.ok(core.draftLint(t4).includes(core.TITLE_NO_VERB_LINT))
  const t4n = mkTask({ title: '修复 lint 规则', description: '明确描述', acceptance: 'node --test' })
  assert.ok(!core.draftLint(t4n).includes(core.TITLE_NO_VERB_LINT))
  assert.ok(!core.draftLint(t4n).includes(core.EMPTY_DESC_WARNING))
  assert.ok(core.draftLint(mkTask({ title: '修复 x', description: '', acceptance: 'node --test' })).includes(core.EMPTY_DESC_WARNING))
})

test('create-task RPC: 起草 lint 落卡 lintWarnings[]，get-tasks 透出（不阻断创建）', async () => {
  const board = mkBoard([])
  const h = mkRpcHandlers(board)
  const r = await h['create-task']({ title: '修复 lint 规则', description: '明确描述', touches: ['src/**'], acceptance: 'node --test' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.task.lintWarnings, [core.TREE_GLOB_LINT])
  const got = await h['get-tasks']({})
  assert.deepEqual(got.tasks[0].lintWarnings, [core.TREE_GLOB_LINT])
})

test('update-task RPC: 改标题后重算 lintWarnings（无动词标题触发，改回动词清空）', async () => {
  const board = mkBoard([mkTask({ id: 't1', title: '修复 x', description: 'd', acceptance: 'node --test' })])
  const h = mkRpcHandlers(board)
  assert.equal(board.tasks[0].lintWarnings, undefined) // 直接建卡无字段（老卡零字段）
  const r = await h['update-task']({ taskId: 't1', title: '看板规则' })
  assert.deepEqual(r.task.lintWarnings, [core.TITLE_NO_VERB_LINT])
  const r2 = await h['update-task']({ taskId: 't1', title: '修复 lint 规则' })
  assert.deepEqual(r2.task.lintWarnings, [])
})

test('起草 lint：老卡无 lintWarnings 字段 → get-tasks 照常返回不炸（零字段兼容）', async () => {
  const board = mkBoard([mkTask({ id: 'old', title: '老卡', description: 'd', acceptance: 'node --test' })])
  const h = mkRpcHandlers(board)
  const got = await h['get-tasks']({})
  assert.equal(got.tasks.length, 1)
  assert.equal(got.tasks[0].lintWarnings, undefined) // 不补造字段，undefined 不炸
})

test('起草 lint 接线：四入口 draftLint 落卡 + 详情 ⚠️ 行 + README 双份（源码级断言）', () => {
  const host = hostSrc()
  assert.equal((host.match(/t\.lintWarnings = draftLint\(t, draftLintIo\(sid, d\.ownerCwd\)/g) || []).length, 4) // task_create/create-task/task_update/update-task 四入口
  assert.equal((host.match(/function draftLintIo\(/g) || []).length, 1) // IO 注入 helper 单一出处
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /export function draftLint\(t, io\)/)
  assert.match(coreSrc, /export function ambiguousTouch\(touches, io\)/)
  assert.match(coreSrc, /export function touchDirPrefix\(p\)/)
  assert.match(coreSrc, /TREE_GLOB_LINT = 'touches 粒度过粗，几乎锁整仓'/)
  assert.match(coreSrc, /AMBIGUOUS_PATH_LINT = '路径双仓库歧义，建议加仓库前缀'/)
  assert.match(coreSrc, /FULL_NO_ACCEPTANCE_LINT = 'full 管线建议带验收命令'/)
  assert.match(coreSrc, /TITLE_NO_VERB_LINT = '标题缺动作动词/)
  const detail = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  assert.match(detail, /task\.lintWarnings\.map\(function \(w, i\)/) // 详情 ⚠️ 行小块
  const pkgReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const rootReadme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.equal((pkgReadme.match(/lintWarnings\[\]/g) || []).length, 2)  // 包 README 双处（调研门禁 + 三档通用）
  assert.equal((rootReadme.match(/lintWarnings\[\]/g) || []).length, 2) // 根 README 同步双处
})

test('epicPrecheck: 字段有无 + 路径存在性（exists 注入），direct/归档子任务不参与', () => {
  const kids = [
    mkTask({ id: 'k1', title: '无材料', parentId: 'ep', context: { files: [], notes: '' } }),
    mkTask({ id: 'k2', title: '有笔记', parentId: 'ep', context: { files: [], notes: '结论' } }),
    mkTask({ id: 'k3', title: '路径全不存在', parentId: 'ep', context: { files: ['a.mjs', 'b.mjs:L3-L9'], notes: '' } }),
    mkTask({ id: 'k4', title: '路径存在', parentId: 'ep', context: { files: ['c.mjs'], notes: '' } }),
    mkTask({ id: 'k5', title: 'direct 跳过', parentId: 'ep', pipeline: 'direct', context: { files: [], notes: '' } }),
    mkTask({ id: 'k6', title: '归档跳过', parentId: 'ep', status: 'archived', context: { files: [], notes: '' } }),
  ]
  const pre = core.epicPrecheck(kids, 'ep', (p) => p === 'c.mjs')
  assert.equal(pre.total, 4) // direct/归档不计入 N
  assert.deepEqual(pre.missing.map((m) => m.id), ['k1', 'k3'])
  assert.match(pre.missing[0].reason, /无 contextFiles/)
  assert.match(pre.missing[1].reason, /全部不存在/)
  // 锚点 :L 段先剥掉再查存在性（'b.mjs:L3-L9' 以 'b.mjs' 查 exists）；
  // 可选「 — 一句用途」后缀同样剥掉（瘦身清单条目写法，task-muvjs392）——存在性是对文件而言的。
  // some 短路：第一条 false 才会继续查第二条，正好把两种剥法都走一遍。
  const seen = []
  const pre2 = core.epicPrecheck([mkTask({ id: 'x', parentId: 'ep', context: { files: ['b.mjs:L3-L9', 'd.mjs:L1-L5 — 状态机主循环'], notes: '' } })], 'ep', (p) => { seen.push(p); return p === 'd.mjs' })
  assert.deepEqual(seen, ['b.mjs', 'd.mjs'])   // 锚点与用途都剥掉，落到纯路径
  assert.deepEqual(pre2.missing, [])           // d.mjs 存在 → 不判缺材料
})

test('epicPrecheckNote: 全部有材料 → 空串（不打扰）；有缺失 → N/M 汇总文案（超 5 条折叠）', () => {
  assert.equal(core.epicPrecheckNote({ total: 3, missing: [] }), '')
  assert.equal(core.epicPrecheckNote(null), '')
  const note = core.epicPrecheckNote({ total: 3, missing: [{ id: 'k1', title: '无材料', reason: '无 contextFiles/contextNotes' }] })
  assert.match(note, /epic 发布预检：3 个子任务中 1 个无调研注入/)
  assert.match(note, /k1「无材料」/)
  const many = { total: 7, missing: [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'k' + i, title: 't' + i, reason: 'r' })) }
  const note2 = core.epicPrecheckNote(many)
  assert.match(note2, /7 个子任务中 6 个无调研注入/); assert.match(note2, /等/)
})

test('update-task RPC: 发布 epic（有子任务缺调研注入）→ pushSysNote 汇总 + 响应挂 epicPrecheck；全有材料不打扰', async () => {
  const notes = []
  const board = mkBoard([
    mkTask({ id: 'ep', title: '史诗', status: 'draft' }),
    mkTask({ id: 'c1', title: '子任务1', parentId: 'ep', status: 'draft', context: { files: [], notes: '' } }),
    mkTask({ id: 'c2', title: '子任务2', parentId: 'ep', status: 'draft', context: { files: [], notes: 'n' } }),
  ])
  const handlers = mkRpcHandlers(board, { pushSysNote: (sid, text, taskId) => notes.push({ text, taskId }) })
  const r = await handlers['update-task']({ taskId: 'ep', publish: true })
  assert.equal(r.ok, true)
  assert.equal(board.tasks[0].status, 'pending') // 照常发布，预检不阻断
  assert.equal(notes.length, 1)
  assert.match(notes[0].text, /epic 发布预检：2 个子任务中 1 个无调研注入/)
  assert.match(notes[0].text, /c1「子任务1」/)
  assert.equal(notes[0].taskId, 'ep')
  assert.ok(r.epicPrecheck && r.epicPrecheck.missing.length === 1)
  // 全部有材料 → 不投递、响应不挂字段（「不打扰」口径）
  const notes2 = []
  const board2 = mkBoard([
    mkTask({ id: 'ep2', title: '史诗2', status: 'draft' }),
    mkTask({ id: 'c3', title: '子任务3', parentId: 'ep2', status: 'draft', context: { files: [], notes: 'n' } }),
  ])
  const h2 = mkRpcHandlers(board2, { pushSysNote: (sid, text) => notes2.push(text) })
  const r2 = await h2['update-task']({ taskId: 'ep2', publish: true })
  assert.equal(r2.ok, true); assert.equal(notes2.length, 0); assert.equal('epicPrecheck' in r2, false)
  // 非 draft 发布被拒（not a draft）→ 不预检不投递：ep2 已是 pending，重复 publish 应被拒
  const r3 = await h2['update-task']({ taskId: 'ep2', publish: true })
  assert.equal(r3.ok, false); assert.match(r3.error, /not a draft/); assert.equal(notes2.length, 0)
})

// ===== 调研遵循·host 三件套（task-mutnj3a4）：touches→suggestedContextFiles 桥接 + Verifier 归因 + 驳回 hint =====

test('suggestContextFiles: glob 跳过 / 锚点剥离 / 存在性过滤 / 去重 / 上限 20 全矩阵', () => {
  // 非数组 / 空条目 / 非字符串 → 空
  assert.deepEqual(core.suggestContextFiles(null, () => true), [])
  assert.deepEqual(core.suggestContextFiles(['', '  ', 42], () => true), [])
  // glob 条目（* ? [ ] { } 任一）跳过；具体文件保留
  assert.deepEqual(core.suggestContextFiles(['src/**', '*.mjs', 'a?.js', 'x/[ab].js', 'x/{a,b}.js', 'lib/a.mjs'], () => true), ['lib/a.mjs'])
  // 锚点 :L 段剥掉后再查存在性，返回剥锚后的相对原样
  const seen = []
  const r = core.suggestContextFiles(['lib/a.mjs:L10-L20'], (p) => { seen.push(p); return true })
  assert.deepEqual(r, ['lib/a.mjs']); assert.deepEqual(seen, ['lib/a.mjs'])
  // 存在性过滤：不存在的剔除
  assert.deepEqual(core.suggestContextFiles(['a.mjs', 'b.mjs'], (p) => p === 'b.mjs'), ['b.mjs'])
  // exists 抛异常视为不存在（宁缺勿滥）
  assert.deepEqual(core.suggestContextFiles(['a.mjs'], () => { throw new Error('x') }), [])
  // exists 缺省 → 退化为只做 glob/锚点过滤（与 epicPrecheck 同口径）
  assert.deepEqual(core.suggestContextFiles(['a.mjs', 'src/**']), ['a.mjs'])
  // 去重（按剥锚后原串）+ 顺序保持
  assert.deepEqual(core.suggestContextFiles(['a.mjs', 'a.mjs:L5', 'b.mjs', 'a.mjs'], () => true), ['a.mjs', 'b.mjs'])
  // 上限 20（与 contextFiles 上限一致）
  const many = []
  for (let i = 0; i < 25; i++) many.push('f' + i + '.mjs')
  assert.equal(core.suggestContextFiles(many, () => true).length, 20)
})

test('attachContextSuggestions: 触发②且有建议 → warning 补尾 + 挂字段；否则形态不变', () => {
  // 触发：warnings 含无调研警告且 touches 有可建议文件
  const out = { ok: true }
  const warns = core.createTaskWarnings(mkTask({ description: 'd', touches: ['lib/a.mjs'] }))
  const suggested = core.attachContextSuggestions(out, warns, ['lib/a.mjs'], () => true)
  assert.deepEqual(suggested, ['lib/a.mjs'])
  assert.deepEqual(out.suggestedContextFiles, ['lib/a.mjs'])
  assert.match(warns[0], /可直接 task_update contextFiles 补上/)
  // 不触发①：无「未附调研上下文」警告（已有调研上下文）→ null，out 不挂字段
  const out2 = { ok: true }
  const warns2 = core.createTaskWarnings(mkTask({ description: 'd', touches: ['lib/a.mjs'], context: { files: [], notes: 'n' } }))
  assert.equal(core.attachContextSuggestions(out2, warns2, ['lib/a.mjs'], () => true), null)
  assert.equal('suggestedContextFiles' in out2, false)
  // 不触发②：touches 全 glob → null，warning 原文不变（不补尾巴）
  const out3 = { ok: true }
  const warns3 = core.createTaskWarnings(mkTask({ description: 'd', touches: ['src/**'] }))
  const before = warns3.join('；')
  assert.equal(core.attachContextSuggestions(out3, warns3, ['src/**'], () => true), null)
  assert.equal('suggestedContextFiles' in out3, false)
  assert.equal(warns3.join('；'), before)
})

test('create-task 双通道：touches 指向真实文件且无调研上下文 → 挂 suggestedContextFiles + warning 补尾', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-suggest-'))
  fs.writeFileSync(path.join(tmp, 'real.mjs'), '// x')
  const extra = { sessionCwd: () => tmp }
  // RPC 通道：ghost.mjs 不存在、src/** 是 glob → 均剔除，只剩 real.mjs
  const board = mkBoard([])
  const r = await mkRpcHandlers(board, extra)['create-task']({ title: 'T', description: 'd', touches: ['real.mjs', 'ghost.mjs', 'src/**'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.suggestedContextFiles, ['real.mjs'])
  assert.match(r.warning, /未附调研上下文/); assert.match(r.warning, /可直接 task_update contextFiles 补上/)
  // 工具通道（同口径）
  const board2 = mkBoard([])
  const tools = mkRpcHandlers(board2, extra).__tools
  const r2 = await tools['task_create'].execute({ title: 'T', description: 'd', touches: ['real.mjs'] }, {})
  assert.equal(r2.ok, true)
  assert.deepEqual(r2.suggestedContextFiles, ['real.mjs'])
  assert.match(r2.warning, /可直接 task_update contextFiles 补上/)
})

test('create-task：touches 全 glob 或已有调研上下文 → 不挂 suggestedContextFiles（返回体形态不变）', async () => {
  const board = mkBoard([])
  const r = await mkRpcHandlers(board)['create-task']({ title: 'T', description: 'd', touches: ['src/**'] })
  assert.equal(r.ok, true); assert.match(r.warning, /未附调研上下文/)
  assert.equal('suggestedContextFiles' in r, false)
  assert.ok(!/可直接 task_update/.test(r.warning)) // 无建议时尾巴也不补
  const board2 = mkBoard([])
  const r2 = await mkRpcHandlers(board2)['create-task']({ title: 'T', description: 'd', touches: ['lib/a.mjs'], contextNotes: '已调研' })
  assert.equal(r2.ok, true); assert.equal('warning' in r2, false); assert.equal('suggestedContextFiles' in r2, false)
})

test('verify 驳回 hint：verify-task RPC + task_verify 工具 rejected 附重派提示，approved 不附', async () => {
  // RPC 通道 rejected → 附 hint，驳回语义不变（回 in-progress）
  const board = mkBoard([mkTask({ id: 'v1', status: 'verifying' })])
  const r = await mkRpcHandlers(board)['verify-task']({ taskId: 'v1', verdict: 'rejected', comment: '跑偏了' })
  assert.equal(r.ok, true); assert.match(r.hint, /驳回原因写进 description/); assert.match(r.hint, /新 Worker 没有上一轮记忆/)
  assert.equal(board.tasks[0].status, 'in-progress')
  // RPC 通道 approved → 无 hint 字段
  const board2 = mkBoard([mkTask({ id: 'v2', status: 'verifying' })])
  const r2 = await mkRpcHandlers(board2)['verify-task']({ taskId: 'v2', verdict: 'approved' })
  assert.equal(r2.ok, true); assert.equal('hint' in r2, false)
  // 工具通道 rejected → 同口径附 hint
  const board3 = mkBoard([mkTask({ id: 'v3', status: 'verifying' })])
  const r3 = await mkRpcHandlers(board3).__tools['task_verify'].execute({ taskId: 'v3', verdict: 'rejected', comment: '缺测试' }, {})
  assert.equal(r3.ok, true); assert.match(r3.hint, /驳回原因写进 description/)
  // 工具通道 approved → 无 hint
  const board4 = mkBoard([mkTask({ id: 'v4', status: 'verifying' })])
  const r4 = await mkRpcHandlers(board4).__tools['task_verify'].execute({ taskId: 'v4', verdict: 'approved' }, {})
  assert.equal(r4.ok, true); assert.equal('hint' in r4, false)
})

// ===== 驳回信息全量带回（task-muvg15p5）：三条驳回路径统一落 kind='rejection' 完整包 =====
// 事故链：驳回信息此前只走 history（histNotes 每条截 300 字）——board_verdict 工具通道的 checks
// （逐条核对证据）整段丢弃、手动驳回 comment 常空且不写 t.verification → 重派 Worker 只看到一句
// 被截断的「rejected」，拿不到可执行的返工细节。修法：驳回包落 t.messages，经 buildMessages 全量
// 注入 Worker prompt（每条 2000 字），history 保持不动（审计轨）。
const REJ_CHECKS = '## 核对项\n- 断言①未落地（lib/core.mjs:100 无 pushRejection 调用）\n- 断言②端到端未锁（test/core.test.mjs 缺 prompt 含 checks 断言）'
// 文本通道端到端 harness：真跑 poolCycle 派 Verifier run，run.result 由用例手工 resolve → 真走 settleVerifier
function mkVerifierSettleDispatch(board) {
  var runs = {}
  var resolveRun = null
  var boardRef = { b: board }
  var ctx = {
    fs: {}, effect: function () {}, get: function () { return null }, timer: null,
    subagents: {
      list: function () { return ['mock'] },
      getProvider: function () { return { inheritsParentContext: false } },
      start: async function () { return { id: 'run-v1', result: new Promise(function (res) { resolveRun = res }), dispose: async function () {} } },
    },
  }
  var state = { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} }
  var dispatch = createDispatch(ctx, state, {
    rt: async function () { return boardRef.b }, wt: async function () {}, mutateLocked: async function (sid, fn) { return fn(boardRef.b) },
    kickCycle: function () {}, rootForSession: function () { return { id: FULL_SID } }, sessionCwd: function () { return '' },
    withTimeout: function (p) { return p }, runsFor: function () { return runs }, feedbackOn: function () { return true }, epicSplitOn: function () { return true },
    pushSysNote: function () {}, maybeNotify: function () {}, notifyTaskDone: function () {},
  })
  return { dispatch: dispatch, settle: function (text) { resolveRun({ output: [{ type: 'text', text: text }], stopReason: 'completed' }) } }
}
async function waitRej(t, ms) {
  var t0 = Date.now()
  while (Date.now() - t0 < (ms || 2000)) {
    if (t.messages.some(function (m) { return m && m.kind === 'rejection' })) return true
    await new Promise(function (r) { setTimeout(r, 5) })
  }
  return t.messages.some(function (m) { return m && m.kind === 'rejection' })
}

test('驳回信息全量带回①：board_verdict 工具通道 → messages 落完整驳回包（checks 全文不再丢）', async () => {
  const board = mkBoard([mkTask({ id: 'r1', status: 'verifying' })])
  const r = await mkRpcHandlers(board).__tools['board_verdict'].execute({ taskId: 'r1', verdict: 'rejected', summary: '单测未过', checks: REJ_CHECKS }, {})
  assert.equal(r.ok, true)
  const t = board.tasks[0]
  const rej = t.messages.filter(m => m.kind === 'rejection')
  assert.equal(rej.length, 1)
  assert.match(rej[0].text, /单测未过/)
  assert.ok(rej[0].text.includes('断言①未落地（lib/core.mjs:100 无 pushRejection 调用）')) // checks 全文在位（工具通道此前整段丢弃）
  assert.equal(rej[0].by, 'tester')
  assert.equal(rej[0].at, t.verification.at) // 与验收结论同一时间戳（判重口径）
  // 端到端：重派 Worker prompt 真的带上了 checks（「带回」的最终判据）
  const p = core.buildWorkerPrompt(t, '', false)
  assert.match(p, /\[rejection\]/)
  assert.ok(p.includes('断言②端到端未锁（test/core.test.mjs 缺 prompt 含 checks 断言）'))
})

test('驳回信息全量带回②：Verifier 文本结算路径 → 同构驳回包，prompt 含 checks（端到端真 settle）', async () => {
  const t = mkTask({ id: 'v1', status: 'verifying' })
  const h = mkVerifierSettleDispatch(mkBoard([t]))
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(t.status, 'verifying'); assert.ok(t.verifierRun) // 已派 Verifier（占位已换真实 run id）
  h.settle('REJECTED: 交付物与验收脚本不符\n\n## 测试概要\nnpm test 未跑通\n\n' + REJ_CHECKS)
  assert.equal(await waitRej(t), true)
  const rej = t.messages.filter(m => m.kind === 'rejection')
  assert.equal(rej.length, 1)
  assert.match(rej[0].text, /npm test 未跑通/)
  assert.ok(rej[0].text.includes('断言①未落地'))
  assert.equal(rej[0].by, 'run-v1')
  assert.equal(t.verification.verdict, 'rejected')
  assert.equal(t.status, 'pending') // 驳回重派（rejectCount=1 < 3）
  const p = core.buildWorkerPrompt(t, '', false)
  assert.ok(p.includes('断言②端到端未锁（test/core.test.mjs 缺 prompt 含 checks 断言）'))
})

test('驳回信息全量带回③：手动驳回双通道 → messages 落包 + t.verification 补写（空 comment 有兜底）', async () => {
  // RPC 通道 + comment 缺省（人工/GUI 常留空）：兜底文案也要是「可执行的下一步」，不能是空消息
  const board = mkBoard([mkTask({ id: 'm1', status: 'verifying' })])
  await mkRpcHandlers(board)['verify-task']({ taskId: 'm1', verdict: 'rejected' })
  const t = board.tasks[0]
  assert.equal(t.verification.verdict, 'rejected'); assert.equal(t.verification.checks, '')
  assert.equal(t.verification.by, 'tester'); assert.ok(t.verification.at)
  const rej = t.messages.filter(m => m.kind === 'rejection')
  assert.equal(rej.length, 1)
  assert.match(rej[0].text, /驳回方未填写原因，请先自查交付物与验收脚本差距/)
  assert.match(core.buildWorkerPrompt(t, '', false), /驳回方未填写原因/) // 端到端：空原因也带回一句可执行兜底
  // 工具通道带 comment → 同构落包 + 结论字段口径与自动路径一致
  const board2 = mkBoard([mkTask({ id: 'm2', status: 'verifying' })])
  await mkRpcHandlers(board2).__tools['task_verify'].execute({ taskId: 'm2', verdict: 'rejected', comment: '缺边界断言' }, {})
  const t2 = board2.tasks[0]
  assert.equal(t2.verification.summary, '缺边界断言'); assert.equal(t2.verification.checks, '')
  const rej2 = t2.messages.filter(m => m.kind === 'rejection')
  assert.equal(rej2.length, 1)
  assert.match(rej2[0].text, /验收驳回 · 缺边界断言/)
})

test('驳回信息全量带回④：approved 路径零 rejection 消息（双通道 + 文本结算，防误落）', async () => {
  const board = mkBoard([mkTask({ id: 'a1', status: 'verifying' })])
  await mkRpcHandlers(board).__tools['board_verdict'].execute({ taskId: 'a1', verdict: 'approved', summary: 'OK', checks: '## 核对项\n- 全过' }, {})
  assert.equal(board.tasks[0].status, 'resolved')
  assert.equal(board.tasks[0].messages.filter(m => m.kind === 'rejection').length, 0)
  const board2 = mkBoard([mkTask({ id: 'a2', status: 'verifying' })])
  await mkRpcHandlers(board2)['verify-task']({ taskId: 'a2', verdict: 'approved', comment: 'OK' })
  assert.equal(board2.tasks[0].messages.filter(m => m.kind === 'rejection').length, 0)
  const t = mkTask({ id: 'a3', status: 'verifying' })
  const h = mkVerifierSettleDispatch(mkBoard([t]))
  await h.dispatch.poolCycle(FULL_SID)
  h.settle('APPROVED: 全部通过\n\n## 测试概要\n真跑通过')
  await new Promise(function (r) { setTimeout(r, 20) })
  assert.equal(t.status, 'resolved')
  assert.equal(t.messages.filter(m => m.kind === 'rejection').length, 0)
})

test('pushRejection: 同事件判重（同时间戳/同前缀不双推）+ 空原因兜底文案', () => {
  const t = { messages: [] }
  assert.equal(core.pushRejection(t, '概要', '核对项全文', 'T1', 'v'), true)
  assert.equal(core.pushRejection(t, '概要', '核对项全文', 'T1', 'v'), false) // 同时间戳
  assert.equal(core.pushRejection(t, '概要', '核对项全文', 'T2', 'v'), false) // 异时间戳但正文前缀相同（同一驳回）
  assert.equal(core.pushRejection(t, '另一件事', '', 'T3', 'v'), true)        // 不同事件照常落
  assert.equal(t.messages.length, 2)
  assert.equal(t.messages[0].kind, 'rejection'); assert.equal(t.messages[0].by, 'v')
  assert.equal(core.rejectionText('', ''), '（驳回方未填写原因，请先自查交付物与验收脚本差距）')
  assert.equal(core.rejectionText('概要', '核对'), '验收驳回 · 概要\n\n核对项：\n核对')
})

test('驳回全量带回接线（源码级）：三条驳回路径都调 pushRejection + messages 通道在位', () => {
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.equal((rpc.match(/pushRejection\(t, /g) || []).length, 3) // board_verdict 工具 + verify-task RPC + task_verify 工具
  assert.match(dsp, /pushRejection\(t, vsecs\.verifySummary, vsecs\.checks, t\.verification\.at, String\(rec\.id\)\)/)
  assert.equal((hostSrc().match(/pushRejection\(t, /g) || []).length, 4) // 三条路径 + Verifier 文本结算
  assert.match(coreSrc, /export function pushRejection/)
  assert.match(coreSrc, /kind: 'rejection'/)
  // buildMessages 现成通道在位（驳回包靠它进 prompt，不新开通道）
  assert.match(coreSrc, /export function buildMessages/)
  assert.match(coreSrc, /if \(msgs\) p \+= '\\n\\n该任务的详细消息/)
})

test('buildVerifierPrompt: 含「立单缺调研」驳回归因条款', () => {
  const p = core.buildVerifierPrompt(mkTask({ id: 'tx', status: 'verifying' }), '')
  assert.match(p, /立单缺调研/)
  assert.match(p, /驳回热点统计/)
})

// ===== Verifier 验收员加餐（task-muy3gm03）：固定 persona + 文件纪律 + toolFilter 收窄 =====
test('Verifier 加餐①：VERIFIER_PERSONA 常量——验收员四要点 + 无 {{ 连写括号（严格插值护栏）', () => {
  const ps = core.VERIFIER_PERSONA
  assert.equal(typeof ps, 'string')
  assert.match(ps, /独立验收员/)       // 人设定位
  assert.match(ps, /独立判断/)         // ① 独立判断
  assert.match(ps, /不轻信/)           // ① 不轻信 Worker 汇报
  assert.match(ps, /实证为准/)         // ② 以验收脚本实证为准
  assert.match(ps, /诚实分级/)         // ③ 诚实分级（自测指南三档）
  assert.match(ps, /双读者/)           // ④ 结论给主窗口与用户双读者
  // 宿主对 persona 做严格 {{…}} 插值（同 deployment persona 模板语义）——文本不得含连写 {
  assert.ok(!/\{\{/.test(ps), 'persona 文本不得含 {{（严格插值会抛异常）')
})

test('Verifier 加餐②：文件纪律条款在 verifier prompt；worker prompt 不含（parity）', () => {
  const t = mkTask({ id: 'tx', status: 'verifying' })
  const pv = core.buildVerifierPrompt(t, '')
  assert.match(pv, /文件纪律/)                       // 条款标题
  assert.match(pv, /可以写必要的临时\/测试文件/)      // 允许写临时/测试文件
  assert.match(pv, /_scratch/)                       // 临时文件落点
  assert.match(pv, /验收结束后自行清理/)              // 验收结束清理
  assert.match(pv, /禁止改动工程代码与文档/)          // 工程代码/文档只读
  assert.match(pv, /touches 审计兜底/)               // 事后兜底威慑写明
  // 条款在结论契约之前（纪律先行）
  assert.ok(pv.indexOf('文件纪律') < pv.indexOf('结论契约'), '文件纪律段先于结论契约')
  // worker prompt 逐字 parity：不含任何文件纪律/加餐条款
  const pw = core.buildWorkerPrompt(mkTask({ id: 'tx', status: 'pending' }), '')
  assert.doesNotMatch(pw, /文件纪律/)
  assert.doesNotMatch(pw, /touches 审计/)
})

test('Verifier 加餐③：toolFilter 保守收窄——只 deny 联网检索，无 allow 白名单（注释锁定保守理由）', () => {
  // 白名单断言：收窄为 deny 形态，只砍 web_fetch/web_search（验收不需联网）
  assert.deepEqual(core.VERIFIER_TOOL_FILTER, { deny: ['web_fetch', 'web_search'] })
  assert.equal(core.VERIFIER_TOOL_FILTER.allow, undefined, '不设 allow 白名单（拿不准的宁可不收窄）')
  // 注释存在性断言：core.mjs 写明保守理由（其余工具保留的逐类口径）
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /toolFilter 收窄评估结论（保守口径）/)
  assert.match(coreSrc, /拿不准的宁可不收窄/)
})

test('Verifier 加餐④：真派发接线——verifier spawn 挂 persona/toolFilter，worker spawn 逐字 parity', async () => {
  // 真跑 poolCycle：一张 verifying 卡（派 verifier）+ 一张 pending 卡（派 worker，continuable 路径）
  const tv = mkTask({ id: 'v1', status: 'verifying' })
  const tw = mkTask({ id: 'w1', status: 'pending' })
  const h = mkHookDispatch(mkBoard([tv, tw]))
  await h.dispatch.poolCycle(FULL_SID)
  const v = h.spawned.find((s) => s.label === 'verifier:v1')
  assert.ok(v, 'verifier 按真实派发路径 spawn（一次性 start）')
  assert.equal(v.persona, core.VERIFIER_PERSONA, 'verifier spawn 挂固定验收员 persona')
  assert.deepEqual(v.toolFilter, { deny: ['web_fetch', 'web_search'] }, 'verifier spawn 挂收窄 toolFilter')
  const w = h.spawnedContinuable.find((s) => s.label === 'worker:w1')
  assert.ok(w, 'worker 按真实派发路径 spawn（continuable）')
  assert.equal(w.persona, undefined, 'worker spawn 不挂 persona（逐字 parity）')
  assert.equal(w.toolFilter, undefined, 'worker spawn 不挂 toolFilter（逐字 parity）')
  // hook run 也不挂（hook 只吃 buildHookPrompt 薄框架，不加验收员人设）
  assert.ok(h.spawned.every((s) => s.label.indexOf('hook') !== 0 || s.persona === undefined), 'hook spawn 不挂加餐')
})

test('Verifier 加餐⑤：源码级锁定——加餐只挂 verifier 分支 + 失败回退剥外挂参数', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  // ① 挂载点只有一处，且被 role === 'verifier' 守门（worker/hook 不可能挂上）
  assert.match(dsp, /if \(role === 'verifier'\) \{ req\.persona = VERIFIER_PERSONA; req\.toolFilter = VERIFIER_TOOL_FILTER \}/)
  assert.equal((dsp.match(/req\.persona = VERIFIER_PERSONA/g) || []).length, 1)
  assert.equal((dsp.match(/req\.toolFilter = VERIFIER_TOOL_FILTER/g) || []).length, 1)
  // ② 常量从 core 解构导入（单一事实源）
  assert.match(dsp, /VERIFIER_PERSONA, VERIFIER_TOOL_FILTER/)
  // ③ 回退兜底：spawn 失败剥光外挂参数（persona/toolFilter/agentOptions）裸请求重试
  assert.match(dsp, /delete req\.agentOptions; delete req\.persona; delete req\.toolFilter/)
  // ④ 注释写明 continuable 面不支持 persona 的实证结论（只挂一次性面的理由）
  assert.match(dsp, /continuable 面（ContinuableCreateRequest 仅 sessionId\/parent\/signal）/)
})

test('调研遵循接线：双通道 attachContextSuggestions / 驳回 hint 双挂 / Verifier 归因条款（源码级断言）', () => {
  const src = hostSrc()
  assert.equal((src.match(/attachContextSuggestions\(/g) || []).length, 2) // task_create 工具 + create-task RPC
  assert.equal((src.match(/\.hint = REJECT_REDISPATCH_HINT/g) || []).length, 2) // task_verify 工具 + verify-task RPC
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /立单缺调研/) // Verifier prompt 归因条款在位
  assert.match(coreSrc, /export function suggestContextFiles/)
})

test('调研门禁接线：双通道 warning 调用 / epic 预检投递 / 读包失败落卡（源码级轻量断言）', () => {
  const src = hostSrc()
  assert.equal((src.match(/createTaskWarnings\(t\)/g) || []).length, 2) // task_create 工具 + create-task RPC
  assert.match(src, /pushSysNote: notify\.pushSysNote, sessionCwd: session\.sessionCwd/) // index.mjs 接线
  assert.match(src, /__pre = epicPrecheck\(d\.tasks, t\.id, existsFn\)/) // publish 预检调用
  assert.match(src, /afterPublishPrecheck\(sid, args\.taskId, __res\)/) // 锁外 pushSysNote 投递
  assert.match(src, /t2\.lastError = \('contextPack 读取失败: '/) // dispatch 读包失败落卡（mutateLocked 返回非空才写盘）
  assert.match(src, /调研门禁：pipeline=full\/work 且 touches 非空/) // task_create 工具描述事前引导
})

// ===== Token 消耗统计 =====
test('aggregateUsageSummary: 空任务/无 usage 任务 → 全零 + 空 Top', () => {
  const s = aggregateUsageSummary([mkTask({ id: 'a' }), mkTask({ id: 'b', usage: null })])
  assert.equal(s.total, 0); assert.equal(s.input, 0); assert.equal(s.output, 0); assert.equal(s.cacheRead, 0)
  assert.deepEqual(s.byModel, {}); assert.deepEqual(s.topTasks, [])
  assert.deepEqual(s.byDay, {}) // 日账缺省空对象（老看板/无 usage 不炸）
  assert.deepEqual(aggregateUsageSummary(undefined), { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, effective: 0, byModel: {}, byModelEff: {}, byDay: {}, byDayFull: {}, topTasks: [] })
})

test('aggregateUsageSummary: 总量/输入输出缓存拆分累加 + 按模型小计合并', () => {
  const u1 = { input: 100, output: 20, cacheRead: 1000, cacheWrite: 0, total: 1120, runs: 2, models: { 'deepseek-flash': 1000, 'glm-5': 120 } }
  const u2 = { input: 5, output: 5, cacheRead: 0, cacheWrite: 3, total: 13, runs: 1, models: { 'deepseek-flash': 13 } }
  const s = aggregateUsageSummary([mkTask({ id: 'a', usage: u1 }), mkTask({ id: 'b', usage: u2 }), mkTask({ id: 'c' })])
  assert.equal(s.total, 1133); assert.equal(s.input, 105); assert.equal(s.output, 25)
  assert.equal(s.cacheRead, 1000); assert.equal(s.cacheWrite, 3)
  assert.deepEqual(s.byModel, { 'deepseek-flash': 1013, 'glm-5': 120 })
  assert.deepEqual(s.byDay, {}) // 无 byDay 且无 updatedAt → 不归任何日（宁可漏不错）
})

// 测试侧独立复刻本地日 key（与实现同口径但各自独立写，防「实现自证」）
const lk = (iso) => { const d = new Date(iso); const p2 = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) }
// 用本地时间构造再转 ISO：任意时区下本地日都是 2026-10-02，断言与宿主时区无关
const localIso = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString()

test('aggregateUsageSummary: byDay 日账逐日合并（同日累加 / 跨日分桶）', () => {
  const a = mkTask({ id: 'a', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 100, runs: 2, models: {}, updatedAt: localIso(2026, 10, 2, 10, 0), byDay: { '2026-10-01': { t: 60, e: 60 }, '2026-10-02': { t: 40, e: 40 } } } })
  const b = mkTask({ id: 'b', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 30, runs: 1, models: {}, updatedAt: localIso(2026, 10, 2, 11, 0), byDay: { '2026-10-02': { t: 30, e: 30 } } } })
  const s = aggregateUsageSummary([a, b])
  assert.deepEqual(s.byDay, { '2026-10-01': { t: 60, e: 60 }, '2026-10-02': { t: 70, e: 70 } }) // 同日 t/e 分别累加、跨日分桶
  assert.equal(s.total, 130) // 总量口径不变
  assert.deepEqual(a.usage.byDay, { '2026-10-01': { t: 60, e: 60 }, '2026-10-02': { t: 40, e: 40 } }) // 入参对象未被就地改写（纯函数）
})

test('aggregateUsageSummary: 存量任务无 byDay → 整笔归 updatedAt 的本地日（近似口径）', () => {
  const legacy = mkTask({ id: 'old', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 500, runs: 1, models: {}, updatedAt: localIso(2026, 10, 2, 10, 30) } })
  const fresh = mkTask({ id: 'new', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 20, runs: 1, models: {}, updatedAt: localIso(2026, 10, 3, 9, 0), byDay: { '2026-10-03': { t: 20, e: 20 } } } })
  const s = aggregateUsageSummary([legacy, fresh])
  assert.deepEqual(s.byDay, { '2026-10-02': { t: 500, e: null }, '2026-10-03': { t: 20, e: 20 } }) // 老任务兜底只有总量（e 不可知=null）+ 新任务日账双指标
  assert.equal(lk(localIso(2026, 10, 2, 10, 30)), '2026-10-02') // 本地日口径自检（防 toISOString 的 UTC 错位）
})

test('aggregateUsageSummary: 本地 00:30 的 updatedAt 落在本地日（用 UTC 位移可区分的时刻钉死口径）', () => {
  // 东八区：本地 2026-10-02 00:30 → UTC 2026-10-01T16:30Z；若实现用 toISOString().slice(0,10)
  // 就会记成 10-01（跨日错位）。本条在 UTC+8 宿主上必然抓得住这种写法。
  const iso = localIso(2026, 10, 2, 0, 30)
  const s = aggregateUsageSummary([mkTask({ id: 'midnight', usage: { total: 42, models: {}, updatedAt: iso } })])
  assert.deepEqual(Object.keys(s.byDay), ['2026-10-02'])
  assert.deepEqual(s.byDay['2026-10-02'], { t: 42, e: null }) // 兜底路径只有总量：e 不可知置 null，不冒充有效值
})

test('aggregateUsageSummary: 无 updatedAt / 坏 updatedAt → 不归任何日，byDay 空对象不炸', () => {
  const s = aggregateUsageSummary([
    mkTask({ id: 'x', usage: { total: 7, models: {} } }),
    mkTask({ id: 'y', usage: { total: 9, models: {}, updatedAt: 'not-a-date' } }),
    mkTask({ id: 'z', usage: { total: 11, models: {}, byDay: null } })
  ])
  assert.deepEqual(s.byDay, {})
  assert.equal(s.total, 27)
  assert.equal(s.topTasks.length, 3) // 总量/Top 不受日账缺失影响
})

test('aggregateUsageSummary: Top 任务按总量降序、最多 8 条、带 runs 计数', () => {
  const tasks = []
  for (let i = 0; i < 12; i++) tasks.push(mkTask({ id: 't' + i, title: 'T' + i, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: i * 10, runs: i } }))
  const s = aggregateUsageSummary(tasks)
  assert.equal(s.topTasks.length, 8)
  assert.deepEqual(s.topTasks.map(x => x.total), [110, 100, 90, 80, 70, 60, 50, 40]) // 降序取前 8
  assert.equal(s.topTasks[0].id, 't11'); assert.equal(s.topTasks[0].title, 'T11'); assert.equal(s.topTasks[0].runs, 11)
})

// ===== Token 口径对齐真实消耗：有效/缓存读分离 + run 级留账 =====
test('aggregateUsageSummary: 有效消耗合计 = 输入+输出+缓存写（缓存读不计入）', () => {
  // 实证场景：本板累计 10.3M 里缓存读 9.7M（94%），有效消耗仅 605K——大数字虚高 17 倍。
  const u1 = { input: 100, output: 20, cacheRead: 1000, cacheWrite: 5, total: 1125, runs: 2, models: {} }
  const u2 = { input: 5, output: 5, cacheRead: 0, cacheWrite: 3, total: 13, runs: 1, models: {} }
  const s = aggregateUsageSummary([mkTask({ id: 'a', usage: u1 }), mkTask({ id: 'b', usage: u2 })])
  assert.equal(s.effective, 138) // (100+20+5) + (5+5+3)
  assert.equal(s.cacheRead, 1000)
  assert.equal(s.total, 1138)
  assert.equal(s.effective + s.cacheRead, s.total) // 三分量自洽：有效 + 缓存读 = 合计
  // 脏字段/缺字段不把 NaN 带进看板（NaN 会让工具输出的 lossless-JSON 校验拒整条结果）
  const s2 = aggregateUsageSummary([mkTask({ id: 'z', usage: { total: 9, models: {} } })])
  assert.equal(s2.effective, 0)
  // Top8 条目带 有效 / 缓存读 拆分（仪表盘 title 直接用）
  const t0 = aggregateUsageSummary([mkTask({ id: 'a', usage: u1 })]).topTasks[0]
  assert.equal(t0.effective, 125); assert.equal(t0.cacheRead, 1000)
})

test('aggregateUsageSummary: byDay 双指标记账（{t,e} 逐日合并）+ 有效合计', () => {
  const a = mkTask({ id: 'a', usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 5, total: 920, runs: 2, models: {}, updatedAt: localIso(2026, 10, 2, 10, 0), byDay: { '2026-10-01': { t: 600, e: 60 }, '2026-10-02': { t: 320, e: 20 } } } })
  const b = mkTask({ id: 'b', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1, total: 30, runs: 1, models: {}, updatedAt: localIso(2026, 10, 2, 11, 0), byDay: { '2026-10-02': { t: 30, e: 3 } } } })
  const s = aggregateUsageSummary([a, b])
  assert.deepEqual(s.byDay, { '2026-10-01': { t: 600, e: 60 }, '2026-10-02': { t: 350, e: 23 } }) // 同日 t/e 各自累加、跨日分桶
  assert.equal(s.effective, 23) // (10+5+5) + (1+1+1)
  assert.equal(s.total, 950)
  assert.deepEqual(a.usage.byDay, { '2026-10-01': { t: 600, e: 60 }, '2026-10-02': { t: 320, e: 20 } }) // 纯函数：入参不被就地改写
})

test('aggregateUsageSummary: 老 number 形态 byDay 兼容（总量保留、有效值置 null 不猜）', () => {
  // 本轮之前的日账是裸 number（只有总量、没有逐 run 拆分）→ e 不可知必须 null，
  // 既不能让「近 7 天」整段消失（t 保留），也不能伪造一个有效值冒充。
  const legacy = mkTask({ id: 'old', usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 5, total: 920, runs: 1, models: {}, byDay: { '2026-10-01': 600 } } })
  const fresh = mkTask({ id: 'new', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1, total: 30, runs: 1, models: {}, byDay: { '2026-10-02': { t: 30, e: 3 } } } })
  const s = aggregateUsageSummary([legacy, fresh])
  assert.deepEqual(s.byDay, { '2026-10-01': { t: 600, e: null }, '2026-10-02': { t: 30, e: 3 } })
  assert.equal(s.byDay['2026-10-01'].e, null) // 不可知就是 null（不是 0、也不是 t）
  // 同一天既有老形态又有新形态 → 合并后 e 仍不可知（总量照常累加，不假装算得出）
  const mixOld = mkTask({ id: 'm1', usage: { total: 100, models: {}, byDay: { '2026-10-03': 40 } } })
  const mixNew = mkTask({ id: 'm2', usage: { input: 3, output: 2, cacheRead: 50, cacheWrite: 0, total: 55, models: {}, byDay: { '2026-10-03': { t: 55, e: 5 } } } })
  assert.deepEqual(aggregateUsageSummary([mixOld, mixNew]).byDay['2026-10-03'], { t: 95, e: null })
  // 逐项合计仍按各任务 usage 精确算（不受日账形态影响）
  assert.equal(aggregateUsageSummary([legacy, fresh]).effective, 23) // (10+5+5)+(1+1+1)
})

test('aggregateUsageSummary: effective 字段与 effectiveTokens 导出一致（口径单点定义）', () => {
  assert.equal(effectiveTokens({ input: 3, output: 4, cacheRead: 99, cacheWrite: 5 }), 12)
  assert.equal(effectiveTokens({ cacheRead: 99 }), 0)   // 只有缓存读 → 有效 0（缓存读不算真实消耗）
  assert.equal(effectiveTokens(null), 0)                 // 空值不炸
  assert.equal(effectiveTokens({ input: '3', output: 4 }), 7) // 字符串数字按数字算
  const s = aggregateUsageSummary([mkTask({ id: 'a', usage: { input: 3, output: 4, cacheRead: 99, cacheWrite: 5, total: 111, models: {} } })])
  assert.equal(s.effective, effectiveTokens({ input: 3, output: 4, cacheRead: 99, cacheWrite: 5 }))
})

// ===== 统计范围（range）过滤：范围过滤在 host 做（run 级数据 t.runs[i].usage + t.runs[i].at 只在 host）=====
// 测试侧独立构造 run 留账（含 at 时间戳 + 模型名），不复用实现内部函数——防「实现自证」。
// 数据源位置是硬口径（task-muwq9u04 的 bug 根因）：run 记录数组挂在**任务级 t.runs**，
// t.usage.runs 只是「结算次数」计数（number）——把计数当数组读会恒得空数组，范围过滤静默失效。
const mkRun = (at, model, u) => ({ role: 'worker', id: 'r-' + at + '-' + model, at, model, outcome: 'ok', usage: u })
const U = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite })

test('aggregateUsageSummary 范围过滤：逐 run 裁切（任务级 t.runs[]）+ 两端边界日 + 无 at 兜底', () => {
  const t1 = mkTask({
    id: 'a', title: 'A',
    // 四条 run 合计与任务级 usage 五分量一致（总 700），便于核对「范围内只算入选 run」
    runs: [
      mkRun(localIso(2026, 9, 30, 23, 0), 'm-old', U(1, 1, 8, 0)),   // 范围外（09-30）
      mkRun(localIso(2026, 10, 1, 8, 0), 'm-mid', U(3, 4, 100, 5)),  // 范围内（10-01）
      mkRun(localIso(2026, 10, 5, 9, 0), 'm-new', U(6, 15, 152, 5)), // 范围外（10-05）
      mkRun('', 'm-noat', U(100, 100, 100, 100))                     // 无 at 的老 run：裁不了 → 只在无范围时计入
    ],
    usage: { total: 700, input: 110, output: 120, cacheRead: 360, cacheWrite: 110, runs: 4, models: { 'm-x': 700 }, updatedAt: localIso(2026, 10, 2, 10, 0) }
  })
  const s = aggregateUsageSummary([t1], { from: '2026-10-01', to: '2026-10-03' })
  assert.equal(s.total, 112)                                   // 只有 10-01 那条计入（3+4+100+5）
  assert.equal(s.input, 3); assert.equal(s.output, 4)
  assert.equal(s.cacheRead, 100); assert.equal(s.cacheWrite, 5)
  assert.equal(s.effective, 12)                                // 有效 = 输入+输出+缓存写，不含缓存读
  assert.deepEqual(s.byModel, { 'm-mid': 112 })                // 模型分布随范围收窄（run 级重算）
  assert.deepEqual(s.byModelEff, { 'm-mid': 12 })              // 模型有效分摊同源（3+4+5）
  assert.deepEqual(s.topTasks.map(x => x.id), ['a'])
  assert.equal(s.topTasks[0].total, 112); assert.equal(s.topTasks[0].effective, 12)
  assert.equal(s.topTasks[0].runs, 1)                          // 「N 次 run」在范围下报入选 run 数（旧版此处置 0）
  // 边界包含性：只选范围首日 / 只选范围末日，两端都必须命中（闭区间口径）
  assert.equal(aggregateUsageSummary([t1], { from: '2026-10-01', to: '2026-10-01' }).total, 112)
  assert.equal(aggregateUsageSummary([t1], { from: '2026-10-05', to: '2026-10-05' }).total, 178)
  assert.equal(aggregateUsageSummary([t1], { from: '2026-10-05', to: '2026-10-05' }).effective, 26) // 6+15+5
  // 只给一端：from 不设上限 / to 不设下限
  assert.equal(aggregateUsageSummary([t1], { from: '2026-10-05' }).total, 178)
  assert.equal(aggregateUsageSummary([t1], { to: '2026-09-30' }).total, 10)
  // 范围内一条 run 都不入选（含「无 at 的老 run」）→ 该任务零贡献，不进 total 也不进 Top8
  const s0 = aggregateUsageSummary([t1], { from: '2020-01-01', to: '2020-01-02' })
  assert.equal(s0.total, 0); assert.deepEqual(s0.topTasks, []); assert.deepEqual(s0.byModel, {}); assert.deepEqual(s0.byModelEff, {})
  assert.deepEqual(s0.byDay, {}) // byDay 同步裁到范围内（范围外日不入）
})

test('aggregateUsageSummary 范围过滤：run 未记模型名时按任务级占比摊（模型键不消失、Σ 与入选总量对齐）', () => {
  // 真实数据形状：r.model 常是空串（派发未覆盖模型时模型名只落在日志里），而 t.usage.models 用的是
  // 日志记录的名字。若范围路径只认 r.model，这部分用量会凭空丢掉模型键——本机实测某个模型的整键
  // （`deepseek-flash`）在切范围后消失，且「按模型分布」加起来 ≠ 累计。
  const t = mkTask({
    id: 'a', title: 'A',
    runs: [
      mkRun(localIso(2026, 10, 5, 9, 0), 'm-known', U(10, 10, 0, 0)),  // 合计 20：run 上有模型名
      mkRun(localIso(2026, 10, 5, 10, 0), '', U(30, 30, 40, 0))        // 合计 100：无模型名（派发未覆盖）
    ],
    usage: { total: 120, input: 40, output: 40, cacheRead: 40, cacheWrite: 0, runs: 2, models: { 'm-known': 60, 'm-log': 60 }, updatedAt: localIso(2026, 10, 5, 10, 30) }
  })
  const s = aggregateUsageSummary([t], { from: '2026-10-05', to: '2026-10-05' })
  assert.equal(s.total, 120); assert.equal(s.effective, 80)          // 有效 = 40+40+0（缓存读 40 不计）
  assert.equal(Object.keys(s.byModel).length, 2)                     // 两个模型键都在（无名的按占比摊，不消失）
  assert.equal(s.byModel['m-known'], 70)                             // 精确 20 + 摊派 60*(100/120)=50
  assert.equal(s.byModel['m-log'], 50)
  const sum = Object.keys(s.byModel).reduce((n, k) => n + s.byModel[k], 0)
  assert.equal(sum, s.total)                                         // Σ byModel 与本次入选 total 对齐
  assert.equal(s.byModelEff['m-known'], 20 + Math.round(60 * (60 / 120))) // 有效：精确 20 + 摊派 30
  assert.equal(s.byModelEff['m-log'], 30)
  const sumE = Object.keys(s.byModelEff).reduce((n, k) => n + s.byModelEff[k], 0)
  assert.equal(sumE, s.effective)                                    // Σ byModelEff 与入选有效对齐
})

test('aggregateUsageSummary 范围过滤：topTasks 随范围收窄（回归：数据源错位时 Top8 与无范围逐字相同）', () => {
  // 活体实证的回归形状（task-muwq9u04）：任务最后一次结算落在范围内（updatedAt=10-02），
  // 但大头花在范围外（09-30）。修复前（把 t.usage.runs 计数当数组读 → 恒空数组 → 整任务退化成
  // updatedAt 单日近似）该任务整笔 150 计入、「Top8 主数字与无范围逐字相同」——正是用户看到的现象。
  const t = mkTask({
    id: 'a', title: 'A',
    runs: [
      mkRun(localIso(2026, 9, 30, 9, 0), 'm-old', U(30, 20, 50, 0)),  // 合计 100（有效 50）：范围外
      mkRun(localIso(2026, 10, 2, 9, 0), 'm-new', U(10, 10, 30, 0))   // 合计 50（有效 20）：范围内
    ],
    usage: { total: 150, input: 40, output: 30, cacheRead: 80, cacheWrite: 0, runs: 2, models: { 'm-x': 150 }, updatedAt: localIso(2026, 10, 2, 9, 30) }
  })
  const all = aggregateUsageSummary([t])
  assert.equal(all.total, 150)                                     // 无范围：整笔
  assert.equal(all.topTasks[0].total, 150); assert.equal(all.topTasks[0].effective, 70)
  const r = aggregateUsageSummary([t], { from: '2026-10-02', to: '2026-10-02' })
  assert.equal(r.total, 50)                                        // 范围内只算 10-02 那条
  assert.deepEqual(r.topTasks.map(x => x.total), [50])
  assert.deepEqual(r.topTasks.map(x => x.effective), [20])
  assert.equal(r.topTasks[0].runs, 1)
  assert.notDeepEqual(r.topTasks.map(x => x.total), all.topTasks.map(x => x.total)) // 逐字相同即回归（数据源错位）
  assert.deepEqual(r.byModel, { 'm-new': 50 })                     // 模型分布同口径收窄（不是 {'m-x':150}）
  assert.deepEqual(r.byModelEff, { 'm-new': 20 })
})

test('aggregateUsageSummary 范围过滤：无 range = 现状逐字不变（parity，含无 at 的 run 照旧全量计入）', () => {
  const tasks = [
    mkTask({
      id: 'a', usage: {
        total: 300, input: 10, output: 20, cacheRead: 260, cacheWrite: 10, runs: 2, models: { 'm-x': 300 },
        updatedAt: localIso(2026, 10, 2, 10, 0)
      },
      runs: [mkRun(localIso(2026, 9, 30, 23, 0), 'm-old', U(1, 1, 8, 0)), mkRun('', 'm-noat', U(100, 100, 100, 100))]
    }),
    mkTask({ id: 'legacy', usage: { total: 500, input: 0, output: 0, cacheRead: 500, cacheWrite: 0, runs: 1, models: {}, updatedAt: localIso(2026, 10, 2, 11, 0) } }),
    mkTask({ id: 'nodate', usage: { total: 9, input: 9, output: 0, cacheRead: 0, cacheWrite: 0, models: { 'm-z': 9 } } })
  ]
  const base = aggregateUsageSummary(tasks)
  assert.deepEqual(aggregateUsageSummary(tasks, { from: '', to: '' }), base)  // 空范围与不传等价（客户端空范围即此形态）
  assert.deepEqual(aggregateUsageSummary(tasks, {}), base)
  assert.deepEqual(aggregateUsageSummary(tasks, null), base)                  // 老调用形态（只传 tasks）逐字不变
  assert.equal(base.total, 809)                                               // 300 + 500 + 9（run 留账不参与无范围口径）
  assert.deepEqual(base.byModel, { 'm-x': 300, 'm-z': 9 })
  assert.deepEqual(base.byModelEff, { 'm-x': 40, 'm-z': 9 })                  // 无范围：任务级按「有效/总量」摊派
  assert.equal(base.effective, 49)                                            // 40(a) + 0(legacy 无分量) + 9
  // 无 runs 留账的老任务：无范围时照旧全量计入（parity 的关键一条）
  assert.ok(base.topTasks.some(x => x.id === 'legacy'))
})

test('aggregateUsageSummary 范围过滤：无 run 级留账的老任务按 updatedAt 本地日判范围（近似口径，无日可判则不计入）', () => {
  const legacy = mkTask({ id: 'old', usage: { total: 500, input: 0, output: 0, cacheRead: 500, cacheWrite: 0, runs: 1, models: {}, updatedAt: localIso(2026, 10, 2, 10, 30) } })
  const keep = aggregateUsageSummary([legacy], { from: '2026-10-02', to: '2026-10-02' })
  assert.equal(keep.total, 500)                                 // updatedAt 落在范围内 → 计入（近似归日）
  assert.equal(keep.effective, 0)                               // 老任务只有总量：有效消耗仍按分量算（全 0）
  assert.equal(aggregateUsageSummary([legacy], { from: '2026-10-03', to: '2026-10-03' }).total, 0) // 范围外 → 剔除
  const noDate = mkTask({ id: 'nodate', usage: { total: 9, models: {} } })
  assert.equal(aggregateUsageSummary([noDate], { from: '2026-10-01', to: '2026-10-31' }).total, 0) // 无日可判 → 宁可漏不错
  assert.equal(aggregateUsageSummary([noDate]).total, 9)        // 无范围时照旧计入（parity）
  // runs 条目存在但**都没落 usage**（老 run / 未结算）＝同样没有 run 级留账可裁 → 照样走 updatedAt 近似，
  // 不能因为「有 runs 数组」就判该任务对范围零贡献（那会把老卡的真实消耗整块吞掉）
  const bare = mkTask({
    id: 'bare', runs: [{ role: 'worker', id: 'r1', at: localIso(2026, 10, 2, 9, 0), outcome: 'completed' }],
    usage: { total: 77, input: 7, output: 7, cacheRead: 63, cacheWrite: 0, runs: 1, models: { 'm-bare': 77 }, updatedAt: localIso(2026, 10, 2, 9, 0) }
  })
  const bareKept = aggregateUsageSummary([bare], { from: '2026-10-02', to: '2026-10-02' })
  assert.equal(bareKept.total, 77)
  assert.deepEqual(bareKept.topTasks.map(x => x.id), ['bare'])
  assert.deepEqual(bareKept.byModelEff, { 'm-bare': 14 })       // 有效 7+7+0=14，任务级按占比摊派（77/77）
  assert.equal(aggregateUsageSummary([bare], { from: '2026-10-03', to: '2026-10-03' }).total, 0)
})

test('aggregateUsageSummary 范围过滤：byDay 同步裁到范围内（范围外日不入 byDay）', () => {
  const t1 = mkTask({
    id: 'a', usage: {
      total: 100, input: 0, output: 0, cacheRead: 100, cacheWrite: 0, runs: 2, models: {},
      updatedAt: localIso(2026, 10, 3, 10, 0),
      byDay: { '2026-09-30': { t: 40, e: 40 }, '2026-10-03': { t: 60, e: 60 } }
    }
  })
  const s = aggregateUsageSummary([t1], { from: '2026-10-01', to: '2026-10-31' })
  assert.deepEqual(s.byDay, { '2026-10-03': { t: 60, e: 60 } }) // 域外的 09-30 不进 byDay
  assert.equal(s.total, 100)                                    // 但任务级 total 不被 byDay 裁剪影响（无 runs 留账 → 按 updatedAt 判在范围内）
})

// ===== 统计范围接线（源码级断言）：host get-tasks 透传 + client 轮询带范围 + setRange 触发重拉 + UI 文案 =====
test('Token 区统计范围接线：get-tasks 接 range 透传 + fetchTasks 带范围 + setRange 触发重拉（源码级断言）', () => {
  const host = hostSrc()
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // host：get-tasks 把 args.range 透传给聚合（过滤在 host 做——run 级数据只在 host）
  assert.match(host, /aggregateUsageSummary\(d\.tasks, args && args\.range\)/)
  assert.match(host, /runs\[i\]\.usage/)                        // run 级留账（范围过滤的数据源，先于本次改动已在）
  // client：轮询带上当前统计范围；空范围不传 field（老 host 调用形态逐字不变）
  assert.match(cli, /var rgSend = activeRange\(\)/)
  assert.match(cli, /var rpcArgs = \(rgSend\.from \|\| rgSend\.to\) \? \{ range: rgSend \} : undefined/)
  assert.match(cli, /rpc\('get-tasks', rpcArgs\)/)
  // 范围守卫：响应回来时范围已变则丢弃旧范围的聚合，不覆盖新范围的值
  assert.match(cli, /if \(rgKey === \(rgNow\.from \+ '~' \+ rgNow\.to\)\) state\.usageSummary = \(d && d\.usageSummary\) \|\| null/)
  // RangeFilter：setRange 触发重拉（报告/总览本地现算，Token 区必须回 host 重算）
  assert.match(cli, /state\.dateRange = \{ from: from, to: to \}/)
  assert.match(cli, /if \(typeof fetchTasks === 'function'\) fetchTasks\(\)/)
  // UI：范围激活时 Token 区标题带标记 + 范围作用域 caption（今日/近 7 天固定口径写明）
  assert.match(cli, /'范围内: ' \+ rangeLabel\(\)/)
  assert.match(cli, /统计范围作用于按模型分布 \/ 任务消耗 Top 8 \/ 累计三分量/)
  assert.match(cli, /今日与「近 7 天」为固定口径，不随范围变化/)
})

// ===== Token 区三连修（task-muwq9u04）：范围过滤数据源 / 选范围即渲染 / 主数字口径（task-muxnqunk 已翻转为总量主显）=====
test('Token 区①：范围过滤读**任务级 t.runs[]**（run 级留账真实位置），不再误读 usage.runs 计数（源码级断言）', () => {
  const usageSrc = readFileSync(new URL('../lib/usage.mjs', import.meta.url), 'utf8')
  // 数据源必须取自 t.runs（数组，条目带 at/model/usage）；t.usage.runs 只是「结算次数」计数（number）
  assert.match(usageSrc, /var trs = Array\.isArray\(t\.runs\) \? t\.runs : \[\]/)
  assert.equal(/Array\.isArray\(uRaw\.runs\)/.test(usageSrc), false) // 回归根因：把计数当数组读 → 恒空 → 过滤静默失效
  assert.match(usageSrc, /if \(!dayInRange\(dayKeyOf\(r && r\.at\), range\)\) continue/)
  // topTasks 与 total 同一份入选 run 数据（同一过滤口径，不再各算一遍）
  assert.match(usageSrc, /models\[rm\] = \(models\[rm\] \|\| 0\) \+ ru\.total/)
  assert.match(usageSrc, /modelsE\[rm\] = \(modelsE\[rm\] \|\| 0\) \+ effectiveTokens\(ru\)/)
  assert.match(usageSrc, /s\.topTasks\.push\(\{ id: t\.id, title: t\.title, total: uTot, effective: uEff/)
})

test('Token 区②：usageSummary 变化纳入 notify 触发（选范围即渲染，JSON 串比对而非引用比）', () => {
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(cli, /var usageJsonPrev = JSON\.stringify\(state\.usageSummary \|\| null\)/) // 赋值前快照
  assert.match(cli, /var usageDelta = !tasksChanged && JSON\.stringify\(state\.usageSummary \|\| null\) !== usageJsonPrev/)
  assert.match(cli, /if \(cfgDelta \|\| usageDelta\) notify\(\)/)
  // 顺序：快照 → 范围守卫下赋值 → 比对（先赋值后快照会把 delta 恒置 false）
  const iSnap = cli.indexOf('var usageJsonPrev =')
  const iAssign = cli.indexOf('state.usageSummary = (d && d.usageSummary) || null')
  const iDelta = cli.indexOf('var usageDelta =')
  const iNotify = cli.indexOf('if (cfgDelta || usageDelta) notify()')
  assert.ok(iSnap >= 0 && iAssign > iSnap && iDelta > iAssign && iNotify > iDelta, 'usageSummary 变化检测顺序应为 快照→赋值→比对→notify')
  // 反向断言：不得用引用比较（host 每轮都返回新对象 → 引用比恒真 → 3s 轮询每轮重渲染，tasksHash 节约作废）
  assert.equal(/state\.usageSummary !== prevUsage/.test(cli), false)
})

test('setUsage 订阅锁（task-mv10lvud 遗留，task-mv1pqy27 补锁）：TopPanel update() 内 setUsage(state.usageSummary) 订阅存在（kernel.js 源 + client.js 产物各一条）', () => {
  const kernel = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 订阅声明：usageSummary 换新对象即触发 Token 区重渲染
  assert.match(kernel, /var _usg = useState\(state\.usageSummary\), setUsage = _usg\[1\]/)
  assert.match(built, /var _usg = useState\(state\.usageSummary\), setUsage = _usg\[1\]/)
  // 锁定「订阅存在于 update() 监听器内」：setUsage(state.usageSummary) 落在 update() 函数体、
  // 且该 update 被 listeners.push 注册（而非游离在组件渲染路径上）
  assert.match(kernel, /function update\(\) \{[\s\S]*?setUsage\(state\.usageSummary\)[\s\S]*?\}; listeners\.push\(update\)/)
  assert.match(built, /function update\(\) \{[\s\S]*?setUsage\(state\.usageSummary\)[\s\S]*?\}; listeners\.push\(update\)/)
})

test('Token 区③：Top8 与模型分布主数字取总量（有效进 title），caption 写明口径翻转（源码级断言）', () => {
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 口径翻转（task-muxnqunk，用户 2026-10-07 裁决「算总的吧」，推翻 task-muwq9u04 有效主显）：
  // 主数字一律总量（含缓存读），有效消耗退悬浮 title
  // 模型分布：主数字取 host 的 byModel（总量），byModelEff（有效分摊）退 title（缺字段标「有效不可知」）
  assert.match(cli, /var tt = u\.byModel\[m\] \|\| 0/)
  assert.match(cli, /value: m\.total, max: maxM/)
  assert.match(cli, /：总量 ' \+ String\(m\.total\) \+ ' tokens（含缓存读）/)
  // Top8：主数字取 topTasks[].total，effective 退 title
  assert.match(cli, /var ee = \(typeof x\.effective === 'number'\) \? x\.effective : null/)
  assert.match(cli, /value: x\.total, max: maxT/)
  assert.match(cli, /（总量 ' \+ String\(x\.total\) \+ ' tokens（含缓存读）/)
  // 排序按显示口径（总量）降序：条形长度与行序一致
  assert.match(cli, /\}\)\.sort\(function \(a, b\) \{ return b\.total - a\.total \}\)/)
  // 标题与 caption 写明口径翻转（主数字均为总量，有效见悬浮）
  assert.match(cli, /'按模型分布（总量）'/)
  assert.match(cli, /'任务消耗 Top 8（总量）'/)
  assert.match(cli, /主数字（今日 \/ 近 7 天 \/ 模型分布 \/ Top 8 \/ 主窗口行）均为总量口径（含缓存读）/)
  assert.match(cli, /有效消耗（input\+output\+cacheWrite，不含缓存读）见悬浮 title/)
})

test('Token 区③：byModelEff 与累计有效自洽（模型有效分摊不出「模型合计 > 累计有效」的矛盾）', () => {
  const a = mkTask({ id: 'a', usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 5, total: 920, runs: 1, models: { 'm-1': 920 } } })
  const b = mkTask({ id: 'b', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1, total: 30, runs: 1, models: { 'm-1': 10, 'm-2': 20 } } })
  const s = aggregateUsageSummary([a, b])
  assert.equal(s.effective, 23)                       // (10+5+5) + (1+1+1)
  const sum = Object.keys(s.byModelEff).reduce((n, k) => n + s.byModelEff[k], 0)
  assert.ok(Math.abs(sum - s.effective) <= Object.keys(s.byModelEff).length, 'Σ byModelEff 应与 effective 自洽（仅四舍五入误差）：' + sum)
  assert.deepEqual(s.byModelEff, { 'm-1': 21, 'm-2': 2 })  // a 的 20 全归 m-1；b 的 3 按 10:20 摊成 1:2 → m-1 合计 21
  assert.equal(s.byModel['m-1'], 930)
})

test('README 双份同步记录 Token 口径（总量主显 / 近 7 天 / 有效退悬浮 / 派发口径边界）', () => {
  const pkg = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.equal(pkg, root) // 两份 README 必须字节一致（npm run sync-readme 的约束）
  // 口径翻转（task-muxnqunk）：主数字均为总量口径（含缓存读），有效消耗退悬浮
  for (const s of ['今日总量', '近 7 天', '有效消耗 = 输入 + 输出 + 缓存写（不含缓存读）', '不含主窗口对话', 'run 级留账', '统计范围', '主数字均为总量口径', 't.runs[]']) {
    assert.ok(pkg.includes(s), 'README 应记录口径：' + s)
  }
})

test('Token run 级留账：accumulateRunUsage 把本次用量写回对应 t.runs 条目（源码级断言）', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  // 五分量原样写回 runs 条目：任何维度（按天/按模型/按阶段）都能从 runs 精确重建，不必回头猜
  assert.match(dsp, /if \(Array\.isArray\(t\.runs\)\)/)
  assert.match(dsp, /if \(String\(t\.runs\[ri\] && t\.runs\[ri\]\.id\) === String\(rec\.id\)\)/)
  assert.match(dsp, /t\.runs\[ri\]\.usage = \{ input: u\.input \|\| 0, output: u\.output \|\| 0, cacheRead: u\.cacheRead \|\| 0, cacheWrite: u\.cacheWrite \|\| 0, total: u\.total \|\| 0 \}/)
  assert.match(dsp, /break/) // 命中即停（同一 runId 只记一次）
  // 倒序查找 + 找不到就跳过：runs 条目由 recordRunHistory 先行写入、closeRunHistory 更新结局，正常必存在
  assert.match(dsp, /for \(var ri = t\.runs\.length - 1; ri >= 0; ri--\)/)
  // 有效消耗口径单点定义（host 侧），byDay 双指标记账与它同源
  assert.match(dsp, /function effectiveOf\(u\) \{/)
  assert.match(dsp, /return \(u\.input \|\| 0\) \+ \(u\.output \|\| 0\) \+ \(u\.cacheWrite \|\| 0\)/)
  assert.match(dsp, /var eff = effectiveOf\(u\)/)
  // byDay 双指标：总 t / 有效 e 各自累加；老 number 形态脏值就地收敛成对象（不把老字段形态写坏）
  assert.match(dsp, /if \(!cell \|\| typeof cell !== 'object'\) cell = \{ t: Number\(cell\) \|\| 0, e: 0 \}/)
  assert.match(dsp, /t\.usage\.byDay\[dk\] = cell/)
})

test('readRunUsage: run 不存在 / 日志目录不可读 → null（优雅降级，不抛错）', () => {
  assert.equal(readRunUsage('no-such-run-' + Date.now()), null)
  assert.equal(readRunUsage(''), null)
  assert.equal(findRunLog('no-such-run-' + Date.now()), null)
})

test('readRunUsage: v4 多帧日志真实解析（临时目录造帧 → usage 逐帧累加 + 模型取自 request/context）', (t) => {
  // 只在宿主支持 zstd 压缩时构造样本（Node >= 22.15 / 23.8）；否则跳过，避免 CI 假红
  if (typeof zlib.zstdCompressSync !== 'function') { t.skip('zstdCompressSync unavailable'); return }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'))
  const runId = 'run-usage-test'
  const dir = path.join(root, 'bucket', runId)
  fs.mkdirSync(dir, { recursive: true })
  const frameOf = (events) => zlib.zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8'))
  // 三帧：帧 1 只有模型与一次 usage；帧 2 是半截坏帧（截断，必须被跳过而不是抛错）；帧 3 又一次 usage + 无 usage 事件
  const f1 = frameOf([
    { type: 'request/context', data: { model: 'deepseek-flash' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 1000, cacheWriteTokens: 0, totalTokens: 1107 } } }
  ])
  const good = frameOf([{ type: 'assistant/message', data: { usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 5, totalTokens: 12 } } }, { type: 'step/end', data: {} }])
  const bad = good.subarray(0, Math.max(1, good.length - 6)) // 截断帧：解压必失败
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([f1, bad, good]))
  const u = readRunUsage(runId, root)
  assert.equal(u.input, 103); assert.equal(u.output, 11); assert.equal(u.cacheRead, 1000)
  assert.equal(u.cacheWrite, 5); assert.equal(u.total, 1119); assert.equal(u.model, 'deepseek-flash')
  // 只有坏帧 / 无 usage 事件 → null（不是 0 值对象，调用方按「暂无数据」降级）
  const dir2 = path.join(root, 'bucket', 'run-no-usage'); fs.mkdirSync(dir2, { recursive: true })
  fs.writeFileSync(path.join(dir2, 'session.v4.jsonl.zstd'), frameOf([{ type: 'step/end', data: {} }]))
  assert.equal(readRunUsage('run-no-usage', root), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('Token 消耗接线：settleRun 结算累加 + 按模型小计 + get-tasks 聚合 + 仪表盘区块（源码级断言）', () => {
  const host = hostSrc()
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(host, /await accumulateRunUsage\(sid, rec\)/)                    // settleRun（及手动终止）结算路径调用
  assert.match(host, /t\.usage\.models\[mk\] = \(t\.usage\.models\[mk\] \|\| 0\) \+ u\.total/) // 按模型小计累加
  assert.match(host, /rec\.model \|\| u\.model/)                                // 模型 key 来源：派发覆盖 > 日志记录
  assert.match(host, /inputTokens/)                                            // 字段名与真实 v4 日志一致
  assert.match(host, /d\.usageSummary = aggregateUsageSummary\(d\.tasks, args && args\.range\)/)     // get-tasks 现算聚合（带统计范围）
  assert.match(cli, /React\.createElement\(TokenUsage, \{ usage: state\.usageSummary \}\)/) // 仪表盘插入消耗区
  assert.match(cli, /state\.usageSummary = \(d && d\.usageSummary\) \|\| null/) // 客户端取数
  assert.match(cli, /'⛁ ' \+ fmtTokens\(t\.usage\.total\)/)                     // 进行中/已完成卡片显示本任务累计
})

test('Token 日账接线：dispatch 记 byDay 双指标（本地日）+ 仪表盘总量口径（源码级断言）', () => {
  const host = hostSrc()
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(host, /cell\.t = \(Number\(cell\.t\) \|\| 0\) \+ u\.total/) // 结算时记一笔日账总量
  assert.match(host, /cell\.e = \(Number\(cell\.e\) \|\| 0\) \+ eff/)       // 同一笔记一笔有效消耗
  assert.match(host, /var dk = localDayKey\(\)/)                           // 键取结算时刻本地日
  // 本地日口径：localDayKey 必须用本地 getters 拼（含 getFullYear/getMonth/getDate），不得用 toISOString
  const dispatchSrc = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const dkBody = dispatchSrc.match(/function localDayKey\(d\) \{[\s\S]{0,300}?\n    \}/)
  assert.ok(dkBody, 'dispatch.mjs 应定义 localDayKey')
  assert.match(dkBody[0], /getFullYear\(\)/)
  assert.match(dkBody[0], /getMonth\(\) \+ 1/)
  assert.match(dkBody[0], /getDate\(\)/)
  assert.equal(/toISOString/.test(dkBody[0]), false) // UTC 会让晚间消耗落到次日
  assert.match(host, /if \(!t\.usage\.byDay\) t\.usage\.byDay = \{\}/)            // 老任务就地补日账（不改老字段形态）
  assert.match(host, /lc\.t \+= u\.total; lc\.e = null; s\.byDay\[lk\] = lc/)     // 存量兜底归 updatedAt 本地日（只有总量，e 不可知）
  // 仪表盘：大数字=今日总量（含缓存读）+「其中有效 X」小字 + 累计三分量 + 近 7 天总量柱 + 口径 caption
  // （口径翻转 task-muxnqunk：主显总量，有效退悬浮/次要位；旧口径灰柱规则退役——见翻转测试负断言）
  assert.match(cli, /function lastNDays\(n\)/)
  assert.match(cli, /var todayCell = dayOf\(byDay\[todayKey\]\)/)                 // 今日缺省退化（无日账不误报）
  assert.match(cli, /'tokens（今日总量，含缓存读）'/)                               // 大数字口径 = 总量（含缓存读）
  assert.match(cli, /'其中有效 '/)                                                // 有效消耗退居次要小字（对照总量）
  assert.match(cli, /'累计（本看板） 有效 '/)                                      // 累计三分量：有效
  assert.match(cli, /' · 缓存读 '/)                                              // 累计三分量：缓存读
  assert.match(cli, /' · 合计 '/)                                                // 累计三分量：合计
  assert.match(cli, /'近 7 天（总量，含缓存读）'/)
  assert.match(cli, /k\.slice\(5\) \+ '：总量 ' \+ String\(v\)/)                  // 条形 title：MM-DD：总量 N tok
  assert.match(cli, /' \/ 有效 ' \+ String\(c\.e\) \+ ' tok'/)                     // 条形 title 补有效对照
  assert.match(cli, /口径：累计与 Top 8 仅看板派发的 Worker\/Verifier run（= 一次执行）消耗/)       // 口径边界明示（累计/Top8 仅 run 口径）
  assert.match(cli, /主窗口行=本会话对话消耗，与看板派发口径并列不混入/)                 // 主窗口行并列不混入（task-muwsol23 起单列展示）
  assert.match(cli, /主数字（今日 \/ 近 7 天 \/ 模型分布 \/ Top 8 \/ 主窗口行）均为总量口径（含缓存读）/) // 主数字口径翻转（task-muxnqunk）
  assert.match(cli, /其中缓存读 ' \+ String\(x\.cacheRead \|\| 0\)/)                  // Top8 title 补 缓存读 拆分（有效进 title）
  assert.match(cli, /background: isToday \? C\.brand : C\.nested/)                 // 今天高亮 brand、其余浅底（灰柱规则已退役）
  assert.match(cli, /hasDayData \? React\.createElement/)                         // 7 天全空不渲染该区
})

// ===== Token 口径三连修（task-muwsnyqv）：byDay 闭区间 / byDayFull 固定口径 / 旧口径不冒充 =====
test('Token 三连修①：byDay 范围 to 闭区间 + 入选 run 重建日账（from=to=今天 时 byDay 有今天）', () => {
  // 活体实证形状：range{from:'2026-10-05',to:'2026-10-06'} 时 total/effective 含今天而 byDay 整丢——
  // 病根是 picked 路径合成的 u 丢 byDay/updatedAt。修复后按入选 run 的 at 本地日逐日重建。
  const t1 = mkTask({
    id: 'a', title: 'A',
    runs: [
      mkRun(localIso(2026, 10, 5, 8, 0), 'm-x', U(3, 4, 100, 5)),   // 10-05：t=112 e=12
      mkRun(localIso(2026, 10, 6, 9, 0), 'm-x', U(6, 15, 152, 5))   // 10-06（今天）：t=178 e=26
    ],
    usage: { total: 290, input: 9, output: 19, cacheRead: 252, cacheWrite: 10, runs: 2, models: { 'm-x': 290 }, updatedAt: localIso(2026, 10, 6, 10, 0), byDay: { '2026-10-05': { t: 112, e: 12 }, '2026-10-06': { t: 178, e: 26 } } }
  })
  const s = aggregateUsageSummary([t1], { from: '2026-10-05', to: '2026-10-06' })
  assert.equal(s.total, 290)                                                        // run 级过滤：两天都计入
  assert.deepEqual(s.byDay, { '2026-10-05': { t: 112, e: 12 }, '2026-10-06': { t: 178, e: 26 } }) // to 端闭区间：10-06 不丢
  // 两端边界各一条：from=to=边界日 → 当日必在 byDay（run 级重建，日 key 与范围过滤同口径 r.at）
  assert.deepEqual(aggregateUsageSummary([t1], { from: '2026-10-06', to: '2026-10-06' }).byDay, { '2026-10-06': { t: 178, e: 26 } })
  assert.deepEqual(aggregateUsageSummary([t1], { from: '2026-10-05', to: '2026-10-05' }).byDay, { '2026-10-05': { t: 112, e: 12 } })
  // 范围内日账与入选 total 自洽（Σ byDay.t === s.total，run 级重建不丢账）
  const sum = Object.keys(s.byDay).reduce((n, k) => n + s.byDay[k].t, 0)
  assert.equal(sum, s.total)
  // run 级重建的 e 恒为已知有效值（五分量俱全），不出现 null
  assert.equal(s.byDay['2026-10-06'].e, 26)
})

test('Token 三连修②：byDayFull 未过滤全量与 byDay 并存（今日/近 7 天固定口径数据源）+ 客户端接线', () => {
  const t1 = mkTask({
    id: 'a', title: 'A',
    runs: [
      mkRun(localIso(2026, 10, 5, 8, 0), 'm-x', U(3, 4, 100, 5)),
      mkRun(localIso(2026, 10, 6, 9, 0), 'm-x', U(6, 15, 152, 5))
    ],
    usage: { total: 290, input: 9, output: 19, cacheRead: 252, cacheWrite: 10, runs: 2, models: { 'm-x': 290 }, updatedAt: localIso(2026, 10, 6, 10, 0), byDay: { '2026-10-05': { t: 112, e: 12 }, '2026-10-06': { t: 178, e: 26 } } }
  })
  const s = aggregateUsageSummary([t1], { from: '2026-10-06', to: '2026-10-06' })
  assert.deepEqual(s.byDay, { '2026-10-06': { t: 178, e: 26 } })                                  // byDay：范围内
  assert.deepEqual(s.byDayFull, { '2026-10-05': { t: 112, e: 12 }, '2026-10-06': { t: 178, e: 26 } }) // byDayFull：全量不受裁
  // 范围外任务也进 byDayFull（固定口径不随范围），但不进 total/byDay
  const tOut = mkTask({ id: 'out', usage: { total: 50, input: 1, output: 1, cacheRead: 48, cacheWrite: 0, runs: 1, models: {}, updatedAt: localIso(2026, 10, 1, 9, 0) } })
  const s2 = aggregateUsageSummary([t1, tOut], { from: '2026-10-06', to: '2026-10-06' })
  assert.equal(s2.total, 178)                                              // 范围外任务不进 total
  assert.deepEqual(s2.byDay, { '2026-10-06': { t: 178, e: 26 } })          // 也不进范围内 byDay
  assert.deepEqual(s2.byDayFull['2026-10-01'], { t: 50, e: null })         // 但进 byDayFull（存量兜底归 updatedAt，e 不可知=null）
  // 无范围：byDayFull 与 byDay 内容一致（parity，老 host 行为逐字不变）
  const s3 = aggregateUsageSummary([t1])
  assert.deepEqual(s3.byDayFull, s3.byDay)
  // 老 number 形态日账：byDayFull 同样 e=null 不猜（不冒充有效值）
  const legacy = mkTask({ id: 'old', usage: { total: 600, models: {}, byDay: { '2026-10-01': 600 } } })
  assert.deepEqual(aggregateUsageSummary([legacy]).byDayFull, { '2026-10-01': { t: 600, e: null } })
  // 纯函数：入参对象未被就地改写
  assert.deepEqual(t1.usage.byDay, { '2026-10-05': { t: 112, e: 12 }, '2026-10-06': { t: 178, e: 26 } })
  // 接线（源码级）：host 聚合骨架带 byDayFull；客户端今日/近 7 天读 byDayFull，老 host 缺字段退化 byDay
  const usageSrc = readFileSync(new URL('../lib/usage.mjs', import.meta.url), 'utf8')
  assert.match(usageSrc, /byDayFull: \{\}/)
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(cli, /var byDay = \(u\.byDayFull && typeof u\.byDayFull === 'object'\) \? u\.byDayFull : \(\(u\.byDay && typeof u\.byDay === 'object'\) \? u\.byDay : \{\}\)/)
})

// ===== Token 口径翻转（task-muxnqunk，用户 2026-10-07 裁决「算总的吧」）：总量主显 / 有效退悬浮 / 灰柱退役 =====
// 推翻 task-muwq9u04 的「有效消耗主显」：主数字一律总量 t（含缓存读），有效消耗 e 退居 title/次要位；
// task-muwsnyqv ③ 的旧口径灰柱规则顺势退役（t 恒有值，e===null 的日子现在就是正常柱）。
// 不动的：模型表现区与质量趋势区保持有效口径（效率指标语义），报告导出分列口径不动。
test('Token 口径翻转：总量主显（含缓存读）+ 有效退 title + 旧口径灰柱规则退役（源码级断言）', () => {
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 近 7 天柱形：按总量归一与画柱（t 恒有值，e===null 的旧口径日就是正常柱）
  assert.match(cli, /if \(dc\.t > maxDay\) maxDay = dc\.t/)                   // maxDay 按总量归一
  assert.match(cli, /var v = c\.t \|\| 0/)                                    // 柱高取总量
  assert.match(cli, /background: isToday \? C\.brand : C\.nested/)            // 今天高亮 brand，其余浅底（无灰柱分支）
  // 今日大数字：显总量 todayCell.t（byDayFull 口径不变），有效退 title / 次要小字
  assert.match(cli, /fmtTokens\(todayCell\.t\)/)
  assert.match(cli, /'tokens（今日总量，含缓存读）'/)
  // caption 新文案：主数字均为总量口径（含缓存读）；有效消耗见悬浮
  assert.match(cli, /主数字（今日 \/ 近 7 天 \/ 模型分布 \/ Top 8 \/ 主窗口行）均为总量口径（含缓存读）/)
  assert.match(cli, /有效消耗（input\+output\+cacheWrite，不含缓存读）见悬浮 title/)
  // 负断言：旧口径灰柱规则（task-muwsnyqv ③）顺势退役——legacy 分支 / 灰柱图例 / 今日「—」防护全删
  assert.equal(/var legacy = /.test(cli), false)
  assert.equal(/var todayLegacy/.test(cli), false)
  assert.equal(/hasLegacy/.test(cli), false)
  assert.equal(/灰柱 = 旧口径数据/.test(cli), false)
  assert.equal(/旧口径数据（仅总量/.test(cli), false)
  assert.equal(/今日有效消耗不可知/.test(cli), false)
  assert.equal(/（近似：老日账只有总量）/.test(cli), false)
  // README 双份记录口径翻转
  const pkg = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(pkg.includes('主数字均为总量口径'), 'README 应记录 Token 区口径翻转（总量主显）')
})

// ===== 调研 ROI 行 token 有效口径（task-muupnnq5）=====
// 客户端 bundle 无模块系统（只注入 React），故 ROI 判定在 dashboard.js 内联为 roiTokenOf；
// 这里把该函数原文切出来执行，直接断言真行为而不是断言注释。
function dashboardFnOf(name) {
  const src = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
  const start = src.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'lib/client/dashboard.js 应定义 ' + name)
  const end = src.indexOf('\n    function ', start + 1)
  return src.slice(start, end > start ? end : undefined)
}
function evalDashboardFn(name, deps) {
  const body = dashboardFnOf(name) + '\n' + (deps || []).map(dashboardFnOf).join('\n')
  return new Function(body + '\nreturn ' + name)()
}
// 造一张「已领取→已完成」的 ROI 候选卡（usage 由调用方给）
function mkRoiTask(i, hasRes, usage) {
  const base = Date.parse('2026-01-01T00:00:00Z')
  return mkTask({
    id: 'roi' + i,
    status: 'resolved',
    createdAt: new Date(base + i * 60000).toISOString(),
    claimedAt: new Date(base + i * 60000 + 60000).toISOString(),
    resolvedAt: new Date(base + i * 60000 + 60000 + 3600000).toISOString(), // 执行恒为 1h
    context: hasRes ? { files: ['docs/a.md'] } : {},
    usage: usage || null,
  })
}

test('ROI token 口径：有分量字段取有效消耗（不含缓存读），与 total 明确不同（源码级实执）', () => {
  const roiTokenOf = evalDashboardFn('roiTokenOf')
  // 有效 = 输入 1000 + 输出 500 + 缓存写 200 = 1700；含缓存读的 total 竟是 91700（缓存读撑高 ~54 倍）
  assert.deepEqual(roiTokenOf({ input: 1000, output: 500, cacheWrite: 200, cacheRead: 90000, total: 91700 }), { tok: 1700, fallback: false })
  // 分量只有一项也算：缓存写单独存在时有效值就是它（不等于含缓存读的 total）
  assert.deepEqual(roiTokenOf({ cacheWrite: 300, cacheRead: 90000, total: 90300 }), { tok: 300, fallback: false })
  // 全 0 分量 + 有 total：退化为含缓存读的合计并标 fallback（老/存量结算卡的近似口径）
  assert.deepEqual(roiTokenOf({ input: 0, output: 0, cacheWrite: 0, cacheRead: 90000, total: 90000 }), { tok: 90000, fallback: true })
  assert.deepEqual(roiTokenOf({ total: 5000 }), { tok: 5000, fallback: true })
  // 无任何结算记录 → null（不参与均值，不拉低样本）；脏值/缺 usage 同样降级
  assert.deepEqual(roiTokenOf({ input: 0, total: 0 }), { tok: null, fallback: false })
  assert.deepEqual(roiTokenOf(null), { tok: null, fallback: false })
  assert.deepEqual(roiTokenOf({ input: 'x', total: -5 }), { tok: null, fallback: false })
})

test('ROI 分组均值：computeStats 用有效消耗取均值，token 口径与 Token 区一致（源码级实执）', () => {
  const computeStats = evalDashboardFn('computeStats', ['roiTokenOf'])
  // 有调研 2 张：(1000+0+200)=1200 与 (300+100+0)=400 → 均值 800（若退回旧口径 total，均值会是 45850）
  const tasks = [
    mkRoiTask(0, true, { input: 1000, output: 0, cacheWrite: 200, cacheRead: 90000, total: 91200 }),
    mkRoiTask(1, true, { input: 300, output: 100, cacheWrite: 0, cacheRead: 0, total: 400 }),
    // 无调研 2 张：一张只有 total（老卡 → 兜底 + fallback 计数），一张无 usage（不参与均值）
    mkRoiTask(2, false, { total: 5000 }),
    mkRoiTask(3, false, null),
  ]
  const st = computeStats(tasks)
  assert.ok(st.roi, '两组各 ≥1 且总样本 ≥4 时应产出 roi')
  assert.equal(st.roi.yes.n, 2)
  assert.equal(st.roi.yes.tok, 800)
  assert.equal(st.roi.yes.tokN, 2)
  assert.equal(st.roi.yes.tokFallbackN, 0)
  assert.equal(st.roi.no.n, 2)
  assert.equal(st.roi.no.tok, 5000)  // 无 usage 的卡被跳过：均值就是那张老卡的 total
  assert.equal(st.roi.no.tokN, 1)
  assert.equal(st.roi.no.tokFallbackN, 1) // 老卡兜底要能被 UI 标 ~（ResearchRoiRow 读该字段）
  assert.equal(st.roi.no.execMs, 3600000)
})

test('ROI 口径注释/接线：client.js 产物与 host 端判定同源（源码级断言）', () => {
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(cli, /var tk = roiTokenOf\(t\.usage\)/)                       // ROI 行不再直接读 t.usage.total
  assert.equal(/var tok = \(t\.usage && typeof t\.usage\.total === 'number'/.test(cli), false)
  assert.match(cli, /tokN: toks\.length, tokFallbackN: fb/)                  // 分组均值带样本数与兜底张数
  assert.match(cli, /口径 = 有效消耗（输入\+输出\+缓存写，不含缓存读）/)          // title 标注口径来源
  // host 侧同款判定（单卡口径的规范实现，client 内联以免引入模块系统）
  assert.deepEqual(taskEffectiveTokens({ input: 10, output: 5, cacheWrite: 2, cacheRead: 900, total: 917 }), { tok: 17, fallback: false, total: 917 })
  assert.deepEqual(taskEffectiveTokens({ total: 917 }), { tok: 917, fallback: true, total: 917 })
  assert.deepEqual(taskEffectiveTokens(null), { tok: null, fallback: false, total: null })
})

// ===== 学习飞轮 v1：候选教训信号 + feedbackEnabled 开关 + 软召回 =====
test('cfg: feedbackEnabled 默认开（缺字段/脏值都算开），只有显式 false 才关', () => {
  assert.equal(core.cfg({}).feedbackEnabled, true)
  assert.equal(core.cfg({ feedbackEnabled: true }).feedbackEnabled, true)
  assert.equal(core.cfg({ feedbackEnabled: false }).feedbackEnabled, false)
  assert.equal(core.cfg({ feedbackEnabled: 'no' }).feedbackEnabled, true) // 脏值不关（默认开）
})

test('seed/normalizeBoard: feedbackEnabled 新看板默认 true，老看板读路径补 true，显式 false 保留', () => {
  assert.equal(core.seed('s1').feedbackEnabled, true)
  assert.equal(core.normalizeBoard({ tasks: [] }).feedbackEnabled, true)                       // 老看板无字段 → 默认开
  assert.equal(core.normalizeBoard({ tasks: [], feedbackEnabled: false }).feedbackEnabled, false)
  assert.equal(core.normalizeBoard({ tasks: [], feedbackEnabled: 'x' }).feedbackEnabled, true) // 脏值收敛成默认开
})

test('lessonText: 三段式（场景/明细段/来源），明细段截 300 字', () => {
  const t = core.lessonText('任务「X」(t1) 被 Verifier 驳回', [['错误做法', '理'.repeat(400)]], '任务 t1 · 2026-01-01')
  const lines = t.split('\n')
  assert.equal(lines[0], '场景: 任务「X」(t1) 被 Verifier 驳回')
  assert.ok(lines[1].indexOf('错误做法: ') === 0)
  assert.equal(lines[1].slice('错误做法: '.length).length, 300) // 驳回理由截 300 字
  assert.equal(lines[2], '来源: 任务 t1 · 2026-01-01')
  // 仲裁形态：疑问 + 裁决结论两段
  const a = core.lessonText('任务「Y」(t2) 的歧义裁决', [['疑问', '该走 A 还是 B？'], ['裁决结论', '走 B']], '任务 t2')
  assert.match(a, /^场景: /)
  assert.match(a, /疑问: 该走 A 还是 B？/)
  assert.match(a, /裁决结论: 走 B/)
  assert.match(a, /来源: 任务 t2$/)
})

test('pushLesson: 落 kind=lesson-candidate（by 默认 system），同 at / 同内容前缀判重', () => {
  const t = { messages: [] }
  const txt = core.lessonText('场景', [['错误做法', '驳回理由']], 'src')
  assert.equal(core.pushLesson(t, txt, 'T1', 'system'), true)
  assert.equal(core.pushLesson(t, txt, 'T1', 'system'), false) // 同 at → 判重（同一事件多路径触发）
  assert.equal(core.pushLesson(t, txt, 'T2', 'system'), false) // 同内容前缀 → 判重
  assert.equal(t.messages.length, 1)
  assert.equal(t.messages[0].kind, 'lesson-candidate')
  assert.equal(t.messages[0].at, 'T1'); assert.equal(t.messages[0].by, 'system')
  const other = core.lessonText('另一个场景', [['错误做法', '别的理由']], 'src2')
  assert.equal(core.pushLesson(t, other), true)                 // 不同事件照常落
  assert.equal(t.messages[1].by, 'system')                      // by 缺省 system
  assert.equal(core.pushLesson({ messages: [] }, ''), false)    // 空文本不落
})

test('buildWorkerPrompt: 软召回引导随 feedbackEnabled 开关（关则整句消失）', () => {
  const t = mkTask({ id: 't1', title: 'X' })
  assert.match(core.buildWorkerPrompt(t), /先检索相关历史教训再动手/)                  // 缺省（未传）＝默认开
  assert.match(core.buildWorkerPrompt(t, '', true), /先检索相关历史教训再动手/)
  assert.doesNotMatch(core.buildWorkerPrompt(t, '', false), /历史教训/)               // 关 → 不出现
  assert.doesNotMatch(core.buildWorkerPrompt(t, '', false), /笔记\/记忆类工具/)
  assert.match(core.LESSON_RECALL_HINT, /note_search/) // 引导里点名可用的检索工具类型（只是举例）
})

test('学习飞轮接线：两处触发点 + push-lesson 开关拦截 + prompt/客户端软召回（源码级断言）', () => {
  const host = hostSrc()
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  // 候选教训两处触发：Verifier 驳回（文本通道 + 工具通道 + GUI RPC）与主窗口仲裁结论
  assert.match(host, /pushRejectLesson\(d, t, vsecs\.verifySummary \|\| trimmed, t\.verification\.at\)/)
  assert.match(host, /if \(!approved\) pushRejectLesson\(d, t, \(args\.summary \|\| ''\)/)
  assert.match(host, /if \(args\.verdict === 'rejected'\) \{ t\.verification = \{ verdict: 'rejected'[^}]*\}; pushRejection\(t, args\.comment, '', t\.verification\.at, actor\); pushRejectLesson\(d, t, args\.comment\); r\.hint = REJECT_REDISPATCH_HINT \}/) // verify-task RPC：驳回包落 messages + 候选教训 + 驳回重派 hint 同分支挂载（task-mutnj3a4 / task-muvg15p5）
  assert.match(host, /pushArbitrationLesson\(d, t, escQ, answer \|\| '', arbAt\)/)
  // 生成前一律过 feedbackEnabled 总开关（关掉 = 不生成、不推）
  assert.equal((host.match(/if \(!cfg\(d\)\.feedbackEnabled\) return false/g) || []).length, 2)
  // 沉淀推送通道：关 → 明确拒绝；开 → followup 给主窗口 agent 自行选择存储工具
  assert.match(host, /handle\('push-lesson'/)
  assert.match(host, /if \(!cfg\(d\)\.feedbackEnabled\) return \{ ok: false, error: 'feedback disabled' \}/)
  assert.match(host, /请用你可用的笔记\/记忆工具（如 note_manage）沉淀，或评估后忽略。/)
  assert.match(host, /root\.followup\(makeMsg\('📚 \[任务看板\] 候选教训沉淀请求/)
  // 开关透出：get-tasks 返回体 + set-board-config 写入 + 缓存同步（systemPrompt 同步读取）
  assert.match(host, /d\.feedbackEnabled = cfg\(d\)\.feedbackEnabled/)
  assert.match(host, /args\.key === 'feedbackEnabled'/)
  assert.match(host, /feedbackCache\[sid\] = d\.feedbackEnabled/)
  assert.match(host, /feedbackCache\[sid\] = nd\.feedbackEnabled !== false/)
  // 软召回：Worker prompt 与 Team 提示词都以开关为条件拼接（pack=瘦身清单本体，随首条 prompt 注入）
  assert.match(host, /buildWorkerPrompt\(t, pack, cfg\(dsnap\)\.feedbackEnabled\)/)
  assert.match(host, /feedbackOn\(String\(agent\.id\)\) \? '\\n' \+ LESSON_RECALL_HINT/)
  assert.match(coreSrc, /if \(feedbackEnabled !== false\) p \+= '\\n\\n' \+ LESSON_RECALL_HINT/)
  // 客户端：开关读取 + 设置区 checkbox + 候选卡片「沉淀」按钮 + 关闭即整块不渲染
  assert.match(cli, /state\.feedbackEnabled = cfgKnobOf\(d, 'feedbackEnabled'\)/)
  assert.match(cli, /setCfg\('feedbackEnabled', e\.target\.checked\)/) // 乐观路径（task-muw5uudk）
  assert.match(cli, /'lesson-candidate': \{ color: C\.brand, label: '候选教训', icon: 'book-open' \}/)
  assert.match(cli, /rpc\('push-lesson', \{ taskId: props\.taskId, text: String\(m\.text \|\| ''\) \}\)/)
  assert.match(cli, /if \(!state\.feedbackEnabled\) msgs = msgs\.filter\(function \(m\) \{ return m && m\.kind !== 'lesson-candidate' \}\)/)
  // 零耦合红线：不出现任何笔记插件的模块导入/服务获取/API 调用
  // （注释里的历史提及与 prompt 文案里「举例可用工具名」不算耦合）
  assert.doesNotMatch(host, /from 'dsh-notes|require\('dsh-notes|ctx\.get\('notes'\)|uiWorkspace\.openNote|note_manage\(|note_search\(/)
  assert.doesNotMatch(coreSrc, /from 'dsh-notes|ctx\.get\('notes'\)|uiWorkspace\.openNote|note_manage\(|note_search\(/)
  assert.doesNotMatch(cli, /from 'dsh-notes|ctx\.get\('notes'\)|uiWorkspace\.openNote|note_manage\(|note_search\(/)
})

// ===== 架构自省 L1·UI：仪表盘「架构健康」提示区接线（源码级断言；纯函数信号本身见 health.test.mjs）=====
test('架构健康接线：get-tasks 返回 healthHints + 仪表盘 HealthHints 区缺省兼容渲染', () => {
  const host = hostSrc()
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(host, /d\.healthHints = __rh\.hints\.concat\(computeHealthHints\(d\.tasks\)\)/) // host 每次请求现算返回（零存储）；运行时 hint（task-muxhrkbg）拼在静态信号前面
  assert.match(cli, /function HealthHints\(\)/)                          // 仪表盘提示区组件
  assert.match(cli, /React\.createElement\(HealthHints\)/)               // 挂进 Dashboard（统计卡行下方、Token 消耗区上方）
  assert.match(cli, /Array\.isArray\(d\.healthHints\)/)                  // 缺省兼容：老 host 无字段/非数组 → 按空处理
  assert.match(cli, /if \(!hints\.length\) return null/)                 // 空数组 → 整块不渲染（零残留）
  assert.match(cli, /'架构健康'/)                                        // 区标题
  assert.match(cli, /warn \? C\.warn : infoColor/)                       // warn=琥珀 / info=蓝灰 两级配色
  assert.match(cli, /dsw-alias-state-business-primary/)                  // info 蓝灰用 DSH 现有 business 信息色（色板无独立 info 档）
})

// ===== 史诗父卡语义层：父卡自动流转 + childStats 聚合 =====
test('parentKickOnDispatch: 子任务派发时 pending 父卡 → in-progress（记 ah），返回父卡', () => {
  const p = mkTask({ id: 'epic', status: 'pending' })
  const c = mkTask({ id: 'c1', parentId: 'epic' })
  const d = mkBoard([p, c])
  const r = core.parentKickOnDispatch(d, c)
  assert.equal(r, p)
  assert.equal(p.status, 'in-progress')
  const h = p.history[p.history.length - 1]
  assert.equal(h.from, 'pending'); assert.equal(h.to, 'in-progress')
  assert.match(h.note, /首个子任务派发，史诗进入推进态/)
})

test('parentKickOnDispatch: 已在 in-progress 不重放 / verifying 不动', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'epic' }); const c2 = mkTask({ id: 'c2', parentId: 'epic' })
  const d = mkBoard([p, c1, c2])
  assert.equal(core.parentKickOnDispatch(d, c1), null) // 已推进态 → 不重放
  assert.equal(p.history.length, 0)
  assert.equal(p.status, 'in-progress')
  // verifying 父卡（全子任务 resolved 后的验收态）同样不动
  const pv = mkTask({ id: 'epic2', status: 'verifying' })
  const cv = mkTask({ id: 'c3', parentId: 'epic2' })
  const d2 = mkBoard([pv, cv])
  assert.equal(core.parentKickOnDispatch(d2, cv), null)
  assert.equal(pv.status, 'verifying'); assert.equal(pv.history.length, 0)
})

test('parentKickOnDispatch: draft 父卡不动（草稿是刻意的人工态）', () => {
  const p = mkTask({ id: 'epic', status: 'draft' })
  const c = mkTask({ id: 'c1', parentId: 'epic' })
  const d = mkBoard([p, c])
  assert.equal(core.parentKickOnDispatch(d, c), null)
  assert.equal(p.status, 'draft'); assert.equal(p.history.length, 0)
})

test('parentKickOnDispatch: 无 parentId / 父卡不存在 → null，无副作用', () => {
  const solo = mkTask({ id: 'solo' }); const d = mkBoard([solo])
  assert.equal(core.parentKickOnDispatch(d, solo), null)
  const orphan = mkTask({ id: 'c1', parentId: 'ghost' }); const d2 = mkBoard([orphan])
  assert.equal(core.parentKickOnDispatch(d2, orphan), null)
})

test('aggregateChildStats: 空板 / 无父子关系 → 空对象（不出键）', () => {
  assert.deepEqual(core.aggregateChildStats([]), {})
  assert.deepEqual(core.aggregateChildStats(null), {})
  assert.deepEqual(core.aggregateChildStats(undefined), {})
  const d = [mkTask({ id: 'a' }), mkTask({ id: 'b', status: 'in-progress' })]
  assert.deepEqual(core.aggregateChildStats(d), {})
})

test('aggregateChildStats: 聚合口径 total/settled/active/activeTitle', () => {
  const kids = [
    mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' }),
    mkTask({ id: 'c2', parentId: 'epic', status: 'in-progress', title: '进行中甲' }),
    mkTask({ id: 'c3', parentId: 'epic', status: 'pending' }),
    mkTask({ id: 'c4', parentId: 'epic', status: 'in-progress', title: '进行中乙' }),
    mkTask({ id: 'c5', parentId: 'epic', status: 'verifying' }),
    mkTask({ id: 'c6', parentId: 'epic', status: 'blocked' }),
  ]
  const s = core.aggregateChildStats(kids).epic
  assert.equal(s.total, 6)      // 子任务全计（含归档，本例无归档）
  assert.equal(s.settled, 1)    // 仅 resolved（verifying 不算了结）
  assert.equal(s.resolved, 1)   // 兼容别名同值
  assert.equal(s.active, 2)     // in-progress 数
  assert.equal(s.activeTitle, '进行中甲') // 第一个 in-progress 子任务标题（看板顺序）
})

// 反馈 task-muupgfot（史诗进度归档消失）：归档子任务必须计入 total + settled，否则归档一张子卡
// 会让进度分母缩水（0/10 → 0/9）、分子永不前进，且全归档父卡整个从卡片上消失。
test('aggregateChildStats: 归档子任务计入 total+settled（10 卡归 2 → 2/10，不再退化 0/8）', () => {
  const ten = []
  for (let i = 1; i <= 10; i++) ten.push(mkTask({ id: 'k' + i, parentId: 'epic', status: i <= 2 ? 'archived' : 'pending' }))
  const s10 = core.aggregateChildStats(ten).epic
  assert.equal(s10.total, 10)   // 归档不减分母（旧口径被 continue 跳过 → 8）
  assert.equal(s10.settled, 2)  // 归档计入分子（旧口径 → 0）
  assert.equal(s10.resolved, 2) // 兼容别名与 settled 同值（老前端/老断言按 resolved 读仍成立）
  assert.equal(s10.active, 0)

  // 全归档父卡仍出键（史诗收尾后卡片徽章不凭空消失，留档可查）
  const allArch = [mkTask({ id: 'z1', parentId: 'e2', status: 'archived' }), mkTask({ id: 'z2', parentId: 'e2', status: 'archived' })]
  assert.deepEqual(core.aggregateChildStats(allArch).e2, { total: 2, settled: 2, resolved: 2, active: 0, activeTitle: '' })

  // 多父卡各自成键 + 混合状态（cancelled 也属了结集：人已显式放弃该子任务范围）
  const tasks = [
    mkTask({ id: 'a1', parentId: 'p1', status: 'resolved' }),
    mkTask({ id: 'a2', parentId: 'p1', status: 'archived' }),
    mkTask({ id: 'a3', parentId: 'p1', status: 'in-progress', title: 'p1活跃' }),
    mkTask({ id: 'b1', parentId: 'p2', status: 'archived' }),
    mkTask({ id: 'b2', parentId: 'p2', status: 'cancelled' }),
    mkTask({ id: 'd1', parentId: 'p3', status: 'pending' }),
    mkTask({ id: 'd2', parentId: 'p3', status: 'resolved' }),
  ]
  const stats = core.aggregateChildStats(tasks)
  assert.deepEqual(Object.keys(stats).sort(), ['p1', 'p2', 'p3']) // 全归档的父卡也出键（不再「键自然消失」）
  assert.deepEqual(stats.p1, { total: 3, settled: 2, resolved: 2, active: 1, activeTitle: 'p1活跃' })
  assert.deepEqual(stats.p2, { total: 2, settled: 2, resolved: 2, active: 0, activeTitle: '' })
  assert.deepEqual(stats.p3, { total: 2, settled: 1, resolved: 1, active: 0, activeTitle: '' })
})

test('aggregateChildStats: in-progress/verifying/pending 未了结不计 settled；archived 永不算 active', () => {
  const kids = [
    mkTask({ id: 'c1', parentId: 'epic', status: 'in-progress', title: '甲' }),
    mkTask({ id: 'c2', parentId: 'epic', status: 'verifying' }),
    mkTask({ id: 'c3', parentId: 'epic', status: 'blocked' }),
    mkTask({ id: 'c4', parentId: 'epic', status: 'pending' }),
    mkTask({ id: 'c5', parentId: 'epic', status: 'draft' }),
    mkTask({ id: 'c6', parentId: 'epic', status: 'archived' }),
  ]
  const s = core.aggregateChildStats(kids).epic
  assert.equal(s.total, 6)
  assert.equal(s.settled, 1)   // 只有归档那张算了结；进行中/验证中/阻塞/待办/草稿都不算
  assert.equal(s.active, 1)    // 归档不冒充在跑
  assert.equal(s.activeTitle, '甲')
})

test('aggregateChildStats: 归档口径注释写明僵尸卡近似 + 旧「归档跳过」已消灭（源码级断言）', () => {
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  // 近似口径必须写在注释里：v1.7.1 起 archive-task 放行「无活跃 run 的 in-progress 僵尸卡」，
  // 故 archived 不再严格等于「曾经完成」——但归档仍是人的显式了结，进度上计入是对的
  assert.match(coreSrc, /archive-task 放行「无活跃 run 的 in-progress 僵尸卡」/)
  assert.match(coreSrc, /进度只增不减/)
  // 分子口径单一出处（resolved | cancelled | archived）
  assert.match(coreSrc, /if \(t\.status === 'resolved' \|\| t\.status === 'cancelled' \|\| t\.status === 'archived'\) \{ s\.settled\+\+; s\.resolved\+\+ \}/)
  // 防回归：聚合循环里不得再按 archived 跳过
  assert.doesNotMatch(coreSrc, /aggregateChildStats[\s\S]{0,600}?status === 'archived'\) continue/)
  assert.match(coreSrc, /if \(!t \|\| !isb\(t\)\) continue/)
  // 与父卡自动收口口径（isChildSettled）现已同口径：archived 计入终态集，注释里写明（反馈 n-muw706h1uymy）
  assert.match(coreSrc, /与 isChildSettled（父卡自动收口口径）现已同口径/)
  // 僵尸放行本身的门禁注释仍在 rpc.mjs（口径来源不悬空）
  const rpcSrc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  assert.match(rpcSrc, /in-progress 且无活跃 run\s+→ 放行（parentKick 僵尸态出清/)
})

test('FamilySection: 子任务清单含归档（灰化 + 「已归档」徽章 + 沉底，不排 archived）（源码级断言）', () => {
  const src = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  // 清单按 parentId 现算，**不再**附加 status !== 'archived' 过滤（反馈 task-muupgfot：归档后详情里子任务消失）
  assert.match(src, /var kids = state\.tasks\.filter\(function \(x\) \{ return x\.parentId === task\.id \}\)/)
  assert.doesNotMatch(src, /x\.parentId === task\.id && x\.status !== 'archived'/)
  // 沉底排序：已归档排后（稳定排序，未归档保持既有顺序）
  assert.match(src, /\.sort\(function \(a, b\) \{ return \(a\.status === 'archived' \? 1 : 0\) - \(b\.status === 'archived' \? 1 : 0\) \}\)/)
  // 行尾「已归档」徽章 + 灰化（降透明度 + 次要文字色），点击行为不变（仍可进详情看留档）
  assert.match(src, /'已归档'/)
  assert.match(src, /opacity: arch \? 0\.55 : 1/)
  assert.match(src, /color: arch \? C\.text2 : C\.brand/)
  assert.match(src, /onClick: function \(\) \{ jump\(x\.id\) \}/)
  // 标题行分子口径与卡片 📦 徽章同源（settled，含归档），不再用只数 resolved 的旧分子
  assert.match(src, /var settledN = kids\.filter\(function \(x\) \{ return x\.status === 'resolved' \|\| x\.status === 'cancelled' \|\| x\.status === 'archived' \}\)\.length/)
  assert.match(src, /'📦 子任务 · ' \+ settledN \+ '\/' \+ kids\.length \+ ' 已了结'/)
  // 卡片徽章/进度条读 settled（老宿主无该字段时回退 resolved，缺省兼容）
  const card = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  assert.match(card, /var csDone = cs \? \(typeof cs\.settled === 'number' \? cs\.settled : cs\.resolved\) : 0/)
  assert.match(card, /'📦 史诗 · ' \+ csDone \+ '\/' \+ cs\.total/)
  assert.match(card, /Math\.round\(\(csDone \/ cs\.total\) \* 100\)/)
  assert.doesNotMatch(card, /cs\.resolved \+ '\/' \+ cs\.total/) // 旧读法已全部换成 csDone
  // 组装产物里也要有（require build-client 先跑；npm pretest 已保证）
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /'已归档'/)
  assert.match(built, /csDone/)
})

test('详情「运行」区：渲染活跃 run 子会话 id（childId）+ 标注「对应子代理列表同名条目」（源码级断言）', () => {
  const src = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  // 运行区门禁：仅 in-progress + claimedBy（有活跃 run）才渲染，claimedBy 即该 run 的子会话 id（childId）
  assert.match(src, /task\.status === 'in-progress' && task\.claimedBy \?/)
  assert.match(src, /'子会话 id: ' \+ task\.claimedBy/)
  assert.match(src, /对应子代理列表同名条目/)
  // 组装产物里也要有（npm pretest 已保证 build-client 先跑）
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /'子会话 id: ' \+ task\.claimedBy/)
  assert.match(built, /对应子代理列表同名条目/)
})

test('README 双份：运行区子会话 id 归属标注 + git 纪律红线各补一句且逐字一致', () => {
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('对应子代理列表同名条目') >= 0, 'README 缺运行区子会话 id 归属标注说明')
  assert.ok(r1.indexOf('git 纪律红线') >= 0, 'README 缺 git 纪律红线说明')
})

// ===== 归档 tab 数据源口径（反馈 n-muyg3e0m9z7i）：归档 tab 空 vs 仪表盘 68 根修 =====
// 旧 ArchiveView 数据源走独立 state.archived/fetchArchived：异步填库却未接入 TopPanel 的 notify 更新项，
// 归档 tab 打开后停在「暂无归档任务」空态；仪表盘「已归档」计数来自 state.tasks（get-tasks 全量含归档）。
// 修法：ArchiveView 直接读 state.tasks.filter(status==='archived')，与仪表盘同源全量 + 归档时间倒序 + 顶部注条数。
test('ArchiveView: 归档数据源读 state.tasks 全量（对齐仪表盘「已归档」），不依赖 state.archived/fetchArchived（源码级断言）', () => {
  const src = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  // 数据源必须与仪表盘同源：state.tasks.filter(status==='archived' || status==='cancelled')（get-tasks 全量含归档；取消通道卡2：cancelled 归入本 tab 可见可恢复）
  assert.match(src, /var archived = state\.tasks\.filter\(function \(t\) \{ return t\.status === 'archived' \|\| t\.status === 'cancelled' \}\)/)
  // 反向断言：不得再读独立 state.archived.filter（异步填库不触发重渲染 → tab 恒空）
  assert.doesNotMatch(src, /state\.archived\.filter/)
  // 不得再挂「空则 fetchArchived」的 useEffect（独立数据源已移除）
  assert.doesNotMatch(src, /useEffect\(function \(\) \{ if \(!state\.archived\.length\) fetchArchived\(\) \}/)
  // 不得有任何 7 日窗口 cutoff（老归档 >7 天被整批滤掉是原根因候选形态之一）
  assert.doesNotMatch(src, /cutoff/)
  assert.doesNotMatch(src, /7 \* 24 \* 60|7 \* 86400000|604800000/)
  // 顶部注明条数：共 N 条；含已取消时补「（含已取消 X 条）」括号段，取消为 0 时省略（task-mv1pqy27 文案口径修正）
  assert.match(src, /var cancelledCount = archived\.filter\(function \(t\) \{ return t\.status === 'cancelled' \}\)\.length/)
  assert.match(src, /'共 ' \+ archived\.length \+ ' 条' \+ \(cancelledCount > 0 \? '（含已取消 ' \+ cancelledCount \+ ' 条）' : ''\)/)
  // 归档/取消时间倒序：archivedAt 优先，回退 cancelledAt/resolvedAt/createdAt
  assert.match(src, /function archTs\(t\) \{ return t\.archivedAt \|\| t\.cancelledAt \|\| t\.resolvedAt \|\| t\.createdAt \|\| '' \}/)
  // 取消卡可见标记：行内「已取消」chip + 时间戳回退 cancelledAt
  assert.match(src, /t\.status === 'cancelled' \? React\.createElement\('span', \{ title: '已取消（可恢复待办）'/)
  assert.match(src, /\(t\.archivedAt \|\| t\.cancelledAt\) \? ago\(t\.archivedAt \|\| t\.cancelledAt\)/)
  // 组装产物同步（pretest 已跑 build-client）
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /var archived = state\.tasks\.filter\(function \(t\) \{ return t\.status === 'archived' \|\| t\.status === 'cancelled' \}\)/)
  assert.match(built, /'共 ' \+ archived\.length \+ ' 条' \+ \(cancelledCount > 0 \? '（含已取消 ' \+ cancelledCount \+ ' 条）' : ''\)/)
})

// ===== 史诗 hooks=agent run（task-muuw4ov7）：host 生命周期接线（pre 闸门 / post 收口 / 薄框架 prompt / 主窗口限定写入）=====
// 设计定稿：hook 点 = 一次**真实 agent 运行**（不是声明式命令）；点位可选（epic 未声明 hooks 则全链路零变化）；
// 薄框架 + agent 自行决策 + 歧义上报兜底；commit/push 不入任何默认形态；hooks 只许主窗口设置。
const HOOK_TASK = (over) => mkTask(Object.assign({ id: 'epic', title: '史诗甲', status: 'in-progress', hooks: { pre: { enabled: true, prompt: '准备环境', state: 'idle', runId: null } } }, over || {}))

test('normalizeHooks: 浅校验形状（enabled 缺省 true / prompt 必填 / state 枚举 / 未知键忽略 / null 清除）', () => {
  const ok = core.normalizeHooks({ pre: { prompt: '准备' } })
  assert.deepEqual(ok.hooks.pre, { enabled: true, prompt: '准备', state: 'idle', runId: null }) // enabled 缺省 true
  assert.equal(core.normalizeHooks({ pre: { prompt: 'p', enabled: false } }).hooks.pre.enabled, false)
  assert.equal(core.normalizeHooks(null).hooks, null)                       // null = 清除
  assert.equal(core.normalizeHooks({}).hooks.pre, undefined)                 // 空对象 = 什么都不声明
  assert.deepEqual(core.normalizeHooks({ pre: null }).hooks, { pre: null })  // 显式 null 原样穿出（撤点位的意图不能在归一化阶段被吃掉）
  // prompt 必填（薄框架契约本体由主窗口写，空 prompt 等于没契约 → 宁早报错）
  assert.match(core.normalizeHooks({ pre: { prompt: '   ' } }).error, /prompt 不能为空/)
  assert.match(core.normalizeHooks({ pre: { prompt: 123 } }).error, /prompt 必须是字符串/)
  // 形状与枚举
  assert.match(core.normalizeHooks('x').error, /必须是对象/)
  assert.match(core.normalizeHooks({ pre: 'x' }).error, /hooks\.pre 必须是对象/)
  assert.equal(core.normalizeHooks({ pre: { prompt: 'p', state: 'running' } }).hooks.pre.state, 'running') // 合法枚举放行
  assert.ok(core.normalizeHooks({ pre: { prompt: 'p', state: 'bogus' } }).error, 'state 必须是 ') // 非法枚举拒绝
  assert.match(String(core.normalizeHooks({ pre: { prompt: 'p', state: 'bogus' } }).error), /state 必须是/)
  assert.equal(core.normalizeHooks({ pre: { prompt: 'p', state: 'done', runId: 'r1' } }).hooks.pre.state, 'done') // 重启后人工恢复现场
  // 未知键忽略（前向兼容：老 host 存下的字段不炸）
  assert.deepEqual(Object.keys(core.normalizeHooks({ pre: { prompt: 'p', 未知: 1 } }).hooks.pre).sort(), ['enabled', 'prompt', 'runId', 'state'])
  // 超长 prompt 截断到 4000
  assert.equal(core.normalizeHooks({ pre: { prompt: 'x'.repeat(5000) } }).hooks.pre.prompt.length, 4000)
})

test('mergeHooks: 浅合并（未提交点位保留 / { pre: null } 只撤 pre / null 全清）', () => {
  const prev = { pre: { enabled: true, prompt: 'A', state: 'done', runId: null }, post: { enabled: true, prompt: 'B', state: 'idle', runId: null } }
  const onlyPre = core.mergeHooks(prev, core.normalizeHooks({ pre: { prompt: 'A2' } }).hooks)
  assert.equal(onlyPre.post.prompt, 'B')   // 未提交的点位保留原值（task_update 只想改 prompt 时不必重复整条）
  assert.equal(onlyPre.pre.prompt, 'A2')
  assert.equal(onlyPre.pre.state, 'idle')  // 重新提交 pre = 重置该点位状态机（人改了契约就当重跑）
  const dropPre = core.mergeHooks(prev, { pre: null }) // { pre: null } 撤点位
  assert.equal(dropPre.pre, undefined); assert.equal(dropPre.post.prompt, 'B')
  assert.deepEqual(core.mergeHooks(prev, null), prev)  // 语义同「不提交」
})

test('preHookGate: 未声明/未启用/done 放行；idle/running/failed 拦下（串行闸门）', () => {
  assert.deepEqual(core.preHookGate(null), { pass: true, reason: 'none' })                       // 老 epic 无 hooks → 放行
  assert.deepEqual(core.preHookGate(mkTask({})), { pass: true, reason: 'none' })
  assert.equal(core.preHookGate(mkTask({ hooks: { pre: { enabled: false, state: 'idle' } } })).pass, true) // 未启用 → 放行
  assert.deepEqual(core.preHookGate(HOOK_TASK({ hooks: { pre: { enabled: true, state: 'done' } } })), { pass: true, reason: 'done' })
  assert.deepEqual(core.preHookGate(HOOK_TASK()), { pass: false, reason: 'idle' })                // 待跑 → 本轮不派子任务
  assert.deepEqual(core.preHookGate(HOOK_TASK({ hooks: { pre: { enabled: true, state: 'running' } } })), { pass: false, reason: 'running' })
  assert.deepEqual(core.preHookGate(HOOK_TASK({ hooks: { pre: { enabled: true, state: 'failed' } } })), { pass: false, reason: 'failed' })
  assert.equal(core.hookOn(HOOK_TASK(), 'pre'), true)
  assert.equal(core.hookOn(HOOK_TASK(), 'post'), false)  // 只声明了 pre
})

test('pickDispatch: pre 闸门未 done → 该 epic 的子任务一张都不派；done 后放行（核心回归）', () => {
  const epi = HOOK_TASK() // pre=idle
  const c1 = mkTask({ id: 'c1', parentId: 'epic', status: 'pending' })
  const c2 = mkTask({ id: 'c2', parentId: 'epic', status: 'pending' })
  const other = mkTask({ id: 'solo', status: 'pending' }) // 无关卡片不受影响
  const d = mkBoard([epi, c1, c2, other])
  assert.deepEqual(core.pickDispatch(d, 5, 0, null).pendings.map(t => t.id), ['solo'])
  // idle → running（hook run 在跑）：仍然一张都不派
  epi.hooks.pre.state = 'running'
  assert.deepEqual(core.pickDispatch(d, 5, 0, null).pendings.map(t => t.id), ['solo'])
  // failed（已 blocked 待人裁决）：绝不自动放行
  epi.hooks.pre.state = 'failed'
  assert.deepEqual(core.pickDispatch(d, 5, 0, null).pendings.map(t => t.id), ['solo'])
  // done（前置准备完成）：下轮起子任务正常派发
  epi.hooks.pre.state = 'done'
  assert.deepEqual(core.pickDispatch(d, 5, 0, null).pendings.map(t => t.id).sort(), ['c1', 'c2', 'solo'])
})

test('pickDispatch: 老 epic（无 hooks）+ 只在 post 声明 → 与既有行为零变化', () => {
  const epi = mkTask({ id: 'epic', status: 'in-progress' })   // 无 hooks
  const c = mkTask({ id: 'c1', parentId: 'epic', status: 'pending' })
  assert.deepEqual(core.pickDispatch(mkBoard([epi, c]), 5, 0, null).pendings.map(t => t.id), ['c1'])
  const epi2 = mkTask({ id: 'e2', status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: 'idle' } } })
  const c2 = mkTask({ id: 'c2', parentId: 'e2', status: 'pending' })
  assert.deepEqual(core.pickDispatch(mkBoard([epi2, c2]), 5, 0, null).pendings.map(t => t.id), ['c2']) // post 不拦前置派发
})

test('maybeAutoCloseParent 接线③：post 未收口 → 不转 verifying，只置 running + 待跑标记', () => {
  const epi = mkTask({ id: 'epic', status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: 'idle' } } })
  const c = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  const d = mkBoard([epi, c])
  const p = core.maybeAutoCloseParent(d, c)
  assert.equal(p, epi)
  assert.equal(epi.status, 'in-progress')          // 关键：延迟 verifying（不再直接收口）
  assert.equal(epi.hooks.post.pending, true)       // 等 poolCycle 见标记 spawn hook-post
  assert.equal(epi.hooks.post.state, 'running')
  assert.equal(epi.resolution, undefined)          // 未收口就绝不算已收口（旧实现此处会被写成 'all subtasks resolved'）
  assert.match(epi.history[epi.history.length - 1].note, /post hook 收口未完成，延迟 verifying/)
  // 幂等：已在 post 收口途中重复调用仍不转 verifying
  assert.equal(core.maybeAutoCloseParent(d, c), epi)
  assert.equal(epi.status, 'in-progress')
})

test('maybeAutoCloseParent 接线③：post 已 done → 正常转 verifying；failed → 回归安静态', () => {
  const mk = (state, pending) => {
    const e = mkTask({ id: 'epic', status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: state, pending: pending } } })
    const c = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
    return { e, d: mkBoard([e, c]), c }
  }
  const a = mk('done', undefined)
  assert.equal(core.maybeAutoCloseParent(a.d, a.c), a.e)
  assert.equal(a.e.status, 'verifying')            // 收口完成 → 交人验收
  assert.equal(a.e.resolution, 'all subtasks resolved')
  const b = mk('failed', undefined)
  assert.equal(core.maybeAutoCloseParent(b.d, b.c), null)  // 收口失败已 blocked 待人裁决，绝不自动收口
  assert.equal(b.e.status, 'in-progress')
})

test('maybeAutoCloseParent: 老 epic（无 hooks）全链路零变化（防回归）', () => {
  const e = mkTask({ id: 'epic', status: 'in-progress' })
  const c = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  const d = mkBoard([e, c])
  assert.equal(core.maybeAutoCloseParent(d, c), e)
  assert.equal(e.status, 'verifying')              // 未声明 post → 维持现状直接收口
  assert.equal(e.hooks, undefined)
})

test('applyHookSettle 接线②：pre 完成 → done（串行闸门打开）', () => {
  const epi = HOOK_TASK({ hooks: { pre: { enabled: true, prompt: '准备', state: 'running', runId: 'run-p', pending: false } } })
  const d = mkBoard([epi])
  const r = core.applyHookSettle(d, 'epic', 'pre', true, '准备完成', 'run-p', '')
  assert.equal(r.preDone, true)
  assert.equal(epi.hooks.pre.state, 'done')
  assert.equal(epi.hooks.pre.runId, null)          // run 归零（结束即失效）
  assert.equal(epi.status, 'in-progress')          // pre 不影响 epic 自身状态
  assert.match(epi.history[epi.history.length - 1].note, /hooks\.pre: running → done/)
  assert.equal(core.applyHookSettle(d, 'epic', 'pre', true, 'x', 'run-p', '').already, true) // 幂等
})

test('applyHookSettle 接线②：pre 失败 → state=failed + epic blocked + 歧义上报（不自动重试）', () => {
  const epi = HOOK_TASK({ hooks: { pre: { enabled: true, prompt: '准备', state: 'running', runId: 'run-p' } } })
  const d = mkBoard([epi])
  const r = core.applyHookSettle(d, 'epic', 'pre', false, '', 'run-p', '模型不可用')
  assert.equal(r.blocked, true)
  assert.equal(epi.hooks.pre.state, 'failed')
  assert.equal(epi.status, 'blocked')
  assert.match(epi.escalation.question, /hooks\.pre（前置准备）失败：模型不可用/)
  assert.match(epi.escalation.question, /重试.*跳过.*放弃/s)
  assert.match(epi.lastError, /hooks\.pre run 失败/)
  assert.equal(epi.messages[epi.messages.length - 1].kind, 'escalation')
  // 已 blocked 后子任务仍被闸门拦住（failed 不放行）
  const c = mkTask({ id: 'c1', parentId: 'epic', status: 'pending' })
  d.tasks.push(c)
  assert.equal(core.pickDispatch(d, 5, 0, null).pendings.length, 0)
  // 幂等：已被裁决前重复结算不覆盖 escalation
  const esc0 = epi.escalation
  assert.equal(core.applyHookSettle(d, 'epic', 'pre', false, '', 'run-p', 'again').already, true)
  assert.equal(epi.escalation, esc0)
})

test('applyHookSettle 接线②：post 完成 → post=done + epic 转 verifying（收口完成）', () => {
  const epi = HOOK_TASK({ status: 'in-progress', hooks: { post: { enabled: true, prompt: '收口', state: 'running', runId: 'run-q', pending: false } } })
  const d = mkBoard([epi])
  const r = core.applyHookSettle(d, 'epic', 'post', true, '已总结', 'run-q', '')
  assert.equal(r.closed, true)
  assert.equal(epi.hooks.post.state, 'done')
  assert.equal(epi.status, 'verifying')            // 收口完成才交人验收
  assert.equal(epi.resolution, 'hooks.post settled')
  assert.match(epi.history[epi.history.length - 1].note, /post hook 收口完成/)
})

test('applyHookSettle 接线②：post 失败 → failed + blocked + 歧义；点位被删则只收口', () => {
  const epi = HOOK_TASK({ hooks: { post: { enabled: true, prompt: '收口', state: 'running', runId: 'run-q' } } })
  const d = mkBoard([epi])
  assert.equal(core.applyHookSettle(d, 'epic', 'post', false, '', 'run-q', '超时').blocked, true)
  assert.equal(epi.hooks.post.state, 'failed'); assert.equal(epi.status, 'blocked')
  assert.match(epi.escalation.question, /hooks\.post（收口）失败：超时/)
  // hooks 被人删除 → 只收口（already），不凭空造状态
  const epi2 = mkTask({ id: 'e2', status: 'in-progress' })
  assert.equal(core.applyHookSettle(mkBoard([epi2]), 'e2', 'post', true, '', 'r', '').already, true)
  assert.equal(epi2.status, 'in-progress')
  // epic 不存在 → null（调用方静默跳过）
  assert.equal(core.applyHookSettle(mkBoard([]), 'ghost', 'pre', true, '', 'r', ''), null)
})

test('buildHookPrompt: 薄框架模板（契约 + epic 上下文 + 子任务清单 + 歧义兜底）', () => {
  const epi = mkTask({
    id: 'epic', title: '史诗甲', description: '把 X 做完',
    hooks: { pre: { enabled: true, prompt: '先把依赖装好', state: 'idle' } },
  })
  epi.context = { instructions: '别碰 client' }
  const kids = [mkTask({ id: 'c1', title: '子一', status: 'pending', pipeline: 'full' }), mkTask({ id: 'c2', title: '子二', status: 'resolved' })]
  const p = core.buildHookPrompt(epi, 'pre', kids)
  assert.match(p, /hooks=pre run/)                       // 角色标识
  assert.match(p, /pre（前置准备闸门）/)
  assert.match(p, /epic · 史诗甲/)
  assert.match(p, /把 X 做完/)                            // epic 描述注入
  assert.match(p, /别碰 client/)                          // epic 指引注入
  assert.match(p, /先把依赖装好/)                          // 主窗口写的运行契约
  assert.match(p, /- \[pending\] c1 · 子一（管线 full）/)  // 子任务标题/状态清单
  assert.match(p, /- \[resolved\] c2 · 子二/)
  assert.match(p, /让这批子任务具备开跑条件/)               // 薄框架：只定边界，不排具体动作
  assert.match(p, /由你根据上下文判断/)
  assert.match(p, /board_report（kind=escalate, taskId=epic/) // 歧义兜底通道
  assert.match(p, /不要猜测、不要硬闯/)
  assert.match(p, /不要默认提交（git commit）或推送（git push）/) // 红线③：commit/push 不入默认形态
  assert.match(p, /完成即代表 pre 闸门放行/)
  // post 契约：收口语义 + 明确「自行决策并自负其责」，且不含 pre 的放行文案
  const q = core.buildHookPrompt(epi, 'post', kids)
  assert.match(q, /hooks=post run/)
  assert.match(q, /post（收口闸门）/)
  assert.match(q, /把这批已完成的工作收口/)
  assert.match(q, /自行决策并自负其责/)
  assert.match(q, /史诗将自动转入 verifying/)
  assert.doesNotMatch(q, /完成即代表 pre 闸门放行/)
  // 无子任务时也有可读清单占位（不产生半截列表）
  assert.match(core.buildHookPrompt(epi, 'pre', []), /（暂无子任务）/)
})

test('hooks 只许主窗口设置：create-task/update-task RPC 与 task_create/task_update 双通道角色门禁', async () => {
  // ① RPC 通道：子代理（resolveRoot(actor) !== actor）带 hooks 一律拒绝
  const child = { resolveRoot: () => 'root-other' }
  const b1 = mkBoard([])
  const r1 = await mkRpcHandlers(b1, child)['create-task']({ title: 'T', description: 'd', hooks: { pre: { prompt: 'p' } } })
  assert.equal(r1.ok, false); assert.match(r1.error, /hooks 仅主窗口可设/); assert.equal(b1.tasks.length, 0)
  // 不带 hooks 时子代理路径行为不变（老契约：RPC 通道本就主窗口驱动）
  const r1b = await mkRpcHandlers(mkBoard([]), child)['create-task']({ title: 'T', description: 'd' })
  assert.equal(r1b.ok, true)
  // ② RPC 通道：主窗口（resolveRoot(actor) === actor）可设 + 形状校验错误原样返回
  const b2 = mkBoard([])
  const r2 = await mkRpcHandlers(b2)['create-task']({ title: 'T', description: 'd', hooks: { pre: { prompt: '准备' } } })
  assert.equal(r2.ok, true)
  assert.equal(b2.tasks[0].hooks.pre.prompt, '准备')
  assert.equal(b2.tasks[0].hooks.pre.enabled, true)
  const r2b = await mkRpcHandlers(mkBoard([]))['create-task']({ title: 'T', description: 'd', hooks: { pre: {} } })
  assert.equal(r2b.ok, false); assert.match(r2b.error, /prompt 不能为空/)
  // ③ RPC 通道：update-task 浅合并（只改 prompt 不动 post；{ pre: null } 撤点位）
  const b3 = mkBoard([mkTask({ id: 'e1', hooks: { pre: { enabled: true, prompt: 'A', state: 'idle' }, post: { enabled: true, prompt: 'B', state: 'idle' } } })])
  const r3 = await mkRpcHandlers(b3)['update-task']({ taskId: 'e1', hooks: { pre: { prompt: 'A2' } } })
  assert.equal(r3.ok, true)
  assert.equal(b3.tasks[0].hooks.pre.prompt, 'A2'); assert.equal(b3.tasks[0].hooks.post.prompt, 'B')
  const r3b = await mkRpcHandlers(b3)['update-task']({ taskId: 'e1', hooks: { pre: null } })
  assert.equal(r3b.ok, true); assert.equal(b3.tasks[0].hooks.pre, undefined); assert.equal(b3.tasks[0].hooks.post.prompt, 'B')
  // ④ 工具通道：schema 有 hooks 参数 + hooks 专属门禁（子代理报「hooks 仅主窗口可设」，非通用无权限文案）
  const h = mkRpcHandlers(mkBoard([]))
  const hChild = mkRpcHandlers(mkBoard([]), child) // 子代理身份（resolveRoot 指向别处）
  for (const name of ['task_create', 'task_update']) {
    const tool = h.__tools[name]
    assert.ok(tool, name + ' 工具已注册')
    assert.ok(tool.parameters.properties.hooks, name + ' schema 含 hooks 参数')
    // hooks 与 draft/publish 同级（顶层属性）——曾误插进 draft/publish 属性内部（`.properties.hooks` 为空即漏检）
    assert.equal(tool.parameters.properties.draft && tool.parameters.properties.draft.properties && tool.parameters.properties.draft.properties.hooks, undefined, name + ' hooks 未误插进 draft 属性内')
    // 子代理调用带 hooks → 专属文案拒绝（先于/独立于通用「仅主窗口可用」门禁，便于定位权限边界）
    const resChild = await hChild.__tools[name].execute({ taskId: 'x', title: 'T', hooks: { pre: { prompt: 'p' } } })
    assert.equal(resChild.ok, false)
    assert.match(resChild.error, /hooks 仅主窗口可设/)
  }
  // ⑤ 子代理（resolveRoot 指向别处）经 update-task 带 hooks → 同一文案拒绝，且不改卡
  const b4 = mkBoard([mkTask({ id: 'e2', hooks: { pre: { enabled: true, prompt: 'A', state: 'idle' } } })])
  const r4 = await mkRpcHandlers(b4, child)['update-task']({ taskId: 'e2', hooks: { pre: { prompt: 'X' } } })
  assert.equal(r4.ok, false); assert.match(r4.error, /hooks 仅主窗口可设/)
  assert.equal(b4.tasks[0].hooks.pre.prompt, 'A')
  assert.equal(b4.tasks[0].hooks.pre.state, 'idle') // 状态机不被越权写入扰动
})

// ===== hooks 接线（host 侧）：pre 闸门 spawn / post 补 spawn / hook run 结算分派（直调 + 源码级）=====
// poolCycle 直调 harness（带 subagents）：spawnOneShot 走真实路径，捕获 provider/label/prompt；
// run.result 用永不落定的 Promise（本用例只验证「谁被 spawn 了、prompt 对不对」，不触发结算）。
// 分流口径（task-muw5gnhv）：Worker 默认走 startContinuable → 记入 spawnedContinuable；
// verifier/hook run 照旧走 start → 记入 spawned（两族 label 同名，故分开收集避免断言串味）。
function mkHookDispatch(board, over) {
  const spawned = []
  const spawnedContinuable = []
  const runs = {}
  const boardRef = { b: board }
  const ctx = {
    fs: {}, effect: function () {}, get: function () { return null },
    timer: null,
    subagents: {
      list: () => ['mock'],
      getProvider: () => ({ inheritsParentContext: false }),
      start: async (name, req) => {
        spawned.push({ name, label: req.label, text: req.prompt[0].text, parent: req.parent, persona: req.persona, toolFilter: req.toolFilter })
        return { id: 'run-' + spawned.length, result: new Promise(function () {}), dispose: async function () {} }
      },
      startContinuable: async (spec) => {
        spawnedContinuable.push({ name: spec.provider, label: spec.label, text: spec.request.prompt[0].text, parent: spec.request.parent, persona: spec.request.persona, toolFilter: spec.request.toolFilter })
        return { childId: 'child-' + spawnedContinuable.length, messageId: 'msg-' + spawnedContinuable.length }
      },
    },
  }
  const state = { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} }
  const dispatch = createDispatch(ctx, state, Object.assign({
    rt: async () => boardRef.b,
    wt: async () => {},
    mutateLocked: async (sid, fn) => fn(boardRef.b),
    kickCycle: () => {},
    rootForSession: () => ({ id: FULL_SID }),
    sessionCwd: () => '', withTimeout: (p) => p, runsFor: () => runs, feedbackOn: () => true,
    pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
  }, over || {}))
  return { dispatch, spawned, spawnedContinuable, runs, board: boardRef }
}

test('poolCycle 接线①：pre=idle → 不派子任务，改 spawn hook-pre run（prompt=薄框架+契约）', async () => {
  const epi = HOOK_TASK({ hooks: { pre: { enabled: true, prompt: '先把依赖装好', state: 'idle', runId: null } } })
  const child = mkTask({ id: 'c1', parentId: 'epic', status: 'pending' })
  // 第二个子任务挂在一张无 hooks 的 epic 上：它是「无关卡片」参照物，也顺带保证 epi 不被 claim
  // → epi 停在 in-progress（poolCycle 的空闲快进不会把整轮短路掉，hook 闸门分支真的被执行到）
  const epi2 = mkTask({ id: 'epic2', status: 'in-progress' })
  const child2 = mkTask({ id: 'z1', parentId: 'epic2', status: 'pending' })
  const board = mkBoard([epi, child, epi2, child2])
  const h = mkHookDispatch(board)
  await h.dispatch.poolCycle(FULL_SID)
  // 分流断言（task-muw5gnhv）：hook run 照旧一次性 start，Worker 走 startContinuable
  const labels = h.spawned.map(s => s.label).concat(h.spawnedContinuable.map(s => s.label)).sort()
  assert.deepEqual(labels, ['hook-pre:epic', 'worker:z1'])   // 只 spawn hook + 无关卡片照常派，无 c1 的 Worker
  assert.deepEqual(h.spawned.map(s => s.label), ['hook-pre:epic'])       // hook 不走 continuable
  assert.deepEqual(h.spawnedContinuable.map(s => s.label), ['worker:z1']) // Worker 走 continuable
  assert.equal(child.status, 'pending')                    // 串行闸门：子任务原地待命
  assert.equal(child2.status, 'in-progress')               // 无关卡片不受闸门影响
  assert.equal(epi.hooks.pre.state, 'running')             // 状态机推进（写在卡上，重启可恢复）
  assert.equal(epi.hooks.pre.pending, undefined)           // pre 不用内存占用标记：幂等靠 state='running' 本身
  const hp = h.spawned.find(s => s.label === 'hook-pre:epic')
  assert.match(hp.text, /hooks=pre run/)
  assert.match(hp.text, /先把依赖装好/)                     // 主窗口契约注入
  // 第二轮（hook 仍在跑）不重复 spawn
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(h.spawned.filter(s => s.label === 'hook-pre:epic').length, 1)
})

test('poolCycle 接线①：pre=done → 子任务正常派发（闸门放行，不再 spawn hook）', async () => {
  const epi = HOOK_TASK({ hooks: { pre: { enabled: true, prompt: '准备', state: 'done', runId: null } } })
  const child = mkTask({ id: 'c1', parentId: 'epic', status: 'pending' })
  const h = mkHookDispatch(mkBoard([epi, child]))
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(h.spawned.length, 0)                        // 无 hook run
  assert.equal(h.spawnedContinuable.length, 1)             // 派的是 Worker（默认 continuable 路径）
  assert.equal(h.spawnedContinuable[0].label, 'worker:c1')
  assert.equal(child.status, 'in-progress')
})

test('poolCycle 接线③：post 待跑标记 → 不转 verifying，spawn hook-post run 收口', async () => {
  const epi = mkTask({ id: 'epic', title: '史诗甲', status: 'in-progress', hooks: { post: { enabled: true, prompt: '做收口', state: 'idle', runId: null } } })
  const child = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  const board = mkBoard([epi, child])
  // 先让 core 纯函数挂上待跑标记（真实触发路径：子任务了结时 maybeAutoCloseParent 被调用）
  core.maybeAutoCloseParent(board, child)
  assert.equal(epi.status, 'in-progress')                  // 延迟 verifying
  const h = mkHookDispatch(board)
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].label, 'hook-post:epic')
  assert.equal(epi.status, 'in-progress')                  // spawn 后仍等 hook 结算才转 verifying
  assert.equal(epi.hooks.post.pending, false)
  assert.equal(epi.verifierRun, 'run-1')                   // 幂等占用位换成真实 run id
  await h.dispatch.poolCycle(FULL_SID)                     // 不重复 spawn
  assert.equal(h.spawned.length, 1)
})

test('poolCycle 接线③：老 epic（无 hooks）→ 子任务了结仍直接 verifying，零 hook spawn（防回归）', async () => {
  const epi = mkTask({ id: 'epic', status: 'in-progress' })
  const child = mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' })
  // 再来一对有 hooks 的 epic（idle pre）：本轮真的会 spawn hook-pre，
  // 这样「hooked 场景 spawn ≥1、老场景 spawn 0」是对照组而非空跑（快进短路不会掩盖结论）
  const hooked = HOOK_TASK({ id: 'hooked', hooks: { pre: { enabled: true, prompt: '准备', state: 'idle' } } })
  const hchild = mkTask({ id: 'h1', parentId: 'hooked', status: 'pending' })
  const board = mkBoard([epi, child, hooked, hchild])
  core.maybeAutoCloseParent(board, child)
  const h = mkHookDispatch(board)
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(epi.status, 'verifying')                    // 老 epic 维持现状直接收口
  assert.equal(hooked.hooks.pre.state, 'running')          // 对照组确实跑了 hook
  // 老 epic 收口后进 verifying 会照常派 Verifier（既有行为未变）；对照组只有 hook-pre 一条 run
  assert.deepEqual(h.spawned.map(s => s.label).sort(), ['hook-pre:hooked', 'verifier:epic'])
  assert.equal(epi.hooks, undefined)
})

// ===== 可续跑 Worker（task-muw5gnhv 卡1）：continuable 分流 / turn 结算观测 / 回退开关 =====
// 观察口径：ctx.on('agent/status') 的注册回调 + runsFor 的 rec 形态 + 任务状态机推进。
// 分流②③的 spawn 双路 mock 内建「同一次派发只会命中一条路」的互斥断言（调用即记名）。
function mkContinuableDispatch(board, over, ctxOver) {
  const log = { continuable: [], oneShot: [] }
  const listeners = []
  // runs 表必须与 state.activeRuns[sid] **同一对象**：spawnOneShot 经 runsFor 写 rec，
  // agent/status 监听器经 state.activeRuns 读 rec——两处不同表就永远命中不到（真实 session.runsFor
  // 正是与 activeRuns 同源的访问器）。
  const runs = {}
  const activeRuns = { [FULL_SID]: runs }
  const base = {
    fs: {}, get: function () { return null },
    timer: null,
    // 真实 cordis 的 ctx.effect 会**立即执行**回调取其 disposer（订阅由此当场建立）——
    // 桩里必须照做，否则 ctx.on 永远不被触达，事件通道的接线就测不到。
    effect: function (f) { var d = f(); return function () { if (typeof d === 'function') d() } },
    on: function (name, fn) { listeners.push({ name: name, fn: fn }); return function () {} },
    subagents: {
      list: () => ['mock'],
      getProvider: () => ({ inheritsParentContext: false }),
      start: async (name, req) => {
        log.oneShot.push({ name: name, label: req.label })
        return { id: 'run-1', result: new Promise(function () {}), dispose: async function () {} }
      },
      startContinuable: async (spec) => {
        log.continuable.push({ name: spec.provider, label: spec.label, text: spec.request.prompt[0].text })
        return { childId: 'child-abc', messageId: 'msg-1' }
      },
    },
  }
  const dispatch = createDispatch(
    Object.assign(base, ctxOver || {}),
    { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: activeRuns },
    Object.assign({
      rt: async () => board, wt: async () => {}, mutateLocked: async (sid, fn) => fn(board), kickCycle: () => {},
      rootForSession: () => ({ id: FULL_SID }),
      withTimeout: (p) => p, runsFor: () => runs, feedbackOn: () => true,
      pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
    }, over || {}))
  return { dispatch, log, listeners, runs, board }
}
const flush = () => new Promise(r => setImmediate(r))

// 子进程探针源码（可续跑 Worker⑤ 用）：只在子进程里执行「真跑一次 continuable 派发 + 真读会话日志 + 真结算」。
// 为什么必须子进程：findRunLog 走 os.homedir()（进程内首次调用即缓存），临时 HOME 只有在进程启动前
// 设好才生效——同进程改 env 既无效又会带偏其它用例与真实看板目录。
const PROBE_CONTINUABLE_SOURCE = `
const { createDispatch } = await import('./lib/dispatch.mjs')
const SID = 'session-test-0000-0000-000000000000'
const listeners = []
const runs = {}
let failedFail = 0
const origErr = console.error
console.error = function () { var s = Array.prototype.join.call(arguments, ' '); if (/未读到 assistant 文本/.test(s)) failedFail++; origErr.apply(console, arguments) }
const ctx = {
  fs: {}, get: () => null, timer: null,
  effect: function (f) { var d = f(); return function () { if (typeof d === 'function') d() } },
  on: function (n, f) { listeners.push(f); return function () {} },
  subagents: {
    list: () => ['mock'],
    getProvider: () => ({ inheritsParentContext: false }),
    start: async () => ({ id: 'run-1', result: new Promise(() => {}), dispose: async () => {} }),
    startContinuable: async () => ({ childId: 'child-ok', messageId: 'm1' }),
  },
}
const t = { id: 'w6', title: '卡', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null, history: [], messages: [] }
const board = { version: 11, ownerSession: SID, boardMode: 'auto', maxWorkers: 3, tasks: [t] }
const d = createDispatch(ctx, { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: { [SID]: runs } }, {
  rt: async () => board, wt: async () => {}, mutateLocked: async (s, f) => f(board), kickCycle: () => {}, rootForSession: () => ({ id: SID }),
  withTimeout: (p) => p, runsFor: () => runs, feedbackOn: () => true, pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
})
await d.poolCycle(SID)
const rec = runs['w6']
listeners[0]({ agent: { session: { id: 'child-ok' } }, status: 'running' })
listeners[0]({ agent: { session: { id: 'child-ok' } }, status: 'idle' })
for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
console.log(JSON.stringify({ status: t.status, continual: !!(rec && rec.continuable), deliverable: t.deliverable || null, failedFail: failedFail }))
`

test('可续跑 Worker①：worker 走 startContinuable（rec 持 childId），verifier 照旧走 start（分流断言）', async () => {
  const w = mkTask({ id: 'w1', title: 'Worker 卡', status: 'pending' })
  const v = mkTask({ id: 'v1', title: '待验收卡', status: 'verifying' })
  const h = mkContinuableDispatch(mkBoard([w, v]))
  await h.dispatch.poolCycle(FULL_SID)
  // Worker → continuable（默认开关开）
  assert.deepEqual(h.log.continuable.map(x => x.label), ['worker:w1'])
  // Verifier → 一次性 start（不因开关改道）
  assert.deepEqual(h.log.oneShot.map(x => x.label), ['verifier:v1'])
  // rec 结构：id=childId（会话 id 语义不变，t.runs/claimedBy 都靠它）、持 childId、标记 continuable、无 run
  const rec = h.runs['w1']
  assert.equal(rec.id, 'child-abc'); assert.equal(rec.childId, 'child-abc')
  assert.equal(rec.continuable, true); assert.equal(rec.run, null); assert.equal(rec.settled, false); assert.equal(rec.ran, false)
  assert.equal(rec.role, 'worker'); assert.equal(rec.taskId, 'w1'); assert.equal(typeof rec.startedAt, 'number')
  // 任务侧接线照旧：claimedBy 落 childId（详情页/会话跳转语义不变）+ runs 历史留档同 id
  assert.equal(w.claimedBy, 'child-abc')
  assert.deepEqual(w.runs.map(r => r.id), ['child-abc'])
  // verifier 的 rec 仍是旧形态（有 run、无 continuable）
  assert.equal(h.runs['v1'].continuable, undefined)
  assert.equal(String(h.runs['v1'].id), 'run-1')
  // 订阅已注册且事件名正确（回退开关不影响的公共通道）
  assert.deepEqual(h.listeners.map(l => l.name), ['agent/status'])
})

test('可续跑 Worker②：agent/status running→idle → settle 推进任务（真跑事件回调，非源码断言）', async () => {
  const t = mkTask({ id: 'w2', title: '会失败的卡', status: 'pending' })
  const h = mkContinuableDispatch(mkBoard([t]))
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(t.status, 'in-progress')
  const fire = (status) => h.listeners[0].fn({ agent: { session: { id: 'child-abc' } }, status: status })
  // ① running：只标记「这一轮真跑起来了」，绝不结算（rec 仍在活跃表）
  fire('running')
  assert.equal(h.runs['w2'].ran, true)
  assert.equal(t.status, 'in-progress')
  assert.equal(h.runs['w2'].settled, false)
  // ② idle：turn 结束 → 走 settleWorker 的任务推进语义。本用例的环境里读不到子会话日志（无真实日志文件），
  //   故走「空文本按失败结算」的既有降级臂：in-progress → pending 重排（retryCount 首次 fail = 1），
  //   而不是被误判成「空完成」推进到 verifying。
  fire('idle')
  await flush()
  assert.equal(t.status, 'pending')
  assert.equal(t.retryCount, 1)
  assert.equal(t.claimedBy, null)
  assert.equal(h.runs['w2'], undefined) // 结算即摘除活跃表项
  const last = t.history[t.history.length - 1]
  assert.match(last.note, /worker 失败/)
  // 幂等：rec 已摘除后再来 idle 事件不炸、不重复计数
  fire('idle'); await flush()
  assert.equal(t.retryCount, 1)
  // 非本 rec 的会话 id 不误伤：另一个 child 的 idle 事件被忽略
  const t2 = mkTask({ id: 'w3', title: '另一张', status: 'pending' })
  const h2 = mkContinuableDispatch(mkBoard([t2]))
  await h2.dispatch.poolCycle(FULL_SID)
  h2.listeners[0].fn({ agent: { session: { id: '别人的会话' } }, status: 'running' })
  h2.listeners[0].fn({ agent: { session: { id: '别人的会话' } }, status: 'idle' })
  await flush()
  assert.equal(t2.status, 'in-progress'); assert.equal(h2.runs['w3'].settled, false)
  // 未观测到 running 的伪 idle 被 rec.ran 守卫挡住（不拿瞬时 idle 结算成「空文本失败」）
  h2.listeners[0].fn({ agent: { session: { id: 'child-abc' } }, status: 'idle' })
  await flush()
  assert.equal(t2.status, 'in-progress'); assert.equal(h2.runs['w3'].settled, false)
})

test('可续跑 Worker②b：事件 payload 身份契约——agent 无 id 字段，身份在 agent.session.id（2026-10-06 热修防再发）', async () => {
  // 事故根源：dsh-agent 的 Agent 接口（runtime-types.d.ts）没有 id 字段——身份在 agent.session.id。
  // 旧实现读 agent.id 恒 undefined → cid='' 静默早退 → 事件结算通道自卡1上线从未在生产触发。
  // 本条用「无 id 字段的真实形状」mock 锁住契约；agent.id 兜底分支也一并覆盖。
  const t = mkTask({ id: 'w2b', title: '身份契约卡', status: 'pending' })
  const h = mkContinuableDispatch(mkBoard([t]))
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(t.status, 'in-progress')
  // 真实形状：agent 只有 session.id，没有 id——必须命中 rec 并结算（harness mock 恒返回 childId 'child-abc'）
  h.listeners[0].fn({ agent: { session: { id: 'child-abc' } }, status: 'running' })
  assert.equal(h.runs['w2b'].ran, true)
  h.listeners[0].fn({ agent: { session: { id: 'child-abc' } }, status: 'idle' })
  await flush()
  assert.equal(t.status, 'pending') // 空文本降级臂回 pending（同②口径）
  assert.equal(h.runs['w2b'], undefined)
  // 防回归哨兵：若有人把身份读回 agent.id，上面两发事件将静默无效果——本断言会立刻红
  const t2 = mkTask({ id: 'w2c', title: 'payload 缺 agent', status: 'pending' })
  const h2 = mkContinuableDispatch(mkBoard([t2]))
  await h2.dispatch.poolCycle(FULL_SID)
  h2.listeners[0].fn({ status: 'idle' })            // 无 agent：静默跳过不炸
  h2.listeners[0].fn({ agent: null, status: 'idle' }) // agent=null：同上
  await flush()
  assert.equal(t2.status, 'in-progress'); assert.equal(h2.runs['w2c'].settled, false)
})

test('可续跑 Worker③：workerContinuable=false → 逐字回退一次性路径（零 startContinuable 调用）', async () => {
  const t = mkTask({ id: 'w4', title: '回退卡', status: 'pending' })
  const board = Object.assign(mkBoard([t]), { workerContinuable: false })
  const h = mkContinuableDispatch(board)
  await h.dispatch.poolCycle(FULL_SID)
  assert.deepEqual(h.log.continuable, [])                  // 回退：continuable 路径一次都不进
  assert.deepEqual(h.log.oneShot.map(x => x.label), ['worker:w4'])
  const rec = h.runs['w4']
  assert.equal(rec.continuable, undefined)                 // 旧 rec 形态逐字不变
  assert.equal(rec.childId, undefined)
  assert.equal(String(rec.id), 'run-1')                    // id 仍等于 run.id
  assert.ok(rec.run && typeof rec.run.dispose === 'function') // 旧结算通道（run.result + dispose）在位
  assert.equal(t.claimedBy, 'run-1')                       // 任务侧写回同旧口径
})

test('可续跑 Worker④：startContinuable 失败 → spawn 回 null，任务回 pending（不卡 spawn-pending）', async () => {
  const t = mkTask({ id: 'w5', title: '起不来的卡', status: 'pending' })
  const h = mkContinuableDispatch(mkBoard([t]), {}, {
    subagents: {
      list: () => ['mock'],
      getProvider: () => ({ inheritsParentContext: false }),
      start: async () => { throw new Error('不该走一次性路径') },
      startContinuable: async () => { throw new Error('continuation unavailable') },
    },
  })
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(t.status, 'pending')          // 回收重新排队（不是卡在 in-progress/spawn-pending）
  assert.equal(t.claimedBy, null)
  assert.equal(t.claimedAt, null)
  assert.equal(h.runs['w5'], undefined)      // 无活跃 rec（失败不占并发位）
  const last = t.history[t.history.length - 1]
  assert.match(last.note, /spawn 失败，回收重新排队/)
})

test('可续跑 Worker⑤：idle 后从子会话 v4 日志读到助手文本 → 走文本通道推进 verifying（真读真日志）', async () => {
  // 子会话日志定位走 os.homedir()（进程内首次调用即缓存），故用临时 HOME + child_process 隔离子进程跑，
  // 不能在主进程改 HOME——同进程的其它用例/真实看板目录都会被带偏。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbc-'))
  const frames = [{ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '## 开发描述\n续跑 Worker 完工\n## 自测情况\nok' }] } } }]
  const chunks = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(frames[0]) + '\n'))]
  fs.mkdirSync(path.join(tmp, '.dsh', 'sessions', 'b1', 'child-ok'), { recursive: true })
  fs.writeFileSync(path.join(tmp, '.dsh', 'sessions', 'b1', 'child-ok', 'session.v4.jsonl.zstd'), Buffer.concat(chunks))
  try {
    const child = spawnSync(process.execPath, ['-e', PROBE_CONTINUABLE_SOURCE], { env: Object.assign({}, process.env, { HOME: tmp, USERPROFILE: tmp }), encoding: 'utf8' })
    assert.equal(child.status, 0, 'probe 失败: ' + child.stderr)
    const out = JSON.parse(child.stdout.trim().split('\n').pop())
    assert.equal(out.status, 'verifying')                 // 文本通道：有助手文本 → 正常推进 verifying
    assert.equal(out.continual, true)                     // 走的确实是 continuable 路径
    assert.match(out.deliverable.summary, /续跑 Worker 完工/) // 交付物来自真日志读到的文本（非空完成）
    assert.equal(out.failedFail, 0)                       // 没有走「空文本按失败」的降级臂
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('可续跑 Worker 接线（源码级）：事件订阅走 ctx.effect 回收 + 硬超时 interrupt 留存 + 重派续跑接线', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  const rpcSrc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  // ① 双路 spawn：Worker+开关开才走 startContinuable（verifier/hook 不受影响）
  assert.match(dsp, /var useContinuable = role === 'worker' && c\.workerContinuable !== false/)
  assert.match(dsp, /var cs = await subagents\.startContinuable\(\{ provider: providerName, label: req\.label, request: req, signal: req\.signal \}\)/)
  // ② 结算观测：agent/status 订阅 + running→idle + rec.ran 二次守卫 + effect 回收
  assert.match(dsp, /ctx\.effect\(function \(\) \{ return ctx\.on\('agent\/status', onAgentStatus\) \}\)/)
  assert.match(dsp, /if \(status !== 'idle' && status !== 'running'\) return/) // running 事件必须放行（rec.ran 的唯一来源）
  assert.match(dsp, /if \(status === 'running'\) \{ rec\.ran = true; return \}/)
  assert.match(dsp, /if \(!rec\.ran \|\| rec\.settled\) return/)
  assert.match(dsp, /await settleRun\(sid, rec, \{ output: \[\{ type: 'text', text: text \}\], stopReason: text\.trim\(\) \? 'completed' : 'error' \}, null\)/)
  // ③ 卡2 Step1：硬超时/失败结算对 continuable 子会话改 interrupt（留存不销毁），一次性仍 dispose；
  //    authority 形状取 dsh-subagent 的 SubagentInterruptAuthority，interrupt 异常被吞进 resumeBlocked 不阻断结算。
  assert.match(dsp, /async function endContinuable\(sid, rec\) \{/)
  assert.match(dsp, /subagents\.interrupt\(rec\.childId, \{ kind: 'ancestor', agent: parent \}\)/)
  assert.match(dsp, /if \(rec\.continuable\) await endContinuable\(sid, rec\)\s*\n\s*else await rec\.run\.dispose\(\)/)
  assert.match(dsp, /rec\.resumeBlocked = true/)
  assert.match(dsp, /withTimeout\(abortableP, hardMs, rec\.role \+ ':' \+ t\.id\)/)
  // ④ 文本兜底复用 usage.mjs 现成读取器（与 agent-activity 同一套日志定位/分帧）+ 续跑基线（只认本轮新写字节）
  assert.match(dsp, /var log = findRunLog\(childId, sessionsRoot\)/)
  assert.match(dsp, /var buf = readLogBytes\(log, tail\)/)
  assert.match(dsp, /childSessionOutput\(rec\.childId, rec\.baselineBytes\)/)
  assert.match(dsp, /baselineBytes: logSizeOf\(childId\)/)
  // ⑤ 卡2 Step2/Step3：重派续跑接线（sendMessage 冷复活 + 薄框架断点续跑指令 + runs[] 续跑记录 +
  //    失败回退 fresh spawn）+ 三连败计数不受续跑影响（续跑同样走 settleWorker 的 retryCount 口径）
  assert.match(dsp, /await subagents\.sendMessage\(parent, childId, \[\{ type: 'text', text: text \}\], \{ signal: makeSignal\(\) \}\)/)
  assert.match(dsp, /【断点续跑】你之前执行此任务被中断（第 ' \+ attempt \+ ' 次尝试）/)
  assert.match(dsp, /await recordRunHistory\(sid, t\.id, 'worker', childId, '', c\.hardTimeoutMin, true, true\)/)
  assert.match(dsp, /if \(sp\.role === 'worker' && c\.workerContinuable !== false\) \{/)
  assert.match(dsp, /kind: 'resume-fallback'/)
  assert.match(dsp, /if \(r\.continuable !== true \|\| r\.noResume === true\) return ''/) // 续跑资格：一次性 run/已标 noResume 一律不够格
  assert.match(dsp, /if \(r\.outcome !== 'timeout\/error' && r\.outcome !== 'incomplete'\) return ''/) // 只续「超时/失败」的断点
  // ⑥ 板级开关三件套（cfg 兜底 / normalizeBoard 补缺省 / seed 初值 / set-board-config 白名单 / get-tasks 透出）
  assert.match(coreSrc, /workerContinuable: d\.workerContinuable !== false/)
  assert.match(coreSrc, /if \(typeof d\.workerContinuable !== 'boolean'\) d\.workerContinuable = true/)
  assert.match(coreSrc, /epicSplit: true, workerContinuable: true, verifyUserGuide: true, minWorkers: 1/)
  assert.match(rpcSrc, /else if \(args\.key === 'workerContinuable'\) d\.workerContinuable = !!args\.value/)
  assert.match(rpcSrc, /d\.workerContinuable = cfg\(d\)\.workerContinuable/)
  // ⑦ 手动终止/活动查询对 continuable rec 不炸（id 统一取 rec.id，dispose 分路）
  assert.match(rpcSrc, /try \{ if \(rec\.run\) await rec\.run\.dispose\(\) \} catch \(_\) \{\}/)
  // ⑧ 卸载清理对 continuable rec 不炸（判空 + 立 settled 旗 + 原位清空）
  assert.match(dsp, /if \(r0 && r0\.run\) r0\.run\.dispose\(\); if \(r0\) r0\.settled = true/)
})

test('可续跑 Worker⑥：插件卸载清理对 continuable rec 不炸且清空表（真跑 disposer）', async () => {
  const t = mkTask({ id: 'w7', title: '卸载卡', status: 'pending' })
  const teardown = []
  const h = mkContinuableDispatch(mkBoard([t]), {}, { effect: function (f) { var d = f(); teardown.push(d); return function () { if (typeof d === 'function') d() } } })
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(typeof h.runs['w7'], 'object') // 派发后有活跃 rec
  for (const fn of teardown) if (typeof fn === 'function') fn() // 模拟插件停止：跑 ctx.effect 的 disposer
  assert.equal(h.runs['w7'], undefined)       // 原位清空（旧引用看不到残留 rec）
  assert.equal(t.status, 'in-progress')       // 清理只放行结算，不擅自推进任务状态
})

// ===== 可续跑 Worker（task-muw5h2ps 卡2）：硬超时 interrupt + 重派冷复活续跑 + 失败回退 fresh spawn =====
// 观察口径：真跑 poolCycle（真 spawnOneShot / 真 tryResumeWorker）+ 真事件通道（agent/status）+ 卡上留档
// （t.runs/结局）——不断言实现细节，断言「谁被调了、任务变成什么样」。
// 断言①～⑤ 对应卡2 三条 Step：①硬超时→interrupt 留存（不 dispose）；②重派 sendMessage 续跑（不 spawn 新 Worker）；
// ③续跑失败回退 fresh spawn + 任务消息留说明；④interrupt 失败不卡死且重派回退；⑤回退开关下一次性路径零变化。
test('可续跑 Worker⑦（卡2①）：硬超时 → interrupt 留存（不 dispose），任务回 pending 且 run 留「continuable+超时」结局', async () => {
  const parent = { id: FULL_SID }
  const calls = { interrupt: [] }
  let disposed = 0
  const t = mkTask({ id: 'r1', title: '超时卡', status: 'pending' })
  const h = mkContinuableDispatch(mkBoard([t]), {
    rootForSession: () => parent,
    // 硬超时臂：直接拒绝（等价 withTimeout 到期）——走的是与真实到期逐字相同的失败结算
    withTimeout: () => Promise.reject(new Error('timeout: worker:r1 after 120min')),
  }, {
    subagents: {
      list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
      start: async () => ({ id: 'run-1', result: new Promise(function () {}), dispose: async function () { disposed++ } }),
      startContinuable: async () => ({ childId: 'child-abc', messageId: 'msg-1' }),
      interrupt: (id, auth) => calls.interrupt.push({ id: id, auth: auth }),
    },
  })
  await h.dispatch.poolCycle(FULL_SID)
  await flush(); await flush(); await flush()
  // ① 硬超时收尾 = interrupt（子会话 idle 留存，等重派冷复活），不是销毁/丢弃
  assert.equal(calls.interrupt.length, 1)
  assert.equal(calls.interrupt[0].id, 'child-abc')
  // authority 形状 = dsh-subagent 的 SubagentInterruptAuthority：{kind:'ancestor', agent: 活的直接父 Agent}
  assert.deepEqual(calls.interrupt[0].auth, { kind: 'ancestor', agent: parent })
  assert.equal(disposed, 0)                    // continuable 路径绝不 dispose（rec 也没有 run）
  // 任务侧语义与现状一致：失败结算 → 回 pending 重排、count +1
  assert.equal(t.status, 'pending')
  assert.equal(t.retryCount, 1)
  assert.equal(t.claimedBy, null)
  assert.equal(h.runs['r1'], undefined)        // 结算即摘除活跃表项
  // runs 留档是续跑资格的唯一依据：continuable + timeout/error（首派不带 resume 标记）
  const last = t.runs[t.runs.length - 1]
  assert.equal(last.outcome, 'timeout/error')
  assert.equal(last.continuable, true)
  assert.equal(last.resume, undefined)
  assert.equal(last.noResume, undefined)
})

test('可续跑 Worker⑧（卡2②）：重派命中续跑 → sendMessage 冷复活（零新 spawn），指令含「断点续跑/第 2 次尝试」，runs[] 追加 resume 记录', async () => {
  const parent = { id: FULL_SID }
  const sent = []
  const spawned = []
  // 上次 continuable Worker run 结局=超时（形状即⑦那条路径产生的真实留档）
  const t = mkTask({ id: 'r2', title: '续跑卡', status: 'pending', runs: [{ role: 'worker', id: 'child-old', at: '2026-01-01T00:00:00.000Z', model: '', outcome: 'timeout/error', hardMin: 120, continuable: true }] })
  const h = mkContinuableDispatch(mkBoard([t]), { rootForSession: () => parent }, {
    subagents: {
      list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
      start: async () => { spawned.push('one-shot'); return { id: 'run-1', result: new Promise(function () {}), dispose: async function () {} } },
      startContinuable: async () => { spawned.push('continuable'); return { childId: 'child-new', messageId: 'msg-1' } },
      sendMessage: async (sender, targetId, content, options) => { sent.push({ sender: sender, targetId: targetId, content: content, options: options }); return 'msg-2' },
    },
  })
  await h.dispatch.poolCycle(FULL_SID)
  // ② 发的是续跑指令，目标是上次那个子会话
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sender, parent)                       // sender = 活的直接父 Agent（服务端按邻接校验）
  assert.equal(sent[0].targetId, 'child-old')
  const txt = sent[0].content[0].text
  assert.match(txt, /【断点续跑】/)
  assert.match(txt, /第 2 次尝试/)                            // N = 已有 Worker run 数(1) + 本次
  assert.match(txt, /git status\/diff/)                       // 先盘点工作树
  assert.match(txt, /从断点继续/)
  assert.match(txt, /任务契约与验收标准见上文历史/)
  assert.match(txt, /board_report escalate/)                  // 吃不准就上报
  assert.ok(sent[0].options && sent[0].options.signal, 'sendMessage 选项形态必须是 SubagentSendMessageOptions { signal }')
  assert.deepEqual(spawned, [])                               // 零新 spawn（两条 spawn 路都没进）
  // 任务侧：占位 claim 换成真实 childId；活跃 rec 重新挂上（turn 结算仍靠 agent/status 事件）
  assert.equal(t.status, 'in-progress')
  assert.equal(t.claimedBy, 'child-old')
  const rec = h.runs['r2']
  assert.equal(rec.childId, 'child-old'); assert.equal(rec.continuable, true); assert.equal(rec.resumed, true)
  assert.equal(rec.ran, false); assert.equal(rec.settled, false)
  assert.equal(typeof rec.baselineBytes, 'number')             // 续跑基线（只认本轮新写字节）
  // runs[] 追加一条续跑记录：role=worker / id=childId（同一会话）/ resume 标记
  const last = t.runs[t.runs.length - 1]
  assert.equal(last.role, 'worker'); assert.equal(last.id, 'child-old')
  assert.equal(last.resume, true); assert.equal(last.continuable, true); assert.equal(last.outcome, 'running')
  // 续跑轮同样能被事件结算（与首派同一条通道）：running→idle（本环境读不到子会话日志 → 走「空文本按失败」）
  h.listeners[0].fn({ agent: { session: { id: 'child-old' } }, status: 'running' })
  assert.equal(h.runs['r2'].ran, true)
  h.listeners[0].fn({ agent: { session: { id: 'child-old' } }, status: 'idle' })
  await flush(); await flush()
  assert.equal(t.status, 'pending')                            // 续跑也算一次尝试：失败照常重排
  assert.equal(t.retryCount, 1)                                // 三连败计数口径不受续跑影响（Step3）
  assert.equal(h.runs['r2'], undefined)
  assert.equal(t.runs[t.runs.length - 1].outcome, 'incomplete') // 续跑轮结局落档（下一轮仍够格续跑）
})

test('可续跑 Worker⑨（卡2③）：续跑失败（NOT_RESUMABLE）→ 回退 fresh spawn，任务消息留一行说明并随首条 prompt 注入', async () => {
  const parent = { id: FULL_SID }
  const sent = []
  const prompts = []
  const t = mkTask({ id: 'r3', title: '回退卡', status: 'pending', runs: [{ role: 'worker', id: 'child-dead', at: '2026-01-01T00:00:00.000Z', model: '', outcome: 'incomplete', hardMin: 120, continuable: true }] })
  const h = mkContinuableDispatch(mkBoard([t]), { rootForSession: () => parent }, {
    subagents: {
      list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
      start: async () => { throw new Error('不该走一次性路径') },
      startContinuable: async (spec) => { prompts.push(spec.request.prompt[0].text); return { childId: 'child-new', messageId: 'msg-1' } },
      sendMessage: async (sender, targetId) => { sent.push(targetId); throw new Error('subagent/not-resumable') },
    },
  })
  await h.dispatch.poolCycle(FULL_SID)
  assert.deepEqual(sent, ['child-dead'])        // 确实先试了续跑（冷复活失败）
  assert.equal(prompts.length, 1)               // 失败 → 回退 fresh spawn（全新 Worker）
  assert.equal(t.claimedBy, 'child-new')
  // 任务消息里留一行说明（详情页可见）
  const note = (t.messages || []).find((m) => m.kind === 'resume-fallback')
  assert.ok(note, '续跑回退必须留说明')
  assert.match(note.text, /断点续跑不可用/)
  assert.match(note.text, /not-resumable/)      // 原因带出，可追溯
  // 说明写在 spawn **之前**：新 Worker 的首条 prompt 里就能看到（否则「留一行说明」只是给人事后翻账）
  assert.match(prompts[0], /### \[resume-fallback\]/)
  assert.match(prompts[0], /断点续跑不可用/)
})

test('可续跑 Worker⑩（卡2④）：interrupt 失败 → 结算不卡死（照常回 pending）且 run 标 noResume，重派直接 fresh spawn 不空唤醒', async () => {
  const parent = { id: FULL_SID }
  const sent = []
  const spawned = []
  let timeouts = 0
  const t = mkTask({ id: 'r4', title: '打断失败卡', status: 'pending' })
  const h = mkContinuableDispatch(mkBoard([t]), {
    rootForSession: () => parent,
    // 只有第一轮的硬超时臂到期（第二轮让它永不落定，便于断言「重派后停在 in-progress」）
    withTimeout: () => { timeouts++; return timeouts === 1 ? Promise.reject(new Error('timeout: worker:r4 after 120min')) : new Promise(function () {}) },
  }, {
    subagents: {
      list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
      start: async () => { throw new Error('不该走一次性路径') },
      startContinuable: async () => { spawned.push('spawn'); return { childId: 'child-' + spawned.length, messageId: 'm' } },
      interrupt: () => { throw new Error('UNAUTHORIZED: 会话已死') },
      sendMessage: async (sender, targetId) => { sent.push(targetId); return 'msg' },
    },
  })
  await h.dispatch.poolCycle(FULL_SID)
  await flush(); await flush(); await flush()
  // 第一轮：正常首派（continuable 路径）→ 硬超时结算 → interrupt 抛错被吞进结算（不抛穿 poolCycle、
  // 不阻断状态机）：任务照常回 pending 重排
  assert.deepEqual(spawned, ['spawn'])          // 首派确实走了 continuable 路径
  assert.equal(t.status, 'pending')
  assert.equal(t.retryCount, 1)
  const first = t.runs[t.runs.length - 1]
  assert.equal(first.outcome, 'timeout/error')
  assert.equal(first.noResume, true)            // 子会话不可信 → 该 run 失去续跑资格
  // 重派：noResume → 不回空唤醒，直接 fresh spawn（回退路径）
  await h.dispatch.poolCycle(FULL_SID)
  assert.deepEqual(sent, [])                    // 零 sendMessage（不空唤醒）
  assert.deepEqual(spawned, ['spawn', 'spawn']) // 本轮恰好一次 fresh spawn
  assert.equal(t.status, 'in-progress')
  assert.equal(t.claimedBy, 'child-2')
})

test('可续跑 Worker⑪（卡2⑤）：workerContinuable=false → 续跑机制整体短路（零 sendMessage/零 interrupt），一次性 dispose 兜底逐字不变', async () => {
  const parent = { id: FULL_SID }
  const sent = []
  const interrupted = []
  let disposed = 0
  // 即使卡上留着「continuable + 超时失败」的 run，开关关掉也必须零续跑（门禁在开关，不在 run 标记）
  const t = mkTask({ id: 'r5', title: '回退开关卡', status: 'pending', runs: [{ role: 'worker', id: 'child-old', at: '2026-01-01T00:00:00.000Z', model: '', outcome: 'timeout/error', hardMin: 120, continuable: true }] })
  const board = Object.assign(mkBoard([t]), { workerContinuable: false })
  const h = mkContinuableDispatch(board, { rootForSession: () => parent }, {
    subagents: {
      list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
      start: async () => ({ id: 'run-1', result: Promise.reject(new Error('boom')), dispose: async function () { disposed++ } }),
      startContinuable: async () => { throw new Error('开关关：不该走 continuable') },
      sendMessage: async (sender, targetId) => { sent.push(targetId); return 'msg' },
      interrupt: (id) => { interrupted.push(id) },
    },
  })
  await h.dispatch.poolCycle(FULL_SID)
  for (let i = 0; i < 4; i++) await flush()
  assert.deepEqual(sent, [])                    // 零冷复活
  assert.deepEqual(interrupted, [])             // 零 interrupt（一次性路径只 dispose）
  assert.ok(disposed >= 1)                      // 旧兜底照旧（run.dispose）
  assert.equal(t.status, 'pending')             // 失败结算语义不变
  assert.equal(t.retryCount, 1)
  assert.equal(h.runs['r5'], undefined)
  const last = t.runs[t.runs.length - 1]
  assert.equal(last.continuable, undefined)     // 一次性 run 不留 continuable 标记 → 天然不可续跑
  assert.equal(last.outcome, 'timeout/error')
})

// 子进程探针（卡2 续跑基线护栏）：真建 v4 日志 → 真续跑 → 区分「续跑轮没产出（旧文本不得冒充交付物）」
// 与「续跑轮真产出（正常推进 verifying）」。必须子进程：findRunLog 走 os.homedir() 且进程内首次调用即缓存。
const PROBE_RESUME_BASELINE_SOURCE = `
const fs = await import('node:fs')
const path = await import('node:path')
const zlib = await import('node:zlib')
const { createDispatch } = await import('./lib/dispatch.mjs')
const SID = 'session-test-0000-0000-000000000000'
const childId = 'child-old'
const logDir = path.join(process.env.HOME, '.dsh', 'sessions', 'b1', childId)
fs.mkdirSync(logDir, { recursive: true })
const logPath = path.join(logDir, 'session.v4.jsonl.zstd')
function frame(text) { return zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: text }] } } }) + '\\n')) }
fs.writeFileSync(logPath, frame('## 开发描述\\n上一轮（被中断那次）的残留文本，绝不能被当成续跑轮的交付物'))
const listeners = []
const runs = {}
const sent = []
const ctx = {
  fs: {}, get: () => null, timer: null,
  effect: function (f) { var d = f(); return function () { if (typeof d === 'function') d() } },
  on: function (n, f) { listeners.push(f); return function () {} },
  subagents: {
    list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
    start: async () => ({ id: 'run-1', result: new Promise(() => {}), dispose: async () => {} }),
    startContinuable: async () => ({ childId: 'child-x', messageId: 'm' }),
    sendMessage: async (sender, target) => { sent.push(target); return 'm2' },
    interrupt: () => {},
  },
}
const t = { id: 'w9', title: '续跑基线卡', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null, history: [], messages: [], runs: [{ role: 'worker', id: childId, at: '2026-01-01T00:00:00Z', model: '', outcome: 'timeout/error', hardMin: 120, continuable: true }] }
const board = { version: 11, ownerSession: SID, boardMode: 'auto', maxWorkers: 3, tasks: [t] }
const d = createDispatch(ctx, { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: { [SID]: runs } }, {
  rt: async () => board, wt: async () => {}, mutateLocked: async (s, f) => f(board), kickCycle: () => {}, rootForSession: () => ({ id: SID }),
  withTimeout: () => new Promise(() => {}), runsFor: () => runs, feedbackOn: () => true, pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
})
const idle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
// 第一轮：冷复活后「一个字都没产出」（日志无新字节）→ 必须按失败重排，不许拿残留文本推进 verifying
await d.poolCycle(SID)
listeners[0]({ agent: { session: { id: childId } }, status: 'running' })
listeners[0]({ agent: { session: { id: childId } }, status: 'idle' })
await idle()
const stale = { status: t.status, retryCount: t.retryCount || 0, deliverable: t.deliverable || null }
// 第二轮：真追加一帧（续跑轮真产出）→ 正常推进 verifying，交付物取自**新**文本
await d.poolCycle(SID)
fs.appendFileSync(logPath, frame('## 开发描述\\n续跑轮的新交付物\\n## 自测情况\\nok'))
listeners[0]({ agent: { session: { id: childId } }, status: 'running' })
listeners[0]({ agent: { session: { id: childId } }, status: 'idle' })
await idle()
console.log(JSON.stringify({ stale: stale, ok: { status: t.status, deliverable: t.deliverable || null }, sent: sent }))
`

test('可续跑 Worker⑫（卡2 续跑基线）：续跑轮没产出 → 残留旧文本不得冒充交付物（按失败重排）；真产出 → 正常推进 verifying', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbc2-'))
  try {
    const child = spawnSync(process.execPath, ['-e', PROBE_RESUME_BASELINE_SOURCE], { env: Object.assign({}, process.env, { HOME: tmp, USERPROFILE: tmp }), encoding: 'utf8' })
    assert.equal(child.status, 0, 'probe 失败: ' + child.stderr)
    const out = JSON.parse(child.stdout.trim().split('\n').pop())
    assert.deepEqual(out.sent, ['child-old', 'child-old'])   // 两轮都是真续跑（sendMessage 冷复活）
    // 第一轮：日志里明明有完整的分段格式文本，但那是上一轮的残留 → 只认基线之后的新字节 → 空文本按失败
    assert.equal(out.stale.status, 'pending')
    assert.equal(out.stale.retryCount, 1)
    assert.equal(out.stale.deliverable, null)
    // 第二轮：基线之后真追加了一帧 → 正常走文本通道推进 verifying，交付物取新文本
    assert.equal(out.ok.status, 'verifying')
    assert.match(out.ok.deliverable.summary, /续跑轮的新交付物/)
    assert.doesNotMatch(out.ok.deliverable.summary, /残留文本/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('可续跑 Worker⑬（卡2 手动终止臂）：终止 continuable run → interrupt 留存（零 dispose），任务回 pending 且关 run 结局 terminated（不留续跑资格）', async () => {
  const parent = { id: FULL_SID }
  const calls = { interrupt: [] }
  const closed = []
  const t = mkTask({ id: 'mt1', title: '手动终止卡', status: 'in-progress', claimedBy: 'child-live', runs: [{ role: 'worker', id: 'child-live', at: '2026-01-01T00:00:00.000Z', model: '', outcome: 'running', hardMin: 120, continuable: true }] })
  const board = mkBoard([t])
  // 活跃 rec：continuable 形态（无 run，只能 interrupt）
  const runs = { mt1: { id: 'child-live', childId: 'child-live', continuable: true, ran: true, run: null, role: 'worker', taskId: 'mt1', startedAt: Date.now(), model: '', settled: false } }
  const h = mkRpcHandlers(board, {
    rootForSession: () => parent, runsFor: () => runs,
    // 手动终止 run 关账（task-mv1pqy27）：与生产 dispatch.closeRunHistory 同口径，只关 outcome==='running' 的条目
    closeRunHistory: async (sid, taskId, runId, outcome) => { closed.push({ taskId: taskId, runId: runId, outcome: outcome }); var tt = board.tasks.find(function (x) { return x.id === taskId }); if (tt && Array.isArray(tt.runs)) { var rr = tt.runs[tt.runs.length - 1]; if (rr && rr.id === runId && rr.outcome === 'running') { rr.outcome = outcome; rr.endedAt = '2026-01-01T00:00:01Z' } } }
  }, { subagents: { interrupt: (id, auth) => calls.interrupt.push({ id: id, auth: auth }) } })
  const r = await h['terminate-agent']({ taskId: 'mt1' })
  assert.equal(r.ok, true); assert.equal(r.terminated, 'worker:mt1')
  // 终止 = interrupt 留存（不是 dispose）：authority 形状同硬超时臂
  assert.deepEqual(calls.interrupt, [{ id: 'child-live', auth: { kind: 'ancestor', agent: parent } }])
  assert.equal(runs.mt1, undefined)                 // 活跃表摘除（结算通道随之关闭，不会被 idle 事件误结算）
  assert.equal(t.status, 'pending'); assert.equal(t.claimedBy, null) // 既有语义：重新排队
  // 关 run 结局 terminated（与状态无关，task-mv1pqy27）：terminated 不满足 resumeTarget 续跑判据 → 仍不留续跑资格
  assert.deepEqual(closed, [{ taskId: 'mt1', runId: 'child-live', outcome: 'terminated' }])
  assert.equal(t.runs[t.runs.length - 1].outcome, 'terminated')
})

test('hooks 接线（源码级）：spawnOneShot 三态 prompt + settleRun 分派 + pre/post 占用与 spawn 失败回收', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  // spawnOneShot：hook 角色走 buildHookPrompt（phase 由 role 决定）
  assert.match(dsp, /if \(role === 'hook-pre' \|\| role === 'hook-post'\) \{/)
  assert.match(dsp, /buildHookPrompt\(t, role === 'hook-pre' \? 'pre' : 'post', kids\)/)
  // settleRun：hook 分支进 settleHook（照 worker/verifier 结算模式）
  assert.match(dsp, /else if \(rec\.role === 'hook-pre' \|\| rec\.role === 'hook-post'\) await settleHook\(sid, rec, output, failed, errText\)/)
  assert.match(dsp, /applyHookSettle\(d, rec\.taskId, phase, !\(failed \|\| esc\), output, runId, errText\)/)
  // pre 闸门占用（state=running 即幂等占用）与 post 补 spawn（pending 标记驱动，复用 verifierRun 幂等位）
  assert.match(dsp, /if \(hookOn\(t, 'pre'\) && t\.hooks\.pre\.state === 'idle' && !runs\[t\.id\]\) \{/)
  assert.match(dsp, /hookSetState\(t, 'pre', 'running', 'system', '派发前置 hook run'\)/)
  assert.match(dsp, /t\.hooks\.post\.pending && !t\.verifierRun && !runs\[t\.id\]/)
  // spawn 失败回收：pre 退回 idle 重试 / post 保留待跑标记
  assert.match(dsp, /sp\.role === 'hook-pre'/)
  assert.match(dsp, /t\.hooks\.pre\.state === 'running'\) \{ t\.hooks\.pre\.state = 'idle'/)
  assert.match(dsp, /sp\.role === 'hook-post'/)
  // 角色口径注释：hook run 计入 activeV（不挤占 Worker 并发位但参与空闲快进判定）
  assert.match(dsp, /hook run 不是 Worker，不该挤占 maxWorkers 并发位/)
  // core：post 延迟 verifying 注释与串行闸门说明在位（设计意图可追溯）
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /post 延迟 verifying（hooks=agent run 接线③）/)
  assert.match(coreSrc, /串行闸门语义 = 「一个 epic 的子任务在 pre hook 完成之前一张都不派」/)
  assert.match(coreSrc, /commit\/push 不进任何默认形态/)
})

test('hooks 主窗口限定（源码级）：RPC 与工具双通道门禁 + 浅校验口径唯一在 core.normalizeHooks', () => {
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  assert.match(rpc, /var HOOKS_MAIN_ONLY = 'hooks 仅主窗口可设（子代理无 hooks 权限）'/)
  assert.match(rpc, /function hooksDenied\(actor\) \{ return resolveRoot\(actor\) !== actor \}/)
  // create-task RPC：锁外角色门禁 + 锁内形状校验（与建卡同处一次持锁段）
  assert.match(rpc, /if \(args\.hooks !== undefined && hooksDenied\(actor\)\) return \{ ok: false, error: HOOKS_MAIN_ONLY \}/)
  assert.match(rpc, /var nHooks = null; if \(args\.hooks !== undefined\) \{ var hn = normalizeHooks\(args\.hooks\)/)
  // update-task RPC：同一门禁 + 浅合并
  assert.match(rpc, /if \(args\.hooks !== undefined && hooksDenied\(actor\)\) return \{ ok: false, error: HOOKS_MAIN_ONLY \}; var existsFn = existsInSession\(sid\)/)
  assert.match(rpc, /if \(args\.hooks !== undefined\) \{ var __he = applyHooks\(t, args\.hooks\)/)
  // 工具通道：两个工具的 hooks 专属门禁（在通用门禁之后，子代理拿到更准确的错误文案）
  assert.equal((rpc.match(/if \(args\.hooks !== undefined && resolveRoot\(__ra\) !== __ra\) return \{ ok: false, error: 'hooks 仅主窗口可设（子代理无 hooks 权限）' \}/g) || []).length, 2)
  // 形状校验口径唯一（normalizeHooks/mergeHooks 只在 core 定义，rpc 只解构引用）
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /export function normalizeHooks\(input\)/)
  assert.match(coreSrc, /export function mergeHooks\(prev, next\)/)
})

test('史诗语义层接线：poolCycle 派发分支触发父卡流转 + get-tasks 返回 childStats（源码级断言）', () => {
  const host = hostSrc()
  // poolCycle 占位 claim 的 dispatch 分支：claimApply 后紧跟 parentKickOnDispatch
  assert.match(host, /claimApply\(d, t, 'spawn-pending', 'dispatch'\); if \(parentKickOnDispatch\(d, t\)\)/)
  // get-tasks 现算 childStats（零存储）
  assert.match(host, /d\.childStats = aggregateChildStats\(d\.tasks\)/)
  // 两模块都从 core 解构引入（接线不断）；rpc.mjs 解构表尾部随调研门禁（task-mute6zpw）、调研遵循三件套（task-mutnj3a4）、
  // tasksHash（task-mutrtwin）、hooks 浅校验（normalizeHooks/mergeHooks，本批 hooks=agent run）、
  // 自测指南归一（normalizeUserTest，task-muxyyvg0）扩展；
  // dispatch.mjs 解构表尾部追加 hook 族（buildHookPrompt/hookOn/hookSetState/gsb）与驳回包 helper（pushRejection，task-muvg15p5）、
  // Verifier 验收员加餐常量（VERIFIER_PERSONA/VERIFIER_TOOL_FILTER，task-muy3gm03）
  assert.match(host, /parentKickOnDispatch, LESSON_RECALL_HINT, buildHookPrompt, applyHookSettle, hookOn, hookSetState, gsb, pushRejection, VERIFIER_PERSONA, VERIFIER_TOOL_FILTER \} = core/)
  assert.match(host, /boardHome, aggregateChildStats, createTaskWarnings, epicPrecheck, epicPrecheckNote, attachContextSuggestions, REJECT_REDISPATCH_HINT, tasksHash, normalizeHooks, mergeHooks, pushRejection, normalizeUserTest, draftLint \} = core/)
  // 既有「全子任务 resolved → 父 verifying」逻辑不动（checkParentAuto 仍在 verifyApply 链路；
  // 但其内部已委托共享 helper maybeAutoCloseParent——单一判定口径，core.mjs 不在 hostSrc 清单，单独读）
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /if \(verdict === 'approved' && isb\(t\)\) \{ var p = checkParentAuto\(d, t\)/)
  assert.match(coreSrc, /export function checkParentAuto\(d, t\) \{ return maybeAutoCloseParent\(d, t\) \}/)
})

// ===== 防再发：notify 逻辑单一来源（lib/notify.mjs）=====
// dispatch.mjs 曾藏整套 notify 僵尸重复副本（本地 receiptBuf/escNotifyTimers + notifyTaskDone/flushReceipts 等：
// 函数声明提升后被头部 var x = deps.x 赋值覆盖，是永不执行的死代码——改错地方不产生效果，挪赋值顺序即引爆）。
// 此处断言六个函数的定义只存在于 notify.mjs，任何模块再长出副本即红。
test('notify 单一来源：notifyTaskDone/flushReceipts/deliverEscalation 等函数定义只存在于 lib/notify.mjs', () => {
  const names = ['deliverEscalation', 'notifyMainWindow', 'maybeNotify', 'notifyTaskDone', 'notifyDispatched', 'pushSysNote', 'flushReceipts']
  const others = ['../index.mjs', '../lib/policy.mjs', '../lib/usage.mjs', '../lib/session.mjs', '../lib/store.mjs', '../lib/dispatch.mjs', '../lib/rpc.mjs']
  const notifySrc = readFileSync(new URL('../lib/notify.mjs', import.meta.url), 'utf8')
  for (const name of names) {
    const re = new RegExp('function ' + name + '\\s*\\(')
    assert.match(notifySrc, re, 'lib/notify.mjs 缺少 ' + name + ' 定义（权威实现应在此）')
    for (const f of others) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      assert.ok(!re.test(src), f + ' 不得再定义 ' + name + '（notify 逻辑唯一权威在 lib/notify.mjs，副本是僵尸死代码）')
    }
  }
})

// ===== 派发即回执（task-muuoduri）：notifyDispatched 入 45s 聚合队列「🚀 已派发」区 =====
// createNotify 直调 harness：mock ctx.timer 捕获 45s 窗口回调（不自动触发 → 无 45s 真等待）；
// root.followup 捕获投递文本；rt 按 o.board 返回看板快照（投递前状态过滤读的就是它）。
function mkNotify(options) {
  const o = options || {}
  const captured = []
  let board = o.board || { tasks: [] }
  const state = { escNotifyTimers: {}, receiptBuf: {}, receiptedKeys: {}, sysNotesBuf: {} }
  const ctx = { timer: { timeout: () => new Promise(() => {}) } } // 窗口回调不自动触发，测试按「满 5 条」同步冲刷
  const root = { followup: (m) => { captured.push(m) }, whenIdle: () => Promise.resolve() }
  const deps = {
    rt: async () => board,
    rootForSession: () => (o.noRoot ? null : root),
    withTimeout: (p) => p,
    isDispatched: (sid, id) => !!id,
  }
  const notify = createNotify(ctx, state, deps)
  return { notify, state, captured, setBoard: (b) => { board = b } }
}
function textOf(m) { return m.content.map(c => c.text).join('\n') }
const DTASK = (over) => mkTask(Object.assign({ id: 'dt1', title: '派发中的卡', status: 'in-progress', claimedBy: 'run-1', claimedAt: '2026-01-02T00:00:00Z' }, over || {}))
// 顶开窗口：再入 4 条完成回执触发「满 5 条」同步冲刷（真实生产冲刷路径，无 45s 真等待）
function pushFour(h) { for (const i of [1, 2, 3, 4]) h.notify.notifyTaskDone('s1', mkTask({ id: 'k' + i, title: 'K' + i, status: 'resolved', claimedBy: 'r' + i, resolvedAt: 'T' + i }), 'resolved') }

test('派发回执①：notifyDispatched 入队（kind=dispatched + role）→ flush 出「🚀 已派发」区', async () => {
  const h = mkNotify({ board: { tasks: [DTASK()] } })
  h.notify.notifyDispatched('s1', DTASK(), 'worker')
  const buf = h.state.receiptBuf.s1
  assert.equal(buf.items.length, 1)
  assert.equal(buf.items[0].kind, 'dispatched')
  assert.equal(buf.items[0].role, 'worker')
  pushFour(h)
  await new Promise(r => setImmediate(r))
  assert.equal(h.captured.length, 1)
  const txt = textOf(h.captured[0])
  assert.match(txt, /🚀 已派发 1 个：/)
  assert.match(txt, /派发中的卡 \(dt1\) — Worker 执行中/)
  assert.equal(h.captured[0].source.kind, 'plugin:dsh-agent-board')

  // verifier 角色文案
  const vt = mkTask({ id: 'v1', title: '验收中的卡', status: 'in-progress', claimedBy: 'w0', verifierRun: 'v-1' })
  const h2 = mkNotify({ board: { tasks: [vt] } })
  h2.notify.notifyDispatched('s1', vt, 'verifier')
  pushFour(h2)
  await new Promise(r => setImmediate(r))
  assert.match(textOf(h2.captured[0]), /验收中的卡 \(v1\) — Verifier 验收中/)
})

test('派发回执②：flush 时任务已离场（非 in-progress）→ dispatched 项被丢弃', async () => {
  const h = mkNotify({ board: { tasks: [mkTask({ id: 'fast', title: '10 秒探针', status: 'resolved', claimedBy: 'run-1' })] } })
  h.notify.notifyDispatched('s1', mkTask({ id: 'fast', title: '10 秒探针', status: 'in-progress', claimedBy: 'run-1', claimedAt: 'T' }), 'worker')
  assert.equal(h.state.receiptBuf.s1.items.length, 1) // 入队照常（派发时刻确实派发了）
  pushFour(h)
  await new Promise(r => setImmediate(r))
  assert.equal(h.captured.length, 1)
  const txt = textOf(h.captured[0])
  assert.doesNotMatch(txt, /🚀 已派发/)   // 已离场的派发回执被丢弃
  assert.doesNotMatch(txt, /10 秒探针/)   // 不与完成回执重复刷屏
  assert.match(txt, /✅ 完成 4 个：/)      // 完成回执（主通道）照常投递
})

test('派发回执③：完成回执与派发回执同窗口 → 合并成一条消息', async () => {
  const t = mkTask({ id: 'm1', title: '合并卡', status: 'in-progress', claimedBy: 'run-9', claimedAt: 'T' })
  const h = mkNotify({ board: { tasks: [t] } })
  h.notify.notifyDispatched('s1', t, 'worker')                                                              // 派发时刻
  h.notify.notifyTaskDone('s1', Object.assign({}, t, { status: 'resolved', resolvedAt: 'T3' }), 'resolved')  // 完成时刻（同一窗口）
  pushFour(h)
  await new Promise(r => setImmediate(r))
  assert.equal(h.captured.length, 1) // 一条消息，不是两条
  const txt = textOf(h.captured[0])
  assert.match(txt, /回执摘要（5 条）/)
  assert.match(txt, /🚀 已派发 1 个：/)
  assert.match(txt, /✅ 完成 4 个：/)
})

test('派发回执④：deps 未注入 notifyDispatched（老 host）→ 静默跳过，不抛错', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  // 回执开关（task-muuwgcro）加在 deps 注入判断之前：关掉开关与老 host 未注入两种静默路径共用同一行
  assert.match(dsp, /if \(c\.notifyDispatch !== false && typeof notifyDispatched === 'function'\) notifyDispatched\(sid, sp\.t, sp\.role\)/)
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(idx, /notifyDispatched: notify\.notifyDispatched/) // index.mjs 接线在位
  // 行为面：deps 未提供 isDispatched 时 notifyDispatched 照常入队（老 host 兼容，零依赖完成回执判定）
  const h = mkNotify({ board: { tasks: [DTASK()] } })
  assert.doesNotThrow(() => h.notify.notifyDispatched('s1', DTASK(), 'worker'))
  assert.equal(h.state.receiptBuf.s1.items.length, 1)
})

// ===== 回执开关进设置（task-muuwgcro）：板级 notifyDispatch/notifyDone 双布尔（缺省 true）+ 两处闸门 =====
// 用户指令：「回执可以做一个开关，放到设置里」。语义：设置区「通知」小节可分别关掉「派发回执」与
// 「完成回执」；歧义裁决通知（notifyMainWindow）是裁决通道不是回执，不接入开关。
test('回执开关①：cfg/normalizeBoard/seed 三处缺省均为 true（老板文件与新建板行为不变）', () => {
  // ① 空对象（最老形态）：cfg 归一为 true，不是 undefined/假值——闸门读的是 !== false
  const c = core.cfg({})
  assert.equal(c.notifyDispatch, true)
  assert.equal(c.notifyDone, true)
  // ② 老看板文件（无该字段）→ normalizeBoard 补 true（读路径兜底，UI 勾选态确定）
  const old = core.normalizeBoard({ version: 11, tasks: [] })
  assert.equal(old.notifyDispatch, true)
  assert.equal(old.notifyDone, true)
  // ③ 显式 false 原样保留；非布尔脏值收敛回 true（与 feedbackEnabled 同一归一化口径）
  const off = core.normalizeBoard({ notifyDispatch: false, notifyDone: false })
  assert.equal(off.notifyDispatch, false)
  assert.equal(off.notifyDone, false)
  assert.equal(core.cfg({ notifyDispatch: false, notifyDone: false }).notifyDispatch, false)
  assert.equal(core.cfg({ notifyDispatch: false, notifyDone: false }).notifyDone, false)
  const dirty = core.normalizeBoard({ notifyDispatch: 'no', notifyDone: 0 })
  assert.equal(dirty.notifyDispatch, true)
  assert.equal(dirty.notifyDone, true)
  // ④ 新建板种子显式带两个 true（seed 与 cfg 口径一致）
  const seeded = core.seed('s1')
  assert.equal(seeded.notifyDispatch, true)
  assert.equal(seeded.notifyDone, true)
})

test('回执开关②：notifyDispatch=false → spawn 成功也不入派发回执（真跑 poolCycle + 真 spawnOneShot）', async () => {
  const calls = []
  // 真 spawnOneShot 需要一个可用 provider：start/startContinuable 都返回永不结算的 run
  // （派发回执只看 spawn 成功，不看结局）；两条路都 mock，用例才对「Worker 默认 continuable」无感。
  const ctxOver = { subagents: { list: () => ['p1'], getProvider: () => ({ inheritsParentContext: false }), start: async () => ({ id: 'run-1', dispose() {}, result: new Promise(function () {}) }), startContinuable: async () => ({ childId: 'child-1', messageId: 'msg-1' }) } }
  function run(flag) {
    const board = Object.assign(mkBoard([mkTask({ id: 'dt1', title: '被派的卡' })]), { maxWorkers: 3, notifyDispatch: flag })
    return mkDispatch(board, {
      rootForSession: () => ({ id: FULL_SID }),
      notifyDispatched: (sid, t, role) => calls.push({ sid: sid, id: t.id, role: role }),
    }, ctxOver)
  }
  // 关：spawn 照常成功（占位 claim + 历史留档 + run id 回写，多次写盘），但派发回执一次都不入队
  const off = run(false)
  await off.dispatch.poolCycle(FULL_SID)
  assert.equal(calls.length, 0, 'notifyDispatch=false 时不得入派发回执')
  assert.ok(off.counters.writes > 1, '派发确实发生（不是因未派发才没回执）')
  // 开（缺字段 → cfg 默认 true）：同一路径照常回执，证明闸门没误伤正常路径
  calls.length = 0
  const on = run(true)
  await on.dispatch.poolCycle(FULL_SID)
  assert.deepEqual(calls, [{ sid: FULL_SID, id: 'dt1', role: 'worker' }])
})

test('回执开关③b：notifyDone=false → worker 三连败转 blocked 也不入完成回执（真跑结算路径）', async () => {
  const done = []
  // run 立即失败（Promise.reject）→ settleRun 走失败分支 → retryCount 2→3 → blocked（状态机不受开关影响）。
  // 两条 spawn 路都挂上立即失败的结局：Worker 默认走 continuable（spawnOneShot 里约定的
  // continuableResult 测试钩子），workerContinuable=false 时才落到一次性 run.result。
  const ctxOver = { subagents: { list: () => ['p1'], getProvider: () => ({ inheritsParentContext: false }), start: async () => ({ id: 'run-1', dispose() {}, result: Promise.reject(new Error('boom')) }), startContinuable: async () => ({ childId: 'child-1', messageId: 'msg-1' }) } }
  async function run(flag, continuable) {
    done.length = 0
    const runs = {} // 稳定 runs 表：settleRun 靠 runsFor(sid)[taskId] === rec 认领本次 run
    const board = Object.assign(mkBoard([mkTask({ id: 'dt2', title: '会失败的卡', retryCount: 2 })]), { maxWorkers: 3, notifyDone: flag, workerContinuable: continuable })
    const h = mkDispatch(board, {
      rootForSession: () => ({ id: FULL_SID }),
      runsFor: () => runs,
      // 测试钩子：continuable 没有 run.result，这里注入一个立即失败的结果
      // （生产不注入 → 永不落定，结算只走 agent/status 的 idle）
      continuableResult: () => Promise.reject(new Error('boom')),
      notifyTaskDone: (sid, t, kind) => done.push({ id: t.id, kind: kind, status: t.status }),
    }, ctxOver)
    await h.dispatch.poolCycle(FULL_SID)
    for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)) // 结算链（含 closeRunHistory/usage）全在微任务里
    return { h, board }
  }
  // 关（continuable 默认路径）：照常 blocked（卡该阻塞就阻塞），只是一条完成回执都不发
  const off = await run(false, true)
  assert.equal(off.board.tasks[0].status, 'blocked')
  assert.deepEqual(done, [])
  // 开：同一路径照常回执（证明闸门没误伤完成回执主通道）
  const on = await run(true, true)
  assert.equal(on.board.tasks[0].status, 'blocked')
  assert.deepEqual(done, [{ id: 'dt2', kind: 'blocked', status: 'blocked' }])
  // 回退路径（workerContinuable=false）：一次性 run.result 结算语义逐字不变（同一断言恒成立）
  const legacy = await run(true, false)
  assert.equal(legacy.board.tasks[0].status, 'blocked')
  assert.deepEqual(done, [{ id: 'dt2', kind: 'blocked', status: 'blocked' }])
})

test('回执开关③/④：完成/阻塞回执闸门在结算调用方；歧义裁决通道零开关（源码级断言）', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const noti = readFileSync(new URL('../lib/notify.mjs', import.meta.url), 'utf8')
  // 完成回执：三个结算函数（worker/verifier/hook）都在同一次持锁回调里取 notifyDone（零额外读盘）
  assert.equal((dsp.match(/doneOn = cfg\(d\)\.notifyDone !== false/g) || []).length, 3)
  assert.equal((dsp.match(/if \(doneOn && /g) || []).length, 5) // worker 2 + verifier 2 + hook-closed 1
  assert.match(dsp, /if \(doneOn && result\.task && result\.task\.status === 'resolved'\) notifyTaskDone\(sid, result\.task, 'resolved'\)/)
  assert.match(dsp, /if \(doneOn && result\.task && result\.task\.status === 'blocked'\) notifyTaskDone\(sid, result\.task, 'blocked'\)/)
  assert.match(dsp, /if \(result\.blocked\) \{ maybeNotify\(sid, result\.task\); if \(doneOn\) notifyTaskDone\(sid, result\.task, 'blocked'\) \}/)
  // 闸门默认 true：回调未跑到也不漏报（宁可多报）
  assert.equal((dsp.match(/var doneOn = true/g) || []).length, 3)
  // ④ 歧义通道零开关：通知层根本读不到板级配置（cfg 未引入），去注释后的上报代码段不含两个开关名
  assert.doesNotMatch(noti, /cfg\(/)
  const escBlock = noti.slice(noti.indexOf('// 歧义上报通知'), noti.indexOf('// ===== 任务回执通知'))
  assert.ok(escBlock.length > 200, '上报段切片成功（锚点注释在位）')
  const escCode = escBlock.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  assert.doesNotMatch(escCode, /notifyDispatch|notifyDone/)
  // 三个结算点的歧义通知调用（maybeNotify）都不带任何开关闸门
  assert.equal((dsp.match(/maybeNotify\(sid, result\.task\)/g) || []).length, 3)
})

test('回执开关⑤：设置弹层「通知」小节两行开关 + set-board-config 读写通道（源码 + RPC 行为）', async () => {
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // UI：小节标题 + 两行开关文案 + 各自 RPC 键（勾选态缺字段=开，与 host 缺省一致）
  assert.match(cli, /'通知'/)
  assert.match(cli, /'⚡ 派发回执（任务被 Worker\/Verifier 领走时播报）'/)
  assert.match(cli, /'✅ 完成回执（任务完成或阻塞时聚合播报）'/)
  // 开关行走乐观路径（task-muw5uudk：点击瞬时翻面，rpc 与失败回滚在 setCfg 内；键名分别断言）
  assert.match(cli, /checked: props\.notifyDispatch !== false, onChange: function \(e\) \{ setCfg\('notifyDispatch', e\.target\.checked\) \}/)
  assert.match(cli, /checked: props\.notifyDone !== false, onChange: function \(e\) \{ setCfg\('notifyDone', e\.target\.checked\) \}/)
  assert.match(cli, /歧义裁决通知不受这两个开关影响/)
  // 透传链路：state 读取（老 host 缺字段=开）→ TopPanel useState → PoolCfgPopover props
  assert.match(cli, /state\.notifyDispatch = cfgKnobOf\(d, 'notifyDispatch'\)/) // 读取口径单点定义（task-muw5uudk）
  assert.match(cli, /state\.notifyDone = cfgKnobOf\(d, 'notifyDone'\)/) // 读取口径单点定义（task-muw5uudk）
  assert.match(cli, /useState\(state\.notifyDispatch\)/)
  assert.match(cli, /feedbackEnabled: fbEnabled, notifyDispatch: ndOn, notifyDone: nnOn/)
  // host 通道：set-board-config 白名单两键布尔原样存 + get-tasks 显式透出确定布尔值
  const board = mkBoard([])
  const h = mkRpcHandlers(board)
  await h['set-board-config']({ key: 'notifyDispatch', value: false })
  await h['set-board-config']({ key: 'notifyDone', value: false })
  assert.equal(board.notifyDispatch, false)
  assert.equal(board.notifyDone, false)
  await h['set-board-config']({ key: 'notifyDispatch', value: true })
  const got = await h['get-tasks']({})
  assert.equal(got.notifyDispatch, true)
  assert.equal(got.notifyDone, false)
})

// ===== 调研门禁·UI：无调研徽章 + 详情注入清单 + 创建表单 warning 展示（源码级断言）=====
test('调研门禁 UI 接线：卡片「⚠️ 无调研」徽章 + 详情「调研注入」清单 + 创建表单 warning 黄行（源码级断言）', () => {
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(cli, /function noResearch\(t\)/)                        // 徽章判定函数（纯 client 侧现算）
  assert.match(cli, /pl !== 'full' && pl !== 'work'/)                 // 口径：仅 full/work 管线参与（direct 主窗口自处理）
  assert.match(cli, /'⚠️ 无调研'/)                                     // 卡片标题行右侧徽章文案
  assert.match(cli, /本任务未附调研上下文，Worker 需自行定位/)          // 徽章悬停解释（title）
  assert.match(cli, /var cx = t\.context \|\| \{\}/)                  // context 缺省兼容：老任务无 context 按空处理（预期亮徽章）
  assert.match(cli, /'📎 调研注入: '/)                                 // 详情页「调研注入」区标题
  assert.match(cli, /无调研注入——Worker 需自行定位/)                    // 详情空态明示
  assert.match(cli, /个文件（' \+ files\.map\(function \(f\) \{ return actBase\(f\) \}\)/) // files 清单按 basename 展示
  assert.match(cli, /调研笔记 ' \+ notes\.length \+ ' 字/)              // notes 字数统计
  assert.match(cli, /if \(r && r\.warning\)/)                          // 创建表单消费 create-task 响应的 warning 字段
  assert.match(cli, /'⚠️ ' \+ warn/)                                   // warning 原文黄色行展示（C.warn）
})

// ===== 反馈修复（task-mutrtwin）：僵尸 epic 归档放行 + get-tasks tasksHash =====
// ① archive-task 对「无活跃 run 的 in-progress」放行（parentKick 僵尸态出清，反馈 n-mutma3mmwceq）；
// ② get-tasks 附 tasksHash（core 纯函数 djb2），kernel hash 相同跳渲染（反馈 n-mut9rzs2mkhg）。

test('tasksHash: 同输入同 hash（纯函数稳定；JSON 重解析的等价形态 hash 相同）', () => {
  const a = [mkTask({ id: 'a', title: '甲' }), mkTask({ id: 'b', status: 'in-progress' })]
  assert.equal(core.tasksHash(a), core.tasksHash(a))
  // 跨轮询 rt() 重新 JSON.parse 的同内容对象 → hash 相同（短路生效的前提）
  assert.equal(core.tasksHash(a), core.tasksHash(JSON.parse(JSON.stringify(a))))
  assert.equal(core.tasksHash([]), core.tasksHash([]))
  assert.equal(core.tasksHash(undefined), core.tasksHash(null)) // 非数组一律按空板兜底
})

test('tasksHash: 关键字段变 → hash 变；非关键字段（history/messages/usage）变 → hash 不变', () => {
  const h0 = core.tasksHash([mkTask({ id: 'a' })])
  // 关键字段逐一变化（驱动列表/详情渲染的字段）
  assert.notEqual(core.tasksHash([mkTask({ id: 'a', status: 'in-progress' })]), h0)
  assert.notEqual(core.tasksHash([mkTask({ id: 'a', title: '改名' })]), h0)
  assert.notEqual(core.tasksHash([mkTask({ id: 'a', priority: 'high' })]), h0)
  assert.notEqual(core.tasksHash([mkTask({ id: 'a', lastError: 'boom' })]), h0)
  assert.notEqual(core.tasksHash([mkTask({ id: 'a', lastProgress: { text: '过半', at: 'x' } })]), h0)
  assert.notEqual(core.tasksHash([mkTask({ id: 'a', resolvedAt: '2026-01-02T00:00:00Z' })]), h0)
  assert.notEqual(core.tasksHash([mkTask({ id: 'a', frozen: true })]), h0)
  // escalation 必须入 hash：board_report escalate 只写 escalation/messages/history、
  // 不动其他任何字段——漏掉它「新歧义自动弹开面板」会被 hash 短路吞掉
  assert.notEqual(core.tasksHash([mkTask({ id: 'a', escalation: { question: '歧义', at: 'x', by: 'w' } })]), h0)
  // 非关键字段不动 hash（不驱动列表渲染，参与会让结算写账/进展消息引发空渲染抖动）
  const t1 = mkTask({ id: 'a' }); t1.history.push({ from: 'pending', to: 'in-progress', timestamp: 'x', actor: 'y', note: '' })
  assert.equal(core.tasksHash([t1]), h0)
  const t2 = mkTask({ id: 'a' }); t2.messages.push({ kind: 'progress', text: 'p', at: 'x', by: 'w' })
  assert.equal(core.tasksHash([t2]), h0)
  const t3 = mkTask({ id: 'a' }); t3.usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, runs: 1, models: {} }
  assert.equal(core.tasksHash([t3]), h0)
})

test('tasksHash: 顺序有关（数组序变化 → hash 变；看板按数组序渲染，口径写清）', () => {
  const a = mkTask({ id: 'a' }), b = mkTask({ id: 'b' })
  assert.notEqual(core.tasksHash([a, b]), core.tasksHash([b, a]))
})

test('archive-task RPC: resolved/cancelled 放行（既有行为不破）', async () => {
  const board = mkBoard([mkTask({ id: 'r1', status: 'resolved' }), mkTask({ id: 'c1', status: 'cancelled' })])
  const h = mkRpcHandlers(board)
  assert.equal((await h['archive-task']({ taskId: 'r1' })).ok, true)
  assert.equal((await h['archive-task']({ taskId: 'c1' })).ok, true)
  assert.equal(board.tasks[0].status, 'archived')
  assert.equal(board.tasks[1].status, 'archived')
})

test('archive-task RPC: in-progress 无活跃 run 放行（parentKick 僵尸 epic 出清）', async () => {
  // 僵尸态还原：direct epic 被 parentKickOnDispatch 推进到 in-progress，子任务已归档、无 run、claimedBy=null
  const zombie = mkTask({ id: 'z1', status: 'in-progress', claimedBy: null, pipeline: 'direct' })
  const board = mkBoard([zombie])
  const h = mkRpcHandlers(board, { hasActiveRun: () => false })
  const r = await h['archive-task']({ taskId: 'z1' })
  assert.equal(r.ok, true); assert.equal(zombie.status, 'archived'); assert.ok(zombie.archivedAt)
})

test('archive-task RPC: in-progress 有活跃 run 拒绝；已 settled run 放行；未注入 hasActiveRun 按活跃兜底', async () => {
  // 有活跃 run → 拒绝（不能归在跑的任务）
  let t = mkTask({ id: 'a1', status: 'in-progress' })
  let h = mkRpcHandlers(mkBoard([t]), { hasActiveRun: () => true })
  let r = await h['archive-task']({ taskId: 'a1' })
  assert.equal(r.ok, false); assert.match(r.error, /cannot archive/); assert.equal(t.status, 'in-progress')
  // 有 run 记录但已 settled（finish→settleRun 过渡窗口，Worker 已结束）→ 放行
  // （hasActiveRun 的 !settled 口径由 index.mjs 实现，此处 mock 其结论）
  t = mkTask({ id: 'a2', status: 'in-progress' })
  h = mkRpcHandlers(mkBoard([t]), { hasActiveRun: () => false })
  r = await h['archive-task']({ taskId: 'a2' })
  assert.equal(r.ok, true); assert.equal(t.status, 'archived')
  // deps 未注入 hasActiveRun → 保守兜底视为有活跃 run → 拒绝（保持旧门禁行为，不误放在跑任务）
  t = mkTask({ id: 'a3', status: 'in-progress' })
  h = mkRpcHandlers(mkBoard([t]))
  r = await h['archive-task']({ taskId: 'a3' })
  assert.equal(r.ok, false); assert.match(r.error, /cannot archive/)
  // 其余状态（verifying 等）仍拒绝——放行面只扩到「无活跃 run 的 in-progress」
  t = mkTask({ id: 'a4', status: 'verifying' })
  h = mkRpcHandlers(mkBoard([t]), { hasActiveRun: () => false })
  r = await h['archive-task']({ taskId: 'a4' })
  assert.equal(r.ok, false); assert.match(r.error, /cannot archive/)
})

test('task_archive 工具：与 archive-task RPC 同一门禁口径（僵尸放行/活跃拒绝）', async () => {
  let t = mkTask({ id: 'z2', status: 'in-progress', claimedBy: null })
  let h = mkRpcHandlers(mkBoard([t]), { hasActiveRun: () => false })
  let r = await h.__tools['task_archive'].execute({ taskId: 'z2' }, {})
  assert.equal(r.ok, true); assert.equal(t.status, 'archived')
  t = mkTask({ id: 'z3', status: 'in-progress' })
  h = mkRpcHandlers(mkBoard([t]), { hasActiveRun: () => true })
  r = await h.__tools['task_archive'].execute({ taskId: 'z3' }, {})
  assert.equal(r.ok, false); assert.match(r.error, /cannot archive/)
})

// ===== 取消通道（task_cancel 工具 + cancel-task RPC，反馈 n-mv0zbqk...）=====
test('cancel-task RPC: draft/pending/blocked 三态可取消，reason 落历史', async () => {
  const d1 = mkTask({ id: 'd1', status: 'draft' })
  const p1 = mkTask({ id: 'p1', status: 'pending' })
  const b1 = mkTask({ id: 'b1', status: 'blocked', resolution: '卡住了' })
  const board = mkBoard([d1, p1, b1])
  const h = mkRpcHandlers(board)
  assert.equal((await h['cancel-task']({ taskId: 'd1', reason: '误建' })).ok, true)
  assert.equal((await h['cancel-task']({ taskId: 'p1' })).ok, true)
  assert.equal((await h['cancel-task']({ taskId: 'b1', reason: '放弃' })).ok, true)
  assert.equal(d1.status, 'cancelled'); assert.ok(d1.cancelledAt)
  assert.equal(p1.status, 'cancelled'); assert.ok(p1.cancelledAt)
  assert.equal(b1.status, 'cancelled'); assert.equal(b1.resolution, null) // 阻塞残留 resolution 清空
  // reason 落历史（actor + note）
  assert.ok(d1.history.some(function (x) { return x.to === 'cancelled' && x.actor === 'tester' && /取消: 误建/.test(x.note) }))
  assert.ok(p1.history.some(function (x) { return x.to === 'cancelled' && x.actor === 'tester' && /取消/.test(x.note) }))
  assert.ok(b1.history.some(function (x) { return x.to === 'cancelled' && /取消: 放弃/.test(x.note) }))
})

test('cancel-task RPC: in-progress(真实 run)/verifying/resolved 拒（terminate/archive 语义）', async () => {
  const ip = mkTask({ id: 'ip', status: 'in-progress', claimedBy: 'run-x' })
  const vf = mkTask({ id: 'vf', status: 'verifying' })
  const rs = mkTask({ id: 'rs', status: 'resolved' })
  const board = mkBoard([ip, vf, rs])
  const h = mkRpcHandlers(board)
  let r = await h['cancel-task']({ taskId: 'ip' })
  assert.equal(r.ok, false); assert.match(r.error, /terminate-agent/); assert.equal(ip.status, 'in-progress')
  r = await h['cancel-task']({ taskId: 'vf' })
  assert.equal(r.ok, false); assert.match(r.error, /terminate-agent/); assert.equal(vf.status, 'verifying')
  r = await h['cancel-task']({ taskId: 'rs' })
  assert.equal(r.ok, false); assert.match(r.error, /归档/); assert.equal(rs.status, 'resolved')
})

test('cancel-task RPC: spawn-pending 边缘回退（清认领位，不留死占位）', async () => {
  const sp = mkTask({ id: 'sp', status: 'in-progress', claimedBy: 'spawn-pending', claimedAt: '2026-01-01T00:00:00Z' })
  const board = mkBoard([sp])
  const h = mkRpcHandlers(board)
  const r = await h['cancel-task']({ taskId: 'sp', reason: 'spawn 在途作废' })
  assert.equal(r.ok, true)
  assert.equal(sp.status, 'cancelled')
  assert.equal(sp.claimedBy, null); assert.equal(sp.claimedAt, null) // 占位回退（与 spawn 失败同口径）
  assert.ok(sp.history.some(function (x) { return x.from === 'in-progress' && x.to === 'cancelled' }))
})

test('task_cancel 工具：与 cancel-task RPC 同一门禁口径（放行/拒绝/幂等）', async () => {
  const t = mkTask({ id: 'x1', status: 'pending' })
  let h = mkRpcHandlers(mkBoard([t]))
  let r = await h.__tools['task_cancel'].execute({ taskId: 'x1', reason: '走工具通道' }, {})
  assert.equal(r.ok, true); assert.equal(t.status, 'cancelled')
  // 幂等：再次取消已取消卡 → alreadyCancelled
  r = await h.__tools['task_cancel'].execute({ taskId: 'x1' }, {})
  assert.equal(r.ok, true); assert.equal(r.alreadyCancelled, true)
  // 执行中拒绝（工具通道同门禁）
  const t2 = mkTask({ id: 'x2', status: 'in-progress', claimedBy: 'run-y' })
  h = mkRpcHandlers(mkBoard([t2]))
  r = await h.__tools['task_cancel'].execute({ taskId: 'x2' }, {})
  assert.equal(r.ok, false); assert.match(r.error, /terminate-agent/)
})

test('restore 清 cancelledAt（task-mv1pqy27）：已取消卡 resetToPending 恢复待办不背取消时间戳（行为级，RPC + 工具双通道）', async () => {
  // RPC 通道（归档 tab「↩ 恢复待办」走 update-task resetToPending）
  const c = mkTask({ id: 'rc1', status: 'cancelled', cancelledAt: '2026-01-01T00:00:00Z' })
  const h = mkRpcHandlers(mkBoard([c]))
  const r = await h['update-task']({ taskId: 'rc1', resetToPending: true })
  assert.equal(r.ok, true); assert.equal(c.status, 'pending')
  assert.equal('cancelledAt' in c, false) // delete 语义：字段消失，不背取消时间戳
  // 工具通道（task_update resetToPending）同口径
  const c2 = mkTask({ id: 'rc2', status: 'cancelled', cancelledAt: '2026-01-01T00:00:00Z' })
  const h2 = mkRpcHandlers(mkBoard([c2]))
  const r2 = await h2.__tools['task_update'].execute({ taskId: 'rc2', resetToPending: true }, {})
  assert.equal(r2.ok, true); assert.equal(c2.status, 'pending')
  assert.equal('cancelledAt' in c2, false)
})

test('terminate 认领位清理与状态无关 + 关 run 结局 terminated（源码级，task-mv1pqy27 死结窗口根修）', () => {
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  // 认领位清理按命中的 run 角色（rec.role）而非卡状态分支（resolved/archived/cancelled 态也清）
  assert.match(rpc, /if \(rec\) \{\s*if \(rec\.role === 'verifier'\) \{ t\.verifierRun = null; delete t\.verifierRunAt \}/)
  assert.match(rpc, /else \{ t\.claimedBy = null; t\.claimedAt = null \}/)
  // 关 run 结局 outcome:'terminated'（与状态无关，凡 terminate 命中该卡的 run 就关账）
  assert.match(rpc, /closeRunHistory\(sid, taskId, String\(rec\.id\), 'terminated'\)/)
  // stale 兜底仍保留：无 rec 的 verifying 卡仍按状态清 verifierRun（rec 不存在时 rec.role 无从判定）
  assert.match(rpc, /else if \(t\.status === 'verifying'\) \{ t\.verifierRun = null; delete t\.verifierRunAt; ah\(t, 'verifying'/)
  // 接线：dispatch 导出 closeRunHistory + index 注入 rpc（未接线则 doTerminate 走 no-op 兜底，关账失效）
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(dsp, /closeRunHistory: closeRunHistory/)
  assert.match(idx, /closeRunHistory: dispatch\.closeRunHistory/)
})

test('task_cancel GUI 按钮门禁：canCancel 三态 + 详情页按钮接线 + confirm 预警 + 产物重组装', () => {
  const ksrc = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
  const tdsrc = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // canCancel 谓词与 canDelete 同三态口径（draft/pending/blocked）
  assert.match(ksrc, /function canCancel\(t\) \{ return !!t && \(t\.status === 'draft' \|\| t\.status === 'pending' \|\| t\.status === 'blocked'\) \}/)
  // confirm 预警 + cancel-task RPC 调用
  assert.ok(ksrc.indexOf('取消后不再派发，可在归档恢复。确认取消') >= 0, 'kernel.js 缺 confirm 预警')
  assert.ok(ksrc.indexOf("rpc('cancel-task'") >= 0, 'kernel.js 缺 cancel-task 调用')
  // 详情页按钮门禁：canCancel(task) 才渲染取消按钮
  assert.ok(tdsrc.indexOf('canCancel(task) ? React.createElement') >= 0, 'task-detail.js 缺 canCancel 门禁')
  assert.ok(tdsrc.indexOf('cancelTask(task.id, task.title, setActionMsg)') >= 0, 'task-detail.js 缺取消按钮接线')
  // 产物重组装：关键接线标记出现在 lib/client.js
  for (const m of ['function canCancel(t)', "rpc('cancel-task'", '取消后不再派发，可在归档恢复', 'canCancel(task) ? React.createElement']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m)
  }
})

// ===== 反馈修复（task-mux3uvx3，反馈 n-muw706h1uymy）：归档路径触发父卡收口 + task_resolve 守卫对齐 =====
test('归档双通道触发父卡自动收口：archive-task RPC 与 task_archive 工具同一 archiveApply 口径', async () => {
  // RPC 通道：归档末子卡 → 父卡 in-progress → verifying
  const p = mkTask({ id: 'ep', status: 'in-progress' })
  const k1 = mkTask({ id: 'k1', parentId: 'ep', status: 'resolved' })
  const k2 = mkTask({ id: 'k2', parentId: 'ep', status: 'resolved' })
  const board = mkBoard([p, k1, k2])
  const h = mkRpcHandlers(board)
  const r = await h['archive-task']({ taskId: 'k2' })
  assert.equal(r.ok, true); assert.equal(r.parentUpdated, true)
  assert.equal(p.status, 'verifying')
  assert.equal(p.resolution, 'all subtasks resolved')
  // 工具通道同口径
  const p2 = mkTask({ id: 'ep2', status: 'in-progress' })
  const j1 = mkTask({ id: 'j1', parentId: 'ep2', status: 'resolved' })
  const j2 = mkTask({ id: 'j2', parentId: 'ep2', status: 'resolved' })
  const h2 = mkRpcHandlers(mkBoard([p2, j1, j2]))
  const r2 = await h2.__tools['task_archive'].execute({ taskId: 'j2' }, {})
  assert.equal(r2.ok, true); assert.equal(r2.parentUpdated, true); assert.equal(p2.status, 'verifying')
  // 未凑齐不收口（还剩在跑子卡）：归档其中一张已 resolved 的，父卡不动
  const p3 = mkTask({ id: 'ep3', status: 'in-progress' })
  const m1 = mkTask({ id: 'm1', parentId: 'ep3', status: 'resolved' })
  const m2 = mkTask({ id: 'm2', parentId: 'ep3', status: 'in-progress' })
  const h3 = mkRpcHandlers(mkBoard([p3, m1, m2]), { hasActiveRun: () => true })
  const r3 = await h3['archive-task']({ taskId: 'm1' })
  assert.equal(r3.ok, true); assert.equal('parentUpdated' in r3, false); assert.equal(p3.status, 'in-progress')
})

test('batch-op archive：整批落定后触发父卡收口（第三条归档路径同口径）；未凑齐不收口', async () => {
  // 末两张子卡一次批量归档 → 父卡 verifying（旧路径归档后从不查父卡 → 同样卡死）
  const p = mkTask({ id: 'bp', status: 'in-progress' })
  const b1 = mkTask({ id: 'b1', parentId: 'bp', status: 'resolved' })
  const b2 = mkTask({ id: 'b2', parentId: 'bp', status: 'resolved' })
  const b3 = mkTask({ id: 'b3', parentId: 'bp', status: 'cancelled' })
  const h = mkRpcHandlers(mkBoard([p, b1, b2, b3]))
  const r = await h['batch-op']({ op: 'archive', ids: ['b1', 'b2', 'b3'] })
  assert.equal(r.ok, true); assert.equal(r.done, 3); assert.equal(r.parentsClosed, 1)
  assert.equal(p.status, 'verifying')
  // 未凑齐（还有在跑子卡）→ 不收口、不挂 parentsClosed 字段（返回体老契约不变）
  const p2 = mkTask({ id: 'bp2', status: 'in-progress' })
  const d1 = mkTask({ id: 'd1', parentId: 'bp2', status: 'resolved' })
  const d2 = mkTask({ id: 'd2', parentId: 'bp2', status: 'in-progress' })
  const h2 = mkRpcHandlers(mkBoard([p2, d1, d2]))
  const r2 = await h2['batch-op']({ op: 'archive', ids: ['d1'] })
  assert.equal(r2.ok, true); assert.equal('parentsClosed' in r2, false); assert.equal(p2.status, 'in-progress')
  // 不级联：批量只动显式选中的 id（与单卡 archiveApply 的级联刻意不同）
  assert.equal(d2.status, 'in-progress')
})

test('task_resolve 工具：claimedBy=null 的 in-progress 卡放行主窗口（对齐 RPC 口径）；他人认领照旧拒', async () => {
  // claimedBy=null（parentKick 僵尸 epic / 手动置 in-progress 的无人认领卡）→ 放行（工具已有主窗口门禁）
  const t1 = mkTask({ id: 'u1', status: 'in-progress', claimedBy: null })
  const r1 = await mkRpcHandlers(mkBoard([t1])).__tools['task_resolve'].execute({ taskId: 'u1', status: 'blocked' }, {})
  assert.equal(r1.ok, true); assert.equal(t1.status, 'blocked')
  // verifying + resolution 同样放行（父卡检查仍由 resolveApply 内部触发，行为不变）
  const t2 = mkTask({ id: 'u2', status: 'in-progress', claimedBy: null, pipeline: 'full' })
  const r2 = await mkRpcHandlers(mkBoard([t2])).__tools['task_resolve'].execute({ taskId: 'u2', status: 'verifying', resolution: '手动兜底' }, {})
  assert.equal(r2.ok, true); assert.equal(t2.status, 'verifying')
  // 他人认领 → 照旧拒（既有守卫场景不回归）
  const t3 = mkTask({ id: 'u3', status: 'in-progress', claimedBy: 'other' })
  const r3 = await mkRpcHandlers(mkBoard([t3])).__tools['task_resolve'].execute({ taskId: 'u3', status: 'verifying', resolution: 'x' }, {})
  assert.equal(r3.ok, false); assert.match(r3.error, /not claimed by you/); assert.equal(t3.status, 'in-progress')
  // 本人认领 → 放行
  const t4 = mkTask({ id: 'u4', status: 'in-progress', claimedBy: 'tester', pipeline: 'full' })
  const r4 = await mkRpcHandlers(mkBoard([t4])).__tools['task_resolve'].execute({ taskId: 'u4', status: 'verifying', resolution: 'x' }, {})
  assert.equal(r4.ok, true); assert.equal(t4.status, 'verifying')
})

test('反馈修复接线断言：index.mjs 注入 hasActiveRun + get-tasks 附 tasksHash + kernel 短路分支（源码级）', () => {
  const host = hostSrc()
  // index.mjs：hasActiveRun 定义（runsFor 表有记录且 !settled 即活跃）并注入 createRpc deps
  assert.match(host, /function hasActiveRun\(sid, taskId\) \{ var rec = session\.runsFor\(sid\)\[taskId\]; return !!\(rec && !rec\.settled\) \}/)
  assert.match(host, /hasActiveRun: hasActiveRun,/)
  // rpc.mjs：get-tasks 响应附 tasksHash（现算不落盘）；archiveErr 门禁 = 定义1 + RPC1 + 工具1
  assert.match(host, /d\.tasksHash = tasksHash\(d\.tasks\)/)
  const rpcSrc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  assert.equal((rpcSrc.match(/archiveErr\(sid, t\)/g) || []).length, 3)
  // kernel：hash 短路分支存在（hash 相同跳过 tasks 赋值 + notify；老 host 无 hash 恒视为变化）
  const ksrc = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
  assert.match(ksrc, /var newHash = \(d && d\.tasksHash\) \|\| ''/)
  assert.match(ksrc, /var tasksChanged = !newHash \|\| newHash !== state\.tasksHash/)
  assert.match(ksrc, /if \(tasksChanged\) \{[\s\S]*?notify\(\)/)
})

// ===== 无障碍两件套（task-mutrubay，反馈 n-mut9rzpyc7p1）：卡片键盘可达 + 详情页「流转到」按钮组（源码级断言）=====
test('无障碍接线：卡片 role/tabIndex/aria-label/onKeyDown/焦点框 + 详情页流转按钮组（源码级）', () => {
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // ① 卡片键盘可达：button 角色 + Tab 序 + 读屏标签（标题+状态）+ Enter/Space 与点击共用同一激活函数 + 主题色焦点框
  assert.match(cli, /role: 'button', tabIndex: 0, 'aria-label': t\.title \+ '（' \+ \(statusLabels\[t\.status\] \|\| t\.status\) \+ '）'/)
  assert.match(cli, /onKeyDown: function \(e\) \{ if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{ e\.preventDefault\(\); activate\(\) \} \}/)
  assert.match(cli, /onClick: activate,/) // 点击与键盘同一条激活路径（多选=切换选中，否则开详情）
  assert.match(cli, /outline: isCardFocus\(t\.id\) \? '2px solid ' \+ C\.brand : 'none'/) // 主题色焦点框（非浏览器默认蓝框）
  assert.match(cli, /function isCardFocus\(id\)/) // 焦点态走 state 现算（轮询重渲染不丢焦点框）
  // ② 详情页「流转到」按钮组：合法迁移表 + 组容器（读屏可报组名）+ 四状态按钮文案
  assert.match(cli, /var FLOW_DEF = \{/)
  assert.match(cli, /role: 'group', 'aria-label': '状态流转'/)
  assert.match(cli, /'⇄ 流转到：'/)
  assert.match(cli, /'▶ 开始处理'/); assert.match(cli, /'✅ 提交验收'/); assert.match(cli, /'⛔ 标记阻塞'/)
  assert.match(cli, /'↩ 重投待办'/); assert.match(cli, /'✔ 验收通过'/); assert.match(cli, /'↩ 驳回重投'/)
  // 迁移通道与拖拽 transition() 同 RPC 族（host 门禁不变）；失败原因 ⚠️ 回显 actionMsg 行
  assert.match(cli, /function flowTo\(to\)/)
  assert.match(cli, /p = rpc\('claim-task', \{ taskId: task\.id \}\)/)
  assert.match(cli, /p = rpc\('update-task', \{ taskId: task\.id, resetToPending: true \}\)/)
  assert.match(cli, /p = rpc\('resolve-task', \{ taskId: task\.id, status: 'verifying', resolution: res \}\)/)
  assert.match(cli, /p = rpc\('verify-task', \{ taskId: task\.id, verdict: 'approved' \}\)/)
  assert.match(cli, /setActionMsg\('⚠️ 流转失败：' \+ \(r\.error \|\| '未知错误'\)\)/)
})

// ===== no-root 刷屏根治（task-muuf0o7a）：poolCycle root 闸门 + 短 id 幻影板防线 =====
// 事故链：幻影板 tasks-cc24eb5c.json（裸短 id 建出）滞留 pending 卡 → poolCycle 每 15s
// pickDispatch 成功→占位 claim→spawnOneShot 才发现无活 root→console.error→占位超时回收
// →下轮再来，永久 spam。根治 = ①poolCycle 入口 root 闸门（无 root 不派发不写盘零日志）
// + ②touchSession/create-task 拒绝不完整短 id（import- 前缀放行）。

test('isFullSessionId：裸短 id/空值/unknown 拒绝；完整 root id 与 import- 前缀放行', () => {
  assert.equal(isFullSessionId('cc24eb5c'), false)           // 裸短 id（本次幻影板元凶）
  assert.equal(isFullSessionId(''), false)
  assert.equal(isFullSessionId(null), false)
  assert.equal(isFullSessionId(undefined), false)
  assert.equal(isFullSessionId('unknown'), false)
  assert.equal(isFullSessionId('abcdefghij-k'), false)       // 长度 <20
  assert.equal(isFullSessionId('abcdefghijklmno-pqrst'), false) // ≥20 但只有一个 '-'
  assert.equal(isFullSessionId('-abcdefghij-klmnopqr'), false)  // 首字符即 '-' 不算结构
  assert.equal(isFullSessionId('session-cc24eb5c-702c-4f7d-a1b2c3d4e5f6'), true)
  assert.equal(isFullSessionId('import-sess_df0837fa-1'), true) // import- 前缀板合法放行
})

test('touchSession：不完整短 id 不注册进已知会话集合（幻影板不进心跳轮询）', () => {
  const known = {}
  const session = createSession({}, { knownSessions: known, feedbackCache: {}, activeRuns: {}, dispatchedEver: {} })
  session.touchSession('cc24eb5c')     // 裸短 id → 拒绝
  session.touchSession('unknown')      // 既有排除项不变
  session.touchSession(null)
  session.touchSession('session-cc24eb5c-702c-4f7d-a1b2c3d4e5f6') // 完整 id → 注册
  session.touchSession('import-sess_df0837fa-1')                  // import- 前缀 → 放行
  assert.deepEqual(Object.keys(known).sort(), ['import-sess_df0837fa-1', 'session-cc24eb5c-702c-4f7d-a1b2c3d4e5f6'].sort())
})

// poolCycle 直调 harness：ctx 不给 timer（15s 心跳 IIFE 跳过），deps 全 mock，计数读/写/日志
// ctxOver（第三参，可选）：覆盖 ctx 面（如注入 subagents 让真 spawnOneShot 跑起来——回执开关行为测试用）
function mkDispatch(board, over, ctxOver) {
  const counters = { reads: 0, writes: 0, errs: [] }
  const dispatch = createDispatch(
    // 创建期无条件触达：effect（卸载清理注册）/ get('systemPrompt' 引导段)；不给 timer/agents/subagents
    Object.assign({ fs: {}, effect: function () {}, get: function () { return null } }, ctxOver || {}),
    { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} },
    Object.assign({
      rt: async () => { counters.reads++; return board },
      wt: async () => { counters.writes++ },
      mutateLocked: async (sid, fn) => { counters.writes++; return fn(board) },
      kickCycle: () => {},
      rootForSession: () => undefined, // 默认无活 root（幻影板/死会话场景）
      sessionCwd: () => '', withTimeout: (p) => p, runsFor: () => ({}), feedbackOn: () => true,
      pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
    }, over || {}))
  return { dispatch, counters }
}

test('poolCycle root 闸门：无活 root → 直接返回 undefined，不读盘/不写盘/零日志（根治 15s 刷屏）', async () => {
  const { dispatch, counters } = mkDispatch(mkBoard([mkTask()])) // 板上有 pending 卡也不进循环
  const origErr = console.error
  console.error = function () { counters.errs.push(Array.prototype.join.call(arguments, ' ')) }
  try {
    const r = await dispatch.poolCycle('cc24eb5c')
    assert.equal(r, undefined) // 调用方（kickCycle/15s 心跳）忽略返回值，签名兼容
    assert.equal(counters.reads, 0)  // rt 都没跑：零读盘
    assert.equal(counters.writes, 0) // 零写盘
    assert.deepEqual(counters.errs, []) // 零日志
  } finally { console.error = origErr }
})

test('poolCycle root 闸门：有活 root → 正常进循环（空板走空闲快进返回 snap，不写盘）', async () => {
  const board = mkBoard([])
  const { dispatch, counters } = mkDispatch(board, { rootForSession: () => ({ id: FULL_SID }) })
  const r = await dispatch.poolCycle(FULL_SID)
  assert.ok(r && Array.isArray(r.tasks)) // 空闲快进返回 snap（闸门未误伤正常路径）
  assert.equal(counters.reads, 1)
  assert.equal(counters.writes, 0) // 空板无残留 poolStatus/dispatchInfo → 快进不写盘
})

test('create-task RPC：不完整短 id sessionId → 报错不建板；import- 前缀与正常路径放行', async () => {
  // rpcSessionId 覆写为「尊重显式 sessionId 入参」（生产行为：args.sessionId 优先于 actor 归一）
  const honorSid = { rpcSessionId: (args) => (args && args.sessionId) || FULL_SID }
  // ① 裸短 id → 拒绝且不落任务（防幻影板）
  const board = mkBoard([])
  const r = await mkRpcHandlers(board, honorSid)['create-task']({ title: 'T', description: 'd', sessionId: 'cc24eb5c' })
  assert.equal(r.ok, false)
  assert.match(r.error, /sessionId 不完整/)
  assert.equal(board.tasks.length, 0)
  // ② import- 前缀板 → 放行（导入会话是合法板，别误伤）
  const board2 = mkBoard([])
  const r2 = await mkRpcHandlers(board2, honorSid)['create-task']({ title: 'T', description: 'd', sessionId: 'import-sess_df0837fa-1' })
  assert.equal(r2.ok, true)
  assert.equal(board2.tasks.length, 1)
  // ③ 不传 sessionId（正常路径，归一为完整 root id）→ 放行，返回体形态不变
  const board3 = mkBoard([])
  const r3 = await mkRpcHandlers(board3, honorSid)['create-task']({ title: 'T', description: 'd' })
  assert.equal(r3.ok, true)
  assert.equal(board3.tasks.length, 1)
})

test('no-root 刷屏根治接线断言（源码级）：闸门/防线/兜底注释均在位', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const ses = readFileSync(new URL('../lib/session.mjs', import.meta.url), 'utf8')
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  // ① poolCycle 入口即 root 闸门（闸门必须在 rt 读盘之前——不读盘才谈得上零 IO）
  assert.match(dsp, /async function poolCycle\(sid\) \{[\s\S]{0,900}if \(!rootForSession\(sid\)\) return undefined[\s\S]{0,200}var snap = await rt\(sid\)/)
  // spawnOneShot 的 console.error 兜底保留 + 注释说明闸门在上游
  assert.match(dsp, /console\.error\('\[task-board\] no root agent for session ' \+ sid \+ ', skip spawn'\)/)
  assert.match(dsp, /poolCycle 入口已有 root 存活早闸门/)
  // ② touchSession 注册口接入 isFullSessionId；纯函数出口 + rpc.mjs 直引
  assert.match(ses, /export function isFullSessionId\(sid\)/)
  assert.match(ses, /sid !== 'unknown' && isFullSessionId\(sid\)\) knownSessions\[sid\]/)
  assert.match(rpc, /import \{ isFullSessionId \} from '\.\/session\.mjs'/)
  // create-task handler 校验在 mutateLocked 之前（拒绝时不建板）
  // 窗口放宽到 700：幻影板防线与 return mutateLocked 之间新增了 hooks 角色门禁（本批 hooks=agent run；
  // hooks 是高权限入口，只许主窗口设置），防线本身仍紧随 handler 开头
  assert.match(rpc, /handle\('create-task', async function \(args\) \{ var sid = rpcSessionId\(args\);[\s\S]{0,700}if \(!isFullSessionId\(sid\)\) return \{ ok: false, error: 'sessionId 不完整[\s\S]{0,300}return mutateLocked/)
})

// ===== isRoot 蝶变防抖（task-muupr8ld，反馈 n-muuerxv9ijxs）=====
// 根因：host get-tasks 现算 isRoot（agents.roots() 含本 sid），生成开始/结束瞬间 agents 树重建有瞬态窗口
// 返回假 false；旧口径一次 false 就强收抽屉（state.open=false）→「看板在生成状态切换时突然消失」。
// 修法：客户端防抖——曾确认 true 的会话需连续 3 次 false 才收；从未 true 的子代理会话即时收起；
// 三处消费点（强收/按钮/面板）+ 活动心跳省流统一读 isRootStable；会话切换重置防抖态。
test('isRoot 蝶变防抖（源码级）：计数器 + 连续 3 次阈值 + everTrue 门锁 + 新会话即时收紧', () => {
  const ksrc = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // ① 防抖态三字段入 state（everTrue/连续 false 计数/稳定值）
  assert.match(ksrc, /isRoot: true, isRootEverTrue: false, isRootFalseN: 0, isRootStable: true/)
  // ② 阈值常量 = 3（host 3s 心跳 ≈ 9s），注释写明为什么防抖/为什么子代理不防抖
  assert.match(ksrc, /var IS_ROOT_FALSE_LIMIT = 3/)
  assert.match(ksrc, /为什么防抖：host rpc\.mjs L97 的 isRoot 是每次 get-tasks 现算的/)
  assert.match(ksrc, /为什么子代理会话不防抖：everTrue=false 的会话（新打开的子代理）立即 isRootStable=false/)
  // ③ 防抖器本体：true → 清零+everTrue+stable；从未 true → 即时 false（门锁）；everTrue 则累计到阈值才翻
  assert.match(ksrc, /function applyIsRoot\(rawIsRoot\) \{/)
  assert.match(ksrc, /if \(rawIsRoot\) \{[\s\S]{0,400}state\.isRootEverTrue = true/)
  assert.match(ksrc, /state\.isRootFalseN = 0[\s\S]{0,80}state\.isRootStable = true/)
  assert.match(ksrc, /else if \(!state\.isRootEverTrue\) \{[\s\S]{0,120}state\.isRootStable = false/)
  assert.match(ksrc, /state\.isRootFalseN\+\+[\s\S]{0,200}if \(state\.isRootFalseN >= IS_ROOT_FALSE_LIMIT\) state\.isRootStable = false/)
  // ④ 轮询只把原始值喂给防抖器（不再直写 state.isRoot）
  assert.match(ksrc, /applyIsRoot\(!d \|\| d\.isRoot !== false\)/)
  assert.doesNotMatch(ksrc, /state\.isRoot = !d \|\| d\.isRoot !== false/)
  // ⑤ 三处消费点 + 活动心跳省流统一读 isRootStable（不得再读单次 isRoot 原始值）
  assert.match(ksrc, /if \(!state\.isRootStable && state\.open\) \{ state\.open = false; state\.detailId = null \}/) // L303 强收
  assert.match(ksrc, /if \(!state\.sessionId \|\| !state\.isRootStable \|\| !state\.open\) return/)                        // 省流轮询
  assert.match(ksrc, /setIsOpen\(state\.open\); setIsRoot\(state\.isRootStable\)/)                                        // 按钮
  assert.match(ksrc, /if \(!isRoot\) return null \/\/ 子代理会话不显示看板入口（读 isRootStable/)
  assert.match(ksrc, /if \(!state\.isRootStable\) return null \/\/ 子代理会话不渲染看板面板（读 isRootStable/)
  assert.doesNotMatch(ksrc, /state\.isRoot === false/) // 旧口径已根除（消费点不再看单次值）
  // ⑥ 会话切换重置防抖态（旧会话的"曾确认 true"不得漂到新会话）
  assert.match(ksrc, /state\.isRootEverTrue = false; state\.isRootFalseN = 0; state\.isRootStable = false; notify\(\); fetchTasks\(\); fetchChildren\(\)/)
  // ⑦ 产物体重组装：断言在源码与 lib/client.js 产物上同口径
  assert.match(cli, /var IS_ROOT_FALSE_LIMIT = 3/)
  assert.match(cli, /isRootEverTrue: false, isRootFalseN: 0, isRootStable: true/)
  assert.equal((cli.match(/applyIsRoot\(/g) || []).length, 2) // 定义 1 + 轮询调用 1
})

test('isRoot 持久语义：host 侧改读 parentSession（根=无父），防抖仍指回客户端', () => {
  const rpcSrc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  // isRoot 持久判定入口：根会话=无父，不再读活跃 roots() 集
  assert.match(rpcSrc, /async function isRootPersistent\(sid\)/)
  assert.match(rpcSrc, /snap\.header\) return !snap\.header\.parentSession/)
  assert.match(rpcSrc, /d\.isRoot = await isRootPersistent\(sid\)/)
  // 指针注释：防抖仍在客户端 kernel.js applyIsRoot，曾确认 true 需连续 3 次 false 才收
  assert.match(rpcSrc, /防抖仍在客户端：kernel\.js applyIsRoot/)
  assert.match(rpcSrc, /曾确认 true 的会话需连续 3 次/)
})

// ===== 史诗 hooks UI（task-muuw56yf）：卡片相位徽章 + 详情页 hooks 编辑区 =====
// 依赖卡 task-muuw4ov7 落地的真实字段契约（本文件上方 hooks 测试段即其口径）：
//   epic.hooks = { pre: { enabled, prompt, state, runId, pending? }, post: 同构 }；state ∈ idle|running|done|failed；
//   hook run 记在 epic.runs[]（role 'hook-pre'/'hook-post'，{ role, id, at, endedAt, outcome, model }）；
//   update-task RPC 的 hooks 字段浅合并，normalizeHooks 对缺省 state 归零成 idle（故 UI 必须透传 state/runId）；
//   hooks 只许主窗口设置（UI 不做权限预判，失败原因原样回显）。
test('hooks 卡片相位徽章（源码级）：三态文案 + err 色 + 无 hooks 零渲染', () => {
  const card = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  // 相位判定唯一出处：hookBadgeOf（读 t.hooks，未声明直接 null = 老卡零渲染）
  assert.match(card, /function hookBadgeOf\(t\) \{/)
  assert.match(card, /var h = t && t\.hooks\n      if \(!h\) return null/)
  // 三个相位文案 + 徽章优先级：failed（pre|post）> pre running > post running > 不渲染
  assert.match(card, /'⚠️ hook 失败待裁决'/)
  assert.match(card, /'⏳ 前置准备中'/)
  assert.match(card, /'🧪 收尾中'/)
  assert.match(card, /if \(\(pre && pre\.state === 'failed'\) \|\| \(post && post\.state === 'failed'\)\) \{/)
  assert.match(card, /if \(pre && pre\.state === 'running'\) return \{ txt: '⏳ 前置准备中'/)
  assert.match(card, /if \(post && post\.state === 'running'\) return \{ txt: '🧪 收尾中'/)
  assert.match(card, /return null\n    \}/) // 末尾兜底：idle / done 不占位
  // 只有「已声明且 enabled」的点位参与相位判定（停用的点位不该报 running/failed）
  assert.match(card, /var pre = \(h\.pre && h\.pre\.enabled\) \? h\.pre : null/)
  assert.match(card, /var post = \(h\.post && h\.post\.enabled\) \? h\.post : null/)
  // 失败徽章走 err 色（与既有 escalation 视觉同源）
  assert.match(card, /return \{ txt: '⚠️ hook 失败待裁决', color: C\.err,/)
  // 挂载点：与「📦 史诗 · x/y」并存（史诗卡限定，相位是附加过程态而非替代进度）
  assert.match(card, /epic \? hookPhaseBadge\(t\) : null,/)
  assert.match(card, /'📦 史诗 · ' \+ csDone \+ '\/' \+ cs\.total/)
  // 组装产物里也要有（require build-client 先跑；npm pretest 已保证）
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const s of ['⏳ 前置准备中', '🧪 收尾中', '⚠️ hook 失败待裁决']) assert.ok(built.includes(s), '产物应含相位文案：' + s)
})

test('hooks 详情页编辑区（源码级）：开关 + prompt + state/耗时 + 失败跳裁决 + run 跳会话 + 保存通道', () => {
  const src = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  // ① 挂载与门禁：史诗（有子任务）或已声明 hooks 才渲染，普通老卡整块不出现
  assert.match(src, /function HooksSection\(props\) \{/)
  assert.match(src, /var kids = state\.tasks\.filter\(function \(x\) \{ return x\.parentId === task\.id \}\)/)
  assert.match(src, /var declared = !!\(kHooks && \(kHooks\.pre \|\| kHooks\.post\)\)/)
  assert.match(src, /if \(kids\.length === 0 && !declared\) return null/)
  // key=task.id 挂载：切换任务重挂组件，编辑缓冲不串卡
  assert.match(src, /React\.createElement\(HooksSection, \{ key: task\.id, task: task \}\)/)
  // ② 两行同构：enabled 开关（原生 checkbox）+ prompt 文本框（薄框架语义写进 placeholder）
  assert.match(src, /phaseRow\('pre', '⏳ 前置（pre）'/)
  assert.match(src, /phaseRow\('post', '🧪 收尾（post）'/)
  assert.match(src, /type: 'checkbox', checked: !!b\.enabled, onChange: function \(e\) \{ setPhase\(ph, \{ enabled: e\.target\.checked \}\) \}/)
  assert.match(src, /placeholder: '补充指令（可选）——前置=让子任务具备开跑条件；后置=把这批活收口。具体动作由 hook agent 自行决策'/)
  // ③ state 展示四态 + 未启用 + 耗时（运行中=已跑、落定=净耗时）
  assert.match(src, /\{ idle: \{ label: off \? '未启用' : '待运行', color: C\.text2 \}, running: \{ label: '运行中', color: C\.brand \}, done: \{ label: '已完成', color: C\.ok \}, failed: \{ label: '失败', color: C\.err \} \}/)
  assert.match(src, /if \(st === 'running'\) dur = '已跑 ' \+ elapsedSince\(run\.at\)/)
  assert.match(src, /else if \(run\.endedAt\) dur = '耗时 ' \+ fmtDur\(/)
  // ④ 失败 → 「前往裁决」：同页锚点跳转（裁决区 id 固定，DetailView 已挂 id）
  assert.match(src, /m\.state === 'failed' \? React\.createElement\('button', \{ onClick: goArbitration/)
  assert.match(src, /'前往裁决'/)
  assert.match(src, /function goArbitration\(\) \{ var el = document\.getElementById\('tskb-escalation'\); if \(el && el\.scrollIntoView\) el\.scrollIntoView\(\{ block: 'center' \}\) \}/)
  assert.match(src, /React\.createElement\('div', \{ id: 'tskb-escalation'/)
  // ⑤ run 跳会话（照 verifierRun 跳转既有模式）+ post 的 run id 落在 verifierRun 位
  assert.match(src, /onClick: function \(\) \{ if \(uiWorkspaceSvc\) uiWorkspaceSvc\.openSession\(m\.run\.id\) \}/)
  assert.match(src, /var rid = runId \|\| \(phase === 'post' \? task\.verifierRun : null\)/)
  assert.match(src, /var role = 'hook-' \+ phase/)
  // ⑥ 保存通道：update-task RPC 的 hooks 字段（UI 不做权限判断，失败原因原样 ⚠️ 回显）
  assert.match(src, /rpc\('update-task', \{ taskId: task\.id, hooks: \{ pre: pre\.item, post: post\.item \} \}\)/)
  assert.match(src, /if \(r && r\.ok === false\) \{ setMsg\('⚠️ ' \+ \(r\.error \|\| '保存失败'\)\); return \}/)
  // ⓪ 防再发（2026-10-05 详情页崩板事故）：组件首行必须完成 React hook 解构——bundler 只注入 React 本体，
  //    裸用 useState = 运行期 ReferenceError → shell 容错层卸载整个 shell.overlay（看板整体消失）
  assert.match(src, /function HooksSection\(props\) \{\s+var _R = React; var useState = _R\.useState/)
  // ⑦ 提交体三条口径：空 prompt=撤点位（null）；state/runId/pending 原样透传（否则在跑的 hook 会被打回 idle）；
  //    运行中的点位不清空（run 还在飞，撤声明会让结算落到空点位）——删除意图保留 + 回一行提示
  assert.match(src, /if \(!String\(b\.prompt \|\| ''\)\.trim\(\)\) \{/)
  assert.match(src, /if \(cur && cur\.state === 'running'\) return \{ item: keep\(cur\), warn: ph \+ ' 运行中：本次不清空该点位（run 还在跑），等它跑完再撤' \}/)
  assert.match(src, /return \{ item: null \}/)
  assert.match(src, /if \(cur\.state\) item\.state = cur\.state/)
  assert.match(src, /if \(cur\.runId\) item\.runId = cur\.runId/)
  assert.match(src, /if \(cur\.pending\) item\.pending = true/)
  assert.match(src, /setMsg\(warns\.length \? '⚠️ ' \+ warns\.join\('；'\) : '✅ 已保存 hooks 配置'\)/)
  // 组装产物里也要有
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const s of ['Hooks（可选点位）', '前往裁决', '保存 hooks']) assert.ok(built.includes(s), '产物应含：' + s)
})

test('README 双份同步记录 hooks UI 口径（相位徽章 / 详情编辑区 / 自行决策 + 歧义兜底）', () => {
  const pkg = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.equal(pkg, root) // 两份 README 必须字节一致（npm run sync-readme 的约束）
  for (const s of ['可选 hooks', '串行闸门', '自行决策', '歧义上报', '⏳ 前置准备中', '🧪 收尾中', '⚠️ hook 失败待裁决', 'hooks 仅主窗口可设']) {
    assert.ok(pkg.includes(s), 'README 应记录 hooks UI 口径：' + s)
  }
})

// ===== 史诗拆分总开关（epicSplit，板级；口径：只关「引导」不禁「机制」）=====
// false 时两个生效点：① Team 提示词第 6 条 TEAM_SPLIT_RULE 整条不注入（policy.splitRuleOf）
// ② create-task RPC / task_create 工具返回体不再附 suggestSplit（policy.withSplitHint 第三参）。
// 机制面（显式 parentId 建子卡 / 史诗自动收口 / hooks 状态机）一律不看这个开关。
test('cfg/seed/normalizeBoard: epicSplit 缺省开（缺字段/脏值都算开），只有显式 false 才关', () => {
  assert.equal(core.cfg({}).epicSplit, true)
  assert.equal(core.cfg({ epicSplit: true }).epicSplit, true)
  assert.equal(core.cfg({ epicSplit: false }).epicSplit, false)
  assert.equal(core.cfg({ epicSplit: 'no' }).epicSplit, true) // 脏值不关（默认开）
  assert.equal(core.cfg({ epicSplit: 0 }).epicSplit, true)
  assert.equal(core.seed('s1').epicSplit, true)
  assert.equal(core.normalizeBoard({ tasks: [] }).epicSplit, true)                        // 老看板无字段 → 默认开（行为零变化）
  assert.equal(core.normalizeBoard({ tasks: [], epicSplit: false }).epicSplit, false)      // 显式 false 原样保留
  assert.equal(core.normalizeBoard({ tasks: [], epicSplit: 'x' }).epicSplit, true)         // 脏值收敛成默认开
})

test('splitRuleOf: 第 6 条注入出口——缺省/true 与开关落地前逐字相同，显式 false 整条不出现', () => {
  assert.equal(splitRuleOf(undefined), '\n' + TEAM_SPLIT_RULE) // 老调用方/缺省 → 零变化
  assert.equal(splitRuleOf(true), '\n' + TEAM_SPLIT_RULE)
  assert.equal(splitRuleOf(false), '')
  assert.doesNotMatch(splitRuleOf(false), /大任务必须拆分|parentId|checkParentAuto/)
  // 拼接形态：第 5 条末尾直接接出口——关掉时编号 1~5 连续、不留空行尾巴
  assert.ok(('5. 尾部。' + splitRuleOf(true)).endsWith('\n' + TEAM_SPLIT_RULE))
  assert.equal('5. 尾部。' + splitRuleOf(false), '5. 尾部。')
})

test('epicSplit 行为①：Team 提示词第 6 条随门禁注入/消失（真跑一次 section 组装，不是源码断言）', () => {
  const SID = FULL_SID
  const sections = []
  const ctx = {
    fs: {},
    effect: function () { return function () {} },
    get: function (name) {
      if (name !== 'systemPrompt') return null
      return { section: function (cfg) { sections.push(cfg); return function () {} }, context: function () { return function () {} } }
    },
  }
  // 只给 createDispatch 创建期真正用到的 deps 面；epicSplitOn 就是要验的门禁读取器
  const mkDeps = (on) => ({
    rt: async () => mkBoard([]), wt: async () => {}, mutateLocked: async (sid, fn) => fn(mkBoard([])), kickCycle: () => {},
    rootForSession: () => undefined, sessionCwd: () => '', withTimeout: (p) => p, runsFor: () => ({}),
    feedbackOn: () => false, epicSplitOn: () => on,
    pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
  })
  const mkState = () => { const s = { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} }; s.teamModeCache[SID] = true; return s }
  const textOf = (on) => {
    sections.length = 0
    createDispatch(ctx, mkState(), mkDeps(on))
    const sec = sections.find((s) => s.name === 'task-board:team-mode')
    assert.ok(sec, 'team-mode 引导段已注册')
    return sec.text({ agent: { id: SID } })
  }
  const on = textOf(true)
  assert.ok(on.includes(TEAM_SPLIT_RULE)); assert.match(on, /大任务必须拆分/); assert.match(on, /checkParentAuto/)
  const off = textOf(false)
  // 条款整条消失（连 parentId/checkParentAuto 都不再出现），基础 1~5 条引导一字不少
  assert.doesNotMatch(off, /大任务必须拆分|parentId=父卡 id|checkParentAuto|epic 父卡/)
  assert.match(off, /Team 模式已开启/); assert.match(off, /5\. Team 模式下 task_create 默认建为草稿/)
  assert.equal(on.replace(splitRuleOf(true), ''), off.replace(splitRuleOf(false), '')) // 除第 6 条外逐字相同
})

test('withSplitHint: epicSplit=false 不附 suggestSplit（与未命中同形），缺省/true 零变化', () => {
  const big = mkTask({ title: '全量重写派发引擎' })
  const off = withSplitHint({ ok: true, task: {} }, big, false)
  assert.equal(off.suggestSplit, undefined)
  assert.deepEqual(Object.keys(off), ['ok', 'task']) // 返回体形态与「未命中」逐字同形
  assert.equal(withSplitHint({ ok: true, task: {} }, big, true).suggestSplit, SUGGEST_SPLIT_TEXT)
  assert.equal(withSplitHint({ ok: true, task: {} }, big).suggestSplit, SUGGEST_SPLIT_TEXT)          // 两参老调用零变化
  assert.equal(withSplitHint({ ok: true, task: {} }, big, undefined).suggestSplit, SUGGEST_SPLIT_TEXT) // 缺省=开
})

test('buildWorkerPrompt: Worker prompt 不含拆分条款（引导只在主窗口侧两处动态面，审计锁定）', () => {
  const t = mkTask({ title: '把整个引擎系统级重写', description: 'x'.repeat(600) })
  const p = core.buildWorkerPrompt(t, '', true)
  for (const s of ['建议粒度', '拆分', 'parentId', 'epic 卡', 'TASK_SIZE_CONTRACT', 'TEAM_SPLIT_RULE']) {
    assert.ok(!p.includes(s), 'Worker prompt 不该出现拆分引导：' + s)
  }
  // 源码级：buildWorkerPrompt 体内不引用拆分文案、也不引用门禁出口——Worker 侧没有可跳过的条款，
  // 所以 epicSplit 对 Worker prompt 是零影响（将来若往这里加拆分条款，必须同步接 epicSplit 门禁）
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  const body = coreSrc.slice(coreSrc.indexOf('export function buildWorkerPrompt'), coreSrc.indexOf('export function buildVerifierPrompt'))
  assert.ok(body.length > 500, 'buildWorkerPrompt 切片成功')
  assert.doesNotMatch(body, /TASK_SIZE_CONTRACT|TEAM_SPLIT_RULE|splitRuleOf|建议粒度/)
})

test('epicSplit 透出：get-tasks 返回确定布尔值（缺省 true / 显式 false），set-board-config 白名单落盘', async () => {
  const board = mkBoard([])
  const h = mkRpcHandlers(board)
  assert.equal((await h['get-tasks']({})).epicSplit, true) // 老看板缺字段 → true（零变化）
  await h['set-board-config']({ key: 'epicSplit', value: false })
  assert.equal(board.epicSplit, false)
  assert.equal((await h['get-tasks']({})).epicSplit, false)
  await h['set-board-config']({ key: 'epicSplit', value: true })
  assert.equal((await h['get-tasks']({})).epicSplit, true)
})

test('workerContinuable 透出：get-tasks 返回确定布尔值（缺省 true / 显式 false），set-board-config 白名单落盘', async () => {
  const board = mkBoard([])
  const h = mkRpcHandlers(board)
  assert.equal((await h['get-tasks']({})).workerContinuable, true) // 老看板缺字段 → true（新行为即默认）
  assert.equal((await h['set-board-config']({ key: 'workerContinuable', value: false })).ok, true)
  assert.equal(board.workerContinuable, false)
  assert.equal((await h['get-tasks']({})).workerContinuable, false) // 回退开关可读可写（客户端按需渲染开关）
  await h['set-board-config']({ key: 'workerContinuable', value: true })
  assert.equal((await h['get-tasks']({})).workerContinuable, true)
  // 脏值口径：非布尔落盘值在读路径被 cfg 归一为 true（与 notifyDispatch 同款）
  board.workerContinuable = 'no'
  assert.equal((await h['get-tasks']({})).workerContinuable, true)
})

test('epicSplit 行为：关掉后 create-task 不附 suggestSplit，但显式 parentId 建子卡 + 史诗自动收口照常（机制不禁）', async () => {
  const board = mkBoard([])
  const h = mkRpcHandlers(board)
  const big = { title: '全量重构整个派发引擎', description: '把整个看板的派发与结算链路系统级重写一遍，覆盖全部管线与状态机' }
  const on = await h['create-task'](Object.assign({ id: 'epic-on' }, big))
  assert.equal(on.ok, true); assert.equal(on.suggestSplit, SUGGEST_SPLIT_TEXT) // 缺省开：引导照旧
  assert.equal((await h['set-board-config']({ key: 'epicSplit', value: false })).ok, true)
  const r1 = await h['create-task'](Object.assign({ id: 'epic-off' }, big))
  assert.equal(r1.ok, true); assert.equal('suggestSplit' in r1, false) // 引导关掉：不再劝拆
  // 机制不禁①：显式 parentId 建子卡照常
  const child = await h['create-task']({ id: 'kid-1', title: '拆出来的一小块', description: '明确描述', parentId: 'epic-off' })
  assert.equal(child.ok, true); assert.equal(child.task.parentId, 'epic-off')
  // 机制不禁②：子任务全部了结 → 父卡照常自动转 verifying（checkParentAuto 不看开关）
  const ep = board.tasks.find((x) => x.id === 'epic-off'); ep.status = 'in-progress'
  const kid = board.tasks.find((x) => x.id === 'kid-1'); kid.status = 'resolved'
  assert.equal(core.checkParentAuto(board, kid), ep)
  assert.equal(ep.status, 'verifying')
})

test('epicSplit 接线（源码级）：缓存同步 / Team 引导段门禁 / 双出口第三参 / get-tasks 透出 / UI「功能」小节', () => {
  const src = hostSrc()
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8') // hostSrc 不含 core（纯逻辑核）
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 配置层（core.mjs：cfg 兜底 / seed 初值 / normalizeBoard 老看板补齐）
  assert.match(coreSrc, /epicSplit: d\.epicSplit !== false/)
  assert.match(coreSrc, /if \(typeof d\.epicSplit !== 'boolean'\) d\.epicSplit = true/)
  assert.match(coreSrc, /notifyDone: true, epicSplit: true, workerContinuable: true, verifyUserGuide: true, minWorkers: 1/) // seed 缺省开（workerContinuable 随 task-muw5gnhv、verifyUserGuide 随 task-muxyyvg0 插入 epicSplit 与 minWorkers 之间）
  // 缓存链路：rt() 读盘同步 + set-board-config 当场回填（Team 提示词是同步组装，只能读缓存）
  assert.match(src, /epicSplitCache\[sid\] = nd\.epicSplit !== false/)
  assert.match(src, /function epicSplitOn\(sid\) \{ return epicSplitCache\[sid\] !== false \}/)
  assert.match(src, /epicSplitOn: session\.epicSplitOn/)
  assert.match(src, /var epicSplitOn = deps\.epicSplitOn/)
  assert.match(src, /else if \(args\.key === 'epicSplit'\) \{ d\.epicSplit = !!args\.value; epicSplitCache\[sid\] = d\.epicSplit \}/)
  // ① Team 提示词第 6 条经门禁出口注入
  assert.match(src, /splitRuleOf\(epicSplitOn\(String\(agent\.id\)\)\)/)
  // ② 双出口（RPC + 工具）都传第三参
  assert.equal((src.match(/withSplitHint\(\{ ok: true, task: t \}, t, cfg\(d\)\.epicSplit\)/g) || []).length, 2)
  assert.match(src, /d\.epicSplit = cfg\(d\)\.epicSplit/) // get-tasks 透出确定布尔值
  // ③ UI：入池配置弹层「功能」小节一行开关（勾选态缺字段=开）+ 状态透传链
  assert.match(cli, /'功能'/)
  assert.match(cli, /'🧩 史诗拆分：大任务引导拆为 epic \+ 子任务'/)
  assert.match(cli, /checked: props\.epicSplit !== false, onChange: function \(e\) \{ setCfg\('epicSplit', e\.target\.checked\) \}/)
  assert.match(cli, /关掉只停引导：显式 parentId 建子卡与史诗自动收口照常工作/)
  assert.match(cli, /state\.epicSplit = cfgKnobOf\(d, 'epicSplit'\)/) // 读取口径单点定义（task-muw5uudk）
  assert.match(cli, /useState\(state\.epicSplit\)/)
  assert.match(cli, /epicSplit: esOn/)
})

test('README 双份同步记录 epicSplit 开关口径（关引导不禁机制）', () => {
  const pkg = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.equal(pkg, root) // 两份 README 必须字节一致
  for (const s of ['`epicSplit`', '「**功能**」小节', '只停**引导**', '**机制不禁**', 'parentId']) {
    assert.ok(pkg.includes(s), 'README 应记录 epicSplit 口径：' + s)
  }
})

// ===== 可续跑 Worker（task-muw5hhsh 卡3）：usage 增量聚合（seq 水位线）/ 重启 reconcile / 文档与 UI 收尾 =====
// 为什么必须真跑日志+真跑 poolCycle：卡3 三条 Step 都是「同一会话被结算多次」与「重启后内存表清零」这两类
// 只在真实路径上才成立的形态——源码级断言看不出「第二次结算到底记了多少」，必须让 settleRun 真读真日志。
// 公共 harness：临时 HOME（findRunLog 走 os.homedir()，子进程外改 env 无效）+ 真 spawnOneShot/真事件通道/
// 真 usage 结算（mutateLocked 直写 board 对象）。childId 固定为 'child-old'，与卡2 续跑用例同一形状。
function frameOfSeq(events) {
  return zlib.zstdCompressSync(Buffer.from(events.map(function (e) { return JSON.stringify(e) }).join('\n') + '\n', 'utf8'))
}
// 一次助手 usage 事件（seq 显式给，模拟 v4 日志的全序字段）
function usageEvent(seq, usage) { return { type: 'assistant/message', seq: seq, data: { usage: usage } } }
// 临时会话日志根（deps.sessionsRoot 注入，不碰 os.homedir）——布局与真实一致：<root>/<bucket>/<childId>/session.v4.jsonl.zstd
function mkLogRoot(bucket, childId, chunks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbc3-'))
  const dir = path.join(root, bucket, childId)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'session.v4.jsonl.zstd')
  if (chunks && chunks.length) fs.writeFileSync(logPath, Buffer.concat(chunks))
  return { root: root, logPath: logPath, append: function (b) { fs.appendFileSync(logPath, b) } }
}
function mkUsageDispatch(board, over, ctxOver) {
  const listeners = []
  const runs = {}
  const ctx = Object.assign({
    fs: {}, get: function () { return null }, timer: null,
    // 真 cordis 的 ctx.effect 立即执行回调取 disposer（订阅当场建立）——桩里必须照做，否则事件通道测不到
    effect: function (f) { var d = f(); return function () { if (typeof d === 'function') d() } },
    on: function (n, f) { listeners.push(f); return function () {} },
    subagents: {
      list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
      start: async () => ({ id: 'run-1', result: new Promise(function () {}), dispose: async function () {} }),
      startContinuable: async () => ({ childId: 'child-old', messageId: 'msg-1' }),
      // 卡3① 要真走「重派续跑」路径（同一 childId 被结算两次）——续跑通道必须在位，
      // 否则第二轮会回落 fresh spawn（虽然 childId 相同、水量线仍生效，但断言的语义就不是续跑了）
      sendMessage: async () => 'msg-2',
      interrupt: () => {},
    },
  }, ctxOver || {})
  const dispatch = createDispatch(ctx, { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: { [FULL_SID]: runs } }, Object.assign({
    rt: async () => board, wt: async () => {}, mutateLocked: async (sid, fn) => fn(board), kickCycle: () => {},
    rootForSession: () => ({ id: FULL_SID }),
    withTimeout: (p) => p, runsFor: () => runs, feedbackOn: () => true, pushSysNote: () => {}, maybeNotify: () => {}, notifyTaskDone: () => {},
  }, over || {}))
  return { dispatch, listeners, runs }
}
const fireIdle = async (h, childId) => {
  h.listeners[0]({ agent: { session: { id: childId } }, status: 'running' })
  h.listeners[0]({ agent: { session: { id: childId } }, status: 'idle' })
  await flush(); await flush(); await flush()
}

test('卡3①：usage 增量聚合——同一持久子会话两次结算只记增量（总量=两次增量之和，非双倍）', async () => {
  // 第 1 轮（首派）：seq 0=模型，1=usage 10
  const L = mkLogRoot('b1', 'child-old', [frameOfSeq([{ type: 'request/context', seq: 0, data: { model: 'deepseek-flash' } }, usageEvent(1, { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 })])])
  try {
    const t = mkTask({ id: 'u1', title: '增量账卡', status: 'pending' })
    const board = mkBoard([t])
    const h = mkUsageDispatch(board, { sessionsRoot: L.root })
    await h.dispatch.poolCycle(FULL_SID)
    await fireIdle(h, 'child-old') // 首轮结算（本用例环境无子会话助手文本 → 走「空文本按失败」的既有降级臂）
    // 首轮：增量=10（水位线从 0 起 → 全量），水位线落卡 = maxSeq(1)
    assert.equal(t.usage.total, 10)
    assert.equal(h.runs['u1'], undefined)
    const first = t.runs[t.runs.length - 1]
    assert.equal(first.usageSeq, 1)                       // 水位线（下一轮从这之后继续）
    assert.equal(first.usage.total, 10)
    // 第 2 轮：重派续跑（同一 childId）→ 追加 seq 2=usage 5，结算只认增量 5
    L.append(frameOfSeq([usageEvent(2, { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 })]))
    await h.dispatch.poolCycle(FULL_SID)
    await fireIdle(h, 'child-old')
    // 断言①：总量 = 10 + 5 = 15（不是全量重复累加的 25）；水位线推进到 2
    assert.equal(t.usage.total, 15)
    assert.equal(t.usage.input, 13)                       // 10 + 3
    assert.equal(t.usage.output, 2)
    assert.equal(t.usage.runs, 2)                         // runs 计数是「结算次数」，不受水位线影响
    const second = t.runs[t.runs.length - 1]
    assert.equal(second.resume, true)                     // 第二轮确实是续跑（沿用同一会话）    assert.equal(second.usageSeq, 2)
    assert.equal(second.usage.total, 5)                   // run 级留账只记本轮增量
    // 第 3 轮：本轮零新增量 → 一行都不记（不记 0，也不重复记）
    await h.dispatch.poolCycle(FULL_SID)
    await fireIdle(h, 'child-old')
    assert.equal(t.usage.total, 15)                       // 总量不动（拿不到增量就跳过累加）
    assert.equal(t.usage.runs, 2)
  } finally { fs.rmSync(L.root, { recursive: true, force: true }) }
})

test('卡3④（基线）：one-shot 路径计账不变——整份日志全量累加一次，与改造前逐字一致', async () => {
  const L = mkLogRoot('b1', 'run-1', [frameOfSeq([
    usageEvent(1, { inputTokens: 4, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 109 }),
    usageEvent(2, { inputTokens: 6, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 8, totalTokens: 21 })
  ])])
  try {
    // workerContinuable=false → 走一次性 start（run.id='run-1'）→ rec 无 continuable/无 childId
    const t = mkTask({ id: 'o1', title: '一次性账卡', status: 'pending' })
    const board = Object.assign(mkBoard([t]), { workerContinuable: false })
    const h = mkUsageDispatch(board, { sessionsRoot: L.root }, {
      subagents: {
        list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
        start: async () => ({ id: 'run-1', result: Promise.reject(new Error('boom')), dispose: async function () {} }),
        startContinuable: async () => { throw new Error('开关关：不该走 continuable') },
      },
    })
    await h.dispatch.poolCycle(FULL_SID)
    for (let i = 0; i < 4; i++) await flush()
    // 全量一次：109 + 21 = 130；五分量逐项累加（缓存读单列）
    assert.equal(t.usage.total, 130)
    assert.equal(t.usage.input, 10)
    assert.equal(t.usage.output, 12)
    assert.equal(t.usage.cacheRead, 100)
    assert.equal(t.usage.cacheWrite, 8)
    assert.equal(t.usage.runs, 1)
    // 水位线同样落卡（一次性 run 的日志只被结算这一次，水位线只是留痕，不改变任何口径）
    assert.equal(t.runs[t.runs.length - 1].usageSeq, 2)
    assert.equal(t.runs[t.runs.length - 1].continuable, undefined)
    // 一次性 run 不会被 reconcile 抢去做续跑（continuable 标记是唯一门禁）
    assert.equal(!!t.runs[t.runs.length - 1].continuable, false)
  } finally { fs.rmSync(L.root, { recursive: true, force: true }) }
})

// ===== 可续跑 Worker⑭（task-muwkhqf8 回归修复）：continuable 结算补关 run 记录（结局/usage/超时臂三件套）=====
// 病根：continuable Worker 的 run 记录此前只有事件通道（agent/status running→idle → settleContinuable →
// settleRun）会收尾。Worker 用 board_report 上报完成时任务已被工具通道推进到 verifying，若该 turn 的
// idle 事件没被观测到（伪 idle 被 rec.ran 守卫挡下/冷窗口/重启/事件丢失），run 记录永久停在 outcome='running'
// → ① 软超时臂对已完成 run 误报 ② usage 漏计 ③ 硬超时臂到期对已结算的闲置会话补枪。
// 观察口径（活体形状，非源码断言）：真跑 poolCycle（真 spawnOneShot）+ 真 board_report 工具（execute）
// + 真 usage 结算（真读 zstd 日志 + seq 水位线）+ mock timer 断言软臂被真清掉。
// 可注入的 mock timer：与真实 ctx.timer 的**回调式**形态同构（timeout(cb, ms) 返回 dispose 闭包），
// 记下每个 handle 是否被清 → 「超时臂摘除」在单测里可断言（promise 式桩做不到这点）。
// interval 是必须项：createDispatch 会挂 15s 心跳（返回 disposer），缺了直接 TypeError。
function mkTimerProbe() {
  const handles = []
  return {
    handles,
    timer: {
      timeout: function (cb, ms) {
        const h = { ms: ms, cancelled: false }
        handles.push(h)
        return function () { h.cancelled = true }
      },
      interval: function () { return function () {} },
    },
  }
}
function lastRun(t) { return t.runs[t.runs.length - 1] }

test('可续跑 Worker⑭a（task-muwkhqf8）：board_report 完成 → runs[] 条目关账（completed+endedAt+usage 落账+usageRecorded）+ 软超时臂被摘除', async () => {
  // 真日志：seq 0=模型，1=usage 33 → 增量口径落账 33（首轮水位线 0 = 全量）
  // 桶名/childId 每条用例独占（node --test 内文件用例可并行，共用同一 root 会互相踩日志目录）
  const L = mkLogRoot('b-cu1', 'child-cua', [frameOfSeq([
    { type: 'request/context', seq: 0, data: { model: 'deepseek-flash' } },
    usageEvent(1, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 33 }),
  ])])
  const TP = mkTimerProbe()
  try {
    const t = mkTask({ id: 'cu1', title: 'continuable 回归卡', status: 'pending' })
    const board = Object.assign(mkBoard([t]), { hardTimeoutMin: 360, softTimeoutMin: 30 })
    const h = mkUsageDispatch(board, { sessionsRoot: L.root }, {
      timer: TP.timer,
      subagents: {
        list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
        start: async () => ({ id: 'run-1', result: new Promise(function () {}), dispose: async function () {} }),
        startContinuable: async () => ({ childId: 'child-cua', messageId: 'msg-1' }),
        sendMessage: async () => 'msg-2', interrupt: () => {},
      },
    })
    await h.dispatch.poolCycle(FULL_SID)
    assert.equal(t.status, 'in-progress')
    assert.equal(h.runs['cu1'].continuable, true)
    // 派发即挂两级超时臂：软臂至少一个 handle（硬臂由 withTimeout 提供，桩里是恒等透传）
    assert.ok(TP.handles.length >= 1, '派发必须挂上软超时臂')
    // Worker 真调 board_report（工具通道）上报完成
    const r = await mkRpcHandlers(board, { reportRunSettled: h.dispatch.settleReportedRun, runsFor: () => h.runs }).__tools['board_report'].execute(
      { taskId: 'cu1', kind: 'complete', summary: '做完了', changes: '改了 a.mjs', selfTest: 'npm test 全绿', diffStat: '+1 -1' }, {})
    assert.equal(r.ok, true)
    assert.equal(t.status, 'verifying')
    // 断言①：run 记录关账——结局 completed + endedAt 落 + usage 落账（增量口径）+ 幂等旗
    const run = lastRun(t)
    assert.equal(run.id, 'child-cua')
    assert.equal(run.outcome, 'completed')
    assert.ok(run.endedAt, 'outcome 关账必须同时落 endedAt')
    assert.equal(run.usage.total, 33)
    assert.equal(run.usage.input, 20)
    assert.equal(run.usage.cacheRead, 3)
    assert.equal(run.usageRecorded, true)   // 幂等旗：重复结算不二次记账
    assert.equal(run.usageSeq, 1)           // 水位线落卡（续跑轮从此继续）
    // 任务级 usage 同步累加 + 活跃表项摘除（任务已落定，不该再占 Worker 并发位）
    assert.equal(t.usage.total, 33)
    assert.equal(t.usage.runs, 1)
    assert.equal(h.runs['cu1'], undefined)
    // 断言②：两级超时臂被摘除——软臂 handle 收到 dispose
    assert.ok(TP.handles.every(x => x.cancelled), '结算后软超时臂必须被真清掉（否则每 30min 刷假告警）')
    // 断言③：重复上报（工具入口重入）不二次关账——任务已不在 in-progress，run 结局/endedAt/usage 均不动
    const endedAt = run.endedAt
    const r2 = await mkRpcHandlers(board, { reportRunSettled: h.dispatch.settleReportedRun, runsFor: () => h.runs }).__tools['board_report'].execute(
      { taskId: 'cu1', kind: 'complete', summary: '再报一次', changes: '', selfTest: '', diffStat: '' }, {})
    assert.equal(r2.ok, false)              // 工具门禁拒绝（not in-progress）
    assert.equal(lastRun(t).endedAt, endedAt)
    assert.equal(t.usage.total, 33)         // usage 不二次累加
    assert.equal(t.usage.runs, 1)
  } finally { fs.rmSync(L.root, { recursive: true, force: true }) }
})

test('可续跑 Worker⑭b（task-muwkhqf8）：文本兜底入口（agent/status idle）同断言——completed+endedAt+usage 落账+超时臂摘除', async () => {
  // 真日志：同一份日志里既有**助手文本**（文本通道据此推进 verifying）又有 usage 帧
  const L = mkLogRoot('b-cu2', 'child-cub', [frameOfSeq([
    { type: 'request/context', seq: 0, data: { model: 'deepseek-flash' } },
    { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: '## 开发描述\n文本通道完工\n## 自测情况\nok' }] } } },
    usageEvent(2, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 11 }),
  ])])
  const TP = mkTimerProbe()
  try {
    const t = mkTask({ id: 'cu2', title: '文本兜底卡', status: 'pending' })
    const board = Object.assign(mkBoard([t]), { hardTimeoutMin: 360, softTimeoutMin: 30 })
    const h = mkUsageDispatch(board, { sessionsRoot: L.root }, {
      timer: TP.timer,
      subagents: {
        list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
        start: async () => ({ id: 'run-1', result: new Promise(function () {}), dispose: async function () {} }),
        startContinuable: async () => ({ childId: 'child-cub', messageId: 'msg-1' }),
        sendMessage: async () => 'msg-2', interrupt: () => {},
      },
    })
    await h.dispatch.poolCycle(FULL_SID)
    await fireIdle(h, 'child-cub') // running→idle：事件通道结算（文本兜底）
    assert.equal(t.status, 'verifying')                 // 有助手文本 → 推进验收（不是「空文本按失败」）
    const run = lastRun(t)
    assert.equal(run.outcome, 'completed')              // 与一次性路径收尾口径一致
    assert.ok(run.endedAt)
    assert.equal(run.usage.total, 11)
    assert.equal(run.usageRecorded, true)
    assert.equal(t.usage.total, 11)
    assert.ok(TP.handles.every(x => x.cancelled), '文本兜底结算同样摘除超时臂')
    assert.equal(h.runs['cu2'], undefined)
  } finally { fs.rmSync(L.root, { recursive: true, force: true }) }
})

test('可续跑 Worker⑭c（task-muwkhqf8 回归）：上报与事件双通道先后到达 → usage 只记一笔、run 结局不被二次改写（幂等）', async () => {
  const L = mkLogRoot('b-cu3', 'child-cuc', [frameOfSeq([
    { type: 'request/context', seq: 0, data: { model: 'deepseek-flash' } },
    { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: '## 开发描述\n工具通道完工\n## 自测情况\nok' }] } } },
    usageEvent(2, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 11 }),
  ])])
  const TP = mkTimerProbe()
  try {
    const t = mkTask({ id: 'cu3', title: '双通道卡', status: 'pending' })
    const board = Object.assign(mkBoard([t]), { hardTimeoutMin: 360, softTimeoutMin: 30 })
    const h = mkUsageDispatch(board, { sessionsRoot: L.root }, {
      timer: TP.timer,
      subagents: {
        list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
        start: async () => ({ id: 'run-1', result: new Promise(function () {}), dispose: async function () {} }),
        startContinuable: async () => ({ childId: 'child-cuc', messageId: 'msg-1' }),
        sendMessage: async () => 'msg-2', interrupt: () => {},
      },
    })
    await h.dispatch.poolCycle(FULL_SID)
    const r = await mkRpcHandlers(board, { reportRunSettled: h.dispatch.settleReportedRun, runsFor: () => h.runs }).__tools['board_report'].execute(
      { taskId: 'cu3', kind: 'complete', summary: '完成', changes: '', selfTest: '', diffStat: '' }, {})
    assert.equal(r.ok, true)
    const endedAt = lastRun(t).endedAt
    // 上报收尾后 idle 事件才到（rec 已摘除 + rec.settled 已立）→ 不二次关账、不二次记账
    h.listeners[0]({ agent: { session: { id: 'child-cuc' } }, status: 'running' })
    h.listeners[0]({ agent: { session: { id: 'child-cuc' } }, status: 'idle' })
    await flush(); await flush(); await flush()
    assert.equal(t.status, 'verifying')                 // 状态不被事件通道回退
    assert.equal(lastRun(t).outcome, 'completed')       // 结局不被改写
    assert.equal(lastRun(t).endedAt, endedAt)           // endedAt 不刷新
    assert.equal(t.usage.total, 11)                     // usage 只有一笔
    assert.equal(t.usage.runs, 1)
  } finally { fs.rmSync(L.root, { recursive: true, force: true }) }
})

test('卡3②③：重启 reconcile——存活的续跑 Worker 被找回重挂观测；已死的会话走硬超时等价物回 pending', async () => {
  const queried = []
  const sent = []
  const spawned = []
  const found = mkTask({
    id: 'k1', title: '重启后仍在跑的卡', status: 'in-progress', claimedBy: 'child-alive', claimedAt: '2026-01-01T00:00:00Z',
    runs: [{ role: 'worker', id: 'child-alive', at: '2026-01-01T00:00:00Z', model: '', outcome: 'running', hardMin: 120, continuable: true }],
  })
  const dead = mkTask({
    id: 'k2', title: '重启后会话已死的卡', status: 'in-progress', claimedBy: 'child-dead', claimedAt: '2026-01-01T00:00:00Z',
    runs: [{ role: 'worker', id: 'child-dead', at: '2026-01-01T00:00:00Z', model: '', outcome: 'running', hardMin: 120, continuable: true }],
  })
  // 干扰项：一次性 run（不可续跑——continuable 标记是唯一门禁）/ 结局已落 timeout-error（归重派续跑路径，reconcile 不抢）
  // claimedAt 取「刚刚」（本用例只测 reconcile，不想顺带触发孤儿回收——那会让干扰项被回收重排，混淆观察口径）
  const nowIso = new Date().toISOString()
  const oneShot = mkTask({
    id: 'k3', title: '一次性 run 卡', status: 'in-progress', claimedBy: 'child-oneshot', claimedAt: nowIso,
    runs: [{ role: 'worker', id: 'child-oneshot', at: nowIso, model: '', outcome: 'running', hardMin: 120 }],
  })
  const failed = mkTask({
    id: 'k4', title: '已落超时结局的卡', status: 'in-progress', claimedBy: 'child-failed', claimedAt: nowIso,
    runs: [{ role: 'worker', id: 'child-failed', at: nowIso, model: '', outcome: 'timeout/error', hardMin: 120, continuable: true }],
  })
  const board = mkBoard([found, dead, oneShot, failed])
  const h = mkUsageDispatch(board, { rootForSession: () => ({ id: FULL_SID }) }, {
    subagents: {
      list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
      start: async () => { spawned.push('one-shot'); return { id: 'run-1', result: new Promise(function () {}), dispose: async function () {} } },
      startContinuable: async () => { spawned.push('continuable'); return { childId: 'child-new', messageId: 'm' } },
      // 死会话的冷复活真实失败（NOT_RESUMABLE）：reconcile 之后本轮重派会先试续跑再回落 fresh spawn
      sendMessage: async (sender, targetId) => { sent.push(targetId); throw new Error('subagent/not-resumable') },
      interrupt: () => {},
      listChildren: async (sid) => { queried.push(sid); return [{ sessionId: 'child-alive', label: 'worker:k1' }] },
    },
  })
  await h.dispatch.poolCycle(FULL_SID)
  // ② 找回存活 run：rec 重建（与 spawnOneShot 的 continuable 形态同构）+ 重挂超时臂 → 任务留在进行中
  assert.deepEqual(queried, [FULL_SID])                     // 查的是 root 会话的 children
  const rec = h.runs['k1']
  assert.ok(rec, '存活子会话必须被重新挂回活跃表')
  assert.equal(rec.id, 'child-alive'); assert.equal(rec.childId, 'child-alive')
  assert.equal(rec.continuable, true); assert.equal(rec.ran, false); assert.equal(rec.settled, false)
  assert.equal(rec.restored, true)                          // 「重启找回」与首次 spawn 可区分
  assert.equal(typeof rec.baselineBytes, 'number')          // 基线取当前日志字节数（重启前产出不冒充本轮交付物）
  assert.equal(typeof rec.startedAt, 'number')
  assert.equal(found.status, 'in-progress'); assert.equal(found.claimedBy, 'child-alive')
  // ③ 会话已死 → 硬超时等价物：回 pending + 清占位 + 落 timeout/error 结局 + 留一行流转记录
  assert.equal(dead.runs[0].outcome, 'timeout/error')
  assert.ok(dead.runs[0].endedAt, '死会话的 run 结局要带 endedAt')
  const deadNote = dead.history.filter((x) => /重启后执行会话已丢失/.test(x.note || ''))
  assert.equal(deadNote.length, 1)
  assert.equal(deadNote[0].to, 'pending')
  assert.equal(dead.lastError, 'host 重启后 Worker 子会话已不存在（reconcile 未找回），任务回收重排')
  // 死会话当轮即被重新派发：先试冷复活（失败）→ 回落全新 Worker（reconcile 只做一次，不阻塞重派）；
  // k1（已找回）占住 Worker 并发位，故本轮 spawned 只有 k2 的替代会话
  assert.deepEqual(sent, ['child-dead'])
  assert.deepEqual(spawned, ['continuable'])
  assert.equal(dead.status, 'in-progress'); assert.equal(dead.claimedBy, 'child-new')
  // 干扰项零变化（reconcile 不越界）：一次性 run 与已落结局的卡都不进 reconcile，也不被它重置
  assert.equal(h.runs['k3'], undefined); assert.equal(oneShot.status, 'in-progress')
  assert.equal(oneShot.claimedBy, 'child-oneshot'); assert.equal(oneShot.runs.length, 1)
  assert.equal(failed.status, 'in-progress'); assert.equal(failed.claimedBy, 'child-failed')
  assert.equal(failed.runs[0].outcome, 'timeout/error'); assert.equal(h.runs['k4'], undefined)
  assert.equal(sent.length, 1)                              // 只有死会话那一次续跑尝试（k3/k4 零 sendMessage）
  // 只做一次（per host 生命周期）：第二轮 listChildren 不再被调用，已找回的 rec 也不被重置
  const before = h.runs['k1']
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(queried.length, 1)
  assert.equal(h.runs['k1'], before)
})

// ===== 僵尸 run 留档清扫（task-mv22z61v）：落定卡 running 无 endedAt 留档关账 + 清卡面认领位 =====
test('僵尸 run 留档清扫：落定卡 running 无 endedAt 留档被关账+清位；在飞卡/活跃 rec 不扫；二次运行零改动', async () => {
  const nowIso = new Date().toISOString()
  // ① 僵尸 verifier 留档：resolved 卡 + verifierRun 残留指向死会话 + runs[] 里 verifier:running 无 endedAt
  const zv = mkTask({ id: 'zv', title: '僵尸 verifier 卡', status: 'resolved', verifierRun: 'v-dead', verifierRunAt: '2026-01-01T00:00:00Z',
    runs: [{ role: 'verifier', id: 'v-dead', at: '2026-01-01T00:00:00Z', model: '', outcome: 'running' }] })
  // ② 僵尸 worker 留档：cancelled 卡 + claimedBy 残留指向死会话
  const zw = mkTask({ id: 'zw', title: '僵尸 worker 卡', status: 'cancelled', claimedBy: 'w-dead', claimedAt: '2026-01-01T00:00:00Z',
    runs: [{ role: 'worker', id: 'w-dead', at: '2026-01-01T00:00:00Z', model: '', outcome: 'running' }] })
  // ③ 已关账留档：outcome 已落定 + endedAt，非 running 条目不该被碰（不误扫非 running 留档）
  const zc = mkTask({ id: 'zc', title: '已关账卡', status: 'resolved',
    runs: [{ role: 'worker', id: 'w-ok', at: '2026-01-01T00:00:00Z', model: '', outcome: 'completed', endedAt: '2026-01-01T00:05:00Z' }] })
  // ④ 在飞卡（in-progress）：running 留档是 reconcile/结算通道辖区，绝不误扫（断言②）
  const inflight = mkTask({ id: 'fly', title: '在飞卡', status: 'in-progress', claimedBy: 'w-alive', claimedAt: nowIso,
    runs: [{ role: 'worker', id: 'w-alive', at: nowIso, model: '', outcome: 'running', continuable: true }] })
  // ⑤ 在飞卡（verifying）+ 活跃 rec：双重护栏——status 非落定 + 内存活跃表里还活着，都该跳过（断言② + 无活跃 rec 才扫）
  const vfy = mkTask({ id: 'vfy', title: '验收中卡', status: 'verifying', verifierRun: 'v-alive', verifierRunAt: nowIso,
    runs: [{ role: 'verifier', id: 'v-alive', at: nowIso, model: '', outcome: 'running' }] })
  const board = mkBoard([zv, zw, zc, inflight, vfy])
  const h = mkUsageDispatch(board)
  h.runs['vfy'] = { id: 'v-alive', role: 'verifier', taskId: 'vfy', startedAt: Date.now(), model: '', settled: false }
  await h.dispatch.poolCycle(FULL_SID)
  // ① 僵尸 verifier 留档：关账（stale-closed + endedAt + note）+ 清 verifierRun 位 + 留一行 history
  assert.equal(zv.runs[0].outcome, 'stale-closed')
  assert.ok(zv.runs[0].endedAt, '僵尸 verifier 留档要带 endedAt')
  assert.equal(zv.runs[0].note, 'host 重启僵尸留档清扫')
  assert.equal(zv.verifierRun, null)
  assert.equal('verifierRunAt' in zv, false)
  assert.equal(zv.history.filter(function (x) { return /僵尸 run 留档已关账/.test(x.note || '') }).length, 1)
  // ② 僵尸 worker 留档：关账 + 清 claimedBy 位
  assert.equal(zw.runs[0].outcome, 'stale-closed')
  assert.ok(zw.runs[0].endedAt)
  assert.equal(zw.runs[0].note, 'host 重启僵尸留档清扫')
  assert.equal(zw.claimedBy, null)
  assert.equal(zw.claimedAt, null)
  // ③ 已关账留档零改动
  assert.equal(zc.runs[0].outcome, 'completed')
  assert.equal(zc.runs[0].endedAt, '2026-01-01T00:05:00Z')
  assert.equal(zc.runs[0].note, undefined)
  // ④⑤ 在飞卡 running 留档零改动（断言②：in-progress/verifying 都不扫）
  assert.equal(inflight.runs[0].outcome, 'running')
  assert.equal(inflight.runs[0].endedAt, undefined)
  assert.equal(inflight.claimedBy, 'w-alive')
  assert.equal(vfy.runs[0].outcome, 'running')
  assert.equal(vfy.runs[0].endedAt, undefined)
  assert.equal(vfy.verifierRun, 'v-alive')
  // ⑤ 幂等：二次运行零改动（关账后 outcome!=running，不再新增 history 行 / 不再刷新 endedAt）
  const zvEndedAt = zv.runs[0].endedAt
  const zwEndedAt = zw.runs[0].endedAt
  const zvHistoryLen = zv.history.length
  const zwHistoryLen = zw.history.length
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(zv.runs[0].outcome, 'stale-closed')
  assert.equal(zv.runs[0].endedAt, zvEndedAt)
  assert.equal(zv.history.length, zvHistoryLen)
  assert.equal(zw.runs[0].outcome, 'stale-closed')
  assert.equal(zw.runs[0].endedAt, zwEndedAt)
  assert.equal(zw.history.length, zwHistoryLen)
})

test('僵尸 run 留档清扫接线（源码级）：sweepZombieRuns 定义 + poolCycle 挂点 + 只清扫落定卡门禁', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  // ① 清扫函数定义（含「只对落定卡做」状态门禁与「无活跃 rec 才扫」护栏）
  assert.match(dsp, /async function sweepZombieRuns\(sid, snap\) \{/)
  assert.match(dsp, /if \(t\.status !== 'resolved' && t\.status !== 'cancelled' && t\.status !== 'archived'\) return/)
  assert.match(dsp, /if \(rec && !rec\.settled && String\(rec\.id\) === rid\) return/)
  assert.match(dsp, /r\.outcome = 'stale-closed'/)
  assert.match(dsp, /r\.endedAt = new Date\(\)\.toISOString\(\)/)
  assert.match(dsp, /r\.note = 'host 重启僵尸留档清扫'/)
  assert.match(dsp, /if \(t\.verifierRun === rid\) \{ t\.verifierRun = null; delete t\.verifierRunAt \}/)
  assert.match(dsp, /if \(t\.claimedBy === rid\) \{ t\.claimedBy = null; t\.claimedAt = null \}/)
  assert.match(dsp, /return any \? d : null/) // 无改动不写盘（安静板不因清扫产生心跳写盘）
  // ② poolCycle 挂点：reconcile 之后、幽灵回收之前（落定卡僵尸留档 reconcile/reap 都管不到，须在空闲快进前兜到）
  assert.match(dsp, /try \{ await sweepZombieRuns\(sid, snap\) \} catch \(e\) \{ console\.error\('\[task-board\] 僵尸留档清扫失败:/)
})

test('卡2/卡3 接线（源码级）：usage 水位线落卡 + reconcile 一次性 + 详情页 ↻ 续跑标注 + 文档收尾', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const usageSrc = readFileSync(new URL('../lib/usage.mjs', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // ① usage 增量：readRunUsage 收第三参 sinceSeq，只认水位线之后的帧，并回传全份 maxSeq
  assert.match(usageSrc, /export function readRunUsage\(runId, sessionsRoot, sinceSeq\) \{/)
  assert.match(usageSrc, /if \(from > 0 && sq <= from\) continue/)
  assert.match(usageSrc, /maxSeq: -1/)
  // ② 结算侧：水位线从卡上 runs 条目读、增量累加后写回（只增不减）
  assert.match(dsp, /function seekSeqOf\(snap, taskId, runId\) \{/)
  assert.match(dsp, /since = seekSeqOf\(snap0, rec\.taskId, rec\.id\)/)
  assert.match(dsp, /u = readRunUsage\(String\(rec\.id\), sessionsRoot, since\)/)
  // 同 id 的续跑新条目尚未结算（usageSeq 未设）→ 必须继续往前找已结算的那条，否则水位线恒 0（踩过的坑）
  assert.match(dsp, /if \(!r \|\| String\(r\.id\) !== String\(runId\)\) continue\s*\n\s*var w = num0\(r\.usageSeq\)\s*\n\s*if \(w > 0\) return w/)
  assert.match(dsp, /t\.runs\[ri\]\.usageSeq = Math\.max\(num0\(t\.runs\[ri\]\.usageSeq\), num0\(u\.maxSeq\)\)/)
  // ③ reconcile：per-host 一次性标记 + listChildren 存活判定 + 重建 rec/重挂超时臂 + 死会话回 pending
  assert.match(dsp, /async function reconcileRoot\(sid\) \{/)
  assert.match(dsp, /if \(state\.reconcileDone\[sid\]\) return/)
  assert.match(dsp, /typeof subagents\.listChildren !== 'function'/)
  assert.match(dsp, /await withTimeout\(q, 5000, 'reconcile listChildren'\)/)
  assert.match(dsp, /restored: true, ran: false/)
  assert.match(dsp, /baselineBytes: logSizeOf\(childId\)/)
  assert.match(dsp, /armTimeouts\(sid, rec, tc, c2\)/)
  assert.match(dsp, /last\.outcome = 'timeout\/error'; last\.endedAt = new Date\(\)\.toISOString\(\)/)
  assert.match(dsp, /续跑观测已恢复/)
  // poolCycle 入口接线（在读 runs/snap 之前，重建的 rec 参与本轮活跃计数）
  assert.match(dsp, /try \{ await reconcileRoot\(sid\) \} catch \(e\) \{ console\.error\('\[task-board\] reconcile 失败:'/)
  // ④ 详情页 ↻ 续跑标注（读卡2 落的 runs[i].resume，不猜；老留档零渲染）
  assert.match(cli, /var rsMark = r\.resume === true \? ' ↻' : ''/)
  assert.match(cli, /↻ 冷复活续跑：沿用上一次的子会话，非新开/)
  // ⑤ index.mjs 共享 state 建 reconcileDone 容器（模块间显式注入，不隐式引用）
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(idx, /reconcileDone: \{\},\s+\/\/ sid -> true/)
})

test('README 双份同步记录可续跑 Worker 三件套（continuable / 重启 reconcile / usage 增量）', () => {
  const pkg = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.equal(pkg, root) // 两份 README 必须字节一致（npm run sync-readme 的约束；断言⑤）
  for (const s of [
    '### 可续跑 Worker（continuable',   // 新增章节
    '`workerContinuable`',              // 回退开关
    'interrupt 留存（不销毁）',           // 超时留存
    '重派冷复活续跑',                     // 冷复活续跑
    '重启 reconcile',                    // 重启找回
    'usageSeq',                          // usage 增量水位线
    '续跑基线',                          // 不拿旧文本冒充交付物
    'Verifier 与 hooks',                 // 一次性边界
  ]) {
    assert.ok(pkg.includes(s), 'README 应记录可续跑 Worker 口径：' + s)
  }
})

// ===== 设置开关点击即时反馈（task-muw5uudk：乐观更新 + config 变化补渲染）=====
// 用户实证「池配置弹层勾选点击几秒才同步」。两段根因：
//   ① 受控 checkbox（checked 读 props）无乐观更新 → 点击要等 set-board-config + fetchTasks 双往返才翻面；
//   ② fetchTasks 在 tasksHash 不变时跳过 notify（渲染节约设计），config 字段照常赋值但无 notify →
//      开关要等下一次任意 notify（安静板卡数秒）才翻面。
// 断言口径：抽真函数原文执行（不猜注释）+ 源码级接线。键名/字段名从源码动态解析——新增开关自动纳入断言。
test('池配置开关乐观更新：每个开关先写 state+notify 再 rpc，失败回滚并复用错误条（源码级实执）', async () => {
  const src = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
  function sliceFn(name, next) {
    const start = src.indexOf('function ' + name + '(')
    assert.ok(start >= 0, 'lib/client/dashboard.js 应定义 ' + name)
    const end = src.indexOf('function ' + next + '(', start + 1)
    assert.ok(end > start, name + ' 之后应紧跟 ' + next)
    return src.slice(start, end)
  }
  const pop = sliceFn('PoolCfgPopover', 'TeamView')
  // ① 每个开关行的 onChange 只能走 setCfg（乐观路径），不得再直接发 rpc（漏一个就回到「等往返才翻面」）
  const handlers = [...pop.matchAll(/type: 'checkbox', checked: [^,]+, onChange: function \(e\) \{ ([^}]*) \}/g)].map(m => m[1])
  assert.ok(handlers.length >= 3, '池配置应有 ≥3 个开关行（实测 ' + handlers.length + ' 个）')
  const keys = []
  for (const h of handlers) {
    const m = h.match(/^setCfg\('([a-zA-Z]+)', e\.target\.checked\)$/)
    assert.ok(m, '开关 onChange 必须是 setCfg(键, e.target.checked) 单调用，实测：' + h)
    keys.push(m[1])
  }
  assert.deepEqual(keys.slice().sort(), ['epicSplit', 'feedbackEnabled', 'notifyDispatch', 'notifyDone', 'verifyUserGuide'])
  // ② 乐观序：先写 state、再 notify、最后才 rpc（顺序颠倒 = 点击仍等往返）
  const setCfgMatch = src.match(/function setCfg\(key, next\) \{[\s\S]*?\n      \}/)
  assert.ok(setCfgMatch, '应定义 setCfg')
  const body = setCfgMatch[0]
  const iState = body.indexOf('state[key] = next === true')
  const iNotify = body.indexOf('notify()')
  const iRpc = body.indexOf("rpc('set-board-config'")
  assert.ok(iState >= 0 && iNotify > iState && iRpc > iNotify, '乐观序必须是 写 state → notify → rpc')
  // ③ 失败回滚分支在位：回滚 state + notify 提示，且回滚先于报错（绝不让开关停在未落盘的值上）
  const iCatch = body.indexOf('.catch(function (e) {')
  assert.ok(iCatch > iRpc, 'setCfg 必须有 .catch 失败分支')
  const catchBody = body.slice(iCatch)
  assert.match(catchBody, /cfgRollback\(key, prev\)/)
  assert.match(catchBody, /reportReadErr\('设置保存失败：' \+ readErrText\(e\)\)/)
  assert.ok(catchBody.indexOf('cfgRollback(key, prev)') < catchBody.indexOf('reportReadErr('), '先回滚再报错')
  const rollbackMatch = pop.match(/function cfgRollback\(key, prev\) \{ state\[key\] = prev; notify\(\) \}/)
  assert.ok(rollbackMatch, '回滚函数应同时还原 state 并 notify')
  // ④ 真执行：乐观翻面 + 成功不回滚 / 失败回滚 + 报错（抽真函数原文跑，不是断言注释）
  function mkHarness(fail) {
    const h = { state: { epicSplit: true, feedbackEnabled: false }, notified: 0, calls: [], errs: [] }
    h.notify = () => { h.notified++ }
    h.reportReadErr = (m) => { h.errs.push(m) }
    h.rpc = (method, args) => { h.calls.push([method, args]); return fail ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true }) }
    h.readErrText = (e) => String((e && e.message) || e || '网络异常')
    h.setCfg = new Function('state', 'notify', 'rpc', 'reportReadErr', 'readErrText',
      rollbackMatch[0] + '\n' + body + '\nreturn setCfg')(h.state, h.notify, h.rpc, h.reportReadErr, h.readErrText)
    return h
  }
  const ok = mkHarness(false)
  ok.setCfg('epicSplit', false)
  assert.equal(ok.state.epicSplit, false)                                   // 点击瞬时翻面（rpc 尚未 resolve）
  assert.equal(ok.notified, 1)
  assert.deepEqual(ok.calls[0], ['set-board-config', { key: 'epicSplit', value: false }])
  await Promise.resolve().then(() => {})                                    // 放行成功分支微任务
  assert.equal(ok.state.epicSplit, false)                                   // 成功路径不回滚
  const bad = mkHarness(true)
  bad.setCfg('feedbackEnabled', true)
  assert.equal(bad.state.feedbackEnabled, true)                             // 乐观置真
  assert.equal(bad.notified, 1)
  await Promise.resolve().then(() => {}).then(() => {})
  assert.equal(bad.state.feedbackEnabled, false)                            // 失败回滚到旧值
  assert.equal(bad.notified, 2)                                             // 回滚立即补 notify（开关不留假态）
  assert.equal(bad.errs.length, 1)
  assert.match(bad.errs[0], /^设置保存失败：boom$/)
})

test('fetchTasks 设置开关权威纠偏：hash 不变时配置变化补 notify + hash 短路结构保持（源码级）', () => {
  const src = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
  // ① 取值口径单点定义（缺字段/脏值=开，只有显式 false 才关），且五个开关字段确由它赋值
  const knobSrc = src.match(/function cfgKnobOf\(src, key\) \{[^\n]*\n/)[0]
  const changedSrc = src.match(/function cfgKnobsChanged\(a, b\) \{[^\n]*\n/)[0]
  const cfgKnobOf = new Function(knobSrc + '\nreturn cfgKnobOf')()
  const cfgKnobsChanged = new Function(changedSrc + '\nreturn cfgKnobsChanged')()
  assert.equal(cfgKnobOf({}, 'notifyDispatch'), true)                            // 老 host 无字段 → 开
  assert.equal(cfgKnobOf({ notifyDispatch: false }, 'notifyDispatch'), false)    // 只有显式 false 才关
  const KNOBS = ['feedbackEnabled', 'notifyDispatch', 'notifyDone', 'epicSplit', 'verifyUserGuide']
  for (const k of KNOBS) assert.match(src, new RegExp("state\\." + k + " = cfgKnobOf\\(d, '" + k + "'\\)"))
  // ② 真执行比较器：五个开关任一翻转都算变化（漏一个 → 该开关又要等下一次任意 notify）
  const allOn = { feedbackEnabled: true, notifyDispatch: true, notifyDone: true, epicSplit: true, verifyUserGuide: true }
  assert.equal(cfgKnobsChanged(allOn, Object.assign({}, allOn)), false)
  for (const k of KNOBS) {
    assert.equal(cfgKnobsChanged(allOn, Object.assign({}, allOn, { [k]: false })), true, k + ' 翻转必须被检测到')
  }
  // ③ 接线：赋值前快照（含全部开关）→ 赋值后比对 → 仅在 hash 短路（!tasksChanged）时补 notify
  const snap = src.match(/var cfgKnobs = \{[^}]*\}/)
  assert.ok(snap, 'fetchTasks 应在赋值前快照开关字段')
  const iSnap = src.indexOf(snap[0])
  for (const k of KNOBS) {
    assert.ok(snap[0].includes(k + ': state.' + k), '快照应含 ' + k)
    assert.ok(src.indexOf("state." + k + " = cfgKnobOf(d, '" + k + "')") > iSnap, k + ' 赋值必须在快照之后')
  }
  assert.match(src, /var cfgDelta = !tasksChanged && cfgKnobsChanged\(cfgKnobs, state\)/)
  // task-muwq9u04：usageSummary 变化与开关变化共用这一次补 notify（令牌区选范围即渲染）
  assert.match(src, /var usageDelta = !tasksChanged && JSON\.stringify\(state\.usageSummary \|\| null\) !== usageJsonPrev/)
  assert.match(src, /if \(cfgDelta \|\| usageDelta\) notify\(\)/)
  const iDelta = src.indexOf('var cfgDelta =')
  const iNotify = src.indexOf('if (cfgDelta || usageDelta) notify()')
  const iEsc = src.indexOf('if (tasksChanged) {\n          var newEsc')
  assert.ok(iDelta < iNotify && iEsc > iNotify, '补 notify 必须在配置赋值之后、escalation 分支之前')
  // ④ 既有渲染节约（tasksHash 短路）逐字保持——本次只加不删
  assert.match(src, /var tasksChanged = !newHash \|\| newHash !== state\.tasksHash/)
  assert.match(src, /if \(tasksChanged\) \{\s*\n\s*state\.tasksHash = newHash\s*\n\s*state\.tasks = \(d && d\.tasks\) \|\| \[\]\s*\n\s*\}/)
  // ⑤ 产物接线：client.js 为拼装产物，真源改动必须已重建（产物与源一致由 build-client --check 兜底）
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(cli, /function cfgKnobOf\(src, key\)/)
  assert.match(cli, /if \(cfgDelta \|\| usageDelta\) notify\(\)/)
  assert.match(cli, /function setCfg\(key, next\)/)
})

// ===== 池冻结根修（task-muwlepg6）：幽灵占位 → capW=0 → 整池停止派发 =====
// 活体事故形状（2026-10-06 实测看板）：首个 continuable Worker 经 board_report 完成后，活跃表项（rec）
// 因当时还没有上报通道收尾而漏摘；此后每张卡漏一条，5 条残留 + 1 个真在跑 → poolCycle 的
// activeW=6 > maxWorkers=3 → capW 恒 0 → 9 张 pending 卡一张都派不出去、verifying 卡的 Verifier 也
// 永不 spawn（pickDispatch 的 busyTaskIds 认出自己的幽灵 rec）——而 force dispatch-task 手动通道
// （不经 capW / busyTaskIds）一切正常。下面三条用例把该形状与本卡的三层防御钉死。
test('池冻结根修①（根因复现）：活跃表残留被回收 → capW 不再被拖到 0，pending 卡当轮照常派发', async () => {
  // 幽灵三态（覆盖活体里出现的三种卡面）：verifying（已交验收）/ resolved / archived，全都不可能是
  // 「Worker 正在跑」的形态，各自都带一条同构的 continuable worker rec。
  const gVerify = mkTask({ id: 'g-verify', title: '卡已交验收', status: 'verifying', claimedBy: 'ghost-1', claimedAt: '2026-10-06T10:29:28Z', runs: [{ role: 'worker', id: 'ghost-1', outcome: 'running', continuable: true, at: '2026-10-06T10:29:31Z' }] })
  const gResolved = mkTask({ id: 'g-resolved', title: '卡已 resolved', status: 'resolved', claimedBy: 'ghost-2' })
  const gArchived = mkTask({ id: 'g-archived', title: '卡已归档', status: 'archived', claimedBy: 'ghost-3' })
  // 真在跑的活卡（in-progress + claimedBy === rec.id）：绝不能被回收——误杀等于整轮交付物丢失
  const live = mkTask({ id: 'live1', title: '真在跑', status: 'in-progress', claimedBy: 'live-child' })
  const p1 = mkTask({ id: 'p1', title: '待派 1', createdAt: '2026-01-01T00:00:01Z' })
  const p2 = mkTask({ id: 'p2', title: '待派 2', createdAt: '2026-01-01T00:00:02Z' })
  const p3 = mkTask({ id: 'p3', title: '待派 3', createdAt: '2026-01-01T00:00:03Z' })
  const board = mkBoard([gVerify, gResolved, gArchived, live, p1, p2, p3])
  const h = mkContinuableDispatch(board, { rootForSession: () => ({ id: FULL_SID }) })
  const now = Date.now()
  h.runs['g-verify'] = { id: 'ghost-1', childId: 'ghost-1', continuable: true, role: 'worker', taskId: 'g-verify', startedAt: now, settled: false }
  h.runs['g-resolved'] = { id: 'ghost-2', childId: 'ghost-2', continuable: true, role: 'worker', taskId: 'g-resolved', startedAt: now, settled: false }
  h.runs['g-archived'] = { id: 'ghost-3', childId: 'ghost-3', continuable: true, role: 'worker', taskId: 'g-archived', startedAt: now, settled: false }
  h.runs['live1'] = { id: 'live-child', childId: 'live-child', continuable: true, role: 'worker', taskId: 'live1', startedAt: now, settled: false }
  const logs = []
  const origLog = console.log
  console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')) }
  try { await h.dispatch.poolCycle(FULL_SID) } finally { console.log = origLog }
  // ① 幽灵条目全部摘除，活条目保留
  assert.equal(h.runs['g-resolved'], undefined)
  assert.equal(h.runs['g-archived'], undefined)
  assert.ok(h.runs['live1'], 'in-progress + claimedBy===rec.id 的真在跑 Worker 绝不能被回收')
  assert.ok(logs.some(s => /回收失效活跃表项（幽灵占位）3 个/.test(s)), '回收动作必须留痕（可观测，不静默）')
  // ② 幽灵摘除后，那张 verifying 卡**当轮**就拿到了 Verifier（旧形状：busyTaskIds 认出它自己的幽灵 rec
  //    → 该卡永远进不了 Verifier 派发）。同一 taskId 的活跃表项从「worker 幽灵」换成「verifier 真 run」，
  //    正是「卡被解冻」的直接证据。
  assert.equal(h.runs['g-verify'].role, 'verifier')
  assert.deepEqual(h.log.oneShot.map(x => x.label), ['verifier:g-verify'])
  assert.equal(gVerify.verifierRun, String(h.runs['g-verify'].id))
  // ③ capW 恢复（maxWorkers=3 - 真活跃 1 = 2）：pending 卡当轮派发——修复前 activeW=4 → capW=0 → 一张不派
  assert.deepEqual(h.log.continuable.map(x => x.label).sort(), ['worker:p1', 'worker:p2'])
  assert.equal(p1.status, 'in-progress'); assert.equal(p2.status, 'in-progress')
  assert.equal(p3.status, 'pending') // 并发上限内，留给下一轮（不是被幽灵卡住）
  // ④ 幽灵的 run 结局用与两条结算通道**同一个** settleRunRecord 补上（不再永久停在 running）
  assert.equal(gVerify.runs[0].outcome, 'completed')
  assert.ok(gVerify.runs[0].endedAt)
  assert.equal(gResolved.runs, undefined) // 无 runs[] 的卡照样摘表项，不因缺数据抛错
  // ⑤ 池状态快照不再出现幽灵（旧形状：poolStatus 里 4 条 busy，其中 3 条是幽灵）
  assert.deepEqual(board.poolStatus.workers.map(w => w.taskId), ['live1'])
  // ⑥ 下一轮心跳照常（池子活过来了）：新 spawn 的 verifier rec 进快照、并发位如实计数——
  //    activeW=3（live1+p1+p2）已到 maxWorkers 上限 → p3 仍按上限留在 pending（是上限，不是幽灵冻结）
  await h.dispatch.poolCycle(FULL_SID)
  assert.deepEqual(board.poolStatus.workers.map(w => w.taskId).sort(), ['live1', 'p1', 'p2'])
  assert.deepEqual(board.poolStatus.verifiers.map(w => w.taskId), ['g-verify'])
  assert.equal(p3.status, 'pending')
})

test('池冻结根修②（防御）：派发单项异常不拖死同轮其余项，下一轮照常派发', async () => {
  // 注入点选「派发即回执」回调（回执/通知层是真实世界里最容易炸的一环）：旧形状下它一抛就抛穿整个
  // toSpawn 循环——本轮后面的卡全部留在 'spawn-pending'（worker 位靠 isOrphan 2min 回收，
  // verifier/hook 位则没有任何自愈路径），且本轮派发整批作废。
  const a = mkTask({ id: 'a1', title: 'A', createdAt: '2026-01-01T00:00:01Z' })
  const b = mkTask({ id: 'b1', title: 'B', createdAt: '2026-01-01T00:00:02Z' })
  let boom = true, n = 0
  const spawned = []
  const h = mkContinuableDispatch(mkBoard([a, b]),
    { notifyDispatched: function () { if (boom) { boom = false; throw new Error('receipt boom') } } },
    {
      subagents: {
        list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
        start: async (name, req) => { spawned.push(req.label); return { id: 'run-' + (++n), result: new Promise(function () {}), dispose: async function () {} } },
        startContinuable: async (spec) => { spawned.push(spec.label); return { childId: 'child-' + (++n), messageId: 'm' } },
      },
    })
  const errs = []
  const origErr = console.error
  console.error = function () { errs.push(Array.prototype.join.call(arguments, ' ')) }
  try { await h.dispatch.poolCycle(FULL_SID) } finally { console.error = origErr }
  // 异常被隔离并留痕（旧形状：异常抛穿 poolCycle，没有这一行）
  assert.ok(errs.some(s => /派发单项异常/.test(s)), '单项异常必须被捕获并留痕')
  // A 那次 spawn 其实成功了（异常发生在回执里）→ 认领位是真实 run id，两个 rec 都在活跃表
  assert.equal(a.claimedBy, 'child-1')
  assert.ok(h.runs['a1'] && h.runs['b1'])
  // 同轮其余项照常派发（旧形状：B 永远停在 'spawn-pending'，只有 worker:a1 被 spawn）
  assert.deepEqual(spawned.sort(), ['worker:a1', 'worker:b1'])
  assert.equal(b.claimedBy, 'child-2')
  // 下一轮照常派发：池没进入冻结态（新增 pending 卡立刻被派出去）
  const c = mkTask({ id: 'c1', title: 'C', createdAt: '2026-01-01T00:00:03Z' })
  h.board.tasks.push(c)
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(c.claimedBy, 'child-3')
})

test('池冻结根修③（防御）：spawn 抛异常时四种占位全清（worker/verifier/hook-pre/hook-post），下一轮照常派发', async () => {
  // 异常点在 spawnOneShot 的 try **之外**（pickProvider → subagents.list()）：这是旧形状里最真实的
  // 抛穿路径——旧代码不接这一抛，第一项就把整个循环带走，紧随其后的 verifier 与两个 hook 占位
  // （spawn-pending / state='running'）全部变成死占位。
  const w = mkTask({ id: 'w1', title: 'W', createdAt: '2026-01-01T00:00:01Z' })
  const v = mkTask({ id: 'v1', title: 'V', status: 'verifying', createdAt: '2026-01-01T00:00:02Z' })
  // claimedAt 取当下：本用例只验证「spawn 抛异常时的占位清理」，别让 isOrphan 的 2min 规则先把手动认领的
  // 史诗回收成 pending（那会把 hook 场景变成 worker 场景，测不到本该测的那条路径）
  const claimedAt = new Date().toISOString()
  const epicPre = mkTask({ id: 'e1', title: 'E-pre', status: 'in-progress', claimedBy: 'main', claimedAt: claimedAt, hooks: { pre: { enabled: true, prompt: '准备', state: 'idle', runId: null } } })
  const epicPost = mkTask({ id: 'e2', title: 'E-post', status: 'in-progress', claimedBy: 'main', claimedAt: claimedAt, hooks: { post: { enabled: true, prompt: '收口', state: 'running', pending: true } } })
  let boom = true, n = 0
  const spawned = []
  const h = mkContinuableDispatch(mkBoard([w, v, epicPre, epicPost]), {}, {
    subagents: {
      list: () => { if (boom) throw new Error('subagents list boom'); return ['mock'] },
      getProvider: () => ({ inheritsParentContext: false }),
      start: async (name, req) => { spawned.push(req.label); return { id: 'run-' + (++n), result: new Promise(function () {}), dispose: async function () {} } },
      startContinuable: async (spec) => { spawned.push(spec.label); return { childId: 'child-' + (++n), messageId: 'm' } },
    },
  })
  const errs = []
  const origErr = console.error
  console.error = function () { errs.push(Array.prototype.join.call(arguments, ' ')) }
  try { await h.dispatch.poolCycle(FULL_SID) } finally { console.error = origErr }
  assert.equal(errs.filter(s => /派发单项异常/.test(s)).length, 4, '四项派发各自被隔离并留痕')
  // 四种占位全部回收（旧形状：w 卡在 in-progress/spawn-pending，v 卡在 verifying/spawn-pending，
  // e1 卡在 hooks.pre.state='running'（串行闸门永久关闭＝该史诗子任务永不派发），
  // e2 卡在 verifierRun='spawn-pending' 且待跑标记已清（＝永久不收口））
  assert.equal(w.status, 'pending'); assert.equal(w.claimedBy, null); assert.equal(w.claimedAt, null)
  assert.equal(v.verifierRun, null); assert.equal(v.verifierRunAt, undefined)
  assert.equal(epicPre.hooks.pre.state, 'idle'); assert.equal(epicPre.hooks.pre.runId, null); assert.equal(epicPre.hooks.pre.pending, true)
  assert.equal(epicPost.verifierRun, null); assert.equal(epicPost.hooks.post.pending, true)
  assert.deepEqual(Object.keys(h.runs), []) // 没有半成品 rec 占并发位
  // 下一轮（spawn 恢复正常）照常派发四种角色——占位清干净的直接证据
  boom = false
  await h.dispatch.poolCycle(FULL_SID)
  assert.deepEqual(spawned.sort(), ['hook-post:e2', 'hook-pre:e1', 'verifier:v1', 'worker:w1'])
  assert.equal(w.status, 'in-progress'); assert.match(String(w.claimedBy), /^child-/)
  assert.ok(v.verifierRun && v.verifierRun !== 'spawn-pending')
  assert.equal(epicPre.hooks.pre.state, 'running'); assert.ok(epicPre.hooks.pre.runId)
  assert.ok(epicPost.verifierRun && epicPost.verifierRun !== 'spawn-pending'); assert.equal(epicPost.hooks.post.pending, false)
  assert.equal(Object.keys(h.runs).length, 4)
})

test('池冻结根修④（防御）：settle 链里抛异常（kickCycle 注入）不拖死 tick，下一轮 poolCycle 照常派发', async () => {
  // 结算链在 host 事件回调里跑（onAgentStatus → settleContinuable → settleRun → settleWorker）。这里在
  // 结算尾部的 kickCycle 上注入异常（真实世界里它通往回执/通知层），验证：异常被结算链自己吃掉、
  // 任务状态照常推进、且**下一轮 poolCycle 照常派发**（tick 没有被拖死）。
  const w = mkTask({ id: 's1', title: '会结算的卡' })
  const p = mkTask({ id: 'p9', title: '后续待派', createdAt: '2026-01-01T00:00:09Z' })
  let boom = false, n = 0
  const board = Object.assign(mkBoard([w, p]), { maxWorkers: 1 }) // 上限 1：第一轮只派 s1，p9 留给下一轮
  const h = mkContinuableDispatch(board,
    { kickCycle: function () { if (boom) throw new Error('kick boom') } },
    {
      subagents: {
        list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
        start: async (name, req) => ({ id: 'run-' + (++n), result: new Promise(function () {}), dispose: async function () {} }),
        startContinuable: async () => ({ childId: 'child-' + (++n), messageId: 'm' }),
      },
    })
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(w.status, 'in-progress'); assert.equal(p.status, 'pending') // 上限内只派 w
  boom = true
  const errs = []
  const origErr = console.error
  console.error = function () { errs.push(Array.prototype.join.call(arguments, ' ')) }
  try {
    h.listeners[0].fn({ agent: { session: { id: 'child-1' } }, status: 'running' })
    h.listeners[0].fn({ agent: { session: { id: 'child-1' } }, status: 'idle' })
    for (let i = 0; i < 4; i++) await flush()
  } finally { console.error = origErr }
  assert.ok(errs.some(s => /settle worker failed/.test(s)), '结算链异常必须被吃掉并留痕')
  assert.equal(w.status, 'pending')   // 状态推进照常（空文本 → 失败重排）
  assert.equal(w.retryCount, 1)
  assert.equal(h.runs['s1'], undefined)
  // tick 照常：下一轮 poolCycle 立刻把 s1 重新派出去（poolCycle 本体没有被结算异常拖死）
  boom = false
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(w.status, 'in-progress')
  assert.ok(h.runs['s1'])
})

test('池冻结根修⑤（接线，源码级）：幽灵回收在活跃度计数之前 + 轮异常隔离 + 去抖 latch 兜底复位', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const sto = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  // ① 回收必须在 activeW 计数与 pickDispatch 之前（否则本轮依旧被幽灵拖住）
  const iReap = dsp.indexOf('reapedN = await reapGhostRecs(sid, snap)')
  const iCount = dsp.indexOf('if (rc0.role === \'worker\') activeW++')
  assert.ok(iReap > 0 && iCount > iReap, '幽灵回收必须先于活跃度计数')
  // ② 回收后重读快照（否则空闲快进的 wt(snap) 会把收尾结果覆盖回旧状态）
  //   （task-muxhrkbg 在同一块内追加了 reapNote 打点，块体由单行扩成多行——语义不变，断言随之放宽到块形状）
  assert.match(dsp, /if \(reapedN > 0\) \{\s*try \{ snap = await rt\(sid\) \} catch \(_\) \{\}/)
  // ③ 本轮主体包 try（整轮异常隔离），且刻意不设再入 latch
  //   （task-muxhrkbg 在 try 块内追加 poolLastOkAt 心跳打点：主体正常返回才刷新——异常隔离语义由下面的 catch 断言继续锁死）
  assert.match(dsp, /try \{\s*var cycleRet = await poolCycleBody\(sid, info, runs, snap\)\s*poolHealthFor\(sid\)\.poolLastOkAt = Date\.now\(\)\s*return cycleRet\s*\}/)
  assert.match(dsp, /catch \(e\) \{ console\.error\('\[task-board\] poolCycle 本轮异常（已隔离，下一轮照常）/)
  assert.match(dsp, /刻意\*\*不设\*\*再入守卫/)
  // ④ 持锁段按阶段隔离（五段各自 try/catch，回调照样返回 d → 该写的池状态一定写下去）
  assert.match(dsp, /回收段异常（本轮跳过回收，派发照常）/)
  assert.match(dsp, /派发决策异常（本轮跳过派发，池状态照常写）/)
  assert.match(dsp, /hook 段异常（本轮跳过 hook spawn）/)
  assert.match(dsp, /touches 展示态计算异常（本轮跳过）/)
  assert.match(dsp, /池状态快照异常（本轮跳过）/)
  // ⑤ 派发单项隔离 + 统一占位回收出口（四角色）
  assert.match(dsp, /async function releaseSpawnPlaceholder\(sid, sp, note\) \{/)
  assert.match(dsp, /派发单项异常（已回收占位，继续本轮其余项）/)
  assert.match(dsp, /await releaseSpawnPlaceholder\(sid, sp, 'spawn 失败，回收重新排队'\)/)
  assert.match(dsp, /await releaseSpawnPlaceholder\(sid, sp, 'spawn 失败'\)/)
  // ⑥ spawn-pending 死占位回收扩面到 in-progress（hook-post 的幂等占用位）
  assert.match(dsp, /if \(t\.verifierRun === 'spawn-pending' && \(now - new Date\(t\.verifierRunAt \|\| 0\)\.getTime\(\)\) > 120000\)/)
  assert.match(dsp, /reclaim-hook-pre/)
  // ⑦ 去抖 latch：时间戳 + 兜底复位 + reject 也复位 + poolCycle 调用包 try/catch
  assert.match(sto, /var STALE_LATCH_MS = 10000/)
  assert.match(sto, /if \(latchedAt && Date\.now\(\) - latchedAt < STALE_LATCH_MS\) return/)
  assert.match(sto, /tm\.timeout\(50\)\.then\(go, go\)/)
  assert.match(sto, /kickCycle → poolCycle 调用失败/)
})

// ============================================================================
// continuable 消息通道二修（task-muwox2ii，发版门禁 e2e 两条红的根因）
//   Bug A：续跑指令把权威锚死在「上文历史契约」→ 仲裁后的新指示没人执行，任务收不了口（touches-freeze 场景 H 红）
//   Bug B：doIntervene 只认 rec.run.localAgent（一次性 run 句柄）→ continuable Worker 收不到干预（steer 套件 4/8 红）
// 断言①②③④ 与主窗口调研笔记一一对应。
// ============================================================================

// ===== Bug A ①（行为级）：仲裁消息原文随续跑指令投递 + 末尾立优先级声明 =====
test('续跑优先级①（task-muwox2ii）：仲裁消息原文随续跑指令投递，末尾立「最新裁决优先于历史契约」声明', async () => {
  const parent = { id: FULL_SID }
  const sent = []
  const t = mkTask({
    id: 'pr1', title: '裁决续跑卡', status: 'pending',
    // 真实形状：escalation（Worker 自己上报的疑问）+ arbitration（主窗口裁决答案）都在卡上
    messages: [
      { kind: 'escalation', text: '要不要继续做？', at: '2026-01-01T00:00:01Z', by: 'child-old' },
      { kind: 'arbitration', text: '无需额外信息，直接按完成契约上报完成即可。', at: '2026-01-01T00:00:02Z', by: 'main', action: 'resume' },
    ],
    runs: [{ role: 'worker', id: 'child-old', at: '2026-01-01T00:00:00Z', model: '', outcome: 'incomplete', hardMin: 120, continuable: true }],
  })
  const h = mkContinuableDispatch(mkBoard([t]), { rootForSession: () => parent }, {
    subagents: {
      list: () => ['mock'], getProvider: () => ({ inheritsParentContext: false }),
      start: async () => { throw new Error('续跑命中时不该走一次性路径') },
      startContinuable: async () => { throw new Error('续跑命中时不该 fresh spawn') },
      sendMessage: async (sender, targetId, content, options) => { sent.push({ sender: sender, targetId: targetId, content: content, options: options }); return 'msg-2' },
    },
  })
  await h.dispatch.poolCycle(FULL_SID)
  assert.equal(sent.length, 1)
  const txt = sent[0].content[0].text
  // ① 仲裁消息在续跑指令里**可见**（与 fresh spawn 的 buildWorkerPrompt 同源 core.buildMessages）
  assert.match(txt, /### \[arbitration\] \(2026-01-01T00:00:02Z by main\)/)
  assert.match(txt, /无需额外信息，直接按完成契约上报完成即可。/)
  // ② 末尾的优先级声明：最新裁决/干预优先于历史契约，并显式给出「不要做其他事 vs 上报完成」的反例
  assert.match(txt, /【优先级声明】/)
  assert.match(txt, /本次消息与上面 messages 里的最新裁决\/干预，优先于上文历史中的原始任务契约/)
  assert.match(txt, /两者冲突时以最新指示为准/)
  assert.match(txt, /不要做其他事/)
  // 声明在仲裁消息**之后**（最后一句才读到，不会被当成插入语）
  assert.ok(txt.lastIndexOf('【优先级声明】') > txt.lastIndexOf('### [arbitration]'), '优先级声明必须在消息段之后')
  // 旧文案逐字保留（老断言与老 Worker 的行为锚点不变）
  assert.match(txt, /【断点续跑】/)
  assert.match(txt, /第 2 次尝试/)
  assert.match(txt, /任务契约与验收标准见上文历史/)
  assert.match(txt, /吃不准就 board_report escalate/)
})

// ===== Bug A ②（源码级）：断言接线不被将来改动悄悄抹掉 =====
test('续跑优先级②（源码级）：续跑文案用 core.buildMessages 带消息段 + 优先级声明文案在位且顺序正确', () => {
  const dsp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  assert.match(dsp, /try \{ msgs = core\.buildMessages\(t\) \} catch \(_\) \{\}/) // 与 fresh spawn 同源（截断口径一致）
  assert.match(dsp, /该任务的最新消息（主窗口裁决\/高优干预\/驳回理由等，请务必遵循）：/)
  assert.match(dsp, /【优先级声明】本次消息与上面 messages 里的最新裁决\/干预，优先于上文历史中的原始任务契约；两者冲突时以最新指示为准/)
  const iMsgs = dsp.indexOf('该任务的最新消息（主窗口裁决')
  const iDecl = dsp.indexOf('【优先级声明】本次消息与上面')
  assert.ok(iMsgs > 0 && iDecl > iMsgs, '先拼消息段，再拼优先级声明')
})

// ===== Bug B ①④（行为级）：continuable rec 干预送得到 + e2e 断言口径（channel='steer'）不变 =====
test('高优干预①（continuable）：rec 无 run 也走宿主投递——host-protocol 优先、保留插件 source、channel=steer', async () => {
  const parent = { id: FULL_SID }
  const hostCalls = []
  const sent = []
  const DELIVER = Symbol.for('dsh.subagent.deliverPrompt')
  const board = mkBoard([mkTask({ id: 'iv1', title: 'continuable 干预卡', status: 'in-progress' })])
  // continuable rec 的真实形态：无 run、有 childId（spawnOneShot 的 continuable 分支）
  const runs = { iv1: { id: 'child-live', childId: 'child-live', continuable: true, ran: true, run: null, role: 'worker', taskId: 'iv1', startedAt: Date.now(), model: '', settled: false } }
  const handlers = mkRpcHandlers(board, { runsFor: () => runs, rootForSession: () => parent }, {
    subagents: {
      [DELIVER]: async function (p, cid, content, source, signal, delivery) { hostCalls.push({ p: p, cid: cid, content: content, source: source, signal: signal, delivery: delivery }); return 'm1' },
      sendMessage: async function (sender, cid, content, options) { sent.push({ sender: sender, cid: cid, content: content, options: options }); return 'm2' },
    },
  })
  const r = await handlers['intervene-agent']({ taskId: 'iv1', message: '插一条高优指令：上报时带上标记 STEER-MARKER-ABC。' })
  assert.equal(r.ok, true)
  assert.equal(r.delivered, true, 'continuable rec 干预必须真的送达（旧实现整段被跳过 → delivered 恒 false）')
  assert.equal(r.channel, 'steer', 'e2e 断言口径不变：channel 必须仍是 steer')
  assert.equal(hostCalls.length, 1)
  assert.deepEqual(sent, [], 'host-protocol 可用时不再重复走 sendMessage（一次干预只投一次）')
  assert.equal(hostCalls[0].p, parent)                  // 授权者 = 活的直接父 Agent
  assert.equal(hostCalls[0].cid, 'child-live')          // 目标 = 该 continuable 子会话
  assert.equal(hostCalls[0].delivery, 'steer')          // 就近 step 边界消费（不是等整 turn 的 queue）
  assert.ok(hostCalls[0].signal, '投递必须带 AbortSignal（SubagentSendMessageOptions 同族形态）')
  assert.match(hostCalls[0].content[0].text, /STEER-MARKER-ABC/)                       // payload 含干预文本
  assert.equal(hostCalls[0].source.kind, 'plugin:dsh-agent-board')                    // source 保留（e2e 消费断言靠它）
  assert.equal(hostCalls[0].source.form, 'notice')
  // 干预原文照旧落卡（详情页可见 + 后续派发随 prompt 注入，通道补充不改这条既有语义）
  assert.equal(board.tasks[0].messages.filter((m) => m.kind === 'intervention').length, 1)
  assert.equal(board.tasks[0].messages.filter((m) => m.kind === 'intervention')[0].text, '插一条高优指令：上报时带上标记 STEER-MARKER-ABC。')
  // ===== 主窗口高优干预锐化（2026-10-06 活体实证）=====
  // 病根补记：旧实现下 **continuable Worker 正在跑**（rec.continuable=true、run=null）时，干预依然落进
  // 「（无活跃 run，随下次派发注入）」分支——「有无活跃 run」的判定本身对 continuable 误阴。此处把
  // 「live continuable rec 的干预不落入该分支」锁成红绿断言。
  const note1 = board.tasks[0].history[board.tasks[0].history.length - 1].note
  assert.ok(!/无活跃 run/.test(note1), 'live continuable rec 干预不得落「无活跃 run」分支（旧实现正是在这里误阴）: ' + note1)
  assert.ok(!/未实时送达/.test(note1), 'delivered=true 时不得带「未实时送达」后缀: ' + note1)
  assert.match(note1, /^高优干预: 插一条高优指令：上报时带上标记 STEER-MARKER-ABC。$/)
})

// ===== Bug B ②（行为级）：一次性 rec 的既有两跳通道逐字不变 =====
test('高优干预②（一次性 rec 逐字不变）：agent.steer 优先、steer 抛错回退 followup、零宿主投递', async () => {
  const steered = [], followed = [], sent = []
  const board = mkBoard([mkTask({ id: 'iv2', title: '一次性干预卡', status: 'in-progress' })])
  const runs = { iv2: { id: 'run-1', run: { localAgent: { steer: function (m) { steered.push(m) }, followup: function (m) { followed.push(m) } } }, role: 'worker', taskId: 'iv2', settled: false } }
  const handlers = mkRpcHandlers(board, { runsFor: () => runs, rootForSession: () => ({ id: FULL_SID }) }, {
    subagents: { sendMessage: async function () { sent.push('不该走宿主投递'); return 'm' } },
  })
  let r = await handlers['intervene-agent']({ taskId: 'iv2', message: '口径重写：先做 B 再做 A。' })
  assert.equal(r.ok, true); assert.equal(r.delivered, true); assert.equal(r.channel, 'steer')
  assert.equal(steered.length, 1); assert.deepEqual(followed, [])
  assert.deepEqual(sent, [])                                    // 一次性 rec 绝不进宿主投递分支
  assert.equal(steered[0].source.kind, 'plugin:dsh-agent-board')
  assert.equal(steered[0].source.form, 'notice')
  assert.match(steered[0].content[0].text, /口径重写：先做 B 再做 A。/)
  // steer 抛错 → 回退 followup（第三跳不变；老宿主没有 steer 时同样落这里）
  runs.iv2 = { id: 'run-2', run: { localAgent: { steer: function () { throw new Error('no steer') }, followup: function (m) { followed.push(m) } } }, role: 'worker', taskId: 'iv2' }
  r = await handlers['intervene-agent']({ taskId: 'iv2', message: '再插一条' })
  assert.equal(r.delivered, true); assert.equal(r.channel, 'followup'); assert.equal(followed.length, 1)
  // 无活跃 rec：只记录，history 说明文案逐字不变
  const idle = mkTask({ id: 'iv8', title: '无活跃 run 卡', status: 'in-progress' })
  board.tasks.push(idle)
  r = await handlers['intervene-agent']({ taskId: 'iv8', message: '无 run 的干预' })
  assert.equal(r.delivered, false); assert.equal(r.channel, '')
  assert.match(idle.history[idle.history.length - 1].note, /^高优干预: 无 run 的干预（无活跃 run，随下次派发注入）$/)
})

// ===== Bug B ③（行为级）：continuable 回退链三态 =====
test('高优干预③（continuable 回退链）：host 符号不可用 → sendMessage；两条都失败 → 记录注入 + history 留「未实时送达」', async () => {
  const sent = []
  const board = mkBoard([
    mkTask({ id: 'iv4', title: '回退 sendMessage 卡', status: 'in-progress' }),
    mkTask({ id: 'iv5', title: '死会话卡', status: 'in-progress' }),
    mkTask({ id: 'iv6', title: '缺 childId 卡', status: 'in-progress' }),
  ])
  const runs = {
    iv4: { id: 'child-a', childId: 'child-a', continuable: true, run: null, role: 'worker', taskId: 'iv4', settled: false },
    iv5: { id: 'child-b', childId: 'child-b', continuable: true, run: null, role: 'worker', taskId: 'iv5', settled: false },
    iv6: { id: 'rec-no-child', continuable: true, run: null, role: 'worker', taskId: 'iv6', settled: false },
  }
  // 老宿主面：ctx.subagents 上没有 host-protocol 符号键方法，只有公开 sendMessage；
  // child-b 的会话已死（sendMessage 抛 NOT_RESUMABLE）
  const handlers = mkRpcHandlers(board, { runsFor: () => runs, rootForSession: () => ({ id: FULL_SID }) }, {
    subagents: {
      sendMessage: async function (sender, targetId, content, options) {
        if (targetId === 'child-b') throw new Error('subagent/not-resumable')
        sent.push({ sender: sender, targetId: targetId, content: content, options: options })
        return 'm'
      },
    },
  })
  // ① host 不可用 → 公开 sendMessage（卡2 续跑同通道），选项形态 { signal }
  let r = await handlers['intervene-agent']({ taskId: 'iv4', message: 'STEER-回退-MARKER' })
  assert.equal(r.ok, true); assert.equal(r.delivered, true); assert.equal(r.channel, 'steer')
  assert.equal(sent.length, 1); assert.equal(sent[0].targetId, 'child-a')
  assert.match(sent[0].content[0].text, /STEER-回退-MARKER/)
  assert.ok(sent[0].options && sent[0].options.signal, 'sendMessage 选项形态必须是 { signal }')
  // ② 会话已死 → 回退记录注入（现状行为），history 写明未实时送达
  r = await handlers['intervene-agent']({ taskId: 'iv5', message: '送给死会话的干预' })
  assert.equal(r.ok, true); assert.equal(r.delivered, false); assert.equal(r.channel, '')
  const t5 = board.tasks.find((x) => x.id === 'iv5')
  assert.equal(t5.messages.filter((m) => m.kind === 'intervention').length, 1)   // 干预原文照旧落卡（重派时会注入）
  assert.match(t5.history[t5.history.length - 1].note, /高优干预: 送给死会话的干预（干预未能实时送达（会话不可用），已转为重派注入）$/)
  // ③ 无 childId（老/异常 rec 形态）→ 同样回退记录注入，不留「已送达」假象
  r = await handlers['intervene-agent']({ taskId: 'iv6', message: '缺 childId 的干预' })
  assert.equal(r.delivered, false); assert.equal(r.channel, '')
  const t6 = board.tasks.find((x) => x.id === 'iv6')
  assert.match(t6.history[t6.history.length - 1].note, /干预未能实时送达（会话不可用），已转为重派注入/)
  // ④ 已立 settled 旗（结算通道正在认领/会话收尾）→ **不投**（主窗口 2026-10-06 锐化的判活口径）：
  //    投递会打在正在关门的会话上或静默丢失，故直接落记录注入；host/sendMessage 一次都不许调。
  runs.iv7 = { id: 'child-settled', childId: 'child-settled', continuable: true, run: null, role: 'worker', taskId: 'iv7', settled: true }
  board.tasks.push(mkTask({ id: 'iv7', title: '已结算 rec 卡', status: 'in-progress' }))
  const sentBefore = sent.length
  r = await handlers['intervene-agent']({ taskId: 'iv7', message: '送给已结算 rec 的干预' })
  assert.equal(r.delivered, false); assert.equal(r.channel, '')
  assert.equal(sent.length, sentBefore, 'settled rec 不得再投递（sendMessage 零调用）')
  const t7 = board.tasks.find((x) => x.id === 'iv7')
  assert.match(t7.history[t7.history.length - 1].note, /干预未能实时送达（会话不可用），已转为重派注入/)
  assert.equal(t7.messages.filter((m) => m.kind === 'intervention').length, 1)
  // 四条路径的干预原文都进 messages（通道选择不改变「记录一条干预」的既有语义）
  assert.equal(t6.messages.filter((m) => m.kind === 'intervention').length, 1)
})

// ===== Bug B ④（源码级）：投递点接线不被将来改动悄悄抹掉 =====
test('高优干预④（源码级）：continuable 投递点 = host-protocol 符号键 + sendMessage 回退，且分路在 rec.continuable 上', () => {
  const rpcSrc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  assert.match(rpcSrc, /Symbol\.for\('dsh\.subagent\.deliverPrompt'\)/)                                  // 宿主适配器入口
  assert.match(rpcSrc, /if \(rec && rec\.continuable === true\) \{/)                                     // 分路门禁
  assert.match(rpcSrc, /await host\.call\(subagents, parent, childId, m\.content, m\.source, makeSignal\(\), 'steer'\)/)
  assert.match(rpcSrc, /await subagents\.sendMessage\(parent, childId, m\.content, \{ signal: makeSignal\(\) \}\)/)
  assert.match(rpcSrc, /if \(rec && rec\.run && rec\.run\.localAgent\) \{/)                              // 一次性路径原样保留
  assert.match(rpcSrc, /干预未能实时送达（会话不可用），已转为重派注入/)
  assert.match(rpcSrc, /if \(!childId \|\| rec\.settled === true \|\| !subagents \|\| !parent\) return \{ delivered: false \}/) // 判活口径（settled 旗）
  // 回退链顺序：host 投递在 sendMessage 之前（能保留插件 source 的通道优先）
  assert.ok(rpcSrc.indexOf('await host.call(subagents, parent, childId') < rpcSrc.indexOf('await subagents.sendMessage(parent, childId'), 'host 投递必须先于 sendMessage 回退')
})

// ===== 巡检三连修（巡检实证三条）：草稿发布预警 / 优先级 chip 单一状态源 / 批量归档跳过原因 =====
test('巡检①：草稿态「保存并重置」改「保存并发布」+ 发布预警 title（源码级 + 文案存在性）', () => {
  const src = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  // 草稿态按钮文案切换（含「发布」字样），非草稿仍「保存并重置」——单一 createElement 内条件三元
  assert.match(src, /task\.status === 'draft' \? ' 保存并发布' : ' 保存并重置'/)
  // 草稿态 title 发布预警文案存在（发布后可能被立即派发）
  assert.match(src, /'发布后按当前工作模式可能被立即派发'/)
  // 组装产物同步（pretest 已跑 build-client）
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /保存并发布/)
  assert.match(built, /发布后按当前工作模式可能被立即派发/)
})

test('巡检②：优先级 chip 高亮与「清除」显隐统一读全局 state.filterPrio（消灭本地 fp 副本）', () => {
  const src = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  // chip 高亮读全局 state.filterPrio（单一事实源）
  assert.match(src, /var on = state\.filterPrio\.indexOf\(p\) >= 0/)
  // 「清除」显隐也读全局 state.filterPrio
  assert.match(src, /var hasFilter = q\.trim\(\) \|\| state\.filterPrio\.length > 0 \|\| ft/)
  // 消灭本地副本：不得再出现 fp 副本初始化 / setFp 同步
  assert.doesNotMatch(src, /useState\(state\.filterPrio\)/)
  assert.doesNotMatch(src, /setFp/)
  // 组装产物同步
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /var on = state\.filterPrio\.indexOf\(p\) >= 0/)
  assert.doesNotMatch(built, /setFp/)
})

test('巡检③：batch-op archive 跳过附 reasons（id → 原因）且 client 渲成「标题：原因」列表', async () => {
  // host 行为：非 resolved/cancelled 卡跳过时记录 'cannot archive' 原因（不再只 skip 无因）
  const a = mkTask({ id: 'tf-a', status: 'resolved' })
  const b = mkTask({ id: 'tf-b', status: 'in-progress' })
  const c = mkTask({ id: 'tf-c', status: 'pending' })
  const board = mkBoard([a, b, c])
  const h = mkRpcHandlers(board)
  const r = await h['batch-op']({ op: 'archive', ids: ['tf-a', 'tf-b', 'tf-c'] })
  assert.equal(r.ok, true)
  assert.equal(r.done, 1)
  assert.deepEqual(r.skipped, ['tf-b', 'tf-c'])
  assert.equal(r.reasons['tf-b'], 'cannot archive')
  assert.equal(r.reasons['tf-c'], 'cannot archive')
  assert.equal(a.status, 'archived')
  assert.equal(b.status, 'in-progress')
  // client 渲染：reasonRows 把 reasons 对象转「标题：原因」列表（逐条，不再只显示「跳过 N」无原因）
  const src = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  assert.match(src, /function reasonRows\(r\) \{ var m = \(r && r\.reasons\) \|\| \{\}; return Object\.keys\(m\)\.map/)
  assert.match(src, /it\.title \+ '：' \+ it\.reason/)
  assert.match(src, /'跳过原因'/)
  // 组装产物同步
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /it\.title \+ '：' \+ it\.reason/)
  assert.match(built, /'跳过原因'/)
})

// ===== 巡检三连②（详情编辑 / 表单标签 / 恢复预警）：优先级+标签可编辑 / 标签进 create 载荷 / 恢复 confirm 门禁 =====
test('巡检三连②-①：详情页优先级四档下拉 + 标签编辑走 update-task（含 tags 通道落卡 trim/去空）', async () => {
  const src = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  // 优先级静态 chip → 四档下拉（value 读 task.priority，onChange 落 update-task priority 通道）
  assert.match(src, /value: task\.priority \|\| 'medium', onChange: function \(e\) \{ rpc\('update-task', \{ taskId: task\.id, priority: e\.target\.value \}\)\.then\(fetchTasks\)/)
  assert.match(src, /\['critical', 'high', 'medium', 'low'\]\.map/)
  // 标签编辑：TagsEditor 逗号分隔 input + update-task tags 通道
  assert.match(src, /function TagsEditor\(props\)/)
  assert.match(src, /rpc\('update-task', \{ taskId: task\.id, tags: tags \}\)/)
  // 行为级：update-task RPC tags 通道落卡 + trim/去空（详情页标签编辑的落点）
  const board = mkBoard([mkTask({ id: 't1', tags: [] })])
  const h = mkRpcHandlers(board)
  const r = await h['update-task']({ taskId: 't1', tags: ['bug', '  epic  ', '', '待验收'] })
  assert.equal(r.ok, true)
  assert.deepEqual(board.tasks[0].tags, ['bug', 'epic', '待验收'])
  // 组装产物同步
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /function TagsEditor\(props\)/)
  assert.match(built, /value: task\.priority \|\| 'medium', onChange: function \(e\) \{ rpc\('update-task', \{ taskId: task\.id, priority: e\.target\.value \}\)\.then\(fetchTasks\)/)
})

test('巡检三连②-②：新建表单「标签」字段进 create-task 载荷（逗号分隔 trim+去空）', () => {
  const src = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  // 标签输入字段 + 逗号分隔解析（trim + 去空）
  assert.match(src, /var tags = tagsRaw\.split\(/)
  assert.match(src, /'标签（逗号分隔，可空）'/)
  // create-task 载荷带 tags 字段（与 touches/dependsOn 同级）
  assert.match(src, /tags: tags, dependsOn: deps/)
  // 组装产物同步
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /tags: tags, dependsOn: deps/)
})

test('巡检三连②-③：归档「恢复待办」confirm 门禁（list 不弹 / auto+team 弹）+ title 预警', () => {
  const src = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  // 工作模式派生（与 fetchTasks 同口径）；list 不弹，auto/team 走 confirm 门禁
  assert.match(src, /var wm = state\.workMode \|\| \(state\.teamMode \? 'team' : \(state\.boardMode === 'auto' \? 'auto' : 'list'\)\)/)
  assert.match(src, /if \(wm !== 'list'\)/)
  assert.match(src, /window\.confirm\('恢复待办后将按当前工作模式立即重新派发，消耗一轮 Worker\+Verifier token。继续/)
  // 按钮 title 预警（非 list 模式），list 模式仅「恢复为待办」
  assert.match(src, /title: wm === 'list' \? '恢复为待办' : '恢复为待办（将按当前工作模式立即重新派发，消耗一轮 Worker\+Verifier token）'/)
  // 组装产物同步
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(built, /window\.confirm\('恢复待办后将按当前工作模式立即重新派发，消耗一轮 Worker\+Verifier token。继续/)
})
