// dsh-agent-board — README 拆解官 / 力度路由文档回归（test/readme-decompose-docs.test.mjs，task-mvnnkv7x-1）
// 采用源码级断言（同 user-guide-client.test.mjs ⑤ 范式；client 无渲染 harness，文档类卡片一律读盘断言）：
//   ① README 双份逐字一致——根 README 是唯一手写源，包内那份由 npm run sync-readme 生成，禁止手改；
//   ② 拆解官工作流指南——何时拆 / draft-pending 门禁 / outputSchema 提案契约 / host 物化 draft 子卡 /
//      逐张 publish / 幂等重拆语义，全部落字；
//   ③ 力度路由使用指南——调档（task_update size）/ 配表（⚙️ 力度路由 6 下拉 + laneModels 部分合并）/
//      四级取模链 / modelSource 留档审计 / 按档位记分；
//   ④ 工具表「16 个 Agent 工具」——任务管理 9 + 需求拆解 1 + 调研上下文 1 + 池治理 3 + 子代理上报 2，
//      旧「14 个」字样清零；
//   ⑤ 文档与源码同口径——rpc.mjs 实际注册 16 工具（表内集合与注册集合相等）+ policy.mjs 上限常量 8；
//   ⑥ 全文工具数一致——任何「N 个 Agent 工具」措辞都必须为 16（工具表标题 + 仓库结构表 rpc.mjs 行同口径，
//      根/包双份都锁；旧 13/14/15 计数全文清零）。本卡主题内的工具数纠错不得只改标题漏结构表。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const rootReadme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
const pkgReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const rpc = readFileSync(new URL('../lib/rpc.mjs', import.meta.url), 'utf8')
const policy = readFileSync(new URL('../lib/policy.mjs', import.meta.url), 'utf8')

test('①README 双份逐字一致（根 = 包，sync-readme 生成）', () => {
  assert.equal(rootReadme, pkgReadme, 'README 双份必须逐字一致（npm run sync-readme）')
})

test('②拆解官工作流指南：适用场景 + 门禁 + 提案契约 + 物化 draft + 逐张 publish + 幂等重拆', () => {
  for (const m of [
    '#### 拆解官工作流',
    '需求卡 → 实现侧子卡',
    'task_decompose',
    'draft/pending',          // 源卡门禁
    'outputSchema',           // 提案强箍
    '8 张',                   // children 上限
    'DECOMPOSE_MAX_CHILDREN', // 上限常量同源
    'publish=true',           // 物化后逐张发布
    '幂等重拆',               // 重拆清旧批
    'proposalOf',             // 提案子卡归属
    'verdict=keep',           // 不拆分支
    '拆解提案',               // 源卡消息 / 通知
    '不占 Worker 位',         // 并发位口径
    'TEAM_DECOMPOSE_FLOW',    // 与 Team 第 9 条工作流同源
  ]) assert.ok(rootReadme.includes(m), 'README 拆解官指南缺锚点：' + m)
  // 两条关键纪律必须写清（防误解：拆完源卡自动关 / 拆解官能建卡）
  assert.ok(rootReadme.includes('源卡状态不变'), '缺「源卡状态不变」口径')
  assert.ok(rootReadme.includes('零建卡工具'), '缺「拆解官零建卡工具」口径')
})

test('③力度路由使用指南：调档 / 配表 / 四级取模链 / modelSource 留档审计 / 按档位记分', () => {
  for (const m of [
    '#### 力度路由使用指南',
    'laneModels',
    'set-board-config',
    '部分合并',                 // 只合显式槽位
    '共 6 个模型下拉',          // ⚙️ 弹层三档 × 双角色
    '取模链四级',
    '卡级 `model` 特例',
    'modelSource',              // 命中跳留档审计
    'configLog',                // 写入审计行
    '按档位',                   // 记分卡小表
  ]) assert.ok(rootReadme.includes(m), 'README 力度路由指南缺锚点：' + m)
  // 调档入口写死在对话 task_update size（GUI 只读）
  assert.match(rootReadme, /task_update taskId=\.\.\. size='heavy'/)
  // 取模链四跳顺序：卡级特例 → 档位 lane → 板级行 → 父模型
  assert.match(rootReadme, /卡级 `model` 特例[\s\S]*档位 lane 槽[\s\S]*板级 `workerModel` \/ `verifierModel`[\s\S]*父模型/)
})

test('④工具表：标题「16 个 Agent 工具」+ 表内恰好 16 个工具（含两个新工具）+ 旧 14 字样清零', () => {
  assert.ok(rootReadme.includes('## 16 个 Agent 工具'), '工具表标题须为「16 个 Agent 工具」')
  assert.ok(!rootReadme.includes('14 个 Agent 工具'), '不得残留「14 个 Agent 工具」旧标题')
  const section = rootReadme.split('## 16 个 Agent 工具')[1].split('\n## ')[0]
  const listed = [...new Set((section.match(/`(?:task|board)_[a-z_]+`/g) || []).map((s) => s.slice(1, -1)))]
  assert.equal(listed.length, 16, '工具表应恰收 16 个工具，实际 ' + listed.length + '：' + listed.join('、'))
  for (const n of ['task_decompose', 'task_preview_context']) {
    assert.ok(listed.includes(n), '工具表缺新工具：' + n)
  }
  // 新工具说明行点明各自语义（拆解官 = 提案物化不建卡；预览 = 不建卡不派发）
  assert.ok(section.includes('拆解官'), '工具表说明缺拆解官语义')
  assert.ok(section.includes('预演调研注入清单'), '工具表说明缺 task_preview_context 语义')
  assert.ok(section.includes('不建卡'), '工具表说明缺「不建卡」边界')
})

test('⑤文档与源码同口径：rpc.mjs 注册 16 工具（集合相等）+ 拆解官上限 8 张', () => {
  const registered = [...new Set((rpc.match(/name: '(?:task|board)_[a-z_]+'/g) || []).map((s) => s.slice(7, -1)))]
  assert.equal(registered.length, 16, 'rpc.mjs 注册工具数应为 16，实际：' + registered.join('、'))
  const section = rootReadme.split('## 16 个 Agent 工具')[1].split('\n## ')[0]
  const listed = [...new Set((section.match(/`(?:task|board)_[a-z_]+`/g) || []).map((s) => s.slice(1, -1)))]
  assert.deepEqual(listed.slice().sort(), registered.slice().sort(), 'README 工具表与 rpc.mjs 注册集合必须相等')
  assert.match(policy, /DECOMPOSE_MAX_CHILDREN = 8/)
  assert.ok(policy.includes('buildDecomposerPrompt'), 'policy.mjs 缺拆解官 prompt 契约')
})

test('⑥全文工具数一致：任何「N 个 Agent 工具」措辞都必须是 16（标题 + 仓库结构表同口径，根/包双份）', () => {
  // 全文扫描而非只扫工具表标题——仓库结构表里「RPC 路由 + N 个 Agent 工具注册」曾漏改成 13，
  // 只断言「14 个标题消失」会把这类陈旧计数放过去。
  const counts = [...rootReadme.matchAll(/(\d+)\s*个 Agent 工具/g)].map((m) => m[1])
  assert.ok(counts.length >= 2, '全文应至少两处工具数措辞（工具表标题 + 仓库结构表 rpc.mjs 行），实际 ' + counts.length)
  for (const n of counts) {
    assert.equal(n, '16', 'README 残留陈旧工具数：「' + n + ' 个 Agent 工具」')
  }
  for (const stale of ['13 个 Agent 工具', '14 个 Agent 工具', '15 个 Agent 工具']) {
    assert.ok(!rootReadme.includes(stale), '不得残留「' + stale + '」')
  }
  // 结构表 rpc.mjs 行显式锁死（与「## 16 个 Agent 工具」表同为工具数事实源）
  assert.match(
    rootReadme,
    /`rpc\.mjs`\s*\|\s*接口层\s*\|\s*RPC 路由 \+ 16 个 Agent 工具注册/,
    '仓库结构表 rpc.mjs 行须写「RPC 路由 + 16 个 Agent 工具注册」',
  )
  // 包内那份由 sync-readme 生成，工具数必须与根一致（未同步会在这里红）
  const pkgCounts = [...pkgReadme.matchAll(/(\d+)\s*个 Agent 工具/g)].map((m) => m[1])
  assert.deepEqual(pkgCounts, counts, '包 README 工具数与根 README 不一致（先跑 npm run sync-readme）')
})
