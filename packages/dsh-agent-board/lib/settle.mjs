// dsh-agent-board — 结算主干（lib/settle.mjs）
// 拆分自 lib/dispatch.mjs（拆分第 5 刀，task-mvt8c1yx-5）：run 结算收尾、continuable 收尾、
// agent/status 事件通道与 board_report 上报通道共用同一套关账/usage/摘超时臂口径。
// 禁 import dispatch.mjs：角色结算仍由 dispatch 以懒闭包注入，健康/留档/usage 等同域依赖亦闭包注入。
import { statSync } from 'node:fs'
import * as core from './core.mjs'
import { findRunLog, readLogBytes, readLogFrames } from './usage.mjs'
const { outputText } = core

export function createSettle(opts) {
    var state = opts.state, ctx = opts.ctx, runsFor = opts.runsFor, mutateLocked = opts.mutateLocked
    var rootForSession = opts.rootForSession
    // rt/sessionsRoot 与 dispatch 同源：continuable 补停豁免须读新鲜卡面，日志兜底须读同一 sessions 根。
    var rt = opts.rt, sessionsRoot = opts.sessionsRoot
    var closeRunHistory = opts.closeRunHistory, resumeTarget = opts.resumeTarget
    var poolHealthFor = opts.poolHealthFor, accumulateRunUsage = opts.accumulateRunUsage, roles = opts.roles
    const { observeModel, resetModelFailure } = opts.health
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
        if (rec.role === 'worker') await roles.worker(sid, rec, output, failed, errText)
        else if (rec.role === 'hook-pre' || rec.role === 'hook-post') await roles.hook(sid, rec, output, failed, errText)
        else if (rec.role === 'decomposer') await roles.decompose(sid, rec, res, err)
        else await roles.verifier(sid, rec, output, failed, errText)
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
    return { settleRun: settleRun, settleRunRecord: settleRunRecord, settleReportedRun: settleReportedRun, onAgentStatus: onAgentStatus }
}