// @ts-check
/**
 * 文本归一化：用 `TreeWalker(SHOW_TEXT)` 自己拼文本，**不使用 `innerText`**。
 *
 * 为什么不能用 `innerText`：读取它会强制一次布局（reflow）。spec §12 把"抽取阶段
 * 强制 reflow 次数 = 0"定为硬约束，因为抓取发生在用户点击的瞬间，一次 reflow 在
 * 大页面上就是几十毫秒的体感延迟。
 *
 * 归一化语义与参考实现一致（`orca/src/main/browser/grab-guest-foundation-script.ts`）：
 * 任意空白折叠成单个空格；文本节点之间保留一个分隔空格；首尾不出现空格。
 */
;(function attachTextNormalizer(scope) {
  'use strict'

  /**
   * 参考实现逐个列举的空白码点。之所以不直接用 `\s`：
   * `\s` 在不同引擎上对 U+FEFF、U+3000 等的处理不一致，而这里要对齐
   * "浏览器渲染时看不见但占位"的那一批码点。
   * @param {number} code
   */
  function isWhitespaceCode(code) {
    return (
      code === 32 ||
      (code >= 9 && code <= 13) ||
      code === 160 ||
      code === 5760 ||
      (code >= 8192 && code <= 8202) ||
      code === 8232 ||
      code === 8233 ||
      code === 8239 ||
      code === 8287 ||
      code === 12288 ||
      code === 65279
    )
  }

  /**
   * @returns {{ text: string, pendingSpace: boolean }}
   */
  function createTextAccumulator() {
    return { text: '', pendingSpace: false }
  }

  /**
   * 声明"下一个非空白字符之前要插一个空格"。
   * @param {{ text: string, pendingSpace: boolean }} acc
   */
  function appendTextSeparator(acc) {
    if (acc.text.length > 0) {
      acc.pendingSpace = true
    }
  }

  /**
   * @param {{ text: string, pendingSpace: boolean }} acc
   * @param {string} value
   * @param {number} max
   */
  function appendNormalizedText(acc, value, max) {
    // 多留 20 个码元，让后续 clamp 有空间追加 " (truncated)" 而不是先把内容切掉。
    const limit = max + 20
    const text = String(value || '')
    for (let i = 0; i < text.length && acc.text.length < limit; i++) {
      const code = text.charCodeAt(i)
      if (isWhitespaceCode(code)) {
        if (acc.text.length > 0) {
          acc.pendingSpace = true
        }
        continue
      }
      if (acc.pendingSpace) {
        acc.text += ' '
        acc.pendingSpace = false
        if (acc.text.length >= limit) {
          break
        }
      }
      acc.text += text.charAt(i)
    }
  }

  /**
   * @param {{ text: string, pendingSpace: boolean }} acc
   * @param {number} max
   */
  function finishAccumulatedText(acc, max) {
    return scope.__EG__.clampStr(acc.text, max)
  }

  /**
   * 取元素的有界可见文本。
   * @param {Element} el
   * @param {number} max
   */
  function getBoundedText(el, max) {
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const acc = createTextAccumulator()
      let inspected = 0
      let node = walker.nextNode()
      while (node && acc.text.length < max + 20 && inspected < scope.__EG__.TEXT_NODE_SCAN_LIMIT) {
        inspected++
        appendTextSeparator(acc)
        const remaining = max + 20 - acc.text.length - (acc.pendingSpace ? 1 : 0)
        if (remaining <= 0) {
          break
        }
        appendNormalizedText(acc, (node.nodeValue || '').slice(0, remaining), max)
        node = walker.nextNode()
      }
      return finishAccumulatedText(acc, max)
    } catch (error) {
      // 页面可能持有异常的 TreeWalker 桩（或节点已分离）；返回空串而不是冒泡，
      // 因为文本缺失不该让整次抓取失败。
      return ''
    }
  }

  /**
   * @param {Element} el
   */
  function getTextSnippet(el) {
    return getBoundedText(el, scope.__EG__.BUDGET.textSnippetMaxLength)
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.isWhitespaceCode = isWhitespaceCode
  scope.__EG__.createTextAccumulator = createTextAccumulator
  scope.__EG__.appendTextSeparator = appendTextSeparator
  scope.__EG__.appendNormalizedText = appendNormalizedText
  scope.__EG__.finishAccumulatedText = finishAccumulatedText
  scope.__EG__.getBoundedText = getBoundedText
  scope.__EG__.getTextSnippet = getTextSnippet
})(globalThis)
