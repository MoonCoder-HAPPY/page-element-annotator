// @ts-check
/**
 * 源码定位：尽力找出"这个元素在哪个源文件的哪一行"。
 *
 * ## 为什么是四档而不是一档
 *
 * 参考实现只有一条路径：沿 React fiber 取 `_debugSource`。那条路径**只在 dev 构建下有效**
 * （生产构建的 React 不写这个字段），所以生产站点上它永远拿不到值 —— 而且没有兜底文案时，
 * 用户只会看到一个空值，不知道是插件坏了还是本来就拿不到。
 *
 * 这里按可靠性从高到低依次尝试：
 *
 * 1. **React fiber 的 `_debugSource`** —— 最精确，含行号列号，仅 dev 构建
 * 2. **Vue 的 `__file`** —— SFC 编译产物上的字段，Vue 2/3 都有
 * 3. **约定属性** `data-v-inspector` / `data-source` / `data-source-file` —— 需要项目主动配合
 * 4. **都没有 → 返回 null**，由格式化器输出"诚实缺省"文案（spec §9.2）
 *
 * ## 明确不做的事
 *
 * **不解析 sourcemap**（spec §4.3 列为非目标）。它对 code-splitting / 内联 sourcemap /
 * 受保护构建都不稳，维护成本与收益不匹配。
 *
 * 整体可以失效：任何一档抛错都只是让这一档拿不到值，不影响主流程。
 */
;(function attachSourceLocator(scope) {
  'use strict'

  const ns = (scope.__EG__ = scope.__EG__ || {})

  /** fiber 上溯深度上限。深层组件树不能拖长抽取耗时（spec §12 的 400ms 预算）。 */
  const MAX_FIBER_DEPTH = 35
  /** 组件名保留上限。 */
  const MAX_COMPONENTS = 6

  /**
   * fiber 的键名带构建哈希后缀（`__reactFiber$abc123`），**必须前缀匹配**。
   * React 19 起键名形态变过一次，写死键名会在升级时静默失效（spec §15 R-7）。
   *
   * @param {Element} el
   */
  function getFiberFromElement(el) {
    let keys
    try {
      keys = Object.keys(el)
    } catch (error) {
      return null
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
        try {
          return el[key] || null
        } catch (error) {
          return null
        }
      }
    }
    return null
  }

  /**
   * @param {any} fiber
   */
  function getComponentNameFromFiber(fiber) {
    if (!fiber) {
      return null
    }
    const type = fiber.type || fiber.elementType
    if (!type || typeof type === 'string') {
      return null
    }
    if (type.displayName || type.name) {
      return type.displayName || type.name
    }
    if (type.render && (type.render.displayName || type.render.name)) {
      return type.render.displayName || type.render.name
    }
    if (type.type && (type.type.displayName || type.type.name)) {
      return type.type.displayName || type.type.name
    }
    return null
  }

  /**
   * 哪些组件名不值得写进上下文。框架内部的 Provider / Boundary / Router 一类
   * 对"改哪个文件"没有帮助，反而会挤掉真正有信息量的组件名。
   *
   * @param {string} name
   */
  function shouldSkipComponentName(name) {
    if (!name || name.length <= 2) {
      return true
    }
    return (
      /^(Fragment|Root|Routes|Route|Outlet|Provider|Consumer|Profiler|Suspense)$/.test(name) ||
      /(?:Boundary|BoundaryHandler|Router|Provider|Consumer|Context|Wrapper)$/.test(name) ||
      /^(Inner|Outer|Client|Server|RSC|Dev|React|Hot)/.test(name)
    )
  }

  /**
   * 清理构建器加在路径上的前缀，让输出是"人可以去找的那个路径"。
   *
   * @param {string} path
   */
  function cleanSourcePath(path) {
    if (!path) {
      return ''
    }
    return String(path)
      .replace(/[?#].*$/, '')
      .replace(/^turbopack:\/\/\/\[project\]\//, '')
      .replace(/^webpack-internal:\/\/\/\.\//, '')
      .replace(/^webpack-internal:\/\/\//, '')
      .replace(/^webpack:\/\/\/\.\//, '')
      .replace(/^webpack:\/\/\//, '')
      .replace(/^turbopack:\/\/\//, '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^file:\/\/\//, '/')
      .replace(/^\([^)]+\)\/\.\//, '')
      .replace(/^\.\//, '')
  }

  /**
   * 第 1 档：React fiber。
   *
   * @param {Element} el
   */
  function locateFromReact(el) {
    const fiber = getFiberFromElement(el)
    if (!fiber) {
      return null
    }
    const components = []
    let sourceFile = null
    let current = fiber
    let depth = 0

    while (current && depth < MAX_FIBER_DEPTH) {
      const name = getComponentNameFromFiber(current)
      if (
        name &&
        !shouldSkipComponentName(name) &&
        components.indexOf(name) === -1 &&
        components.length < MAX_COMPONENTS
      ) {
        components.push(name)
      }
      const source = current._debugSource || (current._debugOwner && current._debugOwner._debugSource)
      if (!sourceFile && source && source.fileName && source.lineNumber) {
        const raw =
          cleanSourcePath(source.fileName) +
          ':' +
          source.lineNumber +
          (source.columnNumber !== undefined ? ':' + source.columnNumber : '')
        // 与参考实现一致：源码路径命中机密模式时整条丢弃，而不是替换成 [redacted] ——
        // 一个"[redacted]:12:3" 对读者毫无价值，不如让格式化器输出诚实缺省。
        sourceFile = ns.containsSecret(raw) ? null : raw
      }
      current = current.return
      depth++
    }

    if (!sourceFile && components.length === 0) {
      return null
    }
    return { sourceFile, components }
  }

  /**
   * 第 2 档：Vue SFC 的 `__file`。
   *
   * Vue 把源文件路径挂在组件选项上，可以从 DOM 元素的 `__vue__`（Vue 2）
   * 或 `__vueParentComponent`（Vue 3）向上找。
   *
   * @param {Element} el
   */
  function locateFromVue(el) {
    /** @type {any} */
    let node = el
    let depth = 0
    while (node && depth < MAX_FIBER_DEPTH) {
      const candidate =
        node.__vue__ ||
        node.__vueParentComponent ||
        (node.__vueParentComponent && node.__vueParentComponent.type)
      const file = extractVueFile(candidate)
      if (file) {
        return { sourceFile: file, components: collectVueComponentNames(el) }
      }
      node = node.parentElement
      depth++
    }
    return null
  }

  /**
   * @param {any} candidate
   */
  function extractVueFile(candidate) {
    if (!candidate) {
      return null
    }
    const sources = [
      candidate.__file,
      candidate.type && candidate.type.__file,
      candidate.$options && candidate.$options.__file,
      candidate.constructor && candidate.constructor.__file
    ]
    for (const value of sources) {
      if (typeof value === 'string' && value.length > 0) {
        const cleaned = cleanSourcePath(value)
        if (cleaned && !ns.containsSecret(cleaned)) {
          return cleaned
        }
      }
    }
    return null
  }

  /**
   * Vue 的组件名。比 React 那侧弱得多（`__name` 是可选的），所以能拿多少算多少。
   * @param {Element} el
   */
  function collectVueComponentNames(el) {
    const names = []
    let node = el
    let depth = 0
    while (node && depth < MAX_FIBER_DEPTH && names.length < MAX_COMPONENTS) {
      const component = node.__vueParentComponent
      const type = component && component.type
      const name =
        (type && (type.name || type.__name)) ||
        (node.$options && (node.$options.name || node.$options._componentTag))
      if (name && typeof name === 'string' && !shouldSkipComponentName(name) && names.indexOf(name) === -1) {
        names.push(name)
      }
      node = node.parentElement
      depth++
    }
    return names
  }

  /** 第 3 档用到的约定属性。项目需要主动配合才会有值。 */
  const CONVENTION_ATTRIBUTES = Object.freeze([
    'data-v-inspector',
    'data-source',
    'data-source-file'
  ])

  /**
   * 第 3 档：约定属性。
   *
   * 只**读取**，不做任何推断——属性里写什么就是什么。这样项目可以主动接入，
   * 而插件不会瞎猜出一个可能是错的路径。
   *
   * @param {Element} el
   */
  function locateFromAttributes(el) {
    let node = el
    let depth = 0
    while (node && depth < MAX_FIBER_DEPTH) {
      for (const attribute of CONVENTION_ATTRIBUTES) {
        const value = node.getAttribute && node.getAttribute(attribute)
        if (typeof value === 'string' && value.length > 0) {
          const cleaned = cleanSourcePath(value)
          if (cleaned && !ns.containsSecret(cleaned)) {
            return { sourceFile: cleaned, components: [] }
          }
        }
      }
      node = node.parentElement
      depth++
    }
    return null
  }

  /**
   * 四档依次尝试，返回第一个有结果的。
   *
   * @param {Element} el
   * @returns {{ sourceFile: string|null, reactComponents: string|null, locatedBy: string|null }}
   */
  function locateSource(el) {
    /** @type {{ sourceFile: string|null, components: string[] }|null} */
    let found = null
    /** @type {string|null} */
    let locatedBy = null

    const tiers = [
      ['react-fiber', locateFromReact],
      ['vue-sfc', locateFromVue],
      ['convention-attribute', locateFromAttributes]
    ]

    for (const [name, locator] of tiers) {
      try {
        const result = locator(el)
        if (result && (result.sourceFile || (result.components && result.components.length > 0))) {
          found = result
          locatedBy = name
          break
        }
      } catch (error) {
        // 某一档抛错只意味着这一档拿不到值，继续试下一档。
        continue
      }
    }

    if (!found) {
      return { sourceFile: null, reactComponents: null, locatedBy: null }
    }

    const components = found.components || []
    return {
      sourceFile: found.sourceFile
        ? ns.clampStr(found.sourceFile, ns.BUDGET.sourceFileMaxLength)
        : null,
      reactComponents:
        components.length > 0
          ? ns.clampStr(
              components
                .slice()
                .reverse()
                .map(function (componentName) {
                  return '<' + componentName + '>'
                })
                .join(' '),
              ns.BUDGET.reactComponentsMaxLength
            )
          : null,
      locatedBy
    }
  }

  ns.MAX_FIBER_DEPTH = MAX_FIBER_DEPTH
  ns.CONVENTION_ATTRIBUTES = CONVENTION_ATTRIBUTES
  ns.getFiberFromElement = getFiberFromElement
  ns.getComponentNameFromFiber = getComponentNameFromFiber
  ns.shouldSkipComponentName = shouldSkipComponentName
  ns.cleanSourcePath = cleanSourcePath
  ns.locateSource = locateSource
  ns.locateFromReact = locateFromReact
  ns.locateFromVue = locateFromVue
  ns.locateFromAttributes = locateFromAttributes
})(globalThis)
