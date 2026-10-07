// dsh-agent-board — Verifier 自测指南 client 侧单测（test/user-guide-client.test.mjs，task-muxyyvg0）
// client 无渲染 harness（react 不在包依赖，渲染由 dsh web 客户端运行时注入）——与历卡同一纪律：
// 全部走源码级断言（task-detail.js / dashboard.js / kernel.js 模块源 + client.js 重组装产物 + README 双份同步）。
//   ③ 卡详情展示块——验证记录区「自测指南」块：gist + 步骤列表 + 预期 + tier 徽章（ui 绿/metric 蓝/internal 灰）；
//      双门禁：板级开关 verifyUserGuide 关 / 未挂 userTest 字段，任一 → 整块不渲染
//   ④ 报告导出聚合——buildReport「## 本版自测清单」段：按 resolvedAt 倒序近 10 张已验收卡，
//      tier=internal 收末尾并标注；开关关掉整段不出现
//   ⑤ README 双份——根 README 与包 README 逐字一致 + verifier 段补指南说明 + 开关清单补 verifyUserGuide 行
//   ⑥ 接线——kernel state/轮询纠偏/PoolCfgPopover prop 传递 + 产物重组装
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const detail = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
const dash = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
const kernel = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ===== ③ 卡详情「自测指南」块（渲染 / 缺字段不渲染）=====
test('③详情块：验证记录区挂「📋 自测指南」——gist+步骤+预期+tier 三档徽章（ui 绿/metric 蓝/internal 灰）', () => {
  assert.ok(detail.indexOf('📋 自测指南') >= 0, '详情块标题缺失')
  // 双门禁：userTest 字段 + 板级开关（显式 false 才关），缺一不渲染
  assert.match(detail, /task\.verification\.userTest && state\.verifyUserGuide !== false/)
  // tier 三档徽章配色：ui 绿（C.ok）/ metric 蓝（C.brand）/ internal 灰（C.text2）
  assert.match(detail, /ut\.tier === 'ui' \? \{ c: C\.ok, label: 'UI 可操作' \}/)
  assert.match(detail, /ut\.tier === 'metric' \? \{ c: C\.brand, label: '看指标' \}/)
  assert.match(detail, /\{ c: C\.text2, label: '纯内部' \}/)
  // 徽章 title 附三档口径说明
  assert.match(detail, /ui=界面可操作 \/ metric=看指标变化 \/ internal=纯内部无用户可感知面/)
  // gist / 编号步骤列表 / 预期行三要素
  assert.match(detail, /ut\.gist \? React\.createElement\('div'/)
  assert.match(detail, /ut\.steps\.map\(function \(s, i\) \{ return React\.createElement\('div', \{ key: i/)
  assert.ok(detail.indexOf("(i + 1) + '. ' + s") >= 0, '编号步骤列表缺失')
  assert.ok(detail.indexOf("'预期：' + ut.expect") >= 0, '预期行缺失')
})

// ===== ④ 报告导出聚合「本版自测清单」段 =====
test('④报告段：buildReport 聚合「## 本版自测清单」——倒序近 10 张 + internal 收末尾标注 + 开关门禁', () => {
  assert.ok(dash.indexOf('## 本版自测清单') >= 0, '报告缺自测清单段标题')
  // 数据源 = 已验收卡（done 池）里挂了 userTest 的；开关关掉整段不出现
  assert.match(dash, /if \(state\.verifyUserGuide !== false\) \{[\s\S]*?## 本版自测清单/)
  assert.match(dash, /done\.filter\(function \(t\) \{ return t\.verification && t\.verification\.userTest \}\)/)
  // 按验收通过时间倒序（resolvedAt 兜底 verification.at）+ 近 10 张
  assert.match(dash, /String\(b\.resolvedAt \|\| b\.verification\.at \|\| ''\)\.localeCompare\(String\(a\.resolvedAt \|\| a\.verification\.at \|\| ''\)\)/)
  assert.match(dash, /ugList\.slice\(0, 10\)/)
  // tier=internal 收末尾（非 internal 在前 concat internal 在后）并标注「无用户可感知面」
  assert.match(dash, /ugAct\.concat\(ugInternal\)/)
  assert.ok(dash.indexOf('纯内部 · 无用户可感知面') >= 0, 'internal 末尾标注缺失')
  // 条目形态：### 标题（档位）+ 改动/自测步骤/预期
  assert.ok(dash.indexOf("'- 改动：' + ut.gist") >= 0)
  assert.ok(dash.indexOf("'- 自测步骤：'") >= 0)
  assert.ok(dash.indexOf("'- 预期：' + ut.expect") >= 0)
})

// ===== ⑤ README 双份 =====
test('⑤README 双份：根/包逐字一致 + verifier 段补指南说明 + 开关清单补 verifyUserGuide 行', () => {
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('verifyUserGuide') >= 0, 'README 开关清单缺 verifyUserGuide 行')
  assert.ok(r1.indexOf('自测指南') >= 0, 'README verifier 段缺自测指南说明')
  assert.ok(r1.indexOf('本版自测清单') >= 0, 'README 缺报告聚合段说明')
})

// ===== ⑥ 接线与产物 =====
test('⑥接线：kernel state 缺省开 + 轮询纠偏 + PoolCfgPopover prop/开关 + client.js 已重组装', () => {
  // kernel state 默认值（缺字段=开，与 host cfg 同口径）
  assert.match(kernel, /epicSplit: true, verifyUserGuide: true/)
  // 轮询权威纠偏 + 变更检测纳入开关（cfgKnobsChanged 浅比较）
  assert.match(kernel, /state\.verifyUserGuide = cfgKnobOf\(d, 'verifyUserGuide'\)/)
  assert.match(kernel, /a\.verifyUserGuide !== b\.verifyUserGuide/)
  // PoolCfgPopover prop 传递 + 「验收」小节开关（setCfg 走 set-board-config 通道，乐观更新+失败回滚既有基建复用）
  assert.match(kernel, /verifyUserGuide: vugOn/)
  assert.match(dash, /checked: props\.verifyUserGuide !== false, onChange: function \(e\) \{ setCfg\('verifyUserGuide', e\.target\.checked\) \}/)
  // 产物重组装：模块源关键标记逐一出现在 lib/client.js
  for (const m of ['📋 自测指南', '## 本版自测清单', 'verifyUserGuide', '纯内部 · 无用户可感知面', 'UI 可操作']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})
