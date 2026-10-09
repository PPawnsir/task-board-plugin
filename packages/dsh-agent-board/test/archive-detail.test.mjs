// dsh-agent-board — 归档卡点开详情（用户 2026-10-09 指令）client 侧单测（test/archive-detail.test.mjs）
// client 无渲染 harness（react 不在包依赖，渲染由 dsh web 客户端运行时注入）——与历卡同一纪律：
// 全部走源码级断言（board-list.js / kernel.js / task-detail.js 模块源 + client.js 重组装产物）。
// 断言：
//   ① 归档行可点击进详情：ArchiveView 行挂 onClick → state.detailId = t.id（复用 detailId 机制，与看板卡同路径）；
//     恢复/历史会话按钮 stopPropagation——点「恢复待办」不误开详情
//   ② 归档 tab 分支尊重 detailId：kernel.js view==='archive' 分支 detailId 优先渲染 DetailView
//   ③ 已阅链路对归档卡生效：mark-reviewed 触发条件无 status 门禁（读 detailId，archived 同样落账）
//   ④ 产物重组装：关键接线标记出现在 lib/client.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const bl = readFileSync(new URL('../lib/client/board-list.js', import.meta.url), 'utf8')
const kernel = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
const td = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ===== ① 归档行可点击进详情 + 行内按钮不冒泡 =====
test('① 归档行可点击进详情（onClick 接线 state.detailId）+ 恢复/历史会话按钮不冒泡', () => {
  assert.match(bl, /onClick: function \(\) \{ state\.detailId = t\.id; notify\(\) \}/)
  assert.match(bl, /onClick: function \(e\) \{ e\.stopPropagation\(\); restore\(t\.id\) \}/)
  assert.match(bl, /onClick: function \(e\) \{ e\.stopPropagation\(\); if \(uiWorkspaceSvc\) uiWorkspaceSvc\.openSession\(r\.id\) \}/)
})

// ===== ② 归档 tab 分支尊重 detailId：复用 DetailView =====
test('② 归档 tab 分支尊重 detailId：复用 DetailView（与看板卡同路径）', () => {
  assert.match(kernel, /view === 'archive'\) \{ content = detailId \? React\.createElement\(DetailView\) : React\.createElement\(ArchiveView\) \}/)
})

// ===== ③ 已阅链路对归档卡生效：mark-reviewed 无 status 门禁 =====
test('③ 已阅链路对归档卡生效：mark-reviewed 触发无 status 门禁（读 detailId）', () => {
  assert.match(td, /var t = getTask\(state\.detailId\); if \(t && t\.reviewHint && t\.reviewHint\.score > 0 && !t\.reviewedAt\) \{ rpc\('mark-reviewed'/)
  // reviewPending 单一事实源含 archived（徽章随 fetchTasks 消失的口径）
  assert.match(kernel, /t\.status === 'resolved' \|\| t\.status === 'archived'/)
})

// ===== ④ 产物重组装 =====
test('④ 产物重组装：三处接线标记出现在 lib/client.js', () => {
  for (const m of ['state.detailId = t.id; notify()', 'detailId ? React.createElement(DetailView) : React.createElement(ArchiveView)', 'e.stopPropagation(); restore(t.id)']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})
