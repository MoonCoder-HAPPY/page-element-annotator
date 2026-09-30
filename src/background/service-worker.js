// @ts-check
/**
 * service worker：消息路由、按需注入、诊断。
 *
 * MV3 的 service worker 会被回收，所以这里**不保存任何需要跨事件存活的内存状态**；
 * 每一次消息都自带它需要的一切。（具体后果见 spec §15 R-8。）
 *
 * 用 `importScripts` 而不是 ES module 导入：本扩展是零构建，而经典 service worker
 * 与 `chrome.scripting` 注入都不解析 `import` 语法（见实现报告决策 I-1）。
 *
 * **剪贴板不在这里写。** MV3 worker 不是文档，`navigator.clipboard` 在它是 undefined
 * （真机报错：`Cannot read properties of undefined (reading 'writeText')`）。
 * 文本与图片的剪贴板写入都在**带文档的上下文**里做：
 * 抓取路径在内容脚本（`src/content/clipboard.js`），
 * 历史路径在侧边面板（`src/sidepanel/index.js`）。
 * 这里只负责脱敏、格式化、截图、落历史，然后把内容回传。
 */
importScripts(
  '../shared/text-utils.js',
  '../shared/surrogate-safe-string.js',
  '../shared/budget.js',
  '../shared/format.js',
  // 导出压缩包要用。放在 format 之后：`screenshotImageName` 是"图片在包里的路径"
  // 唯一来源，打包与 Markdown 引用都从它取。
  '../shared/zip.js',
  '../shared/attribute-allowlist.js',
  '../shared/secret-patterns.js',
  './sanitize.js',
  './screenshot-crop.js',
  './screenshot-capture.js',
  './history-store.js',
  './shot-diagnostics.js'
)

const ns = globalThis.__EG__

/**
 * 最近一次已知的"抓取模式"状态。
 *
 * 只用来让面板**打开那一刻**就能显示正确的按钮文案（「元素注释」还是「取消元素注释」），
 * 免得先显示错的再跳变。它是纯缓存：worker 被回收后为 null，面板会退回注入查询。
 * 不作为任何判断的依据 —— 判断一律走 `grab.state` 的真实查询。
 * @type {{ armed: boolean, tabId: number|null, at: number }|null}
 */
let lastGrabState = null

/**
 * 让侧边面板**常驻**。
 *
 * ## 这件事为什么需要显式设置
 *
 * Chrome 的侧边面板一旦打开本来就是常驻的（贴右侧、跨标签页、浏览器重启后还开着），
 * 但它的**入口**藏得很深：只能从右键扩展图标或拼图菜单打开。真机反馈就是
 * 「侧边栏没有常驻右侧展示」—— 因为压根没打开过。
 *
 * `openPanelOnActionClick: true` 让**点扩展图标直接开侧边面板**，这是其他插件
 * 给人的那种体验。
 *
 * ## 代价（必须说清）
 *
 * Chrome 的规则是二选一：设了这个之后**弹窗不会再出现**（点击只开面板）。
 * 所以弹窗里的内容（最近抓取列表、复制按钮、自检、进入抓取模式）必须都在
 * 侧边面板里可得 —— 那些能力本来就在面板里，本轮补上了复制按钮。
 *
 * 「进入抓取模式」的入口随之变成快捷键 `Ctrl+Shift+E`（面板里也留了按钮）。
 */
async function configureSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  } catch (error) {
    // 旧版 Chrome 没有这个 API；不影响其他功能。
  }
}

// 每次 worker 启动都设一遍：`setPanelBehavior` 是持久化的，但 worker 会被回收。
//
// `configureSidePanel()` 的顶层调用放在**文件末尾**（所有声明之后）——
// 早先它在文件开头，靠函数提升才跑得起来；那种写法一旦出错，报错会指向调用点，
// 而真正的原因在几百行之外。
chrome.runtime.onInstalled.addListener(function () {
  void configureSidePanel()
})

/*
 * ⚠️ 这里原来挂着 `chrome.windows.onRemoved`，用来捕捉"用户直接叉掉注释小窗口"。
 *
 * 输入框搬到**侧边面板**之后就没有这个窗口了，那条监听随之删掉：
 * 面板没有"被叉掉"这个概念，它的关闭由 `grab.comment.cancel` 那条消息覆盖
 * （面板关了、暂存还在，重开时 `grab.annotation.context` 会把它读回来）。
 */

/**
 * 按依赖顺序注入的内容脚本。
 *
 * 顺序不能改：`text-utils` 提供 `clampStr`，`text-normalizer` 与 `selector` 依赖它；
 * `extract` 依赖 `selector` 与 `text-normalizer`；`screenshot-crop` 提供裁剪原语，
 * `screenshot-flow` 依赖它与 `overlay`；`clipboard` 提供文档侧剪贴板写入，
 * `annotation-dialog` 提供点选后的注释框，`picker` 依赖以上全部。
 */
const CONTENT_SCRIPTS = [
  'src/shared/text-utils.js',
  'src/shared/surrogate-safe-string.js',
  'src/shared/budget.js',
  'src/shared/format.js',
  'src/shared/attribute-allowlist.js',
  'src/shared/secret-patterns.js',
  'src/content/text-normalizer.js',
  'src/content/selector.js',
  'src/content/source-locator.js',
  'src/content/extract.js',
  'src/content/overlay.js',
  'src/content/capsule.js',
  'src/background/screenshot-crop.js',
  'src/content/screenshot-flow.js',
  // ⚠️ 这里**没有** `clipboard.js` 与 `annotation-dialog.js` —— 它们已经删掉了。
  //
  // 原因就是这个扩展最初那个反复修不好的问题：页面内的注释输入框会和页面的
  // 抽屉/模态框抢焦点。前后修了八轮（抢焦点、`focusin` 守卫、`inert`、
  // 防爆栈、按键兜底、退让…），全都是在一场**赢不了**的争夺里优化打法。
  //
  // Orca 的做法是页面侧**不创建任何输入控件**，注释 UI 放在它自己的渲染进程里。
  // 现在照做了：抽取完把 payload 交给 worker，用户在**侧边面板**的输入卡片里写注释。
  // 页面侧从此不写剪贴板、也不承载输入控件，那两个模块一起失去了调用者。
  //
  // 这里曾经挂着 `src/content/preview-overlay.js`：
  // 截图预览浮层。放在 picker 之前：picker 会用到 `isOurOwnUiEvent` 之类
  // 判断"这个元素是不是我们自己的 UI"，而浮层也是我们的 UI 之一。
  'src/content/preview-overlay.js',
  'src/content/picker.js'
]

/** `chrome.runtime.getURL` 在 service worker 里可用；用于诊断输出绝对路径。 */
function resolveContentScriptPaths() {
  return CONTENT_SCRIPTS.map(function (relative) {
    return chrome.runtime.getURL(relative)
  })
}

/**
 * 在指定标签页里依次执行内容脚本。
 *
 * ## 为什么是 `files:` 而不是 fetch + eval
 *
 * 我先试过"worker 读出源码 → 注入一个函数 eval 它们"。**那条路在原理上就是错的**：
 * 内容脚本虽然跑在隔离世界，`eval` 仍然受**页面**的 CSP 约束。真机错误是
 * `Evaluating a string as JavaScript violates the following Content Security Policy
 * directive ... 'unsafe-eval' is not an allowed source of script`。
 * 带 CSP 的页面上（包括扩展自己的页面）必然失败。
 *
 * `files:` 是**脚本资源加载**，不是字符串求值，所以不受该 CSP 限制 —— 这是唯一正确的做法。
 *
 * ## 为什么逐个文件注入而不是一次传整个数组
 *
 * 一次传数组时，任一文件加载失败只会得到一句
 * `Could not load file: 'chrome-extension://<id>/…'`，**分不清是路径解析问题还是
 * 某个文件本身的问题**。逐个注入的代价是多次 IPC（16 次，几十毫秒），
 * 换来的是精确到文件的失败信息 —— 这个交易值得。
 *
 * @param {number} tabId
 * @param {string[]} [only]
 */
async function injectContentScripts(tabId, only) {
  const wanted = only ? CONTENT_SCRIPTS.filter((p) => only.includes(p)) : CONTENT_SCRIPTS
  const failures = []

  for (const relative of wanted) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: [relative]
      })
    } catch (error) {
      failures.push(`${relative} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${wanted.length} 个文件注入失败：\n` + failures.join('\n')
    )
  }

  // 注入完再确认一次命名空间真的装起来了 —— 文件"注入成功"不等于"执行成功"。
  const probe = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: function () {
      const api = globalThis.__EG__
      return {
        keyCount: api ? Object.keys(api).length : 0,
        hasArmPicker: Boolean(api && typeof api.armPicker === 'function')
      }
    }
  })
  const outcome = probe && probe[0] ? probe[0].result : null
  if (!outcome || outcome.keyCount === 0) {
    throw new Error('内容脚本注入返回成功，但页面里读不到命名空间 —— 文件可能没有被执行。')
  }
  return outcome
}

/**
 * 注入失败是不是"权限不足"这一类。
 *
 * 为什么必须单独识别它（真机踩出来的）：`activeTab` 只在**用户调用扩展**时授予，
 * 并且**标签页导航就会撤销**。侧边面板是常驻的，所以"点图标 → 页面导航 →
 * 点面板按钮"这条最常见的路径上根本没有授权，注入会被拒。
 * 而快捷键能用，因为每次按都是一次新的调用、每次都重新授权。
 *
 * 真机报错原文：
 * `Cannot access contents of the page. Extension manifest must request permission
 *  to access the respective host.`
 *
 * 识别出来之后就能给用户一条**能自己走下去**的路：申请长期 host 授权
 * （manifest 里已声明 `optional_host_permissions`，见 spec §9.4）。
 *
 * @param {unknown} error
 */
function isPermissionDenied(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /Cannot access contents of the page|must request permission|Cannot access a chrome|extension manifest/i.test(
    message
  )
}

/**
 * 让内容脚本进入抓取模式。
 *
 * 为什么要先注入再调用：`activeTab` 权限下我们无法假设脚本已在页面上（每次导航都被清掉），
 * 所以先注入再调用。注入完成后立刻在同一帧里调用 `armPicker`，避免用消息去"碰运气"
 * —— 那是竞态。
 *
 * @param {chrome.tabs.Tab} tab
 * @param {{ toggle?: boolean }} [options]
 */
async function enterGrabMode(tab, options) {
  if (!tab || !tab.id) {
    return
  }
  const armOptions = {
    toggle: Boolean(options && options.toggle),
  }
  try {
    await injectContentScripts(tab.id)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: function (armArgs) {
        globalThis.__EG__.armPicker(armArgs)
      },
      args: [armOptions]
    })
  } catch (error) {
    // chrome://、扩展商店、PDF 内建查看器等页面不允许注入。这不是异常，
    // 而是需要明确告知用户的常规结果（AC-15）。
    await showActionBadgeUninjectable(tab.id, error)
  }
}

/**
 * 注入被拒时给用户一个可理解的信号，而不是静默无反应。
 * @param {number} tabId
 * @param {unknown} error
 */
async function showActionBadgeUninjectable(tabId, error) {
  const detail = error instanceof Error ? error.message : String(error)
  try {
    await chrome.action.setBadgeText({ tabId, text: '×' })
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7f1d1d' })
    await chrome.action.setTitle({
      tabId,
      title: `页面元素注释：无法在此页面注入\n${detail}`
    })
  } catch (badgeError) {
    // 标签页可能已经关闭；角标失败不是需要上报的问题。
  }
}

// Why: 弹窗在 manifest 里用 `action.default_popup` 声明（声明式，不依赖 worker 先跑起来）。
//
// 注意：一旦声明了弹窗，`chrome.action.onClicked` **就不会再触发** ——
// Chrome 的行为是"有弹窗时点击只开弹窗"。这个监听器只在没有弹窗时才会生效
// （例如有人手动删掉 manifest 里的 default_popup），保留它是为了那种情况下的可用性。
chrome.action.onClicked.addListener(function (tab) {
  void enterGrabMode(tab, { toggle: true })
})

/**
 * 键盘快捷键。
 *
 * `toggle-grab-mode`：切换抓取模式（已 armed 则退出）。
 * `grab-hovered-element`：不要求点击，把指针下一次落到元素上就抓。
 *
 * ⚠️ 已知限制（spec §17.2 手工验收项）：Chrome 的 `commands` 不会激活一个尚未注入
 * 内容脚本的标签页。因此**全新标签页上的首次快捷键不会生效**，需要先点一次扩展图标。
 * 这是 Chrome 的既有限制，不是本实现的缺陷；已在 README 与验收清单中记录。
 */
/**
 * 诊断：按执行顺序逐步跑一遍"注入内容脚本"那条链，第一个失败的步骤就是根因。
 * 结果是一个结构化清单，供弹窗里的自检页渲染。
 */
async function runDiagnostics() {
  /** @type {{ name: string, ok: boolean, detail: string, error?: string }[]} */
  const steps = []
  let ok = true

  steps.push({
    name: 'service worker 已响应',
    ok: true,
    detail: '后台进程正常运行，能处理消息。'
  })

  // 找一个可注入的普通网页标签页
  let targetTab = null
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
    targetTab = tabs.find(function (tab) {
      return typeof tab.id === 'number'
    })
    steps.push({
      name: '找到可注入的网页标签页',
      ok: Boolean(targetTab),
      detail: targetTab
        ? `将使用：${targetTab.title || ''} — ${targetTab.url || ''}`
        : '没有找到 http/https 的标签页。chrome:// 开头的页面（新标签页、设置、扩展管理页）不允许注入，请先打开一个普通网站再自检。'
    })
    if (!targetTab) {
      ok = false
    }
  } catch (error) {
    ok = false
    steps.push({
      name: '找到可注入的网页标签页',
      ok: false,
      detail: 'tab 查询失败。',
      error: error instanceof Error ? error.message : String(error)
    })
  }

  if (!targetTab || typeof targetTab.id !== 'number') {
    return {
      ok: false,
      verdict:
        '❌ 没有可注入的网页标签页。\n' +
        '请打开一个普通网站（例如 example.com），然后重新自检。',
      steps,
      hint: null
    }
  }

  const tabId = targetTab.id

  const hasScripting = Boolean(chrome.scripting && chrome.scripting.executeScript)
  steps.push({
    name: 'chrome.scripting API 可用',
    ok: hasScripting,
    detail: hasScripting
      ? `scripting 权限已授予。将注入 ${CONTENT_SCRIPTS.length} 个文件，` +
        `首个路径示例：${resolveContentScriptPaths()[0]}`
      : 'scripting API 不存在 —— manifest 里的 permissions 可能没生效，请重新加载扩展。'
  })
  if (!hasScripting) {
    return { ok: false, verdict: '❌ scripting API 不可用。', steps, hint: null }
  }

  // 逐个文件注入（files: 是唯一不受页面 CSP 限制的做法）
  let injectOutcome = null
  try {
    injectOutcome = await injectContentScripts(tabId)
    steps.push({
      name: `逐个注入 ${CONTENT_SCRIPTS.length} 个内容脚本文件`,
      ok: true,
      detail: `全部注入成功；注入后命名空间有 ${injectOutcome.keyCount} 个键。`
    })
  } catch (error) {
    ok = false
    steps.push({
      name: `逐个注入 ${CONTENT_SCRIPTS.length} 个内容脚本文件`,
      ok: false,
      detail: '至少一个文件注入失败 —— 下面的 error 里逐条列出了是哪些文件、什么错。',
      error: error instanceof Error ? error.message : String(error)
    })
    return {
      ok: false,
      verdict:
        '❌ 内容脚本注入失败 —— 这就是点图标没反应的根因。\n' +
        'error 里每一条都是「文件 → 错误」，请整段发给我。',
      steps,
      hint: null
    }
  }

  // 冒烟：真的进入一次抓取模式，确认交互层也活了。
  // 注意这里**不该**检查 sanitizePayload —— 安全边界只在 service worker 侧加载，
  // 内容侧没有它是架构要求，不是缺失。
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: function () {
        const api = globalThis.__EG__
        return {
          injected: typeof api !== 'undefined',
          keyCount: api ? Object.keys(api).length : 0,
          hasArmPicker: Boolean(api && typeof api.armPicker === 'function'),
          hasExtractPayload: Boolean(api && typeof api.extractPayload === 'function'),
          hasOverlayMount: Boolean(api && typeof api.mountOverlay === 'function'),
          hasExtractWithScreenshot: Boolean(api && typeof api.extractWithScreenshot === 'function'),
          hasCopyText: Boolean(api && typeof api.copyTextToClipboard === 'function'),
          hasCopyImage: Boolean(api && typeof api.copyImageToClipboard === 'function')
        }
      }
    })
    const probeResult = probe && probe[0] ? probe[0].result : null
    const ready = Boolean(
      probeResult &&
        probeResult.injected &&
        probeResult.hasArmPicker &&
        probeResult.hasExtractPayload &&
        probeResult.hasOverlayMount &&
        probeResult.hasExtractWithScreenshot &&
        probeResult.hasCopyText
    )
    steps.push({
      name: '注入后内容脚本的命名空间已就绪',
      ok: ready,
      detail: probeResult
        ? `命名空间共 ${probeResult.keyCount} 个键；armPicker=${probeResult.hasArmPicker}、` +
          `extractPayload=${probeResult.hasExtractPayload}、mountOverlay=${probeResult.hasOverlayMount}、` +
          `extractWithScreenshot=${probeResult.hasExtractWithScreenshot}、` +
          `copyText=${probeResult.hasCopyText}、copyImage=${probeResult.hasCopyImage}`
        : '探测没有返回结果。'
    })
    if (!ready) {
      ok = false
    }
  } catch (error) {
    ok = false
    steps.push({
      name: '注入后内容脚本的命名空间已就绪',
      ok: false,
      detail: '无法在目标页面里读取内容脚本状态。',
      error: error instanceof Error ? error.message : String(error)
    })
  }

  return {
    ok,
    verdict: ok
      ? '✅ 一切正常。\n回到那个页面，点扩展图标 →「进入抓取模式」，然后点页面上的元素试试。'
      : '⚠️ 注入本身成功，但内容脚本没有正确装配 —— 请把上面每一步的详情发给我。',
    steps,
    hint: null
  }
}

/**
 * 容量已满时的统一错误。
 *
 * 文案要说清**三件事**：现在多少、上限多少、怎么办。
 * 只说"存储已满"会让用户去猜该删几条、还是该改设置。
 *
 * @param {{ recordCount: number, maxRecords: number, bytes: number, maxBytes: number, reason: string|null }} capacity
 */
function capacityExceededError(capacity) {
  const mb = (value) => (value / (1024 * 1024)).toFixed(1)
  const which =
    capacity.reason === 'records'
      ? `记录条数已达上限（${capacity.recordCount} / ${capacity.maxRecords} 条）`
      : `已用容量已达上限（${mb(capacity.bytes)} / ${mb(capacity.maxBytes)} MB）`
  return {
    code: 'history_quota_exceeded',
    message:
      `${which}。\n` +
      '解决办法（任选其一）：\n' +
      '· 在面板里删掉几条旧记录，或点「清空」\n' +
      '· 在面板的「容量设置」里把上限调大\n' +
      '（不会自动挤掉旧记录 —— 那等于悄悄删你的东西。）',
    capacity: capacity
  }
}

/**
 * 「等用户写注释」期间暂存的那份数据。
 *
 * 放 `chrome.storage.session` 而不是模块变量：MV3 的 worker 随时可能被回收，
 * 而用户在小窗口里写注释的这段时间**完全够它被回收一次**。
 * session 作用域在浏览器重启后自然清空，正是这里需要的语义。
 */
const PENDING_ANNOTATION_KEY = 'pendingAnnotation'



/**
 * 通知页面：这次注释结束了，把高亮框解冻。
 *
 * 用户要求："用户注释以后 框选的区域必须要常驻显示，
 * 直到用户取消/添加完成此次注释的添加。"
 *
 * 所以"结束"必须**双向**通知到：不解冻就会出现"框一直挂在那儿、
 * 鼠标怎么动都不动"的僵尸状态。
 *
 * 三种结束方式都要走这里：
 *   · 点「添加」提交；
 *   · 点「取消」；
 *   · **直接点窗口的关闭按钮** —— 那条只有 `windows.onRemoved` 观察得到。
 *
 * @param {number|null} tabId 发起这次抓取的标签页
 */
async function notifyAnnotationEnded(tabId) {
  if (typeof tabId !== 'number') {
    return
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'grab.annotation.end' })
  } catch (error) {
    // 页面已经导航走 / 内容脚本不在：没有高亮框要解冻，正常情况。
  }
}

/**
 * 给面板看的元素标识（`div.cm-content` 这种形态）。
 *
 * 面板顶部那个输入卡片要显示"你选中的是哪里"。取元素路径里最后一截就够 ——
 * 太长会把一行撑满，而用户只需要认出来是不是自己点的那个。
 *
 * ## ⚠️ 字段在 `payload.target` 里面，不是 `payload` 上
 *
 * 真机反馈："为什么这里显示 【（未命名元素）】呢？"
 *
 * 我第一版读的是 `payload.elementPath` —— 那个字段**根本不存在**。
 * `extract.js` 把它放在 **`payload.target.elementPath`**（和 `selector`、
 * `fullPath` 一起，见那里的返回结构）。读错层级不会报错，只会静默地永远走兜底文案，
 * 所以面板上一直显示「（未命名元素）」。
 *
 * 与面板详情面板里 `target.elementPath` 的读法保持一致。
 *
 * @param {any} payload
 * @returns {string}
 */
function describePendingTarget(payload) {
  const target = (payload && payload.target) || {}
  // 可读路径优先；退到选择器；再退到完整路径 —— 三层都是"能认出这个元素"的表达。
  const raw = target.elementPath || target.selector || target.fullPath || ''
  const path = typeof raw === 'string' ? raw.trim() : ''
  if (path === '') {
    return '（未命名元素）'
  }
  const segments = path.split('>')
  const last = segments[segments.length - 1].trim()
  return last !== '' ? last : path
}

/**
 * 通知面板：有一笔注释待写，把输入卡片亮出来。
 *
 * 面板打不开时（用户把它关了）不报错：暂存还在，用户重新打开面板时
 * `grab.annotation.context` 会把它读出来。所以面板关着**不是错误**，
 * 只是这一步没人在听。
 *
 * @param {any} prepared
 */
async function notifyPanelOfPending(prepared) {
  try {
    await chrome.runtime.sendMessage({
      type: 'grab.annotation.pending',
      label: prepared ? prepared.label : ''
    })
  } catch (error) {
    // 面板未打开：正常情况（见上）。
  }
}

/**
 * 通知面板：那笔待写的注释作废了，把输入卡片收起来。
 *
 * 与 `notifyPanelOfPending` 成对。面板没开着时静默失败 —— 它下次打开会走
 * `grab.comment.context` 自己发现"没有待写注释"。
 */
async function notifyPanelAnnotationDismissed() {
  try {
    await chrome.runtime.sendMessage({ type: 'grab.annotation.dismissed' })
  } catch (error) {
    // 面板未打开：正常情况。
  }
}

/**
 * 读取"还没写完注释的那次抓取"，没有就返回 null。
 *
 * 放 `chrome.storage.session` 而不是模块变量：MV3 的 worker 随时可能被回收，
 * 而用户在小窗口里写注释的这段时间**完全够它被回收一次**。
 *
 * @returns {Promise<any|null>}
 */
async function readPendingAnnotation() {
  try {
    const stored = await chrome.storage.session.get([PENDING_ANNOTATION_KEY])
    return stored && stored[PENDING_ANNOTATION_KEY] ? stored[PENDING_ANNOTATION_KEY] : null
  } catch (error) {
    return null
  }
}

/**
 * 把暂存的记录落库，并把文本与截图一起写进剪贴板。
 *
 * @param {string} comment
 * @returns {Promise<{ ok: true, result: object } | { ok: false, error: { code: string, message: string } }>}
 */
async function finishPendingAnnotation(comment) {
  const pending = await readPendingAnnotation()
  if (!pending || !pending.record) {
    return {
      ok: false,
      error: { code: 'no_pending_annotation', message: '这次抓取已经失效了，请重新选一次元素。' }
    }
  }

  const record = pending.record
  record.comment = ns.normalizeComment(comment)
  let historyDropped = 0
  try {
    const writeResult = await ns.appendRecord(record)
    historyDropped = writeResult.droppedCount
  } catch (error) {
    // storage 配额或 worker 回收期间的写入失败；不阻断抓取。
  }
  await chrome.storage.session.remove(PENDING_ANNOTATION_KEY)

  /*
   * ⚠️ **必须在这里重新格式化**，不能复用 `pending.text`。
   *
   * 真机反馈："系统注释完以后 你自动复制到剪切板的内容没有【Requested change:】内容，
   * 但是我点击复制全部、复制文本都有这个内容。"
   *
   * 原因：`pending.text` 是在**点击那一刻**格式化的，而那时注释还没写
   * （`message.comment` 是空的），所以它天然不含 "Requested change" 那一段。
   * 用户后来写的注释只被写进了记录，**没有回到那段要复制的文本里**。
   *
   * 而「复制全部 / 复制文本」走的是另一条路（`clipboard.copyText`），
   * 它从**已落库的记录**里取 `comment` 重新格式化 —— 所以那两个按钮反而是对的。
   *
   * 两条路必须产出同一段文本：注释是整段上下文里唯一说明"要改什么"的那一句，
   * 缺了它，粘给 AI 的只是一堆没有问题的描述。
   */
  const textForClipboard = ns.formatGrabPayloadAsText(record.payload, record.comment)

  return {
    ok: true,
    result: {
      textForClipboard: textForClipboard,
      screenshotDataUrl: record.payload && record.payload.screenshot
        ? record.payload.screenshot.dataUrl
        : null,
      historyDropped
    }
  }
}

/**
 * 所有消息的唯一入口。
 *
 * 每个分支返回 `{ ok, result }` 或 `{ ok: false, error: { code, message } }` ——
 * 调用方（面板 / 内容脚本）靠 `error.code` 决定怎么补救，而不是去解析错误文案。
 *
 * @param {any} message
 * @param {{ tab?: chrome.tabs.Tab, sender?: chrome.runtime.MessageSender }} context
 * @returns {Promise<{ ok: true, result?: unknown } | { ok: false, error: { code: string, message: string } }>}
 */
async function handleMessage(message, context) {
  if (message && message.type === 'diagnostics.run') {
    return { ok: true, result: await runDiagnostics() }
  }

  /**
   * 取某条记录的**完整截图**（不是缩略图）。
   *
   * 面板列表里只带缩略图（160px 的 JPEG），点开看大图时才按需取完整的那张 ——
   * 列表投影故意不带完整 payload，否则面板渲染代价会随历史规模线性增长。
   */
  if (message && message.type === 'history.screenshot') {
    const { records } = await ns.readHistory()
    const record = records.find(function (candidate) {
      return candidate.id === message.id
    })
    const shot = record && record.payload ? record.payload.screenshot : null
    if (!shot || !shot.dataUrl) {
      return { ok: false, error: { code: 'no_screenshot', message: '这条记录没有截图' } }
    }
    return {
      ok: true,
      result: { dataUrl: shot.dataUrl, width: shot.width, height: shot.height }
    }
  }


/**
   *
   * 这三个消息存在的理由：**阻断点必须前移**。
   * 用户原话："用户框选元素的时候就应该阻止，而不是用户设置完注释以后点击添加按钮
   * 才阻断，这样用户体感一点都不好。"
   *
   * 所以容量是一个可以被**预先查询**的事实，而不是写入失败时才冒出来的错误。
   */
  if (message && message.type === 'history.capacity') {
    return { ok: true, result: await ns.readCapacity() }
  }

  if (message && message.type === 'settings.get') {
    const settings = await ns.readSettings()
    const capacity = await ns.readCapacity()
    const floor = await ns.readUsageFloor()
    return {
      ok: true,
      result: {
        settings,
        defaults: ns.DEFAULT_SETTINGS,
        limits: ns.SETTINGS_LIMITS,
        capacity,
        // 输入框的**有效下限**。面板拿它设 `min`，让"调不下去"这件事
        // 在用户敲之前就看得见，而不是敲完被静默改成别的数字。
        floor
      }
    }
  }

  /**
   * 在当前页面里弹出截图预览浮层。
   *
   * 由面板发起。为什么不让面板自己开标签页：用户明确要求
   * "直接在当前页面打开，不要新增页面打开"。页面占满主区域、宽度够用，
   * 而且**不打断手上正在做的事**（跳走再跳回来是要付成本的）。
   *
   * 这里要处理"当前页面还没注入过内容脚本"的情况 —— 冷启动时很常见。
   * 所以先注入、再发消息；注入用的是已有的那套（含按文件逐个报错的能力）。
   */
  if (message && message.type === 'preview.show') {
    const { records } = await ns.readHistory()
    const record = records.find(function (candidate) {
      return candidate.id === message.id
    })
    const shot = record && record.payload ? record.payload.screenshot : null
    if (!shot || !shot.dataUrl) {
      return { ok: false, error: { code: 'no_screenshot', message: '这条记录没有截图' } }
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs && tabs[0]
    if (!tab || typeof tab.id !== 'number') {
      return { ok: false, error: { code: 'no_active_tab', message: '找不到当前标签页。' } }
    }

    try {
      await injectContentScripts(tab.id)
      await chrome.tabs.sendMessage(tab.id, {
        type: 'preview.showOverlay',
        screenshot: { dataUrl: shot.dataUrl, width: shot.width, height: shot.height }
      })
      return { ok: true, result: { shown: true } }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: isPermissionDenied(error) ? 'needs_host_permission' : 'preview_failed',
          message:
            '无法在这个页面上显示预览 —— 需要先给这个网站授权（面板里有「授权访问所有网站」）。'
        }
      }
    }
  }


  if (message && message.type === 'settings.set') {
    // 面板保存容量设置时只发 `{ maxRecords, maxBytes }` —— **没带上的字段必须保留**。
    //
    // 这条规则当初是为了保护快捷键（两个设置同住 `settings` 对象，整体覆盖会把
    // 没带上的那个清掉）。快捷键那套删掉之后规则本身依然成立：
    // "保存容量顺手把别的设置重置了"始终是个 bug，不能靠"发的人记得带上全部字段"。
    const current = await ns.readSettings()
    const incoming = message.settings || {}
    const settings = await ns.writeSettings(Object.assign({}, current, incoming))
    return { ok: true, result: { settings, capacity: await ns.readCapacity() } }
  }

  /**
   * 内容脚本报告"截图因为缺授权被拒"。
   *
   * 转给侧边面板，让它露出「授权访问所有网站」按钮。
   * 面板可能没开 —— 那种拒绝必须吞掉。
   */
  if (message && message.type === 'grab.needsHostPermission') {
    try {
      void chrome.runtime
        .sendMessage({ type: 'grab.needsHostPermission' })
        .catch(function () {
          // 面板未打开：正常情况。
        })
    } catch (error) {
      // 同上。
    }
    return { ok: true, result: { acknowledged: true } }
  }

  /**
   * 内容脚本报告"抓取模式开了/关了"。
   *
   * 转给侧边面板，让按钮在「元素注释」与「取消元素注释」之间切换。
   * 面板可能没开 —— 那种情况下 `sendMessage` 会拒绝，**必须吞掉**，
   * 否则每次在页面上按 Esc 都会在 worker 里留一条未处理拒绝。
   */
  if (message && message.type === 'grab.state.changed') {
    const armed = Boolean(message.armed)
    // `mode` 必须原样转给面板 —— 见面板 `setGrabArmed` 那段注释：
    // 少了它，两个入口按钮会同时显示「取消…」（真机反馈过）。
    const mode = armed ? message.mode || 'click' : null
    const tabId = context.tab && typeof context.tab.id === 'number' ? context.tab.id : null
    // 顺手记下最后状态：面板重新打开时可以先拿它显示，不必等一次注入查询。
    lastGrabState = { armed, mode, tabId, at: Date.now() }
    try {
      void chrome.runtime
        .sendMessage({ type: 'grab.state', armed, mode, tabId })
        .catch(function () {
          // 面板未打开：正常情况。
        })
    } catch (error) {
      // 同上。
    }
    return { ok: true, result: { acknowledged: true } }
  }

  /**
   * 查询抓取模式当前状态。
   *
   * 状态的真身在**页面**里（用户可能在页面上按了 Esc），所以这里注入一次去问。
   * 页面读不到内容脚本的命名空间时（未注入）按"未开启"处理 —— 那是真实状态。
   */
  if (message && message.type === 'grab.state') {
    /*
     * ⚠️ 先看有没有**未完成的注释**，有就直接问那个标签页。
     *
     * 真机反馈："只要弹窗打开了 按钮就会由 取消注释 变成 元素注释，
     * 但我此时依然可以使用元素框选。"
     *
     * 原因：注释窗口一聚焦，`{ active: true, currentWindow: true }` 解析到的
     * 就是**注释窗口自己那个标签页**（我们的扩展页），去问它"你有没有 armed"
     * 当然得到 `false` —— 于是面板把按钮复位，而页面里的拾取器**其实还 armed 着**。
     *
     * 也就是说：这不是状态错了，是**问错了标签页**。
     *
     * 判据用"未完成注释记下的 tabId"而不是"过滤掉扩展页"：
     * `tab.url` 需要 `tabs` 权限才能读，而清单里没有、也不该为此加。
     * 记下来的那个 id 是这一路唯一真实可靠的锚点。
     */
    const pendingForState = await readPendingAnnotation()
    let tab = null
    if (pendingForState && typeof pendingForState.tabId === 'number') {
      tab = { id: pendingForState.tabId }
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      tab = tabs && tabs[0]
    }
    if (!tab || typeof tab.id !== 'number') {
      return { ok: true, result: { armed: false, tabId: null } }
    }
    try {
      const probe = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: function () {
          const api = globalThis.__EG__
          if (!api || typeof api.isPickerArmed !== 'function') {
            return { armed: false, mode: null }
          }
          const armed = api.isPickerArmed()
          // **把"当前是哪个入口"一起带回去。**
          //
          // 面板据此只把**用到的那个**按钮改成「取消…」。真机反馈：
          // "为什么我点击元素注释，同时出现了两个取消？不应该我当前操作的是哪个
          // 你就应该显示哪个取消吗？" —— 之前这里只返回 `armed`，面板拿不到模式，
          // 只好把两个都改成取消态，用户就分不清自己点的是哪个。
          // 读**入口模式**（`getPickerMode()`），不要再从"是否在等悬停"推导。
          //
          // 推导会在动作过程中翻面：悬停命中后那个标志复位，于是面板收到
          // `mode: 'click'`，把另一个按钮点亮 —— 真机反馈的"闪黑"。
          const mode =
            typeof api.getPickerMode === 'function'
              ? api.getPickerMode()
              : null
          return { armed, mode: armed ? mode || 'click' : null }
        }
      })
      const result = (probe && probe[0] && probe[0].result) || { armed: false, mode: null }
      const armed = Boolean(result.armed)
      lastGrabState = { armed, tabId: tab.id, at: Date.now() }
      return { ok: true, result: { armed, mode: result.mode || null, tabId: tab.id } }
    } catch (error) {
      // 注入不进去（chrome:// 页面、无授权等）→ 不可能处于抓取模式。
      return {
        ok: true,
        result: { armed: false, mode: null, tabId: tab.id, note: 'not_injectable' }
      }
    }
  }

  /**
   * 关掉抓取模式。
   *
   * 存在的理由（真机踩出来的）：拾取器的 Esc 监听挂在**页面**的 document 上，
   * 而点过面板按钮之后焦点在**面板**里 —— 按键根本到不了页面，Esc 因此"有时不生效"。
   * 面板自己也监听 Esc，走这条消息把页面里的拾取器关掉。
   */
  if (message && message.type === 'grab.cancel') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs && tabs[0]
    if (!tab || typeof tab.id !== 'number') {
      return { ok: false, error: { code: 'no_active_tab', message: '找不到当前活动标签页。' } }
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: function () {
          const api = globalThis.__EG__
          if (api && typeof api.disarmPicker === 'function') {
            api.disarmPicker()
          }
        }
      })
      lastGrabState = { armed: false, tabId: tab.id, at: Date.now() }
      /*
       * 退出注释模式 = 用户不写了。
       *
       * 必须把**待写的那笔注释**一起收掉，否则会留下一个半死不活的状态：
       *   · 面板里的输入卡片还挂着、写着上次的内容；
       *   · 页面里那个高亮框还冻结在旧元素上（真机反馈："取消注释 以后原来的
       *     框选仍然存在 不应该关闭掉吗？"）；
       *   · `grab.state` 还会优先去问那个已经作废的标签页。
       *
       * 用户点了「取消注释」，意思就是"这件事我不做了"，不该再留着任何一半。
       */
      const pendingOnDisarm = await readPendingAnnotation()
      if (pendingOnDisarm) {
        await chrome.storage.session.remove(PENDING_ANNOTATION_KEY)
        await notifyAnnotationEnded(pendingOnDisarm.tabId)
        await notifyPanelAnnotationDismissed()
      }
      return { ok: true, result: { armed: false } }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'cancel_failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  /**
   * 内容侧的截图诊断上报。
   *
   * 截图失败最常发生在内容侧（取图 → 解码 → 裁剪），而那边跑在隔离世界，
   * 页面控制台看不到。所以它主动把每一步回传到这里记档。
   * 内容脚本**不等**这次响应，所以这里不能做任何可能抛错的事。
   */
  if (message && message.type === 'screenshot.diagnostic') {
    ns.recordShotDiagnostic(String(message.stage || '(无阶段)'), message.detail || null)
    return { ok: true, result: { recorded: true } }
  }

  /**
   * 读截图诊断记录。用户在界面上查看，不需要开控制台。
   * 传 `{ clear: true }` 时先清空，便于"重载扩展 → 复现一次 → 只看这一次"。
   */
  if (message && message.type === 'screenshotDiagnostics.get') {
    if (message.clear) {
      await chrome.storage.local.remove([ns.SHOT_DIAGNOSTICS_KEY])
      return { ok: true, result: { entries: [] } }
    }
    const stored = await chrome.storage.local.get([ns.SHOT_DIAGNOSTICS_KEY])
    const entries = Array.isArray(stored && stored[ns.SHOT_DIAGNOSTICS_KEY])
      ? stored[ns.SHOT_DIAGNOSTICS_KEY]
      : []
    return { ok: true, result: { entries } }
  }

  // 打开侧边面板。
  //
  // 侧边面板的入口在 Chrome 里藏得很深（拼图菜单或右键扩展图标），真机反馈
  // 明确说了"用户都看不到"，所以弹窗里给一个按钮直接开。
  //
  // 注意 `sidePanel.open()` 要求**用户手势**，而消息是异步处理的，手势可能已经
  // 失效 —— 所以这里**不假装一定成功**：失败时如实回报，由弹窗提示用户走
  // 右键菜单那条路。
  if (message && message.type === 'panel.open') {
    if (!chrome.sidePanel || typeof chrome.sidePanel.open !== 'function') {
      return {
        ok: false,
        error: {
          code: 'side_panel_unavailable',
          message: '当前 Chrome 不支持 sidePanel.open，请右键扩展图标 →「打开侧边面板」。'
        }
      }
    }
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tab = tabs && tabs[0]
      if (!tab || typeof tab.id !== 'number') {
        return {
          ok: false,
          error: { code: 'no_active_tab', message: '找不到当前活动标签页。' }
        }
      }
      await chrome.sidePanel.open({ tabId: tab.id })
      return { ok: true, result: { opened: true } }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'side_panel_open_failed',
          message:
            `打开侧边面板被拒绝（${error instanceof Error ? error.message : String(error)}）。` +
            '请右键扩展图标 →「打开侧边面板」。'
        }
      }
    }
  }

  // 来自弹窗的手动入口。弹窗拿不到 tab 参数，所以这里自己查当前活动标签页。
  /*
   * 注释输入框的三条消息。
   *
   * 输入框住在**侧边面板**里（我们自己的文档），所以这几条是"面板 → worker"，
   * 页面完全不参与 —— 也就没有抢焦点这回事。
   */
  if (message && message.type === 'grab.comment.context') {
    const pending = await readPendingAnnotation()
    if (!pending || !pending.record) {
      // **没有暂存不是错误**：面板每次打开都会问一次，没有待写注释才是常态。
      // 这里返回 `ok: true` + `pending: false`，让面板据此收起输入卡片，
      // 而不是把它当成一次失败（那会在面板上弹一条莫名其妙的红字）。
      return { ok: true, result: { pending: false, label: '' } }
    }
    return {
      ok: true,
      result: {
        pending: true,
        label: pending.label || describePendingTarget(pending.record.payload || {})
      }
    }
  }

  if (message && message.type === 'grab.comment.submit') {
    // 先把 tabId 记下来 —— `finishPendingAnnotation` 会把暂存清掉。
    const beforeSubmit = await readPendingAnnotation()
    const finished = await finishPendingAnnotation(message.comment || '')
    if (!finished.ok) {
      return finished
    }
    // 注释完成了 → 让页面把高亮框解冻。
    await notifyAnnotationEnded(beforeSubmit ? beforeSubmit.tabId : null)
    /*
     * 落库在这里做，**剪贴板交给窗口自己写**。
     *
     * 两个理由：
     *   · 窗口是个带文档的上下文，而且提交时它正是前台窗口 —— 写剪贴板最稳；
     *   · 页面那边可能已经导航走了，把内容回传给页面去写是不可靠的。
     */
    return finished
  }

  if (message && message.type === 'grab.comment.cancel') {
    const beforeCancel = await readPendingAnnotation()
    await chrome.storage.session.remove(PENDING_ANNOTATION_KEY)
    await notifyAnnotationEnded(beforeCancel ? beforeCancel.tabId : null)
    /*
     * ⚠️ 新增：把"卡片收起来"也广播出去。
     *
     * 这条消息原来**只有面板会发**（用户点注释框的「取消」），面板自己就地收起
     * 卡片就够了，所以不需要广播。
     *
     * 现在**页面里的 Esc 也会发它**（用户要求："esc 只控制是否取消当前选中的
     * 高亮区域，不支持通过 esc 键退出元素注释" —— 于是"取消"这一半被搬到了
     * 页面侧）。发起的文档变成了页面，面板不会知道，卡片会挂着一个**已经作废的
     * 元素标识**继续等着用户提交。
     *
     * 面板那条路收到这条广播是无害的：`hideAnnotationComposer()` 是幂等的，
     * 它本来也要做同一件事。
     */
    await notifyPanelAnnotationDismissed()
    return { ok: true, result: { cancelled: true } }
  }

  if (message && message.type === 'grab.manual.start') {
    // 容量检查放在**最前面**，早于找标签页、早于注入。
    //
    // 用户要求的正是这个顺序："用户框选元素的时候就应该阻止，而不是用户设置完注释
    // 以后点击添加按钮才阻断"。连抓取模式都不该让他进去 —— 进去了、选好元素、
    // 写完一整段注释，最后才被拒绝，那段时间全白花。
    const capacity = await ns.readCapacity()
    if (capacity.atLimit) {
      return { ok: false, error: capacityExceededError(capacity) }
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs && tabs[0]
    if (!tab || typeof tab.id !== 'number') {
      return {
        ok: false,
        error: { code: 'no_active_tab', message: '找不到当前活动标签页。' }
      }
    }
    try {
      await injectContentScripts(tab.id)
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: function (armArgs) {
          globalThis.__EG__.armPicker(armArgs)
        },
        args: [{ toggle: false }]
      })
      return { ok: true, result: { armed: true } }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)

      // 权限不足时给一个**专门的码**，让面板能推出"授权"按钮。
      // 不这么做的话，用户看到的是一句让他去检查 chrome:// 页面的提示 ——
      // 而真实原因是他这次没有授权，跟页面类型无关。我第一版就是那样，
      // 结果真机反馈「同一个页面，面板按钮报错、快捷键又可以」，提示完全指错方向。
      if (isPermissionDenied(error)) {
        return {
          ok: false,
          error: {
            code: 'needs_host_permission',
            message:
              '这条标签页当前没有访问授权。\n' +
              '原因：Chrome 的临时授权（activeTab）只在**点图标或按快捷键**那一刻生效，' +
              '而且**页面一导航就会被撤销**；侧边面板是常驻的，所以从面板点按钮时往往已经没有授权了。\n' +
              '解决：点下面的「授权访问所有网站」一次，之后从面板里就能直接进入抓取模式。\n' +
              '（或者按 Ctrl+Shift+E —— 快捷键每次都是一次新的授权，所以一直可用。）',
            origin: typeof tab.url === 'string' ? tab.url : null
          }
        }
      }

      return {
        ok: false,
        error: {
          code: 'inject_failed',
          message:
            `无法在这个页面上注入（${detail}）。\n` +
            '常见原因：\n' +
            '  · chrome:// 开头的页面（新标签页、设置、扩展管理页）—— 换普通网站即可\n' +
            '  · 本地文件 file:// 打开的页面 —— Chrome 默认禁止扩展注入，' +
            '需要到 chrome://extensions 里打开该扩展的「允许访问文件网址」\n' +
            '  · Chrome 应用商店等受保护页面 —— 同样不允许注入'
        }
      }
    }
  }

  if (message && message.type === 'grab.screenshot.request') {
    const windowId = context.tab && context.tab.windowId
    try {
      const dataUrl = await ns.captureVisibleTab(windowId)
      // 把真实返回值记下来（只记前缀与长度）。真机上截图一直失败，
      // 而失败点无从判断 —— 这条记录能直接回答"API 到底返回了什么"。
      ns.recordShotDiagnostic('captureVisibleTab:ok', {
        windowId: typeof windowId === 'number' ? windowId : `(非数字: ${typeof windowId})`,
        returned: ns.inspectDataUrl(dataUrl, 'captureVisibleTab 返回值')
      })
      return { ok: true, result: { dataUrl } }
    } catch (error) {
      const classified = ns.classifyCaptureError(error)
      const detail = error instanceof Error ? error.message : String(error)
      ns.recordShotDiagnostic('captureVisibleTab:failed', {
        windowId: typeof windowId === 'number' ? windowId : `(非数字: ${typeof windowId})`,
        error: detail,
        classified
      })

      // 缺权限时给**专门的码**，让面板能推出授权按钮。
      //
      // 真机踩出来的关键区别：`captureVisibleTab` 要的是 **`<all_urls>` 或
      // `activeTab`**，而 `optional_host_permissions` 里写 `http://*/*`,
      // `https://*/*` 只能覆盖 `scripting.executeScript` —— 注入能用、截图被拒。
      // 所以 manifest 现在声明的是 `<all_urls>`，让一次授权同时覆盖两件事。
      if (/all_urls|activeTab|permission/i.test(detail)) {
        return {
          ok: false,
          error: {
            code: 'needs_host_permission',
            message:
              '截图需要访问这个网站的授权，而当前没有。\n' +
              '原因：Chrome 的临时授权（activeTab）只在**点图标或按快捷键**那一刻生效，' +
              '并且**页面一导航就撤销**。\n' +
              '解决：在侧边面板里点「授权访问所有网站」一次。' +
              '（或重新点一次扩展图标，重新获得临时授权。）'
          }
        }
      }

      return { ok: false, error: classified }
    }
  }

  if (message && message.type === 'grab.extract.request') {
    // 内容脚本带过来的截图先体检一次（只描述，不改动）。
    const incomingScreenshot = message.rawPayload && message.rawPayload.screenshot
    ns.recordShotDiagnostic('extract:received', {
      hasScreenshotField: Boolean(incomingScreenshot),
      screenshotIsObject: Boolean(incomingScreenshot && typeof incomingScreenshot === 'object'),
      incoming: incomingScreenshot ? ns.inspectDataUrl(incomingScreenshot.dataUrl, 'raw.screenshot.dataUrl') : null,
      omittedReasonFromContent: (message.rawPayload && message.rawPayload.screenshotOmittedReason) || null
    })

    const sanitized = ns.sanitizePayload(message.rawPayload)
    if (!sanitized.ok) {
      return { ok: false, error: { code: sanitized.code, message: sanitized.message } }
    }

    // 净化之后再记一次：这一步能看到"截图有没有被拒、拒绝理由是什么"。
    ns.recordShotDiagnostic('extract:sanitized', {
      kept: Boolean(sanitized.payload.screenshot),
      keptDataUrl: sanitized.payload.screenshot
        ? ns.inspectDataUrl(sanitized.payload.screenshot.dataUrl, '净化后保留的 dataUrl')
        : null,
      omittedReason: sanitized.payload.screenshotOmittedReason || null,
      redactedSelfCheck: ns.inspectDataUrl(
        message.rawPayload && message.rawPayload.screenshot
          ? message.rawPayload.screenshot.dataUrl
          : null,
        '净化前的 dataUrl'
      ).startsWithPng
    })

    // 注意这里**不写剪贴板**：service worker 里 `navigator.clipboard` 是 undefined
    // （MV3 worker 不是文档，没有剪贴板 API）。真机实测的报错是
    // `Cannot read properties of undefined (reading 'writeText')`。
    //
    // 剪贴板改由内容脚本在**页面文档**里写（`src/content/clipboard.js`）——
    // 那里既有文档、又处在本此点击的激活上下文内。所以这里把格式化好的文本回传。
    // 注释要一起进文本：它是整段上下文里唯一说明"要改什么"的那一句。
    // 不带它的话，用户写的意图只留在历史列表里，粘给 AI 的却是一堆没有问题的描述。
    const text = ns.formatGrabPayloadAsText(sanitized.payload, message.comment)

    // 截图是**独立**的第二个剪贴板载荷（spec §9.2 / §20.2）：文本走文本通道，
    // 图片走图片通道，用户可以分别粘贴。截图失败不影响文本已复制的事实。
    let screenshotNote = ''
    const screenshot = sanitized.payload.screenshot
    const hasScreenshot = Boolean(screenshot && screenshot.dataUrl)
    if (!hasScreenshot && sanitized.payload.screenshotOmittedReason) {
      screenshotNote = ns.describeScreenshotOmission(sanitized.payload.screenshotOmittedReason)
    }

    // 历史记录：**必须在 sanitize 之后**（ticket 06 的已知坑第一条）。
    // 先存 raw 再脱敏会让密码在磁盘上留一份。
    // 历史写入失败不影响本次抓取已经成功的事实。
    let historyDropped = 0

    /*
     * 「等用户写注释」这条路。
     *
     * ## 为什么输入框不在页面里
     *
     * 在页面里弹框会和页面的抽屉/模态框抢焦点 —— 前后修了八轮（抢焦点、
     * `focusin` 守卫、`inert`、防爆栈、按键兜底、退让…），全都是在一场
     * **赢不了**的争夺里优化打法。
     *
     * Orca 的做法是：页面侧注入脚本**不创建任何输入控件**
     * （`grab-guest-overlay-script.ts`），注释 UI 在**它自己的渲染进程**里
     * （`browser-page-annotation-tray.tsx` 的 `<textarea autoFocus>`）。
     * 两个不同的文档 —— 页面里的焦点陷阱碰不到它，所以**根本没有那场争夺**。
     *
     * ## 为什么是侧边面板，而不是独立小窗口
     *
     * 第一版开的是 `chrome.windows.create({type:'popup'})`。功能对，但真机上
     * 它带着一圈操作系统标题栏（最小化/最大化/关闭），用户反馈：
     * "我不希望用户能感觉到这是一个独立的浏览器弹窗。"
     *
     * 查过 Chromium 的 API 定义：`frameless` / `titleBar` / `borderless`
     * 这些词在 `windows.json` 里**一次都没出现** —— 扩展 API 造不出无边框窗口。
     *
     * 而**侧边面板本来就是我们自己的文档**，没有窗口边框，而且用户是从面板点
     * 「元素注释」才开始框选的 —— 它一定是开着的。
     *
     * ## 顺序：先抽好，再交给面板
     *
     * 元素此刻**还活着**（用户刚点上去），所以在这里就把 payload 抽完、存好。
     * 等用户写完注释回来时，页面上那个元素可能早就没了
     * （hover 浮层、SPA 重渲染），那时再抽就晚了。
     */
    if (message.awaitComment === true) {
      /*
       * 上一个还没写完就再点一个元素 → 直接**替换**掉。
       *
       * `chrome.storage.session` 只有一份暂存，不处理的话先那个的 payload 会被
       * 悄悄覆盖，提交时落的是后一个。选"替换"而不是"拒绝"：
       * 用户点第二个元素，本意就是要改主意。
       */
      const previous = await readPendingAnnotation()
      if (previous) {
        await notifyAnnotationEnded(previous.tabId)
        await chrome.storage.session.remove(PENDING_ANNOTATION_KEY)
      }

      /** @type {any} */
      let prepared = null
      try {
        const thumbnail = hasScreenshot ? await ns.createThumbnail(screenshot.dataUrl) : null
        const record = ns.createRecord(sanitized.payload)
        record.thumbnail = thumbnail
        // 注释留空 —— 由面板那边的输入框补上。
        record.comment = null
        prepared = {
          record,
          tabId: context.tab ? context.tab.id : null,
          label: describePendingTarget(sanitized.payload)
          /*
           * ⚠️ 这里**故意不预格式化文本**。
           *
           * 原来存了一份 `text`（点击那一刻格式化的），提交时直接拿它去写剪贴板。
           * 但那一刻注释还没写 —— 于是自动复制出来的文本**没有 "Requested change"
           * 那一段**，而「复制全部 / 复制文本」走的是"从已落库记录重新格式化"，
           * 反而是对的。用户看到的就是"同一个东西，两条路内容不一样"。
           *
           * 现在统一在提交时格式化（见 `finishPendingAnnotation`），
           * 两条路产出同一段文本。
           */
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'prepare_failed',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }

      await chrome.storage.session.set({ [PENDING_ANNOTATION_KEY]: prepared })
      await notifyPanelOfPending(prepared)
      return { ok: true, result: { awaitingComment: true } }
    }

    try {
      const thumbnail = hasScreenshot ? await ns.createThumbnail(screenshot.dataUrl) : null
      const record = ns.createRecord(sanitized.payload)
      record.thumbnail = thumbnail
      // 注释随记录一起落库：它能随历史存活、并在导出 Markdown 时带上（spec §9.3）。
      // 走 normalizeComment 而不是直接用 —— 它负责 trim、空值转 null、按 2000 截断，
      // 与侧边面板保存评论走的是同一条清洗路径。
      record.comment = ns.normalizeComment(message.comment)
      const writeResult = await ns.appendRecord(record)
      historyDropped = writeResult.droppedCount
    } catch (error) {
      // storage 配额或 worker 回收期间的写入失败；不阻断抓取。
    }

    return {
      ok: true,
      result: {
        // 回传给内容脚本，由它在页面文档里写剪贴板。
        textForClipboard: text,
        // 截图也回传：图片剪贴板同样只能在文档上下文里写。
        screenshotDataUrl: hasScreenshot ? screenshot.dataUrl : null,
        url: sanitized.payload.page.sanitizedUrl,
        screenshotIncluded: hasScreenshot,
        screenshotNote,
        historyDropped
      }
    }
  }

  if (message && message.type === 'picker.disarm') {
    await chrome.scripting.executeScript({
      target: { tabId: message.tabId, allFrames: false },
      func: function () {
        globalThis.__EG__.disarmPicker()
      }
    })
    return { ok: true, result: { disarmed: true } }
  }

  // ---------------------------------------------------------------------------
  // 侧边面板：历史
  // ---------------------------------------------------------------------------
  // 面板不做任何存储操作，全部经这里。这样 R-8（MV3 worker 会被回收）的影响面
  // 被限制在一个上下文里，而不是散落在两处。

  if (message && message.type === 'history.list') {
    const { records, schemaMismatch } = await ns.readHistory()
    return {
      ok: true,
      result: {
        rows: records.map(ns.toListRow),
        schemaMismatch
      }
    }
  }

  if (message && message.type === 'history.detail') {
    const { records } = await ns.readHistory()
    const record = records.find(function (candidate) {
      return candidate.id === message.id
    })
    if (!record) {
      return {
        ok: false,
        error: { code: 'record_not_found', message: '该记录已不存在' }
      }
    }
    return {
      ok: true,
      result: {
        target: record.payload.target,
        ancestorPath: record.payload.ancestorPath,
        nearbyText: record.payload.nearbyText,
        page: record.payload.page
      }
    }
  }

  if (message && message.type === 'history.annotate') {
    await ns.annotateRecord(message.id, message.comment)
    return { ok: true, result: { saved: true } }
  }

  if (message && message.type === 'history.delete') {
    const result = await ns.deleteRecord(message.id)
    return { ok: true, result: { droppedCount: result.droppedCount } }
  }

  /**
   * 清空。带 `ids` 时只删这些，否则清掉全部。
   *
   * 与「导出」同一套语义：没勾选 → 清空；勾了 → 清空所选。
   * 两个按钮的行为应该一致，否则用户得记住"哪个按钮认勾选、哪个不认"。
   */
  if (message && message.type === 'history.clear') {
    const ids = Array.isArray(message.ids) ? message.ids : []
    if (ids.length > 0) {
      const result = await ns.deleteRecords(ids)
      return { ok: true, result: { cleared: false, deletedCount: result.deletedCount } }
    }
    await ns.clearHistory()
    return { ok: true, result: { cleared: true } }
  }

  if (message && message.type === 'history.export') {
    return await exportRecords(message.ids)
  }

  // ---------------------------------------------------------------------------
  // 侧边面板：重新复制
  // ---------------------------------------------------------------------------

  if (message && message.type === 'clipboard.copyText') {
    const { records } = await ns.readHistory()
    const record = records.find(function (candidate) {
      return candidate.id === message.id
    })
    if (!record) {
      return { ok: false, error: { code: 'record_not_found', message: '该记录已不存在' } }
    }
    // 只回传文本，由面板自己写剪贴板（worker 里没有 clipboard API）。
    // 用 `formatRecordAsText` 而不是直接格式化 payload —— 后者会**丢掉注释**，
    // 而"重新复制文本"的整个意义就是重拷这条记录（含它的意图）。
    return { ok: true, result: { text: ns.formatRecordAsText(record) } }
  }

  if (message && message.type === 'clipboard.copyScreenshot') {
    const { records } = await ns.readHistory()
    const record = records.find(function (candidate) {
      return candidate.id === message.id
    })
    const screenshot = record && record.payload ? record.payload.screenshot : null
    if (!screenshot || !screenshot.dataUrl) {
      return {
        ok: false,
        error: { code: 'no_screenshot', message: '这条记录没有截图' }
      }
    }
    return { ok: true, result: { dataUrl: screenshot.dataUrl } }
  }

  return {
    ok: false,
    error: { code: 'unknown_message', message: `未知消息类型：${message && message.type}` }
  }
}

/**
 * 导出。
 *
 * `ids` 为空（或不是数组）时导出**全部** —— 这是"没勾选任何记录"时的语义。
 * 用户要求按钮在这两种状态之间切换：
 *   没勾选 → 「导出全部」；勾了 → 「导出所选」。
 * 所以"空 ids"必须是一个合法输入（表示全部），而不是 `nothing_selected` 错误。
 *
 * ## 行为：导出一个**压缩包**，落到磁盘
 *
 * 用户明确要求「导出全部」就是**存到磁盘**，所以最终会走
 * `chrome.downloads.download`，而不是把内容交给剪贴板。
 *
 * 早先的版本是"进剪贴板 + 另有一颗下载按钮"。用户删掉了那颗按钮并指出
 * 导出本身就应该是存盘，于是两条路径合成一条 —— 也因此 `downloads` 权限
 * 又回到了 manifest 里（它是这个行为的前提）。
 *
 * ⚠️ 但**下载这一步不在这里做**，而是把这个 ZIP 的 base64 回给面板，由面板
 * 用 blob URL 触发下载 —— worker 里没有 `URL.createObjectURL`，只能走 data URL，
 * 而多兆的 data URL 当下载地址并不可靠。见 `exportRecords` 里的说明。
 *
 * @param {string[]|undefined} ids
 */
async function exportRecords(ids) {
  const { records } = await ns.readHistory()
  const selecting = Array.isArray(ids) && ids.length > 0

  // 保持历史本身的顺序（时间倒序），而不是勾选顺序——列表顺序就是导出顺序。
  const selected = selecting
    ? records.filter(function (record) {
        return ids.indexOf(record.id) !== -1
      })
    : records

  if (selected.length === 0) {
    return {
      ok: false,
      error: {
        code: selecting ? 'nothing_selected' : 'history_empty',
        message: selecting ? '选中的记录已不存在' : '还没有任何记录可以导出'
      }
    }
  }

  const markdown = ns.formatRecordsAsMarkdown(selected)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  /*
   * 导出成**压缩包**：一份 Markdown + 每条一张真 PNG。
   *
   * ## 为什么要打包，而不是三种更简单的做法
   *
   *  · **只导出 md、截图写一句说明** —— 就是原来那样。用户："导出 md 的截图
   *    你也要导出啊！" 导出里最要紧的就是截图，把它换成一句说明等于没导出。
   *
   *  · **把截图内联成 data URL** —— 单条还好，15 条就是 20MB 上下的 `.md`，
   *    编辑器打开就卡死（原注释里的担心是对的，只是结论下错了）。
   *
   *  · **下载 md + 若干张散图** —— 参考文件名会把 md 和图片拆到不同目录，
   *    用户拿到一个指向不存在路径的 md。而且下载条数 = 记录数 + 1，很吵。
   *
   * 打包一次下载、内容自洽、md 依旧小而可读。
   */
  const entries = []
  const encoder = new TextEncoder()
  entries.push({ name: '元素注释.md', bytes: encoder.encode(markdown) })

  selected.forEach(function (record, index) {
    const screenshot = record.payload ? record.payload.screenshot : null
    if (!screenshot || typeof screenshot.dataUrl !== 'string') {
      return
    }
    const base64 = screenshot.dataUrl.startsWith(ns.PNG_DATA_URL_PREFIX)
      ? screenshot.dataUrl.slice(ns.PNG_DATA_URL_PREFIX.length)
      : null
    if (base64 === null) {
      // 不是 PNG：跳过而不是塞一份坏数据进包（解压出来会是个打不开的图）。
      return
    }
    try {
      entries.push({
        // ⚠️ 与 Markdown 里引用的是**同一个函数**算出来的路径。
        name: ns.screenshotImageName(index),
        bytes: ns.base64ToBytes(base64)
      })
    } catch (error) {
      // 单张解不开不该让整次导出失败 —— 其余记录仍然要导出去。
    }
  })

  const zipBytes = ns.buildZip(entries)
  const filename = `element-notes-${stamp}.zip`

  /*
   * 返回 base64 让**面板**去下载，而不是在这里直接下载。
   *
   * 原因：worker 里没有 `URL.createObjectURL`（它不是文档），只能走 data URL；
   * 而多兆的 data URL 作为下载地址并不可靠。面板是个文档，能建 blob URL。
   */
  return {
    ok: true,
    result: {
      filename,
      count: selected.length,
      imageCount: entries.length - 1,
      base64: base64FromBytes(zipBytes)
    }
  }
}

/**
 * 字节 → base64。
 *
 * 不能直接 `btoa(String.fromCharCode(...bytes))`：展开成参数列表会在几万字节时
 * 就爆栈。必须分块。
 *
 * @param {Uint8Array} bytes
 */
function base64FromBytes(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  handleMessage(message, { tab: sender.tab, sender }).then(
    function (response) {
      sendResponse(response)
    },
    function (error) {
      sendResponse({
        ok: false,
        error: {
          code: 'internal_error',
          message: error instanceof Error ? error.message : String(error)
        }
      })
    }
  )
  // 返回 true 保持消息通道打开以等待异步 sendResponse。
  return true
})

// ---------------------------------------------------------------------------
// 启动时的两件事：放在**所有声明之后**
// ---------------------------------------------------------------------------
//
// 这里才调用，而不是文件开头 —— 见开头那段注释。
//
// ## 为什么还要包一层 `typeof`
//
// 这两个都是**可选的启动步骤**：`configureSidePanel` 失败最多是面板入口少一个，
// 热键注册失败最多是"要先去面板改一次键"。它们不该有能力让整个 service worker
// 注册失败 —— 那会把扩展变成一个完全不能用的东西（真机上发生过，表现为
// 「Service worker registration failed. Status code: 15」）。
//
// 包一层之后，失败模式从"整个扩展不可用"降级为"某个便利功能没生效"，
// 而后者是用户可以继续工作的状态。
//
// 注意：这不是在掩盖错误 —— 真正的错误仍会在 console 里出现，
// 只是不再顺着 load 路径把 worker 一起带走。
if (typeof configureSidePanel === 'function') {
  void configureSidePanel()
}
