// dsh-agent-board — 派发引擎（lib/dispatch.mjs）
// createDispatch(ctx, state, deps)：一次性子代理 spawn/结算（软+硬两级超时）/ run 历史留档 /
// token 消耗累加 / poolCycle 派发周期（孤儿回收+占位 claim+池快照）/ 15s 心跳 / 插件卸载清理 /
// Team 模式 systemPrompt 引导段 / 预研文件上下文注入通道（packByChild + pendingPacks 首轮竞速认领）。
import * as core from './core.mjs'
import { readRunUsage } from './usage.mjs'
import { TEAM_SPLIT_RULE, pushRejectLesson } from './policy.mjs'
const { ah, cfg, claimApply, resolveApply, verifyApply, parseSections, outputText, pickDispatch, isOrphan, buildWorkerPrompt, buildVerifierPrompt, buildContextPackSection, parseAnchorPath, sliceLines, buildFileOutline, parentKickOnDispatch, LESSON_RECALL_HINT } = core

export function createDispatch(ctx, state, deps) {
    const fs = ctx.fs
    var rt = deps.rt, wt = deps.wt, mutateLocked = deps.mutateLocked, kickCycle = deps.kickCycle
    var rootForSession = deps.rootForSession, sessionCwd = deps.sessionCwd, withTimeout = deps.withTimeout, runsFor = deps.runsFor, feedbackOn = deps.feedbackOn
    var pushSysNote = deps.pushSysNote, maybeNotify = deps.maybeNotify, notifyTaskDone = deps.notifyTaskDone
    // 共享状态别名（本体由 index.mjs apply 统一构建并逐模块注入）
    var dispatchedEver = state.dispatchedEver
    var badModels = state.badModels
    var packByChild = state.packByChild
    var pendingPacks = state.pendingPacks
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

    // 主窗口预研文件：t.context.files 里的路径由主 agent 选择性指定（它调研时读过哪些文件），
    // host 在派发时从磁盘读最新内容注入 prompt——Worker/Verifier 不用从零重复调研。
    // 上限：单文件 8KB、总计 40KB，超出截断并标注。
    // 相对路径的解析根必须是「该会话的工作区」（root agent 的 session.header.cwd），
    // 不能靠进程 cwd——dsh web 从家目录启动时相对路径会解析到 ~/.dsh 之外的家目录下，
    // 全部读成「读取失败」（v0.1.7 实测：dsh-notes-plugin/... → C:\Users\<user>\dsh-notes-plugin）。

    async function readContextPack(sid, t) {
      var paths = (t.context && Array.isArray(t.context.files)) ? t.context.files : []
      var notes = (t.context && typeof t.context.notes === 'string') ? t.context.notes : ''
      if (!paths.length && !notes.trim()) return ''
      var cwd = sessionCwd(sid)
      var out = [], total = 0
      for (var i = 0; i < paths.length && total < 40960; i++) {
        var p = String(paths[i] || '')
        if (!p) continue
        // 锚点行段语法：'path:L2350-L2420' / 'path:L2350'（看板反馈 n-musaoirgsigo ②）
        // 盘符冒号不会被误判（parseAnchorPath 只认尾部 :L<num>）；展示路径保留原始写法。
        var anchor = parseAnchorPath(p)
        try {
          var full = await fs.readText(await fs.resolve(anchor.file, cwd ? { cwd: cwd } : undefined))
          var content = full, truncated = false, meta = '', outline = null
          var anchorFrom = null // 锚点段起点（预算二次截断时换算注入末行用）
          if (anchor.from != null) {
            var seg = sliceLines(full, anchor.from, anchor.to)
            if (seg.invalid) {
              // 段超范围 → 回退头部注入并标注（调用方写明锚点意图，Worker 可据此换锚点重读）
              meta = '锚点 L' + anchor.from + (anchor.to != null ? '-L' + anchor.to : '') + ' 无效（共 ' + seg.totalLines + ' 行），已回退头部'
            } else {
              content = seg.text
              anchorFrom = seg.injectedFrom
              meta = '锚点行段：共 ' + seg.totalLines + ' 行，已注入 L' + seg.injectedFrom + '–L' + seg.injectedTo + (seg.capped ? '（超 400 行段长上限）' : '')
            }
          } else if (anchor.invalidAnchor) {
            meta = '锚点写法无效，已回退头部'
          }
          // 预算口径不变：单文件 8KB、总计 40KB（锚点段同样计入）
          if (content.length > 8192) { content = content.slice(0, 8192); truncated = true }
          if (total + content.length > 40960) { content = content.slice(0, 40960 - total); truncated = true }
          if (truncated) {
            // 截断标注升级（①）：从「（截断）」升级为「共 N 行，已注入 X–M 行」
            var gotLines = content ? content.split('\n').length : 0
            if (anchorFrom != null) {
              meta += '；预算截断到 L' + (anchorFrom + gotLines - 1)
            } else {
              var totalLines = full.split('\n').length
              meta += (meta ? '；' : '') + '截断：共 ' + totalLines + ' 行，已注入 1–' + gotLines + ' 行'
              // 结构索引（①④）：头部注入被截断时附上，Worker 可照索引用锚点语法直读目标段
              outline = buildFileOutline(full)
            }
          }
          var entry = { path: p, content: content, truncated: truncated }
          if (meta) entry.meta = meta
          if (outline && outline.length) entry.outline = outline
          out.push(entry)
          total += content.length
        } catch (e) {
          out.push({ path: p, content: '[读取失败: ' + String(e).slice(0, 120) + ']', truncated: false })
        }
      }
      return buildContextPackSection(out, notes.slice(0, 8000))
    }

    // 预研文件注入通道：内容不混进 user prompt，而是通过 systemPrompt.context 以「上下文注入」
    // 区块呈现（与 skill-catalog 等系统注入同形态）。
    // 首轮竞速：子代理的首次 prompt 组装发生在 subagents.start() 返回之前，packByChild 还没写入
    // → spawn 前把 pack 放进 pendingPacks，provider 按父子归属（isOwnedBy 父 agent）即时认领。
    // packByChild / pendingPacks 容器本体在 state（见上方别名）

    // 历史会话留档：t.runs = [{ role, id, at, model, outcome, endedAt }]，上限 20 条
    // 目的：任务流转到 resolved/archived 后，详情页仍能选择跳转到任一历史阶段的会话
    // （Worker 首次/重试、Verifier 各次），而不是只剩最后一次 run id。
    async function recordRunHistory(sid, taskId, role, runId, model, hardMin) {
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t) return
          if (!Array.isArray(t.runs)) t.runs = []
          t.runs.push({ role: role, id: runId, at: new Date().toISOString(), model: model || '', outcome: 'running', hardMin: hardMin || 120 })
          if (t.runs.length > 20) t.runs = t.runs.slice(-20)
        })
      } catch (e) { console.error('[task-board] recordRunHistory failed:', String(e)) }
    }
    async function closeRunHistory(sid, taskId, runId, outcome) {
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t || !Array.isArray(t.runs)) return
          for (var i = t.runs.length - 1; i >= 0; i--) {
            if (t.runs[i].id === runId) { t.runs[i].outcome = outcome; t.runs[i].endedAt = new Date().toISOString(); break }
          }
        })
      } catch (e) { console.error('[task-board] closeRunHistory failed:', String(e)) }
    }

    async function spawnOneShot(sid, t, role) {
      var subagents = ctx.subagents; if (!subagents) return null
      var parent = rootForSession(sid); if (!parent) { console.error('[task-board] no root agent for session ' + sid + ', skip spawn'); return null }
      var providerName = pickProvider(); if (!providerName) { console.error('[task-board] no subagent provider'); return null }
      var modelOverride = ''
      var dsnap = await rt(sid)
      if (role === 'verifier') { modelOverride = (typeof dsnap.verifierModel === 'string' && dsnap.verifierModel.trim()) ? dsnap.verifierModel.trim() : ''; if (modelOverride && badModels[modelKey(sid, modelOverride)]) { console.error('[task-board] model ' + modelOverride + ' circuited, using parent model'); modelOverride = '' } }
      else if (role === 'worker') { modelOverride = (typeof dsnap.workerModel === 'string' && dsnap.workerModel.trim()) ? dsnap.workerModel.trim() : ''; if (modelOverride && badModels[modelKey(sid, modelOverride)]) { console.error('[task-board] model ' + modelOverride + ' circuited, using parent model'); modelOverride = '' } }
      var pack = ''
      try { pack = await readContextPack(sid, t) } catch (e) { console.error('[task-board] context pack read failed:', String(e)) }
      // user prompt 只留一行指引，内容走上下文注入区块
      var packNote = pack ? '本任务附带主窗口预研文件，已通过「上下文注入」区提供（含文件完整内容），直接基于其内容工作，不要重复读取这些文件。' : ''
      var req = { label: role + ':' + t.id, prompt: [{ type: 'text', text: role === 'worker' ? buildWorkerPrompt(t, packNote, cfg(dsnap).feedbackEnabled) : buildVerifierPrompt(t, packNote) }], parent: parent, signal: makeSignal() }
      if (modelOverride) {
        // list-models 返回的 id 是 "provider/model" 复合格式（如 "cmss/zhanlu/glm-5.2"），
        // 但 AgentOptions 的 provider 和 model 是分开的——整串塞进 model 会报 UNKNOWN_MODEL
        var slash = modelOverride.indexOf('/')
        if (slash > 0) req.agentOptions = { provider: modelOverride.slice(0, slash), model: modelOverride.slice(slash + 1) }
        else req.agentOptions = { model: modelOverride }
      }
      var run
      var ppEntry = pack ? { pack: pack, parent: parent, at: Date.now() } : null
      if (ppEntry) pendingPacks.push(ppEntry)
      try { run = await subagents.start(providerName, req) } catch (e) {
        if (modelOverride) { console.error('[task-board] model override failed, fallback to parent model:', String(e)); delete req.agentOptions; try { run = await subagents.start(providerName, req) } catch (e2) { console.error('[task-board] spawn ' + role + ' failed:', String(e2)); return null } }
        else { console.error('[task-board] spawn ' + role + ' failed:', String(e)); return null }
      } finally {
        if (ppEntry) { var ppi = pendingPacks.indexOf(ppEntry); if (ppi >= 0) pendingPacks.splice(ppi, 1) }
      }
      var c = cfg(dsnap)
      var rec = { run: run, role: role, taskId: t.id, startedAt: Date.now(), model: modelOverride, settled: false }
      runsFor(sid)[t.id] = rec
      if (pack) packByChild[String(run.id)] = pack
      if (!dispatchedEver[sid]) dispatchedEver[sid] = {}
      dispatchedEver[sid][String(run.id)] = true
      // 历史会话留档：每次派发都追加一条 {role,id,at,model}，任务完成后仍可回看
      // 各阶段（含重试的第 1/2/3 次 Worker）会话——否则 claimedBy/verifierRun 只留最后一次
      recordRunHistory(sid, t.id, role, String(run.id), modelOverride, c.hardTimeoutMin).catch(function () {})
      // ===== 两级超时：软超时只提醒主窗口（由人决定继续等待或终止），硬超时兜底 dispose =====
      // 一次性 run 没有看门狗：完全依赖人工决策时，人不在线挂死的 run 会永久占用并发位，
      // 所以保留硬上限作为最后防线（默认 120min，可配置）。
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
      withTimeout(run.result, hardMs, role + ':' + t.id).then(function (res) { finish(res, null) }).catch(function (e) { finish(null, e) })
      return rec
    }

    // run 结算：保证 dispose；工具通道（board_report/board_verdict）已推进状态的话文本路径跳过
    async function settleRun(sid, rec, res, err) {
      if (runsFor(sid)[rec.taskId] !== rec) return // 已被 terminate 等路径处理
      delete runsFor(sid)[rec.taskId]
      delete packByChild[String(rec.run.id)] // 上下文注入缓存随 run 销毁
      try { await rec.run.dispose() } catch (_) {}
      var output = outputText(res)
      var failed = !!err || (res && res.stopReason && res.stopReason !== 'completed')
      var errText = err ? String(err) : (res && (res.diagnostic || res.stopReason) || '')
      try {
        if (rec.role === 'worker') await settleWorker(sid, rec, output, failed, errText)
        else await settleVerifier(sid, rec, output, failed, errText)
      } catch (e) { console.error('[task-board] settle ' + rec.role + ' failed (task ' + rec.taskId + '):', String(e)) }
      // 历史会话留档：记录该次 run 的结局（完成/失败/硬超时），详情页可据此标注阶段状态
      closeRunHistory(sid, rec.taskId, String(rec.run.id), failed ? (err ? 'timeout/error' : 'incomplete') : 'completed').catch(function () {})
      // ===== token 消耗结算：读该次 run 的 v4 日志聚合 usage，累加到任务 =====
      // 放在状态推进之后：统计是附加信息，读日志失败/无 usage 时静默跳过，绝不影响结算语义。
      // Worker 失败重试、驳回重做都会各走一次 settleRun，因此多轮消耗天然累加（runs 计数）。
      await accumulateRunUsage(sid, rec)
    }

    // 把一次 run 的 token 消耗累加到任务（t.usage）：总量/输入/输出/缓存读写 + 按模型小计 + runs 计数。
    // 模型小计的 key：优先本次派发显式覆盖的模型（rec.model），否则用日志里记录的会话模型。
    async function accumulateRunUsage(sid, rec) {
      var u = null
      try { u = readRunUsage(String(rec.run.id)) } catch (_) { u = null }
      if (!u || !u.total) return
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
          t.usage.updatedAt = new Date().toISOString()
          return { ok: true }
        })
      } catch (e) { console.error('[task-board] usage accumulate failed (task ' + rec.taskId + '):', String(e)) }
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
        t.deliverable = { summary: secs.summary || output.slice(0, 600), changes: secs.changes || '', selfTest: secs.selfTest || '', diff: (secs.diff || '').slice(0, 4000), at: new Date().toISOString(), by: String(rec.run.id) }
        resolveApply(d, t, String(rec.run.id), 'verifying', output || 'Worker 完成', 'worker 文本上报完成')
        return { task: t }
      })
      if (!result) return
      // already=true：工具通道（board_report）已推进状态并已发回执/歧义通知，settle 只负责 dispose，不再重复通知
      if (result.already) return
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
          if (failed && rec.model) { badModels[modelKey(sid, rec.model)] = true; pushSysNote(sid, '模型 ' + rec.model + ' 验收连续失败，已熔断回退父级模型') }
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
      if (result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
      if (result.task && result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      kickCycle(sid)
    }

    // 歧义上报通知：任何模式都通知主窗口（escalation 需要人工裁决，不能静默吞掉）
    // 25s 去抖投递：主窗口 turn 进行中时 followup 只在宿主侧排队，送达时任务常已被裁决/归档（过期回声）；
    // 排队无法撤回，插件侧唯一可行的方案就是延迟 + 投递前重查看板。
    // escNotifyTimers 存每个任务最新一次调度：同一任务再次上报即顶替旧调度（旧回调身份不匹配 → 静默丢弃）；
    // 投递时才读 escalation.question，所以连续多次上报只会收到一条、且一定是最新疑问。
    var escNotifyTimers = {}
    function deliverEscalation(sid, taskId) {
      rt(sid).then(function (d) {
        var t = null
        var list = (d && d.tasks) || []
        for (var i = 0; i < list.length; i++) { if (list[i].id === taskId) { t = list[i]; break } }
        // escalation 已消失（已被裁决）或任务已 resolved/archived → 通知已过期，静默跳过（history 不记）
        if (!t || !t.escalation || t.status === 'resolved' || t.status === 'archived') return
        var root = rootForSession(sid)
        if (!root) return
        try { root.followup(makeMsg('⚠️ [任务看板] Worker 上报歧义，等待裁决：\n\n任务: ' + t.title + ' (' + t.id + ')\n\n疑问:\n' + String(t.escalation.question || '').slice(0, 1500) + '\n\n请在看板详情页裁决，或直接回复指示。裁决后会有新 Worker 带着裁决答案接手。\n\n（若收到时任务已被裁决或归档，说明本通知投递晚于处理——先用 task_list/get-tasks 核对状态，勿重复裁决。）', 'notice', '任务待裁决: ' + t.title)) } catch (e) { console.error('[task-board] escalate notify failed:', String(e)) }
      }).catch(function (e) { console.error('[task-board] escalate notify failed:', String(e)) })
    }
    function notifyMainWindow(sid, t) {
      var tm = ctx.timer
      if (!tm) { deliverEscalation(sid, t.id); return } // timer 不可用 → 直接投递（保持原即时行为）
      var key = sid + ':' + t.id
      var mine = tm.timeout(25000)
      escNotifyTimers[key] = mine
      mine.then(function () {
        if (escNotifyTimers[key] !== mine) return // 已被该任务更新的一次上报顶替 → 丢弃，避免重复通知
        delete escNotifyTimers[key]
        deliverEscalation(sid, t.id)
      }).catch(function () {}) // 插件销毁时 timeout 会 reject("Context has been disposed")，静默吞掉
    }
    function maybeNotify(sid, task) { if (task && task.escalation) { notifyMainWindow(sid, task) } }

    // ===== 任务回执通知（批量聚合 + 空闲门控）：派发执行的任务在 完成/阻塞 时通知主窗口 =====
    // 只通知派发执行的任务（isDispatched），主窗口自己手动处理的任务不回执（自己干的自己知道）。
    // 批量聚合：任务多时每任务一条 followup 会把主窗口 turn 队列打满（用户输入排队等回执处理完才刷新），
    // 改为 45s 窗口（或满 5 条）聚合为一条摘要；发送前等主窗口空闲，不打断对话。
    var receiptBuf = {}
    // 回执幂等去重表：key = 任务id + 类别 + 完成事件指纹（deliverable/verification/resolvedAt/末条history 时间戳）。
    // 同一完成事件被任何路径（工具直报/run 结算/未来回归）重复通知时指纹一致 → 吞掉；
    // 驳回后重做完成 → 时间戳全换新 → 指纹不同 → 正常回执。
    var receiptedKeys = {}
    function notifyTaskDone(sid, t, kind) {
      if (!t || !isDispatched(sid, t.claimedBy)) return
      var lastHist = (t.history && t.history.length) ? String(t.history[t.history.length - 1].timestamp || '') : ''
      var stamp = [kind, (t.deliverable && t.deliverable.at) || '', (t.verification && t.verification.at) || '', t.resolvedAt || '', lastHist].join('|')
      var key = t.id + ':' + stamp
      if (receiptedKeys[key]) return
      var rkeys = Object.keys(receiptedKeys)
      if (rkeys.length > 512) { var rnow = Date.now(); for (var ri = 0; ri < rkeys.length; ri++) { if (rnow - receiptedKeys[rkeys[ri]] > 3600000) delete receiptedKeys[rkeys[ri]] } }
      receiptedKeys[key] = Date.now()
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
    // 系统级异常通知队列（易失，随回执冲刷）：模型熔断/spawn 失败/孤儿回收/看门狗标记
    var sysNotesBuf = {}
    // taskId 可选：告警类通知（软超时提醒等）语义只对「任务仍在执行中」成立，
    // 带上任务 id 后 flush 投递前可重读看板校验，任务已落定的过期告警直接丢弃
    function pushSysNote(sid, text, taskId) {
      var arr = (sysNotesBuf[sid] = sysNotesBuf[sid] || [])
      arr.push({ text: text, at: new Date().toISOString(), taskId: taskId || null })
      if (arr.length > 10) arr.splice(0, arr.length - 10)
    }
    function flushReceipts(sid) {
      var buf = receiptBuf[sid]
      var notes = sysNotesBuf[sid] || []
      if ((!buf || !buf.items.length) && !notes.length) return
      receiptBuf[sid] = null
      sysNotesBuf[sid] = []
      var root = rootForSession(sid); if (!root) return
      var items = (buf && buf.items) ? buf.items.slice() : []
      function noteOf(status) { return status === 'verifying' ? '验证中' : '进行中' }
      // 组装投递文本（入参已是过滤后的存活项，避免用已丢弃项的计数）
      function composeText(items, notes) {
        var done = [], blocked = []
        for (var i = 0; i < items.length; i++) { (items[i].kind === 'resolved' ? done : blocked).push(items[i]) }
        var lines = [done.length || blocked.length ? '📋 [任务看板] 回执摘要（' + items.length + ' 条）' : '📋 [任务看板] 系统通知', '']
        if (done.length) {
          lines.push('✅ 完成 ' + done.length + ' 个：')
          for (var j = 0; j < done.length && j < 8; j++) lines.push('  · ' + done[j].title + ' (' + done[j].id + ')' + (done[j].summary ? ' — ' + done[j].summary.slice(0, 120) : ''))
        }
        if (blocked.length) {
          lines.push('🛑 阻塞 ' + blocked.length + ' 个（需关注）：')
          for (var k = 0; k < blocked.length && k < 8; k++) lines.push('  · ' + blocked[k].title + ' (' + blocked[k].id + ')' + (blocked[k].note ? ' — ' + blocked[k].note.slice(0, 150) : ''))
        }
        if (notes.length) {
          lines.push('', '⚠️ 系统异常 ' + notes.length + ' 条：')
          for (var n = 0; n < notes.length && n < 8; n++) lines.push('  · ' + notes[n].text)
        }
        lines.push('', '可用 task_list 查看全部；阻塞项可在看板拖回待办重新投放。')
        return lines.join('\n')
      }
      // 投递前状态过滤：入队到投递之间隔着 45s 聚合窗口 + 等主窗口空闲（最长 5 分钟），
      // 期间任务可能已经完成/归档——过期告警与死回执会误报（实测软超时告警 6/6 全误报）。
      // 所以 send 之前重读一次看板，按任务现状决定丢哪些项。
      function deliver() {
        return Promise.resolve().then(function () { return rt(sid) }).catch(function () { return null }).then(function (snap) {
          var tasks = (snap && snap.tasks) || []
          function findTask(id) { for (var i = 0; i < tasks.length; i++) { if (tasks[i].id === id) return tasks[i] } return null }
          // a. 带 taskId 的告警项：任务状态不在 in-progress/verifying 即已落定 → 丢弃；
          //    保留的项在文本前标注投递时状态（读到的是发送瞬间的真实状态，人可据此判断时效）
          var keptNotes = []
          for (var i = 0; i < notes.length; i++) {
            var nt = notes[i]
            if (nt.taskId) {
              var t = findTask(nt.taskId)
              if (!t || (t.status !== 'in-progress' && t.status !== 'verifying')) continue
              keptNotes.push({ text: '（投递时状态：' + noteOf(t.status) + '）' + nt.text })
            } else keptNotes.push(nt)
          }
          // b. 回执项：任务已 archived（人已手动归档 = 已知悉）→ 丢弃；
          //    resolved/blocked 保留（回执是主通道，任务查不到也保留，不能因读盘失败丢回执）
          var keptItems = []
          for (var j = 0; j < items.length; j++) {
            var it = items[j]
            var tt = findTask(it.id)
            if (tt && tt.status === 'archived') continue
            keptItems.push(it)
          }
          // c. 过滤后全空 → 不再打扰主窗口
          if (!keptItems.length && !keptNotes.length) return
          try { root.followup(makeMsg(composeText(keptItems, keptNotes), 'recall')) } catch (e) { console.error('[task-board] receipt flush failed:', String(e)) }
        })
      }
      if (typeof root.whenIdle === 'function') {
        var waited = withTimeout(root.whenIdle(), 300000, 'receipt-idle-wait') // 最多等 5 分钟，超时也发（不能丢回执）
        Promise.resolve(waited).then(deliver, deliver).catch(function (e) { console.error('[task-board] receipt flush failed:', String(e)) })
      } else deliver().catch(function (e) { console.error('[task-board] receipt flush failed:', String(e)) })
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
        // touches 文件级排他展示态：被拦候选写 t.waitingForTouches = [持有者任务id...]，
        // 未被拦/已派发/已落定的任务清除该字段（每心跳刷新的 UI 展示态，不参与任何派发逻辑，
        // 但必须显式清——只在写入时报字段会留下"锁已释放仍显示 🔒 等待"的永久误导）。
        var waitMap = {}
        picked.blockedTouches.forEach(function (b) { waitMap[b.id] = b.conflicts })
        d.tasks.forEach(function (t) {
          if (waitMap[t.id]) { t.waitingForTouches = waitMap[t.id]; info.push('wait-touches ' + t.id + '<-' + waitMap[t.id].join(',')) }
          else if (t.waitingForTouches) delete t.waitingForTouches
        })
        // UI 池状态：来自活跃 run（一次性模型：没有成员名册，只有在跑的任务）
        d.poolStatus = { workers: [], verifiers: [] }
        Object.keys(runs).forEach(function (k) { var rc = runs[k]; d.poolStatus[rc.role === 'worker' ? 'workers' : 'verifiers'].push({ id: k, num: '-', busy: true, taskId: rc.taskId, runId: String(rc.run.id), done: 0, queueLen: 0, suspect: false, model: rc.model || '' }) })
        if (info.length > 0) { d.dispatchInfo = info.join('; '); d.dispatchInfoAt = new Date().toISOString() }
        else if (d.dispatchInfo && (!d.dispatchInfoAt || Date.now() - new Date(d.dispatchInfoAt).getTime() > 90000)) { delete d.dispatchInfo; delete d.dispatchInfoAt } // 瞬时通知：90s TTL 过期即清，不再永久残留
        return d
      }, true) // skipKick：poolCycle 自写不触发 kickCycle（防无限循环）

      // 锁外 spawn（慢操作）；占位 claim 已保证不会被别的 cycle 重复派发
      for (var k = 0; k < toSpawn.length; k++) {
        var sp = toSpawn[k]
        var rec = await spawnOneShot(sid, sp.t, sp.role)
        if (rec) {
          // claim 占位换成真实 run id；verifier run 单独记（claimedBy 保留 worker 的，供详情页跳转会话）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t) { if (sp.role === 'worker' && t.claimedBy === 'spawn-pending') t.claimedBy = String(rec.run.id); if (sp.role === 'verifier' && t.verifierRun === 'spawn-pending') { t.verifierRun = String(rec.run.id); t.verifierRunAt = new Date().toISOString() } }; return t }, true)
        } else if (sp.role === 'worker') {
          // spawn 失败 → 回 pending
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.status === 'in-progress' && t.claimedBy === 'spawn-pending') { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', 'spawn 失败，回收重新排队') }; return t }, true)
          pushSysNote(sid, '任务「' + sp.t.title + '」Worker 启动失败，已重新排队')
        } else if (sp.role === 'verifier') {
          // verifier spawn 失败 → 清占位，下轮 cycle 重试（占位不清会永远卡住派发）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.verifierRun === 'spawn-pending') { t.verifierRun = null; delete t.verifierRunAt }; return t }, true)
          pushSysNote(sid, '任务「' + sp.t.title + '」Verifier 启动失败，下轮自动重试')
        }
      }
      return result
    }

    // 插件停止时清理所有活跃 run
    ctx.effect(function () { return function () { Object.keys(state.activeRuns).forEach(function (psid) { var rr = state.activeRuns[psid]; Object.keys(rr).forEach(function (k) { try { rr[k].run.dispose() } catch (_) {} }) }); state.activeRuns = {} } })
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
          return '【任务看板 Team 模式已开启】\n本会话的任务看板处于 Team 模式。请遵循以下工作方式：\n1. 涉及代码改动、文件创建、命令执行等实质性工作时，优先用 task_create 提交为看板任务（由一次性 Worker/Verifier 子代理执行与验收），不要自己直接动手实现。\n2. 你仍保有全部工具能力——调研、读代码、讨论方案、回答问题时直接进行，无需提交任务。\n3. 创建任务时，务必在 description 里写清任务目标和约束；调研结论/原始需求/思路用 contextNotes 带上，调研时读过的关键文件用 contextFiles 把路径带上——两者都会通过「上下文注入」通道传给子代理（独立注入区块，不占对话流）。子代理是全新会话、无你的会话记忆，上下文不够它需要从零自行调研，效率大打折扣甚至跑偏方向。\n4. Worker 上报歧义时会通过 task_arbitrate 等待你裁决，请及时响应。驳回重派时同样：新 Worker 没有上一轮的记忆，驳回原因会在 prompt 里，但额外上下文需你在 description 里补上。\n5. Team 模式下 task_create 默认建为草稿（草稿不会被派发领取）。把所有任务的 dependsOn 依赖关系、contextNotes/contextFiles 都补完后，再逐个 task_update publish=true 统一发布。确实需要立即派发的单个任务才显式传 draft:false。\n' + TEAM_SPLIT_RULE + (feedbackOn(String(agent.id)) ? '\n' + LESSON_RECALL_HINT + '把检索到的相关历史教训写进任务的 contextNotes，让子代理少踩重复的坑。' : '')
        },
      })
      ctx.effect(function () { return disposeSection })
      // 预研文件上下文注入：Worker/Verifier 的预研文件内容以「上下文注入」区块呈现
      // （与 skill-catalog 同形态），不混进 user prompt。按子代理会话 id 命中，O(1)，
      // 其他 agent 组装时零成本返回空串。
      var disposeCtxPack = sysPrompt.context({
        name: 'task-board:context-pack',
        order: 50,
        text: function (assembleCtx) {
          var agent = assembleCtx && assembleCtx.agent
          if (!agent) return ''
          var aid = String(agent.id)
          var hit = packByChild[aid]
          if (hit) return hit
          // 首轮竞速自愈：start() 返回前的首次组装按父子归属从 pendingPacks 认领
          var agentsSvc = ctx.agents
          if (!agentsSvc) return ''
          var now = Date.now()
          for (var i = pendingPacks.length - 1; i >= 0; i--) {
            var pp = pendingPacks[i]
            if (now - pp.at > 60000) { pendingPacks.splice(i, 1); continue }
            try {
              if (agentsSvc.isOwnedBy(aid, pp.parent)) { packByChild[aid] = pp.pack; return pp.pack }
            } catch (e) { console.error('[task-board] ctxpack isOwnedBy threw: ' + String(e)) }
          }
          return ''
        },
      })
      ctx.effect(function () { return disposeCtxPack })
    }

    return { poolCycle: poolCycle, spawnOneShot: spawnOneShot, accumulateRunUsage: accumulateRunUsage, readContextPack: readContextPack }
}
