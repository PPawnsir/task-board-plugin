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
      var _R = React; var useState = _R.useState // 与全库组件同例：bundler 只注入 React 本体，hook 须自行解构（漏了就是运行期 ReferenceError，shell 容错层直接卸载整个 overlay——2026-10-05 详情页崩板事故）
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
            if (window.confirm('⚠️ 文件锁冲突：以下任务正持有同一批文件（touches 重叠；锁持到归档——verifying/resolved 卡也在持锁，等其归档即自动放行）：\n\n' + (names || ids.join('、')) + '\n\n强行并行可能互相覆盖改动/diff 冲突。仍要越权派发吗？')) return send(true)
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
                // 续跑标记（卡2 落的 runs[i].resume 字段；卡3 Step3 在此显式标注）：同一条会话的第二次及以后
                // 派发是「冷复活续跑」而不是新开 Worker，不标出来会让人把「第 2/3 次」误读成又开了一个新会话。
                // 只读 r.resume，不猜（老留档没有该字段 → 零渲染，与改造前逐字一致）。
                var rsMark = r.resume === true ? ' ↻' : ''
                return React.createElement('button', {
                  key: i, onClick: function () { if (uiWorkspaceSvc) uiWorkspaceSvc.openSession(r.id) },
                  title: rm.tip + ' 第 ' + seq + ' 次' + (r.resume === true ? '（↻ 冷复活续跑：沿用上一次的子会话，非新开）' : '') + (r.at ? ' · ' + ago(r.at) : '') + (r.model ? ' · ' + r.model : '') + (r.outcome ? ' · ' + r.outcome : '') + '（' + r.id + '）',
                  style: { fontSize: 10, padding: '2px 8px', border: '1px solid ' + (isCur ? rm.color : C.border), borderRadius: 3, background: isCur ? C.card : 'transparent', color: rm.color, cursor: 'pointer', fontWeight: isCur ? 600 : 400 }
                }, '→ ' + rm.tip + ' #' + seq + (r.at ? ' · ' + ago(r.at) : '') + okMark + rsMark)
              })))
        })(),
        canIntervene ? React.createElement('div', { style: { marginTop: 8, padding: '6px 8px', border: '1px dashed ' + C.warn, borderRadius: 6 } },
          React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.warn, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 } }, ic('zap', 11), '高优先级介入（插入执行 Agent 队首）'),
          React.createElement('div', { style: { display: 'flex', gap: 4 } },
            React.createElement('input', { value: interveneMsg, onChange: function (e) { setInterveneMsg(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') submitIntervene() }, placeholder: '给执行中的 Agent 下达高优指令…', style: { flex: 1, fontSize: 11, padding: '4px 8px', border: '1px solid ' + C.border2, borderRadius: 4, background: C.card, color: C.text } }),
            React.createElement('button', { onClick: submitIntervene, disabled: !interveneMsg.trim(), style: { fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 4, background: C.warn, color: C_INV, cursor: 'pointer', fontWeight: 600 } }, '介入'))) : null)
    }
