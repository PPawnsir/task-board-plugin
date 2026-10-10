// dsh-agent-board — 已结算会话清理（lib/cleanup.mjs）
// 纯函数 + node IO，不碰 ctx 与共享状态。看板内建「已结算会话清理」：
// 扫本板全部任务 runs[]，四闸筛「可删」= outcome 已落定（非 running）∧ usageRecorded=true
// ∧ 非 continuable（可续跑 Worker 会话绝不删）∧ 会话不活跃（不在活跃树/本会话血统）。
// 路径逃逸防护两道闸：① 会话 id 白名单 [A-Za-z0-9_-]；② rm 前再验目标绝对路径仍在 sessions 桶内。
// 数据源（与 usage.mjs findRunLog 同源布局，2026-10 本机核对）：
//   会话日志目录：~/.dsh/sessions/<bucket>/<id>/（bucket=工作区转义目录名，id=会话 id 目录）
//   projcache 逐会话：~/.dsh/storages/session_projcache/sessions/<id>.json
//   注册表索引残留：~/.dsh/storages/session_projcache.json（宿主托管、version/seq 结构，**不清理**，
//     只文档注明残留形态——见 README「存储清理」小节）
import path from 'node:path'
import fsNode from 'node:fs'

// ===== 会话 id 安全性（路径逃逸第一道闸）=====
// 合法会话 id 只含 [A-Za-z0-9_-]：裸 UUID（5c912460-...）、session-<uuid>、import-sess_...、child-... 均符合。
// 任何出现 . / \ 等路径字符（含 ../ 逃逸、Windows \ 分隔符）的 id 一律拒。
export function isSafeSessionId(id) {
  if (typeof id !== 'string') return false
  if (!id || id.length > 200) return false
  if (id !== id.trim()) return false
  return /^[A-Za-z0-9_-]+$/.test(id)
}

// 四闸可删判定的跳过原因（稳定机器码，测试与仪表盘按它对齐）
export var SKIP_REASON_TEXT = {
  'id-invalid': '会话 id 非法（路径逃逸防护）',
  'not-settled': 'outcome 未落定',
  'not-recorded': 'usage 未记账',
  'continuable': '可续跑会话（需续命，不删）',
  'active': '会话仍活跃/属本会话血统',
}

// 单个 run 条目四闸判定：返回 { deletable:true } 或 { deletable:false, reason }。
// 闸序（先硬后软）：① id 合法 ② outcome 落定（非 running）③ usageRecorded ④ 非 continuable ⑤ 不活跃。
export function classifyRun(run, blockedIds) {
  var id = (run && typeof run.id === 'string') ? run.id : ''
  if (!isSafeSessionId(id)) return { deletable: false, reason: 'id-invalid' }
  if (!run.outcome || run.outcome === 'running') return { deletable: false, reason: 'not-settled' }
  if (run.usageRecorded !== true) return { deletable: false, reason: 'not-recorded' }
  if (run.continuable === true) return { deletable: false, reason: 'continuable' }
  if (blockedIds && blockedIds.has(id)) return { deletable: false, reason: 'active' }
  return { deletable: true }
}

// 扫全部任务 runs[]：按会话 id 聚合分类。同一 id 只要任一条不可删 → 整组不可删（宁漏勿错删）。
// 返回 { items: [{ id, taskId, role }], skipped: [{ id, taskId, reason, text }] }
export function scanDeletable(tasks, blockedIds) {
  var list = Array.isArray(tasks) ? tasks : []
  var groups = {} // id -> { id, taskId, role, runs: [] }
  var order = []
  for (var ti = 0; ti < list.length; ti++) {
    var t = list[ti]
    if (!t || !Array.isArray(t.runs)) continue
    for (var ri = 0; ri < t.runs.length; ri++) {
      var r = t.runs[ri]
      if (!r || typeof r.id !== 'string' || !r.id) continue
      var g = groups[r.id]
      if (!g) { g = groups[r.id] = { id: r.id, taskId: t.id, role: r.role || '', runs: [] }; order.push(r.id) }
      g.runs.push(r)
    }
  }
  var items = []
  var skipped = []
  for (var oi = 0; oi < order.length; oi++) {
    var id = order[oi]
    var grp = groups[id]
    var reason = null
    for (var k = 0; k < grp.runs.length; k++) {
      var c = classifyRun(grp.runs[k], blockedIds)
      if (!c.deletable) { reason = c.reason; break }
    }
    if (reason === null) items.push({ id: id, taskId: grp.taskId, role: grp.role })
    else skipped.push({ id: id, taskId: grp.taskId, reason: reason, text: SKIP_REASON_TEXT[reason] || reason })
  }
  return { items: items, skipped: skipped }
}

// ===== 体积估算（只读，绝不写盘）=====
// 递归目录体积（字节）：不存在/读不到返回 0，绝不抛错
export function dirSizeOf(p) {
  try {
    var st = fsNode.statSync(p)
    if (!st.isDirectory()) return 0
  } catch (_) { return 0 }
  var total = 0
  var stack = [p]
  while (stack.length) {
    var cur = stack.pop()
    var entries
    try { entries = fsNode.readdirSync(cur, { withFileTypes: true }) } catch (_) { continue }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]
      var fp = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(fp)
      else { try { total += fsNode.statSync(fp).size } catch (_) {} }
    }
  }
  return total
}

export function fileSizeOf(p) {
  try { return fsNode.statSync(p).size } catch (_) { return 0 }
}

// 定位会话目录：扫 sessionsRoot 下所有桶，返回 <bucket>/<id> 目录路径（存在才返回），否则 null
export function findSessionDir(id, sessionsRoot) {
  if (!id || !sessionsRoot) return null
  try {
    var buckets = fsNode.readdirSync(sessionsRoot)
    for (var i = 0; i < buckets.length; i++) {
      var cand = path.join(sessionsRoot, buckets[i], id)
      try { if (fsNode.statSync(cand).isDirectory()) return cand } catch (_) {}
    }
  } catch (_) {}
  return null
}

// 一次性扫 sessionsRoot 建 id → 目录路径 索引：3423 会话量级下 preview 只扫一遍桶，
// 避免「每个可删项都 readdirSync 整棵 sessions 树」的 O(N×M) 重复读盘。
export function buildSessionDirIndex(sessionsRoot) {
  var idx = {}
  if (!sessionsRoot) return idx
  try {
    var buckets = fsNode.readdirSync(sessionsRoot)
    for (var i = 0; i < buckets.length; i++) {
      var bdir = path.join(sessionsRoot, buckets[i])
      var entries
      try { entries = fsNode.readdirSync(bdir) } catch (_) { continue }
      for (var j = 0; j < entries.length; j++) {
        var fp = path.join(bdir, entries[j])
        try { if (fsNode.statSync(fp).isDirectory()) idx[entries[j]] = fp } catch (_) {}
      }
    }
  } catch (_) {}
  return idx
}

// 路径仍在根内判定（路径逃逸第二道闸）：relative 不以 .. 开头、不是绝对路径、且不等于根本身
export function isWithin(root, p) {
  if (!root || !p) return false
  var rel = path.relative(root, p)
  if (rel === '') return false // 目标 == 根本身 → 拒绝（绝不删整个桶）
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && rel.indexOf('..' + path.sep) !== 0
}

// ===== preview：dry-run，只读盘估体积、绝不删任何文件 =====
// opts.roots = { sessions: '<home>/.dsh/sessions', projcacheDir: '<home>/.dsh/storages/session_projcache/sessions' }
// 返回 { total, totalBytes, items: [{id,taskId,role,bytes,sessionDir,projcachePath}], skipped, byTask }
export function previewCleanup(tasks, opts) {
  opts = opts || {}
  var roots = opts.roots || {}
  var sessionsRoot = roots.sessions
  var projcacheDir = roots.projcacheDir
  var list = Array.isArray(tasks) ? tasks : []
  var titleById = {}
  for (var ti = 0; ti < list.length; ti++) { if (list[ti] && list[ti].id) titleById[list[ti].id] = list[ti].title || list[ti].id }
  var scan = scanDeletable(list, opts.blockedIds)
  var dirIndex = buildSessionDirIndex(sessionsRoot)
  var items = []
  var totalBytes = 0
  var byTask = {}
  for (var i = 0; i < scan.items.length; i++) {
    var it = scan.items[i]
    var dir = dirIndex[it.id] || null
    var dirBytes = dir ? dirSizeOf(dir) : 0
    var pcPath = projcacheDir ? path.join(projcacheDir, it.id + '.json') : null
    var pcBytes = pcPath ? fileSizeOf(pcPath) : 0
    var bytes = dirBytes + pcBytes
    totalBytes += bytes
    items.push({ id: it.id, taskId: it.taskId, role: it.role, bytes: bytes, sessionDir: dir, projcachePath: (pcPath && pcBytes > 0) ? pcPath : null })
    var bk = byTask[it.taskId] || (byTask[it.taskId] = { taskId: it.taskId, title: titleById[it.taskId] || it.taskId, count: 0, bytes: 0 })
    bk.count++; bk.bytes += bytes
  }
  return { total: items.length, totalBytes: totalBytes, items: items, skipped: scan.skipped, byTask: Object.keys(byTask).map(function (k) { return byTask[k] }) }
}

// ===== run：真删（confirm 执行）=====
// 每个目标删前再验 isSafeSessionId + isWithin（路径逃逸第二道闸）。会话目录 rm recursive；
// projcache json rm force。返回 { deleted, deletedIds, freedBytes, skipped }
export async function runCleanup(items, opts) {
  opts = opts || {}
  var roots = opts.roots || {}
  var sessionsRoot = roots.sessions
  var projcacheDir = roots.projcacheDir
  var list = Array.isArray(items) ? items : []
  var deletedIds = []
  var freedBytes = 0
  var skipped = []
  for (var i = 0; i < list.length; i++) {
    var it = list[i]
    if (!it || !isSafeSessionId(it.id)) { skipped.push({ id: it && it.id, reason: 'id-invalid' }); continue }
    var dir = it.sessionDir
    var pcPath = it.projcachePath
    // 先验两道路径逃逸（删前整体校验，避免「删了一半才发现另一条逃逸」）
    if (dir && !isWithin(sessionsRoot, dir)) { skipped.push({ id: it.id, reason: 'path-escape' }); continue }
    if (pcPath && projcacheDir && !isWithin(projcacheDir, pcPath)) { skipped.push({ id: it.id, reason: 'path-escape' }); continue }
    var freed = 0
    // 删会话目录（核心目标；失败则整项算跳过，绝不误报成功）
    if (dir) {
      try { var db = dirSizeOf(dir); await fsNode.promises.rm(dir, { recursive: true, force: true }); freed += db } catch (e) { skipped.push({ id: it.id, reason: 'rm-failed' }); continue }
    }
    // 删 projcache json（best-effort：删不掉不阻断主目标）
    if (pcPath && projcacheDir) {
      try { var pb = fileSizeOf(pcPath); await fsNode.promises.rm(pcPath, { force: true }); freed += pb } catch (_) { /* projcache 删不掉不阻断主目标 */ }
    }
    deletedIds.push(it.id)
    freedBytes += freed
  }
  return { deleted: deletedIds.length, deletedIds: deletedIds, freedBytes: freedBytes, skipped: skipped }
}
