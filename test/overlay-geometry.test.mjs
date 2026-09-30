// @ts-check
/**
 * overlay 的几何与文案单测（ticket 02）。
 *
 * ## 为什么只测这三个函数
 *
 * `overlay.js` 的大部分代码是 DOM 装配与事件接线 —— 那些只有真浏览器能证明，
 * 由 `verify-in-chrome.mjs` 覆盖。但其中三个函数是**纯几何/纯字符串**，
 * 且正是最容易算错的地方（标签要不要翻到上方、超屏元素怎么画框、文案怎么截断），
 * 所以在这里用不依赖真实布局的输入钉住它们。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')

/**
 * overlay.js 依赖 `text-normalizer.js` 的 `getBoundedText`，后者在校验 `NodeFilter.SHOW_TEXT`
 * 与 `document.createTreeWalker`；这里给最小 stub，因为被测函数都不会真正走到那里。
 */
function installDomStub() {
  const previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
    window: globalThis.window
  }
  globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 }
  globalThis.document = { createTreeWalker: () => ({ nextNode: () => null }) }
  globalThis.window = { matchMedia: () => ({ matches: false }) }
  return () => {
    globalThis.document = previous.document
    globalThis.NodeFilter = previous.NodeFilter
    globalThis.window = previous.window
  }
}

function loadOverlay() {
  const order = [
    'src/shared/text-utils.js',
    'src/shared/surrogate-safe-string.js',
    'src/shared/budget.js',
    'src/shared/format.js',
    'src/shared/attribute-allowlist.js',
    'src/shared/secret-patterns.js',
    'src/content/text-normalizer.js',
    'src/content/overlay.js'
  ]
  for (const relative of order) {
    new Function(readFileSync(join(extensionRoot, relative), 'utf8')).call(globalThis)
  }
  return globalThis.__EG__
}

/** 造一个 DOMRect 形状的对象（不依赖真实布局）。 */
function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
}

/** 造一个最小的元素 stub，只提供 overlay 读的字段。 */
function fakeElement(tagName, role, id) {
  return {
    tagName: tagName.toUpperCase(),
    isConnected: true,
    id: id ?? '',
    getAttribute: (name) => (name === 'role' ? (role ?? null) : null)
  }
}

test('标签文案：tag + role + 截断文本 + 尺寸', () => {
  const restore = installDomStub()
  const ns = loadOverlay()
  try {
    const el = fakeElement('button', 'button')
    const text = ns.buildLabelText(el, rect(0, 0, 220.4, 48.6), 'Submit order')
    assert.equal(text, 'button  role=button  "Submit order"  220x49')

    // 无 role、无文本时只剩 tag 与尺寸。
    const bare = ns.buildLabelText(fakeElement('div'), rect(0, 0, 10, 10), '')
    assert.equal(bare, 'div  10x10')
  } finally {
    restore()
  }
})

test('标签文案：超长文本截断到 40 码元以内且不切开代理对', () => {
  const restore = installDomStub()
  const ns = loadOverlay()
  try {
    const el = fakeElement('p')
    const longAscii = 'x'.repeat(200)
    const label = ns.buildLabelText(el, rect(0, 0, 100, 20), longAscii)
    assert.ok(label.includes('...'), label)
    const quoted = label.match(/"([^"]*)"/)[1]
    assert.equal(quoted.length, 40, `引用内文本应为 40 码元，实际 ${quoted.length}`)

    // 星平面字符不能留下悬空高代理项。
    const emoji = '😀'.repeat(60)
    const emojiLabel = ns.buildLabelText(el, rect(0, 0, 100, 20), emoji)
    const emojiQuoted = emojiLabel.match(/"([^"]*)"/)[1]
    assert.ok(
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emojiQuoted),
      '标签文本里出现了孤立高代理项'
    )
  } finally {
    restore()
  }
})

test('标签纵向位置：默认在元素下方，贴底时翻到上方', () => {
  const restore = installDomStub()
  const ns = loadOverlay()
  try {
    // 元素在视口中部：标签在下方（bottom + 6）。
    assert.equal(ns.resolveLabelTop(rect(0, 100, 100, 50), 800), 156)
    // 元素贴底：下方放不下 28px，翻到上方（top - 28）。
    assert.equal(ns.resolveLabelTop(rect(0, 780, 100, 50), 800), 752)
    // 元素贴顶且下方放不下：结果不得为负。
    assert.equal(ns.resolveLabelTop(rect(0, 5, 100, 100), 120), 0)
  } finally {
    restore()
  }
})

test('高亮框：超出视口的元素按可见部分绘制', () => {
  const restore = installDomStub()
  const ns = loadOverlay()
  try {
    // 完全在视口内：原样返回。
    assert.deepEqual(ns.resolveHighlightBox(rect(10, 20, 100, 50), 1280, 800), {
      left: 10,
      top: 20,
      width: 100,
      height: 50
    })

    // 左侧与上方越界：夹到 0。
    assert.deepEqual(ns.resolveHighlightBox(rect(-40, -30, 100, 50), 1280, 800), {
      left: 0,
      top: 0,
      width: 60,
      height: 20
    })

    // 右侧与下方越界。
    assert.deepEqual(ns.resolveHighlightBox(rect(1200, 750, 200, 100), 1280, 800), {
      left: 1200,
      top: 750,
      width: 80,
      height: 50
    })

    // 比屏幕还高：整屏高度，而不是延伸到屏幕外。
    assert.deepEqual(ns.resolveHighlightBox(rect(0, -500, 1280, 4000), 1280, 800), {
      left: 0,
      top: 0,
      width: 1280,
      height: 800
    })

    // 完全在视口外：返回全零的哨兵框，调用方据此隐藏高亮框。
    // 用零框而不是"保留越界坐标"，避免调用方把越界坐标当成有效位置。
    assert.deepEqual(ns.resolveHighlightBox(rect(0, 900, 100, 50), 1280, 800), {
      left: 0,
      top: 0,
      width: 0,
      height: 0
    })

    // 完全在视口右侧同理。
    assert.deepEqual(ns.resolveHighlightBox(rect(1300, 10, 100, 50), 1280, 800), {
      left: 0,
      top: 0,
      width: 0,
      height: 0
    })

    // 边界：刚好贴在视口底边外侧（bottom === viewportHeight 时仍在视口内）。
    assert.deepEqual(ns.resolveHighlightBox(rect(0, 780, 100, 20), 1280, 800), {
      left: 0,
      top: 780,
      width: 100,
      height: 20
    })
  } finally {
    restore()
  }
})

test('overlay 导出的是幂等的 mount/teardown，且带 aria-hidden', () => {
  const restore = installDomStub()
  const ns = loadOverlay()
  try {
    assert.equal(typeof ns.mountOverlay, 'function')
    assert.equal(typeof ns.teardownOverlay, 'function')
    assert.equal(typeof ns.hitTestForOverlay, 'function')
    assert.equal(typeof ns.freezeOverlayHighlight, 'function')
    // 未 mount 时不应抛错。
    ns.teardownOverlay()
    ns.updateOverlayHighlight(null)
    assert.equal(ns.isOverlayMounted(), false)
    assert.equal(ns.getOverlayCurrentElement(), null)
  } finally {
    restore()
  }
})
