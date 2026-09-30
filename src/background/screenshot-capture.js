// @ts-check
/**
 * 截图采集：调用 `chrome.tabs.captureVisibleTab`，串行化并处理速率限制。
 *
 * ## 为什么必须串行化并有最小间隔
 *
 * `captureVisibleTab` 有调用配额。连续抓取多个元素时并发调用会有一部分被拒绝，
 * 而"被拒绝"在用户侧看起来就是"偶尔没有截图"——最难排查的那种间歇性故障。
 * 所以这里用一个 Promise 链把调用排成队列，并在两次调用之间留最小间隔（R-1）。
 *
 * 配额具体数值官方未公开，因此策略是**遇到失败就拉长间隔**（指数退避到上限），
 * 而不是猜一个数字然后假设它够用。
 */
;(function attachScreenshotCapture(scope) {
  'use strict'

  const ns = (scope.__EG__ = scope.__EG__ || {})

  /** 连续调用之间的最小间隔。保守取 300ms：体感上仍像"立刻"。 */
  const MIN_INTERVAL_MS = 300
  /** 退避上限。超过这个间隔说明配额确实被限住了，宁可慢也不要丢。 */
  const MAX_INTERVAL_MS = 2000
  /** 单次调用的等待上限。 */
  const CAPTURE_TIMEOUT_MS = 5000

  let queueTail = Promise.resolve()
  let lastCaptureAt = 0
  let currentIntervalMs = MIN_INTERVAL_MS

  /**
   * @param {number} ms
   */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 采一次整屏图（当前窗口的可见区域）。
   *
   * 失败时抛错，由调用方翻译成用户可读的原因。
   * @param {number} windowId
   */
  async function captureVisibleTabOnce(windowId) {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('capture_visible_tab_timeout'))
      }, CAPTURE_TIMEOUT_MS)

      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        clearTimeout(timer)
        const runtimeError = chrome.runtime.lastError
        if (runtimeError) {
          reject(new Error(runtimeError.message || 'capture_visible_tab_failed'))
          return
        }
        if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
          reject(new Error('capture_visible_tab_empty'))
          return
        }
        resolve(dataUrl)
      })
    })
  }

  /**
   * 排队采一次整屏图，保证与前一次调用之间有足够间隔。
   *
   * @param {number} windowId
   * @returns {Promise<string>} PNG data URL
   */
  function captureVisibleTab(windowId) {
    const run = async () => {
      const sinceLast = Date.now() - lastCaptureAt
      if (sinceLast < currentIntervalMs) {
        await delay(currentIntervalMs - sinceLast)
      }
      try {
        const dataUrl = await captureVisibleTabOnce(windowId)
        // 成功：间隔逐步回落到下限，但不要一步跳回，避免"成功一次就立刻再撞上限"。
        currentIntervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(currentIntervalMs / 2))
        return dataUrl
      } catch (error) {
        // 失败：拉长间隔。宁可慢一点，也不要让用户看到"有时没截图"。
        currentIntervalMs = Math.min(MAX_INTERVAL_MS, currentIntervalMs * 2)
        throw error
      } finally {
        lastCaptureAt = Date.now()
      }
    }

    const result = queueTail.then(run, run)
    // 队列本身不能因为一次失败就断掉。
    queueTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /**
   * 把底层错误翻译成 spec §9.1 的错误码与用户可读文案。
   * @param {unknown} error
   */
  function classifyCaptureError(error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('timeout')) {
      return {
        code: ns.ERROR_CODES.screenshotCaptureFailed,
        message: '截图超时（浏览器没有在 5 秒内返回画面）'
      }
    }
    if (message.includes('empty')) {
      return {
        code: ns.ERROR_CODES.screenshotCaptureFailed,
        message: '截图返回了空画面'
      }
    }
    if (/activeTab|permission|denied/i.test(message)) {
      return {
        code: ns.ERROR_CODES.screenshotCaptureFailed,
        message: '当前页面未授予截图所需的临时权限，请重新点击扩展图标后再试'
      }
    }
    return {
      code: ns.ERROR_CODES.screenshotCaptureFailed,
      message: `截图失败：${message}`
    }
  }

  ns.SCREENSHOT_MIN_INTERVAL_MS = MIN_INTERVAL_MS
  ns.SCREENSHOT_MAX_INTERVAL_MS = MAX_INTERVAL_MS
  ns.captureVisibleTab = captureVisibleTab
  ns.classifyCaptureError = classifyCaptureError
  ns.screenshotCurrentIntervalMs = function () {
    return currentIntervalMs
  }
})(globalThis)
