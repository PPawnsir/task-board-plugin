// dsh-agent-board — 架构自省 L1（lib/health.mjs）
// 纯函数、零状态、零 IO：从任务数组现算「架构健康提示」，不落盘、不通知、不依赖任何 ctx。
// 数据源只用任务持久化字段（createdAt/claimedAt/resolvedAt/touches/rejectCount）。
// 窗口化（近 50 张卡）而非累计：架构优化落地后老数据自动滑出窗口不再报警——
// 健康区同时是「拆分是否有效」的客观验收证据。
// 信号源不做裁判：只产提示文案，决策永远是人。
import { normTouch, pickDispatch } from './core.mjs'

// ===== 阈值常量（全部置顶，可按实际使用手感调整；只影响之后的计算，不追溯老数据）=====
var WINDOW_SIZE = 50       // 统计窗口：按 createdAt 取最近 N 张卡（含归档）
var TOUCH_HOT_MIN = 8      // 信号 a：单路径 touches 声明次数阈值
var TOUCH_HOT_RATIO = 0.4  // 信号 a：声明次数占窗口内「有 touches 任务」的比例阈值
var SERIAL_MIN_TOUCH = 5   // 信号 b：有 touches 任务的最小样本数（不足则不判定，防小样本噪声）
var SERIAL_RATIO = 2       // 信号 b：有 touches 任务滞留中位数 > 无 touches 任务的 N 倍
var SERIAL_MIN_WAIT_MIN = 5 // 信号 b：**绝对**阈值——有 touches 侧滞留中位数不足 5min 一律不判定
                           // （task-muupnnq5 实证：线上曾挂「0min vs 0min」告警——0.4min > 0.1min×2 满足
                           //  相对倍数但两者都不到半分钟，亚分钟差异毫无架构意义，是纯噪声）
var P90_LIMIT_MIN = 45     // 信号 c：resolved 任务执行时长（claimedAt→resolvedAt）p90 阈值（分钟）
var REJECT_HOT_MIN = 2     // 信号 d：单路径累计驳回次数阈值
var MAX_HINTS = 3          // 返回提示上限（warn 信号优先排列）

// 信号 a 分母防灌水（task-muupnnq5）：这些路径被流程性挂在几乎每张开发卡上，不代表架构收敛点。
// 「组装产物 / 守门员路径」黑名单——过滤只作用于**本健康度模块内的路径聚合**（信号 a 热度分母、信号 d 归因），
// 不动 touches 本身语义：锁冲突、并行度判定、派发排队一概不受影响（core.mjs 的 matchOne 不读本表）。
// 副作用（刻意接受）：挂在这些路径上的驳回也不再触发信号 d——对「产物/守门员」报警反而会掩盖真脆弱区。
// 加名单的唯一理由必须是「流程性挂载」，不是「看着不重要」。
var TOUCH_NOISE_PATHS = {
  'lib/client.js': true, // 派生产物：由 lib/client/*.js 组装，改源码的卡几乎都会挂它（改它反而不对）
  'test': true,          // 守门员目录：单测随每张开发卡走
  'README.md': true,     // 双份 README 的根仓副本：随下次发版统一核对，不指代模块收敛点
}

// 是否为「机械随卡」噪声路径（normTouch 已归一：\ →/、去 ./、去尾 /）
function isNoiseTouchPath(p) {
  if (TOUCH_NOISE_PATHS[p]) return true
  return p.indexOf('test/') === 0 // test/ 整棵子树（含 test/x.test.mjs）
}

// 毫秒 → 分钟（四舍五入取整，仅供文案展示）；不足 1 分钟显示 <1min——
// 否则 0.4min 与 0.1min 都渲染成「0min」，告警看起来像幽灵（task-muupnnq5 线上实证）
function toMin(ms) { var m = Math.round(ms / 60000); return m < 1 ? '<1min' : m + 'min' }

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

// 滞留代理：createdAt →（claimedAt 优先，否则 resolvedAt）。
// task-muupnnq5 口径补充：仍在排队（无 claimedAt 也无 resolvedAt）的 pending 卡用 **now - createdAt** 计入——
// 「还在排队等锁」同样是等待，旧口径直接返回 -1 把它们整批丢掉（右删失），会系统性低估带 touches 任务的滞留。
// 副作用（刻意接受）：窗口里长期无人认领的僵尸 pending 卡滞留随时间单调增长，会持续计入有/无 touches 分组；
// 这是「锁 + 派发双重饥饿」的真实信号，不是噪声。无法计算返回 -1。
function waitMsOf(t, now) {
  var end = t.claimedAt || t.resolvedAt
  if (!end) {
    if (!t.createdAt) return -1
    var pm = now - Date.parse(t.createdAt)
    return (isNaN(pm) || pm < 0) ? -1 : pm
  }
  if (!t.createdAt) return -1
  var ms = Date.parse(end) - Date.parse(t.createdAt)
  return (isNaN(ms) || ms < 0) ? -1 : ms
}

// 执行时长：claimedAt → resolvedAt（纯干活耗时，不含排队；task-mutdnitw 口径修正）。
// 无 claimedAt（手工/direct 卡没有领取动作）或无法计算返回 -1，不参与聚合。
function durationMsOf(t) {
  if (!t.resolvedAt || !t.claimedAt) return -1
  var ms = Date.parse(t.resolvedAt) - Date.parse(t.claimedAt)
  return (isNaN(ms) || ms < 0) ? -1 : ms
}

// 任务 touches 归一化（与 core.mjs normTouch 同款口径）+ 单任务内去重 + 机械随卡路径过滤；无 touches 返回 []
function normPathsOf(t) {
  var raw = Array.isArray(t.touches) ? t.touches : []
  var seen = {}, out = []
  for (var i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== 'string') continue
    var p = normTouch(raw[i])
    if (p && !seen[p] && !isNoiseTouchPath(p)) { seen[p] = true; out.push(p) }
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
  var durations = []    // 信号 c：resolved 任务执行时长毫秒（claimedAt→resolvedAt）
  var now = Date.now()  // 信号 b：排队中 pending 卡的右删失代理要用「现在」（一次取定，长循环内不漂移）
  for (var i = 0; i < win.length; i++) {
    var t = win[i] || {}
    var paths = normPathsOf(t)
    if (paths.length) {
      withTouchN++
      for (var j = 0; j < paths.length; j++) declCounts[paths[j]] = (declCounts[paths[j]] || 0) + 1
    }
    var rc = t.rejectCount || 0
    if (rc > 0) { for (var k = 0; k < paths.length; k++) rejCounts[paths[k]] = (rejCounts[paths[k]] || 0) + rc }
    var w = waitMsOf(t, now)
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
  // 双重闸门：相对倍数（>2×）之外还要过**绝对**阈值（≥5min），治「0min vs 0min」这类亚分钟噪声告警。
  if (waitWith.length >= SERIAL_MIN_TOUCH && waitWithout.length > 0) {
    var medW = medianOf(waitWith), medWo = medianOf(waitWithout)
    if (medW >= SERIAL_MIN_WAIT_MIN * 60000 && medW > medWo * SERIAL_RATIO) {
      hints.push({ level: 'info', text: '带 touches 任务平均等待明显更长（中位数 ' + toMin(medW) + ' vs ' + toMin(medWo) + '），并行度受锁限制' })
    }
  }
  // --- 信号 c：执行时长 p90（resolved 任务执行时长尾部抬升 = 粒度/架构成本恶化）---
  var p90 = percentileOf(durations, 0.9)
  if (p90 !== null && p90 > P90_LIMIT_MIN * 60000) {
    hints.push({ level: 'info', text: '任务执行时长 p90 已达 ' + toMin(p90) + '——超长任务占比升高，考虑拆分粒度或检查架构热点' })
  }
  return hints.slice(0, MAX_HINTS)
}

// ===== 运行时健康自检（task-muxhrkbg，proposal n-muwlpbr3wkhc）=====
// 与上面的静态架构信号（L1）正交：这里看「运行时心跳」——派发循环是否在转、结算通道是否活着、
// 幽灵回收是否发生过。事故背景：2026-10-06 continuable 上线事故——settle 链异常导致 poolCycle
// 冻结 ~45 分钟无人知（发现靠 e2e 翻车 + 用户肉眼）；L1 只有静态信号（孤儿/僵尸卡），没有运行时监护。
// 数据源 = dispatch.mjs 写入的内存心跳 state.poolHealth[sid]（{ bornAt, poolLastOkAt, settleLastOkAt,
// reapNote }），本函数仍是纯函数：不读盘、不删数据——reapNote 的一次性消费由调用方按返回的
// consumeReapNote 旗执行（rpc get-tasks 摘除），测试因此可以纯断言返回值。
// 客户端零改动：hint 通道是纯文本数组直渲（level 仅 warn/info 两档配色），①的「红条」用 warn 级 +
// 文案 🔴 前缀表达（真要独立红色档需 client 加 level——本卡范围外，留给主窗口裁决）。
var POOL_STALE_MS = 5 * 60000    // ① 派发循环心跳：上次成功轮距今超 5min（且有活可派、有空位）→ 冻结疑似
var SETTLE_STALE_MS = 30 * 60000 // ② 结算通道静默：有在跑卡但超 30min 无任何成功结算 → 黄级提示
var REAP_NOTE_TTL_MS = 90000     // ③ 幽灵回收一次性记录的保鲜期（与 dispatchInfo 90s TTL 同口径）

// HH:mm 本地时分（hint 文案里的「上次成功 HH:mm」）
function hhmm(ms) { var d = new Date(ms); var h = d.getHours(), m = d.getMinutes(); return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m }

// board = get-tasks 的看板对象（只用 .tasks）；rt = state.poolHealth[sid] 心跳记录（undefined → 无法判定，全不亮）；
// opts = { capW: 当前 Worker 空位数（manual 模式 / 无活 root 时调用方传 0）, now: 毫秒（测试可 mock）,
//          alive: root 是否存活（false 时 ①② 都不判——死会话本就不该派发/结算，不是冻结) }。
// 「可派发」判定复用 core.pickDispatch 全闸门口径（依赖/frozen/歧义/manual/direct/pre-hook/touches 锁）：
// capW=1 探针有 pendings 产出 = 存在「无任何阻塞原因可派发」的卡；全被锁/被依赖挡 → 不误报。
// 返回 { hints: [{level, text}], consumeReapNote: 读到 reapNote（无论是否过期）即为 true }。
export function computeRuntimeHealthHints(board, rt, opts) {
  var out = { hints: [], consumeReapNote: false }
  if (!board || !Array.isArray(board.tasks)) return out
  if (!rt || typeof rt !== 'object') return out
  var now = (opts && typeof opts.now === 'number') ? opts.now : Date.now()
  var capW = (opts && typeof opts.capW === 'number') ? opts.capW : 0
  var alive = !opts || opts.alive !== false
  var bornAt = typeof rt.bornAt === 'number' ? rt.bornAt : now
  var tasks = board.tasks

  // --- ④ 看板数据文件腐坏/抢救可见化（task-mv0bl9vg ②③）---
  // store.recoverCorrupt 隔离/抢救时写 rt.corruptNote（{ at, salvage, kept, file }），这里现算透出
  // err 级 hint（客户端红色档，区别于 warn/info）。数据安全红线信号：sticky 不消费、不 TTL——
  // 只要板还处于腐坏态就持续亮（poolHealth 纯内存，host 重启自然清）。level='err' 是通道新档，
  // 客户端按非 warn/info 渲染红色；老客户端缺省降级为 info 色，信号仍可见。
  var cn = rt.corruptNote
  if (cn && typeof cn === 'object') {
    var cnText = cn.salvage
      ? '🔴 看板数据文件腐坏，已自动抢救保留 ' + (cn.kept || 0) + ' 张卡（丢弃撕裂残片），原始文件留档 ' + (cn.file || '') + '，可联系恢复'
      : '🔴 看板数据文件腐坏已隔离，历史在 ' + (cn.file || '') + '，可联系恢复'
    out.hints.push({ level: 'err', text: cnText })
  }

  if (alive) {
    // --- ① 派发循环心跳：有可派卡 + 池有空位 + 上次成功轮 >5min ---
    // poolLastOkAt 缺失时退到 bornAt（首次见到本板的时刻）：host 重启后心跳全断也能在 5min 宽限后亮条，
    // 而正常路径首轮 cycle（≤15s）会立刻刷新它，不会误报。
    var poolRef = typeof rt.poolLastOkAt === 'number' ? rt.poolLastOkAt : bornAt
    if (capW > 0 && now - poolRef > POOL_STALE_MS) {
      var probe = pickDispatch({ tasks: tasks }, 1, 0, null)
      if (probe.pendings.length > 0) {
        var staleMin = Math.floor((now - poolRef) / 60000)
        out.hints.push({ level: 'warn', text: '🔴 派发循环疑似冻结（上次成功 ' + hhmm(poolRef) + '，已 ' + staleMin + ' 分钟无派发）——有可派发任务且池有空位，请查看 host 控制台 [task-board] 日志或重载看板插件' })
      }
    }
    // --- ② settle 通道存活：有 in-progress 卡 + >30min 无任何成功结算（黄级）---
    // settleLastOkAt 同样缺省退 bornAt（重启后 30min 宽限，不拿「无记录」当「已静默」）。
    var hasInProgress = tasks.some(function (t) { return t && t.status === 'in-progress' })
    if (hasInProgress) {
      var settleRef = typeof rt.settleLastOkAt === 'number' ? rt.settleLastOkAt : bornAt
      if (now - settleRef > SETTLE_STALE_MS) {
        out.hints.push({ level: 'warn', text: '结算通道长时间无活动（上次成功结算 ' + hhmm(settleRef) + '，已 ' + Math.floor((now - settleRef) / 60000) + ' 分钟）——有任务在执行中但超过 30 分钟无任何 run 结算，settle 链路可能异常' })
      }
    }
  }

  // --- ③ 幽灵回收可视化：本轮回收 >0 留一条一次性 info（读到即消费；过期未读静默丢弃不亮条）---
  // 展示序放在最后：它只是历史事件留痕，①② 是进行中的事故。
  var rn = rt.reapNote
  if (rn && typeof rn.n === 'number' && rn.n > 0 && typeof rn.at === 'number') {
    out.consumeReapNote = true
    if (now - rn.at <= REAP_NOTE_TTL_MS) {
      out.hints.push({ level: 'info', text: '本轮回收 ' + rn.n + ' 个幽灵活跃表项（' + hhmm(rn.at) + '）——失效表项已自动摘除，若反复出现请排查 settle 链路（host 日志 [task-board]）' })
    }
  }
  return out
}
