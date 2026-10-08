// dsh-agent-board — 纯逻辑核心（lib/core.mjs）
// 不依赖任何 ctx/服务/IO：任务状态机、依赖校验、管线分类、prompt 构建、输出解析。
// index.mjs（IO 编排层）从这里 import；单元测试直接跑本文件（node --test）。
// 例外：boardDirName/boardHome 只做纯路径拼接（读 env，不碰磁盘），放在这里是为了让
// 「临时 HOME」可被自测注入——os.homedir() 进程内首次调用即缓存，晚改 env 无效。
import os from 'node:os'
import path from 'node:path'

// ===== 常量 =====
export const MAX_CLAIMED = 3
export const CLAIMABLE = ['pending', 'blocked']
export const PRIO_RANK = { critical: 4, high: 3, medium: 2, low: 1 }

// ===== 任务数据工具 =====
export function ah(t, f, to, ac, n) { if (!Array.isArray(t.history)) t.history = []; t.history.push({ from: f, to: to, timestamp: new Date().toISOString(), actor: ac, note: n || '' }) }
export function isb(t) { return t.parentId != null }
export function gsb(p, a) { return a.filter(function (x) { return x.parentId === p }) }
export function gpt(t, a) { return isb(t) ? a.find(function (x) { return x.id === t.parentId }) : undefined }
export function vt(d) { return d && typeof d === 'object' && Array.isArray(d.tasks) }

// ===== touches 文件级排他（glob 最小匹配器，零依赖）=====
// 背景：并行 Worker 改同一批文件会互踩（diff 冲突/一方覆盖另一方）。任务可声明
// touches: string[]（glob），派发器发现与「持锁任务的 touches」冲突
// 则本轮跳过该候选（记入 pickDispatch 返回的 blockedTouches），等锁释放再派。
// 持锁口径见 holdsFiles（in-progress + claimedBy / verifying 持锁；resolved/cancelled/archived 即放）。
// 语义（宁可偏严不可漏拦）：
//   1. 先归一化：\ → /、去 './' 前缀、去尾部 '/'；空串或非字符串忽略。
//   2. a === b 视为冲突。
//   3. 'dir/**' 目录前缀覆盖（含两侧都 /** 时前缀互相包含）；`*` 只当通配符处理，
//      不做通用 glob 展开——最小实现，够用且不会误判。
//   4. '*.ext' 后缀：两侧都是 '*.ext' 比扩展名；一侧是具体路径看 endsWith('/'+glob)
//      或本身 endsWith。
//   5. 裸文件名（无 '/' 且非 '*.ext'）只在「另一侧也是裸名」时比 basename 相等；
//      含 '/' 的具体路径不参与裸名规则（否则 'a/core.mjs' 会误撞裸名 'core.mjs'）。
// 保守倾向：不确定即算冲突（误拦只是晚一轮派发，漏拦会让两个 Worker 互踩）。
export function normTouch(s) {
  var v = String(s).replace(/\\/g, '/').trim()
  while (v.slice(0, 2) === './') v = v.slice(2)
  while (v.length > 1 && v.charAt(v.length - 1) === '/') v = v.slice(0, -1)
  return v
}
function baseOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1) }
function isStarDot(p) { return p.length > 2 && p.indexOf('*') === 0 && p.charAt(1) === '.' && p.indexOf('/') < 0 }
function dirLockPrefix(p) { return p.length > 3 && p.slice(-3) === '/**' ? p.slice(0, -2) : '' }
function matchOne(pattern, subject) {
  var p = normTouch(pattern), s = normTouch(subject)
  if (!p || !s) return false
  if (p === s) return true
  // 目录锁：'dir/**' 覆盖 dir 下的任意路径（两个方向都试，任一侧声明目录锁即锁定整棵子树）
  var pfx = dirLockPrefix(p); if (pfx && s.indexOf(pfx) === 0) return true
  var sfx = dirLockPrefix(s); if (sfx && p.indexOf(sfx) === 0) return true
  var ps = isStarDot(p), ss = isStarDot(s)
  if (ps && ss) return p === s // 两侧都是通配扩展名：只有完全相同才算（*.js vs *.ts 不冲突）
  if (ps) return s.length > p.length - 1 && s.slice(-(p.length - 1)) === p.slice(1)
  if (ss) return p.length > s.length - 1 && p.slice(-(s.length - 1)) === s.slice(1)
  // 含 '/' 的具体路径：一侧是另一侧目录下的文件即冲突（src/lib 覆盖 src/lib/core.mjs）
  if (p.indexOf('/') >= 0 || s.indexOf('/') >= 0) return s.indexOf(p + '/') === 0 || p.indexOf(s + '/') === 0
  return baseOf(p) === baseOf(s)
}
// 两组 glob 是否可能命中同一批文件（对称判定）
export function patOverlap(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; return matchOne(a, b) || matchOne(b, a) }
// 已声明 touches 的任务集合是否与本任务声明的 touches 冲突
export function overlapsTouches(mine, theirs) {
  var m = Array.isArray(mine) ? mine : []
  var th = Array.isArray(theirs) ? theirs : []
  for (var i = 0; i < m.length; i++) { for (var j = 0; j < th.length; j++) { if (patOverlap(m[i], th[j])) return true } }
  return false
}

// ===== 依赖校验（#18）=====
// 存在性 + 自引用 + DFS 环检测；返回错误消息或 null
export function validateDeps(d, taskId, deps) {
  if (!Array.isArray(deps)) return 'dependsOn must be array'
  for (var i = 0; i < deps.length; i++) {
    var dep = deps[i]
    if (dep === taskId) return 'self-dependency: ' + dep
    if (!d.tasks.find(function (x) { return x.id === dep })) return 'dependency not found: ' + dep
  }
  var visited = {}
  function reaches(cur) {
    if (cur === taskId) return true
    if (visited[cur]) return false
    visited[cur] = true
    var ct = d.tasks.find(function (x) { return x.id === cur })
    var cd = (ct && Array.isArray(ct.dependsOn)) ? ct.dependsOn : []
    for (var k = 0; k < cd.length; k++) { if (reaches(cd[k])) return true }
    return false
  }
  for (var j = 0; j < deps.length; j++) { if (reaches(deps[j])) return 'circular dependency via: ' + deps[j] }
  return null
}
// 依赖全部满足（resolved/archived 视为满足）
export function depsSatisfied(d, t) {
  if (!Array.isArray(t.dependsOn) || t.dependsOn.length === 0) return true
  return t.dependsOn.every(function (id) { var x = d.tasks.find(function (y) { return y.id === id }); return x && (x.status === 'resolved' || x.status === 'archived') })
}
// 依赖被永久阻断（依赖已 cancelled）
export function depsCancelled(d, t) {
  if (!Array.isArray(t.dependsOn) || t.dependsOn.length === 0) return false
  return t.dependsOn.some(function (id) { var x = d.tasks.find(function (y) { return y.id === id }); return x && x.status === 'cancelled' })
}

// ===== 管线分类（#19）：规则先行，兜底 full（宁严勿漏）=====
export function classifyPipeline(t) {
  if (t.acceptance && String(t.acceptance).trim()) return 'full'
  var text = ((t.title || '') + ' ' + (t.description || '')).toLowerCase()
  if (/解释|为什么|是什么|区别|对比|说明一下|是什么意思|how to|what is|why /.test(text)) return 'direct'
  if (/文档|调研|整理|总结|报告|指南|白皮书|readme|分析文/.test(text)) return 'work'
  return 'full'
}

// ===== 配置（一次性派发模型：max*=并发上限；min* 字段保留仅为兼容旧看板文件，引擎不使用）=====
// 两级超时：软超时（默认 30min）只上报主窗口提醒，不杀 run；硬超时（默认 120min）才兜底
// dispose 释放并发位——人在线时由人决策，人不在时系统兜底。
// feedbackEnabled（学习飞轮 v1 总开关，默认开）：关掉后不生成候选教训、prompt 不提软召回、
// 详情页沉淀按钮不渲染。老看板文件没有该字段 → 默认 true（normalizeBoard 补齐）。
// 回执开关（设置区「通知」小节，双布尔，缺省 true = 现状不变）：
//   notifyDispatch=false → 派发回执（任务被 Worker/Verifier 领走时播报）不入聚合队列；
//   notifyDone=false     → 完成回执（任务完成/阻塞时聚合播报）不入聚合队列。
// 只闸「回执」两条入口；歧义裁决通知（notifyMainWindow）是裁决通道不是回执，不接入开关。
// 史诗拆分总开关 epicSplit（入池配置弹层「功能」小节，缺省 true = 现状不变）：**只关引导，不禁机制**——
//   false → ① Team 提示词第 6 条 TEAM_SPLIT_RULE 整条不注入（policy.splitRuleOf）；② create-task RPC 与
//           task_create 工具的返回体不再附 suggestSplit 软提示（policy.withSplitHint 第三参门禁）。
//   机制照常：显式传 parentId 建子卡、史诗自动收口（checkParentAuto）、hooks 状态机都不看这个开关——
//   用户/主窗口明确要拆的时候不受阻（关的是"主动劝你拆"，不是"不许你拆"）。
// 边界：task_create 工具描述里的 TASK_SIZE_CONTRACT 是**静态工具契约**（工具定义会快照进 request header，
//   dsh-session 校验 description 必须是 string），没有按板动态能力，因此不随本开关走——这也是「关引导」
//   只覆盖两处**动态引导**（Team 提示词条款 + suggestSplit 软提示）的原因。
// Worker 可续跑开关 workerContinuable（task-muw5gnhv，缺省 true = 新行为即默认）：门禁**只在
//   dispatch.spawnOneShot 的 Worker 分支**生效——true 走 subagents.startContinuable（rec 持 childId，
//   turn 结算靠 host 事件 agent/status running→idle），false 逐字回退旧的 subagents.start() 一次性路径
//   （run.result 结算）。Verifier/hook run 一律照旧 one-shot，不看这个键（它们无续跑语义）。
//   消费点只有派发引擎（spawn 时读一次 cfg 快照），所以不需要 feedbackEnabled/epicSplit 那样的热路径缓存。
// Verifier 自测指南开关 verifyUserGuide（设置区「通知」小节旁「验收」小节，缺省 true）：
//   false → ① Verifier prompt 不拼 USER_GUIDE_CONTRACT 指南段（省 token）；
//           ② 验收落账（settleVerifier/board_verdict）不挂 t.verification.userTest；
//           ③ client 详情页自测指南块与报告「本版自测清单」段整块不渲染。
//   消费点同为 spawn/结算时读 cfg 快照，无需热路径缓存。
export function cfg(d) {
  var soft = Math.max(1, Math.min(480, d.softTimeoutMin || 30))
  var hard = Math.max(soft, Math.min(1440, d.hardTimeoutMin || 120))
  return { minWorkers: Math.max(0, Math.min(10, d.minWorkers || 1)), maxWorkers: Math.max(1, Math.min(10, d.maxWorkers || 3)), minVerifiers: Math.max(0, Math.min(5, d.minVerifiers || 0)), maxVerifiers: Math.max(0, Math.min(5, d.maxVerifiers || 2)), softTimeoutMin: soft, hardTimeoutMin: hard, feedbackEnabled: d.feedbackEnabled !== false, notifyDispatch: d.notifyDispatch !== false, notifyDone: d.notifyDone !== false, epicSplit: d.epicSplit !== false, workerContinuable: d.workerContinuable !== false, verifyUserGuide: d.verifyUserGuide !== false }
}

// ===== 看板数据目录（跨重启继承用）=====
// 单独抽成纯函数，是为了让「临时 HOME」可被测试注入：
// os.homedir() 在进程内**首次调用即缓存**，等到测试里再改 env 已经晚了（拿到的是真实家目录）；
// 每次调用都读一遍 env，才能让自测脚本用 temp 目录隔离真实看板（scripts/self-config-inherit.cjs）。
// 优先顺序与 Node 的 homedir 一致：HOME（类 Unix / 显式覆盖）→ USERPROFILE（Windows）→ os.homedir() 兜底。
export function boardDirName() { return (process.env.HOME || process.env.USERPROFILE || os.homedir() || '.') }
export function boardHome() { return path.join(boardDirName(), '.dsh') }

// ===== 看板文件种子 =====
// poolStatus 必须始终在种子/归一化里存在：task_list 工具输出 poolStatus: d.poolStatus，
// 缺字段 = undefined → 工具结果的 lossless-JSON 校验会拒（"value is not lossless JSON"）
// ownerCwd（跨重启继承）：创建该看板的会话工作区路径，继承判定全靠它——取不到就省略字段
// （绝不落空串，否则「路径读不到的多个会话」会被误判成同一工作区）。
export function seed(sid, ownerCwd) {
  var d = { version: 12, ownerSession: sid, boardMode: 'auto', teamMode: false, feedbackEnabled: true, notifyDispatch: true, notifyDone: true, epicSplit: true, workerContinuable: true, verifyUserGuide: true, minWorkers: 1, maxWorkers: 3, minVerifiers: 0, maxVerifiers: 2, workerModel: '', verifierModel: '', softTimeoutMin: 30, hardTimeoutMin: 120, poolStatus: { workers: [], verifiers: [] }, tasks: [] }
  if (typeof ownerCwd === 'string' && ownerCwd) d.ownerCwd = ownerCwd
  return d
}
// 旧文件缺 poolStatus 的归一化（读路径兜底，保证任何历史文件都满足工具输出契约）
// touches 兼容：老任务没有该字段照常（这里只把「存在但非数组」的脏值收敛成数组，
// 避免 holdsFiles/touchesConflict 里 Array.isArray 判定之外还有第三种形态）
// feedbackEnabled 兼容：老看板没有该字段（或落了脏值）一律补 true——默认开，行为与 v1 之前一致。
// notifyDispatch/notifyDone（回执开关）同法：老看板文件没有该字段 → 补 true，缺省开 = 现状不变。
// epicSplit（史诗拆分总开关）同法：老看板没有该字段（或脏值）→ 补 true，缺省开 = 引导照旧。
// workerContinuable（Worker 可续跑开关）同法：老看板没有该字段（或脏值）→ 补 true，
// 即老看板读进来就按新行为（可续跑 Worker）派发；显式落 false 才是逐字回退旧一次性路径。
// verifyUserGuide（Verifier 自测指南开关）同法：老看板没有该字段（或脏值）→ 补 true，缺省开 = 指南照常。
export function normalizeBoard(d) {
  if (d && typeof d === 'object') {
    if (!d.poolStatus || typeof d.poolStatus !== 'object' || !Array.isArray(d.poolStatus.workers) || !Array.isArray(d.poolStatus.verifiers)) d.poolStatus = { workers: [], verifiers: [] }
    if (typeof d.feedbackEnabled !== 'boolean') d.feedbackEnabled = true
    if (typeof d.notifyDispatch !== 'boolean') d.notifyDispatch = true
    if (typeof d.notifyDone !== 'boolean') d.notifyDone = true
    if (typeof d.epicSplit !== 'boolean') d.epicSplit = true
    if (typeof d.workerContinuable !== 'boolean') d.workerContinuable = true
    if (typeof d.verifyUserGuide !== 'boolean') d.verifyUserGuide = true
    if (Array.isArray(d.tasks)) {
      for (var i = 0; i < d.tasks.length; i++) {
        var t = d.tasks[i]
        if (t && t.touches !== undefined && !Array.isArray(t.touches)) t.touches = []
      }
    }
  }
  return d
}

// ===== 状态流转 =====
export function claimCheck(d, t, sid) { if (CLAIMABLE.indexOf(t.status) < 0) return 'cannot claim in ' + t.status; if (t.claimedBy && t.claimedBy !== sid && t.status === 'in-progress') return 'claimed by ' + t.claimedBy; if (d.boardMode === 'manual' || t.assignMode === 'manual') { if (t.assignee && t.assignee !== sid) return 'assigned to ' + t.assignee }; if (isb(t)) { var p = gpt(t, d.tasks); if (!p) return 'parent not found'; if (p.status !== 'in-progress' && p.status !== 'verifying') return 'parent not in-progress' }; var mc = d.tasks.filter(function (x) { return x.claimedBy === sid && (x.status === 'in-progress' || x.status === 'verifying') && !isb(x) }); if (!isb(t) && mc.length >= MAX_CLAIMED) return 'max ' + MAX_CLAIMED + ' active'; return null }
export function claimApply(d, t, sid, note) { var ps = t.status; t.status = 'in-progress'; t.claimedBy = sid; t.claimedAt = new Date().toISOString(); ah(t, ps, 'in-progress', sid, note) }
// 子任务「已了结」终态口径：resolved（已完成/已验收）+ cancelled（人主动放弃该子任务范围）
// + archived（归档=人的显式了结，与 childStats 进度口径同源）。
// 为什么 cancelled 也算：cancelled 是人的显式决定，该子任务范围已关闭；若不算，一张被取消的
// 子任务会把 epic 永久钉在 in-progress（手动取消的卡反而制造死卡）。验收时人仍可在 epic 上驳回。
// 为什么 archived 也算（反馈 n-muw706h1uymy 实证修）：旧口径「归档不算」会在「resolve 一张归档
// 一张」的交错序列下制造死卡——末子卡 resolve 时兄卡已归档，终态集永远凑不齐，epic 永久卡
// in-progress（真实盘面：childStats 3/3 settled，父卡停在 in-progress）。归档动作本身即人的显式
// 了结（archiveErr 门禁只放行 resolved/cancelled/无活跃 run 的僵尸卡），计入终态集语义成立。
// 安全性：父卡归档级联子卡时父卡已是 archived（非 in-progress），maybeAutoCloseParent 第一道
// 状态闸门即拦，级联不会反向误推动父卡。
export function isChildSettled(t) { return !!t && (t.status === 'resolved' || t.status === 'cancelled' || t.status === 'archived') }
// 史诗父卡自动收口（共享 helper，唯一判定口径）：父卡存在、父卡 in-progress、且全部子任务 ∈ 终态完成集
// → 父卡转 verifying（交人验收）。幂等：父卡已 verifying/resolved/archived 一律返回 null，重复调用无副作用。
export function maybeAutoCloseParent(d, childTask) {
  if (!d || !childTask || !isb(childTask)) return null
  var p = gpt(childTask, d.tasks)
  if (!p || p.status !== 'in-progress') return null
  var s = gsb(p.id, d.tasks)
  if (!s.length || !s.every(function (x) { return isChildSettled(x) })) return null
  // ===== post 延迟 verifying（hooks=agent run 接线③）=====
  // epic 声明了 post hook 且尚未收口（state !== 'done'）→ 不直接转 verifying，先挂 post 闸门：
  //   state='idle'    → 本轮不转 verifying，只置 running 等 poolCycle 补 spawn hook-post run
  //                     （core 保持纯函数：只落状态 + 返回父卡，spawn 由 dispatch 侧做）
  //   state='running' → 已在收口途中，poolCycle 会补 spawn（idle 与 running 同分支，二者共用
  //                     hook-post 幂等占用标记 hooks.post.pending）
  //   state='failed'  → 收口失败已 blocked 等人裁决，绝不自动收口（回归安静态，避免每轮重复触发）
  // 未声明/未启用 post → 直接转 verifying（既有行为逐字不变），并清掉可能残留的待跑标记。
  if (hookOn(p, 'post')) {
    var pst = hookState(p, 'post')
    if (pst === 'failed') return null
    if (pst !== 'done') {
      p.hooks.post.pending = true // hook-post 幂等占用标记：poolCycle 见它才 spawn（spawn 后清除，失败再置回）
      p.hooks.post.state = 'running'
      ah(p, p.status, p.status, 'system', 'auto: all subtasks settled，post hook 收口未完成，延迟 verifying')
      return p
    }
  }
  if (p.hooks && p.hooks.post && p.hooks.post.pending) delete p.hooks.post.pending
  p.status = 'verifying'
  p.resolvedAt = new Date().toISOString()
  p.resolution = 'all subtasks resolved'
  ah(p, 'in-progress', 'verifying', 'system', 'auto: all subtasks resolved')
  return p
}
// 兼容名：既有调用点（verifyApply）与 TEAM_SPLIT_RULE / README 的对外语义名保持不变，内部委托共享 helper。
export function checkParentAuto(d, t) { return maybeAutoCloseParent(d, t) }
export function resolveApply(d, t, sid, status, resolution, note) { var ps = t.status; if (status === 'verifying' && t.pipeline && t.pipeline !== 'full') { status = 'resolved' } t.status = status; t.resolution = resolution || null; t.resolvedAt = new Date().toISOString(); ah(t, ps, status, sid, note); var r = { ok: true, task: t }; var p = maybeAutoCloseParent(d, t); if (p) { r.parentUpdated = true }; return r }
export function verifyApply(d, t, sid, verdict, comment) { var ps = t.status; if (verdict === 'approved') { t.status = 'resolved'; t.verifiedAt = new Date().toISOString(); t.verifiedBy = sid; delete t.frozen; delete t.frozenAt; delete t.frozenBy; ah(t, ps, 'resolved', sid, 'approved' + (comment ? ': ' + comment : '')) } else { t.status = 'in-progress'; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'in-progress', sid, 'rejected' + (comment ? ': ' + comment : '')) }; var r = { ok: true, task: t }; if (verdict === 'approved' && isb(t)) { var p = checkParentAuto(d, t); if (p) { r.parentUpdated = true } }; return r }
// 归档落定（task_archive 工具与 archive-task RPC 共享，单一行为口径；门禁 archiveErr 留在
// rpc.mjs——活性判定依赖 index.mjs 注入的 hasActiveRun，core 保持纯函数）：置 archived +
// 级联归档子卡 + 触发父卡自动收口。
// 父卡检查是本路径的必挂钩子（反馈 n-muw706h1uymy 根因②）：旧实现归档后不查父卡，
// 「末子卡归档」这一下永远补不上收口——isChildSettled 计入 archived 后，本钩子是交错
// resolve+archive 序列与僵尸子卡直接出清（v1.7.1 放行面）两条链路的最后保险。
// 父卡带 post hook 时 maybeAutoCloseParent 内部照旧只挂闸门（pending+running），不直接转
// verifying——hooks 语义逐字不变。note 由调用方给（工具 'archived' / RPC 'manual archive'）。
export function archiveApply(d, t, actor, note) {
  var ps = t.status
  t.status = 'archived'
  t.archivedAt = new Date().toISOString()
  ah(t, ps, 'archived', actor, note || 'archived')
  var ca = 0
  gsb(t.id, d.tasks).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } })
  var r = { ok: true, task: t }
  if (ca) r.childrenArchived = ca
  var p = maybeAutoCloseParent(d, t) // 归档路径同样触发父卡自动收口（isChildSettled 已计 archived）
  if (p) r.parentUpdated = true
  return r
}

// ===== 史诗 hooks=agent run（宿主生命周期接线）=====
// 定位：hook 点 = 一次**真实 agent 运行**（不是声明式命令、不走 shell），挂在 epic 卡上、
// 由派发周期 spawn 成一次性子代理 run（role 'hook-pre' / 'hook-post'），run 结算把 state 推进。
// 数据形态（写在卡上，重启可恢复——state 机不靠内存）：
//   epic.hooks = { pre: { enabled, prompt, state: 'idle'|'running'|'done'|'failed', runId }, post: 同构 }
// 三条红线：
//   ① 点位可选——epic 未声明 hooks 时全链路零变化（pickDispatch / maybeAutoCloseParent / poolCycle
//      都只在 hooks 存在且 enabled 时才进入分支，老 epic 行为逐字不变）；
//   ② 薄框架——prompt 只给契约与上下文，做什么由 hook agent 自行决策，吃不准就歧义上报；
//   ③ commit/push 不进任何默认形态——默认文案明确写「不要默认提交/推送」，收口动作全由 agent 自己判断。
export var HOOK_PHASES = ['pre', 'post']
export var HOOK_STATES = ['idle', 'running', 'done', 'failed']
// 建卡/更新卡的 hooks 浅校验（工具 task_create/task_update 与 RPC create-task/update-task 共用同一口径）。
// 口径：只认 { pre?, post? } 两键；每项 { enabled?:bool, prompt?:string, state?:enum, runId?:string }；
// prompt 非空字符串（≤4000，超长截断）；state/runId 允许传（重启后人工恢复现场）；未知键忽略、不报错。
// 返回 { hooks } 或 { error }——调用方把 error 原样回给主窗口（宁早报错，别静默存下一坨跑不起来的配置）。
export function normalizeHooks(input) {
  if (input === null) return { hooks: null }
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'hooks 必须是对象（{ pre?, post? }）' }
  var out = {}
  var dels = []
  for (var i = 0; i < HOOK_PHASES.length; i++) {
    var ph = HOOK_PHASES[i]
    var raw = input[ph]
    if (raw === undefined) continue
    // 显式 null = 撤掉该点位（un-declare）。它必须原样穿到 mergeHooks——否则「只撤 pre」的意图会在
    // 归一化阶段被吃掉，task_update hooks:{pre:null} 变成空操作（实测踩过）。
    if (raw === null) { dels.push(ph); out[ph] = null; continue }
    if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'hooks.' + ph + ' 必须是对象' }
    var h = { enabled: raw.enabled === undefined ? true : !!raw.enabled, prompt: '', state: 'idle', runId: null }
    if (raw.prompt !== undefined) {
      if (typeof raw.prompt !== 'string') return { error: 'hooks.' + ph + '.prompt 必须是字符串' }
      h.prompt = raw.prompt.slice(0, 4000)
    }
    if (!String(h.prompt).trim()) return { error: 'hooks.' + ph + '.prompt 不能为空（薄框架只给契约，契约本体由主窗口写）' }
    if (raw.state !== undefined) {
      if (HOOK_STATES.indexOf(raw.state) < 0) return { error: 'hooks.' + ph + '.state 必须是 ' + HOOK_STATES.join('/') }
      h.state = raw.state
    }
    if (raw.runId !== undefined && raw.runId !== null) h.runId = String(raw.runId)
    // 内部机器标记（pending）原样穿过去：主窗口若为恢复现场整条重传 pre，不该把待跑标记洗掉
    if (raw.pending) h.pending = true
    out[ph] = h
  }
  // 只有「纯删除」时才返回仅含 null 的对象；有真实点位时把 null 一并带上（mergeHooks 逐点位处理）
  if (!dels.length) { var clean = {}; for (var j = 0; j < HOOK_PHASES.length; j++) { if (out[HOOK_PHASES[j]] && out[HOOK_PHASES[j]] !== null) clean[HOOK_PHASES[j]] = out[HOOK_PHASES[j]] } return { hooks: clean } }
  return { hooks: out }
}
// 已有 hooks 与本次提交的钩子做**浅合并**（task_update 只想改 prompt 时不必重复整条 pre/post）：
// 未提交的键保留原值；提交 null 表示删除该点位（un-declare）。
export function mergeHooks(prev, next) {
  var out = {}
  var base = (prev && typeof prev === 'object') ? prev : {}
  for (var i = 0; i < HOOK_PHASES.length; i++) {
    var ph = HOOK_PHASES[i]
    if (base[ph]) out[ph] = base[ph]
  }
  if (!next) return out
  for (var j = 0; j < HOOK_PHASES.length; j++) {
    var p2 = HOOK_PHASES[j]
    if (next[p2] === undefined) continue
    if (next[p2] === null) { delete out[p2]; continue }
    out[p2] = next[p2]
  }
  return out
}
// 该点位是否「已声明且启用」——pickDispatch 闸门与 poolCycle 触发共用的唯一判定口径
export function hookOn(owner, phase) { var h = owner && owner.hooks && owner.hooks[phase]; return !!(h && h.enabled) }
export function hookState(owner, phase) { var h = owner && owner.hooks && owner.hooks[phase]; return (h && h.state) || 'idle' }
// 状态机写入（唯一入口，保证 ah 留痕）：state 写在 epic 卡上（重启可恢复）。
export function hookSetState(p, phase, state, actor, note) {
  var h = p.hooks && p.hooks[phase]
  var from = (h && h.state) || 'idle'
  h.state = state
  ah(p, p.status, p.status, actor || 'system', 'hooks.' + phase + ': ' + from + ' → ' + state + (note ? '（' + note + '）' : ''))
  return h
}
// hook run 结算（纯函数，dispatch.settleHook 持锁段调用；抽出来是为了能单测状态机）：
//   ok=true   pre  → hooks.pre='done'（串行闸门打开，下轮起子任务正常派发）
//   ok=true   post → hooks.post='done' + epic 转 verifying（收口完成，交人验收）
//   ok=false  pre/post → 该点位 state='failed' + epic 转 blocked + escalation 挂卡（歧义上报：
//              重试/跳过/放弃，由主窗口裁决），绝不自动重试——故障 hook 反复重跑只会烧钱。
// 幂等：点位已 done、或 epic 已有未裁决 escalation 时返回 { already: true }，不覆盖不改状态。
export function applyHookSettle(d, epicId, phase, ok, output, runId, errText) {
  var p = d.tasks.find(function (x) { return x.id === epicId })
  if (!p) return null
  var h = (p.hooks && p.hooks[phase]) || null
  if (!h) return { task: p, already: true }
  if (h.state === 'done') return { task: p, already: true }
  if (p.escalation) { h.runId = null; delete h.pending; return { task: p, already: true } }
  h.runId = null
  delete h.pending
  if (!ok) {
    var why = String(errText || '').slice(0, 150) || '未给出有效结论'
    hookSetState(p, phase, 'failed', String(runId), 'hook run 失败')
    p.lastError = ('hooks.' + phase + ' run 失败: ' + why).slice(0, 300)
    p.escalation = {
      question: 'hooks.' + phase + '（' + (phase === 'pre' ? '前置准备' : '收口') + '）失败：' + why + '\n' +
        (output ? 'hook agent 输出（截断）：\n' + String(output).slice(0, 1200) + '\n' : '') +
        '请裁决：重试（把 hooks.' + phase + '.state 置回 idle 即可重跑）/ 跳过（置为 done 放行）/ 放弃（终止该史诗）。',
      at: new Date().toISOString(), by: String(runId),
    }
    if (!Array.isArray(p.messages)) p.messages = []
    p.messages.push({ kind: 'escalation', text: p.escalation.question, at: p.escalation.at, by: String(runId) })
    ah(p, p.status, 'blocked', String(runId), 'hooks.' + phase + ' 失败，待主窗口裁决（重试/跳过/放弃）')
    p.status = 'blocked'
    return { task: p, blocked: true }
  }
  hookSetState(p, phase, 'done', String(runId), 'hook run 完成')
  if (phase === 'post') {
    var from = p.status
    p.status = 'verifying'
    p.resolvedAt = new Date().toISOString()
    p.resolution = 'hooks.post settled'
    ah(p, from, 'verifying', 'system', 'auto: post hook 收口完成')
    return { task: p, closed: true }
  }
  return { task: p, preDone: true }
}
// ===== pre 串行闸门（纯函数，pickDispatch 过滤用）=====
// 语义：子任务候选命中派发前，先看它所在 epic 的前置 hook 是否已完成——
//   hooks.pre 未声明/未启用 → 放行（老 epic 零变化）
//   state='done'          → 放行（前置准备完成，下轮起子任务正常派发）
//   state='idle'          → **拦下**：本轮不派子任务，由 poolCycle 改 spawn hook-pre run（串行闸门）
//   state='running'       → 拦下：hook run 还在跑，跳过本轮（不重复 spawn）
//   state='failed'        → 拦下：已 blocked 等人裁决（重试/跳过/放弃），绝不自动放行
// 串行闸门语义 = 「一个 epic 的子任务在 pre hook 完成之前一张都不派」，天然并发安全。
export function preHookGate(epic) {
  if (!epic || !hookOn(epic, 'pre')) return { pass: true, reason: 'none' }
  var st = hookState(epic, 'pre')
  if (st === 'done') return { pass: true, reason: 'done' }
  return { pass: false, reason: st }
}

// ===== 史诗父卡语义层 =====
// 父卡自动流转：子任务被派发时（poolCycle 占位 claim 的 dispatch 分支调用），
// 若父卡 status 为 pending → 父卡转 in-progress（ah 记「首个子任务派发，史诗进入推进态」），
// 让史诗卡离开待办列、给出「正在推进」的列位置信号；同时打通既有 checkParentAuto
// （全子任务 resolved → 父 verifying 要求父卡在 in-progress，此前 pending 父卡永远到不了）。
// draft 父卡不动（草稿是刻意的人工态）；已在 in-progress/verifying 的不重放（返回 null）。
// 返回被推进的父卡（无 parentId / 父卡不存在 / 父卡非 pending → null）。
export function parentKickOnDispatch(d, t) { if (!isb(t)) return null; var p = gpt(t, d.tasks); if (!p || p.status !== 'pending') return null; p.status = 'in-progress'; ah(p, 'pending', 'in-progress', 'system', '首个子任务派发，史诗进入推进态'); return p }

// childStats 聚合（get-tasks 返回体字段，按 tasks 现算零存储）：
// { <parentId>: { total, settled, resolved, active, activeTitle } }
// 口径：total=该 parentId 的**全部**子任务数（**含已归档**）；settled=其中已了结数，分子口径
// settled = resolved | cancelled | archived；resolved=settled 的兼容别名（既有对外字段名，同值，
// 老前端/老断言按 resolved 读仍成立）；active=in-progress 数；activeTitle=第一个 in-progress
// 子任务标题（按看板顺序，无则空串）。active/activeTitle 口径不变：archived 永不算 active。
// 为什么归档必须计入（task-muupgfot）：归档=人已显式了结该卡；若把 archived 从 total/settled 里
// 一起排除，归档一张子卡会让史诗进度从 0/10「退化」成 0/9——分母无故缩水、分子永不前进，
// 正是用户报的「有子任务完成后史诗进度从 0/10 变 0/9」。进度只增不减是这条口径的红线。
// 近似说明：v1.7.1 起 archive-task 放行「无活跃 run 的 in-progress 僵尸卡」，故 archived 不再严格
// 等于「曾经完成」；但归档动作本身仍是人的显式了结，进度语义上计入是对的（僵尸出清场景里父卡
// 通常随之归档，不影响在板卡片的展示）。与 isChildSettled（父卡自动收口口径）现已同口径：
// archived 同样计入终态集（反馈 n-muw706h1uymy 修复——归档不入终态会让交错归档的 epic 永久
// 卡死）；进度展示与收口流转共用同一「了结」语义，展示 n/n settled 时父卡必已具备收口条件。
export function aggregateChildStats(tasks) {
  var out = {}
  var list = Array.isArray(tasks) ? tasks : []
  for (var i = 0; i < list.length; i++) {
    var t = list[i]
    if (!t || !isb(t)) continue
    var s = out[t.parentId] || (out[t.parentId] = { total: 0, settled: 0, resolved: 0, active: 0, activeTitle: '' })
    s.total++
    if (t.status === 'resolved' || t.status === 'cancelled' || t.status === 'archived') { s.settled++; s.resolved++ }
    if (t.status === 'in-progress') { s.active++; if (!s.activeTitle) s.activeTitle = String(t.title || '') }
  }
  return out
}

// ===== 输出解析（文本降级路径）=====
// parseSections: 解析 ## 分段输出为结构化字段（容错：无分段时返回空对象，调用方降级）
export function parseSections(text) {
  var out = {}
  if (!text) return out
  var re = /^##\s+(.+?)\s*$/gm, m, matches = []
  while ((m = re.exec(text))) matches.push({ title: m[1], idx: m.index, end: m.index + m[0].length })
  for (var i = 0; i < matches.length; i++) {
    var body = text.slice(matches[i].end, i + 1 < matches.length ? matches[i + 1].idx : text.length).trim()
    var title = matches[i].title
    if (/开发描述/.test(title)) out.summary = body
    else if (/改动/.test(title)) out.changes = body
    else if (/自测指南|用户自测/.test(title)) { var ut = parseUserTest(body); if (ut) out.userTest = ut } // 须在「自测」前：自测指南 ≠ 自测情况
    else if (/自测/.test(title)) out.selfTest = body
    else if (/diff|变更概要/i.test(title)) out.diff = body
    else if (/测试概要|验证概要|审查概要/.test(title)) out.verifySummary = body
    else if (/核对项|核验项|检查项/.test(title)) out.checks = body
  }
  return out
}
// ===== Verifier 自测指南（verifyUserGuide，task-muxyyvg0）=====
// userTest 四字段归一（工具通道 board_verdict 的参数 + 文本通道 parseUserTest 的出口共用）：
//   gist ≤300 / steps ≤12 条每条 ≤300 / expect ≤600；tier 只认 ui/metric/internal 三档，
//   非法/缺省一律归 internal（最保守档——宁可标「无用户可感知面」也不伪造可操作指引）。
// 四字段全空（gist/steps/expect 皆空）→ 返回 null（视为没交指南，不挂字段）。
export function normalizeUserTest(u) {
  if (!u || typeof u !== 'object') return null
  var tier = String(u.tier == null ? '' : u.tier).trim().toLowerCase().split(/[\s（(，,。|。.]/)[0]
  if (['ui', 'metric', 'internal'].indexOf(tier) < 0) tier = 'internal'
  var steps = []
  if (Array.isArray(u.steps)) { for (var i = 0; i < u.steps.length && steps.length < 12; i++) { var s = String(u.steps[i] == null ? '' : u.steps[i]).trim().slice(0, 300); if (s) steps.push(s) } }
  var out = { gist: String(u.gist == null ? '' : u.gist).trim().slice(0, 300), steps: steps, expect: String(u.expect == null ? '' : u.expect).trim().slice(0, 600), tier: tier }
  if (!out.gist && !out.steps.length && !out.expect) return null
  return out
}
// 「## 自测指南」段体 → userTest 四字段。字段锚：gist:/tier:/steps:/expect:
//（兼容中文别名 概要/分级/步骤/预期 与全角冒号；锚词允许前导列表符 `- gist:`）。
// steps: 行之后的列表行（-/*/+/1./1、/1)）逐条收集；其余续行并入当前字段文本。
export function parseUserTest(body) {
  if (!body) return null
  var raw = { gist: '', steps: [], expect: '', tier: '' }
  var field = null
  var lines = String(body).split('\n')
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i]
    var m = ln.match(/^\s*(?:[-*+]\s*)?(gist|概要|tier|分级|steps?|步骤|expect|预期)\s*[:：]\s*(.*)$/i)
    if (m) {
      var key = m[1].toLowerCase()
      var val = (m[2] || '').trim()
      if (key === 'gist' || key === '概要') { field = 'gist'; raw.gist = val }
      else if (key === 'tier' || key === '分级') { field = 'tier'; raw.tier = val }
      else if (key === 'step' || key === 'steps' || key === '步骤') { field = 'steps'; if (val) raw.steps.push(val) }
      else { field = 'expect'; raw.expect = val }
      continue
    }
    var sm = ln.match(/^\s*(?:[-*+]|\d+[.、)）])\s+(.+)$/)
    if (sm && field === 'steps') { raw.steps.push(sm[1].trim()); continue }
    var txt = ln.trim()
    if (!txt) continue
    if (field === 'gist') raw.gist += (raw.gist ? ' ' : '') + txt
    else if (field === 'expect') raw.expect += (raw.expect ? '\n' : '') + txt
    else if (field === 'steps' && raw.steps.length) raw.steps[raw.steps.length - 1] += ' ' + txt
  }
  return normalizeUserTest(raw)
}
// verifier 结论：行首锚定 APPROVED/REJECTED（输出中提到历史驳回字眼不应误判）；null = 无法判定
export function parseVerdict(output) { var m = (output || '').trim().match(/^[ \t>*#\-\s]*(APPROVED|REJECTED)\b/im); return m ? m[1].toUpperCase() : null }
// worker 歧义标记
export function isEscalation(output) { return /\[ESCALATE\]/i.test(output || '') }
// 从 run.result.output（ContentBlock[]）提取纯文本
export function outputText(res) { if (!res || !res.output) return ''; var parts = []; for (var i = 0; i < res.output.length; i++) { var b = res.output[i]; if (b && b.type === 'text' && b.text) parts.push(b.text) } return parts.join('\n') }

// ===== 学习飞轮 v1：候选教训信号（只产信号，不做存储）=====
// 设计红线（零耦合）：看板只把「候选教训」当作一条结构化的 messages 记录落盘（详情页可见），
// 绝不调用任何笔记/记忆工具的 API、不写任何外部文件、也不知道对方最终把教训存到哪。
// 沉淀动作由主窗口 agent 自己选择可用工具完成（push-lesson RPC 只负责把候选 followup 过去）。
// 触发点（两处都先过 feedbackEnabled 总开关）：Verifier 驳回、主窗口仲裁结论。
// 候选教训文本：三段式 markdown（场景 / 明细段… / 来源）；明细段每段截 300 字。
// parts = [[标签, 正文], ...]，如 [['错误做法', 驳回理由]] 或 [['疑问', q], ['裁决结论', a]]。
export function lessonText(scene, parts, source) {
  var lines = ['场景: ' + String(scene == null ? '' : scene).trim().slice(0, 200)]
  var list = Array.isArray(parts) ? parts : []
  for (var i = 0; i < list.length && i < 4; i++) {
    if (!list[i]) continue
    lines.push(String(list[i][0]) + ': ' + String(list[i][1] == null ? '' : list[i][1]).trim().slice(0, 300))
  }
  lines.push('来源: ' + String(source == null ? '' : source))
  return lines.join('\n')
}
// 往任务 messages 追一条候选教训（kind='lesson-candidate'）。轻量判重：同一 at 或正文前 80 字相同
// 即视为同一事件（同一驳回/裁决可能被工具通道与 run 结算两条路径各触发一次）→ 不重复落。
// 返回 true = 本次新落一条（调用方据此决定要不要提示 UI/主窗口）。
export function pushLesson(t, text, at, by) {
  if (!t || !text) return false
  if (!Array.isArray(t.messages)) t.messages = []
  var stamp = at || new Date().toISOString()
  var head = String(text).slice(0, 80)
  for (var i = 0; i < t.messages.length; i++) {
    var m = t.messages[i]
    if (!m || m.kind !== 'lesson-candidate') continue
    if (m.at === stamp || String(m.text || '').slice(0, 80) === head) return false
  }
  t.messages.push({ kind: 'lesson-candidate', text: String(text), at: stamp, by: by || 'system' })
  return true
}

// ===== 驳回包全量带回（task-muvg15p5）=====
// 问题实证：驳回信息此前只走 history（histNotes 每条截 300 字），board_verdict 工具通道更把
// checks（逐条核对证据 = 真正可执行的驳回细节）整段丢弃；手动驳回 comment 可为空、且不写
// t.verification → 重派 Worker 只拿到一句被截断的「rejected」，无从据此返工。
// 修法（零新通道）：三条驳回路径统一往 t.messages 追一条 kind='rejection' 的完整驳回包，
// buildMessages 会把 t.messages 全量拼进 Worker prompt（每条 2000 字，远超 history 的 300 字）。
// history 保持现状不动——它是审计轨，不是执行载荷。
// 文本口径：有 summary/checks 时「验收驳回 · <summary>」+「核对项：<checks>」；两者皆空（手动驳回
// 未填原因）时给一句可执行的兜底，而不是留一条空消息。
export function rejectionText(summary, checks) {
  var s = String(summary == null ? '' : summary).trim()
  var c = String(checks == null ? '' : checks).trim()
  if (!s && !c) return '（驳回方未填写原因，请先自查交付物与验收脚本差距）'
  return '验收驳回 · ' + s + (c ? '\n\n核对项：\n' + c : '')
}
// 往任务 messages 追一条完整驳回包（kind='rejection'）。轻量判重（与 pushLesson 同口径）：
// 同一 at 或正文前 80 字相同视为同一事件——文本结算路径在工具通道已处理时 already=true 会整段
// 跳过，判重是第二道保险，杜绝同一驳回双推。返回 true = 本次新落一条。
export function pushRejection(t, summary, checks, at, by) {
  if (!t) return false
  if (!Array.isArray(t.messages)) t.messages = []
  var stamp = at || new Date().toISOString()
  var text = rejectionText(summary, checks)
  var head = text.slice(0, 80)
  for (var i = 0; i < t.messages.length; i++) {
    var m = t.messages[i]
    if (!m || m.kind !== 'rejection') continue
    if (m.at === stamp || String(m.text || '').slice(0, 80) === head) return false
  }
  t.messages.push({ kind: 'rejection', text: text, at: stamp, by: by || 'system' })
  return true
}

// ===== 一次性子代理 prompt 构建（上下文由主窗口 agent 写入 description/instructions，系统只追加生命周期记录）=====
// 学习飞轮 v1 软召回引导（feedbackEnabled 开时才拼进 prompt）：环境里若有笔记/记忆类工具，先查历史教训再动手。
// 只是"提示先搜"——看板不代查、不调用任何记忆工具、也无从知道有没有这类工具（零耦合）。
export var LESSON_RECALL_HINT = '开工前如环境装有笔记/记忆类工具（如 note_search），先检索相关历史教训再动手。'
// 过程记录注入：驳回/裁决/干预 history + messages（裁决答案/干预指令/歧义原文）是系统管理的，必须带给子代理
export function histNotes(t) { return (t.history || []).filter(function (h) { return h.note && (/歧义|裁决|驳回|干预|rejected/i.test(h.note)) }).map(function (h) { return '- [' + h.timestamp + '] ' + String(h.note).slice(0, 300) }).join('\n') }
export function buildMessages(t) {
  if (!Array.isArray(t.messages) || t.messages.length === 0) return ''
  return t.messages.map(function (m) { return '### [' + (m.kind || 'note') + '] (' + (m.at || '') + ' by ' + (m.by || '') + ')\n' + String(m.text || '').slice(0, 2000) }).join('\n\n')
}
// 主窗口预研上下文段（瘦身分离形态，task-muvjs392）：**笔记全文 + 文件清单**，
// 由 host 组装后传入（core 保持纯函数不碰 IO）。文件内容本体不进 prompt——由 Worker 用 read 工具
// 按行号范围自取（执行时盘面，更新鲜），既免了大文件正文撑爆 prompt，也免了随 runtime 快照每轮重发
//（旧形态走 systemPrompt.context，自治 run 中实测 6×48.8K 字符≈白烧 75–100K token）。
// 注意：{{ }} 净化沿用「systemPrompt context 严格插值」时代的封闭变换（内容里 {{...}} 会直接抛异常
// 毁掉子代理的整个 prompt 组装）。通道虽已退役，净化是幂等纯变换且单测锁定口径，保留以防历史笔记复发。
// 教训：replace(/\{\{/g,'{ {') 是开变换——三连括号 {{{lo}}}（Python f-string）会得到
// "{ {{lo}}}"，替换结果自己又造出 {{。按"连 { 整 run 拆开"才是封闭变换。
function sanitizeCtx(s) { return String(s).replace(/\{+/g, function (m) { return m.length === 1 ? m : m.split('').join(' ') }) }
// contextFiles 条目写法：「路径[:L起[-L止]][ — 一句用途]」。
// 用途可选（缺省只给路径行号，不造新字段）：分隔符用「 — 」（em dash 带两侧空格，路径/锚点里不会出现）。
// 锚点按 parseAnchorPath 口径归一（a.js:L10-20 → a.js:L10-L20；非法锚点剥掉，不误导 Worker 去读空段）。
// 返回 { path: 清单展示串（含归一锚点）, file: 纯路径（存在性预检用，剥掉锚点与用途）, usage }。
export function parseContextFileEntry(entry) {
  var s = String(entry == null ? '' : entry).trim()
  var usage = ''
  var sep = s.indexOf(' — ')
  if (sep > 0) { usage = s.slice(sep + 3).trim(); s = s.slice(0, sep).trim() }
  var a = parseAnchorPath(s)
  var p = a.from != null ? (a.file + ':L' + a.from + (a.to != null ? '-L' + a.to : '')) : a.file
  return { path: p, file: a.file, usage: usage }
}
// 组装瘦身清单：笔记段（全文，调用方已按 8000 字符截断）+ 文件清单段（每行「路径:L行号 — 一句用途」）。
// files 收 { path, usage }（兼容裸字符串）；两者皆空 → 空串（调用方据此跳过注入，保持无清单 parity）。
export function buildContextPackSection(files, notes) {
  var parts = []
  if (notes && String(notes).trim()) parts.push('### 主窗口调研笔记（结论/思路/原始需求，直接采信）\n' + sanitizeCtx(String(notes)))
  var list = []
  if (Array.isArray(files)) {
    for (var i = 0; i < files.length; i++) {
      var f = files[i]
      var path = (typeof f === 'string') ? f : (f && f.path)
      if (!path) continue
      var line = '- ' + sanitizeCtx(path)
      if (f && typeof f === 'object' && f.usage) line += ' — ' + sanitizeCtx(f.usage)
      list.push(line)
    }
  }
  if (list.length) parts.push('### 调研文件清单（附带的调研文件清单请按需用 read 工具自行读取，不要全量盲读；给出行号的按行号范围读）\n' + list.join('\n'))
  return parts.length ? parts.join('\n\n') : ''
}

// ===== 上下文注入增强：锚点行段 + 截断结构索引（看板反馈 n-musaoirgsigo ①②④）=====
// 背景：contextFiles 注入大文件被 8KB 头部截断，目标代码段在中部/尾部，Worker 仍需全文盘点；
// 且只标"截断"二字，不知道截掉了什么、该补读哪里。
// 三个纯函数落在这里可单测；零依赖纯行正则，宁可漏检不可误切（不引 parser）。
// 【task-muvjs392 后现状】派发侧已改为「清单 + Worker 按需 read 自取」，host 不再读盘、不再切段/附索引：
// parseAnchorPath 仍在使用（清单条目归一，见 parseContextFileEntry）；sliceLines / buildFileOutline
// 暂留为纯工具（口径由单测锁定），不删以免丢历史行为证据、也备将来主窗口要行段预切时复用——宿主路径上已无调用点。
// 锚点行段长度上限（行）：超出截断到该上限并标记 capped
export var CONTEXT_SLICE_MAX_LINES = 400
// 结构索引条数上限：超出附一条省略标注
export var CONTEXT_OUTLINE_MAX = 40

// 锚点只认路径尾部的 :L<num>(-L?<num>)?（-L200 / -200 都收）。
// 正则锚定 $ 且要求 ":L" 前缀——Windows 盘符 "C:\" 的冒号在最前，绝不会误匹配。
var ANCHOR_TAIL = /:L(\d+)(?:-L?(\d+))?$/i
// 解析 'path:L2350-L2420' / 'path:L2350' 行段语法。
// 返回 {file, from, to}；无锚点 → {file: 原串, from: null, to: null}；
// 写法非法（:L0、:L5-L2 等）→ 剥掉锚点、from=null、invalidAnchor=true（调用方回退头部并标注）。
export function parseAnchorPath(p) {
  var s = String(p || '')
  var m = s.match(ANCHOR_TAIL)
  if (!m) return { file: s, from: null, to: null }
  var from = parseInt(m[1], 10)
  var to = m[2] != null ? parseInt(m[2], 10) : null
  var file = s.slice(0, m.index)
  if (!isFinite(from) || from < 1 || (to != null && (!isFinite(to) || to < from))) return { file: file, from: null, to: null, invalidAnchor: true }
  return { file: file, from: from, to: to }
}

// 按行切段（行号 1 起，from/to 皆含）。
// from 为 null → 全量（头部注入口径，injectedFrom=1、injectedTo=末行）。
// 段无效（from 越界/<1、to<from）→ invalid=true，调用方回退头部注入并标注。
// to 超文末 → 收敛到文末（锚点大意写超了，给到手头有的，不算无效）。
// 段长超 CONTEXT_SLICE_MAX_LINES → 截到上限并 capped=true。
export function sliceLines(content, from, to) {
  var text = String(content == null ? '' : content)
  var lines = text.split('\n')
  var total = lines.length
  if (from == null) return { text: text, totalLines: total, injectedFrom: 1, injectedTo: total, capped: false, invalid: false }
  var f = Math.floor(Number(from))
  var t = to == null ? total : Math.floor(Number(to))
  if (!isFinite(f) || f < 1 || f > total || (to != null && (!isFinite(t) || t < f))) {
    return { text: '', totalLines: total, injectedFrom: 0, injectedTo: 0, capped: false, invalid: true }
  }
  if (t > total) t = total
  var capped = false
  if (t - f + 1 > CONTEXT_SLICE_MAX_LINES) { t = f + CONTEXT_SLICE_MAX_LINES - 1; capped = true }
  return { text: lines.slice(f - 1, t).join('\n'), totalLines: total, injectedFrom: f, injectedTo: t, capped: capped, invalid: false }
}

// 结构索引：JS/TS 顶层函数/类/箭头赋值 与 Markdown 标题，逐行正则（零依赖，宁可漏检不可误切）。
// 每条 'L<n>: <签名≤80字符>'；超 CONTEXT_OUTLINE_MAX 条截断并附一条省略标注。
// 两个正则都无 /g，.test 无状态可安全复用。
var OUTLINE_JS = /^(?:export\s+)?(?:async\s+)?(?:function\s|class\s|[\w$]+\s*=\s*(?:async\s+)?(?:function|\())/
var OUTLINE_MD = /^#{1,6}\s/
function outlineHit(ln) { return OUTLINE_JS.test(ln) || OUTLINE_MD.test(ln) }
export function buildFileOutline(content) {
  var lines = String(content == null ? '' : content).split('\n')
  var out = []
  var i
  for (i = 0; i < lines.length; i++) {
    if (!outlineHit(lines[i])) continue
    var sig = lines[i].trim()
    if (sig.length > 80) sig = sig.slice(0, 80) + '…'
    out.push('L' + (i + 1) + ': ' + sig)
    if (out.length >= CONTEXT_OUTLINE_MAX) break
  }
  // 已达上限 → 数一遍剩余命中，附省略标注（只在截断时多扫这一次尾部）
  if (out.length >= CONTEXT_OUTLINE_MAX && i < lines.length) {
    var rest = 0
    for (var j = i + 1; j < lines.length; j++) { if (outlineHit(lines[j])) rest++ }
    if (rest > 0) out.push('…（另有 ' + rest + ' 条结构省略）')
  }
  return out
}
// 口径说明（epicSplit 总开关审计）：Worker prompt **不含任何拆分引导条款**——拆分引导只出现在主窗口侧
// 两处动态面（Team 提示词第 6 条 + create-task/task_create 的 suggestSplit 软提示），Worker 拿到的是
// 已经建好的单张卡（要拆也轮不到它拆，真觉得大应走歧义上报）。故 epicSplit=false 时 Worker prompt 字面
// 与 true 时逐字相同（单测锁定 parity，防止将来有人往这里塞拆分条款而漏接门禁）；buildWorkerPrompt
// 因此不引入 epicSplit 形参——没有条款可跳过，加个无用参数只会是死代码。
export function buildWorkerPrompt(t, pack, feedbackEnabled) {
  var notes = histNotes(t)
  var msgs = buildMessages(t)
  var p = '你是一个一次性任务执行 Worker。完成下面这个任务，完成后本会话即销毁。\n\ntaskId: ' + t.id + '\n任务: ' + t.title + '\n描述: ' + (t.description || '')
  if (t.context && t.context.instructions) p += '\n指引: ' + t.context.instructions
  if (t.acceptance) p += '\n硬性验收脚本: ' + t.acceptance + '\n（必须实际运行该命令并在自测情况中粘贴真实输出；未通过不得上报完成）'
  if (notes) p += '\n\n该任务的过程记录（歧义上报/主窗口裁决/驳回/干预，请务必遵循最新裁决方向）：\n' + notes
  if (msgs) p += '\n\n该任务的详细消息（裁决答案/干预指令/歧义原文等，请务必遵循）：\n' + msgs
  if (pack) p += '\n\n' + pack
  // 学习飞轮 v1 软召回（feedbackEnabled 关闭时不出现）：只提示"先查历史教训"，看板绝不代查——
  // 环境里有没有笔记/记忆类工具、教训库长什么样，都是 Worker 自己判断的事（零耦合）。
  if (feedbackEnabled !== false) p += '\n\n' + LESSON_RECALL_HINT
  // git 纪律红线（n-muyaaoo7cqnd 实证事故：并行 Worker 跑 git checkout HEAD -- package.json
  // 把另一 Worker 的在途编辑冲掉）：禁止还原命令，只改自己写的文件，要干净基线走 escalate 上报。
  p += '\n\ngit 纪律红线：禁止 git checkout / git restore / git reset --hard / git clean 等还原命令（会冲掉并行 Worker 与你自己的未提交在途编辑）；你只需管自己写的文件，别人改了别的文件与你无关；确实需要干净基线时用 board_report（kind=escalate）上报，由主窗口裁决。'
  p += '\n\n完成契约（双模，工具优先）：\n1. 完成时：优先调用 board_report 工具（kind=complete, taskId=' + t.id + '，summary=开发描述/changes=改动清单/selfTest=自测情况/diffStat=变更概要）；工具不可用则按分段格式输出（## 开发描述 / ## 改动清单 / ## 自测情况 / ## diff 概要）。\n   diffStat 要求：若本次改动发生在 git 仓库内，运行 git diff --stat（含 git status --short），把输出贴进 diffStat（≤1500 字符）；关键逻辑变更可附 ≤20 行核心片段。非代码任务/无 git 仓库可省略。\n   **board_report 调用成功即任务终点：立即结束输出，不要再修改/验证任何文件**。上报后任务即刻进入验收，你继续改动会让代码在验收口径之外漂移、且阻塞 Verifier 派发（实测有 Worker 上报后又自测 16 分钟）；上报后发现新问题的，写进 selfTest 备注交由 Verifier/主窗口裁决。\n2. 歧义/信息不足/需用户决策时：优先调用 board_report（kind=escalate, taskId=' + t.id + ', question=疑问）；工具不可用则输出以 [ESCALATE] 开头的说明。不要猜测。上报歧义后直接结束本轮——裁决后会有新 Worker 带着裁决答案接手。\n3. 进展汇报（较大任务）：按里程碑推进，每完成一个可验证的里程碑调用一次 board_report（kind="progress", taskId=' + t.id + ', question=一行进展摘要，≤200 字符）。只在有实际产物/结论时报；禁止定时汇报或表演式汇报。'
  return p
}
// ===== Verifier 自测指南契约段（verifyUserGuide 板级开关，默认开，task-muxyyvg0）=====
// 背景：Verifier 产出只对主窗口说话，用户无法逐张审产出——每张验收卡附一份「用户自测指南」，
// 用户照着步骤自己验证。四字段：gist（一句人话说改了什么）/ steps[]（用户操作步骤，每条一步）/
// expect（预期看到什么）/ tier（ui=界面可操作 | metric=看指标变化 | internal=纯内部无用户可感知面，
// internal 时 steps 可空、expect 写「验证靠测试套件」）。
// 诚实护栏写死在 prompt：只给亲自验过/从 diff 可推导的步骤，不许编没验过的操作；
// UI 特性给具体路径（哪个区哪个按钮）；host-only 改动如实标 internal。
// 双模：工具通道走 board_verdict 的 userTest 参数；文本通道追加「## 自测指南」段
//（段体格式 parseUserTest 解析，落账 t.verification.userTest）。
export var USER_GUIDE_CONTRACT = '\n\n自测指南（给用户看的验收指引，随结论一并提交）：\n在结论分段之后追加一段「## 自测指南」，严格按四字段格式：\ngist: <一句人话：这次改了什么，用户能感知到什么>\ntier: ui | metric | internal（三选一，诚实分级：ui=界面可操作验证；metric=看指标/数据变化验证；internal=纯内部改动，无用户可感知面）\nsteps:\n1. <用户操作第一步>\n2. <用户操作第二步>\nexpect: <预期看到什么>\n诚实护栏：steps 只写你亲自验过、或能从 diff 直接推导的步骤，不许编造没验过的操作；UI 特性给具体路径（哪个区哪个按钮）；tier=internal 时 steps 可留空，expect 写「验证靠测试套件」。\n工具通道：调用 board_verdict 时把四字段放进 userTest 参数（{gist: 一句人话, steps: [步骤,...], expect: 预期, tier: ui|metric|internal}）。'

// ===== Verifier 验收员加餐（task-muy3gm03）：固定 persona + 工具收窄 =====
// 背景：Verifier 此前只有任务层 prompt 契约，没有「人设」——遇到 Worker 汇报与实证冲突时
// 容易顺着汇报走。宿主 spawn 面实证（dsh-subagent types.d.ts:136-191 + spawn-in-process
// lib/index.js:23-29 capabilities 全 true）：一次性 start() 支持 persona（scoped
// deployment:persona-prefix 影子段，只覆盖该子代理的部署人设）与 toolFilter（scoped
// tools.restrict()，工具从 prompt 消失且拒绝执行）。continuable 面（ContinuableCreateRequest
// 只有 sessionId/parent/signal）不支持这两个参数——但 verifier 恒走一次性路径
//（useContinuable 只对 worker 开），挂一次性面即覆盖全部 verifier spawn。
// ⚠️ persona 走宿主严格 {{…}} 插值（同 deployment persona 模板语义）——本文不得出现连写 {。
// ⚠️ toolFilter 名字走「响亮未知名校验」：deny 了不存在的工具会直接抛错，故只砍
//    宿主标配的 web_fetch/web_search，且 dispatch 侧有「剥外挂参数重试」兜底。
export var VERIFIER_PERSONA = '你是任务看板的独立验收员（Verifier），不是 Worker 的队友。\n1. 独立判断：不轻信 Worker 的汇报与自测描述——「Worker 说已验证」不构成证据，一切以你亲自复跑/核对到的为准。\n2. 实证为准：有硬性验收脚本必须独立复跑并核对真实输出；脚本失败或无法复现成功一律 REJECTED。\n3. 诚实分级：自测指南按真实可验证面分级（ui/metric/internal），不为好看拔高档次，没验过的步骤不写。\n4. 双读者：结论同时写给主窗口（逐条核对证据，含行号）和用户（自测指南人话）——两者都要诚实、可复核。'
// toolFilter 收窄评估结论（保守口径）：只砍明确无关的联网检索（web_fetch/web_search——
// 验收以本地实证为准，不需联网）；其余一律保留：read/grep/glob/pwsh 是核对主力，
// write/edit 供文件纪律允许的临时/测试文件，board_verdict 是落账通道，note_* 供查历史教训，
// browser_* 保留（tier=ui 验收可能要真实开页面核对），task_*/看板管理工具子代理本无权限
//（rpc 层 root 闸门）无需再砍。拿不准的宁可不收窄。
export var VERIFIER_TOOL_FILTER = { deny: ['web_fetch', 'web_search'] }
export function buildVerifierPrompt(t, pack, userGuide) {
  var notes = histNotes(t)
  var msgs = buildMessages(t)
  var p = '你是一个一次性任务审核 Verifier。审查下面这个任务的完成质量，给出结论后本会话即销毁。\n\ntaskId: ' + t.id + '\n任务: ' + t.title + '\n描述: ' + (t.description || '').slice(0, 500)
  p += '\n完成说明: ' + (t.resolution || '(无)')
  p += '\n交付物: ' + (t.deliverable ? ('开发描述: ' + (t.deliverable.summary || '') + '\n改动清单: ' + (t.deliverable.changes || '') + '\n自测情况: ' + (t.deliverable.selfTest || '') + (t.deliverable.diff ? '\nWorker 变更 diff 概要（git diff --stat 等，作为改动范围核对的第材料）:\n' + t.deliverable.diff : '')) : '(无)').slice(0, 4000)
  if (t.context && t.context.instructions) p += '\n指引: ' + t.context.instructions
  if (t.acceptance) p += '\n硬性验收脚本: ' + t.acceptance + '\n（必须独立复跑该命令并把真实输出贴进核对项；脚本失败必须 REJECTED）'
  if (notes) p += '\n\n该任务的过程记录（歧义上报/主窗口裁决/驳回/干预，若有）：\n' + notes + '\n注意：若过程记录显示主窗口已裁决改变任务方向，以裁决后的方向为验收标准。'
  if (msgs) p += '\n\n该任务的详细消息（裁决答案/干预指令/歧义原文等）：\n' + msgs
  if (pack) p += '\n\n' + pack
  // 跑偏归因条款（调研遵循·host 三件套 ②）：驳回理由注明「立单缺调研」——归因计入驳回热点统计，
  // 供主窗口分诊「立单缺料 vs Worker 执行问题」，缺料占高了就该把建卡调研门禁拧紧。
  p += '\n驳回归因：若 Worker 的产出明显因缺少调研上下文而跑偏/绕路，驳回时请在驳回理由里注明「立单缺调研」（归因会计入驳回热点统计）。'
  // 文件纪律（task-muy3gm03，用户口径「验收时可以写必要的测试文件，不要动工程代码」）：
  // 写死进 prompt 的硬纪律 + 事后兜底威慑（touches 审计：Worker 交付的 diff 概要与任务声明的
  // touches 即改动范围基线，越界即驳回——这层审计对 verifier 自己同样生效）。
  p += '\n文件纪律：验收时可以写必要的临时/测试文件（放 _scratch 或测试目录，验收结束后自行清理干净）；禁止改动工程代码与文档（README 等）。事后有 touches 审计兜底：Worker 交付的 diff 概要与任务声明的 touches 是改动范围基线，发现越界改动（含你自己留下的改动痕迹）一律驳回。'
  p += '\n\n结论契约（双模，工具优先）：\n1. 优先调用 board_verdict 工具（taskId=' + t.id + ', verdict=approved/rejected, summary=测试概要, checks=逐条核对证据含行号）。\n2. 工具不可用则首行 APPROVED: <结论> 或 REJECTED: <结论>，然后 ## 测试概要 / ## 核对项 分段。'
  // 自测指南段（verifyUserGuide 开关门禁，缺省开）：整段追加在 prompt 末尾；关掉 = 逐字无此段（省 token），
  // 落账侧（settleVerifier/board_verdict）同开关门禁——关时即使输出带了段也不挂 userTest 字段。
  if (userGuide !== false) p += USER_GUIDE_CONTRACT
  return p
}

// ===== hook run prompt（薄框架模板，hooks=agent run）=====
// hook 点 = 一次真实 agent 运行：prompt 只给「契约一句话 + epic 上下文 + 子任务清单」，
// 具体做什么由 hook agent 按现场自行决策；吃不准/信息不足一律歧义上报，禁止硬闯。
// commit/push 不进任何默认形态——前置不许默认提交，后置明确写「不要默认提交/推送」（红线③）。
// pre 契约：让这批子任务具备开跑条件（做什么准备由 agent 判断，可只读调研后什么都不改）。
// post 契约：把这批已完成的工作收口（验证/总结/（自行决定并自负其责的）提交都算）。
export function buildHookPrompt(epic, phase, childTasks) {
  var kids = Array.isArray(childTasks) ? childTasks : []
  var pre = phase !== 'post'
  var p = '你是一个一次性史诗 hook 执行 Agent（hooks=' + (pre ? 'pre' : 'post') + ' run）。本次运行由任务看板的派发周期发起，完成（或上报歧义）后本会话即销毁。\n\n'
  p += 'hook 点位：' + (pre ? 'pre（前置准备闸门）' : 'post（收口闸门）') + '\n'
  p += '所属史诗：' + epic.id + ' · ' + String(epic.title || '') + '\n'
  p += '史诗状态：' + String(epic.status || '') + '\n'
  p += '史诗描述：' + String(epic.description || '(无)').slice(0, 2000) + '\n'
  if (epic.context && epic.context.instructions) p += '史诗指引：' + String(epic.context.instructions).slice(0, 1000) + '\n'
  p += '\n主窗口给本次 hook 的运行契约（薄框架：只定边界，不做具体动作安排）：\n' + String((epic.hooks && epic.hooks[phase] && epic.hooks[phase].prompt) || '(未填写)').slice(0, 4000) + '\n'
  p += '\n该史诗的子任务清单（' + kids.length + ' 个）：\n'
  if (!kids.length) p += '- （暂无子任务）\n'
  for (var i = 0; i < kids.length; i++) {
    var c = kids[i]
    p += '- [' + (c.status || '') + '] ' + c.id + ' · ' + String(c.title || '').slice(0, 120)
    if (c.pipeline) p += '（管线 ' + c.pipeline + '）'
    p += '\n'
  }
  p += '\n你的任务：' + (pre
    ? '让这批子任务具备开跑条件。做什么准备由你根据上下文判断（可只读调研、制定方案、补齐约定，也可以判断为「无需准备」）。'
    : '把这批已完成的工作收口。收口动作由你判断（通常可能涉及验证、总结，也可能涉及提交——自行决策并自负其责）。')
  p += '信息不足、吃不准、或需要用户/主窗口决策时：优先调用 board_report（kind=escalate, taskId=' + epic.id + ', question=疑问）；工具不可用则输出以 [ESCALATE] 开头的说明。不要猜测、不要硬闯。\n'
  p += '红灯纪律：不要默认提交（git commit）或推送（git push）——除非上面的运行契约明确要求，或你判断确实是本次收口不可省略的一步；那也要在完成说明里写清做了什么、为什么。\n'
  if (!pre) p += '本次收口完成后，史诗将自动转入 verifying（交人验收）。\n'
  p += '\n完成契约（双模，工具优先）：\n'
  if (pre) p += '1. 完成时：优先调用 board_report 工具（kind=complete, taskId=' + epic.id + '，summary=做了什么准备/changes=改动清单（无改动就写「无」）/selfTest=自测情况/diffStat=变更概要）。工具不可用则按分段格式输出（## 开发描述 / ## 改动清单 / ## 自测情况 / ## diff 概要）。完成即代表 pre 闸门放行，之后 epic 的子任务会开始派发。\n'
  else p += '1. 完成时：优先调用 board_report 工具（kind=complete, taskId=' + epic.id + '，summary=收口做了什么/changes=改动清单（无改动就写「无」）/selfTest=自测情况/diffStat=变更概要）。工具不可用则按分段格式输出（## 开发描述 / ## 改动清单 / ## 自测情况 / ## diff 概要）。\n'
  p += '   **board_report 调用成功即本次运行终点：立即结束输出，不要再修改/验证任何文件**。\n'
  p += '2. 歧义/信息不足：board_report（kind=escalate, taskId=' + epic.id + ', question=疑问）；工具不可用则输出以 [ESCALATE] 开头的说明。上报后直接结束本轮。\n'
  p += '3. 进展汇报：只在有实际产物/结论时报（board_report kind="progress"），禁止表演式汇报。\n'
  return p
}

// ===== 文件锁持有集合（touches 排他）=====
// 口径（用户 2026-10-06 裁决）：锁只护「正在写」的阶段——**状态流转到已完成（resolved）即放锁**。
// 这是对 task-muv7c8ja / e969f57「锁持到归档」的回调：归档应回归纯收纳动作，不再是释放点。
// 原话：「文件锁归档后才解锁不合理，应该状态自动流转到已完成时解锁」（反馈 n-muupqg81u575 的
// 真问题——验收后-提交前窗口期污染——改由流程承接，不再用长持锁兜底）。
// 持锁两态（声明了 touches 为前提）：
//   - in-progress + claimedBy：Worker 正在改文件（claimedBy 为空=占位未落座/僵尸，不算持锁）；
//   - verifying：Worker 已停笔但**尚未落定**——驳回会回 in-progress 让同一批文件继续被改，
//     故锁不能在 in-progress→verifying 断（Verifier 只读，不参与排他）。
// 即放（不持有）：resolved（完成即放，未归档也放）、cancelled（放弃语义=不再产出）、
// archived（归档只是收纳，对锁零影响）、pending/blocked/draft（没有 Worker 在改文件）。
// 承接关系（「验收后-提交前」窗口期为什么不再靠锁兜底）：
//   ① 主窗口即时门禁纪律：收到完成回执就立即提交，不等不看别的卡（提交时点与回执对齐）；
//   ② 史诗 post-hook：提交动作收进任务生命周期（post=done 才收口 epic），提交可追溯、可审计。
//   锁只表达「文件正在被写」，「改动尚未提交」由上面两条承接——否则 resolved 卡长期不归档
//   会一直堵住同批文件、把本可并行的批次全串行化，这正是本次回调要消除的代价。
// 返回 [{id, touches}]，id 用于 blockedTouches.conflicts 展示"在等谁"。
export function holdsFiles(d) {
  var out = []
  if (!d || !Array.isArray(d.tasks)) return out
  for (var i = 0; i < d.tasks.length; i++) {
    var t = d.tasks[i]
    if (!t || !Array.isArray(t.touches) || !t.touches.length) continue
    var holds = t.status === 'verifying' || (t.status === 'in-progress' && !!t.claimedBy)
    if (holds) out.push({ id: t.id, touches: t.touches })
  }
  return out
}
// 候选任务（pending）与一组锁持有者是否冲突；返回持有者 id 列表（空数组 = 无冲突）
export function touchesConflict(t, holds) {
  var out = []
  if (!t || !Array.isArray(holds)) return out
  for (var i = 0; i < holds.length; i++) { if (holds[i] && holds[i].id !== t.id && overlapsTouches(t.touches, holds[i].touches)) out.push(holds[i].id) }
  return out
}

// ===== 派发决策（纯函数版，poolCycle 持锁段调用）=====
// 返回 { pendings, verifs, blockedTouches }：按优先级排序的可派发任务清单。
// frozen（裁决挂起冻结）不参与任何自动派发：pending 不派 Worker、verifying 不派 Verifier；
// 只能由主窗口显式解冻（unfreeze-task RPC / task_update unfreeze:true）后重新入池。
// blockedTouches（touches 文件级排他）：候选声明了 touches 且与活动任务的 touches 冲突 →
// 不进 pendings，改记 [{id, conflicts:[持有任务id...]}]，由 index.mjs 的 poolCycle 写展示态字段
// t.waitingForTouches（每心跳刷新的 UI 展示，不参与其他逻辑）。verifs 不受 touches 影响（Verifier 只读）。
// 注意：frozen/dependsOn/escalation/上限 的优先级不变——先过滤再算 touches 冲突。
// pre hook 串行闸门（hooks=agent run 接线①）：候选所属 epic 的 hooks.pre 未 done 时整批不派
// （见 preHookGate），由 poolCycle 改 spawn hook-pre run——同一 epic 的子任务在准备完成前
// 一张都不派，这是「pre 闸门」的串行语义；未声明 hooks 的 epic 逐字不受影响。
export function pickDispatch(d, capW, capV, busyTaskIds) {
  var blockedTouches = []
  var pendings = []
  // 锁持有集合在本轮内动态增长：一旦某候选被纳入本轮派发，它立即成为持有者，
  // 防止同一轮 cycle 派出的两个任务声明重叠 touches。
  var holds = holdsFiles(d)
  if (capW > 0) {
    var cands = d.tasks.filter(function (t) { return t.status === 'pending' && !t.claimedBy && !t.frozen && t.assignMode !== 'manual' && t.pipeline !== 'direct' && depsSatisfied(d, t) && !t.escalation && preHookGate(gpt(t, d.tasks)).pass })
      .sort(function (a, b) { var p = (PRIO_RANK[b.priority] || 2) - (PRIO_RANK[a.priority] || 2); return p !== 0 ? p : (a.createdAt || '').localeCompare(b.createdAt || '') })
    for (var i = 0; i < cands.length && pendings.length < capW; i++) {
      var conflicts = touchesConflict(cands[i], holds)
      if (conflicts.length) { blockedTouches.push({ id: cands[i].id, conflicts: conflicts }); continue }
      pendings.push(cands[i])
      if (Array.isArray(cands[i].touches) && cands[i].touches.length) holds.push({ id: cands[i].id, touches: cands[i].touches })
    }
  }
  var verifs = capV > 0 ? d.tasks.filter(function (t) { return t.status === 'verifying' && !t.frozen && (!t.pipeline || t.pipeline === 'full') && !t.escalation && t.verifierRun !== 'spawn-pending' && !(busyTaskIds && busyTaskIds[t.id]) }).slice(0, capV) : []
  return { pendings: pendings, verifs: verifs, blockedTouches: blockedTouches }
}
// 孤儿回收判定：in-progress 且 claimedBy 非主会话、无活跃 run、无 escalation、超 2 分钟：in-progress 且 claimedBy 非主会话、无活跃 run、无 escalation、超 2 分钟
export function isOrphan(d, t, runs, now) {
  return t.status === 'in-progress' && t.claimedBy && t.claimedBy !== d.ownerSession && !(runs && runs[t.id]) && !t.escalation && (now - new Date(t.claimedAt || 0).getTime()) > 120000
}

// ===== 调研门禁（warning 族 + epic 发布预检；proposal n-mutduqaen6q9 收窄采纳）=====
// 背景：调研上下文（contextFiles/contextNotes）是 Worker 效率的最大变量——缺材料时 Worker
// 要花 10-15 分钟自行 grep 定位，甚至跑偏方向。这里只放纯函数：建卡 warning（软提示不阻断）
// 与 epic 发布预检汇总；IO（existsSync）由调用方注入，本体零依赖可单测。

// 整树 glob 判定：归一化后以 '/**' 结尾或恰为 '**'（'src/**'、'./src/**'、'src\**' 都算）——
// 整树锁会让同批次所有碰该目录的任务串行化。'src/*'、'src/**/*.mjs' 不算（结尾不是 '/**'）。
export function isTreeGlob(p) { var v = normTouch(p); return v === '**' || /\/\*\*$/.test(v) }

// 建卡 warning 族（task_create 工具与 create-task RPC 共用同一口径，软提示不阻断创建）：
//   ① description trim 后空白 → 提醒补目标/约束（沿用 E 卡既有文案，逐字不变）
//   ② pipeline∈{full,work} 且 touches 非空且 contextFiles/contextNotes 皆空 → 提醒补调研上下文
//   ③ touches 含整树 glob → 提醒精确到文件级
// ②③ 的触发前提：pipeline≠'direct' 且 touches 非空（direct 主窗口直接处理、无 touches 不指望调研材料）。
// 返回 string[]；调用方自行合并为一条 warning 字段（可选字段，老调用方无感）。
export var EMPTY_DESC_WARNING = '任务描述为空——Worker 只能凭标题猜需求，建议补一句目标/约束'
// ②的文案单独成常量：rpc 双通道在「触发②且 touches 有可建议文件」时要认出这条并补尾巴
// （attachContextSuggestions），字面量若散在两处会漂移。
export var NO_RESEARCH_WARNING = '未附调研上下文（contextFiles/contextNotes）——Worker 将自行 grep 定位，建议补上预研文件路径或勾选无需调研'
// ②触发且 suggestContextFiles 非空时，warning 尾巴补的最省力动作指引（不含 '；'，不破坏多 warning 合并分隔）
export var NO_RESEARCH_HINT = '（可直接 task_update contextFiles 补上：touches 指向的文件就是最相关的调研现场）'
// verify 驳回响应的重派提示（task_verify 工具 + verify-task RPC 的 rejected 分支挂载；字段可选，老调用方无感）
export var REJECT_REDISPATCH_HINT = '建议：驳回原因写进 description，并用 contextNotes 补调研结论后再重派——新 Worker 没有上一轮记忆'
export function createTaskWarnings(t) {
  var out = []
  if (!t || typeof t !== 'object') return out
  if (!String(t.description || '').trim()) out.push(EMPTY_DESC_WARNING)
  var touches = Array.isArray(t.touches) ? t.touches : []
  if ((t.pipeline || 'full') !== 'direct' && touches.length) {
    var cx = t.context || {}
    var hasFiles = Array.isArray(cx.files) && cx.files.length > 0
    var hasNotes = !!(cx.notes && String(cx.notes).trim())
    if (!hasFiles && !hasNotes) out.push(NO_RESEARCH_WARNING)
    if (touches.some(isTreeGlob)) out.push('touches 含整树 glob 会串行化整个批次——修复类任务建议精确到文件级')
  }
  return out
}

// ===== 任务起草 lint（proposal n-muwlpbspl3w2）：四规则软警告，存 task.lintWarnings[]，不阻塞 =====
// 与上方「调研门禁」（createTaskWarnings，瞬态 warning 字段）正交：那是「缺调研材料」的即时软提示；
// 这是「起草质量」的持久诊断（粒度过粗/双仓库歧义/缺验收/标题缺动词/描述空），随卡落盘、
// get-tasks 透出、详情页 ⚠️ 行展示。纯函数：双仓库歧义读盘（io 注入），本体零 IO 可单测。
// 四规则（各一触发 + 各一不触发，单测锁定）：
//   ① touches 含整树 glob（src/** 级）→ 粒度过粗，几乎锁整仓
//   ② touches 相对路径在 ownerCwd 多个直接子目录下同名命中 → 路径双仓库歧义
//   ③ pipeline=full 但无 acceptance 验收脚本 → 建议带验收命令
//   ④ 标题缺动作动词 / 描述为空 → 建议补指令式标题 / 补目标约束
export var TREE_GLOB_LINT = 'touches 粒度过粗，几乎锁整仓'
export var AMBIGUOUS_PATH_LINT = '路径双仓库歧义，建议加仓库前缀'
export var FULL_NO_ACCEPTANCE_LINT = 'full 管线建议带验收命令'
export var TITLE_NO_VERB_LINT = '标题缺动作动词，建议改为「动词+宾语」指令式'

// 标题动作动词白名单（中文指令式任务标题高频动词，命中任一即算「有动词」）。
// 只做软提示：宁可漏检不可误报（漏了最多不亮这条），因此不做「非动词开头即判缺动词」的严格反例。
var TITLE_VERBS = /添加|新增|修复|实现|重构|优化|支持|调整|更新|删除|迁移|拆分|整理|调研|设计|接入|改造|移除|升级|编写|撰写|起草|补充|完善|收敛|扩展|统一|替换|清理|测试|验证|审查|复核|审计|沉淀|回写|生成|构建|发布|上线|评审|分析|汇总|统计|梳理|排查|定位|解决|处理|切换|对齐|收口|接线|透出|承接|重建|适配|放宽|收紧|拦截|放行|归一|聚合|装配|注入|投递|挂载|卸载|裁剪|截断|折叠|去重|合并|回滚|撤销|归档|恢复|继承|出清|释放|覆盖|包裹|转发|代理|缓存|落盘|读盘|心跳|轮询|结算|推进|回填|重命名|改名|重写|重排|重试|重投|重派|复查|复跑|补全|补齐|补写|补录|追加|跟进|追踪|溯源|归因|归类|导出|导入|展示|渲染|刷新|跳转|筛选|排序/

// touches 相对路径的「仓库内目录前缀」：剥掉 glob 尾段，得到跨仓库判重锚点。
// 'packages/dsh-agent-board/**' → 'packages/dsh-agent-board'；'src/x.mjs' → 'src'；
// 'a/b/c.mjs' → 'a/b'；裸文件名（无 '/'）→ ''（无目录前缀，不参与双仓库判重）。
export function touchDirPrefix(p) {
  var v = normTouch(p)
  if (!v || v === '**') return ''
  var i = v.lastIndexOf('/')
  return i < 0 ? '' : v.slice(0, i)
}

// 双仓库歧义：某条 touches 相对路径的目录前缀，在 root 的 ≥2 个直接子目录下都存在 → 命中同名仓库副本。
// 返回命中的相对路径原文（首个）或 null；io = { root, subdirs[], dirExists(path) } 由调用方注入（读盘）。
// 绝对路径/盘符（C:）/裸文件名不参与判重（裸文件名没有目录锚点，判不了）。
export function ambiguousTouch(touches, io) {
  if (!io || typeof io.dirExists !== 'function') return null
  var list = Array.isArray(touches) ? touches : []
  var subs = Array.isArray(io.subdirs) ? io.subdirs : []
  if (!subs.length) return null
  var root = String(io.root || '')
  for (var i = 0; i < list.length; i++) {
    var p = list[i]
    if (typeof p !== 'string' || !p.trim()) continue
    var v = normTouch(p)
    if (!v || path.isAbsolute(v) || /^[a-zA-Z]:/.test(v)) continue
    var dir = touchDirPrefix(v)
    if (!dir) continue
    var hits = 0
    for (var j = 0; j < subs.length && hits < 2; j++) {
      var cand = path.join(root, subs[j], dir)
      var ok = false
      try { ok = !!io.dirExists(cand) } catch (_) { ok = false }
      if (ok) hits++
    }
    if (hits >= 2) return p
  }
  return null
}

// 起草质量 lint 主入口：返回 string[]（task.lintWarnings 字段内容）。io 缺省时规则②退化为不触发（零 IO 安全）。
export function draftLint(t, io) {
  var out = []
  if (!t || typeof t !== 'object') return out
  var touches = Array.isArray(t.touches) ? t.touches : []
  // ① 整树 glob（多条只报一次）
  for (var i = 0; i < touches.length; i++) { if (isTreeGlob(touches[i])) { out.push(TREE_GLOB_LINT); break } }
  // ② 双仓库歧义（附命中路径，便于定位该加哪个仓库前缀）
  var amb = ambiguousTouch(touches, io)
  if (amb) out.push(AMBIGUOUS_PATH_LINT + '（' + amb + '）')
  // ③ full 无 acceptance（pipeline 空串按默认 full 口径）
  if ((t.pipeline || 'full') === 'full' && !String(t.acceptance || '').trim()) out.push(FULL_NO_ACCEPTANCE_LINT)
  // ④ 标题缺动词 / 描述为空（描述为空复用调研门禁 EMPTY_DESC_WARNING 文案，单一事实源）
  if (!TITLE_VERBS.test(String(t.title || ''))) out.push(TITLE_NO_VERB_LINT)
  if (!String(t.description || '').trim()) out.push(EMPTY_DESC_WARNING)
  return out
}

// ===== touches → suggestedContextFiles 自动桥接（调研遵循·host 三件套 ①）=====
// 让遵守成为最省力路径：建卡触发「无调研上下文」warning 时，直接把 touches 里的具体文件
// 提炼成可一键采纳的 contextFiles 建议（响应挂 suggestedContextFiles 字段）。
// 只取「非 glob 的具体文件路径」：含 * ? [ ] { } 任一通配符的条目跳过（glob 指认不了单个现场）；
// 锚点 :L 段剥掉（存在性是对文件而言的，建议也只到文件级）。exists(path) 由调用方注入
// （fs.existsSync + 会话工作区相对解析包装）；缺省时退化为只做 glob/锚点过滤（与 epicPrecheck 同口径）。
// 去重按剥锚后的原串（不强行归一 './'——相对原样返回，调用方怎么写就怎么收）。
// 上限 20 条（与 contextFiles 上限一致）；exists 抛异常视为不存在（建议错了比没有更糟，宁缺勿滥）。
export var SUGGEST_CONTEXT_MAX = 20
var GLOB_CHARS = /[*?\[\]{}]/
export function suggestContextFiles(touches, exists) {
  var out = []
  var seen = {}
  var list = Array.isArray(touches) ? touches : []
  for (var i = 0; i < list.length && out.length < SUGGEST_CONTEXT_MAX; i++) {
    var raw = list[i]
    if (typeof raw !== 'string' || !raw.trim()) continue
    var file = parseAnchorPath(raw.trim()).file
    if (!file || GLOB_CHARS.test(file)) continue
    if (seen[file]) continue
    if (typeof exists === 'function') {
      var ok = false
      try { ok = !!exists(file) } catch (_) { ok = false }
      if (!ok) continue
    }
    seen[file] = true
    out.push(file)
  }
  return out
}

// 建卡响应的建议桥接（task_create 工具 + create-task RPC 双通道同口径）：
// warnings 里有「无调研上下文」警告且 touches 能提炼出建议时——
//   ① 该条 warning 尾巴补 NO_RESEARCH_HINT（指认最省力动作）；
//   ② out 挂 suggestedContextFiles 字段（可选字段，老调用方无感）。
// 不触发/无建议 → 返回 null，out 与 warnings 形态完全不变（不改既有 warning 判定逻辑，只加建议通道）。
// 注意：必须在 warnings join('；') 之前调用，尾巴才会进最终 warning 文案。
export function attachContextSuggestions(out, warnings, touches, exists) {
  if (!out || !Array.isArray(warnings)) return null
  var idx = warnings.indexOf(NO_RESEARCH_WARNING)
  if (idx < 0) return null
  var suggested = suggestContextFiles(touches, exists)
  if (!suggested.length) return null
  warnings[idx] = NO_RESEARCH_WARNING + NO_RESEARCH_HINT
  out.suggestedContextFiles = suggested
  return suggested
}

// epic 发布预检：父卡 publish 时对其子任务做轻量调研注入预检。
// 口径：只看 pipeline≠direct 的非归档子任务；「无调研注入」= context.files/context.notes 皆空，
//   或 files 列了路径但全部不存在（exists 回调判定，锚点 :L 段与可选「 — 一句用途」后缀先剥掉再查——
//   存在性是对文件而言的，见 parseContextFileEntry）。
// exists(path) 由调用方注入（fs.existsSync + 会话工作区相对解析包装）；缺省时退化为只查字段有无。
// 返回 { total, missing: [{id, title, reason}] }；total=参与预检的子任务数（供汇总文案 N/M）。
export function epicPrecheck(tasks, parentId, exists) {
  var kids = gsb(parentId, Array.isArray(tasks) ? tasks : []).filter(function (x) { return x && x.status !== 'archived' && x.pipeline !== 'direct' })
  var missing = []
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i]
    var cx = (k && k.context) || {}
    var files = Array.isArray(cx.files) ? cx.files.filter(function (p) { return typeof p === 'string' && p.trim() }) : []
    var hasNotes = !!(cx.notes && String(cx.notes).trim())
    var reason = ''
    if (!files.length && !hasNotes) reason = '无 contextFiles/contextNotes'
    else if (files.length && typeof exists === 'function') {
      var anyExist = files.some(function (p) { try { return !!exists(parseContextFileEntry(p).file) } catch (_) { return false } })
      if (!anyExist) reason = '预研文件路径全部不存在（子代理按需 read 时也会全部读不到）'
    }
    if (reason) missing.push({ id: String(k.id || ''), title: String(k.title || '').slice(0, 40), reason: reason })
  }
  return { total: kids.length, missing: missing }
}

// 汇总文案：全部有材料 → 空串（不打扰）；否则 'epic 发布预检：N 个子任务中 M 个无调研注入：…'。
// 列表最多列 5 条（id「title」（原因）），超出折叠为「等」——pushSysNote 队列单条不宜过长。
export function epicPrecheckNote(pre) {
  if (!pre || !Array.isArray(pre.missing) || !pre.missing.length) return ''
  var list = pre.missing.slice(0, 5).map(function (m) { return m.id + '「' + m.title + '」' + (m.reason ? '（' + m.reason + '）' : '') }).join('、')
  return 'epic 发布预检：' + pre.total + ' 个子任务中 ' + pre.missing.length + ' 个无调研注入：' + list + (pre.missing.length > 5 ? ' 等' : '') + '——建议先补 contextFiles/contextNotes 再发布'
}

// ===== tasksHash：任务列表渲染的变更检测（轮询渲染节约，反馈 n-mut9rzs2mkhg）=====
// 背景：客户端 3s 固定全量轮询 get-tasks，任务没变也全量重渲染（实测单卡 12.7KB×20/min）。
// host 在 get-tasks 响应附 tasksHash，kernel 存 state.tasksHash，hash 相同则跳过
// state.tasks 赋值 + notify（传输仍全量，省的是渲染；短期方案）。
// 序列化口径（单测锁定）：
//   - 只挑「驱动列表/详情渲染」的字段：id/status/priority/title/description/parentId/tags/
//     claimedBy/claimedAt/resolvedAt/verifiedAt/archivedAt/lastError/lastProgress.text/
//     frozen/stuckSince/escalation.question。
//     escalation 必须在内：新歧义要触发面板自动弹开，而 board_report escalate 只写
//     escalation/messages/history，不动其他任何字段——漏掉它自动弹开就死了。
//     childStats 由 tasks 现算，其输入（子任务 status/parentId）已随上述字段覆盖。
//   - history/messages/usage/context 不参与：不驱动列表渲染，结算写账/进展消息若参与
//     会让 hash 频繁抖动，短路失效。
//   - 顺序有关：按数组序拼接——看板渲染本就按数组序，顺序变化也该重渲染。
//   - hash 用 djb2-xor（32 位无符号，base36 输出）：实现极小零依赖。hash 只承担
//     「渲染短路」语义，不承担正确性——极低概率碰撞的最坏后果是少渲染一轮。
export function tasksHash(tasks) {
  var list = Array.isArray(tasks) ? tasks : []
  var parts = []
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {}
    parts.push([
      t.id, t.status, t.priority, t.title, t.description, t.parentId,
      Array.isArray(t.tags) ? t.tags.join(',') : '',
      t.claimedBy, t.claimedAt, t.resolvedAt, t.verifiedAt, t.archivedAt,
      t.lastError, t.lastProgress && t.lastProgress.text,
      t.frozen ? '1' : '', t.stuckSince, t.escalation && t.escalation.question
    ].join('\u0001'))
  }
  var s = parts.join('\u0002')
  var h = 5381
  for (var j = 0; j < s.length; j++) h = (((h << 5) + h) ^ s.charCodeAt(j)) >>> 0
  return h.toString(36)
}
