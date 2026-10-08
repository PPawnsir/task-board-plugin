// dsh-agent-board — 无头宿主基建（test/helpers/mock-ctx.mjs）
// 在**无 DSH 环境**下托住真实 index.mjs 的 apply(ctx)：全套假 cordis 服务 + 真 fs 临时 HOME +
// 虚拟时钟 + 剧本化 subagents + webServer 路由捕获 + systemPrompt/llm 记录器。
//
// 设计口径（与宿主真实契约逐一对齐，来源：lib/dispatch.mjs / lib/notify.mjs / lib/store.mjs / lib/rpc.mjs）：
//   · timer.timeout(ms)          → Promise（kickCycle 50ms / 歧义去抖 25s / 回执聚合 45s / withTimeout 硬超时）
//   · timer.timeout(cb, ms)      → dispose 函数（软超时臂，armTimeouts 回调式用法）
//   · timer.interval(fn, ms)     → dispose 函数（15s 心跳）
//   · subagents.start(provider, req)            → 一次性 run（result promise 由测试驱动落定/拒绝）
//   · subagents.startContinuable({...})         → { childId, messageId }（持久子会话，turn 结算走 emitStatus）
//   · subagents.sendMessage / interrupt / listChildren → 记录器 + 可剧本化
//   · agents.currentInitiator()/roots()/list()/get()/isOwnedBy() → 按测试剧本返回（缺省单 root，actor=root；env.setRoots 可清空模拟休眠）
//   · ctx.get('sessionPersistence')             → 持久会话表 stat(id)（env.persistedHeaders 可写 parentSession 模拟子会话/根会话）
//   · tools.register / webServer.register       → 捕获工具表与 RPC 路由（env.rpc 走真 readBody/handler 路径）
//   · ctx.get('systemPrompt'|'llm')             → 记录器（注册了什么段/查了什么模型都留痕）
//   · ctx.effect / ctx.on('agent/status')       → 真实执行 + disposer 收口 / 事件捕获与重放
//
// 看板文件走真路径：store 层用 node:fs 直读写 boardHome()=<$HOME>/.dsh——本 harness 把
// process.env.HOME 指到 os.tmpdir 下的独立临时目录（boardDirName() 每次现读 env，进程内安全），
// cleanup() 恢复原 env 并递归删除临时目录。每个用例一个独立 mockCtx + 独立临时目录，互不污染。
// 注意：插件自身从不 mkdir .dsh（生产上宿主保证 ~/.dsh 已存在），故 harness 建目录时预建
// <home>/.dsh 以镜像这一前置条件——否则 wt() 的 tmp 文件写入会 ENOENT。
//
// 虚拟时钟只接管 ctx.timer 注册的所有定时器；Date.now() 仍是真实墙钟（看板时间戳语义不变）。
// advance(ms) 按到期顺序同步触发回调/落定 promise，每轮之间让出宏任务使异步链（poolCycle→spawn→
// 落盘）起跑；链尾用 waitFor 轮询收敛（真实 I/O 不定长，这是有意设计而非竞态）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

/**
 * @typedef {Object} MockEnv
 * @property {Object} ctx            假 cordis ctx——直接传给插件 apply(ctx)
 * @property {string} sid            本会话（root agent）id
 * @property {string} home           临时 HOME 目录（看板文件在 <home>/.dsh/tasks-<sid>.json）
 * @property {Object} clock          虚拟时钟：advance(ms) 推进并触发到期定时器；tick() 手动触发一次心跳 interval；now() 当前虚拟毫秒
 * @property {Map}    tools          已注册工具表（task_create/board_report/board_verdict/task_arbitrate/...），调 .execute(args)
 * @property {(method:string, args?:Object)=>Promise<any>} rpc  以真 RPC 语义（POST body → readBody → handler）调捕获的路由
 * @property {Array}  runs           start() 产出的一次性 run：{ id, req, result, disposed, localAgent, resolveWith(text,stopReason?), failWith(err) }
 * @property {Array}  continuables   startContinuable 产出：{ childId, messageId, label, request }
 * @property {Array}  sendMessages   sendMessage 记录：{ parent, childId, content }
 * @property {Array}  interrupts     interrupt 记录：{ childId, authority }
 * @property {Array}  children       listChildren 剧本（可整组替换返回值）
 * @property {(childId:string, status:'running'|'idle')=>void} emitStatus  重放 agent/status 事件（continuable 结算触发器）
 * @property {Array}  sent           root.followup 捕获的消息（makeMsg 形态：content[0].text 取文本）
 * @property {Object} root           假 root agent（followup 记录器；刻意不带 whenIdle → 回执立即投递分支）
 * @property {Object} spSections     systemPrompt 注册段记录器
 * @property {Object} llm            llm 记录器（listProviders/listModels 调用留痕）
 * @property {string} actor          currentInitiator 返回值（缺省=root sid；测试可改写模拟子代理身份）
 * @property {(list:Object[])=>void} setRoots  改写活跃 root 集（传 [] 模拟休眠根会话/重建窗口）
 * @property {Object} persistedHeaders  持久会话表 sid → { id, parentSession }（写 parentSession 模拟子会话；缺省根会话 parentSession=undefined）
 * @property {()=>Object} board      读当前看板文件 JSON（不存在返回 null）
 * @property {(id:string)=>Object|undefined} task  看板里按 id 取任务
 * @property {(fn:Function, label?:string, timeoutMs?:number)=>Promise<any>} waitFor  真实时间轮询直到条件为真（默认 5s 上限）
 * @property {(label:string)=>Object|undefined} lastRun  按 label 前缀找最近一次一次性 run（label 形如 'worker:task-x'）
 * @property {(fn:(d:Object)=>void)=>void} patchBoard  直接改写看板文件（构造孤儿/脏数据场景用）
 * @property {()=>Promise<void>} cleanup  收尾：跑全部 disposer、恢复 HOME env、递归删临时目录
 */

/**
 * 创建一套无头宿主环境。
 * @param {Object} [opts]
 * @param {string} [opts.sid]       会话 id（缺省自动生成，形如 session-mock-xxxx-xx——满足 isFullSessionId 结构）
 * @param {string} [opts.cwd]       root agent 的工作区路径（缺省=临时 home；sessionCwd/ownerCwd 来源）
 * @returns {MockEnv}
 */
export function createMockCtx(opts) {
  opts = opts || {}
  var sid = opts.sid || ('session-mock-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36))
  var home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-board-test-'))
  // 镜像宿主前置条件：生产上 ~/.dsh 由宿主保证存在（插件自身从不 mkdir）——临时 HOME 里预建，
  // 否则 store.wt() 写 <home>/.dsh/tasks-<sid>.json.tmp 会 ENOENT。
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  var cwd = opts.cwd || home

  // ===== 临时 HOME 接管（boardDirName 每次现读 env → 看板文件落在这里，与真实家目录隔离）=====
  var prevHome = process.env.HOME
  var hadHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME')
  process.env.HOME = home

  // ===== 虚拟时钟 =====
  var now = 0
  var seq = 0
  var timers = [] // { id, at, every(0=once), cb, cancelled }
  function schedule(at, every, cb) { var t = { id: ++seq, at: at, every: every || 0, cb: cb, cancelled: false }; timers.push(t); return t }
  function flushMacro(turns) { // 让 promise 连续体与 fs 回调起跑（不定长 I/O 的链尾由 waitFor 收敛）
    var p = Promise.resolve()
    for (var i = 0; i < (turns || 6); i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r) }) })
    return p
  }
  var clock = {
    now: function () { return now },
    pendingCount: function () { return timers.filter(function (t) { return !t.cancelled }).length },
    // 推进虚拟时间：按到期顺序触发，interval 自动续挂；每触发一个让出一次宏任务
    advance: async function (ms) {
      var target = now + ms
      for (;;) {
        var next = null
        for (var i = 0; i < timers.length; i++) {
          var t = timers[i]
          if (t.cancelled || t.at > target) continue
          if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t
        }
        if (!next) break
        now = next.at
        if (next.every > 0) next.at = now + next.every
        else next.cancelled = true
        try { next.cb() } catch (e) { console.error('[mock-ctx] 定时器回调异常:', String(e)) }
        await flushMacro(3)
      }
      now = target
      await flushMacro(6)
    },
    // 手动触发一次心跳（interval 回调），不动虚拟时间、不改 interval 的既有排程
    tick: async function () {
      var cbs = []
      for (var i = 0; i < timers.length; i++) { var t = timers[i]; if (!t.cancelled && t.every > 0) cbs.push(t.cb) }
      for (var j = 0; j < cbs.length; j++) { try { cbs[j]() } catch (e) { console.error('[mock-ctx] 心跳回调异常:', String(e)) } }
      await flushMacro(6)
    },
  }
  var timer = {
    // 双形态：timeout(ms)→Promise（去抖/聚合/硬超时 race）；timeout(cb, ms)→dispose（软超时臂）
    timeout: function (a, b) {
      if (typeof a === 'function') {
        var t1 = schedule(now + (typeof b === 'number' ? b : 0), 0, a)
        return function () { t1.cancelled = true }
      }
      var ms = typeof a === 'number' ? a : 0
      return new Promise(function (resolve) { schedule(now + ms, 0, function () { resolve() }) })
    },
    interval: function (fn, ms) {
      var t2 = schedule(now + (typeof ms === 'number' ? ms : 0), typeof ms === 'number' ? ms : 0, fn)
      return function () { t2.cancelled = true }
    },
  }

  // ===== 剧本化 subagents =====
  var runs = []
  var continuables = []
  var sendMessages = []
  var interrupts = []
  var children = []
  var runSeq = 0
  var childSeq = 0
  function makeRun(provider, req) {
    var settle = {}
    var result = new Promise(function (res, rej) { settle.res = res; settle.rej = rej })
    var run = {
      id: 'run-' + (++runSeq),
      provider: provider,
      req: req, // { label, prompt, parent, signal, agentOptions? }——label 形如 'worker:task-x' / 'verifier:task-x'
      result: result,
      disposed: false,
      localAgent: { // doIntervene 通道句柄：steer/followup 记录器
        steered: [],
        followed: [],
        steer: function (m) { this.steered.push(m) },
        followup: function (m) { this.followed.push(m) },
      },
      dispose: async function () { run.disposed = true },
      // 测试驱动结局：resolveWith('文本') = 正常完成（outputText 可指定）；failWith(e) = run 失败
      resolveWith: function (text, stopReason) { settle.res({ output: [{ type: 'text', text: text || '' }], stopReason: stopReason || 'completed' }) },
      failWith: function (err) { settle.rej(err instanceof Error ? err : new Error(String(err))) },
    }
    runs.push(run)
    return run
  }
  var subagents = {
    list: function () { return ['mock-provider'] },
    getProvider: function () { return { inheritsParentContext: false } },
    start: async function (provider, req) { return makeRun(provider, req) },
    startContinuable: async function (o) {
      var c = { childId: 'child-' + (++childSeq), messageId: 'm' + childSeq, label: o && o.label, request: o && o.request }
      continuables.push(c)
      return c
    },
    sendMessage: async function (parent, childId, content) { sendMessages.push({ parent: parent, childId: childId, content: content }); return { ok: true } },
    interrupt: function (childId, authority) { interrupts.push({ childId: childId, authority: authority }) },
    listChildren: async function () { return children },
  }

  // ===== agents（缺省单 root；actor 可改写模拟子代理/其他会话身份）=====
  var sent = []
  var root = {
    id: sid,
    session: { id: sid, header: { cwd: cwd } },
    followup: function (m) { sent.push(m) },
    // whenIdle 刻意不实现：flushReceipts 走「无空闲门控 → 立即投递」分支（45s 窗口到点即投，可断言）
  }
  var env // 前向引用（currentInitiator 读 env.actor）
  var rootsList = [root] // 活跃 root 集（测试可 env.setRoots([]) 清空模拟「休眠根会话」）
  var persistedHeaders = {} // 持久会话表 sid → SessionHeader（测试可写 parentSession 模拟子会话/根会话）
  persistedHeaders[sid] = { id: sid, parentSession: undefined }
  var agents = {
    currentInitiator: function () { return { id: env.actor } },
    roots: function () { return rootsList },
    list: function () { return rootsList.slice() },
    get: function (id) { for (var i = 0; i < rootsList.length; i++) { if (String(rootsList[i].id) === String(id)) return rootsList[i] } return undefined },
    isOwnedBy: function () { return false },
  }

  // ===== tools / webServer / systemPrompt / llm / effect / on =====
  var tools = new Map()
  var routes = []
  var spSections = []
  var llmCalls = { listProviders: 0, listModels: [] }
  var disposers = []
  var listeners = {} // event -> Set<fn>

  var ctx = {
    fs: {}, // store 层走 node:fs 直读写（家目录绝对路径），fs 服务只是占位——保留键位对齐真实契约
    timer: timer,
    subagents: subagents,
    agents: agents,
    tools: { register: function (t) { tools.set(t.name, t) } },
    webServer: {
      register: function (r) {
        routes.push(r)
        return function () { var i = routes.indexOf(r); if (i >= 0) routes.splice(i, 1) }
      },
    },
    get: function (name) {
      if (name === 'systemPrompt') {
        return {
          sections: spSections,
          section: function (spec) { spSections.push(spec); return function () { var i = spSections.indexOf(spec); if (i >= 0) spSections.splice(i, 1) } },
        }
      }
      if (name === 'llm') {
        return {
          listProviders: function () { llmCalls.listProviders++; return [] },
          listModels: async function (p) { llmCalls.listModels.push(p); return [] },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          stat: async function (id) { var h = persistedHeaders[id]; return h ? { header: h } : undefined },
        }
      }
      return undefined
    },
    effect: function (fn) {
      var d
      if (typeof fn === 'function') d = fn()
      if (typeof d === 'function') disposers.push(d)
      return function () {}
    },
    on: function (event, fn) {
      if (!listeners[event]) listeners[event] = new Set()
      listeners[event].add(fn)
      return function () { listeners[event].delete(fn) }
    },
  }

  env = {
    ctx: ctx,
    sid: sid,
    home: home,
    cwd: cwd,
    clock: clock,
    tools: tools,
    runs: runs,
    continuables: continuables,
    sendMessages: sendMessages,
    interrupts: interrupts,
    children: children,
    sent: sent,
    root: root,
    spSections: spSections,
    llm: llmCalls,
    actor: sid,
    setRoots: function (list) { rootsList = list || [] }, // 清空/改写活跃 root 集（模拟休眠/重建窗口）
    persistedHeaders: persistedHeaders, // 持久会话表（sid → { id, parentSession }）；写 parentSession 模拟子会话

    // 以真 RPC 语义调用捕获的 webServer 路由（POST /dsh-agent-board → readBody → handlers[method]）
    rpc: async function (method, args) {
      var route = routes[0]
      if (!route) throw new Error('webServer 路由未注册（apply 未跑？）')
      var req = Readable.from([Buffer.from(JSON.stringify({ method: method, args: args || {} }), 'utf8')])
      req.method = 'POST'
      var res = {
        statusCode: 0, body: '',
        setHeader: function () {},
        writeHead: function (c) { res.statusCode = c },
        end: function (s) { res.body = s },
      }
      await route.handler(req, res)
      return JSON.parse(res.body)
    },

    // 重放 host 事件 agent/status（continuable Worker 的 turn 结算触发器：先 running 后 idle）
    emitStatus: function (childId, status) {
      var set = listeners['agent/status']
      if (!set) return
      set.forEach(function (fn) { fn({ agent: { session: { id: childId } }, status: status }) })
    },

    board: function () {
      try { return JSON.parse(fs.readFileSync(path.join(home, '.dsh', 'tasks-' + sid + '.json'), 'utf8')) } catch (_) { return null }
    },
    task: function (id) {
      var d = env.board()
      return d && d.tasks.find(function (t) { return t.id === id })
    },
    patchBoard: function (fn) {
      var p = path.join(home, '.dsh', 'tasks-' + sid + '.json')
      var d = JSON.parse(fs.readFileSync(p, 'utf8'))
      fn(d)
      fs.writeFileSync(p, JSON.stringify(d), 'utf8')
    },
    lastRun: function (labelPrefix) {
      for (var i = runs.length - 1; i >= 0; i--) { if (runs[i].req && String(runs[i].req.label).indexOf(labelPrefix) === 0) return runs[i] }
      return undefined
    },

    // 真实时间轮询收敛：异步链（读盘→持锁→写盘→spawn→落卡）的终点不定长，按条件等到为止
    waitFor: async function (fn, label, timeoutMs) {
      var t0 = Date.now()
      var cap = timeoutMs || 5000
      for (;;) {
        var v
        try { v = await fn() } catch (_) { v = null }
        if (v) return v
        if (Date.now() - t0 > cap) throw new Error('waitFor 超时（' + cap + 'ms）: ' + (label || '(未命名条件)'))
        await new Promise(function (r) { setTimeout(r, 5) })
      }
    },

    cleanup: async function () {
      for (var i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (_) {} }
      for (var j = 0; j < timers.length; j++) timers[j].cancelled = true
      if (hadHome) process.env.HOME = prevHome
      else delete process.env.HOME
      try { fs.rmSync(home, { recursive: true, force: true }) } catch (_) {}
    },
  }
  return env
}
