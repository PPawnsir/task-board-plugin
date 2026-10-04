// dsh-agent-board 纯逻辑单元测试 — node --test packages/dsh-agent-board/test/
// 覆盖：状态机流转 / 依赖校验与环检测 / 管线分类 / 输出解析 / prompt 构建 / 派发决策 / 孤儿回收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import * as core from '../lib/core.mjs'
// 粒度治理（软闸门）住在 lib/policy.mjs（策略层，纯函数）、usage 聚合住在 lib/usage.mjs，
// 均由 index.mjs 薄壳 re-export（对外契约不变），这里仍从 index.mjs 导入直接断言
import { suggestSplitOf, withSplitHint, SUGGEST_SPLIT_TEXT, TASK_SIZE_CONTRACT, TEAM_SPLIT_RULE } from '../index.mjs'
import { aggregateUsageSummary, readRunUsage, findRunLog } from '../index.mjs'
import { createRpc } from '../lib/rpc.mjs'
// host 端源码拼接（Phase 2 模块化后：薄壳 index.mjs + lib/*.mjs 领域模块），供源码级接线断言
const HOST_SOURCES = ['../index.mjs', '../lib/policy.mjs', '../lib/usage.mjs', '../lib/session.mjs', '../lib/store.mjs', '../lib/notify.mjs', '../lib/dispatch.mjs', '../lib/rpc.mjs']
function hostSrc() { return HOST_SOURCES.map(function (f) { return readFileSync(new URL(f, import.meta.url), 'utf8') }).join('\n') }

function mkTask(over) { return Object.assign({ id: 't1', title: 'T', description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null, history: [], messages: [] }, over || {}) }
function mkBoard(tasks) { return { version: 11, ownerSession: 's1', boardMode: 'auto', tasks: tasks || [] } }

// ===== 状态机 =====
test('claimApply: pending → in-progress，记 history', () => {
  const t = mkTask(); const d = mkBoard([t])
  core.claimApply(d, t, 'actor1', 'test')
  assert.equal(t.status, 'in-progress'); assert.equal(t.claimedBy, 'actor1')
  assert.equal(t.history.length, 1); assert.equal(t.history[0].to, 'in-progress')
})

test('claimCheck: 非可认领状态拒绝', () => {
  const t = mkTask({ status: 'verifying' }); const d = mkBoard([t])
  assert.match(core.claimCheck(d, t, 'a'), /cannot claim/)
})

test('claimCheck: 已被他人认领拒绝（in-progress 首先被 CLAIMABLE 拦住）', () => {
  const t = mkTask({ status: 'in-progress', claimedBy: 'other' }); const d = mkBoard([t])
  assert.match(core.claimCheck(d, t, 'a'), /cannot claim/) // CLAIMABLE 只含 pending/blocked，in-progress 先被拦
  // claimedBy 分支的实际生效场景：blocked 状态被他人认领后重派
  const t2 = mkTask({ status: 'blocked', claimedBy: 'other' }); const d2 = mkBoard([t2])
  assert.equal(core.claimCheck(d2, t2, 'a'), null) // blocked 可重派（claimedBy 分支只在 in-progress 才有意义）
})

test('claimCheck: 手动模式+指定 assignee 拒绝他人', () => {
  const t = mkTask({ assignMode: 'manual', assignee: 'bob' }); const d = mkBoard([t])
  assert.match(core.claimCheck(d, t, 'alice'), /assigned to bob/)
  assert.equal(core.claimCheck(d, t, 'bob'), null)
})

test('claimCheck: 超过 MAX_CLAIMED 拒绝', () => {
  const mine = [1, 2, 3].map(i => mkTask({ id: 'm' + i, status: 'in-progress', claimedBy: 'me' }))
  const t = mkTask({ id: 'new' }); const d = mkBoard(mine.concat([t]))
  assert.match(core.claimCheck(d, t, 'me'), /max 3 active/)
})

test('resolveApply: full 档 → verifying；work/direct 档 → 直接 resolved', () => {
  const tf = mkTask({ pipeline: 'full' }); core.resolveApply(mkBoard([tf]), tf, 'w', 'verifying', 'done')
  assert.equal(tf.status, 'verifying')
  const tw = mkTask({ pipeline: 'work' }); core.resolveApply(mkBoard([tw]), tw, 'w', 'verifying', 'done')
  assert.equal(tw.status, 'resolved')
})

test('verifyApply: approved → resolved；rejected → 回 in-progress', () => {
  const t = mkTask({ status: 'verifying' }); core.verifyApply(mkBoard([t]), t, 'v', 'approved', 'ok')
  assert.equal(t.status, 'resolved'); assert.ok(t.verifiedAt)
  const t2 = mkTask({ status: 'verifying' }); core.verifyApply(mkBoard([t2]), t2, 'v', 'rejected', 'bad')
  assert.equal(t2.status, 'in-progress'); assert.equal(t2.resolution, null)
})

test('子任务全 resolved → 父任务自动 verifying', () => {
  const p = mkTask({ id: 'p', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'p', status: 'verifying' })
  const c2 = mkTask({ id: 'c2', parentId: 'p', status: 'resolved' })
  const d = mkBoard([p, c1, c2])
  const r = core.verifyApply(d, c1, 'v', 'approved')
  assert.equal(r.parentUpdated, true); assert.equal(p.status, 'verifying')
})

// ===== 依赖 =====
test('validateDeps: 自引用/不存在/成环 全拒绝', () => {
  const a = mkTask({ id: 'a' }); const b = mkTask({ id: 'b', dependsOn: ['a'] })
  const d = mkBoard([a, b])
  assert.match(core.validateDeps(d, 'a', ['a']), /self-dependency/)
  assert.match(core.validateDeps(d, 'a', ['ghost']), /not found/)
  // a 依赖 b，b 已依赖 a → 成环
  const d2 = mkBoard([mkTask({ id: 'a', dependsOn: ['b'] }), mkTask({ id: 'b', dependsOn: ['a'] })])
  assert.match(core.validateDeps(d2, 'a', ['b']), /circular/)
})

test('depsSatisfied: resolved/archived 算满足，其余不算', () => {
  const dep = mkTask({ id: 'dep', status: 'resolved' })
  const t = mkTask({ dependsOn: ['dep'] }); const d = mkBoard([dep, t])
  assert.equal(core.depsSatisfied(d, t), true)
  dep.status = 'in-progress'
  assert.equal(core.depsSatisfied(d, t), false)
  dep.status = 'archived'
  assert.equal(core.depsSatisfied(d, t), true)
})

test('depsCancelled: 依赖被取消 → true', () => {
  const dep = mkTask({ id: 'dep', status: 'cancelled' })
  const t = mkTask({ dependsOn: ['dep'] })
  assert.equal(core.depsCancelled(mkBoard([dep, t]), t), true)
})

// ===== 管线分类 =====
test('classifyPipeline: 验收脚本→full；问答→direct；文档→work；兜底 full', () => {
  assert.equal(core.classifyPipeline(mkTask({ acceptance: 'npm test' })), 'full')
  assert.equal(core.classifyPipeline(mkTask({ title: '解释一下这个函数' })), 'direct')
  assert.equal(core.classifyPipeline(mkTask({ title: '整理 API 文档' })), 'work')
  assert.equal(core.classifyPipeline(mkTask({ title: '实现登录功能' })), 'full')
})

// ===== 输出解析 =====
test('parseSections: 分段解析', () => {
  const out = core.parseSections('前言\n## 开发描述\n做了 A\n## 改动清单\n改了 x.js\n## 自测情况\nnpm test pass')
  assert.equal(out.summary, '做了 A'); assert.equal(out.changes, '改了 x.js'); assert.equal(out.selfTest, 'npm test pass')
  assert.deepEqual(core.parseSections(''), {})
  assert.deepEqual(core.parseSections('没有分段的纯文本'), {})
})

test('cfg: 两级超时默认值/夹取/hard≥soft（软超时只提醒，硬超时兜底）', () => {
  assert.equal(core.cfg({}).softTimeoutMin, 30)
  assert.equal(core.cfg({}).hardTimeoutMin, 120)
  assert.equal(core.cfg({ softTimeoutMin: 45, hardTimeoutMin: 240 }).softTimeoutMin, 45)
  assert.equal(core.cfg({ softTimeoutMin: 0 }).softTimeoutMin, 30) // 0 → 默认
  assert.equal(core.cfg({ softTimeoutMin: 9999 }).softTimeoutMin, 480) // 上限夹取
  assert.equal(core.cfg({ hardTimeoutMin: 99999 }).hardTimeoutMin, 1440)
  // hard 不得低于 soft，避免硬超时早于软提醒触发
  assert.equal(core.cfg({ softTimeoutMin: 300, hardTimeoutMin: 60 }).hardTimeoutMin, 300)
})

test('seed: 新看板自带两级超时默认值', () => {
  const s = core.seed('session-x')
  assert.equal(s.softTimeoutMin, 30)
  assert.equal(s.hardTimeoutMin, 120)
})

test('parseSections: diff 概要分段解析（Worker 变更概要 → deliverable.diff）', () => {
  const s = core.parseSections('## 开发描述\n做了\n## diff 概要\n gen.py | 3 + ++')
  assert.equal(s.diff, 'gen.py | 3 + ++')
  assert.equal(s.summary, '做了')
})

test('parseVerdict: 行首锚定，历史提及不误判', () => {
  assert.equal(core.parseVerdict('APPROVED: 通过'), 'APPROVED')
  assert.equal(core.parseVerdict('REJECTED: 不达标'), 'REJECTED')
  assert.equal(core.parseVerdict('> APPROVED\n引用块里的也算'), 'APPROVED') // 引用块前缀允许
  assert.equal(core.parseVerdict('上次被 REJECTED 了，这次我觉得行'), null) // 非行首锚定 → 不误判
  assert.equal(core.parseVerdict(''), null)
})

test('isEscalation: [ESCALATE] 标记', () => {
  assert.equal(core.isEscalation('[ESCALATE] 缺少需求'), true)
  assert.equal(core.isEscalation('正常完成'), false)
})

test('outputText: ContentBlock[] 提取文本', () => {
  assert.equal(core.outputText({ output: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(core.outputText(null), '')
  assert.equal(core.outputText({}), '')
})

// ===== prompt 构建 =====
test('buildWorkerPrompt: 注入 taskId/描述/验收脚本/过程记录', () => {
  const t = mkTask({ id: 'tx', description: '做个功能', acceptance: 'npm test', history: [{ note: '驳回: 缺测试', timestamp: '2026-01-01' }] })
  const p = core.buildWorkerPrompt(t)
  assert.match(p, /taskId: tx/); assert.match(p, /做个功能/); assert.match(p, /npm test/); assert.match(p, /驳回: 缺测试/); assert.match(p, /board_report/)
})

test('buildWorkerPrompt: 不自动注入 context.files/docs（由主窗口写入 description）', () => {
  const t = mkTask({ id: 'ctx', context: { instructions: '看 README', files: ['src/x.js'], docs: ['设计文档'], relatedTasks: ['task-a'], prerequisites: 'Node 22+' } })
  const p = core.buildWorkerPrompt(t)
  assert.match(p, /看 README/)          // instructions 注入（主窗口写的指引）
  assert.doesNotMatch(p, /src\/x\.js/)  // files 不自动注入
  assert.doesNotMatch(p, /设计文档/)    // docs 不自动注入
  assert.doesNotMatch(p, /task-a/)      // relatedTasks 不自动注入
  assert.doesNotMatch(p, /Node 22/)     // prerequisites 不自动注入
})

test('buildWorkerPrompt: 注入 messages（裁决答案/干预指令/歧义原文——系统管理的生命周期记录）', () => {
  const t = mkTask({ id: 'msg', messages: [{ kind: 'arbitration', text: '用方案B', at: '2026-01-01', by: 'main' }, { kind: 'intervention', text: '注意边界', at: '2026-01-02', by: 'main' }] })
  const p = core.buildWorkerPrompt(t)
  assert.match(p, /用方案B/); assert.match(p, /注意边界/); assert.match(p, /arbitration/); assert.match(p, /intervention/)
})

test('buildVerifierPrompt: 注入交付物 + 验收脚本 + messages', () => {
  const t = mkTask({ id: 'tx', acceptance: 'npm test', deliverable: { summary: '做完了', changes: 'x.js', selfTest: 'pass' }, messages: [{ kind: 'arbitration', text: '方案B', at: '2026-01-01', by: 'main' }] })
  const p = core.buildVerifierPrompt(t)
  assert.match(p, /做完了/); assert.match(p, /npm test/); assert.match(p, /board_verdict/); assert.match(p, /方案B/)
})

// ===== 预研文件段（主窗口选择性注入，host 读盘后传入）=====
test('buildContextPackSection: 空清单返回空串', () => {
  assert.equal(core.buildContextPackSection([]), '')
  assert.equal(core.buildContextPackSection(null), '')
  assert.equal(core.buildContextPackSection(undefined), '')
})

test('buildContextPackSection: 文件内容 + 截断标记', () => {
  const s = core.buildContextPackSection([
    { path: 'src/a.ts', content: 'const x = 1', truncated: false },
    { path: 'docs/b.md', content: '说明', truncated: true },
  ])
  assert.match(s, /主窗口预研文件/); assert.match(s, /不要重复读取/)
  assert.match(s, /### src\/a\.ts/); assert.match(s, /const x = 1/)
  assert.match(s, /### docs\/b\.md（截断）/); assert.match(s, /说明/)
})

test('buildWorkerPrompt/buildVerifierPrompt: 注入预研文件段', () => {
  const pack = core.buildContextPackSection([{ path: 'src/x.js', content: 'hello', truncated: false }])
  const t = mkTask({ id: 'pk' })
  assert.match(core.buildWorkerPrompt(t, pack), /### src\/x\.js/)
  assert.match(core.buildWorkerPrompt(t, pack), /hello/)
  assert.match(core.buildVerifierPrompt(t, pack), /### src\/x\.js/)
  // 不传 pack 时不出现该段
  assert.doesNotMatch(core.buildWorkerPrompt(t), /主窗口预研文件/)
})

test('buildContextPackSection: {{ }} 插值净化（context 通道严格插值会抛异常）', () => {
  const s = core.buildContextPackSection([{ path: 'src/tpl.vue', content: '<div>{{ msg }}</div>', truncated: false }])
  assert.doesNotMatch(s, /\{\{/)          // 不允许残留插值触发器
  assert.match(s, /\{ \{ msg \}\}/)        // 内容可读性保留
})

test('buildContextPackSection: 三连花括号（Python f-string）封闭净化', () => {
  // 真实事故：f"{{{lo}}}" 经 replace(/\{\{/g,'{ {') 变成 "{ {{lo}}}"——替换结果自己又造出 {{
  const s = core.buildContextPackSection([{ path: 'gen.py', content: 'quant = f"{{{lo}}}" + f"{{{lo},{hi}}}"', truncated: false }])
  assert.doesNotMatch(s, /\{\{/)           // 净化必须是封闭变换
  assert.match(s, /\{ \{ \{lo\}\}\}/)      // 可读性保留
  // 五连括号 + 单括号混合
  const s2 = core.buildContextPackSection([{ path: 'x', content: 'a{{{{{b}}}}}{c}{{d}}', truncated: false }])
  assert.doesNotMatch(s2, /\{\{/)
})

test('buildContextPackSection: 笔记（思路/原始需求）注入 + 净化', () => {
  const s = core.buildContextPackSection([{ path: 'a.js', content: 'x', truncated: false }], '用户原话：要做成{{可配置}}的')
  assert.match(s, /主窗口调研笔记/)
  assert.match(s, /用户原话：要做成\{ \{可配置\}\}的/)  // 笔记里的 {{}} 也被净化
  assert.match(s, /### a\.js/)                          // 文件段同时存在
})

test('buildContextPackSection: 仅笔记无文件也可注入', () => {
  const s = core.buildContextPackSection([], '思路：先改 A 再改 B')
  assert.match(s, /主窗口调研笔记/); assert.match(s, /先改 A 再改 B/)
  assert.doesNotMatch(s, /预研文件/)
  assert.equal(core.buildContextPackSection([], ''), '')
  assert.equal(core.buildContextPackSection(null, '  '), '')
})

test('buildContextPackSection: meta 截断详情 + 结构索引块渲染（①②④）', () => {
  const s = core.buildContextPackSection([
    { path: 'src/big.js', content: 'function a() {}', truncated: true, meta: '截断：共 3800 行，已注入 1–96 行', outline: ['L12: export function foo(a, b)', 'L88: class Bar'] },
  ])
  assert.match(s, /### src\/big\.js（截断：共 3800 行，已注入 1–96 行）/)
  assert.match(s, /结构索引/); assert.match(s, /L12: export function foo\(a, b\)/); assert.match(s, /L88: class Bar/)
})

test('buildContextPackSection: 锚点行段 meta 渲染', () => {
  const s = core.buildContextPackSection([
    { path: 'src/big.js:L2350-L2420', content: 'x', truncated: false, meta: '锚点行段：共 3800 行，已注入 L2350–L2420' },
  ])
  assert.match(s, /### src\/big\.js:L2350-L2420（锚点行段：共 3800 行，已注入 L2350–L2420）/)
  assert.doesNotMatch(s, /结构索引/)
})

// ===== 锚点行段解析（②，零依赖纯正则，Windows 盘符冒号不得误判）=====
test('parseAnchorPath: 无锚点原样返回', () => {
  assert.deepEqual(core.parseAnchorPath('src/a.js'), { file: 'src/a.js', from: null, to: null })
  assert.deepEqual(core.parseAnchorPath(''), { file: '', from: null, to: null })
  // 盘符无锚点：冒号在最前，不触发
  assert.deepEqual(core.parseAnchorPath('C:\\Users\\x\\a.js'), { file: 'C:\\Users\\x\\a.js', from: null, to: null })
})

test('parseAnchorPath: 单行与行段锚点', () => {
  assert.deepEqual(core.parseAnchorPath('src/a.js:L2350'), { file: 'src/a.js', from: 2350, to: null })
  assert.deepEqual(core.parseAnchorPath('src/a.js:L2350-L2420'), { file: 'src/a.js', from: 2350, to: 2420 })
  // 第二段 L 可省略
  assert.deepEqual(core.parseAnchorPath('src/a.js:L10-20'), { file: 'src/a.js', from: 10, to: 20 })
})

test('parseAnchorPath: Windows 盘符 + 锚点共存', () => {
  assert.deepEqual(core.parseAnchorPath('C:\\Users\\x\\a.js:L100-L200'), { file: 'C:\\Users\\x\\a.js', from: 100, to: 200 })
  assert.deepEqual(core.parseAnchorPath('D:/deepseek-work/b.mjs:L5'), { file: 'D:/deepseek-work/b.mjs', from: 5, to: null })
})

test('parseAnchorPath: 非法锚点剥掉并标记 invalidAnchor（调用方回退头部）', () => {
  var r1 = core.parseAnchorPath('a.js:L0')
  assert.equal(r1.file, 'a.js'); assert.equal(r1.from, null); assert.equal(r1.invalidAnchor, true)
  var r2 = core.parseAnchorPath('a.js:L5-L2')  // to < from
  assert.equal(r2.from, null); assert.equal(r2.invalidAnchor, true)
  // 完全不成形的尾巴（:Lab）不匹配锚点正则 → 按无锚点处理，路径原样保留
  var r3 = core.parseAnchorPath('a.js:Lab')
  assert.equal(r3.file, 'a.js:Lab'); assert.equal(r3.from, null); assert.equal(r3.invalidAnchor, undefined)
})

// ===== 按行切段（②，行号 1 起、from/to 皆含）=====
test('sliceLines: 正常切段', () => {
  var c = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
  var s = core.sliceLines(c, 2, 4)
  assert.equal(s.text, 'l2\nl3\nl4')
  assert.equal(s.totalLines, 5); assert.equal(s.injectedFrom, 2); assert.equal(s.injectedTo, 4)
  assert.equal(s.capped, false); assert.equal(s.invalid, false)
  // to 省略 → 到文末
  var s2 = core.sliceLines(c, 4, null)
  assert.equal(s2.text, 'l4\nl5'); assert.equal(s2.injectedTo, 5)
  // from 为 null → 全量（头部注入口径）
  var s3 = core.sliceLines(c, null)
  assert.equal(s3.text, c); assert.equal(s3.injectedFrom, 1); assert.equal(s3.injectedTo, 5)
})

test('sliceLines: 超界无效 / to 超尾收敛', () => {
  var c = ['l1', 'l2', 'l3'].join('\n')
  var bad = core.sliceLines(c, 99, null)
  assert.equal(bad.invalid, true); assert.equal(bad.text, ''); assert.equal(bad.totalLines, 3)
  assert.equal(core.sliceLines(c, 0, 2).invalid, true)   // from < 1
  assert.equal(core.sliceLines(c, 3, 2).invalid, true)   // to < from
  // to 写超了 → 收敛到文末，不算无效
  var ok = core.sliceLines(c, 2, 9999)
  assert.equal(ok.invalid, false); assert.equal(ok.injectedTo, 3); assert.equal(ok.text, 'l2\nl3')
})

test('sliceLines: 400 行段长上限', () => {
  var lines = []
  for (var i = 1; i <= 1000; i++) lines.push('row' + i)
  var s = core.sliceLines(lines.join('\n'), 1, null)
  assert.equal(s.capped, true); assert.equal(s.injectedFrom, 1); assert.equal(s.injectedTo, 400)
  assert.equal(s.text.split('\n').length, 400); assert.equal(s.totalLines, 1000)
  // 段内不超上限不标记
  var s2 = core.sliceLines(lines.join('\n'), 500, 600)
  assert.equal(s2.capped, false); assert.equal(s2.injectedTo, 600)
})

// ===== 结构索引（①④，逐行正则，宁可漏检不可误切）=====
test('buildFileOutline: JS 函数/类/箭头赋值', () => {
  var c = [
    'import os from "node:os"',
    'export function foo(a, b) {',
    '  return a + b',
    '}',
    'class Bar {',
    '}',
    'baz = async function () {}',
    'qux = async (x) => x',
    'const plain = 42',
    // 规格正则不含 var/let/const 前缀赋值形态——宁可漏检不可误切（var baz = ... 不入索引）
    'var prefixed = function () {}',
  ].join('\n')
  var o = core.buildFileOutline(c)
  assert.deepEqual(o, ['L2: export function foo(a, b) {', 'L5: class Bar {', 'L7: baz = async function () {}', 'L8: qux = async (x) => x'])
})

test('buildFileOutline: Markdown 标题 + 签名超 80 字符截断', () => {
  var longSig = 'function ' + 'a'.repeat(100) + '() {'
  var c = ['# 标题', '正文', '## 小节', '####### 七级不算标题', longSig].join('\n')
  var o = core.buildFileOutline(c)
  assert.equal(o[0], 'L1: # 标题'); assert.equal(o[1], 'L3: ## 小节')
  assert.equal(o.length, 3)  // 七级 # 不匹配；长签名收进来但截断
  assert.ok(o[2].startsWith('L5: function ')); assert.equal(o[2].length, 'L5: '.length + 81); assert.ok(o[2].endsWith('…'))
})

test('buildFileOutline: 40 条上限 + 省略标注', () => {
  var lines = []
  for (var i = 1; i <= 50; i++) lines.push('function f' + i + '() {}')
  var o = core.buildFileOutline(lines.join('\n'))
  assert.equal(o.length, 41)  // 40 条 + 1 条省略标注
  assert.equal(o[0], 'L1: function f1() {}')
  assert.equal(o[39], 'L40: function f40() {}')
  assert.match(o[40], /另有 10 条结构省略/)
  // 不超上限无省略标注
  var o2 = core.buildFileOutline(['function only() {}'].join('\n'))
  assert.deepEqual(o2, ['L1: function only() {}'])
})

// ===== 派发决策 =====
test('pickDispatch: 优先级排序 + 并发上限 + 排除项', () => {
  const tasks = [
    mkTask({ id: 'lo', priority: 'low', createdAt: '2026-01-02' }),
    mkTask({ id: 'hi', priority: 'critical', createdAt: '2026-01-03' }),
    mkTask({ id: 'claimed', claimedBy: 'someone' }),
    mkTask({ id: 'manual', assignMode: 'manual' }),
    mkTask({ id: 'direct', pipeline: 'direct' }),
    mkTask({ id: 'esc', escalation: { question: 'q' } }),
  ]
  const d = mkBoard(tasks)
  const r = core.pickDispatch(d, 3, 0, null)
  assert.deepEqual(r.pendings.map(t => t.id), ['hi', 'lo']) // critical 优先，claimed/manual/direct/escalation 全排除
  assert.equal(r.verifs.length, 0) // capV=0
  const r2 = core.pickDispatch(d, 1, 0, null)
  assert.equal(r2.pendings.length, 1) // cap 生效
})

test('pickDispatch: 依赖未满足不派发', () => {
  const dep = mkTask({ id: 'dep', status: 'in-progress' })
  const t = mkTask({ id: 'w8', dependsOn: ['dep'] })
  const r = core.pickDispatch(mkBoard([dep, t]), 5, 0, null)
  assert.equal(r.pendings.length, 0)
  dep.status = 'resolved'
  const r2 = core.pickDispatch(mkBoard([dep, t]), 5, 0, null)
  assert.equal(r2.pendings.length, 1)
})

test('pickDispatch: verifying 只派 full 档，排除 escalation 和忙中', () => {
  const tasks = [
    mkTask({ id: 'vf', status: 'verifying', pipeline: 'full' }),
    mkTask({ id: 'vw', status: 'verifying', pipeline: 'work' }),
    mkTask({ id: 've', status: 'verifying', pipeline: 'full', escalation: { question: 'q' } }),
    mkTask({ id: 'vb', status: 'verifying', pipeline: 'full' }),
  ]
  const r = core.pickDispatch(mkBoard(tasks), 0, 5, { vb: true })
  assert.deepEqual(r.verifs.map(t => t.id), ['vf']) // work 档不派审、escalation 不派、忙中不派
})

test('pickDispatch: verifying spawn-pending 占位不重复派发（防双 Verifier）', () => {
  const tasks = [
    mkTask({ id: 'vp', status: 'verifying', pipeline: 'full', verifierRun: 'spawn-pending' }),
    mkTask({ id: 'vd', status: 'verifying', pipeline: 'full', verifierRun: '12345' }), // 有真实 run id 但 run 已死（崩溃恢复场景）→ 应重派
    mkTask({ id: 'vn', status: 'verifying', pipeline: 'full' }), // 从未派发 → 应派
  ]
  const r = core.pickDispatch(mkBoard(tasks), 0, 5, null)
  assert.deepEqual(r.verifs.map(t => t.id), ['vd', 'vn'])
  // 占位 + 忙中双重排除
  const r2 = core.pickDispatch(mkBoard(tasks), 0, 5, { vd: true })
  assert.deepEqual(r2.verifs.map(t => t.id), ['vn'])
})

test('pickDispatch: frozen（裁决挂起冻结）不参与任何自动派发', () => {
  const tasks = [
    mkTask({ id: 'fz', frozen: true }), // pending 冻结 → 不派 Worker
    mkTask({ id: 'nz' }), // 普通 pending → 应派
    mkTask({ id: 'fv', status: 'verifying', pipeline: 'full', frozen: true }), // verifying 冻结 → 不派 Verifier
    mkTask({ id: 'nv', status: 'verifying', pipeline: 'full' }), // 普通 verifying → 应派
  ]
  const r = core.pickDispatch(mkBoard(tasks), 5, 5, null)
  assert.deepEqual(r.pendings.map(t => t.id), ['nz'])
  assert.deepEqual(r.verifs.map(t => t.id), ['nv'])
  // 解冻（unfreeze-task 清 frozen）后立即恢复可派发
  delete tasks[0].frozen; delete tasks[2].frozen
  const r2 = core.pickDispatch(mkBoard(tasks), 5, 5, null)
  assert.deepEqual(r2.pendings.map(t => t.id).sort(), ['fz', 'nz'])
  assert.deepEqual(r2.verifs.map(t => t.id).sort(), ['fv', 'nv'])
})

// ===== touches 文件级排他：glob 最小匹配器 =====
test('patOverlap: 完全相同路径冲突 + 归一化（\\ → /、去 ./ 前缀与尾 /）', () => {
  assert.equal(core.patOverlap('src/a.js', 'src/a.js'), true)
  assert.equal(core.patOverlap('src\\a.js', 'src/a.js'), true)   // 反斜杠归一化
  assert.equal(core.patOverlap('./src/a.js', 'src/a.js'), true) // ./ 前缀
  assert.equal(core.patOverlap('src/', 'src'), true)            // 尾 / 归一化
  assert.equal(core.patOverlap('src/a.js', 'src/b.js'), false)
  // 空/非字符串不冲突（脏声明不该误拦一切）
  assert.equal(core.patOverlap('', 'src/a.js'), false)
  assert.equal(core.patOverlap(null, 'src/a.js'), false)
  assert.equal(core.patOverlap(undefined, 'a.js'), false)
})

test('patOverlap: dir/** 目录覆盖（含两侧都 /** 时前缀互相包含）', () => {
  assert.equal(core.patOverlap('src/**', 'src/a.js'), true)
  assert.equal(core.patOverlap('src/a.js', 'src/**'), true)          // 对称
  assert.equal(core.patOverlap('src/**', 'src/deep/nested/b.js'), true)
  assert.equal(core.patOverlap('src/**', 'src2/a.js'), false)        // 前缀必须带 /
  assert.equal(core.patOverlap('src/**', 'lib/a.js'), false)
  assert.equal(core.patOverlap('src/**', 'src2/**'), false)
  assert.equal(core.patOverlap('src/**', 'src/**'), true)
  assert.equal(core.patOverlap('src/sub/**', 'src/**'), true)        // 前缀互相包含
  assert.equal(core.patOverlap('**/*.js', 'src/a.js'), false)        // '*.js' 只按扩展名后缀匹配，不展开目录通配
  assert.equal(core.patOverlap('**/*.js', 'src/a.ts'), false)
  assert.equal(core.patOverlap('**/lib/**', '**/lib/core.mjs'), true) // 复合 glob 的 dir 段（一侧是另一侧前缀）
})

test('patOverlap: *.ext 后缀（两侧 *.ext 比扩展名；*.ext vs 具体文件看 endsWith）', () => {
  assert.equal(core.patOverlap('*.js', 'src/a.js'), true)
  assert.equal(core.patOverlap('src/a.js', '*.js'), true)
  assert.equal(core.patOverlap('*.js', 'a.js'), true)
  assert.equal(core.patOverlap('*.js', '*.js'), true)
  assert.equal(core.patOverlap('*.js', '*.ts'), false)
  assert.equal(core.patOverlap('*.js', 'src/a.ts'), false)  // 扩展名不同 → 不冲突
  assert.equal(core.patOverlap('*.jsx', 'src/a.js'), false) // 后缀比对是整段（'a.js' 不以 '.jsx' 结尾）
})

test('patOverlap: 裸文件名（无 /）只与另一侧 basename 相等才算冲突', () => {
  assert.equal(core.patOverlap('index.mjs', 'index.mjs'), true)
  assert.equal(core.patOverlap('a/core.mjs', 'core.mjs'), false) // 具体路径不参与裸名规则
  assert.equal(core.patOverlap('core.mjs', 'a/core.mjs'), false)
  assert.equal(core.patOverlap('src/a.js', 'lib/a.js'), false)   // 同 basename 不同目录
  assert.equal(core.patOverlap('src/a.js', 'src/lib'), false)    // 含 / 时只比目录包含（'src/a.js' 不在 'src/lib/' 下）
})

test('touchesConflict: 与锁持有者逐条比对，返回冲突持有者 id', () => {
  const holds = [
    { id: 'h1', touches: ['src/**'] },
    { id: 'h2', touches: ['docs/x.md'] },
  ]
  assert.deepEqual(core.touchesConflict({ id: 'w1', touches: ['src/a.js'] }, holds), ['h1'])
  assert.deepEqual(core.touchesConflict({ id: 'w2', touches: ['lib/a.js'] }, holds), [])
  assert.deepEqual(core.touchesConflict({ id: 'w3', touches: ['docs/x.md', 'src/b.js'] }, holds), ['h1', 'h2'])
  assert.deepEqual(core.touchesConflict({ id: 'w4' }, holds), [])          // 没声明 touches = 不参与排他
  assert.deepEqual(core.touchesConflict({ id: 'h1', touches: ['src/a.js'] }, holds), []) // 不和自己冲突
})

test('holdsFiles: 仅 in-progress + claimedBy + 有 touches 持有文件锁', () => {
  const tasks = [
    mkTask({ id: 'live', status: 'in-progress', claimedBy: 'run-1', touches: ['src/**'] }),
    mkTask({ id: 'notouch', status: 'in-progress', claimedBy: 'run-2' }),
    mkTask({ id: 'noclaim', status: 'in-progress' }),
    mkTask({ id: 'pending', status: 'pending', touches: ['src/a.js'] }),
    mkTask({ id: 'verifying', status: 'verifying', touches: ['src/b.js'] }),
    mkTask({ id: 'empty', status: 'in-progress', claimedBy: 'run-3', touches: [] }),
  ]
  const holds = core.holdsFiles(mkBoard(tasks))
  assert.deepEqual(holds.map(h => h.id), ['live'])
  assert.deepEqual(holds[0].touches, ['src/**'])
  assert.deepEqual(core.holdsFiles(null), [])
})

// ===== 派发决策（touches 拦截）=====
test('pickDispatch: touches 与活动任务冲突 → 不进 pendings，记入 blockedTouches', () => {
  const tasks = [
    mkTask({ id: 'holder', status: 'in-progress', claimedBy: 'run-1', touches: ['src/**'] }),
    mkTask({ id: 'clash', touches: ['src/a.js'], createdAt: '2026-01-01' }),
    mkTask({ id: 'free', touches: ['lib/a.js'], createdAt: '2026-01-02' }),
    mkTask({ id: 'untouched', createdAt: '2026-01-03' }), // 没声明 touches → 不被拦
  ]
  const r = core.pickDispatch(mkBoard(tasks), 5, 0, null)
  assert.deepEqual(r.pendings.map(t => t.id).sort(), ['free', 'untouched'])
  assert.deepEqual(r.blockedTouches, [{ id: 'clash', conflicts: ['holder'] }])
})

test('pickDispatch: verifying 不持有文件锁（Worker 已停笔），verifier 派发（verifs）不受 touches 影响', () => {
  const tasks = [
    // verifying 的任务即使声明了 touches 也不持有锁
    mkTask({ id: 'vt', status: 'verifying', pipeline: 'full', claimedBy: 'run-1', touches: ['src/**'] }),
    mkTask({ id: 'w1', touches: ['src/a.js'] }),
  ]
  const r = core.pickDispatch(mkBoard(tasks), 5, 5, null)
  assert.deepEqual(r.pendings.map(t => t.id), ['w1'])          // 未被 verifying 任务拦住
  assert.deepEqual(r.blockedTouches, [])
  assert.deepEqual(r.verifs.map(t => t.id), ['vt'])            // Verifier 照常派（只读，不参与排他）
  // 反向：pending 任务声明 touches 也不影响 verifs 派发
  const tasks2 = [mkTask({ id: 'w2', touches: ['src/**'] }), mkTask({ id: 'v2', status: 'verifying', pipeline: 'full' })]
  const r2 = core.pickDispatch(mkBoard(tasks2), 5, 5, null)
  assert.deepEqual(r2.verifs.map(t => t.id), ['v2'])
})

test('pickDispatch: 未声明 touches 的任务不做任何拦截；同一轮内已派发任务立即成为锁持有者', () => {
  // 无锁持有者时，声明了 touches 的任务照常派发（锁只在 in-progress 时持有）
  const solo = mkBoard([mkTask({ id: 'solo', touches: ['src/**'] })])
  const r1 = core.pickDispatch(solo, 5, 0, null)
  assert.deepEqual(r1.pendings.map(t => t.id), ['solo'])
  assert.deepEqual(r1.blockedTouches, [])
  // 同一轮拿两个候选：第一个把 src/ 纳入锁，第二个声明重叠 → 本轮只派第一个
  const d = mkBoard([
    mkTask({ id: 'one', touches: ['src/a.js'], priority: 'critical', createdAt: '2026-01-01' }),
    mkTask({ id: 'two', touches: ['src/**'], createdAt: '2026-01-02' }),
  ])
  const r2 = core.pickDispatch(d, 5, 0, null)
  assert.deepEqual(r2.pendings.map(t => t.id), ['one'])
  assert.deepEqual(r2.blockedTouches, [{ id: 'two', conflicts: ['one'] }])
})

test('pickDispatch: frozen/dependsOn/escalation 优先级不变（touches 拦截附加在原有过滤之后）', () => {
  const tasks = [
    mkTask({ id: 'holder', status: 'in-progress', claimedBy: 'run-1', touches: ['src/**'] }),
    mkTask({ id: 'fz', frozen: true, touches: ['src/a.js'] }),                 // 冻结 → 既有语义直接排除，不记 blockedTouches
    mkTask({ id: 'dep', dependsOn: ['holder'], touches: ['src/a.js'] }),        // 依赖未满足 → 既有语义排除
    mkTask({ id: 'esc', escalation: { question: 'q' }, touches: ['src/a.js'] }),// 待裁决 → 排除
    mkTask({ id: 'clash', touches: ['src/a.js'] }),                            // 唯一被 touches 拦下的
  ]
  const r = core.pickDispatch(mkBoard(tasks), 5, 0, null)
  assert.deepEqual(r.pendings, [])
  assert.deepEqual(r.blockedTouches, [{ id: 'clash', conflicts: ['holder'] }])
  // 锁释放（holder 结算/归档）后，被拦任务下一轮自动恢复可派发
  mkBoard(tasks).tasks[0].status = 'verifying'
  const r2 = core.pickDispatch(mkBoard(tasks), 5, 0, null)
  assert.ok(r2.pendings.map(t => t.id).indexOf('clash') >= 0)
  assert.deepEqual(r2.blockedTouches, [])
})

test('normalizeBoard: touches 脏值（非数组）收敛为空数组，缺字段任务照常', () => {
  const legacy = { tasks: [{ id: 'a', touches: 'src/a.js' }, { id: 'b' }, { id: 'c', touches: ['src/c.js'] }] }
  const d = core.normalizeBoard(legacy)
  assert.deepEqual(d.tasks[0].touches, [])
  assert.equal(d.tasks[1].touches, undefined) // 缺字段不动（老看板文件兼容）
  assert.deepEqual(d.tasks[2].touches, ['src/c.js'])
})

// ===== 孤儿回收 =====
test('isOrphan: 认领者非主会话 + 无活跃 run + 超 2 分钟', () => {
  const old = new Date(Date.now() - 200000).toISOString()
  const t = mkTask({ status: 'in-progress', claimedBy: 'run-123', claimedAt: old })
  const d = mkBoard([t])
  assert.equal(core.isOrphan(d, t, {}, Date.now()), true)
  assert.equal(core.isOrphan(d, t, { t1: {} }, Date.now()), false) // 有活跃 run
  t.claimedBy = 's1' // 主会话自己认领的
  assert.equal(core.isOrphan(d, t, {}, Date.now()), false)
  t.claimedBy = 'run-123'; t.escalation = { question: 'q' }
  assert.equal(core.isOrphan(d, t, {}, Date.now()), false) // 待裁决的不回收
  delete t.escalation; t.claimedAt = new Date().toISOString()
  assert.equal(core.isOrphan(d, t, {}, Date.now()), false) // 刚认领不超 2 分钟
})

// ===== 种子与配置 =====
test('seed: 初始看板结构', () => {
  const d = core.seed('s1')
  assert.equal(d.ownerSession, 's1'); assert.equal(d.boardMode, 'auto'); assert.deepEqual(d.tasks, [])
  assert.ok(core.vt(d))
  // poolStatus 必须存在——task_list 工具输出它，undefined 会被 lossless-JSON 校验拒
  assert.deepEqual(d.poolStatus, { workers: [], verifiers: [] })
})

test('normalizeBoard: 旧文件补 poolStatus', () => {
  const legacy = { tasks: [] }
  const d = core.normalizeBoard(legacy)
  assert.deepEqual(d.poolStatus, { workers: [], verifiers: [] })
  // 已有合法 poolStatus 不动
  const ok = { tasks: [], poolStatus: { workers: [{ id: 'w1' }], verifiers: [] } }
  assert.equal(core.normalizeBoard(ok).poolStatus.workers[0].id, 'w1')
  // 残缺的 poolStatus（缺 verifiers 数组）也修复
  const broken = { tasks: [], poolStatus: { workers: [] } }
  assert.deepEqual(core.normalizeBoard(broken).poolStatus, { workers: [], verifiers: [] })
})

test('cfg: 边界夹紧', () => {
  const c = core.cfg({ minWorkers: -1, maxWorkers: 99, minVerifiers: 99, maxVerifiers: -1 })
  assert.equal(c.minWorkers, 0); assert.equal(c.maxWorkers, 10); assert.equal(c.minVerifiers, 5); assert.equal(c.maxVerifiers, 0)
})

// ===== 回归：PRIO_RANK 使用一致性 =====
test('PRIO_RANK: 与 pickDispatch 排序一致', () => {
  // PRIO_RANK 必须有 4 档，且值与 pickDispatch 的 sort 逻辑一致
  assert.equal(core.PRIO_RANK.critical, 4); assert.equal(core.PRIO_RANK.high, 3)
  assert.equal(core.PRIO_RANK.medium, 2); assert.equal(core.PRIO_RANK.low, 1)
  // pickDispatch 优先级排序验证（已在前面测过，这里确认 PRIO_RANK 可用）
  const d = mkBoard([mkTask({ id: 'lo', priority: 'low' }), mkTask({ id: 'hi', priority: 'critical' })])
  const r = core.pickDispatch(d, 5, 0, null)
  assert.equal(r.pendings[0].id, 'hi') // critical 排前面
})

// ===== 回归：outputText 对各种 SubagentResult 形态 =====
test('outputText: 各种 ContentBlock 形态', () => {
  assert.equal(core.outputText({ output: [{ type: 'text', text: 'hello' }] }), 'hello')
  assert.equal(core.outputText({ output: [] }), '')
  assert.equal(core.outputText({ output: [{ type: 'tool_use' }] }), '') // 无 text block
  assert.equal(core.outputText({ stopReason: 'completed' }), '') // 无 output 字段
  assert.equal(core.outputText(undefined), '')
  assert.equal(core.outputText(null), '')
})

// ===== 回归：isOrphan 边界 =====
test('isOrphan: cancelled 状态不回收（不在 in-progress）', () => {
  const t = mkTask({ status: 'cancelled', claimedBy: 'run-x', claimedAt: new Date(Date.now() - 999999).toISOString() })
  assert.equal(core.isOrphan(mkBoard([t]), t, {}, Date.now()), false)
})
test('isOrphan: 刚 claim 的（<2min）不回收', () => {
  const t = mkTask({ status: 'in-progress', claimedBy: 'run-x', claimedAt: new Date().toISOString() })
  assert.equal(core.isOrphan(mkBoard([t]), t, {}, Date.now()), false)
})

// ===== 任务粒度治理（软闸门：只提示，绝不阻断）=====
test('suggestSplitOf: 常规粒度任务不提示（返回空串）', () => {
  assert.equal(suggestSplitOf(mkTask({ title: '改按钮文案', description: '把按钮文案从 A 改成 B，肉眼确认' })), '')
  assert.equal(suggestSplitOf(mkTask()), '')
  assert.equal(suggestSplitOf(undefined), '')
})

test('suggestSplitOf: description 超过 500 字符触发建议（恰好 500 不触发）', () => {
  assert.equal(suggestSplitOf(mkTask({ description: 'x'.repeat(500) })), '')
  assert.equal(suggestSplitOf(mkTask({ description: 'x'.repeat(501) })), SUGGEST_SPLIT_TEXT)
})

test('suggestSplitOf: 命中史诗特征词触发建议（title / description 任一命中）', () => {
  assert.equal(suggestSplitOf(mkTask({ title: '全量重构派发引擎' })), SUGGEST_SPLIT_TEXT)
  assert.equal(suggestSplitOf(mkTask({ title: 'T', description: '把整个看板 UI 做一遍' })), SUGGEST_SPLIT_TEXT)
  assert.equal(suggestSplitOf(mkTask({ title: 'T', description: '系统级改造' })), SUGGEST_SPLIT_TEXT)
})

test('suggestSplitOf: 建议文案含 10~30 分钟粒度与拆分出口', () => {
  assert.match(SUGGEST_SPLIT_TEXT, /10~30 分钟/)
  assert.match(SUGGEST_SPLIT_TEXT, /parentId/)
  assert.match(SUGGEST_SPLIT_TEXT, /收窄边界/)
})

test('withSplitHint: 命中时才附加 suggestSplit，未命中返回体形态不变（老调用方无感）', () => {
  const big = withSplitHint({ ok: true, task: {} }, mkTask({ title: '全量重写' }))
  assert.equal(big.suggestSplit, SUGGEST_SPLIT_TEXT)
  const small = withSplitHint({ ok: true, task: {} }, mkTask({ title: '改个错别字' }))
  assert.deepEqual(Object.keys(small), ['ok', 'task']) // 不附加 suggestSplit
  assert.equal(small.suggestSplit, undefined)
})

test('粒度治理接线：工具描述/Team 提示词/双出口返回体均已落地（源码级轻量断言）', () => {
  const src = hostSrc()
  assert.match(TASK_SIZE_CONTRACT, /建议粒度：单任务 10~30 分钟/)
  assert.match(TASK_SIZE_CONTRACT, /epic 卡/)
  assert.match(TEAM_SPLIT_RULE, /大任务必须拆分/)
  assert.match(TEAM_SPLIT_RULE, /pipeline 传 direct/)
  assert.match(TEAM_SPLIT_RULE, /parentId=父卡 id/)
  assert.match(TEAM_SPLIT_RULE, /checkParentAuto/)
  assert.ok(src.includes("' + TASK_SIZE_CONTRACT")) // task_create 工具描述已拼接契约
  assert.ok(src.includes("' + TEAM_SPLIT_RULE"))    // teamSection 已拼接第 6 条
  assert.equal((src.match(/withSplitHint\(\{ ok: true, task: t \}, t\)/g) || []).length, 2) // task_create 工具 + create-task RPC
  assert.match(src, /全量\|整体\|系统级\|全面\|重构\|所有模块\|整个/) // 史诗特征词表在位
  assert.match(src, /SPLIT_DESC_LIMIT = 500/)                        // 500 字符阈值在位
})

// ===== create-task 空 description 软警告（E 卡）=====
// 轻量 RPC 直调 harness：mock ctx（tools/effect/webServer）+ deps 最小面，直接调 handlers['create-task']
// extra 可覆盖默认 deps（如 epic 预检用例注入 pushSysNote 捕获 / sessionCwd 解析根）
function mkRpcHandlers(board, extra) {
  const state = { handlers: {}, teamModeCache: {}, feedbackCache: {} }
  const tools = {} // 工具通道捕获：双通道接线测试经 __tools['task_create'].execute(...) 直调
  const ctx = { tools: { register(t) { tools[t.name] = t } }, effect() {}, webServer: { register() { return () => {} } } }
  const deps = Object.assign({
    getActorId: () => 'tester', resolveRoot: (x) => x,
    toolSessionId: () => 's1', rpcSessionId: () => 's1',
    rootForSession: () => null, deriveWorkMode: () => 'solo', runsFor: () => [],
    rt: async () => board, mutateLocked: (sid, fn) => fn(board),
    maybeNotify: () => {}, notifyTaskDone: () => {},
    spawnOneShot: () => {}, accumulateRunUsage: () => {}, readContextPack: async () => null,
    pushSysNote: () => {}, sessionCwd: () => '',
  }, extra || {})
  createRpc(ctx, state, deps)
  state.handlers.__tools = tools
  return state.handlers
}
const EMPTY_DESC_WARNING = '任务描述为空——Worker 只能凭标题猜需求，建议补一句目标/约束'

test('create-task RPC: description 空白（空串 / 纯空格）→ 创建成功且响应附 warning 软警告', async () => {
  let board = mkBoard([])
  let r = await mkRpcHandlers(board)['create-task']({ title: 'T', description: '' })
  assert.equal(r.ok, true); assert.equal(r.warning, EMPTY_DESC_WARNING)
  assert.equal(board.tasks.length, 1) // 软警告不拦截创建
  board = mkBoard([])
  r = await mkRpcHandlers(board)['create-task']({ title: 'T', description: '   ' }) // 纯空格同样视为空白（trim 判定）
  assert.equal(r.ok, true); assert.equal(r.warning, EMPTY_DESC_WARNING)
  assert.equal(board.tasks.length, 1)
})

test('create-task RPC: description 非空 → 响应无 warning 字段（返回体形态不变，老调用方无感）', async () => {
  const board = mkBoard([])
  const r = await mkRpcHandlers(board)['create-task']({ title: 'T', description: '把按钮文案从 A 改成 B，肉眼确认' })
  assert.equal(r.ok, true)
  assert.equal('warning' in r, false)
  assert.equal(board.tasks.length, 1)
})

// ===== 调研门禁（task-mute6zpw）：warning 族扩展 + epic 发布预检 + 读包失败落卡 =====
// 纯函数口径在 core.mjs（isTreeGlob/createTaskWarnings/epicPrecheck/epicPrecheckNote）；
// 这里既测纯函数矩阵，也经 mkRpcHandlers 直调验证双通道接线（warning 合并、publish 预检投递）。

test('isTreeGlob: 仅「以 /** 结尾或恰为 **」算整树 glob', () => {
  for (const p of ['**', 'src/**', './src/**', 'src\\**', 'a/b/**']) assert.equal(core.isTreeGlob(p), true, p)
  for (const p of ['src/*', 'src/**/*.mjs', '*.mjs', 'src/x.mjs', '', '**x']) assert.equal(core.isTreeGlob(p), false, p)
})

test('createTaskWarnings: 触发/不触发矩阵（pipeline × touches × 调研上下文）', () => {
  // ① description 空白（沿用 E 卡既有文案，逐字一致）
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: ' ' })), [EMPTY_DESC_WARNING])
  // ② full/work + touches 非空 + contextFiles/contextNotes 皆空 → 无调研上下文警告
  const noCtx = core.createTaskWarnings(mkTask({ description: 'd', pipeline: 'full', touches: ['lib/a.mjs'] }))
  assert.equal(noCtx.length, 1); assert.match(noCtx[0], /未附调研上下文/)
  const work = core.createTaskWarnings(mkTask({ description: 'd', pipeline: 'work', touches: ['lib/a.mjs'] }))
  assert.equal(work.length, 1); assert.match(work[0], /未附调研上下文/)
  // 有 contextFiles 或 contextNotes 任一 → ②不触发
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: 'd', touches: ['lib/a.mjs'], context: { files: ['lib/a.mjs'], notes: '' } })), [])
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: 'd', touches: ['lib/a.mjs'], context: { files: [], notes: '结论' } })), [])
  // pipeline=direct 或 touches 为空 → ②③都不触发
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: 'd', pipeline: 'direct', touches: ['src/**'] })), [])
  assert.deepEqual(core.createTaskWarnings(mkTask({ description: 'd', touches: [] })), [])
  // ③ 整树 glob（与 ② 同现时的数组序：② 在前 ③ 在后）
  const both = core.createTaskWarnings(mkTask({ description: 'd', touches: ['src/**'] }))
  assert.equal(both.length, 2); assert.match(both[0], /未附调研上下文/); assert.match(both[1], /整树 glob/)
  // 有调研上下文时只剩 ③
  const globOnly = core.createTaskWarnings(mkTask({ description: 'd', touches: ['src/**'], context: { files: [], notes: 'n' } }))
  assert.equal(globOnly.length, 1); assert.match(globOnly[0], /整树 glob/)
})

test('create-task RPC: touches 非空且无调研上下文 → warning 附「未附调研上下文」（软提示不拦截）', async () => {
  const board = mkBoard([])
  const r = await mkRpcHandlers(board)['create-task']({ title: '改 lib/x.mjs 的返回值', description: '明确描述', touches: ['lib/x.mjs'] })
  assert.equal(r.ok, true); assert.match(r.warning, /未附调研上下文/); assert.equal(board.tasks.length, 1)
})

test('create-task RPC: 整树 glob → warning 附「整树 glob」；pipeline=direct 不触发 a/b', async () => {
  let board = mkBoard([])
  let r = await mkRpcHandlers(board)['create-task']({ title: '调整 src 目录的一批样式', description: 'd', touches: ['src/**'], contextNotes: '已调研' })
  assert.equal(r.ok, true); assert.match(r.warning, /整树 glob/); assert.ok(!/未附调研上下文/.test(r.warning))
  board = mkBoard([])
  r = await mkRpcHandlers(board)['create-task']({ title: '改 src 下某个开关', description: 'd', pipeline: 'direct', touches: ['src/**'] })
  assert.equal(r.ok, true); assert.equal('warning' in r, false)
})

test('create-task RPC: 空描述 + 无调研上下文 + 整树 glob → 三条合并为一条 warning（；分隔）', async () => {
  const board = mkBoard([])
  const r = await mkRpcHandlers(board)['create-task']({ title: '改 src 一批文件', description: '', touches: ['src/**'] })
  assert.equal(r.ok, true)
  assert.match(r.warning, /任务描述为空/); assert.match(r.warning, /未附调研上下文/); assert.match(r.warning, /整树 glob/)
  assert.equal(r.warning.split('；').length, 3)
})

test('epicPrecheck: 字段有无 + 路径存在性（exists 注入），direct/归档子任务不参与', () => {
  const kids = [
    mkTask({ id: 'k1', title: '无材料', parentId: 'ep', context: { files: [], notes: '' } }),
    mkTask({ id: 'k2', title: '有笔记', parentId: 'ep', context: { files: [], notes: '结论' } }),
    mkTask({ id: 'k3', title: '路径全不存在', parentId: 'ep', context: { files: ['a.mjs', 'b.mjs:L3-L9'], notes: '' } }),
    mkTask({ id: 'k4', title: '路径存在', parentId: 'ep', context: { files: ['c.mjs'], notes: '' } }),
    mkTask({ id: 'k5', title: 'direct 跳过', parentId: 'ep', pipeline: 'direct', context: { files: [], notes: '' } }),
    mkTask({ id: 'k6', title: '归档跳过', parentId: 'ep', status: 'archived', context: { files: [], notes: '' } }),
  ]
  const pre = core.epicPrecheck(kids, 'ep', (p) => p === 'c.mjs')
  assert.equal(pre.total, 4) // direct/归档不计入 N
  assert.deepEqual(pre.missing.map((m) => m.id), ['k1', 'k3'])
  assert.match(pre.missing[0].reason, /无 contextFiles/)
  assert.match(pre.missing[1].reason, /全部不存在/)
  // 锚点 :L 段先剥掉再查存在性（'b.mjs:L3-L9' 以 'b.mjs' 查 exists）
  const seen = []
  core.epicPrecheck([mkTask({ id: 'x', parentId: 'ep', context: { files: ['b.mjs:L3-L9'], notes: '' } })], 'ep', (p) => { seen.push(p); return true })
  assert.deepEqual(seen, ['b.mjs'])
})

test('epicPrecheckNote: 全部有材料 → 空串（不打扰）；有缺失 → N/M 汇总文案（超 5 条折叠）', () => {
  assert.equal(core.epicPrecheckNote({ total: 3, missing: [] }), '')
  assert.equal(core.epicPrecheckNote(null), '')
  const note = core.epicPrecheckNote({ total: 3, missing: [{ id: 'k1', title: '无材料', reason: '无 contextFiles/contextNotes' }] })
  assert.match(note, /epic 发布预检：3 个子任务中 1 个无调研注入/)
  assert.match(note, /k1「无材料」/)
  const many = { total: 7, missing: [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'k' + i, title: 't' + i, reason: 'r' })) }
  const note2 = core.epicPrecheckNote(many)
  assert.match(note2, /7 个子任务中 6 个无调研注入/); assert.match(note2, /等/)
})

test('update-task RPC: 发布 epic（有子任务缺调研注入）→ pushSysNote 汇总 + 响应挂 epicPrecheck；全有材料不打扰', async () => {
  const notes = []
  const board = mkBoard([
    mkTask({ id: 'ep', title: '史诗', status: 'draft' }),
    mkTask({ id: 'c1', title: '子任务1', parentId: 'ep', status: 'draft', context: { files: [], notes: '' } }),
    mkTask({ id: 'c2', title: '子任务2', parentId: 'ep', status: 'draft', context: { files: [], notes: 'n' } }),
  ])
  const handlers = mkRpcHandlers(board, { pushSysNote: (sid, text, taskId) => notes.push({ text, taskId }) })
  const r = await handlers['update-task']({ taskId: 'ep', publish: true })
  assert.equal(r.ok, true)
  assert.equal(board.tasks[0].status, 'pending') // 照常发布，预检不阻断
  assert.equal(notes.length, 1)
  assert.match(notes[0].text, /epic 发布预检：2 个子任务中 1 个无调研注入/)
  assert.match(notes[0].text, /c1「子任务1」/)
  assert.equal(notes[0].taskId, 'ep')
  assert.ok(r.epicPrecheck && r.epicPrecheck.missing.length === 1)
  // 全部有材料 → 不投递、响应不挂字段（「不打扰」口径）
  const notes2 = []
  const board2 = mkBoard([
    mkTask({ id: 'ep2', title: '史诗2', status: 'draft' }),
    mkTask({ id: 'c3', title: '子任务3', parentId: 'ep2', status: 'draft', context: { files: [], notes: 'n' } }),
  ])
  const h2 = mkRpcHandlers(board2, { pushSysNote: (sid, text) => notes2.push(text) })
  const r2 = await h2['update-task']({ taskId: 'ep2', publish: true })
  assert.equal(r2.ok, true); assert.equal(notes2.length, 0); assert.equal('epicPrecheck' in r2, false)
  // 非 draft 发布被拒（not a draft）→ 不预检不投递：ep2 已是 pending，重复 publish 应被拒
  const r3 = await h2['update-task']({ taskId: 'ep2', publish: true })
  assert.equal(r3.ok, false); assert.match(r3.error, /not a draft/); assert.equal(notes2.length, 0)
})

// ===== 调研遵循·host 三件套（task-mutnj3a4）：touches→suggestedContextFiles 桥接 + Verifier 归因 + 驳回 hint =====

test('suggestContextFiles: glob 跳过 / 锚点剥离 / 存在性过滤 / 去重 / 上限 20 全矩阵', () => {
  // 非数组 / 空条目 / 非字符串 → 空
  assert.deepEqual(core.suggestContextFiles(null, () => true), [])
  assert.deepEqual(core.suggestContextFiles(['', '  ', 42], () => true), [])
  // glob 条目（* ? [ ] { } 任一）跳过；具体文件保留
  assert.deepEqual(core.suggestContextFiles(['src/**', '*.mjs', 'a?.js', 'x/[ab].js', 'x/{a,b}.js', 'lib/a.mjs'], () => true), ['lib/a.mjs'])
  // 锚点 :L 段剥掉后再查存在性，返回剥锚后的相对原样
  const seen = []
  const r = core.suggestContextFiles(['lib/a.mjs:L10-L20'], (p) => { seen.push(p); return true })
  assert.deepEqual(r, ['lib/a.mjs']); assert.deepEqual(seen, ['lib/a.mjs'])
  // 存在性过滤：不存在的剔除
  assert.deepEqual(core.suggestContextFiles(['a.mjs', 'b.mjs'], (p) => p === 'b.mjs'), ['b.mjs'])
  // exists 抛异常视为不存在（宁缺勿滥）
  assert.deepEqual(core.suggestContextFiles(['a.mjs'], () => { throw new Error('x') }), [])
  // exists 缺省 → 退化为只做 glob/锚点过滤（与 epicPrecheck 同口径）
  assert.deepEqual(core.suggestContextFiles(['a.mjs', 'src/**']), ['a.mjs'])
  // 去重（按剥锚后原串）+ 顺序保持
  assert.deepEqual(core.suggestContextFiles(['a.mjs', 'a.mjs:L5', 'b.mjs', 'a.mjs'], () => true), ['a.mjs', 'b.mjs'])
  // 上限 20（与 contextFiles 上限一致）
  const many = []
  for (let i = 0; i < 25; i++) many.push('f' + i + '.mjs')
  assert.equal(core.suggestContextFiles(many, () => true).length, 20)
})

test('attachContextSuggestions: 触发②且有建议 → warning 补尾 + 挂字段；否则形态不变', () => {
  // 触发：warnings 含无调研警告且 touches 有可建议文件
  const out = { ok: true }
  const warns = core.createTaskWarnings(mkTask({ description: 'd', touches: ['lib/a.mjs'] }))
  const suggested = core.attachContextSuggestions(out, warns, ['lib/a.mjs'], () => true)
  assert.deepEqual(suggested, ['lib/a.mjs'])
  assert.deepEqual(out.suggestedContextFiles, ['lib/a.mjs'])
  assert.match(warns[0], /可直接 task_update contextFiles 补上/)
  // 不触发①：无「未附调研上下文」警告（已有调研上下文）→ null，out 不挂字段
  const out2 = { ok: true }
  const warns2 = core.createTaskWarnings(mkTask({ description: 'd', touches: ['lib/a.mjs'], context: { files: [], notes: 'n' } }))
  assert.equal(core.attachContextSuggestions(out2, warns2, ['lib/a.mjs'], () => true), null)
  assert.equal('suggestedContextFiles' in out2, false)
  // 不触发②：touches 全 glob → null，warning 原文不变（不补尾巴）
  const out3 = { ok: true }
  const warns3 = core.createTaskWarnings(mkTask({ description: 'd', touches: ['src/**'] }))
  const before = warns3.join('；')
  assert.equal(core.attachContextSuggestions(out3, warns3, ['src/**'], () => true), null)
  assert.equal('suggestedContextFiles' in out3, false)
  assert.equal(warns3.join('；'), before)
})

test('create-task 双通道：touches 指向真实文件且无调研上下文 → 挂 suggestedContextFiles + warning 补尾', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-suggest-'))
  fs.writeFileSync(path.join(tmp, 'real.mjs'), '// x')
  const extra = { sessionCwd: () => tmp }
  // RPC 通道：ghost.mjs 不存在、src/** 是 glob → 均剔除，只剩 real.mjs
  const board = mkBoard([])
  const r = await mkRpcHandlers(board, extra)['create-task']({ title: 'T', description: 'd', touches: ['real.mjs', 'ghost.mjs', 'src/**'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.suggestedContextFiles, ['real.mjs'])
  assert.match(r.warning, /未附调研上下文/); assert.match(r.warning, /可直接 task_update contextFiles 补上/)
  // 工具通道（同口径）
  const board2 = mkBoard([])
  const tools = mkRpcHandlers(board2, extra).__tools
  const r2 = await tools['task_create'].execute({ title: 'T', description: 'd', touches: ['real.mjs'] }, {})
  assert.equal(r2.ok, true)
  assert.deepEqual(r2.suggestedContextFiles, ['real.mjs'])
  assert.match(r2.warning, /可直接 task_update contextFiles 补上/)
})

test('create-task：touches 全 glob 或已有调研上下文 → 不挂 suggestedContextFiles（返回体形态不变）', async () => {
  const board = mkBoard([])
  const r = await mkRpcHandlers(board)['create-task']({ title: 'T', description: 'd', touches: ['src/**'] })
  assert.equal(r.ok, true); assert.match(r.warning, /未附调研上下文/)
  assert.equal('suggestedContextFiles' in r, false)
  assert.ok(!/可直接 task_update/.test(r.warning)) // 无建议时尾巴也不补
  const board2 = mkBoard([])
  const r2 = await mkRpcHandlers(board2)['create-task']({ title: 'T', description: 'd', touches: ['lib/a.mjs'], contextNotes: '已调研' })
  assert.equal(r2.ok, true); assert.equal('warning' in r2, false); assert.equal('suggestedContextFiles' in r2, false)
})

test('verify 驳回 hint：verify-task RPC + task_verify 工具 rejected 附重派提示，approved 不附', async () => {
  // RPC 通道 rejected → 附 hint，驳回语义不变（回 in-progress）
  const board = mkBoard([mkTask({ id: 'v1', status: 'verifying' })])
  const r = await mkRpcHandlers(board)['verify-task']({ taskId: 'v1', verdict: 'rejected', comment: '跑偏了' })
  assert.equal(r.ok, true); assert.match(r.hint, /驳回原因写进 description/); assert.match(r.hint, /新 Worker 没有上一轮记忆/)
  assert.equal(board.tasks[0].status, 'in-progress')
  // RPC 通道 approved → 无 hint 字段
  const board2 = mkBoard([mkTask({ id: 'v2', status: 'verifying' })])
  const r2 = await mkRpcHandlers(board2)['verify-task']({ taskId: 'v2', verdict: 'approved' })
  assert.equal(r2.ok, true); assert.equal('hint' in r2, false)
  // 工具通道 rejected → 同口径附 hint
  const board3 = mkBoard([mkTask({ id: 'v3', status: 'verifying' })])
  const r3 = await mkRpcHandlers(board3).__tools['task_verify'].execute({ taskId: 'v3', verdict: 'rejected', comment: '缺测试' }, {})
  assert.equal(r3.ok, true); assert.match(r3.hint, /驳回原因写进 description/)
  // 工具通道 approved → 无 hint
  const board4 = mkBoard([mkTask({ id: 'v4', status: 'verifying' })])
  const r4 = await mkRpcHandlers(board4).__tools['task_verify'].execute({ taskId: 'v4', verdict: 'approved' }, {})
  assert.equal(r4.ok, true); assert.equal('hint' in r4, false)
})

test('buildVerifierPrompt: 含「立单缺调研」驳回归因条款', () => {
  const p = core.buildVerifierPrompt(mkTask({ id: 'tx', status: 'verifying' }), '')
  assert.match(p, /立单缺调研/)
  assert.match(p, /驳回热点统计/)
})

test('调研遵循接线：双通道 attachContextSuggestions / 驳回 hint 双挂 / Verifier 归因条款（源码级断言）', () => {
  const src = hostSrc()
  assert.equal((src.match(/attachContextSuggestions\(/g) || []).length, 2) // task_create 工具 + create-task RPC
  assert.equal((src.match(/\.hint = REJECT_REDISPATCH_HINT/g) || []).length, 2) // task_verify 工具 + verify-task RPC
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /立单缺调研/) // Verifier prompt 归因条款在位
  assert.match(coreSrc, /export function suggestContextFiles/)
})

test('调研门禁接线：双通道 warning 调用 / epic 预检投递 / 读包失败落卡（源码级轻量断言）', () => {
  const src = hostSrc()
  assert.equal((src.match(/createTaskWarnings\(t\)/g) || []).length, 2) // task_create 工具 + create-task RPC
  assert.match(src, /pushSysNote: notify\.pushSysNote, sessionCwd: session\.sessionCwd/) // index.mjs 接线
  assert.match(src, /__pre = epicPrecheck\(d\.tasks, t\.id, existsFn\)/) // publish 预检调用
  assert.match(src, /afterPublishPrecheck\(sid, args\.taskId, __res\)/) // 锁外 pushSysNote 投递
  assert.match(src, /t2\.lastError = \('contextPack 读取失败: '/) // dispatch 读包失败落卡（mutateLocked 返回非空才写盘）
  assert.match(src, /调研门禁：pipeline=full\/work 且 touches 非空/) // task_create 工具描述事前引导
})

// ===== Token 消耗统计 =====
test('aggregateUsageSummary: 空任务/无 usage 任务 → 全零 + 空 Top', () => {
  const s = aggregateUsageSummary([mkTask({ id: 'a' }), mkTask({ id: 'b', usage: null })])
  assert.equal(s.total, 0); assert.equal(s.input, 0); assert.equal(s.output, 0); assert.equal(s.cacheRead, 0)
  assert.deepEqual(s.byModel, {}); assert.deepEqual(s.topTasks, [])
  assert.deepEqual(aggregateUsageSummary(undefined), { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {}, topTasks: [] })
})

test('aggregateUsageSummary: 总量/输入输出缓存拆分累加 + 按模型小计合并', () => {
  const u1 = { input: 100, output: 20, cacheRead: 1000, cacheWrite: 0, total: 1120, runs: 2, models: { 'deepseek-flash': 1000, 'glm-5': 120 } }
  const u2 = { input: 5, output: 5, cacheRead: 0, cacheWrite: 3, total: 13, runs: 1, models: { 'deepseek-flash': 13 } }
  const s = aggregateUsageSummary([mkTask({ id: 'a', usage: u1 }), mkTask({ id: 'b', usage: u2 }), mkTask({ id: 'c' })])
  assert.equal(s.total, 1133); assert.equal(s.input, 105); assert.equal(s.output, 25)
  assert.equal(s.cacheRead, 1000); assert.equal(s.cacheWrite, 3)
  assert.deepEqual(s.byModel, { 'deepseek-flash': 1013, 'glm-5': 120 })
})

test('aggregateUsageSummary: Top 任务按总量降序、最多 8 条、带 runs 计数', () => {
  const tasks = []
  for (let i = 0; i < 12; i++) tasks.push(mkTask({ id: 't' + i, title: 'T' + i, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: i * 10, runs: i } }))
  const s = aggregateUsageSummary(tasks)
  assert.equal(s.topTasks.length, 8)
  assert.deepEqual(s.topTasks.map(x => x.total), [110, 100, 90, 80, 70, 60, 50, 40]) // 降序取前 8
  assert.equal(s.topTasks[0].id, 't11'); assert.equal(s.topTasks[0].title, 'T11'); assert.equal(s.topTasks[0].runs, 11)
})

test('readRunUsage: run 不存在 / 日志目录不可读 → null（优雅降级，不抛错）', () => {
  assert.equal(readRunUsage('no-such-run-' + Date.now()), null)
  assert.equal(readRunUsage(''), null)
  assert.equal(findRunLog('no-such-run-' + Date.now()), null)
})

test('readRunUsage: v4 多帧日志真实解析（临时目录造帧 → usage 逐帧累加 + 模型取自 request/context）', (t) => {
  // 只在宿主支持 zstd 压缩时构造样本（Node >= 22.15 / 23.8）；否则跳过，避免 CI 假红
  if (typeof zlib.zstdCompressSync !== 'function') { t.skip('zstdCompressSync unavailable'); return }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'))
  const runId = 'run-usage-test'
  const dir = path.join(root, 'bucket', runId)
  fs.mkdirSync(dir, { recursive: true })
  const frameOf = (events) => zlib.zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8'))
  // 三帧：帧 1 只有模型与一次 usage；帧 2 是半截坏帧（截断，必须被跳过而不是抛错）；帧 3 又一次 usage + 无 usage 事件
  const f1 = frameOf([
    { type: 'request/context', data: { model: 'deepseek-flash' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 1000, cacheWriteTokens: 0, totalTokens: 1107 } } }
  ])
  const good = frameOf([{ type: 'assistant/message', data: { usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 5, totalTokens: 12 } } }, { type: 'step/end', data: {} }])
  const bad = good.subarray(0, Math.max(1, good.length - 6)) // 截断帧：解压必失败
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([f1, bad, good]))
  const u = readRunUsage(runId, root)
  assert.equal(u.input, 103); assert.equal(u.output, 11); assert.equal(u.cacheRead, 1000)
  assert.equal(u.cacheWrite, 5); assert.equal(u.total, 1119); assert.equal(u.model, 'deepseek-flash')
  // 只有坏帧 / 无 usage 事件 → null（不是 0 值对象，调用方按「暂无数据」降级）
  const dir2 = path.join(root, 'bucket', 'run-no-usage'); fs.mkdirSync(dir2, { recursive: true })
  fs.writeFileSync(path.join(dir2, 'session.v4.jsonl.zstd'), frameOf([{ type: 'step/end', data: {} }]))
  assert.equal(readRunUsage('run-no-usage', root), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('Token 消耗接线：settleRun 结算累加 + 按模型小计 + get-tasks 聚合 + 仪表盘区块（源码级断言）', () => {
  const host = hostSrc()
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(host, /await accumulateRunUsage\(sid, rec\)/)                    // settleRun（及手动终止）结算路径调用
  assert.match(host, /t\.usage\.models\[mk\] = \(t\.usage\.models\[mk\] \|\| 0\) \+ u\.total/) // 按模型小计累加
  assert.match(host, /rec\.model \|\| u\.model/)                                // 模型 key 来源：派发覆盖 > 日志记录
  assert.match(host, /inputTokens/)                                            // 字段名与真实 v4 日志一致
  assert.match(host, /d\.usageSummary = aggregateUsageSummary\(d\.tasks\)/)     // get-tasks 现算聚合
  assert.match(cli, /React\.createElement\(TokenUsage, \{ usage: state\.usageSummary \}\)/) // 仪表盘插入消耗区
  assert.match(cli, /state\.usageSummary = \(d && d\.usageSummary\) \|\| null/) // 客户端取数
  assert.match(cli, /'⛁ ' \+ fmtTokens\(t\.usage\.total\)/)                     // 进行中/已完成卡片显示本任务累计
})

// ===== 学习飞轮 v1：候选教训信号 + feedbackEnabled 开关 + 软召回 =====
test('cfg: feedbackEnabled 默认开（缺字段/脏值都算开），只有显式 false 才关', () => {
  assert.equal(core.cfg({}).feedbackEnabled, true)
  assert.equal(core.cfg({ feedbackEnabled: true }).feedbackEnabled, true)
  assert.equal(core.cfg({ feedbackEnabled: false }).feedbackEnabled, false)
  assert.equal(core.cfg({ feedbackEnabled: 'no' }).feedbackEnabled, true) // 脏值不关（默认开）
})

test('seed/normalizeBoard: feedbackEnabled 新看板默认 true，老看板读路径补 true，显式 false 保留', () => {
  assert.equal(core.seed('s1').feedbackEnabled, true)
  assert.equal(core.normalizeBoard({ tasks: [] }).feedbackEnabled, true)                       // 老看板无字段 → 默认开
  assert.equal(core.normalizeBoard({ tasks: [], feedbackEnabled: false }).feedbackEnabled, false)
  assert.equal(core.normalizeBoard({ tasks: [], feedbackEnabled: 'x' }).feedbackEnabled, true) // 脏值收敛成默认开
})

test('lessonText: 三段式（场景/明细段/来源），明细段截 300 字', () => {
  const t = core.lessonText('任务「X」(t1) 被 Verifier 驳回', [['错误做法', '理'.repeat(400)]], '任务 t1 · 2026-01-01')
  const lines = t.split('\n')
  assert.equal(lines[0], '场景: 任务「X」(t1) 被 Verifier 驳回')
  assert.ok(lines[1].indexOf('错误做法: ') === 0)
  assert.equal(lines[1].slice('错误做法: '.length).length, 300) // 驳回理由截 300 字
  assert.equal(lines[2], '来源: 任务 t1 · 2026-01-01')
  // 仲裁形态：疑问 + 裁决结论两段
  const a = core.lessonText('任务「Y」(t2) 的歧义裁决', [['疑问', '该走 A 还是 B？'], ['裁决结论', '走 B']], '任务 t2')
  assert.match(a, /^场景: /)
  assert.match(a, /疑问: 该走 A 还是 B？/)
  assert.match(a, /裁决结论: 走 B/)
  assert.match(a, /来源: 任务 t2$/)
})

test('pushLesson: 落 kind=lesson-candidate（by 默认 system），同 at / 同内容前缀判重', () => {
  const t = { messages: [] }
  const txt = core.lessonText('场景', [['错误做法', '驳回理由']], 'src')
  assert.equal(core.pushLesson(t, txt, 'T1', 'system'), true)
  assert.equal(core.pushLesson(t, txt, 'T1', 'system'), false) // 同 at → 判重（同一事件多路径触发）
  assert.equal(core.pushLesson(t, txt, 'T2', 'system'), false) // 同内容前缀 → 判重
  assert.equal(t.messages.length, 1)
  assert.equal(t.messages[0].kind, 'lesson-candidate')
  assert.equal(t.messages[0].at, 'T1'); assert.equal(t.messages[0].by, 'system')
  const other = core.lessonText('另一个场景', [['错误做法', '别的理由']], 'src2')
  assert.equal(core.pushLesson(t, other), true)                 // 不同事件照常落
  assert.equal(t.messages[1].by, 'system')                      // by 缺省 system
  assert.equal(core.pushLesson({ messages: [] }, ''), false)    // 空文本不落
})

test('buildWorkerPrompt: 软召回引导随 feedbackEnabled 开关（关则整句消失）', () => {
  const t = mkTask({ id: 't1', title: 'X' })
  assert.match(core.buildWorkerPrompt(t), /先检索相关历史教训再动手/)                  // 缺省（未传）＝默认开
  assert.match(core.buildWorkerPrompt(t, '', true), /先检索相关历史教训再动手/)
  assert.doesNotMatch(core.buildWorkerPrompt(t, '', false), /历史教训/)               // 关 → 不出现
  assert.doesNotMatch(core.buildWorkerPrompt(t, '', false), /笔记\/记忆类工具/)
  assert.match(core.LESSON_RECALL_HINT, /note_search/) // 引导里点名可用的检索工具类型（只是举例）
})

test('学习飞轮接线：两处触发点 + push-lesson 开关拦截 + prompt/客户端软召回（源码级断言）', () => {
  const host = hostSrc()
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  // 候选教训两处触发：Verifier 驳回（文本通道 + 工具通道 + GUI RPC）与主窗口仲裁结论
  assert.match(host, /pushRejectLesson\(d, t, vsecs\.verifySummary \|\| trimmed, t\.verification\.at\)/)
  assert.match(host, /if \(!approved\) pushRejectLesson\(d, t, \(args\.summary \|\| ''\)/)
  assert.match(host, /if \(args\.verdict === 'rejected'\) \{ pushRejectLesson\(d, t, args\.comment\); r\.hint = REJECT_REDISPATCH_HINT \}/) // verify-task RPC：候选教训 + 驳回重派 hint（task-mutnj3a4）同分支挂载
  assert.match(host, /pushArbitrationLesson\(d, t, escQ, answer \|\| '', arbAt\)/)
  // 生成前一律过 feedbackEnabled 总开关（关掉 = 不生成、不推）
  assert.equal((host.match(/if \(!cfg\(d\)\.feedbackEnabled\) return false/g) || []).length, 2)
  // 沉淀推送通道：关 → 明确拒绝；开 → followup 给主窗口 agent 自行选择存储工具
  assert.match(host, /handle\('push-lesson'/)
  assert.match(host, /if \(!cfg\(d\)\.feedbackEnabled\) return \{ ok: false, error: 'feedback disabled' \}/)
  assert.match(host, /请用你可用的笔记\/记忆工具（如 note_manage）沉淀，或评估后忽略。/)
  assert.match(host, /root\.followup\(makeMsg\('📚 \[任务看板\] 候选教训沉淀请求/)
  // 开关透出：get-tasks 返回体 + set-board-config 写入 + 缓存同步（systemPrompt 同步读取）
  assert.match(host, /d\.feedbackEnabled = cfg\(d\)\.feedbackEnabled/)
  assert.match(host, /args\.key === 'feedbackEnabled'/)
  assert.match(host, /feedbackCache\[sid\] = d\.feedbackEnabled/)
  assert.match(host, /feedbackCache\[sid\] = nd\.feedbackEnabled !== false/)
  // 软召回：Worker prompt 与 Team 提示词都以开关为条件拼接
  assert.match(host, /buildWorkerPrompt\(t, packNote, cfg\(dsnap\)\.feedbackEnabled\)/)
  assert.match(host, /feedbackOn\(String\(agent\.id\)\) \? '\\n' \+ LESSON_RECALL_HINT/)
  assert.match(coreSrc, /if \(feedbackEnabled !== false\) p \+= '\\n\\n' \+ LESSON_RECALL_HINT/)
  // 客户端：开关读取 + 设置区 checkbox + 候选卡片「沉淀」按钮 + 关闭即整块不渲染
  assert.match(cli, /state\.feedbackEnabled = !\(d && d\.feedbackEnabled === false\)/)
  assert.match(cli, /key: 'feedbackEnabled', value: e\.target\.checked/)
  assert.match(cli, /'lesson-candidate': \{ color: C\.brand, label: '候选教训', icon: 'book-open' \}/)
  assert.match(cli, /rpc\('push-lesson', \{ taskId: props\.taskId, text: String\(m\.text \|\| ''\) \}\)/)
  assert.match(cli, /if \(!state\.feedbackEnabled\) msgs = msgs\.filter\(function \(m\) \{ return m && m\.kind !== 'lesson-candidate' \}\)/)
  // 零耦合红线：不出现任何笔记插件的模块导入/服务获取/API 调用
  // （注释里的历史提及与 prompt 文案里「举例可用工具名」不算耦合）
  assert.doesNotMatch(host, /from 'dsh-notes|require\('dsh-notes|ctx\.get\('notes'\)|uiWorkspace\.openNote|note_manage\(|note_search\(/)
  assert.doesNotMatch(coreSrc, /from 'dsh-notes|ctx\.get\('notes'\)|uiWorkspace\.openNote|note_manage\(|note_search\(/)
  assert.doesNotMatch(cli, /from 'dsh-notes|ctx\.get\('notes'\)|uiWorkspace\.openNote|note_manage\(|note_search\(/)
})

// ===== 架构自省 L1·UI：仪表盘「架构健康」提示区接线（源码级断言；纯函数信号本身见 health.test.mjs）=====
test('架构健康接线：get-tasks 返回 healthHints + 仪表盘 HealthHints 区缺省兼容渲染', () => {
  const host = hostSrc()
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(host, /d\.healthHints = computeHealthHints\(d\.tasks\)/)   // host 每次请求现算返回（零存储）
  assert.match(cli, /function HealthHints\(\)/)                          // 仪表盘提示区组件
  assert.match(cli, /React\.createElement\(HealthHints\)/)               // 挂进 Dashboard（统计卡行下方、Token 消耗区上方）
  assert.match(cli, /Array\.isArray\(d\.healthHints\)/)                  // 缺省兼容：老 host 无字段/非数组 → 按空处理
  assert.match(cli, /if \(!hints\.length\) return null/)                 // 空数组 → 整块不渲染（零残留）
  assert.match(cli, /'架构健康'/)                                        // 区标题
  assert.match(cli, /warn \? C\.warn : infoColor/)                       // warn=琥珀 / info=蓝灰 两级配色
  assert.match(cli, /dsw-alias-state-business-primary/)                  // info 蓝灰用 DSH 现有 business 信息色（色板无独立 info 档）
})

// ===== 史诗父卡语义层：父卡自动流转 + childStats 聚合 =====
test('parentKickOnDispatch: 子任务派发时 pending 父卡 → in-progress（记 ah），返回父卡', () => {
  const p = mkTask({ id: 'epic', status: 'pending' })
  const c = mkTask({ id: 'c1', parentId: 'epic' })
  const d = mkBoard([p, c])
  const r = core.parentKickOnDispatch(d, c)
  assert.equal(r, p)
  assert.equal(p.status, 'in-progress')
  const h = p.history[p.history.length - 1]
  assert.equal(h.from, 'pending'); assert.equal(h.to, 'in-progress')
  assert.match(h.note, /首个子任务派发，史诗进入推进态/)
})

test('parentKickOnDispatch: 已在 in-progress 不重放 / verifying 不动', () => {
  const p = mkTask({ id: 'epic', status: 'in-progress' })
  const c1 = mkTask({ id: 'c1', parentId: 'epic' }); const c2 = mkTask({ id: 'c2', parentId: 'epic' })
  const d = mkBoard([p, c1, c2])
  assert.equal(core.parentKickOnDispatch(d, c1), null) // 已推进态 → 不重放
  assert.equal(p.history.length, 0)
  assert.equal(p.status, 'in-progress')
  // verifying 父卡（全子任务 resolved 后的验收态）同样不动
  const pv = mkTask({ id: 'epic2', status: 'verifying' })
  const cv = mkTask({ id: 'c3', parentId: 'epic2' })
  const d2 = mkBoard([pv, cv])
  assert.equal(core.parentKickOnDispatch(d2, cv), null)
  assert.equal(pv.status, 'verifying'); assert.equal(pv.history.length, 0)
})

test('parentKickOnDispatch: draft 父卡不动（草稿是刻意的人工态）', () => {
  const p = mkTask({ id: 'epic', status: 'draft' })
  const c = mkTask({ id: 'c1', parentId: 'epic' })
  const d = mkBoard([p, c])
  assert.equal(core.parentKickOnDispatch(d, c), null)
  assert.equal(p.status, 'draft'); assert.equal(p.history.length, 0)
})

test('parentKickOnDispatch: 无 parentId / 父卡不存在 → null，无副作用', () => {
  const solo = mkTask({ id: 'solo' }); const d = mkBoard([solo])
  assert.equal(core.parentKickOnDispatch(d, solo), null)
  const orphan = mkTask({ id: 'c1', parentId: 'ghost' }); const d2 = mkBoard([orphan])
  assert.equal(core.parentKickOnDispatch(d2, orphan), null)
})

test('aggregateChildStats: 空板 / 无父子关系 → 空对象（不出键）', () => {
  assert.deepEqual(core.aggregateChildStats([]), {})
  assert.deepEqual(core.aggregateChildStats(null), {})
  assert.deepEqual(core.aggregateChildStats(undefined), {})
  const d = [mkTask({ id: 'a' }), mkTask({ id: 'b', status: 'in-progress' })]
  assert.deepEqual(core.aggregateChildStats(d), {})
})

test('aggregateChildStats: 聚合口径 total/resolved/active/activeTitle', () => {
  const kids = [
    mkTask({ id: 'c1', parentId: 'epic', status: 'resolved' }),
    mkTask({ id: 'c2', parentId: 'epic', status: 'in-progress', title: '进行中甲' }),
    mkTask({ id: 'c3', parentId: 'epic', status: 'pending' }),
    mkTask({ id: 'c4', parentId: 'epic', status: 'in-progress', title: '进行中乙' }),
    mkTask({ id: 'c5', parentId: 'epic', status: 'verifying' }),
    mkTask({ id: 'c6', parentId: 'epic', status: 'blocked' }),
  ]
  const s = core.aggregateChildStats(kids).epic
  assert.equal(s.total, 6)      // 非归档子任务全计
  assert.equal(s.resolved, 1)   // 仅 resolved（verifying 不算完成）
  assert.equal(s.active, 2)     // in-progress 数
  assert.equal(s.activeTitle, '进行中甲') // 第一个 in-progress 子任务标题（看板顺序）
})

test('aggregateChildStats: 归档子任务不计入；全归档 → 不出键；多父卡各自成键', () => {
  const tasks = [
    // 父卡 p1：1 resolved + 1 archived（归档不计）+ 1 in-progress
    mkTask({ id: 'a1', parentId: 'p1', status: 'resolved' }),
    mkTask({ id: 'a2', parentId: 'p1', status: 'archived' }),
    mkTask({ id: 'a3', parentId: 'p1', status: 'in-progress', title: 'p1活跃' }),
    // 父卡 p2：全部 archived → 不出键
    mkTask({ id: 'b1', parentId: 'p2', status: 'archived' }),
    mkTask({ id: 'b2', parentId: 'p2', status: 'archived' }),
    // 父卡 p3：无活跃子任务 → activeTitle 空串
    mkTask({ id: 'd1', parentId: 'p3', status: 'pending' }),
    mkTask({ id: 'd2', parentId: 'p3', status: 'resolved' }),
  ]
  const stats = core.aggregateChildStats(tasks)
  assert.deepEqual(Object.keys(stats).sort(), ['p1', 'p3']) // p2 全归档不出键；父卡自身不在 tasks 也照算（按键聚合）
  assert.deepEqual(stats.p1, { total: 2, resolved: 1, active: 1, activeTitle: 'p1活跃' }) // archived 的 a2 不进 total
  assert.deepEqual(stats.p3, { total: 2, resolved: 1, active: 0, activeTitle: '' })
})

test('史诗语义层接线：poolCycle 派发分支触发父卡流转 + get-tasks 返回 childStats（源码级断言）', () => {
  const host = hostSrc()
  // poolCycle 占位 claim 的 dispatch 分支：claimApply 后紧跟 parentKickOnDispatch
  assert.match(host, /claimApply\(d, t, 'spawn-pending', 'dispatch'\); if \(parentKickOnDispatch\(d, t\)\)/)
  // get-tasks 现算 childStats（零存储）
  assert.match(host, /d\.childStats = aggregateChildStats\(d\.tasks\)/)
  // 两模块都从 core 解构引入（接线不断）；rpc.mjs 解构表尾部随调研门禁（task-mute6zpw）与调研遵循三件套（task-mutnj3a4）扩展
  assert.match(host, /parentKickOnDispatch, LESSON_RECALL_HINT \} = core/)
  assert.match(host, /boardHome, aggregateChildStats, createTaskWarnings, epicPrecheck, epicPrecheckNote, attachContextSuggestions, REJECT_REDISPATCH_HINT \} = core/)
  // 既有「全子任务 resolved → 父 verifying」逻辑不动（checkParentAuto 仍在 verifyApply 链路；core.mjs 不在 hostSrc 清单，单独读）
  const coreSrc = readFileSync(new URL('../lib/core.mjs', import.meta.url), 'utf8')
  assert.match(coreSrc, /if \(verdict === 'approved' && isb\(t\)\) \{ var p = checkParentAuto\(d, t\)/)
})

// ===== 防再发：notify 逻辑单一来源（lib/notify.mjs）=====
// dispatch.mjs 曾藏整套 notify 僵尸重复副本（本地 receiptBuf/escNotifyTimers + notifyTaskDone/flushReceipts 等：
// 函数声明提升后被头部 var x = deps.x 赋值覆盖，是永不执行的死代码——改错地方不产生效果，挪赋值顺序即引爆）。
// 此处断言六个函数的定义只存在于 notify.mjs，任何模块再长出副本即红。
test('notify 单一来源：notifyTaskDone/flushReceipts/deliverEscalation 等函数定义只存在于 lib/notify.mjs', () => {
  const names = ['deliverEscalation', 'notifyMainWindow', 'maybeNotify', 'notifyTaskDone', 'pushSysNote', 'flushReceipts']
  const others = ['../index.mjs', '../lib/policy.mjs', '../lib/usage.mjs', '../lib/session.mjs', '../lib/store.mjs', '../lib/dispatch.mjs', '../lib/rpc.mjs']
  const notifySrc = readFileSync(new URL('../lib/notify.mjs', import.meta.url), 'utf8')
  for (const name of names) {
    const re = new RegExp('function ' + name + '\\s*\\(')
    assert.match(notifySrc, re, 'lib/notify.mjs 缺少 ' + name + ' 定义（权威实现应在此）')
    for (const f of others) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      assert.ok(!re.test(src), f + ' 不得再定义 ' + name + '（notify 逻辑唯一权威在 lib/notify.mjs，副本是僵尸死代码）')
    }
  }
})

// ===== 调研门禁·UI：无调研徽章 + 详情注入清单 + 创建表单 warning 展示（源码级断言）=====
test('调研门禁 UI 接线：卡片「⚠️ 无调研」徽章 + 详情「调研注入」清单 + 创建表单 warning 黄行（源码级断言）', () => {
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(cli, /function noResearch\(t\)/)                        // 徽章判定函数（纯 client 侧现算）
  assert.match(cli, /pl !== 'full' && pl !== 'work'/)                 // 口径：仅 full/work 管线参与（direct 主窗口自处理）
  assert.match(cli, /'⚠️ 无调研'/)                                     // 卡片标题行右侧徽章文案
  assert.match(cli, /本任务未附调研上下文，Worker 需自行定位/)          // 徽章悬停解释（title）
  assert.match(cli, /var cx = t\.context \|\| \{\}/)                  // context 缺省兼容：老任务无 context 按空处理（预期亮徽章）
  assert.match(cli, /'📎 调研注入: '/)                                 // 详情页「调研注入」区标题
  assert.match(cli, /无调研注入——Worker 需自行定位/)                    // 详情空态明示
  assert.match(cli, /个文件（' \+ files\.map\(function \(f\) \{ return actBase\(f\) \}\)/) // files 清单按 basename 展示
  assert.match(cli, /调研笔记 ' \+ notes\.length \+ ' 字/)              // notes 字数统计
  assert.match(cli, /if \(r && r\.warning\)/)                          // 创建表单消费 create-task 响应的 warning 字段
  assert.match(cli, /'⚠️ ' \+ warn/)                                   // warning 原文黄色行展示（C.warn）
})
