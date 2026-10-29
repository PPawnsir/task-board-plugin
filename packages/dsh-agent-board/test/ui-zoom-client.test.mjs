// dsh-agent-board — 界面缩放档位 client 侧单测（test/ui-zoom-client.test.mjs，task-mv58e01j）
// 背景：用户 2026-10-12 反馈「字体整体偏小」；面板 ~317 处内联 fontSize px 写死，逐处改不值 →
// 定稿方案=面板根容器 CSS zoom 等比缩放（Chromium 支持，字体/图标/间距一并放大，只影响本面板）。
// client 无渲染 harness（react 不在包依赖，渲染由 dsh web 客户端运行时注入）——与历卡同一纪律：
// 全部走源码级断言（kernel.js / dashboard.js 模块源 + client.js 重组装产物 + README 双份同步）。
//   ① 状态与持久化——state.uiZoom（localStorage 键 dsh-agent-board-ui-zoom，白名单五档，脏值/异常回退 1）
//   ② 根容器接线——TopPanel 顶层 div style 挂 zoom: uiZoom（订阅值，notify 即时生效）
//   ③ 设置弹层档位——⚙ 弹层「界面」小节 ZoomCfg 下拉：90/100/110/125/150%，选中即 setItem+state+notify
//   ④ 弹层坐标补偿——/z 口径收进 clampPopoverPos 统一锚点（左溢改左锚/右溢钳右），zoom=1 时右锚式与旧行为同值
//   ⑤ README 双份——根/包逐字一致 + 看板 UI 区补「界面缩放」说明行
//   ⑥ 产物重组装——关键标记逐一出现在 lib/client.js（需 npm run build-client）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const kernel = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
const dash = readFileSync(new URL('../lib/client/dashboard.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ===== ① 状态与持久化（kernel state + localStorage 读取，缺省 1，白名单校验）=====
test('①状态：UI_ZOOM_KEY/UI_ZOOM_LEVELS 常量 + readUiZoom 白名单回退 + state.uiZoom 初始化', () => {
  assert.ok(kernel.indexOf("var UI_ZOOM_KEY = 'dsh-agent-board-ui-zoom'") >= 0, '缺 localStorage 键常量')
  assert.match(kernel, /var UI_ZOOM_LEVELS = \[0\.9, 1, 1\.1, 1\.25, 1\.5\]/, '缺五档白名单（90/100/110/125/150%）')
  // 读取：parseFloat + 白名单命中才采纳，脏值/异常一律回退 1
  assert.match(kernel, /function readUiZoom\(\) \{ try \{ var v = parseFloat\(localStorage\.getItem\(UI_ZOOM_KEY\)\); return UI_ZOOM_LEVELS\.indexOf\(v\) >= 0 \? v : 1 \} catch \(_\) \{ return 1 \} \}/)
  // state 字段初始化（读 localStorage，不开口在 host）
  assert.match(kernel, /verifyUserGuide: true, uiZoom: readUiZoom\(\)/)
})

// ===== ② 根容器接线（TopPanel 顶层 div style.zoom + 订阅链）=====
test('②接线：TopPanel 订阅 uiZoom（useState + update 链）+ 根容器 style 挂 zoom', () => {
  // 订阅：useState 初值读 state.uiZoom，update 链里 setUiZoom(state.uiZoom)（notify 即时生效的渲染通路）
  assert.match(kernel, /useState\(state\.uiZoom\), uiZoom = _uzm\[0\], setUiZoom = _uzm\[1\]/)
  assert.match(kernel, /setCrd\(state\.cleanupRetentionDays\); setUiZoom\(state\.uiZoom\)/)
  // 根容器（面板顶层 fixed div）style 挂 zoom——只此一行接管全面板缩放，不动任何既有 fontSize
  assert.match(kernel, /zIndex: 900, zoom: uiZoom, background: C\.bg/)
})

// ===== ③ 设置弹层档位（⚙ 弹层「界面」小节 ZoomCfg 下拉，选中即持久化+生效）=====
test('③档位：ZoomCfg 下拉五档 + 选中即 localStorage.setItem + state.uiZoom + notify + 弹层「界面」小节挂载', () => {
  assert.match(dash, /function ZoomCfg\(\)/, '缺 ZoomCfg 组件')
  // 五档选项由白名单渲染，默认档标注
  assert.match(dash, /UI_ZOOM_LEVELS\.map\(function \(z\) \{ return React\.createElement\('option', \{ key: String\(z\), value: String\(z\) \}, Math\.round\(z \* 100\) \+ '%' \+ \(z === 1 \? '（默认）' : ''\)\) \}/)
  // 选中口径：非法档位不采纳 → 写 state → localStorage 持久化 → notify 即时生效
  assert.match(dash, /if \(UI_ZOOM_LEVELS\.indexOf\(n\) < 0\) return/)
  assert.match(dash, /state\.uiZoom = n/)
  assert.match(dash, /localStorage\.setItem\(UI_ZOOM_KEY, String\(n\)\)/)
  // 弹层「界面」小节挂载 ZoomCfg（存储清理之后、弹层收尾之前）
  assert.match(dash, /'界面'\),\s*React\.createElement\('div', \{ style: \{ display: 'flex', gap: 8, alignItems: 'center' \} \},\s*React\.createElement\(ZoomCfg, null\)/)
  assert.ok(dash.indexOf('界面缩放') >= 0, '弹层缺「界面缩放」标签')
})

// ===== ④ 弹层坐标补偿 + 钳制接线（task-mvt05utl：/z 口径收进 clampPopoverPos 统一锚点）=====
test('④补偿：两弹层 toggle 走 clampPopoverPos（/z 还原在钳制函数内统一，左溢改左锚），zoom=1 时右锚式与旧行为同值', () => {
  assert.match(dash, /var z = state\.uiZoom \|\| 1/)
  // 锚点统一（task-mvt05utl）：两弹层同款 clamp 调用（预算宽常量 + popoverBounds 实测抽屉边界）
  assert.match(dash, /setPos\(clampPopoverPos\(r, ROUTE_POPOVER_W, z, popoverBounds\(btnRef\.current\)\)\)/)
  assert.match(dash, /setPos\(clampPopoverPos\(r, POOL_POPOVER_W, z, popoverBounds\(btnRef\.current\)\)\)/)
  // /z 口径仍在（收进钳制函数）：top 与 right 各项除以档位还原 CSS px
  assert.match(dash, /var top = \(r\.bottom \+ 4\) \/ zz/)
  assert.match(dash, /var right = Math\.max\(m, window\.innerWidth - r\.right\) \/ zz/)
  // maxHeight 改读补偿后的 pos.maxH（不再用未补偿的 calc(100vh - ...)）
  assert.match(dash, /maxHeight: \(pos\.maxH \|\| 300\) \+ 'px'/)
})

// ===== ⑤ README 双份 =====
test('⑤README 双份：根/包逐字一致 + 看板 UI 区补「界面缩放」说明行（档位/键名/即时生效）', () => {
  const r1 = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  const r2 = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(r1, r2, 'README 双份必须逐字一致（npm run sync-readme）')
  assert.ok(r1.indexOf('界面缩放') >= 0, 'README 缺「界面缩放」说明行')
  assert.ok(r1.indexOf('dsh-agent-board-ui-zoom') >= 0, 'README 说明行缺 localStorage 键名')
  assert.ok(r1.indexOf('90% / 100%（默认）/ 110% / 125% / 150%') >= 0, 'README 说明行缺五档清单')
})

// ===== ⑥ 产物重组装 =====
test('⑥产物：模块源关键标记逐一出现在 lib/client.js（需 npm run build-client 重组装）', () => {
  for (const m of ['dsh-agent-board-ui-zoom', 'UI_ZOOM_LEVELS', 'readUiZoom', 'zoom: uiZoom', 'ZoomCfg', '界面缩放']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})
