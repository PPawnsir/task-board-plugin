// ============================================================================
// dashboard —— 仪表盘域：统计（computeStats/TrendChart/StatCard/BarRow）· 范围筛选（RangeFilter）
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
      // 耗时口径三分离（task-mutdnitw）：avgQueue=平均排队（创建→被领取）、avgExec=平均执行（被领取→完成），均只统计领取过的卡；avgVerify 口径不动（完成→验收）
      return { total: total, byStatus: byStatus, byPriority: byPriority, byAgent: byAgent, avgQueue: fmtMs(avgMs(queueTimes)), avgExec: fmtMs(avgMs(execTimes)), avgVerify: fmtMs(avgMs(verifyTimes)), todayDone: todayDone, dailyDone: dailyDone, recentActivity: recentActivity }
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
      function mini(label, value) { return React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, label + ' ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(value))) }
      return React.createElement('div', { style: box },
        head,
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 } },
          React.createElement('span', { style: { fontSize: 20, fontWeight: 700, color: C.brand } }, fmtTokens(u.total)),
          React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, 'tokens（本看板累计）'),
          mini('输入', u.input), mini('输出', u.output), mini('缓存读', u.cacheRead), u.cacheWrite ? mini('缓存写', u.cacheWrite) : null),
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
              return React.createElement(UsageRow, { key: x.id, label: x.title || x.id, value: x.total, max: maxT, color: C.ok, labelColor: t ? C.brand : C.text2, title: x.title + '（' + String(x.total) + ' tokens / ' + (x.runs || 0) + ' 次 run）' + (t ? '——点击查看详情' : ''), onClick: t ? function () { state.detailId = x.id; notify() } : undefined })
            }))))
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
            React.createElement('span', null, '候选教训（Verifier 驳回/仲裁结论自动生成候选，Worker prompt 提示先检索历史教训）'))) : null)
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
