// debounce.js 自测脚本（真实定时器，快速延迟）
const { debounce } = require('./debounce')

let passed = 0
let failed = 0

function assert(desc, cond) {
  if (cond) { passed++; console.log('  ✓ ' + desc) }
  else { failed++; console.error('  ✗ ' + desc) }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

async function main() {
  console.log('trailing（默认）:')
  {
    const calls = []
    const f = debounce(function (x) { calls.push(x) }, 50)
    f(1); f(2); f(3)
    assert('立即调用三次，trailing 前不执行', calls.length === 0)
    await sleep(80)
    assert('延迟后只执行最后一次', calls.length === 1 && calls[0] === 3)
  }

  console.log('leading:')
  {
    const calls = []
    const f = debounce(function (x) { calls.push(x) }, 50, { leading: true, trailing: false })
    f(1)
    assert('leading 立即执行', calls.length === 1 && calls[0] === 1)
    f(2); f(3)
    assert('延迟期内再次调用不执行', calls.length === 1)
    await sleep(80)
    assert('trailing=false，延迟后不执行', calls.length === 1)
  }

  console.log('leading + trailing:')
  {
    const calls = []
    const f = debounce(function (x) { calls.push(x) }, 50, { leading: true, trailing: true })
    f(1)
    assert('leading 执行 1', calls.length === 1 && calls[0] === 1)
    f(2)
    await sleep(80)
    assert('trailing 执行最后一次 2', calls.length === 2 && calls[1] === 2)
  }

  console.log('cancel:')
  {
    const calls = []
    const f = debounce(function (x) { calls.push(x) }, 50)
    f(1)
    f.cancel()
    await sleep(80)
    assert('cancel 后不执行', calls.length === 0)
  }

  console.log('flush:')
  {
    const calls = []
    const f = debounce(function (x) { calls.push(x); return x }, 50)
    f(42)
    const r = f.flush()
    assert('flush 立即执行并返回结果', calls.length === 1 && calls[0] === 42 && r === 42)
    await sleep(80)
    assert('flush 后不再 trailing 执行', calls.length === 1)
  }

  console.log('pending:')
  {
    const f = debounce(function () {}, 50)
    assert('初始 pending=false', f.pending() === false)
    f()
    assert('调用后 pending=true', f.pending() === true)
    f.cancel()
    assert('cancel 后 pending=false', f.pending() === false)
  }

  console.log('this 与参数透传:')
  {
    const ctx = { name: 'ctx' }
    let gotThis = null
    let gotArgs = null
    const f = debounce(function (a, b) { gotThis = this; gotArgs = [a, b] }, 30)
    f.call(ctx, 'x', 'y')
    await sleep(60)
    assert('this 透传正确', gotThis === ctx)
    assert('参数透传正确', gotArgs[0] === 'x' && gotArgs[1] === 'y')
  }

  console.log('持续调用重置计时:')
  {
    const calls = []
    const f = debounce(function () { calls.push(Date.now()) }, 60)
    f()
    await sleep(40)
    f()  // 重置计时
    await sleep(40)
    assert('80ms 内持续调用未执行', calls.length === 0)
    await sleep(40)
    assert('安静 60ms 后执行', calls.length === 1)
  }

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
  if (failed > 0) process.exit(1)
}

main().catch(function (e) { console.error(e); process.exit(1) })
