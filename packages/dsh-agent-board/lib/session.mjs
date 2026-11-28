// dsh-agent-board — 会话层（lib/session.mjs）
// createSession(ctx, state)：agent 归属解析（resolveRoot 10s 缓存）/ 工具与 RPC 的会话 id 归一 /
// 已知会话心跳集合 / 工作模式三档派生 / feedback 与 epicSplit 开关读取 / 按会话找 root agent / 会话工作区 /
// 通用超时包装 / 活跃 run 表与派发履历访问。共享状态全部经 state 显式注入（别名为本地 var）。
// 另出口纯函数 isFullSessionId（幻影板防线口径，rpc.mjs 直接 import 复用，与 policy.mjs 纯函数同例）
// 与 hasChildDirectory/childSessionsOf（子会话目录统一源：旧 listChildren 兼容 + rc.5 listDescendants
// 持久 catalog 主源 + agents.list 活体回退；rpc/settle/dispatch 三面直接 import，与 isFullSessionId 同例）。

// 完整会话 id 结构判定（防幻影板，task-muuf0o7a）：真实 root 会话 id 形如
// session-cc24eb5c-702c-...（长度 ≥20 且至少两个 '-'）；裸短 id（如 cc24eb5c——某次调用
// 传了截断短 id）不具备完整结构，用它建出的 tasks-<短id>.json 是幻影板：poolCycle 对它
// pickDispatch 成功却永远匹配不到活 root（真实 id 带 session- 前缀与后缀），每 15s 心跳
// console.error 刷屏。import- 前缀板（import-sess_df0837fa-...）是合法的导入会话板，放行。
export function isRootSessionHeader(h) {
  if (!h) return true // 活体缺失 header 时保持旧放行语义；祖先链在缺少证据时停在当前会话
  if (h.origin === 'subagent') return false // rc.5 宿主 rootOf 的首要判据：显式子代理身份优先于深度/父 id
  if (h.parentSession) {
    // 主会话 fork/seed 也带 parentSession，但 delegationDepth=0；它不是子代理（task-mv59nn9m /
    // ontology_ai task_create 误拒 2026-11-24）。老 v3 子代理没有 depth，维持 parentSession→非根的保守口径。
    return typeof h.delegationDepth === 'number' && h.delegationDepth === 0
  }
  return true
}

export function isFullSessionId(sid) {
  if (!sid || typeof sid !== 'string') return false
  if (sid.indexOf('import-') === 0) return true // import- 前缀板合法，结构判断放行
  if (sid.length < 20) return false
  var first = sid.indexOf('-')
  return first > 0 && sid.indexOf('-', first + 1) > first
}

// ===== 子会话目录统一源（rc.5 契约迁移，task-mwzzub2w；截图故障 n-mwzztin5okiv）=====
// 四个消费点全部经此归一，不再各自摸 ctx.subagents.listChildren：list-children RPC 与 terminate
// 终止核验（rpc.mjs）/ 重启 reconcile（settle.mjs）/ 续跑死会话哨兵（dispatch.mjs）。
// 优先级：旧宿主 subagents.listChildren 原样兼容——有它就只用它（测试剧本/rc.5 之前的宿主零扰动）；
// rc.5 用 subagents.listDescendants 持久 catalog（不加载 Agent，冷子会话也在列）；最后才回退 agents.list()
// 活体全表 + header 过滤：parentSession===sid 且 origin==='subagent'（判据与 isRootSessionHeader 同源）。
// listDescendants 只收 kind==='child' && depth===1 && parentId===sid 的直接子会话；diagnostic、孙代理、
// 别家 parent 全部排除。agents.list 同样只收**直接子代理**：主 fork/seed 有 parentSession 但无 origin
// （或 depth=0）→ 不收；孙代理的 parentSession 指向子代理而非 sid → 不收；无父子关系会话 → 不收。
// 返回形状统一归一 {sessionId,id,label}（sessionId 与 id 同为子会话 id——旧目录行两种命名都见过，
// 消费方两种取法都不破）。查询统一包成 Promise：同步抛错也转 rejection，消费方 catch 口径单一。
// 无任何目录能力 → 返回 null（≠ 空数组）：null 是「查不了」，调用方保留既有跳过/无法核验语义；
// 空数组是「确认没有子会话」（reconcile 判死 / 哨兵立即结算 / 终止核验通过）。
export function hasChildDirectory(ctx) {
  var subs = ctx && ctx.subagents
  if (subs && typeof subs.listChildren === 'function') return true
  if (subs && typeof subs.listDescendants === 'function') return true
  var ag = ctx && ctx.agents
  return !!(ag && typeof ag.list === 'function')
}

export function childSessionsOf(ctx, sid, signal) {
  var subs = (ctx && ctx.subagents) || null
  if (subs && typeof subs.listChildren === 'function') {
    // 旧宿主路径：透传调用（signal 与 listDescendants 路径一样原样传递），返回行按消费面历史口径归一
    // （label||title||mode 与 rpc 旧实现同链）。异常原样转 rejection 交给调用方既有 catch。
    return Promise.resolve().then(function () { return subs.listChildren(sid, signal) }).then(function (kids) {
      var out = []
      var list = Array.isArray(kids) ? kids : []
      for (var i = 0; i < list.length; i++) {
        var c = list[i]; if (!c) continue
        var cid = String(c.sessionId || c.id || '')
        if (!cid) continue
        out.push({ sessionId: cid, id: cid, label: String(c.label || c.title || c.mode || '') })
      }
      return out
    })
  }
  if (subs && typeof subs.listDescendants === 'function') {
    // rc.5 持久 catalog 主源：不加载/复活 Agent，agents.list 漏掉的冷子会话也能列出。
    // 服务会递归返回整树，必须在统一出口只保留本 sid 的直接 child；异常原样转 rejection 透传。
    return Promise.resolve().then(function () { return subs.listDescendants(sid, signal) }).then(function (rows) {
      var out = []
      var list = Array.isArray(rows) ? rows : []
      for (var i = 0; i < list.length; i++) {
        var c = list[i]
        if (!c || c.kind !== 'child' || c.depth !== 1) continue
        if (String(c.parentId || '') !== String(sid)) continue
        var cid = String(c.sessionId || c.id || '')
        if (!cid) continue
        out.push({ sessionId: cid, id: cid, label: String(c.label || c.title || c.mode || '') })
      }
      return out
    })
  }
  var ag = (ctx && ctx.agents) || null
  if (ag && typeof ag.list === 'function') {
    // agents.list 活体回退：全表 + header 过滤。查询本身同步（list 是同步 registry 读），
    // 包 Promise 只为统一消费面；list() 抛错转 rejection 透传——四个消费点都有既有 catch
    // （跳过/可见化），不在这里吞错。
    return Promise.resolve().then(function () {
      var all = ag.list() || []
      var out = []
      for (var i = 0; i < all.length; i++) {
        var a = all[i]; if (!a) continue
        var h = a.session && a.session.header
        if (!h || h.origin !== 'subagent') continue
        if (String(h.parentSession || '') !== String(sid)) continue
        var cid = String(a.id || h.id || '')
        if (!cid) continue
        out.push({ sessionId: cid, id: cid, label: String(a.label || a.name || '') })
      }
      return out
    })
  }
  return null
}

export function createSession(ctx, state) {
    // 共享状态别名（本体由 index.mjs apply 统一构建并逐模块注入）
    var knownSessions = state.knownSessions
    var feedbackCache = state.feedbackCache
    var epicSplitCache = state.epicSplitCache
    var activeRuns = state.activeRuns
    var dispatchedEver = state.dispatchedEver

    // ===== 工具函数 =====
    function getActorId() { const a = ctx.agents; if (a) { const i = a.currentInitiator(); if (i) return String(i.id) } return 'unknown' }
    // ===== 根 agent 判定（rc.5 契约迁移，task-mwqu2k7p；fork 误拒修复 task-mwqu2mmq）=====
    // 宿主 0.2.2-rc.5 的 agents 服务移除 roots()/isOwnedBy()，只余 list()/get()。
    // 不能只看 parentSession：主会话 fork/seed 也有父 id（delegationDepth=0），真正子代理则带
    // origin='subagent'（通常 depth≥1）。统一走 isRootSessionHeader，与 rpc/store 的持久判根同源。
    function isRootAgent(a) { return !!(a && isRootSessionHeader(a.session && a.session.header)) }
    function rootIdsOf(agentsSvc) { var s = {}; try { var all = agentsSvc.list() || []; for (var i = 0; i < all.length; i++) { if (isRootAgent(all[i])) s[String(all[i].id)] = true } } catch (_) {} return s }
    function parentSessionOf(agentsSvc, sid) { try { var a = agentsSvc.get(sid); var h = a && a.session && a.session.header; return isRootSessionHeader(h) ? '' : String(h.parentSession || '') } catch (_) { return '' } }
    // resolveRoot 是同步热点（每个工具守卫/RPC/prompt 组装都调），agent 注册表可能有几百个子代理，
    // 每次调用全表扫描会反复卡宿主事件循环 → memoize 10s TTL。
    // 父子归属在一个 agent 存活期内不变，10s 过期窗口足够安全。
    var _rootCache = {}
    function resolveRootUncached(sid) { const agentsSvc = ctx.agents; if (!agentsSvc) return sid; var cur = sid; var visited = {}; while (!visited[cur]) { visited[cur] = true; var p = parentSessionOf(agentsSvc, cur); if (!p) return cur; cur = p } return cur }
    function resolveRoot(sid) {
      var now = Date.now()
      var c = _rootCache[sid]
      if (c && now - c.at < 10000) return c.root
      var r = resolveRootUncached(sid)
      // 缓存上限：超 512 个 key 时清掉过期项，防长进程累积
      var keys = Object.keys(_rootCache)
      if (keys.length > 512) { for (var i = 0; i < keys.length; i++) { if (now - _rootCache[keys[i]].at >= 10000) delete _rootCache[keys[i]] } }
      _rootCache[sid] = { root: r, at: now }
      return r
    }
    function toolSessionId() { var sid = resolveRoot(getActorId()); touchSession(sid); return sid }
    function rpcSessionId(args) { var sid = (args && typeof args.sessionId === 'string' && args.sessionId.length > 0) ? args.sessionId : resolveRoot(getActorId()); touchSession(sid); return sid }
    // 已知会话集合：心跳驱动这些会话的 poolCycle（摆脱对客户端轮询的依赖）
    // 带 TTL 淘汰：>30 分钟无活跃的会话从心跳中移除，避免长期运行后空转 poolCycle
    // 不完整短 id 不注册（幻影板防线 task-muuf0o7a）：短 id 板永远匹配不到活 root，
    // 进心跳集合只会让 poolCycle 每 15s 空转刷屏——在注册口直接拦住。
    function touchSession(sid) { if (sid && typeof sid === 'string' && sid !== 'unknown' && isFullSessionId(sid)) knownSessions[sid] = Date.now() }
    // teamMode 缓存：由 rt() 同步，供 systemPrompt 动态引导段读取（v65）
    // feedbackEnabled 缓存（学习飞轮 v1）：同样由 rt() 同步——systemPrompt 的组装是同步函数，
    // 不能在里面读文件。与 teamModeCache 同源同生命周期（引导段本来就要 teamMode 命中才渲染）。
    function feedbackOn(sid) { return feedbackCache[sid] !== false }
    // 史诗拆分总开关缓存（epicSplit，缺省 true）：与 feedbackCache 同源同生命周期——Team 提示词组装是同步
    // 函数，只能读缓存；由 rt() 每次读盘同步、set-board-config 写入时当场更新。缺键=开（老看板字段由
    // normalizeBoard 补 true，未落盘前也不会误判为关）。
    function epicSplitOn(sid) { return epicSplitCache[sid] !== false }
    // 工作模式三档收敛（UI 一维化）：内部仍存 boardMode+teamMode 两个 flag（老数据/老 RPC 无损），
    // workMode 是纯派生字段——由两 flag 算出，不落盘（normalizeBoard 无需改动）。
    //   'team' → boardMode=auto + teamMode=true（主窗口当调度员：默认草稿 + 裁决歧义）
    //   'auto' → boardMode=auto + teamMode=false（即建即派给 Worker）
    //   'list' → boardMode=manual + teamMode=false（看板=TODO 列表，手动 claim 或逐张派发）
    function deriveWorkMode(d) { return (d && d.teamMode) ? 'team' : ((d && d.boardMode) === 'auto' ? 'auto' : 'list') }

    // 按会话找 root agent（静态插件挂 host 层后多会话共存，不能"取第一个"——会把 worker 挂到别的会话上）
    // rc.5 契约迁移：不再读 roots() 集，直接按 id 取活体并用 isRootSessionHeader 判根（兼容 fork/seed 主会话）。
    function rootForSession(sid) { var s = ctx.agents; if (!s) return undefined; var a = typeof s.get === 'function' ? s.get(sid) : undefined; return isRootAgent(a) ? a : undefined }

    function sessionCwd(sid) { try { var root = rootForSession(sid); var cwd = root && root.session && root.session.header && root.session.header.cwd; return (typeof cwd === 'string' && cwd) ? cwd : '' } catch (_) { return '' } }

    // 超时保护：run 挂死时走失败重试路径
    function withTimeout(promise, ms, label) { var timer = ctx.timer; if (!timer) return promise; return Promise.race([promise, timer.timeout(ms).then(function () { throw new Error(label + ' timeout ' + ms + 'ms') })]) }

    // 活跃 run 表 / 派发履历：容器本体在 state，这里只是访问器
    function runsFor(sid) { if (!activeRuns[sid]) activeRuns[sid] = {}; return activeRuns[sid] }
    function isDispatched(sid, id) { return !!(id && dispatchedEver[sid] && dispatchedEver[sid][id]) }

    return { getActorId: getActorId, resolveRoot: resolveRoot, toolSessionId: toolSessionId, rpcSessionId: rpcSessionId, touchSession: touchSession, rootForSession: rootForSession, sessionCwd: sessionCwd, deriveWorkMode: deriveWorkMode, feedbackOn: feedbackOn, epicSplitOn: epicSplitOn, withTimeout: withTimeout, runsFor: runsFor, isDispatched: isDispatched, isFullSessionId: isFullSessionId }
}
