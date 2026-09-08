/**
 * clamp(value, min, max) — 将 value 限制在 [min, max] 区间内。
 *
 * 语义约定：
 * - value 为 NaN → 返回 NaN（无效输入向外传播，不静默吞掉）
 * - min > max → 抛出 RangeError（调用方 bug，应当暴露而非猜测交换）
 * - min/max 为 NaN → 同样抛出 RangeError（区间本身无意义）
 * - value < min → 返回 min；value > max → 返回 max；否则返回 value
 */
function clamp(value, min, max) {
  if (typeof min !== 'number' || typeof max !== 'number' || Number.isNaN(min) || Number.isNaN(max)) {
    throw new RangeError('clamp: min/max 必须是有效数字')
  }
  if (min > max) {
    throw new RangeError('clamp: min (' + min + ') 不能大于 max (' + max + ')')
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return NaN
  }
  if (value < min) return min
  if (value > max) return max
  return value
}

module.exports = { clamp }
