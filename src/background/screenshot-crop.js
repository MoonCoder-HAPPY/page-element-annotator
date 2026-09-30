// @ts-check
/**
 * 截图裁剪：把 `captureVisibleTab` 返回的整屏 PNG 按元素矩形裁出来。
 *
 * ## 两个容易算错的地方
 *
 * 1. **`captureVisibleTab` 返回的是设备像素图**，而元素的 `getBoundingClientRect()`
 *    是 CSS 像素。裁剪前必须乘 `devicePixelRatio`，否则在高 DPI 屏幕上会裁错位置
 *    （在 dpr=2 的屏幕上拿到的会是一半大小的区域）。
 *
 * 2. **舍入后的矩形可能越界**。`Math.round` 之后的右/下边界可能比图像本身大 1px，
 *    直接传给 `drawImage` 会得到透明边或被裁短的图。所以必须夹到图像尺寸内。
 *
 * 本模块是纯几何 + `OffscreenCanvas`，不依赖 DOM，可以在 Node 里用手写的
 * `OffscreenCanvas` 桩单测（见 `test/screenshot-crop.test.mjs`）。
 *
 * 对应 spec §14.10。
 */
;(function attachScreenshotCrop(scope) {
  'use strict'

  const ns = (scope.__EG__ = scope.__EG__ || {})

  /** 裁剪失败的原因码，与 spec §9.1 的错误码一致。 */
  const CROP_FAILURE = Object.freeze({
    empty: 'screenshot_crop_empty',
    invalidRect: 'screenshot_crop_invalid_rect'
  })

  /**
   * 把 CSS 像素矩形换算成设备像素裁剪框，并夹到图像范围内。
   *
   * @param {{ x: number, y: number, width: number, height: number }} rectViewport
   * @param {number} devicePixelRatio
   * @param {number} imageWidth
   * @param {number} imageHeight
   * @returns {{ ok: true, box: { x: number, y: number, width: number, height: number } }
   *          | { ok: false, reason: string }}
   */
  function computeCropBox(rectViewport, devicePixelRatio, imageWidth, imageHeight) {
    const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1

    const left = Math.round(rectViewport.x * dpr)
    const top = Math.round(rectViewport.y * dpr)
    const right = Math.round((rectViewport.x + rectViewport.width) * dpr)
    const bottom = Math.round((rectViewport.y + rectViewport.height) * dpr)

    const x = Math.max(0, Math.min(left, imageWidth))
    const y = Math.max(0, Math.min(top, imageHeight))
    const clampedRight = Math.max(0, Math.min(right, imageWidth))
    const clampedBottom = Math.max(0, Math.min(bottom, imageHeight))

    const width = clampedRight - x
    const height = clampedBottom - y

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return { ok: false, reason: CROP_FAILURE.invalidRect }
    }
    if (width <= 0 || height <= 0) {
      return { ok: false, reason: CROP_FAILURE.empty }
    }
    return { ok: true, box: { x, y, width, height } }
  }

  /**
   * 元素是否完全落在视口内。
   *
   * 只有"完全在视口内"才值得直接截图：部分可见的元素截出来是残缺的，
   * 那种情况应当先滚动到可见（见 spec §6.1 的主流程）。
   *
   * @param {{ x: number, y: number, width: number, height: number }} rectViewport
   * @param {number} viewportWidth
   * @param {number} viewportHeight
   */
  function isFullyInsideViewport(rectViewport, viewportWidth, viewportHeight) {
    return (
      rectViewport.x >= 0 &&
      rectViewport.y >= 0 &&
      rectViewport.x + rectViewport.width <= viewportWidth &&
      rectViewport.y + rectViewport.height <= viewportHeight
    )
  }

  /**
   * 估算 PNG data URL 的字节数。
   *
   * 不真的解码：那是几十 MB 的内存与毫秒级开销，而我们只需要一个上限判断。
   * base64 的 4 个字符编码 3 个字节，因此 `ceil(length / 4) * 3` 是保守上界。
   *
   * @param {string} dataUrl
   */
  function estimateDataUrlBytes(dataUrl) {
    const prefix = ns.PNG_DATA_URL_PREFIX
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
      return 0
    }
    const base64Length = dataUrl.length - prefix.length
    return Math.ceil(base64Length / 4) * 3
  }

  /**
   * 从整屏图裁出元素区域。
   *
   * @param {any} imageBitmap 已经解码的整屏位图（由调用方 decode）
   * @param {{ x: number, y: number, width: number, height: number }} rectViewport
   * @param {number} devicePixelRatio
   * @returns {Promise<{ ok: true, dataUrl: string, width: number, height: number, byteLength: number }
   *          | { ok: false, reason: string }>}
   */
  async function cropScreenshot(imageBitmap, rectViewport, devicePixelRatio) {
    const boxResult = computeCropBox(
      rectViewport,
      devicePixelRatio,
      imageBitmap.width,
      imageBitmap.height
    )
    if (!boxResult.ok) {
      return { ok: false, reason: boxResult.reason }
    }
    const box = boxResult.box

    const canvas = new OffscreenCanvas(box.width, box.height)
    const context = canvas.getContext('2d')
    if (!context) {
      return { ok: false, reason: CROP_FAILURE.invalidRect }
    }
    context.drawImage(
      imageBitmap,
      box.x,
      box.y,
      box.width,
      box.height,
      0,
      0,
      box.width,
      box.height
    )

    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const base64 = base64FromBytes(bytes)

    return {
      ok: true,
      dataUrl: ns.PNG_DATA_URL_PREFIX + base64,
      width: box.width,
      height: box.height,
      byteLength: bytes.length
    }
  }

  /**
   * 字节数组 → base64。不用 `btoa(String.fromCharCode(...))` 是因为大数组会撑爆调用栈。
   * @param {Uint8Array} bytes
   */
  function base64FromBytes(bytes) {
    const chunkSize = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)))
    }
    return btoa(binary)
  }

  ns.CROP_FAILURE = CROP_FAILURE
  ns.computeCropBox = computeCropBox
  ns.isFullyInsideViewport = isFullyInsideViewport
  ns.estimateDataUrlBytes = estimateDataUrlBytes
  ns.cropScreenshot = cropScreenshot
  ns.base64FromBytes = base64FromBytes
})(globalThis)
