// build-pkg.cjs — 把动态插件源码（host-v30.js / client-v30.js）机械转换为
// 静态 Bundle 包 packages/dsh-agent-board/。
//
// 转换规则（全部带计数断言，源文件结构变化时会直接报错而不是生成坏包）：
//   host:  return {apply(ctx){...}} → export function apply(ctx){...} + export const inject
//          ctx.get('fs'/'timer'/'agents'/'subagents') → ctx.<name>
//          harness.registerTool(ctx, harness.defineTool(...)) → ctx.tools.register(defineTool(...))
//          harness.handle('x', fn) → handlers['x'] = fn（汇入 /dsh-agent-board webServer 路由）
//   client: return {inject, apply} → module.exports {name, inject, apply}
//           包进 window.__ModuleLoader__.load 工厂，React 走 require('react')
//           host.call(m, a) → fetch POST /dsh-agent-board
//           ctx.interval(cb, ms) → ctx.get('timer').interval(cb, ms)（ctx.effect 包裹）
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..')
const OUT = path.join(SRC, 'packages', 'dsh-agent-board')

function replaceCounted(text, from, to, expect, label) {
  const count = text.split(from).length - 1
  if (count !== expect) throw new Error(`[build] ${label}: expected ${expect} occurrence(s) of ${JSON.stringify(from.slice(0, 60))}, found ${count}`)
  return text.split(from).join(to)
}

// ─── host ────────────────────────────────────────────────────────────────
let host = fs.readFileSync(path.join(SRC, 'host-v30.js'), 'utf8')

host = replaceCounted(host,
  "return {\n  apply(ctx) {\n    const fs = ctx.get('fs')\n    if (fs === undefined) { console.error('[task-board] fs unavailable'); return }",
  "export function apply(ctx) {\n    const fs = ctx.fs\n    // RPC handlers 表必须在最前面初始化：后面的 handle(...) 调用依赖它（var 只提升声明不提升赋值）\n    var handlers = {}\n    function handle(method, fn) { handlers[method] = fn }",
  1, 'host header')
// 去掉对象包装尾部的 `  }\n}` → `}`
host = host.replace(/\n  \}\n\}\s*$/, '\n}')
if (!host.trimEnd().endsWith('}')) throw new Error('[build] host tail unwrap failed')

host = replaceCounted(host, "ctx.get('fs')", 'ctx.fs', 0, 'noop') // 已无剩余（header 已处理）；允许 0
host = host // ctx.get('fs') 在 header 替换后不应再出现
if (host.includes("ctx.get('fs')")) throw new Error('[build] leftover ctx.get(\'fs\')')
host = host.split("ctx.get('timer')").join('ctx.timer')
host = host.split("ctx.get('agents')").join('ctx.agents')
host = host.split("ctx.get('subagents')").join('ctx.subagents')

// 工具注册：harness.registerTool(ctx, harness.defineTool({ → ctx.tools.register(defineTool({
const toolCount = host.split('harness.registerTool(ctx, harness.defineTool({').length - 1
if (toolCount < 10) throw new Error(`[build] expected >=10 tool registrations, found ${toolCount}`)
host = host.split('harness.registerTool(ctx, harness.defineTool({').join('ctx.tools.register(defineTool({')

// RPC：harness.handle('x', fn) → handle('x', fn)，集中进 handlers
const rpcCount = host.split('harness.handle(').length - 1
if (rpcCount < 15) throw new Error(`[build] expected >=15 rpc handlers, found ${rpcCount}`)
host = host.split('harness.handle(').join('handle(')

// 在 console.log 版本行之前插入 webServer 路由（handlers/handle 已在 apply 开头声明）
const hostInfra = `
    // ===== client ↔ host RPC：POST /dsh-agent-board { method, args } → JSON =====
    function readBody(req, limit) {
      return new Promise(function (resolve, reject) {
        var chunks = [], size = 0
        req.on('data', function (c) { size += c.length; if (size > limit) { reject(new Error('payload too large')); try { req.destroy() } catch (_) {} return }; chunks.push(c) })
        req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')) })
        req.on('error', reject)
      })
    }
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-board',
      handler: async function (req, res) {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ ok: false, message: 'method not allowed' })); return }
        var payload = null
        try { payload = JSON.parse(await readBody(req, 4 * 1024 * 1024)) } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'bad request' })); return }
        var fn = payload && handlers[payload.method]
        if (!fn) { res.writeHead(404); res.end(JSON.stringify({ ok: false, message: 'unknown method: ' + payload.method })); return }
        try { var out = await fn(payload.args); res.writeHead(200); res.end(JSON.stringify(out === undefined ? null : out)) } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, message: String(e) })) }
      },
    })

`
host = host.replace("    console.log('[task-board]", hostInfra + "    console.log('[task-board]")
if (!host.includes("'/dsh-agent-board'")) throw new Error('[build] host infra insertion failed')

const hostOut = `// dsh-agent-board — Agent 任务看板（host 端）
// 由 scripts/build-pkg.cjs 从 host-v30.js 机械转换生成；不要手改本文件。
//
// 零外部依赖：link: 安装的包从真实路径解析，裸 import '@deepseek-ai/dsh-tools'
// 会解析失败（ERR_MODULE_NOT_FOUND）。defineTool 本体只是 校验+包装 出
// {name, description, parameters, output, execute} 普通对象，这里内联等价实现。
// parameters 已是完整 JSON Schema，原样透传；output 透传 schema+render。
function defineTool(options) {
  var userExecute = options.execute
  var userRender = options.output && options.output.render
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: userRender ? function (args, value) { return userRender(args, value) } : undefined,
    },
    execute: function (args, exec) { return userExecute(args, exec) },
  }
}

export const name = 'dsh-agent-board'
export const inject = ['fs', 'timer', 'subagents', 'agents', 'tools', 'webServer']

` + host + '\n'

// ─── client ──────────────────────────────────────────────────────────────
let client = fs.readFileSync(path.join(SRC, 'client-v30.js'), 'utf8')

client = replaceCounted(client,
  "return {\n  inject: ['timer'],\n  apply(ctx) {",
  "function apply(ctx) {",
  1, 'client header')
client = client.replace(/\n  \}\n\}\s*$/, '\n}')
if (!client.trimEnd().endsWith('}')) throw new Error('[build] client tail unwrap failed')

// ctx.interval(fetchTasks, 3000) → timer 服务（静态 client 没有 ctx.interval 快捷方式）
client = replaceCounted(client,
  'ctx.interval(fetchTasks, 3000)',
  "var __timer = ctx.get('timer')\n    if (__timer) ctx.effect(function () { return __timer.interval(fetchTasks, 3000) })",
  1, 'client interval')

// host.call(method, a) → fetch
client = replaceCounted(client,
  'return host.call(method, a)',
  "return fetch('/dsh-agent-board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: method, args: a }) }).then(function (r) { return r.json() })",
  1, 'client rpc')
if (client.includes('host.call')) throw new Error('[build] leftover host.call')

const clientOut = `/* global window, document, fetch, getComputedStyle, MutationObserver, ResizeObserver */
// dsh-agent-board — Browser 侧 bundle（CJS 工厂，供 dsh web 客户端 ModuleLoader 注入）。
// 由 scripts/build-pkg.cjs 从 client-v30.js 机械转换生成；不要手改本文件。
window.__ModuleLoader__.load({
  id: "dsh-agent-board",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict'
    const React = require('react')

` + client + `

module.exports = { name: 'dsh-agent-board', apply: apply }
return module.exports
  }
})
`

// ─── 写出 ────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true })
fs.writeFileSync(path.join(OUT, 'index.mjs'), hostOut, 'utf8')
fs.writeFileSync(path.join(OUT, 'lib', 'client.js'), clientOut, 'utf8')
console.log(`[build] host: ${toolCount} tools, ${rpcCount} rpc handlers`)
console.log('[build] wrote', path.join(OUT, 'index.mjs'))
console.log('[build] wrote', path.join(OUT, 'lib', 'client.js'))
