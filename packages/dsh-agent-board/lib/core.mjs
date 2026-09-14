// dsh-agent-board — 纯逻辑核心（lib/core.mjs）
// 不依赖任何 ctx/服务/IO：任务状态机、依赖校验、管线分类、prompt 构建、输出解析。
// index.mjs（IO 编排层）从这里 import；单元测试直接跑本文件（node --test）。

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
export function cfg(d) { return { minWorkers: Math.max(0, Math.min(10, d.minWorkers || 1)), maxWorkers: Math.max(1, Math.min(10, d.maxWorkers || 3)), minVerifiers: Math.max(0, Math.min(5, d.minVerifiers || 0)), maxVerifiers: Math.max(0, Math.min(5, d.maxVerifiers || 2)) } }

// ===== 看板文件种子 =====
export function seed(sid) { return { version: 11, ownerSession: sid, boardMode: 'auto', teamMode: false, minWorkers: 1, maxWorkers: 3, minVerifiers: 0, maxVerifiers: 2, verifierModel: '', tasks: [] } }

// ===== 状态流转 =====
export function claimCheck(d, t, sid) { if (CLAIMABLE.indexOf(t.status) < 0) return 'cannot claim in ' + t.status; if (t.claimedBy && t.claimedBy !== sid && t.status === 'in-progress') return 'claimed by ' + t.claimedBy; if (d.boardMode === 'manual' || t.assignMode === 'manual') { if (t.assignee && t.assignee !== sid) return 'assigned to ' + t.assignee }; if (isb(t)) { var p = gpt(t, d.tasks); if (!p) return 'parent not found'; if (p.status !== 'in-progress' && p.status !== 'verifying') return 'parent not in-progress' }; var mc = d.tasks.filter(function (x) { return x.claimedBy === sid && (x.status === 'in-progress' || x.status === 'verifying') && !isb(x) }); if (!isb(t) && mc.length >= MAX_CLAIMED) return 'max ' + MAX_CLAIMED + ' active'; return null }
export function claimApply(d, t, sid, note) { var ps = t.status; t.status = 'in-progress'; t.claimedBy = sid; t.claimedAt = new Date().toISOString(); ah(t, ps, 'in-progress', sid, note) }
export function checkParentAuto(d, t) { if (!isb(t)) return null; var p = gpt(t, d.tasks); if (!p || p.status !== 'in-progress') return null; var s = gsb(p.id, d.tasks); if (s.every(function (x) { return x.status === 'resolved' })) { p.status = 'verifying'; p.resolvedAt = new Date().toISOString(); p.resolution = 'all subtasks resolved'; ah(p, 'in-progress', 'verifying', 'system', 'auto: all subtasks resolved'); return p }; return null }
export function resolveApply(d, t, sid, status, resolution, note) { var ps = t.status; if (status === 'verifying' && t.pipeline && t.pipeline !== 'full') { status = 'resolved' } t.status = status; t.resolution = resolution || null; t.resolvedAt = new Date().toISOString(); ah(t, ps, status, sid, note); var r = { ok: true, task: t }; if (status === 'verifying' && isb(t)) { var s = gsb(t.parentId, d.tasks); if (s.every(function (x) { return x.status === 'resolved' || x.id === t.id })) { var p = gpt(t, d.tasks); if (p && p.status === 'in-progress') { p.status = 'verifying'; p.resolvedAt = new Date().toISOString(); p.resolution = 'all subtasks done'; ah(p, 'in-progress', 'verifying', 'system', 'auto'); r.parentUpdated = true } } }; return r }
export function verifyApply(d, t, sid, verdict, comment) { var ps = t.status; if (verdict === 'approved') { t.status = 'resolved'; t.verifiedAt = new Date().toISOString(); t.verifiedBy = sid; ah(t, ps, 'resolved', sid, 'approved' + (comment ? ': ' + comment : '')) } else { t.status = 'in-progress'; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'in-progress', sid, 'rejected' + (comment ? ': ' + comment : '')) }; var r = { ok: true, task: t }; if (verdict === 'approved' && isb(t)) { var p = checkParentAuto(d, t); if (p) { r.parentUpdated = true } }; return r }

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

// ===== 一次性子代理 prompt 构建（上下文全量注入——子代理无会话记忆）=====
// 过程记录注入：驳回/裁决/干预历史随 prompt 带给一次性子代理
export function histNotes(t) { return (t.history || []).filter(function (h) { return h.note && (/歧义|裁决|驳回|干预|rejected/i.test(h.note)) }).map(function (h) { return '- [' + h.timestamp + '] ' + String(h.note).slice(0, 300) }).join('\n') }
export function buildWorkerPrompt(t) {
  var notes = histNotes(t)
  return '你是一个一次性任务执行 Worker。完成下面这个任务，完成后本会话即销毁。\n\ntaskId: ' + t.id + '\n任务: ' + t.title + '\n描述: ' + (t.description || '') + '\n指引: ' + ((t.context && t.context.instructions) || '') + (t.acceptance ? '\n硬性验收脚本: ' + t.acceptance + '\n（必须实际运行该命令并在自测情况中粘贴真实输出；未通过不得上报完成）' : '') + (notes ? '\n\n该任务的过程记录（歧义上报/主窗口裁决/驳回/干预，请务必遵循最新裁决方向）：\n' + notes : '') + '\n\n完成契约（双模，工具优先）：\n1. 完成时：优先调用 board_report 工具（kind=complete, taskId=' + t.id + '，summary=开发描述/changes=改动清单/selfTest=自测情况）；工具不可用则按分段格式输出（## 开发描述 / ## 改动清单 / ## 自测情况）。\n2. 歧义/信息不足/需用户决策时：优先调用 board_report（kind=escalate, taskId=' + t.id + ', question=疑问）；工具不可用则输出以 [ESCALATE] 开头的说明。不要猜测。上报歧义后直接结束本轮——裁决后会有新 Worker 带着裁决答案接手。'
}
export function buildVerifierPrompt(t) {
  var notes = histNotes(t)
  return '你是一个一次性任务审核 Verifier。审查下面这个任务的完成质量，给出结论后本会话即销毁。\n\ntaskId: ' + t.id + '\n任务: ' + t.title + '\n描述: ' + (t.description || '').slice(0, 500) + '\n完成说明: ' + (t.resolution || '(无)') + '\n交付物: ' + (t.deliverable ? ('开发描述: ' + (t.deliverable.summary || '') + '\n改动清单: ' + (t.deliverable.changes || '') + '\n自测情况: ' + (t.deliverable.selfTest || '')) : '(无)').slice(0, 1500) + (t.acceptance ? '\n硬性验收脚本: ' + t.acceptance + '\n（必须独立复跑该命令并把真实输出贴进核对项；脚本失败必须 REJECTED）' : '') + (notes ? '\n\n该任务的过程记录（歧义上报/主窗口裁决/驳回/干预，若有）：\n' + notes + '\n注意：若过程记录显示主窗口已裁决改变任务方向，以裁决后的方向为验收标准。' : '') + '\n\n结论契约（双模，工具优先）：\n1. 优先调用 board_verdict 工具（taskId=' + t.id + ', verdict=approved/rejected, summary=测试概要, checks=逐条核对证据含行号）。\n2. 工具不可用则首行 APPROVED: <结论> 或 REJECTED: <结论>，然后 ## 测试概要 / ## 核对项 分段。'
}

// ===== 派发决策（纯函数版，poolCycle 持锁段调用）=====
// 返回 { pendings, verifs }：按优先级排序的可派发任务清单
export function pickDispatch(d, capW, capV, busyTaskIds) {
  var pendings = capW > 0 ? d.tasks.filter(function (t) { return t.status === 'pending' && !t.claimedBy && t.assignMode !== 'manual' && t.pipeline !== 'direct' && depsSatisfied(d, t) && !t.escalation })
    .sort(function (a, b) { var p = (PRIO_RANK[b.priority] || 2) - (PRIO_RANK[a.priority] || 2); return p !== 0 ? p : (a.createdAt || '').localeCompare(b.createdAt || '') }).slice(0, capW) : []
  var verifs = capV > 0 ? d.tasks.filter(function (t) { return t.status === 'verifying' && (!t.pipeline || t.pipeline === 'full') && !t.escalation && !(busyTaskIds && busyTaskIds[t.id]) }).slice(0, capV) : []
  return { pendings: pendings, verifs: verifs }
}
// 孤儿回收判定：in-progress 且 claimedBy 非主会话、无活跃 run、无 escalation、超 2 分钟
export function isOrphan(d, t, runs, now) {
  return t.status === 'in-progress' && t.claimedBy && t.claimedBy !== d.ownerSession && !(runs && runs[t.id]) && !t.escalation && (now - new Date(t.claimedAt || 0).getTime()) > 120000
}
