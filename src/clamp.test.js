const { test } = require('node:test')
const assert = require('node:assert/strict')
const { clamp } = require('./clamp')

test('正常值：区间内原样返回', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(0, 0, 10), 0)    // 边界值 min
  assert.equal(clamp(10, 0, 10), 10)  // 边界值 max
  assert.equal(clamp(-2.5, -5, 5), -2.5)
})

test('越界：低于下限取 min，高于上限取 max', () => {
  assert.equal(clamp(-3, 0, 10), 0)
  assert.equal(clamp(15, 0, 10), 10)
  assert.equal(clamp(-100, -5, 5), -5)
})

test('NaN：value 为 NaN 时返回 NaN', () => {
  assert.ok(Number.isNaN(clamp(NaN, 0, 10)))
  assert.ok(Number.isNaN(clamp(undefined, 0, 10)))
})

test('min > max：抛出 RangeError', () => {
  assert.throws(() => clamp(5, 10, 0), RangeError)
  assert.throws(() => clamp(5, 10, 0), /min .* 不能大于 max/)
  assert.throws(() => clamp(5, NaN, 10), RangeError)
})
