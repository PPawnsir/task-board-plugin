// dsh-agent-board — 通知层（lib/notify.mjs）
// makeMsg（纯函数，模块级 export，rpc.mjs 直接 import）：插件来源消息构造。
// createNotify(ctx, state, deps)：歧义上报 25s 去抖通知 / 回执批量聚合（45s 或满 5 条）+ 主窗口空闲门控 /
// 系统异常通知队列 / 投递前按看板现状过滤过期项（含 dispatched 派发回执的离场过滤）。共享状态全部经 state 显式注入。
// 回执两类入口共用同一聚合队列：notifyTaskDone（完成/阻塞）+ notifyDispatched（派发即回执）。
// 回执开关（板级 notifyDispatch/notifyDone，设置区「通知」小节）不在本模块判定——闸门在调用方
// （dispatch.mjs 派发/结算处读 cfg 快照），这样歧义裁决通知（notifyMainWindow）天然不受开关影响。

    // makeMsg 支持插件来源标记（参考 dsh-notes 派发模式）：
    // form 'recall' = 背景回执（召回上下文，非指令）；'notice' = 需注意的通知（带一行 summary）
    // 不再用 kind:'user'——插件消息不该冒充用户在说话，模型可据 form 正确理解语义
    // v0.1.7 起会话日志为 format v4：source.kind 必须是「生产者自有 kind」，kind:'plugin'
    // 是已退役的 v3 包装写法，落盘时 persistence 直接抛 SessionFormatError
    // （format v4 message requires a producer-owned source kind）并连带炸掉主窗口当前轮次。
    // v3→v4 迁移把 {kind:'plugin',plugin:'dsh-agent-board'} 映射为 {kind:'plugin:dsh-agent-board'}，
    // 这里直接写迁移后的形态，与存量历史一致；form/summary 作为 source 元数据字段保留。
export function makeMsg(text, form, summary) { var src = { kind: 'plugin:dsh-agent-board' }; if (form) { src.form = form; if (form === 'notice' && summary) src.summary = summary }; return { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), role: 'user', content: [{ type: 'text', text: text }], source: src } }

export function createNotify(ctx, state, deps) {
    var rt = deps.rt, rootForSession = deps.rootForSession, withTimeout = deps.withTimeout, isDispatched = deps.isDispatched
    // 共享状态别名（本体由 index.mjs apply 统一构建并逐模块注入）
    var escNotifyTimers = state.escNotifyTimers
    var receiptBuf = state.receiptBuf
    var receiptedKeys = state.receiptedKeys
    var sysNotesBuf = state.sysNotesBuf

    // 歧义上报通知：任何模式都通知主窗口（escalation 需要人工裁决，不能静默吞掉）
    // ⚠️ 本通道是「裁决通道」不是回执——设置区的回执开关（notifyDispatch/notifyDone）只闸下面两条
    // 回执入队入口（notifyTaskDone/notifyDispatched 的调用方），这里绝不读开关：关掉回执提醒是嫌吵，
    // 关掉歧义提醒会让任务永久卡在等人裁决（闸门放在调用方而非本函数，就是为了让这条通道零开关）。
    // 25s 去抖投递：主窗口 turn 进行中时 followup 只在宿主侧排队，送达时任务常已被裁决/归档（过期回声）；
    // 排队无法撤回，插件侧唯一可行的方案就是延迟 + 投递前重查看板。
    // escNotifyTimers 存每个任务最新一次调度：同一任务再次上报即顶替旧调度（旧回调身份不匹配 → 静默丢弃）；
    // 投递时才读 escalation.question，所以连续多次上报只会收到一条、且一定是最新疑问。
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
    // 回执幂等去重表：key = 任务id + 类别 + 完成事件指纹（deliverable/verification/resolvedAt/末条history 时间戳）。
    // 同一完成事件被任何路径（工具直报/run 结算/未来回归）重复通知时指纹一致 → 吞掉；
    // 驳回后重做完成 → 时间戳全换新 → 指纹不同 → 正常回执。
    // 回执入队（共享内核，notifyTaskDone / notifyDispatched 两条入口共用同一 45s 聚合队列）：
    // 幂等去重表 key = 任务id + 类别指纹 + 事件时间戳（1h TTL 清超龄键）；入队后满 5 条立即冲刷，
    // 否则挂 45s 窗口（timer 不可用则同步冲刷）。
    function pushReceipt(sid, key, item) {
      if (receiptedKeys[key]) return
      var rkeys = Object.keys(receiptedKeys)
      if (rkeys.length > 512) { var rnow = Date.now(); for (var ri = 0; ri < rkeys.length; ri++) { if (rnow - receiptedKeys[rkeys[ri]] > 3600000) delete receiptedKeys[rkeys[ri]] } }
      receiptedKeys[key] = Date.now()
      var buf = receiptBuf[sid] || (receiptBuf[sid] = { items: [], timer: null })
      buf.items.push(item)
      if (buf.items.length >= 5) { flushReceipts(sid); return }
      if (!buf.timer) {
        var tm = ctx.timer
        if (tm) { var captured = buf; buf.timer = tm.timeout(45000).then(function () { if (receiptBuf[sid] === captured) flushReceipts(sid) }).catch(function () {}) }
        else flushReceipts(sid)
      }
    }
    function notifyTaskDone(sid, t, kind) {
      if (!t || !isDispatched(sid, t.claimedBy)) return
      var lastHist = (t.history && t.history.length) ? String(t.history[t.history.length - 1].timestamp || '') : ''
      var stamp = [kind, (t.deliverable && t.deliverable.at) || '', (t.verification && t.verification.at) || '', t.resolvedAt || '', lastHist].join('|')
      var lastNote = (t.history && t.history.length) ? String(t.history[t.history.length - 1].note || '') : ''
      pushReceipt(sid, t.id + ':' + stamp, { kind: kind, title: t.title, id: t.id, summary: (t.deliverable && t.deliverable.summary) || '', note: lastNote })
    }
    // 派发即回执：任务被 Worker/Verifier 领走（spawn 成功）时入同一聚合队列，flush 出「🚀 已派发」区。
    // 为什么与完成回执同队列：派发与完成常在同一 45s 窗口内（10 秒探针卡），分两条消息会刷屏；
    // 同一条摘要里「已派发 → 完成/阻塞」相邻呈现，人一眼看清生命周期。role = worker/verifier。
    // 判定用 claimedBy 真值（派发回执不依赖 dispatchedEver 的 run 记账——那条判定是给完成回执区分
    // 「派发执行 vs 主窗口手动」用的；派发回执本身只可能由派发路径调用，天然是派发任务）。
    function notifyDispatched(sid, t, role) {
      if (!t || !t.id || !t.claimedBy) return
      var stamp = 'dispatched|' + String(role || 'worker') + '|' + (t.claimedAt || t.verifierRunAt || '')
      pushReceipt(sid, t.id + ':' + stamp, { kind: 'dispatched', role: String(role || 'worker'), title: t.title, id: t.id, summary: '', note: '' })
    }
    // 系统级异常通知队列（易失，随回执冲刷）：模型熔断/spawn 失败/孤儿回收/看门狗标记
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
        var done = [], blocked = [], dispatched = []
        for (var i = 0; i < items.length; i++) { (items[i].kind === 'resolved' ? done : (items[i].kind === 'dispatched' ? dispatched : blocked)).push(items[i]) }
        var lines = [items.length ? '📋 [任务看板] 回执摘要（' + items.length + ' 条）' : '📋 [任务看板] 系统通知', '']
        if (dispatched.length) {
          lines.push('🚀 已派发 ' + dispatched.length + ' 个：')
          for (var d = 0; d < dispatched.length && d < 8; d++) lines.push('  · ' + dispatched[d].title + ' (' + dispatched[d].id + ') — ' + (dispatched[d].role === 'verifier' ? 'Verifier 验收中' : 'Worker 执行中'))
        }
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
          //    dispatched（派发即回执）：入队到 flush 之间任务可能已离场（10 秒探针卡快速完成、
          //    被人取消/归档）——任务已不在 in-progress 说明「已派发」这条时效性信息已过期，
          //    丢弃以免与同窗口的完成回执重复刷屏（完成回执本身就是主通道，信息不丢）。
          //    rt 读盘失败（tt 为 null）时保留，不因瞬时读盘错误吞掉派发回执。
          var keptItems = []
          for (var j = 0; j < items.length; j++) {
            var it = items[j]
            var tt = findTask(it.id)
            if (tt && tt.status === 'archived') continue
            if (it.kind === 'dispatched' && tt && tt.status !== 'in-progress') continue
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

    return { maybeNotify: maybeNotify, notifyTaskDone: notifyTaskDone, notifyDispatched: notifyDispatched, pushSysNote: pushSysNote }
}
