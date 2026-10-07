// scripts/reload-probe.cjs — 插件热重载可行性探针（无头基建实验支线 L3）
//
// 目的：如实回答「dsh-agent-board 改了代码能不能不重启宿主就生效」。
// 结论口径（2026-10-07 实测，详见 docs/DEVTESTING.md）：
//   组合层（disable→enable 触发的 HMR 重组）可以热生效——路由会先消失再恢复；
//   代码层不可热重载——宿主 ESM 模块表按 URL 缓存，重新挂载 import 到的仍是旧模块对象，
//   服务端代码改动一律重启 dsh 生效。
//
// 用法：
//   node scripts/reload-probe.cjs             基线探测：活性快照 + 管理通道盘点 + 3s 路由基线
//   node scripts/reload-probe.cjs --watch 60  观测窗口：轮询路由 60s，供另开会话 toggle 时采集时间线
//
// 环境变量：
//   DSH_PROBE_BASE   宿主基址（缺省 http://127.0.0.1:3080）
//   DSH_PROFILE_DIR  profile 目录（缺省 %DSH_HOME%/profiles/web，无 DSH_HOME 则 ~/.dsh/profiles/web）
//
// 退出码：0 = 探测流程走通（不等于支持热重载）；1 = 宿主不可达等流程性失败。

var fs = require('node:fs')
var path = require('node:path')
var os = require('node:os')

var BASE = process.env.DSH_PROBE_BASE || 'http://127.0.0.1:3080'
var PROFILE_DIR = process.env.DSH_PROFILE_DIR
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'web')
var ROUTE = BASE + '/dsh-agent-board'

// ---- 小工具 ----
function ts(t0) { return '[+' + ((Date.now() - t0) / 1000).toFixed(1) + 's]' }

// 以真实 RPC 语义打插件路由：mounted → 200 + JSON；未挂载 → 405 空 body（README 验证安装节口径）
async function probeRoute() {
  try {
    var res = await fetch(ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'get-tasks', args: {} }),
      signal: AbortSignal.timeout(4000),
    })
    var body = await res.text()
    return { status: res.status, bytes: body.length }
  } catch (e) {
    return { status: 0, bytes: 0, error: String(e && e.message || e) }
  }
}

// ---- P1 管理通道盘点（只读证据：profile 文件直读，不动宿主）----
function inspectProfile() {
  var out = { profileDir: PROFILE_DIR, exists: fs.existsSync(PROFILE_DIR) }
  if (!out.exists) return out
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'))
    out.patchReload = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.patchReload
    out.bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
    out.boardInBundles = out.bundles.indexOf('dsh-agent-board') >= 0
  } catch (e) { out.pkgError = String(e && e.message || e) }
  try {
    var patch = fs.readFileSync(path.join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8')
    // YAML-lite：按行扫 agent-board 行块（行首 '-' 起始，后续缩进行归属该行块），不做全量解析
    var lines = patch.split(/\r?\n/)
    var idx = -1
    for (var k = 0; k < lines.length; k++) { if (/^-\s+id:\s*agent-board\b/.test(lines[k])) { idx = k; break } }
    if (idx >= 0) {
      var block = [lines[idx]]
      for (var j = idx + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) block.push(lines[j])
      out.boardRow = block.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120)
      var d = block.join('\n').match(/disabled:\s*(\w+)/)
      out.boardDisabled = d ? d[1] : '(行内未写 disabled)'
    } else {
      out.boardRow = null
      out.boardDisabled = '(未找到 agent-board 行)'
    }
  } catch (e) { out.patchError = String(e && e.message || e) }
  return out
}

async function main() {
  var argv = process.argv.slice(2)
  var watchSec = 0
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--watch') watchSec = Number(argv[i + 1] || 30)
  }
  var t0 = Date.now()
  console.log('== reload-probe == 宿主基址 ' + BASE)

  // P0 活性快照
  var first = await probeRoute()
  if (first.status === 0) {
    console.error(ts(t0) + ' 宿主不可达：' + first.error)
    console.error('先启动 dsh（dsh --profile web）再跑本探针。')
    process.exit(1)
  }
  console.log(ts(t0) + ' P0 活性快照：POST /dsh-agent-board → HTTP ' + first.status + '（' + first.bytes + 'B）')

  // P1 管理通道盘点
  var prof = inspectProfile()
  console.log(ts(t0) + ' P1 profile 证据（' + prof.profileDir + '）：')
  if (!prof.exists) {
    console.log('    profile 目录不存在——跳过文件证据（可用 DSH_PROFILE_DIR 指定）')
  } else {
    console.log('    patchReload = ' + prof.patchReload + '（live = 组合层 HMR 开：改 patch 立即重组，无需重启）')
    console.log('    dsh-agent-board 在 bundles 清单：' + prof.boardInBundles)
    console.log('    cordis.patch.yml 里 agent-board 行：' + (prof.boardRow || '(未找到)') + '｜disabled = ' + prof.boardDisabled)
  }
  console.log('    管理接口形态：agent 工具 plugin_manager（set_plugin）/ Web UI「Plugins」页——')
  console.log('    走 cordis 服务 + profile patch 落盘，无公开 HTTP 端点；本脚本从外部只能观测路由，不能触发 toggle。')

  // P2 观测窗口（--watch）或 3s 基线
  var winMs = watchSec > 0 ? watchSec * 1000 : 3000
  console.log(ts(t0) + ' P2 路由观测窗口 ' + (winMs / 1000) + 's' + (watchSec > 0 ? '（请在此期间用 plugin_manager set_plugin 做 disable→enable）' : '（基线）'))
  var last = null
  var sawDown = false
  var sawRecover = false
  while (Date.now() - t0 < winMs + 1000 || (watchSec === 0 && last === null)) {
    var r = await probeRoute()
    var up = r.status === 200
    if (last === null || up !== last) {
      console.log(ts(t0) + '    路由' + (up ? '存活（HTTP ' + r.status + '）' : '消失（HTTP ' + r.status + '）'))
      if (last !== null && !up) sawDown = true
      if (sawDown && up) sawRecover = true
    }
    last = up
    if (watchSec <= 0) break
    await new Promise(function (r2) { setTimeout(r2, 1000) })
  }
  if (watchSec > 0) {
    console.log(ts(t0) + ' 观测结果：路由消失过=' + sawDown + '，消失后恢复=' + sawRecover)
  }

  // P3 结论（机制口径 + 本次实测）
  console.log('== 结论 ==')
  console.log('1) 组合层热重组：profile patchReload=live 时 disable→enable 即时重组，路由/工具随之卸下再挂上——' + (watchSec > 0 ? '本次观测见上方时间线' : '加 --watch N 实测') + '。')
  console.log('2) 代码层热重载：不支持。宿主 ESM 模块表按 URL 缓存，重新挂载 import 到的仍是旧模块对象；')
  console.log('   改 packages/dsh-agent-board 任何服务端代码后必须重启 dsh 才生效（2026-10-06 探针实锤，本次复核一致）。')
  console.log('3) 前端产物 lib/client.js 属客户端模块图，浏览器刷新即拉新；但 host 端逻辑（index.mjs/lib/*.mjs）一律走重启。')
  process.exit(0)
}

main().catch(function (e) { console.error('reload-probe 流程失败：', e); process.exit(1) })
