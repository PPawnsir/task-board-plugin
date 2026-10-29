// dsh-agent-board — 故障注入文档回归：路径 B 接口预留（test/fault-injection-docs.test.mjs，task-mvqi3uj4-8）
// 采用源码级断言（readme-decompose-docs.test.mjs L13-40 读盘断言范式；client 无渲染 harness，
// 文档类卡片一律读盘断言）。被锁对象：docs/fault-injection.md（docs/ 目录首文件——拆解阶段
// 「A 起步 + B 留接口」决策的可追溯记录，供后续宿主级立项直接引用）：
//   ① 文档存在 + 三节锚点标题在案——A/B 权衡记录 / B 路径接缝契约 / 测试分层纪律；
//   ② A/B 权衡节——A=mock-ctx 故障层（调度逻辑全真、宿主假、轻、五档×六场景）vs
//      B=宿主级 mock provider 插件（全真链路、重、需宿主配合面）；首期取 A 理由 + B 触发条件
//      （漏网事故三面：事件面/持久化面/startActivation 真契约）全部落字；
//   ③ B 接缝契约节——宿主侧最小面三项（可编程 subagents provider / llm provider 枚举面 /
//      会话日志落盘布局）+ 每项的 A 层故障映射（等价注入点）契约词逐字在案；
//   ④ 测试分层纪律节——事故复盘双落纪律（单测断言锁机制 + fault-e2e-* 场景锁接缝）+
//      新事故类加卡模板指向 fault-e2e-recovery.test.mjs；
//   ⑤ 关键契约词全文在案——startActivation / listProviders / session.v4.jsonl.zstd /
//      五档故障名（instant-kill/hang/empty/rate-limit/slow）+ 消费点「文件 + 符号」锚；
//   ⑥ 文档与源码同口径——五档故障名逐一在 fault-provider.mjs FAULT_TYPES 常量里（源码真值），
//      消费点符号在案（dispatch.mjs: hasActivationApi/activationAsRun/activationRequestOf；拆分后
//      model-health.mjs: modelDirectory/probeModel），文档锚不悬空。
//   ⑦ 行号锚清扫锁（task-mvt8c1yx-8 拆分第 8 刀）：拆分令行号持续漂移，文档一律按「文件 + 函数/
//      符号名」定位——旧行号锚（L806-823/L163-178/L294-332）与任何 L<行号> 形式一律不得回潮。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const doc = readFileSync(new URL('../docs/fault-injection.md', import.meta.url), 'utf8')
const dispatch = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
const modelHealth = readFileSync(new URL('../lib/model-health.mjs', import.meta.url), 'utf8')
const faultProvider = readFileSync(new URL('./helpers/fault-provider.mjs', import.meta.url), 'utf8')

test('①文档存在 + 三节锚点标题在案（A/B 权衡记录 / B 路径接缝契约 / 测试分层纪律）', () => {
  for (const h of [
    '# 故障注入 · 路径 B 接口预留：宿主级 mock provider 插件接缝契约',
    '## 一、A/B 权衡记录（首期取 A，B 留接口）',
    '## 二、B 路径接缝契约（宿主侧最小面 + A 层故障映射）',
    '## 三、测试分层纪律（事故复盘双落）',
  ]) assert.ok(doc.includes(h), 'fault-injection.md 缺锚点标题：' + h)
})

test('②A/B 权衡节：A 层形态/首期取 A 理由 + B 层形态/触发条件（漏网事故三面）全在案', () => {
  for (const m of [
    'mock-ctx 故障层',            // A 形态
    '宿主级 mock provider 插件',  // B 形态
    '调度逻辑全真',               // A 全真面
    '宿主假',                     // A 假面
    '五档故障模式',               // 五档
    '六场景',                     // 首期场景面
    '首期取 A 的理由',
    'B 的触发条件（何时必须上 B）',
    '漏网事故',
    'agent/status 事件面事故',    // 触发面 (a)
    '会话持久化面事故',           // 触发面 (b)
    'startActivation 真契约偏差', // 触发面 (c)
    '互不替代',                   // 两套关系口径
  ]) assert.ok(doc.includes(m), 'A/B 权衡节缺锚点：' + m)
})

test('③B 接缝契约节：宿主侧最小面三项 + A 层故障映射（等价注入点）契约词全在案', () => {
  for (const m of [
    '可编程 subagents provider',  // 面 1
    'llm provider 枚举面',        // 面 2
    '会话日志落盘布局',           // 面 3
    'startActivation',            // 探测/消费点
    "delivery: 'parent'",         // continuable 结算语义
    "delivery='caller'",          // 一次性语义
    'childId',                    // 子会话 id 语义
    'activationAsRun',            // 旧 run 形状适配
    'activationRequestOf',        // 新契约 request 组装
    'listProviders',              // 枚举面
    'listModels',
    'llm.stream',                 // stream 消费点
    'probeModel',
    'modelDirectory',             // 目录闸数据源
    'session.v4.jsonl.zstd',      // 日志布局
    'findRunLog',
    'installFaults',              // A 层注入点
    'synthActivation',
    'faultLlm',
    'writeFaultLog',
    'writeChildLog',
    '等价注入点',                 // A 层映射口径
  ]) assert.ok(doc.includes(m), 'B 接缝契约节缺契约词：' + m)
})

test('④测试分层纪律节：事故复盘双落纪律 + 新事故类加卡模板指向 fault-e2e-recovery.test.mjs', () => {
  for (const m of [
    '双落纪律',
    '单测断言锁机制',
    'fault-e2e-* 场景锁接缝',
    'fault-e2e-circuit.test.mjs',       // 现有秒拆熔断面
    'fault-e2e-hung.test.mjs',          // 现有挂死判死面
    'fault-e2e-recovery.test.mjs',      // 新事故类加卡模板指向
    '新事故类加卡模板',
  ]) assert.ok(doc.includes(m), '测试分层纪律节缺锚点：' + m)
})

test('⑤关键契约词全文在案：五档故障名 + startActivation/listProviders/session.v4.jsonl.zstd + 符号锚', () => {
  for (const n of ['instant-kill', 'hang', 'empty', 'rate-limit', 'slow']) {
    assert.ok(doc.includes(n), '文档缺五档故障名：' + n)
  }
  for (const m of ['startActivation', 'listProviders', 'session.v4.jsonl.zstd']) {
    assert.ok(doc.includes(m), '文档缺关键契约词：' + m)
  }
  // 消费点锚一律「文件 + 函数/符号名」口径（task-mvt8c1yx-8）：拆分后行号必漂，符号不漂。
  for (const m of ['lib/dispatch.mjs', 'lib/model-health.mjs', 'spawnOneShot', 'hasActivationApi',
    'activationAsRun', 'activationRequestOf', 'modelDirectory()', 'probeModel()']) {
    assert.ok(doc.includes(m), '文档缺消费点符号锚：' + m)
  }
  for (const dead of ['L806-823', 'L163-178', 'L294-332']) {
    assert.ok(!doc.includes(dead), '文档残留旧行号锚（拆分后已漂移，按符号定位）：' + dead)
  }
  assert.ok(!/L\d{2,4}/.test(doc), '文档不得再出现 L<行号> 形式锚点（历次拆分会令其漂移）')
})

test('⑦行号锚清扫：lib/ 与 docs/ 不再有指向 dispatch.mjs 的 L<行号> 锚（预研清单语法说明除外）', () => {
  assert.ok(!/dispatch\.mjs[^\n]*L\d/.test(doc), 'fault-injection.md 残留 dispatch.mjs 行号锚')
  assert.ok(!/dispatch[^\n]*\s\d{3}\b/.test(doc), 'fault-injection.md 残留「dispatch <行号>」式锚')
})

test('⑥文档与源码同口径：五档在 FAULT_TYPES 常量里（源码真值）+ dispatch.mjs 消费点符号在案', () => {
  const types = faultProvider.match(/var FAULT_TYPES = \[([^\]]+)\]/)
  assert.ok(types, 'fault-provider.mjs 缺 FAULT_TYPES 常量')
  for (const n of ['instant-kill', 'hang', 'empty', 'rate-limit', 'slow']) {
    assert.ok(types[1].includes("'" + n + "'"), 'FAULT_TYPES 缺五档故障名：' + n)
  }
  // 文档引用的消费点符号不悬空（符号级同口径）：spawn/activation 面仍在 dispatch.mjs，
  // 模型目录/探测面已拆至 lib/model-health.mjs（第 2/4 刀）——文档锚指到新文件，此处回源码复检。
  for (const s of ['hasActivationApi', 'activationAsRun', 'activationRequestOf', 'startActivation']) {
    assert.ok(dispatch.includes(s), 'dispatch.mjs 缺消费点符号：' + s)
  }
  for (const s of ['function modelDirectory', 'function probeModel']) {
    assert.ok(modelHealth.includes(s), 'lib/model-health.mjs 缺消费点符号：' + s)
  }
})
