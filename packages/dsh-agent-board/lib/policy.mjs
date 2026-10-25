// dsh-agent-board — 策略层（lib/policy.mjs）
// 纯函数、零状态、零 IO：任务粒度治理（软闸门文案与判定）+ 学习飞轮候选教训生成。
// index.mjs 薄壳 re-export 粒度治理导出（对外契约不变）；dispatch/rpc 模块按需 import。
import * as core from './core.mjs'
const { cfg, lessonText, pushLesson, ah, classifyPipeline } = core

// ===== 任务粒度治理（全软方案：只引导/提示，绝不阻断创建与派发）=====
// 背景：agent 容易把史诗级大任务整坨塞进看板（长程 + 跑偏风险 + 返工成本高）。
// 落地三件套（都不带硬闸门）：
//   1) task_create 工具描述里的粒度契约 TASK_SIZE_CONTRACT；
//   2) Team 模式系统提示词第 6~8 条拆分 doctrine（流程 + 决策树 + 上下文装配）；
//   3) create-task RPC / task_create 工具返回体命中时附加 suggestSplit 一行建议（不落盘、不改状态）。
// 板级总开关 epicSplit（缺省 true，UI 在入池配置弹层「功能」小节）：**只关引导，不禁机制**。
//   false 时的两个生效点＝上面第 2、3 条（本文件 splitRuleOf / withSplitHint 统一收口）：
//     · splitRuleOf(false) → ''：Team 提示词第 6~8 条整条不注入；
//     · withSplitHint(out, t, false) → 原样返回：不再附 suggestSplit 软提示。
//   机制面一律不看这个开关：显式传 parentId 建子卡、检查/收口父子流转、hooks 状态机照常工作——
//   关的是「主动劝你拆」，不是「不许你拆」。
//   第 1 条（TASK_SIZE_CONTRACT）留在 task_create 的**静态**工具描述里：工具定义会快照进 request header
//   （dsh-session 校验 description 必须是 string），没有按板动态能力，故不在开关范围内。
export var TASK_SIZE_CONTRACT = '建议粒度：单任务 10~30 分钟可独立完成。超出此范围的大任务请先拆分——建一张 epic 卡（parentId 体系）再挂子任务，别整坨塞进来。'
export var SUGGEST_SPLIT_TEXT = '任务看起来偏大（建议单任务 10~30 分钟）：考虑拆分子任务（parentId）或收窄边界'
// Team 模式提示词第 6 条：大任务的 epic 拆分流程（父卡 pipeline=direct 不派发，子任务全 resolved 后父卡由 checkParentAuto 自动转 verifying）
export var TEAM_SPLIT_RULE = '6. 大任务必须拆分：预计超过 30 分钟的任务，先建一张 epic 父卡（pipeline 传 direct，不派发），再拆成若干 10~30 分钟的子任务（task_create 传 parentId=父卡 id，有先后顺序的用 dependsOn 串联）。子任务全部完成后父卡会自动标记完成（checkParentAuto）。'
// Team 提示词第 7 条：命中任一信号即拆，按可独立验收的子卡与文件族切边界。
export var TEAM_DECISION_TREE = '7. 拆解决策树（命中任一信号就该拆）：预计超 30 分钟；涉及 3+ 个文件/模块族；需求描述含「然后/接着/再/最后」等多阶段词；交付物超 2 类。拆法：按「每张子卡可独立验收」（自带可运行的 acceptance）切边界；按文件族/touches 切分还能天然避开文件锁互踩。'
// Team 提示词第 8 条：子代理零记忆，每张子卡都要独立带齐公共背景与调研包。
export var TEAM_CONTEXT_PACKING = '8. 拆解后的上下文装配：每张子卡独立带齐调研包（description 写目标约束 + contextNotes 写结论思路 + contextFiles 带行号）——子代理零记忆，epic 父卡上的背景不会自动传给子卡，公共背景要逐卡复制进 contextNotes。执行中 Worker 发现任务比预估大时会 escalate 上报，此时拆分重派，别让 Worker 硬跑整坨。'
// Team 提示词第 9 条：需求卡 → 拆解官 → 确认发布的工作流引导（task-mvneoy1u，epic task-mvnem59t 子卡 3/6）。
// ⚠️ 本条**不受 epicSplit 门禁**：它是「确认流怎么用」的流程引导，不是「主动劝你拆」——
//    拆解官机制本身也不看 epicSplit（task_decompose 工具常驻）。dispatch 注入段在 splitRuleOf(...) 之后恒拼接本条。
export var TEAM_DECOMPOSE_FLOW = '9. 需求卡工作流：用户用自然语言下达的大需求，先建成 draft 需求卡（保留需求原文），再用 task_decompose 派拆解官出实现侧子卡提案；提案以草稿子卡落位后，向用户呈现一览（标题/档位/模型/touches），用户确认或调档（task_update 改 size/model）后统一 publish。拆解官提案不是终稿——你的呈现与用户的那一眼确认是语义质量的最后防线。'
// Team 提示词第 6~8 条拆分 doctrine 的注入出口（每条含前导换行，调用方直接字符串相加）：
//   epicSplit 缺省/true → 第 6 条拆分流程 + 第 7 条决策树 + 第 8 条上下文装配；
//   epicSplit === false → ''（第 6~8 条整条不出现，编号 1~5 连续不受影响）。
// 纯函数：只看传入布尔，不读配置、不碰 IO——dispatch 侧从缓存取 cfg(d).epicSplit 后传进来。
export function splitRuleOf(epicSplit) { return epicSplit === false ? '' : '\n'+TEAM_SPLIT_RULE+'\n'+TEAM_DECISION_TREE+'\n'+TEAM_CONTEXT_PACKING }
// 史诗特征词：命中即视为"整坨塞进来"的典型信号（与 TASK_SIZE_CONTRACT 配套；无 /g，可安全复用）
var EPIC_WORDS = /全量|整体|系统级|全面|重构|所有模块|整个/
// description 长度阈值（字符）：超过它说明描述密度远超"10~30 分钟单任务"应有体量
var SPLIT_DESC_LIMIT = 500
// 软闸门判定：description > 500 字符，或 title+description 命中史诗特征词 → 返回建议文案；否则返回 ''
// 纯函数、无 IO、不改任务字段——调用方拿到空串即视为粒度正常（falsy 判断即可）
export function suggestSplitOf(t) {
  var desc = String((t && t.description) || '')
  var text = String((t && t.title) || '') + ' ' + desc
  if (desc.length > SPLIT_DESC_LIMIT || EPIC_WORDS.test(text)) return SUGGEST_SPLIT_TEXT
  return ''
}
// 统一出口：只在命中时附加字段，老调用方拿到的返回体形态完全不变（多一个可选字段而已）
// 第三参 epicSplit（缺省 undefined = 开）：显式 false 时直接原样返回——总开关关掉后不再主动劝拆，
// 返回体与「未命中」逐字同形（老调用方无感）。
export function withSplitHint(out, t, epicSplit) {
  if (epicSplit === false) return out
  var hint = suggestSplitOf(t)
  if (hint && out && typeof out === 'object') out.suggestSplit = hint
  return out
}

    // ===== 学习飞轮 v1：候选教训信号（只产信号，不做存储）=====
    // 看板在这里只做一件事：把「Verifier 驳回 / 主窗口仲裁结论」变成一条结构化的候选教训，
    // 落进 t.messages（kind='lesson-candidate'：详情页可见 + 带「沉淀」按钮）。
    // 零耦合红线：不调用任何笔记/记忆工具的 API、不写任何外部文件——教训最终存到哪、要不要存，
    // 全由主窗口 agent 自己用可用工具决定。触发前一律先过 feedbackEnabled 总开关（关掉 = 不生成）。
    function lessonSource(t) { return '任务 ' + t.id + '「' + String(t.title || '').slice(0, 60) + '」 · ' + new Date().toISOString() }
export function pushRejectLesson(d, t, reason, at) {
      if (!cfg(d).feedbackEnabled) return false
      return pushLesson(t, lessonText('任务「' + String(t.title || '') + '」(' + t.id + ') 被 Verifier 驳回', [['错误做法', String(reason || '(Verifier 未给出理由)')]], lessonSource(t)), at, 'system')
    }
export function pushArbitrationLesson(d, t, question, answer, at) {
      if (!cfg(d).feedbackEnabled) return false
      return pushLesson(t, lessonText('任务「' + String(t.title || '') + '」(' + t.id + ') 的歧义裁决', [['疑问', question], ['裁决结论', answer]], lessonSource(t)), at, 'system')
    }

// ===== 拆解官（task-mvnenrwk，epic task-mvnem59t 子卡 2/6）：outputSchema 强箍提案 + host 物化 =====
// 核心设计（需求讨论定稿，勿改架构）：拆解官=一次性 run，**不拿任何建卡工具**——提案由 host 读
// result.structured 后物化成 draft 子卡（权限口子=根本不需要开）。本层只放三样纯定义/纯函数：
//   DECOMPOSE_SCHEMA                       outputSchema（仅 type/properties/required/items/enum 白名单字段）
//   buildDecomposerPrompt(t, pack)         拆解官契约（写死纪律，与 buildWorkerPrompt/buildVerifierPrompt 同风格）
//   applyDecomposeProposal(d, t, proposal, now)   host 物化：提案 → draft 子卡（幂等清旧批）
// ⚠️ 宿主硬性规则（task-mvnenrwk 驳回实证，dsh-tools lib/types/json-schema.js:223-228）：enum 必须伴
//    type/oneOf——缺 type 的 enum 会在 startActivation 内被 assertObjectJsonSchema 同步抛 JsonSchemaError
//    拒收 → 命中「剥外挂参数裸重试」回退 → 运行期永远拿不到 result.structured → host 物化生产不可达。
//    回归锁：test/decompose.test.mjs ①b（宿主子集校验镜像 + 破形反证）。
export var DECOMPOSE_MAX_CHILDREN = 8
export var DECOMPOSE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'children'],
  properties: {
    verdict: { type: 'string', enum: ['split', 'keep'] },
    children: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'size', 'touches', 'acceptance', 'description'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          size: { type: 'string', enum: ['light', 'standard', 'heavy'] },
          modelHint: { type: 'string' },
          touches: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'string' },
          dependsOnIdx: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    rationale: { type: 'string' },
  },
}
// 拆解官 prompt 契约（写死纪律）：
// ① 第一步必须 read contextFiles 清单里的文件再动手拆（实现侧拆解，禁止需求侧转述）；
// ② 每张子卡 10~30 分钟可独立验收、touches 精确到文件、acceptance 是可执行命令；
// ③ size 判档语义：light=单点小改/文档/配置，standard=常规模块改动（缺省），heavy=跨模块/高风险/需强推理；
//    modelHint 仅在有特殊理由时填（如超长上下文）；
// ④ children 上限 DECOMPOSE_MAX_CHILDREN 张；verdict=keep 表示源卡不用拆；
// ⑤ dependsOnIdx 只许引用本批**前排**子卡下标（0 起）——物化侧据此翻译成本批真实 id，按构造天然无环。
export function buildDecomposerPrompt(t, pack) {
  var p = '你是任务看板的拆解官（一次性 run）。你的唯一交付物是**结构化拆解提案**（由 outputSchema 强箍：verdict/children/rationale），提案落定后本会话即销毁。\n\n'
  p += '源卡：' + t.id + ' · ' + String(t.title || '') + '\n'
  p += '状态：' + String(t.status || '') + '\n'
  p += '描述：\n' + String(t.description || '(无)').slice(0, 8000) + '\n'
  if (t.acceptance) p += '源卡验收脚本：' + String(t.acceptance) + '\n'
  if (t.context && t.context.instructions) p += '指引：' + String(t.context.instructions).slice(0, 1000) + '\n'
  if (Array.isArray(t.touches) && t.touches.length) p += '源卡 touches：' + t.touches.join('、') + '\n'
  if (pack) p += '\n' + pack + '\n'
  p += '\n拆解纪律（硬约束）：\n'
  p += '1. 第一步必须先用 read 工具读上面文件清单里的文件（按所给行号范围），从**实现侧**拆（按模块/文件边界切分）；禁止不读代码就拍脑袋拆，禁止只做需求侧转述。\n'
  p += '2. 每张子卡必须 10~30 分钟可独立完成并验收：touches 精确到文件（文件级排他锁，同批子卡 touches 不得互相重叠），acceptance 必须是可执行命令（如 "node --test test/xxx.test.mjs"）。\n'
  p += '3. size 判档：light=单点小改/文档/配置；standard=常规模块改动（缺省）；heavy=跨模块/高风险/需强推理。modelHint 仅在有特殊理由时填（如某子卡需超长上下文模型），否则留空。\n'
  p += '4. children 上限 ' + DECOMPOSE_MAX_CHILDREN + ' 张；有先后顺序的用 dependsOnIdx 标注（只许引用本批**前排**子卡的下标，0 起）。\n'
  p += '5. 源卡本身不大、不必拆时：verdict=keep，并在 rationale 写清理由。\n'
  p += '\n权限边界：你没有任何建卡工具——不要尝试创建/修改看板任务。提案由宿主读结构化结果后自动物化为 draft 子卡（源卡状态不变，由主窗口确认后逐张 publish）。\n'
  return p
}
// 子卡 id 分配：parentId-N 派生（可读、可溯源）；与存量卡撞号时追加 rN 后缀（重拆撞已发布子卡的场景）。
function decomposeChildId(d, parentId, n) {
  var id = parentId + '-' + n
  var bump = 0
  while (d.tasks.some(function (x) { return x && x.id === id })) { bump++; id = parentId + '-' + n + 'r' + bump }
  return id
}
// host 物化：拆解提案 → draft 子卡（在 mutateLocked 锁内调用的纯函数）。
// 纪律：
//   · 校验先于清理——提案畸形/run 失败时**绝不清**旧批提案（失败不毁已有资产）；
//   · 幂等：提案有效才清旧批（proposalOf===源卡 id 且仍 draft 的提案子卡整批移除；已 publish/落定的绝不碰）；
//   · 子卡落位：status=draft、parentId=源卡、size（合法才落）、model=modelHint（空不落）、touches/acceptance/
//     description 落位、dependsOnIdx → 本批真实 id（只收前排下标，天然无环）、上限 DECOMPOSE_MAX_CHILDREN 截断；
//   · 源卡自身状态不变（仍 draft/pending，由用户处置），只追加 messages 提案摘要行 + history 审计行。
// 返回 { ok, verdict, children?:[{id,title}], error? }——非空返回值驱动 mutateLocked 写盘。
export function applyDecomposeProposal(d, t, proposal, now) {
  if (!d || !Array.isArray(d.tasks) || !t) return { ok: false, error: '板/源卡缺失' }
  if (!Array.isArray(t.messages)) t.messages = []
  var stamp = now || new Date().toISOString()
  var verdict = proposal && typeof proposal === 'object' ? proposal.verdict : ''
  if (verdict !== 'split' && verdict !== 'keep') {
    t.messages.push({ kind: 'decompose', text: '🧩 拆解提案无效（verdict 缺失/非法：' + String(verdict || '(空)') + '）——源卡未改动，可重试 task_decompose', at: stamp, by: 'decomposer' })
    return { ok: false, error: '提案 verdict 缺失/非法' }
  }
  var kids = []
  if (verdict === 'split') {
    var raw = Array.isArray(proposal.children) ? proposal.children : []
    for (var i = 0; i < raw.length && kids.length < DECOMPOSE_MAX_CHILDREN; i++) {
      var c0 = raw[i]
      if (!c0 || typeof c0 !== 'object') continue
      if (!String(c0.title == null ? '' : c0.title).trim()) continue
      kids.push(c0)
    }
    if (!kids.length) {
      t.messages.push({ kind: 'decompose', text: '🧩 拆解提案无效（children 为空或无一条带 title）——源卡未改动，可重试 task_decompose', at: stamp, by: 'decomposer' })
      return { ok: false, error: '提案 children 为空' }
    }
  }
  // 幂等点：提案有效才清旧批——上次未发布（仍 draft）的提案子卡整批移除。
  d.tasks = d.tasks.filter(function (x) { return !(x && x.proposalOf === t.id && x.status === 'draft') })
  if (verdict === 'keep') {
    var rationale = String(proposal.rationale == null ? '' : proposal.rationale).trim().slice(0, 1500)
    t.messages.push({ kind: 'decompose', text: '🧩 拆解官判定无需拆分：' + (rationale || '（未给理由）'), at: stamp, by: 'decomposer' })
    ah(t, t.status, t.status, 'system', '拆解官判定无需拆分（rationale 落源卡消息）')
    return { ok: true, verdict: 'keep', children: [] }
  }
  // 物化：先分配整批 id（dependsOnIdx → 真实 id 翻译要求全员 id 已知），再逐张落 draft 子卡。
  var ids = []
  for (var k = 0; k < kids.length; k++) ids.push(decomposeChildId(d, t.id, k + 1))
  var created = []
  for (var k2 = 0; k2 < kids.length; k2++) {
    var c = kids[k2]
    var deps = []
    var di = Array.isArray(c.dependsOnIdx) ? c.dependsOnIdx : []
    for (var dj = 0; dj < di.length; dj++) {
      var idx = di[dj]
      if (typeof idx === 'number' && isFinite(idx) && idx >= 0 && idx < k2 && deps.indexOf(ids[idx]) < 0) deps.push(ids[idx])
    }
    var child = {
      id: ids[k2],
      title: String(c.title).trim().slice(0, 200),
      description: String(c.description == null ? '' : c.description).slice(0, 8000),
      status: 'draft',
      priority: t.priority || 'medium',
      tags: Array.isArray(t.tags) ? t.tags.slice() : [],
      parentId: t.id,
      subtaskStrategy: null,
      assignMode: 'auto',
      assignee: null,
      context: { files: [], docs: [], instructions: '', notes: '', relatedTasks: [], prerequisites: '' },
      acceptance: String(c.acceptance == null ? '' : c.acceptance).slice(0, 2000),
      dependsOn: deps,
      touches: Array.isArray(c.touches) ? c.touches.filter(function (x) { return typeof x === 'string' && x.trim() }).slice(0, 20).map(function (x) { return x.trim() }) : [],
      pipeline: '',
      claimedBy: null, claimedAt: null, createdAt: stamp,
      resolvedAt: null, verifiedAt: null, verifiedBy: null, archivedAt: null, resolution: null, waitingForTouches: null,
      messages: [],
      history: [{ from: 'created', to: 'draft', timestamp: stamp, actor: 'decomposer', note: '拆解官提案物化（源卡 ' + t.id + '）' }],
      proposalOf: t.id,
    }
    // 拆解官定的 touches 就是它的调研结论（task-mvnrtpxo，task-mvnnkv7x epic 发布预检「无调研包」误报实证）：
    // 物化时 context.files 自动 = touches（文件级路径，Worker 可按需 read 自取；touches 已过滤+截 20，与
    // contextFiles 上限同口径），预检 epicPrecheck 不再对拆解子卡报 missing。context.notes 留空——
    // child.description 本身已含实现侧结论，不重复复制。
    child.context.files = child.touches.slice()
    // 与 create-task 同口径：未显式给 pipeline 时按卡面分类（含 acceptance 的通常落 full）
    child.pipeline = classifyPipeline(child); child.pipelineAuto = true
    var sz = typeof c.size === 'string' ? c.size.trim() : ''
    if (sz === 'light' || sz === 'standard' || sz === 'heavy') child.size = sz
    var mh = typeof c.modelHint === 'string' ? c.modelHint.trim() : ''
    if (mh) child.model = mh
    d.tasks.push(child)
    created.push(child)
  }
  var summary = created.map(function (x) { return x.id + '·' + x.title }).join('、').slice(0, 900)
  t.messages.push({ kind: 'decompose', text: '🧩 拆解提案已就位（' + created.length + ' 张草稿子卡）：' + summary + '——确认后逐张 publish（task_update publish=true）', at: stamp, by: 'decomposer' })
  ah(t, t.status, t.status, 'system', '拆解官提案物化 ' + created.length + ' 张草稿子卡（draft，待主窗口确认发布）')
  return { ok: true, verdict: 'split', children: created.map(function (x) { return { id: x.id, title: x.title } }) }
}
