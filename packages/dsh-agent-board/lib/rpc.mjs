// dsh-agent-board — RPC 与工具接线层（lib/rpc.mjs）
// createRpc(ctx, state, deps)：task_* 工具注册（cordis tools 契约）+ client↔host RPC 方法表 +
// POST /dsh-agent-board 路由。工具名 / RPC 方法名 / 参数与返回体形态全部保持原契约（纯搬迁）。
// 零外部依赖：link: 安装的包从真实路径解析，裸 import '@deepseek-ai/dsh-tools'
// 会解析失败（ERR_MODULE_NOT_FOUND）。defineTool 本体只是 校验+包装 出
// {name, description, parameters, output, execute} 普通对象，这里内联等价实现。
// parameters 已是完整 JSON Schema，原样透传；output 透传 schema+render。
import * as core from './core.mjs'
import path from 'node:path'
import fsNode from 'node:fs'
import { findRunLog, readLogBytes, readLogFrames, aggregateUsageSummary } from './usage.mjs'
import { TASK_SIZE_CONTRACT, withSplitHint, pushRejectLesson, pushArbitrationLesson } from './policy.mjs'
import { makeMsg } from './notify.mjs'
import { computeHealthHints } from './health.mjs'
import { isFullSessionId } from './session.mjs' // 幻影板防线口径（纯函数，与 policy.mjs 直引同例）
const { ah, isb, gsb, gpt, vt, validateDeps, classifyPipeline, cfg, claimCheck, claimApply, resolveApply, verifyApply, PRIO_RANK, touchesConflict, holdsFiles, boardHome, aggregateChildStats, createTaskWarnings, epicPrecheck, epicPrecheckNote, attachContextSuggestions, REJECT_REDISPATCH_HINT, tasksHash, normalizeHooks, mergeHooks, pushRejection } = core

function defineTool(options) {
  var userExecute = options.execute
  var userRender = options.output && options.output.render
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: userRender ? function (args, value) { return userRender(args, value) } : undefined,
    },
    execute: function (args, exec) { return userExecute(args, exec) },
  }
}

    function jo() { return { schema: { type: 'object', additionalProperties: true }, render: function (a, v) { return [{ type: 'text', text: JSON.stringify(v, null, 2) }] } } }
    // touches（文件级排他声明）归一化：非字符串项过滤掉，空数组 = 不声明（无锁语义）。
    // 上限 20 条，与 contextFiles 上限一致，防止 prompt/看板文件被超长清单撑爆。
    function normTouches(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x.trim() }).slice(0, 20).map(function (x) { return x.trim() }) : [] }

export function createRpc(ctx, state, deps) {
    // deps：session/store/notify/dispatch 各模块公共 API（index.mjs 接线注入）
    var getActorId = deps.getActorId, resolveRoot = deps.resolveRoot, toolSessionId = deps.toolSessionId, rpcSessionId = deps.rpcSessionId
    var rootForSession = deps.rootForSession, deriveWorkMode = deps.deriveWorkMode, runsFor = deps.runsFor
    var rt = deps.rt, mutateLocked = deps.mutateLocked
    var maybeNotify = deps.maybeNotify, notifyTaskDone = deps.notifyTaskDone
    var spawnOneShot = deps.spawnOneShot, accumulateRunUsage = deps.accumulateRunUsage, readContextPack = deps.readContextPack
    var pushSysNote = deps.pushSysNote, sessionCwd = deps.sessionCwd // 调研门禁③：epic 发布预检的投递通道与路径解析根
    // 僵尸 epic 出清（反馈 n-mutma3mmwceq）：archive 门禁的活性判定由 index.mjs 接线注入
    // （runsFor(sid)[taskId] 存在且 !settled 即活跃）。未注入时按「有活跃 run」兜底——
    // 保守保持旧门禁行为（in-progress 一律拒归档），绝不因缺依赖误放走在跑的任务。
    var hasActiveRun = typeof deps.hasActiveRun === 'function' ? deps.hasActiveRun : function () { return true }
    // archive 门禁（archive-task RPC 与 task_archive 工具同一口径，返回错误串或 null 放行）：
    //   resolved / cancelled         → 放行（既有行为）
    //   in-progress 且无活跃 run     → 放行（parentKick 僵尸态出清：direct epic 被
    //     parentKickOnDispatch 推进到 in-progress 后子任务已归档、无 run、claimedBy=null，
    //     此前 archive（非 resolved/cancelled）与 resolve（not claimed by you）双拒，
    //     只能 resetToPending→delete 三段舞）
    //   in-progress 有活跃 run / 其余状态 → 拒绝
    function archiveErr(sid, t) {
      if (t.status === 'resolved' || t.status === 'cancelled') return null
      if (t.status === 'in-progress' && !hasActiveRun(sid, t.id)) return null
      return 'cannot archive'
    }
    // 共享状态别名（本体由 index.mjs apply 统一构建并逐模块注入）
    var teamModeCache = state.teamModeCache
    var feedbackCache = state.feedbackCache
    var epicSplitCache = state.epicSplitCache
    // RPC handlers 表必须在最前面初始化：后面的 handle(...) 调用依赖它（var 只提升声明不提升赋值）
    var handlers = state.handlers
    function handle(method, fn) { handlers[method] = fn }

    // ===== 调研门禁③配套：epic 发布预检 =====
    // 路径存在性判定：相对路径按「该会话工作区」解析（与 readContextPack 同根，不靠进程 cwd）；
    // existsSync 同步轻量，只在 publish 时跑一遍（每子任务 ≤20 条路径，不读全文）。
    function existsInSession(sid) {
      var cwd = typeof sessionCwd === 'function' ? sessionCwd(sid) : ''
      return function (p) { try { return fsNode.existsSync(path.isAbsolute(p) ? p : (cwd ? path.join(cwd, p) : p)) } catch (_) { return false } }
    }
    // 预检有缺失才 pushSysNote 汇总给主窗口；全部有材料不打扰（响应体同样不挂字段）。锁外调用，不拖长写锁。
    function afterPublishPrecheck(sid, taskId, result) {
      var pre = result && result.ok && result.epicPrecheck
      if (!pre || !pre.missing || !pre.missing.length) return
      if (typeof pushSysNote === 'function') pushSysNote(sid, epicPrecheckNote(pre), taskId)
    }

    // ===== hooks（史诗 hooks=agent run）只许主窗口设置 =====
    // 工具任务链早已有「看板管理工具仅主窗口可用」门禁（resolveRoot(actor) === actor），这里单独再拦一道：
    // hooks 是高权限入口（会 spawn 真的 agent run 去动代码/跑收口），RPC 通道同样只放行主窗口。
    var HOOKS_MAIN_ONLY = 'hooks 仅主窗口可设（子代理无 hooks 权限）'
    function hooksDenied(actor) { return resolveRoot(actor) !== actor }
    // hooks 浅校验 + 与既有值浅合并；返回 { hooks } 或 { error }（口径唯一在 core.normalizeHooks）。
    // 传 hooks=null 表示整体清除；传 { pre: null } 表示只撤 pre 点位；未提交的点位保留原值。
    function applyHooks(target, incoming) {
      var n = normalizeHooks(incoming)
      if (n.error) return n
      var merged = mergeHooks(target.hooks, n.hooks)
      if (Object.keys(merged).length) target.hooks = merged
      else delete target.hooks
      return { ok: true }
    }

    // ===== Tools =====
    ctx.tools.register(defineTool({ name: 'task_list', description: '列出当前会话任务。', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in-progress', 'verifying', 'resolved', 'blocked', 'cancelled'] }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, tag: { type: 'string' }, parentId: { type: 'string' }, includeArchived: { type: 'boolean' }, limit: { type: 'number' } }, required: [] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var d = await rt(sid); var a = d.tasks; var ts = a; if (!args.includeArchived) ts = ts.filter(function (x) { return x.status !== 'archived' }); if (args.status) ts = ts.filter(function (x) { return x.status === args.status }); if (args.priority) ts = ts.filter(function (x) { return x.priority === args.priority }); if (args.tag) ts = ts.filter(function (x) { return (x.tags || []).indexOf(args.tag) >= 0 }); if (args.parentId === 'null') ts = ts.filter(function (x) { return !isb(x) }); else if (args.parentId) ts = ts.filter(function (x) { return x.parentId === args.parentId }); var po = PRIO_RANK; ts.sort(function (a, b) { var dd = (po[b.priority] || 0) - (po[a.priority] || 0); return dd !== 0 ? dd : (a.createdAt || '').localeCompare(b.createdAt || '') }); var lim = Math.min(args.limit || 20, 100); var res = ts.slice(0, lim).map(function (x) { var e = Object.assign({}, x); if (isb(x)) { var p = gpt(x, a); if (p) e.parentSummary = { id: p.id, title: p.title, status: p.status } }; var ch = gsb(x.id, a); if (ch.length) { e.subtaskCount = ch.length; e.subtaskResolved = ch.filter(function (y) { return y.status === 'resolved' }).length }; return e }); var out = { tasks: res, total: ts.length, session: sid, actor: getActorId(), boardMode: d.boardMode || 'auto', teamMode: !!d.teamMode, poolStatus: d.poolStatus }; if (d.teamMode) out.teamHint = 'Team 模式已开启：实质性改动请优先 task_create 提交看板由池执行；调研/读取/讨论可直接进行；Worker 歧义会上报等你裁决。'; return out } }))
    ctx.tools.register(defineTool({ name: 'task_context', description: '获取任务完整上下文。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, expandFiles: { type: 'boolean' }, includeParent: { type: 'boolean' }, includeSubtasks: { type: 'boolean' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var d = await rt(sid); var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found: ' + args.taskId }; return { ok: true, context: { task: t, inheritedContext: t.context || {} } } } }))
    ctx.tools.register(defineTool({ name: 'task_preview_context', description: '派发前上下文预览：预演 task_create 的 contextFiles/contextNotes 将注入给子代理的实际内容（读盘后的最终形态），用于确认材料是否足够。不创建任务。返回 ok=false/empty=true 说明无可注入内容。', parameters: { type: 'object', properties: { contextFiles: { type: 'array', items: { type: 'string' }, description: '预演的文件路径列表' }, contextNotes: { type: 'string', description: '预演的调研笔记' } }, required: [] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var files = Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : []; var notes = typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : ''; if (!files.length && !notes.trim()) return { ok: false, error: 'contextFiles/contextNotes 至少提供一个' }; try { var pack = await readContextPack(sid, { context: { files: files, notes: notes } }); return { ok: true, empty: !pack, pack: pack } } catch (e) { return { ok: false, error: String(e).slice(0, 200) } } } }))
    ctx.tools.register(defineTool({ name: 'task_claim', description: '领取待办任务→in-progress。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var err = claimCheck(d, t, actor); if (err) return { ok: false, error: err }; claimApply(d, t, actor, args.reason || 'claimed'); return { ok: true, task: t, context: { task: t, inheritedContext: t.context || {} } } }) } }))
    ctx.tools.register(defineTool({ name: 'task_resolve', description: '提交验证(verifying)或阻塞(blocked)。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string', enum: ['verifying', 'blocked'] }, resolution: { type: 'string' } }, required: ['taskId', 'status'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress' }; if (t.claimedBy !== actor) return { ok: false, error: 'not claimed by you' }; if (args.status === 'verifying' && !args.resolution) return { ok: false, error: 'resolution required' }; return resolveApply(d, t, actor, args.status, args.resolution, args.resolution || args.status) }) } }))
    ctx.tools.register(defineTool({ name: 'task_verify', description: '验收：approved→resolved，rejected→in-progress。子任务全完成父任务自动verifying。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'rejected'] }, comment: { type: 'string' } }, required: ['taskId', 'verdict'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'verifying') return { ok: false, error: 'not verifying' }; var __vr = verifyApply(d, t, actor, args.verdict, args.comment); if (args.verdict === 'rejected') { t.verification = { verdict: 'rejected', summary: args.comment || '', checks: '', at: new Date().toISOString(), by: actor }; pushRejection(t, args.comment, '', t.verification.at, actor); __vr.hint = REJECT_REDISPATCH_HINT } return __vr }) } }))
    ctx.tools.register(defineTool({ name: 'task_archive', description: '归档已解决/已取消任务（无活跃 run 的 in-progress 僵尸卡也可归档，用于 parentKick 僵尸态出清）。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { var a = d.tasks; var t = a.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var __ae = archiveErr(sid, t); if (__ae) return { ok: false, error: __ae }; var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'archived'); var ca = 0; gsb(t.id, a).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } }); var r = { ok: true, task: t }; if (ca) r.childrenArchived = ca; return r }) } }))
    ctx.tools.register(defineTool({ name: 'task_update', description: '更新任务字段，可选重置为 pending。dependsOn/pipeline 也可更新（环检测会拒绝成环依赖）。contextFiles 可更新预研文件清单。unfreeze:true 解除裁决挂起冻结（frozen）并触发派发。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, assignMode: { type: 'string', enum: ['auto', 'manual'] }, assignee: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, contextFiles: { type: 'array', items: { type: 'string' }, description: '预研文件路径（替换式更新），派发时经上下文注入传给子代理' }, contextNotes: { type: 'string', description: '预研笔记（替换式更新）：调研结论/原始需求/思路' }, pipeline: { type: 'string', enum: ['full', 'work', 'direct'] }, resetToPending: { type: 'boolean' }, unfreeze: { type: 'boolean', description: '解除冻结（frozen）并立即触发派发，用于 hold 裁决补完上下文后重新入池' }, publish: { type: 'boolean', description: '发布草稿为 pending（仅 draft 状态有效）' }, hooks: { type: 'object', additionalProperties: true, description: '史诗 hook 点位（仅主窗口可设）：{ pre?: { enabled?, prompt }, post?: { enabled?, prompt } } —— hook 点=一次真实 agent 运行（不是声明式命令）：pre 在子任务派发前跑一遍前置准备（未完成前该 epic 的子任务一张都不派），post 在全部子任务了结后跑一遍收口（完成后 epic 才转 verifying）。prompt 是薄框架契约（做什么由 hook agent 判断，吃不准会歧义上报）。传 null 清除，传 { pre: null } 只撤该点位。' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (args.hooks !== undefined && resolveRoot(__ra) !== __ra) return { ok: false, error: 'hooks 仅主窗口可设（子代理无 hooks 权限）' }; if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); var existsFn = existsInSession(sid); var __res = await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var __pre = null; if (args.title !== undefined) t.title = args.title; if (args.description !== undefined) t.description = args.description; if (args.priority !== undefined) t.priority = args.priority; if (args.assignMode !== undefined) t.assignMode = args.assignMode; if (args.assignee !== undefined) t.assignee = args.assignee || null; if (args.dependsOn !== undefined) { var derr = validateDeps(d, t.id, args.dependsOn); if (derr) return { ok: false, error: derr }; t.dependsOn = args.dependsOn } if (args.pipeline !== undefined) { t.pipeline = args.pipeline; t.pipelineAuto = false } if (args.contextFiles !== undefined) { if (!t.context) t.context = { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' }; t.context.files = Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : [] } if (args.contextNotes !== undefined) { if (!t.context) t.context = { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' }; t.context.notes = typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : '' } if (args.publish) { if (t.status !== 'draft') return { ok: false, error: 'not a draft' }; t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'published'); /* 调研门禁③：发布的是 epic（有子任务）时轻量预检子任务调研注入，缺失挂返回值由锁外 pushSysNote 汇总 */ __pre = epicPrecheck(d.tasks, t.id, existsFn) } if (args.unfreeze && t.frozen) { delete t.frozen; delete t.frozenAt; delete t.frozenBy; ah(t, t.status, t.status, actor, '解除冻结，重新进入派发池') } if (args.resetToPending) { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; t.resolvedAt = null; t.resolution = null; delete t.retryCount; delete t.stuckSince; ah(t, ps, 'pending', actor, 'reset to pending after edit') }; if (args.hooks !== undefined) { var __he = applyHooks(t, args.hooks); if (__he.error) return { ok: false, error: __he.error } }; var __out = { ok: true, task: t }; if (__pre && __pre.missing.length) __out.epicPrecheck = __pre; return __out }); afterPublishPrecheck(sid, args.taskId, __res); return __res } }))
    ctx.tools.register(defineTool({ name: 'task_create', description: '创建新任务到当前会话看板。acceptance 可选：硬性验收脚本命令（如 "node --test src/x.test.js"），Worker 必须实际运行、Verifier 必须独立复跑。dependsOn 可选：依赖任务 id 数组，依赖全部完成后才会被派发。pipeline 可选：full(默认,工作+验证)/work(只做不验)/direct(不进池，主窗口直接处理)。contextFiles 可选：你在调研中已经读过的关键文件路径数组——派发时 host 会从磁盘读取最新内容，通过「上下文注入」通道传给 Worker/Verifier（呈现为独立注入区块，不占对话流），避免子代理从零重复调研。contextNotes 可选：调研结论/原始需求/思路等非文件类上下文，同样走上下文注入。【开发类任务（涉及代码改动/修复/特性）务必带文件调研】：把调研中读过的关键文件路径放进 contextFiles、结论思路放进 contextNotes——实测可让 Worker 省去 10~15 分钟从零 grep 定位的时间，且方向感天壤之别（无调研的 Worker 只能靠标题猜需求、极易跑偏）。调研门禁：pipeline=full/work 且 touches 非空而未带调研上下文时，返回将附 warning 提示。touches 可选：本任务将要改动的文件路径/glob 数组（如 "src/x.mjs"、"src/**"）——派发器在同一时刻只派发 touches 不冲突的任务，避免并行 Worker 改同一批文件互踩；任务持有文件锁（in-progress/verifying/resolved 都持有，锁持到归档才真释放——护住验收后-提交前的提交窗口期；cancelled 立即释放）。' + TASK_SIZE_CONTRACT, parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, tags: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' }, instructions: { type: 'string' }, acceptance: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, contextFiles: { type: 'array', items: { type: 'string' }, description: '预研文件路径（相对 workspace 或绝对路径），内容将在派发时经上下文注入传给子代理' }, contextNotes: { type: 'string', description: '预研笔记：调研结论/原始需求/思路等（≤8000 字符），经上下文注入传给子代理' }, pipeline: { type: 'string', enum: ['full', 'work', 'direct'] }, touches: { type: 'array', items: { type: 'string' }, description: '本任务将改动的文件路径/glob（文件级排他锁）：与活动任务 touches 冲突时不派发，等锁释放；支持 "src/**" 目录、"./a/b.mjs"、裸文件名等写法' }, draft: { type: 'boolean', description: '创建为草稿（不派发）。Team 模式下缺省即为 true——补全 dependsOn/上下文后用 task_update publish=true 统一发布；非 Team 模式缺省 false，显式 draft:false 可跳过草稿' }, hooks: { type: 'object', additionalProperties: true, description: '史诗 hook 点位（仅主窗口可设）：{ pre?: { enabled?, prompt }, post?: { enabled?, prompt } } —— hook 点=一次真实 agent 运行（不是声明式命令）：pre 在子任务派发前跑一遍前置准备（未完成前该 epic 的子任务一张都不派），post 在全部子任务了结后跑一遍收口（完成后 epic 才转 verifying）。prompt 是薄框架契约（做什么由 hook agent 判断，吃不准会歧义上报）。传 null 清除，传 { pre: null } 只撤该点位。' } }, required: ['title'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (args.hooks !== undefined && resolveRoot(__ra) !== __ra) return { ok: false, error: 'hooks 仅主窗口可设（子代理无 hooks 权限）' }; if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; var sid = toolSessionId(); var actor = getActorId(); return mutateLocked(sid, function (d) { if (args.id && d.tasks.find(function (x) { return x.id === args.id })) return { ok: false, error: 'duplicate id: ' + args.id }; if (args.dependsOn && args.dependsOn.length) { var derr = validateDeps(d, args.id || '(pending)', args.dependsOn); if (derr) return { ok: false, error: derr } }; var now = new Date().toISOString(); /* Team 模式护栏：draft 缺省跟随 teamMode（先补齐依赖/上下文再统一 publish）；显式 draft:false 保留为立即派发的逃生门 */ var asDraft = args.draft === undefined ? !!d.teamMode : !!args.draft; var t = { id: args.id || ('task-' + Date.now().toString(36)), title: args.title, description: args.description || '', status: asDraft ? 'draft' : 'pending', priority: args.priority || 'medium', tags: args.tags || [], parentId: args.parentId || null, subtaskStrategy: null, assignMode: 'auto', assignee: null, context: { files: (Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : []), docs: [], instructions: args.instructions || '', notes: (typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : ''), relatedTasks: [], prerequisites: '' }, acceptance: args.acceptance || '', dependsOn: args.dependsOn || [], touches: normTouches(args.touches), pipeline: args.pipeline || '', claimedBy: null, claimedAt: null, createdAt: now, resolvedAt: null, verifiedAt: null, verifiedBy: null, archivedAt: null, resolution: null, waitingForTouches: null, messages: [], history: [{ from: 'created', to: asDraft ? 'draft' : 'pending', timestamp: now, actor: actor, note: asDraft ? 'created as draft' : 'created' }] }; if (args.hooks !== undefined) { var __hn = normalizeHooks(args.hooks); if (__hn.error) return { ok: false, error: __hn.error }; if (__hn.hooks && Object.keys(__hn.hooks).length) t.hooks = __hn.hooks } if (!t.pipeline) t.pipeline = classifyPipeline(t); t.pipelineAuto = !args.pipeline; d.tasks.push(t); /* 调研门禁 warning 族（与 create-task RPC 同口径，core 纯函数）：空描述/无调研上下文/整树 glob 三类软提示合并为一条（；分隔），不拦截创建 */ var __out = withSplitHint({ ok: true, task: t }, t, cfg(d).epicSplit); var __warns = createTaskWarnings(t); attachContextSuggestions(__out, __warns, t.touches, existsInSession(sid)); if (__warns.length) __out.warning = __warns.join('；'); return __out }) } }))

    // ===== RPC =====
    // get-tasks 是纯读路径（rt 只读文件）——poolCycle 由 15s 心跳 + 写入后 kickCycle 驱动，
    // 客户端 3s 轮询不再触发池计算/写盘（之前每轮询一次就 poolCycle+写盘一次，切会话时多会话轮询挤在文件锁上）
    // isRoot 现算不落盘：生成开始/结束瞬间 agents 树重建，roots() 存在瞬态窗口返回不含本 sid（假 false）。
    // host 不改行为（保持"现算真相"），防抖在客户端：kernel.js applyIsRoot——曾确认 true 的会话需连续 3 次
    // false（3s 心跳≈9s）才收抽屉；从未 true 的子代理会话仍即时收起（反馈 n-muuerxv9ijxs / task-muupr8ld）。
    handle('get-tasks', async function (args) { var sid = rpcSessionId(args); var d = await rt(sid); d.sessionId = sid; var __ag = ctx.agents; d.isRoot = true; if (__ag) { var __roots = __ag.roots(); var __rids = []; for (var __i = 0; __i < __roots.length; __i++) __rids.push(String(__roots[__i].id)); d.isRoot = __rids.indexOf(sid) >= 0 }
      // poolStatus 防幽灵：只保留指向当前活跃任务的条目（重启后内存 runs 清空，文件快照可能残留）
      if (d.poolStatus) { var __act = {}; (d.tasks || []).forEach(function (t) { if (t.status === 'in-progress' || t.status === 'verifying') __act[t.id] = true }); d.poolStatus.workers = (d.poolStatus.workers || []).filter(function (w) { return __act[w.taskId] }); d.poolStatus.verifiers = (d.poolStatus.verifiers || []).filter(function (v) { return __act[v.taskId] }) }
      // 学习飞轮 v1：把 feedbackEnabled 显式放进返回体（normalizeBoard 已按老看板补默认 true），
      // 客户端据此做能力检测——开关关闭时渲染层不生成候选、不显示「沉淀」按钮。
      d.feedbackEnabled = cfg(d).feedbackEnabled
      // 回执开关（设置区「通知」小节）同法显式透出：老 host 不返回时客户端按「缺字段=开」兜底，
      // 这里给出确定布尔值，UI 勾选态不依赖客户端各自的兜底写法。
      d.notifyDispatch = cfg(d).notifyDispatch
      d.notifyDone = cfg(d).notifyDone
      // 史诗拆分总开关（设置区「功能」小节）同法显式透出确定布尔值：老 host 不返回时客户端按「缺字段=开」兜底，
      // UI 勾选态不依赖各自兜底写法。
      d.epicSplit = cfg(d).epicSplit
      // 工作模式派生字段：UI 只读这一个字段决定三档选中态（不落盘，写入仍走 boardMode/teamMode）
      d.workMode = deriveWorkMode(d)
      // ===== board 级 token 消耗聚合（现算，不落盘）：总量 + 输入/输出/缓存读 + 按模型 + 任务 Top8 =====
      d.usageSummary = aggregateUsageSummary(d.tasks)
      // 架构自省 L1：healthHints 现算（纯函数零存储零 IO，近 50 卡窗口），客户端「架构健康」区超阈值才显示
      d.healthHints = computeHealthHints(d.tasks)
      // 史诗父卡语义层：childStats 现算（零存储）——{ <parentId>: { total, settled, resolved, active, activeTitle } }，
      // 父卡列位置/进度展示的数据源；total 含已归档子任务，settled=resolved|cancelled|archived（resolved 为
      // 兼容别名同值），因此归档子卡不会让进度分母缩水（task-muupgfot）；只有无任何子任务的父卡才不出键
      d.childStats = aggregateChildStats(d.tasks)
      // 渲染变更检测（反馈 n-mut9rzs2mkhg）：tasks 关键字段的稳定 hash（纯函数，口径见 core.tasksHash），
      // 客户端 3s 轮询 hash 相同则跳过 state.tasks 赋值 + notify——传输仍全量，省的是渲染
      d.tasksHash = tasksHash(d.tasks)
      return d })
    // 派发前上下文预览：主 agent 用它确认"我将注入给子代理的材料"是否足够（不发任务、不落盘）
    handle('preview-context', async function (args) {
      var files = Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : []
      var notes = typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : ''
      if (!files.length && !notes.trim()) return { ok: false, error: 'contextFiles/contextNotes 至少提供一个' }
      var pack = ''
      try { pack = await readContextPack(rpcSessionId(args), { context: { files: files, notes: notes } }) } catch (e) { return { ok: false, error: '读取失败: ' + String(e).slice(0, 120) } }
      return { ok: true, filesCount: files.length, notesLen: notes.length, pack: pack, empty: !pack }
    })
    // 活动心跳：读子代理会话日志的最后一帧，提取最近的动作摘要（卡片/详情页展示"现在跑到哪了"）
    handle('agent-activity', async function (args) {
      var sid = rpcSessionId(args)
      var rec = runsFor(sid)[args.taskId]
      if (!rec || !rec.run) return { ok: true, activity: null, reason: 'no active run' }
      var child = String(rec.run.id)
      try {
        // 子会话日志定位：直接扫描 ~/.dsh/sessions/*/<child>/session.vN.jsonl.zstd
        // （不再从看板路径反推 workspace——那依赖进程 cwd 凑巧等于工作区，曾是隐性 bug）
        // v0.1.7 起日志文件名带格式版本号（session.v4.jsonl.zstd），旧会话是
        // session.v3.jsonl.zstd / session.jsonl.zstd——按新到旧逐个探测。
        // 定位与分帧和 readRunUsage 共用同一套 helper（findRunLog / readLogBytes / readLogFrames）。
        var log = findRunLog(child)
        if (!log) return { ok: true, activity: null, reason: 'log not found' }
        // 只同步读末尾 2MB（日志追加写，末帧必在尾部）——整文件 readFileSync 在大日志上
        // 会造成数十毫秒级同步 I/O，多任务轮询时叠加成全局卡顿
        var buf = readLogBytes(log, 2 * 1024 * 1024)
        if (!buf) return { ok: true, activity: null, reason: 'log unreadable' }
        // 追加写多帧格式：最新事件在末帧。但末帧可能只有 step/end、turn/end 这类
        // 结算事件（v4 一帧只装一个step的增量），单解一帧经常捞不到动作 → 从新到旧
        // 最多回扫 3 帧，找到第一个动作摘要即止（成本仍受控：每帧只是一次 zstd 解压）
        var frames = readLogFrames(buf, 3)
        var activity = null
        for (var fi = 0; fi < frames.length && !activity; fi++) {
          var evs = frames[fi]
          for (var i = evs.length - 1; i >= 0 && !activity; i--) {
            var e = evs[i]
            var dta = (e && e.data) || {}
            if (e && e.type === 'tool/call' && dta.name) activity = '🔧 ' + dta.name + ' ' + String(dta.arguments || '').replace(/\s+/g, ' ').slice(0, 90)
            // v4：助手文本在 assistant/message 的 content 块里；v3 及以前是 assistant/chunk 流片
            else if (e && e.type === 'assistant/message') {
              var msg = dta.message || {}
              var blocks = Array.isArray(msg.content) ? msg.content : []
              for (var b = blocks.length - 1; b >= 0; b--) { if (blocks[b] && blocks[b].type === 'text' && String(blocks[b].text || '').trim()) { activity = '💬 ' + String(blocks[b].text).replace(/\s+/g, ' ').slice(0, 120); break } }
            }
            else if (e && e.type === 'assistant/chunk' && dta.block && dta.block.type === 'text' && dta.block.text && dta.block.text.trim()) activity = '💬 ' + dta.block.text.replace(/\s+/g, ' ').slice(0, 120)
          }
        }
        return { ok: true, activity: activity }
      } catch (e) { return { ok: true, activity: null, reason: String(e).slice(0, 80) } }
    })
    // 全局多会话总览：聚合本机所有看板的任务计数（只读，供 dashboard 跨会话视图）
    handle('list-boards', async function (args) {
      var home = boardHome()
      var out = []
      var files
      try { files = fsNode.readdirSync(home).filter(function (f) { return f.indexOf('tasks-') === 0 && f.slice(-5) === '.json' }) } catch (e) { return { ok: true, boards: [] } }
      for (var i = 0; i < files.length; i++) {
        try {
          var d = JSON.parse(fsNode.readFileSync(path.join(home, files[i]), 'utf8'))
          if (!vt(d)) continue
          var counts = { pending: 0, inProgress: 0, verifying: 0, resolved: 0, blocked: 0 }
          var titles = []
          var lastTs = ''
          d.tasks.forEach(function (t) {
            if (t.status === 'archived') return
            if (counts[t.status] !== undefined) counts[t.status]++
            if (t.status === 'in-progress' || t.status === 'verifying' || t.status === 'blocked') titles.push(t.title)
            ;(t.history || []).forEach(function (h) { if (h.timestamp > lastTs) lastTs = h.timestamp })
          })
          out.push({ session: d.ownerSession, boardMode: d.boardMode || 'auto', teamMode: !!d.teamMode, counts: counts, activeTitles: titles.slice(0, 3), lastActivity: lastTs })
        } catch (_) {}
      }
      out.sort(function (a, b) { return (b.lastActivity || '').localeCompare(a.lastActivity || '') })
      return { ok: true, boards: out }
    })
    handle('claim-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var err = claimCheck(d, t, actor); if (err) return { ok: false, error: err }; claimApply(d, t, actor, 'manual claim via board'); return { ok: true, task: t } }) })
    handle('resolve-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress' }; return resolveApply(d, t, actor, args.status, args.resolution, args.resolution || args.status) }) })
    handle('verify-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; if (t.status !== 'verifying') return { ok: false, error: 'not verifying' }; delete t.escalation; delete t.verifyRetries; var r = verifyApply(d, t, actor, args.verdict, args.comment); if (args.verdict === 'rejected') { t.verification = { verdict: 'rejected', summary: args.comment || '', checks: '', at: new Date().toISOString(), by: actor }; pushRejection(t, args.comment, '', t.verification.at, actor); pushRejectLesson(d, t, args.comment); r.hint = REJECT_REDISPATCH_HINT } return r }) })
    handle('archive-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); return mutateLocked(sid, function (d) { var a = d.tasks; var t = a.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var __ae = archiveErr(sid, t); if (__ae) return { ok: false, error: __ae }; var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'manual archive'); var ca = 0; gsb(t.id, a).forEach(function (c) { if (c.status !== 'archived') { ah(c, c.status, 'archived', actor, 'cascade'); c.status = 'archived'; c.archivedAt = new Date().toISOString(); ca++ } }); var r = { ok: true, task: t }; if (ca) r.childrenArchived = ca; return r }) })
    // ===== 任务删除通道（真删，无 undo）=====
    // 背景：archive-task 只收 resolved/cancelled，草稿/误建卡片此前没有任何下线通道（只能永远挂着）。
    // 状态门禁（delete-task 与 batch-op delete 共用本函数，保证两条入口语义完全一致）：
    //   draft / pending / blocked → 允许删（未产生任何执行痕迹，删了不丢信息）
    //   in-progress / verifying   → 拒绝，提示先 terminate-agent 终止（避免把在跑的 run 变成孤儿）
    //   resolved / cancelled      → 拒绝，引导用 archive-task（已落定任务留档可检索）
    //   archived                  → 幂等 ok（已不在活跃看板里，重复调用不报错）
    // 未归档子任务（parentId 指向本任务且 status !== 'archived'）存在时拒删：父卡一删子任务的
    // parentId 就成了悬空引用（checkParentAuto / 上下文继承都会失效），必须先处理子任务。
    // 返回 { err: '...' } 或 { mode: 'already' }；调用方按需转成各自的返回体。
    function deleteGate(d, t) {
      if (t.status === 'in-progress' || t.status === 'verifying') return { err: '任务正在执行中，请先用 terminate-agent 终止（in-progress 回待办、verifying 换 verifier 接手）再删除' }
      if (t.status === 'resolved' || t.status === 'cancelled') return { err: '已落定任务请用归档（archive-task），不要删除' }
      if (t.status === 'archived') return { mode: 'already' }
      // 允许态只剩 draft / pending / blocked；其他未知状态（老看板/人工改档）一律拒删，宁可保守
      if (t.status !== 'draft' && t.status !== 'pending' && t.status !== 'blocked') return { err: '任务状态 ' + t.status + ' 不在可删除范围（仅草稿/待办/阻塞可删）' }
      var live = gsb(t.id, d.tasks).filter(function (c) { return c.status !== 'archived' })
      if (live.length) return { err: '该任务还有 ' + live.length + ' 个未归档子任务（' + live.map(function (c) { return c.title || c.id }).slice(0, 3).join('、') + '），请先删除或归档子任务' }
      return { mode: 'ok' }
    }
    // 单任务删除：真删（从 d.tasks 数组移除），不写 history（记录随任务一起消失），不留档、无 undo。
    // console.error 留一行操作日志，便于事后溯源"某个卡片什么时候被谁删了"。
    handle('delete-task', async function (args) {
      var sid = rpcSessionId(args); var actor = getActorId()
      if (!args.taskId) return { ok: false, error: 'taskId required' }
      return mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        var g = deleteGate(d, t)
        if (g.mode === 'already') return { ok: true, deleted: t.id, alreadyArchived: true }
        if (g.err) return { ok: false, error: g.err }
        d.tasks = d.tasks.filter(function (x) { return x.id !== t.id })
        console.error('[task-board] delete-task: ' + t.id + ' «' + String(t.title || '').slice(0, 60) + '» (status=' + t.status + ') by ' + actor)
        return { ok: true, deleted: t.id }
      })
    })
    handle('update-task', async function (args) { var sid = rpcSessionId(args); var actor = getActorId(); if (args.hooks !== undefined && hooksDenied(actor)) return { ok: false, error: HOOKS_MAIN_ONLY }; var existsFn = existsInSession(sid); var __res = await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === args.taskId }); if (!t) return { ok: false, error: 'not found' }; var __pre = null; if (args.title !== undefined) t.title = args.title; if (args.description !== undefined) t.description = args.description; if (args.priority !== undefined) t.priority = args.priority; if (args.assignMode !== undefined) t.assignMode = args.assignMode; if (args.assignee !== undefined) t.assignee = args.assignee || null; if (args.dependsOn !== undefined) { var derr = validateDeps(d, t.id, args.dependsOn); if (derr) return { ok: false, error: derr }; t.dependsOn = args.dependsOn } if (args.pipeline !== undefined) { t.pipeline = args.pipeline; t.pipelineAuto = false } if (args.contextFiles !== undefined) { if (!t.context) t.context = { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' }; t.context.files = Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : [] } if (args.contextNotes !== undefined) { if (!t.context) t.context = { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' }; t.context.notes = typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : '' } if (args.publish) { if (t.status !== 'draft') return { ok: false, error: 'not a draft' }; t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'published'); /* 调研门禁③：发布的是 epic（有子任务）时轻量预检子任务调研注入，缺失挂返回值由锁外 pushSysNote 汇总 */ __pre = epicPrecheck(d.tasks, t.id, existsFn) } if (args.unfreeze && t.frozen) { delete t.frozen; delete t.frozenAt; delete t.frozenBy; ah(t, t.status, t.status, actor, '解除冻结，重新进入派发池') } if (args.resetToPending) { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; t.resolvedAt = null; t.resolution = null; delete t.retryCount; delete t.stuckSince; ah(t, ps, 'pending', actor, 'reset to pending after edit') }; if (args.hooks !== undefined) { var __he = applyHooks(t, args.hooks); if (__he.error) return { ok: false, error: __he.error } }; var __out = { ok: true, task: t }; if (__pre && __pre.missing.length) __out.epicPrecheck = __pre; return __out }); afterPublishPrecheck(sid, args.taskId, __res); return __res })
    handle('set-board-mode', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { d.boardMode = args.mode === 'manual' ? 'manual' : 'auto'; if (d.boardMode === 'manual' && d.teamMode) { d.teamMode = false; teamModeCache[sid] = false }; return { ok: true, boardMode: d.boardMode, teamMode: !!d.teamMode, workMode: deriveWorkMode(d) } }) })
    handle('set-team-mode', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { d.teamMode = !!args.enabled; if (d.teamMode) d.boardMode = 'auto'; teamModeCache[sid] = d.teamMode; return { ok: true, teamMode: d.teamMode, boardMode: d.boardMode, workMode: deriveWorkMode(d) } }) })
    // 工作模式三档单入口（v75 UI 收敛）：一次写入 boardMode+teamMode 两个字段，
    // 复用与老 RPC 完全相同的写入语义（team 档强制 auto；list 档关 team）——
    // 老 RPC set-board-mode/set-team-mode 原样保留，旧客户端/脚本/E2E 不受影响。
    handle('set-work-mode', async function (args) {
      var sid = rpcSessionId(args)
      var m = args && args.mode
      var mode = (m === 'list' || m === 'team') ? m : 'auto' // 缺省/非法值兜底 auto
      return mutateLocked(sid, function (d) {
        if (mode === 'list') { d.boardMode = 'manual'; d.teamMode = false }
        else if (mode === 'team') { d.boardMode = 'auto'; d.teamMode = true }
        else { d.boardMode = 'auto'; d.teamMode = false }
        teamModeCache[sid] = !!d.teamMode // 同步 systemPrompt 引导段的 teamMode 缓存
        return { ok: true, mode: mode, workMode: deriveWorkMode(d), boardMode: d.boardMode, teamMode: !!d.teamMode }
      })
    })
    // 裁决回流（v74 一次性模型）：原 Worker 已结束，答案写入 history 后任务回 pending，
    // 下个派发周期 spawn 新 Worker，裁决内容随 prompt 注入（histNotes 匹配"裁决"）
    // 结构化动作（裁决竞态保护）：
    //   action='resume'（默认，保持现状）= 裁决后立即回到派发池，~50ms 内被自动重派；
    //   action='hold' = 任务置 frozen 冻结，不参与任何自动派发（pickDispatch 跳过），
    //     留给主窗口补 dependsOn/补上下文的时间窗口，补完再显式解冻（unfreeze-task）。
    //   hold 时 mutateLocked 传 skipKick：冻结任务本就不该派发，省掉一次无意义的 poolCycle。
    async function doResolveEscalation(sid, actor, taskId, answer, action) {
      var act = action === 'hold' ? 'hold' : 'resume'
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (!t.escalation) return { ok: false, error: 'not escalated' }
        var escQ = String(t.escalation.question || '') // 先留档：下面 delete 后就没得取了
        delete t.escalation
        if (!Array.isArray(t.messages)) t.messages = []
        var arbAt = new Date().toISOString()
        t.messages.push({ kind: 'arbitration', text: answer || '', at: arbAt, by: actor, action: act })
        // 学习飞轮 v1：主窗口的裁决结论是最值钱的教训来源（Worker 会在同一个坑里反复上报）
        // → 生成候选教训（场景/疑问/裁决结论），由主窗口决定要不要沉淀进笔记/记忆工具。
        pushArbitrationLesson(d, t, escQ, answer || '', arbAt)
        ah(t, t.status, t.status, actor, (act === 'hold' ? '主窗口裁决（挂起冻结）: ' : '主窗口裁决: ') + (answer || '').slice(0, 200))
        // in-progress 的歧义任务：回 pending 重派（新 Worker 带裁决上下文）；verifying 的 verifier 故障升级：保持待审，下轮派新 verifier
        if (t.status === 'in-progress') { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps, 'pending', 'system', act === 'hold' ? '带裁决挂起冻结（不参与自动派发）' : '带裁决重新排队') }
        if (act === 'hold') { t.frozen = true; t.frozenAt = new Date().toISOString(); t.frozenBy = actor; ah(t, t.status, t.status, actor, '冻结：不参与自动派发，待主窗口补完上下文后解冻') }
        else { delete t.frozen; delete t.frozenAt; delete t.frozenBy }
        return { ok: true, task: t, answer: answer || '', action: act, frozen: !!t.frozen }
      }, act === 'hold')
      return result
    }
    // 解冻（竞态保护配套通道）：清 frozen + 记历史 + 触发派发（mutateLocked 默认 kickCycle）
    async function doUnfreezeTask(sid, actor, taskId) {
      return mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (!t.frozen) return { ok: false, error: 'not frozen' }
        delete t.frozen; delete t.frozenAt; delete t.frozenBy
        ah(t, t.status, t.status, actor, '解除冻结，重新进入派发池')
        return { ok: true, task: t, unfrozen: true }
      })
    }
    handle('unfreeze-task', async function (args) { return doUnfreezeTask(rpcSessionId(args), getActorId(), args.taskId) })
    // 高优介入（v74）：有活跃 run 则直接打进其会话；无则只记录 history（下次派发随 prompt 注入）
    // 通道选择（v1.2.4）：steer 优先——下一个 step 边界即消费；followup 要等整个 turn 结束，
    // 长 turn 下干预形同失联（实测：Worker 单 turn 跑 10+ 分钟，「口径重写」类干预到位时活已按旧口径干完）。
    // steer 不可用（老宿主无此方法）或抛错时回退 followup。
    async function doIntervene(sid, actor, taskId, msg) {
      if (!(msg || '').trim()) return { ok: false, error: 'message required' }
      var rec = runsFor(sid)[taskId]
      var delivered = false
      var channel = ''
      if (rec && rec.run && rec.run.localAgent) {
        var agent = rec.run.localAgent
        var m = makeMsg('[高优先级干预] 来自主窗口/用户的指令：\n\n' + msg + '\n\n请优先响应此指令，然后继续当前任务。', 'notice', '高优干预: ' + taskId)
        if (typeof agent.steer === 'function') {
          try { agent.steer(m); delivered = true; channel = 'steer' } catch (_) {}
        }
        if (!delivered) {
          try { agent.followup(m); delivered = true; channel = 'followup' } catch (_) {}
        }
      }
      await mutateLocked(sid, function (d) { var t = d.tasks.find(function (x) { return x.id === taskId }); if (t) { if (!Array.isArray(t.messages)) t.messages = []; t.messages.push({ kind: 'intervention', text: msg, at: new Date().toISOString(), by: actor }); ah(t, t.status, t.status, actor, '高优干预: ' + msg.slice(0, 200) + (delivered ? '' : '（无活跃 run，随下次派发注入）')) }; return t })
      return { ok: true, delivered: delivered, channel: channel }
    }
    // 终止执行某任务的 run：dispose 并回 pending（verifying 则保持待审，由新 verifier 接手）
    async function doTerminate(sid, actor, taskId) {
      var rec = runsFor(sid)[taskId]
      var label = 'no-active-run'
      if (rec) {
        delete runsFor(sid)[taskId]; label = rec.role + ':' + taskId
        try { await rec.run.dispose() } catch (_) {}
        // 手动终止的 run 不会走 settleRun（runsFor 已摘除，结算路径会早退），
        // 但它确实消耗了 token——在这里补一次结算，避免终止即丢账。
        await accumulateRunUsage(sid, rec)
      }
      await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (!t) return null
        delete t.stuckSince
        if (t.status === 'in-progress') { var ps = t.status; t.status = 'pending'; t.claimedBy = null; t.claimedAt = null; ah(t, ps, 'pending', actor, '手动终止，任务重新排队') }
        else if (t.status === 'verifying') { ah(t, 'verifying', 'verifying', actor, '手动终止审查，等待新 verifier 接手') }
        return t
      })
      return { ok: true, terminated: label }
    }
    // 继续等待：清除卡死标记
    async function doDismiss(sid, actor, taskId) {
      await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === taskId })
        if (t) { delete t.stuckSince; ah(t, t.status, t.status, actor, '清除卡死标记，继续观察') }
        return t
      })
      return { ok: true }
    }
    handle('terminate-agent', async function (args) { return doTerminate(rpcSessionId(args), getActorId(), args.taskId) })
    handle('dismiss-suspect', async function (args) { return doDismiss(rpcSessionId(args), getActorId(), args.taskId) })
    ctx.tools.register(defineTool({ name: 'task_terminate', description: 'Team 模式：终止执行某任务的池中 Agent（卡死/跑偏时）。in-progress 任务回 pending 重派，verifying 由新 verifier 接手。', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doTerminate(toolSessionId(), getActorId(), args.taskId) } }))
    // 手动触发单任务派发（manual 模式下"派发给 Worker"按钮，或 auto 模式手动补派）
    // touches 文件级排他：默认尊重文件锁——候选与活动任务 touches 冲突时返回
    // { ok:false, error:'touches-conflict', conflicts:[...] }（客户端 confirm 后带 force:true 重发）。
    // force:true 是人工越权通道：明知会与在跑 Worker 改同一批文件，由人决定是否强行并行。
    handle('dispatch-task', async function (args) {
      var sid = rpcSessionId(args)
      var role = args.role === 'verifier' ? 'verifier' : 'worker'
      var force = args.force === true
      var claimed = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (role === 'worker') {
          if (t.status !== 'pending') return { ok: false, error: 'not pending (状态: ' + t.status + ')' }
          if (t.claimedBy) return { ok: false, error: 'already claimed' }
          if (!force) { var cf = touchesConflict(t, holdsFiles(d)); if (cf.length) return { ok: false, error: 'touches-conflict', conflicts: cf } }
          claimApply(d, t, 'spawn-pending', 'manual dispatch' + (force ? '（force 越权：忽略 touches 冲突）' : ''))
        }
        else { if (t.status !== 'verifying') return { ok: false, error: 'not verifying (状态: ' + t.status + ')' }; if (t.escalation) return { ok: false, error: 'escalated, 待裁决' } }
        return { ok: true }
      })
      if (!claimed || !claimed.ok) return claimed
      var d = await rt(sid)
      var t = d.tasks.find(function (x) { return x.id === args.taskId })
      if (!t) return { ok: false, error: 'task disappeared' }
      var rec = await spawnOneShot(sid, t, role)
      if (rec) {
        if (role === 'worker') { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === args.taskId }); if (t2 && t2.claimedBy === 'spawn-pending') t2.claimedBy = String(rec.run.id); return t2 }, true) }
        if (role === 'verifier') { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === args.taskId }); if (t2) t2.verifierRun = String(rec.run.id); return t2 }, true) }
        return { ok: true, runId: String(rec.run.id) }
      }
      // spawn 失败 → 回退
      if (role === 'worker') { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === args.taskId }); if (t2 && t2.status === 'in-progress' && t2.claimedBy === 'spawn-pending') { t2.status = 'pending'; t2.claimedBy = null; t2.claimedAt = null; ah(t2, 'in-progress', 'pending', 'system', 'spawn 失败') }; return t2 }, true) }
      return { ok: false, error: 'spawn failed' }
    })
    handle('resolve-escalation', async function (args) { return doResolveEscalation(rpcSessionId(args), getActorId(), args.taskId, args.answer, args.action) })
    handle('intervene-agent', async function (args) { return doIntervene(rpcSessionId(args), getActorId(), args.taskId, args.message) })
    // 主 Agent 工具版（Team 模式下主 Agent 通过工具裁决/介入）
    ctx.tools.register(defineTool({ name: 'task_arbitrate', description: 'Team 模式：裁决 Worker 上报的歧义（escalation）。action=resume（默认）裁决后任务回派发池立即重派；action=hold 任务挂起冻结、不参与自动派发（留给主窗口补 dependsOn/上下文，补完后用 task_update unfreeze:true 解冻）。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, answer: { type: 'string' }, action: { type: 'string', enum: ['resume', 'hold'], description: 'resume（默认）=裁决后重新派发；hold=挂起冻结不派发' } }, required: ['taskId', 'answer'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doResolveEscalation(toolSessionId(), getActorId(), args.taskId, args.answer, args.action) } }))
    ctx.tools.register(defineTool({ name: 'task_intervene', description: 'Team 模式：向执行某任务的池中 Agent 发起高优先级指令（steer 通道，当前 step 结束即响应；无活跃 run 时记录随下次派发注入）。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, message: { type: 'string' } }, required: ['taskId', 'message'] }, output: jo(), execute: async function (args) { var __ra = getActorId(); if (resolveRoot(__ra) !== __ra) return { ok: false, error: '看板管理工具仅主窗口可用（子代理无看板权限）' }; return doIntervene(toolSessionId(), getActorId(), args.taskId, args.message) } }))
    // ===== 池中 Agent 结构化回报工具（双模：工具优先，文本分段为降级路径）=====
    ctx.tools.register(defineTool({ name: 'board_report', description: '[任务看板 Worker 专用] 上报任务结果。kind=complete 时填 summary/changes/selfTest/diffStat（git 仓库内改动附 git diff --stat 概要）；kind=escalate 时填 question（歧义上报，等待主窗口裁决）；kind=progress 时填 question（一行里程碑进展摘要，≤200 字符）——只在有实际产物/结论时报，禁止定时或表演式汇报，静默不通知主窗口。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, kind: { type: 'string', enum: ['complete', 'escalate', 'progress'] }, summary: { type: 'string' }, changes: { type: 'string' }, selfTest: { type: 'string' }, diffStat: { type: 'string', description: '变更概要：git diff --stat（含 git status --short）输出，≤1500 字符' }, question: { type: 'string', description: 'kind=escalate：歧义原文；kind=progress：一行里程碑进展摘要（≤200 字符）' } }, required: ['taskId', 'kind'] }, output: jo(), execute: async function (args) {
      var sid = toolSessionId(); var actor = getActorId()
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (t.status !== 'in-progress') return { ok: false, error: 'not in-progress (状态: ' + t.status + ')' }
        if (!Array.isArray(t.messages)) t.messages = []
        // ===== 里程碑进展通道（kind=progress）=====
        // 定位：长任务执行期间的「还在正确路上」的轻量证明；不进回执聚合、不通知主窗口（纯静默可见）。
        // 防表演式汇报：只在有实际产物/结论时报（契约写在 buildWorkerPrompt 里），且不写 ah() 历史（避免刷屏）。
        if (args.kind === 'progress') {
          var ptext = String(args.question || '').trim().slice(0, 200)
          if (!ptext) return { ok: false, error: 'question required for progress (一行进展摘要)' }
          var pat = new Date().toISOString()
          t.messages.push({ kind: 'progress', text: ptext, at: pat, by: actor })
          t.lastProgress = { text: ptext, at: pat } // 覆盖式：卡片只展示最新一条
          return { ok: true, progress: t.lastProgress }
        }
        if (args.kind === 'escalate') {
          var at = new Date().toISOString()
          t.escalation = { question: (args.question || '').slice(0, 2000), at: at, by: actor }
          t.messages.push({ kind: 'escalation', text: (args.question || '').slice(0, 4000), at: at, by: actor })
          ah(t, 'in-progress', 'in-progress', actor, '上报歧义（工具通道），待主窗口裁决')
          return { ok: true, escalated: true, task: t }
        }
        delete t.escalation
        delete t.retryCount // v72：成功完成清零超时重试计数（工具直报路径）
        delete t.stuckSince
        t.deliverable = { summary: args.summary || '', changes: args.changes || '', selfTest: args.selfTest || '', diff: (args.diffStat || '').slice(0, 4000), at: new Date().toISOString(), by: actor }
        var r = resolveApply(d, t, actor, 'verifying', (args.summary || '') + (args.selfTest ? '\n\n自测: ' + args.selfTest.slice(0, 300) : ''), 'worker 工具上报完成')
        r.ok = true; r.task = t
        return r
      })
      if (result && result.ok && result.escalated) maybeNotify(sid, result.task)
      if (result && result.ok && result.task && result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved') // 工具直报路径也要回执（work 档 board_report 直接落 resolved）
      return result
    } }))
    ctx.tools.register(defineTool({ name: 'board_verdict', description: '[任务看板 Verifier 专用] 提交验收结论。verdict=approved/rejected；summary=测试概要；checks=逐条核对证据。', parameters: { type: 'object', properties: { taskId: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'rejected'] }, summary: { type: 'string' }, checks: { type: 'string' } }, required: ['taskId', 'verdict'] }, output: jo(), execute: async function (args) {
      var sid = toolSessionId(); var actor = getActorId()
      var approved = args.verdict === 'approved'
      var result = await mutateLocked(sid, function (d) {
        var t = d.tasks.find(function (x) { return x.id === args.taskId })
        if (!t) return { ok: false, error: 'not found' }
        if (t.status !== 'verifying') return { ok: false, error: 'not verifying (状态: ' + t.status + ')' }
        delete t.escalation; delete t.verifyRetries // verifier 恢复产出：清人工验收标记
        t.verification = { verdict: args.verdict, summary: args.summary || '', checks: args.checks || '', at: new Date().toISOString(), by: actor }
        verifyApply(d, t, actor, args.verdict, (args.summary || '').slice(0, 200))
        if (!approved) { t.rejectCount = (t.rejectCount || 0) + 1; if (t.rejectCount >= 3) { t.status = 'blocked'; ah(t, 'in-progress', 'blocked', 'system', 'verifier 驳回 x' + t.rejectCount + '，待人工裁决') } }
        // 学习飞轮 v1：工具通道驳回同样生成候选教训（与文本通道同一条判重口径，不会重复落）
        if (!approved) pushRejectLesson(d, t, (args.summary || '') + (args.checks ? '\n' + args.checks : ''), t.verification.at)
        // 驳回包全量带回（task-muvg15p5）：checks（逐条核对证据）此前只进 history 且被截到 200 字——
        // 现落一条 kind='rejection' 全量包，随 buildMessages 注入重派 Worker prompt（见 core.pushRejection）
        if (!approved) pushRejection(t, args.summary, args.checks, t.verification.at, actor)
        return { ok: true, task: t }
      })
      if (result && result.ok && result.task) {
        if (result.task.status === 'resolved') notifyTaskDone(sid, result.task, 'resolved')
        if (result.task.status === 'blocked') notifyTaskDone(sid, result.task, 'blocked')
      }
      if (result && result.ok && !approved && result.task) {
        // v74 一次性模型：原 Worker 已销毁，驳回任务回 pending 重派新 Worker（完整驳回包已落 t.messages，
        // 经 buildMessages 全量随 prompt 注入；history 只是审计轨）
        var bt = result.task
        if ((bt.rejectCount || 0) < 3) { await mutateLocked(sid, function (d) { var t2 = d.tasks.find(function (x) { return x.id === bt.id }); if (t2 && t2.status === 'in-progress') { t2.status = 'pending'; t2.claimedBy = null; t2.claimedAt = null }; return t2 }, true) }
      }
      return result
    } }))
    // 枚举当前网关可用模型（供 Verifier 模型下拉选择）：llm.listProviders + listModels
    handle('list-models', async function () {
      var llm = ctx.get('llm'); if (!llm) return { ok: false, error: 'llm service unavailable' }
      var providers = llm.listProviders()
      var out = []
      for (var i = 0; i < providers.length; i++) {
        try {
          var models = await llm.listModels(providers[i].id)
          for (var j = 0; j < models.length; j++) out.push({ id: providers[i].id + '/' + models[j].id, name: models[j].name || models[j].id, provider: providers[i].name || providers[i].id })
        } catch (_) { /* 某 provider 枚举失败不阻塞整体 */ }
      }
      return { ok: true, models: out }
    })
    // ===== 学习飞轮 v1：沉淀推送通道（push-lesson）=====
    // 详情页「沉淀」按钮 → 把结构化候选教训 followup 给主窗口 agent，由它用自己可用的
    // 笔记/记忆工具（如 note_manage）决定沉淀到哪、或评估后忽略。
    // 这就是全部：看板不知道对方有没有记忆工具、也不知道最终存到哪（零耦合红线）。
    // feedbackEnabled 关闭 → 直接拒绝（UI 侧也不会渲染按钮，这里是双保险）。
    handle('push-lesson', async function (args) {
      var sid = rpcSessionId(args)
      var text = (typeof args.text === 'string') ? args.text.trim().slice(0, 4000) : ''
      if (!text) return { ok: false, error: 'text required' }
      var d = await rt(sid)
      if (!cfg(d).feedbackEnabled) return { ok: false, error: 'feedback disabled' }
      var root = rootForSession(sid)
      if (!root) return { ok: false, error: 'no root agent for session' }
      var delivered = false
      try {
        root.followup(makeMsg('📚 [任务看板] 候选教训沉淀请求\n\n' + text + '\n\n请用你可用的笔记/记忆工具（如 note_manage）沉淀，或评估后忽略。', 'notice', '教训沉淀: ' + String(args.taskId || '')))
        delivered = true
      } catch (e) { console.error('[task-board] push-lesson followup failed:', String(e)) }
      return { ok: true, delivered: delivered }
    })
    // 板级配置写入（设置区单入口）：数值键钳制范围、字符串键 trim、布尔键原样存。
    // 回执开关 notifyDispatch/notifyDone（UI「通知」小节）：布尔原样落盘，缺省 true 由 normalizeBoard 补；
    // 生效点在派发侧读 cfg(snap)（不回填缓存），下一次派发/结算周期即生效。
    // 史诗拆分总开关 epicSplit（UI「功能」小节）：布尔原样落盘 + **当场回填 epicSplitCache**——Team 提示词
    // 组装是同步函数只能读缓存，不回填就得等下一次 rt() 读盘才生效（关掉后仍按旧的劝拆一轮，体感是开关没生效）。
    // 与 feedbackEnabled 同款双写；机制面（parentId 建子卡/自动收口/hooks）不看这个键。
    handle('set-board-config', async function (args) { var sid = rpcSessionId(args); return mutateLocked(sid, function (d) { if (args.key === 'maxWorkers') d.maxWorkers = Math.max(1, Math.min(10, args.value || 3)); else if (args.key === 'maxVerifiers') d.maxVerifiers = Math.max(0, Math.min(5, args.value || 0)); else if (args.key === 'workerModel') d.workerModel = typeof args.value === 'string' ? args.value.trim() : ''; else if (args.key === 'verifierModel') d.verifierModel = typeof args.value === 'string' ? args.value.trim() : ''; else if (args.key === 'softTimeoutMin') d.softTimeoutMin = Math.max(1, Math.min(480, Number(args.value) || 30)); else if (args.key === 'hardTimeoutMin') d.hardTimeoutMin = Math.max(1, Math.min(1440, Number(args.value) || 120)); else if (args.key === 'feedbackEnabled') { d.feedbackEnabled = !!args.value; feedbackCache[sid] = d.feedbackEnabled } else if (args.key === 'notifyDispatch') d.notifyDispatch = !!args.value; else if (args.key === 'notifyDone') d.notifyDone = !!args.value; else if (args.key === 'epicSplit') { d.epicSplit = !!args.value; epicSplitCache[sid] = d.epicSplit } return { ok: true } }) })
    handle('create-task', async function (args) { var sid = rpcSessionId(args); /* 短 id 防幻影板（task-muuf0o7a）：截断/不完整 sessionId 建出的板永远匹配不到活 root（每 15s 刷屏元凶），显式报错优于静默建幻影板；import- 前缀板由 isFullSessionId 放行 */ if (!isFullSessionId(sid)) return { ok: false, error: 'sessionId 不完整（疑似截断短 id），拒绝创建任务: ' + sid }; var actor = getActorId(); /* hooks 只许主窗口设置（角色门禁） */ if (args.hooks !== undefined && hooksDenied(actor)) return { ok: false, error: HOOKS_MAIN_ONLY }; return mutateLocked(sid, function (d) { var nHooks = null; if (args.hooks !== undefined) { var hn = normalizeHooks(args.hooks); if (hn.error) return { ok: false, error: hn.error }; nHooks = hn.hooks } if (args.id && d.tasks.find(function (x) { return x.id === args.id })) return { ok: false, error: 'duplicate id' }; if (args.dependsOn && args.dependsOn.length) { var derr = validateDeps(d, args.id || '(pending)', args.dependsOn); if (derr) return { ok: false, error: derr } }; var now = new Date().toISOString(); /* Team 模式护栏：draft 缺省跟随 teamMode（先补齐依赖/上下文再统一 publish）；显式 draft:false 保留为立即派发的逃生门 */ var asDraft = args.draft === undefined ? !!d.teamMode : !!args.draft; var t = { id: args.id || ('task-' + Date.now().toString(36)), title: args.title || 'Untitled', description: args.description || '', status: asDraft ? 'draft' : 'pending', priority: args.priority || 'medium', tags: args.tags || [], parentId: args.parentId || null, subtaskStrategy: null, assignMode: 'auto', assignee: null, context: { files: (Array.isArray(args.contextFiles) ? args.contextFiles.map(String).slice(0, 20) : []), docs: [], instructions: args.instructions || '', notes: (typeof args.contextNotes === 'string' ? args.contextNotes.slice(0, 8000) : ''), relatedTasks: [], prerequisites: '' }, acceptance: args.acceptance || '', dependsOn: args.dependsOn || [], touches: normTouches(args.touches), pipeline: args.pipeline || '', claimedBy: null, claimedAt: null, createdAt: now, resolvedAt: null, verifiedAt: null, verifiedBy: null, archivedAt: null, resolution: null, waitingForTouches: null, messages: [], history: [{ from: 'created', to: asDraft ? 'draft' : 'pending', timestamp: now, actor: actor, note: asDraft ? 'created as draft' : 'created' }] }; if (nHooks && Object.keys(nHooks).length) t.hooks = nHooks; if (!t.pipeline) { t.pipeline = classifyPipeline(t); t.pipelineAuto = true }; d.tasks.push(t); /* 调研门禁 warning 族（与并行 UI 卡约定字段名 warning，core 纯函数统一口径）：空描述/无调研上下文/整树 glob 三类软提示合并为一条（；分隔），不拦截创建；字段可选，老 client 无感 */ var out = withSplitHint({ ok: true, task: t }, t, cfg(d).epicSplit); var warns = createTaskWarnings(t); attachContextSuggestions(out, warns, t.touches, existsInSession(sid)); if (warns.length) out.warning = warns.join('；'); return out }) })
    handle('list-children', async function (args) { var sid = rpcSessionId(args); var subs = ctx.subagents; if (!subs) return { ok: true, children: [] }; try { var list = await subs.listChildren(sid); var children = (list || []).map(function (c) { return { id: String(c.sessionId || c.id || ''), label: String(c.label || c.title || c.mode || '') } }).filter(function (c) { return c.id.length > 0 }); return { ok: true, children: children } } catch (e) { return { ok: true, children: [], error: String(e) } } })
    // ===== #14 批量操作：archive（仅 resolved/cancelled）/ set-priority（全部）/ delete（真删，无 undo）=====
    // delete op 与单任务 delete-task 走同一套 deleteGate 门禁（状态 + 未归档子任务），
    // done/skipped 语义与 archive 完全一致：门禁不过就进 skipped（附 reasons[id] 一行原因）。
    // 注意：批量删除是**真删**（从 tasks 数组移除），不产生 undo 快照——batch-undo 对 delete 无意义。
    handle('batch-op', async function (args) {
      var sid = rpcSessionId(args); var actor = getActorId()
      var ids = Array.isArray(args.ids) ? args.ids : []
      if (ids.length === 0) return { ok: false, error: 'no ids' }
      return mutateLocked(sid, function (d) {
        var done = 0, skipped = [], reasons = {}
        // skip 点统一收口：追加 id + 原因（原因只进 reasons，不改 skipped 的 string[] 老契约）
        function skip(id, why) { skipped.push(id); if (why) reasons[id] = why }
        ids.forEach(function (id) {
          var t = d.tasks.find(function (x) { return x.id === id })
          if (!t) { skip(id, '任务不存在'); return }
          if (args.op === 'delete') {
            var g = deleteGate(d, t)
            if (g.err) { skip(id, g.err); return }
            // archived 幂等：已归档的不再删（也不计入 done，与 archive 对已归档项的处理保持一致）
            if (g.mode === 'already') { skip(id, '已归档'); return }
            d.tasks = d.tasks.filter(function (x) { return x.id !== id })
            console.error('[task-board] batch delete: ' + id + ' «' + String(t.title || '').slice(0, 60) + '» (status=' + t.status + ') by ' + actor)
            done++
          } else if (args.op === 'archive') {
            if (t.status !== 'resolved' && t.status !== 'cancelled') { skipped.push(id); return }
            var ps = t.status; t.status = 'archived'; t.archivedAt = new Date().toISOString(); ah(t, ps, 'archived', actor, 'batch archive'); done++
          } else if (args.op === 'set-priority') {
            if (['low', 'medium', 'high', 'critical'].indexOf(args.value) < 0) { skipped.push(id); return }
            t.priority = args.value; ah(t, t.status, t.status, actor, '批量设优先级: ' + args.value); done++
          } else if (args.op === 'publish') {
            if (t.status !== 'draft') { skipped.push(id); return }
            t.status = 'pending'; ah(t, 'draft', 'pending', actor, 'batch publish'); done++
          } else { skipped.push(id) }
        })
        // reasons 只在 delete op 下有内容（其他 op 的跳过原因沿用"未命中门禁"的老行为），
        // 老客户端只读 skipped.length，多一个可选字段无感。
        return { ok: true, done: done, skipped: skipped, reasons: reasons }
      })
    })
    // #16 批量撤销：按快照恢复 priority（任何状态）与 status（仅 archive→resolved 回滚）
    // 明确不支持 op='delete'：删除是真删（任务对象已从 tasks 数组移除，快照里只剩 id/priority/status），
    // 没有任何可恢复的原始字段，撤销只能凭空造一张残缺卡片——所以 delete 不产生 undo 快照，
    // 客户端也不为 delete 显示「↩️ 撤销」按钮（snapshot 只在 done>0 且 op!=='delete' 时保留）。
    // 若老客户端硬发 op='delete' 快照进来，落到 else 分支只做 priority 回填，不会凭空复活任务。
    handle('batch-undo', async function (args) {
      var sid = rpcSessionId(args); var actor = getActorId()
      var snap = args && args.snapshot
      if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) return { ok: false, error: 'no snapshot' }
      return mutateLocked(sid, function (d) {
        var done = 0, skipped = []
        snap.items.forEach(function (it) {
          var t = d.tasks.find(function (x) { return x.id === it.id })
          if (!t) { skipped.push(it.id); return }
          t.priority = it.priority || t.priority
          if (snap.op === 'archive' && t.status === 'archived' && (it.status === 'resolved' || it.status === 'cancelled')) {
            t.status = it.status; delete t.archivedAt
            ah(t, 'archived', it.status, actor, '撤销批量归档')
          } else {
            ah(t, t.status, t.status, actor, '撤销批量优先级: ' + t.priority)
          }
          done++
        })
        return { ok: true, done: done, skipped: skipped }
      })
    })

    // ===== client ↔ host RPC：POST /dsh-agent-board { method, args } → JSON =====
    function readBody(req, limit) {
      return new Promise(function (resolve, reject) {
        var chunks = [], size = 0
        req.on('data', function (c) { size += c.length; if (size > limit) { reject(new Error('payload too large')); try { req.destroy() } catch (_) {} return }; chunks.push(c) })
        req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')) })
        req.on('error', reject)
      })
    }
    // ctx.webServer.register 只返回释放器、不绑定调用方 fiber（tools.register 才会），
    // 必须自己 ctx.effect 包住——否则插件禁用/重载后路由残留，handler 闭包指向已销毁的
    // fiber 内状态（500），且再次启用时撞 "duplicate exact route" 永远起不来。
    ctx.effect(function () {
      return ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-board',
      handler: async function (req, res) {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ ok: false, message: 'method not allowed' })); return }
        var payload = null
        try { payload = JSON.parse(await readBody(req, 4 * 1024 * 1024)) } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'bad request' })); return }
        var fn = payload && handlers[payload.method]
        if (!fn) { res.writeHead(404); res.end(JSON.stringify({ ok: false, message: 'unknown method: ' + payload.method })); return }
        try { var out = await fn(payload.args); res.writeHead(200); res.end(JSON.stringify(out === undefined ? null : out)) } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, message: String(e) })) }
      },
      })
    })
}
