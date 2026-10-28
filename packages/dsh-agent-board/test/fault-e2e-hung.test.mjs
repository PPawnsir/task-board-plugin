// dsh-agent-board — 故障 E2E：挂死零产出 600s 墙钟地板判死重派（task-mvqi3uj4-4，真循环形态；task-mvrt9tn5 阈值定稿；task-mvrvtamd-4 增 v2 帧活性 E2E④⑤）
// 事故类「挂死零产出」（原形：glm-5.2 连接开着永不响应，日志零增长 7 分钟人工才发现）的端到端回归。
// 机制锚点：hungZeroOutputSweep（lib/dispatch.mjs）双闸 = 连续 40 轮零增长 × 距基线 ≥600s 墙钟地板
//（固定值，task-mvrt9tn5：延迟缩放作废——延迟与长生成静默时长无关，三连误杀实证）
//（HUNG_ZERO_GROWTH_ROUNDS / HUNG_ZERO_GROWTH_MS 常量）；logSizeOf 走 findRunLog(sessionsRoot)。
// v2 帧活性主路径（task-mvrvtamd-2 agent/assistant-stream 帧订阅）：全局见过帧 + rec 可映射会话
//（continuable=childId）时主路径判「帧静默」——疑似 HUNG_FRAME_SUSPECT_MS(120s) → 🟡 stuckSince 标卡
// 不终止；判死 HUNG_FRAME_KILL_MS(600s) → settleRun 失败臂+熔断连击+重派全链复用（「帧静默 600s」文案）；
// 帧活体（frameDirty）即恢复：清基线，静默未满 600s 同步清疑似标卡。E2E④（emitFrame 续命→停帧→疑似
// 标卡→补一帧清除）/ E2E⑤（帧判死→冷复活→连击 fresh spawn→熔断拉黑）锁此主路径——mock-ctx emitFrame
// 重放帧事件，缺省 createMockCtx 不自动发帧（E2E①-③ 零帧环境 = 帧路径关闸时的日志双闸兜底回归）。
// 与薄桩 mkGateDispatch（settle-stop-interrupt.test.mjs 挂死①-⑤）互补——本套是「真循环形态」：
//   · 真 harness：真实 index.mjs apply(mockCtx)（与 integration.test.mjs 同一卡1 harness），不改生产代码；
//   · 真日志：pinHomedir 钉 USERPROFILE 到临时 HOME（Windows 下 findRunLog 回退 os.homedir() 所必须），
//     往 <home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd 写真 zstd 帧后停笔（零增长）；
//   · 真派发循环：kickCycle 50ms 去抖（advance(50)）驱动 spawn，15s 心跳（tick）驱动 sweep 轮；
//   · 墙钟闸：虚拟时钟推不动 Date.now 墙钟——patchBoard 把 zeroGrowthSince 按真实时间倒推 601s
//     （integration.test.mjs「patchBoard 把 claimedAt 按真实时间倒推」同款先例），再驱 40 轮心跳 → 判死。
// 断言纪律：E2E 下连击表（modelFailStreak/badModels）在 dispatch 闭包内不可直读——全部走行为证据：
//   卡面 runs 行（model/modelSource/outcome/endedAt/zeroGrowthRounds）、lastError、sendMessages、
//   新 spawn 的 request.agentOptions 有无（prov/hung 三连熔断后新 spawn 不再带它 = 拉黑生效）。
// 故障注入：board.workerModel='prov/hung'（patchBoard 注入；set-board-config 对非在册 id 会拒写——
//   mock llm 空 provider 清单下 enumModels 返回 [] 走拒写分支，故走 patchBoard）；
//   continuable worker spawn 后测试写真日志帧再停笔 = 「会话在但不干活」的挂死形态。
// 时钟纪律：Date.now 真实墙钟不动；advance(50) 只在 spawn 轮用（kickCycle 去抖），sweep 轮全走
//   tick()（手动触发 15s 心跳 interval，不动虚拟时间）——续跑死亡哨兵 5s / 软硬超时臂 30min/120min
//   均是 timer.timeout 虚拟定时，全程永不触发，判死唯一来源 = 挂死 sweep（真双闸）。
// 等待纪律（task-mvr4lplk 负载 flake 收敛）：waitFor 统一 20s 预算（W 常量，integration.test.mjs
//   :936-944 同款先例——全量 npm test 并行负载下真实 I/O 收敛显著变慢，5s 默认上限偶发超时，
//   两 Worker 独立同报）；仅放宽测试侧等待预算，不放松挂死判定语义（40 轮×600s 墙钟双闸断言逐字不变）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

// ===== 测试工具（与 integration.test.mjs 同形）=====
// waitFor 预算（task-mvr4lplk 负载 flake 收敛，integration.test.mjs:936-944 同款先例）：全量 npm test
// 并行进程负载下真实 I/O 收敛显著变慢（实测 5s 默认上限偶发超时，两 Worker 独立同报）——统一放宽到 20s。
// 仅放宽测试侧等待预算；挂死判定语义（40 轮×600s 墙钟双闸）是产品行为，断言逐字不变。
var W = 20000
// 一帧 v4 日志（与 lib/usage.mjs readLogFrames 同形：多帧 zstd 顺序拼接，帧内 jsonl）
function frameOf(events) { return zlib.zstdCompressSync(Buffer.from(events.map(function (e) { return JSON.stringify(e) }).join('\n') + '\n', 'utf8')) }

// 写一份 continuable 子会话日志（写真日志帧后停笔 = 零增长挂死形态）；返回日志路径与字节数。
// 布局与真实一致 <home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd（findRunLog 按桶探测）
function writeChildLog(env, childId, text) {
  var dir = path.join(env.home, '.dsh', 'sessions', 'test-bucket', childId)
  fs.mkdirSync(dir, { recursive: true })
  var ev = { type: 'assistant/message', time: Date.now(), seq: 1, data: { message: { content: [{ type: 'text', text: text }] } } }
  var p = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(p, frameOf([ev]))
  return { path: p, bytes: fs.statSync(p).size }
}

// 把 os.homedir() 钉到本用例临时 HOME（Windows 下认 USERPROFILE）；返回恢复闭包（finally 里先于 cleanup 调）
function pinHomedir(env) {
  var had = Object.prototype.hasOwnProperty.call(process.env, 'USERPROFILE')
  var prev = process.env.USERPROFILE
  process.env.USERPROFILE = env.home
  return function () { if (had) process.env.USERPROFILE = prev; else delete process.env.USERPROFILE }
}

// 建卡封装：显式 description 避开空描述软提示；其余字段按需透传
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '挂死E2E任务 ' + id, description: '挂死零产出 E2E 用例 ' + id }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  assert.equal(r.task.status, 'pending', '非 Team 模式即建即 pending: ' + id)
  return r.task
}

// 墙钟倒推（integration.test.mjs 先例）：patchBoard 把某行基线字段按真实墙钟倒推——缺省
// zeroGrowthSince 倒推 601s（601s > HUNG_WALL_FLOOR_MS(600000) 墙钟地板即过；task-mvrt9tn5 定稿：
// 固定 600s，不读健康表延迟——E2E 挂死模型无延迟数据同值）；v2 帧路径同款可测性（task-mvrvtamd-4
// E2E④⑤）：传 ('frameSilenceSince', 121000) 疑似 / ('frameSilenceSince', 601000) 判死倒推帧静默基线。
// 补丁前先排水（task-mvr4lplk 从固定 150ms 窗升级为「保底窗+条件收敛」）：waitFor 只等到了 sweep
// 的写盘，poolCycleBody 尾部的大锁段（池快照每轮重写）仍在飞——不排水补丁会被「读旧文档的在飞写」
// 覆盖（stale doc 回写），zeroGrowthSince 丢失墙钟闸永不过（mock-ctx cleanup 的 100ms 静默窗同款先例）。
// 150ms 保底窗保留原语义；随后轮询 board 文件内容，静默 50ms（无新写盘落定）才打补丁——负载下
// 固定窗可能不足以排干在飞写，条件收敛按实际写盘节奏自适应；3s 上限兜底（极端负载下不无限等待，
// 超上限继续，后续断言会暴露真问题）。
async function pushBackBaseline(env, taskId, childId, field, msBack) {
  field = field || 'zeroGrowthSince'
  msBack = typeof msBack === 'number' ? msBack : 601000
  var boardFile = path.join(env.home, '.dsh', 'tasks-' + env.sid + '.json')
  await new Promise(function (r) { setTimeout(r, 150) }) // 保底排水窗：烧完上一轮 poolCycle 的在飞写盘
  var t0 = Date.now()
  var lastContent = null
  var seen = false
  var lastChangeAt = t0
  for (;;) {
    var content = null
    try { content = fs.readFileSync(boardFile, 'utf8') } catch (_) {}
    if (!seen || content !== lastContent) { seen = true; lastContent = content; lastChangeAt = Date.now() }
    else if (Date.now() - lastChangeAt >= 50) break // 内容静默：在飞写盘已落定，补丁不会被 stale 回写冲掉
    if (Date.now() - t0 > 3000) break // 上限兜底：极端负载下不无限等待
    await new Promise(function (r) { setTimeout(r, 10) })
  }
  env.patchBoard(function (d) {
    var t = d.tasks.find(function (x) { return x.id === taskId })
    var row = (t.runs || []).find(function (r) { return String(r.id) === String(childId) && r.outcome === 'running' })
    assert.ok(row, '墙钟倒推目标行存在（在跑 run 留档）')
    row[field] = (typeof row[field] === 'number' ? row[field] : Date.now()) - msBack
  })
}

// 心跳驱 N 轮零增长：tick() 手动触发 15s 心跳 interval → poolCycle → sweep 轮；每轮 waitFor 计数
// 落盘再进下一轮（真 fs I/O 不定长，确保上一轮 sweep 写盘完成后才打下一轮心跳）。
// 只驱动「行还开着」的轮次（判死轮由调用方 tick 后 waitFor 关账结局——判死轮 outcome 已翻走）。
async function driveZeroGrowthRounds(env, taskId, childId, rounds) {
  for (var i = 1; i <= rounds; i++) {
    await env.clock.tick()
    var target = i
    await env.waitFor(function () {
      var t = env.task(taskId)
      var row = (t.runs || []).find(function (r) { return String(r.id) === String(childId) && r.outcome === 'running' })
      return row && row.zeroGrowthRounds === target ? row : null
    }, '零增长第 ' + target + ' 轮计数落盘', W)
  }
}

// 看某行基线字段是否已落（首轮 sweep 记基线的 waitFor 条件）
function baselineOf(env, taskId, childId) {
  return function () {
    var t = env.task(taskId)
    var row = (t.runs || []).find(function (r) { return String(r.id) === String(childId) && r.outcome === 'running' })
    return row && typeof row.lastLogBytes === 'number' && typeof row.zeroGrowthSince === 'number' ? row : null
  }
}

// 看某行帧静默基线是否已落（v2 帧活性主路径首见记基线的 waitFor 条件，E2E④⑤ 用）；outcome 过滤让
// 冷复活后的续跑行自然命中——同 id 双行取在跑那条，与 sweep 取行语义一致（dispatch.mjs 倒序取最新）。
function frameBaselineOf(env, taskId, childId) {
  return function () {
    var t = env.task(taskId)
    var row = (t.runs || []).find(function (r) { return String(r.id) === String(childId) && r.outcome === 'running' })
    return row && typeof row.frameSilenceSince === 'number' ? row : null
  }
}

// 共用引导（机械段）：独立临时 HOME + USERPROFILE 钉死 → 真 apply → 故障注入（板级模型钉 prov/hung）
// → 建卡 → 自动派发（continuable spawn，模型=prov/hung）。返回 { env, unpin, child, log }。
// 挂死编排段（写真日志帧/基线/倒推/心跳轮）由各用例内联——真循环形态的编排本身就是被测行为。
async function bootHungBoard(env, taskId) {
  var unpin = pinHomedir(env)
  plugin.apply(env.ctx)
  await createTask(env, taskId, { pipeline: 'full', acceptance: 'npm test' }) // 建卡先落盘（板文件存在后才能 patchBoard）
  env.patchBoard(function (d) { d.workerModel = 'prov/hung' }) // 故障注入：spawn 前落盘（下一轮取模链读到）
  await env.clock.advance(50) // kickCycle 50ms 去抖 → poolCycle → continuable spawn（模型=prov/hung）
  await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn 发生', W)
  var child = env.continuables[0]
  await env.waitFor(function () {
    var x = env.task(taskId)
    var r = x && x.runs && x.runs[0]
    return x && x.status === 'in-progress' && r && r.outcome === 'running' && r.model === 'prov/hung' ? x : null
  }, '落卡 in-progress 且 runs[0] running（model=prov/hung）', W)
  return { env: env, unpin: unpin, child: child }
}

// ===== E2E①：真日志零增长 40 轮 × 墙钟倒推 601s → 判死关账 + 自动重派续跑（真循环全链）=====
// 场景（真循环形态）：建卡 → continuable worker spawn 于 prov/hung → 写真日志帧后停笔（零增长）→
// 首轮 sweep 扫过只记基线 → patchBoard 把 zeroGrowthSince 倒推 601s → tick 驱 40 轮心跳 → 判死。
test('E2E挂死①：真日志零增长+墙钟倒推 601s → 40 轮心跳判死关账；判死后自动重派冷复活原子会话', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootHungBoard(env, 'task-hung-1')
    var child1 = boot.child
    // 写真日志帧后停笔（零增长）：「会话在但不干活」的挂死形态——真文件落 <home>/.dsh/sessions/
    var log = writeChildLog(env, child1.childId, '初始帧：worker 已 spawn，此后零产出（挂死形态）')
    // 首轮 sweep 扫过只记基线：lastLogBytes/zeroGrowthSince 落 runs 留档，不计数不判死
    await env.clock.tick()
    var row0 = await env.waitFor(baselineOf(env, 'task-hung-1', child1.childId), '首轮 sweep 记基线（lastLogBytes/zeroGrowthSince）', W)
    assert.equal(row0.lastLogBytes, log.bytes, '基线=真日志当前字节数（logSizeOf→findRunLog→statSync）')
    assert.equal(row0.zeroGrowthRounds, undefined, '首见只记基线不计数（绝不在第一眼判死）')
    assert.equal(row0.outcome, 'running', '基线轮不判死')
    // 墙钟倒推 601s（虚拟时钟推不动 Date.now，只能倒推基线）
    await pushBackBaseline(env, 'task-hung-1', child1.childId)
    // tick 驱 40 轮心跳 → 判死（双闸：40 轮零增长 × 距基线 ≥600s 地板）
    await driveZeroGrowthRounds(env, 'task-hung-1', child1.childId, 39)
    await env.clock.tick()
    await env.waitFor(function () { var x = env.task('task-hung-1'); return x && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null }, '第 40 轮判死关账', W)
    // 断言②：判死后自动重派发生（真循环：sweep 判死结算→同一轮 pickDispatch→tryResumeWorker）；
    // 连败软闸未达线（1 次失败 < 2，recentRuns 仅 1 条全败）→ 续跑健康闸放行 → 冷复活原子会话。
    // 先等重派完成再断言（判死轮的 pending 态随即被续跑翻走，直接断言 pending 有竞态）
    await env.waitFor(function () {
      var x = env.task('task-hung-1')
      var r2 = x && x.runs && x.runs.find(function (r) { return r.resume === true })
      return r2 && r2.outcome === 'running' && x.claimedBy === child1.childId ? r2 : null
    }, '判死后自动重派（续跑行落卡）', W)
    // 断言①：lastError 含「挂死」、runs[0] outcome=timeout/error、endedAt 落账（结算后稳定字段）
    var t = env.task('task-hung-1')
    assert.match(String(t.lastError || ''), /挂死/, '挂死原因落卡（lastError）')
    assert.match(String(t.lastError || ''), /零产出/, 'lastError 带零产出诊断')
    assert.equal(t.runs[0].outcome, 'timeout/error', '挂死 run 关账（settleRun 失败臂 err 路径）')
    assert.ok(t.runs[0].endedAt, '关账写 endedAt')
    assert.equal(t.runs[0].zeroGrowthRounds, 40, '判死轮计数=40（双闸轮数半边）')
    assert.equal(t.retryCount, 1, '失败计数照旧（失败臂语义不变）')
    assert.ok((t.history || []).some(function (h) { return h.from === 'in-progress' && h.to === 'pending' }), '失败臂重排留史（in-progress→pending）')
    t = env.task('task-hung-1')
    var resumeRow = t.runs.find(function (r) { return r.resume === true })
    assert.equal(resumeRow.id, child1.childId, '重派目标=原原子会话（同一 childId）')
    assert.equal(resumeRow.model, 'prov/hung', '续跑行 model 补齐归因（原模型经健康闸放行）')
    assert.equal(t.status, 'in-progress', '重派落卡 in-progress')
    assert.equal(t.claimedBy, child1.childId, '认领位回原子会话')
    var sm = env.sendMessages.find(function (m) { return m.childId === child1.childId })
    assert.ok(sm, '重派=sendMessage 冷复活原子会话（sendMessages 记录）')
    assert.match(String((sm.content || [])[0] && sm.content[0].text || ''), /断点续跑/, '冷复活文本=断点续跑指令')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// ===== E2E②：同病模型三连挂死 → 熔断拉黑行为证据（新 spawn 不再选 prov/hung）=====
// 连击表（modelFailStreak/badModels）在 dispatch 闭包内不可直读——行为证据链：
//   挂死#1（连击1）→ 重派续跑冷复活（健康闸放行）→ 挂死#2（连击2）→ 重派被连败软闸拦截改 fresh spawn
//   （recentRuns 2 全败，板级模型接手）→ 挂死#3（连击3）→ 熔断拉黑（卡 blocked）→ 新卡 spawn
//   不再选 prov/hung（request.agentOptions 缺席 + modelSource=parent = 取模链跳过熔断模型）。
test('E2E挂死②：同病模型三连挂死 → 熔断拉黑——新 spawn 不再选 prov/hung（agentOptions 缺席+modelSource=parent）', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootHungBoard(env, 'task-hung-c')
    var child1 = boot.child
    // ---- 挂死 #1：写真日志帧 → 基线 → 倒推 601s → 40 轮心跳 → 判死（连击 1）----
    var log1 = writeChildLog(env, child1.childId, '初始帧 #1')
    await env.clock.tick()
    await env.waitFor(baselineOf(env, 'task-hung-c', child1.childId), '挂死#1 基线落档', W)
    await pushBackBaseline(env, 'task-hung-c', child1.childId)
    await driveZeroGrowthRounds(env, 'task-hung-c', child1.childId, 39)
    await env.clock.tick()
    await env.waitFor(function () { var x = env.task('task-hung-c'); return x && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null }, '挂死#1 判死关账', W)
    // 挂死#1 后重派：连败软闸未达线（1 次失败）→ 冷复活同一会话（runs[1] resume）
    await env.waitFor(function () {
      var x = env.task('task-hung-c')
      var r2 = x && x.runs && x.runs.find(function (r) { return r.resume === true })
      return r2 && r2.outcome === 'running' && x.claimedBy === child1.childId ? r2 : null
    }, '挂死#1 后冷复活（resume 行落卡）', W)
    assert.equal(env.sendMessages.length, 1, '挂死#1 重派=sendMessage 冷复活恰一次')
    // ---- 挂死 #2：续跑行基线 → 倒推 601s → 40 轮心跳 → 判死（连击 2）----
    await env.clock.tick() // sweep 对续跑行首见记基线（同一会话日志未涨=复活后仍挂死）
    await env.waitFor(baselineOf(env, 'task-hung-c', child1.childId), '挂死#2 基线落档（续跑行）', W)
    await pushBackBaseline(env, 'task-hung-c', child1.childId)
    await driveZeroGrowthRounds(env, 'task-hung-c', child1.childId, 39)
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-hung-c')
      var r2 = x && x.runs && x.runs.find(function (r) { return r.resume === true })
      return r2 && r2.outcome === 'timeout/error' ? r2 : null
    }, '挂死#2 判死关账（resume 行）', W)
    // 挂死#2 后重派：连败软闸达线（recentRuns 2 全败）→ 续跑健康闸拦截 → fresh spawn（板级模型接手）
    await env.waitFor(function () {
      var x = env.task('task-hung-c')
      return x && x.runs && x.runs.length >= 3 && x.runs[2].outcome === 'running' && !x.runs[2].resume ? x.runs[2] : null
    }, '挂死#2 后 fresh spawn 落卡（续跑健康闸拦截改新会话）', W)
    var t2 = env.task('task-hung-c')
    assert.equal(t2.runs[2].model, 'prov/hung', 'fresh spawn 走板级模型（连击 2 < 3 未熔断，链首项照常在册）')
    assert.equal(t2.runs[2].modelSource, 'board', 'modelSource=board 留档')
    assert.equal(t2.runs[2].continuable, true, 'fresh spawn 是新 continuable 会话')
    assert.ok(t2.messages && t2.messages.some(function (m) { return m.kind === 'resume-fallback' }), '续跑放弃留痕（resume-fallback 消息）')
    var child2 = env.continuables[1]
    assert.ok(child2 && child2.childId !== child1.childId, 'fresh spawn 是新子会话（非冷复活）')
    assert.equal(env.sendMessages.length, 1, '连败软闸拦截后零第二次冷复活投递')
    // ---- 挂死 #3：写真日志帧 → 基线 → 倒推 601s → 40 轮心跳 → 判死（连击 3 → 熔断拉黑 + 卡 blocked）----
    var log2 = writeChildLog(env, child2.childId, '初始帧 #2（fresh spawn 后停笔）')
    await env.clock.tick()
    await env.waitFor(baselineOf(env, 'task-hung-c', child2.childId), '挂死#3 基线落档（fresh spawn 行）', W)
    assert.equal(env.task('task-hung-c').runs[2].lastLogBytes, log2.bytes, 'fresh spawn 行基线=其真日志字节数')
    await pushBackBaseline(env, 'task-hung-c', child2.childId)
    await driveZeroGrowthRounds(env, 'task-hung-c', child2.childId, 39)
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-hung-c')
      return x && x.status === 'blocked' && x.runs[2] && x.runs[2].outcome === 'timeout/error' ? x : null
    }, '挂死#3 判死关账 + 三连败 → 卡 blocked（worker 失败 x3 语义）', W)
    var t3 = env.task('task-hung-c')
    assert.match(String(t3.lastError || ''), /挂死/, '挂死#3 原因落卡')
    // ---- 熔断行为证据：新卡 spawn 不再选 prov/hung（badModels 已拉黑，备用链空 → 父模型兜底）----
    await createTask(env, 'task-hung-d', { pipeline: 'full', acceptance: 'npm test' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 3 }, '新卡 spawn 发生（熔断后取模链跳过病模型）', W)
    var child3 = env.continuables[2]
    await env.waitFor(function () {
      var x = env.task('task-hung-d')
      return x && x.status === 'in-progress' && x.runs && x.runs[0] && x.runs[0].outcome === 'running' ? x : null
    }, '新卡落卡', W)
    assert.equal(child3.request && child3.request.agentOptions, undefined, '新 spawn 不再带 prov/hung（agentOptions 缺席=熔断拉黑生效）')
    var t4 = env.task('task-hung-d')
    assert.equal(t4.runs[0].model, '', '新 spawn 模型留档为空（父模型兜底）')
    assert.equal(t4.runs[0].modelSource, 'parent', 'modelSource=parent（取模链跳过熔断模型，槽位/备用链均无健康者）')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// ===== E2E③：活体增长不误伤反例（settle-stop-interrupt 挂死②薄桩断言搬真循环）=====
// 增长中 run 不误伤：追加真日志字节 → 推进一轮 → 清零计数+刷新基线（zeroGrowthRounds 删除）；
// 且增长刷新的基线是真实墙钟 now——随后快轮 40 连零增长（轮数达 40）被 600s 墙钟地板兜住不判死
// （写风暴下纯轮数会秒判刚 spawn 的 run——双闸的墙钟半边在真循环里直证）。
test('E2E挂死③：活体增长清零计数+刷新基线不误伤；增长后快轮 40 连被 600s 墙钟地板兜住', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootHungBoard(env, 'task-hung-l')
    var child = boot.child
    var log = writeChildLog(env, child.childId, '初始帧：worker 已 spawn')
    await env.clock.tick()
    var row = await env.waitFor(baselineOf(env, 'task-hung-l', child.childId), '基线落档', W)
    assert.equal(row.lastLogBytes, log.bytes, '基线=真日志字节数')
    // 墙钟倒推 601s → 3 轮零增长（轮数 3 < 40，未达轮数闸）
    await pushBackBaseline(env, 'task-hung-l', child.childId)
    await driveZeroGrowthRounds(env, 'task-hung-l', child.childId, 3)
    assert.equal(env.task('task-hung-l').runs[0].outcome, 'running', '3 轮 < 40 不判死')
    // 反例：追加真日志帧（活体增长）→ 推进一轮 → 清零计数+刷新基线
    var ev2 = { type: 'assistant/message', time: Date.now(), seq: 2, data: { message: { content: [{ type: 'text', text: '活体增长帧：worker 真在干活' }] } } }
    fs.appendFileSync(log.path, frameOf([ev2]))
    var grown = fs.statSync(log.path).size
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-hung-l'); var r = x && x.runs[0]
      return r && r.lastLogBytes === grown && r.zeroGrowthRounds === undefined ? r : null
    }, '活体增长：清零计数+刷新基线（薄桩挂死②同款断言）', W)
    assert.equal(env.task('task-hung-l').runs[0].lastLogBytes, grown, '基线刷新到最新字节数')
    // 增长后的基线是真实墙钟 now：再快轮 40 连零增长（轮数达 40）→ 600s 墙钟地板兜住不判死
    await driveZeroGrowthRounds(env, 'task-hung-l', child.childId, 39)
    await env.clock.tick()
    var t = await env.waitFor(function () {
      var x = env.task('task-hung-l'); var r = x && x.runs[0]
      return r && r.zeroGrowthRounds === 40 && r.outcome === 'running' ? r : null
    }, '零增长轮数按真实心跳累计到 40', W)
    assert.equal(t.zeroGrowthRounds, 40, '轮数半边达线（40 轮零增长）')
    assert.equal(t.outcome, 'running', '600s 墙钟地板兜住：活体增长刷新基线后快轮 40 连不判死（写风暴防秒判）')
    // 全程零误伤：卡在跑、零 lastError、零重派
    var card = env.task('task-hung-l')
    assert.equal(card.status, 'in-progress', '全程零误伤（卡保持 in-progress）')
    assert.ok(!card.lastError, '零 lastError（未判死）')
    assert.equal(env.continuables.length, 1, '零重派（无冷复活/新 spawn）')
    assert.equal(env.sendMessages.length, 0, '零续跑投递')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// ===== E2E④：v2 帧活性主路径——emitFrame 续命 → 停帧 → 倒推 frameSilenceSince 121s → 🟡疑似标卡；补一帧 → 疑似清除 =====
// 场景（真循环形态）：continuable worker spawn 于 prov/hung → emitFrame 续命（帧活体 sweep 走恢复臂，
// 零标记零留档）→ 停帧 → tick 驱心跳（首见记 frameSilenceSince=lastFrameAt 基线）→ patchBoard 倒推 121s
//（> HUNG_FRAME_SUSPECT_MS 120s，< 600s 判死线）→ 🟡疑似：stuckSince 落卡、卡仍 in-progress、零判死零重派
// 零熔断；重复 sweep 不重复标卡 → 补一帧 → 帧恢复（静默不足 600s）→ 疑似清除+基线删除。
test('E2E挂死④：emitFrame 续命→停帧→倒推 frameSilenceSince 121s → 疑似标卡不判死；补一帧 → 疑似清除', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootHungBoard(env, 'task-hung-s')
    var child = boot.child
    // ---- 阶段 A：emitFrame 续命（帧活体）→ 停帧 → 心跳 sweep 首见记帧基线 ----
    var tFrame = Date.now()
    env.emitFrame(child.childId) // assistant-stream 帧：rec.lastFrameAt=now+frameDirty（仅内存不写盘）
    await env.clock.tick() // 活体 sweep：frameDirty 消费走恢复臂——零帧期零基线（续命证据）
    await env.clock.tick() // 停帧后 sweep：frameSince=0 → 基线=lastFrameAt 首见落档
    var row = await env.waitFor(frameBaselineOf(env, 'task-hung-s', child.childId), '停帧后帧基线首见落档', W)
    assert.ok(row.frameSilenceSince >= tFrame, '基线锚定最近帧时间（lastFrameAt，非 startedAt 兜底）')
    assert.ok(row.frameSilenceSince <= Date.now(), '基线是真实墙钟时刻（虚拟时钟推不动）')
    assert.equal(row.zeroGrowthRounds, undefined, '帧路径不计数（日志 40 轮半边不参与）')
    assert.equal(row.lastLogBytes, undefined, '帧活性主路径启用 → 日志双闸旁路（sizes 预读跳过）')
    assert.equal(row.outcome, 'running', '续命期零判死')
    assert.ok(!env.task('task-hung-s').stuckSince, '续命期零疑似（帧活体扫过零标记）')
    // ---- 阶段 B：patchBoard 倒推 frameSilenceSince 121s → 🟡疑似标卡（不判死不重派）----
    await pushBackBaseline(env, 'task-hung-s', child.childId, 'frameSilenceSince', 121000)
    await env.clock.tick()
    var t = await env.waitFor(function () { var x = env.task('task-hung-s'); return x && x.stuckSince ? x : null }, '帧静默 121s → 疑似标卡', W)
    assert.ok(typeof t.stuckSince === 'number' && t.stuckSince <= Date.now(), 'stuckSince 落卡（真实墙钟）')
    assert.ok((t.history || []).some(function (h) { return /疑似卡顿/.test(h.note) && /帧静默 120s/.test(h.note) }), '🟡 疑似留史（assistant 帧静默 120s，仅标卡不终止）')
    await env.clock.tick() // 重复 sweep：!t.stuckSince 守卫——不重复标卡
    assert.equal((env.task('task-hung-s').history || []).filter(function (h) { return /疑似卡顿/.test(h.note) }).length, 1, '重复 sweep 幂等（疑似不重复标卡）')
    t = env.task('task-hung-s')
    assert.equal(t.status, 'in-progress', '疑似不翻状态（仅标卡不终止）')
    assert.equal(env.task('task-hung-s').runs[0].outcome, 'running', '零判死（121s < 600s 判死线）')
    assert.ok(!t.lastError, '零 lastError')
    assert.equal(t.retryCount, undefined, '零失败计数（疑似不喂熔断连击）')
    assert.equal(env.sendMessages.length, 0, '零重派（零冷复活投递）')
    assert.equal(env.continuables.length, 1, '零新 spawn（零熔断拉黑行为）')
    // ---- 阶段 C：补一帧 → 帧恢复（静默不足 600s）→ 疑似清除+基线删除 ----
    env.emitFrame(child.childId, { type: 'chunk', index: 2, time: Date.now() }) // 显式帧形状（reasoning-delta 同理全算活）
    await env.clock.tick()
    t = await env.waitFor(function () {
      var x = env.task('task-hung-s')
      var r = x && x.runs && x.runs.find(function (r) { return String(r.id) === String(child.childId) && r.outcome === 'running' })
      return x && !x.stuckSince && r && r.frameSilenceSince === undefined ? x : null
    }, '补一帧 → 帧恢复：疑似清除+基线删除', W)
    assert.ok((t.history || []).some(function (h) { return /帧恢复/.test(h.note) && /清除疑似卡顿标记/.test(h.note) }), '帧恢复留史（静默不足 600s 清标）')
    assert.equal(t.status, 'in-progress', '恢复后卡保持 in-progress')
    assert.equal(env.sendMessages.length, 0, '恢复零重派')
    assert.equal(env.continuables.length, 1, '恢复零新 spawn')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// ===== E2E⑤：v2 帧路径判死——停帧 + 倒推 frameSilenceSince 601s → 判死关账 + 冷复活 + 连击 fresh spawn + 熔断拉黑 =====
// 场景（真循环形态）：emitFrame 激活帧观测面 → 停帧 → 帧基线落档 → patchBoard 倒推 601s
//（> HUNG_FRAME_KILL_MS 600s）→ 帧判死关账（timeout/error、endedAt、lastError「挂死+帧静默 600s」；
// 帧路径不计数 zeroGrowthRounds 缺席——与日志路径 40 轮双闸对照）→ 自动重派冷复活（连败软闸未达线，
// sendMessages/断点续跑文本断言照搬 E2E① L168-193 形态）→ 复活后仍挂死二次帧判死（连败软闸达线）→
// fresh spawn（连击行为证据）→ 三连帧判死 → 熔断拉黑 → 新卡 spawn 不再选 prov/hung。
test('E2E挂死⑤：帧静默倒推 601s → 判死关账+冷复活；二次帧判死连击 fresh spawn；三连熔断拉黑新卡不带 prov/hung', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootHungBoard(env, 'task-hung-f')
    var child1 = boot.child
    // ---- 挂死 #1（连击 1）：emitFrame 激活帧面 → 停帧 → 帧基线落档 → 倒推 601s → 帧判死 ----
    env.emitFrame(child1.childId) // 激活帧观测面（frameStreamSeen）+ lastFrameAt 基线锚
    await env.clock.tick() // 活体 sweep：frameDirty 消费走恢复臂（零基线）
    await env.clock.tick() // 停帧后 sweep：frameSince=0 → 基线=lastFrameAt 首见落档
    await env.waitFor(frameBaselineOf(env, 'task-hung-f', child1.childId), '挂死#1 帧基线落档', W)
    assert.equal(env.task('task-hung-f').runs[0].lastLogBytes, undefined, '帧路径启用 → 日志基线旁路')
    await pushBackBaseline(env, 'task-hung-f', child1.childId, 'frameSilenceSince', 601000)
    await env.clock.tick()
    await env.waitFor(function () { var x = env.task('task-hung-f'); return x && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null }, '挂死#1 帧判死关账', W)
    // ---- 自动重派冷复活（E2E① L168-193 形态照搬）：连败软闸未达线（1 次失败 < 2）→ 健康闸放行 ----
    // 先等重派完成再断言（判死轮的 pending 态随即被续跑翻走，直接断言 pending 有竞态）
    await env.waitFor(function () {
      var x = env.task('task-hung-f')
      var r2 = x && x.runs && x.runs.find(function (r) { return r.resume === true })
      return r2 && r2.outcome === 'running' && x.claimedBy === child1.childId ? r2 : null
    }, '帧判死后自动重派（续跑行落卡）', W)
    var t = env.task('task-hung-f')
    assert.match(String(t.lastError || ''), /挂死/, '挂死原因落卡（lastError）')
    assert.match(String(t.lastError || ''), /帧静默 600s/, 'lastError 带帧语义诊断（判死文案「帧静默 600s」）')
    assert.equal(t.runs[0].outcome, 'timeout/error', '挂死 run 关账（settleRun 失败臂 err 路径）')
    assert.ok(t.runs[0].endedAt, '关账写 endedAt')
    assert.equal(t.runs[0].zeroGrowthRounds, undefined, '帧路径不计数（对照日志路径 40 轮双闸）')
    assert.equal(t.retryCount, 1, '失败计数照旧（帧判死=失败臂语义，熔断连击+1 的卡面留痕）')
    assert.ok((t.history || []).some(function (h) { return h.from === 'in-progress' && h.to === 'pending' }), '失败臂重排留史（in-progress→pending）')
    var resumeRow = t.runs.find(function (r) { return r.resume === true })
    assert.equal(resumeRow.id, child1.childId, '重派目标=原原子会话（同一 childId）')
    assert.equal(resumeRow.model, 'prov/hung', '续跑行 model 补齐归因（原模型经健康闸放行）')
    assert.equal(t.status, 'in-progress', '重派落卡 in-progress')
    assert.equal(t.claimedBy, child1.childId, '认领位回原子会话')
    var sm = env.sendMessages.find(function (m) { return m.childId === child1.childId })
    assert.ok(sm, '重派=sendMessage 冷复活原子会话（sendMessages 记录）')
    assert.match(String((sm.content || [])[0] && sm.content[0].text || ''), /断点续跑/, '冷复活文本=断点续跑指令')
    // ---- 挂死 #2（连击 2）：复活后仍挂死（零新帧）→ 续跑行帧基线 → 倒推 601s → 帧判死 ----
    await env.clock.tick() // sweep 对续跑行首见记帧基线（同一会话复活后仍零帧=复活后仍挂死）
    await env.waitFor(frameBaselineOf(env, 'task-hung-f', child1.childId), '挂死#2 帧基线落档（续跑行）', W)
    await pushBackBaseline(env, 'task-hung-f', child1.childId, 'frameSilenceSince', 601000)
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-hung-f')
      var r2 = x && x.runs && x.runs.find(function (r) { return r.resume === true })
      return r2 && r2.outcome === 'timeout/error' ? r2 : null
    }, '挂死#2 帧判死关账（续跑行）', W)
    // ---- 连击行为证据：连败软闸达线（recentRuns 2 全败）→ 续跑健康闸拦截 → fresh spawn（板级模型接手）----
    await env.waitFor(function () {
      var x = env.task('task-hung-f')
      return x && x.runs && x.runs.length >= 3 && x.runs[2].outcome === 'running' && !x.runs[2].resume ? x.runs[2] : null
    }, '挂死#2 后 fresh spawn 落卡（续跑健康闸拦截改新会话）', W)
    var t2 = env.task('task-hung-f')
    assert.equal(t2.runs[2].model, 'prov/hung', 'fresh spawn 走板级模型（连击 2 < 3 未熔断，链首项照常在册）')
    assert.equal(t2.runs[2].modelSource, 'board', 'modelSource=board 留档')
    assert.equal(t2.runs[2].continuable, true, 'fresh spawn 是新 continuable 会话')
    assert.ok(t2.messages && t2.messages.some(function (m) { return m.kind === 'resume-fallback' }), '续跑放弃留痕（resume-fallback 消息）')
    assert.equal(env.sendMessages.length, 1, '连败软闸拦截后零第二次冷复活投递')
    var child2 = env.continuables[1]
    assert.ok(child2 && child2.childId !== child1.childId, 'fresh spawn 是新子会话（非冷复活）')
    // ---- 挂死 #3（连击 3 → 熔断拉黑 + 卡 blocked）：帧面已激活，零帧新行基线照落 → 倒推 601s → 帧判死 ----
    await env.clock.tick()
    await env.waitFor(frameBaselineOf(env, 'task-hung-f', child2.childId), '挂死#3 帧基线落档（fresh spawn 行）', W)
    assert.equal(env.task('task-hung-f').runs[2].lastLogBytes, undefined, '帧路径启用 → fresh spawn 行零日志基线')
    await pushBackBaseline(env, 'task-hung-f', child2.childId, 'frameSilenceSince', 601000)
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-hung-f')
      return x && x.status === 'blocked' && x.runs[2] && x.runs[2].outcome === 'timeout/error' ? x : null
    }, '挂死#3 帧判死关账 + 三连败 → 卡 blocked（worker 失败 x3 语义）', W)
    var t3 = env.task('task-hung-f')
    assert.match(String(t3.lastError || ''), /帧静默/, '挂死#3 帧语义落卡')
    assert.equal(t3.retryCount, 3, '三次帧判死各计一次失败（熔断连击 3 = 拉黑线）')
    // ---- 熔断拉黑行为证据：新卡 spawn 不再选 prov/hung（badModels 已拉黑，备用链空 → 父模型兜底）----
    await createTask(env, 'task-hung-e', { pipeline: 'full', acceptance: 'npm test' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 3 }, '新卡 spawn 发生（熔断后取模链跳过病模型）', W)
    var child3 = env.continuables[2]
    await env.waitFor(function () {
      var x = env.task('task-hung-e')
      return x && x.status === 'in-progress' && x.runs && x.runs[0] && x.runs[0].outcome === 'running' ? x : null
    }, '新卡落卡', W)
    assert.equal(child3.request && child3.request.agentOptions, undefined, '新 spawn 不再带 prov/hung（agentOptions 缺席=熔断拉黑生效）')
    var t4 = env.task('task-hung-e')
    assert.equal(t4.runs[0].model, '', '新 spawn 模型留档为空（父模型兜底）')
    assert.equal(t4.runs[0].modelSource, 'parent', 'modelSource=parent（取模链跳过熔断模型，槽位/备用链均无健康者）')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})
