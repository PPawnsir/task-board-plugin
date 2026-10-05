// dsh-agent-board — 架构自省 L1 单测（test/health.test.mjs）
// 覆盖：四信号命中/不命中、窗口边界（近 50 张卡）、空板、提示上限 3 条。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeHealthHints } from '../lib/health.mjs'

var MIN = 60000
var BASE = Date.parse('2026-01-01T00:00:00.000Z')
function iso(ms) { return new Date(ms).toISOString() }

// 造卡：i 决定 createdAt（i 越大越新），extra 覆盖字段
function mk(i, extra) {
  var t = { id: 't' + i, createdAt: iso(BASE + i * MIN), status: 'resolved', touches: [], claimedAt: null, resolvedAt: null, rejectCount: 0 }
  return Object.assign(t, extra || {})
}

// ===== 空板 / 非法输入 =====
test('空板与非法输入返回 []', function () {
  assert.deepEqual(computeHealthHints([]), [])
  assert.deepEqual(computeHealthHints(undefined), [])
  assert.deepEqual(computeHealthHints(null), [])
})

// ===== 信号 a：touches 声明热度 =====
test('信号 a 命中：单路径 ≥8 次且占比 ≥40% → warn', function () {
  var ts = []
  for (var i = 0; i < 10; i++) ts.push(mk(i, { touches: ['src/big.js'], claimedAt: iso(BASE + i * MIN + 1 * MIN), resolvedAt: iso(BASE + i * MIN + 2 * MIN) }))
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.equal(hints[0].level, 'warn')
  assert.ok(hints[0].text.indexOf('src/big.js') >= 0)
  assert.ok(hints[0].text.indexOf('10 次声明 touches') >= 0)
  assert.ok(hints[0].text.indexOf('占比 100%') >= 0)
  assert.ok(hints[0].text.indexOf('考虑拆分模块') >= 0)
})

test('信号 a 不命中：声明次数 <8', function () {
  var ts = []
  for (var i = 0; i < 7; i++) ts.push(mk(i, { touches: ['src/big.js'], claimedAt: iso(BASE + i * MIN + MIN), resolvedAt: iso(BASE + i * MIN + 2 * MIN) }))
  assert.deepEqual(computeHealthHints(ts), [])
})

test('信号 a 不命中：次数够但占有 touches 任务比例 <40%', function () {
  var ts = []
  for (var i = 0; i < 8; i++) ts.push(mk(i, { touches: ['src/hot.js'] }))
  for (var j = 0; j < 20; j++) ts.push(mk(100 + j, { touches: ['src/u' + j + '.js'] }))
  // src/hot.js 计 8 次 ≥8，但有 touches 任务共 28 张，占比 28.6% <40% → 不提示
  assert.deepEqual(computeHealthHints(ts), [])
})

test('信号 a 口径：路径归一化（./ 前缀与反斜杠合并计数）', function () {
  var ts = []
  for (var i = 0; i < 4; i++) ts.push(mk(i, { touches: ['./src/big.js'] }))
  for (var j = 0; j < 4; j++) ts.push(mk(10 + j, { touches: ['src\\big.js'] }))
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.equal(hints[0].level, 'warn')
  assert.ok(hints[0].text.indexOf('src/big.js 在近 8 张卡中被 8 次声明 touches（占比 100%）') >= 0)
})

// task-muupnnq5 ③：机械随卡路径（组装产物 / 守门员目录 / 根 README）不计入热度，也不占占比分母
test('信号 a 防灌水：test/ 与 lib/client.js 只出现在机械随卡时不再触发 warn', function () {
  var ts = []
  // 10 张卡都挂守门员/产物路径——旧口径下 lib/client.js 会以 10 次 + 100% 占比误报「架构收敛点」
  for (var i = 0; i < 10; i++) ts.push(mk(i, { touches: ['lib/client.js', 'test/health.test.mjs', 'test'] }))
  assert.deepEqual(computeHealthHints(ts), [])
})

test('信号 a 防灌水：噪声路径不进占比分母', function () {
  var ts = []
  // 10 张卡只挂守门员/产物路径：过滤后一律不算「有 touches 任务」，不该抬高分母、也不该进热度计数
  for (var i = 0; i < 10; i++) ts.push(mk(i, { touches: ['README.md', 'test/health.test.mjs', 'lib/client.js'] }))
  // 7 张真实热点路径卡：真实分母 7（旧口径会被 10 张噪声卡撑成 17）
  for (var j = 0; j < 7; j++) ts.push(mk(10 + j, { touches: ['src/real.js'] }))
  // 判定式：次数 7 < 8 → 不命中；若分母含噪声卡则是 7/17=41% ≥ 40%，会误报（本断言锁死该回归）
  assert.deepEqual(computeHealthHints(ts), [])
})

test('信号 a 防灌水：真实热点路径照常计入（噪声过滤不误伤相邻路径）', function () {
  var ts = []
  for (var i = 0; i < 8; i++) ts.push(mk(i, { touches: ['lib/core.mjs', 'test/core.test.mjs'] })) // 同卡里的真实路径仍计数（只丢 test/ 那条）
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.ok(hints[0].text.indexOf('lib/core.mjs 在近 8 张卡中被 8 次声明 touches') >= 0)
  assert.equal(hints[0].text.indexOf('test/core.test.mjs'), -1)
})

test('信号 a 防灌水：过滤只在健康度侧，touches 锁语义不受影响（core 判定原样）', async function () {
  // 黑名单属健康度展示口径：core 的锁冲突判定必须仍认这些路径（否则会静默放行并行 Worker 互踩）
  var core = await import('../lib/core.mjs')
  assert.equal(core.normTouch('./lib/client.js'), 'lib/client.js')
  assert.equal(core.patOverlap('lib/client.js', './lib/client.js'), true)
  assert.equal(core.patOverlap('test/**', 'test/health.test.mjs'), true)
  assert.equal(core.patOverlap('README.md', 'README.md'), true)
})

// ===== 信号 b：串行代价代理 =====
test('信号 b 命中：有 touches 任务滞留中位数 > 无 touches 的 2 倍且样本 ≥5（绝对阈值也过）', function () {
  var ts = []
  for (var i = 0; i < 6; i++) ts.push(mk(i, { touches: ['src/x' + i + '.js'], claimedAt: iso(BASE + i * MIN + 30 * MIN), resolvedAt: iso(BASE + i * MIN + 31 * MIN) }))
  for (var j = 0; j < 6; j++) ts.push(mk(100 + j, { claimedAt: iso(BASE + (100 + j) * MIN + 3 * MIN), resolvedAt: iso(BASE + (100 + j) * MIN + 4 * MIN) }))
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.equal(hints[0].level, 'info')
  assert.ok(hints[0].text.indexOf('中位数 30min vs 3min') >= 0)
  assert.ok(hints[0].text.indexOf('并行度受锁限制') >= 0)
})

test('信号 b 不命中：有 touches 任务样本 <5', function () {
  var ts = []
  for (var i = 0; i < 4; i++) ts.push(mk(i, { touches: ['src/x' + i + '.js'], claimedAt: iso(BASE + i * MIN + 60 * MIN), resolvedAt: iso(BASE + i * MIN + 61 * MIN) }))
  for (var j = 0; j < 4; j++) ts.push(mk(100 + j, { claimedAt: iso(BASE + (100 + j) * MIN + MIN), resolvedAt: iso(BASE + (100 + j) * MIN + 2 * MIN) }))
  assert.deepEqual(computeHealthHints(ts), [])
})

// task-muupnnq5 ①：亚分钟差异（0.4min vs 0.1min 满足 2 倍）是纯噪声，绝对阈值 5min 拦掉
test('信号 b 不触发：相对倍数够但不足 5min 绝对阈值（4.9min vs 0.4min）', function () {
  var ts = []
  for (var i = 0; i < 6; i++) ts.push(mk(i, { touches: ['src/n' + i + '.js'], claimedAt: iso(BASE + i * MIN + 294000), resolvedAt: iso(BASE + i * MIN + 300000) })) // 等待 4.9min
  for (var j = 0; j < 6; j++) ts.push(mk(100 + j, { claimedAt: iso(BASE + (100 + j) * MIN + 24000), resolvedAt: iso(BASE + (100 + j) * MIN + 30000) })) // 等待 0.4min
  assert.deepEqual(computeHealthHints(ts), [])
})

test('信号 b 触发：刚过 5min 绝对阈值（5.1min vs 0.4min）', function () {
  var ts = []
  for (var i = 0; i < 6; i++) ts.push(mk(i, { touches: ['src/y' + i + '.js'], claimedAt: iso(BASE + i * MIN + 306000), resolvedAt: iso(BASE + i * MIN + 312000) })) // 等待 5.1min
  for (var j = 0; j < 6; j++) ts.push(mk(100 + j, { claimedAt: iso(BASE + (100 + j) * MIN + 24000), resolvedAt: iso(BASE + (100 + j) * MIN + 30000) })) // 等待 0.4min
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.ok(hints[0].text.indexOf('中位数 5min vs <1min') >= 0) // 5.1 → 5min；0.4min 不再撞脸成「0min」而是 <1min
})

// task-muupnnq5 ④：排队中（无 claimedAt/resolvedAt）的 pending 卡按 now-createdAt 计入，治右删失低估
test('信号 b 口径：仍在排队的 pending 卡滞留计入（now-createdAt）', function () {
  var now = Date.now()
  var ts = []
  // 6 张仍排队的有 touches 卡，创建于 40min 前 → 滞留 40min
  for (var i = 0; i < 6; i++) ts.push(mk(i, { status: 'pending', touches: ['src/w' + i + '.js'], createdAt: iso(now - 40 * MIN) }))
  // 6 张立刻完成的无 touches 卡 → 滞留 ~0
  for (var j = 0; j < 6; j++) ts.push(mk(100 + j, { createdAt: iso(now - 60 * MIN), claimedAt: iso(now - 59 * MIN), resolvedAt: iso(now - 58 * MIN) }))
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.ok(hints[0].text.indexOf('并行度受锁限制') >= 0)
  // 反证：同一批卡若都是「刚刚创建还在排队」（滞留 ~0）则不判定——差别全部来自 now-createdAt 口径
  var fresh = ts.map(function (t) { return Object.assign({}, t, { createdAt: iso(now - 30000) }) })
  assert.deepEqual(computeHealthHints(fresh), [])
})

// task-muupnnq5 ①：亚分钟滞留的展示修正——不再四舍五入成「0min」撞脸（治幽灵告警的观感来源）
test('文案口径：不足 1 分钟渲染 <1min（无 0min 撞脸）', function () {
  var now = Date.now()
  var ts = []
  // 6 张排队中的有 touches 卡：滞留 40min（过绝对阈值）+ 6 张 0.2min 对照组 → 对照组必须显示 <1min
  for (var i = 0; i < 6; i++) ts.push(mk(i, { status: 'pending', touches: ['src/z' + i + '.js'], createdAt: iso(now - 40 * MIN) }))
  for (var j = 0; j < 6; j++) ts.push(mk(100 + j, { createdAt: iso(now - 12000), claimedAt: iso(now), resolvedAt: iso(now) }))
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.ok(hints[0].text.indexOf('40min vs <1min') >= 0)
  assert.equal(hints[0].text.indexOf('vs 0min'), -1) // 亚分钟不再渲染成「0min」
})

// ===== 信号 c：执行时长 p90（口径 = claimedAt→resolvedAt，task-mutdnitw 修正后不含排队）=====
test('信号 c 命中：resolved 任务执行时长 p90 > 45min', function () {
  var ts = []
  for (var i = 0; i < 8; i++) ts.push(mk(i, { claimedAt: iso(BASE + i * MIN + MIN), resolvedAt: iso(BASE + i * MIN + 11 * MIN) })) // 执行 10min
  for (var j = 0; j < 2; j++) ts.push(mk(100 + j, { claimedAt: iso(BASE + (100 + j) * MIN + MIN), resolvedAt: iso(BASE + (100 + j) * MIN + 121 * MIN) })) // 执行 120min
  // n=10，p90 = 升序第 ceil(0.9*10)=9 位 = 120min
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.equal(hints[0].level, 'info')
  assert.ok(hints[0].text.indexOf('p90 已达 120min') >= 0)
})

test('信号 c 不命中：p90 未超阈值', function () {
  var ts = []
  for (var i = 0; i < 10; i++) ts.push(mk(i, { claimedAt: iso(BASE + i * MIN + MIN), resolvedAt: iso(BASE + i * MIN + 31 * MIN) })) // 执行 30min
  assert.deepEqual(computeHealthHints(ts), [])
})

test('信号 c 口径：排队不计入执行时长；无 claimedAt 的卡不参与聚合', function () {
  // 排队 119min + 执行 1min：旧口径（创建起算 120min）会误报，新口径不报警
  var ts = []
  for (var i = 0; i < 10; i++) ts.push(mk(i, { claimedAt: iso(BASE + i * MIN + 119 * MIN), resolvedAt: iso(BASE + i * MIN + 120 * MIN) }))
  assert.deepEqual(computeHealthHints(ts), [])
  // 无 claimedAt 的手工/直办卡：resolvedAt 再晚也不参与 p90（durationMsOf 返回 -1）
  var ts2 = []
  for (var j = 0; j < 10; j++) ts2.push(mk(j, { resolvedAt: iso(BASE + j * MIN + 500 * MIN) }))
  assert.deepEqual(computeHealthHints(ts2), [])
})

// ===== 信号 d：驳回热点 =====
test('信号 d 命中：同路径累计驳回 ≥2 次 → warn', function () {
  var ts = [
    mk(0, { touches: ['src/fragile.js'], rejectCount: 1 }),
    mk(1, { touches: ['src/fragile.js'], rejectCount: 1 }),
  ]
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 1)
  assert.equal(hints[0].level, 'warn')
  assert.ok(hints[0].text.indexOf('src/fragile.js 相关任务被驳回 2 次') >= 0)
  assert.ok(hints[0].text.indexOf('质量脆弱区') >= 0)
})

test('信号 d 不命中：驳回 <2 次；无 touches 的驳回无法归因', function () {
  assert.deepEqual(computeHealthHints([mk(0, { touches: ['src/a.js'], rejectCount: 1 })]), [])
  assert.deepEqual(computeHealthHints([mk(0, { rejectCount: 5 })]), [])
})

// ===== 窗口边界：只统计近 50 张卡（含归档）=====
test('窗口边界：热点滑出近 50 张窗口后不再报警', function () {
  var hot = []
  for (var i = 0; i < 10; i++) hot.push(mk(i, { touches: ['src/old.js'], rejectCount: 1, status: 'archived' }))
  // 对照组：热点卡在窗口内时确实命中（信号 a + d）
  assert.ok(computeHealthHints(hot).length >= 2)
  // 追加 50 张更新的普通卡，把热点挤出窗口
  var all = hot.slice()
  for (var j = 0; j < 50; j++) all.push(mk(100 + j, { claimedAt: iso(BASE + (100 + j) * MIN + MIN), resolvedAt: iso(BASE + (100 + j) * MIN + 2 * MIN) }))
  assert.equal(all.length, 60)
  assert.deepEqual(computeHealthHints(all), [])
})

// ===== 提示上限：最多 3 条，warn 优先 =====
test('四信号同时命中时截断为 3 条（warn 优先）', function () {
  var ts = []
  // 8 张热点卡：touches src/hot.js（信号 a：8/14=57%）、各驳回 1 次（信号 d：累计 8 次）、滞留 30min、执行 70min
  for (var i = 0; i < 8; i++) ts.push(mk(i, { touches: ['src/hot.js'], rejectCount: 1, claimedAt: iso(BASE + i * MIN + 30 * MIN), resolvedAt: iso(BASE + i * MIN + 100 * MIN) }))
  // 6 张其他 touches 卡：滞留 30min、执行 70min（凑信号 b 样本与信号 c）
  for (var j = 0; j < 6; j++) ts.push(mk(100 + j, { touches: ['src/other.js'], claimedAt: iso(BASE + (100 + j) * MIN + 30 * MIN), resolvedAt: iso(BASE + (100 + j) * MIN + 100 * MIN) }))
  // 6 张无 touches 卡：滞留 3min、执行 97min（信号 b 对照组；resolvedAt 必须有，否则滞留会退化成 now-createdAt）
  for (var k = 0; k < 6; k++) ts.push(mk(200 + k, { claimedAt: iso(BASE + (200 + k) * MIN + 3 * MIN), resolvedAt: iso(BASE + (200 + k) * MIN + 100 * MIN) }))
  var hints = computeHealthHints(ts)
  assert.equal(hints.length, 3)
  assert.deepEqual(hints.map(function (h) { return h.level }), ['warn', 'warn', 'info'])
  assert.ok(hints[0].text.indexOf('src/hot.js') >= 0)
  assert.ok(hints[1].text.indexOf('驳回 8 次') >= 0)
  assert.ok(hints[2].text.indexOf('并行度受锁限制') >= 0)
})
