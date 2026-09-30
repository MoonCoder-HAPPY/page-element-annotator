// @ts-check
/**
 * payload → 可粘贴文本。
 *
 * 字段顺序与措辞**刻意与参考实现一致**（`orca/src/renderer/.../GrabConfirmationSheet.tsx`
 * 的 `formatGrabPayloadAsText`），这样用户在 Orca 内嵌浏览器里形成的阅读习惯可以直接迁移。
 *
 * 两处与参考实现不同的地方已在实现报告记录：
 *   I-3  `Source:` 缺省时**仍输出该行**，值为诚实缺省文案（参考实现是整行不输出）
 *   I-4  `React:` 沿用参考实现行为（有值才输出），不把缺省文案外推过去
 */
;(function attachFormatter(scope) {
  'use strict'

  /** `Source:` 拿不到源码位置时的诚实缺省文案（spec §9.2）。 */
  const SOURCE_UNAVAILABLE_TEXT = '(not available on this page)'

  /** `Computed styles:` 段里只输出这几项，且各自有条件。 */
  const DEFAULT_POSITION = 'static'
  const TRANSPARENT_BACKGROUND = 'rgba(0, 0, 0, 0)'

  /**
   * 计算样式段的筛选规则。为什么不是把 16 项全列出来：
   * `display: inline`、`position: static`、`background: transparent` 是绝大多数元素的
   * 默认值，列出来只增加噪声，不增加信息量。
   * @param {Record<string, string>} styles
   */
  function buildStyleLines(styles) {
    const lines = []
    if (styles.display && styles.display !== 'inline') {
      lines.push(`display: ${styles.display}`)
    }
    if (styles.position && styles.position !== DEFAULT_POSITION) {
      lines.push(`position: ${styles.position}`)
    }
    if (styles.fontSize) {
      lines.push(`font-size: ${styles.fontSize}`)
    }
    if (styles.color) {
      lines.push(`color: ${styles.color}`)
    }
    if (styles.backgroundColor && styles.backgroundColor !== TRANSPARENT_BACKGROUND) {
      lines.push(`background: ${styles.backgroundColor}`)
    }
    return lines
  }

  /**
   * 一条记录的**分节模型** —— 两个格式化器的唯一来源。
   *
   * ## 为什么必须是同一个模型
   *
   * 「复制全部」用的是 `formatGrabPayloadAsText`（纯文本，粘给 AI），
   * 导出（压缩包里的 `.md`）用的是 `formatRecordsAsMarkdown`。
   * 它们原本是**两份各自维护的字段清单**，于是同一件东西有两套说法：
   *
   *   剪贴板 `Selected element:` / `Dimensions:` / `Computed styles:` / `Text content:`
   *   导出   `- 标签：` / `- 尺寸：` / `计算样式：` / `文本：`
   *
   * 而且导出**漏了两节**（`Nearby context`、`Ancestor path` / `Full DOM path`）。
   * 用户反馈："你导出的内容就不能和复制全部的时候那种格式和描述保持一致吗？"
   *
   * 手改一遍文案只能治这一次。**要让它们不再漂移，只能让两边读同一份模型** ——
   * 加一个字段就是加一处，两个渲染器自动都拿到。
   *
   * ## 分节的形状
   *
   * - `block`：标题 + 若干行（`Selected element` 那种）
   * - `bullets`：标题 + 每行一条（`Nearby context`）
   * - `indented`：标题 + 每行缩进（`Computed styles`，缩进是为了读起来是"一组"）
   * - `code`：标题 + 一段代码（`HTML`，Markdown 里用围栏）
   * - `inline`：`标题: 值` 单行（`Ancestor path` / `Full DOM path`）
   * - `image`：图片（**只有导出有** —— 剪贴板走的是图片通道，不是文本）
   *
   * @param {any} payload
   * @param {{ comment?: string|null, screenshotName?: string|null }} [options]
   * @returns {Array<{ title: string, kind: string, lines?: string[], language?: string, name?: string }>}
   */
  function buildRecordSections(payload, options) {
    const target = (payload && payload.target) || {}
    const accessibility = target.accessibility || {}
    const screenshots = options || {}
    const sections = []

    // 注释放在最前面（元素标识之前）：读这段文字的是 AI，"我想改什么"比
    // "这个元素长什么样"更该先看到。真机反馈就是"注释完全没有覆盖到内容里"，
    // 所以它以前根本没被输出过。
    const trimmedComment =
      typeof screenshots.comment === 'string' ? screenshots.comment.trim() : ''
    if (trimmedComment) {
      sections.push({ title: 'Requested change', kind: 'block', lines: [trimmedComment] })
    }

    const elementLines = [target.tagName || '']
    if (accessibility.accessibleName) {
      elementLines.push(`Accessible name: "${accessibility.accessibleName}"`)
    }
    if (accessibility.role) {
      elementLines.push(`Role: ${accessibility.role}`)
    }
    elementLines.push(`Selector: ${target.selector || ''}`)
    // I-3：缺省时保留该行并说明原因，而不是让用户以为这一项坏了。
    elementLines.push(`Source: ${target.sourceFile || SOURCE_UNAVAILABLE_TEXT}`)
    if (target.reactComponents) {
      elementLines.push(`React: ${target.reactComponents}`)
    }
    const rect = target.rectViewport || { width: 0, height: 0 }
    elementLines.push(`Dimensions: ${Math.round(rect.width)}x${Math.round(rect.height)}`)
    /*
     * ⚠️ 用 `code` 而不是 `block`。
     *
     * 这是键值 dump，**行结构本身有意义**。而 Markdown 会把连续的行合成一个段落
     * —— 用 `block` 渲染出来会挤成一坨（我并排对照时一眼就看出来了）。
     * 代码块既保住逐行结构，又是这个场景的惯用写法。
     *
     * 纯文本那条路不受影响：那个渲染器对 `code` 就是逐行输出。
     */
    sections.push({ title: 'Selected element', kind: 'code', lines: elementLines })

    /*
     * 截图只有导出用得上：剪贴板那条路走的是图片通道，文本里没有它。
     *
     * 没抓到截图时**仍然保留这一节**并写"未捕获"—— 那是条真实信息
     * （用户要知道这条少了什么），而不是可以省掉的格式。
     */
    if (screenshots.screenshotName) {
      sections.push({ title: 'Screenshot', kind: 'image', name: screenshots.screenshotName })
    } else if (screenshots.wantScreenshotPlaceholder) {
      sections.push({
        title: 'Screenshot',
        kind: 'block',
        lines: [SCREENSHOT_MISSING_TEXT]
      })
    }

    if (target.textSnippet) {
      sections.push({ title: 'Text content', kind: 'block', lines: [target.textSnippet] })
    }

    const nearby = Array.isArray(payload && payload.nearbyText) ? payload.nearbyText : []
    if (nearby.length > 0) {
      sections.push({ title: 'Nearby context', kind: 'bullets', lines: nearby.slice() })
    }

    const styleLines = buildStyleLines(target.computedStyles || {})
    if (styleLines.length > 0) {
      sections.push({ title: 'Computed styles', kind: 'indented', lines: styleLines })
    }

    if (target.htmlSnippet) {
      sections.push({
        title: 'HTML',
        kind: 'code',
        language: 'html',
        lines: [target.htmlSnippet]
      })
    }

    const ancestors = Array.isArray(payload && payload.ancestorPath) ? payload.ancestorPath : []
    if (ancestors.length > 0) {
      sections.push({ title: 'Ancestor path', kind: 'inline', lines: [ancestors.join(' > ')] })
    }
    if (target.fullPath) {
      sections.push({ title: 'Full DOM path', kind: 'inline', lines: [target.fullPath] })
    }

    return sections
  }

  /**
   * @param {any} payload
   * @param {string|null} [comment] 用户写的意图。有这个字段时**必须**输出：
   *   它是整段上下文里唯一说明"要改什么"的东西，正是 AI 最需要的那一句。
   * @returns {string}
   */
  function formatGrabPayloadAsText(payload, comment) {
    /** @type {string[]} */
    const lines = []

    lines.push(`Attached browser context from ${payload.page.sanitizedUrl}`)
    lines.push('')

    for (const section of buildRecordSections(payload, { comment: comment })) {
      if (section.kind === 'image') {
        // 纯文本通道里没有图片：这一节是导出专用的，这里跳过。
        continue
      }
      if (section.kind === 'inline') {
        lines.push(`${section.title}: ${section.lines[0]}`)
        continue
      }
      lines.push(`${section.title}:`)
      for (const line of section.lines) {
        if (section.kind === 'bullets') {
          lines.push(`- ${line}`)
        } else if (section.kind === 'indented') {
          lines.push(`  ${line}`)
        } else {
          lines.push(line)
        }
      }
      lines.push('')
    }

    return lines.join('\n').trimEnd()
  }

  /**
   * 选一段足够长的反引号围栏，保证内容里的围栏不会提前闭合它。
   *
   * 这是从参考实现的 `browser-annotation-output.ts` 照搬的一处真实修复：
   * HTML 里出现 ``` 时，固定用三个反引号会把代码块切在中间，
   * 之后的整份 Markdown 结构都会错位。做法是数出内容里最长的连续反引号串，
   * 用比它长一格的围栏。
   *
   * @param {string} content
   */
  function selectCodeFence(content) {
    const runs = String(content || '').match(/`+/g)
    const longest = runs
      ? runs.reduce(function (max, run) {
          return Math.max(max, run.length)
        }, 0)
      : 0
    return '`'.repeat(Math.max(3, longest + 1))
  }

  /**
   * 把内容包进自适应长度的代码围栏。
   * @param {string} content
   * @param {string} language
   */
  function fenceCodeBlock(content, language) {
    const fence = selectCodeFence(content)
    return `${fence}${language}\n${content}\n${fence}`
  }

  /** 没抓到截图时的文案。 */
  const SCREENSHOT_MISSING_TEXT = '未捕获'

  /**
   * 第 `index` 条记录的截图在压缩包里的路径。
   *
   * ## 为什么必须是**共享函数**，而不是两边各写一遍字符串拼接
   *
   * 一处是"生成 ZIP 时把图片放进去"，另一处是"Markdown 里引用它"。
   * 两边各写一遍 `images/00${index+1}.png` 这种拼接，只要有一边改了
   * （补零位数、改用 `.jpg`、下标从 0 开始），**导出的 Markdown 就会指向
   * 一个不存在的文件** —— 而且不会报错，只会在用户打开时看到一个破图。
   *
   * 所以让它成为唯一来源：ZIP 打包与 Markdown 生成都调它。
   *
   * @param {number} index 记录在导出里的序号（从 0 开始）
   * @returns {string}
   */
  function screenshotImageName(index) {
    return `images/${String(index + 1).padStart(3, '0')}.png`
  }

  /**
   * PNG data URL 的前缀。
   *
   * ## 它为什么必须放在 shared 而不是 sanitize.js
   *
   * 这个常量**两个上下文都要用**：
   * - service worker 侧：`sanitize.js` 校验截图是不是 PNG（安全铁律）；
   * - 内容脚本侧：`screenshot-crop.js` 裁剪完要拼出 data URL。
   *
   * 它原来定义在 `sanitize.js` 里，而那个文件**只在 service worker 加载**
   * （安全边界有意不下发到页面）。于是内容脚本里 `ns.PNG_DATA_URL_PREFIX` 是
   * `undefined`，拼出来的是 `"undefined" + base64` —— 前缀校验必然失败，
   * 而失败信息是 `payload_invalid`，看起来像"截图数据坏了"，实际整条截图链路
   * 全是好的。这个 bug 在真机上活了很久，就是因为表象指向了完全错误的方向。
   *
   * 把它放在两个上下文都会加载的 `format.js` 里，从结构上消除这种"跨上下文
   * 引用了一个只在单侧存在的符号"的可能。
   */
  const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

  /**
   * 错误码与"截图为何没生成"的原因码。
   *
   * ## 为什么放在 shared
   *
   * 这些码**两个上下文都要用**：
   * - service worker 侧：`sanitize.js`、`screenshot-capture.js` 产生它们；
   * - 内容脚本侧：`screenshot-flow.js` 在"元素不可见/裁剪为空"时产生它们。
   *
   * 它们原来定义在 `sanitize.js` 里，而那个文件只在 service worker 加载。
   * 于是内容脚本里 `ns.ERROR_CODES.elementNotVisible` 是 `undefined`，
   * 报告出来的原因是 `undefined` —— 用户看到的是**一句没有理由的"没有截图"**，
   * 而界面本来是要告诉他"元素不在视口内且滚动后仍不可达"的。
   *
   * 这与 `PNG_DATA_URL_PREFIX` 是同一类缺陷：跨上下文引用了一个只在单侧存在的符号。
   * 放进来之后，"两侧都要用的常量"只有一个去处，不会再散落。
   */
  const ERROR_CODES = Object.freeze({
    payloadInvalid: 'payload_invalid',
    pageNotInjectable: 'page_not_injectable',
    elementDetached: 'element_detached',
    clipboardDenied: 'clipboard_denied',
    screenshotTooLarge: 'screenshot_too_large',
    screenshotCaptureFailed: 'screenshot_capture_failed',
    screenshotCropEmpty: 'screenshot_crop_empty',
    elementNotVisible: 'element_not_visible',
    crossOriginFrameDenied: 'cross_origin_frame_denied',
    historyQuotaExceeded: 'history_quota_exceeded'
  })

  /**
   * 截图缺省原因码 → 用户可读文案。
   *
   * 用 `ERROR_CODES` 而不是手抄一遍字面量：抄一遍就等于给同一组字符串
   * 维护两份，改名时漏改一处就会退化成"没有截图：element_not_visible"这种
   * 把原因码直接甩给用户的样子。
   *
   * @param {string} reason
   */
  function describeScreenshotOmission(reason) {
    if (reason === ERROR_CODES.elementNotVisible) {
      return '没有截图：元素不在视口内且滚动后仍不可达。'
    }
    if (reason === ERROR_CODES.screenshotTooLarge) {
      return '没有截图：元素截图超过 2 MB 上限。'
    }
    if (reason === ERROR_CODES.screenshotCropEmpty) {
      return '没有截图：元素可见区域为空。'
    }
    if (reason === ERROR_CODES.screenshotCaptureFailed) {
      return '没有截图：浏览器拒绝了截图请求。'
    }
    if (reason === ERROR_CODES.payloadInvalid) {
      return '没有截图：截图数据未通过校验。'
    }
    return `没有截图：${reason}`
  }

  /**
   * 批量导出：把多条历史记录合成一份 Markdown（spec §9.3）。
   *
   * ## 字段与描述**与「复制全部」完全一致**
   *
   * 用户要求："你导出的内容就不能和复制全部的时候那种格式和描述保持一致吗？
   * 不需要顶部的 title，但是有些语法该通过 md 美化就使用。"
   *
   * 所以这里**不是**自己再列一遍字段，而是读 `buildRecordSections` ——
   * 和剪贴板那段纯文本读的是**同一份模型**。差异只在渲染方式：
   *
   *   · 分节标题用**加粗**（`**Selected element**`），不是又一个标题层级 ——
   *     每条记录已经有一个 `###` 了，再往下加标题会让目录变得很碎；
   *   · `HTML` 用带围栏的代码块（语言标 `html`），语法能高亮；
   *   · 评论用**引用块**，多行也不破坏结构；
   *   · 截图是 Markdown 图片，指向压缩包内的真文件。
   *
   * ## 截图用相对路径引用，不内联、也不写占位说明
   *
   * 这里原来写的是"（截图已单独复制到剪贴板）" —— 那是刻意的取舍，
   * 理由是"一张原图可达 1 MB，内联进 Markdown 会让文件既难打开也难粘贴"。
   *
   * 理由成立，但**结论错了**：真机反馈"导出 md 的截图你也要导出啊！"
   * 导出里最要紧的就是截图，把它换成一句说明等于没导出。
   *
   * 而内联同样不行 —— 15 条就是 20MB 上下的 `.md`。
   *
   * 所以改成**导出成一个压缩包**：这份 Markdown 用 `images/001.png` 这样的
   * 相对路径引用同一包内的真图片。`.md` 保持小而可读，图片是真文件。
   *
   * 路径由 `screenshotImageName()` 生成 —— ZIP 打包那边用的是同一个函数，
   * 两边不会各写一遍而漂移（漂移的后果是 Markdown 指向一个不存在的文件，
   * 而且**不会报错**，只会看到破图）。
   *
   * @param {any[]} records 按希望出现的顺序（一般是最新在前）
   * @returns {string}
   */
  function formatRecordsAsMarkdown(records) {
    if (!Array.isArray(records) || records.length === 0) {
      return ''
    }

    const lines = []

    records.forEach(function (record, index) {
      const payload = record.payload || {}
      const page = payload.page || {}
      const target = payload.target || {}
      const screenshot = payload.screenshot

      /*
       * 每条记录一个三级标题 —— 这是 Markdown 该做的那部分（便于跳转与目录）。
       *
       * ⚠️ **没有顶层标题**（用户要求"不需要顶部的 title"）。
       * 原来还有一段 `## 页面：…` 的文档头，里面写着抓取时间与总条数。
       * 它和"复制全部"输出的形态对不上 —— 那段文本是**一上来就是内容**。
       * 页面 URL 也没丢：它现在跟着每条记录走（下面那行），
       * 这在多条记录来自不同页面时反而更准确。
       */
      const label = target.selector || target.tagName || '(未知元素)'
      lines.push(`### ${index + 1}. ${label}`)
      lines.push('')

      if (page.sanitizedUrl) {
        lines.push(`Attached browser context from ${page.sanitizedUrl}`)
        lines.push('')
      }
      if (record.url && record.url !== page.sanitizedUrl) {
        lines.push(`页面：${record.url}`)
        lines.push('')
      }

      const sections = buildRecordSections(payload, {
        comment: record.comment,
        screenshotName:
          screenshot && screenshot.dataUrl ? screenshotImageName(index) : null,
        // 导出里"没有截图"也要说一句 —— 那是用户需要知道的缺失。
        wantScreenshotPlaceholder: true
      })

      for (const section of sections) {
        if (section.kind === 'image') {
          lines.push(`**${section.title}**`)
          lines.push('')
          lines.push(`![截图](${section.name})`)
          lines.push('')
          continue
        }

        if (section.kind === 'inline') {
          // 半角冒号 + 空格，与纯文本那条的 `Label: value` 形态对齐。
          lines.push(`**${section.title}:** ${section.lines[0]}`)
          lines.push('')
          continue
        }

        lines.push(`**${section.title}**`)
        lines.push('')

        if (section.kind === 'code') {
          // ⚠️ 必须 join 起来再围栏 —— 我第一版写的是 `section.lines[0]`，
          // 于是"Selected element"那一段只输出了第一行（标签名），
          // 后面所有键值行**静默消失**。并排对照时一眼看出来的。
          lines.push(fenceCodeBlock(section.lines.join('\n'), section.language || ''))
          lines.push('')
          continue
        }

        if (section.kind === 'bullets') {
          for (const line of section.lines) {
            lines.push(`- ${line}`)
          }
          lines.push('')
          continue
        }

        if (section.kind === 'indented') {
          // 计算样式在 Markdown 里也用列表：`- ` 比"缩进两格"更稳
          // （缩进在 Markdown 里没有语义，很多渲染器会把它压成一行）。
          for (const line of section.lines) {
            lines.push(`- \`${line}\``)
          }
          lines.push('')
          continue
        }

        // 评论用引用块：多行评论不会把后面的结构挤出去。
        if (section.title === 'Requested change') {
          for (const line of String(section.lines[0]).split('\n')) {
            lines.push(`> ${line}`)
          }
          lines.push('')
          continue
        }

        for (const line of section.lines) {
          lines.push(line)
        }
        lines.push('')
      }
    })

    return lines.join('\n').trimEnd()
  }

  /**
   * 记录 → 可粘贴的文本。
   *
   * 存在的理由是"注释必须跟着走"：注释存在**记录**上，而
   * `formatGrabPayloadAsText` 只看 payload。侧边面板的"重新复制文本"原先直接
   * 调后者，于是用户写的意图被丢掉 —— 真机反馈："用户的注释完全没有覆盖到内容里"。
   *
   * @param {any} record
   */
  function formatRecordAsText(record) {
    if (!record || !record.payload) {
      return ''
    }
    return formatGrabPayloadAsText(record.payload, record.comment)
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.SOURCE_UNAVAILABLE_TEXT = SOURCE_UNAVAILABLE_TEXT
  scope.__EG__.PNG_DATA_URL_PREFIX = PNG_DATA_URL_PREFIX
  scope.__EG__.ERROR_CODES = ERROR_CODES
  scope.__EG__.buildStyleLines = buildStyleLines
  scope.__EG__.formatGrabPayloadAsText = formatGrabPayloadAsText
  scope.__EG__.formatRecordAsText = formatRecordAsText
  scope.__EG__.selectCodeFence = selectCodeFence
  scope.__EG__.fenceCodeBlock = fenceCodeBlock
  scope.__EG__.formatRecordsAsMarkdown = formatRecordsAsMarkdown
  // 共享给 ZIP 打包那边 —— 两边必须用同一个路径生成规则，见它的说明。
  scope.__EG__.screenshotImageName = screenshotImageName
  scope.__EG__.describeScreenshotOmission = describeScreenshotOmission
})(globalThis)
