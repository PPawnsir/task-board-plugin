// 详情页流程展示/实时编辑回归（task-mwqu2mmq）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRpc } from '../lib/rpc.mjs'

const FULL_SID = 'session-test-0000-0000-000000000000'
function mkHandlers(board) {
  const state = { handlers: {}, teamModeCache: {}, feedbackCache: {}, epicSplitCache: {} }
  const tools = {}
  const ctx = { tools: { register(t) { tools[t.name] = t } }, effect() {}, webServer: { register() { return () => {} } } }
  createRpc(ctx, state, {
    getActorId: () => 'tester', resolveRoot: x => x,
    toolSessionId: () => FULL_SID, rpcSessionId: () => FULL_SID,
    rootForSession: () => null, deriveWorkMode: () => 'solo',
    runsFor: () => ({ v: { id: 'verifier-live', role: 'verifier', settled: false } }),
    rt: async () => board, mutateLocked: (sid, fn) => fn(board),
    maybeNotify: () => {}, notifyTaskDone: () => {},
    spawnOneShot: () => {}, accumulateRunUsage: () => {}, readContextPack: async () => null,
    pushSysNote: () => {}, sessionCwd: () => '',
  })
  return state.handlers
}

test('RPC 行为：验证中改 work 不自动完成；人工 force 验收后才 resolved（活跃 Verifier 需 force）', async () => {
  const task = { id: 'v', title: '待验收', status: 'verifying', pipeline: 'full', dependsOn: [], history: [], messages: [] }
  const board = { version: 11, ownerSession: FULL_SID, boardMode: 'auto', tasks: [task] }
  const h = mkHandlers(board)
  const updated = await h['update-task']({ taskId: 'v', pipeline: 'work' })
  assert.equal(updated.ok, true)
  assert.equal(task.pipeline, 'work')
  assert.equal(task.status, 'verifying', '仅改流程字段时不擅自改变当前状态')
  const blocked = await h['verify-task']({ taskId: 'v', verdict: 'approved' })
  assert.equal(blocked.ok, false, '活跃 Verifier 未 force 时仍拦截')
  const approved = await h['verify-task']({ taskId: 'v', verdict: 'approved', comment: '主窗口手动跳过', force: true })
  assert.equal(approved.ok, true)
  assert.equal(task.status, 'resolved')
  assert.equal(task.verifiedBy, 'tester')
})

const src = readFileSync(new URL('../lib/client/task-detail.js', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

for (const [name, text] of [['模块源', src], ['组装产物', built]]) {
  test(`${name}：详情有流程下拉，三档选项实时走 update-task`, () => {
    assert.match(text, /function PipelineEditor\(props\)/)
    assert.match(text, /React\.createElement\(PipelineEditor, \{ key: task\.id \+ '\|pipeline', task: task \}\)/)
    assert.match(text, /value: 'full' \}, '全流程（执行\+验收）'/)
    assert.match(text, /value: 'work' \}, '免验证（只做不验）'/)
    assert.match(text, /value: 'direct' \}, '主窗口处理'/)
    assert.match(text, /rpc\('update-task', \{ taskId: task\.id, pipeline: next \}\)/)
  })

  test(`${name}：验证中 full→work 必须 confirm，再按主窗口人工通过 force 收口`, () => {
    assert.match(text, /task\.status === 'verifying' && current === 'full' && next === 'work'/)
    assert.match(text, /改为免验证并跳过当前独立验收？/)
    assert.match(text, /rpc\('verify-task', \{ taskId: task\.id, verdict: 'approved', comment: '主窗口将流程从 full 改为 work，手动跳过独立 Verifier 验收', force: true \}\)/)
    assert.match(text, /迟到记录保留/)
    // 只有 work 触发跳过：direct 仅更新后续执行形态，不擅自完成当前卡
    assert.ok(!/next === 'direct'[\s\S]{0,120}verify-task/.test(text), 'direct 不应触发人工验收通过')
  })
}
