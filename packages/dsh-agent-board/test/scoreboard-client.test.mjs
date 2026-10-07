// dsh-agent-board — 记分卡卡3 client 模型表现区单测（test/scoreboard-client.test.mjs，task-muxhtgi2）
// client 无渲染 harness（react 不在包依赖，渲染由 dsh web 客户端运行时注入）——与历卡同一纪律：
// 全部走源码级断言（dashboard.js 模块源 + client.js 重组装产物 + README 双份同步）。
//   ① 表格渲染——ModelPerf 组件 + 区根锚 id + 七列列头逐字（各带 title 口径说明）+ 行键=模型×角色×规模段
//   ② 筛选器本地过滤——角色/规模段两组 chip + buckets 本地 filter；组件体内无 rpc(/fetchTasks(（不重拉）
//   ③ 样本不足灰显——insufficient 行 opacity 灰显 + title 前缀「样本 <5，仅供参考」
//   ④ 空态——无数据「暂无足够 run 数据」（锚 id 照挂）；筛选空「当前筛选无匹配桶」
//   ⑤ 锚链接——Token 区 caption「→ 模型表现」→ getElementById('tskb-model-perf') + scrollIntoView
//   ⑥ 接线与产物——Dashboard 在 TokenUsage 正下方挂载 ModelPerf；client.js 已重组装；README 双份同步
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// 组件体切片（function <name> 到下一区段 banner 或下一顶级 function，二者取先），供「不重拉」负断言限定范围
function sliceFn(s, name) {
  const i = s.indexOf('function ' + name + '(')
  assert.ok(i >= 0, name + ' 必须存在')
  const jBanner = s.indexOf('\n    // =====', i + 1)
  const jFn = s.indexOf('\n    function ', i + 1)
  const j = [jBanner, jFn].filter(function (x) { return x > i }).sort(function (a, b) { return a - b })[0]
  return s.slice(i, j || undefined)
}

// ===== ① 七指标表格渲染 =====
test('卡3①：表格——组件/锚 id/七列列头带 title 口径/行键=模型×角色×规模段', () => {
  assert.match(src, /function ModelPerf\(props\)/)
  assert.match(src, /id: 'tskb-model-perf'/)
  // 七列列名逐字（与任务描述同序）：有效均值/耗时中位/驳回率/一次通过率/超时率/续跑率/缓存命中率
  const labels = ['有效均值', '耗时中位', '驳回率', '一次通过率', '超时率', '续跑率', '缓存命中率']
  for (const lb of labels) assert.ok(src.indexOf("label: '" + lb + "'") >= 0, '缺七列列头：' + lb)
  assert.equal(MP_COLS_count(src), 7, 'MP_COLS 必须恰好七列')
  // 表头列名带 title 口径说明（th 挂 c.title，cursor:help 提示可悬浮）
  assert.match(src, /React\.createElement\('th', \{ key: c\.k, style: thR, title: c\.title \}, c\.label\)/)
  // 行 = 模型×场景桶：行键 model|role|size；场景列 角色·规模段（小/中/大）
  assert.match(src, /key: b\.model \+ '\|' \+ b\.role \+ '\|' \+ b\.size/)
  assert.match(src, /b\.role \+ '·' \+ \(MP_SIZE_LABEL\[b\.size\] \|\| b\.size\)/)
  assert.match(src, /var MP_SIZE_LABEL = \{ small: '小', medium: '中', large: '大' \}/)
})
function MP_COLS_count(s) {
  const i = s.indexOf('var MP_COLS = [')
  const j = s.indexOf(']', i)
  return (s.slice(i, j).match(/label: '/g) || []).length
}

// ===== ② 场景筛选器本地过滤（不重拉）=====
test('卡3②：筛选器——角色/规模段两组 chip 本地过滤；组件零 rpc/fetchTasks（不重拉）', () => {
  const body = sliceFn(src, 'ModelPerf')
  // 角色：全部/worker/verifier；规模段：全部/小/中/大
  assert.match(body, /chip\(roleF, pickRole, '', '全部'\)/)
  assert.match(body, /chip\(roleF, pickRole, 'worker', 'worker'\)/)
  assert.match(body, /chip\(roleF, pickRole, 'verifier', 'verifier'\)/)
  assert.match(body, /chip\(sizeF, pickSize, '', '全部'\)/)
  assert.match(body, /chip\(sizeF, pickSize, 'small', '小'\)/)
  assert.match(body, /chip\(sizeF, pickSize, 'medium', '中'\)/)
  assert.match(body, /chip\(sizeF, pickSize, 'large', '大'\)/)
  // 本地过滤本体：buckets.filter 按 role/size（scoreboard 已随 get-tasks 响应就位，筛选只是数组 pass）
  assert.match(body, /buckets\.filter\(function \(b\) \{ return \(!roleF \|\| b\.role === roleF\) && \(!sizeF \|\| b\.size === sizeF\) \}\)/)
  // 不重拉硬断言：组件体内不得出现 rpc( / fetchTasks(
  assert.ok(!/\brpc\(/.test(body), 'ModelPerf 不得自持 rpc（不重拉）')
  assert.ok(!/fetchTasks\(/.test(body), 'ModelPerf 不得触发重拉')
})

// ===== ③ 样本不足灰显 =====
test('卡3③：样本护栏——insufficient 行 opacity 灰显 + title 前缀「样本 <5，仅供参考」', () => {
  assert.match(src, /opacity: b\.insufficient \? 0\.45 : 1/)
  assert.match(src, /b\.insufficient \? '样本 <5，仅供参考——' : ''/)
  // 筛选计数行同步亮「N 桶样本不足」
  assert.match(src, /insufN \? ' · ' \+ insufN \+ ' 桶样本不足' : ''/)
})

// ===== ④ 空态 =====
test('卡3④：空态——无数据「暂无足够 run 数据」（锚 id 照挂）；筛选空「当前筛选无匹配桶」', () => {
  assert.ok(src.indexOf('暂无足够 run 数据') >= 0)
  assert.match(src, /if \(!buckets\.length\) return React\.createElement\('div', \{ id: 'tskb-model-perf'/)
  assert.ok(src.indexOf('当前筛选无匹配桶') >= 0)
})

// ===== ⑤ Token 区锚链接 =====
test('卡3⑤：锚链接——Token 区 caption「→ 模型表现」→ getElementById + scrollIntoView', () => {
  assert.ok(src.indexOf('→ 模型表现') >= 0)
  assert.match(src, /document\.getElementById\('tskb-model-perf'\)/)
  assert.match(src, /el\.scrollIntoView\(\{ block: 'start' \}\)/)
})

// ===== ⑥ 接线与产物 =====
test('卡3⑥：接线——Dashboard 挂载在 TokenUsage 正下方；scoreboard 取 usageSummary.scoreboard；产物已重组装；README 双份同步', () => {
  const iTok = src.indexOf("React.createElement(TokenUsage, { usage: state.usageSummary })")
  const iMp = src.indexOf("React.createElement(ModelPerf, { sb: (state.usageSummary && state.usageSummary.scoreboard) || null })")
  assert.ok(iTok >= 0, 'TokenUsage 挂载点必须存在')
  assert.ok(iMp > iTok, 'ModelPerf 必须挂在 TokenUsage 正下方')
  // 产物重组装：模块源关键标记逐一出现在 lib/client.js
  for (const m of ['function ModelPerf(props)', 'tskb-model-perf', '样本 <5，仅供参考', '暂无足够 run 数据', '当前筛选无匹配桶', '→ 模型表现', 'var MP_COLS = [']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
  // kernel state 默认值（筛选档位跨渲染保持，与 rfOpen 同例）
  const ksrc = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
  assert.match(ksrc, /mpRole: '', mpSize: ''/)
  // README 双份：根 README 与包 README 逐字一致 + 含「模型表现」区说明
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('模型表现') >= 0, 'README 仪表盘段缺「模型表现」区说明')
})
