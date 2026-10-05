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
// touches: string[]（glob），派发器发现与「活动（in-progress）任务的 touches」冲突
// 则本轮跳过该候选（记入 pickDispatch 返回的 blockedTouches），等锁释放再派。
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
export function cfg(d) {
  var soft = Math.max(1, Math.min(480, d.softTimeoutMin || 30))
  var hard = Math.max(soft, Math.min(1440, d.hardTimeoutMin || 120))
  return { minWorkers: Math.max(0, Math.min(10, d.minWorkers || 1)), maxWorkers: Math.max(1, Math.min(10, d.maxWorkers || 3)), minVerifiers: Math.max(0, Math.min(5, d.minVerifiers || 0)), maxVerifiers: Math.max(0, Math.min(5, d.maxVerifiers || 2)), softTimeoutMin: soft, hardTimeoutMin: hard, feedbackEnabled: d.feedbackEnabled !== false }
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
  var d = { version: 12, ownerSession: sid, boardMode: 'auto', teamMode: false, feedbackEnabled: true, minWorkers: 1, maxWorkers: 3, minVerifiers: 0, maxVerifiers: 2, workerModel: '', verifierModel: '', softTimeoutMin: 30, hardTimeoutMin: 120, poolStatus: { workers: [], verifiers: [] }, tasks: [] }
  if (typeof ownerCwd === 'string' && ownerCwd) d.ownerCwd = ownerCwd
  return d
}
// 旧文件缺 poolStatus 的归一化（读路径兜底，保证任何历史文件都满足工具输出契约）
// touches 兼容：老任务没有该字段照常（这里只把「存在但非数组」的脏值收敛成数组，
// 避免 holdsFiles/touchesConflict 里 Array.isArray 判定之外还有第三种形态）
// feedbackEnabled 兼容：老看板没有该字段（或落了脏值）一律补 true——默认开，行为与 v1 之前一致。
export function normalizeBoard(d) {
  if (d && typeof d === 'object') {
    if (!d.poolStatus || typeof d.poolStatus !== 'object' || !Array.isArray(d.poolStatus.workers) || !Array.isArray(d.poolStatus.verifiers)) d.poolStatus = { workers: [], verifiers: [] }
    if (typeof d.feedbackEnabled !== 'boolean') d.feedbackEnabled = true
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
// 子任务「已了结」终态口径：resolved（已完成/已验收）+ cancelled（人主动放弃该子任务范围）。
// 为什么 cancelled 也算：cancelled 是人的显式决定，该子任务范围已关闭；若不算，一张被取消的
// 子任务会把 epic 永久钉在 in-progress（手动取消的卡反而制造死卡）。验收时人仍可在 epic 上驳回。
// 注：archived 不算——归档是「收尾/清理」动作，不应反向推动父卡流转（父卡归档时会级联归档子任务）。
export function isChildSettled(t) { return !!t && (t.status === 'resolved' || t.status === 'cancelled') }
// 史诗父卡自动收口（共享 helper，唯一判定口径）：父卡存在、父卡 in-progress、且全部子任务 ∈ 终态完成集
// → 父卡转 verifying（交人验收）。幂等：父卡已 verifying/resolved/archived 一律返回 null，重复调用无副作用。
export function maybeAutoCloseParent(d, childTask) {
  if (!d || !childTask || !isb(childTask)) return null
  var p = gpt(childTask, d.tasks)
  if (!p || p.status !== 'in-progress') return null
  var s = gsb(p.id, d.tasks)
  if (!s.length || !s.every(function (x) { return isChildSettled(x) })) return null
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
// 通常随之归档，不影响在板卡片的展示）。注意与 isChildSettled（父卡自动收口口径，archived 不算）
// 的区别：那条管「是否推动父卡流转」，本条只管「进度分母/分子的展示口径」，两者刻意不合并。
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
    else if (/自测/.test(title)) out.selfTest = body
    else if (/diff|变更概要/i.test(title)) out.diff = body
    else if (/测试概要|验证概要|审查概要/.test(title)) out.verifySummary = body
    else if (/核对项|核验项|检查项/.test(title)) out.checks = body
  }
  return out
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
// 主窗口预研上下文段：笔记（调研结论/原始需求/思路）+ 文件，由 host 组装后传入（core 保持纯函数不碰 IO）
// 注意：systemPrompt context 通道做严格 {{var}} 插值，内容里的 {{...}} 会直接抛异常
// 毁掉子代理的整个 prompt 组装——必须把 { 连写整 run 拆开（肉眼可读，插值器不再触发）。
// 教训：replace(/\{\{/g,'{ {') 是开变换——三连括号 {{{lo}}}（Python f-string）会得到
// "{ {{lo}}}"，替换结果自己又造出 {{。按"连 { 整 run 拆开"才是封闭变换。
function sanitizeCtx(s) { return String(s).replace(/\{+/g, function (m) { return m.length === 1 ? m : m.split('').join(' ') }) }
export function buildContextPackSection(files, notes) {
  var parts = []
  if (notes && String(notes).trim()) parts.push('### 主窗口调研笔记（结论/思路/原始需求，直接采信）\n' + sanitizeCtx(String(notes)))
  if (Array.isArray(files) && files.length) {
    parts.push('主窗口预研文件（主窗口创建任务前已读过以下内容，直接使用，不要重复读取；标"截断"的内容可按需补读）：')
    for (var i = 0; i < files.length; i++) {
      var f = files[i]
      // meta 携带截断详情/锚点信息（readContextPack 组装）；老数据只有 truncated 时回退「（截断）」
      var head = '### ' + sanitizeCtx(f.path) + (f.meta ? '（' + sanitizeCtx(f.meta) + '）' : (f.truncated ? '（截断）' : ''))
      parts.push(head + '\n' + sanitizeCtx(f.content))
      // 结构索引块：供 Worker 按行号用锚点语法直读目标段，不用全文盘点
      if (Array.isArray(f.outline) && f.outline.length) {
        parts.push('结构索引（' + sanitizeCtx(f.path) + ' 的函数/标题及行号，可用 路径:L起-L止 锚点补读）：\n' + f.outline.map(function (x) { return sanitizeCtx(x) }).join('\n'))
      }
    }
  }
  return parts.length ? parts.join('\n\n') : ''
}

// ===== 上下文注入增强：锚点行段 + 截断结构索引（看板反馈 n-musaoirgsigo ①②④）=====
// 背景：contextFiles 注入大文件被 8KB 头部截断，目标代码段在中部/尾部，Worker 仍需全文盘点；
// 且只标"截断"二字，不知道截掉了什么、该补读哪里。
// 三个纯函数落在这里可单测；零依赖纯行正则，宁可漏检不可误切（不引 parser）。
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
  p += '\n\n完成契约（双模，工具优先）：\n1. 完成时：优先调用 board_report 工具（kind=complete, taskId=' + t.id + '，summary=开发描述/changes=改动清单/selfTest=自测情况/diffStat=变更概要）；工具不可用则按分段格式输出（## 开发描述 / ## 改动清单 / ## 自测情况 / ## diff 概要）。\n   diffStat 要求：若本次改动发生在 git 仓库内，运行 git diff --stat（含 git status --short），把输出贴进 diffStat（≤1500 字符）；关键逻辑变更可附 ≤20 行核心片段。非代码任务/无 git 仓库可省略。\n   **board_report 调用成功即任务终点：立即结束输出，不要再修改/验证任何文件**。上报后任务即刻进入验收，你继续改动会让代码在验收口径之外漂移、且阻塞 Verifier 派发（实测有 Worker 上报后又自测 16 分钟）；上报后发现新问题的，写进 selfTest 备注交由 Verifier/主窗口裁决。\n2. 歧义/信息不足/需用户决策时：优先调用 board_report（kind=escalate, taskId=' + t.id + ', question=疑问）；工具不可用则输出以 [ESCALATE] 开头的说明。不要猜测。上报歧义后直接结束本轮——裁决后会有新 Worker 带着裁决答案接手。\n3. 进展汇报（较大任务）：按里程碑推进，每完成一个可验证的里程碑调用一次 board_report（kind="progress", taskId=' + t.id + ', question=一行进展摘要，≤200 字符）。只在有实际产物/结论时报；禁止定时汇报或表演式汇报。'
  return p
}
export function buildVerifierPrompt(t, pack) {
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
  p += '\n\n结论契约（双模，工具优先）：\n1. 优先调用 board_verdict 工具（taskId=' + t.id + ', verdict=approved/rejected, summary=测试概要, checks=逐条核对证据含行号）。\n2. 工具不可用则首行 APPROVED: <结论> 或 REJECTED: <结论>，然后 ## 测试概要 / ## 核对项 分段。'
  return p
}

// ===== 文件锁持有集合（touches 排他）=====
// 仅 in-progress + claimedBy + 声明了 touches 的任务持有文件锁：
//   - verifying 不持有（Worker 已按契约停笔，锁随 in-progress→verifying 自动释放；
//     驳回回 in-progress 时重新持有）；
//   - pending/blocked/draft 没有 Worker 在改文件，不持有。
// 返回 [{id, touches}]，id 用于 blockedTouches.conflicts 展示"在等谁"。
export function holdsFiles(d) {
  var out = []
  if (!d || !Array.isArray(d.tasks)) return out
  for (var i = 0; i < d.tasks.length; i++) {
    var t = d.tasks[i]
    if (t.status === 'in-progress' && t.claimedBy && Array.isArray(t.touches) && t.touches.length) out.push({ id: t.id, touches: t.touches })
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
export function pickDispatch(d, capW, capV, busyTaskIds) {
  var blockedTouches = []
  var pendings = []
  // 锁持有集合在本轮内动态增长：一旦某候选被纳入本轮派发，它立即成为持有者，
  // 防止同一轮 cycle 派出的两个任务声明重叠 touches。
  var holds = holdsFiles(d)
  if (capW > 0) {
    var cands = d.tasks.filter(function (t) { return t.status === 'pending' && !t.claimedBy && !t.frozen && t.assignMode !== 'manual' && t.pipeline !== 'direct' && depsSatisfied(d, t) && !t.escalation })
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
// 孤儿回收判定：in-progress 且 claimedBy 非主会话、无活跃 run、无 escalation、超 2 分钟
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
//   或 files 列了路径但全部不存在（exists 回调判定，锚点 :L 段先剥掉再查——存在性是对文件而言的）。
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
      var anyExist = files.some(function (p) { try { return !!exists(parseAnchorPath(p).file) } catch (_) { return false } })
      if (!anyExist) reason = '预研文件路径全部不存在（注入将全是读取失败）'
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
