// dsh-agent-board — 挂死检测域（lib/hung.mjs）
// 拆分自 lib/dispatch.mjs（拆分第 1 刀·叶子模块，task-mvt8c1yx）：挂死零产出检测常量（task-mvqcoz9l/
// task-mvrt9tn5 定稿）+ 挂死型模型面失败识别（isHungKillFailure）+ assistant-stream 帧活性追踪
// （frameSessionIdOf/frameStreamSeen/onAssistantFrame）+ 零产出清扫（hungZeroOutputSweep）。
// 叶子模块：只 import core.mjs，不 import 任何兄弟域文件；会话状态/留档结算以闭包回调注入
// （createHung 工厂：logSizeOf 与 settleRun 本轮仍在 dispatch.mjs 内，settleRun 后续拆分搬走时只需重指注入目标）。
import { ah } from './core.mjs'

// ===== 挂死零产出检测常量（task-mvqcoz9l）=====
// 原形（2026-10-27 降级实测）：glm-5.2 续跑挂上「连接开着永不响应」形态——会话不死（死会话哨兵
// listChildren 查不出）、不报错（无 settle 事件）、零产出（日志零增长 7 分钟），running 假相直到
// 人工终止。熔断/冷却/哨兵全部够不着它（哨兵只盖「会话不在目录」，这里盖「会话在但不干活」）。
// 判死口径：连续 HUNG_ZERO_GROWTH_ROUNDS 轮（≈40 ≈ 600s/15s 心跳）日志零增长 **且距基线
// ≥600s 墙钟地板**——poolCycle 不只心跳驱动，每次写盘都 kickCycle（写风暴下轮数可在 1s
// 内跑完），纯轮数会对刚 spawn 的 run 秒判；双闸 = 「≥40 轮零增长且真跨 600s 墙钟」。
// 常量化暂不开放配置（实证再调）。
// ===== 挂死墙钟阈值定稿（task-mvrt9tn5 二度校准）：固定 600s，放弃延迟缩放 =====
// 三轮生产误杀实证（2026-10-28）：①慢网关模型长生成段 180s+ 零日志被 180s 闸误杀；
// ②kimi-k3（健康表实测延迟 2s 的快模型）正常干活 10 分钟同样被 180s 闸误杀（=3×2s 地板）——
// 结论：延迟（首 token 速度）与「长生成静默时长」无关，慢模型慢在长生成，快模型做大任务
// 同样有 3 分钟+ 无日志窗口，3×latencyMs 缩放（task-mvrg3962）方向作废。定稿：墙钟地板直接
// 600s（10 分钟，对齐观测到的最长正常静默），删延迟缩放（简化，也根除「3×0s=0s 假精确回落」
// 的延迟数据缺失洞）。轮数闸按墙钟换算常量化：600s/15s 心跳 ≈ 40 轮。判死语义不变：
// 600s 零增长 + 轮数达线才判（真挂死 7 分钟实证，600s 仍能抓住，只是晚 3 分钟——可接受）。
// 熔断喂连击/重派链路均不动。
export var HUNG_WALL_FLOOR_MS = 600000
export var HUNG_ZERO_GROWTH_ROUNDS = 40 // ≈ HUNG_WALL_FLOOR_MS / 15s 心跳：轮数半边与墙钟半边同尺度（写风暴防秒判语义保留）
// 挂死检测 v2：assistant-stream 帧活性优先，日志双闸只兜无帧流/不可映射的旧路径。
// 120s 只标疑似不杀；600s 才走既有判死结算。帧时间戳只在内存刷新，持久化仅承担 sweep 基线与状态转换。
export var HUNG_FRAME_SUSPECT_MS = 120000
export var HUNG_FRAME_KILL_MS = 600000
export var HUNG_KILL_PREFIX = 'run 挂死：' // 判死失败文本前缀（进 isModelKillFailure 白名单 = 计入熔断连击）
export var HUNG_CIRCUIT_WHY = '挂死零产出（会话日志字节持续不涨），已熔断' // 挂死触发的熔断文案分态（挂死≠秒拆）
// 挂死型模型面失败识别：判死结算的错误文本（HUNG_KILL_PREFIX 开头）与宿主秒拆/activation 异常
// 同属模型面故障——计入熔断连击（feedModelFailure）。文案避开冷却嗅探关键词（连接/超时/网关等），
// 挂死只进连击，不登记冷却（冷却表与熔断表语义分治）。
export function isHungKillFailure(errText) { return String(errText || '').indexOf(HUNG_KILL_PREFIX) === 0 }

// ===== 帧活性追踪 + 零产出清扫（会话状态/留档结算以闭包回调注入）=====
export function createHung(opts) {
    var state = opts.state, mutateLocked = opts.mutateLocked, runsFor = opts.runsFor
    // logSizeOf 与 settleRun 本轮仍在 dispatch.mjs 内（createDispatch 函数声明提升，此处以闭包回调注入）；
    // settleRun 后续拆分搬走时只需重指注入目标，本模块零改动。
    var logSizeOf = opts.logSizeOf, settleRun = opts.settleRun
    // 可映射帧流的会话 id：continuable 用 childId；activation 一次性 run 在创建时显式记录 childId。
    // 老 start 的 provider run id 不是会话身份，frameSessionId 为空，sweep 自动保留日志双闸。
    function frameSessionIdOf(rec) {
      if (!rec) return ''
      return String(rec.continuable ? (rec.childId || '') : (rec.frameSessionId || ''))
    }
    var frameStreamSeen = false // 本 host 生命周期是否见过任意 assistant-stream 帧（薄桩/mock 零帧时全局兜底）
    function onAssistantFrame(payload) {
      try {
        if (!payload || !payload.frame) return
        var agent = payload.agent
        var cid = agent ? String((agent.session && agent.session.id) || agent.id || '') : ''
        if (!cid) return
        frameStreamSeen = true
        var table = state.activeRuns
        Object.keys(table).forEach(function (sid) {
          var rr = table[sid]; if (!rr) return
          Object.keys(rr).forEach(function (k) {
            var rec = rr[k]
            if (!rec || rec.settled) return
            var mapped = frameSessionIdOf(rec)
            // 事件本身就是身份证据：手工重建/旧形态 rec 若 id 命中，也可安全建立映射；
            // 老 start 的 provider run id 通常不命中，保持日志闸。
            if (!mapped && String(rec.id || '') === cid) { rec.frameSessionId = cid; mapped = cid }
            if (mapped !== cid) return
            // start/chunk/end 全算活；chunk 不过滤 chunk.type，reasoning-delta 同样刷新。只进内存，绝不逐帧写盘。
            rec.lastFrameAt = Date.now()
            rec.frameDirty = true // sweep 据此识别“本轮前有新帧”；不能拿持久基线与时间戳比大小（E2E 会倒推基线）
          })
        })
      } catch (e) { console.error('[task-board] agent/assistant-stream 处理失败:', String(e)) }
    }
    // ===== 挂死零产出检测（task-mvqcoz9l）：在跑 worker/verifier run 日志字节零增长判死重派+喂熔断 =====
    // 原形（2026-10-27 降级实测）：glm-5.2 续跑挂上「连接开着永不响应」形态——会话不死（死会话哨兵
    // listChildren 查不出）、不报错（无 settle 事件）、零产出（日志零增长 7 分钟），running 假相直到
    // 人工终止。熔断/冷却/哨兵全部够不着它。修法：每轮对在跑 worker/verifier run 比对会话日志字节数
    // （logSizeOf）与 run 留档的 lastLogBytes（新字段，每轮写回）：连续 HUNG_ZERO_GROWTH_ROUNDS 轮
    // 零增长且距基线 ≥600s 墙钟地板（固定值，task-mvrt9tn5 二度校准：延迟缩放作废）→ 判定挂死：settleRun 失败臂（记「挂死零产出」，errText
    // 前缀 HUNG_KILL_PREFIX 进 isModelKillFailure 白名单）+ 计入该模型熔断连击（挂死=模型面故障）+
    // 卡重派（settleWorker 失败臂回 pending / settleVerifier 失败臂重排审查）。活体增长即清零计数。
    // 边界（宁少勿多）：
    //   ① 只盖 worker/verifier 在跑 rec（!settled）——decomposer/hook 产出形态不同，不进本检测；
    //   ② 留档行缺失（rec 刚 spawn、recordRunHistory 未落盘）→ 无锚点跳过，下轮再判，绝不在无锚点时判死；
    //   ③ 首见 lastLogBytes 只记基线不计数（老数据无字段同理）——绝不在第一眼把可能真在跑的 run 判死；
    //   ④ 活体增长（size>prev）即清零计数+刷新基线（零增长窗口重新起算）——正常 run 行为零变化；
    //   ⑤ 字节预读在锁外（logSizeOf 走 findRunLog/statSync），比对与计数在锁内（与留档行同一次原子写）；
    //   ⑥ 判死结算在锁外：settleRun 自带认领守卫（runsFor[taskId]!==rec 早退）+ 自己的锁段——结算通道
    //      抢先（事件/上报/终止）则跳过，绝不重复判死；幂等（判死后 rec 摘表，下轮零候选）。
    //   ⑦ 返回本轮判死条数（0=无候选/无判死；调用方据此决定要不要重读快照）。
    async function hungZeroOutputSweep(sid, runs, snap) {
      var cands = []
      Object.keys(runs).forEach(function (k) {
        var rec = runs[k]
        if (rec && !rec.settled && (rec.role === 'worker' || rec.role === 'verifier')) cands.push(rec)
      })
      if (!cands.length || !snap || snap.__noPersist || !Array.isArray(snap.tasks)) return 0
      // ⑤ 字节预读在锁外且只服务兜底候选：帧流已生效且 rec 可映射时不再读日志。
      var sizes = {}
      cands.forEach(function (rec) {
        if (frameStreamSeen && frameSessionIdOf(rec)) return
        sizes[String(rec.id)] = logSizeOf(String(rec.childId || rec.id))
      })
      var hung = [], hungWhy = {}
      await mutateLocked(sid, function (d) {
        if (!d || !Array.isArray(d.tasks)) return null
        var any = false
        cands.forEach(function (rec) {
          try {
            var rid = String(rec.id)
            var t = null
            for (var i = 0; i < d.tasks.length; i++) { if (d.tasks[i] && d.tasks[i].id === rec.taskId) { t = d.tasks[i]; break } }
            if (!t || !Array.isArray(t.runs)) return // ② 卡不存在/无留档：无锚点不判
            var row = null
            for (var j = t.runs.length - 1; j >= 0; j--) {
              var r0 = t.runs[j]
              if (r0 && String(r0.id) === rid && r0.outcome === 'running') { row = r0; break } // 本轮在跑的那条（同 id 首派+续跑取最新）
            }
            if (!row) return // ② 留档缺失：无锚点不判
            // ===== v2 帧活性主路径：全局见过帧 + 本 rec 有可映射会话 id 才启用 =====
            // 薄桩/mock/老 host 零帧，或老 start provider run id 不可映射 → 直接落下方原日志双闸，存量语义逐字不变。
            if (frameStreamSeen && frameSessionIdOf(rec)) {
              var nowFrame = Date.now()
              var lastFrameAt = Number(rec.lastFrameAt || 0)
              var frameSince = typeof row.frameSilenceSince === 'number' ? row.frameSilenceSince : 0
              // 事件只置内存 dirty，sweep 消费后才算“帧恢复”：删持久基线；静默未满 600s 时同步清疑似标卡。
              // 刻意不比较 frameSince < lastFrameAt——E2E 倒推持久基线也满足该大小关系，会把判死编排误吃成恢复。
              var hadFrame = rec.frameDirty === true
              rec.frameDirty = false
              if (hadFrame) {
                var recoverySilence = frameSince ? nowFrame - frameSince : 0
                if (frameSince) { delete row.frameSilenceSince; any = true }
                if (t.stuckSince && recoverySilence < HUNG_FRAME_KILL_MS) {
                  delete t.stuckSince
                  ah(t, t.status, t.status, String(rec.id), 'assistant 帧恢复（静默不足 600s），清除疑似卡顿标记')
                  any = true
                }
                return
              }
              // 零帧 sweep：基线取最近帧，未见过本会话帧则取 startedAt；仅基线缺失时写，安静轮不刷盘。
              // E2E 可 patchBoard 倒推 frameSilenceSince（虚拟时钟推不动 Date.now），与旧日志基线同款可测性。
              if (!frameSince) {
                frameSince = lastFrameAt || Number(rec.startedAt || nowFrame)
                row.frameSilenceSince = frameSince
                any = true
              }
              var frameSilentMs = nowFrame - frameSince
              if (frameSilentMs >= HUNG_FRAME_KILL_MS) {
                hung.push(rec)
                hungWhy[rid] = HUNG_KILL_PREFIX + '帧静默 ' + Math.round(HUNG_FRAME_KILL_MS / 1000) + 's，判挂死按模型面故障结算重派'
                return
              }
              if (frameSilentMs >= HUNG_FRAME_SUSPECT_MS && !t.stuckSince) {
                t.stuckSince = nowFrame
                ah(t, t.status, t.status, String(rec.id), '🟡 疑似卡顿：assistant 帧静默 ' + Math.round(HUNG_FRAME_SUSPECT_MS / 1000) + 's（仅标卡，不终止）')
                any = true
              }
              return
            }
            var size = sizes[rid]
            var prev = typeof row.lastLogBytes === 'number' ? row.lastLogBytes : null
            if (prev === null) { row.lastLogBytes = size; row.zeroGrowthSince = Date.now(); any = true; return } // ③ 首见只记基线
            if (size > prev) { // ④ 活体增长：清零计数 + 刷新基线（零增长窗口重新起算）
              row.lastLogBytes = size; row.zeroGrowthSince = Date.now()
              if (row.zeroGrowthRounds) delete row.zeroGrowthRounds
              any = true; return
            }
            row.zeroGrowthRounds = (row.zeroGrowthRounds || 0) + 1
            any = true
            var since = typeof row.zeroGrowthSince === 'number' ? row.zeroGrowthSince : 0
            // 墙钟闸（task-mvrt9tn5 定稿）：固定 600s 地板——延迟与长生成静默时长无关（三连误杀实证），不再读健康表缩放
            if (row.zeroGrowthRounds >= HUNG_ZERO_GROWTH_ROUNDS && since && Date.now() - since >= HUNG_WALL_FLOOR_MS) hung.push(rec)
          } catch (e) { console.error('[task-board] 挂死检测判定失败 (run ' + (rec && rec.id) + '):', String(e)) }
        })
        return any ? d : null // 无改动返回 null → 不写盘（安静板纪律；有活跃 run 时主锁本就每轮写池快照，增量零额外写）
      }, true) // skipKick：本轮已是 poolCycle；判死结算自会 kick（settleWorker 尾部）
      // ⑥ 判死结算在锁外：失败臂（记「挂死零产出」）+ 熔断连击 + 卡重派。errText 避开冷却嗅探关键词，
      // 挂死只进连击不进冷却（settleWorker 失败臂 sniffModelCooldown 对该文本零命中）。
      var killed = 0
      for (var hi = 0; hi < hung.length; hi++) {
        var hrec = hung[hi]
        try {
          if (hrec.settled || runsFor(sid)[hrec.taskId] !== hrec) continue // 结算通道已抢先，不重复判
          killed++
          // 判死文案带出实际生效阈值（task-mvrt9tn5）：固定值直述「阈值 600s」——不引用健康表延迟，
          // 也不再有「3×0s」假精确 / 「地板值，无实测延迟」分态（缩放已删，阈值对任何模型同值）。
          var wallTxt = Math.round(HUNG_WALL_FLOOR_MS / 1000) + 's'
          // 帧路径只换诊断文案；settleRun 失败臂、HUNG_KILL_PREFIX、熔断与重派链全部复用。
          var why = hungWhy[String(hrec.id)] || (HUNG_KILL_PREFIX + '连续 ' + HUNG_ZERO_GROWTH_ROUNDS + ' 轮会话日志零增长（零产出），超挂死墙钟阈值 ' + wallTxt + '，判挂死按模型面故障结算重派')
          console.log('[task-board] 挂死零产出判死（' + sid + '）：task ' + hrec.taskId + ' run ' + hrec.id + ' ' + why)
          // err 传裸字符串（settleRun 只做 !!err / String(err)）：new Error 会被 String(err) 包上
          // 'Error: ' 前缀，isModelKillFailure 的前缀锚定（index 0）失效 → 熔断连击漏喂。
          await settleRun(sid, hrec, null, why)
        } catch (e) { console.error('[task-board] 挂死判死结算失败 (task ' + hrec.taskId + '):', String(e)) }
      }
      return killed
    }
    return { onAssistantFrame: onAssistantFrame, hungZeroOutputSweep: hungZeroOutputSweep, frameSessionIdOf: frameSessionIdOf }
}
