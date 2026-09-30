// @ts-check
/**
 * Chrome 授权模型下的入口行为（回归测试）。
 *
 * ## 这个测试守的是什么
 *
 * 真机 bug：**在侧边面板里点「进入抓取模式」→ 17 个文件全部注入失败**
 * （`Cannot access contents of the page. Extension manifest must request permission
 * to access the respective host.`），而**同一个页面上按快捷键 `Ctrl+Shift+E` 却可以**。
 *
 * 机制全在 Chrome 的授权规则里：
 *
 * - `activeTab` 只在**用户调用扩展**时授予：点 action 图标、快捷键、右键菜单；
 * - 它只对**当时那个标签页**有效；
 * - **标签页导航就撤销它**；
 * - 在侧边面板里点一个按钮**不是**上述任何一种调用 → 不授予。
 *
 * 侧边面板是常驻的，所以"点图标 → 页面导航 → 回面板点按钮"这条最常见的路径上
 * 根本没有授权；而快捷键每次按都是一次新调用，所以一直能用。
 *
 * ## 为什么必须用这样一个 harness
 *
 * 本环境的 Chrome 不接受 `--load-extension`（试过 7 种启动组合），无法加载扩展。
 * 但这个 bug 的机制**完全在授权模型里**，而那个模型可以用几十行忠实模拟。
 * 于是这里加载**真实的 `service-worker.js`**，只把 `chrome.*` 换成那个模型 ——
 * 测的是"我们的代码在真实授权语义下会怎样"，不是一个仿写品。
 *
 * ## harness 的边界（写清楚以免误信）
 *
 * - 它**不执行**注入的 `func`：真实 Chrome 会把函数送进页面的隔离世界，
 *   而这里没有那个世界。所以它判定**授权**相关的问题，不判定注入后页面里的行为。
 * - 页面里的内容脚本行为由 `verify-injection-path.mjs` 与真机验证覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')
const MANIFEST = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Chrome 授权模型
// ---------------------------------------------------------------------------

function createChromeStub(options) {
  let currentOrigin = options.origin
  /** activeTab 的授予状态：null 表示没授予。 */
  let activeTabGrant = null
  /** 通过 optional_host_permissions 拿到的长期授权（存的是**模式**）。 */
  const hostGrants = new Set()
  const log = []

  const tab = {
    id: 1,
    windowId: 1,
    get url() {
      return currentOrigin
    }
  }

  function originOf(url) {
    try {
      const parsed = new URL(url)
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return url
    }
  }

  // host 权限模式 → URL 的匹配。真实 Chrome 按模式匹配，不是字符串相等
  // （写这段时踩过：stub 用精确比对，于是"授权成功但后续仍被拒"，
  //  那是 harness 的建模错误，会让人误以为修复无效）。
  function patternMatchesOrigin(pattern, origin) {
    if (typeof pattern !== 'string' || typeof origin !== 'string') {
      return false
    }
    const m = /^(\*|https?):\/\/([^/]+)(\/.*)?$/.exec(pattern)
    if (!m) {
      return false
    }
    const [, scheme, host, path] = m
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    if (scheme !== '*' && scheme !== parsed.protocol.replace(':', '')) {
      return false
    }
    if (host === '*' || host === parsed.host) {
      return !path || path === '/*' || parsed.pathname.startsWith(path.replace(/\*$/, ''))
    }
    return false
  }

  function canAccessTab() {
    if (
      activeTabGrant &&
      activeTabGrant.tabId === tab.id &&
      activeTabGrant.origin === currentOrigin
    ) {
      return true
    }
    for (const pattern of hostGrants) {
      if (patternMatchesOrigin(pattern, currentOrigin)) {
        return true
      }
    }
    return false
  }

  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (p) => `chrome-extension://test/${p}`,
      id: 'test'
    },
    action: {
      onClicked: { addListener: () => {} },
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {}
    },
    commands: { onCommand: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    permissions: {
      // worker 启动时用它判断"常驻热键脚本能不能注册"（注册需要 host 授权）。
      // 与 `request` 共用同一份授权状态，不能各写一套 —— 那样会出现
      // "request 说授予了、contains 说没有"的自相矛盾。
      contains: async (request) => {
        const origins = (request && request.origins) || []
        return origins.every((origin) => hostGrants.has(origin) || [...hostGrants].some(
          (granted) => granted === '<all_urls>' || granted === origin
        ))
      },
      onAdded: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      request: async (request) => {
        const origins = (request && request.origins) || []
        const declared = chrome.__declaredOptionalOrigins || []
        // 请求的 origin 必须落在声明范围内。`<all_urls>` 声明覆盖所有 http/https
        // 请求（也覆盖请求 `<all_urls>` 本身）—— 这是 Chrome 的真实规则。
        const covers = (declaredOrigin, requested) => {
          if (declaredOrigin === requested) {
            return true
          }
          if (declaredOrigin !== '<all_urls>') {
            return false
          }
          return /^(https?|file|ftp):/.test(requested) || requested === '<all_urls>' || requested === '*://*/*'
        }
        const acceptable = origins.every((o) => declared.some((d) => covers(d, o)))
        if (!acceptable) {
          log.push('permissions.request DENIED (not declared optional)')
          return false
        }
        for (const origin of origins) {
          hostGrants.add(origin)
        }
        log.push('permissions.request GRANTED')
        return true
      },
      contains: async (request) => {
        const origins = (request && request.origins) || []
        return origins.every((o) => hostGrants.has(o))
      }
    },
    tabs: {
      query: async () => [tab],
      // worker 现在会往标签页推快捷键（常驻热键脚本监听它）。
      // 绝大多数页面没有接收方，真实 Chrome 会拒绝 —— 这里如实模拟，
      // 因为"推送失败被吞掉"正是要验证的行为之一。
      sendMessage: async () => {
        throw new Error('Could not establish connection.')
      }
    },
    scripting: {
      // 常驻热键脚本的注册状态。worker 启动时会查一次；这里报告"没注册"，
      // 于是它会尝试注册 —— 而在未授权时不该真的注册（由 `permissions.contains`
      // 返回 false 决定）。
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async (scripts) => {
        registeredScripts.push(scripts)
        log.push('registerContentScripts')
        return undefined
      },
      unregisterContentScripts: async () => {
        log.push('unregisterContentScripts')
        return undefined
      },
      // 授权不足时按 Chrome 的真实文案抛错 —— 这正是用户看到的报错。
      executeScript: async (injection) => {
        if (!canAccessTab()) {
          throw new Error(
            'Cannot access contents of the page. Extension manifest must request ' +
              'permission to access the respective host.'
          )
        }
        log.push('executeScript ok')
        const source = injection && typeof injection.func === 'function' ? String(injection.func) : ''
        if (source.includes('keyCount')) {
          return [{ result: { keyCount: 77, hasArmPicker: true } }]
        }
        return [{ result: undefined }]
      }
    },
    storage: {
      local: {
        __data: new Map(),
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys]
          const out = {}
          for (const k of list) {
            if (this.__data.has(k)) {
              out[k] = this.__data.get(k)
            }
          }
          return out
        },
        async set(values) {
          for (const [k, v] of Object.entries(values)) {
            this.__data.set(k, v)
          }
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            this.__data.delete(k)
          }
        }
      }
    }
    // 这里原本还有 `downloads` 桩。「下载 .md」按钮删除后落文件路径整个去掉，
    // 桩也一起去掉 —— 留着它会让"权限清单与实现一致"这件事失去检查意义。
  }

  return {
    chrome,
    log,
    /** 只有这几种调用会授予 activeTab —— Chrome 的真实规则。 */
    grantActiveTab(reason) {
      activeTabGrant = { tabId: tab.id, origin: currentOrigin }
      log.push(`grant activeTab (${reason})`)
    },
    /** 导航会撤销 activeTab。 */
    navigateTo(url) {
      currentOrigin = originOf(url)
      activeTabGrant = null
      log.push(`navigate -> ${currentOrigin}`)
    },
    canAccessTab,
    hostGrants: () => Array.from(hostGrants)
  }
}

/** 加载真实的 service worker，只替换 `chrome.*`。 */
function bootWorker() {
  const env = createChromeStub({ origin: 'https://example.com' })
  let messageHandler = null
  env.chrome.runtime.onMessage.addListener = (fn) => {
    messageHandler = fn
  }
  env.chrome.__declaredOptionalOrigins = MANIFEST.optional_host_permissions || []

  const sandbox = {
    chrome: env.chrome,
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    btoa,
    crypto
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  const importScripts = (...specs) => {
    for (const spec of specs) {
      const rel = spec.startsWith('../') ? 'src/' + spec.slice(3) : 'src/background/' + spec.slice(2)
      const source = readFileSync(join(extensionRoot, rel), 'utf8')
      new Function('chrome', 'globalThis', 'self', 'console', source).call(
        sandbox,
        env.chrome,
        sandbox,
        sandbox,
        console
      )
    }
  }

  const workerSource = readFileSync(join(extensionRoot, 'src/background/service-worker.js'), 'utf8')
  new Function('chrome', 'importScripts', 'globalThis', 'self', 'console', workerSource).call(
    sandbox,
    env.chrome,
    importScripts,
    sandbox,
    sandbox,
    console
  )

  assert.ok(messageHandler, 'worker 必须注册 onMessage 监听器')

  return {
    env,
    send: (message) =>
      new Promise((resolve) => {
        const returned = messageHandler(message, {}, resolve)
        if (returned !== true) {
          resolve(undefined)
        }
      })
  }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('bug 复现：点图标 → 页面导航 → 点面板按钮 → 注入失败', async () => {
  const { env, send } = bootWorker()
  env.grantActiveTab('action click')
  assert.equal(env.canAccessTab(), true, '点图标后应已授予 activeTab')

  // 登录、点链接、切走再回来都会导航 —— activeTab 在那一刻被撤销。
  env.navigateTo('https://example.com/other')
  assert.equal(env.canAccessTab(), false, '导航后 activeTab 应被撤销')

  const response = await send({ type: 'grab.manual.start' })
  assert.equal(response.ok, false, '没有授权时注入必须失败（这就是用户看到的报错）')
})

test('失败必须被识别成 needs_host_permission，而不是笼统的 inject_failed', async () => {
  const { env, send } = bootWorker()
  env.navigateTo('https://example.com/other')

  const response = await send({ type: 'grab.manual.start' })
  assert.equal(response.error.code, 'needs_host_permission')
  // 文案要说清真实原因，不能把人往"页面类型不对"上引。
  assert.match(response.error.message, /activeTab/)
  assert.match(response.error.message, /授权/)
})

test('权限申请必须发生在面板侧，worker 自己不能申请（手势不跨异步消息）', async () => {
  const { env, send } = bootWorker()
  env.navigateTo('https://example.com/other')
  await send({ type: 'grab.manual.start' })
  assert.deepEqual(
    env.hostGrants(),
    [],
    'worker 侧申请会丢掉用户手势，必然失败；申请只能由面板的点击 handler 发起'
  )
})

test('对照组：快捷键每次都是新的用户调用，所以一直可用', async () => {
  const { env } = bootWorker()
  env.navigateTo('https://example.com/other')
  assert.equal(env.canAccessTab(), false)
  env.grantActiveTab('command')
  assert.equal(env.canAccessTab(), true, '快捷键重新授予了 activeTab')
  assert.deepEqual(env.hostGrants(), [], '快捷键路径不需要长期授权')
})

test('修复后的完整流程：授权一次 → 重试成功', async () => {
  const { env, send } = bootWorker()
  env.navigateTo('https://example.com/other')

  const first = await send({ type: 'grab.manual.start' })
  assert.equal(first.error.code, 'needs_host_permission', '第一步应拿到可补救的错误码')

  const granted = await env.chrome.permissions.request({
    origins: ['http://*/*', 'https://*/*']
  })
  assert.equal(granted, true, 'manifest 声明了 optional_host_permissions，授权应成功')

  const second = await send({ type: 'grab.manual.start' })
  assert.equal(second.ok, true, '拿到长期授权后重试必须成功')
  assert.equal(env.hostGrants().length > 0, true)
})

test('授权一次之后换站点、换标签页都不再失败（常驻面板需要的行为）', async () => {
  const { env, send } = bootWorker()
  await env.chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })
  env.navigateTo('https://www.bilibili.com/video/x')

  assert.equal(env.canAccessTab(), true, 'hostGrants 按模式覆盖所有 http/https')
  const response = await send({ type: 'grab.manual.start' })
  assert.equal(response.ok, true)
})

test('用户拒绝授权时不产生假成功', async () => {
  const env = createChromeStub({ origin: 'https://example.com' })
  env.chrome.__declaredOptionalOrigins = [] // 模拟没声明的环境
  const granted = await env.chrome.permissions.request({ origins: ['https://*/*'] })
  assert.equal(granted, false, '未声明为 optional 时请求必须被拒')
  assert.deepEqual(env.hostGrants(), [], '被拒后不能留下任何授权')
})
