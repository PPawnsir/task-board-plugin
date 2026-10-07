// dsh-agent-board — 记分卡卡5 驳回聚类 + 约定建议 + 按表现荐模型 hint 单测（test/scorecard-clusters.test.mjs，task-muxhu1zv）
// 覆盖（对应任务断言①~④ + 接线）：
//   ① 聚类规则法正确性——5 类驳回文本各 3 条 → Top3 正确（并列按规则表顺序）+ 占比 20%；
//     区分度 case（5/4/3/2/1）Top3 顺序与 pct；未匹配文本进 other 兜底桶
//   ② 建议文本结构化——suggestion 形如「驳回 Top1『…』占 N%——建议…」逐字核对
//   ③ 荐模型 hint 阈值边界——runs 9/10、通过率 89%/90%、effGap 恰好 30% 不亮 / 31% 亮、
//     单模型无对比不亮、verifier/large 桶不计入
//   ④ 无驳回/无数据不炸——空/脏输入全形态返回空结果或 null，绝不抛错
//   ⑤ 接线（源码级 + 端到端）——buildScoreboard 挂 rejectionClusters（范围按驳回消息日落点裁剪）/
//     rpc healthHints 拼 modelPerfHint / index re-export / client 组件与产物 / README 双份
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildScoreboard, clusterRejections, REJECTION_CLUSTER_RULES, modelPerfHint, MODEL_HINT_MIN_RUNS, MODEL_HINT_MIN_PASS, MODEL_HINT_EFF_GAP } from '../index.mjs'
import { localDayKey } from '../lib/usage.mjs'

function isoOf(y, m, d, h, mi) { return new Date(y, m - 1, d, h, mi || 0, 0).toISOString() }
function dayOf(y, m, d) { return localDayKey(new Date(y, m - 1, d, 12)) }
const D0 = dayOf(2026, 10, 5)
const D1 = dayOf(2026, 10, 6)

// 五类驳回文本（与规则表类目一一对应；形态仿 rejectionText 产物「验收驳回 · <summary>」）
const REJ_TEXTS = {
  'acceptance-skipped': '验收驳回 · 验收脚本未实跑——上报前必须逐字粘贴真实输出',
  'readme-stale': '验收驳回 · README 未同步（行为变了文档没跟）',
  'scope-creep': '验收驳回 · 范围越界：改了 touches 声明外的文件',
  'assertion-missing': '验收驳回 · 断言①缺失单测锁定',
  'artifact-stale': '验收驳回 · 产物未重组装（lib/client.js 还是旧的）',
}
// 构造 texts：{ 类目id: 条数 }（按对象键序铺开）
function mkTexts(plan) {
  const out = []
  for (const id of Object.keys(plan)) for (let i = 0; i < plan[id]; i++) out.push(REJ_TEXTS[id] + ' #' + i)
  return out
}

// ===== ① 聚类规则法正确性 =====
test('卡5①a：5 类驳回各 3 条 → Top3 = 规则表前三类（并列按表序），占比各 20%，其余进 restCount', () => {
  const r = clusterRejections(mkTexts({ 'acceptance-skipped': 3, 'readme-stale': 3, 'scope-creep': 3, 'assertion-missing': 3, 'artifact-stale': 3 }))
  assert.equal(r.total, 15)
  assert.equal(r.top.length, 3)
  // 五类并列 3 条：Top3 取规则表顺序前三（acceptance → readme → scope）
  assert.deepEqual(r.top.map(function (c) { return c.id }), ['acceptance-skipped', 'readme-stale', 'scope-creep'])
  for (const c of r.top) {
    assert.equal(c.count, 3)
    assert.equal(c.pct, 20) // 3/15 = 20%
    assert.equal(c.samples.length, 3) // 代表原文 ≤3 条
  }
  assert.equal(r.restCount, 2) // assertion/artifact 两类未进 Top3
  assert.equal(r.otherCount, 0)
})
test('卡5①b：区分度 5/4/3/2/1 → Top3 按 count 降序，pct 逐条核对；未匹配文本进 other 桶', () => {
  const texts = mkTexts({ 'acceptance-skipped': 5, 'readme-stale': 4, 'scope-creep': 3, 'assertion-missing': 2, 'artifact-stale': 1 })
  texts.push('验收驳回 · 完全模板外的奇葩原因') // other
  const r = clusterRejections(texts)
  assert.equal(r.total, 16)
  assert.deepEqual(r.top.map(function (c) { return c.id }), ['acceptance-skipped', 'readme-stale', 'scope-creep'])
  assert.equal(r.top[0].pct, 31) // 5/16 = 31.25% → 31
  assert.equal(r.top[1].pct, 25) // 4/16 = 25%
  assert.equal(r.top[2].pct, 19) // 3/16 = 18.75% → 19
  assert.equal(r.otherCount, 1)
  assert.equal(r.restCount, 3) // assertion/artifact/other 未进 Top3
  // 规则表常量形态：5 类种子类目 + 每条带 id/label/re/advice
  assert.equal(REJECTION_CLUSTER_RULES.length, 5)
  for (const rule of REJECTION_CLUSTER_RULES) {
    assert.ok(rule.id && rule.label && rule.re instanceof RegExp && typeof rule.advice === 'string' && rule.advice.length > 0)
  }
  // 首命中归类：同时命中两类关键词的文本只归优先级更高者（占比分母守恒，Σcount = total）
  const mixed = clusterRejections(['验收驳回 · 验收脚本没跑，README 也没同步'])
  assert.equal(mixed.total, 1)
  assert.equal(mixed.top[0].id, 'acceptance-skipped') // 「没跑」先命中（规则表第一位）
})

// ===== ② 建议文本结构化 =====
test('卡5②：suggestion 结构化——「驳回 TopN『label』占 pct%——建议<类目 advice>」逐字核对', () => {
  const r = clusterRejections(mkTexts({ 'acceptance-skipped': 2, 'readme-stale': 1 }))
  assert.equal(r.top[0].suggestion, '驳回 Top1『验收脚本未实跑』占 67%——建议在派发约定/Worker prompt 补一条：上报前必须逐字粘贴验收脚本真实输出（未通过不得上报完成）')
  assert.equal(r.top[1].suggestion, '驳回 Top2『README 未同步』占 33%——建议在派发约定补一条：行为/口径/界面变化必须同步 README 双份并逐字一致（npm run sync-readme）')
  // other 桶也有通用建议文案（人工归纳入口）
  const ro = clusterRejections(['验收驳回 · 模板外原因'])
  assert.equal(ro.top[0].id, 'other')
  assert.match(ro.top[0].suggestion, /^驳回 Top1『其他（未匹配规则）』占 100%——建议人工归纳该类驳回的共性/)
})

// ===== ③ 荐模型 hint 阈值边界 =====
// 构造 scoreboard bucket（modelPerfHint 只读 model/role/size/runs/resolved/firstPass/effSum/effCount）
function bk(model, role, size, runs, resolved, firstPass, effAvg) {
  return { model: model, role: role, size: size, runs: runs, resolved: resolved, firstPass: firstPass, effSum: effAvg * runs, effCount: runs }
}
// 基准亮例：m/a 中小卡合并 runs=10、通过率 9/10=90%、effAvg 690；m/b runs=10、100%、effAvg 1000（差距 31%）
function sbBase() {
  return { buckets: [
    bk('m/a', 'worker', 'small', 6, 6, 5, 690),
    bk('m/a', 'worker', 'medium', 4, 4, 4, 690),
    bk('m/b', 'worker', 'small', 10, 10, 10, 1000),
  ] }
}
test('卡5③a：荐模型 hint 亮例——中小卡 worker 合并判定 + 文案逐项（模型/通过率/有效均值/差距）', () => {
  assert.equal(MODEL_HINT_MIN_RUNS, 10)
  assert.equal(MODEL_HINT_MIN_PASS, 0.9)
  assert.equal(MODEL_HINT_EFF_GAP, 0.3)
  const h = modelPerfHint(sbBase())
  assert.ok(h, '满足全部阈值必须亮')
  assert.equal(h.level, 'warn') // 黄条
  assert.ok(h.text.indexOf('模型 m/a 在中小卡表现最优') === 0)
  assert.ok(h.text.indexOf('通过率 90%') >= 0)
  assert.ok(h.text.indexOf('有效均值 690') >= 0)
  assert.ok(h.text.indexOf('较其他合格模型低 31%') >= 0) // (1000-690)/1000 = 31%
  assert.ok(h.text.indexOf('建议设为默认 workerModel') >= 0)
})
test('卡5③b：阈值边界——runs 9 不亮 / 恰好 10 亮；通过率 89% 不亮 / 恰好 90% 亮；effGap 恰好 30% 不亮 / 31% 亮', () => {
  // runs 9（中小卡合并后仍差 1）→ null
  const s9 = sbBase(); s9.buckets[1] = bk('m/a', 'worker', 'medium', 3, 3, 3, 690) // 6+3=9
  assert.equal(modelPerfHint(s9), null)
  // runs 恰好 10 → 亮（sbBase 已是 10，③a 已证）
  // 通过率 89%（resolved=100, firstPass=89）→ null
  const s89 = { buckets: [bk('m/a', 'worker', 'small', 100, 100, 89, 690), bk('m/b', 'worker', 'small', 10, 10, 10, 1000)] }
  assert.equal(modelPerfHint(s89), null)
  // 通过率恰好 90%（firstPass=9, resolved=10）→ 亮（sbBase 即此形态）
  // effGap 恰好 30%（700 vs 1000 → (1000-700)/1000 = 0.3，严格 > 不成立）→ null
  const s30 = { buckets: [bk('m/a', 'worker', 'small', 10, 10, 9, 700), bk('m/b', 'worker', 'small', 10, 10, 10, 1000)] }
  assert.equal(modelPerfHint(s30), null)
  // effGap 31%（690 vs 1000）→ 亮
  const s31 = { buckets: [bk('m/a', 'worker', 'small', 10, 10, 9, 690), bk('m/b', 'worker', 'small', 10, 10, 10, 1000)] }
  assert.ok(modelPerfHint(s31))
})
test('卡5③c：对比与口径边界——单模型合格不亮（无对比对象）；verifier/large 桶不计入；effAvg 不可知不判', () => {
  // 只有一个合格模型（m/b runs 不足 10）→ null
  const s1 = { buckets: [bk('m/a', 'worker', 'small', 10, 10, 10, 500), bk('m/b', 'worker', 'small', 5, 5, 5, 2000)] }
  assert.equal(modelPerfHint(s1), null)
  // m/a 的数据全在 verifier 桶 → worker 桶无候选 → null
  const sv = { buckets: [bk('m/a', 'verifier', 'small', 20, 20, 20, 500), bk('m/b', 'worker', 'small', 10, 10, 10, 1000)] }
  assert.equal(modelPerfHint(sv), null)
  // large 桶不计入中小卡判定（m/a 只有 large 达标）→ null
  const sl = { buckets: [bk('m/a', 'worker', 'large', 20, 20, 20, 500), bk('m/b', 'worker', 'small', 10, 10, 10, 1000)] }
  assert.equal(modelPerfHint(sl), null)
  // 通过率不可知（resolved=0）不判；有效均值不可知（effCount=0）不判
  assert.equal(modelPerfHint({ buckets: [bk('m/a', 'worker', 'small', 10, 0, 0, 500), bk('m/b', 'worker', 'small', 10, 10, 10, 1000)] }), null)
  const se = sbBase(); se.buckets[0].effCount = 0; se.buckets[1].effCount = 0 // m/a 均值不可知
  assert.equal(modelPerfHint(se), null)
})

// ===== ④ 无驳回/无数据不炸 =====
test('卡5④：空/脏输入全形态不炸——空数组/非数组/空文本/null 字段', () => {
  assert.deepEqual(clusterRejections([]), { total: 0, top: [], otherCount: 0, restCount: 0 })
  assert.deepEqual(clusterRejections(null), { total: 0, top: [], otherCount: 0, restCount: 0 })
  assert.deepEqual(clusterRejections('garbage'), { total: 0, top: [], otherCount: 0, restCount: 0 })
  // 空文本/空白文本不算样本（不稀释占比）
  assert.equal(clusterRejections(['', '  ', null, undefined]).total, 0)
  // hint：null / 缺 buckets / 空 buckets → null
  assert.equal(modelPerfHint(null), null)
  assert.equal(modelPerfHint({}), null)
  assert.equal(modelPerfHint({ buckets: [] }), null)
  assert.equal(modelPerfHint({ buckets: 'garbage' }), null)
  // 脏 bucket 条目（null/缺字段）不炸
  assert.equal(modelPerfHint({ buckets: [null, { model: 'x' }, 'garbage'] }), null)
  // 全空看板端到端：scoreboard 带 rejectionClusters 空形态
  const sb = buildScoreboard([])
  assert.deepEqual(sb.rejectionClusters, { total: 0, top: [], otherCount: 0, restCount: 0 })
})

// ===== ⑤ 接线：buildScoreboard 端到端（驳回消息 → rejectionClusters）+ 范围裁剪 =====
test('卡5⑤a：buildScoreboard 挂 rejectionClusters——驳回文本随 rejRec 进聚类；范围按驳回消息自身日落点裁剪', () => {
  const tasks = [
    {
      id: 'tR1', title: 'R1', status: 'resolved', createdAt: isoOf(2026, 10, 6, 9), verifiedAt: isoOf(2026, 10, 6, 15),
      rejectCount: 2,
      messages: [
        { kind: 'rejection', text: '验收驳回 · 验收脚本未实跑', at: isoOf(2026, 10, 6, 11), by: 'v1' },
        { kind: 'rejection', text: '验收驳回 · README 未同步', at: isoOf(2026, 10, 5, 18), by: 'v2' }, // D0 的驳回
      ],
      usage: { input: 100, output: 50, cacheWrite: 10, total: 1160 },
      runs: [{ role: 'worker', id: 'w1', at: isoOf(2026, 10, 6, 10), endedAt: isoOf(2026, 10, 6, 10, 10), model: 'm/a', outcome: 'completed', usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, total: 1160 } }],
    },
  ]
  const sb = buildScoreboard(tasks)
  assert.equal(sb.rejectionClusters.total, 2)
  assert.equal(sb.rejectionClusters.top.length, 2)
  assert.equal(sb.rejectionClusters.top[0].id, 'acceptance-skipped') // 并列 1 条按规则表序
  assert.equal(sb.rejectionClusters.top[1].id, 'readme-stale')
  // 范围只留 D1：D0 的 README 驳回被裁（按驳回消息自身日落点，与 run 归因独立）
  const sr = buildScoreboard(tasks, { from: D1, to: D1 })
  assert.equal(sr.rejectionClusters.total, 1)
  assert.equal(sr.rejectionClusters.top[0].id, 'acceptance-skipped')
  // 无驳回任务的看板：空形态不炸
  assert.equal(buildScoreboard([{ id: 'x', status: 'pending' }]).rejectionClusters.total, 0)
})
test('卡5⑤b：接线（源码级）——rpc healthHints 拼 modelPerfHint / index re-export / client 组件与产物 / README 双份', () => {
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  const usage = readFileSync(new URL('../lib/usage.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const dash = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // host：modelPerfHint 从 usage.mjs import；scoreboard 就位后现算；拼在 computeHealthHints 结果尾部
  assert.match(rpc, /import \{ findRunLog, readLogBytes, readLogFrames, aggregateUsageSummary, readMainWindowUsage, buildScoreboard, modelPerfHint \} from '\.\/usage\.mjs'/)
  const iSb = rpc.indexOf('d.usageSummary.scoreboard = buildScoreboard(d.tasks, args && args.range')
  const iMph = rpc.indexOf('var __mph = modelPerfHint(d.usageSummary.scoreboard)')
  assert.ok(iSb >= 0 && iMph > iSb, 'modelPerfHint 必须在 scoreboard 挂载之后现算')
  assert.match(rpc, /d\.healthHints = __rh\.hints\.concat\(computeHealthHints\(d\.tasks\)\)\.concat\(__mph \? \[__mph\] : \[\]\)/)
  // usage.mjs：聚类规则表 / 聚类函数 / hint 阈值常量导出
  assert.match(usage, /export var REJECTION_CLUSTER_RULES = \[/)
  assert.match(usage, /export function clusterRejections\(texts\)/)
  assert.match(usage, /export function modelPerfHint\(sb\)/)
  assert.match(usage, /export var MODEL_HINT_MIN_RUNS = 10/)
  // index 兼容 re-export
  assert.match(idx, /clusterRejections, REJECTION_CLUSTER_RULES, modelPerfHint, MODEL_HINT_MIN_RUNS, MODEL_HINT_MIN_PASS, MODEL_HINT_EFF_GAP/)
  // client：组件 + 锚 id + 复制按钮 + 挂载在 QualityTrends 正下方
  assert.match(dash, /function RejectionClusters\(props\)/)
  assert.match(dash, /id: 'tskb-rejection-clusters'/)
  assert.match(dash, /navigator\.clipboard\.writeText\(text\)/)
  assert.ok(dash.indexOf('复制约定建议') >= 0)
  const iQt = dash.indexOf("React.createElement(QualityTrends, { sb: (state.usageSummary && state.usageSummary.scoreboard) || null })")
  const iRc = dash.indexOf("React.createElement(RejectionClusters, { sb: (state.usageSummary && state.usageSummary.scoreboard) || null })")
  assert.ok(iQt >= 0 && iRc > iQt, 'RejectionClusters 必须挂在 QualityTrends 正下方')
  // 产物重组装：关键标记在 lib/client.js
  for (const m of ['function RejectionClusters(props)', 'tskb-rejection-clusters', '复制约定建议', '暂无驳回记录']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
  // README 双份：逐字一致 + 含驳回聚类与荐模型 hint 说明
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('驳回聚类') >= 0, 'README 缺「驳回聚类」说明')
  assert.ok(r1.indexOf('workerModel') >= 0, 'README 缺荐模型 hint 说明')
})
