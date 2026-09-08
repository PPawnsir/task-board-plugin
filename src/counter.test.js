// counter.js 自测脚本
const { createCounter } = require('./counter')

let passed = 0
let failed = 0

function assert(desc, actual, expected) {
  if (actual === expected) { passed++; console.log('  ✓ ' + desc) }
  else { failed++; console.error('  ✗ ' + desc + ' — expected ' + expected + ', got ' + actual) }
}

console.log('createCounter 基础行为:')
const c1 = createCounter()
assert('初始值为 0', c1.getValue(), 0)
assert('increment → 1', c1.increment(), 1)
assert('increment → 2', c1.increment(), 2)
assert('decrement → 1', c1.decrement(), 1)
assert('reset → 0', c1.reset(), 0)
assert('reset 后 getValue 为 0', c1.getValue(), 0)

console.log('自定义初始值:')
const c2 = createCounter(10)
assert('初始值为 10', c2.getValue(), 10)
assert('increment → 11', c2.increment(), 11)
assert('reset → 回到初始值 10', c2.reset(), 10)

console.log('边界情况:')
const c3 = createCounter()
assert('decrement 可到负数 -1', c3.decrement(), -1)
assert('继续 decrement → -2', c3.decrement(), -2)

const c4 = createCounter(5)
c4.increment(); c4.increment()
assert('两次 increment 后 reset 回到 5', c4.reset(), 5)

console.log('实例隔离:')
const a = createCounter(0)
const b = createCounter(100)
a.increment(); a.increment()
assert('a 独立为 2', a.getValue(), 2)
assert('b 不受影响仍为 100', b.getValue(), 100)

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
if (failed > 0) process.exit(1)
