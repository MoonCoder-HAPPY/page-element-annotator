/**
 * `_debugSource` 可用率实测的运行器。
 *
 * 打开 fixture 页面，读出页面自己算好的结果，落盘到 verification/。
 *
 * 用法：`node test/risk-probe/run-debug-source-probe.mjs`
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'react-fixture')
const extensionRoot = join(here, '..', '..')
const projectRoot = join(here, '..', '..', '..')
const outputPath = join(
  projectRoot,
  '.spec-workflow',
  'element-grab-extension',
  'verification',
  'debug-source-probe.json'
)

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
]

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 静态服务器。需要服务三处：
 * - `/fixture/*` → fixture 自身
 * - `/vendor/*`  → React 构建产物（`../vendor/x.js` 从 `/fixture/index.html` 解析出来
 *                  就是 `/vendor/x.js`，不是 `/fixture/vendor/x.js`——这是第一版 404 的原因）
 * - `/src/*`     → 项目 src 下的定位器脚本
 */
async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      let filePath

      if (url.pathname.startsWith('/fixture/')) {
        filePath = join(fixtureDir, url.pathname.slice('/fixture/'.length))
      } else if (url.pathname.startsWith('/vendor/')) {
        filePath = join(fixtureDir, 'vendor', url.pathname.slice('/vendor/'.length))
      } else if (url.pathname.startsWith('/src/')) {
        filePath = join(extensionRoot, url.pathname.slice(1))
      } else {
        response.writeHead(404)
        response.end('not found')
        return
      }

      const body = await readFile(filePath)
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream'
      })
      response.end(body)
    } catch (error) {
      response.writeHead(404)
      response.end('not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

function launchChrome(chromePath, userDataDir, url) {
  return spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      url
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
      const page = targets.find(
        (t) => t.type === 'page' && t.url.includes('/fixture/') && t.webSocketDebuggerUrl
      )
      if (page) return page
    } catch {
      // 继续等
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('等待 fixture 页面超时')
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
        }, 30000)
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

  const { server, origin } = await startServer()
  const userDataDir = await mkdtemp(join(tmpdir(), 'eg-debug-source-'))
  const url = `${origin}/fixture/index.html`
  const child = launchChrome(chromePath, userDataDir, url)
  let cdp = null

  try {
    const port = await readDevToolsPort(child, 25000)
    const target = await waitForPageTarget(port, 15000)
    cdp = createCdpClient(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')

    // fixture 自己在 400ms 后测量，这里多等一会儿。
    let payload = null
    for (let i = 0; i < 60; i++) {
      payload = await evaluate(
        cdp,
        `globalThis.__probeResult ? JSON.stringify(globalThis.__probeResult) : null`
      )
      if (payload) break
      await new Promise((r) => setTimeout(r, 200))
    }

    if (!payload) {
      const failure = {
        probe: 'debugSource-availability',
        verdict: 'probe_unavailable',
        reason: 'fixture 未产出结果（React 可能没渲染成功）',
        fixtureUrl: url,
        measuredAt: new Date().toISOString()
      }
      await persist(failure)
      console.log(JSON.stringify(failure, null, 2))
      process.exit(0)
    }

    const parsed = JSON.parse(payload)
    const report = {
      probe: 'debugSource-availability',
      measuredAt: new Date().toISOString(),
      fixtureUrl: url,
      ...parsed
    }

    // 给出结论：定位器能不能在真实 React dev 树上命中。
    if (parsed.ok && parsed.locatorResult) {
      const located = parsed.locatorResult.sourceFile
      report.verdict = located
        ? 'locator_hits_on_react_dev_build'
        : 'locator_misses_even_with_debug_source_present'
      report.interpretation = located
        ? `定位器在 React ${parsed.reactVersion} 的 development 构建上命中：${located}。` +
          `fiber 上确有 _debugSource（首次出现在第 ${parsed.firstSourceDepth} 层）。` +
          '注意这是 development 构建；生产构建不写该字段，第 1 档会自然落到后续档位。'
        : 'fiber 上存在 _debugSource，但定位器没命中 —— 需要排查定位器的取值逻辑。'
    } else if (parsed.ok) {
      report.verdict = 'locator_missing'
      report.interpretation = '页面里没有加载到项目的 locateSource —— 检查 fixture 的脚本引用路径。'
    } else {
      report.verdict = 'fixture_failed'
      report.interpretation = String(parsed.reason)
    }

    await persist(report)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    cdp?.close()
    child.kill()
    server.close()
    await new Promise((r) => setTimeout(r, 300))
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function persist(report) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8')
  await readFile(outputPath, 'utf8')
}

main().catch((error) => {
  console.error('探针脚本自身出错：', error)
  process.exit(1)
})
