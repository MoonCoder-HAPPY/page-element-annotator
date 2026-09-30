// @ts-check
/**
 * 抓取模式状态机、悬停跟踪与点击捕获。
 *
 * ## 为什么用 async function 而不是裸 new Promise
 *
 * 页面可能引入 Zone.js（Angular 默认这么做），它会把全局 `Promise` 换成
 * `ZoneAwarePromise`。某些宿主环境不认这个实现，会把
 * `__zone_symbol__state` / `__zone_symbol__value` 这样的包装体当成 promise 的
 * 结果直接传回来，于是上层收到一个"结构非法的 payload"而不是真实结果。
 * 用 `async function` 让引擎自己处理，绕开这个坑（spec §20.1.1）。
 *
 * ## 只有一条入口
 *
 * `pointerdown` → 冻结高亮 → 抽取 → 交给 worker 开输入（现在在侧边面板里）。
 *
 * 这里原本还有第二条"悬停注释"入口，用户要求删除 —— **两个入口的行为本来就
 * 一样**（都是左键点击才抓，悬停只用来高亮预览），留着只会让人以为是两种模式。
 *
 * hover 才出现的内容（下拉菜单、气泡提示）依然能抓：抽取发生在**点击那一刻**
 * （见 `captureElement` 里的顺序说明），浮层收掉了也不影响。
 */
;(function attachPicker(scope) {
  'use strict'

  // ---------------------------------------------------------------------------
  // 先拆掉**上一份实例**，再装自己这一份
  // ---------------------------------------------------------------------------
  //
  // 真机反馈："退出注释以后，鼠标还处于框选的状态，没有退出，好像是在多个页面
  // 来回切换的时候会有这个问题，此时刷新页面才可以解决。"
  //
  // 根因是**重复注入**：`chrome.scripting.executeScript({ files })` 每注入一次
  // 就会把这些 IIFE **重新执行一遍**。重新执行会覆盖 `__EG__` 上的函数，
  // 但上一份注册在 `window` / `document` 上的监听器**还挂在原处** ——
  // 它们闭包住的是**旧的模块状态**（旧的 `state`、旧的 `armGeneration`）。
  //
  // 于是同一个页面里可能有**两套监听器**：新的 disarm 之后，旧的那一套仍然
  // 响应 pointermove，把高亮框重新挂回来。表现就是"退出了但还在框选"，
  // 而刷新页面能解决 —— 刷新清掉了所有旧监听器。
  //
  // 多标签页来回切换会加剧它：每次切回来都可能触发一次重新注入，实例越叠越多。
  //
  // 修法：进入本文件时先把上一份彻底拆掉。**必须在定义新状态之前做** ——
  // 晚一步 `ns` 就已经被覆盖，旧实例的引用就找不回来了。
  try {
    const previous = scope.__EG__ && scope.__EG__.__disposePickerInstance
    if (typeof previous === 'function') {
      previous()
    }
  } catch (error) {
    // 拆不掉也得继续装新的：宁可有残留，也不要整个内容脚本挂掉。
  }

  const ns = (scope.__EG__ = scope.__EG__ || {})

  const STATE = Object.freeze({
    idle: 'idle',
    armed: 'armed',
    awaiting: 'awaiting'
  })

  let state = STATE.idle
  /** 单调递增，用于丢弃过期操作的结果（切页、快速重复进入等）。 */
  let armGeneration = 0
  /**
   * 这一次是**从哪个入口**进来的。
   *
   * ⚠️ 悬停入口已按用户要求删除，这个状态连同整套 `mode` 机制一起清掉了：
   * 两个入口的行为本来就一样（都是左键点击才抓，悬停只用来高亮预览），
   * 只剩一个入口之后就没有"是哪个入口"这回事。
   *
   * 它当初存在的理由值得记一下：入口模式一度是从"拾取器是不是在等悬停"**现场
   * 推导**的，而悬停命中后那个标志会翻回 `false`，于是推给面板的 `mode` 变成
   * `'click'`，把另一个按钮点亮成深色闪一下（真机反馈的"闪黑"）。
   * 教训是：**入口是"用户点了哪个按钮"，它不会在动作过程中变，不该被推导。**
   */

  /** @type {Element|null} */
  let hoveredElement = null

/**
 * 注释窗口开着 —— 高亮框**冻结**在用户选中的那个元素上。
 *
 * 用户要求："用户注释以后 框选的区域必须要常驻显示，
 * 直到用户取消/添加完成此次注释的添加。"
 *
 * 它同时管住两件事：
 *   · `finally` 里不解冻（否则框会被移回鼠标位置）；
 *   · `onPointerMove` 里不跟随 hover（否则鼠标一动框就跑）。
 *
 * 由 worker 在"提交 / 取消 / 注释窗口被关掉"时通过 `grab.annotation.end`
 * 复位。见 `releaseAnnotationHighlight`。
 */
let annotationInProgress = false
  let detachListeners = null

  function isArmed() {
    return state !== STATE.idle
  }

  /**
   * 事件是否落在**注释框或胶囊**里（不含 overlay）。
   *
   * 这两类宿主里的交互（在文本框打字、点「添加」「取消」）属于我们的 UI，
   * 拾取器必须整条链放过：不能吞、不能当成"用户选了元素"。
   *
   * ## 为什么这件事很关键（真机踩出来的）
   *
   * 注释框的「添加」按钮长时间没反应。原因是拾取器在 document 捕获阶段对
   * `mousedown` 调了 `preventDefault()` —— 而在 `mousedown` 上 `preventDefault()`
   * 会**阻止后续 `click` 的派发**。按钮只收到 `mouseup`，永远等不到 `click`，
   * 它的监听器一次都没跑。（`pointerdown` 上没有这个副作用，只有 `mousedown` 有。）
   *
   * ## 为什么**不**把 overlay 算进来
   *
   * overlay 的捕获器覆盖整个视口且 `pointer-events: auto`，所以**每一条**指针事件的
   * 直接落点都是它。若把它也算作"我们自己的 UI"，拾取器会直接失效（悬停高亮不动、
   * 点选无反应）—— 我先后按"路径里出现过"和"直接落点是宿主"写了两次，两次都错，
   * 因为两次都把 overlay 卷了进来。overlay 的过滤是 `hitTestForOverlay` 与
   * `resolveClickTarget` 的职责（它们会临时让开指针事件取真实元素）。
   *
   * @param {Event} event
   */
  function isOurOwnUiEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const target = path.length > 0 ? path[0] : event.target
    if (!(target instanceof Element)) {
      return false
    }
    if (target.id === ns.OVERLAY_HOST_ID) {
      return false
    }
    return ns.isOurOwnUi(target)
  }

  /**
   * 点击拦截。三个都要调：
   * - preventDefault：阻止页面自己的默认行为（提交表单、跳转）
   * - stopPropagation / stopImmediatePropagation：阻止页面自己的处理器
   *
   * 残余风险（spec §15 R-4）：window 上更早注册的 capture 阶段监听器仍可能先执行，
   * 所以不能宣称"页面无法感知用户在选取元素"。
   * @param {Event} event
   */
  function swallowEvent(event) {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  /**
   * 事件的真实目标。
   *
   * `event.target` 在 Shadow DOM 场景下是**重定向后**的结果，会指向 shadow host；
   * `composedPath()[0]` 才是用户视觉上点到的那个元素。
   *
   * @param {Event} event
   */
  function resolveEventTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      // 跳过我们自己的宿主（overlay／胶囊／注释框）。它们的 id 都以
      // `element-grab-` 开头；硬编码单个 id 的话，每新增一个宿主就会漏一个。
      if (node instanceof Element && ns.isOurOwnUi(node)) {
        return null
      }
      if (node instanceof Element) {
        return node
      }
    }
    return event.target instanceof Element ? event.target : null
  }

  /**
   * 事件是否发生在跨域 iframe 内部（拿不到其 DOM 的那种）。
   *
   * 判据：`composedPath` 里存在一个 `contentDocument` 为 `null` 的 `IFRAME`。
   * 同源 iframe 的 `contentDocument` 是可读的，所以不会被误判。
   *
   * @param {Event} event
   */
  function isInsideCrossOriginFrame(event) {
    if (typeof event.composedPath !== 'function') {
      return false
    }
    const path = event.composedPath()
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      if (node instanceof HTMLIFrameElement && node.contentDocument === null) {
        return true
      }
    }
    return false
  }

  /**
   * 问 worker 还能不能存。
   *
   * 失败时返回 null（**不阻断**）：容量查询本身出错不该让抓取彻底不可用 ——
   * 写入侧还有一道 `history_quota_exceeded` 的兜底。
   *
   * @returns {Promise<any|null>}
   */
  async function askCapacity() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'history.capacity' })
      return response && response.ok === true ? response.result : null
    } catch (error) {
      return null
    }
  }

  /**
   * 把容量情况说成一句用户能照着做的话。
   *
   * @param {{ recordCount: number, maxRecords: number, bytes: number, maxBytes: number, reason: string|null }} capacity
   */
  function describeCapacity(capacity) {
    const mb = function (value) {
      return (value / (1024 * 1024)).toFixed(1)
    }
    if (capacity.reason === 'records') {
      return (
        `存不下了：已达 ${capacity.recordCount} / ${capacity.maxRecords} 条上限。` +
        '请在侧边面板里删掉几条旧记录，或把「容量设置」的上限调大。'
      )
    }
    return (
      `存不下了：已用 ${mb(capacity.bytes)} / ${mb(capacity.maxBytes)} MB。` +
      '请在侧边面板里删掉几条旧记录，或把「容量设置」的上限调大。'
    )
  }

  /**
   * 抓一个元素：抽好 payload，交给 worker 开**独立小窗口**写注释。
   *
   * 没有第二个分支了 —— `withCommentDialog` 那个参数随页面内弹框一起删掉了。
   * 页面侧从此**不承载任何输入控件**（Orca 的做法），所以不存在"要不要弹框"这个问题。
   *
   * @param {Element} element
   * @param {number} generation
   */
  async function captureElement(element, generation) {
    if (generation !== armGeneration) {
      return
    }
    if (!element.isConnected) {
      ns.showCapsule('元素已消失，请重新选择', 'error')
      return
    }

    // 顺序：**先抽好，再交给小窗口**。
    //
    // ## 为什么把抽取提前
    //
    // hover 激活的内容（下拉菜单、气泡提示）只在鼠标停留时存在。用户点完元素、
    // 鼠标一移开，页面立刻把浮层收掉 —— 等用户在小窗口里写完注释回来再抽，
    // 那个元素**早就不在了**。所以必须在点击这一刻把 payload 抽完、存好。
    //
    // ## 为什么输入框不放在页面里
    //
    // 原来是在页面 `documentElement` 上挂一个带 textarea 的浮层。于是只要页面
    // 开着抽屉/模态框之类**带焦点陷阱**的组件，就会一直和它抢焦点 ——
    // 输入法用不了、按键进不去、甚至把回调打成相互递归爆栈。
    //
    // Orca 的做法是：页面侧注入脚本**不创建任何输入控件**
    // （`grab-guest-overlay-script.ts`），注释 UI 在**它自己的渲染进程**里
    // （`browser-page-annotation-tray.tsx` 的 `<textarea autoFocus>`）。
    // 两个不同的文档 —— 页面的焦点陷阱碰不到它，**根本没有那场争夺**。
    //
    // 这里就是那个思路：抽取完把 payload 交给 worker，由它开一个**扩展自己的
    // 小窗口**让用户写注释。这个页面从此不再承载任何输入控件。
    const capacity = await askCapacity()
    if (capacity && capacity.atLimit) {
      ns.showCapsule(describeCapacity(capacity), 'error')
      return
    }

    state = STATE.awaiting
    let raw
    try {
      // 走带截图的编排：内部会在截图前隐藏 overlay 并恢复它（spec §6.1 的关键步骤）。
      raw = (await ns.extractWithScreenshot(element)).raw
    } catch (error) {
      // 截图编排失败不应让整次抓取失败：退回纯文本抽取。
      try {
        raw = ns.extractPayload(element)
      } catch (fallbackError) {
        ns.showCapsule(
          `抽取失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          'error'
        )
        state = STATE.armed
        return
      }
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'grab.extract.request',
        requestId: `${generation}-${Date.now()}`,
        rawPayload: raw,
        // 让 worker 知道"别落库，先等用户写注释"。
        awaitComment: true
      })

      if (generation !== armGeneration) {
        return
      }

      if (!response || response.ok !== true) {
        const message = response && response.error ? response.error.message : '未知原因'
        ns.showCapsule(`抓取失败：${message}`, 'error')
      } else {
        // 置位**必须**在成功之后：失败时 `finally` 要照常解冻、把框交还给 hover。
        annotationInProgress = true
        ns.showCapsule('注释窗口已打开，写完点「添加」', 'info')
      }
    } catch (error) {
      // 扩展被重新加载/卸载时 sendMessage 会抛；这是环境变化而非抓取失败，
      // 所以退出抓取模式而不是留下一个永远等不到响应的状态。
      ns.showCapsule('扩展连接已断开，请重新点击扩展图标', 'error')
      armGeneration++
      teardown()
      return
    } finally {
      // 收尾**必须**在这里做，而不是散落在各个成功/失败分支里：
      // 任何一个 return 都不会跳过 finally，所以"冻结的高亮框"和
      // "捕获器还占着指针事件"这两件坏事不会因为新加了一条失败分支而回归。
      if (generation === armGeneration) {
        state = STATE.armed
        /*
         * ⚠️ 注释还没结束（小窗口开着）时**不能解冻**。
         *
         * 用户要求："用户注释以后 框选的区域必须要常驻显示，
         * 直到用户取消/添加完成此次注释的添加。"
         *
         * 解冻之后那句 `updateOverlayHighlight(hoveredElement)` 会把框移回
         * 鼠标当前位置 —— 用户在小窗口里打字时，页面上那个"我选的是这里"的
         * 参照就没了。而注释本身正是要说明"这个地方要改什么"，
         * 参照没了，注释也就失去了所指。
         *
         * Orca 的注入脚本里就是这条（`grab.freezeHighlight()`）：
         * "freeze the highlight instead of removing it so the user sees
         * which element was selected while the copy menu is shown."
         */
        if (!annotationInProgress) {
          ns.unfreezeOverlayHighlight()
          // 高亮框保留的那一帧已经过去，重新按当前指针位置刷新。
          if (hoveredElement) {
            ns.updateOverlayHighlight(hoveredElement)
          }
        }
      }
    }
  }

  /**
   * @param {any} payload
   */
  function describeTarget(payload) {
    const tag = payload.target.tagName
    const firstClass = payload.target.cssClasses
      ? '.' + payload.target.cssClasses.split(/\s+/)[0]
      : ''
    const rect = payload.target.rectViewport
    return `${tag}${firstClass} · ${Math.round(rect.width)}×${Math.round(rect.height)}`
  }

  /**
   * 注释结束（提交了 / 取消了 / 小窗口被关掉了）—— 解冻高亮，恢复跟随 hover。
   *
   * 由 worker 发 `grab.annotation.end` 触发。三种结束方式都要覆盖到，
   * 少一种就会出现"框一直挂在那儿、鼠标怎么动都不动"的僵尸状态：
   *   · 点「添加」提交；
   *   · 点「取消」；
   *   · **直接点窗口的关闭按钮** —— 这条靠 worker 的 `windows.onRemoved`，
   *     它是唯一能观察到"用户把窗口叉掉了"的地方。
   */
  function releaseAnnotationHighlight() {
    if (!annotationInProgress) {
      return
    }
    annotationInProgress = false
    if (state === STATE.armed) {
      ns.unfreezeOverlayHighlight()
      /*
       * ⚠️ **必须显式清掉画面**，光解冻不够。
       *
       * `unfreezeOverlayHighlight()` 只把 `frozenElement` 置空，**不重画** ——
       * 要等下一次 `pointermove` 才会刷新。而用户是在**面板里**点「取消」的，
       * 鼠标根本不在页面上，于是那个冻结的框**一直留在页面上**，再也不会消失。
       *
       * 真机反馈："取消注释 以后原来的框选仍然存在 不应该关闭掉吗？"
       *
       * 传 `null` 是 overlay 里"什么都不高亮"的约定（见 `updateHighlight`）。
       * 下一次指针移到页面上时会自然画出正确的框。
       */
      ns.updateOverlayHighlight(null)
    }
  }

  /**
   * 接收 worker 的"注释结束"通知。
   *
   * 单独注册一条监听（而不是塞进 `preview-overlay.js` 那条）：那是预览浮层
   * 自己的职责，把一个模块的消息混进另一个模块，下次谁改都得先猜。
   */
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (message && message.type === 'grab.annotation.end') {
        releaseAnnotationHighlight()
        sendResponse({ ok: true })
        return true
      }
      return undefined
    })
  } catch (error) {
    // 老环境没有 onMessage 时高亮不会自动解冻；其余功能不受影响。
  }

  /**
   * @param {PointerEvent} event
   */
  function onPointerMove(event) {
    if (state !== STATE.armed) {
      return
    }
    /*
     * 注释窗口开着时**不跟随 hover**。
     *
     * 用户要求"框选的区域必须常驻显示" —— 如果这里照常刷新，鼠标从小窗口
     * 挪回页面（或只是碰一下页面），框就跳到别的元素上，
     * "我选的是这里"这个参照当场消失。冻结要包含"不更新"，不只是"不解冻"。
     */
    if (annotationInProgress) {
      return
    }
    // 这里**不**做 "是不是我们自己的 UI" 判断：overlay 的捕获器覆盖全视口，
    // 指针事件的落点几乎总是它，加了判断就等于把悬停整个掐掉
    // （我第一次加了，真机表现为高亮框完全不动）。
    // 过滤我们自己的宿主是 `hitTestForOverlay` 的职责 —— 它会临时让开指针事件，
    // 拿到坐标下真正的页面元素。
    const element = ns.hitTestForOverlay(event.clientX, event.clientY)
    hoveredElement = element
    ns.updateOverlayHighlight(element)

    // —— 抓取**只由左键点击决定**，不靠"停留" ——
    //
    // 这里原本有一段 400ms 停留判定：指针在某元素上停够时间就自动弹注释框，
    // 不需要点击。真机反馈说明那是错的方向：
    //
    //   "当我使用悬停注释的时候，会自动触发弹窗，我都没有点击左键进行选择，
    //    也会自动触发弹窗。"
    //
    // 问题在于 **"鼠标停着"不等于"我要选它"** —— 用户读页面、想事情、
    // 等浮层出现，都会让指针停在某个元素上，于是弹框凭空冒出来。
    // 而且它抢在用户能看清之前。
    //
    // hover 才出现的内容依然能抓：点位期间的悬停高亮照常工作，而
    // `captureElement` 里的快照机制保证浮层在写注释期间消失也能抓到
    // （见那里的注释）。
    //
    // 这里原本还要记住"是从哪个入口进来的"（`armedMode`），用来决定面板上
    // 哪个按钮显示「取消」以及进模式时的提示文案。悬停入口按用户要求删除之后
    // 只剩一个按钮、一种文案，那件事不需要记了。
  }

  /**
   * `pointerdown` 与 `mousedown` 都可能成为"按下"的信号，取决于事件来源：
   *
   * - 真实鼠标交互在支持 Pointer Events 的浏览器上先发 `pointerdown`；
   * - **CDP `Input.dispatchMouseEvent` 只发 `mousedown`**（没有 pointer 事件），
   *   所以自动化窗口里只有 `mousedown` 会到；
   * - 某些 WebDriver/合成事件路径也是只发 `mouse*`。
   *
   * 因此两个都听，并用 `downHandled` 去重，避免一次按下被处理两遍。
   */
  let downHandled = false

  /**
   * 按下时确定"用户点的是哪个元素"。
   *
   * ## 为什么不能用 `event.target`
   *
   * 捕获器是一个覆盖全视口的顶层层，**它自己才是事件目标**。真机诊断确认：
   *
   * ```
   * pointerdown:__eg-grab-host  mousedown:__eg-grab-host  click:__eg-grab-host
   * ```
   *
   * 也就是说 `event.target` 永远是捕获器，不是用户视觉上点到的元素。
   * 参考实现在 Electron 里靠渲染层侧信道知道点到了谁；扩展里必须自己解析。
   *
   * ## 解析顺序
   *
   * 1. **hover 缓存**：`onPointerMove` 每帧都在做命中测试，它认到的元素就是用户
   *    此刻看到高亮的那个 —— 这是最权威的答案，且与用户看到的完全一致。
   * 2. **坐标命中测试**：hover 缓存为空时（例如用户没移动鼠标就直接点了，
   *    或者 overlay 刚挂载）用事件的坐标现场测一次。
   * 3. **composedPath**：上面两条都拿不到时的最后手段（例如合成事件没有可信坐标）。
   *
   * @param {MouseEvent} event
   */
  function resolveClickTarget(event) {
    const hovered = ns.getOverlayCurrentElement()
    if (hovered && hovered.isConnected) {
      return hovered
    }
    const hit = ns.hitTestForOverlay(event.clientX, event.clientY)
    if (hit) {
      return hit
    }
    return resolveEventTarget(event)
  }

  /**
   * @param {MouseEvent} event
   */
  function onPointerDown(event) {
    if (state !== STATE.armed) {
      return
    }
    // 注释框／胶囊／overlay 里的事件一律放过：它们是我们自己的 UI，
    // 用户在文本框里打字、点按钮都不是"选元素"。这条判断同时保证
    // **不会对按钮的 mousedown 调 preventDefault**（那会掐掉它的 click）。
    if (isOurOwnUiEvent(event)) {
      return
    }
    if (downHandled) {
      return
    }
    downHandled = true
    /*
     * ⚠️ **注释框开着时，页面上的点击一律不生效。**
     *
     * 用户反馈："假设我目前已经框选了某个元素 但是我此时鼠标又点击了另一个地方
     * 但是框选的高亮区域没有跟着改变 注释框的内容倒是改变了。"
     *
     * 修之前这条链路是这样跑的 —— 第二次点击**被解析成了原来那个被冻结的元素**
     * （`resolveClickTarget` 的第一顺位就是冻结元素/悬停缓存）：
     *
     *   1. 用户点的是 B，送进 worker 的却是 A 的 payload（这一击被静默丢掉）；
     *   2. worker 的"替换上一笔"分支先发 `grab.annotation.end`，可那一刻页面状态是
     *      `awaiting` 而不是 `armed`，`releaseAnnotationHighlight` 里的
     *      `if (state === STATE.armed)` 把解冻和清画面一起挡掉了 ——
     *      **高亮框留在 A 上不动**；
     *   3. 面板收到新的 pending 又把输入卡片重渲染一次，用户**已经敲进去的字被清空**。
     *
     * 于是"高亮没跟着变、注释框内容倒是变了"这三件事同时成立。
     *
     * 语义上它本来也不该生效：用户对注释的要求是"框选的区域必须常驻显示，直到
     * 取消/添加完成这一次注释"（见文件顶部的 `annotationInProgress`）。注释还没写完
     * 就再选一个，"我正在注释的是哪个"当场失去所指，写好的字还会被丢掉。
     *
     * 所以这里**只吞事件 + 提示一句**：不解析目标、不请求抽取、不冻结、不结束。
     * 想换目标就先点「添加」或「取消」—— 那条路走的是 `armed` 状态下的
     * `grab.annotation.end`，解冻与清画面都会正常执行。
     */
    if (annotationInProgress) {
      swallowEvent(event)
      ns.showCapsule('注释还没写完：先点「添加」或「取消」，再选下一个元素', 'info')
      return
    }
    // 跨域 iframe 内的元素拿不到 DOM，明确告知而不是静默失败（spec §6.4）。
    if (isInsideCrossOriginFrame(event)) {
      swallowEvent(event)
      ns.showCapsule('该元素位于未授权的 iframe 内，无法读取其上下文', 'error')
      return
    }
    const target = resolveClickTarget(event)
    if (!target) {
      return
    }
    swallowEvent(event)
    ns.freezeOverlayHighlight()
    // 点选路径：弹注释框，用户确认后才抽取、截图、落库（修订 D-4）。
    void captureElement(target, armGeneration)
  }

  /** 抬手时重置去重标记，为下一次按下做准备。 */
  function onPointerUp() {
    downHandled = false
  }

  /**
   * 吞掉 `click`。
   *
   * 为什么按下时已经 `preventDefault` 了还要单独听 `click`：`click` 是**独立事件**，
   * 浏览器在配对完成后另外派发一次。对 `mousedown` 调 `preventDefault()`
   * **会**阻止这次 `click` 的派发（我原先在这里写的是"不阻止"，那句话是错的，
   * 也正是注释框按钮失灵的原因）；对 `pointerdown` 调则没有这个副作用。
   *
   * 只在 armed / awaiting 期间吞，避免退出抓取模式后误伤页面的正常点击。
   *
   * @param {MouseEvent} event
   */
  function onClick(event) {
    if (state === STATE.idle) {
      return
    }
    // 我们自己的 UI 例外：注释框的按钮靠 `click` 触发，胶囊里的按钮也是。
    if (isOurOwnUiEvent(event)) {
      return
    }
    swallowEvent(event)
  }

  /**
   * 取消"当前这一次选择"，但**留在抓取模式里**（Esc 的第一层）。
   *
   * 用户要求："esc 只控制是否取消当前选中的高亮区域，不支持通过 esc 键退出元素注释。"
   *
   * 这条语义**早就存在**，只是 Esc 没接上去：worker 的 `grab.comment.cancel`
   * 会清掉暂存的那一笔、通知面板收起输入卡片、再回一条 `grab.annotation.end`
   * 让页面解冻并清画面 —— 面板里注释框的「取消」按钮走的就是它。
   * 这里把 Esc 接到同一条路上，而不是另发明一套。
   *
   * ⚠️ **本地先收敛，再发消息。**
   *
   * `releaseAnnotationHighlight()` 是页面自己那一半（解冻 + 显式清画面 + 复位
   * `annotationInProgress`）。先做它，是因为下面那条 `sendMessage` 可能失败
   * （扩展被重载、worker 被回收）：失败时页面也已经回到"可以继续点选"的状态，
   * 而不是留下"框常驻、这一笔已作废、点击又被守卫挡掉"的僵尸 ——
   * 那正是上一轮 `annotationInProgress` 那个 bug 的形态。
   */
  function cancelCurrentAnnotation() {
    releaseAnnotationHighlight()
    ns.showCapsule('已取消这次选择，可以继续点选元素', 'info')
    try {
      const sent = chrome.runtime.sendMessage({ type: 'grab.comment.cancel' })
      if (sent && typeof sent.catch === 'function') {
        sent.catch(function () {
          // 没有接收方（扩展被重载 / worker 被回收）：本地已经收敛，不必再报。
        })
      }
    } catch (error) {
      // 老环境或扩展已卸载：同上。
    }
  }

  /**
   * @param {KeyboardEvent} event
   */
  function onKeyDown(event) {
    if (state === STATE.idle) {
      return
    }
    // 注释框开着时，键盘属于文本框：Esc 由弹窗自己处理（取消），
    // 不该在这里被解释成"退出抓取模式"。
    if (isOurOwnUiEvent(event)) {
      return
    }

    // 快捷键那套已整体删除，这里只剩内置的 Esc。
    if (event.key !== 'Escape') {
      return
    }
    swallowEvent(event)
    /*
     * Esc **退一层**（用户选定，见 `cancelCurrentAnnotation` 的说明）：
     *
     *   · 有选中（挂着一笔待写注释）→ 只取消这次选中，模式留着；
     *   · 没选中 → 退出抓取模式。
     *
     * 两层都必须有。只留第一层的话，键盘就彻底没有退出路径了 ——
     * 面板顶栏那个「取消注释」按钮要鼠标点得到面板才行，而面板可能被关掉；
     * spec 的用户故事 18 与 AC-10 也正是"别被卡在十字光标状态"这条诉求。
     */
    if (annotationInProgress) {
      cancelCurrentAnnotation()
      return
    }
    disarm()
    ns.showCapsule('已退出抓取模式', 'info')
  }

  /**
   * 页面导航期间抓取模式没有意义（overlay 与目标都失效了），直接退出且不报错。
   */
  function onPageHide() {
    if (state !== STATE.idle) {
      armGeneration++
      teardown()
    }
  }

  function attachListeners() {
    const moveListener = /** @type {EventListener} */ (onPointerMove)
    const downListener = /** @type {EventListener} */ (onPointerDown)
    const upListener = /** @type {EventListener} */ (onPointerUp)
    const clickListener = /** @type {EventListener} */ (onClick)
    const keyListener = /** @type {EventListener} */ (onKeyDown)

    window.addEventListener('pointermove', moveListener, true)
    window.addEventListener('mousemove', moveListener, true)
    window.addEventListener('pointerdown', downListener, true)
    window.addEventListener('mousedown', downListener, true)
    window.addEventListener('pointerup', upListener, true)
    window.addEventListener('mouseup', upListener, true)
    window.addEventListener('click', clickListener, true)
    window.addEventListener('keydown', keyListener, true)
    window.addEventListener('pagehide', onPageHide, true)

    detachListeners = function () {
      window.removeEventListener('pointermove', moveListener, true)
      window.removeEventListener('mousemove', moveListener, true)
      window.removeEventListener('pointerdown', downListener, true)
      window.removeEventListener('mousedown', downListener, true)
      window.removeEventListener('pointerup', upListener, true)
      window.removeEventListener('mouseup', upListener, true)
      window.removeEventListener('click', clickListener, true)
      window.removeEventListener('keydown', keyListener, true)
      window.removeEventListener('pagehide', onPageHide, true)
      detachListeners = null
    }
  }

  /**
   * 把**当前这一份实例**彻底拆掉（连同它留下的 DOM 宿主）。
   *
   * 由下一次注入时调用（见文件开头那段）。与 `teardown()` 的区别：
   * `teardown()` 只是"退出抓取模式"，而这里要保证**不留任何痕迹** ——
   * 监听器、宿主节点、以及监听器闭包里那份可能已经过期的状态。
   */
  function disposeInstance() {
    try {
      detachListeners && detachListeners()
    } catch (error) {
      // 继续拆剩下的。
    }
    try {
      ns.teardownOverlay && ns.teardownOverlay()
    } catch (error) {
      // 同上。
    }

    // 兜底：按 id 把我们的宿主节点全部摘掉。
    //
    // 上面两步依赖**这一份**实例还持有正确的引用；而出现重复注入时，
    // 很可能正是这种引用已经不完整了（例如上一份的 `detachListeners` 已被
    // 新实例覆盖，或 `ns.teardownOverlay` 指向的是别人）。所以再按 id 扫一遍 ——
    // 这是唯一不依赖任何模块状态的清理方式。
    for (const id of [
      'element-grab-dialog-host',
      'element-grab-capsule-host',
      'element-grab-preview-host',
      '__eg-grab-host',
      '__eg-grab-highlight',
      '__eg-grab-capsule'
    ]) {
      const node = document.getElementById(id)
      if (node) {
        node.remove()
      }
    }

    state = STATE.idle
    hoveredElement = null
    downHandled = false
  }
  ns.__disposePickerInstance = disposeInstance

  function teardown() {
    state = STATE.idle
    hoveredElement = null
    downHandled = false
    /*
     * ⚠️ 必须一起复位。
     *
     * 不复位的话，用户"点了元素 → 点「取消注释」退出 → 再点「元素注释」进来"之后，
     * `onPointerMove` 会因为 `annotationInProgress` 仍为 `true` 而**永不更新高亮** ——
     * 页面上看着像死了，而且**不会自愈**：那条复位通知（`grab.annotation.end`）
     * 只在提交/取消注释时才发，已经错过的那次永远补不回来。
     */
    annotationInProgress = false
    ns.teardownOverlay()
    if (detachListeners) {
      detachListeners()
    }
  }

  /**
   * 进入抓取模式。
   * @param {{ toggle?: boolean, silent?: boolean }} [options]
   *   - `toggle: true`：已是 armed 则退出（点扩展图标的行为）
   *     捕获一律由**左键点击**决定（见 onPointerMove 里那段说明）
   *   - `silent: true`：不弹提示胶囊（连续操作时避免刷屏）
   */
  /**
   * 把"抓取模式开了还是关了"告诉 service worker，由它转给侧边面板。
   *
   * ## 为什么需要这条通路
   *
   * 面板上的按钮要显示「元素注释」还是「取消元素注释」，取决于**页面里**的真实状态。
   * 而状态可能在面板看不见的地方变化：用户在页面上按 Esc、按 Ctrl+Shift+E、
   * 或者页面导航把它清掉了。面板猜不出来，只能被告知。
   *
   * 用推送而不是轮询：轮询要么贵（每次都要注入脚本问一次），要么慢（按钮状态滞后）。
   *
   * 失败要吞掉：面板可能不在（用户没开），此时 `sendMessage` 会以
   * "Receiving end does not exist" 拒绝 —— 那不影响抓取本身。
   */
  function notifyStateChanged() {
    try {
      void chrome.runtime
        .sendMessage({
          type: 'grab.state.changed',
          armed: isArmed()
          /*
           * 这里原本还带一个 `mode`（'click' | 'hover'）告诉面板是哪个入口，
           * 用来避免"悬停命中时另一个按钮闪黑"。悬停入口删除后只剩一个按钮，
           * 那个字段随之去掉。
           */
        })
        .catch(function () {
          // 没有接收方（面板未打开）是常态，不是错误。
        })
    } catch (error) {
      // 扩展被重载时 sendMessage 会同步抛；忽略。
    }
  }

  /**
   * @param {{ toggle?: boolean, silent?: boolean }} [options]
   */
  function arm(options) {
    const shouldToggle = Boolean(options && options.toggle)
    if (shouldToggle && state !== STATE.idle) {
      disarm()
      return false
    }

    // 无条件重建：页面可能预置了伪造的全局实现（spec §20.1.2）。
    teardown()
    armGeneration++
    state = STATE.armed

    ns.mountOverlay()
    attachListeners()

    if (!(options && options.silent)) {
      // 只有一种入口了，文案不再需要按模式分支。
      ns.showCapsule('元素注释：点一下要注释的元素', 'info')
    }
    notifyStateChanged()
    return true
  }


  function disarm() {
    armGeneration++

    // ⚠️ 这里**不再**需要"关掉可能开着的注释框"了。
    //
    // 以前那句话来自真机反馈："点击取消注释按钮以后，当前弹出的注释框内容并不会
    // 自动关闭。" —— 因为注释框是页面里的另一个模块，`teardown()` 管不到它。
    //
    // 现在注释框住在**扩展自己的小窗口**里，不在这个页面文档里，
    // 拾取器也就没有任何东西要替它收拾。取消抓取时那个窗口由用户自己关，
    // 或者由 worker 在提交/取消时关掉。

    teardown()
    notifyStateChanged()
  }

  ns.pickerState = function () {
    return state
  }
  ns.isPickerArmed = isArmed
  ns.armPicker = arm
  ns.disarmPicker = disarm
  ns.resolvePickerEventTarget = resolveEventTarget
  ns.resolvePickerClickTarget = resolveClickTarget
  ns.isInsideCrossOriginFrame = isInsideCrossOriginFrame
  ns.PICKER_STATE = STATE
})(globalThis)
