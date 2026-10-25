// dsh-agent-board — 人工/外部操作留痕（opsLog）单测（test/ops-log.test.mjs）
// 背景（task-mvnf3gly，epic task-mvnem59t 子卡 8/8）：Team 模式下人工 GUI 操作对 Agent 不可感——
// HTTP 通道写集成功即落 d.opsLog（{at, op, taskId, summary, actor}，截尾 50，仿 configLog），
// get-tasks 透尾部 20 / task_list recentOps 透尾部 5 单行 / Team 注入段加「最近人工/外部操作」小节
// （opsCache 在 rt() 与 teamModeCache 同点同步，section text() 每轮现算）。
// 覆盖（任务断言①~⑤）：
//   ① 写集命中记 opsLog；读集（get-tasks/list-children）不记；ok:false 不记；专道排除（set-board-config/mark-reviewed）不记
//   ② 截尾 50：超出后只留最新 50 条，最新在尾
//   ③ get-tasks 透出尾部 20 条；task_list 透出 recentOps 尾部 5 条单行摘要
//   ④ Team 注入段「最近人工/外部操作」出现/缺席两态 + 单行格式 + 位于 LESSON_RECALL_HINT 之前
//   ⑤ opsCache 随 rt() 同步（patchBoard 改写 → get-tasks 触发 rt → 注入段内容跟随）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx } from './helpers/mock-ctx.mjs'
import * as plugin from '../index.mjs'

function iso(i) { return new Date(1700000000000 + i * 60000).toISOString() }
async function prefillOps(env, n) {
  // patchBoard 要求看板文件已存在（首次 mutateLocked 才落盘）——空板先种一张卡（其留痕随即被覆盖）
  if (!env.board()) await env.rpc('create-task', { sessionId: env.sid, id: 'task-seed-ops', title: 'seed', pipeline: 'direct', draft: true })
  env.patchBoard(function (d) {
    d.opsLog = []
    for (var i = 0; i < n; i++) d.opsLog.push({ at: iso(i), op: 'update-task', taskId: 'task-p' + i, summary: 'update-task title', actor: env.sid })
  })
}
function teamSection(env) { return env.spSections.find(function (s) { return s.name === 'task-board:team-mode' }) }

// ===== ① 写集记 / 读集不记 / ok:false 不记 / 专道排除不记 =====
test('① opsLog 留痕门禁：写集命中记（字段齐）；读集/ok:false/专道排除不记', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    // 写集命中：create-task
    var c = await env.rpc('create-task', { sessionId: env.sid, id: 'task-op1', title: '留痕一号', pipeline: 'direct', draft: true })
    assert.equal(c.ok, true)
    var ops = env.board().opsLog
    assert.equal(ops.length, 1, '写集命中落 1 条')
    assert.equal(ops[0].op, 'create-task')
    assert.ok(ops[0].at && /^\d{4}-/.test(ops[0].at), 'at 为 ISO 时间戳')
    assert.equal(ops[0].actor, env.sid, 'actor=来源会话')
    assert.ok(ops[0].summary.indexOf('create-task') === 0 && ops[0].summary.indexOf('留痕一号') >= 0, 'summary 一句话含方法+标题')
    // 写集命中：update-task（taskId 落条目）
    var u = await env.rpc('update-task', { sessionId: env.sid, taskId: 'task-op1', title: '改名', priority: 'high' })
    assert.equal(u.ok, true)
    ops = env.board().opsLog
    assert.equal(ops.length, 2)
    assert.equal(ops[1].taskId, 'task-op1', '卡 id 落条目')
    assert.equal(ops[1].summary, 'update-task title/priority', 'update-task 摘要=改动字段清单')
    // 写集命中：batch-op（ids 拼 taskId，摘要带 op×N）
    var b = await env.rpc('batch-op', { sessionId: env.sid, op: 'set-priority', ids: ['task-op1'], value: 'low' })
    assert.equal(b.ok, true)
    ops = env.board().opsLog
    assert.equal(ops.length, 3)
    assert.equal(ops[2].summary, 'batch-op set-priority ×1')
    assert.equal(ops[2].taskId, 'task-op1')
    // 读集不记
    await env.rpc('get-tasks', { sessionId: env.sid })
    await env.rpc('list-children', { sessionId: env.sid })
    assert.equal(env.board().opsLog.length, 3, '读集不落 opsLog')
    // ok:false 不记（任务不存在）
    var bad = await env.rpc('update-task', { sessionId: env.sid, taskId: 'nope', title: 'x' })
    assert.equal(bad.ok, false)
    assert.equal(env.board().opsLog.length, 3, 'ok:false 不落 opsLog')
    // 专道排除：set-board-config（configLog 专道）/ mark-reviewed（自动触发）不记
    var sc = await env.rpc('set-board-config', { sessionId: env.sid, key: 'maxWorkers', value: 4 })
    assert.equal(sc.ok, true)
    var mr = await env.rpc('mark-reviewed', { sessionId: env.sid, taskId: 'task-op1' })
    assert.equal(mr.ok, true)
    assert.equal(env.board().opsLog.length, 3, 'set-board-config/mark-reviewed 走专道，不进 opsLog')
    assert.equal(env.board().configLog.length, 1, 'configLog 专道照记（对照）')
  } finally { await env.cleanup() }
})

// ===== ② 截尾 50 =====
test('② opsLog 截尾 50：超出只留最新，最新在尾', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await prefillOps(env, 48)
    for (var i = 0; i < 5; i++) await env.rpc('create-task', { sessionId: env.sid, id: 'task-trim-' + i, title: 'T' + i, pipeline: 'direct', draft: true })
    var ops = env.board().opsLog
    assert.equal(ops.length, 50, '截尾留最新 50 条')
    assert.equal(ops[49].op, 'create-task')
    assert.ok(ops[49].summary.indexOf('T4') >= 0, '最新一条在尾部')
    assert.equal(ops[0].taskId, 'task-p3', '最老三条被裁掉（task-p0~p2 已出窗）')
  } finally { await env.cleanup() }
})

// ===== ③ get-tasks 透尾部 20 / task_list recentOps 透尾部 5 单行 =====
test('③ get-tasks 透出 opsLog 尾部 20；task_list recentOps 尾部 5 条单行摘要', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    await prefillOps(env, 25)
    var d = await env.rpc('get-tasks', { sessionId: env.sid })
    assert.equal(d.opsLog.length, 20, 'get-tasks 透尾部 20 条')
    assert.equal(d.opsLog[19].taskId, 'task-p24', '尾部=最新')
    var lst = await env.tools.get('task_list').execute({})
    assert.ok(Array.isArray(lst.recentOps), 'task_list 带 recentOps')
    assert.equal(lst.recentOps.length, 5, 'recentOps 尾部 5 条')
    assert.match(lst.recentOps[4], /^- \d{2}-\d{2} \d{2}:\d{2} update-task title task-p24$/, '单行摘要格式「- MM-DD HH:MM <summary> <taskId>」')
    // 无操作时 recentOps 为空数组（字段恒在，形态确定）
    await prefillOps(env, 0)
    var lst2 = await env.tools.get('task_list').execute({})
    assert.deepEqual(lst2.recentOps, [], '无操作 recentOps=[]')
  } finally { await env.cleanup() }
})

// ===== ④⑤ Team 注入段「最近人工/外部操作」两态 + opsCache 随 rt() 同步 =====
test('④⑤ Team 注入段：opsCache 有操作→小节出现（LESSON 前）；空→小节缺席；patchBoard 改写经 rt 同步后内容跟随', async () => {
  var env = createMockCtx()
  try {
    plugin.apply(env.ctx)
    var sec = teamSection(env)
    assert.ok(sec && typeof sec.text === 'function', 'Team 注入段已注册')
    // 未开 Team 模式：恒空串（门禁不回归）
    assert.equal(sec.text({ agent: env.root }), '')
    // 开 Team 模式（本身即一次写集留痕）+ rt 同步 opsCache
    await env.rpc('set-team-mode', { sessionId: env.sid, enabled: true })
    await env.rpc('get-tasks', { sessionId: env.sid })
    var txt = sec.text({ agent: env.root })
    assert.ok(txt.indexOf('【最近人工/外部操作】') >= 0, '有操作→小节出现')
    assert.ok(txt.indexOf('set-team-mode on') >= 0, '小节含操作单行')
    assert.ok(/^- \d{2}-\d{2} \d{2}:\d{2} set-team-mode on$/m.test(txt), '小节内单行格式')
    assert.ok(txt.indexOf('【最近人工/外部操作】') < txt.indexOf('开工前如环境装有笔记/记忆类工具'), '小节位于 LESSON_RECALL_HINT 之前')
    // ⑤ patchBoard 清空 opsLog → rt 同步 → 小节缺席
    await prefillOps(env, 0)
    await env.rpc('get-tasks', { sessionId: env.sid })
    var txt2 = sec.text({ agent: env.root })
    assert.equal(txt2.indexOf('【最近人工/外部操作】'), -1, '无操作→小节缺席（零噪音）')
    assert.ok(txt2.indexOf('【任务看板 Team 模式已开启】') >= 0, 'Team 引导主体仍在')
    // ⑤ 再写入 2 条 → 小节内容跟随（缓存非快照）
    await prefillOps(env, 2)
    await env.rpc('get-tasks', { sessionId: env.sid })
    var txt3 = sec.text({ agent: env.root })
    assert.ok(txt3.indexOf('update-task title task-p1') >= 0, 'rt 再同步后小节内容跟随最新尾部')
  } finally { await env.cleanup() }
})
