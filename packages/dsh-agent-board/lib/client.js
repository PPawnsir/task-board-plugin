/* global window, document, fetch, getComputedStyle, MutationObserver, ResizeObserver */
// dsh-agent-board — Browser 侧 bundle（CJS 工厂，供 dsh web 客户端 ModuleLoader 注入）。
// ⚠️ GENERATED FILE — 请勿直接编辑。源码在 lib/client/*.js（按用户感知域分模块），
//    由 scripts/build-client.cjs 拼装生成（prepublishOnly / pretest 自动挂链）。
window.__ModuleLoader__.load({
  id: "dsh-agent-board",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict'
    const React = require('react')

function apply(ctx) {
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
    var state = { sessionId: null, tasks: [], boardMode: 'auto', teamMode: false, workMode: 'auto', minWorkers: 1, maxWorkers: 3, minVerifiers: 0, maxVerifiers: 2, workerModel: '', verifierModel: '', softTimeoutMin: 30, hardTimeoutMin: 120, feedbackEnabled: true, notifyDispatch: true, notifyDone: true, epicSplit: true, lessonPushed: {}, isRoot: true, isRootEverTrue: false, isRootFalseN: 0, isRootStable: true, open: false, detailId: null, children: [], dragOver: null, dragTask: null, dispatchInfo: '', view: 'board', layoutLeft: 280, layoutRight: 0, poolStatus: null, escalatedIds: [], filterQ: '', filterPrio: [], filterTag: '', selectMode: false, selected: {}, undoSnapshot: null, cardHover: '', archSort: 'time-desc', dateRange: { from: '', to: '' }, rfOpen: false, gboOpen: false, activity: {}, archived: [], archQ: '', globalBoards: [], createOpen: false, createFlash: '', usageSummary: null, childStats: {}, tasksErr: '', tasksHash: '' }

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

    // ===== isRoot 蝶变防抖（反馈 n-muuerxv9ijxs / task-muupr8ld）=====
    // 为什么防抖：host rpc.mjs L97 的 isRoot 是每次 get-tasks 现算的
    // （agents.roots() 是否含本会话 id）。生成开始/结束瞬间 agents 树重建，roots() 存在一个
    // 瞬态窗口返回不含本 sid → 单次 isRoot=false 就触发 L303 强收抽屉（state.open=false），
    // 用户表现为「看板在生成状态切换时突然消失，每次都要重新打开」；按钮/面板同病闪烁。
    // 防抖口径：已确认过 true 的会话（everTrue）需连续 IS_ROOT_FALSE_LIMIT 次 false
    // （host 3s 心跳 ≈ 9s）才把 isRootStable 翻成 false——覆盖瞬态窗口，真正降级仍会收敛。
    // 为什么子代理会话不防抖：everTrue=false 的会话（新打开的子代理）立即 isRootStable=false，
    // 保护语义不削弱——子代理会话本就不该出现看板入口/抽屉，即时收起没有代价。
    // 消费口径：强收（本函数）/按钮（BoardButton）/面板（TopPanel）/活动心跳省流（fetchActivity）
    // 四处一律读 isRootStable，不读单次轮询的 state.isRoot 原始值。
    var IS_ROOT_FALSE_LIMIT = 3
    function applyIsRoot(rawIsRoot) {
      state.isRoot = rawIsRoot
      if (rawIsRoot) {
        state.isRootEverTrue = true // 曾确认 true：此后 false 需连续累计（会话生命周期内粘滞，切换会话时重置）
        state.isRootFalseN = 0
        state.isRootStable = true
      } else if (!state.isRootEverTrue) {
        state.isRootStable = false // 从未 true（新打开的子代理会话）：即时收起，不防抖
      } else {
        state.isRootFalseN++
        if (state.isRootFalseN >= IS_ROOT_FALSE_LIMIT) state.isRootStable = false // 连续 3 次 false：真降级（子代理树已重建不含本 sid），收敛
      }
    }

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
        // 回执开关（设置区「通知」）：同口径——老 host 不返回 → 视为开，只有显式 false 才关
        state.notifyDispatch = !(d && d.notifyDispatch === false)
        state.notifyDone = !(d && d.notifyDone === false)
        // 史诗拆分总开关（设置区「功能」）：同上——老 host 不返回 = 开（引导照旧），只有显式 false 才关
        state.epicSplit = !(d && d.epicSplit === false)
        applyIsRoot(!d || d.isRoot !== false) // 原始值只喂给防抖器，消费点一律读 isRootStable
        if (!state.isRootStable && state.open) { state.open = false; state.detailId = null } // 子代理会话（含连续 3 次 false 的真降级）：强制收起看板
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
      if (!state.sessionId || !state.isRootStable || !state.open) return // 面板关闭时不轮询活动（省同步 I/O）；isRootStable 口径见 isRoot 蝶变防抖
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
      useEffect(function () { if (props && props.sessionId) { var sid = String(props.sessionId); if (state.sessionId !== sid) { state.sessionId = sid; reqEpoch++; state.tasks = []; state.tasksHash = ''; state.children = []; state.activity = {}; state.archived = []; state.detailId = null; state.childStats = {}; state.tasksErr = ''; state.isRootEverTrue = false; state.isRootFalseN = 0; state.isRootStable = false; notify(); fetchTasks(); fetchChildren() } } }, [props && props.sessionId]) // 会话切换重置 isRoot 防抖态（everTrue/计数/stable 都按会话生命周期——旧会话的"曾确认 true"不得漂到新会话）；reset 后首轮 get-tasks 判定前按"未确认 root"保守隐藏，避免切进子代理会话时入口闪现
      useEffect(function () { function update() { var n = 0, e = 0; for (var i = 0; i < state.tasks.length; i++) { if (state.tasks[i].status === 'pending') n++; if (state.tasks[i].escalation) e++ }; setPendingCount(n); setEscCount(e); setIsOpen(state.open); setIsRoot(state.isRootStable) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!isRoot) return null // 子代理会话不显示看板入口（读 isRootStable：瞬态 false 不收，见 isRoot 蝶变防抖）
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
      var _ndo = useState(state.notifyDispatch), ndOn = _ndo[0], setNdOn = _ndo[1]; var _nno = useState(state.notifyDone), nnOn = _nno[0], setNnOn = _nno[1]
      var _eso = useState(state.epicSplit), esOn = _eso[0], setEsOn = _eso[1] // 史诗拆分总开关勾选态（设置区「功能」）
      useEffect(function () { function update() { setOpen(state.open); setTasksState(state.tasks); setModeState(state.boardMode); setDetailId(state.detailId); setDragOver(state.dragOver); setDispatchInfo(state.dispatchInfo); setViewState(state.view); setLayL(state.layoutLeft); setLayR(state.layoutRight); setMinW(state.minWorkers); setMaxW(state.maxWorkers); setMinV(state.minVerifiers); setMaxV(state.maxVerifiers); setWorkerModel(state.workerModel); setVerifierModel(state.verifierModel); setTeamMode(state.teamMode); setWorkModeState(state.workMode); setDR(state.dateRange); setSoftT(state.softTimeoutMin); setHardT(state.hardTimeoutMin); setFbEnabled(state.feedbackEnabled); setNdOn(state.notifyDispatch); setNnOn(state.notifyDone); setEsOn(state.epicSplit); setCreateOpen(state.createOpen); setCreateFlash(state.createFlash); setTasksErr(state.tasksErr) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!open) return null
      if (!state.isRootStable) return null // 子代理会话不渲染看板面板（读 isRootStable：瞬态 false 不闪，见 isRoot 蝶变防抖）
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
            React.createElement(PoolCfgPopover, { minW: minW, maxW: maxW, minV: minV, maxV: maxV, workerModel: workerModel, verifierModel: verifierModel, softT: softT, hardT: hardT, feedbackEnabled: fbEnabled, notifyDispatch: ndOn, notifyDone: nnOn, epicSplit: esOn }),
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

// ============================================================================
// board-list —— 看板列表域：批量操作条（BatchBar）· 筛选条（FilterBar）· 卡片（Card）
//   · 归档列表（ArchiveView）· 建卡表单（CreateTaskForm）
// 本文件是 apply(ctx) 函数体片段，不可独立运行；由 scripts/build-client.cjs 按序拼接生成 lib/client.js。
// ============================================================================

    // #14 批量操作条（#16 带一步撤销：快照操作前的 priority/status；delete 是真删，明确不支持撤销）
    function BatchBar() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(0), cnt = _a[0], setCnt = _a[1]; var _b = useState(false), on = _b[0], setOn = _b[1]; var _c = useState(''), msg = _c[0], setMsg = _c[1]; var _d = useState(null), undo = _d[0], setUndo = _d[1]
      useEffect(function () { function update() { setCnt(Object.keys(state.selected).length); setOn(state.selectMode); setUndo(state.undoSnapshot) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!on) return null
      var ids = Object.keys(state.selected)
      function snapshot(op) { return { op: op, at: Date.now(), items: ids.map(function (id) { var t = getTask(id); return t ? { id: id, priority: t.priority, status: t.status } : null }).filter(Boolean) } }
      // 跳过原因只回显第一条（如"任务正在执行中，请先…"），避免把整屏门禁文案塞进批量条
      function firstReason(r) { var m = (r && r.reasons) || {}; var ks = Object.keys(m); return ks.length ? String(m[ks[0]]) : '' }
      function run(op, value) {
        // 只有可撤销的 op 才需要快照（delete 是真删，快照里的 status/priority 复活不回整张卡）
        var snap = op === 'delete' ? null : snapshot(op)
        var payload = { ids: ids, op: op }; if (value !== undefined) payload.value = value
        rpc('batch-op', payload).then(function (r) {
          state.selected = {}
          // 删除无 undo：done>0 也不留撤销快照（否则「↩️ 撤销」点了恢复不了，纯粹误导）；其他 op 维持一步撤销
          state.undoSnapshot = (r && r.done > 0 && op !== 'delete') ? snap : null
          var reason = (op === 'delete' && r && r.reasons) ? firstReason(r) : ''
          setMsg('✅ 已处理 ' + (r && r.done || 0) + ' 个' + (r && r.skipped && r.skipped.length ? '，跳过 ' + r.skipped.length + (reason ? '（' + reason + '）' : '') : ''))
          fetchTasks()
        }).catch(function (e) { setMsg('⚠️ ' + String(e)) })
      }
      // 批量删除：真删不可恢复，必须先 confirm；确认后走 batch-op delete，逐 id 受 host 同一套状态门禁约束
      function batchDelete() {
        if (cnt === 0) return
        if (!window.confirm('批量删除不可恢复，确认删除选中的 ' + cnt + ' 个任务？\n（执行中/验证中的会被跳过，需先终止；已落定任务请改用归档）')) return
        run('delete')
      }
      function doUndo() { if (!undo) return; rpc('batch-undo', { snapshot: undo }).then(function (r) { setMsg('↩️ 已撤销 ' + (r && r.done || 0) + ' 个'); state.undoSnapshot = null; fetchTasks() }).catch(function (e) { setMsg('⚠️ ' + String(e)) }) }
      var btn = { fontSize: 10, padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', fontWeight: 600 }
      return React.createElement('div', { style: { position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginTop: 8, background: C.nested, border: '1px solid ' + C.border, borderRadius: 6 } },
        React.createElement('span', { style: { fontSize: 11, color: C.text, fontWeight: 600 } }, '已选 ' + cnt + ' 项'),
        React.createElement('button', { onClick: function () { run('archive') }, disabled: cnt === 0, style: Object.assign({}, btn, { background: C.text2, color: C_INV, display: 'inline-flex', alignItems: 'center', gap: 3 }) }, ic('archive', 11), '批量归档'),
        ['critical', 'high', 'medium', 'low'].map(function (p) { return React.createElement('button', { key: p, onClick: function () { run('set-priority', p) }, disabled: cnt === 0, style: Object.assign({}, btn, { background: prioColor[p], color: C_INV }) }, prioLabel[p]) }),
        // 批量删除（drop 语义）：红底实心 + confirm 防误删；执行中/验证中与有未归档子任务的会被 host 跳过
        React.createElement('button', { onClick: batchDelete, disabled: cnt === 0, title: '删除选中任务（不可恢复；执行中/验证中的需先终止，已落定请用归档）', style: Object.assign({}, btn, { background: C.err, color: C_INV, display: 'inline-flex', alignItems: 'center', gap: 3 }) }, ic('trash-2', 11), '批量删除'),
        undo ? React.createElement('button', { onClick: doUndo, title: '撤销最近一次批量操作（删除不可撤销）', style: Object.assign({}, btn, { background: C.brand, color: C_INV }) }, '↩️ 撤销') : null,
        msg ? React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, msg) : null,
        React.createElement('button', { onClick: function () { state.selected = {}; notify() }, style: { marginLeft: 'auto', fontSize: 10, padding: '3px 8px', border: 'none', background: 'transparent', color: C.text2, cursor: 'pointer' } }, '清除选择'))
    }

    function FilterBar() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(state.filterQ), q = _a[0], setQ = _a[1]; var _b = useState(state.filterPrio), fp = _b[0], setFp = _b[1]; var _c = useState(state.filterTag), ft = _c[0], setFt = _c[1]
      useEffect(function () { function update() { setQ(state.filterQ); setFp(state.filterPrio); setFt(state.filterTag) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      function setQ2(v) { state.filterQ = v; notify() }
      function togglePrio(p) { var i = state.filterPrio.indexOf(p); if (i >= 0) state.filterPrio.splice(i, 1); else state.filterPrio.push(p); notify() }
      function clearAll() { state.filterQ = ''; state.filterPrio = []; state.filterTag = ''; notify() }
      var hasFilter = q.trim() || fp.length > 0 || ft
      var chipBase = { fontSize: 10, padding: '2px 8px', borderRadius: 10, border: '1px solid ' + C.border, cursor: 'pointer', background: 'transparent', color: C.text2, transition: 'all .15s' }
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' } },
        React.createElement('input', { value: q, onChange: function (e) { setQ2(e.target.value) }, placeholder: '🔍 搜索标题/描述/ID…', style: { flex: '0 1 200px', fontSize: 11, padding: '3px 8px', border: '1px solid ' + C.border2, borderRadius: 4, background: C.card, color: C.text } }),
        ['critical', 'high', 'medium', 'low'].map(function (p) { var on = fp.indexOf(p) >= 0; return React.createElement('button', { key: p, onClick: function () { togglePrio(p) }, style: Object.assign({}, chipBase, on ? { background: prioColor[p], color: C_INV, borderColor: prioColor[p] } : {}) }, prioLabel[p]) }),
        allTags().length > 0 ? React.createElement('select', { value: ft, onChange: function (e) { state.filterTag = e.target.value; notify() }, style: { fontSize: 10, padding: '2px 4px', border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text } }, React.createElement('option', { value: '' }, '🏷 全部标签'), allTags().map(function (g) { return React.createElement('option', { key: g, value: g }, g) })) : null,
        hasFilter ? React.createElement('button', { onClick: clearAll, style: { fontSize: 10, padding: '2px 8px', borderRadius: 10, border: 'none', background: C.nested, color: C.text2, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 2 } }, ic('x', 9), '清除') : null)
    }

    // 卡片删除入口的 hover 态（值形如 "taskId|del"，未 hover 时为空串）：
    // 只用于控制垃圾桶按钮的淡入/淡出（平时 opacity:0 不抢视觉），不参与拖拽/选中逻辑。
    function isCardHover(id, kind) { return String(state.cardHover || '') === (id + '|' + kind) }
    function setHover(id, kind) { var v = id ? (id + '|' + kind) : ''; if (state.cardHover !== v) { state.cardHover = v; notify() } }

    // 卡片键盘焦点态（无障碍，反馈 n-mut9rzpyc7p1）：内联样式表达不了 :focus 伪类，
    // 用 focus/blur 事件 + state 现算主题色 outline——样式由 state 推导，轮询重渲染也不会丢焦点框。
    function isCardFocus(id) { return String(state.cardFocus || '') === id }
    function setCardFocus(id) { var v = id || ''; if (state.cardFocus !== v) { state.cardFocus = v; notify() } }

    // ===== 卡片「当前动作」行摘要化（client 侧提炼；host 仍下发原文，不改 host）=====
    // host 的 activity 形如 `🔧 pwsh {"command": "Get-ChildItem …"}`（90 字符硬截，常断在 JSON 中段，
    // 原样展示零信息量，反馈 n-mut914xana0t）或 `💬 自由文本`。这里提炼为「工具名 + 关键参数摘要」：
    //   pwsh → 命令体；read/write/edit → 文件 basename；browser_* → 动作名 + 目标（target/url/ref）；
    //   参数摘要 40 字符内、优先在空格/路径分隔符处断点；解析失败/自由文本回退为原文前 40 字符（头部截断）。
    function actCut(s, n) { s = String(s || ''); if (s.length <= n) return s; var c = s.slice(0, n); var last = c.charCodeAt(c.length - 1); if (last >= 0xD800 && last <= 0xDBFF) c = c.slice(0, -1); var sp = Math.max(c.lastIndexOf(' '), c.lastIndexOf('/'), c.lastIndexOf('\\')); if (sp >= Math.floor(n / 2)) c = c.slice(0, sp); return c.replace(/[\s/\\]+$/, '') + '…' } // 不斩断代理对（emoji）
    // 从不完整 JSON 文本里抢指定 key 的第一个字符串值（host 文本常被硬截，JSON.parse 多半失败，正则直达）
    function actArg(rest, key) { var m = String(rest || '').match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)')); return m ? m[1] : '' }
    function actBase(p) { p = String(p || ''); var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i >= 0 ? p.slice(i + 1) : p }
    function activitySummary(text) {
      var s = String(text || '').trim()
      if (!s) return ''
      if (s.indexOf('💬') === 0) return actCut(s, 40) // 自由文本：保留 💬 前缀从头部截
      var body = s.replace(/^🔧\s*/, '') // 去工具调用前缀（host 格式 🔧 <tool> <argsJSON>）
      var m = body.match(/^([A-Za-z_][\w-]*)\s*([\s\S]*)$/)
      if (!m) return actCut(s, 40)
      var tool = m[1], rest = (m[2] || '').trim()
      if (!rest) return actCut(s, 40)
      var v = ''
      if (tool === 'pwsh') v = actArg(rest, 'command')
      else if (tool === 'read' || tool === 'write' || tool === 'edit') v = actBase(actArg(rest, 'file_path'))
      if (v) return tool + ' ' + actCut(v, 40)
      if (tool.indexOf('browser_') === 0) {
        var act = actArg(rest, 'action'); var tgt = actArg(rest, 'target') || actArg(rest, 'url') || actArg(rest, 'ref')
        var parts = []; if (act) parts.push(act); if (tgt) parts.push(tgt)
        if (parts.length) return tool + ' ' + actCut(parts.join(' '), 40)
      }
      return actCut(s, 40) // 无法解析：原文前 40 字符（从头部截，不再断在 JSON 中段）
    }

    // 史诗/依赖/父子识别层（childStats 缺省兼容：host 未返回该字段时一律不渲染相关元素）：
    //   父卡 = 元信息行首位「📦 史诗 · settled/total」徽章 + 3px 迷你进度条 + activeTitle 非空时「▸ 在跑」行；
    //     settled = resolved | cancelled | archived（含已归档子任务、total 也含），口径同宿主 aggregateChildStats；
    //     老宿主只下发 resolved 时回退读它（缺省兼容）——所以归档子卡不再让徽章从 0/10 退化成 0/9；
    //   子卡 = 标题下一行小字「↳ 父任务标题」（从 state.tasks 找父卡，找不到回退 shortId）；
    //   依赖未满足的待办卡 = 卡片底部灰字「⛓ 等待「第一个未满足依赖标题」」（多个时附「 等 N 个」）。
    // ===== 调研门禁·UI：「⚠️ 无调研」徽章判定（纯 client 侧现算，host 不下发该字段）=====
    // 口径：pipeline ∈ {full, work}（direct 主窗口自处理，无需调研注入）且 touches 非空（声明了要改文件）
    //   且 context.files / context.notes 皆空。context 缺省兼容：老任务无 context 对象按空处理——
    //   即老任务也会亮徽章，这是预期行为（立单质量可见即问责；draft/pending 等状态照常显示，与状态无关）。
    function noResearch(t) {
      var pl = t.pipeline || 'full'
      if (pl !== 'full' && pl !== 'work') return false
      if (!Array.isArray(t.touches) || t.touches.length === 0) return false
      var cx = t.context || {}
      var files = Array.isArray(cx.files) ? cx.files : []
      var notes = typeof cx.notes === 'string' ? cx.notes.trim() : ''
      return files.length === 0 && notes.length === 0
    }
    // ===== epic hook 相位徽章（hooks=agent run 的卡片侧可见性，task-muuw56yf）=====
    // 与 host core.normalizeHooks 契约同源：epic.hooks = { pre: { enabled, prompt, state, runId, pending? }, post: 同构 }，
    // state ∈ idle | running | done | failed（host 状态机推进，UI 只读展示，不在这里改状态）。
    // 缺省兼容硬约束：卡上无 hooks / 该点位未启用 → 返回 null，老卡渲染逐字不变（零额外 DOM）。
    // 优先级与文案（同一时刻只可能有一个相位有话说）：
    //   pre|post failed  → 「⚠️ hook 失败待裁决」（err 色）：史诗已被 host 转 blocked 挂歧义，过程态文案都让位；
    //   pre  running     → 「⏳ 前置准备中」：串行闸门期内，该 epic 的子任务一张都不派；
    //   post running     → 「🧪 收尾中」：子任务已全部了结、epic 仍 in-progress，等收口 run 归还；
    //   idle / done      → 不渲染（普通进行中维持「📦 史诗 · x/y」原样，稳定态不加噪音）。
    function hookBadgeOf(t) {
      var h = t && t.hooks
      if (!h) return null
      var pre = (h.pre && h.pre.enabled) ? h.pre : null
      var post = (h.post && h.post.enabled) ? h.post : null
      if ((pre && pre.state === 'failed') || (post && post.state === 'failed')) {
        var ph = (pre && pre.state === 'failed') ? 'pre' : 'post'
        return { txt: '⚠️ hook 失败待裁决', color: C.err, tip: 'hooks.' + ph + '（' + (ph === 'pre' ? '前置准备' : '收口') + '）运行失败：史诗已转阻塞等人裁决（重试/跳过/放弃），详情页可跳裁决区' }
      }
      if (pre && pre.state === 'running') return { txt: '⏳ 前置准备中', color: C.brand, tip: '前置 hook run 正在跑：完成前该史诗的子任务一张都不派（串行闸门）' }
      if (post && post.state === 'running') return { txt: '🧪 收尾中', color: C.brand, tip: '收口 hook run 正在跑：子任务已全部了结，史诗仍 in-progress，收口完成后才转验证中' }
      return null
    }
    function hookPhaseBadge(t) {
      var b = hookBadgeOf(t)
      if (!b) return null
      return React.createElement('span', { title: b.tip, style: { fontSize: 9, padding: '0 4px', borderRadius: 2, background: 'color-mix(in srgb, ' + b.color + ' 14%, transparent)', color: b.color, fontWeight: 600, whiteSpace: 'nowrap' } }, b.txt)
    }

    function Card(props) { var t = props.task; var pc = prioColor[t.priority] || prioColor.low; var dragging = state.dragTask === t.id; var preview = (t.deliverable && t.deliverable.summary) || t.resolution; var critGlow = t.priority === 'critical' && !t.escalation; var sel = !!state.selected[t.id]; var pm = pipeOf(t); var depBlock = t.status === 'pending' && depsBlocked(t); var delOk = !state.selectMode && canDelete(t); var cs = (state.childStats && state.childStats[t.id]) || null; var csDone = cs ? (typeof cs.settled === 'number' ? cs.settled : cs.resolved) : 0; var epic = !!(cs && cs.total > 0); var parentT = t.parentId ? getTask(t.parentId) : null; var depWaitTitle = ''; var depWaitN = 0; if (depBlock) { t.dependsOn.forEach(function (id) { var d = getTask(id); if (!d || (d.status !== 'resolved' && d.status !== 'archived')) { depWaitN++; if (!depWaitTitle) depWaitTitle = d && d.title ? d.title : id } }) } var durB = cardDur(t);
      // 无障碍（反馈 n-mut9rzpyc7p1）：卡片根以 button 角色进 Tab 序（aria-label=标题+状态），
      // Enter/Space 触发与点击相同的激活行为（多选=切换选中，否则开详情）；
      // focus 态用主题色 C.brand 2px outline（不用浏览器默认蓝框，保持主题一致）
      function activate() { if (state.selectMode) { if (state.selected[t.id]) delete state.selected[t.id]; else state.selected[t.id] = true; notify() } else { state.detailId = t.id; notify() } }
      return React.createElement('div', { role: 'button', tabIndex: 0, 'aria-label': t.title + '（' + (statusLabels[t.status] || t.status) + '）', draggable: !state.selectMode, onDragStart: function (e) { onDragStart(e, t) }, onDragEnd: onDragEnd, onMouseEnter: function () { if (delOk) setHover(t.id, 'del') }, onMouseLeave: function () { if (delOk) setHover('', '') }, onFocus: function () { setCardFocus(t.id) }, onBlur: function () { setCardFocus('') }, onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } }, onClick: activate, style: { outline: isCardFocus(t.id) ? '2px solid ' + C.brand : 'none', outlineOffset: 2, border: '1px solid ' + (sel ? C.brand : (t.escalation ? C.err : (critGlow ? C.err : C.border))), borderRadius: 6, padding: '6px 8px', marginBottom: 6, background: sel ? C.nested : C.card, borderLeft: '3px solid ' + (t.escalation ? C.err : pc), cursor: state.selectMode ? 'pointer' : 'grab', fontSize: 12, opacity: dragging ? 0.4 : (depBlock ? 0.65 : 1), transition: 'opacity .15s', animation: critGlow ? 'tskb-crit 2s ease-in-out infinite' : 'none' } }, React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 4 } }, state.selectMode ? React.createElement('span', { style: { color: sel ? C.brand : C.text2, flexShrink: 0, marginTop: 1, display: 'inline-flex' } }, ic(sel ? 'square-check-big' : 'square', 12)) : null, React.createElement('div', { style: { fontWeight: 600, color: C.text, marginBottom: 2, wordBreak: 'break-word', flex: 1 } }, t.title), React.createElement('span', { style: { flexShrink: 0, marginTop: 1, display: 'inline-flex', color: C.text2 }, title: pm.label }, ic(pm.icon, 10)), React.createElement('span', { style: { fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'color-mix(in srgb, ' + pc + ' 20%, transparent)', color: pc, flexShrink: 0, marginTop: 1 } }, prioLabel[t.priority] || '中'), noResearch(t) ? React.createElement('span', { title: '本任务未附调研上下文，Worker 需自行定位——建议补 contextFiles/contextNotes', style: { fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'color-mix(in srgb, ' + C.warn + ' 18%, transparent)', color: C.warn, fontWeight: 600, flexShrink: 0, marginTop: 1, whiteSpace: 'nowrap' } }, '⚠️ 无调研') : null, (t.usage && t.usage.total) ?React.createElement('span', { style: { fontSize: 9, color: C.text2, flexShrink: 0, marginTop: 1 }, title: '本任务累计 token：' + String(t.usage.total) + '（' + (t.usage.runs || 0) + ' 次 run）' }, '⛁ ' + fmtTokens(t.usage.total)) : null), t.parentId ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: parentT ? '父任务：' + parentT.title + ' (' + t.parentId + ')' : t.parentId }, '↳ ' + (parentT && parentT.title ? parentT.title : shortId(t.parentId))) : null, t.escalation ? React.createElement('div', { style: { fontSize: 10, color: C.err, fontWeight: 600, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 } }, ic('alert-triangle', 10), '待裁决 — 点击查看疑问') : null, t.stuckSince ? React.createElement('div', { style: { fontSize: 10, color: C.warn, fontWeight: 600, marginBottom: 2, animation: 'tskb-pulse 1.5s ease-in-out infinite' } }, '⏱ 疑似卡死 · ' + ago(t.stuckSince) + ' — 点击处理') : null, React.createElement('div', { style: { fontSize: 10, color: C.text2, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' } },
            epic ? React.createElement('span', { title: '史诗父卡：' + csDone + '/' + cs.total + ' 个子任务已了结（完成/取消/归档）', style: { fontSize: 9, padding: '0 4px', borderRadius: 2, background: 'color-mix(in srgb, ' + C.brand + ' 14%, transparent)', color: C.brand, fontWeight: 600 } }, '📦 史诗 · ' + csDone + '/' + cs.total) : null,
            // hook 相位徽章：与 📦 徽章**并存**（相位是 epic 的附加过程态，不是替代进度）
            epic ? hookPhaseBadge(t) : null,
            t.frozen ? React.createElement('span', { title: '已冻结：不参与自动派发（详情页可「解除冻结」）', style: { color: C.brand, fontWeight: 600 } }, '❄ 冻结') : null,
            (Array.isArray(t.waitingForTouches) && t.waitingForTouches.length) ? React.createElement('span', { title: '等文件锁释放：' + t.waitingForTouches.join('、') + '（touches 冲突，详情页可 force 越权派发）', style: { color: C.warn, fontWeight: 600 } }, '🔒 等文件释放') : null,
            React.createElement('span', { title: pm.label, style: { fontSize: 9, padding: '0 4px', borderRadius: 2, background: C.nested, border: '1px solid ' + C.border } }, pm.short),
            (t.retryCount || 0) + (t.rejectCount || 0) > 0 ? React.createElement('span', { title: '重试 ' + (t.retryCount || 0) + ' 次 / 驳回 ' + (t.rejectCount || 0) + ' 次', style: { color: C.warn, fontWeight: 600 } }, '⟳' + ((t.retryCount || 0) + (t.rejectCount || 0))) : null,
            t.status === 'in-progress' && t.claimedBy ? React.createElement('span', null, '⚡ ' + shortId(t.claimedBy)) : null,
            t.assignee ? React.createElement('span', null, '👤→' + shortId(t.assignee)) : null,
            durB ? React.createElement('span', { title: durB.tip }, durB.txt) : null,
            // 删除入口（仅草稿/待办/阻塞，多选模式下隐藏以免误触）：hover 才由透明转红，平时不抢视觉
            delOk ? React.createElement('span', {
              onClick: function (e) { e.stopPropagation(); deleteTask(t.id, t.title) }, // 阻止冒泡：不打开详情页
              onMouseDown: function (e) { e.stopPropagation() }, // 也不触发卡片拖拽
              title: '删除任务（不可恢复；执行中请先终止，已落定请用归档）',
              style: { flexShrink: 0, marginTop: 1, display: 'inline-flex', cursor: 'pointer', color: C.err, opacity: isCardHover(t.id, 'del') ? 1 : 0, transition: 'opacity .15s' }
            }, ic('trash-2', 11)) : null),
          // 史诗迷你进度条（3px 高，settled/total 比例，ok 色填充）+ 在跑子任务行（activeTitle 非空才渲染）
          epic ? React.createElement('div', { style: { height: 3, borderRadius: 2, background: C.nested, marginTop: 4, overflow: 'hidden' }, title: '子任务进度 ' + csDone + '/' + cs.total }, React.createElement('div', { style: { height: '100%', width: Math.max(0, Math.min(100, Math.round((csDone / cs.total) * 100))) + '%', background: C.ok, borderRadius: 2, transition: 'width .3s' } })) : null,
          epic && cs.activeTitle ? React.createElement('div', { style: { fontSize: 10, color: C.brand, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: '在跑子任务：' + cs.activeTitle }, '▸ 在跑：' + cs.activeTitle) : null,
          // 当前动作行：展示摘要（工具名+关键参数），悬停 title 仍是 host 原文
          (t.status === 'in-progress' || t.status === 'verifying') && state.activity[t.id] ? React.createElement('div', { style: { fontSize: 10, color: C.brand, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: state.activity[t.id] }, '👁 ' + activitySummary(state.activity[t.id])) : null,
          // 里程碑进展（Worker 主动上报的轻量进展，kind=progress）：进行中的卡片显示最新一条 + 相对时间，无则不显示
          t.status === 'in-progress' && t.lastProgress && t.lastProgress.text ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: '最近进展（' + (t.lastProgress.by || '') + ' · ' + fmtTime(t.lastProgress.at) + '）：' + t.lastProgress.text }, '📈 ' + t.lastProgress.text + ' · ' + ago(t.lastProgress.at)) : null,
          t.status === 'verifying' && preview ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '📝 ' + preview) : null, depBlock ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: '依赖全部完成后才会派发' }, '⛓ 等待「' + depWaitTitle + '」' + (depWaitN > 1 ? ' 等 ' + depWaitN + ' 个' : '')) : null) }

    function ArchiveView() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(state.archQ || ''), q = _a[0], setQ = _a[1]
      useEffect(function () { if (!state.archived.length) fetchArchived() }, [])
      var list = state.archived.filter(function (t) {
        if (!q) return true
        var qq = q.toLowerCase()
        return (t.title || '').toLowerCase().indexOf(qq) >= 0 || (t.id || '').toLowerCase().indexOf(qq) >= 0 || (t.tags || []).join(' ').toLowerCase().indexOf(qq) >= 0
      }).sort(function (a, b) {
        // 完成时间最近在前：resolvedAt 优先，回退验收时间/归档时间/最后活动时间
        function doneTs(t) { return t.resolvedAt || (t.verification && t.verification.at) || t.archivedAt || taskLastTs(t) || '' }
        return (doneTs(b) || '').localeCompare(doneTs(a) || '')
      })
      function restore(id) { rpc('update-task', { taskId: id, resetToPending: true }).then(function () { fetchArchived(); fetchTasks() }).catch(function () {}) }
      return React.createElement('div', null,
        React.createElement('input', { value: q, onChange: function (e) { setQ(e.target.value); state.archQ = e.target.value }, placeholder: '检索标题 / ID / 标签…', style: { width: '100%', padding: '5px 8px', fontSize: 11, border: '1px solid ' + C.border2, borderRadius: 5, background: C.card, color: C.text, marginBottom: 8 } }),
        state.archived.length === 0 ? React.createElement('div', { style: { fontSize: 11, color: C.text2, padding: 12, textAlign: 'center' } }, '暂无归档任务') :
        list.length === 0 ? React.createElement('div', { style: { fontSize: 11, color: C.text2, padding: 12, textAlign: 'center' } }, '无匹配结果') :
        list.map(function (t) {
          return React.createElement('div', { key: t.id, style: { padding: '6px 8px', marginBottom: 5, background: C.card, border: '1px solid ' + C.border, borderRadius: 6 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              React.createElement('span', { style: { fontSize: 11, fontWeight: 600, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: t.title }, t.title),
              t.verification ? React.createElement('span', { title: '验收结论: ' + (t.verification.summary || '').slice(0, 100), style: { fontSize: 9, padding: '1px 5px', borderRadius: 3, background: t.verification.verdict === 'approved' ? C.ok : C.err, color: C_INV } }, t.verification.verdict === 'approved' ? '过' : '驳') : null,
              React.createElement('span', { style: { fontSize: 9, color: C.text2 } }, t.archivedAt ? ago(t.archivedAt) : '')),
            t.verification && t.verification.summary ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '📝 ' + t.verification.summary) : null,
            React.createElement('div', { style: { display: 'flex', gap: 5, marginTop: 4, flexWrap: 'wrap' } },
              React.createElement('button', { onClick: function () { restore(t.id) }, title: '恢复为待办', style: { fontSize: 9, padding: '2px 7px', border: '1px solid ' + C.brand, borderRadius: 3, background: 'transparent', color: C.brand, cursor: 'pointer' } }, '↩ 恢复待办'),
              (function () {
                var runs = historyRuns(t)
                if (!runs.length) return React.createElement('span', { style: { fontSize: 9, color: C.text2, opacity: 0.6, padding: '2px 0' } }, '无历史会话')
                var wN = 0, vN = 0
                return React.createElement('span', { style: { display: 'inline-flex', gap: 5, flexWrap: 'wrap' } }, runs.map(function (r, i) {
                  var seq = r.role === 'verifier' ? (++vN) : (++wN)
                  var isV = r.role === 'verifier'
                  return React.createElement('button', {
                    key: i, onClick: function () { if (uiWorkspaceSvc) uiWorkspaceSvc.openSession(r.id) },
                    title: (isV ? 'Verifier' : 'Worker') + ' 第 ' + seq + ' 次' + (r.at ? ' · ' + ago(r.at) : '') + (r.model ? ' · ' + r.model : '') + '（' + r.id + '）',
                    style: { fontSize: 9, padding: '2px 7px', border: '1px solid ' + (isV ? C.warn : C.brand), borderRadius: 3, background: 'transparent', color: isV ? C.warn : C.brand, cursor: 'pointer' }
                  }, '→ ' + (isV ? 'V' : 'W') + '#' + seq)
                }))
              })()))
        }))
    }

    // ===== GUI 创建任务：＋新建任务 表单弹层（提交走 create-task RPC，Team 托管默认存草稿）=====
    function CreateTaskForm() {
      var _R = React; var useState = _R.useState
      // 草稿默认值：workMode 优先，缺失时按 boardMode/teamMode 本地兜底派生（与 fetchTasks 同口径）
      var wm = state.workMode || (state.teamMode ? 'team' : (state.boardMode === 'auto' ? 'auto' : 'list'))
      var _t = useState(''), title = _t[0], setTitle = _t[1]
      var _d = useState(''), desc = _d[0], setDesc = _d[1]
      var _p = useState('medium'), prio = _p[0], setPrio = _p[1]
      var _pl = useState('full'), pipe = _pl[0], setPipe = _pl[1]
      var _tc = useState(''), touchesRaw = _tc[0], setTouchesRaw = _tc[1]
      var _dp = useState({}), depSel = _dp[0], setDepSel = _dp[1]
      var _ac = useState(''), acc = _ac[0], setAcc = _ac[1]
      var _dr = useState(wm === 'team'), asDraft = _dr[0], setAsDraft = _dr[1]
      var _bs = useState(false), busy = _bs[0], setBusy = _bs[1]
      var _er = useState(''), err = _er[0], setErr = _er[1]
      var _ok = useState(''), okMsg = _ok[0], setOkMsg = _ok[1] // 成功行（仅「创建成功但响应带 warning」的不关窗路径展示）
      var _wn = useState(''), warn = _wn[0], setWarn = _wn[1] // host create-task 成功路径附带的 warning 原文（可能多条合并，原样黄色展示）
      // 依赖候选：当前看板 status 为 draft/pending 的任务
      var cands = state.tasks.filter(function (t) { return t.status === 'draft' || t.status === 'pending' })
      function close() { state.createOpen = false; notify() }
      function toggleDep(id) { var next = Object.assign({}, depSel); if (next[id]) delete next[id]; else next[id] = true; setDepSel(next) }
      function submit() {
        if (busy) return
        var t = title.trim()
        if (!t) { setErr('⚠️ 请先填写标题'); return }
        var touches = touchesRaw.split(/[\n,，;；]/).map(function (s) { return s.trim() }).filter(function (s) { return s.length > 0 })
        var deps = cands.filter(function (x) { return depSel[x.id] }).map(function (x) { return x.id })
        setBusy(true); setErr(''); setOkMsg(''); setWarn('')
        rpc('create-task', { title: t, description: desc, priority: prio, pipeline: pipe, touches: touches, dependsOn: deps, acceptance: acc.trim(), draft: asDraft }).then(function (r) {
          setBusy(false)
          if (r && r.ok === false) { setErr('⚠️ ' + (r.error || '创建失败')); return }
          fetchTasks()
          // 调研门禁·软警告：host 成功路径可附 warning 字符串（如空描述提醒，可能多条合并）——不拦截创建、
          // 也不打断成功提示：表单保持打开，成功行 + ⚠️ 黄色 warning 原文行同屏展示，读完自行关闭；
          // 清掉标题防「再点一次创建」连击出重复卡（空标题会被校验拦住）。无 warning 维持原关窗 + 头部 flash 行为。
          if (r && r.warning) { setOkMsg(asDraft ? '✅ 已存草稿' : '✅ 已创建任务'); setWarn(String(r.warning)); setTitle(''); return }
          state.createOpen = false
          flashCreated(asDraft ? '✅ 已存草稿' : '✅ 已创建任务')
          notify()
        }).catch(function (e) { setBusy(false); setErr('⚠️ ' + String(e)) })
      }
      var inp = { width: '100%', boxSizing: 'border-box', fontSize: 11, padding: '4px 6px', border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text, fontFamily: 'inherit' }
      var lblStyle = { fontSize: 10, color: C.text2, marginBottom: 3 }
      function field(label, node) { return React.createElement('div', { style: { marginBottom: 8 } }, React.createElement('div', { style: lblStyle }, label), node) }
      var btnGhost = { fontSize: 11, padding: '4px 12px', border: '1px solid ' + C.border, borderRadius: 5, background: 'transparent', color: C.text2, cursor: 'pointer' }
      var btnPrimary = { fontSize: 11, padding: '4px 14px', border: 'none', borderRadius: 5, background: C.brand, color: C_INV, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }
      // 视口级 overlay（修裁切，反馈 n-mut9rzl4mxe4）：fixed 全屏遮罩脱离看板抽屉（maxHeight 60vh + overflow hidden）
      // 的裁剪上下文（抽屉无 transform/filter，fixed 相对视口定位不被裁）；弹窗限高 80vh、字段区内部滚动、
      // 底部按钮区吸底常驻——标题与「创建并派发」始终同屏，无需盲滚。
      return React.createElement('div', { style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }, onClick: function (e) { if (e.target === e.currentTarget) close() } },
        React.createElement('div', { style: { width: 440, maxWidth: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: C.bg, border: '1px solid ' + C.border, borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.28)', overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid ' + C.border, flexShrink: 0 } },
            React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: C.text, display: 'inline-flex', alignItems: 'center', gap: 5 } }, ic('plus', 14), '新建任务'),
            React.createElement('button', { onClick: close, title: '关闭', style: { border: 'none', background: 'transparent', cursor: 'pointer', color: C.text2, display: 'inline-flex' } }, ic('x', 14))),
          // 字段区：内容超出 80vh 时在此内部滚动
          React.createElement('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px 4px' } },
          field('标题 *', React.createElement('input', { value: title, onChange: function (e) { setTitle(e.target.value) }, placeholder: '一句话说清要做什么', style: inp })),
          field('描述', React.createElement('textarea', { value: desc, onChange: function (e) { setDesc(e.target.value) }, rows: 3, placeholder: '背景 / 目标 / 约束（可空）', style: Object.assign({}, inp, { resize: 'vertical', minHeight: 46 }) })),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            React.createElement('div', { style: { flex: '1 1 0', minWidth: 0 } }, field('优先级', React.createElement('select', { value: prio, onChange: function (e) { setPrio(e.target.value) }, style: inp }, ['critical', 'high', 'medium', 'low'].map(function (p) { return React.createElement('option', { key: p, value: p }, prioLabel[p] + '（' + p + '）') })))),
            React.createElement('div', { style: { flex: '1 1 0', minWidth: 0 } }, field('管线', React.createElement('select', { value: pipe, onChange: function (e) { setPipe(e.target.value) }, style: inp },
              React.createElement('option', { value: 'full' }, '全流程（执行+验证）'),
              React.createElement('option', { value: 'work' }, '免验证（只做不验）'),
              React.createElement('option', { value: 'direct' }, '主窗口处理'))))),
          field('touches（文件/glob，逗号或换行分隔，可空）', React.createElement('input', { value: touchesRaw, onChange: function (e) { setTouchesRaw(e.target.value) }, placeholder: 'src/a.mjs, src/**', style: inp })),
          field('依赖（全部完成后才派发，可空）', cands.length === 0
            ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '当前无草稿/待办任务可选')
            : React.createElement('div', { style: { maxHeight: 96, overflowY: 'auto', border: '1px solid ' + C.border, borderRadius: 4, padding: '4px 6px', background: C.card } }, cands.map(function (x) {
              return React.createElement('label', { key: x.id, style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text, padding: '1px 0', cursor: 'pointer' } },
                React.createElement('input', { type: 'checkbox', checked: !!depSel[x.id], onChange: function () { toggleDep(x.id) } }),
                React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (statusLabels[x.status] || x.status) + ' · ' + (x.title || x.id)))
            }))),
          field('验收脚本（命令，可空）', React.createElement('input', { value: acc, onChange: function (e) { setAcc(e.target.value) }, placeholder: '如 node --test test/x.test.js', style: Object.assign({}, inp, { fontFamily: 'monospace' }) })),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text, cursor: 'pointer', marginBottom: 6, flexWrap: 'wrap' } },
            React.createElement('input', { type: 'checkbox', checked: asDraft, onChange: function (e) { setAsDraft(e.target.checked) } }),
            '存为草稿',
            React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, wm === 'team' ? '（Team 托管默认草稿；取消勾选 = 立即派发）' : '（先补依赖/上下文，稍后统一发布）'))),
          // 底部：错误行 + 按钮区吸底常驻（flexShrink:0，不随字段区滚动）
          React.createElement('div', { style: { flexShrink: 0, padding: '8px 12px 12px', borderTop: '1px solid ' + C.border, background: C.bg } },
            okMsg ? React.createElement('div', { style: { fontSize: 11, color: C.ok, marginBottom: 6 } }, okMsg) : null,
            warn ? React.createElement('div', { style: { fontSize: 11, color: C.warn, marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, '⚠️ ' + warn) : null,
            err ? React.createElement('div', { style: { fontSize: 11, color: C.err, marginBottom: 6 } }, err) : null,
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
              React.createElement('button', { onClick: close, style: btnGhost }, '取消'),
              React.createElement('button', { onClick: submit, disabled: busy, title: asDraft ? '创建为草稿（不派发）' : '创建并立即进入派发池', style: btnPrimary }, busy ? '创建中…' : (asDraft ? '存为草稿' : '创建并派发'))))))
    }

// ============================================================================
// task-detail —— 任务详情域：裁决对话与沉淀（MsgThread）· 依赖区块（DepsSection）
//   · 详情抽屉（DetailView：编辑/流转/裁决/冻结/touches/历史会话/高优介入）
// 本文件是 apply(ctx) 函数体片段，不可独立运行；由 scripts/build-client.cjs 按序拼接生成 lib/client.js。
// ============================================================================

    function MsgThread(props) {
      var msgs = props.messages || []
      // 学习飞轮 v1：总开关关闭时，候选教训卡片连同「沉淀」按钮整个不渲染（不生成也不展示）
      if (!state.feedbackEnabled) msgs = msgs.filter(function (m) { return m && m.kind !== 'lesson-candidate' })
      if (msgs.length === 0) return null
      var kindStyle = { escalation: { color: C.err, label: 'Worker 上报', icon: 'alert-triangle' }, arbitration: { color: C.brand, label: '主窗口裁决', icon: 'scale' }, intervention: { color: C.warn, label: '高优介入', icon: 'zap' }, progress: { color: C.text2, label: '进展', icon: 'activity' }, 'lesson-candidate': { color: C.brand, label: '候选教训', icon: 'book-open' } }
      // 「沉淀」按钮语义：把这条候选教训 push 给主窗口 agent，由它自己选笔记/记忆工具落库
      // （看板不知道对方有没有这类工具、也不知道最终存到哪——零耦合）。推送成功即置灰。
      function lessonKey(m, i) { return String(props.taskId || '') + '|' + String((m && m.at) || i) }
      function pushLesson(m, i) {
        var key = lessonKey(m, i)
        rpc('push-lesson', { taskId: props.taskId, text: String(m.text || '') }).then(function (r) {
          state.lessonPushed[key] = (r && r.ok) ? true : 'fail'
          notify()
        }).catch(function () { state.lessonPushed[key] = 'fail'; notify() })
      }
      return React.createElement('div', { style: { marginBottom: 8 } },
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 3 } }, '裁决对话 (' + msgs.length + ')'),
        msgs.map(function (m, i) {
          var ks = kindStyle[m.kind] || { color: C.text2, label: m.kind }
          var head = React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: ks.color, marginBottom: 2, display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic(ks.icon, 10), ks.label + ' · ' + (m.by || '') + ' · ' + ago(m.at))
          var body = React.createElement('div', { style: { fontSize: 10, color: C.text, whiteSpace: 'pre-wrap', maxHeight: 140, overflowY: 'auto' } }, m.text)
          if (m.kind !== 'lesson-candidate') {
            return React.createElement('div', { key: i, style: { marginBottom: 4, padding: '5px 8px', borderLeft: '2px solid ' + ks.color, background: C.nested, borderRadius: 4 } }, head, body)
          }
          var st = state.lessonPushed[lessonKey(m, i)]
          var btnStyle = { fontSize: 9, padding: '2px 7px', borderRadius: 3, flexShrink: 0, cursor: st === true ? 'default' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }
          if (st === true) { btnStyle.border = '1px solid ' + C.border; btnStyle.background = 'transparent'; btnStyle.color = C.text2 }
          else if (st === 'fail') { btnStyle.border = 'none'; btnStyle.background = C.err; btnStyle.color = C_INV }
          else { btnStyle.border = '1px solid ' + C.brand; btnStyle.background = 'transparent'; btnStyle.color = C.brand }
          return React.createElement('div', { key: i, style: { marginBottom: 4, padding: '5px 8px', borderLeft: '2px solid ' + C.brand, background: 'color-mix(in srgb, ' + C.brand + ' 6%, transparent)', borderRadius: 4 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 6 } },
              React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: ks.color, marginBottom: 2, display: 'inline-flex', alignItems: 'center', gap: 3 } }, '📚', ks.label + ' · ' + (m.by || '') + ' · ' + ago(m.at)),
                body),
              React.createElement('button', { onClick: function () { if (st !== true) pushLesson(m, i) }, disabled: st === true, title: st === true ? '已推送给主窗口 agent' : (st === 'fail' ? '推送失败，点击重试' : '把这条候选教训推给主窗口 agent，由它用笔记/记忆工具沉淀'), style: btnStyle }, st === true ? '✅ 已推送' : (st === 'fail' ? '⚠ 重试' : '沉淀'))))
        }))
    }

    // #18 依赖管理区块：列出依赖（状态+跳转+移除）+ 添加依赖下拉
    function DepsSection(props) {
      var task = props.task
      var deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
      var candidates = state.tasks.filter(function (x) { return x.id !== task.id && x.status !== 'archived' && deps.indexOf(x.id) < 0 })
      function saveDeps(next) { rpc('update-task', { taskId: task.id, dependsOn: next }).then(function (r) { if (r && r.ok === false) setMsg('⚠️ ' + (r.error || '失败')); fetchTasks() }).catch(function (e) { setMsg('⚠️ ' + String(e)) }) }
      var _R = React; var useState = _R.useState
      var _m = useState(''), msg = _m[0], setMsg = _m[1]
      return React.createElement('div', { style: { marginBottom: 8, padding: '6px 8px', border: '1px solid ' + C.border, borderRadius: 6, background: C.card } },
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 4 } }, '⛓ 依赖任务（全部完成后才会派发）' + (deps.length ? ' · ' + deps.length : '')),
        deps.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 4 } }, '无依赖 — 可立即派发') : deps.map(function (id) {
          var dt = getTask(id)
          var satisfied = dt && (dt.status === 'resolved' || dt.status === 'archived')
          return React.createElement('div', { key: id, style: { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3, fontSize: 10 } },
            React.createElement('span', { style: { padding: '0 5px', borderRadius: 3, fontSize: 9, background: satisfied ? C.ok : (statusColors[dt && dt.status] || C.text2), color: C_INV, flexShrink: 0 } }, dt ? (statusLabels[dt.status] || dt.status) : '不存在'),
            React.createElement('span', { onClick: function () { if (dt) { state.detailId = id; notify() } }, style: { color: dt ? C.brand : C.text2, cursor: dt ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, title: id }, dt ? dt.title : id),
            React.createElement('span', { onClick: function () { saveDeps(deps.filter(function (x) { return x !== id })) }, title: '移除依赖', style: { cursor: 'pointer', color: C.text2, flexShrink: 0, display: 'inline-flex' } }, ic('x', 10)))
        }),
        candidates.length > 0 ? React.createElement('select', { value: '', onChange: function (e) { if (e.target.value) saveDeps(deps.concat([e.target.value])) }, style: { width: '100%', fontSize: 10, padding: '2px 4px', marginTop: 2, border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text } },
          React.createElement('option', { value: '' }, '＋ 添加依赖…'),
          candidates.map(function (x) { return React.createElement('option', { key: x.id, value: x.id }, x.title.slice(0, 36) + ' (' + (statusLabels[x.status] || x.status) + ')') })) : null,
        msg ? React.createElement('div', { style: { fontSize: 10, color: C.err, marginTop: 3 } }, msg) : null)
    }

    // 父子区块（与 DepsSection 并列）：
    //   子卡 = 父链面包屑「↳ 史诗：<父标题>」，点击回跳父卡详情；
    //   父卡 = 子任务清单（状态色点 + 标题 + 状态标签，点击直达子卡详情；标题行汇总 settled/total）。
    //   归档留档（反馈 task-muupgfot）：清单**含已归档子任务**——归档后子任务不该从详情消失，
    //     否则史诗拆分过程整段丢失、只剩一个分母缩水的数字。归档行灰化（降透明度 + 次要文字色）
    //     + 行尾「已归档」徽章，并沉底排在未归档之后（稳定排序：未归档保持 state.tasks 既有顺序）；
    //     仅降视觉权重不改交互——点击照旧进子卡详情看留档。
    //   口径与卡片 📦 徽章同源：settled = resolved | cancelled | archived（宿主 aggregateChildStats 的
    //     settled/resolved 字段），total 含归档，所以详情与卡片永远显示同一个 N/M。
    //   数据源是 state.tasks 按 parentId 现算（parentId 为老字段），不依赖 host 的 childStats，天然缺省兼容；
    //   既无父也无子的普通卡整块不渲染。嵌套史诗（本身也是子卡的父卡）两段同区块上下排列。
    function FamilySection(props) {
      var task = props.task
      var parentT = task.parentId ? getTask(task.parentId) : null
      // 不按状态过滤（归档也要留在清单里）；仅按「是否归档」稳定排序把归档沉底（V8 sort 稳定，未归档保序）
      var kids = state.tasks.filter(function (x) { return x.parentId === task.id })
        .sort(function (a, b) { return (a.status === 'archived' ? 1 : 0) - (b.status === 'archived' ? 1 : 0) })
      if (!task.parentId && kids.length === 0) return null
      var settledN = kids.filter(function (x) { return x.status === 'resolved' || x.status === 'cancelled' || x.status === 'archived' }).length
      function jump(id) { state.detailId = id; notify() }
      return React.createElement('div', { style: { marginBottom: 8, padding: '6px 8px', border: '1px solid ' + C.border, borderRadius: 6, background: C.card } },
        task.parentId ? React.createElement('div', { style: { fontSize: 11, marginBottom: kids.length ? 6 : 0 } },
          React.createElement('span', { style: { color: C.text2, fontWeight: 600 } }, '↳ 史诗：'),
          React.createElement('span', { onClick: function () { if (parentT) jump(task.parentId) }, title: parentT ? parentT.title + ' (' + task.parentId + ')' : task.parentId, style: { color: parentT ? C.brand : C.text2, cursor: parentT ? 'pointer' : 'default', fontWeight: 600 } }, parentT && parentT.title ? parentT.title : shortId(task.parentId))) : null,
        kids.length > 0 ? React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 4 } }, '📦 子任务 · ' + settledN + '/' + kids.length + ' 已了结'),
          kids.map(function (x) {
            var arch = x.status === 'archived'
            return React.createElement('div', { key: x.id, onClick: function () { jump(x.id) }, title: (statusLabels[x.status] || x.status) + ' · ' + x.id + (arch ? ' · 已归档留档（点击查看）' : ''), style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 10, cursor: 'pointer', opacity: arch ? 0.55 : 1 } },
              React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: statusColors[x.status] || C.text2, flexShrink: 0 } }),
              React.createElement('span', { style: { color: arch ? C.text2 : C.brand, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, x.title || x.id),
              arch
                ? React.createElement('span', { style: { fontSize: 9, padding: '0 4px', borderRadius: 2, background: C.nested, color: C.text2, border: '1px solid ' + C.border, flexShrink: 0 } }, '已归档')
                : React.createElement('span', { style: { fontSize: 9, color: C.text2, flexShrink: 0 } }, statusLabels[x.status] || x.status))
          })) : null)
    }

    // ===== Hooks（可选点位）· 史诗前置/后置 agent run 的编辑与状态面板（task-muuw56yf）=====
    // 契约以 host core.normalizeHooks / mergeHooks 为准（勿凭记忆改字段名）：
    //   epic.hooks = { pre: { enabled, prompt, state, runId, pending? }, post: 同构 }，state ∈ idle|running|done|failed；
    //   hook run 记在 epic.runs[]（role 'hook-pre'/'hook-post'，字段 { role, id, at, endedAt, outcome, model }）。
    // 写入通道 = update-task RPC 的 hooks 字段（浅合并：未提交的点位保留原值，传 null 撤点位）。
    // 三条 UI 口径：
    //   ① 老卡零渲染：既无子任务、也未声明 hooks 的普通卡整块不出现（与卡片相位徽章同一门禁）；
    //   ② 权限不在 UI 判断——「hooks 仅主窗口可设」由 host 双重门禁裁决，失败原因原样 ⚠️ 回显；
    //      客户端预判角色只会把真实错误变成灰按钮，反而更难查；
    //   ③ state 只读展示（host 状态机推进，重启可恢复）；重试=把 state 置回 idle，走裁决通道，
    //      这里只负责给 failed 一个「前往裁决」锚点，不另造裁决入口。
    function hookRunOf(task, phase, runId) {
      var role = 'hook-' + phase
      // host 侧 run id 落位不对称：pre 在 spawn 成功时回填 hooks.pre.runId，post 复用 verifierRun 位
      // （claim 占位换真 id）；且两端结算都把 runId 归零——所以取不到时按角色回退「最后一条」。
      var rid = runId || (phase === 'post' ? task.verifierRun : null)
      var runs = Array.isArray(task.runs) ? task.runs : []
      var hit = null
      for (var i = 0; i < runs.length; i++) {
        if (!runs[i] || runs[i].role !== role) continue
        if (rid && runs[i].id !== rid) continue
        hit = runs[i] // 顺序遍历取最后一条匹配：重试后的新 run 覆盖旧展示
      }
      return hit
    }
    function hookStateMeta(task, phase) {
      var h = (task.hooks && task.hooks[phase]) || null
      var st = (h && h.state) || 'idle'
      var off = !h || !h.enabled
      var run = hookRunOf(task, phase, h && h.runId)
      var meta = { idle: { label: off ? '未启用' : '待运行', color: C.text2 }, running: { label: '运行中', color: C.brand }, done: { label: '已完成', color: C.ok }, failed: { label: '失败', color: C.err } }[st] || { label: String(st), color: C.text2 }
      // 耗时：运行中 = 距 spawn 的已跑时长；已落定 = spawn → endedAt 净耗时（老 run 无 endedAt 则不显示）
      var dur = ''
      if (run && run.at) {
        if (st === 'running') dur = '已跑 ' + elapsedSince(run.at)
        else if (run.endedAt) dur = '耗时 ' + fmtDur(new Date(run.at).getTime(), new Date(run.endedAt).getTime())
      }
      return { state: st, off: off, label: meta.label, color: meta.color, run: run, dur: dur }
    }
    function HooksSection(props) {
      var task = props.task
      var kHooks = task.hooks || null
      var _a = useState(''), msg = _a[0], setMsg = _a[1]
      var _b = useState(false), saving = _b[0], setSaving = _b[1]
      // 编辑缓冲以「卡上现值」为初值；父层以 key=task.id 挂载 → 切换任务自动重挂，缓冲不会串卡
      var _c = useState({ pre: { enabled: !!(kHooks && kHooks.pre && kHooks.pre.enabled), prompt: (kHooks && kHooks.pre && kHooks.pre.prompt) || '' }, post: { enabled: !!(kHooks && kHooks.post && kHooks.post.enabled), prompt: (kHooks && kHooks.post && kHooks.post.prompt) || '' } }), buf = _c[0], setBuf = _c[1]
      var kids = state.tasks.filter(function (x) { return x.parentId === task.id })
      var declared = !!(kHooks && (kHooks.pre || kHooks.post))
      if (kids.length === 0 && !declared) return null
      function setPhase(ph, patch) { var nb = { pre: buf.pre, post: buf.post }; nb[ph] = Object.assign({}, nb[ph], patch); setBuf(nb) }
      // 提交体组装（三条口径缺一都踩坑）：
      //   a) prompt 清空 = 撤掉该点位：host normalizeHooks 明确拒绝空 prompt，撤点位用 null 表达才在契约内
      //      （不该把「我不想要这个 hook 了」变成一条报错）；**例外**——该点位 state='running' 时不清空：
      //      run 还在飞，撤掉声明会让它的结算落到空点位（表现为白跑一轮），删除意图原样保留并回一行提示；
      //   b) 已声明点位的 state/runId/pending 原样回传：normalizeHooks 对缺省 state 归零成 idle，
      //      不透传就等于「改一下 prompt 把在跑/已落定的 hook 打回待运行」；
      //   c) 凑不出 prompt 的点位一律提交 null（幂等删除，不凭空造点位）。
      function payloadFor(ph) {
        var cur = (task.hooks && task.hooks[ph]) || null
        var b = buf[ph] || { enabled: false, prompt: '' }
        function keep(h) { var it = { enabled: !!h.enabled, prompt: String(h.prompt || '') }; if (h.state) it.state = h.state; if (h.runId) it.runId = h.runId; if (h.pending) it.pending = true; return it }
        if (!String(b.prompt || '').trim()) {
          if (cur && cur.state === 'running') return { item: keep(cur), warn: ph + ' 运行中：本次不清空该点位（run 还在跑），等它跑完再撤' }
          return { item: null }
        }
        var item = { enabled: !!b.enabled, prompt: String(b.prompt).slice(0, 4000) }
        if (cur) {
          if (cur.state) item.state = cur.state
          if (cur.runId) item.runId = cur.runId
          if (cur.pending) item.pending = true
        }
        return { item: item }
      }
      function save() {
        if (saving) return
        var pre = payloadFor('pre'), post = payloadFor('post')
        var warns = [pre.warn, post.warn].filter(Boolean)
        setSaving(true); setMsg('')
        rpc('update-task', { taskId: task.id, hooks: { pre: pre.item, post: post.item } }).then(function (r) {
          setSaving(false)
          if (r && r.ok === false) { setMsg('⚠️ ' + (r.error || '保存失败')); return }
          setMsg(warns.length ? '⚠️ ' + warns.join('；') : '✅ 已保存 hooks 配置')
          fetchTasks()
        }).catch(function (e) { setSaving(false); setMsg('⚠️ ' + String(e)) })
      }
      // 「前往裁决」= 同页锚点跳转（裁决区 id 固定 tskb-escalation，由 DetailView 渲染）；
      // hook 失败时 host 已把 epic 转 blocked 并挂好 escalation，这里只把视线送过去。
      function goArbitration() { var el = document.getElementById('tskb-escalation'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }) }
      function phaseRow(ph, title, hint) {
        var m = hookStateMeta(task, ph)
        var b = buf[ph] || { enabled: false, prompt: '' }
        return React.createElement('div', { key: ph, style: { marginBottom: 6, padding: '5px 7px', border: '1px solid ' + C.border, borderRadius: 5, background: C.nested } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 } },
            React.createElement('label', { style: { fontSize: 11, fontWeight: 600, color: C.text, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
              React.createElement('input', { type: 'checkbox', checked: !!b.enabled, onChange: function (e) { setPhase(ph, { enabled: e.target.checked }) }, title: '启用该点位（停用后 host 全链路跳过它）' }),
              title),
            React.createElement('span', { title: 'state 由 host 状态机推进（写在卡上，重启可恢复）；失败后重试=把 state 置回 idle，走裁决通道', style: { fontSize: 9, padding: '0 5px', borderRadius: 3, background: 'color-mix(in srgb, ' + m.color + ' 16%, transparent)', color: m.color, fontWeight: 600 } }, m.label),
            m.dur ? React.createElement('span', { style: { fontSize: 9, color: C.text2 } }, m.dur) : null,
            m.run && m.run.id ? React.createElement('button', { onClick: function () { if (uiWorkspaceSvc) uiWorkspaceSvc.openSession(m.run.id) }, title: '查看该 hook run 的会话（' + m.run.id + (m.run.model ? ' · ' + m.run.model : '') + '）', style: { fontSize: 9, padding: '1px 6px', border: '1px solid ' + C.brand, borderRadius: 3, background: 'transparent', color: C.brand, cursor: 'pointer' } }, '→ 查看会话') : null,
            m.state === 'failed' ? React.createElement('button', { onClick: goArbitration, title: '跳到本页裁决区：重试（置回 idle）/ 跳过（置 done 放行）/ 放弃（终止史诗）', style: { fontSize: 9, padding: '1px 6px', border: 'none', borderRadius: 3, background: C.err, color: C_INV, cursor: 'pointer', fontWeight: 600 } }, '前往裁决') : null),
          React.createElement('textarea', { value: b.prompt, onChange: function (e) { setPhase(ph, { prompt: e.target.value }) }, rows: 2, placeholder: '补充指令（可选）——前置=让子任务具备开跑条件；后置=把这批活收口。具体动作由 hook agent 自行决策', style: { width: '100%', fontSize: 11, padding: '4px 6px', border: '1px solid ' + C.border2, borderRadius: 4, background: C.card, color: C.text, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' } }),
          React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 3, lineHeight: 1.6 } }, hint))
      }
      return React.createElement('div', { style: { marginBottom: 8, padding: '6px 8px', border: '1px solid ' + C.border, borderRadius: 6, background: C.card } },
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 } }, ic('zap', 11), 'Hooks（可选点位）'),
        phaseRow('pre', '⏳ 前置（pre）', '让子任务具备开跑条件：未完成前该史诗的子任务一张都不派（串行闸门）。'),
        phaseRow('post', '🧪 收尾（post）', '把这批活收口：全部子任务了结后跑一遍，完成后史诗才转验证中。'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          React.createElement('button', { onClick: save, disabled: saving, title: '保存到卡上（update-task RPC，hooks 字段浅合并）', style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.brand, color: C_INV, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 } }, saving ? '保存中…' : [ic('save', 10), ' 保存 hooks']),
          msg ? React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, msg) : null),
        React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 4, lineHeight: 1.6 } }, '每个点位是一次真实 agent 运行（不是声明式命令）：prompt 只给薄框架契约与上下文，动作由 hook agent 自行决策，吃不准会歧义上报；失败即转阻塞等人裁决（重试/跳过/放弃），不会自动重跑。清空 prompt 保存 = 撤掉该点位。hooks 仅主窗口可设（host 门禁，失败原因原样回显）。'))
    }

    function DetailView() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect; var task = getTask(state.detailId)
      var _a = useState(task ? task.title : ''), editTitle = _a[0], setEditTitle = _a[1]; var _b = useState(task ? task.description || '' : ''), editDesc = _b[0], setEditDesc = _b[1]; var _c = useState(false), saving = _c[0], setSaving = _c[1]; var _d = useState(state.boardMode), mode = _d[0], setMode = _d[1]
      var _e2 = useState(''), arbAnswer = _e2[0], setArbAnswer = _e2[1]; var _f2 = useState(''), interveneMsg = _f2[0], setInterveneMsg = _f2[1]; var _g2 = useState(''), actionMsg = _g2[0], setActionMsg = _g2[1]; var _h2 = useState('resume'), arbAction = _h2[0], setArbAction = _h2[1]
      useEffect(function () { function update() { setMode(state.boardMode) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!task) { state.detailId = null; return React.createElement('div', { style: { padding: 20, color: C.text2 } }, '任务不存在') }
      function doAction(fn) { fn().then(fetchTasks).catch(function () {}) }
      function saveEdit() { setSaving(true); rpc('update-task', { taskId: task.id, title: editTitle, description: editDesc, resetToPending: true }).then(function () { setSaving(false); fetchTasks() }).catch(function () { setSaving(false) }) }
      function jumpToAgent() { if (uiWorkspaceSvc && task.claimedBy) uiWorkspaceSvc.openSession(task.claimedBy) }
      function submitArbitration() { if (!arbAnswer.trim()) return; var act = arbAction === 'hold' ? 'hold' : 'resume'; rpc('resolve-escalation', { taskId: task.id, answer: arbAnswer, action: act }).then(function (r) { setActionMsg(r && r.ok ? (act === 'hold' ? '✅ 裁决已记录，任务已挂起冻结（❄ 不参与自动派发）' : '✅ 裁决已转达，任务重新排队派发') : '⚠️ ' + ((r && r.error) || '失败')); setArbAnswer(''); setArbAction('resume'); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      function doUnfreeze() { rpc('unfreeze-task', { taskId: task.id }).then(function (r) { setActionMsg(r && r.ok ? '✅ 已解除冻结，重新进入派发池' : '⚠️ ' + ((r && r.error) || '失败')); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      function doTerminate() { rpc('terminate-agent', { taskId: task.id }).then(function (r) { setActionMsg(r && r.ok ? '⏹ 已终止 ' + (r.terminated || '') + '，任务重新排队' : '⚠️ ' + ((r && r.error) || '无活动 Agent')); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      function doDismiss() { rpc('dismiss-suspect', { taskId: task.id }).then(function () { setActionMsg('✅ 已清除卡死标记，继续观察'); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      // 手动派发（touches 文件级排他）：host 默认尊重文件锁，冲突时返回 touches-conflict；
      // 这里 confirm 列出"在等谁"后带 force:true 重发（人工越权通道：明知会并行改同一批文件）。
      // force 只在用户明确确认时加——默认调用形态与旧版一致（不带 force）。
      function doManualDispatch(role) {
        function send(force) { var a = { taskId: task.id, role: role }; if (force) a.force = true; return rpc('dispatch-task', a) }
        return send(false).then(function (r) {
          if (r && r.ok === false && r.error === 'touches-conflict') {
            var ids = Array.isArray(r.conflicts) ? r.conflicts : []
            var names = ids.map(function (id) { var t2 = getTask(id); return (t2 ? t2.title : id) + ' (' + id + ')' }).join('、')
            if (window.confirm('⚠️ 文件锁冲突：以下进行中任务正在改同一批文件（touches 重叠）：\n\n' + (names || ids.join('、')) + '\n\n强行并行可能互相覆盖改动/diff 冲突。仍要越权派发吗？')) return send(true)
            setActionMsg('⛔ 已取消派发（等文件锁释放，或调整 touches 声明）')
            return { ok: false, cancelled: true }
          }
          return r
        })
      }
      function submitIntervene() { if (!interveneMsg.trim()) return; rpc('intervene-agent', { taskId: task.id, message: interveneMsg }).then(function (r) { setActionMsg(r && r.ok ? '✅ 高优指令已插入 ' + shortId(r.agent) + ' 队首' : '⚠️ ' + ((r && r.error) || '无活动 Agent')); setInterveneMsg(''); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      var isManual = task.assignMode === 'manual'; var canJump = (task.status === 'in-progress' || task.status === 'verifying') && task.claimedBy && task.claimedBy !== state.sessionId
      var canIntervene = task.status === 'in-progress' || task.status === 'verifying'
      // ===== 无障碍·「流转到」按钮组（反馈 n-mut9rzpyc7p1）：状态流转不再只有拖拽一条路 =====
      // 合法迁移与拖拽 transition()（kernel.js）逐条对齐——host 门禁不变，失败原因 ⚠️ 回显 actionMsg 行；
      // 原生 button 元素天然键盘可达（Tab 聚焦 + Enter/Space 触发），读屏可报组名与按钮名
      var FLOW_DEF = {
        'pending': [{ to: 'in-progress', label: '▶ 开始处理', color: C.brand, tip: '领取并开始处理（待办 → 进行中）' }],
        'in-progress': [{ to: 'verifying', label: '✅ 提交验收', color: C.ok, tip: '提交验证（进行中 → 验证中），需填解决说明' }, { to: 'blocked', label: '⛔ 标记阻塞', color: C.warn, tip: '标记为阻塞（进行中 → 阻塞）' }],
        'blocked': [{ to: 'pending', label: '↩ 重投待办', color: C.brand, tip: '解除阻塞重新投放（阻塞 → 待办）' }, { to: 'in-progress', label: '▶ 开始处理', color: C.brand, tip: '领取并开始处理（阻塞 → 进行中）' }],
        'verifying': [{ to: 'resolved', label: '✔ 验收通过', color: C.ok, tip: '验收通过（验证中 → 已完成）' }, { to: 'in-progress', label: '↩ 驳回重投', color: C.err, tip: '驳回回执行中（验证中 → 进行中）' }]
      }
      var flowBtns = FLOW_DEF[task.status] || []
      function flowTo(to) {
        var p = null
        if (to === 'in-progress' && (task.status === 'pending' || task.status === 'blocked')) p = rpc('claim-task', { taskId: task.id })
        else if (to === 'pending' && task.status === 'blocked') p = rpc('update-task', { taskId: task.id, resetToPending: true })
        else if (to === 'verifying' && task.status === 'in-progress') { var res = window.prompt('提交验证 — 解决说明（必填）：'); if (!res) return; p = rpc('resolve-task', { taskId: task.id, status: 'verifying', resolution: res }) }
        else if (to === 'blocked' && task.status === 'in-progress') { var rs = window.prompt('阻塞原因（可选）：') || ''; p = rpc('resolve-task', { taskId: task.id, status: 'blocked', resolution: rs }) }
        else if (to === 'resolved' && task.status === 'verifying') p = rpc('verify-task', { taskId: task.id, verdict: 'approved' })
        else if (to === 'in-progress' && task.status === 'verifying') { var cm = window.prompt('驳回原因（可选）：'); p = rpc('verify-task', { taskId: task.id, verdict: 'rejected', comment: cm || '' }) }
        if (!p) return
        p.then(function (r) { if (r && r.ok === false) setActionMsg('⚠️ 流转失败：' + (r.error || '未知错误')); else setActionMsg('✅ 已流转到「' + (statusLabels[to] || to) + '」'); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) })
      }
      return React.createElement('div', { style: { padding: '4px 2px' } },
        React.createElement('div', { onClick: function () { state.detailId = null; notify() }, style: { fontSize: 11, color: C.brand, cursor: 'pointer', marginBottom: 8 } }, '← 返回看板'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } }, React.createElement('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'color-mix(in srgb, ' + (prioColor[task.priority] || prioColor.low) + ' 20%, transparent)', color: (prioColor[task.priority] || prioColor.low) } }, prioLabel[task.priority] || '中'), React.createElement('span', { style: { fontSize: 11, padding: '1px 8px', borderRadius: 3, background: C.nested, color: C.text } }, statusLabels[task.status] || task.status), React.createElement('select', { value: task.pipeline || 'full', onChange: function (e) { rpc('update-task', { taskId: task.id, pipeline: e.target.value }).then(fetchTasks).catch(function () {}) }, title: '管线档位', style: { fontSize: 10, padding: '1px 4px', border: '1px solid ' + C.border, borderRadius: 3, background: C.card, color: C.text2 } }, React.createElement('option', { value: 'full' }, '全流程（执行+验证）'), React.createElement('option', { value: 'work' }, '免验证（只做不验）'), React.createElement('option', { value: 'direct' }, '主窗口处理')), task.pipelineAuto ? React.createElement('span', { style: { fontSize: 9, color: C.text2 }, title: '由规则自动分类，可手动覆盖' }, 'auto') : null, isManual ? React.createElement('span', { style: { fontSize: 10, color: C.text2, display: 'inline-flex', alignItems: 'center', gap: 2 } }, ic('user', 10), '手动派发') : null),
        // 流转到按钮组（键盘可达的状态迁移入口，替代拖拽；无合法迁移的状态（draft/resolved 等）整块不渲染）
        flowBtns.length > 0 ? React.createElement('div', { role: 'group', 'aria-label': '状态流转', style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 8, padding: '5px 8px', border: '1px solid ' + C.border, borderRadius: 6, background: C.card } },
          React.createElement('span', { style: { fontSize: 10, fontWeight: 600, color: C.text2 } }, '⇄ 流转到：'),
          flowBtns.map(function (b) { return React.createElement('button', { key: b.to, onClick: function () { flowTo(b.to) }, title: b.tip, style: { fontSize: 10, padding: '3px 9px', border: '1px solid ' + b.color, borderRadius: 3, background: 'transparent', color: b.color, cursor: 'pointer', fontWeight: 600 } }, b.label) })) : null,
        // 最近失败（host settle 失败路径写入 task.lastError；缺字段静默不渲染，≤2 行截断，悬停看全文）
        task.lastError ? React.createElement('div', { style: { fontSize: 11, color: C.err, marginBottom: 8, padding: '4px 8px', border: '1px solid ' + C.err, borderRadius: 6, background: 'color-mix(in srgb, ' + C.err + ' 8%, transparent)', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', wordBreak: 'break-all' }, title: String(task.lastError) }, '最近失败: ' + String(task.lastError)) : null,
        task.frozen ? React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 8, padding: '6px 8px', border: '1px solid ' + C.brand, borderRadius: 6, background: 'color-mix(in srgb, ' + C.brand + ' 8%, transparent)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontWeight: 600 } }, '❄ 已冻结：不参与自动派发'),
          React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, '裁决挂起' + (task.frozenAt ? '（' + ago(task.frozenAt) + '）' : '') + '，留出补 dependsOn/上下文的时间；解冻后重新入池'),
          React.createElement('button', { onClick: doUnfreeze, title: '清除冻结标记并触发派发', style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.brand, color: C_INV, cursor: 'pointer', fontWeight: 600, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('refresh-cw', 10), '解除冻结')) : null,
        (Array.isArray(task.waitingForTouches) && task.waitingForTouches.length) ? React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 8, padding: '6px 8px', border: '1px solid ' + C.warn, borderRadius: 6, background: 'color-mix(in srgb, ' + C.warn + ' 8%, transparent)' } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 2 } }, '🔒 等文件锁释放：暂不自动派发'),
          React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 4 } }, '本任务声明的 touches 与以下进行中任务重叠（同一批文件并行改会互踩）；它们提交验收/完成后自动派发。'),
          React.createElement('div', { style: { fontSize: 10, display: 'flex', flexWrap: 'wrap', gap: 5 } }, task.waitingForTouches.map(function (id) { var t2 = getTask(id); return React.createElement('span', { key: id, onClick: function () { if (t2) { state.detailId = id; notify() } }, title: t2 ? (t2.title + ' (' + id + ')') : id, style: { padding: '1px 5px', borderRadius: 3, background: C.nested, border: '1px solid ' + C.border, color: t2 ? C.brand : C.text2, cursor: t2 ? 'pointer' : 'default' } }, (t2 ? t2.title.slice(0, 20) : shortId(id)) + ' · ' + shortId(id)) })),
          Array.isArray(task.touches) && task.touches.length ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 4 } }, '本任务 touches: ' + task.touches.join('、')) : null) : null,
        Array.isArray(task.touches) && task.touches.length ? React.createElement('div', { style: { fontSize: 11, color: C.text2, marginBottom: 6, padding: '4px 6px', background: C.nested, borderRadius: 4 } }, '🔒 文件级排他（touches）: ' + task.touches.join('、')) : null,
        (task.status === 'in-progress' || task.status === 'verifying') && state.activity[task.id] ? React.createElement('div', { style: { fontSize: 10, color: C.brand, marginBottom: 8, padding: '4px 8px', background: C.nested, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4, animation: 'tskb-pulse 2s ease-in-out infinite' } }, ic('activity', 10), React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '当前动作: ' + state.activity[task.id])) : null,
        task.status === 'in-progress' && task.claimedBy ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 8, padding: '5px 8px', background: C.nested, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          ic('activity', 10),
          React.createElement('span', null, '已运行 ' + elapsedSince(task.claimedAt) + '（软超时 ' + state.softTimeoutMin + ' 分提醒 · 硬超时 ' + state.hardTimeoutMin + ' 分自动终止）'),
          elapsedMin(task.claimedAt) > state.softTimeoutMin ? React.createElement('span', { style: { color: C.warn, fontWeight: 600 } }, '⏱ 已超软超时') : null,
          React.createElement('button', { onClick: doTerminate, title: '终止该执行 Agent，任务回 pending 重新排队', style: { fontSize: 10, padding: '2px 8px', border: '1px solid ' + C.err, borderRadius: 3, background: 'transparent', color: C.err, cursor: 'pointer', marginLeft: 'auto' } }, '⏹ 立即终止')) : null,
        task.escalation ? React.createElement('div', { id: 'tskb-escalation', style: { marginBottom: 8, padding: '8px 10px', border: '1px solid ' + C.err, borderRadius: 6, background: 'color-mix(in srgb, ' + C.err + ' 8%, transparent)' } },
          React.createElement('div', { style: { fontSize: 12, fontWeight: 700, color: C.err, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 } }, ic('alert-triangle', 13), 'Worker 上报歧义 — 等待主窗口裁决'),
          React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 6, whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' } }, task.escalation.question),
          React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 6 } }, '上报于 ' + ago(task.escalation.at) + ' · ' + (task.escalation.by || '')),
          React.createElement('textarea', { value: arbAnswer, onChange: function (e) { setArbAnswer(e.target.value) }, rows: 2, placeholder: '输入裁决指示，将直接转达给原 Worker（保有上下文）…', style: { width: '100%', fontSize: 11, padding: '5px 8px', marginBottom: 4, border: '1px solid ' + C.err, borderRadius: 4, background: C.card, color: C.text, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' } }),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            React.createElement('select', { value: arbAction, onChange: function (e) { setArbAction(e.target.value) }, title: '裁决后任务去向：重新派发=立即回派发池；挂起冻结=不参与自动派发，留出补 dependsOn/上下文的时间', style: { fontSize: 10, padding: '4px 4px', border: '1px solid ' + C.err, borderRadius: 4, background: C.card, color: C.text } },
              React.createElement('option', { value: 'resume' }, '裁决后：重新派发'),
              React.createElement('option', { value: 'hold' }, '裁决后：挂起冻结 ❄')),
            React.createElement('button', { onClick: submitArbitration, disabled: !arbAnswer.trim(), style: { fontSize: 11, padding: '4px 12px', border: 'none', borderRadius: 4, background: C.err, color: C_INV, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 } }, ic('scale', 12), '提交裁决'),
            arbAction === 'hold' ? React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, '冻结后不参与自动派发，补完上下文可在详情页「解除冻结」放行') : null)) : null,
        actionMsg ? React.createElement('div', { style: { fontSize: 11, color: C.text2, marginBottom: 6 } }, actionMsg) : null,
        task.stuckSince ? React.createElement('div', { style: { marginBottom: 8, padding: '8px 10px', border: '1px solid ' + C.warn, borderRadius: 6, background: 'color-mix(in srgb, ' + C.warn + ' 8%, transparent)' } },
          React.createElement('div', { style: { fontSize: 12, fontWeight: 700, color: C.warn, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 } }, ic('alert-triangle', 13), '执行 Agent 疑似卡死'),
          React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 6 } }, '标记于 ' + ago(task.stuckSince) + '（运行超 5 分钟且事件流停滞超 1 分钟）。你可以查看其会话后决定：'),
          React.createElement('div', { style: { display: 'flex', gap: 6 } },
            React.createElement('button', { onClick: doTerminate, style: { fontSize: 11, padding: '4px 12px', border: 'none', borderRadius: 4, background: C.err, color: C_INV, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 } }, ic('stop-circle', 12), '终止任务（重新排队）'),
            React.createElement('button', { onClick: doDismiss, style: { fontSize: 11, padding: '4px 12px', border: '1px solid ' + C.border, borderRadius: 4, background: 'transparent', color: C.text2, cursor: 'pointer' } }, '继续观察'),
            canJump ? React.createElement('button', { onClick: jumpToAgent, style: { fontSize: 11, padding: '4px 12px', border: '1px solid ' + C.brand, borderRadius: 4, background: 'transparent', color: C.brand, cursor: 'pointer' } }, '→ 查看会话') : null)) : null,
        React.createElement('input', { value: editTitle, onChange: function (e) { setEditTitle(e.target.value) }, style: { width: '100%', fontSize: 13, fontWeight: 600, padding: '4px 6px', marginBottom: 6, border: '1px solid ' + C.border2, borderRadius: 4, background: C.card, color: C.text, boxSizing: 'border-box' } }),
        React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 8, lineHeight: 1.7 } }, React.createElement('div', null, 'ID: ' + task.id), React.createElement('div', null, '创建: ' + fmtTime(task.createdAt) + '（' + ago(task.createdAt) + '）'), task.claimedBy ? React.createElement('div', null, '领取人: ', React.createElement(ActorLink, { id: task.claimedBy }), ' · ' + ago(task.claimedAt)) : null, task.resolvedAt ? React.createElement('div', null, '提交: ' + fmtTime(task.resolvedAt)) : null, task.verifiedAt ? React.createElement('div', null, '验收: ' + fmtTime(task.verifiedAt) + ' by ', React.createElement(ActorLink, { id: task.verifiedBy })) : null),
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 3 } }, '任务描述'),
        React.createElement('textarea', { value: editDesc, onChange: function (e) { setEditDesc(e.target.value) }, rows: 3, style: { width: '100%', fontSize: 12, padding: '6px 8px', marginBottom: 6, border: '1px solid ' + C.border2, borderRadius: 4, background: C.card, color: C.text, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' } }),
        task.context && task.context.instructions ? React.createElement('div', { style: { fontSize: 11, color: C.text2, marginBottom: 6, padding: '4px 6px', background: C.nested, borderRadius: 4 } }, '指引: ' + task.context.instructions) : null,
        // ===== 调研注入清单（调研门禁·详情侧，与卡片「⚠️ 无调研」徽章同口径）=====
        // 一行汇总派发时注入给 Worker/Verifier 的调研上下文：files 数量 + basename 清单（悬停看完整路径）、
        // notes 字数统计（悬停看原文，超 500 字截断标注）；两者皆空 → 明示「无调研注入」。
        // context 缺省兼容：老任务无 context 对象按空处理——同样亮出空态，这是预期（立单质量问责）。
        // 行风格对齐上方「最近失败」行（border + color-mix 淡底）：空态 warn 黄调，有内容走中性 nested。
        (function () {
          var cx = task.context || {}
          var files = Array.isArray(cx.files) ? cx.files : []
          var notes = typeof cx.notes === 'string' ? cx.notes : ''
          var empty = files.length === 0 && notes.trim().length === 0
          var parts = []
          if (files.length) parts.push(files.length + ' 个文件（' + files.map(function (f) { return actBase(f) }).join('、') + '）')
          if (notes.trim()) parts.push('调研笔记 ' + notes.length + ' 字')
          var tip = empty ? '本任务未附调研上下文，Worker 需自行定位——建议补 contextFiles/contextNotes'
            : (files.length ? '完整路径：\n' + files.join('\n') : '') + (notes.trim() ? (files.length ? '\n\n' : '') + '调研笔记原文：\n' + (notes.length > 500 ? notes.slice(0, 500) + '…（共 ' + notes.length + ' 字）' : notes) : '')
          return React.createElement('div', { style: { fontSize: 11, marginBottom: 8, padding: '4px 8px', border: '1px solid ' + (empty ? C.warn : C.border), borderRadius: 6, background: empty ? 'color-mix(in srgb, ' + C.warn + ' 8%, transparent)' : C.nested, color: empty ? C.warn : C.text2, wordBreak: 'break-word' }, title: tip },
            '📎 调研注入: ' + (empty ? '无调研注入——Worker 需自行定位，建议补 contextFiles/contextNotes' : parts.join(' · ')))
        })(),
        React.createElement(FamilySection, { task: task }),
        // Hooks 区（史诗可选点位）：key=task.id 保证切换任务时重挂，编辑缓冲不串卡
        React.createElement(HooksSection, { key: task.id, task: task }),
        React.createElement(DepsSection, { task: task }),
        task.acceptance ? React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 6, padding: '5px 8px', background: C.nested, borderRadius: 4, borderLeft: '2px solid ' + C.ok, fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 4 } }, ic('flask-conical', 11), '硬性验收: ' + task.acceptance) : null,
        task.resolution ? React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 6, padding: '5px 8px', background: C.nested, borderRadius: 4, borderLeft: '2px solid ' + C.warn, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap' } }, '📝 ' + task.resolution) : null,
        task.deliverable ? React.createElement('div', { style: { marginBottom: 8, padding: '6px 8px', border: '1px solid ' + C.border, borderRadius: 6, background: C.card } },
          React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: C.brand, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 } }, ic('package', 12), '交付报告 · ' + (task.deliverable.by || '') + ' · ' + ago(task.deliverable.at)),
          React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 4, whiteSpace: 'pre-wrap' } }, task.deliverable.summary || '(无开发描述)'),
          task.deliverable.changes ? React.createElement('div', { style: { marginTop: 4 } }, React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2 } }, '改动清单'), React.createElement('div', { style: { fontSize: 10, color: C.text2, whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto' } }, task.deliverable.changes)) : null,
          task.deliverable.selfTest ? React.createElement('div', { style: { marginTop: 4 } }, React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2 } }, '自测情况'), React.createElement('div', { style: { fontSize: 10, color: C.text2, whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto' } }, task.deliverable.selfTest)) : null) : null,
        task.verification ? React.createElement('div', { style: { marginBottom: 8, padding: '6px 8px', border: '1px solid ' + (task.verification.verdict === 'approved' ? C.ok : C.err), borderRadius: 6, background: C.card } },
          React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: task.verification.verdict === 'approved' ? C.ok : C.err, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 } }, ic(task.verification.verdict === 'approved' ? 'clipboard-check' : 'clipboard-x', 12), (task.verification.verdict === 'approved' ? '验收通过' : '验收驳回') + ' · ' + (task.verification.by || '') + ' · ' + ago(task.verification.at)),
          React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 4, whiteSpace: 'pre-wrap' } }, task.verification.summary || '(无测试概要)'),
          task.verification.checks ? React.createElement('div', { style: { marginTop: 4 } }, React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2 } }, '核对项'), React.createElement('div', { style: { fontSize: 10, color: C.text2, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' } }, task.verification.checks)) : null) : null,
        React.createElement(MsgThread, { messages: task.messages, taskId: task.id }),
        Array.isArray(task.history) && task.history.length > 0 ? React.createElement('div', { style: { marginBottom: 8 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 3 } }, '流转轨迹'), React.createElement('div', { style: { fontSize: 10, color: C.text2, padding: '4px 6px', background: C.nested, borderRadius: 4 } }, task.history.map(function (h, i) { return React.createElement('div', { key: i, style: { marginBottom: 2 } }, React.createElement('span', { style: { color: C.brand } }, statusLabels[h.to] || h.to), ' · ' + ago(h.timestamp) + ' · ', React.createElement(ActorLink, { id: h.actor }), h.note ? ' · ' + h.note : '') }))) : null,
        React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 } },
          React.createElement('button', { onClick: saveEdit, disabled: saving, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.brand, color: C_INV, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 } }, saving ? '保存中…' : [ic('save', 10), ' 保存并重置']),
          task.status === 'draft' ? React.createElement('button', { onClick: function () { doAction(function () { return rpc('update-task', { taskId: task.id, publish: true }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.ok, color: C_INV, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('rocket', 10), '发布（进入派发池）') : null,
          (task.status === 'pending' || task.status === 'blocked') ? React.createElement('button', { onClick: function () { doAction(function () { return rpc('claim-task', { taskId: task.id }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.brand, color: C_INV, cursor: 'pointer' } }, '领取') : null,
          task.status === 'pending' ? React.createElement('button', { onClick: function () { doAction(function () { return doManualDispatch('worker') }) }, title: '手动派发给一次性 Worker 子代理', style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.warn, color: C_INV, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('zap', 10), '派发') : null,
          task.status === 'verifying' && !task.escalation ? React.createElement('button', { onClick: function () { doAction(function () { return doManualDispatch('verifier') }) }, title: '手动派发给一次性 Verifier 子代理', style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.warn, color: C_INV, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('zap', 10), '派发验收') : null,
          task.status === 'verifying' ? React.createElement('button', { onClick: function () { doAction(function () { return rpc('verify-task', { taskId: task.id, verdict: 'approved' }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.ok, color: C_INV, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('check-circle', 10), '通过') : null,
          task.status === 'verifying' ? React.createElement('button', { onClick: function () { var r = window.prompt('驳回原因：'); doAction(function () { return rpc('verify-task', { taskId: task.id, verdict: 'rejected', comment: r || '' }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.err, color: C_INV, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('x-circle', 10), '驳回') : null,
          task.status === 'resolved' ? React.createElement('button', { onClick: function () { doAction(function () { return rpc('archive-task', { taskId: task.id }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.text2, color: C_INV, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('archive', 10), '归档') : null),
          // 删除（仅草稿/待办/阻塞）：confirm 防误删；被 host 门禁拒绝时把原因回显到详情页 actionMsg
          // 容器 div 的收尾括号已挂在「归档」行；删除按钮作为**额外一行元素**排在它后面
          // （多一个实参给同一个 createElement，属于合法调用），因此本行自身必须配平。
          canDelete(task) ? React.createElement('button', { onClick: function () { deleteTask(task.id, task.title, setActionMsg) }, title: '删除任务（不可恢复；执行中请先终止，已落定请用归档）', style: { fontSize: 10, padding: '3px 8px', border: '1px solid ' + C.err, borderRadius: 3, background: 'transparent', color: C.err, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic('trash-2', 10), '删除') : null,
        (function () {
          // 历史会话：无论任务处于哪个阶段都完整列出（Worker 各次 + Verifier 各次）
          var runs = historyRuns(task)
          if (!runs.length) return null
          var roleMeta = { worker: { label: 'W', color: C.brand, tip: 'Worker' }, verifier: { label: 'V', color: C.warn, tip: 'Verifier' } }
          var wN = 0, vN = 0
          return React.createElement('div', { style: { marginTop: 8, padding: '6px 8px', background: C.nested, borderRadius: 6 } },
            React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 } }, ic('users', 10), '历史会话（点击跳转查看，含全部重试）'),
            React.createElement('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
              runs.map(function (r, i) {
                var rm = roleMeta[r.role] || roleMeta.worker
                var seq = r.role === 'verifier' ? (++vN) : (++wN)
                var isCur = (r.role === 'worker' && task.claimedBy === r.id) || (r.role === 'verifier' && task.verifierRun === r.id)
                var okMark = r.outcome === 'completed' ? ' ✅' : (r.outcome === 'running' ? ' ⏳' : (r.outcome ? ' ⚠' : ''))
                return React.createElement('button', {
                  key: i, onClick: function () { if (uiWorkspaceSvc) uiWorkspaceSvc.openSession(r.id) },
                  title: rm.tip + ' 第 ' + seq + ' 次' + (r.at ? ' · ' + ago(r.at) : '') + (r.model ? ' · ' + r.model : '') + (r.outcome ? ' · ' + r.outcome : '') + '（' + r.id + '）',
                  style: { fontSize: 10, padding: '2px 8px', border: '1px solid ' + (isCur ? rm.color : C.border), borderRadius: 3, background: isCur ? C.card : 'transparent', color: rm.color, cursor: 'pointer', fontWeight: isCur ? 600 : 400 }
                }, '→ ' + rm.tip + ' #' + seq + (r.at ? ' · ' + ago(r.at) : '') + okMark)
              })))
        })(),
        canIntervene ? React.createElement('div', { style: { marginTop: 8, padding: '6px 8px', border: '1px dashed ' + C.warn, borderRadius: 6 } },
          React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.warn, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 } }, ic('zap', 11), '高优先级介入（插入执行 Agent 队首）'),
          React.createElement('div', { style: { display: 'flex', gap: 4 } },
            React.createElement('input', { value: interveneMsg, onChange: function (e) { setInterveneMsg(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') submitIntervene() }, placeholder: '给执行中的 Agent 下达高优指令…', style: { flex: 1, fontSize: 11, padding: '4px 8px', border: '1px solid ' + C.border2, borderRadius: 4, background: C.card, color: C.text } }),
            React.createElement('button', { onClick: submitIntervene, disabled: !interveneMsg.trim(), style: { fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 4, background: C.warn, color: C_INV, cursor: 'pointer', fontWeight: 600 } }, '介入'))) : null)
    }

// ============================================================================
// dashboard —— 仪表盘域：统计（computeStats/TrendChart/StatCard/BarRow/ResearchRoiRow）· 范围筛选（RangeFilter）
//   · 全局总览（GlobalBoards）· 报告（buildReport/ReportButton）· Token 消耗（TokenUsage）
//   · 架构健康（HealthHints，架构自省 L1）
//   · 团队池（TeamView/PoolStatus）· 设置（WorkModeSwitch/PoolCfg/MinCfg/ModelCfg/PoolCfgPopover）
// 本文件是 apply(ctx) 函数体片段，不可独立运行；由 scripts/build-client.cjs 按序拼接生成 lib/client.js。
// ============================================================================

    function computeStats(tasks) {
      var total = tasks.length, byStatus = {}, byPriority = {}, byAgent = {}, queueTimes = [], execTimes = [], verifyTimes = [], todayDone = 0, todayStart = new Date(); todayStart.setHours(0, 0, 0, 0); var recentActivity = []
      var dailyDone = [] // #15 近 7 天每日完成趋势
      for (var di = 6; di >= 0; di--) { var dayStart = new Date(todayStart); dayStart.setDate(dayStart.getDate() - di); var dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1); dailyDone.push({ label: (dayStart.getMonth() + 1) + '/' + dayStart.getDate(), count: 0, start: dayStart, end: dayEnd }) }
      tasks.forEach(function (t) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; byPriority[t.priority || 'medium'] = (byPriority[t.priority || 'medium'] || 0) + 1; if (t.claimedBy && (t.status === 'in-progress' || t.status === 'verifying')) { if (!byAgent[t.claimedBy]) byAgent[t.claimedBy] = 0; byAgent[t.claimedBy]++ } if (t.createdAt && t.claimedAt) queueTimes.push(new Date(t.claimedAt) - new Date(t.createdAt)); if (t.claimedAt && t.resolvedAt) execTimes.push(new Date(t.resolvedAt) - new Date(t.claimedAt)); if (t.verifiedAt && t.resolvedAt) verifyTimes.push(new Date(t.verifiedAt) - new Date(t.resolvedAt)); if (t.resolvedAt) { var rd = new Date(t.resolvedAt); if (rd >= todayStart) todayDone++; for (var k = 0; k < dailyDone.length; k++) { if (rd >= dailyDone[k].start && rd < dailyDone[k].end) { dailyDone[k].count++; break } } } if (Array.isArray(t.history)) t.history.forEach(function (h) { recentActivity.push({ taskId: t.id, title: t.title, from: h.from, to: h.to, actor: h.actor, timestamp: h.timestamp, note: h.note }) }) })
      recentActivity.sort(function (a, b) { return (b.timestamp || '').localeCompare(a.timestamp || '') }); recentActivity = recentActivity.slice(0, 10)
      function avgMs(arr) { if (arr.length === 0) return null; var s = arr.reduce(function (a, b) { return a + b }, 0); return Math.round(s / arr.length) }
      function fmtMs(ms) { if (!ms) return '-'; var m = Math.floor(ms / 60000); if (m < 60) return m + ' 分钟'; var h = Math.floor(m / 60); if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分'; return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 时' }
      // 调研 ROI 分组（task-mutnjesa）：resolved/archived 且有执行数据（claimedAt→resolvedAt 可算，
      //   无 claimedAt 的手工/direct 卡跳过）的卡按「有无调研注入」分两组——有调研 = context.files /
      //   context.notes 任一非空（context 缺省按无调研，与详情页「调研注入」行同口径）。
      //   与 usageSummary 同哲学：纯现算零存储。任一组为空或总样本 <4 时 roi=null（样本太少没说服力，不渲染）。
      var roiYes = [], roiNo = []
      tasks.forEach(function (t) {
        if (t.status !== 'resolved' && t.status !== 'archived') return
        if (!t.claimedAt || !t.resolvedAt) return
        var execMs = new Date(t.resolvedAt) - new Date(t.claimedAt)
        if (!(execMs >= 0)) return // 时间戳异常（NaN/负值）跳过
        var cx = t.context || {}
        var hasRes = (Array.isArray(cx.files) && cx.files.length > 0) || (typeof cx.notes === 'string' && cx.notes.trim().length > 0)
        // token 口径与「Token 消耗区」一致化（task-muupnnq5）：取**有效消耗**（输入+输出+缓存写，不含缓存读），
        //   不再拿含缓存读的 total 冒充——本板实测缓存读占总量 ~94%，用 total 会让 ROI 行的 token 均值虚高十几倍，
        //   与 Token 区大数字口径互相打架。分量字段缺失的老/存量卡兜底退化为 total 并打 tokFallback 标记（title 标注），
        //   绝不把总量伪装成有效值；无任何结算记录的卡 tok=null，不参与均值（不拉低样本）。
        var tk = roiTokenOf(t.usage)
        ;(hasRes ? roiYes : roiNo).push({ execMs: execMs, tok: tk.tok, tokFallback: tk.fallback })
      })
      var roi = null
      if (roiYes.length > 0 && roiNo.length > 0 && roiYes.length + roiNo.length >= 4) {
        var roiAgg = function (arr) {
          var execMs = Math.round(arr.reduce(function (a, b) { return a + b.execMs }, 0) / arr.length)
          var toks = [], fb = 0
          arr.forEach(function (x) { if (x.tok !== null) { toks.push(x.tok); if (x.tokFallback) fb++ } })
          return { n: arr.length, execMs: execMs, tok: toks.length ? Math.round(toks.reduce(function (a, b) { return a + b }, 0) / toks.length) : null, tokN: toks.length, tokFallbackN: fb }
        }
        roi = { yes: roiAgg(roiYes), no: roiAgg(roiNo) }
      }
      // 耗时口径三分离（task-mutdnitw）：avgQueue=平均排队（创建→被领取）、avgExec=平均执行（被领取→完成），均只统计领取过的卡；avgVerify 口径不动（完成→验收）
      return { total: total, byStatus: byStatus, byPriority: byPriority, byAgent: byAgent, avgQueue: fmtMs(avgMs(queueTimes)), avgExec: fmtMs(avgMs(execTimes)), avgVerify: fmtMs(avgMs(verifyTimes)), todayDone: todayDone, dailyDone: dailyDone, recentActivity: recentActivity, roi: roi }
    }

    // 单卡 token 口径（task-muupnnq5）：ROI 行与「Token 消耗区」口径同源，避免同一张卡两处两个数。
    //   有分量（input/output/cacheWrite 任一 >0）→ 有效消耗（不含缓存读）；只有 total 的老/存量卡 → 兜底 total 并标 fallback；
    //   两者皆无 → tok=null（无结算样本，跳过而不是记 0，避免拉低均值）。
    //   注：客户端 bundle 只注入 React（无模块系统），故此处内联，host 侧同款判定在 lib/usage.mjs taskEffectiveTokens。
    function roiTokenOf(u) {
      if (!u) return { tok: null, fallback: false }
      function pos(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0 }
      var inp = pos(u.input), outp = pos(u.output), cw = pos(u.cacheWrite), tot = pos(u.total)
      if (inp > 0 || outp > 0 || cw > 0) return { tok: inp + outp + cw, fallback: false }
      if (tot > 0) return { tok: tot, fallback: true }
      return { tok: null, fallback: false }
    }

    function TrendChart(props) {
      var data = props.data || []
      var max = 1; data.forEach(function (d) { if (d.count > max) max = d.count })
      return React.createElement('div', { style: { padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, marginBottom: 12 } },
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, '近 7 天完成趋势'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 40 } },
          data.map(function (d, i) {
            var h = d.count > 0 ? Math.max(10, Math.round(d.count / max * 36)) : 3
            return React.createElement('div', { key: i, style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 1 }, title: d.label + ': ' + d.count + ' 个完成' },
              d.count > 0 ? React.createElement('span', { style: { fontSize: 8, color: C.text2 } }, String(d.count)) : null,
              React.createElement('div', { style: { width: '100%', maxWidth: 28, height: h + 'px', borderRadius: 2, background: d.count > 0 ? C.ok : C.nested, transition: 'height .3s' } }),
              React.createElement('span', { style: { fontSize: 8, color: C.text2 } }, d.label))
          })))
    }

    function StatCard(props) { return React.createElement('div', { style: { flex: '1 1 0', minWidth: 80, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, textAlign: 'center' } }, React.createElement('div', { style: { fontSize: 20, fontWeight: 700, color: props.color || C.text } }, String(props.value)), React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 2 } }, props.label)) }

    // 双行指标卡（耗时口径三分离：原「平均完成时间」一个展示位拆为 排队/执行 两行，不挤占其他指标位）
    function StatCardDual(props) { return React.createElement('div', { style: { flex: '1 1 0', minWidth: 80, padding: '6px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, textAlign: 'center' }, title: props.title }, React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: props.color || C.text } }, String(props.value1)), React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 1 } }, props.label1), React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: props.color || C.text, marginTop: 3 } }, String(props.value2)), React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 1 } }, props.label2)) }

    // 调研 ROI 对比行（task-mutnjesa）：让数据替道理说话——「有调研 vs 无调研」分组账单直接摆给主窗口看，
    //   比任何引导文案都管用。数据源 computeStats 的 roi（null = 任一组为空或总样本 <4，整块不渲染）；
    //   无调研组明显更慢（平均执行 > 有调研组 1.2 倍，阈值写清避免把随机波动误读成结论）时其数字用 warn 色。
    //   token 口径（task-muupnnq5）：**有效消耗**（输入+输出+缓存写，不含缓存读），与「Token 消耗区」大数字同源；
    //   组内只要有一张卡走了 total 兜底（无分量字段的老/存量卡），该数字后加 '~' 并在 title 里写明张数。
    function ResearchRoiRow(props) {
      var roi = props.roi
      if (!roi) return null
      function fmtM(ms) { var m = Math.round(ms / 60000); if (m < 60) return m + 'm'; return (m / 60).toFixed(1) + 'h' }
      var noSlower = roi.no.execMs > roi.yes.execMs * 1.2
      function grp(icon, label, g, warnNums) {
        var approx = (g.tokFallbackN || 0) > 0
        var tip = g.tok === null ? label + '：无带 usage 结算记录的卡，token 均值不可计'
          : g.n + ' 卡中 ' + g.tokN + ' 张有 usage 结算记录；均值口径 = 有效消耗（输入+输出+缓存写，不含缓存读）'
            + (approx ? '；其中 ' + g.tokFallbackN + ' 张无分量字段（老/存量结算），退化为含缓存读的合计值参与均值（故标 ~）' : '')
        return React.createElement('span', { title: tip },
          icon + ' ' + label + ' ',
          React.createElement('span', { style: { fontWeight: 600, color: warnNums ? C.warn : C.text } }, g.n + ' 卡 平均 ' + fmtM(g.execMs) + '/约 ' + (g.tok === null ? '-' : (approx ? '~' : '') + fmtTokens(g.tok)) + ' tok'))
      }
      return React.createElement('div', { style: { padding: '6px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, marginBottom: 12, fontSize: 10, color: C.text2, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }, title: 'resolved/archived 且领取过的卡按有无调研注入分组现算（执行 = 被领取→完成；token 均值只计有 usage 结算记录的卡，口径 = 有效消耗：输入+输出+缓存写，不含缓存读；老卡无分量字段时退化为合计并标 ~）' },
        React.createElement('span', { style: { fontSize: 11, fontWeight: 600, color: C.text2, display: 'inline-flex', alignItems: 'center', gap: 4 } }, ic('scale', 11), '调研 ROI'),
        grp('📎', '有调研', roi.yes, false),
        React.createElement('span', null, '·'),
        grp('⚠️', '无调研', roi.no, noSlower))
    }

    function BarRow(props) { var pct = props.total > 0 ? (props.count / props.total * 100) : 0; return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } }, React.createElement('span', { style: { width: 40, fontSize: 10, color: C.text2, textAlign: 'right', flexShrink: 0 } }, props.label), React.createElement('div', { style: { flex: 1, height: 8, background: C.nested, borderRadius: 4, overflow: 'hidden' } }, React.createElement('div', { style: { height: '100%', width: pct + '%', background: props.color || C.brand, borderRadius: 4, transition: 'width .3s' } })), React.createElement('span', { style: { width: 24, fontSize: 10, color: C.text2, flexShrink: 0 } }, String(props.count))) }

    // ===== 仪表盘：日期范围筛选（共享给报告与全局总览）=====
    function tsInRange(iso, from, to) {
      if (!iso) return false
      var d = new Date(iso); if (isNaN(d.getTime())) return false
      var ds = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2)
      if (from && ds < from) return false
      if (to && ds > to) return false
      return true
    }
    function taskLastTs(t) {
      var last = t.createdAt || ''
      ;(t.history || []).forEach(function (h) { if (h.timestamp > last) last = h.timestamp })
      if (t.deliverable && t.deliverable.at > last) last = t.deliverable.at
      if (t.verification && t.verification.at > last) last = t.verification.at
      if (t.archivedAt && t.archivedAt > last) last = t.archivedAt
      return last
    }
    function activeRange() { var f = state.dateRange || {}; return { from: f.from || '', to: f.to || '' } }
    function rangeLabel() { var r = activeRange(); return !r.from && !r.to ? '全部时间' : (r.from || '…') + ' ~ ' + (r.to || '…') }
    function RangeFilter() {
      var _R = React; var useState = _R.useState
      var _a = useState(state.rfOpen || false), open = _a[0], setOpen = _a[1]
      var rg = activeRange()
      function setRange(from, to) { state.dateRange = { from: from, to: to }; notify() }
      function preset(days) {
        if (days === 0) { setRange('', ''); return }
        var to = new Date(); var from = new Date(Date.now() - (days - 1) * 86400000)
        function fmt(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) }
        setRange(fmt(from), fmt(to))
      }
      var headBtn = { fontSize: 11, padding: '3px 10px', border: '1px solid ' + (rg.from || rg.to ? C.brand : C.border), borderRadius: 5, background: (rg.from || rg.to) ? C.nested : C.card, color: (rg.from || rg.to) ? C.brand : C.text2, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }
      var chip = { fontSize: 10, padding: '2px 8px', border: '1px solid ' + C.border2, borderRadius: 10, background: C.card, color: C.text2, cursor: 'pointer' }
      var dateInput = { fontSize: 11, padding: '2px 6px', border: '1px solid ' + C.border2, borderRadius: 4, background: C.card, color: C.text }
      return React.createElement('div', { style: { marginBottom: 10 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          React.createElement('button', { onClick: function () { state.rfOpen = !open; setOpen(!open) }, style: headBtn },
            ic('calendar-days', 11),
            React.createElement('span', null, '统计范围: ' + rangeLabel()),
            ic(open ? 'chevron-up' : 'chevron-down', 10))),
        open ? React.createElement('div', { style: { marginTop: 6, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, '快捷:'),
            React.createElement('button', { onClick: function () { preset(1) }, style: chip }, '今天'),
            React.createElement('button', { onClick: function () { preset(7) }, style: chip }, '近 7 天'),
            React.createElement('button', { onClick: function () { preset(30) }, style: chip }, '近 30 天'),
            React.createElement('button', { onClick: function () { preset(0) }, style: chip }, '全部'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('label', { style: { fontSize: 10, color: C.text2, display: 'inline-flex', alignItems: 'center', gap: 4 } }, '开始',
              React.createElement('input', { type: 'date', value: rg.from, onChange: function (e) { setRange(e.target.value, rg.to) }, style: dateInput })),
            React.createElement('label', { style: { fontSize: 10, color: C.text2, display: 'inline-flex', alignItems: 'center', gap: 4 } }, '截至',
              React.createElement('input', { type: 'date', value: rg.to, onChange: function (e) { setRange(rg.from, e.target.value) }, style: dateInput })),
            React.createElement('span', { style: { fontSize: 9, color: C.text2 } }, '作用于报告与全局总览')),
          React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 5 } }, '报告统计「时间范围内有活动」的任务；总览只显示范围内有活跃的会话。')) : null)
    }

    function GlobalBoards() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(state.globalBoards), boards = _a[0], setBoards = _a[1]
      var _b = useState(state.gboOpen || false), open = _b[0], setOpen = _b[1]
      function load() { rpc('list-boards').then(function (r) { var b = (r && r.boards) || []; state.globalBoards = b; setBoards(b) }).catch(function () {}) }
      useEffect(function () { load() }, [])
      if (!boards.length) return null
      var rg = activeRange()
      var shown = boards.filter(function (b) { return !rg.from && !rg.to ? true : tsInRange(b.lastActivity, rg.from, rg.to) })
      var activeN = boards.filter(function (b) { return b.counts.inProgress || b.counts.verifying || b.counts.pending || b.counts.blocked }).length
      return React.createElement('div', { style: { padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, marginBottom: 12 } },
        React.createElement('div', { onClick: function () { state.gboOpen = !open; setOpen(!open); if (!open) load() }, style: { fontSize: 11, fontWeight: 600, color: C.text2, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 } },
          ic('layout-grid', 11),
          React.createElement('span', null, '全局会话总览（本机 ' + boards.length + ' 个看板 · ' + activeN + ' 个活跃）'),
          open && (rg.from || rg.to) ? React.createElement('span', { style: { fontSize: 9, color: C.brand } }, '范围: ' + rangeLabel()) : null,
          React.createElement('span', { style: { marginLeft: 'auto', display: 'inline-flex', color: C.text2 } }, ic(open ? 'chevron-up' : 'chevron-down', 11))),
        open ? (shown.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2, padding: '6px 0' } }, '时间范围内无活跃会话') : shown.map(function (b, i) {
          var isSelf = b.session === state.sessionId
          return React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, padding: '3px 0', borderBottom: '1px solid ' + C.nested } },
            React.createElement('span', { onClick: function () { if (!isSelf && uiWorkspaceSvc) uiWorkspaceSvc.openSession(b.session) }, style: { color: isSelf ? C.text2 : C.brand, cursor: isSelf ? 'default' : 'pointer', textDecoration: isSelf ? 'none' : 'underline', minWidth: 90 } }, (isSelf ? '★ ' : '') + shortId(b.session)),
            React.createElement('span', { style: { color: C.text2 } }, workModeNames[b.teamMode ? 'team' : (b.boardMode === 'auto' ? 'auto' : 'list')]),
            React.createElement('span', { style: { display: 'inline-flex', gap: 5 } },
              b.counts.inProgress ? React.createElement('span', { style: { color: C.brand } }, '▶' + b.counts.inProgress) : null,
              b.counts.verifying ? React.createElement('span', { style: { color: C.warn } }, '验' + b.counts.verifying) : null,
              b.counts.pending ? React.createElement('span', { style: { color: C.text } }, '待' + b.counts.pending) : null,
              b.counts.blocked ? React.createElement('span', { style: { color: C.err } }, '🛑' + b.counts.blocked) : null,
              !(b.counts.inProgress || b.counts.verifying || b.counts.pending || b.counts.blocked) ? React.createElement('span', { style: { color: C.text2 } }, '空闲') : null),
            b.activeTitles.length ? React.createElement('span', { style: { color: C.text2, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: b.activeTitles.join('；') }, b.activeTitles.join('；')) : null,
            b.lastActivity ? React.createElement('span', { style: { color: C.text2 } }, ago(b.lastActivity)) : null)
        })) : null)
    }

    function buildReport() {
      var lines = ['# 任务看板报告', '', '生成时间: ' + new Date().toLocaleString(), '工作模式: ' + (workModeNames[state.workMode || (state.teamMode ? 'team' : (state.boardMode === 'auto' ? 'auto' : 'list'))] || '自动派发'), '', '统计范围: ' + rangeLabel()]
      var groups = { inProgress: [], verifying: [], pending: [], blocked: [], resolved: [] }
      var rg = activeRange()
      state.tasks.forEach(function (t) {
        if (t.status === 'archived') return
        if ((rg.from || rg.to) && !tsInRange(taskLastTs(t), rg.from, rg.to)) return
        var g = groups[t.status]; if (g) g.push(t)
      })
      if (groups.inProgress.length) { lines.push('## 进行中'); groups.inProgress.forEach(function (t) { lines.push('- ' + t.title + '（' + (t.claimedBy ? shortId(t.claimedBy) : '-') + '）') }); lines.push('') }
      if (groups.verifying.length) { lines.push('## 验证中'); groups.verifying.forEach(function (t) { lines.push('- ' + t.title) }); lines.push('') }
      if (groups.pending.length) { lines.push('## 待办'); groups.pending.forEach(function (t) { lines.push('- ' + t.title + ((t.retryCount || 0) + (t.rejectCount || 0) > 0 ? '（⟳' + ((t.retryCount || 0) + (t.rejectCount || 0)) + '）' : '')) }); lines.push('') }
      if (groups.blocked.length) { lines.push('## 阻塞'); groups.blocked.forEach(function (t) { lines.push('- ' + t.title + (t.escalation ? '（待裁决）' : '')) }); lines.push('') }
      var doneAll = state.archived.length ? state.archived : state.tasks.filter(function (t) { return t.status === 'resolved' }); var done = doneAll.filter(function (t) { return !(rg.from || rg.to) || tsInRange(taskLastTs(t), rg.from, rg.to) })
      if (done.length) { lines.push('## 已完成（含归档，近 ' + Math.min(done.length, 20) + ' 条）'); done.slice(0, 20).forEach(function (t) { lines.push('- ' + t.title + (t.verification ? '｜验收: ' + t.verification.verdict : '') + (t.deliverable && t.deliverable.summary ? '｜' + t.deliverable.summary.slice(0, 80) : '')) }); lines.push('') }
      return lines.join('\n')
    }

    function ReportButton() {
      var _R = React; var useState = _R.useState
      var _a = useState(''), msg = _a[0], setMsg = _a[1]
      function gen() {
        var md = buildReport()
        try { navigator.clipboard.writeText(md).then(function () { setMsg('✅ 已复制到剪贴板'); setTimeout(function () { setMsg('') }, 2500) }, function () { download(md) }) } catch (_) { download(md) }
        function download(text) {
          try { var blob = new Blob([text], { type: 'text/markdown' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'board-report.md'; a.click(); setMsg('✅ 已下载 board-report.md'); setTimeout(function () { setMsg('') }, 2500) } catch (_) { setMsg('⚠️ 导出失败') }
        }
      }
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, React.createElement('button', { onClick: gen, title: '生成本看板 markdown 报告并复制', style: { fontSize: 11, padding: '3px 10px', border: '1px solid ' + C.border, borderRadius: 5, background: C.card, color: C.text, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 } }, ic('file-down', 12), '生成报告'), msg ? React.createElement('span', { style: { fontSize: 10, color: C.ok } }, msg) : null)
    }

    // ===== Token 消耗区（数据源：host 端 get-tasks 的 usageSummary）=====
    // usageSummary 由 host 从各任务 t.usage 现算（t.usage 来自 Worker/Verifier 会话 v4 日志的
    // assistant/message.usage 聚合）。这里只做展示、不做计费断言；日志读不到/还没有 run 结算时
    // usageSummary.total 为 0，一律显示「暂无数据」。
    // 日账（usageSummary.byDay：{'YYYY-MM-DD': {t,e}}）用于「今日」大数字与「近 7 天」条形。
    // 双指标口径：t = 总量（含缓存读）、e = 有效消耗（输入+输出+缓存写，不含缓存读）。
    // e === null 表示该日只有老形态 number 日账 / 存量兜底（没有逐 run 拆分，有效值不可知）——
    // 展示时退化为 t 并在文案/title 上标 ~ 近似，绝不把总量冒充有效值。
    // dayKey 口径与 host 记账完全一致——本地 getters 拼，绝不用 toISOString()（UTC 会让
    // 晚上 8 点后的消耗落到次日，今日消耗直接错位）。
    function localDayKey(d) {
      var x = d || new Date()
      function p2(n) { return (n < 10 ? '0' : '') + n }
      return x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate())
    }
    // 近 n 天的本地日 key 序列（旧 → 新，最后一个是今天）；本地日期构造天然跨月/跨年正确
    function lastNDays(n) {
      var out = []
      var now = new Date()
      for (var i = n - 1; i >= 0; i--) out.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
      return out
    }
    function fmtTokens(n) {
      var v = Number(n) || 0
      if (v >= 1000000000) return (v / 1000000000).toFixed(1) + 'B'
      if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1) + 'M'
      if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k'
      return String(v)
    }
    // 一行「标签 + 条形 + 数值」：模型分布与任务 Top 同款（在仪表盘里局部渲染，不改动通用 BarRow）
    function UsageRow(props) {
      var pct = props.max > 0 ? Math.max(2, Math.round(props.value / props.max * 100)) : 0
      var clickable = !!props.onClick
      return React.createElement('div', { onClick: props.onClick, title: props.title, style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, cursor: clickable ? 'pointer' : 'default' } },
        React.createElement('span', { style: { width: 110, fontSize: 10, color: props.labelColor || C.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 } }, props.label),
        React.createElement('div', { style: { flex: 1, height: 8, background: C.nested, borderRadius: 4, overflow: 'hidden' } },
          React.createElement('div', { style: { height: '100%', width: pct + '%', background: props.color || C.brand, borderRadius: 4, transition: 'width .3s' } })),
        React.createElement('span', { style: { width: 54, fontSize: 10, color: C.text2, textAlign: 'right', flexShrink: 0 } }, fmtTokens(props.value)))
    }
    function TokenUsage(props) {
      var u = props.usage
      var box = { padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, marginBottom: 12 }
      var head = React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 } }, ic('bar-chart-3', 11), 'Token 消耗')
      if (!u || !u.total) return React.createElement('div', { style: box }, head, React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无数据（Worker/Verifier 会话日志里还没有 usage 记录）'))
      var models = Object.keys(u.byModel || {}).map(function (m) { return { model: m, total: u.byModel[m] || 0 } }).sort(function (a, b) { return b.total - a.total })
      var maxM = models.length ? (models[0].total || 1) : 1
      var top = u.topTasks || []
      var maxT = top.length ? (top[0].total || 1) : 1
      // 日账：今日数字取本地日 key，没有日账（byDay 缺字段/老 host）时退化为 0，不炸也不误报。
      // 读侧兼容两种单元形态：老 number（只有总量，有效值不可知）→ { t: n, e: null }。
      var byDay = (u.byDay && typeof u.byDay === 'object') ? u.byDay : {}
      function dayOf(v) {
        if (v && typeof v === 'object') return { t: Number(v.t) || 0, e: (v.e === 0 || v.e) ? Number(v.e) || 0 : null }
        return { t: Number(v) || 0, e: null }
      }
      var todayKey = localDayKey()
      var todayCell = dayOf(byDay[todayKey])
      // 有效消耗缺失（老日账/存量兜底）→ 大数字退化为总量并打 approx 标 ~，口径不伪造
      var todayApprox = todayCell.e === null
      var todayEff = todayApprox ? todayCell.t : todayCell.e
      var days = lastNDays(7)
      var maxDay = 1
      var hasDayData = false
      for (var di = 0; di < days.length; di++) { var dc = dayOf(byDay[days[di]]); var dv = (dc.e === null ? dc.t : dc.e); if (dv > maxDay) maxDay = dv; if (dc.t > 0 || dc.e > 0) hasDayData = true }
      function mini(label, value) { return React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, label + ' ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(value))) }
      // 累计三分量：有效（真实成本）+ 缓存读（占了 total 的大头，必须单列才看得出虚高来源）+ 合计
      var effTotal = (typeof u.effective === 'number') ? u.effective : ((u.input || 0) + (u.output || 0) + (u.cacheWrite || 0))
      return React.createElement('div', { style: box },
        head,
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 } },
          React.createElement('span', { style: { fontSize: 20, fontWeight: 700, color: C.brand }, title: '今日有效消耗（本地日 ' + todayKey + '）= 输入+输出+缓存写，不含缓存读；一次 run 的消耗整笔记在结算日' + (todayApprox ? '。本条日账来自老形态/存量兜底数据，有效值不可知，此处以总量近似（标 ~）' : '') }, (todayApprox ? '~' : '') + fmtTokens(todayEff)),
          React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, 'tokens（今日有效' + (todayApprox ? ' · 近似' : '') + '）'),
          todayCell.t > todayEff ? React.createElement('span', { style: { fontSize: 10, color: C.text2 }, title: '今日总量（含缓存读）——与有效消耗的差额就是缓存读' }, '含缓存读共 ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(todayCell.t))) : null,
          React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, '累计（本看板） 有效 ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(effTotal)), ' · 缓存读 ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(u.cacheRead)), ' · 合计 ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(u.total))),
          mini('输入', u.input), mini('输出', u.output), u.cacheWrite ? mini('缓存写', u.cacheWrite) : null),
        // 近 7 天迷你条形：高按区间 max 归一（今天高亮 brand，其余浅底 + 边框），
        // 柱高一律取**有效消耗**；e 不可知的日退化为总量（title 标 ~ 近似）。
        // 7 天全为 0 时整块不渲染（零残留，不占版面）
        hasDayData ? React.createElement('div', { style: { marginBottom: 8 } },
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 4 } }, '近 7 天（有效消耗）'),
          React.createElement('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 4 } },
            days.map(function (k) {
              var c = dayOf(byDay[k])
              var approx = c.e === null
              var v = approx ? c.t : c.e
              var isToday = k === todayKey
              var h = v > 0 ? Math.max(3, Math.round(v / maxDay * 32)) : 3
              return React.createElement('div', { key: k, title: k.slice(5) + '：有效 ' + String(v) + (approx ? '（近似：老日账只有总量）' : '') + ' tok' + (c.t > v ? ' / 含缓存读共 ' + String(c.t) + ' tok' : ''), style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 } },
                React.createElement('div', { style: { width: '100%', height: h, background: isToday ? C.brand : C.nested, border: '1px solid ' + (isToday ? C.brand : C.border), borderRadius: 2 } }),
                React.createElement('span', { style: { fontSize: 8, color: isToday ? C.brand : C.text2, whiteSpace: 'nowrap' } }, k.slice(5)))
            }))) : null,
        React.createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          React.createElement('div', { style: { flex: '1 1 240px', minWidth: 200 } },
            React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 4 } }, '按模型分布'),
            models.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无数据') : models.map(function (m) {
              return React.createElement(UsageRow, { key: m.model, label: m.model, value: m.total, max: maxM, color: C.brand, title: m.model + '：' + String(m.total) + ' tokens' })
            })),
          React.createElement('div', { style: { flex: '1 1 240px', minWidth: 200 } },
            React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 4 } }, '任务消耗 Top 8'),
            top.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无数据') : top.map(function (x) {
              var t = getTask(x.id)
              return React.createElement(UsageRow, { key: x.id, label: x.title || x.id, value: x.total, max: maxT, color: C.ok, labelColor: t ? C.brand : C.text2, title: x.title + '（合计 ' + String(x.total) + ' tokens · 有效 ' + String((typeof x.effective === 'number') ? x.effective : (x.total - (x.cacheRead || 0))) + ' / 缓存读 ' + String(x.cacheRead || 0) + ' · ' + (x.runs || 0) + ' 次 run）' + (t ? '——点击查看详情' : ''), onClick: t ? function () { state.detailId = x.id; notify() } : undefined })
            }))),
        // 口径边界：本区只统计看板派发的 Worker/Verifier run，主窗口对话自身不越界纳入
        React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 6, lineHeight: 1.5 } }, '口径：仅看板派发的 Worker/Verifier run 消耗，不含主窗口对话；大数字与「近 7 天」为有效消耗（输入+输出+缓存写，不含缓存读），缓存读单列'))
    }

    // ===== 架构健康提示区（架构自省 L1 · 数据源：state.healthHints）=====
    // healthHints 由 host lib/health.mjs 的 computeHealthHints(tasks) 每次请求现算（纯函数零存储零 IO）：
    //   [{ level: 'warn'|'info', text }]。kernel fetchTasks 已将其与 tasks 同源透传进 state.healthHints，
    //   本组件不再自持 rpc('get-tasks')（消灭仪表盘打开期间的 3s 双轮询），随面板 notify 重渲染同步刷新。
    //   缺省兼容：老 host 无此字段 / 非数组 / 空数组 → 返回 null，整块不渲染（零残留）。无按钮无状态。
    function HealthHints() {
      var hints = (Array.isArray(state.healthHints) ? state.healthHints : []).filter(function (h) { return h && h.text })
      if (!hints.length) return null
      // 两级配色：warn=⚠️ 琥珀（C.warn）；info=ℹ️ 蓝灰（DSH 现有 business 信息色——色板无独立 info 档）
      var infoColor = 'var(--dsw-alias-state-business-primary)'
      return React.createElement('div', { style: { padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, marginBottom: 12 } },
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 } }, ic('activity', 11), '架构健康'),
        hints.map(function (h, i) {
          var warn = h.level === 'warn'
          var col = warn ? C.warn : infoColor
          return React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 10, lineHeight: 1.5, color: col, marginBottom: 3 } },
            React.createElement('span', { style: { flexShrink: 0 } }, warn ? '⚠️' : 'ℹ️'),
            React.createElement('span', null, String(h.text)))
        }))
    }

    function Dashboard() {
      var stats = computeStats(state.tasks); var statusOrder = ['pending', 'in-progress', 'verifying', 'resolved', 'blocked', 'archived']; var prioOrder = ['critical', 'high', 'medium', 'low']
      return React.createElement('div', null,
        React.createElement(RangeFilter),
        React.createElement(GlobalBoards),
        React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' } }, React.createElement(StatCard, { label: '总任务', value: stats.total, color: C.text }), React.createElement(StatCard, { label: '待办', value: stats.byStatus['pending'] || 0, color: C.text2 }), React.createElement(StatCard, { label: '进行中', value: stats.byStatus['in-progress'] || 0, color: C.brand }), React.createElement(StatCard, { label: '验证中', value: stats.byStatus['verifying'] || 0, color: C.warn }), React.createElement(StatCard, { label: '已完成', value: stats.byStatus['resolved'] || 0, color: C.ok }), React.createElement(StatCard, { label: '已归档', value: stats.byStatus['archived'] || 0, color: C.text2 })),
        React.createElement(HealthHints),
        React.createElement(TokenUsage, { usage: state.usageSummary }),
        React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
          React.createElement('div', { style: { flex: '1 1 0', minWidth: 200, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, '按状态分布'), statusOrder.map(function (s) { return React.createElement(BarRow, { key: s, label: statusLabels[s] || s, count: stats.byStatus[s] || 0, total: stats.total, color: statusColors[s] || C.brand }) })),
          React.createElement('div', { style: { flex: '1 1 0', minWidth: 200, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, '按优先级分布'), prioOrder.map(function (p) { return React.createElement(BarRow, { key: p, label: prioLabel[p] || p, count: stats.byPriority[p] || 0, total: stats.total, color: prioColor[p] || C.brand }) }))),
        React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' } }, React.createElement(StatCardDual, { label1: '平均排队', value1: stats.avgQueue, label2: '平均执行', value2: stats.avgExec, title: '耗时口径三分离：⏳ 排队 = 创建 → 被领取（等了多久）；⏱ 执行 = 被领取 → 完成（干了多久）；均不含验收时长' }), React.createElement(StatCard, { label: '平均验证时间', value: stats.avgVerify }), React.createElement(StatCard, { label: '今日完成', value: stats.todayDone, color: C.ok })),
        React.createElement(ResearchRoiRow, { roi: stats.roi }),
        React.createElement(TrendChart, { data: stats.dailyDone }),
        Object.keys(stats.byAgent).length > 0 ? React.createElement('div', { style: { padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, marginBottom: 12 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, 'Agent 负载（进行中+验证中）'), Object.keys(stats.byAgent).map(function (aid) { return React.createElement('div', { key: aid, style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11 } }, React.createElement(ActorLink, { id: aid }), React.createElement('span', { style: { color: C.text2 } }, stats.byAgent[aid] + ' 个任务')) })) : null,
        React.createElement('div', { style: { padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, '最近活跃'), stats.recentActivity.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无记录') : stats.recentActivity.map(function (a, i) { return React.createElement('div', { key: i, style: { fontSize: 10, color: C.text2, marginBottom: 3, display: 'flex', gap: 4, alignItems: 'center' } }, React.createElement('span', { style: { color: statusColors[a.to] || C.brand, fontWeight: 600 } }, statusLabels[a.to] || a.to), React.createElement('span', { style: { color: C.text, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.title), React.createElement(ActorLink, { id: a.actor }), React.createElement('span', null, ago(a.timestamp))) })))
    }

    // 工作模式选择器（v75）：boardMode/teamMode 双开关收敛为一维三档，点击走 set-work-mode 单入口。
    // 老 RPC（set-board-mode/set-team-mode）在服务端保留兼容，UI 不再使用。
    function WorkModeSwitch(props) {
      var cur = props.mode || 'auto'
      function pick(m) { if (m === cur) return; rpc('set-work-mode', { mode: m }).then(fetchTasks).catch(function () {}) }
      // 档位文案：名称 + 一句说明（说明常驻显示在按钮内，选中态高亮不可用 title 才看得到）
      var opts = [
        { k: 'list', name: '清单模式', desc: '看板当 TODO 列表', icon: 'clipboard-list' },
        { k: 'auto', name: '自动派发', desc: '即建即派给 Worker', icon: 'zap' },
        { k: 'team', name: 'Team 托管', desc: '草稿起步，主窗口裁决', icon: 'users' }
      ]
      var btnBase = { border: 'none', cursor: 'pointer', fontWeight: 500, textAlign: 'center', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1, padding: '3px 9px', transition: 'all .15s', lineHeight: 1.25 }
      return React.createElement('div', { title: '工作模式（清单 / 自动派发 / Team 托管）——歧义裁决、Verifier 验收、touches 排他在三档下全部生效', style: { display: 'inline-flex', borderRadius: 8, border: '1px solid ' + C.border, overflow: 'hidden', background: C.card } }, opts.map(function (o) {
        var on = cur === o.k
        return React.createElement('button', {
          key: o.k, onClick: function () { pick(o.k) }, title: o.name + '：' + o.desc,
          style: Object.assign({}, btnBase, on ? { background: C.brand, color: C_INV } : { background: 'transparent', color: C.text2 })
        },
          React.createElement('span', { style: { fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3 } }, ic(o.icon, 11), o.name),
          React.createElement('span', { style: { fontSize: 9, opacity: on ? 0.85 : 0.7, whiteSpace: 'nowrap' } }, o.desc))
      }))
    }

    function PoolCfg(props) { var _R = React; var useState = _R.useState, useEffect = _R.useEffect; var _a = useState(String(props.value)), val = _a[0], setVal = _a[1]; var _b = useState(false), dirty = _b[0], setDirty = _b[1]; useEffect(function () { setVal(String(props.value)); setDirty(false) }, [props.value]); function commit(v) { var n = parseInt(v, 10); if (!isNaN(n) && n >= 0 && n <= 10) { setVal(String(n)); setDirty(false); rpc('set-board-config', { key: props.cfgKey, value: n }).then(fetchTasks).catch(function () {}) } } function step(d) { var n = parseInt(val, 10) || 0; commit(String(Math.max(0, Math.min(10, n + d)))) } var miniBtn = { fontSize: 9, padding: '0px 4px', border: '1px solid ' + C.border2, borderRadius: 2, background: C.nested, color: C.text2, cursor: 'pointer', lineHeight: '14px' }; return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 1, fontSize: 9, color: C.text2 } }, props.label, React.createElement('button', { onClick: function () { step(-1) }, title: '减 1', style: miniBtn }, '−'), React.createElement('input', { value: val, onChange: function (e) { setVal(e.target.value); setDirty(e.target.value !== String(props.value)) }, onBlur: function () { if (dirty) commit(val) }, onKeyDown: function (e) { if (e.key === 'Enter') commit(val) }, style: { width: 22, padding: '0px 2px', fontSize: 9, textAlign: 'center', border: '1px solid ' + (dirty ? C.brand : C.border2), borderRadius: 2, background: C.card, color: C.text } }), React.createElement('button', { onClick: function () { step(1) }, title: '加 1', style: miniBtn }, '＋'), dirty ? React.createElement('button', { onClick: function () { commit(val) }, title: '应用', style: { fontSize: 9, padding: '0px 5px', border: 'none', borderRadius: 2, background: C.brand, color: C_INV, cursor: 'pointer', lineHeight: '14px', fontWeight: 600, display: 'inline-flex', alignItems: 'center' } }, ic('check', 9)) : null) }
    function MinCfg(props) {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(String(props.value)), val = _a[0], setVal = _a[1]
      var _b = useState(false), dirty = _b[0], setDirty = _b[1]
      useEffect(function () { setVal(String(props.value)); setDirty(false) }, [props.value])
      function commit(v) {
        var n = parseInt(v, 10)
        if (isNaN(n) || n < props.min || n > props.max) { setVal(String(props.value)); setDirty(false); return }
        setVal(String(n)); setDirty(false); rpc('set-board-config', { key: props.cfgKey, value: n }).then(fetchTasks).catch(function () {})
      }
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, color: C.text2 } },
        props.label,
        React.createElement('input', {
          value: val, title: props.tip || (props.min + ' ~ ' + props.max + ' 分钟'),
          onChange: function (e) { setVal(e.target.value); setDirty(e.target.value !== String(props.value)) },
          onBlur: function () { if (dirty) commit(val) },
          onKeyDown: function (e) { if (e.key === 'Enter') commit(val) },
          style: { width: 38, padding: '0px 3px', fontSize: 9, textAlign: 'center', border: '1px solid ' + (dirty ? C.brand : C.border2), borderRadius: 2, background: C.card, color: C.text }
        }),
        React.createElement('span', { style: { fontSize: 9, color: C.text2 } }, '分'),
        dirty ? React.createElement('button', { onClick: function () { commit(val) }, title: '应用', style: { fontSize: 9, padding: '0px 5px', border: 'none', borderRadius: 2, background: C.brand, color: C_INV, cursor: 'pointer', lineHeight: '14px', fontWeight: 600, display: 'inline-flex', alignItems: 'center' } }, ic('check', 9)) : null)
    }

    function PoolStatus() {
      var ps = state.poolStatus
      if (!ps) return null
      var wActive = (ps.workers || []).filter(function (w) { return w.busy }).length
      var wTotal = (ps.workers || []).length
      var vActive = (ps.verifiers || []).filter(function (v) { return v.busy }).length
      var vTotal = (ps.verifiers || []).length
      return React.createElement('span', { style: { fontSize: 9, color: C.text2, display: 'inline-flex', gap: 4, alignItems: 'center' } },
        // 池水位 title 标注（反馈 n-mut9rzoq3flu）：裸数字新用户看不懂，⚡=Worker 在跑/上限，✓=Verifier 在跑/上限
        React.createElement('span', { title: 'Worker 在跑/上限', style: { display: 'inline-flex', alignItems: 'center', gap: 2 } }, ic('zap', 10), wActive + '/' + wTotal),
        React.createElement('span', { title: 'Verifier 在跑/上限', style: { display: 'inline-flex', alignItems: 'center', gap: 2 } }, ic('check', 10), vActive + '/' + vTotal))
    }

    // #11 头部减负：池配置收纳进 ⚙️ 弹出层（含 #17 verifier 异构模型设置）
    function ModelCfg(props) {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(props.value || ''), val = _a[0], setVal = _a[1]
      var _b = useState(false), dirty = _b[0], setDirty = _b[1]
      var _m = useState(null), models = _m[0], setModels = _m[1]
      var cfgKey = props.cfgKey || 'verifierModel'
      var label = props.label || 'V模型'
      // 下拉列出当前网关可用模型（host list-models RPC）；枚举失败降级为文本输入
      useEffect(function () {
        var cancelled = false
        rpc('list-models').then(function (r) { if (!cancelled && r && r.ok && Array.isArray(r.models) && r.models.length) setModels(r.models) }).catch(function () {})
        return function () { cancelled = true }
      }, [])
      useEffect(function () { setVal(props.value || ''); setDirty(false) }, [props.value])
      function save() { setDirty(false); rpc('set-board-config', { key: cfgKey, value: (val || '').trim() }).then(fetchTasks).catch(function () {}) }
      function pick(v) { setVal(v); setDirty(false); rpc('set-board-config', { key: cfgKey, value: v }).then(fetchTasks).catch(function () {}) }
      if (models) {
        return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, color: C.text2 } }, label,
          React.createElement('select', { value: val, onChange: function (e) { pick(e.target.value) }, title: label + '（空=继承父级）', style: { width: 150, padding: '0px 4px', fontSize: 9, border: '1px solid ' + C.border, borderRadius: 2, background: C.card, color: C.text } },
            React.createElement('option', { value: '' }, '继承父级'),
            models.map(function (m) { return React.createElement('option', { key: m.id, value: m.id }, m.name + ' (' + m.provider + ')') })))
      }
      // 降级：文本输入（模型枚举不可用时）
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, color: C.text2 } }, label,
        React.createElement('input', { value: val, onChange: function (e) { setVal(e.target.value); setDirty(e.target.value !== (props.value || '')) }, onBlur: function () { if (dirty) save() }, onKeyDown: function (e) { if (e.key === 'Enter') save() }, placeholder: '空=同父级', style: { width: 110, padding: '0px 4px', fontSize: 9, border: '1px solid ' + (dirty ? C.brand : C.border2), borderRadius: 2, background: C.card, color: C.text } }),
        dirty ? React.createElement('button', { onClick: save, title: '应用', style: { fontSize: 9, padding: '0px 5px', border: 'none', borderRadius: 2, background: C.brand, color: C_INV, cursor: 'pointer', lineHeight: '14px', fontWeight: 600, display: 'inline-flex', alignItems: 'center' } }, ic('check', 9)) : null)
    }

    function PoolCfgPopover(props) {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect, useRef = _R.useRef
      var _a = useState(false), open = _a[0], setOpen = _a[1]
      var _p = useState(null), pos = _p[0], setPos = _p[1]
      var ref = useRef(null); var btnRef = useRef(null)
      useEffect(function () { if (!open) return; function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }; document.addEventListener('mousedown', onDown); return function () { document.removeEventListener('mousedown', onDown) } }, [open])
      function toggle() {
        // position:fixed + 视口坐标：面板容器是 overflow:hidden + maxHeight:60vh，
        // absolute 弹窗在面板内容短时会被裁掉下半截（超时配置行曾被整个裁掉）。
        // fixed 脱离任何祖先裁剪（面板无 transform/filter，不会形成包含块）。
        if (!open && btnRef.current) { var r = btnRef.current.getBoundingClientRect(); setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }) }
        setOpen(!open)
      }
      return React.createElement('span', { ref: ref, style: { position: 'relative', display: 'inline-flex' } },
        React.createElement('button', { ref: btnRef, onClick: toggle, title: '池配置', style: { fontSize: 12, padding: '3px 8px', border: '1px solid ' + (open ? C.brand : C.border), borderRadius: 6, cursor: 'pointer', background: open ? C.nested : 'transparent', color: C.text2, display: 'inline-flex', alignItems: 'center' } }, ic('settings', 13)),
        open && pos ? React.createElement('div', { style: { position: 'fixed', top: pos.top + 'px', right: pos.right + 'px', padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', zIndex: 1000, whiteSpace: 'nowrap', maxHeight: 'calc(100vh - ' + (pos.top + 12) + 'px)', overflowY: 'auto' } },
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 5 } }, '并发上限（一次性派发，用完即销毁）'),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 } },
            React.createElement(PoolCfg, { label: 'W并发', cfgKey: 'maxWorkers', value: props.maxW }),
            React.createElement(PoolCfg, { label: 'V并发', cfgKey: 'maxVerifiers', value: props.maxV })),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 } },
            React.createElement(ModelCfg, { label: 'W模型', cfgKey: 'workerModel', value: props.workerModel }),
            React.createElement('span', { style: { fontSize: 9, color: C.text2 } }, '（Worker 执行模型）')),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            React.createElement(ModelCfg, { label: 'V模型', cfgKey: 'verifierModel', value: props.verifierModel }),
            React.createElement('span', { style: { fontSize: 9, color: C.text2 } }, '（Verifier 异构审查）')),
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, margin: '7px 0 5px' } }, '两级超时（软超时只提醒主窗口，由你决定继续等待或终止）'),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            React.createElement(MinCfg, { label: '软超时', cfgKey: 'softTimeoutMin', value: props.softT, min: 1, max: 480, tip: '超过后在看板提醒主窗口，不终止 run（1~480 分钟）' }),
            React.createElement(MinCfg, { label: '硬超时', cfgKey: 'hardTimeoutMin', value: props.hardT, min: 1, max: 1440, tip: '兜底：人不在线时自动终止挂死 run 并重试（1~1440 分钟）' })),
          // 学习飞轮 v1 总开关：关掉后不生成候选教训、prompt 不提软召回、详情页不渲染「沉淀」按钮
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, margin: '7px 0 5px' } }, '学习反馈'),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text, cursor: 'pointer', whiteSpace: 'normal', maxWidth: 260 } },
            React.createElement('input', { type: 'checkbox', checked: !!props.feedbackEnabled, onChange: function (e) { rpc('set-board-config', { key: 'feedbackEnabled', value: e.target.checked }).then(fetchTasks).catch(function () {}) } }),
            React.createElement('span', null, '候选教训（Verifier 驳回/仲裁结论自动生成候选，Worker prompt 提示先检索历史教训）')),
          // 回执开关（用户要求「回执可以做一个开关，放到设置里」）：派发/完成两类回执各自可关，缺省都开。
          // 只影响回执播报，不影响派发与状态机；歧义裁决通知不在此闸门内（见下行说明文案）。
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, margin: '7px 0 5px' } }, '通知'),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text, cursor: 'pointer', whiteSpace: 'normal', maxWidth: 260 } },
            React.createElement('input', { type: 'checkbox', checked: props.notifyDispatch !== false, onChange: function (e) { rpc('set-board-config', { key: 'notifyDispatch', value: e.target.checked }).then(fetchTasks).catch(function () {}) } }),
            React.createElement('span', null, '⚡ 派发回执（任务被 Worker/Verifier 领走时播报）')),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text, cursor: 'pointer', whiteSpace: 'normal', maxWidth: 260, marginTop: 3 } },
            React.createElement('input', { type: 'checkbox', checked: props.notifyDone !== false, onChange: function (e) { rpc('set-board-config', { key: 'notifyDone', value: e.target.checked }).then(fetchTasks).catch(function () {}) } }),
            React.createElement('span', null, '✅ 完成回执（任务完成或阻塞时聚合播报）')),
          React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 3, whiteSpace: 'normal', maxWidth: 260 } }, '歧义裁决通知不受这两个开关影响（任务等人裁决必须提醒）'),
          // 史诗拆分总开关（板级 epicSplit，缺省 true）：**只关引导，不禁机制**——关掉后 Team 提示词不再
          // 注入「大任务必须拆分」第 6 条、create-task 响应不再附 suggestSplit 软提示；显式传 parentId 建
          // 子卡、史诗自动收口/hooks 状态机照常（用户/主窗口明确要拆时不受阻）。勾选态缺字段=开，与 host 同口径。
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, margin: '7px 0 5px' } }, '功能'),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text, cursor: 'pointer', whiteSpace: 'normal', maxWidth: 260 } },
            React.createElement('input', { type: 'checkbox', checked: props.epicSplit !== false, onChange: function (e) { rpc('set-board-config', { key: 'epicSplit', value: e.target.checked }).then(fetchTasks).catch(function () {}) } }),
            React.createElement('span', null, '🧩 史诗拆分：大任务引导拆为 epic + 子任务')),
          React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 3, whiteSpace: 'normal', maxWidth: 260 } }, '关掉只停引导：显式 parentId 建子卡与史诗自动收口照常工作')) : null)
    }

    function TeamView() {
      var ps = state.poolStatus || { workers: [], verifiers: [] }
      // v74 一次性模型：每个活跃卡片 = 一个在跑的 run（随任务结算销毁），没有常驻成员
      function memberCard(m, role) {
        var isW = role === 'worker'
        var curTask = m.taskId ? getTask(m.taskId) : null
        return React.createElement('div', { key: m.id, style: { minWidth: 170, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 8, borderTop: '3px solid ' + (isW ? C.brand : C.warn) } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 } },
            React.createElement('span', { style: { display: 'inline-flex', color: isW ? C.brand : C.warn } }, ic(isW ? 'zap' : 'clipboard-check', 13)),
            React.createElement('span', { style: { fontSize: 12, fontWeight: 700, color: C.text } }, (isW ? 'Worker' : 'Verifier') + ' · 执行中'),
            React.createElement('span', { style: { marginLeft: 'auto', fontSize: 9, padding: '1px 6px', borderRadius: 3, background: C.brand, color: C_INV } }, '忙碌')),
          m.model ? React.createElement('div', { style: { fontSize: 9, color: C.warn, marginBottom: 3 }, title: '异构模型审查' }, '🧬 ' + m.model) : null,
          curTask ? React.createElement('div', { onClick: function () { state.detailId = curTask.id; state.view = 'board'; notify() }, style: { fontSize: 10, color: C.brand, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: curTask.title }, '→ ' + curTask.title) : React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '→ ' + m.taskId),
          React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 3 }, title: '一次性子代理会话' }, '会话 ' + String(m.runId || '').slice(0, 8) + '…（用完即销毁）'))
      }
      var ws = ps.workers || [], vs = ps.verifiers || []
      var _R2 = React; var _st = _R2.useState(''), editMsg = _st[0], setEditMsg = _st[1]
      function saveTimeout(cfgKey, v, min, max) {
        var n = parseInt(v, 10)
        if (isNaN(n) || n < min || n > max) { setEditMsg('范围 ' + min + '~' + max + ' 分钟'); setTimeout(function () { setEditMsg('') }, 2500); return }
        rpc('set-board-config', { key: cfgKey, value: n }).then(function () { setEditMsg('✅ 已保存'); setTimeout(function () { setEditMsg('') }, 2000); fetchTasks() }).catch(function () { setEditMsg('⚠️ 保存失败'); setTimeout(function () { setEditMsg('') }, 2500) })
      }
      var tIn = { width: 44, padding: '1px 3px', fontSize: 10, textAlign: 'center', border: '1px solid ' + C.border, borderRadius: 3, background: C.card, color: C.text }
      return React.createElement('div', null,
        React.createElement('div', { style: { marginBottom: 10, padding: '6px 8px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 10, color: C.text2 } },
          ic('activity', 11),
          React.createElement('span', null, '超时策略:'),
          React.createElement('span', { style: { color: C.brand, fontWeight: 600 } }, '软超时'),
          React.createElement('input', { type: 'number', defaultValue: String(state.softTimeoutMin || 30), min: 1, max: 480, title: '超过该时长只提醒主窗口，不终止 run', onBlur: function (e) { saveTimeout('softTimeoutMin', e.target.value, 1, 480) }, onKeyDown: function (e) { if (e.key === 'Enter') saveTimeout('softTimeoutMin', e.target.value, 1, 480) }, style: tIn }),
          React.createElement('span', null, '分（仅提醒，由你决定继续等待或终止）'),
          React.createElement('span', { style: { margin: '0 3px', color: C.border } }, '·'),
          React.createElement('span', { style: { color: C.warn, fontWeight: 600 } }, '硬超时'),
          React.createElement('input', { type: 'number', defaultValue: String(state.hardTimeoutMin || 120), min: 1, max: 1440, title: '人不在线时兜底：自动终止挂死 run 并重试', onBlur: function (e) { saveTimeout('hardTimeoutMin', e.target.value, 1, 1440) }, onKeyDown: function (e) { if (e.key === 'Enter') saveTimeout('hardTimeoutMin', e.target.value, 1, 1440) }, style: tIn }),
          React.createElement('span', null, '分（兜底自动终止并重试）'),
          editMsg ? React.createElement('span', { style: { color: editMsg.indexOf('✅') === 0 ? C.ok : C.err, fontWeight: 600 } }, editMsg) : null),
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 } }, ic('zap', 12), 'Worker 池 (' + ws.length + ')'),
        ws.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 10 } }, '暂无 Worker（有待办任务时自动扩容）') : React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } }, ws.map(function (m) { return memberCard(m, 'worker') })),
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 } }, ic('clipboard-check', 12), 'Verifier 池 (' + vs.length + ')'),
        vs.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无 Verifier（有验证中任务时自动扩容）') : React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, vs.map(function (m) { return memberCard(m, 'verifier') })))
    }
}

module.exports = { name: 'dsh-agent-board', inject: ['slots', 'sessions', 'uiWorkspace', 'timer'], apply: apply }
return module.exports
  }
})
