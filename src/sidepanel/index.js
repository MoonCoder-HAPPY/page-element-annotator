// @ts-check
/**
 * 侧边面板：会话历史、评论、批量导出。
 *
 * ## 安全约定：只用 textContent，不用 innerHTML
 *
 * 面板渲染的一切都来自页面：选择器、HTML 片段、用户评论。用 `innerHTML` 拼接
 * 等于把页面内容当成 HTML 执行——那是一个直接的注入面。这里全部走
 * `document.createElement` + `textContent`，没有例外。
 *
 * ## 与 service worker 的分工
 *
 * 面板**不做任何存储操作**，也不生成缩略图：那些都在 service worker 里。
 * 面板只负责画与发消息。这样 R-8（MV3 worker 会被回收）的影响面被限制在
 * 一个地方，而不是散落在两个上下文里。
 */
;(function attachSidePanel() {
  'use strict'

  const ns = globalThis.__EG__

  /**
   * 两步确认的复位时间。
   *
   * 超时是必需的：没有它，一次误点会让按钮**长期**停在"确认删除？"，
   * 之后任何一次点击都会真的删掉 —— 那比不确认更危险。
   */
  const CONFIRM_TIMEOUT_MS = 4000

  /** @type {any[]} */
  let rows = []
  /** 展开状态按 id 记录，重渲染后保持不变。 */
  const expandedIds = new Set()
  /** 勾选状态同理。 */
  const selectedIds = new Set()
  /** 评论草稿，避免重渲染时丢字。 */
  const commentDrafts = new Map()

  /**
   * 待保存的评论：id → { text, status }。
   *
   * 存在的意义是"每一条改动都有据可查"：输入停顿、失焦、面板关闭、以及
   * 复制/导出/删除之前，都要能把还没落库的内容立刻写下去。
   */
  const pendingCommentSaves = new Map()
  /** 每条评论各自的防抖定时器。 */
  const commentSaveTimers = new Map()

  /** 输入停顿多久后自动保存。太短会边打字边写盘，太长会让"打了字就走"丢内容。 */
  const COMMENT_AUTOSAVE_DEBOUNCE_MS = 700

  const recordsElement = document.getElementById('records')
  const emptyElement = document.getElementById('empty')
  const noMatchElement = document.getElementById('no-match')
  const filterNoteElement = document.getElementById('filter-note')
  const recordSearch = document.getElementById('record-search')
  // 标题右侧那条统计（「N 条 · 缩略图约 X MB」）已按用户要求删除。
  // 条数在「全选（N）」那一行已经有了，缩略图字节数是个几乎恒为 0.00 的估算 ——
  // 两样都不值得占标题旁边的位置。
  const noticeElement = document.getElementById('notice')
  const exportButton = document.getElementById('export-selected')
  const clearButton = document.getElementById('clear-all')
  const startElementNoteButton = document.getElementById('start-element-note')
  const startElementNoteLabel = document.getElementById('start-element-note-label')
  // 悬停入口已按用户要求删除，相关的 DOM 引用与整套 mode 机制一起清掉了。
  const shotDiagElement = document.getElementById('shot-diag')
  const shotDiagPanel = document.getElementById('shot-diag-panel')
  const shotDiagClearButton = document.getElementById('shot-diag-clear')
  const shotDiagReloadButton = document.getElementById('shot-diag-reload')
  const grantRow = document.getElementById('grant-row')
  const grantHostButton = document.getElementById('grant-host')
  const selectAllRow = document.getElementById('select-all-row')
  const selectAllCheckbox = document.getElementById('select-all')
  const selectAllLabel = document.getElementById('select-all-label')
  const themeSwitch = document.getElementById('theme-switch')
  const capacityLine = document.getElementById('capacity-line')
  const settingRange = document.getElementById('setting-range')

  /**
   * 重新拉一次容量设置并重画输入框。
   *
   * 由 `wireCapacitySettings()` 赋值，`renderChrome()` 在记录数变化时调用。
   *
   * 为什么必须重拉：输入框的**下限 = 当前已用量**。抓到新记录之后用量变大了，
   * 但 `renderSettings` 只在面板加载时跑过一次 —— 不重拉的话下限仍是旧值，
   * 于是"调低到低于用量"这条路在界面这层又敞开了（worker 那层还会兜住，
   * 但用户会看到自己填的数字被悄悄改掉，而不是敲的时候就改）。
   *
   * @type {null | (() => void)}
   */
  let reloadCapacitySettings = null
  /** 上一次重取容量设置时的记录数。只有变了才重取，避免每次重渲染都发一条消息。 */
  let lastCapacityRecordCount = -1
  const settingMaxRecords = document.getElementById('setting-max-records')
  const settingMaxBytes = document.getElementById('setting-max-bytes')
  const settingSave = document.getElementById('setting-save')
  const settingReset = document.getElementById('setting-reset')

  /**
   * @param {string} type
   * @param {any} [payload]
   */
  async function send(type, payload) {
    return await chrome.runtime.sendMessage(Object.assign({ type }, payload || {}))
  }

  /**
   * 由**面板自己**写文本剪贴板。
   *
   * 不能让 service worker 写：MV3 worker 不是文档，`navigator.clipboard` 在那里是
   * undefined（真机报错 `Cannot read properties of undefined (reading 'writeText')`）。
   * 面板是带文档的扩展页面，用户这一下点击也带来了激活上下文，所以这里可用。
   *
   * @param {string} text
   * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
   */
  async function writeTextToClipboard(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, reason: '要复制的内容是空的' }
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      return { ok: false, reason: '剪贴板 API 不可用' }
    }
    try {
      await navigator.clipboard.writeText(text)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 由面板自己写图片剪贴板。
   *
   * @param {string} dataUrl
   * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
   */
  async function writeImageToClipboard(dataUrl) {
    if (typeof ClipboardItem === 'undefined') {
      return { ok: false, reason: '这个环境不支持 ClipboardItem' }
    }
    if (!navigator.clipboard || !navigator.clipboard.write) {
      return { ok: false, reason: '剪贴板 API 不可用' }
    }
    try {
      const blob = await (await fetch(dataUrl)).blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * @param {string} text
   */
  function escapeHtmlForClipboard(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  /**
   * **一次**写入：文字与截图放在**同一个**剪贴板条目里。
   *
   * ## 为什么必须是一次
   *
   * 用户已经报过一次这个 bug："我在 word 里面马上粘贴复制的内容，结果发现只有截图，
   * 没有其它的任何描述了。"
   *
   * 系统剪贴板是**单槽位**的：一个条目、多个"表示"。任何一次写入都会**替换**掉
   * 之前的内容 —— 先写文本、再写图片，最后只剩图片。
   *
   * ## 三个表示
   *
   *   · `text/plain` —— 纯文本编辑器
   *   · `text/html`  —— **文字 + 内嵌截图**。这是"在一起"的关键：
   *     Word / 飞书 / Notion 粘 HTML 时两者一起拿到
   *   · `image/png`  —— 只吃图片的目标
   *
   * @param {{ text: string, imageDataUrl?: string|null }} payload
   * @returns {Promise<{ ok: true, wrote: string[] } | { ok: false, reason: string }>}
   */
  async function writeRichToClipboard(payload) {
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (text.length === 0) {
      return { ok: false, reason: '要复制的内容是空的' }
    }
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
      // 没有富文本通道就退回纯文本 —— 至少把最重要的那部分送出去。
      const fallback = await writeTextToClipboard(text)
      return fallback.ok ? { ok: true, wrote: ['text/plain'] } : fallback
    }

    /** @type {Record<string, Blob>} */
    const representations = {
      'text/plain': new Blob([text], { type: 'text/plain' })
    }

    const imageDataUrl =
      typeof payload.imageDataUrl === 'string' && payload.imageDataUrl !== ''
        ? payload.imageDataUrl
        : null

    if (imageDataUrl) {
      representations['text/html'] = new Blob(
        [
          '<div style="font:13px/1.6 -apple-system,system-ui,sans-serif;white-space:pre-wrap">' +
            escapeHtmlForClipboard(text) +
            '</div>' +
            '<div style="margin-top:8px"><img src="' +
            imageDataUrl +
            '" alt="元素截图" style="max-width:100%"></div>'
        ],
        { type: 'text/html' }
      )
      try {
        representations['image/png'] = await (await fetch(imageDataUrl)).blob()
      } catch (error) {
        // 图片解码失败不该让整次复制失败：文字那一半仍然要送出去。
      }
    }

    try {
      await navigator.clipboard.write([new ClipboardItem(representations)])
      return { ok: true, wrote: Object.keys(representations) }
    } catch (error) {
      const fallback = await writeTextToClipboard(text)
      if (!fallback.ok) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true, wrote: ['text/plain'] }
    }
  }

  /**
   * 空闲时显示的标语。
   *
   * 用户要求："这个提示的地方常驻在前台，如果用户没有任何操作就显示我这个插件的 slogan。"
   *
   * 提示位常驻有个额外好处：它出现/消失**不会让下面的内容上下跳** ——
   * 原来它是 `hidden` 的，每次操作都会把列表推下去一点。
   */
  const SLOGAN = '精准锚定页面元素，一键注释直达 AI。'

  /**
   * 操作反馈显示多久后自动回落到标语。
   *
   * 没有这个回落，"常驻"就会变成"上一次操作的提示永远挂在那儿"——
   * 用户要的是"没有操作时看到 slogan"，而不是"上一次操作的结果永不消失"。
   */
  const NOTICE_REVERT_MS = 4000
  /** @type {ReturnType<typeof setTimeout>|null} */
  let noticeRevertTimer = null

  function showNotice(text) {
    if (noticeRevertTimer !== null) {
      clearTimeout(noticeRevertTimer)
      noticeRevertTimer = null
    }

    noticeElement.textContent = text
    // 永久可见：不再设 `hidden`。
    noticeElement.hidden = false
    // 标语与操作反馈在**视觉上要分得开**：前者是介绍，后者是结果。
    // 用同一套样式会让标语看起来像"刚刚发生了一件事"。
    const isSlogan = text === SLOGAN
    noticeElement.classList.toggle('muted', isSlogan)

    if (!isSlogan) {
      noticeRevertTimer = setTimeout(function () {
        noticeRevertTimer = null
        showNotice(SLOGAN)
      }, NOTICE_REVERT_MS)
    }
  }

  function clearNotice() {
    showNotice(SLOGAN)
  }

  /**
   * 相对时间。面板里"3 分钟前"比 ISO 时间更容易扫读。
   * @param {number} timestamp
   */
  function formatRelativeTime(timestamp) {
    const elapsed = Date.now() - timestamp
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      return '刚刚'
    }
    const seconds = Math.floor(elapsed / 1000)
    if (seconds < 60) {
      return '刚刚'
    }
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) {
      return `${minutes} 分钟前`
    }
    const hours = Math.floor(minutes / 60)
    if (hours < 24) {
      return `${hours} 小时前`
    }
    const days = Math.floor(hours / 24)
    return `${days} 天前`
  }

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) {
      node.className = className
    }
    if (text !== undefined) {
      node.textContent = text
    }
    return node
  }

  /**
   * 一个"标签 + 等宽值"的字段块。值走 textContent。
   * @param {string} label
   * @param {string} value
   */
  /**
   * 详情里**可能很长**的那几项，折叠时的最大高度。
   *
   * 用户反馈："详情里面的 文本、HTML、计算样式这三个内容里面的东西可能会很多，
   * 所以你需要设置一个固定的高度，如果超过这个高度就仅展示固定高度的内容，
   * 用户想要查看所有的就点击各自文本旁边的箭头展开按钮。"
   *
   * 判断是对的：HTML 片段与计算样式动辄几十行，全铺开会让一条记录占满整屏，
   * 而**真正需要看全的只是少数时候**。
   *
   * 120px ≈ 8 行等宽小字：够看出"这是什么东西"，又不至于淹没其它字段。
   */
  const COLLAPSED_VALUE_MAX_PX = 120

  /**
   * 一行 `标签: 值`。
   *
   * 值过长时折叠到固定高度，并在标签旁边给一个箭头按钮展开/收起。
   *
   * ## 为什么按钮放在**标签**旁边而不是值旁边
   *
   * 值本身可能宽到折行、也可能被折叠区域裁掉。按钮跟着值走的话，
   * 它会随内容宽度浮动，位置不稳定；放在标签那一列则是每行固定的一竖条，
   * 扫一眼就能知道哪几项是可以展开的。
   *
   * ## 折叠与否靠**实测**，不靠字符数
   *
   * 用字符数阈值会误判：同样的字符数，等宽字体下折行数可能差一倍。
   * 这里先按折叠态插进去，再量 `scrollHeight > clientHeight` —— 量出来才算数。
   *
   * @param {string} label
   * @param {string} value
   */
  function field(label, value) {
    const wrapper = element('div', 'kv')
    wrapper.appendChild(element('span', 'kv-key', label))

    const valueNode = element('span', 'kv-value kv-collapsible', value)
    valueNode.style.maxHeight = COLLAPSED_VALUE_MAX_PX + 'px'
    wrapper.appendChild(valueNode)

    // 插进文档之后才有布局可量。用 rAF 等一帧，避免在 appendChild 之前
    // 读到恒为 0 的尺寸（那时节点还不在布局树里）。
    requestAnimationFrame(function () {
      if (valueNode.scrollHeight <= COLLAPSED_VALUE_MAX_PX + 2) {
        // 没超出就**不留按钮**：一个按下去没有任何变化的按钮比没有更糟。
        valueNode.classList.remove('kv-collapsible')
        valueNode.style.maxHeight = ''
        return
      }

      valueNode.classList.add('kv-clipped')

      const toggle = element('button', 'kv-toggle', '▸')
      toggle.type = 'button'
      toggle.setAttribute('aria-expanded', 'false')
      toggle.setAttribute('aria-label', `展开「${label}」的完整内容`)
      toggle.title = '展开 / 收起'
      toggle.addEventListener('click', function () {
        const expanded = !valueNode.classList.contains('kv-expanded')
        valueNode.classList.toggle('kv-expanded', expanded)
        valueNode.classList.toggle('kv-clipped', !expanded)
        // ⚠️ 必须同时改**内联的 max-height**。
        //
        // 折叠高度是在 `field()` 里以内联样式设的，而内联样式**优先级高于类**。
        // 只加一个 class 去掉不了它 —— 展开后高度纹丝不动（第一版就是这样：
        // 箭头转了、可内容还是被裁着，看起来像按钮坏了）。
        valueNode.style.maxHeight = expanded ? 'none' : COLLAPSED_VALUE_MAX_PX + 'px'
        toggle.textContent = expanded ? '▾' : '▸'
        toggle.setAttribute('aria-expanded', String(expanded))
        toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}「${label}」的完整内容`)
      })
      // 跟在标签后面 —— 见上面关于位置的说明。
      wrapper.insertBefore(toggle, valueNode)
    })

    return wrapper
  }

  /**
   * @param {string} id
   */
  function findRecordRow(id) {
    return rows.find(function (row) {
      return row.id === id
    })
  }

  /**
   * 重新取一次历史并重渲染。
   */
  async function refresh() {
    const response = await send('history.list')
    if (!response || response.ok !== true) {
      showNotice('读取历史失败')
      return
    }
    // 记住上一次的记录集合：用来判断这次能不能就地更新而不是重建。
    const previousRows = rows
    rows = response.result.rows
    if (response.result.schemaMismatch) {
      // 版本不可识别时丢弃重建，只告知一次（不报错）。
      showNotice('历史数据版本已变更，已重置为空历史。')
    }
    // 清理已不存在条目的勾选与展开状态，避免选中数虚高。
    const alive = new Set(
      rows.map(function (row) {
        return row.id
      })
    )
    for (const id of Array.from(selectedIds)) {
      if (!alive.has(id)) {
        selectedIds.delete(id)
      }
    }
    for (const id of Array.from(expandedIds)) {
      if (!alive.has(id)) {
        expandedIds.delete(id)
      }
    }
    for (const id of Array.from(commentDrafts.keys())) {
      if (!alive.has(id)) {
        commentDrafts.delete(id)
      }
    }

    // 记录变化后可能有一些勾选项**已经不在当前筛选结果里**了。
    // 不摘掉的话，"导出所选"会动到用户屏幕上找不到的记录 ——
    // 这与"动作只作用于看得见的内容"直接矛盾。
    syncSelectionToVisible()

    // 记录集合没变、展开状态也没变 → **就地更新，不重建**。
    //
    // 这是"编辑注释后滚动跳顶"的对策。机制是：整表重建时
    // `renderDetail` 会先建一个**空的**详情容器、内容稍后才异步填回 ——
    // 所有已展开的详情区同时变空，内容高度骤降，浏览器把滚动位置夹到顶部，
    // 等详情填回来也回不去了。记录越少、高度越依赖展开区，这个塌缩越明显
    // （真机反馈："展开以后就会，就几条"）。
    //
    // 自动刷新最常见的触发源是**我们自己写了一条注释**（写存储 → onChanged
    // → 这里）。那种情况下记录集合根本没变，本来就不该整表重建：
    // 重建还会顺带摧毁用户正在编辑的输入框、把光标弄丢。
    // 结构不动，高度就不会塌缩，滚动位置自然保持 —— 不是"重建后恢复"，
    // 而是**根本不发生**。
    if (canUpdateInPlace(previousRows)) {
      updateRowsInPlace()
      renderChrome()
      return
    }

    render()
  }

  /**
   * 记录集合与顺序是否与上一次完全一致。
   *
   * 一致才允许就地更新：id 变了、顺序变了、条数变了，都可能影响 DOM 结构
   * （比如条数变化会让"全选"行出现或消失），那时必须重建。
   *
   * @param {any[]} previous
   */
  function canUpdateInPlace(previous) {
    if (!Array.isArray(previous) || previous.length !== rows.length || rows.length === 0) {
      return false
    }
    for (let i = 0; i < rows.length; i++) {
      if (previous[i].id !== rows[i].id) {
        return false
      }
    }
    // 列表区是否真的渲染出来了：首次进入时还没有 DOM，必须走重建。
    return recordsElement.children.length === rows.length
  }

  /**
   * 就地更新每行的可变字段（标题、元信息、缩略图），不碰 DOM 结构。
   *
   * 只更新"会变的那几处"，不重建节点 —— 详情区、正在编辑的输入框、
   * 滚动位置全都不受影响。
   */
  function updateRowsInPlace() {
    for (const row of rows) {
      const item = recordsElement.querySelector('.record[data-record-id="' + row.id + '"]')
      if (!item) {
        continue
      }

      const hasComment = typeof row.comment === 'string' && row.comment.trim().length > 0
      const title = item.querySelector('.record-title')
      if (title) {
        if (hasComment) {
          title.classList.remove('as-selector')
          title.textContent = row.comment
        } else {
          title.classList.add('as-selector')
          title.textContent = row.selector || row.tagName || '(未知)'
        }
      }

      const meta = item.querySelector('.record-meta')
      if (meta) {
        // 元信息：时间 + 选择器。
        //
        // ⚠️ 这里**不再**带「含截图」三个字（用户要求："冗余显示了"）。
        // 列表里每一条几乎都有截图，标出来等于没标，还把时间挤到角落。
        // 缩略图本身就是"有没有截图"最直接的表达。
        meta.textContent = formatRelativeTime(row.createdAt)
        if (hasComment) {
          meta.appendChild(
            element('span', 'record-selector', ' · ' + (row.selector || row.tagName || '(未知)'))
          )
        }
      }

      const thumb = item.querySelector('img.record-thumb')
      if (row.thumbnail && thumb) {
        thumb.src = row.thumbnail
      }
    }
  }

  /**
   * 更新列表之外的静态部分（计数、按钮可用性、全选三态）。
   *
   * 单独抽出来，让"就地更新"与"整表重建"两条路径共用同一套状态同步 ——
   * 否则很容易只在其中一条里改了按钮状态，另一条就悄悄不同步了。
   */
  function renderChrome() {
    // 列表区是否渲染由调用方决定（`render` 只渲染筛出来的那些）。
    // 这里处理的是"全部记录为空"与"筛完一条不剩"这两种不同的空态。
    const visible = visibleRows()
    const filtering = searchQuery.trim() !== ''

    emptyElement.hidden = rows.length > 0
    noMatchElement.hidden = !(rows.length > 0 && visible.length === 0)
    // 有余量时把筛选状态写在列表上方，免得用户以为记录丢了。
    filterNoteElement.hidden = !(filtering && visible.length > 0)
    if (!filterNoteElement.hidden) {
      filterNoteElement.textContent = `筛选中：显示 ${visible.length} / ${rows.length} 条`
    }

    // 记录数变了就重取一次容量设置：输入框的下限 = 当前已用量，
    // 而用量跟着记录数走。不重取的话下限会停在旧值上。
    if (rows.length !== lastCapacityRecordCount) {
      lastCapacityRecordCount = rows.length
      if (typeof reloadCapacitySettings === 'function') {
        reloadCapacitySettings()
      }
    }

    const selectedCount = selectedIds.size
    // ⚠️ 判据是**筛出来的条数**，不是全部记录数 ——
    // 全选/导出/清空都得作用于用户看到的那几条。
    const hasVisible = visible.length > 0
    const selecting = selectedCount > 0

    exportButton.disabled = !hasVisible
    clearButton.disabled = !hasVisible

    // ⚠️ 只**复位**，不直接写文案。
    //
    // 导出现在是两步确认（`armTwoStepConfirm`）。如果这里直接赋
    // `textContent`，按钮停在「确认导出？」时文案会被改回「导出全部」，
    // 但确认器内部的 `armed` 仍是 true —— **下一次点击就直接执行了**，
    // 比没有确认更危险。
    //
    // 文案由确认器通过 idleLabel 函数每次重算（见下面 armTwoStepConfirm 那段），
    // 所以这里只要让它复位就行。`clearButton` 一直是这个做法。
    if (typeof exportButton.__resetConfirm === 'function') {
      exportButton.__resetConfirm()
    }
    if (typeof clearButton.__resetConfirm === 'function') {
      clearButton.__resetConfirm()
    }

    selectAllRow.hidden = rows.length === 0
    if (rows.length > 0) {
      // 三态按**可见**条数算：筛出 3 条、全勾上时全选框就该是勾上的。
      selectAllCheckbox.checked = hasVisible && selectedCount === visible.length
      selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < visible.length
      if (selectedCount > 0) {
        // 数字两边不留空格：`已选 100 / 100` 比 `已选 100/100` 宽约 10px，
        // 而这一行旁边还住着搜索框 —— 窄面板里每个字都占位置。
        selectAllLabel.textContent = filtering
          ? `已选 ${selectedCount}/${visible.length}`
          : `已选 ${selectedCount}/${rows.length}`
      } else {
        // 筛选时也用 `全选（N）`，N 是**可见条数**，不再另造一个「全选结果（N）」。
        //
        // 两种理由：一是那个措辞要多占约 17px（`全选结果（100）` 实测 129px），
        // 而这一行的宽度必须固定、不能随文案变；二是范围本来就已经由列表下方的
        // 「筛选中：显示 1 / 3 条」说清了，按钮上再写一遍是重复。
        selectAllLabel.textContent = `全选（${visible.length}）`
      }
    }
  }

  /**
   * 面板的滚动容器。
   *
   * 是 `.scroll-area`，**不是**文档本身 —— 文档已经被设成 `overflow: hidden`，
   * 滚动全部发生在那个内层容器里（这样滚动条出现/消失不会挤压其它元素）。
   * 拿错容器会让"保住滚动位置"那套逻辑静默失效（读到恒为 0 的值）。
   */
  function scroller() {
    return document.querySelector('.scroll-area') || document.documentElement
  }

  function render() {
    // 保住滚动位置。
    //
    // 真机反馈"修改注释以后滚动条会突然跳回顶部"。整表重建时列表会被清空，
    // 高度瞬间塌陷，浏览器把滚动位置夹到顶部，之后再填回内容也回不去。
    //
    // 常见的触发源已经由 `refresh()` 的就地更新路径消除了（记录集合没变时
    // **根本不重建**）。这里是兜底：新抓一条、删除一条这类确实需要重排的情况
    // 仍会走重建，那时至少让位置回到原处。
    //
    // ⚠️ 诚实标注：这一处我**没能用测试证明必需** —— 在 harness 里撤掉它，
    // 断言照样通过。留下它是因为代价极低、原理上无害。
    const scrollTop = scroller().scrollTop

    recordsElement.textContent = ''
    renderChrome()

    for (const row of visibleRows()) {
      recordsElement.appendChild(renderRow(row))
    }

    if (scrollTop > 0) {
      scroller().scrollTop = scrollTop
    }
  }

  /**
   * 两步确认：第一次点击把按钮变成「确认删除？」，第二次才真的执行。
   *
   * ## 为什么不用 `window.confirm`
   *
   * - 面板是一块**常驻的窄栏**，原生模态框会打断整个面板，而且样式不可控；
   * - 它在这个上下文里的可靠性没有保证（面板不是普通标签页）；
   * - 它的返回值只能区分"确定/取消"，无法表达"你到底在确认哪一条"。
   *
   * 行内确认把"要删的是哪一条"留在原位：按钮就在那一行上，用户看得到对象。
   *
   * ## 超时自动复位
   *
   * 没有超时的话，一次误点会让按钮**长期**停在"确认删除？"状态，
   * 之后任何一次点击都会真的删掉 —— 那就比不确认更危险。
   *
   * @param {HTMLButtonElement} button
   * @param {string|(() => string)} idleLabel
   *   可以是函数：清空按钮的文案随勾选状态变（「清空」/「清空所选」），
   *   而它的**确认态**文案不变 —— 确认的是"要不要执行"这件事，不是执行什么。
   * @param {string} confirmLabel
   * @param {() => void} onConfirm
   */
  function armTwoStepConfirm(button, idleLabel, confirmLabel, onConfirm) {
    let armed = false
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null

    function currentIdleLabel() {
      return typeof idleLabel === 'function' ? idleLabel() : idleLabel
    }

    function reset() {
      armed = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      button.textContent = currentIdleLabel()
      button.classList.remove('armed')
      button.setAttribute('aria-label', currentIdleLabel())
    }

    // ⚠️ **鼠标一离开就复位**（用户要求）。
    //
    // 用户原话："当用户点击以后会显示二次确认的按钮，目前当用户不想清空/删除的话，
    // 那么二次确认的按钮会等待几秒钟才关闭，我希望当用户的鼠标从二次确认的按钮上
    // 离开就立即恢复成原来的按钮和功能，这样体感会更好。"
    //
    // 判断是对的：**"把鼠标移开"本身就是"我不确认"这个意图的表达**。
    // 让用户为了取消而干等几秒，是在惩罚一个已经很清楚的决定。
    //
    // 用 `mouseleave` 而不是 `mouseout`：前者只在离开**按钮本身**时触发，
    // 不会因为移到按钮内部的子节点而误触发。
    //
    // 也刻意不用 `pointerleave`：触摸屏上手指抬起就会发它，于是第一次点完
    // 立刻复位 —— 两次点击的确认在触屏上根本用不了。
    //
    // 超时**保留**作兜底：鼠标停在原地不动、或用键盘操作时，
    // 按钮不该永远停在「确认…」上。
    button.addEventListener('mouseleave', reset)

    button.addEventListener('click', function () {
      if (!armed) {
        armed = true
        button.textContent = confirmLabel
        button.classList.add('armed')
        button.setAttribute('aria-label', confirmLabel)
        timer = setTimeout(reset, CONFIRM_TIMEOUT_MS)
        return
      }
      // 第二次点击：先复位再执行，避免执行过程中按钮停在"确认"态。
      reset()
      onConfirm()
    })

    // 暴露给测试与"别处发生刷新时复位"用。
    button.__resetConfirm = reset
  }

  /**
   * 打开截图预览。
   *
   * ## 三个方案的取舍（用户逐一反馈过）
   *
   * 1. **面板内浮层**：面板只有约 320px，一张 1000px 宽的截图在那里怎么放大
   *    都看不清 —— 被否掉；
   * 2. **新标签页**：看得清，但会**离开正在注释的页面** —— 用户点缩略图时
   *    想的是"我刚抓的这个长什么样"，跳走再跳回来是额外的成本 —— 被否掉；
   * 3. **当前页面里的浮层**（现在这个）：页面占满主区域、宽度够用，
   *    而且不打断手上的事。用户的原话是"直接在当前页面打开，增加一个浮层显示"。
   *
   * 动作交给 worker：它要负责"这个页面可能还没注入过内容脚本"这件事
   * （冷启动时很常见），面板自己做不了。
   */
  function openScreenshot(id) {
    void (async function () {
      const response = await send('preview.show', { id })
      if (response && response.ok === true) {
        return
      }
      const error = (response && response.error) || {}
      if (error.code === 'needs_host_permission') {
        grantRow.hidden = false
      }
      showNotice(error.message || '打开预览失败，请重试')
    })()
  }

  /**
   * @param {any} row
   */
  function renderRow(row) {
    const item = element('li', 'record')
    // 自动保存后要做"只更新这一行的标题"的定点更新，所以行上要能按 id 定位。
    item.dataset.recordId = row.id

    const head = element('div', 'record-head')

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'record-check'
    checkbox.checked = selectedIds.has(row.id)
    checkbox.setAttribute('aria-label', `选择 ${row.selector || row.tagName}`)
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) {
        selectedIds.add(row.id)
      } else {
        selectedIds.delete(row.id)
      }
      render()
    })
    head.appendChild(checkbox)

    if (row.thumbnail) {
      const thumbnail = document.createElement('img')
      thumbnail.className = 'record-thumb'
      thumbnail.src = row.thumbnail
      thumbnail.alt = ''
      // 缩略图可点开看大图。加个"可放大"的语义给屏幕阅读器，
      // 视觉上靠 cursor: zoom-in 提示（见 CSS）。
      thumbnail.title = '点开看大图'
      thumbnail.setAttribute('role', 'button')
      thumbnail.setAttribute('tabindex', '0')
      thumbnail.setAttribute('aria-label', '查看该元素的大图')
      thumbnail.addEventListener('click', function (event) {
        event.preventDefault()
        openScreenshot(row.id)
      })
      thumbnail.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openScreenshot(row.id)
        }
      })
      head.appendChild(thumbnail)
    } else {
      head.appendChild(element('div', 'record-thumb', '▢'))
    }

    const summary = element('div', 'record-summary')

    // 主行放**用户写的注释**，没有注释时才退回选择器。
    // 理由（用户反馈）：注释是这个人自己说的话，是他在列表里唯一用来"认出这条"的东西；
    // 而 `div:nth-of-type(1)` 这种选择器在一屏里往往长得差不多，当标题等于没有标题。
    const hasComment = typeof row.comment === 'string' && row.comment.trim().length > 0
    const title = element('span', 'record-title')
    if (hasComment) {
      title.textContent = row.comment
    } else {
      // 没有注释时选择器就是主行 —— 加一个类让它的等宽字体与断行行为正确。
      title.classList.add('as-selector')
      title.textContent = row.selector || row.tagName || '(未知)'
    }
    summary.appendChild(title)

    // 元信息：时间 + 选择器。
    //
    // ⚠️ 这里**不再**带「含截图」三个字（用户要求："冗余显示了"）——
    // 见上面 `renderRow` 里同一处的说明。
    const meta = element('span', 'record-meta')
    meta.appendChild(element('span', '', formatRelativeTime(row.createdAt)))
    if (hasComment) {
      const selectorInMeta = element(
        'span',
        'record-selector',
        ' · ' + (row.selector || row.tagName || '(未知)')
      )
      meta.appendChild(selectorInMeta)
    }
    summary.appendChild(meta)
    head.appendChild(summary)

    const toggle = element('button', 'record-toggle', expandedIds.has(row.id) ? '收起' : '详情')
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', String(expandedIds.has(row.id)))
    toggle.setAttribute('aria-label', `展开或收起 ${row.selector || row.tagName} 的详情`)
    toggle.addEventListener('click', function () {
      if (expandedIds.has(row.id)) {
        expandedIds.delete(row.id)
      } else {
        expandedIds.add(row.id)
      }
      render()
    })
    head.appendChild(toggle)

    item.appendChild(head)

    if (expandedIds.has(row.id)) {
      item.appendChild(renderDetail(row))
    }
    return item
  }

  /**
   * @param {any} row
   */
  function renderDetail(row) {
    const body = element('div', 'record-body')

    const detailContainer = element('div')
    body.appendChild(detailContainer)

    // 详情是按需读取的：列表投影不含完整 payload，避免面板随历史规模变慢。
    void send('history.detail', { id: row.id }).then(function (response) {
      detailContainer.textContent = ''
      if (!response || response.ok !== true) {
        detailContainer.appendChild(element('div', 'reason', '读取详情失败'))
        return
      }
      renderDetailContent(detailContainer, row, response.result)
    })

    // 评论：**自动保存**，没有保存按钮。
    //
    // 保存按钮本质上是在要求用户替机器做一件机器该做的事。三层覆盖所有出口：
    //
    //   1. 输入停顿 700ms  → 存（用户打了字就坐在那里，也算数）
    //   2. 失焦            → 立刻存（点了别处）
    //   3. 面板隐藏/关闭    → 立刻存（最常见的"没失焦就直接关掉面板"）
    //   另加：复制/导出/删除等动作前先 flush，保证拿到的内容是最新的。
    //
    // 关键约束：**保存后不能整表重渲染** —— 那会重建 DOM 并把光标从输入框里踢走，
    // 用户正打字时会被打断。所以保存只在内存里更新，结构需要变化时延到失焦后再做。
    const commentWrapper = element('div', 'comment-block')
    const commentInput = document.createElement('textarea')
    commentInput.className = 'comment-input'
    commentInput.placeholder = '补一句说明（会写进导出的 Markdown）'
    commentInput.value = commentDrafts.has(row.id) ? commentDrafts.get(row.id) : row.comment || ''
    commentInput.maxLength = ns.BUDGET.annotationCommentMaxLength
    commentInput.setAttribute('aria-label', '该元素的反馈')
    commentInput.dataset.recordId = row.id

    const commentStatus = element('span', 'comment-status', '')

    commentInput.addEventListener('input', function () {
      commentDrafts.set(row.id, commentInput.value)
      pendingCommentSaves.set(row.id, { text: commentInput.value, status: commentStatus })
      setCommentStatus(commentStatus, '')
      scheduleCommentSave(row.id)
    })

    commentInput.addEventListener('blur', function () {
      void flushCommentSave(row.id)
    })

    commentWrapper.appendChild(commentInput)
    commentWrapper.appendChild(commentStatus)
    body.appendChild(commentWrapper)

    const actions = element('div', 'record-actions')

    /*
     * 「复制全部」：文字与截图**一次**复制到同一个剪贴板条目。
     *
     * 放在「复制文本」**左边**（用户要求）—— 它是这个动作组里最常用的一个，
     * 而且"复制文本 / 复制截图"是它的两个部分，排在一起读得通。
     *
     * ⚠️ 必须走 `writeRichToClipboard`（一次写入多表示）。
     * 分两次写的话第二次会覆盖第一次 —— 那个 bug 已经报过一次了
     * （"粘贴出来只有截图，没有其它的任何描述"）。
     */
    const copyAllButton = element('button', 'mini', '复制全部')
    copyAllButton.type = 'button'
    copyAllButton.setAttribute(
      'aria-label',
      '把文本上下文与截图一起复制（粘进 Word / 飞书时两者都在）'
    )
    copyAllButton.addEventListener('click', function () {
      void (async function () {
        // 先落库再复制：用户"写完直接点复制"是常态，
        // 不 flush 的话复制到的是上一次保存的旧注释。
        await flushCommentSave(row.id)
        const textResponse = await send('clipboard.copyText', { id: row.id })
        if (!textResponse || textResponse.ok !== true) {
          showNotice('复制失败，请重试')
          return
        }

        // 截图是可选的一半：没有截图时**只复制文本**并如实说明，
        // 而不是整个失败 —— 文字是这条记录里最重要的部分。
        let dataUrl = null
        let wantedImage = false
        if (row.hasScreenshot) {
          wantedImage = true
          const shotResponse = await send('clipboard.copyScreenshot', { id: row.id })
          if (shotResponse && shotResponse.ok === true) {
            dataUrl = shotResponse.result.dataUrl
          }
        }

        const writeResult = await writeRichToClipboard({
          text: textResponse.result.text,
          imageDataUrl: dataUrl
        })
        if (!writeResult.ok) {
          showNotice(`复制失败：${writeResult.reason}`)
          return
        }

        const wroteImage = (writeResult.wrote || []).some((t) => String(t).startsWith('image/'))
        if (wantedImage && !wroteImage) {
          showNotice('已复制文本（截图没能一起放进剪贴板）')
        } else if (wroteImage) {
          showNotice('已复制文本与截图（同一份，粘一次两者都在）')
        } else {
          showNotice('已复制文本（这条没有截图）')
        }
      })()
    })
    actions.appendChild(copyAllButton)

    const copyTextButton = element('button', 'mini', '复制文本')
    copyTextButton.type = 'button'
    copyTextButton.setAttribute('aria-label', '重新复制该元素的文本上下文')
    copyTextButton.addEventListener('click', function () {
      void (async function () {
        // 先落库再复制：用户"写完直接点复制"是常态，
        // 不 flush 的话复制到的是上一次保存的旧注释 —— 这是去掉保存按钮后
        // 最容易出的错，也是这个按钮必须最早 flush 的原因。
        await flushCommentSave(row.id)
        const response = await send('clipboard.copyText', { id: row.id })
        if (!response || response.ok !== true) {
          showNotice('复制失败，请重试')
          return
        }
        const writeResult = await writeTextToClipboard(response.result.text)
        showNotice(writeResult.ok ? '已复制文本' : `复制失败：${writeResult.reason}`)
      })()
    })
    actions.appendChild(copyTextButton)

    const copyScreenshotButton = element('button', 'mini', '复制截图')
    copyScreenshotButton.type = 'button'
    copyScreenshotButton.disabled = !row.hasScreenshot
    copyScreenshotButton.setAttribute('aria-label', '重新复制该元素的截图')
    copyScreenshotButton.addEventListener('click', function () {
      void (async function () {
        const response = await send('clipboard.copyScreenshot', { id: row.id })
        if (!response || response.ok !== true) {
          showNotice('复制截图失败，请重试')
          return
        }
        const writeResult = await writeImageToClipboard(response.result.dataUrl)
        showNotice(writeResult.ok ? '已复制截图' : `复制截图失败：${writeResult.reason}`)
      })()
    })
    actions.appendChild(copyScreenshotButton)

    const deleteButton = element('button', 'mini danger', '删除')
    deleteButton.type = 'button'
    deleteButton.setAttribute('aria-label', '删除这条记录')
    // 删除不可逆，必须二次确认。
    // 用行内两步而不是 window.confirm：按钮就长在这一行上，
    // 用户看得见"我确认的是哪一条"。
    armTwoStepConfirm(deleteButton, '删除', '确认删除？', function () {
      void (async function () {
        // 要删的行上可能有还没落库的评论；先 flush 再删，
        // 否则用户刚写的内容会连同这一条一起悄悄消失（虽然结果一样，但
        // 中间那次写入失败会被"删除成功"掩盖，很难排查）。
        await flushCommentSave(row.id)
        await send('history.delete', { id: row.id })
        // 删完给一句反馈：列表会少一条，但"少了"本身就容易被忽略。
        await refresh()
        showNotice('已删除该记录')
      })()
    })
    actions.appendChild(deleteButton)

    // 没有截图时说明原因：放在动作行右边，不再单独占一整行。
    // （不允许静默消失，但也不必用一整块版面说一件事。）
    if (!row.hasScreenshot && row.screenshotOmittedReason) {
      actions.appendChild(
        element('span', 'shot-reason', ns.describeScreenshotOmission(row.screenshotOmittedReason))
      )
    }

    body.appendChild(actions)

    return body
  }

  /**
   * 这条诊断是不是"出了问题"。
   *
   * 只看阶段名里有没有 `failed` 是不够的：最该被看见的一条是
   * `extract:sanitized` + `kept: false` —— 名字里没有任何"失败"字样，
   * 但它恰恰意味着截图被净化拒掉了。所以同时看内容。
   *
   * @param {any} entry
   */
  function diagnosticLooksBad(entry) {
    const stage = String((entry && entry.stage) || '')
    if (stage.indexOf('failed') !== -1 || stage.indexOf('rejected') !== -1) {
      return true
    }
    const detail = entry && entry.detail
    if (!detail || typeof detail !== 'object') {
      return false
    }
    if (detail.kept === false) {
      return true
    }
    if (detail.omittedReason) {
      return true
    }
    if (detail.screenshotIsObject === false) {
      return true
    }
    // data URL 体检结果：不是 PNG 前缀就是全链路第一处异常。
    for (const key of ['returned', 'incoming', 'keptDataUrl', 'redactedSelfCheck']) {
      const inspected = detail[key]
      if (inspected && typeof inspected === 'object' && inspected.startsWithPng === false) {
        return true
      }
    }
    return false
  }

  /**
   * 渲染截图管道诊断。
   *
   * 每条记录是一个阶段，按时间顺序。关键是能看到**真实的 data URL 前缀与长度**——
   * 真机上截图一直失败，只有这些中间产物能指出是哪一步把图弄丢了。
   *
   * @param {any[]} entries
   */
  function renderShotDiagnostics(entries) {
    shotDiagElement.textContent = ''

    const list = Array.isArray(entries) ? entries : []

    // 诊断面板**平时隐藏**，只在最近这些记录里存在失败时自动出现。
    //
    // 为什么保留而不是删掉：截图曾经连续好几轮失败，全靠这块逐阶段记录才定位到
    // 根因（一个跨上下文缺失的常量）。删掉它，下次再出问题我就只能靠猜。
    // 但也确实不该一直占着面板底部 —— 截图正常时它没有任何价值。
    // 于是：正常时隐藏，异常时**自己出现**，用户不用去找。
    //
    // 判据用 `diagnosticLooksBad`（成功/失败阶段的分色就是它决定的），
    // 而不是"看有没有 `omittedReason`"之类的另一套规则 —— 两套规则迟早会不一致。
    const hasFailure = list.some(function (entry) {
      return diagnosticLooksBad(entry)
    })
    shotDiagPanel.hidden = !hasFailure

    if (list.length === 0) {
      shotDiagElement.appendChild(
        element(
          'div',
          'diag-empty',
          '还没有记录。点上面的「清空并重抓一次」，然后到页面上抓一个元素，回来刷新。'
        )
      )
      return
    }

    for (const entry of list) {
      const box = element('div', 'diag-entry')
      box.appendChild(
        element(
          'div',
          'stage ' + (diagnosticLooksBad(entry) ? 'bad' : 'ok'),
          String(entry.stage || '(未知阶段)')
        )
      )
      box.appendChild(
        element('pre', '', `${entry.at || ''}\n${JSON.stringify(entry.detail, null, 1)}`)
      )
      shotDiagElement.appendChild(box)
    }
  }

  async function loadShotDiagnostics() {
    const response = await send('screenshotDiagnostics.get')
    if (!response || response.ok !== true) {
      shotDiagElement.textContent = ''
      shotDiagElement.appendChild(element('div', 'diag-empty', '读取诊断失败。'))
      return
    }
    renderShotDiagnostics(response.result.entries)
  }

  /**
   * @param {HTMLElement} node
   * @param {string} text
   * @param {boolean} [isError]
   */
  function setCommentStatus(node, text, isError) {
    node.textContent = text
    node.classList.toggle('bad', Boolean(isError))
  }

  /**
   * 某个输入框是否正被编辑。
   *
   * 用来决定"能不能重渲染"：重渲染会重建 DOM，把光标从正在打字的框里踢走。
   */
  function isCommentInputFocused() {
    const active = document.activeElement
    return Boolean(active && active.classList && active.classList.contains('comment-input'))
  }

  /**
   * 排一次防抖保存。
   * @param {string} id
   */
  function scheduleCommentSave(id) {
    const existing = commentSaveTimers.get(id)
    if (existing !== undefined) {
      clearTimeout(existing)
    }
    const timer = setTimeout(function () {
      commentSaveTimers.delete(id)
      void flushCommentSave(id)
    }, COMMENT_AUTOSAVE_DEBOUNCE_MS)
    commentSaveTimers.set(id, timer)
  }

  /**
   * 立刻把某条待保存的评论写下去。
   *
   * @param {string} id
   * @returns {Promise<boolean>} 是否成功（没有待保存内容时也算成功）
   */
  async function flushCommentSave(id) {
    const pending = pendingCommentSaves.get(id)
    if (!pending) {
      return true
    }
    const existing = commentSaveTimers.get(id)
    if (existing !== undefined) {
      clearTimeout(existing)
      commentSaveTimers.delete(id)
    }

    // 先摘掉待保存标记：写入期间用户继续打字会重新排一次，不能被他覆盖掉。
    pendingCommentSaves.delete(id)
    setCommentStatus(pending.status, '保存中…')

    const response = await send('history.annotate', { id, comment: pending.text })
    if (!response || response.ok !== true) {
      // 失败要**留下来**，下次任何一次 flush 还会重试；同时如实显示。
      pendingCommentSaves.set(id, pending)
      setCommentStatus(pending.status, '保存失败', true)
      return false
    }

    const row = rows.find(function (candidate) {
      return candidate.id === id
    })
    if (row) {
      const hadComment = typeof row.comment === 'string' && row.comment.trim().length > 0
      const hasCommentNow = pending.text.trim().length > 0
      row.comment = pending.text
      commentDrafts.delete(id)

      // 主行显示的是"注释还是选择器"这个**结构**变了才需要换掉整行。
      // 两个约束：
      // - 必须等焦点离开输入框再做，否则会把用户的光标踢走；
      // - **只换这一行**，不要 `render()` 整表 —— 整表重建会让列表高度瞬间塌成 0，
      //   滚动位置被夹到顶部，用户看到的就是"编辑完滚动条突然跳回顶部"。
      if (hadComment !== hasCommentNow && !isCommentInputFocused()) {
        const oldItem = recordsElement.querySelector('.record[data-record-id="' + id + '"]')
        if (oldItem) {
          oldItem.replaceWith(renderRow(row))
        } else {
          render()
        }
        return true
      }
      // 结构没变就直接更新那一行的标题文字：用户能立刻看到自己的话变成了标题，
      // 又不用付重建 DOM 的代价。
      if (hasCommentNow) {
        const titleNode = recordsElement.querySelector(
          '.record[data-record-id="' + id + '"] .record-title'
        )
        if (titleNode) {
          titleNode.textContent = pending.text
        }
      }
    }
    setCommentStatus(pending.status, '已保存')
    return true
  }

  /**
   * 把所有待保存的评论立刻写下去。
   *
   * 复制/导出/删除这类动作之前都要先调它 —— 否则用户"写完直接点复制"
   * 拿到的会是上一次保存的旧内容（这正是去掉保存按钮后最容易出的错）。
   */
  async function flushAllCommentSaves() {
    const ids = Array.from(pendingCommentSaves.keys())
    let allOk = true
    for (const id of ids) {
      const ok = await flushCommentSave(id)
      if (!ok) {
        allOk = false
      }
    }
    return allOk
  }

  /**
   * @param {HTMLElement} container
   * @param {any} row
   * @param {any} detail
   */
  function renderDetailContent(container, row, detail) {
    const target = detail.target || {}
    if (target.elementPath) {
      container.appendChild(field('可读路径', target.elementPath))
    }
    if (target.sourceFile) {
      container.appendChild(field('源码', target.sourceFile))
    }
    if (target.reactComponents) {
      container.appendChild(field('组件', target.reactComponents))
    }
    if (target.cssClasses) {
      container.appendChild(field('class', target.cssClasses))
    }
    if (target.textSnippet) {
      container.appendChild(field('文本', target.textSnippet))
    }
    if (target.htmlSnippet) {
      container.appendChild(field('HTML', target.htmlSnippet))
    }
    const styleLines = ns.buildStyleLines(target.computedStyles || {})
    if (styleLines.length > 0) {
      container.appendChild(field('计算样式', styleLines.join('\n')))
    }
    if (detail.ancestorPath && detail.ancestorPath.length > 0) {
      container.appendChild(field('祖先路径', detail.ancestorPath.join(' > ')))
    }
    if (row.url) {
      container.appendChild(field('页面', row.url))
    }
  }

  selectAllCheckbox.addEventListener('change', function () {
    // ⚠️ 遍历的是 **visibleRows()**，不是 `rows`。
    //
    // 这里曾经写的是 `for (const row of rows)` —— 而 `renderChrome` 里显示的三态
    // 与计数早就改成按**筛选结果**算了。于是界面显示「全选结果（1）」，
    // 点下去却把整个历史都勾上了：显示与动作用了两套判据。
    //
    // 用户反馈的真机现象正是这个："我对当前搜索出来的结果进行全选的操作的时候，
    // 会选到所有的历史记录。"
    //
    // 现在两条路径共用同一个 `visibleRows()` —— 用户看到几条，动作就作用于几条。
    if (selectAllCheckbox.checked) {
      for (const row of visibleRows()) {
        selectedIds.add(row.id)
      }
    } else {
      // 取消时也只摘掉**当前可见**的那些：它们才是这个复选框代表的范围。
      for (const row of visibleRows()) {
        selectedIds.delete(row.id)
      }
    }
    render()
  })


  /**
   * 容量设置。
   *
   * 默认 100 条 / 20 MB（用户指定）。输入框用 MB 而不是字节：
   * 让人填 20971520 这种数字等于逼他算错。
   */
  function wireCapacitySettings() {
    const MB = 1024 * 1024

    /**
     * 超出上下限就**当场改成边界值**，并短暂标红。
     *
     * 用户要求："超出上限以后应该自动将输入的内容转成最大值。"
     *
     * 为什么在这里做而不是只靠 `<input max>`：`max` 只在表单校验时生效，
     * 用户照样能敲出 99999 并看着它留在框里 —— 直到点保存才被后端收敛，
     * 那时他会以为"我明明填了 99999"。当场改掉，反馈是即时的、看得见的。
     *
     * 边界值从元素属性读，不在 JS 里另抄一份：两边各写一份就会漂移 ——
     * 改了 HTML 忘了改 JS，用户就会遇到"输入被改成另一个数字"。
     *
     * @param {HTMLInputElement} input
     * @returns {boolean} 是否发生了收敛
     */
    function clampInputToLimits(input) {
      const raw = input.value.trim()
      if (raw === '') {
        input.classList.remove('clamped')
        return false
      }
      const value = Number(raw)
      if (!Number.isFinite(value)) {
        input.classList.remove('clamped')
        return false
      }
      const min = Number(input.min)
      const max = Number(input.max)
      let clamped = Math.round(value)
      if (Number.isFinite(max) && clamped > max) {
        clamped = max
      }
      if (Number.isFinite(min) && clamped < min) {
        clamped = min
      }
      if (clamped === Math.round(value)) {
        input.classList.remove('clamped')
        return false
      }
      input.value = String(clamped)
      input.classList.add('clamped')
      // 标红只是提示"我给你改了"，不是错误状态，所以很快褪掉。
      setTimeout(function () {
        input.classList.remove('clamped')
      }, 1200)
      return true
    }

    for (const input of [settingMaxRecords, settingMaxBytes]) {
      input.addEventListener('input', function () {
        clampInputToLimits(input)
      })
      input.addEventListener('blur', function () {
        clampInputToLimits(input)
      })
    }

    /**
     * @param {any} info
     */
    function renderSettings(info) {
      const settings = info.settings
      const capacity = info.capacity
      // 有效下限 = **当前已用量**。
      //
      // 用户要求："用户从大调小的时候，最低值必须与当前的使用量持平。"
      // 把下限设在输入框的 `min` 上，用户敲的时候就会被收敛到用量，
      // 而不是敲完 40 才发现系统帮他删了旧记录。
      //
      // 占用量的下限要**向上取整**：填的是整数 MB，而用量是精确字节 ——
      // 用 12.3 MB 时下限必须是 13，否则填 12 仍然低于用量。
      const floorRecords = Math.max(
        info.limits.minRecords,
        Math.max(capacity.recordCount, (info.floor && info.floor.minRecords) || 0)
      )
      const floorBytes = Math.max(
        Math.round(info.limits.minBytes / MB),
        Math.ceil(((info.floor && info.floor.minBytes) || capacity.bytes) / MB)
      )

      settingMaxRecords.value = String(settings.maxRecords)
      settingMaxBytes.value = String(Math.round(settings.maxBytes / MB))
      settingMaxRecords.max = String(info.limits.maxRecords)
      settingMaxBytes.max = String(Math.round(info.limits.maxBytes / MB))
      settingMaxRecords.min = String(floorRecords)
      settingMaxBytes.min = String(floorBytes)

      const mb = (value) => (value / MB).toFixed(1)
      const reached = capacity.atLimit ? '（已达上限）' : ''
      capacityLine.textContent =
        `已用 ${capacity.recordCount} / ${capacity.maxRecords} 条 · ` +
        `${mb(capacity.bytes)} / ${mb(capacity.maxBytes)} MB${reached}`
      capacityLine.classList.toggle('bad', capacity.atLimit)

      /*
       * 取值范围提示。
       *
       * ⚠️ 这里写的是**绝对范围**（常量），不是"有效下限 = 当前已用量"。
       *
       * 用户要求换成："取值范围：条数 1–1000，空间 1–512 MB；
       * 超出自动按边界适配，下调上限不影响已有记录。"
       *
       * 那两个数字与 `SETTINGS_LIMITS` 完全对得上（minRecords 1 / MAX_RECORDS 1000，
       * minBytes 1 MB / maxBytes 512 MB），所以直接用常量，**不再用手算出来的
       * `floorRecords` / `floorBytes`** —— 那样一旦常量改了，这行文案会跟着漂。
       *
       * 注意输入框的 `min` 仍然是**有效下限**（`floorRecords` 那一套）：
       * 上限不能低于已经存下来的量，否则就等于"调低上限会删记录"。
       * 敲更小的数时会被收敛回有效下限，`clampInputToLimits` 会把它标红一下。
       */
      settingRange.textContent =
        `取值范围：条数 ${info.limits.minRecords}–${info.limits.maxRecords}，` +
        `空间 ${Math.round(info.limits.minBytes / MB)}–${Math.round(info.limits.maxBytes / MB)} MB；` +
        `超出自动按边界适配，下调上限不影响已有记录。`
    }

    void (async function load() {
      const response = await send('settings.get')
      if (response && response.ok === true) {
        renderSettings(response.result)
      }
    })()

    reloadCapacitySettings = function () {
      void (async function () {
        const response = await send('settings.get')
        if (response && response.ok === true) {
          renderSettings(response.result)
        }
      })()
    }

    settingSave.addEventListener('click', function () {
      void (async function () {
        // 提交前再收敛一次：用户可能没触发过 input（例如用脚本填的值）。
        clampInputToLimits(settingMaxRecords)
        clampInputToLimits(settingMaxBytes)

        // 空值要当成"不改"而不是 0：清空输入框时 Number('') === 0，
        // 直接提交会把上限设成最小值，那是个很难理解的意外。
        const recordsRaw = settingMaxRecords.value.trim()
        const bytesRaw = settingMaxBytes.value.trim()
        if (recordsRaw === '' || bytesRaw === '') {
          showNotice('两个上限都要填数字')
          return
        }
        const response = await send('settings.set', {
          settings: {
            maxRecords: Number(recordsRaw),
            maxBytes: Number(bytesRaw) * MB
          }
        })
        if (!response || response.ok !== true) {
          showNotice('保存设置失败，请重试')
          return
        }
        // 保存后用**服务端返回的值**重画：worker 会把上限向上收敛到当前用量，
        // 所以这里显示的可能是被改过的数字（例如你想填 40、实际存下 50）。
        // 拿回显去画，用户看到的才是真实生效的值。
        const fresh = await send('settings.get')
        if (fresh && fresh.ok === true) {
          renderSettings(fresh.result)
        }
        await refresh()
        showNotice('容量设置已保存')
      })()
    })

    settingReset.addEventListener('click', function () {
      void (async function () {
        const current = await send('settings.get')
        if (!current || current.ok !== true) {
          return
        }
        const response = await send('settings.set', { settings: current.result.defaults })
        if (response && response.ok === true) {
          // 同样用服务端回显重画：若当前用量已经超过默认值（100 条 / 20 MB），
          // 恢复默认同样会被向上收敛，界面要如实反映。
          const fresh = await send('settings.get')
          if (fresh && fresh.ok === true) {
            renderSettings(fresh.result)
          }
          await refresh()
          showNotice('已恢复默认容量（100 条 / 20 MB）')
        }
      })()
    })
  }

  // 搜索。
  //
  // 输入时不重建 DOM 是不可能的：筛掉的行必须真的从列表里消失。但**不 await**、
  // 直接同步 render，所以每次按键的重排都很短；记录规模在 100 条上限内，够用。
  //
  // 关键副作用：换搜索词时要把**已经看不见的 id 从勾选里摘掉**。留着它们会让
  // "已选 3"里混进用户在屏幕上找不到的记录，之后导出/清空就会动到他看不见的东西。
  recordSearch.addEventListener('input', function () {
    searchQuery = recordSearch.value
    syncSelectionToVisible()
    render()
  })

  function syncSelectionToVisible() {
    const visible = new Set(
      visibleRows().map(function (row) {
        return row.id
      })
    )
    for (const id of Array.from(selectedIds)) {
      if (!visible.has(id)) {
        selectedIds.delete(id)
      }
    }
  }

  wireCapacitySettings()

  /**
   * 外观主题的三段切换。
   *
   * 真正的逻辑在 `theme.js`（它必须在首屏绘制前跑），这里只负责把按钮状态
   * 与当前偏好同步 —— 包括"跟随系统"时用户改了系统主题，按钮仍要对得上。
   */
  function wireThemeSwitch() {
    const theme = ns.theme
    if (!theme || !themeSwitch) {
      return
    }

    const buttons = Array.from(themeSwitch.querySelectorAll('button'))

    function syncPressed() {
      const current = theme.readPreference()
      for (const button of buttons) {
        button.setAttribute('aria-pressed', String(button.dataset.themeValue === current))
      }
    }

    for (const button of buttons) {
      button.addEventListener('click', function () {
        theme.set(/** @type {any} */ (button.dataset.themeValue))
      })
    }

    // theme.js 在应用主题后会回调订阅者（包括系统主题变化引起的那种），
    // 所以按钮状态总是跟着真实偏好走，不会和实际显示不一致。
    theme.subscribe(syncPressed)
    syncPressed()
  }

  wireThemeSwitch()

  /**
   * 当前"操作对象"的 id 列表。
   *
   * 三种情况：
   *   勾了记录   → 那些 id
   *   有搜索词   → **搜索结果**的 id（"全部"在筛选状态下指"全部符合搜索的"）
   *   都没有     → `undefined`，由 worker 展开成完整列表
   *
   * 为什么筛选时要显式发 id 而不是让 worker 去筛：搜索是**面板侧**的状态，
   * worker 不知道用户敲了什么。把"哪些算全部"的判据留在产生它的那一侧，
   * 两边就不需要各自维护一套相同的匹配规则（那种重复迟早会漂移）。
   *
   * @returns {string[]|undefined}
   */
  function targetIds() {
    if (selectedIds.size > 0) {
      return Array.from(selectedIds)
    }
    if (searchQuery.trim() !== '') {
      return visibleRows().map(function (row) {
        return row.id
      })
    }
    return undefined
  }

  /** 当前搜索词（小写、已去首尾空白）。 */
  let searchQuery = ''

  /**
   * 一条记录是否命中搜索词。
   *
   * 搜索范围 = **用户在列表里看得到的内容**：标题行（注释或选择器）、
   * 页面标题、URL、标签名。只匹配"标题"会漏掉一个常见动作 ——
   * 用户记得某个元素在哪个页面上，但记不清注释写了什么。
   *
   * @param {any} row
   * @param {string} query 已经小写化
   */
  function matchesQuery(row, query) {
    const fields = [row.comment, row.selector, row.tagName, row.tabTitle, row.url]
    for (const field of fields) {
      if (typeof field === 'string' && field.toLowerCase().indexOf(query) !== -1) {
        return true
      }
    }
    return false
  }

  /**
   * 经过搜索过滤后的记录。
   *
   * 所有"全选 / 导出 / 清空"都以此为准 —— 用户看到几条，动作就作用于几条。
   * 让动作绕过筛选去作用于看不见的记录，是这类界面最容易出的错。
   */
  function visibleRows() {
    const query = searchQuery.trim().toLowerCase()
    if (query === '') {
      return rows
    }
    return rows.filter(function (row) {
      return matchesQuery(row, query)
    })
  }

  // 导出也要二次确认（用户要求："导出全部需要用户二次确认，避免误触"）。
  //
  // 用与清空/删除**同一个** `armTwoStepConfirm` —— 三处动作长得一样，
  // 用户不用为每一处学一种确认方式。
  armTwoStepConfirm(
    exportButton,
    function () {
      // 文案随"有没有勾选"与"有没有在搜索"变。
      //
      // 筛选状态下"全部"指的是**全部搜索结果**，所以点明这一点，
      // 避免用户以为会导出整个历史。
      if (selectedIds.size > 0) {
        return '导出所选'
      }
      return searchQuery.trim() !== '' ? '导出结果' : '导出全部'
    },
    '确认导出？',
    function () {
      void (async function () {
        // 导出前把所有待保存的评论写下去：导出的 Markdown 要带上用户刚写的内容。
        await flushAllCommentSaves()
        const ids = targetIds()
        const response = await send('history.export', { ids })
        if (!response || response.ok !== true) {
          const error = (response && response.error) || {}
          showNotice(error.message || '导出失败，请重试')
          return
        }

        /*
         * 下载**由面板发起**，不是 worker。
         *
         * 导出的是一个 ZIP（Markdown + 每条一张真 PNG），几兆是常态。
         * worker 里没有 `URL.createObjectURL`（它不是文档），只能走 data URL ——
         * 而多兆的 data URL 当下载地址并不可靠。面板是文档，能建 blob URL。
         *
         * ⚠️ `revokeObjectURL` 不能紧跟 `download()` 调用：下载是异步取字节的，
         * 立刻撤销会让它拿到一个已经失效的地址。延迟撤销（并在窗口关闭时兜底）
         * 是这里唯一稳的做法。
         */
        const result = response.result
        let downloadUrl = null
        try {
          const bytes = ns.base64ToBytes(result.base64)
          const blob = new Blob([bytes], { type: 'application/zip' })
          downloadUrl = URL.createObjectURL(blob)
          await chrome.downloads.download({
            url: downloadUrl,
            filename: result.filename,
            saveAs: true
          })
        } catch (error) {
          showNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`)
          return
        } finally {
          if (downloadUrl) {
            const url = downloadUrl
            setTimeout(function () {
              try {
                URL.revokeObjectURL(url)
              } catch (revokeError) {
                // 已经撤销过了：无关紧要。
              }
            }, 60000)
          }
        }

        const scope = ids ? `所选 ${result.count} 条` : `全部 ${result.count} 条`
        const images = result.imageCount > 0 ? `，含 ${result.imageCount} 张截图` : ''
        showNotice(`已导出 ${scope}${images} → ${result.filename}`)
      })()
    }
  )
  // 清空不可逆，用行内两步确认（AC-14）。
  // 不用 `window.confirm`：那在常驻的窄面板里会打断整个界面，
  // 而且和删除按钮的确认方式不一致 —— 两个不可逆操作应该长得一样。
  //
  // 语义随勾选状态变：没勾选 → 清空全部；勾了 → 清空所选。
  // 文案用函数传入，让它每次都读当前选择，而不是在初始化时定死。
  //
  // 这里**不 flush 待保存的评论**：要删的东西留着先写一遍毫无意义。
  // 但要把防抖定时器清掉，避免它们稍后对着已经不存在的记录再发一次写入。
  armTwoStepConfirm(
    clearButton,
    function () {
      // 不带数量：数量已经在「已选 N / 总数」那一行，按钮上重复一遍是冗余。
      return selectedIds.size > 0 ? '清空所选' : '清空'
    },
    '确认清空？',
    function () {
      void (async function () {
        const ids = targetIds()
        const count = selectedIds.size
        for (const timer of commentSaveTimers.values()) {
          clearTimeout(timer)
        }
        commentSaveTimers.clear()
        pendingCommentSaves.clear()

        const response = await send('history.clear', { ids })
        if (!response || response.ok !== true) {
          showNotice('清空失败，请重试')
          return
        }

        // 只删所选时，展开状态与评论草稿也要跟着清 —— 否则它们会挂在不存在的 id 上，
        // 下一次偶然出现同 id（几乎不可能，但状态残留本身就是隐患）会莫名其妙地展开。
        for (const id of ids || []) {
          expandedIds.delete(id)
          commentDrafts.delete(id)
        }
        selectedIds.clear()
        clearNotice()
        await refresh()
        showNotice(ids ? `已删除所选 ${count} 条` : '历史已清空')
      })()
    }
  )

  // 「进入抓取模式」：面板现在常驻，所以要有个地方开始抓取
  // （点图标改成开面板之后，弹窗那套入口就没了）。
  //
  // ⚠️ 这条入口与快捷键有一个**本质差别**，值得写下来：
  // Chrome 的 `activeTab` 只在"用户调用扩展"时授予（点图标、快捷键、右键菜单），
  // 并且**标签页导航就会撤销**。快捷键每次按都是一次新调用，所以一直能用；
  // 而面板是常驻的 —— "点图标 → 页面导航 → 回面板点按钮"这条常见路径上
  // 根本没有授权，注入会被拒（真机报错：17/17 个文件注入失败，
  // `Cannot access contents of the page`）。
  //
  // 所以这里不能只报错，必须给出补救：申请长期 host 授权（manifest 已声明
  // `optional_host_permissions`，spec §9.4 批准的）。
  // 请求的 origin **必须与 manifest 的 `optional_host_permissions` 对得上** ——
  // 超出声明范围的请求会被 Chrome 直接拒绝。
  //
  // 这里用 `<all_urls>` 而不是 `http://*/*` + `https://*/*`：后者只能覆盖
  // `scripting.executeScript`，而 `captureVisibleTab` 认的是 `<all_urls>`。
  // 真机上就是这么表现的：用户按提示授权了、注入确实好了，但**截图仍然失败**，
  // 而且报错要求他再授权一次他刚做过的事。
  const HOST_ORIGINS = ['<all_urls>']

  /** 只有 http/https 页面才值得提供授权按钮。 */
  function isWebPage(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url)
  }

  function hideGrantRow() {
    grantRow.hidden = true
  }

  /** 抓取模式当前是否开着。按钮文案与行为都由它决定。 */
  let grabArmed = false
  /*
   * 这里原本还有一个 `grabMode`（'click' | 'hover'），用来决定两个入口按钮里
   * 哪一个显示「取消注释」。悬停入口按用户要求删除之后它就失去了意义 ——
   * 只剩一个按钮、一种行为，整套 mode 机制一起清掉了。
   */

  /**
   * 这个元素是不是"正在输入文字"的字段。
   *
   * Esc 的守卫要用它判断"该不该让键"。判据必须窄：只看 INPUT/TEXTAREA 会把
   * 复选框、单选钮、按钮也卷进来 —— 那些上面按 Esc 没有"取消输入"的含义，
   * 挡住 Esc 只会让用户退不出抓取模式（真机上就是这么暴露的）。
   *
   * @param {Element|null} node
   */
  function isTextEntry(node) {
    if (!node) {
      return false
    }
    if (node.tagName === 'TEXTAREA') {
      return true
    }
    if (node.tagName !== 'INPUT') {
      return false
    }
    const type = String(node.getAttribute('type') || 'text').toLowerCase()
    return ['text', 'search', 'password', 'email', 'url', 'tel', 'number'].indexOf(type) !== -1
  }

  /**
   * 把按钮同步到"抓取模式开/关"这个真实状态。
   *
   * ## 为什么文案是「取消注释」而不是「元素注释」
   *
   * 一个写着「元素注释」的按钮，在已经进入抓取模式时点击它会**再注入一次并
   * 重新 arm** —— 用户以为自己在取消，实际没变化，那是个会让人反复点的死按钮。
   *
   * ## 这里**不再**有 `mode` 参数
   *
   * 原来有两个入口（元素注释 / 悬停注释），要靠 `mode` 决定哪个显示「取消」。
   * 用户要求去掉悬停入口，而两个入口的行为本来就一样（都是左键点击才抓），
   * 所以整套 `mode` 机制随之删除。
   *
   * @param {boolean} armed
   */
  function setGrabArmed(armed) {
    grabArmed = Boolean(armed)

    // ⚠️ 只改**文案 span**，绝不能给按钮赋 `textContent`。
    //
    // 按钮里有两个子节点：加号 SVG 和文案 span。给按钮赋 `textContent` 会把
    // 所有子节点换成一个纯文本节点 —— 加号就这样被删掉了，而且是在面板启动
    // 第一次调用本函数时（`refreshGrabState()`）发生的。
    // 表现是"代码里明明有图标，界面上永远看不到"，非常难往这里想。
    startElementNoteLabel.textContent = grabArmed ? '取消注释' : '元素注释'
    startElementNoteButton.setAttribute(
      'aria-label',
      grabArmed ? '退出注释模式' : '元素注释：点页面上的元素并写说明'
    )
    startElementNoteButton.classList.toggle('armed-note', grabArmed)
  }

  /**
   * 容量已满时给用户的一句完整解释。
   *
   * 必须同时说清"现在多少 / 上限多少 / 怎么办" —— 只说"存不下了"
   * 会让人去猜该删几条还是该改设置。
   *
   * @param {{ recordCount: number, maxRecords: number, bytes: number, maxBytes: number, reason: string|null }} capacity
   */
  function capacityMessage(capacity) {
    const mb = (value) => (value / (1024 * 1024)).toFixed(1)
    const which =
      capacity.reason === 'records'
        ? `记录数已达上限（${capacity.recordCount} / ${capacity.maxRecords} 条）`
        : `占用已达上限（${mb(capacity.bytes)} / ${mb(capacity.maxBytes)} MB）`
    return `${which}，无法再新增注释。删掉几条旧记录，或在下方「容量设置」里调大上限。`
  }

  /**
   * 容量挡住时，顺手把设置区展开 —— 让用户不必自己去下面找。
   */
  function maybeOpenCapacitySettings() {
    const details = document.querySelector('details.settings')
    if (details) {
      details.open = true
      details.scrollIntoView({ block: 'nearest' })
    }
  }

  /**
   * 注释入口（只剩一个了）。
   *
   * ⚠️ 这里原本有两个入口（元素注释 / 悬停注释），靠 `mode` 参数区分。
   *
   * 用户要求去掉悬停入口："现在元素注释我看也具备 悬停注释的功能了。"
   *
   * **成立，而且这不是"顺带支持"，是本来就一样**：两个入口都是**左键点击元素**
   * 才抓，悬停只用来高亮预览。那条"停 400ms 自动捕获"早就按用户要求删掉了。
   * 所以悬停按钮点了之后**什么额外效果都没有** —— 留着一个什么都不多做的按钮，
   * 只会让人以为是两种模式。
   *
   * hover 才出现的内容（下拉菜单、气泡提示）依然能抓：点击那一刻先把 payload
   * 抽好（见 `captureElement` 的顺序说明），浮层收掉了也不影响。
   */
  function wireNoteEntry() {
    const button = startElementNoteButton

    button.addEventListener('click', function () {
    // ⚠️ 第一句，必须在任何 await 之前。
    //
    // `chrome.permissions.request` 只在**用户手势内同步发起**时才生效。
    // 这个点击是唯一能拿到手势的时机，所以申请必须放在这里，
    // 而不是等到截图失败之后 —— 那样用户得先失败一次、再滚到面板顶部
    // 去找那个授权按钮，是个把人绕晕的顺序（真机就是这么卡住的）。
    //
    // 已经授权时这个调用会**立刻返回 true、不弹框**，所以无条件调用是安全的。
    const hostPermission = chrome.permissions
      ? chrome.permissions.request({ origins: HOST_ORIGINS })
      : Promise.resolve(false)

    void (async function () {
      hideGrantRow()
      await hostPermission

      // 已经在抓取模式里 → 这个按钮是"取消"。
      if (grabArmed) {
        const cancelResponse = await send('grab.cancel')
        if (cancelResponse && cancelResponse.ok === true) {
          setGrabArmed(false)
          /*
           * ⚠️ **在这里就地收起输入卡片**，不要指望 worker 那条广播。
           *
           * 真机反馈："取消注释以后 弹窗没有消失/关闭。"
           *
           * 原因：worker 侧的清理（清暂存 + 通知面板）是通过
           * `chrome.runtime.sendMessage` 推过来的，而**从 service worker 推给
           * 侧边面板这条路并不可靠** —— 那条广播没到，卡片就留在那儿了。
           *
           * 而这件事**本来就该由发起方收尾**：面板刚发出取消、也拿到了成功响应，
           * 它自己最清楚该收什么。worker 那条广播留着当兜底（覆盖"从别处退出"
           * 的情况），但不再是唯一依靠。
           */
          hideAnnotationComposer()
          showNotice('已退出注释模式')
          return
        }
        showNotice(
          (cancelResponse && cancelResponse.error && cancelResponse.error.message) ||
            '退出注释模式失败，请重试。'
        )
        return
      }

      // 容量检查放在**进入抓取模式之前**。
      //
      // service worker 里也有一道同样的检查（那是权威），这里再做一次是为了
      // 把提示放在用户看得见的地方 —— 面板里的完整解释比页面角落一闪而过的
      // 胶囊有用得多。用户明确要求：不要等他写完注释才说存不下。
      const capacityResponse = await send('history.capacity')
      if (capacityResponse && capacityResponse.ok === true && capacityResponse.result.atLimit) {
        showNotice(capacityMessage(capacityResponse.result))
        void maybeOpenCapacitySettings()
        return
      }

      const response = await send('grab.manual.start', {})
      if (response && response.ok === true) {
        setGrabArmed(true)
        showNotice('已进入元素注释 —— 切到页面点元素，写完注释点「添加」')
        // 点完把焦点从按钮上挪开：按钮上留着焦点时，后续回车/空格会再次触发它，
        // 而 Esc 也更容易被面板吃掉（见下面面板侧的 Esc 处理）。
        button.blur()
        return
      }

      const error = (response && response.error) || {}
      showNotice(error.message || '进入注释模式失败，请重试。')

      // 权限失败时给出可操作的补救按钮。
      if (error.code === 'needs_host_permission') {
        grantRow.hidden = false
      }
      // 容量被拒（worker 侧那道权威检查）→ 同样展开设置区。
      if (error.code === 'history_quota_exceeded') {
        void maybeOpenCapacitySettings()
      }
    })()
    })
  }

  // 两个入口都接上：共用同一段流程，差别只在传给 worker 的 `mode`。
  wireNoteEntry()

  /**
   * 注释输入卡片 —— 用户点了元素之后在这里写注释。
   *
   * ## 为什么输入框在面板里
   *
   * 之前它住在 `chrome.windows.create({type:'popup'})` 开出来的独立窗口里。
   * 功能是对的，但真机上那个窗口带着一圈操作系统标题栏（最小化/最大化/关闭），
   * 用户反馈："我不希望用户能感觉到这是一个独立的浏览器弹窗。"
   *
   * 查过 Chromium 的 API 定义：`frameless` / `titleBar` / `borderless` 这些词在
   * `windows.json` 里**一次都没出现过** —— 扩展 API 造不出无边框窗口。
   *
   * 面板是我们自己的文档、没有窗口边框，而且用户就是从面板点「元素注释」才开始
   * 框选的 —— 它一定是开着的。所以这是唯一既无边框、又不会和页面抢焦点的位置。
   */
  const composer = document.getElementById('annotation-composer')
  const composerTarget = document.getElementById('annotation-target')
  const composerInput = /** @type {HTMLTextAreaElement|null} */ (
    document.getElementById('annotation-input')
  )
  const composerAdd = document.getElementById('annotation-add')
  const composerCancel = document.getElementById('annotation-cancel')
  const composerNote = document.getElementById('annotation-note')

  /**
   * 页面刷新/导航后，在卡片里说明"什么没了、什么还在"。
   *
   * ## 为什么要说，而不是干脆把卡片收掉
   *
   * 刷新会让页面上的高亮框消失 —— 那个视觉参照确实没了。但**payload（含截图）
   * 是在点击那一刻就抽好的**，记录本身完整，用户写了一半的注释也还在输入框里。
   *
   * 收掉卡片等于**把用户刚敲的字扔掉**，而它其实还能正常提交。
   * 所以保留，只是如实告诉他参照没了、内容还在。
   */
  function noteAnnotationAnchorLost() {
    if (!composerNote || !isAnnotationComposerVisible()) {
      return
    }
    composerNote.textContent = '页面刷新后高亮框消失，但截图和上下文已保存，仍可继续添加。'
    composerNote.hidden = false
  }

  function showAnnotationComposer(label) {
    if (!composer || !composerInput || !composerTarget) {
      return
    }
    composerTarget.textContent = label || '（未命名元素）'
    composerTarget.title = label || ''
    composerInput.value = ''
    // 每次弹出都从"没有异常"开始，上一轮刷新留下的说明不能带过来。
    if (composerNote) {
      composerNote.hidden = true
      composerNote.textContent = ''
    }
    composer.hidden = false
    /*
     * 复位二次确认。
     *
     * 不复位的话，用户上一次把「取消」点成了「确认取消？」然后没继续（移开鼠标、
     * 或者卡片整个关掉了），下一次弹出卡片时它会**带着确认态出现** ——
     * 那一刻再点一下就真的取消了，而用户以为那是第一次点。
     */
    if (composerCancel && typeof composerCancel.__resetConfirm === 'function') {
      composerCancel.__resetConfirm()
    }
    // 打开就聚焦。面板是**我们自己的文档**，这里的焦点没人会来抢 ——
    // 这正是把输入框从页面里挪出来的全部意义。
    composerInput.focus()
  }

  function hideAnnotationComposer() {
    if (composer) {
      composer.hidden = true
    }
    if (composerInput) {
      composerInput.value = ''
    }
    if (composerNote) {
      composerNote.hidden = true
      composerNote.textContent = ''
    }
    // 卡片收起来时也复位 —— 同上，确认态不该跨卡片生命周期留着。
    if (composerCancel && typeof composerCancel.__resetConfirm === 'function') {
      composerCancel.__resetConfirm()
    }
  }

  /**
   * 输入卡片此刻是不是开着。
   *
   * 面板文档上那条 Esc 要用它做守卫：卡片挂着时不退出注释模式 ——
   * 否则"Esc 把卡片关了"，与用户的要求相反（见那里那段说明）。
   *
   * @returns {boolean}
   */
  function isAnnotationComposerVisible() {
    return Boolean(composer && !composer.hidden)
  }

  /**
   * 提交注释：先让 worker 落库，拿回文本与截图，再由**面板**写剪贴板。
   *
   * 剪贴板必须在文档上下文里写（worker 里 `navigator.clipboard` 是 undefined），
   * 而面板正好是个文档。
   */
  async function submitAnnotationComment() {
    if (!composerInput) {
      return
    }
    const comment = composerInput.value.trim()
    if (comment === '') {
      showNotice('写点什么再添加（或按 Esc 取消）')
      composerInput.focus()
      return
    }
    const response = await send('grab.comment.submit', { comment: comment })
    if (!response || response.ok !== true) {
      const reason = response && response.error ? response.error.message : '未知原因'
      showNotice(`添加失败：${reason}`)
      return
    }
    const result = response.result || {}
    const writeResult = await writeRichToClipboard({
      text: result.textForClipboard || '',
      imageDataUrl: result.screenshotDataUrl || null
    })
    hideAnnotationComposer()
    void refresh()
    if (writeResult.ok) {
      const wroteImage = (writeResult.wrote || []).some((t) => String(t).startsWith('image/'))
      showNotice(wroteImage ? '已添加，文本与截图已复制' : '已添加，文本已复制')
    } else {
      // 落库成功、复制失败：说清楚，别让用户以为白写了。
      showNotice(`已添加，但复制到剪贴板失败：${writeResult.reason || '未知原因'}`)
    }
  }

  async function cancelAnnotationComment() {
    await send('grab.comment.cancel', {})
    hideAnnotationComposer()
    showNotice('已取消这次注释')
  }

  if (composerAdd) {
    composerAdd.addEventListener('click', function () {
      void submitAnnotationComment()
    })
  }
  if (composerCancel) {
    /*
     * 「取消」也要二次确认（用户要求）。
     *
     * 理由和面板里其它不可逆操作一样：**卡片里是用户刚手动敲进去的注释**，
     * 一次误点就整段没了。而它旁边就是「添加」，两个按钮紧挨着 ——
     * 点错的代价和收益完全不匹配。
     *
     * 复用 `armTwoStepConfirm`（导出与清空用的也是它），而不是另写一遍：
     * 那样"鼠标一离开就复位"、"超时兜底"、"确认态底色"这些行为会三份各写一遍，
     * 迟早漂移。用户对这个交互的要求是统一的 ——
     * "当用户的鼠标从二次确认的按钮上离开就立即恢复成原来的按钮和功能"。
     */
    armTwoStepConfirm(composerCancel, '取消', '确认取消？', function () {
      void cancelAnnotationComment()
    })
  }
  if (composerInput) {
    composerInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        void submitAnnotationComment()
      }
      /*
       * ⚠️ **Esc 不关这个卡片**（用户要求："弹窗不再支持通过 ESC 关闭，
       * 通过 取消 按钮关闭"）。
       *
       * Esc 是"随手反悔"的键，而这里正在写的东西是**用户刚手动敲进去的注释** ——
       * 手滑一下整段就没了，代价和收益不匹配。要放弃就明确去点「取消」。
       *
       * 另外这也不会和别处打架：面板文档上那条 Esc（退出注释模式）有
       * `isTextEntry` 守卫，焦点在文本框里时它本来就会跳过。
       */
    })
  }

  /*
   * 面板打开时就问一次：可能有一笔注释是在面板关着的时候发起的
   * （用户点完元素、面板被挤掉又拉回来）。
   */
  void (async function restorePendingAnnotation() {
    const response = await send('grab.comment.context', {})
    if (response && response.ok === true && response.result && response.result.pending === true) {
      showAnnotationComposer(response.result.label)
    }
  })()

  /*
   * worker 在用户点完元素后推过来 —— 这时才把输入卡片亮出来。
   *
   * 页面侧此刻已经把高亮框**冻结**在选中的元素上，所以面板里写注释时，
   * 页面上那个"我选的是这里"的参照一直在。
   */
  try {
    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === 'grab.annotation.pending') {
        showAnnotationComposer(message.label)
        return undefined
      }
      /*
       * 用户点了「取消注释」退出模式 —— 那笔待写的注释作废了，把卡片收起来。
       *
       * 不处理的话卡片会一直挂着、还写着上次的内容，看着像"我明明退出了，
       * 它怎么还在"。
       */
      if (message && message.type === 'grab.annotation.dismissed') {
        hideAnnotationComposer()
        return undefined
      }
      return undefined
    })
  } catch (error) {
    // 老环境没有 onMessage 时卡片不会自动弹出；`restorePendingAnnotation` 仍能兜住。
  }

  /**
   * 拉取真实状态（页面里说了算），同步按钮。
   *
   * 面板看不到页面里发生的事 —— 用户可能在页面上按了 Esc、按了 Ctrl+Shift+E，
   * 或者页面导航把抓取模式清掉了。所以不能只在点击时改按钮。
   */
  async function refreshGrabState() {
    const response = await send('grab.state')
    if (response && response.ok === true) {
      // `mode` 一起传：只把**正在用的那个**按钮改成「取消…」。
      setGrabArmed(response.result.armed)
    }
  }

  /**
   * 面板侧的 Esc。
   *
   * 这一条是修"有时候按 Esc 不退出"的关键：拾取器的 Esc 挂在**页面**的 document 上，
   * 而点过面板按钮之后焦点在**面板**里 —— 按键根本到不了页面。
   * 所以面板自己也听一次 Esc，走消息把页面里的拾取器关掉。
   */
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !grabArmed) {
      return
    }
    // 用户**正在输入文字**时不抢 Esc —— 那可能是想取消输入。
    //
    // 判据必须窄到"文本输入类"：我第一版写成"INPUT 或 TEXTAREA 就跳过"，
    // 于是复选框（也是 INPUT）命中之后，Esc 就再也退不出抓取模式了。
    // 复选框上按 Esc 没有"取消输入"的含义，不该被这个守卫挡住。
    if (isTextEntry(document.activeElement)) {
      return
    }
    /*
     * ⚠️ **注释输入卡片挂着的时候，Esc 什么都不做**（用户要求："弹窗不再支持
     * 通过 ESC 关闭，通过 取消 按钮关闭"）。
     *
     * 光把卡片自己的 Esc 拿掉还不够：焦点不在文本框里时（比如用户点过面板别处），
     * 这一条会退出**整个注释模式**，而退出会连带把卡片收掉 ——
     * 在用户看来那同样是"Esc 把弹窗关了"。
     *
     * 而且此时卡片里是**用户刚手动敲进去的注释**：Esc 是"随手反悔"的键，
     * 手滑一下整段就没了，代价和收益不匹配。要放弃就明确去点「取消」。
     */
    if (isAnnotationComposerVisible()) {
      return
    }
    event.preventDefault()
    void (async function () {
      const response = await send('grab.cancel')
      if (response && response.ok === true) {
        setGrabArmed(false)
        // 面板发起的退出，就地收尾 —— 同 L1934 那条说明，别指望 worker 的广播。
        hideAnnotationComposer()
        showNotice('已退出注释模式')
      }
    })()
  })

  // 内容脚本在页面里开/关抓取模式时会推过来，按钮跟着变。
  try {
    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === 'grab.state') {
        setGrabArmed(message.armed)
        /*
         * ⚠️ 这里**不再**因为 `armed` 变成 false 就收起输入卡片。
         *
         * 之前那条规定的是"卡片只在抓取模式开着时才有意义"。它当时是为了修
         * 真机那个"取消注释以后弹窗没有消失"——但**定得太宽了**，后来撞上一个
         * 更贵的问题：
         *
         *   用户正在写注释时刷新了页面 → 拾取器归零、`armed` 变 false →
         *   卡片被收掉 → **用户刚敲的那些字被扔掉**。
         *
         * 而它们本来完全有效：payload（含截图）是在**点击那一刻**就抽好的，
         * 记录是完整的，随时可以提交。
         *
         * 所以正确的判据是：**卡片跟着"有一笔待写的注释"走，不跟着拾取器走。**
         * 收起只发生在真的没有待写注释的时候 —— 也就是下面这几条：
         *   · 用户点「取消」/「取消注释」（面板就地收起）；
         *   · 提交成功（面板就地收起）；
         *   · worker 明确推来 `grab.annotation.dismissed`（兜底）。
         *
         * 而"拾取器 armed 或不 armed"只影响按钮文案。
         */
      }
      // 截图因为缺授权被拒 —— 露出授权按钮。
      // 只靠页面上那条两秒的胶囊，用户不知道下一步该做什么。
      if (message && message.type === 'grab.needsHostPermission') {
        grantRow.hidden = false
        showNotice('截图需要网站访问授权 —— 点下面的「授权访问所有网站」，之后截图就能用了。')
      }
    })
  } catch (error) {
    // 没有 onMessage（老环境）时退化为"打开面板时查询一次"。
  }

  grantHostButton.addEventListener('click', function () {
    // ⚠️ `chrome.permissions.request` 必须在**用户手势内同步发起**。
    // 这个 handler 里在它之前**不能有任何 await** —— 一次 await 就会用掉
    // 瞬时激活，请求会被拒。所以这里先发请求，再在 then 里做后续的事。
    const granted = chrome.permissions.request({ origins: HOST_ORIGINS })

    Promise.resolve(granted)
      .then(function (ok) {
        if (!ok) {
          showNotice(
            '授权被拒绝。可以按 Ctrl+Shift+E 用快捷键进入抓取模式 —— ' +
              '快捷键每次都会重新授权，不需要这一步。'
          )
          return
        }
        hideGrantRow()
        // 拿到长期授权后重试，这次应当成功。
        return send('grab.manual.start').then(function (response) {
          if (response && response.ok === true) {
            showNotice('已授权并进入抓取模式 —— 切到页面点元素')
            return
          }
          const error = (response && response.error) || {}
          showNotice(error.message || '授权成功，但注入仍然失败。')
          if (error.code === 'needs_host_permission') {
            grantRow.hidden = false
          }
        })
      })
      .catch(function (error) {
        showNotice('申请授权失败：' + String(error && error.message ? error.message : error))
      })
  })

  /**
   * 自动刷新。
   *
   * 面板是常驻的，所以"用户在页面上抓了一个元素"这件事必须自己传过来 ——
   * 真机反馈：「在打开侧边栏的情况下，我新增了注释的内容，没有立即显示」，
   * 因为面板只在打开那一刻读过一次历史。
   *
   * 用 `chrome.storage.onChanged` 而不是让 service worker 广播：
   * - 历史本来就落在 `chrome.storage.local`，写入必然触发这个事件；
   * - 不需要 worker 知道面板开没开，也不需要 `sendResponse` 返回 true 那些约定
   *   （广播时若无人接收，`sendMessage` 的 Promise 会以 "Receiving end does not
   *   exist" 拒绝，反而给抓取路径引入噪音）。
   *
   * 加防抖：连续抓几个元素时 storage 会写好几次，不需要每次都重渲染。
   */
  let refreshTimer = null
  function scheduleRefresh() {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer)
    }
    refreshTimer = setTimeout(function () {
      refreshTimer = null
      void refresh()
      void loadShotDiagnostics()
    }, 150)
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local') {
        return
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'records')) {
        scheduleRefresh()
      }
    })
  } catch (error) {
    // 旧环境没有该 API 时退化为手动刷新（面板重开即刷新），不影响其他功能。
  }

  // —— 截图诊断 ——
  shotDiagReloadButton.addEventListener('click', function () {
    void loadShotDiagnostics()
  })

  shotDiagClearButton.addEventListener('click', function () {
    void (async function () {
      await send('screenshotDiagnostics.get', { clear: true })
      await loadShotDiagnostics()
      showNotice('诊断已清空。现在到页面上抓一个元素，再回来点「刷新」。')
    })()
  })

  // 提示位常驻：一打开面板就先把标语放上去（而不是留空等用户操作）。
  clearNotice()

  void refresh()
  void loadShotDiagnostics()
  // 快捷键那套已按用户要求整体删除，这里不再拉取它们的状态
  // （界面元素也已移除，再调用只会去操作 null）。
  void refreshGrabState()

  // ⚠️ **切换标签页时必须重查一次**（真机反馈）。
  //
  // 用户原话："当我在页面A打开了元素注释，切换到页面B以后，此时右侧虽然显示的
  // 【取消注释】按钮（说明此时已经进入了元素的框选状态），但是实际没有显示框选的
  // 区域……我觉得像是之前切换页面后显示的取消注释的按钮实际上是新页面的打开注释
  // 的按钮。"
  //
  // 他的判断是对的。抓取模式**是每个标签页各自的状态**，而面板是常驻的、
  // 只有一份。切换标签页之后，面板上显示的仍是**上一个标签页**的状态。
  //
  // 原来只监听 `window.focus` —— 而**切页不会触发它**：侧边面板是独立文档，
  // 一直处于显示状态，从来没有失焦过。
  //
  // `chrome.tabs.onActivated` 不需要额外权限（它不带 URL/title，`tabs` 权限
  // 才管那些）。没有它时静默跳过 —— 面板其余功能不受影响。
  try {
    if (chrome.tabs && chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(function () {
        void refreshGrabState()
      })
    }
  } catch (error) {
    // 老环境没有这个事件：退回"只在窗口获得焦点时刷新"。
  }

  /*
   * ⚠️ **页面刷新时也要重查一次**（真机反馈）。
   *
   * 场景：用户正在注释，随手按了 F5 / Ctrl+R。页面重新加载 → 内容脚本全部
   * 重新注入 → 抓取模式归零、高亮框消失。但面板上的按钮**还停在「取消注释」**，
   * 因为没有任何一条现成的通知会触发：
   *
   *   · `tabs.onActivated` —— 标签页没换，不触发；
   *   · `window.focus` —— 面板一直有焦点，不触发；
   *   · `visibilitychange` —— 面板一直可见，不触发；
   *   · 页面的 `grab.state.changed` 推送 —— 那个脚本已经**被销毁了**，发不出来。
   *
   * 换句话说：**状态的拥有者（页面）消失时，恰恰是它最不可能通知你的时候。**
   * 只能由外面观察"这个标签页开始加载了"。
   *
   * `chrome.tabs.onUpdated` **不需要 `tabs` 权限**就能收到 `status` 变化
   * （`url` / `title` 才需要）。这里只看 `status === 'loading'`，
   * 所以不涉及任何新的权限。
   *
   * 刷新后重查一次，答案会自己变对：worker 注入脚本去问，新文档里没人 armed，
   * 于是返回 `armed: false`，按钮复位、输入卡片也随之收起。
   */
  try {
    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
        if (changeInfo && changeInfo.status === 'loading') {
          // 卡片开着的话，先说明"高亮框消失、但内容还在"，再重查状态。
          // 顺序不能反：重查会把已关掉的抓取模式反映过来，而卡片是否还在
          // 取决于这次刷新**有没有**待写的注释。
          noteAnnotationAnchorLost()
          void refreshGrabState()
        }
      })
    }
  } catch (error) {
    // 老环境没有这个事件：刷新后的按钮会停在旧状态，其余功能不受影响。
  }

  // 面板常驻，用户可能在另一个标签页里开关了抓取模式；
  // 窗口重新获得焦点时也刷新一次（覆盖"从别的应用切回来"）。
  window.addEventListener('focus', function () {
    void refreshGrabState()
  })

  // 面板被隐藏/关闭前把待保存的评论写下去。
  //
  // 这一条覆盖的是最常见的流失路径：**用户在框里打完字，直接关掉面板** ——
  // 既没有失焦（面板整体消失，blur 不一定派发），也不一定等得到那 700ms 防抖。
  // 没有它，自动保存会给人一种"偶尔丢字"的感觉，而那是最难被信任的一类 bug。
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      void flushAllCommentSaves()
    }
  })
  window.addEventListener('pagehide', function () {
    void flushAllCommentSaves()
  })
})()
