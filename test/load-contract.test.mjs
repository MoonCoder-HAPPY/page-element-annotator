// @ts-check
/**
 * 经典脚本加载契约测试。
 *
 * ## 这个测试在防什么
 *
 * 本扩展是零构建、按 `files` 数组顺序注入经典脚本、通过 `globalThis.__EG__`
 * 命名空间互相访问（spec 决策 I-1）。这个结构有三个**在浏览器里才暴露**的失败模式：
 *
 * 1. 顺序错了 → 后加载的文件读不到前一个挂上去的函数，运行时才炸；
 * 2. 某个共享常量被改了数值 → 抽取端与校验端对"上限"的理解不一致；
 * 3. 中文文案的 UTF-8 字节被写坏 → 用户看到 U+FFFD。
 *
 * 这三条都能在 `node --test` 里静态捕获，不需要真浏览器。因此这里用**与
 * service worker 的 `importScripts` 完全相同的顺序**加载同一批文件。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')

/**
 * service worker 声明的加载顺序（不含只依赖 Chrome API 的 service-worker 自身）。
 * 与 `src/background/service-worker.js` 的 `importScripts` 必须一致。
 */
const LOAD_ORDER = [
  'src/shared/text-utils.js',
  'src/shared/surrogate-safe-string.js',
  'src/shared/budget.js',
  'src/shared/format.js',
  'src/shared/attribute-allowlist.js',
  'src/shared/secret-patterns.js',
  'src/background/sanitize.js'
]

function loadExtensionScriptsInOrder() {
  for (const relative of LOAD_ORDER) {
    const source = readFileSync(join(extensionRoot, relative), 'utf8')
    // 经典脚本的等价求值：和 <script> / executeScript({files}) 一样，
    // 顶层 this 在非严格模式下指向 globalThis。
    new Function(source).call(globalThis)
  }
  return globalThis.__EG__
}

test('按声明的顺序加载后，命名空间装配完整', () => {
  const ns = loadExtensionScriptsInOrder()

  const expectedFunctions = [
    'clampStr',
    'sliceAtCodeUnitLimit',
    'containsSecret',
    'sanitizeUrl',
    'isSafeAttributeName',
    'validateStructure',
    'sanitizePayload',
    'formatGrabPayloadAsText',
    'buildStyleLines'
  ]
  for (const name of expectedFunctions) {
    assert.equal(typeof ns[name], 'function', `缺少函数 ${name}`)
  }

  assert.equal(typeof ns.BUDGET, 'object')
  assert.equal(typeof ns.STYLE_PROPS, 'object')
  assert.ok(ns.SAFE_ATTRIBUTE_NAMES instanceof Set)
})

test('加载顺序不可交换：越过 budget 先加载 selector 会缺依赖', () => {
  // 用一个干净的沙箱证明依赖是真实的，而不是碰巧成立。
  const sandbox = new Function('return this')()
  const loadInto = (relative) => {
    const source = readFileSync(join(extensionRoot, relative), 'utf8')
    new Function(source).call(sandbox)
  }

  sandbox.__EG__ = {}
  loadInto('src/shared/text-utils.js')

  // text-utils 的 clampStr 依赖 surrogate-safe-string 与 budget 的常量。
  assert.equal(typeof sandbox.__EG__.clampStr, 'function')
  assert.throws(
    () => sandbox.__EG__.clampStr('x'.repeat(10), 5),
    /sliceAtCodeUnitLimit/,
    '故意缺依赖时必须显式报错，而不是静默返回错值'
  )
})

test('注释输入框的聚焦样式与详情里的 .comment-input 一致（不加 outline）', () => {
  // 用户要求："内层的蓝色边框太深了 你和详情里面的输入框样式保持一致就可以了呀。"
  //
  // 那条"太深的蓝边框"是我写的 `outline: 2px solid var(--blue)` —— 一圈 2px 的
  // 硬蓝环。而面板里**已经为这件事修过一次**：通用 `:focus-visible` 规则旁边
  // 记着用户的原话"聚焦以后出现很丑的蓝色边框"，根因是边框色 + 光晕 + outline
  // **叠了三层**。房规因此定死：**文本输入不需要可见焦点环**（用户看得见光标）。
  //
  // 断言写成"与 .comment-input 用同一套表达"，而不是"不许出现蓝色" ——
  // 前者才是那条房规的真正内容。
  const css = readFileSync(join(extensionRoot, 'src/sidepanel/index.css'), 'utf8')

  /** 取出某条规则的选择器块。 */
  const blockOf = (selector) => {
    const start = css.indexOf(selector + ' {')
    assert.ok(start !== -1, `找不到规则：${selector}`)
    const end = css.indexOf('}', start)
    return css.slice(start, end)
  }

  const commentFocus = blockOf('.comment-input:focus')
  const annotationFocus = blockOf('.annotation-input:focus')

  // 同一个表达：边框换主色 + 一层柔和光晕。
  for (const property of ['border-color: var(--blue)', 'box-shadow: 0 0 0 3px var(--fill-strong)']) {
    assert.ok(
      commentFocus.includes(property),
      `.comment-input:focus 里没有「${property}」—— 这条断言的前提变了，先核对房规`
    )
    assert.ok(
      annotationFocus.includes(property),
      `注释输入框的 :focus 缺少「${property}」—— 应当与详情里的输入框一致`
    )
  }

  // ⚠️ 不得再有 outline。这条是本用例的主要目的。
  assert.ok(
    !/outline:\s*(?!none)/.test(annotationFocus),
    '注释输入框的 :focus 里出现了 outline —— 那正是"很丑的蓝色边框"那次的原因'
  )
  assert.ok(
    !css.includes('.annotation-input:focus-visible'),
    '不得给注释输入框单独写 :focus-visible 焦点环 —— 文本输入不需要可见焦点环'
  )
  assert.ok(
    blockOf('.annotation-input').includes('outline: none'),
    '基础规则要把浏览器默认焦点环关掉，再由 :focus 表达聚焦'
  )

  // 外层的蓝边框也去掉（用户要求"和其它的保持一致就行"）。
  const composer = blockOf('.annotation-composer')
  assert.ok(
    !/border:\s*1px solid var\(--blue\)/.test(composer),
    '注释卡片不得单独描一圈蓝边 —— 面板里其它卡片都是"同底 + 同投影"'
  )
})


test('CSS 里每个 var() 都必须有定义（用了不存在的 token 是静默错误）', () => {
  const relative = 'src/sidepanel/index.css'
  const source = readFileSync(join(extensionRoot, relative), 'utf8')
  // 先抹掉注释：注释里提到 `var(--x)` 是在说明它，不是在用它。
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')

  const defined = new Set(Array.from(css.matchAll(/(--[a-z0-9-]+)\s*:/gi)).map((m) => m[1]))
  const used = Array.from(css.matchAll(/var\((--[a-z0-9-]+)/gi)).map((m) => m[1])

  assert.ok(defined.size > 8, `只解析到 ${defined.size} 个变量定义，可能正则不对`)
  assert.ok(used.length > 20, `只解析到 ${used.length} 处 var() 引用，可能正则不对`)

  for (const name of used) {
    assert.ok(
      defined.has(name),
      `用了未定义的 CSS 变量 ${name} —— 写不存在的 token 不会报错、不会警告，` +
        '只是那一条样式静默失效。真机上踩过两次：`.primary-note` 根本没写规则' +
        '导致按钮一直发灰、`var(--card)` 实际叫 `--bg-card`。'
    )
  }
})

test('预算数值与 spec §10.2 表格逐项一致', () => {
  const ns = loadExtensionScriptsInOrder()
  /** spec §10.2 —— 独立写死的期望值，不从实现里推导。 */
  const expected = {
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
    screenshotMaxBytes: 2 * 1024 * 1024
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(ns.BUDGET[key], value, `BUDGET.${key} 与 spec 不一致`)
  }
})

test('16 项计算样式与 spec §10.3 的顺序一致', () => {
  const ns = loadExtensionScriptsInOrder()
  assert.deepEqual(
    [...ns.STYLE_PROPS],
    [
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
    ]
  )
})

test('clampStr 截断时留后缀，且不切开代理对', () => {
  const ns = loadExtensionScriptsInOrder()

  assert.equal(ns.clampStr('abc', 5), 'abc')
  assert.equal(ns.clampStr('abcdefgh', 4), 'abcd (truncated)')

  // U+1F600 是一个星平面字符，占两个 UTF-16 码元。
  const withSurrogate = 'a😀b'
  assert.equal(withSurrogate.length, 4)
  const clamped = ns.clampStr(withSurrogate, 2)
  // 上限 2 落在 😀 的两半之间，必须退到 1 而不是留下悬空高代理项。
  assert.equal(clamped, 'a (truncated)')
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clamped), '不得留下孤立高代理项')
})

test('文本格式化器：Source 缺省时保留该行（spec I-3 决策）', () => {
  const ns = loadExtensionScriptsInOrder()
  const payload = {
    page: { sanitizedUrl: 'https://example.com/page' },
    target: {
      tagName: 'button',
      selector: 'button#submit',
      sourceFile: null,
      reactComponents: null,
      rectViewport: { x: 0, y: 0, width: 220.4, height: 48.6 },
      accessibility: { role: 'button', accessibleName: 'Submit order' },
      textSnippet: 'Submit order',
      htmlSnippet: '<button id="submit">Submit order</button>',
      computedStyles: { display: 'inline', position: 'static', backgroundColor: 'rgba(0, 0, 0, 0)' },
      fullPath: 'body > button#submit'
    },
    nearbyText: [],
    ancestorPath: []
  }

  const text = ns.formatGrabPayloadAsText(payload)

  assert.ok(text.startsWith('Attached browser context from https://example.com/page'))
  assert.ok(text.includes('Selected element:\nbutton'))
  assert.ok(text.includes('Selector: button#submit'))
  assert.ok(
    text.includes('Source: (not available on this page)'),
    'Source 缺省时必须保留该行并给出诚实缺省文案，而不是整行省略'
  )
  assert.ok(text.includes('Dimensions: 220x49'), 'Dimensions 必须四舍五入')
  assert.ok(!text.includes('React:'), 'React 无值时不输出该行（spec I-4）')
  assert.ok(!text.includes('Computed styles:'), '全部为默认值的样式段不输出')
  assert.ok(text.includes('HTML:\n<button id="submit">Submit order</button>'))
})

test('所有源文件是合法 UTF-8 且不含替换字符', () => {
  const files = [
    ...LOAD_ORDER,
    'src/content/text-normalizer.js',
    'src/content/selector.js',
    'src/content/extract.js',
    'src/content/capsule.js',
    'src/content/picker.js',
    'src/background/service-worker.js'
  ]
  for (const relative of files) {
    const text = readFileSync(join(extensionRoot, relative), 'utf8')
    assert.ok(!text.includes('\uFFFD'), `${relative} 含 U+FFFD，说明写入时编码被破坏`)
  }
})

test('manifest 是合法 JSON，且权限未超出 spec §9.4 的批准清单', () => {
  const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'))

  assert.equal(manifest.manifest_version, 3)

  // `downloads` 是导出落盘所需（用户要求「导出全部」＝直接把 .md 存到磁盘）。
  const approvedBySpec = new Set([
    'activeTab',
    'scripting',
    'storage',
    'sidePanel',
    'clipboardWrite',
    'downloads'
  ])
  for (const permission of manifest.permissions) {
    assert.ok(
      approvedBySpec.has(permission),
      `权限 ${permission} 不在 spec §9.4 批准清单内，触发暂停条件 P-3`
    )
  }

  // AC-18：这些权限一开始就不能出现。
  for (const forbidden of ['tabs', 'cookies', 'history', 'webNavigation']) {
    assert.ok(!manifest.permissions.includes(forbidden), `不得申请 ${forbidden}`)
  }
  assert.ok(
    !manifest.host_permissions || manifest.host_permissions.length === 0,
    '安装时不得索要全站权限'
  )
})

/**
 * 从源码里抽出所有"经命名空间读取的符号"。
 *
 * 匹配 `ns.NAME` / `scope.__EG__.NAME` / `__EG__.NAME` 这几种写法，
 * 排除掉赋值左侧（`scope.__EG__.NAME = ...`）与 `__EG__` 本身。
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function referencedNamespaceSymbols(source) {
  const found = new Set()
  const patterns = [
    /\bns\.([A-Za-z_$][\w$]*)/g,
    /\bscope\.__EG__\.([A-Za-z_$][\w$]*)/g,
    /\bglobalThis\.__EG__\.([A-Za-z_$][\w$]*)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      // 排除**赋值左侧**：`ns.FOO = ...` 是定义，不是引用。
      // 只看等号、不看 `==` / `===`。
      const rest = source.slice(match.index + match[0].length)
      if (/^\s*(=(?!=))/.test(rest)) {
        continue
      }
      found.add(match[1])
    }
  }
  found.delete('__EG__')
  return found
}

function readFile(relative) {
  return readFileSync(join(extensionRoot, relative), 'utf8')
}

/**
 * 内容脚本的加载顺序。
 *
 * 从 `service-worker.js` 的 `CONTENT_SCRIPTS` 读，而不是在测试里另抄一份 ——
 * 抄一份就会出现"测试与实现各自维护同一份清单"的老问题，而那份清单漏掉的项
 * 恰恰是最容易出事的地方（本项目已经有 4 处脚本清单的历史）。
 * @returns {string[]}
 */
function contentScriptOrder() {
  const source = readFile('src/background/service-worker.js')
  const match = source.match(/const CONTENT_SCRIPTS = \[([\s\S]*?)\]/)
  assert.ok(match, 'service-worker.js 里应当有 CONTENT_SCRIPTS 清单')
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/**
 * service worker 的加载顺序（`importScripts`，路径相对 `src/background/` 解析）。
 * @returns {string[]}
 */
function serviceWorkerOrder() {
  const source = readFile('src/background/service-worker.js')
  const match = source.match(/importScripts\(([\s\S]*?)\)/)
  assert.ok(match, 'service-worker.js 里应当有 importScripts 清单')
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) =>
    m[1].startsWith('../') ? 'src/' + m[1].slice(3) : 'src/background/' + m[1].slice(2)
  )
}

/**
 * 在给定的加载顺序下装配命名空间，然后核对**每个被引用的符号都存在**。
 *
 * ## 这条断言为什么必要
 *
 * 真机上截图一直失败，报的是 `payload_invalid`（"截图数据未通过校验"），
 * 而实际原因是：`PNG_DATA_URL_PREFIX` 定义在 `sanitize.js` 里，
 * 而那个文件**只在 service worker 加载**；内容脚本里的 `screenshot-crop.js`
 * 也在用它 —— 于是拼出来的 data URL 是 `"undefined" + base64`。
 *
 * 整条截图链路（取图 → 解码 → 裁剪）全是好的，只有前缀是错的，
 * 而错误信息把人引向"数据坏了"这个完全错误的方向。
 *
 * 这类缺陷的共性是**跨上下文引用了一个只在单侧存在的符号**，语法检查、
 * 单元测试、真机注入验证都抓不到它 —— 因为每个文件单独看都是对的。
 * 只有"按上下文的加载顺序装配一遍，再看引用能不能落实"才抓得到。
 *
 * @param {string[]} order
 * @returns {{ namespace: any, missing: Map<string, string[]> }}
 */
function auditContext(order) {
  const sandbox = { console, setTimeout, clearTimeout, TextEncoder, btoa, crypto }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  for (const relative of order) {
    const source = readFile(relative)
    new Function('globalThis', 'self', 'console', 'setTimeout', 'clearTimeout', source).call(
      sandbox,
      sandbox,
      sandbox,
      console,
      setTimeout,
      clearTimeout
    )
  }

  const namespace = sandbox.__EG__ || {}
  /** 符号 → 在哪些文件里被引用 */
  const missing = new Map()
  for (const relative of order) {
    for (const symbol of referencedNamespaceSymbols(readFile(relative))) {
      if (!(symbol in namespace)) {
        if (!missing.has(symbol)) {
          missing.set(symbol, [])
        }
        missing.get(symbol).push(relative)
      }
    }
  }
  return { namespace, missing }
}

test('内容脚本上下文：引用的每个命名空间符号都必须真的存在', () => {
  const order = contentScriptOrder()
  const { namespace, missing } = auditContext(order)
  assert.ok(Object.keys(namespace).length > 50, '命名空间应当装起来')
  assert.deepEqual(
    Array.from(missing.entries()).map(([symbol, files]) => `${symbol} ← ${files.join(', ')}`),
    [],
    '有符号在内容脚本上下文里不存在（跨上下文引用漏了）'
  )
})

test('service worker 上下文：引用的每个命名空间符号都必须真的存在', () => {
  const order = serviceWorkerOrder()
  const { namespace, missing } = auditContext(order)
  assert.ok(Object.keys(namespace).length > 50, '命名空间应当装起来')
  assert.deepEqual(
    Array.from(missing.entries()).map(([symbol, files]) => `${symbol} ← ${files.join(', ')}`),
    [],
    '有符号在 service worker 上下文里不存在'
  )
})

test('截图链路依赖的常量在**两个**上下文里都有（真机 bug 的回归）', () => {
  // PNG_DATA_URL_PREFIX 被两侧同时需要：service worker 用它校验，
  // 内容脚本用它拼 data URL。它一度只在 service worker 侧存在。
  for (const [label, order] of [
    ['内容脚本', contentScriptOrder()],
    ['service worker', serviceWorkerOrder()]
  ]) {
    const { namespace } = auditContext(order)
    assert.equal(
      typeof namespace.PNG_DATA_URL_PREFIX,
      'string',
      `${label}上下文缺少 PNG_DATA_URL_PREFIX —— 内容脚本拼出来的 data URL 会带 undefined 前缀`
    )
    assert.match(namespace.PNG_DATA_URL_PREFIX, /^data:image\/png;base64,$/)
  }
})

test('所有源文件都能被解析（含模板字符串里的语法错误）', () => {
  // 这条守卫是为一个我反复犯的错误加的：注释框与面板的 CSS 写在**模板字符串**里，
  // 而我多次在其中的注释里写了反引号 —— 反引号会直接截断模板字符串，
  // 整个文件变成语法错误。
  //
  // 语法错误本该在改完就发现；但如果只靠手敲 `node --check`，
  // 就会陷入"改完 → 手动检查 → 发现坏了 → 再改"的循环。
  // 放进套件里，一次就能看见，而且以后不会再犯到用户那里。
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(extensionRoot, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(relative)
      } else if (entry.name.endsWith('.js')) {
        files.push(relative)
      }
    }
  }
  walk('src')
  assert.ok(files.length > 10, `应当扫到足够多的源文件，实际 ${files.length}`)

  const failures = []
  for (const relative of files) {
    try {
      // 用 Function 构造器解析（与浏览器加载经典脚本同样的解析方式）。
      // 只**解析**、不执行 —— 执行需要 chrome.* 等运行环境。
      new Function(readFile(relative))
    } catch (error) {
      failures.push(`${relative}: ${error.message}`)
    }
  }
  assert.deepEqual(failures, [], '有源文件无法解析')
})

test('截图所需的 host 权限必须能被 `captureVisibleTab` 接受', () => {
  // 真机 bug 的回归：`optional_host_permissions` 里写 `http://*/*` + `https://*/*`
  // 只能覆盖 `scripting.executeScript` —— 注入能用、**截图被拒**，报错是
  // "Either the '<all_urls>' or 'activeTab' permission is required."
  //
  // 也就是说"授权一次就都好了"这个承诺，在只声明 http/https 时不成立：
  // 用户按提示授权了，注入确实好了，但截图仍然失败 —— 而且失败信息指向
  // 一个他刚刚才做过一遍的动作。
  //
  // `captureVisibleTab` 认的是 `<all_urls>`；所以这里把它钉死。
  const manifest = JSON.parse(readFile('manifest.json'))
  const optional = manifest.optional_host_permissions || []
  assert.ok(
    optional.includes('<all_urls>'),
    `optional_host_permissions 必须包含 <all_urls>，实际是 ${JSON.stringify(optional)}`
  )
})

