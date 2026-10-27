// ===== 拆解官（task-mvnenrwk，epic task-mvnem59t 子卡 2/6）：task_decompose + outputSchema 提案 + host 物化 =====
// 断言清单（对应任务验收口径）：
//   ① DECOMPOSE_SCHEMA 常量形状（白名单字段 / required / enum / 上限常量）
//   ② task_decompose 门禁：子代理拒 + 源卡状态门禁（draft/pending 以外拒）+ 在跑幂等拒 + spawn 接线
//   ③ mock 桩全链：startActivation(delivery=caller + outputSchema 透传) → result.structured=split
//      → draft 子卡落位（size/model/touches/acceptance/dependsOn 序号→真实 id）+ 源卡消息 + 通知
//   ④ verdict=keep（源卡记 rationale、零子卡）与 structured 缺失（失败消息+通知、零子卡）两条路径
//   ⑤ 幂等重拆：旧 draft 提案批清除、已发布旧提案保留、失败不毁旧批、keep 清残留 draft
//   ⑤b dependsOn 序号接线（task-mvr44rm3）：'1' 起序号→真实 id+顺序=引用顺序；坏序号丢弃+子卡 messages 留痕；无依赖零影响
//   ⑥ decomposer 不占 activeW（poolCycle：活跃 decomposer rec 下 pending 卡照常派 Worker）
//      + 拆解期源卡不被派 Worker（skip-decomposing 守卫）+ recIsLive 不回收在跑 decomposer
//   ⑦ 物化子卡自带调研包（task-mvnrtpxo）：context.files 自动 = touches（拆解官调研结论），
//      epic 发布预检 epicPrecheck 不再对拆解子卡报「无调研包」missing
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DECOMPOSE_SCHEMA, DECOMPOSE_MAX_CHILDREN, buildDecomposerPrompt, applyDecomposeProposal, TEAM_DECOMPOSE_FLOW } from '../lib/policy.mjs'
import { epicPrecheck, epicPrecheckNote } from '../lib/core.mjs'
import { createDispatch } from '../lib/dispatch.mjs'
import { createRpc } from '../lib/rpc.mjs'

var SID = 'session-test-0000-0000-000000000000'

function mkTask(over) {
  return Object.assign({ id: 't1', title: 'T', description: '', status: 'draft', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', history: [], messages: [] }, over || {})
}
function mkBoard(tasks, over) { return Object.assign({ version: 12, ownerSession: SID, boardMode: 'auto', maxWorkers: 3, tasks: tasks || [] }, over || {}) }

// ===== dispatch harness：稳定 runs 表（settleRun 认领守卫要求同一张表）+ pushSysNote 记录 =====
function mkDispatch(board, ctxOver, depsOver) {
  var runs = {}
  var notes = []
  var dispatch = createDispatch(
    Object.assign({ fs: {}, effect: function () {}, get: function () { return null } }, ctxOver || {}),
    { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} },
    Object.assign({
      rt: async function () { return board },
      wt: async function () {},
      mutateLocked: async function (sid, fn) { return fn(board) },
      kickCycle: function () {},
      rootForSession: function () { return { id: SID } },
      sessionCwd: function () { return '' }, withTimeout: function (p) { return p }, runsFor: function () { return runs }, feedbackOn: function () { return true },
      pushSysNote: function (sid, text, taskId) { notes.push({ text: text, taskId: taskId || null }) },
      maybeNotify: function () {}, notifyTaskDone: function () {},
    }, depsOver || {}))
  return { dispatch: dispatch, runs: runs, notes: notes }
}
// 新宿主桩（spawn-activation.test.mjs 同形）：startActivation 记录 spec，result 直接落定注入值
function mkDecomposeSubagents(calls, resultValue, opts) {
  opts = opts || {}
  return {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function (spec) {
      calls.push(spec)
      if (opts.failFirst) { opts.failFirst = false; throw new Error('outputSchema unsupported') }
      return { childId: 'dec-' + calls.length, messageId: 'msg-' + calls.length, result: Promise.resolve(resultValue), dispose: async function () {} }
    },
    interrupt: function () {},
    // 刻意不带 start/startContinuable——误走旧路径必然 TypeError 炸出
  }
}
function tick() { return new Promise(function (r) { setTimeout(r, 50) }) }

// ===== 宿主 assertObjectJsonSchema 子集校验镜像（task-mvnenrwk 驳回回归锁的地基）=====
// 插件不依赖 dsh-tools（CI 环境无宿主 node_modules），此处按宿主 0.2.1-rc.3 的
// dsh-tools/lib/types/json-schema.js checkSchemaNode 逐条复刻强制子集规则：
//   白名单键（type/oneOf/properties/required/additionalProperties/items/enum/const + 注解键）、
//   约束键必须伴 type/oneOf（223-228 行——本次驳回的元凶）、enum 仅标量且值型匹配、
//   required 必须落在 properties 内、oneOf ≥2 且禁兄弟约束键、根须 type:'object'（object-rooted）。
// 镜像本身也被锁：①b 用「旧版缺 type 的破形」反证它必然报出宿主同款违规文案——镜像失效会立刻红。
var SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
var CONSTRAINT_KEYS = { type: 1, oneOf: 1, properties: 1, required: 1, additionalProperties: 1, items: 1, enum: 1, const: 1 }
var ANNOTATION_KEYS = { description: 1, title: 1, default: 1, examples: 1 }
var ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
function hostSchemaViolations(schema) {
  var violations = []
  function has(n, k) { return Object.prototype.hasOwnProperty.call(n, k) }
  function walk(node, path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { violations.push(path + ' must be a schema object'); return }
    Object.keys(node).forEach(function (k) {
      if (!CONSTRAINT_KEYS[k] && !ANNOTATION_KEYS[k]) violations.push(path + '.' + k + ' is not a supported keyword')
    })
    var hasType = has(node, 'type'), hasOneOf = has(node, 'oneOf')
    if (hasType && hasOneOf) { violations.push(path + ' cannot declare both type and oneOf'); return }
    if (!hasType && !hasOneOf) {
      ONE_OF_SIBLINGS.forEach(function (k) { if (has(node, k)) violations.push(path + '.' + k + ' requires type or oneOf') })
      return
    }
    if (hasOneOf) {
      ONE_OF_SIBLINGS.forEach(function (k) { if (has(node, k)) violations.push(path + '.' + k + ' is not supported beside oneOf') })
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(path + '.oneOf must be an array of at least two schemas')
      else node.oneOf.forEach(function (b, i) { walk(b, path + '.oneOf[' + i + ']') })
      return
    }
    var t = node.type
    if (typeof t !== 'string' || SCHEMA_TYPES.indexOf(t) < 0) { violations.push(path + '.type must be one of ' + SCHEMA_TYPES.join('/')); return }
    var allowedFor = { properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'], enum: ['string', 'number', 'integer', 'boolean', 'null'], const: ['string', 'number', 'integer', 'boolean', 'null'] }
    Object.keys(allowedFor).forEach(function (k) { if (has(node, k) && allowedFor[k].indexOf(t) < 0) violations.push(path + '.' + k + ' is not supported on type "' + t + '"') })
    if (t === 'object') {
      if (has(node, 'required')) {
        if (!Array.isArray(node.required) || node.required.some(function (x) { return typeof x !== 'string' })) violations.push(path + '.required must be an array of strings')
        else node.required.forEach(function (k) { if (!node.properties || !has(node.properties, k)) violations.push(path + '.required names "' + k + '" which is not in properties') })
      }
      if (has(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') violations.push(path + '.additionalProperties must be a boolean')
      if (has(node, 'properties')) {
        if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) violations.push(path + '.properties must be an object of schemas')
        else Object.keys(node.properties).forEach(function (k) { walk(node.properties[k], path + '.properties.' + k) })
      }
    }
    if (t === 'array' && has(node, 'items')) walk(node.items, path + '.items')
    if (['string', 'number', 'integer', 'boolean', 'null'].indexOf(t) >= 0 && has(node, 'enum')) {
      var ok = Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every(function (v) {
        if (t === 'string') return typeof v === 'string'
        if (t === 'number') return typeof v === 'number' && isFinite(v)
        if (t === 'integer') return typeof v === 'number' && isFinite(v) && Math.floor(v) === v
        if (t === 'boolean') return typeof v === 'boolean'
        return v === null
      })
      if (!ok) violations.push(path + '.enum must be a non-empty array of ' + t + ' values')
    }
  }
  walk(schema, 'schema')
  if (!violations.length && (!schema || typeof schema !== 'object' || schema.type !== 'object')) violations.push('schema.type must be "object" (structured output is object-rooted)')
  return violations
}

// ===== ① DECOMPOSE_SCHEMA 常量形状 =====
test('① DECOMPOSE_SCHEMA 常量形状：白名单字段 / required / enum / 上限常量', function () {
  assert.equal(DECOMPOSE_SCHEMA.type, 'object')
  assert.deepEqual(DECOMPOSE_SCHEMA.required, ['verdict', 'children'])
  var props = DECOMPOSE_SCHEMA.properties
  assert.deepEqual(props.verdict.enum, ['split', 'keep'])
  assert.equal(props.children.type, 'array')
  var item = props.children.items
  assert.equal(item.type, 'object')
  assert.deepEqual(item.required, ['title', 'size', 'touches', 'acceptance', 'description'])
  assert.deepEqual(item.properties.size.enum, ['light', 'standard', 'heavy'])
  assert.equal(item.properties.title.type, 'string')
  assert.equal(item.properties.description.type, 'string')
  assert.equal(item.properties.acceptance.type, 'string')
  assert.equal(item.properties.modelHint.type, 'string')
  assert.deepEqual(item.properties.touches, { type: 'array', items: { type: 'string' } })
  assert.deepEqual(item.properties.dependsOn, { type: 'array', items: { type: 'string' } })
  assert.equal(props.rationale.type, 'string')
  // 白名单字段核验（递归收集 schema 键，不得出现 type/properties/required/items/enum 以外的键）
  var allowed = { type: 1, properties: 1, required: 1, items: 1, enum: 1 }
  ;(function walk(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    Object.keys(node).forEach(function (k) {
      if (k === 'properties') { var ps = node.properties; Object.keys(ps).forEach(function (pk) { walk(ps[pk]) }); return }
      if (k === 'items') { walk(node.items); return }
      assert.ok(allowed[k], 'schema 出现白名单外字段: ' + k)
    })
  })(DECOMPOSE_SCHEMA)
  assert.equal(DECOMPOSE_MAX_CHILDREN, 8)
  // buildDecomposerPrompt 契约关键点（写死纪律在位）
  var p = buildDecomposerPrompt(mkTask({ id: 'e9', title: '大', description: '做点大事', acceptance: 'npm test' }), '')
  assert.match(p, /拆解官/)
  assert.match(p, /e9 · 大/)
  assert.match(p, /npm test/)
  assert.match(p, /实现侧/)
  assert.match(p, /10~30 分钟/)
  assert.match(p, /有先后顺序时用 dependsOn 引用同批序号/)
  assert.match(p, /没有任何建卡工具/)
})

// ===== ①b DECOMPOSE_SCHEMA 过宿主 assertObjectJsonSchema 子集校验（task-mvnenrwk 驳回回归锁）=====
// 驳回实证：verdict/size 的 enum 缺 type 被宿主 @deepseek-ai/dsh 0.2.1-rc.3 直接拒收
// （startActivation → assertObjectJsonSchema 同步抛 JsonSchemaError → 剥 outputSchema 裸重试 →
// result.structured 永缺 → host 物化在生产完全不可达）。修复=enum 伴 type；本条锁死该回归。
test('①b DECOMPOSE_SCHEMA 过宿主子集校验镜像 + 镜像能逮住 enum 缺 type 回归', function () {
  // 修复后的 schema：零违规（宿主 assertObjectJsonSchema 同口径——本地已用真宿主模块复验，见任务自测）
  assert.deepEqual(hostSchemaViolations(DECOMPOSE_SCHEMA), [], 'DECOMPOSE_SCHEMA 必须过宿主 assertObjectJsonSchema 子集（enum 伴 type 等）')
  // 镜像自检 1：旧版破形（verdict enum 缺 type）必须报出宿主原话——镜像若退化此断言立刻红
  var broken = { type: 'object', required: ['verdict'], properties: { verdict: { enum: ['split', 'keep'] } } }
  assert.ok(hostSchemaViolations(broken).indexOf('schema.properties.verdict.enum requires type or oneOf') >= 0, '镜像必须逮住 enum 缺 type（宿主原话）')
  // 镜像自检 2：children.items.properties.size 同款破形（嵌套路径也要报对位置）
  var broken2 = { type: 'object', properties: { children: { type: 'array', items: { type: 'object', properties: { size: { enum: ['light'] } } } } } }
  assert.ok(hostSchemaViolations(broken2).indexOf('schema.properties.children.items.properties.size.enum requires type or oneOf') >= 0)
  // 镜像自检 3：enum 值型不匹配声明 type 也拒（宿主规则：enum 必须全是 type 型值）
  var badEnum = { type: 'object', properties: { size: { type: 'string', enum: ['light', 1] } } }
  assert.ok(hostSchemaViolations(badEnum).some(function (v) { return /enum must be a non-empty array of string values/.test(v) }))
  // 镜像自检 4：白名单外键 / required 指空 / 根非 object 三经典违规
  assert.ok(hostSchemaViolations({ type: 'object', properties: { a: { type: 'string', minLength: 1 } } }).some(function (v) { return /minLength is not a supported keyword/.test(v) }))
  assert.ok(hostSchemaViolations({ type: 'object', required: ['ghost'], properties: {} }).some(function (v) { return /required names "ghost" which is not in properties/.test(v) }))
  assert.ok(hostSchemaViolations({ type: 'array', items: { type: 'string' } }).indexOf('schema.type must be "object" (structured output is object-rooted)') >= 0)
})

// ===== RPC harness（与 lane-models.test.mjs mkRpcHandlers 同形）=====
function mkRpcHandlers(board, extra, ctxExtra) {
  var state = { handlers: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {} }
  var tools = {}
  var ctx = Object.assign({ tools: { register: function (t) { tools[t.name] = t } }, effect: function () {}, webServer: { register: function () { return function () {} } } }, ctxExtra || {})
  var deps = Object.assign({
    getActorId: function () { return 'tester' }, resolveRoot: function (x) { return x },
    toolSessionId: function () { return SID }, rpcSessionId: function () { return SID },
    rootForSession: function () { return null }, deriveWorkMode: function () { return 'solo' }, runsFor: function () { return {} },
    rt: async function () { return board }, mutateLocked: async function (sid, fn) { return fn(board) },
    maybeNotify: function () {}, notifyTaskDone: function () {},
    spawnOneShot: function () {}, accumulateRunUsage: function () {}, readContextPack: async function () { return null },
    pushSysNote: function () {}, sessionCwd: function () { return '' },
  }, extra || {})
  createRpc(ctx, state, deps)
  state.handlers.__tools = tools
  return state.handlers
}

// ===== ② task_decompose 门禁与 spawn 接线 =====
test('② task_decompose 门禁：子代理拒 + 源卡状态门禁 + 在跑幂等拒 + spawn 接线', async function () {
  var board = mkBoard([mkTask({ id: 't1', status: 'draft' })])
  var spawned = []
  var h = mkRpcHandlers(board, {
    spawnOneShot: async function (sid, t, role) { spawned.push({ taskId: t.id, role: role }); return { id: 'dec-run-1' } },
  })
  var td = h.__tools['task_decompose']
  assert.ok(td, 'task_decompose 已注册')
  // 子代理拒（resolveRoot(actor) !== actor，与 task_create 同款门禁）
  var hSub = mkRpcHandlers(board, { getActorId: function () { return 'child-x' }, resolveRoot: function () { return 'root-y' } })
  var r0 = await hSub.__tools['task_decompose'].execute({ taskId: 't1' })
  assert.equal(r0.ok, false); assert.match(r0.error, /仅主窗口/)
  // 不存在
  var r1 = await td.execute({ taskId: 'nope' })
  assert.equal(r1.ok, false); assert.match(r1.error, /not found/)
  // 状态门禁：in-progress / verifying / resolved 一律拒
  var bad = ['in-progress', 'verifying', 'resolved']
  for (var i = 0; i < bad.length; i++) {
    var b2 = mkBoard([mkTask({ id: 't1', status: bad[i] })])
    var h2 = mkRpcHandlers(b2, { spawnOneShot: async function () { return { id: 'x' } } })
    var rr = await h2.__tools['task_decompose'].execute({ taskId: 't1' })
    assert.equal(rr.ok, false, bad[i] + ' 应被拒')
    assert.match(rr.error, /draft\/pending/)
  }
  // 正常：draft 源卡 → spawnOneShot(role='decomposer')，返回 runId
  var r2 = await td.execute({ taskId: 't1' })
  assert.equal(r2.ok, true)
  assert.equal(r2.runId, 'dec-run-1')
  assert.deepEqual(spawned, [{ taskId: 't1', role: 'decomposer' }])
  // pending 源卡同样放行
  var b3 = mkBoard([mkTask({ id: 't2', status: 'pending' })])
  var h3 = mkRpcHandlers(b3, { spawnOneShot: async function () { return { id: 'dec-run-2' } } })
  var r3 = await h3.__tools['task_decompose'].execute({ taskId: 't2' })
  assert.equal(r3.ok, true)
  // 在跑幂等拒：活跃表已有未 settled 的 decomposer rec
  var runs4 = { t1: { id: 'dec-run-1', role: 'decomposer', taskId: 't1', settled: false } }
  var h4 = mkRpcHandlers(board, { runsFor: function () { return runs4 }, spawnOneShot: async function () { throw new Error('不该被调') } })
  var r4 = await h4.__tools['task_decompose'].execute({ taskId: 't1' })
  assert.equal(r4.ok, false); assert.match(r4.error, /已在运行中/)
  // spawn 失败（返回 null）→ 显式错误
  var h5 = mkRpcHandlers(board, { spawnOneShot: async function () { return null } })
  var r5 = await h5.__tools['task_decompose'].execute({ taskId: 't1' })
  assert.equal(r5.ok, false); assert.match(r5.error, /spawn 失败/)
})

// ===== ③ mock 桩全链：structured=split → draft 子卡落位 + 源卡消息 + 通知 =====
test('③ 全链：startActivation(caller + outputSchema) → structured=split → draft 子卡物化', async function () {
  var src = mkTask({ id: 'epic1', title: '大任务', status: 'draft', description: '做点大事' })
  var board = mkBoard([src])
  var calls = []
  var proposal = {
    verdict: 'split',
    rationale: '两个文件族天然可切',
    children: [
      { title: '子卡A', description: '做 A', size: 'light', touches: ['lib/a.mjs'], acceptance: 'node --test test/a.test.mjs' },
      { title: '子卡B', description: '做 B', size: 'heavy', modelHint: 'kimi/kimi-k3', touches: ['lib/b.mjs'], acceptance: 'node --test test/b.test.mjs', dependsOn: ['1'] },
    ],
  }
  var h = mkDispatch(board, { subagents: mkDecomposeSubagents(calls, { output: [{ type: 'text', text: '提案完毕' }], stopReason: 'completed', structured: proposal }) })
  var rec = await h.dispatch.spawnOneShot(SID, src, 'decomposer')
  assert.ok(rec, 'spawn 成功')
  assert.equal(rec.role, 'decomposer')
  assert.equal(rec.continuable, undefined, 'decomposer 恒走一次性路径')
  // spawn 面：delivery=caller + outputSchema 透传 + request 剥 label/signal（新契约）
  assert.equal(calls.length, 1)
  assert.equal(calls[0].delivery, 'caller')
  assert.deepEqual(calls[0].request.outputSchema, DECOMPOSE_SCHEMA)
  assert.equal(calls[0].request.label, undefined)
  assert.equal(calls[0].request.signal, undefined)
  assert.ok(calls[0].request.prompt[0].text.indexOf('拆解官') >= 0, 'prompt 是拆解官契约')
  // 活跃表登记（键=源卡 id）
  assert.equal(h.runs['epic1'], rec)
  await tick()
  // 子卡物化：draft + parentId + proposalOf + 字段落位
  var kids = board.tasks.filter(function (x) { return x.parentId === 'epic1' })
  assert.equal(kids.length, 2)
  var a = kids[0], b = kids[1]
  assert.equal(a.status, 'draft'); assert.equal(a.proposalOf, 'epic1')
  assert.equal(a.title, '子卡A'); assert.equal(a.size, 'light')
  assert.deepEqual(a.touches, ['lib/a.mjs']); assert.equal(a.acceptance, 'node --test test/a.test.mjs')
  assert.equal('model' in a, false, 'modelHint 空不落 model 字段')
  assert.deepEqual(a.dependsOn, [])
  assert.equal(a.pipeline, 'full'); assert.equal(a.pipelineAuto, true)
  // 物化子卡自带调研包（task-mvnrtpxo）：context.files 自动 = touches（拆解官定的 touches 就是它的调研结论），
  // context.notes 留空（description 已含实现侧结论，不重复复制）
  assert.deepEqual(a.context.files, ['lib/a.mjs'], '物化子卡 context.files === touches')
  assert.deepEqual(b.context.files, ['lib/b.mjs'])
  assert.equal(a.context.notes, '', 'notes 留空不重复 description')
  assert.equal(b.context.notes, '')
  assert.equal(b.size, 'heavy'); assert.equal(b.model, 'kimi/kimi-k3', 'modelHint 落 model')
  assert.deepEqual(b.dependsOn, [a.id], "dependsOn['1'] 序号翻译成本批真实 id")
  assert.equal(b.history[0].actor, 'decomposer')
  assert.ok(b.id.indexOf('epic1-') === 0, '子卡 id 由源卡派生')
  // 源卡：状态不变 + 摘要消息 + run 留档关账
  assert.equal(src.status, 'draft', '源卡状态不变')
  var dmsg = src.messages.filter(function (m) { return m.kind === 'decompose' })
  assert.equal(dmsg.length, 1); assert.match(dmsg[0].text, /拆解提案已就位（2 张草稿子卡）/)
  var drec = src.runs.filter(function (r) { return r.role === 'decomposer' })
  assert.equal(drec.length, 1); assert.equal(drec[0].outcome, 'completed')
  // 通知：pushSysNote 送达且不带 taskId（源卡 draft，带 taskId 会被回执冲刷过滤丢弃）
  assert.ok(h.notes.some(function (n) { return /拆解提案已就位/.test(n.text) && n.taskId === null }), 'pushSysNote 不带 taskId 送达')
  // 活跃表已摘除（结算链收口）
  assert.equal(h.runs['epic1'], undefined)
})

// ===== ③b spawn 外挂参数回退：provider 拒 outputSchema → 剥离重试 =====
test('③b outputSchema 不被支持时剥外挂参数重试（不炸主流程）', async function () {
  var src = mkTask({ id: 'epic2', status: 'draft' })
  var board = mkBoard([src])
  var calls = []
  var origErr = console.error; console.error = function () {} // 压掉回退日志
  try {
    var h = mkDispatch(board, { subagents: mkDecomposeSubagents(calls, { output: [], stopReason: 'completed', structured: { verdict: 'keep', children: [], rationale: '小' } }, { failFirst: true }) })
    var rec = await h.dispatch.spawnOneShot(SID, src, 'decomposer')
    assert.ok(rec, '回退后 spawn 成功')
    assert.equal(calls.length, 2, '首败后重试一次')
    assert.deepEqual(calls[0].request.outputSchema, DECOMPOSE_SCHEMA, '首次带 outputSchema')
    assert.equal(calls[1].request.outputSchema, undefined, '重试剥掉 outputSchema')
  } finally { console.error = origErr }
})

// ===== ④ verdict=keep 与 structured 缺失两条路径 =====
test('④ verdict=keep（记 rationale 零子卡）与 structured 缺失（失败消息+通知零子卡）', async function () {
  // keep：源卡记「无需拆分：rationale」，零子卡，状态不变
  var src1 = mkTask({ id: 'k1', status: 'pending' })
  var board1 = mkBoard([src1])
  var calls1 = []
  var h1 = mkDispatch(board1, { subagents: mkDecomposeSubagents(calls1, { output: [], stopReason: 'completed', structured: { verdict: 'keep', children: [], rationale: '单点小改不必拆' } }) })
  await h1.dispatch.spawnOneShot(SID, src1, 'decomposer')
  await tick()
  assert.equal(board1.tasks.length, 1, 'keep 不产子卡')
  assert.equal(src1.status, 'pending', '源卡状态不变')
  var m1 = src1.messages.filter(function (m) { return m.kind === 'decompose' })
  assert.equal(m1.length, 1); assert.match(m1[0].text, /无需拆分：单点小改不必拆/)
  assert.ok(h1.notes.some(function (n) { return /无需拆分/.test(n.text) }), 'keep 通知送达')
  // structured 缺失：源卡记失败原因 + 通知，零子卡
  var src2 = mkTask({ id: 'k2', status: 'draft' })
  var board2 = mkBoard([src2])
  var calls2 = []
  var h2 = mkDispatch(board2, { subagents: mkDecomposeSubagents(calls2, { output: [{ type: 'text', text: '我自由发挥了' }], stopReason: 'completed' }) })
  await h2.dispatch.spawnOneShot(SID, src2, 'decomposer')
  await tick()
  assert.equal(board2.tasks.length, 1, 'structured 缺失不产子卡')
  var m2 = src2.messages.filter(function (m) { return m.kind === 'decompose' })
  assert.equal(m2.length, 1); assert.match(m2[0].text, /structured 缺失/)
  assert.ok(h2.notes.some(function (n) { return /未产出可用提案/.test(n.text) }), '失败通知送达')
  // run 失败臂：stopReason=error → 源卡记失败原因
  var src3 = mkTask({ id: 'k3', status: 'draft' })
  var board3 = mkBoard([src3])
  var calls3 = []
  var h3 = mkDispatch(board3, { subagents: mkDecomposeSubagents(calls3, { output: [], stopReason: 'error', diagnostic: 'boom' }) })
  await h3.dispatch.spawnOneShot(SID, src3, 'decomposer')
  await tick()
  var m3 = src3.messages.filter(function (m) { return m.kind === 'decompose' })
  assert.equal(m3.length, 1); assert.match(m3[0].text, /拆解官 run 失败/)
  assert.equal(board3.tasks.length, 1)
})

// ===== ⑤ 幂等重拆：旧 draft 提案批清除、已发布旧提案保留、失败不毁旧批、keep 清残留 =====
test('⑤ 幂等重拆：applyDecomposeProposal 清旧批 draft / 保留已发布 / 失败不毁旧批', function () {
  var src = mkTask({ id: 'r1', status: 'draft' })
  var board = mkBoard([src])
  var r1 = applyDecomposeProposal(board, src, { verdict: 'split', children: [{ title: '旧A', description: '', size: 'standard', touches: [], acceptance: 'x' }] }, '2026-01-01T01:00:00Z')
  assert.equal(r1.ok, true); assert.equal(r1.children.length, 1)
  // 重拆：新提案落地 → 旧 draft 提案被清（id 是派生量会被新批复用，按标题认旧批），新批落位
  var r2 = applyDecomposeProposal(board, src, { verdict: 'split', children: [{ title: '新A', description: '', size: 'light', touches: [], acceptance: 'y' }, { title: '新B', description: '', size: 'standard', touches: [], acceptance: 'z', dependsOn: ['1'] }] }, '2026-01-01T02:00:00Z')
  assert.equal(r2.ok, true); assert.equal(r2.children.length, 2)
  assert.ok(!board.tasks.some(function (x) { return x.title === '旧A' }), '旧 draft 提案被清')
  assert.equal(board.tasks.filter(function (x) { return x.parentId === 'r1' }).length, 2)
  // 已 publish 的旧提案子卡（status!=draft）绝不清
  var newA = board.tasks.find(function (x) { return x.title === '新A' })
  newA.status = 'pending' // 模拟已 publish
  var r3 = applyDecomposeProposal(board, src, { verdict: 'split', children: [{ title: '第三代', description: '', size: 'standard', touches: [], acceptance: 'w' }] }, '2026-01-01T03:00:00Z')
  assert.equal(r3.ok, true)
  assert.ok(board.tasks.some(function (x) { return x.title === '新A' && x.status === 'pending' }), '已发布提案子卡不被清')
  assert.ok(!board.tasks.some(function (x) { return x.title === '新B' }), '未发布旧批仍被清')
  // 失败不毁旧批：畸形提案（children 空）→ 现有提案原样保留
  var before = board.tasks.length
  var r4 = applyDecomposeProposal(board, src, { verdict: 'split', children: [] }, '2026-01-01T04:00:00Z')
  assert.equal(r4.ok, false)
  assert.equal(board.tasks.length, before, '失败路径不清旧批')
  assert.match(src.messages[src.messages.length - 1].text, /children 为空/)
  // keep 也清残留 draft 提案（最新判定=不拆）
  var r5 = applyDecomposeProposal(board, src, { verdict: 'keep', children: [], rationale: '算了' }, '2026-01-01T05:00:00Z')
  assert.equal(r5.ok, true); assert.equal(r5.verdict, 'keep')
  assert.ok(!board.tasks.some(function (x) { return x.proposalOf === 'r1' && x.status === 'draft' }), 'keep 清掉残留 draft 提案')
  // 上限截断：9 张提案 → 只落 8 张
  var many = []
  for (var i = 0; i < 9; i++) many.push({ title: '批' + i, description: '', size: 'standard', touches: [], acceptance: 'c' + i })
  var r6 = applyDecomposeProposal(board, src, { verdict: 'split', children: many }, '2026-01-01T06:00:00Z')
  assert.equal(r6.children.length, 8, 'children 上限 8 截断')
  // dependsOn 序号防御（task-mvr44rm3）：非法/越界/自引用/后排序号一律丢弃 + 该子卡 messages 留痕（本批无环）
  var board2 = mkBoard([mkTask({ id: 'r2', status: 'draft' })])
  var src2 = board2.tasks[0]
  applyDecomposeProposal(board2, src2, { verdict: 'split', children: [
    { title: 'A0', description: '', size: 'standard', touches: [], acceptance: 'a', dependsOn: ['0', '1', '2', '9', '-1', 'x'] },
    { title: 'B1', description: '', size: 'standard', touches: [], acceptance: 'b', dependsOn: ['2', '1', '1'] },
  ] }, '2026-01-01T07:00:00Z')
  var a0 = board2.tasks.find(function (x) { return x.title === 'A0' })
  var b1 = board2.tasks.find(function (x) { return x.title === 'B1' })
  assert.deepEqual(a0.dependsOn, [], '首卡无前排可引：自/越界/负数/非数字序号全丢')
  assert.ok(a0.messages.some(function (m) { return m.kind === 'decompose' && /依赖序号无法解析/.test(m.text) }), '坏序号在该子卡 messages 留痕')
  assert.deepEqual(b1.dependsOn, [a0.id], '只收前排序号（去重）')
  assert.ok(b1.messages.some(function (m) { return m.kind === 'decompose' && /依赖序号无法解析/.test(m.text) }), '自引用序号丢弃+留痕')
})

// ===== ⑤b dependsOn 序号接线（task-mvr44rm3 定稿）：同批序号引用物化为真实任务 id =====
test('⑤b dependsOn 序号引用：真实 id 映射+顺序=引用顺序+坏序号丢弃留痕+无依赖零影响', function () {
  // ① 有效序号引用：['1','2'] 指本批第 1/2 张提案，映射真实 id，deps 顺序=引用顺序
  var src = mkTask({ id: 'w1', status: 'draft' })
  var board = mkBoard([src])
  var r = applyDecomposeProposal(board, src, { verdict: 'split', children: [
    { title: '基建', description: '', size: 'standard', touches: [], acceptance: 'a' },
    { title: '中游', description: '', size: 'standard', touches: [], acceptance: 'b', dependsOn: ['1'] },
    { title: '下游', description: '', size: 'standard', touches: [], acceptance: 'c', dependsOn: ['2', '1'] },
  ] }, '2026-01-01T01:00:00Z')
  assert.equal(r.ok, true)
  var k1 = board.tasks.find(function (x) { return x.title === '基建' })
  var k2 = board.tasks.find(function (x) { return x.title === '中游' })
  var k3 = board.tasks.find(function (x) { return x.title === '下游' })
  assert.deepEqual(k1.dependsOn, [], '无依赖提案零影响')
  assert.deepEqual(k2.dependsOn, [k1.id], "序号 '1' → 本批第 1 张真实 id")
  assert.deepEqual(k3.dependsOn, [k2.id, k1.id], '序号引用映射为真实 id 且顺序=引用顺序')
  assert.equal(k1.messages.length, 0, '有效/无引用不产生留痕消息')
  // ② 坏序号：越界/非数字丢弃 + 该子卡 messages 留一条「依赖序号无法解析」；有效序号照常映射
  var board3 = mkBoard([mkTask({ id: 'w2', status: 'draft' })])
  var src3 = board3.tasks[0]
  var r3 = applyDecomposeProposal(board3, src3, { verdict: 'split', children: [
    { title: '甲', description: '', size: 'standard', touches: [], acceptance: 'a', dependsOn: ['9', 'abc'] },
    { title: '乙', description: '', size: 'standard', touches: [], acceptance: 'b', dependsOn: ['1', '5', 'x'] },
  ] }, '2026-01-01T02:00:00Z')
  assert.equal(r3.ok, true, '坏序号不阻断物化')
  var jia = board3.tasks.find(function (x) { return x.title === '甲' })
  var yi = board3.tasks.find(function (x) { return x.title === '乙' })
  assert.deepEqual(jia.dependsOn, [], '越界/非数字序号丢弃')
  assert.deepEqual(yi.dependsOn, [jia.id], '混合：有效序号照常映射')
  var tj = jia.messages.filter(function (m) { return m.kind === 'decompose' && /依赖序号无法解析/.test(m.text) })
  assert.equal(tj.length, 1, '子卡 messages 留一条「依赖序号无法解析」')
  assert.match(tj[0].text, /9、abc/, '留痕带坏序号明细')
  var ty = yi.messages.filter(function (m) { return m.kind === 'decompose' && /依赖序号无法解析/.test(m.text) })
  assert.equal(ty.length, 1, '后排溢出+非数字同样留痕')
  assert.match(ty[0].text, /5、x/, '留痕带坏序号明细')
})

// ===== ⑥ decomposer 不占 activeW + 拆解期源卡不派 Worker + recIsLive 不回收 =====
test('⑥ poolCycle：decomposer 计 activeV 不占 worker 位 + 源卡拆解期跳过派发', async function () {
  var src = mkTask({ id: 'src1', title: '待拆源卡', status: 'pending' })
  var w = mkTask({ id: 'w1', title: '普通待办', status: 'pending' })
  var board = mkBoard([src, w], { maxWorkers: 1 })
  var spawnCalls = []
  var h = mkDispatch(board, { subagents: {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function (spec) { spawnCalls.push(spec); return { childId: 'child-' + spawnCalls.length, messageId: 'm' + spawnCalls.length, result: new Promise(function () {}), dispose: async function () {} } },
    interrupt: function () {},
  } })
  // 预置活跃 decomposer rec（占住 src1）：若它被错算进 activeW，maxWorkers=1 下 w1 将派不出
  h.runs['src1'] = { id: 'dec-9', role: 'decomposer', taskId: 'src1', startedAt: Date.now(), settled: false, model: '', modelSource: 'parent' }
  await h.dispatch.poolCycle(SID)
  // w1 照常派出（continuable worker，delivery=parent）——decomposer 没占 worker 位
  assert.equal(spawnCalls.length, 1, 'w1 被派发（activeW 未被 decomposer 挤占）')
  assert.equal(spawnCalls[0].label, 'worker:w1')
  assert.equal(spawnCalls[0].delivery, 'parent')
  // 拆解期源卡不派 Worker（skip-decomposing 守卫）
  assert.equal(src.claimedBy, null); assert.equal(src.status, 'pending')
  // recIsLive：在跑 decomposer（pending 源卡）不被幽灵回收
  assert.ok(h.runs['src1'], 'decomposer rec 存活（未被 reapGhostRecs 误收）')
  assert.equal(h.runs['w1'].role, 'worker')
  // 池快照（锁内现算，只含本轮开始时已在跑的 run；w1 的 rec 在锁外 spawn 才登记，下轮才入快照）：
  // decomposer 归 verifiers 区（与 hook run 同格展示），workers 区不含它
  assert.equal(board.poolStatus.workers.length, 0, 'workers 区不含 decomposer')
  assert.equal(board.poolStatus.verifiers.length, 1)
  assert.equal(board.poolStatus.verifiers[0].taskId, 'src1')
})

// ===== ⑦ 物化子卡自带调研包（task-mvnrtpxo，task-mvnnkv7x epic 发布预检「无调研包」误报实证）=====
test('⑦ 物化子卡 context.files 自动 = touches；epicPrecheck 不再报 missing', function () {
  var src = mkTask({ id: 'p1', status: 'draft' })
  var board = mkBoard([src])
  var r = applyDecomposeProposal(board, src, { verdict: 'split', children: [
    { title: '子甲', description: '做甲', size: 'standard', touches: ['lib/a.mjs', 'test/a.test.mjs'], acceptance: 'x' },
    { title: '子乙', description: '做乙', size: 'standard', touches: [], acceptance: 'y' },
  ] }, '2026-01-01T01:00:00Z')
  assert.equal(r.ok, true)
  var ka = board.tasks.find(function (x) { return x.title === '子甲' })
  var kb = board.tasks.find(function (x) { return x.title === '子乙' })
  assert.deepEqual(ka.context.files, ['lib/a.mjs', 'test/a.test.mjs'], 'context.files === touches（保序）')
  assert.deepEqual(kb.context.files, [], 'touches 空则 files 空（不捏造）')
  assert.equal(ka.context.notes, '', 'notes 留空——description 已含实现侧结论')
  // 预检口径（core.mjs epicPrecheck）：files 非空即不算「无 contextFiles/contextNotes」——带 touches 的子甲出 missing 名单
  var pre = epicPrecheck(board.tasks, 'p1')
  assert.equal(pre.total, 2)
  assert.deepEqual(pre.missing.map(function (m) { return m.id }), [kb.id], '只有 touches 也为空的子乙仍报 missing')
  // 全部带 touches 时预检全绿：warning 文案为空串（task-mvnnkv7x 两张子卡误报不再触发）
  var board2 = mkBoard([mkTask({ id: 'p2', status: 'draft' })])
  applyDecomposeProposal(board2, board2.tasks[0], { verdict: 'split', children: [
    { title: '甲', description: '', size: 'standard', touches: ['lib/a.mjs'], acceptance: 'x' },
    { title: '乙', description: '', size: 'standard', touches: ['lib/b.mjs'], acceptance: 'y' },
  ] }, '2026-01-01T02:00:00Z')
  var pre2 = epicPrecheck(board2.tasks, 'p2')
  assert.equal(pre2.total, 2)
  assert.equal(pre2.missing.length, 0, '物化子卡自带 touches 调研包 → 预检零 missing')
  assert.equal(epicPrecheckNote(pre2), '', '预检全绿不产生 warning 文案')
})

// ===== ⑧ 拆解官可见性·数据面（task-mvomad6c，用户点菜 C「从没见过这个子 agent 触发」）=====
// ⑧a dispatch 池快照条目带 role（客户端择出 decomposer 的前提；桶归属/并发位语义不变）
// ⑧b rpc get-tasks 防幽灵过滤放行 decomposer（源卡恒 draft/pending 永不在活跃集，不放行必被摘——
//    池条隐形真根）；幽灵 worker/verifier 条目仍被摘（既有口径不变）
test('⑧ 数据面：poolStatus 条目带 role + get-tasks 防幽灵过滤放行 decomposer（幽灵照摘）', async function () {
  // ⑧a 行为级：活跃 decomposer rec → 池快照 verifiers 桶条目 role='decomposer'
  var src = mkTask({ id: 'src1', title: '待拆源卡', status: 'pending' })
  var board = mkBoard([src])
  var h = mkDispatch(board, { subagents: {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function () { throw new Error('不应 spawn（skip-decomposing 守卫拦住唯一 pending 卡）') },
    interrupt: function () {},
  } })
  h.runs['src1'] = { id: 'dec-1', role: 'decomposer', taskId: 'src1', startedAt: Date.now(), settled: false, model: '', modelSource: 'parent' }
  await h.dispatch.poolCycle(SID)
  assert.equal(board.poolStatus.workers.length, 0)
  assert.equal(board.poolStatus.verifiers.length, 1)
  assert.equal(board.poolStatus.verifiers[0].role, 'decomposer', '池快照条目带 role（客户端择出前提）')
  // 源码钉线：装配行透出 role
  var dsrc = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  assert.ok(dsrc.indexOf("role: rc.role || ''") >= 0, 'dispatch poolStatus 装配缺 role 透出')
  // ⑧b 行为级：get-tasks 过滤——decomposer（源卡 draft）豁免，幽灵 worker/verifier 照摘
  var b2 = mkBoard([mkTask({ id: 'src2', status: 'draft' })])
  b2.poolStatus = { workers: [{ id: 'w-g', busy: true, taskId: 'ghost-w' }], verifiers: [
    { id: 'v-live-dec', busy: true, taskId: 'src2', role: 'decomposer' },
    { id: 'v-ghost', busy: true, taskId: 'ghost-v', role: 'verifier' },
  ] }
  var h2 = mkRpcHandlers(b2)
  var got = await h2['get-tasks']({})
  assert.deepEqual(got.poolStatus.workers, [], '幽灵 worker 仍被摘（既有口径不变）')
  assert.equal(got.poolStatus.verifiers.length, 1, 'decomposer 条目豁免防幽灵过滤（源卡 draft 也留住）')
  assert.equal(got.poolStatus.verifiers[0].id, 'v-live-dec')
  assert.equal(got.poolStatus.verifiers[0].role, 'decomposer')
  // 源码钉线：豁免分支存在
  var rsrc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  assert.ok(rsrc.indexOf("__act[v.taskId] || v.role === 'decomposer'") >= 0, 'rpc 防幽灵过滤缺 decomposer 豁免')
})

// ===== ⑨ 拆解官可见性·GUI 源码断言（task-mvomad6c ①②③露出点）=====
test('⑨ GUI：池条「🧩 拆解中 ×N」+ 成员卡 🧩 拆解官 + 详情页 decomposer 行 + 卡面徽标接线', function () {
  var dash = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
  var bl = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  var td = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
  // ① 池条：role 择出 + 独立计数字段；Verifier 计数口径不变（含 decomposer 的并发位语义）
  assert.match(dash, /var decBusy = vBusy\.filter\(function \(v\) \{ return v\.role === 'decomposer' \}\)/, 'PoolStatus 缺 decomposer 择出')
  assert.ok(dash.indexOf("'🧩 拆解中 ×' + decBusy.length") >= 0, '池条缺「🧩 拆解中 ×N」字段')
  assert.match(dash, /var vActive = vBusy\.length/, 'Verifier 计数口径被动（应保持并发位语义）')
  // ①同族 TeamView 成员卡：decomposer 不再冒充「Verifier · 执行中」
  assert.ok(dash.indexOf("isDec ? '🧩 拆解官' : 'Verifier'") >= 0, '成员卡缺 🧩 拆解官标签')
  // ③ 详情页 runs 行：roleMeta.decomposer + 序数按角色分桶 + 在跑高亮 + title 耗时
  assert.ok(td.indexOf("decomposer: { label: '🧩', color: C.brand, tip: '拆解官' }") >= 0, '详情页 roleMeta 缺 decomposer 条目')
  assert.match(td, /var seqKey = roleMeta\[r\.role\] \? r\.role : 'worker'/, '详情页序数未按角色分桶')
  assert.ok(td.indexOf("r.role === 'decomposer' && r.outcome === 'running' && !r.endedAt") >= 0, '缺 decomposer 在跑高亮口径')
  assert.ok(td.indexOf("' · 耗时 ' + fmtDur(") >= 0, '详情页 runs 行 title 缺耗时展示')
  // ② 卡面徽标：纯函数 + Card 渲染接线
  assert.match(bl, /function decomposeBadgeOf\(t, allTasks\)/, '缺 decomposeBadgeOf 纯函数')
  assert.ok(bl.indexOf('decomposePhaseBadge(t),') >= 0, 'Card 徽标区未接 decomposePhaseBadge')
  // 归档行同族修正：runs 行 🧩 标签
  assert.ok(bl.indexOf("isD ? '拆解官' : 'Worker'") >= 0, '归档行 runs 缺拆解官标签')
})

// ===== ⑩ 卡面徽标三态行为级（decomposeBadgeOf 纯函数提取执行，与 lane-gui ②b 同手法）=====
test('⑩ decomposeBadgeOf 三态：在跑（含超龄守卫）/ 已提案 ×N / 无', function () {
  var bl = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
  var m = bl.match(/function decomposeBadgeOf\(t, allTasks\) \{[\s\S]*?\n    \}/)
  assert.ok(m, '未能从 board-list.js 提取 decomposeBadgeOf')
  var decomposeBadgeOf = new Function(m[0] + '\nreturn decomposeBadgeOf')()
  // 在跑：末条 decomposer 留档 running 无 endedAt 且未超龄
  var tRun = { id: 's1', runs: [{ role: 'decomposer', id: 'd1', at: new Date().toISOString(), outcome: 'running', hardMin: 120 }] }
  var b1 = decomposeBadgeOf(tRun, [tRun])
  assert.ok(b1 && b1.txt === '🧩 拆解中' && b1.tone === 'brand', '在跑 → 🧩 拆解中（brand 色）')
  // 超龄守卫：重启残留（at 3h 前 > hardMin 120min）不亮「拆解中」，无提案批 → null
  var tStale = { id: 's2', runs: [{ role: 'decomposer', id: 'd2', at: new Date(Date.now() - 3 * 3600000).toISOString(), outcome: 'running', hardMin: 120 }] }
  assert.equal(decomposeBadgeOf(tStale, [tStale]), null, '超龄 running 留档（重启残留）不亮拆解中')
  // 已提案：留档已关账 + 同板 2 张 proposalOf draft 子卡
  var tDone = { id: 's3', runs: [{ role: 'decomposer', id: 'd3', at: '2026-01-01T00:00:00Z', outcome: 'completed', endedAt: '2026-01-01T00:03:00Z' }] }
  var kids = [
    { id: 's3-1', parentId: 's3', proposalOf: 's3', status: 'draft' },
    { id: 's3-2', parentId: 's3', proposalOf: 's3', status: 'draft' },
  ]
  var b3 = decomposeBadgeOf(tDone, [tDone].concat(kids))
  assert.ok(b3 && b3.txt === '🧩 已提案 ×2' && b3.tone === 'warn', '已提案 ×N（draft 提案批计数，warn 色）')
  // 提案全发布（draft→pending）→ 徽标熄灭
  var kidsPub = kids.map(function (k) { return Object.assign({}, k, { status: 'pending' }) })
  assert.equal(decomposeBadgeOf(tDone, [tDone].concat(kidsPub)), null, '提案批全发布后徽标熄灭')
  // 无：从未拆解（无 runs）/ 有 runs 但无 decomposer / 失败且无提案批
  assert.equal(decomposeBadgeOf({ id: 's4' }, []), null, '无 runs 字段 → null')
  assert.equal(decomposeBadgeOf({ id: 's5', runs: [{ role: 'worker', id: 'w1', outcome: 'completed' }] }, []), null, '无 decomposer 留档 → null')
  var tFail = { id: 's6', runs: [{ role: 'decomposer', id: 'd6', at: '2026-01-01T00:00:00Z', outcome: 'timeout/error', endedAt: '2026-01-01T00:01:00Z' }] }
  assert.equal(decomposeBadgeOf(tFail, [tFail]), null, '失败且无提案批 → null（失败原因由源卡消息承载）')
})

// ===== ⑪ 产物标记（task-mvomad6c：改完源必须重组装，pretest 已挂 build-client）=====
test('⑪ 产物：lib/client.js 含拆解官可见性标记', function () {
  var built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const mk of ['🧩 拆解中 ×', '🧩 已提案 ×', 'decomposeBadgeOf', "tip: '拆解官'"]) {
    assert.ok(built.indexOf(mk) >= 0, 'client.js 缺标记：' + mk + '（需 npm run build-client 重组装）')
  }
})

// ===== ⑫ Team 第 9 条补漏（task-mvoutja4）：已有设计稿也必须走拆解官 =====
// 补漏款焊死「我已经设计好了」的绕过缝隙：命中拆分树信号的需求即使主窗口已在讨论中形成设计稿，
// 也一律走拆解官——设计稿写进需求卡 contextNotes 作为参考方案，拆解官验证/修正而非从零重来。
test('⑫ 第 9 条已有设计稿款（TEAM_DECOMPOSE_FLOW）：补漏关键词在位 + 旧文案要点不丢', function () {
  // 补漏款三个关键语义逐字锁死：①中间态（已有设计稿）也走拆解官 ②设计稿进 contextNotes 当起点
  assert.match(TEAM_DECOMPOSE_FLOW, /即使主窗口已在讨论中形成设计稿/)
  assert.match(TEAM_DECOMPOSE_FLOW, /一律走拆解官/)
  assert.match(TEAM_DECOMPOSE_FLOW, /contextNotes 作为参考方案/)
  assert.match(TEAM_DECOMPOSE_FLOW, /验证\/修正设计而非从零重来/)
  // ③禁止绕过：以「我已经设计好了」为由整卡直派被明文禁止
  assert.match(TEAM_DECOMPOSE_FLOW, /禁止以/)
  assert.match(TEAM_DECOMPOSE_FLOW, /整卡直派/)
  // 旧文案要点仍在（core.test.mjs 既有拼接/注入位置断言口径不破：/^9\. 需求卡工作流/ 等）
  assert.match(TEAM_DECOMPOSE_FLOW, /^9\. 需求卡工作流/)
  assert.match(TEAM_DECOMPOSE_FLOW, /draft 需求卡（保留需求原文）/)
  assert.match(TEAM_DECOMPOSE_FLOW, /task_decompose/)
  assert.match(TEAM_DECOMPOSE_FLOW, /标题\/档位\/模型\/touches/)
  assert.match(TEAM_DECOMPOSE_FLOW, /统一 publish/)
  assert.match(TEAM_DECOMPOSE_FLOW, /最后防线/)
})
