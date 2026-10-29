// ===== 力度路由 GUI + 记分卡 bySize 档位维度（task-mvneq4mw）=====
// 断言清单（对应任务验收口径）：
//   ① 模型路由弹层「力度路由」小节：三档 × Worker/Verifier 共 6 个 OrderedModelsEditor 链编辑器
//     （task-mvokikl3：下拉添加+芯片 ×/↑ 排序，替代首选单选），写走 set-board-config key='laneModels'
//     部分合并、槽位写**整个有序数组**（非仅首选），空链=「继承板级」语义
//   ② laneModels state 透传：kernel fetchTasks 回读 + TopPanel 订阅 + PoolCfgPopover props 接线
//   ②b cfgKnobs 快照类型对称（验收驳回回归修复）：快照存原值，null→null 恒 false、真变化才 true
//   ③ 记分卡 bySize 聚合（usage.mjs）：三档归桶 / 无 size 老 run 归标档 / hook 剔除 /
//     驳回归档 / 异常(超时+跑崩)/token 合计 / 范围裁剪；run.size 派发留档（dispatch.mjs）
//   ④ build-client 产物含标记（改完源必须重组装）
//   ⑤ README 双份逐字一致 + 含「力度路由」「按档位」说明
//   ⑥ 模型路由独立弹层（task-mvnyc8vo）：ModelRoutePopover 三区（板级/六槽/备用链）+
//      池配置弹层搬离断言（不再含模型区）
//   ⑦ 备用链 GUI：OrderedModelsEditor 同款链编辑器（task-mvokikl3，FallbackCfg/textarea 退役）→
//      fallbackModels 数组写入通道 + kernel fetchTasks/cfgKnobs/TopPanel 透传订阅
//   ⑧ 在跑子代理模型可见：成员卡 + 池状态条渲染 model 与取模来源角标；dispatch poolStatus 带 modelSource
//   ⑨ 产物含模型路由弹层标记
//   ⑩ OrderedModelsEditor 组件本体：芯片 ×/↑ 交互 + 下拉过滤已选 + 改动即写 + 目录缺失降级
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildScoreboard } from '../index.mjs'
import { localDayKey } from '../lib/usage.mjs'
import { createDispatch } from '../lib/dispatch.mjs'
import { createRpc } from '../lib/rpc.mjs'
import { cfg, seed, normalizeBoard, configuredModelIds, modelHealthView } from '../lib/core.mjs'

const src = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
const ksrc = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ===== ① GUI 源码断言：六槽有序链编辑器（task-mvokikl3）+ 整槽数组读写 + laneModels 部分合并写通道 =====
test('①力度路由小节：三档×双角色 6 个 OrderedModelsEditor 链编辑器 + 空链=继承板级 + 槽位写整个有序数组（非仅首选）', () => {
  // 小节标题在模型行之后
  assert.ok(src.indexOf("'力度路由'") >= 0, '缺「力度路由」小节标题')
  const iVer = src.indexOf("cfgKey: 'verifierModel'")
  const iLane = src.indexOf("'力度路由'")
  const iTimeout = src.indexOf('两级超时（软超时只提醒主窗口')
  assert.ok(iVer >= 0 && iLane > iVer && iTimeout > iLane, '力度路由小节必须在模型行之后、两级超时之前')
  // 三档表 map 展开（3 档 × worker/verifier = 6 个链编辑器实例）
  assert.match(src, /\[\['light', '轻档'\], \['standard', '标档'\], \['heavy', '重档'\]\]\.map\(function \(ln\)/)
  // 读侧：整槽数组原样传入（非仅首选——laneFirst 首选单选形态已退役，链编辑器消费完整有序数组）
  assert.match(src, /\(props\.laneModels && props\.laneModels\[ln\[0\]\]\) \|\| \{\}/)
  assert.match(src, /React\.createElement\(OrderedModelsEditor, \{ label: ln\[1\] \+ ' Worker', value: laneObj\.worker, models: routeModels, emptyHint: '继承板级'/, 'Worker 槽未接链编辑器（整槽数组读）')
  assert.match(src, /React\.createElement\(OrderedModelsEditor, \{ label: ln\[1\] \+ ' Verifier', value: laneObj\.verifier, models: routeModels, emptyHint: '继承板级'/, 'Verifier 槽未接链编辑器（整槽数组读）')
  // 空链占位语义「继承板级」（空槽=继承上方板级模型行）
  assert.equal((src.match(/emptyHint: '继承板级'/g) || []).length, 2, 'map 内 worker/verifier 两槽位空链占位均为「继承板级」')
  assert.ok(src.indexOf('空链 = 继承上方 Worker/Verifier 模型行') >= 0, '缺「空链=继承板级模型行」注一句')
  // 语义一句「按序取第一个健康模型」
  assert.ok(src.indexOf('按序取第一个健康模型') >= 0, '缺「按序取第一个健康模型」语义标注')
  // 写通道：改动即写 set-board-config key='laneModels' 部分合并，槽位值=整个有序数组 nextArr（非仅首选）
  assert.match(src, /function saveLaneSlot\(lane, role, nextArr\) \{ var patch = \{\}; patch\[lane\] = \{\}; patch\[lane\]\[role\] = nextArr/, '缺 saveLaneSlot 整槽数组写')
  assert.match(src, /rpc\('set-board-config', \{ key: 'laneModels', value: patch \}\)/)
  // 首选单选形态退役：laneFirst helper 与 ModelCfg laneList 接线不再存在
  assert.ok(src.indexOf('function laneFirst(') < 0, 'laneFirst 首选形态应已退役（链编辑器读整槽数组）')
  assert.ok(src.indexOf('laneList:') < 0, 'ModelCfg 不再接 laneList（六槽已迁链编辑器）')
  assert.ok(src.indexOf('完整排序走对话/RPC') < 0, '「完整排序走对话/RPC」旧注释应已移除（GUI 可编完整链）')
  // 板级模型行仍是 ModelCfg 两段式（选中≠保存，点 ✓ 才提交）——既有契约不走即点即写
  assert.match(src, /function pick\(v\) \{ setVal\(v\); setDirty\(v !== \(props\.value \|\| ''\)\) \}/)
})

// ===== ② laneModels state 透传 =====
test('②kernel 透传：fetchTasks 回读 laneModels + TopPanel 订阅 + PoolCfgPopover props', () => {
  assert.ok(ksrc.indexOf('state.laneModels = (d && d.laneModels) || null') >= 0, 'fetchTasks 缺 laneModels 回读')
  assert.match(ksrc, /workerModel: '', verifierModel: '', laneModels: null/, 'state 初始缺 laneModels: null')
  assert.ok(ksrc.indexOf('setLaneMs(state.laneModels)') >= 0, 'TopPanel update() 缺 laneModels 订阅')
  assert.ok(ksrc.indexOf('laneModels: laneMs') >= 0, 'PoolCfgPopover 缺 laneModels prop')
  // 变更检测：hash 不变分支里 laneModels 变化也要补 notify（与开关系列同口径）
  assert.match(ksrc, /JSON\.stringify\(a\.laneModels \|\| null\) !== JSON\.stringify\(b\.laneModels \|\| null\)/)
})

// ===== ②b cfgKnobs 快照类型对称（验收驳回回归修复）：快照存原值，比较器双侧同形态 =====
// 回归形状（2026-10-25 验收驳回）：快照把 laneModels 预存成 JSON 字符串，比较器又对双侧各
// stringify 一次 → 串 vs 对象/null 类型不对称恒 true（实测老 host null→null 也判变化）→
// 3s 轮询每轮补 notify，既有 tasksHash 渲染节约纪律被废，且旧断言（allOn 夹具无 laneModels、
// 新测试只断言正则存在）全都捕不到。此处钉死：快照形态源码断言 + 抽真函数跑行为三态。
test('②b：cfgKnobs 快照 laneModels 存原值——null→null/同值新引用恒 false，真实变化才 true', () => {
  // ① 快照形态：laneModels 存 state 原值，快照行内不得再出现 stringify（双 stringify=类型不对称根源）
  const snapM = ksrc.match(/var cfgKnobs = \{[^}]*\}/)
  assert.ok(snapM, 'fetchTasks 缺 cfgKnobs 快照')
  assert.ok(snapM[0].indexOf('laneModels: state.laneModels') >= 0, '快照 laneModels 必须存 state 原值')
  assert.ok(snapM[0].indexOf('JSON.stringify') < 0, '快照内不得 stringify（比较器已双侧 stringify，再包一层=恒 true 回归）')
  // ② 行为级：抽 kernel 真函数跑（与 core.test 的 allOn 夹具同手法，但夹具带 laneModels）
  const fnSrc = ksrc.match(/function cfgKnobsChanged\(a, b\) \{[^\n]*\n/)[0]
  const cfgKnobsChanged = new Function(fnSrc + '\nreturn cfgKnobsChanged')()
  const base = { feedbackEnabled: true, notifyDispatch: true, notifyDone: true, epicSplit: true, verifyUserGuide: true }
  const LANES = { light: { worker: '', verifier: '' }, standard: { worker: 'a/b', verifier: '' }, heavy: { worker: '', verifier: '' } }
  const snapOf = (lm) => Object.assign({}, base, { laneModels: lm })
  // 老 host 不返回 laneModels：快照 null、赋值后仍 null → false（旧形状此处恒 true，每轮白补 notify）
  assert.equal(cfgKnobsChanged(snapOf(null), snapOf(null)), false, 'null→null 不得算变化（驳回回归的实测形状）')
  // 同值不同引用（host 每轮现算归一、必然新对象）→ false（渲染节约成立的前提）
  assert.equal(cfgKnobsChanged(snapOf(JSON.parse(JSON.stringify(LANES))), snapOf(JSON.parse(JSON.stringify(LANES)))), false, '同值新引用不得算变化')
  // 真实变化：槽位改值 / null→有值 / 有值→null 都必须检出（否则 GUI 改了槽位板面不刷新）
  const LANES2 = JSON.parse(JSON.stringify(LANES)); LANES2.heavy.worker = 'c/d'
  assert.equal(cfgKnobsChanged(snapOf(LANES), snapOf(LANES2)), true, '槽位改值必须检出')
  assert.equal(cfgKnobsChanged(snapOf(null), snapOf(LANES)), true, 'null→有值必须检出')
  assert.equal(cfgKnobsChanged(snapOf(LANES), snapOf(null)), true, '有值→null 必须检出')
  // ③ 产物同步：组装产物里快照同样是原值形态（pretest 的 build-client 兜底之外的直接锁）
  const bSnap = built.match(/var cfgKnobs = \{[^}]*\}/)
  assert.ok(bSnap && bSnap[0].indexOf('laneModels: state.laneModels') >= 0, 'client.js 产物快照缺 laneModels 原值形态（需 npm run build-client）')
})

// ===== ④ build-client 产物含标记 =====
test('④产物：lib/client.js 已重组装且含力度路由/按档位标记', () => {
  for (const m of ['力度路由', '按档位', '继承板级', "key: 'laneModels'", 'function LaneTable(props)', 'state.laneModels = (d && d.laneModels) || null']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})

// ===== ⑤ README 双份同步 =====
test('⑤README：双份逐字一致 + 含力度路由与按档位说明', () => {
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('力度路由') >= 0, 'README 缺「力度路由」说明')
  assert.ok(r1.indexOf('按档位') >= 0, 'README 缺记分卡「按档位」小表说明')
})

// ===== ③a bySize 聚合：三档归桶 / 老 run 兼容 / hook 剔除 / 驳回归档 / 范围裁剪 =====
function isoOf(y, m, d, h, mi) { return new Date(y, m - 1, d, h, mi || 0, 0).toISOString() }
function dayOf(y, m, d) { return localDayKey(new Date(y, m - 1, d, 12)) }
function U(inp, outp, cr, cw) { return { input: inp, output: outp, cacheRead: cr, cacheWrite: cw, total: inp + outp + cr + cw } }
const D0 = dayOf(2026, 10, 5)
const D1 = dayOf(2026, 10, 6)
// 夹具：tL(light worker completed + verifier incomplete) / tH(heavy 3 run + 1 驳回归 wh1) /
// tS(老 run 无 size 归标档 + junk size 归标档 + hook 剔除 + 无 usage 老 run 只计 runs 不进 token)
function mkLaneTasks() {
  return [
    { id: 'tL', title: 'L', status: 'resolved', createdAt: isoOf(2026, 10, 6, 9), verifiedAt: isoOf(2026, 10, 6, 13),
      runs: [
        { role: 'worker', id: 'wl', at: isoOf(2026, 10, 6, 10), endedAt: isoOf(2026, 10, 6, 10, 10), model: 'm/a', outcome: 'completed', size: 'light', usage: U(100, 50, 1000, 10) },
        { role: 'verifier', id: 'vl', at: isoOf(2026, 10, 6, 10, 20), endedAt: isoOf(2026, 10, 6, 10, 25), model: 'm/v', outcome: 'incomplete', size: 'light', usage: U(10, 5, 0, 1) },
      ] },
    { id: 'tH', title: 'H', status: 'resolved', createdAt: isoOf(2026, 10, 6, 9), verifiedAt: isoOf(2026, 10, 6, 14), rejectCount: 1,
      messages: [{ kind: 'rejection', text: '验收驳回 · 自测没过', at: isoOf(2026, 10, 6, 11, 45), by: 'vh0' }],
      runs: [
        { role: 'worker', id: 'wh1', at: isoOf(2026, 10, 6, 11), endedAt: isoOf(2026, 10, 6, 11, 30), model: 'm/b', outcome: 'timeout/error', size: 'heavy', usage: U(200, 100, 3000, 20) },
        { role: 'worker', id: 'wh2', at: isoOf(2026, 10, 6, 12), endedAt: isoOf(2026, 10, 6, 12, 5), model: 'm/b', outcome: 'completed', size: 'heavy', usage: U(100, 50, 0, 10) },
        { role: 'verifier', id: 'vh', at: isoOf(2026, 10, 6, 12, 10), endedAt: isoOf(2026, 10, 6, 12, 15), model: 'm/v', outcome: 'completed', size: 'heavy', usage: U(50, 20, 500, 5) },
      ] },
    { id: 'tS', title: 'S', status: 'resolved', createdAt: isoOf(2026, 10, 5, 9), resolvedAt: isoOf(2026, 10, 6, 15),
      runs: [
        { role: 'worker', id: 'ws0', at: isoOf(2026, 10, 5, 9), outcome: 'completed' }, // 老 run：无 size/usage/endedAt
        { role: 'worker', id: 'ws1', at: isoOf(2026, 10, 6, 13), endedAt: isoOf(2026, 10, 6, 13, 5), model: 'm/c', outcome: 'failed', size: 'ultra', usage: U(10, 10, 10, 10) }, // junk size → 标档
        { role: 'hook-pre', id: 'hk', at: isoOf(2026, 10, 6, 14), endedAt: isoOf(2026, 10, 6, 14, 2), model: 'm/h', outcome: 'completed', usage: U(5, 5, 5, 5) }, // hook 不进档位统计
      ] },
  ]
}
test('③a1：bySize 三档归桶——runs/驳回/异常/token 逐档数值核对', () => {
  const sb = buildScoreboard(mkLaneTasks())
  assert.ok(sb.bySize, 'scoreboard 缺 bySize')
  assert.deepEqual(Object.keys(sb.bySize).sort(), ['heavy', 'light', 'standard'], 'bySize 恒有三档')
  // light：wl(completed) + vl(incomplete)
  assert.equal(sb.bySize.light.runs, 2)
  assert.equal(sb.bySize.light.failed, 1, 'vl incomplete 计跑崩')
  assert.equal(sb.bySize.light.timeouts, 0)
  assert.equal(sb.bySize.light.rejected, 0)
  assert.equal(sb.bySize.light.tokSum, 1160 + 16)
  assert.equal(sb.bySize.light.effSum, 160 + 16)
  // heavy：wh1(timeout) + wh2(completed) + vh(completed)；驳回 11:45 归因 wh1（wh2 12:00 晚于驳回时刻）
  assert.equal(sb.bySize.heavy.runs, 3)
  assert.equal(sb.bySize.heavy.timeouts, 1)
  assert.equal(sb.bySize.heavy.failed, 0)
  assert.equal(sb.bySize.heavy.rejected, 1, '驳回归因到 heavy 档 worker run')
  assert.equal(sb.bySize.heavy.tokSum, 3320 + 160 + 575)
  assert.equal(sb.bySize.heavy.effSum, 320 + 160 + 75)
  // standard：ws0（无 size 老 run 归标档，只计 runs 不进 token）+ ws1（junk size 归标档，failed）
  assert.equal(sb.bySize.standard.runs, 2, 'hook run 剔除、无 size/junk size 均归标档')
  assert.equal(sb.bySize.standard.failed, 1)
  assert.equal(sb.bySize.standard.tokSum, 40, '无 usage 老 run 不进 token 口径（不伪造 0）')
  assert.equal(sb.bySize.standard.effSum, 30)
  assert.equal(sb.meta.roleOther, 1, 'hook run 计 roleOther 不进档')
})
test('③a2：bySize 随统计范围裁剪（run 日落点两端闭区间）', () => {
  const sb = buildScoreboard(mkLaneTasks(), { from: D1, to: D1 })
  assert.equal(sb.bySize.standard.runs, 1, 'D0 的 ws0 被范围裁掉')
  assert.equal(sb.bySize.standard.tokSum, 40)
  assert.equal(sb.bySize.light.runs, 2)
  assert.equal(sb.bySize.heavy.runs, 3)
  const sb0 = buildScoreboard(mkLaneTasks(), { from: D0, to: D0 })
  assert.equal(sb0.bySize.light.runs, 0, '范围外档位归零（三档键恒在）')
  assert.equal(sb0.bySize.standard.runs, 1)
  assert.equal(sb0.bySize.heavy.rejected, 0, '归因 run 被裁，其驳回随之裁掉')
})

// ===== ③b run.size 派发留档（dispatch.mjs spawnOneShot → recordRunHistory）=====
// harness 与 lane-models.test.mjs 同形（mkActivationSubagents 记录 spec，自含一份避免跨文件耦合）
var SID = 'session-test-0000-0000-000000000000'
function mkTask(over) {
  return Object.assign({ id: 't1', title: 'T', description: '', status: 'in-progress', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: 'spawn-pending', claimedAt: null, createdAt: '2026-01-01T00:00:00Z', history: [], messages: [] }, over || {})
}
function mkDispatch(board, ctxOver, stateOver) {
  var shared = Object.assign({ knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {}, modelCooldown: {}, modelHealth: {} }, stateOver || {})
  return createDispatch(
    Object.assign({ fs: {}, effect: function () {}, get: function () { return null } }, ctxOver || {}),
    shared,
    {
      rt: async function () { return board }, wt: async function () {},
      mutateLocked: async function (sid, fn) { return fn(board) },
      kickCycle: function () {}, rootForSession: function () { return { id: SID } },
      sessionCwd: function () { return '' }, withTimeout: function (p) { return p }, runsFor: function (sid) { return shared.activeRuns[sid] || (shared.activeRuns[sid] = {}) },
      feedbackOn: function () { return true }, pushSysNote: function () {}, maybeNotify: function () {}, notifyTaskDone: function () {},
    })
}
function mkActivationSubagents(calls, result) {
  return {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function (spec) {
      calls.push(spec)
      return { childId: 'child-' + calls.length, messageId: 'msg-' + calls.length, result: result || new Promise(function () {}), dispose: async function () {} }
    },
  }
}
test('③b：run.size 留档——worker/verifier 归一到档（缺省/脏值=标档），hook 不留档', async function () {
  // worker + size=heavy → runs[0].size='heavy'，rec.size 同步
  var b1 = { version: 12, tasks: [mkTask({ size: 'heavy' })], workerModel: 'bw/board-w', verifierModel: 'bv/board-v' }
  var sr1 = await mkDispatch(b1, { subagents: mkActivationSubagents([]) }).spawnOneShot(SID, b1.tasks[0], 'worker')
  assert.equal(b1.tasks[0].runs[0].size, 'heavy', 'run 留档带 size')
  assert.equal(sr1.size, 'heavy', 'rec 留 size')
  // 无 size → 标档语义
  var b2 = { version: 12, tasks: [mkTask({})], workerModel: 'bw/board-w', verifierModel: '' }
  var sr2 = await mkDispatch(b2, { subagents: mkActivationSubagents([]) }).spawnOneShot(SID, b2.tasks[0], 'worker')
  assert.equal(b2.tasks[0].runs[0].size, 'standard', '缺省=标档')
  assert.equal(sr2.size, 'standard')
  // verifier + size=light → light（Verifier 跟卡 size 同档）
  var b3 = { version: 12, tasks: [mkTask({ size: 'light' })], workerModel: '', verifierModel: 'bv/board-v' }
  var sr3 = await mkDispatch(b3, { subagents: mkActivationSubagents([]) }).spawnOneShot(SID, b3.tasks[0], 'verifier')
  assert.equal(b3.tasks[0].runs[0].size, 'light')
  assert.equal(sr3.size, 'light')
  // 脏值 size → 标档收敛
  var b4 = { version: 12, tasks: [mkTask({ size: 'ultra' })], workerModel: 'bw/board-w' }
  await mkDispatch(b4, { subagents: mkActivationSubagents([]) }).spawnOneShot(SID, b4.tasks[0], 'worker')
  assert.equal(b4.tasks[0].runs[0].size, 'standard', '脏值 size 归标档')
  // hook 不进链不留档（恒父模型，不进档位统计）
  var b5 = { version: 12, tasks: [mkTask({ size: 'heavy', hooks: { pre: { enabled: true, prompt: 'p' } } })], workerModel: 'bw/board-w' }
  await mkDispatch(b5, { subagents: mkActivationSubagents([]) }).spawnOneShot(SID, b5.tasks[0], 'hook-pre')
  assert.equal('size' in b5.tasks[0].runs[0], false, 'hook run 不留 size')
})

// ===== ⑥ 模型路由独立弹层（task-mvnyc8vo）：三区齐全 + 池配置弹层搬离断言 =====
test('⑥模型路由弹层：板级/六槽/备用链三区齐全，池配置弹层不再含模型区（搬离非复制）', () => {
  const iMr = src.indexOf('function ModelRoutePopover(props)')
  const iPc = src.indexOf('function PoolCfgPopover(props)')
  const iTv = src.indexOf('function TeamView()')
  assert.ok(iMr >= 0, '缺 ModelRoutePopover 组件')
  assert.ok(iPc > iMr, 'ModelRoutePopover 须定义在 PoolCfgPopover 之前（旧断言①时序：力度路由在两级超时之前）')
  assert.ok(iTv > iPc)
  // 三区：板级模型 / 力度路由六槽 / 备用模型链 + 取模口径说明
  const mrBody = src.slice(iMr, iPc)
  assert.ok(mrBody.indexOf("'板级模型'") >= 0, '弹层缺「板级模型」区标题')
  assert.ok(mrBody.indexOf("cfgKey: 'workerModel'") >= 0 && mrBody.indexOf("cfgKey: 'verifierModel'") >= 0, '板级 Worker/Verifier 模型行未搬入')
  assert.ok(mrBody.indexOf("'力度路由'") >= 0, '弹层缺「力度路由」区标题')
  assert.match(mrBody, /\[\['light', '轻档'\], \['standard', '标档'\], \['heavy', '重档'\]\]\.map\(function \(ln\)/, '六槽三档表未搬入')
  assert.ok(mrBody.indexOf('继承板级') >= 0, '六槽「继承板级」语义未随区搬入')
  assert.ok(mrBody.indexOf("'备用模型链'") >= 0, '弹层缺「备用模型链」区标题')
  assert.ok(mrBody.indexOf('取模口径') >= 0, '缺取模链口径说明一句')
  // 工具栏按钮：cpu 图标 + 弹层 fixed 定位模式复用
  assert.match(mrBody, /ic\('cpu', 13\)/, '缺模型路由工具栏按钮（cpu 图标）')
  assert.match(mrBody, /position: 'fixed', top: pos\.top \+ 'px'/, '弹层未复用 fixed 定位模式')
  // 搬离断言：池配置弹层体内不再有模型区（PoolCfgPopover → TeamView 区间）
  const pcBody = src.slice(iPc, iTv)
  assert.ok(pcBody.indexOf('ModelCfg') < 0, '池配置弹层仍引用 ModelCfg（模型区应搬走）')
  assert.ok(pcBody.indexOf("'力度路由'") < 0, '池配置弹层仍含「力度路由」区（应搬走）')
  assert.ok(pcBody.indexOf('继承板级') < 0, '池配置弹层仍含六槽继承语义（应搬走）')
  // 池配置弹层保留区未动：并发/超时/开关
  assert.ok(pcBody.indexOf('并发上限') >= 0 && pcBody.indexOf('两级超时') >= 0 && pcBody.indexOf('学习反馈') >= 0, '池配置弹层保留区（并发/超时/开关）被误伤')
  // 工具栏接线：kernel 同挂两个弹层
  assert.ok(ksrc.indexOf('React.createElement(ModelRoutePopover, { workerModel: workerModel, verifierModel: verifierModel, laneModels: laneMs, fbModels: fbMs })') >= 0, '工具栏缺 ModelRoutePopover 接线')
  assert.ok(ksrc.indexOf("var _fbm = useState(state.fallbackModels), fbMs = _fbm[0], setFbMs = _fbm[1]") >= 0, 'TopPanel 缺 fbMs state')
})

// ===== ⑦ 备用链 GUI：OrderedModelsEditor 链编辑器（FallbackCfg/textarea 退役）→ 数组写入通道 + kernel 透传 =====
test('⑦备用链：FallbackCfg/textarea 退役 + OrderedModelsEditor 同款链编辑器 + set-board-config fallbackModels 整链数组写通道 + kernel 透传', () => {
  // FallbackCfg 文本编辑组件退役（task-mvokikl3，用户原话「不要直接让用户填文本，要支持下拉选择」）
  assert.ok(src.indexOf('function FallbackCfg(props)') < 0, 'FallbackCfg 文本编辑组件应已退役')
  // 弹层区（ModelRoutePopover→PoolCfgPopover 区间）不再含 textarea 文本框
  const iMr7 = src.indexOf('function ModelRoutePopover(props)')
  const iPc7 = src.indexOf('function PoolCfgPopover(props)')
  assert.ok(iMr7 >= 0 && iPc7 > iMr7)
  assert.ok(src.slice(iMr7, iPc7).indexOf("React.createElement('textarea'") < 0, '模型路由弹层区不得再含 textarea（备用链改链编辑器）')
  // 备用链接同款链编辑器 + 跨档逃生索语义标注
  assert.match(src, /React\.createElement\(OrderedModelsEditor, \{ label: '备用链', value: props\.fbModels, models: routeModels, emptyHint: '无（不启用）', health: modelHealth, onSave: saveFallbackChain \}\)/, '备用链未接 OrderedModelsEditor')
  assert.ok(src.indexOf('跨档逃生索') >= 0, '缺「档位链全不可用时的跨档逃生索」语义标注')
  // 写通道：整个有序数组（改动即写，host 逐项合法清单校验）
  assert.match(src, /function saveFallbackChain\(nextArr\) \{ return rpc\('set-board-config', \{ key: 'fallbackModels', value: nextArr \}\) \}/, '缺 saveFallbackChain 整链数组写')
  // kernel 透传：fetchTasks 回读 + cfgKnobs 快照/比对 + TopPanel 订阅
  assert.ok(ksrc.indexOf('state.fallbackModels = (d && d.fallbackModels) || null') >= 0, 'fetchTasks 缺 fallbackModels 回读')
  assert.match(ksrc, /laneModels: null, fallbackModels: null/, 'state 初始缺 fallbackModels: null')
  assert.match(ksrc, /fallbackModels: state\.fallbackModels \|\| null/, 'cfgKnobs 快照缺 fallbackModels（原值形态）')
  assert.match(ksrc, /JSON\.stringify\(a\.fallbackModels \|\| null\) !== JSON\.stringify\(b\.fallbackModels \|\| null\)/, 'cfgKnobsChanged 缺 fallbackModels 比对（hash 不变分支补 notify 前提）')
  assert.ok(ksrc.indexOf('setFbMs(state.fallbackModels)') >= 0, 'TopPanel update() 缺 fallbackModels 订阅')
})

// ===== ⑧ 在跑子代理模型可见：成员卡 + 池状态条渲染 model 与取模来源角标 =====
test('⑧在跑模型可见：modelSourceBadge 角标（档/备/降/卡）+ 成员卡/池状态条渲染 + dispatch poolStatus 带 modelSource', () => {
  // 角标映射与闸口（board/parent=常规继承不标）
  assert.match(src, /var MODEL_SRC_BADGE = \{ card: '卡', lane: '档', fallback: '备', 'cooldown-downgrade': '降' \}/, '缺来源→角标映射')
  assert.match(src, /function modelSourceBadge\(src\) \{/, '缺 modelSourceBadge 组件')
  assert.ok(src.indexOf("src === 'board' || src === 'parent'") >= 0, 'board/parent 不标闸口缺失')
  // 成员卡（TeamView memberCard）渲染 model + 角标
  assert.match(src, /'🧬 ' \+ m\.model/, '成员卡缺 model 渲染')
  assert.match(src, /modelSourceBadge\(m\.modelSource\)/, '成员卡/池状态条缺来源角标渲染')
  // 池状态条（PoolStatus）在跑条目芯片
  assert.ok(src.indexOf('在跑模型：') >= 0, 'PoolStatus 缺在跑模型芯片')
  assert.match(src, /wBusy\.concat\(vBusy\)\.filter\(function \(m\) \{ return !!m\.model \}\)/, 'PoolStatus 缺 busy 条目收集')
  // 数据面：dispatch poolStatus 条目带 modelSource（缺则 GUI 角标无源）
  const dsrc = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
  assert.ok(dsrc.indexOf("modelSource: rc.modelSource || ''") >= 0, 'dispatch poolStatus 条目缺 modelSource 透出')
})

// ===== ⑨ 产物含模型路由弹层标记 =====
test('⑨产物：lib/client.js 已重组装且含模型路由弹层/在跑模型可见标记', () => {
  for (const m of ['ModelRoutePopover', 'OrderedModelsEditor', '备用模型链', '板级模型', 'modelSourceBadge', '在跑模型：', "state.fallbackModels = (d && d.fallbackModels) || null", "'cpu'"]) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
  // 退役形态不得残留在产物里
  assert.ok(built.indexOf('function FallbackCfg(props)') < 0, 'client.js 残留 FallbackCfg（需 npm run build-client 重组装）')
  assert.ok(built.indexOf('function laneFirst(') < 0, 'client.js 残留 laneFirst（需 npm run build-client 重组装）')
})

// ===== ⑩ 链编辑器组件本体（task-mvokikl3）：芯片 ×/↑ 交互 + 下拉过滤已选 + 改动即写 + 目录缺失降级 =====
test('⑩OrderedModelsEditor：组件存在 + 芯片行（×移除/↑前移）+ 下拉过滤已在链中 + 改动即写（onSave→rpc→fetchTasks）+ 目录缺失降级文本输入', () => {
  assert.ok(src.indexOf('function OrderedModelsEditor(props)') >= 0, '缺 OrderedModelsEditor 组件')
  // 组件须定义在 ModelRoutePopover 之前（弹层内复用 7 处：六槽+备用链）
  assert.ok(src.indexOf('function OrderedModelsEditor(props)') < src.indexOf('function ModelRoutePopover(props)'), 'OrderedModelsEditor 须定义在 ModelRoutePopover 之前')
  // 下拉过滤已在链中的（链内唯一，重复添加无意义）
  assert.match(src, /models\.filter\(function \(m\) \{ return list\.indexOf\(m\.id\) < 0 \}\)/, '下拉未过滤已在链中的模型')
  // × 移除：splice 掉第 i 片
  assert.match(src, /function removeAt\(i\) \{ var next = list\.slice\(\); next\.splice\(i, 1\); commit\(next\) \}/, '缺 × 移除交互')
  // ↑ 前移一位：与前一顺位交换（首片不渲染 ↑）
  assert.match(src, /function upAt\(i\) \{ if \(i <= 0\) return; var next = list\.slice\(\); var t = next\[i - 1\]; next\[i - 1\] = next\[i\]; next\[i\] = t; commit\(next\) \}/, '缺 ↑ 前移交互')
  // 添加：追加到链尾（concat）+ 已在链中的不加
  assert.match(src, /commit\(list\.concat\(\[v\]\)\)/, '添加未追加到链尾')
  // 改动即写：commit 走 props.onSave（rpc 通道）→ 成功后 fetchTasks 回读；host 拒写 ok:false 亮 ⚠️ 不静默吞
  assert.match(src, /Promise\.resolve\(props\.onSave\(next\)\)/, '改动即写未走 props.onSave')
  assert.match(src, /r && r\.ok === false/, 'host 拒写（ok:false）未展示（不静默吞）')
  // 空链占位语义（继承下一级/无）
  assert.match(src, /props\.emptyHint \|\| '无'/, '缺空链占位（emptyHint）')
  // 目录不可用降级文本输入（不丢功能）
  assert.match(src, /placeholder: 'provider\/model'/, '缺目录缺失降级文本输入')
  // 弹层取一次 list-models 下发 7 处（routeModels），避免每编辑器各发一次 RPC
  assert.match(src, /var _rm = useState\(null\), routeModels = _rm\[0\], setRouteModels = _rm\[1\]/, 'ModelRoutePopover 缺 routeModels 目录 state')
})

// ===== ⑪ 模型健康：配置缺省/归一 + 已配置模型枚举 + 四态统一视图 =====
test('⑪模型健康配置与统一视图：默认15分钟、已配置集合去重、冷却/熔断/健康/未知与过期恢复', () => {
  assert.equal(seed(SID).probeEnabled, true)
  assert.equal(seed(SID).probeIntervalMin, 15)
  assert.equal(cfg({}).probeEnabled, true)
  assert.equal(cfg({}).probeIntervalMin, 15)
  assert.equal(cfg({ probeIntervalMin: 2.4 }).probeIntervalMin, 2)
  var old = { tasks: [], probeEnabled: 'dirty', probeIntervalMin: 0 }
  normalizeBoard(old)
  assert.equal(old.probeEnabled, true)
  assert.equal(old.probeIntervalMin, 15)
  old.probeEnabled = false; old.probeIntervalMin = 2000; normalizeBoard(old)
  assert.equal(old.probeEnabled, false)
  assert.equal(old.probeIntervalMin, 1440)

  var d = seed(SID)
  d.workerModel = 'p/a'; d.verifierModel = 'p/v'
  d.laneModels.light.verifier = ['p/d']
  d.laneModels.heavy.worker = ['p/b', 'p/a']
  d.fallbackModels = ['p/c', 'p/a']
  assert.deepEqual(configuredModelIds(d), ['p/a', 'p/v', 'p/d', 'p/b', 'p/c'], '板级∪档位∪备用链去重；不扫目录/不含卡级模型')
  var now = Date.now()
  var bucket = {
    'p/a': { observed: 'healthy', observedNote: '主动探测通过', lastProbe: '2026-10-26T01:00:00.000Z', lastSeen: '2026-10-26T01:00:00.000Z', latencyMs: 12, recentRuns: [{ ok: true, at: '2026-10-26T00:00:00.000Z', latencyMs: 30 }] },
    'p/b': { observed: 'healthy', observedNote: '最近 run 成功', cooldownNote: '额度限流，冷却至 15:00' },
    'p/c': { observed: 'unknown', circuitNote: '验收连续失败，已熔断' },
    'p/removed': { observed: 'healthy' },
  }
  var view = modelHealthView(d, bucket, { sid: SID, now: now, modelCooldown: { 'p/b': now + 60000 }, badModels: { [SID + '|p/c']: true } })
  assert.equal(view['p/a'].state, 'healthy')
  assert.equal(view['p/a'].lastProbe, '2026-10-26T01:00:00.000Z')
  assert.equal(view['p/a'].latencyMs, 12)
  assert.equal(view['p/a'].recentRuns.length, 1)
  assert.equal(view['p/b'].state, 'cooldown')
  assert.equal(view['p/b'].until, now + 60000)
  assert.equal(view['p/b'].note, '额度限流，冷却至 15:00')
  assert.equal(view['p/c'].state, 'circuit')
  assert.equal(view['p/d'].state, 'unknown', '已配置但无信号=未知')
  assert.equal('p/removed' in view, false, '已移出配置的模型不透出/不探测')
  var recovered = modelHealthView(d, bucket, { sid: SID, now: now, modelCooldown: { 'p/b': now - 1 }, badModels: {} })
  assert.equal(recovered['p/b'].state, 'healthy', '过期冷却不残留')
  assert.equal('until' in recovered['p/b'], false)
  assert.equal(recovered['p/c'].state, 'unknown', '无熔断时回基础观察态')
})

function mkHealthRpc(board, stateOver) {
  var state = Object.assign({ handlers: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {}, modelHealth: {}, modelCooldown: {}, badModels: {} }, stateOver || {})
  var ctx = { tools: { register: function () {} }, effect: function () {}, webServer: { register: function () { return function () {} } }, get: function () { return null } }
  createRpc(ctx, state, {
    getActorId: function () { return 'tester' }, resolveRoot: function (x) { return x }, toolSessionId: function () { return SID }, rpcSessionId: function () { return SID },
    rootForSession: function () { return null }, deriveWorkMode: function () { return 'auto' }, runsFor: function () { return {} },
    rt: async function () { return board }, mutateLocked: async function (sid, fn) { return fn(board) },
    maybeNotify: function () {}, notifyTaskDone: function () {}, spawnOneShot: function () {}, accumulateRunUsage: function () {},
    readContextPack: async function () { return null }, pushSysNote: function () {}, sessionCwd: function () { return '' },
  })
  return { handlers: state.handlers, state: state }
}

// ===== ⑫ get-tasks 健康透出 + 探测开关/间隔写通道（含 unchanged 轻量响应）=====
test('⑫RPC：get-tasks 透出 modelHealth/probeEnabled/probeIntervalMin，set-board-config 可写且轻量响应不丢健康面', async () => {
  var board = seed(SID); board.workerModel = 'p/a'
  var state = {
    modelHealth: { [SID]: { 'p/a': { observed: 'healthy', observedNote: '主动探测通过', lastProbe: '2026-10-26T01:00:00.000Z', lastSeen: '2026-10-26T01:00:00.000Z', latencyMs: 9, recentRuns: [] } } },
    modelCooldown: {}, badModels: {},
  }
  var h = mkHealthRpc(board, state)
  var first = await h.handlers['get-tasks']({})
  assert.equal(first.probeEnabled, true)
  assert.equal(first.probeIntervalMin, 15)
  assert.equal(first.modelHealth['p/a'].state, 'healthy')
  assert.equal(first.modelHealth['p/a'].latencyMs, 9)
  var light = await h.handlers['get-tasks']({ ifHash: first.tasksHash })
  assert.equal(light.unchanged, true)
  assert.equal(light.modelHealth['p/a'].state, 'healthy', 'unchanged 轻量响应仍透健康表')
  var off = await h.handlers['set-board-config']({ key: 'probeEnabled', value: false })
  assert.equal(off.ok, true)
  var interval = await h.handlers['set-board-config']({ key: 'probeIntervalMin', value: 7 })
  assert.equal(interval.ok, true)
  assert.equal(board.probeEnabled, false)
  assert.equal(board.probeIntervalMin, 7)
  assert.deepEqual(board.configLog.slice(-2).map(function (x) { return x.key }), ['probeEnabled', 'probeIntervalMin'], '两个配置键均入既有审计')
  var after = await h.handlers['get-tasks']({})
  assert.equal(after.probeEnabled, false)
  assert.equal(after.probeIntervalMin, 7)
  assert.equal(after.modelHealth['p/a'].state, 'healthy', '关主动探测不清被动健康信号')
})

function mkProbeCtx(calls, errorText) {
  var llm = {
    stream: function (options) {
      calls.push(options)
      return (async function * () {
        if (errorText) yield { type: 'finish', reason: { kind: 'error', failure: { message: errorText } } }
        else yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { get: function (name) { return name === 'llm' ? llm : null } }
}
function mkProbeBoard() {
  var d = seed(SID)
  d.workerModel = 'p/a'; d.verifierModel = 'p/v'
  d.laneModels.heavy.worker = ['p/b', 'p/a']; d.fallbackModels = ['p/c']
  return d
}
// EMPTY_RESPONSE 宿主逐字文案（dsh-llm-pi-ai mapStopReason：model "<m>" returned a completed
// response with no content；dsh-llm-deepseek 另作 '<…> returned no content'）——探测侧按文本特征识别。
var EMPTY_RESPONSE_TEXT = 'model "p/a" returned a completed response with no content'
// 探测响应脚本桩（task-mvrfp1rj）：script 按「第 N 次 llm.stream 调用」取一步
//   'stop'        正常完成（finish/stop）
//   'empty'       宿主空响应（finish/error + failure.code=EMPTY_RESPONSE，逐字文案见上）
//   { empty: t }  自定义文本的空响应（验 quota 类文本由既有嗅探接管）
//   { error: t }  真错误（finish/error，无 code——超时/限流/连接等形态）
//   'nofinish'    流结束但零 finish 块
//   'hang'        永不完成（挂起直到 signal abort——task-mvsv8zym 验超时/重试超时形态）
function mkProbeScriptCtx(calls, script) {
  var llm = {
    stream: function (options) {
      var step = script[Math.min(calls.length, script.length - 1)]
      calls.push(options)
      return (async function * () {
        if (step === 'nofinish') return
        if (step === 'hang') {
          await new Promise(function (_, reject) {
            if (options.signal.aborted) return reject(new Error('aborted'))
            options.signal.addEventListener('abort', function () { reject(new Error('aborted')) })
          })
          return
        }
        if (step === 'empty' || (step && step.empty)) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: (step && step.empty) || EMPTY_RESPONSE_TEXT, code: 'EMPTY_RESPONSE' } } }
          return
        }
        if (step && step.error) { yield { type: 'finish', reason: { kind: 'error', failure: { message: step.error } } }; return }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { get: function (name) { return name === 'llm' ? llm : null } }
}

// ===== ⑬ 主动嗅探：极短 llm.stream 直调 + 仅配置集合 + 关闭零请求 + 429 复用冷却 =====
test('⑬主动探测：maxTokens=1 无系统/工具/子代理，仅已配置去重集合；probeEnabled=false 零请求', async () => {
  var calls = [], state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  var dispatch = mkDispatch(mkProbeBoard(), mkProbeCtx(calls), state)
  var result = await dispatch.probeConfiguredModels(SID, mkProbeBoard())
  assert.equal(result.probed, 4)
  assert.equal(result.healthy, 4)
  assert.deepEqual(result.models, ['p/a', 'p/v', 'p/b', 'p/c'])
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(function (x) { return x.provider + '/' + x.model }), result.models)
  for (var i = 0; i < calls.length; i++) {
    assert.equal(calls[i].maxTokens, 1)
    assert.equal(calls[i].messages[0].content[0].text, 'ping')
    assert.equal('system' in calls[i], false)
    assert.equal('tools' in calls[i], false)
    assert.equal('sessionId' in calls[i], false, '直调不创建/绑定子会话')
  }
  var h = state.modelHealth[SID]['p/a']
  assert.equal(h.state, 'healthy')
  assert.ok(h.lastProbe && h.lastSeen)
  assert.equal(typeof h.latencyMs, 'number')
  assert.equal(calls.filter(function (x) { return x.maxTokens === 8 }).length, 0, '一次成功不触发重试（8 token 重试只在空响应后出现）')

  var offCalls = [], offBoard = mkProbeBoard(); offBoard.probeEnabled = false
  var offState = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  var off = await mkDispatch(offBoard, mkProbeCtx(offCalls), offState).probeConfiguredModels(SID, offBoard)
  assert.equal(off.disabled, true)
  assert.equal(off.probed, 0)
  assert.equal(offCalls.length, 0, '关闭主动探测=零 LLM 请求')
  assert.equal(offState.modelHealth[SID]['p/a'].state, 'unknown', '关闭后仍建立被动健康表/未知态')
})

test('⑬b主动探测失败：429 finish error 复用冷却登记，不污染 badModels 熔断表', async () => {
  var calls = [], board = seed(SID); board.workerModel = 'p/a'
  var state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  var origErr = console.error; console.error = function () {}
  try {
    var result = await mkDispatch(board, mkProbeCtx(calls, '429 RATE_LIMIT'), state).probeConfiguredModels(SID, board)
    assert.equal(result.probed, 1)
    assert.equal(result.healthy, 0)
    assert.equal(calls.length, 1, '真错误一次定性：不触发空响应 8 token 重试')
    assert.equal(calls[0].maxTokens, 1)
    assert.ok(state.modelCooldown['p/a'] > Date.now())
    assert.equal(state.modelHealth[SID]['p/a'].state, 'cooldown')
    assert.ok(state.modelHealth[SID]['p/a'].lastProbe)
    assert.equal(Object.keys(state.badModels).length, 0)
  } finally { console.error = origErr }
})

// ===== ⑬c 空响应重试（task-mvrfp1rj）：首探 maxTokens=1 空 → 8 重试有内容 = 🟢 探测通过 =====
// 语义矩阵（用户 2026-10-28 拍板）：①1 token 空→8 重试一次；②重试有内容→🟢；④真错误/超时/无 finish 不重试。
test('⑬c空响应重试：首探 maxTokens=1 空 → maxTokens=8 重试有内容 → 🟢探测通过，不喂冷却', async () => {
  var calls = [], board = seed(SID); board.workerModel = 'p/a'
  var state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  var result = await mkDispatch(board, mkProbeScriptCtx(calls, ['empty', 'stop']), state).probeConfiguredModels(SID, board)
  assert.equal(result.probed, 1)
  assert.equal(result.healthy, 1, '重试有内容 = 探测通过（存活）')
  assert.equal(calls.length, 2, '空响应触发且只触发一次重试')
  assert.deepEqual(calls.map(function (x) { return x.maxTokens }), [1, 8], '首探 1 token → 重试 8 token')
  for (var i = 0; i < calls.length; i++) {
    assert.equal(calls[i].messages[0].content[0].text, 'ping')
    assert.equal('system' in calls[i], false)
    assert.equal('tools' in calls[i], false)
    assert.equal('sessionId' in calls[i], false, '重试同样是最小直调（不创建/绑定子会话）')
  }
  var h = state.modelHealth[SID]['p/a']
  assert.equal(h.state, 'healthy')
  assert.equal(h.observed, 'healthy')
  assert.match(h.observedNote, /主动探测通过/)
  assert.equal('p/a' in state.modelCooldown, false, '存活不喂冷却')
  assert.equal(Object.keys(state.badModels).length, 0, '探测通过不碰熔断表')
})

// ===== ⑬d 空响应分治（task-mvrqdw4k·用户拍板，修正 task-mvrfp1rj 的「重试仍空=不可调用」旧口径）=====
// 可用性实证（三重，决定性）：v4.1-flash 正产出当轮对话、两次「失败」皆我方固定 60s 挂死闸误杀（已修自适应）
// ——它是慢不是死，纯空响应=供应商怪癖判 🟡degraded 存活（不喂冷却/路由仍可选用）；额度/凭据/连接信号=真错维持失败臂。
test('⑬d空响应分治：重试仍空（纯 EMPTY_RESPONSE）判 🟡degraded 存活不喂冷却；quota 文本仍由既有嗅探接管走失败臂', async () => {
  var calls = [], board = seed(SID); board.workerModel = 'p/a'
  var state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  var origErr = console.error; console.error = function () {}
  try {
    var result = await mkDispatch(board, mkProbeScriptCtx(calls, ['empty', 'empty']), state).probeConfiguredModels(SID, board)
    assert.equal(result.probed, 1)
    assert.equal(result.healthy, 0, '纯空响应不记 🟢存活（healthy 计数不含它）')
    assert.equal(result.degraded, 1, '纯空响应=供应商怪癖，记 🟡degraded（degraded 计数含它）')
    assert.deepEqual(calls.map(function (x) { return x.maxTokens }), [1, 8], '重试节奏不变（首探 1 token → 重试 8 token）')
    var h = state.modelHealth[SID]['p/a']
    assert.equal(h.state, 'degraded', '🟡降级存活态（syncModelHealth degraded 派生）')
    assert.equal(h.observed, 'degraded', 'observeModel 记降级不记失败')
    assert.match(h.observedNote, /链路存活但极简请求零内容/, '降级 note 标明供应商怪癖（含「零内容」）')
    assert.match(h.observedNote, /maxTokens=8 重试仍空/, '文案保留重试口径便于排查')
    assert.ok(h.lastProbe, '降级也留 lastProbe（探测确实跑过）')
    assert.equal('p/a' in state.modelCooldown, false, '纯空响应不喂冷却嗅探（冷却表零登记）')
    assert.equal(Object.keys(state.badModels).length, 0, '探测不碰 badModels 熔断表（与既有口径一致）')

    // 同一「重试仍空」路径，重试文本带额度字样 → 失败臂，既有嗅探正则接管（quota 优先级高于空响应判定，契约保留）
    var calls2 = [], state2 = { modelHealth: {}, modelCooldown: {}, badModels: {} }
    var quotaText = '429 额度不足：' + EMPTY_RESPONSE_TEXT
    var r2 = await mkDispatch(board, mkProbeScriptCtx(calls2, ['empty', { empty: quotaText }]), state2).probeConfiguredModels(SID, board)
    assert.equal(r2.healthy, 0)
    assert.equal(r2.degraded, 0, '额度信号=真错，不判 degraded（quota 文本优先级高于空响应判定）')
    assert.deepEqual(calls2.map(function (x) { return x.maxTokens }), [1, 8])
    assert.ok(state2.modelCooldown['p/a'] > Date.now(), 'quota 类文本由 parseModelCooldown 接管（失败臂照旧喂嗅探）')
    assert.equal(state2.modelHealth[SID]['p/a'].state, 'cooldown')
    assert.match(state2.modelHealth[SID]['p/a'].cooldownNote, /额度限流/)

    // 凭据类（task-mvrqdw4k 矩阵第 3 行）：空响应文本带凭据字样 → 失败臂（该供应商全模型不可用），不判 degraded
    var calls3 = [], state3 = { modelHealth: {}, modelCooldown: {}, badModels: {} }
    var credText = '401 invalid api key：' + EMPTY_RESPONSE_TEXT
    var r3 = await mkDispatch(board, mkProbeScriptCtx(calls3, ['empty', { empty: credText }]), state3).probeConfiguredModels(SID, board)
    assert.equal(r3.healthy, 0)
    assert.equal(r3.degraded, 0, '凭据信号=真错，不判 degraded')
    assert.equal(state3.modelHealth[SID]['p/a'].state, 'unknown', '凭据类走失败臂（observed=unknown）')
    assert.match(state3.modelHealth[SID]['p/a'].observedNote, /主动探测失败/)
    assert.equal('p/a' in state3.modelCooldown, false, '凭据文本不命中额度/连接嗅探（不误登记冷却）')

    // 连接信号（矩阵第 4 行）：空响应文本带连接字样 → 失败臂，连接嗅探照旧登记短冷却（语义逐字不变）
    var calls4 = [], state4 = { modelHealth: {}, modelCooldown: {}, badModels: {} }
    var connText = 'ECONNRESET：' + EMPTY_RESPONSE_TEXT
    var r4 = await mkDispatch(board, mkProbeScriptCtx(calls4, ['empty', { empty: connText }]), state4).probeConfiguredModels(SID, board)
    assert.equal(r4.healthy, 0)
    assert.equal(r4.degraded, 0, '连接信号=真错，不判 degraded（连接/超时语义逐字不变）')
    assert.ok(state4.modelCooldown['p/a'] > Date.now(), '连接类文本由 parseModelCooldown 接管（连接短冷却）')
    assert.equal(state4.modelHealth[SID]['p/a'].state, 'cooldown')
  } finally { console.error = origErr }
})

// ===== ⑯ degraded 放行（task-mvrqdw4k）：healthyModel 只拦 circuit/cooldown，degraded 必须放行 = 路由仍可选用 =====
// 闭环论证：额度真耗尽有两条独立通道兜底——①宿主直接抛 QUOTA_EXCEEDED（探测即降级冷却）；②若网关伪装成空响应，
// 真派发 run 会失败 → recentRuns 软闸（≥2 全败）跳过它——探测放宽不放跑真坏模型（探测管可调性、行为闸管质量）。
test('⑯degraded放行：降级态模型仍被路由选用（healthyModel 不拦 degraded），公开视图同口径透出 🟡', async () => {
  var spawnCalls = []
  var board = seed(SID)
  board.tasks = [mkTask({ size: 'heavy' })]  // in-progress + spawn-pending（mkTask 缺省，spawn 落闸重验要求）
  board.laneModels.heavy.worker = ['p/a']
  var state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  // 直种 degraded 观察态（probeConfiguredModels 空响应分治的同款产物，⑬d 已断言落账路径）
  state.modelHealth[SID] = { 'p/a': { state: 'degraded', observed: 'degraded', observedNote: '主动探测：链路存活但极简请求零内容（EMPTY_RESPONSE 供应商怪癖）', lastProbe: '2026-10-28T00:00:00.000Z', lastSeen: '2026-10-28T00:00:00.000Z', note: '主动探测：链路存活但极简请求零内容', recentRuns: [] } }
  var origErr = console.error; console.error = function () {}
  try {
    var sr = await mkDispatch(board, { subagents: mkActivationSubagents(spawnCalls) }, state).spawnOneShot(SID, board.tasks[0], 'worker')
    assert.ok(sr)
    assert.deepEqual(spawnCalls[0].request.agentOptions, { provider: 'p', model: 'a' }, 'degraded 模型仍被路由选用（healthyModel 只拦 circuit/cooldown）')
    assert.equal(sr.modelSource, 'lane', '档位槽直取（degraded 放行：未降下一跳/未走备用链/未回父模型）')
    // 公开健康视图（get-tasks 数据源 modelHealthView）：degraded 派生同口径透出，UI 才能显示 🟡降级
    var view = modelHealthView(board, state.modelHealth[SID], { sid: SID, modelCooldown: state.modelCooldown, badModels: state.badModels })
    assert.equal(view['p/a'].state, 'degraded', '公开视图透出 degraded（仲裁放行的单行派生）')
    assert.match(view['p/a'].note, /链路存活但极简请求零内容/, '视图 note 随降级态透出')
  } finally { console.error = origErr }
})

// ===== ⑬e 真失败不重试（task-mvrfp1rj）：无 finish / 超时 语义逐字不变，且不触发 8 token 重试 =====
test('⑬e真失败不重试：无 finish 与超时仍判探测失败（语义逐字不变），不触发空响应重试', async () => {
  var calls = [], board = seed(SID); board.workerModel = 'p/a'
  var state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  var origErr = console.error; console.error = function () {}
  try {
    var r1 = await mkDispatch(board, mkProbeScriptCtx(calls, ['nofinish']), state).probeConfiguredModels(SID, board)
    assert.equal(r1.healthy, 0)
    assert.equal(calls.length, 1, '无 finish 一次定性，不重试')
    assert.match(state.modelHealth[SID]['p/a'].observedNote, /未返回 finish/)

    // 超时：计时器到点 abort（宿主真实行为），probe timeout 文案照旧，同样不重试
    var calls2 = [], state2 = { modelHealth: {}, modelCooldown: {}, badModels: {} }
    var hangCtx = {
      timer: {
        timeout: function (fn) { var t = setTimeout(fn, 0); return function () { clearTimeout(t) } },
        interval: function () { return function () {} }, // 心跳注册（本用例不需要真跑）
      },
      get: function (name) {
        if (name !== 'llm') return null
        return {
          stream: function (options) {
            calls2.push(options)
            return (async function * () {
              await new Promise(function (_, reject) {
                if (options.signal.aborted) return reject(new Error('aborted'))
                options.signal.addEventListener('abort', function () { reject(new Error('aborted')) })
              })
            })()
          },
        }
      },
    }
    var r2 = await mkDispatch(board, hangCtx, state2).probeConfiguredModels(SID, board)
    assert.equal(r2.healthy, 0)
    assert.equal(calls2.length, 1, '超时一次定性，不重试')
    assert.match(state2.modelHealth[SID]['p/a'].observedNote, /probe timeout/, '超时文案沿用既有口径')
    assert.equal('p/a' in state2.modelCooldown, false, 'probe timeout 文本不命中冷却嗅探（既有口径）')
  } finally { console.error = origErr }
})

// ===== ⑰ 探测预算独立（task-mvsv8zym）：每尝试各 20s 非共享递减 + 重试超时沿用首探判定 + 超时不覆盖既有观测 =====
// 事故实证（2026-10-29）：旧 15s 共享 deadline 下慢模型首探耗 ~10s 空响应，重试只剩 4.6s 必超时，
// 被我方预算饿死误记「probe timeout」=模型失败（误导主窗口两次）。记录型计时器捕获预算窗口 ms，不真等 20s。
function mkRecordTimerCtx(base, delays) {
  base.timer = {
    timeout: function (fn, ms) { delays.push(ms); var t = setTimeout(fn, 0); return function () { clearTimeout(t) } },
    interval: function () { return function () {} }, // 心跳注册（本用例不需要真跑）
  }
  return base
}

test('⑰a探测预算独立：每尝试各 20s 非共享递减；慢模型首探空+重试超时→沿用首探判定 🟡degraded 不喂冷却', async () => {
  var calls = [], delays = [], board = seed(SID); board.workerModel = 'p/a'
  var state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  var origErr = console.error; console.error = function () {}
  try {
    // 慢模型复刻（事故实证形态）：首探空响应 + 重试挂起到超时；记录型立即触发计时器
    var ctx = mkRecordTimerCtx(mkProbeScriptCtx(calls, ['empty', 'hang']), delays)
    var result = await mkDispatch(board, ctx, state).probeConfiguredModels(SID, board)
    assert.equal(result.probed, 1)
    assert.equal(result.healthy, 0)
    assert.equal(result.degraded, 1, '重试超时沿用首探判定：首探纯空响应=🟡degraded，不再误记 fail')
    assert.deepEqual(calls.map(function (x) { return x.maxTokens }), [1, 8], '重试节奏不变（首探 1 token → 重试 8 token）')
    assert.deepEqual(delays, [20000, 20000], '每次尝试独立预算：两次计时器窗口各 20s（旧共享制第二次只拿残余递减值）')
    var h = state.modelHealth[SID]['p/a']
    assert.equal(h.state, 'degraded', '🟡降级存活态（非 fail/cooldown/unknown）')
    assert.equal(h.observed, 'degraded')
    assert.match(h.observedNote, /重试预算耗尽（慢模型），沿用首探判定/, '文案标明沿用首探判定')
    assert.match(h.observedNote, /链路存活但极简请求零内容/, '降级 note 保留供应商怪癖口径')
    assert.ok(h.lastProbe, 'degraded 也留 lastProbe（探测确实跑过）')
    assert.equal('p/a' in state.modelCooldown, false, '重试超时+纯空响应不喂冷却')
    assert.equal(Object.keys(state.badModels).length, 0, '不碰熔断表')
  } finally { console.error = origErr }
})

test('⑰b重试超时+首探真错信号：沿用首探判定走失败臂，额度喂冷却/凭据不误登记', async () => {
  var board = seed(SID); board.workerModel = 'p/a'
  var origErr = console.error; console.error = function () {}
  try {
    // 额度类：首探空响应文本带额度字样 + 重试超时 → 沿用首探判定=fail → 嗅探登记冷却
    var calls = [], delays = [], state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
    var quotaText = '429 额度不足：' + EMPTY_RESPONSE_TEXT
    var ctx = mkRecordTimerCtx(mkProbeScriptCtx(calls, [{ empty: quotaText }, 'hang']), delays)
    var r = await mkDispatch(board, ctx, state).probeConfiguredModels(SID, board)
    assert.equal(r.healthy, 0)
    assert.equal(r.degraded, 0, '额度信号=真错，沿用首探判定不判 degraded')
    assert.deepEqual(delays, [20000, 20000], '重试同样拿独立 20s 预算')
    assert.ok(state.modelCooldown['p/a'] > Date.now(), '沿用首探判定后仍喂嗅探（quota 真错）')
    assert.equal(state.modelHealth[SID]['p/a'].state, 'cooldown')
    assert.match(state.modelHealth[SID]['p/a'].observedNote, /重试预算耗尽（慢模型），沿用首探判定/)

    // 凭据类：沿用首探判定走失败臂但不误登记冷却（CREDENTIAL 不命中额度/连接嗅探）
    var calls2 = [], delays2 = [], state2 = { modelHealth: {}, modelCooldown: {}, badModels: {} }
    var credText = '401 invalid api key：' + EMPTY_RESPONSE_TEXT
    var ctx2 = mkRecordTimerCtx(mkProbeScriptCtx(calls2, [{ empty: credText }, 'hang']), delays2)
    var r2 = await mkDispatch(board, ctx2, state2).probeConfiguredModels(SID, board)
    assert.equal(r2.healthy, 0)
    assert.equal(r2.degraded, 0, '凭据信号=真错，沿用首探判定不判 degraded')
    assert.equal(state2.modelHealth[SID]['p/a'].state, 'unknown', '凭据类走失败臂（observed=unknown）')
    assert.match(state2.modelHealth[SID]['p/a'].observedNote, /重试预算耗尽（慢模型），沿用首探判定/)
    assert.equal('p/a' in state2.modelCooldown, false, '凭据文本不命中额度/连接嗅探（不误登记冷却）')
  } finally { console.error = origErr }
})

test('⑰c超时不覆盖既有观测：先 healthy 再超时→仍 healthy+note 更新+延迟保留；首探超时新条目仍 unknown', async () => {
  var board = seed(SID); board.workerModel = 'p/a'
  var origErr = console.error; console.error = function () {}
  try {
    // 先 healthy：正常探测通过
    var state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
    var calls = []
    await mkDispatch(board, mkProbeScriptCtx(calls, ['stop']), state).probeConfiguredModels(SID, board)
    var h = state.modelHealth[SID]['p/a']
    assert.equal(h.state, 'healthy')
    assert.match(h.observedNote, /主动探测通过/)
    var latBefore = h.latencyMs
    assert.equal(typeof latBefore, 'number')
    // 再超时：hang + 立即触发计时器 → 判定保留，observed/state/latency 不倒退
    var calls2 = [], delays2 = []
    var ctx2 = mkRecordTimerCtx(mkProbeScriptCtx(calls2, ['hang']), delays2)
    await mkDispatch(board, ctx2, state).probeConfiguredModels(SID, board)
    assert.deepEqual(calls2.map(function (x) { return x.maxTokens }), [1], '首探超时无重试（⑬e 契约保留）')
    assert.equal(h.state, 'healthy', '超时不覆盖既有 healthy 观测（不倒退成 unknown）')
    assert.equal(h.observed, 'healthy')
    assert.equal(h.latencyMs, latBefore, '超时不覆写既有延迟（保留原 healthy 观测延迟）')
    assert.match(h.observedNote, /主动探测超时（慢模型，判定保留）/, 'note 更新为超时+判定保留')
    assert.match(h.observedNote, /probe timeout/, '保留超时细节便于排查')
    assert.ok(h.lastProbe, '超时也留 lastProbe（探测确实跑过）')

    // 首探超时+无既有观测：新条目仍 unknown + note 更新（不误记 healthy/fail/cooldown）
    var state2 = { modelHealth: {}, modelCooldown: {}, badModels: {} }
    var calls3 = []
    var ctx3 = mkRecordTimerCtx(mkProbeScriptCtx(calls3, ['hang']), [])
    var r3 = await mkDispatch(board, ctx3, state2).probeConfiguredModels(SID, board)
    assert.equal(r3.healthy, 0)
    var h2 = state2.modelHealth[SID]['p/a']
    assert.equal(h2.state, 'unknown', '首探超时新条目=unknown（不误记 fail）')
    assert.equal(h2.observed, 'unknown')
    assert.match(h2.observedNote, /主动探测超时（慢模型，判定保留）/)
    assert.equal('p/a' in state2.modelCooldown, false, 'probe timeout 不命中冷却嗅探（既有口径）')
  } finally { console.error = origErr }
})

async function runVerifierHealth(result) {
  var settle = null, pending = new Promise(function (resolve) { settle = resolve })
  var board = seed(SID); board.verifierModel = 'p/v'; board.tasks = [mkTask({ status: 'verifying' })]
  var state = { modelHealth: {}, modelCooldown: {}, badModels: {} }
  var dispatch = mkDispatch(board, { subagents: mkActivationSubagents([], pending) }, state)
  var rec = await dispatch.spawnOneShot(SID, board.tasks[0], 'verifier')
  assert.equal(rec.model, 'p/v')
  settle(result)
  for (var i = 0; i < 30; i++) {
    var h = state.modelHealth[SID] && state.modelHealth[SID]['p/v']
    if (h && h.recentRuns.length) break
    await new Promise(function (resolve) { setTimeout(resolve, 10) })
  }
  return { board: board, state: state }
}

// ===== ⑭ 被动 run 聚合 + 熔断登记：统一结算点真实落健康表 =====
test('⑭被动健康面：Verifier 成功 run 记健康/延迟/近5次，失败 run 同步熔断且保留失败样本', async () => {
  var ok = await runVerifierHealth({ output: [{ type: 'text', text: 'APPROVED' }], stopReason: 'completed' })
  var ho = ok.state.modelHealth[SID]['p/v']
  assert.equal(ho.state, 'healthy')
  assert.equal(ho.recentRuns.length, 1)
  assert.equal(ho.recentRuns[0].ok, true)
  assert.equal(typeof ho.latencyMs, 'number')
  assert.match(ho.observedNote, /最近 run 成功（近 1 次 1 次成功）/)
  assert.equal(ho.lastProbe, null, '被动 run 不伪造主动探测时间')

  var bad = await runVerifierHealth({ output: [], stopReason: 'error', diagnostic: 'boom' })
  var hb = bad.state.modelHealth[SID]['p/v']
  assert.equal(bad.state.badModels[SID + '|p/v'], true, '原 badModels 熔断判定照常')
  assert.equal(hb.state, 'circuit', '熔断登记同步健康表')
  assert.equal(hb.recentRuns.length, 1)
  assert.equal(hb.recentRuns[0].ok, false)
  assert.match(hb.circuitNote, /验收连续失败/)
})

// ===== ⑮ GUI 健康点与弹层配置：四态/悬浮详情/七处链芯片/局部15s刷新/产物同步 =====
test('⑮模型路由健康点：🟢🟡🔴⚪ + 悬浮详情 + 主动探测配置 + build 产物标记', () => {
  assert.ok(src.indexOf('function ModelHealthDot(props)') >= 0)
  for (const icon of ['🟢', '🟡', '🔴', '⚪']) assert.ok(src.indexOf(icon) >= 0, '缺健康点图标 ' + icon)
  // task-mvrqdw4k 错误码分治：degraded（🟡降级，与 cooldown 同图标不同文案）挂 MODEL_HEALTH_META，源与产物双锁定
  assert.ok(src.indexOf("degraded: { icon: '🟡', label: '降级'") >= 0, '健康点缺 🟡降级档（task-mvrqdw4k 错误码分治）')
  assert.ok(built.indexOf("degraded: { icon: '🟡', label: '降级'") >= 0, 'client.js 缺 🟡降级档（需 npm run build-client）')
  assert.ok(src.indexOf("role: 'img'") >= 0 && src.indexOf("'aria-label': props.model + ' ' + label") >= 0, '健康点缺可访问名称')
  for (const text of ['最近探测：', '最近信号：', '最近延迟：', '次 run：']) assert.ok(src.indexOf(text) >= 0, '悬浮详情缺 ' + text)
  assert.match(src, /React\.createElement\(ModelHealthDot, \{ model: m, health: props\.health \}\)/, '链芯片未接健康点')
  assert.equal((src.match(/OrderedModelsEditor, \{ label:[^\n]*health: modelHealth/g) || []).length, 3, 'Worker/Verifier map + 备用链三处接线覆盖七处编辑器')
  assert.ok(src.indexOf("rpc('get-tasks', args)") >= 0 && src.indexOf('setInterval(refreshModelHealth, 15000)') >= 0, '弹层缺局部健康刷新')
  assert.ok(src.indexOf("key: 'probeEnabled'") >= 0 && src.indexOf("cfgKey: 'probeIntervalMin'") >= 0, '弹层缺探测开关/间隔配置')
  assert.ok(src.indexOf('健康嗅探（事前调度）') >= 0)
  for (const marker of ['function ModelHealthDot(props)', '健康嗅探（事前调度）', "cfgKey: 'probeIntervalMin'", 'health: modelHealth']) {
    assert.ok(built.indexOf(marker) >= 0, 'client.js 缺健康标记：' + marker + '（需 npm run build-client）')
  }
})
