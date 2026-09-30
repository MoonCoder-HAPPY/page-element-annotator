// @ts-check
/**
 * 元素上下文抽取。全部是**只读 DOM 操作**，不得改动页面状态。
 *
 * 安全提示（spec §10.4 的设计原则）：本文件产出的是 **raw payload**，
 * service worker 侧的 `sanitize.js` 会对它**完整重算一遍**，不信任这里的任何声明。
 * 也就是说这里做脱敏只是为了减少传输量，**不是安全边界**。
 */
;(function attachExtractor(scope) {
  'use strict'

  const MAX_ARIA_LABELLEDBY_IDS = 32

  /**
   * 读取选区文本。只覆盖 §10.1 的 `selectedText` 字段。
   */
  function getSelectedText() {
    try {
      const selection = window.getSelection ? window.getSelection() : null
      if (!selection || selection.rangeCount === 0) {
        return ''
      }
      const budget = scope.__EG__.BUDGET.selectedTextMaxLength
      const acc = scope.__EG__.createTextAccumulator()
      let inspected = 0
      for (let i = 0; i < selection.rangeCount && acc.text.length < budget + 20; i++) {
        const range = selection.getRangeAt(i)
        const walkerRoot = range.commonAncestorContainer
        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            if (range.intersectsNode && !range.intersectsNode(node)) {
              return NodeFilter.FILTER_REJECT
            }
            return NodeFilter.FILTER_ACCEPT
          }
        })
        let node = walkerRoot.nodeType === Node.TEXT_NODE ? walkerRoot : walker.nextNode()
        while (
          node &&
          acc.text.length < budget + 20 &&
          inspected < scope.__EG__.TEXT_NODE_SCAN_LIMIT
        ) {
          inspected++
          const textNode = node
          let value = textNode.nodeValue || ''
          scope.__EG__.appendTextSeparator(acc)
          const remaining = budget + 20 - acc.text.length - (acc.pendingSpace ? 1 : 0)
          if (remaining <= 0) {
            break
          }
          if (value) {
            let start = textNode === range.startContainer ? range.startOffset : 0
            let end = textNode === range.endContainer ? range.endOffset : value.length
            if (end > start + remaining) {
              end = start + remaining
            }
            if (textNode === range.startContainer) {
              start = Math.min(start, value.length)
            }
            value = value.slice(start, end)
            scope.__EG__.appendNormalizedText(acc, value, budget)
          }
          node = walker.nextNode()
        }
      }
      return scope.__EG__.finishAccumulatedText(acc, budget)
    } catch (error) {
      return ''
    }
  }

  /**
   * HTML 片段。移除 `<script>` 内容。
   *
   * ⚠️ 已知缺口（由 ticket 03 的 S-1 修正）：`<style>` 内容尚未移除，
   * `type=password|hidden` 的 `value` 会随 `outerHTML` 一并带出，
   * 且本字段与 `textSnippet` 目前都不做机密扫描。
   * @param {Element} el
   */
  function getHtmlSnippet(el) {
    const clone = /** @type {Element} */ (el.cloneNode(true))
    const scripts = clone.querySelectorAll('script')
    for (let i = 0; i < scripts.length; i++) {
      scripts[i].remove()
    }
    const html = clone.outerHTML || ''
    return scope.__EG__.clampStr(html, scope.__EG__.BUDGET.htmlSnippetMaxLength)
  }

  /**
   * 属性白名单过滤 + 机密值替换 + URL 属性净化。
   * @param {Element} el
   * @returns {Record<string, string>}
   */
  function getSafeAttributes(el) {
    /** @type {Record<string, string>} */
    const attrs = {}
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i]
      const name = attr.name.toLowerCase()
      if (!scope.__EG__.isSafeAttributeName(name)) {
        continue
      }
      const value = attr.value
      if (scope.__EG__.containsSecret(value)) {
        attrs[name] = '[redacted]'
      } else if ((name === 'href' || name === 'src' || name === 'action') && value) {
        attrs[name] = scope.__EG__.sanitizeUrl(value)
      } else if (name === 'class') {
        attrs[name] = scope.__EG__.clampStr(value, 200)
      } else {
        attrs[name] = value
      }
    }
    return attrs
  }

  /**
   * 按空白码点切分 `aria-labelledby` 的 id 列表。
   * 手写扫描而不是正则切分：guest 页面控制这个属性的长度，正则会在大串上退化。
   * @param {string} value
   */
  function getAriaLabelledByIds(value) {
    const ids = []
    let tokenStart = -1
    for (let index = 0; index <= value.length; index++) {
      const isEnd = index === value.length
      if (!isEnd && !scope.__EG__.isWhitespaceCode(value.charCodeAt(index))) {
        if (tokenStart === -1) {
          tokenStart = index
        }
        continue
      }
      if (tokenStart !== -1) {
        ids.push(value.slice(tokenStart, index))
        tokenStart = -1
        if (ids.length >= MAX_ARIA_LABELLEDBY_IDS) {
          break
        }
      }
    }
    return ids
  }

  /**
   * @param {Element} el
   */
  function getAccessibility(el) {
    const role = el.getAttribute('role') || el.tagName.toLowerCase()
    const ariaLabel = el.getAttribute('aria-label') || null
    const ariaLabelledBy = el.getAttribute('aria-labelledby') || null
    /** @type {string|null} */
    let accessibleName = null
    if (ariaLabel) {
      accessibleName = ariaLabel
    } else if (ariaLabelledBy) {
      const parts = getAriaLabelledByIds(ariaLabelledBy)
      const names = []
      for (let i = 0; i < parts.length; i++) {
        const ref = document.getElementById(parts[i])
        if (ref) {
          names.push(scope.__EG__.getBoundedText(ref, 100))
        }
      }
      if (names.length) {
        accessibleName = names.join(' ')
      }
    } else {
      const tag = el.tagName.toLowerCase()
      if (tag === 'button' || tag === 'a' || tag === 'label') {
        accessibleName = scope.__EG__.getBoundedText(el, 100)
      } else if (el.getAttribute('title')) {
        accessibleName = el.getAttribute('title')
      } else if (el.getAttribute('alt')) {
        accessibleName = el.getAttribute('alt')
      }
    }
    return { role, accessibleName, ariaLabel, ariaLabelledBy }
  }

  /**
   * 计算样式子集。只调用一次 `getComputedStyle`，逐项用 `getPropertyValue`
   * 读 16 个属性，避免每个属性各走一次样式系统。
   * @param {Element} el
   * @returns {Record<string, string>}
   */
  function getComputedStyleSubset(el) {
    /** @type {Record<string, string>} */
    const result = {}
    const computed = window.getComputedStyle(el)
    for (const prop of scope.__EG__.STYLE_PROPS) {
      const cssName = prop.replace(/[A-Z]/g, function (m) {
        return '-' + m.toLowerCase()
      })
      result[prop] = computed.getPropertyValue(cssName) || ''
    }
    return result
  }

  /**
   * 邻近文本：从相邻兄弟节点交替向外取，直到取满或扫描超限。
   * @param {Element} el
   */
  function getNearbyText(el) {
    /** @type {string[]} */
    const results = []
    const parent = el.parentElement
    if (!parent) {
      return results
    }
    const budget = scope.__EG__.BUDGET
    const limit = scope.__EG__.NEARBY_ELEMENT_SCAN_LIMIT

    /**
     * @param {Element|null} sibling
     */
    function addSiblingText(sibling) {
      if (!sibling) {
        return
      }
      const text = scope.__EG__.getBoundedText(sibling, budget.nearbyTextEntryMaxLength)
      if (text) {
        results.push(scope.__EG__.clampStr(text, budget.nearbyTextEntryMaxLength))
      }
    }

    let inspected = 0
    let previous = el.previousElementSibling
    let next = el.nextElementSibling
    while (results.length < budget.nearbyTextMaxEntries && inspected < limit && (previous || next)) {
      if (previous) {
        const previousSibling = previous
        previous = previous.previousElementSibling
        inspected++
        addSiblingText(previousSibling)
      }
      if (next && results.length < budget.nearbyTextMaxEntries && inspected < limit) {
        const nextSibling = next
        next = next.nextElementSibling
        inspected++
        addSiblingText(nextSibling)
      }
    }
    return results
  }

  /**
   * 邻近元素摘要（`tag.class "文本"`）。参考实现采集了它但两个 formatter 都没用；
   * 本案保留，供 side panel 详情与批量导出使用（见实现报告决策 I-5）。
   * @param {Element} el
   */
  function getNearbyElements(el) {
    const parent = el.parentElement
    if (!parent) {
      return []
    }
    /** @type {string[]} */
    const result = []
    const budget = scope.__EG__.BUDGET
    const limit = scope.__EG__.NEARBY_ELEMENT_SCAN_LIMIT

    /**
     * @param {Element|null} sibling
     */
    function addSibling(sibling) {
      if (!sibling || sibling === el) {
        return
      }
      const rect = sibling.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        return
      }
      let label = sibling.tagName.toLowerCase()
      const stableClasses = scope.__EG__.getStableClasses(sibling, 1)
      if (stableClasses.length > 0) {
        label += '.' + stableClasses[0]
      }
      const text = scope.__EG__.getBoundedText(sibling, 50)
      if (text) {
        label += ' "' + scope.__EG__.clampStr(text, 50) + '"'
      }
      result.push(scope.__EG__.clampStr(label, budget.nearbyElementMaxLength))
    }

    let inspected = 0
    let previous = el.previousElementSibling
    let next = el.nextElementSibling
    while (
      result.length < budget.nearbyElementsMaxEntries &&
      inspected < limit &&
      (previous || next)
    ) {
      if (previous) {
        const previousSibling = previous
        previous = previous.previousElementSibling
        inspected++
        addSibling(previousSibling)
      }
      if (next && result.length < budget.nearbyElementsMaxEntries && inspected < limit) {
        const nextSibling = next
        next = next.nextElementSibling
        inspected++
        addSibling(nextSibling)
      }
    }
    return result
  }

  /**
   * 祖先路径（`tag[role=...]`）。
   * @param {Element} el
   */
  function getAncestorPath(el) {
    /** @type {string[]} */
    const path = []
    let current = el.parentElement
    while (
      current &&
      current !== document.documentElement &&
      path.length < scope.__EG__.BUDGET.ancestorPathMaxEntries
    ) {
      const tag = current.tagName.toLowerCase()
      const role = current.getAttribute('role')
      path.push(role ? tag + '[role=' + role + ']' : tag)
      current = current.parentElement
    }
    return path
  }

  /**
   * 页面级上下文。
   */
  function getPageContext() {
    return {
      sanitizedUrl: scope.__EG__.sanitizeUrl(location.href),
      title: scope.__EG__.clampStr(document.title || '', 500),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
      capturedAt: new Date().toISOString()
    }
  }

  /**
   * @param {DOMRect} rect
   */
  function toPlainRect(rect) {
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    }
  }

  /**
   * 抽取一个元素的完整 raw payload。
   *
   * 副作用约定：只读。不修改 DOM、不写 localStorage、不发请求。
   * @param {Element} el
   */
  function extractPayload(el) {
    const rect = el.getBoundingClientRect()
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const selector = scope.__EG__.buildSelector(el)
    // 源码定位整体可失效：拿不到就返回 null，由格式化器输出诚实缺省文案（spec §9.2）。
    const located =
      typeof scope.__EG__.locateSource === 'function'
        ? scope.__EG__.locateSource(el)
        : { sourceFile: null, reactComponents: null }

    return {
      page: getPageContext(),
      target: {
        tagName: el.tagName.toLowerCase(),
        selector,
        elementPath: scope.__EG__.buildReadablePath(el),
        fullPath: scope.__EG__.buildFullPath(el),
        cssClasses: scope.__EG__.clampStr(
          el.getAttribute('class') || '',
          scope.__EG__.BUDGET.cssClassesMaxLength
        ),
        nearbyElements: getNearbyElements(el),
        selectedText: getSelectedText() || null,
        isFixed: isInFixedPositioning(el),
        reactComponents: located.reactComponents,
        sourceFile: located.sourceFile,
        textSnippet: scope.__EG__.getTextSnippet(el),
        htmlSnippet: getHtmlSnippet(el),
        attributes: getSafeAttributes(el),
        accessibility: getAccessibility(el),
        rectViewport: toPlainRect(rect),
        rectPage: {
          x: rect.left + scrollX,
          y: rect.top + scrollY,
          width: rect.width,
          height: rect.height
        },
        computedStyles: getComputedStyleSubset(el)
      },
      nearbyText: getNearbyText(el),
      ancestorPath: getAncestorPath(el),
      screenshot: null
    }
  }

  /**
   * 祖先链上是否存在 fixed/sticky 定位 —— 这类元素滚动时会跟随视口，
   * 影响"元素在视口外"的判断，因此需要单独标记。
   * @param {Element} el
   */
  function isInFixedPositioning(el) {
    try {
      let current = el
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const position = window.getComputedStyle(current).position
        if (position === 'fixed' || position === 'sticky') {
          return true
        }
        current = current.parentElement
      }
    } catch (error) {
      return false
    }
    return false
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.getSelectedText = getSelectedText
  scope.__EG__.getHtmlSnippet = getHtmlSnippet
  scope.__EG__.getSafeAttributes = getSafeAttributes
  scope.__EG__.getAriaLabelledByIds = getAriaLabelledByIds
  scope.__EG__.getAccessibility = getAccessibility
  scope.__EG__.getComputedStyleSubset = getComputedStyleSubset
  scope.__EG__.getNearbyText = getNearbyText
  scope.__EG__.getNearbyElements = getNearbyElements
  scope.__EG__.getAncestorPath = getAncestorPath
  scope.__EG__.getPageContext = getPageContext
  scope.__EG__.isInFixedPositioning = isInFixedPositioning
  scope.__EG__.extractPayload = extractPayload
})(globalThis)
