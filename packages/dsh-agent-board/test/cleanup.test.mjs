// dsh-agent-board — 已结算会话清理套件（task-mv2131cz）：
//   ① 四闸可删谓词（落定 / recorded / 非 continuable / 不活跃 各一）
//   ② preview 不动盘（dry-run 零副作用）
//   ③ run 真删会话目录 + projcache json（临时 HOME 构造，与真实布局一致）
//   ④ 路径逃逸防护（id 含 ../ 之类拒 + rm 前 isWithin 再验）
// 纯函数断言直接 import lib/cleanup.mjs；RPC 端到端跑真实 index.mjs apply(mockCtx)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'
import { isSafeSessionId, classifyRun, scanDeletable, previewCleanup, runCleanup, isWithin, buildSessionDirIndex } from '../lib/cleanup.mjs'

// ===== ① 会话 id 白名单（路径逃逸第一道闸）=====
test('isSafeSessionId：合法 id 放行、路径字符/空值拒', function () {
  assert.equal(isSafeSessionId('5c912460-ddd0-45f2-8298-717b2cfd6a25'), true, '裸 UUID 放行')
  assert.equal(isSafeSessionId('session-55b0879a-b266-434e-98e2-5d2ba6ee85f6'), true, 'session-<uuid> 放行')
  assert.equal(isSafeSessionId('import-sess_df0837fa-9e89-465b-9962-dd61e481c87e'), true, 'import-sess_ 放行')
  assert.equal(isSafeSessionId('child-abc123'), true, 'child- 放行')
  assert.equal(isSafeSessionId('../evil'), false, '父路径段拒')
  assert.equal(isSafeSessionId('a/b'), false, '正斜杠拒')
  assert.equal(isSafeSessionId('a\\b'), false, '反斜杠拒')
  assert.equal(isSafeSessionId('.'), false, '单点拒')
  assert.equal(isSafeSessionId('..'), false, '双点拒')
  assert.equal(isSafeSessionId(''), false, '空串拒')
  assert.equal(isSafeSessionId('  padded  '), false, '首尾空白拒')
  assert.equal(isSafeSessionId('a.b'), false, '含点拒（会话 id 不应含点）')
})

// ===== ② 四闸可删谓词（各一）=====
test('classifyRun：四闸各一 + 全过可删', function () {
  var none = new Set()
  assert.equal(classifyRun({ id: 'a', outcome: 'running', usageRecorded: true }, none).reason, 'not-settled', '闸1 落定：running 拒')
  assert.equal(classifyRun({ id: 'a', usageRecorded: true }, none).reason, 'not-settled', '闸1 落定：缺 outcome 拒')
  assert.equal(classifyRun({ id: 'a', outcome: 'completed' }, none).reason, 'not-recorded', '闸2 recorded：缺旗拒')
  assert.equal(classifyRun({ id: 'a', outcome: 'completed', usageRecorded: true, continuable: true }, none).reason, 'continuable', '闸3 非 continuable：可续跑拒')
  assert.equal(classifyRun({ id: 'a', outcome: 'completed', usageRecorded: true }, new Set(['a'])).reason, 'active', '闸4 不活跃：活跃/血统拒')
  assert.equal(classifyRun({ id: 'a', outcome: 'completed', usageRecorded: true }, none).deletable, true, '全过可删')
  assert.equal(classifyRun({ id: '../x', outcome: 'completed', usageRecorded: true }, none).reason, 'id-invalid', '路径逃逸优先拒')
})

// ===== ③ scanDeletable：同 id 任一条不可删则整组不可删 =====
test('scanDeletable：按 id 聚合、任一条不可删整组拒', function () {
  var tasks = [
    { id: 't1', title: 't1', runs: [{ id: 'ok', role: 'worker', outcome: 'completed', usageRecorded: true }, { id: 'dup', role: 'worker', outcome: 'completed', usageRecorded: true }] },
    { id: 't2', title: 't2', runs: [{ id: 'dup', role: 'worker', outcome: 'running', usageRecorded: true }] }
  ]
  var r = scanDeletable(tasks, new Set())
  assert.deepEqual(r.items.map(function (x) { return x.id }), ['ok'], '只 ok 可删')
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].id, 'dup')
  assert.equal(r.skipped[0].reason, 'not-settled', 'dup 任一条 running 即整组拒')
})

// ===== ④ preview 无副作用 + run 真删（临时 HOME 构造）=====
test('previewCleanup 只读不删、runCleanup 真删目录+projcache', async function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cleanup-'))
  try {
    var sessionsRoot = path.join(tmp, 'sessions')
    var bucket = path.join(sessionsRoot, 'b1')
    var sessionDir = path.join(bucket, 'child-ok')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x'.repeat(1000))
    var projcacheDir = path.join(tmp, 'projcache')
    fs.mkdirSync(projcacheDir, { recursive: true })
    var pcPath = path.join(projcacheDir, 'child-ok.json')
    fs.writeFileSync(pcPath, 'y'.repeat(500))
    var roots = { sessions: sessionsRoot, projcacheDir: projcacheDir }
    var tasks = [{ id: 't1', title: 't1', runs: [{ id: 'child-ok', role: 'worker', outcome: 'completed', usageRecorded: true }] }]
    // preview：dry-run，估体积 + 不动盘
    var pv = previewCleanup(tasks, { blockedIds: new Set(), roots: roots })
    assert.equal(pv.total, 1)
    assert.ok(pv.totalBytes >= 1500, '体积估算含目录+projcache')
    assert.ok(fs.existsSync(sessionDir), 'preview 后会话目录仍在（零副作用）')
    assert.ok(fs.existsSync(pcPath), 'preview 后 projcache 仍在（零副作用）')
    // run：真删
    var rep = await runCleanup(pv.items, { roots: roots })
    assert.equal(rep.deleted, 1)
    assert.ok(!fs.existsSync(sessionDir), 'run 后会话目录已删')
    assert.ok(!fs.existsSync(pcPath), 'run 后 projcache 已删')
    assert.equal(rep.freedBytes, pv.totalBytes, '释放字节与预览一致')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ===== ⑤ 路径逃逸防护：rm 前 isWithin 再验 + id 白名单 =====
test('路径逃逸：isWithin 拒绝桶外路径、runCleanup 拒删逃逸目标', async function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cleanup-esc-'))
  try {
    var sessionsRoot = path.join(tmp, 'sessions')
    var projcacheDir = path.join(tmp, 'projcache')
    fs.mkdirSync(sessionsRoot, { recursive: true })
    fs.mkdirSync(projcacheDir, { recursive: true })
    // isWithin 纯函数：根内放行、根外/根本身拒绝
    assert.equal(isWithin(sessionsRoot, path.join(sessionsRoot, 'b1', 'x')), true, '桶内放行')
    assert.equal(isWithin(sessionsRoot, path.join(tmp, 'outside')), false, '桶外拒绝')
    assert.equal(isWithin(sessionsRoot, sessionsRoot), false, '根本身拒绝')
    // runCleanup：sessionDir 指向桶外 → 跳过并拒绝删除
    var outside = path.join(tmp, 'outside-dir')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'do-not-delete')
    var rep = await runCleanup([{ id: 'evil', sessionDir: outside, projcachePath: null }], { roots: { sessions: sessionsRoot, projcacheDir: projcacheDir } })
    assert.equal(rep.deleted, 0)
    assert.equal(rep.skipped.length, 1)
    assert.equal(rep.skipped[0].reason, 'path-escape')
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), '桶外目录未被删')
    // 含 ../ 的 id 在 runCleanup 层也被 id-invalid 拦下（即使给了合法 sessionDir）
    var rep2 = await runCleanup([{ id: '../evil', sessionDir: path.join(sessionsRoot, 'b1', 'x'), projcachePath: null }], { roots: { sessions: sessionsRoot, projcacheDir: projcacheDir } })
    assert.equal(rep2.deleted, 0)
    assert.equal(rep2.skipped[0].reason, 'id-invalid')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ===== ⑥ RPC 端到端：cleanup-preview / cleanup-run（真实 apply + 临时 HOME）=====
test('RPC cleanup-preview/run 端到端 + 留痕 + 活跃/逃逸跳过', async function () {
  var env = createMockCtx()
  plugin.apply(env.ctx)
  try {
    // 可删会话：on-disk 会话目录 + projcache
    var sessionDir = path.join(env.home, '.dsh', 'sessions', 'b1', 'child-abc')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'z'.repeat(2000))
    var projDir = path.join(env.home, '.dsh', 'storages', 'session_projcache', 'sessions')
    fs.mkdirSync(projDir, { recursive: true })
    var pcPath = path.join(projDir, 'child-abc.json')
    fs.writeFileSync(pcPath, 'w'.repeat(600))
    // 先建一张卡落出看板文件（patchBoard 需文件已存在），再整体覆盖 runs 场景
    await env.rpc('create-task', { sessionId: env.sid, id: 'seed', title: 'seed', description: 'x' })
    env.patchBoard(function (d) {
      d.tasks = [
        { id: 't1', title: 't1', status: 'resolved', runs: [{ id: 'child-abc', role: 'worker', outcome: 'completed', usageRecorded: true }] },
        { id: 't2', title: 't2', status: 'resolved', runs: [{ id: 'child-active', role: 'worker', outcome: 'completed', usageRecorded: true }] },
        { id: 't3', title: 't3', status: 'resolved', runs: [{ id: '../escape', role: 'worker', outcome: 'completed', usageRecorded: true }] }
      ]
    })
    // 活跃会话：child-active 塞进活跃树（agents.list 会返回它）→ 应被「不活跃」闸跳过
    env.setRoots([env.root, { id: 'child-active' }])
    var pv = await env.rpc('cleanup-preview', { sessionId: env.sid })
    assert.equal(pv.ok, true)
    assert.equal(pv.total, 1, '只 child-abc 可删')
    assert.ok(pv.totalBytes >= 2600)
    var skipIds = (pv.skipped || []).map(function (s) { return s.id })
    assert.ok(skipIds.indexOf('child-active') >= 0, '活跃会话进跳过清单')
    assert.ok(skipIds.indexOf('../escape') >= 0, '路径逃逸 id 进跳过清单')
    assert.ok(fs.existsSync(sessionDir), 'preview 后会话目录仍在（零副作用）')
    assert.ok(fs.existsSync(pcPath), 'preview 后 projcache 仍在（零副作用）')
    // run：confirm:false 拒、confirm:true 真删
    var noConfirm = await env.rpc('cleanup-run', { sessionId: env.sid })
    assert.equal(noConfirm.ok, false, '无 confirm 拒绝')
    var rep = await env.rpc('cleanup-run', { sessionId: env.sid, confirm: true })
    assert.equal(rep.ok, true)
    assert.equal(rep.deleted, 1)
    assert.ok(!fs.existsSync(sessionDir), 'run 后会话目录已删')
    assert.ok(!fs.existsSync(pcPath), 'run 后 projcache 已删')
    var board = env.board()
    assert.ok(Array.isArray(board.cleanupLog) && board.cleanupLog.length === 1, 'cleanupLog 留痕')
    assert.equal(board.cleanupLog[0].deleted, 1)
  } finally {
    await env.cleanup()
  }
})

// ===== ⑦ buildSessionDirIndex：一次性索引可定位目录（preview 用）=====
test('buildSessionDirIndex：id → 目录路径 索引', function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cleanup-idx-'))
  try {
    var sessionsRoot = path.join(tmp, 'sessions')
    var b1 = path.join(sessionsRoot, 'b1')
    var b2 = path.join(sessionsRoot, 'b2')
    fs.mkdirSync(path.join(b1, 'aaa'), { recursive: true })
    fs.mkdirSync(path.join(b2, 'bbb'), { recursive: true })
    fs.writeFileSync(path.join(b1, 'aaa', 'session.jsonl.zstd'), 'x') // 目录里放个文件确保是目录
    fs.writeFileSync(path.join(b2, 'bbb', 'session.jsonl.zstd'), 'y')
    var idx = buildSessionDirIndex(sessionsRoot)
    assert.equal(idx['aaa'], path.join(b1, 'aaa'))
    assert.equal(idx['bbb'], path.join(b2, 'bbb'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
