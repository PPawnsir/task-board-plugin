// dsh-agent-board — 会话层（lib/session.mjs）
// createSession(ctx, state)：agent 归属解析（resolveRoot 10s 缓存）/ 工具与 RPC 的会话 id 归一 /
// 已知会话心跳集合 / 工作模式三档派生 / feedback 开关读取 / 按会话找 root agent / 会话工作区 /
// 通用超时包装 / 活跃 run 表与派发履历访问。共享状态全部经 state 显式注入（别名为本地 var）。
// 另出口纯函数 isFullSessionId（幻影板防线口径，rpc.mjs 直接 import 复用，与 policy.mjs 纯函数同例）。

// 完整会话 id 结构判定（防幻影板，task-muuf0o7a）：真实 root 会话 id 形如
// session-cc24eb5c-702c-...（长度 ≥20 且至少两个 '-'）；裸短 id（如 cc24eb5c——某次调用
// 传了截断短 id）不具备完整结构，用它建出的 tasks-<短id>.json 是幻影板：poolCycle 对它
// pickDispatch 成功却永远匹配不到活 root（真实 id 带 session- 前缀与后缀），每 15s 心跳
// console.error 刷屏。import- 前缀板（import-sess_df0837fa-...）是合法的导入会话板，放行。
export function isFullSessionId(sid) {
  if (!sid || typeof sid !== 'string') return false
  if (sid.indexOf('import-') === 0) return true // import- 前缀板合法，结构判断放行
  if (sid.length < 20) return false
  var first = sid.indexOf('-')
  return first > 0 && sid.indexOf('-', first + 1) > first
}

export function createSession(ctx, state) {
    // 共享状态别名（本体由 index.mjs apply 统一构建并逐模块注入）
    var knownSessions = state.knownSessions
    var feedbackCache = state.feedbackCache
    var activeRuns = state.activeRuns
    var dispatchedEver = state.dispatchedEver

    // ===== 工具函数 =====
    function getActorId() { const a = ctx.agents; if (a) { const i = a.currentInitiator(); if (i) return String(i.id) } return 'unknown' }
    // resolveRoot 是同步热点（每个工具守卫/RPC/prompt 组装都调），agent 注册表可能有几百个子代理，
    // 每次调用 roots()+list()+全表 isOwnedBy 扫描会反复卡宿主事件循环 → memoize 10s TTL。
    // 父子归属在一个 agent 存活期内不变，10s 过期窗口足够安全。
    var _rootCache = {}
    function resolveRootUncached(sid) { const agentsSvc = ctx.agents; if (!agentsSvc) return sid; var cur = sid; var roots = agentsSvc.roots(); var rids = []; for (var i = 0; i < roots.length; i++) rids.push(String(roots[i].id)); if (rids.indexOf(cur) >= 0) return cur; var all = agentsSvc.list(); var visited = {}; while (!visited[cur]) { visited[cur] = true; var o = null; for (var j = 0; j < all.length; j++) { if (agentsSvc.isOwnedBy(cur, all[j])) { o = all[j]; break } }; if (!o) break; cur = String(o.id); if (rids.indexOf(cur) >= 0) return cur }; return cur }
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
    // 工作模式三档收敛（UI 一维化）：内部仍存 boardMode+teamMode 两个 flag（老数据/老 RPC 无损），
    // workMode 是纯派生字段——由两 flag 算出，不落盘（normalizeBoard 无需改动）。
    //   'team' → boardMode=auto + teamMode=true（主窗口当调度员：默认草稿 + 裁决歧义）
    //   'auto' → boardMode=auto + teamMode=false（即建即派给 Worker）
    //   'list' → boardMode=manual + teamMode=false（看板=TODO 列表，手动 claim 或逐张派发）
    function deriveWorkMode(d) { return (d && d.teamMode) ? 'team' : ((d && d.boardMode) === 'auto' ? 'auto' : 'list') }

    // 按会话找 root agent（静态插件挂 host 层后多会话共存，不能"取第一个"——会把 worker 挂到别的会话上）
    function rootForSession(sid) { var s = ctx.agents; if (!s) return undefined; var r = s.roots(); for (var i = 0; i < r.length; i++) { if (String(r[i].id) === sid) return r[i] } return undefined }

    function sessionCwd(sid) { try { var root = rootForSession(sid); var cwd = root && root.session && root.session.header && root.session.header.cwd; return (typeof cwd === 'string' && cwd) ? cwd : '' } catch (_) { return '' } }

    // 超时保护：run 挂死时走失败重试路径
    function withTimeout(promise, ms, label) { var timer = ctx.timer; if (!timer) return promise; return Promise.race([promise, timer.timeout(ms).then(function () { throw new Error(label + ' timeout ' + ms + 'ms') })]) }

    // 活跃 run 表 / 派发履历：容器本体在 state，这里只是访问器
    function runsFor(sid) { if (!activeRuns[sid]) activeRuns[sid] = {}; return activeRuns[sid] }
    function isDispatched(sid, id) { return !!(id && dispatchedEver[sid] && dispatchedEver[sid][id]) }

    return { getActorId: getActorId, resolveRoot: resolveRoot, toolSessionId: toolSessionId, rpcSessionId: rpcSessionId, touchSession: touchSession, rootForSession: rootForSession, sessionCwd: sessionCwd, deriveWorkMode: deriveWorkMode, feedbackOn: feedbackOn, withTimeout: withTimeout, runsFor: runsFor, isDispatched: isDispatched, isFullSessionId: isFullSessionId }
}
