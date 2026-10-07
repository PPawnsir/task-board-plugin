// dsh-agent-board — 主窗口 Token 消耗展示项单测（test/usage-mainwindow.test.mjs，task-muwsol23）
// 覆盖（对应任务断言①~⑥ + README）：
//   ① 增量尾读——同文件追加后只读增量字节段（readSync 字节计数）；无变化零读；截断全量重读
//   ② 聚合五分量 + e=input+output+cacheWrite 口径 + byDay 本地日落点 + 尾部半帧不结算（下轮补读不丢不重）
//   ③ 范围裁剪——byDay/累计三分量随 range（本地日闭区间）；空范围=无范围（parity）；出参副本不污染缓存
//   ④ 隔离红线——mainWindow 不进 Top8/累计/模型归属（挂上后逐字不变）；聚合本体永不产出 mainWindow 键
//   ⑤ 失败静默降级——日志不存在/无 usage/垃圾字节/无缓存槽 → null 或旧值，绝不抛
//   ⑥ client/host 接线源码断言——单列行 / 模型分布尾部条（0 不渲染）/ caption / get-tasks 挂载
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { readMainWindowUsage, aggregateUsageSummary } from '../index.mjs'
import { localDayKey } from '../lib/usage.mjs'

const zstdOk = typeof zlib.zstdCompressSync === 'function'
// 一帧追加写：与 v4 日志同形（多帧 zstd 顺序拼接，帧内 jsonl）
function frameOf(events) { return zlib.zstdCompressSync(Buffer.from(events.map(function (e) { return JSON.stringify(e) }).join('\n') + '\n', 'utf8')) }
// 主会话日志根：布局与真实一致 <root>/<bucket>/<sid>/session.v4.jsonl.zstd（findRunLog 按桶探测）
function mkMainLog(sid, chunks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mw-'))
  const dir = path.join(root, 'bucket', sid)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'session.v4.jsonl.zstd')
  if (chunks && chunks.length) fs.writeFileSync(logPath, Buffer.concat(chunks))
  return { root: root, logPath: logPath, append: function (b) { fs.appendFileSync(logPath, b) } }
}
// 事件时间戳（epoch ms）：本地构造保证落点与 localDayKey 口径一致（与机器时区无关）
function msOf(y, m, d, h) { return new Date(y, m - 1, d, h === undefined ? 12 : h, 0, 0).getTime() }
function dayOf(y, m, d, h) { return localDayKey(new Date(msOf(y, m, d, h))) }
// 一条 assistant/message usage 事件（time 是 v4 事件自带的全序时间戳字段）
function amEvent(ms, usage) { return { type: 'assistant/message', time: ms, data: { usage: usage } } }
function U(inp, outp, cr, cw) { return { inputTokens: inp, outputTokens: outp, cacheReadTokens: cr, cacheWriteTokens: cw, totalTokens: inp + outp + cr + cw } }

// ===== ① 增量尾读（字节计数）=====
test('主窗口①：增量尾读——追加后只读新增字节段、无变化零读、截断全量重读（readSync 字节计数）', (t) => {
  if (!zstdOk) { t.skip('zstdCompressSync unavailable'); return }
  const L = mkMainLog('sid-mw1', [frameOf([amEvent(msOf(2026, 10, 5, 10), U(100, 7, 1000, 0))])])
  try {
    const cache = {}
    // 字节计数：node:fs 的默认导出是共享 CJS 对象，包装 readSync 即覆盖 usage.mjs 的 fsNode.readSync
    const origRead = fs.readSync
    let bytes = 0
    fs.readSync = function (fd, buf, off, len, pos) { bytes += len; return origRead.apply(fs, arguments) }
    try {
      const sz1 = fs.statSync(L.logPath).size
      const r1 = readMainWindowUsage('sid-mw1', L.root, null, cache)
      assert.equal(bytes, sz1) // 首轮全量读
      assert.equal(r1.total, 1107); assert.equal(r1.effective, 107); assert.equal(r1.cacheRead, 1000)
      // 第二轮无变化 → 零读直接用缓存（3s 轮询稳态零全量重读的硬保证）
      bytes = 0
      const r1b = readMainWindowUsage('sid-mw1', L.root, null, cache)
      assert.equal(bytes, 0)
      assert.deepEqual(r1b, r1)
      // 追加一帧 → 只读新增字节段（增量尾读），聚合 = 旧账 + 增量（不重复计账）
      const add = frameOf([amEvent(msOf(2026, 10, 6, 9), U(3, 4, 0, 5))])
      L.append(add)
      bytes = 0
      const r2 = readMainWindowUsage('sid-mw1', L.root, null, cache)
      assert.equal(bytes, add.length) // 增量段字节数，不是全文件
      assert.equal(r2.total, 1119)    // 1107 + 12（若全量重读重复计账会变 2226）
      assert.equal(r2.effective, 119) // 107 + (3+4+5)
      assert.equal(r2.cacheRead, 1000)
      // 截断（日志轮换/文件变小）→ 缓存作废，全量重读一次
      const fresh = frameOf([amEvent(msOf(2026, 10, 7, 8), U(1, 1, 1, 1))])
      fs.writeFileSync(L.logPath, fresh)
      bytes = 0
      const r3 = readMainWindowUsage('sid-mw1', L.root, null, cache)
      assert.equal(bytes, fresh.length)
      assert.equal(r3.total, 4)  // 旧账随轮换清零重算（不是 1119+4）
      assert.equal(r3.effective, 3)
    } finally { fs.readSync = origRead }
  } finally { fs.rmSync(L.root, { recursive: true, force: true }) }
})

// ===== ② 聚合口径 + byDay 日落点 + 尾部半帧 =====
test('主窗口②：五分量 + e=输入+输出+缓存写 + byDay 本地日落点；尾部半帧不结算（补全后整帧只记一次）', (t) => {
  if (!zstdOk) { t.skip('zstdCompressSync unavailable'); return }
  const d1 = dayOf(2026, 10, 5, 10), d2 = dayOf(2026, 10, 6, 23)
  const f1 = frameOf([
    { type: 'request/context', time: msOf(2026, 10, 5, 9), data: { model: 'm-x' } }, // 非 assistant/message：不计
    amEvent(msOf(2026, 10, 5, 10), U(10, 5, 100, 5)),  // d1：t=120 e=20 cr=100
    amEvent(msOf(2026, 10, 6, 23), U(1, 2, 3, 4))      // d2：t=10 e=7 cr=3
  ])
  const L = mkMainLog('sid-mw2', [f1])
  try {
    const cache = {}
    const r = readMainWindowUsage('sid-mw2', L.root, null, cache)
    assert.equal(r.total, 130)      // 120 + 10（总量含缓存读）
    assert.equal(r.effective, 27)   // (10+5+5) + (1+2+4)：缓存读不进有效口径
    assert.equal(r.cacheRead, 103)
    assert.deepEqual(r.byDay, { [d1]: { t: 120, e: 20, cr: 100 }, [d2]: { t: 10, e: 7, cr: 3 } })
    // 尾部半帧（写入进行中）：解压必失败 → 不结算，聚合值原地不动
    const good = frameOf([amEvent(msOf(2026, 10, 6, 23, 30), U(2, 2, 0, 1))]) // t=5 e=5
    L.append(good.subarray(0, good.length - 6))
    const r2 = readMainWindowUsage('sid-mw2', L.root, null, cache)
    assert.equal(r2.total, 130)
    assert.equal(r2.effective, 27)
    // 补全该帧 → 从半帧起点重读，整帧恰好记一次（不丢不重）
    L.append(good.subarray(good.length - 6))
    const r3 = readMainWindowUsage('sid-mw2', L.root, null, cache)
    assert.equal(r3.total, 135)
    assert.equal(r3.effective, 32)
    assert.deepEqual(r3.byDay[d2], { t: 15, e: 12, cr: 3 })
  } finally { fs.rmSync(L.root, { recursive: true, force: true }) }
})

// ===== ③ 范围裁剪 =====
test('主窗口③：范围裁剪——byDay/累计三分量随 range（本地日闭区间）；空范围=无范围（parity）；出参副本不污染缓存', (t) => {
  if (!zstdOk) { t.skip('zstdCompressSync unavailable'); return }
  const d1 = dayOf(2026, 10, 5, 10), d2 = dayOf(2026, 10, 6, 23)
  const L = mkMainLog('sid-mw3', [frameOf([
    amEvent(msOf(2026, 10, 5, 10), U(10, 5, 100, 5)),
    amEvent(msOf(2026, 10, 6, 23), U(1, 2, 3, 4))
  ])])
  try {
    const cache = {}
    const all = readMainWindowUsage('sid-mw3', L.root, null, cache)
    assert.equal(all.total, 130)
    // 范围只留 d2：三分量由入选日重算，byDay 只剩 d2（与 run 口径同一 dayInRange 两端闭区间）
    const cropped = readMainWindowUsage('sid-mw3', L.root, { from: d2, to: d2 }, cache)
    assert.equal(cropped.total, 10)
    assert.equal(cropped.effective, 7)
    assert.equal(cropped.cacheRead, 3)
    assert.deepEqual(cropped.byDay, { [d2]: { t: 10, e: 7, cr: 3 } })
    // 范围全落空：0 值对象（不是 null——会话确有消耗，只是都在范围外）
    const miss = readMainWindowUsage('sid-mw3', L.root, { from: '2020-01-01', to: '2020-01-02' }, cache)
    assert.deepEqual(miss, { total: 0, effective: 0, cacheRead: 0, byDay: {} })
    // 空范围与不传等价（parity，与 aggregateUsageSummary 同一约定）
    assert.deepEqual(readMainWindowUsage('sid-mw3', L.root, { from: '', to: '' }, cache), all)
    // 缓存里存的是未裁剪全量：范围请求之后再读全量仍正确（裁剪发生在出参，不毁缓存）
    const again = readMainWindowUsage('sid-mw3', L.root, null, cache)
    assert.equal(again.total, 130)
    // 出参是副本：改出参 byDay 不污染缓存聚合
    cropped.byDay[d2].t = 999999
    assert.equal(readMainWindowUsage('sid-mw3', L.root, null, cache).total, 130)
  } finally { fs.rmSync(L.root, { recursive: true, force: true }) }
})

// ===== ④ 隔离红线（parity）=====
test('主窗口④：隔离红线——挂上 mainWindow 后 Top8/累计/模型归属逐字不变；聚合本体永不产出 mainWindow 键', () => {
  const tasks = [
    { id: 'a', title: 'A', usage: { total: 290, input: 9, output: 19, cacheRead: 252, cacheWrite: 10, runs: 2, models: { 'm-x': 290 }, updatedAt: '2026-10-06T02:00:00.000Z', byDay: { '2026-10-05': { t: 112, e: 12 }, '2026-10-06': { t: 178, e: 26 } } } },
    { id: 'b', title: 'B', usage: { total: 30, input: 1, output: 1, cacheRead: 28, cacheWrite: 0, runs: 1, models: { 'm-y': 30 }, updatedAt: '2026-10-06T03:00:00.000Z', byDay: { '2026-10-06': { t: 30, e: 2 } } } }
  ]
  const before = aggregateUsageSummary(tasks)
  // host 接线形态（rpc.mjs get-tasks）：聚合完成后才挂 mainWindow
  const after = aggregateUsageSummary(tasks)
  after.mainWindow = { total: 999999, effective: 8888, cacheRead: 7777, byDay: { '2026-10-06': { t: 999999, e: 8888, cr: 7777 } } }
  // Top8 / 本看板累计 / 模型归属逐字不变（隔离红线）
  assert.deepEqual(after.topTasks, before.topTasks)
  assert.equal(after.total, before.total)
  assert.equal(after.effective, before.effective)
  assert.equal(after.cacheRead, before.cacheRead)
  assert.deepEqual(after.byModel, before.byModel)
  assert.deepEqual(after.byModelEff, before.byModelEff)
  assert.deepEqual(after.byDay, before.byDay)
  assert.deepEqual(after.byDayFull, before.byDayFull)
  // aggregateUsageSummary 本体永不产出 mainWindow 键（隔离在聚合层就成立，范围路径同样）
  assert.equal('mainWindow' in before, false)
  assert.equal('mainWindow' in aggregateUsageSummary(tasks, { from: '2026-10-06', to: '2026-10-06' }), false)
  // 源码级：mainWindow 挂载必须发生在 run 口径聚合之后
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  const iAgg = rpc.indexOf('d.usageSummary = aggregateUsageSummary(d.tasks, args && args.range)')
  const iMw = rpc.indexOf('d.usageSummary.mainWindow =')
  assert.ok(iAgg >= 0 && iMw > iAgg, 'mainWindow 必须在 aggregateUsageSummary 之后挂载（隔离顺序）')
})

// ===== ⑤ 失败静默降级 =====
test('主窗口⑤：失败静默降级——日志不存在/无 usage/垃圾字节/无缓存槽 → null 或旧值，绝不抛', (t) => {
  if (!zstdOk) { t.skip('zstdCompressSync unavailable'); return }
  // 日志不存在 / 空会话 id → null（客户端不渲染该行）
  assert.equal(readMainWindowUsage('no-such-session-' + Date.now(), undefined, null, {}), null)
  assert.equal(readMainWindowUsage('', undefined, null, {}), null)
  // 只有非 usage 事件 → null（不渲染，与 readRunUsage 的 hasUsage 同哲学）
  const L1 = mkMainLog('sid-nouse', [frameOf([{ type: 'step/end', time: Date.now(), data: {} }])])
  try { assert.equal(readMainWindowUsage('sid-nouse', L1.root, null, {}), null) } finally { fs.rmSync(L1.root, { recursive: true, force: true }) }
  // 垃圾字节（非 zstd 帧）→ null，不抛
  const L2 = mkMainLog('sid-garbage', null)
  fs.writeFileSync(L2.logPath, Buffer.from('not a zstd stream at all'))
  try { assert.equal(readMainWindowUsage('sid-garbage', L2.root, null, {}), null) } finally { fs.rmSync(L2.root, { recursive: true, force: true }) }
  // 无 cacheStore（undefined）也能工作：每次全量读，不炸（老宿主/直接调用兜底）
  const L3 = mkMainLog('sid-nocache', [frameOf([amEvent(msOf(2026, 10, 5, 10), U(1, 1, 0, 0))])])
  try {
    const r = readMainWindowUsage('sid-nocache', L3.root, null, undefined)
    assert.equal(r.total, 2)
    assert.equal(r.effective, 2)
  } finally { fs.rmSync(L3.root, { recursive: true, force: true }) }
})

// ===== ⑥ client/host 接线（源码级断言）=====
test('主窗口⑥：接线（源码级）——get-tasks 挂载 / 增量尾读三态 / 单列行 + 模型分布尾部条 + caption', () => {
  const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  const usage = readFileSync(new URL('../lib/usage.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8') // 组装产物（pretest 已重建）
  // host：get-tasks 在 run 口径聚合之后挂载 mainWindow（带统计范围 + 增量尾读缓存）
  assert.match(rpc, /readMainWindowUsage\(sid, sessionsRoot, args && args\.range, state\.mainWindowUsageCache\)/)
  assert.match(rpc, /if \(__mw\) d\.usageSummary\.mainWindow = __mw/) // null 不挂字段（客户端静默不渲染）
  assert.match(idx, /mainWindowUsageCache: \{\}/)                      // 缓存本体在共享 state
  // usage.mjs：增量尾读三态 + 半帧不结算
  assert.match(usage, /export function readMainWindowUsage\(sessionId, sessionsRoot, range, cacheStore\)/)
  assert.match(usage, /if \(acc && st\.size < acc\.size\) acc = null/) // 变小/轮换 → 全量重读
  assert.match(usage, /st\.size > acc\.size/)                          // 变大 → 增量臂
  assert.match(usage, /readLogBytes\(log, st\.size - acc\.size\)/)     // 只读新增字节段
  assert.match(usage, /if \(k === offs\.length - 1\) break/)           // 尾部半帧不结算
  // client：缺字段静默降级 + 累计行下方单列行（口径翻转 task-muxnqunk：今日/累计显总量，
  // 有效进悬浮 title，缓存读不再单列——已含在 total 里）
  assert.match(cli, /u\.mainWindow && typeof u\.mainWindow === 'object'/)
  assert.match(cli, /'主窗口（本会话）：今日 '/)
  assert.match(cli, /' · 累计 '/)
  assert.match(cli, /fmtTokens\(mw\.total\)/)
  assert.equal(cli.includes('（缓存读 '), false) // 缓存读不再单列（旧「（缓存读 Z）」段已退役）
  // client：模型分布尾部追加「主窗口（对话）」（总量主显；0 不渲染，固定尾部不参与排序）
  assert.match(cli, /label: '主窗口（对话）'/)
  assert.match(cli, /mw && mw\.total > 0/)
  // caption：并列不混入的口径说明
  assert.match(cli, /主窗口行=本会话对话消耗，与看板派发口径并列不混入/)
})

// ===== README 双份记录 =====
test('主窗口⑦：README 双份记录主窗口行口径（增量尾读 / 隔离红线 / 范围裁剪 / 静默降级）', () => {
  const pkg = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.equal(pkg, root) // 两份 README 必须字节一致（npm run sync-readme 的约束）
  for (const s of ['主窗口（本会话）', '主窗口（对话）', '增量尾读', '不进 Top 8', '不含主窗口对话', '静默降级']) {
    assert.ok(pkg.includes(s), 'README 应记录主窗口行口径：' + s)
  }
})
