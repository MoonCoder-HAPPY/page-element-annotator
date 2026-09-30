/**
 * 把扩展打成可发布的 ZIP。
 *
 * ## 离线、零依赖
 *
 * 这个项目是零构建的（没有 package.json、没有 node_modules），所以打包脚本
 * 也不引入任何依赖。ZIP 的写法**复用 `src/shared/zip.js`** —— 那一份已经被
 * `test/zip.test.mjs` 用**真实解压器**验过（PowerShell 的 Expand-Archive），
 * 再写一份只会多出第二处可能出错、却没人验的容器实现。
 *
 * ## 包里装什么
 *
 * 只装扩展**运行时需要**的东西：`manifest.json`、`icons/`、`src/`。
 *
 * 刻意**不装**：
 *   · `test/`、`tools/` —— 开发用，用户不需要；
 *   · `.spec-workflow/` —— 内部流程产物；
 *   · `README.md` —— 面向仓库读者，而不是装了扩展的人。
 *
 * 这不只是"省体积"：`test/repro.html` 一度被写进 `web_accessible_resources`，
 * 于是它跟着扩展一起发布了，还对所有网站可访问 —— **一个可以被网站探测到的面**。
 * 排除开发文件是让它不再有机会溜进去的第一道闸。
 *
 * 用法：
 *   node tools/package.mjs            # 产出 dist/页面元素注释-v<version>.zip
 *   node tools/package.mjs --out x.zip
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 要装进包里的顶层条目。**新增目录时必须显式加进来**，而不是反过来排除。 */
const INCLUDE = ['manifest.json', 'icons', 'src']

/**
 * 载入 `src/shared/zip.js`（浏览器里是个挂在命名空间上的 IIFE）。
 *
 * @returns {{ buildZip: (entries: Array<{name: string, bytes: Uint8Array}>) => Uint8Array }}
 */
function loadZipWriter() {
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
 * 递归收集一个文件或目录下的所有文件。
 *
 * @param {string} absolute
 * @param {string[]} out
 */
function collect(absolute, out) {
  const stats = statSync(absolute)
  if (stats.isDirectory()) {
    for (const entry of readdirSync(absolute)) {
      collect(join(absolute, entry), out)
    }
    return
  }
  out.push(absolute)
}

/**
 * 打包。
 *
 * @param {{ outPath?: string }} [options]
 * @returns {{ outPath: string, fileCount: number, bytes: number }}
 */
export function buildPackage(options) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  const zip = loadZipWriter()

  const files = []
  for (const entry of INCLUDE) {
    collect(join(root, entry), files)
  }

  const entries = files
    .map((absolute) => ({
      // ZIP 里一律用正斜杠，Windows 的反斜杠会让解压器建出错误的目录名。
      name: relative(root, absolute).split(sep).join('/'),
      bytes: new Uint8Array(readFileSync(absolute))
    }))
    // 顺序固定：同样的输入产出逐字节相同的包（zip.js 里的时间戳也是固定的）。
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const bytes = zip.buildZip(entries)

  const outPath =
    (options && options.outPath) ||
    join(root, 'dist', `页面元素注释-v${manifest.version}.zip`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, Buffer.from(bytes))

  return { outPath, fileCount: entries.length, bytes: bytes.length }
}

// 直接运行时（而不是被 import）才执行。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outIndex = process.argv.indexOf('--out')
  const built = buildPackage(outIndex !== -1 ? { outPath: process.argv[outIndex + 1] } : {})
  console.log(`已打包：${built.outPath}`)
  console.log(`  文件 ${built.fileCount} 个，${(built.bytes / 1024).toFixed(1)} KB`)
}
