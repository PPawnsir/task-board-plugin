// dsh-agent-board — Agent 任务看板（host 端）
// 本文件即源码，直接维护（v68 起：变形层已拆除，不再从其他文件生成）。
//
// 零外部依赖：link: 安装的包从真实路径解析，裸 import '@deepseek-ai/dsh-tools'
// 会解析失败（ERR_MODULE_NOT_FOUND）。defineTool 本体只是 校验+包装 出
// {name, description, parameters, output, execute} 普通对象，这里内联等价实现。
// parameters 已是完整 JSON Schema，原样透传；output 透传 schema+render。
import * as core from './lib/core.mjs'
import { zstdDecompressSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import fsNode from 'node:fs'
const { ah, isb, gsb, gpt, vt, validateDeps, depsSatisfied, depsCancelled, classifyPipeline, seed, normalizeBoard, cfg, claimCheck, claimApply, checkParentAuto, resolveApply, verifyApply, parseSections, parseVerdict, isEscalation, outputText, histNotes, buildContextPackSection, buildWorkerPrompt, buildVerifierPrompt, pickDispatch, isOrphan, PRIO_RANK, patOverlap, overlapsTouches, touchesConflict, holdsFiles, lessonText, pushLesson, LESSON_RECALL_HINT, boardHome, parseAnchorPath, sliceLines, buildFileOutline } = core

function defineTool(options) {
  var userExecute = options.execute
  var userRender = options.output && options.output.render
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: userRender ? function (args, value) { return userRender(args, value) } : undefined,
    },
    execute: function (args, exec) { return userExecute(args, exec) },
  }
}

// ===== 任务粒度治理（全软方案：只引导/提示，绝不阻断创建与派发）=====
// 背景：agent 容易把史诗级大任务整坨塞进看板（长程 + 跑偏风险 + 返工成本高）。
// 落地三件套（都不带硬闸门）：
//   1) task_create 工具描述里的粒度契约 TASK_SIZE_CONTRACT；
//   2) Team 模式系统提示词第 6 条 TEAM_SPLIT_RULE（epic 父卡 + 子任务 + checkParentAuto 收尾）；
//   3) create-task RPC / task_create 工具返回体命中时附加 suggestSplit 一行建议（不落盘、不改状态）。
export var TASK_SIZE_CONTRACT = '建议粒度：单任务 10~30 分钟可独立完成。超出此范围的大任务请先拆分——建一张 epic 卡（parentId 体系）再挂子任务，别整坨塞进来。'
export var SUGGEST_SPLIT_TEXT = '任务看起来偏大（建议单任务 10~30 分钟）：考虑拆分子任务（parentId）或收窄边界'
// Team 模式提示词第 6 条：大任务的 epic 拆分流程（父卡 pipeline=direct 不派发，子任务全 resolved 后父卡由 checkParentAuto 自动转 verifying）
export var TEAM_SPLIT_RULE = '6. 大任务必须拆分：预计超过 30 分钟的任务，先建一张 epic 父卡（pipeline 传 direct，不派发），再拆成若干 10~30 分钟的子任务（task_create 传 parentId=父卡 id，有先后顺序的用 dependsOn 串联）。子任务全部完成后父卡会自动标记完成（checkParentAuto）。'
// 史诗特征词：命中即视为"整坨塞进来"的典型信号（与 TASK_SIZE_CONTRACT 配套；无 /g，可安全复用）
var EPIC_WORDS = /全量|整体|系统级|全面|重构|所有模块|整个/
// description 长度阈值（字符）：超过它说明描述密度远超"10~30 分钟单任务"应有体量
var SPLIT_DESC_LIMIT = 500
// 软闸门判定：description > 500 字符，或 title+description 命中史诗特征词 → 返回建议文案；否则返回 ''
// 纯函数、无 IO、不改任务字段——调用方拿到空串即视为粒度正常（falsy 判断即可）
export function suggestSplitOf(t) {
  var desc = String((t && t.description) || '')
  var text = String((t && t.title) || '') + ' ' + desc
  if (desc.length > SPLIT_DESC_LIMIT || EPIC_WORDS.test(text)) return SUGGEST_SPLIT_TEXT
  return ''
}
// 统一出口：只在命中时附加字段，老调用方拿到的返回体形态完全不变（多一个可选字段而已）
export function withSplitHint(out, t) {
  var hint = suggestSplitOf(t)
  if (hint && out && typeof out === 'object') out.suggestSplit = hint
  return out
}

// ===== Token 消耗统计（v4 会话日志 usage 聚合）=====
// 数据源：Worker/Verifier 一次性子会话的 v4 追加写日志
//   ~/.dsh/sessions/<bucket>/<childSessionId>/session.v4.jsonl.zstd
// 字段形状（用本机真实日志逐帧核对后确认，2026-10）：
//   type === 'assistant/message' 的事件带 data.usage =
//     { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
//   模型名不在 assistant/message 上，而在同会话的 request/context（data.model，
//   与 request/header 的 data.header.config.model 同源）——模型小计以日志记录的为准。
// 定位/分帧逻辑与 agent-activity RPC 共用（同一套日志名探测 + zstd 帧头切分），
// 区别只是 usage 要扫全部帧、activity 只看最新几帧。
// 约束：只做展示、不做计费断言；读不到日志/无 usage 一律返回 null（调用方降级为「暂无数据」），绝不抛错。
var USAGE_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd']
var ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// 定位某个 run（子会话 id）的日志文件：bucket × 版本名逐个探测（新版本名优先）；找不到/不可读返回 null
export function findRunLog(runId, sessionsRoot) {
  if (!runId) return null
  try {
    var root = sessionsRoot || path.join(os.homedir(), '.dsh', 'sessions')
    var buckets = fsNode.readdirSync(root)
    for (var bi = 0; bi < buckets.length; bi++) {
      for (var ni = 0; ni < USAGE_LOG_NAMES.length; ni++) {
        var cand = path.join(root, buckets[bi], String(runId), USAGE_LOG_NAMES[ni])
        if (fsNode.existsSync(cand)) return cand
      }
    }
  } catch (_) {}
  return null
}

// 读日志字节：tailBytes > 0 时只读末尾这么多字节（activity 热路径用），否则读整份（usage 结算用）。
// 尾部截断可能切在帧中间，交给 readLogFrames 逐帧 try/catch 降级。
function readLogBytes(logPath, tailBytes) {
  try {
    var sz = fsNode.statSync(logPath).size
    var start = (tailBytes > 0 && sz > tailBytes) ? sz - tailBytes : 0
    var buf = Buffer.alloc(sz - start)
    var fd = fsNode.openSync(logPath, 'r')
    try { fsNode.readSync(fd, buf, 0, buf.length, start) } finally { fsNode.closeSync(fd) }
    return buf
  } catch (_) { return null }
}

// 追加写多帧格式：按帧头 MAGIC 切段、逐帧解压、逐行 JSON.parse。
// 返回帧数组（从新到旧），每帧是事件数组（保持帧内原序）；limit > 0 只取最新 limit 帧。
// 坏帧/半帧（强杀截断、MAGIC 假命中、尾部切在压缩流中间）整帧跳过，绝不抛错。
function readLogFrames(buf, limit) {
  var out = []
  if (!buf || !buf.length) return out
  var offs = []
  var at = buf.indexOf(ZSTD_MAGIC)
  while (at >= 0) { offs.push(at); at = buf.indexOf(ZSTD_MAGIC, at + 1) }
  for (var k = offs.length - 1; k >= 0; k--) {
    if (limit > 0 && out.length >= limit) break
    var end = k + 1 < offs.length ? offs[k + 1] : buf.length
    var evs = []
    try {
      var text = zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8')
      var lines = text.split('\n')
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i]) continue
        try { evs.push(JSON.parse(lines[i])) } catch (_) {}
      }
    } catch (_) { continue }
    out.push(evs)
  }
  return out
}

// 聚合一次 run 的全部 token 消耗：{input, output, cacheRead, cacheWrite, total, model}。
// 逐帧扫 assistant/message 的 data.usage 累加（无 usage 的事件跳过、没有 usage 事件返回 null）。
// total 优先取日志自带的 totalTokens，缺失时才用 输入+输出+缓存读+缓存写 兜底。
export function readRunUsage(runId, sessionsRoot) {
  try {
    var log = findRunLog(runId, sessionsRoot)
    if (!log) return null
    // 整份读取：usage 必须全量累加（单次 run 日志量级 MB，结算时只读一次）。
    // 极端超大日志封顶 64MB——只丢最老的历史帧，好过结算路径被一次同步 IO 拖住。
    var buf = readLogBytes(log, 64 * 1024 * 1024)
    if (!buf) return null
    var frames = readLogFrames(buf, 0)
    var out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, model: '' }
    var hasUsage = false
    for (var fi = 0; fi < frames.length; fi++) {
      var evs = frames[fi]
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i]; var dta = (e && e.data) || {}
        if (e && e.type === 'request/context' && dta.model && !out.model) out.model = String(dta.model)
        if (!e || e.type !== 'assistant/message') continue
        var u = dta.usage
        if (!u) continue
        var inp = numOr0(u.inputTokens), outp = numOr0(u.outputTokens)
        var cr = numOr0(u.cacheReadTokens), cw = numOr0(u.cacheWriteTokens)
        out.input += inp; out.output += outp; out.cacheRead += cr; out.cacheWrite += cw
        out.total += numOr0(u.totalTokens) || (inp + outp + cr + cw)
        hasUsage = true
      }
    }
    return hasUsage ? out : null
  } catch (e) {
    // 日志解析失败一律降级：usage 只是展示统计，绝不影响结算与状态流转
    console.error('[task-board] readRunUsage failed (' + runId + '):', String(e))
    return null
  }
}
function numOr0(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0 }

// board 级聚合（get-tasks 现算，不落盘额外表）：总量 + 输入/输出/缓存读拆分 + 按模型小计 + 任务 Top8。
// 归档任务同样计入（它们确实消耗过 token）；无 usage 的任务跳过。
export function aggregateUsageSummary(tasks) {
  var s = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {}, topTasks: [] }
  var list = Array.isArray(tasks) ? tasks : []
  for (var i = 0; i < list.length; i++) {
    var t = list[i]; var u = t && t.usage
    if (!u) continue
    s.total += u.total || 0; s.input += u.input || 0; s.output += u.output || 0
    s.cacheRead += u.cacheRead || 0; s.cacheWrite += u.cacheWrite || 0
    var ms = u.models || {}
    for (var mk in ms) { if (Object.prototype.hasOwnProperty.call(ms, mk)) s.byModel[mk] = (s.byModel[mk] || 0) + (ms[mk] || 0) }
    if (u.total) s.topTasks.push({ id: t.id, title: t.title, total: u.total, runs: u.runs || 0 })
  }
  s.topTasks.sort(function (a, b) { return b.total - a.total })
  s.topTasks = s.topTasks.slice(0, 8)
  return s
}

export const name = 'dsh-agent-board'
export const inject = ['fs', 'timer', 'subagents', 'agents', 'tools', 'webServer']

export function apply(ctx) {
    const fs = ctx.fs
    // RPC handlers 表必须在最前面初始化：后面的 handle(...) 调用依赖它（var 只提升声明不提升赋值）
    var handlers = {}
    function handle(method, fn) { handlers[method] = fn }

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
    var knownSessions = {}
    function touchSession(sid) { if (sid && typeof sid === 'string' && sid !== 'unknown') knownSessions[sid] = Date.now() }
    // teamMode 缓存：由 rt() 同步，供 systemPrompt 动态引导段读取（v65）
    var teamModeCache = {}
    // feedbackEnabled 缓存（学习飞轮 v1）：同样由 rt() 同步——systemPrompt 的组装是同步函数，
    // 不能在里面读文件。与 teamModeCache 同源同生命周期（引导段本来就要 teamMode 命中才渲染）。
    var feedbackCache = {}
    function feedbackOn(sid) { return feedbackCache[sid] !== false }
    // 工作模式三档收敛（UI 一维化）：内部仍存 boardMode+teamMode 两个 flag（老数据/老 RPC 无损），
    // workMode 是纯派生字段——由两 flag 算出，不落盘（normalizeBoard 无需改动）。
    //   'team' → boardMode=auto + teamMode=true（主窗口当调度员：默认草稿 + 裁决歧义）
    //   'auto' → boardMode=auto + teamMode=false（即建即派给 Worker）
    //   'list' → boardMode=manual + teamMode=false（看板=TODO 列表，手动 claim 或逐张派发）
    function deriveWorkMode(d) { return (d && d.teamMode) ? 'team' : ((d && d.boardMode) === 'auto' ? 'auto' : 'list') }
    // 看板文件用「家目录绝对路径 + node:fs」直读写——不再走 fs 服务的相对路径解析
    // （fs 服务的相对路径解析根 = 进程启动 cwd，cwd 一变所有看板静默读成空板；
    //  曾因此导致整个看板状态异常。绝对路径对此永久免疫）
    function boardPath(sid) { return path.join(boardHome(), 'tasks-' + sid + '.json') }
    function fileFor(sid) { return boardPath(sid) } // 保留旧名兼容调用点，但已是绝对路径

    // ===== 看板跨重启继承（会话根 id 漂移 → 不分裂）=====
    // 背景（看板反馈 n-mur1bmrwvoge）：DSH 重启后同一会话在宿主侧的根 id 可能变
    // （实测 55b0879a → 7b44fb23），看板按 ownerSession 分文件 → 新卡落新板，
    // 旧板（73 张卡历史）从默认视图消失，用户视角就是「看板被清空了」。
    // 归属改为「工作区」：文件里记 ownerCwd；以新 sid 访问且本 sid 无文件时，
    // 若同工作区存在**唯一**「原主已死（不在 agents.roots()）」的看板 → 接管它。
    // 防误继承三闸门：① 只认 ownerCwd 严格相等；② 原主必须不在存活 root 集合里；
    // ③ 候选必须唯一 —— 多候选一律不动（宁可留孤儿板等人工认领，也不合并错板）。
    // 触发点在 rt() 的「文件不存在」分支：工具 / RPC / UI 三通道都走 rt，天然统一受益。
    function activeRootIds() { try { var rs = ctx.agents && ctx.agents.roots(); var s = {}; if (Array.isArray(rs)) for (var i = 0; i < rs.length; i++) s[String(rs[i].id)] = true; return s } catch (_) { return {} } }
    // 找可接管的孤儿看板：返回文件名，或 null（含「多候选」——多候选刻意返回 null）
    function findAdoptableBoardFile(sid, cwd) {
      if (!cwd) return null                                  // 本会话工作区未知 → 绝不猜（猜错就是合并错板）
      var home = boardHome()
      var files
      try { files = fsNode.readdirSync(home) } catch (_) { return null }
      var alive = activeRootIds()
      var hits = []
      for (var i = 0; i < files.length; i++) {
        var f = String(files[i] || '')
        if (f.indexOf('tasks-') !== 0 || f.slice(-5) !== '.json') continue
        var owner = f.slice(6, -5)
        if (!owner || owner === sid) continue                // 本 sid 的文件不该走到这里（本函数只在「本板不存在」时调用）
        if (alive[owner]) continue                           // 原主还活着 → 不是孤儿板，绝不碰
        var d = null
        try { d = JSON.parse(fsNode.readFileSync(path.join(home, f), 'utf8')) } catch (_) { continue }
        if (!vt(d)) continue
        if (d.ownerCwd !== cwd) continue                     // 老文件没 ownerCwd（undefined）→ 天然不匹配，不会被误接管
        hits.push({ file: f, sid: owner })
      }
      if (hits.length > 1) {                                 // 多候选：记录一行但不自动动（多板并存时人工 list-boards 处理）
        console.error('[task-board] 继承跳过：工作区 ' + cwd + ' 有 ' + hits.length + ' 个候选孤儿板（' + hits.map(function (h) { return h.sid }).join(', ') + '），不自动接管')
        return null
      }
      return hits.length === 1 ? hits[0] : null
    }
    // 瞬时占用白名单（与 wt() 同款）：Windows 上 rename/unlink 的目标名被并发读句柄、Defender、
    // 索引器短暂占用时会抛这几个码——退避后重试即可；其它错误（跨设备 EXDEV、只读等）立即放弃。
    var TRANSIENT_FS = { EPERM: 1, EBUSY: 1, ENOTEMPTY: 1, EACCES: 1 }
    function isTransientFs(e) { return !!(e && TRANSIENT_FS[e.code]) }
    // rename 退避重试：成功 true；非瞬时错误或重试耗尽 false（由调用方决定降级/回滚）
    async function renameRetry(from, to, tries) {
      var n = tries || 6
      for (var i = 0; i < n; i++) {
        try { await fsNode.promises.rename(from, to); return true }
        catch (e) {
          if (!isTransientFs(e) || i === n - 1) { console.error('[task-board] rename failed (' + from + ' -> ' + to + '):', String(e)); return false }
          await new Promise(function (r) { setTimeout(r, 60 * (i + 1)) })
        }
      }
      return false
    }
    // unlink 退避重试：ENOENT 视为已达成；重试耗尽返回 false（调用方记一行日志，不再阻断继承）
    async function unlinkRetry(p, tries) {
      var n = tries || 6
      for (var i = 0; i < n; i++) {
        try { await fsNode.promises.unlink(p); return true }
        catch (e) {
          if (e && e.code === 'ENOENT') return true
          if (!isTransientFs(e) || i === n - 1) { console.error('[task-board] unlink failed (' + p + '):', String(e)); return false }
          await new Promise(function (r) { setTimeout(r, 60 * (i + 1)) })
        }
      }
      return false
    }
    // 接管落盘：两条路径，都保证「接管后看板目录里只剩新 sid 那一个文件」（不残留 .adopt-/.tmp 之类残件——
    // 残留一份含全部历史卡的旧板 = 用户磁盘上多一份完整看板，下次继承还会把它算成候选）。
    //   ① 主路径 rename(p → np)：原子、复用 wt() 同款 EPERM/EBUSY 退避重试。注意 rename 只搬内容，
    //      文件里 ownerSession 仍写着旧 sid，所以必须紧接着用 wt() 把改写后的内容原子写回 np；
    //      写回失败则把文件改名退回 p —— 绝不留下「名字是新 sid、内容写着旧主」的半成品（否则 rt()
    //      读到 ownerSession 不匹配会退回空板，用户视角仍是「看板被清空」）。
    //   ② 兜底 rename 走不通（跨设备/顽固占用）→ wt() 写新板 + unlinkRetry 删旧板。先写后删：
    //      任何时刻磁盘上至少有一份完整看板。
    async function adoptBoard(sid, cand, cwd) {
      var p = boardPath(cand.sid), np = boardPath(sid)
      // 目标名已被占用 → 绝不接管（防覆盖：本会话看板若只是「这一刻读不到」，覆盖等于把本板换成孤儿板）
      if (cand.sid === sid || fsNode.existsSync(np)) return false
      var c = null
      try { c = JSON.parse(await fsNode.promises.readFile(p, 'utf8')) } catch (e) { console.error('[task-board] 继承失败（读旧板）:', String(e)); return false }
      if (!vt(c)) return false
      c.ownerSession = sid
      if (typeof cwd === 'string' && cwd) c.ownerCwd = cwd
      if (await renameRetry(p, np)) {                            // ① 主路径：先改名，再把 ownerSession 改写写回
        try {
          await wt(sid, c)
          console.error('[task-board] 继承看板 ' + cand.sid + ' → ' + sid + '（工作区 ' + cwd + '，原主已不在 roots）')
          return true
        } catch (e) {
          console.error('[task-board] 继承失败（改写 ownerSession）:', String(e))
          await renameRetry(np, p)                               // 回滚到旧名：下次 rt 还能再试，且不留半成品
          return false
        }
      }
      try { await wt(sid, c) } catch (e) { console.error('[task-board] 继承失败（写新板）:', String(e)); return false }
      await unlinkRetry(p)
      console.error('[task-board] 继承看板 ' + cand.sid + ' → ' + sid + '（工作区 ' + cwd + '，原主已不在 roots；rename 不通，走写新+删旧）')
      return true
    }
    async function rt(sid) {
      var r = null
      try { r = await fsNode.promises.readFile(boardPath(sid), 'utf8') } catch (e) {
        // 只有「文件确实不存在（ENOENT）」才触发继承：EACCES/EPERM/被占 等说明本会话看板很可能存在、
        // 只是这一刻读不到——此时去接管会把别的板写到本会话文件名上（改前行为只是内存空板，不落盘）。
        if (!e || e.code !== 'ENOENT') { console.error('[task-board] 读看板失败（不触发继承）: ' + boardPath(sid) + ' :: ' + String(e)); return seedNoPersist(sid) }
        // 本 sid 无看板文件：先试「同工作区唯一孤儿板」继承，接不到才种新板（种板即带 ownerCwd，供下次重启继承）
        try {
          var cwd0 = sessionCwd(sid)
          var cand = findAdoptableBoardFile(sid, cwd0)
          if (cand && await adoptBoard(sid, cand, cwd0)) r = await fsNode.promises.readFile(boardPath(sid), 'utf8')
        } catch (e2) { console.error('[task-board] 继承流程异常（降级为空板）:', String(e2)) }
        if (r === null) return seed(sid, sessionCwd(sid))
      }
      try {
        var d = JSON.parse(r)
        if (vt(d) && d.ownerSession === sid) {
          teamModeCache[sid] = !!d.teamMode; var nd = normalizeBoard(d); feedbackCache[sid] = nd.feedbackEnabled !== false
          // ownerCwd 回填（只改内存，随下一次写盘落盘）：老看板文件没有该字段，而继承判定靠它——
          // 不写盘就永远不能匿名继承。这里不额外做 IO，避免把只读路径变成写路径。
          if (!nd.ownerCwd) { var cw = sessionCwd(sid); if (cw) nd.ownerCwd = cw }
          return nd
        }
        return seed(sid, sessionCwd(sid))
      } catch (_) {
        // JSON 截断/损坏（如强杀打断写盘）：隔离留档再种新板——数据不丢，坏文件也不反复 poison
        console.error('[task-board] board file corrupt, quarantining: ' + boardPath(sid))
        fsNode.promises.rename(boardPath(sid), boardPath(sid) + '.corrupt-' + Date.now()).catch(function () {})
        return seedNoPersist(sid)
      }
    }
    // 瞬时读失败/坏文件隔离后的空板必须禁止回写：否则一个「读不到」的瞬间就会把 106 张卡覆成空板。
    // __noPersist 用 non-enumerable 挂载——即使将来有路径漏判把它写出去，JSON.stringify 也会跳过该字段。
    function seedNoPersist(sid) { var d = seed(sid, sessionCwd(sid)); try { Object.defineProperty(d, '__noPersist', { value: true, enumerable: false }) } catch (_) {} return d }
    // 原子写盘：先写临时文件再 rename——强杀若发生在写盘中途，磁盘上最多留个 .tmp 残件，
    // 看板本体永远不会是截断的半个 JSON（此前非原子直写，kill 中写 = 看板被 seed 清空）
    // Windows 特有问题：rename 目标被并发读句柄/Defender/索引器短暂占用时抛 EPERM/EBUSY
    // （E2E 实测：GUI 3s 轮询 + 脚本 10s 轮询下偶发，publish 写入整个丢失）。
    // 对这类瞬时占用做有限退避重试；其他错误（只读/不存在目录等）直接抛。
    async function wt(sid, d) {
      var c = JSON.stringify(d); var p = boardPath(sid); var tmp = p + '.tmp'
      var lastErr = null
      for (var attempt = 0; attempt < 6; attempt++) {
        try { await fsNode.promises.writeFile(tmp, c, 'utf8'); await fsNode.promises.rename(tmp, p); return }
        catch (e) {
          lastErr = e
          var code = e && e.code
          if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES') {
            await new Promise(function (r) { setTimeout(r, 60 * (attempt + 1)) })
            continue
          }
          console.error('[task-board] write:', String(e)); throw e
        }
      }
      console.error('[task-board] write: retry exhausted (6 次) ->', String(lastErr)); throw lastErr
    }
    // 每会话一条 promise 链，串行化所有 读-改-写，消除并发写竞争
    var fileLocks = {}
    function withLock(sid, fn) { var prev = fileLocks[sid] || Promise.resolve(); var p = prev.then(function () { return fn() }); fileLocks[sid] = p.catch(function () {}); return p }
    // 便捷：串行的 读→mutate→写。mutate(d) 返回值作为结果；mutate 返回 null/undefined 则不写
    // 写成功后异步触发一次 poolCycle（派发/回收反应快），按会话去抖避免连环触发
    var cyclePending = {}
    function kickCycle(sid) { if (cyclePending[sid]) return; cyclePending[sid] = true; var tm = ctx.timer; var go = function () { cyclePending[sid] = false; poolCycle(sid).catch(function () {}) }; if (tm) tm.timeout(50).then(go); else Promise.resolve().then(go) }
    function mutateLocked(sid, mutate, skipKick) { return withLock(sid, async function () { var d = await rt(sid); if (d && d.__noPersist) { console.error('[task-board] 看板暂时不可读，拒绝在空板上覆写（防瞬时读失败清板）: ' + sid); return { ok: false, error: '看板暂时不可读，请重试' } } var r = await mutate(d); if (r !== null && r !== undefined) { await wt(sid, d); if (!skipKick) kickCycle(sid); return r } return r }) }
    function jo() { return { schema: { type: 'object', additionalProperties: true }, render: function (a, v) { return [{ type: 'text', text: JSON.stringify(v, null, 2) }] } } }
    // touches（文件级排他声明）归一化：非字符串项过滤掉，空数组 = 不声明（无锁语义）。
    // 上限 20 条，与 contextFiles 上限一致，防止 prompt/看板文件被超长清单撑爆。
    function normTouches(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x.trim() }).slice(0, 20).map(function (x) { return x.trim() }) : [] }
    // 按会话找 root agent（静态插件挂 host 层后多会话共存，不能"取第一个"——会把 worker 挂到别的会话上）
    function rootForSession(sid) { var s = ctx.agents; if (!s) return undefined; var r = s.roots(); for (var i = 0; i < r.length; i++) { if (String(r[i].id) === sid) return r[i] } return undefined }
    function makeSignal() { try { return new AbortController().signal } catch (_) { return { aborted: false, addEventListener: function () {}, removeEventListener: function () {} } } }
    // makeMsg 支持插件来源标记（参考 dsh-notes 派发模式）：
    // form 'recall' = 背景回执（召回上下文，非指令）；'notice' = 需注意的通知（带一行 summary）
    // 不再用 kind:'user'——插件消息不该冒充用户在说话，模型可据 form 正确理解语义
    // v0.1.7 起会话日志为 format v4：source.kind 必须是「生产者自有 kind」，kind:'plugin'
    // 是已退役的 v3 包装写法，落盘时 persistence 直接抛 SessionFormatError
    // （format v4 message requires a producer-owned source kind）并连带炸掉主窗口当前轮次。
    // v3→v4 迁移把 {kind:'plugin',plugin:'dsh-agent-board'} 映射为 {kind:'plugin:dsh-agent-board'}，
    // 这里直接写迁移后的形态，与存量历史一致；form/summary 作为 source 元数据字段保留。
    function makeMsg(text, form, summary) { var src = { kind: 'plugin:dsh-agent-board' }; if (form) { src.form = form; if (form === 'notice' && summary) src.summary = summary }; return { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), role: 'user', content: [{ type: 'text', text: text }], source: src } }
    // 超时保护：run 挂死时走失败重试路径
    function withTimeout(promise, ms, label) { var timer = ctx.timer; if (!timer) return promise; return Promise.race([promise, timer.timeout(ms).then(function () { throw new Error(label + ' timeout ' + ms + 'ms') })]) }

    // ===== 学习飞轮 v1：候选教训信号（只产信号，不做存储）=====
    // 看板在这里只做一件事：把「Verifier 驳回 / 主窗口仲裁结论」变成一条结构化的候选教训，
    // 落进 t.messages（kind='lesson-candidate'：详情页可见 + 带「沉淀」按钮）。
    // 零耦合红线：不调用任何笔记/记忆工具的 API、不写任何外部文件——教训最终存到哪、要不要存，
    // 全由主窗口 agent 自己用可用工具决定。触发前一律先过 feedbackEnabled 总开关（关掉 = 不生成）。
    function lessonSource(t) { return '任务 ' + t.id + '「' + String(t.title || '').slice(0, 60) + '」 · ' + new Date().toISOString() }
    function pushRejectLesson(d, t, reason, at) {
      if (!cfg(d).feedbackEnabled) return false
      return pushLesson(t, lessonText('任务「' + String(t.title || '') + '」(' + t.id + ') 被 Verifier 驳回', [['错误做法', String(reason || '(Verifier 未给出理由)')]], lessonSource(t)), at, 'system')
    }
    function pushArbitrationLesson(d, t, question, answer, at) {
      if (!cfg(d).feedbackEnabled) return false
      return pushLesson(t, lessonText('任务「' + String(t.title || '') + '」(' + t.id + ') 的歧义裁决', [['疑问', question], ['裁决结论', answer]], lessonSource(t)), at, 'system')
    }


    // ===== 状态流转（已抽取到 lib/core.mjs）=====
    // ===== 一次性派发引擎（v74 去池化重写）=====
    // 每个任务 spawn 一个独立一次性子代理：上下文由看板通过 prompt 全量注入（任务描述/指引/验收脚本/过程记录），
    // 优先选择不继承父会话历史的 provider（inheritsParentContext === false），工作结束 run.result 结算后即 dispose 销毁。
    // 无常驻池、无队列、无名册——彻底消除幽灵指派/身份错乱/spawn 死亡循环整族问题。
    var activeRuns = {} // sid -> { taskId: { run, role, taskId, startedAt, model } }
    var dispatchedEver = {} // sid -> { runId: true }（回执判定：区分派发执行 vs 主窗口手动）
    function runsFor(sid) { if (!activeRuns[sid]) activeRuns[sid] = {}; return activeRuns[sid] }
    function isDispatched(sid, id) { return !!(id && dispatchedEver[sid] && dispatchedEver[sid][id]) }
    // 模型熔断：带覆盖模型的 run 若立即失败（如 UNKNOWN_MODEL——模型在当前网关没配置），记入坏名单回退父级
    var badModels = {}
    function modelKey(sid, model) { return sid + '|' + model }

    var _cachedProvider = null
    function pickProvider() {
      if (_cachedProvider) return _cachedProvider
      var subagents = ctx.subagents; if (!subagents) return null
      var names = subagents.list(); if (!names.length) return null
      for (var i = 0; i < names.length; i++) { try { var p = subagents.getProvider(names[i]); if (p && p.inheritsParentContext === false) { _cachedProvider = names[i]; return _cachedProvider } } catch (_) {} }
      _cachedProvider = names[0]; return _cachedProvider
    }

    // 主窗口预研文件：t.context.files 里的路径由主 agent 选择性指定（它调研时读过哪些文件），
    // host 在派发时从磁盘读最新内容注入 prompt——Worker/Verifier 不用从零重复调研。
    // 上限：单文件 8KB、总计 40KB，超出截断并标注。
    // 相对路径的解析根必须是「该会话的工作区」（root agent 的 session.header.cwd），
    // 不能靠进程 cwd——dsh web 从家目录启动时相对路径会解析到 ~/.dsh 之外的家目录下，
    // 全部读成「读取失败」（v0.1.7 实测：dsh-notes-plugin/... → C:\Users\<user>\dsh-notes-plugin）。
    function sessionCwd(sid) { try { var root = rootForSession(sid); var cwd = root && root.session && root.session.header && root.session.header.cwd; return (typeof cwd === 'string' && cwd) ? cwd : '' } catch (_) { return '' } }
    async function readContextPack(sid, t) {
      var paths = (t.context && Array.isArray(t.context.files)) ? t.context.files : []
      var notes = (t.context && typeof t.context.notes === 'string') ? t.context.notes : ''
      if (!paths.length && !notes.trim()) return ''
      var cwd = sessionCwd(sid)
      var out = [], total = 0
      for (var i = 0; i < paths.length && total < 40960; i++) {
        var p = String(paths[i] || '')
        if (!p) continue
        // 锚点行段语法：'path:L2350-L2420' / 'path:L2350'（看板反馈 n-musaoirgsigo ②）
        // 盘符冒号不会被误判（parseAnchorPath 只认尾部 :L<num>）；展示路径保留原始写法。
        var anchor = parseAnchorPath(p)
        try {
          var full = await fs.readText(await fs.resolve(anchor.file, cwd ? { cwd: cwd } : undefined))
          var content = full, truncated = false, meta = '', outline = null
          var anchorFrom = null // 锚点段起点（预算二次截断时换算注入末行用）
          if (anchor.from != null) {
            var seg = sliceLines(full, anchor.from, anchor.to)
            if (seg.invalid) {
              // 段超范围 → 回退头部注入并标注（调用方写明锚点意图，Worker 可据此换锚点重读）
              meta = '锚点 L' + anchor.from + (anchor.to != null ? '-L' + anchor.to : '') + ' 无效（共 ' + seg.totalLines + ' 行），已回退头部'
            } else {
              content = seg.text
              anchorFrom = seg.injectedFrom
              meta = '锚点行段：共 ' + seg.totalLines + ' 行，已注入 L' + seg.injectedFrom + '–L' + seg.injectedTo + (seg.capped ? '（超 400 行段长上限）' : '')
            }
          } else if (anchor.invalidAnchor) {
            meta = '锚点写法无效，已回退头部'
          }
          // 预算口径不变：单文件 8KB、总计 40KB（锚点段同样计入）
          if (content.length > 8192) { content = content.slice(0, 8192); truncated = true }
          if (total + content.length > 40960) { content = content.slice(0, 40960 - total); truncated = true }
          if (truncated) {
            // 截断标注升级（①）：从「（截断）」升级为「共 N 行，已注入 X–M 行」
            var gotLines = content ? content.split('\n').length : 0
            if (anchorFrom != null) {
              meta += '；预算截断到 L' + (anchorFrom + gotLines - 1)
            } else {
              var totalLines = full.split('\n').length
              meta += (meta ? '；' : '') + '截断：共 ' + totalLines + ' 行，已注入 1–' + gotLines + ' 行'
              // 结构索引（①④）：头部注入被截断时附上，Worker 可照索引用锚点语法直读目标段
              outline = buildFileOutline(full)
            }
          }
          var entry = { path: p, content: content, truncated: truncated }
          if (meta) entry.meta = meta
          if (outline && outline.length) entry.outline = outline
          out.push(entry)
          total += content.length
        } catch (e) {
          out.push({ path: p, content: '[读取失败: ' + String(e).slice(0, 120) + ']', truncated: false })
        }
      }
      return buildContextPackSection(out, notes.slice(0, 8000))
    }

    // 预研文件注入通道：内容不混进 user prompt，而是通过 systemPrompt.context 以「上下文注入」
    // 区块呈现（与 skill-catalog 等系统注入同形态）。
    // 首轮竞速：子代理的首次 prompt 组装发生在 subagents.start() 返回之前，packByChild 还没写入
    // → spawn 前把 pack 放进 pendingPacks，provider 按父子归属（isOwnedBy 父 agent）即时认领。
    var packByChild = {}
    var pendingPacks = []

    // 历史会话留档：t.runs = [{ role, id, at, model, outcome, endedAt }]，上限 20 条
    // 目的：任务流转到 resolved/archived 后，详情页仍能选择跳转到任一历史阶段的会话
    // （Worker 首次/重试、Verifier 各次），而不是只剩最后一次 run id。
    async function recordRunHistory(sid, taskId, role, runId, model, hardMin) {
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t) return
          if (!Array.isArray(t.runs)) t.runs = []
          t.runs.push({ role: role, id: runId, at: new Date().toISOString(), model: model || '', outcome: 'running', hardMin: hardMin || 120 })
          if (t.runs.length > 20) t.runs = t.runs.slice(-20)
        })
      } catch (e) { console.error('[task-board] recordRunHistory failed:', String(e)) }
    }
    async function closeRunHistory(sid, taskId, runId, outcome) {
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t || !Array.isArray(t.runs)) return
          for (var i = t.runs.length - 1; i >= 0; i--) {
            if (t.runs[i].id === runId) { t.runs[i].outcome = outcome; t.runs[i].endedAt = new Date().toISOString(); break }
          }
        })
      } catch (e) { console.error('[task-board] closeRunHistory failed:', String(e)) }
    }

    async function spawnOneShot(sid, t, role) {
      var subagents = ctx.subagents; if (!subagents) return null
      var parent = rootForSession(sid); if (!parent) { console.error('[task-board] no root agent for session ' + sid + ', skip spawn'); return null }
      var providerName = pickProvider(); if (!providerName) { console.error('[task-board] no subagent provider'); return null }
      var modelOverride = ''
      var dsnap = await rt(sid)
      if (role === 'verifier') { modelOverride = (typeof dsnap.verifierModel === 'string' && dsnap.verifierModel.trim()) ? dsnap.verifierModel.trim() : ''; if (modelOverride && badModels[modelKey(sid, modelOverride)]) { console.error('[task-board] model ' + modelOverride + ' circuited, using parent model'); modelOverride = '' } }
      else if (role === 'worker') { modelOverride = (typeof dsnap.workerModel === 'string' && dsnap.workerModel.trim()) ? dsnap.workerModel.trim() : ''; if (modelOverride && badModels[modelKey(sid, modelOverride)]) { console.error('[task-board] model ' + modelOverride + ' circuited, using parent model'); modelOverride = '' } }
      var pack = ''
      try { pack = await readContextPack(sid, t) } catch (e) { console.error('[task-board] context pack read failed:', String(e)) }
      // user prompt 只留一行指引，内容走上下文注入区块
      var packNote = pack ? '本任务附带主窗口预研文件，已通过「上下文注入」区提供（含文件完整内容），直接基于其内容工作，不要重复读取这些文件。' : ''
      var req = { label: role + ':' + t.id, prompt: [{ type: 'text', text: role === 'worker' ? buildWorkerPrompt(t, packNote, cfg(dsnap).feedbackEnabled) : buildVerifierPrompt(t, packNote) }], parent: parent, signal: makeSignal() }
      if (modelOverride) {
        // list-models 返回的 id 是 "provider/model" 复合格式（如 "cmss/zhanlu/glm-5.2"），
        // 但 AgentOptions 的 provider 和 model 是分开的——整串塞进 model 会报 UNKNOWN_MODEL
        var slash = modelOverride.indexOf('/')
        if (slash > 0) req.agentOptions = { provider: modelOverride.slice(0, slash), model: modelOverride.slice(slash + 1) }
        else req.agentOptions = { model: modelOverride }
      }
      var run
      var ppEntry = pack ? { pack: pack, parent: parent, at: Date.now() } : null
      if (ppEntry) pendingPacks.push(ppEntry)
      try { run = await subagents.start(providerName, req) } catch (e) {
        if (modelOverride) { console.error('[task-board] model override failed, fallback to parent model:', String(e)); delete req.agentOptions; try { run = await subagents.start(providerName, req) } catch (e2) { console.error('[task-board] spawn ' + role + ' failed:', String(e2)); return null } }
        else { console.error('[task-board] spawn ' + role + ' failed:', String(e)); return null }
      } finally {
        if (ppEntry) { var ppi = pendingPacks.indexOf(ppEntry); if (ppi >= 0) pendingPacks.splice(ppi, 1) }
      }
      var c = cfg(dsnap)
      var rec = { run: run, role: role, taskId: t.id, startedAt: Date.now(), model: modelOverride, settled: false }
      runsFor(sid)[t.id] = rec
      if (pack) packByChild[String(run.id)] = pack
      if (!dispatchedEver[sid]) dispatchedEver[sid] = {}
      dispatchedEver[sid][String(run.id)] = true
      // 历史会话留档：每次派发都追加一条 {role,id,at,model}，任务完成后仍可回看
      // 各阶段（含重试的第 1/2/3 次 Worker）会话——否则 claimedBy/verifierRun 只留最后一次
      recordRunHistory(sid, t.id, role, String(run.id), modelOverride, c.hardTimeoutMin).catch(function () {})
      // ===== 两级超时：软超时只提醒主窗口（由人决定继续等待或终止），硬超时兜底 dispose =====
      // 一次性 run 没有看门狗：完全依赖人工决策时，人不在线挂死的 run 会永久占用并发位，
      // 所以保留硬上限作为最后防线（默认 120min，可配置）。
      var startedAt = rec.startedAt
      var softMs = c.softTimeoutMin * 60000
      var hardMs = c.hardTimeoutMin * 60000
      function finish(res, err) { if (rec.settled) return; rec.settled = true; settleRun(sid, rec, res, err) }
      ;(function softArm() {
        var tm = ctx.timer; if (!tm) return
        tm.timeout(softMs).then(function () {
          if (rec.settled) return
          var mins = Math.round((Date.now() - startedAt) / 60000)
          // 带 taskId：投递前会按任务现状复查，任务已完成/落定的过期告警直接丢弃（避免误报）
          pushSysNote(sid, '⏱ 任务「' + t.title + '」的 ' + role + '（' + t.id + '）已运行 ' + mins + ' 分钟仍未完成——如属正常长任务可忽略；需要干预可在看板详情页「立即终止」（硬超时 ' + c.hardTimeoutMin + ' 分钟后将自动终止并重试）', t.id)
          softArm() // 持续提醒直到结算或硬超时
        }).catch(function () {})
      })()
      withTimeout(run.result, hardMs, role + ':' + t.id).then(function (res) { finish(res, null) }).catch(function (e) { finish(null, e) })
      return rec
    }

    // run 结算：保证 dispose；工具通道（board_report/board_verdict）已推进状态的话文本路径跳过
    async function settleRun(sid, rec, res, err) {
      if (runsFor(sid)[rec.taskId] !== rec) return // 已被 terminate 等路径处理
      delete runsFor(sid)[rec.taskId]
      delete packByChild[String(rec.run.id)] // 上下文注入缓存随 run 销毁
      try { await rec.run.dispose() } catch (_) {}
      var output = outputText(res)
      var failed = !!err || (res && res.stopReason && res.stopReason !== 'completed')
      var errText = err ? String(err) : (res && (res.diagnostic || res.stopReason) || '')
      try {
        if (rec.role === 'worker') await settleWorker(sid, rec, output, failed, errText)
        else await settleVerifier(sid, rec, output, failed, errText)
      } catch (e) { console.error('[task-board] settle ' + rec.role + ' failed (task ' + rec.taskId + '):', String(e)) }
      // 历史会话留档：记录该次 run 的结局（完成/失败/硬超时），详情页可据此标注阶段状态
      closeRunHistory(sid, rec.taskId, String(rec.run.id), failed ? (err ? 'timeout/error' : 'incomplete') : 'completed').catch(function () {})
      // ===== token 消耗结算：读该次 run 的 v4 日志聚合 usage，累加到任务 =====
      // 放在状态推进之后：统计是附加信息，读日志失败/无 usage 时静默跳过，绝不影响结算语义。
      // Worker 失败重试、驳回重做都会各走一次 settleRun，因此多轮消耗天然累加（runs 计数）。
      await accumulateRunUsage(sid, rec)
    }

    // 把一次 run 的 token 消耗累加到任务（t.usage）：总量/输入/输出/缓存读写 + 按模型小计 + runs 计数。
    // 模型小计的 key：优先本次派发显式覆盖的模型（rec.model），否则用日志里记录的会话模型。
    async function accumulateRunUsage(sid, rec) {
      var u = null
      try { u = readRunUsage(String(rec.run.id)) } catch (_) { u = null }
      if (!u || !u.total) return
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === rec.taskId })
          if (!t) return null
          if (!t.usage) t.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, runs: 0, models: {} }
          // 逐字段兜底 0：脏数据（半写/老形态）也不会把 NaN 带进看板（NaN 会让工具输出的 lossless-JSON 校验拒整条结果）
          t.usage.input = (t.usage.input || 0) + u.input
          t.usage.output = (t.usage.output || 0) + u.output
          t.usage.cacheRead = (t.usage.cacheRead || 0) + u.cacheRead
          t.usage.cacheWrite = (t.usage.cacheWrite || 0) + u.cacheWrite
          t.usage.total = (t.usage.total || 0) + u.total
          t.usage.runs = (t.usage.runs || 0) + 1
          if (!t.usage.models) t.usage.models = {}
          var mk = rec.model || u.model || '(未知模型)'
          t.usage.models[mk] = (t.usage.models[mk] || 0) + u.total
          t.usage.updatedAt = new Date().toISOString()
          return { ok: true }
        })
      } catch (e) { console.error('[task-board] usage accumulate failed (task ' + rec.taskId + '):', String(e)) }
    }

    async function settleWorker(sid, rec, output, failed, errText) {
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === rec.taskId })
        if (!t) return null
        // 工具通道已处理（board_report 已推进到 verifying/resolved 或挂了 escalation）→ 只收尾
        if (t.status !== 'in-progress' || t.escalation) return { task: t, already: true }
        if (failed) {
          t.retryCount = (t.retryCount || 0) + 1
          if (t.retryCount >= 3) { var ps = t.status; t.status = 'blocked'; ah(t, ps, 'blocked', String(rec.run.id), 'worker 失败 x' + t.retryCount + '（' + String(errText).slice(0, 120) + '），待人工介入'); return { task: t, blocked: true } }
          var ps2 = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps2, 'pending', String(rec.run.id), 'worker 失败（' + String(errText).slice(0, 80) + '），重新排队 (' + t.retryCount + '/3)')
          return { task: t, retry: true }
        }
        if (/\[ESCALATE\]/i.test(output || '')) {
          t.escalation = { question: output.slice(0, 2000), at: new Date().toISOString(), by: String(rec.run.id) }
          if (!Array.isArray(t.messages)) t.messages = []
          t.messages.push({ kind: 'escalation', text: output.slice(0, 4000), at: t.escalation.at, by: String(rec.run.id) })
          ah(t, 'in-progress', 'in-progress', String(rec.run.id), 'worker 上报歧义（文本通道），待主窗口裁决')
          return { task: t, escalated: true }
        }
        // 文本降级路径：分段格式上报
        var secs = parseSections(output)
        delete t.retryCount; delete t.stuckSince
        t.deliverable = { summary: secs.summary || output.slice(0, 600), changes: secs.changes || '', selfTest: secs.selfTest || '', diff: (secs.diff || '').slice(0, 4000), at: new Date().toISOString(), by: String(rec.run.id) }
        resolveApply(d, t, String(rec.run.id), 'verifying', output || 'Worker 完成', 'worker 文本上报完成')
        return { task: t }
      })
      if (!result) return
      // already=true：工具通道（board_report）已推进状态并已发回执/歧义通知，settle 只负责 dispose，不再重复通知
      if (result.already) return
      if (result.escalated) maybeNotify(sid, result.task)
      if (result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
      if (result.blocked) notifyTaskDone(sid, result.task, 'blocked')
      kickCycle(sid) // 结算后立刻补派
    }

    async function settleVerifier(sid, rec, output, failed, errText) {
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === rec.taskId })
        if (!t) return null
        if (t.status !== 'verifying' || t.escalation) return { task: t, already: true } // 工具通道已处理
        var trimmed = (output || '').trim()
        var vm = trimmed.match(/^[ \t>*#\-\s]*(APPROVED|REJECTED)\b/im)
        if (failed || !vm) {
          // 失败/空输出/无法判定：verifyRetries 计数，>=3 转人工验收（deliverable 已完成，是 verifier 故障不是任务故障）
          if (failed && rec.model) { badModels[modelKey(sid, rec.model)] = true; pushSysNote(sid, '模型 ' + rec.model + ' 验收连续失败，已熔断回退父级模型') }
          t.verifyRetries = (t.verifyRetries || 0) + 1
          if (t.verifyRetries >= 3) { t.escalation = { question: 'Verifier 连续 ' + t.verifyRetries + ' 次未能给出有效结论（' + (failed ? String(errText).slice(0, 150) : '输出格式异常') + '）。交付物已完成，请人工验收：看板详情页直接通过/驳回，或 task_verify 裁决。', at: new Date().toISOString(), by: 'system' }; ah(t, 'verifying', 'verifying', 'system', 'verifier 故障，转人工验收'); return { task: t, escalated: true } }
          ah(t, 'verifying', 'verifying', 'system', 'verifier 未给出有效结论，重新排队审查 (' + t.verifyRetries + '/3)')
          return { task: t, retry: true }
        }
        var approved = vm[1].toUpperCase() === 'APPROVED'
        var vsecs = parseSections(trimmed)
        delete t.stuckSince; delete t.verifyRetries
        t.verification = { verdict: approved ? 'approved' : 'rejected', summary: vsecs.verifySummary || trimmed.slice(0, 600), checks: vsecs.checks || '', at: new Date().toISOString(), by: String(rec.run.id) }
        verifyApply(d, t, String(rec.run.id), approved ? 'approved' : 'rejected', trimmed.slice(0, 200))
        if (!approved) {
          t.rejectCount = (t.rejectCount || 0) + 1
          // 学习飞轮 v1：Verifier 驳回 → 候选教训（场景/错误做法/来源），随 t.verification.at 判重
          pushRejectLesson(d, t, vsecs.verifySummary || trimmed, t.verification.at)
          if (t.rejectCount >= 3) { t.status = 'blocked'; ah(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x' + t.rejectCount + '，待人工裁决') }
          else { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', '驳回重派：新 Worker 将携带驳回原因继续') }
        }
        return { task: t, approved: approved }
      })
      if (!result) return
      // already=true：工具通道（board_verdict）已推进状态并已发回执，settle 只负责 dispose，不再重复通知
      if (result.already) return
      if (result.escalated) maybeNotify(sid, result.task)
      if (result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
      if (result.task && result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      kickCycle(sid)
    }

    // 歧义上报通知：任何模式都通知主窗口（escalation 需要人工裁决，不能静默吞掉）
    // 25s 去抖投递：主窗口 turn 进行中时 followup 只在宿主侧排队，送达时任务常已被裁决/归档（过期回声）；
    // 排队无法撤回，插件侧唯一可行的方案就是延迟 + 投递前重查看板。
    // escNotifyTimers 存每个任务最新一次调度：同一任务再次上报即顶替旧调度（旧回调身份不匹配 → 静默丢弃）；
    // 投递时才读 escalation.question，所以连续多次上报只会收到一条、且一定是最新疑问。
    var escNotifyTimers = {}
    function deliverEscalation(sid, taskId) {
      rt(sid).then(function (d) {
        var t = null
        var list = (d && d.tasks) || []
        for (var i = 0; i < list.length; i++) { if (list[i].id === taskId) { t = list[i]; break } }
        // escalation 已消失（已被裁决）或任务已 resolved/archived → 通知已过期，静默跳过（history 不记）
        if (!t || !t.escalation || t.status === 'resolved' || t.status === 'archived') return
        var root = rootForSession(sid)
        if (!root) return
        try { root.followup(makeMsg('⚠️ [任务看板] Worker 上报歧义，等待裁决：\n\n任务: ' + t.title + ' (' + t.id + ')\n\n疑问:\n' + String(t.escalation.question || '').slice(0, 1500) + '\n\n请在看板详情页裁决，或直接回复指示。裁决后会有新 Worker 带着裁决答案接手。\n\n（若收到时任务已被裁决或归档，说明本通知投递晚于处理——先用 task_list/get-tasks 核对状态，勿重复裁决。）', 'notice', '任务待裁决: ' + t.title)) } catch (e) { console.error('[task-board] escalate notify failed:', String(e)) }
      }).catch(function (e) { console.error('[task-board] escalate notify failed:', String(e)) })
    }
    function notifyMainWindow(sid, t) {
      var tm = ctx.timer
      if (!tm) { deliverEscalation(sid, t.id); return } // timer 不可用 → 直接投递（保持原即时行为）
      var key = sid + ':' + t.id
      var mine = tm.timeout(25000)
      escNotifyTimers[key] = mine
      mine.then(function () {
        if (escNotifyTimers[key] !== mine) return // 已被该任务更新的一次上报顶替 → 丢弃，避免重复通知
        delete escNotifyTimers[key]
        deliverEscalation(sid, t.id)
      }).catch(function () {}) // 插件销毁时 timeout 会 reject("Context has been disposed")，静默吞掉
    }
    function maybeNotify(sid, task) { if (task && task.escalation) { notifyMainWindow(sid, task) } }

    // ===== 任务回执通知（批量聚合 + 空闲门控）：派发执行的任务在 完成/阻塞 时通知主窗口 =====
    // 只通知派发执行的任务（isDispatched），主窗口自己手动处理的任务不回执（自己干的自己知道）。
    // 批量聚合：任务多时每任务一条 followup 会把主窗口 turn 队列打满（用户输入排队等回执处理完才刷新），
    // 改为 45s 窗口（或满 5 条）聚合为一条摘要；发送前等主窗口空闲，不打断对话。
    var receiptBuf = {}
    // 回执幂等去重表：key = 任务id + 类别 + 完成事件指纹（deliverable/verification/resolvedAt/末条history 时间戳）。
    // 同一完成事件被任何路径（工具直报/run 结算/未来回归）重复通知时指纹一致 → 吞掉；
    // 驳回后重做完成 → 时间戳全换新 → 指纹不同 → 正常回执。
    var receiptedKeys = {}
    function notifyTaskDone(sid, t, kind) {
      if (!t || !isDispatched(sid, t.claimedBy)) return
      var lastHist = (t.history && t.history.length) ? String(t.history[t.history.length - 1].timestamp || '') : ''
      var stamp = [kind, (t.deliverable && t.deliverable.at) || '', (t.verification && t.verification.at) || '', t.resolvedAt || '', lastHist].join('|')
      var key = t.id + ':' + stamp
      if (receiptedKeys[key]) return
      var rkeys = Object.keys(receiptedKeys)
      if (rkeys.length > 512) { var rnow = Date.now(); for (var ri = 0; ri < rkeys.length; ri++) { if (rnow - receiptedKeys[rkeys[ri]] > 3600000) delete receiptedKeys[rkeys[ri]] } }
      receiptedKeys[key] = Date.now()
      var buf = receiptBuf[sid] || (receiptBuf[sid] = { items: [], timer: null })
      var lastNote = (t.history && t.history.length) ? String(t.history[t.history.length - 1].note || '') : ''
      buf.items.push({ kind: kind, title: t.title, id: t.id, summary: (t.deliverable && t.deliverable.summary) || '', note: lastNote })
      if (buf.items.length >= 5) { flushReceipts(sid); return }
      if (!buf.timer) {
        var tm = ctx.timer
        if (tm) { var captured = buf; buf.timer = tm.timeout(45000).then(function () { if (receiptBuf[sid] === captured) flushReceipts(sid) }).catch(function () {}) }
        else flushReceipts(sid)
      }
    }
    // 系统级异常通知队列（易失，随回执冲刷）：模型熔断/spawn 失败/孤儿回收/看门狗标记
    var sysNotesBuf = {}
    // taskId 可选：告警类通知（软超时提醒等）语义只对「任务仍在执行中」成立，
    // 带上任务 id 后 flush 投递前可重读看板校验，任务已落定的过期告警直接丢弃
    function pushSysNote(sid, text, taskId) {
      var arr = (sysNotesBuf[sid] = sysNotesBuf[sid] || [])
      arr.push({ text: text, at: new Date().toISOString(), taskId: taskId || null })
      if (arr.length > 10) arr.splice(0, arr.length - 10)
    }
    function flushReceipts(sid) {
      var buf = receiptBuf[sid]
      var notes = sysNotesBuf[sid] || []
      if ((!buf || !buf.items.length) && !notes.length) return
      receiptBuf[sid] = null
      sysNotesBuf[sid] = []
      var root = rootForSession(sid); if (!root) return
      var items = (buf && buf.items) ? buf.items.slice() : []
      function noteOf(status) { return status === 'verifying' ? '验证中' : '进行中' }
      // 组装投递文本（入参已是过滤后的存活项，避免用已丢弃项的计数）
      function composeText(items, notes) {
        var done = [], blocked = []
        for (var i = 0; i < items.length; i++) { (items[i].kind === 'resolved' ? done : blocked).push(items[i]) }
        var lines = [done.length || blocked.length ? '📋 [任务看板] 回执摘要（' + items.length + ' 条）' : '📋 [任务看板] 系统通知', '']
        if (done.length) {
          lines.push('✅ 完成 ' + done.length + ' 个：')
          for (var j = 0; j < done.length && j < 8; j++) lines.push('  · ' + done[j].title + ' (' + done[j].id + ')' + (done[j].summary ? ' — ' + done[j].summary.slice(0, 120) : ''))
        }
        if (blocked.length) {
          lines.push('🛑 阻塞 ' + blocked.length + ' 个（需关注）：')
          for (var k = 0; k < blocked.length && k < 8; k++) lines.push('  · ' + blocked[k].title + ' (' + blocked[k].id + ')' + (blocked[k].note ? ' — ' + blocked[k].note.slice(0, 150) : ''))
        }
        if (notes.length) {
          lines.push('', '⚠️ 系统异常 ' + notes.length + ' 条：')
          for (var n = 0; n < notes.length && n < 8; n++) lines.push('  · ' + notes[n].text)
        }
        lines.push('', '可用 task_list 查看全部；阻塞项可在看板拖回待办重新投放。')
        return lines.join('\n')
      }
      // 投递前状态过滤：入队到投递之间隔着 45s 聚合窗口 + 等主窗口空闲（最长 5 分钟），
      // 期间任务可能已经完成/归档——过期告警与死回执会误报（实测软超时告警 6/6 全误报）。
      // 所以 send 之前重读一次看板，按任务现状决定丢哪些项。
      function deliver() {
        return Promise.resolve().then(function () { return rt(sid) }).catch(function () { return null }).then(function (snap) {
          var tasks = (snap && snap.tasks) || []
          function findTask(id) { for (var i = 0; i < tasks.length; i++) { if (tasks[i].id === id) return tasks[i] } return null }
          // a. 带 taskId 的告警项：任务状态不在 in-progress/verifying 即已落定 → 丢弃；
          //    保留的项在文本前标注投递时状态（读到的是发送瞬间的真实状态，人可据此判断时效）
          var keptNotes = []
          for (var i = 0; i < notes.length; i++) {
            var nt = notes[i]
            if (nt.taskId) {
              var t = findTask(nt.taskId)
              if (!t || (t.status !== 'in-progress' && t.status !== 'verifying')) continue
              keptNotes.push({ text: '（投递时状态：' + noteOf(t.status) + '）' + nt.text })
            } else keptNotes.push(nt)
          }
          // b. 回执项：任务已 archived（人已手动归档 = 已知悉）→ 丢弃；
          //    resolved/blocked 保留（回执是主通道，任务查不到也保留，不能因读盘失败丢回执）
          var keptItems = []
          for (var j = 0; j < items.length; j++) {
            var it = items[j]
            var tt = findTask(it.id)
            if (tt && tt.status === 'archived') continue
            keptItems.push(it)
          }
          // c. 过滤后全空 → 不再打扰主窗口
          if (!keptItems.length && !keptNotes.length) return
          try { root.followup(makeMsg(composeText(keptItems, keptNotes), 'recall')) } catch (e) { console.error('[task-board] receipt flush failed:', String(e)) }
        })
      }
      if (typeof root.whenIdle === 'function') {
        var waited = withTimeout(root.whenIdle(), 300000, 'receipt-idle-wait') // 最多等 5 分钟，超时也发（不能丢回执）
        Promise.resolve(waited).then(deliver, deliver).catch(function (e) { console.error('[task-board] receipt flush failed:', String(e)) })
      } else deliver().catch(function (e) { console.error('[task-board] receipt flush failed:', String(e)) })
    }

    // ===== 派发周期（15s 心跳 + 写入后 kickCycle 触发）=====
    async function poolCycle(sid) {
      var info = []
      var runs = runsFor(sid)
      var snap = await rt(sid)
      var activeW = 0, activeV = 0
      Object.keys(runs).forEach(function (k) { if (runs[k].role === 'worker') activeW++; else activeV++ })
      // 空闲快进：无活跃任务且无活跃 run → 不写盘直接返回（心跳每 15s 跑一次，不能每次都写文件）
      var hasActive = snap.tasks.some(function (t) { return t.status === 'pending' || t.status === 'verifying' || t.status === 'in-progress' })
      if (!hasActive && activeW + activeV === 0) {
        var emptyPool = { workers: [], verifiers: [] }
        // 快进不写盘的前提是磁盘上的 poolStatus 已经是空的——否则（典型：DSH 重启清空了
        // 内存 runs 表，文件里残留重启前的忙碌快照）幽灵 Worker 会永远显示执行中
        var stalePool = snap.poolStatus && (((snap.poolStatus.workers || []).length + (snap.poolStatus.verifiers || []).length) > 0)
        // dispatchInfo 是瞬时通知（90s TTL）：空闲周期也要负责过期清理，否则永久残留
        var staleInfo = snap.dispatchInfo && (!snap.dispatchInfoAt || Date.now() - new Date(snap.dispatchInfoAt).getTime() > 90000)
        if (staleInfo) { delete snap.dispatchInfo; delete snap.dispatchInfoAt }
        if (stalePool || staleInfo) { if (stalePool) snap.poolStatus = emptyPool; try { await wt(sid, snap) } catch (_) {} }
        return snap
      }
      var c = cfg(snap)
      var isAuto = (snap.boardMode || 'auto') === 'auto'

      // 持锁：孤儿回收 + 占位 claim（防并发 cycle 重复派发）+ 池状态快照，一次原子写
      // 孤儿回收 + verifier 派发在两种模式都跑；worker 派发仅 auto 模式（manual 模式主窗口自己做）
      var toSpawn = []
      var result = await mutateLocked(sid, function (d) {
        var now = Date.now()
        d.tasks.forEach(function (t) {
          if (isOrphan(d, t, runs, now)) { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', '执行 run 已结束/丢失，回收重新排队'); pushSysNote(sid, '任务「' + t.title + '」执行 run 丢失，已回收重新排队'); info.push('reclaim ' + t.id) }
          // verifier 派发占位超时回收：占位后强杀/spawn 中断会留 spawn-pending 死占位，超 2min 清掉恢复可派发
          if (t.status === 'verifying' && t.verifierRun === 'spawn-pending' && (now - new Date(t.verifierRunAt || 0).getTime()) > 120000) { t.verifierRun = null; delete t.verifierRunAt; ah(t, 'verifying', 'verifying', 'system', 'Verifier 派发占位超时，回收重新排队'); info.push('reclaim-verifier ' + t.id) }
        })
        // worker 派发仅 auto；verifier 派发两种模式都跑（manual 模式主窗口 claim 做完的 full 档任务需要验收）
        var capW = isAuto ? Math.max(0, c.maxWorkers - activeW) : 0
        var picked = pickDispatch(d, capW, Math.max(0, c.maxVerifiers - activeV), runs)
        picked.pendings.forEach(function (t) { claimApply(d, t, 'spawn-pending', 'dispatch'); toSpawn.push({ role: 'worker', t: t }); info.push('dispatch ' + t.id) })
        picked.verifs.forEach(function (t) { t.verifierRun = 'spawn-pending'; t.verifierRunAt = new Date().toISOString(); toSpawn.push({ role: 'verifier', t: t }); info.push('verify ' + t.id) })
        // touches 文件级排他展示态：被拦候选写 t.waitingForTouches = [持有者任务id...]，
        // 未被拦/已派发/已落定的任务清除该字段（每心跳刷新的 UI 展示态，不参与任何派发逻辑，
        // 但必须显式清——只在写入时报字段会留下"锁已释放仍显示 🔒 等待"的永久误导）。
        var waitMap = {}
        picked.blockedTouches.forEach(function (b) { waitMap[b.id] = b.conflicts })
        d.tasks.forEach(function (t) {
          if (waitMap[t.id]) { t.waitingForTouches = waitMap[t.id]; info.push('wait-touches ' + t.id + '<-' + waitMap[t.id].join(',')) }
          else if (t.waitingForTouches) delete t.waitingForTouches
        })
        // UI 池状态：来自活跃 run（一次性模型：没有成员名册，只有在跑的任务）
        d.poolStatus = { workers: [], verifiers: [] }
        Object.keys(runs).forEach(function (k) { var rc = runs[k]; d.poolStatus[rc.role === 'worker' ? 'workers' : 'verifiers'].push({ id: k, num: '-', busy: true, taskId: rc.taskId, runId: String(rc.run.id), done: 0, queueLen: 0, suspect: false, model: rc.model || '' }) })
        if (info.length > 0) { d.dispatchInfo = info.join('; '); d.dispatchInfoAt = new Date().toISOString() }
        else if (d.dispatchInfo && (!d.dispatchInfoAt || Date.now() - new Date(d.dispatchInfoAt).getTime() > 90000)) { delete d.dispatchInfo; delete d.dispatchInfoAt } // 瞬时通知：90s TTL 过期即清，不再永久残留
        return d
      }, true) // skipKick：poolCycle 自写不触发 kickCycle（防无限循环）

      // 锁外 spawn（慢操作）；占位 claim 已保证不会被别的 cycle 重复派发
      for (var k = 0; k < toSpawn.length; k++) {
        var sp = toSpawn[k]
        var rec = await spawnOneShot(sid, sp.t, sp.role)
        if (rec) {
          // claim 占位换成真实 run id；verifier run 单独记（claimedBy 保留 worker 的，供详情页跳转会话）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t) { if (sp.role === 'worker' && t.claimedBy === 'spawn-pending') t.claimedBy = String(rec.run.id); if (sp.role === 'verifier' && t.verifierRun === 'spawn-pending') { t.verifierRun = String(rec.run.id); t.verifierRunAt = new Date().toISOString() } }; return t }, true)
        } else if (sp.role === 'worker') {
          // spawn 失败 → 回 pending
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.status === 'in-progress' && t.claimedBy === 'spawn-pending') { t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, 'in-progress', 'pending', 'system', 'spawn 失败，回收重新排队') }; return t }, true)
          pushSysNote(sid, '任务「' + sp.t.title + '」Worker 启动失败，已重新排队')
        } else if (sp.role === 'verifier') {
          // verifier spawn 失败 → 清占位，下轮 cycle 重试（占位不清会永远卡住派发）
          await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === sp.t.id }); if (t && t.verifierRun === 'spawn-pending') { t.verifierRun = null; delete t.verifierRunAt }; return t }, true)
          pushSysNote(sid, '任务「' + sp.t.title + '」Verifier 启动失败，下轮自动重试')
        }
      }
      return result
    }

    // 插件停止时清理所有活跃 run
    ctx.effect(function () { return function () { Object.keys(activeRuns).forEach(function (psid) { var rr = activeRuns[psid]; Object.keys(rr).forEach(function (k) { try { rr[k].run.dispose() } catch (_) {} }) }); activeRuns = {} } })
    // Host 侧调度心跳：每 15s 对所有已知会话跑 poolCycle（客户端轮询只是触发器之一，面板关闭/后台节流时照常运转）
    ;(function () { var tm = ctx.timer; if (!tm) return; var disposeTick = tm.interval(function () { var cutoff = Date.now() - 1800000; Object.keys(knownSessions).forEach(function (sid) { if (knownSessions[sid] < cutoff) delete knownSessions[sid]; else poolCycle(sid).catch(function () {}) }) }, 15000); ctx.effect(function () { return disposeTick }) })()

    // ===== Team 模式提示词引导（v65）：teamMode 开启时往主窗口 agent 的 system prompt 注入看板派发引导 =====
    // 用动态 section（text 函数每次组装求值）：开启时注入，关闭时返回空串不落盘。
    // 只对 root agent 注入（池中 worker/verifier 有自己的 prompt 契约，不需要这段）。
    var sysPrompt = ctx.get('systemPrompt')
    if (sysPrompt) {
      var disposeSection = sysPrompt.section({
        name: 'task-board:team-mode',
        order: 250,
        text: function (assembleCtx) {
          var agent = assembleCtx && assembleCtx.agent
          if (!agent) return ''
          // O(1) 快路径：root agent 的 id 就是其会话 id（Agent.id === SessionId），
          // teamModeCache 按会话 id 键——Worker/Verifier 自己的会话 id 不在缓存里，天然不会误注入。
          // 不能走 resolveRoot：该函数在每个 agent 每次 prompt 组装时同步执行，
          // resolveRoot 全表扫 agent 注册表会把宿主事件循环卡死（曾导致全局界面卡顿、用户消息延迟渲染）。
          if (!teamModeCache[String(agent.id)]) return ''
          return '【任务看板 Team 模式已开启】\n本会话的任务看板处于 Team 模式。请遵循以下工作方式：\n1. 涉及代码改动、文件创建、命令执行等实质性工作时，优先用 task_create 提交为看板任务（由一次性 Worker/Verifier 子代理执行与验收），不要自己直接动手实现。\n2. 你仍保有全部工具能力——调研、读代码、讨论方案、回答问题时直接进行，无需提交任务。\n3. 创建任务时，务必在 description 里写清任务目标和约束；调研结论/原始需求/思路用 contextNotes 带上，调研时读过的关键文件用 contextFiles 把路径带上——两者都会通过「上下文注入」通道传给子代理（独立注入区块，不占对话流）。子代理是全新会话、无你的会话记忆，上下文不够它需要从零自行调研，效率大打折扣甚至跑偏方向。\n4. Worker 上报歧义时会通过 task_arbitrate 等待你裁决，请及时响应。驳回重派时同样：新 Worker 没有上一轮的记忆，驳回原因会在 prompt 里，但额外上下文需你在 description 里补上。\n5. Team 模式下 task_create 默认建为草稿（草稿不会被派发领取）。把所有任务的 dependsOn 依赖关系、contextNotes/contextFiles 都补完后，再逐个 task_update publish=true 统一发布。确实需要立即派发的单个任务才显式传 draft:false。\n' + TEAM_SPLIT_RULE + (feedbackOn(String(agent.id)) ? '\n' + LESSON_RECALL_HINT + '把检索到的相关历史教训写进任务的 contextNotes，让子代理少踩重复的坑。' : '')
        },
      })
      ctx.effect(function () { return disposeSection })
      // 预研文件上下文注入：Worker/Verifier 的预研文件内容以「上下文注入」区块呈现
      // （与 skill-catalog 同形态），不混进 user prompt。按子代理会话 id 命中，O(1)，
      // 其他 agent 组装时零成本返回空串。
      var disposeCtxPack = sysPrompt.context({
        name: 'task-board:context-pack',
        order: 50,
        text: function (assembleCtx) {
          var agent = assembleCtx && assembleCtx.agent
          if (!agent) return ''
          var aid = String(agent.id)
          var hit = packByChild[aid]
          if (hit) return hit
          // 首轮竞速自愈：start() 返回前的首次组装按父子归属从 pendingPacks 认领
          var agentsSvc = ctx.agents
          if (!agentsSvc) return ''
          var now = Date.now()
          for (var i = pendingPacks.length - 1; i >= 0; i--) {
            var pp = pendingPacks[i]
            if (now - pp.at > 60000) { pendingPacks.splice(i, 1); continue }
            try {
              if (agentsSvc.isOwnedBy(aid, pp.parent)) { packByChild[aid] = pp.pack; return pp.pack }
            } catch (e) { console.error('[task-board] ctxpack isOwnedBy threw: ' + String(e)) }
          }
          return ''
        },
      })
      ctx.effect(function () { return disposeCtxPack })
    }

    // ===== Tools =====
    ctx.tools.register(defineTool({ name: 'task_list', description: '列出当前会话任务。', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in-progress', 'verifying', 'resolved', 'blocked', 'cancelled'] }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, tag: { type: 'string' }, parentId: { type: 'string' }, includeArchived: { type: 'boolean' }, limit: { type: 'number' } }, required: [] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var d = await rt(sid); var a = d.tasks; var ts = a; if (!args.includeArchived) ts = ts.filter(function (x) { return x.status !== 'archived' }); if (args.status) ts = ts.filter(function (x) { return x.status === args.status }); if (args.priority) ts = ts.filter(function (x) { return x.priority === args.priority }); if (args.tag) ts = ts.filter(function (x) { return (x.tags || []).indexOf(args.tag) >= 0 }); if (args.parentId === 'null') ts = ts.filter(function (x) { return !isb(x) }); else if (args.parentId) ts = ts.filter(function (x) { return x.parentId === args.parentId }); var po = PRIO_RANK; ts.sort(function (a, b) { var dd = (po[b.priority] || 0) - (po[a.priority] || 0); return dd !== 0 ? dd : (a.createdAt || '').localeCompare(b.createdAt || '') }); var lim = Math.min(args.limit || 20, 100); var res = ts.slice(0, lim).map(function (x) { var e = Object.assign({}, x); if (isb(x)) { var p = gpt(x, a); if (p) e.parentSummary = { id: p.id, title: p.title, status: p.status } }; var ch = gsb(x.id, a); if (ch.length) { e.subtaskCount = ch.length; e.subtaskResolved = ch.filter(function (y) { return y.status === 'resolved' }).length }; return e }); var out = { tasks: res, total: ts.length, session: sid, actor: getActorId(), boardMode: d.boardMode || 'auto', teamMode: !!d.teamMode, poolStatus: d.poolStatus }; if (d.teamMode) out.teamHint = 'Team 模式已开启：实质性改动请优先 task_create 提交看板由池执行；调研/读取/讨论可直接进行；Worker 歧义会上报等你裁决。'; return out } }))
    ctx.tools.register(defineTool({ name: 'task_context', description: '获取任务完整上下文。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, expandFiles: { type: 'boolean' }, includeParent: { type: 'boolean' }, includeSubtasks: { type: 'boolean' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var d = await rt(sid); var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found: ' + args.taskId }; return { ok: true, context: { task: t, inheritedContext: t.context || {} } } } }))
    ctx.tools.register(defineTool({ name: 'task_preview_context', description: '派发前上下文预览：预演 task_create 的 contextFiles/contextNotes 将注入给子代理的实际内容（读盘后的最终形态），用于确认材料是否足够。不创建任务。返回 ok=false/empty=true 说明无可注入内容。', parameters: { type: 'object', properties: { contextFiles: { type: 'array', items: { type: 'string' }, description: '预演的文件路径列表' }, contextNotes: { type: 'string', description: '预演的调研笔记' } }, required: [] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var files = Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : []; var notes = typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : ''; if (!files.length && !notes.trim()) return { ok: false, error: 'contextFiles/contextNotes 至少提供一个' }; try { var pack = await readContextPack(sid, { context: { files: files, notes: notes } }); return { ok: true, empty: !pack, pack: pack } } catch (e) { return { ok: false, error: String(e).slice(0, 200) } } } }))
    ctx.tools.register(defineTool({ name: 'task_claim', description: '领取待办任务→in-progress。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var err = claimCheck(d, t, actor); if (err) return { ok: false, error: err }; claimApply(d, t, actor, args.reason || 'claimed'); return { ok: true, task: t, context: { task: t, inheritedContext: t.context || {} } } }) } }))
    ctx.tools.register(defineTool({ name: 'task_resolve', description: '提交验证(verifying)或阻塞(blocked)。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string', enum: ['verifying', 'blocked'] }, resolution: { type: 'string' } }, required: ['taskId', 'status'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress' }; if (t.claimedBy !== actor) return { ok: false, error: 'not claimed by you' }; if (args.status === 'verifying' && !args.resolution) return { ok: false, error: 'resolution required' }; return resolveApply(d, t, actor, args.status, args.resolution, args.resolution || args.status) }) } }))
    ctx.tools.register(defineTool({ name: 'task_verify', description: '验收：approved→resolved，rejected→in-progress。子任务全完成父任务自动verifying。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'rejected'] }, comment: { type: 'string' } }, required: ['taskId', 'verdict'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'verifying') return { ok: false, error: 'not verifying' }; return verifyApply(d, t, actor, args.verdict, args.comment) }) } }))
    ctx.tools.register(defineTool({ name: 'task_archive', description: '归档已解决/已取消任务。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var a = d.tasks; var t = a.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'resolved' && t.status !== 'cancelled') return { ok: false, error: 'only resolved/cancelled' }; var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'archived'); var ca = 0; gsb(t.id, a).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } }); var r = { ok: true, task: t }; if (ca) r.childrenArchived = ca; return r }) } }))
    ctx.tools.register(defineTool({ name: 'task_update', description: '更新任务字段，可选重置为 pending。dependsOn/pipeline 也可更新（环检测会拒绝成环依赖）。contextFiles 可更新预研文件清单。unfreeze:true 解除裁决挂起冻结（frozen）并触发派发。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, assignMode: { type: 'string', enum: ['auto', 'manual'] }, assignee: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, contextFiles: { type: 'array', items: { type: 'string' }, description: '预研文件路径（替换式更新），派发时经上下文注入传给子代理' }, contextNotes: { type: 'string', description: '预研笔记（替换式更新）：调研结论/原始需求/思路' }, pipeline: { type: 'string', enum: ['full', 'work', 'direct'] }, resetToPending: { type: 'boolean' }, unfreeze: { type: 'boolean', description: '解除冻结（frozen）并立即触发派发，用于 hold 裁决补完上下文后重新入池' }, publish: { type: 'boolean', description: '发布草稿为 pending（仅 draft 状态有效）' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (args.title !== undefined) t.title = args.title; if (args.description !== undefined) t.description = args.description; if (args.priority !== undefined) t.priority = args.priority; if (args.assignMode !== undefined) t.assignMode = args.assignMode; if (args.assignee !== undefined) t.assignee = args.assignee || null; if (args.dependsOn !== undefined) { var derr = validateDeps(d, t.id, args.dependsOn); if (derr) return { ok: false, error: derr }; t.dependsOn = args.dependsOn } if (args.pipeline !== undefined) { t.pipeline = args.pipeline; t.pipelineAuto = false } if (args.contextFiles !== undefined) { if (!t.context) t.context = { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' }; t.context.files = Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : [] } if (args.contextNotes !== undefined) { if (!t.context) t.context = { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' }; t.context.notes = typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : '' } if (args.publish) { if (t.status !== 'draft') return { ok: false, error: 'not a draft' }; t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'published') } if (args.unfreeze && t.frozen) { delete t.frozen; delete t.frozenAt; delete t.frozenBy; ah(t, t.status, t.status, actor, '解除冻结，重新进入派发池') } if (args.resetToPending) { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'pending', actor, 'reset to pending after edit') }; return { ok: true, task: t } }) } }))
    ctx.tools.register(defineTool({ name: 'task_create', description: '创建新任务到当前会话看板。acceptance 可选：硬性验收脚本命令（如 "node --test src/x.test.js"），Worker 必须实际运行、Verifier 必须独立复跑。dependsOn 可选：依赖任务 id 数组，依赖全部完成后才会被派发。pipeline 可选：full(默认,工作+验证)/work(只做不验)/direct(不进池，主窗口直接处理)。contextFiles 可选：你在调研中已经读过的关键文件路径数组——派发时 host 会从磁盘读取最新内容，通过「上下文注入」通道传给 Worker/Verifier（呈现为独立注入区块，不占对话流），避免子代理从零重复调研。contextNotes 可选：调研结论/原始需求/思路等非文件类上下文，同样走上下文注入。touches 可选：本任务将要改动的文件路径/glob 数组（如 "src/x.mjs"、"src/**"）——派发器在同一时刻只派发 touches 不冲突的任务，避免并行 Worker 改同一批文件互踩；任务进行中持有文件锁，提交验收/完成后释放。' + TASK_SIZE_CONTRACT, parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, tags: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' }, instructions: { type: 'string' }, acceptance: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, contextFiles: { type: 'array', items: { type: 'string' }, description: '预研文件路径（相对 workspace 或绝对路径），内容将在派发时经上下文注入传给子代理' }, contextNotes: { type: 'string', description: '预研笔记：调研结论/原始需求/思路等（≤8000 字符），经上下文注入传给子代理' }, pipeline: { type: 'string', enum: ['full', 'work', 'direct'] }, touches: { type: 'array', items: { type: 'string' }, description: '本任务将改动的文件路径/glob（文件级排他锁）：与活动任务 touches 冲突时不派发，等锁释放；支持 "src/**" 目录、"./a/b.mjs"、裸文件名等写法' }, draft: { type: 'boolean', description: '创建为草稿（不派发）。Team 模式下缺省即为 true——补全 dependsOn/上下文后用 task_update publish=true 统一发布；非 Team 模式缺省 false，显式 draft:false 可跳过草稿' } }, required: ['title'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { if (args.id && d.tasks.find(function (x) { return x.id === args.id })) return { ok: false, error: 'duplicate id: ' + args.id }; if (args.dependsOn && args.dependsOn.length) { var derr = validateDeps(d, args.id || '(pending)', args.dependsOn); if (derr) return { ok: false, error: derr } }; var now = new Date().toISOString(); /* Team 模式护栏：draft 缺省跟随 teamMode（先补齐依赖/上下文再统一 publish）；显式 draft:false 保留为立即派发的逃生门 */ var asDraft = args.draft === undefined ? !!d.teamMode : !!args.draft; var t = { id: args.id || ('task-' + Date.now().toString(36)), title: args.title, description: args.description || '', status: asDraft ? 'draft' : 'pending', priority: args.priority || 'medium', tags: args.tags || [], parentId: args.parentId || null, subtaskStrategy: null, assignMode: 'auto', assignee: null, context: { files: (Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : []), docs: [], instructions: args.instructions || '', notes: (typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : ''), relatedTasks: [], prerequisites: '' }, acceptance: args.acceptance || '', dependsOn: args.dependsOn || [], touches: normTouches(args.touches), pipeline: args.pipeline || '', claimedBy: null, claimedAt: null, createdAt: now, resolvedAt: null, verifiedAt: null, verifiedBy: null, archivedAt: null, resolution: null, waitingForTouches: null, messages: [], history: [{ from: 'created', to: asDraft ? 'draft' : 'pending', timestamp: now, actor: actor, note: asDraft ? 'created as draft' : 'created' }] }; if (!t.pipeline) t.pipeline = classifyPipeline(t); t.pipelineAuto = !args.pipeline; d.tasks.push(t); return withSplitHint({ ok: true, task: t }, t) }) } }))

    // ===== RPC =====
    // get-tasks 是纯读路径（rt 只读文件）——poolCycle 由 15s 心跳 + 写入后 kickCycle 驱动，
    // 客户端 3s 轮询不再触发池计算/写盘（之前每轮询一次就 poolCycle+写盘一次，切会话时多会话轮询挤在文件锁上）
    handle('get-tasks', async function (args) { var sid = rpcSessionId(args); var d = await rt(sid); d.sessionId = sid; var __ag = ctx.agents; d.isRoot = true; if (__ag) { var __roots = __ag.roots(); var __rids = []; for (var __i = 0; __i < __roots.length; __i++) __rids.push(String(__roots[__i].id)); d.isRoot = __rids.indexOf(sid) >= 0 }
      // poolStatus 防幽灵：只保留指向当前活跃任务的条目（重启后内存 runs 清空，文件快照可能残留）
      if (d.poolStatus) { var __act = {}; (d.tasks || []).forEach(function (t) { if (t.status === 'in-progress' || t.status === 'verifying') __act[t.id] = true }); d.poolStatus.workers = (d.poolStatus.workers || []).filter(function (w) { return __act[w.taskId] }); d.poolStatus.verifiers = (d.poolStatus.verifiers || []).filter(function (v) { return __act[v.taskId] }) }
      // 学习飞轮 v1：把 feedbackEnabled 显式放进返回体（normalizeBoard 已按老看板补默认 true），
      // 客户端据此做能力检测——开关关闭时渲染层不生成候选、不显示「沉淀」按钮。
      d.feedbackEnabled = cfg(d).feedbackEnabled
      // 工作模式派生字段：UI 只读这一个字段决定三档选中态（不落盘，写入仍走 boardMode/teamMode）
      d.workMode = deriveWorkMode(d)
      // ===== board 级 token 消耗聚合（现算，不落盘）：总量 + 输入/输出/缓存读 + 按模型 + 任务 Top8 =====
      d.usageSummary = aggregateUsageSummary(d.tasks)
      return d })
    // 派发前上下文预览：主 agent 用它确认"我将注入给子代理的材料"是否足够（不发任务、不落盘）
    handle('preview-context', async function (args) {
      var files = Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : []
      var notes = typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : ''
      if (!files.length && !notes.trim()) return { ok: false, error: 'contextFiles/contextNotes 至少提供一个' }
      var pack = ''
      try { pack = await readContextPack(rpcSessionId(args), { context: { files: files, notes: notes } }) } catch (e) { return { ok: false, error: '读取失败: ' + String(e).slice(0, 120) } }
      return { ok: true, filesCount: files.length, notesLen: notes.length, pack: pack, empty: !pack }
    })
    // 活动心跳：读子代理会话日志的最后一帧，提取最近的动作摘要（卡片/详情页展示"现在跑到哪了"）
    handle('agent-activity', async function (args) {
      var sid = rpcSessionId(args)
      var rec = runsFor(sid)[args.taskId]
      if (!rec || !rec.run) return { ok: true, activity: null, reason: 'no active run' }
      var child = String(rec.run.id)
      try {
        // 子会话日志定位：直接扫描 ~/.dsh/sessions/*/<child>/session.vN.jsonl.zstd
        // （不再从看板路径反推 workspace——那依赖进程 cwd 凑巧等于工作区，曾是隐性 bug）
        // v0.1.7 起日志文件名带格式版本号（session.v4.jsonl.zstd），旧会话是
        // session.v3.jsonl.zstd / session.jsonl.zstd——按新到旧逐个探测。
        // 定位与分帧和 readRunUsage 共用同一套 helper（findRunLog / readLogBytes / readLogFrames）。
        var log = findRunLog(child)
        if (!log) return { ok: true, activity: null, reason: 'log not found' }
        // 只同步读末尾 2MB（日志追加写，末帧必在尾部）——整文件 readFileSync 在大日志上
        // 会造成数十毫秒级同步 I/O，多任务轮询时叠加成全局卡顿
        var buf = readLogBytes(log, 2 * 1024 * 1024)
        if (!buf) return { ok: true, activity: null, reason: 'log unreadable' }
        // 追加写多帧格式：最新事件在末帧。但末帧可能只有 step/end、turn/end 这类
        // 结算事件（v4 一帧只装一个step的增量），单解一帧经常捞不到动作 → 从新到旧
        // 最多回扫 3 帧，找到第一个动作摘要即止（成本仍受控：每帧只是一次 zstd 解压）
        var frames = readLogFrames(buf, 3)
        var activity = null
        for (var fi = 0; fi < frames.length && !activity; fi++) {
          var evs = frames[fi]
          for (var i = evs.length - 1; i >= 0 && !activity; i--) {
            var e = evs[i]
            var dta = (e && e.data) || {}
            if (e && e.type === 'tool/call' && dta.name) activity = '🔧 ' + dta.name + ' ' + String(dta.arguments || '').replace(/\s+/g, ' ').slice(0, 90)
            // v4：助手文本在 assistant/message 的 content 块里；v3 及以前是 assistant/chunk 流片
            else if (e && e.type === 'assistant/message') {
              var msg = dta.message || {}
              var blocks = Array.isArray(msg.content) ? msg.content : []
              for (var b = blocks.length - 1; b >= 0; b--) { if (blocks[b] && blocks[b].type === 'text' && String(blocks[b].text || '').trim()) { activity = '💬 ' + String(blocks[b].text).replace(/\s+/g, ' ').slice(0, 120); break } }
            }
            else if (e && e.type === 'assistant/chunk' && dta.block && dta.block.type === 'text' && dta.block.text && dta.block.text.trim()) activity = '💬 ' + dta.block.text.replace(/\s+/g, ' ').slice(0, 120)
          }
        }
        return { ok: true, activity: activity }
      } catch (e) { return { ok: true, activity: null, reason: String(e).slice(0, 80) } }
    })
    // 全局多会话总览：聚合本机所有看板的任务计数（只读，供 dashboard 跨会话视图）
    handle('list-boards', async function (args) {
      var home = boardHome()
      var out = []
      var files
      try { files = fsNode.readdirSync(home).filter(function (f) { return f.indexOf('tasks-') === 0 && f.slice(-5) === '.json' }) } catch (e) { return { ok: true, boards: [] } }
      for (var i = 0; i < files.length; i++) {
        try {
          var d = JSON.parse(fsNode.readFileSync(path.join(home, files[i]), 'utf8'))
          if (!vt(d)) continue
          var counts = { pending: 0, inProgress: 0, verifying: 0, resolved: 0, blocked: 0 }
          var titles = []
          var lastTs = ''
          d.tasks.forEach(function (t) {
            if (t.status === 'archived') return
            if (counts[t.status] !== undefined) counts[t.status]++
            if (t.status === 'in-progress' || t.status === 'verifying' || t.status === 'blocked') titles.push(t.title)
            ;(t.history || []).forEach(function (h) { if (h.timestamp > lastTs) lastTs = h.timestamp })
          })
          out.push({ session: d.ownerSession, boardMode: d.boardMode || 'auto', teamMode: !!d.teamMode, counts: counts, activeTitles: titles.slice(0, 3), lastActivity: lastTs })
        } catch (_) {}
      }
      out.sort(function (a, b) { return (b.lastActivity || '').localeCompare(a.lastActivity || '') })
      return { ok: true, boards: out }
    })
    handle('claim-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var err = claimCheck(d, t, actor); if (err) return { ok: false, error: err }; claimApply(d, t, actor, 'manual claim via board'); return { ok: true, task: t } }) })
    handle('resolve-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress' }; return resolveApply(d, t, actor, args.status, args.resolution, args.resolution || args.status) }) })
    handle('verify-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'verifying') return { ok: false, error: 'not verifying' }; delete t.escalation; delete t.verifyRetries; var r = verifyApply(d, t, actor, args.verdict, args.comment); if (args.verdict === 'rejected') pushRejectLesson(d, t, args.comment); return r }) })
    handle('archive-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var a = d.tasks; var t = a.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'resolved' && t.status !== 'cancelled') return { ok: false, error: 'cannot archive' }; var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'manual archive'); var ca = 0; gsb(t.id, a).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } }); var r = { ok: true, task: t }; if (ca) r.childrenArchived = ca; return r }) })
    // ===== 任务删除通道（真删，无 undo）=====
    // 背景：archive-task 只收 resolved/cancelled，草稿/误建卡片此前没有任何下线通道（只能永远挂着）。
    // 状态门禁（delete-task 与 batch-op delete 共用本函数，保证两条入口语义完全一致）：
    //   draft / pending / blocked → 允许删（未产生任何执行痕迹，删了不丢信息）
    //   in-progress / verifying   → 拒绝，提示先 terminate-agent 终止（避免把在跑的 run 变成孤儿）
    //   resolved / cancelled      → 拒绝，引导用 archive-task（已落定任务留档可检索）
    //   archived                  → 幂等 ok（已不在活跃看板里，重复调用不报错）
    // 未归档子任务（parentId 指向本任务且 status !== 'archived'）存在时拒删：父卡一删子任务的
    // parentId 就成了悬空引用（checkParentAuto / 上下文继承都会失效），必须先处理子任务。
    // 返回 { err: '...' } 或 { mode: 'already' }；调用方按需转成各自的返回体。
    function deleteGate(d, t) {
      if (t.status === 'in-progress' || t.status === 'verifying') return { err: '任务正在执行中，请先用 terminate-agent 终止（in-progress 回待办、verifying 换 verifier 接手）再删除' }
      if (t.status === 'resolved' || t.status === 'cancelled') return { err: '已落定任务请用归档（archive-task），不要删除' }
      if (t.status === 'archived') return { mode: 'already' }
      // 允许态只剩 draft / pending / blocked；其他未知状态（老看板/人工改档）一律拒删，宁可保守
      if (t.status !== 'draft' && t.status !== 'pending' && t.status !== 'blocked') return { err: '任务状态 ' + t.status + ' 不在可删除范围（仅草稿/待办/阻塞可删）' }
      var live = gsb(t.id, d.tasks).filter(function (c) { return c.status !== 'archived' })
      if (live.length) return { err: '该任务还有 ' + live.length + ' 个未归档子任务（' + live.map(function (c) { return c.title || c.id }).slice(0, 3).join('、') + '），请先删除或归档子任务' }
      return { mode: 'ok' }
    }
    // 单任务删除：真删（从 d.tasks 数组移除），不写 history（记录随任务一起消失），不留档、无 undo。
    // console.error 留一行操作日志，便于事后溯源"某个卡片什么时候被谁删了"。
    handle('delete-task', async function (args) {
      var sid = rpcSessionId(args); var actor = getActorId()
      if (!args.taskId) return { ok: false, error: 'taskId required' }
      return mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        var g = deleteGate(d, t)
        if (g.mode === 'already') return { ok: true, deleted: t.id, alreadyArchived: true }
        if (g.err) return { ok: false, error: g.err }
        d.tasks = d.tasks.filter(function (x) { return x.id !== t.id })
        console.error('[task-board] delete-task: ' + t.id + ' «' + String(t.title || '').slice(0, 60) + '» (status=' + t.status + ') by ' + actor)
        return { ok: true, deleted: t.id }
      })
    })
    handle('update-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (args.title !== undefined) t.title = args.title; if (args.description !== undefined) t.description = args.description; if (args.priority !== undefined) t.priority = args.priority; if (args.assignMode !== undefined) t.assignMode = args.assignMode; if (args.assignee !== undefined) t.assignee = args.assignee || null; if (args.dependsOn !== undefined) { var derr = validateDeps(d, t.id, args.dependsOn); if (derr) return { ok: false, error: derr }; t.dependsOn = args.dependsOn } if (args.pipeline !== undefined) { t.pipeline = args.pipeline; t.pipelineAuto = false } if (args.contextFiles !== undefined) { if (!t.context) t.context = { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' }; t.context.files = Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : [] } if (args.contextNotes !== undefined) { if (!t.context) t.context = { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' }; t.context.notes = typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : '' } if (args.publish) { if (t.status !== 'draft') return { ok: false, error: 'not a draft' }; t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'published') } if (args.unfreeze && t.frozen) { delete t.frozen; delete t.frozenAt; delete t.frozenBy; ah(t, t.status, t.status, actor, '解除冻结，重新进入派发池') } if (args.resetToPending) { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; t.resolvedAt = null; t.resolution = null; ah(t, ps, 'pending', actor, 'reset to pending after edit') }; return { ok: true, task: t } }) })
    handle('set-board-mode', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { d.boardMode = args.mode === 'manual' ? 'manual' : 'auto'; if (d.boardMode === 'manual' && d.teamMode) { d.teamMode = false; teamModeCache[sid] = false }; return { ok: true, boardMode: d.boardMode, teamMode: !!d.teamMode, workMode: deriveWorkMode(d) } }) })
    handle('set-team-mode', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { d.teamMode = !!args.enabled; if (d.teamMode) d.boardMode = 'auto'; teamModeCache[sid] = d.teamMode; return { ok: true, teamMode: d.teamMode, boardMode: d.boardMode, workMode: deriveWorkMode(d) } }) })
    // 工作模式三档单入口（v75 UI 收敛）：一次写入 boardMode+teamMode 两个字段，
    // 复用与老 RPC 完全相同的写入语义（team 档强制 auto；list 档关 team）——
    // 老 RPC set-board-mode/set-team-mode 原样保留，旧客户端/脚本/E2E 不受影响。
    handle('set-work-mode', async function (args) {
      var sid = rpcSessionId(args)
      var m = args && args.mode
      var mode = (m === 'list' || m === 'team') ? m : 'auto' // 缺省/非法值兜底 auto
      return mutateLocked(sid, function (d) {
        if (mode === 'list') { d.boardMode = 'manual'; d.teamMode = false }
        else if (mode === 'team') { d.boardMode = 'auto'; d.teamMode = true }
        else { d.boardMode = 'auto'; d.teamMode = false }
        teamModeCache[sid] = !!d.teamMode // 同步 systemPrompt 引导段的 teamMode 缓存
        return { ok: true, mode: mode, workMode: deriveWorkMode(d), boardMode: d.boardMode, teamMode: !!d.teamMode }
      })
    })
    // 裁决回流（v74 一次性模型）：原 Worker 已结束，答案写入 history 后任务回 pending，
    // 下个派发周期 spawn 新 Worker，裁决内容随 prompt 注入（histNotes 匹配"裁决"）
    // 结构化动作（裁决竞态保护）：
    //   action='resume'（默认，保持现状）= 裁决后立即回到派发池，~50ms 内被自动重派；
    //   action='hold' = 任务置 frozen 冻结，不参与任何自动派发（pickDispatch 跳过），
    //     留给主窗口补 dependsOn/补上下文的时间窗口，补完再显式解冻（unfreeze-task）。
    //   hold 时 mutateLocked 传 skipKick：冻结任务本就不该派发，省掉一次无意义的 poolCycle。
    async function doResolveEscalation(sid, actor, taskId, answer, action) {
      var act = action === 'hold' ? 'hold' : 'resume'
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (!t.escalation) return { ok: false, error: 'not escalated' }
        var escQ = String(t.escalation.question || '') // 先留档：下面 delete 后就没得取了
        delete t.escalation
        if (!Array.isArray(t.messages)) t.messages = []
        var arbAt = new Date().toISOString()
        t.messages.push({ kind: 'arbitration', text: answer || '', at: arbAt, by: actor, action: act })
        // 学习飞轮 v1：主窗口的裁决结论是最值钱的教训来源（Worker 会在同一个坑里反复上报）
        // → 生成候选教训（场景/疑问/裁决结论），由主窗口决定要不要沉淀进笔记/记忆工具。
        pushArbitrationLesson(d, t, escQ, answer || '', arbAt)
        ah(t, t.status, t.status, actor, (act === 'hold' ? '主窗口裁决（挂起冻结）: ' : '主窗口裁决: ') + (answer || '').slice(0, 200))
        // in-progress 的歧义任务：回 pending 重派（新 Worker 带裁决上下文）；verifying 的 verifier 故障升级：保持待审，下轮派新 verifier
        if (t.status === 'in-progress') { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps, 'pending', 'system', act === 'hold' ? '带裁决挂起冻结（不参与自动派发）' : '带裁决重新排队') }
        if (act === 'hold') { t.frozen = true; t.frozenAt = new Date().toISOString(); t.frozenBy = actor; ah(t, t.status, t.status, actor, '冻结：不参与自动派发，待主窗口补完上下文后解冻') }
        else { delete t.frozen; delete t.frozenAt; delete t.frozenBy }
        return { ok: true, task: t, answer: answer || '', action: act, frozen: !!t.frozen }
      }, act === 'hold')
      return result
    }
    // 解冻（竞态保护配套通道）：清 frozen + 记历史 + 触发派发（mutateLocked 默认 kickCycle）
    async function doUnfreezeTask(sid, actor, taskId) {
      return mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (!t.frozen) return { ok: false, error: 'not frozen' }
        delete t.frozen; delete t.frozenAt; delete t.frozenBy
        ah(t, t.status, t.status, actor, '解除冻结，重新进入派发池')
        return { ok: true, task: t, unfrozen: true }
      })
    }
    handle('unfreeze-task', async function (args) { return doUnfreezeTask(rpcSessionId(args), getActorId(), args.taskId) })
    // 高优介入（v74）：有活跃 run 则直接打进其会话；无则只记录 history（下次派发随 prompt 注入）
    // 通道选择（v1.2.4）：steer 优先——下一个 step 边界即消费；followup 要等整个 turn 结束，
    // 长 turn 下干预形同失联（实测：Worker 单 turn 跑 10+ 分钟，「口径重写」类干预到位时活已按旧口径干完）。
    // steer 不可用（老宿主无此方法）或抛错时回退 followup。
    async function doIntervene(sid, actor, taskId, msg) {
      if (!(msg || '').trim()) return { ok: false, error: 'message required' }
      var rec = runsFor(sid)[taskId]
      var delivered = false
      var channel = ''
      if (rec && rec.run && rec.run.localAgent) {
        var agent = rec.run.localAgent
        var m = makeMsg('[高优先级干预] 来自主窗口/用户的指令：\n\n' + msg + '\n\n请优先响应此指令，然后继续当前任务。', 'notice', '高优干预: ' + taskId)
        if (typeof agent.steer === 'function') {
          try { agent.steer(m); delivered = true; channel = 'steer' } catch (_) {}
        }
        if (!delivered) {
          try { agent.followup(m); delivered = true; channel = 'followup' } catch (_) {}
        }
      }
      await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === taskId }); if (t) { if (!Array.isArray(t.messages)) t.messages = []; t.messages.push({ kind: 'intervention', text: msg, at: new Date().toISOString(), by: actor }); ah(t, t.status, t.status, actor, '高优干预: ' + msg.slice(0, 200) + (delivered ? '' : '（无活跃 run，随下次派发注入）')) }; return t })
      return { ok: true, delivered: delivered, channel: channel }
    }
    // 终止执行某任务的 run：dispose 并回 pending（verifying 则保持待审，由新 verifier 接手）
    async function doTerminate(sid, actor, taskId) {
      var rec = runsFor(sid)[taskId]
      var label = 'no-active-run'
      if (rec) {
        delete runsFor(sid)[taskId]; label = rec.role + ':' + taskId
        try { await rec.run.dispose() } catch (_) {}
        // 手动终止的 run 不会走 settleRun（runsFor 已摘除，结算路径会早退），
        // 但它确实消耗了 token——在这里补一次结算，避免终止即丢账。
        await accumulateRunUsage(sid, rec)
      }
      await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return null
        delete t.stuckSince
        if (t.status === 'in-progress') { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps, 'pending', actor, '手动终止，任务重新排队') }
        else if (t.status === 'verifying') { ah(t, 'verifying', 'verifying', actor, '手动终止审查，等待新 verifier 接手') }
        return t
      })
      return { ok: true, terminated: label }
    }
    // 继续等待：清除卡死标记
    async function doDismiss(sid, actor, taskId) {
      await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (t) { delete t.stuckSince; ah(t, t.status, t.status, actor, '清除卡死标记，继续观察') }
        return t
      })
      return { ok: true }
    }
    handle('terminate-agent', async function (args) { return doTerminate(rpcSessionId(args), getActorId(), args.taskId) })
    handle('dismiss-suspect', async function (args) { return doDismiss(rpcSessionId(args), getActorId(), args.taskId) })
    ctx.tools.register(defineTool({ name: 'task_terminate', description: 'Team 模式：终止执行某任务的池中 Agent（卡死/跑偏时）。in-progress 任务回 pending 重派，verifying 由新 verifier 接手。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doTerminate(toolSessionId(), getActorId(), args.taskId) } }))
    // 手动触发单任务派发（manual 模式下"派发给 Worker"按钮，或 auto 模式手动补派）
    // touches 文件级排他：默认尊重文件锁——候选与活动任务 touches 冲突时返回
    // { ok:false, error:'touches-conflict', conflicts:[...] }（客户端 confirm 后带 force:true 重发）。
    // force:true 是人工越权通道：明知会与在跑 Worker 改同一批文件，由人决定是否强行并行。
    handle('dispatch-task', async function (args) {
      var sid = rpcSessionId(args)
      var role = args.role === 'verifier' ? 'verifier' : 'worker'
      var force = args.force === true
      var claimed = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (role === 'worker') {
          if (t.status !== 'pending') return { ok: false, error: 'not pending (状态: ' + t.status + ')' }
          if (t.claimedBy) return { ok: false, error: 'already claimed' }
          if (!force) { var cf = touchesConflict(t, holdsFiles(d)); if (cf.length) return { ok: false, error: 'touches-conflict', conflicts: cf } }
          claimApply(d, t, 'spawn-pending', 'manual dispatch' + (force ? '（force 越权：忽略 touches 冲突）' : ''))
        }
        else { if (t.status !== 'verifying') return { ok: false, error: 'not verifying (状态: ' + t.status + ')' }; if (t.escalation) return { ok: false, error: 'escalated, 待裁决' } }
        return { ok: true }
      })
      if (!claimed || !claimed.ok) return claimed
      var d = await rt(sid)
      var t = d.tasks.find(function (x) { return x.id === args.taskId })
      if (!t) return { ok: false, error: 'task disappeared' }
      var rec = await spawnOneShot(sid, t, role)
      if (rec) {
        if (role === 'worker') { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === args.taskId }); if (t2 && t2.claimedBy === 'spawn-pending') t2.claimedBy = String(rec.run.id); return t2 }, true) }
        if (role === 'verifier') { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === args.taskId }); if (t2) t2.verifierRun = String(rec.run.id); return t2 }, true) }
        return { ok: true, runId: String(rec.run.id) }
      }
      // spawn 失败 → 回退
      if (role === 'worker') { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === args.taskId }); if (t2 && t2.status === 'in-progress' && t2.claimedBy === 'spawn-pending') { t2.status = 'pending'; t2.claimedBy = null; t2.claimedAt = null; ah(t2, 'in-progress', 'pending', 'system', 'spawn 失败') }; return t2 }, true) }
      return { ok: false, error: 'spawn failed' }
    })
    handle('resolve-escalation', async function (args) { return doResolveEscalation(rpcSessionId(args), getActorId(), args.taskId, args.answer, args.action) })
    handle('intervene-agent', async function (args) { return doIntervene(rpcSessionId(args), getActorId(), args.taskId, args.message) })
    // 主 Agent 工具版（Team 模式下主 Agent 通过工具裁决/介入）
    ctx.tools.register(defineTool({ name: 'task_arbitrate', description: 'Team 模式：裁决 Worker 上报的歧义（escalation）。action=resume（默认）裁决后任务回派发池立即重派；action=hold 任务挂起冻结、不参与自动派发（留给主窗口补 dependsOn/上下文，补完后用 task_update unfreeze:true 解冻）。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, answer: { type: 'string' }, action: { type: 'string', enum: ['resume', 'hold'], description: 'resume（默认）=裁决后重新派发；hold=挂起冻结不派发' } }, required: ['taskId', 'answer'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doResolveEscalation(toolSessionId(), getActorId(), args.taskId, args.answer, args.action) } }))
    ctx.tools.register(defineTool({ name: 'task_intervene', description: 'Team 模式：向执行某任务的池中 Agent 发起高优先级指令（steer 通道，当前 step 结束即响应；无活跃 run 时记录随下次派发注入）。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, message: { type: 'string' } }, required: ['taskId', 'message'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doIntervene(toolSessionId(), getActorId(), args.taskId, args.message) } }))
    // ===== 池中 Agent 结构化回报工具（双模：工具优先，文本分段为降级路径）=====
    ctx.tools.register(defineTool({ name: 'board_report', description: '[任务看板 Worker 专用] 上报任务结果。kind=complete 时填 summary/changes/selfTest/diffStat（git 仓库内改动附 git diff --stat 概要）；kind=escalate 时填 question（歧义上报，等待主窗口裁决）；kind=progress 时填 question（一行里程碑进展摘要，≤200 字符）——只在有实际产物/结论时报，禁止定时或表演式汇报，静默不通知主窗口。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, kind: { type: 'string', enum: ['complete', 'escalate', 'progress'] }, summary: { type: 'string' }, changes: { type: 'string' }, selfTest: { type: 'string' }, diffStat: { type: 'string', description: '变更概要：git diff --stat（含 git status --short）输出，≤1500 字符' }, question: { type: 'string', description: 'kind=escalate：歧义原文；kind=progress：一行里程碑进展摘要（≤200 字符）' } }, required: ['taskId', 'kind'] }, output: jo(), execute: async function (args) {
      var sid = toolSessionId(); var actor = getActorId()
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress (状态: ' + t.status + ')' }
        if (!Array.isArray(t.messages)) t.messages = []
        // ===== 里程碑进展通道（kind=progress）=====
        // 定位：长任务执行期间的「还在正确路上」的轻量证明；不进回执聚合、不通知主窗口（纯静默可见）。
        // 防表演式汇报：只在有实际产物/结论时报（契约写在 buildWorkerPrompt 里），且不写 ah() 历史（避免刷屏）。
        if (args.kind === 'progress') {
          var ptext = String(args.question || '').trim().slice(0, 200)
          if (!ptext) return { ok: false, error: 'question required for progress (一行进展摘要)' }
          var pat = new Date().toISOString()
          t.messages.push({ kind: 'progress', text: ptext, at: pat, by: actor })
          t.lastProgress = { text: ptext, at: pat } // 覆盖式：卡片只展示最新一条
          return { ok: true, progress: t.lastProgress }
        }
        if (args.kind === 'escalate') {
          var at = new Date().toISOString()
          t.escalation = { question: (args.question || '').slice(0, 2000), at: at, by: actor }
          t.messages.push({ kind: 'escalation', text: (args.question || '').slice(0, 4000), at: at, by: actor })
          ah(t, 'in-progress', 'in-progress', actor, '上报歧义（工具通道），待主窗口裁决')
          return { ok: true, escalated: true, task: t }
        }
        delete t.escalation
        delete t.retryCount // v72：成功完成清零超时重试计数（工具直报路径）
        delete t.stuckSince
        t.deliverable = { summary: args.summary || '', changes: args.changes || '', selfTest: args.selfTest || '', diff: (args.diffStat || '').slice(0, 4000), at: new Date().toISOString(), by: actor }
        var r = resolveApply(d, t, actor, 'verifying', (args.summary || '') + (args.selfTest ? '\n\n自测: ' + args.selfTest.slice(0, 300) : ''), 'worker 工具上报完成')
        r.ok = true; r.task = t
        return r
      })
      if (result && result.ok && result.escalated) maybeNotify(sid, result.task)
      if (result && result.ok && result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved') // 工具直报路径也要回执（work 档 board_report 直接落 resolved）
      return result
    } }))
    ctx.tools.register(defineTool({ name: 'board_verdict', description: '[任务看板 Verifier 专用] 提交验收结论。verdict=approved/rejected；summary=测试概要；checks=逐条核对证据。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'rejected'] }, summary: { type: 'string' }, checks: { type: 'string' } }, required: ['taskId', 'verdict'] }, output: jo(), execute: async function (args) {
      var sid = toolSessionId(); var actor = getActorId()
      var approved = args.verdict === 'approved'
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (t.status !== 'verifying') return { ok: false, error: 'not verifying (状态: ' + t.status + ')' }
        delete t.escalation; delete t.verifyRetries // verifier 恢复产出：清人工验收标记
        t.verification = { verdict: args.verdict, summary: args.summary || '', checks: args.checks || '', at: new Date().toISOString(), by: actor }
        verifyApply(d, t, actor, args.verdict, (args.summary || '').slice(0, 200))
        if (!approved) { t.rejectCount = (t.rejectCount || 0) + 1; if (t.rejectCount >= 3) { t.status = 'blocked'; ah(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x' + t.rejectCount + '，待人工裁决') } }
        // 学习飞轮 v1：工具通道驳回同样生成候选教训（与文本通道同一条判重口径，不会重复落）
        if (!approved) pushRejectLesson(d, t, (args.summary || '') + (args.checks ? '\n' + args.checks : ''), t.verification.at)
        return { ok: true, task: t }
      })
      if (result && result.ok && result.task) {
        if (result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
        if (result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      }
      if (result && result.ok && !approved && result.task) {
        // v74 一次性模型：原 Worker 已销毁，驳回任务回 pending 重派新 Worker（驳回原因已在 verifyApply 的 history 里，随 prompt 注入）
        var bt = result.task
        if ((bt.rejectCount || 0) < 3) { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === bt.id }); if (t2 && t2.status === 'in-progress') { t2.status = 'pending'; t2.claimedBy = null; t2.claimedAt = null }; return t2 }, true) }
      }
      return result
    } }))
    // 枚举当前网关可用模型（供 Verifier 模型下拉选择）：llm.listProviders + listModels
    handle('list-models', async function () {
      var llm = ctx.get('llm'); if (!llm) return { ok: false, error: 'llm service unavailable' }
      var providers = llm.listProviders()
      var out = []
      for (var i = 0; i < providers.length; i++) {
        try {
          var models = await llm.listModels(providers[i].id)
          for (var j = 0; j < models.length; j++) out.push({ id: providers[i].id + '/' + models[j].id, name: models[j].name || models[j].id, provider: providers[i].name || providers[i].id })
        } catch (_) { /* 某 provider 枚举失败不阻塞整体 */ }
      }
      return { ok: true, models: out }
    })
    // ===== 学习飞轮 v1：沉淀推送通道（push-lesson）=====
    // 详情页「沉淀」按钮 → 把结构化候选教训 followup 给主窗口 agent，由它用自己可用的
    // 笔记/记忆工具（如 note_manage）决定沉淀到哪、或评估后忽略。
    // 这就是全部：看板不知道对方有没有记忆工具、也不知道最终存到哪（零耦合红线）。
    // feedbackEnabled 关闭 → 直接拒绝（UI 侧也不会渲染按钮，这里是双保险）。
    handle('push-lesson', async function (args) {
      var sid = rpcSessionId(args)
      var text = (typeof args.text === 'string') ? args.text.trim().slice(0, 4000) : ''
      if (!text) return { ok: false, error: 'text required' }
      var d = await rt(sid)
      if (!cfg(d).feedbackEnabled) return { ok: false, error: 'feedback disabled' }
      var root = rootForSession(sid)
      if (!root) return { ok: false, error: 'no root agent for session' }
      var delivered = false
      try {
        root.followup(makeMsg('📚 [任务看板] 候选教训沉淀请求\n\n' + text + '\n\n请用你可用的笔记/记忆工具（如 note_manage）沉淀，或评估后忽略。', 'notice', '教训沉淀: ' + String(args.taskId || '')))
        delivered = true
      } catch (e) { console.error('[task-board] push-lesson followup failed:', String(e)) }
      return { ok: true, delivered: delivered }
    })
    handle('set-board-config', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { if (args.key === 'maxWorkers') d.maxWorkers = Math.max(1, Math.min(10, args.value || 3)); else if (args.key === 'maxVerifiers') d.maxVerifiers = Math.max(0, Math.min(5, args.value || 0)); else if (args.key === 'workerModel') d.workerModel = typeof args.value === 'string' ? args.value.trim() : ''; else if (args.key === 'verifierModel') d.verifierModel = typeof args.value === 'string' ? args.value.trim() : ''; else if (args.key === 'softTimeoutMin') d.softTimeoutMin = Math.max(1, Math.min(480, Number(args.value) || 30)); else if (args.key === 'hardTimeoutMin') d.hardTimeoutMin = Math.max(1, Math.min(1440, Number(args.value) || 120)); else if (args.key === 'feedbackEnabled') { d.feedbackEnabled = !!args.value; feedbackCache[sid] = d.feedbackEnabled } return { ok: true } }) })
    handle('create-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { if (args.id && d.tasks.find(function (x) { return x.id === args.id })) return { ok: false, error: 'duplicate id' }; if (args.dependsOn && args.dependsOn.length) { var derr = validateDeps(d, args.id || '(pending)', args.dependsOn); if (derr) return { ok: false, error: derr } }; var now = new Date().toISOString(); /* Team 模式护栏：draft 缺省跟随 teamMode（先补齐依赖/上下文再统一 publish）；显式 draft:false 保留为立即派发的逃生门 */ var asDraft = args.draft === undefined ? !!d.teamMode : !!args.draft; var t = { id: args.id || ('task-' + Date.now().toString(36)), title: args.title || 'Untitled', description: args.description || '', status: asDraft ? 'draft' : 'pending', priority: args.priority || 'medium', tags: args.tags || [], parentId: args.parentId || null, subtaskStrategy: null, assignMode: 'auto', assignee: null, context: { files: (Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : []), docs: [], instructions: args.instructions || '', notes: (typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : ''), relatedTasks: [], prerequisites: '' }, acceptance: args.acceptance || '', dependsOn: args.dependsOn || [], touches: normTouches(args.touches), pipeline: args.pipeline || '', claimedBy: null, claimedAt: null, createdAt: now, resolvedAt: null, verifiedAt: null, verifiedBy: null, archivedAt: null, resolution: null, waitingForTouches: null, messages: [], history: [{ from: 'created', to: asDraft ? 'draft' : 'pending', timestamp: now, actor: actor, note: asDraft ? 'created as draft' : 'created' }] }; if (!t.pipeline) { t.pipeline = classifyPipeline(t); t.pipelineAuto = true }; d.tasks.push(t); return withSplitHint({ ok: true, task: t }, t) }) })
    handle('list-children', async function (args) { var sid = rpcSessionId(args); var subs = ctx.subagents; if (!subs) return { ok: true, children: [] }; try { var list = await subs.listChildren(sid); var children = (list || []).map(function (c) { return { id: String(c.sessionId || c.id || ''), label: String(c.label || c.title || c.mode || '') } }).filter(function (c) { return c.id.length > 0 }); return { ok: true, children: children } } catch (e) { return { ok: true, children: [], error: String(e) } } })
    // ===== #14 批量操作：archive（仅 resolved/cancelled）/ set-priority（全部）/ delete（真删，无 undo）=====
    // delete op 与单任务 delete-task 走同一套 deleteGate 门禁（状态 + 未归档子任务），
    // done/skipped 语义与 archive 完全一致：门禁不过就进 skipped（附 reasons[id] 一行原因）。
    // 注意：批量删除是**真删**（从 tasks 数组移除），不产生 undo 快照——batch-undo 对 delete 无意义。
    handle('batch-op', async function (args) {
      var sid = rpcSessionId(args); var actor = getActorId()
      var ids = Array.isArray(args.ids) ? args.ids : []
      if (ids.length === 0) return { ok: false, error: 'no ids' }
      return mutateLocked(sid, function (d) {
        var done = 0, skipped = [], reasons = {}
        // skip 点统一收口：追加 id + 原因（原因只进 reasons，不改 skipped 的 string[] 老契约）
        function skip(id, why) { skipped.push(id); if (why) reasons[id] = why }
        ids.forEach(function (id) {
          var t = d.tasks.find(function (x) { return x.id === id })
          if (!t) { skip(id, '任务不存在'); return }
          if (args.op === 'delete') {
            var g = deleteGate(d, t)
            if (g.err) { skip(id, g.err); return }
            // archived 幂等：已归档的不再删（也不计入 done，与 archive 对已归档项的处理保持一致）
            if (g.mode === 'already') { skip(id, '已归档'); return }
            d.tasks = d.tasks.filter(function (x) { return x.id !== id })
            console.error('[task-board] batch delete: ' + id + ' «' + String(t.title || '').slice(0, 60) + '» (status=' + t.status + ') by ' + actor)
            done++
          } else if (args.op === 'archive') {
            if (t.status !== 'resolved' && t.status !== 'cancelled') { skipped.push(id); return }
            var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'batch archive'); done++
          } else if (args.op === 'set-priority') {
            if (['low', 'medium', 'high', 'critical'].indexOf(args.value) < 0) { skipped.push(id); return }
            t.priority = args.value; ah(t, t.status, t.status, actor, '批量设优先级: ' + args.value); done++
          } else if (args.op === 'publish') {
            if (t.status !== 'draft') { skipped.push(id); return }
            t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'batch publish'); done++
          } else { skipped.push(id) }
        })
        // reasons 只在 delete op 下有内容（其他 op 的跳过原因沿用"未命中门禁"的老行为），
        // 老客户端只读 skipped.length，多一个可选字段无感。
        return { ok: true, done: done, skipped: skipped, reasons: reasons }
      })
    })
    // #16 批量撤销：按快照恢复 priority（任何状态）与 status（仅 archive→resolved 回滚）
    // 明确不支持 op='delete'：删除是真删（任务对象已从 tasks 数组移除，快照里只剩 id/priority/status），
    // 没有任何可恢复的原始字段，撤销只能凭空造一张残缺卡片——所以 delete 不产生 undo 快照，
    // 客户端也不为 delete 显示「↩️ 撤销」按钮（snapshot 只在 done>0 且 op!=='delete' 时保留）。
    // 若老客户端硬发 op='delete' 快照进来，落到 else 分支只做 priority 回填，不会凭空复活任务。
    handle('batch-undo', async function (args) {
      var sid = rpcSessionId(args); var actor = getActorId()
      var snap = args && args.snapshot
      if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) return { ok: false, error: 'no snapshot' }
      return mutateLocked(sid, function (d) {
        var done = 0, skipped = []
        snap.items.forEach(function (it) {
          var t = d.tasks.find(function (x) { return x.id === it.id })
          if (!t) { skipped.push(it.id); return }
          t.priority = it.priority || t.priority
          if (snap.op === 'archive' && t.status === 'archived' && (it.status === 'resolved' || it.status === 'cancelled')) {
            t.status = it.status; delete t.archivedAt
            ah(t, 'archived', it.status, actor, '撤销批量归档')
          } else {
            ah(t, t.status, t.status, actor, '撤销批量优先级: ' + t.priority)
          }
          done++
        })
        return { ok: true, done: done, skipped: skipped }
      })
    })

    // ===== client ↔ host RPC：POST /dsh-agent-board { method, args } → JSON =====
    function readBody(req, limit) {
      return new Promise(function (resolve, reject) {
        var chunks = [], size = 0
        req.on('data', function (c) { size += c.length; if (size > limit) { reject(new Error('payload too large')); try { req.destroy() } catch (_) {} return }; chunks.push(c) })
        req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')) })
        req.on('error', reject)
      })
    }
    // ctx.webServer.register 只返回释放器、不绑定调用方 fiber（tools.register 才会），
    // 必须自己 ctx.effect 包住——否则插件禁用/重载后路由残留，handler 闭包指向已销毁的
    // fiber 内状态（500），且再次启用时撞 "duplicate exact route" 永远起不来。
    ctx.effect(function () {
      return ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-board',
      handler: async function (req, res) {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ ok: false, message: 'method not allowed' })); return }
        var payload = null
        try { payload = JSON.parse(await readBody(req, 4 * 1024 * 1024)) } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'bad request' })); return }
        var fn = payload && handlers[payload.method]
        if (!fn) { res.writeHead(404); res.end(JSON.stringify({ ok: false, message: 'unknown method: ' + payload.method })); return }
        try { var out = await fn(payload.args); res.writeHead(200); res.end(JSON.stringify(out === undefined ? null : out)) } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, message: String(e) })) }
      },
      })
    })

    console.log('[task-board] v74 loaded (pool removed: one-shot dispatch, context injected per task, dispose on settle)')
}

