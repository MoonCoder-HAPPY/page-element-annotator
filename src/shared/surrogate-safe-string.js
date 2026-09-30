// @ts-check
/**
 * 按 UTF-16 码元上限截断，但不切开代理对。
 *
 * 为什么需要它：JS 的 `String.length` 数的是 UTF-16 码元，在边界上直接 `slice`
 * 会落在星平面字符（emoji、多数 CJK 扩展字）的两半之间，留下一个孤立代理项，
 * 之后每个界面都会把它渲染成 U+FFFD。
 *
 * 对应 spec §14.8。参考实现见 `orca/src/shared/surrogate-safe-text-slice.ts`。
 */
;(function attachSurrogateSafeString(scope) {
  'use strict'

  const HIGH_SURROGATE_MIN = 0xd800
  const HIGH_SURROGATE_MAX = 0xdbff

  /**
   * @param {number} code
   */
  function isHighSurrogate(code) {
    return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX
  }

  /**
   * 截到 `limit` 个 UTF-16 码元，且不留下悬空的高代理项。
   * @param {string} value
   * @param {number} limit
   */
  function sliceAtCodeUnitLimit(value, limit) {
    if (typeof value !== 'string') {
      return ''
    }
    if (value.length <= limit) {
      return value
    }
    if (limit <= 0) {
      return ''
    }
    const end = isHighSurrogate(value.charCodeAt(limit - 1)) ? limit - 1 : limit
    return value.slice(0, end)
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.sliceAtCodeUnitLimit = sliceAtCodeUnitLimit
})(globalThis)
