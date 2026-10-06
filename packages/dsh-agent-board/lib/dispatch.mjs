// dsh-agent-board — 派发引擎（lib/dispatch.mjs）
// createDispatch(ctx, state, deps)：一次性子代理 spawn/结算（软+硬两级超时）/ run 历史留档 /
// token 消耗累加 / poolCycle 派发周期（孤儿回收+占位 claim+池快照）/ 15s 心跳 / 插件卸载清理 /
// Team 模式 systemPrompt 引导段 / 预研上下文瘦身清单（调研笔记全文 + 文件清单，随首条 prompt 一次性注入）。
import * as core from './core.mjs'
import { readRunUsage, findRunLog, readLogBytes, readLogFrames } from './usage.mjs'
import { splitRuleOf, pushRejectLesson } from './policy.mjs'
const { ah, cfg, claimApply, resolveApply, verifyApply, parseSections, outputText, pickDispatch, isOrphan, buildWorkerPrompt, buildVerifierPrompt, buildContextPackSection, parseContextFileEntry, parentKickOnDispatch, LESSON_RECALL_HINT, buildHookPrompt, applyHookSettle, hookOn, hookSetState, gsb, pushRejection } = core

export function createDispatch(ctx, state, deps) {
    // 宿主 fs 句柄与「会话工作区解析根」随预研注入瘦身退役（task-muvjs392）：派发侧不再读盘——
    // 清单只给「路径:L行号 — 一句用途」，文件内容由 Worker 自己用 read 工具按行号范围自取。
    var rt = deps.rt, wt = deps.wt, mutateLocked = deps.mutateLocked, kickCycle = deps.kickCycle
    var rootForSession = deps.rootForSession, withTimeout = deps.withTimeout, runsFor = deps.runsFor, feedbackOn = deps.feedbackOn
    // 史诗拆分总开关读取器（epicSplit，缺省 true）：与 feedbackOn 同源（session 缓存，rt() 同步）——
    // Team 提示词组装是同步函数，只能读缓存，不能读盘。
    var epicSplitOn = deps.epicSplitOn
    var pushSysNote = deps.pushSysNote, maybeNotify = deps.maybeNotify, notifyTaskDone = deps.notifyTaskDone
    // 派发即回执：spawn 成功后入 45s 聚合队列的「🚀 已派发」区（老 host 未注入 → 静默跳过）
    var notifyDispatched = deps.notifyDispatched
    // 共享状态别名（本体由 index.mjs apply 统一构建并逐模块注入）
    var dispatchedEver = state.dispatchedEver
    var badModels = state.badModels
    // 「上下文注入」区块通道的按子代理会话缓存表 + 首轮竞速认领队列随该通道一起退役（task-muvjs392）：
    // 瘦身清单直接进首条 prompt，不再需要注入段命中与父子归属认领（并行 spawn 认领错包的潜伏 bug 一并消灭）。
    var knownSessions = state.knownSessions
    var teamModeCache = state.teamModeCache

    function makeSignal() { try { return new AbortController().signal } catch (_) { return { aborted: false, addEventListener: function () {}, removeEventListener: function () {} } } }

    // ===== 状态流转（已抽取到 lib/core.mjs）=====
    // ===== 一次性派发引擎（v74 去池化重写）=====
    // 每个任务 spawn 一个独立一次性子代理：上下文由看板通过 prompt 全量注入（任务描述/指引/验收脚本/过程记录），
    // 优先选择不继承父会话历史的 provider（inheritsParentContext === false），工作结束 run.result 结算后即 dispose 销毁。
    // 无常驻池、无队列、无名册——彻底消除幽灵指派/身份错乱/spawn 死亡循环整族问题。
    // activeRuns / dispatchedEver 容器本体在 state（index.mjs 统一构建）；runsFor/isDispatched 在 session 层

    // 模型熔断：带覆盖模型的 run 若立即失败（如 UNKNOWN_MODEL——模型在当前网关没配置），记入坏名单回退父级
    function modelKey(sid, model) { return sid + '|' + model }

    var _cachedProvider = null
    function pickProvider() {
      if (_cachedProvider) return _cachedProvider
      var subagents = ctx.subagents; if (!subagents) return null
      var names = subagents.list(); if (!names.length) return null
      for (var i = 0; i < names.length; i++) { try { var p = subagents.getProvider(names[i]); if (p && p.inheritsParentContext === false) { _cachedProvider = names[i]; return _cachedProvider } } catch (_) {} }
      _cachedProvider = names[0]; return _cachedProvider
    }

    // 主窗口预研上下文（瘦身分离形态，task-muvjs392）：只组装**瘦身清单**——调研笔记全文（≤8000 字符）
    // + 文件清单（每行「路径:L行号 — 一句用途」，用途取自 contextFiles 条目的可选注释位）。
    // 文件内容本体不进 prompt、host 也不再读盘（IO 清零）：由 Worker 用 read 工具按行号范围自取——执行时
    // 盘面更新鲜，且免了大文件正文（旧形态单文件 8KB/总包 40KB 截断注入）既撑 prompt 又随快照每轮重发
    // （实证 6×48.8K 字符≈白烧 75–100K token；整包塞 prompt 同样有害，故取「分离 + 按需自取」）。
    function readContextPack(t) {
      var paths = (t && t.context && Array.isArray(t.context.files)) ? t.context.files : []
      var notes = (t && t.context && typeof t.context.notes === 'string') ? t.context.notes : ''
      if (!paths.length && !notes.trim()) return ''
      var files = []
      for (var i = 0; i < paths.length; i++) {
        // 锚点行段语法 'path:L2350-L2420' / 'path:L2350' 与可选「 — 一句用途」由 core 纯函数归一，
        // 清单里原样带上行号供 Worker 直接 read(file, offset, limit) 自取。
        var e = parseContextFileEntry(paths[i])
        if (e.path) files.push(e)
      }
      return buildContextPackSection(files, notes.slice(0, 8000))
    }

    // 历史会话留档：t.runs = [{ role, id, at, model, outcome, endedAt }]，上限 20 条
    // 目的：任务流转到 resolved/archived 后，详情页仍能选择跳转到任一历史阶段的会话
    // （Worker 首次/重试、Verifier 各次），而不是只剩最后一次 run id。
    async function recordRunHistory(sid, taskId, role, runId, model, hardMin) {
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t) return null // 找不到任务：返回 null 不写盘
          if (!Array.isArray(t.runs)) t.runs = []
          t.runs.push({ role: role, id: runId, at: new Date().toISOString(), model: model || '', outcome: 'running', hardMin: hardMin || 120 })
          if (t.runs.length > 20) t.runs = t.runs.slice(-20)
          return { ok: true } // mutateLocked 契约：回调返回 null/undefined 则跳过写盘——必须显式返回非空值，否则 runs 永不落盘
        })
      } catch (e) { console.error('[task-board] recordRunHistory failed:', String(e)) }
    }
    async function closeRunHistory(sid, taskId, runId, outcome) {
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t || !Array.isArray(t.runs)) return null // 找不到任务/无 runs：返回 null 不写盘
          for (var i = t.runs.length - 1; i >= 0; i--) {
            if (t.runs[i].id === runId) { t.runs[i].outcome = outcome; t.runs[i].endedAt = new Date().toISOString(); break }
          }
          return { ok: true } // 同上：显式返回非空值触发写盘
        })
      } catch (e) { console.error('[task-board] closeRunHistory failed:', String(e)) }
    }

    async function spawnOneShot(sid, t, role) {
      var subagents = ctx.subagents; if (!subagents) return null
      // 兜底保留（真异常时有用）：poolCycle 入口已有 root 存活早闸门，正常派发路径不会到达这里；
      // 只有闸门外的直接调用（如 dispatch-task RPC 指定了无 root 的 sid）才会触发此报错。
      var parent = rootForSession(sid); if (!parent) { console.error('[task-board] no root agent for session ' + sid + ', skip spawn'); return null }
      var providerName = pickProvider(); if (!providerName) { console.error('[task-board] no subagent provider'); return null }
      var modelOverride = ''
      var dsnap = await rt(sid)
      if (role === 'verifier') { modelOverride = (typeof dsnap.verifierModel === 'string' && dsnap.verifierModel.trim()) ? dsnap.verifierModel.trim() : ''; if (modelOverride && badModels[modelKey(sid, modelOverride)]) { console.error('[task-board] model ' + modelOverride + ' circuited, using parent model'); modelOverride = '' } }
      else if (role === 'worker') { modelOverride = (typeof dsnap.workerModel === 'string' && dsnap.workerModel.trim()) ? dsnap.workerModel.trim() : ''; if (modelOverride && badModels[modelKey(sid, modelOverride)]) { console.error('[task-board] model ' + modelOverride + ' circuited, using parent model'); modelOverride = '' } }
      var pack = ''
      try { pack = readContextPack(t) } catch (e) {
        console.error('[task-board] context pack read failed:', String(e))
        // 调研门禁④：组装清单失败落卡（t.lastError，复用详情页「最近失败」行展示机制），不再只沉在
        // host 控制台——主窗口排查「Worker 为什么没拿到预研材料」不用翻日志。
        // mutateLocked 契约：回调返回 null/undefined 跳过写盘——找到任务才返回非空值；skipKick 免一次无谓 poolCycle。
        try { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === t.id }); if (!t2) return null; t2.lastError = ('contextPack 读取失败: ' + String(e)).slice(0, 300); return t2 }, true) } catch (_) {}
      }
      // prompt 三态：worker / verifier / hook（hooks=agent run：pre 与 post 共用 buildHookPrompt，
      // 由 phase 决定契约文案——二者都是挂在 epic 上的一次性真实 agent 运行）。
      // pack = 瘦身清单本体（调研笔记全文 + 文件清单），由 buildWorkerPrompt/buildVerifierPrompt 直接拼进
      // 首条 prompt 一次性注入——不再是「一行指引 + 随快照每轮重发的上下文注入区块」。
      // hook 分支现读一次看板只为拿子任务清单；读失败退化为空清单（prompt 仍成立，绝不因此不 spawn）。
      var promptText
      if (role === 'hook-pre' || role === 'hook-post') {
        var kids = []
        try { var hsnap = await rt(sid); kids = gsb(t.id, (hsnap && hsnap.tasks) || []) } catch (_) {}
        promptText = buildHookPrompt(t, role === 'hook-pre' ? 'pre' : 'post', kids)
      } else promptText = role === 'worker' ? buildWorkerPrompt(t, pack, cfg(dsnap).feedbackEnabled) : buildVerifierPrompt(t, pack)
      var req = { label: role + ':' + t.id, prompt: [{ type: 'text', text: promptText }], parent: parent, signal: makeSignal() }
      if (modelOverride) {
        // list-models 返回的 id 是 "provider/model" 复合格式（如 "cmss/zhanlu/glm-5.2"），
        // 但 AgentOptions 的 provider 和 model 是分开的——整串塞进 model 会报 UNKNOWN_MODEL
        var slash = modelOverride.indexOf('/')
        if (slash > 0) req.agentOptions = { provider: modelOverride.slice(0, slash), model: modelOverride.slice(slash + 1) }
        else req.agentOptions = { model: modelOverride }
      }
      // ===== spawn 两条路径（task-muw5gnhv 卡1：可续跑 Worker + 回退开关）=====
      // 开关开（缺省）→ Worker 走 continuable：subagents.startContinuable 建**持久子会话**
      //   （返回 {childId, messageId}，无 run.result 承诺），turn 结算改由 host 事件
      //   agent/status 的 running→idle 触发 settleWorker（卡2 才在此基础上做续跑/超时 interrupt）。
      // 开关关 / verifier / hook run → 逐字回退旧的 subagents.start()（一次性 run，run.result 结算）。
      // 模型覆盖的回退语义两条路径共用：带 agentOptions 首次失败 → 去掉覆盖用父级模型再试一次
      //   （provider 的 prepareContinuable/start 都在第一步就校验模型，失败时都不会留下半建子会话）。
      var c = cfg(dsnap)
      var useContinuable = role === 'worker' && c.workerContinuable !== false
      var run
      var childId = ''
      try {
        if (useContinuable) {
          var cs = await subagents.startContinuable({ provider: providerName, label: req.label, request: req, signal: req.signal })
          childId = String(cs && cs.childId || '')
          if (!childId) throw new Error('startContinuable 未返回 childId')
        } else {
          run = await subagents.start(providerName, req)
        }
      } catch (e) {
        if (modelOverride) {
          console.error('[task-board] model override failed, fallback to parent model:', String(e))
          delete req.agentOptions
          try {
            if (useContinuable) {
              var cs2 = await subagents.startContinuable({ provider: providerName, label: req.label, request: req, signal: req.signal })
              childId = String(cs2 && cs2.childId || '')
              if (!childId) throw new Error('startContinuable 未返回 childId')
            } else run = await subagents.start(providerName, req)
          } catch (e2) { console.error('[task-board] spawn ' + role + ' failed:', String(e2)); return null }
        } else { console.error('[task-board] spawn ' + role + ' failed:', String(e)); return null }
      }
      // rec 统一形态：id = 该次 run 的子会话 id（continuable 是 childId，一次性是 run.id——
      // 会话 id 语义不变，t.runs[].id / claimedBy / verifierRun / poolStatus.runId / 详情页跳转全部照旧）。
      // rec.run 只在一次性路径存在（dispose/result 的来源）；continuable 路径 rec.continuable=true，
      // 用 rec.childId 定位 host 事件、dispose 走 drain（卡1 先不 interrupt，见 settleContinuable）。
      var rec = useContinuable
        ? { id: childId, childId: childId, continuable: true, ran: false, run: null, role: role, taskId: t.id, startedAt: Date.now(), model: modelOverride, settled: false }
        : { id: String(run.id), run: run, role: role, taskId: t.id, startedAt: Date.now(), model: modelOverride, settled: false }
      runsFor(sid)[t.id] = rec
      if (!dispatchedEver[sid]) dispatchedEver[sid] = {}
      dispatchedEver[sid][String(rec.id)] = true
      // 历史会话留档：每次派发都追加一条 {role,id,at,model}，任务完成后仍可回看
      // 各阶段（含重试的第 1/2/3 次 Worker）会话——否则 claimedBy/verifierRun 只留最后一次
      recordRunHistory(sid, t.id, role, String(rec.id), modelOverride, c.hardTimeoutMin).catch(function () {})
      // ===== 两级超时：软超时只提醒主窗口（由人决定继续等待或终止），硬超时兜底 dispose =====
      // 一次性 run 没有看门狗：完全依赖人工决策时，人不在线挂死的 run 会永久占用并发位，
      // 所以保留硬上限作为最后防线（默认 120min，可配置）。
      // ⚠️ 过渡态（task-muw5gnhv 卡1）：continuable 路径的硬超时仍走旧 dispose 兜底结算，
      // 不 interrupt 子会话（子代理可能继续跑）——卡2 才把这里换成 subagents.interrupt。
      var startedAt = rec.startedAt
      var softMs = c.softTimeoutMin * 60000
      var hardMs = c.hardTimeoutMin * 60000
      function finish(res, err) { if (rec.settled) return; rec.settled = true; settleRun(sid, rec, res, err) }
      ;(function softArm() {
        var tm = ctx.timer; if (!tm) return
        tm.timeout(softMs).then(function () {
          if (rec.settled) return
          var mins = Math.round((Date.now() - startedAt) / 60000)
          // 带 taskId：投递前会按任务现状复查，任务已完成/落定的过期告警直接丢弃（避免误报）
          pushSysNote(sid, '⏱ 任务「' + t.title + '」的 ' + role + '（' + t.id + '）已运行 ' + mins + ' 分钟仍未完成——如属正常长任务可忽略；需要干预可在看板详情页「立即终止」（硬超时 ' + c.hardTimeoutMin + ' 分钟后将自动终止并重试）', t.id)
          softArm() // 持续提醒直到结算或硬超时
        }).catch(function () {})
      })()
      // continuable 没有 run.result：用永不落定的 Promise 占位——结算唯一入口是 agent/status 的 idle
      // （硬超时那条臂由 withTimeout 提供，语义与一次性路径一致：到期走失败结算）。
      // 测试钩子 deps.continuableResult：单测要验证「continuable 路径的失败/超时结算」时替换这个占位
      // （生产不注入 → 保持永不落定）。
      var resultP = useContinuable ? (typeof deps.continuableResult === 'function' ? deps.continuableResult(rec) : new Promise(function () {})) : run.result
      withTimeout(resultP, hardMs, role + ':' + t.id).then(function (res) { finish(res, null) }).catch(function (e) { finish(null, e) })
      return rec
    }

    // run 结算：保证 dispose；工具通道（board_report/board_verdict）已推进状态的话文本路径跳过
    async function settleRun(sid, rec, res, err) {
      if (runsFor(sid)[rec.taskId] !== rec) return // 已被 terminate 等路径处理
      delete runsFor(sid)[rec.taskId]
      // 清理：一次性 run 走 dispose（既有语义逐字不变）；continuable 走 drain/不断言——
      // 卡1 只结算不 interrupt（子会话被 interrupt 后仍可被 sendMessage 唤醒，故此处不断言其死亡）。
      try {
        if (rec.continuable) await endContinuable(rec)
        else await rec.run.dispose()
      } catch (_) {}
      var output = outputText(res)
      var failed = !!err || (res && res.stopReason && res.stopReason !== 'completed')
      var errText = err ? String(err) : (res && (res.diagnostic || res.stopReason) || '')
      try {
        if (rec.role === 'worker') await settleWorker(sid, rec, output, failed, errText)
        else if (rec.role === 'hook-pre' || rec.role === 'hook-post') await settleHook(sid, rec, output, failed, errText)
        else await settleVerifier(sid, rec, output, failed, errText)
      } catch (e) { console.error('[task-board] settle ' + rec.role + ' failed (task ' + rec.taskId + '):', String(e)) }
      // 历史会话留档：记录该次 run 的结局（完成/失败/硬超时），详情页可据此标注阶段状态
      closeRunHistory(sid, rec.taskId, String(rec.id), failed ? (err ? 'timeout/error' : 'incomplete') : 'completed').catch(function () {})
      // ===== token 消耗结算：读该次 run 的 v4 日志聚合 usage，累加到任务 =====
      // 放在状态推进之后：统计是附加信息，读日志失败/无 usage 时静默跳过，绝不影响结算语义。
      // Worker 失败重试、驳回重做都会各走一次 settleRun，因此多轮消耗天然累加（runs 计数）。
      await accumulateRunUsage(sid, rec)
    }

    // ===== 可续跑 Worker 的 turn 结算（task-muw5gnhv 卡1）=====
    // 与一次性路径的关系：任务推进语义**完全复用** settleWorker（board_report 工具优先、文本兜底同构），
    // 差别只在「怎么知道 turn 完了」与「怎么收尾」：
    //   · 一次性：run.result 落定 → settleRun(res,err)（有结构化结果/失败原因）；
    //   · continuable：没有 run.result，只能靠 host 事件 agent/status 的 running→idle 观测 turn 结束
    //     （见 onAgentStatus）。因此这里没有 res：输出文本从子会话 v4 日志尾部的 assistant/message 兜底读；
    //     日志读不到且文本为空时按失败结算（走 pending 重试），**绝不当成「空完成」推进到 verifying**——
    //     否则一次「没跑起来就 idle」的事件会把任务误判为有交付物。
    async function settleContinuable(sid, rec) {
      if (runsFor(sid)[rec.taskId] !== rec) return // 已被 terminate/硬超时等路径认领
      var text = ''
      try { text = childSessionOutput(rec.childId) } catch (e) { console.error('[task-board] continuable 输出读取失败 (' + rec.childId + '):', String(e)) }
      if (!text.trim()) console.error('[task-board] continuable child ' + rec.childId + ' idle 但未读到 assistant 文本，按失败结算（任务 ' + rec.taskId + '）')
      await settleRun(sid, rec, { output: [{ type: 'text', text: text }], stopReason: text.trim() ? 'completed' : 'error' }, null)
    }

    // continuable 子会话的收尾：本卡**不 interrupt**（卡2 才接超时/中止臂），只记录事件——
    // 子会话是持久会话，turn 结束即闲置，不释放也无副作用；硬超时兜底路径同样只经此处。
    async function endContinuable(rec) {
      // 过渡态占位：保留钩子位置，卡2 在此调 subagents.interrupt(childId, {kind:'ancestor', agent: parent})
      return rec
    }

    // 读子会话 v4 日志尾部的助手文本（continuable 路径的文本兜底通道）：
    // 与 rpc.mjs agent-activity 同一套 helper/事件形状（assistant/message.content[].text），
    // 只是这里要的是**最后一条完整助手文本**（供 settleWorker 解析分段格式 / [ESCALATE]）。
    // 只读尾部 2MB：回复在末尾，整份读大日志会拖慢结算路径；读不到一律返回 ''（调用方按失败处理）。
    function childSessionOutput(childId) {
      if (!childId) return ''
      var log = findRunLog(childId)
      if (!log) return ''
      var buf = readLogBytes(log, 2 * 1024 * 1024)
      if (!buf) return ''
      var frames = readLogFrames(buf, 0)
      var out = ''
      for (var fi = 0; fi < frames.length; fi++) {
        var evs = frames[fi]
        for (var i = 0; i < evs.length; i++) {
          var e = evs[i]; var dta = (e && e.data) || {}
          if (!e || e.type !== 'assistant/message') continue
          var msg = dta.message || {}
          var blocks = Array.isArray(msg.content) ? msg.content : []
          var parts = []
          for (var b = 0; b < blocks.length; b++) { if (blocks[b] && blocks[b].type === 'text' && blocks[b].text) parts.push(String(blocks[b].text)) }
          if (parts.length) out = parts.join('\n') // 帧从新到旧：最后命中覆盖前值 → 得到最新一条助手文本
        }
      }
      return out
    }

    // 本地日期 key（YYYY-MM-DD）：byDay 日账的唯一口径。
    // 必须用本地 getters 拼——toISOString() 是 UTC，晚上 8 点后的消耗会被记到次日，
    // 「今日消耗」在东八区会从每天 08:00 起算，直接错位。
    function localDayKey(d) {
      var x = d || new Date()
      function p2(n) { return (n < 10 ? '0' : '') + n }
      return x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate())
    }

    // 有效消耗 = 输入 + 输出 + 缓存写（不含缓存读）。
    // 为什么单列：本板实测累计 total 里缓存读占 94%（9.7M/10.3M），大数字被缓存读撑高约 17 倍，
    // 与「真实花掉多少」严重脱节——有效消耗才是可比的成本口径，缓存读单列展示。
    function effectiveOf(u) {
      if (!u) return 0
      return (u.input || 0) + (u.output || 0) + (u.cacheWrite || 0)
    }

    // 把一次 run 的 token 消耗累加到任务（t.usage）：总量/输入/输出/缓存读写 + 按模型小计 + runs 计数 + 日账。
    // 模型小计的 key：优先本次派发显式覆盖的模型（rec.model），否则用日志里记录的会话模型。
    // 日账（byDay）：本次 run 整笔记到「结算时刻的本地日」——一次 run 不跨日拆分
    // （跨零点的长 run 全算在结算日），换取实现极简与仪表盘「今日 / 近 7 天」可算。
    // 双指标形态：byDay[day] = { t: total, e: effective }（e 是有效消耗，不含缓存读）。
    // 老数据（number 形态，本轮之前落的日账）只在聚合端兼容：读侧按 { t: n, e: null } 处理，
    // e 不可知就置 null（宁可展示上标 ~ 近似，也不伪造一个「有效值」）。
    async function accumulateRunUsage(sid, rec) {
      var u = null
      try { u = readRunUsage(String(rec.id)) } catch (_) { u = null }
      if (!u || !u.total) return
      var eff = effectiveOf(u)
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === rec.taskId })
          if (!t) return null
          if (!t.usage) t.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, runs: 0, models: {} }
          // 逐字段兜底 0：脏数据（半写/老形态）也不会把 NaN 带进看板（NaN 会让工具输出的 lossless-JSON 校验拒整条结果）
          t.usage.input = (t.usage.input || 0) + u.input
          t.usage.output = (t.usage.output || 0) + u.output
          t.usage.cacheRead = (t.usage.cacheRead || 0) + u.cacheRead
          t.usage.cacheWrite = (t.usage.cacheWrite || 0) + u.cacheWrite
          t.usage.total = (t.usage.total || 0) + u.total
          t.usage.runs = (t.usage.runs || 0) + 1
          if (!t.usage.models) t.usage.models = {}
          var mk = rec.model || u.model || '(未知模型)'
          t.usage.models[mk] = (t.usage.models[mk] || 0) + u.total
          // 日账：老任务没有 byDay 就地补（不改写老字段形态）；键是本地日 YYYY-MM-DD。
          if (!t.usage.byDay) t.usage.byDay = {}
          // 脏值兜底：历史/半写数据里 byDay[dk] 可能是 number（老形态）或字符串，一律收敛成对象记账
          var dk = localDayKey()
          var cell = t.usage.byDay[dk]
          if (!cell || typeof cell !== 'object') cell = { t: Number(cell) || 0, e: 0 }
          cell.t = (Number(cell.t) || 0) + u.total
          cell.e = (Number(cell.e) || 0) + eff
          t.usage.byDay[dk] = cell
          // ===== run 级留账：把本次 run 的用量原样写回它在 t.runs 里的条目 =====
          // 作用：总量口径万一再要调整（换分母/排除某类 run/按天或按模型重建），不必回头猜——
          // 每个 run 自带五分量，任意维度都能精确重算（byDay 只是它的一个投影）。
          // 找不到条目就跳过：t.runs 条目由 recordRunHistory 先行写入、closeRunHistory 更新结局，
          // 正常结算路径必存在；只有手写/裁剪过的历史任务会缺，缺了也不该阻断聚合累加。
          if (Array.isArray(t.runs)) {
            for (var ri = t.runs.length - 1; ri >= 0; ri--) {
              if (String(t.runs[ri] && t.runs[ri].id) === String(rec.id)) {
                t.runs[ri].usage = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, total: u.total || 0 }
                break
              }
            }
          }
          t.usage.updatedAt = new Date().toISOString()
          return { ok: true }
        })
      } catch (e) { console.error('[task-board] usage accumulate failed (task ' + rec.taskId + '):', String(e)) }
    }

    // ===== host 事件订阅：agent/status（continuable Worker 的 turn 结算触发器，task-muw5gnhv 卡1）=====
    // 事件契约（host Event 目录实证）：'agent/status'(payload: { agent, status: 'idle'|'running' })。
    // 「子代理 turn 完成」在事件面就是 running→idle；continuable 没有 run.result promise，故这是唯一可靠的
    // 结算信号。订阅形态：ctx.on（本插件 host 侧首个事件订阅点），一律走 ctx.effect 回收——
    // 插件卸载/HMR 重载时监听器必须随之注销，否则重载后同一事件会被多份旧闭包重复结算（重复结算虽被
    // rec.settled / runsFor 认领双重挡住，但旧闭包里过期的 state 引用本身就是内存泄漏）。
    // 二次守卫 rec.ran：只有**观测到过 running** 的 rec 才允许被 idle 结算。理由：startContinuable 返回后
    // 子会话可能先报一个瞬时 idle（驱动尚未接上/冷复活窗口），若拿它结算，任务会以「空文本」被推进/回退。
    // 真实 turn 必然先 running 后 idle，因此该守卫只挡伪 idle，不挡正常结算。
    function onAgentStatus(payload) {
      try {
        // ⚠️ 不能在此只放行 idle：running 事件正是 rec.ran 的唯一来源（见下方守卫），
        // 早退会让 rec.ran 永远 false → idle 永远不结算（任务只能等硬超时）——本实现踩过的坑。
        var status = payload && payload.status
        if (status !== 'idle' && status !== 'running') return
        var agent = payload.agent
        var cid = agent ? String(agent.id) : ''
        if (!cid) return
        var table = state.activeRuns
        // 事件按会话 id 命中活跃 rec：continuable rec 的 childId 就是子会话 id（= agent.id），
        // 故这里是 O(1) 的 rec.childId 比对，不做任何 agent 注册表扫描。
        Object.keys(table).forEach(function (sid) {
          var rr = table[sid]; if (!rr) return
          Object.keys(rr).forEach(function (k) {
            var rec = rr[k]
            if (!rec || !rec.continuable || rec.childId !== cid) return
            if (status === 'running') { rec.ran = true; return }
            if (!rec.ran || rec.settled) return
            rec.settled = true // 先立旗：堵住硬超时臂与重复事件的并发重入
            settleContinuable(sid, rec).catch(function (e) { console.error('[task-board] settleContinuable failed (task ' + rec.taskId + '):', String(e)) })
          })
        })
      } catch (e) { console.error('[task-board] agent/status 处理失败:', String(e)) }
    }
    // 注册（cordis 标准事件订阅）：返回的 disposer 交给 ctx.effect 回收。
    // 老宿主/测试桩上没有 ctx.on 时静默跳过——派发照常，只是没有事件结算通道（一次性路径本就不需要）。
    if (typeof ctx.on === 'function') {
      try {
        ctx.effect(function () { return ctx.on('agent/status', onAgentStatus) })
      } catch (e) { console.error('[task-board] agent/status 订阅失败:', String(e)) }
    }

    async function settleWorker(sid, rec, output, failed, errText) {
      // 完成回执开关（设置区「通知」notifyDone）：在同一次持锁回调里读看板文档（零额外读盘），
      // 缺字段/回调未跑到时保持 true——宁可多报一条，也不因读配置失败漏报完成。
      var doneOn = true
      var result = await mutateLocked(sid, function (d) {
        doneOn = cfg(d).notifyDone !== false
        var t = d.tasks.find(function (x) { return x.id === rec.taskId })
        if (!t) return null
        // 工具通道已处理（board_report 已推进到 verifying/resolved 或挂了 escalation）→ 只收尾
        if (t.status !== 'in-progress' || t.escalation) return { task: t, already: true }
        if (failed) {
          // 失败原因落卡（截断 300）：卡片详情页可直接查看最近失败原因，排查三连败不再靠猜
          t.lastError = String(errText || '').slice(0, 300)
          t.retryCount = (t.retryCount || 0) + 1
          if (t.retryCount >= 3) { var ps = t.status; t.status = 'blocked'; ah(t, ps, 'blocked', String(rec.id), 'worker 失败 x' + t.retryCount + '（' + String(errText).slice(0, 120) + '），待人工介入'); return { task: t, blocked: true } }
          var ps2 = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps2, 'pending', String(rec.id), 'worker 失败（' + String(errText).slice(0, 80) + '），重新排队 (' + t.retryCount + '/3)')
          return { task: t, retry: true }
        }
        if (/\[ESCALATE\]/i.test(output || '')) {
          t.escalation = { question: output.slice(0, 2000), at: new Date().toISOString(), by: String(rec.id) }
          if (!Array.isArray(t.messages)) t.messages = []
          t.messages.push({ kind: 'escalation', text: output.slice(0, 4000), at: t.escalation.at, by: String(rec.id) })
          ah(t, 'in-progress', 'in-progress', String(rec.id), 'worker 上报歧义（文本通道），待主窗口裁决')
          return { task: t, escalated: true }
        }
        // 文本降级路径：分段格式上报
        var secs = parseSections(output)
        delete t.retryCount; delete t.stuckSince; delete t.lastError // 成功路径：失败计数/卡死标记/最近失败原因一并清除
        t.deliverable = { summary: secs.summary || output.slice(0, 600), changes: secs.changes || '', selfTest: secs.selfTest || '', diff: (secs.diff || '').slice(0, 4000), at: new Date().toISOString(), by: String(rec.id) }
        resolveApply(d, t, String(rec.id), 'verifying', output || 'Worker 完成', 'worker 文本上报完成')
        return { task: t }
      })
      if (!result) return
      // already=true：工具通道（board_report）已推进状态并已发回执/歧义通知，settle 只负责 dispose，不再重复通知
      if (result.already) return
      if (result.escalated) maybeNotify(sid, result.task)
      // 歧义通知（maybeNotify → notifyMainWindow）是裁决通道，不受回执开关影响：只闸下面两条完成/阻塞回执
      if (doneOn && result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
      if (doneOn && result.blocked) notifyTaskDone(sid, result.task, 'blocked')
      kickCycle(sid) // 结算后立刻补派
    }

    async function settleVerifier(sid, rec, output, failed, errText) {
      // 完成回执开关同上：持锁回调内取 notifyDone
      var doneOn = true
      var result = await mutateLocked(sid, function (d) {
        doneOn = cfg(d).notifyDone !== false
        var t = d.tasks.find(function (x) { return x.id === rec.taskId })
        if (!t) return null
        if (t.status !== 'verifying' || t.escalation) return { task: t, already: true } // 工具通道已处理
        var trimmed = (output || '').trim()
        var vm = trimmed.match(/^[ \t>*#\-\s]*(APPROVED|REJECTED)\b/im)
        if (failed || !vm) {
          // 失败原因落卡（截断 300）：verifier 故障/输出无法判定的原因留在卡片上供排查
          t.lastError = String(errText || 'verifier 未给出有效结论（输出格式异常）').slice(0, 300)
          // 失败/空输出/无法判定：verifyRetries 计数，>=3 转人工验收（deliverable 已完成，是 verifier 故障不是任务故障）
          if (failed && rec.model) { badModels[modelKey(sid, rec.model)] = true; pushSysNote(sid, '模型 ' + rec.model + ' 验收连续失败，已熔断回退父级模型') }
          t.verifyRetries = (t.verifyRetries || 0) + 1
          if (t.verifyRetries >= 3) { t.escalation = { question: 'Verifier 连续 ' + t.verifyRetries + ' 次未能给出有效结论（' + (failed ? String(errText).slice(0, 150) : '输出格式异常') + '）。交付物已完成，请人工验收：看板详情页直接通过/驳回，或 task_verify 裁决。', at: new Date().toISOString(), by: 'system' }; ah(t, 'verifying', 'verifying', 'system', 'verifier 故障，转人工验收'); return { task: t, escalated: true } }
          ah(t, 'verifying', 'verifying', 'system', 'verifier 未给出有效结论，重新排队审查 (' + t.verifyRetries + '/3)')
          return { task: t, retry: true }
        }
        var approved = vm[1].toUpperCase() === 'APPROVED'
        var vsecs = parseSections(trimmed)
        delete t.stuckSince; delete t.verifyRetries; delete t.lastError // 成功给出结论：卡死标记/重试计数/最近失败原因一并清除
        t.verification = { verdict: approved ? 'approved' : 'rejected', summary: vsecs.verifySummary || trimmed.slice(0, 600), checks: vsecs.checks || '', at: new Date().toISOString(), by: String(rec.id) }
        verifyApply(d, t, String(rec.id), approved ? 'approved' : 'rejected', trimmed.slice(0, 200))
        if (!approved) {
          t.rejectCount = (t.rejectCount || 0) + 1
          // 驳回包全量带回（task-muvg15p5）：summary + checks（逐条核对证据）落 messages，
          // 随 buildMessages 注入重派 Worker prompt——history 里只有 200 字截断，Worker 据此无法返工
          pushRejection(t, vsecs.verifySummary, vsecs.checks, t.verification.at, String(rec.id))
          // 学习飞轮 v1：Verifier 驳回 → 候选教训（场景/错误做法/来源），随 t.verification.at 判重
          pushRejectLesson(d, t, vsecs.verifySummary || trimmed, t.verification.at)
          if (t.rejectCount >= 3) { t.status = 'blocked'; ah(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x' + t.rejectCount + '，待人工裁决') }
          else { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', '驳回重派：新 Worker 将携带驳回原因继续') }
        }
        return { task: t, approved: approved }
      })
      if (!result) return
      // already=true：工具通道（board_verdict）已推进状态并已发回执，settle 只负责 dispose，不再重复通知
      if (result.already) return
      if (result.escalated) maybeNotify(sid, result.task)
      if (doneOn && result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
      if (doneOn && result.task && result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      kickCycle(sid)
    }

    // ===== hook run 结算（hooks=agent run 接线②）=====
    // 照 worker/verifier 的结算模式：mutateLocked 持锁改状态机（状态机纯函数在 core.applyHookSettle，
    // 单测直接打它），锁外发通知 + kickCycle 补派。
    //   hook-pre  完成 → hooks.pre.state='done'（下轮起子任务正常放行，串行闸门打开）
    //   hook-post 完成 → hooks.post.state='done' + epic 转 verifying（收口完成，交人验收）
    //   失败（异常/stopReason 异常）或文本 [ESCALATE] → 该点位 state='failed' + epic 转 blocked +
    //   escalation 挂卡（歧义上报「前置准备失败，重试/跳过/放弃」），不自动重试。
    // 幂等：epic 已有未裁决 escalation 时只收口不覆盖（主窗口裁决前不刷屏）。
    async function settleHook(sid, rec, output, failed, errText) {
      var phase = rec.role === 'hook-pre' ? 'pre' : 'post'
      var esc = /\[ESCALATE\]/i.test(output || '')
      var runId = String(rec.id)
      // 完成回执开关（notifyDone）：hook 收口把 epic 推进到 blocked/verifying 同样算完成回执，一视同仁
      var doneOn = true
      var result = await mutateLocked(sid, function (d) {
        doneOn = cfg(d).notifyDone !== false
        var p = d.tasks.find(function (x) { return x.id === rec.taskId })
        if (!p) return null
        return applyHookSettle(d, rec.taskId, phase, !(failed || esc), output, runId, errText)
      })
      if (!result) return
      if (result.already) return
      if (result.blocked) { maybeNotify(sid, result.task); if (doneOn) notifyTaskDone(sid, result.task, 'blocked') }
      if (doneOn && result.closed) notifyTaskDone(sid, result.task, 'resolved')
      kickCycle(sid) // 结算后立刻补派（pre 完成 → 子任务开跑；post 完成 → epic 进验收）
    }

    // ===== 派发周期（15s 心跳 + 写入后 kickCycle 触发）=====
    async function poolCycle(sid) {
      // root 存活早闸门（根治 no-root 刷屏，task-muuf0o7a）：无活 root 的会话板根本不进派发循环——
      // 不读盘、不 claim、不回收、不写盘、零日志。幻影板（裸短 id 建的 tasks-<短id>.json，真实会话
      // id 带 session- 前缀与后缀，rootForSession 永远匹配不到）或已关闭会话的残留板若进循环，
      // 每 15s 心跳都会 pickDispatch→占位 claim→spawnOneShot 才发现无 root→console.error→占位
      // 超时回收→下轮再来，永久 spam。死会话的 pending 卡等会话重开后自然恢复派发
      // （这正是孤儿板接管语义），此处无需任何动作。
      // 返回值说明：调用方（store.kickCycle / 15s 心跳）均忽略返回值，返回 undefined 签名兼容。
      if (!rootForSession(sid)) return undefined
      var info = []
      var runs = runsFor(sid)
      var snap = await rt(sid)
      var activeW = 0, activeV = 0
      // 角色口径：worker 计入 activeW（占 Worker 并发位）；verifier 与 hook run（hook-pre/hook-post）
      // 统一计入 activeV——hook run 不是 Worker，不该挤占 maxWorkers 并发位，但它确实是一条在跑的 run，
      // 必须参与「空闲快进」判定，否则 hook 跑着时重复派发的闸门会失守。
      Object.keys(runs).forEach(function (k) { if (runs[k].role === 'worker') activeW++; else activeV++ })
      // 空闲快进：无活跃任务且无活跃 run → 不写盘直接返回（心跳每 15s 跑一次，不能每次都写文件）
      var hasActive = snap.tasks.some(function (t) { return t.status === 'pending' || t.status === 'verifying' || t.status === 'in-progress' })
      if (!hasActive && activeW + activeV === 0) {
        var emptyPool = { workers: [], verifiers: [] }
        // 快进不写盘的前提是磁盘上的 poolStatus 已经是空的——否则（典型：DSH 重启清空了
        // 内存 runs 表，文件里残留重启前的忙碌快照）幽灵 Worker 会永远显示执行中
        var stalePool = snap.poolStatus && (((snap.poolStatus.workers || []).length + (snap.poolStatus.verifiers || []).length) > 0)
        // dispatchInfo 是瞬时通知（90s TTL）：空闲周期也要负责过期清理，否则永久残留
        var staleInfo = snap.dispatchInfo && (!snap.dispatchInfoAt || Date.now() - new Date(snap.dispatchInfoAt).getTime() > 90000)
        if (staleInfo) { delete snap.dispatchInfo; delete snap.dispatchInfoAt }
        if (stalePool || staleInfo) { if (stalePool) snap.poolStatus = emptyPool; try { await wt(sid, snap) } catch (_) {} }
        return snap
      }
      var c = cfg(snap)
      var isAuto = (snap.boardMode || 'auto') === 'auto'

      // 持锁：孤儿回收 + 占位 claim（防并发 cycle 重复派发）+ 池状态快照，一次原子写
      // 孤儿回收 + verifier 派发在两种模式都跑；worker 派发仅 auto 模式（manual 模式主窗口自己做）
      var toSpawn = []
      var result = await mutateLocked(sid, function (d) {
        var now = Date.now()
        d.tasks.forEach(function (t) {
          if (isOrphan(d, t, runs, now)) { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', '执行 run 已结束/丢失，回收重新排队'); pushSysNote(sid, '任务「' + t.title + '」执行 run 丢失，已回收重新排队'); info.push('reclaim ' + t.id) }
          // verifier 派发占位超时回收：占位后强杀/spawn 中断会留 spawn-pending 死占位，超 2min 清掉恢复可派发
          if (t.status === 'verifying' && t.verifierRun === 'spawn-pending' && (now - new Date(t.verifierRunAt || 0).getTime()) > 120000) { t.verifierRun = null; delete t.verifierRunAt; ah(t, 'verifying', 'verifying', 'system', 'Verifier 派发占位超时，回收重新排队'); info.push('reclaim-verifier ' + t.id) }
        })
        // worker 派发仅 auto；verifier 派发两种模式都跑（manual 模式主窗口 claim 做完的 full 档任务需要验收）
        var capW = isAuto ? Math.max(0, c.maxWorkers - activeW) : 0
        var picked = pickDispatch(d, capW, Math.max(0, c.maxVerifiers - activeV), runs)
        picked.pendings.forEach(function (t) { claimApply(d, t, 'spawn-pending', 'dispatch'); if (parentKickOnDispatch(d, t)) info.push('epic-kick ' + t.parentId); toSpawn.push({ role: 'worker', t: t }); info.push('dispatch ' + t.id) })
        picked.verifs.forEach(function (t) { t.verifierRun = 'spawn-pending'; t.verifierRunAt = new Date().toISOString(); toSpawn.push({ role: 'verifier', t: t }); info.push('verify ' + t.id) })
        // ===== hooks=agent run：pre 闸门占用 + post 收口补 spawn（接线①③）=====
        // pre：候选被 pickDispatch 的 preHookGate 拦下时，本轮不派子任务——这里改 spawn hook-pre run。
        // 触发条件用状态机本身（state='idle' 即「已声明且从未跑过」，重启后从卡上原样恢复，不靠内存标记）；
        // state='running' 说明已有 hook run 在跑（幂等，同一 epic 同时最多一条），'done'/'failed' 都轮不到这里。
        // post：子任务全部了结时 core.maybeAutoCloseParent 不直接转 verifying，只置 hooks.post.pending
        // 标记；本轮在这里看到标记就 spawn hook-post run（无活跃子任务时也能被下一次心跳收走）。
        d.tasks.forEach(function (t) {
          if (hookOn(t, 'pre') && t.hooks.pre.state === 'idle' && !runs[t.id]) {
            hookSetState(t, 'pre', 'running', 'system', '派发前置 hook run')
            toSpawn.push({ role: 'hook-pre', t: t })
            info.push('hook-pre ' + t.id)
          }
          if (t.status === 'in-progress' && hookOn(t, 'post') && t.hooks.post.pending && !t.verifierRun && !runs[t.id]) {
            t.hooks.post.pending = false
            t.hooks.post.state = 'running'
            t.verifierRun = 'spawn-pending' // 复用 Verifier 幂等占用位：只在 spawn 成功后换成真实 run id
            t.verifierRunAt = new Date().toISOString()
            toSpawn.push({ role: 'hook-post', t: t })
            info.push('hook-post ' + t.id)
          }
        })
        // touches 文件级排他展示态：被拦候选写 t.waitingForTouches = [持有者任务id...]，
        // 未被拦/已派发/已落定的任务清除该字段（每心跳刷新的 UI 展示态，不参与任何派发逻辑，
        // 但必须显式清——只在写入时报字段会留下"锁已释放仍显示 🔒 等待"的永久误导）。
        // 持锁口径的唯一出处是 core.holdsFiles（in-progress + claimedBy / verifying / resolved 都持锁，
        // 归档才真释放——反馈 n-muupqg81u575）。这里不做任何放锁动作：verifying/resolved 卡不放锁，
        // 故 conflicts 里出现 resolved 卡 id 是预期行为（滞留原因对用户可见，就是主窗口还没归档）；
        // 归档动作（archive-task / task_archive）把卡改成 archived 后，下轮 tickInProgress 15s 轮
        // 自然把等待卡放行，无需在此额外触发补派。
        var waitMap = {}
        picked.blockedTouches.forEach(function (b) { waitMap[b.id] = b.conflicts })
        d.tasks.forEach(function (t) {
          if (waitMap[t.id]) { t.waitingForTouches = waitMap[t.id]; info.push('wait-touches ' + t.id + '<-' + waitMap[t.id].join(',')) }
          else if (t.waitingForTouches) delete t.waitingForTouches
        })
        // UI 池状态：来自活跃 run（一次性模型：没有成员名册，只有在跑的任务）。
        // hook run 也归「verifiers」区展示（同一格里都是非 Worker 的一次性 run）。
        d.poolStatus = { workers: [], verifiers: [] }
        Object.keys(runs).forEach(function (k) { var rc = runs[k]; d.poolStatus[rc.role === 'worker' ? 'workers' : 'verifiers'].push({ id: k, num: '-', busy: true, taskId: rc.taskId, runId: String(rc.id), done: 0, queueLen: 0, suspect: false, model: rc.model || '' }) })
        if (info.length > 0) { d.dispatchInfo = info.join('; '); d.dispatchInfoAt = new Date().toISOString() }
        else if (d.dispatchInfo && (!d.dispatchInfoAt || Date.now() - new Date(d.dispatchInfoAt).getTime() > 90000)) { delete d.dispatchInfo; delete d.dispatchInfoAt } // 瞬时通知：90s TTL 过期即清，不再永久残留
        return d
      }, true) // skipKick：poolCycle 自写不触发 kickCycle（防无限循环）

      // 锁外 spawn（慢操作）；占位 claim 已保证不会被别的 cycle 重复派发
      for (var k = 0; k < toSpawn.length; k++) {
        var sp = toSpawn[k]
        var rec = await spawnOneShot(sid, sp.t, sp.role)
        if (rec) {
          // claim 占位换成真实 run id；verifier/hook-post run 单独记（claimedBy 保留 worker 的，供详情页跳转会话）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t) { if (sp.role === 'worker' && t.claimedBy === 'spawn-pending') t.claimedBy = String(rec.id); if ((sp.role === 'verifier' || sp.role === 'hook-post') && t.verifierRun === 'spawn-pending') { t.verifierRun = String(rec.id); t.verifierRunAt = new Date().toISOString() }; if (sp.role === 'hook-pre' && t.hooks && t.hooks.pre) t.hooks.pre.runId = String(rec.id) }; return t }, true)
          // 派发即回执：spawn 真成功后才入队（占位阶段失败不通知）；经 deps 注入，未注入静默跳过（老 host 兼容）
          // 回执开关（设置区「通知」）：notifyDispatch=false → 派发回执整条跳过（spawn 照常，只闭嘴）；
          // 闸门读本轮 poolCycle 已取的 cfg 快照 c（无额外读盘），老看板缺字段 → cfg 归一为 true。
          if (c.notifyDispatch !== false && typeof notifyDispatched === 'function') notifyDispatched(sid, sp.t, sp.role)
        } else if (sp.role === 'worker') {
          // spawn 失败 → 回 pending
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.status === 'in-progress' && t.claimedBy === 'spawn-pending') { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', 'spawn 失败，回收重新排队') }; return t }, true)
          pushSysNote(sid, '任务「' + sp.t.title + '」Worker 启动失败，已重新排队')
        } else if (sp.role === 'verifier') {
          // verifier spawn 失败 → 清占位，下轮 cycle 重试（占位不清会永远卡住派发）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.verifierRun === 'spawn-pending') { t.verifierRun = null; delete t.verifierRunAt }; return t }, true)
          pushSysNote(sid, '任务「' + sp.t.title + '」Verifier 启动失败，下轮自动重试')
        } else if (sp.role === 'hook-pre') {
          // hook-pre spawn 失败 → 退回 idle + 重新置待跑标记，下轮自动重试（串行闸门保持关闭）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.hooks && t.hooks.pre && t.hooks.pre.state === 'running') { t.hooks.pre.state = 'idle'; t.hooks.pre.runId = null; t.hooks.pre.pending = true }; return t }, true)
          pushSysNote(sid, '史诗「' + sp.t.title + '」前置 hook 启动失败，下轮自动重试')
        } else if (sp.role === 'hook-post') {
          // hook-post spawn 失败 → 清幂等占用 + 保留待跑标记，下轮自动重试
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t) { if (t.verifierRun === 'spawn-pending') { t.verifierRun = null; delete t.verifierRunAt } if (t.hooks && t.hooks.post && t.hooks.post.state !== 'done') t.hooks.post.pending = true }; return t }, true)
          pushSysNote(sid, '史诗「' + sp.t.title + '」收口 hook 启动失败，下轮自动重试')
        }
      }
      return result
    }

    // 插件停止时清理所有活跃 run。
    // continuable rec 没有 run（持久子会话，本卡不 interrupt）——两件事必须做：
    //   ① 判空（否则 rr[k].run.dispose() 抛 TypeError，虽被 catch 但整条清理链断在这里）；
    //   ② 立 settled 旗（让软/硬超时臂与事件结算一起放行，卸载后不该再有状态推进）。
    // 表的处置保持既有语义：逐会话原位清空（旧引用不会看到残留 rec）+ 顶层容器换新（与原实现的
    // state.activeRuns = {} 等价）。原位清空是必要的——runsFor(sid) 返回的是每会话子对象，
    // 只换顶层容器会把这些子对象连同里面的 rec 一起漏掉。
    ctx.effect(function () { return function () { Object.keys(state.activeRuns).forEach(function (psid) { var rr = state.activeRuns[psid]; Object.keys(rr).forEach(function (k) { try { var r0 = rr[k]; if (r0 && r0.run) r0.run.dispose(); if (r0) r0.settled = true } catch (_) {} ; delete rr[k] }) }); state.activeRuns = {} } })
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
          // O(1) 快路径：root agent 的 id 就是其会话 id（Agent.id === SessionId），
          // teamModeCache 按会话 id 键——Worker/Verifier 自己的会话 id 不在缓存里，天然不会误注入。
          // 不能走 resolveRoot：该函数在每个 agent 每次 prompt 组装时同步执行，
          // resolveRoot 全表扫 agent 注册表会把宿主事件循环卡死（曾导致全局界面卡顿、用户消息延迟渲染）。
          if (!teamModeCache[String(agent.id)]) return ''
          // 第 6 条（拆分条款）走 epicSplit 门禁（缺省 true = 逐字不变）：关掉只是不再主动劝拆，
          // 显式 parentId 建子卡 / 史诗自动收口 / hooks 状态机全部照常（机制不禁）。
          return '【任务看板 Team 模式已开启】\n本会话的任务看板处于 Team 模式。请遵循以下工作方式：\n1. 涉及代码改动、文件创建、命令执行等实质性工作时，优先用 task_create 提交为看板任务（由一次性 Worker/Verifier 子代理执行与验收），不要自己直接动手实现。\n2. 你仍保有全部工具能力——调研、读代码、讨论方案、回答问题时直接进行，无需提交任务。\n3. 创建任务时，务必在 description 里写清任务目标和约束；调研结论/原始需求/思路用 contextNotes 带上，调研时读过的关键文件用 contextFiles 把路径带上（可写「路径:L1-L2 — 一句用途」，只给行号不给正文）——两者都会随子代理的首条 prompt 一次性注入（调研笔记全文 + 文件清单），文件内容由子代理按需用 read 工具按行号范围自取。子代理是全新会话、无你的会话记忆，上下文不够它需要从零自行调研，效率大打折扣甚至跑偏方向——开发类任务（代码改动/修复/特性）务必带文件调研，实测可省 Worker 10~15 分钟自行 grep 定位；未带调研上下文的开发类任务返回会附 warning。\n4. Worker 上报歧义时会通过 task_arbitrate 等待你裁决，请及时响应。驳回重派时同样：新 Worker 没有上一轮的记忆，驳回原因会在 prompt 里，但额外上下文需你在 description 里补上。\n5. Team 模式下 task_create 默认建为草稿（草稿不会被派发领取）。把所有任务的 dependsOn 依赖关系、contextNotes/contextFiles 都补完后，再逐个 task_update publish=true 统一发布。确实需要立即派发的单个任务才显式传 draft:false。' + splitRuleOf(epicSplitOn(String(agent.id))) + (feedbackOn(String(agent.id)) ? '\n' + LESSON_RECALL_HINT + '把检索到的相关历史教训写进任务的 contextNotes，让子代理少踩重复的坑。' : '')
        },
      })
      ctx.effect(function () { return disposeSection })
      // 预研「上下文注入」区块通道已整体退役（task-muvjs392）：瘦身清单直接拼进首条 prompt，
      // 这里不再注册任何 systemPrompt.context 动态注入段——旧形态随 runtime 快照每轮刷新重发
      // （实证 6×48.8K 字符≈白烧 75–100K token），且「按父子归属认领预研包」的首轮竞速机制
      // 在并行 spawn 下存在认领错包的潜伏 bug，一并消灭。
    }

    return { poolCycle: poolCycle, spawnOneShot: spawnOneShot, accumulateRunUsage: accumulateRunUsage, readContextPack: readContextPack }
}
