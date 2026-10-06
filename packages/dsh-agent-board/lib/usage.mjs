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
