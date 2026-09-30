/**
 * Chrome 扩展的 captureVisibleTab 频率实测。
 *
 * ## 这个脚本在装什么
 *
 * 它加载一个**一次性生成的 Chrome MV3 扩展**（不是本项目的扩展），扩展里只有一个
 * service worker，唯一做的事是连续调用 `chrome.tabs.captureVisibleTab` 并把每次的
 * 结果记到 `chrome.storage.local`。
 *
 * 然后用 headless Chrome 打开一个本地页面，触发那次连续调用，把结果读回来。
 *
 * ## 为什么要单独造一个扩展
 *
 * `chrome.tabs.captureVisibleTab` 只存在于**扩展上下文**里。页面上无法调用它，
 * 所以本项目的验证脚本（在页面上下文里跑）对它无能为力——之前几轮都是靠
 * `Page.captureScreenshot` 替代的。要真测配额，就必须真加载一个扩展。
 *
 * 用法：`node test/risk-probe/run-capture-vt-probe.mjs`
 * 退出码 0 = 探针跑完（不代表没有失败，失败率本身就是结论）。
 *
 * 输出写到 `.spec-workflow/element-grab-extension/verification/capture-visible-tab-probe.json`。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..', '..', '..')
const outputPath = join(
  projectRoot,
  '.spec-workflow',
  'element-grab-extension',
  'verification',
  'capture-visible-tab-probe.json'
)

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
]

/** 探针扩展：连续抓 N 次，记录每次的耗时与成败。 */
const PROBE_EXTENSION_MANIFEST = {
  manifest_version: 3,
  name: 'capture-visible-tab probe',
  version: '1.0.0',
  description: 'One-off probe: measures chrome.tabs.captureVisibleTab throughput.',
  permissions: ['activeTab', 'scripting', 'storage'],
  background: { service_worker: 'worker.js' },
  action: { default_title: 'run probe' }
}

/**
 * 探针 worker。
 *
 * 关键：**不依赖内容脚本注入**。第一版用 manifest 声明的 `content_scripts` 从页面
 * 触发扩展，结果在无头模式下根本没注入（`probe_unavailable`）。改成由 worker
 * 自己跑探针、把结果写进 `chrome.storage.local`，页面只负责读结果——这也更贴近
 * 真实的调用路径（`captureVisibleTab` 本来就是在 worker 里调的）。
 *
 * @type {string}
 */
const PROBE_EXTENSION_WORKER = `
// 所有东西都挂在 globalThis 上：MV3 service worker 的顶层函数声明不在
// CDP Runtime.evaluate 的作用域里，直接 eval 'runBurst(...)' 会 ReferenceError。
globalThis.runBurst = async function (count) {
  const results = []
  for (let i = 0; i < count; i++) {
    const startedAt = Date.now()
    const outcome = await new Promise(function (resolve) {
      try {
        chrome.tabs.captureVisibleTab(undefined, { format: 'png' }, function (dataUrl) {
          const error = chrome.runtime.lastError
          resolve({
            index: i,
            elapsedMs: Date.now() - startedAt,
            ok: !error && typeof dataUrl === 'string' && dataUrl.length > 0,
            error: error ? error.message : null,
            bytes: typeof dataUrl === 'string' ? dataUrl.length : 0
          })
        })
      } catch (error) {
        resolve({ index: i, elapsedMs: Date.now() - startedAt, ok: false, error: String(error), bytes: 0 })
      }
    })
    results.push(outcome)
  }
  return results
}

globalThis.probeReady = true
`

/**
 * 探针触发方式：用 CDP 直接执行 service worker 里的表达式。
 *
 * 这是本次实测的关键手法——`captureVisibleTab` 只存在于扩展上下文，
 * 但 worker 也是一个可以附加调试器的 target，所以能在里面直接求值。
 * 因此不需要内容脚本、不需要真实点击图标。
 */

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe target</title>
<style>body{background:#fff;font:16px system-ui;margin:0;padding:40px}</style></head>
<body><h1 id="probe">captureVisibleTab probe target</h1></body></html>`

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(FIXTURE_HTML)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

function launchChrome(chromePath, userDataDir, extensionDir) {
  return spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
}

function readDevToolsPort(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`未读到端口\n${buffer}`)), timeoutMs)
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
      reject(new Error(`Chrome 提前退出 code=${code}`))
    })
  })
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 端口还没起来
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('等待页面 target 超时')
}

/**
 * 找探针扩展的 service worker target。
 *
 * 这一步同时回答了"无头模式下 `--load-extension` 到底加载了没有"——
 * 找不到 worker target 就意味着扩展没被加载，后面的测量无从谈起。
 */
async function waitForServiceWorkerTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastSeen = []
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      lastSeen = targets.map((t) => `${t.type}:${t.url}`)
      const worker = targets.find(
        (t) =>
          (t.type === 'service_worker' || t.type === 'worker') &&
          typeof t.url === 'string' &&
          t.url.includes('worker.js') &&
          t.webSocketDebuggerUrl
      )
      if (worker) return { worker, lastSeen }
    } catch {
      // 继续等
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return { worker: null, lastSeen }
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  let nextId = 1
  const pending = new Map()
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
        }, 60000)
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
    console.error('未找到 Chrome/Edge，无法进行本项实测')
    process.exit(2)
  }

  const workDir = await mkdtemp(join(tmpdir(), 'eg-capture-probe-'))
  const extensionDir = join(workDir, 'extension')
  const userDataDir = join(workDir, 'profile')
  await mkdir(extensionDir, { recursive: true })
  await mkdir(userDataDir, { recursive: true })

  await writeFile(
    join(extensionDir, 'manifest.json'),
    JSON.stringify(PROBE_EXTENSION_MANIFEST, null, 2),
    'utf8'
  )
  await writeFile(join(extensionDir, 'worker.js'), PROBE_EXTENSION_WORKER, 'utf8')

  const { server, origin } = await startFixtureServer()
  const child = launchChrome(chromePath, userDataDir, extensionDir)
  let cdp = null
  let workerCdp = null

  try {
    const port = await readDevToolsPort(child, 25000)
    const target = await waitForPageTarget(port, 15000)
    cdp = createCdpClient(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: `${origin}/probe.html` })
    await new Promise((r) => setTimeout(r, 900))

    const { worker, lastSeen } = await waitForServiceWorkerTarget(port, 12000)
    if (!worker) {
      const report = {
        probe: 'captureVisibleTab-throughput',
        verdict: 'probe_unavailable',
        reason:
          '找不到探针扩展的 service worker target —— 说明无头模式下 --load-extension 没有真正加载扩展。' +
          '这是环境限制，不构成对扩展能力的结论。',
        observedTargets: lastSeen,
        measuredAt: new Date().toISOString()
      }
      await persist(report)
      console.log(JSON.stringify(report, null, 2))
      process.exit(0)
    }

    workerCdp = createCdpClient(worker.webSocketDebuggerUrl)
    await workerCdp.ready
    await workerCdp.send('Runtime.enable')

    const workerEval = async (expression) => {
      const result = await workerCdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (result.exceptionDetails) {
        throw new Error(
          `worker 内抛错：${
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
          }`
        )
      }
      return result.result.value
    }

    /** 让 worker 自己跑一轮零间隔连发，返回原始结果。 */
    const runBurstInWorker = async (count) => {
      await workerEval(`globalThis.__probeResults = null; true`)
      await workerEval(
        `runBurst(${count}).then(function (r) { globalThis.__probeResults = r; return true })`
      )
      // 轮询直到结果落地。
      for (let i = 0; i < 200; i++) {
        const ready = await workerEval(`Array.isArray(globalThis.__probeResults)`)
        if (ready) break
        await new Promise((r) => setTimeout(r, 150))
      }
      return JSON.parse(await workerEval(`JSON.stringify(globalThis.__probeResults)`))
    }

    const BURST = 12
    const firstBurst = await runBurstInWorker(BURST)
    // 紧接第二轮：看是否存在"窗口型"配额（第一轮全绿、第二轮开始失败）。
    const secondBurst = await runBurstInWorker(BURST)

    const summarize = (results) => {
      const ok = results.filter((r) => r.ok).length
      const failures = results.filter((r) => !r.ok)
      const elapsed = results.map((r) => r.elapsedMs)
      return {
        attempts: results.length,
        succeeded: ok,
        failed: results.length - ok,
        failureRate:
          results.length === 0 ? null : Number(((results.length - ok) / results.length).toFixed(3)),
        minElapsedMs: elapsed.length ? Math.min(...elapsed) : null,
        maxElapsedMs: elapsed.length ? Math.max(...elapsed) : null,
        medianElapsedMs: elapsed.length
          ? elapsed.slice().sort((a, b) => a - b)[Math.floor(elapsed.length / 2)]
          : null,
        errorMessages: Array.from(new Set(failures.map((r) => r.error).filter(Boolean))),
        failedIndices: failures.map((r) => r.index)
      }
    }

    const first = summarize(firstBurst)
    const second = summarize(secondBurst)

    const verdict =
      first.failed === 0 && second.failed === 0
        ? 'no_throttle_observed_at_24_rapid_calls'
        : first.failed === 0
          ? 'throttle_observed_on_second_rapid_burst'
          : 'throttle_observed_within_first_burst'

    const report = {
      probe: 'captureVisibleTab-throughput',
      measuredAt: new Date().toISOString(),
      chromeVersion: await evaluate(cdp, `navigator.userAgent`),
      burstSize: BURST,
      intervalBetweenCallsMs: 0,
      verdict,
      firstBurst: first,
      secondBurst: second,
      firstBurstRaw: firstBurst,
      secondBurstRaw: secondBurst,
      implementationIntervalMs: 300,
      interpretation:
        verdict === 'no_throttle_observed_at_24_rapid_calls'
          ? '24 次零间隔连发全部成功，未观察到限流。说明实现的 300ms 下限 + 串行化足够保守；但也意味着**限流阈值未被触及，本次测量无法给出确切阈值**——这是本项的已知测量边界。'
          : verdict === 'throttle_observed_on_second_rapid_burst'
            ? '第一轮全部成功、紧接的第二轮出现失败 —— 存在窗口型配额。实现的退避（失败后间隔翻倍、上限 2000ms）方向正确。'
            : '第一轮内即出现失败 —— 零间隔连发不可用，串行化 + 最小间隔是必需而非优化。'
    }

    await persist(report)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    workerCdp?.close()
    cdp?.close()
    child.kill()
    server.close()
    await new Promise((r) => setTimeout(r, 300))
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function persist(report) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8')
  // 顺便回读一次确认写成功，避免"以为写了其实没有"。
  await readFile(outputPath, 'utf8')
}

main().catch((error) => {
  console.error('探针脚本自身出错：', error)
  process.exit(1)
})
