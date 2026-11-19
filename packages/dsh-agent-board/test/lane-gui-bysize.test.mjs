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
//      + 下架模型可发现性（task-mwcw1q7b）：链内不在目录 → 「⚠️下架」标记 + warn 描边；目录 null 不误标
//      + 一键清理失效（task-mwcw2jx8）：「清理失效（N）」按钮有失效项才渲染，过滤纯删除复用 commit 通道
//   ⑱ effort 选择器（task-mwkbo9z6）：{id,effort} 槽位芯片显示「id · effort」（纯字符串只显 id 零视觉
//      变化）+ 添加时 effort 下拉（选项=该模型 efforts、默认 defaultEffort、「默认」=不指定；无 efforts/
//      目录不可用隐藏）+ 芯片 effort 文本点击改档走 onSave 提交 {id,effort}（重建纯函数行为级锁定）
//   ㉝㉞ UX 阶段1 补漏（task-mwnlwd0e）：设置弹层（PoolCfgPopover/ModelRoutePopover）配置项按分组卡片
//      组织（每组一张 C.nested 圆角卡）+ 字号阶梯（组头/配置项标签 fsSub、值·输入·注释 fsAux，与阶段1
//      同族）——定位（fixed+clamp+uiZoom 补偿+预算宽常量）与开关 setCfg 通道零改动 + 产物同步
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
  // ===== 下架模型可发现性（task-mwcw1q7b）：链内不在当前目录 → 芯片标「⚠️下架」+ warn 描边 + title 说明 =====
  // 目录可用（props.models 非空数组）才建索引；目录不可用（null 老宿主/枚举失败，或空目录数组=枚举回空无法判定）
  // inDir 保持 null → 一律不标（无法判定不误标）
  assert.match(src, /var inDir = null/, '缺下架判定基线（目录不可用时须保持 null 不标记）')
  assert.match(src, /if \(models && models\.length\) \{ inDir = \{\}; for \(var mi = 0; mi < models\.length; mi\+\+\) \{ if \(models\[mi\] && models\[mi\]\.id\) inDir\[models\[mi\]\.id\] = 1 \} \}/, '缺目录索引（仅目录非空时构建；空目录/null 均不标）')
  assert.match(src, /var retired = !!\(inDir && !inDir\[m\]\)/, '缺芯片下架判定（链内模型不在目录 → 下架）')
  assert.match(src, /' · ⚠️该模型已不在当前网关可用清单——可直接点 × 移除（仅新增值校验）；要替换请从下方下拉选择'/, '缺下架芯片 title 说明（可直接移除/从下拉替换）')
  assert.match(src, /border: '1px solid ' \+ \(retired \? C\.warn : C\.border\)/, '下架芯片缺 warn 描边（与正常芯片区分）')
  assert.match(src, /retired \? React\.createElement\('span', \{ style: \{ color: C\.warn, fontSize: 8, lineHeight: '12px', flexShrink: 0 \} \}, '⚠️下架'\) : null/, '缺「⚠️下架」芯片标记')
  assert.ok(built.indexOf("'⚠️下架'") >= 0, 'client.js 缺「⚠️下架」标记（需 npm run build-client）')
  assert.ok(built.indexOf('var retired = !!(inDir && !inDir[m])') >= 0, 'client.js 缺下架判定（需 npm run build-client）')
})

// ===== ⑩b 一键清理失效（task-mwcw2jx8）：按钮出现条件 + 过滤纯删除复用 commit 通道 + busy 置灰 + 产物同步 =====
// 背景：同槽多个下架模型逐个 × 要点 N 次等 N 次 RPC——此键一次收口；纯删除在子卡A（task-mwcw0z5t）
// diff 校验下天然放行（仅「当前配置没有的新值」过合法清单），零新增 RPC、零校验改动。
test('⑩b清理失效按钮：有失效项才渲染（计数与下架判定同源）+ 过滤纯删除复用 commit 通道 + 无失效项/目录不可用不渲染 + busy 防连点', () => {
  // 失效计数：与子卡B 下架判定同源（inDir 索引）——目录不可用（inDir=null：老宿主/枚举失败/空目录）恒 0
  assert.match(src, /var retiredCount = inDir \? list\.filter\(function \(m\) \{ return !inDir\[m\] \}\)\.length : 0/, '缺失效计数（须与下架判定同源，目录不可用恒 0 → 按钮不渲染）')
  // 清理函数：过滤掉全部不在目录的项，剩余数组交 commit（与 removeAt 同通道 props.onSave/set-board-config，零新 RPC）
  assert.match(src, /function cleanRetired\(\) \{ if \(!inDir\) return; commit\(list\.filter\(function \(m\) \{ return !!inDir\[m\] \}\)\) \}/, '缺清理函数（过滤全部目录外模型 → 剩余数组走既有 commit 通道）')
  // 按钮渲染条件：retiredCount>0 才渲染（无失效项不添乱）；提交期间 busy 置灰防连点
  // （busy 断言作用域限定在 OrderedModelsEditor 组件体内：文件他处另有同名 busy state 的预览/清理组件）
  const iOme = src.indexOf('function OrderedModelsEditor(props)')
  const iMrp = src.indexOf('function ModelRoutePopover(props)')
  assert.ok(iOme >= 0 && iMrp > iOme, 'OrderedModelsEditor 组件边界切片失败')
  const omeBody = src.slice(iOme, iMrp)
  assert.match(src, /retiredCount \? React\.createElement\('button', \{ onClick: cleanRetired, disabled: busy,/, '清理按钮须以 retiredCount 为渲染条件（无失效项不渲染）')
  assert.match(omeBody, /var _busy = useState\(false\), busy = _busy\[0\], setBusy = _busy\[1\]/, '缺 busy 提交态（置灰防连点）')
  assert.ok(omeBody.indexOf("setMsg(''); setBusy(true)") >= 0, 'commit 提交开始未置 busy')
  assert.equal((omeBody.match(/setBusy\(false\)/g) || []).length, 2, 'commit 成功/异常两臂都须复位 busy（防永久置灰）')
  // 文案与 title（口径逐字：动态计数 N + 「仅删除，不新增」语义）
  assert.match(src, /'清理失效（' \+ retiredCount \+ '）'/, '按钮文案须为「清理失效（N）」动态计数')
  assert.match(src, /title: '一键移除全部已下架模型（仅删除，不新增）'/, '按钮 title 缺「仅删除，不新增」语义')
  // 前提锁：子卡A diff 校验口径未动（纯删除天然放行依赖它；本卡零改动 rpc.mjs）
  const dsrc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
  assert.ok(dsrc.indexOf('首次出现的新值') >= 0, '子卡A diff 校验口径应保持（仅新值过合法清单——纯删除放行的前提）')
  // 产物同步：client.js 重组装后含清理按钮全链标记
  for (const m of ['清理失效（', '一键移除全部已下架模型（仅删除，不新增）', 'function cleanRetired() { if (!inDir) return; commit(list.filter(function (m) { return !!inDir[m] })) }', 'var retiredCount = inDir ? list.filter(function (m) { return !inDir[m] }).length : 0']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺清理按钮标记：' + m + '（需 npm run build-client）')
  }
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

// ===== ⑬f 探测恢复熔断解除（task-mvvw71nc）：连续 2 次探测通过翻绿，红态可证活 =====
// 用户 2026-10-31 实测：「配置模型熔断后状态变红，再下一个探测周期是否会变回来，实测没有」——旧 ok 臂只写
// observed='healthy'，从不碰 badModels 熔断表，syncModelHealth 覆盖闸每次重查熔断表压回 circuit（探测能证
// 「可调用」却解除不了「不可调」判定）。修法（用户拍板「乙+连击」）：探测 ok 臂累计 probeOkStreak，连续 2 次
// （15min 双周期确认）→ delete badModels + 连击清零 + 重派生 + 通知；中断（失败/超时/degraded）计数清零；
// 单次成功不复位（不放过「能回 1 token 但跑长任务就崩」的偶发病模型）。
function mkRecoverState(k) {
  var st = { modelHealth: {}, modelCooldown: {}, badModels: {}, probeOkStreak: {}, modelFailStreak: {} }
  st.badModels[k] = true
  st.modelFailStreak[k] = 3
  st.modelHealth[SID] = {}
  st.modelHealth[SID]['p/a'] = { state: 'circuit', observed: 'healthy', observedNote: '主动探测通过', lastProbe: '2026-10-30T00:00:00.000Z', lastSeen: '2026-10-30T00:00:00.000Z', circuitNote: '连续 3 次 spawn/续跑即被宿主拆除（模型失败），已熔断', recentRuns: [] }
  return st
}
// 捕获 pushSysNote 的派发桩（mkDispatch 的 pushSysNote 是 no-op，恢复通知投递断言需要显式捕获）；
// 接线与 mkDispatch 同形，state 各表按引用共享（probeOkStreak 由测试预置，工厂就地取用同一引用）。
function mkRecoverDispatch(board, ctxOver, state, notes) {
  var shared = Object.assign({ knownSessions: {}, dispatchedEver: {}, teamModeCache: {}, activeRuns: {} }, state)
  return createDispatch(
    Object.assign({ fs: {}, effect: function () {}, get: function () { return null } }, ctxOver || {}),
    shared,
    {
      rt: async function () { return board }, wt: async function () {},
      mutateLocked: async function (sid, fn) { return fn(board) },
      kickCycle: function () {}, rootForSession: function () { return { id: SID } },
      sessionCwd: function () { return '' }, withTimeout: function (p) { return p }, runsFor: function (sid) { return shared.activeRuns[sid] || (shared.activeRuns[sid] = {}) },
      feedbackOn: function () { return true }, pushSysNote: function (sid, text) { notes.push({ sid: sid, text: String(text) }) }, maybeNotify: function () {}, notifyTaskDone: function () {},
    })
}

test('⑬f探测恢复熔断解除：单次通过不复位；连续 2 次→badModels 清除+连击清零+翻 healthy+通知投递', async () => {
  var board = seed(SID); board.workerModel = 'p/a'
  var k = SID + '|p/a'
  var origErr = console.error; console.error = function () {}
  try {
    // ① 已熔断 + 探测成功 1 次 → 仍 circuit（计数 1，badModels/连击未动，零通知）
    var calls = [], notes = [], st = mkRecoverState(k)
    var d = mkRecoverDispatch(board, mkProbeScriptCtx(calls, ['stop']), st, notes)
    var r1 = await d.probeConfiguredModels(SID, board)
    assert.equal(r1.healthy, 1)
    assert.equal(st.badModels[k], true, '单次探测成功不解除熔断（过滤偶发响应）')
    assert.equal(st.probeOkStreak[k], 1, '恢复连击累计 1')
    assert.equal(st.modelFailStreak[k], 3, '熔断连击未被单次探测清零')
    assert.equal(st.modelHealth[SID]['p/a'].state, 'circuit', '覆盖闸仍压回 circuit（半程红态）')
    assert.equal(st.modelHealth[SID]['p/a'].observed, 'healthy', 'observed 已翻 healthy（覆盖态仍 circuit）')
    assert.equal(notes.length, 0, '未复位不发通知')

    // ② 连续第 2 次 → 解除：badModels 清除 + 连击清零 + 恢复计数清零 + state 翻 healthy + 通知投递
    var r2 = await d.probeConfiguredModels(SID, board)
    assert.equal(r2.healthy, 1)
    assert.equal(k in st.badModels, false, '连续 2 次探测通过 → 解除熔断')
    assert.equal(k in st.modelFailStreak, false, '熔断连击清零（复位对称操作）')
    assert.equal(k in st.probeOkStreak, false, '恢复连击复位后清零')
    assert.equal(st.modelHealth[SID]['p/a'].state, 'healthy', '熔断解除后重派生翻绿（🔴→🟢）')
    assert.equal(st.modelHealth[SID]['p/a'].observed, 'healthy')
    assert.equal(notes.length, 1, '解除熔断投递系统通知')
    assert.equal(notes[0].sid, SID)
    assert.equal(notes[0].text, '模型 p/a 连续 2 次探测通过，熔断已解除，恢复调度')

    // ⑤ 解除后再探测成功：未熔断 → 零副作用（不重建计数/不重复通知）
    await d.probeConfiguredModels(SID, board)
    assert.equal(k in st.probeOkStreak, false, '未熔断模型探测成功零副作用（不建多余计数）')
    assert.equal(notes.length, 1, '未熔断不再发通知')
  } finally { console.error = origErr }
})

test('⑬f2探测恢复中断清零：中途一次失败→计数清零重新计；degraded 🟡 不计入不复位', async () => {
  var board = seed(SID); board.workerModel = 'p/a'
  var k = SID + '|p/a'
  var origErr = console.error; console.error = function () {}
  try {
    // ③ 成功 1 次 → 失败 1 次（计数清零）→ 成功 1 次：仍 circuit 且计数 1（必须真的连续，偶发成功不叠加）
    var calls = [], notes = [], st = mkRecoverState(k)
    var d = mkRecoverDispatch(board, mkProbeScriptCtx(calls, ['stop', { error: 'boom' }, 'stop', 'stop']), st, notes)
    await d.probeConfiguredModels(SID, board)
    assert.equal(st.probeOkStreak[k], 1)
    var rf = await d.probeConfiguredModels(SID, board)
    assert.equal(rf.healthy, 0)
    assert.equal(k in st.probeOkStreak, false, '中途一次探测失败 → 恢复计数清零')
    assert.equal(st.badModels[k], true, '失败不复位熔断')
    await d.probeConfiguredModels(SID, board)
    assert.equal(st.probeOkStreak[k], 1, '清零后重新计（不是累计 2）')
    assert.equal(st.badModels[k], true, '仍需再连续一次才解除')
    assert.equal(st.modelHealth[SID]['p/a'].state, 'circuit')
    assert.equal(notes.length, 0)
    await d.probeConfiguredModels(SID, board)
    assert.equal(k in st.badModels, false, '清零重计后连续 2 次才解除')
    assert.equal(notes.length, 1)

    // ④ degraded 🟡（纯空响应供应商怪癖）非探测成功 → 不复位且计数清零（只有 🟢 通过才算证活）
    var calls2 = [], notes2 = [], st2 = mkRecoverState(k)
    var d2 = mkRecoverDispatch(board, mkProbeScriptCtx(calls2, ['stop', 'empty', 'empty']), st2, notes2)
    await d2.probeConfiguredModels(SID, board)
    assert.equal(st2.probeOkStreak[k], 1)
    var rd = await d2.probeConfiguredModels(SID, board)
    assert.equal(rd.degraded, 1, '纯空响应判 🟡degraded 存活')
    assert.equal(k in st2.probeOkStreak, false, 'degraded 不计入恢复连击（清零）')
    assert.equal(st2.badModels[k], true, 'degraded 不复位熔断')
    assert.equal(st2.modelHealth[SID]['p/a'].state, 'circuit', '熔断覆盖态仍在（degraded 未解除）')
    assert.equal(notes2.length, 0, 'degraded 不发解除通知')

    // ④b 探测超时（判定保留臂）同样非成功 → 计数清零不复位
    var calls4 = [], notes4 = [], st4 = mkRecoverState(k)
    await mkRecoverDispatch(board, mkProbeScriptCtx(calls4, ['stop']), st4, notes4).probeConfiguredModels(SID, board)
    assert.equal(st4.probeOkStreak[k], 1)
    var ctx4 = mkRecordTimerCtx(mkProbeScriptCtx(calls4, ['hang']), [])
    await mkRecoverDispatch(board, ctx4, st4, notes4).probeConfiguredModels(SID, board)
    assert.equal(k in st4.probeOkStreak, false, '探测超时（判定保留）同样不计入恢复连击')
    assert.equal(st4.badModels[k], true, '超时不复位熔断')
    assert.equal(st4.modelHealth[SID]['p/a'].state, 'circuit')
    assert.equal(notes4.length, 0)

    // ⑤ 未熔断模型：探测成功零副作用（不建计数/不通知）
    var calls3 = [], notes3 = [], st3 = { modelHealth: {}, modelCooldown: {}, badModels: {}, probeOkStreak: {}, modelFailStreak: {} }
    var d3 = mkRecoverDispatch(board, mkProbeScriptCtx(calls3, ['stop', 'stop']), st3, notes3)
    await d3.probeConfiguredModels(SID, board)
    await d3.probeConfiguredModels(SID, board)
    assert.deepEqual(Object.keys(st3.probeOkStreak), [], '未熔断模型探测成功零副作用（不建多余计数）')
    assert.deepEqual(Object.keys(st3.badModels), [])
    assert.equal(notes3.length, 0, '未熔断无通知')
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

// ===== ⑱ effort 选择器（task-mwkbo9z6）：芯片「id · effort」+ 添加时 effort 下拉 + 芯片改档走 onSave =====
// 前置：子卡1（task-mwkbm37s）list-models 每模型带 efforts（档位 id 清单，空/缺席=不支持或老宿主）与
// defaultEffort（默认档，缺席省略）；子卡2（task-mwkbmu9k）配置面支持 {id,effort?} 复合槽位。
// 本卡纯 GUI（onSave 通道/list-models 拉取零改）：①芯片显示 ②添加下拉 ③芯片改档——⑤产物同步。
test('⑱a effort 选择器·源码结构：两形态读侧（list+effs 平行数组）+ 芯片 effort 段 gated + 添加时 effort 下拉（efforts 选项/defaultEffort 默认/无 efforts 隐藏）+ 改档提交', () => {
  const iOme18 = src.indexOf('function OrderedModelsEditor(props)')
  const iMrp18 = src.indexOf('function ModelRoutePopover(props)')
  assert.ok(iOme18 >= 0 && iMrp18 > iOme18, 'OrderedModelsEditor 组件边界切片失败')
  const ome = src.slice(iOme18, iMrp18)
  // ① 读侧两形态拆解：list=同序 id 数组（去重/下架/清理判定按 id 走，口径零改）+ effs=同序 effort 平行数组
  assert.match(ome, /var raw = Array\.isArray\(props\.value\) \? props\.value : \(typeof props\.value === 'string' && props\.value \? \[props\.value\] : /, '缺两形态读侧容错（老单字符串形态归一为单元素数组）')
  assert.match(ome, /if \(typeof rv === 'string' && rv\.trim\(\)\) \{ list\.push\(rv\.trim\(\)\); effs\.push\(''\) \}/, '字符串项未归一进 list/effs（effort 空=纯字符串形态）')
  assert.match(ome, /typeof rv\.id === 'string' && rv\.id\.trim\(\)\) \{ list\.push\(rv\.id\.trim\(\)\); effs\.push\(typeof rv\.effort === 'string' && rv\.effort\.trim\(\) \? rv\.effort\.trim\(\) : ''\) \}/, '对象项未拆解进 list/effs 平行数组（{id,effort?} → id + effort）')
  // ① 芯片显示：effort 文本段 gated 于 eff（纯字符串槽位不渲染 → 芯片只显 id，零视觉变化）；id 文本段原样
  assert.match(ome, /var eff = effs\[i\] \|\| ''/, '缺芯片 effort 读取（effs 平行数组按下标）')
  assert.match(ome, /eff \? \(effEdit === i/, 'effort 文本/改档下拉未 gated 于 eff（纯字符串芯片不得出现 effort 段）')
  assert.match(ome, /\}, ' · ' \+ eff\)\) : null/, '缺「id · effort」芯片 effort 文本（· 分隔）')
  assert.match(ome, /React\.createElement\('span', null, m\),/, '芯片 id 文本段应保持原样（纯字符串=只显 id）')
  // ② effort 元数据选项源：effortsOf（efforts 空/缺席/目录不可用 → null → 相关 UI 隐藏）+ defaultEffortOf（缺席=''）
  assert.match(ome, /function effortsOf\(id\) \{ var mm = modelMeta && modelMeta\[id\]; return \(mm && Array\.isArray\(mm\.efforts\) && mm\.efforts\.length\) \? mm\.efforts : null \}/, '缺 efforts 选项源（空/缺席=隐藏 effort 选择器）')
  assert.match(ome, /function defaultEffortOf\(id\) \{ var mm = modelMeta && modelMeta\[id\]; return \(mm && typeof mm\.defaultEffort === 'string' && mm\.defaultEffort\) \? mm\.defaultEffort : '' \}/, '缺 defaultEffort 取值（缺席=空串=「默认」档）')
  // ② 添加时 effort 下拉：pickEfforts null（未选/无 efforts/目录不可用/降级手输）→ 不渲染；选项=efforts +「默认」
  assert.match(ome, /var pickEfforts = pickVal \? effortsOf\(pickVal\) : null/, '缺添加时 effort 选项源（pickEfforts=null → 下拉隐藏，只添加 id）')
  assert.match(ome, /pickEfforts \? React\.createElement\('select', \{ value: pickEff, onChange: function \(e\) \{ setPickEff\(e\.target\.value\) \}, title: '思考等级（默认=不指定 effort，走模型默认档）'/, '缺添加时 effort 下拉（渲染 gated 于 pickEfforts）')
  assert.match(ome, /pickEfforts\.map\(function \(ef\) \{ return React\.createElement\('option', \{ key: ef, value: ef \}, ef\) \}\)/, 'effort 下拉选项未来自该模型 efforts 清单')
  assert.match(ome, /React\.createElement\('option', \{ value: '' \}, '默认'\)/, '缺「默认」选项（=不指定 effort，走模型默认档）')
  // ② 模型切换即重置：effort 默认选中该模型 defaultEffort
  assert.match(ome, /setPickEff\(e\.target\.value \? defaultEffortOf\(e\.target\.value\) : ''\)/, '模型切换未把 effort 重置为该模型 defaultEffort')
  // ② 添加落形：选档 → {id,effort} 终形；「默认」/无 efforts → 纯字符串（零变化）
  assert.match(ome, /if \(pickEff && effortsOf\(v\)\) v = \{ id: v, effort: pickEff \}/, '添加未落 {id,effort} 终形（选了档位时）')
  // ③ 芯片改档：点击 effort 文本展开（effortsOf 有选项才可点）+ 改选走 commit（{id,effort} 由重建层落形）
  assert.match(ome, /if \(effOpts\) setEffEdit\(effEdit === i \? null : i\)/, 'effort 文本点击未展开改档下拉（有选项才可点）')
  assert.match(ome, /onChange: function \(e\) \{ changeEffort\(i, e\.target\.value\) \}/, '改档下拉未接 changeEffort')
  assert.match(ome, /var patch = \{\}; patch\[list\[i\]\] = eff \|\| ''/, '缺改档单项覆盖（「默认」=清除回纯字符串）')
  assert.match(ome, /function changeEffort\(i, eff\) \{[\s\S]*?commit\(list\.slice\(\), patch\)/, '改档未走 commit → onSave 通道')
  // ③ 提交重建：effMap（存量 id effort 原样带回，删除/前移/清理不丢档）+ effPatch（改档覆盖）→ onSave 单参形态
  assert.match(ome, /var effMap = \{\}[\s\S]*?next = rebuildEffItems\(next, effMap, effPatch\)/, 'commit 缺两形态重建（存量 effort 按id带回 + 改档覆盖）')
  assert.match(src, /function rebuildEffItems\(next, effMap, effPatch\) \{/, '缺 rebuildEffItems 重建纯函数（模块级，供 commit 落形）')
  assert.match(ome, /Promise\.resolve\(props\.onSave\(next\)\)/, 'onSave 通道形态被改（应保持既有单参形态）')
  // 边界锁：list-models 拉取与下发未动（routeModels 原样传 7 处编辑器，efforts 元数据随 models 透传）
  assert.match(src, /models: routeModels, emptyHint: '继承板级', health: modelHealth/, 'models 透传接线被改（efforts 元数据应随 routeModels 原样下发）')
})

test('⑱b effort 重建纯函数·行为级：纯字符串零变化 + 存量 effort 保留（删除/前移/清理不丢档）+ add 终形直通 + 改档覆盖/清除 + 脏项防御', () => {
  const fnM = src.match(/function rebuildEffItems\(next, effMap, effPatch\) \{[\s\S]*?\n    \}/)
  assert.ok(fnM, '缺 rebuildEffItems 函数体（源码提取失败）')
  const rebuildEffItems = new Function(fnM[0] + '\nreturn rebuildEffItems')()
  // ① 纯字符串数组（老形态/「默认」）：无 effort → 原样输出（零变化）
  assert.deepEqual(rebuildEffItems(['a/b', 'c/d'], {}, null), ['a/b', 'c/d'])
  assert.deepEqual(rebuildEffItems(['a/b'], null, null), ['a/b'], 'effMap null（目录不可用）防御不炸')
  // ② 存量 effort 保留：×/↑/清理传 id 数组，effMap 按 id 带回 {id,effort}（删除/前移/清理/重排不丢档）
  assert.deepEqual(rebuildEffItems(['c/d', 'a/b'], { 'a/b': 'high' }, null), ['c/d', { id: 'a/b', effort: 'high' }])
  assert.deepEqual(rebuildEffItems(['a/b'], { 'a/b': 'high', 'x/y': 'low' }, null), [{ id: 'a/b', effort: 'high' }], 'effMap 只按 next 里的 id 取（链外 id 不带出）')
  // ③ add 终形直通：混合数组（ids + {id,effort}）——对象项 effort 保留、无 effort 对象回纯字符串、均 trim
  assert.deepEqual(rebuildEffItems(['a/b', { id: ' c/d ', effort: ' low ' }], { 'a/b': 'high' }, null), [{ id: 'a/b', effort: 'high' }, { id: 'c/d', effort: 'low' }])
  assert.deepEqual(rebuildEffItems([{ id: ' a/b ' }], null, null), ['a/b'], '无 effort 对象回纯字符串（trim 后）')
  // ④ 改档覆盖：effPatch 优先于 effMap 与对象自带 effort；''=清除回纯字符串
  assert.deepEqual(rebuildEffItems(['a/b'], { 'a/b': 'high' }, { 'a/b': 'low' }), [{ id: 'a/b', effort: 'low' }], '改档覆盖优先于存量 effMap')
  assert.deepEqual(rebuildEffItems(['a/b'], { 'a/b': 'high' }, { 'a/b': '' }), ['a/b'], '「默认」=清除 effort 回纯字符串')
  assert.deepEqual(rebuildEffItems(['a/b'], {}, { 'a/b': 'medium' }), [{ id: 'a/b', effort: 'medium' }], '纯字符串槽位改档 → 落 {id,effort}')
  assert.deepEqual(rebuildEffItems([{ id: 'a/b', effort: 'high' }], {}, { 'a/b': 'low' }), [{ id: 'a/b', effort: 'low' }], '对象槽位改档覆盖（对象自带 effort 让位）')
  // ⑤ 脏项防御：非字符串/缺 id/空 id 丢弃；effort 非字符串忽略；非数组 next → []
  assert.deepEqual(rebuildEffItems([42, { id: '' }, null, ' x/y ', { id: ' m/n', effort: 9 }], null, null), ['x/y', 'm/n'], '脏项丢弃、id trim、非字符串 effort 忽略')
  assert.deepEqual(rebuildEffItems('junk', null, null), [], '非数组入参 → 空数组（防御不炸）')
})

test('⑱c effort 选择器·产物同步：client.js 已重组装且含全链标记', () => {
  for (const m of ['function rebuildEffItems(next, effMap, effPatch)', 'function effortsOf(id)', 'function defaultEffortOf(id)', 'function changeEffort(i, eff)', "React.createElement('option', { value: '' }, '默认')", "' · ' + eff", 'if (pickEff && effortsOf(v)) v = { id: v, effort: pickEff }', 'var pickEfforts = pickVal ? effortsOf(pickVal) : null']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺 effort 选择器标记：' + m + '（需 npm run build-client 重组装）')
  }
})

// ===== ⑲ UX redesign 阶段1（task-mwndiu77）：字号阶梯 + 仪表盘/归档卡片化（纯呈现层，零功能改动）=====
// 口径：只调字号/布局/留白/卡片化，解决「文字太小内容过多」；参照 prototype/ux-redesign.html 阶梯。
//   ① kernel C 对象字号 token（fsBody=13/fsSub=12/fsAux=11）且组件引用 token（替换写死 10-11px）；
//      豁免：8px 图表微标签、既有锁死字号（onboarding 横幅 kernel fontSize:10 原文——别卡的断言口径）
//   ② 仪表盘 16 区全保留 + 卡片化（圆角 8 / 内边距 12 / 区间隔 14）
//   ③ 归档卡片化（行卡 + 标题 fsBody）且全信息保留（检索/计数/徽标/摘要/恢复/runs 链接）
//   ④ 产物同步：client.js 含 token 与卡片化标记（build-client 重拼）
const blsrc = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
// 仪表盘呈现域：TrendChart（首组件）→ WorkModeSwitch（工具栏域，阶段边界外不越刀）
const dashRegion = src.slice(src.indexOf('function TrendChart(props)'), src.indexOf('// 工作模式选择器（v75）'))
// Dashboard 主体（16 区装配处）：Dashboard() → WorkModeSwitch
const dashBody = src.slice(src.indexOf('function Dashboard()'), src.indexOf('// 工作模式选择器（v75）'))
// 归档域：ArchiveView() → CreateTaskForm()
const archRegion = blsrc.slice(blsrc.indexOf('function ArchiveView()'), blsrc.indexOf('function CreateTaskForm()'))

test('⑲UX1-字号阶梯：C 对象 token 13/12/11 + 各域引用 token（呈现域写死 9/10/11 归零）', () => {
  assert.match(ksrc, /fsBody: 13, fsSub: 12, fsAux: 11/, 'kernel C 对象缺字号阶梯 token（正文13/次要12/辅助11）')
  // kernel 域引用：ViewTab 视图切换 + 顶栏错误条 + 入口状态条（合并入口后状态条即唯一入口）
  assert.match(ksrc, /fontSize: C\.fsSub, padding: '4px 12px'/, 'ViewTab 未引用 fsSub token')
  assert.ok(ksrc.indexOf('fontSize: C.fsSub, color: C.err') >= 0, '顶栏读错误条未引用 fsSub token')
  assert.ok(ksrc.indexOf("cursor: 'pointer', fontSize: C.fsSub }") >= 0, '入口状态条（活跃）未引用 fsSub token')
  assert.ok(ksrc.indexOf("cursor: 'pointer', fontSize: C.fsSub, opacity: 0.7 }") >= 0, '入口状态条（全零静态）未引用 fsSub token')
  // 仪表盘呈现域：token 引用成规模 + 写死 9/10/11 归零（8px 图表微标签豁免）
  assert.ok((dashRegion.match(/fontSize: C\.fsSub/g) || []).length >= 60, '仪表盘呈现域 fsSub 引用应覆盖正文/次要文字（≥60 处）')
  assert.ok((dashRegion.match(/fontSize: C\.fsAux/g) || []).length >= 20, '仪表盘呈现域 fsAux 引用应覆盖辅助文字（≥20 处）')
  assert.equal((dashRegion.match(/fontSize: (?:9|10|11)(?!\d)/g) || []).length, 0, '仪表盘呈现域仍写死 9/10/11px（应引用 C.fs* token）')
  // 归档域：标题升 fsBody（正文 13）+ 写死 9/10/11 归零
  assert.ok(archRegion.indexOf('fontSize: C.fsBody, fontWeight: 600') >= 0, '归档行标题未用 fsBody（正文 13）')
  assert.equal((archRegion.match(/fontSize: (?:9|10|11)(?!\d)/g) || []).length, 0, '归档域仍写死 9/10/11px（应引用 C.fs* token）')
})

test('⑳UX1-仪表盘 16 区全保留 + 卡片化（圆角 8 / 内边距 12 / 区间隔 14）', () => {
  // 16 功能区逐个点名（RangeFilter/GlobalBoards/StatCard×6/HealthHints/StorageCleanup/TokenUsage/
  // ModelPerf/QualityTrends/RejectionClusters/状态分布/优先级分布/StatCardDual行/ResearchRoiRow/
  // TrendChart/Agent 负载/最近活跃）——功能不丢是硬约束
  for (const z of [
    'React.createElement(RangeFilter)', 'React.createElement(GlobalBoards)',
    "React.createElement(StatCard, { label: '总任务'", "React.createElement(StatCard, { label: '待办'",
    "React.createElement(StatCard, { label: '进行中'", "React.createElement(StatCard, { label: '验证中'",
    "React.createElement(StatCard, { label: '已完成'", "React.createElement(StatCard, { label: '已归档'",
    'React.createElement(HealthHints)', 'React.createElement(StorageCleanup)',
    'React.createElement(TokenUsage, { usage: state.usageSummary })', 'React.createElement(ModelPerf,',
    'React.createElement(QualityTrends,', 'React.createElement(RejectionClusters,',
    "'按状态分布'", "'按优先级分布'",
    'React.createElement(StatCardDual,', 'React.createElement(ResearchRoiRow,',
    'React.createElement(TrendChart,', "'Agent 负载（进行中+验证中）'", "'最近活跃'"
  ]) { assert.ok(dashBody.indexOf(z) >= 0, '仪表盘缺功能区：' + z + '（16 区全保留是硬约束）') }
  // 卡片化口径：全区卡片 radius 8 + padding 12 + 区间隔 14
  assert.ok((src.match(/padding: '12px', background: C\.card, border: '1px solid ' \+ C\.border, borderRadius: 8/g) || []).length >= 10, '仪表盘区卡未卡片化（radius 8 + padding 12）')
  assert.ok((src.match(/borderRadius: 8, marginBottom: 14/g) || []).length >= 9, '区间隔未调至 14px（卡片化留白口径）')
  assert.match(src, /display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap'/, '分布图两卡行未用 14px 区间隔')
  assert.match(src, /display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap'/, '统计卡行未调留白（gap 8 + 区间隔 14）')
})

test('㉑UX1-归档卡片化 + 全信息保留（检索/计数/徽标/摘要/恢复/runs 链接/详情跳转）', () => {
  // 行卡片化（radius 8 + 行距 8）+ 标题 fsBody
  assert.match(blsrc, /padding: '10px 12px', marginBottom: 8, background: C\.card, border: '1px solid ' \+ C\.border, borderRadius: 8, cursor: 'pointer'/, '归档行未卡片化（radius 8 + padding 10px 12px）')
  // 检索 + 计数（含已取消单列口径）
  assert.ok(archRegion.indexOf('检索标题 / ID / 标签…') >= 0, '归档检索框丢失')
  assert.ok(archRegion.indexOf("'共 ' + archived.length + ' 条'") >= 0, '归档计数行丢失')
  // 徽标族全保留：建议过目 / 验收结论 过·驳 / 已取消
  assert.ok(archRegion.indexOf('👁 建议过目') >= 0, '「建议过目」徽标丢失')
  assert.ok(archRegion.indexOf("? '过' : '驳'") >= 0, '验收结论徽标（过/驳）丢失')
  assert.ok(archRegion.indexOf("'已取消'") >= 0, '「已取消」徽标丢失')
  // 摘要 + 恢复（confirm 门禁口径不变）+ runs 链接 + 空态
  assert.ok(archRegion.indexOf("'📝 ' + t.verification.summary") >= 0, '验收摘要行丢失')
  assert.ok(archRegion.indexOf('↩ 恢复待办') >= 0, '「恢复待办」按钮丢失')
  assert.ok(archRegion.indexOf('恢复待办后将按当前工作模式立即重新派发') >= 0, '恢复重派 confirm 门禁丢失')
  assert.ok(archRegion.indexOf('无历史会话') >= 0, '「无历史会话」空态丢失')
  assert.ok(archRegion.indexOf('uiWorkspaceSvc.openSession(r.id)') >= 0, 'runs 历史会话链接丢失')
  assert.match(archRegion, /onClick: function \(\) \{ state\.detailId = t\.id; notify\(\) \}/, '归档行点击进详情丢失')
  assert.match(archRegion, /onClick: function \(e\) \{ e\.stopPropagation\(\); restore\(t\.id\) \}/, '恢复按钮 handler 丢失')
})

test('㉒UX1-产物同步：client.js 含字号 token 与卡片化标记（需 npm run build-client 重组装）', () => {
  for (const m of [
    'fsBody: 13, fsSub: 12, fsAux: 11',
    "padding: '12px', background: C.card, border: '1px solid ' + C.border, borderRadius: 8",
    "padding: '10px 12px', marginBottom: 8, background: C.card, border: '1px solid ' + C.border, borderRadius: 8",
    'fontSize: C.fsBody, fontWeight: 600',
    "display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap'"
  ]) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺阶段1标记：' + m + '（需 npm run build-client 重组装）')
  }
})

// ===== ㉓/㉔ 方案 F：会话标题栏常驻看板状态条（BoardStatusBar；task-mwndjbb8 落地，task-mwnn0m74 合并入口）=====
// 口径（原型 prototype/ux-redesign.html 方案 F + 合并入口）：常驻显示 ⚡在跑/📋待办/🔍验收/⚠歧义(红)/⛔阻塞(黄)
// 五计数（仅显非零段）；有歧义变红、有阻塞变黄（歧义优先红）；点状态条=展开完整看板——状态条是「智能看板」
// 唯一入口（独立按钮已彻底移除：定义与渲染都不再存在），toggle 与按钮逐字同效；五计数全零淡化为静态
// 「📋 看板」入口；数据源复用 state.tasks（零新增采集）；per-session 一对一不变（isRootStable 同口径：
// 子代理会话不显示；会话切换重置 effect 随按钮迁入状态条，保 per-session 数据生命周期）+ 零新增 slots.inject
// （core.test vm 沙箱锁 injects:2/disposers:9，状态条必须挂既有注册内）。
// 组件域切片：BoardStatusBar() → ViewTab()
const iBsb = ksrc.indexOf('function BoardStatusBar(props)')
const iBsbEnd = ksrc.indexOf('function ViewTab()')
const bsbBody = ksrc.slice(iBsb, iBsbEnd)

test('㉓方案F状态条·源码：唯一入口在位（独立按钮已移除）+ 五计数段 + 红黄变色 + 点击同效 toggle + 无活跃静态入口 + 会话重置迁入 + 零新增 inject', () => {
  // ① 组件在位：定义在 ViewTab 之前（标题栏骨架域），纯函数 helper 同域；独立按钮（BoardButton）彻底移除
  assert.ok(iBsb > 0, '缺 BoardStatusBar 组件定义')
  assert.ok(iBsbEnd > iBsb, 'BoardStatusBar 须定义在 ViewTab 之前（标题栏骨架域）')
  assert.ok(ksrc.indexOf('function boardStatusCounts(tasks)') >= 0, '缺 boardStatusCounts 纯函数')
  assert.equal(ksrc.indexOf('BoardButton'), -1, '独立看板按钮（BoardButton）残留：合并入口必须移除其定义与渲染')
  // ② 五计数段：在跑/待办/验收/歧义/阻塞（仅显非零段，段定义在组件体内）
  for (const seg of ["icon: 'zap', n: cnt.run, label: '在跑'", "icon: 'clipboard-list', n: cnt.pend, label: '待办'", "icon: 'search', n: cnt.verify, label: '验收'", "icon: 'alert-triangle', n: esc, label: '歧义'", "icon: 'ban', n: blk, label: '阻塞'"]) {
    assert.ok(bsbBody.indexOf(seg) >= 0, '状态条缺计数段：' + seg)
  }
  assert.ok(ksrc.indexOf("'search': [") >= 0 && ksrc.indexOf('m21 21-4.3-4.3') >= 0, '缺 Lucide search 图标（验收段）')
  // ③ 变色口径：歧义红（C.err）优先于阻塞黄（C.warn）；红/黄均上描边（border 用 alertColor）
  assert.match(bsbBody, /var alertColor = esc > 0 \? C\.err : \(blk > 0 \? C\.warn : null\)/, '缺红黄变色判定（歧义红优先）')
  assert.match(bsbBody, /border: '1px solid ' \+ \(alertColor \|\| C\.border\)/, '变色未上状态条描边')
  assert.match(bsbBody, /color-mix\(in srgb, ' \+ alertColor \+ ' 10%, transparent\)/, '变色未上淡底衬')
  assert.match(bsbBody, /color: C\.err, tip: '待主窗口裁决', bold: true/, '歧义段未用红色加粗')
  assert.match(bsbBody, /color: C\.warn, tip: '任务阻塞待处理', bold: true/, '阻塞段未用黄色加粗')
  // ④ 点状态条=展开/收起完整看板（与「智能看板」按钮同效 toggle；静态入口从收起态点开）
  assert.match(bsbBody, /onClick: function \(\) \{ state\.open = !state\.open; notify\(\) \}/, '状态条缺与按钮同效的 toggle')
  assert.ok(bsbBody.indexOf("'看板状态：'") >= 0 && bsbBody.indexOf('点击展开完整看板') >= 0, '状态条缺汇总 title（看板状态：…——点击展开完整看板）')
  // ⑤ 无活跃淡化为静态「📋 看板」入口：五计数全零判定 + 淡化 + 点击同效 toggle
  assert.match(bsbBody, /var active = cnt\.run \+ cnt\.pend \+ cnt\.verify \+ cnt\.esc \+ cnt\.block > 0/, '缺无活跃判定（五计数求和）')
  assert.ok(bsbBody.indexOf("title: '看板（当前无活跃任务）——点击展开'") >= 0, '缺静态入口 title')
  assert.ok(bsbBody.indexOf('opacity: 0.7') >= 0, '静态入口未淡化（opacity 0.7）')
  assert.equal((bsbBody.match(/onClick: function \(\) \{ state\.open = !state\.open; notify\(\) \}/g) || []).length, 2, '两分支点击都须与按钮同效 toggle（活跃条 + 静态入口）')
  // ⑥ 数据源零新增采集 + per-session：复用 state.tasks 订阅（listeners），体内无 rpc；isRoot 同口径
  assert.ok(bsbBody.indexOf('setCnt(boardStatusCounts(state.tasks))') >= 0, '数据源未复用 state.tasks')
  assert.equal(bsbBody.indexOf('rpc('), -1, '状态条体内不得新增 RPC 采集')
  assert.match(bsbBody, /listeners\.push\(update\); update\(\);/, '状态条缺 listeners 订阅（notify 驱动实时刷新）')
  assert.match(bsbBody, /setIsRoot\(state\.isRootStable\)/, '缺 isRootStable 订阅（子代理会话不显示，与按钮同口径）')
  assert.ok(bsbBody.indexOf('if (!isRoot) return null') >= 0, '缺子代理会话不渲染闸口')
  // ⑥b 合并入口：原独立按钮的会话切换重置 effect 必须随按钮迁入状态条（否则切会话后状态条显示旧会话数据）
  assert.match(bsbBody, /useEffect\(function \(\) \{ if \(props && props\.sessionId\)/, '缺会话切换重置 effect（合并入口后须由状态条自持）')
  for (const m of ['state.sessionId = sid', 'reqEpoch++', 'state.tasks = []', 'state.children = []', 'state.activity = {}', 'state.detailId = null', 'state.isRootEverTrue = false', 'state.isRootStable = false', 'fetchTasks(); fetchChildren()']) {
    assert.ok(bsbBody.indexOf(m) >= 0, '会话切换重置 effect 不完整，缺：' + m)
  }
  assert.equal((bsbBody.match(/useEffect\(function/g) || []).length, 2, '状态条须恰有 2 个 effect（会话重置 + listeners 订阅）')
  // ⑦ 挂接与边界：状态条挂既有 header.actions 注册且为唯一渲染入口；独立按钮零残留；零新增 inject
  const entryReg = ksrc.slice(ksrc.indexOf("id: 'task-board-btn'"), ksrc.indexOf("slots.inject('shell.overlay'"))
  assert.ok(entryReg.indexOf('React.createElement(BoardStatusBar, props)') >= 0, '状态条未挂既有 header.actions 注册')
  assert.equal((entryReg.match(/createElement\(BoardStatusBar, props\)/g) || []).length, 1, '状态条须为唯一渲染入口')
  assert.equal(entryReg.indexOf('BoardButton'), -1, 'header.actions 注册内仍有独立按钮残留')
  assert.equal((ksrc.match(/slots\.inject\(/g) || []).length, 2, '不得新增 slots.inject（vm 沙箱锁 injects:2/disposers:9）')
  assert.equal((ksrc.match(/ctx\.effect\(/g) || []).length, 1, '不得新增裸 ctx.effect（regEffect 计数闸）')
})

test('㉔方案F boardStatusCounts 行为级：五计数归位/歧义跨状态计数/脏项防御/空板归零 + 产物同步', () => {
  // 抽真函数跑（与 ②b cfgKnobsChanged / ⑱b rebuildEffItems 同手法）
  const fnM = ksrc.match(/function boardStatusCounts\(tasks\) \{[\s\S]*?\n    \}/)
  assert.ok(fnM, '缺 boardStatusCounts 函数体（源码提取失败）')
  const boardStatusCounts = new Function(fnM[0] + '\nreturn boardStatusCounts')()
  // 空板/无任务：五计数全零（无活跃 → 静态入口口径）
  assert.deepEqual(boardStatusCounts([]), { run: 0, pend: 0, verify: 0, esc: 0, block: 0 }, '空板五计数应全零')
  assert.deepEqual(boardStatusCounts(null), { run: 0, pend: 0, verify: 0, esc: 0, block: 0 }, 'null 防御不炸')
  assert.deepEqual(boardStatusCounts([{ status: 'draft' }, { status: 'resolved' }, { status: 'cancelled' }, { status: 'archived' }]), { run: 0, pend: 0, verify: 0, esc: 0, block: 0 }, '草稿/已完成/已取消/已归档不计入五计数')
  // 五计数归位：2 在跑 + 3 待办 + 1 验收 + 1 阻塞
  const mk = (over) => Object.assign({ id: 'x', status: 'pending' }, over || {})
  const counts = boardStatusCounts([
    mk({ status: 'in-progress' }), mk({ status: 'in-progress' }),
    mk({ status: 'pending' }), mk({ status: 'pending' }), mk({ status: 'pending' }),
    mk({ status: 'verifying' }), mk({ status: 'blocked' }),
  ])
  assert.deepEqual(counts, { run: 2, pend: 3, verify: 1, esc: 0, block: 1 }, '五计数逐项归位')
  // 歧义跨状态计数（与按钮 esc 徽章同口径：t.escalation 与 status 无关，resolved 卡上的歧义照计）
  assert.equal(boardStatusCounts([mk({ status: 'resolved', escalation: { question: 'q' } })]).esc, 1, 'resolved 卡上的歧义仍计数（与按钮徽章同口径）')
  assert.equal(boardStatusCounts([mk({ escalation: { question: 'q' } }), mk({ escalation: 1 })]).esc, 2, '多歧义累加')
  // 歧义+阻塞并存：计数各自独立（红黄优先级在渲染层 alertColor，数据层不合并）
  const both = boardStatusCounts([mk({ status: 'blocked', escalation: { question: 'q' } })])
  assert.deepEqual(both, { run: 0, pend: 0, verify: 0, esc: 1, block: 1 }, '歧义与阻塞并存时两计数独立')
  // 脏项防御：null 项/无 status 项不炸不误计
  assert.deepEqual(boardStatusCounts([null, {}, mk({ status: 'pending' })]), { run: 0, pend: 1, verify: 0, esc: 0, block: 0 }, 'null/缺 status 脏项防御')
  // 产物同步：client.js 重组装后含状态条全链标记（npm run build-client）
  for (const m of ['function BoardStatusBar(props)', 'function boardStatusCounts(tasks)', 'React.createElement(BoardStatusBar, props)', "'search': [", "title: '看板（当前无活跃任务）——点击展开'", 'var alertColor = esc > 0 ? C.err : (blk > 0 ? C.warn : null)', "icon: 'ban', n: blk, label: '阻塞'"]) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺方案F状态条标记：' + m + '（需 npm run build-client 重组装）')
  }
  // 产物同步（合并入口）：独立按钮定义/渲染在产物里同样不得残留
  assert.equal(built.indexOf('BoardButton'), -1, 'client.js 产物残留独立看板按钮（需 npm run build-client 重组装）')
})

// ===== ㉕㉖㉗㉘ UX redesign 阶段2（task-mwndjspx）：详情页重构——核心信息四格卡 + 操作区 + 分区折叠 + 高级操作折叠 =====
// 口径（原型 prototype/ux-redesign.html 详情页）：核心信息置顶（状态/优先级·档位/执行模型/耗时四格卡，2×2 栅格）
// + 操作区（FLOW_DEF「流转到」组保留 + 生命周期操作表 OPS_DEF 主/次/危险三档 + 危险操作档原样上移）
// + 分区折叠（操作区/当前动作默认展开；系统记录/仲裁史/执行历史 runs 默认折叠）
// + 高级操作折叠（仲裁/干预/手动派发/跳转/编辑收进折叠区；活跃歧义 escalation 自动展开）。
// 硬约束红线：零功能逻辑改动——FLOW_DEF/flowTo/canJump/jumpToRun/仲裁/干预/手动派发全部既有行为不变（逐字锁）。
const tdsrc = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
// 详情域切片：DetailView() → 文件末（本卡主刀区）
const tdv = tdsrc.slice(tdsrc.indexOf('function DetailView()'))
// 高级操作折叠区切片：k: 'adv' → FamilySection（编辑子区以保存按钮收尾）
const advRegion = tdv.slice(tdv.indexOf("k: 'adv'"), tdv.indexOf('React.createElement(FamilySection'))

test('㉕UX2-核心信息四格卡：状态/优先级·档位/执行模型/耗时 + 2×2 栅格 + 置顶 + 耗时口径纯函数 + 产物同步', () => {
  // 四格标签逐个点名（缺一不可）
  for (const cell of ["'状态'", "'优先级 / 档位'", "'执行模型'", "'耗时'"]) {
    assert.ok(tdv.indexOf(cell) >= 0, '四格卡缺格：' + cell)
  }
  // 2×2 栅格（对齐原型 .detail-core grid 1fr 1fr）
  assert.match(tdv, /gridTemplateColumns: 'repeat\(2, 1fr\)'/, '四格卡缺 2×2 栅格')
  // 置顶：四格卡在 ReviewSummary 与操作区之前（核心信息置顶硬口径）
  const iCore = tdv.indexOf("gridTemplateColumns: 'repeat(2, 1fr)'")
  assert.ok(iCore >= 0 && tdv.indexOf('React.createElement(ReviewSummary') > iCore, '四格卡必须置顶（先于 ReviewSummary）')
  assert.ok(tdv.indexOf("k: 'ops'") > iCore, '四格卡必须先于操作区')
  // 模型格数据源：卡级特例或板级默认（只读）
  assert.ok(tdv.indexOf("cell('执行模型', task.model || '板级默认'") >= 0, '模型格缺 task.model || 板级默认口径')
  // 耗时口径纯函数行为级（注入 elapsedSince/fmtDur 桩提取执行，与 ⑩ decomposeBadgeOf 同手法）
  const fnM = tdsrc.match(/function coreDurText\(t\) \{[\s\S]*?\n    \}/)
  assert.ok(fnM, '缺 coreDurText 函数体（源码提取失败）')
  const coreDurText = new Function('elapsedSince', 'fmtDur', fnM[0] + '\nreturn coreDurText')(function () { return '5m' }, function () { return '12m' })
  assert.equal(coreDurText({ status: 'in-progress', claimedAt: 'x' }), '已跑 5m', 'in-progress+claimedAt → 已跑')
  assert.equal(coreDurText({ status: 'verifying', claimedAt: 'x' }), '已跑 5m', 'verifying+claimedAt → 已跑（当前 run）')
  assert.equal(coreDurText({ status: 'verifying', resolvedAt: 'x' }), '验收 5m', 'verifying 无领取位 → 验收已跑')
  assert.equal(coreDurText({ status: 'resolved', createdAt: 'a', resolvedAt: 'b' }), '总耗时 12m', 'resolved → 创建→落定净总耗时')
  assert.equal(coreDurText({ status: 'pending', createdAt: 'a' }), '存在 5m', '其余 → 存在时长')
  assert.equal(coreDurText(null), '—', 'null 防御不炸')
  // 产物同步（npm run build-client）
  for (const m of ["'优先级 / 档位'", "'执行模型'", 'function coreDurText(t)', "gridTemplateColumns: 'repeat(2, 1fr)'"]) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺四格卡标记：' + m + '（需 npm run build-client 重组装）')
  }
})

test('㉖UX2-操作区：生命周期操作表 OPS_DEF 七态+archived + 主/次/危险三档 + FLOW_DEF 流转组/危险操作区既有标记零回归', () => {
  assert.match(tdv, /var OPS_DEF = \{/, '缺 OPS_DEF 生命周期操作表')
  // 七态 + archived 全有入口（blocked 空数组=流转组承载恢复待办/开始处理）
  const opsRegion = tdv.slice(tdv.indexOf('var OPS_DEF'), tdv.indexOf('var extraOps'))
  for (const st of ["'draft'", "'pending'", "'in-progress'", "'verifying'", "'resolved'", "'blocked'", "'cancelled'", "'archived'"]) {
    assert.ok(opsRegion.indexOf(st + ':') >= 0, 'OPS_DEF 缺状态：' + st)
  }
  // 主/次/危险三档配色表（primary brand 实底 / secondary 描边 / danger err 描边）
  assert.match(tdv, /var OPS_TIER = \{/, '缺 OPS_TIER 三档配色')
  for (const tier of ["primary: { border: 'none', background: C.brand", "secondary: { border: '1px solid ' + C.border2", "danger: { border: '1px solid ' + C.err"]) {
    assert.ok(tdv.indexOf(tier) >= 0, 'OPS_TIER 缺档位：' + tier)
  }
  // 各状态核心操作逐个点名（主档推进主线，含 in-progress 危险档终止）
  for (const op of ["'保存并发布'", "'发布（进入派发池）'", "'派发'", "'派发验收（换 verifier）'", "'归档'", "'重开（回待办）'", "'恢复待办'", "'终止'", "'干预'", "'编辑'"]) {
    assert.ok(opsRegion.indexOf(op) >= 0, 'OPS_DEF 缺操作：' + op)
  }
  // 三档标注成规模（primary/secondary/danger 各 ≥3/≥4/≥1）
  assert.ok((opsRegion.match(/tier: 'primary'/g) || []).length >= 3, 'primary 主档应 ≥3（保存并发布/归档/恢复待办×2）')
  assert.ok((opsRegion.match(/tier: 'secondary'/g) || []).length >= 4, 'secondary 次档应 ≥4（编辑×2/重开/干预×2）')
  assert.ok((opsRegion.match(/tier: 'danger'/g) || []).length >= 1, 'danger 危险档应 ≥1（in-progress 终止）')
  // gate 门禁：verifying 派发验收须避开活跃歧义（既有 !task.escalation 口径）
  assert.match(opsRegion, /label: '派发验收（换 verifier）', icon: 'zap', gate: function \(\) \{ return !task\.escalation \}/)
  // 操作区行渲染：按 OPS_TIER 档位落样式 + 生命周期组名（读屏可报）
  assert.match(tdv, /extraOps\.map\(function \(o\) \{ return React\.createElement\('button', \{ key: o\.label, onClick: o\.run, title: o\.tip/)
  assert.match(tdv, /Object\.assign\(\{ fontSize: 10, padding: '3px 9px', borderRadius: 3, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 \}, OPS_TIER\[o\.tier\]\)/)
  assert.match(tdv, /role: 'group', 'aria-label': '生命周期操作'/)
  // FLOW_DEF 流转组零回归（既有断言口径逐字保留——本卡红线：flowTo 行为不变）
  for (const m of ['var FLOW_DEF = {', "role: 'group', 'aria-label': '状态流转'", "'⇄ 流转到：'", 'function flowTo(to)', "setActionMsg('⚠️ 流转失败：' + (r.error || '未知错误'))", "'▶ 开始处理'", "'✅ 提交验收'", "'⛔ 标记阻塞'", "'↩ 重投待办'", "'✔ 验收通过'", "'↩ 驳回重投'"]) {
    assert.ok(tdv.indexOf(m) >= 0, 'FLOW_DEF 流转组标记丢失：' + m)
  }
  // 危险操作区既有标记零回归（task-mv493xjs 视觉分层：虚线分隔 + aria-label + 取消任务/删除接线收进操作区末档）
  for (const m of ["'aria-label': '危险操作'", "borderTop: '1px dashed ' + C.err", "ic('ban', 10), '取消任务'", 'cancelTask(task.id, task.title, setActionMsg)', 'canCancel(task) ? React.createElement', "ic('trash-2', 10), '删除'"]) {
    assert.ok(tdv.indexOf(m) >= 0, '危险操作区标记丢失：' + m)
  }
  // 产物同步
  for (const m of ['var OPS_DEF = {', 'var OPS_TIER = {', "k: 'ops'", "'操作（' + (statusLabels[task.status] || task.status) + '）：'"]) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺操作区标记：' + m + '（需 npm run build-client）')
  }
})

test('㉗UX2-分区折叠：Section 组件（原生 button 头 + aria-expanded）+ 默认口径（操作/当前动作展开；系统记录/仲裁史/runs 折叠）+ 三折叠区有内容才渲染', () => {
  assert.match(tdsrc, /function Section\(props\)/, '缺 Section 折叠组件')
  // 折叠头必须原生 button（本文件 div+onClick 纪律归零；键盘可达 + aria-expanded 供读屏）
  assert.match(tdsrc, /React\.createElement\('button', \{ onClick: function \(\) \{ if \(props\.onToggle\) props\.onToggle\(props\.k\) \}, 'aria-expanded': open \? 'true' : 'false'/, 'Section 头缺原生 button / aria-expanded')
  // 默认口径：ops/act 展开，sys/arb/runs 折叠，adv 默认折叠但有歧义自动展开（useState 初始化 + 切卡重置同款）
  assert.match(tdv, /return \{ ops: true, act: true, sys: false, arb: false, runs: false, adv: !!\(task && task\.escalation\) \}/, '缺省折叠口径不符（操作/当前动作展开；系统记录/仲裁史/runs 折叠）')
  assert.match(tdv, /setFolds\(\{ ops: true, act: true, sys: false, arb: false, runs: false, adv: !!\(t && t\.escalation\) \}\)/, '切卡重置折叠态缺失')
  // 五分区标题逐个点名 + open: folds 接线（受控折叠，状态在 DetailView）
  for (const s of ["k: 'ops', title: '⚡ 操作'", "k: 'act', title: '📡 当前动作'", "k: 'sys', title: '🗂 系统记录 · 流转轨迹'", "k: 'arb', title: '⚖ 仲裁史 · 裁决对话'", "k: 'runs', title: '👥 执行历史（runs）'"]) {
    const i = tdv.indexOf(s)
    assert.ok(i >= 0, '缺分区：' + s)
    assert.ok(/open: folds\./.test(tdv.slice(i, i + 320)), '分区缺 open: folds 接线：' + s)
  }
  // 有内容才渲染（空卡零 DOM）：仲裁史 gate messages / 系统记录 gate history / runs 沿用 !runs.length / 当前动作 act&run
  assert.match(tdv, /\(Array\.isArray\(task\.messages\) && task\.messages\.length\) \? React\.createElement\(Section, \{ k: 'arb'/, '仲裁史折叠区缺内容门禁')
  assert.match(tdv, /Array\.isArray\(task\.history\) && task\.history\.length > 0 \? React\.createElement\(Section, \{ k: 'sys'/, '系统记录折叠区缺内容门禁')
  assert.match(tdv, /if \(!runs\.length\) return null/, 'runs 折叠区缺内容门禁（沿用既有口径）')
  assert.match(tdv, /if \(!act && !run\) return null/, '当前动作区缺内容门禁')
  // 当前动作区收拢既有两块：activity 脉冲行 + 运行信息行（子会话 id 标注原样保留）
  assert.match(tdv, /'当前动作: ' \+ state\.activity\[task\.id\]/, '当前动作区缺 activity 脉冲行')
  assert.match(tdv, /'子会话 id: ' \+ task\.claimedBy \+ '（对应子代理列表同名条目）'/, '当前动作区缺运行信息行（子会话 id）')
  // 产物同步
  for (const m of ['function Section(props)', "k: 'sys', title: '🗂 系统记录 · 流转轨迹'", "k: 'arb', title: '⚖ 仲裁史 · 裁决对话'", "k: 'runs', title: '👥 执行历史（runs）'"]) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺分区折叠标记：' + m + '（需 npm run build-client）')
  }
})

test('㉘UX2-高级操作折叠：仲裁/干预/手动派发/跳转/编辑收进折叠区 + 歧义自动展开 + openAdv 锚点 + canJump 零改动 + 产物同步', () => {
  // 高级操作 Section 在位（默认折叠，adv key；hint 列五要素）
  assert.ok(advRegion.indexOf("k: 'adv', title: '⚙ 高级操作'") >= 0, '缺 ⚙ 高级操作 折叠区')
  assert.ok(advRegion.indexOf('仲裁 · 干预 · 手动派发 · 跳转 · 编辑') >= 0, '高级操作 hint 缺五要素')
  // ① 仲裁：tskb-escalation 块收进折叠区（HooksSection goArbitration 锚点不悬空）
  assert.ok(advRegion.indexOf("id: 'tskb-escalation'") >= 0, '仲裁块未收进高级操作折叠区（tskb-escalation）')
  assert.ok(advRegion.indexOf('Worker 上报歧义 — 等待主窗口裁决') >= 0, '仲裁块标题丢失')
  // ② 干预：tskb-adv-intervene 输入块收进折叠区
  assert.ok(advRegion.indexOf("id: 'tskb-adv-intervene'") >= 0, '干预输入未收进高级操作折叠区（tskb-adv-intervene）')
  assert.ok(advRegion.indexOf('高优先级介入（插入执行 Agent 队首）') >= 0, '干预块标题丢失')
  // ③ 手动派发：子区收进折叠区（与操作区同一动作函数 doManualDispatch/doTerminate）
  assert.ok(advRegion.indexOf('手动派发 / 终止') >= 0, '手动派发子区未收进高级操作折叠区')
  assert.match(advRegion, /doAction\(function \(\) \{ return doManualDispatch\('worker'\) \}\)/, '折叠区派发按钮未复用 doManualDispatch')
  assert.match(advRegion, /doAction\(function \(\) \{ return doManualDispatch\('verifier'\) \}\)/, '折叠区派发验收按钮未复用 doManualDispatch')
  assert.match(advRegion, /onClick: doTerminate/, '折叠区终止按钮未复用 doTerminate')
  // ④ 跳转：子区收进折叠区（canJump Worker 会话 + 拆解官会话）
  assert.ok(advRegion.indexOf('跳转（子会话）') >= 0, '跳转子区未收进高级操作折叠区')
  assert.ok(advRegion.indexOf('jumpToAgent') >= 0 && advRegion.indexOf('jumpToRun(decRun.id)') >= 0, '跳转子区缺 jumpToAgent/jumpToRun 接线')
  // ⑤ 编辑：tskb-adv-edit 子区（标题/描述/属性行/标签/touches/保存按钮全收拢）
  assert.ok(advRegion.indexOf("id: 'tskb-adv-edit'") >= 0, '编辑子区未收进高级操作折叠区（tskb-adv-edit）')
  for (const m of ['React.createElement(TagsEditor, { key: task.id, task: task })', "React.createElement(TouchesEditor, { key: task.id + '|touches', task: task })", 'onClick: saveEdit', "task.status === 'draft' ? ' 保存并发布' : ' 保存并重置'"]) {
    assert.ok(advRegion.indexOf(m) >= 0, '编辑子区缺控件：' + m)
  }
  // 属性编辑行（优先级/档位下拉）收进编辑子区：size 下拉紧随状态徽章（既有断言口径串原样保留）
  assert.ok(advRegion.indexOf("statusLabels[task.status] || task.status), React.createElement('select', { value: task.size || (state.teamMode ? 'standard' : ''") >= 0, '属性编辑行未收进编辑子区（size 下拉）')
  // 歧义自动展开：escalation 出现时 adv 折叠区自动展开（待裁决上报不能被折叠埋没）
  assert.match(tdv, /if \(task && task\.escalation\) setFolds\(function \(f\) \{ return f\.adv \? f : Object\.assign\(\{\}, f, \{ adv: true \}\) \}\)/, '缺歧义自动展开高级操作')
  // openAdv 锚点通道：操作区「编辑/干预」按钮展开折叠区并滚动（goArbitration 同款 scrollIntoView）
  assert.match(tdv, /function openAdv\(anchor\) \{[\s\S]*?document\.getElementById\(anchor\)/, '缺 openAdv 锚点滚动通道')
  assert.ok(tdv.indexOf("openAdv('tskb-adv-edit')") >= 0, '操作区「编辑」未接 openAdv')
  assert.ok(tdv.indexOf("openAdv('tskb-adv-intervene')") >= 0, '操作区「干预」未接 openAdv')
  // canJump / jumpToRun 零改动红线（decompose ⑬c 同款逐字锁）
  assert.ok(tdv.indexOf("var canJump = (task.status === 'in-progress' || task.status === 'verifying') && task.claimedBy && task.claimedBy !== state.sessionId") >= 0, 'canJump 条件被改动（应保持原样）')
  assert.match(tdv, /function jumpToRun\(runId\) \{ if \(uiWorkspaceSvc && runId\) uiWorkspaceSvc\.openSession\(runId\) \}/, 'jumpToRun 缺 openSession 接线')
  // 恢复待办/重开主档：与归档 tab restore 同款 confirm 门禁 + 既有 resetToPending 通道
  assert.match(tdv, /function doResetPending\(what\) \{[\s\S]*?window\.confirm\(what \+ '后将按当前工作模式立即重新派发，消耗一轮 Worker\+Verifier token。继续？'\)/, 'doResetPending 缺 confirm 门禁')
  assert.match(tdv, /function doResetPending\(what\) \{[\s\S]*?rpc\('update-task', \{ taskId: task\.id, resetToPending: true \}\)/, 'doResetPending 未走既有 resetToPending 通道')
  // 产物同步
  for (const m of ["k: 'adv', title: '⚙ 高级操作'", "id: 'tskb-escalation'", "id: 'tskb-adv-intervene'", "id: 'tskb-adv-edit'", 'function openAdv(anchor)', 'function doResetPending(what)']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺高级操作折叠区标记：' + m + '（需 npm run build-client）')
  }
})

// ===== ㉙㉚㉛㉜ UX redesign 阶段3（task-mwndka2w）：执行池四区——模型健康 + 最近完成 + 资源水位 =====
// 口径（原型 prototype/ux-redesign.html 执行池）：TeamView 保留成员卡细节与超时策略编辑（零回归硬约束），
// 新增三区——②模型健康（每模型健康态 + effort 档 + 目录外「已下架」）③最近完成 feed（带时间）④资源水位
// （Worker/Verifier 并发 + 本小时 token + 今日完成）。数据面红线：三区全部复用既有通道现算零新增采集——
// 模型清单/水位/feed 读 state（laneModels / poolStatus / tasks 的 run 留账）；健康四态与 effort/下架元数据走
// 既有 RPC（get-tasks.modelHealth 局部 15s 刷新 + list-models 目录一次取），与 ModelRoutePopover 同款
// 「局部拉取不改 kernel 全局 state」。
const i3tv = src.indexOf('function TeamView()')
assert.ok(i3tv >= 0, '缺 TeamView 组件')
const tv3 = src.slice(i3tv) // TeamView 本体 + 其后三区纯函数助手（本卡主刀区）

test('㉙执行池四区·骨架与保留面：成员卡细节 + 超时策略编辑零回归 + 三区标题/卡片化在位', () => {
  // ① 保留面（既有功能红线，验收口径①②）：成员卡四要素逐个点名
  assert.match(tv3, /'🧬 ' \+ m\.model/, '成员卡缺模型行（🧬 + m.model）')
  assert.ok(tv3.indexOf('modelSourceBadge(m.modelSource)') >= 0, '成员卡缺取模来源角标')
  assert.match(tv3, /curTask \? React\.createElement\('div', \{ onClick: function \(\) \{ state\.detailId = curTask\.id; state\.view = 'board'; notify\(\) \}/, '成员卡缺当前任务点击链接（进详情）')
  assert.ok(tv3.indexOf("'会话 ' + String(m.runId || '').slice(0, 8) + '…（用完即销毁）'") >= 0, '成员卡缺一次性会话 id 行')
  assert.ok(tv3.indexOf("'忙碌'") >= 0, '成员卡缺忙碌徽标')
  // 超时策略编辑（软/硬双输入 + saveTimeout 写通道）逐字保留（验收口径②）
  assert.match(tv3, /function saveTimeout\(cfgKey, v, min, max\)/, '缺 saveTimeout 超时保存函数')
  assert.match(tv3, /rpc\('set-board-config', \{ key: cfgKey, value: n \}\)/, '超时保存未走 set-board-config')
  assert.ok(tv3.indexOf("'超时策略:'") >= 0, '缺超时策略行标题')
  assert.ok(tv3.indexOf("saveTimeout('softTimeoutMin'") >= 0 && tv3.indexOf("saveTimeout('hardTimeoutMin'") >= 0, '软/硬超时输入接线丢失')
  // ② 三区标题逐个点名（验收口径③④⑤的门面）
  for (const z of ["'模型健康 ('", "'最近完成 ('", "'资源水位'"]) assert.ok(tv3.indexOf(z) >= 0, '缺三区标题：' + z)
  // 三区容器：flex wrap 三卡（卡片化口径与仪表盘一致 radius 8 + padding 12，窄面板可折行）
  assert.match(tv3, /flex: '1 1 230px', minWidth: 230, padding: '12px', background: C\.card, border: '1px solid ' \+ C\.border, borderRadius: 8/, '三区卡片化口径缺失（zoneBox）')
  assert.match(tv3, /display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12/, '三区容器缺 flex wrap 布局')
})

test('㉚执行池四区·模型健康：每模型健康态（ModelHealthDot 复用）+ effort 档 + 已下架 + 局部拉取零新增采集', () => {
  // ① 健康态：行内复用 ModelHealthDot（🟢🟡🔴⚪四态 + 悬浮详情，与模型路由弹层同源）+ 状态标签着色
  assert.match(tv3, /React\.createElement\(ModelHealthDot, \{ model: mid, health: mhData \}\)/, '健康行缺 ModelHealthDot 接线')
  assert.ok(tv3.indexOf('(h && MODEL_HEALTH_META[h.state]) || MODEL_HEALTH_META.unknown') >= 0, '健康行缺状态标签（MODEL_HEALTH_META 着色）')
  // ② effort 档：显式档优先 → 目录 defaultEffort 兜底 → '—' 空档（title 三态说明）
  assert.match(tv3, /var eff = tmr\.effConf\[mid\] \|\| \(tmr\.defEff && tmr\.defEff\[mid\]\) \|\| ''/, '缺 effort 档合成（显式档→模型默认档→空）')
  assert.ok(tv3.indexOf("eff || '—'") >= 0, '缺 effort 空档「—」占位')
  assert.ok(tv3.indexOf('思考等级 effort 档：') >= 0, '缺 effort title 口径说明')
  // ③ 已下架：目录可用才标（inCat=null 目录不可用/老宿主不误标——OrderedModelsEditor 同口径）
  assert.match(tv3, /var retired = !!\(tmr\.inCat && !tmr\.inCat\[mid\]\)/, '缺已下架判定（inCat 索引缺项）')
  assert.ok(tv3.indexOf("'⚠️已下架'") >= 0, '缺「⚠️已下架」行内标记')
  // ④ 局部拉取（数据源红线：不改 kernel 全局 state、零新增采集——健康面走既有 get-tasks 通道）
  assert.match(tv3, /function refreshTeamHealth\(\) \{/, '缺 refreshTeamHealth 局部健康拉取')
  assert.match(tv3, /rpc\('get-tasks', args\)/, '健康拉取未走既有 get-tasks 通道')
  assert.ok(tv3.indexOf('setMhData(d.modelHealth || null)') >= 0, '健康拉取未取 d.modelHealth')
  assert.ok(tv3.indexOf('setInterval(refreshTeamHealth, 15000)') >= 0, '缺 15s 局部健康刷新')
  assert.ok(tv3.indexOf('epoch !== mhEpoch.current') >= 0, '缺 epoch 迟到响应丢弃（卸载后 setState 防护）')
  assert.ok(tv3.indexOf("rpc('list-models')") >= 0, '缺 list-models 目录拉取（efforts/defaultEffort 元数据已透出）')
  // 空态与降级提示：未配置模型 / 健康信号读取中 / 目录不可用（能力检测不误报）
  assert.ok(tv3.indexOf('未配置模型（板级 / 力度路由 / 备用链均为空') >= 0, '缺未配置模型空态')
  assert.ok(tv3.indexOf('模型目录不可用：已下架判定与默认 effort 档关闭') >= 0, '缺目录不可用降级提示')
})

test('㉚b执行池四区·teamModelRows 行为级：板级∪六槽∪备用链去重保序 + 两形态 effort + 目录索引/已下架/默认档/脏防御', () => {
  const fnM = src.match(/function teamModelRows\(workerModel, verifierModel, laneModels, fallbackModels, catModels\) \{[\s\S]*?\n    \}/)
  assert.ok(fnM, '缺 teamModelRows 函数体（源码提取失败）')
  const teamModelRows = new Function(fnM[0] + '\nreturn teamModelRows')()
  // ① 清单=板级∪六槽∪备用链，去重保序（与 host 侧 configuredModelIds 同口径）
  const LANES = { light: { worker: [], verifier: ['p/d'] }, standard: { worker: [], verifier: [] }, heavy: { worker: ['p/b', 'p/a'], verifier: [] } }
  const r1 = teamModelRows('p/a', 'p/v', LANES, ['p/c', 'p/a'], null)
  assert.deepEqual(r1.order, ['p/a', 'p/v', 'p/d', 'p/b', 'p/c'], '清单=板级∪六槽∪备用链去重保序')
  // ② 两形态 effort：{id,effort} 显式档收录（六槽/备用链同形）；首见无档、后续带档 → 补上
  const L2 = { light: { worker: ['p/x'], verifier: [] }, standard: { worker: [], verifier: [] }, heavy: { worker: [], verifier: [] } }
  assert.equal(teamModelRows('', '', L2, [{ id: 'p/x', effort: 'high' }], null).effConf['p/x'], 'high', '备用链 {id,effort} 显式档收录')
  const r3 = teamModelRows('p/x', '', { light: { worker: [], verifier: [] }, standard: { worker: [], verifier: [] }, heavy: { worker: [], verifier: [] } }, [{ id: 'p/x', effort: 'low' }], null)
  assert.equal(r3.effConf['p/x'], 'low', '板级首见无档、备用链带档 → 补上（首个非空档优先）')
  // ③ 目录索引：非空才建 inCat/defEff；defaultEffort 收录、无者不猜；目录外 id 下架可判定
  const r4 = teamModelRows('p/a', 'p/b', null, ['p/zz'], [{ id: 'p/a', defaultEffort: 'high' }, { id: 'p/b' }])
  assert.deepEqual(r4.inCat, { 'p/a': 1, 'p/b': 1 }, '目录非空建索引')
  assert.equal(r4.defEff['p/a'], 'high', 'defaultEffort 收录')
  assert.equal(r4.defEff['p/b'], undefined, '无 defaultEffort 不猜')
  assert.equal(r4.inCat['p/zz'], undefined, '目录外模型已下架可判定')
  // ④ 目录不可用（null）/空目录：不建索引（下架不误标——OrderedModelsEditor inCat 同口径）
  assert.equal(teamModelRows('p/a', '', null, null, null).inCat, null, '目录 null 不建索引')
  assert.equal(teamModelRows('p/a', '', null, null, []).inCat, null, '空目录不建索引（枚举回空无法判定）')
  // ⑤ 脏防御：非字符串/空 id 丢弃、id trim；laneModels 数组/备用链字符串等脏形态不炸
  const r7 = teamModelRows('', '', { light: { worker: [42, { id: '' }, ' x/y '], verifier: [] }, standard: {}, heavy: {} }, null, null)
  assert.deepEqual(r7.order, ['x/y'], '脏项丢弃 + id trim')
  assert.deepEqual(teamModelRows('', '', [], 'junk', null).order, [], 'laneModels 数组/备用链字符串脏形态不炸')
})

test('㉛执行池四区·最近完成+资源水位源码级：feed 倒序带时间点击进详情 + 并发/本小时 token/今日完成水位行', () => {
  // ① 最近完成 feed 渲染：相对时间 ago + 点击进详情（与成员卡任务链接同款交互）+ 空态
  assert.ok(tv3.indexOf("'· ' + ago(doneAt)") >= 0, 'feed 条目缺相对时间（ago）')
  assert.ok(tv3.indexOf("state.detailId = t.id; state.view = 'board'; notify()") >= 0, 'feed 条目缺点击进详情')
  assert.ok(tv3.indexOf('暂无已完成任务') >= 0, 'feed 缺空态文案')
  assert.ok(tv3.indexOf("'最近完成 (' + feed.length") >= 0, 'feed 标题缺计数')
  // ② 资源水位：并发（poolStatus busy / maxWorkers·maxVerifiers 上限分母）+ 三行水位 + 今日完成
  assert.match(tv3, /var wBusyN = \(ps\.workers \|\| \[\]\)\.filter\(function \(m\) \{ return m && m\.busy \}\)\.length/, '缺 Worker busy 并发计数')
  assert.match(tv3, /var vBusyN = \(ps\.verifiers \|\| \[\]\)\.filter\(function \(m\) \{ return m && m\.busy \}\)\.length/, '缺 Verifier busy 并发计数')
  assert.ok(tv3.indexOf('state.maxWorkers || 3') >= 0 && tv3.indexOf('state.maxVerifiers || 2') >= 0, '缺并发上限分母（state.maxWorkers/maxVerifiers）')
  for (const row of ["'Worker 并发'", "'Verifier 并发'", "'本小时 token 消耗'", "'今日完成任务'"]) assert.ok(tv3.indexOf(row) >= 0, '资源水位缺行：' + row)
  // 水位条与百分比：pctOf（0 值不显条、非零保底 2%）+ waterRow 渲染 + 消耗空态
  assert.match(tv3, /function pctOf\(v, max\) \{ var x = Number\(v\) \|\| 0; if \(!\(max > 0\)\) return 0; var p = Math\.round\(x \/ max \* 100\); return x > 0 \? Math\.max\(2, p\) : 0 \}/, '缺 pctOf 水位百分比')
  assert.match(tv3, /function waterRow\(label, valText, pct, tip, color\) \{/, '缺 waterRow 水位条组件')
  assert.ok(tv3.indexOf("'暂无消耗'") >= 0, 'token 水位缺零消耗空态')
})

test('㉛b执行池四区·水位行为级：teamHourTokens（本小时/峰值/今日合计+分量兜底+他日不计）+ teamTodayDone（今日零点口径）', () => {
  const fnH = src.match(/function teamHourTokens\(tasks, now\) \{[\s\S]*?\n    \}/)
  assert.ok(fnH, '缺 teamHourTokens 函数体（源码提取失败）')
  const teamHourTokens = new Function(fnH[0] + '\nreturn teamHourTokens')()
  const fnD = src.match(/function teamTodayDone\(tasks, now\) \{[\s\S]*?\n    \}/)
  assert.ok(fnD, '缺 teamTodayDone 函数体（源码提取失败）')
  const teamTodayDone = new Function(fnD[0] + '\nreturn teamTodayDone')()
  function isoOf(y, m, d, h) { return new Date(y, m - 1, d, h).toISOString() }
  const now = new Date(2026, 10, 19, 15, 30) // 2026-11-19 15:30 本地
  const tk = [
    { runs: [{ at: isoOf(2026, 11, 19, 14), usage: { total: 100 } }, { at: isoOf(2026, 11, 19, 15), usage: { total: 300 } }] },
    { runs: [{ at: isoOf(2026, 11, 19, 15), usage: { total: 120, input: 0, output: 0 } }, { at: isoOf(2026, 11, 18, 20), usage: { total: 999 } }] },
    { runs: [{ at: isoOf(2026, 11, 19, 15), usage: { total: 0, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }] }, // total=0 → 分量兜底
    { runs: [{ at: isoOf(2026, 11, 19, 15) }] }, // 无 usage run 不计（不伪造 0）
    { junk: 1 }, // 无 runs 脏项
  ]
  const ht = teamHourTokens(tk, now)
  assert.equal(ht.cur, 300 + 120 + 15, '当前时钟小时合计（含 total=0 分量兜底；无 usage/他日均不计）')
  assert.equal(ht.peak, 435, '峰值小时=15 点桶（14 点桶 100 更小）')
  assert.equal(ht.today, 100 + 300 + 120 + 15, '今日合计（昨日 999 不计）')
  assert.equal(teamHourTokens([], now).cur, 0, '空板零消耗')
  assert.equal(teamHourTokens(null, now).peak, 0, 'null 防御')
  // 今日完成：resolvedAt 过今日零点（与仪表盘 computeStats.todayDone 同口径）；脏项/未完成不计
  const td = [
    { resolvedAt: isoOf(2026, 11, 19, 0) },
    { resolvedAt: isoOf(2026, 11, 19, 23) },
    { resolvedAt: isoOf(2026, 11, 18, 23) },
    { resolvedAt: null },
    null,
  ]
  assert.equal(teamTodayDone(td, now), 2, '今日完成=过了今日零点的 resolvedAt（与时钟时分无关）')
  assert.equal(teamTodayDone(null, now), 0, 'null 防御')
})

test('㉜执行池四区·产物同步：client.js 已重组装且含三区全链标记（验收口径⑥）', () => {
  for (const m of [
    '模型健康', '最近完成', '资源水位', '⚠️已下架',
    'function teamModelRows(workerModel, verifierModel, laneModels, fallbackModels, catModels)',
    'function teamDoneFeed(tasks, n)', 'function teamHourTokens(tasks, now)', 'function teamTodayDone(tasks, now)',
    'function refreshTeamHealth()', 'setInterval(refreshTeamHealth, 15000)', 'setMhData(d.modelHealth || null)',
    '本小时 token 消耗', '今日完成任务', '未配置模型（板级 / 力度路由 / 备用链均为空',
    // 保留面产物级复核（验收口径①②：成员卡细节与超时策略不得在产物里走样）
    'function saveTimeout(cfgKey, v, min, max)', '超时策略:', '忙碌', 'modelSourceBadge(m.modelSource)',
  ]) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺执行池四区标记：' + m + '（需 npm run build-client 重组装）')
  }
})

// ===== ㉝㉞ UX 阶段1 补漏（task-mwnlwd0e）：设置弹层卡片化 + 字号阶梯 =====
// 口径（原型 prototype/ux-redesign.html 设置视图 setting-card）：PoolCfgPopover 与 ModelRoutePopover
// 的配置项按「分组卡片」组织——每组一张 C.nested 圆角卡（弹层根已是 C.card，组卡抬一层 bg-layer-2，
// 与仪表盘/归档卡片同族）；字号阶梯与阶段1 同族：组头 fsSub·600、配置项标签 fsSub、值·输入·注释 fsAux，
// 取代旧 10/9px 平铺。红线：只改布局与信息层级——定位（fixed + clampPopoverPos + uiZoom 补偿 + 预算宽
// 常量）、配置读写通道、开关 setCfg 乐观更新行为零改动。
test('㉝设置弹层卡片化：两弹层分组圆角卡（模型路由4卡/池配置8卡）+ 组头挂卡片 + 定位常量与开关通道零改动', () => {
  const iMr = src.indexOf('function ModelRoutePopover(props)')
  const iPc = src.indexOf('function PoolCfgPopover(props)')
  const iTv = src.indexOf('function TeamView()')
  assert.ok(iMr >= 0 && iPc > iMr && iTv > iPc, '弹层组件切片失败')
  const mrBody = src.slice(iMr, iPc)
  const pcBody = src.slice(iPc, iTv)
  // ① 组卡样式（两弹层同款局部声明）：C.nested 圆角卡 + 组头 fsSub·600
  for (const body of [mrBody, pcBody]) {
    assert.ok(body.indexOf("var cfgCard = { background: C.nested, border: '1px solid ' + C.border, borderRadius: 8, padding: '8px 10px', marginBottom: 8 }") >= 0, '弹层缺组卡样式 cfgCard（C.nested 圆角卡，弹层根 C.card 抬一层）')
    assert.ok(body.indexOf('var cfgHead = { fontSize: C.fsSub, fontWeight: 600, color: C.text2, marginBottom: 5 }') >= 0, '弹层缺组头样式 cfgHead（fsSub·600 字号阶梯）')
  }
  // ② 模型路由 4 张分组卡：板级模型 / 健康嗅探 / 力度路由 / 备用模型链（组头逐一绑定在卡内）
  assert.equal((mrBody.match(/React\.createElement\('div', \{ style: cfgCard \},/g) || []).length, 4, 'ModelRoutePopover 应 4 张分组卡（板级模型/健康嗅探/力度路由/备用模型链）')
  for (const h of ["React.createElement('div', { style: cfgHead }, '板级模型')", "React.createElement('div', { style: cfgHead }, '健康嗅探（事前调度）')", "React.createElement('div', { style: cfgHead }, '力度路由')", "React.createElement('div', { style: cfgHead }, '备用模型链')"]) {
    assert.ok(mrBody.indexOf(h) >= 0, '模型路由弹层缺组头卡片绑定：' + h)
  }
  // ③ 池配置 8 张分组卡：并发/两级超时/学习反馈/通知/验收/功能/存储清理/界面
  assert.equal((pcBody.match(/React\.createElement\('div', \{ style: cfgCard \},/g) || []).length, 8, 'PoolCfgPopover 应 8 张分组卡（并发/两级超时/学习反馈/通知/验收/功能/存储清理/界面）')
  for (const h of ["React.createElement('div', { style: cfgHead }, '学习反馈')", "React.createElement('div', { style: cfgHead }, '通知')", "React.createElement('div', { style: cfgHead }, '验收')", "React.createElement('div', { style: cfgHead }, '功能')", "React.createElement('div', { style: cfgHead }, '存储清理')", "React.createElement('div', { style: cfgHead }, '界面')"]) {
    assert.ok(pcBody.indexOf(h) >= 0, '池配置弹层缺组头卡片绑定：' + h)
  }
  assert.ok(pcBody.indexOf("'并发上限（一次性派发，用完即销毁）'") >= 0 && pcBody.indexOf("'两级超时（软超时只提醒主窗口") >= 0, '池配置弹层缺并发/两级超时组头文案')
  // ④ 定位红线：预算宽常量与 clamp 接线零改动（task-mvt05utl / task-mv58e01j 口径原样）
  assert.ok(src.indexOf('var POOL_POPOVER_W = 360') >= 0 && src.indexOf('var ROUTE_POPOVER_W = 500') >= 0, '弹层预算宽常量被改动（定位口径红线）')
  assert.match(src, /setPos\(clampPopoverPos\(r, ROUTE_POPOVER_W, z, popoverBounds\(btnRef\.current\)\)\)/, 'ModelRoutePopover clamp 接线被改动')
  assert.match(src, /setPos\(clampPopoverPos\(r, POOL_POPOVER_W, z, popoverBounds\(btnRef\.current\)\)\)/, 'PoolCfgPopover clamp 接线被改动')
  // 两弹层根定位样式逐字保留（fixed + 双锚渲染 + maxH/overflowY 滚动）
  assert.equal((src.match(/padding: '8px 10px', background: C\.card, border: '1px solid ' \+ C\.border, borderRadius: 8, boxShadow: '0 4px 16px rgba\(0,0,0,0\.15\)', zIndex: 1000, whiteSpace: 'nowrap', maxHeight: \(pos\.maxH \|\| 300\) \+ 'px', overflowY: 'auto'/g) || []).length, 2, '两弹层根定位样式须逐字保留（卡片化不得动定位）')
  // ⑤ 开关行为红线：池配置 5 个开关仍走 setCfg 乐观通道（onChange 单调用形态逐一在位）
  const knobs = [...pcBody.matchAll(/type: 'checkbox', checked: [^,]+, onChange: function \(e\) \{ setCfg\('([a-zA-Z]+)', e\.target\.checked\) \}/g)].map(m => m[1])
  assert.deepEqual(knobs.slice().sort(), ['epicSplit', 'feedbackEnabled', 'notifyDispatch', 'notifyDone', 'verifyUserGuide'], '池配置开关 setCfg 乐观通道被误伤（卡片化只改布局）')
})

test('㉞设置弹层字号阶梯：配置项标签 fsSub / 值·输入·注释 fsAux（七个配置组件全迁）+ 下架徽章既有形态不动 + 产物同步', () => {
  // ① 标签 fsSub：PoolCfg 根（gap:1）+ MinCfg/RetentionCfg/ModelCfg×2/ZoomCfg/OnboardReset 根（gap:3 共 6 处）
  //   + 弹层内开关行/主动探测 label（共 6 处）
  assert.ok(src.indexOf('gap: 1, fontSize: C.fsSub, color: C.text2') >= 0, 'PoolCfg 配置项标签未上 fsSub')
  assert.equal((src.match(/gap: 3, fontSize: C\.fsSub, color: C\.text2/g) || []).length, 6, 'MinCfg/RetentionCfg/ModelCfg/ZoomCfg/OnboardReset 标签须 6 处 fsSub')
  assert.equal((src.match(/fontSize: C\.fsSub, color: C\.text, cursor: 'pointer'/g) || []).length, 6, '开关行/主动探测 label 须 6 处 fsSub')
  // ② 值·输入·按钮 fsAux：应用/添加/清理失效按钮（7 处）+ 各输入/下拉/步进钮
  assert.equal((src.match(/fontSize: C\.fsAux, padding: '0px 5px'/g) || []).length, 7, '应用/添加/清理失效按钮须 7 处 fsAux')
  for (const m of ["width: 22, padding: '0px 2px', fontSize: C.fsAux", "width: 38, padding: '0px 3px', fontSize: C.fsAux", "width: 150, padding: '0px 4px', fontSize: C.fsAux", "width: 110, padding: '0px 4px', fontSize: C.fsAux", "width: 150, padding: '0px 2px', fontSize: C.fsAux", "var chipBtn = { fontSize: C.fsAux"]) {
    assert.ok(src.indexOf(m) >= 0, '配置值/输入未上 fsAux：' + m)
  }
  assert.ok(src.indexOf("gap: 4, fontSize: C.fsAux, color: C.text2, whiteSpace: 'normal'") >= 0, 'OrderedModelsEditor 编辑器根未上 fsAux（链芯片/下拉同族）')
  // ③ 注释 fsAux：弹层内注释 span 与口径 hint（（Worker 执行模型）等）
  assert.ok(src.indexOf("React.createElement('span', { style: { fontSize: C.fsAux, color: C.text2 } }, '（Worker 执行模型）')") >= 0, '弹层注释未上 fsAux')
  assert.ok(src.indexOf("React.createElement('div', { style: { fontSize: C.fsAux, color: C.text2, marginTop: 1, whiteSpace: 'normal', maxWidth: 360 } }, '每槽=有序模型链") >= 0, '力度路由口径 hint 未上 fsAux')
  // ④ 既有锁定形态不动：⚠️下架徽章 fontSize:8（徽章非标签/值，⑩ 断言原样）；池状态条/健康点图标 fontSize:9 不属弹层
  assert.ok(src.indexOf("fontSize: 8, lineHeight: '12px', flexShrink: 0 } }, '⚠️下架'") >= 0, '⚠️下架徽章 fontSize:8 既有形态被误改')
  // ⑤ 产物同步：client.js 已重组装（组卡样式×2 + 字号阶梯标记族）
  assert.equal((built.match(/var cfgCard = \{ background: C\.nested, border: '1px solid ' \+ C\.border, borderRadius: 8, padding: '8px 10px', marginBottom: 8 \}/g) || []).length, 2, 'client.js 缺两弹层组卡样式（需 npm run build-client）')
  assert.equal((built.match(/var cfgHead = \{ fontSize: C\.fsSub, fontWeight: 600, color: C\.text2, marginBottom: 5 \}/g) || []).length, 2, 'client.js 缺两弹层组头样式（需 npm run build-client）')
  for (const m of ['gap: 3, fontSize: C.fsSub, color: C.text2', "fontSize: C.fsSub, color: C.text, cursor: 'pointer'", "fontSize: C.fsAux, padding: '0px 5px'"]) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺字号阶梯标记：' + m + '（需 npm run build-client）')
  }
})
