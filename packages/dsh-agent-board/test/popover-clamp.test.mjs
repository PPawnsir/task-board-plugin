// dsh-agent-board — 弹层定位钳制纯函数单测（test/popover-clamp.test.mjs，task-mvt05utl）
// 背景：用户 2026-10-29 截图报「排版有点乱」①主修——设置弹层（PoolCfgPopover）fixed 定位统一右锚定
// （right=视口右缘-按钮右缘，内容向左延伸），按钮贴抽屉左缘（窄窗下工具栏折行，⚙/路由按钮落到第二行
// 左端）时弹层左半探出抽屉/视口被裁。修法=clampPopoverPos 纯函数统一预算锚点（两弹层共用）：
// 左溢改左锚（左缘=抽屉左缘+8）/右溢钳右（右缘=抽屉右缘-8）/正常右锚不动；zoom 各项除档还原。
// client 无渲染 harness（react 不在包依赖，渲染由 dsh web 客户端运行时注入）——与历卡同一纪律：
// 纯函数走 new Function 提取直测（window 垫片取视口口径）+ 源码级接线断言 + client.js 产物标记。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dash = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// 纯函数提取（apply 片段不可 import，历卡同款手法）：两工具相邻声明，提取窗到 ModelRoutePopover 为止
const fnSrc = dash.slice(dash.indexOf('function clampPopoverPos'), dash.indexOf('function ModelRoutePopover'))
assert.ok(fnSrc.indexOf('function popoverBounds') >= 0, '提取窗须同时含 popoverBounds（两工具相邻声明）')
assert.ok(fnSrc.indexOf('var POOL_POPOVER_W') >= 0 && fnSrc.indexOf('var ROUTE_POPOVER_W') >= 0, '提取窗须含预算宽常量')

// 浏览器全局垫片（clamp 内部读 window.innerWidth/innerHeight 取视口口径；零依赖不装 jsdom）
globalThis.window = { innerWidth: 1200, innerHeight: 800 }
const clamp = new Function(fnSrc + '\nreturn clampPopoverPos')()

// ===== 三态①：正常不动（宽抽屉、按钮居右 → 右锚定贴按钮右缘，与旧式逐字同值）=====
test('①正常：右锚定不动（top/right/maxH 与旧式同值），不误触发左锚', () => {
  var out = clamp({ bottom: 100, right: 900 }, 360, 1, { left: 280, right: 1200 })
  // 越界比较不触发：按钮右缘-预算宽 540 ≥ 抽屉左缘+8=288
  assert.equal(out.left, null, '正常态不得改左锚')
  assert.equal(out.right, Math.max(8, 1200 - 900) / 1, 'right=旧式 max(8, vw - r.right)')
  assert.equal(out.top, (100 + 4) / 1, 'top=旧式 (r.bottom + 4)')
  assert.equal(out.maxH, Math.max(140, (800 - 100 - 16) / 1), 'maxH=旧式公式')
  assert.equal(out.right != null && out.left == null, true, '右锚式恰单锚')
})

// ===== 三态②：左溢改左锚（按钮贴抽屉左缘 → 左缘=抽屉左缘+8，修截图被裁病灶）=====
test('②左溢：按钮右缘-预算宽 < 抽屉左缘+8 → 改左锚定（left=抽屉左缘+8，right 收起不双锚拉宽）', () => {
  var out = clamp({ bottom: 100, right: 340 }, 360, 1, { left: 280, right: 1200 })
  // 340-360=-20 < 288 → 左溢成立；288+360=648 ≤ 1192 → 右不溢，保持左锚
  assert.equal(out.left, 288, 'left=抽屉左缘+8（280+8）')
  assert.equal(out.right, null, '左锚态 right 收起（双锚会拉宽弹层）')
  assert.equal(out.top, 104, 'top 不受锚向影响')
  assert.equal(out.maxH, 684, 'maxH 不受锚向影响')
})

// ===== 三态③：右溢钳右（左锚后右缘仍越界 → 钳回右锚、右缘=抽屉右缘-8 兜底）=====
test('③右溢：抽屉比弹层还窄 → 钳回右锚定（右缘=抽屉右缘-8）极端兜底', () => {
  var out = clamp({ bottom: 100, right: 340 }, 360, 1, { left: 280, right: 400 })
  // 340-360=-20 < 288 → 左溢成立；288+360=648 > 400-8=392 → 右溢 → 钳右
  assert.equal(out.left, null, '右溢兜底回右锚')
  assert.equal(out.right, Math.max(8, 1200 - 392) / 1, 'right 使弹层右缘=抽屉右缘-8（1200-808=392）')
  assert.equal(1200 - out.right, 392, '可视右缘=抽屉右缘-8')
})

// ===== zoom≠1 坐标还原（/z 口径收进钳制函数，两锚向同款；×z 还原可视坐标）=====
test('④zoom：左锚 left 与右锚 right 各项除以档位还原，×z 复原可视坐标贴按钮/贴抽屉缘', () => {
  var z = 1.5
  var leftMode = clamp({ bottom: 100, right: 340 }, 360, z, { left: 280, right: 1200 })
  assert.equal(leftMode.left, 288 / z, 'left 除以档位')
  assert.equal(leftMode.left * z, 288, '×z 还原可视左缘=抽屉左缘+8')
  assert.equal(leftMode.top, (100 + 4) / z, 'top 除以档位')
  assert.equal(leftMode.right, null, 'zoom 下左锚态 right 仍收起')
  var rightMode = clamp({ bottom: 100, right: 900 }, 360, z, { left: 280, right: 1200 })
  assert.equal(rightMode.right, Math.max(8, 1200 - 900) / z, 'right 除以档位')
  assert.equal(1200 - rightMode.right * z, 900, '×z 还原可视右缘=按钮右缘（不漂移）')
  assert.equal(rightMode.maxH, Math.max(140, (800 - 100 - 16) / z), 'maxH 除以档位')
})

// ===== 接线断言（源码级）：两弹层同款 clamp + 渲染条件双锚 + 抽屉边界实测 =====
test('⑤接线：两弹层 toggle 同款 clamp 调用 + 渲染条件双锚（left 非空走左锚）+ 旧式公式退役', () => {
  assert.match(dash, /setPos\(clampPopoverPos\(r, ROUTE_POPOVER_W, z, popoverBounds\(btnRef\.current\)\)\)/, 'ModelRoutePopover 缺 clamp 接线')
  assert.match(dash, /setPos\(clampPopoverPos\(r, POOL_POPOVER_W, z, popoverBounds\(btnRef\.current\)\)\)/, 'PoolCfgPopover 缺 clamp 接线')
  // 渲染：left 非空 → left 锚定（React null style 省略），right 同理——两弹层渲染同款
  var renders = dash.match(/left: pos\.left != null \? pos\.left \+ 'px' : null, right: pos\.right != null \? pos\.right \+ 'px' : null/g) || []
  assert.ok(renders.length >= 2, '两弹层渲染须都接条件双锚（实测 ' + renders.length + ' 处）')
  // 旧式未钳 setPos 公式须已退役（防双轨残留）
  assert.ok(dash.indexOf('setPos({ top:') < 0, '旧式 setPos({ top: ... }) 须已退役')
  // 抽屉边界实测：popoverBounds 沿按钮向上找首个 position:fixed 祖先（面板根），找不到退化视口
  assert.match(dash, /getComputedStyle\(el\)\.position === 'fixed'/)
  assert.match(dash, /return \{ left: 0, right: window\.innerWidth \}/, 'popoverBounds 缺视口退化兜底')
})

// ===== 池条折行（轻症顺带，task-mvt05utl ③）=====
test('⑥池条：PoolStatus 容器加 flexWrap（窄抽屉下 Worker/Verifier 计数与模型芯片折行不挤一排）', () => {
  assert.match(dash, /fontSize: 9, color: C\.text2, display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap'/, 'PoolStatus 容器缺 flexWrap')
})

// ===== 产物重组装 =====
test('⑦产物：clamp/池条标记逐一出现在 lib/client.js（需 npm run build-client 重组装）', () => {
  for (const m of ['clampPopoverPos', 'popoverBounds', 'POOL_POPOVER_W', 'ROUTE_POPOVER_W']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})
