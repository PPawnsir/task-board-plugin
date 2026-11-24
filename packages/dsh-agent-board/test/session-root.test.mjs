// 主会话 fork/seed 判根回归（Issue：ontology_ai 主窗口 task_create 被误判为子代理，2026-11-24）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSession, isRootSessionHeader } from '../lib/session.mjs'

const MAIN_FORK = 'session-aa61f7c9-0e21-4080-b252-4b95ada9b7c4'
const PREVIOUS_MAIN = 'session-0c60e64e-3389-4242-98d8-52e910ba1ac2'
const CHILD = '54592664-6cbf-4ff4-9255-97ba0f270111'

const mainForkHeader = {
  id: MAIN_FORK,
  parentSession: PREVIOUS_MAIN,
  isSeeded: true,
  delegationDepth: 0,
  agentPreset: 'standard',
}
const childHeader = {
  id: CHILD,
  parentSession: MAIN_FORK,
  isSeeded: false,
  origin: 'subagent',
  delegationDepth: 1,
  agentPreset: 'standard',
}

test('判根纯函数：主会话 fork/seed 认根，显式子代理与 v3 老形态仍拒绝', () => {
  assert.equal(isRootSessionHeader(mainForkHeader), true, '事发主会话：有 parentSession 但 depth=0，必须是根')
  assert.equal(isRootSessionHeader(childHeader), false, '真实子代理：origin=subagent + depth=1')
  assert.equal(isRootSessionHeader({ ...mainForkHeader, origin: 'subagent' }), false, 'origin=subagent 优先于 depth=0')
  assert.equal(isRootSessionHeader({ parentSession: PREVIOUS_MAIN }), false, 'v3 老子代理无 depth：维持保守非根')
  assert.equal(isRootSessionHeader({ id: PREVIOUS_MAIN, delegationDepth: 0 }), true, '无 parentSession 的普通主会话')
  assert.equal(isRootSessionHeader(undefined), true, '缺 header 时保持旧回退语义')
})

test('resolveRoot/task_create 门禁：主 fork 解析到自身；子代理解析到主 fork 而非更早主会话', () => {
  const mainFork = { id: MAIN_FORK, session: { header: mainForkHeader } }
  const previousMain = { id: PREVIOUS_MAIN, session: { header: { id: PREVIOUS_MAIN, delegationDepth: 0 } } }
  const child = { id: CHILD, session: { header: childHeader } }
  const byId = new Map([[MAIN_FORK, mainFork], [PREVIOUS_MAIN, previousMain], [CHILD, child]])
  const ctx = {
    agents: {
      currentInitiator: () => mainFork,
      get: id => byId.get(id),
      list: () => [mainFork, previousMain, child],
    },
  }
  const session = createSession(ctx, {
    knownSessions: {}, feedbackCache: {}, epicSplitCache: {}, activeRuns: {}, dispatchedEver: {},
  })

  const actor = session.getActorId()
  assert.equal(actor, MAIN_FORK)
  assert.equal(session.resolveRoot(actor), actor, '主窗口门禁 resolveRoot(actor)===actor 必须成立')
  assert.equal(session.toolSessionId(), MAIN_FORK)
  assert.equal(session.rootForSession(MAIN_FORK), mainFork, '主 fork 有活 root，可 spawn/看板')
  assert.equal(session.resolveRoot(CHILD), MAIN_FORK, '子代理归到当前主 fork，不再穿过它误归上一代主会话')
  assert.notEqual(session.resolveRoot(CHILD), CHILD, '真正子代理仍被主窗口门禁拒绝')
  assert.equal(session.rootForSession(CHILD), undefined, '子代理不能充当 spawn root')
})
