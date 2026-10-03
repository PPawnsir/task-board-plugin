#!/usr/bin/env node
// dsh-agent-board — client bundle 零依赖组装器
//
// 背景：dsh web 的 client 运行时把整个 entry（package.json exports["./client"] → lib/client.js）
// 读成单个字符串，经 new Function 求值（见 dsh-cordis-client-runner evaluateClientHalf），
// 没有模块解析能力，相对 import 是语法错误。因此模块化只能走「构建时拼装」：
//
//   模块源：lib/client/{kernel,board-list,task-detail,dashboard}.js（apply(ctx) 函数体片段）
//   产物：  lib/client.js（本脚本生成，头部有 GENERATED 标记，请勿直接编辑）
//
// 安全性：四个模块拼接进同一函数作用域，var/function 声明提升使跨模块引用与顺序无关；
// 所有同步执行代码（DOM 监听/轮询注册/布局同步/slots.inject）都在 kernel 域内且保持原相对顺序。
//
// 用法：
//   node scripts/build-client.cjs           生成 lib/client.js
//   node scripts/build-client.cjs --check   只校验：产物是否最新（过时/缺失则退出码 1，不写盘）
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const PKG = path.resolve(__dirname, '..')
const SRC_DIR = path.join(PKG, 'lib', 'client')
const OUT = path.join(PKG, 'lib', 'client.js')
// 拼接顺序固定（声明顺序无关正确性，固定只为产物稳定可 diff）
const MODULES = ['kernel', 'board-list', 'task-detail', 'dashboard']

// ===== 产物头/尾模板（ModuleLoader 包装 + CJS 工厂；契约段，任何改动先查 dsh-client-modules）=====
const HEAD = `/* global window, document, fetch, getComputedStyle, MutationObserver, ResizeObserver */
// dsh-agent-board — Browser 侧 bundle（CJS 工厂，供 dsh web 客户端 ModuleLoader 注入）。
// ⚠️ GENERATED FILE — 请勿直接编辑。源码在 lib/client/*.js（按用户感知域分模块），
//    由 scripts/build-client.cjs 拼装生成（prepublishOnly / pretest 自动挂链）。
window.__ModuleLoader__.load({
  id: "dsh-agent-board",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict'
    const React = require('react')

function apply(ctx) {
`
const TAIL = `}

module.exports = { name: 'dsh-agent-board', inject: ['slots', 'sessions', 'uiWorkspace', 'timer'], apply: apply }
return module.exports
  }
})
`

/** 语法校验：片段包一层函数体做 parse-only（不执行），模块名进错误信息方便定位。
 *  注意：模块文件是 apply 函数体片段（kernel.js 含裸 return），不能直接 node --check；
 *  本检查与 node --check 用同一个 V8 parser，等价且零子进程。 */
function checkSyntax(name, code) {
  try {
    new vm.Script('function __check__(ctx) {\n' + code + '\n}', { filename: 'lib/client/' + name + '.js' })
  } catch (e) {
    throw new Error('模块 lib/client/' + name + '.js 语法错误: ' + e.message)
  }
}

function build() {
  const parts = []
  for (const m of MODULES) {
    const file = path.join(SRC_DIR, m + '.js')
    if (!fs.existsSync(file)) throw new Error('缺少模块源: lib/client/' + m + '.js')
    const src = fs.readFileSync(file, 'utf8')
    checkSyntax(m, src)
    parts.push(src.replace(/\s+$/, '')) // 去尾部空白，模块间统一空行分隔
  }
  return HEAD + parts.join('\n\n') + '\n' + TAIL
}

const out = build()
// 产物整体再过一次语法校验（等价于 node --check，但零子进程）
try {
  new vm.Script(out, { filename: 'lib/client.js' })
} catch (e) {
  throw new Error('组装产物语法错误（不应发生，请检查模块边界是否切断了表达式）: ' + e.message)
}

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (cur !== out) {
    console.error('[build-client] lib/client.js 已过时：模块源有改动，请运行 node scripts/build-client.cjs')
    process.exit(1)
  }
  console.log('[build-client] 产物与模块源一致，无需重建')
} else {
  fs.writeFileSync(OUT, out, 'utf8')
  console.log('[build-client] 已生成 lib/client.js（' + MODULES.length + ' 模块，' + out.split('\n').length + ' 行）')
}
