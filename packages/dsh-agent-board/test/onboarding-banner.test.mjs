// dsh-agent-board — 首用引导横幅 client 侧单测（test/onboarding-banner.test.mjs，task-mvmttnux）
// 背景：反馈 n-muygxqc7045b（看板 UX 巡检 2026-10-08：全程无首用引导）的最低成本方案——
// 板视图 content 内「提示：拖拽卡片」行之前插一行可关闭定位引导：定位语 + 「？」链 README + ✕ 关闭
// （localStorage 键 dsh-agent-board-onboard-dismissed 持久化，同 uiZoom 纯客户端偏好模式，不走 host 配置）。
// 仅 presentation 层，不涉派发逻辑；独立于空态 CTA 行，不动空态统一决策（六列骨架照常）。
// client 无渲染 harness（react 不在包依赖）——与历卡同一纪律：全部走源码级断言
//（kernel.js 模块源 + client.js 重组装产物）。
//   ① 文案——定位语字面量存在于板视图 content 组装（提示行之前）
//   ② 持久化——ONBOARD_DISMISS_KEY 键名常量 + readOnboardDismissed 读取（异常回退未关闭）
//   ③ dismiss——✕ 处理器 localStorage.setItem 写键 + state.onboardDismissed + notify 重渲染
//   ④ 「？」链接——README URL + target=_blank + rel=noopener
//   ⑤ 订阅链——state.onboardDismissed 初始化 + useState 订阅 + update 链（notify 即时生效）
//   ⑥ 产物重组装——关键标记逐一出现在 lib/client.js（需 npm run build-client）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const kernel = readFileSync(new URL('../lib/client/kernel.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ===== ① 文案：定位语字面量存在于板视图 content 组装，且挂在提示行之前 =====
test('①文案：定位语「看板 = 把任务交给后台 Worker 执行、Verifier 独立验收的任务板」存在于提示行之前', () => {
  const bannerAt = kernel.indexOf('看板 = 把任务交给后台 Worker 执行、Verifier 独立验收的任务板')
  assert.ok(bannerAt >= 0, '缺横幅定位语字面量')
  const hintAt = kernel.indexOf('提示：拖拽卡片到目标列即可流转状态')
  assert.ok(hintAt >= 0, '缺既有提示行（挂载点丢失？）')
  assert.ok(bannerAt < hintAt, '横幅必须渲染在「提示：拖拽卡片」行之前')
  // 仅未 dismiss 时渲染（obd 条件守卫）
  assert.match(kernel, /obd \? null : React\.createElement\('div', \{ style: \{ fontSize: 10, color: C\.text2, marginBottom: 6, display: 'flex'/)
})

// ===== ② 持久化：localStorage 键名常量 + 读取函数（异常/未写回退未关闭）=====
test('②持久化：ONBOARD_DISMISS_KEY 键名 + readOnboardDismissed 读取（异常回退 false）', () => {
  assert.ok(kernel.indexOf("var ONBOARD_DISMISS_KEY = 'dsh-agent-board-onboard-dismissed'") >= 0, '缺 localStorage 键常量')
  assert.match(kernel, /function readOnboardDismissed\(\) \{ try \{ return localStorage\.getItem\(ONBOARD_DISMISS_KEY\) === '1' \} catch \(_\) \{ return false \} \}/)
})

// ===== ③ dismiss：✕ 处理器写键 + state + notify 重渲染 =====
test('③dismiss：✕ onClick 写 localStorage 键 + state.onboardDismissed=true + notify()', () => {
  assert.match(kernel, /localStorage\.setItem\(ONBOARD_DISMISS_KEY, '1'\)/, '✕ 处理器缺 localStorage 写键')
  assert.match(kernel, /state\.onboardDismissed = true; notify\(\)/, '✕ 处理器缺 state 更新 + notify 重渲染')
})

// ===== ④ 「？」链接：README URL + target=_blank + rel=noopener =====
test('④链接：「？」链 https://github.com/PPawnsir/task-board-plugin#readme（target=_blank rel=noopener）', () => {
  assert.ok(kernel.indexOf("href: 'https://github.com/PPawnsir/task-board-plugin#readme'") >= 0, '缺 README 链接 URL')
  assert.match(kernel, /target: '_blank', rel: 'noopener'/, '链接缺 target=_blank rel=noopener')
})

// ===== ⑤ 订阅链：state 初始化 + useState 订阅 + update 链 =====
test('⑤订阅：state.onboardDismissed 初始化 + TopPanel useState 订阅 + update 链 setObd', () => {
  assert.match(kernel, /uiZoom: readUiZoom\(\), onboardDismissed: readOnboardDismissed\(\)/, 'state 缺 onboardDismissed 初始化')
  assert.match(kernel, /useState\(state\.onboardDismissed\), obd = _obd\[0\], setObd = _obd\[1\]/, '缺 useState 订阅')
  assert.match(kernel, /setUiZoom\(state\.uiZoom\); setObd\(state\.onboardDismissed\)/, 'update 链缺 setObd')
})

// ===== ⑥ 产物重组装 =====
test('⑥产物：模块源关键标记逐一出现在 lib/client.js（需 npm run build-client 重组装）', () => {
  for (const m of ['dsh-agent-board-onboard-dismissed', 'ONBOARD_DISMISS_KEY', 'readOnboardDismissed', '看板 = 把任务交给后台 Worker 执行、Verifier 独立验收的任务板', 'onboardDismissed']) {
    assert.ok(built.indexOf(m) >= 0, 'client.js 缺标记：' + m + '（需 npm run build-client 重组装）')
  }
})
