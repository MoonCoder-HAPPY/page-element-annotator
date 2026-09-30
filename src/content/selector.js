// @ts-check
/**
 * 选择器构造。
 *
 * 这个文件是 AC-3 的核心：产出的 `selector` 必须在页面中**恰好命中一个元素**，
 * 否则 AI 拿到它去定位代码或写查询时会命中错元素。参考实现的做法值得完整照搬：
 *
 * 1. 逐级向上拼 `parent > child`，最多 10 级；
 * 2. 每拼完一级就用 `document.querySelectorAll(...).length === 1` **实测**唯一性，
 *    而不是靠"看起来够具体"来推断；
 * 3. 只有当本级的候选不唯一时才追加 `:nth-of-type(n)`，避免选择器无谓变长。
 *
 * `:nth-of-type` 的计数逻辑有个容易写错的细节：当元素在自己那一类里是第一个时，
 * 仍要检查后面有没有同类兄弟——若有，则必须写成 `:nth-of-type(1)`，否则选择器
 * 会命中后出现的那个同类元素。参考实现为此单独写了 next-sibling 扫描。
 */
;(function attachSelector(scope) {
  'use strict'

  const MAX_SELECTOR_DEPTH = 10
  const MAX_READABLE_PATH_DEPTH = 6
  const MAX_FULL_PATH_DEPTH = 20
  const MAX_SELECTOR_CLASSES = 2

  /**
   * CSS 标识符转义。优先用平台实现（`CSS.escape`），退化路径只做最基本处理。
   * @param {string} value
   */
  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value)
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      return '\\' + ch
    })
  }

  /**
   * 形如 `a1B2c3D4e5f6` 的构建产物哈希：长、既有数字又有大写。
   * 这类 class 名不稳定（每次构建会变），留在选择器里没有任何定位价值。
   * @param {string} value
   */
  function looksHashy(value) {
    return /^[A-Za-z0-9_-]{12,}$/.test(value) && /\d/.test(value) && /[A-Z]/.test(value)
  }

  /**
   * 取"稳定"的 class：跳过过长、像机密、CSS-in-JS 生成、以及像构建哈希的那些。
   * @param {Element} el
   * @param {number} maxCount
   */
  function getStableClasses(el, maxCount) {
    if (!el.classList) {
      return []
    }
    const result = []
    for (let i = 0; i < el.classList.length && result.length < maxCount; i++) {
      const cls = el.classList[i]
      if (!cls || cls.length > 60 || scope.__EG__.containsSecret(cls)) {
        continue
      }
      if (/^css-[a-z0-9]+$/i.test(cls) || looksHashy(cls)) {
        continue
      }
      result.push(cls)
    }
    return result
  }

  /**
   * 单级选择器片段：优先 `tag#id`，其次 `tag.class1.class2`，最后退化到 `tag`。
   * @param {Element} el
   */
  function buildSelectorPart(el) {
    const tag = el.tagName.toLowerCase()
    const id = el.id
    if (id && !scope.__EG__.containsSecret(id)) {
      return tag + '#' + cssEscape(id)
    }
    const classes = getStableClasses(el, MAX_SELECTOR_CLASSES)
    if (classes.length > 0) {
      return (
        tag +
        classes
          .map(function (cls) {
            return '.' + cssEscape(cls)
          })
          .join('')
      )
    }
    return tag
  }

  /**
   * @param {string} selector
   */
  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1
    } catch (error) {
      // 非法选择器（例如页面提供了畸形 id）视为不唯一，让上层继续加限定。
      return false
    }
  }

  /**
   * 当本级片段不唯一时，追加 `:nth-of-type(n)`。
   * @param {Element} current
   */
  function getNthOfTypeSuffix(current) {
    const tag = current.tagName
    let index = 1
    let sibling = current.previousElementSibling
    while (sibling) {
      if (sibling.tagName === tag) {
        index++
      }
      sibling = sibling.previousElementSibling
    }
    if (index > 1) {
      return ':nth-of-type(' + index + ')'
    }

    // 自己那一类里的第一个，但后面还有同类兄弟 —— 仍须显式写 (1)。
    sibling = current.nextElementSibling
    while (sibling) {
      if (sibling.tagName === tag) {
        return ':nth-of-type(1)'
      }
      sibling = sibling.nextElementSibling
    }
    return ''
  }

  /**
   * 逐级向上构造，并在每一级验证唯一性。
   * @param {Element} el
   */
  function buildSelector(el) {
    const parts = []
    let current = el
    while (
      current &&
      current.nodeType === Node.ELEMENT_NODE &&
      current !== document.body &&
      parts.length < MAX_SELECTOR_DEPTH
    ) {
      let part = buildSelectorPart(current)
      const parent = current.parentElement
      if (parent) {
        const candidate = parts.concat([part]).reverse().join(' > ')
        if (!isUniqueSelector(candidate)) {
          part += getNthOfTypeSuffix(current)
        }
      }
      parts.unshift(part)
      const selector = parts.join(' > ')
      if (isUniqueSelector(selector)) {
        return scope.__EG__.clampStr(selector, scope.__EG__.BUDGET.selectorMaxLength)
      }
      current = parent
    }
    return scope.__EG__.clampStr(
      parts.join(' > ') || el.tagName.toLowerCase(),
      scope.__EG__.BUDGET.selectorMaxLength
    )
  }

  /**
   * 给人看的路径：优先 `#id`，其次 `[aria-label]`，其次 `[role]`，其次一个稳定 class。
   * @param {Element} el
   */
  function buildReadablePath(el) {
    const parts = []
    let current = el
    while (current && current !== document.documentElement && parts.length < MAX_READABLE_PATH_DEPTH) {
      const tag = current.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') {
        break
      }
      let label = tag
      const aria = current.getAttribute('aria-label')
      const role = current.getAttribute('role')
      const stableClasses = getStableClasses(current, 1)
      if (current.id && !scope.__EG__.containsSecret(current.id)) {
        label = '#' + cssEscape(current.id)
      } else if (aria && !scope.__EG__.containsSecret(aria)) {
        label = tag + '[aria-label="' + scope.__EG__.clampStr(aria, 40).replace(/"/g, '\\"') + '"]'
      } else if (role && !scope.__EG__.containsSecret(role)) {
        label = tag + '[role="' + scope.__EG__.clampStr(role, 30).replace(/"/g, '\\"') + '"]'
      } else if (stableClasses.length > 0) {
        label = '.' + cssEscape(stableClasses[0])
      }
      parts.unshift(label)
      current = current.parentElement
    }
    return scope.__EG__.clampStr(parts.join(' > '), scope.__EG__.BUDGET.pathMaxLength)
  }

  /**
   * 原始 DOM 路径：只用 tag/class，不做唯一性判定，供人做交叉核对。
   * @param {Element} el
   */
  function buildFullPath(el) {
    const parts = []
    let current = el
    while (
      current &&
      current.nodeType === Node.ELEMENT_NODE &&
      current !== document.documentElement &&
      parts.length < MAX_FULL_PATH_DEPTH
    ) {
      parts.unshift(buildSelectorPart(current))
      current = current.parentElement
    }
    return scope.__EG__.clampStr(parts.join(' > '), scope.__EG__.BUDGET.pathMaxLength)
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.cssEscape = cssEscape
  scope.__EG__.looksHashy = looksHashy
  scope.__EG__.getStableClasses = getStableClasses
  scope.__EG__.buildSelectorPart = buildSelectorPart
  scope.__EG__.isUniqueSelector = isUniqueSelector
  scope.__EG__.getNthOfTypeSuffix = getNthOfTypeSuffix
  scope.__EG__.buildSelector = buildSelector
  scope.__EG__.buildReadablePath = buildReadablePath
  scope.__EG__.buildFullPath = buildFullPath
})(globalThis)
