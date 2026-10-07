// dsh-agent-board — 记分卡卡2 host 聚合底座单测（test/scoreboard.test.mjs，task-muxhtgh9）
// 覆盖（对应任务断言①~⑥ + 接线）：
//   ① 七指标各一条数值正确性——模型×角色×规模段桶：有效token(均值+总额)/耗时(中位+P90)/驳回率/
//     一次通过率/超时率/续跑率/缓存命中率
//   ② 样本不足标记——桶内 runs<5 标 insufficient:true；恰好 5 条不标
//   ③ 趋势 rollup byDay 正确——一次通过率 byDay / 卡时长四桶 / 超时率走势 byDay / 续跑成功率
//   ④ 增量缓存命中零重算——(taskCount, 最新落定时刻) 不变时改字段值结果逐字不变；新 run 落地即重算
//   ⑤ 范围裁剪——与 usageSummary 同一 range 口径（run 日落点两端闭区间）；空范围=无范围（parity）
//   ⑥ 老数据缺字段退化不炸——无 model/endedAt/usage/runs/messages 各形态 + fs 全炸纯函数照跑
//   ⑦ host 接线（源码级）——get-tasks 挂载 scoreboard / 缓存并列在 state / index 兼容 re-export
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import { buildScoreboard, SCOREBOARD_MIN_SAMPLE } from '../index.mjs'
import { localDayKey } from '../lib/usage.mjs'

// 本地构造时刻 → ISO 串（round-trip 经 dayKeyOf 仍落原本地日，与机器时区无关）
function isoOf(y, m, d, h, mi) { return new Date(y, m - 1, d, h, mi || 0, 0).toISOString() }
function dayOf(y, m, d) { return localDayKey(new Date(y, m - 1, d, 12)) }
function U(inp, outp, cr, cw) { return { input: inp, output: outp, cacheRead: cr, cacheWrite: cw, total: inp + outp + cr + cw } }

const D0 = dayOf(2026, 10, 5) // 老卡/跨天日
const D1 = dayOf(2026, 10, 6) // 主场景日

// 标准夹具（每次调用全新对象——测试间互不污染）：
//   tA：resolved 一次通过（rejectCount 缺省）；runs = w1(worker m/a, d1 10min) + v1(verifier m/v, 5min)
//   tB：resolved 被驳过一次（rejectCount 1，驳回消息 d1 11:45 归因 w2）；runs = w2(timeout 30min) + w3(resume completed 5min)
//   tC：老卡（direct 档直落 resolvedAt；run 无 model/endedAt/usage；usage 只有 total → 规模兜底 small）
//   tD：pending 无 runs 无 usage（零贡献不炸）
function mkTasks() {
  return [
    {
      id: 'tA', title: 'A', status: 'resolved', createdAt: isoOf(2026, 10, 6, 9), verifiedAt: isoOf(2026, 10, 6, 13),
      usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, total: 1160 }, // 有效 160 → small
      runs: [
        { role: 'worker', id: 'w1', at: isoOf(2026, 10, 6, 10), endedAt: isoOf(2026, 10, 6, 10, 10), model: 'm/a', outcome: 'completed', usage: U(100, 50, 1000, 10) },
        { role: 'verifier', id: 'v1', at: isoOf(2026, 10, 6, 10, 20), endedAt: isoOf(2026, 10, 6, 10, 25), model: 'm/v', outcome: 'completed', usage: U(50, 20, 500, 5) },
      ],
    },
    {
      id: 'tB', title: 'B', status: 'resolved', createdAt: isoOf(2026, 10, 5, 22), verifiedAt: isoOf(2026, 10, 6, 14),
      rejectCount: 1,
      messages: [{ kind: 'rejection', text: '验收驳回 · 自测没过', at: isoOf(2026, 10, 6, 11, 45), by: 'v2' }],
      usage: { input: 300, output: 150, cacheRead: 3000, cacheWrite: 30, total: 3480 }, // 有效 480 → small
      runs: [
        { role: 'worker', id: 'w2', at: isoOf(2026, 10, 6, 11), endedAt: isoOf(2026, 10, 6, 11, 30), model: 'm/a', outcome: 'timeout/error', usage: U(200, 100, 3000, 20) },
        { role: 'worker', id: 'w3', at: isoOf(2026, 10, 6, 12), endedAt: isoOf(2026, 10, 6, 12, 5), model: 'm/a', outcome: 'completed', resume: true, usage: U(100, 50, 0, 10) },
      ],
    },
    {
      id: 'tC', title: 'C', status: 'resolved', createdAt: isoOf(2026, 10, 5, 17, 50), resolvedAt: isoOf(2026, 10, 5, 18),
      usage: { total: 500, updatedAt: isoOf(2026, 10, 5, 18) }, // 老形态只有 total → 兜底 small
      runs: [{ role: 'worker', id: 'old-1', at: isoOf(2026, 10, 5, 9), outcome: 'completed' }], // 无 model/endedAt/usage
    },
    { id: 'tD', title: 'D', status: 'pending' },
  ]
}
function bucketOf(sb, model, role, size) {
  const b = sb.buckets.filter(function (x) { return x.model === model && x.role === role && x.size === size })
  return b.length ? b[0] : null
}

// ===== ① 七指标数值正确性 =====
test('卡2①：七指标——m/a×worker×small 桶逐条数值核对（有效token/耗时/驳回率/一次通过率/超时率/续跑率/缓存命中率）', () => {
  const sb = buildScoreboard(mkTasks())
  const b = bucketOf(sb, 'm/a', 'worker', 'small')
  assert.ok(b, 'm/a|worker|small 桶必须存在')
  assert.equal(b.runs, 3) // w1 + w2 + w3（老 run 无模型不进桶）
  // ① 有效 token：总额 160+320+160=640，均值 round(640/3)=213
  assert.equal(b.effSum, 640)
  assert.equal(b.effAvg, 213)
  // ② 耗时：durs [600000, 1800000, 300000] → 中位 600000（10min），P90 最近秩 = 1800000（30min）
  assert.equal(b.durMedianMs, 600000)
  assert.equal(b.durP90Ms, 1800000)
  // ③ 驳回率：tB 驳回消息 11:45 归因到 w2（11:00 ≤ 11:45 < w3 12:00）→ 1/3
  assert.equal(b.rejected, 1)
  assert.equal(b.rejectRate, 1 / 3)
  // ④ 一次通过率：桶内 resolved = tA + tB；tA rejectCount 缺省=0 → firstPass 1/2
  assert.equal(b.resolved, 2)
  assert.equal(b.firstPass, 1)
  assert.equal(b.firstPassRate, 0.5)
  // ⑤ 超时率：w2 outcome='timeout/error' → 1/3
  assert.equal(b.timeouts, 1)
  assert.equal(b.timeoutRate, 1 / 3)
  // ⑥ 续跑率：w3 resume:true → 1/3
  assert.equal(b.resumes, 1)
  assert.equal(b.resumeRate, 1 / 3)
  // ⑦ 缓存命中率：cr 1000+3000+0=4000 / (inp 400 + cr 4000) = 4000/4400
  assert.ok(Math.abs(b.cacheHitRate - 4000 / 4400) < 1e-12)
  assert.equal(b.insufficient, true) // 3 < 5 → 样本护栏
  // verifier 桶同轮核对（角色分桶 + 一次通过率按桶归属：tA 在 m/v 桶也是 firstPass）
  const bv = bucketOf(sb, 'm/v', 'verifier', 'small')
  assert.ok(bv, 'm/v|verifier|small 桶必须存在')
  assert.equal(bv.runs, 1)
  assert.equal(bv.effSum, 75)
  assert.equal(bv.durMedianMs, 300000)
  assert.equal(bv.durP90Ms, 300000) // 单样本 P90=自身
  assert.equal(bv.rejected, 0)
  assert.equal(bv.firstPassRate, 1)
  assert.equal(bv.timeoutRate, 0)
  assert.equal(bv.resumeRate, 0)
  assert.ok(Math.abs(bv.cacheHitRate - 500 / 550) < 1e-12)
  assert.equal(bv.insufficient, true)
  // meta 诊断：老 run 缺模型如实计数，不硬塞桶
  assert.equal(sb.meta.tasks, 4)
  assert.equal(sb.meta.runsSettled, 5)
  assert.equal(sb.meta.bucketed, 4)
  assert.equal(sb.meta.noModel, 1)
  assert.equal(sb.meta.noSize, 0)
  assert.equal(sb.meta.roleOther, 0)
  assert.equal(sb.meta.rejUnattributed, 0)
  // 排序稳定：有效总额降序（m/a 640 在 m/v 75 前）
  assert.equal(sb.buckets[0].model, 'm/a')
  assert.equal(sb.buckets[1].model, 'm/v')
})

// ===== ② 样本不足标记边界 =====
test('卡2②：样本护栏——桶内恰好 5 条不标 insufficient，4 条标', () => {
  assert.equal(SCOREBOARD_MIN_SAMPLE, 5)
  function mkN(n) {
    const runs = []
    for (let i = 0; i < n; i++) {
      runs.push({ role: 'worker', id: 'r' + i, at: isoOf(2026, 10, 6, 10, i), endedAt: isoOf(2026, 10, 6, 10, i + 1), model: 'm/b', outcome: 'completed', usage: U(10, 10, 0, 0) })
    }
    return [{ id: 'tE', status: 'resolved', createdAt: isoOf(2026, 10, 6, 9), verifiedAt: isoOf(2026, 10, 6, 11), usage: { input: 10 * n, output: 10 * n, cacheWrite: 0, total: 20 * n }, runs: runs }]
  }
  const b5 = bucketOf(buildScoreboard(mkN(5)), 'm/b', 'worker', 'small')
  assert.equal(b5.runs, 5)
  assert.equal(b5.insufficient, false)
  const b4 = bucketOf(buildScoreboard(mkN(4)), 'm/b', 'worker', 'small')
  assert.equal(b4.runs, 4)
  assert.equal(b4.insufficient, true)
})

// ===== ③ 趋势 rollup byDay =====
test('卡2③：全局趋势——一次通过率 byDay / 卡时长四桶 / 超时率走势 byDay / 续跑成功率', () => {
  const sb = buildScoreboard(mkTasks())
  const tr = sb.trends
  // 一次通过率 byDay（resolved 任务按落定日；rejectCount=0 计 firstPass）：
  //   D0: tC（resolvedAt 直落，rejectCount 缺省）→ 1/1；D1: tA(过) + tB(驳过) → 1/2
  assert.deepEqual(tr.firstPassByDay[D0], { resolved: 1, firstPass: 1 })
  assert.deepEqual(tr.firstPassByDay[D1], { resolved: 2, firstPass: 1 })
  // 卡时长分布（createdAt→落定）：tA 4h 与 tB 16h → gt60m；tC 10min 整 → m10to30（含端归中同哲学）
  assert.deepEqual(tr.durationBuckets, { lt10m: 0, m10to30: 1, m30to60: 0, gt60m: 2 })
  // 超时率走势 byDay（run.at 日落点，全角色全模型）：D1 四 run 1 超时；D0 老 run 1 条 0 超时
  assert.deepEqual(tr.timeoutByDay[D1], { runs: 4, timeout: 1 })
  assert.deepEqual(tr.timeoutByDay[D0], { runs: 1, timeout: 0 })
  // 续跑成功率：w3 resume 且 completed → 1/1
  assert.deepEqual(tr.resume, { runs: 1, completed: 1, rate: 1 })
})

// ===== ④ 增量缓存命中零重算 =====
test('卡2④：增量缓存——(taskCount, 最新落定时刻) 不变命中即零重算；新 run 落地戳变即重算', () => {
  const slot = {}
  const tasks = mkTasks()
  const r1 = buildScoreboard(tasks, null, slot)
  assert.ok(slot.recs, '首轮后缓存槽应持有归一化记录')
  // 命中证明：改掉 w1 的 model 与 tA 的 title（不改任何时间戳、不加任务）——
  // 若提取层重算，桶键会变成 m/changed；结果逐字不变 = 零重算的硬证据
  tasks[0].title = 'A（改名）'
  tasks[0].runs[0].model = 'm/changed'
  const r2 = buildScoreboard(tasks, null, slot)
  assert.deepEqual(r2, r1)
  assert.equal(bucketOf(r2, 'm/a', 'worker', 'small').runs, 3)
  assert.equal(slot.recs.runRecs[0].model, 'm/a') // 缓存记录保持旧值（命中未重扫）
  // 范围请求同样吃缓存（裁剪在装配层现算，不触发重提取）
  const r2r = buildScoreboard(tasks, { from: D1, to: D1 }, slot)
  assert.equal(bucketOf(r2r, 'm/a', 'worker', 'small').runs, 3)
  // 新 run 落地（时间戳前进）→ 戳变 → 重算反映新数据（w1 此时已是 m/changed → 也如实分桶）
  const slot2 = {}
  const tasks2 = mkTasks()
  const r3 = buildScoreboard(tasks2, null, slot2)
  tasks2[0].runs.push({ role: 'worker', id: 'w4', at: isoOf(2026, 10, 6, 15), endedAt: isoOf(2026, 10, 6, 15, 10), model: 'm/a', outcome: 'completed', usage: U(10, 10, 0, 0) })
  const r4 = buildScoreboard(tasks2, null, slot2)
  const b4 = bucketOf(r4, 'm/a', 'worker', 'small')
  assert.equal(b4.runs, 4)
  assert.equal(b4.effSum, 660)
  assert.equal(b4.effAvg, 165)
  assert.ok(!deepEq(r4, r3), '时间戳前进后必须重算，不得复用旧结果')
  // 无 cacheStore（undefined）兜底：每次全量提取，不炸
  assert.equal(bucketOf(buildScoreboard(mkTasks()), 'm/a', 'worker', 'small').runs, 3)
})
function deepEq(a, b) { try { assert.deepEqual(a, b); return true } catch (_) { return false } }

// ===== ⑤ 范围裁剪 =====
test('卡2⑤：范围裁剪——run 日落点两端闭区间；驳回随被裁 run 一起裁；空范围=无范围（parity）', () => {
  const slot = {}
  const tasks = mkTasks()
  // 只留 D1：桶不变（w1/v1/w2/w3 全在 D1）；老 run（D0）被裁 → bucketed 4→4、noModel 0
  const r1 = buildScoreboard(tasks, { from: D1, to: D1 }, slot)
  assert.equal(bucketOf(r1, 'm/a', 'worker', 'small').runs, 3)
  assert.equal(bucketOf(r1, 'm/a', 'worker', 'small').rejected, 1) // 驳回的 rDay=D1 在范围内
  assert.equal(r1.meta.noModel, 0) // D0 老 run 被裁后不再计入诊断
  assert.deepEqual(r1.trends.firstPassByDay, { [D1]: { resolved: 2, firstPass: 1 } }) // tC（D0 落定）被裁
  assert.deepEqual(r1.trends.durationBuckets, { lt10m: 0, m10to30: 0, m30to60: 0, gt60m: 2 })
  assert.deepEqual(r1.trends.timeoutByDay, { [D1]: { runs: 4, timeout: 1 } })
  assert.deepEqual(r1.trends.resume, { runs: 1, completed: 1, rate: 1 })
  // 只留 D0：m/a 桶整条消失（桶内 run 全在 D1）；老 run 无模型 → buckets 空
  const r0 = buildScoreboard(tasks, { from: D0, to: D0 }, slot)
  assert.equal(r0.buckets.length, 0)
  assert.deepEqual(r0.trends.firstPassByDay, { [D0]: { resolved: 1, firstPass: 1 } })
  assert.deepEqual(r0.trends.durationBuckets, { lt10m: 0, m10to30: 1, m30to60: 0, gt60m: 0 })
  assert.deepEqual(r0.trends.timeoutByDay, { [D0]: { runs: 1, timeout: 0 } })
  assert.deepEqual(r0.trends.resume, { runs: 0, completed: 0, rate: null }) // w3（D1）被裁
  // 空范围与不传等价（parity，与 aggregateUsageSummary 同一约定）
  const all = buildScoreboard(tasks, null, slot)
  assert.deepEqual(buildScoreboard(tasks, { from: '', to: '' }, slot), all)
  // 缓存里存的是未裁剪归一化记录：范围请求之后再读全量仍正确（裁剪不毁缓存）
  assert.equal(bucketOf(buildScoreboard(tasks, null, slot), 'm/a', 'worker', 'small').runs, 3)
})

// ===== ⑥ 老数据缺字段退化不炸 + 纯函数零 IO =====
test('卡2⑥：老数据退化——无 outcome/无 at/无 runs/无 messages/脏条目 全形态不炸，如实计数不伪造', () => {
  const junk = [
    null, 'garbage', // 脏任务条目
    { id: 'j1', runs: [{ role: 'worker', id: 'r-fly', at: isoOf(2026, 10, 6, 8), outcome: 'running' }] }, // 在飞：不算缺字段，不进指标
    { id: 'j2', runs: [{ role: 'worker', id: 'r-noat', outcome: 'completed', model: 'm/c' }] }, // 无 at：进桶（无范围）但不进 byDay
    { id: 'j3', messages: [{ kind: 'rejection', text: 'x', at: isoOf(2026, 10, 6, 9) }] }, // 有驳回无 runs → 归因 null
    { id: 'j4', runs: 'not-an-array', messages: { 0: 'x' } }, // 字段形态全错
    { id: 'j5', status: 'resolved' }, // resolved 但无落定时刻/createdAt → resolvedDay '' 卡时长 null
  ]
  const sb = buildScoreboard(junk)
  assert.equal(sb.meta.runsSettled, 1) // 只有 r-noat 已落定
  assert.equal(sb.meta.rejUnattributed, 1) // j3 的驳回无 run 可归
  const b = bucketOf(sb, 'm/c', 'worker', 'small') // j2 无 usage → 规模不可知？不对——无 usage 任务 size=null
  assert.equal(b, null) // j2 任务无 usage → size null → 不进桶（noSize=1）
  assert.equal(sb.meta.noSize, 1)
  assert.deepEqual(sb.trends.timeoutByDay, {}) // 无 at → 无日落点 → 不进 byDay
  assert.deepEqual(sb.trends.resume, { runs: 0, completed: 0, rate: null })
  assert.deepEqual(sb.trends.firstPassByDay, {}) // j5 resolvedDay '' 不入 byDay
  // 范围下同样不炸（无日落点的已落定 run 被裁，宁可漏不错）
  const sr = buildScoreboard(junk, { from: D1, to: D1 })
  assert.equal(sr.meta.runsSettled, 1)
  assert.equal(sr.buckets.length, 0)
  // 纯函数零 IO：fs 门面全部打爆后照跑（与卡1④同一纪律）
  const orig = {}
  for (const k of ['readFileSync', 'readdirSync', 'statSync', 'openSync', 'readSync', 'existsSync']) {
    orig[k] = fs[k]
    fs[k] = function () { throw new Error('IO 触碰：' + k) }
  }
  try {
    const b2 = bucketOf(buildScoreboard(mkTasks()), 'm/a', 'worker', 'small')
    assert.equal(b2.runs, 3)
    assert.equal(b2.effSum, 640)
  } finally {
    for (const k2 of Object.keys(orig)) fs[k2] = orig[k2]
  }
})

// ===== ⑦ host 接线（源码级断言）=====
test('卡2⑦：接线——get-tasks 挂载 scoreboard / 缓存并列在 state / index 兼容 re-export / 纯 host 不碰 client', () => {
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  const usage = readFileSync(new URL('../lib/usage.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  // get-tasks：scoreboard 挂在 usageSummary 上（聚合之后），带同一 range 口径 + 增量缓存槽
  const iAgg = rpc.indexOf('d.usageSummary = aggregateUsageSummary(d.tasks, args && args.range)')
  const iSb = rpc.indexOf('d.usageSummary.scoreboard = buildScoreboard(d.tasks, args && args.range')
  assert.ok(iAgg >= 0 && iSb > iAgg, 'scoreboard 必须在 aggregateUsageSummary 之后挂载')
  assert.match(rpc, /state\.scoreboardCache\[sid\] \|\| \(state\.scoreboardCache\[sid\] = \{\}\)/)
  assert.match(rpc, /if \(!state\.scoreboardCache\) state\.scoreboardCache = \{\}/) // 测试桩就地补（与 mainWindowUsageCache 同例）
  // 缓存本体在共享 state（与 mainWindow 尾读缓存并列）
  assert.match(idx, /scoreboardCache: \{\}/)
  // 聚合本体在 usage.mjs；样本护栏常量导出
  assert.match(usage, /export function buildScoreboard\(tasks, range, cacheStore\)/)
  assert.match(usage, /export var SCOREBOARD_MIN_SAMPLE = 5/)
  // 兼容 re-export：单测与卡3 客户端对接从 index.mjs 直取
  assert.match(idx, /buildScoreboard, SCOREBOARD_MIN_SAMPLE/)
  // 范围裁剪复用同一 dayInRange/rangeOn（与 usageSummary 同一 range 口径的硬保证）
  assert.match(usage, /dayInRange\(q\.day, range\)/)
})
