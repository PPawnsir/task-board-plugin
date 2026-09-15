// dsh-agent-board — Agent 任务看板（host 端）
// 本文件即源码，直接维护（v68 起：变形层已拆除，不再从其他文件生成）。
//
// 零外部依赖：link: 安装的包从真实路径解析，裸 import '@deepseek-ai/dsh-tools'
// 会解析失败（ERR_MODULE_NOT_FOUND）。defineTool 本体只是 校验+包装 出
// {name, description, parameters, output, execute} 普通对象，这里内联等价实现。
// parameters 已是完整 JSON Schema，原样透传；output 透传 schema+render。
import * as core from './lib/core.mjs'
const { ah, isb, gsb, gpt, vt, validateDeps, depsSatisfied, depsCancelled, classifyPipeline, seed, cfg, claimCheck, claimApply, checkParentAuto, resolveApply, verifyApply, parseSections, parseVerdict, isEscalation, outputText, histNotes, buildWorkerPrompt, buildVerifierPrompt, pickDispatch, isOrphan, PRIO_RANK } = core

function defineTool(options) {
  var userExecute = options.execute
  var userRender = options.output && options.output.render
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: userRender ? function (args, value) { return userRender(args, value) } : undefined,
    },
    execute: function (args, exec) { return userExecute(args, exec) },
  }
}

export const name = 'dsh-agent-board'
export const inject = ['fs', 'timer', 'subagents', 'agents', 'tools', 'webServer']

export function apply(ctx) {
    const fs = ctx.fs
    // RPC handlers 表必须在最前面初始化：后面的 handle(...) 调用依赖它（var 只提升声明不提升赋值）
    var handlers = {}
    function handle(method, fn) { handlers[method] = fn }

    // ===== 工具函数 =====
    function getActorId() { const a = ctx.agents; if (a) { const i = a.currentInitiator(); if (i) return String(i.id) } return 'unknown' }
    function resolveRoot(sid) { const agentsSvc = ctx.agents; if (!agentsSvc) return sid; var cur = sid; var roots = agentsSvc.roots(); var rids = []; for (var i = 0; i < roots.length; i++) rids.push(String(roots[i].id)); if (rids.indexOf(cur) >= 0) return cur; var all = agentsSvc.list(); var visited = {}; while (!visited[cur]) { visited[cur] = true; var o = null; for (var j = 0; j < all.length; j++) { if (agentsSvc.isOwnedBy(cur, all[j])) { o = all[j]; break } }; if (!o) break; cur = String(o.id); if (rids.indexOf(cur) >= 0) return cur }; return cur }
    function toolSessionId() { var sid = resolveRoot(getActorId()); touchSession(sid); return sid }
    function rpcSessionId(args) { var sid = (args && typeof args.sessionId === 'string' && args.sessionId.length > 0) ? args.sessionId : resolveRoot(getActorId()); touchSession(sid); return sid }
    // 已知会话集合：心跳驱动这些会话的 poolCycle（摆脱对客户端轮询的依赖）
    // 带 TTL 淘汰：>30 分钟无活跃的会话从心跳中移除，避免长期运行后空转 poolCycle
    var knownSessions = {}
    function touchSession(sid) { if (sid && typeof sid === 'string' && sid !== 'unknown') knownSessions[sid] = Date.now() }
    // teamMode 缓存：由 rt() 同步，供 systemPrompt 动态引导段读取（v65）
    var teamModeCache = {}
    function fileFor(sid) { return '.dsh/tasks-' + sid + '.json' }
    async function rt(sid) { try { var t = await fs.resolve(fileFor(sid)); var r = await fs.readText(t); var d = JSON.parse(r); if (vt(d) && d.ownerSession === sid) { teamModeCache[sid] = !!d.teamMode; return d }; return seed(sid) } catch (_) { return seed(sid) } }
    async function wt(sid, d) { var c = JSON.stringify(d, null, 2); try { var t = await fs.resolve(fileFor(sid)); await fs.writeText(t, c) } catch (e) { console.error('[task-board] write:', String(e)); throw e } }
    // 每会话一条 promise 链，串行化所有 读-改-写，消除并发写竞争
    var fileLocks = {}
    function withLock(sid, fn) { var prev = fileLocks[sid] || Promise.resolve(); var p = prev.then(function () { return fn() }); fileLocks[sid] = p.catch(function () {}); return p }
    // 便捷：串行的 读→mutate→写。mutate(d) 返回值作为结果；mutate 返回 null/undefined 则不写
    // 写成功后异步触发一次 poolCycle（派发/回收反应快），按会话去抖避免连环触发
    var cyclePending = {}
    function kickCycle(sid) { if (cyclePending[sid]) return; cyclePending[sid] = true; var tm = ctx.timer; var go = function () { cyclePending[sid] = false; poolCycle(sid).catch(function () {}) }; if (tm) tm.timeout(50).then(go); else Promise.resolve().then(go) }
    function mutateLocked(sid, mutate, skipKick) { return withLock(sid, async function () { var d = await rt(sid); var r = await mutate(d); if (r !== null && r !== undefined) { await wt(sid, d); if (!skipKick) kickCycle(sid); return r } return r }) }
    function jo() { return { schema: { type: 'object', additionalProperties: true }, render: function (a, v) { return [{ type: 'text', text: JSON.stringify(v, null, 2) }] } } }
    // 按会话找 root agent（静态插件挂 host 层后多会话共存，不能"取第一个"——会把 worker 挂到别的会话上）
    function rootForSession(sid) { var s = ctx.agents; if (!s) return undefined; var r = s.roots(); for (var i = 0; i < r.length; i++) { if (String(r[i].id) === sid) return r[i] } return undefined }
    function makeSignal() { try { return new AbortController().signal } catch (_) { return { aborted: false, addEventListener: function () {}, removeEventListener: function () {} } } }
    function makeMsg(text) { return { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'user' } } }
    // 超时保护：run 挂死时走失败重试路径
    function withTimeout(promise, ms, label) { var timer = ctx.timer; if (!timer) return promise; return Promise.race([promise, timer.timeout(ms).then(function () { throw new Error(label + ' timeout ' + ms + 'ms') })]) }


    // ===== 状态流转（已抽取到 lib/core.mjs）=====
    // ===== 一次性派发引擎（v74 去池化重写）=====
    // 每个任务 spawn 一个独立一次性子代理：上下文由看板通过 prompt 全量注入（任务描述/指引/验收脚本/过程记录），
    // 优先选择不继承父会话历史的 provider（inheritsParentContext === false），工作结束 run.result 结算后即 dispose 销毁。
    // 无常驻池、无队列、无名册——彻底消除幽灵指派/身份错乱/spawn 死亡循环整族问题。
    var activeRuns = {} // sid -> { taskId: { run, role, taskId, startedAt, model } }
    var dispatchedEver = {} // sid -> { runId: true }（回执判定：区分派发执行 vs 主窗口手动）
    function runsFor(sid) { if (!activeRuns[sid]) activeRuns[sid] = {}; return activeRuns[sid] }
    function isDispatched(sid, id) { return !!(id && dispatchedEver[sid] && dispatchedEver[sid][id]) }
    // 模型熔断：带覆盖模型的 run 若立即失败（如 UNKNOWN_MODEL——模型在当前网关没配置），记入坏名单回退父级
    var badModels = {}
    function modelKey(sid, model) { return sid + '|' + model }

    var _cachedProvider = null
    function pickProvider() {
      if (_cachedProvider) return _cachedProvider
      var subagents = ctx.subagents; if (!subagents) return null
      var names = subagents.list(); if (!names.length) return null
      for (var i = 0; i < names.length; i++) { try { var p = subagents.getProvider(names[i]); if (p && p.inheritsParentContext === false) { _cachedProvider = names[i]; return _cachedProvider } } catch (_) {} }
      _cachedProvider = names[0]; return _cachedProvider
    }

    async function spawnOneShot(sid, t, role) {
      var subagents = ctx.subagents; if (!subagents) return null
      var parent = rootForSession(sid); if (!parent) { console.error('[task-board] no root agent for session ' + sid + ', skip spawn'); return null }
      var providerName = pickProvider(); if (!providerName) { console.error('[task-board] no subagent provider'); return null }
      var modelOverride = ''
      if (role === 'verifier') { var dd = await rt(sid); modelOverride = (typeof dd.verifierModel === 'string' && dd.verifierModel.trim()) ? dd.verifierModel.trim() : ''; if (modelOverride && badModels[modelKey(sid, modelOverride)]) { console.error('[task-board] model ' + modelOverride + ' circuited, using parent model'); modelOverride = '' } }
      var req = { label: role + ':' + t.id, prompt: [{ type: 'text', text: role === 'worker' ? buildWorkerPrompt(t) : buildVerifierPrompt(t) }], parent: parent, signal: makeSignal() }
      if (modelOverride) req.agentOptions = { model: modelOverride }
      var run
      try { run = await subagents.start(providerName, req) } catch (e) {
        if (modelOverride) { console.error('[task-board] model override failed, fallback to parent model:', String(e)); delete req.agentOptions; try { run = await subagents.start(providerName, req) } catch (e2) { console.error('[task-board] spawn ' + role + ' failed:', String(e2)); return null } }
        else { console.error('[task-board] spawn ' + role + ' failed:', String(e)); return null }
      }
      var rec = { run: run, role: role, taskId: t.id, startedAt: Date.now(), model: modelOverride }
      runsFor(sid)[t.id] = rec
      if (!dispatchedEver[sid]) dispatchedEver[sid] = {}
      dispatchedEver[sid][String(run.id)] = true
      // 30min 硬超时（一次性 run 没有看门狗，挂死不能白占并发位）→ 走失败重试路径
      withTimeout(run.result, 1800000, role + ':' + t.id).then(function (res) { settleRun(sid, rec, res, null) }).catch(function (e) { settleRun(sid, rec, null, e) })
      return rec
    }

    // run 结算：保证 dispose；工具通道（board_report/board_verdict）已推进状态的话文本路径跳过
    async function settleRun(sid, rec, res, err) {
      if (runsFor(sid)[rec.taskId] !== rec) return // 已被 terminate 等路径处理
      delete runsFor(sid)[rec.taskId]
      try { await rec.run.dispose() } catch (_) {}
      var output = outputText(res)
      var failed = !!err || (res && res.stopReason && res.stopReason !== 'completed')
      var errText = err ? String(err) : (res && (res.diagnostic || res.stopReason) || '')
      try {
        if (rec.role === 'worker') await settleWorker(sid, rec, output, failed, errText)
        else await settleVerifier(sid, rec, output, failed, errText)
      } catch (e) { console.error('[task-board] settle ' + rec.role + ' failed (task ' + rec.taskId + '):', String(e)) }
    }

    async function settleWorker(sid, rec, output, failed, errText) {
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === rec.taskId })
        if (!t) return null
        // 工具通道已处理（board_report 已推进到 verifying/resolved 或挂了 escalation）→ 只收尾
        if (t.status !== 'in-progress' || t.escalation) return { task: t, already: true }
        if (failed) {
          t.retryCount = (t.retryCount || 0) + 1
          if (t.retryCount >= 3) { var ps = t.status; t.status = 'blocked'; ah(t, ps, 'blocked', String(rec.run.id), 'worker 失败 x' + t.retryCount + '（' + String(errText).slice(0, 120) + '），待人工介入'); return { task: t, blocked: true } }
          var ps2 = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps2, 'pending', String(rec.run.id), 'worker 失败（' + String(errText).slice(0, 80) + '），重新排队 (' + t.retryCount + '/3)')
          return { task: t, retry: true }
        }
        if (/\[ESCALATE\]/i.test(output || '')) {
          t.escalation = { question: output.slice(0, 2000), at: new Date().toISOString(), by: String(rec.run.id) }
          if (!Array.isArray(t.messages)) t.messages = []
          t.messages.push({ kind: 'escalation', text: output.slice(0, 4000), at: t.escalation.at, by: String(rec.run.id) })
          ah(t, 'in-progress', 'in-progress', String(rec.run.id), 'worker 上报歧义（文本通道），待主窗口裁决')
          return { task: t, escalated: true }
        }
        // 文本降级路径：分段格式上报
        var secs = parseSections(output)
        delete t.retryCount; delete t.stuckSince
        t.deliverable = { summary: secs.summary || output.slice(0, 600), changes: secs.changes || '', selfTest: secs.selfTest || '', at: new Date().toISOString(), by: String(rec.run.id) }
        resolveApply(d, t, String(rec.run.id), 'verifying', output || 'Worker 完成', 'worker 文本上报完成')
        return { task: t }
      })
      if (!result) return
      if (result.escalated) maybeNotify(sid, result.task)
      if (result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
      if (result.blocked) notifyTaskDone(sid, result.task, 'blocked')
      kickCycle(sid) // 结算后立刻补派
    }

    async function settleVerifier(sid, rec, output, failed, errText) {
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === rec.taskId })
        if (!t) return null
        if (t.status !== 'verifying' || t.escalation) return { task: t, already: true } // 工具通道已处理
        var trimmed = (output || '').trim()
        var vm = trimmed.match(/^[ \t>*#\-\s]*(APPROVED|REJECTED)\b/im)
        if (failed || !vm) {
          // 失败/空输出/无法判定：verifyRetries 计数，>=3 转人工验收（deliverable 已完成，是 verifier 故障不是任务故障）
          if (failed && rec.model) { badModels[modelKey(sid, rec.model)] = true }
          t.verifyRetries = (t.verifyRetries || 0) + 1
          if (t.verifyRetries >= 3) { t.escalation = { question: 'Verifier 连续 ' + t.verifyRetries + ' 次未能给出有效结论（' + (failed ? String(errText).slice(0, 150) : '输出格式异常') + '）。交付物已完成，请人工验收：看板详情页直接通过/驳回，或 task_verify 裁决。', at: new Date().toISOString(), by: 'system' }; ah(t, 'verifying', 'verifying', 'system', 'verifier 故障，转人工验收'); return { task: t, escalated: true } }
          ah(t, 'verifying', 'verifying', 'system', 'verifier 未给出有效结论，重新排队审查 (' + t.verifyRetries + '/3)')
          return { task: t, retry: true }
        }
        var approved = vm[1].toUpperCase() === 'APPROVED'
        var vsecs = parseSections(trimmed)
        delete t.stuckSince; delete t.verifyRetries
        t.verification = { verdict: approved ? 'approved' : 'rejected', summary: vsecs.verifySummary || trimmed.slice(0, 600), checks: vsecs.checks || '', at: new Date().toISOString(), by: String(rec.run.id) }
        verifyApply(d, t, String(rec.run.id), approved ? 'approved' : 'rejected', trimmed.slice(0, 200))
        if (!approved) {
          t.rejectCount = (t.rejectCount || 0) + 1
          if (t.rejectCount >= 3) { t.status = 'blocked'; ah(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x' + t.rejectCount + '，待人工裁决') }
          else { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', '驳回重派：新 Worker 将携带驳回原因继续') }
        }
        return { task: t, approved: approved }
      })
      if (!result) return
      if (result.escalated) maybeNotify(sid, result.task)
      if (result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
      if (result.task && result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      kickCycle(sid)
    }

    // 歧义上报聊天通知：仅 Team 模式推送到主窗口聊天流；自动模式靠看板面板 3s 轮询自动弹开（聊天通知是冗余噪音）
    function notifyMainWindow(sid, t, question) {
      var root = rootForSession(sid)
      if (!root) return
      try { root.followup(makeMsg('⚠️ [任务看板] Worker 上报歧义，等待裁决：\n\n任务: ' + t.title + ' (' + t.id + ')\n\n疑问:\n' + question.slice(0, 1500) + '\n\n请在看板详情页裁决，或直接回复指示（我会通过 resolve-escalation 转达给接手的 Worker）。')) } catch (e) { console.error('[task-board] escalate notify failed:', String(e)) }
    }
    function maybeNotify(sid, task) { if (task && task.escalation) { rt(sid).then(function (d) { if (d.teamMode) notifyMainWindow(sid, task, task.escalation.question) }).catch(function () {}) } }

    // ===== 任务回执通知（批量聚合 + 空闲门控）：派发执行的任务在 完成/阻塞 时通知主窗口 =====
    // 只通知派发执行的任务（isDispatched），主窗口自己手动处理的任务不回执（自己干的自己知道）。
    // 批量聚合：任务多时每任务一条 followup 会把主窗口 turn 队列打满（用户输入排队等回执处理完才刷新），
    // 改为 45s 窗口（或满 5 条）聚合为一条摘要；发送前等主窗口空闲，不打断对话。
    var receiptBuf = {}
    function notifyTaskDone(sid, t, kind) {
      if (!t || !isDispatched(sid, t.claimedBy)) return
      var buf = receiptBuf[sid] || (receiptBuf[sid] = { items: [], timer: null })
      var lastNote = (t.history && t.history.length) ? String(t.history[t.history.length - 1].note || '') : ''
      buf.items.push({ kind: kind, title: t.title, id: t.id, summary: (t.deliverable && t.deliverable.summary) || '', note: lastNote })
      if (buf.items.length >= 5) { flushReceipts(sid); return }
      if (!buf.timer) {
        var tm = ctx.timer
        if (tm) { var captured = buf; buf.timer = tm.timeout(45000).then(function () { if (receiptBuf[sid] === captured) flushReceipts(sid) }).catch(function () {}) }
        else flushReceipts(sid)
      }
    }
    function flushReceipts(sid) {
      var buf = receiptBuf[sid]; if (!buf) return
      receiptBuf[sid] = null
      if (!buf.items.length) return
      var root = rootForSession(sid); if (!root) return
      var done = [], blocked = []
      for (var i = 0; i < buf.items.length; i++) { (buf.items[i].kind === 'resolved' ? done : blocked).push(buf.items[i]) }
      var lines = ['📋 [任务看板] 回执摘要（' + buf.items.length + ' 条）', '']
      if (done.length) {
        lines.push('✅ 完成 ' + done.length + ' 个：')
        for (var j = 0; j < done.length && j < 8; j++) lines.push('  · ' + done[j].title + ' (' + done[j].id + ')' + (done[j].summary ? ' — ' + done[j].summary.slice(0, 120) : ''))
      }
      if (blocked.length) {
        lines.push('🛑 阻塞 ' + blocked.length + ' 个（需关注）：')
        for (var k = 0; k < blocked.length && k < 8; k++) lines.push('  · ' + blocked[k].title + ' (' + blocked[k].id + ')' + (blocked[k].note ? ' — ' + blocked[k].note.slice(0, 150) : ''))
      }
      lines.push('', '可用 task_list 查看全部；阻塞项可在看板拖回待办重新投放。')
      var text = lines.join('\n')
      function send() { try { root.followup(makeMsg(text)) } catch (e) { console.error('[task-board] receipt flush failed:', String(e)) } }
      if (typeof root.whenIdle === 'function') {
        var waited = withTimeout(root.whenIdle(), 300000, 'receipt-idle-wait') // 最多等 5 分钟，超时也发（不能丢回执）
        Promise.resolve(waited).then(send).catch(send)
      } else send()
    }

    // ===== 派发周期（15s 心跳 + 写入后 kickCycle 触发）=====
    async function poolCycle(sid) {
      var info = []
      var runs = runsFor(sid)
      var snap = await rt(sid)
      var activeW = 0, activeV = 0
      Object.keys(runs).forEach(function (k) { if (runs[k].role === 'worker') activeW++; else activeV++ })
      // 空闲快进：无活跃任务且无活跃 run → 不写盘直接返回（心跳每 15s 跑一次，不能每次都写文件）
      var hasActive = snap.tasks.some(function (t) { return t.status === 'pending' || t.status === 'verifying' || t.status === 'in-progress' })
      if (!hasActive && activeW + activeV === 0) { snap.poolStatus = { workers: [], verifiers: [] }; return snap }
      var c = cfg(snap)
      var isAuto = (snap.boardMode || 'auto') === 'auto'

      // 持锁：孤儿回收 + 占位 claim（防并发 cycle 重复派发）+ 池状态快照，一次原子写
      var toSpawn = []
      var result = await mutateLocked(sid, function (d) {
        if (isAuto) {
          var now = Date.now()
          // 孤儿回收（core.isOrphan）：in-progress 且 claimedBy 非主会话、无活跃 run、无 escalation、超 2 分钟 → 回 pending
          d.tasks.forEach(function (t) {
            if (isOrphan(d, t, runs, now)) { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', '执行 run 已结束/丢失，回收重新排队'); info.push('reclaim ' + t.id) }
          })
          var picked = pickDispatch(d, Math.max(0, c.maxWorkers - activeW), Math.max(0, c.maxVerifiers - activeV), null)
          picked.pendings.forEach(function (t) { claimApply(d, t, 'spawn-pending', 'dispatch'); toSpawn.push({ role: 'worker', t: t }); info.push('dispatch ' + t.id) })
          picked.verifs.forEach(function (t) { toSpawn.push({ role: 'verifier', t: t }); info.push('verify ' + t.id) })
        }
        // UI 池状态：来自活跃 run（一次性模型：没有成员名册，只有在跑的任务）
        d.poolStatus = { workers: [], verifiers: [] }
        Object.keys(runs).forEach(function (k) { var rc = runs[k]; d.poolStatus[rc.role === 'worker' ? 'workers' : 'verifiers'].push({ id: k, num: '-', busy: true, taskId: rc.taskId, runId: String(rc.run.id), done: 0, queueLen: 0, suspect: false, model: rc.model || '' }) })
        if (info.length > 0) d.dispatchInfo = info.join('; ')
        return d
      }, true) // skipKick：poolCycle 自写不触发 kickCycle（防无限循环）

      // 锁外 spawn（慢操作）；占位 claim 已保证不会被别的 cycle 重复派发
      for (var k = 0; k < toSpawn.length; k++) {
        var sp = toSpawn[k]
        var rec = await spawnOneShot(sid, sp.t, sp.role)
        if (rec) {
          // claim 占位换成真实 run id
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t) { if (sp.role === 'worker' && t.claimedBy === 'spawn-pending') t.claimedBy = String(rec.run.id) }; return t }, true)
        } else if (sp.role === 'worker') {
          // spawn 失败 → 回 pending（verifier spawn 失败无需处理，下轮 cycle 会重试）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.status === 'in-progress' && t.claimedBy === 'spawn-pending') { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', 'spawn 失败，回收重新排队') }; return t }, true)
        }
      }
      return result
    }

    // 插件停止时清理所有活跃 run
    ctx.effect(function () { return function () { Object.keys(activeRuns).forEach(function (psid) { var rr = activeRuns[psid]; Object.keys(rr).forEach(function (k) { try { rr[k].run.dispose() } catch (_) {} }) }); activeRuns = {} } })
    // Host 侧调度心跳：每 15s 对所有已知会话跑 poolCycle（客户端轮询只是触发器之一，面板关闭/后台节流时照常运转）
    ;(function () { var tm = ctx.timer; if (!tm) return; var disposeTick = tm.interval(function () { var cutoff = Date.now() - 1800000; Object.keys(knownSessions).forEach(function (sid) { if (knownSessions[sid] < cutoff) delete knownSessions[sid]; else poolCycle(sid).catch(function () {}) }) }, 15000); ctx.effect(function () { return disposeTick }) })()

    // ===== Team 模式提示词引导（v65）：teamMode 开启时往主窗口 agent 的 system prompt 注入看板派发引导 =====
    // 用动态 section（text 函数每次组装求值）：开启时注入，关闭时返回空串不落盘。
    // 只对 root agent 注入（池中 worker/verifier 有自己的 prompt 契约，不需要这段）。
    var sysPrompt = ctx.get('systemPrompt')
    if (sysPrompt) {
      var disposeSection = sysPrompt.section({
        name: 'task-board:team-mode',
        order: 250,
        text: function (assembleCtx) {
          var agent = assembleCtx && assembleCtx.agent
          if (!agent) return ''
          var aid = String(agent.id || '')
          var sid = resolveRoot(aid)
          // P0 修复：只对 root agent 自身注入。Worker/Verifier 的 resolveRoot 也会返回主会话 sid，
          // 但 agent.id !== sid 说明是子代理——子代理有自己的 prompt 契约，不需要"你是主窗口"引导。
          // 之前缺这行守卫 → Worker 也收到"请用 task_create 派发任务"→ Worker 误认自己是主窗口。
          if (aid !== sid) return ''
          if (!teamModeCache[sid]) return ''
          return '【任务看板 Team 模式已开启】\n本会话的任务看板处于 Team 模式。请遵循以下工作方式：\n1. 涉及代码改动、文件创建、命令执行等实质性工作时，优先用 task_create 提交为看板任务（由一次性 Worker/Verifier 子代理执行与验收），不要自己直接动手实现。\n2. 你仍保有全部工具能力——调研、读代码、讨论方案、回答问题时直接进行，无需提交任务。\n3. Worker 上报歧义时会通过 task_arbitrate 等待你裁决，请及时响应。\n4. 任务尽量一次写清 description/dependsOn/acceptance；需要分步建设的用 task_create draft:true 先建草稿，补全后 publish。'
        },
      })
      ctx.effect(function () { return disposeSection })
    }

    // ===== Tools =====
    ctx.tools.register(defineTool({ name: 'task_list', description: '列出当前会话任务。', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in-progress', 'verifying', 'resolved', 'blocked', 'cancelled'] }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, tag: { type: 'string' }, parentId: { type: 'string' }, includeArchived: { type: 'boolean' }, limit: { type: 'number' } }, required: [] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var d = await rt(sid); var a = d.tasks; var ts = a; if (!args.includeArchived) ts = ts.filter(function (x) { return x.status !== 'archived' }); if (args.status) ts = ts.filter(function (x) { return x.status === args.status }); if (args.priority) ts = ts.filter(function (x) { return x.priority === args.priority }); if (args.tag) ts = ts.filter(function (x) { return (x.tags || []).indexOf(args.tag) >= 0 }); if (args.parentId === 'null') ts = ts.filter(function (x) { return !isb(x) }); else if (args.parentId) ts = ts.filter(function (x) { return x.parentId === args.parentId }); var po = PRIO_RANK; ts.sort(function (a, b) { var dd = (po[b.priority] || 0) - (po[a.priority] || 0); return dd !== 0 ? dd : (a.createdAt || '').localeCompare(b.createdAt || '') }); var lim = Math.min(args.limit || 20, 100); var res = ts.slice(0, lim).map(function (x) { var e = Object.assign({}, x); if (isb(x)) { var p = gpt(x, a); if (p) e.parentSummary = { id: p.id, title: p.title, status: p.status } }; var ch = gsb(x.id, a); if (ch.length) { e.subtaskCount = ch.length; e.subtaskResolved = ch.filter(function (y) { return y.status === 'resolved' }).length }; return e }); var out = { tasks: res, total: ts.length, session: sid, actor: getActorId(), boardMode: d.boardMode || 'auto', teamMode: !!d.teamMode, poolStatus: d.poolStatus }; if (d.teamMode) out.teamHint = 'Team 模式已开启：实质性改动请优先 task_create 提交看板由池执行；调研/读取/讨论可直接进行；Worker 歧义会上报等你裁决。'; return out } }))
    ctx.tools.register(defineTool({ name: 'task_context', description: '获取任务完整上下文。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, expandFiles: { type: 'boolean' }, includeParent: { type: 'boolean' }, includeSubtasks: { type: 'boolean' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var d = await rt(sid); var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found: ' + args.taskId }; return { ok: true, context: { task: t, inheritedContext: t.context || {} } } } }))
    ctx.tools.register(defineTool({ name: 'task_claim', description: '领取待办任务→in-progress。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var err = claimCheck(d, t, actor); if (err) return { ok: false, error: err }; claimApply(d, t, actor, args.reason || 'claimed'); return { ok: true, task: t, context: { task: t, inheritedContext: t.context || {} } } }) } }))
    ctx.tools.register(defineTool({ name: 'task_resolve', description: '提交验证(verifying)或阻塞(blocked)。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string', enum: ['verifying', 'blocked'] }, resolution: { type: 'string' } }, required: ['taskId', 'status'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress' }; if (t.claimedBy !== actor) return { ok: false, error: 'not claimed by you' }; if (args.status === 'verifying' && !args.resolution) return { ok: false, error: 'resolution required' }; return resolveApply(d, t, actor, args.status, args.resolution, args.resolution || args.status) }) } }))
    ctx.tools.register(defineTool({ name: 'task_verify', description: '验收：approved→resolved，rejected→in-progress。子任务全完成父任务自动verifying。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'rejected'] }, comment: { type: 'string' } }, required: ['taskId', 'verdict'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'verifying') return { ok: false, error: 'not verifying' }; return verifyApply(d, t, actor, args.verdict, args.comment) }) } }))
    ctx.tools.register(defineTool({ name: 'task_archive', description: '归档已解决/已取消任务。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var a = d.tasks; var t = a.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'resolved' && t.status !== 'cancelled') return { ok: false, error: 'only resolved/cancelled' }; var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'archived'); var ca = 0; gsb(t.id, a).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } }); var r = { ok: true, task: t }; if (ca) r.childrenArchived = ca; return r }) } }))
    ctx.tools.register(defineTool({ name: 'task_update', description: '更新任务字段，可选重置为 pending。dependsOn/pipeline 也可更新（环检测会拒绝成环依赖）。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, assignMode: { type: 'string', enum: ['auto', 'manual'] }, assignee: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, pipeline: { type: 'string', enum: ['full', 'work', 'direct'] }, resetToPending: { type: 'boolean' }, publish: { type: 'boolean', description: '发布草稿为 pending（仅 draft 状态有效）' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (args.title !== undefined) t.title = args.title; if (args.description !== undefined) t.description = args.description; if (args.priority !== undefined) t.priority = args.priority; if (args.assignMode !== undefined) t.assignMode = args.assignMode; if (args.assignee !== undefined) t.assignee = args.assignee || null; if (args.dependsOn !== undefined) { var derr = validateDeps(d, t.id, args.dependsOn); if (derr) return { ok: false, error: derr }; t.dependsOn = args.dependsOn } if (args.pipeline !== undefined) { t.pipeline = args.pipeline; t.pipelineAuto = false } if (args.publish) { if (t.status !== 'draft') return { ok: false, error: 'not a draft' }; t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'published') } if (args.resetToPending) { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'pending', actor, 'reset to pending after edit') }; return { ok: true, task: t } }) } }))
    ctx.tools.register(defineTool({ name: 'task_create', description: '创建新任务到当前会话看板。acceptance 可选：硬性验收脚本命令（如 "node --test src/x.test.js"），Worker 必须实际运行、Verifier 必须独立复跑。dependsOn 可选：依赖任务 id 数组，依赖全部完成后才会被派发。pipeline 可选：full(默认,工作+验证)/work(只做不验)/direct(不进池，主窗口直接处理)。', parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, tags: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' }, instructions: { type: 'string' }, acceptance: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, pipeline: { type: 'string', enum: ['full', 'work', 'direct'] }, draft: { type: 'boolean', description: 'true 创建为草稿（不派发不可领取），补全信息后用 task_update publish=true 发布' } }, required: ['title'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { if (args.id && d.tasks.find(function (x) { return x.id === args.id })) return { ok: false, error: 'duplicate id: ' + args.id }; if (args.dependsOn && args.dependsOn.length) { var derr = validateDeps(d, args.id || '(pending)', args.dependsOn); if (derr) return { ok: false, error: derr } }; var now = new Date().toISOString(); var t = { id: args.id || ('task-' + Date.now().toString(36)), title: args.title, description: args.description || '', status: args.draft ? 'draft' : 'pending', priority: args.priority || 'medium', tags: args.tags || [], parentId: args.parentId || null, subtaskStrategy: null, assignMode: 'auto', assignee: null, context: { files: [], docs: [], instructions: args.instructions || '', relatedTasks: [], prerequisites: '' }, acceptance: args.acceptance || '', dependsOn: args.dependsOn || [], pipeline: args.pipeline || '', claimedBy: null, claimedAt: null, createdAt: now, resolvedAt: null, verifiedAt: null, verifiedBy: null, archivedAt: null, resolution: null, messages: [], history: [{ from: 'created', to: args.draft ? 'draft' : 'pending', timestamp: now, actor: actor, note: args.draft ? 'created as draft' : 'created' }] }; if (!t.pipeline) t.pipeline = classifyPipeline(t); t.pipelineAuto = !args.pipeline; d.tasks.push(t); return { ok: true, task: t } }) } }))

    // ===== RPC =====
    // get-tasks 是纯读路径（rt 只读文件）——poolCycle 由 15s 心跳 + 写入后 kickCycle 驱动，
    // 客户端 3s 轮询不再触发池计算/写盘（之前每轮询一次就 poolCycle+写盘一次，切会话时多会话轮询挤在文件锁上）
    handle('get-tasks', async function (args) { var sid = rpcSessionId(args); var d = await rt(sid); d.sessionId = sid; var __ag = ctx.agents; d.isRoot = true; if (__ag) { var __roots = __ag.roots(); var __rids = []; for (var __i = 0; __i < __roots.length; __i++) __rids.push(String(__roots[__i].id)); d.isRoot = __rids.indexOf(sid) >= 0 } return d })
    handle('claim-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var err = claimCheck(d, t, actor); if (err) return { ok: false, error: err }; claimApply(d, t, actor, 'manual claim via board'); return { ok: true, task: t } }) })
    handle('resolve-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress' }; return resolveApply(d, t, actor, args.status, args.resolution, args.resolution || args.status) }) })
    handle('verify-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'verifying') return { ok: false, error: 'not verifying' }; delete t.escalation; delete t.verifyRetries; return verifyApply(d, t, actor, args.verdict, args.comment) }) })
    handle('archive-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var a = d.tasks; var t = a.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'resolved' && t.status !== 'cancelled') return { ok: false, error: 'cannot archive' }; var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'manual archive'); var ca = 0; gsb(t.id, a).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } }); var r = { ok: true, task: t }; if (ca) r.childrenArchived = ca; return r }) })
    handle('update-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (args.title !== undefined) t.title = args.title; if (args.description !== undefined) t.description = args.description; if (args.priority !== undefined) t.priority = args.priority; if (args.assignMode !== undefined) t.assignMode = args.assignMode; if (args.assignee !== undefined) t.assignee = args.assignee || null; if (args.dependsOn !== undefined) { var derr = validateDeps(d, t.id, args.dependsOn); if (derr) return { ok: false, error: derr }; t.dependsOn = args.dependsOn } if (args.pipeline !== undefined) { t.pipeline = args.pipeline; t.pipelineAuto = false } if (args.publish) { if (t.status !== 'draft') return { ok: false, error: 'not a draft' }; t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'published') } if (args.resetToPending) { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'pending', actor, 'reset to pending after edit') }; return { ok: true, task: t } }) })
    handle('set-board-mode', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { d.boardMode = args.mode === 'manual' ? 'manual' : 'auto'; return { ok: true, boardMode: d.boardMode } }) })
    handle('set-team-mode', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { d.teamMode = !!args.enabled; return { ok: true, teamMode: d.teamMode } }) })
    // 裁决回流（v74 一次性模型）：原 Worker 已结束，答案写入 history 后任务回 pending，
    // 下个派发周期 spawn 新 Worker，裁决内容随 prompt 注入（histNotes 匹配"裁决"）
    async function doResolveEscalation(sid, actor, taskId, answer) {
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (!t.escalation) return { ok: false, error: 'not escalated' }
        delete t.escalation
        if (!Array.isArray(t.messages)) t.messages = []
        t.messages.push({ kind: 'arbitration', text: answer || '', at: new Date().toISOString(), by: actor })
        ah(t, t.status, t.status, actor, '主窗口裁决: ' + (answer || '').slice(0, 200))
        // in-progress 的歧义任务：回 pending 重派（新 Worker 带裁决上下文）；verifying 的 verifier 故障升级：保持待审，下轮派新 verifier
        if (t.status === 'in-progress') { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps, 'pending', 'system', '带裁决重新排队') }
        return { ok: true, task: t, answer: answer || '' }
      })
      return result
    }
    // 高优介入（v74）：有活跃 run 则直接 followup 进其会话；无则只记录 history（下次派发随 prompt 注入）
    async function doIntervene(sid, actor, taskId, msg) {
      if (!(msg || '').trim()) return { ok: false, error: 'message required' }
      var rec = runsFor(sid)[taskId]
      var delivered = false
      if (rec && rec.run && rec.run.localAgent) {
        try { rec.run.localAgent.followup(makeMsg('[高优先级干预] 来自主窗口/用户的指令：\n\n' + msg + '\n\n请优先响应此指令，然后继续当前任务。')); delivered = true } catch (_) {}
      }
      await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === taskId }); if (t) { if (!Array.isArray(t.messages)) t.messages = []; t.messages.push({ kind: 'intervention', text: msg, at: new Date().toISOString(), by: actor }); ah(t, t.status, t.status, actor, '高优干预: ' + msg.slice(0, 200) + (delivered ? '' : '（无活跃 run，随下次派发注入）')) }; return t })
      return { ok: true, delivered: delivered }
    }
    // 终止执行某任务的 run：dispose 并回 pending（verifying 则保持待审，由新 verifier 接手）
    async function doTerminate(sid, actor, taskId) {
      var rec = runsFor(sid)[taskId]
      var label = 'no-active-run'
      if (rec) { delete runsFor(sid)[taskId]; label = rec.role + ':' + taskId; try { await rec.run.dispose() } catch (_) {} }
      await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return null
        delete t.stuckSince
        if (t.status === 'in-progress') { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps, 'pending', actor, '手动终止，任务重新排队') }
        else if (t.status === 'verifying') { ah(t, 'verifying', 'verifying', actor, '手动终止审查，等待新 verifier 接手') }
        return t
      })
      return { ok: true, terminated: label }
    }
    // 继续等待：清除卡死标记
    async function doDismiss(sid, actor, taskId) {
      await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (t) { delete t.stuckSince; ah(t, t.status, t.status, actor, '清除卡死标记，继续观察') }
        return t
      })
      return { ok: true }
    }
    handle('terminate-agent', async function (args) { return doTerminate(rpcSessionId(args), getActorId(), args.taskId) })
    handle('dismiss-suspect', async function (args) { return doDismiss(rpcSessionId(args), getActorId(), args.taskId) })
    ctx.tools.register(defineTool({ name: 'task_terminate', description: 'Team 模式：终止执行某任务的池中 Agent（卡死/跑偏时）。in-progress 任务回 pending 重派，verifying 由新 verifier 接手。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doTerminate(toolSessionId(), getActorId(), args.taskId) } }))
    handle('resolve-escalation', async function (args) { return doResolveEscalation(rpcSessionId(args), getActorId(), args.taskId, args.answer) })
    handle('intervene-agent', async function (args) { return doIntervene(rpcSessionId(args), getActorId(), args.taskId, args.message) })
    // 主 Agent 工具版（Team 模式下主 Agent 通过工具裁决/介入）
    ctx.tools.register(defineTool({ name: 'task_arbitrate', description: 'Team 模式：裁决 Worker 上报的歧义（escalation）。答案直接转达给原 Worker 继续执行。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, answer: { type: 'string' } }, required: ['taskId', 'answer'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doResolveEscalation(toolSessionId(), getActorId(), args.taskId, args.answer) } }))
    ctx.tools.register(defineTool({ name: 'task_intervene', description: 'Team 模式：向执行某任务的池中 Agent 发起高优先级指令（插入其队列头部，当前 turn 结束后优先处理）。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, message: { type: 'string' } }, required: ['taskId', 'message'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doIntervene(toolSessionId(), getActorId(), args.taskId, args.message) } }))
    // ===== 池中 Agent 结构化回报工具（双模：工具优先，文本分段为降级路径）=====
    ctx.tools.register(defineTool({ name: 'board_report', description: '[任务看板 Worker 专用] 上报任务结果。kind=complete 时填 summary/changes/selfTest；kind=escalate 时填 question（歧义上报，等待主窗口裁决）。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, kind: { type: 'string', enum: ['complete', 'escalate'] }, summary: { type: 'string' }, changes: { type: 'string' }, selfTest: { type: 'string' }, question: { type: 'string' } }, required: ['taskId', 'kind'] }, output: jo(), execute: async function (args) {
      var sid = toolSessionId(); var actor = getActorId()
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress (状态: ' + t.status + ')' }
        if (!Array.isArray(t.messages)) t.messages = []
        if (args.kind === 'escalate') {
          var at = new Date().toISOString()
          t.escalation = { question: (args.question || '').slice(0, 2000), at: at, by: actor }
          t.messages.push({ kind: 'escalation', text: (args.question || '').slice(0, 4000), at: at, by: actor })
          ah(t, 'in-progress', 'in-progress', actor, '上报歧义（工具通道），待主窗口裁决')
          return { ok: true, escalated: true, task: t }
        }
        delete t.escalation
        delete t.retryCount // v72：成功完成清零超时重试计数（工具直报路径）
        delete t.stuckSince
        t.deliverable = { summary: args.summary || '', changes: args.changes || '', selfTest: args.selfTest || '', at: new Date().toISOString(), by: actor }
        var r = resolveApply(d, t, actor, 'verifying', (args.summary || '') + (args.selfTest ? '\n\n自测: ' + args.selfTest.slice(0, 300) : ''), 'worker 工具上报完成')
        r.ok = true; r.task = t
        return r
      })
      if (result && result.ok && result.escalated) maybeNotify(sid, result.task)
      if (result && result.ok && result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved') // 工具直报路径也要回执（work 档 board_report 直接落 resolved）
      return result
    } }))
    ctx.tools.register(defineTool({ name: 'board_verdict', description: '[任务看板 Verifier 专用] 提交验收结论。verdict=approved/rejected；summary=测试概要；checks=逐条核对证据。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'rejected'] }, summary: { type: 'string' }, checks: { type: 'string' } }, required: ['taskId', 'verdict'] }, output: jo(), execute: async function (args) {
      var sid = toolSessionId(); var actor = getActorId()
      var approved = args.verdict === 'approved'
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (t.status !== 'verifying') return { ok: false, error: 'not verifying (状态: ' + t.status + ')' }
        delete t.escalation; delete t.verifyRetries // verifier 恢复产出：清人工验收标记
        t.verification = { verdict: args.verdict, summary: args.summary || '', checks: args.checks || '', at: new Date().toISOString(), by: actor }
        verifyApply(d, t, actor, args.verdict, (args.summary || '').slice(0, 200))
        if (!approved) { t.rejectCount = (t.rejectCount || 0) + 1; if (t.rejectCount >= 3) { t.status = 'blocked'; ah(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x' + t.rejectCount + '，待人工裁决') } }
        return { ok: true, task: t }
      })
      if (result && result.ok && result.task) {
        if (result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
        if (result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      }
      if (result && result.ok && !approved && result.task) {
        // v74 一次性模型：原 Worker 已销毁，驳回任务回 pending 重派新 Worker（驳回原因已在 verifyApply 的 history 里，随 prompt 注入）
        var bt = result.task
        if ((bt.rejectCount || 0) < 3) { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === bt.id }); if (t2 && t2.status === 'in-progress') { t2.status = 'pending'; t2.claimedBy = null; t2.claimedAt = null }; return t2 }, true) }
      }
      return result
    } }))
    // 枚举当前网关可用模型（供 Verifier 模型下拉选择）：llm.listProviders + listModels
    handle('list-models', async function () {
      var llm = ctx.get('llm'); if (!llm) return { ok: false, error: 'llm service unavailable' }
      var providers = llm.listProviders()
      var out = []
      for (var i = 0; i < providers.length; i++) {
        try {
          var models = await llm.listModels(providers[i].id)
          for (var j = 0; j < models.length; j++) out.push({ id: providers[i].id + '/' + models[j].id, name: models[j].name || models[j].id, provider: providers[i].name || providers[i].id })
        } catch (_) { /* 某 provider 枚举失败不阻塞整体 */ }
      }
      return { ok: true, models: out }
    })
    handle('set-board-config', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { if (args.key === 'maxWorkers') d.maxWorkers = Math.max(1, Math.min(10, args.value || 3)); else if (args.key === 'maxVerifiers') d.maxVerifiers = Math.max(0, Math.min(5, args.value || 0)); else if (args.key === 'verifierModel') d.verifierModel = typeof args.value === 'string' ? args.value.trim() : ''; return { ok: true } }) })
    handle('create-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { if (args.id && d.tasks.find(function (x) { return x.id === args.id })) return { ok: false, error: 'duplicate id' }; if (args.dependsOn && args.dependsOn.length) { var derr = validateDeps(d, args.id || '(pending)', args.dependsOn); if (derr) return { ok: false, error: derr } }; var now = new Date().toISOString(); var t = { id: args.id || ('task-' + Date.now().toString(36)), title: args.title || 'Untitled', description: args.description || '', status: args.draft ? 'draft' : 'pending', priority: args.priority || 'medium', tags: args.tags || [], parentId: args.parentId || null, subtaskStrategy: null, assignMode: 'auto', assignee: null, context: { files: [], docs: [], instructions: args.instructions || '', relatedTasks: [], prerequisites: '' }, acceptance: args.acceptance || '', dependsOn: args.dependsOn || [], pipeline: args.pipeline || '', claimedBy: null, claimedAt: null, createdAt: now, resolvedAt: null, verifiedAt: null, verifiedBy: null, archivedAt: null, resolution: null, messages: [], history: [{ from: 'created', to: args.draft ? 'draft' : 'pending', timestamp: now, actor: actor, note: args.draft ? 'created as draft' : 'created' }] }; if (!t.pipeline) { t.pipeline = classifyPipeline(t); t.pipelineAuto = true }; d.tasks.push(t); return { ok: true, task: t } }) })
    handle('list-children', async function (args) { var sid = rpcSessionId(args); var subs = ctx.subagents; if (!subs) return { ok: true, children: [] }; try { var list = await subs.listChildren(sid); var children = (list || []).map(function (c) { return { id: String(c.sessionId || c.id || ''), label: String(c.label || c.title || c.mode || '') } }).filter(function (c) { return c.id.length > 0 }); return { ok: true, children: children } } catch (e) { return { ok: true, children: [], error: String(e) } } })
    // ===== #14 批量操作：archive（仅 resolved/cancelled）/ set-priority（全部）=====
    handle('batch-op', async function (args) {
      var sid = rpcSessionId(args); var actor = getActorId()
      var ids = Array.isArray(args.ids) ? args.ids : []
      if (ids.length === 0) return { ok: false, error: 'no ids' }
      return mutateLocked(sid, function (d) {
        var done = 0, skipped = []
        ids.forEach(function (id) {
          var t = d.tasks.find(function (x) { return x.id === id })
          if (!t) { skipped.push(id); return }
          if (args.op === 'archive') {
            if (t.status !== 'resolved' && t.status !== 'cancelled') { skipped.push(id); return }
            var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'batch archive'); done++
          } else if (args.op === 'set-priority') {
            if (['low', 'medium', 'high', 'critical'].indexOf(args.value) < 0) { skipped.push(id); return }
            t.priority = args.value; ah(t, t.status, t.status, actor, '批量设优先级: ' + args.value); done++
          } else { skipped.push(id) }
        })
        return { ok: true, done: done, skipped: skipped }
      })
    })
    // #16 批量撤销：按快照恢复 priority（任何状态）与 status（仅 archive→resolved 回滚）
    handle('batch-undo', async function (args) {
      var sid = rpcSessionId(args); var actor = getActorId()
      var snap = args && args.snapshot
      if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) return { ok: false, error: 'no snapshot' }
      return mutateLocked(sid, function (d) {
        var done = 0, skipped = []
        snap.items.forEach(function (it) {
          var t = d.tasks.find(function (x) { return x.id === it.id })
          if (!t) { skipped.push(it.id); return }
          t.priority = it.priority || t.priority
          if (snap.op === 'archive' && t.status === 'archived' && (it.status === 'resolved' || it.status === 'cancelled')) {
            t.status = it.status; delete t.archivedAt
            ah(t, 'archived', it.status, actor, '撤销批量归档')
          } else {
            ah(t, t.status, t.status, actor, '撤销批量优先级: ' + t.priority)
          }
          done++
        })
        return { ok: true, done: done, skipped: skipped }
      })
    })

    // ===== client ↔ host RPC：POST /dsh-agent-board { method, args } → JSON =====
    function readBody(req, limit) {
      return new Promise(function (resolve, reject) {
        var chunks = [], size = 0
        req.on('data', function (c) { size += c.length; if (size > limit) { reject(new Error('payload too large')); try { req.destroy() } catch (_) {} return }; chunks.push(c) })
        req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')) })
        req.on('error', reject)
      })
    }
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-board',
      handler: async function (req, res) {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ ok: false, message: 'method not allowed' })); return }
        var payload = null
        try { payload = JSON.parse(await readBody(req, 4 * 1024 * 1024)) } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'bad request' })); return }
        var fn = payload && handlers[payload.method]
        if (!fn) { res.writeHead(404); res.end(JSON.stringify({ ok: false, message: 'unknown method: ' + payload.method })); return }
        try { var out = await fn(payload.args); res.writeHead(200); res.end(JSON.stringify(out === undefined ? null : out)) } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, message: String(e) })) }
      },
    })

    console.log('[task-board] v74 loaded (pool removed: one-shot dispatch, context injected per task, dispose on settle)')
}
