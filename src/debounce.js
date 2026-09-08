/**
 * 防抖工具函数 — 支持 leading/trailing 选项
 *
 * debounce(fn, delay, options)
 *   options.leading  — 在延迟开始前调用（默认 false）
 *   options.trailing — 在延迟结束后调用（默认 true）
 *
 * 返回的函数附带：
 *   .cancel() — 取消防 pending 的调用
 *   .flush()  — 立即执行 pending 的调用
 *   .pending() — 是否有待执行的调用
 */

function debounce(fn, delay, options) {
  if (typeof fn !== 'function') throw new TypeError('debounce: fn must be a function')
  delay = Math.max(0, Number(delay) || 0)
  var opts = options || {}
  var leading = opts.leading === true
  var trailing = opts.trailing !== false  // 默认 true

  if (!leading && !trailing) {
    // 两边都关 = 永不调用，直接返回空操作
    var noop = function () {}
    noop.cancel = function () {}
    noop.flush = function () { return undefined }
    noop.pending = function () { return false }
    return noop
  }

  var timerId = null
  var lastArgs = null
  var lastThis = null
  var lastCallTime = 0
  var lastInvokeTime = 0
  var result

  function invoke(time) {
    lastInvokeTime = time
    var args = lastArgs
    var thisArg = lastThis
    lastArgs = null
    lastThis = null
    result = fn.apply(thisArg, args)
    return result
  }

  function trailingEdge() {
    timerId = null
    if (trailing && lastArgs) {
      invoke(Date.now())
    } else {
      lastArgs = null
      lastThis = null
    }
  }

  function timerExpired() {
    var time = Date.now()
    // trailing edge：自上次调用起已经安静了 delay
    if (time - lastCallTime >= delay) {
      trailingEdge()
      return
    }
    // 持续被调用，重新计时剩余时间
    var remaining = delay - (time - lastCallTime)
    timerId = setTimeout(timerExpired, remaining)
  }

  function debounced() {
    var time = Date.now()
    lastCallTime = time
    lastArgs = arguments
    lastThis = this

    var isLeading = leading && timerId === null

    if (timerId !== null) {
      clearTimeout(timerId)
    }
    timerId = setTimeout(timerExpired, delay)

    if (isLeading) {
      return invoke(time)
    }
    return result
  }

  debounced.cancel = function () {
    if (timerId !== null) {
      clearTimeout(timerId)
      timerId = null
    }
    lastArgs = null
    lastThis = null
  }

  debounced.flush = function () {
    if (timerId === null) return result
    clearTimeout(timerId)
    timerId = null
    if (trailing && lastArgs) {
      return invoke(Date.now())
    }
    lastArgs = null
    lastThis = null
    return result
  }

  debounced.pending = function () {
    return timerId !== null
  }

  return debounced
}

module.exports = { debounce: debounce }
