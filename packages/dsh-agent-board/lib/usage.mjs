// dsh-agent-board — Token 消耗统计（lib/usage.mjs）
// v4 会话日志定位 / zstd 分帧 / usage 聚合：纯函数 + node 模块，不碰 ctx 与共享状态。
// index.mjs 薄壳 re-export findRunLog/readRunUsage/aggregateUsageSummary（对外契约不变）；
// readLogBytes/readLogFrames 新增 export 供 rpc.mjs 的 agent-activity 复用（原 index.mjs 模块内私有）。
import { zstdDecompressSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import fsNode from 'node:fs'

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
export function readLogBytes(logPath, tailBytes) {
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
export function readLogFrames(buf, limit) {
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

// 本地日期 key（YYYY-MM-DD）：与 dispatch.mjs 的日账记账同一口径。
// 用本地 getters 拼而不用 toISOString()——UTC 会把晚间消耗挪到次日，「今日消耗」直接错位。
function localDayKey(d) {
  var x = d
  function p2(n) { return (n < 10 ? '0' : '') + n }
  return x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate())
}
// ISO 串 → 本地日 key；缺失/解析失败返回 ''（宁可漏记一天，也不错记到别的日子）
function dayKeyOf(iso) {
  if (!iso) return ''
  var d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return localDayKey(d)
}

// 有效消耗 = 输入 + 输出 + 缓存写（不含缓存读）。
// 口径背景：本板实测累计 total 中缓存读占 94%（9.7M/10.3M），大数字被缓存读撑高约 17 倍，
// 与「真实花掉多少」严重脱节；有效消耗才是可比的成本口径，缓存读保留为独立可查分量。
export function effectiveTokens(u) {
  if (!u) return 0
  return numOr0(u.input) + numOr0(u.output) + numOr0(u.cacheWrite)
}

// 单卡「有效消耗」展示口径（task-muupnnq5）：ROI 行与 Token 消耗区必须同源，否则同一张卡两处两个数。
//   - 有结算分量（input/output/cacheWrite 任一为 >0 的数字）→ 有效消耗 = 输入+输出+缓存写（不含缓存读）；
//   - 无任何分量字段（老形态 / 只有 total 的存量卡）→ 兜底退化为 total，调用方可按 fallback 标注口径；
//   - 两者皆无 → null（表示「没有可用的结算记录」，调用方跳过该样本而不是记 0，避免拉低均值）。
// 返回 { tok, fallback, total }：tok 为 null 时整卡不参与均值。
export function taskEffectiveTokens(u) {
  if (!u) return { tok: null, fallback: false, total: null }
  var hasPart = numOr0(u.input) > 0 || numOr0(u.output) > 0 || numOr0(u.cacheWrite) > 0
  var tot = numOr0(u.total) > 0 ? numOr0(u.total) : null
  if (hasPart) return { tok: effectiveTokens(u), fallback: false, total: tot }
  if (tot !== null) return { tok: tot, fallback: true, total: tot }
  return { tok: null, fallback: false, total: null }
}

// 日账单元的归一化读取：新形态是 { t, e }（t=总量含缓存读，e=有效消耗不含缓存读），
// 老形态是裸 number（只有总量）→ e 返回 null 表示「不可知」——调用方按近似口径展示（标 ~），
// 绝不把总量冒充有效值（伪造一个有效数字比留 null 更坏）。
// 注意区分「不可知」与「真的是 0」：老 number 形态永远 e=null（哪怕 t=0）；
// 新对象形态缺 e 字段视为没记过有效值 → 同样 null（宁可显示 ~ 近似，不假装是 0）。
function dayCell(v) {
  if (v && typeof v === 'object') {
    var hasT = v.t !== undefined && v.t !== null
    var hasE = v.e !== undefined && v.e !== null
    var t = Number(v.t); var e = Number(v.e)
    return { t: (hasT && isFinite(t) && t > 0) ? t : 0, e: (hasE && isFinite(e)) ? e : null }
  }
  var n = Number(v)
  return { t: isFinite(n) && n > 0 ? n : 0, e: null }
}

// board 级聚合（get-tasks 现算，不落盘额外表）：总量 + 输入/输出/缓存读拆分 + 有效合计 + 按模型小计 + 任务 Top8 + 日账。
// 归档任务同样计入（它们确实消耗过 token）；无 usage 的任务跳过。
export function aggregateUsageSummary(tasks) {
  var s = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, effective: 0, byModel: {}, byDay: {}, topTasks: [] }
  var list = Array.isArray(tasks) ? tasks : []
  for (var i = 0; i < list.length; i++) {
    var t = list[i]; var u = t && t.usage
    if (!u) continue
    s.total += u.total || 0; s.input += u.input || 0; s.output += u.output || 0
    s.cacheRead += u.cacheRead || 0; s.cacheWrite += u.cacheWrite || 0
    s.effective += effectiveTokens(u)
    var ms = u.models || {}
    for (var mk in ms) { if (Object.prototype.hasOwnProperty.call(ms, mk)) s.byModel[mk] = (s.byModel[mk] || 0) + (ms[mk] || 0) }
    // Top8 带有效/缓存读拆分：仪表盘 Top 行 title 直接展示两个口径，点上就能核对虚高来源
    if (u.total) s.topTasks.push({ id: t.id, title: t.title, total: u.total, effective: effectiveTokens(u), cacheRead: u.cacheRead || 0, runs: u.runs || 0 })
    // 日账合并：任务自带 byDay（逐日精确）→ 逐 key 累加，并把日单元归一化成 {t,e}
    // （老 number 形态 → {t:n, e:null}，e 不可知就不猜；e 为 null 的日聚合后仍是 null）。
    // 存量兜底：本功能上线前结算的老任务没有 byDay，把整笔 total 归到 updatedAt 的本地日——
    // 近似口径（跨天老任务全部落在最后结算日），好过整段历史在「近 7 天」里凭空消失；
    // 无 updatedAt / 解析失败则不归任何日（宁可漏不错）。兜底路径同样只有总量（e=null）。
    var by = (u.byDay && typeof u.byDay === 'object') ? u.byDay : null
    var hasBy = false
    for (var bk in by) { if (Object.prototype.hasOwnProperty.call(by, bk)) { hasBy = true; break } }
    if (hasBy) {
      for (var dk in by) {
        if (!Object.prototype.hasOwnProperty.call(by, dk)) continue
        var c = dayCell(by[dk])
        // 累加器初值 e 用 undefined（=还没合并过任何来源），与「已知不可知」（null）区分开——
        // 若初值直接写 null，第一轮 cur.e===null 判定就把已知的有效值自我清空成 null（本实现踩过的坑）。
        // 合并规则：任一来源 e 不可知 → 该日 e 不可知（不假装算得出）；全部已知才累加。
        var cur = s.byDay[dk] || { t: 0, e: undefined }
        cur.t += c.t
        if (c.e === null) cur.e = null
        else if (cur.e !== null) cur.e = (cur.e || 0) + c.e
        if (cur.e === undefined) cur.e = null
        s.byDay[dk] = cur
      }
    } else if (u.total) {
      var lk = dayKeyOf(u.updatedAt)
      if (lk) { var lc = s.byDay[lk] || { t: 0, e: undefined }; lc.t += u.total; lc.e = null; s.byDay[lk] = lc }
    }
  }
  s.topTasks.sort(function (a, b) { return b.total - a.total })
  s.topTasks = s.topTasks.slice(0, 8)
  return s
}
