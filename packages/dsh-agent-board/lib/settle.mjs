// dsh-agent-board — 结算主干（lib/settle.mjs）
// 拆分自 lib/dispatch.mjs（拆分第 5 刀 task-mvt8c1yx-5：run 结算收尾、continuable 收尾、
// agent/status 事件通道与 board_report 上报通道共用同一套关账/usage/摘超时臂口径；
// 拆分第 6 刀 task-mvt8c1yx-6：四个角色结算 settleWorker/settleVerifier/settleHook/settleDecompose
// 搬入本模块，settleRun 分路改模块内直调，撤掉 roles 懒注入）。
// 禁 import dispatch.mjs：健康/留档/usage 同域依赖直接 import 叶子模块（core/policy/model-health/hung），
// model-health 的冷却/熔断四方法是工厂方法（非模块导出），随已注入的 health 实例解构；通知类 deps
// （pushSysNote/maybeNotify/notifyTaskDone/notifyLate*/notifyDecomposed/kickCycle）随工厂入参注入。
import { statSync } from 'node:fs'
import * as core from './core.mjs'
import { findRunLog, readLogBytes, readLogFrames } from './usage.mjs'
import { applyDecomposeProposal, pushRejectLesson } from './policy.mjs'
import { modelKey } from './model-health.mjs'
import { isHungKillFailure, HUNG_CIRCUIT_WHY } from './hung.mjs'
const { outputText, cfg, ah, parseSections, resolveApply, verifyApply, lateVerdictApply, lateNoticeFp, pushRejection, applyHookSettle } = core

export function createSettle(opts) {
    var state = opts.state, ctx = opts.ctx, runsFor = opts.runsFor, mutateLocked = opts.mutateLocked
    var rootForSession = opts.rootForSession
    // rt/sessionsRoot 与 dispatch 同源：continuable 补停豁免须读新鲜卡面，日志兜底须读同一 sessions 根。
    var rt = opts.rt, sessionsRoot = opts.sessionsRoot
    var closeRunHistory = opts.closeRunHistory, resumeTarget = opts.resumeTarget
    var poolHealthFor = opts.poolHealthFor, accumulateRunUsage = opts.accumulateRunUsage
    // 工厂入参补通知类 deps（拆分第 6 刀）：四个角色结算的消费面——按各函数实际消费逐个对；
    // notifyLateReject/notifyLateApprove 未接线 → 静默跳过（守卫写法随行，与 dispatch 原归一口径一致）。
    var pushSysNote = opts.pushSysNote, maybeNotify = opts.maybeNotify, notifyTaskDone = opts.notifyTaskDone
    var notifyLateReject = (typeof opts.notifyLateReject === 'function') ? opts.notifyLateReject : null // 迟到驳回 err 级通知（未接线 → 静默跳过）
    var notifyLateApprove = (typeof opts.notifyLateApprove === 'function') ? opts.notifyLateApprove : null // 迟到复核 notice 级通知（三连根修②，未接线 → 静默跳过）
    var notifyDecomposed = opts.notifyDecomposed
    var kickCycle = opts.kickCycle
    // badModels 熔断表（settleVerifier 即时熔断臂消费）：与 dispatch 同源别名（state 共享同一引用，
    // model-health 工厂惰性初始化语义逐字不变）。
    var badModels = state.badModels
    // 健康域工厂方法（拆分第 6 刀）：冷却嗅探/喂熔断/即时熔断/熔断登记四方法是 createModelHealth
    // 工厂方法（非模块导出），从已注入的 health 实例解构——与 observeModel/resetModelFailure 同源。
    const { observeModel, resetModelFailure, sniffModelCooldown, feedModelFailure, isModelKillFailure, markModelCircuit } = opts.health
    // run 结算：保证收尾；工具通道（board_report/board_verdict）已推进状态的话文本路径跳过
    // ===== 结算收尾三件套（task-muwkhqf8）=====
    // 无论从哪条入口进来（事件通道 settleContinuable / 上报通道 board_report），run 记录的收尾动作
    // 必须一致：①关 run 结局（closeRunHistory）②usage 落账（seq 水位线增量）③摘除软/硬超时臂。
    // 三条各自幂等：重复结算（idle 事件重入 / 上报与事件双通道先后到达）不二次关账、不二次记账。
    // ===== 结算≠停止根修（task-mv8wuznb，ontology 实证 2026-10-15：卡 02:02 已 resolved、verdict 已落账，
    // verifier 子会话却持续写盘空转到 10:16 被主窗口手杀——8 小时空烧）=====
    // 病根：一次性 run 的 settle 只关账（dispose 只释放本地 run 句柄，不停子会话的 agent loop）——
    // verifier 调完 board_verdict 后 turn 未结束（继续探索/循环），会话持续空转烧 token。
    // 一次性子代理「结算即销毁」是设计语义，这里补齐销毁的半步：结算落定后对该 run 的子会话补一枪
    // interrupt（与 endContinuable 同款 authority 形状，fire-and-return 同步发信号即返回）。
    // 挂载点取 settleRunRecord 末尾 = 所有一次性落定路径的唯一汇合点（settleRun 的
    // completed/failed/incomplete、幽灵回收 reapGhostRecs 的收尾都经这里）——含事故原形
    // 「board_verdict 落账 → 卡 resolved → rec 下轮被幽灵回收」那条（rec 在表外时 settleRun 根本跑不到）。
    // 边界（零改动）：hook 点位不在本卡范围；重复 interrupt 无害（取消信号幂等）。continuable 豁免经
    // task-mvbeallq 收紧：原「continuable 即跳」过宽（无续跑位的残影借豁免续跑），现仅「续跑位真在
    // 本 child 手上」才放行，其余 continuable 落定同样补停——收紧细则与竞态论证见函数头注释。
    // 失败只 console.error：结算已落定，残留空转只影响 token 不影响正确性（与 terminate 的 killFail
    // 告警分级不同——那是用户显式要杀，这里是收尾补强）。
    async function stopSettledOneShot(sid, rec) {
      if (!rec || !rec.id) return
      if (rec.role !== 'verifier' && rec.role !== 'worker') return // 只对 verifier 与 worker 动手
      var subagents = ctx.subagents
      if (!subagents || typeof subagents.interrupt !== 'function') return // 老宿主/老测试桩无此能力：逐字不变
      var parent = rootForSession(sid)
      if (!parent) return // 无活 root 可授权（root 已死/重建窗口）→ 跳过，结算语义不受影响
      // ===== continuable 豁免收紧（task-mvbeallq，残影治理①）=====
      // 原闸门「rec.continuable 即跳」过宽：continuable 但**已无续跑位**的落定——completed（resumeTarget
      // 只认超时/失败结局）/ noResume 落旗（reap 失败）/ 卡面最新 worker 留档已被更新的 run 取代
      // （池故障后主窗口重派了新 Worker）——借豁免续跑就是残影（ontology 实证：旧子会话残影续跑 5 分钟
      // 逐文件推进，与新 Worker 差点同批文件互踩）。interrupt 对 continuable 只打断 turn、不销毁会话
      // （endContinuable 同款语义），补停安全。豁免只剩「续跑位真在本 child 手上」两种形态：
      //   ① 本卡活跃表已有接管**同一子会话**的新 rec——续跑在途，此刻打断会杀掉刚复活的新 turn。
      //      （续跑路径纪律：sendMessage 返回后**零 await**先登记 rec 再追加续跑留档，故新 turn 全程
      //      被本形态覆盖；不同 id 的新 rec=fresh spawn 新 Worker，不豁免——旧残影照停。）
      //   ② 锁外新鲜快照上 resumeTarget 仍指向本 child——续跑位未被消费，下轮重派会冷复活它。
      //      （豁免判定必须读新鲜快照：结算刚关账，只有自己内存里的 rec 不足以判定留档次序——
      //      幽灵回收路径上卡面可能已有更新的 worker 留档。）
      // 两形态之外一律补停；快照读不到（t=null）按「无续跑位」处理——宁停勿留残影。
      if (rec.continuable) {
        var cur = runsFor(sid)[rec.taskId]
        if (cur && String(cur.id) === String(rec.id)) return // ① 续跑在途（新 rec 接管同一子会话）
        var t = null
        try {
          var dsnap = await rt(sid)
          if (dsnap && Array.isArray(dsnap.tasks)) { for (var ti = 0; ti < dsnap.tasks.length; ti++) { if (dsnap.tasks[ti] && dsnap.tasks[ti].id === rec.taskId) { t = dsnap.tasks[ti]; break } } }
        } catch (_) { t = null }
        if (t && resumeTarget(t) === String(rec.id)) return // ② 续跑位在手：留存会话供冷复活
      }
      try {
        subagents.interrupt(String(rec.id), { kind: 'ancestor', agent: parent })
      } catch (e) {
        console.error('[task-board] 一次性 run 结算后 interrupt 子会话失败（会话可能仍在空转，只影响 token）task ' + rec.taskId + ' child ' + rec.id + ':', String(e))
      }
    }

    async function settleRunRecord(sid, rec, opts) {
      // ① 结局落卡：failed → 有 err 记 timeout/error，无 err 记 incomplete（与一次性路径口径一致）；
      //    成功 → completed。noResume 旗随 rec.resumeBlocked（interrupt 失败）落卡。
      try {
        await closeRunHistory(sid, rec.taskId, String(rec.id), opts.outcome, rec.continuable ? { noResume: rec.resumeBlocked === true } : null)
      } catch (e) { console.error('[task-board] closeRunHistory 收尾失败 (task ' + rec.taskId + '):', String(e)) }
      // 统一健康表被动面：每个可归因 run 落定都记最近 5 次成败与本次延迟；父模型 id 不可知则跳过。
      if (rec.model) observeModel(sid, rec.model, opts.outcome === 'completed', { latencyMs: Math.max(0, Date.now() - Number(rec.startedAt || Date.now())) })
      // 熔断连击归零（task-mvowb2hc 洞①）：连击只在「连续」语义内计数——任一可归因 run 正常完成
      // 即证明模型链路恢复，清零重新计数（失败落定不动连击，也归不了零）。
      if (rec.model && opts.outcome === 'completed') resetModelFailure(sid, rec.model)
      // ② usage 落账：读该次 run 的 v4 日志聚合（水位线增量），累加到任务。放在状态推进之后：
      //    统计是附加信息，读日志失败/无 usage 时静默跳过，绝不影响结算语义。
      //    Worker 失败重试、驳回重做都会各走一次 settleRun，因此多轮消耗天然累加（runs 计数）。
      try { await accumulateRunUsage(sid, rec) } catch (e) { console.error('[task-board] usage 收尾失败 (task ' + rec.taskId + '):', String(e)) }
      // ③ 摘除两级超时臂：软臂不再刷假告警，硬臂不再对已结算的闲置会话补一枪 interrupt。
      try { if (typeof rec.disarm === 'function') rec.disarm() } catch (_) {}
      // ② settle 通道心跳（运行时健康自检）：三件套各自幂等且各自 catch 永不抛，
      // 走到这里即「一次成功结算活动」——rpc 侧据此判定「结算通道 >30min 无活动」黄条。
      poolHealthFor(sid).settleLastOkAt = Date.now()
      // ④ 结算≠停止根修（task-mv8wuznb）：落定后主动 interrupt 子会话，堵「结算≠停止」空转洞。
      // task-mvbeallq 起改 async（continuable 豁免收紧需读锁外快照算 resumeTarget）——interrupt 本身
      // 仍是同步信号 fire-and-return；闸门与 try/catch 全在函数内/调用处，绝不阻断/改变结算语义；
      // 续跑位在手的 continuable 与 hook 在函数内被原样放行（豁免边界见函数头注释）。
      try { await stopSettledOneShot(sid, rec) } catch (e) { console.error('[task-board] 结算后补停子会话异常（不影响结算）task ' + rec.taskId + ':', String(e)) }
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
        // 角色结算分路改模块内直调（拆分第 6 刀，撤掉第 5 刀的 roles 懒注入）——四个函数搬入本模块下方。
        if (rec.role === 'worker') await settleWorker(sid, rec, output, failed, errText)
        else if (rec.role === 'hook-pre' || rec.role === 'hook-post') await settleHook(sid, rec, output, failed, errText)
        else if (rec.role === 'decomposer') await settleDecompose(sid, rec, res, err)
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
    //     在跑的 Worker（幽灵占位）。子会话由 settleRunRecord 末尾的 stopSettledOneShot 补停
    //     （task-mvbeallq：completed 落定天然无续跑位——resumeTarget 只认超时/失败结局——「续跑豁免」
    //     留下的就是残影续跑窗；补停只打断 turn 不销毁会话，与 endContinuable 同款语义）。
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

    // ===== Worker run 结算（搬移自 lib/dispatch.mjs，拆分第 6 刀 task-mvt8c1yx-6；注释与文案零变化）=====
    async function settleWorker(sid, rec, output, failed, errText) {
      // 冷却嗅探②（continuable 死子路径）：失败结算文本命中限流/连接故障 → 本 run 所用模型登记冷却表。
      // activation.result 拆除兜底臂带上来的诊断文本（含「限额将在 … 重置」/ ENOTFOUND 等）也走这里。
      // rec.model 空 = 父模型（id 不可知）无法归因，跳过；badModels 熔断语义不受影响（两张表各管各的）。
      if (failed && rec.model) await sniffModelCooldown(sid, rec.taskId, rec.model, errText)
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
          // ===== 宿主秒拆喂熔断（task-mvowb2hc 洞①）：spawn/续跑后即被宿主拆除（stopReason:error）
          // = 模型面失败，计入熔断连击——原形 task-mvoutja4：glm-5.3-flash 秒拆 ×3 不计入 badModels，
          // 熔断永不触发，档位链每轮重派都再选同一个坏模型。连续 3 次才拉黑（熔断语义不变：badModels
          // 落黑名单 → 取模链跳过 + 健康表 circuit）；worker 自己的失误不计，成功 run 归零（settleRunRecord）。
          if (rec.model && isModelKillFailure(errText)) feedModelFailure(sid, rec.model, isHungKillFailure(errText) ? HUNG_CIRCUIT_WHY : undefined)
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
    // ===== Verifier run 结算（搬移自 lib/dispatch.mjs，拆分第 6 刀 task-mvt8c1yx-6；注释与文案零变化）=====
    async function settleVerifier(sid, rec, output, failed, errText) {
      // 完成回执开关同上：持锁回调内取 notifyDone
      var doneOn = true
      var result = await mutateLocked(sid, function (d) {
        doneOn = cfg(d).notifyDone !== false
        var t = d.tasks.find(function (x) { return x.id === rec.taskId })
        if (!t) return null
        if (t.escalation) return { task: t, already: true }
        if (t.status !== 'verifying') {
          // 迟到落账（验收时序三洞 ③）：verifier 结论落到已落定卡（主窗口抢批/归档早于本 run 结算）不再静默丢弃。
          // 但「工具通道已处理」= board_verdict 已由本 run 自己落账（t.verification.by === rec.id）→ 保持 already。
          if (t.status === 'resolved' || t.status === 'archived' || t.status === 'cancelled') {
            if (t.verification && String(t.verification.by) === String(rec.id)) return { task: t, already: true }
            var ltrim = (output || '').trim()
            var lvm = ltrim.match(/^[ \t>*#\-\s]*(APPROVED|REJECTED)\b/im)
            if (failed || !lvm) return { task: t, already: true } // 无有效结论，不落 late
            var lapproved = lvm[1].toUpperCase() === 'APPROVED'
            var lsecs = parseSections(ltrim)
            var lr = lateVerdictApply(t, lapproved ? 'approved' : 'rejected', lsecs.verifySummary || ltrim.slice(0, 600), lsecs.checks || '', lsecs.userTest, new Date().toISOString(), String(rec.id), cfg(d).verifyUserGuide)
            if (lr && lr.invalid) return { task: t, already: true } // 三连根修①：非法 verdict 零落账（防御——本路径 verdict 恒来自正则解析）
            return { task: t, late: true, lateRejected: lr.lateRejected && lr.wasApproved }
          }
          return { task: t, already: true }
        }
        var trimmed = (output || '').trim()
        var vm = trimmed.match(/^[ \t>*#\-\s]*(APPROVED|REJECTED)\b/im)
        if (failed || !vm) {
          // 失败原因落卡（截断 300）：verifier 故障/输出无法判定的原因留在卡片上供排查
          t.lastError = String(errText || 'verifier 未给出有效结论（输出格式异常）').slice(0, 300)
          // 失败/空输出/无法判定：verifyRetries 计数，>=3 转人工验收（deliverable 已完成，是 verifier 故障不是任务故障）
          if (failed && rec.model) {
            badModels[modelKey(sid, rec.model)] = true
            // 熔断文案分态（task-mv73ym2k，实证 n-mv6ezj6vary4）：错误串含 UNKNOWN_MODEL = 模型 id 非法
            // （mistake 类：配置写错，模型无辜）——与「连续验收失败」（quality 类）区分，不归一堆。
            var modelIllegal = /UNKNOWN_MODEL/i.test(String(errText || ''))
            markModelCircuit(sid, rec.model, modelIllegal ? '模型 id 配置非法，已熔断' : '验收连续失败，已熔断')
            pushSysNote(sid, modelIllegal
              ? '模型 ' + rec.model + ' 配置非法（不在可用清单），已熔断回退父级模型——请经 list-models 选合法 id 重配'
              : '模型 ' + rec.model + ' 验收连续失败，已熔断回退父级模型')
          }
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
      // 迟到通知分态（三连根修②③，task-mvf7nve8）：rejected 且卡已 approved → err 级「🚨 迟到驳回」+
      // healthHint（banner 只 rejected 亮）；approved → notice 级「✅ 迟到复核：维持原判」。
      // 同指纹（taskId+by+verdict，poolHealth.lastLateNotice）已投过 → 跳过，零重复通知。
      if (result.late) {
        var __phL = poolHealthFor(sid)
        var __fpL = lateNoticeFp(result.task)
        var __onceL = __phL.lastLateNotice !== __fpL
        if (__onceL) __phL.lastLateNotice = __fpL
        if (result.lateRejected) {
          __phL.lateRejectNote = { taskId: result.task.id, at: Date.now() } // banner 幂等 sticky，不受去重闸影响
          if (__onceL && notifyLateReject) notifyLateReject(sid, result.task)
        } else if (__onceL && notifyLateApprove && result.task.lateVerdict && result.task.lateVerdict.verdict === 'approved') {
          notifyLateApprove(sid, result.task)
        }
        return
      }
      if (result.escalated) maybeNotify(sid, result.task)
      if (doneOn && result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
      if (doneOn && result.task && result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      kickCycle(sid)
    }
    // ===== hook run 结算（hooks=agent run 接线②；搬移自 lib/dispatch.mjs，拆分第 6 刀 task-mvt8c1yx-6）=====
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
    // ===== 拆解官结算（task-mvnenrwk；搬移自 lib/dispatch.mjs，拆分第 6 刀 task-mvt8c1yx-6）：host 读 result.structured 物化 draft 子卡 =====
    // 三分支：verdict=split → applyDecomposeProposal 物化（幂等清旧批 draft 提案）+ 源卡摘要消息 + 通知；
    //         verdict=keep → 源卡记「无需拆分：rationale」；
    //         run 失败 / structured 缺失 / 提案畸形 → 源卡记失败原因 + 通知（源卡与旧提案批都不动）。
    // 通知（task-mvrqiu6x）：split/keep 成功改走 notifyDecomposed（pushReceipt 聚合内核出「🧩 已拆解」分区，
    // 受 notifyDone 开关约束）——源卡按设计停在 draft/pending，旧实现借 pushSysNote 系统通道绕行
    // 「带 taskId 会被仍在执行中过滤器丢弃」的墙，代价是成功信号伪装成「⚠️ 系统异常」；
    // 失败分支保持 pushSysNote 🚨 不变（异常就该是异常）。
    async function settleDecompose(sid, rec, res, err) {
      var failed = !!err || (res && res.stopReason && res.stopReason !== 'completed')
      var errText = err ? String(err) : (res && (res.diagnostic || res.stopReason) || '')
      var structured = (res && res.structured && typeof res.structured === 'object') ? res.structured : null
      var applied = null
      var srcTitle = ''
      // 完成回执开关（设置区「通知」notifyDone，task-mvrqiu6x）：同一次持锁回调里读看板文档（零额外读盘，
      // 与 settleWorker/settleVerifier 写法一致）；缺字段 → cfg 归一为 true，宁可多报不漏报。
      var doneOn = true
      try {
        applied = await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === rec.taskId })
          if (!t) return null
          srcTitle = t.title
          doneOn = cfg(d).notifyDone !== false
          if (!Array.isArray(t.messages)) t.messages = []
          if (failed) {
            t.messages.push({ kind: 'decompose', text: '🧩 拆解官 run 失败（' + String(errText || '未知错误').slice(0, 200) + '）——源卡未改动，可重试 task_decompose', at: new Date().toISOString(), by: 'system' })
            return { ok: false, failed: true }
          }
          if (!structured) {
            t.messages.push({ kind: 'decompose', text: '🧩 拆解官未返回结构化提案（structured 缺失，可能宿主/provider 不支持 outputSchema）——源卡未改动，可重试 task_decompose', at: new Date().toISOString(), by: 'system' })
            return { ok: false, failed: true }
          }
          return applyDecomposeProposal(d, t, structured, new Date().toISOString())
        }, true) // skipKick：物化的是 draft 子卡（不参与派发），无需踢 poolCycle
      } catch (e) { console.error('[task-board] settle decompose failed (task ' + rec.taskId + '):', String(e)); applied = null }
      try {
        // 拆解官正式回执：走 notifyDecomposed（「🧩 已拆解」聚合分区，notifyDone 闸门同完成回执口径；
        // 源卡 messages 的「🧩 拆解提案已就位/无需拆分」留痕已由 applyDecomposeProposal 落卡，
        // 关开关时留痕照旧不丢）——成功信号不再借系统通道伪装异常。
        if (applied && applied.ok && applied.verdict === 'split') {
          if (doneOn && typeof notifyDecomposed === 'function') notifyDecomposed(sid, { sourceId: rec.taskId, sourceTitle: srcTitle, verdict: 'split', children: applied.children, reason: '' })
        } else if (applied && applied.ok && applied.verdict === 'keep') {
          if (doneOn && typeof notifyDecomposed === 'function') notifyDecomposed(sid, { sourceId: rec.taskId, sourceTitle: srcTitle, verdict: 'keep', children: [], reason: structured ? String(structured.rationale == null ? '' : structured.rationale).trim().slice(0, 150) : '' })
        } else pushSysNote(sid, '🚨 拆解官 run 未产出可用提案（源卡 ' + rec.taskId + '）：' + String((applied && applied.error) || errText || 'structured 缺失').slice(0, 200)) // 失败分支：异常就是异常，保持 🚨 系统通道（文案逐字不变）
      } catch (e) { console.error('[task-board] decompose notify failed:', String(e)) }
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
    // settleWorker 从工厂返回集导出（拆分第 6 刀）：spawnOneShot 的 activation 拆除兜底臂/异常臂两调用点
    // 重指本实例——同一 deps 接线（mutateLocked/health/通知类/kickCycle 同源），语义与搬移前一致。
    return { settleRun: settleRun, settleRunRecord: settleRunRecord, settleReportedRun: settleReportedRun, onAgentStatus: onAgentStatus, settleWorker: settleWorker }
}