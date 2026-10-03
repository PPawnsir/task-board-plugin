// dsh-agent-board — 架构自省 L1（lib/health.mjs）
// 纯函数、零状态、零 IO：从任务数组现算「架构健康提示」，不落盘、不通知、不依赖任何 ctx。
// 数据源只用任务持久化字段（createdAt/claimedAt/resolvedAt/touches/rejectCount）。
// 窗口化（近 50 张卡）而非累计：架构优化落地后老数据自动滑出窗口不再报警——
// 健康区同时是「拆分是否有效」的客观验收证据。
// 信号源不做裁判：只产提示文案，决策永远是人。
import { normTouch } from './core.mjs'

// ===== 阈值常量（全部置顶，可按实际使用手感调整；只影响之后的计算，不追溯老数据）=====
var WINDOW_SIZE = 50       // 统计窗口：按 createdAt 取最近 N 张卡（含归档）
var TOUCH_HOT_MIN = 8      // 信号 a：单路径 touches 声明次数阈值
var TOUCH_HOT_RATIO = 0.4  // 信号 a：声明次数占窗口内「有 touches 任务」的比例阈值
var SERIAL_MIN_TOUCH = 5   // 信号 b：有 touches 任务的最小样本数（不足则不判定，防小样本噪声）
var SERIAL_RATIO = 2       // 信号 b：有 touches 任务滞留中位数 > 无 touches 任务的 N 倍
var P90_LIMIT_MIN = 45     // 信号 c：resolved 任务时长 p90 阈值（分钟）
var REJECT_HOT_MIN = 2     // 信号 d：单路径累计驳回次数阈值
var MAX_HINTS = 3          // 返回提示上限（warn 信号优先排列）

// 毫秒 → 分钟（四舍五入取整，仅供文案展示）
function toMin(ms) { return Math.round(ms / 60000) }

// 中位数（输入任意序，内部复制排序；空数组返回 null）
function medianOf(nums) {
  if (!nums.length) return null
  var v = nums.slice().sort(function (a, b) { return a - b })
  var n = v.length
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2
}

// p 分位数（near-rank：升序后取 ceil(p*n)-1 位；空数组返回 null）
function percentileOf(nums, p) {
  if (!nums.length) return null
  var v = nums.slice().sort(function (a, b) { return a - b })
  var i = Math.ceil(p * v.length) - 1
  if (i < 0) i = 0
  return v[i]
}

// pending 滞留代理：createdAt →（claimedAt 优先，否则 resolvedAt）。无法计算返回 -1。
function waitMsOf(t) {
  var end = t.claimedAt || t.resolvedAt
  if (!end || !t.createdAt) return -1
  var ms = Date.parse(end) - Date.parse(t.createdAt)
  return (isNaN(ms) || ms < 0) ? -1 : ms
}

// 任务时长：resolvedAt - createdAt。无法计算返回 -1。
function durationMsOf(t) {
  if (!t.resolvedAt || !t.createdAt) return -1
  var ms = Date.parse(t.resolvedAt) - Date.parse(t.createdAt)
  return (isNaN(ms) || ms < 0) ? -1 : ms
}

// 任务 touches 归一化（与 core.mjs normTouch 同款口径）+ 单任务内去重；无 touches 返回 []
function normPathsOf(t) {
  var raw = Array.isArray(t.touches) ? t.touches : []
  var seen = {}, out = []
  for (var i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== 'string') continue
    var p = normTouch(raw[i])
    if (p && !seen[p]) { seen[p] = true; out.push(p) }
  }
  return out
}

// 取计数最高的路径；并列时取字典序较小者保证确定性。返回 [path, count]，空表返回 ['', 0]
function topPath(counts) {
  var best = '', bestN = 0
  for (var p in counts) {
    var n = counts[p]
    if (n > bestN || (n === bestN && n > 0 && p < best)) { best = p; bestN = n }
  }
  return [best, bestN]
}

// 主入口：tasks = 看板任务数组（含归档）。返回 [{level:'warn'|'info', text}]，最多 MAX_HINTS 条，无命中返回 []。
export function computeHealthHints(tasks) {
  var all = Array.isArray(tasks) ? tasks.slice() : []
  if (!all.length) return []
  // 窗口：按 createdAt 倒序取最近 WINDOW_SIZE 张（缺 createdAt 视为空串，排在最老一侧）
  all.sort(function (a, b) { return String((b && b.createdAt) || '').localeCompare(String((a && a.createdAt) || '')) })
  var win = all.slice(0, WINDOW_SIZE)

  // 单趟遍历收集各信号所需的分组数据
  var declCounts = {}   // 信号 a：路径 → 声明次数
  var rejCounts = {}    // 信号 d：路径 → 累计驳回次数
  var waitWith = []     // 信号 b：有 touches 任务的滞留毫秒
  var waitWithout = []  // 信号 b：无 touches 任务的滞留毫秒
  var withTouchN = 0    // 窗口内有 touches 的任务数（信号 a 占比分母）
  var durations = []    // 信号 c：resolved 任务时长毫秒
  for (var i = 0; i < win.length; i++) {
    var t = win[i] || {}
    var paths = normPathsOf(t)
    if (paths.length) {
      withTouchN++
      for (var j = 0; j < paths.length; j++) declCounts[paths[j]] = (declCounts[paths[j]] || 0) + 1
    }
    var rc = t.rejectCount || 0
    if (rc > 0) { for (var k = 0; k < paths.length; k++) rejCounts[paths[k]] = (rejCounts[paths[k]] || 0) + rc }
    var w = waitMsOf(t)
    if (w >= 0) { if (paths.length) waitWith.push(w); else waitWithout.push(w) }
    var dur = durationMsOf(t)
    if (dur >= 0) durations.push(dur)
  }

  var hints = []
  // --- 信号 a：touches 声明热度（某路径被高频声明 = 架构收敛点失控，该拆）---
  var hot = topPath(declCounts)
  if (hot[1] >= TOUCH_HOT_MIN && withTouchN > 0 && hot[1] / withTouchN >= TOUCH_HOT_RATIO) {
    hints.push({ level: 'warn', text: hot[0] + ' 在近 ' + win.length + ' 张卡中被 ' + hot[1] + ' 次声明 touches（占比 ' + Math.round(hot[1] / withTouchN * 100) + '%）——考虑拆分模块' })
  }
  // --- 信号 d：驳回热点（按 touches 路径聚合 rejectCount = 质量脆弱区）---
  var rej = topPath(rejCounts)
  if (rej[1] >= REJECT_HOT_MIN) {
    hints.push({ level: 'warn', text: rej[0] + ' 相关任务被驳回 ' + rej[1] + ' 次——质量脆弱区，建议审查该模块' })
  }
  // --- 信号 b：串行代价代理（有 touches 任务滞留中位数显著更长 = 并行度受锁限制）---
  if (waitWith.length >= SERIAL_MIN_TOUCH && waitWithout.length > 0) {
    var medW = medianOf(waitWith), medWo = medianOf(waitWithout)
    if (medW > medWo * SERIAL_RATIO) {
      hints.push({ level: 'info', text: '带 touches 任务平均等待明显更长（中位数 ' + toMin(medW) + 'min vs ' + toMin(medWo) + 'min），并行度受锁限制' })
    }
  }
  // --- 信号 c：时长 p90（resolved 任务时长尾部抬升 = 粒度/架构成本恶化）---
  var p90 = percentileOf(durations, 0.9)
  if (p90 !== null && p90 > P90_LIMIT_MIN * 60000) {
    hints.push({ level: 'info', text: '任务时长 p90 已达 ' + toMin(p90) + 'min——超长任务占比升高，考虑拆分粒度或检查架构热点' })
  }
  return hints.slice(0, MAX_HINTS)
}
