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
      function setRange(from, to) {
        state.dateRange = { from: from, to: to }
        // 报告/总览是本地现算，notify 即可；Token 区的模型分布/Top8/累计要按范围重算，
        // 而过滤在 host（run 级数据只在 host）→ 必须重拉一次 get-tasks（fetchTasks 会带上新范围）。
        // fetchTasks 在 kernel 域定义，同处 apply 函数体 → 函数声明提升，此处可用。
        if (typeof fetchTasks === 'function') fetchTasks()
        notify()
      }
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
            React.createElement('span', { style: { fontSize: 9, color: C.text2 } }, '作用于报告、全局总览与 Token 区（模型分布/Top8/累计）')),
          React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 5 } }, '报告统计「时间范围内有活动」的任务；总览只显示范围内有活跃的会话；Token 区按 run 的本地日落点过滤（今日与近 7 天为固定口径，不受范围影响）。')) : null)
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
    // 日账（usageSummary.byDayFull：{'YYYY-MM-DD': {t,e}}）用于「今日」大数字与「近 7 天」条形。
    // 双指标口径：t = 总量（含缓存读）、e = 有效消耗（输入+输出+缓存写，不含缓存读）。
    // e === null 表示该日只有老形态 number 日账 / 存量兜底（没有逐 run 拆分，有效值不可知）——
    // 旧口径日不拿 t 冒充有效（task-muwsnyqv ③：本板 10-05 t=154M 含 97% 缓存读曾被画成巨柱）：
    // 今日大数字显示「—」+ title 说明，近 7 天画矮灰柱 + tooltip 标「旧口径数据（仅总量）」。
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
      // 范围激活标记：Token 区的模型分布/Top8/累计已按「统计范围」过滤（host 侧重算），
      // 不加标记的话用户没法判断看到的数字是全量还是范围内——标记与 RangeFilter 同源（activeRange）。
      var tg = activeRange()
      var tgOn = !!(tg.from || tg.to)
      var head = React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 } }, ic('bar-chart-3', 11), 'Token 消耗',
        tgOn ? React.createElement('span', { style: { fontSize: 9, fontWeight: 400, color: C.brand, border: '1px solid ' + C.brand, borderRadius: 8, padding: '0 6px' }, title: '模型分布 / 任务消耗 Top 8 / 累计已按统计范围过滤：' + rangeLabel() }, '范围内: ' + rangeLabel()) : null)
      if (!u || !u.total) return React.createElement('div', { style: box }, head, React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无数据（Worker/Verifier 会话日志里还没有 usage 记录）'))
      // ===== 主数字口径统一（task-muwq9u04）：模型分布行与 Top8 行的主数字一律显示**有效消耗**（e），
      // 含缓存读的合计（t）退到 title 悬浮；否则同一块里「今日有效 3.7M」与「单任务 21M」并排自相矛盾
      // （用户就是这么判成 bug 的）。数据源：host 的 byModelEff（模型有效分摊）与 topTasks[].effective；
      // 老 host 缺 byModelEff / 老卡无五分量留账 → 退化用合计值并在 title 标 ~（口径不伪造）。
      // 排序按**显示口径**（有效）降序：条形长度与行序一致，否则首行不是最长的条。
      var models = Object.keys(u.byModel || {}).map(function (m) {
        var tt = u.byModel[m] || 0
        var ee = (u.byModelEff && typeof u.byModelEff[m] === 'number') ? u.byModelEff[m] : null
        return { model: m, total: tt, eff: (ee === null ? tt : ee), approx: ee === null }
      }).sort(function (a, b) { return b.eff - a.eff })
      var maxM = models.length ? (models[0].eff || 1) : 1
      var top = (u.topTasks || []).map(function (x) {
        var ee = (typeof x.effective === 'number') ? x.effective : null
        return { id: x.id, title: x.title, total: x.total, cacheRead: x.cacheRead, runs: x.runs, eff: (ee === null ? x.total : ee), approx: ee === null }
      }).sort(function (a, b) { return b.eff - a.eff })
      var maxT = top.length ? (top[0].eff || 1) : 1
      // 日账：今日数字取本地日 key，没有日账（缺字段/老 host）时退化为 0，不炸也不误报。
      // 读侧兼容两种单元形态：老 number（只有总量，有效值不可知）→ { t: n, e: null }。
      // 固定口径数据源（task-muwsnyqv ②）：「今日」「近 7 天」读**未过滤**的 byDayFull——caption
      // 承诺这两处不随统计范围变，读范围内 byDay 会让「今天被范围裁掉」时大数字凭空归零（实证）。
      // 老 host 缺 byDayFull → 退化读 byDay（范围内口径，数值可能偏小但形态一致，不炸）。
      var byDay = (u.byDayFull && typeof u.byDayFull === 'object') ? u.byDayFull : ((u.byDay && typeof u.byDay === 'object') ? u.byDay : {})
      function dayOf(v) {
        if (v && typeof v === 'object') return { t: Number(v.t) || 0, e: (v.e === 0 || v.e) ? Number(v.e) || 0 : null }
        return { t: Number(v) || 0, e: null }
      }
      var todayKey = localDayKey()
      var todayCell = dayOf(byDay[todayKey])
      // 旧口径日（e===null 且有总量：老 number 日账/存量兜底，只有含缓存读的总量）不拿 t 冒充有效
      // （task-muwsnyqv ③）——大数字显示「—」+ title 说明；t=0 且无日账 = 今日尚无结算，照常显示 0。
      var todayLegacy = todayCell.e === null && todayCell.t > 0
      var todayEff = todayCell.e === null ? 0 : todayCell.e
      var days = lastNDays(7)
      var maxDay = 1
      var hasDayData = false
      var hasLegacy = false
      // maxDay 只按有效消耗归一：旧口径日（e===null）的 t 含缓存读（本板实测占 97%），参与归一会
      // 把其余日子的有效柱压成平地（task-muwsnyqv ③：10-05 t=154M 巨柱就是这么来的）。
      for (var di = 0; di < days.length; di++) { var dc = dayOf(byDay[days[di]]); if (dc.e !== null && dc.e > maxDay) maxDay = dc.e; if (dc.e === null && dc.t > 0) hasLegacy = true; if (dc.t > 0 || dc.e > 0) hasDayData = true }
      function mini(label, value) { return React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, label + ' ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(value))) }
      // 累计三分量：有效（真实成本）+ 缓存读（占了 total 的大头，必须单列才看得出虚高来源）+ 合计
      var effTotal = (typeof u.effective === 'number') ? u.effective : ((u.input || 0) + (u.output || 0) + (u.cacheWrite || 0))
      return React.createElement('div', { style: box },
        head,
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 } },
          React.createElement('span', { style: { fontSize: 20, fontWeight: 700, color: todayLegacy ? C.text2 : C.brand }, title: todayLegacy ? ('今日有效消耗不可知：该日账为旧口径数据（仅总量 ' + fmtTokens(todayCell.t) + ' tok，含缓存读），总量不冒充有效值') : ('今日有效消耗（本地日 ' + todayKey + '）= 输入+输出+缓存写，不含缓存读；一次 run 的消耗整笔记在结算日') }, todayLegacy ? '—' : fmtTokens(todayEff)),
          React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, 'tokens（今日有效' + (todayLegacy ? ' · 旧口径不可知' : '') + '）'),
          todayCell.t > todayEff ? React.createElement('span', { style: { fontSize: 10, color: C.text2 }, title: '今日总量（含缓存读）——与有效消耗的差额就是缓存读' + (todayLegacy ? '；该日为旧口径数据，有效消耗不可知' : '') }, '含缓存读共 ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(todayCell.t))) : null,
          React.createElement('span', { style: { fontSize: 10, color: C.text2 } }, '累计（本看板） 有效 ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(effTotal)), ' · 缓存读 ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(u.cacheRead)), ' · 合计 ', React.createElement('span', { style: { color: C.text, fontWeight: 600 } }, fmtTokens(u.total))),
          mini('输入', u.input), mini('输出', u.output), u.cacheWrite ? mini('缓存写', u.cacheWrite) : null),
        // 近 7 天迷你条形：高按区间 max 归一（今天高亮 brand，其余浅底 + 边框），
        // 柱高一律取**有效消耗**；e 不可知的旧口径日不拿总量冒充——画固定矮灰柱（tooltip 标明
        // 「旧口径数据（仅总量，含缓存读）」），有效柱高不被缓存读撑歪。7 天全为 0 时整块不渲染。
        hasDayData ? React.createElement('div', { style: { marginBottom: 8 } },
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 4 } }, '近 7 天（有效消耗）', hasLegacy ? React.createElement('span', { style: { fontSize: 9, fontWeight: 400, marginLeft: 6 } }, '灰柱 = 旧口径数据（仅总量）') : null),
          React.createElement('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 4 } },
            days.map(function (k) {
              var c = dayOf(byDay[k])
              // 旧口径日（e===null 且有总量）：不拿 t 冒充有效画柱（task-muwsnyqv ③）——
              // 画固定矮灰柱 + tooltip 标明；有效日柱高照常按有效消耗归一。
              var legacy = c.e === null && c.t > 0
              var v = legacy ? 0 : (c.e || 0)
              var isToday = k === todayKey
              var h = legacy ? 6 : (v > 0 ? Math.max(3, Math.round(v / maxDay * 32)) : 3)
              return React.createElement('div', { key: k, title: legacy ? (k.slice(5) + '：旧口径数据（仅总量 ' + String(c.t) + ' tok，含缓存读；有效消耗不可知，不拿总量画柱）') : (k.slice(5) + '：有效 ' + String(v) + ' tok' + (c.t > v ? ' / 含缓存读共 ' + String(c.t) + ' tok' : '')), style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 } },
                React.createElement('div', { style: { width: '100%', height: h, background: legacy ? C.border : (isToday ? C.brand : C.nested), border: '1px solid ' + (legacy ? C.border2 : (isToday ? C.brand : C.border)), borderRadius: 2 } }),
                React.createElement('span', { style: { fontSize: 8, color: isToday ? C.brand : C.text2, whiteSpace: 'nowrap' } }, k.slice(5)))
            }))) : null,
        React.createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          React.createElement('div', { style: { flex: '1 1 240px', minWidth: 200 } },
            React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 4 } }, '按模型分布（有效消耗）'),
            models.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无数据') : models.map(function (m) {
              return React.createElement(UsageRow, { key: m.model, label: m.model, value: m.eff, max: maxM, color: C.brand, title: m.model + '：有效 ' + (m.approx ? '~' : '') + String(m.eff) + ' tokens（不含缓存读）' + (m.approx ? '——本模型无有效分量留账，以合计近似' : '') + ' · 含缓存读合计 ' + String(m.total) + ' tokens' })
            })),
          React.createElement('div', { style: { flex: '1 1 240px', minWidth: 200 } },
            React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, marginBottom: 4 } }, '任务消耗 Top 8（有效消耗）'),
            top.length === 0 ? React.createElement('div', { style: { fontSize: 10, color: C.text2 } }, '暂无数据') : top.map(function (x) {
              var t = getTask(x.id)
              return React.createElement(UsageRow, { key: x.id, label: x.title || x.id, value: x.eff, max: maxT, color: C.ok, labelColor: t ? C.brand : C.text2, title: x.title + '（有效 ' + (x.approx ? '~' : '') + String(x.eff) + ' tokens（不含缓存读） · 含缓存读合计 ' + String(x.total) + ' · 其中缓存读 ' + String(x.cacheRead || 0) + ' · ' + (x.runs || 0) + ' 次 run）' + (x.approx ? '（老卡无五分量留账，有效值以合计近似）' : '') + (t ? '——点击查看详情' : ''), onClick: t ? function () { state.detailId = x.id; notify() } : undefined })
            }))),
        // 口径边界：本区只统计看板派发的 Worker/Verifier run，主窗口对话自身不越界纳入
        // 范围说明（task-muwc7hjd）：用户常把 RangeFilter 当成「整页过滤」，但今日大数字与近 7 天柱子
        // 是自身固定口径（今日=本地今天、近 7 天=最近 7 个本地日）——不随范围变，必须在文案里讲清，
        // 否则「选了范围数字没变」看起来像 bug。模型分布/Top8/累计才是范围生效的三处。
        React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 6, lineHeight: 1.5 } }, '口径：仅看板派发的 Worker/Verifier run 消耗，不含主窗口对话；主数字（模型分布 / Top 8）与「今日」「近 7 天」均为有效消耗口径（输入+输出+缓存写，不含缓存读），含缓存读的合计在悬浮 title 里单列对照'),
        React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 2, lineHeight: 1.5 } }, '统计范围作用于按模型分布 / 任务消耗 Top 8 / 累计三分量（按 run 的本地日落点过滤）；今日与「近 7 天」为固定口径，不随范围变化。'))
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
      // 开关点击即时反馈（反馈：勾选几秒才同步，task-muw5uudk）：
      // checked 是受控值（读 Props→state，由 3s 轮询通知才更新），此前 onChange 只发 rpc →
      // 点下去要等 set-board-config + fetchTasks 双往返（安静板卡上 tasksHash 不变还会被渲染节约吃掉）才翻面。
      // 口径：**先写 state + notify（点击瞬时翻面）→ 再 rpc('set-board-config') → 失败回滚 state + notify
      // 并复用错误条 reportReadErr（沿用「读路径错误防线」：绝不让开关停在未落盘的值上）**。
      // 成功路径的权威纠偏在 kernel.fetchTasks（配置变化检测），此处不重复 fetchTasks：3s 轮询自会带回真值。
      function cfgRollback(key, prev) { state[key] = prev; notify() }
      function setCfg(key, next) {
        var prev = !!state[key] // 乐观更新前的值，失败回滚用
        state[key] = next === true // 归一成布尔：默认开口径由服务端权威值（fetchTasks）纠偏
        notify() // 立即翻面，不等 rpc
        rpc('set-board-config', { key: key, value: next === true }).catch(function (e) { cfgRollback(key, prev); reportReadErr('设置保存失败：' + readErrText(e)) })
      }
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
            React.createElement('input', { type: 'checkbox', checked: !!props.feedbackEnabled, onChange: function (e) { setCfg('feedbackEnabled', e.target.checked) } }),
            React.createElement('span', null, '候选教训（Verifier 驳回/仲裁结论自动生成候选，Worker prompt 提示先检索历史教训）')),
          // 回执开关（用户要求「回执可以做一个开关，放到设置里」）：派发/完成两类回执各自可关，缺省都开。
          // 只影响回执播报，不影响派发与状态机；歧义裁决通知不在此闸门内（见下行说明文案）。
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, margin: '7px 0 5px' } }, '通知'),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text, cursor: 'pointer', whiteSpace: 'normal', maxWidth: 260 } },
            React.createElement('input', { type: 'checkbox', checked: props.notifyDispatch !== false, onChange: function (e) { setCfg('notifyDispatch', e.target.checked) } }),
            React.createElement('span', null, '⚡ 派发回执（任务被 Worker/Verifier 领走时播报）')),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text, cursor: 'pointer', whiteSpace: 'normal', maxWidth: 260, marginTop: 3 } },
            React.createElement('input', { type: 'checkbox', checked: props.notifyDone !== false, onChange: function (e) { setCfg('notifyDone', e.target.checked) } }),
            React.createElement('span', null, '✅ 完成回执（任务完成或阻塞时聚合播报）')),
          React.createElement('div', { style: { fontSize: 9, color: C.text2, marginTop: 3, whiteSpace: 'normal', maxWidth: 260 } }, '歧义裁决通知不受这两个开关影响（任务等人裁决必须提醒）'),
          // 史诗拆分总开关（板级 epicSplit，缺省 true）：**只关引导，不禁机制**——关掉后 Team 提示词不再
          // 注入「大任务必须拆分」第 6 条、create-task 响应不再附 suggestSplit 软提示；显式传 parentId 建
          // 子卡、史诗自动收口/hooks 状态机照常（用户/主窗口明确要拆时不受阻）。勾选态缺字段=开，与 host 同口径。
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: C.text2, margin: '7px 0 5px' } }, '功能'),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.text, cursor: 'pointer', whiteSpace: 'normal', maxWidth: 260 } },
            React.createElement('input', { type: 'checkbox', checked: props.epicSplit !== false, onChange: function (e) { setCfg('epicSplit', e.target.checked) } }),
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
