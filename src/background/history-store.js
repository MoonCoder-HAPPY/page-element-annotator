// @ts-check
/**
 * 会话历史存储（service worker 侧）。
 *
 * ## 三条硬约束
 *
 * 1. **只存脱敏后的 payload。** 顺序必须是"sanitize 通过 → 存历史"。
 *    先存 raw 再脱敏会让密码在磁盘上留一份（ticket 06 的已知坑第一条）。
 * 2. **历史里存缩略图，不存原图。** 原图只用于当次写剪贴板。
 *    这是容量能否守住 8 MiB 的关键：单条记录从约 1 MB 压到约 10 KB（spec §10.5）。
 * 3. **不改名、不迁移。** `schemaVersion` 无法识别时**丢弃并按空历史重建**，
 *    只在面板上告知一次。零构建下维护迁移链的代价远高于丢历史（历史是缓存性质的数据）。
 *
 * ## 为什么每次读都从 storage 取
 *
 * MV3 的 service worker 会被回收（spec §15 R-8）。任何"常驻内存的历史"在 worker
 * 被回收后都会消失或与磁盘不一致。因此这里不带缓存，读就是读。
 */
;(function attachHistoryStore(scope) {
  'use strict'

  const ns = (scope.__EG__ = scope.__EG__ || {})

  const STORAGE_KEY = 'records'
  const SCHEMA_VERSION_KEY = 'schemaVersion'
  /** 当前 schema 版本。改动记录结构时必须同步递增，否则旧数据会被静默丢弃。 */
  const SCHEMA_VERSION = 1

  /**
   * 容量设置（可由用户在面板里改）存在这个键下。
   *
   * 与记录列表分开存：它是一条**设置**，不是一条记录 —— 混在一起的话
   * `clearHistory` 会连设置一起清掉，而且容量统计会把自己也算进去。
   */
  const SETTINGS_KEY = 'settings'

  /**
   * 硬上限。用户可调的范围被它夹住。
   *
   * 这两个数字是"防止用户把自己坑死"的兜底，不是产品默认值 ——
   * 产品默认值见 `DEFAULT_SETTINGS`（100 条 / 20 MB）。
   */
  const MAX_RECORDS = 1000
  const MAX_BYTES = 512 * 1024 * 1024
  /** 缩略图最长边。 */
  const THUMBNAIL_MAX_EDGE = 160
  /** 缩略图质量（JPEG 比 PNG 小得多，且缩略图不需要无损）。 */
  const THUMBNAIL_QUALITY = 0.7

  /**
   * 估算一条记录在存储里占多少字节。不可序列化时返回 `null`（而不是一个虚构的大数）。
   *
   * 为什么不能返回一个"很大"的替代值：`pruneRecords` 是从**尾部**（最旧）往前丢的，
   * 而它内部的字节记账按实际扣除。给坏记录一个虚构体积会让记账与实际不符，
   * 结果可能是"丢掉了好的、留下了坏的"——正是这条路径本该避免的事。
   *
   * @param {any} record
   * @returns {number|null}
   */
  function estimateRecordBytes(record) {
    try {
      const serialized = JSON.stringify(record)
      return typeof serialized === 'string' ? serialized.length : null
    } catch (error) {
      return null
    }
  }

  /**
   * 容量**默认值**。
   *
   * 用户要求默认 100 条 / 20 MB，并可在面板里自定义。
   *
   * 为什么默认值比硬上限保守：这两个数字决定"什么时候开始拦人"。定得太高，
   * 用户会在毫不知情的情况下把存储吃到配额边缘；100 条 / 20 MB 是一个既能装下
   * 一整天的工作量、又留足余量的档位。
   */
  const DEFAULT_SETTINGS = Object.freeze({
    maxRecords: 100,
    maxBytes: 20 * 1024 * 1024
  })

  /** 设置项自身的护栏：不能让用户把上限设成 0 或大到离谱。 */
  const SETTINGS_LIMITS = Object.freeze({
    minRecords: 1,
    maxRecords: 1000,
    minBytes: 1024 * 1024,
    maxBytes: 512 * 1024 * 1024
  })

  /**
   * 读设置。任何异常都退回默认值 —— 容量设置读不出来不该让整个扩展不可用。
   *
   * @returns {Promise<{ maxRecords: number, maxBytes: number }>}
   */
  async function readSettings() {
    try {
      const stored = await chrome.storage.local.get([SETTINGS_KEY])
      const raw = stored && stored[SETTINGS_KEY]
      if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_SETTINGS }
      }
      return clampSettings(raw)
    } catch (error) {
      return { ...DEFAULT_SETTINGS }
    }
  }

  /**
   * 把任意输入收敛成合法设置。
   *
   * 入口处一律收敛，而不是"存的时候校验、用的时候相信它"：
   * 存储里的值可能来自旧版本、手改、或别处的 bug，用它之前必须过一遍。
   *
   * @param {any} raw
   */
  function clampSettings(raw) {
    return {
      maxRecords: clampNumber(raw && raw.maxRecords, SETTINGS_LIMITS.minRecords, SETTINGS_LIMITS.maxRecords, DEFAULT_SETTINGS.maxRecords),
      maxBytes: clampNumber(raw && raw.maxBytes, SETTINGS_LIMITS.minBytes, SETTINGS_LIMITS.maxBytes, DEFAULT_SETTINGS.maxBytes)
    }
  }

  /**
   * 把一个可能是任何东西的输入收敛成 [min, max] 内的整数，无法识别时用默认值。
   *
   * ⚠️ 这里必须显式挡掉 `null` / `undefined` / 空字符串。
   * 原因是 `Number(null) === 0`、`Number('') === 0`，而 0 是**有限数** ——
   * 只看 `Number.isFinite` 的话，"没设置"会被当成"设成 0"，然后被夹到最小值。
   * 表现就是：存储里少一个字段，用户的上限会从 20 MB 悄悄变成 1 MB。
   * （这个坑是单元测试抓出来的，不是我推出来的。）
   *
   * @param {unknown} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   */
  function clampNumber(value, min, max, fallback) {
    if (value === null || value === undefined) {
      return fallback
    }
    if (typeof value === 'string' && value.trim() === '') {
      return fallback
    }
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) {
      return fallback
    }
    return Math.min(max, Math.max(min, Math.round(numeric)))
  }

  /**
   * 写设置。
   *
   * ## 下限是"当前已用量"，不是 1
   *
   * 用户反馈："用户当前设置的保存条数是 100，如果此时历史记录中已经存在 50 条了，
   * 但是用户此时又把这个额度调整成了 40 —— 现在的逻辑会把之前最早的 10 条删掉，
   * 这个逻辑是错误的。用户从大调小的时候，最低值必须与当前的使用量持平。"
   *
   * 判断是对的：调低上限的**意图**是"以后少存一些"，不是"现在帮我删掉一些"。
   * 悄悄删掉已有记录是用户没有要求、也无法撤销的破坏性操作。
   *
   * 所以这里把上限**向上**收敛到当前用量。想真正腾出空间，用户得自己去删记录 ——
   * 那是一个他看得见、也确认过的动作。
   *
   * 下限必须在**这一层**钉住，不能只靠界面上的 `min`：`writeSettings` 一旦被
   * 别的路径调到，界面那层就形同虚设。
   *
   * @param {any} raw
   */
  async function writeSettings(raw) {
    const wanted = clampSettings(raw)

    // 只取"用了多少"，不关心当前上限是什么。
    const { records } = await readHistory()
    let usedBytes = 0
    for (const record of records) {
      const size = estimateRecordBytes(record)
      if (size !== null) {
        usedBytes += size
      }
    }

    const settings = clampSettings({
      maxRecords: Math.max(wanted.maxRecords, records.length),
      maxBytes: Math.max(wanted.maxBytes, usedBytes)
    })

    await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
    return settings
  }

  /**
   * 当前的容量占用情况。
   *
   * 面板与内容脚本都用它判断"还能不能抓"——**在用户动手之前**判断，
   * 而不是等他写完注释再拒绝。
   *
   * @returns {Promise<{ recordCount: number, bytes: number, maxRecords: number, maxBytes: number,
   *                     atLimit: boolean, reason: string|null }>}
   */
  async function readCapacity() {
    const settings = await readSettings()
    const { records } = await readHistory()
    let bytes = 0
    for (const record of records) {
      const size = estimateRecordBytes(record)
      if (size !== null) {
        bytes += size
      }
    }
    // 判据用 `>=`：等于上限时再抓一条必然要挤掉最旧的一条，
    // 而"悄悄挤掉用户已有的记录"比"明确拒绝"更糟。
    const byCount = records.length >= settings.maxRecords
    const byBytes = bytes >= settings.maxBytes
    return {
      recordCount: records.length,
      bytes,
      maxRecords: settings.maxRecords,
      maxBytes: settings.maxBytes,
      atLimit: byCount || byBytes,
      reason: byCount ? 'records' : byBytes ? 'bytes' : null
    }
  }

  /**
   * 按条数与字节双限回收，从最旧开始删。
   *
   * 不可序列化的记录**先行剔除**：它写不进去，留着只会让每次写入都失败。
   * 这一步必须在容量判断之前做，否则虚构体积会污染记账。
   *
   * @param {any[]} records 时间倒序（最新在前）
   * @param {{ maxRecords: number, maxBytes: number }} [settings]
   * @returns {{ kept: any[], droppedCount: number, droppedBytes: number }}
   */
  function pruneRecords(records, settings) {
    if (!Array.isArray(records) || records.length === 0) {
      return { kept: [], droppedCount: 0, droppedBytes: 0 }
    }
    const limits = settings ? clampSettings(settings) : { ...DEFAULT_SETTINGS }

    /** 先剔掉不可序列化的，并记录它们的体积为 0（它们从未占用过存储）。 */
    const serializable = []
    let unserializableCount = 0
    for (const record of records) {
      const size = estimateRecordBytes(record)
      if (size === null) {
        unserializableCount++
        continue
      }
      serializable.push({ record, size })
    }

    let totalBytes = serializable.reduce(function (sum, entry) {
      return sum + entry.size
    }, 0)
    let keptCount = serializable.length
    let droppedBytes = 0

    // 从尾部（最旧）开始丢，直到条数与字节都在限内。
    while (keptCount > 0 && (keptCount > limits.maxRecords || totalBytes > limits.maxBytes)) {
      keptCount--
      totalBytes -= serializable[keptCount].size
      droppedBytes += serializable[keptCount].size
    }

    return {
      kept: serializable.slice(0, keptCount).map(function (entry) {
        return entry.record
      }),
      droppedCount: unserializableCount + (serializable.length - keptCount),
      droppedBytes
    }
  }

  /**
   * 评论清洗：去掉空白、超长截断，并且**去掉 Markdown 里能破坏结构的字符序列**。
   *
   * 评论是用户自己写的，但它会被拼进一份 Markdown 反馈块。`<`/`` ` `` 之类
   * 本身无害（它们在 Markdown 里只是普通文本），真正会破坏结构的是**没有闭合的
   * 代码围栏**——但那由导出侧的自适应围栏处理，不在这里改用户的内容。
   *
   * 这里只做两件必要的事：trim 与按预算截断。
   *
   * @param {unknown} comment
   */
  function normalizeComment(comment) {
    if (typeof comment !== 'string') {
      return null
    }
    const trimmed = comment.trim()
    if (trimmed.length === 0) {
      return null
    }
    return ns.clampStr(trimmed, ns.BUDGET.annotationCommentMaxLength)
  }

  /**
   * 从 payload 生成一条历史记录。
   *
   * @param {any} payload 已通过 sanitize 的 payload
   * @returns {any}
   */
  function createRecord(payload, options) {
    return {
      id: (options && options.id) || ns.randomId(),
      payload,
      comment: null,
      createdAt: (options && options.createdAt) || Date.now(),
      tabTitle: payload && payload.page ? payload.page.title : '',
      url: payload && payload.page ? payload.page.sanitizedUrl : ''
    }
  }

  /**
   * 生成 URL 安全的随机 id。`crypto.randomUUID` 在 service worker 与页面里都可用；
   * 退化路径用一个时间戳加随机数，够用于本地去重。
   */
  function randomId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
      }
    } catch (error) {
      // 继续走退化路径。
    }
    return 'rec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }

  /**
   * 生成缩略图（最长边 ≤160px 的 JPEG data URL）。
   *
   * 失败时返回 null：一条没有缩略图的记录仍然可用，不值得为它让整次抓取失败。
   *
   * @param {string} dataUrl 原图 PNG data URL
   * @returns {Promise<string|null>}
   */
  async function createThumbnail(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
      return null
    }
    try {
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
      const longestEdge = Math.max(bitmap.width, bitmap.height)
      const scale = longestEdge > THUMBNAIL_MAX_EDGE ? THUMBNAIL_MAX_EDGE / longestEdge : 1
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))

      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) {
        bitmap.close()
        return null
      }
      // 先铺白底：PNG 可能带 alpha，JPEG 没有 alpha 通道，不铺的话透明区会变黑。
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
      context.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()

      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMBNAIL_QUALITY })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return 'data:image/jpeg;base64,' + ns.base64FromBytes(bytes)
    } catch (error) {
      return null
    }
  }

  /**
   * 把一条历史记录压成列表用的轻量投影。
   *
   * side panel 只需要这些字段就能画出列表；把整个 payload 传过去会让
   * 面板的渲染代价随历史规模线性增长（每条 payload 可达几十 KB）。
   *
   * @param {any} record
   */
  function toListRow(record) {
    const target = record.payload && record.payload.target ? record.payload.target : {}
    const screenshot = record.payload ? record.payload.screenshot : null
    return {
      id: record.id,
      createdAt: record.createdAt,
      selector: target.selector || '',
      tagName: target.tagName || '',
      url: record.url || '',
      tabTitle: record.tabTitle || '',
      hasComment: Boolean(record.comment),
      comment: record.comment,
      thumbnail: record.thumbnail || null,
      hasScreenshot: Boolean(screenshot && screenshot.dataUrl),
      screenshotOmittedReason: record.payload ? record.payload.screenshotOmittedReason || null : null
    }
  }

  /**
   * 读历史。任何读取或解析失败都按空历史处理，并把结构问题报出来让调用方决定是否提示。
   *
   * @returns {Promise<{ records: any[], schemaMismatch: boolean }>}
   */
  async function readHistory() {
    let stored
    try {
      stored = await chrome.storage.local.get([STORAGE_KEY, SCHEMA_VERSION_KEY])
    } catch (error) {
      return { records: [], schemaMismatch: false }
    }

    const version = stored ? stored[SCHEMA_VERSION_KEY] : undefined
    if (version !== undefined && version !== SCHEMA_VERSION) {
      // 不做迁移：丢弃并按空历史重建（spec §10.5）。
      return { records: [], schemaMismatch: true }
    }
    const records = stored ? stored[STORAGE_KEY] : undefined
    if (!Array.isArray(records)) {
      return { records: [], schemaMismatch: version !== undefined }
    }
    return { records, schemaMismatch: false }
  }

  /**
   * 写历史。返回回收信息供 UI 提示一次。
   *
   * @param {any[]} records
   */
  async function writeHistory(records) {
    // 裁剪必须用**用户当前的设置**，而不是写死的常量。
    const pruned = pruneRecords(records, await readSettings())
    await chrome.storage.local.set({
      [STORAGE_KEY]: pruned.kept,
      [SCHEMA_VERSION_KEY]: SCHEMA_VERSION
    })
    return { droppedCount: pruned.droppedCount, droppedBytes: pruned.droppedBytes }
  }

  /**
   * 追加一条。历史保持时间倒序（最新在前）。
   *
   * @param {any} record
   */
  async function appendRecord(record) {
    const { records } = await readHistory()
    return await writeHistory([record].concat(records))
  }

  /**
   * 删除一条。
   * @param {string} id
   */
  async function deleteRecord(id) {
    const { records } = await readHistory()
    const next = records.filter(function (record) {
      return record.id !== id
    })
    return await writeHistory(next)
  }

  /**
   * 批量删除。
   *
   * @param {string[]} ids
   */
  async function deleteRecords(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { deletedCount: 0 }
    }
    const { records } = await readHistory()
    const next = records.filter(function (record) {
      return ids.indexOf(record.id) === -1
    })
    const result = await writeHistory(next)
    return { deletedCount: records.length - next.length, droppedCount: result.droppedCount }
  }

  /**
   * 设置评论。
   * @param {string} id
   * @param {unknown} comment
   */
  async function annotateRecord(id, comment) {
    const { records } = await readHistory()
    const normalized = normalizeComment(comment)
    const next = records.map(function (record) {
      if (record.id !== id) {
        return record
      }
      return Object.assign({}, record, { comment: normalized })
    })
    return await writeHistory(next)
  }

  async function clearHistory() {
    await chrome.storage.local.set({ [STORAGE_KEY]: [], [SCHEMA_VERSION_KEY]: SCHEMA_VERSION })
  }

  /**
   * 按当前设置回收一次。
   *
   * ⚠️ 注意它**不会**因为"用户调低了上限"就删记录 —— `writeSettings` 已经把
   * 新上限向上收敛到当前用量了。这里只在别的原因导致超限时兜底
   * （例如记录本身被别处写大、或设置从旧版本继承而来）。
   */
  async function pruneToSettings() {
    const { records } = await readHistory()
    return await writeHistory(records)
  }

  /**
   * 上限的**有效下限**：当前已用量。
   *
   * 面板要用它设置输入框的 `min`，让"调不下去"这件事在用户敲之前就看得见，
   * 而不是敲完被静默改成别的数字。
   *
   * @returns {Promise<{ minRecords: number, minBytes: number, recordCount: number, bytes: number }>}
   */
  async function readUsageFloor() {
    const { records } = await readHistory()
    let bytes = 0
    for (const record of records) {
      const size = estimateRecordBytes(record)
      if (size !== null) {
        bytes += size
      }
    }
    return { minRecords: records.length, minBytes: bytes, recordCount: records.length, bytes }
  }

  ns.HISTORY_STORAGE_KEY = STORAGE_KEY
  ns.HISTORY_SCHEMA_VERSION = SCHEMA_VERSION
  ns.HISTORY_MAX_RECORDS = MAX_RECORDS
  ns.HISTORY_MAX_BYTES = MAX_BYTES
  ns.HISTORY_SETTINGS_KEY = SETTINGS_KEY
  ns.DEFAULT_SETTINGS = DEFAULT_SETTINGS
  ns.SETTINGS_LIMITS = SETTINGS_LIMITS
  ns.readSettings = readSettings
  ns.writeSettings = writeSettings
  ns.clampSettings = clampSettings
  ns.readCapacity = readCapacity
  ns.readUsageFloor = readUsageFloor
  ns.pruneToSettings = pruneToSettings
  ns.deleteRecords = deleteRecords
  ns.THUMBNAIL_MAX_EDGE = THUMBNAIL_MAX_EDGE
  ns.estimateRecordBytes = estimateRecordBytes
  ns.pruneRecords = pruneRecords
  ns.normalizeComment = normalizeComment
  ns.createRecord = createRecord
  ns.randomId = randomId
  ns.createThumbnail = createThumbnail
  ns.toListRow = toListRow
  ns.readHistory = readHistory
  ns.writeHistory = writeHistory
  ns.appendRecord = appendRecord
  ns.deleteRecord = deleteRecord
  ns.annotateRecord = annotateRecord
  ns.clearHistory = clearHistory
})(globalThis)
