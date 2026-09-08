/* global window, document, fetch, getComputedStyle, MutationObserver, ResizeObserver */
// dsh-agent-board — Browser 侧 bundle（CJS 工厂，供 dsh web 客户端 ModuleLoader 注入）。
// 由 scripts/build-pkg.cjs 从 client-v30.js 机械转换生成；不要手改本文件。
window.__ModuleLoader__.load({
  id: "dsh-agent-board",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict'
    const React = require('react')

function apply(ctx) {
    var slots = ctx.get('slots')
    if (slots === undefined) return
    var sessionsSvc = ctx.get('sessions')
    var C = { bg: 'var(--dsw-alias-bg-base)', card: 'var(--dsw-alias-bg-layer-1)', nested: 'var(--dsw-alias-bg-layer-2)', border: 'var(--dsw-alias-border-l1)', brand: 'var(--dsw-alias-brand-primary)', text: 'var(--dsw-alias-label-primary)', text2: 'var(--dsw-alias-label-secondary)', err: 'var(--dsw-alias-state-error-primary)', ok: 'var(--dsw-alias-state-success-primary)', warn: 'var(--dsw-alias-state-warn-primary)' }
    var prioColor = { critical: C.err, high: C.warn, medium: C.brand, low: C.text2 }
    var prioLabel = { critical: '紧急', high: '高', medium: '中', low: '低' }
    var statusLabels = { draft: '草稿', pending: '待办', 'in-progress': '进行中', verifying: '验证中', resolved: '已完成', blocked: '阻塞', cancelled: '已取消', archived: '已归档' }
    var statusColors = { draft: C.text2, pending: C.text2, 'in-progress': C.brand, verifying: C.warn, resolved: C.ok, blocked: C.err, archived: C.text2 }
    var COLUMNS = ['draft', 'pending', 'in-progress', 'verifying', 'resolved', 'blocked']
    var state = { sessionId: null, tasks: [], boardMode: 'auto', teamMode: false, minWorkers: 1, maxWorkers: 3, minVerifiers: 0, maxVerifiers: 2, verifierModel: '', open: false, detailId: null, children: [], dragOver: null, dragTask: null, dispatchInfo: '', view: 'board', layoutLeft: 280, layoutRight: 0, poolStatus: null, escalatedIds: [], filterQ: '', filterPrio: [], filterTag: '', selectMode: false, selected: {}, undoSnapshot: null, archSort: 'time-desc' }
    // #16 快捷键：Esc 逐级关闭（详情→看板→面板）；输入框聚焦时不劫持
    try {
      var onKey = function (e) {
        if (e.key !== 'Escape') return
        var ae = document.activeElement
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return
        if (!state.open) return
        if (state.detailId) { state.detailId = null; notify() }
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
    function fetchTasks() {
      if (!state.sessionId) return
      rpc('get-tasks').then(function (d) {
        state.tasks = (d && d.tasks) || []
        state.boardMode = (d && d.boardMode) || 'auto'
        state.teamMode = !!(d && d.teamMode)
        state.minWorkers = (d && d.minWorkers) || 1
        state.maxWorkers = (d && d.maxWorkers) || 3
        state.minVerifiers = (d && d.minVerifiers) || 0
        state.maxVerifiers = (d && d.maxVerifiers) || 2
        state.verifierModel = (d && d.verifierModel) || ''
        state.poolStatus = (d && d.poolStatus) || null
        if (d && d.dispatchInfo) { state.dispatchInfo = d.dispatchInfo }
        // escalation 一等公民：出现新的待裁决任务 → 面板自动弹开直达该任务详情
        var newEsc = state.tasks.filter(function (t) { return t.escalation && state.escalatedIds.indexOf(t.id) < 0 })
        state.escalatedIds = state.tasks.filter(function (t) { return t.escalation }).map(function (t) { return t.id })
        if (newEsc.length > 0) { state.open = true; state.view = 'board'; state.detailId = newEsc[0].id }
        notify()
      }).catch(function () {})
    }
    function fetchChildren() { if (!state.sessionId) return; rpc('list-children').then(function (d) { state.children = (d && d.children) || []; notify() }).catch(function () {}) }
    var __timer = ctx.get('timer')
    if (__timer) ctx.effect(function () { return __timer.interval(fetchTasks, 3000) })
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
    try { var ro = new ResizeObserver(function () { syncLayout() }); ro.observe(document.body); ctx.effect(function () { return function () { ro.disconnect() } }) } catch (_) {}
    try { var mo = new MutationObserver(function () { syncLayout() }); mo.observe(document.body, { attributes: true, attributeFilter: ['style'], subtree: true }); ctx.effect(function () { return function () { mo.disconnect() } }) } catch (_) {}
    syncLayout()
    function ago(iso) { if (!iso) return ''; var ms = Date.now() - new Date(iso).getTime(); if (ms < 60000) return '刚刚'; if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前'; if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前'; return Math.floor(ms / 86400000) + ' 天前' }
    function fmtTime(iso) { if (!iso) return '-'; try { return new Date(iso).toLocaleString() } catch (_) { return iso } }
    function getTask(id) { return state.tasks.find(function (t) { return t.id === id }) }
    function shortId(sid) { return sid ? String(sid).slice(0, 14) : '' }
    function jumpTo(actorId) { if (sessionsSvc && actorId && actorId !== 'system' && actorId !== 'unknown' && actorId !== 'auto-dispatch') sessionsSvc.open(actorId) }
    function transition(taskId, from, to) {
      if (from === to) return
      var ok = function () { fetchTasks() }; var fail = function () { fetchTasks() }
      if (to === 'pending' && from === 'draft') rpc('update-task', { taskId: taskId, publish: true }).then(ok).catch(fail)
      else if (to === 'in-progress' && (from === 'pending' || from === 'blocked')) rpc('claim-task', { taskId: taskId }).then(ok).catch(fail)
      else if (to === 'verifying' && from === 'in-progress') { var res = window.prompt('提交验证 — 解决说明（必填）：'); if (res) rpc('resolve-task', { taskId: taskId, status: 'verifying', resolution: res }).then(ok).catch(fail) }
      else if (to === 'resolved' && from === 'verifying') rpc('verify-task', { taskId: taskId, verdict: 'approved' }).then(ok).catch(fail)
      else if (to === 'in-progress' && from === 'verifying') { var c = window.prompt('驳回原因（可选）：'); rpc('verify-task', { taskId: taskId, verdict: 'rejected', comment: c || '' }).then(ok).catch(fail) }
      else if (to === 'blocked' && from === 'in-progress') { var r = window.prompt('阻塞原因（可选）：') || ''; rpc('resolve-task', { taskId: taskId, status: 'blocked', resolution: r }).then(ok).catch(fail) }
      else if (to === 'archived' && from === 'resolved') rpc('archive-task', { taskId: taskId }).then(ok).catch(fail)
    }
    function onDragStart(e, task) { e.dataTransfer.setData('text/plain', JSON.stringify({ id: task.id, status: task.status })); e.dataTransfer.effectAllowed = 'move'; state.dragTask = task.id; notify() }
    function onDragEnd() { state.dragTask = null; state.dragOver = null; notify() }
    function onColDragOver(e, st) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (state.dragOver !== st) { state.dragOver = st; notify() } }
    function onColDragLeave(st) { if (state.dragOver === st) { state.dragOver = null; notify() } }
    function onColDrop(e, st) { e.preventDefault(); try { var data = JSON.parse(e.dataTransfer.getData('text/plain')); state.dragOver = null; state.dragTask = null; transition(data.id, data.status, st); notify() } catch (_) {} }
    function computeStats(tasks) {
      var total = tasks.length, byStatus = {}, byPriority = {}, byAgent = {}, completionTimes = [], verifyTimes = [], todayDone = 0, todayStart = new Date(); todayStart.setHours(0, 0, 0, 0); var recentActivity = []
      var dailyDone = [] // #15 近 7 天每日完成趋势
      for (var di = 6; di >= 0; di--) { var dayStart = new Date(todayStart); dayStart.setDate(dayStart.getDate() - di); var dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1); dailyDone.push({ label: (dayStart.getMonth() + 1) + '/' + dayStart.getDate(), count: 0, start: dayStart, end: dayEnd }) }
      tasks.forEach(function (t) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; byPriority[t.priority || 'medium'] = (byPriority[t.priority || 'medium'] || 0) + 1; if (t.claimedBy && (t.status === 'in-progress' || t.status === 'verifying')) { if (!byAgent[t.claimedBy]) byAgent[t.claimedBy] = 0; byAgent[t.claimedBy]++ } if (t.resolvedAt && t.createdAt) completionTimes.push(new Date(t.resolvedAt) - new Date(t.createdAt)); if (t.verifiedAt && t.resolvedAt) verifyTimes.push(new Date(t.verifiedAt) - new Date(t.resolvedAt)); if (t.resolvedAt) { var rd = new Date(t.resolvedAt); if (rd >= todayStart) todayDone++; for (var k = 0; k < dailyDone.length; k++) { if (rd >= dailyDone[k].start && rd < dailyDone[k].end) { dailyDone[k].count++; break } } } if (Array.isArray(t.history)) t.history.forEach(function (h) { recentActivity.push({ taskId: t.id, title: t.title, from: h.from, to: h.to, actor: h.actor, timestamp: h.timestamp, note: h.note }) }) })
      recentActivity.sort(function (a, b) { return (b.timestamp || '').localeCompare(a.timestamp || '') }); recentActivity = recentActivity.slice(0, 10)
      function avgMs(arr) { if (arr.length === 0) return null; var s = arr.reduce(function (a, b) { return a + b }, 0); return Math.round(s / arr.length) }
      function fmtMs(ms) { if (!ms) return '-'; var m = Math.floor(ms / 60000); if (m < 60) return m + ' 分钟'; var h = Math.floor(m / 60); if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分'; return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 时' }
      return { total: total, byStatus: byStatus, byPriority: byPriority, byAgent: byAgent, avgCompletion: fmtMs(avgMs(completionTimes)), avgVerify: fmtMs(avgMs(verifyTimes)), todayDone: todayDone, dailyDone: dailyDone, recentActivity: recentActivity }
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
    function BarRow(props) { var pct = props.total > 0 ? (props.count / props.total * 100) : 0; return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } }, React.createElement('span', { style: { width: 40, fontSize: 10, color: C.text2, textAlign: 'right', flexShrink: 0 } }, props.label), React.createElement('div', { style: { flex: 1, height: 8, background: C.nested, borderRadius: 4, overflow: 'hidden' } }, React.createElement('div', { style: { height: '100%', width: pct + '%', background: props.color || C.brand, borderRadius: 4, transition: 'width .3s' } })), React.createElement('span', { style: { width: 24, fontSize: 10, color: C.text2, flexShrink: 0 } }, String(props.count))) }
    function Dashboard() {
      var stats = computeStats(state.tasks); var statusOrder = ['pending', 'in-progress', 'verifying', 'resolved', 'blocked', 'archived']; var prioOrder = ['critical', 'high', 'medium', 'low']
      return React.createElement('div', null,
        React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' } }, React.createElement(StatCard, { label: '总任务', value: stats.total, color: C.text }), React.createElement(StatCard, { label: '待办', value: stats.byStatus['pending'] || 0, color: C.text2 }), React.createElement(StatCard, { label: '进行中', value: stats.byStatus['in-progress'] || 0, color: C.brand }), React.createElement(StatCard, { label: '验证中', value: stats.byStatus['verifying'] || 0, color: C.warn }), React.createElement(StatCard, { label: '已完成', value: stats.byStatus['resolved'] || 0, color: C.ok }), React.createElement(StatCard, { label: '已归档', value: stats.byStatus['archived'] || 0, color: C.text2 })),
        React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
          React.createElement('div', { style: { flex: '1 1 0', minWidth: 200, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, '按状态分布'), statusOrder.map(function (s) { return React.createElement(BarRow, { key: s, label: statusLabels[s] || s, count: stats.byStatus[s] || 0, total: stats.total, color: statusColors[s] || C.brand }) })),
          React.createElement('div', { style: { flex: '1 1 0', minWidth: 200, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, '按优先级分布'), prioOrder.map(function (p) { return React.createElement(BarRow, { key: p, label: prioLabel[p] || p, count: stats.byPriority[p] || 0, total: stats.total, color: prioColor[p] || C.brand }) }))),
        React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' } }, React.createElement(StatCard, { label: '平均完成时间', value: stats.avgCompletion }), React.createElement(StatCard, { label: '平均验证时间', value: stats.avgVerify }), React.createElement(StatCard, { label: '今日完成', value: stats.todayDone, color: C.ok })),
        React.createElement(TrendChart, { data: stats.dailyDone }),
        Object.keys(stats.byAgent).length > 0 ? React.createElement('div', { style: { padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6, marginBottom: 12 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, 'Agent 负载（进行中+验证中）'), Object.keys(stats.byAgent).map(function (aid) { return React.createElement('div', { key: aid, style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11 } }, React.createElement(ActorLink, { id: aid }), React.createElement('span', { style: { color: C.text2 } }, stats.byAgent[aid] + ' 个任务')) })) : null,
        React.createElement('div', { style: { padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 6 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 } }, '最近活跃'), stats.recentActivity.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无记录') : stats.recentActivity.map(function (a, i) { return React.createElement('div', { key: i, style: { fontSize: 10, color: C.text2, marginBottom: 3, display: 'flex', gap: 4, alignItems: 'center' } }, React.createElement('span', { style: { color: statusColors[a.to] || C.brand, fontWeight: 600 } }, statusLabels[a.to] || a.to), React.createElement('span', { style: { color: C.text, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.title), React.createElement(ActorLink, { id: a.actor }), React.createElement('span', null, ago(a.timestamp))) })))
    }
    function BoardButton(props) {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(0), pendingCount = _a[0], setPendingCount = _a[1]; var _b = useState(false), isOpen = _b[0], setIsOpen = _b[1]; var _c = useState(0), escCount = _c[0], setEscCount = _c[1]
      useEffect(function () { if (props && props.sessionId) { var sid = String(props.sessionId); if (state.sessionId !== sid) { state.sessionId = sid; fetchTasks(); fetchChildren() } } }, [props && props.sessionId])
      useEffect(function () { function update() { var n = 0, e = 0; for (var i = 0; i < state.tasks.length; i++) { if (state.tasks[i].status === 'pending') n++; if (state.tasks[i].escalation) e++ }; setPendingCount(n); setEscCount(e); setIsOpen(state.open) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      return React.createElement('button', { onClick: function () { state.open = !state.open; notify() }, title: '任务看板' + (pendingCount > 0 ? '（' + pendingCount + ' 待办）' : '') + (escCount > 0 ? '（' + escCount + ' 待裁决）' : ''), style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', border: '1px solid ' + (escCount > 0 ? C.err : C.border), borderRadius: 6, background: isOpen ? C.nested : 'transparent', color: C.text, cursor: 'pointer', fontSize: 12 } }, React.createElement('span', null, '📋'), React.createElement('span', null, '看板'), escCount > 0 ? React.createElement('span', { style: { minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: C.err, color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', animation: 'tskb-pulse 1s ease-in-out infinite' }, title: escCount + ' 个任务待裁决' }, '⚠' + escCount) : null, pendingCount > 0 ? React.createElement('span', { style: { minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: C.brand, color: '#fff', fontSize: 10, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, String(pendingCount)) : null)
    }
    function ModeSwitch(props) { var mode = props.mode; function pick(m) { rpc('set-board-mode', { mode: m }).then(fetchTasks).catch(function () {}) } var btnBase = { fontSize: 12, padding: '4px 14px', border: 'none', cursor: 'pointer', fontWeight: 500, flex: 1, textAlign: 'center', borderRadius: 6, transition: 'all .15s' }; return React.createElement('div', { style: { display: 'inline-flex', borderRadius: 8, border: '1px solid ' + C.border, overflow: 'hidden', background: C.card } }, React.createElement('button', { onClick: function () { pick('auto') }, style: Object.assign({}, btnBase, mode === 'auto' ? { background: C.brand, color: '#fff' } : { background: 'transparent', color: C.text2 }) }, '🤖 自动'), React.createElement('button', { onClick: function () { pick('manual') }, style: Object.assign({}, btnBase, mode === 'manual' ? { background: C.brand, color: '#fff' } : { background: 'transparent', color: C.text2 }) }, '👤 手动')) }
    function TeamSwitch(props) { var on = props.on; function toggle() { rpc('set-team-mode', { enabled: !on }).then(fetchTasks).catch(function () {}) } return React.createElement('button', { onClick: toggle, title: on ? 'Team 模式已开启：所有任务提交看板由常驻 Agent 处理，歧义自动上报主窗口' : '开启 Team 模式：任务全走看板，Worker 歧义上报主窗口裁决', style: { fontSize: 12, padding: '4px 10px', border: '1px solid ' + (on ? C.brand : C.border), borderRadius: 8, cursor: 'pointer', fontWeight: 500, background: on ? C.brand : 'transparent', color: on ? '#fff' : C.text2, transition: 'all .15s' } }, '👥 Team' + (on ? ' ON' : '')) }
    function ViewTab() { var btnBase = { fontSize: 11, padding: '3px 10px', border: 'none', cursor: 'pointer', fontWeight: 500, borderRadius: 5, transition: 'all .15s' }; return React.createElement('div', { style: { display: 'inline-flex', borderRadius: 6, border: '1px solid ' + C.border, overflow: 'hidden', background: C.card } }, React.createElement('button', { onClick: function () { state.view = 'board'; notify() }, style: Object.assign({}, btnBase, state.view === 'board' ? { background: C.brand, color: '#fff' } : { background: 'transparent', color: C.text2 }) }, '📋 看板'), React.createElement('button', { onClick: function () { state.view = 'team'; notify() }, style: Object.assign({}, btnBase, state.view === 'team' ? { background: C.brand, color: '#fff' } : { background: 'transparent', color: C.text2 }) }, '👥 团队'), React.createElement('button', { onClick: function () { state.view = 'dashboard'; notify() }, style: Object.assign({}, btnBase, state.view === 'dashboard' ? { background: C.brand, color: '#fff' } : { background: 'transparent', color: C.text2 }) }, '📊 仪表盘')) }
    function PoolCfg(props) { var _R = React; var useState = _R.useState, useEffect = _R.useEffect; var _a = useState(String(props.value)), val = _a[0], setVal = _a[1]; var _b = useState(false), dirty = _b[0], setDirty = _b[1]; useEffect(function () { setVal(String(props.value)); setDirty(false) }, [props.value]); function commit(v) { var n = parseInt(v, 10); if (!isNaN(n) && n >= 0 && n <= 10) { setVal(String(n)); setDirty(false); rpc('set-board-config', { key: props.cfgKey, value: n }).then(fetchTasks).catch(function () {}) } } function step(d) { var n = parseInt(val, 10) || 0; commit(String(Math.max(0, Math.min(10, n + d)))) } var miniBtn = { fontSize: 9, padding: '0px 4px', border: '1px solid ' + C.border, borderRadius: 2, background: C.nested, color: C.text2, cursor: 'pointer', lineHeight: '14px' }; return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 1, fontSize: 9, color: C.text2 } }, props.label, React.createElement('button', { onClick: function () { step(-1) }, title: '减 1', style: miniBtn }, '−'), React.createElement('input', { value: val, onChange: function (e) { setVal(e.target.value); setDirty(e.target.value !== String(props.value)) }, onBlur: function () { if (dirty) commit(val) }, onKeyDown: function (e) { if (e.key === 'Enter') commit(val) }, style: { width: 22, padding: '0px 2px', fontSize: 9, textAlign: 'center', border: '1px solid ' + (dirty ? C.brand : C.border), borderRadius: 2, background: C.card, color: C.text } }), React.createElement('button', { onClick: function () { step(1) }, title: '加 1', style: miniBtn }, '＋'), dirty ? React.createElement('button', { onClick: function () { commit(val) }, title: '应用', style: { fontSize: 9, padding: '0px 5px', border: 'none', borderRadius: 2, background: C.brand, color: '#fff', cursor: 'pointer', lineHeight: '14px', fontWeight: 600 } }, '✓') : null) }
    function PoolStatus() {
      var ps = state.poolStatus
      if (!ps) return null
      var wActive = (ps.workers || []).filter(function (w) { return w.busy }).length
      var wTotal = (ps.workers || []).length
      var vActive = (ps.verifiers || []).filter(function (v) { return v.busy }).length
      var vTotal = (ps.verifiers || []).length
      return React.createElement('span', { style: { fontSize: 9, color: C.text2, display: 'inline-flex', gap: 4, alignItems: 'center' } },
        React.createElement('span', { title: 'Worker 池' }, '⚡' + wActive + '/' + wTotal),
        React.createElement('span', { title: 'Verifier 池' }, '✓' + vActive + '/' + vTotal))
    }
    // #11 头部减负：池配置收纳进 ⚙️ 弹出层（含 #17 verifier 异构模型设置）
    function ModelCfg(props) {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(props.value || ''), val = _a[0], setVal = _a[1]; var _b = useState(false), dirty = _b[0], setDirty = _b[1]
      useEffect(function () { setVal(props.value || ''); setDirty(false) }, [props.value])
      function save() { setDirty(false); rpc('set-board-config', { key: 'verifierModel', value: val.trim() }).then(fetchTasks).catch(function () {}) }
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, color: C.text2 } }, 'V模型',
        React.createElement('input', { value: val, onChange: function (e) { setVal(e.target.value); setDirty(e.target.value !== (props.value || '')) }, onBlur: function () { if (dirty) save() }, onKeyDown: function (e) { if (e.key === 'Enter') save() }, placeholder: '空=同父级', style: { width: 110, padding: '0px 4px', fontSize: 9, border: '1px solid ' + (dirty ? C.brand : C.border), borderRadius: 2, background: C.card, color: C.text } }),
        dirty ? React.createElement('button', { onClick: save, title: '应用', style: { fontSize: 9, padding: '0px 5px', border: 'none', borderRadius: 2, background: C.brand, color: '#fff', cursor: 'pointer', lineHeight: '14px', fontWeight: 600 } }, '✓') : null)
    }
    function PoolCfgPopover(props) {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect, useRef = _R.useRef
      var _a = useState(false), open = _a[0], setOpen = _a[1]
      var ref = useRef(null)
      useEffect(function () { if (!open) return; function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }; document.addEventListener('mousedown', onDown); return function () { document.removeEventListener('mousedown', onDown) } }, [open])
      return React.createElement('span', { ref: ref, style: { position: 'relative', display: 'inline-flex' } },
        React.createElement('button', { onClick: function () { setOpen(!open) }, title: '池配置', style: { fontSize: 12, padding: '3px 8px', border: '1px solid ' + (open ? C.brand : C.border), borderRadius: 6, cursor: 'pointer', background: open ? C.nested : 'transparent', color: C.text2 } }, '⚙️'),
        open ? React.createElement('div', { style: { position: 'absolute', top: '100%', right: 0, marginTop: 4, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', zIndex: 10, whiteSpace: 'nowrap' } },
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 5 } }, '池配置（最小/最大并发）'),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 } },
            React.createElement(PoolCfg, { label: 'W-', cfgKey: 'minWorkers', value: props.minW }), React.createElement(PoolCfg, { label: 'W+', cfgKey: 'maxWorkers', value: props.maxW }),
            React.createElement(PoolCfg, { label: 'V-', cfgKey: 'minVerifiers', value: props.minV }), React.createElement(PoolCfg, { label: 'V+', cfgKey: 'maxVerifiers', value: props.maxV })),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            React.createElement(ModelCfg, { value: props.verifierModel }),
            React.createElement('span', { style: { fontSize: 9, color: C.text2 } }, '（Verifier 异构审查）'))) : null)
    }
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
    var pipeMeta = { full: { icon: '🧪', label: '全流程（执行+验证）' }, work: { icon: '📝', label: '免验证（只做不验）' }, direct: { icon: '💬', label: '主窗口直接处理' } }
    function pipeOf(t) { return pipeMeta[t.pipeline] || pipeMeta.full }
    // #14 批量操作条（#16 带一步撤销：快照操作前的 priority/status）
    function BatchBar() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(0), cnt = _a[0], setCnt = _a[1]; var _b = useState(false), on = _b[0], setOn = _b[1]; var _c = useState(''), msg = _c[0], setMsg = _c[1]; var _d = useState(null), undo = _d[0], setUndo = _d[1]
      useEffect(function () { function update() { setCnt(Object.keys(state.selected).length); setOn(state.selectMode); setUndo(state.undoSnapshot) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!on) return null
      var ids = Object.keys(state.selected)
      function snapshot(op) { return { op: op, at: Date.now(), items: ids.map(function (id) { var t = getTask(id); return t ? { id: id, priority: t.priority, status: t.status } : null }).filter(Boolean) } }
      function run(op, value) { var snap = snapshot(op); var payload = { ids: ids, op: op }; if (value !== undefined) payload.value = value; rpc('batch-op', payload).then(function (r) { state.selected = {}; state.undoSnapshot = (r && r.done > 0) ? snap : null; setMsg('✅ 已处理 ' + (r && r.done || 0) + ' 个' + (r && r.skipped && r.skipped.length ? '，跳过 ' + r.skipped.length : '')); fetchTasks() }).catch(function (e) { setMsg('⚠️ ' + String(e)) }) }
      function doUndo() { if (!undo) return; rpc('batch-undo', { snapshot: undo }).then(function (r) { setMsg('↩️ 已撤销 ' + (r && r.done || 0) + ' 个'); state.undoSnapshot = null; fetchTasks() }).catch(function (e) { setMsg('⚠️ ' + String(e)) }) }
      var btn = { fontSize: 10, padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', fontWeight: 600 }
      return React.createElement('div', { style: { position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginTop: 8, background: C.nested, border: '1px solid ' + C.border, borderRadius: 6 } },
        React.createElement('span', { style: { fontSize: 11, color: C.text, fontWeight: 600 } }, '已选 ' + cnt + ' 项'),
        React.createElement('button', { onClick: function () { run('archive') }, disabled: cnt === 0, style: Object.assign({}, btn, { background: C.text2, color: '#fff' }) }, '📦 批量归档'),
        ['critical', 'high', 'medium', 'low'].map(function (p) { return React.createElement('button', { key: p, onClick: function () { run('set-priority', p) }, disabled: cnt === 0, style: Object.assign({}, btn, { background: prioColor[p], color: '#fff' }) }, prioLabel[p]) }),
        undo ? React.createElement('button', { onClick: doUndo, title: '撤销最近一次批量操作', style: Object.assign({}, btn, { background: C.brand, color: '#fff' }) }, '↩️ 撤销') : null,
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
        React.createElement('input', { value: q, onChange: function (e) { setQ2(e.target.value) }, placeholder: '🔍 搜索标题/描述/ID…', style: { flex: '0 1 200px', fontSize: 11, padding: '3px 8px', border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text } }),
        ['critical', 'high', 'medium', 'low'].map(function (p) { var on = fp.indexOf(p) >= 0; return React.createElement('button', { key: p, onClick: function () { togglePrio(p) }, style: Object.assign({}, chipBase, on ? { background: prioColor[p], color: '#fff', borderColor: prioColor[p] } : {}) }, prioLabel[p]) }),
        allTags().length > 0 ? React.createElement('select', { value: ft, onChange: function (e) { state.filterTag = e.target.value; notify() }, style: { fontSize: 10, padding: '2px 4px', border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text } }, React.createElement('option', { value: '' }, '🏷 全部标签'), allTags().map(function (g) { return React.createElement('option', { key: g, value: g }, g) })) : null,
        hasFilter ? React.createElement('button', { onClick: clearAll, style: { fontSize: 10, padding: '2px 8px', borderRadius: 10, border: 'none', background: C.nested, color: C.text2, cursor: 'pointer' } }, '✕ 清除') : null)
    }
    function Card(props) { var t = props.task; var pc = prioColor[t.priority] || prioColor.low; var dragging = state.dragTask === t.id; var preview = (t.deliverable && t.deliverable.summary) || t.resolution; var critGlow = t.priority === 'critical' && !t.escalation; var sel = !!state.selected[t.id]; var pm = pipeOf(t); var depBlock = t.status === 'pending' && depsBlocked(t); return React.createElement('div', { draggable: !state.selectMode, onDragStart: function (e) { onDragStart(e, t) }, onDragEnd: onDragEnd, onClick: function () { if (state.selectMode) { if (state.selected[t.id]) delete state.selected[t.id]; else state.selected[t.id] = true; notify() } else { state.detailId = t.id; notify() } }, style: { border: '1px solid ' + (sel ? C.brand : (t.escalation ? C.err : (critGlow ? C.err : C.border))), borderRadius: 6, padding: '6px 8px', marginBottom: 6, background: sel ? C.nested : C.card, borderLeft: '3px solid ' + (t.escalation ? C.err : pc), cursor: state.selectMode ? 'pointer' : 'grab', fontSize: 12, opacity: dragging ? 0.4 : (depBlock ? 0.65 : 1), transition: 'opacity .15s', animation: critGlow ? 'tskb-crit 2s ease-in-out infinite' : 'none' } }, React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 4 } }, state.selectMode ? React.createElement('span', { style: { fontSize: 12, color: sel ? C.brand : C.text2, flexShrink: 0, marginTop: 1 } }, sel ? '☑' : '☐') : null, React.createElement('div', { style: { fontWeight: 600, color: C.text, marginBottom: 2, wordBreak: 'break-word', flex: 1 } }, t.title), React.createElement('span', { style: { fontSize: 10, flexShrink: 0, marginTop: 1 }, title: pm.label }, pm.icon), React.createElement('span', { style: { fontSize: 9, padding: '1px 5px', borderRadius: 3, background: pc, color: '#fff', flexShrink: 0, marginTop: 1 } }, prioLabel[t.priority] || '中')), t.escalation ? React.createElement('div', { style: { fontSize: 10, color: C.err, fontWeight: 600, marginBottom: 2 } }, '⚠️ 待裁决 — 点击查看疑问') : null, depBlock ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 2 } }, '⛓ 被 ' + t.dependsOn.filter(function (id) { var d = getTask(id); return !d || (d.status !== 'resolved' && d.status !== 'archived') }).length + ' 个依赖阻塞') : null, t.stuckSince ? React.createElement('div', { style: { fontSize: 10, color: C.warn, fontWeight: 600, marginBottom: 2, animation: 'tskb-pulse 1.5s ease-in-out infinite' } }, '⏱ 疑似卡死 · ' + ago(t.stuckSince) + ' — 点击处理') : null, React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, t.status === 'in-progress' && t.claimedBy ? '⚡ ' + shortId(t.claimedBy) : '', t.assignee ? ' 👤→' + shortId(t.assignee) : '', ' ' + ago(t.createdAt)), t.status === 'verifying' && preview ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '📝 ' + preview) : null) }
    function ActorLink(props) { var id = props.id; if (!id || id === 'system' || id === 'unknown' || id === 'auto-dispatch') return React.createElement('span', { style: { color: C.text2 } }, id || '-'); return React.createElement('span', { onClick: function (e) { e.stopPropagation(); jumpTo(id) }, style: { color: C.brand, cursor: 'pointer', textDecoration: 'underline' }, title: '跳转到 ' + id }, shortId(id)) }
    function MsgThread(props) {
      var msgs = props.messages || []
      if (msgs.length === 0) return null
      var kindStyle = { escalation: { color: C.err, label: '⚠️ Worker 上报' }, arbitration: { color: C.brand, label: '⚖️ 主窗口裁决' }, intervention: { color: C.warn, label: '⚡ 高优介入' } }
      return React.createElement('div', { style: { marginBottom: 8 } },
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 3 } }, '裁决对话 (' + msgs.length + ')'),
        msgs.map(function (m, i) {
          var ks = kindStyle[m.kind] || { color: C.text2, label: m.kind }
          return React.createElement('div', { key: i, style: { marginBottom: 4, padding: '5px 8px', borderLeft: '2px solid ' + ks.color, background: C.nested, borderRadius: 4 } },
            React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: ks.color, marginBottom: 2 } }, ks.label + ' · ' + (m.by || '') + ' · ' + ago(m.at)),
            React.createElement('div', { style: { fontSize: 10, color: C.text, whiteSpace: 'pre-wrap', maxHeight: 140, overflowY: 'auto' } }, m.text))
        }))
    }
    function TeamView() {
      var ps = state.poolStatus || { workers: [], verifiers: [] }
      function memberCard(m, role) {
        var isW = role === 'worker'
        var curTask = m.taskId ? getTask(m.taskId) : null
        return React.createElement('div', { key: m.id, style: { minWidth: 170, padding: '8px 10px', background: C.card, border: '1px solid ' + C.border, borderRadius: 8, borderTop: '3px solid ' + (m.busy ? (isW ? C.brand : C.warn) : C.border) } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 } },
            React.createElement('span', { style: { fontSize: 14 } }, isW ? '⚡' : '🔍'),
            React.createElement('span', { style: { fontSize: 12, fontWeight: 700, color: C.text } }, (isW ? 'Worker' : 'Verifier') + ' #' + m.num),
            React.createElement('span', { style: { marginLeft: 'auto', fontSize: 9, padding: '1px 6px', borderRadius: 3, background: m.suspect ? C.err : (m.busy ? C.brand : C.nested), color: (m.suspect || m.busy) ? '#fff' : C.text2 } }, m.suspect ? '⏱ 卡死' : (m.busy ? '忙碌' : '空闲'))),
          m.model ? React.createElement('div', { style: { fontSize: 9, color: C.warn, marginBottom: 3 }, title: '异构模型审查' }, '🧬 ' + m.model) : null,
          React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 3 } }, '已完成 ' + (m.done || 0) + ' · 队列 ' + (m.queueLen || 0)),
          curTask ? React.createElement('div', { onClick: function () { state.detailId = curTask.id; state.view = 'board'; notify() }, style: { fontSize: 10, color: C.brand, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: curTask.title }, '→ ' + curTask.title) : React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '待命中'),
          React.createElement('div', { style: { marginTop: 4 } }, React.createElement(ActorLink, { id: m.id })))
      }
      var ws = ps.workers || [], vs = ps.verifiers || []
      return React.createElement('div', null,
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 6 } }, '⚡ Worker 池 (' + ws.length + ')'),
        ws.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 10 } }, '暂无 Worker（有待办任务时自动扩容）') : React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } }, ws.map(function (m) { return memberCard(m, 'worker') })),
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 6 } }, '🔍 Verifier 池 (' + vs.length + ')'),
        vs.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无 Verifier（有验证中任务时自动扩容）') : React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, vs.map(function (m) { return memberCard(m, 'verifier') })))
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
            React.createElement('span', { style: { padding: '0 5px', borderRadius: 3, fontSize: 9, background: satisfied ? C.ok : (statusColors[dt && dt.status] || C.text2), color: '#fff', flexShrink: 0 } }, dt ? (statusLabels[dt.status] || dt.status) : '不存在'),
            React.createElement('span', { onClick: function () { if (dt) { state.detailId = id; notify() } }, style: { color: dt ? C.brand : C.text2, cursor: dt ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, title: id }, dt ? dt.title : id),
            React.createElement('span', { onClick: function () { saveDeps(deps.filter(function (x) { return x !== id })) }, title: '移除依赖', style: { cursor: 'pointer', color: C.text2, flexShrink: 0 } }, '✕'))
        }),
        candidates.length > 0 ? React.createElement('select', { value: '', onChange: function (e) { if (e.target.value) saveDeps(deps.concat([e.target.value])) }, style: { width: '100%', fontSize: 10, padding: '2px 4px', marginTop: 2, border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text } },
          React.createElement('option', { value: '' }, '＋ 添加依赖…'),
          candidates.map(function (x) { return React.createElement('option', { key: x.id, value: x.id }, x.title.slice(0, 36) + ' (' + (statusLabels[x.status] || x.status) + ')') })) : null,
        msg ? React.createElement('div', { style: { fontSize: 10, color: C.err, marginTop: 3 } }, msg) : null)
    }
    function DetailView() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect; var task = getTask(state.detailId)
      var _a = useState(task ? task.title : ''), editTitle = _a[0], setEditTitle = _a[1]; var _b = useState(task ? task.description || '' : ''), editDesc = _b[0], setEditDesc = _b[1]; var _c = useState(false), saving = _c[0], setSaving = _c[1]; var _d = useState(state.boardMode), mode = _d[0], setMode = _d[1]
      var _e2 = useState(''), arbAnswer = _e2[0], setArbAnswer = _e2[1]; var _f2 = useState(''), interveneMsg = _f2[0], setInterveneMsg = _f2[1]; var _g2 = useState(''), actionMsg = _g2[0], setActionMsg = _g2[1]
      useEffect(function () { function update() { setMode(state.boardMode) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!task) { state.detailId = null; return React.createElement('div', { style: { padding: 20, color: C.text2 } }, '任务不存在') }
      function doAction(fn) { fn().then(fetchTasks).catch(function () {}) }
      function saveEdit() { setSaving(true); rpc('update-task', { taskId: task.id, title: editTitle, description: editDesc, resetToPending: true }).then(function () { setSaving(false); fetchTasks() }).catch(function () { setSaving(false) }) }
      function assignTo(childId) { rpc('update-task', { taskId: task.id, assignMode: 'manual', assignee: childId }).then(fetchTasks).catch(function () {}) }
      function jumpToAgent() { if (sessionsSvc && task.claimedBy) sessionsSvc.open(task.claimedBy) }
      function submitArbitration() { if (!arbAnswer.trim()) return; rpc('resolve-escalation', { taskId: task.id, answer: arbAnswer }).then(function (r) { setActionMsg(r && r.ok ? '✅ 裁决已转达给 Worker' : '⚠️ ' + ((r && r.error) || '失败')); setArbAnswer(''); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      function doTerminate() { rpc('terminate-agent', { taskId: task.id }).then(function (r) { setActionMsg(r && r.ok ? '⏹ 已终止 ' + (r.terminated || '') + '，任务重新排队' : '⚠️ ' + ((r && r.error) || '无活动 Agent')); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      function doDismiss() { rpc('dismiss-suspect', { taskId: task.id }).then(function () { setActionMsg('✅ 已清除卡死标记，继续观察'); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      function submitIntervene() { if (!interveneMsg.trim()) return; rpc('intervene-agent', { taskId: task.id, message: interveneMsg }).then(function (r) { setActionMsg(r && r.ok ? '✅ 高优指令已插入 ' + shortId(r.agent) + ' 队首' : '⚠️ ' + ((r && r.error) || '无活动 Agent')); setInterveneMsg(''); fetchTasks() }).catch(function (e) { setActionMsg('⚠️ ' + String(e)) }) }
      var isManual = task.assignMode === 'manual'; var canJump = (task.status === 'in-progress' || task.status === 'verifying') && task.claimedBy && task.claimedBy !== state.sessionId
      var canIntervene = task.status === 'in-progress' || task.status === 'verifying'
      return React.createElement('div', { style: { padding: '4px 2px' } },
        React.createElement('div', { onClick: function () { state.detailId = null; notify() }, style: { fontSize: 11, color: C.brand, cursor: 'pointer', marginBottom: 8 } }, '← 返回看板'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } }, React.createElement('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 3, background: prioColor[task.priority] || prioColor.low, color: '#fff' } }, prioLabel[task.priority] || '中'), React.createElement('span', { style: { fontSize: 11, padding: '1px 8px', borderRadius: 3, background: C.nested, color: C.text } }, statusLabels[task.status] || task.status), React.createElement('select', { value: task.pipeline || 'full', onChange: function (e) { rpc('update-task', { taskId: task.id, pipeline: e.target.value }).then(fetchTasks).catch(function () {}) }, title: '管线档位', style: { fontSize: 10, padding: '1px 4px', border: '1px solid ' + C.border, borderRadius: 3, background: C.card, color: C.text2 } }, React.createElement('option', { value: 'full' }, '🧪 全流程'), React.createElement('option', { value: 'work' }, '📝 免验证'), React.createElement('option', { value: 'direct' }, '💬 主窗口处理')), task.pipelineAuto ? React.createElement('span', { style: { fontSize: 9, color: C.text2 }, title: '由规则自动分类，可手动覆盖' }, 'auto') : null, isManual ? React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, '👤 手动派发') : null),
        task.escalation ? React.createElement('div', { style: { marginBottom: 8, padding: '8px 10px', border: '1px solid ' + C.err, borderRadius: 6, background: 'color-mix(in srgb, ' + C.err + ' 8%, transparent)' } },
          React.createElement('div', { style: { fontSize: 12, fontWeight: 700, color: C.err, marginBottom: 4 } }, '⚠️ Worker 上报歧义 — 等待主窗口裁决'),
          React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 6, whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' } }, task.escalation.question),
          React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 6 } }, '上报于 ' + ago(task.escalation.at) + ' · ' + (task.escalation.by || '')),
          React.createElement('textarea', { value: arbAnswer, onChange: function (e) { setArbAnswer(e.target.value) }, rows: 2, placeholder: '输入裁决指示，将直接转达给原 Worker（保有上下文）…', style: { width: '100%', fontSize: 11, padding: '5px 8px', marginBottom: 4, border: '1px solid ' + C.err, borderRadius: 4, background: C.card, color: C.text, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' } }),
          React.createElement('button', { onClick: submitArbitration, disabled: !arbAnswer.trim(), style: { fontSize: 11, padding: '4px 12px', border: 'none', borderRadius: 4, background: C.err, color: '#fff', cursor: 'pointer', fontWeight: 600 } }, '⚖️ 提交裁决')) : null,
        actionMsg ? React.createElement('div', { style: { fontSize: 11, color: C.text2, marginBottom: 6 } }, actionMsg) : null,
        task.stuckSince ? React.createElement('div', { style: { marginBottom: 8, padding: '8px 10px', border: '1px solid ' + C.warn, borderRadius: 6, background: 'color-mix(in srgb, ' + C.warn + ' 8%, transparent)' } },
          React.createElement('div', { style: { fontSize: 12, fontWeight: 700, color: C.warn, marginBottom: 4 } }, '⏱ 执行 Agent 疑似卡死'),
          React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 6 } }, '标记于 ' + ago(task.stuckSince) + '（运行超 5 分钟且事件流停滞超 1 分钟）。你可以查看其会话后决定：'),
          React.createElement('div', { style: { display: 'flex', gap: 6 } },
            React.createElement('button', { onClick: doTerminate, style: { fontSize: 11, padding: '4px 12px', border: 'none', borderRadius: 4, background: C.err, color: '#fff', cursor: 'pointer', fontWeight: 600 } }, '⏹ 终止任务（重新排队）'),
            React.createElement('button', { onClick: doDismiss, style: { fontSize: 11, padding: '4px 12px', border: '1px solid ' + C.border, borderRadius: 4, background: 'transparent', color: C.text2, cursor: 'pointer' } }, '继续观察'),
            canJump ? React.createElement('button', { onClick: jumpToAgent, style: { fontSize: 11, padding: '4px 12px', border: '1px solid ' + C.brand, borderRadius: 4, background: 'transparent', color: C.brand, cursor: 'pointer' } }, '→ 查看会话') : null)) : null,
        React.createElement('input', { value: editTitle, onChange: function (e) { setEditTitle(e.target.value) }, style: { width: '100%', fontSize: 13, fontWeight: 600, padding: '4px 6px', marginBottom: 6, border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text, boxSizing: 'border-box' } }),
        React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 8, lineHeight: 1.7 } }, React.createElement('div', null, 'ID: ' + task.id), React.createElement('div', null, '创建: ' + fmtTime(task.createdAt) + '（' + ago(task.createdAt) + '）'), task.claimedBy ? React.createElement('div', null, '领取人: ', React.createElement(ActorLink, { id: task.claimedBy }), ' · ' + ago(task.claimedAt)) : null, task.resolvedAt ? React.createElement('div', null, '提交: ' + fmtTime(task.resolvedAt)) : null, task.verifiedAt ? React.createElement('div', null, '验收: ' + fmtTime(task.verifiedAt) + ' by ', React.createElement(ActorLink, { id: task.verifiedBy })) : null),
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 3 } }, '任务描述'),
        React.createElement('textarea', { value: editDesc, onChange: function (e) { setEditDesc(e.target.value) }, rows: 3, style: { width: '100%', fontSize: 12, padding: '6px 8px', marginBottom: 6, border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' } }),
        task.context && task.context.instructions ? React.createElement('div', { style: { fontSize: 11, color: C.text2, marginBottom: 6, padding: '4px 6px', background: C.nested, borderRadius: 4 } }, '指引: ' + task.context.instructions) : null,
        React.createElement(DepsSection, { task: task }),
        task.acceptance ? React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 6, padding: '5px 8px', background: C.nested, borderRadius: 4, borderLeft: '2px solid ' + C.ok, fontFamily: 'monospace' } }, '🧪 硬性验收: ' + task.acceptance) : null,
        task.resolution ? React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 6, padding: '5px 8px', background: C.nested, borderRadius: 4, borderLeft: '2px solid ' + C.warn, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap' } }, '📝 ' + task.resolution) : null,
        task.deliverable ? React.createElement('div', { style: { marginBottom: 8, padding: '6px 8px', border: '1px solid ' + C.border, borderRadius: 6, background: C.card } },
          React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: C.brand, marginBottom: 4 } }, '📦 交付报告 · ' + (task.deliverable.by || '') + ' · ' + ago(task.deliverable.at)),
          React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 4, whiteSpace: 'pre-wrap' } }, task.deliverable.summary || '(无开发描述)'),
          task.deliverable.changes ? React.createElement('div', { style: { marginTop: 4 } }, React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2 } }, '改动清单'), React.createElement('div', { style: { fontSize: 10, color: C.text2, whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto' } }, task.deliverable.changes)) : null,
          task.deliverable.selfTest ? React.createElement('div', { style: { marginTop: 4 } }, React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2 } }, '自测情况'), React.createElement('div', { style: { fontSize: 10, color: C.text2, whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto' } }, task.deliverable.selfTest)) : null) : null,
        task.verification ? React.createElement('div', { style: { marginBottom: 8, padding: '6px 8px', border: '1px solid ' + (task.verification.verdict === 'approved' ? C.ok : C.err), borderRadius: 6, background: C.card } },
          React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: task.verification.verdict === 'approved' ? C.ok : C.err, marginBottom: 4 } }, (task.verification.verdict === 'approved' ? '🔍 验收通过' : '🔍 验收驳回') + ' · ' + (task.verification.by || '') + ' · ' + ago(task.verification.at)),
          React.createElement('div', { style: { fontSize: 11, color: C.text, marginBottom: 4, whiteSpace: 'pre-wrap' } }, task.verification.summary || '(无测试概要)'),
          task.verification.checks ? React.createElement('div', { style: { marginTop: 4 } }, React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2 } }, '核对项'), React.createElement('div', { style: { fontSize: 10, color: C.text2, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' } }, task.verification.checks)) : null) : null,
        React.createElement(MsgThread, { messages: task.messages }),
        Array.isArray(task.history) && task.history.length > 0 ? React.createElement('div', { style: { marginBottom: 8 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 3 } }, '流转轨迹'), React.createElement('div', { style: { fontSize: 10, color: C.text2, padding: '4px 6px', background: C.nested, borderRadius: 4 } }, task.history.map(function (h, i) { return React.createElement('div', { key: i, style: { marginBottom: 2 } }, React.createElement('span', { style: { color: C.brand } }, statusLabels[h.to] || h.to), ' · ' + ago(h.timestamp) + ' · ', React.createElement(ActorLink, { id: h.actor }), h.note ? ' · ' + h.note : '') }))) : null,
        React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 } },
          React.createElement('button', { onClick: saveEdit, disabled: saving, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.brand, color: '#fff', cursor: 'pointer' } }, saving ? '保存中…' : '💾 保存并重置'),
          task.status === 'draft' ? React.createElement('button', { onClick: function () { doAction(function () { return rpc('update-task', { taskId: task.id, publish: true }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.ok, color: '#fff', cursor: 'pointer', fontWeight: 600 } }, '🚀 发布（进入派发池）') : null,
          (task.status === 'pending' || task.status === 'blocked') ? React.createElement('button', { onClick: function () { doAction(function () { return rpc('claim-task', { taskId: task.id }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.brand, color: '#fff', cursor: 'pointer' } }, '领取') : null,
          task.status === 'verifying' ? React.createElement('button', { onClick: function () { doAction(function () { return rpc('verify-task', { taskId: task.id, verdict: 'approved' }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.ok, color: '#fff', cursor: 'pointer' } }, '✓ 通过') : null,
          task.status === 'verifying' ? React.createElement('button', { onClick: function () { var r = window.prompt('驳回原因：'); doAction(function () { return rpc('verify-task', { taskId: task.id, verdict: 'rejected', comment: r || '' }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.err, color: '#fff', cursor: 'pointer' } }, '✗ 驳回') : null,
          task.status === 'resolved' ? React.createElement('button', { onClick: function () { doAction(function () { return rpc('archive-task', { taskId: task.id }) }) }, style: { fontSize: 10, padding: '3px 8px', border: 'none', borderRadius: 3, background: C.text2, color: '#fff', cursor: 'pointer' } }, '📦 归档') : null,
          canJump ? React.createElement('button', { onClick: jumpToAgent, style: { fontSize: 10, padding: '3px 8px', border: '1px solid ' + C.brand, borderRadius: 3, background: 'transparent', color: C.brand, cursor: 'pointer' } }, '→ 跳转执行会话') : null),
        canIntervene ? React.createElement('div', { style: { marginTop: 8, padding: '6px 8px', border: '1px dashed ' + C.warn, borderRadius: 6 } },
          React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.warn, marginBottom: 4 } }, '⚡ 高优先级介入（插入执行 Agent 队首）'),
          React.createElement('div', { style: { display: 'flex', gap: 4 } },
            React.createElement('input', { value: interveneMsg, onChange: function (e) { setInterveneMsg(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') submitIntervene() }, placeholder: '给执行中的 Agent 下达高优指令…', style: { flex: 1, fontSize: 11, padding: '4px 8px', border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text } }),
            React.createElement('button', { onClick: submitIntervene, disabled: !interveneMsg.trim(), style: { fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 4, background: C.warn, color: '#fff', cursor: 'pointer', fontWeight: 600 } }, '介入'))) : null,
        mode === 'manual' ? React.createElement('div', { style: { marginTop: 8 } }, React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 3 } }, '派发给子 Agent'), React.createElement('select', { value: task.assignee || '', onChange: function (e) { assignTo(e.target.value || null) }, style: { width: '100%', fontSize: 11, padding: '4px 6px', border: '1px solid ' + C.border, borderRadius: 4, background: C.card, color: C.text } }, React.createElement('option', { value: '' }, '— 未指派 —'), state.children.map(function (c) { return React.createElement('option', { key: c.id, value: c.id }, (c.label || c.id).slice(0, 40)) }))) : null)
    }
    function TopPanel() {
      var _R = React; var useState = _R.useState, useEffect = _R.useEffect
      var _a = useState(state.open), open = _a[0], setOpen = _a[1]; var _b = useState(state.tasks), tasks = _b[0], setTasksState = _b[1]; var _c = useState(state.boardMode), mode = _c[0], setModeState = _c[1]; var _d = useState(state.detailId), detailId = _d[0], setDetailId = _d[1]; var _e = useState(false), showArchived = _e[0], setShowArchived = _e[1]; var _f = useState(state.dragOver), dragOver = _f[0], setDragOver = _f[1]; var _g = useState(state.dispatchInfo), dispatchInfo = _g[0], setDispatchInfo = _g[1]; var _j = useState(state.view), view = _j[0], setViewState = _j[1]; var _k = useState(state.layoutLeft), layL = _k[0], setLayL = _k[1]; var _l = useState(state.layoutRight), layR = _l[0], setLayR = _l[1]
      var _m = useState(state.minWorkers), minW = _m[0], setMinW = _m[1]; var _n = useState(state.maxWorkers), maxW = _n[0], setMaxW = _n[1]; var _o = useState(state.minVerifiers), minV = _o[0], setMinV = _o[1]; var _p = useState(state.maxVerifiers), maxV = _p[0], setMaxV = _p[1]
      var _q = useState(state.teamMode), teamMode = _q[0], setTeamMode = _q[1]
      useEffect(function () { function update() { setOpen(state.open); setTasksState(state.tasks); setModeState(state.boardMode); setDetailId(state.detailId); setDragOver(state.dragOver); setDispatchInfo(state.dispatchInfo); setViewState(state.view); setLayL(state.layoutLeft); setLayR(state.layoutRight); setMinW(state.minWorkers); setMaxW(state.maxWorkers); setMinV(state.minVerifiers); setMaxV(state.maxVerifiers); setTeamMode(state.teamMode) }; listeners.push(update); update(); return function () { var i = listeners.indexOf(update); if (i >= 0) listeners.splice(i, 1) } }, [])
      if (!open) return null
      var active = tasks.filter(function (t) { return t.status !== 'archived' }); var archived = tasks.filter(function (t) { return t.status === 'archived' })
      var hasFilter = state.filterQ.trim() || state.filterPrio.length > 0 || state.filterTag
      if (hasFilter) { active = active.filter(passFilter); archived = archived.filter(passFilter) }
      var content
      if (view === 'dashboard') { content = React.createElement(Dashboard) }
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
        content = React.createElement('div', null, React.createElement(FilterBar, null), hasFilter && active.length === 0 && archived.length === 0 ? React.createElement('div', { style: { textAlign: 'center', padding: 16, color: C.text2, fontSize: 11 } }, '无匹配任务') : null, React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 6 } }, state.selectMode ? '多选模式：点击卡片勾选，底部批量操作' : '提示：拖拽卡片到目标列即可流转状态'), React.createElement('div', { style: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 } }, cols), archived.length > 0 ? React.createElement('div', { style: { marginTop: 4 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, React.createElement('div', { onClick: function () { setShowArchived(!showArchived) }, style: { fontSize: 11, color: C.text2, cursor: 'pointer', userSelect: 'none' } }, (showArchived ? '▼' : '▶') + ' 已归档 (' + archived.length + ')'), showArchived ? React.createElement('select', { value: state.archSort, onChange: function (e) { state.archSort = e.target.value; notify() }, title: '归档排序', style: { fontSize: 9, padding: '1px 4px', border: '1px solid ' + C.border, borderRadius: 3, background: C.card, color: C.text2 } }, React.createElement('option', { value: 'time-desc' }, '最新在前'), React.createElement('option', { value: 'time-asc' }, '最早在前'), React.createElement('option', { value: 'title' }, '按标题')) : null), showArchived ? React.createElement('div', { style: { maxHeight: '32vh', overflowY: 'auto', marginTop: 4, paddingRight: 2 } }, archSorted.map(function (t) { return React.createElement(Card, { key: t.id, task: t }) })) : null) : null, React.createElement(BatchBar, null))
      }
      return React.createElement('div', { style: { position: 'fixed', top: 44, left: (layL + 8) + 'px', right: (layR + 8) + 'px', maxHeight: '60vh', zIndex: 900, background: C.bg, border: '1px solid ' + C.border, borderRadius: '0 0 10px 10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid ' + C.border, flexShrink: 0, flexWrap: 'wrap', gap: 4 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, React.createElement('span', { style: { fontWeight: 600, fontSize: 13, color: C.text } }, '📋 任务看板'), React.createElement(ViewTab, null), React.createElement(PoolStatus, null)),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
            React.createElement(PoolCfgPopover, { minW: minW, maxW: maxW, minV: minV, maxV: maxV, verifierModel: state.verifierModel }),
            dispatchInfo ? React.createElement('span', { style: { fontSize: 9, color: C.brand, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: dispatchInfo }, dispatchInfo) : null,
            React.createElement('button', { onClick: function () { state.selectMode = !state.selectMode; if (!state.selectMode) state.selected = {}; notify() }, title: '多选批量操作', style: { fontSize: 11, padding: '3px 8px', border: '1px solid ' + (state.selectMode ? C.brand : C.border), borderRadius: 6, cursor: 'pointer', background: state.selectMode ? C.brand : 'transparent', color: state.selectMode ? '#fff' : C.text2 } }, '☑ 多选'),
            React.createElement(TeamSwitch, { on: teamMode }),
            React.createElement(ModeSwitch, { mode: mode }),
            React.createElement('button', { onClick: function () { fetchTasks(); fetchChildren() }, title: '刷新', style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: C.text2 } }, '🔄'),
            React.createElement('button', { onClick: function () { state.open = false; state.detailId = null; notify() }, title: '关闭', style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: C.text2 } }, '✕'))),
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '10px 12px' } }, tasks.length === 0 ? React.createElement('div', { style: { textAlign: 'center', padding: 24, color: C.text2, fontSize: 12 } }, '🎉 暂无任务') : content))
    }
    slots.inject('conversation.session.header.actions', function () { return slots.register({ name: 'conversation.session.header.actions', id: 'task-board-btn', label: '任务看板', order: 30 }, function (props) { return React.createElement(BoardButton, props) }) })
    slots.inject('shell.overlay', function () { return slots.register({ name: 'shell.overlay', id: 'task-board-top-panel' }, function () { return React.createElement(TopPanel) }) })
}

module.exports = { name: 'dsh-agent-board', apply: apply }
return module.exports
  }
})
