// @ts-check
/**
 * 属性白名单（spec §10.4 第 3 步 / §10.2）。
 *
 * `value`、`data-*`、`style` 一律不进 payload —— 这是参考实现里最值得照搬的一条
 * 安全决策，因为 `value` 正是密码框泄露的入口之一（另一条入口在 HTML 片段里，
 * 由 ticket 03 的 S-1 修正处理）。
 */
;(function attachAttributeAllowlist(scope) {
  'use strict'

  /**
   * 只保留这些属性名。大小写无关，比较前统一转小写。
   * @type {ReadonlySet<string>}
   */
  const SAFE_ATTRIBUTE_NAMES = new Set([
    'id',
    'class',
    'name',
    'type',
    'role',
    'href',
    'src',
    'alt',
    'title',
    'placeholder',
    'for',
    'action',
    'method'
  ])

  /**
   * `aria-*` 一律放行，因为它们描述的是元素的语义而非用户数据。
   * @param {string} name
   */
  function isAriaAttribute(name) {
    return name.startsWith('aria-')
  }

  /**
   * @param {string} name
   */
  function isSafeAttributeName(name) {
    const lower = String(name).toLowerCase()
    return SAFE_ATTRIBUTE_NAMES.has(lower) || isAriaAttribute(lower)
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.SAFE_ATTRIBUTE_NAMES = SAFE_ATTRIBUTE_NAMES
  scope.__EG__.isAriaAttribute = isAriaAttribute
  scope.__EG__.isSafeAttributeName = isSafeAttributeName
})(globalThis)
