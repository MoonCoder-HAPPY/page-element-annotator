/**
 * 生成扩展图标（PNG）。
 *
 * ## 为什么需要这个脚本
 *
 * Chrome 扩展的图标必须是**位图**（PNG），不接受 SVG。而本扩展是零构建的：
 * 没有打包器、没有依赖，所以也没有 sharp / canvas 这类库可用。
 *
 * 于是这里手写一个最小 PNG 编码器：zlib 是 Node 内置的，PNG 的容器格式
 * （长度 + 类型 + 数据 + CRC）也就几十行。图形用**超采样**画：
 * 在 4 倍分辨率下逐像素判定，再平均降采样，得到干净的抗锯齿边缘 ——
 * 这对 16×16 尤其重要，那个尺寸下边缘一脏整个图标就糊了。
 *
 * ## 用法
 *
 * ```
 * node tools/make-icons.mjs
 * ```
 *
 * 产物写进 `icons/`，**已经提交进仓库**。扩展本身在运行时不跑这个脚本，
 * 它只是让图标可复现、可调整，而不是一张来路不明的图。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'icons')

// ---------------------------------------------------------------------------
// 最小 PNG 编码器
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须是 width*height*4
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型 6 = RGBA
  ihdr[10] = 0 // 压缩方法
  ihdr[11] = 0 // 过滤方法
  ihdr[12] = 0 // 非隔行

  // 每条扫描线前面加一个过滤字节。全用 0（None）：
  // 我们的图很小，压缩率无所谓，简单可靠优先。
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// 几何：签名距离场（SDF），用来画抗锯齿的圆角矩形
// ---------------------------------------------------------------------------

/**
 * 圆角矩形的有符号距离：< 0 在内部，> 0 在外部，0 在边界。
 * @returns {number} 以"归一化单位"表示的距离
 */
function roundedRectDistance(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius)
  const dy = Math.abs(py - cy) - (halfH - radius)
  const outsideX = Math.max(dx, 0)
  const outsideY = Math.max(dy, 0)
  const outside = Math.sqrt(outsideX * outsideX + outsideY * outsideY)
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/** 经典箭头光标的多边形（归一化到 0..1 的自身包围盒）。 */
const CURSOR_POLYGON = [
  [0.0, 0.0],
  [0.0, 0.78],
  [0.2, 0.6],
  [0.32, 0.94],
  [0.46, 0.88],
  [0.34, 0.55],
  [0.56, 0.55]
]

/** 射线法判断点是否在多边形内。 */
function pointInPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) {
      inside = !inside
    }
  }
  return inside
}

/** 光标在整体画布里的位置与大小。 */
const CURSOR_BOX = { x: 0.46, y: 0.4, size: 0.54 }

/**
 * 点在不在光标里。
 * @param {number} grow 把多边形围绕自身中心放大多少（用来做"间隙"）
 */
function inCursor(x, y, grow) {
  const size = CURSOR_BOX.size * (grow || 1)
  // 放大时保持中心不动，否则间隙会偏到一边去。
  const offset = (CURSOR_BOX.size - size) / 2
  const cx = (x - CURSOR_BOX.x - offset) / size
  const cy = (y - CURSOR_BOX.y - offset) / size
  if (cx < 0 || cx > 1 || cy < 0 || cy > 1) {
    return false
  }
  return pointInPolygon(cx, cy, CURSOR_POLYGON)
}

// ---------------------------------------------------------------------------
// 图案
// ---------------------------------------------------------------------------

/**
 * 在归一化坐标 (x, y) ∈ [0,1]² 上返回该点的颜色与不透明度。
 *
 * 图案 = iOS 蓝圆角方块 + 白色选择框 + 白色光标箭头。
 * 隐喻很直白：**在页面上框住一个元素并点选它** —— 就是扩展做的事。
 *
 * ## 为什么要按尺寸调参
 *
 * 同一个图案在 128px 好看，在 16px 就是一团糊：细描边（0.048 × 16 ≈ 0.77px）
 * 在那个尺寸下几乎消失，而"间隙"又把仅剩的笔画进一步吃掉。
 * 小图标要的是**粗、连、少**，所以按尺寸放宽描边、收掉间隙。
 * 这是图标设计的常规做法，不是取巧。
 *
 * @param {number} x
 * @param {number} y
 * @param {boolean} compact 小尺寸（16/32）用的加粗变体
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
function sample(x, y, compact) {
  // —— 底板：圆角方块，从上到下有极轻微的渐变（纯色会显得平）——
  const plate = roundedRectDistance(x, y, 0.5, 0.5, 0.5, 0.5, 0.235)
  if (plate > 0) {
    return { r: 0, g: 0, b: 0, a: 0 }
  }

  const top = { r: 0x0a, g: 0x84, b: 0xff } // iOS 深色模式蓝
  const bottom = { r: 0x00, g: 0x6a, b: 0xe0 }
  const t = y
  const plateColor = {
    r: Math.round(top.r + (bottom.r - top.r) * t),
    g: Math.round(top.g + (bottom.g - top.g) * t),
    b: Math.round(top.b + (bottom.b - top.b) * t),
    a: 1
  }

  // —— 顺序很重要：光标 → 间隙 → 选择框 ——
  //
  // 光标与选择框在图里必然重叠（光标就压在框的右下角上）。两个白色形状直接叠在
  // 一起会糊成一团 —— 128px 下已经看不清边界，16px 更是一块白斑。
  // 所以先给光标一圈"间隙"（把底下压回底板色），再把光标和框分别画上去。
  // 这是让叠加图标在小尺寸下仍可辨认的关键手法。
  //
  // 但小尺寸下间隙要收掉：那时每一像素都在承担识别度，留白反而是浪费。
  const haloGrow = compact ? 1 : 1.34
  if (inCursor(x, y, 1)) {
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  if (haloGrow > 1 && inCursor(x, y, haloGrow)) {
    return plateColor
  }

  // —— 选择框：白色描边的圆角矩形 ——
  const frame = roundedRectDistance(x, y, 0.42, 0.4, 0.26, 0.24, 0.08)
  const frameStroke = compact ? 0.08 : 0.048
  if (Math.abs(frame) <= frameStroke) {
    return { r: 255, g: 255, b: 255, a: 1 }
  }

  return plateColor
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 超采样倍数。16×16 下边缘质量几乎全靠它。 */
const SUPERSAMPLE = 4

/**
 * @param {number} size
 * @returns {Buffer}
 */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = SUPERSAMPLE * SUPERSAMPLE
  // 16 与 32 用加粗变体：那个尺寸下细笔画会消失。
  const compact = size <= 32

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size
          const c = sample(x, y, compact)
          // 预乘 alpha 再平均，否则半透明边缘会出现暗边。
          r += c.r * c.a
          g += c.g * c.a
          b += c.b * c.a
          a += c.a
        }
      }

      const index = (py * size + px) * 4
      if (a > 0) {
        rgba[index] = Math.round(r / a)
        rgba[index + 1] = Math.round(g / a)
        rgba[index + 2] = Math.round(b / a)
        rgba[index + 3] = Math.round((a / samples) * 255)
      }
    }
  }

  return rgba
}

mkdirSync(outDir, { recursive: true })

const SIZES = [16, 32, 48, 128]
for (const size of SIZES) {
  const png = encodePng(size, size, render(size))
  const file = join(outDir, `icon-${size}.png`)
  writeFileSync(file, png)
  console.log(`icon-${size}.png  ${png.length} 字节`)
}

console.log(`\n已写入 ${outDir}`)
