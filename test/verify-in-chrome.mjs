// @ts-check
/**
 * 真浏览器验证（ticket 01）。
 *
 * ## 这个脚本验证什么、不验证什么
 *
 * 单测证明不了的一件事是：**按声明的顺序用 `chrome.scripting.executeScript({ files })`
 * 注入经典脚本后，`globalThis.__EG__` 命名空间在真实 Chrome 的隔离世界里真的装配成功**。
 * 那正是零构建方案的核心假设（决策 I-1），所以必须真跑。
 *
 * 它**不**验证扩展图标的点击路径 —— 无头模式下没有可见工具栏可以点，那是 AC-1 的
 * 手工验收项（spec §17.2 步 1–2）。这里聚焦"注入 + 装配 + 点选 + 抽取 + 复制"。
 *
 * 用法：`node test/verify-in-chrome.mjs`
 * 退出码 0 = 全部通过；非 0 = 有失败项，明细打印在 stdout。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
]

/**
 * harness 需要加载的源码 = **worker 侧文件** 与 **内容脚本** 的并集。
 *
 * - 内容脚本那一半直接读自 service worker 的 `CONTENT_SCRIPTS`，不手抄；
 * - worker 侧的 `sanitize.js` / `history-store.js` 是 harness 自己在页面里
 *   模拟 worker 的响应工厂时要用的（真实环境里它们只在 worker 里）。
 *
 * ⚠️ 原来这里是一份硬编码清单，注释还写着"与 CONTENT_SCRIPTS 一致" ——
 * 而它已经不一致了：新增 `preview-overlay.js` 时只改了源码，于是 harness 里
 * `showPreviewOverlay` 根本不存在，新加的断言直接报 "is not a function"。
 * 两份清单迟早漂移，而且漂移是**静默**的：测试照跑，只是少测了一个文件。
 */
const serviceWorkerSource = readFileSync(
  join(extensionRoot, 'src', 'background', 'service-worker.js'),
  'utf8'
)
const contentScriptsMatch = serviceWorkerSource.match(/const CONTENT_SCRIPTS = \[([\s\S]*?)\n\]/)
if (!contentScriptsMatch) {
  throw new Error('从 service-worker.js 里找不到 CONTENT_SCRIPTS')
}
const CONTENT_SCRIPTS_IN_ORDER = Array.from(
  contentScriptsMatch[1].matchAll(/'([^']+)'/g)
).map((m) => m[1])
if (CONTENT_SCRIPTS_IN_ORDER.length === 0) {
  throw new Error('CONTENT_SCRIPTS 解析出来是空的')
}

/** 只有 worker 侧才有的文件，harness 为了模拟 worker 需要它们。 */
const WORKER_ONLY_FOR_HARNESS = [
  'src/background/sanitize.js',
  'src/background/history-store.js',
  // 顺序要求：`sanitize` 与 `history-store` 必须在依赖它们的模块之前。
  // `CONTENT_SCRIPTS` 把这两个排在 `text-normalizer` 之前，所以插在那里。
  '',
  ''
].filter((v) => v !== '')

const FIRST_CONTENT_INDEX = CONTENT_SCRIPTS_IN_ORDER.findIndex((f) =>
  f.startsWith('src/content/')
)
const SCRIPT_ORDER = CONTENT_SCRIPTS_IN_ORDER.slice(0, FIRST_CONTENT_INDEX)
  .concat(WORKER_ONLY_FOR_HARNESS)
  .concat(CONTENT_SCRIPTS_IN_ORDER.slice(FIRST_CONTENT_INDEX))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`)
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function startFixtureServer() {
  const html = await readFile(join(here, 'fixture-page.html'))
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

function launchChrome(chromePath, userDataDir, extensionDir) {
  const args = [
    '--headless=new',
    `--remote-debugging-port=0`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
    'about:blank'
  ]
  return spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}

/** 从 Chrome 的 stderr 里读它实际选的调试端口。 */
function readDevToolsPort(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      reject(new Error(`未能从 Chrome 输出中读到 DevTools 端口\n${buffer}`))
    }, timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString()
      const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stderr.on('data', onData)
    child.stdout.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Chrome 提前退出，code=${code}\n${buffer}`))
    })
  })
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 端口还没起来；继续等。
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('等待页面 target 超时')
}

/** 极简 CDP 客户端，够用即可。 */
function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  let nextId = 1
  const pending = new Map()
  const eventListeners = new Map()

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(undefined))
    socket.addEventListener('error', (event) => reject(new Error(`CDP socket 错误：${event}`)))
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    if (message.method && eventListeners.has(message.method)) {
      for (const listener of eventListeners.get(message.method)) {
        listener(message.params)
      }
    }
  })

  return {
    ready,
    async send(method, params) {
      await ready
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params: params ?? {} }))
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`${method} 超时`))
          }
        }, 20000)
      })
    },
    on(method, listener) {
      if (!eventListeners.has(method)) {
        eventListeners.set(method, new Set())
      }
      eventListeners.get(method).add(listener)
    },
    close() {
      socket.close()
    }
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(
      `页面内表达式抛错：${
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      }`
    )
  }
  return result.result.value
}

async function main() {
  const chromePath = findChrome()
  if (!chromePath) {
    console.error('未找到 Chrome/Edge，跳过真浏览器验证')
    process.exit(2)
  }
  console.log(`使用浏览器：${chromePath}\n`)

  const { server, origin } = await startFixtureServer()
  const userDataDir = await mkdtemp(join(tmpdir(), 'element-grab-verify-'))
  const child = launchChrome(chromePath, userDataDir, extensionRoot)

  let cdp = null
  try {
    const port = await readDevToolsPort(child, 20000)
    const target = await waitForPageTarget(port, 15000)
    cdp = createCdpClient(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // 授予剪贴板权限，否则读回验证不了。
    await cdp.send('Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    })

    await cdp.send('Page.navigate', { url: `${origin}/fixture-page.html` })
    await new Promise((r) => setTimeout(r, 600))

    check(
      '金样例页面已加载',
      (await evaluate(cdp, 'document.title')).includes('页面元素注释'),
      await evaluate(cdp, 'document.title')
    )

    // —— 核心假设：按序注入经典脚本后命名空间装配成功 ——
    const sources = []
    for (const relative of SCRIPT_ORDER) {
      sources.push(await readFile(join(extensionRoot, relative), 'utf8'))
    }

    // 真机上 `chrome.runtime.sendMessage` 由隔离世界提供。这里在求值前装一个
    // 等价的桥：它干的事与 service worker 的 `handleMessage` 一致。
    //
    // ⚠️ 这个桥必须**逐字跟随** worker 的契约，否则它测的是一个不存在的实现。
    // 它曾经写错在这里：剪贴板写入从 worker 移到内容脚本之后，桥还在自己写剪贴板
    // （`window.__clipboardWrites.push(text)`），于是"确认路径不该写剪贴板"这条
    // 断言永远失败 —— 而失败的原因是夹具在冒充一个已经被改掉的 worker。
    //
    // 当前契约：worker 只做 sanitize + format + 截图回传，**不碰剪贴板**；
    // 文本与图片都由内容脚本在页面文档里写。
    const bootstrap = `(() => {
      window.__clipboardWrites = [];
      window.__clipboardImages = [];

      /*
       * 图片剪贴板的存根。
       *
       * 图片只能走异步剪贴板 API + ClipboardItem（没有 execCommand 退路），
       * 而 headless Chrome 里 navigator.clipboard 可能是 undefined ——
       * 不装这个存根就永远验不到"图片到底有没有被写进去"，只能验"函数被调用了"。
       */
      if (!navigator.clipboard) {
        Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
      }
      navigator.clipboard.write = async (items) => {
        for (const item of items) {
          // 真实的 ClipboardItem.types 是**属性**（sequence of DOMString），
          // 不是方法。我第一版写成 item.types()，于是报
          // "item.types is not a function" —— 那是**存根的错**，不是产品代码的错，
          // 但看起来完全像"图片根本没被复制"。
          // （本段在模板字符串里，注释不能出现反引号。）
          const types = typeof item.types === 'function' ? item.types() : item.types;
          const list = types || [];
          for (const type of list) {
            window.__clipboardImages.push(type);
          }
          /*
           * **替换**整个槽位 —— 这就是真机的行为，也是这个 bug 的核心：
           * 先写文本、再写图片 = 剪贴板里最终只剩图片。
           *
           * 读出 text/plain 表示的内容，供断言检查"文字还在不在"。
           */
          let text = null;
          if (list.includes('text/plain') && typeof item.getType === 'function') {
            const blob = await item.getType('text/plain');
            text = blob && typeof blob.text === 'function' ? await blob.text() : null;
          }
          window.__clipboardSlot = { types: list.slice(), text: text };
        }
      };
      if (typeof ClipboardItem === 'undefined') {
        globalThis.ClipboardItem = function (map) {
          this.types = () => Object.keys(map);
          this.getType = async (type) => map[type];
        };
      }
      if (!globalThis.chrome) { globalThis.chrome = {}; }
      if (!globalThis.chrome.runtime) { globalThis.chrome.runtime = {}; }

      /*
       * 捕获内容脚本注册的 onMessage 监听器。
       *
       * worker 有两条路把消息推到页面（chrome.tabs.sendMessage），而内容脚本这一侧
       * 是 chrome.runtime.onMessage。夹具只实现后者 —— 但要**真的把消息派发
       * 到监听器上**，否则"收到 grab.annotation.end 就解冻"这条路径根本没有覆盖，
       * 只能靠读代码相信它。
       *
       * （本段在模板字符串里，注释不能出现反引号。）
       */
      window.__contentMessageListeners = [];
      globalThis.chrome.runtime.onMessage = {
        addListener: (fn) => {
          window.__contentMessageListeners.push(fn);
        }
      };
      window.__sendToPage = (message) => {
        let responded = false;
        for (const fn of window.__contentMessageListeners) {
          /*
           * ⚠️ 必须**逐个调用**，不能写成 responded = responded || fn(...)。
           *
           * 逻辑或（||）会短路：第一个返回 true 的监听器之后，**其余的都不会被调用**。
           * 页面里可能同时挂着好几个模块（预览浮层、拾取器）的监听器，
           * 短路会让"消息只送达了其中一部分"，而看起来像"某个模块没响应"。
           */
          const answered = fn(message, {}, () => {});
          if (answered === true) {
            responded = true;
          }
        }
        return responded;
      };

      globalThis.chrome.runtime.sendMessage = async (message) => {
        if (message && message.type === 'grab.screenshot.request') {
          return await window.__captureVisibleTabForTest(message.rectViewport, message.devicePixelRatio);
        }
        // 「重新复制文本」：与 worker 的 clipboard.copyText 分支同一契约 ——
        // 用 formatRecordAsText，连同记录上的注释一起回。
        if (message && message.type === 'clipboard.copyText') {
          const ns = globalThis.__EG__;
          const records = window.__storedRecords || [];
          const record = records.find((r) => r.id === message.id) || records[records.length - 1];
          if (!record) {
            return { ok: false, error: { code: 'record_not_found', message: '没有匹配的记录' } };
          }
          return { ok: true, result: { text: ns.formatRecordAsText(record) } };
        }
        /*
         * 页面侧按 Esc 取消"这一笔"（用户要求：Esc 只取消选中、不退出模式）。
         *
         * 与真实 worker 的 grab.comment.cancel 契约一致：清掉暂存 → 通知页面
         * 解冻（worker 发的是 grab.annotation.end）→ 再广播给面板收起卡片。
         */
        if (message && message.type === 'grab.comment.cancel') {
          const hadPending = Boolean(window.__pendingAnnotation);
          window.__pendingAnnotation = null;
          window.__commentCancels = (window.__commentCancels || 0) + 1;
          window.__sendToPage({ type: 'grab.annotation.end' });
          return { ok: true, result: { cancelled: hadPending } };
        }

        if (!message || message.type !== 'grab.extract.request') {
          return { ok: false, error: { code: 'unknown_message', message: 'unknown' } };
        }
        const ns = globalThis.__EG__;
        const sanitized = ns.sanitizePayload(message.rawPayload);
        if (!sanitized.ok) {
          return { ok: false, error: { code: sanitized.code, message: sanitized.message } };
        }

        /*
         * ⚠️ 新契约：点选路径**先不落库**，等用户在面板里写完注释再提交。
         *
         * 内容脚本发 awaitComment:true 时，worker 只把 payload 暂存起来
         * （真实实现放在 chrome.storage.session），回一句"在等注释"。
         * 落库与剪贴板都在**面板**那一侧完成 —— 页面从此不写剪贴板。
         */
        if (message.awaitComment === true) {
          /*
           * ⚠️ 与真实 worker 的**"替换上一笔"**契约一致（service-worker.js 里
           * message.awaitComment === true 那个分支）：
           *
           *   上一个还没写完就再点一个元素 → 先给**发起上一笔的那个标签页**发
           *   grab.annotation.end（页面据此解冻并**清掉高亮**），
           *   再存新的 pending，再推给面板重渲染输入卡片。
           *
           * 少了这一步，harness 测的就是一个比真实实现更"温和"的世界：
           * 用户报的那个"注释框变了、高亮没跟着变"正是这条链路的产物。
           */
          const hadPending = Boolean(window.__pendingAnnotation);
          if (hadPending) {
            window.__annotationReplaced = (window.__annotationReplaced || 0) + 1;
            window.__sendToPage({ type: 'grab.annotation.end' });
          }
          window.__pendingAnnotation = {
            rawPayload: message.rawPayload,
            sanitized: sanitized.payload,
            anchor: message.anchor || null
          };
          window.__extractCalls = (window.__extractCalls || 0) + 1;
          return { ok: true, result: { awaitingComment: true } };
        }

        // 与 worker 的契约一致：**注释要进文本**。注释是整段上下文里唯一说明
        // "要改什么"的那一句，丢掉它等于把用户的意图扔了（真机反馈发现的缺陷）。
        const text = ns.formatGrabPayloadAsText(sanitized.payload, message.comment);
        window.__lastExtractComment = message.comment === undefined ? null : message.comment;
      // 诊断：图片没进剪贴板时用来分辨"没截图"还是"复制失败"。
      window.__lastExtractScreenshotDataUrl = (message.rawPayload && message.rawPayload.screenshot)
        ? message.rawPayload.screenshot.dataUrl
        : null;
        // 记一条"已落库的记录"，供 clipboard.copyText 走真实的 formatRecordAsText。
        window.__storedRecords = window.__storedRecords || [];
        const stored = {
          id: 'rec-' + (window.__storedRecords.length + 1),
          payload: sanitized.payload,
          comment: message.comment === undefined ? null : message.comment
        };
        window.__storedRecords.push(stored);
        window.__lastStoredRecordId = stored.id;
        const shot = sanitized.payload.screenshot;
        const hasScreenshot = Boolean(shot && shot.dataUrl);
        return {
          ok: true,
          result: {
            textForClipboard: text,
            screenshotDataUrl: hasScreenshot ? shot.dataUrl : null,
            // 诊断用：内容脚本据此判断"这次到底有没有截图可复制"。
            screenshotIncluded: hasScreenshot,
            screenshotNote: hasScreenshot ? '' : (sanitized.payload.screenshotOmittedReason || ''),
            screenshotIncluded: hasScreenshot,
            screenshotNote: hasScreenshot
              ? ''
              : sanitized.payload.screenshotOmittedReason || ''
          }
        };
      };

      const sources = ${JSON.stringify(sources)};
      for (const source of sources) { (0, eval)(source); }
      return typeof globalThis.__EG__;
    })()`
    const nsKind = await evaluate(cdp, bootstrap)
    check('注入后 globalThis.__EG__ 装配成功', nsKind === 'object', `实际：${nsKind}`)

    // —— 重复注入：退出后不该还留在框选状态（真机反馈） ——
    //
    // 用户原话："退出注释以后，鼠标还处于框选的状态，没有退出，好像是在多个页面
    // 来回切换的时候会有这个问题，此时刷新页面才可以解决。"
    //
    // 根因：`chrome.scripting.executeScript({ files })` 每次都把这些 IIFE
    // **重新执行一遍**。重新执行会覆盖 `__EG__` 上的函数，但上一份注册在 window
    // 上的监听器还挂着 —— 它们闭包住旧的 `state`。于是新的 disarm 之后，
    // 旧的那套仍然响应 pointermove，把高亮框重新挂回来。
    //
    // 这条断言复现的就是它：注入两次 → arm → disarm → 再派发 pointermove，
    // 高亮框不该回来。
    const duplicateInjection = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const api = globalThis.__EG__;

          api.disarmPicker();
          await new Promise((r) => setTimeout(r, 80));

          // ⚠️ **先进入模式，再重新注入。**
          //
          // 这个顺序是必须的，也是第一版测不出问题的原因：只有在"旧实例已经
          // 注册过监听器"的时候重新注入，才会留下那套孤儿监听器。
          // 先注入再 arm 的话，旧实例从未 attach 过，自然没有泄漏 ——
          // 断言会假绿（第一版就是这样）。
          //
          // 真实场景正是这个顺序：用户正在注释模式下，切到别的页面再切回来，
          // 触发了重新注入。
          api.armPicker({});
          await new Promise((r) => setTimeout(r, 150));
          const overlayAfterArm = Boolean(document.getElementById('__eg-grab-host'));

          // 重新注入（模拟切页回来）。
          const again = ${JSON.stringify(sources)};
          for (const source of again) { (0, eval)(source); }
          const api2 = globalThis.__EG__;

          // 用**第二份**退出。
          api2.disarmPicker();
          await new Promise((r) => setTimeout(r, 150));
          const overlayAfterDisarm = Boolean(document.getElementById('__eg-grab-host'));

          // 关键一步：退出之后继续动鼠标。旧实例若还在监听，高亮会被挂回来。
          for (let i = 0; i < 5; i++) {
            window.dispatchEvent(new MouseEvent('pointermove', {
              bubbles: true, clientX: 100 + i * 10, clientY: 120
            }));
            await new Promise((r) => setTimeout(r, 30));
          }
          const overlayAfterMove = Boolean(document.getElementById('__eg-grab-host'));
          const stillArmed = api2.isPickerArmed();

          api2.disarmPicker();
          await new Promise((r) => setTimeout(r, 80));

          return JSON.stringify({
            overlayAfterArm,
            overlayAfterDisarm,
            overlayAfterMove,
            stillArmed
          });
        })()`
      )
    )
    check(
      '前置：重复注入后仍能正常进入注释模式',
      duplicateInjection.overlayAfterArm === true,
      JSON.stringify(duplicateInjection)
    )
    check(
      '【真机反馈】重复注入后退出，高亮框当场消失',
      duplicateInjection.overlayAfterDisarm === false,
      JSON.stringify(duplicateInjection)
    )
    check(
      '【真机反馈】退出后继续动鼠标，高亮框**不会**被旧实例挂回来（不用刷新页面）',
      duplicateInjection.overlayAfterMove === false && duplicateInjection.stillArmed === false,
      JSON.stringify(duplicateInjection)
    )

    // `chrome.tabs.captureVisibleTab` 只存在于扩展上下文，页面里没有。
    // 这里用 CDP 的 Page.captureScreenshot 做等价物：同样是"整屏 PNG"，
    // 且同样**不含** overlay（因为 overlay 已完成隐藏）。
    await cdp.send('Runtime.addBinding', { name: '__egCaptureVisibleTab' })
    cdp.on('Runtime.bindingCalled', (params) => {
      if (params.name !== '__egCaptureVisibleTab') {
        return
      }
      void (async () => {
        try {
          const shot = await cdp.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false
          })
          await evaluate(
            cdp,
            `window.__cdpScreenshotResolvers["${params.payload}"]?.({ ok: true, dataUrl: "data:image/png;base64,${shot.data}" }); true`
          )
        } catch (error) {
          await evaluate(
            cdp,
            `window.__cdpScreenshotResolvers["${params.payload}"]?.({ ok: false, error: String(${JSON.stringify(
              String(error)
            )}) }); true`
          )
        }
      })()
    })

    await evaluate(
      cdp,
      `(() => {
        window.__cdpScreenshotResolvers = {};
        let counter = 0;
        window.__cdpScreenshot = () => new Promise((resolve) => {
          const id = 'shot-' + (++counter);
          window.__cdpScreenshotResolvers[id] = resolve;
          globalThis.__egCaptureVisibleTab(id);
        });
        window.__captureVisibleTabForTest = async () => {
          const response = await window.__cdpScreenshot();
          if (!response || response.ok !== true) {
            return { ok: false, error: { code: 'screenshot_capture_failed', message: 'cdp failed' } };
          }
          return { ok: true, result: { dataUrl: response.dataUrl } };
        };
        return true;
      })()`
    )

    const apiCheck = await evaluate(
      cdp,
      `(() => {
        const ns = globalThis.__EG__;
        const required = ['clampStr','sliceAtCodeUnitLimit','buildSelector','extractPayload',
          'formatGrabPayloadAsText','sanitizePayload','armPicker','disarmPicker','showCapsule'];
        const missing = required.filter((n) => typeof ns[n] !== 'function');
        return JSON.stringify({ missing, budget: ns.BUDGET.selectorMaxLength });
      })()`
    )
    const api = JSON.parse(apiCheck)
    check('命名空间里所有跨文件依赖都已就位', api.missing.length === 0, `缺失：${api.missing}`)
    check('预算常量在浏览器侧可读', api.budget === 700, `selectorMaxLength=${api.budget}`)

    // —— 抽取：AC-3 的选择器唯一性 ——
    const selectorCheck = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('#cart-actions-target') || document.querySelector('.cart-actions');
        const target = document.querySelector('#submit-order');
        const selector = globalThis.__EG__.buildSelector(target);
        const matches = document.querySelectorAll(selector).length;
        const repeated = globalThis.__EG__.buildSelector(document.querySelectorAll('.review-order')[1]);
        const repeatedMatches = document.querySelectorAll(repeated).length;
        return JSON.stringify({ selector, matches, repeated, repeatedMatches });
      })()`
    )
    const sel = JSON.parse(selectorCheck)
    check(
      'AC-3：带 id 的元素选择器恰好命中 1 个',
      sel.matches === 1,
      `selector=${sel.selector} matches=${sel.matches}`
    )
    check(
      'AC-3：重复 class 的元素靠 :nth-of-type 消歧后仍恰好命中 1 个',
      sel.repeatedMatches === 1,
      `selector=${sel.repeated} matches=${sel.repeatedMatches}`
    )

    // —— 抽取完整 payload ——
    const payloadCheck = await evaluate(
      cdp,
      `(() => {
        const target = document.querySelector('#submit-order');
        const payload = globalThis.__EG__.extractPayload(target);
        return JSON.stringify({
          hasTag: payload.target.tagName === 'button',
          selector: payload.target.selector,
          rounded: Math.round(payload.target.rectViewport.width) + 'x' + Math.round(payload.target.rectViewport.height),
          styleKeys: Object.keys(payload.target.computedStyles).length,
          accessibleName: payload.target.accessibility.accessibleName,
          nearbyCount: payload.nearbyText.length,
          url: payload.page.sanitizedUrl,
          htmlHasButton: payload.target.htmlSnippet.includes('<button'),
          sourceFile: payload.target.sourceFile
        });
      })()`
    )
    const payload = JSON.parse(payloadCheck)
    check('抽取：tagName 正确', payload.hasTag)
    check('抽取：16 项计算样式齐全', payload.styleKeys === 16, `实际 ${payload.styleKeys}`)
    check(
      '抽取：可访问名来自 aria-label',
      payload.accessibleName === 'Submit order',
      payload.accessibleName
    )
    check('抽取：邻近文本已采集', payload.nearbyCount > 0, `条数=${payload.nearbyCount}`)
    check(
      '抽取：页面 URL 已去掉 query/fragment',
      !payload.url.includes('?') && !payload.url.includes('#'),
      payload.url
    )
    check('抽取：HTML 片段含目标元素', payload.htmlHasButton)
    check(
      'I-3 前提：ticket 05 之前 sourceFile 为 null（格式化器将输出诚实缺省）',
      payload.sourceFile === null,
      String(payload.sourceFile)
    )

    // —— 文本格式化器 ——
    const textCheck = await evaluate(
      cdp,
      `(() => {
        const target = document.querySelector('#submit-order');
        const text = globalThis.__EG__.formatGrabPayloadAsText(
          globalThis.__EG__.extractPayload(target)
        );
        return JSON.stringify({
          head: text.split('\\n')[0],
          hasSelector: text.includes('Selector: '),
          hasSourceDefault: text.includes('Source: (not available on this page)'),
          hasDimensions: /Dimensions: \\d+x\\d+/.test(text),
          hasHtml: text.includes('HTML:'),
          hasTestContent: text.includes('Text content:')
        });
      })()`
    )
    const text = JSON.parse(textCheck)
    check('AC-2：文本以 Attached browser context from 开头', text.head.startsWith('Attached browser context from'), text.head)
    check('AC-2：含 Selector 段', text.hasSelector)
    check('AC-2：含 Dimensions 段', text.hasDimensions)
    check('AC-2：含 HTML 段', text.hasHtml)
    check('规格 I-3：Source 缺省行已保留并给出诚实文案', text.hasSourceDefault)
    check('AC-2：含 Text content 段', text.hasTestContent)

    // —— 空元素与超长文本（AC-20 部分）——
    const edgeCheck = await evaluate(
      cdp,
      `(() => {
        const ns = globalThis.__EG__;
        const emptyPayload = ns.extractPayload(document.querySelector('#empty-box'));
        const longPayload = ns.extractPayload(document.querySelector('#long-text'));
        const emptyText = ns.formatGrabPayloadAsText(emptyPayload);
        return JSON.stringify({
          emptyOk: emptyPayload.target.tagName === 'div',
          emptyNoBlankHeading: !/Text content:\\n\\n/.test(emptyText) && !/HTML:\\n\\n/.test(emptyText),
          longLen: longPayload.target.textSnippet.length,
          longTruncated: longPayload.target.textSnippet.endsWith('(truncated)')
        });
      })()`
    )
    const edge = JSON.parse(edgeCheck)
    check('AC-20：空 div 仍产出合法 payload', edge.emptyOk)
    check('AC-20：空字段不产生空标题行', edge.emptyNoBlankHeading)
    check(
      'AC-20：超长文本被截断并带后缀',
      edge.longTruncated && edge.longLen <= 220,
      `长度=${edge.longLen} truncated=${edge.longTruncated}`
    )

    // —— 拾取器 UX：overlay 挂载、真实鼠标事件、Esc 清理（ticket 02）——
    await evaluate(cdp, `globalThis.__EG__.armPicker({}); true`)
    check('抓取模式已进入', (await evaluate(cdp, `globalThis.__EG__.isPickerArmed()`)) === true)
    check(
      'AC-1：overlay 已挂载到页面',
      (await evaluate(cdp, `globalThis.__EG__.isOverlayMounted()`)) === true
    )

    /** 用 CDP 派发真实鼠标事件（真实浏览器路径，不是合成事件）。 */
    const dispatchMouse = (type, x, y, button) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: button ?? 'none',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0
      })

    /**
     * 滚轮。
     *
     * CDP **要求**显式给出 `deltaX`/`deltaY` —— 不传会直接报
     * `'deltaX' and 'deltaY' are expected for mouseWheel event`，
     * 而错误信息里看不出"你漏了参数"，看起来像事件本身不支持。
     *
     * @param {number} x
     * @param {number} y
     * @param {number} deltaY 负值 = 向上滚（放大）
     * @param {{ ctrlKey?: boolean }} [modifiers]
     */
    const dispatchWheel = (x, y, deltaY, modifiers) =>
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY,
        modifiers: modifiers && modifiers.ctrlKey ? 2 : 0
      })

    const submitBox = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const r = document.querySelector('#submit-order').getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        })()`
      )
    )

    // 移动鼠标到目标元素上 → 应有高亮框与标签（它们都在 closed shadow root 里，
    // 页面侧读不到，所以通过 overlay 自己导出的 getter 验证状态）。
    await dispatchMouse('mouseMoved', submitBox.x, submitBox.y)
    await new Promise((r) => setTimeout(r, 250))

    const hoverState = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const ns = globalThis.__EG__;
          const el = ns.getOverlayCurrentElement();
          const host = document.getElementById('__eg-grab-host');
          return JSON.stringify({
            hoveredId: el ? el.id : null,
            hostPresent: Boolean(host),
            hostAriaHidden: host ? host.getAttribute('aria-hidden') : null,
            hostPointerEvents: host ? host.style.pointerEvents : null,
            hostCursor: host ? host.style.cursor : null
          });
        })()`
      )
    )
    check(
      'AC-1：鼠标移到元素上后 overlay 认到了它',
      hoverState.hoveredId === 'submit-order',
      `实际 hovered=${hoverState.hoveredId}`
    )
    // 十字准星现在挂在根元素上（宿主不再吃事件，也就顺带不了光标）。
    const rootCursor = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const host = document.getElementById('__eg-grab-host');
          return JSON.stringify({
            crosshairOnRoot: document.documentElement.style.cursor === 'crosshair',
            pointerEventsOnHost: host ? host.style.pointerEvents : null
          });
        })()`
      )
    )
    check(
      // ⚠️ 这条断言**推翻了**早先的版本。原来它要求捕获器 `cursor:crosshair`
      // 且（隐含地）`pointer-events:all` —— 而那正是"页面收不到 hover"的成因：
      // 一个全视口、吃事件的覆盖层，会让 hover 才出现的内容永远不出现。
      //
      // 新契约：
      //   · 宿主仍然是顶层全视口（高亮框要画在上面）；
      //   · 但它**不吃指针事件**（页面必须能收到 hover）；
      //   · 十字准星改由根元素提供。
      'AC-1：捕获器是顶层的全视口元素，且**不吃指针事件**（页面能收到 hover）',
      hoverState.hostPointerEvents === 'none' &&
        rootCursor.crosshairOnRoot === true &&
        rootCursor.pointerEventsOnHost === 'none',
      JSON.stringify({ hostPointerEvents: hoverState.hostPointerEvents, ...rootCursor })
    )
    check(
      '§7.5：拾取器对可访问性树隐藏（aria-hidden）',
      hoverState.hostAriaHidden === 'true',
      String(hoverState.hostAriaHidden)
    )

    /*
     * ─────────────────────────────────────────────────────────────────────
     * 这里原本有 **700 行**"页面内弹注释框"的测试：弹框外观、取消/添加按钮的
     * 真实鼠标点击、二次确认、"用真实鼠标点添加"、hover 浮层与写注释的配合……
     *
     * 全部删掉了，因为**那个弹框没有了**。
     *
     * 输入框搬到了侧边面板 —— 页面侧从此不承载任何输入控件（Orca 的做法）。
     * 弹框的外观与交互现在由 verify-sidepanel.mjs 覆盖（那里跑的是真正的面板）。
     *
     * 页面侧剩下的责任是：**点一下 → 抽好 payload → 交给 worker**，
     * 以及注释期间把高亮框**冻结**在选中的元素上。后者见文件末尾那个段落。
     * ─────────────────────────────────────────────────────────────────────
     */

    // —— 新流程：点一下 → 抽好交给 worker → 高亮**冻结**到注释结束 ——
    //
    // 输入框搬到侧边面板之后，页面侧只剩两件事：
    //   ① 点击那一刻把 payload 抽好（元素那时还活着）并交给 worker；
    //   ② 注释期间把高亮框**冻结**在选中的元素上。
    //
    // ② 是用户明确要求的："用户注释以后 框选的区域必须要常驻显示，
    // 直到用户取消/添加完成此次注释的添加。"它同时管住两件事：
    //   · 不解冻（否则框会被移回鼠标位置）；
    //   · 不跟随 hover（否则鼠标一动框就跑了）。
    //
    // 这些都是**页面侧**的行为，只有真浏览器测得到 —— 单测够不着 overlay。
    await evaluate(
      cdp,
      `(() => {
        const api = globalThis.__EG__;
        api.disarmPicker();
        window.__pendingAnnotation = null;
        window.__extractCalls = 0;
        return true;
      })()`
    )
    await evaluate(cdp, `globalThis.__EG__.armPicker({ silent: true }); true`)
    await new Promise((r) => setTimeout(r, 200))

    const newFlowBox = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const r = document.querySelector('#submit-order').getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        })()`
      )
    )
    await dispatchMouse('mouseMoved', newFlowBox.x, newFlowBox.y, 'left')
    await new Promise((r) => setTimeout(r, 120))
    await dispatchMouse('mousePressed', newFlowBox.x, newFlowBox.y, 'left')
    await dispatchMouse('mouseReleased', newFlowBox.x, newFlowBox.y, 'left')
    await new Promise((r) => setTimeout(r, 350))

    const afterClick = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          // shadow root 是 closed 的，页面读不到高亮框 —— 用 overlay 导出的探针。
          const probe = globalThis.__EG__.__overlayHighlightProbe();
          return JSON.stringify({
            extractCalls: window.__extractCalls || 0,
            pendingSelector: window.__pendingAnnotation
              ? window.__pendingAnnotation.sanitized.target.selector
              : null,
            frozen: probe.frozen,
            highlightVisible: probe.visible
          });
        })()`
      )
    )

    // 鼠标移开 —— 冻结的意义就在这里：框不该跟着跑。
    await dispatchMouse('mouseMoved', 5, 600, 'left')
    await new Promise((r) => setTimeout(r, 250))
    const afterMouseAway = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const probe = globalThis.__EG__.__overlayHighlightProbe();
          const target = document.querySelector('#submit-order').getBoundingClientRect();
          const rect = probe.rect;
          return JSON.stringify({
            frozen: probe.frozen,
            highlightVisible: probe.visible,
            // 框还贴在**当初选中的那个元素**上（而不是鼠标下面那个）。
            stillOnSelected:
              Boolean(rect) &&
              Math.abs(rect.left - target.left) < 3 &&
              Math.abs(rect.top - target.top) < 3
          });
        })()`
      )
    )

    check(
      '【新流程】点一下就把 payload 交给 worker（带 awaitComment，页面不再直接落库）',
      afterClick.extractCalls === 1 &&
        typeof afterClick.pendingSelector === 'string' &&
        afterClick.pendingSelector.length > 0,
      JSON.stringify(afterClick)
    )
    check(
      '【用户要求】点完之后高亮框**冻结**着（注释期间常驻显示）',
      afterClick.frozen === true && afterClick.highlightVisible === true,
      JSON.stringify(afterClick)
    )
    check(
      '【用户要求】鼠标移开后高亮框**不跟着跑**，仍贴在选中的那个元素上',
      afterMouseAway.frozen === true &&
        afterMouseAway.highlightVisible === true &&
        afterMouseAway.stillOnSelected === true,
      JSON.stringify(afterMouseAway)
    )

    // 注释结束 → worker 通知页面解冻（真实链路：面板提交/取消 → tabs.sendMessage）。
    const afterEnd = JSON.parse(
      await evaluate(
        cdp,
        `JSON.stringify({
          listeners: (window.__contentMessageListeners || []).length,
          delivered: window.__sendToPage({ type: 'grab.annotation.end' })
        })`
      )
    )
    await new Promise((r) => setTimeout(r, 200))
    const afterRelease = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const probe = globalThis.__EG__.__overlayHighlightProbe();
          return JSON.stringify({ frozen: probe.frozen, visible: probe.visible });
        })()`
      )
    )
    check(
      '【用户要求】注释结束后高亮框解冻（不会留下僵尸框）',
      afterEnd.listeners > 0 && afterEnd.delivered === true && afterRelease.frozen === false,
      JSON.stringify({ afterEnd, afterRelease })
    )

    await evaluate(
      cdp,
      `(() => {
        globalThis.__EG__.disarmPicker();
        window.__pendingAnnotation = null;
        return true;
      })()`
    )
    await new Promise((r) => setTimeout(r, 150))

    /*
     * —— 注释待写期间又点了另一个元素（真机反馈）——
     *
     * 用户原话："假设我目前已经框选了某个元素 但是我此时鼠标又点击了另一个地方
     * 但是框选的高亮区域没有跟着改变 注释框的内容倒是改变了"
     *
     * 注释框（侧边面板顶部那张输入卡片）与页面里的高亮框是**同一个选中状态的两个
     * 视图**。不管实现最终选哪条语义（跟随新的选择 / 拒绝这次点击），两边必须指向
     * **同一个元素** —— 一边说 A、另一边说 B 是纯粹的坏状态：用户看着注释框写着 B、
     * 页面上高亮的却是 A，写完提交到底落到谁身上无法预期。
     */
    await evaluate(
      cdp,
      `(() => {
        window.__extractCalls = 0;
        window.__pendingAnnotation = null;
        /*
         * 监听胶囊文案。
         *
         * 被忽略的那一击**必须给用户一句话** —— 否则"点了没反应"在用户眼里
         * 就是坏了。胶囊住在 closed shadow root 里，页面读不到它的文字，
         * 所以这里在 showCapsule 外面裹一层记录。只是读，不改行为。
         */
        window.__capsuleLog = [];
        const ns = globalThis.__EG__;
        if (typeof ns.showCapsule === 'function' && !ns.showCapsule.__spied) {
          const original = ns.showCapsule;
          const spy = function (message, tone) {
            window.__capsuleLog.push({ message, tone });
            return original(message, tone);
          };
          spy.__spied = true;
          ns.showCapsule = spy;
        }
        globalThis.__EG__.armPicker({ silent: true });
        return true;
      })()`
    )
    await new Promise((r) => setTimeout(r, 150))

    /** 点某个选择器命中的元素（真实鼠标事件），并等注释流程走完。 */
    const clickSelector = async (selector) => {
      const point = JSON.parse(
        await evaluate(
          cdp,
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            const r = el.getBoundingClientRect();
            return JSON.stringify({
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2)
            });
          })()`
        )
      )
      await dispatchMouse('mouseMoved', point.x, point.y, 'left')
      await new Promise((r) => setTimeout(r, 120))
      await dispatchMouse('mousePressed', point.x, point.y, 'left')
      await dispatchMouse('mouseReleased', point.x, point.y, 'left')
      await new Promise((r) => setTimeout(r, 320))
    }

    /** 一次快照：注释框那侧认的元素 vs 高亮框那侧认的元素。 */
    const selectionViews = async () =>
      JSON.parse(
        await evaluate(
          cdp,
          `(() => {
            const probe = globalThis.__EG__.__overlayHighlightProbe();
            const pending = window.__pendingAnnotation;
            return JSON.stringify({
              extractCalls: window.__extractCalls || 0,
              annotationBoxSelector: pending ? pending.sanitized.target.selector : null,
              highlightSelector: probe.frozenSelector || probe.currentSelector,
              frozen: probe.frozen,
              visible: probe.visible,
              // 真实 worker 在收到"第二笔"时会替换上一笔并通知页面结束（见 shim 注释）。
              annotationReplaced: window.__annotationReplaced || 0
            });
          })()`
        )
      )

    await clickSelector('#submit-order')
    const afterSelectA = await selectionViews()
    await clickSelector('.review-order')
    const afterSelectB = await selectionViews()
    const capsuleAfterIgnoredClick = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const log = window.__capsuleLog || [];
          return JSON.stringify(log[log.length - 1] || null);
        })()`
      )
    )

    check(
      '【真机反馈】注释待写期间又点另一个元素：这一击被忽略，注释框与高亮都停在原来那个元素上',
      /*
       * 用户原话："假设我目前已经框选了某个元素 但是我此时鼠标又点击了另一个地方
       * 但是框选的高亮区域没有跟着改变 注释框的内容倒是改变了。"
       *
       * 用户在两条语义里选了"**忽略这次点击**"：注释还没写完就不该再选别的元素。
       * 所以这条断言钉四件事，任何一条塌了都会重新变成他看到的那个坏状态：
       *
       *   1. `extractCalls` 不增长 —— 没有第二次抽取（点击没被当成新的选择）；
       *   2. `annotationReplaced === 0` —— 没有触发 worker 的"替换上一笔"，
       *      也就没有那条会把高亮清掉、把面板输入框清空的 `grab.annotation.end`；
       *   3. 注释框认的元素没变；
       *   4. 高亮框**还在、还冻结着、还在同一个元素上**。
       */
      afterSelectB.extractCalls === afterSelectA.extractCalls &&
        afterSelectB.annotationReplaced === 0 &&
        afterSelectB.annotationBoxSelector === afterSelectA.annotationBoxSelector &&
        afterSelectB.highlightSelector === afterSelectA.highlightSelector &&
        afterSelectB.frozen === true &&
        afterSelectB.visible === true,
      JSON.stringify({ afterSelectA, afterSelectB })
    )

    check(
      '【真机反馈】忽略那一击时要给一句话（否则"点了没反应"就是坏了）',
      Boolean(capsuleAfterIgnoredClick) &&
        String(capsuleAfterIgnoredClick.message).includes('注释还没写完'),
      JSON.stringify(capsuleAfterIgnoredClick)
    )

    await evaluate(
      cdp,
      `(() => {
        globalThis.__EG__.disarmPicker();
        window.__pendingAnnotation = null;
        return true;
      })()`
    )
    await new Promise((r) => setTimeout(r, 150))

    /*
     * —— 选中之后按 Esc（真机反馈）——
     *
     * 用户原话："当我选中元素以后 按下 esc 直接退出了元素注释 我觉得这样肯定是错误的。
     * esc 只控制是否取消当前选中的高亮区域，不支持通过 esc 键退出元素注释。"
     *
     * 语义上"取消这一笔注释、保留模式"**早就存在**：worker 的 `grab.comment.cancel`
     * （清 pending → 通知页面解冻 → 模式不变），面板的「取消」按钮走的就是它。
     * 页面里那条 Esc 却走 `disarm()` —— 整个模式一起关掉，这才是用户看到的现象。
     */
    await evaluate(
      cdp,
      `(() => {
        window.__pendingAnnotation = null;
        window.__extractCalls = 0;
        globalThis.__EG__.armPicker({ silent: true });
        return true;
      })()`
    )
    await new Promise((r) => setTimeout(r, 150))
    await clickSelector('#submit-order')
    const beforeEscWithSelection = await selectionViews()
    await evaluate(
      cdp,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`
    )
    await new Promise((r) => setTimeout(r, 300))
    const afterEscWithSelection = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const probe = globalThis.__EG__.__overlayHighlightProbe();
          return JSON.stringify({
            armed: globalThis.__EG__.isPickerArmed(),
            state: globalThis.__EG__.pickerState(),
            overlayMounted: globalThis.__EG__.isOverlayMounted(),
            highlightVisible: probe.visible,
            frozen: probe.frozen,
            commentCancels: window.__commentCancels || 0,
            pendingCleared: window.__pendingAnnotation === null
          });
        })()`
      )
    )
    const capsuleAfterEsc = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const log = window.__capsuleLog || [];
          return JSON.stringify(log[log.length - 1] || null);
        })()`
      )
    )

    check(
      '【真机反馈】选中之后按 Esc：只取消这次选中，**不退出**元素注释模式',
      beforeEscWithSelection.frozen === true &&
        afterEscWithSelection.armed === true &&
        afterEscWithSelection.state === 'armed' &&
        afterEscWithSelection.overlayMounted === true &&
        afterEscWithSelection.highlightVisible === false &&
        afterEscWithSelection.frozen === false,
      JSON.stringify({ beforeEscWithSelection, afterEscWithSelection })
    )

    check(
      '【用户要求】Esc 取消的是"这一笔"：worker 收到 grab.comment.cancel，暂存清掉，提示说的是"已取消这次选择"',
      afterEscWithSelection.commentCancels === 1 &&
        afterEscWithSelection.pendingCleared === true &&
        Boolean(capsuleAfterEsc) &&
        String(capsuleAfterEsc.message).includes('已取消这次选择'),
      JSON.stringify({ afterEscWithSelection, capsuleAfterEsc })
    )

    /*
     * 取消之后**必须还能接着选下一个** —— 这才是"模式留着"的意义。
     *
     * 只断言"armed 还是 true"是不够的：`annotationInProgress` 万一没复位，
     * 模式看着是开着的，但下一次点击会被上一轮那道守卫挡掉（"注释还没写完：
     * 先点「添加」或「取消」"）—— 那是个更隐蔽的僵尸态。
     */
    await clickSelector('.review-order')
    const afterCancelThenSelect = await selectionViews()
    check(
      '【用户要求】Esc 取消之后能立刻接着点下一个元素（高亮与注释框都切到新元素）',
      afterCancelThenSelect.extractCalls === beforeEscWithSelection.extractCalls + 1 &&
        afterCancelThenSelect.annotationBoxSelector !==
          beforeEscWithSelection.annotationBoxSelector &&
        afterCancelThenSelect.frozen === true &&
        afterCancelThenSelect.visible === true,
      JSON.stringify({ beforeEscWithSelection, afterEscWithSelection, afterCancelThenSelect })
    )

    // —— Esc 退出与清理（AC-10）——
    await evaluate(cdp, `globalThis.__EG__.armPicker({ silent: true }); true`)
    await evaluate(
      cdp,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`
    )
    await new Promise((r) => setTimeout(r, 150))
    const afterEsc = JSON.parse(
      await evaluate(
        cdp,
        `JSON.stringify({
          armed: globalThis.__EG__.isPickerArmed(),
          state: globalThis.__EG__.pickerState(),
          overlayMounted: globalThis.__EG__.isOverlayMounted(),
          overlayHost: Boolean(document.getElementById('__eg-grab-host'))
        })`
      )
    )
    check('AC-10：Esc 退出抓取模式', afterEsc.armed === false && afterEsc.state === 'idle', JSON.stringify(afterEsc))
    check(
      'AC-10：Esc 后 overlay 从 DOM 中彻底移除（无残留）',
      afterEsc.overlayMounted === false && afterEsc.overlayHost === false,
      JSON.stringify(afterEsc)
    )

    // —— 跨域 iframe 提示（§6.4）——
    const crossOriginCheck = await evaluate(
      cdp,
      `(() => {
        const frame = document.createElement('iframe');
        // 同源 iframe 的 contentDocument 可读，因此不该被判为跨域。
        document.body.appendChild(frame);
        const sameOrigin = globalThis.__EG__.isInsideCrossOriginFrame({
          composedPath: () => [frame, document.body, document, window]
        });
        frame.remove();
        // 用一个 contentDocument 为 null 的假 iframe 模拟跨域。
        const fake = { contentDocument: null };
        Object.setPrototypeOf(fake, HTMLIFrameElement.prototype);
        const crossOrigin = globalThis.__EG__.isInsideCrossOriginFrame({
          composedPath: () => [fake, document.body, document, window]
        });
        return JSON.stringify({ sameOrigin, crossOrigin });
      })()`
    )
    const crossOrigin = JSON.parse(crossOriginCheck)
    check(
      '§6.4：同源 iframe 不被误判为跨域',
      crossOrigin.sameOrigin === false,
      String(crossOrigin.sameOrigin)
    )
    check(
      '§6.4：跨域 iframe（contentDocument 为 null）被识别',
      crossOrigin.crossOrigin === true,
      String(crossOrigin.crossOrigin)
    )

    // —— Shadow DOM：真实目标从 composedPath 取，而不是重定向后的 target ——
    // 必须在**派发期间的捕获阶段**验证：事件派发结束后 composedPath() 会返回空数组，
    // 那时只能退回到已被重定向为 shadow host 的 event.target。
    const shadowCheck = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const shadowButton = document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-btn');
          let result = null;
          const probe = (event) => {
            const resolved = globalThis.__EG__.resolvePickerEventTarget(event);
            result = {
              resolvedId: resolved ? resolved.id : null,
              insideShadowRoot: Boolean(
                resolved && resolved.getRootNode && resolved.getRootNode().host
              ),
              retargetedTargetId: event.target ? event.target.id : null,
              pathLength: typeof event.composedPath === 'function' ? event.composedPath().length : -1
            };
          };
          window.addEventListener('pointerdown', probe, true);
          try {
            shadowButton.dispatchEvent(
              new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true })
            );
          } finally {
            window.removeEventListener('pointerdown', probe, true);
          }
          return JSON.stringify(result);
        })()`
      )
    )
    check(
      '§14.4：Shadow DOM 内部元素被解析为真实目标（而非重定向后的 host）',
      shadowCheck.resolvedId === 'shadow-btn' && shadowCheck.insideShadowRoot === true,
      JSON.stringify(shadowCheck)
    )
    check(
      '§14.4：对照项 —— 该事件的 event.target 确实已被重定向为 shadow host',
      shadowCheck.retargetedTargetId === 'shadow-host',
      JSON.stringify(shadowCheck)
    )

    // —— 安全边界：在真实页面上验证脱敏（AC-6 / AC-7 / AC-8）——
    // 这三条只有跑在真实 DOM 上才算证据：金样例页面里放了真的密码框、
    // 真的带 userinfo 与 token 的链接、真的用 .secret-banner 命名的元素。
    const redactionCheck = await evaluate(
      cdp,
      `(() => {
        const ns = globalThis.__EG__;

        // AC-6：密码框。值 hunter2-super-secret 本身不含任何机密词汇，
        // 因此只有"按 type 属性剥离"这条规则能挡住它。
        const pwRaw = ns.extractPayload(document.querySelector('#pw'));
        const pwSanitized = ns.sanitizePayload(pwRaw);
        if (!pwSanitized.ok) return JSON.stringify({ error: pwSanitized.message });
        const pwText = ns.formatGrabPayloadAsText(pwSanitized.payload);

        // AC-8：带 userinfo 与 token 的链接。
        const linkRaw = ns.extractPayload(document.querySelector('#keyed-link'));
        const linkSanitized = ns.sanitizePayload(linkRaw);
        const linkText = ns.formatGrabPayloadAsText(linkSanitized.payload);

        // AC-7：class 里含裸子串 secret 的正常元素，不该被脱敏。
        const bannerSanitized = ns.sanitizePayload(ns.extractPayload(document.querySelector('#banner')));
        const sourceCodeSanitized = ns.sanitizePayload(ns.extractPayload(document.querySelector('#source-code-note')));

        // S-3：正文含 "Password reset ..." 的段落，句子应保留。
        const proseSanitized = ns.sanitizePayload(ns.extractPayload(document.querySelector('#password-prose')));

        return JSON.stringify({
          pwLeaked: pwText.includes('hunter2-super-secret'),
          pwRedacted: pwText.includes('[redacted]'),
          pwText: pwText,
          linkLeakedUser: linkText.includes('user:pw'),
          linkLeakedToken: linkText.includes('token=xyz'),
          linkLeakedUserinfo: /https:\\/\\/[^\\s"']*@/.test(linkText),
          linkHref: linkSanitized.payload.target.attributes.href,
          bannerClasses: bannerSanitized.payload.target.cssClasses,
          sourceCodeClasses: sourceCodeSanitized.payload.target.cssClasses,
          proseText: proseSanitized.payload.target.textSnippet
        });
      })()`
    )
    const redaction = JSON.parse(redactionCheck)

    check(
      'AC-6：真实密码框的值不出现在待复制文本里',
      redaction.pwLeaked === false,
      redaction.pwLeaked ? redaction.pwText.slice(0, 400) : ''
    )
    check('AC-6：密码位置留下了 [redacted] 标记', redaction.pwRedacted === true)
    check(
      'AC-8：带 userinfo 与 token 的链接未泄漏 user/pw/token',
      !redaction.linkLeakedUser && !redaction.linkLeakedToken && !redaction.linkLeakedUserinfo,
      `href=${redaction.linkHref}`
    )
    check(
      'AC-8：净化后的 href 只留协议与路径',
      redaction.linkHref === 'https://example.com/api/keys/abc123',
      String(redaction.linkHref)
    )
    check(
      'AC-7：class="secret-banner" 未被脱敏',
      redaction.bannerClasses === 'secret-banner',
      String(redaction.bannerClasses)
    )
    check(
      'AC-7：class="source-code" 未被脱敏',
      redaction.sourceCodeClasses === 'source-code',
      String(redaction.sourceCodeClasses)
    )
    check(
      'S-3：正文句子保留，仅替换孤立的凭据词',
      typeof redaction.proseText === 'string' &&
        redaction.proseText.includes('reset is available') &&
        redaction.proseText.startsWith('[redacted]'),
      String(redaction.proseText)
    )

    // —— 截图（ticket 04）——
    // 这一段的核心是证明两件事：截图真的产出了、且**没有把 overlay 拍进去**。
    const screenshotCheck = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const ns = globalThis.__EG__;
          ns.disarmPicker();
          window.__clipboardImages.length = 0;

          const target = document.querySelector('#submit-order');
          const expected = target.getBoundingClientRect();
          const beforeClicks = window.__fixtureClicks.length;

          const result = await ns.extractWithScreenshot(target);
          const shot = result.raw.screenshot;

          if (!shot) {
            return JSON.stringify({ produced: false, omittedReason: result.screenshotNote });
          }

          // 读回裁剪后的图像，检查尺寸并采样像素。
          const bitmap = await createImageBitmap(await (await fetch(shot.dataUrl)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);

          const sample = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
          // 采样中心像素：#submit-order 的填充色是 rgb(37,99,235)。
          const center = sample(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2));
          const btnStyles = getComputedStyle(target);
          const centerIsElementFill = center[2] > center[0] && center[2] > 100 && center[3] > 200;
          const computedBackground = btnStyles.backgroundColor;

          const width = bitmap.width;
          const height = bitmap.height;
          bitmap.close();

          return JSON.stringify({
            produced: true,
            width,
            height,
            dpr: window.devicePixelRatio || 1,
            expectedWidth: Math.round(expected.width),
            expectedHeight: Math.round(expected.height),
            prefixOk: shot.dataUrl.startsWith('data:image/png;base64,'),
            center,
            centerIsElementFill,
            computedBackground,
            pageSawClick: window.__fixtureClicks.length - beforeClicks,
            overlayRestored: !globalThis.__EG__.isOverlaySuppressed()
          });
        })()`
      )
    )

    check('AC-4：元素截图已产出', screenshotCheck.produced === true, JSON.stringify(screenshotCheck))
    check(
      'AC-4：截图是合法的 PNG data URL',
      screenshotCheck.prefixOk === true,
      String(screenshotCheck.prefixOk)
    )
    check(
      '§14.10：截图尺寸按 devicePixelRatio 换算后与元素 CSS 尺寸一致',
      screenshotCheck.width === Math.round(screenshotCheck.expectedWidth * screenshotCheck.dpr) &&
        screenshotCheck.height === Math.round(screenshotCheck.expectedHeight * screenshotCheck.dpr),
      `实际 ${screenshotCheck.width}x${screenshotCheck.height}，期望 ${screenshotCheck.expectedWidth}x${screenshotCheck.expectedHeight} @${screenshotCheck.dpr}x`
    )
    // 判据说明：截的是 #submit-order，它的 background 是 rgb(37,99,235)。
    // 白底页面上"四角是白色"本身没有判别力（页面背景就是白的），
    // 所以这里改为采样**元素中心的填充色**——只有真的截到了这个元素才会是蓝色。
    check(
      'AC-4：截图内容确实是目标元素（中心像素为按钮的填充色，而非页面背景）',
      screenshotCheck.centerIsElementFill === true,
      `中心像素=${JSON.stringify(screenshotCheck.center)}`
    )
    check(
      '截图流程结束后 overlay 已恢复（不会把抓取模式卡在隐藏状态）',
      screenshotCheck.overlayRestored === true,
      String(screenshotCheck.overlayRestored)
    )
    check(
      '截图流程本身不产生页面点击',
      screenshotCheck.pageSawClick === 0,
      `页面观察到 ${screenshotCheck.pageSawClick} 次`
    )

    // —— 对照实验：证明"截图前隐藏 overlay"这一步是必需的 ——
    // 先让 overlay 真的画出高亮框（挂载 + 一次悬停命中），再对比抑制前后的截图。
    // 之前那版对照没有区分度，因为 picker 已被 disarm、overlay 根本没挂在页面上。
    const overlayBox = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const r = document.querySelector('#submit-order').getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        })()`
      )
    )
    await evaluate(cdp, `globalThis.__EG__.armPicker({ silent: true }); true`)
    await dispatchMouse('mouseMoved', overlayBox.x, overlayBox.y)
    await new Promise((r) => setTimeout(r, 200))
    check(
      '对照实验前提：overlay 已挂载并认到了目标元素',
      (await evaluate(cdp, `Boolean(globalThis.__EG__.getOverlayCurrentElement())`)) === true
    )

    const contrastCheck = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const ns = globalThis.__EG__;
          const target = document.querySelector('#submit-order');

          const sampleCenter = async () => {
            const rect = target.getBoundingClientRect();
            const response = await globalThis.chrome.runtime.sendMessage({
              type: 'grab.screenshot.request',
              rectViewport: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
              devicePixelRatio: window.devicePixelRatio || 1
            });
            const bitmap = await createImageBitmap(await (await fetch(response.result.dataUrl)).blob());
            const cropped = await ns.cropScreenshot(bitmap, rect, window.devicePixelRatio || 1);
            bitmap.close();
            if (!cropped.ok) return null;
            const bmp2 = await createImageBitmap(await (await fetch(cropped.dataUrl)).blob());
            const canvas = new OffscreenCanvas(bmp2.width, bmp2.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bmp2, 0, 0);
            // 采样高亮框描边所在的位置：框的左上角内边。
            const px = Array.from(ctx.getImageData(1, 1, 1, 1).data);
            const center = Array.from(
              ctx.getImageData(Math.floor(bmp2.width / 2), Math.floor(bmp2.height / 2), 1, 1).data
            );
            bmp2.close();
            return { edge: px, center };
          };

          ns.setOverlaySuppressed(false); // 故意让高亮框可见
          await new Promise((r) => setTimeout(r, 80));
          const withOverlay = await sampleCenter();

          ns.setOverlaySuppressed(true);  // 正确做法：隐藏后再截
          await new Promise((r) => setTimeout(r, 80));
          const withoutOverlay = await sampleCenter();

          ns.setOverlaySuppressed(false);
          ns.disarmPicker();
          return JSON.stringify({ withOverlay, withoutOverlay });
        })()`
      )
    )
    check(
      '对照实验：overlay 可见时截到的边缘像素与隐藏后不同（证明隐藏这一步真的起作用）',
      JSON.stringify(contrastCheck.withOverlay) !== JSON.stringify(contrastCheck.withoutOverlay),
      `withOverlay=${JSON.stringify(contrastCheck.withOverlay)} withoutOverlay=${JSON.stringify(
        contrastCheck.withoutOverlay
      )}`
    )

    // —— 视口外元素：自动滚动后仍能截到（AC-5）——
    const farCheck = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const ns = globalThis.__EG__;
          const target = document.querySelector('#far-button');
          const before = target.getBoundingClientRect();
          const beforeInViewport = ns.isFullyInsideViewport(
            { x: before.left, y: before.top, width: before.width, height: before.height },
            window.innerWidth,
            window.innerHeight
          );
          const result = await ns.extractWithScreenshot(target);
          const after = target.getBoundingClientRect();
          const afterInViewport = ns.isFullyInsideViewport(
            { x: after.left, y: after.top, width: after.width, height: after.height },
            window.innerWidth,
            window.innerHeight
          );
          return JSON.stringify({
            beforeInViewport,
            afterInViewport,
            produced: Boolean(result.raw.screenshot),
            omittedReason: result.screenshotNote,
            scrollY: window.scrollY
          });
        })()`
      )
    )
    check(
      'AC-5 前提：目标元素初始确实在视口外',
      farCheck.beforeInViewport === false,
      JSON.stringify(farCheck)
    )
    check(
      'AC-5：自动滚动到元素后它完全进入视口',
      farCheck.afterInViewport === true,
      JSON.stringify(farCheck)
    )
    check(
      'AC-5：视口外元素滚动后成功截到图',
      farCheck.produced === true,
      `omittedReason=${farCheck.omittedReason}`
    )

    // —— 视口外且不可达：诚实降级，不假报成功（AC-5 后半 + §13）——
    const unreachableCheck = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const ns = globalThis.__EG__;
          // 造一个"很高、滚不到完全可见"的元素：body 加一个禁止滚动的高度。
          const blocker = document.createElement('div');
          blocker.id = 'tall-blocker';
          blocker.style.cssText = 'position:fixed;inset:0;overflow:hidden;';
          const tall = document.createElement('div');
          tall.style.cssText = 'height:20000px;';
          blocker.appendChild(tall);
          document.documentElement.appendChild(blocker);

          const probe = document.createElement('div');
          probe.id = 'unreachable-probe';
          probe.style.cssText = 'height:50000px;';
          tall.appendChild(probe);

          const captured = await ns.captureElementScreenshot(probe);
          blocker.remove();
          return JSON.stringify({
            produced: Boolean(captured.screenshot),
            omittedReason: captured.omittedReason
          });
        })()`
      )
    )
    check(
      'AC-5 后半：不可达时报告 element_not_visible，而不是给一张残缺图',
      unreachableCheck.produced === false &&
        unreachableCheck.omittedReason === 'element_not_visible',
      JSON.stringify(unreachableCheck)
    )

    // —— 连续抓取 10 个元素：验证串行化与退避（R-1）——
    const burstCheck = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const ns = globalThis.__EG__;
          window.__clipboardWrites.length = 0;
          window.__clipboardImages.length = 0;
          const targets = [
            '#submit-order', '.cart-total', '.cart-delivery', '#banner',
            '#source-code-note', '#password-prose', '#empty-box', '#keyed-link',
            '#cart', '#long-text'
          ];
          let produced = 0;
          let omitted = 0;
          for (const selector of targets) {
            const el = document.querySelector(selector);
            if (!el) continue;
            const r = await ns.extractWithScreenshot(el);
            if (r.raw.screenshot) produced += 1;
            else omitted += 1;
          }
          return JSON.stringify({
            attempted: targets.length,
            produced,
            omitted,
            intervalMs: interpolateInterval()
          });
          function interpolateInterval() {
            // 页面里读不到 service worker 的退避状态；这里只报告 n/a，
            // 真正的退避断言由 screenshot-crop 单测覆盖。
            return 'n/a';
          }
        })()`
      )
    )
    check(
      'R-1：连续 10 个元素全部拿到截图（串行化未丢帧）',
      burstCheck.produced === burstCheck.attempted,
      JSON.stringify(burstCheck)
    )

    // —— 源码定位的接线（ticket 05）——
    // 这里只证明"接线通了"：extractPayload 会带上源码定位的结果。
    // 真实栈的可用率（React dev vs 生产 / Vue / 约定属性）由 §19.1 的风险实测覆盖，
    // 单元测试覆盖各档的解析逻辑。
    const sourceWiring = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const ns = globalThis.__EG__;

          // 1) 真实 DOM 上：加一个带约定属性的元素，验证第 3 档端到端生效。
          const probe = document.createElement('div');
          probe.id = 'source-probe';
          probe.setAttribute('data-source', 'src/components/Probe.tsx');
          probe.textContent = 'probe';
          document.getElementById('cart').appendChild(probe);

          const withAttribute = ns.extractPayload(probe);

          // 2) 真实 DOM 上：普通元素（无 fiber / 无约定属性）应当拿到 null，
          //    而格式化器输出诚实缺省文案。
          const plain = ns.extractPayload(document.querySelector('.cart-total'));
          const plainText = ns.formatGrabPayloadAsText(plain);

          // 3) 模拟真实 React 形状的 fiber，验证第 1 档在真实 DOM 元素上生效。
          const reactTarget = document.querySelector('#submit-order');
          const fiber = {
            type: { name: 'SubmitButton' },
            _debugSource: {
              fileName: 'turbopack:///[project]/src/components/Cart.tsx',
              lineNumber: 42,
              columnNumber: 7
            },
            return: { type: { name: 'CartActions' }, return: { type: { name: 'CartPage' }, return: null } }
          };
          reactTarget['__reactFiber$verify'] = fiber;
          const withFiber = ns.extractPayload(reactTarget);
          const fiberText = ns.formatGrabPayloadAsText(withFiber);
          delete reactTarget['__reactFiber$verify'];

          probe.remove();

          return JSON.stringify({
            attributeSource: withAttribute.target.sourceFile,
            attributeComponents: withAttribute.target.reactComponents,
            plainSource: plain.target.sourceFile,
            plainHasDefaultLine: plainText.includes('Source: (not available on this page)'),
            fiberSource: withFiber.target.sourceFile,
            fiberComponents: withFiber.target.reactComponents,
            fiberTextHasSource: /Source: src\\/components\\/Cart\\.tsx:42:7/.test(fiberText),
            fiberTextHasReact: fiberText.includes('React: <CartPage> <CartActions> <SubmitButton>')
          });
        })()`
      )
    )

    check(
      '源码定位接线：约定属性 data-source 经 extractPayload 生效',
      sourceWiring.attributeSource === 'src/components/Probe.tsx',
      String(sourceWiring.attributeSource)
    )
    check(
      '源码定位接线：React fiber 经 extractPayload 生效并清理了构建前缀',
      sourceWiring.fiberSource === 'src/components/Cart.tsx:42:7',
      String(sourceWiring.fiberSource)
    )
    check(
      '源码定位接线：组件名按由外到内的层级顺序输出',
      sourceWiring.fiberComponents === '<CartPage> <CartActions> <SubmitButton>',
      String(sourceWiring.fiberComponents)
    )
    check(
      'AC-9（dev 分支）：文本里出现真实的 Source 行',
      sourceWiring.fiberTextHasSource === true
    )
    check(
      'AC-9（dev 分支）：文本里出现 React 组件层级',
      sourceWiring.fiberTextHasReact === true
    )
    check(
      'AC-9（生产分支）：拿不到源码位置时 sourceFile 为 null',
      sourceWiring.plainSource === null,
      String(sourceWiring.plainSource)
    )
    check(
      'AC-9（生产分支）：此时文本里是诚实缺省行，而不是缺行或错值',
      sourceWiring.plainHasDefaultLine === true
    )

    // —— 历史与导出（ticket 06）——
    // `chrome.storage.local` 只存在于扩展上下文，页面里没有。
    // 这里装一个内存实现（语义与真实 API 一致：get 返回对象、set 合并），
    // 走的是 history-store.js 的真实代码路径。
    const historyCheck = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const store = new Map();
          globalThis.chrome.storage = {
            local: {
              async get(keys) {
                const list = Array.isArray(keys) ? keys : [keys];
                const out = {};
                for (const key of list) { if (store.has(key)) out[key] = store.get(key); }
                return out;
              },
              async set(values) { for (const [k, v] of Object.entries(values)) store.set(k, v); }
            }
          };

          const ns = globalThis.__EG__;
          ns.disarmPicker();

          // 1) 从空历史开始。
          await ns.clearHistory();
          const empty = await ns.readHistory();

          // 2) 追加三条已脱敏的 payload。
          const targets = ['#submit-order', '.cart-total', '.cart-delivery'];
          const appendedIds = [];
          for (const selector of targets) {
            const payload = ns.sanitizePayload(ns.extractPayload(document.querySelector(selector)));
            if (!payload.ok) return JSON.stringify({ error: payload.message });
            /*
             * 给**第一条**挂一张真实截图。
             *
             * 不挂的话"导出里引用了包内的真图片"这条断言没有前提 ——
             * 它会因为"本来就没截图"而失败，而那看起来像导出坏了。
             * 用一张最小的合法 PNG：断言验的是**路径与引用**，不是像素。
             */
            payload.payload.screenshot = {
              mimeType: 'image/png',
              // 1x1 透明 PNG。
              dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
              width: 1,
              height: 1
            };
            const record = ns.createRecord(payload.payload);
            appendedIds.push(record.id);
            await ns.appendRecord(record);
          }

          const afterAppend = await ns.readHistory();

          // 3) 列表投影不带完整 payload。取"最新那条"（列表首行）而不是写死某个选择器。
          const rows = afterAppend.records.map(ns.toListRow);

          // 4) 加一条评论，然后在同一次读取里核对。
          await ns.annotateRecord(appendedIds[0], '  这个按钮太淡了 😀  ');
          const afterAnnotate = await ns.readHistory();
          const annotated = afterAnnotate.records.find((r) => r.id === appendedIds[0]);

          // 5) 导出为 Markdown。
          const markdown = ns.formatRecordsAsMarkdown(afterAnnotate.records);

          // 6) 删除一条。
          await ns.deleteRecord(appendedIds[2]);
          const afterDelete = await ns.readHistory();

          // 7) 版本不识别时丢弃重建。
          store.set('schemaVersion', 999);
          const mismatched = await ns.readHistory();

          // 8) 容量：塞 30 条，确认全部保留且总量远低于上限。
          await ns.clearHistory();
          for (let i = 0; i < 30; i++) {
            const payload = ns.sanitizePayload(ns.extractPayload(document.querySelector('#submit-order')));
            const record = ns.createRecord(payload.payload);
            await ns.appendRecord(record);
          }
          const afterThirty = await ns.readHistory();
          const totalBytes = afterThirty.records.reduce(
            (sum, r) => sum + ns.estimateRecordBytes(r), 0
          );

          return JSON.stringify({
            emptyCount: empty.records.length,
            appendedCount: afterAppend.records.length,
            // 历史保持时间倒序：最新追加的应该在最前。
            newestSelector: rows[0].selector,
            oldestSelector: rows[rows.length - 1].selector,
            rowHasPayload: 'payload' in rows[0],
            comment: annotated ? annotated.comment : null,
            // 顶层标题已按用户要求去掉（原来这里是 "## 页面：…" 那一行）。
            // 现在第一行就是第一条记录的标题。
            markdownHead: markdown.split('\\n')[0],
            markdownHasNumbering: markdown.includes('### 1.') && markdown.includes('### 2.') && markdown.includes('### 3.'),
            // 标签与「复制全部」一致 —— 原来的写法是 **反馈：**（带星号那种）。
            markdownHasFeedback: markdown.includes('**Requested change**'),
            // 导出与复制全部读同一份分节模型，所以这些节也都该出现。
            markdownHasSections:
              markdown.includes('**Selected element**') &&
              markdown.includes('**Text content**') &&
              markdown.includes('**Computed styles**') &&
              markdown.includes('**Nearby context**'),
            // 有截图时必须引用包内的真图片。
            markdownHasImage: markdown.includes('![截图](images/'),
            markdownHasEmoji: markdown.includes('😀'),
            markdownLeaksBase64: markdown.includes('AAAA'),
            markdownHasFence: markdown.includes('\\u0060\\u0060\\u0060html'),
            afterDeleteCount: afterDelete.records.length,
            mismatchCount: mismatched.records.length,
            mismatchFlag: mismatched.schemaMismatch,
            thirtyCount: afterThirty.records.length,
            thirtyBytes: totalBytes,
            maxBytes: ns.HISTORY_MAX_BYTES
          });
        })()`
      )
    )

    check('历史：初始为空', historyCheck.emptyCount === 0, JSON.stringify(historyCheck))
    check('历史：追加三条后读回三条', historyCheck.appendedCount === 3, JSON.stringify(historyCheck))
    check(
      '历史：列表投影不带完整 payload（面板渲染代价不随历史规模增长）',
      historyCheck.rowHasPayload === false,
      String(historyCheck.rowHasPayload)
    )
    check(
      '历史：列表投影带可读选择器，且最新追加的排在最前',
      typeof historyCheck.newestSelector === 'string' &&
        historyCheck.newestSelector.includes('cart-delivery') &&
        historyCheck.oldestSelector.includes('submit-order'),
      JSON.stringify({
        newest: historyCheck.newestSelector,
        oldest: historyCheck.oldestSelector
      })
    )
    check(
      '历史：评论被 trim 且 emoji 保留',
      historyCheck.comment === '这个按钮太淡了 😀',
      String(historyCheck.comment)
    )
    check(
      // 用户要求"不需要顶部的 title"—— 第一行应当就是第一条记录的标题。
      '导出：第一行就是记录标题（已按用户要求去掉顶层 title）',
      typeof historyCheck.markdownHead === 'string' &&
        historyCheck.markdownHead.startsWith('### 1.'),
      String(historyCheck.markdownHead)
    )
    check('导出：多条记录按序编号', historyCheck.markdownHasNumbering === true)
    check('导出：评论以引用块出现（标签与「复制全部」一致）', historyCheck.markdownHasFeedback === true)
    check(
      '导出：分节与「复制全部」一致（两边读同一份模型）',
      historyCheck.markdownHasSections === true,
      JSON.stringify({ hasSections: historyCheck.markdownHasSections })
    )
    check(
      '导出：有截图时引用包内的真图片，而不是写一句说明',
      historyCheck.markdownHasImage === true,
      JSON.stringify({ hasImage: historyCheck.markdownHasImage })
    )
    check('导出：emoji 原样保留', historyCheck.markdownHasEmoji === true)
    check(
      '导出：截图未内联（base64 不出现）',
      historyCheck.markdownLeaksBase64 === false,
      String(historyCheck.markdownLeaksBase64)
    )
    check('导出：HTML 用代码围栏包裹', historyCheck.markdownHasFence === true)
    check('历史：删除一条后剩两条', historyCheck.afterDeleteCount === 2, String(historyCheck.afterDeleteCount))
    check(
      '历史：schemaVersion 不识别时丢弃并按空历史重建（并置位提示标志）',
      historyCheck.mismatchCount === 0 && historyCheck.mismatchFlag === true,
      JSON.stringify({ count: historyCheck.mismatchCount, flag: historyCheck.mismatchFlag })
    )
    check(
      'AC-17：连续 30 条全部保留，且总占用远低于 8 MiB 上限',
      historyCheck.thirtyCount === 30 && historyCheck.thirtyBytes < historyCheck.maxBytes,
      JSON.stringify({ count: historyCheck.thirtyCount, bytes: historyCheck.thirtyBytes })
    )

    /*
     * ─────────────────────────────────────────────────────────────────────
     * 这里原本有"内容脚本写剪贴板"的测试（一次 ClipboardItem 带 text/plain +
     * text/html + image/png，以及那个真机 bug：先写文本再写图片会把文本盖掉）。
     *
     * 删掉了，因为**剪贴板不再由页面写**。
     *
     * 现在写完注释、点「添加」时，是**面板**（我们自己的文档）写剪贴板 ——
     * 提交那一刻它正是前台窗口，而页面可能早就导航走了。
     *
     * 那组断言（含"文字与图片必须在同一个剪贴板条目里"）已经搬到
     * verify-sidepanel.mjs，那里跑的是真正的面板。
     * ─────────────────────────────────────────────────────────────────────
     */

    // —— 选择器唯一性覆盖到所有金样例目标 ——
    const sweep = await evaluate(
      cdp,
      `(() => {
        const ids = ['cart','submit-order','pw','keyed-link','banner','source-code-note',
          'password-prose','empty-box','far-button','shadow-host'];
        const bad = [];
        for (const id of ids) {
          const el = document.getElementById(id);
          if (!el) { bad.push(id + ':missing'); continue; }
          const selector = globalThis.__EG__.buildSelector(el);
          const matches = document.querySelectorAll(selector).length;
          if (matches !== 1) bad.push(id + ':' + matches + ' via ' + selector);
        }
        return JSON.stringify(bad);
      })()`
    )
    check(
      'AC-3 加严：金样例页面上 10 个目标的选择器全部恰好命中 1 个',      JSON.parse(sweep).length === 0,
      JSON.parse(sweep).join('; ')
    )

    // —— 截图预览浮层：工具条按钮不能关掉它 + 滚轮缩放（真机反馈） ——
    //
    // 用户原话："图片预览这里面顶部那一排操作项，我无论点击哪个都会导致图片被关闭。"
    //
    // 根因：把"点空白关闭"挂在了 backdrop 上，而**工具条是 backdrop 的子元素**，
    // 事件冒泡上去就把预览关了。
    //
    // 这里用 CDP **真实鼠标事件**点击 —— 浮层内部是 closed shadow root，
    // 页面脚本拿不到它的节点，但真实事件会经过浏览器命中测试正确进入 shadow DOM。
    // 所以验的是真路径，而不是"在外部模拟一次点击"。
    const previewShot = await evaluate(
      cdp,
      `(() => {
        // 图必须够大，让"适应窗口"与"100%"确实不同 ——
        // 图太小时放大会被容器卡住，缩放断言就没有鉴别力。
        const canvas = document.createElement('canvas');
        canvas.width = 900; canvas.height = 700;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2563eb'; ctx.fillRect(0, 0, 900, 700);
        ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'; ctx.fillText('shot', 40, 90);
        const url = canvas.toDataURL('image/png');
        globalThis.__EG__.showPreviewOverlay({ dataUrl: url, width: 900, height: 700 });
        return url.length;
      })()`
    )
    check('前置：浮层能打开并拿到截图数据', typeof previewShot === 'number' && previewShot > 100)

    const previewBefore = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    check(
      '前置：工具条上的按钮都能定位到（探针拿到了坐标）',
      previewBefore.open === true &&
        Boolean(previewBefore.zoomIn) &&
        Boolean(previewBefore.zoomOut) &&
        Boolean(previewBefore.closeButton),
      JSON.stringify(previewBefore)
    )

    // 点「放大」按钮 —— 它**不该**关闭浮层。
    //
    // `button` 必须显式给 `'left'`：CDP 在 `'none'` 下会派发 press/release，
    // 但**不会合成 DOM `click`** —— 而按钮的处理器挂在 `click` 上。
    // 表现是"事件发了、按钮没反应"，很容易误判成按钮本身有问题。
    await dispatchMouse('mousePressed', previewBefore.zoomIn.x, previewBefore.zoomIn.y, 'left')
    await dispatchMouse('mouseReleased', previewBefore.zoomIn.x, previewBefore.zoomIn.y, 'left')
    await new Promise((r) => setTimeout(r, 250))
    const afterToolbarClick = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    check(
      '【真机反馈】点工具条按钮**不会**关掉浮层',
      afterToolbarClick.open === true,
      JSON.stringify({ open: afterToolbarClick.open })
    )
    check(
      '点「放大」确实放大了（不只是"没关"，而是真的生效）',
      typeof afterToolbarClick.scale === 'number' && afterToolbarClick.scale > 0,
      JSON.stringify({ scale: afterToolbarClick.scale, level: afterToolbarClick.level })
    )

    // 滚轮缩放。
    //
    // ⚠️ 必须先从"100%"回到**适应窗口**。滚轮的分工是：
    //   图片没溢出（适应或更小）→ 滚轮缩放；
    //   图片已放大到溢出         → 滚轮滚动查看，缩放用 Ctrl/⌘+滚轮。
    //
    // 停在 100% 时图片是溢出的，普通滚轮按设计**只滚动**，测不出缩放 ——
    // 第一版就是停在那里测的，得到 before/after 都是 1，看起来像"滚轮没实现"。
    await dispatchMouse(
      'mousePressed',
      previewBefore.fitButton.x,
      previewBefore.fitButton.y,
      'left'
    )
    await dispatchMouse(
      'mouseReleased',
      previewBefore.fitButton.x,
      previewBefore.fitButton.y,
      'left'
    )
    await new Promise((r) => setTimeout(r, 200))
    const atFit = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    check(
      '前置：点「适应窗口」回到适应态（此时图片未溢出，滚轮才用于缩放）',
      atFit.scale === 0,
      JSON.stringify({ scale: atFit.scale, level: atFit.level })
    )

    const wheelTarget = atFit.image || { x: 400, y: 400 }
    await dispatchWheel(wheelTarget.x, wheelTarget.y, -120)
    await new Promise((r) => setTimeout(r, 250))
    const afterWheel = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    check(
      '【用户要求】滚轮可以放大图片（适应态下向上滚）',
      typeof afterWheel.scale === 'number' && afterWheel.scale !== atFit.scale,
      JSON.stringify({ before: atFit.scale, after: afterWheel.scale, level: afterWheel.level })
    )

    // 溢出之后，Ctrl+滚轮仍然能缩放（普通滚轮这时让给滚动）。
    const overflowed = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    await dispatchWheel(wheelTarget.x, wheelTarget.y, -120, { ctrlKey: true })
    await new Promise((r) => setTimeout(r, 250))
    const afterCtrlWheel = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    check(
      '放大到溢出之后，Ctrl+滚轮仍可继续缩放（普通滚轮这时用于滚动查看）',
      afterCtrlWheel.scale !== overflowed.scale,
      JSON.stringify({
        before: overflowed.scale,
        after: afterCtrlWheel.scale,
        level: afterCtrlWheel.level
      })
    )

    // —— 一次滚轮动作只走一档（真机反馈） ——
    //
    // 用户原话："放大不是一步一步放大，放小也不是，滚轮识别有问题。"
    //
    // 根因：原来**每个 `wheel` 事件**都走一档，而一次滚轮动作会触发很多事件 ——
    // 触控板一次轻扫几十个，鼠标一格也有 1 个但触控板的小步进会累积成几十档。
    // 现在按累积位移算，够一格才走一档。
    //
    // 这一条模拟触控板：20 个事件、每个 deltaY=-8（合计 -160 = 一格半），
    // 正确的行为是**至多走 2 档**；修复前会走满 20 档直接到上限。
    await dispatchMouse(
      'mousePressed',
      previewBefore.fitButton.x,
      previewBefore.fitButton.y,
      'left'
    )
    await dispatchMouse(
      'mouseReleased',
      previewBefore.fitButton.x,
      previewBefore.fitButton.y,
      'left'
    )
    await new Promise((r) => setTimeout(r, 200))
    const burstStart = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    check('前置：回到适应态，准备测连发', burstStart.scale === 0, String(burstStart.scale))

    const burstTarget = burstStart.image || { x: 400, y: 400 }
    for (let i = 0; i < 20; i++) {
      // 用 **Ctrl+滚轮**：它不受"溢出后让给滚动"那条规则影响，
      // 因此每个事件都会真的尝试缩放 —— 第一版用普通滚轮，图片一溢出
      // 后续事件就被让给滚动了，断言**测不出**连发失控（假绿）。
      //
      // 连发之间只隔 8ms —— 模拟触控板的连续小步进，不触发"停手"重置。
      await dispatchWheel(burstTarget.x, burstTarget.y, -8, { ctrlKey: true })
      await new Promise((r) => setTimeout(r, 8))
    }
    await new Promise((r) => setTimeout(r, 250))
    const afterBurst = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    check(
      '【真机反馈】触控板连发 20 个小事件只走**至多 2 档**（不是一路冲到上限）',
      afterBurst.scale !== burstStart.scale && afterBurst.scale <= 1.5,
      JSON.stringify({
        startScale: burstStart.scale,
        afterScale: afterBurst.scale,
        level: afterBurst.level,
        // 修复前这里会是 4（STEPS 上限）
        note: '20 个 -8 合计 -160，够一格半'
      })
    )
    // —— 从适应态滚**两格**，验证档位取值正确 ——
    await dispatchMouse(
      'mousePressed',
      previewBefore.fitButton.x,
      previewBefore.fitButton.y,
      'left'
    )
    await dispatchMouse(
      'mouseReleased',
      previewBefore.fitButton.x,
      previewBefore.fitButton.y,
      'left'
    )
    await new Promise((r) => setTimeout(r, 200))

    // 两格：每格 deltaY=-120，各自恰好越过一次阈值（100）。
    for (let i = 0; i < 2; i++) {
      await dispatchWheel(burstTarget.x, burstTarget.y, -120, { ctrlKey: true })
      await new Promise((r) => setTimeout(r, 60))
    }
    await new Promise((r) => setTimeout(r, 200))
    const twoIn = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )

    // 再缩两格，验证方向下的档位取值也对。
    for (let i = 0; i < 2; i++) {
      await dispatchWheel(burstTarget.x, burstTarget.y, 120, { ctrlKey: true })
      await new Promise((r) => setTimeout(r, 60))
    }
    await new Promise((r) => setTimeout(r, 200))
    const twoOut = JSON.parse(
      await evaluate(cdp, `JSON.stringify(globalThis.__EG__.__previewProbe())`)
    )
    const twoSteps = { scale: twoIn.scale, level: twoIn.level, afterTwoOut: twoOut.scale }

    check(
      // ⚠️ **滚两格必须落在 150%。**
      //
      // 这条是为一个很隐蔽的 bug 加的：重构 `zoomAtPointer` 时漏掉了 `STEPS[...]`
      // 查表，`scale` 被赋成了**数组下标**。
      //
      // 为什么不用"倍率必须在档位表里"？因为下标 1/2/3/4 **恰好也是合法倍率**，
      // 那种断言抓不到它（试过了，确实假绿）。
      // 只有"从适应态起、恰好两格之后的位置"才有区分度：
      //   正确 → STEPS[4] = 1.5（150%）
      //   带 bug → min(7, 3+1) = 4（400%）
      '【回归】从适应态滚**两格**应落在 150%（漏查表会跳到 400%）',
      twoSteps.scale === 1.5 && twoSteps.level === '150%',
      JSON.stringify({ scale: twoSteps.scale, level: twoSteps.level, expected: 1.5 })
    )
    check(
      // 从 150% 缩两格：150% → 100% → 75%。
      // （我第一版写成期望 100%，是**算错了** —— 所以这条同时也在验方向。）
      '缩小方向同样按档位走：150% 缩两格应到 75%',
      twoSteps.afterTwoOut === 0.75,
      JSON.stringify({ afterTwoOut: twoSteps.afterTwoOut, expected: 0.75 })
    )

    // 收尾，别影响后面的用例。
    await evaluate(cdp, `globalThis.__EG__.closePreviewOverlay(); true`)
    check(
      'closePreviewOverlay 能正常关掉（收尾）',
      (await evaluate(cdp, `globalThis.__EG__.isPreviewOverlayOpen()`)) === false
    )

    // —— 待命期间，页面必须能收到 hover 事件（真机反馈） ——
    //
    // 用户原话："我首次点击悬停注释以后放在了一个具有hover展示的按钮上，它没有出现，
    // 当我点击1次注释以后……此时再把悬停注释移动到这个有hover展示的按钮上，
    // 此时就会出现hover效果了，这时候才可以注释成功。"
    //
    // "第一次不行、走一遍弹窗之后才行"这个观察是定位根因的关键：
    // 待命时浮层宿主是 `pointer-events: all`（全视口覆盖），**页面收不到任何
    // 指针事件**，于是 hover 浮层永远不出现；而那一轮弹窗把宿主留在了
    // `pointer-events: none`，反倒让页面收到了事件 —— 一个 bug 偶然掩盖了另一个。
    //
    // 回路：造一个"只在 hover 时出现"的元素，arm 之后把**真实鼠标**移上去，
    // 断言那个浮层出现了。
    await evaluate(
      cdp,
      `(() => {
        const trigger = document.createElement('div');
        trigger.id = 'eg-hover-trigger';
        trigger.textContent = 'hover 我';
        trigger.style.cssText = 'position:fixed;left:30px;top:420px;width:120px;height:30px;background:#eee;z-index:1';

        const panel = document.createElement('div');
        panel.id = 'eg-hover-panel';
        panel.textContent = 'hover 才出现的内容';
        panel.style.cssText = 'display:none;position:fixed;left:30px;top:452px;width:180px;height:40px;background:#cfc;z-index:1';

        document.body.appendChild(trigger);
        document.body.appendChild(panel);
        // 只用 **mouseenter/mouseleave** —— 这是 hover 展示最常见的实现，
        // 也恰好最容易被"全视口吃事件"的浮层掐死。
        trigger.addEventListener('mouseenter', () => { panel.style.display = 'block'; });
        trigger.addEventListener('mouseleave', () => { panel.style.display = 'none'; });

        globalThis.__EG__.disarmPicker();
        return true;
      })()`
    )
    await new Promise((r) => setTimeout(r, 120))

    const hoverTriggerBox = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const r = document.getElementById('eg-hover-trigger').getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        })()`
      )
    )

    // 先把鼠标放到远处，确保是"移进去"而不是一直在里面。
    await dispatchMouse('mouseMoved', 5, 600, 'left')
    // `pendingHoverGrab` 随悬停入口一起删掉了 —— 现在只有一种入口。
    await evaluate(cdp, `globalThis.__EG__.armPicker({ silent: true }); true`)
    await new Promise((r) => setTimeout(r, 200))

    await dispatchMouse('mouseMoved', hoverTriggerBox.x, hoverTriggerBox.y, 'left')
    await new Promise((r) => setTimeout(r, 350))

    const hoverUnderArm = JSON.parse(
      await evaluate(
        cdp,
        `JSON.stringify({
          panelVisible: getComputedStyle(document.getElementById('eg-hover-panel')).display !== 'none',
          armed: globalThis.__EG__.isPickerArmed()
        })`
      )
    )
    check(
      '前置：已进入注释模式',
      hoverUnderArm.armed === true,
      JSON.stringify(hoverUnderArm)
    )
    check(
      '【真机反馈】待命期间把鼠标移到 hover 触发的元素上，**页面的 hover 浮层必须出现**',
      hoverUnderArm.panelVisible === true,
      JSON.stringify(hoverUnderArm)
    )

    // 收尾：拆掉、退出模式。
    await evaluate(
      cdp,
      `(() => {
        globalThis.__EG__.disarmPicker();
        document.getElementById('eg-hover-trigger').remove();
        document.getElementById('eg-hover-panel').remove();
        return true;
      })()`
    )

    /*
     * ─────────────────────────────────────────────────────────────────────
     * 这里原本有 **1300 行**关于"页面内的注释框如何与页面的焦点陷阱争夺焦点"的测试。
     *
     * 全部删掉了，因为**那场争夺不存在了**。
     *
     * 输入框从页面里搬到了**侧边面板**（我们自己的文档）：抽屉/模态框的焦点陷阱
     * 只能作用于它自己那个文档，碰不到面板。所以这些测试针对的对象 ——
     * 抢焦点、focusin 守卫、inert 清理、防爆栈、按键兜底、退让机制、
     * 光标兜底、键盘激活不被吞 —— **一个都不再存在**。
     *
     * 它们是分八轮加上去的，每一轮都在"如何赢下焦点"这个框架里优化打法。
     * 真正解决问题的是 Orca 的做法：**不上那个战场**。
     *
     * 那些行为现在由这些用例覆盖：
     *   · 输入框所在的面板（含"刷新后内容不丢"）—— verify-sidepanel.mjs；
     *   · 剪贴板一次写入多表示 —— 同上；
     *   · 面板输入的契约（Esc 不关、取消才关）—— 同上。
     *
     * 页面侧留下的责任只有一条，见下面那个新段落：**注释期间高亮框保持冻结**。
     * ─────────────────────────────────────────────────────────────────────
     */

  } finally {
    cdp?.close()
    child.kill()
    server.close()
    await new Promise((r) => setTimeout(r, 300))
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` :: ${item.detail}` : ''}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('验证脚本自身出错：', error)
  process.exit(1)
})
