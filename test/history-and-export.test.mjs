// @ts-check
/**
 * 批量导出与历史存储单测（ticket 06）。
 *
 * ## 为什么这两块必须在 Node 里测
 *
 * - `formatRecordsAsMarkdown` 产出的是一份**会被粘进 AI 对话的 Markdown**。
 *   围栏选错、HTML 提前闭合、多行评论挤掉结构——这些都在纯字符串层面就能验，
 *   而且错了以后只有"粘进去发现格式乱"这一条反馈路径，很难排查。
 * - `pruneRecords` 决定历史会不会撑爆 `chrome.storage.local`。容量判断是纯算术，
 *   但边界（刚好等于上限 / 超出 1 字节 / 空数组）容易写错，且错了以后表现为
 *   "偶尔丢记录"，同样难排查。
 *
 * 真实浏览器里的 `chrome.storage.local` 往返由 `verify-in-chrome.mjs` 覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')

const LOAD_ORDER = [
  'src/shared/text-utils.js',
  'src/shared/surrogate-safe-string.js',
  'src/shared/budget.js',
  'src/shared/format.js',
  'src/shared/attribute-allowlist.js',
  'src/shared/secret-patterns.js',
  'src/background/sanitize.js',
  'src/background/history-store.js'
]

for (const relative of LOAD_ORDER) {
  new Function(readFileSync(join(extensionRoot, relative), 'utf8')).call(globalThis)
}
const ns = globalThis.__EG__

/** 造一条历史记录。 */
function makeRecord(overrides = {}) {
  const payload = {
    page: { title: '购物车', sanitizedUrl: 'https://example.com/cart' },
    target: {
      tagName: 'button',
      selector: 'div.cart-actions > button#submit-order',
      sourceFile: 'src/components/Cart.tsx:42:7',
      reactComponents: '<CartPage> <CartActions> <SubmitButton>',
      rectViewport: { x: 0, y: 0, width: 220.4, height: 48.6 },
      htmlSnippet: '<button id="submit-order" class="btn">Submit order</button>',
      textSnippet: 'Submit order',
      accessibility: { role: 'button', accessibleName: 'Submit order', ariaLabel: null, ariaLabelledBy: null },
      fullPath: 'body > div.cart > div.cart-actions > button#submit-order',
      computedStyles: {
        display: 'flex',
        position: 'static',
        fontSize: '15px',
        color: 'rgb(255, 255, 255)',
        backgroundColor: 'rgb(37, 99, 235)'
      }
    },
    nearbyText: [],
    ancestorPath: ['div.cart-actions', 'div#cart'],
    screenshot: null,
    screenshotOmittedReason: null
  }
  return Object.assign(
    {
      id: 'rec-1',
      payload,
      comment: null,
      createdAt: 1_700_000_000_000,
      tabTitle: '购物车',
      url: 'https://example.com/cart',
      thumbnail: null
    },
    overrides
  )
}

// ---------------------------------------------------------------------------
// 自适应代码围栏
// ---------------------------------------------------------------------------

test('围栏选择：无内部反引号时用三个', () => {
  assert.equal(ns.selectCodeFence('<div>x</div>'), '```')
})

test('围栏选择：内容含三个反引号时用四个（参考实现修过的真实问题）', () => {
  assert.equal(ns.selectCodeFence('a```b'), '````')
})

test('围栏选择：内容含更长的反引号串时跟到更长', () => {
  assert.equal(ns.selectCodeFence('`````five'), '``````')
})

test('围栏包裹：HTML 里的三反引号不会提前闭合代码块', () => {
  const html = '<pre>```\ncode\n```</pre>'
  const fenced = ns.fenceCodeBlock(html, 'html')
  const lines = fenced.split('\n')
  // 首尾必须是同一长度的围栏，且内容原样保留。
  assert.equal(lines[0], '````html')
  assert.equal(lines[lines.length - 1], '````')
  assert.ok(fenced.includes('```\ncode\n```'), '内容不能被改写')
})

// ---------------------------------------------------------------------------
// 注释必须跟着复制走（真机反馈："用户的注释完全没有覆盖到内容里"）
// ---------------------------------------------------------------------------

test('注释进文本：单条格式化时注释必须出现在最前面', () => {
  // 根因是注释存在**记录**上，而文本格式化只看 payload —— 于是列表里有、剪贴板里没有。
  const payload = makeRecord().payload
  const text = ns.formatGrabPayloadAsText(payload, '这个按钮太淡了')

  assert.ok(text.includes('Requested change:'), '缺少注释段')
  assert.ok(text.includes('这个按钮太淡了'), '注释内容丢失')

  const commentIndex = text.indexOf('这个按钮太淡了')
  const elementIndex = text.indexOf('Selected element:')
  assert.ok(
    commentIndex < elementIndex,
    '"要改什么"应当排在"元素长什么样"之前 —— 读这段的是 AI'
  )
})

test('注释进文本：空注释与非字符串注释都不产生空段', () => {
  const payload = makeRecord().payload
  for (const value of [null, undefined, '', '   ', 42, {}]) {
    const text = ns.formatGrabPayloadAsText(payload, value)
    assert.ok(!text.includes('Requested change:'), `不该为 ${JSON.stringify(value)} 输出注释段`)
  }
  // 不传第二个参数也不能崩（老的调用点仍然合法）。
  assert.ok(ns.formatGrabPayloadAsText(payload).includes('Selected element:'))
})

test('注释进文本：多行注释原样保留', () => {
  const payload = makeRecord().payload
  const text = ns.formatGrabPayloadAsText(payload, '第一行\n第二行')
  assert.ok(text.includes('第一行\n第二行'), text.slice(0, 260))
})

test('注释进文本：formatRecordAsText 会带上记录上的注释', () => {
  // 这是 "重新复制文本" 与弹窗列表复制走的入口。
  const record = makeRecord({ comment: '把背景改成主色' })
  const text = ns.formatRecordAsText(record)
  assert.ok(text.includes('把背景改成主色'), '记录上的注释被丢掉了')

  // 没有实体 payload 的记录返回空串，而不是抛错。
  assert.equal(ns.formatRecordAsText(null), '')
  assert.equal(ns.formatRecordAsText({}), '')
})

// ---------------------------------------------------------------------------
// 批量导出格式
// ---------------------------------------------------------------------------

test('批量导出：单条记录产出完整的 Markdown 结构', () => {
  const markdown = ns.formatRecordsAsMarkdown([makeRecord()])

  // ⚠️ **没有顶层标题**（用户要求"不需要顶部的 title"）。
  // 原来这里有 `## 页面：…` 加"抓取时间/共 N 个元素"，那种文档头和
  // 「复制全部」输出的形态对不上 —— 那段文本是一上来就是内容。
  assert.ok(!markdown.startsWith('## '), '不应当再有顶层标题')
  assert.ok(!markdown.includes('共 1 个元素'), '不应当再有"共 N 个元素"那行')

  assert.ok(markdown.includes('### 1. div.cart-actions > button#submit-order'))
  // 字段名与「复制全部」逐字一致（用户要求"格式和描述保持一致"）。
  assert.ok(markdown.includes('**Selected element**'), markdown.slice(0, 400))
  assert.ok(markdown.includes('Selector: div.cart-actions > button#submit-order'))
  assert.ok(markdown.includes('Source: src/components/Cart.tsx:42:7'))
  assert.ok(markdown.includes('Dimensions: 220x49'), '尺寸必须四舍五入')
  assert.ok(markdown.includes('React: <CartPage> <CartActions> <SubmitButton>'))
  assert.ok(markdown.includes('```html'))
  assert.ok(markdown.includes('<button id="submit-order"'))
  assert.ok(markdown.includes('**Computed styles**'))
  assert.ok(markdown.includes('**Text content**'))
  assert.ok(markdown.includes('Submit order'))
  // 这两节以前**导不出来** —— 用户的"格式不一致"里就包括这种缺失。
  // 夹具的 nearbyText 是空的，所以这里先喂一份再验。
  {
    const withNearby = makeRecord().payload
    withNearby.nearbyText = ['加入购物车', '立即购买']
    const withNearbyMarkdown = ns.formatRecordsAsMarkdown([makeRecord({ payload: withNearby })])
    assert.ok(withNearbyMarkdown.includes('**Nearby context**'), '附近上下文不能漏')
    assert.ok(withNearbyMarkdown.includes('- 加入购物车'), '附近上下文要逐条列出来')
  }
  assert.ok(markdown.includes('**Ancestor path:**'), '祖先路径不能漏')
  assert.ok(markdown.includes('**Full DOM path:**'), '完整 DOM 路径不能漏')
})

test('批量导出：多条记录按传入顺序编号', () => {
  const markdown = ns.formatRecordsAsMarkdown([
    makeRecord({ id: 'a', payload: Object.assign(makeRecord().payload, {
      target: Object.assign(makeRecord().payload.target, { selector: '#first' })
    }) }),
    makeRecord({ id: 'b', payload: Object.assign(makeRecord().payload, {
      target: Object.assign(makeRecord().payload.target, { selector: '#second' })
    }) })
  ])
  assert.ok(markdown.includes('### 1. #first'), markdown)
  assert.ok(markdown.includes('### 2. #second'), markdown)
})

test('批量导出：源码缺失时用诚实缺省文案（而不是略过该行）', () => {
  const payload = makeRecord().payload
  payload.target.sourceFile = null
  const markdown = ns.formatRecordsAsMarkdown([makeRecord({ payload })])
  assert.ok(
    markdown.includes('Source: (not available on this page)'),
    '缺省时该行必须存在并说明原因'
  )
})

test('批量导出：截图用**相对路径引用**（不内联、也不写占位说明）', () => {
  // 真机反馈："导出 md 的截图你也要导出啊！你现在截图区域的内容都是：
  // 【- 截图：（截图已单独复制到剪贴板）】这肯定是不行的。"
  //
  // 原来那条断言（"截图只标注状态，绝不内联"）**正好在验用户否掉的行为**。
  // 它当初的理由是对的（内联会让 .md 暴涨），但结论错了：导出里最要紧的
  // 就是截图，把它换成一句说明等于没导出。
  //
  // 现在导出的是一个 ZIP（Markdown + 每条一张真 PNG），Markdown 用相对路径引用。
  const payload = makeRecord().payload
  payload.screenshot = {
    mimeType: 'image/png',
    // 一段足够长的假 base64，若被内联会明显出现。
    dataUrl: 'data:image/png;base64,' + 'A'.repeat(5000),
    width: 220,
    height: 49
  }

  const markdown = ns.formatRecordsAsMarkdown([makeRecord({ payload })])

  assert.ok(
    markdown.includes('![截图](images/001.png)'),
    `有截图时必须引用包内图片，实际：${markdown.split('\n').find((l) => l.includes('截图'))}`
  )
  assert.ok(
    !markdown.includes('截图已单独复制到剪贴板'),
    '不得再出现那句占位说明 —— 那是用户明确否掉的'
  )
  assert.ok(!markdown.includes('AAAA'), 'base64 不得出现在 Markdown 里（那会让文件暴涨）')
  assert.ok(markdown.length < 3000, `内联了截图会让长度暴涨，实际 ${markdown.length}`)

  // 引用的路径必须与 ZIP 里实际放图片用的**同一个函数**算出来 ——
  // 两边各写一遍拼接的话，漂移的后果是 Markdown 指向不存在的文件，
  // 而且**不会报错**，只会看到破图。
  assert.equal(ns.screenshotImageName(0), 'images/001.png')
  assert.equal(ns.screenshotImageName(9), 'images/010.png')
  assert.equal(ns.screenshotImageName(99), 'images/100.png')
})

test('批量导出：多条记录的图片路径按序号递增（含补零，便于排序）', () => {
  const records = []
  for (let i = 0; i < 3; i++) {
    const payload = makeRecord().payload
    payload.screenshot = {
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA',
      width: 10,
      height: 10
    }
    records.push(makeRecord({ payload }))
  }
  const markdown = ns.formatRecordsAsMarkdown(records)
  for (const name of ['images/001.png', 'images/002.png', 'images/003.png']) {
    assert.ok(markdown.includes(`![截图](${name})`), `缺少 ${name}`)
  }
})

test('批量导出：无截图时标注"未捕获"', () => {
  const markdown = ns.formatRecordsAsMarkdown([makeRecord()])
  assert.ok(markdown.includes('**Screenshot**'), '没有截图时也要保留这一节')
  assert.ok(markdown.includes('未捕获'), '缺了要说清楚，不能静默略过')
})

test('批量导出：评论逐行加引用前缀，多行评论不破坏结构', () => {
  const markdown = ns.formatRecordsAsMarkdown([
    makeRecord({ comment: '第一行反馈\n第二行反馈\n\n第四行反馈' })
  ])
  assert.ok(markdown.includes('**Requested change**'))
  assert.ok(markdown.includes('> 第一行反馈'), markdown)
  assert.ok(markdown.includes('> 第二行反馈'))
  assert.ok(markdown.includes('> '), '空行也要保留引用前缀')
  assert.ok(markdown.includes('> 第四行反馈'))
  /*
   * 引用块之后不能留下未加前缀的裸行。
   *
   * ⚠️ 扫描范围是**注释块本身**，不是"从这里到文末"。
   *
   * 这条原来一直扫到文末 —— 因为那时注释是**每条记录的最后一段**。
   * 现在注释排在最前面（与「复制全部」的顺序一致：读这段的是 AI，
   * "我想改什么"比"这个元素长什么样"更该先看到），后面还有别的节，
   * 于是 ``` 那种正常的行也会被判成"裸行"。
   */
  const feedbackIndex = markdown.indexOf('**Requested change**')
  assert.ok(feedbackIndex !== -1, '找不到注释那一节')
  const afterFeedback = markdown.slice(feedbackIndex)
  // 到下一个分节标题为止。
  const nextSection = afterFeedback.indexOf('**', '**Requested change**'.length)
  const feedbackBlock =
    nextSection === -1 ? afterFeedback : afterFeedback.slice(0, nextSection)
  for (const line of feedbackBlock.split('\n')) {
    assert.ok(
      line === '' || line.startsWith('>') || line.startsWith('**'),
      `注释块里出现了没有引用前缀的行：${JSON.stringify(line)}`
    )
  }
  assert.ok(feedbackBlock.includes('> 第四行反馈'), '多行注释要完整保留')
})

test('导出与「复制全部」的字段名逐项一致（读的是同一份分节模型）', () => {
  /*
   * 用户要求："你导出的内容就不能和复制全部的时候那种格式和描述保持一致吗？
   * 不需要顶部的 title，但是有些语法该通过 md 美化就使用。"
   *
   * 这两条路原本是**两份各自维护的字段清单**，于是同一件东西有两套说法：
   *   剪贴板 Selected element / Dimensions / Computed styles / Text content
   *   导出   - 标签： / - 尺寸： / 计算样式： / 文本：
   * 而且导出还**漏了两节**（Nearby context、Ancestor path / Full DOM path）。
   *
   * 现在两边都读 buildRecordSections。这条断言就是那个契约：
   * **每一节的标题必须在两边都出现，且不得再有旧说法残留。**
   */
  const payload = makeRecord().payload;
  payload.nearbyText = ['加入购物车', '立即购买'];

  const plain = ns.formatGrabPayloadAsText(payload, '改成主色');
  const markdown = ns.formatRecordsAsMarkdown([makeRecord({ payload, comment: '改成主色' })]);

  const sharedTitles = [
    'Requested change',
    'Selected element',
    'Text content',
    'Nearby context',
    'Computed styles',
    'HTML',
    'Ancestor path',
    'Full DOM path'
  ];
  for (const title of sharedTitles) {
    assert.ok(plain.includes(title + ':'), '复制全部里缺 ' + title);
    assert.ok(markdown.includes('**' + title), '导出里缺 ' + title);
  }

  // 旧的标签不得残留 —— 只验"新的在"挡不住"旧的也还在"。
  const retiredLabels = ['- 标签：', '- 尺寸：', '- 源码：', '- 组件：', '计算样式：', '文本：', '**反馈：**'];
  for (const retired of retiredLabels) {
    assert.ok(!markdown.includes(retired), '导出里还剩旧标签：' + retired);
  }

  // 顶层标题（文档头）按用户要求去掉。
  assert.ok(!/^#{1,2} /m.test(markdown), '导出不应再有顶层标题');
})

test('批量导出：emoji 与中文评论原样保留', () => {
  const markdown = ns.formatRecordsAsMarkdown([makeRecord({ comment: '这个按钮太淡了 😀 改成主色' })])
  assert.ok(markdown.includes('> 这个按钮太淡了 😀 改成主色'))
})

test('批量导出：空数组返回空串而不是抛错', () => {
  assert.equal(ns.formatRecordsAsMarkdown([]), '')
  assert.equal(ns.formatRecordsAsMarkdown(null), '')
})

test('批量导出：payload 字段缺失时降级而不是崩', () => {
  const markdown = ns.formatRecordsAsMarkdown([
    { id: 'x', createdAt: 1_700_000_000_000, payload: {}, comment: null, url: '' }
  ])
  assert.ok(typeof markdown === 'string')
  assert.ok(markdown.includes('(未知元素)'))
})

// ---------------------------------------------------------------------------
// 评论清洗
// ---------------------------------------------------------------------------

test('评论清洗：trim、空值转 null、按 2000 上限截断', () => {
  assert.equal(ns.normalizeComment('  hello  '), 'hello')
  assert.equal(ns.normalizeComment('   '), null)
  assert.equal(ns.normalizeComment(''), null)
  assert.equal(ns.normalizeComment(null), null)
  assert.equal(ns.normalizeComment(42), null)

  const long = ns.normalizeComment('x'.repeat(3000))
  assert.ok(long.length <= ns.BUDGET.annotationCommentMaxLength + ns.TRUNCATION_SUFFIX.length)
  assert.ok(long.endsWith(ns.TRUNCATION_SUFFIX))
})

// ---------------------------------------------------------------------------
// 容量回收
// ---------------------------------------------------------------------------

test('容量回收：空数组与非法输入都返回空结果', () => {
  assert.deepEqual(ns.pruneRecords([]), { kept: [], droppedCount: 0, droppedBytes: 0 })
  assert.deepEqual(ns.pruneRecords(null), { kept: [], droppedCount: 0, droppedBytes: 0 })
})

test('容量回收：条数未超限时一条不丢', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, blob: 'x'.repeat(100) }))
  const result = ns.pruneRecords(records)
  assert.equal(result.kept.length, 10)
  assert.equal(result.droppedCount, 0)
})

test('容量回收：恰好等于条数上限时一条不丢（边界）', () => {
  // 显式传入上限，不依赖默认值。
  //
  // 上限现在是**可配置的产品参数**（默认 100 条 / 20 MB，用户能改）。拿默认值当
  // 测试基准，会让"改个默认值就挂一批测试"，而那些失败说明不了任何真实问题。
  // 这里要验的是**裁剪算法**，所以把上限钉成常量。
  const limits = { maxRecords: 5, maxBytes: 1024 * 1024 }
  const records = Array.from({ length: limits.maxRecords }, (_, i) => ({ id: `r${i}` }))
  const result = ns.pruneRecords(records, limits)
  assert.equal(result.kept.length, limits.maxRecords)
  assert.equal(result.droppedCount, 0)
})

test('容量回收：超过条数上限时从最旧开始丢', () => {
  const limits = { maxRecords: 5, maxBytes: 1024 * 1024 }
  const records = Array.from({ length: limits.maxRecords + 5 }, (_, i) => ({ id: `r${i}` }))
  const result = ns.pruneRecords(records, limits)
  assert.equal(result.kept.length, limits.maxRecords)
  assert.equal(result.droppedCount, 5)
  // 最新（最前）的必须留下，最旧的必须被丢。
  assert.equal(result.kept[0].id, 'r0')
  assert.equal(result.kept[result.kept.length - 1].id, `r${limits.maxRecords - 1}`)
})

test('容量默认值：100 条 / 20 MB（用户指定）', () => {
  // 与上面的算法测试分开：这里锁的是**产品默认值**，
  // 它本来就会随产品决策变，不该和算法正确性混在一条断言里。
  assert.equal(ns.DEFAULT_SETTINGS.maxRecords, 100)
  assert.equal(ns.DEFAULT_SETTINGS.maxBytes, 20 * 1024 * 1024)
})

test('容量设置：越界或垃圾输入被收敛到合法范围', () => {
  // 不能让用户把上限设成 0（一抓就满）或大到把 storage 配额撑爆。
  const clampedLow = ns.clampSettings({ maxRecords: 0, maxBytes: -1 })
  assert.equal(clampedLow.maxRecords, ns.SETTINGS_LIMITS.minRecords)
  assert.equal(clampedLow.maxBytes, ns.SETTINGS_LIMITS.minBytes)

  const clampedHigh = ns.clampSettings({ maxRecords: 1e9, maxBytes: 1e18 })
  assert.equal(clampedHigh.maxRecords, ns.SETTINGS_LIMITS.maxRecords)
  assert.equal(clampedHigh.maxBytes, ns.SETTINGS_LIMITS.maxBytes)

  // 垃圾输入退回默认值，而不是让 NaN 一路传到裁剪逻辑里
  const garbage = ns.clampSettings({ maxRecords: 'abc', maxBytes: null })
  assert.equal(garbage.maxRecords, ns.DEFAULT_SETTINGS.maxRecords)
  assert.equal(garbage.maxBytes, ns.DEFAULT_SETTINGS.maxBytes)
})

test('设置：调低上限时向上收敛到当前用量，**不**接受低于用量的值', async () => {
  // 这条测的是**真实的** history-store，不是面板测试里我手写的夹具 ——
  // 夹具是我自己镜像的契约，可能和实现对不上；这一条才是权威的。
  //
  // 用户反馈："用户当前设置的保存条数是 100，如果此时历史记录中已经存在 50 条了，
  // 但是用户此时又把这个额度调整成了 40 —— 现在的逻辑会把之前最早的 10 条删掉，
  // 这个逻辑是错误的。用户从大调小的时候，最低值必须与当前的使用量持平！"
  const store = { records: [], schemaVersion: 1 }
  const previousChrome = globalThis.chrome
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys]
          const out = {}
          for (const key of wanted) {
            if (key in store) {
              out[key] = store[key]
            }
          }
          return out
        },
        set: async (patch) => {
          Object.assign(store, patch)
        }
      }
    }
  }

  try {
    // 造 50 条记录（每条都有可序列化的 payload，体积估算才有意义）。
    store.records = Array.from({ length: 50 }, (_, i) => makeRecord({ id: `r${i}` }))

    const effective = await ns.writeSettings({
      maxRecords: 40,
      maxBytes: 1024 * 1024
    })

    assert.equal(effective.maxRecords, 50, '上限必须被收敛到当前用量 50，而不是接受 40')
    assert.equal(store.settings.maxRecords, 50, '写进存储的也必须是 50')

    // 关键：一条记录都不能少。
    const after = await ns.readHistory()
    assert.equal(after.records.length, 50, '调低上限**不得**删除任何已有记录')

    // 用量本身就是下限 —— 读出来确认它和上限一致。
    const floor = await ns.readUsageFloor()
    assert.equal(floor.minRecords, 50)
    assert.ok(floor.minBytes > 0)

    // 反向：调高上限要正常生效。
    const raised = await ns.writeSettings({ maxRecords: 120, maxBytes: 30 * 1024 * 1024 })
    assert.equal(raised.maxRecords, 120)
    assert.equal(raised.maxBytes, 30 * 1024 * 1024)
  } finally {
    if (previousChrome === undefined) {
      delete globalThis.chrome
    } else {
      globalThis.chrome = previousChrome
    }
  }
})

test('容量回收：字节超限时按最旧的先丢', () => {
  // 每条约 1 MiB 的字符串，10 条会超过 5 MiB 上限。
  const limits = { maxRecords: 100, maxBytes: 5 * 1024 * 1024 }
  const oneMiB = 'x'.repeat(1024 * 1024)
  const records = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, blob: oneMiB }))
  const result = ns.pruneRecords(records, limits)
  assert.ok(result.kept.length < 10, `应当丢了一些，实际保留 ${result.kept.length}`)
  assert.equal(result.kept[0].id, 'r0', '最新的必须留下')
  assert.equal(result.droppedCount + result.kept.length, 10)
  assert.ok(result.droppedBytes > 0)
})

test('容量回收：单条就超限时全部清空而不是留下一条超限的', () => {
  const limits = { maxRecords: 100, maxBytes: 1024 * 1024 }
  const huge = { id: 'huge', blob: 'x'.repeat(limits.maxBytes + 1024) }
  const result = ns.pruneRecords([huge, { id: 'small', blob: 'x' }], limits)
  assert.equal(result.kept.length, 0, '留下超限的单条会让下次写入继续失败')
  assert.equal(result.droppedCount, 2)
})

test('容量回收：序列化失败的超大记录被当作疑似超大丢弃，正常记录保留', () => {
  const circular = { id: 'cir' }
  circular.self = circular
  const result = ns.pruneRecords([circular, { id: 'ok', blob: 'x' }])
  // 序列化失败时按"疑似超大"处理（估算为字节上限本身），因此它会被优先丢掉。
  // 把坏记录留在历史里会让下次写入继续失败。
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0].id, 'ok')
  assert.equal(result.droppedCount, 1)
})

// ---------------------------------------------------------------------------
// 列表投影
// ---------------------------------------------------------------------------

test('列表投影：只带列表需要的字段，不带完整 payload', () => {
  const row = ns.toListRow(makeRecord({ thumbnail: 'data:image/jpeg;base64,AA', comment: '反馈' }))
  assert.equal(row.selector, 'div.cart-actions > button#submit-order')
  assert.equal(row.tagName, 'button')
  assert.equal(row.hasComment, true)
  assert.equal(row.comment, '反馈')
  assert.equal(row.thumbnail, 'data:image/jpeg;base64,AA')
  assert.equal(row.hasScreenshot, false)
  // 关键：完整 payload 不进列表投影，否则面板渲染代价随历史规模线性增长。
  assert.equal(row.payload, undefined)
  assert.equal(row.target, undefined)
})

test('列表投影：payload 缺失时不抛错', () => {
  const row = ns.toListRow({ id: 'x', createdAt: 1, payload: null })
  assert.equal(row.selector, '')
  assert.equal(row.hasScreenshot, false)
})

// ---------------------------------------------------------------------------
// 创建记录
// ---------------------------------------------------------------------------

test('创建记录：带上 id、时间与页面摘要，评论初始为 null', () => {
  const record = ns.createRecord(makeRecord().payload)
  assert.equal(typeof record.id, 'string')
  assert.ok(record.id.length > 0)
  assert.equal(record.comment, null)
  assert.equal(record.tabTitle, '购物车')
  assert.equal(record.url, 'https://example.com/cart')
  assert.equal(typeof record.createdAt, 'number')
})

test('创建记录：两次调用得到不同的 id', () => {
  const a = ns.createRecord(makeRecord().payload)
  const b = ns.createRecord(makeRecord().payload)
  assert.notEqual(a.id, b.id)
})

// ---------------------------------------------------------------------------
// 截图缺省原因文案
// ---------------------------------------------------------------------------

test('缺省原因映射：五个错误码都有可读文案，未知码降级但不空', () => {
  for (const code of [
    'element_not_visible',
    'screenshot_too_large',
    'screenshot_crop_empty',
    'screenshot_capture_failed',
    'payload_invalid'
  ]) {
    const text = ns.describeScreenshotOmission(code)
    assert.ok(text.startsWith('没有截图：'), `${code} 的文案不对：${text}`)
    assert.ok(text.length > 6)
  }
  const unknown = ns.describeScreenshotOmission('something_new')
  assert.ok(unknown.includes('something_new'), '未知原因也要显示出来，不能吞掉')
})

// ---------------------------------------------------------------------------
// 接线检查（防"实现了但没接上"）
// ---------------------------------------------------------------------------

test('存储权限与 side_panel 已声明，且权限未越界', () => {
  const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'))
  assert.ok(manifest.permissions.includes('storage'), '缺少 storage 权限')
  assert.ok(manifest.permissions.includes('sidePanel'), '缺少 sidePanel 权限')
  // downloads 权限**必须**在：用户要求「导出全部」直接把 .md 存到磁盘，
  // 那条路径走 `chrome.downloads.download`。
  //
  // 这条断言被来回翻过一次，值得记下来：上一轮用户说"导出全就是下载 MD 的功能"
  // 并要求删掉下载按钮，于是我断言它**不该**存在；这一轮用户明确"导出全部的功能
  // 就是直接把 .md 存到磁盘"，于是它又必需了。
  // 结论：权限断言要跟着**行为**走，而不是跟着"当前有没有人用"走。
  assert.ok(
    manifest.permissions.includes('downloads'),
    '导出改为落盘后，downloads 权限是必需的'
  )
  assert.ok(manifest.side_panel && manifest.side_panel.default_path, '缺少 side_panel 声明')
  for (const forbidden of ['tabs', 'cookies', 'history', 'webNavigation']) {
    assert.ok(!manifest.permissions.includes(forbidden), `不得申请 ${forbidden}`)
  }
})

test('service worker 在 sanitize 之后才写历史（顺序不能反）', () => {
  const serviceWorker = readFileSync(
    join(extensionRoot, 'src/background/service-worker.js'),
    'utf8'
  )

  /*
   * ⚠️ 判据必须限定在 **`grab.extract.request` 处理器内部**。
   *
   * 原来它是对整份文件做 `indexOf`，取**第一处** `ns.appendRecord(record)` ——
   * 只要在文件里更靠前的位置新增任何一个写历史的函数，这条断言就会误报。
   * （加"等用户写注释"那条路时正是如此：`finishPendingAnnotation` 写的是
   * **已经脱敏过的**那条记录，不变量依然成立，但断言红了。）
   *
   * 源文件里的**文本顺序**表达不了"写进历史的记录必须来自脱敏后的 payload"
   * 这个不变量 —— 能表达它的是"在抽取处理器内部，先脱敏、后落库"。
   */
  const handlerStart = serviceWorker.indexOf("message.type === 'grab.extract.request'")
  assert.ok(handlerStart !== -1, '找不到 grab.extract.request 处理器')

  // 到下一个消息处理器为止，就是这一个处理器的范围。
  const nextHandler = serviceWorker.indexOf("message.type === 'picker.disarm'", handlerStart)
  const handlerBody = serviceWorker.slice(
    handlerStart,
    nextHandler === -1 ? undefined : nextHandler
  )

  const sanitizeIndex = handlerBody.indexOf('ns.sanitizePayload(message.rawPayload)')
  const appendIndex = handlerBody.indexOf('ns.appendRecord(record)')
  assert.ok(sanitizeIndex !== -1, '抽取处理器里找不到 sanitize 调用')
  assert.ok(appendIndex !== -1, '抽取处理器里找不到 appendRecord 调用')
  assert.ok(
    sanitizeIndex < appendIndex,
    '必须先 sanitize 再写历史——反过来会让原始密码在磁盘上留一份'
  )

  /*
   * 另一半：**每一条**落库的记录都必须来自 `sanitized.payload`。
   *
   * 只比对顺序挡不住"另起一条路径、绕过 sanitize 直接写" —— 而那才是这个
   * 不变量真正要防的事。"等用户写注释"那条路就是把 record 暂存起来、之后
   * 再由别处写入，所以这里显式检查那个 createRecord 也只吃 sanitized。
   */
  const recordCreations = Array.from(
    serviceWorker.matchAll(/ns\.createRecord\(([^)]*)\)/g)
  ).map((m) => m[1].trim())
  assert.ok(recordCreations.length > 0, '找不到 createRecord 调用')
  for (const argument of recordCreations) {
    assert.ok(
      argument.startsWith('sanitized.payload'),
      `createRecord 必须只接受脱敏后的 payload，实际收到：${argument}`
    )
  }
})
