// dsh-agent-board — 风险队列「待你过目」+ 审视摘要区单测（test/review-hints.test.mjs，task-muzikj1y）
// 覆盖（对应任务断言①~⑥ + 接线）：
//   ① 四硬信号各命中/不命中（computeReviewHints：驳回/歧义/核心 touches/full 无 acceptance）
//   ② 软信号平时不计 / 质量异动告警激活期间计入（diff>300 行 + 续跑≥2 次，联动加严）
//   ③ reviewedAt 幂等落账（mark-reviewed RPC 只写一次）+ get-tasks 现算透出 reviewHint 零落库
//   ④⑤ 客户端接线（徽章/chip/审视摘要区四块+来源徽标/digest 未过目）源码级 + 产物重组装
//   ⑥ README 双份逐字一致 + 各补「待你过目」说明
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as core from '../lib/core.mjs'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

// 纯函数测试的任务形态：默认「干净卡」（无驳回/无歧义/无核心 touches/有 acceptance）→ score 0
function mkTask(over) {
  return Object.assign({ id: 't1', title: 'T', status: 'resolved', pipeline: 'full', acceptance: 'npm test', touches: [], messages: [], runs: [], rejectCount: 0 }, over || {})
}

// ===== ① 四硬信号各命中/不命中 =====
test('① 四硬信号各命中/不命中（computeReviewHints）', () => {
  // 干净卡 → score 0
  assert.deepEqual(core.computeReviewHints([mkTask()]), { t1: { score: 0, reasons: [] } })
  // 硬① 被驳回过：rejectCount>0（canonical 口径）
  var h1 = core.computeReviewHints([mkTask({ id: 'a', rejectCount: 1 })])
  assert.equal(h1.a.score, 1); assert.match(h1.a.reasons[0], /驳回/)
  // 硬① 备选：verification.verdict='rejected'
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', verification: { verdict: 'rejected' } })]).a.score, 1)
  // 硬① 备选：messages kind='rejection'
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', messages: [{ kind: 'rejection', text: 'x' }] })]).a.score, 1)
  // 硬① 备选：runs 含 rejected 结局（老留档兼容，字面「runs 含 rejected」口径）
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', runs: [{ outcome: 'rejected' }] })]).a.score, 1)
  // 硬① 不命中：零驳回
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', rejectCount: 0, verification: { verdict: 'approved' } })]).a.score, 0)
  // 硬② 上报过歧义：messages kind='arbitration'
  var h2 = core.computeReviewHints([mkTask({ id: 'a', messages: [{ kind: 'arbitration', text: 'x' }] })])
  assert.equal(h2.a.score, 1); assert.match(h2.a.reasons[0], /歧义/)
  // 硬② 不命中：无 arbitration 包
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', messages: [{ kind: 'progress', text: 'x' }] })]).a.score, 0)
  // 硬③ touches 碰核心文件：三种核心文件 basename 各命中
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', touches: ['lib/dispatch.mjs'] })]).a.score, 1)
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', touches: ['lib/rpc.mjs'] })]).a.score, 1)
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', touches: ['core.mjs'] })]).a.score, 1)
  assert.match(core.computeReviewHints([mkTask({ id: 'a', touches: ['./lib/core.mjs'] })]).a.reasons[0], /核心文件/)
  // 硬③ 不命中：非核心文件 / glob
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', touches: ['src/a.mjs'] })]).a.score, 0)
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', touches: ['*.mjs'] })]).a.score, 0)
  // 硬④ full 无 acceptance
  var h4 = core.computeReviewHints([mkTask({ id: 'a', acceptance: '' })])
  assert.equal(h4.a.score, 1); assert.match(h4.a.reasons[0], /验收脚本/)
  // 硬④ 不命中：有 acceptance / work 档 / 空白 acceptance 但有内容（trim 后非空不算空）
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', acceptance: 'node --test' })]).a.score, 0)
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', acceptance: '', pipeline: 'work' })]).a.score, 0)
})

// ===== ② 软信号：平时不计 / 告警态计入（联动加严）=====
test('② 软信号：质量异动告警未激活不计入 / 激活期间计入（diff>300 行 + 续跑≥2 次）', () => {
  var diff = ' src/a.mjs | 200 +++++++\n 1 file changed, 350 insertions(+), 50 deletions(-)'
  var t = mkTask({ id: 'a', deliverable: { diff: diff }, runs: [{ role: 'worker', resume: true }, { role: 'worker', resume: true }] })
  // 平时（告警未激活）：软信号不计入 → score 0
  assert.equal(core.computeReviewHints([t], {}).a.score, 0)
  assert.equal(core.computeReviewHints([t], { qualityAlertActive: false }).a.score, 0)
  // 告警激活：diff(400 行)>300 + 续跑 2 次≥2 → 两条软信号全计入
  var h = core.computeReviewHints([t], { qualityAlertActive: true })
  assert.equal(h.a.score, 2)
  assert.match(h.a.reasons[0], /diff 超 300 行/)
  assert.match(h.a.reasons[1], /续跑 ≥2 次/)
  // 阈值边界：恰好 300 行不亮（>300 才亮）；续跑 1 次不亮
  var diffEdge = ' 1 file changed, 250 insertions(+), 50 deletions(-)' // 300 行
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', deliverable: { diff: diffEdge } })], { qualityAlertActive: true }).a.score, 0)
  assert.equal(core.computeReviewHints([mkTask({ id: 'a', runs: [{ resume: true }] })], { qualityAlertActive: true }).a.score, 0)
  // 硬软叠加：硬④ + 软⑤ + 软⑥ → score 3
  var tMix = mkTask({ id: 'a', acceptance: '', deliverable: { diff: diff }, runs: [{ resume: true }, { resume: true }] })
  var hMix = core.computeReviewHints([tMix], { qualityAlertActive: true })
  assert.equal(hMix.a.score, 3)
})

// ===== ③ reviewedAt 幂等落账 + get-tasks 现算透出 reviewHint（真 harness）=====
test('③ mark-reviewed 幂等落账（只写一次）+ get-tasks 现算透出 reviewHint 零落库', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await env.rpc('create-task', { sessionId: env.sid, id: 'task-rv', title: 'R', description: 'd', pipeline: 'full', acceptance: 'npm test' })
    assert.equal(env.task('task-rv').reviewedAt, undefined, '初始无 reviewedAt')
    // 第一次落账
    var r1 = await env.rpc('mark-reviewed', { sessionId: env.sid, taskId: 'task-rv' })
    assert.equal(r1.ok, true)
    var at1 = env.task('task-rv').reviewedAt
    assert.ok(at1, '第一次落账 reviewedAt')
    // 幂等：第二次不重写
    var r2 = await env.rpc('mark-reviewed', { sessionId: env.sid, taskId: 'task-rv' })
    assert.equal(r2.ok, true)
    assert.equal(env.task('task-rv').reviewedAt, at1, '第二次调用不重写 reviewedAt')
    // 未找到任务
    var r3 = await env.rpc('mark-reviewed', { sessionId: env.sid, taskId: 'nope' })
    assert.equal(r3.ok, false)
    // get-tasks 透出 reviewHint（现算，不落盘）
    await env.rpc('create-task', { sessionId: env.sid, id: 'task-gh', title: 'G', description: 'd', pipeline: 'full', acceptance: 'npm test' })
    env.patchBoard(function (d) {
      var t = d.tasks.find(function (x) { return x.id === 'task-gh' })
      t.rejectCount = 1
      t.touches = ['lib/core.mjs']
      t.acceptance = ''
    })
    var d = await env.rpc('get-tasks', { sessionId: env.sid })
    var gh = d.tasks.find(function (x) { return x.id === 'task-gh' })
    assert.ok(gh.reviewHint, 'get-tasks 透出 reviewHint')
    assert.equal(gh.reviewHint.score, 3, '驳回 + 核心文件 + 无 acceptance = 3 条硬信号')
    assert.equal(gh.reviewHint.reasons.length, 3)
    // 零落库：board 文件不存 reviewHint（现算字段不进盘）
    var raw = env.board().tasks.find(function (x) { return x.id === 'task-gh' })
    assert.equal(raw.reviewHint, undefined, 'reviewHint 现算零落库（board 文件不写 reviewHint）')
  } finally { await env.cleanup() }
})

// ===== ④⑤⑥ 客户端接线 + 产物重组装 + README 双份（源码级）=====
test('④⑤ 客户端接线：徽章/chip/审视摘要区四块+来源徽标/digest（源码级 + 产物重组装）', () => {
  const ksrc = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
  const bl = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  const td = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  const dash = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // kernel：单一事实源谓词 + 过滤接线 + state 默认字段
  assert.match(ksrc, /function reviewPending\(t\)/)
  assert.match(ksrc, /state\.filterReview && !reviewPending\(t\)/)
  assert.match(ksrc, /filterReview: false/)
  // board-list：chip「待你过目」+ 「建议过目」徽章
  assert.ok(bl.indexOf('待你过目') >= 0, 'FilterBar 缺「待你过目」chip')
  assert.ok(bl.indexOf('👁 建议过目') >= 0, '缺「建议过目」徽章')
  assert.match(bl, /reviewPending\(t\) \?/)
  // task-detail：审视摘要区四块 + 来源徽标 + mark-reviewed 触发
  assert.ok(td.indexOf('tskb-review-summary') >= 0, '缺审视摘要区容器 id')
  assert.ok(td.indexOf('① 为什么在这') >= 0, '缺四问①')
  assert.ok(td.indexOf('② 改了什么') >= 0, '缺四问②')
  assert.ok(td.indexOf('③ 机器怎么验的') >= 0, '缺四问③')
  assert.ok(td.indexOf('④ 怎么亲自确认') >= 0, '缺四问④')
  assert.ok(td.indexOf('Worker 汇报') >= 0, '缺「Worker 汇报」来源徽标')
  assert.ok(td.indexOf('Verifier 实证') >= 0, '缺「Verifier 实证」来源徽标')
  assert.ok(td.indexOf('系统记录') >= 0, '缺「系统记录」来源徽标')
  assert.match(td, /rpc\('mark-reviewed'/)
  // dashboard：digest 未过目计数 + buildReport 行
  assert.match(dash, /reviewPending\(t\)/)
  assert.ok(dash.indexOf('- 未过目：') >= 0, '报告缺「未过目」行')
  // 产物重组装：关键标记逐一出现在 lib/client.js
  for (const m of ['待你过目', '👁 建议过目', 'tskb-review-summary', '- 未过目：']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})

test('接线：core 纯函数 + rpc get-tasks 现算 + mark-reviewed（源码级）', () => {
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /export function computeReviewHints\(tasks, opts\)/)
  assert.match(coreSrc, /export var REVIEW_CORE_FILES = \['dispatch\.mjs', 'rpc\.mjs', 'core\.mjs'\]/)
  assert.match(rpc, /core\.computeReviewHints\(d\.tasks, \{ qualityAlertActive: __qch\.length > 0 \}\)/)
  assert.match(rpc, /handle\('mark-reviewed'/)
  assert.match(rpc, /if \(!t\.reviewedAt\) t\.reviewedAt = new Date\(\)\.toISOString\(\)/)
  // tasksHash 序列化口径纳入 reviewedAt + reviewHint（已阅/软信号联动才能重渲染）
  assert.match(coreSrc, /t\.reviewedAt,/)
  assert.match(coreSrc, /t\.reviewHint \? String\(t\.reviewHint\.score\)/)
})

test('⑥ README 双份：逐字一致 + 各补「待你过目」说明', () => {
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('待你过目') >= 0, 'README 缺「待你过目」说明')
  assert.ok(r1.indexOf('审视摘要') >= 0, 'README 缺「审视摘要」说明')
  assert.ok(r1.indexOf('reviewHint') >= 0, 'README 缺 reviewHint 说明')
})
