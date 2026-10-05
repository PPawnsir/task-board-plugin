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
    function Card(props) { var t = props.task; var pc = prioColor[t.priority] || prioColor.low; var dragging = state.dragTask === t.id; var preview = (t.deliverable && t.deliverable.summary) || t.resolution; var critGlow = t.priority === 'critical' && !t.escalation; var sel = !!state.selected[t.id]; var pm = pipeOf(t); var depBlock = t.status === 'pending' && depsBlocked(t); var delOk = !state.selectMode && canDelete(t); var cs = (state.childStats && state.childStats[t.id]) || null; var csDone = cs ? (typeof cs.settled === 'number' ? cs.settled : cs.resolved) : 0; var epic = !!(cs && cs.total > 0); var parentT = t.parentId ? getTask(t.parentId) : null; var depWaitTitle = ''; var depWaitN = 0; if (depBlock) { t.dependsOn.forEach(function (id) { var d = getTask(id); if (!d || (d.status !== 'resolved' && d.status !== 'archived')) { depWaitN++; if (!depWaitTitle) depWaitTitle = d && d.title ? d.title : id } }) } var durB = cardDur(t);
      // 无障碍（反馈 n-mut9rzpyc7p1）：卡片根以 button 角色进 Tab 序（aria-label=标题+状态），
      // Enter/Space 触发与点击相同的激活行为（多选=切换选中，否则开详情）；
      // focus 态用主题色 C.brand 2px outline（不用浏览器默认蓝框，保持主题一致）
      function activate() { if (state.selectMode) { if (state.selected[t.id]) delete state.selected[t.id]; else state.selected[t.id] = true; notify() } else { state.detailId = t.id; notify() } }
      return React.createElement('div', { role: 'button', tabIndex: 0, 'aria-label': t.title + '（' + (statusLabels[t.status] || t.status) + '）', draggable: !state.selectMode, onDragStart: function (e) { onDragStart(e, t) }, onDragEnd: onDragEnd, onMouseEnter: function () { if (delOk) setHover(t.id, 'del') }, onMouseLeave: function () { if (delOk) setHover('', '') }, onFocus: function () { setCardFocus(t.id) }, onBlur: function () { setCardFocus('') }, onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } }, onClick: activate, style: { outline: isCardFocus(t.id) ? '2px solid ' + C.brand : 'none', outlineOffset: 2, border: '1px solid ' + (sel ? C.brand : (t.escalation ? C.err : (critGlow ? C.err : C.border))), borderRadius: 6, padding: '6px 8px', marginBottom: 6, background: sel ? C.nested : C.card, borderLeft: '3px solid ' + (t.escalation ? C.err : pc), cursor: state.selectMode ? 'pointer' : 'grab', fontSize: 12, opacity: dragging ? 0.4 : (depBlock ? 0.65 : 1), transition: 'opacity .15s', animation: critGlow ? 'tskb-crit 2s ease-in-out infinite' : 'none' } }, React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 4 } }, state.selectMode ? React.createElement('span', { style: { color: sel ? C.brand : C.text2, flexShrink: 0, marginTop: 1, display: 'inline-flex' } }, ic(sel ? 'square-check-big' : 'square', 12)) : null, React.createElement('div', { style: { fontWeight: 600, color: C.text, marginBottom: 2, wordBreak: 'break-word', flex: 1 } }, t.title), React.createElement('span', { style: { flexShrink: 0, marginTop: 1, display: 'inline-flex', color: C.text2 }, title: pm.label }, ic(pm.icon, 10)), React.createElement('span', { style: { fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'color-mix(in srgb, ' + pc + ' 20%, transparent)', color: pc, flexShrink: 0, marginTop: 1 } }, prioLabel[t.priority] || '中'), noResearch(t) ? React.createElement('span', { title: '本任务未附调研上下文，Worker 需自行定位——建议补 contextFiles/contextNotes', style: { fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'color-mix(in srgb, ' + C.warn + ' 18%, transparent)', color: C.warn, fontWeight: 600, flexShrink: 0, marginTop: 1, whiteSpace: 'nowrap' } }, '⚠️ 无调研') : null, (t.usage && t.usage.total) ?React.createElement('span', { style: { fontSize: 9, color: C.text2, flexShrink: 0, marginTop: 1 }, title: '本任务累计 token：' + String(t.usage.total) + '（' + (t.usage.runs || 0) + ' 次 run）' }, '⛁ ' + fmtTokens(t.usage.total)) : null), t.parentId ? React.createElement('div', { style: { fontSize: 10, color: C.text2, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: parentT ? '父任务：' + parentT.title + ' (' + t.parentId + ')' : t.parentId }, '↳ ' + (parentT && parentT.title ? parentT.title : shortId(t.parentId))) : null, t.escalation ? React.createElement('div', { style: { fontSize: 10, color: C.err, fontWeight: 600, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 3 } }, ic('alert-triangle', 10), '待裁决 — 点击查看疑问') : null, t.stuckSince ? React.createElement('div', { style: { fontSize: 10, color: C.warn, fontWeight: 600, marginBottom: 2, animation: 'tskb-pulse 1.5s ease-in-out infinite' } }, '⏱ 疑似卡死 · ' + ago(t.stuckSince) + ' — 点击处理') : null, React.createElement('div', { style: { fontSize: 10, color: C.text2, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' } },
            epic ? React.createElement('span', { title: '史诗父卡：' + csDone + '/' + cs.total + ' 个子任务已了结（完成/取消/归档）', style: { fontSize: 9, padding: '0 4px', borderRadius: 2, background: 'color-mix(in srgb, ' + C.brand + ' 14%, transparent)', color: C.brand, fontWeight: 600 } }, '📦 史诗 · ' + csDone + '/' + cs.total) : null,
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
