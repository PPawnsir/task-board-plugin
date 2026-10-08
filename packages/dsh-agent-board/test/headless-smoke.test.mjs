// dsh-agent-board — 无头冒烟链路 + mock-ctx harness 各面独立用例（task-muxpfon9 无头基建卡1）
// 本文件同时证明两件事：
//   ① test/helpers/mock-ctx.mjs 这套无头宿主基建的每一面都可独立工作——
//      fs 临时目录隔离 / 虚拟时钟推进 / subagents 剧本化（一次性 run + continuable 句柄）/
//      agentEvents 事件发射 / webServer 路由直调 / agents 剧本 / tools·systemPrompt·llm 记录器；
//   ② 冒烟链路：真实 import ../index.mjs → apply(env.ctx) → 建一张卡 → 虚拟时钟推进 →
//      断言派发发生（subagents 剧本收到 continuable spawn）→ emitStatus 事件结算 → 断点续跑 sendMessage。
// 约束：不改 index.mjs 任何行为；看板文件落在 os.tmpdir 下的独立临时 HOME，cleanup 全清。
// 注意：node:test 顶层用例默认串行——每个用例自建 env、finally 里 cleanup（HOME env 是进程级，严禁并行env）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

// ===== harness 面①：fs —— 临时 HOME 接管 / 目录隔离 / cleanup 恢复 =====
test('harness·fs 面：临时 HOME 接管+隔离，cleanup 恢复 env 并递归删目录', async () => {
  var hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME')
  var prevHome = process.env.HOME
  var env1 = createMockCtx()
  assert.equal(process.env.HOME, env1.home, '创建后 HOME 指向该 env 的临时目录（boardDirName 每次现读 env）')
  assert.ok(env1.home.indexOf(os.tmpdir()) === 0, '临时目录落在 os.tmpdir 下')
  assert.ok(fs.existsSync(env1.home), '临时目录真实存在（真写 fs）')
  var env2 = createMockCtx()
  assert.notEqual(env1.home, env2.home, '每个 env 各自独立临时目录')
  fs.writeFileSync(path.join(env1.home, 'marker.txt'), 'x', 'utf8')
  assert.ok(!fs.existsSync(path.join(env2.home, 'marker.txt')), '目录间互不污染')
  await env2.cleanup() // LIFO 纪律：后建的先清，HOME 回到 env1
  assert.equal(process.env.HOME, env1.home, 'cleanup 按 LIFO 恢复上一层 HOME')
  await env1.cleanup()
  assert.ok(!fs.existsSync(env1.home), 'cleanup 递归删除临时目录')
  if (hadHome) assert.equal(process.env.HOME, prevHome, 'HOME env 恢复创建前的原值')
  else assert.ok(!Object.prototype.hasOwnProperty.call(process.env, 'HOME'), '原本无 HOME 则恢复为未设置')
})

// ===== harness 面②：虚拟时钟 —— 到期触发 / dispose 取消 / interval 续挂 =====
test('harness·时钟面：advance 按到期顺序触发，dispose 真取消，interval 自动续挂', async () => {
  var env = createMockCtx()
  try {
    var fired = []
    var cancel = env.ctx.timer.timeout(function () { fired.push('disposed') }, 10)
    cancel() // 回调式的 dispose 闭包：真清掉，到期不触发
    env.ctx.timer.timeout(function () { fired.push('cb50') }, 50)
    var p100 = env.ctx.timer.timeout(100).then(function () { fired.push('p100') }) // promise 形态（kickCycle/去抖/聚合同款用法）
    var iv = 0
    var stopIv = env.ctx.timer.interval(function () { iv++ }, 30)
    assert.equal(env.clock.now(), 0, '虚拟时钟从 0 起算')
    await env.clock.advance(40)
    assert.deepEqual(fired, [], '40ms 内无到期（10 已 dispose，50/100 未到点）')
    await env.clock.advance(60) // → now=100
    assert.deepEqual(fired, ['cb50', 'p100'], '按到期顺序触发（回调式 50 先于 promise 式 100）')
    assert.equal(iv, 3, 'interval 30ms 在 100ms 窗口内触发 3 次（30/60/90）并自动续挂')
    assert.equal(env.clock.now(), 100)
    stopIv()
    await env.clock.advance(1000)
    assert.equal(iv, 3, 'interval dispose 后不再触发')
    assert.equal(env.clock.pendingCount(), 0, '全部定时器已结清（一次性触发后即注销）')
    await p100 // promise 形态确实落定过（then 链已在 advance 内跑完）
  } finally { await env.cleanup() }
})

// ===== harness 面③：subagents 剧本 —— 一次性 run 可控结局 + continuable 句柄 + 记录器 =====
test('harness·subagents 面：一次性 run 由测试驱动结局，continuable/sendMessage/interrupt/listChildren 留痕', async () => {
  var env = createMockCtx()
  try {
    // 一次性 run：result promise 由测试驱动
    var run = await env.ctx.subagents.start('mock-provider', { label: 'worker:t1', prompt: [{ type: 'text', text: 'p' }] })
    assert.equal(env.runs.length, 1, 'start 产出登记进 runs 剧本表')
    assert.equal(run.req.label, 'worker:t1', 'req 原文留痕（label/prompt 可断言）')
    var settled = null
    run.result.then(function (r) { settled = r }, function () {})
    await new Promise(function (r) { setImmediate(r) })
    assert.equal(settled, null, '未 resolveWith 前 result 不落定（测试掌控节奏）')
    // localAgent steer/followup 记录器（doIntervene 通道句柄）
    run.localAgent.steer('高优指令')
    run.localAgent.followup('补充消息')
    assert.deepEqual(run.localAgent.steered, ['高优指令'])
    assert.deepEqual(run.localAgent.followed, ['补充消息'])
    run.resolveWith('交付文本')
    var res = await run.result
    assert.equal(res.output[0].text, '交付文本', 'outputText 可指定（{ output:[{type:text}], stopReason } 形状）')
    assert.equal(res.stopReason, 'completed')
    // 失败结局：failWith 拒绝 result
    var run2 = await env.ctx.subagents.start('mock-provider', { label: 'verifier:t2' })
    run2.failWith('boom')
    await assert.rejects(run2.result, /boom/)
    // continuable 面：{ childId, messageId } 句柄
    var c = await env.ctx.subagents.startContinuable({ provider: 'mock-provider', label: 'worker:t3', request: { prompt: [] } })
    assert.ok(c.childId && c.messageId, 'startContinuable 返回 { childId, messageId }')
    assert.equal(env.continuables[0].label, 'worker:t3', 'continuable 剧本登记 label/request')
    // sendMessage / interrupt / listChildren 记录器
    await env.ctx.subagents.sendMessage(env.root, c.childId, [{ type: 'text', text: '续跑指令' }])
    assert.equal(env.sendMessages[0].childId, c.childId)
    assert.equal(env.sendMessages[0].content[0].text, '续跑指令')
    env.ctx.subagents.interrupt(c.childId, { kind: 'ancestor', agent: env.root })
    assert.equal(env.interrupts[0].childId, c.childId)
    assert.equal(env.interrupts[0].authority.kind, 'ancestor', 'interrupt authority 形状留痕')
    env.children.push({ id: 'child-x', label: 'x' })
    assert.deepEqual(await env.ctx.subagents.listChildren(env.sid), [{ id: 'child-x', label: 'x' }], 'listChildren 剧本可整组替换')
  } finally { await env.cleanup() }
})

// ===== harness 面④：agentEvents —— emitStatus 重放 agent/status 事件 =====
test('harness·agentEvents 面：emitStatus 手动发射事件，payload 形状与退订语义正确', async () => {
  var env = createMockCtx()
  try {
    var got = []
    var off = env.ctx.on('agent/status', function (p) { got.push(p) })
    env.emitStatus('child-9', 'running')
    env.emitStatus('child-9', 'idle')
    assert.deepEqual(got.map(function (p) { return p.status }), ['running', 'idle'])
    assert.equal(got[0].agent.session.id, 'child-9', 'payload 形状 { agent: { session: { id } }, status }（与 host 事件契约一致）')
    off()
    env.emitStatus('child-9', 'idle')
    assert.equal(got.length, 2, '退订后不再接收')
  } finally { await env.cleanup() }
})

// ===== harness 面⑤：webServer 直调 + agents 剧本 + tools/systemPrompt/llm 记录器（需 apply 接线）=====
test('harness·webServer/agents 面：apply 后走真 readBody/handler 路径直调 RPC，工具与提示词留痕', async () => {
  var env = createMockCtx()
  try {
    // agents 剧本：currentInitiator/roots 可按测试改写
    assert.equal(env.ctx.agents.currentInitiator().id, env.sid, '缺省 actor=root sid')
    env.actor = 'sub-agent-1'
    assert.equal(env.ctx.agents.currentInitiator().id, 'sub-agent-1', 'actor 可改写模拟子代理身份')
    env.actor = env.sid
    assert.equal(env.ctx.agents.roots()[0].session.header.cwd, env.cwd, 'root.session.header.cwd 是 sessionCwd 来源')
    // 真实 index.mjs 接线（薄壳：session→store→notify→dispatch→rpc）
    plugin.apply(env.ctx)
    // webServer register 捕获的路由：env.rpc 以真语义直调（POST body → readBody → handlers[method]）
    var r = await env.rpc('get-tasks', { sessionId: env.sid })
    assert.equal(r.sessionId, env.sid)
    assert.ok(Array.isArray(r.tasks) && r.tasks.length === 0, '新会话空板')
    assert.equal(r.isRoot, true)
    // tools.register 记录器：工具表按名可查、execute 可真跑
    assert.ok(env.tools.get('task_create'), 'task_create 已注册')
    assert.ok(env.tools.get('board_report'), 'board_report 已注册')
    var listed = await env.tools.get('task_list').execute({})
    assert.ok(Array.isArray(listed.tasks) && listed.tasks.length === 0, 'task_list 工具真跑返回空表')
    // systemPrompt 记录器：Team 引导段在 apply 时注册
    assert.ok(env.spSections.some(function (s) { return s.name === 'task-board:team-mode' }), 'systemPrompt.section 注册留痕')
    // llm 记录器：list-models RPC 触发 listProviders
    var lm = await env.rpc('list-models', {})
    assert.equal(lm.ok, true)
    assert.equal(env.llm.listProviders, 1, 'llm.listProviders 调用留痕')
  } finally { await env.cleanup() }
})

// ===== ② 冒烟链路：建卡 → 虚拟时钟推进 → 派发发生 → 事件结算 → 断点续跑 =====
// 这一例证明 harness 可用：真实 index.mjs 全套接线在 mockCtx 上跑通核心派发闭环。
// 链路：create-task RPC → mutateLocked 写盘 → kickCycle（虚拟 50ms 去抖）→ poolCycle →
//       pickDispatch → spawnOneShot → subagents.startContinuable（workerContinuable 缺省开）→
//       agent/status running→idle 事件结算（空文本按失败重排，interrupt 留存）→
//       再推进去抖 → tryResumeWorker 命中续跑资格 → sendMessage 冷复活（不再 fresh spawn）。
test('冒烟链路：apply(mockCtx) → 建卡 → 时钟推进 → continuable 派发 → 事件结算 → 断点续跑', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    // 建一张卡（pipeline=work：只做不验，避开 verifier 支线；显式 description 避开软提示）
    var created = await env.rpc('create-task', { sessionId: env.sid, id: 'task-smoke-1', title: '冒烟任务', description: '无头冒烟链路用例', pipeline: 'work' })
    assert.equal(created.ok, true)
    assert.equal(created.task.status, 'pending', '非 Team 模式即建即 pending')
    assert.ok(fs.existsSync(path.join(env.home, '.dsh', 'tasks-' + env.sid + '.json')), '看板文件落在临时 HOME')
    // 虚拟时钟推进 50ms（kickCycle 去抖窗口）→ poolCycle 起跑；链尾真实 I/O 由 waitFor 收敛
    await env.clock.advance(50)
    // 核心断言：派发发生——subagents 剧本收到 continuable spawn
    await env.waitFor(function () { return env.continuables.length >= 1 }, 'continuable spawn 发生')
    var child = env.continuables[0]
    assert.equal(child.label, 'worker:task-smoke-1', 'spawn label 形如 worker:<taskId>')
    assert.ok(child.request.prompt[0].text.indexOf('冒烟任务') >= 0, '首条 prompt 携带任务标题')
    assert.equal(env.runs.length, 0, 'Worker 走 continuable 面，未动用一次性 start')
    // 卡面：占位 claim（spawn-pending）已换成真实 childId
    await env.waitFor(function () {
      var t = env.task('task-smoke-1')
      return t && t.status === 'in-progress' && t.claimedBy === child.childId ? t : null
    }, '任务落卡 in-progress 且 claimedBy=childId')
    // 事件结算：continuable 无 run.result，agent/status 的 running→idle 是唯一结算信号
    env.emitStatus(child.childId, 'running')
    env.emitStatus(child.childId, 'idle')
    // 无 v4 会话日志可读 → 空文本按失败结算：回 pending 重排（settleContinuable 既定语义），interrupt 留存子会话。
    // waitFor 必须等整条结算链尾（settleWorker 落卡 + closeRunHistory 关账）——否则 cleanup 会
    // rm 掉在飞写盘的临时目录（链尾不定长是真实 I/O，这正是 harness 提供 waitFor 的原因）。
    await env.waitFor(function () {
      var t = env.task('task-smoke-1')
      return t && t.status === 'pending' && t.retryCount === 1 && t.runs && t.runs.length === 1 && t.runs[0].outcome === 'incomplete' ? t : null
    }, '空文本失败重排 pending 且 run 关账 incomplete')
    var t1 = env.task('task-smoke-1')
    assert.ok(env.interrupts.some(function (i) { return i.childId === child.childId }), '结算收尾 interrupt 留存（不销毁子会话）')
    assert.equal(t1.runs[0].continuable, true)
    // 断点续跑：再推进一次去抖窗口 → 命中续跑资格 → sendMessage 冷复活原 child，不再 fresh spawn
    await env.clock.advance(50)
    await env.waitFor(function () { return env.sendMessages.length >= 1 }, '断点续跑 sendMessage 发出')
    assert.equal(env.sendMessages[0].childId, child.childId, '续跑唤醒的是原子会话')
    assert.ok(env.sendMessages[0].content[0].text.indexOf('断点续跑') >= 0, '续跑指令文案')
    assert.equal(env.continuables.length, 1, '续跑命中 → 不再 spawn 新子会话')
    // 续跑轮再次事件结算（仍空文本 → retryCount 2）；runs 留档两条，第二条 resume:true 且关账 incomplete
    env.emitStatus(child.childId, 'running')
    env.emitStatus(child.childId, 'idle')
    await env.waitFor(function () {
      var t = env.task('task-smoke-1')
      return t && t.status === 'pending' && t.retryCount === 2 && t.runs && t.runs.length === 2 && t.runs[1].outcome === 'incomplete' ? t : null
    }, '续跑轮失败重排且关账')
    var t2 = env.task('task-smoke-1')
    assert.equal(t2.runs[1].resume, true, '第二条标 resume:true')
  } finally { await env.cleanup() }
})

// ===== isRoot 持久语义（banner 入口瞬态/持久消失修复，task-muzys43o）=====
// 根因：host get-tasks 的 isRoot 旧实现读活跃 roots() 集——roots() 只含活体会话，
// 休眠根会话（有板有卡但无活 agent）恒 false → banner「智能看板」按钮分钟级消失；
// 且生成开始/结束 agents 树重建有瞬态窗口假 false。修法：isRoot 改读持久 parentSession
// （根会话=无父），休眠根也算 root；子代理会话（parentSession 指向父）仍 false。
test('isRoot 持久语义：休眠根会话仍 root（parentSession 缺省），子代理会话仍 false', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    // 造一块「有板有卡」的根会话板（证明休眠前确有板卡）
    var created = await env.rpc('create-task', { sessionId: env.sid, id: 't-isroot-1', title: '休眠根会话卡', pipeline: 'work' })
    assert.equal(created.ok, true)
    // 模拟休眠：活跃 roots 清空（无活 agent），但持久表仍记 parentSession 缺省（根）
    env.setRoots([])
    var r = await env.rpc('get-tasks', { sessionId: env.sid })
    assert.equal(r.isRoot, true, '① 休眠根会话 isRoot=true（持久 parentSession 缺省，不依赖活跃 roots 集）')
    assert.equal(r.tasks.length, 1, '休眠不丢板卡（rt 读盘仍在）')
    // ② 子代理会话：持久表记 parentSession → false（保护语义不变）
    var childSid = 'session-child-aaaa-bbbb'
    env.persistedHeaders[childSid] = { id: childSid, parentSession: env.sid }
    var rc = await env.rpc('get-tasks', { sessionId: childSid })
    assert.equal(rc.isRoot, false, '② 子代理会话 isRoot=false（parentSession 指向父）')
  } finally { await env.cleanup() }
})
