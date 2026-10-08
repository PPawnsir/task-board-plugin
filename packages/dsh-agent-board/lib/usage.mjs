// dsh-agent-board — Token 消耗统计（lib/usage.mjs）
// v4 会话日志定位 / zstd 分帧 / usage 聚合（含可续跑 Worker 的 seq 水位线增量结算）：纯函数 + node 模块，
// 不碰 ctx 与共享状态。
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

// ===== 水位线（sinceSeq）：可续跑 Worker 的「同一份日志多次结算」防重复计账 =====
// 背景（task-muw5hhsh 卡3）：一次性 run 各自一份日志文件，全量累加即正确；但 continuable 的
// 硬超时 interrupt 留存 + 重派冷复活续跑**沿用同一个子会话 → 同一份 v4 日志**——一个会话被结算
// 多次，整份全量累加会把上几轮的 token 反复记进看板（本机实测同一 childId 结算两次＝双倍账）。
// 水位线取事件自带的全序字段 seq（v4 日志每条事件都带 seq，会话内单调递增——用本机真实日志逐帧核对）：
//   结算时只认 seq > sinceSeq 的 assistant/message 增量帧，并把本份日志见过的 maxSeq 回给调用方
//   落在 t.runs[].usageSeq 上，下一轮结算从该水位继续。本轮完全没产出（maxSeq 不前进）→ 返回 null
//   （不是 0 值对象，调用方按「暂无数据」跳过），绝不再记一笔空账。
// sinceSeq 缺省（undefined/非正数）＝全量累加 → one-shot 路径逐字不变（水位的「首次结算」形态）。
export function readRunUsage(runId, sessionsRoot, sinceSeq) {
  try {
    var log = findRunLog(runId, sessionsRoot)
    if (!log) return null
    // 整份读取：usage 需要全部帧（单次 run 日志量级 MB，结算时只读一次）。
    // 极端超大日志封顶 64MB——只丢最老的历史帧，好过结算路径被一次同步 IO 拖住。
    // 注意与水位线的关系：封顶只可能丢「最老」帧（seq 小的），水位线语义不受影响。
    var buf = readLogBytes(log, 64 * 1024 * 1024)
    if (!buf) return null
    var frames = readLogFrames(buf, 0)
    var out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, model: '', maxSeq: -1 }
    var hasUsage = false
    var from = numOr0(sinceSeq)
    // 帧序是「从新到旧」，逐帧扫即可；maxSeq 取全份日志的最大 seq（含无 usage 的事件）——
    // 这样「本轮只有工具调用、没有新助手消息」也不会让水位线倒退（下一轮的增量判定仍然正确）。
    for (var fi = 0; fi < frames.length; fi++) {
      var evs = frames[fi]
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i]; var dta = (e && e.data) || {}
        var sq = numOr0(e && e.seq)
        if (sq > out.maxSeq) out.maxSeq = sq
        if (e && e.type === 'request/context' && dta.model && !out.model) out.model = String(dta.model)
        if (from > 0 && sq <= from) continue // 已结算过的历史帧（水位线之前）不再计入
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
// 导出供测试直接钉死口径（dispatch.mjs 仍持自己同名的一份——那边是记账热路径，不动）。
export function localDayKey(d) {
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

// ===== 统计范围（range）过滤：range = { from, to }，本地日 YYYY-MM-DD，两端都含、可各自缺省 =====
// 为什么在 host 侧过滤：run 级数据（runs[i].usage 五分量 + runs[i].at 时间戳）只在 host，
// 客户端轮询只拿聚合——范围筛选只能在这一层做，客户端没法自己裁。
// 口径：run 的本地日落点 localDayKey(run.at) 判 in/out；范围外 run 不计入 total/byModel/top，
// byDay 也同步裁到范围内（范围外日不入 byDay；run 留账任务按入选 run 逐日重建，to 端闭区间）。
// byDayFull 与范围无关恒为全量（task-muwsnyqv ②）——客户端「今日」「近 7 天」固定口径读它。
// 缺省（无 range / from 与 to 皆空）= 现状逐字不变（parity）：不引入任何新的过滤分支语义，
// 老任务（无 runs 留账）与无 at 的老 run 照旧全量计入。
function normDayKey(v) {
  if (v === undefined || v === null) return ''
  var s = String(v).trim()
  if (!s) return ''
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '' // 只认标准本地日 key，脏值当没填（宁可不过滤，不乱裁）
}
// 范围是否有效：两端都空视为「无范围」——调用方传 {from:'',to:''} 与不传等价（客户端空范围即此形态）
function rangeOn(range) {
  if (!range || typeof range !== 'object') return false
  return !!(normDayKey(range.from) || normDayKey(range.to))
}
// 日 key 是否落在范围内（字符串比较即可：YYYY-MM-DD 定长零填充，字典序 = 时间序）；端点缺省 = 该侧不设限
function dayInRange(dayKey, range) {
  var d = normDayKey(dayKey)
  if (!d) return false
  var from = normDayKey(range && range.from)
  var to = normDayKey(range && range.to)
  if (from && d < from) return false
  if (to && d > to) return false
  return true
}
// 一次 run 的 usage 分量提取：**任务级** t.runs[] 条目上的 usage 是 run 级留账
// （五分量俱全，dispatch.accumulateRunUsage 结算时按 runId 原样写回），条目同时自带 at/model。
// 字段位置务必分清（task-muwq9u04 的 bug 根因）：t.runs 是 run 记录**数组**，
// 而 t.usage.runs 只是「结算次数」的**计数**（number）——把后者当数组读会恒得空数组。
function runUsageOf(r) {
  var ru = r && r.usage
  if (!ru || typeof ru !== 'object') return null
  var tot = numOr0(ru.total)
  if (!tot) return null // 无总量的 run 条目不算一次有效结算（与 readRunUsage 的 hasUsage 同哲学）
  return { total: tot, input: numOr0(ru.input), output: numOr0(ru.output), cacheRead: numOr0(ru.cacheRead), cacheWrite: numOr0(ru.cacheWrite) }
}

// board 级聚合（get-tasks 现算，不落盘额外表）：总量 + 输入/输出/缓存读拆分 + 有效合计 + 按模型小计
// （合计与有效各一份）+ 任务 Top8 + 日账。归档任务同样计入（它们确实消耗过 token）；无 usage 的任务跳过。
// 第二参 range 可选（{from,to} 本地日）：给定时只计范围内 run（口径见上方 range 段）；省略/空范围 = 全量。
// 【范围过滤的数据源 · task-muwq9u04 修正】run 级留账在**任务级 t.runs[]**（dispatch 写入，条目形如
// { role, id, at, model, outcome, usage:{五分量} }）；t.usage.runs 只是「结算次数」计数（number）。
// 上一版把 uRaw.runs（= t.usage.runs 计数）当数组读 → 真实数据上恒为 []，范围过滤整个退化成
// 「按任务 updatedAt 单日近似」，于是切范围后 topTasks 与无范围逐字相同（用户活体实证：选 2026-10-05
// 后 total/byDay 收窄、Top8 第一名仍是全量 48M 的那张卡）。现在改为逐 run 精确裁切。
export function aggregateUsageSummary(tasks, range) {
  var s = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, effective: 0, byModel: {}, byModelEff: {}, byDay: {}, byDayFull: {}, topTasks: [] }
  var list = Array.isArray(tasks) ? tasks : []
  var hasRange = rangeOn(range)
  for (var i = 0; i < list.length; i++) {
    var t = list[i]; var uRaw = t && t.usage
    if (!uRaw) continue
    // ===== byDayFull：未过滤全量日账（task-muwsnyqv ②）=====
    // 「今日」「近 7 天」是固定口径（客户端 caption 承诺不随统计范围变），数据源必须是全量日账——
    // 只读范围内裁剪的 byDay 时，「今天被范围裁掉」会让今日大数字凭空归零（活体实证：范围
    // {10-05,10-06} 下今日条目整丢）。口径与无范围 byDay 逐字同源：任务级 uRaw.byDay 逐日合并
    // （老 number → e=null 不猜），无 byDay 的存量任务整笔归 updatedAt 本地日；与下方范围判定
    // 完全解耦（范围外任务照样计入 byDayFull），无范围时 byDayFull 与 byDay 内容一致（parity）。
    var byF = (uRaw.byDay && typeof uRaw.byDay === 'object') ? uRaw.byDay : null
    var hasByF = false
    for (var bk0 in byF) { if (Object.prototype.hasOwnProperty.call(byF, bk0)) { hasByF = true; break } }
    if (hasByF) {
      for (var dk0 in byF) {
        if (!Object.prototype.hasOwnProperty.call(byF, dk0)) continue
        var c0 = dayCell(byF[dk0])
        // 合并规则与 byDay 相同：任一来源 e 不可知 → 该日 e=null（不假装算得出）；全部已知才累加。
        var cur0 = s.byDayFull[dk0] || { t: 0, e: undefined }
        cur0.t += c0.t
        if (c0.e === null) cur0.e = null
        else if (cur0.e !== null) cur0.e = (cur0.e || 0) + c0.e
        if (cur0.e === undefined) cur0.e = null
        s.byDayFull[dk0] = cur0
      }
    } else if (numOr0(uRaw.total)) {
      var lkF = dayKeyOf(uRaw.updatedAt)
      if (lkF) { var lcF = s.byDayFull[lkF] || { t: 0, e: undefined }; lcF.t += numOr0(uRaw.total); lcF.e = null; s.byDayFull[lkF] = lcF }
    }
    // 过滤层只决定「这次任务贡献哪些用量」，下游累加口径（模型/Top/byDay）逐字不动。
    var u = uRaw
    if (hasRange) {
      var trs = Array.isArray(t.runs) ? t.runs : [] // 任务级 run 留档（真实数据源：条目自带 at + model + usage）
      var uSum = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      var models = null
      var modelsE = null
      var picked = 0 // 范围内入选的 run 数（Top8 的「N 次 run」在范围下报它）
      var covered = 0 // 落了 usage 的 run 数（判「有没有 run 级留账可裁」——与 at 无关）
      var modeledTot = 0 // 入选 run 里**记了模型名**的那部分总量（剩下的按任务级占比摊，见下）
      var modeledEff = 0
      var dayB = null // 入选 run 的逐日归桶（重建范围内 byDay，见下）
      for (var ri = 0; ri < trs.length; ri++) {
        var r = trs[ri]
        var ru = runUsageOf(r)
        if (!ru) continue // run 条目还没落 usage（老 run / 未结算）：不参与裁切，只影响 covered 计数
        covered++
        if (!dayInRange(dayKeyOf(r && r.at), range)) continue // 范围外 run：不计入任何分量
        picked++
        uSum.total += ru.total; uSum.input += ru.input; uSum.output += ru.output
        uSum.cacheRead += ru.cacheRead; uSum.cacheWrite += ru.cacheWrite
        // byDay 同步重建（task-muwsnyqv ①）：旧版合成的 u 丢 byDay/updatedAt → 范围内日账整块消失
        // （「今天被吞」实证：range 含今天时 total/effective 含今天、byDay 却无今天）。按入选 run 的
        // at 本地日逐日归桶——与范围过滤同一落点口径（dayInRange 两端闭区间：d > to 才丢），
        // from=to=今天 时今天必在 byDay。run 级五分量俱全 → e 恒为已知有效值（不是 null）。
        var rd = dayKeyOf(r && r.at)
        if (rd) {
          if (!dayB) dayB = {}
          var dc1 = dayB[rd] || { t: 0, e: 0 }
          dc1.t += ru.total; dc1.e += effectiveTokens(ru)
          dayB[rd] = dc1
        }
        // 按模型分布同步按范围收窄：模型 key 与结算同源（派发覆盖 > 日志记录），run 留账里没记模型名
        // → 退化为任务级模型小计，但只在本次有 run 入选时摊（否则等于把范围外消耗算进来）。
        // 合计与有效（byModel / byModelEff）同一轮同源累加，两条口径不各算一遍。
        var rm = (r && r.model) || ''
        if (rm) {
          if (!models) { models = {}; modelsE = {} }
          models[rm] = (models[rm] || 0) + ru.total
          modelsE[rm] = (modelsE[rm] || 0) + effectiveTokens(ru)
          modeledTot += ru.total; modeledEff += effectiveTokens(ru)
        }
      }
      if (picked) {
        // 有 run 入选：模型分布优先用 run 级重算（能精确按范围切）。
        var taskModels = (uRaw.models && typeof uRaw.models === 'object') ? uRaw.models : {}
        var tmKeys = []
        for (var tk in taskModels) { if (Object.prototype.hasOwnProperty.call(taskModels, tk)) tmKeys.push(tk) }
        var tTot = numOr0(uRaw.total)
        // 未被 run 级模型名归属的那部分用量（含「一条都没记模型名」的极端）按任务级模型小计占比摊派：
        // 模型键不凭空消失（真实数据里 r.model 常是空串——派发未覆盖模型时模型名只在日志里，
        // 而 u.models 用的是日志记录的名字），ΣbyModel 也仍与本次入选 total 对齐，不出现
        // 「按模型分布加起来 ≠ 累计」。全部入选 run 都记了模型名（restTot=0）→ 一个字节都不摊，保持精确。
        var restTot = uSum.total - modeledTot
        var restEff = effectiveTokens(uSum) - modeledEff
        if (tmKeys.length && (restTot > 0 || !models)) {
          if (!models) { models = {}; modelsE = {} }
          var ratio = tTot > 0 ? (restTot / tTot) : 0
          var ratioE = tTot > 0 ? (restEff / tTot) : 0
          for (var ti = 0; ti < tmKeys.length; ti++) {
            models[tmKeys[ti]] = (models[tmKeys[ti]] || 0) + Math.round(numOr0(taskModels[tmKeys[ti]]) * ratio)
            modelsE[tmKeys[ti]] = (modelsE[tmKeys[ti]] || 0) + Math.round(numOr0(taskModels[tmKeys[ti]]) * ratioE)
          }
        }
        u = { total: uSum.total, input: uSum.input, output: uSum.output, cacheRead: uSum.cacheRead, cacheWrite: uSum.cacheWrite, models: models || {}, modelEff: modelsE || {}, runs: picked, byDay: dayB || {} }
      } else if (!covered) {
        // 无 run 级留账可裁（本功能上线前的存量卡；或 runs 条目全都没落 usage）：没有 run 级时间戳，
        // 整笔退化为「updatedAt 的本地日」这一近似口径（与 byDay 存量兜底同源）；无 updatedAt / 解析失败 →
        // 无日可判 → 范围外（宁可漏不错，绝不把不知何时花的钱算进用户选的范围）。
        var lk0 = dayKeyOf(uRaw.updatedAt)
        if (!lk0 || !dayInRange(lk0, range)) continue
      } else {
        continue // 有 run 留账但范围内一条都没入选（含 run 无 at 的老数据）：本任务对本次范围零贡献
      }
    }
    var uTot = numOr0(u.total)
    if (!uTot) continue // 范围内无用量 → 不计入（也不进 Top，零值条目无信息量）
    var uEff = effectiveTokens(u) // 有效口径单点定义（effectiveTokens），与 ROI 行/近 7 天同源
    s.total += uTot; s.input += numOr0(u.input); s.output += numOr0(u.output)
    s.cacheRead += numOr0(u.cacheRead); s.cacheWrite += numOr0(u.cacheWrite)
    s.effective += uEff
    var ms = u.models || {}
    for (var mk in ms) { if (Object.prototype.hasOwnProperty.call(ms, mk)) s.byModel[mk] = (s.byModel[mk] || 0) + numOr0(ms[mk]) }
    // 按模型有效消耗（byModelEff）：口径统一后模型分布行的主数字也要是有效消耗，否则同一块里
    // 「今日有效 3.7M / 单模型 21M」并排自相矛盾。范围路径已按入选 run 精确算出；无范围路径
    // （以及 run 未记模型名的兜底）按该任务「有效/总量」比例摊派——Σ(byModelEff) 与 s.effective
    // 至多差各模型四舍五入的个位数，不制造新的口径矛盾。
    var meEff = (u.modelEff && typeof u.modelEff === 'object') ? u.modelEff : null
    if (meEff) {
      for (var me1 in meEff) { if (Object.prototype.hasOwnProperty.call(meEff, me1)) s.byModelEff[me1] = (s.byModelEff[me1] || 0) + numOr0(meEff[me1]) }
    } else {
      var ratioE2 = uTot > 0 ? (uEff / uTot) : 0
      for (var me2 in ms) { if (Object.prototype.hasOwnProperty.call(ms, me2)) s.byModelEff[me2] = (s.byModelEff[me2] || 0) + Math.round(numOr0(ms[me2]) * ratioE2) }
    }
    // Top8 带有效/缓存读拆分：仪表盘 Top 行主数字取 effective（有效消耗），合计/缓存读进 title 悬浮
    s.topTasks.push({ id: t.id, title: t.title, total: uTot, effective: uEff, cacheRead: numOr0(u.cacheRead), runs: u.runs || 0 })
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
        if (hasRange && !dayInRange(dk, range)) continue // 范围外日：不进 byDay（日账随范围一起裁，聚合体内不自相矛盾）
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

// ===== 主窗口（本会话对话）Token 消耗：增量尾读主会话自己的 v4 日志（task-muwsol23）=====
// 与 readRunUsage 的差异：主会话日志持续增长（可达数万事件），3s 轮询下每轮全量读会把
// 同步 IO 摊进轮询热路径——这里按「文件偏移水位」增量尾读，缓存条目由调用方持有（键=会话 id）：
//   { size, mtimeMs, total, input, output, cacheRead, cacheWrite, effective, byDay, hasUsage }
//   - size = 已结算到的文件偏移；只推进到「最后一个完整解压帧」的末尾——尾部半帧（写入中）
//     不结算，下轮从该偏移重读（绝不丢事件、绝不重复计账）；
//   - 文件变大 → 只读 [size, 新size) 的新增字节段（3s 轮询稳态零全量重读）；
//   - 文件变小（日志轮换/截断）→ 缓存作废，全量重读一次（封顶 64MB，与 readRunUsage 同一护栏）；
//   - 文件不变 → 零读直接用缓存聚合值。
// 聚合口径与 Worker 完全同源：五分量（input/output/cacheRead/cacheWrite/total）+ e=input+output+cacheWrite，
// 日落点取 assistant/message 事件的 time 字段（epoch ms）的本地日（与 run 口径同一 localDayKey）。
// 范围裁剪：缓存里存的是**未裁剪**全量聚合；range（{from,to} 本地日）在出参时按 byDay 逐日裁
// （与 run 口径同一 dayInRange，两端闭区间），范围内 total/effective/cacheRead 由入选日重算——
// 无日可判（无 time/坏 time）的事件只进平账不进任何日，范围下自然被裁（宁可漏不错）。
// 隔离红线：返回值只挂 usageSummary.mainWindow——不进 Top8 / 「本看板累计」/ 架构健康与学习飞轮基数。
// 失败静默降级：日志不存在/不可读/解不出任何 usage → null（客户端不渲染该行），绝不抛进轮询。
var MAINWIN_LOG_CAP = 64 * 1024 * 1024
// 聚合器初始形态（也是缓存条目形态）
function mainWinAcc() {
  return { size: 0, mtimeMs: 0, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, effective: 0, byDay: {}, hasUsage: false }
}
// 事件时间戳（v4 事件的 time 字段，epoch ms）→ 本地日 key；缺失/非法返回 ''（不进任何日账）
function dayKeyOfMs(ms) {
  var t = Number(ms)
  if (!isFinite(t) || t <= 0) return ''
  var d = new Date(t)
  if (isNaN(d.getTime())) return ''
  return localDayKey(d)
}
// 把 buf 内全部完整帧的 assistant/message usage 累加进 acc；返回「结算到」的相对偏移。
// 帧序旧→新扫（追加写）：中间坏帧跳过但照样结算掉（坏帧永远读不回来，别让水位卡住）；
// 最后一段解压失败 = 尾部半帧（写入进行中）→ 停在它的起点，下轮写完整后重读。
function mainWinAggregateFrames(acc, buf) {
  var offs = []
  var at = buf.indexOf(ZSTD_MAGIC)
  while (at >= 0) { offs.push(at); at = buf.indexOf(ZSTD_MAGIC, at + 1) }
  var consumed = 0
  for (var k = 0; k < offs.length; k++) {
    var end = k + 1 < offs.length ? offs[k + 1] : buf.length
    var lines = null
    try {
      lines = zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8').split('\n')
    } catch (_) {
      if (k === offs.length - 1) break // 尾部半帧：不结算，下轮从它的起点重读
      consumed = end; continue
    }
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) continue
      var e
      try { e = JSON.parse(lines[i]) } catch (_) { continue }
      if (!e || e.type !== 'assistant/message') continue
      var u = e.data && e.data.usage
      if (!u) continue
      var inp = numOr0(u.inputTokens), outp = numOr0(u.outputTokens)
      var cr = numOr0(u.cacheReadTokens), cw = numOr0(u.cacheWriteTokens)
      var tot = numOr0(u.totalTokens) || (inp + outp + cr + cw)
      var eff = inp + outp + cw
      acc.total += tot; acc.input += inp; acc.output += outp
      acc.cacheRead += cr; acc.cacheWrite += cw; acc.effective += eff
      acc.hasUsage = true
      var dk = dayKeyOfMs(e.time)
      if (dk) {
        var cell = acc.byDay[dk] || { t: 0, e: 0, cr: 0 }
        cell.t += tot; cell.e += eff; cell.cr += cr
        acc.byDay[dk] = cell
      }
    }
    consumed = end
  }
  return consumed
}
// 主窗口消耗读取入口。cacheStore 缺省（undefined/非对象）→ 不缓存每次全量读（测试/老宿主兜底）。
// 出参 byDay 单元为 { t, e, cr }（t=总量含缓存读，e=有效，cr=缓存读）——范围裁剪要按日重算
// 三个口径，故比 run 日账 {t,e} 多带一个缓存读分量；出参是副本，改出参不污染缓存。
export function readMainWindowUsage(sessionId, sessionsRoot, range, cacheStore) {
  try {
    if (!sessionId) return null
    var log = findRunLog(sessionId, sessionsRoot)
    if (!log) return null
    var st = null
    try { st = fsNode.statSync(log) } catch (_) { return null }
    var store = (cacheStore && typeof cacheStore === 'object') ? cacheStore : null
    var key = String(sessionId)
    var acc = store ? store[key] : null
    if (acc && st.size < acc.size) acc = null // 日志轮换/截断（文件变小）→ 缓存作废全量重读
    if (!acc) {
      var buf0 = readLogBytes(log, MAINWIN_LOG_CAP)
      if (!buf0) return null
      var base0 = st.size - buf0.length // 封顶截断时只丢最老帧（buf 起点对应绝对偏移 base0）
      acc = mainWinAcc()
      acc.size = base0 + mainWinAggregateFrames(acc, buf0)
      acc.mtimeMs = st.mtimeMs
      if (store) store[key] = acc
    } else if (st.size > acc.size) {
      // 增量尾读：只读新增字节段 [acc.size, st.size)；读取失败保留旧聚合值出数（降级不闪断，下轮再试）
      var buf1 = readLogBytes(log, st.size - acc.size)
      if (buf1) { acc.size += mainWinAggregateFrames(acc, buf1); acc.mtimeMs = st.mtimeMs }
    }
    // st.size === acc.size → 零读直接用缓存
    if (!acc.hasUsage) return null // 还没有任何 usage 事件 → 静默（客户端不渲染该行）
    var out = { total: 0, effective: 0, cacheRead: 0, byDay: {} }
    if (rangeOn(range)) {
      for (var dk in acc.byDay) {
        if (!Object.prototype.hasOwnProperty.call(acc.byDay, dk)) continue
        if (!dayInRange(dk, range)) continue
        var c = acc.byDay[dk]
        out.byDay[dk] = { t: c.t, e: c.e, cr: c.cr }
        out.total += c.t; out.effective += c.e; out.cacheRead += c.cr
      }
    } else {
      out.total = acc.total; out.effective = acc.effective; out.cacheRead = acc.cacheRead
      for (var dk2 in acc.byDay) {
        if (!Object.prototype.hasOwnProperty.call(acc.byDay, dk2)) continue
        var c2 = acc.byDay[dk2]
        out.byDay[dk2] = { t: c2.t, e: c2.e, cr: c2.cr }
      }
    }
    return out
  } catch (e) {
    // 展示统计绝不影响轮询：任何意外一律记日志降级为「无该行」
    console.error('[task-board] readMainWindowUsage failed (' + sessionId + '):', String(e))
    return null
  }
}

// ===== 记分卡数据底座（task-muxhshfu 卡1）：run 完备性体检 / 驳回归因 / 场景分桶 =====
// 三个 helper 全部纯函数零 IO（不碰 fs/不读时钟——日期只用 Date 解析已有字符串），供卡2聚合底座直接组合。
// 数据源是任务级 t.runs[] 留账（写路径见 dispatch.mjs recordRunHistory/closeRunHistory/accumulateRunUsage）：
//   新形态条目 { role, id, at, model, outcome, endedAt, usage:{五分量}, usageSeq, usageRecorded, continuable?, resume? }
//   老形态条目可能缺 model/endedAt/usage——聚合端退化口径在此收口（标缺失，绝不伪造）。

// 规模段边界常量（v1 写死）：按任务有效 token（effectiveTokens 口径：输入+输出+缓存写，不含缓存读）分桶——
// 小 <1M / 中 1M~10M / 大 >10M。边界归属：恰好 1M 归中、恰好 10M 归中（「<1M」「>10M」都是严格不等号）。
export var SIZE_BUCKET_SMALL_MAX = 1000000
export var SIZE_BUCKET_MEDIUM_MAX = 10000000
// 有效 token → 规模段（'small' | 'medium' | 'large'）。
// 非法/非正输入 → null：任务还没结算出有效消耗时「规模不可知」，调用方跳过该样本，不硬塞进小桶拉低口径。
export function sizeBucketOf(effTok) {
  var n = Number(effTok)
  if (!isFinite(n) || n <= 0) return null
  if (n < SIZE_BUCKET_SMALL_MAX) return 'small'
  if (n <= SIZE_BUCKET_MEDIUM_MAX) return 'medium'
  return 'large'
}

// 角色归一（场景桶的另一维）：run.role 原始值 → 'worker' | 'verifier' | 'other'。
// hook-pre/hook-post/缺省/未知一律 'other'——不计入 worker/verifier 对比桶，也不假装成 worker
//（老卡 runs[] 缺 role 时同理：宁可丢进 other，不污染两个主桶的驳回率/耗时口径）。
export function runRoleOf(r) {
  var role = r && r.role
  if (role === 'worker') return 'worker'
  if (role === 'verifier') return 'verifier'
  return 'other'
}

// run 条目完备性体检（卡1①）：continuable 时代一条「已落定」的 run 应齐 model/at/endedAt/outcome/usage
// 五组分（usage 以 total>0 为一次有效结算，与 runUsageOf 同口径；分量缺省视为 0，老形态只有 total 不判缺）。
//   · outcome==='running'（在飞/手动终止残留）：只核 at——model 要等结算时回填、endedAt/usage 结算才落，
//     它不是「缺字段」而是「还没结算」（手动终止刻意不关账，留 running = 不留续跑资格）；
//   · resume 是稀疏旗标（仅续跑记录置 true）：缺省即 false，永不计入 missing；
//   · 已落定 run 的 model 为 '' = 缺口：结算路径现已回填日志模型名（dispatch.accumulateRunUsage 补落账），
//     存量老数据仍会被这里如实量出——这正是体检要暴露的退化面。
// 返回 { status: 'complete' | 'running' | 'incomplete', missing: [字段名...] }（missing 仅 incomplete 时非空）。
export function auditRunEntry(r) {
  if (!r || typeof r !== 'object') return { status: 'incomplete', missing: ['entry'] }
  var missing = []
  if (!r.at || isNaN(new Date(r.at).getTime())) missing.push('at')
  var oc = String(r.outcome || '')
  if (!oc) { missing.push('outcome'); return { status: 'incomplete', missing: missing } }
  if (oc === 'running') return { status: missing.length ? 'incomplete' : 'running', missing: missing }
  if (!r.model) missing.push('model')
  if (!r.endedAt || isNaN(new Date(r.endedAt).getTime())) missing.push('endedAt')
  var u = r.usage
  if (!u || typeof u !== 'object' || numOr0(u.total) <= 0) missing.push('usage')
  return { status: missing.length ? 'incomplete' : 'complete', missing: missing }
}
// 板级体检汇总：逐 run 过 auditRunEntry，聚合出完备/在飞/缺字段三档计数 + 逐字段缺口分布。
// 纯体检不修改任何数据（补字段走写路径回填，不在这里改存量）。runs 明细供排查定位（taskId/runId/缺哪些）。
export function auditRunsCompleteness(tasks) {
  var s = { total: 0, complete: 0, running: 0, incomplete: 0, byField: { model: 0, at: 0, endedAt: 0, outcome: 0, usage: 0, entry: 0 }, runs: [] }
  var list = Array.isArray(tasks) ? tasks : []
  for (var i = 0; i < list.length; i++) {
    var t = list[i]
    var trs = (t && Array.isArray(t.runs)) ? t.runs : []
    for (var ri = 0; ri < trs.length; ri++) {
      var r = trs[ri]
      var a = auditRunEntry(r)
      s.total++
      if (a.status === 'complete') s.complete++
      else if (a.status === 'running') s.running++
      else s.incomplete++
      for (var mi = 0; mi < a.missing.length; mi++) {
        var f = a.missing[mi]
        if (s.byField[f] === undefined) s.byField[f] = 0
        s.byField[f]++
      }
      s.runs.push({ taskId: String(t && t.id || ''), runId: String(r && r.id || ''), role: runRoleOf(r), status: a.status, missing: a.missing })
    }
  }
  return s
}

// ===== 驳回归因（卡1②）：rejected 落定时刻 ↔ 该任务最近的 worker run =====
// 三条驳回来源在这里统一收口——它们都把驳回时刻落在 t.verification.at / messages(kind='rejection').at：
//   ① verifier 文本通道（settleVerifier：verification.by = verifier 自己的 run id）
//   ② board_verdict 工具通道（by = verifier 会话 actor）
//   ③ 主窗口 task_verify / 看板 verify-task（by = 主窗口 actor；direct 档任务没有 worker run → 归因 null）
// 归因目标恒为「被驳回的那次劳动」= 驳回时刻前最近一条 role='worker' 的 run——
// ⚠️ 不能直接取「时刻前最近一条 run」：verifier 自己的 run 也在 runs[] 里且时刻更晚，会自我归因。
// 跨天漂移：run.at 与驳回时刻不同本地日 → crossDay=true（老卡跨天驳回归因可能漂，聚合端标 ~ 不追求完美）。
// 返回 null = 无 worker run 可归（direct 档 / 老卡无 runs 留账）；
// 否则 { runId, model, at, crossDay, drifted }：
//   drifted=true 表示所有 worker run 的 at 都晚于驳回时刻（时钟回拨/老数据 at 脏）——
//   退化为「最新 worker run」兜底，聚合端同样按近似口径处理。
export function attributeRejection(t, rejectedAt) {
  if (!t || !Array.isArray(t.runs)) return null
  var rAt = Date.parse(rejectedAt) // 无效时刻 → NaN → 只认兜底臂
  var best = null   // at <= rejectedAt 的最近 worker run（倒序首个命中）
  var latest = null // 无视时刻的最新 worker run（兜底）
  for (var i = t.runs.length - 1; i >= 0; i--) {
    var r = t.runs[i]
    if (!r || r.role !== 'worker') continue
    if (!latest) latest = r
    var at = Date.parse(r.at)
    if (!isFinite(at)) continue // at 脏的 run 不参与时刻比较，但仍是最新兜底候选
    if (!isFinite(rAt) || at <= rAt) { best = r; break }
  }
  var run = best || latest
  if (!run) return null
  var dkRun = dayKeyOf(run.at)
  var dkRej = dayKeyOf(rejectedAt)
  return {
    runId: String(run.id || ''),
    model: String(run.model || ''),
    at: String(run.at || ''),
    crossDay: !!(dkRun && dkRej && dkRun !== dkRej),
    drifted: !best
  }
}

// ===== 记分卡聚合底座（task-muxhtgh9 卡2）：scoreboard = 模型×角色×规模段七指标桶 + 全局质量趋势 rollup =====
// 设计稿 v3（笔记 n-muwsq9yztrpa）。数据源与卡1相同：任务级 t.runs[] 留账 + t.messages 驳回包
// （kind='rejection'，三条驳回来源统一落点，pushRejection 已按 at/文本头判重）+ 落定时刻
// （approved 验收 = t.verifiedAt；direct/work 档直落 resolved = t.resolvedAt）。纯函数零 IO：
// 不碰 fs/不读时钟，日期只解析已有字符串（与卡1 helper 同一纪律）。
//
// 两层结构（增量缓存的关键）：
//   提取层 buildScoreRecs(tasks)：扫全部任务的 runs/驳回消息，产出归一化记录 —— 唯一的重活
//     （逐 run 归一 + 驳回归因 + 日落点解析 + 任务级规模段都在这层）。
//   装配层 assembleScoreboard(recs, range)：七指标桶 + 趋势 rollup + 范围裁剪，每次调用现算，
//     输入只是归一化记录（轻量数组 pass）——范围切换不触发重提取。
// 增量缓存：runs 只增不改 —— 缓存槽（调用方持有，与 mainWindow 尾读缓存并列在 state）形态
//   { taskCount, stamp, recs }，键 = (任务数, 最新落定时刻)。stamp 在「最新 run at/endedAt」上扩了
//   verifiedAt / resolvedAt / 驳回消息 at / t.usage.updatedAt：驳回与验收只改 messages/status 不改 runs，
//   usage 落账（accumulateRunUsage）只写 usage 分量与 usage.updatedAt 不回填 endedAt——不看这些会出陈账
//   （驳回率/一次通过率/缓存命中率永远停在首次缓存值）。探针 scoreProbe 只做 Date.parse 取最大值
//   （不解析日 key、不归因、不分配记录），比提取层便宜一个量级；命中即整份复用，提取层零重算。
// 样本量护栏：桶内 runs < SCOREBOARD_MIN_SAMPLE（5）标 insufficient:true（卡3 客户端据此灰显不排名）。
export var SCOREBOARD_MIN_SAMPLE = 5

// 探针：不分配记录地扫出 (任务数, 最新落定时刻) 缓存键。Date.parse 缺失/脏值 → NaN → 不参与 max。
function scoreProbeMax(stamp, v) { var n = Date.parse(v); return (isFinite(n) && n > stamp) ? n : stamp }
function scoreProbe(tasks) {
  var stamp = 0
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i]
    if (!t || typeof t !== 'object') continue
    stamp = scoreProbeMax(stamp, t.verifiedAt)
    stamp = scoreProbeMax(stamp, t.resolvedAt)
    if (t.usage && typeof t.usage === 'object') stamp = scoreProbeMax(stamp, t.usage.updatedAt)
    var trs = Array.isArray(t.runs) ? t.runs : []
    for (var ri = 0; ri < trs.length; ri++) {
      var r = trs[ri]
      if (!r) continue
      stamp = scoreProbeMax(stamp, r.at)
      stamp = scoreProbeMax(stamp, r.endedAt)
    }
    var ms = Array.isArray(t.messages) ? t.messages : []
    for (var mi = 0; mi < ms.length; mi++) {
      if (ms[mi] && ms[mi].kind === 'rejection') stamp = scoreProbeMax(stamp, ms[mi].at)
    }
  }
  return { count: tasks.length, stamp: stamp }
}

// 提取层：全量扫出归一化记录（缓存未命中才跑）。
//   runRec：{ taskId, model, role, size, day, durMs, eff, inp, cr, outcome, resume }
//     —— 只收已落定 run（outcome 存在且非 'running'；在飞/手动终止残留还没结算，不进任何指标，与卡1体检同口径）。
//     eff/inp/cr 为 null = 该 run 无 usage 留账（老 run/未结算）：进 runs 计数但不进 token/缓存口径（不伪造 0）。
//   taskRec：{ id, resolved, resolvedDay, cardDurMs, rejectCount }
//     —— 规模段按任务有效 token（taskEffectiveTokens 口径，卡1 sizeBucketOf 同一界线）；null=规模不可知，
//     run 仍进趋势但不进桶（不硬塞小桶拉低口径）。
//   rejRec：{ taskId, runId, model, size, rDay }——驳回事件按卡1 attributeRejection 归到「驳回前最近 worker run」；
//     runId='' = 无 worker run 可归（direct 档/老卡无 runs），装配层如实计 rejUnattributed，不硬塞桶。
function buildScoreRecs(tasks) {
  var runRecs = [], taskRecs = [], rejRecs = []
  var stamp = 0
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i]
    if (!t || typeof t !== 'object') continue
    var size = sizeBucketOf(taskEffectiveTokens(t.usage).tok)
    // 落定时刻：approved 验收 = verifiedAt（verifyApply）；direct/work 档直落 resolved = resolvedAt（resolveApply）
    var rsAt = t.verifiedAt || t.resolvedAt || ''
    var rsMs = Date.parse(rsAt)
    var resolved = t.status === 'resolved'
    var resolvedDay = (resolved && isFinite(rsMs)) ? dayKeyOf(rsAt) : ''
    stamp = scoreProbeMax(stamp, rsAt)
    var cMs = Date.parse(t.createdAt)
    // 卡时长 = createdAt → 落定时刻；缺任一端/倒挂 → null（不参与分布桶，不伪造）
    var cardDurMs = (resolved && isFinite(cMs) && isFinite(rsMs) && rsMs >= cMs) ? (rsMs - cMs) : null
    var rejCnt = numOr0(t.rejectCount)
    var tid = String(t.id || '')
    taskRecs.push({ id: tid, resolved: resolved, resolvedDay: resolvedDay, cardDurMs: cardDurMs, rejectCount: rejCnt })
    if (t.usage && typeof t.usage === 'object') stamp = scoreProbeMax(stamp, t.usage.updatedAt)
    var trs = Array.isArray(t.runs) ? t.runs : []
    for (var ri = 0; ri < trs.length; ri++) {
      var r = trs[ri]
      if (!r || typeof r !== 'object') continue
      var oc = String(r.outcome || '')
      if (!oc || oc === 'running') continue // 在飞/手动终止残留：不算缺字段，是还没结算
      stamp = scoreProbeMax(stamp, r.at)
      stamp = scoreProbeMax(stamp, r.endedAt)
      var aMs = Date.parse(r.at), eMs = Date.parse(r.endedAt)
      var ru = runUsageOf(r) // 五分量或 null（老 run/未结算）
      runRecs.push({
        taskId: tid,
        model: String(r.model || ''),
        role: runRoleOf(r),
        size: size,
        day: dayKeyOf(r.at),
        durMs: (isFinite(aMs) && isFinite(eMs) && eMs >= aMs) ? (eMs - aMs) : null,
        eff: ru ? effectiveTokens(ru) : null,
        inp: ru ? ru.input : null,
        cr: ru ? ru.cacheRead : null,
        outcome: oc,
        resume: r.resume === true
      })
    }
    // 驳回事件：三条来源统一落 t.messages kind='rejection'（判重已在写入侧），读取只认这一个落点
    var ms = Array.isArray(t.messages) ? t.messages : []
    for (var mi = 0; mi < ms.length; mi++) {
      var m = ms[mi]
      if (!m || m.kind !== 'rejection' || !m.at) continue
      stamp = scoreProbeMax(stamp, m.at)
      var attr = attributeRejection(t, m.at) // null = 无 worker run 可归（direct 档/老卡无 runs 留账）
      var rDay = ''
      if (attr) {
        for (var ri2 = 0; ri2 < trs.length; ri2++) {
          if (trs[ri2] && String(trs[ri2].id) === attr.runId) { rDay = dayKeyOf(trs[ri2].at); break }
        }
      }
      // text/mDay（卡5 驳回聚类）：驳回原文与驳回消息自身日落点随 rejRec 带出——
      // messages 只增不改（pushRejection 判重后只 push，无编辑路径），缓存键已含驳回 at，无陈账风险。
      rejRecs.push({ taskId: tid, runId: attr ? attr.runId : '', model: attr ? attr.model : '', size: size, rDay: rDay, mDay: dayKeyOf(m.at), text: String(m.text || '') })
    }
  }
  return { stamp: stamp, runRecs: runRecs, taskRecs: taskRecs, rejRecs: rejRecs }
}

// 耗时分布：最近秩口径 p90 = sorted[ceil(0.9n)-1]；中位数偶数 n 取两中值均值。空数组 → 两个 null。
function medP90(durs) {
  if (!durs.length) return { med: null, p90: null }
  durs.sort(function (a, b) { return a - b })
  var n = durs.length
  var med = (n % 2) ? durs[(n - 1) / 2] : (durs[n / 2 - 1] + durs[n / 2]) / 2
  return { med: med, p90: durs[Math.min(n - 1, Math.ceil(n * 0.9) - 1)] }
}

// 装配层：归一化记录 → scoreboard。范围裁剪在这层现算（run 日落点 dayInRange 两端闭区间，
// 与 usageSummary 同一 range 口径）；缓存命中与否不影响裁剪正确性（裁剪不依赖提取结果以外的状态）。
function assembleScoreboard(recs, range) {
  var hasRange = rangeOn(range)
  var bmap = {}   // bucketKey(model|role|size) -> 聚合器
  var bTasks = {} // bucketKey -> { taskId: true }（桶内任务级指标的分母来源）
  var meta = { tasks: recs.taskRecs.length, runsSettled: recs.runRecs.length, bucketed: 0, roleOther: 0, noModel: 0, noSize: 0, rejUnattributed: 0 }
  var tr = { firstPassByDay: {}, durationBuckets: { lt10m: 0, m10to30: 0, m30to60: 0, gt60m: 0 }, timeoutByDay: {}, rejectByDay: {}, resume: { runs: 0, completed: 0, rate: null } }
  // ===== 任务级趋势：一次通过率 byDay（resolved 任务按落定日）+ 卡时长分布四桶 =====
  var tById = {}
  for (var ti = 0; ti < recs.taskRecs.length; ti++) {
    var trc = recs.taskRecs[ti]
    tById[trc.id] = trc
    if (!trc.resolved) continue
    if (hasRange && !dayInRange(trc.resolvedDay, range)) continue // resolvedDay ''（老数据）范围下剔除：宁可漏不错
    if (trc.resolvedDay) {
      var fc = tr.firstPassByDay[trc.resolvedDay] || { resolved: 0, firstPass: 0 }
      fc.resolved++
      if (!trc.rejectCount) fc.firstPass++
      tr.firstPassByDay[trc.resolvedDay] = fc
    }
    if (trc.cardDurMs !== null) {
      // <10m / 10-30m / 30-60m（含 60m 端点，与规模段「含端归中」同哲学）/ >60m
      if (trc.cardDurMs < 600000) tr.durationBuckets.lt10m++
      else if (trc.cardDurMs < 1800000) tr.durationBuckets.m10to30++
      else if (trc.cardDurMs <= 3600000) tr.durationBuckets.m30to60++
      else tr.durationBuckets.gt60m++
    }
  }
  // ===== run 级：趋势（全角色全模型，「全部模型」汇总只看日落点）+ 桶（worker/verifier × 有模型 × 规模可知）=====
  for (var qi = 0; qi < recs.runRecs.length; qi++) {
    var q = recs.runRecs[qi]
    var inR = !hasRange || dayInRange(q.day, range) // day ''（无 at 老 run）范围下剔除
    if (inR) {
      // 超时率走势 byDay：落定值实测是 'timeout/error'（dispatch.settleRun 失败臂 + 幽灵回收），
      // 字面 'timeout' 兼容预留。日落点取 run.at（与范围裁剪同一口径）。
      if (q.day) {
        var tc = tr.timeoutByDay[q.day] || { runs: 0, timeout: 0 }
        tc.runs++
        if (q.outcome === 'timeout/error' || q.outcome === 'timeout') tc.timeout++
        tr.timeoutByDay[q.day] = tc
      }
      // 续跑成功率：resume 稀疏旗标（仅续跑记录置 true）的 run 里，最终 completed 的占比
      if (q.resume) { tr.resume.runs++; if (q.outcome === 'completed') tr.resume.completed++ }
    } else {
      // 范围外 run 不进趋势也不进桶（meta 计数保持范围口径：裁剪后还剩多少进了桶）
      if (hasRange) continue
    }
    if (q.role === 'other') { meta.roleOther++; continue } // hook/缺省角色不进 worker/verifier 对比桶（卡1口径）
    if (!q.model) { meta.noModel++; continue }             // 老 run 缺模型名：如实计数，不硬塞「(未知)」桶
    if (!q.size) { meta.noSize++; continue }               // 任务未结算出有效消耗：规模不可知，不进桶
    var key = q.model + '|' + q.role + '|' + q.size
    var b = bmap[key]
    if (!b) {
      b = { key: key, model: q.model, role: q.role, size: q.size, runs: 0, effSum: 0, effCount: 0, durs: [], rejected: 0, resolved: 0, firstPass: 0, timeouts: 0, resumes: 0, inpSum: 0, crSum: 0 }
      bmap[key] = b; bTasks[key] = {}
    }
    b.runs++
    meta.bucketed++
    if (q.eff !== null) { b.effSum += q.eff; b.effCount++ }
    if (q.durMs !== null) b.durs.push(q.durMs)
    if (q.outcome === 'timeout/error' || q.outcome === 'timeout') b.timeouts++
    if (q.resume) b.resumes++
    if (q.inp !== null || q.cr !== null) { b.inpSum += q.inp || 0; b.crSum += q.cr || 0 }
    bTasks[key][q.taskId] = true
  }
  // ===== 驳回率：归因到桶（卡1 attributeRejection 已在提取层跑完，这里只按桶累加）=====
  for (var ji = 0; ji < recs.rejRecs.length; ji++) {
    var j = recs.rejRecs[ji]
    // 无 run 可归 / 归因 run 缺模型 / 任务规模不可知 → 如实计 rejUnattributed，不塞进任何桶
    if (!j.runId || !j.model || !j.size) { meta.rejUnattributed++; continue }
    // 与被驳回 run 的桶归属同一裁剪口径：run 被范围裁掉，其驳回也随之裁掉（聚合体不自相矛盾）
    if (hasRange && !dayInRange(j.rDay, range)) continue
    var jb = bmap[j.model + '|worker|' + j.size]
    if (jb) jb.rejected++
    else meta.rejUnattributed++ // 归因 run 自身没进桶的边缘（记录被裁/缺字段）：不凭空造桶
  }
  // ===== 一次通过率（任务级指标）：桶内 resolved 任务中 rejectCount=0 的占比 =====
  // 任务按「它有哪些 run 落在这个桶」归属（一张卡多个模型的 run 会各进各桶）；范围下按 resolvedDay 裁剪
  //（落定日不在范围内 → 不计入分子分母）。
  for (var bk in bmap) {
    if (!Object.prototype.hasOwnProperty.call(bmap, bk)) continue
    var bb = bmap[bk]
    var tset = bTasks[bk]
    for (var tId in tset) {
      if (!Object.prototype.hasOwnProperty.call(tset, tId)) continue
      var tk = tById[tId]
      if (!tk || !tk.resolved) continue
      if (hasRange && !dayInRange(tk.resolvedDay, range)) continue
      bb.resolved++
      if (!tk.rejectCount) bb.firstPass++
    }
  }
  // ===== 七指标定稿 =====
  var out = []
  for (var fk in bmap) {
    if (!Object.prototype.hasOwnProperty.call(bmap, fk)) continue
    var f = bmap[fk]
    var mp = medP90(f.durs)
    out.push({
      model: f.model, role: f.role, size: f.size, runs: f.runs,
      // ① 有效 token：均值 + 总额（有效口径 = 输入+输出+缓存写，与 effectiveTokens 单点同源）
      effSum: f.effSum, effAvg: f.effCount ? Math.round(f.effSum / f.effCount) : null,
      // ② 耗时：endedAt - at，中位数 + P90（ms）；无合法时刻的 run 不进分布
      durMedianMs: mp.med, durP90Ms: mp.p90,
      // ③ 驳回率 = 归因到本桶 run 的驳回次数 / 桶内 runs
      rejected: f.rejected, rejectRate: f.runs ? f.rejected / f.runs : 0,
      // ④ 一次通过率 = 桶内 resolved 且 rejectCount=0 / 桶内 resolved（无 resolved 任务 → null，不假装 0）
      resolved: f.resolved, firstPass: f.firstPass, firstPassRate: f.resolved ? f.firstPass / f.resolved : null,
      // ⑤ 超时率 = outcome 超时落定 / 桶内 runs
      timeouts: f.timeouts, timeoutRate: f.runs ? f.timeouts / f.runs : 0,
      // ⑥ 续跑率 = resume:true 的 run / 桶内 runs
      resumes: f.resumes, resumeRate: f.runs ? f.resumes / f.runs : 0,
      // ⑦ 缓存命中率 = cacheRead / max(input+cacheRead, 1)。
      //   ⚠️ provider 口径差异钉：本看板数据源（v4 日志 usage）实测 input 与 cacheRead 分列（kimi/anthropic
      //   口径）；若某 provider 把缓存读并进 input，分母被双计、命中率失真——跨 provider 对比先核各家口径。
      //   无 usage 样本（inpSum+crSum=0）→ null（不假装 0）。
      cacheHitRate: (f.inpSum + f.crSum) > 0 ? f.crSum / (f.inpSum + f.crSum) : null,
      // 样本量护栏：runs < 5 标 insufficient（客户端据此灰显不排名）
      insufficient: f.runs < SCOREBOARD_MIN_SAMPLE
    })
  }
  // 稳定排序：有效总额降序（主对比维度），并列按 key 字典序（轮询间输出不抖动）
  out.sort(function (a, b2) {
    var dd = b2.effSum - a.effSum
    if (dd !== 0) return dd
    return a.model + '|' + a.role + '|' + a.size < b2.model + '|' + b2.role + '|' + b2.size ? -1 : 1
  })
  tr.resume.rate = tr.resume.runs ? tr.resume.completed / tr.resume.runs : null
  // ===== 驳回聚类（卡5①，task-muxhu1zv）：规则法 Top3 + 约定建议文本 =====
  // 裁剪口径：按驳回消息**自身**日落点 mDay（与驳回率桶的归因 run 日落点 rDay 相互独立）——
  // direct 档 / 无 worker run 可归的驳回同样是学习飞轮样本，不能因归因失败从聚类里消失；
  // mDay=''（无 at 老数据）在范围下剔除（宁可漏不错，与全局 range 哲学一致）。
  var rejTexts = []
  for (var ci = 0; ci < recs.rejRecs.length; ci++) {
    var rcj = recs.rejRecs[ci]
    if (hasRange && !dayInRange(rcj.mDay, range)) continue
    // 驳回率 byDay（质量异动告警③ 的数据源，异常驱动审视②）：按驳回消息自身本地日落点逐日计数——
    // 与 rejectionClusters 同一 mDay 口径（direct 档 / 无 worker run 可归的驳回同样是样本，不因归因失败消失）。
    if (rcj.mDay) { var rbd = tr.rejectByDay[rcj.mDay] || (tr.rejectByDay[rcj.mDay] = { rejects: 0 }); rbd.rejects++ }
    rejTexts.push(rcj.text)
  }
  return { buckets: out, trends: tr, meta: meta, rejectionClusters: clusterRejections(rejTexts) }
}

// 记分卡聚合入口（get-tasks 内组装到 usageSummary.scoreboard）。
// cacheStore 缺省/非对象 → 不缓存每次全量提取（测试/老宿主兜底，与 readMainWindowUsage 同约定）。
// 命中（taskCount 与 stamp 双双相同）→ 提取层零重算，只做装配层范围裁剪现算。
export function buildScoreboard(tasks, range, cacheStore) {
  var list = Array.isArray(tasks) ? tasks : []
  var store = (cacheStore && typeof cacheStore === 'object') ? cacheStore : null
  var recs = null
  if (store && store.recs) {
    var pb = scoreProbe(list)
    if (store.taskCount === pb.count && store.stamp === pb.stamp) recs = store.recs
  }
  if (!recs) {
    recs = buildScoreRecs(list)
    if (store) { store.taskCount = list.length; store.stamp = recs.stamp; store.recs = recs }
  }
  return assembleScoreboard(recs, range)
}

// ===== 驳回聚类 Top3（卡5①，task-muxhu1zv）：规则法，不上 embedding =====
// 驳回文本结构高度模板化（rejectionText 产物：「验收驳回 · <summary>\n\n核对项：\n<checks>」），
// 规则表按主窗口验收驳回的真实高频原因归纳（本机看板驳回库为空时的种子表，随真实样本增补）：
// 每条驳回只归入**第一个命中**的类目（规则表顺序 = 优先级），占比分母 = 驳回总数（Σpct ≤ 100%）；
// 全部未命中进 'other' 兜底桶（如实计数参与排名，建议文案只能给通用模板——人工归纳后再补规则）。
// 纯函数零 IO；texts 为驳回原文数组（装配层已按范围裁剪），空数组 → total:0 top:[]，绝不抛错。
export var REJECTION_CLUSTER_RULES = [
  { id: 'acceptance-skipped', label: '验收脚本未实跑', re: /验收脚本|未实跑|未跑|没跑|真实输出|逐字粘贴|自测没过|自测不/, advice: '在派发约定/Worker prompt 补一条：上报前必须逐字粘贴验收脚本真实输出（未通过不得上报完成）' },
  { id: 'readme-stale', label: 'README 未同步', re: /README|文档未|文档不|未同步/, advice: '在派发约定补一条：行为/口径/界面变化必须同步 README 双份并逐字一致（npm run sync-readme）' },
  { id: 'scope-creep', label: '范围越界', re: /范围越界|越界|范围外|改了别|额外改动|顺带改|顺手改/, advice: '在派发约定补一条：只改任务 touches 声明范围内的文件；范围外发现的问题另建卡，不顺带改' },
  { id: 'assertion-missing', label: '断言缺失', re: /断言/, advice: '在派发约定补一条：任务断言必须逐条配单测锁定——断言无测试视为未完成' },
  { id: 'artifact-stale', label: '产物未重组装', re: /重组装|重新组装|产物未|build-client|组装产物|未重建|未重新构建/, advice: '在派发约定补一条：改完组装源（lib/client/* 等）必须重组装产物（npm run build-client）再上报' },
]
var REJ_CLUSTER_OTHER = { id: 'other', label: '其他（未匹配规则）', advice: '人工归纳该类驳回的共性后，在派发约定/Worker prompt 补一条对应规则' }
var REJ_SAMPLE_MAX = 3   // 每类代表原文最多保留条数
var REJ_SAMPLE_CLIP = 80 // 代表原文截断长度（客户端放 title 悬浮）

// texts → { total, top: [{ id, label, count, pct, samples, suggestion }], otherCount, restCount }
//   top 最多 3 条（count 降序，并列按规则表顺序、other 恒排最后）；
//   pct = Math.round(count/total*100)（整数百分比）；samples = 该类前 3 条原文各截 80 字；
//   suggestion = 「驳回 TopN『label』占 pct%——建议<类目 advice>」（结构化约定建议文本，卡5②）。
export function clusterRejections(texts) {
  var out = { total: 0, top: [], otherCount: 0, restCount: 0 }
  var list = Array.isArray(texts) ? texts : []
  var acc = [] // 与规则表同序的累加器 + 末尾 other
  var ri
  for (ri = 0; ri <= REJECTION_CLUSTER_RULES.length; ri++) {
    var rule = ri < REJECTION_CLUSTER_RULES.length ? REJECTION_CLUSTER_RULES[ri] : REJ_CLUSTER_OTHER
    acc.push({ id: rule.id, label: rule.label, advice: rule.advice, count: 0, samples: [] })
  }
  for (var i = 0; i < list.length; i++) {
    var text = String(list[i] == null ? '' : list[i])
    if (!text.trim()) continue // 空文本不算一条驳回样本（防御脏数据，不稀释占比）
    out.total++
    var hit = acc.length - 1 // 缺省 other
    for (ri = 0; ri < REJECTION_CLUSTER_RULES.length; ri++) {
      if (REJECTION_CLUSTER_RULES[ri].re.test(text)) { hit = ri; break } // 首命中即归类（顺序=优先级）
    }
    var a = acc[hit]
    a.count++
    if (a.samples.length < REJ_SAMPLE_MAX) a.samples.push(text.slice(0, REJ_SAMPLE_CLIP))
  }
  // count>0 的类目参与排名：count 降序，并列按 acc 下标（规则表顺序，other 天然最后）
  var ranked = acc.filter(function (x) { return x.count > 0 }).sort(function (x, y) {
    if (y.count !== x.count) return y.count - x.count
    return acc.indexOf(x) - acc.indexOf(y)
  })
  for (var k = 0; k < ranked.length; k++) {
    var r = ranked[k]
    if (r.id === 'other') out.otherCount = r.count
    if (k < 3) {
      var pct = Math.round(r.count / out.total * 100)
      out.top.push({
        id: r.id, label: r.label, count: r.count, pct: pct, samples: r.samples,
        suggestion: '驳回 Top' + (k + 1) + '『' + r.label + '』占 ' + pct + '%——建议' + r.advice,
      })
    }
  }
  out.restCount = ranked.length > 3 ? ranked.length - 3 : 0 // Top3 之外还有几类（客户端 caption 提示用）
  return out
}

// ===== 按表现荐模型 hint（卡5③，task-muxhu1zv）：healthHints 通道的规则 =====
// 判定（全部满足才亮，任一不达标静默返回 null——无足够数据不亮）：
//   桶范围：role='worker' 且规模段 ∈ {small, medium}（中小卡桶；verifier 与大卡不参与——荐的是默认
//     workerModel，大卡样本少且成本结构不同质）。同模型的中小桶合并成模型级样本再判。
//   ① 样本量：模型合并 runs >= MODEL_HINT_MIN_RUNS（10）——恰好 10 合格，9 不亮；
//   ② 一次通过率：合并 firstPass/resolved >= MODEL_HINT_MIN_PASS（0.9）——恰好 90% 合格，89% 不亮；
//      resolved=0（桶内无落定任务）→ 通过率不可知，不判（不假装 0%）；
//   ③ 有效均值显著更低：候选 = 合格模型中 effAvg（ΣeffSum/ΣeffCount）最低者，且对**其他每个**合格
//      模型的 effAvg 都严格低 >MODEL_HINT_EFF_GAP（30%，取最小差距判定——最保守口径；恰好 30% 不亮）；
//      合格模型 <2 个 → 无对比对象，「显著低于其他」无从谈起 → null。
// 返回 healthHints 条目形态 { level: 'warn', text }（黄条），由 rpc get-tasks 拼进 d.healthHints。
export var MODEL_HINT_MIN_RUNS = 10
export var MODEL_HINT_MIN_PASS = 0.9
export var MODEL_HINT_EFF_GAP = 0.3

// token 数量简写（hint 文案用）：>=1M → X.XM，>=1K → X.XK，否则取整原数
function fmtTokShort(n) {
  if (!isFinite(n) || n < 0) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(Math.round(n))
}

export function modelPerfHint(sb) {
  if (!sb || !Array.isArray(sb.buckets)) return null
  // 按模型合并 worker × 中小卡桶（单桶样本常不足 10，合并后模型级样本才是判定基准）
  var mm = {}
  for (var i = 0; i < sb.buckets.length; i++) {
    var b = sb.buckets[i]
    if (!b || b.role !== 'worker') continue
    if (b.size !== 'small' && b.size !== 'medium') continue
    var a = mm[b.model] || (mm[b.model] = { model: b.model, runs: 0, resolved: 0, firstPass: 0, effSum: 0, effCount: 0 })
    a.runs += numOr0(b.runs)
    a.resolved += numOr0(b.resolved)
    a.firstPass += numOr0(b.firstPass)
    a.effSum += numOr0(b.effSum)
    a.effCount += numOr0(b.effCount)
  }
  var cands = []
  for (var mk in mm) {
    if (!Object.prototype.hasOwnProperty.call(mm, mk)) continue
    var v = mm[mk]
    if (v.runs < MODEL_HINT_MIN_RUNS) continue   // ① 样本量
    if (!v.resolved) continue                     // ② 通过率不可知（无落定任务）不判
    var pass = v.firstPass / v.resolved
    if (pass < MODEL_HINT_MIN_PASS) continue      // ② 通过率 <90%（恰好 90% 合格）
    if (!v.effCount) continue                     // ③ 有效均值不可知（无 usage 留账）不判
    cands.push({ model: v.model, runs: v.runs, pass: pass, effAvg: v.effSum / v.effCount })
  }
  if (cands.length < 2) return null // 无对比对象（单模型独秀不构成「显著低于其他」）
  cands.sort(function (x, y) { return (x.effAvg - y.effAvg) || (x.model < y.model ? -1 : 1) }) // 有效均值升序（并列按模型名，确定性）
  var best = cands[0]
  // 对其他每个合格模型都严格低 >30%：最小差距 > 30% 才成立（恰好 30% 不亮）
  var minGap = Infinity
  for (var gi = 1; gi < cands.length; gi++) {
    var oAvg = cands[gi].effAvg
    var gap = oAvg > 0 ? (oAvg - best.effAvg) / oAvg : 0 // 对方均值为 0：无法定义「低 30%」，按 0 处理（必不亮）
    if (gap < minGap) minGap = gap
  }
  if (!(minGap > MODEL_HINT_EFF_GAP)) return null
  return {
    level: 'warn',
    text: '模型 ' + best.model + ' 在中小卡表现最优（通过率 ' + Math.round(best.pass * 100) + '% · 有效均值 ' + fmtTokShort(best.effAvg) +
      '，较其他合格模型低 ' + Math.round(minGap * 100) + '%），建议设为默认 workerModel',
  }
}

// ===== 质量异动告警（异常驱动审视②，proposal n-muxyyvgonpoo）：scoreboard.trends 数据驱动的环比告警 =====
// 三条同构规则（阈值常量置顶）：近 7 天 vs 再前 7 天，两侧样本各 ≥ QUALITY_MIN_SAMPLE 才判（防小样本误报）。
//   ① 一次通过率（firstPassByDay：firstPass/resolved）**跌** > QUALITY_CHANGE_PP 个百分点 → 建议抽查近期验收；
//   ② 超时率（timeoutByDay：timeout/runs）**涨** > QUALITY_CHANGE_PP 个百分点 → 建议排查派发/超时链路；
//   ③ 驳回率（rejectByDay：rejects / timeoutByDay 同日的 runs）**涨** > QUALITY_CHANGE_PP 个百分点 → 建议审查驳回原因。
// 数据全部来自 scoreboard.trends（卡2 已建，本卡只做判定 + hint，不重建数据）。
// 纯函数零 IO：日期只解析已有字符串做窗口切分；now 缺省 Date.now()（测试可注入钉死窗口，与卡2 零时钟纪律一致——
// 环比的「近 7 天」必须相对某个「今天」，这是本函数的唯一时钟依赖，故显式参数化）。
export var QUALITY_CHANGE_PP = 10   // 环比变化阈值（百分点）：恰好 10pp 不亮、严格 >10pp 才亮
export var QUALITY_MIN_SAMPLE = 5   // 两侧样本护栏：任一侧样本 <5 不判（防小样本噪声）
export var QUALITY_WINDOW_DAYS = 7  // 环比窗口：近 7 天 vs 再前 7 天

// 近 count 天的本地日 key（旧→新，最后一个是今天）：与 localDayKey 同一本地 getters 口径
function qualityRecentDays(nowMs, count) {
  var out = []
  var d = new Date(nowMs)
  for (var i = count - 1; i >= 0; i--) out.push(localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i)))
  return out
}
// 把 byDay 在指定日 key 集合上的指定数值字段累加；byDay 缺失/脏 → 全 0（绝不抛错）
function qualitySumCells(byDay, keys, fields) {
  var out = {}
  for (var f = 0; f < fields.length; f++) out[fields[f]] = 0
  if (!byDay || typeof byDay !== 'object') return out
  for (var i = 0; i < keys.length; i++) {
    var c = byDay[keys[i]]
    if (!c || typeof c !== 'object') continue
    for (var f2 = 0; f2 < fields.length; f2++) out[fields[f2]] += numOr0(c[fields[f2]])
  }
  return out
}
// 环比百分点差（a - b，四舍五入到 0.1pp）：恰好 10pp 不亮 / 10.1pp 亮——0.1pp 精度 + 严格 > 阈值，浮点安全
function qualityPpDelta(a, b) { return Math.round((a - b) * 1000) / 10 }

export function qualityChangeHints(sb, now) {
  var tr = sb && sb.trends && typeof sb.trends === 'object' ? sb.trends : null
  if (!tr) return []
  var hints = []
  var nowMs = (typeof now === 'number' && isFinite(now)) ? now : Date.now()
  // 近 14 天窗口切两半：近 7 天（含今天）vs 再前 7 天
  var days = qualityRecentDays(nowMs, QUALITY_WINDOW_DAYS * 2)
  var near = days.slice(-QUALITY_WINDOW_DAYS)
  var prior = days.slice(0, QUALITY_WINDOW_DAYS)
  // --- ① 一次通过率跌 ---
  var fpN = qualitySumCells(tr.firstPassByDay, near, ['resolved', 'firstPass'])
  var fpP = qualitySumCells(tr.firstPassByDay, prior, ['resolved', 'firstPass'])
  if (fpN.resolved >= QUALITY_MIN_SAMPLE && fpP.resolved >= QUALITY_MIN_SAMPLE) {
    var fpNR = fpN.firstPass / fpN.resolved, fpPR = fpP.firstPass / fpP.resolved
    if (qualityPpDelta(fpPR, fpNR) > QUALITY_CHANGE_PP) {
      hints.push({ level: 'warn', text: '质量异动：一次通过率本周 ' + Math.round(fpNR * 100) + '%（上周 ' + Math.round(fpPR * 100) + '%），建议抽查近期验收' })
    }
  }
  // --- ② 超时率涨（分母 = 当日落定 runs）---
  var toN = qualitySumCells(tr.timeoutByDay, near, ['runs', 'timeout'])
  var toP = qualitySumCells(tr.timeoutByDay, prior, ['runs', 'timeout'])
  if (toN.runs >= QUALITY_MIN_SAMPLE && toP.runs >= QUALITY_MIN_SAMPLE) {
    var toNR = toN.timeout / toN.runs, toPR = toP.timeout / toP.runs
    if (qualityPpDelta(toNR, toPR) > QUALITY_CHANGE_PP) {
      hints.push({ level: 'warn', text: '质量异动：超时率本周 ' + Math.round(toNR * 100) + '%（上周 ' + Math.round(toPR * 100) + '%），建议排查派发/超时链路' })
    }
  }
  // --- ③ 驳回率涨（分子 = rejectByDay 的 rejects，分母 = timeoutByDay 同日的 runs）---
  var rjN = qualitySumCells(tr.rejectByDay, near, ['rejects'])
  var rjP = qualitySumCells(tr.rejectByDay, prior, ['rejects'])
  if (toN.runs >= QUALITY_MIN_SAMPLE && toP.runs >= QUALITY_MIN_SAMPLE) {
    var rjNR = rjN.rejects / toN.runs, rjPR = rjP.rejects / toP.runs
    if (qualityPpDelta(rjNR, rjPR) > QUALITY_CHANGE_PP) {
      hints.push({ level: 'warn', text: '质量异动：驳回率本周 ' + Math.round(rjNR * 100) + '%（上周 ' + Math.round(rjPR * 100) + '%），建议审查近期驳回原因' })
    }
  }
  return hints
}
