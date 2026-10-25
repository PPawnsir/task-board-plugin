// ===== 力度路由 GUI + 记分卡 bySize 档位维度（task-mvneq4mw）=====
// 断言清单（对应任务验收口径）：
//   ① 池配置弹层「力度路由」小节：三档 × Worker/Verifier 共 6 个 ModelCfg 下拉，
//     写走 set-board-config key='laneModels' 部分合并，空串=「继承板级」语义
//   ② laneModels state 透传：kernel fetchTasks 回读 + TopPanel 订阅 + PoolCfgPopover props 接线
//   ②b cfgKnobs 快照类型对称（验收驳回回归修复）：快照存原值，null→null 恒 false、真变化才 true
//   ③ 记分卡 bySize 聚合（usage.mjs）：三档归桶 / 无 size 老 run 归标档 / hook 剔除 /
//     驳回归档 / 异常(超时+跑崩)/token 合计 / 范围裁剪；run.size 派发留档（dispatch.mjs）
//   ④ build-client 产物含标记（改完源必须重组装）
//   ⑤ README 双份逐字一致 + 含「力度路由」「按档位」说明
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildScoreboard } from '../index.mjs'
import { localDayKey } from '../lib/usage.mjs'
import { createDispatch } from '../lib/dispatch.mjs'

const src = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
const ksrc = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ===== ① GUI 源码断言：6 个下拉 + 继承语义 + laneModels 部分合并写通道 =====
test('①力度路由小节：三档×双角色 6 个 ModelCfg 下拉 + 空=继承板级 + laneModels 部分合并写通道', () => {
  // 小节标题在模型行之后
  assert.ok(src.indexOf("'力度路由'") >= 0, '缺「力度路由」小节标题')
  const iVer = src.indexOf("cfgKey: 'verifierModel'")
  const iLane = src.indexOf("'力度路由'")
  const iTimeout = src.indexOf('两级超时（软超时只提醒主窗口')
  assert.ok(iVer >= 0 && iLane > iVer && iTimeout > iLane, '力度路由小节必须在模型行之后、两级超时之前')
  // 6 个下拉：三档表 × 双角色 map 展开（3 档 × worker/verifier = 6 实例，源码层为一张三档表 + 双角色两行）
  assert.match(src, /\[\['light', '轻档'\], \['standard', '标档'\], \['heavy', '重档'\]\]\.map\(function \(ln\)/)
  assert.match(src, /React\.createElement\(ModelCfg, \{ label: ln\[1\] \+ ' Worker', lane: ln\[0\], laneRole: 'worker', inheritLabel: '继承板级', value: laneObj\.worker \|\| '' \}\)/)
  assert.match(src, /React\.createElement\(ModelCfg, \{ label: ln\[1\] \+ ' Verifier', lane: ln\[0\], laneRole: 'verifier', inheritLabel: '继承板级', value: laneObj\.verifier \|\| '' \}\)/)
  // 继承语义：空选项文案「继承板级」（继承上方 Worker/Verifier 模型行）
  assert.equal((src.match(/inheritLabel: '继承板级'/g) || []).length, 2, 'map 内 worker/verifier 两槽位空选项均为「继承板级」')
  assert.ok(src.indexOf('空 = 继承上方 Worker/Verifier 模型行') >= 0, '缺「空=继承板级模型行」注一句')
  // 写通道：ModelCfg lane 分支走 set-board-config key='laneModels' 部分合并对象
  assert.match(src, /patch\[lane\] = \{\}; patch\[lane\]\[laneRole\] = \(val \|\| ''\)\.trim\(\)/)
  assert.match(src, /rpc\('set-board-config', \{ key: 'laneModels', value: patch \}\)/)
  // 读侧：下拉值取 props.laneModels[档][角色]
  assert.match(src, /\(props\.laneModels && props\.laneModels\[ln\[0\]\]\) \|\| \{\}/)
  // 两段式语义保持（选中≠保存，点 ✓ 才提交）——ModelCfg 既有契约不走即点即写
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
function mkDispatch(board, ctxOver) {
  return createDispatch(
    Object.assign({ fs: {}, effect: function () {}, get: function () { return null } }, ctxOver || {}),
    { knownSessions: {}, dispatchedEver: {}, badModels: {}, teamModeCache: {}, activeRuns: {} },
    {
      rt: async function () { return board }, wt: async function () {},
      mutateLocked: async function (sid, fn) { return fn(board) },
      kickCycle: function () {}, rootForSession: function () { return { id: SID } },
      sessionCwd: function () { return '' }, withTimeout: function (p) { return p }, runsFor: function () { return ({}) },
      feedbackOn: function () { return true }, pushSysNote: function () {}, maybeNotify: function () {}, notifyTaskDone: function () {},
    })
}
function mkActivationSubagents(calls) {
  return {
    list: function () { return ['p1'] },
    getProvider: function () { return { inheritsParentContext: false } },
    startActivation: async function (spec) {
      calls.push(spec)
      return { childId: 'child-' + calls.length, messageId: 'msg-' + calls.length, result: new Promise(function () {}), dispose: async function () {} }
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
