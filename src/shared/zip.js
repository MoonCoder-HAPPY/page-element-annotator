// @ts-check
/**
 * 极简 ZIP 打包器（**store 模式**，不压缩）。
 *
 * ## 为什么需要它
 *
 * 导出的 Markdown 原来在每条下面写一句"（截图已单独复制到剪贴板）" ——
 * 那是**刻意的取舍**，注释里写着理由："一张原图可达 1 MB，内联进 Markdown 会让
 * 文件既难打开也难粘贴"。
 *
 * 真机反馈说明这个取舍是错的："导出 md 的截图你也要导出啊！"
 *
 * 但直接内联同样不行：15 条记录就是 20MB 上下的 `.md`，编辑器打开就卡死。
 *
 * **正确的做法是导出成一个压缩包**：`元素注释.md` + `images/001.png`、`002.png`…
 * Markdown 里用相对路径引用。这样 `.md` 保持小而可读，截图又是**真图片文件**，
 * 解压出来直接能看、能贴进 Word。
 *
 * ## 为什么是 store 而不是 deflate
 *
 * 塞进去的图片是 PNG —— **本身已经是压缩格式**，再 deflate 一遍几乎不减小体积，
 * 却要引入一整套压缩实现（零构建项目里没有 zlib）。文本部分不大，不值得为它
 * 增加这么多代码与出错面。
 *
 * 所以这里只实现 ZIP 的**容器部分**：local header + 数据 + 中央目录 + EOCD。
 */
;(function attachZip(scope) {
  'use strict'

  /** CRC32 查表。ZIP 的每个条目都要带数据的 CRC32。 */
  const CRC_TABLE = (function buildTable() {
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      table[i] = c >>> 0
    }
    return table
  })()

  /**
   * @param {Uint8Array} bytes
   * @returns {number}
   */
  function crc32(bytes) {
    let crc = 0xffffffff
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  /**
   * ZIP 里每个条目都有 DOS 格式的时间戳。
   *
   * 用**固定值**而不是当前时间：同样的输入产出**逐字节相同**的压缩包，
   * 测试才能直接比对字节，用户重新导出也不会因为时间戳不同而看起来是"变了"。
   * 这个值对应 1980-01-01 00:00:00（DOS 时间的起点，也是 ZIP 允许的最小值）。
   */
  const DOS_TIME = 0
  const DOS_DATE = 33 // (1980-1980)<<9 | 1<<5 | 1

  /**
   * 把 UTF-8 字符串编成字节。
   *
   * @param {string} text
   * @returns {Uint8Array}
   */
  function utf8Bytes(text) {
    return new TextEncoder().encode(text)
  }

  /**
   * 把 base64（不含 data URL 前缀）解成字节。
   *
   * `atob` 给出的是 Latin-1 字符串，必须逐字节取 `charCodeAt` ——
   * 直接把字符串当字节用会把 >0x7F 的字节写坏。
   *
   * @param {string} base64
   * @returns {Uint8Array}
   */
  function base64ToBytes(base64) {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  /**
   * 写一个小端 32 位整数。
   *
   * @param {Uint8Array} target
   * @param {number} offset
   * @param {number} value
   */
  function writeUint32(target, offset, value) {
    target[offset] = value & 0xff
    target[offset + 1] = (value >>> 8) & 0xff
    target[offset + 2] = (value >>> 16) & 0xff
    target[offset + 3] = (value >>> 24) & 0xff
  }

  /**
   * 写一个小端 16 位整数。
   *
   * @param {Uint8Array} target
   * @param {number} offset
   * @param {number} value
   */
  function writeUint16(target, offset, value) {
    target[offset] = value & 0xff
    target[offset + 1] = (value >>> 8) & 0xff
  }

  /**
   * 打包成一个 ZIP。
   *
   * @param {Array<{ name: string, bytes: Uint8Array }>} entries
   *   条目顺序就是包里的顺序。`name` 用 `/` 分隔，可以带目录。
   * @returns {Uint8Array}
   */
  function buildZip(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      // 空包也要能产出合法的 ZIP（EOCD 自身就是一个合法空包）。
      entries = []
    }

    /** @type {Array<{ nameBytes: Uint8Array, data: Uint8Array, crc: number, offset: number }>} */
    const prepared = []
    let offset = 0

    // —— 第一遍：算出每个条目的 local header 偏移与总长 ——
    for (const entry of entries) {
      const nameBytes = utf8Bytes(entry.name)
      const data = entry.bytes
      prepared.push({
        nameBytes,
        data,
        crc: crc32(data),
        offset
      })
      // local header 固定 30 字节 + 文件名 + 数据
      offset += 30 + nameBytes.length + data.length
    }

    const centralDirectoryOffset = offset
    let centralDirectorySize = 0
    for (const item of prepared) {
      centralDirectorySize += 46 + item.nameBytes.length
    }

    const total = centralDirectoryOffset + centralDirectorySize + 22
    const out = new Uint8Array(total)
    let cursor = 0

    // —— 第二遍：写 local header + 数据 ——
    for (const item of prepared) {
      writeUint32(out, cursor, 0x04034b50) // local file header 签名
      writeUint16(out, cursor + 4, 20) // 解压所需版本 2.0
      // 0x0800 = 文件名是 UTF-8。中文文件名（"元素注释.md"）必须开这一位，
      // 否则解压出来是乱码。
      writeUint16(out, cursor + 6, 0x0800)
      writeUint16(out, cursor + 8, 0) // 压缩方法 0 = store
      writeUint16(out, cursor + 10, DOS_TIME)
      writeUint16(out, cursor + 12, DOS_DATE)
      writeUint32(out, cursor + 14, item.crc)
      writeUint32(out, cursor + 18, item.data.length) // 压缩后大小
      writeUint32(out, cursor + 22, item.data.length) // 原始大小
      writeUint16(out, cursor + 26, item.nameBytes.length)
      writeUint16(out, cursor + 28, 0) // extra field 长度
      out.set(item.nameBytes, cursor + 30)
      out.set(item.data, cursor + 30 + item.nameBytes.length)
      cursor += 30 + item.nameBytes.length + item.data.length
    }

    // —— 第三遍：中央目录 ——
    const centralStart = cursor
    for (const item of prepared) {
      writeUint32(out, cursor, 0x02014b50) // central directory 签名
      writeUint16(out, cursor + 4, 20) // 创建者版本
      writeUint16(out, cursor + 6, 20) // 解压所需版本
      writeUint16(out, cursor + 8, 0x0800) // 同样标 UTF-8
      writeUint16(out, cursor + 10, 0)
      writeUint16(out, cursor + 12, DOS_TIME)
      writeUint16(out, cursor + 14, DOS_DATE)
      writeUint32(out, cursor + 16, item.crc)
      writeUint32(out, cursor + 20, item.data.length)
      writeUint32(out, cursor + 24, item.data.length)
      writeUint16(out, cursor + 28, item.nameBytes.length)
      writeUint16(out, cursor + 30, 0) // extra
      writeUint16(out, cursor + 32, 0) // 注释
      writeUint16(out, cursor + 34, 0) // 起始磁盘号
      writeUint16(out, cursor + 36, 0) // 内部属性
      writeUint32(out, cursor + 38, 0) // 外部属性
      writeUint32(out, cursor + 42, item.offset)
      out.set(item.nameBytes, cursor + 46)
      cursor += 46 + item.nameBytes.length
    }

    // —— 第四遍：EOCD ——
    writeUint32(out, cursor, 0x06054b50)
    writeUint16(out, cursor + 4, 0) // 本磁盘号
    writeUint16(out, cursor + 6, 0) // 中央目录起始磁盘号
    writeUint16(out, cursor + 8, prepared.length)
    writeUint16(out, cursor + 10, prepared.length)
    writeUint32(out, cursor + 12, centralDirectorySize)
    writeUint32(out, cursor + 16, centralStart)
    writeUint16(out, cursor + 20, 0) // 注释长度

    return out
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.buildZip = buildZip
  scope.__EG__.zipCrc32 = crc32
  scope.__EG__.base64ToBytes = base64ToBytes
})(globalThis)
