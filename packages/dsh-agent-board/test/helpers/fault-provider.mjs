// dsh-agent-board — 可编程故障供应商层（test/helpers/fault-provider.mjs）
// 在 mock-ctx 无头宿主上落**opt-in 的故障注入面**：installFaults(env, { programs, directory, ... })
// 调用后才替换/包装 env.ctx.subagents 与 env.ctx.get('llm') 返回值——缺省 createMockCtx() 行为
// 逐字不变（尤其**不得**给缺省 subagents 加 startActivation：dispatch.mjs hasActivationApi 一旦为真，
// 全部既有集成测试的 spawn 会从 start/startContinuable 翻到 startActivation 路径=大面积改写不可接受）。
//
// 五档故障模式（首期全部可用）：
//   ① instant-kill 秒拆 —— activation.result/run.result 以「子会话被宿主拆除（stopReason: error，<diag>）」
//      前缀文本**裸字符串**拒（isModelKillFailure 锚定该前缀；先例：new Error 会被 String(err) 包上
//      'Error: ' 前缀导致前缀锚定失效——必须传裸字符串）。diagnostic 刻意避开冷却关键词。
//   ② hang 挂死          —— childId/run id 返回后 result 永不落定零事件；配合写真日志文件到
//      <home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd（布局对齐 integration.test.mjs
//      writeChildLog 先例——挂死零产出检测按 logSizeOf 量字节，文件存在即有基线、永不增长即零产出）。
//   ③ empty 空响应       —— 落定 output text=''（一次性面）；continuable 面写空 assistant 帧 +
//      重放 running→idle（settleContinuable 读到空文本按失败结算，绝不当成空完成推进）。
//   ④ rate-limit 限流    —— 以「429 RATE_LIMIT: 限额将在 <本地时刻> 重置」文本**裸字符串**拒
//      （parseModelCooldown 中文带重置形态；resetAt/resetInMs 可编程，缺省 now+30min）。
//   ⑤ slow 慢响应        —— 可编程延时（ctx.timer.timeout=虚拟时钟，clock.advance 可推）后正常落定。
//
// 必备观测面：
//   · spawn 日志 handle.spawnLog：逐条 { label, provider, model, delivery, method, at, fault }——
//     model 由 agentOptions 拼回 prov/model 复合格式（取模链拆分点的逆操作）：provider+model；
//     无 slash 裸 model 原样；无 agentOptions = 父模型（''）。
//   · llm 目录可编程且**运行中可变**：listProviders/listModels 每次现取不缓存（目录失效场景靠
//     中途 shrink 实现），handle.directory.add/remove/set 即刻生效。
//   · llm.stream 桩：yield { type:'finish', reason:{kind:'stop'} } 为健康；
//     { type:'finish', reason:{kind:'error', failure:{message}} } 为失败（probeModel 消费口径）。
//   · 每档故障程序支持「次数窗口」：times: N = 前 N 次命中后自愈（连败软闸/恢复旅程场景）；
//     缺省 1（剧本表语义——命中一次即翻下一个程序），times: Infinity = 永续。
//
// 契约细节（与 dispatch.mjs 消费面对照）：
//   · result 级拒绝前**就地挂防御性空 catch**：spawn 返回与结算臂挂接（armTimeouts / activation
//     拆除臂）之间隔着 await 窗口，先标记「有人处理」防 unhandled rejection 崩掉测试进程。
//   · 老 startContinuable（无 result 承诺）上 instant-kill/rate-limit 只能 spawn 层拒（throw——
//     dispatch catch 冷却嗅探①通道读 e.message）；hang/empty/slow 在结果面（日志+事件）落地。
//   · activation 合成（activation:true 或原桩已有 startActivation）：delivery='parent' 走事件结算
//     （result 只认拆除落定——健康合成不落定 result）；delivery='caller' 一次性 result 结算。
//   · form:'teardown'（仅 delivery='parent' 生效）：result 以 { output:[], stopReason:'error',
//     diagnostic } 落定——拆除落定形态（dispatch 由宿主构造「子会话被宿主拆除」前缀文本）。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

var KILL_PREFIX = '子会话被宿主拆除（stopReason: error，'
var FAULT_TYPES = ['instant-kill', 'hang', 'empty', 'rate-limit', 'slow']
var MATCH_KEYS = ['label', 'role', 'method']
var RATE_LIMIT_DEFAULT_IN_MS = 30 * 60000
var SLOW_DEFAULT_MS = 250
var DEFAULT_BUCKET = 'test-bucket'
var DEFAULT_HEALTHY_TEXT = 'mock-fault healthy：正常完成'

function pad2(n) { return ('0' + n).slice(-2) }
// 本地时区 YYYY-MM-DD HH:mm:ss（重置时刻解析口径：中文「重置」形态）
function localTs(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) }

function normalizeDirectory(d) {
  if (typeof d === 'function') return { fn: d, map: null }
  var map = {}
  var i, k
  if (Array.isArray(d)) for (i = 0; i < d.length; i++) { if (d[i]) map[String(d[i])] = true }
  else if (d && typeof d === 'object') for (k in d) { if (d[k]) map[k] = true }
  return { fn: null, map: map }
}
function dirToMap(v) {
  var map = {}
  var i, k
  if (Array.isArray(v)) for (i = 0; i < v.length; i++) { if (v[i]) map[String(v[i])] = true }
  else if (v && typeof v === 'object') for (k in v) { if (v[k]) map[k] = true }
  return map
}
function readDirectory(dirState) {
  if (dirState.fn) return dirToMap(dirState.fn())
  return dirState.map
}
function normalizeStreamSpec(v, key) {
  if (v === 'error') return { kind: 'error', message: 'mock stream 故障（' + key + '）' }
  if (v === 'stop') return { kind: 'stop' }
  if (v && typeof v === 'object') return v
  throw new TypeError('installFaults: stream[' + key + '] 值必须是 error/stop/{kind,...} 形态，收到 ' + typeof v)
}
function normalizeStream(s) {
  if (typeof s === 'function') return { fn: s, map: null }
  var map = {}
  if (s && typeof s === 'object') for (var k in s) map[k] = normalizeStreamSpec(s[k], k)
  return { fn: null, map: map }
}
function normalizeMatch(m, i) {
  if (typeof m === 'string') return { label: m }
  if (!m) return null
  for (var k in m) { if (MATCH_KEYS.indexOf(k) < 0) throw new TypeError('installFaults: programs[' + i + '].match 未知键: ' + k + '（可用: ' + MATCH_KEYS.join('/') + '）') }
  return m
}
// 剧本表归一：字符串简写 = { type }；type 必须 ∈ 五档；times ≥1（缺省 Infinity=永续）
function normalizePrograms(list) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new TypeError('installFaults: programs 必须是数组（按序消费的剧本表），收到 ' + typeof list)
  return list.map(function (raw, i) {
    var p = typeof raw === 'string' ? { type: raw } : raw
    if (!p || typeof p.type !== 'string') throw new TypeError('installFaults: programs[' + i + '] 缺 type 字段')
    if (FAULT_TYPES.indexOf(p.type) < 0) throw new TypeError('installFaults: programs[' + i + '].type 未知故障模式: ' + p.type + '（可用: ' + FAULT_TYPES.join('/') + '）')
    // 次数窗口：缺省 1（剧本表语义——命中一次即翻下一个程序）；times: Infinity = 永续（所有命中 spawn 全吃）
    var times = p.times === undefined ? 1 : p.times
    if (typeof times !== 'number' || times < 1) throw new TypeError('installFaults: programs[' + i + '].times 必须是 ≥1 的数字（次数窗口，Infinity=永续）')
    return {
      type: p.type, times: times, match: normalizeMatch(p.match, i), used: 0, done: false,
      diagnostic: p.diagnostic, message: p.message, resetAt: p.resetAt, resetInMs: p.resetInMs,
      delayMs: p.delayMs, text: p.text, logText: p.logText, logBucket: p.logBucket,
      writeLog: p.writeLog, form: p.form, at: p.at,
    }
  })
}
// 帧格式：与 lib/usage.mjs readLogFrames 同形（多帧 zstd 顺序拼接，帧内 jsonl）；zstd 不可用（老 Node）退 plain utf8 字节
function frameOf(events) {
  var buf = Buffer.from(events.map(function (e) { return JSON.stringify(e) }).join('\n') + '\n', 'utf8')
  if (typeof zlib.zstdCompressSync === 'function') return zlib.zstdCompressSync(buf)
  return buf
}

/**
 * 安装故障供应商层（opt-in；必须在 plugin.apply 之前调用）。
 * @param {Object} env   mock-ctx 环境（createMockCtx 返回值）
 * @param {Object} [opts]
 * @param {Array}  [opts.programs]      剧本表（按序消费）：{ type, times?, match?, ...typeOpts }
 * @param {Object|Array|Function} [opts.directory] 初始模型目录（复合 id 键/数组/函数源；缺省空目录）
 * @param {boolean} [opts.activation]  合成 startActivation（模拟 v0.2.1+ 宿主契约）；缺省 false=绝不加
 * @param {Object} [opts.stream]       llm.stream 桩配置：{ '<prov/model>': {kind,message?,delayMs?} } 或函数
 * @param {string} [opts.logBucket]    故障日志桶名（缺省 test-bucket）
 * @param {string} [opts.healthyText]  activation 健康合成日志文本
 * @param {boolean} [opts.autoIdle]    continuable 面故障自动重放 running→idle（缺省 true）
 * @returns {Object} handle：{ spawnLog, programs, llm, directory, activation, uninstall }
 */
export function installFaults(env, opts) {
  opts = opts || {}
  if (!env || !env.ctx) throw new TypeError('installFaults: 需要 mock-ctx 环境（env.ctx）——先 createMockCtx 再 installFaults')
  var ctx = env.ctx
  var origSub = ctx.subagents
  if (!origSub) throw new TypeError('installFaults: env.ctx.subagents 缺失')
  var origGet = ctx.get
  var origActivation = (origSub && typeof origSub.startActivation === 'function') ? origSub.startActivation : null
  var programs = normalizePrograms(opts.programs)
  var dirState = normalizeDirectory(opts.directory)
  var streamState = normalizeStream(opts.stream)
  // activation 合成开关（opt-in）：true = 包装层提供 startActivation（模拟 v0.2.1+ 宿主契约，spawn 翻到
  // startActivation 路径——**仅测试显式要求时**）；缺省 false——原桩没有就绝不加（hasActivationApi
  // 路径保全，零回归红线）；原桩已有则包装之（委托透传，日志/故障程序照常生效）。
  var synthActivationMode = opts.activation === true || !!origActivation
  var logBucket = opts.logBucket || DEFAULT_BUCKET
  var healthyText = opts.healthyText || DEFAULT_HEALTHY_TEXT
  var autoIdle = opts.autoIdle !== false
  var spawnLog = []
  var faultRunSeq = 0
  var faultChildSeq = 0

  function matches(m, e) {
    if (!m) return true
    if (m.label !== undefined && String(e.label || '').indexOf(m.label) !== 0) return false
    if (m.method !== undefined && e.method !== m.method) return false
    if (m.role !== undefined) {
      var lab = String(e.label || '')
      var ok = m.role === 'hook'
        ? (lab.indexOf('hook-pre:') === 0 || lab.indexOf('hook-post:') === 0 || lab.indexOf('hook:') === 0)
        : lab.indexOf(m.role + ':') === 0
      if (!ok) return false
    }
    return true
  }
  // 剧本表按序消费：首个「match 命中且未耗尽」的程序吃掉本次 spawn；times 用尽即 done（自愈——
  // 之后的 spawn 逐字委托原方法，恢复旅程场景依赖此语义）
  function pickProgram(entry) {
    for (var i = 0; i < programs.length; i++) {
      var p = programs[i]
      if (p.done) continue
      if (!matches(p.match, entry)) continue
      p.used++
      if (p.used >= p.times) p.done = true
      return p
    }
    return null
  }
  // model 复合格式重构（取模链拆分点的逆操作）：agentOptions.provider 存在 → provider/model；
  // 无 slash 裸 model 原样；无 agentOptions = 父模型（''）
  function modelFromAgentOptions(ao) {
    if (!ao) return ''
    if (ao.provider) return String(ao.provider) + '/' + String(ao.model || '')
    return String(ao.model || '')
  }
  function agentOptionsOf(method, reqLike) {
    if (!reqLike) return null
    if (method === 'start') return reqLike.agentOptions || null
    return (reqLike.request && reqLike.request.agentOptions) || null
  }
  function logSpawn(method, provider, reqLike, delivery) {
    var e = {
      label: (reqLike && reqLike.label) || '',
      provider: String(provider || ''),
      model: modelFromAgentOptions(agentOptionsOf(method, reqLike)),
      delivery: delivery,
      method: method,
      at: new Date().toISOString(),
    }
    spawnLog.push(e)
    return e
  }
  // ===== 故障文本构造（与解析器口径逐一对齐）=====
  function faultTextOf(program) {
    if (program.type === 'instant-kill') {
      // 「子会话被宿主拆除（stopReason: error，<diag>）」前缀（isModelKillFailure 锚定）；diagnostic 避开冷却关键词
      return KILL_PREFIX + (program.diagnostic || 'mock-fault: instant-kill') + '）'
    }
    // 「429 … 限额将在 <本地时刻> 重置」（中文带重置形态；resetAt > resetInMs > now+30min 缺省）
    if (program.message) return program.message
    var base = program.resetAt !== undefined ? program.resetAt
      : Date.now() + (program.resetInMs !== undefined ? program.resetInMs : RATE_LIMIT_DEFAULT_IN_MS)
    var ts = base instanceof Date ? base.getTime() : base
    return '429 RATE_LIMIT: 当前账户额度已用尽，限额将在 ' + localTs(ts) + ' 重置'
  }
  function hangTextOf(program) {
    return program.logText !== undefined ? program.logText : 'mock-fault hang：会话挂死中（永不落定）'
  }
  // 真日志文件：<home>/.dsh/sessions/<桶>/<childId>/session.v4.jsonl.zstd（布局对齐 writeChildLog 先例）
  // 挂死零产出检测按 logSizeOf 量字节：文件存在即有基线，永不增长即零产出。
  function writeFaultLog(program, childId, text) {
    if (!childId) return
    if (program && program.writeLog === false) return
    var bucket = (program && program.logBucket) || logBucket
    var dir = path.join(env.home, '.dsh', 'sessions', bucket, childId)
    fs.mkdirSync(dir, { recursive: true })
    var ev = { type: 'assistant/message', time: Date.now(), seq: 1, data: { message: { content: [{ type: 'text', text: text }] } } }
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frameOf([ev]))
  }
  // 重放 agent/status running→idle（先 running 后 idle——rec.ran 守卫要求，只挡伪 idle 不挡正常结算）。
  // setImmediate（宏任务）：dispatch 拿到 childId 后零 await 先登记 rec，再让出——事件落在登记之后。
  function scheduleIdle(childId) {
    if (!autoIdle) return
    if (typeof env.emitStatus !== 'function') return
    setImmediate(function () {
      env.emitStatus(childId, 'running')
      env.emitStatus(childId, 'idle')
    })
  }
  // ===== 结果面故障落地（result-bearing 路径共用）：run.result / activation.result =====
  // delivery='parent'（continuable 面）的 empty/slow 与老 continuable 同形：写日志 + 重放 idle
  // （settlement 走事件通道）；'caller'/'run'（一次性面）走 result 落定。
  function strikeResult(program, id, result, settle, delivery) {
    var continuable = delivery === 'parent'
    var type = program.type
    if (type === 'hang') {
      // 挂死：日志真写（logSizeOf 基线），result 永不落定零事件
      writeFaultLog(program, id, hangTextOf(program))
      return
    }
    if (type === 'instant-kill' || type === 'rate-limit') {
      // form:'teardown'（仅 delivery='parent'）：result 以 { stopReason:'error', diagnostic } 落定——
      // 拆除落定形态（dispatch 拆除臂由宿主构造「子会话被宿主拆除（stopReason: error，…）」前缀文本）
      if (program.form === 'teardown' && delivery === 'parent') {
        settle.res({ output: [], stopReason: 'error', diagnostic: type === 'instant-kill' ? (program.diagnostic || 'mock-fault: instant-kill') : faultTextOf(program) })
        return
      }
      // 缺省：result 以**裸字符串**拒（结算臂只做 String(err)——new Error 会被包上 'Error: ' 前缀，
      // isModelKillFailure 的前缀锚定（index 0）失效）。就地挂防御性空 catch：spawn 返回与结算臂
      // 挂接之间隔着 await 窗口，先标记「有人处理」防 unhandled rejection 崩进程。
      result.catch(function () {})
      settle.rej(faultTextOf(program))
      return
    }
    if (type === 'empty') {
      if (continuable) {
        // 空响应：assistant text=''（settleContinuable 读到空文本按失败结算，绝不当成空完成推进）
        writeFaultLog(program, id, '')
        scheduleIdle(id)
        return
      }
      // 空响应：落定 output text=''（一次性面语义）
      settle.res({ output: [{ type: 'text', text: '' }], stopReason: 'completed' })
      return
    }
    // slow：可编程延时（ctx.timer.timeout=虚拟时钟，clock.advance 可推）后正常落定
    var delay = typeof program.delayMs === 'number' ? program.delayMs : SLOW_DEFAULT_MS
    var text = program.text !== undefined ? program.text : 'mock-fault slow：正常完成'
    Promise.resolve(ctx.timer.timeout(delay)).then(function () {
      if (continuable) {
        writeFaultLog(program, id, text)
        scheduleIdle(id)
        return
      }
      settle.res({ output: [{ type: 'text', text: text }], stopReason: 'completed' })
    })
  }
  // ===== 老 startContinuable（无 result 承诺）结果面：settlement 走 agent/status 事件 =====
  function strikeContinuable(program, c) {
    var type = program.type
    if (type === 'hang') {
      writeFaultLog(program, c.childId, hangTextOf(program))
      return // 永不落定零事件：无 idle 重放、无 result
    }
    if (type === 'empty') {
      writeFaultLog(program, c.childId, '') // 空响应：assistant text=''（settleContinuable 读到空文本按失败结算）
      scheduleIdle(c.childId)
      return
    }
    // slow：延时后写健康日志 + 重放 idle
    var delay = typeof program.delayMs === 'number' ? program.delayMs : SLOW_DEFAULT_MS
    var text = program.text !== undefined ? program.text : 'mock-fault slow：正常完成'
    Promise.resolve(ctx.timer.timeout(delay)).then(function () {
      writeFaultLog(program, c.childId, text)
      scheduleIdle(c.childId)
    })
  }
  // ===== 合成新契约 Activation（activation opt-in / 原桩已有 startActivation 时）=====
  // { childId, messageId, result, dispose }（SubagentActivation 契约形状）
  function synthActivation(spec, delivery, program) {
    // spawn 层拒（at:'spawn' 显式，或老 continuable 无 result 的缺省）：调用本身 throw——
    // dispatch catch 冷却嗅探①通道读 e.message（带覆盖模型首败命中限流/连接 → 登记冷却表）
    if (program && (program.type === 'instant-kill' || program.type === 'rate-limit') && program.at === 'spawn') {
      throw new Error(faultTextOf(program))
    }
    var settle = {}
    var result = new Promise(function (res, rej) { settle.res = res; settle.rej = rej })
    var act = {
      childId: 'fault-child-' + (++faultChildSeq),
      messageId: 'm' + faultChildSeq,
      result: result,
      dispose: async function () { act.disposed = true },
      label: (spec && spec.label) || '',
      request: spec && spec.request,
      delivery: delivery,
      __fault: program ? program.type : null,
    }
    env.continuables.push(act)
    if (!program) {
      // 健康合成：production 正常完成 = parked-idle 不落定 result（结算走事件）；
      // delivery='caller' 一次性面：result 正常落定（结算走 run.result）
      if (delivery === 'caller') {
        settle.res({ output: [{ type: 'text', text: healthyText }], stopReason: 'completed' })
      } else {
        writeFaultLog(null, act.childId, healthyText)
        scheduleIdle(act.childId)
      }
      return act
    }
    strikeResult(program, act.childId, result, settle, delivery)
    return act
  }
  // ===== 包装 subagents：缺省方法逐字委托；spawn 三方法加日志 + 故障程序（opt-in 后才生效）=====
  var wrappedSub = {
    list: function () { return origSub.list() },
    getProvider: function () { return origSub.getProvider ? origSub.getProvider() : { inheritsParentContext: false } },
    start: async function (provider, req) {
      var entry = logSpawn('start', provider, req, 'run')
      var program = pickProgram(entry)
      entry.fault = program ? program.type : null
      if (!program) return origSub.start(provider, req) // 无程序命中：逐字委托（健康路径）
      // 合成一次性 run（同 makeRun 形态，__fault 留档）：故障面不走原 provider——模型/宿主「失败」了
      var settle = {}
      var result = new Promise(function (res, rej) { settle.res = res; settle.rej = rej })
      var run = {
        id: 'fault-run-' + (++faultRunSeq),
        provider: provider,
        req: req,
        result: result,
        disposed: false,
        __fault: program.type,
        localAgent: { steered: [], followed: [], steer: function (m) { this.steered.push(m) }, followup: function (m) { this.followed.push(m) } },
        dispose: async function () { run.disposed = true },
        resolveWith: function (text, stopReason) { settle.res({ output: [{ type: 'text', text: text || '' }], stopReason: stopReason || 'completed' }) },
        failWith: function (err) { settle.rej(err instanceof Error ? err : new Error(String(err))) },
      }
      env.runs.push(run)
      strikeResult(program, run.id, result, settle, 'run')
      return run
    },
  }
  if (origSub.startContinuable) {
    wrappedSub.startContinuable = async function (o) {
      var entry = logSpawn('startContinuable', o && o.provider, o, 'continuable')
      var program = pickProgram(entry)
      entry.fault = program ? program.type : null
      if (!program) return origSub.startContinuable(o)
      // 老 continuable 无 result 承诺：instant-kill/rate-limit 只能 spawn 层拒（throw——dispatch
      // catch 冷却嗅探①通道读 e.message；kill 文本不命中冷却关键词，绝不污染冷却表）
      if (program.type === 'instant-kill' || program.type === 'rate-limit') throw new Error(faultTextOf(program))
      var c = { childId: 'fault-child-' + (++faultChildSeq), messageId: 'm' + faultChildSeq, label: (o && o.label) || '', request: o && o.request, __fault: program.type }
      env.continuables.push(c)
      strikeContinuable(program, c)
      return c
    }
  }
  if (synthActivationMode) {
    wrappedSub.startActivation = async function (spec) {
      var delivery = (spec && spec.delivery) || 'parent'
      var entry = logSpawn('startActivation', spec && spec.provider, spec, delivery)
      var program = pickProgram(entry)
      entry.fault = program ? program.type : null
      if (!program && origActivation) return origActivation(spec) // 原桩已有：无程序命中时逐字委托
      return synthActivation(spec, delivery, program)
    }
  }
  if (origSub.sendMessage) wrappedSub.sendMessage = function (p, c, content) { return origSub.sendMessage(p, c, content) }
  if (origSub.interrupt) wrappedSub.interrupt = function (c, authority) { return origSub.interrupt(c, authority) }
  if (origSub.listChildren) wrappedSub.listChildren = function () { return origSub.listChildren() }
  // ===== 可编程 llm（ctx.get('llm') 返回值）：目录每次现取不缓存（运行中可变）+ stream 桩 =====
  var faultLlm = {
    listProviders: function () {
      if (env.llm) env.llm.listProviders = (env.llm.listProviders || 0) + 1 // 原记录器口径保留
      var dir = readDirectory(dirState)
      var providers = []
      var seen = {}
      Object.keys(dir).forEach(function (id) {
        var slash = id.indexOf('/')
        if (slash <= 0) return
        var p = id.slice(0, slash)
        if (!seen[p]) { seen[p] = true; providers.push({ id: p }) }
      })
      return providers
    },
    listModels: async function (p) {
      if (env.llm && Array.isArray(env.llm.listModels)) env.llm.listModels.push(p)
      var dir = readDirectory(dirState)
      var models = []
      Object.keys(dir).forEach(function (id) {
        var slash = id.indexOf('/')
        if (slash <= 0) return
        if (id.slice(0, slash) !== String(p)) return
        models.push({ id: id.slice(slash + 1) })
      })
      return models
    },
    stream: function (req) {
      var model = req && req.provider ? (String(req.provider) + '/' + String(req.model || '')) : String((req && req.model) || '')
      if (env.llm) { if (!Array.isArray(env.llm.streams)) env.llm.streams = []; env.llm.streams.push({ provider: req && req.provider, model: model, at: new Date().toISOString() }) }
      var spec = null
      if (streamState.fn) spec = normalizeStreamSpec(streamState.fn(req), 'fn')
      else if (streamState.map && Object.prototype.hasOwnProperty.call(streamState.map, model)) spec = streamState.map[model]
      var delayMs = spec && typeof spec.delayMs === 'number' ? spec.delayMs : 0
      return (async function* () {
        if (delayMs > 0) await ctx.timer.timeout(delayMs)
        if (spec && spec.kind === 'error') {
          // probeModel 消费口径：finish.reason.kind='error' + failure.message = 失败文本（进冷却登记）
          yield { type: 'finish', reason: { kind: 'error', failure: { message: String((spec && spec.message) || 'mock stream 故障') } } }
          return
        }
        // 健康：finish/stop（probeModel 消费口径——证明模型链路可用）
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }

  var handle = {
    spawnLog: spawnLog,
    programs: programs,
    activation: synthActivationMode,
    llm: faultLlm,
    // 目录操作面：remove/add/set 即刻生效（listModels/listProviders 每次现取，运行中可变）
    directory: {
      current: function () { var d = readDirectory(dirState); var out = {}; Object.keys(d).forEach(function (k) { out[k] = true }); return out },
      has: function (id) { return !!readDirectory(dirState)[String(id)] },
      add: function (id) { if (dirState.fn) throw new TypeError('directory 以函数注入时不可变——请直接改源函数'); dirState.map[String(id)] = true },
      remove: function (id) { if (dirState.fn) throw new TypeError('directory 以函数注入时不可变——请直接改源函数'); delete dirState.map[String(id)] },
      set: function (d) { if (dirState.fn) throw new TypeError('directory 以函数注入时不可变——请直接改源函数'); dirState.map = dirToMap(d) },
    },
    // 卸载：还原原 subagents 与 ctx.get（ctx.effect 注册 → env.cleanup 时自动回收）
    uninstall: function () {
      ctx.subagents = origSub
      ctx.get = origGet
      if (env.faults === handle) delete env.faults
    },
  }
  // 安装：替换 subagents + 包装 ctx.get('llm')——plugin.apply 必须在 installFaults 之后调用
  ctx.subagents = wrappedSub
  ctx.get = function (name) { if (name === 'llm') return faultLlm; return origGet.call(ctx, name) }
  // cleanup 自动卸载（ctx.effect 立即执行回调取 disposer——uninstall 在 env.cleanup 时被回收调用）
  ctx.effect(function () { return handle.uninstall })
  env.faults = handle
  return handle
}
