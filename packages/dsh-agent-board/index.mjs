// dsh-agent-board — Agent 任务看板（host 端）
// 本文件即源码，直接维护（v68 起：变形层已拆除，不再从其他文件生成）。
//
// ===== 模块地图（Phase 2 模块化：薄壳入口 + 领域模块，行为零变化纯搬迁）=====
//   index.mjs        薄壳：cordis 契约（name/inject/apply）+ 共享 state 构建 + 模块接线 + 兼容 re-export
//   lib/core.mjs     纯逻辑核心（状态机/依赖校验/管线分类/prompt 构建/输出解析/派发决策）——不依赖 ctx/IO
//   lib/policy.mjs   策略层：任务粒度治理（软闸门）+ 学习飞轮候选教训（纯函数零状态）
//   lib/usage.mjs    Token 消耗统计：v4 会话日志定位/分帧/usage 聚合（纯函数 + node 模块）
//   lib/session.mjs  会话层：agent 归属解析/会话 id 归一/工作模式派生/活跃 run 表访问
//   lib/store.mjs    持久化层：看板读写/原子落盘/跨重启继承/文件锁/mutateLocked
//   lib/notify.mjs   通知层：歧义去抖通知/回执聚合/系统异常队列/makeMsg
//   lib/dispatch.mjs 派发引擎：spawnOneShot/settleRun/poolCycle/心跳/systemPrompt 注入
//   lib/rpc.mjs      接线层：task_* 工具注册 + RPC 方法表 + /dsh-agent-board 路由
// 共享闭包状态全部收进 apply 内的显式 state 对象，逐模块经参数注入（禁止跨模块隐式引用）。
//
// 兼容 re-export：对外导出契约不变（单测与历史引用直接 import 自本文件）。
export { TASK_SIZE_CONTRACT, SUGGEST_SPLIT_TEXT, TEAM_SPLIT_RULE, suggestSplitOf, withSplitHint, splitRuleOf } from './lib/policy.mjs'
export { findRunLog, readRunUsage, aggregateUsageSummary, effectiveTokens, taskEffectiveTokens } from './lib/usage.mjs'
import { createSession } from './lib/session.mjs'
import { createStore } from './lib/store.mjs'
import { createNotify } from './lib/notify.mjs'
import { createDispatch } from './lib/dispatch.mjs'
import { createRpc } from './lib/rpc.mjs'

export const name = 'dsh-agent-board'
export const inject = ['fs', 'timer', 'subagents', 'agents', 'tools', 'webServer']

export function apply(ctx) {
    // ===== 共享运行时状态（显式构建，逐模块注入；原 apply 闭包变量纯搬迁）=====
    var state = {
      handlers: {},        // RPC 方法表：rpc.mjs handle() 注册，webServer 路由按 method 查找
      knownSessions: {},   // 心跳驱动的会话集合（>30 分钟无活跃淘汰）
      teamModeCache: {},   // rt()/set-*-mode 同步，systemPrompt 引导段读取
      feedbackCache: {},   // 学习飞轮开关缓存（rt()/set-board-config 同步）
      epicSplitCache: {},  // 史诗拆分总开关缓存（rt()/set-board-config 同步，Team 引导段读取）
      fileLocks: {},       // 每会话一条 promise 链，串行化所有 读-改-写
      cyclePending: {},    // kickCycle 50ms 去抖
      activeRuns: {},      // sid -> { taskId: { run, role, taskId, startedAt, model } }
      dispatchedEver: {},  // sid -> { runId: true }（回执判定：区分派发执行 vs 主窗口手动）
      badModels: {},       // 模型熔断坏名单（sid|model → true）
      packByChild: {},     // 预研文件注入缓存（按子代理会话 id）
      pendingPacks: [],    // 首轮竞速认领队列（start() 返回前的首次 prompt 组装）
      escNotifyTimers: {}, // 歧义通知 25s 去抖（同任务新调度顶替旧调度）
      receiptBuf: {},      // 回执 45s/满 5 条聚合窗口
      receiptedKeys: {},   // 回执幂等去重（完成事件指纹，1h TTL）
      sysNotesBuf: {},     // 系统级异常通知队列（随回执冲刷）
    }
    // ===== 模块接线（依赖顺序：session → store → notify → dispatch → rpc）=====
    var session = createSession(ctx, state)
    // poolCycle 晚绑定：store.kickCycle → dispatch.poolCycle，而 dispatch 依赖 store——循环经晚绑定解开。
    // kickCycle 只在写盘后触发（工具/RPC/心跳，全部发生在 apply 完成之后），null 占位无调用窗口。
    var storeDeps = { sessionCwd: session.sessionCwd, poolCycle: null }
    var store = createStore(ctx, state, storeDeps)
    var notify = createNotify(ctx, state, { rt: store.rt, rootForSession: session.rootForSession, withTimeout: session.withTimeout, isDispatched: session.isDispatched })
    var dispatch = createDispatch(ctx, state, {
      rt: store.rt, wt: store.wt, mutateLocked: store.mutateLocked, kickCycle: store.kickCycle,
      rootForSession: session.rootForSession, sessionCwd: session.sessionCwd,
      withTimeout: session.withTimeout, runsFor: session.runsFor, feedbackOn: session.feedbackOn, epicSplitOn: session.epicSplitOn,
      pushSysNote: notify.pushSysNote, maybeNotify: notify.maybeNotify, notifyTaskDone: notify.notifyTaskDone,
      notifyDispatched: notify.notifyDispatched,
    })
    storeDeps.poolCycle = dispatch.poolCycle // 晚绑定收口
    // 僵尸 epic 出清配套（反馈 n-mutma3mmwceq）：archive-task 门禁的活性判定。
    // 口径：runsFor 表内有记录且未 settled 即活跃。settleRun/手动终止都会摘除表项；
    // settled=true 是 finish→settleRun 的结算过渡窗口（Worker 已结束），视为不活跃放行。
    function hasActiveRun(sid, taskId) { var rec = session.runsFor(sid)[taskId]; return !!(rec && !rec.settled) }
    createRpc(ctx, state, {
      getActorId: session.getActorId, resolveRoot: session.resolveRoot, toolSessionId: session.toolSessionId, rpcSessionId: session.rpcSessionId,
      rootForSession: session.rootForSession, deriveWorkMode: session.deriveWorkMode, runsFor: session.runsFor,
      rt: store.rt, mutateLocked: store.mutateLocked,
      maybeNotify: notify.maybeNotify, notifyTaskDone: notify.notifyTaskDone,
      pushSysNote: notify.pushSysNote, sessionCwd: session.sessionCwd, // 调研门禁③：epic 发布预检汇总投递 + 预研路径相对解析根
      spawnOneShot: dispatch.spawnOneShot, accumulateRunUsage: dispatch.accumulateRunUsage, readContextPack: dispatch.readContextPack,
      hasActiveRun: hasActiveRun,
    })

    console.log('[task-board] v74 loaded (pool removed: one-shot dispatch, context injected per task, dispose on settle)')
}
