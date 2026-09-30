/**
 * 验证新的注入实现（fetch 源码 + 单函数按序 eval）在真实 Chrome 里成立。
 *
 * ## 为什么需要这个
 *
 * 本环境的 Chrome 不接受 `--load-extension`，所以无法直接跑扩展。
 * 但新实现的核心是**一段自包含的注入函数**——那段函数可以原样搬到页面上下文里跑，
 * 只要把 service worker 的 `fetch(chrome.runtime.getURL(p))` 换成从磁盘读。
 *
 * 于是能验证的东西很具体：
 * - 15 个源码按声明顺序 eval 后，命名空间是否真的装配出预期的键
 * - `armPicker` 是否可调用、调用后 overlay 是否真的挂上
 * - 有没有脚本在 eval 时报错
 *
 * 不能验证的：`chrome.scripting.executeScript` 本身、真实剪贴板、真实 storage。
 *
 * 用法：`node test/verify-injection-path.mjs`
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
]

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
}

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

/** 从 service-worker 源码里读出真正的注入清单，避免手工维护第二份。 */
async function readContentScriptList() {
  const sw = await readFile(join(extensionRoot, 'src/background/service-worker.js'), 'utf8')
  const match = sw.match(/const CONTENT_SCRIPTS = \[([\s\S]*?)\]/)
  if (!match) {
    throw new Error('在 service-worker.js 里找不到 CONTENT_SCRIPTS 清单')
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** 从 importScripts 读出 service worker 侧的加载清单（相对 src/background 解析）。 */
async function readServiceWorkerScriptList() {
  const sw = await readFile(join(extensionRoot, 'src/background/service-worker.js'), 'utf8')
  const match = sw.match(/importScripts\(([\s\S]*?)\)/)
  if (!match) {
    throw new Error('在 service-worker.js 里找不到 importScripts 清单')
  }
  return [...match[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .map((spec) => (spec.startsWith('../') ? 'src/' + spec.slice(3) : 'src/background/' + spec.slice(2)))
}

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      const filePath = join(extensionRoot, url.pathname.slice(1))
      const body = await readFile(filePath)
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream'
      })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  let nextId = 1
  const pending = new Map()
  const errors = []
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(undefined))
    socket.addEventListener('error', () => reject(new Error('CDP socket 错误')))
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
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text
      )
    }
  })
  return {
    ready,
    errors,
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
      `页面内抛错：${
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      }`
    )
  }
  return result.result.value
}

async function main() {
  const chromePath = findChrome()
  if (!chromePath) {
    console.error('未找到 Chrome/Edge')
    process.exit(2)
  }

  const list = await readContentScriptList()
  check(`注入清单可读（${list.length} 个路径）`, list.length > 0)

  // 这就是 service worker 里 fetch 那一步在做的事。
  const sources = []
  let totalBytes = 0
  for (const relative of list) {
    const text = await readFile(join(extensionRoot, relative), 'utf8')
    totalBytes += text.length
    sources.push({ path: relative, source: text })
  }
  check(
    `读取全部源码（${(totalBytes / 1024).toFixed(1)} KB）`,
    sources.length === list.length && totalBytes > 0
  )

  const { server, origin } = await startServer()
  const userDataDir = await mkdtemp(join(tmpdir(), 'eg-inject-path-'))
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `${origin}/test/fixture-page.html`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )

  let cdp = null
  try {
    const port = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('未读到端口')), 25000)
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
    })

    let target
    for (let i = 0; i < 60; i++) {
      const targetList = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = targetList.find((t) => t.type === 'page' && t.url.includes('fixture-page'))
      if (target) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!target) throw new Error('等待 fixture 页面超时')

    cdp = createCdpClient(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')
    await new Promise((r) => setTimeout(r, 500))

    // === 这一步与 service-worker.js 里注入的那个 func 逐字对应 ===
    // 唯一的差别是源码来自磁盘读而不是 worker 里的 fetch。
    const injectedOutcome = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const payload = ${JSON.stringify({ scripts: sources })};
          const problems = [];
          for (const entry of payload.scripts) {
            try {
              (0, eval)(entry.source);
            } catch (error) {
              problems.push(entry.path + ': ' + (error && error.message ? error.message : String(error)));
            }
          }
          const api = globalThis.__EG__;
          return JSON.stringify({
            failed: problems,
            keyCount: api ? Object.keys(api).length : 0,
            hasArmPicker: Boolean(api && typeof api.armPicker === 'function'),
            hasExtractPayload: Boolean(api && typeof api.extractPayload === 'function'),
            hasMountOverlay: Boolean(api && typeof api.mountOverlay === 'function'),
            hasSanitizePayload: Boolean(api && typeof api.sanitizePayload === 'function'),
            hasFormatText: Boolean(api && typeof api.formatGrabPayloadAsText === 'function'),
            hasLoadSource: Boolean(api && typeof api.locateSource === 'function'),
            hasCropScreenshot: Boolean(api && typeof api.cropScreenshot === 'function'),
            hasExtractWithScreenshot: Boolean(api && typeof api.extractWithScreenshot === 'function'),
            hasShowCapsule: Boolean(api && typeof api.showCapsule === 'function'),
            hasDescribeOmission: Boolean(api && typeof api.describeScreenshotOmission === 'function')
          });
        })()`
      )
    )

    check(
      '按序 eval 15 个源码无任何报错',
      injectedOutcome.failed.length === 0,
      injectedOutcome.failed.join(' | ')
    )
    check(
      `命名空间装配出 ${injectedOutcome.keyCount} 个键（期望 ≥ 70）`,
      injectedOutcome.keyCount >= 70,
      `实际 ${injectedOutcome.keyCount}`
    )

    // 内容侧必须有的（15 个 CONTENT_SCRIPTS 提供的）
    const requiredAcrossFiles = [
      ['armPicker', injectedOutcome.hasArmPicker, 'picker.js'],
      ['extractPayload', injectedOutcome.hasExtractPayload, 'extract.js'],
      ['mountOverlay', injectedOutcome.hasMountOverlay, 'overlay.js'],
      ['formatGrabPayloadAsText', injectedOutcome.hasFormatText, 'format.js'],
      ['locateSource', injectedOutcome.hasLoadSource, 'source-locator.js'],
      ['cropScreenshot', injectedOutcome.hasCropScreenshot, 'screenshot-crop.js'],
      ['extractWithScreenshot', injectedOutcome.hasExtractWithScreenshot, 'screenshot-flow.js'],
      ['showCapsule', injectedOutcome.hasShowCapsule, 'capsule.js'],
      ['describeScreenshotOmission', injectedOutcome.hasDescribeOmission, 'format.js']
    ]
    for (const [name, present, originFile] of requiredAcrossFiles) {
      check(`跨文件依赖 ${name}（来自 ${originFile}）已就位`, present)
    }

    // 内容侧**不该**有的（安全边界只在 service worker 里）
    check(
      '安全边界 sanitizePayload 不在内容侧（架构约束：它只在 service worker 加载）',
      injectedOutcome.hasSanitizePayload === false,
      `实际存在 = ${injectedOutcome.hasSanitizePayload}`
    )

    // 真正调用一次 armPicker，看交互层是否也活了。
    const armed = await evaluate(
      cdp,
      `(() => {
        globalThis.__EG__.armPicker({});
        const host = document.getElementById('__eg-grab-host');
        return JSON.stringify({
          armed: globalThis.__EG__.isPickerArmed(),
          overlayMounted: globalThis.__EG__.isOverlayMounted(),
          overlayHostInDom: Boolean(host),
          // 十字准星现在挂在**根元素**上，不再由宿主提供 ——
          // 宿主必须 pointer-events:none（否则页面收不到 hover，
          // 见 verify-in-chrome 里那条真机反馈断言）。
          // （本段在模板字符串里，注释不能出现反引号。）
          cursor: document.documentElement.style.cursor,
          hostPointerEvents: host ? host.style.pointerEvents : null,
          capsule: Boolean(document.getElementById('element-grab-capsule-host'))
        });
      })()`
    )
    const armState = JSON.parse(armed)
    check('调用 armPicker 后进入抓取模式', armState.armed === true)
    check(
      'overlay 捕获器真的挂进了 DOM（页面侧能查到 #__eg-grab-host）',
      armState.overlayMounted === true && armState.overlayHostInDom === true,
      JSON.stringify(armState)
    )
    check(
      // 光标改由根元素提供（宿主不再吃指针事件，也就顺带不了光标）。
      // 同时锁住"宿主不吃事件"这条 —— 它正是"hover 内容出不来"那个 bug 的修法。
      '十字光标与页内提示都生效，且宿主不吃指针事件',
      armState.cursor === 'crosshair' &&
        armState.capsule === true &&
        armState.hostPointerEvents === 'none'
    )

    check('整个过程没有未捕获异常', cdp.errors.length === 0, cdp.errors.join(' | '))

    // === service worker 侧：同一条注入函数能否把 10 个后台源码装起来 ===
    // 这条必须验：如果 fetch+eval 在 service worker 里跑不通，那整个后台都会挂。
    const swList = await readServiceWorkerScriptList()
    const swSources = []
    for (const relative of swList) {
      swSources.push({ path: relative, source: await readFile(join(extensionRoot, relative), 'utf8') })
    }
    const swOutcome = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          // 在一个干净对象上模拟 service worker 的全局，避免污染已装好的内容侧命名空间。
          const sandbox = {};
          const problems = [];
          for (const entry of ${JSON.stringify({ scripts: swSources })}.scripts) {
            try {
              new Function('globalThis', entry.source).call(sandbox, sandbox);
            } catch (error) {
              problems.push(entry.path + ': ' + (error && error.message ? error.message : String(error)));
            }
          }
          const api = sandbox.__EG__;
          return JSON.stringify({
            failed: problems,
            keyCount: api ? Object.keys(api).length : 0,
            hasSanitizePayload: Boolean(api && typeof api.sanitizePayload === 'function'),
            hasCaptureVisibleTab: Boolean(api && typeof api.captureVisibleTab === 'function'),
            hasAppendRecord: Boolean(api && typeof api.appendRecord === 'function'),
            hasFormatMarkdown: Boolean(api && typeof api.formatRecordsAsMarkdown === 'function')
          });
        })()`
      )
    )
    check(
      `service worker 侧按序加载 ${swList.length} 个源码无报错`,
      swOutcome.failed.length === 0,
      swOutcome.failed.join(' | ')
    )
    check(
      `service worker 命名空间装出 ${swOutcome.keyCount} 个键`,
      swOutcome.keyCount >= 70,
      `实际 ${swOutcome.keyCount}`
    )
    check('service worker 侧有 sanitizePayload（安全边界就位）', swOutcome.hasSanitizePayload === true)
    check('service worker 侧有 captureVisibleTab（截图采集就位）', swOutcome.hasCaptureVisibleTab === true)
    check('service worker 侧有 appendRecord（历史写入就位）', swOutcome.hasAppendRecord === true)
    check('service worker 侧有 formatRecordsAsMarkdown（批量导出就位）', swOutcome.hasFormatMarkdown === true)

    const failed = results.filter((r) => !r.ok)
    console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
    if (failed.length > 0) {
      console.log('失败项：')
      for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` :: ${item.detail}` : ''}`)
      process.exitCode = 1
    }
  } finally {
    cdp?.close()
    child.kill()
    server.close()
    await new Promise((r) => setTimeout(r, 300))
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('验证脚本自身出错：', error)
  process.exit(1)
})
