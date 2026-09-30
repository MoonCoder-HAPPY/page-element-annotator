/**
 * service worker **整份求值**测试。
 *
 * ## 它补的是哪一类漏网
 *
 * `node --check` 只验语法。像"函数声明被关在另一个函数体里，于是模块级的调用
 * 找不到它"这种问题，语法完全合法 —— 但 worker 一加载就抛
 * `ReferenceError: xxx is not defined`，整个扩展**完全不可用**。
 *
 * 这个坑真机上踩过两次：
 *   - `settingRange is not defined`（面板）
 *   - `syncHotkeyRegistration is not defined`（worker，直接导致 SW 注册失败）
 *
 * 两次都是 `node --check` 全绿、所有测试全绿，然后用户那边一片红。
 *
 * ## 手法
 *
 * 给 `importScripts` 与 `chrome` 打桩，然后用 `vm` **真的求值一遍**整份源码。
 * 加载期的作用域错误会当场抛出，并且带行号。
 *
 * 断言"求值成功"之外，还逐个检查关键函数是否真的挂在了全局 ——
 * 光求值成功不够：一个被关在别人函数体里的声明同样不会抛错，
 * 只要没人调用它。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 造一个够用的 chrome 桩。
 *
 * 只覆盖 service worker 在**加载期**会碰到的部分 —— 那是我们要验的阶段。
 * 缺一个 API 会让求值在这里失败，而那正是它的价值：说明我用了不存在的接口。
 */
function makeSandbox() {
  const noop = () => {}
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  const declared = new Set(manifest.permissions || [])

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    importScripts: noop,
    /*
     * `importScripts` 是空桩，所以**共享命名空间是空的**。
     *
     * 加载期求值用不到它（没人调用那些函数），但一旦某个用例真的走到落库那一步
     * （`grab.comment.submit`），`ns.normalizeComment` / `ns.appendRecord` 就是
     * undefined，报 `Cannot read properties of undefined` —— 那是**桩不够**，
     * 不是被测代码有问题。
     *
     * 补上这两个最小实现。它们不是"替代码通过"：被测的是"提交之后有没有通知
     * 页面解冻"，落库本身由别的用例覆盖。
     */
    __EG__: {
      normalizeComment: (value) =>
        typeof value === 'string' && value.trim() !== '' ? value.trim() : null,
      appendRecord: async () => ({ droppedCount: 0 }),
      /*
       * 提交时要**重新格式化**那段给剪贴板的文本（带上用户刚写的注释）。
       *
       * 桩里必须返回一个**带得走注释**的值，否则用例只能验"函数被调用过"，
       * 而验不到真正的 bug —— 曾经因为复用点击那一刻格式化好的文本，
       * 自动复制出来的内容缺了 "Requested change" 那一段。
       */
      formatGrabPayloadAsText: (payload, comment) => {
        void payload
        return comment ? `ctx\nRequested change: ${comment}` : 'ctx'
      }
    },
    fetch: () => Promise.reject(new Error('no network')),
    chrome: {
      runtime: {
        onMessage: { addListener: noop },
        onInstalled: { addListener: noop },
        onStartup: { addListener: noop },
        getURL: (p) => 'chrome-extension://test/' + p
      },
      permissions: {
        contains: async () => false,
        onAdded: { addListener: noop },
        onRemoved: { addListener: noop }
      },
      scripting: { executeScript: async () => [] },
      sidePanel: { setPanelBehavior: async () => {} },
      tabs: { query: async () => [], sendMessage: async () => {} },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        // `storage.session` 是"等用户写注释"那条路用的（MVP 的 worker 随时会被回收，
        // 模块变量靠不住）。桩里必须有它，否则那条路在测试里会静默降级成
        // "读不到暂存" —— 而真实环境里它是能用的，测试就替代码掩盖了问题。
        session: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {}
        }
      },
      windows: {
        /*
         * ⚠️ `onRemoved` 必须有：worker 在**顶层**注册它（用来捕捉
         * "用户直接点窗口的关闭按钮"）。桩缺了这个 API，worker 一加载就抛 ——
         * 而真实 Chrome 里它是存在的。
         */
        onRemoved: { addListener: noop },
        /*
         * 注释小窗口。
         *
         * ⚠️ **桩必须比代码严格，否则它就在替代码掩盖错误。**
         *
         * 真机反馈（这次的教训）：
         *   `Error at parameter 'createData': Unexpected property: 'resizable'.`
         *
         * `chrome.windows.create` 根本不接受 `resizable` —— 我凭空写了一个，
         * 而当时的桩照单全收、测试全绿，抓取在真机上当场失败。
         * 这和 `chrome.commands` 那次是同一类问题：**桩比真实环境宽容**。
         *
         * 所以这里照着官方文档的白名单**逐项校验**，多一个属性就抛 ——
         * 抛出的措辞也模仿 Chrome，排查时一眼能认出来。
         */
        create: async (createData) => {
          const allowed = [
            'url',
            'tabId',
            'left',
            'top',
            'width',
            'height',
            'focused',
            'incognito',
            'type',
            'state',
            'setSelfAsOpener'
          ]
          for (const key of Object.keys(createData || {})) {
            if (!allowed.includes(key)) {
              throw new Error(
                `Error at parameter 'createData': Unexpected property: '${key}'.`
              )
            }
          }
          return { id: 1 }
        },
        update: async (windowId, updateInfo) => {
          const allowed = [
            'left',
            'top',
            'width',
            'height',
            'focused',
            'drawAttention',
            'state',
            'resizable'
          ]
          for (const key of Object.keys(updateInfo || {})) {
            if (!allowed.includes(key)) {
              throw new Error(
                `Error at parameter 'updateInfo': Unexpected property: '${key}'.`
              )
            }
          }
          return { id: windowId }
        },
        remove: async () => {}
      },
      action: {
        onClicked: { addListener: noop },
        setBadgeText: async () => {},
        setTitle: async () => {}
      }
    }
  }

  // `chrome.commands` **只在 manifest 声明了 `commands` 时才存在**。
  //
  // ⚠️ 这一条是血的教训：原来的桩无条件提供 `chrome.commands`，而 manifest 里
  // 的 `commands` 段被删掉之后，真实环境里这个 API 就是 `undefined` ——
  // worker 顶层那行 `chrome.commands.onCommand.addListener(...)` 直接抛
  // TypeError，**整个 service worker 注册失败**（status 15，扩展完全不可用）。
  //
  // 而测试全绿，因为桩比真实环境宽容。桩必须**照着 manifest 生成**，
  // 否则它就在替被测代码掩盖"用了 manifest 没声明的 API"这类错误。
  if (manifest.commands) {
    sandbox.chrome.commands = { getAll: async () => [], onCommand: { addListener: noop } }
  }

  // `downloads` 同理 —— 权限没声明就不该有那个 API。
  if (declared.has('downloads')) {
    sandbox.chrome.downloads = { download: async () => 1 }
  }

  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  return sandbox
}

test('service worker 能在加载期完整求值（不抛作用域错误）', () => {
  const source = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')
  const sandbox = makeSandbox()
  vm.createContext(sandbox)

  // 求值失败会带上行号 —— 那正是排查时最需要的东西。
  assert.doesNotThrow(() => {
    new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox)
  }, 'service worker 在加载期抛错了；Chrome 里表现为「Service worker registration failed」')

  // 只验"没抛错"不够：被关在别人函数体里的声明同样不会抛错，
  // 只要没人调用它。所以逐个确认关键函数真的挂在了全局。
  for (const name of [
    'handleMessage',
    'enterGrabMode',
    'exportRecords',
    'configureSidePanel',
    'injectContentScripts',
    'runDiagnostics'
  ]) {
    assert.equal(
      typeof sandbox[name],
      'function',
      `${name} 没有挂在全局作用域上 —— 它很可能被声明在了另一个函数体内部`
    )
  }
})

test('面板脚本能在加载期完整求值（真机踩过 settingRange 那次）', () => {
  // 面板的加载期错误表现为"整个面板白屏/按钮全没反应"，
  // 而语法检查照样是绿的。这里用同样的手法验一遍。
  const source = readFileSync(join(root, 'src/sidepanel/index.js'), 'utf8')

  // 面板脚本依赖 DOM，这里只验**解析后能被求值的形状**：
  // 用一个最小的 document/window 桩，让它跑到"找不到元素"为止 ——
  // 那说明它至少没有作用域层面的加载期错误。
  const noop = () => {}
  const element = () => ({
    addEventListener: noop,
    setAttribute: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    style: {},
    dataset: {},
    textContent: '',
    hidden: false
  })
  // `__EG__` 的桩：**可调用，且任何属性访问都返回它自己**。
  //
  // 面板会做 `ns.theme.subscribe(...)`、`ns.chordFromEvent(...)` 这类链式访问；
  // 如果桩只在顶层返回函数，取到 `ns.theme.subscribe` 就是 undefined，
  // 于是测试报的是"桩不够像"，而不是被测代码有问题（第一版就是这样失败的）。
  const anyCallable = new Proxy(function () {}, {
    get: () => anyCallable,
    apply: () => undefined
  })
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: noop,
    document: {
      getElementById: element,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: element,
      addEventListener: noop,
      body: { clientWidth: 320 },
      documentElement: { style: {}, dataset: {} },
      scrollingElement: {}
    },
    window: { addEventListener: noop, dispatchEvent: noop },
    navigator: {},
    chrome: {
      runtime: { onMessage: { addListener: noop }, sendMessage: async () => ({}) },
      permissions: { request: async () => true },
      storage: { onChanged: { addListener: noop } }
    },
    __EG__: new Proxy({}, { get: () => anyCallable })
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)

  let failure = null
  try {
    new vm.Script(source, { filename: 'sidepanel/index.js' }).runInContext(sandbox)
  } catch (error) {
    failure = error
  }

  assert.equal(
    failure,
    null,
    failure ? `面板脚本加载期抛错：${failure.message}` : ''
  )
})

test('注释窗口开着时，grab.state 问的是**发起抓取的那个标签页**', async () => {
  // 真机反馈："只要弹窗打开了 按钮就会由 取消注释 变成 元素注释，
  // 但我此时依然可以使用元素框选。"
  //
  // 原因：注释窗口一聚焦，`{ active: true, currentWindow: true }` 解析到的就是
  // **注释窗口自己那个标签页**（我们的扩展页），去问它有没有 armed 当然是 false。
  // 状态没错，是**问错了标签页**。
  //
  // 判据：`executeScript` 的 `target.tabId` 必须是暂存里记下的那个，
  // 而不是"此刻聚焦的那个"。
  const source = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox)

  const ANNOTATING_TAB = 42
  const ANNOTATION_WINDOW_TAB = 999

  sandbox.chrome.storage.session.get = async (keys) => {
    if (Array.isArray(keys) && keys.includes('pendingAnnotation')) {
      return { pendingAnnotation: { record: { payload: {} }, text: 'x', tabId: ANNOTATING_TAB } }
    }
    return {}
  }
  // 此刻"聚焦"的标签页是注释窗口自己。
  sandbox.chrome.tabs.query = async () => [{ id: ANNOTATION_WINDOW_TAB }]
  const probed = []
  sandbox.chrome.scripting.executeScript = async (options) => {
    probed.push(options.target.tabId)
    return [{ result: { armed: true, mode: 'click' } }]
  }

  const response = await sandbox.handleMessage({ type: 'grab.state' }, {})

  assert.deepEqual(
    probed,
    [ANNOTATING_TAB],
    `应当去问发起抓取的那个标签页（${ANNOTATING_TAB}），实际问了 ${JSON.stringify(probed)}`
  )
  assert.equal(response.ok, true)
  assert.equal(response.result.armed, true, '拾取器其实还 armed 着，面板不该复位按钮')
  assert.equal(response.result.mode, 'click', '模式要一起带回去，否则按钮会亮错那一个')
})

test('没有未完成注释时，grab.state 仍然问当前聚焦的标签页', async () => {
  // 反向：上面那条改动不能把普通情况也带偏。
  const source = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox)

  sandbox.chrome.storage.session.get = async () => ({})
  sandbox.chrome.tabs.query = async () => [{ id: 7 }]
  const probed = []
  sandbox.chrome.scripting.executeScript = async (options) => {
    probed.push(options.target.tabId)
    return [{ result: { armed: false, mode: null } }]
  }

  await sandbox.handleMessage({ type: 'grab.state' }, {})
  assert.deepEqual(probed, [7], '没有暂存时应当照旧问当前标签页')
})

test('注释结束（提交/取消）都要通知页面解冻高亮', async () => {
  // 用户要求："用户注释以后 框选的区域必须要常驻显示，
  // 直到用户取消/添加完成此次注释的添加。"
  //
  // "常驻"的另一半是"该消失时消失"：漏掉任何一种结束方式，都会留下一个
  // **僵尸高亮框** —— 鼠标怎么动都不动，看起来像扩展卡死。
  //
  // 输入框搬到侧边面板之后，"用户叉掉独立窗口"那条路没有了（面板没有这个概念），
  // 剩下提交与取消两条，都必须通知页面。
  const source = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')

  const makeSandboxWithPending = () => {
    const sandbox = makeSandbox()
    vm.createContext(sandbox)
    new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox)
    sandbox.chrome.storage.session.get = async (keys) =>
      Array.isArray(keys) && keys.includes('pendingAnnotation')
        ? { pendingAnnotation: { record: { payload: {} }, text: 'x', tabId: 42 } }
        : {}
    const sent = []
    sandbox.chrome.tabs.sendMessage = async (tabId, message) => {
      sent.push({ tabId, type: message && message.type })
    }
    return { sandbox, sent }
  }

  // ① 取消
  {
    const { sandbox, sent } = makeSandboxWithPending()
    await sandbox.handleMessage({ type: 'grab.comment.cancel' }, {})
    assert.ok(
      sent.some((m) => m.type === 'grab.annotation.end' && m.tabId === 42),
      `取消之后必须通知发起抓取的标签页解冻，实际发了：${JSON.stringify(sent)}`
    )
  }

  // ② 提交
  {
    const { sandbox, sent } = makeSandboxWithPending()
    const result = await sandbox.handleMessage({ type: 'grab.comment.submit', comment: 'hi' }, {})
    assert.equal(result.ok, true, `提交应当成功：${JSON.stringify(result)}`)
    assert.ok(
      sent.some((m) => m.type === 'grab.annotation.end' && m.tabId === 42),
      `提交之后也必须解冻，实际发了：${JSON.stringify(sent)}`
    )
  }
})

test('退出注释模式（grab.cancel）要连待写的那笔注释一起收掉', async () => {
  // 真机反馈："取消注释 以后原来的框选仍然存在 不应该关闭掉吗？"
  //
  // 用户点「取消注释」= "这件事我不做了"。只把拾取器关掉、把暂存留着，
  // 会留下一个半死不活的状态：面板里的输入卡片还挂着、页面上那个高亮框
  // 还冻结在旧元素上、`grab.state` 还会优先去问那个已经作废的标签页。
  const source = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox)

  sandbox.chrome.storage.session.get = async (keys) =>
    Array.isArray(keys) && keys.includes('pendingAnnotation')
      ? { pendingAnnotation: { record: { payload: {} }, text: 'x', tabId: 42 } }
      : {}
  const removed = []
  sandbox.chrome.storage.session.remove = async (key) => {
    removed.push(key)
  }
  const sent = []
  sandbox.chrome.tabs.sendMessage = async (tabId, message) => {
    sent.push({ tabId, type: message && message.type })
  }
  sandbox.chrome.tabs.query = async () => [{ id: 42 }]
  sandbox.chrome.scripting.executeScript = async () => [{ result: undefined }]

  const result = await sandbox.handleMessage({ type: 'grab.cancel' }, {})
  assert.equal(result.ok, true, `退出应当成功：${JSON.stringify(result)}`)

  assert.ok(
    removed.includes('pendingAnnotation'),
    `退出时必须清掉待写的注释，实际清了：${JSON.stringify(removed)}`
  )
  assert.ok(
    sent.some((m) => m.type === 'grab.annotation.end' && m.tabId === 42),
    `退出时必须通知页面解冻高亮（否则那个框会一直留着），实际发了：${JSON.stringify(sent)}`
  )
})

test('页面侧：解冻时必须显式清画面，退出时必须复位冻结状态', () => {
  // 两条都是真机反馈直接对应的缺陷。行为级断言需要 DOM，而端到端套件
  // （`verify-in-chrome.mjs`）此刻正在重写，所以这里先钉住语义。
  const source = readFileSync(join(root, 'src/content/picker.js'), 'utf8')

  /*
   * ① 只 `unfreeze` 是不够的。
   *
   * `unfreezeOverlayHighlight()` 只把 `frozenElement` 置空、**不重画** ——
   * 要等下一次 `pointermove`。而用户是在**面板里**点「取消」的，鼠标不在页面上，
   * 于是那个冻结的框**再也不会消失**。
   *
   * 判据：解冻之后必须紧跟一次 `updateOverlayHighlight(null)`。
   */
  const releaseStart = source.indexOf('function releaseAnnotationHighlight()')
  assert.ok(releaseStart !== -1, '找不到 releaseAnnotationHighlight')
  const releaseBody = source.slice(releaseStart, source.indexOf('chrome.runtime.onMessage', releaseStart))
  assert.ok(
    releaseBody.includes('ns.unfreezeOverlayHighlight()'),
    '解冻那一步不能少'
  )
  assert.match(
    releaseBody,
    /ns\.updateOverlayHighlight\(null\)/,
    '解冻之后必须显式清画面（updateOverlayHighlight(null)）—— ' +
      '否则鼠标不在页面上时那个框会一直留着'
  )

  /*
   * ② `teardown()` 必须复位 `annotationInProgress`。
   *
   * 否则"点了元素 → 退出 → 再进入"之后，`onPointerMove` 会因为该标志仍为 true
   * 而永不更新高亮 —— 页面上看着像死了，而且不会自愈
   * （那条复位通知只在提交/取消时发，错过的那次补不回来）。
   */
  const teardownStart = source.indexOf('function teardown()')
  assert.ok(teardownStart !== -1, '找不到 teardown')
  const teardownBody = source.slice(teardownStart, source.indexOf('function arm(', teardownStart))
  assert.match(
    teardownBody,
    /annotationInProgress = false/,
    'teardown() 必须复位 annotationInProgress，否则重新进入后高亮永不更新'
  )
})

test('注释卡片上的元素标识取自 payload.target（读错层级只会静默走兜底）', async () => {
  // 真机反馈："为什么这里显示 【（未命名元素）】呢？"
  //
  // 我第一版读的是 `payload.elementPath` —— 那个字段**根本不存在**。
  // `extract.js` 把它放在 `payload.target.elementPath`（和 selector / fullPath 一起）。
  // 读错层级**不会报错**，只会永远走兜底文案，所以界面一直显示「（未命名元素）」。
  //
  // 这条走真实调用路径：把一份**形状和 extract.js 一致**的 payload 交给
  // `grab.extract.request`，检查最终存进暂存的 label。
  const source = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox)

  // 补上这条路径会用到的最小命名空间（`importScripts` 是空桩）。
  Object.assign(sandbox.__EG__, {
    sanitizePayload: (raw) => ({ ok: true, payload: raw }),
    createRecord: (payload) => ({ id: 'r1', payload: payload }),
    createThumbnail: async () => 'thumb',
    describeScreenshotOmission: () => '',
    recordShotDiagnostic: () => {},
    inspectDataUrl: () => ({ startsWithPng: false }),
    // 这条路径会先把 payload 格式化成给剪贴板的文本；内容与本用例无关。
    formatGrabPayloadAsText: () => 'formatted'
  })

  let stored = null
  sandbox.chrome.storage.session.set = async (entries) => {
    stored = entries.pendingAnnotation || null
  }
  sandbox.chrome.runtime.sendMessage = async () => undefined

  const rawPayload = {
    page: { url: 'https://example.com/', title: 'x' },
    target: {
      tagName: 'div',
      selector: 'div.cm-content',
      elementPath:
        '.ant-layout-content > .h-full > .flex > .flex > .flex > div.cm-line > div.cm-content',
      fullPath: 'html > body > div > div.cm-content'
    },
    screenshot: null
  }

  const result = await sandbox.handleMessage(
    { type: 'grab.extract.request', rawPayload: rawPayload, awaitComment: true },
    { tab: { id: 42 } }
  )
  assert.equal(result.ok, true, `抽取应当成功：${JSON.stringify(result)}`)
  assert.ok(stored, '应当把待写的注释存下来')

  // 取可读路径的**最后一截** —— 太长会把面板那一行撑满，而用户只需要认出是不是自己点的。
  assert.equal(
    stored.label,
    'div.cm-content',
    `卡片标识应当来自 payload.target.elementPath 的末段，实际：${JSON.stringify(stored.label)}`
  )
})

test('元素标识：三层字段都拿不到时才兜底', () => {
  const source = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox)

  const describe = sandbox.describePendingTarget
  assert.equal(typeof describe, 'function', 'describePendingTarget 必须挂在全局')

  // 只有选择器时退到选择器
  assert.equal(describe({ target: { selector: 'button.primary' } }), 'button.primary')
  // 路径优先于选择器
  assert.equal(
    describe({ target: { elementPath: 'a > b > span.x', selector: 'span.x' } }),
    'span.x'
  )
  // 什么都没有 → 兜底
  assert.equal(describe({}), '（未命名元素）')
  assert.equal(describe(null), '（未命名元素）')

  // ⚠️ 反向钉子：不能再把字段读回 `payload.elementPath` 那一层。
  // 那个位置**没有**这个字段，读它只会静默走兜底 —— 正是真机上那个 bug。
  assert.equal(
    describe({ elementPath: 'a > b' }),
    '（未命名元素）',
    '元素路径在 payload.target 里面；读 payload.elementPath 是错的层级'
  )
})

test('自动复制的内容**必须带上刚写的注释**（两条路产出同一段文本）', async () => {
  // 真机反馈："系统注释完以后 你自动复制到剪切板的内容没有【Requested change:】内容，
  // 但是我点击复制全部、复制文本都有这个内容。"
  //
  // 根因：自动复制用的是**点击那一刻**格式化好的文本（存在暂存里的 `pending.text`），
  // 而那时注释还没写 —— 所以它天然缺了 "Requested change" 那一段。
  // 用户后来写的注释只进了记录，**没有回到那段要复制的文本里**。
  //
  // 而「复制全部 / 复制文本」走的是"从已落库记录重新格式化"，反而是对的 ——
  // 于是同一个东西两条路内容不一样。
  //
  // 这条钉住的是**提交之后**那段文本：它必须重新格式化、带上注释。
  const source = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')
  const sandbox = makeSandbox()
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'service-worker.js' }).runInContext(sandbox)

  // 暂存里放一份"点击那一刻"的记录：payload 已抽好，但**注释还是空的**。
  sandbox.chrome.storage.session.get = async (keys) =>
    Array.isArray(keys) && keys.includes('pendingAnnotation')
      ? {
          pendingAnnotation: {
            record: { payload: { target: { selector: 'div.x' } } },
            tabId: 42
          }
        }
      : {}

  const result = await sandbox.handleMessage(
    { type: 'grab.comment.submit', comment: '改成主色' },
    {}
  )

  assert.equal(result.ok, true, `提交应当成功：${JSON.stringify(result)}`)
  assert.equal(
    result.result.textForClipboard,
    'ctx\nRequested change: 改成主色',
    '自动复制的那段文本必须**重新格式化**（带上用户刚写的注释），' +
      '不能复用点击那一刻格式化好的旧文本 —— 那样会缺掉 "Requested change" 一整段'
  )
})

test('清空会把**截图一起删掉**（它存在记录里，不是另存一份）', async () => {
  // 用户问："当我点了清空的时候 所选注释对应的图片以及文本内容是否会被删除呢？
  // 我觉得要被删掉。这样符合清空的语义。"
  //
  // 答案是**会**，但这件事值得有一条断言钉住 —— 因为"截图存在哪"是个实现细节：
  // 只要有人哪天把截图挪去**另一个 storage key**（比如为了列表加载更快），
  // 清空就会开始留下孤儿数据，而且**不会有任何报错**，只是存储悄悄涨上去。
  //
  // 这条断言验的是那种情况：清空之后，记录与它带着的截图**一起没了**。
  const source = readFileSync(join(root, 'src/background/history-store.js'), 'utf8')

  /** 一个最小的内存版 chrome.storage.local。 */
  const memory = {}
  const sandbox = {
    console,
    TextEncoder,
    __EG__: {
      // `writeHistory` 会按当前设置裁剪，所以这两个要存在。
      pruneRecords: (records) => ({ kept: records, droppedCount: 0, droppedBytes: 0 }),
      clampStr: (value) => String(value == null ? '' : value),
      normalizeComment: (value) =>
        typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    },
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const out = {}
            for (const key of keys) {
              if (Object.prototype.hasOwnProperty.call(memory, key)) {
                out[key] = memory[key]
              }
            }
            return out
          },
          set: async (entries) => {
            Object.assign(memory, entries)
          }
        }
      }
    }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'history-store.js' }).runInContext(sandbox)

  const BIG_SCREENSHOT = 'data:image/png;base64,' + 'A'.repeat(20000)
  const record = {
    id: 'r1',
    createdAt: Date.now(),
    payload: {
      target: { selector: 'div.x' },
      screenshot: { mimeType: 'image/png', dataUrl: BIG_SCREENSHOT }
    },
    comment: '改成主色'
  }

  await sandbox.__EG__.appendRecord(record)

  // 前置：确实存进去了，而且截图就在记录里。
  assert.equal(memory.records.length, 1, '前置：记录应当已落库')
  assert.equal(
    memory.records[0].payload.screenshot.dataUrl,
    BIG_SCREENSHOT,
    '前置：截图应当随记录一起存在同一个数组里'
  )

  await sandbox.__EG__.clearHistory()

  /*
   * ⚠️ 用 `Array.from` 转一手再比。
   *
   * `memory.records` 是**在 vm 上下文里**创建的数组，它的原型是那个 realm 的
   * `Array.prototype`；而测试运行在另一个 realm。`assert.deepStrictEqual`
   * 会连原型一起比，于是 `[]` 与 `[]` 被判为**不相等** ——
   * 报错长成 `actual: [], expected: []`，看起来像断言坏了，其实是跨 realm。
   */
  assert.deepEqual(Array.from(memory.records), [], '清空之后记录数组必须是空的')
  // 这一条才是真正的判据：**整块存储里再也找不到那段图片数据**。
  // 只看 records 为空是不够的 —— 截图若存在别处，它就还在。
  const everything = JSON.stringify(memory)
  assert.ok(
    !everything.includes('AAAA'),
    '清空之后存储里仍有截图数据 —— 说明它没有随记录一起被删掉'
  )
})

test('删除所选也只删这些（同一条通路）', async () => {
  const source = readFileSync(join(root, 'src/background/history-store.js'), 'utf8')
  const memory = {}
  const sandbox = {
    console,
    TextEncoder,
    __EG__: {
      pruneRecords: (records) => ({ kept: records, droppedCount: 0, droppedBytes: 0 }),
      clampStr: (value) => String(value == null ? '' : value),
      normalizeComment: (value) => (value ? String(value) : null)
    },
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const out = {}
            for (const key of keys) {
              if (Object.prototype.hasOwnProperty.call(memory, key)) out[key] = memory[key]
            }
            return out
          },
          set: async (entries) => {
            Object.assign(memory, entries)
          }
        }
      }
    }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'history-store.js' }).runInContext(sandbox)

  const makeShot = (letter) => 'data:image/png;base64,' + letter.repeat(100)
  for (const id of ['a', 'b', 'c']) {
    await sandbox.__EG__.appendRecord({
      id,
      createdAt: Date.now(),
      payload: { target: {}, screenshot: { mimeType: 'image/png', dataUrl: makeShot('A') } }
    })
  }
  assert.equal(memory.records.length, 3)

  await sandbox.__EG__.deleteRecords(['b'])
  // 同样要 `Array.from`：跨 realm 的数组用 deepStrictEqual 会比原型。
  const ids = Array.from(memory.records).map((r) => r.id)
  assert.deepEqual(ids.sort(), ['a', 'c'], '只应删掉指定的那条')
})

test('注释期间页面侧不跟随 hover（框常驻在选中的元素上）', () => {
  // 行为级断言需要 DOM，而端到端套件（`verify-in-chrome.mjs`）此刻正在重写。
  // 这里先钉住两条**语义**上的约束，等端到端补齐后由它做真正的行为验证。
  const source = readFileSync(join(root, 'src/content/picker.js'), 'utf8')

  assert.match(
    source,
    /let annotationInProgress = false/,
    '需要有"注释进行中"这个状态 —— 高亮冻结跨整个注释过程'
  )

  // `onPointerMove` 顶部必须有这个守卫：只冻结"不解冻"是不够的，
  // 鼠标一动框就会跳走，"我选的是这里"的参照当场消失。
  const moveBody = source.slice(source.indexOf('function onPointerMove(event)'))
  const guardIndex = moveBody.indexOf('if (annotationInProgress)')
  const firstHitTest = moveBody.indexOf('ns.hitTestForOverlay(')
  assert.ok(guardIndex !== -1, 'onPointerMove 里必须有 annotationInProgress 守卫')
  assert.ok(
    guardIndex < firstHitTest,
    '守卫必须在**取命中元素之前** —— 放在后面等于先算完再丢掉'
  )
})