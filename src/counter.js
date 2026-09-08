/**
 * 计数器模块 — 纯函数式实现
 * 支持 increment / decrement / reset，返回当前值
 */

function createCounter(initialValue) {
  var value = typeof initialValue === 'number' && isFinite(initialValue) ? initialValue : 0
  var initial = value

  return {
    /** 自增 1 并返回当前值 */
    increment: function () { return ++value },
    /** 自减 1 并返回当前值 */
    decrement: function () { return --value },
    /** 重置为初始值并返回当前值 */
    reset: function () { value = initial; return value },
    /** 获取当前值（不改变状态） */
    getValue: function () { return value }
  }
}

module.exports = { createCounter: createCounter }
