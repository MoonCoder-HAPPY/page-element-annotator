// @ts-check
/**
 * 截图管道诊断。
 *
 * ## 为什么需要这个
 *
 * 真机上截图一直失败，三种提示都出现过：
 * - `没有截图：截图数据未通过校验。`（payload_invalid）
 * - `没有截图：浏览器拒绝了截图请求。`（screenshot_capture_failed）
 * - 有时没有任何原因
 *
 * 而我在本地把整条管道跑通过（裁剪 → 校验 → 保留），复现不出来 —— 它依赖真实的
 * `chrome.tabs.captureVisibleTab`，那个 API 只存在于扩展上下文，本环境加载不了扩展。
 *
 * 所以这里把**每一步的中间产物**记下来：真的 data URL 前缀、字节量、裁剪尺寸、
 * 校验拒绝的理由。出问题时能在扩展自己的界面上看到，不需要开控制台。
 *
 * 记录上限 10 条、只保留最近一次会话的量，避免把 storage 撑大。
 */
;(function attachShotDiagnostics(scope) {
  'use strict'

  const ns = (scope.__EG__ = scope.__EG__ || {})

  const STORAGE_KEY = 'shotDiagnostics'
  const MAX_ENTRIES = 10
  /** 单个字段的截断长度：诊断只需要看前缀与量级，不需要整张图。 */
  const FIELD_LIMIT = 120

  /**
   * @param {unknown} value
   */
  function brief(value) {
    if (typeof value !== 'string') {
      return { type: typeof value, value: value === null ? 'null' : undefined }
    }
    return {
      length: value.length,
      prefix: value.slice(0, FIELD_LIMIT)
    }
  }

  /**
   * 写入串行化。
   *
   * 诊断是"读列表 → 追加 → 写回"，而多条诊断会在同一毫秒内连续发来
   * （取图、解码、裁剪几乎同时上报）。并发做读-改-写时，几个写入都基于同一份旧列表，
   * 后写的覆盖先写的 —— 结果就是**有一部分记录凭空消失**。
   *
   * 我第一版就是这样：`flow:cropOk` 明明该上报，却从来没出现在界面上，
   * 于是我被引向"是不是裁剪没跑"的错误方向，真凶（常量跨上下文缺失）反而看不见。
   * 一个会丢数据的诊断工具，比没有诊断更坏。
   */
  let writeChain = Promise.resolve()

  /**
   * 记一条诊断。**永不抛错**：诊断本身绝不能成为新的失败来源。
   *
   * @param {string} stage
   * @param {any} detail
   */
  function recordShotDiagnostic(stage, detail) {
    const payload = {
      at: new Date().toISOString(),
      stage,
      detail
    }
    writeChain = writeChain
      .then(function () {
        return appendEntry(payload)
      })
      .catch(function () {
        // 忽略：诊断写入失败不影响抓取，也不该打断后续写入的链条。
      })
  }

  /**
   * @param {any} payload
   */
  async function appendEntry(payload) {
    try {
      if (!scope.chrome || !chrome.storage || !chrome.storage.local) {
        return
      }
      const stored = await chrome.storage.local.get([STORAGE_KEY])
      const list = Array.isArray(stored && stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : []
      list.push(payload)
      while (list.length > MAX_ENTRIES) {
        list.shift()
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: list })
    } catch (error) {
      // 同上。
    }
  }

  /**
   * 给一段 data URL 做体检。**不改动它**，只描述它。
   *
   * @param {unknown} dataUrl
   * @param {string} label
   */
  function inspectDataUrl(dataUrl, label) {
    const report = { label }
    if (typeof dataUrl !== 'string') {
      report.kind = typeof dataUrl
      return report
    }
    report.length = dataUrl.length
    report.prefix = dataUrl.slice(0, FIELD_LIMIT)
    report.startsWithPng = dataUrl.indexOf(ns.PNG_DATA_URL_PREFIX) === 0
    const semicolon = dataUrl.indexOf(';')
    report.mime = semicolon > 0 ? dataUrl.slice(5, semicolon) : '(no semicolon)'
    const comma = dataUrl.indexOf(',')
    report.payloadLength = comma > 0 ? dataUrl.length - comma - 1 : 0
    return report
  }

  ns.recordShotDiagnostic = recordShotDiagnostic
  ns.inspectDataUrl = inspectDataUrl
  ns.SHOT_DIAGNOSTICS_KEY = STORAGE_KEY
})(globalThis)
