// @ts-check
/**
 * 安全边界（service worker 侧）。
 *
 * ## 这个文件为什么存在
 *
 * 抽取发生在页面的上下文里，页面可以伪造任何它想伪造的东西。因此这里的设计原则是
 * 参考实现里最值得照搬的一条（spec §10.4）：
 *
 * > 抽取值与校验值分属两个上下文，service worker **不信任**内容脚本传来的任何声明。
 *
 * 内容脚本那边也有一份看起来相似的过滤逻辑（`extract.js` 的 `getSafeAttributes`），
 * 但它只是为了**减少传输量**；真正的判定只在这里，且这里对每个字段**重算**一遍。
 *
 * ## 六步顺序不可调换（spec §10.4）
 *
 * 1. 结构前置校验
 * 2. 逐字段 clamp
 * 3. 属性白名单
 * 4. 机密扫描
 * 5. URL 净化
 * 6. 截图校验
 */
;(function attachSanitizer(scope) {
  'use strict'

  /** 与内容脚本共用的错误码（spec §9.1）。 */

  /**
   * main 侧独有的第二套限值。
   *
   * 这些数字**不在** spec §10.2 的 `GRAB_BUDGET` 表里（那张表只管跨端预算），
   * 它们是"校验端不接受更长输入"的上限，来自参考实现 `browser-grab-payload.ts`。
   */
  const MAIN_SIDE_LIMITS = Object.freeze({
    title: 500,
    attributeValue: 2000,
    attributeClass: 500,
    ariaLabelledBy: 500,
    ancestorPathEntry: 200,
    pageUrl: 2048
  })

  /**
   * PNG data URL 的前缀由 `shared/format.js` 提供 —— 两个上下文都要用它，
   * 而它原来定义在这里（只在 service worker 加载），导致内容脚本拿到 undefined。
   * 详见 `format.js` 里那段注释。
   */
  function pngPrefix() {
    return scope.__EG__.PNG_DATA_URL_PREFIX
  }

  /**
   * @param {unknown} value
   * @returns {value is Record<string, any>}
   */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  // -------------------------------------------------------------------------
  // 第 1 步：结构前置校验
  // -------------------------------------------------------------------------

  /**
   * 先做这一步而不是直接开始 clamp，是为了让畸形输入走"拒绝"而不是在后续嵌套访问上
   * 抛 TypeError —— 后者会把一次可控的坏输入变成 500 级的失败。
   *
   * @param {unknown} raw
   * @returns {{ ok: true, payload: any } | { ok: false, reason: string }}
   */
  function validateStructure(raw) {
    if (!isPlainObject(raw)) {
      return { ok: false, reason: 'payload is not an object' }
    }
    if (!isPlainObject(raw.page)) {
      return { ok: false, reason: 'payload.page is missing or not an object' }
    }
    if (!isPlainObject(raw.target)) {
      return { ok: false, reason: 'payload.target is missing or not an object' }
    }
    if (!isPlainObject(raw.target.rectViewport)) {
      return { ok: false, reason: 'payload.target.rectViewport is missing' }
    }
    if (!isPlainObject(raw.target.rectPage)) {
      return { ok: false, reason: 'payload.target.rectPage is missing' }
    }
    if (!Array.isArray(raw.nearbyText)) {
      return { ok: false, reason: 'payload.nearbyText is not an array' }
    }
    if (!Array.isArray(raw.ancestorPath)) {
      return { ok: false, reason: 'payload.ancestorPath is not an array' }
    }
    if (!isPlainObject(raw.target.computedStyles)) {
      return { ok: false, reason: 'payload.target.computedStyles is missing' }
    }
    return { ok: true, payload: raw }
  }

  // -------------------------------------------------------------------------
  // 第 2 步：逐字段 clamp
  // -------------------------------------------------------------------------

  /**
   * 已经截断过的字符串不再截第二次 —— 否则会叠加两遍 ` (truncated)` 后缀。
   * @param {unknown} value
   * @param {number} max
   */
  function clampOnce(value, max) {
    if (typeof value !== 'string') {
      return ''
    }
    if (scope.__EG__.isTruncated(value)) {
      return value
    }
    return scope.__EG__.clampStr(value, max)
  }

  /**
   * @param {unknown} value
   * @param {number} fallback
   */
  function safeNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  /**
   * @param {unknown} value
   * @param {number} maxEntries
   * @param {number} maxLength
   */
  function clampStringArray(value, maxEntries, maxLength) {
    if (!Array.isArray(value)) {
      return []
    }
    const result = []
    for (let i = 0; i < value.length && result.length < maxEntries; i++) {
      const entry = value[i]
      if (typeof entry !== 'string' || entry.length === 0) {
        continue
      }
      result.push(clampOnce(entry, maxLength))
    }
    return result
  }

  /**
   * @param {unknown} rect
   */
  function clampRect(rect) {
    const source = isPlainObject(rect) ? rect : {}
    return {
      x: safeNumber(source.x, 0),
      y: safeNumber(source.y, 0),
      width: Math.max(0, safeNumber(source.width, 0)),
      height: Math.max(0, safeNumber(source.height, 0))
    }
  }

  // -------------------------------------------------------------------------
  // 第 3 步：属性白名单
  // -------------------------------------------------------------------------

  /**
   * 重新按白名单过滤，不信任内容脚本已经过滤过这件事。
   * @param {unknown} attributes
   * @returns {Record<string, string>}
   */
  function clampAttributes(attributes) {
    if (!isPlainObject(attributes)) {
      return {}
    }
    /** @type {Record<string, string>} */
    const result = {}
    for (const rawName of Object.keys(attributes)) {
      const name = String(rawName).toLowerCase()
      if (!scope.__EG__.isSafeAttributeName(name)) {
        continue
      }
      const value = attributes[rawName]
      if (typeof value !== 'string') {
        continue
      }
      const limit =
        name === 'class' ? MAIN_SIDE_LIMITS.attributeClass : MAIN_SIDE_LIMITS.attributeValue
      result[name] = clampOnce(value, limit)
    }
    return result
  }

  // -------------------------------------------------------------------------
  // 第 4 步：机密扫描
  // -------------------------------------------------------------------------

  /**
   * @param {unknown} value
   */
  function redactIfSecret(value) {
    if (typeof value !== 'string' || value.length === 0) {
      return value
    }
    return scope.__EG__.containsSecret(value) ? scope.__EG__.REDACTED : value
  }

  /**
   * S-1 修正：HTML 片段在扫描前先做两件事 —— 移除可执行/样式内容，
   * 并把 `type=password|hidden` 的 `value` 无条件替换掉。
   *
   * 为什么不能只依赖模式表：`<input type="password" value="hunter2">` 里的
   * `hunter2` 本身**不含任何机密词汇**，模式表永远不会命中它，但它是密码。
   * 所以这里按"元素的 type 属性"判断，而不是按值的内容判断。
   *
   * 为什么替换成 `[redacted]` 而不是整个删掉：读这段上下文的是 AI，
   * 让它知道"这里有个密码框"有用，让它看到密码没用。
   *
   * @param {string} html
   */
  /**
   * 无条件剥离 password / hidden 输入框的 `value`。
   *
   * ## 为什么不能用一个正则搞定（真机复现出来的泄漏）
   *
   * 第一版是一条正则：
   *
   * ```js
   * /(<input\b[^>]*\btype\s*=\s*["']?(?:password|hidden)["']?[^>]*?)\bvalue\s*=/gi
   * ```
   *
   * 它要求 `type` 出现在 `value` **之前**。HTML 属性顺序自由，所以只要写成
   * `<input value="hunter2" type="password">` 就**完全不匹配**，密码原样进剪贴板。
   * 而兜底扫描也拦不住 —— `hunter2` 不含任何机密**词汇**，模式表永远不命中它。
   *
   * 更坏的是它测不出来：测试夹具恰好写的是 `type` 在前的顺序，所以测试一直是绿的。
   *
   * ## 改法
   *
   * 逐个 `<input>` 标签解析：先在标签内部取 `type`，再决定要不要剥离 `value`。
   * 这样与属性顺序无关，与引号风格无关，也不会被 `data-value=` 之类的近似名骗过。
   *
   * @param {string} html
   */
  function stripSensitiveHtml(html) {
    let result = html
    // 移除 script / style 的内容（保留标签本身，便于 AI 知道结构）。
    result = result.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    result = result.replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2')
    // 逐个 input 标签处理，不看属性顺序。
    result = result.replace(/<input\b[^>]*>/gi, redactSensitiveInputValue)
    return result
  }

  /**
   * 单个 `<input …>` 标签：若 type 是 password/hidden，则把 value 换成 `[redacted]`。
   *
   * @param {string} tag
   */
  function redactSensitiveInputValue(tag) {
    // 只在**属性位置**上匹配 type，避免命中 `data-type="password"` 这类近似名
    // （那不该触发剥离），也避免命中 value 里的内容。
    const typeMatch = tag.match(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i)
    if (!typeMatch) {
      return tag
    }
    const type = (typeMatch[1] ?? typeMatch[2] ?? typeMatch[3] ?? '').toLowerCase()
    if (type !== 'password' && type !== 'hidden') {
      return tag
    }
    // 整体替换 value 的值，保留属性名与引号风格。
    return tag.replace(
      /(?:^|\s)value\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
      (attribute) => {
        const leadingSpace = attribute.slice(0, attribute.length - attribute.trimStart().length)
        return `${leadingSpace}value="${scope.__EG__.REDACTED}"`
      }
    )
  }

  /**
   * HTML 片段是否含凭据。
   *
   * 与自由文本不同，这里**不按 token 判整词**：HTML 是机器生成的标记，
   * 属性值里出现 `token`/`password` 这类字面量通常就是真的凭据字段名。
   * 但它会跳过 URL 类属性的值 —— 那些已由 `sanitizeUrlAttributes` 净化过，
   * 而净化后的路径里出现这些词（例如 `/api/keys/token-info`）不该导致整段被删。
   *
   * @param {string} html
   */
  function htmlContainsSecret(html) {
    const withoutUrls = html.replace(
      /\b(?:href|src|action)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      ' '
    )
    if (scope.__EG__.freeTextContainsSecret(withoutUrls)) {
      return true
    }
    return scope.__EG__.containsSecret(withoutUrls)
  }

  /**
   * 净化 HTML 片段里 URL 类属性的值。
   *
   * 这一步是补一个真实漏掉的洞：`attributes` 对象里的 `href` 会被净化，
   * 但**同一个 href 出现在 `htmlSnippet` 的 `outerHTML` 里**——
   * 真机验证时 `<a href="https://user:pw@example.com/api/keys/abc123?token=xyz#frag">`
   * 就是这样把 userinfo 与 token 原样带出去的（诊断输出确认）。
   *
   * 规则与 `attributes` 一致：非允许协议或认证主机 → 置空；其余剥掉
   * query / fragment / userinfo。
   *
   * @param {string} html
   */
  function sanitizeUrlAttributes(html) {
    return html.replace(
      /\b(href|src|action)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
      function (_match, name, separator, rawValue) {
        const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : ''
        const value = quote ? rawValue.slice(1, -1) : rawValue
        if (value.length === 0) {
          return name + separator + quote + quote
        }
        // 判断"该不该留"用规范化后的协议，而不是拿空串当信号：
        // `about:config`、`javascript:` 会被净化成空串，而认证主机的 URL 也会被
        // 净化为空串——前者应整条移除，后者留空属性更诚实。用协议前缀区分两者。
        const protocolMatch = value.match(/^\s*([a-z][a-z0-9+.-]*:)/i)
        const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : 'none:'
        const allowedProtocol =
          protocol === 'about:' ? value.trim() === 'about:blank' : protocol !== 'none:'
        // 认证主机（NEVER_KEEP_HOSTS）整条移除：连路径都不该出现在上下文里。
        const hostShouldVanish =
          scope.__EG__.sanitizeUrl(value) === '' &&
          /^https?:\/\//i.test(value.trim()) &&
          scope.__EG__.containsSecret(value) === false &&
          (function () {
            try {
              return scope.__EG__.isNeverKeepHost(new URL(value).hostname)
            } catch (error) {
              return false
            }
          })()

        if (!allowedProtocol || hostShouldVanish) {
          return ''
        }
        const sanitized = scope.__EG__.sanitizeUrl(value)
        return name + separator + quote + sanitized + quote
      }
    )
  }

  /**
   * 自由文本字段的机密处理。
   *
   * 走 token 级替换而不是整段丢弃：孤立出现的 `password` 这类词变成 `[redacted]`，
   * 但句子结构保留 —— 整段删掉会连带删掉用户本来想让 AI 看到的上下文。
   * 子串模式命中时仍是整段替换（`redactTextTokens` 内部处理）。
   *
   * @param {unknown} text
   */
  function sanitizeFreeText(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return ''
    }
    return scope.__EG__.redactTextTokens(text)
  }

  // -------------------------------------------------------------------------
  // 第 5 步：URL 净化
  // -------------------------------------------------------------------------

  /**
   * @param {unknown} url
   */
  function clampUrl(url) {
    if (typeof url !== 'string') {
      return ''
    }
    return scope.__EG__.sanitizeUrl(clampOnce(url, MAIN_SIDE_LIMITS.pageUrl))
  }

  // -------------------------------------------------------------------------
  // 第 6 步：截图校验
  // -------------------------------------------------------------------------

  /**
   * @param {unknown} screenshot
   * @returns {{ value: any, omittedReason: string|null }}
   */
  function clampScreenshot(screenshot) {
    if (!isPlainObject(screenshot)) {
      return { value: null, omittedReason: null }
    }
    const dataUrl = screenshot.dataUrl
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(pngPrefix())) {
      // 铁律：只接受 PNG data URL。校验前缀可以挡住伪造的 payload 注入
      // 非图片 URI（参考实现的设计文档同样要求）。
      return { value: null, omittedReason: scope.__EG__.ERROR_CODES.payloadInvalid }
    }
    const base64 = dataUrl.slice(pngPrefix().length)
    // base64 的字节数约为长度的 3/4；用长度上界换算，避免真的去解码大字符串。
    const approximateBytes = Math.floor((base64.length * 3) / 4)
    if (approximateBytes > scope.__EG__.BUDGET.screenshotMaxBytes) {
      return { value: null, omittedReason: scope.__EG__.ERROR_CODES.screenshotTooLarge }
    }
    return {
      value: {
        mimeType: 'image/png',
        dataUrl,
        width: Math.max(0, safeNumber(screenshot.width, 0)),
        height: Math.max(0, safeNumber(screenshot.height, 0)),
        byteLength: approximateBytes
      },
      omittedReason: null
    }
  }

  // -------------------------------------------------------------------------
  // 编排
  // -------------------------------------------------------------------------

  /**
   * 第 2–6 步的完整实现。
   * @param {any} raw
   */
  function clampAndRedact(raw) {
    const budget = scope.__EG__.BUDGET
    const target = raw.target

    // 第 3 步：属性白名单（先过滤，后面的机密扫描才只扫留下的那些）。
    const attributes = clampAttributes(target.attributes)
    // 第 4 步：属性值机密扫描。
    for (const name of Object.keys(attributes)) {
      if (name === 'href' || name === 'src' || name === 'action') {
        // 第 5 步统一处理 URL 类属性。
        attributes[name] = clampUrl(attributes[name])
        continue
      }
      attributes[name] = redactIfSecret(attributes[name])
    }

    const accessibilitySource = isPlainObject(target.accessibility) ? target.accessibility : {}

    // 第 4 步：HTML 片段先按 type 剥敏感 value、再净化 URL 类属性，然后才做机密扫描，
    // 最后才截断 —— 顺序反了会让截断把属性切在中间，正则就匹配不到了。
    //
    // HTML 片段命中时整段替换（而不是 token 级）：HTML 是机器生成的标记，
    // 一处凭据出现说明整段属性都可能携带会话状态，逐 token 替换给不出可验证的保证。
    const htmlAfterStrip = sanitizeUrlAttributes(
      stripSensitiveHtml(typeof target.htmlSnippet === 'string' ? target.htmlSnippet : '')
    )
    const htmlRedacted = htmlContainsSecret(htmlAfterStrip)
      ? scope.__EG__.REDACTED
      : htmlAfterStrip

    const screenshot = clampScreenshot(raw.screenshot)

    return {
      page: {
        // 第 5 步：页面 URL 同样净化（去掉 query / fragment / userinfo）。
        sanitizedUrl: clampUrl(raw.page.sanitizedUrl),
        title: sanitizeFreeText(
          clampOnce(raw.page.title, MAIN_SIDE_LIMITS.title)
        ),
        viewportWidth: safeNumber(raw.page.viewportWidth, 0),
        viewportHeight: safeNumber(raw.page.viewportHeight, 0),
        scrollX: safeNumber(raw.page.scrollX, 0),
        scrollY: safeNumber(raw.page.scrollY, 0),
        devicePixelRatio: safeNumber(raw.page.devicePixelRatio, 1),
        capturedAt: typeof raw.page.capturedAt === 'string' ? raw.page.capturedAt : ''
      },
      target: {
        // 第 2 步：逐字段 clamp。
        tagName: clampOnce(target.tagName, 64),
        selector: clampOnce(target.selector, budget.selectorMaxLength),
        elementPath: clampOnce(target.elementPath, budget.pathMaxLength),
        fullPath: clampOnce(target.fullPath, budget.pathMaxLength),
        cssClasses: redactIfSecret(clampOnce(target.cssClasses, budget.cssClassesMaxLength)),
        nearbyElements: clampStringArray(
          target.nearbyElements,
          budget.nearbyElementsMaxEntries,
          budget.nearbyElementMaxLength
        ),
        selectedText: target.selectedText
          ? sanitizeFreeText(clampOnce(target.selectedText, budget.selectedTextMaxLength))
          : null,
        isFixed: target.isFixed === true,
        reactComponents: target.reactComponents
          ? clampOnce(target.reactComponents, budget.reactComponentsMaxLength)
          : null,
        sourceFile: target.sourceFile ? clampOnce(target.sourceFile, budget.sourceFileMaxLength) : null,
        textSnippet: sanitizeFreeText(clampOnce(target.textSnippet, budget.textSnippetMaxLength)),
        htmlSnippet: clampOnce(htmlRedacted, budget.htmlSnippetMaxLength),
        attributes,
        accessibility: {
          role: clampOnce(accessibilitySource.role, 64),
          accessibleName: sanitizeFreeText(clampOnce(accessibilitySource.accessibleName, 200)),
          ariaLabel: sanitizeFreeText(clampOnce(accessibilitySource.ariaLabel, 200)),
          ariaLabelledBy: clampOnce(
            accessibilitySource.ariaLabelledBy,
            MAIN_SIDE_LIMITS.ariaLabelledBy
          )
        },
        rectViewport: clampRect(target.rectViewport),
        rectPage: clampRect(target.rectPage),
        computedStyles: clampComputedStyles(target.computedStyles)
      },
      nearbyText: clampStringArray(
        raw.nearbyText,
        budget.nearbyTextMaxEntries,
        budget.nearbyTextEntryMaxLength
      ).map(sanitizeFreeText),
      ancestorPath: clampStringArray(
        raw.ancestorPath,
        budget.ancestorPathMaxEntries,
        MAIN_SIDE_LIMITS.ancestorPathEntry
      ),
      screenshot: screenshot.value,
      // 截图缺省原因有两个来源：
      // 1. `clampScreenshot` 自己判定的（数据被篡改、超限）—— 来自安全检查，最可信；
      // 2. 内容脚本报告的（元素不在视口内、采集被拒）—— 只在**确实没有截图**时采信。
      //
      // 两个约束，各自对应一个真实后果：
      // - 必须显式保留第 2 种：我原先直接取 `screenshot.omittedReason`，而在"没有截图"
      //   这条**主要**路径上它恰好是 null（`clampScreenshot(null)` 与
      //   `clampScreenshot(undefined)` 都返回 null），于是内容脚本辛苦测出来的
      //   "元素不在视口内且滚动后仍不可达"被**静默抹掉**。用户只能在 2 秒的胶囊里
      //   瞥一眼，历史里永远没有原因，侧边面板的"没有截图：原因"从来没出现过（SP-001）。
      // - 有截图时**不采信**第 2 种：否则内容脚本可以一边给出有效截图、
      //   一边自述"元素不可见"，让界面显示一条自相矛盾的原因。
      //
      // 只接受已知错误码：这个字段会原样显示给用户，不能让内容脚本塞任意字符串进来。
      screenshotOmittedReason:
        screenshot.omittedReason ||
        (screenshot.value ? null : knownOmissionReason(raw.screenshotOmittedReason))
    }
  }

  /**
   * 内容脚本报告的截图缺省原因，只放行已知错误码。
   * @param {unknown} reason
   * @returns {string|null}
   */
  function knownOmissionReason(reason) {
    if (typeof reason !== 'string') {
      return null
    }
    const codes = scope.__EG__.ERROR_CODES
    return Object.values(codes).indexOf(reason) !== -1 ? reason : null
  }

  /**
   * 只保留 spec §10.3 的 16 项，忽略内容脚本多给的键。
   * @param {unknown} styles
   */
  function clampComputedStyles(styles) {
    const source = isPlainObject(styles) ? styles : {}
    /** @type {Record<string, string>} */
    const result = {}
    for (const prop of scope.__EG__.STYLE_PROPS) {
      const value = source[prop]
      result[prop] = typeof value === 'string' ? clampOnce(value, 200) : ''
    }
    return result
  }

  /**
   * 边界入口。
   * @param {unknown} raw
   * @returns {{ ok: true, payload: any } | { ok: false, code: string, message: string }}
   */
  function sanitizePayload(raw) {
    const structure = validateStructure(raw)
    if (!structure.ok) {
      return {
        ok: false,
        code: scope.__EG__.ERROR_CODES.payloadInvalid,
        message: `抓取结果未通过校验：${structure.reason}`
      }
    }
    return { ok: true, payload: clampAndRedact(structure.payload) }
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.MAIN_SIDE_LIMITS = MAIN_SIDE_LIMITS
  scope.__EG__.isPlainObject = isPlainObject
  scope.__EG__.validateStructure = validateStructure
  scope.__EG__.clampOnce = clampOnce
  scope.__EG__.clampAttributes = clampAttributes
  scope.__EG__.redactIfSecret = redactIfSecret
  scope.__EG__.stripSensitiveHtml = stripSensitiveHtml
  scope.__EG__.htmlContainsSecret = htmlContainsSecret
  scope.__EG__.sanitizeUrlAttributes = sanitizeUrlAttributes
  scope.__EG__.sanitizeFreeText = sanitizeFreeText
  scope.__EG__.clampUrl = clampUrl
  scope.__EG__.clampScreenshot = clampScreenshot
  scope.__EG__.clampComputedStyles = clampComputedStyles
  scope.__EG__.clampAndRedact = clampAndRedact
  scope.__EG__.sanitizePayload = sanitizePayload
})(globalThis)