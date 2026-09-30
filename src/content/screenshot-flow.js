// @ts-check
/**
 * 截图编排（内容脚本侧）。
 *
 * ## 顺序是这个文件存在的主要理由
 *
 * spec §6.1 把"**移除 overlay 之后才截图**"标为关键步骤。搞错顺序不会报错，
 * 只会让每一张截图都带着高亮框与十字光标 —— 那种 bug 只有看图的人才会发现。
 *
 * 正确顺序：
 *
 * ```
 * 抽取 payload（此时 overlay 还在，用户还能看到自己选了什么）
 *   → 暂时把 overlay 藏起来（同时它也不再吃指针事件，天然防重入）
 *   → 必要时滚动到元素可见
 *   → 采整屏图 → 按元素 rect 裁剪
 *   → 恢复 overlay
 *   → 连同截图一起投递给 service worker
 * ```
 *
 * ## 为什么滚动要重测 rect
 *
 * `scrollIntoView` 之后元素的位置变了，之前测的 `rectViewport` 已经失效。
 * 所以滚动后必须重新测一次；否则裁出来的会是滚动前那个位置的区域。
 */
;(function attachScreenshotOrchestration(scope) {
  'use strict'

  const ns = (scope.__EG__ = scope.__EG__ || {})

  /** 等一帧，让 `scrollIntoView` 引发的合成器更新落地。 */
  const SCROLL_SETTLE_MS = 120
  /** overlay 隐藏后、截图前再等一拍，确保捕获到的帧里没有残留的高亮框。 */
  const OVERLAY_HIDE_SETTLE_MS = 60

  /**
   * @param {number} ms
   */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * @param {Element} element
   */
  function measure(element) {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  /**
   * 把元素滚到完全可见的位置。
   *
   * `block: 'center'` 而不是 `'nearest'`：贴边的元素用 `nearest` 之后可能仍有
   * 一部分在视口外（例如元素高于视口时），截出来是残缺的。居中最稳。
   *
   * @param {Element} element
   */
  async function scrollIntoViewFully(element) {
    try {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch (error) {
      // 老浏览器不认 `behavior: 'instant'`；退回布尔参数形式。
      element.scrollIntoView(true)
    }
    await delay(SCROLL_SETTLE_MS)
  }

  /**
   * 把内容侧的关键中间产物送回 service worker 记档。
   *
   * 内容脚本跑在隔离世界、页面控制台看不到它，而截图失败恰恰最常发生在这一侧
   * （取图 → 解码 → 裁剪）。所以每一步都要回传，否则真机上失败了只能看到
   * "没有截图"这一句话，无从判断是哪一步。
   *
   * @param {string} stage
   * @param {any} detail
   */
  function report(stage, detail) {
    try {
      // fire-and-forget：诊断不能影响抓取，也不能因为失败而卡住流程。
      void chrome.runtime.sendMessage({ type: 'screenshot.diagnostic', stage, detail })
    } catch (error) {
      // 扩展被重载时 sendMessage 会抛；忽略。
    }
  }

  /**
   * 采集并裁剪元素截图。
   *
   * @param {Element} element
   * @returns {Promise<{ screenshot: any, omittedReason: string|null }>}
   */
  async function captureElementScreenshot(element) {
    const dpr = window.devicePixelRatio || 1
    let rect = measure(element)

    report('flow:start', {
      dpr,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      fullyInside: ns.isFullyInsideViewport(rect, window.innerWidth, window.innerHeight)
    })

    if (!ns.isFullyInsideViewport(rect, window.innerWidth, window.innerHeight)) {
      await scrollIntoViewFully(element)
      rect = measure(element)
      if (!ns.isFullyInsideViewport(rect, window.innerWidth, window.innerHeight)) {
        // 滚动之后仍不完全可见（元素比视口还大，或页面不允许滚动到位）。
        // 不做部分截图冒充成功——那会让 AI 以为看全了元素。
        report('flow:notVisibleAfterScroll', { rect: { w: Math.round(rect.width), h: Math.round(rect.height) } })
        return { screenshot: null, omittedReason: ns.ERROR_CODES.elementNotVisible }
      }
    }

    let screenDataUrl
    try {
      screenDataUrl = await chrome.runtime.sendMessage({
        type: 'grab.screenshot.request',
        rectViewport: rect,
        devicePixelRatio: dpr
      })
    } catch (error) {
      report('flow:sendMessageThrew', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { screenshot: null, omittedReason: ns.ERROR_CODES.screenshotCaptureFailed }
    }

    if (!screenDataUrl || screenDataUrl.ok !== true) {
      const error = (screenDataUrl && screenDataUrl.error) || {}
      report('flow:workerRefused', {
        ok: Boolean(screenDataUrl && screenDataUrl.ok),
        error: error || null
      })

      // 缺授权时**顺带通知面板**露出授权按钮。
      //
      // 为什么不能只靠胶囊：胶囊两秒就消失了，而"去面板点授权"是一个需要用户
      // 主动完成的多步动作。真机上就是这么表现出来的 —— 用户只看到一句
      // 一闪而过的提示，不知道该做什么。
      if (error.code === 'needs_host_permission') {
        try {
          void chrome.runtime.sendMessage({ type: 'grab.needsHostPermission' })
        } catch (notifyError) {
          // 通知失败不影响本次抓取的结果。
        }
      }

      return {
        screenshot: null,
        omittedReason: error.code || ns.ERROR_CODES.screenshotCaptureFailed
      }
    }

    const returnedDataUrl = screenDataUrl.result.dataUrl
    report('flow:workerReturned', {
      isString: typeof returnedDataUrl === 'string',
      length: typeof returnedDataUrl === 'string' ? returnedDataUrl.length : null,
      prefix: typeof returnedDataUrl === 'string' ? returnedDataUrl.slice(0, 40) : null
    })

    let bitmap
    try {
      const response = await fetch(returnedDataUrl)
      const blob = await response.blob()
      report('flow:blob', {
        blobType: blob.type,
        blobSize: blob.size
      })
      bitmap = await createImageBitmap(blob)
    } catch (error) {
      report('flow:decodeFailed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { screenshot: null, omittedReason: ns.ERROR_CODES.screenshotCaptureFailed }
    }

    report('flow:bitmap', {
      bitmapWidth: bitmap.width,
      bitmapHeight: bitmap.height
    })

    const cropped = await ns.cropScreenshot(bitmap, rect, dpr)
    if (bitmap.close) {
      bitmap.close()
    }

    if (!cropped.ok) {
      report('flow:cropFailed', { reason: cropped.reason })
      return { screenshot: null, omittedReason: cropped.reason }
    }

    report('flow:cropOk', {
      croppedWidth: cropped.width,
      croppedHeight: cropped.height,
      croppedByteLength: cropped.byteLength,
      croppedDataUrlPrefix: typeof cropped.dataUrl === 'string' ? cropped.dataUrl.slice(0, 40) : null,
      croppedDataUrlLength: typeof cropped.dataUrl === 'string' ? cropped.dataUrl.length : null,
      budgetMaxBytes: ns.BUDGET.screenshotMaxBytes
    })

    if (cropped.byteLength > ns.BUDGET.screenshotMaxBytes) {
      // 超限时**不静默**：把原因带回去，让胶囊能说明白为什么没有截图。
      return { screenshot: null, omittedReason: ns.ERROR_CODES.screenshotTooLarge }
    }

    return {
      screenshot: {
        mimeType: 'image/png',
        dataUrl: cropped.dataUrl,
        width: cropped.width,
        height: cropped.height
      },
      omittedReason: null
    }
  }

  /**
   * 完整的"带截图抓取"编排。
   *
   * @param {Element} element 已确认仍在文档中
   * @returns {Promise<{ raw: any, screenshotNote: string }>}
   */
  async function extractWithScreenshot(element) {
    // 1. 先抽取（overlay 仍在，用户看到的高亮与抽取到的是同一个元素）。
    const raw = ns.extractPayload(element)

    // 2. 藏起 overlay，并等一拍让合成器出新的帧。
    ns.setOverlaySuppressed(true)
    await delay(OVERLAY_HIDE_SETTLE_MS)

    try {
      const captured = await captureElementScreenshot(element)
      raw.screenshot = captured.screenshot
      // 失败原因**必须写进 payload**，不能只放在返回值的 screenshotNote 里。
      //
      // 原因：`screenshotNote` 只喂给那条 2 秒就消失的胶囊。用户没看到就永久丢了，
      // 而侧边面板读的是 `payload.screenshotOmittedReason` —— 它一直是 null，
      // 所以"没有截图：<原因>"这一行从来没有出现过（评审 SP-001）。
      // 写进 payload 才能随历史落盘、在面板里回看。
      raw.screenshotOmittedReason = captured.omittedReason || null

      // 截图改变了视口位置（如果滚动过），rectViewport 要以最终测量为准。
      const finalRect = measure(element)
      raw.target.rectViewport = finalRect
      raw.target.rectPage = {
        x: finalRect.x + window.scrollX,
        y: finalRect.y + window.scrollY,
        width: finalRect.width,
        height: finalRect.height
      }

      return { raw, screenshotNote: captured.omittedReason || '' }
    } finally {
      // 3. 无论成功失败都恢复，否则用户会以为抓取模式坏了。
      ns.setOverlaySuppressed(false)
    }
  }

  ns.SCROLL_SETTLE_MS = SCROLL_SETTLE_MS
  ns.extractWithScreenshot = extractWithScreenshot
  ns.captureElementScreenshot = captureElementScreenshot
  ns.measureElementRect = measure
  ns.scrollElementIntoViewFully = scrollIntoViewFully
})(globalThis)
