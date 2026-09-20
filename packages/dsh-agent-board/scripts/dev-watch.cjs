// dsh-agent-board 开发热循环：watch 源码 → 自动重启 dev DSH 实例
//
// 用法：node scripts/dev-watch.cjs   （或 npm run dev）
// 然后浏览器打开 http://127.0.0.1:3081 做 E2E。
//
// 行为：
//   - index.mjs / lib/*.mjs 变更（host 逻辑）→ 杀掉 dev 实例重启（约 3-5s）
//   - lib/client.js 变更 → 同样重启（0.1.5-rc.2 起 client bundle 启动时组合缓存，旧 rev 不更新）
//   - 防抖 800ms（连续保存合并为一次重启）
//
// 为什么不用官方 cordis-plugin-hmr：web 部署的 base composition 把它
// `disabled: true`（TODO: reload lifecycle 未测完），实测 watcher 对 link:
// 插件的文件变更完全静默（连语法错误都无反应），不可用。

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PKG_DIR = path.resolve(__dirname, '..')
const WATCH_DIRS = [PKG_DIR, path.join(PKG_DIR, 'lib')]
const PORT = process.env.DEV_PORT || 3081
const PROFILE = process.env.DEV_PROFILE || 'dev'
const DEBOUNCE_MS = 800

let child = null
let restarting = false
let timer = null

function boot() {
  console.log('[dev-watch] 启动 dev 实例 (profile=' + PROFILE + ', port=' + PORT + ') ...')
  child = spawn('dsh', ['--profile', PROFILE, '--port', String(PORT), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true, // Windows 上 dsh 是 .cmd
  })
  child.stdout.on('data', (d) => process.stdout.write('[dsh] ' + d))
  child.stderr.on('data', (d) => process.stdout.write('[dsh] ' + d))
  child.on('exit', (code) => {
    if (!restarting) {
      console.log('[dev-watch] dev 实例意外退出 (code=' + code + ')，3s 后自动拉起')
      setTimeout(boot, 3000)
    }
  })
}

function restart(reason) {
  if (restarting) return
  restarting = true
  console.log('[dev-watch] 检测到变更（' + reason + '），重启 dev 实例...')
  const old = child
  const done = () => { restarting = false; boot() }
  if (!old) return done()
  old.once('exit', done)
  try { process.platform === 'win32' ? spawn('taskkill', ['/pid', String(old.pid), '/f', '/t'], { stdio: 'ignore' }) : old.kill('SIGTERM') } catch (_) { done() }
  // 兜底：5s 没死就强续
  setTimeout(() => { if (restarting) { restarting = false; boot() } }, 5000)
}

function scheduleRestart(file) {
  clearTimeout(timer)
  timer = setTimeout(() => restart(file), DEBOUNCE_MS)
}

for (const dir of WATCH_DIRS) {
  fs.watch(dir, { recursive: false }, (event, filename) => {
    if (!filename) return
    const f = String(filename)
    if (!/\.(mjs|js)$/.test(f)) return
    if (/\.test\.|test[\\/]|node_modules/.test(f)) return
    scheduleRestart(f)
  })
  console.log('[dev-watch] watching ' + dir)
}

process.on('SIGINT', () => { try { child && child.kill() } catch (_) {} process.exit(0) })
boot()
console.log('[dev-watch] 浏览器打开 http://127.0.0.1:' + PORT + ' 开始 E2E；改 host 代码自动重启，改 client.js 刷新页面即可')
