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
export { findRunLog, readRunUsage, aggregateUsageSummary, effectiveTokens, taskEffectiveTokens, readMainWindowUsage, sizeBucketOf, runRoleOf, auditRunEntry, auditRunsCompleteness, attributeRejection, buildScoreboard, SCOREBOARD_MIN_SAMPLE, SIZE_BUCKET_SMALL_MAX, SIZE_BUCKET_MEDIUM_MAX, clusterRejections, REJECTION_CLUSTER_RULES, modelPerfHint, MODEL_HINT_MIN_RUNS, MODEL_HINT_MIN_PASS, MODEL_HINT_EFF_GAP, qualityChangeHints, QUALITY_CHANGE_PP, QUALITY_MIN_SAMPLE, QUALITY_WINDOW_DAYS } from './lib/usage.mjs'
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
      activeRuns: {},      // sid -> { taskId: { id, run, role, taskId, startedAt, model, settled, continuable?, childId?, ran? } }
                           //   id = 该次 run 的子会话 id（一次性=run.id，continuable=childId，语义统一）；
                           //   continuable Worker 无 run（持久子会话），turn 结算靠 agent/status 事件见 dispatch.mjs
      dispatchedEver: {},  // sid -> { runId: true }（回执判定：区分派发执行 vs 主窗口手动）
      reconcileDone: {},   // sid -> true（可续跑 Worker 重启 reconcile 的 per-host 一次性标记，见 dispatch.mjs）
      badModels: {},       // 模型熔断坏名单（sid|model → true）
      escNotifyTimers: {}, // 歧义通知 25s 去抖（同任务新调度顶替旧调度）
      receiptBuf: {},      // 回执 45s/满 5 条聚合窗口
      receiptedKeys: {},   // 回执幂等去重（完成事件指纹，1h TTL）
      sysNotesBuf: {},     // 系统级异常通知队列（随回执冲刷）
      mainWindowUsageCache: {}, // 主窗口消耗增量尾读缓存（task-muwsol23）：sid → { size, mtimeMs, 聚合五分量+byDay }，
                                //   文件不变零读 / 变大只读增量 / 变小全量重读一次；纯内存不落盘，重启自然全量一次
      scoreboardCache: {},      // 记分卡聚合缓存（task-muxhtgh9 卡2）：sid → { taskCount, stamp, recs }，
                                //   runs 只增不改——键=(任务数, 最新落定时刻) 命中则提取层零重算，范围裁剪在装配层现算；
                                //   纯内存不落盘，重启自然全量一次（与 mainWindowUsageCache 同生命周期纪律）
      poolHealth: {},      // 运行时健康自检（task-muxhrkbg）内存心跳：sid → { bornAt, poolLastOkAt, dispatchOk,
                           //   lastDispatchAt, settleLastOkAt, reapNote }——dispatch.mjs 在 poolCycle 成功轮 /
                           //   settleRunRecord 成功结算 / 幽灵回收 >0 / spawn 成功四处打点，rpc get-tasks 现算
                           //   运行时 hint（health.computeRuntimeHealthHints）。纯内存不落盘：重启后 bornAt 起算，
                           //   心跳阈值的宽限期随之重置（心跳的意义是「host 活着时在不在转」，跨重启无继承价值）
    }
    // ===== 模块接线（依赖顺序：session → store → notify → dispatch → rpc）=====
    var session = createSession(ctx, state)
    // poolCycle 晚绑定：store.kickCycle → dispatch.poolCycle，而 dispatch 依赖 store——循环经晚绑定解开。
    // kickCycle 只在写盘后触发（工具/RPC/心跳，全部发生在 apply 完成之后），null 占位无调用窗口。
    var storeDeps = { sessionCwd: session.sessionCwd, poolCycle: null }
    var store = createStore(ctx, state, storeDeps)
    var notify = createNotify(ctx, state, { rt: store.rt, rootForSession: session.rootForSession, withTimeout: session.withTimeout, isDispatched: session.isDispatched })
    storeDeps.notifyBoardCorrupt = notify.notifyBoardCorrupt // 晚绑定收口（腐坏隔离/抢救通知；store.rt 只在 apply 完成后才触发）
    var dispatch = createDispatch(ctx, state, {
      rt: store.rt, wt: store.wt, mutateLocked: store.mutateLocked, kickCycle: store.kickCycle,
      rootForSession: session.rootForSession,
      // sessionCwd 不再注入 dispatch（预研清单瘦身后派发侧不读盘）；rpc 侧仍需要（epic 预检路径存在性）
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
      // 上报通道结算入口（task-muwkhqf8）：board_report/board_verdict 把任务推进到落定态时，
      // 由 rpc 侧顺手对「该任务当前的 continuable Worker rec」补做收尾三件套
      // （关 run 结局 / usage 落账 / 摘超时臂）——治「工具上报完成后 idle 事件没到 → run 永远 running」。
      reportRunSettled: dispatch.settleReportedRun,
      hasActiveRun: hasActiveRun,
    })

    console.log('[task-board] v74 loaded (pool removed: one-shot dispatch, context injected per task, dispose on settle)')
}
