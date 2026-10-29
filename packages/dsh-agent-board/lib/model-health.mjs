// dsh-agent-board — 模型健康域（lib/model-health.mjs）
// 拆分自 lib/dispatch.mjs（拆分第 2 刀·叶子模块，task-mvt8c1yx-2）：模型冷却嗅探纯函数域
// （限流 task-mvneq4kk + 连接/网关故障短窗 task-mvnx8hnm）+ 统一健康表（task-mvoulhm7，按会话分桶）
// + 冷却期判定（cooldownLive）/ 冷却嗅探登记（sniffModelCooldown）。
// 拆分第 3 刀（task-mvt8c1yx-3）续入：模型目录（modelDirectory/outOfDir/traceStaleModel，与 rpc.mjs
// enumModels 同源的目录获取+失效留痕）/ 备用链健康判定（healthyModel/pickHealthyFallback）/
// 熔断连击（WORKER_MODEL_CIRCUIT_AFTER/isModelKillFailure/feedModelFailure/resetModelFailure，
// task-mvowb2hc 语义注释全量随迁）。
// 叶子模块：唯一 import 兄弟域=挂死域（依赖向单行道 health→hung，禁反向——isModelKillFailure 消费
// isHungKillFailure；hung.mjs 只 import core.mjs，无环）；会话状态/留卡以闭包回调注入
// （createModelHealth 工厂：state 共享同一引用——modelHealth/modelCooldown/badModels/modelFailStreak
// 语义逐字不变；disposed 读取器与 dispatch.mjs probeDisposed 同源，卸载闸语义逐字保留；
// ctx/pushSysNote 随第 3 刀注入——modelDirectory 的 llm 目录获取 / feedModelFailure 的系统通知）。
import { isHungKillFailure } from './hung.mjs'

// ===== 模型冷却嗅探：限流（task-mvneq4kk）+ 连接/网关故障短窗（task-mvnx8hnm）=====
// 纯函数：两类报错形态识别，返回 { until, parsed, kind }，均不命中返回 null。
// ① 限流形态（kind='rate-limit'，行为与 C5 落地逐字一致）：命中 /429|RATE_LIMIT|rate.?limit|限额|额度/i；
//    尝试解析「YYYY-MM-DD HH:mm:ss 重置」（中文，glm 原形事故实证形态）或「reset(s) at/on YYYY-MM-DD HH:mm:ss」
//    （英文）样式时间 → until 时间戳（按本地时区构造，与供应商报错文案口径一致）；解析不到时间 →
//    until = now + 30min（保守缺省）。
// ② 连接/网关形态（kind='connectivity'）：命中 CONNECTIVITY_RE → until = now + 10min 固定短窗
//    （连接故障多为瞬时，短窗自动恢复——比限流缺省 30min 短；固定不开放配置，要配置化等实证再开）。
// 判定顺序：先限流后连接（两类关键词并存的文本按限流处理，窗口更保守）。
// 英文裸词 timeout 刻意不在连接形态内（只认 ETIMEDOUT errno 形态）——供应商「provider timeout after 30s」
// 类软性报错与 withTimeout 的「label timeout Nms」硬超时文本都不进冷却（C5 既有断言锁定该口径）。
var RATE_LIMIT_RE = /429|RATE_LIMIT|rate.?limit|限额|额度/i
var RATE_RESET_ZH_RE = /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})\s*重置/
var RATE_RESET_EN_RE = /resets?(?:\s+at|\s+on)?\s+(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})/i
var RATE_LIMIT_DEFAULT_MS = 30 * 60000
// 连接/网关故障形态识别谓词（export：dispatch.mjs 探测空响应分治 classifyEmptyResponse 同源消费——
// 判定顺序与 parseModelCooldown 先限流后连接的保守口径一致，单源导出防两处口径漂移）
export var CONNECTIVITY_RE = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network|socket|502|503|504|网关|连接|超时/i
var CONNECTIVITY_COOLDOWN_MS = 10 * 60000
export function parseModelCooldown(errText) {
  var s = String(errText || '')
  if (RATE_LIMIT_RE.test(s)) {
    var m = s.match(RATE_RESET_ZH_RE) || s.match(RATE_RESET_EN_RE)
    if (m) {
      var ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
      if (isFinite(ts)) return { until: ts, parsed: true, kind: 'rate-limit' }
    }
    return { until: Date.now() + RATE_LIMIT_DEFAULT_MS, parsed: false, kind: 'rate-limit' }
  }
  if (CONNECTIVITY_RE.test(s)) return { until: Date.now() + CONNECTIVITY_COOLDOWN_MS, parsed: false, kind: 'connectivity' }
  return null
}
// 冷却消息「至 HH:mm」格式化（本地时区）；dispatch.mjs 降档/切备用留痕同源消费（单源导出，防两处格式漂移）
export function hhmmOf(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) }
// 模型熔断/冷却表键（sid|model 复合串）：badModels 熔断名单与 syncModelHealth 熔断判定共用同一键式
// （单源导出——dispatch.mjs 熔断喂给/取模链/验收熔断同源消费，防两处键式漂移）
export function modelKey(sid, model) { return sid + '|' + model }

// ===== 健康表 + 冷却登记（工厂：state 共享同一引用）=====
export function createModelHealth(opts) {
    var state = opts.state, mutateLocked = opts.mutateLocked
    var badModels = state.badModels
    // 冷却表（task-mvneq4kk 限流 / task-mvnx8hnm 连接故障）：与 badModels 同生命周期（纯内存不持久化，
    // 重启即清——额度重置窗口本就短，连接短窗 10min 更短）。语义分治：badModels=连续失败熔断（布尔），
    // modelCooldown=窗口冷却（until 时间戳），两张表各管各的（连接类冷却只进本表，不动熔断判定）。
    // key = 模型 id（provider/model 复合串）：限流是账户级额度窗口、连接故障是网关面，都不按会话分键。
    // 缺字段就地补（测试桩/老宿主兼容，与 poolHealthFor 同例）。
    var modelCooldown = state.modelCooldown || (state.modelCooldown = {})
    // 统一健康表（task-mvoulhm7）：内部按会话分桶，避免 sid|model 熔断信号串板；get-tasks 公开为 {modelId:entry}。
    // observed=最近主动探测/run 的基础状态，冷却与熔断是覆盖态；调度仍只认这两种覆盖态，未知不等于不可用。
    var modelHealth = state.modelHealth || (state.modelHealth = {})
    // 卸载闸读取器（可选注入，缺省恒 false）：与 dispatch.mjs probeDisposed 同源（拆分第 2 刀）——
    // 插件卸载后 observeModel 不再写健康表（既有语义逐字不变）；薄桩/老调用不注入 → 行为不变。
    var disposed = (typeof opts.disposed === 'function') ? opts.disposed : function () { return false }
    // llm 服务句柄（可选注入，拆分第 3 刀）：modelDirectory 的目录获取数据源——dispatch.mjs
    // createDispatch 传入 ctx；薄桩/老调用不注入 → modelDirectory 保守返回 null（目录闸整体跳过，不误伤）。
    var ctx = opts.ctx
    // 系统通知（可选注入，拆分第 3 刀）：feedModelFailure 三连拉黑臂的 pushSysNote——dispatch.mjs 传入；
    // 与验收熔断通知同口径（不带 taskId，不受任务回执冲刷丢弃）。
    var pushSysNote = opts.pushSysNote
    // 熔断连击表（task-mvowb2hc 洞①）：sid|model → 连续「模型面失败」次数（纯内存不持久化，与
    // badModels/modelCooldown 同生命周期，重启即清）。语义：只有「会话被宿主/激活机制在开工前杀掉」
    // 这类模型面失败才计数（worker 自己的失误——空输出/超时等——不算），连续 N 次才拉黑进 badModels
    // （熔断语义不变：拉黑后链跳过 + 健康表 circuit）；任一可归因 run 正常完成即归零（settleRunRecord）。
    var modelFailStreak = state.modelFailStreak || (state.modelFailStreak = {})
    function healthBucket(sid) { return modelHealth[sid] || (modelHealth[sid] = {}) }
    function healthEntry(sid, model) {
      var b = healthBucket(sid)
      return b[model] || (b[model] = { state: 'unknown', observed: 'unknown', lastProbe: null, lastSeen: null, note: '尚无健康信号', observedNote: '尚无健康信号', recentRuns: [] })
    }
    function syncModelHealth(sid, model, cooldownOverride) {
      var e = healthEntry(sid, model), until = typeof cooldownOverride === 'number' ? cooldownOverride : cooldownLive(model)
      // task-mvrqdw4k：degraded 派生（状态优先级 circuit > cooldown > degraded > healthy/unknown——覆盖臂在下方，顺序即优先级）
      e.state = e.observed === 'healthy' ? 'healthy' : (e.observed === 'degraded' ? 'degraded' : 'unknown')
      e.note = e.observedNote || '尚无健康信号'
      delete e.until
      if (until) { e.state = 'cooldown'; e.until = until; e.note = e.cooldownNote || '模型冷却中' }
      if (badModels[modelKey(sid, model)]) { e.state = 'circuit'; e.note = e.circuitNote || '连续失败，模型熔断中' }
      return e
    }
    function observeModel(sid, model, ok, opts) {
      if (!model || disposed()) return null
      opts = opts || {}
      var e = healthEntry(sid, model), at = new Date().toISOString()
      var latency = Number(opts.latencyMs)
      e.lastSeen = at
      // ③ 探测超时/预算耗尽只更新 note（判定保留，task-mvsv8zym）：observed/state/latencyMs/recentRuns
      // 全部保持原值——避免已 healthy/degraded 条目被超时倒退成 unknown（超时非模型健康信号）。
      if (opts.preserveObserved) {
        if (opts.probe) {
          e.lastProbe = at
          e.observedNote = '主动探测超时（慢模型，判定保留）' + (opts.note ? '：' + opts.note : '')
          e.note = e.observedNote
        }
        return syncModelHealth(sid, model)
      }
      // task-mvrqdw4k：探测空响应分治——ok=true 🟢健康；opts.degraded 🟡降级（链路存活，供应商怪癖，
      // 只由探测降级存活臂置入）；其余照旧 unknown（失败臂）。被动 run 观察臂语义逐字不变。
      e.observed = ok ? 'healthy' : (opts.degraded ? 'degraded' : 'unknown')
      if (isFinite(latency) && latency >= 0) e.latencyMs = Math.round(latency)
      if (opts.probe) {
        e.lastProbe = at
        e.observedNote = ok ? '主动探测通过'
          : (opts.degraded
              ? '主动探测：链路存活但极简请求零内容（EMPTY_RESPONSE 供应商怪癖）' + (opts.note ? '：' + opts.note : '')
              : '主动探测失败' + (opts.note ? '：' + opts.note : ''))
      } else {
        e.recentRuns.push({ ok: !!ok, at: at, latencyMs: isFinite(latency) && latency >= 0 ? Math.round(latency) : null })
        if (e.recentRuns.length > 5) e.recentRuns = e.recentRuns.slice(-5)
        var passed = e.recentRuns.filter(function (r) { return r.ok }).length
        e.observedNote = (ok ? '最近 run 成功' : '最近 run 失败') + '（近 ' + e.recentRuns.length + ' 次 ' + passed + ' 次成功）'
      }
      e.note = e.observedNote
      return syncModelHealth(sid, model)
    }
    function markModelCircuit(sid, model, note) {
      var e = healthEntry(sid, model)
      e.circuitNote = note || '连续验收失败，模型熔断中'
      return syncModelHealth(sid, model)
    }
    // 冷却期判定：返回冷却截止 ts（0=不在冷却）；过期项惰性清除（读路径顺手删，无需 sweeper）
    function cooldownLive(model) {
      var until = modelCooldown[model]
      if (!until) return 0
      if (Date.now() >= until) { delete modelCooldown[model]; return 0 }
      return until
    }
    // 冷却嗅探登记：两条登记路径共用（①spawn extras 回退臂 e/e2 文本 ②settleWorker 失败臂 errText——
    // activation.result 拆除兜底臂带上来的诊断文本也走②）。max 收敛：多次报错只延不缩
    // （带重置时间的精确值与 30min/10min 缺省并存时取更晚者）；截止未后延则零改动零留痕（防重复报错刷屏）。
    // 留痕分态（task-mvnx8hnm）：限流=「额度冷却至 HH:mm」，连接/网关=「连接故障短冷却 10 分钟」——
    // 卡 messages 各记一条 kind='cooldown'，排查时一眼分清「额度没了」与「连不上」。
    // 写卡失败静默吞掉（留痕是附属动作，绝不阻断 spawn 回退/失败结算主流程）。返回冷却截止 ts，未命中 null。
    async function sniffModelCooldown(sid, taskId, model, errText) {
      if (!model) return null
      var hit = parseModelCooldown(errText)
      if (!hit) return null
      if (hit.until <= (modelCooldown[model] || 0)) { syncModelHealth(sid, model, modelCooldown[model]); return modelCooldown[model] }
      modelCooldown[model] = hit.until
      var until = modelCooldown[model]
      var he = healthEntry(sid, model)
      he.cooldownNote = hit.kind === 'connectivity' ? ('连接/网关故障，冷却至 ' + hhmmOf(until)) : ('额度限流，冷却至 ' + hhmmOf(until))
      syncModelHealth(sid, model, until)
      if (hit.kind === 'connectivity') console.error('[task-board] 模型 ' + model + ' 连接/网关故障，短冷却 10 分钟至 ' + new Date(until).toISOString())
      else console.error('[task-board] 模型 ' + model + ' 命中 RATE_LIMIT 限流，冷却至 ' + new Date(until).toISOString() + '（' + (hit.parsed ? '重置时间解析' : '缺省 30min') + '）')
      try {
        await mutateLocked(sid, function (d) {
          var t = d.tasks.find(function (x) { return x.id === taskId })
          if (!t) return null
          if (!Array.isArray(t.messages)) t.messages = []
          t.messages.push({ kind: 'cooldown', text: hit.kind === 'connectivity' ? ('🔌 模型 ' + model + ' 连接故障短冷却 10 分钟（至 ' + hhmmOf(until) + '）') : ('⏳ 模型 ' + model + ' 额度冷却至 ' + hhmmOf(until)), at: new Date().toISOString(), by: 'system' })
          return { ok: true }
        }, true) // skipKick：只是留痕，不踢 poolCycle
      } catch (_) {}
      return until
    }

    // ===== 模型目录获取（task-mvd3li6 目录失效闸数据源）：与 rpc.mjs enumModels 同源（llm.listProviders+listModels）=====
    // 返回 { "provider/model": true } 目录映射；null = 目录不可得 → 目录闸整体跳过（保守语义③，不误伤）：
    //   ① llm 服务缺失/缺 listProviders/listModels 方法（老宿主）；② listProviders 未返回数组或抛错；
    //   ③ 任一 provider 的 listModels 抛错或未返回数组（部分枚举=目录不完整，宁可跳过闸也不误杀在册模型）；
    //   ④ 枚举结果为空（退化形态：网关零模型时全候选都会被误判目录外，同样保守跳过）。
    // 每次 spawnOneShot/续跑闸现取一次（刻意不缓存：模型从宿主配置删除/改名要当轮生效，缓存会放走已删模型）。
    async function modelDirectory() {
      var llm = ctx && ctx.get && ctx.get('llm')
      if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return null
      var providers = null
      try { providers = llm.listProviders() } catch (_) { return null }
      if (!Array.isArray(providers)) return null
      var out = {}
      for (var i = 0; i < providers.length; i++) {
        try {
          var models = await llm.listModels(providers[i].id)
          if (!Array.isArray(models)) return null
          for (var j = 0; j < models.length; j++) { if (models[j] && models[j].id) out[providers[i].id + '/' + models[j].id] = true }
        } catch (_) { return null } // 任一 provider 枚举失败 → 目录不完整 → 保守跳过（不误伤）
      }
      if (!Object.keys(out).length) return null
      return out
    }
    // 存在闸谓词（同步；dir=modelDirectory() 结果）：目录可得且模型不在目录 → true（配置已失效）。
    // dir 为 null（目录不可得）恒 false——闸整体跳过，只留连败软闸生效。
    function outOfDir(modelId, dir) { return !!(dir && modelId && !dir[modelId]) }
    // ===== 目录失效留痕（task-mvd3li6）：取模候选不在当前模型目录 → 卡 messages 记「配置已失效」，per 模型去重 =====
    // 同模型重复取模只记一条（防每轮重派刷屏，与冷却嗅探「未后延零留痕」同纪律）；
    // 顺带在健康表 observedNote 落同款分态（GUI 健康点可读出「为什么被跳过」）。写卡失败静默吞掉
    // （留痕是附属动作，绝不阻断取模主流程）。
    async function traceStaleModel(sid, taskId, model) {
      if (!model) return
      console.error('[task-board] 配置已失效：' + model + '（已从模型目录移除），取模跳过该候选')
      try {
        var he = healthEntry(sid, model)
        if (he.observedNote !== '配置已失效（已从模型目录移除）') { he.observedNote = '配置已失效（已从模型目录移除）'; he.note = he.observedNote }
      } catch (_) {}
      try {
        await mutateLocked(sid, function (d) {
          var t2 = d.tasks.find(function (x) { return x.id === taskId })
          if (!t2) return null
          if (!Array.isArray(t2.messages)) t2.messages = []
          var text = '⚠️ 配置已失效：' + model + '（已从模型目录移除），本 run 取模跳过'
          for (var i = t2.messages.length - 1; i >= 0; i--) {
            if (t2.messages[i] && t2.messages[i].kind === 'stale-model' && t2.messages[i].text === text) return null // 已记过，零改动零留痕
          }
          t2.messages.push({ kind: 'stale-model', text: text, at: new Date().toISOString(), by: 'system' })
          return { ok: true }
        }, true) // skipKick：只是留痕，不踢 poolCycle
      } catch (_) {}
    }
    // ===== 备用模型链健康判定（task-mvnqxlpn）：不在 badModels 熔断名单且不在 modelCooldown 冷却期 =====
    // 两张表各管各的（熔断=连续失败布尔，冷却=额度窗口时间戳），任一命中即不健康。
    // 消费点=spawnOneShot 取模链：候选被判不健康时先扫板级 fallbackModels 找首个健康者（链本身逐项过本检查）。
    // ===== 健康面拓宽（task-mvd3li6）：在既有熔断/冷却双闸之上增读 modelHealth 聚合表 =====
    //   ① 近期连败软闸：聚合表 recentRuns（近 5 次 run 成败，settleRunRecord 每次结算喂给）≥2 且全败 →
    //      不健康（软熔断：不落 badModels 黑名单，仅取模/续跑跳过）。一次成功即复位——recentRuns 滚动
    //      窗口本就有归零语义（成功条目进窗「全败」即不成立），确认复用零新增簿记。原形：glm-5.2
    //      「78s 报错一次+挂死一次」病了还被优先调度/续跑——第二次派发即被本闸拦下改走健康取模链。
    //   ② 目录失效闸：dir 可得且模型不在目录（已从宿主配置删除/改名）→ 视为不健康跳过。
    // dir 为可选第三参：既有调用点（不带 dir）= 目录闸跳过，行为逐字不变（零回归）。
    function healthyModel(sid, modelId, dir) {
      if (!modelId) return false
      var h = syncModelHealth(sid, modelId)
      if (h.state === 'circuit') return false
      if (h.state === 'cooldown') return false
      // task-mvrqdw4k：degraded（🟡空响应降级存活）刻意不拦——探测管可调性，模型仍可被路由选用；
      // 行为质量另有 recentRuns 连败软闸兜底（下方），探测放宽不放跑真坏模型。
      if (outOfDir(modelId, dir)) return false
      var rr = h.recentRuns
      if (Array.isArray(rr) && rr.length >= 2) {
        var allBad = true
        for (var i = 0; i < rr.length; i++) { if (rr[i] && rr[i].ok) { allBad = false; break } }
        if (allBad) return false
      }
      return true
    }
    // 扫备用链找首个健康模型（保持链序=主窗口配置的能力水位优先级）；链尽/空链返回 ''。
    // task-mvd3li6 起 async + dir + taskId：链上目录外模型跳过并留痕（traceStaleModel，per 模型去重）；
    // 目录不可得（dir 缺省/null）零留痕，行为与旧签名逐字一致（既有调用点零回归）。
    async function pickHealthyFallback(sid, fbList, dir, taskId) {
      if (!Array.isArray(fbList)) return ''
      for (var fi = 0; fi < fbList.length; fi++) {
        if (outOfDir(fbList[fi], dir)) { await traceStaleModel(sid, taskId, fbList[fi]); continue }
        if (healthyModel(sid, fbList[fi], dir)) return fbList[fi]
      }
      return ''
    }
    // ===== 熔断连击喂给（task-mvowb2hc 洞①）：模型面失败判别 + 连击计数 + 三连拉黑 =====
    // 模型面失败 = 会话被宿主/激活机制在开工前杀掉，两条来源文本都在本文件内确定：
    //   ① activation.result 拆除兜底臂：「子会话被宿主拆除（stopReason: X，…）」（stopReason=completed
    //      的收尾性拆除不算——那是正常完成的副产物，不是模型失败）；
    //   ② activation 异常兜底臂：「子会话 activation 异常：…」（spawn 机制/provider 面失败，同属开工前）。
    // worker 自己的失误（空输出/超时中断/文本降级失败）不算——好模型不该为 worker 的错误背锅。
    var WORKER_MODEL_CIRCUIT_AFTER = 3 // 连续 N 次模型面失败才拉黑（与 worker 三连败阻塞同一三击口径）
    // isHungKillFailure 与挂死常量段已拆至 lib/hung.mjs（拆分第 1 刀 task-mvt8c1yx），顶部 import 同源使用
    // （依赖向单行道 health→hung，禁反向）。
    function isModelKillFailure(errText) {
      var s = String(errText || '')
      if (isHungKillFailure(s)) return true
      if (s.indexOf('子会话被宿主拆除（stopReason: ') === 0) return s.indexOf('子会话被宿主拆除（stopReason: completed') !== 0
      return s.indexOf('子会话 activation 异常：') === 0
    }
    // 连击 +1；达 N 且尚未拉黑 → badModels 落黑名单（取模链/降档候选的既有熔断判定照常消费，零新分支）
    // + 健康表 circuit + 系统通知（不带 taskId：与验收熔断通知同口径，不受任务回执冲刷丢弃）。
    // why 可选（task-mvqcoz9l）：挂死触发的熔断文案分态（挂死≠秒拆），缺省=既有秒拆文案（既有调用点零回归）。
    // 返回是否本次调用触发拉黑（测试/留痕用）。
    function feedModelFailure(sid, model, why) {
      if (!model) return false
      var k = modelKey(sid, model)
      var n = (modelFailStreak[k] || 0) + 1
      modelFailStreak[k] = n
      if (n < WORKER_MODEL_CIRCUIT_AFTER) return false
      if (!badModels[k]) {
        badModels[k] = true
        markModelCircuit(sid, model, why || ('连续 ' + n + ' 次 spawn/续跑即被宿主拆除（模型失败），已熔断'))
        pushSysNote(sid, '模型 ' + model + ' ' + (why || ('连续 ' + n + ' 次 spawn/续跑即被宿主秒拆（模型失败），已熔断')) + '——后续取模链跳过该模型')
      }
      return true
    }
    // 连击归零：任一可归因 run 正常完成即证明模型链路恢复（settleRunRecord completed 路径调用）
    function resetModelFailure(sid, model) { if (model) delete modelFailStreak[modelKey(sid, model)] }
    return { healthBucket: healthBucket, healthEntry: healthEntry, syncModelHealth: syncModelHealth, observeModel: observeModel, markModelCircuit: markModelCircuit, cooldownLive: cooldownLive, sniffModelCooldown: sniffModelCooldown, modelDirectory: modelDirectory, outOfDir: outOfDir, traceStaleModel: traceStaleModel, healthyModel: healthyModel, pickHealthyFallback: pickHealthyFallback, isModelKillFailure: isModelKillFailure, feedModelFailure: feedModelFailure, resetModelFailure: resetModelFailure }
}
