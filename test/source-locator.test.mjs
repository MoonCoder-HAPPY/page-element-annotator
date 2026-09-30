// @ts-check
/**
 * 源码定位单测（ticket 05）。
 *
 * ## 为什么用手写的 fiber 形状而不是真 React
 *
 * 引入真 React（哪怕是 dev 版）会让这个测试依赖一整套打包与 JSX 运行时。
 * 被测契约其实很窄：**给定一根 fiber 链，能不能正确取出 `_debugSource` 与组件名**。
 * 所以这里直接造 fiber 形状的对象——契约清晰，跑得快，也不依赖外部版本。
 *
 * 真实渲染下的可用率由 `verify-in-chrome.mjs` 与 spec §19.1 的风险实测覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')

const LOAD_ORDER = [
  'src/shared/text-utils.js',
  'src/shared/surrogate-safe-string.js',
  'src/shared/budget.js',
  'src/shared/format.js',
  'src/shared/attribute-allowlist.js',
  'src/shared/secret-patterns.js',
  'src/content/source-locator.js'
]

for (const relative of LOAD_ORDER) {
  new Function(readFileSync(join(extensionRoot, relative), 'utf8')).call(globalThis)
}
const ns = globalThis.__EG__

/**
 * 造一个可在 `locateSource` 里走通的元素 stub。
 * @param {{ fiber?: any, vue?: any, attributes?: Record<string, string>, parent?: any }} options
 */
function fakeElement(options = {}) {
  const element = {
    parentElement: options.parent ?? null,
    getAttribute(name) {
      const table = options.attributes || {}
      return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : null
    }
  }
  if (options.fiber) {
    // 键名带哈希后缀，模拟真实 React 的形态。
    element['__reactFiber$abc123'] = options.fiber
  }
  if (options.vue) {
    element.__vueParentComponent = options.vue
  }
  return element
}

/**
 * 造一根 fiber 链。
 * @param {{ name?: string, source?: { fileName: string, lineNumber: number, columnNumber?: number } }} options
 */
function fakeFiber(options = {}) {
  const fiber = {
    type: options.name ? { name: options.name } : 'div',
    return: null
  }
  if (options.source) {
    fiber._debugSource = options.source
  }
  return fiber
}

// ---------------------------------------------------------------------------
// 第 1 档：React fiber
// ---------------------------------------------------------------------------

test('第 1 档：从 fiber 链取出源文件位置与组件名', () => {
  const leaf = fakeFiber({ name: 'SubmitButton', source: { fileName: 'src/components/Cart.tsx', lineNumber: 42, columnNumber: 7 } })
  const parent = fakeFiber({ name: 'CartActions' })
  parent.return = fakeFiber({ name: 'CartPage' })
  leaf.return = parent

  const result = ns.locateSource(fakeElement({ fiber: leaf }))

  assert.equal(result.sourceFile, 'src/components/Cart.tsx:42:7')
  assert.equal(result.locatedBy, 'react-fiber')
  // 顺序是**由外到内**的层级路径（与参考实现一致）。
  // 为什么不是由内到外：`<CartPage> <CartActions> <SubmitButton>` 读起来就是
  // "这个按钮在页面 → 购物车操作区 → 里"，层级信息直接可读；
  // 反过来只是一串名字，读者得自己在脑子里重建层级。
  assert.equal(result.reactComponents, '<CartPage> <CartActions> <SubmitButton>')
})

test('第 1 档：无列号时只输出 file:line', () => {
  const fiber = fakeFiber({ name: 'Widget', source: { fileName: 'src/Widget.tsx', lineNumber: 9 } })
  const result = ns.locateSource(fakeElement({ fiber }))
  assert.equal(result.sourceFile, 'src/Widget.tsx:9')
})

test('第 1 档：构建器前缀被清理成可读路径', () => {
  const cases = [
    ['webpack-internal:///./src/a.tsx', 'src/a.tsx'],
    ['webpack-internal:///src/b.tsx', 'src/b.tsx'],
    ['turbopack:///[project]/src/c.tsx', 'src/c.tsx'],
    ['turbopack:///src/d.tsx', 'src/d.tsx'],
    ['file:///home/me/app/src/e.tsx', '/home/me/app/src/e.tsx'],
    ['./src/f.tsx', 'src/f.tsx'],
    ['https://example.com/src/g.tsx', 'src/g.tsx']
  ]
  for (const [input, expected] of cases) {
    const fiber = fakeFiber({ name: 'C', source: { fileName: input, lineNumber: 1 } })
    const result = ns.locateSource(fakeElement({ fiber }))
    assert.equal(result.sourceFile, expected + ':1', `清理 ${input} 失败`)
  }
})

test('第 1 档：查询串与 hash 被剥掉', () => {
  const fiber = fakeFiber({ name: 'C', source: { fileName: 'src/a.tsx?foo=1#bar', lineNumber: 3 } })
  const result = ns.locateSource(fakeElement({ fiber }))
  assert.equal(result.sourceFile, 'src/a.tsx:3')
})

test('第 1 档：框架内部组件名被过滤，且有数量与长度上限', () => {
  const leaf = fakeFiber({ name: 'RealButton' })
  let current = leaf
  // 一串应当被过滤的框架内部名字。
  for (const name of [
    'Fragment',
    'Root',
    'Routes',
    'Provider',
    'ErrorBoundary',
    'ContextConsumerWrapper',
    'InnerThing',
    'Ab'
  ]) {
    const next = fakeFiber({ name })
    current.return = next
    current = next
  }
  // 再加一串真实组件名，验证 6 个的上限。
  for (const name of ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8']) {
    const next = fakeFiber({ name })
    current.return = next
    current = next
  }

  const result = ns.locateSource(fakeElement({ fiber: leaf }))
  const names = result.reactComponents.match(/<([^>]+)>/g) || []
  assert.ok(names.length <= 6, `组件名数量应 ≤6，实际 ${names.length}`)
  for (const filtered of ['Fragment', 'Root', 'Routes', 'Provider', 'ErrorBoundary', 'InnerThing', 'Ab']) {
    assert.ok(
      !result.reactComponents.includes(filtered),
      `框架内部名 ${filtered} 不该出现在输出里`
    )
  }
  assert.ok(result.reactComponents.includes('<RealButton>'))
})

test('第 1 档：fiber 上溯有深度上限，超深链不会拖长抽取', () => {
  const leaf = fakeFiber()
  let current = leaf
  for (let i = 0; i < 200; i++) {
    const next = fakeFiber({ name: 'C' + i })
    current.return = next
    current = next
  }
  // 只在第 100 层放 source：超过 35 层上限就取不到。
  current._debugSource = { fileName: 'deep.tsx', lineNumber: 1 }

  const result = ns.locateSource(fakeElement({ fiber: leaf }))
  assert.equal(result.sourceFile, null, '超过深度上限的 source 不该被取到')
})

test('第 1 档：源码路径命中机密模式时整条丢弃（而不是输出 [redacted]:12）', () => {
  const fiber = fakeFiber({
    name: 'C',
    source: { fileName: 'src/access_token-holder.tsx', lineNumber: 12 }
  })
  const result = ns.locateSource(fakeElement({ fiber }))
  assert.equal(result.sourceFile, null)
})

test('第 1 档：元素上没有 fiber 键时返回 null', () => {
  const result = ns.locateSource(fakeElement())
  assert.deepEqual(
    { sourceFile: result.sourceFile, reactComponents: result.reactComponents, locatedBy: result.locatedBy },
    { sourceFile: null, reactComponents: null, locatedBy: null }
  )
})

test('第 1 档：键名前缀匹配而非固定键名（React 19 起键名形态变过）', () => {
  const fiber = fakeFiber({ name: 'C', source: { fileName: 'a.tsx', lineNumber: 1 } })
  const element = { getAttribute: () => null, parentElement: null }
  element['__reactFiber$totally-different-hash'] = fiber
  const result = ns.locateSource(element)
  assert.equal(result.sourceFile, 'a.tsx:1')
})

test('第 1 档：`__reactInternalInstance$` 前缀也能认（React 16 legacy）', () => {
  const fiber = fakeFiber({ name: 'Legacy', source: { fileName: 'legacy.tsx', lineNumber: 5 } })
  const element = { getAttribute: () => null, parentElement: null }
  element['__reactInternalInstance$zzz'] = fiber
  const result = ns.locateSource(element)
  assert.equal(result.sourceFile, 'legacy.tsx:5')
})

test('第 1 档：只有组件名没有 source 时也返回（组件名仍是有用信息）', () => {
  let leaf = fakeFiber({ name: 'NamedOnly' })
  const result = ns.locateSource(fakeElement({ fiber: leaf }))
  assert.equal(result.sourceFile, null)
  assert.equal(result.reactComponents, '<NamedOnly>')
})

// ---------------------------------------------------------------------------
// 第 2 档：Vue
// ---------------------------------------------------------------------------

test('第 2 档：从 __vueParentComponent.type.__file 取出 SFC 路径', () => {
  const element = fakeElement({ vue: { type: { name: 'CartPanel', __file: 'src/CartPanel.vue' } } })
  const result = ns.locateSource(element)
  assert.equal(result.sourceFile, 'src/CartPanel.vue')
  assert.equal(result.locatedBy, 'vue-sfc')
  assert.ok(result.reactComponents === null || result.reactComponents.includes('CartPanel'))
})

test('第 2 档：无 React fiber 时才轮到 Vue（优先级正确）', () => {
  const fiber = fakeFiber({ name: 'ReactComp', source: { fileName: 'react.tsx', lineNumber: 1 } })
  const element = fakeElement({ fiber, vue: { type: { name: 'VueComp', __file: 'vue.vue' } } })
  const result = ns.locateSource(element)
  assert.equal(result.locatedBy, 'react-fiber')
  assert.equal(result.sourceFile, 'react.tsx:1')
})

test('第 2 档：向上遍历祖先寻找 vue 组件（元素本身可能没有）', () => {
  const ancestor = fakeElement({ vue: { type: { name: 'Panel', __file: 'src/Panel.vue' } } })
  const child = fakeElement({ parent: ancestor })
  const result = ns.locateSource(child)
  assert.equal(result.sourceFile, 'src/Panel.vue')
  assert.equal(result.locatedBy, 'vue-sfc')
})

// ---------------------------------------------------------------------------
// 第 3 档：约定属性
// ---------------------------------------------------------------------------

test('第 3 档：data-v-inspector / data-source / data-source-file 都能命中', () => {
  for (const attribute of ns.CONVENTION_ATTRIBUTES) {
    const element = fakeElement({ attributes: { [attribute]: 'src/from-attribute.tsx:7' } })
    const result = ns.locateSource(element)
    assert.equal(result.sourceFile, 'src/from-attribute.tsx:7', `${attribute} 未被识别`)
    assert.equal(result.locatedBy, 'convention-attribute')
  }
})

test('第 3 档：属性值同样会被清理前缀', () => {
  const element = fakeElement({ attributes: { 'data-source': 'webpack:///./src/x.tsx' } })
  const result = ns.locateSource(element)
  assert.equal(result.sourceFile, 'src/x.tsx')
})

test('第 3 档：属性值命中机密模式时丢弃', () => {
  const element = fakeElement({ attributes: { 'data-source': 'src/client_secret.tsx' } })
  const result = ns.locateSource(element)
  assert.equal(result.sourceFile, null)
})

test('第 3 档：向上遍历祖先寻找约定属性', () => {
  const ancestor = fakeElement({ attributes: { 'data-source': 'src/ancestor.tsx' } })
  const child = fakeElement({ parent: ancestor })
  const result = ns.locateSource(child)
  assert.equal(result.sourceFile, 'src/ancestor.tsx')
  assert.equal(result.locatedBy, 'convention-attribute')
})

// ---------------------------------------------------------------------------
// 第 4 档与失效语义
// ---------------------------------------------------------------------------

test('第 4 档：三档都拿不到时返回 null（由格式化器输出诚实缺省）', () => {
  const result = ns.locateSource(fakeElement())
  assert.equal(result.sourceFile, null)
  assert.equal(result.reactComponents, null)
  assert.equal(result.locatedBy, null)
})

test('某一档抛错不影响其余档（整体可失效但不崩）', () => {
  const element = fakeElement({ attributes: { 'data-source': 'src/fallback.tsx' } })
  // 让 fiber 取值时抛错。
  Object.defineProperty(element, '__reactFiber$boom', {
    enumerable: true,
    get() {
      throw new Error('boom')
    }
  })
  const result = ns.locateSource(element)
  assert.equal(result.sourceFile, 'src/fallback.tsx', '第 1 档抛错后应继续走到第 3 档')
})

test('超长路径按预算截断并带后缀', () => {
  const fiber = fakeFiber({
    name: 'C',
    source: { fileName: 'x'.repeat(600), lineNumber: 1 }
  })
  const result = ns.locateSource(fakeElement({ fiber }))
  assert.ok(result.sourceFile.length <= ns.BUDGET.sourceFileMaxLength + ns.TRUNCATION_SUFFIX.length)
  assert.ok(result.sourceFile.endsWith(ns.TRUNCATION_SUFFIX))
})

test('组件名串超长时按预算截断', () => {
  const leaf = fakeFiber({ name: 'A'.repeat(80) })
  let current = leaf
  for (let i = 0; i < 5; i++) {
    const next = fakeFiber({ name: 'B'.repeat(80) + i })
    current.return = next
    current = next
  }
  const result = ns.locateSource(fakeElement({ fiber: leaf }))
  assert.ok(result.reactComponents.length <= ns.BUDGET.reactComponentsMaxLength + ns.TRUNCATION_SUFFIX.length)
})

test('source-locator 已挂到命名空间上，且 extract.js 会用到它', () => {
  assert.equal(typeof ns.locateSource, 'function')
  // 防止"实现了但没接上"：extract.js 必须引用 locateSource。
  const extractSource = readFileSync(join(extensionRoot, 'src/content/extract.js'), 'utf8')
  assert.ok(
    extractSource.includes('locateSource'),
    'extract.js 没有引用 locateSource —— 源码定位不会生效'
  )
  // 服务端注入清单必须包含它，且排在 extract.js 之前。
  const serviceWorker = readFileSync(
    join(extensionRoot, 'src/background/service-worker.js'),
    'utf8'
  )
  const locatorIndex = serviceWorker.indexOf('src/content/source-locator.js')
  const extractIndex = serviceWorker.indexOf('src/content/extract.js')
  assert.ok(locatorIndex !== -1, 'source-locator.js 不在注入清单里')
  assert.ok(
    locatorIndex < extractIndex,
    'source-locator.js 必须在 extract.js 之前注入（否则 extract 读到 undefined）'
  )
})
