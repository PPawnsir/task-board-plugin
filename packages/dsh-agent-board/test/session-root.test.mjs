// 主会话 fork/seed 判根回归（Issue：ontology_ai 主窗口 task_create 被误判为子代理，2026-11-24）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSession, isRootSessionHeader, hasChildDirectory, childSessionsOf } from '../lib/session.mjs'

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

// ===== 子会话目录统一源（task-mwzzub2w，rc.5 契约迁移：截图故障 n-mwzztin5okiv）=====
const GRANDCHILD = 'session-grand-00000000-aaaa-bbbb-cccc-ddddeeee0000'
const OTHER_ROOT = 'session-other-0000000-aaaa-bbbb-cccc-ddddeeee0001'
const OTHER_CHILD = 'session-othkid-000000-aaaa-bbbb-cccc-ddddeeee0002'
const COLD_CHILD = 'session-coldkid-00000-aaaa-bbbb-cccc-ddddeeee0003'

function mkAgent(id, header, label) {
  const a = { id: id, session: { header: header } }
  if (label !== undefined) a.label = label
  return a
}

test('目录源 rc.5 路径：agents.list 过滤只收直接子代理——主 fork/seed、孙代理、别家子代理、无父子会话全部排除', async () => {
  const ctx = {
    subagents: { list: () => ['mock'] }, // rc.5 形态：subagents 服务在位但无 listChildren
    agents: {
      list: () => [
        mkAgent(MAIN_FORK, mainForkHeader), // 主 fork/seed（parentSession+depth=0）：不算子会话
        mkAgent(PREVIOUS_MAIN, { id: PREVIOUS_MAIN, delegationDepth: 0 }), // 无父子主会话
        mkAgent(CHILD, childHeader, 'worker:task-x'), // 唯一直接子代理
        mkAgent(GRANDCHILD, { id: GRANDCHILD, parentSession: CHILD, origin: 'subagent', delegationDepth: 2 }), // 孙代理
        mkAgent(OTHER_CHILD, { id: OTHER_CHILD, parentSession: OTHER_ROOT, origin: 'subagent', delegationDepth: 1 }), // 别家子代理
        mkAgent('weird', { parentSession: MAIN_FORK }), // 有父但无 origin（v3 老/非子代理形态）：不收
      ],
    },
  }
  assert.equal(hasChildDirectory(ctx), true, 'agents.list 在位即有目录能力')
  const kids = await childSessionsOf(ctx, MAIN_FORK)
  assert.deepEqual(kids, [{ sessionId: CHILD, id: CHILD, label: 'worker:task-x' }], '只收 parentSession===sid 且 origin=subagent 的直接子代理')
  // 查别的会话目录：别家 root 的直接子代理归它，不串门
  const otherKids = await childSessionsOf(ctx, OTHER_ROOT)
  assert.deepEqual(otherKids, [{ sessionId: OTHER_CHILD, id: OTHER_CHILD, label: '' }], '别家子代理只出现在别家目录（红线：不能把所有 origin=subagent 都算作本会话子代理）')
})

test('目录源 rc.5 持久主源：listDescendants 优先于 agents.list，收冷子会话且只认直接 child', async () => {
  const calls = []
  const signal = new AbortController().signal
  const ctx = {
    subagents: {
      listDescendants: async (sid, sig) => {
        calls.push({ sid, sig })
        return [
          { kind: 'child', id: COLD_CHILD, parentId: MAIN_FORK, depth: 1, label: 'worker:cold', activity: 'inactive', mode: 'continuable' },
          { kind: 'diagnostic', id: 'diagnostic-1', parentId: MAIN_FORK, depth: 1, reason: 'unavailable' },
          { kind: 'child', id: GRANDCHILD, parentId: COLD_CHILD, depth: 2, label: 'worker:grand', mode: 'continuable' },
          { kind: 'child', id: OTHER_CHILD, parentId: OTHER_ROOT, depth: 1, label: 'worker:other', mode: 'continuable' },
          { kind: 'child', id: 'wrong-depth', parentId: MAIN_FORK, depth: 2, label: 'wrong-depth', mode: 'continuable' },
          null,
          {},
        ]
      },
    },
    agents: { list: () => { throw new Error('listDescendants 在位时不得回退 agents.list') } },
  }
  assert.equal(hasChildDirectory(ctx), true, 'listDescendants 单独即可提供目录能力（无需 agents）')
  const kids = await childSessionsOf(ctx, MAIN_FORK, signal)
  assert.deepEqual(calls, [{ sid: MAIN_FORK, sig: signal }], 'rootSessionId 与 signal 原样透传')
  assert.deepEqual(kids, [{ sessionId: COLD_CHILD, id: COLD_CHILD, label: 'worker:cold' }],
    '持久但 agents.list 不含的冷子会话在列；diagnostic/depth>1/别家 parent/无 kind 行全部排除')
})

test('目录源 listDescendants：空持久目录不合并活体表；同步/异步异常原样透传', async () => {
  const ctxEmpty = {
    subagents: { listDescendants: async () => [] },
    agents: { list: () => { throw new Error('持久空目录是权威结果，不得再读 agents.list') } },
  }
  assert.deepEqual(await childSessionsOf(ctxEmpty, MAIN_FORK), [], '持久 catalog 确认空目录即返回 []，不与 agents.list 活体行合并')
  const ctxAsyncErr = { subagents: { listDescendants: async () => { throw new Error('desc-async-boom') } } }
  await assert.rejects(() => childSessionsOf(ctxAsyncErr, MAIN_FORK), /desc-async-boom/)
  const ctxSyncErr = { subagents: { listDescendants: () => { throw new Error('desc-sync-boom') } } }
  await assert.rejects(() => childSessionsOf(ctxSyncErr, MAIN_FORK), /desc-sync-boom/)
})

test('目录源 rc.5 路径：无目录能力 → null（跳过语义）；agents.list 空表 → 空数组（确认无子会话）', async () => {
  assert.equal(hasChildDirectory({}), false, 'subagents/agents 都缺席：无目录能力')
  assert.equal(childSessionsOf({}, MAIN_FORK), null, '无能力返回 null 而非空数组（null=查不了，[] = 确认没有）')
  assert.equal(childSessionsOf({ subagents: {} }, MAIN_FORK), null, 'rc.5 事故原形：subagents 无 listChildren 且无 agents → null，消费方跳过不抛 TypeError')
  const ctx = { agents: { list: () => [] } }
  assert.equal(hasChildDirectory(ctx), true)
  assert.deepEqual(await childSessionsOf(ctx, MAIN_FORK), [], '空表=确认无活子会话（reconcile 判死/哨兵结算的合法输入）')
})

test('目录源旧宿主路径：listChildren 原样兼容（归一化 + 旧 API 优先 + 异常透传 + 同步返回承接）', async () => {
  const calls = []
  const ctx = {
    subagents: {
      listChildren: (sid) => { calls.push(sid); return [{ sessionId: 'c-old-1', label: 'worker:k1' }, { id: 'c-old-2', title: 't2' }, { id: 'c-old-3', mode: 'continuable' }, null, {}] },
    },
  }
  assert.equal(hasChildDirectory(ctx), true)
  const kids = await childSessionsOf(ctx, MAIN_FORK)
  assert.deepEqual(calls, [MAIN_FORK], '查询入参原样透传')
  assert.deepEqual(kids, [
    { sessionId: 'c-old-1', id: 'c-old-1', label: 'worker:k1' },
    { sessionId: 'c-old-2', id: 'c-old-2', label: 't2' },
    { sessionId: 'c-old-3', id: 'c-old-3', label: 'continuable' },
  ], 'label 归一链 label||title||mode 与旧 rpc 实现同口径；空行/空 id 行剔除')
  // 旧 API 优先：同 ctx 也有 agents.list（mock-ctx 形态）时仍走 listChildren，不被新桩改道
  const ctxBoth = {
    subagents: {
      listChildren: async () => [{ sessionId: 'old-way' }],
      listDescendants: async () => { throw new Error('旧 listChildren 优先时不得调用 listDescendants') },
    },
    agents: { list: () => [mkAgent(CHILD, childHeader)] },
  }
  assert.deepEqual(await childSessionsOf(ctxBoth, MAIN_FORK), [{ sessionId: 'old-way', id: 'old-way', label: '' }], '旧 API 在位 → 只走旧路径')
  // 异常透传：异步拒绝交给消费方既有 catch
  const ctxErr = { subagents: { listChildren: async () => { throw new Error('boom') } } }
  await assert.rejects(() => childSessionsOf(ctxErr, MAIN_FORK), /boom/)
  // 同步抛错同样转 rejection（消费方 catch 口径单一）
  const ctxSyncErr = { subagents: { listChildren: () => { throw new Error('sync-boom') } } }
  await assert.rejects(() => childSessionsOf(ctxSyncErr, MAIN_FORK), /sync-boom/)
})
