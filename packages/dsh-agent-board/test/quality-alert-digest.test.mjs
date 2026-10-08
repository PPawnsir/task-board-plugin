// dsh-agent-board — 异常驱动审视②③：质量异动告警 + 报告导出批次 digest 单测（test/quality-alert-digest.test.mjs，task-muysyad1）
// 覆盖（对应任务断言①~④ + 接线）：
//   ② 质量异动告警 qualityChangeHints（scoreboard.trends 环比）
//     ① 阈值边界——一次通过率恰好 10pp 跌不亮 / 10.1pp 跌亮
//     ② 样本不足——任一侧 <5 不亮（即便跌幅巨大）；恰好 5/5 判
//     ③ 超时率/驳回率突变同构各一条（涨 >10pp 亮）；三条同命全出；empty/null/脏输入全形态不炸
//   ③ 报告导出 buildReport「## 批次摘要（近 24 小时）」段（client 无渲染 harness，源码级断言）：
//     字段齐全 + 无数据优雅空态 + 产物重组装
//   ④ 接线 + README 双份——usage/rpc/index 挂 qualityChangeHints + rejectByDay + README 各补一句
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { qualityChangeHints, QUALITY_CHANGE_PP, QUALITY_MIN_SAMPLE, QUALITY_WINDOW_DAYS } from '../index.mjs'
import { localDayKey } from '../lib/usage.mjs'

// 固定「今天」= 2026-10-30 12:00（本地）：近 7 天 = 10-24..10-30，再前 7 天 = 10-17..10-23
const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime()
function dayOf(y, m, d) { return localDayKey(new Date(y, m - 1, d, 12)) }
const NEAR = dayOf(2026, 10, 30)  // 近窗口某日
const PRIOR = dayOf(2026, 10, 20) // 前窗口某日

// ===== ②① 阈值边界 =====
test('②① 阈值边界：一次通过率恰好 10pp 跌不亮 / 10.1pp 跌亮（常量置顶核对）', () => {
  assert.equal(QUALITY_CHANGE_PP, 10)
  assert.equal(QUALITY_MIN_SAMPLE, 5)
  assert.equal(QUALITY_WINDOW_DAYS, 7)
  // 恰好 10pp：近 90%（900/1000）vs 前 100%（1000/1000）→ drop 10.0pp → 不亮
  const exact = { trends: { firstPassByDay: { [NEAR]: { resolved: 1000, firstPass: 900 }, [PRIOR]: { resolved: 1000, firstPass: 1000 } }, timeoutByDay: {}, rejectByDay: {} } }
  assert.deepEqual(qualityChangeHints(exact, NOW), [])
  // 10.1pp：近 89.9%（899/1000）vs 前 100% → drop 10.1pp → 亮，文案逐字核对
  const over = { trends: { firstPassByDay: { [NEAR]: { resolved: 1000, firstPass: 899 }, [PRIOR]: { resolved: 1000, firstPass: 1000 } }, timeoutByDay: {}, rejectByDay: {} } }
  const h = qualityChangeHints(over, NOW)
  assert.equal(h.length, 1)
  assert.equal(h[0].level, 'warn')
  assert.match(h[0].text, /质量异动：一次通过率本周 90%（上周 100%），建议抽查近期验收/)
})

// ===== ②② 样本不足 =====
test('②② 样本不足：任一侧 <5 不亮（即便 0% vs 100%）；恰好 5/5 判', () => {
  // 双侧皆 4（<5）→ 不亮
  const s = { trends: { firstPassByDay: { [NEAR]: { resolved: 4, firstPass: 0 }, [PRIOR]: { resolved: 4, firstPass: 4 } }, timeoutByDay: {}, rejectByDay: {} } }
  assert.deepEqual(qualityChangeHints(s, NOW), [])
  // 仅一侧不足（近 5 / 前 4）→ 不亮
  const s2 = { trends: { firstPassByDay: { [NEAR]: { resolved: 5, firstPass: 0 }, [PRIOR]: { resolved: 4, firstPass: 4 } }, timeoutByDay: {}, rejectByDay: {} } }
  assert.deepEqual(qualityChangeHints(s2, NOW), [])
  // 恰好 5/5 且大幅跌 → 亮（护栏边界：恰好 5 判，非 5 不判）
  const s3 = { trends: { firstPassByDay: { [NEAR]: { resolved: 5, firstPass: 0 }, [PRIOR]: { resolved: 5, firstPass: 5 } }, timeoutByDay: {}, rejectByDay: {} } }
  assert.equal(qualityChangeHints(s3, NOW).length, 1)
})

// ===== ②③ 超时率/驳回率同构 + 空形态 =====
test('②③ 超时率/驳回率突变同构各一条 + 三规则同命全出 + empty/null/脏输入不炸', () => {
  // 超时率涨：近 20%（20/100）vs 前 5%（5/100）→ 涨 15pp → 亮
  const to = { trends: { firstPassByDay: {}, timeoutByDay: { [NEAR]: { runs: 100, timeout: 20 }, [PRIOR]: { runs: 100, timeout: 5 } }, rejectByDay: {} } }
  const ht = qualityChangeHints(to, NOW)
  assert.equal(ht.length, 1)
  assert.match(ht[0].text, /质量异动：超时率本周 20%（上周 5%），建议排查派发\/超时链路/)
  // 驳回率涨：近 20 次驳回 / 前 5 次（分母 runs 各 100）→ 涨 15pp → 亮
  const rj = { trends: { firstPassByDay: {}, timeoutByDay: { [NEAR]: { runs: 100, timeout: 0 }, [PRIOR]: { runs: 100, timeout: 0 } }, rejectByDay: { [NEAR]: { rejects: 20 }, [PRIOR]: { rejects: 5 } } } }
  const hr = qualityChangeHints(rj, NOW)
  assert.equal(hr.length, 1)
  assert.match(hr[0].text, /质量异动：驳回率本周 20%（上周 5%），建议审查近期驳回原因/)
  // 三条规则同时命中 → 三条全出（一次通过率 + 超时率 + 驳回率）
  const all3 = { trends: { firstPassByDay: { [NEAR]: { resolved: 100, firstPass: 0 }, [PRIOR]: { resolved: 100, firstPass: 100 } }, timeoutByDay: { [NEAR]: { runs: 100, timeout: 50 }, [PRIOR]: { runs: 100, timeout: 0 } }, rejectByDay: { [NEAR]: { rejects: 50 }, [PRIOR]: { rejects: 0 } } } }
  assert.equal(qualityChangeHints(all3, NOW).length, 3)
  // empty/null/脏输入全形态不炸（老 host 缺 trends / rejectByDay 等）
  assert.deepEqual(qualityChangeHints(null, NOW), [])
  assert.deepEqual(qualityChangeHints({}, NOW), [])
  assert.deepEqual(qualityChangeHints({ trends: {} }, NOW), [])
  assert.deepEqual(qualityChangeHints({ trends: 'garbage' }, NOW), [])
  assert.deepEqual(qualityChangeHints({ buckets: [] }, NOW), [])
  // 缺 rejectByDay（老 host）只有超时率规则可判，驳回率规则静默跳过不炸
  const noRj = { trends: { firstPassByDay: {}, timeoutByDay: { [NEAR]: { runs: 100, timeout: 30 }, [PRIOR]: { runs: 100, timeout: 0 } } } }
  const hnr = qualityChangeHints(noRj, NOW)
  assert.equal(hnr.length, 1)
  assert.match(hnr[0].text, /质量异动：超时率本周/)
})

// ===== ③ 报告导出「批次摘要」段（源码级）=====
test('③ 报告段：buildReport「## 批次摘要（近 24 小时）」字段齐全 + 无数据优雅空态 + 产物重组装', () => {
  const dash = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 段标题 + 五字段（完成/驳回/Token/异常事件/质量趋势）+ 无数据优雅空态
  assert.ok(dash.indexOf('## 批次摘要（近 24 小时）') >= 0, '报告缺批次摘要段标题')
  assert.ok(dash.indexOf('- 完成：') >= 0, '缺「完成」字段')
  assert.ok(dash.indexOf('- 驳回：') >= 0, '缺「驳回」字段')
  assert.ok(dash.indexOf('- Token：约 ') >= 0, '缺「Token」字段')
  assert.ok(dash.indexOf('- 异常事件：超时 ') >= 0, '缺「异常事件」字段')
  assert.ok(dash.indexOf('· 幽灵回收 ') >= 0, '缺「幽灵回收」字段')
  assert.ok(dash.indexOf('- 质量趋势：') >= 0, '缺「质量趋势」字段')
  assert.ok(dash.indexOf('近 24 小时无活动记录（无完成 / 驳回 / 消耗 / 异常事件）') >= 0, '缺无数据优雅空态')
  assert.ok(dash.indexOf('function batchDigest()') >= 0, '缺 batchDigest 数据源')
  // 纯聚合现有字段（不新建 host 状态、不重拉）：run 级 token 现算 + healthHints 读幽灵回收
  assert.match(dash, /r\.usage && typeof r\.usage === 'object'/)
  assert.ok(dash.indexOf('本轮回收') >= 0, '缺幽灵回收 healthHints 读取')
  // 产物重组装：关键标记逐一出现在 lib/client.js
  for (const m of ['## 批次摘要（近 24 小时）', '近 24 小时无活动记录', 'function batchDigest()']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})

// ===== ④ 接线 + README 双份 =====
test('④ 接线：usage/rpc/index 挂 qualityChangeHints + rejectByDay；README 双份逐字一致 + 各补一句', () => {
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  const usage = readFileSync(new URL('../lib/usage.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  // usage.mjs：质量异动常量置顶 + 函数 + rejectByDay 数据源
  assert.match(usage, /export var QUALITY_CHANGE_PP = 10/)
  assert.match(usage, /export var QUALITY_MIN_SAMPLE = 5/)
  assert.match(usage, /export var QUALITY_WINDOW_DAYS = 7/)
  assert.match(usage, /export function qualityChangeHints\(sb, now\)/)
  assert.match(usage, /rejectByDay: \{\}/)
  assert.match(usage, /tr\.rejectByDay\[rcj\.mDay\]/)
  // rpc：import + healthHints 拼 qualityChangeHints（scoreboard 就位后现算，在 modelPerfHint 之后）
  assert.match(rpc, /modelPerfHint, qualityChangeHints \} from '\.\/usage\.mjs'/)
  const iQch = rpc.indexOf('var __qch = qualityChangeHints(d.usageSummary.scoreboard)')
  const iMph = rpc.indexOf('var __mph = modelPerfHint(d.usageSummary.scoreboard)')
  assert.ok(iQch >= 0 && iMph >= 0 && iQch > iMph, 'qualityChangeHints 必须在 modelPerfHint 之后现算')
  assert.match(rpc, /d\.healthHints = __rh\.hints\.concat\(computeHealthHints\(d\.tasks\)\)\.concat\(__qch\)\.concat\(__mph \? \[__mph\] : \[\]\)/)
  // index 兼容 re-export
  assert.match(idx, /qualityChangeHints, QUALITY_CHANGE_PP, QUALITY_MIN_SAMPLE, QUALITY_WINDOW_DAYS/)
  // README 双份：逐字一致 + 各补一句（质量异动 / 批次摘要）
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('质量异动') >= 0, 'README 缺「质量异动」说明')
  assert.ok(r1.indexOf('批次摘要') >= 0, 'README 缺「批次摘要」说明')
})
