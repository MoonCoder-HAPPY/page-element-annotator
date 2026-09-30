// @ts-check
/**
 * 截图预览浮层（注入到**当前页面**里）。
 *
 * ## 为什么在页面里而不是新标签页 / 侧边面板
 *
 * - 侧边面板只有约 320px，一张 1000px 宽的截图在那里怎么放大都看不清；
 * - 新标签页要看得到，但会**离开正在注释的页面** —— 而用户点缩略图时
 *   脑子里想的是"我刚才抓的这个东西长什么样"，跳走再跳回来是要付成本的。
 *
 * 用户的原话是"直接在当前页面打开，增加一个浮层显示"。页面占满主区域，
 * 尺寸够用，而且不打断手上的事。
 *
 * ## 结构
 *
 * 与其它页内 UI 一致：宿主挂在 `documentElement` 上、样式在 **closed shadow root**
 * 里（页面脚本读不到也改不了）。图片用 data URL，不发任何网络请求。
 */
;(function attachPreviewOverlay(scope) {
  'use strict'

  const HOST_ID = 'element-grab-preview-host'
  const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

  /** @type {{ dataUrl: string, width: number, height: number }|null} */
  let shot = null
  /** 当前浮层的 shadow root，供测试探针读坐标用。 */
  /** @type {ShadowRoot|null} */
  let shadowRoot = null
  /** 0 = 适应窗口（哨兵值，不是倍率）。 */
  let scale = 0
  /** @type {((event: KeyboardEvent) => void)|null} */
  let keyHandler = null

  function close() {
    const host = document.getElementById(HOST_ID)
    if (host) {
      host.remove()
    }
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler, true)
      keyHandler = null
    }
    shot = null
    scale = 0
    shadowRoot = null
    // 清掉滚轮余量：否则"滚到一半关掉、再打开"会继承上次的半格，
    // 新浮层一上来就被推走一档。
    wheelAccum = 0
    wheelLastAt = 0
  }

  function isOpen() {
    return document.getElementById(HOST_ID) !== null
  }

  // ---------------------------------------------------------------------------
  // 滚轮的累积状态
  // ---------------------------------------------------------------------------
  //
  // ⚠️ 这些必须放在**模块作用域**，不能放进 `show()` 里。
  //
  // 我第一版把它们写在 `zoomAtPointer` 旁边 —— 而那是 `show()` 内部的嵌套函数，
  // 于是模块级的 `close()` 引用不到，一调用就 `wheelAccum is not defined`。
  // （`node --check` 查不出这种作用域错误，只有真的跑到那一行才会炸。）

  /** 累积到这么多像素当量，才算"滚了一格"。 */
  const WHEEL_STEP_DELTA = 100
  /**
   * 上一次滚轮事件的时间。
   *
   * 用来**丢弃惯性余波**：触控板抬手之后还会继续发几十个惯性事件，
   * 那些事件的累积量会再次越过阈值，于是用户早已停手、画面还在继续缩放。
   */
  const WHEEL_IDLE_MS = 260
  let wheelAccum = 0
  let wheelLastAt = 0

  /**
   * 测试探针。
   *
   * 浮层用的是 **closed** shadow root —— 页面脚本查不到内部元素，这是有意的
   * （挡住页面对我们 UI 的读写）。代价是测试也没法直接拿到按钮坐标。
   *
   * 所以内部把关键矩形报出来，测试再用 **CDP 真实鼠标事件**点它：
   * 真实事件会经过浏览器的命中测试进入 shadow DOM，因此验的是真路径，
   * 而不是"在外部模拟一次点击"。
   */
  function probe() {
    if (!isOpen() || !shadowRoot) {
      return { open: false, scale, hasBackground: false }
    }
    const rect = (selector) => {
      const node = shadowRoot.querySelector(selector)
      if (!node) {
        return null
      }
      const box = node.getBoundingClientRect()
      return {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
        width: Math.round(box.width),
        height: Math.round(box.height)
      }
    }
    return {
      open: true,
      scale,
      level: (shadowRoot.querySelector('.level') || {}).textContent || '',
      zoomIn: rect('[title^="放大"]'),
      zoomOut: rect('[title^="缩小"]'),
      fitButton: rect('[title^="适应窗口"]'),
      actualButton: rect('[title^="原始尺寸"]'),
      closeButton: rect('[title^="关闭"]'),
      bar: rect('.bar'),
      image: rect('img')
    }
  }

  /**
   * 最小可用样式。刻意不引外部 CSS：内容脚本的样式必须自包含，
   * 而且要挡住页面自己的 `* { }` 规则（用 closed shadow root 已经隔开了）。
   */
  const STYLE = `
    :host { all: initial; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0, 0, 0, 0.72);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      display: flex; flex-direction: column;
      font: 400 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    .bar {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      background: rgba(44, 44, 46, 0.92); color: #f2f2f7;
      border-bottom: 1px solid rgba(84, 84, 88, 0.5);
    }
    .meta { flex: 1 1 auto; min-width: 0; color: rgba(235,235,245,.62); font-size: 12px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .level { min-width: 52px; text-align: center; font-family: ui-monospace, Menlo, monospace;
             font-size: 12px; color: rgba(235,235,245,.82); }
    button {
      font: inherit; padding: 6px 12px; border: 0; border-radius: 8px;
      background: rgba(120,120,128,.32); color: #f2f2f7; font-size: 12px; cursor: pointer;
    }
    button:hover { background: rgba(120,120,128,.48); }
    button:disabled { opacity: .35; cursor: not-allowed; }
    .stage {
      flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center;
      padding: 14px; overflow: auto;
    }
    .stage.plain { padding: 0; }
    img { max-width: 100%; max-height: 100%; object-fit: contain;
          background: #fff; border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,.5); cursor: zoom-in; }
  `

  /**
   * @param {{ dataUrl: string, width: number, height: number }} value
   */
  function show(value) {
    close()
    shot = value

    const host = document.createElement('div')
    host.id = HOST_ID
    // 宿主本身不参与布局，一切都在 shadow 里的 fixed 元素上。
    host.style.cssText = 'all: initial; position: static;'

    const shadow = host.attachShadow({ mode: 'closed' })
    shadowRoot = shadow
    const style = document.createElement('style')
    style.textContent = STYLE
    shadow.appendChild(style)

    const backdrop = document.createElement('div')
    backdrop.className = 'backdrop'

    const bar = document.createElement('div')
    bar.className = 'bar'

    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent =
      `${value.width} × ${value.height} 像素 · 按 Esc 关闭 · 双击图片切换 100%/适应`

    const level = document.createElement('span')
    level.className = 'level'

    const makeButton = (label, title, onClick) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.title = title
      button.addEventListener('click', onClick)
      return button
    }

    const stage = document.createElement('div')
    stage.className = 'stage'

    const image = document.createElement('img')
    image.src = value.dataUrl
    image.alt = '元素截图'

    function currentIndex() {
      if (scale === 0) {
        return -1
      }
      let closest = 0
      let best = Infinity
      for (let i = 0; i < STEPS.length; i++) {
        const distance = Math.abs(STEPS[i] - scale)
        if (distance < best) {
          best = distance
          closest = i
        }
      }
      return closest
    }

    function applyZoom() {
      if (scale === 0) {
        image.style.maxWidth = '100%'
        image.style.maxHeight = '100%'
        image.style.width = ''
        image.style.height = ''
        stage.classList.remove('plain')
        level.textContent = '适应'
      } else {
        // 指定倍率：按**原始像素**算，不受容器限制（超出就滚动）。
        // 看截图细节时最需要的就是这个"不缩"的状态。
        image.style.maxWidth = 'none'
        image.style.maxHeight = 'none'
        image.style.width = Math.round(value.width * scale) + 'px'
        image.style.height = 'auto'
        stage.classList.add('plain')
        level.textContent = Math.round(scale * 100) + '%'
      }
      minusButton.disabled = scale !== 0 && currentIndex() <= 0
      plusButton.disabled = scale !== 0 && currentIndex() >= STEPS.length - 1
    }

    function stepZoom(direction) {
      const index = currentIndex()
      if (direction > 0) {
        // 从"适应"放大时落到 100%：适应窗口的实际倍率因图而异，
        // 用"下一档"会让用户觉得按了没变化。
        scale = index === -1 ? 1 : STEPS[Math.min(STEPS.length - 1, index + 1)]
      } else {
        scale = index === -1 ? 0.5 : STEPS[Math.max(0, index - 1)]
      }
      applyZoom()
    }

    /**
     * 以**光标位置**为中心缩放。
     *
     * 不以光标为中心的话，放大后想看的那块会跑出视野，用户还得再滚回去找 ——
     * 滚轮缩放的便利就丢了一半。做法是记下缩放前光标落在图片的哪个相对位置，
     * 缩放后把滚动位置调整回去，让那一点仍在光标下。
     *
     * @param {number} deltaY
     * @param {number} clientX
     * @param {number} clientY
     */
    /**
     * 以**光标位置**为中心，走一档缩放。
     *
     * @param {number} direction +1 放大，-1 缩小
     * @param {number} clientX
     * @param {number} clientY
     */
    function zoomAtPointer(direction, clientX, clientY) {
      const index = currentIndex()
      // ⚠️ 这里必须**查表** `STEPS[...]`，不能直接用下标。
      //
      // 我重构这个函数时（把入参从 `deltaY` 换成 `direction`）漏掉了查表，
      // 于是 `scale` 被赋成了**数组下标**（0/1/2…7），根本不是 25%/150%/400%
      // 那些倍率 —— 每次滚轮都会跳到一个毫无意义的尺寸上。
      // 用户看到的就是"放大不是一步一步放大，放小也不是"。
      //
      // `node --check` 查不出：赋值语法完全合法，类型也都是 number。
      const next =
        direction > 0
          ? index === -1
            ? 1
            : STEPS[Math.min(STEPS.length - 1, index + 1)]
          : index === -1
            ? 0.5
            : STEPS[Math.max(0, index - 1)]

      // 缩放前：光标在**图片内容**上的相对位置（0–1）。用图片自身的矩形算，
      // 而不是 stage 的 —— 图片可能比 stage 大也可能小。
      const before = image.getBoundingClientRect()
      const ratioX = before.width > 0 ? (clientX - before.left) / before.width : 0.5
      const ratioY = before.height > 0 ? (clientY - before.top) / before.height : 0.5

      if (next === scale) {
        return
      }
      scale = next
      applyZoom()

      // 缩放后：把那一点挪回光标下。`applyZoom` 之后布局已经更新，
      // 所以这里读到的是新的 rect。
      const after = image.getBoundingClientRect()
      const targetX = after.left + after.width * ratioX
      const targetY = after.top + after.height * ratioY
      stage.scrollLeft += targetX - clientX
      stage.scrollTop += targetY - clientY
    }

    /**
     * 滚轮缩放。
     *
     * 分两种情况，因为**两者都需要**：
     *   - 图片没有溢出（"适应"或更小）：滚轮就是缩放，此时没有内容可滚，
     *     不拦的话会去滚页面；
     *   - 图片已经放大到溢出：滚轮留给**滚动查看**（用户放大就是为了看细节，
     *     这时最需要的是移动视野），缩放改用 Ctrl/⌘ + 滚轮。
     *
     * 这个分工是照用户习惯来的：他要求"滚轮放大/缩小"，而放大之后
     * 再把滚轮占住就没法看别处了。
     */
    stage.addEventListener(
      'wheel',
      (event) => {
        const overflowing =
          stage.scrollHeight > stage.clientHeight + 1 || stage.scrollWidth > stage.clientWidth + 1
        const wantsZoom = event.ctrlKey || event.metaKey || !overflowing

        if (!wantsZoom) {
          // 让浏览器自己滚 —— stage 是 overflow:auto。
          return
        }
        event.preventDefault()

        // ⚠️ **累积位移，够一格才走一档。**
        //
        // 原来每个 `wheel` 事件都走一档。那是错的：一次滚轮动作会触发**很多**事件 ——
        //   鼠标滚轮：一格 ≈ 1 个事件（deltaY ≈ ±100）
        //   触控板：一次轻扫几十个事件，抬手后还有惯性余波
        // 于是"滚一下"直接冲过好几档，从适应跳到 400% 或 25%。
        // 用户的原话是"放大不是一步一步放大，放小也不是，滚轮识别有问题"。
        //
        // 归一化 `deltaMode`：不同设备/浏览器给的单位不一样
        // （0=像素、1=行、2=页），不换算的话行模式每次只有 ±3，永远够不到阈值。
        let delta = event.deltaY
        if (event.deltaMode === 1) {
          delta *= 16
        } else if (event.deltaMode === 2) {
          delta *= 100
        }

        const now = Date.now()
        // 停手超过一小段时间，就把余量清掉 —— 否则触控板的惯性余波会攒够阈值，
        // 在用户早已停手之后再缩放一次。
        if (now - wheelLastAt > WHEEL_IDLE_MS) {
          wheelAccum = 0
        }
        // 方向一变就重新计：往回滚时不该继承上一方向的余量。
        if (delta !== 0 && wheelAccum !== 0 && Math.sign(delta) !== Math.sign(wheelAccum)) {
          wheelAccum = 0
        }
        wheelLastAt = now
        wheelAccum += delta

        if (Math.abs(wheelAccum) < WHEEL_STEP_DELTA) {
          return
        }

        // 向上滚（deltaY < 0）= 放大。
        const direction = wheelAccum < 0 ? 1 : -1
        // 扣掉一整格，余量留给下一次 —— 这样慢滚和快滚的"每档所需动作量"一致。
        wheelAccum -= Math.sign(wheelAccum) * WHEEL_STEP_DELTA
        zoomAtPointer(direction, event.clientX, event.clientY)
      },
      // 被动监听无法 preventDefault，必须显式声明。
      { passive: false }
    )

    const minusButton = makeButton('−', '缩小（-）', () => stepZoom(-1))
    const plusButton = makeButton('＋', '放大（+）', () => stepZoom(1))
    const fitButton = makeButton('适应窗口', '适应窗口（0）', () => {
      scale = 0
      applyZoom()
    })
    const actualButton = makeButton('100%', '原始尺寸（1）', () => {
      scale = 1
      applyZoom()
    })
    const closeButton = makeButton('关闭', '关闭预览（Esc）', close)

    bar.appendChild(meta)
    bar.appendChild(minusButton)
    bar.appendChild(level)
    bar.appendChild(plusButton)
    bar.appendChild(fitButton)
    bar.appendChild(actualButton)
    bar.appendChild(closeButton)
    backdrop.appendChild(bar)

    stage.appendChild(image)
    // 双击在「适应窗口」与「100%」之间切换 —— 看截图时最常用的两个状态。
    image.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      scale = scale === 0 ? 1 : 0
      applyZoom()
    })
    // 点图片不该关闭（用户可能只是想看清楚）。
    image.addEventListener('click', (event) => event.stopPropagation())
    backdrop.appendChild(stage)

    // ⚠️ "点空白关闭"挂在 **stage** 上，不是 backdrop。
    //
    // 原来挂在 backdrop 上，而**工具条是 backdrop 的子元素** —— 点任何一个按钮，
    // 事件都会冒泡到 backdrop，然后预览整个关掉。
    // 用户的原话是"顶部那一排操作项我无论点击哪个都会导致图片被关闭"。
    //
    // 挂在 stage 上就没有这个问题：它是 bar 的**兄弟**，bar 里的事件不会传到这里。
    // 而"点空白"的语义本来就落在 stage 上 —— 缩放后图片比 stage 大，
    // 点图片周围那一圈仍然算点空白。
    stage.addEventListener('click', close)

    shadow.appendChild(backdrop)
    document.documentElement.appendChild(host)

    keyHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        stepZoom(1)
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        stepZoom(-1)
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        scale = 0
        applyZoom()
        return
      }
      if (event.key === '1') {
        event.preventDefault()
        scale = 1
        applyZoom()
      }
    }
    document.addEventListener('keydown', keyHandler, true)

    applyZoom()
  }

  /**
   * 接收 worker 的"显示预览"指令。
   *
   * 这是**第一个**需要由 worker 主动推给内容脚本的 UI 动作 —— 之前的页内 UI
   * 都是用户直接在页面上操作触发的。所以必须显式注册监听：没有它，
   * worker 的 `tabs.sendMessage` 会因为"没有接收方"而失败。
   */
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (message && message.type === 'preview.showOverlay' && message.screenshot) {
        show(message.screenshot)
        sendResponse({ ok: true, shown: true })
        return true
      }
      return undefined
    })
  } catch (error) {
    // 老环境没有 onMessage 时，预览浮层不可用（其余功能不受影响）。
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.PREVIEW_HOST_ID = HOST_ID
  scope.__EG__.showPreviewOverlay = show
  scope.__EG__.closePreviewOverlay = close
  scope.__EG__.isPreviewOverlayOpen = isOpen
  scope.__EG__.previewScale = function () {
    return scale
  }
  scope.__EG__.__previewProbe = probe
})(globalThis)
