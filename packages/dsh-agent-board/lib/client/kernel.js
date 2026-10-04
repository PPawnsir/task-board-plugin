// ============================================================================
// kernel —— 底座域：渲染原语（ic/icText/ActorLink）· RPC 封装（rpc + fetchTasks 轮询族）
//   · 共享状态（state/listeners/notify）· 图标（ICONS）· 共享任务工具（筛选/依赖/管线/耗时）
//   · 面板骨架入口（BoardButton / ViewTab / TopPanel / slots.inject）
// 本文件是 apply(ctx) 函数体片段，不可独立运行；由 scripts/build-client.cjs 按序拼接生成 lib/client.js。
// ============================================================================

    // 硬依赖声明（见文件尾 module.exports）：新版 dsh（0.1.5-rc.2）启动顺序下，
    // 不声明 inject 时 apply 先于 slots/sessions/timer 服务注册执行，
    // ctx.get 返回 undefined → 静默退出 → 看板按钮消失。声明后 runner 等服务就绪再 apply。
    var slots = ctx.get('slots')
    if (slots === undefined) return
    var sessionsSvc = ctx.get('sessions')
    // 会话跳转走 uiWorkspace.openSession（0.1.7 起 sessions 服务已无 open 方法，
    // 旧调用 sessionsSvc.open 会抛 TypeError: sessionsSvc.open is not a function）
    var uiWorkspaceSvc = ctx.get('uiWorkspace')
    var C = { bg: 'var(--dsw-alias-bg-base)', card: 'var(--dsw-alias-bg-layer-1)', nested: 'var(--dsw-alias-bg-layer-2)', border: 'var(--dsw-alias-border-l1)', border2: 'var(--dsw-alias-border-l2)', brand: 'var(--dsw-alias-brand-primary)', text: 'var(--dsw-alias-label-primary)', text2: 'var(--dsw-alias-label-secondary)', err: 'var(--dsw-alias-state-error-primary)', ok: 'var(--dsw-alias-state-success-primary)', warn: 'var(--dsw-alias-state-warn-primary)' }
    var C_INV = 'var(--dsw-alias-label-primary-inverted)' // 品牌底/彩色底上的反色文字（深浅模式自动反转）
    var prioColor = { critical: C.err, high: C.warn, medium: C.brand, low: C.text2 }
    var prioLabel = { critical: '紧急', high: '高', medium: '中', low: '低' }
    var statusLabels = { draft: '草稿', pending: '待办', 'in-progress': '进行中', verifying: '验证中', resolved: '已完成', blocked: '阻塞', cancelled: '已取消', archived: '已归档' }
    var statusColors = { draft: C.text2, pending: C.text2, 'in-progress': C.brand, verifying: C.warn, resolved: C.ok, blocked: C.err, archived: C.text2 }
    // 工作模式三档（v75 收敛）：内部仍存 boardMode/teamMode 两个 flag，UI 只呈现一维三档
    var workModeNames = { list: '清单模式', auto: '自动派发', team: 'Team 托管' }

    // ===== 图标收口（docs/icon-style-guide.md：Lucide 线性 SVG，currentColor 跟随主题）=====
    // ICONS 存 [tag, attrs] 数组，用 createElement 逐个渲染（避免 dangerouslySetInnerHTML 受限）
    var ICONS = {
      'clipboard-list': [
        ['rect', { x: 8, y: 2, width: 8, height: 4, rx: 1 }],
        ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }],
        ['path', { d: 'M12 11h4' }],
        ['path', { d: 'M12 16h4' }],
        ['path', { d: 'M8 11h.01' }],
        ['path', { d: 'M8 16h.01' }]
      ],
      'bar-chart-3': [
        ['path', { d: 'M3 3v18h18' }],
        ['path', { d: 'M18 17V9' }],
        ['path', { d: 'M13 17V5' }],
        ['path', { d: 'M8 17v-3' }]
      ],
      'alert-triangle': [
        ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
        ['path', { d: 'M12 9v4' }],
        ['path', { d: 'M12 17h.01' }]
      ],
      'zap': [
        ['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }]
      ],
      'check': [
        ['path', { d: 'M20 6 9 17l-5-5' }]
      ],
      'check-circle': [
        ['circle', { cx: 12, cy: 12, r: 10 }],
        ['path', { d: 'm9 12 2 2 4-4' }]
      ],
      'x-circle': [
        ['circle', { cx: 12, cy: 12, r: 10 }],
        ['path', { d: 'm15 9-6 6' }],
        ['path', { d: 'm9 9 6 6' }]
      ],
      'x': [
        ['path', { d: 'M18 6 6 18' }],
        ['path', { d: 'm6 6 12 12' }]
      ],
      'refresh-cw': [
        ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
        ['path', { d: 'M21 3v5h-5' }],
        ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
        ['path', { d: 'M8 16H3v5' }]
      ],
      'save': [
        ['path', { d: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }],
        ['path', { d: 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7' }],
        ['path', { d: 'M7 3v4a1 1 0 0 0 1 1h7' }]
      ],
      'archive': [
        ['rect', { width: 20, height: 5, x: 2, y: 3, rx: 1 }],
        ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' }],
        ['path', { d: 'M10 12h4' }]
      ],
      // 删除入口图标（草稿/待办/阻塞卡片 hover 小按钮、详情页按钮、批量删除共用）
      'trash-2': [
        ['path', { d: 'M3 6h18' }],
        ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }],
        ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
        ['path', { d: 'M10 11v6' }],
        ['path', { d: 'M14 11v6' }]
      ],
      'package': [
        ['path', { d: 'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z' }],
        ['path', { d: 'M12 22V12' }],
        ['path', { d: 'm3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7' }],
        ['path', { d: 'm7.5 4.27 9 5.15' }]
      ],
      'clipboard-check': [
        ['rect', { width: 8, height: 4, x: 8, y: 2, rx: 1, ry: 1 }],
        ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }],
        ['path', { d: 'm9 14 2 2 4-4' }]
      ],
      'clipboard-x': [
        ['rect', { width: 8, height: 4, x: 8, y: 2, rx: 1, ry: 1 }],
        ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }],
        ['path', { d: 'm15 11-6 6' }],
        ['path', { d: 'm9 11 6 6' }]
      ],
      'scale': [
        ['path', { d: 'm16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z' }],
        ['path', { d: 'm2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z' }],
        ['path', { d: 'M7 21h10' }],
        ['path', { d: 'M12 3v18' }],
        ['path', { d: 'M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2' }]
      ],
      'users': [
        ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }],
        ['circle', { cx: 9, cy: 7, r: 4 }],
        ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }],
        ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }]
      ],
      'bot': [
        ['path', { d: 'M12 8V4H8' }],
        ['rect', { width: 16, height: 12, x: 4, y: 8, rx: 2 }],
        ['path', { d: 'M2 14h2' }],
        ['path', { d: 'M20 14h2' }],
        ['path', { d: 'M15 13v2' }],
        ['path', { d: 'M9 13v2' }]
      ],
      'user': [
        ['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }],
        ['circle', { cx: 12, cy: 7, r: 4 }]
      ],
      'calendar-days': [
        ['rect', { x: 3, y: 4, width: 18, height: 18, rx: 2 }],
        ['path', { d: 'M16 2v4M8 2v4M3 10h18' }],
        ['path', { d: 'M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01' }]
      ],
      'chevron-up': [
        ['path', { d: 'm18 15-6-6-6 6' }]
      ],
      'layout-grid': [
        ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1 }],
        ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1 }],
        ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1 }],
        ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1 }]
      ],
      'activity': [
        ['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]
      ],
      'file-down': [
        ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z' }],
        ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
        ['path', { d: 'M12 18v-6M9 15l3 3 3-3' }]
      ],
      'chevron-down': [
        ['path', { d: 'm6 9 6 6 6-6' }]
      ],
      'chevron-right': [
        ['path', { d: 'm9 18 6-6-6-6' }]
      ],
      'settings': [
        ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
        ['circle', { cx: 12, cy: 12, r: 3 }]
      ],
      'rocket': [
        ['path', { d: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z' }],
        ['path', { d: 'm12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z' }],
        ['path', { d: 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0' }],
        ['path', { d: 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5' }]
      ],
      'flask-conical': [
        ['path', { d: 'M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2' }],
        ['path', { d: 'M8.5 2h7' }],
        ['path', { d: 'M7 16h10' }]
      ],
      'file-text': [
        ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
        ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
        ['path', { d: 'M16 13H8' }],
        ['path', { d: 'M16 17H8' }],
        ['path', { d: 'M10 9H8' }]
      ],
      'message-square': [
        ['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]
      ],
      'square-check-big': [
        ['path', { d: 'M21 10.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.5' }],
        ['path', { d: 'm9 11 3 3L22 4' }]
      ],
      'square': [
        ['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }]
      ],
      'stop-circle': [
        ['circle', { cx: 12, cy: 12, r: 10 }],
        ['rect', { width: 6, height: 6, x: 9, y: 9 }]
      ],
      'plus': [
        ['path', { d: 'M5 12h14' }],
        ['path', { d: 'M12 5v14' }]
      ],
      'book-open': [
        ['path', { d: 'M12 7v14' }],
        ['path', { d: 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z' }]
      ]
    }

    // 图标+文字内联组合的快捷渲染
    function icText(name, size, text) { return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic(name, size), text) }
    function ic(name, size) {
      var def = ICONS[name]
      if (!def) return null
      return React.createElement('svg', {
        width: size || 14, height: size || 14, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'inline-block', verticalAlign: '-2px', flexShrink: 0 }
      }, def.map(function (p, i) { return React.createElement(p[0], Object.assign({ key: i }, p[1])) }))
    }

    var COLUMNS = ['draft', 'pending', 'in-progress', 'verifying', 'resolved', 'blocked']
    var reqEpoch = 0 // 会话切换纪元：切会话时自增，旧会话在途响应按纪元丢弃
    var state = { sessionId: null, tasks: [], boardMode: 'auto', teamMode: false, workMode: 'auto', minWorkers: 1, maxWorkers: 3, minVerifiers: 0, maxVerifiers: 2, workerModel: '', verifierModel: '', softTimeoutMin: 30, hardTimeoutMin: 120, feedbackEnabled: true, lessonPushed: {}, isRoot: true, open: false, detailId: null, children: [], dragOver: null, dragTask: null, dispatchInfo: '', view: 'board', layoutLeft: 280, layoutRight: 0, poolStatus: null, escalatedIds: [], filterQ: '', filterPrio: [], filterTag: '', selectMode: false, selected: {}, undoSnapshot: null, cardHover: '', archSort: 'time-desc', dateRange: { from: '', to: '' }, rfOpen: false, gboOpen: false, activity: {}, archived: [], archQ: '', globalBoards: [], createOpen: false, createFlash: '', usageSummary: null, childStats: {}, tasksErr: '', tasksHash: '' }

    // #16 快捷键：Esc 逐级关闭（详情→看板→面板）；输入框聚焦时不劫持
    try {
      var onKey = function (e) {
        if (e.key !== 'Escape') return
        var ae = document.activeElement
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return
        if (!state.open) return
        if (state.createOpen) { state.createOpen = false; notify() }
        else if (state.detailId) { state.detailId = null; notify() }
        else if (state.selectMode) { state.selectMode = false; state.selected = {}; notify() }
        else { state.open = false; notify() }
        e.stopPropagation()
      }
      document.addEventListener('keydown', onKey, true)
      ctx.effect(function () { return function () { document.removeEventListener('keydown', onKey, true) } })
    } catch (_) {}

    // 注入 escalation 脉冲 + critical 辉光动画样式
    try { var stEl = document.createElement('style'); stEl.textContent = '@keyframes tskb-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.12)}}@keyframes tskb-crit{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 12px 2px rgba(239,68,68,.22)}}'; document.head.appendChild(stEl); ctx.effect(function () { return function () { try { stEl.remove() } catch (_) {} } }) } catch (_) {}

    var listeners = []
    function notify() { listeners.forEach(function (fn) { try { fn(state) } catch (_) {} }) }
    function rpc(method, args) { var a = args || {}; a.sessionId = state.sessionId; return fetch('/dsh-agent-board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: method, args: a }) }).then(function (r) { return r.json() }) }

    // ===== 读路径错误防线（反馈 n-mut9q600tnpx）=====
    // {error} 响应 / 网络 reject 一律保留旧数据（旧卡片继续显示）+ 面板头部下方非阻断错误条，
    // 下次成功自动消失；绝不把 {error} 当空板渲染。console.warn 30s 去抖——3s 轮询失败每次都打会刷屏。
    var readErrWarnAt = 0
    function reportReadErr(msg) {
      state.tasksErr = msg
      var now = Date.now()
      if (now - readErrWarnAt > 30000) { readErrWarnAt = now; try { console.warn('[task-board] ' + msg) } catch (_) {} }
      notify()
    }
    function clearReadErr() { state.tasksErr = '' } // 仅 fetchTasks 成功路径调用（3s 轮询兜底，任何错误条都能随之消失）
    function readErrText(e) { return String((e && e.message) || e || '网络异常') }

    function fetchTasks() {
      if (!state.sessionId) return
      var epoch = reqEpoch
      rpc('get-tasks').then(function (d) {
        if (epoch !== reqEpoch) return // 会话已切换，丢弃过期响应
        if (d && d.error) { reportReadErr('看板数据刷新失败：' + d.error); return } // error 分支：保留旧 tasks/设置，绝不当空板渲染
        clearReadErr()
        // 渲染节约（反馈 n-mut9rzs2mkhg）：host 附 tasksHash（任务关键字段的稳定 hash，口径见 host core.tasksHash）。
        // hash 相同 → 任务列表实质没变：跳过 state.tasks 赋值与 notify（3s 轮询大头是空转重渲染）。
        // 注意区分：tasksErr 清除、boardMode/usageSummary/healthHints/childStats 等轻量字段照常赋值
        // （hash 只管任务列表渲染；这些字段随下次任意 notify 生效，不为它们单独渲染）。
        // 老 host 不返回 tasksHash → 恒视为变化，行为与旧版完全一致。
        var newHash = (d && d.tasksHash) || ''
        var tasksChanged = !newHash || newHash !== state.tasksHash
        if (tasksChanged) {
          state.tasksHash = newHash
          state.tasks = (d && d.tasks) || []
        }
        state.boardMode = (d && d.boardMode) || 'auto'
        state.teamMode = !!(d && d.teamMode)
        // 工作模式（三档）读取：优先用服务端派生字段 workMode，缺失时按同口径本地兜底派生
        // （兼容老 host：老版本 get-tasks 不返回 workMode）
        state.workMode = (d && d.workMode) || (state.teamMode ? 'team' : (state.boardMode === 'auto' ? 'auto' : 'list'))
        state.minWorkers = (d && d.minWorkers) || 1
        state.maxWorkers = (d && d.maxWorkers) || 3
        state.minVerifiers = (d && d.minVerifiers) || 0
        state.maxVerifiers = (d && d.maxVerifiers) || 2
        state.verifierModel = (d && d.verifierModel) || ''
        state.workerModel = (d && d.workerModel) || ''
        state.softTimeoutMin = (d && d.softTimeoutMin) || 30
        state.hardTimeoutMin = (d && d.hardTimeoutMin) || 120
        state.poolStatus = (d && d.poolStatus) || null
        state.usageSummary = (d && d.usageSummary) || null // token 消耗聚合（board 级，host 端现算）
        // 架构健康提示（架构自省 L1）：与 tasks 同源透传，HealthHints 组件直接读 state.healthHints，
        // 不再自持 rpc('get-tasks')——消灭仪表盘打开期间的双轮询。老 host 无此字段 → 空数组零渲染
        state.healthHints = (d && Array.isArray(d.healthHints)) ? d.healthHints : []
        // 史诗父卡语义层：childStats 由 host 按 tasks 现算（{parentId:{total,resolved,active,activeTitle}}）。
        // 缺省兼容——老 host 不返回该字段时置空对象，卡片/详情层遇空一律不渲染相关元素
        state.childStats = (d && d.childStats) || {}
        // 学习飞轮 v1 能力检测：老 host 不返回该字段 → 视为开启（默认开）；只有显式 false 才关。
        state.feedbackEnabled = !(d && d.feedbackEnabled === false)
        state.isRoot = !d || d.isRoot !== false
        if (state.isRoot === false && state.open) { state.open = false; state.detailId = null } // 子代理会话：强制收起看板
        if (d && d.dispatchInfo && d.dispatchInfoAt && Date.now() - new Date(d.dispatchInfoAt).getTime() < 120000) { state.dispatchInfo = d.dispatchInfo } else { state.dispatchInfo = '' } // 瞬时通知 2min 内有效，过期强制清空（服务端写后不清曾致残留数天）
        // escalation 一等公民：出现新的待裁决任务 → 面板自动弹开直达该任务详情
        // （escalation.question 在 tasksHash 序列化口径内：新歧义必然改变 hash → 必然走变化分支，不会漏弹）
        if (tasksChanged) {
          var newEsc = state.tasks.filter(function (t) { return t.escalation && state.escalatedIds.indexOf(t.id) < 0 })
          state.escalatedIds = state.tasks.filter(function (t) { return t.escalation }).map(function (t) { return t.id })
          if (newEsc.length > 0) { state.open = true; state.view = 'board'; state.detailId = newEsc[0].id }
          notify()
        }
      }).catch(function (e) { if (epoch !== reqEpoch) return; reportReadErr('看板数据刷新失败：' + readErrText(e)) }) // 网络 reject 同口径
    }

    // fetchChildren 同病同药：{error} 保留旧 children + 错误条；成功路径不清条（交给 fetchTasks 成功兜底清除，避免并发响应互相抢）
    function fetchChildren() { if (!state.sessionId) return; var epoch = reqEpoch; rpc('list-children').then(function (d) { if (epoch !== reqEpoch) return; if (d && d.error) { reportReadErr('子任务列表刷新失败：' + d.error); return } state.children = (d && d.children) || []; notify() }).catch(function (e) { if (epoch !== reqEpoch) return; reportReadErr('子任务列表刷新失败：' + readErrText(e)) }) }

    // 活动心跳：对进行中/验收中的任务轮询子代理最近动作（卡片与详情展示"现在跑到哪了"）
    function fetchActivity() {
      if (!state.sessionId || !state.isRoot || !state.open) return // 面板关闭时不轮询活动（省同步 I/O）
      var running = state.tasks.filter(function (t) { return t.status === 'in-progress' || t.status === 'verifying' })
      if (!running.length) { if (Object.keys(state.activity).length) { state.activity = {}; notify() } return }
      var pending = running.length
      running.forEach(function (t) {
        var epoch = reqEpoch
        rpc('agent-activity', { taskId: t.id }).then(function (r) {
          if (epoch !== reqEpoch) return // 会话已切换，丢弃过期响应
          pending--
          var act = (r && r.activity) || null
          if (state.activity[t.id] !== act) { state.activity[t.id] = act; notify() }
          else if (pending === 0) notify()
        }).catch(function () { pending-- })
      })
    }

    function fetchArchived() {
      if (!state.sessionId) return
      var epoch = reqEpoch
      rpc('get-tasks', { includeArchived: true }).then(function (d) {
        if (epoch !== reqEpoch) return
        state.archived = ((d && d.tasks) || []).filter(function (t) { return t.status === 'archived' })
        notify()
      }).catch(function () {})
    }

    var __timer = ctx.get('timer')
    // 轮询：get-tasks 已是纯读（v71），3s 开销低；面板关闭时也轮询以更新角标
    if (__timer) ctx.effect(function () { return __timer.interval(fetchTasks, 3000) })
    if (__timer) ctx.effect(function () { return __timer.interval(fetchActivity, 12000) })

    function readLayoutOffsets() {
      try {
        var frames = document.querySelectorAll('[data-sidebar-collapsed], [data-details-collapsed]')
        for (var i = 0; i < frames.length; i++) {
          var gtc = getComputedStyle(frames[i]).gridTemplateColumns
          if (gtc) { var parts = gtc.split(/\s+/); return { sidebar: parseInt(parts[0]) || 0, details: parts.length >= 3 ? (parseInt(parts[parts.length - 1]) || 0) : 0 } }
        }
        var all = document.querySelectorAll('[style*="grid-template-columns"]')
        for (var j = 0; j < all.length; j++) { var s = all[j].style.gridTemplateColumns; var m = s.match(/^(\d+)px/); var m2 = s.match(/(\d+)px$/); return { sidebar: m ? parseInt(m[1]) : 280, details: m2 ? parseInt(m2[1]) : 0 } }
      } catch (_) {}
      return { sidebar: 280, details: 0 }
    }

    function syncLayout() { var o = readLayoutOffsets(); if (o.sidebar !== state.layoutLeft || o.details !== state.layoutRight) { state.layoutLeft = o.sidebar; state.layoutRight = o.details; notify() } }
    // 去抖：切会话时 body 子树 style 大面积变动会触发回调风暴，300ms 合并一次
    var layoutTimer = null
    function syncLayoutDebounced() { if (layoutTimer) return; layoutTimer = setTimeout(function () { layoutTimer = null; syncLayout() }, 300) }
    ctx.effect(function () { return function () { if (layoutTimer) { clearTimeout(layoutTimer); layoutTimer = null } if (createFlashTimer) { clearTimeout(createFlashTimer); createFlashTimer = null } } })
    try { var ro = new ResizeObserver(function () { syncLayoutDebounced() }); ro.observe(document.body); ctx.effect(function () { return function () { ro.disconnect() } }) } catch (_) {}
    try { var mo = new MutationObserver(function () { syncLayoutDebounced() }); mo.observe(document.body, { attributes: true, attributeFilter: ['style'], subtree: true }); ctx.effect(function () { return function () { mo.disconnect() } }) } catch (_) {}
    syncLayout()

    // 创建任务后的轻提示（头部短暂显示"✅ 已存草稿/已创建任务"，2.5s 后自动清空；不引入 toast 体系）
    var createFlashTimer = null
    function flashCreated(msg) {
      state.createFlash = msg
      if (createFlashTimer) clearTimeout(createFlashTimer)
      createFlashTimer = setTimeout(function () { createFlashTimer = null; state.createFlash = ''; notify() }, 2500)
    }

    function ago(iso) { if (!iso) return ''; var ms = Date.now() - new Date(iso).getTime(); if (ms < 60000) return '刚刚'; if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前'; if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前'; return Math.floor(ms / 86400000) + ' 天前' }
    function fmtTime(iso) { if (!iso) return '-'; try { return new Date(iso).toLocaleString() } catch (_) { return iso } }
    function getTask(id) { return state.tasks.find(function (t) { return t.id === id }) }
    function shortId(sid) { return sid ? String(sid).slice(0, 14) : '' }
    function jumpTo(actorId) { if (uiWorkspaceSvc && actorId && actorId !== 'system' && actorId !== 'unknown' && actorId !== 'auto-dispatch') uiWorkspaceSvc.openSession(actorId) }

    function transition(taskId, from, to) {
      if (from === to) return
      var ok = function () { fetchTasks() }; var fail = function () { fetchTasks() }
      if (to === 'pending' && from === 'draft') rpc('update-task', { taskId: taskId, publish: true }).then(ok).catch(fail)
      else if (to === 'pending' && from === 'blocked') rpc('update-task', { taskId: taskId, resetToPending: true }).then(ok).catch(fail) // 阻塞任务拖回待办=重新投放
      else if (to === 'in-progress' && (from === 'pending' || from === 'blocked')) rpc('claim-task', { taskId: taskId }).then(ok).catch(fail)
      else if (to === 'verifying' && from === 'in-progress') { var res = window.prompt('提交验证 — 解决说明（必填）：'); if (res) rpc('resolve-task', { taskId: taskId, status: 'verifying', resolution: res }).then(ok).catch(fail) }
      else if (to === 'resolved' && from === 'verifying') rpc('verify-task', { taskId: taskId, verdict: 'approved' }).then(ok).catch(fail)
      else if (to === 'in-progress' && from === 'verifying') { var c = window.prompt('驳回原因（可选）：'); rpc('verify-task', { taskId: taskId, verdict: 'rejected', comment: c || '' }).then(ok).catch(fail) }
      else if (to === 'blocked' && from === 'in-progress') { var r = window.prompt('阻塞原因（可选）：') || ''; rpc('resolve-task', { taskId: taskId, status: 'blocked', resolution: r }).then(ok).catch(fail) }
      else if (to === 'archived' && from === 'resolved') rpc('archive-task', { taskId: taskId }).then(ok).catch(fail)
    }

    // ===== 删除通道（与 host delete-task / batch-op delete 门禁一一对应）=====
    // 可删状态：草稿/待办/阻塞（未产生执行痕迹）。in-progress/verifying 需先终止；resolved/cancelled 引导归档；
    // 有未归档子任务时 host 会拒删——客户端只做"按钮是否出现"的粗筛，真正的门禁以 host 返回的 error 为准。
    function canDelete(t) { return !!t && (t.status === 'draft' || t.status === 'pending' || t.status === 'blocked') }
    // 误删防呆：真删不可恢复，必须先过 window.confirm（详情页/卡片/批量三处入口共用同一句提示语）
    // 失败时把 host 的中文门禁原因原样回显（如"请先用 terminate-agent 终止"），不做二次翻译。
    function deleteTask(id, title, onMsg) {
      var t = getTask(id)
      var name = title || (t && t.title) || id
      if (!window.confirm('删除不可恢复，确认删除「' + name + '」？')) return Promise.resolve({ ok: false, cancelled: true })
      return rpc('delete-task', { taskId: id }).then(function (r) {
        if (r && r.ok === false) { if (onMsg) onMsg('⚠️ ' + (r.error || '删除失败')) }
        else if (onMsg) onMsg('🗑 已删除「' + name + '」')
        if (state.detailId === id) state.detailId = null // 详情页开着被删任务 → 关掉，避免下一帧渲染"任务不存在"
        fetchTasks()
        return r
      }).catch(function (e) { if (onMsg) onMsg('⚠️ ' + String(e)); return { ok: false, error: String(e) } })
    }

    function onDragStart(e, task) { e.dataTransfer.setData('text/plain', JSON.stringify({ id: task.id, status: task.status })); e.dataTransfer.effectAllowed = 'move'; state.dragTask = task.id; notify() }
    function onDragEnd() { state.dragTask = null; state.dragOver = null; notify() }
    function onColDragOver(e, st) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (state.dragOver !== st) { state.dragOver = st; notify() } }
    function onColDragLeave(st) { if (state.dragOver === st) { state.dragOver = null; notify() } }
    function onColDrop(e, st) { e.preventDefault(); try { var data = JSON.parse(e.dataTransfer.getData('text/plain')); state.dragOver = null; state.dragTask = null; transition(data.id, data.status, st); notify() } catch (_) {} }

    // #13 筛选：文本（标题/描述/ID）+ 优先级多选 + 标签
    function passFilter(t) {
      var q = state.filterQ.trim().toLowerCase()
      if (q && (t.title + ' ' + (t.description || '') + ' ' + t.id).toLowerCase().indexOf(q) < 0) return false
      if (state.filterPrio.length > 0 && state.filterPrio.indexOf(t.priority || 'medium') < 0) return false
      if (state.filterTag && (t.tags || []).indexOf(state.filterTag) < 0) return false
      return true
    }
    function allTags() { var s = {}; state.tasks.forEach(function (t) { (t.tags || []).forEach(function (g) { s[g] = 1 }) }); return Object.keys(s) }
    // #18 依赖未满足判断（依赖不存在视为阻塞——创建时已校验，防御性兜底）
    function depsBlocked(t) { if (!Array.isArray(t.dependsOn) || t.dependsOn.length === 0) return false; return t.dependsOn.some(function (id) { var d = getTask(id); return !d || (d.status !== 'resolved' && d.status !== 'archived') }) }
    // #19 管线档位元数据
    var pipeMeta = { full: { icon: 'flask-conical', label: '全流程（执行+验证）', short: '全流程' }, work: { icon: 'file-text', label: '免验证（只做不验）', short: '免验' }, direct: { icon: 'message-square', label: '主窗口直接处理', short: '直办' } }
    // ===== 耗时口径三分离（task-mutdnitw）：排队 ≠ 执行 ≠ 验收，不再把排队算进耗时 =====
    // waitOf：⏳ 排队时长 = createdAt → claimedAt（未领取则统计到 now）——"等了多久"
    // execOf：⏱ 执行时长 = claimedAt → resolvedAt/archivedAt（未定则统计到 now）——"干了多久"
    //   无 claimedAt（手工/direct 卡没有领取动作）回退原口径 createdAt → resolvedAt/archivedAt/now
    // （验收时长 = resolvedAt → verifiedAt，仪表盘 verifyTimes 已有此口径，卡片不展示）
    function fmtDur(s, e) { var m = Math.max(0, Math.round((e - s) / 60000)); if (m < 1) return '<1m'; if (m < 60) return m + 'm'; var h = Math.floor(m / 60); return h + 'h' + (m % 60 ? (m % 60) + 'm' : '') }
    function waitOf(t) { try { var s = t.createdAt ? new Date(t.createdAt).getTime() : 0; if (!s) return ''; var e = t.claimedAt ? new Date(t.claimedAt).getTime() : Date.now(); return fmtDur(s, e) } catch (_) { return '' } }
    function execOf(t) { try { var sRaw = t.claimedAt || t.createdAt; var s = sRaw ? new Date(sRaw).getTime() : 0; if (!s) return ''; var eRaw = t.resolvedAt || t.archivedAt; var e = eRaw ? new Date(eRaw).getTime() : Date.now(); return fmtDur(s, e) } catch (_) { return '' } }
    // 卡片耗时徽章：draft/pending（还在排队）显「⏳ 等待」；执行后（含 blocked/归档）显「⏱ 执行」；tooltip 写清口径
    function cardDur(t) {
      var st = t.status
      if (st === 'draft' || st === 'pending') { var w = waitOf(t); return w ? { txt: '⏳ 等待 ' + w, tip: '⏳ 排队时长：创建 → 被领取（还没被领取则统计创建至今）——"等了多久"，不含执行' } : null }
      var x = execOf(t)
      return x ? { txt: '⏱ 执行 ' + x, tip: '⏱ 执行时长：被领取 → 完成/归档（进行中则统计领取至今）——"干了多久"，不含排队与验收' + (t.claimedAt ? '' : '；本卡无领取记录（手工/直办），按创建起算') } : null
    }
    function elapsedMin(iso) { var s = iso ? new Date(iso).getTime() : 0; if (!s) return 0; return Math.max(0, Math.round((Date.now() - s) / 60000)) }
    // 历史会话列表：优先用 host 留档的 t.runs（含全部重试）；老任务回退到 claimedBy/verifierRun
    function historyRuns(t) {
      var out = Array.isArray(t.runs) ? t.runs.slice() : []
      if (!out.length) {
        if (t.claimedBy && t.claimedBy !== 'auto-dispatch' && t.claimedBy !== 'system') out.push({ role: 'worker', id: t.claimedBy, at: t.claimedAt })
        if (t.verifierRun) out.push({ role: 'verifier', id: t.verifierRun, at: t.verifiedAt })
      }
      return out.filter(function (r) { return r && r.id })
    }
    function elapsedSince(iso) { var m = elapsedMin(iso); if (!m) return '<1m'; if (m < 60) return m + 'm'; var h = Math.floor(m / 60); return h + 'h' + (m % 60 ? (m % 60) + 'm' : '') }
    function pipeOf(t) { return pipeMeta[t.pipeline] || pipeMeta.full }

    function ActorLink(props) { var id = props.id; if (!id || id === 'system' || id === 'unknown' || id === 'auto-dispatch') return React.createElement('span', { style: { color: C.text2 } }, id || '-'); return React.createElement('span', { onClick: function (e) { e.stopPropagation(); jumpTo(id) }, style: { color: C.brand, cursor: 'pointer', textDecoration: 'underline' }, title: '跳转到 ' + id }, shortId(id)) }

    function BoardButton(props) {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(0), pendingCount = _a[0], setPendingCount = _a[1]; var _b = useState(false), isOpen = _b[0], setIsOpen = _b[1]; var _c = useState(0), escCount = _c[0], setEscCount = _c[1]; var _d2 = useState(true), isRoot = _d2[0], setIsRoot = _d2[1]
      useEffect(function () { if (props && props.sessionId) { var sid = String(props.sessionId); if (state.sessionId !== sid) { state.sessionId = sid; reqEpoch++; state.tasks = []; state.tasksHash = ''; state.children = []; state.activity = {}; state.archived = []; state.detailId = null; state.childStats = {}; state.tasksErr = ''; notify(); fetchTasks(); fetchChildren() } } }, [props && props.sessionId])
      useEffect(function () { function update() { var n = 0, e = 0; for (var i = 0; i < state.tasks.length; i++) { if (state.tasks[i].status === 'pending') n++; if (state.tasks[i].escalation) e++ }; setPendingCount(n); setEscCount(e); setIsOpen(state.open); setIsRoot(state.isRoot) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!isRoot) return null // 子代理会话不显示看板入口
      return React.createElement('button', { onClick: function () { state.open = !state.open; notify() }, title: '智能看板' + (pendingCount > 0 ? '（' + pendingCount + ' 待办）' : '') + (escCount > 0 ? '（' + escCount + ' 待裁决）' : ''), style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', border: '1px solid ' + (escCount > 0 ? C.err : C.border), borderRadius: 6, background: isOpen ? C.nested : 'transparent', color: C.text, cursor: 'pointer', fontSize: 12 } }, React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center' } }, ic('clipboard-list', 14)), React.createElement('span', null, '智能看板'), escCount > 0 ? React.createElement('span', { style: { minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: C.err, color: C_INV, fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 1, animation: 'tskb-pulse 1s ease-in-out infinite' }, title: escCount + ' 个任务待裁决' }, ic('alert-triangle', 10), escCount) : null, pendingCount > 0 ? React.createElement('span', { style: { minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: C.brand, color: C_INV, fontSize: 10, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, String(pendingCount)) : null)
    }

    function ViewTab() { var btnBase = { fontSize: 11, padding: '3px 10px', border: 'none', cursor: 'pointer', fontWeight: 500, borderRadius: 5, transition: 'all .15s' }; function goArch() { state.view = 'archive'; notify(); fetchArchived() } return React.createElement('div', { style: { display: 'inline-flex', borderRadius: 6, border: '1px solid ' + C.border, overflow: 'hidden', background: C.card } }, React.createElement('button', { onClick: function () { state.view = 'board'; notify() }, style: Object.assign({}, btnBase, state.view === 'board' ? { background: C.brand, color: C_INV } : { background: 'transparent', color: C.text2 }) }, React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, ic('clipboard-list', 12), '看板')), React.createElement('button', { onClick: function () { state.view = 'team'; notify() }, style: Object.assign({}, btnBase, state.view === 'team' ? { background: C.brand, color: C_INV } : { background: 'transparent', color: C.text2 }) }, icText('users', 12, '团队')), React.createElement('button', { onClick: function () { state.view = 'dashboard'; notify() }, style: Object.assign({}, btnBase, state.view === 'dashboard' ? { background: C.brand, color: C_INV } : { background: 'transparent', color: C.text2 }) }, icText('bar-chart-3', 12, '仪表盘')), React.createElement('button', { onClick: goArch, title: '已归档任务（可检索、可恢复）', style: Object.assign({}, btnBase, state.view === 'archive' ? { background: C.brand, color: C_INV } : { background: 'transparent', color: C.text2 }) }, icText('archive', 12, '归档'))) }

    function TopPanel() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(state.open), open = _a[0], setOpen = _a[1]; var _b = useState(state.tasks), tasks = _b[0], setTasksState = _b[1]; var _c = useState(state.boardMode), mode = _c[0], setModeState = _c[1]; var _d = useState(state.detailId), detailId = _d[0], setDetailId = _d[1]; var _f = useState(state.dragOver), dragOver = _f[0], setDragOver = _f[1]; var _g = useState(state.dispatchInfo), dispatchInfo = _g[0], setDispatchInfo = _g[1]; var _j = useState(state.view), view = _j[0], setViewState = _j[1]; var _k = useState(state.layoutLeft), layL = _k[0], setLayL = _k[1]; var _l = useState(state.layoutRight), layR = _l[0], setLayR = _l[1]
      var _m = useState(state.minWorkers), minW = _m[0], setMinW = _m[1]; var _n = useState(state.maxWorkers), maxW = _n[0], setMaxW = _n[1]; var _o = useState(state.minVerifiers), minV = _o[0], setMinV = _o[1]; var _p = useState(state.maxVerifiers), maxV = _p[0], setMaxV = _p[1]; var _wm = useState(state.workerModel), workerModel = _wm[0], setWorkerModel = _wm[1]; var _vm = useState(state.verifierModel), verifierModel = _vm[0], setVerifierModel = _vm[1]
      var _q = useState(state.teamMode), teamMode = _q[0], setTeamMode = _q[1]; var _dr = useState(state.dateRange), setDR = _dr[1]
      var _wmo = useState(state.workMode), workMode = _wmo[0], setWorkModeState = _wmo[1]
      var _cro = useState(state.createOpen), createOpen = _cro[0], setCreateOpen = _cro[1]; var _crf = useState(state.createFlash), createFlash = _crf[0], setCreateFlash = _crf[1]
      var _te = useState(state.tasksErr), tasksErr = _te[0], setTasksErr = _te[1] // 读路径错误条（无错不渲染）
      var _sto = useState(state.softTimeoutMin), softT = _sto[0], setSoftT = _sto[1]; var _hto = useState(state.hardTimeoutMin), hardT = _hto[0], setHardT = _hto[1]
      var _fbo = useState(state.feedbackEnabled), fbEnabled = _fbo[0], setFbEnabled = _fbo[1]
      useEffect(function () { function update() { setOpen(state.open); setTasksState(state.tasks); setModeState(state.boardMode); setDetailId(state.detailId); setDragOver(state.dragOver); setDispatchInfo(state.dispatchInfo); setViewState(state.view); setLayL(state.layoutLeft); setLayR(state.layoutRight); setMinW(state.minWorkers); setMaxW(state.maxWorkers); setMinV(state.minVerifiers); setMaxV(state.maxVerifiers); setWorkerModel(state.workerModel); setVerifierModel(state.verifierModel); setTeamMode(state.teamMode); setWorkModeState(state.workMode); setDR(state.dateRange); setSoftT(state.softTimeoutMin); setHardT(state.hardTimeoutMin); setFbEnabled(state.feedbackEnabled); setCreateOpen(state.createOpen); setCreateFlash(state.createFlash); setTasksErr(state.tasksErr) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!open) return null
      if (state.isRoot === false) return null // 子代理会话不渲染看板面板
      var active = tasks.filter(function (t) { return t.status !== 'archived' }); var archived = tasks.filter(function (t) { return t.status === 'archived' })
      var hasFilter = state.filterQ.trim() || state.filterPrio.length > 0 || state.filterTag
      if (hasFilter) { active = active.filter(passFilter); archived = archived.filter(passFilter) }
      var content
      if (view === 'dashboard') { content = React.createElement(Dashboard) }
      else if (view === 'archive') { content = React.createElement(ArchiveView) }
      else if (view === 'team') { content = React.createElement(TeamView) }
      else if (detailId) { content = React.createElement(DetailView) }
      else {
        var prioRank = { critical: 4, high: 3, medium: 2, low: 1 }
        var cols = COLUMNS.map(function (st) { var colTasks = active.filter(function (t) { return t.status === st }); colTasks.sort(function (a, b) { var e = (b.escalation ? 1 : 0) - (a.escalation ? 1 : 0); if (e) return e; var sk = (b.stuckSince ? 1 : 0) - (a.stuckSince ? 1 : 0); if (sk) return sk; var db = (depsBlocked(a) ? 1 : 0) - (depsBlocked(b) ? 1 : 0); if (db) return db; var p = (prioRank[b.priority] || 2) - (prioRank[a.priority] || 2); if (p) return p; return (a.createdAt || '').localeCompare(b.createdAt || '') }); var isOver = dragOver === st; return React.createElement('div', { key: st, onDragOver: function (e) { onColDragOver(e, st) }, onDragLeave: function () { onColDragLeave(st) }, onDrop: function (e) { onColDrop(e, st) }, style: { flex: '1 1 0', minWidth: 150, borderRadius: 8, padding: 6, background: isOver ? C.nested : 'transparent', border: isOver ? '1px dashed ' + C.brand : '1px dashed transparent', transition: 'background .15s, border .15s' } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 4, padding: '0 2px' } }, (statusLabels[st] || st) + ' (' + colTasks.length + ')'), colTasks.map(function (t) { return React.createElement(Card, { key: t.id, task: t }) })) })
        // 归档区：排序选择器（默认归档时间降序）+ 纵向滚动列表（不再横向拉条）
        var archSorted = archived.slice().sort(function (a, b) {
          if (state.archSort === 'title') return (a.title || '').localeCompare(b.title || '')
          var ta = a.archivedAt || a.resolvedAt || a.createdAt || '', tb = b.archivedAt || b.resolvedAt || b.createdAt || ''
          return state.archSort === 'time-asc' ? ta.localeCompare(tb) : tb.localeCompare(ta)
        })
        content = React.createElement('div', null, React.createElement(FilterBar, null), hasFilter && active.length === 0 && archived.length === 0 ? React.createElement('div', { style: { textAlign: 'center', padding: 16, color: C.text2, fontSize: 11 } }, '无匹配任务') : null, React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 6 } }, state.selectMode ? '多选模式：点击卡片勾选，底部批量操作' : '提示：拖拽卡片到目标列即可流转状态'), tasks.length === 0 ? React.createElement('div', { style: { textAlign: 'center', padding: '16px 8px 12px', color: C.text2, fontSize: 12 } }, '点击右上角', React.createElement('span', { style: { color: C.brand, fontWeight: 600 } }, '「+ 新建任务」'), '创建第一张卡，或在对话里说一句 ', React.createElement('code', { style: { fontSize: 11, background: C.nested, padding: '0 4px', borderRadius: 3 } }, 'task_create')) : null, React.createElement('div', { style: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 } }, cols),  React.createElement(BatchBar, null))
      }
      return React.createElement('div', { style: { position: 'fixed', top: 44, left: (layL + 8) + 'px', right: (layR + 8) + 'px', maxHeight: '60vh', zIndex: 900, background: C.bg, border: '1px solid ' + C.border, borderRadius: '0 0 10px 10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid ' + C.border, flexShrink: 0, flexWrap: 'wrap', gap: 4 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, React.createElement('span', { style: { fontWeight: 600, fontSize: 13, color: C.text, display: 'inline-flex', alignItems: 'center', gap: 5 } }, ic('clipboard-list', 15), '智能看板'), React.createElement(ViewTab, null), React.createElement(PoolStatus, null)),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
            React.createElement(PoolCfgPopover, { minW: minW, maxW: maxW, minV: minV, maxV: maxV, workerModel: workerModel, verifierModel: verifierModel, softT: softT, hardT: hardT, feedbackEnabled: fbEnabled }),
            dispatchInfo ? React.createElement('span', { style: { fontSize: 9, color: C.brand, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: dispatchInfo }, dispatchInfo) : null,
            React.createElement('button', { onClick: function () { state.createOpen = true; notify() }, title: '新建任务（可存为草稿）', style: { fontSize: 11, padding: '3px 8px', border: '1px solid ' + C.border, borderRadius: 6, cursor: 'pointer', background: 'transparent', color: C.text2, display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('plus', 11), '新建任务'),
            createFlash ? React.createElement('span', { style: { fontSize: 10, color: C.ok } }, createFlash) : null,
            React.createElement('button', { onClick: function () { state.selectMode = !state.selectMode; if (!state.selectMode) state.selected = {}; notify() }, title: '多选批量操作', style: { fontSize: 11, padding: '3px 8px', border: '1px solid ' + (state.selectMode ? C.brand : C.border), borderRadius: 6, cursor: 'pointer', background: state.selectMode ? C.brand : 'transparent', color: state.selectMode ? C_INV : C.text2, display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('square-check-big', 11), '多选'),
            React.createElement(WorkModeSwitch, { mode: workMode }),
            React.createElement('button', { onClick: function () { fetchTasks(); fetchChildren() }, title: '刷新', style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: C.text2, display: 'inline-flex', alignItems: 'center' } }, ic('refresh-cw', 13)),
            React.createElement('button', { onClick: function () { state.open = false; state.detailId = null; notify() }, title: '关闭', style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: C.text2, display: 'inline-flex', alignItems: 'center' } }, ic('x', 14)))),
        tasksErr ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', fontSize: 11, color: C.err, background: 'rgba(239,68,68,.08)', borderBottom: '1px solid ' + C.border, flexShrink: 0 }, title: '刷新失败不影响已显示数据，下次轮询成功自动恢复' }, ic('alert-triangle', 12), React.createElement('span', null, tasksErr)) : null,
        // 空态统一（反馈 n-mut9rzoq3flu）：空板不再整块替换为「🎉 暂无任务」单行，统一走 content 渲染六列骨架；引导 CTA 行在 content 内部按空板条件插入
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '10px 12px' } }, content),
        createOpen ? React.createElement(CreateTaskForm, null) : null)
    }

    slots.inject('conversation.session.header.actions', function () { return slots.register({ name: 'conversation.session.header.actions', id: 'task-board-btn', label: '任务看板', order: 30 }, function (props) { return React.createElement(BoardButton, props) }) })
    slots.inject('shell.overlay', function () { return slots.register({ name: 'shell.overlay', id: 'task-board-top-panel' }, function () { return React.createElement(TopPanel) }) })
