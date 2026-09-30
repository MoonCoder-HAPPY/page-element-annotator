// @ts-check
/**
 * 抓取预算常量。
 *
 * 单一来源：内容脚本与 service worker 都从这里读，数值必须与
 * `.spec-workflow/element-grab-extension/spec.md` §10.2 的表格逐项一致。
 * 任何一侧另起一份数字都会让"抽取端截断一次、校验端再截断一次"的行为产生分歧。
 *
 * 语法说明：本文件是**经典脚本**（不是 ES module），因为
 * `chrome.scripting.executeScript({ files })` 不解析 import/export 语法。
 * 所有内容侧脚本通过 `globalThis.__EG__` 命名空间互相访问，见 spec 决策 I-1。
 */
;(function attachBudget(scope) {
  'use strict'

  /** @type {Readonly<Record<string, number>>} */
  const BUDGET = Object.freeze({
    textSnippetMaxLength: 200,
    nearbyTextEntryMaxLength: 200,
    nearbyTextMaxEntries: 10,
    htmlSnippetMaxLength: 4096,
    ancestorPathMaxEntries: 10,
    nearbyElementsMaxEntries: 6,
    nearbyElementMaxLength: 160,
    selectorMaxLength: 700,
    pathMaxLength: 900,
    cssClassesMaxLength: 500,
    selectedTextMaxLength: 500,
    sourceFileMaxLength: 500,
    reactComponentsMaxLength: 500,
    annotationCommentMaxLength: 2000,
    annotationsMaxPerPage: 20,
    /** 截图 PNG 的硬字节上限（非 base64 长度）。供 ticket 04 使用。 */
    screenshotMaxBytes: 2 * 1024 * 1024
  })

  /** 文本节点扫描上限：防止超大 DOM 页面把抽取耗时拖到 tick 级。 */
  const TEXT_NODE_SCAN_LIMIT = 80

  /** 兄弟节点扫描上限：与文本扫描同因。 */
  const NEARBY_ELEMENT_SCAN_LIMIT = 80

  /** 抽取的计算样式，顺序即 spec §10.3 的顺序。 */
  const STYLE_PROPS = Object.freeze([
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'color',
    'backgroundColor',
    'border',
    'borderRadius',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'textAlign',
    'zIndex'
  ])

  /** 截断后缀。注意它会让输出略超名义上限（约 12 字符），这是已知且可接受的。 */
  const TRUNCATION_SUFFIX = ' (truncated)'

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.BUDGET = BUDGET
  scope.__EG__.TEXT_NODE_SCAN_LIMIT = TEXT_NODE_SCAN_LIMIT
  scope.__EG__.NEARBY_ELEMENT_SCAN_LIMIT = NEARBY_ELEMENT_SCAN_LIMIT
  scope.__EG__.STYLE_PROPS = STYLE_PROPS
  scope.__EG__.TRUNCATION_SUFFIX = TRUNCATION_SUFFIX
})(globalThis)
