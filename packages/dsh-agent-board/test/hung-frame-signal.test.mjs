// dsh-agent-board — 机制锁单测：assistant-stream 帧活性双层判定全边界（task-mvrvtamd-3）
// docs/fault-injection.md §三 双落纪律的机制锁半边：帧活性判定路径（onAssistantFrame 订阅 +
// hungZeroOutputSweep 帧主路径）的单元级行为断言；fault-e2e-hung.test.mjs 是接缝锁半边（真循环
// 形态），两套互补。挂死检测 v2（task-mvrvtamd-2 落地，lib/dispatch.mjs）：120s 零帧疑似标卡
// （仅标卡不终止）、600s 零帧判死重派（复用既有 settleRun/HUNG_KILL_PREFIX/熔断连击链）；日志
// 零增长双闸保留为无帧流/不可映射 rec 的兜底，存量语义逐字不变。
//
// 必锁场景（卡面七条）：①帧持续刷新（含 reasoning-delta chunk）→ 120s/600s 均不判、stuckSince
// 不出现；②零帧 ≥120s → stuckSince 落卡+ah 留史，不杀不喂熔断、卡保持 in-progress；③疑似后帧
// 恢复 → stuckSince 清除、零判死；④零帧 ≥600s → outcome=timeout/error + lastError 含「挂死」+
// 熔断连击 + 自动重派；⑤老宿主形态（ctx.on 缺席/全程零帧）→ 日志双闸兜底逐字照旧；⑥映射边界：
// 老 start 一次性 run（rec.id≠会话 id）即使全局已有帧观测也走日志闸，不被帧路径误杀；⑦verifier
// 在跑 run 帧路径覆盖（对齐 settle-stop-interrupt 薄桩挂死⑤的 verifier 语义）。
//
// 编排：全部用 createMockCtx + env.emitFrame（test/helpers/mock-ctx.mjs 卡1 已供桩，start/chunk/
// end 三态重放）+ 真 index.mjs apply（与 integration.test.mjs 同一 harness，不改生产代码）。帧路径
// 零 fs 日志依赖（logSizeOf 对可映射 rec 跳过）；日志闸场景（⑤⑥）靠「日志缺失→logSizeOf=0」
// （findRunLog 找不到返回 null→0）驱动轮数半边，无需写真 zstd 帧。
//
// 时钟纪律：Date.now 真实墙钟不动；虚拟时钟推不动 Date.now——挂死编排按 fault-e2e-hung.test.mjs
// L79-100 pushBackBaseline 同款先例，patchBoard 把 runs 留档基线字段按真实墙钟倒推，再 tick() 手动
// 触发 15s 心跳（poolCycle → sweep 轮；tick 不动虚拟时间，软/硬超时臂全程永不触发）。
//
// 断言纪律：连击表（modelFailStreak/badModels）/活跃 rec 表在 dispatch 闭包内不可直读——全部走
// 行为证据：卡面字段（stuckSince/lastError/runs 行/verifyRetries）、history（ah 留史）、
// sendMessages、spawn 请求 agentOptions 有无（熔断拉黑生效）、spawn 会话数。
//
// 等待纪律（task-mvr4lplk 负载 flake 收敛）：waitFor 统一 20s 预算（W 常量，fault-e2e-hung
// .test.mjs L37 同款先例——全量 npm test 并行负载下真实 I/O 收敛显著变慢）；仅放宽测试侧等待
// 预算，不放松挂死判定语义（120s/600s 阈值断言逐字不变）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

// waitFor 预算（fault-e2e-hung.test.mjs L37 同款）：仅放宽测试侧等待预算；判定语义是产品行为
var W = 20000

// ===== 测试工具 =====

// 找在跑 run 留档行（id 匹配 + outcome=running；同 id 首派+续跑取最新一条，dispatch sweep 同款倒序）
function runningRow(env, taskId, runId) {
  return function () {
    var t = env.task(taskId)
    var rows = (t && t.runs) || []
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i]
      if (r && String(r.id) === String(runId) && r.outcome === 'running') return r
    }
    return null
  }
}

// 建卡封装（fault-e2e-hung.test.mjs L61-68 同形）：显式 description 避开空描述软提示
async function createTask(env, id, extra) {
  var args = { sessionId: env.sid, id: id, title: '帧活性单测 ' + id, description: '帧活性双层判定机制锁用例 ' + id }
  if (extra) { for (var k in extra) args[k] = extra[k] }
  var r = await env.rpc('create-task', args)
  assert.equal(r.ok, true, 'create-task 成功: ' + id)
  assert.equal(r.task.status, 'pending', '非 Team 模式即建即 pending: ' + id)
  return r.task
}

// 把 os.homedir() 钉到本用例临时 HOME（Windows 下认 USERPROFILE；findRunLog 回退 os.homedir() 所必须，
// 钉死后日志闸读临时空目录 → logSizeOf=0，且不扫真实家目录）；返回恢复闭包（finally 里先于 cleanup 调）
// ——与 fault-e2e-hung.test.mjs L53-58 同款。
function pinHomedir(env) {
  var had = Object.prototype.hasOwnProperty.call(process.env, 'USERPROFILE')
  var prev = process.env.USERPROFILE
  process.env.USERPROFILE = env.home
  return function () { if (had) process.env.USERPROFILE = prev; else delete process.env.USERPROFILE }
}

// 排水后按真实墙钟倒推 runs 留档基线字段（pushBackBaseline 先例 fault-e2e-hung.test.mjs L79-100 同款
// 三段式：150ms 保底排水窗 + 内容静默 50ms 收敛 + 3s 上限兜底——防「读旧文档的在飞写」覆盖补丁）。
// 虚拟时钟推不动 Date.now 墙钟，只能倒推持久基线；field：'frameSilenceSince'（帧主路径）/
// 'zeroGrowthSince'（日志双闸）。
// 补丁落定自证（负载 flake 收敛）：patchBoard 直写后留 150ms 静默窗再回读板面确认倒推量在位——
// 写风暴下 50ms 静默窗也可能漏排在飞 stale 写（补丁被冲掉 → 判死编排假超时），被冲掉则重打（最多 3 次）。
async function pushBackBaseline(env, taskId, runId, field, minusMs) {
  var boardFile = path.join(env.home, '.dsh', 'tasks-' + env.sid + '.json')
  for (var attempt = 1; attempt <= 3; attempt++) {
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
    var target = null
    env.patchBoard(function (d) {
      var t = d.tasks.find(function (x) { return x.id === taskId })
      var row = (t.runs || []).find(function (r) { return String(r.id) === String(runId) && r.outcome === 'running' })
      assert.ok(row, '墙钟倒推目标行存在（在跑 run 留档）')
      target = (typeof row[field] === 'number' ? row[field] : Date.now()) - minusMs
      row[field] = target
    })
    // 落定自证：留 150ms 让残余在飞写落定，再回读确认补丁在位；被冲掉则重打
    await new Promise(function (r) { setTimeout(r, 150) })
    var okNow = false
    try {
      var d2 = JSON.parse(fs.readFileSync(boardFile, 'utf8'))
      var t2 = d2.tasks.find(function (x) { return x.id === taskId })
      var row2 = (t2.runs || []).find(function (r) { return String(r.id) === String(runId) && r.outcome === 'running' })
      okNow = !!(row2 && row2[field] === target)
    } catch (_) {}
    if (okNow) return
  }
  throw new Error('墙钟倒推补丁三次未落定（在飞写覆盖）: task ' + taskId + ' run ' + runId + ' field ' + field)
}

// 共用引导（机械段，fault-e2e-hung bootHungBoard 同形）：临时 HOME + USERPROFILE 钉死 → 真 apply →
// （可选板级模型注入，熔断归因需要模型；set-board-config 对非在册 id 拒写 → patchBoard 注入，
// fault-e2e-hung L16-17 同款）→ 建卡 → 自动派发（kickCycle 50ms 去抖）→ 等落卡。返回 { unpin, child }。
async function bootWorkerBoard(env, taskId, boardPatch) {
  var unpin = pinHomedir(env)
  plugin.apply(env.ctx)
  await createTask(env, taskId, { pipeline: 'full', acceptance: 'npm test' })
  if (boardPatch) env.patchBoard(boardPatch) // 建卡先落盘（板文件存在后才能 patchBoard）
  await env.clock.advance(50) // kickCycle 50ms 去抖 → poolCycle → continuable spawn
  await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn 发生', W)
  var child = env.continuables[0]
  await env.waitFor(function () {
    var x = env.task(taskId)
    return x && x.status === 'in-progress' && x.runs && x.runs[0] && x.runs[0].outcome === 'running' ? x : null
  }, '落卡 in-progress 且 runs[0] running', W)
  return { unpin: unpin, child: child }
}

// 首轮帧基线（帧主路径基线写入时序）：emitFrame 置 frameStreamSeen+rec 映射+lastFrameAt →
// 第一轮 tick 消费 dirty（recovery 空：无基线可删、无 stuck 可清）→ 第二轮 tick 零帧 sweep 写基线
// （frameSilenceSince = lastFrameAt）。返回基线落档后的在跑行。
async function primeFrameBaseline(env, taskId, childId) {
  env.emitFrame(childId)
  await env.clock.tick()
  await env.clock.tick()
  return env.waitFor(function () {
    var row = runningRow(env, taskId, childId)()
    return row && typeof row.frameSilenceSince === 'number' ? row : null
  }, '零帧 sweep 记帧基线（frameSilenceSince 落 runs 留档）', W)
}

// 帧路径判死一轮：倒推 frameSilenceSince ≥600s（帧主路径无轮数闸，墙钟到线即判）→ 一轮 sweep 判死
// 关账（settleRun 失败臂）。返回 timeout/error 行。
async function frameKill(env, taskId, runId) {
  await pushBackBaseline(env, taskId, runId, 'frameSilenceSince', 601000)
  await env.clock.tick()
  return env.waitFor(function () {
    var t = env.task(taskId)
    var rows = (t && t.runs) || []
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i] && String(rows[i].id) === String(runId) && rows[i].outcome === 'timeout/error') return rows[i]
    }
    return null
  }, '600s 帧静默判死关账', W)
}

// ===== 帧①：帧持续刷新（含 reasoning-delta chunk）→ 120s/600s 均不判、stuckSince 不出现 =====
// start/chunk/end 全算活、chunk 不过滤 type（reasoning-delta 同样刷新 lastFrameAt，dispatch.mjs
// L1797-1799）；帧只进内存（lastFrameAt/frameDirty），sweep 每轮走 recovery 空（无基线可删、无
// stuck 可清）→ 疑似/判死永不触发。40 轮 = 日志双闸的完整轮数预算（600s/15s），帧路径下零积累。
test('帧①：帧持续刷新（含 reasoning-delta chunk）40 轮心跳 → 120s/600s 均不判、stuckSince 不出现', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootWorkerBoard(env, 'task-frame-live')
    var child = boot.child
    for (var i = 1; i <= 40; i++) {
      // 偶数轮发 reasoning-delta chunk：chunk 不过滤 type 的边界锁定（任意形状帧同算活）
      env.emitFrame(child.childId, i % 2 === 0
        ? { type: 'reasoning-delta', index: i, time: Date.now() }
        : { type: 'chunk', index: i, time: Date.now() })
      await env.clock.tick()
    }
    // 收尾等一拍：40 轮在飞 sweep 链落定（真实 I/O 不定长），断言拿稳态
    await new Promise(function (r) { setTimeout(r, 500) })
    var t = env.task('task-frame-live')
    assert.equal(t.status, 'in-progress', '帧持续刷新：卡保持 in-progress')
    assert.equal(t.runs[0].outcome, 'running', '零判死（run 仍 running）')
    assert.equal(t.stuckSince, undefined, 'stuckSince 不出现（120s 疑似不触发）')
    assert.ok(!t.lastError, '零 lastError（未判死）')
    assert.equal(env.continuables.length, 1, '零重派（无冷复活/新 spawn）')
    assert.equal(env.sendMessages.length, 0, '零续跑投递（不杀不重派）')
    assert.equal(env.interrupts.length, 0, '零 interrupt（仅观测，不终止）')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// ===== 帧②：零帧 ≥120s → stuckSince 落卡 + ah 留史；不杀、不喂熔断连击、卡保持 in-progress =====
// 边界用留 2s+ 余量：pushBack 倒推量按「100s 不判 / 再推 25s（共 ≥125s）判」编排——负载下真实
// 墙钟在倒推与 sweep 之间仍会漂移几秒，100s 底留足距 120s 的余量防漂移过线误判。
test('帧②：零帧 ≥120s → stuckSince 落卡 + ah 留史疑似（仅标卡不终止）；不杀、卡保持 in-progress', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootWorkerBoard(env, 'task-frame-suspect')
    var child = boot.child
    // 首轮帧基线：emitFrame → 消费 dirty → 零帧 sweep 写基线（frameSilenceSince = lastFrameAt）
    var row = await primeFrameBaseline(env, 'task-frame-suspect', child.childId)
    assert.equal(row.outcome, 'running', '基线轮不判死')
    // 边界下：100s < 120s → 不落疑似（负断言后 settle 一拍再查）
    await pushBackBaseline(env, 'task-frame-suspect', child.childId, 'frameSilenceSince', 100000)
    await env.clock.tick()
    await new Promise(function (r) { setTimeout(r, 300) }) // sweep 在飞写盘落定
    assert.equal(env.task('task-frame-suspect').stuckSince, undefined, '100s < 120s：不落疑似（HUNG_FRAME_SUSPECT_MS 下边界）')
    // 边界上：再推 25s（共 ≥125s ≥ 120s）→ 疑似落卡
    await pushBackBaseline(env, 'task-frame-suspect', child.childId, 'frameSilenceSince', 25000)
    await env.clock.tick()
    var t = await env.waitFor(function () {
      var x = env.task('task-frame-suspect')
      return x && typeof x.stuckSince === 'number' ? x : null
    }, '≥120s 疑似：stuckSince 落卡', W)
    // ah 留史：疑似标注逐字（actor=rec id、note=🟡 疑似卡顿+120s+仅标卡不终止）
    var suspects = (t.history || []).filter(function (h) { return /疑似卡顿/.test(h.note || '') })
    assert.equal(suspects.length, 1, 'ah 留史恰一条疑似标注')
    assert.match(suspects[0].note, /120s/, '疑似文案带 120s 阈值')
    assert.match(suspects[0].note, /仅标卡，不终止/, '疑似文案带「仅标卡，不终止」语义')
    assert.equal(suspects[0].actor, child.childId, '疑似留史 actor=rec id')
    // 不杀：卡/run 状态零变化、零重派零 interrupt（不喂熔断连击=零判死零 settle）
    assert.equal(t.status, 'in-progress', '疑似不杀：卡保持 in-progress')
    assert.equal(t.runs[0].outcome, 'running', 'run 不关账（仅标卡）')
    assert.ok(!t.lastError, '未判死（零 lastError）')
    assert.equal(env.sendMessages.length, 0, '零重派投递（不喂续跑）')
    assert.equal(env.continuables.length, 1, '零新 spawn（不杀）')
    assert.equal(env.interrupts.length, 0, '零 interrupt（仅标卡不终止）')
    // 幂等：疑似后同态 sweep 不重复标注（!t.stuckSince 守卫）
    await env.clock.tick()
    await new Promise(function (r) { setTimeout(r, 300) })
    assert.equal((env.task('task-frame-suspect').history || []).filter(function (h) { return /疑似卡顿/.test(h.note || '') }).length, 1, '同态 sweep 不重复疑似标注')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// ===== 帧③：疑似后帧恢复 → stuckSince 清除、零判死 =====
// 帧恢复=事件只置内存 dirty，sweep 消费才算：删持久基线（frameSilenceSince）+ 静默未满 600s 同步
// 清疑似标卡（dispatch.mjs L2238-2246 recovery 分支）。
test('帧③：疑似后帧恢复 → stuckSince 清除 + ah 留史帧恢复；零判死', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootWorkerBoard(env, 'task-frame-recover')
    var child = boot.child
    // 前置状态：帧基线 → 倒推 125s → 疑似落卡
    await primeFrameBaseline(env, 'task-frame-recover', child.childId)
    await pushBackBaseline(env, 'task-frame-recover', child.childId, 'frameSilenceSince', 125000)
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-frame-recover')
      return x && typeof x.stuckSince === 'number' ? x : null
    }, '疑似落卡（前置状态）', W)
    // 帧恢复：emitFrame 置 dirty → 下一轮 sweep 走 recovery：删基线 + 清 stuckSince + ah 留史
    env.emitFrame(child.childId)
    await env.clock.tick()
    var t = await env.waitFor(function () {
      var x = env.task('task-frame-recover')
      return x && x.history && x.history.some(function (h) { return /帧恢复/.test(h.note || '') }) ? x : null
    }, '帧恢复 ah 留史落卡', W)
    assert.equal(t.stuckSince, undefined, 'stuckSince 清除（疑似解除）')
    assert.equal(t.runs[0].frameSilenceSince, undefined, '帧基线清除（recovery 删持久基线）')
    var recov = (t.history || []).filter(function (h) { return /帧恢复/.test(h.note || '') })
    assert.equal(recov.length, 1, 'ah 留史恰一条帧恢复')
    assert.match(recov[0].note, /静默不足 600s/, '帧恢复文案带「静默不足 600s」语义')
    assert.match(recov[0].note, /清除疑似卡顿标记/, '帧恢复文案带清除语义')
    // 零判死：卡/run 状态零变化、零重派
    assert.equal(t.status, 'in-progress', '卡保持 in-progress')
    assert.equal(t.runs[0].outcome, 'running', '零判死（run 仍 running）')
    assert.ok(!t.lastError, '零 lastError')
    assert.equal(env.sendMessages.length, 0, '零重派投递')
    assert.equal(env.continuables.length, 1, '零新 spawn')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// ===== 帧④：零帧 ≥600s（patchBoard 倒推 frameSilenceSince）→ 判死 + 熔断连击 + 自动重派 =====
// 帧路径只换诊断文案（「帧静默 600s」）；settleRun 失败臂、HUNG_KILL_PREFIX 前缀（进
// isModelKillFailure 白名单=喂熔断连击）、重派链全部复用（dispatch.mjs L2256-2258 + L2296-2301）。
// 熔断连击行为证据：判死后连败软闸未达线（1 次失败 < 2）→ 冷复活续跑走原模型（连击 1 < 3 未拉黑）；
// 连击拉黑半边由帧④b 三连判死行为证据承接。
test('帧④：零帧 ≥600s → 判死 outcome=timeout/error + lastError 含「挂死」+ 自动重派冷复活', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootWorkerBoard(env, 'task-frame-kill', function (d) { d.workerModel = 'prov/hung' })
    var child = boot.child
    await primeFrameBaseline(env, 'task-frame-kill', child.childId)
    // 倒推 601s ≥ HUNG_FRAME_KILL_MS(600s) → 一轮 sweep 判死（帧路径无轮数闸，墙钟到线即判）
    await frameKill(env, 'task-frame-kill', child.childId)
    var t = env.task('task-frame-kill')
    // 断言①：lastError 含「挂死」+ 帧路径诊断文案 + HUNG_KILL_PREFIX 前缀锚定（喂熔断连击）
    assert.match(String(t.lastError || ''), /挂死/, '挂死原因落卡（lastError）')
    assert.match(String(t.lastError || ''), /帧静默 600s/, '帧路径诊断文案（非日志轮数文案）')
    assert.equal(String(t.lastError || '').indexOf('run 挂死：'), 0, 'HUNG_KILL_PREFIX 前缀锚定（进 isModelKillFailure 白名单=喂熔断连击）')
    // 断言②：outcome=timeout/error + endedAt 落账 + 失败计数/重排留史照旧
    assert.equal(t.runs[0].outcome, 'timeout/error', 'settleRun 失败臂关账')
    assert.ok(t.runs[0].endedAt, '关账写 endedAt')
    assert.equal(t.retryCount, 1, '失败计数照旧（失败臂语义不变）')
    assert.equal(t.stuckSince, undefined, '≥600s 直接判死：不落疑似标记（kill 分支先于 suspect）')
    assert.ok((t.history || []).some(function (h) { return h.from === 'in-progress' && h.to === 'pending' }), '失败臂重排留史（in-progress→pending）')
    // 断言③：自动重派（判死结算→同一轮 pickDispatch→tryResumeWorker）→ 冷复活原子会话
    await env.waitFor(function () {
      var x = env.task('task-frame-kill')
      var r2 = x && x.runs && x.runs.find(function (r) { return r.resume === true })
      return r2 && r2.outcome === 'running' && x.claimedBy === child.childId ? r2 : null
    }, '判死后自动重派（续跑行落卡）', W)
    t = env.task('task-frame-kill')
    var resumeRow = t.runs.find(function (r) { return r.resume === true })
    assert.equal(resumeRow.id, child.childId, '重派目标=原原子会话（同一 childId）')
    assert.equal(resumeRow.model, 'prov/hung', '续跑行 model 归因（原模型经健康闸放行：连击 1 < 3 未拉黑）')
    assert.equal(t.status, 'in-progress', '重派落卡 in-progress')
    assert.equal(t.claimedBy, child.childId, '认领位回原子会话')
    var sm = env.sendMessages.find(function (m) { return m.childId === child.childId })
    assert.ok(sm, '重派=sendMessage 冷复活原子会话')
    assert.match(String((sm.content || [])[0] && sm.content[0].text || ''), /断点续跑/, '冷复活文本=断点续跑指令')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// ===== 帧④b：同病模型三连帧判死 → 熔断拉黑（新 spawn 不再选 prov/hung）=====
// 连击表在 dispatch 闭包内不可直读——行为证据链（fault-e2e-hung E2E② 帧路径翻版）：
//   判死#1（连击1）→ 冷复活续跑（健康闸放行）→ 判死#2（连击2）→ 重派被连败软闸拦截改 fresh spawn
//   → 判死#3（连击3）→ 熔断拉黑（卡 blocked）→ 新卡 spawn 不再带 agentOptions（取模链跳过病模型）。
test('帧④b：同病模型三连帧判死 → 熔断拉黑——新卡 spawn 不再选 prov/hung（agentOptions 缺席+modelSource=parent）', async () => {
  var env = createMockCtx()
  var boot = null
  try {
    boot = await bootWorkerBoard(env, 'task-frame-c', function (d) { d.workerModel = 'prov/hung' })
    var child1 = boot.child
    // ---- 判死 #1：基线 → 倒推 → 判死（连击 1）→ 冷复活 ----
    await primeFrameBaseline(env, 'task-frame-c', child1.childId)
    await frameKill(env, 'task-frame-c', child1.childId)
    await env.waitFor(function () {
      var x = env.task('task-frame-c')
      var r2 = x && x.runs && x.runs.find(function (r) { return r.resume === true })
      return r2 && r2.outcome === 'running' && x.claimedBy === child1.childId ? r2 : null
    }, '判死#1 后冷复活（resume 行落卡）', W)
    assert.equal(env.sendMessages.length, 1, '判死#1 重派=sendMessage 冷复活恰一次')
    // ---- 判死 #2：续跑行基线（复活后仍零帧）→ 倒推 → 判死（连击 2）→ 连败软闸拦截改 fresh spawn ----
    await env.clock.tick()
    await env.waitFor(function () {
      var row = runningRow(env, 'task-frame-c', child1.childId)()
      return row && typeof row.frameSilenceSince === 'number' ? row : null
    }, '判死#2 基线落档（续跑行）', W)
    await frameKill(env, 'task-frame-c', child1.childId)
    await env.waitFor(function () {
      var x = env.task('task-frame-c')
      return x && x.runs && x.runs.length >= 3 && x.runs[2].outcome === 'running' && !x.runs[2].resume ? x.runs[2] : null
    }, '判死#2 后 fresh spawn 落卡（续跑健康闸拦截改新会话）', W)
    var t2 = env.task('task-frame-c')
    assert.equal(t2.runs[2].model, 'prov/hung', 'fresh spawn 走板级模型（连击 2 < 3 未熔断）')
    assert.equal(t2.runs[2].modelSource, 'board', 'modelSource=board 留档')
    assert.equal(t2.runs[2].continuable, true, 'fresh spawn 是新 continuable 会话')
    assert.ok(t2.messages && t2.messages.some(function (m) { return m.kind === 'resume-fallback' }), '续跑放弃留痕（resume-fallback 消息）')
    var child2 = env.continuables[1]
    assert.ok(child2 && child2.childId !== child1.childId, 'fresh spawn 是新子会话（非冷复活）')
    // ---- 判死 #3：fresh 行基线 → 倒推 → 判死（连击 3 → 熔断拉黑 + 卡 blocked）----
    await env.clock.tick()
    await env.waitFor(function () {
      var row = runningRow(env, 'task-frame-c', child2.childId)()
      return row && typeof row.frameSilenceSince === 'number' ? row : null
    }, '判死#3 基线落档（fresh 行）', W)
    await frameKill(env, 'task-frame-c', child2.childId)
    await env.waitFor(function () {
      var x = env.task('task-frame-c')
      return x && x.status === 'blocked' && x.runs[2] && x.runs[2].outcome === 'timeout/error' ? x : null
    }, '判死#3 判死关账 + 三连败 → 卡 blocked', W)
    assert.match(String(env.task('task-frame-c').lastError || ''), /挂死/, '判死#3 原因落卡')
    // ---- 熔断行为证据：新卡 spawn 不再选 prov/hung（备用链空 → 父模型兜底）----
    await createTask(env, 'task-frame-d', { pipeline: 'full', acceptance: 'npm test' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 3 }, '新卡 spawn 发生（熔断后取模链跳过病模型）', W)
    var child3 = env.continuables[2]
    assert.equal(child3.request && child3.request.agentOptions, undefined, '新 spawn 不再带 prov/hung（agentOptions 缺席=熔断拉黑生效）')
    var t4 = await env.waitFor(function () {
      var x = env.task('task-frame-d')
      return x && x.status === 'in-progress' && x.runs && x.runs[0] && x.runs[0].outcome === 'running' ? x : null
    }, '新卡落卡', W)
    assert.equal(t4.runs[0].model, '', '新 spawn 模型留档为空（父模型兜底）')
    assert.equal(t4.runs[0].modelSource, 'parent', 'modelSource=parent（取模链跳过熔断模型）')
  } finally {
    if (boot) boot.unpin()
    await env.cleanup()
  }
})

// 心跳驱 N 轮零增长（fault-e2e-hung driveZeroGrowthRounds 同款）：tick() 手动触发 15s 心跳 →
// poolCycle → sweep 轮；每轮 waitFor 计数落盘再进下一轮（真 fs I/O 不定长，确保上一轮 sweep
// 写盘完成后才打下一轮心跳）。
async function driveZeroGrowth(env, taskId, runId, rounds) {
  for (var i = 1; i <= rounds; i++) {
    await env.clock.tick()
    var target = i
    await env.waitFor(function () {
      var row = runningRow(env, taskId, runId)()
      return row && row.zeroGrowthRounds === target ? row : null
    }, '零增长第 ' + target + ' 轮计数落盘', W)
  }
}

// ===== 帧⑤：老宿主形态 → 日志双闸兜底逐字照旧 =====
// 帧路径启用条件 = frameStreamSeen && frameSessionIdOf(rec)（dispatch.mjs L2230）——两形态都让
// 前半不成立：⑤a ctx.on 缺席（订阅静默跳过，frameStreamSeen 恒 false）；⑤b ctx.on 在位但全程零帧。
// 日志双闸存量语义逐字断言：首见只记基线（logSizeOf=0）→ 40 轮 × 600s 墙钟双闸 → 判死文案
// 「连续 40 轮会话日志零增长」，零帧路径字段（frameSilenceSince/stuckSince 只属帧路径）。
test('帧⑤a：老宿主形态（ctx.on 缺席）→ 帧订阅静默跳过，日志双闸兜底逐字照旧（40 轮×600s 判死）', async () => {
  var env = createMockCtx()
  var unpin = pinHomedir(env)
  try {
    delete env.ctx.on // 老宿主：无事件订阅能力（dispatch.mjs L1806 typeof 检查静默跳过，派发照常）
    plugin.apply(env.ctx)
    await createTask(env, 'task-frame-old', { pipeline: 'full', acceptance: 'npm test' })
    env.patchBoard(function (d) { d.workerModel = 'prov/hung' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, '老宿主无 ctx.on：派发照常（worker spawn）', W)
    var child = env.continuables[0]
    await env.waitFor(runningRow(env, 'task-frame-old', child.childId), '落卡 in-progress 且 runs[0] running', W)
    // 全程零帧 → frameStreamSeen=false → sweep 走日志双闸：首见只记基线（日志缺失 logSizeOf=0）
    await env.clock.tick()
    var row = await env.waitFor(function () {
      var r = runningRow(env, 'task-frame-old', child.childId)()
      return r && typeof r.lastLogBytes === 'number' && typeof r.zeroGrowthSince === 'number' ? r : null
    }, '日志双闸首见记基线（lastLogBytes/zeroGrowthSince）', W)
    assert.equal(row.lastLogBytes, 0, '日志缺失 logSizeOf=0（不抛错不跳过）')
    assert.equal(row.zeroGrowthRounds, undefined, '首见只记基线不计数（绝不在第一眼判死）')
    assert.equal(row.frameSilenceSince, undefined, '帧路径未启用：零帧基线字段')
    assert.equal(env.task('task-frame-old').stuckSince, undefined, '零 stuckSince（疑似只属帧路径）')
    // 倒推 zeroGrowthSince 601s → 40 轮心跳 → 判死（双闸：40 轮零增长 × 600s 墙钟地板）
    await pushBackBaseline(env, 'task-frame-old', child.childId, 'zeroGrowthSince', 601000)
    await driveZeroGrowth(env, 'task-frame-old', child.childId, 39)
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-frame-old')
      return x && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null
    }, '第 40 轮日志双闸判死关账', W)
    var t = env.task('task-frame-old')
    assert.match(String(t.lastError || ''), /挂死/, '挂死原因落卡')
    assert.match(String(t.lastError || ''), /连续 40 轮会话日志零增长/, '日志双闸诊断文案逐字照旧')
    assert.ok(!/帧静默/.test(String(t.lastError || '')), '非帧路径文案（老宿主零帧走日志闸）')
    assert.equal(t.runs[0].zeroGrowthRounds, 40, '轮数半边=40')
    assert.equal(t.runs[0].frameSilenceSince, undefined, '全程零帧路径字段')
  } finally {
    unpin()
    await env.cleanup()
  }
})

// 帧⑤b：ctx.on 在位但全程零帧（frameStreamSeen 恒 false）→ 与 ⑤a 同走日志双闸
test('帧⑤b：ctx.on 在位但全程零帧 → 帧路径不启用，日志双闸兜底逐字照旧（40 轮×600s 判死）', async () => {
  var env = createMockCtx()
  var unpin = pinHomedir(env)
  try {
    plugin.apply(env.ctx) // ctx.on 在位（订阅建立），但测试全程零帧 → frameStreamSeen 恒 false
    await createTask(env, 'task-frame-oldb', { pipeline: 'full', acceptance: 'npm test' })
    env.patchBoard(function (d) { d.workerModel = 'prov/hung' })
    await env.clock.advance(50)
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'worker spawn 发生', W)
    var child = env.continuables[0]
    await env.waitFor(runningRow(env, 'task-frame-oldb', child.childId), '落卡 in-progress 且 runs[0] running', W)
    await env.clock.tick()
    var row = await env.waitFor(function () {
      var r = runningRow(env, 'task-frame-oldb', child.childId)()
      return r && typeof r.lastLogBytes === 'number' && typeof r.zeroGrowthSince === 'number' ? r : null
    }, '日志双闸首见记基线（全程零帧）', W)
    assert.equal(row.lastLogBytes, 0, '日志缺失 logSizeOf=0')
    assert.equal(row.frameSilenceSince, undefined, '零帧观测：帧路径不启用（零帧基线字段）')
    await pushBackBaseline(env, 'task-frame-oldb', child.childId, 'zeroGrowthSince', 601000)
    await driveZeroGrowth(env, 'task-frame-oldb', child.childId, 39)
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-frame-oldb')
      return x && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null
    }, '第 40 轮日志双闸判死关账', W)
    var t = env.task('task-frame-oldb')
    assert.match(String(t.lastError || ''), /连续 40 轮会话日志零增长/, '日志双闸诊断文案逐字照旧')
    assert.ok(!/帧静默/.test(String(t.lastError || '')), '非帧路径文案')
    assert.equal(t.runs[0].zeroGrowthRounds, 40, '轮数半边=40')
    assert.equal(env.task('task-frame-oldb').stuckSince, undefined, '零 stuckSince（疑似只属帧路径）')
  } finally {
    unpin()
    await env.cleanup()
  }
})

// ===== 帧⑥：映射边界——老 start 一次性 run（rec.id≠会话 id）即使全局已有帧观测也走日志闸 =====
// workerContinuable=false → 老 start 路径（mock 无 startActivation → 老 start，run.id=provider run id），
// rec.frameSessionId 空（dispatch.mjs L990）→ 不可映射帧流；即使全局 frameStreamSeen=true（别的会话
// 在流式），帧路径对该 rec 关闭 → 日志闸兜底，不被帧路径误杀。
test('帧⑥：老 start 一次性 run（rec.id≠会话 id）+ 全局已有帧观测 → 仍走日志闸，不被帧路径误杀', async () => {
  var env = createMockCtx()
  var unpin = pinHomedir(env)
  try {
    plugin.apply(env.ctx)
    await createTask(env, 'task-frame-oneshot', { pipeline: 'full', acceptance: 'npm test' })
    env.patchBoard(function (d) { d.workerContinuable = false; d.workerModel = 'prov/hung' }) // 一次性回退开关（老 start 路径）
    await env.clock.advance(50)
    await env.waitFor(function () { return env.runs.length >= 1 }, '一次性 spawn 发生（老 start 路径）', W)
    var run = env.runs[0]
    assert.ok(/^run-/.test(String(run.id)), 'rec.id=provider run id（≠会话 id，frameSessionId 空 = 不可映射帧流）')
    await env.waitFor(runningRow(env, 'task-frame-oneshot', run.id), '落卡 in-progress 且 runs[0] running', W)
    // 全局帧观测（别的会话在流式）：frameStreamSeen=true，但本 rec 不可映射 → 帧路径不启用
    env.emitFrame('session-unrelated-streaming')
    await env.clock.tick()
    var row = await env.waitFor(function () {
      var r = runningRow(env, 'task-frame-oneshot', run.id)()
      return r && typeof r.lastLogBytes === 'number' && typeof r.zeroGrowthSince === 'number' ? r : null
    }, '日志闸首见记基线（不可映射 rec）', W)
    assert.equal(row.frameSilenceSince, undefined, '不可映射 rec：零帧基线（帧路径不误启用）')
    assert.equal(env.task('task-frame-oneshot').stuckSince, undefined, '全局帧存在也不落疑似（帧路径对不可映射 rec 关闭）')
    // 日志闸照常判死：倒推 601s + 40 轮（帧路径未误杀：判死只来自日志双闸）
    await pushBackBaseline(env, 'task-frame-oneshot', run.id, 'zeroGrowthSince', 601000)
    await driveZeroGrowth(env, 'task-frame-oneshot', run.id, 39)
    await env.clock.tick()
    await env.waitFor(function () {
      var x = env.task('task-frame-oneshot')
      return x && x.runs[0] && x.runs[0].outcome === 'timeout/error' ? x : null
    }, '第 40 轮日志闸判死关账', W)
    var t = env.task('task-frame-oneshot')
    assert.match(String(t.lastError || ''), /连续 40 轮会话日志零增长/, '日志闸文案（帧路径未接管）')
    assert.ok(!/帧静默/.test(String(t.lastError || '')), '非帧路径文案（不可映射 rec 走日志闸）')
    assert.equal(t.runs[0].zeroGrowthRounds, 40, '日志闸轮数半边')
    assert.equal(t.runs[0].frameSilenceSince, undefined, '全程零帧路径字段')
    // 判死后自动重派：一次性 run 无可复活会话（resumeTarget 天然零命中）→ fresh spawn 新一次性 run
    await env.waitFor(function () {
      var x = env.task('task-frame-oneshot')
      return x && x.runs && x.runs.length >= 2 && x.runs[1].outcome === 'running' ? x : null
    }, '判死后 fresh spawn 重派', W)
  } finally {
    unpin()
    await env.cleanup()
  }
})

// ===== 帧⑦：verifier 在跑 run 帧路径覆盖（对齐薄桩挂死⑤的 verifier 语义）=====
// verifier 恒走一次性面（dispatch.mjs L923 useContinuable 只对 worker 开）——新宿主契约下经
// startActivation delivery='caller'，activationAsRun 的 run.id=act.childId → rec.frameSessionId
// 显式记录（L990）→ 帧路径可映射。零帧 ≥600s 判死走 settleVerifier 失败臂（outcome=timeout/error +
// verifyRetries 重排 + 既有即时熔断语义，settle-stop-interrupt.test.mjs 挂死⑤对齐）。
test('帧⑦：verifier 在跑 run 帧路径覆盖——零帧 ≥600s 判死走 settleVerifier 失败臂 + 既有即时熔断', async () => {
  var env = createMockCtx()
  var unpin = pinHomedir(env)
  var actSeq = 0
  var activations = []
  try {
    // startActivation 能力桩（新宿主契约）：worker=continuable 面（delivery='parent'）、
    // verifier=一次性面（delivery='caller'）。result 永不落定（真实 activation 只认拆除落定——
    // 挂死形态：verifier 会话在但不产出，零 settle 事件，结算唯一来源=帧静默 sweep）。
    // 挂在 ctx.subagents 上（mock 内部 subagents 与 ctx.subagents 同一对象，spawnOneShot 读它）；
    // hasActivationApi 一次性缓存按首次调用现算（apply 内），桩须在 apply 前挂上。
    env.ctx.subagents.startActivation = async function (spec) {
      var act = { childId: 'act-' + (++actSeq), messageId: 'am' + actSeq, result: new Promise(function () {}), dispose: async function () {} }
      activations.push({ childId: act.childId, delivery: spec && spec.delivery, request: spec && spec.request })
      return act
    }
    plugin.apply(env.ctx)
    await createTask(env, 'task-frame-verify', { pipeline: 'full', acceptance: 'npm test' })
    env.patchBoard(function (d) { d.verifierModel = 'prov/vm' })
    await env.clock.advance(50)
    await env.waitFor(function () { return activations.length >= 1 }, 'worker spawn 发生（startActivation continuable 面）', W)
    var child = activations[0].childId
    await env.waitFor(runningRow(env, 'task-frame-verify', child), '落卡 in-progress 且 runs[0] running', W)
    // worker board_report 完成（上报通道，integration.test.mjs 集成a 同款）→ verifying + worker rec 关账
    var rep = await env.tools.get('board_report').execute({ taskId: 'task-frame-verify', kind: 'complete', summary: '实现完成', changes: '', selfTest: 'ok', diffStat: '' })
    assert.equal(rep.ok, true, 'worker 上报成功')
    assert.equal(rep.task.status, 'verifying', '上报完成 → verifying')
    // verifier spawn（startActivation 一次性面 delivery='caller'，带 verifierModel agentOptions）
    await env.clock.advance(50)
    var vact = await env.waitFor(function () {
      for (var i = 0; i < activations.length; i++) { if (activations[i].delivery === 'caller') return activations[i] }
      return null
    }, 'verifier spawn 发生（startActivation 一次性面）', W)
    // agentOptions 拆 provider/model 复合格式（dispatch.mjs L911-913：list-models id 是 provider/model）
    assert.deepEqual(vact.request && vact.request.agentOptions, { provider: 'prov', model: 'vm' }, '首派 verifier 带 board 级模型 agentOptions')
    var vrow0 = await env.waitFor(function () {
      var t = env.task('task-frame-verify')
      var rows = (t && t.runs) || []
      for (var i = rows.length - 1; i >= 0; i--) { if (rows[i].role === 'verifier' && rows[i].outcome === 'running') return rows[i] }
      return null
    }, 'verifier run 落卡 running', W)
    // verifier 帧路径：emitFrame（act childId 可映射）→ 消费 dirty → 零帧 sweep 写基线
    env.emitFrame(vact.childId)
    await env.clock.tick()
    await env.clock.tick()
    await env.waitFor(function () {
      var r = runningRow(env, 'task-frame-verify', vact.childId)()
      return r && typeof r.frameSilenceSince === 'number' ? r : null
    }, 'verifier 帧基线落档（帧路径覆盖 verifier run）', W)
    await frameKill(env, 'task-frame-verify', vact.childId)
    // settleVerifier 失败臂：outcome=timeout/error + verifyRetries 重排 + 卡仍 verifying + 即时熔断
    await env.waitFor(function () {
      var x = env.task('task-frame-verify')
      var rows = (x && x.runs) || []
      for (var i = rows.length - 1; i >= 0; i--) { if (rows[i].role === 'verifier' && rows[i].outcome === 'timeout/error') return x }
      return null
    }, 'verifier 判死关账（settleVerifier 失败臂）', W)
    var t = env.task('task-frame-verify')
    assert.match(String(t.lastError || ''), /挂死/, '挂死原因落卡')
    assert.match(String(t.lastError || ''), /帧静默 600s/, '帧路径诊断文案')
    assert.equal(t.verifyRetries, 1, 'verifier 失败臂计数（重新排队审查）')
    assert.equal(t.status, 'verifying', '卡仍 verifying（重新排队）')
    assert.ok((t.history || []).some(function (h) { return /重新排队审查/.test(h.note || '') }), 'ah 留史：重新排队审查')
    // 既有即时熔断语义（薄桩挂死⑤对齐）：rec.model=prov/vm 失败即时熔断 → 重排 verifier spawn
    // 跳过病模型（agentOptions 缺席 = 熔断拉黑生效）
    var vact2 = await env.waitFor(function () {
      for (var i = activations.indexOf(vact) + 1; i < activations.length; i++) {
        if (activations[i].delivery === 'caller') return activations[i]
      }
      return null
    }, '重排 verifier spawn 发生（即时熔断后取模链跳过病模型）', W)
    assert.equal(vact2.request && vact2.request.agentOptions, undefined, '重排 spawn 不再带 prov/vm（agentOptions 缺席=即时熔断生效）')
    assert.ok(vact2.childId !== vact.childId, '重排 verifier 是新会话（原挂死 verifier rec 已摘除）')
  } finally {
    unpin()
    await env.cleanup()
  }
})
