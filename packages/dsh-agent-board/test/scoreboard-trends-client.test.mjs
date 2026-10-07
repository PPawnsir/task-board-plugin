// dsh-agent-board — 记分卡卡4 client 质量趋势区单测（test/scoreboard-trends-client.test.mjs，task-muxhtgil）
// client 无渲染 harness（react 不在包依赖，渲染由 dsh web 客户端运行时注入）——与历卡同一纪律：
// 全部走源码级断言（dashboard.js 模块源 + client.js 重组装产物 + README 双份同步）。
//   ① 四块渲染——QualityTrends 组件 + 区根锚 id + 四块块名（一次通过率/卡时长分布/超时率走势/续跑成功率）
//     + 近 14 天固定窗口（lastNDays(14)）+ 时长四桶逐字 + 今日值标记
//   ② 范围联动——读 scoreboard.trends 裁剪后字段（firstPassByDay/durationBuckets/timeoutByDay/resume），
//     组件体内无 rpc(/fetchTasks(（不重拉）；「范围内: …」徽章与 Token/模型表现区同源（activeRange/rangeLabel）
//   ③ 空态——整区空态灰字（锚 id 照挂）+ 单块空态灰字；无样本日画灰基线不假装 0%
//   ④ caption 口径一句——看板派发 run 本体 + 驳回定义（验收 verdict rejected）
//   ⑤ 接线与产物——Dashboard 在 ModelPerf 正下方挂载 QualityTrends；client.js 已重组装；README 双份同步
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// 组件体切片（与 scoreboard-client.test.mjs 同一原语）：function <name> 到下一区段 banner 或下一顶级 function
function sliceFn(s, name) {
  const i = s.indexOf('function ' + name + '(')
  assert.ok(i >= 0, name + ' 必须存在')
  const jBanner = s.indexOf('\n    // =====', i + 1)
  const jFn = s.indexOf('\n    function ', i + 1)
  const j = [jBanner, jFn].filter(function (x) { return x > i }).sort(function (a, b) { return a - b })[0]
  return s.slice(i, j || undefined)
}

// ===== ① 四块渲染 =====
test('卡4①：四块——组件/锚 id/块名逐字/近 14 天窗口/时长四桶/今日值', () => {
  assert.match(src, /function QualityTrends\(props\)/)
  assert.match(src, /id: 'tskb-quality-trends'/)
  // 四块块名逐字
  for (const lb of ['一次通过率（近 14 天）', '卡时长分布', '超时率走势（近 14 天）', '续跑成功率']) {
    assert.ok(src.indexOf(lb) >= 0, '缺块名：' + lb)
  }
  // 近 14 天固定窗口（复用 Token 区 lastNDays 原语，最后一个是今天）
  assert.match(src, /var days14 = lastNDays\(14\)/)
  // 时长四桶键与标签逐字（<10m / 10-30m / 30-60m / >60m，与 host assembleScoreboard 四键一一对应）
  assert.match(src, /var QT_DUR_BUCKETS = \[/)
  for (const k of ["k: 'lt10m'", "k: 'm10to30'", "k: 'm30to60'", "k: 'gt60m'"]) assert.ok(src.indexOf(k) >= 0, '缺时长桶键：' + k)
  for (const lb2 of ["label: '<10m'", "label: '10-30m'", "label: '30-60m'", "label: '>60m'"]) assert.ok(src.indexOf(lb2) >= 0, '缺时长桶标签：' + lb2)
  // 今日值：① ③ 块头「今日」标值 + 今日柱高亮（isToday → C.brand）
  assert.ok(src.indexOf("'今日 '") >= 0, '缺块头今日值标记')
  assert.match(src, /var isToday = c\.k === todayKey/)
  // 迷你柱行通用画法：无样本日画 3px 灰基线（不假装 0%）
  assert.match(src, /function qtDayBars\(cells, color, todayKey\)/)
  assert.match(src, /c\.rate === null \? 3 : Math\.max\(4, Math\.round\(c\.rate \* 34\)\)/)
})

// ===== ② 范围联动（读裁剪后字段，不重拉）=====
test('卡4②：范围联动——读 scoreboard.trends 裁剪后字段；组件零 rpc/fetchTasks；范围内徽章同源', () => {
  const body = sliceFn(src, 'QualityTrends')
  // 读裁剪后字段逐字（host 已按 range 裁剪，client 只渲染）
  assert.match(body, /tr\.firstPassByDay/)
  assert.match(body, /tr\.durationBuckets/)
  assert.match(body, /tr\.timeoutByDay/)
  assert.match(body, /tr\.resume/)
  // 不重拉硬断言：组件体内不得出现 rpc( / fetchTasks(
  assert.ok(!/\brpc\(/.test(body), 'QualityTrends 不得自持 rpc（不重拉）')
  assert.ok(!/fetchTasks\(/.test(body), 'QualityTrends 不得触发重拉')
  // 范围内徽章：与 Token/模型表现区同源（activeRange + rangeLabel）
  assert.match(body, /var tg = activeRange\(\)/)
  assert.match(body, /'范围内: ' \+ rangeLabel\(\)/)
  // 数据源接线：props.sb = usageSummary.scoreboard（与模型表现区同一出参）
  assert.match(src, /React\.createElement\(QualityTrends, \{ sb: \(state\.usageSummary && state\.usageSummary\.scoreboard\) \|\| null \}\)/)
})

// ===== ③ 空态灰显 =====
test('卡4③：空态——整区空态灰字（锚 id 照挂）+ 四块单块空态灰字', () => {
  // 整区：trends 缺字段（老 host）/ 四块皆无数据 → 一句灰字，锚 id 照挂
  assert.match(src, /if \(!tr \|\| \(fpSum \+ toSum \+ durSum \+ rsmRuns\) === 0\)/)
  assert.ok(src.indexOf('暂无足够 run 数据（还没有可统计的已落定 Worker/Verifier run / resolved 任务）') >= 0)
  // 单块空态灰字逐字
  for (const lb of ['近 14 天窗口内暂无 resolved 任务落定', '暂无时长样本', '近 14 天窗口内暂无 run 落定', '暂无续跑记录']) {
    assert.ok(src.indexOf(lb) >= 0, '缺单块空态：' + lb)
  }
  // 率类 null 不假装 0%：mpPct(null) → '—'
  assert.match(src, /rate: resolved \? firstPass \/ resolved : null/)
  assert.match(src, /rate: runs \? timeouts \/ runs : null/)
})

// ===== ④ caption 口径一句 =====
test('卡4④：caption——看板派发 run 本体 + 驳回定义（验收 verdict rejected）+ 固定窗口说明', () => {
  assert.ok(src.indexOf('口径：仅看板派发的 Worker/Verifier run 与任务落定记录') >= 0, '缺 caption 口径句')
  assert.ok(src.indexOf('驳回 = 验收 verdict rejected') >= 0, 'caption 缺驳回定义')
  assert.ok(src.indexOf('近 14 天固定窗口') >= 0, 'caption 缺固定窗口说明')
})

// ===== ⑤ 接线与产物 =====
test('卡4⑤：接线——Dashboard 挂载在 ModelPerf 正下方；产物已重组装；README 双份同步', () => {
  const iMp = src.indexOf("React.createElement(ModelPerf, { sb: (state.usageSummary && state.usageSummary.scoreboard) || null })")
  const iQt = src.indexOf("React.createElement(QualityTrends, { sb: (state.usageSummary && state.usageSummary.scoreboard) || null })")
  assert.ok(iMp >= 0, 'ModelPerf 挂载点必须存在')
  assert.ok(iQt > iMp, 'QualityTrends 必须挂在 ModelPerf 正下方')
  // 产物重组装：模块源关键标记逐一出现在 lib/client.js
  for (const m of ['function QualityTrends(props)', 'function qtDayBars(', 'tskb-quality-trends', 'var QT_DUR_BUCKETS = [', '一次通过率（近 14 天）', '超时率走势（近 14 天）', '续跑成功率', '暂无续跑记录']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
  // README 双份：根 README 与包 README 逐字一致 + 含「质量趋势」区说明
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('质量趋势') >= 0, 'README 仪表盘段缺「质量趋势」区说明')
})
