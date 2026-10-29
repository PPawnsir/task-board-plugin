// dsh-agent-board — 模型健康域（lib/model-health.mjs）
// 拆分自 lib/dispatch.mjs（拆分第 2 刀·叶子模块，task-mvt8c1yx-2）：模型冷却嗅探纯函数域
// （限流 task-mvneq4kk + 连接/网关故障短窗 task-mvnx8hnm）+ 统一健康表（task-mvoulhm7，按会话分桶）
// + 冷却期判定（cooldownLive）/ 冷却嗅探登记（sniffModelCooldown）。
// 拆分第 3 刀（task-mvt8c1yx-3）续入：模型目录（modelDirectory/outOfDir/traceStaleModel，与 rpc.mjs
// enumModels 同源的目录获取+失效留痕）/ 备用链健康判定（healthyModel/pickHealthyFallback）/
// 熔断连击（WORKER_MODEL_CIRCUIT_AFTER/isModelKillFailure/feedModelFailure/resetModelFailure，
// task-mvowb2hc 语义注释全量随迁）。
// 拆分第 4 刀（task-mvt8c1yx-4）续入：主动探测域全量随迁（PROBE_MAX_TOKENS/PROBE_MAX_TOKENS_RETRY/
// PROBE_ATTEMPT_TIMEOUT_MS/QUOTA_SIGNAL_RE/CREDENTIAL_SIGNAL_RE 常量与 task-mvrfp1rj/task-mvrqdw4k/
// task-mvsv8zym 校准注释、isEmptyResponse/classifyEmptyResponse 分治纯函数、probeOnce/probeModel/
// probeConfiguredModels/maybeProbeModels 探测编排、探测态 probeInFlight/probeAbort/probeNextAt/
// probeDisposed 与统一卸载入口 disposeProbe——插件卸载 effect 注册仍由 dispatch.mjs 执行，回调只调
// 本工厂暴露的 disposeProbe()）。
// import 面：兄弟域唯一=挂死域（依赖向单行道 health→hung，禁反向——isModelKillFailure 消费
// isHungKillFailure；hung.mjs 只 import core.mjs，无环）；第 4 刀起另直接 import core.mjs 取
// cfg/configuredModelIds（探测调度闸与配置集合数据源——core.mjs 不 import 本域，无环）；会话状态/
// 留卡以闭包回调注入
// （createModelHealth 工厂：state 共享同一引用——modelHealth/modelCooldown/badModels/modelFailStreak
// 语义逐字不变；探测态随第 4 刀入厂——probeDisposed 成为本域唯一卸载闸读取源（原 opts.disposed 注入
// 同步口径随之退役），dispose 后 observeModel/probeModel 不再写表，既有卸载闸语义逐字不变；
// ctx/pushSysNote 随第 3 刀注入——modelDirectory 的 llm 目录获取 / feedModelFailure 的系统通知 /
// 探测域的 llm.stream 直调与 timer）。
import { isHungKillFailure } from './hung.mjs'
import * as core from './core.mjs'

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

// ===== 主动模型嗅探：llm.stream 极短直调（无子代理/系统提示/工具，首探 maxTokens=1）=====
// finish=stop/max-tokens 等均证明模型链路可用；error/aborted/无 finish 才算失败。失败文本复用既有冷却登记，
// 但不改 badModels 熔断判定。同模型全局只在飞一次，15s 硬超时带 AbortSignal，绝不阻塞 poolCycle 派发。
// ===== 空响应重试（task-mvrfp1rj）+ 错误码分治（task-mvrqdw4k 用户拍板）：探测只裁存活性 =====
// 实证（cmss/zhanlu 系 glm-5.2、deepseek-v4.1-flash）：maxTokens=1 的极简请求被供应商以「terminal stop
// 零内容块」退回，宿主 adapter 归成 EMPTY_RESPONSE 错误（逐字文案，宿主 checkout grep 实测）：
//   ① dsh-llm-pi-ai mapStopReason：model "<m>" returned a completed response with no content
//   ② dsh-llm-deepseek          ：DeepSeek Messages returned no content
// 可用性实证（task-mvrqdw4k 三重，决定性）：v4.1-flash 正产出当轮对话、两次「失败」皆我方固定 60s 挂死闸
// 误杀（已修为自适应）——它是慢不是死，纯空响应=供应商怪癖，不该判死。
// 校准口径（用户拍板·错误码分治矩阵）：
//   ① 首探 maxTokens=1（最省 token；一次通即证明链路可用）；
//   ② 首探「空响应」→ 自动以 maxTokens=8 重试一次（给模型吐 token 的余地，消掉 length 截断型空响应大头）；
//   ③ 重试有内容 → 🟢 探测通过（存活 = 可调用）；
//   ④ 重试仍空 → 按文本/码信号分治（classifyEmptyResponse）：纯空响应=🟡 degraded 存活（链路通，供应商
//      怪癖）——observeModel 记降级不记失败、不喂冷却嗅探、路由仍可选用；额度/凭据/连接信号=真错，维持
//      失败臂照旧 observeModel 失败 + 喂冷却嗅探（quota 文本优先级高于空响应判定，⑬b/⑬d 契约保留）；
//   ⑤ 真错误/aborted/超时/无 finish 语义逐字不变，且不触发重试（一次定性，省一次请求也省一次误判）。
// 放宽不放跑真坏模型（闭环论证）：额度真耗尽有两条独立通道——①宿主直接抛 QUOTA_EXCEEDED（探测即降级）；
// ②若网关伪装成空响应，真派发 run 会失败 → recentRuns 软闸（≥2 全败）跳过它——探测管可调性、行为闸管质量。
// 边界：只动探测判定/健康状态派生/UI 映射与断言；探测调度节奏（probeNextAt/probeIntervalMin）与熔断联动不动。
var PROBE_MAX_TOKENS = 1        // 首探极简：1 token 证链路通
var PROBE_MAX_TOKENS_RETRY = 8  // 空响应重试：给模型吐 token 的余地
var PROBE_ATTEMPT_TIMEOUT_MS = 20000 // 每次尝试独立超时（task-mvsv8zym：两次尝试各拿满 20s，非共享递减——
// 旧 15s 共享预算下慢模型首探耗 ~10s 后重试只剩残余必超时，被我方预算饿死误记成模型失败）。
// 总上限 40s 不违反「绝不阻塞 poolCycle」：探测经 maybeProbeModels 后台异步跑（不 await 进派发主链）。
// EMPTY_RESPONSE 识别（双路）：结构化 code 优先（宿主 finish.failure.code，常量见 dsh-llm/lib/types/error.js），
// 文本特征兜底（兼容只给 message 的旧宿主/网关包装文本）。只认「completed 但零内容」；
// 429/连接/超时等真错误文本一律 false，走既有失败臂（冷却登记口径不变）。
function isEmptyResponse(code, text) {
  if (String(code || '') === 'EMPTY_RESPONSE') return true
  return /no content/i.test(String(text || ''))
}
// 错误码分治信号（task-mvrqdw4k）：宿主把额度/凭据问题单独编码（QUOTA_EXCEEDED_CODE/INVALID_CREDENTIAL_CODE
// 与 EMPTY_RESPONSE_CODE 并列导出），网关包装文本同样带字样——空响应文本/码命中额度/凭据/连接信号 → 真错，
// 维持失败臂（冷却嗅探接管）；纯空响应（无任何真错信号）→ 🟡degraded 存活（供应商怪癖：链路通但极简请求零内容）。
var QUOTA_SIGNAL_RE = /429|RATE_LIMIT|QUOTA_EXCEEDED|rate.?limit|限额|额度|quota/i
var CREDENTIAL_SIGNAL_RE = /INVALID_CREDENTIAL|\b401\b|invalid[ _-]?api[ _-]?key|unauthorized|凭据|凭证/i
// 空响应分治：返回 'degraded'（纯空响应=链路存活）| 'fail'（额度/凭据/连接信号=真错，走失败臂）。
// 判定顺序：额度 > 凭据 > 连接 > degraded（与 parseModelCooldown 先限流后连接的保守口径一致）。
function classifyEmptyResponse(code, text) {
  var s = String(text || ''), c = String(code || '')
  if (QUOTA_SIGNAL_RE.test(s) || /QUOTA/i.test(c)) return 'fail'
  if (CREDENTIAL_SIGNAL_RE.test(s) || /CREDENTIAL/i.test(c)) return 'fail'
  if (CONNECTIVITY_RE.test(s)) return 'fail'
  return 'degraded'
}

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
    // 探测态（拆分第 4 刀随迁，原 dispatch.mjs 同名段）：probeInFlight=同模型在飞探测 promise 表
    // （同模型全局只在飞一次）；probeAbort=在飞尝试 AbortController 表（dispose 时统一 abort）；
    // probeNextAt=15s 心跳间隔闸表（sid → { at, plan }，配置变化立即重排——探测节奏唯一闸）；
    // probeDisposed=插件卸载闸。拆分第 2 刀时期由 dispatch.mjs 持有并经 opts.disposed 注入同步；第 4 刀
    // 随探测域入厂后成为本域内部状态，卸载入口收敛为下方 disposeProbe()（dispatch.mjs 的卸载 effect 回调
    // 只调它）——dispose 后 observeModel/probeModel 不再写表，既有卸载闸语义逐字不变。
    var probeInFlight = {}, probeAbort = {}, probeNextAt = {}, probeDisposed = false
    var disposed = function () { return probeDisposed }
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
    // ===== 主动探测编排（拆分第 4 刀随迁）：probeOnce 单次请求 → probeModel 单模型三态 → =====
    // probeConfiguredModels 配置集合探测 → maybeProbeModels 15s 心跳间隔闸 → disposeProbe 统一卸载入口。
    // 「绝不阻塞 poolCycle」红线：探测经 maybeProbeModels 后台异步跑（不 await 进派发主链）；
    // probeNextAt 间隔闸与 probeModel 三态消费（true=🟢存活 / 'degraded'=🟡降级存活 / false=失败）语义零变化。
    // 单次探测请求：返回 { status:'ok' } | { status:'empty', text, code } | { status:'fail', text }
    //   | { status:'timeout', text }（task-mvsv8zym：超时单列形态，不再与真错误混记 fail——
    //     超时可能只是慢模型+我方预算约束，由上层按首次尝试判定落定或保留既有观测）。
    // attemptMs = 单次尝试独立超时（每尝试各拿满全额预算，非共享递减；task-mvsv8zym）。
    // 每次尝试独立 AbortController/计时器；probeAbort 指向当前在飞尝试（dispose 时统一 abort）。
    async function probeOnce(llm, model, maxTokens, attemptMs) {
      var ac = new AbortController(), timedOut = false, disposeTimer = null
      var attempt = Math.max(1, Number(attemptMs) || 0)
      var slash = model.indexOf('/')
      try {
        if (ctx.timer && typeof ctx.timer.timeout === 'function') disposeTimer = ctx.timer.timeout(function () { timedOut = true; ac.abort() }, attempt)
        else { var nativeTimer = setTimeout(function () { timedOut = true; ac.abort() }, attempt); disposeTimer = function () { clearTimeout(nativeTimer) } }
        probeAbort[model] = ac
        var stream = llm.stream({ provider: model.slice(0, slash), model: model.slice(slash + 1), messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], maxTokens: maxTokens, signal: ac.signal })
        var finished = false, failure = '', failureCode = ''
        for await (var chunk of stream) {
          if (!chunk || chunk.type !== 'finish') continue
          finished = true
          var reason = chunk.reason || {}
          if (reason.kind === 'error' || reason.kind === 'aborted') {
            failure = String((reason.failure && reason.failure.message) || reason.kind || '模型探测失败')
            failureCode = String((reason.failure && reason.failure.code) || '')
          }
        }
        if (timedOut) return { status: 'timeout', text: 'probe timeout ' + Math.round(attempt) + 'ms' }
        if (!finished) return { status: 'fail', text: '模型探测流未返回 finish' }
        if (failure) return isEmptyResponse(failureCode, failure) ? { status: 'empty', text: failure, code: failureCode } : { status: 'fail', text: failure }
        return { status: 'ok' }
      } catch (e) {
        // 抛错形态（provider 直接 throw LlmError）：code 可能带 EMPTY_RESPONSE，文本兜底同一谓词
        if (timedOut) return { status: 'timeout', text: 'probe timeout ' + Math.round(attempt) + 'ms' }
        var text = String(e && e.message || e)
        return isEmptyResponse(e && e.code, text) ? { status: 'empty', text: text, code: String(e && e.code || '') } : { status: 'fail', text: text }
      } finally {
        try { if (typeof disposeTimer === 'function') disposeTimer() } catch (_) {}
      }
    }
    async function probeModel(sid, model) {
      if (probeDisposed) return null
      if (probeInFlight[model]) return probeInFlight[model]
      var llm = ctx.get && ctx.get('llm')
      if (!llm || typeof llm.stream !== 'function') return null
      var slash = model.indexOf('/')
      if (slash <= 0 || slash === model.length - 1) return null
      var started = Date.now()
      var promise = (async function () {
        try {
          var outcome = await probeOnce(llm, model, PROBE_MAX_TOKENS, PROBE_ATTEMPT_TIMEOUT_MS)
          if (outcome.status === 'timeout') {
            // ③ 首探即超时（task-mvsv8zym）：无重试（⑬e 契约保留），且不覆盖既有观测——只更新 note
            // （判定保留）：超时可能只是慢模型+我方预算约束，已 healthy/degraded 条目不倒退成 unknown。
            observeModel(sid, model, false, { probe: true, preserveObserved: true, note: String(outcome.text || '').slice(0, 300) })
            return false
          }
          if (outcome.status === 'empty') {
            // 空响应 = 唯一触发重试的形态（真错误/超时/无 finish 一次定性，不重试）
            if (probeDisposed) {
              // 探测已停（dispose 中断）：无重试机会，仍按错误码分治落定（停机是我方调度约束，非模型健康信号）
              var budgetText = '空响应且探测已停（不重试，零内容）：' + outcome.text
              outcome = classifyEmptyResponse(outcome.code, outcome.text) === 'degraded'
                ? { status: 'degraded', text: budgetText }
                : { status: 'fail', text: budgetText }
            } else {
              var first = outcome
              outcome = await probeOnce(llm, model, PROBE_MAX_TOKENS_RETRY, PROBE_ATTEMPT_TIMEOUT_MS)
              // 重试仍空 = 按错误码分治（task-mvrqdw4k 用户拍板）：纯空响应=🟡degraded 存活（供应商怪癖，链路通）
              // ——不喂冷却、路由仍可选用；额度/凭据/连接信号=真错，维持失败臂（quota 文本优先级高于空响应判定，
              // ⑬b/⑬d 契约保留）。文案标明重试口径便于排查与嗅探归因。
              if (outcome.status === 'empty') {
                var emptyText = 'maxTokens=' + PROBE_MAX_TOKENS_RETRY + ' 重试仍空（EMPTY_RESPONSE）：' + outcome.text
                outcome = classifyEmptyResponse(outcome.code, outcome.text) === 'degraded'
                  ? { status: 'degraded', text: emptyText }
                  : { status: 'fail', text: emptyText }
              } else if (outcome.status === 'timeout') {
                // ② 重试超时≠失败（task-mvsv8zym）：每尝试独立 20s 预算仍耗尽=慢模型，沿用首次尝试判定落定
                // ——与「探测已停」分支同原则（我方预算/停机约束非模型健康信号，L407-412 对称补齐）：
                // 首探纯空响应→🟡degraded；首探文本带额度/凭据/连接信号→fail（嗅探接管）。
                var firstVerdict = classifyEmptyResponse(first.code, first.text)
                outcome = firstVerdict === 'degraded'
                  ? { status: 'degraded', text: '重试预算耗尽（慢模型），沿用首探判定：' + String(first.text || '') }
                  : { status: 'fail', text: '重试预算耗尽（慢模型），沿用首探判定：' + String(first.text || '') }
              }
            }
          }
          if (outcome.status === 'ok') {
            observeModel(sid, model, true, { probe: true, latencyMs: Date.now() - started })
            return true
          }
          if (outcome.status === 'degraded') {
            // 🟡 降级存活臂（task-mvrqdw4k）：记存活不记失败——observeModel 落 degraded 派生态；
            // 不调 sniffModelCooldown（冷却表零登记）；recentRuns 不动（探测本就不进 recentRuns，观察臂已隔开）。
            observeModel(sid, model, false, { probe: true, degraded: true, latencyMs: Date.now() - started, note: String(outcome.text || '').slice(0, 300) })
            return 'degraded'
          }
          var text = String(outcome.text || '模型探测失败').slice(0, 300)
          observeModel(sid, model, false, { probe: true, latencyMs: Date.now() - started, note: text })
          if (!probeDisposed) { try { await sniffModelCooldown(sid, '', model, text) } catch (_) {} }
          return false
        } catch (e) {
          // 兜底臂（probeOnce 自吞错，理论不可达）：语义与旧实现逐字一致
          var failText = String(e && e.message || e).slice(0, 300)
          observeModel(sid, model, false, { probe: true, latencyMs: Date.now() - started, note: failText })
          if (!probeDisposed) { try { await sniffModelCooldown(sid, '', model, failText) } catch (_) {} }
          return false
        } finally {
          delete probeInFlight[model]
          delete probeAbort[model]
        }
      })()
      probeInFlight[model] = promise
      return promise
    }
    async function probeConfiguredModels(sid, d) {
      var c = core.cfg(d), models = core.configuredModelIds(d)
      for (var i = 0; i < models.length; i++) syncModelHealth(sid, models[i])
      if (!c.probeEnabled) return { disabled: true, models: models, probed: 0, degraded: 0 }
      var llm = ctx.get && ctx.get('llm')
      if (!llm || typeof llm.stream !== 'function') return { disabled: false, unavailable: true, models: models, probed: 0, degraded: 0 }
      var probed = 0, healthy = 0, degraded = 0
      for (var m = 0; m < models.length; m++) {
        if (probeDisposed) break
        var before = probeInFlight[models[m]] ? false : true
        var outcome = await probeModel(sid, models[m])
        if (outcome === null) continue
        if (before) probed++
        // task-mvrqdw4k：probeModel 三态消费——true=🟢存活、'degraded'=🟡降级存活（供应商怪癖）、false=失败
        if (outcome === true) healthy++
        else if (outcome === 'degraded') degraded++
      }
      return { disabled: false, models: models, probed: probed, healthy: healthy, degraded: degraded }
    }
    // 15s 调度心跳驱动间隔闸：配置变化立即重排，探测在后台跑，不 await 进派发主链。
    function maybeProbeModels(sid, d) {
      var c = core.cfg(d), now = Date.now()
      if (!c.probeEnabled) { probeNextAt[sid] = 0; return }
      var llm = ctx.get && ctx.get('llm')
      if (!llm || typeof llm.stream !== 'function') return
      var planKey = String(c.probeIntervalMin)
      if (probeNextAt[sid] && probeNextAt[sid].plan === planKey && now < probeNextAt[sid].at) return
      if (!probeNextAt[sid] || probeNextAt[sid].plan !== planKey) probeNextAt[sid] = { at: 0, plan: planKey }
      probeNextAt[sid] = { at: now + c.probeIntervalMin * 60000, plan: planKey }
      probeConfiguredModels(sid, d).catch(function (e) { console.error('[task-board] 模型健康探测失败（下周期重试）:', String(e)) })
    }
    // 插件卸载统一入口（拆分第 4 刀）：落卸载闸（probeDisposed）+ abort 在飞尝试 + 清 probeNextAt 间隔闸表。
    // 注册仍由 dispatch.mjs 的卸载 effect 执行（回调只调本方法）——三步操作与旧卸载 effect 逐字一致；
    // dispose 后 probeModel 不再启动新探测、在飞尝试被 abort、迟到结果不再写健康表。
    function disposeProbe() {
      probeDisposed = true
      Object.keys(probeAbort).forEach(function (model) { try { probeAbort[model].abort() } catch (_) {} })
      probeNextAt = {}
    }
    return { healthBucket: healthBucket, healthEntry: healthEntry, syncModelHealth: syncModelHealth, observeModel: observeModel, markModelCircuit: markModelCircuit, cooldownLive: cooldownLive, sniffModelCooldown: sniffModelCooldown, modelDirectory: modelDirectory, outOfDir: outOfDir, traceStaleModel: traceStaleModel, healthyModel: healthyModel, pickHealthyFallback: pickHealthyFallback, isModelKillFailure: isModelKillFailure, feedModelFailure: feedModelFailure, resetModelFailure: resetModelFailure, probeConfiguredModels: probeConfiguredModels, maybeProbeModels: maybeProbeModels, disposeProbe: disposeProbe }
}
