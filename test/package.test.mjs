/**
 * 打包产物的验证：**用真实的解压器**拆开，逐项核对。
 *
 * ## 为什么不能只验"脚本跑完了、zip 生成了"
 *
 * 一个能生成的包完全可能是**装不起来**的：
 *   · manifest 指的文件不在包里（图标、service worker、侧边面板页）；
 *   · service worker 的 `importScripts` 目标缺了 —— 表现是
 *     "Service worker registration failed"，整个扩展不可用；
 *   · 内容脚本清单里某个文件漏了 —— 表现是抓取时报"某个函数不存在"；
 *   · 混进了开发文件（`test/`、`tools/`）—— 那不只是体积问题：
 *     `test/repro.html` 曾经被写进 `web_accessible_resources` 一起发布，
 *     对所有网站可访问。
 *
 * 这些都是"打开包看一眼"才能发现的事，所以这里真的打开它。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { buildPackage } from '../tools/package.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 找一个能用的 PowerShell（`pwsh` 不在 Node 子进程的 PATH 上）。 */
const POWERSHELL = (() => {
  for (const candidate of [
    'pwsh',
    'powershell',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  ]) {
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
 * 打包并解开，返回解出来的根目录。
 *
 * @param {string} dir
 */
function buildAndExpand(dir) {
  const zipPath = join(dir, 'pkg.zip')
  buildPackage({ outPath: zipPath })
  const expanded = join(dir, 'expanded')
  execFileSync(POWERSHELL, [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${expanded}' -Force`
  ])
  return expanded
}

/**
 * 列出目录下所有文件的相对路径（用 `/` 分隔）。
 *
 * @param {string} dir
 * @param {string} [prefix]
 */
function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...listFiles(join(dir, entry.name), rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

test('打包产物能被真实解压器打开，且 manifest 指的文件都在包里', (t) => {
  if (!POWERSHELL) {
    t.skip('这台机器上没有可用的 PowerShell，无法用真实解压器校验')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'eg-pkg-'))
  try {
    const expanded = buildAndExpand(dir)
    const files = listFiles(expanded)
    const set = new Set(files)

    // ① manifest 在、且是合法 JSON。
    assert.ok(set.has('manifest.json'), `包里没有 manifest.json，实际：${files.join(', ')}`)
    const manifest = JSON.parse(readFileSync(join(expanded, 'manifest.json'), 'utf8'))
    assert.equal(manifest.manifest_version, 3)

    // ② manifest 指到的每一个文件都必须在包里。
    const referenced = [
      manifest.background.service_worker,
      manifest.side_panel.default_path,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon)
    ]
    for (const path of referenced) {
      assert.ok(set.has(path), `manifest 指向 ${path}，但包里没有它`)
    }

    // ③ service worker 的 `importScripts` 目标也必须在 ——
    //    缺一个的表现是 "Service worker registration failed"，扩展完全不可用。
    const workerPath = manifest.background.service_worker
    const workerSource = readFileSync(join(expanded, workerPath), 'utf8')

    const importStart = workerSource.indexOf('importScripts(')
    assert.ok(importStart !== -1, 'worker 里找不到 importScripts —— 断言的前提变了')
    /*
     * ⚠️ 必须**切到那个调用的右括号为止**。
     *
     * 我第一版切到文件末尾，于是把 `CONTENT_SCRIPTS` 数组里的字符串也当成了
     * importScripts 的目标，解析出 `src/background/src/shared/text-utils.js`
     * 这种不存在的路径 —— 报的是"包里少了文件"，其实是我的扫描范围错了。
     */
    const importEnd = workerSource.indexOf(')', importStart)
    const importBlock = workerSource.slice(importStart, importEnd)
    for (const match of importBlock.matchAll(/'([^']+)'/g)) {
      const target = match[1]
      // importScripts 里是相对 worker 的路径。
      const resolved = join(dirname(workerPath), target).split('\\').join('/')
      assert.ok(set.has(resolved), `worker 要 importScripts ${resolved}，但包里没有它`)
    }

    // ④ 内容脚本清单里的每一个文件也都要在。
    const scriptsStart = workerSource.indexOf('const CONTENT_SCRIPTS')
    assert.ok(scriptsStart !== -1, 'worker 里找不到 CONTENT_SCRIPTS —— 断言的前提变了')
    const scriptsBlock = workerSource.slice(scriptsStart)
    let scriptCount = 0
    for (const match of scriptsBlock.matchAll(/'([^']+\.js)'/g)) {
      scriptCount += 1
      assert.ok(set.has(match[1]), `内容脚本清单里有 ${match[1]}，但包里没有它`)
    }
    assert.ok(scriptCount > 0, '内容脚本清单一条都没解析出来 —— 断言等于没跑')

    // ⑤ **开发文件一律不得进包**。
    for (const forbidden of ['test/', 'tools/', '.spec-workflow/', 'README.md', 'dist/']) {
      assert.ok(
        !files.some((f) => f === forbidden || f.startsWith(forbidden)),
        `包里混进了开发文件：${forbidden}`
      )
    }
    assert.ok(
      !set.has('test/repro.html'),
      '缺陷复现页不该随扩展发布 —— 它曾经以 web_accessible_resources 的形式对全网暴露'
    )

    // ⑥ 打包后的 manifest 不得再声明 web_accessible_resources：
    //    没有任何运行时代码需要它（`getURL` 只用于诊断输出路径），
    //    留着就是白白多一个能被网站探测到的面。
    assert.equal(
      manifest.web_accessible_resources,
      undefined,
      '打包后的 manifest 不应再有 web_accessible_resources'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('打包是确定性的：同样输入产出逐字节相同的包', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-pkg-det-'))
  try {
    const a = join(dir, 'a.zip')
    const b = join(dir, 'b.zip')
    buildPackage({ outPath: a })
    buildPackage({ outPath: b })
    assert.deepEqual(
      Array.from(readFileSync(b)),
      Array.from(readFileSync(a)),
      '两次打包的结果不一致 —— 那样"这个包对应哪个版本"就说不清了'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
