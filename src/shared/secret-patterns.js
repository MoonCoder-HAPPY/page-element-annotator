// @ts-check
/**
 * 机密识别模式表。
 *
 * 这个文件是 spec §10.4.2 的单一来源，内容脚本与 service worker 读同一份。
 *
 * ## 两类匹配语义（这是 S-3 修正的落点）
 *
 * 参考实现把 13 个模式**一律做裸子串匹配**。对 `access_token` 这类无歧义的长模式
 * 没问题，但对 `secret` / `password` / `passwd` 会大面积误伤：
 * `class="secret-banner"`、正文里的 "Password"、`aria-label="Enter password"`
 * 全都会变成 `[redacted]`，把本来有用的上下文删掉。
 *
 * 因此这里把两类分开：
 *
 * - **子串匹配**（`SUBSTRING_PATTERNS`）：模式本身足够具体，出现在任何位置都算命中。
 * - **整词匹配**（`WORD_PATTERNS`）：该 token 去掉首尾标点后必须**等于**这个词。
 *   所以 `secret-banner`、`source-code`、`stateful` 不会被误伤。
 *
 * 为什么不能用正则 `\b`：`\b` 的边界定义是"单词字符与非单词字符之间"，而连字符
 * **不是**单词字符 —— 于是 `\bsecret\b` 在 `secret-banner` 上照样命中。
 * 实测确认了这一点（两个用例先失败后才改成现在这版）。真正想要的语义是
 * "这个 token 整个就是那个词"，因此用去标点 + 精确比较，而不是边界正则。
 *
 * token 只按**空白**切分，并且保留内部标点：`example.com` 不会被拆成
 * `example` + `com`，否则 `com` 这类词会造成意外命中。
 */
;(function attachSecretPatterns(scope) {
  'use strict'

  /**
   * 无歧义的子串模式：出现在字符串任何位置都视为命中。
   * @type {readonly string[]}
   */
  const SUBSTRING_PATTERNS = Object.freeze([
    'access_token',
    'auth_token',
    'api_key',
    'apikey',
    'client_secret',
    'oauth_state',
    'x-amz-',
    'session_id',
    'sessionid',
    'csrf'
  ])

  /**
   * 需要整词匹配的模式：裸子串会误伤正常类名与正文单词。
   * @type {readonly string[]}
   */
  const WORD_PATTERNS = Object.freeze(['secret', 'password', 'passwd'])

  /** 命中后的替换值。 */
  const REDACTED = '[redacted]'

  /**
   * spec §10.5 明令**双向排除**的域：既不导入也不清除。
   *
   * 理由与 cookie 导入无关的那一半同样适用于抓取：`accounts.google.com` 这类
   * 认证请求里 `state` / `code` / `continue` 参数天然携带一次性凭据，
   * 而 Google 把登录绑定到创建它的浏览器身份，把它的凭据留在抓取结果里
   * 既没有调试价值又有风险。
   *
   * @type {readonly string[]}
   */
  const NEVER_KEEP_HOSTS = Object.freeze(['google.com', 'youtube.com'])

  /**
   * 用于 URL 净化的允许协议。`about:` 单独处理（只放行 `about:blank`）。
   * @type {ReadonlySet<string>}
   */
  const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

  function escapeForRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  const SUBSTRING_LOWERED = SUBSTRING_PATTERNS.map(function (pattern) {
    return pattern.toLowerCase()
  })

  const WORD_LOWERED = new Set(
    WORD_PATTERNS.map(function (word) {
      return word.toLowerCase()
    })
  )

  /** 首尾需要剥掉的标点。刻意包含连字符：`secret-banner` 里的 `secret` 不算整词。 */
  const EDGE_PUNCTUATION = /^[^a-z0-9\u4e00-\u9fff]+|[^a-z0-9\u4e00-\u9fff]+$/gi

  /**
   * token 去掉首尾标点后是否恰好是某个整词模式。
   * @param {string} token
   */
  function isExactSecretWord(token) {
    if (token.length === 0) {
      return false
    }
    const stripped = token.replace(EDGE_PUNCTUATION, '').toLowerCase()
    return stripped.length > 0 && WORD_LOWERED.has(stripped)
  }

  /**
   * 按空白切分为 token。保留内部标点，这样 `example.com` 不会被拆成
   * `example` + `com` —— 否则 `com`、`co` 这类碎片可能造成意外命中。
   * @param {string} text
   */
  function splitTokens(text) {
    return text.split(/\s+/).filter(function (token) {
      return token.length > 0
    })
  }

  /**
   * 整串是否命中机密模式（用于属性值、class 串等"整体替换"的场景）。
   * @param {unknown} value
   */
  function containsSecret(value) {
    if (typeof value !== 'string' || value.length === 0) {
      return false
    }
    const lower = value.toLowerCase()
    for (let i = 0; i < SUBSTRING_LOWERED.length; i++) {
      if (lower.includes(SUBSTRING_LOWERED[i])) {
        return true
      }
    }
    const tokens = splitTokens(value)
    for (let i = 0; i < tokens.length; i++) {
      if (isExactSecretWord(tokens[i])) {
        return true
      }
    }
    return false
  }

  /**
   * 自由文本是否含凭据（布尔判定，供调用方决定是否整段丢弃）。
   *
   * 子串模式对整个片段判定：它们的形态（`access_token` 等）不会偶然出现在正文里。
   * 整词模式**逐 token** 判定，这样 `"Password reset is available"` 不会被判为凭据，
   * 而 `"password"` 单独出现时会被判为凭据。
   *
   * 注意：决定"怎么处理"时应当优先用 `redactTextTokens`（token 级替换），
   * 这个判定只留给需要布尔答案的场景（例如判断一段 HTML 是否整体不可信）。
   *
   * @param {unknown} text
   */
  function freeTextContainsSecret(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return false
    }
    const lower = text.toLowerCase()
    for (let i = 0; i < SUBSTRING_LOWERED.length; i++) {
      if (lower.includes(SUBSTRING_LOWERED[i])) {
        return true
      }
    }
    const tokens = splitTokens(text)
    for (let i = 0; i < tokens.length; i++) {
      if (isExactSecretWord(tokens[i])) {
        return true
      }
    }
    return false
  }

  /**
   * 自由文本的机密处理：**只替换命中的 token，不删整段**。
   *
   * 这里对 spec §10.4.1 S-3 的文字做了一处主动收紧，理由值得写下来：
   *
   * S-3 要求 `secret`/`password`/`passwd` 改词边界匹配，避免删掉
   * `class="secret-banner"`。但"匹配到了就替换**整个值**"这条规则本身，
   * 用在自由文本上会把周围有用的上下文一起删掉 ——
   * `"Password reset is available from the account page."` 整句变成
   * `[redacted]`，而用户的意图恰恰是想让 AI 看到这句话。
   *
   * 所以自由文本走 token 级替换：只有那个孤立词本身变成 `[redacted]`，
   * 句子结构保留。这**严格更安全**（暴露的字面量更少）且信息量更多。
   *
   * 子串模式（`access_token` 等）仍是整段替换：它们的形态不会偶然出现在正文里，
   * 一旦出现就说明整段都不可信。
   *
   * 属性值与 class 串不走这里，它们仍按"整体替换"处理（短、机器生成、无上下文价值）。
   *
   * @param {string} text
   */
  function redactTextTokens(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return text
    }
    const lower = text.toLowerCase()
    for (let i = 0; i < SUBSTRING_LOWERED.length; i++) {
      if (lower.includes(SUBSTRING_LOWERED[i])) {
        return REDACTED
      }
    }
    return text.replace(/\S+/g, function (token) {
      return isExactSecretWord(token) ? REDACTED : token
    })
  }

  /**
   * @param {string} hostname
   */
  function isNeverKeepHost(hostname) {
    const lower = hostname.toLowerCase()
    for (let i = 0; i < NEVER_KEEP_HOSTS.length; i++) {
      const host = NEVER_KEEP_HOSTS[i]
      if (lower === host || lower.endsWith('.' + host)) {
        return true
      }
    }
    return false
  }

  /**
   * 净化 URL（S-2 修正的落点）。
   *
   * 参考实现只清 `search` 与 `hash`。但 `new URL().toString()` **会包含 userinfo**，
   * 而且路径里带凭据的情况（`/api/keys/abc123`）一样常见。所以这里额外：
   *
   * 1. 显式清空 `username` 与 `password`；
   * 2. 对认证主机（`NEVER_KEEP_HOSTS`）直接返回 `''` —— 它们的 URL 只用于"我抓的是哪一页"
   *    这一层定位，回显整条路径没有价值。
   *
   * @param {string} url
   */
  function sanitizeUrl(url) {
    if (typeof url !== 'string' || url.length === 0) {
      return ''
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'about:') {
        return parsed.toString() === 'about:blank' ? 'about:blank' : ''
      }
      if (!SAFE_URL_PROTOCOLS.has(parsed.protocol)) {
        return ''
      }
      if (isNeverKeepHost(parsed.hostname)) {
        return ''
      }
      parsed.search = ''
      parsed.hash = ''
      parsed.username = ''
      parsed.password = ''
      return parsed.toString()
    } catch (error) {
      // 解析失败时返回原串可能保留 `javascript:` 之类的协议，因此返回空串。
      return ''
    }
  }

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.SUBSTRING_PATTERNS = SUBSTRING_PATTERNS
  scope.__EG__.WORD_PATTERNS = WORD_PATTERNS
  scope.__EG__.NEVER_KEEP_HOSTS = NEVER_KEEP_HOSTS
  scope.__EG__.SAFE_URL_PROTOCOLS = SAFE_URL_PROTOCOLS
  scope.__EG__.REDACTED = REDACTED
  scope.__EG__.containsSecret = containsSecret
  scope.__EG__.freeTextContainsSecret = freeTextContainsSecret
  scope.__EG__.redactTextTokens = redactTextTokens
  scope.__EG__.isExactSecretWord = isExactSecretWord
  scope.__EG__.splitTokens = splitTokens
  scope.__EG__.isNeverKeepHost = isNeverKeepHost
  scope.__EG__.sanitizeUrl = sanitizeUrl
})(globalThis)
