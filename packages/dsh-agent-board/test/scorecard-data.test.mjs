// dsh-agent-board — 记分卡卡1 数据底座单测（test/scorecard-data.test.mjs，task-muxhshfu）
// 覆盖（对应任务断言①~④ + 补落账接线）：
//   ① run 字段完备性体检——老/新 run 各一条过 auditRunEntry 分类正确；板级汇总计数；过聚合不炸（退化口径）
//   ② 驳回归因三来源——verifier 文本通道 / board_verdict 工具通道 / 主窗口 task_verify（direct 无 run → null）；
//     归因恒指 worker run（verifier 自己的 run 不自我归因）；跨天 crossDay 漂标记；时刻倒挂 drifted 兜底
//   ③ 规模段边界值——<1M 小 / 1M~10M 中 / >10M 大（含端归中）；非法输入 null；角色归一 worker/verifier/other
//   ④ 纯函数零 IO——fs 全部门面打爆后 helper 照跑（sizeBucketOf/runRoleOf/audit*/attributeRejection/aggregate）
//   ⑤ 补落账接线（源码级）——accumulateRunUsage 回填 run 条目空 model；index.mjs 兼容 re-export
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import {
  aggregateUsageSummary, effectiveTokens, taskEffectiveTokens,
  sizeBucketOf, runRoleOf, auditRunEntry, auditRunsCompleteness, attributeRejection,
  SIZE_BUCKET_SMALL_MAX, SIZE_BUCKET_MEDIUM_MAX,
} from '../index.mjs'

// 本地构造时刻 → ISO 串（round-trip 经 dayKeyOf 仍落原本地日，与机器时区无关）
function isoOf(y, m, d, h, mi) { return new Date(y, m - 1, d, h, mi || 0, 0).toISOString() }
// 一条「continuable 时代全字段」的已落定 run（五组分齐备：model/at/endedAt/outcome/usage）
function fullRun(id, role, at, model, usage) {
  return { role: role, id: id, at: at, model: model, outcome: 'completed', endedAt: isoOf(2026, 10, 6, 12), usage: usage, usageSeq: 42, usageRecorded: true }
}
function U(inp, outp, cr, cw) { return { input: inp, output: outp, cacheRead: cr, cacheWrite: cw, total: inp + outp + cr + cw } }

// ===== ① 字段完备性体检 + 老/新 run 过聚合不炸 =====
test('卡1①：run 完备性体检——新 run complete / 老 run incomplete 逐字段点名 / 在飞 run 单挂 running', () => {
  const newRun = fullRun('s-new', 'worker', isoOf(2026, 10, 6, 10), 'kimi/k3', U(100, 50, 1000, 10))
  // 老形态存量 run：无 model/endedAt/usage（continuable 时代之前落的账）
  const oldRun = { role: 'worker', id: 's-old', at: isoOf(2026, 10, 5, 9), outcome: 'completed' }
  // 在飞 run：只核 at，model/endedAt/usage 结算时才落（不算缺字段）；手动终止残留同此形态
  const flyRun = { role: 'worker', id: 's-fly', at: isoOf(2026, 10, 7, 1), model: '', outcome: 'running', hardMin: 120, continuable: true }

  assert.deepEqual(auditRunEntry(newRun), { status: 'complete', missing: [] })
  const aOld = auditRunEntry(oldRun)
  assert.equal(aOld.status, 'incomplete')
  assert.deepEqual(aOld.missing.sort(), ['endedAt', 'model', 'usage'])
  assert.deepEqual(auditRunEntry(flyRun), { status: 'running', missing: [] })
  // 极端脏数据：空条目 / at 脏 / outcome 缺
  assert.equal(auditRunEntry(null).status, 'incomplete')
  assert.deepEqual(auditRunEntry({ role: 'worker', id: 'x', outcome: 'running' }).missing, ['at'])
  assert.deepEqual(auditRunEntry({ role: 'worker', id: 'x', at: isoOf(2026, 10, 6, 8) }).missing, ['outcome'])
  // resume 稀疏旗标：缺省不判缺（续跑记录的 resume:true 也不影响完备性结论）
  const resumeRun = fullRun('s-resume', 'worker', isoOf(2026, 10, 6, 11), 'kimi/k3', U(1, 1, 0, 0))
  resumeRun.resume = true; resumeRun.continuable = true
  assert.equal(auditRunEntry(resumeRun).status, 'complete')

  // 板级汇总：计数与逐字段缺口分布
  const s = auditRunsCompleteness([
    { id: 't1', runs: [newRun, flyRun] },
    { id: 't2', runs: [oldRun] },
    { id: 't3' }, // 无 runs 留账的老卡：零贡献，不炸
  ])
  assert.equal(s.total, 3)
  assert.equal(s.complete, 1)
  assert.equal(s.running, 1)
  assert.equal(s.incomplete, 1)
  assert.equal(s.byField.model, 1)
  assert.equal(s.byField.endedAt, 1)
  assert.equal(s.byField.usage, 1)
  assert.equal(s.runs.length, 3)
  assert.equal(s.runs[2].taskId, 't2')
  assert.equal(s.runs[2].runId, 's-old')
})

test('卡1①b：老/新 run 混排过 aggregateUsageSummary（含范围裁剪路径）不炸——老数据退化口径保持', () => {
  const newRun = fullRun('s-new', 'worker', isoOf(2026, 10, 6, 10), 'kimi/k3', U(100, 50, 1000, 10))
  const oldRun = { role: 'worker', id: 's-old', at: isoOf(2026, 10, 5, 9), outcome: 'completed' } // 无 usage
  const t1 = { id: 't1', title: '新卡', usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10, total: 1160, runs: 1, models: { 'kimi/k3': 1160 } }, runs: [newRun] }
  // 老卡：任务级只有 total（无 byDay/models），runs 条目没落 usage → 范围裁剪走「无 run 级留账」退化臂
  const t2 = { id: 't2', title: '老卡', usage: { total: 500, updatedAt: isoOf(2026, 10, 5, 20) }, runs: [oldRun] }
  // 无范围：全量计入
  const all = aggregateUsageSummary([t1, t2])
  assert.equal(all.total, 1660)
  assert.equal(all.effective, 160) // t1 有效 160 + t2 老形态无分量 → effectiveTokens=0（不伪造）
  // 有范围（只含 10-06）：t1 按 run 级精确裁（入选），t2 退化 updatedAt 落 10-05 → 范围外剔除
  const ranged = aggregateUsageSummary([t1, t2], { from: '2026-10-06', to: '2026-10-06' })
  assert.equal(ranged.total, 1160)
  assert.equal(ranged.effective, 160)
  assert.equal(ranged.byModel['kimi/k3'], 1160) // run 条目自带 model → 精确归属，不走摊派
  // 范围裁剪路径下老 run（有 at 无 usage）不入选、不炸、不把脏数据带进 byDay
  assert.equal(Object.keys(ranged.byDay).join(','), '2026-10-06')
})

// ===== ② 驳回归因：三来源 + 跨天漂标记 + 兜底 =====
test('卡1②：驳回归因三来源各一条——归因恒指「驳回前最近 worker run」，verifier 不自我归因', () => {
  const wAt = isoOf(2026, 10, 6, 10)
  const vAt = isoOf(2026, 10, 6, 11)
  const rejAt = isoOf(2026, 10, 6, 12) // 三条来源共用的驳回落定时刻（t.verification.at）
  const workerRun = fullRun('w1', 'worker', wAt, 'worker/model-a', U(100, 50, 0, 0))
  const verifierRun = fullRun('v1', 'verifier', vAt, 'verifier/model-b', U(10, 5, 0, 0))
  const t = { id: 't1', runs: [workerRun, verifierRun] }

  // 来源① verifier 文本通道（settleVerifier）：verification.by = verifier 自己的 run id 'v1'
  // ⚠️ 若按「时刻前最近一条 run」会错归到 v1（时刻更晚）——必须锁定 role='worker'
  const a1 = attributeRejection(t, rejAt)
  assert.equal(a1.runId, 'w1')
  assert.equal(a1.model, 'worker/model-a')
  assert.equal(a1.crossDay, false)
  assert.equal(a1.drifted, false)

  // 来源② board_verdict 工具通道：by = verifier 会话 actor（不一定是 runs 里的 id）——归因口径不变
  const a2 = attributeRejection(t, rejAt) // 同一 helper，by 不参与定位（时刻 + role 唯一定位）
  assert.equal(a2.runId, 'w1')

  // 来源③ 主窗口 task_verify / 看板 verify-task：direct 档任务主窗口自己做，无 worker run → null
  assert.equal(attributeRejection({ id: 't-direct', runs: [] }, rejAt), null)
  assert.equal(attributeRejection({ id: 't-legacy' }, rejAt), null) // 老卡连 runs 字段都没有

  // 多轮驳回：归到「驳回时刻前最近」的那一轮 worker run，不是更早的
  const w2 = fullRun('w2', 'worker', isoOf(2026, 10, 6, 13), 'worker/model-c', U(1, 1, 0, 0))
  const t2 = { id: 't2', runs: [workerRun, verifierRun, w2] }
  assert.equal(attributeRejection(t2, isoOf(2026, 10, 6, 14)).runId, 'w2')   // 第二轮驳回 → w2
  assert.equal(attributeRejection(t2, rejAt).runId, 'w1')                      // 第一轮驳回 → 仍 w1
})

test('卡1②b：跨天驳回归因漂标记 crossDay + 时刻倒挂 drifted 兜底', () => {
  // 跨天：worker run 落在 10-05 深夜，驳回落定在 10-06 凌晨 → 不同本地日 → crossDay=true
  const t = { id: 't1', runs: [fullRun('w1', 'worker', isoOf(2026, 10, 5, 23), 'm/a', U(1, 1, 0, 0))] }
  const a = attributeRejection(t, isoOf(2026, 10, 6, 1))
  assert.equal(a.runId, 'w1')
  assert.equal(a.crossDay, true)
  // 同天 → false
  assert.equal(attributeRejection(t, isoOf(2026, 10, 5, 23, 30)).crossDay, false)
  // 时刻倒挂（时钟回拨/at 脏）：所有 worker run 都晚于驳回时刻 → 兜底最新 worker run + drifted=true
  const t2 = { id: 't2', runs: [fullRun('w9', 'worker', isoOf(2026, 10, 7, 9), 'm/b', U(1, 1, 0, 0))] }
  const a2 = attributeRejection(t2, isoOf(2026, 10, 6, 1))
  assert.equal(a2.runId, 'w9')
  assert.equal(a2.drifted, true)
  // 驳回时刻本身脏（NaN）：同样兜底，不炸
  const a3 = attributeRejection(t2, 'not-a-date')
  assert.equal(a3.runId, 'w9')
  assert.equal(a3.drifted, false) // 时刻不可比 → 首个带合法 at 的 worker run 直中（非兜底臂）
  // worker run 的 at 脏：跳过时刻比较，仍是最新兜底候选
  const t3 = { id: 't3', runs: [{ role: 'worker', id: 'w-dirty', at: 'garbage', outcome: 'completed' }] }
  const a4 = attributeRejection(t3, isoOf(2026, 10, 6, 1))
  assert.equal(a4.runId, 'w-dirty')
  assert.equal(a4.drifted, true)
})

// ===== ③ 规模段边界值 + 角色归一 =====
test('卡1③：规模段边界值——<1M 小 / 1M~10M 中（含端）/ >10M 大；非法输入 null', () => {
  assert.equal(SIZE_BUCKET_SMALL_MAX, 1000000)
  assert.equal(SIZE_BUCKET_MEDIUM_MAX, 10000000)
  assert.equal(sizeBucketOf(null), null)
  assert.equal(sizeBucketOf(undefined), null)
  assert.equal(sizeBucketOf(0), null)
  assert.equal(sizeBucketOf(-5), null)
  assert.equal(sizeBucketOf('junk'), null)
  assert.equal(sizeBucketOf(1), 'small')
  assert.equal(sizeBucketOf(999999), 'small')
  assert.equal(sizeBucketOf(1000000), 'medium')   // 恰好 1M 归中（<1M 是严格不等号）
  assert.equal(sizeBucketOf(9999999), 'medium')
  assert.equal(sizeBucketOf(10000000), 'medium')  // 恰好 10M 归中（>10M 是严格不等号）
  assert.equal(sizeBucketOf(10000001), 'large')
  assert.equal(sizeBucketOf(1e9), 'large')
  // 与任务有效 token 口径打通：taskEffectiveTokens(u).tok 直接喂 sizeBucketOf
  const tok = taskEffectiveTokens({ input: 400000, output: 500000, cacheRead: 9000000, cacheWrite: 200000 }).tok
  assert.equal(tok, 1100000) // 有效口径不含缓存读
  assert.equal(sizeBucketOf(tok), 'medium')
  assert.equal(sizeBucketOf(taskEffectiveTokens(null).tok), null) // 无结算记录 → 规模不可知
})

test('卡1③b：角色归一——worker/verifier 原样，hook/缺省/脏值一律 other', () => {
  assert.equal(runRoleOf({ role: 'worker' }), 'worker')
  assert.equal(runRoleOf({ role: 'verifier' }), 'verifier')
  assert.equal(runRoleOf({ role: 'hook-pre' }), 'other')
  assert.equal(runRoleOf({ role: 'hook-post' }), 'other')
  assert.equal(runRoleOf({}), 'other')        // 老 run 缺 role
  assert.equal(runRoleOf(null), 'other')
  assert.equal(runRoleOf({ role: 'Worker' }), 'other') // 大小写敏感，不猜
})

// ===== ④ 纯函数零 IO =====
test('卡1④：helper 纯函数零 IO——fs 门面全部打爆后照跑不触盘', () => {
  const orig = {}
  for (const k of ['readFileSync', 'readdirSync', 'statSync', 'openSync', 'readSync', 'existsSync']) {
    orig[k] = fs[k]
    fs[k] = function () { throw new Error('IO 触碰：' + k) }
  }
  try {
    const run = fullRun('w1', 'worker', isoOf(2026, 10, 6, 10), 'm/a', U(100, 50, 0, 0))
    const t = { id: 't1', usage: { input: 100, output: 50, total: 150, runs: 1 }, runs: [run] }
    assert.equal(sizeBucketOf(150), 'small')
    assert.equal(runRoleOf(run), 'worker')
    assert.equal(auditRunEntry(run).status, 'complete')
    assert.equal(auditRunsCompleteness([t]).total, 1)
    assert.equal(attributeRejection(t, isoOf(2026, 10, 6, 12)).runId, 'w1')
    assert.equal(effectiveTokens(run.usage), 150)
    assert.equal(aggregateUsageSummary([t], { from: '2026-10-06', to: '2026-10-06' }).total, 150)
  } finally {
    for (const k2 of Object.keys(orig)) fs[k2] = orig[k2]
  }
})

// ===== ⑤ 补落账接线（源码级断言）=====
test('卡1⑤：模型补落账接线——accumulateRunUsage 回填空 model / index re-export / helper 落在 usage.mjs', () => {
  const disp = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  const usage = readFileSync(new URL('../lib/usage.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  // 补落账：run 级留账写回时，条目 model 为空且日志有模型名 → 回填（只填空不覆盖）
  assert.match(disp, /if \(!t\.runs\[ri\]\.model && u\.model\) t\.runs\[ri\]\.model = String\(u\.model\)/)
  // helper 本体在 usage.mjs（纯函数段）
  assert.match(usage, /export function sizeBucketOf\(effTok\)/)
  assert.match(usage, /export function runRoleOf\(r\)/)
  assert.match(usage, /export function auditRunEntry\(r\)/)
  assert.match(usage, /export function auditRunsCompleteness\(tasks\)/)
  assert.match(usage, /export function attributeRejection\(t, rejectedAt\)/)
  // 归因果断锁定 worker：role !== 'worker' 跳过（verifier 不自我归因的硬保证）
  assert.match(usage, /if \(!r \|\| r\.role !== 'worker'\) continue/)
  // 兼容 re-export：单测与卡2 聚合从 index.mjs 直取
  assert.match(idx, /sizeBucketOf, runRoleOf, auditRunEntry, auditRunsCompleteness, attributeRejection/)
})
