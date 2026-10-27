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
//      五档故障名（instant-kill/hang/empty/rate-limit/slow）+ 消费点行号锚；
//   ⑥ 文档与源码同口径——五档故障名逐一在 fault-provider.mjs FAULT_TYPES 常量里（源码真值），
//      dispatch.mjs 消费点符号（hasActivationApi/activationAsRun/modelDirectory/probeModel）在案，
//      文档行号锚不悬空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const doc = readFileSync(new URL('../docs/fault-injection.md', import.meta.url), 'utf8')
const dispatch = readFileSync(new URL('../lib/dispatch.mjs', import.meta.url), 'utf8')
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

test('⑤关键契约词全文在案：五档故障名 + startActivation/listProviders/session.v4.jsonl.zstd + 行号锚', () => {
  for (const n of ['instant-kill', 'hang', 'empty', 'rate-limit', 'slow']) {
    assert.ok(doc.includes(n), '文档缺五档故障名：' + n)
  }
  for (const m of ['startActivation', 'listProviders', 'session.v4.jsonl.zstd']) {
    assert.ok(doc.includes(m), '文档缺关键契约词：' + m)
  }
  for (const m of ['L806-823', 'L163-178', 'L294-332']) {
    assert.ok(doc.includes(m), '文档缺消费点行号锚：' + m)
  }
})

test('⑥文档与源码同口径：五档在 FAULT_TYPES 常量里（源码真值）+ dispatch.mjs 消费点符号在案', () => {
  const types = faultProvider.match(/var FAULT_TYPES = \[([^\]]+)\]/)
  assert.ok(types, 'fault-provider.mjs 缺 FAULT_TYPES 常量')
  for (const n of ['instant-kill', 'hang', 'empty', 'rate-limit', 'slow']) {
    assert.ok(types[1].includes("'" + n + "'"), 'FAULT_TYPES 缺五档故障名：' + n)
  }
  // 文档引用的行号锚不悬空：引用的符号在源码里逐一在案（符号级同口径）
  for (const s of ['hasActivationApi', 'activationAsRun', 'activationRequestOf', 'modelDirectory', 'probeModel', 'startActivation']) {
    assert.ok(dispatch.includes(s), 'dispatch.mjs 缺消费点符号：' + s)
  }
})
