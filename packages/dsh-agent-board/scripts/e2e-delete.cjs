#!/usr/bin/env node
// dsh-agent-board 删除通道冒烟测试（离线、零外部依赖）
// 用法：node scripts/e2e-delete.cjs
//
// 做法：把 index.mjs 当普通 ESM 模块加载，注入一套最小 ctx 桩件（agents/tools/webServer/timer/effect/get），
// 用 ctx.webServer.register 捕获 RPC handler，再按「{ method, args }」直接调用——全程不碰真实宿主与本机看板
// （USERPROFILE/HOME 被指向临时目录，看板文件写在 <tmp>/.dsh/tasks-<sid>.json）。
//
// 覆盖的删除通道门禁：
//   1) draft / pending / blocked → 删除成功（从 tasks 数组真删）
//   2) in-progress / verifying  → 拒绝，提示先 terminate-agent
//   3) resolved / cancelled     → 拒绝，引导 archive-task
//   4) archived                 → 幂等 ok（deleted + alreadyArchived）
//   5) 有未归档子任务            → 拒绝
//   6) batch-op op='delete'     → done/skipped + reasons；真删；undo 快照无意义（batch-undo 不复活）
//   7) 删除不存在的 id           → not found；缺 taskId → 参数校验报错
var fs = require('node:fs')
var os = require('node:os')
var path = require('node:path')

// ===== 1. 环境隔离：HOME 指向临时目录（必须在动态 import index.mjs 之前设置）=====
var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-board-delete-'))
fs.mkdirSync(path.join(tmpHome, '.dsh'), { recursive: true }) // 看板文件写在 <home>/.dsh/ 下，宿主会保证该目录存在，桩件里自己建
process.env.USERPROFILE = tmpHome
process.env.HOME = tmpHome
process.env.HOMEDRIVE = path.parse(tmpHome).root.replace(/\\$/, '')
process.env.HOMEPATH = tmpHome.slice(path.parse(tmpHome).root.length - 1)

var SID = 'session-delete-smoke'
var passed = 0
var failed = []
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✔ ' + label) }
  else { failed.push(label + (extra ? (' :: ' + extra) : '')); console.log('  ✘ ' + label + (extra ? (' :: ' + extra) : '')) }
}

// ===== 2. ctx 桩件 =====
var captured = { handler: null, tools: [], effects: [] }
var ctx = {
  fs: {},
  timer: {
    timeout: function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) },
    interval: function () { return function () {} },
  },
  effect: function (fn) { try { var d = fn(); captured.effects.push(d) } catch (e) { captured.effects.push(null) } return function () {} },
  // systemPrompt 桩件：插件会调用 section() 与 context() 各注册一段动态文本，均返回释放器
  get: function (name) {
    return name === 'systemPrompt'
      ? { section: function () { return function () {} }, context: function () { return function () {} } }
      : undefined
  },
  agents: {
    currentInitiator: function () { return { id: SID } },
    roots: function () { return [{ id: SID, session: { header: { cwd: process.cwd() } } }] },
    list: function () { return [{ id: SID }] },
    isOwnedBy: function () { return false },
  },
  // 关键：不提供 subagents → 派发路径直接 return null，测试期间不会有子代理被 spawn
  tools: { register: function (t) { captured.tools.push(t); return function () {} } },
  webServer: { register: function (r) { captured.handler = r.handler; return function () {} } },
  logger: { info: function () {}, warn: function () {}, error: function () {} },
}

// ===== 3. 加载插件（index.mjs 无外部依赖，可直接 import）=====
// .cjs 里没有顶层 await，因此把后续全部断言包在 async main() 内，由动态 import 驱动
var mod = null

// 直接调用被捕获的 RPC handler（req 提供最小 data/on 接口，res 收集输出）
function rpc(method, args) {
  return new Promise(function (resolve, reject) {
    var body = Buffer.from(JSON.stringify({ method: method, args: Object.assign({}, args, { sessionId: SID }) }), 'utf8')
    var req = {
      method: 'POST',
      on: function (ev, fn) { if (ev === 'data') fn(body); if (ev === 'end') fn(); return req },
    }
    var res = {
      setHeader: function () {}, writeHead: function () {},
      end: function (s) { try { resolve(JSON.parse(String(s))) } catch (e) { reject(new Error('bad json: ' + String(s).slice(0, 200))) } },
    }
    captured.handler(req, res).catch(reject)
  })
}
function listTasks() { return rpc('get-tasks', { includeArchived: true }).then(function (d) { return (d && d.tasks) || [] }) }
function mkTask(id, status, extra) {
  return rpc('create-task', Object.assign({ id: id, title: 'T-' + id, draft: true, pipeline: 'direct' }, extra || {})).then(function (r) {
    if (!r || !r.ok) throw new Error('create-task 失败: ' + JSON.stringify(r))
    return setStatus(id, status)
  })
}
// 直接改进程内的看板文件把 status 摆到目标态（不动 host 门禁逻辑，只造前置状态）
function setStatus(id, status) {
  var p = path.join(tmpHome, '.dsh', 'tasks-' + SID + '.json')
  var d = JSON.parse(fs.readFileSync(p, 'utf8'))
  var t = d.tasks.find(function (x) { return x.id === id })
  if (!t) throw new Error('任务不存在: ' + id)
  t.status = status
  if (status === 'in-progress') { t.claimedBy = 'w-1'; t.claimedAt = new Date().toISOString() }
  if (status === 'resolved') { t.resolvedAt = new Date().toISOString() }
  if (status === 'archived') { t.archivedAt = new Date().toISOString() }
  fs.writeFileSync(p, JSON.stringify(d), 'utf8')
  return status
}

console.log('删除通道冒烟测试（tmpHome=' + tmpHome + '）')

async function main() {
mod = await import('../index.mjs')
mod.apply(ctx)
if (!captured.handler) { console.error('启动失败：插件未注册 /dsh-agent-board 路由'); process.exit(1) }

// ===== 4. 单任务 delete-task 门禁 =====
console.log('\n[1] 单任务删除：可删状态')
for (var i = 0; i < ['draft', 'pending', 'blocked'].length; i++) {
  var st = ['draft', 'pending', 'blocked'][i]
  var id = 'del-' + st
  await mkTask(id, st)
  var r = await rpc('delete-task', { taskId: id })
  ok(r && r.ok === true && r.deleted === id, st + ' 可删（返回 deleted=' + (r && r.deleted) + '）', JSON.stringify(r))
  var left = (await listTasks()).filter(function (t) { return t.id === id })
  ok(left.length === 0, st + ' 删除后已从 tasks 数组移除（真删）')
}

console.log('\n[2] 单任务删除：进行中/验证中拒绝，提示先终止')
for (var j = 0; j < ['in-progress', 'verifying'].length; j++) {
  var st2 = ['in-progress', 'verifying'][j]
  var id2 = 'keep-' + st2
  await mkTask(id2, st2)
  var r2 = await rpc('delete-task', { taskId: id2 })
  ok(r2 && r2.ok === false && /terminate-agent/.test(String(r2.error)), st2 + ' 拒绝且提示 terminate-agent', JSON.stringify(r2))
  ok((await listTasks()).some(function (t) { return t.id === id2 }), st2 + ' 任务仍在（拒绝时不落盘删除）')
}

console.log('\n[3] 单任务删除：已落定引导归档')
for (var k = 0; k < ['resolved', 'cancelled'].length; k++) {
  var st3 = ['resolved', 'cancelled'][k]
  var id3 = 'done-' + st3
  await mkTask(id3, st3)
  var r3 = await rpc('delete-task', { taskId: id3 })
  ok(r3 && r3.ok === false && /archive-task/.test(String(r3.error)), st3 + ' 拒绝且引导 archive-task', JSON.stringify(r3))
}

console.log('\n[4] 单任务删除：已归档幂等 / 不存在 / 缺参')
var archId = 'arch-1'
await mkTask(archId, 'archived')
var r4 = await rpc('delete-task', { taskId: archId })
ok(r4 && r4.ok === true && r4.alreadyArchived === true, 'archived 幂等 ok（alreadyArchived=true）', JSON.stringify(r4))
var r5 = await rpc('delete-task', { taskId: 'no-such-task' })
ok(r5 && r5.ok === false && r5.error === 'not found', '不存在的 id → not found', JSON.stringify(r5))
var r6 = await rpc('delete-task', {})
ok(r6 && r6.ok === false && /taskId required/.test(String(r6.error)), '缺 taskId → 参数校验报错', JSON.stringify(r6))

console.log('\n[5] 未归档子任务 → 拒删（防 parentId 悬空）')
await rpc('create-task', { id: 'parent-1', title: '父任务', draft: true, pipeline: 'direct' })
await rpc('create-task', { id: 'child-1', title: '子任务', draft: true, pipeline: 'direct', parentId: 'parent-1' })
var r7 = await rpc('delete-task', { taskId: 'parent-1' })
ok(r7 && r7.ok === false && /子任务/.test(String(r7.error)), '有未归档子任务 → 拒绝并提示子任务数', JSON.stringify(r7))
// 子任务归档（非删除）后父任务可删
await setStatus('child-1', 'archived')
var r8 = await rpc('delete-task', { taskId: 'parent-1' })
ok(r8 && r8.ok === true, '子任务归档后父任务可删', JSON.stringify(r8))

console.log('\n[6] batch-op op=delete：done/skipped + reasons，且不产生可撤销快照')
await rpc('create-task', { id: 'b-del-1', title: '批删1', draft: true, pipeline: 'direct' })
await rpc('create-task', { id: 'b-del-2', title: '批删2', draft: true, pipeline: 'direct' })
await mkTask('b-keep-run', 'in-progress')
await mkTask('b-keep-res', 'resolved')
await mkTask('b-arch', 'archived')
var rb = await rpc('batch-op', { op: 'delete', ids: ['b-del-1', 'b-del-2', 'b-keep-run', 'b-keep-res', 'b-arch', 'ghost'] })
ok(rb && rb.ok === true && rb.done === 2, 'done=2（两张草稿被删）', JSON.stringify(rb && rb.done))
ok(rb && rb.skipped.length === 4, 'skipped=4（进行中/已落定/已归档/不存在）', JSON.stringify(rb && rb.skipped))
ok(rb && rb.reasons && /terminate-agent/.test(String(rb.reasons['b-keep-run'])), 'skipped 附 reasons：进行中给终止提示', JSON.stringify(rb && rb.reasons))
ok(rb && rb.reasons && /archive-task/.test(String(rb.reasons['b-keep-res'])), 'skipped 附 reasons：已落定引导归档', JSON.stringify(rb && rb.reasons))
var after = await listTasks()
ok(!after.some(function (t) { return t.id === 'b-del-1' || t.id === 'b-del-2' }), '批删的两张草稿已从数组移除')
// batch-undo 对 delete 不复活任务（真删无快照可回滚）
var ru = await rpc('batch-undo', { snapshot: { op: 'delete', items: [{ id: 'b-del-1', priority: 'medium', status: 'draft' }] } })
var after2 = await listTasks()
ok(!after2.some(function (t) { return t.id === 'b-del-1' }), 'batch-undo 不会复活被删任务（真删无 undo）', JSON.stringify(ru))
ok(rb && rb.skipped.indexOf('ghost') >= 0, '不存在的 id 进 skipped')

console.log('\n[7] batch-op 其它 op 契约未受影响（archive / set-priority / publish）')
await rpc('create-task', { id: 'p-1', title: '待发布', draft: true, pipeline: 'direct' })
var rp = await rpc('batch-op', { op: 'publish', ids: ['p-1'] })
ok(rp && rp.ok === true && rp.done === 1, 'publish 仍按老契约工作', JSON.stringify(rp))
await mkTask('res-1', 'resolved')
var ra = await rpc('batch-op', { op: 'archive', ids: ['res-1'] })
ok(ra && ra.ok === true && ra.done === 1, 'archive 仍按老契约工作', JSON.stringify(ra))
var rpri = await rpc('batch-op', { op: 'set-priority', ids: ['p-1'], value: 'high' })
ok(rpri && rpri.ok === true && rpri.done === 1, 'set-priority 仍按老契约工作', JSON.stringify(rpri))

// ===== 5. 收尾 =====
try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch (_) {}
console.log('\n结果：通过 ' + passed + ' 项，失败 ' + failed.length + ' 项')
if (failed.length) { failed.forEach(function (f) { console.log('  FAIL: ' + f) }); process.exit(1) }
console.log('✅ 删除通道冒烟测试全绿')
}

main().catch(function (e) {
  console.error('冒烟测试异常终止：' + (e && e.stack || e))
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch (_) {}
  process.exit(1)
})
