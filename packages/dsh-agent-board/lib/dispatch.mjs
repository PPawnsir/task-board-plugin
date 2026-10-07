// dsh-agent-board — 派发引擎（lib/dispatch.mjs）
// createDispatch(ctx, state, deps)：一次性子代理 spawn/结算（软+硬两级超时）/ run 历史留档 /
// token 消耗累加 / poolCycle 派发周期（孤儿回收+占位 claim+池快照）/ 15s 心跳 / 插件卸载清理 /
// Team 模式 systemPrompt 引导段 / 预研上下文瘦身清单（调研笔记全文 + 文件清单，随首条 prompt 一次性注入）/
// 可续跑 Worker（continuable：硬超时 interrupt 留存 + 重派 sendMessage 冷复活续跑 + 失败回退 fresh spawn）。
import { statSync } from 'node:fs'
import * as core from './core.mjs'
import { readRunUsage, findRunLog, readLogBytes, readLogFrames } from './usage.mjs'
import { splitRuleOf, pushRejectLesson } from './policy.mjs'
const { ah, cfg, claimApply, resolveApply, verifyApply, parseSections, outputText, pickDispatch, isOrphan, buildWorkerPrompt, buildVerifierPrompt, buildContextPackSection, parseContextFileEntry, parentKickOnDispatch, LESSON_RECALL_HINT, buildHookPrompt, applyHookSettle, hookOn, hookSetState, gsb, pushRejection } = core

export function createDispatch(ctx, state, deps) {
    // 宿主 fs 句柄与「会话工作区解析根」随预研注入瘦身退役（task-muvjs392）：派发侧不再读盘——
    // 清单只给「路径:L行号 — 一句用途」，文件内容由 Worker 自己用 read 工具按行号范围自取。
    var rt = deps.rt, wt = deps.wt, mutateLocked = deps.mutateLocked, kickCycle = deps.kickCycle
    var rootForSession = deps.rootForSession, withTimeout = deps.withTimeout, runsFor = deps.runsFor, feedbackOn = deps.feedbackOn
    // 会话日志根（可选注入）：usage 增量结算（卡3）必须「真读真日志」才测得出重复计账——
    // 生产不注入（usage.mjs 回退 os.homedir()），单测注入临时目录（否则只能开子进程改 HOME，
    // 而同进程改 os.homedir 会污染整个测试进程）。老宿主/老测试桩无此依赖 → undefined，行为不变。
    var sessionsRoot = (typeof deps.sessionsRoot === 'string' && deps.sessionsRoot) ? deps.sessionsRoot : undefined
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

    // ===== 运行时健康自检（task-muxhrkbg）心跳打点 =====
    // 本模块是三处心跳的唯一写入方：poolCycle 成功轮 / settleRunRecord 成功结算 / 幽灵回收 >0 / spawn 成功。
    // 读侧在 rpc get-tasks（health.computeRuntimeHealthHints 现算 hint）；纯内存不落盘。
    // state 缺字段时就地补（测试桩/老宿主兼容，与 rpc.mjs mainWindowUsageCache 同例）。
    function poolHealthFor(sid) {
      if (!state.poolHealth) state.poolHealth = {}
      var ph = state.poolHealth[sid]
      if (!ph) { ph = state.poolHealth[sid] = { bornAt: Date.now() } }
      return ph
    }

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

    // 历史会话留档：t.runs = [{ role, id, at, model, outcome, endedAt, continuable?, resume?, noResume? }]，上限 20 条
    // 目的：任务流转到 resolved/archived 后，详情页仍能选择跳转到任一历史阶段的会话
    // （Worker 首次/重试、Verifier 各次），而不是只剩最后一次 run id。
    // 卡2 追加三个标记位（都是**续跑判定的唯一依据**，不再另建内存表——重启后从卡上原样恢复）：
    //   continuable：该 run 是持久子会话，超时/失败后可被 sendMessage 冷复活（一次性 run 无此标记 → 不可续跑）；
    //   resume：本条本身就是一次续跑记录（详情页可区分「首派 / 续跑」）；
    //   noResume：该子会话不可信（interrupt 失败/无 root 可授权）→ 重派直接 fresh spawn，不做空唤醒。
    //   usage / usageSeq / usageRecorded：usage 落账（卡3 seq 水位线增量）与「已落账」幂等旗
    //   （task-muwkhqf8：continuable 的 run 记录现在有两条结算入口——事件通道（agent/status）与
    //   上报通道（board_report 工具完成即收尾），重复关账必须不二次记账）。
    // 两函数都对「同一条 run 记录」幂等：closeRunHistory 只认 outcome==='running' 的条目——重复 settle
    // （idle 事件重入/上报与事件双通道）不覆盖结局、不刷新 endedAt（否则重入会把「已结算」伪装成本次
    // 结算的产物）。recordRunHistory 的幂等**只在续跑轮（resume）启用**：续跑轮与首轮共用同一个子会话 id，
    // 若 sendMessage 的登记被重试一次，就会出现两条同 id 且都停在 running 的记录（续跑资格与 usage 水位线
    // 双双错乱）——故「同 id 已有未落定的条目」时不再追加；而**首派/续跑回退 fresh spawn 一律追加新条目**
    // （同一 childId 的多次派发各占一条，这是 usage 水位线分段的前提，见 seekSeqOf）。
    async function recordRunHistory(sid, taskId, role, runId, model, hardMin, continuable, resume) {
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t) return null // 找不到任务：返回 null 不写盘
          if (!Array.isArray(t.runs)) t.runs = []
          if (resume) {
            for (var ri = t.runs.length - 1; ri >= 0; ri--) {
              var r0 = t.runs[ri]
              if (r0 && String(r0.id) === String(runId) && (!r0.outcome || r0.outcome === 'running')) return null
            }
          }
          var e = { role: role, id: runId, at: new Date().toISOString(), model: model || '', outcome: 'running', hardMin: hardMin || 120 }
          if (continuable) e.continuable = true
          if (resume) e.resume = true
          t.runs.push(e)
          if (t.runs.length > 20) t.runs = t.runs.slice(-20)
          return { ok: true } // mutateLocked 契约：回调返回 null/undefined 则跳过写盘——必须显式返回非空值，否则 runs 永不落盘
        })
      } catch (e) { console.error('[task-board] recordRunHistory failed:', String(e)) }
    }
    async function closeRunHistory(sid, taskId, runId, outcome, flags) {
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t || !Array.isArray(t.runs)) return null // 找不到任务/无 runs：返回 null 不写盘
          for (var i = t.runs.length - 1; i >= 0; i--) {
            if (t.runs[i].id === runId) {
              if (t.runs[i].outcome === 'running') { // 幂等②：只关「还开着」的那条，重入不覆盖结局/endedAt
                t.runs[i].outcome = outcome; t.runs[i].endedAt = new Date().toISOString()
                // flags.noResume：子会话不可信（interrupt 抛错 / 拿不到可授权的活父 Agent）→
                // 这条 run 永久失去续跑资格（resumeTarget 据此回退 fresh spawn，绝不去空唤醒）。
                if (flags && flags.noResume) t.runs[i].noResume = true
              }
              break
            }
          }
          return { ok: true } // 同上：显式返回非空值触发写盘
        })
      } catch (e) { console.error('[task-board] closeRunHistory failed:', String(e)) }
    }

    // ===== 续跑资格判定（卡2）：纯读 t.runs，零 IO =====
    // 从最后一条 Worker run 倒着看，只有「该 run 是 continuable（持久子会话，可冷复活）＋ 结局是超时/失败
    // ＋ 未被标记 noResume」才够格——返回可唤醒的 childId，否则返回 ''（不够格）。
    // 一次性 run 没有 continuable 标记（没有可唤醒的会话），故天然零命中：回退开关下整条续跑路径逐字不生效。
    // 只看**最后一条 Worker run**：更早的 run 即使失败，其会话也已被后续 run 取代（续跑要接着最新断点）。
    function resumeTarget(t) {
      if (!t || !Array.isArray(t.runs)) return ''
      for (var i = t.runs.length - 1; i >= 0; i--) {
        var r = t.runs[i]
        if (!r || r.role !== 'worker') continue
        if (r.continuable !== true || r.noResume === true) return ''
        if (r.outcome !== 'timeout/error' && r.outcome !== 'incomplete') return ''
        return String(r.id || '')
      }
      return ''
    }
    // 「第 N 次尝试」的 N：该任务已有的 Worker run 条数 + 本次。t.runs 被 20 条上限裁剪或老卡没有 runs[]
    // 时退化用 retryCount + 1（口径略粗但方向一致）。只用于续跑文案，不参与任何状态机判断。
    function workerAttemptNo(t) {
      var n = 0
      if (t && Array.isArray(t.runs)) for (var i = 0; i < t.runs.length; i++) { if (t.runs[i] && t.runs[i].role === 'worker') n++ }
      if (!n) n = (t && t.retryCount) || 0
      return n + 1
    }
    // continuable 子会话日志的当前字节数（续跑基线）：续跑轮结算时只读这之后的字节，从而只认
    // 「本轮新写的助手文本」。护栏理由：子会话是同一个会话，上一轮（被中断那次）的助手文本仍在日志里——
    // 若续跑轮一个字都没产出，绝不能把上一轮的残留文本当成「本轮交付物」推进 verifying（那是假完成）。
    // 读不到日志返回 0 → 退化为「按整段日志读」（与卡1 同口径），不因日志缺失改变结算语义。
    function logSizeOf(childId) {
      try { var log = findRunLog(childId, sessionsRoot); if (!log) return 0; return statSync(log).size || 0 } catch (_) { return 0 }
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
      } else promptText = role === 'worker' ? buildWorkerPrompt(t, pack, cfg(dsnap).feedbackEnabled) : buildVerifierPrompt(t, pack, cfg(dsnap).verifyUserGuide)
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
      // 各阶段（含重试的第 1/2/3 次 Worker）会话——否则 claimedBy/verifierRun 只留最后一次。
      // **必须 await**（task-muwkhqf8）：上报通道的收尾（settleReportedRun → closeRunHistory）要求在
      // 「记录已落卡」之后才能关账——fire-and-forget 下极短任务（worker 秒级 board_report）会撞上竞态：
      // 关账先落地 → 找不到条目 → closeRunHistory 空转，run 记录依旧停在 running。
      await recordRunHistory(sid, t.id, role, String(rec.id), modelOverride, c.hardTimeoutMin, !!rec.continuable)
      // ===== 两级超时臂（软提醒 + 硬超时结算）：本体在 armTimeouts，fresh spawn 与续跑共用 =====
      armTimeouts(sid, rec, t, c)
      return rec
    }

    // ===== 两级超时：软超时只提醒主窗口（由人决定继续等待或终止），硬超时兜底结算 =====
    // 一次性 run 没有看门狗：完全依赖人工决策时，人不在线挂死的 run 会永久占用并发位，
    // 所以保留硬上限作为最后防线（默认 120min，可配置）。
    // 两条 spawn 路共用这条臂（卡2 从 spawnOneShot 抽出）：续跑轮也必须挂——否则冷复活的子会话挂死
    // 会永久占用 Worker 并发位，且再没有下一次重派。
    // 硬超时到期本身只是「失败结算」的触发器（语义与一次性路径一致），收尾动作按 rec 分流
    // （见 settleRun）：continuable → interrupt 留存（重派时 sendMessage 冷复活续跑）；一次性 → run.dispose()。
    // ===== 超时臂的「摘除」（task-muwkhqf8 回归修复）=====
    // 病根：两条臂此前**只能靠自己到期落定或 rec.settled 旗空转**——结算完成后软臂那条递归链仍在
    // 每 30min 醒一次刷「worker 已运行 N 分钟仍未完成」的假告警（实测对已 board_report 完成的 run 误报），
    // 硬臂也只是被（未取消的）setTimeout 兜住、到期才对一条早已结算的闲置会话补一枪 interrupt。
    // 修法：软臂改回调式 ctx.timer.timeout(cb, ms)（返回 dispose 闭包，可真清）；硬臂旁挂一个可 reject 的
    // 闸门，摘除时 reject 掉 → withTimeout 的 race 立刻落定，结算链收口，到期不再有补枪。
    // 幂等：disarm 可能被多条入口重复调用（事件通道 / 上报通道 / 硬超时路径自身），一律 no-op 安全。
    // 兼容：老宿主/测试桩的 ctx.timer 可能只实现 promise 形态（返回 thenable 而非 dispose 函数）——
    // 此时没有可清的 handle，退化为「靠 rec.settled 旗空转」，行为与本次改造前逐字一致。
    function armTimeouts(sid, rec, t, c) {
      var startedAt = rec.startedAt
      var softMs = c.softTimeoutMin * 60000
      var hardMs = c.hardTimeoutMin * 60000
      function finish(res, err) { if (rec.settled) return; rec.settled = true; settleRun(sid, rec, res, err) }
      function disarmTimeouts() {
        if (rec.timersDisarmed) return
        rec.timersDisarmed = true
        // 软臂：清掉待到期的那次递归 timeout（链上的下一次由 rec.timersDisarmed 早退拦住，不再续挂）
        try { if (typeof rec.softDispose === 'function') rec.softDispose() } catch (_) {}
        // 硬臂：reject 掉旁挂闸门 → withTimeout 的 race 立即落定为失败；rec.settled 已立时 finish 直接放行
        try { if (typeof rec.abort === 'function') rec.abort() } catch (_) {}
      }
      rec.disarm = disarmTimeouts // 暴露给上报通道（board_report 完成即收尾）与事件通道结算路径
      // 软臂：回调式 ctx.timer.timeout(cb, ms)（真实 ctx.timer 返回 dispose 闭包）→ 可被 disarm 真清掉；
      // 老桩的 promise 形态（返回 thenable）退化为 .then 语义——与本次改造前的行为逐字一致。
      function softSchedule() {
        var tm = ctx.timer; if (!tm) return
        var h = tm.timeout(function () {
          if (rec.timersDisarmed || rec.settled) return
          var mins = Math.round((Date.now() - startedAt) / 60000)
          // 带 taskId：投递前会按任务现状复查，任务已完成/落定的过期告警直接丢弃（避免误报）
          pushSysNote(sid, '⏱ 任务「' + t.title + '」的 ' + rec.role + '（' + t.id + '）已运行 ' + mins + ' 分钟仍未完成——如属正常长任务可忽略；需要干预可在看板详情页「立即终止」（硬超时 ' + c.hardTimeoutMin + ' 分钟后将自动终止并重试）', t.id)
          if (rec.timersDisarmed || rec.settled) return
          softSchedule() // 持续提醒直到结算或硬超时（下一环同样可被 disarm 清掉）
        }, softMs)
        if (typeof h === 'function') rec.softDispose = h
        else if (h && typeof h.then === 'function') { h.then(function () { if (!rec.timersDisarmed && !rec.settled) softSchedule() }).catch(function () {}) }
      }
      ;(function softArm() { softSchedule() })()
      // continuable 没有 run.result：用永不落定的 Promise 占位——结算唯一入口是 agent/status 的 idle
      // （硬超时那条臂由 withTimeout 提供，语义与一次性路径一致：到期走失败结算）。
      // 测试钩子 deps.continuableResult：单测要验证「continuable 路径的失败/超时结算」时替换这个占位
      // （生产不注入 → 保持永不落定）。
      var resultP = rec.continuable ? (typeof deps.continuableResult === 'function' ? deps.continuableResult(rec) : new Promise(function () {})) : rec.run.result
      // 可摘除硬臂：abort 闸门先落定 → withTimeout 的 race 立刻结束，结算后不再对闲置会话补枪。
      // 兜底两处（均为老环境/老桩）：AbortController 缺席 → 退化为裸 withTimeout（逐字不变）；
      // AbortSignal.reason 缺席（Node <17.2）→ abort 落定为无 reason 的 AbortError（老 Node 的既有形状）。
      var abortableP = resultP
      try {
        if (typeof AbortController === 'function') {
          var ac = new AbortController()
          // ⚠️ 刻意**不带 reason**（无参 abort）：Node 会把 abort reason 变成 signal 内部的未处理拒绝
          // （AbortSignal 的 thenable），带 reason 时整个进程会因 unhandled rejection 崩掉——本实现踩过的坑。
          // 落定值由旁挂 promise 自己给（见下），不依赖 signal.reason。
          rec.abort = function () { ac.abort() } // finish 已由 rec.settled 挡住，这条不触发结算
          abortableP = new Promise(function (res, rej) {
            // 摘除（abort）与「abort 之后再挂」都落成同一个失败值：finish 读 rec.settled 后直接 return，不结算。
            function onAbort() { rej(new Error('settled')) }
            if (ac.signal.aborted) { onAbort(); return }
            ac.signal.addEventListener('abort', onAbort, { once: true })
            Promise.resolve(resultP).then(res, rej)
          })
          // ⚠️ 必须就地挂一个空 catch：某些宿主/测试桩的 withTimeout 在**另一路先行落定**（例如硬超时本身
          // 立即 reject）时不会把本 promise 接进 race 的处理器——那样 abort 落定就成了「无处理者的拒绝」，
          // 整个进程会被 unhandled rejection 干掉（本实现踩过的坑）。空 catch 只标记「有人处理」，
          // 不改变 race 的结算值。
          abortableP.catch(function () {})
        } else rec.abort = null
      } catch (_) { rec.abort = null; abortableP = resultP }
      withTimeout(abortableP, hardMs, rec.role + ':' + t.id).then(function (res) { finish(res, null) }).catch(function (e) { finish(null, e) })
    }

    // ===== 重派续跑（卡2）：命中「上次 continuable Worker run 结局=超时/失败」的 pending 任务 =====
    // 不 spawn 新 Worker，改 subagents.sendMessage(活父 Agent, childId, 断点续跑指令)：子会话从持久化
    // **冷复活**，带着自己上一轮的全部上下文（读过什么、改到哪、哪些命令跑通了）接着干——
    // 超时重派不再从零开始。指令是薄框架文案：只要求「盘点工作树 + 从断点继续」，具体怎么做由它判断。
    // 三态返回：{ rec } 续跑成功 / { fallback } 续跑不可用（调用方落回 fresh spawn，并把原因写进任务消息）/
    //           null 压根不适用（无可续跑 run / 宿主没有 sendMessage 能力）——此时调用方走原 fresh spawn，
    //           一次性回退开关（workerContinuable=false）下的行为因此逐字不变。
    // 授权形状取 dsh-subagent 的 SubagentSendMessageOptions：{ signal }（sender 必须是**活的直接父 Agent**，
    // 服务端按邻接关系校验；子会话不在线则从持久化冷复活，不可复活时 reject → 这里转成 fallback）。
    async function tryResumeWorker(sid, t) {
      var subagents = ctx.subagents
      if (!subagents || typeof subagents.sendMessage !== 'function') return null
      var childId = resumeTarget(t)
      if (!childId) return null
      var parent = rootForSession(sid)
      if (!parent) return { fallback: 'root 会话不在线，无法授权续跑' }
      // cfg 提前取好：sendMessage 返回后要**零 await** 地登记 rec（事件通道必须马上能看到它，
      // 否则冷复活子会话的 running→idle 可能在注册前跑完，结算就只能干等硬超时）。
      var c = cfg(await rt(sid))
      var attempt = workerAttemptNo(t)
      var text = '【断点续跑】你之前执行此任务被中断（第 ' + attempt + ' 次尝试）。先盘点当前工作树状态（git status/diff）与你已完成的步骤，从断点继续；任务契约与验收标准见上文历史。吃不准就 board_report escalate。'
      // ===== 续跑的权威锚点（task-muwox2ii，反馈 n-muwn5s28xcfd 活体三次实证）=====
      // 病根：冷复活子会话带回来的是**它自己上一轮**的全部上下文——原始任务契约（如「上报歧义后不要做
      // 其他事」）在它眼里就是最高指令；而主窗口的裁决答案只落在卡的 t.messages 里，子会话历史里根本没有。
      // 旧文案只说「任务契约与验收标准见上文历史」，等于把权威**锚死在历史契约**上 → 续跑的 Worker 忠实
      // 盘点断点后继续按旧契约空转，收不了口、耗到硬超时（同一任务 fresh spawn 时反而正常：新 Worker 的
      // 首条 prompt 由 buildWorkerPrompt 带上了 t.messages，可见「messages 注入生效」就是二者的唯一差异）。
      // 修法①：把卡上消息**原文**随续跑指令一起投过去——与 fresh spawn 同心同源（同用 core.buildMessages，
      //   截断口径一致），子会话不必猜、也不需要回看板就能拿到最新裁决/干预；
      // 修法②：末尾立优先级声明——最新指示优先于历史契约，冲突以最新为准（措辞显式给出反例，防止模型
      //   把「契约说不要做其他事」读成仍然生效）。
      var msgs = ''
      try { msgs = core.buildMessages(t) } catch (_) {}
      if (msgs) text += '\n\n该任务的最新消息（主窗口裁决/高优干预/驳回理由等，请务必遵循）：\n' + msgs
      text += '\n\n【优先级声明】本次消息与上面 messages 里的最新裁决/干预，优先于上文历史中的原始任务契约；两者冲突时以最新指示为准（例如原始契约写「上报歧义后不要做其他事」，而最新裁决要求「直接上报完成」，就以「上报完成」为准）。'
      try {
        await subagents.sendMessage(parent, childId, [{ type: 'text', text: text }], { signal: makeSignal() })
      } catch (e) {
        // NOT_RESUMABLE / 邻接校验失败 / 任何错：一律回退 fresh spawn（本函数不抛，调用方按 rec 为 null 处理）。
        return { fallback: String(e) }
      }
      var rec = { id: childId, childId: childId, continuable: true, resumed: true, ran: false, run: null, role: 'worker', taskId: t.id, startedAt: Date.now(), model: '', settled: false, baselineBytes: logSizeOf(childId) }
      runsFor(sid)[t.id] = rec
      if (!dispatchedEver[sid]) dispatchedEver[sid] = {}
      dispatchedEver[sid][childId] = true
      armTimeouts(sid, rec, t, c)
      // runs[] 追加一条**续跑记录**（role:'worker', id:childId 与原 run 同 id=同一会话, resume:true）：
      // 详情页可区分首派/续跑，且它成为续跑资格判定的最新依据。
      // 这条**必须 await**：竞速下（冷复活子会话立刻 idle）closeRunHistory 可能先落地，
      // 那会找不到条目、结局留在 running → 该 run 永久失去续跑资格。
      await recordRunHistory(sid, t.id, 'worker', childId, '', c.hardTimeoutMin, true, true)
      return { rec: rec }
    }

    // run 结算：保证收尾；工具通道（board_report/board_verdict）已推进状态的话文本路径跳过
    // ===== 结算收尾三件套（task-muwkhqf8）=====
    // 无论从哪条入口进来（事件通道 settleContinuable / 上报通道 board_report），run 记录的收尾动作
    // 必须一致：①关 run 结局（closeRunHistory）②usage 落账（seq 水位线增量）③摘除软/硬超时臂。
    // 三条各自幂等：重复结算（idle 事件重入 / 上报与事件双通道先后到达）不二次关账、不二次记账。
    async function settleRunRecord(sid, rec, opts) {
      // ① 结局落卡：failed → 有 err 记 timeout/error，无 err 记 incomplete（与一次性路径口径一致）；
      //    成功 → completed。noResume 旗随 rec.resumeBlocked（interrupt 失败）落卡。
      try {
        await closeRunHistory(sid, rec.taskId, String(rec.id), opts.outcome, rec.continuable ? { noResume: rec.resumeBlocked === true } : null)
      } catch (e) { console.error('[task-board] closeRunHistory 收尾失败 (task ' + rec.taskId + '):', String(e)) }
      // ② usage 落账：读该次 run 的 v4 日志聚合（水位线增量），累加到任务。放在状态推进之后：
      //    统计是附加信息，读日志失败/无 usage 时静默跳过，绝不影响结算语义。
      //    Worker 失败重试、驳回重做都会各走一次 settleRun，因此多轮消耗天然累加（runs 计数）。
      try { await accumulateRunUsage(sid, rec) } catch (e) { console.error('[task-board] usage 收尾失败 (task ' + rec.taskId + '):', String(e)) }
      // ③ 摘除两级超时臂：软臂不再刷假告警，硬臂不再对已结算的闲置会话补一枪 interrupt。
      try { if (typeof rec.disarm === 'function') rec.disarm() } catch (_) {}
      // ② settle 通道心跳（运行时健康自检）：三件套各自幂等且各自 catch 永不抛，
      // 走到这里即「一次成功结算活动」——rpc 侧据此判定「结算通道 >30min 无活动」黄条。
      poolHealthFor(sid).settleLastOkAt = Date.now()
    }

    async function settleRun(sid, rec, res, err) {
      if (runsFor(sid)[rec.taskId] !== rec) return // 已被 terminate 等路径处理
      delete runsFor(sid)[rec.taskId]
      // 收尾分路（卡2）：一次性 run 走 dispose（既有语义逐字不变）；continuable 走 interrupt——
      // **只打断当前 turn，不销毁子会话**（Activation/未认领收件箱/已发布后代全部保留），
      // idle 后仍可被 sendMessage 冷复活，这正是重派续跑的前提。
      try {
        if (rec.continuable) await endContinuable(sid, rec)
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
      // 历史会话留档 + usage + 超时臂收尾：三件套抽到 settleRunRecord（上报通道共用同一实现）。
      // 结局同时是**续跑资格**的唯一依据（continuable + timeout/error|incomplete → 下次重派改续跑），
      // noResume 旗（interrupt 失败）一并落卡，让重派直接回退 fresh spawn。
      // ⚠️ 位置在状态推进**之后**：rec.resumeBlocked 由 endContinuable 在推进前写好，这里读到的才是终值。
      await settleRunRecord(sid, rec, { outcome: failed ? (err ? 'timeout/error' : 'incomplete') : 'completed' })
    }

    // ===== 可续跑 Worker 的 turn 结算（task-muw5gnhv 卡1；卡2 加续跑基线）=====
    // 与一次性路径的关系：任务推进语义**完全复用** settleWorker（board_report 工具优先、文本兜底同构），
    // 差别只在「怎么知道 turn 完了」与「怎么收尾」：
    //   · 一次性：run.result 落定 → settleRun(res,err)（有结构化结果/失败原因）；
    //   · continuable：没有 run.result，只能靠 host 事件 agent/status 的 running→idle 观测 turn 结束
    //     （见 onAgentStatus）。因此这里没有 res：输出文本从子会话 v4 日志尾部的 assistant/message 兜底读；
    //     日志读不到且文本为空时按失败结算（走 pending 重试），**绝不当成「空完成」推进到 verifying**——
    //     否则一次「没跑起来就 idle」的事件会把任务误判为有交付物。
    // 收尾三件套（关 run 结局 / usage 落账 / 摘超时臂）不在本函数里单独写一遍，而是随 settleRun →
    // settleRunRecord 一起做——它与上报通道（board_report → settleReportedRun）共用同一实现
    // （task-muwkhqf8）：两条入口只是「谁来触发」，收尾口径必须只有一套。
    async function settleContinuable(sid, rec) {
      if (runsFor(sid)[rec.taskId] !== rec) return // 已被 terminate/硬超时等路径认领
      var text = ''
      // 续跑轮（rec.baselineBytes>0）只读基线之后的字节：本轮没写东西就是空文本 → 按失败重排，
      // 不会把上一轮（被中断那次）残留的助手文本冒充成本轮交付物（同一条失败臂，语义不变）。
      try { text = childSessionOutput(rec.childId, rec.baselineBytes) } catch (e) { console.error('[task-board] continuable 输出读取失败 (' + rec.childId + '):', String(e)) }
      if (!text.trim()) console.error('[task-board] continuable child ' + rec.childId + ' idle 但未读到 assistant 文本，按失败结算（任务 ' + rec.taskId + '）')
      await settleRun(sid, rec, { output: [{ type: 'text', text: text }], stopReason: text.trim() ? 'completed' : 'error' }, null)
    }

    // continuable 子会话的收尾（卡2：**interrupt 留存，不销毁**）——
    // 失败/硬超时结算时只发一个取消信号打断当前 turn：Activation、未认领的收件箱、已发布后代全部保留，
    // 子会话 idle 后仍能被 sendMessage 冷复活（Step2 续跑的前提）；一次性路径的 dispose 不动。
    // authority 形状取 dsh-subagent 的 SubagentInterruptAuthority：{kind:'ancestor', agent: 活的直接父 Agent}；
    // 该调用同步 fire-and-return（发完取消信号即返回，目标可能到下一个可观察点才真正停下）。
    // interrupt 失败（会话已死 / 权限不符 / 宿主无此能力）→ **绝不阻断结算**：任务照常回 pending 重排；
    // 只给 rec 立 resumeBlocked 旗 → 该 run 落 noResume 标记，重派时直接 fresh spawn（不空唤醒、不卡死）。
    async function endContinuable(sid, rec) {
      if (!rec || !rec.childId) return rec
      var subagents = ctx.subagents
      if (!subagents || typeof subagents.interrupt !== 'function') return rec
      var parent = rootForSession(sid)
      if (!parent) { rec.resumeBlocked = true; return rec }
      try {
        subagents.interrupt(rec.childId, { kind: 'ancestor', agent: parent })
      } catch (e) {
        rec.resumeBlocked = true
        console.error('[task-board] interrupt 失败，该子会话不再续跑（重派回退 fresh spawn）child ' + rec.childId + ':', String(e))
      }
      return rec
    }

    // 读子会话 v4 日志尾部的助手文本（continuable 路径的文本兜底通道）：
    // 与 rpc.mjs agent-activity 同一套 helper/事件形状（assistant/message.content[].text），
    // 只是这里要的是**最后一条完整助手文本**（供 settleWorker 解析分段格式 / [ESCALATE]）。
    // 只读尾部 2MB：回复在末尾，整份读大日志会拖慢结算路径；读不到一律返回 ''（调用方按失败处理）。
    // minBytes > 0（续跑轮）：只读文件该偏移之后的字节——帧从新到旧，切在半帧上的那一帧由
    // readLogFrames 逐帧 catch 降级丢弃；本轮没产出任何助手文本就返回 ''（走「空文本按失败」）。
    function childSessionOutput(childId, minBytes) {
      if (!childId) return ''
      // 与 logSizeOf/readRunUsage 同源：显式带上 sessionsRoot（生产注入 undefined → 回退 os.homedir()，
      // 与本次改造前逐字一致；单测注入临时目录时才读得到真日志——此前漏传会让「文本兜底」这一路永远读空）。
      var log = findRunLog(childId, sessionsRoot)
      if (!log) return ''
      var tail = 2 * 1024 * 1024
      if (typeof minBytes === 'number' && minBytes > 0) {
        var sz = 0
        try { sz = statSync(log).size || 0 } catch (_) { sz = 0 }
        if (sz <= minBytes) return '' // 续跑基线之后一个字节都没写 → 本轮没有交付物
        tail = sz - minBytes
      }
      var buf = readLogBytes(log, tail)
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

    // ===== usage 增量水位线（卡3 Step1）：这一轮该从哪个 seq 之后继续累加 =====
    // 读同一 rec.id 的历史 runs 条目上落的水位线（runs[i].usageSeq = 上次结算时该会话日志的 maxSeq）。
    // 为什么锚在 runs 条目而不是内存表：重启后内存表清零而卡上留档还在，续跑轮才能接着上次水位；
    // 且同一 childId 的多次派发各占一条 runs（resume 轮追加新条目），水位随条目天然分段、互不串账。
    // ⚠️ 倒序找到「同 id 的条目」还不能停：**续跑轮的新条目与旧条目同 id**（同一会话），新条目此时
    // 还没结算过、usageSeq 未设——必须继续往前找第一条**已结算过**（usageSeq > 0）的条目，否则水位线
    // 恒为 0 → 每轮都把整份日志重算一遍（本实现踩过的坑，实测总量双倍 25 而非 15）。
    // 一条都没有（首次结算 / 手写裁剪过的老任务）→ 0 = 全量累加（与本次改造前逐字一致）。
    function seekSeqOf(snap, taskId, runId) {
      try {
        var tasks = (snap && snap.tasks) || []
        for (var ti = 0; ti < tasks.length; ti++) {
          var t = tasks[ti]
          if (!t || t.id !== taskId || !Array.isArray(t.runs)) continue
          for (var ri = t.runs.length - 1; ri >= 0; ri--) {
            var r = t.runs[ri]
            if (!r || String(r.id) !== String(runId)) continue
            var w = num0(r.usageSeq)
            if (w > 0) return w
          }
        }
      } catch (_) {}
      return 0
    }
    // 水位线字段兜底成非负数字（脏值/老形态一律当 0 = 全量，宁可多记也不误丢）
    function num0(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0 }

    // 该 run 记录是否已落过 usage（usageRecorded 旗）：倒序找同 id 的条目，见旗即真。
    // 判据为什么要**同一 childId 复用**（而不是只认最新条目）：continuable 的续跑轮与首轮共用同一个
    // 子会话 id，closeRunHistory 会把每一轮的条目都更新成终局——「最新那条」在续跑轮结算时正是本轮
    // 新建的那条（usageRecorded 未置，照常记账）。真重复结算（事件通道与上报通道都来/上报后 idle 补到）
    // 时最新条目就是那份已记账的旧条目 → 见旗即跳过。两处语义互斥，同一判据够用，不需要另立新字段。
    function hasUsageRecorded(snap, taskId, runId) {
      try {
        var tasks = (snap && snap.tasks) || []
        for (var ti = 0; ti < tasks.length; ti++) {
          var t = tasks[ti]
          if (!t || t.id !== taskId || !Array.isArray(t.runs)) continue
          for (var ri = t.runs.length - 1; ri >= 0; ri--) {
            var r = t.runs[ri]
            if (!r || String(r.id) !== String(runId)) continue
            return r.usageRecorded === true // 同 id 的最新条目就是本轮该结算的那条
          }
        }
      } catch (_) {}
      return false
    }

    // 把一次 run 的 token 消耗累加到任务（t.usage）：总量/输入/输出/缓存读写 + 按模型小计 + runs 计数 + 日账。
    // 模型小计的 key：优先本次派发显式覆盖的模型（rec.model），否则用日志里记录的会话模型。
    // 日账（byDay）：本次 run 整笔记到「结算时刻的本地日」——一次 run 不跨日拆分
    // （跨零点的长 run 全算在结算日），换取实现极简与仪表盘「今日 / 近 7 天」可算。
    // 双指标形态：byDay[day] = { t: total, e: effective }（e 是有效消耗，不含缓存读）。
    // 老数据（number 形态，本轮之前落的日账）只在聚合端兼容：读侧按 { t: n, e: null } 处理，
    // e 不可知就置 null（宁可展示上标 ~ 近似，也不伪造一个「有效值」）。
    // 增量口径（卡3 Step1）：结算前先读一次看板取该 run 的历史水位线（seekSeqOf），只把这之后的
    // assistant/message 增量计入；累加时把本份日志的 maxSeq 一并落到该 runs 条目上（下一轮从这继续）。
    // one-shot 路径（每 run 独立日志、永远找得到自己的条目且首次无水位）→ 行为逐字不变：全量累加一次。
    async function accumulateRunUsage(sid, rec) {
      var u = null
      var since = 0
      try {
        var snap0 = await rt(sid)
        since = seekSeqOf(snap0, rec.taskId, rec.id)
        // 幂等（task-muwkhqf8）：该条 run 记录已落过账 → 直接跳过。为什么需要它：continuable 的 run 现在有
        // 两条结算入口（事件通道 + board_report 上报通道），且两条可能在「先读到快照、后持锁写」的窗口里
        // 交错——只靠水位线挡不住同一次结算被记两笔（两次都读到同一旧快照）。旗与累加在同一持有锁回调里
        // 写，读序天然串行。判据只看**同 id 的最新条目**（见 hasUsageRecorded：续跑轮新条目未置旗，照常记账）。
        if (hasUsageRecorded(snap0, rec.taskId, rec.id)) return
        u = readRunUsage(String(rec.id), sessionsRoot, since)
      } catch (_) { u = null }
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
          // 置位 usageRecorded = 该条 run 已落账（幂等旗，见函数头注释与 hasUsageRecorded）：
          // 与累加同一次持有锁写，读侧据此挡住「同一结算被两条入口各记一笔」。
          if (Array.isArray(t.runs)) {
            for (var ri = t.runs.length - 1; ri >= 0; ri--) {
              if (String(t.runs[ri] && t.runs[ri].id) === String(rec.id)) {
                t.runs[ri].usage = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, total: u.total || 0 }
                // 水位线落卡（卡3 Step1）：本份日志已结算到 maxSeq；续跑轮再结算时只认这之后的帧。
                // 只增不减（max 收敛）：异常情况下读到较小值也不让水位倒退（倒退＝把已结算帧再记一遍）。
                t.runs[ri].usageSeq = Math.max(num0(t.runs[ri].usageSeq), num0(u.maxSeq))
                t.runs[ri].usageRecorded = true
                // 模型补落账（task-muxhshfu 记分卡卡1①）：派发未显式覆盖模型时条目 model=''，
                // 而日志 request/context 里记着真实模型（u.model，与任务级 u.models 小计同源）——
                // 结算时顺手回填，记分卡卡2 的「模型×场景」聚合就不必再走按任务级占比摊派的近似路径。
                // 只填空不覆盖：派发显式覆盖的模型名优先（aggregateUsageSummary 模型 key 同一优先序）。
                if (!t.runs[ri].model && u.model) t.runs[ri].model = String(u.model)
                break
              }
            }
          }
          t.usage.updatedAt = new Date().toISOString()
          return { ok: true }
        })
      } catch (e) { console.error('[task-board] usage accumulate failed (task ' + rec.taskId + '):', String(e)) }
    }

    // ===== 上报通道结算入口（task-muwkhqf8 回归修复的第二条入口）=====
    // 病根：continuable Worker 的 run 记录此前**只有事件通道**会收尾（agent/status 的 running→idle →
    // settleContinuable → settleRun）。但 Worker 通过 board_report 工具上报完成时，任务状态已被工具通道
    // 推进到 verifying/resolved——此时若该 turn 的 idle 事件没被观测到（rec.ran 二次守卫挡下的伪 idle、
    // 驱动未接上的冷窗口、宿主重启、idle 事件丢失），run 记录就永久停在 outcome='running'：
    //   ① 软超时臂对它误报（实证：已完成的 run 收到「worker 已运行 30 分钟仍未完成」）；
    //   ② usage 不落账（仪表盘漏计这轮消耗）；
    //   ③ 硬超时臂到期还对一条早已结算的闲置会话补一枪 interrupt（噪音 + 误导）。
    // 解法：board_report/board_verdict 把任务推进到落定态（verifying/resolved）时，顺带调本函数——
    // 对**该任务当前的 continuable Worker rec**补做收尾三件套（关 run 结局 / usage 落账 / 摘超时臂），
    // 与事件通道共用 settleRunRecord（同一实现，杜绝两条路各写一套口径）。
    // 三点边界：
    //   · 只认 continuable 且 role==='worker' 的活跃 rec：verifier/hook 是一次性 run。它们的 run.result
    //     落定后 settleRun 会照常收尾；手动终止路径**刻意**不关 run（保留 running = 不留续跑资格），此处不碰。
    //   · 摘除活跃表项：任务已落定，这张卡不该再占 Worker 并发位；否则 poolCycle 的 activeW 会把它算成
    //     在跑的 Worker（幽灵占位）。子会话本身不销毁也不 interrupt——它与手动终止同源：失联的续跑资格
    //     留在卡上，之后真要重派走 tryResumeWorker 的 sendMessage 冷复活。
    //   · 幂等：closeRunHistory 只关 outcome==='running' 的条目、accumulateRunUsage 认 usageRecorded 旗、
    //     rec.disarm 幂等——重复上报 / 上报后 idle 事件补到，都不会二次关账或二次记账。
    // 老宿主/没接线的调用方：deps 里没有这个函数时 rpc 侧静默跳过，行为与本次改造前逐字一致。
    async function settleReportedRun(sid, taskId, opts) {
      var rec = runsFor(sid)[taskId]
      if (!rec || !rec.continuable || rec.role !== 'worker') return false
      if (runsFor(sid)[rec.taskId] !== rec) return false
      delete runsFor(sid)[rec.taskId] // 与 settleRun 同口径：先摘活跃表项，堵住并发重入
      rec.settled = true
      await settleRunRecord(sid, rec, { outcome: (opts && opts.outcome) || 'completed' })
      return true
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
        // 身份来源修正（2026-10-06 热修，活体实证）：dsh-agent 的 Agent 接口**没有 id 字段**——
        // 被驱动的会话才是身份（agent.session.id）。此前读 agent.id 恒 undefined → cid='' 早退，
        // 事件结算通道从卡1上线起从未真正触发（所有结算全靠 run.result / board_report 通道顶着）。
        // agent.id 作兜底保留（防未来内核补上该字段时形状分叉）。
        var cid = agent ? String((agent.session && agent.session.id) || agent.id || '') : ''
        if (!cid) return
        var table = state.activeRuns
        // 事件按会话 id 命中活跃 rec：continuable rec 的 childId 就是子会话 id（= agent.session.id），
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
        // 自测指南落账（verifyUserGuide 开关门禁，task-muxyyvg0）：开关开且解析出「## 自测指南」段才挂
        // userTest；缺段/开关关 → 字段不挂（client 详情块与报告「本版自测清单」段整块不渲染）
        if (cfg(d).verifyUserGuide !== false && vsecs.userTest) t.verification.userTest = vsecs.userTest
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

    // ===== 重启 reconcile（卡3 Step2）：host 重启后把活跃 continuable Worker 的观测重新挂回来 =====
    // 问题：continuable Worker 的 rec 只活在内存（state.activeRuns）——host 重启把它清零，而子会话
    // 本身是**持久子会话**，可能正跑得好好（或刚跑完一轮）。此时任务停在 in-progress 却没人认领：
    // 既不会被 agent/status 结算（表里没 rec），又不会被孤儿回收（isOrphan 的 2 分钟门槛＋它确实
    // 有 claimedBy），只能干等——重启一次就白挂一个 Worker 位。
    // 解法（一次，per host 生命周期）：对本会话板上「in-progress 且无活跃 rec」的任务查 listChildren(root)，
    //   · 该 childId 仍在列 → 判定存活：重建 rec 观测（agent/status 监听本来就在，登记即可续上），
    //     基线取**当前日志字节数**（重启前那轮的产出已落盘，不该冒充重启后的新交付物），重挂两级超时臂；
    //   · 不在列 → 会话已死：走「硬超时等价物」——失败结算的等价动作（回 pending 重排 + 留历史），
    //     不占用 Worker 并发位，等下一轮 poolCycle 正常重派（续跑资格由卡上 runs 留档决定）。
    // 三道门禁：①只对 role=worker + continuable + 结局停在 running 的 run（一次性 run 没有可找回的会话）；
    // ②per host 生命周期只做一次（state.reconcileDone）——重复做会把用户手动终止的卡又挂回去；
    // ③listChildren 不可用（老宿主/测试桩）→ 整段跳过，行为逐字不变。
    // 已知边界（有意不做，交给既有机制）：重启**之后**才被中断的那一轮，reconcile 追不回它的结局——
    // 硬超时臂已在重建时重挂，到点照常结算。
    async function reconcileRoot(sid) {
      if (!state.reconcileDone) state.reconcileDone = {} // 老宿主/测试桩没建这个容器：就地补（不清空已有标记）
      if (state.reconcileDone[sid]) return
      state.reconcileDone[sid] = true
      var subagents = ctx.subagents
      if (!subagents || typeof subagents.listChildren !== 'function') return
      var runs = runsFor(sid)
      var snap = null
      try { snap = await rt(sid) } catch (_) { return }
      // 候选：in-progress + 在跑占位已换成真实 run id + 无活跃 rec + 最后一条 worker run 是 continuable
      // 且结局仍停在 running（已落 timeout/error 的卡由重派路径自己处理，不在此处抢跑）。
      var cands = []
      var list = (snap && snap.tasks) || []
      for (var i = 0; i < list.length; i++) {
        var t = list[i]
        if (!t || t.status !== 'in-progress' || t.escalation) continue
        if (runs[t.id]) continue
        if (!t.claimedBy || t.claimedBy === 'spawn-pending') continue
        if (resumeTarget(t) !== '') continue // 结局已落超时/失败 → 归重派续跑路径，reconcile 不掺和
        var last = null
        var trs = Array.isArray(t.runs) ? t.runs : []
        for (var ri = trs.length - 1; ri >= 0; ri--) { if (trs[ri] && trs[ri].role === 'worker') { last = trs[ri]; break } }
        if (!last || last.continuable !== true || last.outcome !== 'running') continue
        if (String(last.id) !== String(t.claimedBy)) continue // 卡上留档与占位不一致：状态可疑，不动
        cands.push(t)
      }
      if (!cands.length) return
      // 存活判定：listChildren 列出的就是「活的子会话」。带超时保护（查询挂死也不能拖住心跳）。
      var kids = null
      try {
        var q = subagents.listChildren(sid)
        kids = (typeof withTimeout === 'function') ? await withTimeout(q, 5000, 'reconcile listChildren') : await q
      } catch (e) {
        console.error('[task-board] reconcile listChildren 失败（本轮跳过，卡片留在 in-progress 等人工处理）:', String(e))
        return
      }
      var alive = {}
      var kidList = Array.isArray(kids) ? kids : []
      for (var k = 0; k < kidList.length; k++) {
        var c = kidList[k]; if (!c) continue
        var cid = String(c.sessionId || c.id || '')
        if (cid) alive[cid] = true
      }
      var c2 = cfg(snap)
      var found = 0, lost = 0
      for (var ci = 0; ci < cands.length; ci++) {
        var tc = cands[ci]
        var childId = String(tc.claimedBy)
        if (alive[childId]) {
          // ① 存活：重建 rec（与 spawnOneShot 的 continuable 形态逐字同构）→ 重挂两级超时臂。
          //    ran:false —— 重启前的 running 事件已经错过，等下一个真 running 事件到来才允许 idle 结算
          //    （rec.ran 二次守卫的既有语义：宁可等，也不拿一个可能已在跑的会话的空文本当交付物）。
          var rec = { id: childId, childId: childId, continuable: true, restored: true, ran: false, run: null, role: 'worker', taskId: tc.id, startedAt: Date.now(), model: '', settled: false, baselineBytes: logSizeOf(childId) }
          runs[tc.id] = rec
          if (!dispatchedEver[sid]) dispatchedEver[sid] = {}
          dispatchedEver[sid][childId] = true
          armTimeouts(sid, rec, tc, c2)
          found++
          // 系统消息只留一行（重启是低频事件，且这行是「为什么它还在跑」的唯一解释来源）
          pushSysNote(sid, '任务「' + tc.title + '」的 Worker 子会话已在重启后找回（续跑观测已恢复，硬超时 ' + c2.hardTimeoutMin + ' 分钟后照常结算）', tc.id)
        } else lost++
      }
      if (found || lost) console.log('[task-board] 重启 reconcile（' + sid + '）：找回活跃续跑 Worker ' + found + ' 个，' + lost + ' 个子会话已死转回 pending')
      // ② 会话已死：硬超时等价物（失败结算的等价动作）——回 pending 重排 + 留一行 history + 落结局。
      //    放在**锁外**统一做（一次持锁批量处理，避免逐张写盘打断派发周期）。
      if (lost) {
        try {
          await mutateLocked(sid, function (d) {
            d.tasks.forEach(function (t) {
              if (t.status !== 'in-progress' || runs[t.id] || !t.claimedBy || t.claimedBy === 'spawn-pending') return
              var last = null
              var trs = Array.isArray(t.runs) ? t.runs : []
              for (var ri = trs.length - 1; ri >= 0; ri--) { if (trs[ri] && trs[ri].role === 'worker') { last = trs[ri]; break } }
              if (!last || last.continuable !== true || last.outcome !== 'running') return
              if (String(last.id) !== String(t.claimedBy) || alive[String(t.claimedBy)]) return
              var ps = t.status
              t.status = 'pending'; t.claimedBy = null; t.claimedAt = null
              t.lastError = 'host 重启后 Worker 子会话已不存在（reconcile 未找回），任务回收重排'
              last.outcome = 'timeout/error'; last.endedAt = new Date().toISOString()
              ah(t, ps, 'pending', 'system', '重启后执行会话已丢失，回收重新排队')
              return
            })
            return { ok: true }
          }, true)
        } catch (e) { console.error('[task-board] reconcile 死会话回收失败:', String(e)) }
      }
    }

    // ===== 幽灵占位回收（池冻结根修，task-muwlepg6）=====
    // 病根（活体实证）：活跃表项（rec）的**唯一**摘除点是各结算通道（事件通道 settleRun /
    // 上报通道 settleReportedRun / 手动终止）。任何一条漏走（worker 经 board_report 完成但当时
    // 还没有上报通道接线、伪 idle 被 rec.ran 守卫挡下、冷窗口、插件热重载丢回调）都会让 rec
    // 永久留在 state.activeRuns 里，而它同时是四个判定的输入：
    //   ① activeW → capW = max(0, maxWorkers - activeW)：残留数 ≥ maxWorkers 时 capW 恒 0 →
    //      **整池 Worker 自动派发全停**（实测板：5 个残留 + 1 个真在跑 → activeW=6 > maxWorkers=3 → capW=0，
    //      9 张 pending 卡一张都派不出去）；
    //   ② pickDispatch 的 busyTaskIds（= 本表）→ 该卡自己永远进不了 Verifier 派发（verifying 卡永不 spawn）；
    //   ③ isOrphan 的 !runs[t.id] → 该卡永不被孤儿回收（in-progress 死卡持着 touches 锁堵住后续卡）；
    //   ④ poolStatus 快照 → UI 上「幽灵 Worker 卡 busy」。
    // 四者叠加 = 「poolCycle 整体冻结，force dispatch-task 手动通道却正常」——手动通道
    // （rpc dispatch-task → spawnOneShot）不经 capW / busyTaskIds 闸门，故症状完全吻合。
    // 修法：不动任何结算语义，只做**表项 GC**——每轮 cycle 在算活跃度之前，用「卡面证据」核对每个 rec：
    // 卡已不存在、或卡的状态已不可能是该 rec 的在跑态（worker 不在 in-progress / verifier 不在 verifying /
    // hook 状态不是 running）、或卡的认领位已换成别的 run id → 该 rec 已失效，立刻摘除。
    // 摘除是**同步**的（先删表项，本轮 activeW/busyTaskIds 立刻干净、派发当轮恢复），随后用与两条
    // 结算通道**同一个** settleRunRecord 补一次收尾（结局 / usage / 摘超时臂，三者各自幂等）——
    // 不另立第二套口径，也不重复记账（usageRecorded 旗与「只关还开着的条目」双保险）。
    // 边界（宁少勿多，绝不动真在跑的表项）：
    //   · 卡面读不到（__noPersist 空板 / tasks 非数组）→ 整段跳过：瞬时读盘失败不能把真 Worker 当幽灵杀；
    //   · 只认卡面证据，**不认** rec.settled——settled=true 的表项可能正被结算通道认领中
    //     （onAgentStatus 先立旗、同一次同步块里才摘表项），此刻抢先摘除会让 settleRun 的认领守卫
    //     早退、把这一轮的交付物整份丢掉；
    //   · 单条判定/收尾各自 try/catch：一条脏数据只影响该条，不拖死本轮其它回收与派发。
    function recIsLive(t, rec) {
      if (!t || !rec) return false // 卡已不存在（板被重建/换工作区）→ 表项无主
      if (rec.role === 'worker') {
        // Worker 只在 in-progress 活着；claimedBy 为空 = 占位没落座/已被清（僵尸态）
        if (t.status !== 'in-progress' || !t.claimedBy) return false
        if (t.claimedBy !== 'spawn-pending' && String(t.claimedBy) !== String(rec.id)) return false // 认领位已换人（terminate 后重派）
        return true
      }
      if (rec.role === 'verifier') {
        if (t.status !== 'verifying') return false
        if (t.verifierRun && t.verifierRun !== 'spawn-pending' && String(t.verifierRun) !== String(rec.id)) return false
        return true
      }
      if (rec.role === 'hook-pre') return t.status === 'in-progress' && hookOn(t, 'pre') && t.hooks.pre.state === 'running'
      if (rec.role === 'hook-post') return t.status === 'in-progress' && hookOn(t, 'post') && t.hooks.post.state === 'running'
      // 未知角色（前向兼容）：只要卡还在跑态就留着，等卡落定后由这里回收——不在未知形态上做激进判定
      return t.status === 'in-progress' || t.status === 'verifying'
    }
    // 返回本轮摘除条数（调用方据此决定要不要重读盘——收尾写盘会让本轮快照过期）
    async function reapGhostRecs(sid, snap) {
      if (!snap || snap.__noPersist || !Array.isArray(snap.tasks)) return 0
      var runs = runsFor(sid)
      var tasks = snap.tasks
      var reaped = []
      Object.keys(runs).forEach(function (k) {
        var rec = runs[k]
        if (!rec) return
        try {
          var t = null
          for (var i = 0; i < tasks.length; i++) { if (tasks[i] && tasks[i].id === rec.taskId) { t = tasks[i]; break } }
          if (recIsLive(t, rec)) return
          delete runs[k] // 先摘表项：本轮 activeW / busyTaskIds / poolStatus 立刻不再被它污染
          try { if (typeof rec.disarm === 'function') rec.disarm() } catch (_) {} // 摘两级超时臂（幂等）
          rec.settled = true // 堵住迟到的结算通道（settleRun 的认领守卫会早退，不会二次推进任务）
          // 结局口径：卡已落定（resolved/archived/cancelled）或已交验收（verifying）→ 这轮 Worker 交付
          // 确实完成了；卡还在跑态但认领位换了人/卡丢了 → 结局不可知，记 incomplete（与一次性路径的
          // 「无 err 的失败」同口径，且据此保留续跑资格由重派路径判断）。
          var closed = t.status === 'resolved' || t.status === 'archived' || t.status === 'cancelled' || t.status === 'verifying'
          reaped.push({ rec: rec, outcome: closed ? 'completed' : 'incomplete' })
        } catch (e) { console.error('[task-board] 幽灵表项判定失败（本轮跳过该条）:', String(e)) }
      })
      if (!reaped.length) return 0
      for (var r = 0; r < reaped.length; r++) {
        try { await settleRunRecord(sid, reaped[r].rec, { outcome: reaped[r].outcome }) }
        catch (e) { console.error('[task-board] 幽灵表项收尾失败 (task ' + reaped[r].rec.taskId + '):', String(e)) }
      }
      console.log('[task-board] 回收失效活跃表项（幽灵占位）' + reaped.length + ' 个：' + reaped.map(function (x) { return String(x.rec.taskId) + '/' + String(x.rec.role) + '/' + x.outcome }).join(', '))
      return reaped.length
    }

    // ===== 派发周期（15s 心跳 + 写入后 kickCycle 触发）=====
    // 结构（池冻结防御，task-muwlepg6）：入口 root 闸门 → 读盘 → 本轮主体（poolCycleBody）整段包 try。
    // 为什么必须拆这一层：主体里任一环（reconcile / 幽灵回收 / 派发决策 / spawn / 回执）抛异常，
    // 冒泡出去就是「本轮整池零动作」；再叠上任何 latch 型守卫就是永久冻结（本次事故的形状）。
    // 这里把「整轮异常」隔离成「本轮作废、下一轮照常」。
    // 刻意**不设**再入守卫：latch 一旦漏复位就是全停且难观测；重复 cycle 由 mutateLocked 的
    // 占位 claim 原子性兜住，无需互斥。全仓唯一的 latch 是 store.kickCycle 的 cyclePending 去抖，
    // 那边用「时间戳 + 兜底复位」保证不可能恒真（见 store.mjs）。
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
      // 本轮主体整段进 try：任一环节抛异常都只作废本轮（console 留痕），下一轮心跳 / kickCycle 照常进来。
      // ① 派发循环心跳（运行时健康自检）：主体正常返回（含空闲快进早退）才算「成功跑完一轮」刷新时间戳；
      // 异常被隔离时不刷新——连续 >5min 不刷新 + 有可派卡 + 有空位 = rpc 侧亮「派发循环疑似冻结」红条。
      try {
        var cycleRet = await poolCycleBody(sid, info, runs, snap)
        poolHealthFor(sid).poolLastOkAt = Date.now()
        return cycleRet
      }
      catch (e) { console.error('[task-board] poolCycle 本轮异常（已隔离，下一轮照常）([' + sid + ']):', String(e)); return undefined }
    }
    // 本轮主体：reconcile → 幽灵占位回收 → 活跃度/上限闸门 → 持锁（回收+claim+池快照）→ 锁外 spawn。
    async function poolCycleBody(sid, info, runs, snap) {
      // 重启 reconcile（卡3 Step2）：只在本 host 生命周期的首轮 cycle 做一次（内部有 reconcileDone 标记）。
      // 位置取舍：root 闸门必须是第一件事（无活 root 的板零 IO），所以本段只能排在早退闸门与 rt 读盘之后；
      // 而重建出来的 rec 仍在本轮被读到（活跃计数 / 池状态快照都在下面才求值），语义不受影响。
      try { await reconcileRoot(sid) } catch (e) { console.error('[task-board] reconcile 失败:', String(e)) }
      // 幽灵占位回收（池冻结根修）：必须排在活跃度计数与 pickDispatch 之前——残留表项正是把 capW 拉到 0、
      // 并把卡挡在 Verifier 派发之外的元凶（见 reapGhostRecs 头注释）。收尾会写盘（结局/usage），
      // 故有回收时重读一次快照——否则下面空闲快进的 wt(snap) 会拿旧快照把收尾结果覆盖回去。
      var reapedN = 0
      try { reapedN = await reapGhostRecs(sid, snap) } catch (e) { console.error('[task-board] 幽灵占位回收失败（本轮跳过，派发照常）:', String(e)) }
      if (reapedN > 0) {
        try { snap = await rt(sid) } catch (_) {}
        // ③ 幽灵回收可视化（运行时健康自检）：本轮回收 >0 留一条一次性记录（90s 保鲜），
        // rpc get-tasks 读到即在「架构健康」区亮一条 info 并消费——幽灵回收从此在 GUI 可见。
        poolHealthFor(sid).reapNote = { n: reapedN, at: Date.now() }
      }
      var activeW = 0, activeV = 0
      // 角色口径：worker 计入 activeW（占 Worker 并发位）；verifier 与 hook run（hook-pre/hook-post）
      // 统一计入 activeV——hook run 不是 Worker，不该挤占 maxWorkers 并发位，但它确实是一条在跑的 run，
      // 必须参与「空闲快进」判定，否则 hook 跑着时重复派发的闸门会失守。
      Object.keys(runs).forEach(function (k) { var rc0 = runs[k]; if (!rc0) return; if (rc0.role === 'worker') activeW++; else activeV++ })
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
      // ===== 单点异常隔离（池冻结防御，task-muwlepg6）=====
      // 持锁段内按阶段各自 try/catch：回收/派发决策/hooks/touches 展示/池快照五段互不牵连，
      // 任一阶段或任一卡抛异常都只损失那一小段（console 留痕），回调**照样返回 d** ——
      // 保证本轮该写的池状态一定写下去（旧形状下一处异常＝整轮回调抛穿＝本轮什么都不写、
      // 连孤儿回收与池快照都白跑，且这个形状每轮重复时看起来就是「池被冻住」）。
      var toSpawn = []
      var result = await mutateLocked(sid, function (d) {
        var now = Date.now()
        // ① 孤儿回收 + 占位超时回收（逐卡兜底：单卡脏数据不中断整轮）
        try {
          d.tasks.forEach(function (t) {
            try {
              if (isOrphan(d, t, runs, now)) { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', '执行 run 已结束/丢失，回收重新排队'); pushSysNote(sid, '任务「' + t.title + '」执行 run 丢失，已回收重新排队'); info.push('reclaim ' + t.id) }
              // 派发占位超时回收（防死占位，task-muwlepg6 扩面）：占位后强杀 / spawn 中断 / 插件热重载
              // 会留下 'spawn-pending' 死占位；超 2min 一律清掉恢复可派发。覆盖面从「verifying 卡的
              // Verifier」扩到**任何卡上残留的 spawn-pending**——in-progress 史诗复用这一位做
              // hook-post 的幂等占用（原实现漏了这一半，hook-post 死占位会让史诗永久不 spawn 收口）。
              if (t.verifierRun === 'spawn-pending' && (now - new Date(t.verifierRunAt || 0).getTime()) > 120000) {
                t.verifierRun = null; delete t.verifierRunAt
                if (t.status === 'verifying') ah(t, 'verifying', 'verifying', 'system', 'Verifier 派发占位超时，回收重新排队')
                // hook-post 的幂等占用位同款清理：待跑标记置回，下一轮重新 spawn 收口
                if (t.status === 'in-progress' && t.hooks && t.hooks.post && t.hooks.post.state !== 'done') t.hooks.post.pending = true
                info.push('reclaim-verifier ' + t.id)
              }
              // hook-pre 死占位回收：state='running' 但活跃表里没有它的 rec（spawn 途中进程被杀/热重载
              // 留下的半成品）→ 超 2min 退回 idle + 待跑标记，串行闸门保持关闭待重试。判据用「无 rec」：
              // 真在跑的 hook-pre 一定在 runs 表里有 rec；首次见到这种残留（老数据无时间戳）只记时，
              // 下轮之后再判定——绝不在第一眼就把可能真在跑的 hook 拉回 idle（那会放子任务越过闸门）。
              if (t.hooks && t.hooks.pre && t.hooks.pre.state === 'running' && !runs[t.id]) {
                var preAt = new Date(t.hooks.pre.runAt || 0).getTime()
                if (!preAt) t.hooks.pre.runAt = new Date().toISOString()
                else if (now - preAt > 120000) { t.hooks.pre.state = 'idle'; t.hooks.pre.runId = null; t.hooks.pre.pending = true; info.push('reclaim-hook-pre ' + t.id) }
              }
            } catch (e) { console.error('[task-board] 回收判定失败 (task ' + (t && t.id) + '):', String(e)) }
          })
        } catch (e) { console.error('[task-board] 回收段异常（本轮跳过回收，派发照常）:', String(e)) }
        // ② 派发决策 + 占位 claim（worker 仅 auto；verifier 两种模式都跑）
        try {
          var capW = isAuto ? Math.max(0, c.maxWorkers - activeW) : 0
          var picked = pickDispatch(d, capW, Math.max(0, c.maxVerifiers - activeV), runs)
          picked.pendings.forEach(function (t) { claimApply(d, t, 'spawn-pending', 'dispatch'); if (parentKickOnDispatch(d, t)) info.push('epic-kick ' + t.parentId); toSpawn.push({ role: 'worker', t: t }); info.push('dispatch ' + t.id) })
          picked.verifs.forEach(function (t) { t.verifierRun = 'spawn-pending'; t.verifierRunAt = new Date().toISOString(); toSpawn.push({ role: 'verifier', t: t }); info.push('verify ' + t.id) })
        } catch (e) { console.error('[task-board] 派发决策异常（本轮跳过派发，池状态照常写）:', String(e)) }
        // ③ hooks=agent run：pre 闸门占用 + post 收口补 spawn（接线①③）
        // pre：候选被 pickDispatch 的 preHookGate 拦下时，本轮不派子任务——这里改 spawn hook-pre run。
        // 触发条件用状态机本身（state='idle' 即「已声明且从未跑过」，重启后从卡上原样恢复，不靠内存标记）；
        // state='running' 说明已有 hook run 在跑（幂等，同一 epic 同时最多一条），'done'/'failed' 都轮不到这里。
        // post：子任务全部了结时 core.maybeAutoCloseParent 不直接转 verifying，只置 hooks.post.pending
        // 标记；本轮在这里看到标记就 spawn hook-post run（无活跃子任务时也能被下一次心跳收走）。
        try {
          d.tasks.forEach(function (t) {
            try {
              if (hookOn(t, 'pre') && t.hooks.pre.state === 'idle' && !runs[t.id]) {
                hookSetState(t, 'pre', 'running', 'system', '派发前置 hook run')
                t.hooks.pre.runAt = new Date().toISOString() // 死占位回收的时间基准（见①）
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
            } catch (e) { console.error('[task-board] hook 闸门判定失败 (task ' + (t && t.id) + '):', String(e)) }
          })
        } catch (e) { console.error('[task-board] hook 段异常（本轮跳过 hook spawn）:', String(e)) }
        // ④ touches 文件级排他展示态：被拦候选写 t.waitingForTouches = [持有者任务id...]，
        // 未被拦/已派发/已落定的任务清除该字段（每心跳刷新的 UI 展示态，不参与任何派发逻辑，
        // 但必须显式清——只在写入时报字段会留下"锁已释放仍显示 🔒 等待"的永久误导）。
        // 持锁口径的唯一出处是 core.holdsFiles（in-progress + claimedBy / verifying 持锁；
        // resolved/cancelled/archived 即放——锁只护「正在写」的阶段，用户 2026-10-06 裁决，
        // 回调 task-muv7c8ja 的「锁持到归档」口径）。这里不做任何显式放锁动作，也不需要：
        // 锁是随任务状态现算的派生量（不存在遗留的放锁调用点），resolveApply / verifyApply
        // 把卡落到 resolved 后，下一轮 tickInProgress 15s 轮自然把等待卡放行，并顺手清掉
        // waitingForTouches（下面这段每轮显式清，不会留下"锁已释放仍显示 🔒 等待"）。
        // 「验收后-提交前」窗口期由主窗口提交纪律 + 史诗 post-hook 承接（见 core.holdsFiles 注释）。
        try {
          var waitMap = {}
          if (picked) picked.blockedTouches.forEach(function (b) { waitMap[b.id] = b.conflicts })
          d.tasks.forEach(function (t) {
            if (waitMap[t.id]) { t.waitingForTouches = waitMap[t.id]; info.push('wait-touches ' + t.id + '<-' + waitMap[t.id].join(',')) }
            else if (t.waitingForTouches) delete t.waitingForTouches
          })
        } catch (e) { console.error('[task-board] touches 展示态计算异常（本轮跳过）:', String(e)) }
        // ⑤ UI 池状态：来自活跃 run（一次性模型：没有成员名册，只有在跑的任务）。
        // hook run 也归「verifiers」区展示（同一格里都是非 Worker 的一次性 run）。
        try {
          d.poolStatus = { workers: [], verifiers: [] }
          Object.keys(runs).forEach(function (k) { var rc = runs[k]; if (!rc) return; d.poolStatus[rc.role === 'worker' ? 'workers' : 'verifiers'].push({ id: k, num: '-', busy: true, taskId: rc.taskId, runId: String(rc.id), done: 0, queueLen: 0, suspect: false, model: rc.model || '' }) })
        } catch (e) { console.error('[task-board] 池状态快照异常（本轮跳过）:', String(e)) }
        if (info.length > 0) { d.dispatchInfo = info.join('; '); d.dispatchInfoAt = new Date().toISOString() }
        else if (d.dispatchInfo && (!d.dispatchInfoAt || Date.now() - new Date(d.dispatchInfoAt).getTime() > 90000)) { delete d.dispatchInfo; delete d.dispatchInfoAt } // 瞬时通知：90s TTL 过期即清，不再永久残留
        return d
      }, true) // skipKick：poolCycle 自写不触发 kickCycle（防无限循环）

      // 锁外 spawn（慢操作）；占位 claim 已保证不会被别的 cycle 重复派发
      // ===== 占位回收统一出口（task-muwlepg6）=====
      // 四种占位各有归宿，且都是**幂等**的（只清「还是占位态」的那一格，已被真实 run id 覆写的绝不碰——
      // 那说明这一项其实派发成功了，回收动作会误杀一个真在跑的 run）。抽成一个出口是为了让
      // 「spawn 返回 null（失败）」与「spawn 之后任一环抛异常」走同一条清理路径：
      //   worker    → 回 pending（不占 Worker 并发位，等下一轮重派）；
      //   verifier  → 清 verifierRun（下轮 cycle 重试；占位不清会永远卡住 Verifier 派发）；
      //   hook-pre  → 退回 idle + 重新置待跑标记（串行闸门保持关闭，下轮自动重试）；
      //   hook-post → 清幂等占用位 + 保留待跑标记（下轮自动重试收口）。
      async function releaseSpawnPlaceholder(sid, sp, note) {
        try {
          if (sp.role === 'worker') {
            await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.status === 'in-progress' && t.claimedBy === 'spawn-pending') { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', note) }; return t }, true)
          } else if (sp.role === 'verifier') {
            await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.verifierRun === 'spawn-pending') { t.verifierRun = null; delete t.verifierRunAt }; return t }, true)
          } else if (sp.role === 'hook-pre') {
            await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.hooks && t.hooks.pre && t.hooks.pre.state === 'running') { t.hooks.pre.state = 'idle'; t.hooks.pre.runId = null; t.hooks.pre.pending = true; delete t.hooks.pre.runAt }; return t }, true)
          } else if (sp.role === 'hook-post') {
            await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t) { if (t.verifierRun === 'spawn-pending') { t.verifierRun = null; delete t.verifierRunAt } if (t.hooks && t.hooks.post && t.hooks.post.state !== 'done') t.hooks.post.pending = true }; return t }, true)
          }
        } catch (e) { console.error('[task-board] 占位回收失败 (task ' + sp.t.id + ' ' + sp.role + '):', String(e)) }
      }
      for (var k = 0; k < toSpawn.length; k++) {
        var sp = toSpawn[k]
        // 单项隔离（池冻结防御）：派发一项牵动 spawn / 落卡 / 回执多个 await，任一环抛异常都只算这一项
        // 失败——先清掉它的占位（占位不清 = 这张卡永久卡住，verifier/hook 位尤其没有任何自愈路径），
        // 然后继续 toSpawn 的其余项。旧形状下一项异常会抛穿整个循环：后面的卡全部留在 'spawn-pending'，
        // 且这一轮的 toSpawn 全废（worker 位还能靠 isOrphan 2min 回收，verifier/hook 位就真的死了）。
        try {
          var rec = null
          var resumeFallback = ''
          // ===== 重派优先走「冷复活续跑」（卡2）=====
          // 只在 Worker 角色 + workerContinuable 开（缺省）时尝试：命中「上次 continuable run 结局=超时/失败」
          // 的任务时 sendMessage 唤醒原 child（不 spawn 新会话）。不适用（null）或失败（fallback）都落到下面的
          // fresh spawn——开关关掉时这段整段短路，一次性回退路径因此逐字不变（断言⑤）。
          if (sp.role === 'worker' && c.workerContinuable !== false) {
            var rr = await tryResumeWorker(sid, sp.t)
            if (rr && rr.rec) rec = rr.rec
            else if (rr && rr.fallback) resumeFallback = rr.fallback
          }
          // 续跑失败才回退 fresh spawn：**先把说明写进任务消息再 spawn**——新 Worker 的首条 prompt 由
          // buildWorkerPrompt 从任务对象组装（含 messages），这样它自己就能看到「上一轮续跑为何没接上」，
          // 而不是只留在详情页给人事后翻账。返回的 t 是写盘后那份，直接用它 spawn。
          if (!rec && resumeFallback) {
            try {
              var noted = await mutateLocked(sid, function (d) {
                var t2 = d.tasks.find(function (x) { return x.id === sp.t.id })
                if (!t2) return null
                if (!Array.isArray(t2.messages)) t2.messages = []
                t2.messages.push({ kind: 'resume-fallback', text: '断点续跑不可用（' + String(resumeFallback).slice(0, 300) + '），已回退全新 Worker 重跑。', at: new Date().toISOString(), by: 'system' })
                return { t: t2 }
              }, true)
              if (noted && noted.t) sp.t = noted.t
            } catch (e) { console.error('[task-board] 续跑回退说明落卡失败 (task ' + sp.t.id + '):', String(e)) }
          }
          if (!rec) rec = await spawnOneShot(sid, sp.t, sp.role)
          if (rec) {
            // 成功派发计数（运行时健康自检）：续跑命中与 fresh spawn 都算一次成功派发
            var __ph = poolHealthFor(sid); __ph.dispatchOk = (__ph.dispatchOk || 0) + 1; __ph.lastDispatchAt = Date.now()
            // claim 占位换成真实 run id；verifier/hook-post run 单独记（claimedBy 保留 worker 的，供详情页跳转会话）
            await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t) { if (sp.role === 'worker' && t.claimedBy === 'spawn-pending') t.claimedBy = String(rec.id); if ((sp.role === 'verifier' || sp.role === 'hook-post') && t.verifierRun === 'spawn-pending') { t.verifierRun = String(rec.id); t.verifierRunAt = new Date().toISOString() }; if (sp.role === 'hook-pre' && t.hooks && t.hooks.pre) t.hooks.pre.runId = String(rec.id) }; return t }, true)
            // 派发即回执：spawn 真成功后才入队（占位阶段失败不通知）；经 deps 注入，未注入静默跳过（老 host 兼容）
            // 回执开关（设置区「通知」）：notifyDispatch=false → 派发回执整条跳过（spawn 照常，只闭嘴）；
            // 闸门读本轮 poolCycle 已取的 cfg 快照 c（无额外读盘），老看板缺字段 → cfg 归一为 true。
            if (c.notifyDispatch !== false && typeof notifyDispatched === 'function') notifyDispatched(sid, sp.t, sp.role)
          } else if (sp.role === 'worker') {
            // spawn 失败 → 回 pending
            await releaseSpawnPlaceholder(sid, sp, 'spawn 失败，回收重新排队')
            pushSysNote(sid, '任务「' + sp.t.title + '」Worker 启动失败，已重新排队')
          } else if (sp.role === 'verifier') {
            // verifier spawn 失败 → 清占位，下轮 cycle 重试（占位不清会永远卡住派发）
            await releaseSpawnPlaceholder(sid, sp, 'spawn 失败')
            pushSysNote(sid, '任务「' + sp.t.title + '」Verifier 启动失败，下轮自动重试')
          } else if (sp.role === 'hook-pre') {
            // hook-pre spawn 失败 → 退回 idle + 重新置待跑标记，下轮自动重试（串行闸门保持关闭）
            await releaseSpawnPlaceholder(sid, sp, 'spawn 失败')
            pushSysNote(sid, '史诗「' + sp.t.title + '」前置 hook 启动失败，下轮自动重试')
          } else if (sp.role === 'hook-post') {
            // hook-post spawn 失败 → 清幂等占用 + 保留待跑标记，下轮自动重试
            await releaseSpawnPlaceholder(sid, sp, 'spawn 失败')
            pushSysNote(sid, '史诗「' + sp.t.title + '」收口 hook 启动失败，下轮自动重试')
          }
        } catch (e) {
          console.error('[task-board] 派发单项异常（已回收占位，继续本轮其余项）(task ' + sp.t.id + ' ' + sp.role + '):', String(e))
          await releaseSpawnPlaceholder(sid, sp, 'spawn 异常，回收重新排队')
          try { pushSysNote(sid, '任务「' + sp.t.title + '」' + sp.role + ' 派发异常，已回收占位待重派') } catch (_) {}
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
    ctx.effect(function () { return function () { Object.keys(state.activeRuns).forEach(function (psid) { var rr = state.activeRuns[psid]; Object.keys(rr).forEach(function (k) { try { var r0 = rr[k]; if (r0 && r0.run) r0.run.dispose(); if (r0) r0.settled = true } catch (_) {} ; delete rr[k] }) }); state.activeRuns = {}; state.reconcileDone = {} } })
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

    return { poolCycle: poolCycle, spawnOneShot: spawnOneShot, accumulateRunUsage: accumulateRunUsage, settleReportedRun: settleReportedRun, readContextPack: readContextPack }
}
