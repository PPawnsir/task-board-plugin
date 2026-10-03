#!/usr/bin/env node
// dsh-agent-board 看板跨重启继承自测（离线、零外部依赖）
// 用法：node scripts/self-inherit.cjs
//
// 背景（看板反馈 n-mur1bmrwvoge）：DSH 重启后会话根 id 漂移 → 看板按 ownerSession 分文件
// → 新卡落新板、旧板（历史）从默认视图消失。本脚本验证「同工作区唯一孤儿板自动接管」的三分支：
//   [1] 唯一孤儿候选 + ownerCwd 相同        → 接管：文件重命名为新 sid、文件内 ownerSession 改写、卡片随板过来
//   [2] 多个孤儿候选（同工作区）            → 不自动动：两个旧板原样保留、本会话得到空板
//   [3] 原主仍活着（在 agents.roots() 里）  → 不接管：旧板原样保留
//   [4] 兜底：ownerCwd 不同 / 老文件没 ownerCwd → 都不继承
//   [5] rename 恒被占用（EPERM）→ 走「写新板 + 删旧板」兜底路径，同样不残留多余文件
//   [6] 读看板失败但不是 ENOENT（EACCES）→ 不触发继承（防把孤儿板覆盖到本会话说文件名上）
//
// 做法：把 index.mjs 当普通 ESM 模块加载，注入一套最小 ctx 桩件（agents/tools/webServer/timer/effect/get），
// 用 ctx.webServer.register 捕获 RPC handler，按「{ method, args }」直接调用——全程不碰真实宿主与真实看板
// （HOME/USERPROFILE 指向临时目录，看板文件写在 <tmp>/.dsh/tasks-<sid>.json；跑完清理）。
// 环境隔离必须在动态 import index.mjs **之前**完成：lib/core.mjs 的 boardHome() 每次调用都读 env，
// 但真实 syscall 之外的路径拼接必须先隔离好，否则旧代码路径会写到真实家目录。
var fs = require('node:fs')
var os = require('node:os')
var path = require('node:path')

// console.error 捕获：继承/跳过日志是「人可见证据」的一部分，顺手断言（原样转发，不改变输出）
var LOGS = []
var _realError = console.error
console.error = function () { LOGS.push(Array.prototype.map.call(arguments, function (x) { return String(x) }).join(' ')); _realError.apply(console, arguments) }
function takeLogs() { var s = LOGS.join('\n'); LOGS = []; return s }

// ===== 1. 环境隔离：HOME/USERPROFILE 指向临时目录 =====
var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-board-inherit-'))
fs.mkdirSync(path.join(tmpHome, '.dsh'), { recursive: true })
process.env.USERPROFILE = tmpHome
process.env.HOME = tmpHome
process.env.HOMEDRIVE = path.parse(tmpHome).root.replace(/\\$/, '')
process.env.HOMEPATH = tmpHome.slice(path.parse(tmpHome).root.length - 1)

var BOARD_DIR = path.join(tmpHome, '.dsh')
var CWD_A = path.join(tmpHome, 'ws-a')
var CWD_B = path.join(tmpHome, 'ws-b')
fs.mkdirSync(CWD_A, { recursive: true })
fs.mkdirSync(CWD_B, { recursive: true })

var SID = 's-new'
var passed = 0
var failed = []
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + label) }
  else { failed.push(label + (extra ? (' :: ' + extra) : '')); console.log('  \u2718 ' + label + (extra ? (' :: ' + extra) : '')) }
}
// 目录快照：接管是否「干净」必须看整个目录，而不是只看旧文件名在不在——早先版本会在目录里
// 永久留下一份 tasks-<新sid>.json.adopt-<pid>-<ts>（内容 = 旧板全部卡片），boardExists 断言看不出来。
function boardFiles() { return fs.readdirSync(BOARD_DIR).sort() }
// 只清「看板本体 tasks-<sid>.json」与写盘临时件（*.tmp）；刻意保留其它残件（如 .adopt- 残留），
// 让它们在下一条目录断言里暴露出来，而不是被静默清掉（清掉 = 自测盲区）。
function clearBoards() {
  var files = fs.readdirSync(BOARD_DIR)
  files.forEach(function (f) {
    if (/^tasks-.+\.json$/.test(f) || f.indexOf('.tmp') >= 0) { try { fs.unlinkSync(path.join(BOARD_DIR, f)) } catch (_) {} }
  })
}
// 造一个旧看板文件：owner 会话 id + 工作区 + 卡 id 列表（tasks 数组是真卡，用来验证「卡片随板过来」）
function writeBoard(owner, cwd, ids, omitCwd) {
  var now = new Date().toISOString()
  var d = {
    version: 12, ownerSession: owner, boardMode: 'auto', teamMode: false, feedbackEnabled: true,
    minWorkers: 1, maxWorkers: 3, minVerifiers: 0, maxVerifiers: 2, workerModel: '', verifierModel: '',
    softTimeoutMin: 30, hardTimeoutMin: 120, poolStatus: { workers: [], verifiers: [] },
    tasks: (ids || []).map(function (id) {
      return { id: id, title: 'T-' + id, description: '', status: 'pending', priority: 'medium', tags: [], parentId: null, assignMode: 'auto', assignee: null, context: { instructions: '' }, acceptance: '', dependsOn: [], pipeline: 'full', claimedBy: null, claimedAt: null, createdAt: now, resolvedAt: null, history: [], messages: [] }
    }),
  }
  if (!omitCwd) d.ownerCwd = cwd
  fs.writeFileSync(path.join(BOARD_DIR, 'tasks-' + owner + '.json'), JSON.stringify(d), 'utf8')
}
function readBoard(owner) { return JSON.parse(fs.readFileSync(path.join(BOARD_DIR, 'tasks-' + owner + '.json'), 'utf8')) }
function boardExists(owner) { return fs.existsSync(path.join(BOARD_DIR, 'tasks-' + owner + '.json')) }

// ===== 2. ctx 桩件（可换 roots，模拟「原主死没死」）=====
var captured = { handler: null, tools: [] }
var ROOTS = []
var ctx = {
  fs: {},
  timer: {
    timeout: function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) },
    interval: function () { return function () {} },
  },
  effect: function (fn) { try { fn() } catch (_) {} return function () {} },
  get: function (name) {
    return name === 'systemPrompt'
      ? { section: function () { return function () {} }, context: function () { return function () {} } }
      : undefined
  },
  agents: {
    currentInitiator: function () { return { id: (process.env.USERNAME || 'tester') } },
    roots: function () { return ROOTS },
    list: function () { return ROOTS },
    isOwnedBy: function (child, parent) { return String(child) !== String(parent.id) },
  },
  // 不提供 subagents → 派发路径直接 return null，自测期间不会有子代理被 spawn
  tools: { register: function (t) { captured.tools.push(t); return function () {} } },
  webServer: { register: function (r) { captured.handler = r.handler; return function () {} } },
  logger: { info: function () {}, warn: function () {}, error: function () {} },
}
function setRoots(ids, cwd) { ROOTS = ids.map(function (id) { return { id: id, session: { header: { cwd: cwd } } } }) }

function rpc(method, args) {
  return new Promise(function (resolve, reject) {
    var body = Buffer.from(JSON.stringify({ method: method, args: args || {} }), 'utf8')
    var req = { method: 'POST', on: function (ev, fn) { if (ev === 'data') fn(body); if (ev === 'end') fn(); return req } }
    var res = {
      setHeader: function () {}, writeHead: function () {},
      end: function (s) { try { resolve(JSON.parse(String(s))) } catch (e) { reject(new Error('bad json: ' + String(s).slice(0, 200))) } },
    }
    captured.handler(req, res).catch(reject)
  })
}
// 新会话根 id 一定不是进程内首个 sessionId —— 避免 _rootCache 把上一个用例的结果粘住
function newSid() { return 's-new-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36) }
function board(sid) { return rpc('get-tasks', { sessionId: sid }) }

console.log('看板跨重启继承自测（tmpHome=' + tmpHome + '）')

async function main() {
  var mod = await import('../index.mjs')
  mod.apply(ctx)
  if (!captured.handler) { console.error('启动失败：插件未注册 /dsh-agent-board 路由'); process.exit(1) }

  // ===== [1] 唯一孤儿候选 + 同工作区 → 接管 =====
  console.log('\n[1] 唯一孤儿候选（原主已死）→ 自动接管')
  clearBoards()
  var sid1 = newSid()
  setRoots([sid1], CWD_A)
  writeBoard('s-old', CWD_A, ['t-keep-1', 't-keep-2'])
  var d1 = await board(sid1)
  ok(captured.handler != null, 'RPC 已注册')
  ok(d1 && Array.isArray(d1.tasks) && d1.tasks.length === 2, '接管后本会话看到旧板 2 张卡', JSON.stringify((d1 && d1.tasks || []).map(function (t) { return t.id })))
  ok(d1.tasks.length === 2 && d1.tasks[0].id === 't-keep-1' && d1.tasks[1].id === 't-keep-2', '卡片内容随板过来（顺序保持）')
  ok(boardExists(sid1), '文件已重命名为 tasks-' + sid1 + '.json')
  ok(!boardExists('s-old'), '旧文件 tasks-s-old.json 已不存在（不是复制粘贴）')
  ok(readBoard(sid1).ownerSession === sid1, '文件内 ownerSession 已改写为新 sid')
  ok(readBoard(sid1).ownerCwd === CWD_A, 'ownerCwd 保留为原工作区')
  ok(d1.sessionId === sid1, '返回体 sessionId 是新 sid')
  var log1 = takeLogs()
  ok(/\[task-board\] 继承看板 s-old/.test(log1), 'stderr 留一行继承日志（旧 sid → 新 sid）', log1.trim())
  ok(log1.indexOf('rename 不通') < 0, '走的是 rename 主路径（未降级到写新+删旧）', log1.trim())
  ok(JSON.stringify(boardFiles()) === JSON.stringify(['tasks-' + sid1 + '.json']), '接管后看板目录里只剩新 sid 一个文件（无 .adopt-/.tmp 残件）', boardFiles().join(', '))

  // ===== [2] 多候选（同工作区）→ 不自动动 =====
  console.log('\n[2] 多个孤儿候选（同工作区）→ 不自动接管')
  clearBoards()
  var sid2 = newSid()
  setRoots([sid2], CWD_A)
  writeBoard('s-old-a', CWD_A, ['t-a'])
  writeBoard('s-old-b', CWD_A, ['t-b'])
  var d2 = await board(sid2)
  ok(d2 && Array.isArray(d2.tasks) && d2.tasks.length === 0, '本会话得到空板（未擅自合并）', String((d2 && d2.tasks || []).length))
  ok(boardExists('s-old-a') && boardExists('s-old-b'), '两个旧板文件都原样保留')
  ok(readBoard('s-old-a').ownerSession === 's-old-a' && readBoard('s-old-b').ownerSession === 's-old-b', '两个旧板的 ownerSession 都未被改写')
  ok(readBoard('s-old-a').tasks.length === 1 && readBoard('s-old-b').tasks.length === 1, '两个旧板的卡片都还在')
  ok(!boardExists(sid2), '本次读盘没有产生新板文件（未落盘）')
  var log2 = takeLogs()
  ok(/\[task-board\] 继承跳过/.test(log2), 'stderr 留一行跳过日志（多候选不接管）', log2.trim())

  // ===== [3] 原主仍活着 → 不接管 =====
  console.log('\n[3] 原主仍活跃（在 agents.roots()）→ 不接管')
  clearBoards()
  var sid3 = newSid()
  var sidAlive = 's-alive-' + Math.floor(Math.random() * 1e6).toString(36)
  setRoots([sid3, sidAlive], CWD_A)              // 原主与 newcomer 同工作区，但原主还活着
  writeBoard(sidAlive, CWD_A, ['t-live'])
  var d3 = await board(sid3)
  ok(d3 && d3.tasks.length === 0, '本会话得到空板（别人的活板不动）', String((d3 && d3.tasks || []).length))
  ok(boardExists(sidAlive), '原主的板文件仍在原 id 下')
  ok(readBoard(sidAlive).ownerSession === sidAlive, '原主板 ownerSession 未被改写')
  ok(readBoard(sidAlive).tasks.length === 1 && readBoard(sidAlive).tasks[0].id === 't-live', '原主板卡片未被搬走')
  ok(!boardExists(sid3), '本次读盘没有产生新板文件（未落盘）')

  // ===== [4] 兜底：ownerCwd 不同 / 老文件缺 ownerCwd → 都不继承 =====
  console.log('\n[4] 兜底：ownerCwd 不同 或 老文件缺 ownerCwd → 不继承')
  clearBoards()
  var sid4 = newSid()
  setRoots([sid4], CWD_A)
  writeBoard('s-other-ws', CWD_B, ['t-b'])       // 孤儿，但工作区不同
  writeBoard('s-legacy', CWD_A, ['t-legacy'], true) // 孤儿且同工作区，但老文件没有 ownerCwd
  var d4 = await board(sid4)
  ok(d4 && d4.tasks.length === 0, '本会话得到空板', String((d4 && d4.tasks || []).length))
  ok(boardExists('s-other-ws') && boardExists('s-legacy'), '两个候选都原样保留（一个工作区不同、一个缺 ownerCwd）')
  ok(!boardExists(sid4), '没有产生新板文件')
  // 老文件在「下一次写盘」时回填 ownerCwd：这里直接验证种子路径（新板 seed 带 ownerCwd）
  var seeded = await rpc('create-task', { sessionId: sid4, title: 'seed-cwd', pipeline: 'direct' })
  ok(seeded && seeded.ok === true, '新板可正常建卡（seed 路径未被继承逻辑破坏）', JSON.stringify(seeded && seeded.error))
  ok(boardExists(sid4), '首次写盘后新板文件落地')
  ok(readBoard(sid4).ownerCwd === CWD_A, '新板 seed 自带 ownerCwd（下次重启可被继承）')

  // ===== [5] 兜底路径：rename 恒被占用（EPERM）→ 写新板 + 删旧板 =====
  // 主路径（rename）与兜底路径必须各有一条真实走过的用例：早先版本 index.mjs 先把旧板改名搬走、
  // 重试循环却仍去 rename 源路径（已不存在）→ 主路径恒为死代码，且目录里留下 .adopt- 残件副本。
  console.log('\n[5] 兜底路径：rename 恒 EPERM → 写新板 + 删旧板，同样无残件')
  clearBoards()
  var sid5 = newSid()
  setRoots([sid5], CWD_A)
  writeBoard('s-fallback', CWD_A, ['t-fb-1'])
  var realRename = fs.promises.rename
  fs.promises.rename = function (from, to) {
    // 只让「旧板 p → 新 sid 文件名」这一步失败；wt() 的 .tmp → 目标名 是同目录改名，照常放行
    if (String(from).indexOf('tasks-s-fallback.json') >= 0) { var er = new Error('EPERM: forced by self-test'); er.code = 'EPERM'; return Promise.reject(er) }
    return realRename.apply(fs.promises, arguments)
  }
  var d5 = null
  try { d5 = await board(sid5) } finally { fs.promises.rename = realRename }
  var log5 = takeLogs()
  ok(d5 && d5.tasks.length === 1 && d5.tasks[0].id === 't-fb-1', '兜底路径也把卡片带过来', JSON.stringify((d5 && d5.tasks || []).map(function (t) { return t.id })))
  ok(boardExists(sid5) && readBoard(sid5).ownerSession === sid5, '兜底路径同样把文件内 ownerSession 改写为新 sid')
  ok(!boardExists('s-fallback'), '兜底路径删掉了旧文件')
  ok(/rename 不通，走写新\+删旧/.test(log5), 'stderr 日志标明了走的是兜底路径', log5.trim())
  ok(JSON.stringify(boardFiles()) === JSON.stringify(['tasks-' + sid5 + '.json']), '兜底路径看板目录同样只剩新 sid 一个文件', boardFiles().join(', '))

  // ===== [6] 读失败不是 ENOENT → 不触发继承（防覆盖：本会话看板也许只是这一刻读不到）=====
  // 老实现用 `catch (_)` 捕获任意读失败都去接管；若本会话看板存在但暂时不可读（Windows EACCES/EPERM/被占），
  // 接管会把别的板写到本会话文件名上。这里强制 readFile 抛 EACCES 来验证「只认 ENOENT」这道闸门。
  console.log('\n[6] 看板文件读失败（EACCES，非 ENOENT）→ 不触发继承')
  clearBoards()
  var sid6 = newSid()
  setRoots([sid6], CWD_A)
  writeBoard('s-orphan-eacces', CWD_A, ['t-eacces'])   // 同工作区、原主已死 —— 没有闸门就会被接管
  var realRead = fs.promises.readFile
  fs.promises.readFile = function (p) {
    if (String(p).indexOf('tasks-' + sid6 + '.json') >= 0) { var er = new Error('EACCES: forced by self-test'); er.code = 'EACCES'; return Promise.reject(er) }
    return realRead.apply(fs.promises, arguments)
  }
  var d6 = null
  try { d6 = await board(sid6) } finally { fs.promises.readFile = realRead }
  var log6 = takeLogs()
  ok(d6 && d6.tasks.length === 0, '本会话按空板处理（未接管孤儿板）', String((d6 && d6.tasks || []).length))
  ok(/不触发继承/.test(log6), 'stderr 记一行「读看板失败（不触发继承）」', log6.trim())
  ok(boardExists('s-orphan-eacces') && readBoard('s-orphan-eacces').ownerSession === 's-orphan-eacces', '孤儿板原样保留（未被当成继承源）')
  ok(JSON.stringify(boardFiles()) === JSON.stringify(['tasks-s-orphan-eacces.json']), '目录未新增任何文件（没落盘接管）', boardFiles().join(', '))

  // ===== 收尾 =====
  console.log('\n' + (failed.length === 0 ? '\u2713 全部通过' : '\u2717 有失败') + '：' + passed + ' passed, ' + failed.length + ' failed')
  if (failed.length) { failed.forEach(function (f) { console.log('  FAIL: ' + f) }); process.exitCode = 1 }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch (_) {}
}

main().catch(function (e) { console.error('自测异常：', e); try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch (_) {}; process.exit(1) })
