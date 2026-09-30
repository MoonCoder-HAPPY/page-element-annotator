/**
 * ZIP 打包器的验证：**用真实的解压器**校验产出的压缩包。
 *
 * ## 为什么不能只是"自己解析自己"
 *
 * 我如果自己写一遍中央目录解析来验自己写的中央目录，那就等于用同一个理解
 * 检查同一个理解 —— 偏移算错了、CRC 写错了，两边会一起错，测试照样绿。
 *
 * 所以这里把 zip 字节写到临时文件，交给 **PowerShell 的 `Expand-Archive`**
 * （Windows 自带的真实解压实现）解开，再逐字节比对内容。
 *
 * 这也是唯一能证明"用户双击能打开"的方式。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 把 `zip.js` 求值进一个沙箱，取出它挂到命名空间上的函数。 */
function loadZipModule() {
  const source = readFileSync(join(root, 'src/shared/zip.js'), 'utf8')
  const sandbox = {
    TextEncoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    console
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'zip.js' }).runInContext(sandbox)
  return sandbox.__EG__
}

/**
 * 找一个能用的 PowerShell。
 *
 * ⚠️ `pwsh`（PowerShell 7）**不在 Node 子进程的 PATH 上** —— 它只存在于
 * 上层工具的调用环境里。所以这里退回 Windows 自带的
 * `System32\WindowsPowerShell\v1.0\powershell.exe`（PS 5.1），
 * 它同样有 `Expand-Archive`。
 *
 * 找不到就**跳过**并说明原因，而不是让整条用例红着——
 * 那不是被测代码的问题。
 */
const POWERSHELL = (() => {
  const candidates = [
    'pwsh',
    'powershell',
    'powershell.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  ]
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' })
      return candidate
    } catch (error) {
      // 换下一个
    }
  }
  return null
})()

/**
 * 用 PowerShell 的真实解压实现解开，返回解出来的目录。
 *
 * @param {Uint8Array} bytes
 * @param {string} dir
 */
function expandWithPowerShell(bytes, dir) {
  const zipPath = join(dir, 'out.zip')
  writeFileSync(zipPath, Buffer.from(bytes))
  const target = join(dir, 'expanded')
  execFileSync(POWERSHELL, [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${target}' -Force`
  ])
  return target
}

test('产出的 ZIP 能被真实的解压器解开，内容逐字节一致', (t) => {
  if (!POWERSHELL) {
    t.skip('这台机器上没有可用的 PowerShell，无法用真实解压器校验')
    return
  }
  const zip = loadZipModule()
  assert.equal(typeof zip.buildZip, 'function', 'buildZip 必须挂在命名空间上')

  const md = '# 元素注释\n\n中文与 emoji 🎯 都要能原样还原。\n'
  // 一段"假的 PNG"：关键是**含 0x00 与 >0x7F 的字节**，能验证二进制没有被
  // 当成文本处理（那是最容易出的错）。
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x7f])

  const bytes = zip.buildZip([
    { name: '元素注释.md', bytes: new TextEncoder().encode(md) },
    { name: 'images/001.png', bytes: png }
  ])

  const dir = mkdtempSync(join(tmpdir(), 'eg-zip-'))
  try {
    const expanded = expandWithPowerShell(bytes, dir)

    const mdPath = join(expanded, '元素注释.md')
    const pngPath = join(expanded, 'images', '001.png')

    assert.ok(existsSync(mdPath), `解压后应当有「元素注释.md」，实际目录：${dir}`)
    assert.ok(existsSync(pngPath), '解压后应当有 images/001.png（目录结构要保留）')

    assert.equal(readFileSync(mdPath, 'utf8'), md, 'Markdown 内容必须逐字节一致')
    assert.deepEqual(
      Array.from(readFileSync(pngPath)),
      Array.from(png),
      '二进制内容必须逐字节一致（含 0x00 与 >0x7F 的字节）'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空包也是一个合法的 ZIP', (t) => {
  if (!POWERSHELL) {
    t.skip('这台机器上没有可用的 PowerShell，无法用真实解压器校验')
    return
  }
  const zip = loadZipModule()
  const bytes = zip.buildZip([])
  const dir = mkdtempSync(join(tmpdir(), 'eg-zip-empty-'))
  try {
    // 真实解压器不抛错就说明结构是合法的。
    const expanded = expandWithPowerShell(bytes, dir)
    assert.ok(existsSync(expanded), '空包也应当能被解开（内容为空）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：history.export 产出的压缩包里有 Markdown 和真 PNG', (t) => {
  if (!POWERSHELL) {
    t.skip('这台机器上没有可用的 PowerShell，无法用真实解压器校验')
    return
  }

  // 真机反馈："导出 md 的截图你也要导出啊！"
  //
  // 这条把整条导出链路真跑一遍：`history.export` → base64 → 字节 →
  // 交给**真实解压器** → 检查包里的 Markdown **确实引用了**那张图，
  // 而且那张图**确实在包里**。
  //
  // 只验"zip 结构合法"是不够的 —— 结构合法但 Markdown 指向
  // `images/999.png`、包里放的是 `images/001.png`，用户看到的同样是破图，
  // 而且不会有任何报错。所以必须**两边一起验**。
  const workerSource = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8')
  const formatSource = readFileSync(join(root, 'src/shared/format.js'), 'utf8')
  const zipSource = readFileSync(join(root, 'src/shared/zip.js'), 'utf8')

  const sandbox = {
    console,
    TextEncoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    /*
     * ⚠️ `atob` 也必须给。
     *
     * `base64ToBytes` 用它把 base64 解成字节。少了它，那条调用会抛
     * `ReferenceError` —— 而导出里"单张图失败不该让整次导出失败"的 catch
     * 会**静默吞掉**它，于是图片被跳过、`imageCount` 变成 0。
     * 表象是"导出里没有截图"，看起来像产品 bug，实际是**夹具缺一个全局函数**。
     */
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    // worker 顶层会 `importScripts(...)` 加载共享模块；那些文件本用例已经
    // 手工求值过了，所以这里只要一个空实现即可。
    importScripts: () => {}
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  for (const source of [formatSource, zipSource]) {
    new vm.Script(source).runInContext(sandbox)
  }

  const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33]
  const pngBase64 = Buffer.from(pngBytes).toString('base64')
  const record = {
    id: 'r1',
    createdAt: Date.now(),
    url: 'https://example.com/',
    selector: 'div.cm-content',
    payload: {
      page: { title: '示例', sanitizedUrl: 'https://example.com/' },
      target: { tagName: 'div', selector: 'div.cm-content', rectViewport: { width: 10, height: 10 } },
      screenshot: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + pngBase64 }
    }
  }

  // 只要 `readHistory` 与 `buildZip` 路径可用即可；其余命名空间符号按需补桩。
  sandbox.__EG__ = Object.assign(sandbox.__EG__, {
    readHistory: async () => ({ records: [record] }),
    appendRecord: async () => ({ droppedCount: 0 })
  })
  sandbox.chrome = {
    runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} } },
    storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    permissions: { contains: async () => false, onAdded: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    scripting: { executeScript: async () => [] },
    tabs: { query: async () => [], sendMessage: async () => {} },
    sidePanel: { setPanelBehavior: async () => {} },
    action: {
      onClicked: { addListener: () => {} },
      setBadgeText: async () => {},
      setTitle: async () => {}
    }
  }
  new vm.Script(workerSource).runInContext(sandbox)

  return (async () => {
    const response = await sandbox.handleMessage({ type: 'history.export', ids: undefined }, {})
    assert.equal(response.ok, true, `导出应当成功：${JSON.stringify(response).slice(0, 300)}`)
    assert.ok(response.result.base64, '应当回传压缩包的 base64')
    assert.match(response.result.filename, /\.zip$/, '导出的是压缩包，扩展名应当是 .zip')
    assert.equal(response.result.imageCount, 1, '这条记录有一张截图')

    const bytes = sandbox.__EG__.base64ToBytes(response.result.base64)
    const dir = mkdtempSync(join(tmpdir(), 'eg-export-'))
    try {
      const expanded = expandWithPowerShell(bytes, dir)

      const mdPath = join(expanded, '元素注释.md')
      assert.ok(existsSync(mdPath), '包里应当有「元素注释.md」')

      const markdown = readFileSync(mdPath, 'utf8')
      const imageName = sandbox.__EG__.screenshotImageName(0)
      assert.ok(
        markdown.includes(`![截图](${imageName})`),
        `Markdown 必须引用图片，实际那行：${markdown.split('\n').find((l) => l.includes('截图'))}`
      )

      // ⚠️ 关键：Markdown 里写的路径，**包里的文件必须真的在**。
      const imagePath = join(expanded, ...imageName.split('/'))
      assert.ok(
        existsSync(imagePath),
        `Markdown 引用了 ${imageName}，但包里没有这个文件 —— 用户会看到破图且无报错`
      )
      assert.deepEqual(
        Array.from(readFileSync(imagePath)),
        pngBytes,
        '包里的图片必须与原始截图逐字节一致'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })()
})

test('CRC32 与已知值一致', () => {
  const zip = loadZipModule()
  // 标准测试向量："123456789" 的 CRC32 是 0xCBF43926。
  const bytes = new TextEncoder().encode('123456789')
  assert.equal(zip.zipCrc32(bytes), 0xcbf43926, 'CRC32 算错了，解压器会报"文件已损坏"')
})
