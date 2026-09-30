/**
 * fixture 的渲染脚本。
 *
 * ## 为什么显式传 `__source`
 *
 * `_debugSource` 的写入路径是：JSX 编译插件把 `__source={{ fileName, lineNumber, columnNumber }}`
 * 塞进 element 参数 → React 的 **development** 构建在创建 fiber 时把它搬到 `fiber._debugSource`。
 *
 * 这里没有 Babel，所以直接手工传 `__source` —— 等价于 Babel 自动做的事。
 * 用 `React.createElement` 而不是 jsxDEV：dev 构建里两条路径都会落到 `_debugSource`，
 * 而 createElement 在 UMD 下可用（`jsxDEV` 不是 UMD 的公开导出）。
 */
;(function renderFixture() {
  'use strict'

  const h = React.createElement
  const root = document.getElementById('root')
  const resultElement = document.getElementById('result')

  /** 造一个带源码位置的 element。 */
  function withSource(type, props, source) {
    return h(type, Object.assign({}, props, { __source: source }), props && props.children)
  }

  const submitSource = { fileName: 'src/components/SubmitButton.tsx', lineNumber: 42, columnNumber: 7 }
  const actionsSource = { fileName: 'src/components/CartActions.tsx', lineNumber: 18, columnNumber: 3 }
  const pageSource = { fileName: 'turbopack:///[project]/src/pages/CartPage.tsx', lineNumber: 9, columnNumber: 1 }

  function SubmitButton(props) {
    return withSource('button', { id: 'submit-order', className: 'btn', children: props.label }, submitSource)
  }

  function CartActions() {
    return withSource('div', { className: 'cart-actions', children: withSource(SubmitButton, { label: 'Submit order' }, submitSource) }, actionsSource)
  }

  function CartPage() {
    return withSource('div', { id: 'cart', children: withSource(CartActions, {}, actionsSource) }, pageSource)
  }

  // React 18 的 UMD dev 构建用 ReactDOM.createRoot。
  const reactRoot = ReactDOM.createRoot(root)
  reactRoot.render(withSource(CartPage, {}, pageSource))

  // 等 React 提交完成后再测量。
  setTimeout(measure, 400)

  function measure() {
    const target = document.querySelector('#submit-order')
    if (!target) {
      report({ ok: false, reason: 'React 未渲染出目标元素' })
      return
    }

    // 1) fiber 键存不存在（前缀匹配 vs 固定键名）
    const keys = Object.keys(target)
    const fiberKey = keys.find(
      (k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0
    )

    // 2) 沿 fiber 上溯，看 `_debugSource` 到底有没有、在第几层
    let fiber = fiberKey ? target[fiberKey] : null
    const fiberWalk = []
    let depth = 0
    let firstSourceDepth = -1
    while (fiber && depth < 35) {
      const source = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource)
      const name = fiber.type && (fiber.type.displayName || fiber.type.name)
      fiberWalk.push({
        depth,
        componentName: typeof name === 'string' ? name : null,
        hasOwnDebugSource: Boolean(fiber._debugSource),
        hasOwnerDebugSource: Boolean(fiber._debugOwner && fiber._debugOwner._debugSource),
        fileName: source && source.fileName ? String(source.fileName) : null,
        lineNumber: source && source.lineNumber !== undefined ? source.lineNumber : null
      })
      if (firstSourceDepth === -1 && source && source.fileName && source.lineNumber) {
        firstSourceDepth = depth
      }
      fiber = fiber.return
      depth++
    }

    // 3) 用项目自己的定位器跑一遍，看端到端是否命中
    let locatorResult = null
    if (typeof globalThis.__EG__ !== 'undefined' && globalThis.__EG__.locateSource) {
      locatorResult = globalThis.__EG__.locateSource(target)
    }

    report({
      ok: true,
      reactVersion: React.version,
      fiberFound: Boolean(fiber),
      fiberKeyPrefixSeen: fiberKey ? fiberKey.slice(0, 32) : null,
      firstSourceDepth,
      fiberWalk,
      locatorResult
    })
  }

  function report(payload) {
    globalThis.__probeResult = payload
    resultElement.textContent = JSON.stringify(payload, null, 2)
  }
})()
