// @ts-check
/**
 * 抓取模式的视觉层：全视口捕获器 + 高亮框 + 元素标签。
 *
 * ## 三个关键实现点（都不是随手选的）
 *
 * 1. **捕获器是宿主，高亮层是兄弟**。宿主是全视口 `pointer-events:all` 的元素，负责接住
 *    所有指针事件；高亮框与标签放在它内部的 `pointer-events:none` 容器里，
 *    这样它们不会自己挡住命中测试。
 *
 * 2. **命中测试要临时让渡指针事件**。overlay 自己是覆盖全屏的，`elementFromPoint`
 *    会命中 overlay 而不是页面元素。所以每次命中测试前把宿主设成
 *    `pointer-events:none`，测完立刻复原 —— 同步完成，不跨帧，所以没有可见闪烁。
 *
 * 3. **高亮框用双层描边**（内白边 + 外深色阴影）。单色描边在某个背景上一定会消失；
 *    双层保证在浅色和深色页面上都能看清（spec §14.13）。
 *
 * 全部样式写在 closed shadow root 内，既不读页面 CSS 变量也不污染页面样式。
 */
;(function attachOverlay(scope) {
  'use strict'

  const ns = (scope.__EG__ = scope.__EG__ || {})

  const HOST_ID = '__eg-grab-host'

  /** 高亮框与标签的尺寸/位置常量，抽出来便于单测。 */
  const HIGHLIGHT_BORDER_PX = 2
  const LABEL_GAP_PX = 6
  const LABEL_RESERVED_HEIGHT_PX = 28
  const LABEL_MAX_TEXT_LENGTH = 40
  const LABEL_TRUNCATED_SUFFIX = '...'

  /**
   * 标签文案：`tag  role=...  "文本"  宽x高`。纯函数，可单测。
   * @param {Element} el
   * @param {DOMRect} rect
   * @param {string} text
   */
  function buildLabelText(el, rect, text) {
    const parts = [el.tagName.toLowerCase()]
    const role = el.getAttribute('role')
    if (role) {
      parts.push('role=' + role)
    }
    if (text) {
      const clipped =
        text.length > LABEL_MAX_TEXT_LENGTH
          ? scope.__EG__.sliceAtCodeUnitLimit(
              text,
              LABEL_MAX_TEXT_LENGTH - LABEL_TRUNCATED_SUFFIX.length
            ) + LABEL_TRUNCATED_SUFFIX
          : text
      parts.push('"' + clipped + '"')
    }
    parts.push(Math.round(rect.width) + 'x' + Math.round(rect.height))
    return parts.join('  ')
  }

  /**
   * 标签纵向位置：默认放在元素下方，贴到视口底部时改放上方。
   * @param {DOMRect} rect
   * @param {number} viewportHeight
   */
  function resolveLabelTop(rect, viewportHeight) {
    const below = rect.bottom + LABEL_GAP_PX
    if (below + LABEL_RESERVED_HEIGHT_PX > viewportHeight) {
      return Math.max(0, rect.top - LABEL_RESERVED_HEIGHT_PX)
    }
    return below
  }

  /**
   * 元素与视口的相交矩形。
   *
   * 元素纵向或横向超出视口时，高亮框按**可见部分**绘制，否则一个比屏幕还高的元素
   * 会画出一个延伸到屏幕外的框。
   *
   * 必须先判"完全不相交"再各自钳制：只做 `max/min` 钳制的话，一个完全在视口下方的
   * 元素会得到 `width=100, height=0` 这种自相矛盾的框（左右没越界、上下全越界），
   * 调用方看到非零宽度就会画出一条贴着屏幕底边的线。
   *
   * @param {DOMRect} rect
   * @param {number} viewportWidth
   * @param {number} viewportHeight
   */
  function resolveHighlightBox(rect, viewportWidth, viewportHeight) {
    const intersects =
      rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight
    if (!intersects) {
      return { left: 0, top: 0, width: 0, height: 0 }
    }

    const left = Math.max(0, rect.left)
    const top = Math.max(0, rect.top)
    const right = Math.min(viewportWidth, rect.right)
    const bottom = Math.min(viewportHeight, rect.bottom)
    return {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    }
  }

  /**
   * 是否应当禁用过渡动画。
   */
  function prefersReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch (error) {
      return false
    }
  }

  /** @type {HTMLElement|null} */
  let host = null
  /** @type {ShadowRoot|null} */
  let shadow = null
  /** @type {HTMLElement|null} */
  let highlightBox = null
  /** @type {HTMLElement|null} */
  let hoverLabel = null
  /** @type {Element|null} */
  let currentElement = null
  /** @type {Element|null} */
  let frozenElement = null
  /** 截图期间整体隐藏（含捕获器），避免把高亮框拍进图里。 */
  let suppressed = false

  function isMounted() {
    return Boolean(host && host.isConnected)
  }

  /**
   * 整体隐藏 / 恢复。
   *
   * 隐藏时把宿主 `display:none` —— 截图那一拍里既不会拍到自己，也不会干扰页面。
   *
   * ⚠️ 恢复时**不能**把 `pointer-events` 设成 `all`（见 `mount` 里那段说明）。
   *
   * @param {boolean} value
   */
  function setSuppressed(value) {
    suppressed = Boolean(value)
    if (!host) {
      return
    }
    host.style.display = suppressed ? 'none' : ''
  }

  function isSuppressed() {
    return suppressed
  }

  function mount() {
    if (isMounted()) {
      return
    }
    teardown()

    host = document.createElement('div')
    host.id = HOST_ID
    host.style.cssText = [
      'all:initial',
      'position:fixed',
      'top:0',
      'left:0',
      'width:100vw',
      'height:100vh',
      'z-index:2147483647',
      /*
       * ⚠️ **`pointer-events:none` —— 绝不能改成 `all`。**
       *
       * 真机反馈："我首次点击悬停注释以后放在了一个具有hover展示的按钮上，它没有出现，
       * 当我点击1次注释以后……此时再把悬停注释移动到这个有hover展示的按钮上，
       * 此时就会出现hover效果了，这时候才可以注释成功。"
       *
       * 原来这里是 `all`：宿主是全视口覆盖层，于是**页面收不到任何指针事件**，
       * `mouseenter` 不触发 → hover 才出现的内容永远不出现。
       * 而"走一遍弹窗之后就好了"，是那一轮把宿主留在了 `none` ——
       * **一个 bug 偶然掩盖了另一个**，所以现象看起来时灵时不灵。
       *
       * 去掉它之后拾取器依然完全可用：
       *   · 事件监听挂在 `window` 的**捕获阶段**，与"谁吃到事件"无关；
       *   · 命中测试用 `elementFromPoint` —— 我们自己不吃事件，它反而直接返回
       *     页面真实元素，不再需要"临时让开再复原"那一套。
       *
       * 代价是光标不再由这里提供 —— 改由 `documentElement` 上的 `cursor` 承担
       * （见 `applyCursor`），这是元素选择器的常规做法。
       */
      'pointer-events:none'
    ].join(';')
    // 视觉层本身不该进可访问性树：它是给鼠标用的拾取工具。
    host.setAttribute('aria-hidden', 'true')

    shadow = host.attachShadow({ mode: 'closed' })

    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;'
    shadow.appendChild(overlay)

    highlightBox = document.createElement('div')
    highlightBox.style.cssText = [
      'position:fixed',
      `border:${HIGHLIGHT_BORDER_PX}px solid rgba(255,255,255,0.95)`,
      'border-radius:3px',
      'pointer-events:none',
      'display:none',
      'background:rgba(255,255,255,0.08)',
      // 外深内白：单色描边总会在某类页面上消失。
      'box-shadow:0 0 0 1px rgba(0,0,0,0.55),0 2px 10px rgba(0,0,0,0.25)',
      prefersReducedMotion() ? '' : 'transition:left .04s ease-out,top .04s ease-out,width .04s ease-out,height .04s ease-out'
    ]
      .filter(Boolean)
      .join(';')
    overlay.appendChild(highlightBox)

    hoverLabel = document.createElement('div')
    hoverLabel.style.cssText = [
      'position:fixed',
      'padding:3px 8px',
      'background:rgba(24,24,27,0.94)',
      'color:#f4f4f5',
      'font:11px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif',
      'border-radius:4px',
      'pointer-events:none',
      'white-space:nowrap',
      'display:none',
      'max-width:70vw',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'box-shadow:0 2px 8px rgba(0,0,0,0.35)'
    ].join(';')
    overlay.appendChild(hoverLabel)

    document.documentElement.appendChild(host)
    // mount 时若正处于抑制状态（例如截图流程中 overlay 被重建），保持一致。
    setSuppressed(suppressed)
    // 十字准星改由根元素提供（宿主不再吃指针事件，也就没法顺带给光标）。
    if (!suppressed) {
      applyCursor(true)
    }
  }

  function hideVisuals() {
    currentElement = null
    if (highlightBox) {
      highlightBox.style.display = 'none'
    }
    if (hoverLabel) {
      hoverLabel.style.display = 'none'
    }
  }

  /**
   * 更新高亮框与标签。
   * @param {Element|null} el
   */
  function updateHighlight(el) {
    if (!isMounted() || !highlightBox || !hoverLabel) {
      return
    }
    if (!el || el === document.documentElement || el === document.body) {
      hideVisuals()
      return
    }
    if (!el.isConnected) {
      hideVisuals()
      return
    }

    currentElement = el
    const rect = el.getBoundingClientRect()
    const box = resolveHighlightBox(rect, window.innerWidth, window.innerHeight)
    if (box.width === 0 && box.height === 0) {
      hideVisuals()
      return
    }

    highlightBox.style.left = box.left + 'px'
    highlightBox.style.top = box.top + 'px'
    highlightBox.style.width = box.width + 'px'
    highlightBox.style.height = box.height + 'px'
    highlightBox.style.display = 'block'

    const text = scope.__EG__.getBoundedText(el, LABEL_MAX_TEXT_LENGTH)
    hoverLabel.textContent = buildLabelText(el, rect, text)
    hoverLabel.style.left = Math.max(4, rect.left) + 'px'
    hoverLabel.style.top = resolveLabelTop(rect, window.innerHeight) + 'px'
    hoverLabel.style.display = 'block'
  }

  /**
   * 我们自己插进页面的几个宿主元素（overlay／胶囊／注释框）。
   *
   * 它们都是覆盖全屏或固定定位的容器，所以**会被 `elementFromPoint` 与
   * `composedPath` 当成页面元素**。注释框是最后加的，我第一次忘了把它算进来，
   * 结果抓取会把 `div#element-grab-dialog-host` 自己当成目标元素抓走
   * （真机测试立刻抓到：`Selector: div#element-grab-dialog-host`）。
   *
   * ## 为什么按前缀而不是白名单
   *
   * 新增宿主时不用回来改这里。但**前缀本身有历史包袱**：overlay 用的是
   * `__eg-grab-host`，另外两个用的是 `element-grab-*-host`。我第一版只认后者，
   * 于是 overlay 又被当成页面元素抓走（真机断言：`hovered=__eg-grab-host`）。
   * 两个前缀都认，并统一收在这里，避免以后再加宿主时重复这个错误。
   *
   * @param {unknown} node
   * @returns {node is Element}
   */
  function isOurOwnUi(node) {
    if (!(node instanceof Element) || typeof node.id !== 'string') {
      return false
    }
    return node.id.indexOf('element-grab-') === 0 || node.id.indexOf('__eg-grab') === 0
  }

  /**
   * 命中测试：临时让渡指针事件，取该坐标下的真实元素，立刻复原。
   *
   * 让渡与复原是**同步**完成的（中间没有 await / rAF），所以不会出现可见的闪烁，
   * 也不会给页面留下可观察的窗口。
   *
   * 注意 `elementFromPoint` 在 Shadow DOM 上返回的是 shadow host 而不是内部元素。
   * 真实目标由调用方用 `event.composedPath()[0]` 取，见 `picker.js`。
   *
   * @param {number} clientX
   * @param {number} clientY
   */
  function hitTest(clientX, clientY) {
    // 让渡的必须是**所有**我们自己的宿主，不只是 overlay：注释框打开时
    // 它覆盖全屏，只放开 overlay 的话命中的永远是注释框。
    const released = []
    try {
      for (const candidate of document.querySelectorAll(
        '[id^="element-grab-"],[id^="__eg-grab"]'
      )) {
        if (candidate instanceof HTMLElement) {
          released.push({ node: candidate, previous: candidate.style.pointerEvents })
          candidate.style.pointerEvents = 'none'
        }
      }
      const element = document.elementFromPoint(clientX, clientY)
      // 复原在 finally 之前、同步完成；命中我们自己的宿主时按"没命中"处理。
      return !element || isOurOwnUi(element) ? null : element
    } catch (error) {
      return null
    } finally {
      for (const entry of released) {
        entry.node.style.pointerEvents = entry.previous
      }
    }
  }

  /**
   * 取当前高亮的元素（供快捷键"抓 hover 元素"使用）。
   */
  function getCurrentElement() {
    return frozenElement || currentElement
  }

  /**
   * 待命期间把光标设成十字准星。
   *
   * 这一步以前是由宿主（全视口覆盖层）的 `cursor:crosshair` 顺带提供的 ——
   * 而那个覆盖层必须去掉（它会让页面收不到 hover）。改在 `documentElement`
   * 上设：这是元素选择器的常规做法，作用范围对，而且不拦任何事件。
   *
   * 关掉时**还原**用户页面原来的值，不留痕迹。
   */
  let previousRootCursor = null

  function applyCursor(on) {
    const root = document.documentElement
    if (!root) {
      return
    }
    if (on) {
      if (previousRootCursor === null) {
        previousRootCursor = root.style.cursor
      }
      root.style.cursor = 'crosshair'
      return
    }
    if (previousRootCursor !== null) {
      root.style.cursor = previousRootCursor
      previousRootCursor = null
    }
  }

  /**
   * 冻结高亮：选中之后保留高亮框让用户确认点对了，同时把光标恢复成普通箭头。
   */
  function freeze() {
    if (!isMounted() || !host) {
      return
    }
    frozenElement = currentElement
    applyCursor(false)
  }

  /**
   * 解除冻结并重新接管光标。
   */
  function unfreeze() {
    frozenElement = null
    // 抑制期间不要抢回光标，否则会把截图流程自己重新暴露出来。
    if (host && !suppressed) {
      applyCursor(true)
    }
  }

  function teardown() {
    hideVisuals()
    frozenElement = null
    // 把页面原来的光标还回去 —— 不留痕迹。
    applyCursor(false)
    if (host) {
      try {
        host.remove()
      } catch (error) {
        // 节点可能已被页面移除；没有别的可做的。
      }
    }
    host = null
    shadow = null
    highlightBox = null
    hoverLabel = null
  }

  ns.OVERLAY_HOST_ID = HOST_ID
  ns.isOurOwnUi = isOurOwnUi
  ns.buildLabelText = buildLabelText
  ns.resolveLabelTop = resolveLabelTop
  ns.resolveHighlightBox = resolveHighlightBox
  ns.mountOverlay = mount
  ns.teardownOverlay = teardown
  ns.updateOverlayHighlight = updateHighlight
  ns.hitTestForOverlay = hitTest
  ns.getOverlayCurrentElement = getCurrentElement
  ns.freezeOverlayHighlight = freeze
  ns.unfreezeOverlayHighlight = unfreeze
  ns.isOverlayMounted = isMounted
  ns.setOverlaySuppressed = setSuppressed
  ns.isOverlaySuppressed = isSuppressed

  /**
   * 高亮状态自报（测试用）。
   *
   * shadow root 是 **closed** 的，页面侧读不到那个高亮框 —— 而"注释期间高亮框
   * 常驻显示、且不跟着鼠标跑"是用户明确要求的行为，**必须能被验证**。
   * 与 `preview-overlay.js` 的 `__previewProbe` 同一风格。
   *
   * `frozen` 单独报出来，是因为 `getOverlayCurrentElement()` 返回的是
   * `frozenElement || currentElement` —— 光看它分辨不出"冻结住了"和
   * "鼠标恰好还停在同一个元素上"这两件事，而那正是要验的区别。
   *
   * @returns {object}
   */
  ns.__overlayHighlightProbe = function () {
    const rect = highlightBox ? highlightBox.getBoundingClientRect() : null
    return {
      mounted: isMounted(),
      frozen: frozenElement !== null,
      frozenSelector: frozenElement ? buildReadableName(frozenElement) : null,
      currentSelector: currentElement ? buildReadableName(currentElement) : null,
      // 框真的画着：有尺寸、且没被 hideVisuals 藏起来。
      visible: Boolean(rect && rect.width > 0 && rect.height > 0),
      rect: rect
        ? {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        : null
    }
  }

  /** 给探针用的元素标识：优先选择器，退到标签名。 */
  function buildReadableName(element) {
    if (!element) {
      return null
    }
    const selector = scope.__EG__.buildSelector ? scope.__EG__.buildSelector(element) : null
    if (selector) {
      return selector
    }
    return element.tagName ? element.tagName.toLowerCase() : null
  }
})(globalThis)
