// dsh-agent-board — Agent 任务看板（host 端）
// 本文件即源码，直接维护（v68 起：变形层已拆除，不再从其他文件生成）。
//
// 零外部依赖：link: 安装的包从真实路径解析，裸 import '@deepseek-ai/dsh-tools'
// 会解析失败（ERR_MODULE_NOT_FOUND）。defineTool 本体只是 校验+包装 出
// {name, description, parameters, output, execute} 普通对象，这里内联等价实现。
// parameters 已是完整 JSON Schema，原样透传；output 透传 schema+render。
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
    const MAX_CLAIMED = 3
    const CLAIMABLE = ['pending', 'blocked']

    // ===== 工具函数 =====
    function getActorId() { const a = ctx.agents; if (a) { const i = a.currentInitiator(); if (i) return String(i.id) } return 'unknown' }
    function resolveRoot(sid) { const agentsSvc = ctx.agents; if (!agentsSvc) return sid; var cur = sid; var roots = agentsSvc.roots(); var rids = []; for (var i = 0; i < roots.length; i++) rids.push(String(roots[i].id)); if (rids.indexOf(cur) >= 0) return cur; var all = agentsSvc.list(); var g = 0; while (g++ < 20) { var o = null; for (var j = 0; j < all.length; j++) { if (agentsSvc.isOwnedBy(cur, all[j])) { o = all[j]; break } }; if (!o) break; cur = String(o.id); if (rids.indexOf(cur) >= 0) return cur }; return cur }
    function toolSessionId() { var sid = resolveRoot(getActorId()); touchSession(sid); return sid }
    function rpcSessionId(args) { var sid = (args && typeof args.sessionId === 'string' && args.sessionId.length > 0) ? args.sessionId : resolveRoot(getActorId()); touchSession(sid); return sid }
    // 已知会话集合：心跳驱动这些会话的 poolCycle（摆脱对客户端轮询的依赖）
    var knownSessions = {}
    function touchSession(sid) { if (sid && typeof sid === 'string' && sid !== 'unknown') knownSessions[sid] = Date.now() }
    // teamMode 缓存：由 rt() 同步，供 systemPrompt 动态引导段读取（v65）
    var teamModeCache = {}
    function fileFor(sid) { return '.dsh/tasks-' + sid + '.json' }
    function vt(d) { return d && typeof d === 'object' && Array.isArray(d.tasks) }
    function ah(t, f, to, ac, n) { if (!Array.isArray(t.history)) t.history = []; t.history.push({ from: f, to: to, timestamp: new Date().toISOString(), actor: ac, note: n || '' }) }
    function isb(t) { return t.parentId != null }
    function gsb(p, a) { return a.filter(function (x) { return x.parentId === p }) }
    function gpt(t, a) { return isb(t) ? a.find(function (x) { return x.id === t.parentId }) : undefined }
    // #18 依赖校验：存在性 + 自引用 + DFS 环检测（返回错误消息或 null）
    function validateDeps(d, taskId, deps) {
      if (!Array.isArray(deps)) return 'dependsOn must be array'
      for (var i = 0; i < deps.length; i++) {
        var dep = deps[i]
        if (dep === taskId) return 'self-dependency: ' + dep
        if (!d.tasks.find(function (x) { return x.id === dep })) return 'dependency not found: ' + dep
      }
      // 环检测：从每个依赖出发沿 dependsOn 链游走，若能回到 taskId 则成环
      var target = taskId
      var visited = {}
      function reaches(cur) {
        if (cur === target) return true
        if (visited[cur]) return false
        visited[cur] = true
        var ct = d.tasks.find(function (x) { return x.id === cur })
        var cd = (ct && Array.isArray(ct.dependsOn)) ? ct.dependsOn : []
        for (var k = 0; k < cd.length; k++) { if (reaches(cd[k])) return true }
        return false
      }
      for (var j = 0; j < deps.length; j++) { if (reaches(deps[j])) return 'circular dependency via: ' + deps[j] }
      return null
    }
    // #18 依赖是否全部满足（resolved/archived 视为满足）
    function depsSatisfied(d, t) {
      if (!Array.isArray(t.dependsOn) || t.dependsOn.length === 0) return true
      return t.dependsOn.every(function (id) { var x = d.tasks.find(function (y) { return y.id === id }); return x && (x.status === 'resolved' || x.status === 'archived') })
    }
    // #18 依赖是否被永久阻断（依赖已 cancelled → 依赖方永远无法满足）
    function depsCancelled(d, t) {
      if (!Array.isArray(t.dependsOn) || t.dependsOn.length === 0) return false
      return t.dependsOn.some(function (id) { var x = d.tasks.find(function (y) { return y.id === id }); return x && x.status === 'cancelled' })
    }
    // #19 管线分类：规则先行，兜底 full（宁严勿漏）
    function classifyPipeline(t) {
      if (t.acceptance && String(t.acceptance).trim()) return 'full'
      var text = ((t.title || '') + ' ' + (t.description || '')).toLowerCase()
      if (/解释|为什么|是什么|区别|对比|说明一下|是什么意思|how to|what is|why /.test(text)) return 'direct'
      if (/文档|调研|整理|总结|报告|指南|白皮书|readme|分析文/.test(text)) return 'work'
      return 'full'
    }
    function seed(sid) { return { version: 10, ownerSession: sid, boardMode: 'auto', teamMode: false, minWorkers: 1, maxWorkers: 3, minVerifiers: 0, maxVerifiers: 2, verifierModel: '', poolRoster: { nextW: 1, nextV: 1, members: [] }, tasks: [] } }
    async function rt(sid) { try { var t = await fs.resolve(fileFor(sid)); var r = await fs.readText(t); var d = JSON.parse(r); if (vt(d) && d.ownerSession === sid) { teamModeCache[sid] = !!d.teamMode; return d }; return seed(sid) } catch (_) { return seed(sid) } }
    async function wt(sid, d) { var c = JSON.stringify(d, null, 2); try { var t = await fs.resolve(fileFor(sid)); await fs.writeText(t, c) } catch (e) { console.error('[task-board] write:', String(e)); throw e } }
    // 每会话一条 promise 链，串行化所有 读-改-写，消除并发写竞争
    var fileLocks = {}
    function withLock(sid, fn) { var prev = fileLocks[sid] || Promise.resolve(); var p = prev.then(function () { return fn() }); fileLocks[sid] = p.catch(function () {}); return p }
    // 便捷：串行的 读→mutate→写。mutate(d) 返回值作为结果；mutate 返回 null/undefined 则不写
    function mutateLocked(sid, mutate) { return withLock(sid, async function () { var d = await rt(sid); var r = await mutate(d); if (r !== null && r !== undefined) { await wt(sid, d); return r } return r }) }
    function jo() { return { schema: { type: 'object', additionalProperties: true }, render: function (a, v) { return [{ type: 'text', text: JSON.stringify(v, null, 2) }] } } }
    // 按会话找 root agent（静态插件挂 host 层后多会话共存，不能"取第一个"——会把 worker 挂到别的会话上）
    function rootForSession(sid) { var s = ctx.agents; if (!s) return undefined; var r = s.roots(); for (var i = 0; i < r.length; i++) { if (String(r[i].id) === sid) return r[i] } return undefined }
    function makeSignal() { try { return new AbortController().signal } catch (_) { return { aborted: false, addEventListener: function () {}, removeEventListener: function () {} } } }
    function makeMsg(text) { return { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'user' } } }
    // readOutput: 从尾部取最后一条含文本的 assistant/message，且 turn 必须 >= minTurn（排除 seed 与旧 turn——子 agent 会话携带主会话历史 seed）
    function readOutput(agent, minTurn) { var evts = agent.session.events; for (var i = evts.length - 1; i >= 0; i--) { var e = evts[i]; if (e.type === 'assistant/message' && e.data && e.data.message && e.data.message.content) { if (minTurn != null && typeof e.data.turn === 'number' && e.data.turn < minTurn) continue; var c = e.data.message.content; if (typeof c === 'string') return c; if (Array.isArray(c)) { var ts = []; for (var j = 0; j < c.length; j++) { if (c[j] && c[j].type === 'text' && c[j].text) ts.push(c[j].text) } if (ts.length > 0) return ts.join('\n') } } } return '' }
    // 当前最大 turn 号（用于 readOutput 的 minTurn 下限）
    function maxTurn(agent) { var evts = agent.session.events; var m = -1; for (var i = evts.length - 1; i >= 0; i--) { var e = evts[i]; if (e.data && typeof e.data.turn === 'number' && e.data.turn > m) m = e.data.turn } return m }
    // parseSections: 解析 ## 分段输出为结构化字段（容错：无分段时返回空对象，调用方降级）
    function parseSections(text) {
      var out = {}
      if (!text) return out
      var re = /^##\s+(.+?)\s*$/gm, m, matches = []
      while ((m = re.exec(text))) matches.push({ title: m[1], idx: m.index, end: m.index + m[0].length })
      for (var i = 0; i < matches.length; i++) {
        var body = text.slice(matches[i].end, i + 1 < matches.length ? matches[i + 1].idx : text.length).trim()
        var title = matches[i].title
        if (/开发描述/.test(title)) out.summary = body
        else if (/改动/.test(title)) out.changes = body
        else if (/自测/.test(title)) out.selfTest = body
        else if (/测试概要|验证概要|审查概要/.test(title)) out.verifySummary = body
        else if (/核对项|核验项|检查项/.test(title)) out.checks = body
      }
      return out
    }
    // 超时保护：whenIdle 卡住时超时标记 dead
    function withTimeout(promise, ms, label) { var timer = ctx.timer; if (!timer) return promise; return Promise.race([promise, timer.timeout(ms).then(function () { throw new Error(label + ' timeout ' + ms + 'ms') })]) }

    // ===== 配置 =====
    function cfg(d) { return { minWorkers: Math.max(0, Math.min(10, d.minWorkers || 1)), maxWorkers: Math.max(1, Math.min(10, d.maxWorkers || 3)), minVerifiers: Math.max(0, Math.min(5, d.minVerifiers || 0)), maxVerifiers: Math.max(0, Math.min(5, d.maxVerifiers || 2)) } }

    // ===== 状态流转 =====
    function claimCheck(d, t, sid) { if (CLAIMABLE.indexOf(t.status) < 0) return 'cannot claim in ' + t.status; if (t.claimedBy && t.claimedBy !== sid && t.status === 'in-progress') return 'claimed by ' + t.claimedBy; if (d.boardMode === 'manual' || t.assignMode === 'manual') { if (t.assignee && t.assignee !== sid) return 'assigned to ' + t.assignee }; if (isb(t)) { var p = gpt(t, d.tasks); if (!p) return 'parent not found'; if (p.status !== 'in-progress' && p.status !== 'verifying') return 'parent not in-progress' }; var mc = d.tasks.filter(function (x) { return x.claimedBy === sid && (x.status === 'in-progress' || x.status === 'verifying') && !isb(x) }); if (!isb(t) && mc.length >= MAX_CLAIMED) return 'max ' + MAX_CLAIMED + ' active'; return null }
    function claimApply(d, t, sid, note) { var ps = t.status; t.status = 'in-progress'; t.claimedBy = sid; t.claimedAt = new Date().toISOString(); ah(t, ps, 'in-progress', sid, note) }
    function checkParentAuto(d, t) { if (!isb(t)) return null; var p = gpt(t, d.tasks); if (!p || p.status !== 'in-progress') return null; var s = gsb(p.id, d.tasks); if (s.every(function (x) { return x.status === 'resolved' })) { p.status = 'verifying'; p.resolvedAt = new Date().toISOString(); p.resolution = 'all subtasks resolved'; ah(p, 'in-progress', 'verifying', 'system', 'auto: all subtasks resolved'); return p }; return null }
    function resolveApply(d, t, sid, status, resolution, note) { var ps = t.status; if (status === 'verifying' && t.pipeline && t.pipeline !== 'full') { status = 'resolved' } t.status = status; t.resolution = resolution || null; t.resolvedAt = new Date().toISOString(); ah(t, ps, status, sid, note); var r = { ok: true, task: t }; if (status === 'verifying' && isb(t)) { var s = gsb(t.parentId, d.tasks); if (s.every(function (x) { return x.status === 'resolved' || x.id === t.id })) { var p = gpt(t, d.tasks); if (p && p.status === 'in-progress') { p.status = 'verifying'; p.resolvedAt = new Date().toISOString(); p.resolution = 'all subtasks done'; ah(p, 'in-progress', 'verifying', 'system', 'auto'); r.parentUpdated = true } } }; return r }
    function verifyApply(d, t, sid, verdict, comment) { var ps = t.status; if (verdict === 'approved') { t.status = 'resolved'; t.verifiedAt = new Date().toISOString(); t.verifiedBy = sid; ah(t, ps, 'resolved', sid, 'approved' + (comment ? ': ' + comment : '')) } else { t.status = 'in-progress'; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'in-progress', sid, 'rejected' + (comment ? ': ' + comment : '')) }; var r = { ok: true, task: t }; if (verdict === 'approved' && isb(t)) { var p = checkParentAuto(d, t); if (p) { r.parentUpdated = true } }; return r }

    // ===== 生产者-消费者池（每个 agent 一个串行任务队列，消除 taskId 竞争）=====
    // 池按会话分桶：静态插件挂 host 层是进程单例，多会话共用一个 pool 会跨会话串台
    // （worker 的 parent 挂错会话 → 工具 resolveRoot 到别的看板 → "幽灵指派" not found）
    var pools = {}
    function poolFor(sid) { if (!pools[sid]) pools[sid] = { workers: {}, verifiers: {}, nextW: 1, nextV: 1 }; return pools[sid] }
    // 模型熔断：带覆盖模型的 agent 若 init turn 即死（如 UNKNOWN_MODEL——模型在当前网关没配置），
    // 记入坏名单，该会话后续 spawn 不再带此模型（回退父级），避免死亡循环
    var badModels = {}
    function modelKey(sid, model) { return sid + '|' + model }

    async function spawnAgent(sid, role, num, modelOverride) {
      var subagents = ctx.subagents; if (!subagents) return null
      var parent = rootForSession(sid); if (!parent) { console.error('[task-board] no root agent for session ' + sid + ', skip spawn'); return null }
      if (modelOverride && badModels[modelKey(sid, modelOverride)]) { console.error('[task-board] model ' + modelOverride + ' circuited for ' + sid + ', using parent model'); modelOverride = undefined }
      var providers = subagents.list(); if (!providers.length) return null
      var prompt = role === 'worker'
        ? '你是一个任务执行 Worker #' + num + '。当收到任务时，阅读任务描述并完成它。\n\n重要契约（双模，工具优先）：\n1. 完成时：优先调用 board_report 工具（kind=complete，填 summary=开发描述/changes=改动清单/selfTest=自测情况）；若工具不可用，则按分段格式文本输出（## 开发描述 / ## 改动清单 / ## 自测情况）。\n2. 歧义/信息不足/需用户决策时：优先调用 board_report（kind=escalate，填 question）；若工具不可用，输出以 [ESCALATE] 开头的说明。不要猜测。\n3. 任务消息中会给出 taskId，上报时原样携带。\n4. 等待接收任务分配。'
        : '你是一个任务审核 Verifier #' + num + '。当收到审核请求时，评估任务完成质量。\n\n契约（双模，工具优先）：\n1. 优先调用 board_verdict 工具（verdict=approved/rejected，summary=测试概要，checks=逐条核对证据含行号）。\n2. 若工具不可用：首行 APPROVED: <结论> 或 REJECTED: <结论>，然后 ## 测试概要 / ## 核对项 分段。\n3. 任务消息中会给出 taskId，上报时原样携带。\n等待接收审核请求。'
      try {
        // #17 verifier 异构化：用不同模型审查避免同源盲点；失败回退父级模型
        // prompt 必须是 ContentBlock[]（dsh-subagent 类型定义），裸字符串会让 LLM 序列化 content.map 崩溃（init turn 必挂）
        var startReq = { label: role + '-' + num, prompt: [{ type: 'text', text: prompt }], parent: parent, signal: makeSignal() }
        if (modelOverride && typeof modelOverride === 'string') startReq.agentOptions = { model: modelOverride }
        var run
        try { run = await subagents.start(providers[0], startReq) } catch (e) {
          if (!startReq.agentOptions) throw e
          console.error('[task-board] model override failed, fallback to parent model:', String(e))
          delete startReq.agentOptions
          run = await subagents.start(providers[0], startReq)
        }
        // running 初始置为 init 哨兵：init turn 未完成前 pump 不派发任务（否则 whenIdle 会提前 resolve 在 init turn 上，读到 seed 旧消息）
        var agent = { id: String(run.id), num: num, role: role, run: run, agent: run.localAgent, busy: false, taskId: null, eventBoundary: 0, dead: false, tasksCompleted: 0, queue: [], running: { init: true }, model: (modelOverride && role === 'verifier') ? modelOverride : '' }
        // 熔断钩子：init turn 失败且带模型覆盖 → 该模型进坏名单（UNKNOWN_MODEL 发生在首 turn 运行时，start() 的 try/catch 接不住）
        function markDead(e) { agent.dead = true; agent.running = null; if (agent.model && agent.tasksCompleted === 0) { badModels[modelKey(sid, agent.model)] = true; console.error('[task-board] model circuited: ' + agent.model + ' (' + String(e) + '), future spawns use parent model') } }
        run.result.then(function () { agent.eventBoundary = agent.agent.session.events.length; agent.running = null; agent.busy = false; pump(sid, agent) }).catch(markDead)
        withTimeout(run.result, 30000, 'init-' + role + '-' + num).catch(markDead)
        return agent
      } catch (e) { console.error('[task-board] spawn ' + role + ' failed:', String(e)); return null }
    }

    // enqueue: 把任务放进 agent 队列（worker: claim 已在 poolCycle 的 d 里完成；retry: 任务已是 in-progress）
    function enqueue(sid, a, item) { a.queue.push(item); pump(sid, a) }

    // pump: 串行驱动 —— 空闲且有队列则取下一个执行
    function pump(sid, a) {
      if (a.dead || a.running || a.queue.length === 0) return
      var item = a.queue.shift()
      a.running = item; a.busy = true; a.taskId = item.taskId; a.suspect = false
      a.eventBoundary = a.agent.session.events.length
      item.minTurn = maxTurn(a.agent) + 1 // 任务 turn 必然 > 当前最大 turn（followup 开新 turn），readOutput 据此排除 seed/旧 turn
      item.startedAt = Date.now()
      item.lastEventCount = a.eventBoundary
      a.agent.followup(makeMsg(item.prompt))
      var label = (a.role === 'worker' ? 'worker-' : 'verifier-') + a.num
      // 看门狗：30s 间隔检查事件流增量；运行 >300s 且停滞 >60s → suspect 报警（不杀，裁决权交给主窗口/用户）
      var tm = ctx.timer
      var watchdog = tm ? tm.interval(function () {
        if (a.dead || a.running !== item) return
        var now = Date.now()
        var cur = a.agent.session.events.length
        if (cur > item.lastEventCount) { item.lastEventCount = cur; item.lastGrowthAt = now }
        var elapsed = now - item.startedAt
        var silentFor = now - (item.lastGrowthAt || item.startedAt)
        if (!a.suspect && elapsed > 300000 && silentFor > 60000) markSuspect(sid, a, item, elapsed, silentFor)
      }, 30000) : null
      a.agent.whenIdle().then(function () {
        if (watchdog) watchdog()
        if (a.role === 'worker') onWorkerDone(sid, a, item); else onVerifierDone(sid, a, item)
      }).catch(function (e) {
        if (watchdog) watchdog()
        if (a.role === 'worker') onWorkerError(sid, a, item, e); else onVerifierError(sid, a, item, e)
      })
    }

    // suspect 报警：标记卡死，Team 模式通知主窗口，自动模式靠看板 UI
    function markSuspect(sid, a, item, elapsed, silentFor) {
      a.suspect = true
      var label = (a.role === 'worker' ? 'worker-' : 'verifier-') + a.num
      var mins = Math.floor(elapsed / 60000), silentMins = Math.floor(silentFor / 60000)
      console.error('[task-board] ' + label + ' suspect on ' + item.taskId + ': running ' + mins + 'min, silent ' + silentMins + 'min')
      mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === item.taskId })
        if (t && (t.status === 'in-progress' || t.status === 'verifying')) {
          t.stuckSince = new Date().toISOString()
          ah(t, t.status, t.status, 'system', label + ' 疑似卡死：运行 ' + mins + ' 分钟，事件流停滞 ' + silentMins + ' 分钟')
        }
        return { teamMode: !!d.teamMode, task: t }
      }).then(function (r) {
        if (r && r.teamMode) {
          var root = rootForSession(sid)
          if (root) { try { root.followup(makeMsg('⚠️ [任务看板] 池中 Agent 疑似卡死，请裁决：\n\n任务: ' + item.taskId + '\nAgent: ' + label + '\n已运行 ' + mins + ' 分钟，事件流停滞 ' + silentMins + ' 分钟\n\n可查看其会话后用 task_terminate 终止重派，或 task_intervene 指导，或忽略继续观察。')) } catch (_) {} }
        }
      }).catch(function () {})
    }

    function finishTurn(sid, a) {
      a.running = null; a.busy = false; a.taskId = null
      a.tasksCompleted++; a.eventBoundary = a.agent.session.events.length
      pump(sid, a) // 继续队列中的下一个
    }

    // 歧义上报聊天通知：仅 Team 模式推送到主窗口聊天流；自动模式靠看板面板 3s 轮询自动弹开（聊天通知是冗余噪音，且 followup 排队语义导致延迟到达）
    function notifyMainWindow(sid, t, question) {
      var root = rootForSession(sid)
      if (!root) return
      try { root.followup(makeMsg('⚠️ [任务看板] Worker 上报歧义，等待裁决：\n\n任务: ' + t.title + ' (' + t.id + ')\nWorker: ' + t.claimedBy + '\n\n疑问:\n' + question.slice(0, 1500) + '\n\n请在看板详情页裁决，或直接回复指示（我会通过 resolve-escalation 转达给 Worker）。')) } catch (e) { console.error('[task-board] escalate notify failed:', String(e)) }
    }
    // 从 mutateLocked 结果中读 teamMode，决定是否推聊天通知
    function maybeNotify(sid, task) { if (task && task.escalation) { rt(sid).then(function (d) { if (d.teamMode) notifyMainWindow(sid, task, task.escalation.question) }).catch(function () {}) } }

    // ===== 任务回执通知（v66）：池执行的任务在 完成/阻塞 时通知主窗口 =====
    // 只通知池派发执行的任务（claimedBy 是池成员），主窗口自己手动处理的任务不回执（自己干的自己知道）。
    // followup 是队列语义：主窗口忙时排队，闲时送达——正好是长程任务的期望行为。
    function isPoolMember(sid, id) { if (!id) return false; var p = poolFor(sid); return !!(p.workers[id] || p.verifiers[id]) }
    function notifyTaskDone(sid, t, kind) {
      if (!t || !isPoolMember(sid, t.claimedBy)) return
      var root = rootForSession(sid)
      if (!root) return
      var lines
      if (kind === 'resolved') {
        lines = ['✅ [任务看板] 任务已完成', '', '任务: ' + t.title + ' (' + t.id + ')']
        if (t.deliverable && t.deliverable.summary) lines.push('开发描述: ' + t.deliverable.summary.slice(0, 400))
        if (t.verification && t.verification.verdict) lines.push('验收: ' + (t.verification.verdict === 'approved' ? '通过' : '驳回') + (t.verification.summary ? ' — ' + t.verification.summary.slice(0, 200) : ''))
        lines.push('', '可在看板查看详情或归档；依赖它的任务已自动进入派发。')
      } else {
        lines = ['🛑 [任务看板] 任务被阻塞，需要关注', '', '任务: ' + t.title + ' (' + t.id + ')']
        var lastNote = (t.history && t.history.length) ? t.history[t.history.length - 1].note : ''
        if (lastNote) lines.push('原因: ' + String(lastNote).slice(0, 300))
        lines.push('', '可用 task_intervene 指导、task_terminate 终止重派，或在看板详情页处理。')
      }
      try { root.followup(makeMsg(lines.join('\n'))) } catch (e) { console.error('[task-board] done-notify failed:', String(e)) }
    }

    function onWorkerDone(sid, w, item) {
      var output = readOutput(w.agent, item.minTurn)
      var escalated = /\[ESCALATE\]/i.test(output || '')
      var secs = escalated ? {} : parseSections(output)
      mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === item.taskId })
        if (t && t.status === 'in-progress' && t.claimedBy === w.id) {
          if (t.escalation) { delete t.stuckSince; return { task: t, escalated: false } } // board_report 工具已上报并通知，跳过文本路径
          if (escalated) {
            // 歧义上报：任务保持 in-progress，标记 escalation，不进 verifying
            t.escalation = { question: output.slice(0, 2000), at: new Date().toISOString(), by: 'worker-' + w.num }
            if (!Array.isArray(t.messages)) t.messages = []
            t.messages.push({ kind: 'escalation', text: output.slice(0, 4000), at: t.escalation.at, by: 'worker-' + w.num })
            ah(t, 'in-progress', 'in-progress', w.id, 'worker-' + w.num + ' 上报歧义，待主窗口裁决')
            return { task: t, escalated: true }
          }
          delete t.escalation
          delete t.stuckSince // 正常完成清除卡死标记
          t.deliverable = { summary: secs.summary || output.slice(0, 600), changes: secs.changes || '', selfTest: secs.selfTest || '', at: new Date().toISOString(), by: 'worker-' + w.num }
          resolveApply(d, t, w.id, 'verifying', output || 'Worker 完成', 'worker-' + w.num + (item.kind === 'retry' ? ' retry' : '') + ' completed')
          return { task: t, escalated: false }
        }
        return null // 状态不符不写文件
      }).then(function (r) {
        if (r && r.escalated) maybeNotify(sid, r.task)
        if (r && r.task && r.task.status === 'resolved') notifyTaskDone(sid, r.task, 'resolved') // work/direct 档直接完成
        finishTurn(sid, w)
      }).catch(function () { finishTurn(sid, w) })
    }

    function onWorkerError(sid, w, item, err) {
      var isTimeout = /timeout/.test(String(err))
      mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === item.taskId })
        if (t && (t.status === 'in-progress' || t.status === 'blocked') && t.claimedBy === w.id) {
          if (isTimeout) {
            // 超时：清 claimedBy 回 pending 重试，retryCount>=3 才转 blocked 待人工
            t.retryCount = (t.retryCount || 0) + 1
            if (t.retryCount >= 3) { var ps = t.status; t.status = 'blocked'; ah(t, ps, 'blocked', w.id, 'worker-' + w.num + ' timeout x' + t.retryCount + '，待人工介入') }
            else { var ps2 = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps2, 'pending', w.id, 'worker-' + w.num + ' timeout，重新排队 (' + t.retryCount + '/3)') }
          } else { resolveApply(d, t, w.id, 'blocked', String(err), 'worker-' + w.num + ' error') }
          return t
        }
        return null
      }).then(function (t) { if (t && t.status === 'blocked') notifyTaskDone(sid, t, 'blocked') }).catch(function () {})
      w.running = null; w.busy = false; w.taskId = null; w.dead = true
    }

    function onVerifierDone(sid, v, item) {
      var output = readOutput(v.agent, item.minTurn)
      var trimmed = (output || '').trim()
      if (!trimmed) {
        // 空输出 = 读取失败（不是驳回）：任务保持 verifying，verifyRetries 计数，>=3 转 blocked 待人工
        console.error('[task-board] verifier-' + v.num + ' empty output on ' + item.taskId)
        mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === item.taskId })
          if (t && t.status === 'verifying') {
            t.verifyRetries = (t.verifyRetries || 0) + 1
            if (t.verifyRetries >= 3) { var ps = t.status; t.status = 'blocked'; ah(t, ps, 'blocked', 'system', 'verifier 连续 ' + t.verifyRetries + ' 次读取失败，待人工介入') }
            else { ah(t, 'verifying', 'verifying', 'system', 'verifier-' + v.num + ' 输出读取失败，重新排队审查 (' + t.verifyRetries + '/3)') }
            return t
          }
          return null
        }).then(function () { finishTurn(sid, v) }).catch(function () { finishTurn(sid, v) })
        return
      }
      // verdict 解析：行首锚定 APPROVED/REJECTED 标记（输出中提到历史驳回字眼不应误判）。null = 无法判定 → 走重试而非驳回
      var vm = trimmed.match(/^[ \t>*#\-\s]*(APPROVED|REJECTED)\b/im)
      if (!vm) {
        console.error('[task-board] verifier-' + v.num + ' unclear verdict on ' + item.taskId + ': ' + trimmed.slice(0, 120))
        mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === item.taskId })
          if (t && t.status === 'verifying') {
            t.verifyRetries = (t.verifyRetries || 0) + 1
            if (t.verifyRetries >= 3) { var ps = t.status; t.status = 'blocked'; ah(t, ps, 'blocked', 'system', 'verifier 连续 ' + t.verifyRetries + ' 次无法判定，待人工介入') }
            else { ah(t, 'verifying', 'verifying', 'system', 'verifier-' + v.num + ' 判定格式不明，重新排队审查 (' + t.verifyRetries + '/3)') }
            return t
          }
          return null
        }).then(function () { finishTurn(sid, v) }).catch(function () { finishTurn(sid, v) })
        return
      }
      var approved = vm[1].toUpperCase() === 'APPROVED'
      var vsecs = parseSections(trimmed)
      mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === item.taskId })
        if (t && t.status === 'verifying') {
          delete t.stuckSince // 审查正常产出，清除卡死标记
          t.verification = { verdict: approved ? 'approved' : 'rejected', summary: vsecs.verifySummary || trimmed.slice(0, 600), checks: vsecs.checks || '', at: new Date().toISOString(), by: 'verifier-' + v.num }
          verifyApply(d, t, 'verifier-' + v.num, approved ? 'approved' : 'rejected', trimmed.slice(0, 200))
          if (!approved) {
            // 真实驳回预算：3 次后转 blocked 待人工裁决（不再自动重试）
            t.rejectCount = (t.rejectCount || 0) + 1
            if (t.rejectCount >= 3) { t.status = 'blocked'; ah(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x' + t.rejectCount + '，待人工裁决') }
          }
          return t
        }
        return null
      }).then(function (t) {
        // 回执：approved→resolved 通知完成；blocked（驳回超预算）通知阻塞
        if (t && t.status === 'resolved') notifyTaskDone(sid, t, 'resolved')
        if (t && t.status === 'blocked') notifyTaskDone(sid, t, 'blocked')
        // 驳回且未超预算 → 修正任务入队原 worker（锁外 enqueue，避免嵌套锁）
        if (t && !approved && t.claimedBy && (t.rejectCount || 0) < 3) {
          var w = poolFor(sid).workers[t.claimedBy]
          if (w && !w.dead) { enqueue(sid, w, { taskId: t.id, kind: 'retry', prompt: '你之前提交的任务被驳回了。\n\ntaskId: ' + t.id + '\n任务: ' + t.title + '\n驳回原因: ' + trimmed.slice(0, 300) + '\n\n请修正后重新调用 board_report（kind=complete, taskId=' + t.id + '）上报；工具不可用则按分段格式输出。' }) }
        }
        finishTurn(sid, v)
      }).catch(function () { finishTurn(sid, v) })
    }

    function onVerifierError(sid, v, item, err) {
      // verifier 超时/错误：任务保持 verifying，等下一个 verifier 审查（不直接驳回）
      console.error('[task-board] verifier-' + v.num + ' error on ' + item.taskId + ':', String(err))
      v.running = null; v.busy = false; v.taskId = null; v.dead = true
    }

    async function poolCycle(sid) {
      var info = []

      // 阶段0（无锁）：清理死亡 agent
      Object.keys(poolFor(sid).workers).forEach(function (id) { if (poolFor(sid).workers[id].dead) { try { poolFor(sid).workers[id].run.dispose() } catch (_) {} delete poolFor(sid).workers[id] } })
      Object.keys(poolFor(sid).verifiers).forEach(function (id) { if (poolFor(sid).verifiers[id].dead) { try { poolFor(sid).verifiers[id].run.dispose() } catch (_) {} delete poolFor(sid).verifiers[id] } })

      // 阶段1（无锁）：快照读，决定伸缩目标；spawn 是慢操作，不能持锁
      var snap = await rt(sid)
      // #7 名册恢复（必须在 spawn 前）：插件重启后编号计数从文件续上
      if (snap.poolRoster && typeof snap.poolRoster === 'object') { poolFor(sid).nextW = Math.max(poolFor(sid).nextW, snap.poolRoster.nextW || 1); poolFor(sid).nextV = Math.max(poolFor(sid).nextV, snap.poolRoster.nextV || 1) }
      // 空闲快进：无活跃任务且池为空 → 不写盘直接返回（心跳每 15s 跑一次，不能每次都写文件）
      var hasActive = snap.tasks.some(function (t) { return t.status === 'pending' || t.status === 'verifying' || t.status === 'in-progress' })
      if (!hasActive && Object.keys(poolFor(sid).workers).length === 0 && Object.keys(poolFor(sid).verifiers).length === 0) { snap.poolStatus = { workers: [], verifiers: [] }; return snap }
      var c = cfg(snap)
      var snapPending = snap.tasks.filter(function (t) { return t.status === 'pending' && !t.claimedBy && t.assignMode !== 'manual' })
      var snapVerifying = snap.tasks.filter(function (t) { return t.status === 'verifying' })
      var isAuto = (snap.boardMode || 'auto') === 'auto'
      if (isAuto) {
        // suspect Agent 不占扩缩容名额（池自动补位，卡死的由人裁决处置）
        var activeW = Object.values(poolFor(sid).workers).filter(function (w) { return !w.suspect }).length
        var activeV = Object.values(poolFor(sid).verifiers).filter(function (v) { return !v.suspect }).length
        var targetW = Math.max(c.minWorkers, Math.min(c.maxWorkers, Math.max(Math.ceil(snapPending.length / 2), snapPending.length > 0 ? 1 : 0)))
        while (activeW < targetW) { var w = await spawnAgent(sid, 'worker', poolFor(sid).nextW++); if (!w) break; poolFor(sid).workers[w.id] = w; activeW++; info.push('spawn worker-' + w.num) }
        if (activeW > targetW && snapPending.length === 0) { var idle = Object.values(poolFor(sid).workers).filter(function (w) { return !w.busy }); var excess = activeW - targetW; for (var i = 0; i < Math.min(excess, idle.length); i++) { try { idle[i].run.dispose() } catch (_) {} delete poolFor(sid).workers[idle[i].id]; info.push('dispose worker-' + idle[i].num) } }
        var targetV = Math.max(c.minVerifiers, Math.min(c.maxVerifiers, snapVerifying.length))
        var vModel = (typeof snap.verifierModel === 'string' && snap.verifierModel.trim()) ? snap.verifierModel.trim() : ''
        while (activeV < targetV) { var v = await spawnAgent(sid, 'verifier', poolFor(sid).nextV++, vModel || undefined); if (!v) break; poolFor(sid).verifiers[v.id] = v; activeV++; info.push('spawn verifier-' + v.num + (v.model ? '(' + v.model + ')' : '')) }
        if (activeV > targetV && snapVerifying.length === 0) { var idleV = Object.values(poolFor(sid).verifiers).filter(function (v) { return !v.busy }); var excessV = activeV - targetV; for (var j = 0; j < Math.min(excessV, idleV.length); j++) { try { idleV[j].run.dispose() } catch (_) {} delete poolFor(sid).verifiers[idleV[j].id]; info.push('dispose verifier-' + idleV[j].num) } }
      }

      // 阶段2（持锁）：重新读文件，孤儿回收 + claim 分配 + 池状态，一次原子写
      var workerAssignments = []
      var verifierAssignments = []
      var result = await mutateLocked(sid, function (d) {
        var cc = cfg(d)
        if ((d.boardMode || 'auto') === 'auto') {
          // 孤儿回收：in-progress 且 claimedBy 不在当前池中、超过 2 分钟 → 回收为 pending
          var poolIds = Object.keys(poolFor(sid).workers).concat(Object.keys(poolFor(sid).verifiers))
          var nowMs = Date.now()
          d.tasks.forEach(function (t) {
            if (t.status === 'in-progress' && t.claimedBy && t.claimedBy !== sid && poolIds.indexOf(t.claimedBy) < 0) {
              var age = nowMs - new Date(t.claimedAt || 0).getTime()
              if (age > 120000) { ah(t, 'in-progress', 'pending', 'system', 'orphan recovered (worker gone)'); t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; info.push('recover orphan ' + t.id) }
            }
          })
          var prioRank = { critical: 4, high: 3, medium: 2, low: 1 }
          // #18 依赖永久阻断：依赖被取消 → 依赖方转 blocked 待人工裁决（只标一次）
          d.tasks.forEach(function (t) {
            if (t.status === 'pending' && depsCancelled(d, t)) { t.status = 'blocked'; ah(t, 'pending', 'blocked', 'system', '依赖任务已取消，永远无法满足'); info.push('dep-blocked ' + t.id) }
          })
          // #18+#19 派发门槛：依赖全满足 且 非 direct 档（direct 由主窗口直接处理，不进池）
          var pendingTasks = d.tasks.filter(function (t) { return t.status === 'pending' && !t.claimedBy && t.assignMode !== 'manual' && t.pipeline !== 'direct' && depsSatisfied(d, t) })
            .sort(function (a, b) { var p = (prioRank[b.priority] || 2) - (prioRank[a.priority] || 2); return p !== 0 ? p : (a.createdAt || '').localeCompare(b.createdAt || '') }) // #5 优先级调度
          var verifyingTasks = d.tasks.filter(function (t) { return t.status === 'verifying' && (!t.pipeline || t.pipeline === 'full') }) // #19 只有 full 档才分配 verifier
          var idleW = Object.values(poolFor(sid).workers).filter(function (w) { return !w.busy && !w.dead })
          for (var k = 0; k < Math.min(idleW.length, pendingTasks.length); k++) { var wk = idleW[k], tk = pendingTasks[k]; wk.busy = true; wk.taskId = tk.id; claimApply(d, tk, wk.id, 'pool-worker-' + wk.num); workerAssignments.push({ w: wk, t: tk }); info.push('assign ' + tk.id + ' → worker-' + wk.num) }
          var idleV2 = Object.values(poolFor(sid).verifiers).filter(function (v) { return !v.busy && !v.dead })
          for (var l = 0; l < Math.min(idleV2.length, verifyingTasks.length); l++) { var vf = idleV2[l], tv = verifyingTasks[l]; vf.busy = true; vf.taskId = tv.id; verifierAssignments.push({ v: vf, t: tv }); info.push('verify ' + tv.id + ' → verifier-' + vf.num) }
        }
        d.poolStatus = { workers: Object.values(poolFor(sid).workers).map(function (w) { return { id: w.id, num: w.num, busy: w.busy, taskId: w.taskId, done: w.tasksCompleted, queueLen: w.queue.length, suspect: !!w.suspect } }), verifiers: Object.values(poolFor(sid).verifiers).map(function (v) { return { id: v.id, num: v.num, busy: v.busy, taskId: v.taskId, done: v.tasksCompleted, queueLen: v.queue.length, suspect: !!v.suspect, model: v.model || '' } }) }
        // #7 池名册持久化：成员 done 累计随文件落盘（计数恢复已在阶段1完成）
        var roster = d.poolRoster && typeof d.poolRoster === 'object' ? d.poolRoster : { nextW: 1, nextV: 1, members: [] }
        var memberMap = {}
        ;(roster.members || []).forEach(function (m) { memberMap[m.role + '-' + m.num] = m })
        d.poolStatus.workers.forEach(function (w) { var k = 'worker-' + w.num; var prev = memberMap[k]; memberMap[k] = { role: 'worker', num: w.num, done: Math.max(w.done, prev ? prev.done || 0 : 0), lastId: w.id, lastSeen: new Date().toISOString() } })
        d.poolStatus.verifiers.forEach(function (v) { var k = 'verifier-' + v.num; var prev = memberMap[k]; memberMap[k] = { role: 'verifier', num: v.num, done: Math.max(v.done, prev ? prev.done || 0 : 0), lastId: v.id, lastSeen: new Date().toISOString() } })
        d.poolRoster = { nextW: poolFor(sid).nextW, nextV: poolFor(sid).nextV, members: Object.values(memberMap) }
        d.minWorkers = cc.minWorkers; d.maxWorkers = cc.maxWorkers; d.minVerifiers = cc.minVerifiers; d.maxVerifiers = cc.maxVerifiers
        if (typeof d.verifierModel !== 'string') d.verifierModel = '' // v69 起默认空=继承父级模型（环境无关，异构审查需在 ⚙️ 里显式配置本网关可用的模型）
        if (info.length > 0) d.dispatchInfo = info.join('; ')
        return d // 始终写（池状态刷新）
      })

      // 阶段3（锁外）：入队驱动
      workerAssignments.forEach(function (a) { enqueue(sid, a.w, { taskId: a.t.id, kind: 'work', prompt: '请完成以下任务：\n\ntaskId: ' + a.t.id + '\n任务: ' + a.t.title + '\n描述: ' + (a.t.description || '') + '\n指引: ' + (a.t.context && a.t.context.instructions || '') + (a.t.acceptance ? '\n硬性验收脚本: ' + a.t.acceptance + '\n（必须实际运行该命令并在自测情况中粘贴真实输出；未通过不得上报完成）' : '') + '\n\n完成后调用 board_report（kind=complete, taskId=' + a.t.id + '）上报；工具不可用则按分段格式输出（## 开发描述 / ## 改动清单 / ## 自测情况）。' }) })
      // verify prompt 携带 上报/裁决/驳回 历史，让 verifier 感知歧义已被主窗口处理（否则会把"按裁决产出"误判为"绕过任务"）
      verifierAssignments.forEach(function (a) {
        var histNotes = (a.t.history || []).filter(function (h) { return h.note && (/歧义|裁决|驳回|干预|rejected/i.test(h.note)) }).map(function (h) { return '- [' + h.timestamp + '] ' + h.note.slice(0, 300) }).join('\n')
        enqueue(sid, a.v, { taskId: a.t.id, kind: 'verify', prompt: '请审查以下任务完成质量：\n\ntaskId: ' + a.t.id + '\n任务: ' + a.t.title + '\n描述: ' + (a.t.description || '').slice(0, 500) + '\n完成说明: ' + (a.t.resolution || '(无)') + (a.t.acceptance ? '\n硬性验收脚本: ' + a.t.acceptance + '\n（必须独立复跑该命令并把真实输出贴进核对项；脚本失败必须 REJECTED）' : '') + (histNotes ? '\n\n该任务的过程记录（歧义上报/主窗口裁决/驳回/干预，若有）：\n' + histNotes + '\n\n注意：若过程记录显示主窗口已裁决改变任务方向，请以裁决后的方向为验收标准。' : '') + '\n\n完成后调用 board_verdict（taskId=' + a.t.id + '）提交结论；工具不可用则首行 APPROVED:/REJECTED: + ## 测试概要 / ## 核对项 分段输出。' })
      })
      return result
    }

    // 插件停止时清理池
    ctx.effect(function () { return function () { Object.keys(pools).forEach(function (psid) { var pp = pools[psid]; Object.values(pp.workers).forEach(function (w) { try { w.run.dispose() } catch (_) {} }); Object.values(pp.verifiers).forEach(function (v) { try { v.run.dispose() } catch (_) {} }) }); pools = {} } })
    // Host 侧调度心跳：每 15s 对所有已知会话跑 poolCycle（客户端轮询只是触发器之一，面板关闭/后台节流时池照常运转）
    ;(function () { var tm = ctx.timer; if (!tm) return; var disposeTick = tm.interval(function () { Object.keys(knownSessions).forEach(function (sid) { poolCycle(sid).catch(function () {}) }) }, 15000); ctx.effect(function () { return disposeTick }) })()

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
          var sid = resolveRoot(String(agent.id || ''))
          if (!teamModeCache[sid]) return ''
          return '【任务看板 Team 模式已开启】\n本会话的任务看板处于 Team 模式。请遵循以下工作方式：\n1. 涉及代码改动、文件创建、命令执行等实质性工作时，优先用 task_create 提交为看板任务（由常驻 Worker/Verifier 池执行与验收），不要自己直接动手实现。\n2. 你仍保有全部工具能力——调研、读代码、讨论方案、回答问题时直接进行，无需提交任务。\n3. Worker 上报歧义时会通过 task_arbitrate 等待你裁决，请及时响应。\n4. 任务尽量一次写清 description/dependsOn/acceptance；需要分步建设的用 task_create draft:true 先建草稿，补全后 publish。'
        },
      })
      ctx.effect(function () { return disposeSection })
    }

    // ===== Tools =====
    ctx.tools.register(defineTool({ name: 'task_list', description: '列出当前会话任务。', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in-progress', 'verifying', 'resolved', 'blocked', 'cancelled'] }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, tag: { type: 'string' }, parentId: { type: 'string' }, includeArchived: { type: 'boolean' }, limit: { type: 'number' } }, required: [] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var d = await rt(sid); var a = d.tasks; var ts = a; if (!args.includeArchived) ts = ts.filter(function (x) { return x.status !== 'archived' }); if (args.status) ts = ts.filter(function (x) { return x.status === args.status }); if (args.priority) ts = ts.filter(function (x) { return x.priority === args.priority }); if (args.tag) ts = ts.filter(function (x) { return (x.tags || []).indexOf(args.tag) >= 0 }); if (args.parentId === 'null') ts = ts.filter(function (x) { return !isb(x) }); else if (args.parentId) ts = ts.filter(function (x) { return x.parentId === args.parentId }); var po = { critical: 4, high: 3, medium: 2, low: 1 }; ts.sort(function (a, b) { var dd = (po[b.priority] || 0) - (po[a.priority] || 0); return dd !== 0 ? dd : (a.createdAt || '').localeCompare(b.createdAt || '') }); var lim = Math.min(args.limit || 20, 100); var res = ts.slice(0, lim).map(function (x) { var e = Object.assign({}, x); if (isb(x)) { var p = gpt(x, a); if (p) e.parentSummary = { id: p.id, title: p.title, status: p.status } }; var ch = gsb(x.id, a); if (ch.length) { e.subtaskCount = ch.length; e.subtaskResolved = ch.filter(function (y) { return y.status === 'resolved' }).length }; return e }); var out = { tasks: res, total: ts.length, session: sid, actor: getActorId(), boardMode: d.boardMode || 'auto', teamMode: !!d.teamMode, poolStatus: d.poolStatus }; if (d.teamMode) out.teamHint = 'Team 模式已开启：实质性改动请优先 task_create 提交看板由池执行；调研/读取/讨论可直接进行；Worker 歧义会上报等你裁决。'; return out } }))
    ctx.tools.register(defineTool({ name: 'task_context', description: '获取任务完整上下文。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, expandFiles: { type: 'boolean' }, includeParent: { type: 'boolean' }, includeSubtasks: { type: 'boolean' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var d = await rt(sid); var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found: ' + args.taskId }; return { ok: true, context: { task: t, inheritedContext: t.context || {} } } } }))
    ctx.tools.register(defineTool({ name: 'task_claim', description: '领取待办任务→in-progress。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var err = claimCheck(d, t, actor); if (err) return { ok: false, error: err }; claimApply(d, t, actor, args.reason || 'claimed'); return { ok: true, task: t, context: { task: t, inheritedContext: t.context || {} } } }) } }))
    ctx.tools.register(defineTool({ name: 'task_resolve', description: '提交验证(verifying)或阻塞(blocked)。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string', enum: ['verifying', 'blocked'] }, resolution: { type: 'string' } }, required: ['taskId', 'status'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress' }; if (t.claimedBy !== actor) return { ok: false, error: 'not claimed by you' }; if (args.status === 'verifying' && !args.resolution) return { ok: false, error: 'resolution required' }; return resolveApply(d, t, actor, args.status, args.resolution, args.resolution || args.status) }) } }))
    ctx.tools.register(defineTool({ name: 'task_verify', description: '验收：approved→resolved，rejected→in-progress。子任务全完成父任务自动verifying。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'rejected'] }, comment: { type: 'string' } }, required: ['taskId', 'verdict'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'verifying') return { ok: false, error: 'not verifying' }; return verifyApply(d, t, actor, args.verdict, args.comment) }) } }))
    ctx.tools.register(defineTool({ name: 'task_archive', description: '归档已解决/已取消任务。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var a = d.tasks; var t = a.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'resolved' && t.status !== 'cancelled') return { ok: false, error: 'only resolved/cancelled' }; var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'archived'); var ca = 0; gsb(t.id, a).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } }); var r = { ok: true, task: t }; if (ca) r.childrenArchived = ca; return r }) } }))
    ctx.tools.register(defineTool({ name: 'task_update', description: '更新任务字段，可选重置为 pending。dependsOn/pipeline 也可更新（环检测会拒绝成环依赖）。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, assignMode: { type: 'string', enum: ['auto', 'manual'] }, assignee: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, pipeline: { type: 'string', enum: ['full', 'work', 'direct'] }, resetToPending: { type: 'boolean' }, publish: { type: 'boolean', description: '发布草稿为 pending（仅 draft 状态有效）' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (args.title !== undefined) t.title = args.title; if (args.description !== undefined) t.description = args.description; if (args.priority !== undefined) t.priority = args.priority; if (args.assignMode !== undefined) t.assignMode = args.assignMode; if (args.assignee !== undefined) t.assignee = args.assignee || null; if (args.dependsOn !== undefined) { var derr = validateDeps(d, t.id, args.dependsOn); if (derr) return { ok: false, error: derr }; t.dependsOn = args.dependsOn } if (args.pipeline !== undefined) { t.pipeline = args.pipeline; t.pipelineAuto = false } if (args.publish) { if (t.status !== 'draft') return { ok: false, error: 'not a draft' }; t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'published') } if (args.resetToPending) { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'pending', actor, 'reset to pending after edit') }; return { ok: true, task: t } }) } }))
    ctx.tools.register(defineTool({ name: 'task_create', description: '创建新任务到当前会话看板。acceptance 可选：硬性验收脚本命令（如 "node --test src/x.test.js"），Worker 必须实际运行、Verifier 必须独立复跑。dependsOn 可选：依赖任务 id 数组，依赖全部完成后才会被派发。pipeline 可选：full(默认,工作+验证)/work(只做不验)/direct(不进池，主窗口直接处理)。', parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, tags: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' }, instructions: { type: 'string' }, acceptance: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, pipeline: { type: 'string', enum: ['full', 'work', 'direct'] }, draft: { type: 'boolean', description: 'true 创建为草稿（不派发不可领取），补全信息后用 task_update publish=true 发布' } }, required: ['title'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { if (args.id && d.tasks.find(function (x) { return x.id === args.id })) return { ok: false, error: 'duplicate id: ' + args.id }; if (args.dependsOn && args.dependsOn.length) { var derr = validateDeps(d, args.id || '(pending)', args.dependsOn); if (derr) return { ok: false, error: derr } }; var now = new Date().toISOString(); var t = { id: args.id || ('task-' + Date.now().toString(36)), title: args.title, description: args.description || '', status: args.draft ? 'draft' : 'pending', priority: args.priority || 'medium', tags: args.tags || [], parentId: args.parentId || null, subtaskStrategy: null, assignMode: 'auto', assignee: null, context: { files: [], docs: [], instructions: args.instructions || '', relatedTasks: [], prerequisites: '' }, acceptance: args.acceptance || '', dependsOn: args.dependsOn || [], pipeline: args.pipeline || '', claimedBy: null, claimedAt: null, createdAt: now, resolvedAt: null, verifiedAt: null, verifiedBy: null, archivedAt: null, resolution: null, messages: [], history: [{ from: 'created', to: args.draft ? 'draft' : 'pending', timestamp: now, actor: actor, note: args.draft ? 'created as draft' : 'created' }] }; if (!t.pipeline) t.pipeline = classifyPipeline(t); t.pipelineAuto = !args.pipeline; d.tasks.push(t); return { ok: true, task: t } }) } }))

    // ===== RPC =====
    handle('get-tasks', async function (args) { var sid = rpcSessionId(args); var d = await poolCycle(sid); d.sessionId = sid; var __ag = ctx.agents; d.isRoot = true; if (__ag) { var __roots = __ag.roots(); var __rids = []; for (var __i = 0; __i < __roots.length; __i++) __rids.push(String(__roots[__i].id)); d.isRoot = __rids.indexOf(sid) >= 0 } return d })
    handle('claim-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var err = claimCheck(d, t, actor); if (err) return { ok: false, error: err }; claimApply(d, t, actor, 'manual claim via board'); return { ok: true, task: t } }) })
    handle('resolve-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress' }; return resolveApply(d, t, actor, args.status, args.resolution, args.resolution || args.status) }) })
    handle('verify-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'verifying') return { ok: false, error: 'not verifying' }; return verifyApply(d, t, actor, args.verdict, args.comment) }) })
    handle('archive-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var a = d.tasks; var t = a.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'resolved' && t.status !== 'cancelled') return { ok: false, error: 'cannot archive' }; var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'manual archive'); var ca = 0; gsb(t.id, a).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } }); var r = { ok: true, task: t }; if (ca) r.childrenArchived = ca; return r }) })
    handle('update-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (args.title !== undefined) t.title = args.title; if (args.description !== undefined) t.description = args.description; if (args.priority !== undefined) t.priority = args.priority; if (args.assignMode !== undefined) t.assignMode = args.assignMode; if (args.assignee !== undefined) t.assignee = args.assignee || null; if (args.dependsOn !== undefined) { var derr = validateDeps(d, t.id, args.dependsOn); if (derr) return { ok: false, error: derr }; t.dependsOn = args.dependsOn } if (args.pipeline !== undefined) { t.pipeline = args.pipeline; t.pipelineAuto = false } if (args.publish) { if (t.status !== 'draft') return { ok: false, error: 'not a draft' }; t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'published') } if (args.resetToPending) { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'pending', actor, 'reset to pending after edit') }; return { ok: true, task: t } }) })
    handle('set-board-mode', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { d.boardMode = args.mode === 'manual' ? 'manual' : 'auto'; return { ok: true, boardMode: d.boardMode } }) })
    handle('set-team-mode', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { d.teamMode = !!args.enabled; return { ok: true, teamMode: d.teamMode } }) })
    // 裁决回流：用户/主 Agent 裁决后，答案入队原 Worker（同一 Worker 保有上下文）
    async function doResolveEscalation(sid, actor, taskId, answer) {
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (!t.escalation) return { ok: false, error: 'not escalated' }
        delete t.escalation
        if (!Array.isArray(t.messages)) t.messages = []
        t.messages.push({ kind: 'arbitration', text: answer || '', at: new Date().toISOString(), by: actor })
        ah(t, 'in-progress', 'in-progress', actor, '主窗口裁决: ' + (answer || '').slice(0, 200))
        return { ok: true, task: t, answer: answer || '' }
      })
      if (result && result.ok) {
        var w = result.task.claimedBy && poolFor(sid).workers[result.task.claimedBy]
        if (w && !w.dead) {
          enqueue(sid, w, { taskId: result.task.id, kind: 'arbitrated', prompt: '你在任务 "' + result.task.title + '" (taskId: ' + result.task.id + ') 中上报了疑问，主窗口已裁决：\n\n' + result.answer + '\n\n请按裁决继续完成，然后调用 board_report（kind=complete, taskId=' + result.task.id + '）上报；工具不可用则按分段格式输出。' })
        } else {
          // 原 worker 不在：回 pending 让池重新分配（裁决内容已入 history）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === taskId }); if (t && t.status === 'in-progress') { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps, 'pending', 'system', '原 worker 已释放，带裁决重新排队') }; return t })
        }
      }
      return result
    }
    // 高优介入：消息 unshift 到目标 Agent 队首，当前 turn 结束后优先处理
    async function doIntervene(sid, actor, taskId, msg) {
      if (!(msg || '').trim()) return { ok: false, error: 'message required' }
      var target = null
      Object.values(poolFor(sid).workers).forEach(function (w) { if (w.taskId === taskId && !w.dead) target = w })
      if (!target) Object.values(poolFor(sid).verifiers).forEach(function (v) { if (v.taskId === taskId && !v.dead) target = v })
      if (!target) {
        var d = await rt(sid)
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (t && t.claimedBy && poolFor(sid).workers[t.claimedBy] && !poolFor(sid).workers[t.claimedBy].dead) target = poolFor(sid).workers[t.claimedBy]
      }
      if (!target) return { ok: false, error: 'no live agent for task' }
      target.queue.unshift({ taskId: taskId, kind: 'intervene', prompt: '[高优先级干预] 来自主窗口/用户的指令：\n\n' + msg + '\n\n请优先响应此指令，然后继续当前任务。' })
      pump(sid, target)
      await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === taskId }); if (t) { if (!Array.isArray(t.messages)) t.messages = []; t.messages.push({ kind: 'intervention', text: msg, at: new Date().toISOString(), by: actor }); ah(t, t.status, t.status, actor, '高优介入: ' + msg.slice(0, 200)) }; return t })
      return { ok: true, agent: target.id, queued: true }
    }
    // 终止执行某任务的池中 Agent：dispose 并回 pending（verifying 则保持待审，由新 verifier 接手）
    async function doTerminate(sid, actor, taskId) {
      var target = null, role = null
      Object.values(poolFor(sid).workers).forEach(function (w) { if (w.taskId === taskId && !w.dead) { target = w; role = 'worker' } })
      if (!target) Object.values(poolFor(sid).verifiers).forEach(function (v) { if (v.taskId === taskId && !v.dead) { target = v; role = 'verifier' } })
      if (!target) {
        var d = await rt(sid)
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (t && t.claimedBy && poolFor(sid).workers[t.claimedBy] && !poolFor(sid).workers[t.claimedBy].dead) { target = poolFor(sid).workers[t.claimedBy]; role = 'worker' }
      }
      if (!target) return { ok: false, error: 'no live agent for task' }
      target.dead = true
      try { target.run.dispose() } catch (_) {}
      var label = role + '-' + target.num
      await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return null
        delete t.stuckSince
        if (t.status === 'in-progress') { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps, 'pending', actor, '手动终止 ' + label + '，任务重新排队') }
        else if (t.status === 'verifying') { ah(t, 'verifying', 'verifying', actor, '手动终止 ' + label + '，等待新 verifier 接手') }
        return t
      })
      return { ok: true, terminated: label }
    }
    // 继续等待：清除卡死标记，重置该 agent 的计时
    async function doDismiss(sid, actor, taskId) {
      var target = null
      Object.values(poolFor(sid).workers).forEach(function (w) { if (w.taskId === taskId && !w.dead) target = w })
      if (!target) Object.values(poolFor(sid).verifiers).forEach(function (v) { if (v.taskId === taskId && !v.dead) target = v })
      if (target) { target.suspect = false; if (target.running) { target.running.startedAt = Date.now(); target.running.lastGrowthAt = Date.now() } }
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
        t.verification = { verdict: args.verdict, summary: args.summary || '', checks: args.checks || '', at: new Date().toISOString(), by: actor }
        verifyApply(d, t, actor, args.verdict, (args.summary || '').slice(0, 200))
        if (!approved) { t.rejectCount = (t.rejectCount || 0) + 1; if (t.rejectCount >= 3) { t.status = 'blocked'; ah(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x' + t.rejectCount + '，待人工裁决') } }
        return { ok: true, task: t }
      })
      if (result && result.ok && result.task) {
        if (result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
        if (result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      }
      if (result && result.ok && !approved) {
        var t = result.task
        if (t.claimedBy && (t.rejectCount || 0) < 3) { var w = poolFor(sid).workers[t.claimedBy]; if (w && !w.dead) { enqueue(sid, w, { taskId: t.id, kind: 'retry', prompt: '你之前提交的任务被驳回了。\n\n任务: ' + t.title + '\n驳回原因: ' + ((args.summary || '') + ' ' + (args.checks || '')).slice(0, 300) + '\n\n请修正后重新调用 board_report 上报。' }) } }
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
    handle('set-board-config', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { if (args.key === 'minWorkers') d.minWorkers = Math.max(0, Math.min(10, args.value || 0)); else if (args.key === 'maxWorkers') d.maxWorkers = Math.max(1, Math.min(10, args.value || 3)); else if (args.key === 'minVerifiers') d.minVerifiers = Math.max(0, Math.min(5, args.value || 0)); else if (args.key === 'maxVerifiers') d.maxVerifiers = Math.max(0, Math.min(5, args.value || 0)); else if (args.key === 'verifierModel') d.verifierModel = typeof args.value === 'string' ? args.value.trim() : ''; return { ok: true } }) })
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

    console.log('[task-board] v70 loaded (verifier model dropdown via llm.listProviders/listModels)')
}
