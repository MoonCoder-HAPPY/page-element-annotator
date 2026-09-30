// @ts-check
/**
 * 通用字符串工具。放在最早上，因为文本归一化、抽取与格式化都要用。
 *
 * `clampStr` 的截断后缀语义与参考实现一致：超长时先按码元上限切（不切开代理对），
 * 再追加 `" (truncated)"`。注意这会让输出略超名义上限，spec §10.2 已记录为可接受。
 */
;(function attachTextUtils(scope) {
  'use strict'

  /**
   * @param {unknown} value
   * @param {number} max
   */
  function clampStr(value, max) {
    if (typeof value !== 'string' || value.length === 0) {
      return ''
    }
    if (value.length <= max) {
      return value
    }
    return scope.__EG__.sliceAtCodeUnitLimit(value, max) + scope.__EG__.TRUNCATION_SUFFIX
  }

  /**
   * 是否已被 `clampStr` 截断过。用于避免二次截断叠加两遍后缀。
   * @param {unknown} value
   */
  function isTruncated(value) {
    return typeof value === 'string' && value.endsWith(scope.__EG__.TRUNCATION_SUFFIX)
  }

  /**
   * 非空字符串判断（`''`、`null`、`undefined` 均为假）。
   * @param {unknown} value
   * @returns {value is string}
   */
  function hasText(value) {
    return typeof value === 'string' && value.length > 0
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.clampStr = clampStr
  scope.__EG__.isTruncated = isTruncated
  scope.__EG__.hasText = hasText
})(globalThis)
