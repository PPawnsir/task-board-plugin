// dsh-agent-board — get-tasks 条件请求瘦身（ifHash 一致不返全量）单测（test/conditional-get-tasks.test.mjs）
// 背景（task-mv492for，巡检实证 n-mv2turd1o3iv）：面板打开期间每 3s 一次 get-tasks 全量响应恒定
// 1.34MB（tasks 数组含全部卡的 description/context/runs/deliverable 全文），一分钟 ≈26MB 传输。
// tasksHash 此前只做「收到全量后的客户端渲染短路」，载荷本身从没瘦过。修法=条件请求：
// 客户端 fetchTasks 带 ifHash=state.tasksHash；host 比对一致 → 返回 {unchanged:true}+轻量字段（不含 tasks）。
// 覆盖（任务断言①~④）：
//   ① hash 一致 → 响应 unchanged:true 且不含 tasks（字节数级：轻量 <10KB vs 全量 >100KB，harness 构造大板）
//   ② 不带 ifHash / ifHash 不一致 / includeArchived / 卡已变化 → 全量返回不回归
//   ③ unchanged 时客户端 state.tasks 保留（源码级：kernel ifHash 接线 + unchanged 分支优先于 hash 比对）
//   ④ 产物重组装（lib/client.js 含 ifHash/unchanged 接线标记）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

// 多字节字符填充（贴近真实中文看板的字节体量；1 字 = 3 字节 UTF-8）
function big(n) { return '描'.repeat(n) }
function sizeOf(x) { return Buffer.byteLength(JSON.stringify(x)) }

// ===== ①② 字节数级断言：大板全量 >100KB；hash 一致轻量 <10KB 且不含 tasks =====
test('①② get-tasks 条件请求：ifHash 一致返轻量（<10KB 无 tasks）；不一致/缺 ifHash/includeArchived 全量不回归（>100KB）', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    // 构造大板：40 张卡 ×（6KB description + 3KB context.notes）≈ 360KB 级全量
    for (var i = 0; i < 40; i++) {
      await env.rpc('create-task', { sessionId: env.sid, id: 'task-big-' + i, title: '大板卡' + i, description: big(2000), contextNotes: big(1000), pipeline: 'work' })
    }
    // 全量基线：不带 ifHash（老客户端/首轮形态）
    var full = await env.rpc('get-tasks', { sessionId: env.sid })
    assert.ok(Array.isArray(full.tasks) && full.tasks.length === 40, '全量返回全部 40 卡')
    assert.ok(!full.unchanged, '全量响应不带 unchanged 标记')
    assert.ok(full.tasksHash, '全量响应附 tasksHash')
    var fullBytes = sizeOf(full)
    assert.ok(fullBytes > 100 * 1024, '大板全量响应 >100KB（实测 ' + fullBytes + 'B）——大板构造达标')
    // ① hash 一致 → 轻量响应
    var lite = await env.rpc('get-tasks', { sessionId: env.sid, ifHash: full.tasksHash })
    assert.equal(lite.unchanged, true, 'hash 一致 → unchanged:true')
    assert.equal(lite.tasks, undefined, '轻量响应不含 tasks 数组')
    assert.equal(lite.tasksHash, full.tasksHash, '轻量响应透出同一 hash')
    var liteBytes = sizeOf(lite)
    assert.ok(liteBytes < 10 * 1024, '轻量响应 <10KB（实测 ' + liteBytes + 'B，全量 ' + fullBytes + 'B）')
    // 轻量字段照常：usageSummary/healthHints/childStats/poolStatus/workMode/isRoot/各开关一个不少
    assert.ok(lite.usageSummary, 'usageSummary 照常返回（KB 级聚合）')
    assert.ok(Array.isArray(lite.healthHints), 'healthHints 照常返回')
    assert.ok(lite.childStats && typeof lite.childStats === 'object', 'childStats 照常返回')
    assert.ok(lite.poolStatus && typeof lite.poolStatus === 'object', 'poolStatus 照常返回')
    assert.ok(lite.workMode, 'workMode 照常返回')
    assert.equal(lite.isRoot, true, 'isRoot 照常返回')
    assert.equal(lite.feedbackEnabled, true)
    assert.equal(lite.notifyDispatch, true)
    assert.equal(lite.cleanupRetentionDays, 7)
    // ② 不带 ifHash → 全量（上面基线已证）；ifHash 不一致 → 全量不回归
    var stale = await env.rpc('get-tasks', { sessionId: env.sid, ifHash: 'stalehash' })
    assert.ok(Array.isArray(stale.tasks) && stale.tasks.length === 40, 'ifHash 不一致 → 全量返回')
    assert.ok(!stale.unchanged)
    // includeArchived 即使 ifHash 一致也强制全量（归档 tab 数据源 fetchArchived 不带 ifHash，host 侧双保险）
    var arch = await env.rpc('get-tasks', { sessionId: env.sid, ifHash: full.tasksHash, includeArchived: true })
    assert.ok(Array.isArray(arch.tasks) && arch.tasks.length === 40, 'includeArchived 强制全量')
    assert.ok(!arch.unchanged)
    // 卡变化 → hash 变 → 旧 ifHash 失效返全量（含新卡）
    await env.rpc('create-task', { sessionId: env.sid, id: 'task-big-new', title: '新卡', description: 'd', pipeline: 'work' })
    var grown = await env.rpc('get-tasks', { sessionId: env.sid, ifHash: full.tasksHash })
    assert.ok(Array.isArray(grown.tasks) && grown.tasks.length === 41, '卡变化后旧 ifHash 失效 → 全量返回含新卡')
    assert.notEqual(grown.tasksHash, full.tasksHash, 'hash 随卡变化')
    assert.ok(!grown.unchanged)
  } finally { await env.cleanup() }
})

// ===== ③④ 客户端/host 接线（源码级）+ 产物重组装 =====
test('③④ 接线：fetchTasks 带 ifHash + unchanged 分支保留 state.tasks（源码级）+ client.js 产物重组装', () => {
  var ksrc = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
  var rpcSrc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  var built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 请求侧：state.tasksHash 非空才带 ifHash（首轮/会话切换后为空 → 全量拉取同老路径）
  assert.match(ksrc, /if \(state\.tasksHash\) rpcArgs\.ifHash = state\.tasksHash/)
  // 响应侧③：unchanged 优先于 hash 比对——缺 tasks 的轻量响应绝不清空 state.tasks
  assert.match(ksrc, /var unchanged = !!\(d && d\.unchanged\)/)
  assert.match(ksrc, /var tasksChanged = !unchanged && \(!newHash \|\| newHash !== state\.tasksHash\)/)
  // state.tasks 赋值只在 tasksChanged 分支内（unchanged 时保留不动）
  var iBranch = ksrc.indexOf('if (tasksChanged) {')
  var iAssign = ksrc.indexOf('state.tasks = (d && d.tasks) || []')
  assert.ok(iBranch >= 0 && iAssign > iBranch, 'state.tasks 赋值必须在 tasksChanged 分支内（unchanged 保留旧列表）')
  // host 侧：ifHash 一致且非 includeArchived → 剔 tasks + unchanged 标记
  assert.match(rpcSrc, /args\.ifHash && args\.ifHash === d\.tasksHash && !args\.includeArchived/)
  assert.match(rpcSrc, /delete __light\.tasks/)
  assert.match(rpcSrc, /__light\.unchanged = true/)
  // 归档 tab 数据源不带 ifHash（fetchArchived 只传 includeArchived）——双保险的客户端一半
  var fa = ksrc.match(/function fetchArchived\(\)[\s\S]*?\n    \}/)
  assert.ok(fa && fa[0].indexOf('ifHash') < 0, 'fetchArchived 不得带 ifHash（归档全量拉取）')
  // ④ 产物重组装：关键接线标记逐一出现在 lib/client.js
  for (const m of ['rpcArgs.ifHash = state.tasksHash', 'd && d.unchanged']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})
