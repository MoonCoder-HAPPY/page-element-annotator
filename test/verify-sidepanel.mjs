/**
 * 侧边面板的真实渲染验证。
 *
 * ## 为什么需要单独一个脚本
 *
 * `chrome.sidePanel` 需要点扩展图标才能打开，而无头模式没有工具栏——所以
 * 面板的 421 行 UI 代码在之前的验证里**从未真正执行过**。那是一个真实的覆盖缺口：
 * 它引用的每个函数、每个 DOM id、每个消息类型都只能靠静态阅读确认。
 *
 * ## 手法
 *
 * 用 HTTP 提供面板的三件套（index.html / index.css / index.js 及它引用的共享脚本），
 * 在页面里**先注入一个 `chrome.runtime` shim**，再让面板脚本照常运行。
 * 于是被测的是**面板自己的代码**，不是它的复制品。
 *
 * shim 只回答数据；面板的渲染、事件接线、状态管理全部是真跑的。
 *
 * 用法：`node test/verify-sidepanel.mjs`
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = join(here, '..')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
]

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`)
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 与面板里 `send()` 的调用一一对应；只答数据，不替面板做任何渲染。 */
const CHROME_SHIM = `
window.__shimCalls = [];
window.__clipboardWrites = [];

/*
 * 剪贴板的**单槽位**模型。
 *
 * 系统剪贴板是一个条目、多个"表示"（text/plain、text/html、image/png…），
 * 任何一次写入都会**替换**掉之前的内容。夹具必须如实建模这一点 ——
 * 只分别记录"写了文本"和"写了图片"的话，"第二次把第一次覆盖掉"就完全测不到，
 * 而那正是用户报过的 bug（"粘贴出来只有截图，没有其它的任何描述"）。
 *
 * （本段在模板字符串里，注释不能出现反引号。）
 */
window.__clipboardSlot = null;
if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
}
navigator.clipboard.writeText = async (text) => {
  window.__clipboardWrites.push(String(text));
  window.__clipboardSlot = { types: ['text/plain'], text: String(text) };
  return undefined;
};
navigator.clipboard.write = async (items) => {
  for (const item of items) {
    const types = typeof item.types === 'function' ? item.types() : item.types;
    const list = types || [];
    let text = null;
    if (list.indexOf('text/plain') !== -1) {
      const blob = await item.getType('text/plain');
      text = blob && typeof blob.text === 'function' ? await blob.text() : null;
    }
    window.__clipboardSlot = { types: list.slice(), text: text };
  }
  return undefined;
};
if (typeof ClipboardItem === 'undefined') {
  globalThis.ClipboardItem = function (map) {
    this.types = () => Object.keys(map);
    this.getType = async (type) => map[type];
  };
}

const now = Date.now();
const makeRow = (index, withThumb, withComment, omittedReason) => ({
  id: 'rec-' + index,
  createdAt: now - index * 60000,
  selector: 'div.cart-actions > button#item-' + index,
  tagName: 'button',
  url: 'https://example.com/cart',
  tabTitle: '购物车',
  hasComment: withComment,
  comment: withComment ? '这个按钮太淡了 😀' : null,
  thumbnail: withThumb ? 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' : null,
  hasScreenshot: withThumb,
  screenshotOmittedReason: omittedReason
});

window.chrome = {
  /*
   * 下载由**面板**发起（导出的是压缩包，几兆是常态；worker 里没有
   * createObjectURL，只能走 data URL，而多兆的 data URL 当下载地址不可靠）。
   * 夹具记下最后一次调用，便于断言"确实下载了 zip、而且是 blob URL"。
   */
  downloads: {
    __calls: [],
    download: async (options) => {
      window.chrome.downloads.__calls.push(options);
      return 1;
    }
  },
  // 面板用它开"大图预览"标签页。夹具记录调用了什么，便于断言。
  tabs: {
    __created: [],
    create: async (options) => {
      window.chrome.tabs.__created.push(options.url);
      (window.__createdTabs = window.__createdTabs || []).push(options.url);
      return { id: 1 };
    },
    // 切换标签页的推送。
    //
    // 面板必须靠它感知"活动标签页变了" —— window.focus 与 visibilitychange
    // 都**不会**在切页时触发（侧边面板是独立文档，一直处于显示状态）。
    // （本段在模板字符串里，注释不能出现反引号。）
    __activatedListeners: [],
    onActivated: {
      addListener: function (fn) {
        window.chrome.tabs.__activatedListeners.push(fn);
      }
    },
    __fireActivated: function (tabId) {
      for (const fn of window.chrome.tabs.__activatedListeners) {
        fn({ tabId });
      }
      return window.chrome.tabs.__activatedListeners.length;
    },
    /*
     * 页面刷新/导航的推送。
     *
     * 面板靠它发现"页面重新加载了" —— 那一刻抓取模式归零，而
     * tabs.onActivated / window.focus / visibilitychange **都不会触发**，
     * 页面自己的推送也发不出来（脚本已被销毁）。
     *
     * （本段在模板字符串里，注释不能出现反引号。）
     */
    __updatedListeners: [],
    onUpdated: {
      addListener: function (fn) {
        window.chrome.tabs.__updatedListeners.push(fn);
      }
    },
    __fireUpdated: function (tabId, changeInfo) {
      for (const fn of window.chrome.tabs.__updatedListeners) {
        fn(tabId, changeInfo);
      }
      return window.chrome.tabs.__updatedListeners.length;
    }
  },
  runtime: {
    // 面板用它把扩展内路径转成可打开的 URL（大图预览页）。
    //
    // 这里刻意不用正则：整段 shim 在模板字符串里，正则里的反斜杠会被模板字符串
    // 先吃掉一层，写出来的正则就不是原来那个了（而且报错会是很难懂的
    // "Unexpected token"，指向别处）。用 charAt/slice 表达同一件事，没有转义问题。
    getURL: function (path) {
      var p = String(path);
      if (p.charAt(0) === '/') {
        p = p.slice(1);
      }
      return 'chrome-extension://test-extension-id/' + p;
    },
    // 面板会订阅 worker 推来的消息（抓取模式状态变化）。夹具要能模拟推送。
    __messageListeners: [],
    onMessage: {
      addListener: function (fn) {
        window.chrome.runtime.__messageListeners.push(fn);
      }
    },
    __fireMessage: function (message) {
      for (const fn of window.chrome.runtime.__messageListeners) {
        fn(message, {}, function () {});
      }
    },
    sendMessage: async (message) => {
      window.__shimCalls.push(message.type);
      // 另存一份**永不清空**的调用记录。
      // 有些测试需要清空 __shimCalls 来观察"某次动作发了哪些消息"，
      // 那会把"启动时有没有拉过某个数据"这类断言一起抹掉 —— 所以需要两份。
      (window.__allShimCalls = window.__allShimCalls || []).push(message.type);
      switch (message.type) {
        case 'history.list': {
          /*
           * 可选的有状态模式：容量那行要验"清空之后跟着变"，就要求
           * **记录列表与容量来自同一份数据** —— 否则容量是另造的常量，
           * 清空它永远不会动，测不出东西。默认关闭，不影响其它用例。
           */
          if (window.__liveRecords) {
            return { ok: true, result: { rows: window.__liveRecords.slice(), schemaMismatch: false } };
          }
          // 条数可调：滚动相关的断言需要**足够长的列表**才有鉴别力。
          // 三条记录撑不满一屏时，"重建导致滚动跳顶"根本无从发生 ——
          // 我第一版就是三条记录，撤掉修复后测试照样绿，等于没测。
          const extra = window.__extraRows || 0;
          const rows = [
            makeRow(1, true, false, null),
            makeRow(2, false, true, null),
            makeRow(3, false, false, 'element_not_visible')
          ];
          for (let i = 0; i < extra; i++) {
            rows.push(makeRow(100 + i, false, false, null));
          }
          return { ok: true, result: { rows, schemaMismatch: false } };
        }
        case 'history.detail':
          // 加一点延迟，模拟真实链路（面板 → worker → 存储）。
          //
          // 这不是为了"更真实"好看：renderDetail 会先建一个**空的**详情容器、
          // 之后才异步填内容。整表重建时所有已展开的详情区同时变空 ——
          // 内容变矮、滚动被夹紧，等详情填回来也回不去了。
          // 夹具里立刻返回的话这个中间态存在不了（微任务里没有布局），
          // 于是"滚动跳顶"这个 bug 在测试里根本不会发生。
          // （本段在模板字符串里，注释不能出现反引号。）
          await new Promise((r) => setTimeout(r, window.__detailDelayMs || 0));
          return {
            ok: true,
            result: {
              target: {
                tagName: 'button',
                selector: 'div.cart-actions > button#item-1',
                elementPath: '#cart > .cart-actions > button',
                sourceFile: 'src/components/Cart.tsx:42:7',
                reactComponents: '<CartPage> <CartActions> <SubmitButton>',
                cssClasses: 'btn btn-primary',
                textSnippet: 'Submit order',
                /*
                 * HTML 与计算样式刻意给**长内容** —— 真实页面上它们就是很长，
                 * 而"长到超出固定高度"正是折叠逻辑要处理的情形。
                 *
                 * 第一版这里给的是短片段，于是详情里 18 个值**一个都没溢出**，
                 * 折叠断言全绿 —— 但它们测的是"没有折叠时也不报错"，
                 * 等于什么都没验。
                 */
                htmlSnippet:
                  // 真实页面上的 HTML 片段就是几十行。这里按真实长度造，
                  // 因为"长到超出固定高度"正是折叠逻辑要处理的情形 ——
                  // 短片段会让折叠断言测了个寂寞。
                  Array.from(
                    { length: 14 },
                    (_, i) =>
                      '<li class="cart-line" data-index="' +
                      i +
                      '"><span class="cart-line__name">商品名称 ' +
                      i +
                      '</span><span class="cart-line__price">￥' +
                      (i + 1) * 12.5 +
                      '</span></li>'
                  ).join(''),
                computedStyles: {
                  display: 'flex',
                  position: 'static',
                  fontSize: '15px',
                  color: 'rgb(255, 255, 255)',
                  backgroundColor: 'rgb(37, 99, 235)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  paddingTop: '10px',
                  paddingRight: '18px',
                  paddingBottom: '10px',
                  paddingLeft: '18px',
                  borderTopLeftRadius: '8px',
                  borderTopRightRadius: '8px',
                  borderBottomLeftRadius: '8px',
                  borderBottomRightRadius: '8px',
                  boxShadow: 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px',
                  transition: 'background-color 0.2s ease',
                  cursor: 'pointer'
                }
              },
              ancestorPath: ['div.cart-actions', 'div#cart'],
              nearbyText: [],
              page: { title: '购物车', sanitizedUrl: 'https://example.com/cart' }
            }
          };
        case 'history.annotate':
          window.__lastAnnotate = { id: message.id, comment: message.comment };
          return { ok: true, result: { saved: true } };
        case 'history.delete':
          window.__lastDelete = message.id;
          return { ok: true, result: { droppedCount: 0 } };
        case 'history.clear':
          window.__clearCalled = true;
          if (window.__liveRecords) {
            window.__liveRecords = [];
          }
          // 记录参数：没勾选时应为空（= 清空全部），勾了时应带 id。
          window.__lastClearArgs = { ids: message.ids };
          return { ok: true, result: { cleared: message.ids ? false : true } };
        case 'history.export':
          window.__lastExportIds = message.ids;
          // 计数：用来验"第一次点击没有真的导出"（两步确认那一组断言）。
          window.__exportCalls = (window.__exportCalls || 0) + 1;
          window.__lastExportArgs = { ids: message.ids };
          /*
           * 导出回传的是**压缩包的 base64**（Markdown + 每条一张 PNG），
           * 由面板解码后经 blob URL 落盘 —— worker 里没有 createObjectURL。
           *
           * 桩必须给一段**真的能解码**的 base64：给空值或随便一个字符串，
           * 面板里的 atob 会抛，而报错看起来像"导出坏了"，其实只是夹具不对。
           * 这里用一段最小的合法字节（内容是什么无所谓，面板只负责搬运）。
           */
          return {
            ok: true,
            result: {
              filename: 'element-notes-2026-01-01T00-00-00.zip',
              count: Array.isArray(message.ids) ? message.ids.length : 3,
              imageCount: 2,
              // 'UEsDBAoAAAAAAA==' 解出来是 PK 开头的一小段字节，够用。
              base64: 'UEsDBAoAAAAAAA=='
            }
          };
        case 'clipboard.copyText':
          // worker 只回传文本；写入由面板做。
          return { ok: true, result: { text: 'Attached browser context from https://example.com/cart\\n' } };
        case 'clipboard.copyScreenshot':
          // 1x1 透明 PNG。
          return {
            ok: true,
            result: {
              dataUrl:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
            }
          };
        case 'commands.list':
          // 与真实 worker 同一契约：返回**用户实际生效**的快捷键。
          // 刻意让其中一条为空，覆盖"未设置"这条分支 ——
          // 界面上显示一个用户并没有生效的组合，比不显示更糟。
          return {
            ok: true,
            result: {
              commands: window.__fakeCommands || [
                { name: 'toggle-grab-mode', shortcut: 'Ctrl+Shift+E' },
                { name: 'grab-hovered-element', shortcut: 'Alt+Shift+G' },
                // 真实 Chrome 的 getAll() 会**额外**返回内置的 _execute_action
                // （点扩展图标）。夹具必须把它带上 —— 少了它，"第三条命令被错标"
                // 那个真机 bug 在测试里根本不会发生。
                // （本段在模板字符串里，注释不能出现反引号。）
                { name: '_execute_action', shortcut: '' }
              ]
            }
          };
        case 'commands.openSettings':
          window.__openedShortcuts = true;
          return { ok: true, result: { opened: true, url: 'chrome://extensions/shortcuts' } };
        case 'screenshotDiagnostics.get':
          if (message.clear) {
            window.__diagCleared = true;
            return { ok: true, result: { entries: [] } };
          }
          // 一条成功、一条失败：覆盖两种渲染分支。
          return {
            ok: true,
            result: {
              entries: [
                {
                  at: '2026-01-01T00:00:00.000Z',
                  stage: 'captureVisibleTab:ok',
                  detail: {
                    windowId: 1,
                    returned: {
                      label: 'captureVisibleTab 返回值',
                      length: 123456,
                      prefix: 'data:image/png;base64,iVBORw0K',
                      startsWithPng: true,
                      mime: 'image/png',
                      payloadLength: 123450
                    }
                  }
                },
                {
                  at: '2026-01-01T00:00:01.000Z',
                  stage: 'extract:sanitized',
                  detail: { kept: false, omittedReason: 'payload_invalid' }
                }
              ]
            }
          };
        case 'history.capacity': {
          // 默认 100 条 / 20 MB。夹具用 __capacityOverride 直接给出边界情况，
          // 不必真的造 100 条记录。
          if (window.__capacityOverride) {
            return { ok: true, result: window.__capacityOverride };
          }
          const used = (window.__extraRows || 0) + 3;
          const settings = window.__settings || { maxRecords: 100, maxBytes: 20 * 1024 * 1024 };
          return {
            ok: true,
            result: {
              recordCount: used,
              bytes: used * 1024,
              maxRecords: settings.maxRecords,
              maxBytes: settings.maxBytes,
              atLimit: used >= settings.maxRecords,
              reason: used >= settings.maxRecords ? 'records' : null
            }
          };
        }
        case 'settings.get':
          return {
            ok: true,
            result: {
              settings: window.__settings || {
                maxRecords: 100,
                maxBytes: 20 * 1024 * 1024,
                shortcuts: window.__shortcuts || {}
              },
              defaults: { maxRecords: 100, maxBytes: 20 * 1024 * 1024, shortcuts: {} },
              limits: { minRecords: 1, maxRecords: 1000, minBytes: 1048576, maxBytes: 536870912 },
              capacity: {
                recordCount: window.__liveRecords
            ? window.__liveRecords.length
            : (window.__extraRows || 0) + 3,
                bytes: (window.__liveRecords
            ? window.__liveRecords.length
            : (window.__extraRows || 0) + 3) * 1024,
                maxRecords: (window.__settings || {}).maxRecords || 100,
                maxBytes: (window.__settings || {}).maxBytes || 20 * 1024 * 1024,
                atLimit: false,
                reason: null
              },
              // 与真实 worker 同一契约：有效下限 = 当前已用量。
              floor: {
                minRecords: (window.__extraRows || 0) + 3,
                minBytes: ((window.__extraRows || 0) + 3) * 1024,
                recordCount: (window.__extraRows || 0) + 3,
                bytes: ((window.__extraRows || 0) + 3) * 1024
              }
            }
          };
        case 'settings.clearShortcut': {
          // 与真实 worker 同一契约：读**存储里的当前值**删一个键，
          // 而不是接受面板发来的整份副本。
          const next = Object.assign({}, window.__shortcuts || {});
          delete next[message.name];
          window.__shortcuts = next;
          window.__lastShortcutsWrite = next;
          return { ok: true, result: { settings: window.__settings, shortcuts: next } };
        }
        case 'settings.setShortcuts':
          // 与真实 worker 同一契约：存进 settings.shortcuts，并回传生效值。
          window.__shortcuts = message.shortcuts || {};
          window.__lastShortcutsWrite = window.__shortcuts;
          return { ok: true, result: { settings: window.__settings, shortcuts: window.__shortcuts } };
        case 'settings.set':
          // 模拟真实 worker 的**向上收敛**：上限不得低于当前用量，
          // 否则"调低上限"会变成"帮你删记录"。
          window.__settings = {
            maxRecords: Math.max(
              message.settings.maxRecords,
              (window.__extraRows || 0) + 3
            ),
            maxBytes: Math.max(message.settings.maxBytes, ((window.__extraRows || 0) + 3) * 1024)
          };
          window.__lastSettingsWrite = window.__settings;
          return {
            ok: true,
            result: {
              settings: window.__settings,
              capacity: {
                recordCount: (window.__extraRows || 0) + 3,
                bytes: ((window.__extraRows || 0) + 3) * 1024,
                maxRecords: window.__settings.maxRecords,
                maxBytes: window.__settings.maxBytes,
                atLimit: false,
                reason: null
              }
            }
          };
        case 'preview.show':
          // 面板把"显示预览"交给 worker —— 它要负责"这个页面可能还没注入过
          // 内容脚本"，面板自己做不了。
          window.__lastPreviewRequest = message.id;
          return { ok: true, result: { shown: true } };
        case 'history.screenshot':
          // 完整截图（大图预览用），与缩略图区分开：这里是一张比缩略图大得多的 PNG。
          window.__lastScreenshotRequest = message.id;
          return {
            ok: true,
            result: {
              dataUrl: window.__fakeFullScreenshot || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              width: 734,
              height: 122
            }
          };
        case 'grab.state':
          window.__stateQueries = (window.__stateQueries || 0) + 1;
          return {
            ok: true,
            result: {
              armed: window.__grabArmed === true,
              mode: window.__grabArmed === true ? (window.__grabMode || 'click') : null,
              tabId: 1
            }
          };
        case 'grab.cancel':
          window.__lastGrabCancel = true;
          window.__grabArmed = false;
          return { ok: true, result: { armed: false } };
        case 'grab.manual.start':
          // 与真实 worker 同一契约：没有授权时返回可在面板侧补救的错误码。
          // __activeTabValid 模拟"点图标或按快捷键那一刻"的临时授权；
          // __hostGranted 模拟通过「授权访问所有网站」拿到的长期授权。
          // （这段是模板字符串，注释里不能出现反引号 —— 会把它截断。）
          if (window.__activeTabValid === true || window.__hostGranted === true) {
            window.__grabArmed = true;
            return { ok: true, result: { armed: true } };
          }
          return {
            ok: false,
            error: {
              code: 'needs_host_permission',
              message: '这条标签页当前没有访问授权。解决：点「授权访问所有网站」一次。'
            }
          };
        default:
          return { ok: false, error: { code: 'unknown_message', message: message.type } };
      }
    }
  }
};
window.confirm = () => true;

// —— storage 变更模型 ——
//
// 面板监听 chrome.storage.onChanged 来自动刷新（真机 bug：面板常驻，抓了新元素
// 它不知道，列表不更新）。这里把这个事件模拟出来，才能断言"确实会自动刷新"。
window.__storageListeners = [];
window.chrome.storage = {
  onChanged: {
    addListener: function (fn) {
      window.__storageListeners.push(fn);
    }
  },
  local: {
    get: async () => ({}),
    set: async () => {}
  }
};

/** 模拟"历史被写入"：真实扩展里 appendRecord 会触发这个事件。 */
window.__fireStorageChange = function (key) {
  const changes = {};
  changes[key] = { newValue: Date.now() };
  for (const fn of window.__storageListeners) {
    fn(changes, 'local');
  }
};

// —— 用户手势模型 ——
//
// chrome.permissions.request 在真实 Chrome 里**必须在用户手势内同步发起**。
// 这里用一个"手势窗口"把它变成可断言的事实：点击派发时开窗，第一个微任务结束时关窗。
// 若面板的 handler 在 request 之前有任何一个 await，请求会落在窗口之外 → 被拒。
//
// 这条断言守的是一个很容易再犯的坑：加一行日志、加一个 await 检查权限状态，
// 都会让授权静默失效 —— 而"静默失效"在真机上表现为"授权按钮点了没反应"。
window.__gestureOpen = false;
window.__permissionRequests = [];

window.chrome.permissions = {
  request: async (request) => {
    const origins = (request && request.origins) || [];
    const withinGesture = window.__gestureOpen === true;
    window.__permissionRequests.push({ origins, withinGesture });
    if (!withinGesture) {
      // 真实 Chrome 的行为：没有手势就拒绝，而不是抛错。
      return false;
    }
    window.__hostGranted = true;
    return true;
  },
  contains: async () => window.__hostGranted === true
};

// 模拟一次带手势的点击：开窗 → 同步派发 → 关窗。
window.__clickWithGesture = function (node) {
  window.__gestureOpen = true;
  try {
    node.click();
  } finally {
    queueMicrotask(function () {
      window.__gestureOpen = false;
    });
  }
};
`

async function startServer() {
  const html = await readFile(join(extensionRoot, 'src/sidepanel/index.html'))
  /** 记录服务端实际被请求的路径，用于定位 404。 */
  const requestLog = []
  // 面板的 HTML 引用 `../shared/*.js`，从 `/src/sidepanel/index.html` 解析成 `/src/shared/*.js`。
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname === '/panel.html') {
        // 在面板脚本之前注入 shim。
        //
        // 路径改写必须与真实扩展里的解析结果一致：扩展里面板在
        // `src/sidepanel/index.html`，`../shared/x.js` 解析成 `src/shared/x.js`。
        // 这里面板被挪到 `/panel.html`，所以必须显式改写成 `/src/shared/x.js`，
        // 而不是让它自己解析成 `/shared/x.js` —— 后者会 404，
        // 结果面板的 421 行代码一行都不会执行（第一版就是这样，测试"通过"全是假通过）。
        const injected = html
          .toString('utf8')
          .replace('<head>', `<head>\n    <script>${CHROME_SHIM}</script>`)
          .replace('href="index.css"', 'href="/src/sidepanel/index.css"')
          .replace('src="theme.js"', 'src="/src/sidepanel/theme.js"')
          .replace('src="index.js"', 'src="/src/sidepanel/index.js"')
          .replace(/src="\.\.\/shared\//g, 'src="/src/shared/')
        requestLog.push({ status: 200, path: url.pathname })
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(injected)
        return
      }
      const filePath = join(extensionRoot, url.pathname.slice(1))
      const body = await readFile(filePath)
      requestLog.push({ status: 200, path: url.pathname })
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream'
      })
      response.end(body)
    } catch (error) {
      requestLog.push({ status: 404, path: request.url })
      response.writeHead(404)
      response.end('not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}`, requestLog }
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  let nextId = 1
  const pending = new Map()
  const consoleErrors = []
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(undefined))
    socket.addEventListener('error', () => reject(new Error('CDP socket 错误')))
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text
      )
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text)
    }
  })
  return {
    ready,
    consoleErrors,
    async send(method, params) {
      await ready
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params: params ?? {} }))
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`${method} 超时`))
          }
        }, 20000)
      })
    },
    close() {
      socket.close()
    }
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(
      `页面内抛错：${
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      }`
    )
  }
  return result.result.value
}

/**
 * 派发**真实**鼠标事件。
 *
 * 为什么不能用 `element.click()`：合成事件不经过命中测试（hit testing），
 * 所以"点空白处会不会误触发"这类问题它根本测不出来 —— 而命中区正是这次要验的东西。
 */
async function dispatchMouse(cdp, type, x, y, button = 'left') {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button,
    clickCount: 1,
    buttons: 1
  })
}

async function main() {
  const chromePath = findChrome()
  if (!chromePath) {
    console.error('未找到 Chrome/Edge')
    process.exit(2)
  }

  const { server, origin, requestLog } = await startServer()
  const userDataDir = await mkdtemp(join(tmpdir(), 'eg-panel-'))
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `${origin}/panel.html`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )

  let cdp = null
  try {
    const port = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('未读到端口')), 25000)
      const onData = (chunk) => {
        buffer += chunk.toString()
        const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      }
      child.stderr.on('data', onData)
      child.stdout.on('data', onData)
    })

    let target
    for (let i = 0; i < 60; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.url.includes('/panel.html'))
      if (target) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!target) throw new Error('等待面板页面超时')

    cdp = createCdpClient(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await new Promise((r) => setTimeout(r, 900))

    // 1) 面板脚本执行、无未捕获异常
    // 404 单独看：只有**真的被 404 的扩展资源**才算问题（favicon 之类不算）。
    const notFound = requestLog.filter((entry) => entry.status === 404)
    const missingExtensionResources = notFound.filter(
      (entry) => entry.path !== '/favicon.ico' && !entry.path.startsWith('/panel.html')
    )
    check(
      '面板引用的扩展资源全部可加载（无 404）',
      missingExtensionResources.length === 0,
      missingExtensionResources.map((e) => e.path).join(' | ')
    )

    const scriptErrors = cdp.consoleErrors.filter(
      (e) => !/favicon|Failed to load resource/i.test(e)
    )
    check('面板脚本执行无未捕获异常', scriptErrors.length === 0, scriptErrors.join(' | '))

    // 真机上报过 `ReferenceError: settingRange is not defined` ——
    // 我在一次编辑里加了**使用**，声明却到后面一次编辑才补上。
    //
    // `node --check` 查不出这种问题：它只验语法，不验标识符存在与否。
    // 真正可靠的证据是**让那段代码跑起来并看结果**：`#setting-range` 的文案
    // 由 `renderSettings` 里那一行写入，它被填上就证明那条路径确实执行到了，
    // 且没有抛错。
    const settingsRangeText = await evaluate(
      cdp,
      `document.getElementById('setting-range').textContent`
    )
    check(
      '设置区的取值范围文案已写入，且是**绝对范围**（用户指定）',
      typeof settingsRangeText === 'string' &&
        settingsRangeText.includes('取值范围') &&
        // 用户要求："取值范围：条数 1–1000，空间 1–512 MB；
        // 超出自动按边界适配，下调上限不影响已有记录。"
        //
        // ⚠️ 这里写的是**常量**，不是"有效下限 = 当前已用量"。
        // 原来显示的是 4–1000（那时已用 4 条），用户看到的是截图里的 15–1000。
        // 改成绝对范围之后，这行数字才和 `SETTINGS_LIMITS` 一致、也不会随用量漂。
        settingsRangeText.includes('条数 1–1000') &&
        settingsRangeText.includes('空间 1–512 MB') &&
        settingsRangeText.includes('下调上限不影响已有记录'),
      String(settingsRangeText).slice(0, 120)
    )

    // 2) 列表渲染
    const listState = JSON.parse(
      await evaluate(
        cdp,
        `JSON.stringify({
          recordCount: document.querySelectorAll('#records .record').length,
          // 主行现在是注释（有注释时）或选择器（没有注释时）。
        // 选择器始终能在元信息行里找到。
        titles: Array.from(document.querySelectorAll('.record-title')).map((n) => n.textContent),
        titleIsSelectorFlags: Array.from(document.querySelectorAll('.record-title')).map((n) =>
          n.classList.contains('as-selector')
        ),
        metaTexts: Array.from(document.querySelectorAll('.record-meta')).map((n) => n.textContent),
          metaTexts: Array.from(document.querySelectorAll('.record-meta')).map((n) => n.textContent),
          thumbnails: document.querySelectorAll('img.record-thumb').length,
          placeholderThumbs: document.querySelectorAll('div.record-thumb').length,
          emptyHidden: document.getElementById('empty').hidden,
          exportDisabled: document.getElementById('export-selected').disabled,
          sendTypes: window.__shimCalls
        })`
      )
    )
    check(
      'AC-12：面板渲染出全部三条记录',
      listState.recordCount === 3,
      `实际 ${listState.recordCount} 条`
    )
    check(
      '主行：有注释时显示注释（用户的意图比选择器好认）',
      listState.titles[1] === '这个按钮太淡了 😀' && listState.titleIsSelectorFlags[1] === false,
      JSON.stringify({ title: listState.titles[1], asSelector: listState.titleIsSelectorFlags[1] })
    )
    check(
      '主行：没有注释时退回选择器，并标记 as-selector',
      listState.titles[0].includes('item-1') && listState.titleIsSelectorFlags[0] === true,
      JSON.stringify({ title: listState.titles[0], asSelector: listState.titleIsSelectorFlags[0] })
    )
    check(
      '选择器移到元信息行后仍然可见（只在主行是注释时才补进元信息，避免重复）',
      // 第 1 条主行已是选择器 → 元信息不重复它；第 2 条主行是注释 → 元信息里补上选择器。
      !/item-1/.test(listState.metaTexts[0]) && /item-2/.test(listState.metaTexts[1]),
      JSON.stringify(listState.metaTexts)
    )
    check(
      'AC-12：有缩略图的显示图片，没有的显示占位',
      listState.thumbnails === 1 && listState.placeholderThumbs === 2,
      `img=${listState.thumbnails} div=${listState.placeholderThumbs}`
    )
    check(
      'AC-12：元信息含相对时间',
      listState.metaTexts.every((t) => /(刚刚|分钟前|小时前|天前)/.test(t)),
      JSON.stringify(listState.metaTexts)
    )
    check(
      // 用户要求："【· 含截图】这几个字去掉吧。冗余显示了"
      //
      // 断言反过来写：**不得出现**。列表里几乎每条都有截图，标出来等于没标，
      // 还把时间挤到角落；缩略图本身就是"有没有截图"最直接的表达。
      // 写成"不出现"才能挡住它被顺手加回来。
      '元信息里**不再**出现「含截图」（用户要求：冗余）',
      listState.metaTexts.every((t) => !t.includes('含截图')),
      JSON.stringify(listState.metaTexts)
    )
    check(
      '面板拉取数据用的消息类型与 service worker 一致',
      listState.sendTypes.includes('history.list'),
      JSON.stringify(listState.sendTypes)
    )
    check(
      'AC-12：空状态在有条目时隐藏',
      listState.emptyHidden === true,
      String(listState.emptyHidden)
    )
    check(
      // 行为已变更：没勾选时按钮**可用**，语义是"导出全部"。
      // 原来禁用是在"导出只作用于所选"的语义下的合理设计；现在默认动作是全部导出，
      // 禁用它会让人以为"有记录但导不出来"。
      '未选中任何条目时导出按钮**可用**（默认动作是「导出全部」）',
      listState.exportDisabled === false,
      String(listState.exportDisabled)
    )

    // 3) 勾选一条 → 导出按钮启用并显示计数
    const afterSelect = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const box = document.querySelector('#records .record input[type=checkbox]');
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 60));
          return JSON.stringify({
            disabled: document.getElementById('export-selected').disabled,
            label: document.getElementById('export-selected').textContent
          });
        })()`
      )
    )
    check(
      // 文案不再带计数（用户要求去掉冗余的「（N）」）；
      // 计数只在「已选 N / 总数」那一行出现。
      '勾选后导出按钮启用，文案变成「导出所选」',
      afterSelect.disabled === false && afterSelect.label === '导出所选',
      JSON.stringify(afterSelect)
    )

    // 4) 点导出 → 把要导的 id 交给 service worker，由它**直接落盘**
    //
    // 行为已变更（用户要求）：导出 = 存成 .md 文件，不再往剪贴板写。
    // 所以这里断言的是"把 id 交出去 + 给出含文件名的反馈"，
    // 而不是"面板调了剪贴板 API"。
    const exportResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__lastExportIds = null;
          document.getElementById('export-selected').click();

          // 导出现在是两步确认：上面那一击只进「确认导出？」态，这一击才真的导出。
          await new Promise((r) => setTimeout(r, 130));
          document.getElementById('export-selected').click();
          await new Promise((r) => setTimeout(r, 250));

          return JSON.stringify({
            ids: window.__lastExportIds,
            notice: document.getElementById('notice').textContent,
            noticeHidden: document.getElementById('notice').hidden,
            // 最后一次下载调用的参数 —— 用来验"真的下载了 zip、用的是 blob URL"。
            download:
              window.chrome.downloads.__calls.length > 0
                ? {
                    filename:
                      window.chrome.downloads.__calls[window.chrome.downloads.__calls.length - 1]
                        .filename,
                    // 只留前缀：blob URL 后面一段是随机 id，断言方案前缀即可。
                    url: String(
                      window.chrome.downloads.__calls[window.chrome.downloads.__calls.length - 1]
                        .url
                    ).slice(0, 5)
                  }
                : null
          });
        })()`
      )
    )
    check(
      'AC-13 前置：导出把选中的记录 id 传给 service worker',
      Array.isArray(exportResult.ids) && exportResult.ids.length === 1,
      JSON.stringify(exportResult.ids)
    )
    check(
      '导出后给出用户可见的反馈，并写明落到了哪个文件',
      exportResult.noticeHidden === false &&
        typeof exportResult.notice === 'string' &&
        exportResult.notice.includes('.zip'),
      JSON.stringify({ notice: exportResult.notice, hidden: exportResult.noticeHidden })
    )
    check(
      // 导出的是**压缩包**（Markdown + 每条一张真 PNG），所以面板必须
      // 自己把 worker 回传的 base64 变成字节、建 blob URL 再落盘。
      //
      // 断言三件事：确实调了 downloads、扩展名是 .zip、用的是 blob URL ——
      // 用 data URL 的话多兆内容不可靠，而这条正是把它钉住的地方。
      '【用户要求】导出真的触发了下载：blob URL + .zip 文件名',
      exportResult.download &&
        exportResult.download.filename.endsWith('.zip') &&
        String(exportResult.download.url).startsWith('blob:'),
      JSON.stringify(exportResult.download || null)
    )

    // 5) 展开详情 → 渲染字段；评论输入可写并保存
    const detailResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const items = Array.from(document.querySelectorAll('#records .record'));
          if (items.length === 0) return JSON.stringify({ error: '没有渲染出任何记录' });
          const toggle = items[0].querySelector('.record-toggle');
          if (!toggle) return JSON.stringify({ error: '记录里没有展开按钮' });
          toggle.click();
          await new Promise((r) => setTimeout(r, 250));

          const itemsAfter = Array.from(document.querySelectorAll('#records .record'));
          const body = itemsAfter[0].querySelector('.record-body');
          if (!body) return JSON.stringify({ error: '展开后没有详情区' });

          const labels = Array.from(body.querySelectorAll('.kv-key')).map((n) => n.textContent);
          const values = Array.from(body.querySelectorAll('.kv-value')).map((n) => n.textContent);
          const commentBox = body.querySelector('textarea.comment-input');

          window.__lastAnnotate = null;
          if (commentBox) {
            commentBox.value = '  这个按钮太淡了 😀  ';
            commentBox.dispatchEvent(new Event('input', { bubbles: true }));
          }
          // 评论现在是**自动保存**，没有保存按钮。
          // 等过 700ms 防抖，保存应当自己发生 —— 这正是要断言的行为。
          await new Promise((r) => setTimeout(r, 900));

          const saveButton = Array.from(body.querySelectorAll('button')).find((b) =>
            b.textContent.includes('保存')
          );
          const status = body.querySelector('.comment-status');

          return JSON.stringify({
            labels,
            values,
            hasCommentBox: Boolean(commentBox),
            hadDraft: commentBox ? commentBox.value : null,
            saved: window.__lastAnnotate,
            hasSaveButton: Boolean(saveButton),
            statusText: status ? status.textContent : null,
            ariaLabels: Array.from(body.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))
          });
        })()`
      )
    )
    check(
      '评论没有「保存」按钮（自动保存，不该让用户替机器做事）',
      detailResult.hasSaveButton === false,
      JSON.stringify(detailResult)
    )
    check(
      '输入停顿后自动保存（无需任何点击）',
      Boolean(detailResult.saved) && detailResult.saved.comment.includes('这个按钮太淡了'),
      JSON.stringify(detailResult.saved)
    )
    check(
      '保存后如实显示状态（已保存 / 保存中）',
      typeof detailResult.statusText === 'string' && detailResult.statusText.length > 0,
      JSON.stringify(detailResult.statusText)
    )

    // 写完立刻点「复制文本」，**不等**那 700ms 防抖。
    //
    // 这是去掉保存按钮之后最容易出的错：复制走的是 worker 里已经落库的记录，
    // 如果没先把待保存的评论 flush 下去，用户拿到的会是上一次的旧注释
    // —— 而且他不会有任何察觉。所以顺序必须是「先 annotate 再 copyText」。
    const flushBeforeCopy = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__lastAnnotate = null;
          window.__shimCalls = [];
          const box = document.querySelector('#records .record textarea.comment-input');
          if (!box) return JSON.stringify({ error: '找不到评论输入框' });

          box.value = '刚改完就点复制';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          // 立刻点，不等待防抖。
          const copyButton = Array.from(
            document.querySelectorAll('#records .record button')
          ).find((b) => b.textContent === '复制文本');
          if (!copyButton) return JSON.stringify({ error: '找不到复制文本按钮' });
          copyButton.click();
          await new Promise((r) => setTimeout(r, 400));

          const order = window.__shimCalls.slice();
          return JSON.stringify({
            order,
            annotateIndex: order.indexOf('history.annotate'),
            copyIndex: order.indexOf('clipboard.copyText'),
            annotated: window.__lastAnnotate
          });
        })()`
      )
    )
    check(
      '复制前先落库：annotate 排在 copyText 之前',
      flushBeforeCopy.annotateIndex !== -1 &&
        flushBeforeCopy.copyIndex !== -1 &&
        flushBeforeCopy.annotateIndex < flushBeforeCopy.copyIndex,
      JSON.stringify(flushBeforeCopy)
    )
    check(
      '落库的是**刚写的内容**，不是上一次保存的旧值',
      Boolean(flushBeforeCopy.annotated) &&
        flushBeforeCopy.annotated.comment.includes('刚改完就点复制'),
      JSON.stringify(flushBeforeCopy.annotated)
    )
    check(
      'AC-12：详情渲染出源码、组件、class、HTML 等字段',
      detailResult.labels.includes('源码') &&
        detailResult.labels.includes('组件') &&
        detailResult.labels.includes('HTML'),
      JSON.stringify(detailResult.labels)
    )
    check(
      'AC-12：详情字段值取自 service worker 返回的数据',
      detailResult.values.some((v) => v.includes('src/components/Cart.tsx:42:7')),
      JSON.stringify(detailResult.values)
    )
    check(
      'AC-13：评论按原样（未 trim）发给 service worker —— trim 由存储层负责',
      detailResult.saved && detailResult.saved.comment.includes('这个按钮太淡了'),
      JSON.stringify(detailResult.saved)
    )
    check(
      '§7.5：详情区按钮都有 aria-label',
      detailResult.ariaLabels.length > 0 && detailResult.ariaLabels.every((v) => typeof v === 'string' && v.length > 0),
      JSON.stringify(detailResult.ariaLabels)
    )

    // 6) 无截图的条目要写明原因（不允许静默消失）
    const omissionResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const toggles = Array.from(document.querySelectorAll('#records .record .record-toggle'));
          toggles[2].click();
          await new Promise((r) => setTimeout(r, 220));
          const bodies = document.querySelectorAll('#records .record .record-body');
          const target = bodies[bodies.length - 1];
          const reason = target.querySelector('.shot-reason');
          const copyScreenshot = Array.from(target.querySelectorAll('button')).find((b) =>
            b.textContent.includes('复制截图')
          );
          return JSON.stringify({
            reasonText: reason ? reason.textContent : null,
            screenshotButtonDisabled: copyScreenshot ? copyScreenshot.disabled : null
          });
        })()`
      )
    )
    check(
      '无截图时写明具体原因（AC-5 后半 / §13.3 静默失败不可接受）',
      typeof omissionResult.reasonText === 'string' &&
        omissionResult.reasonText.includes('没有截图'),
      String(omissionResult.reasonText)
    )
    check(
      '无截图时"重新复制截图"按钮禁用而不是静默失败',
      omissionResult.screenshotButtonDisabled === true,
      String(omissionResult.screenshotButtonDisabled)
    )

    // —— 「复制全部」：文本与截图一次复制到同一个剪贴板条目 ——
    //
    // 用户要求："复制文本按钮的左边新增一个 复制全部 的功能按钮，
    // 意思就是一起复制截图和文本。"
    //
    // 这条同时挡住一个**已经报过的 bug**：分两次写的话第二次会覆盖第一次，
    // 粘出来只剩截图（"我在 word 里面马上粘贴……结果发现只有截图"）。
    const copyAllState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          // 展开第一条记录的详情（动作按钮在那里）。
          const toggle = document.querySelector('#records .record .record-toggle');
          if (toggle && toggle.textContent === '详情') {
            toggle.click();
            await new Promise((r) => setTimeout(r, 400));
          }

          const finds = Array.from(document.querySelectorAll('#records .record-actions .mini'));
          const labels = finds.map((b) => b.textContent);
          const allButton = finds.find((b) => b.textContent === '复制全部');
          const textButton = finds.find((b) => b.textContent === '复制文本');

          if (!allButton) {
            return JSON.stringify({ found: false, labels: labels });
          }
          // 位置：必须排在「复制文本」**左边**。
          const order = Array.from(allButton.parentElement.children).map((n) => n.textContent);
          const leftOfText = order.indexOf('复制全部') < order.indexOf('复制文本');

          window.__clipboardSlot = null;
          allButton.click();
          await new Promise((r) => setTimeout(r, 400));

          return JSON.stringify({
            found: true,
            leftOfText,
            order: order,
            slot: window.__clipboardSlot
          });
        })()`
      )
    )
    check(
      '【用户要求】「复制全部」按钮存在，且在「复制文本」**左边**',
      copyAllState.found === true && copyAllState.leftOfText === true,
      JSON.stringify({ labels: copyAllState.order })
    )
    check(
      // ⚠️ 这条是核心：槽位里必须**同时**有文字与图片。
      // 分两次写的话，第二次会把第一次覆盖掉 —— 槽位里只剩 image/png。
      '【用户要求】点「复制全部」后，剪贴板里文字与图片**在同一个条目里**',
      copyAllState.slot !== null &&
        Array.isArray(copyAllState.slot.types) &&
        copyAllState.slot.types.some((t) => String(t).startsWith('text/')) &&
        copyAllState.slot.types.some((t) => String(t).startsWith('image/')),
      JSON.stringify(copyAllState.slot)
    )

    //
    // 用户原话："当用户点击以后会显示二次确认的按钮，目前当用户不想清空/删除的话，
    // 那么二次确认的按钮会等待几秒钟才关闭，我希望当用户的鼠标从二次确认的按钮上
    // 离开就立即恢复成原来的按钮和功能，这样体感会更好。"
    const confirmHoverLeave = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const button = document.getElementById('clear-all');
          window.__clearCalled = false;

          // 先复位到初始态（前面的用例可能已经点过它）。
          if (button.__resetConfirm) button.__resetConfirm();
          await new Promise((r) => setTimeout(r, 80));
          const idleLabel = button.textContent;

          // 进确认态。
          button.click();
          await new Promise((r) => setTimeout(r, 120));
          const armedLabel = button.textContent;
          const armedClass = button.classList.contains('armed');

          // 鼠标离开 —— 应当**立刻**复位，不等超时。
          //
          // 只等 150ms：超时是 4000ms 量级，所以这里若能复位，
          // 一定是 mouseleave 起的作用，而不是超时碰巧到了。
          button.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
          await new Promise((r) => setTimeout(r, 150));

          return JSON.stringify({
            idleLabel,
            armedLabel,
            armedClass,
            afterLeaveLabel: button.textContent,
            afterLeaveArmed: button.classList.contains('armed'),
            clearedByLeave: window.__clearCalled === true
          });
        })()`
      )
    )
    check(
      '前置：清空按钮能进入确认态',
      confirmHoverLeave.armedLabel === '确认清空？' && confirmHoverLeave.armedClass === true,
      JSON.stringify(confirmHoverLeave)
    )
    check(
      // 150ms 远小于 4000ms 的超时 —— 所以这条能过，只可能是 mouseleave 生效。
      '【用户要求】鼠标离开确认按钮后**立即**复位（不等超时）',
      confirmHoverLeave.afterLeaveLabel === confirmHoverLeave.idleLabel &&
        confirmHoverLeave.afterLeaveArmed === false,
      JSON.stringify(confirmHoverLeave)
    )
    check(
      '鼠标离开**不等于**确认：复位的同时不能真的执行清空',
      confirmHoverLeave.clearedByLeave === false,
      String(confirmHoverLeave.clearedByLeave)
    )

    // 7) 清空按钮：两次点击才真的清空（第一次只进入"确认"态）
    const clearResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const button = document.getElementById('clear-all');
          window.__clearCalled = false;

          // 第一次点击：只应当进入确认态，**不能**真的清空。
          button.click();
          await new Promise((r) => setTimeout(r, 150));
          const afterFirst = {
            cleared: window.__clearCalled === true,
            label: button.textContent,
            armed: button.classList.contains('armed')
          };

          // 第二次点击：这次才执行。
          button.click();
          await new Promise((r) => setTimeout(r, 300));
          const afterSecond = {
            cleared: window.__clearCalled === true,
            label: button.textContent,
            armed: button.classList.contains('armed')
          };

          return JSON.stringify({ afterFirst, afterSecond });
        })()`
      )
    )
    check(
      'AC-14：清空按钮第一次点击**不**执行，只进入确认态',
      clearResult.afterFirst.cleared === false &&
        clearResult.afterFirst.label === '确认清空？' &&
        clearResult.afterFirst.armed === true,
      JSON.stringify(clearResult.afterFirst)
    )
    check(
      'AC-14：清空按钮第二次点击才真的清空，并复位按钮文案',
      clearResult.afterSecond.cleared === true &&
        clearResult.afterSecond.label === '清空' &&
        clearResult.afterSecond.armed === false,
      JSON.stringify(clearResult.afterSecond)
    )

    // 7b) 删除按钮同样要二次确认（不可逆操作应该长得一样）
    //
    // 注意删除按钮在**展开的详情区**里，所以要先展开一行再去点它 ——
    // 直接查 `#records button` 会找不到（第一版就是这么失败的）。
    const deleteResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__lastDelete = null;

          // 先确保至少有一行是展开的。
          let button = Array.from(document.querySelectorAll('#records .record button')).find(
            (b) => b.textContent === '删除'
          );
          if (!button) {
            const toggle = document.querySelector('#records .record .record-toggle');
            if (!toggle) return JSON.stringify({ error: '没有可展开的记录行' });
            toggle.click();
            await new Promise((r) => setTimeout(r, 250));
            button = Array.from(document.querySelectorAll('#records .record button')).find(
              (b) => b.textContent === '删除'
            );
          }
          if (!button) return JSON.stringify({ error: '展开后仍找不到删除按钮' });

          button.click();
          await new Promise((r) => setTimeout(r, 150));
          const afterFirst = {
            deleted: window.__lastDelete,
            label: button.textContent,
            armed: button.classList.contains('armed')
          };

          button.click();
          await new Promise((r) => setTimeout(r, 350));
          return JSON.stringify({ afterFirst, deletedAfterSecond: window.__lastDelete });
        })()`
      )
    )
    check(
      '删除按钮第一次点击**不**执行，只进入确认态（显示确认删除？）',
      deleteResult.afterFirst &&
        deleteResult.afterFirst.deleted === null &&
        deleteResult.afterFirst.label === '确认删除？' &&
        deleteResult.afterFirst.armed === true,
      JSON.stringify(deleteResult.afterFirst)
    )
    check(
      '删除按钮第二次点击才真的删除',
      Boolean(deleteResult.deletedAfterSecond),
      JSON.stringify(deleteResult)
    )

    // 8) XSS 检查：面板渲染的一切都来自页面，绝不能用 innerHTML
    const xssResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          // 换一份带 HTML 标记的数据，看它会不会被当成结构渲染。
          const originalSend = window.chrome.runtime.sendMessage;
          window.chrome.runtime.sendMessage = async (message) => {
            if (message.type === 'history.list') {
              return {
                ok: true,
                result: {
                  rows: [{
                    id: 'evil',
                    createdAt: Date.now(),
                    selector: '<img src=x onerror=window.__XSS_HIT=1>',
                    tagName: '<b>bold</b>',
                    url: 'https://example.com',
                    tabTitle: '<script>window.__XSS_HIT=2<\\/script>',
                    hasComment: true,
                    comment: '<img src=x onerror=window.__XSS_HIT=3>',
                    thumbnail: null,
                    hasScreenshot: false,
                    screenshotOmittedReason: '<img src=x onerror=window.__XSS_HIT=4>'
                  }],
                  schemaMismatch: false
                }
              };
            }
            return originalSend(message);
          };
          // 用 storage 变更事件强制刷新（清空按钮现在是两步确认，
          // 点一次只进入确认态；这里要的是"重新渲染"，不是"清空"）。
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 300));
          window.chrome.runtime.sendMessage = originalSend;
          return JSON.stringify({
            xssHit: typeof window.__XSS_HIT !== 'undefined' ? window.__XSS_HIT : null,
            renderedAsText: document.querySelector('.record-title')
              ? document.querySelector('.record-title').textContent
              : null,
            injectedElements: document.querySelectorAll('#records img, #records script, #records b').length
          });
        })()`
      )
    )
    check(
      '安全性：页面内容里的 HTML 标记被当作纯文本渲染（零 innerHTML）',
      xssResult.xssHit === null &&
        xssResult.injectedElements === 0 &&
        typeof xssResult.renderedAsText === 'string' &&
        xssResult.renderedAsText.includes('<img'),
      JSON.stringify(xssResult)
    )

    // —— 顶栏四颗按钮必须"看起来是一套" ——
    //
    // 用户反馈：顶栏那几颗按钮与「元素注释」不像一套东西。
    // （当时是"导出所选 / 下载 .md / 清空"三颗，现在下载那颗已删除。）
    // 查下来那三颗**根本没有样式**（基类 button 只有 font/color/cursor，
    // 没有背景与边框），于是渲染成纯文字。
    //
    // 这里用**计算样式**逐个比对形状参数，而不是去解析 CSS 文本：
    // 解析文本只能证明"我写了这些规则"，计算样式才能证明"浏览器真的把它们渲染成一样"。
    const barButtons = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const ids = ['start-element-note', 'export-selected', 'clear-all'];
          const shape = {};
          for (const id of ids) {
            const node = document.getElementById(id);
            const cs = getComputedStyle(node);
            shape[id] = {
              height: Math.round(node.getBoundingClientRect().height),
              borderRadius: cs.borderRadius,
              paddingTop: cs.paddingTop,
              paddingLeft: cs.paddingLeft,
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              // 有底色才算"按钮"；纯文字的背景是透明的。
              hasBackground:
                cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent',
              background: cs.backgroundColor,
              color: cs.color,
              display: cs.display
            };
          }
          return JSON.stringify(shape);
        })()`
      )
    )

    const ids = ['start-element-note', 'export-selected', 'clear-all']
    const baseline = barButtons['start-element-note']
    for (const id of ids) {
      const s = barButtons[id]
      check(
        `顶栏按钮 ${id} 的形状与「元素注释」一致（高度/圆角/内边距/字号/字重）`,
        s.height === baseline.height &&
          s.borderRadius === baseline.borderRadius &&
          s.paddingTop === baseline.paddingTop &&
          s.paddingLeft === baseline.paddingLeft &&
          s.fontSize === baseline.fontSize &&
          s.fontWeight === baseline.fontWeight &&
          s.display === baseline.display,
        JSON.stringify({ baseline, actual: s })
      )
      check(
        `顶栏按钮 ${id} 有底色（不是渲染成纯文字）`,
        s.hasBackground === true,
        JSON.stringify({ background: s.background })
      )
    }

    // 加号图标必须是**有尺寸且不被压缩**的。
    //
    // `.icon` 此前一条样式都没有：SVG 在 inline-flex 按钮里是 flex item，
    // 默认 `flex-shrink: 1`，面板一窄就被压到 0 宽 —— 表现是"按钮上本该有个
    // 加号却什么都看不见"，而代码里它明明在那儿。
    // 这类 bug 只在窄面板下出现，正是最容易被漏掉的那种。
    const iconState = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const icon = document.querySelector('#start-element-note .icon');
          if (!icon) return JSON.stringify({ error: '按钮里没有图标' });
          const rect = icon.getBoundingClientRect();
          return JSON.stringify({
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            flexShrink: getComputedStyle(icon).flexShrink,
            tag: icon.tagName.toLowerCase()
          });
        })()`
      )
    )
    check(
      '「元素注释」按钮带加号图标，且图标有实际尺寸（不被 flex 压没）',
      iconState.tag === 'svg' && iconState.width >= 10 && iconState.height >= 10,
      JSON.stringify(iconState)
    )
    check(
      '图标的 flex-shrink 是 0（面板变窄时不会把它压掉）',
      iconState.flexShrink === '0',
      String(iconState.flexShrink)
    )

    // 四个色相要真的不同 —— 用户说"可以使用不同的颜色"，而颜色是这里唯一的分工手段。
    // —— 按钮底色统一（用户要求，**推翻了**早先"用不同颜色区分语义"那条） ——
    //
    // 用户原话："这一排按钮的有点五颜六色的感觉，太乱了，背景统一成黑字白底。"
    //
    // 早先那条断言要求"至少三种颜色"，方向正好相反。**需求变了，断言必须跟着变** ——
    // 留着它会让正确的实现一直红。这里不是删掉，是改成新契约。
    const backgrounds = ids.map((id) => barButtons[id].background)
    check(
      '【用户要求】四颗按钮底色统一（不再五颜六色）',
      new Set(backgrounds).size === 1,
      JSON.stringify(backgrounds)
    )
    check(
      '【用户要求】统一后的底色是白底（不是灰底/彩底）',
      /^rgb\(255,\s*255,\s*255\)$/.test(backgrounds[0]),
      String(backgrounds[0])
    )
    check(
      '【用户要求】按钮文字是深色（黑字白底，对比度足够）',
      ids.every((id) => {
        const match = String(barButtons[id].color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
        if (!match) {
          return false
        }
        // 相对亮度：三个通道都低才算"黑字"。
        return Number(match[1]) < 80 && Number(match[2]) < 80 && Number(match[3]) < 80
      }),
      JSON.stringify(ids.map((id) => barButtons[id].color))
    )

    const entryResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__lastExportIds = window.__lastExportIds || null;
          window.__grabbedViaPanel = false;
          const button = document.getElementById('start-element-note');
          if (!button) return JSON.stringify({ error: '面板里没有「进入抓取模式」按钮' });
          button.click();
          await new Promise((r) => setTimeout(r, 200));
          return JSON.stringify({
            noticeText: document.getElementById('notice').textContent,
            noticeHidden: document.getElementById('notice').hidden
          });
        })()`
      )
    )
    check(
      '面板里有「元素注释」入口（点图标改成开面板后必须有地方开始抓取）',
      entryResult.error === undefined,
      String(entryResult.error)
    )
    check(
      '点它之后给出用户可见的反馈',
      entryResult.noticeHidden === false &&
        typeof entryResult.noticeText === 'string' &&
        entryResult.noticeText.length > 0,
      JSON.stringify(entryResult)
    )

    // —— 权限补救路径（真机 bug：面板按钮报注入失败，快捷键却能用的那个）——
    //
    // 机制：Chrome 的 activeTab 只在"点图标 / 按快捷键"那一刻授予，且**页面一导航
    // 就撤销**。面板常驻，所以从面板点按钮时常常没有授权。修复是给一个授权按钮。
    const permissionResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__activeTabValid = false;
          window.__hostGranted = false;
          window.__permissionRequests = [];
          window.__gestureOpen = false;

          // 第一步：没有授权时点「进入抓取模式」→ 应当失败并露出授权按钮
          document.getElementById('start-element-note').click();
          await new Promise((r) => setTimeout(r, 250));

          const grantRow = document.getElementById('grant-row');
          const noticeAfterFail = document.getElementById('notice').textContent;
          const rowVisible = grantRow && !grantRow.hidden;

          // 第二步：点「授权访问所有网站」——**带手势**点击
          const grantButton = document.getElementById('grant-host');
          if (!grantButton) {
            return JSON.stringify({ error: '面板里没有授权按钮' });
          }
          window.__clickWithGesture(grantButton);
          await new Promise((r) => setTimeout(r, 350));

          return JSON.stringify({
            rowVisibleAfterFail: rowVisible,
            noticeAfterFail,
            permissionRequests: window.__permissionRequests,
            hostGranted: window.__hostGranted === true,
            rowHiddenAfterGrant: grantRow.hidden === true,
            noticeAfterGrant: document.getElementById('notice').textContent
          });
        })()`
      )
    )

    check(
      '无授权时点「进入抓取模式」会露出授权补救按钮（而不是只丢一句错误）',
      permissionResult.rowVisibleAfterFail === true,
      JSON.stringify(permissionResult)
    )
    check(
      '失败提示说明了真实原因（提到了授权）',
      typeof permissionResult.noticeAfterFail === 'string' &&
        permissionResult.noticeAfterFail.includes('授权'),
      String(permissionResult.noticeAfterFail).slice(0, 120)
    )
    check(
      '点授权按钮会调 chrome.permissions.request',
      // 只统计**授权按钮自己**发起的那次。
      // 点「元素注释」现在也会顺手申请一次（截图也靠这个权限），
      // 而那条路径的点击在夹具里没有手势窗口 —— 不区分的话会把两次混在一起。
      Array.isArray(permissionResult.permissionRequests) &&
        permissionResult.permissionRequests.some((r) => r.withinGesture === true),
      JSON.stringify(permissionResult.permissionRequests)
    )
    check(
      '【手势窗口】permissions.request 在用户手势内同步发起 —— 前面不能有 await',
      Array.isArray(permissionResult.permissionRequests) &&
        permissionResult.permissionRequests.some((r) => r.withinGesture === true),
      '没有任何一次申请落在手势窗口内。真实 Chrome 会直接拒绝，表现为"点了授权没反应"。' +
        '检查 click handler 里 permissions.request 之前是否有 await。' +
        JSON.stringify(permissionResult.permissionRequests)
    )
    check(
      '授权成功后重试进入抓取模式并隐藏授权行',
      permissionResult.hostGranted === true &&
        permissionResult.rowHiddenAfterGrant === true &&
        typeof permissionResult.noticeAfterGrant === 'string' &&
        permissionResult.noticeAfterGrant.includes('已'),
      JSON.stringify(permissionResult)
    )

    // —— 自动刷新（真机 bug：面板常驻，抓了新元素它不更新）——
    const autoRefresh = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          // 先让列表处于"不是 3 条"的状态，才能证明刷新真的发生了。
          const before = document.querySelectorAll('#records .record').length;
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 400)); // 等过 150ms 防抖
          const after = document.querySelectorAll('#records .record').length;
          return JSON.stringify({ before, after, listeners: window.__storageListeners.length });
        })()`
      )
    )
    check(
      '面板订阅了 storage 变更（自动刷新的机制）',
      autoRefresh.listeners >= 1,
      JSON.stringify(autoRefresh)
    )
    check(
      '历史被写入后列表自动更新，不需要手动重开面板',
      autoRefresh.after === 3,
      JSON.stringify(autoRefresh)
    )

    // —— 导出与清空都在全选行右侧（用户要求） ——
    //
    // 用户原话："导出全部 和 清空 按钮放到全选按钮的右边来，我觉得这个比较合理。"
    //
    // 合理在哪：这两个动作都**作用于当前搜索出来的结果**，而"作用范围"
    // 正是由全选按钮表达的。原来放在顶栏，它们和"注释模式"那两个入口挤在一起，
    // 看起来像同一类动作，实际完全不是。
    const exportPlacement = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const row = document.getElementById('select-all-row');
          const box = document.getElementById('select-all');
          const exp = document.getElementById('export-selected');
          const clear = document.getElementById('clear-all');
          const rect = (n) => { const r = n.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; };
          return JSON.stringify({
            exportInRow: row.contains(exp),
            clearInRow: row.contains(clear),
            exportRightOfSelectAll: rect(exp).left > rect(box).left,
            clearRightOfExport: rect(clear).left > rect(exp).left
          });
        })()`
      )
    )
    check(
      '【用户要求】导出与清空已移到全选行内，且在全选按钮右侧',
      exportPlacement.exportInRow === true &&
        exportPlacement.clearInRow === true &&
        exportPlacement.exportRightOfSelectAll === true &&
        exportPlacement.clearRightOfExport === true,
      JSON.stringify(exportPlacement)
    )

    // —— 导出必须两步（用户要求） ——
    //
    // 用户原话："导出全部需要用户二次确认，避免误触。"
    //
    // 要验的是**第一次点击绝不能真的导出**。只验"第二次能导出"是不够的 ——
    // 那在"一次就导出"的实现下同样成立。
    const exportConfirmState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const button = document.getElementById('export-selected');
          if (button.__resetConfirm) button.__resetConfirm();
          await new Promise((r) => setTimeout(r, 90));
          // 探针自己数：确认态下不该有任何导出请求。
          window.__exportCalls = 0;
          const idleLabel = button.textContent;

          button.click();
          await new Promise((r) => setTimeout(r, 250));

          return JSON.stringify({
            idleLabel,
            armedLabel: button.textContent,
            armedClass: button.classList.contains('armed'),
            exportCallsAfterFirst: window.__exportCalls
          });
        })()`
      )
    )
    check(
      '【用户要求】点「导出」第一次**不导出**，只进入确认态',
      exportConfirmState.exportCallsAfterFirst === 0 &&
        exportConfirmState.armedLabel === '确认导出？' &&
        exportConfirmState.armedClass === true,
      JSON.stringify(exportConfirmState)
    )

    // 鼠标离开立即复位（与清空/删除同一条规则）。
    const exportLeaveState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const button = document.getElementById('export-selected');
          button.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
          await new Promise((r) => setTimeout(r, 150));
          return JSON.stringify({
            label: button.textContent,
            armed: button.classList.contains('armed'),
            exportCalls: window.__exportCalls
          });
        })()`
      )
    )
    check(
      '【用户要求】导出确认态在鼠标离开后立即复位，且不执行导出',
      exportLeaveState.armed === false &&
        exportLeaveState.label === exportConfirmState.idleLabel &&
        exportLeaveState.exportCalls === 0,
      JSON.stringify(exportLeaveState)
    )

    // —— 确认态在**悬停时**也必须看得清（真机反馈："这完全看不清啊"） ——
    //
    // 这个 bug 只在悬停时才出现，而**用户必然悬停在按钮上**（刚点过它才进确认态）。
    // 之前那条 hover 断言只覆盖了 `armed-note`，漏掉了 `.armed` ——
    // 于是「确认导出？」变成白字配浅灰，几乎不可读。
    //
    // 断言用 **WCAG 对比度**，而不是"背景是不是某个颜色"：
    // 前者直接对应"能不能看清"，后者只对应"是不是我写的那条规则"。
    const confirmContrast = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          // 对比度计算放在页面里 —— 颜色值本来就在这边。
          const luminance = (color) => {
            const m = String(color).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
            if (!m) return null;
            const parts = [m[1], m[2], m[3]].map((v) => {
              const c = Number(v) / 255;
              return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
          };
          const contrast = (a, b) => {
            const la = luminance(a), lb = luminance(b);
            if (la === null || lb === null) return null;
            const hi = Math.max(la, lb), lo = Math.min(la, lb);
            return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
          };

          const results = {};
          for (const id of ['export-selected', 'clear-all']) {
            const button = document.getElementById(id);
            if (button.__resetConfirm) button.__resetConfirm();
            await new Promise((r) => setTimeout(r, 60));
            // 先移开鼠标，量"未悬停"基准
            const before = getComputedStyle(button);
            const beforePair = { bg: before.backgroundColor, fg: before.color };

            // 进确认态
            button.click();
            await new Promise((r) => setTimeout(r, 150));
            const armedIdle = getComputedStyle(button);
            const armedPair = { bg: armedIdle.backgroundColor, fg: armedIdle.color };

            results[id] = {
              inArmedState: button.classList.contains('armed'),
              label: button.textContent,
              armedIdle: { ...armedPair, contrast: contrast(armedPair.bg, armedPair.fg) },
              beforeBg: beforePair.bg,
              rect: (() => { const r = button.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()
            };
          }
          return JSON.stringify(results);
        })()`
      )
    )

    // 逐颗按钮：把真实鼠标移上去，再量一次对比度。
    for (const id of ['export-selected', 'clear-all']) {
      const box = confirmContrast[id]
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.rect.x, y: box.rect.y })
      await new Promise((r) => setTimeout(r, 180))
      const hovered = JSON.parse(
        await evaluate(
          cdp,
          `(() => {
            const cs = getComputedStyle(document.getElementById(${JSON.stringify(id)}));
            return JSON.stringify({ bg: cs.backgroundColor, fg: cs.color });
          })()`
        )
      )
      const contrast = (() => {
        const parse = (color) => {
          const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
          if (!m) return null
          return [m[1], m[2], m[3]].map((v) => {
            const c = Number(v) / 255
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
          })
        }
        const lum = (color) => {
          const p = parse(color)
          return p === null ? null : 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
        }
        const a = lum(hovered.bg)
        const b = lum(hovered.fg)
        if (a === null || b === null) return null
        const hi = Math.max(a, b)
        const lo = Math.min(a, b)
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
      })()

      check(
        `前置：${id} 已进入确认态`,
        confirmContrast[id].inArmedState === true,
        JSON.stringify(confirmContrast[id])
      )
      check(
        // 4.5 是 WCAG AA 对正文的门槛。低于它基本等于"看不清"。
        // 真机上这里是 1.2 左右（白字配浅灰）。
        `【真机反馈】${id} 确认态**未悬停时**对比度 ≥ 4.5（看得清）`,
        confirmContrast[id].armedIdle.contrast !== null &&
          confirmContrast[id].armedIdle.contrast >= 4.5,
        JSON.stringify(confirmContrast[id].armedIdle)
      )
      check(
        // ⚠️ 这一条才是真正的回归：鼠标必然停在按钮上（刚点过它）。
        `【真机反馈】${id} 确认态**悬停时**对比度仍 ≥ 4.5（不是白字配浅灰）`,
        contrast !== null && contrast >= 4.5,
        JSON.stringify({ hovered, contrast })
      )

      // —— 导出用浅蓝、清空/删除用红（用户要求） ——
      //
      // "二次确认导出的按钮背景底色我觉得可以换成浅蓝色的"。
      //
      // 语义上是对的：红色是**危险色**，而导出只是产出一个文件 ——
      // 不可逆程度远低于清空/删除。用红色是在喊错误的警报。
      //
      // 这条不只验"是浅蓝"，还验**悬停时仍然是浅蓝** ——
      // 上一轮那个 bug 就是悬停被另一条更高特异性的规则接走。
      if (id === 'export-selected') {
        const isBlue = (color) => {
          const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
          if (!m) return false
          const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
          // 浅蓝：蓝通道最高、亮（不是深色）、且不是灰（蓝比红明显高）。
          return b > r && b >= g && b > 180 && r < 250 && b - r > 20
        }
        check(
          '【用户要求】「确认导出？」底色是**浅蓝**（不是危险色的红）',
          isBlue(confirmContrast[id].armedIdle.bg),
          JSON.stringify({
            idleBg: confirmContrast[id].armedIdle.bg,
            hoverBg: hovered.bg
          })
        )
        check(
          '【用户要求】「确认导出？」悬停时仍是浅蓝（不被红色规则接走）',
          isBlue(hovered.bg),
          JSON.stringify({ hoverBg: hovered.bg })
        )
      }
      if (id === 'clear-all') {
        const isRed = (color) => {
          const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
          if (!m) return false
          const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
          return r > g && r > b && r - g > 40
        }
        check(
          '清空是**破坏性**操作，确认态保留危险色（红）—— 与导出区分开',
          isRed(confirmContrast[id].armedIdle.bg) && isRed(hovered.bg),
          JSON.stringify({
            idleBg: confirmContrast[id].armedIdle.bg,
            hoverBg: hovered.bg
          })
        )
      }
    }
    // 收尾：把鼠标移开、复位确认态。
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 500 })
    await evaluate(
      cdp,
      `(() => {
        for (const id of ['export-selected', 'clear-all']) {
          const b = document.getElementById(id);
          if (b.__resetConfirm) b.__resetConfirm();
        }
        return true;
      })()`
    )

    // —— 深色主题下破坏性确认态也要看得清（用户要求） ——
    //
    // 用户原话："深色按钮的清空下 按钮背景底色可以换成白色呀 要不然有点看不清……
    // 但是你要注意，白色背景色可能与现在的白字产生冲突 这个我自己调整配色。"
    //
    // 他说得对，而且自己指出了冲突点：那个深红在**深色面板上几乎融进背景**，
    // 而直接把底换成白、字保持白就完全看不见了。
    //
    // 所以断言必须在**两个主题下都跑** —— 只测默认主题等于只测了一半，
    // 而"另一半"正是用户看到问题的那个。
    const darkContrast = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const root = document.documentElement;
          const previous = root.dataset.resolved;
          const results = {};
          for (const theme of ['light', 'dark']) {
            root.dataset.resolved = theme;
            await new Promise((r) => setTimeout(r, 80));

            const button = document.getElementById('clear-all');
            if (button.__resetConfirm) button.__resetConfirm();
            await new Promise((r) => setTimeout(r, 60));
            const idleBg = getComputedStyle(button).backgroundColor;

            button.click();
            await new Promise((r) => setTimeout(r, 150));
            const cs = getComputedStyle(button);
            results[theme] = {
              armed: button.classList.contains('armed'),
              label: button.textContent,
              bg: cs.backgroundColor,
              fg: cs.color,
              idleBg: idleBg
            };
            if (button.__resetConfirm) button.__resetConfirm();
            await new Promise((r) => setTimeout(r, 60));
          }
          root.dataset.resolved = previous;
          return JSON.stringify(results);
        })()`
      )
    )

    const ratioOf = (bg, fg) => {
      const parse = (color) => {
        const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
        if (!m) return null
        return [m[1], m[2], m[3]].map((v) => {
          const c = Number(v) / 255
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
        })
      }
      const lum = (color) => {
        const p = parse(color)
        return p === null ? null : 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
      }
      const a = lum(bg)
      const b = lum(fg)
      if (a === null || b === null) return null
      const hi = Math.max(a, b)
      const lo = Math.min(a, b)
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
    }

    for (const theme of ['light', 'dark']) {
      check(
        `前置：${theme} 主题下清空按钮进入了确认态`,
        darkContrast[theme].armed === true && darkContrast[theme].label === '确认清空？',
        JSON.stringify(darkContrast[theme])
      )
      check(
        `【用户要求】${theme} 主题下「确认清空？」对比度 ≥ 4.5`,
        ratioOf(darkContrast[theme].bg, darkContrast[theme].fg) >= 4.5,
        JSON.stringify({
          ...darkContrast[theme],
          contrast: ratioOf(darkContrast[theme].bg, darkContrast[theme].fg)
        })
      )
    }
    check(
      // 用户的判断："深色下有点看不清" —— 根因是那个深红在深面板上对比太低，
      // 所以深色主题下用**白底**把它从背景里拉出来。
      '【用户要求】深色主题下确认态底色是**白**（把它从深面板里拉出来）',
      /^rgb\(255,\s*255,\s*255\)$/.test(darkContrast.dark.bg),
      JSON.stringify({ darkBg: darkContrast.dark.bg, lightBg: darkContrast.light.bg })
    )
    check(
      // 用户自己指出的冲突：白底不能配白字。所以深色下文字必须是**深色**。
      //
      // 判据用**相对亮度**而不是原始通道值：#b91c1c 的红通道是 185（很高），
      // 但它的亮度只有 0.045 —— 那是深红，不是亮红。
      // 我第一版用"红通道 < 120"卡，得到假红。
      '【用户要求】深色主题下确认态文字是**深色**（不与白底冲突）',
      (() => {
        const parse = (color) => {
          const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
          if (!m) return null
          return [m[1], m[2], m[3]].map((v) => {
            const c = Number(v) / 255
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
          })
        }
        const p = parse(darkContrast.dark.fg)
        if (p === null) return false
        const luminance = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
        return luminance < 0.3
      })(),
      JSON.stringify({ darkFg: darkContrast.dark.fg })
    )
    check(
      '浅色主题**不变**（深红底白字，本来就清楚）—— 改动只针对深色',
      /^rgb\(185,\s*28,\s*28\)$/.test(darkContrast.light.bg),
      JSON.stringify({ lightBg: darkContrast.light.bg })
    )


    // —— 全选 ——
    const selectAllState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const row = document.getElementById('select-all-row');
          const box = document.getElementById('select-all');
          const label = document.getElementById('select-all-label');
          const exportButton = document.getElementById('export-selected');

          const rowVisible = row && !row.hidden;
          const labelBefore = label.textContent;

          // 全选
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 80));
          const afterCheckAll = document.querySelectorAll('#records .record input[type=checkbox]:checked').length;
          const exportLabel = exportButton.textContent;

          // 取消全选
          box.checked = false;
          box.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 80));
          const afterUncheckAll = document.querySelectorAll('#records .record input[type=checkbox]:checked').length;
          const exportDisabledAgain = exportButton.disabled;

          // 只勾一条 → 全选框应为半选
          const first = document.querySelector('#records .record input[type=checkbox]');
          first.checked = true;
          first.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 80));

          return JSON.stringify({
            rowVisible,
            label: labelBefore,
            afterCheckAll,
            exportLabel,
            afterUncheckAll,
            exportDisabledAgain,
            indeterminateOnPartial: document.getElementById('select-all').indeterminate,
            checkedOnPartial: document.getElementById('select-all').checked
          });
        })()`
      )
    )

    check(
      '全选控件在有记录时出现，标签写明总条数',
      selectAllState.rowVisible === true && String(selectAllState.label).includes('全选（3）'),
      JSON.stringify(selectAllState)
    )
    check(
      // 全选后按钮文案不带计数，但**全选行**要如实显示选中了多少条 ——
      // 数量信息集中在一处，而不是按钮上再重复一遍。
      '点全选会把三条全部选中，数量显示在「已选 N / 总数」那一行',
      selectAllState.afterCheckAll === 3 &&
        String(selectAllState.label).includes('3') &&
        selectAllState.exportLabel === '导出所选',
      JSON.stringify(selectAllState)
    )
    check(
      // 取消全选后按钮**仍然可用**，只是语义从"导出所选"回到"导出全部"。
      '取消全选会清空选择（按钮保持可用，动作回到「导出全部」）',
      selectAllState.afterUncheckAll === 0 && selectAllState.exportDisabledAgain === false,
      JSON.stringify(selectAllState)
    )
    check(
      '部分选中时全选框是半选状态（不靠 checked 单独表达）',
      selectAllState.indeterminateOnPartial === true && selectAllState.checkedOnPartial === false,
      JSON.stringify(selectAllState)
    )

    // —— 标题右侧的统计块：按用户要求删除 ——
    //
    // 顺带验一件容易漏的事：那个统计 span 带 `flex: 1 1 auto`，是**它**把外观
    // 分段控件推到右边的。删掉后如果不补 `margin-left: auto`，分段控件会紧贴标题。
    const statsGone = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const bar = document.querySelector('.bar-title');
          const theme = document.getElementById('theme-switch');
          const barRect = bar.getBoundingClientRect();
          const themeRect = theme.getBoundingClientRect();

          return JSON.stringify({
            elementAbsent: document.getElementById('stats') === null,
            textAbsent: !document.body.textContent.includes('缩略图约'),
            // 贴右：分段控件右边缘与标题行右边缘的差应当很小
            themeOnRight: Math.abs(barRect.right - themeRect.right) < 4
          });
        })()`
      )
    )
    check(
      '【用户要求】标题右侧的「N 条 · 缩略图约 X MB」统计已删除',
      statsGone.elementAbsent === true && statsGone.textAbsent === true,
      JSON.stringify(statsGone)
    )
    check(
      '删掉统计后外观切换仍贴右边缘（原来靠那个统计块撑开）',
      statsGone.themeOnRight === true,
      JSON.stringify(statsGone)
    )

    // —— 全选的可点区域：只应是复选框与文字，不是整行 ——
    //
    // 用户反馈"我没点击到文字也会触发全选"。第一版把 label 做成整行，
    // 于是右半屏的空白也成了点击目标。这里用**真实鼠标事件**按坐标验证：
    // 点空白处不该改状态，点文字才该改。
    const hitArea = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const row = document.getElementById('select-all-row');
          const label = row.querySelector('.select-all-hit');
          const rowRect = row.getBoundingClientRect();
          const labelRect = document.querySelector('.select-all-hit').getBoundingClientRect();
          // 行可能在视口之外（面板变长后），先滚进来再量坐标 ——
          // 否则 elementFromPoint 对viewport 外的点返回 null，
          // 断言会在"容器/标签"之间得不到任何答案（第一版就是 null）。
          row.scrollIntoView({ block: 'center' });
          await new Promise((r) => setTimeout(r, 150));
          const rowRect2 = row.getBoundingClientRect();
          const labelRect2 = document.querySelector('.select-all-hit').getBoundingClientRect();
          const searchRect = document.getElementById('record-search').getBoundingClientRect();

          // 全选行右侧现在放的是**搜索框**，不再是空白 ——
          // 所以"点空白不触发全选"要改到另一处真正的空白：标签与搜索框之间。
          const emptyX = Math.round((labelRect2.right + searchRect.left) / 2);
          const emptyY = Math.round(rowRect2.top + rowRect2.height / 2);
          const hit = document.elementFromPoint(emptyX, emptyY);

          return JSON.stringify({
            emptyPoint: { x: emptyX, y: emptyY },
            hitId: hit ? hit.id : null,
            hitClass: hit ? hit.className : null,
            hitIsContainer: hit === row,
            hitIsLabel: Boolean(hit && hit.classList && hit.classList.contains('select-all-hit')),
            labelPoint: {
              x: Math.round(labelRect2.left + labelRect2.width / 2),
              y: Math.round(labelRect2.top + labelRect2.height / 2)
            }
          });
        })()`
      )
    )
    check(
      '全选行里标签与搜索框之间的空白落在容器上，而不是可点的 label 上',
      hitArea.hitIsContainer === true && hitArea.hitIsLabel === false,
      JSON.stringify(hitArea)
    )

    // 先把状态清干净，并记下**点之前**的选中数。
    // 用绝对数（"应当等于 0"）会读到前面用例留下的残留 —— 那是测试的问题，
    // 不是命中区的问题。比"点前点后有没有变化"才是这条断言真正要问的。
    const beforeEmptyClick = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const box = document.getElementById('select-all');
          if (box.checked) {
            box.checked = false;
            box.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return JSON.stringify({
            selected: document.querySelectorAll('#records .record input[type=checkbox]:checked').length
          });
        })()`
      )
    )
    await new Promise((r) => setTimeout(r, 150))

    // 真实点击空白处 → 不该有任何变化
    await dispatchMouse(cdp, 'mousePressed', hitArea.emptyPoint.x, hitArea.emptyPoint.y, 'left')
    await dispatchMouse(cdp, 'mouseReleased', hitArea.emptyPoint.x, hitArea.emptyPoint.y, 'left')
    await new Promise((r) => setTimeout(r, 200))
    const afterEmptyClick = JSON.parse(
      await evaluate(
        cdp,
        `JSON.stringify({
          checked: document.getElementById('select-all').checked,
          selected: document.querySelectorAll('#records .record input[type=checkbox]:checked').length
        })`
      )
    )
    check(
      // 搜索框是全选行里的新邻居；点它当然不该改选中状态。
      '【新】点搜索框不触发全选',
      afterEmptyClick.checked === false &&
        afterEmptyClick.selected === beforeEmptyClick.selected,
      JSON.stringify({ before: beforeEmptyClick, after: afterEmptyClick })
    )

    // 真实点击文字 → 应当全选
    await dispatchMouse(cdp, 'mousePressed', hitArea.labelPoint.x, hitArea.labelPoint.y, 'left')
    await dispatchMouse(cdp, 'mouseReleased', hitArea.labelPoint.x, hitArea.labelPoint.y, 'left')
    await new Promise((r) => setTimeout(r, 200))
    const afterLabelClick = JSON.parse(
      await evaluate(
        cdp,
        `JSON.stringify({
          checked: document.getElementById('select-all').checked,
          selected: document.querySelectorAll('#records .record input[type=checkbox]:checked').length
        })`
      )
    )
    check(
      '点全选文字仍然正常工作（收窄命中区没有把功能一起砍掉）',
      afterLabelClick.checked === true && afterLabelClick.selected === 3,
      JSON.stringify(afterLabelClick)
    )

    // —— 快捷键区块：**已按用户要求整体删除** ——
    //
    // 原来这里有一整套断言（录制、保存、浏览器占用组合被拒、跳转 Chrome 设置页）。
    // 那些功能已经不在代码里，断言无从谈起。
    //
    // 但"设置区里不再有快捷键"这件事本身值得断言 —— **删干净**是个需要被守护的
    // 状态：哪天有残留、或有人重新加回来，没人会发现。
    const shortcutRemoved = JSON.parse(
      await evaluate(
        cdp,
        `(() => JSON.stringify({
          hint: document.getElementById('shortcut-hint') === null,
          note: document.getElementById('shortcut-note') === null,
          editButton: document.getElementById('edit-shortcuts') === null,
          noChordApi: typeof globalThis.__EG__?.describeChord === 'undefined'
        }))()`
      )
    )
    check(
      '【用户要求】快捷键区块已从设置区删干净（DOM 与代码都无残留）',
      shortcutRemoved.hint === true &&
        shortcutRemoved.note === true &&
        shortcutRemoved.editButton === true &&
        shortcutRemoved.noChordApi === true,
      JSON.stringify(shortcutRemoved)
    )


    // —— 外观主题：三态切换 + 平滑过渡 ——
    const themeState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const root = document.documentElement;
          const initial = {
            preference: root.dataset.theme,
            resolved: root.dataset.resolved,
            colorScheme: root.style.colorScheme
          };

          const buttons = Array.from(
            document.querySelectorAll('#theme-switch button')
          ).map((b) => ({ value: b.dataset.themeValue, pressed: b.getAttribute('aria-pressed') }));

          // 切到深色。
          // 注意读值的时机： theme-animating 类会挂一条 320ms 的过渡，
          // 所以**立刻**读 getComputedStyle 拿到的是过渡的起始值（浅色）。
          // 第一版就是这么失败的 —— 那条失败恰好证明"渐变式切换"真的生效了。
          // 所以：同步捕获同步态（属性、过渡类），等过渡结束再读颜色。
          //
          // 注意上面这行不能写反引号：整段是外层模板字符串，反引号会把它截断
          // （这个错误在本文件里已经犯过三次）。
          document.querySelector('#theme-switch button[data-theme-value="dark"]').click();
          const darkSync = {
            preference: root.dataset.theme,
            resolved: root.dataset.resolved,
            colorScheme: root.style.colorScheme,
            animating: root.classList.contains('theme-animating'),
            stored: localStorage.getItem('eg-theme'),
            pressed: Array.from(document.querySelectorAll('#theme-switch button'))
              .filter((b) => b.getAttribute('aria-pressed') === 'true')
              .map((b) => b.dataset.themeValue)
          };
          await new Promise((r) => setTimeout(r, 420));
          const afterDark = Object.assign(darkSync, {
            bodyBg: getComputedStyle(document.body).backgroundColor,
            bodyColor: getComputedStyle(document.body).color,
            bgVariable: getComputedStyle(root).getPropertyValue('--bg').trim()
          });

          // 切回浅色
          document.querySelector('#theme-switch button[data-theme-value="light"]').click();
          await new Promise((r) => setTimeout(r, 420));
          const afterLight = {
            resolved: root.dataset.resolved,
            bodyBg: getComputedStyle(document.body).backgroundColor
          };

          // 过渡只应在切换的那一次挂上，切完要摘掉
          await new Promise((r) => setTimeout(r, 420));
          const animatingAfterSettle = root.classList.contains('theme-animating');

          return JSON.stringify({ initial, buttons, afterDark, afterLight, animatingAfterSettle });
        })()`
      )
    )

    check(
      '主题三态控件存在且默认「跟随系统」',
      themeState.buttons.length === 3 &&
        themeState.buttons.some((b) => b.value === 'system') &&
        themeState.initial.preference === 'system',
      JSON.stringify({ buttons: themeState.buttons, initial: themeState.initial })
    )
    check(
      '切到深色：偏好与解析结果都变了，并且写进了 localStorage（下次打开不闪白）',
      themeState.afterDark.preference === 'dark' &&
        themeState.afterDark.resolved === 'dark' &&
        themeState.afterDark.stored === 'dark',
      JSON.stringify(themeState.afterDark)
    )
    check(
      '深色下底色/文字真的换了（不是只改了个属性名）',
      themeState.afterDark.bodyBg !== themeState.afterLight.bodyBg &&
        themeState.afterDark.bgVariable === '#000000',
      JSON.stringify({
        darkBg: themeState.afterDark.bodyBg,
        darkVar: themeState.afterDark.bgVariable,
        lightBg: themeState.afterLight.bodyBg
      })
    )
    check(
      '切换时挂上过渡类（渐变式切换），淡出后自动摘掉（不影响 hover）',
      themeState.afterDark.animating === true && themeState.animatingAfterSettle === false,
      JSON.stringify({
        during: themeState.afterDark.animating,
        after: themeState.animatingAfterSettle
      })
    )
    check(
      '分段控件的选中态跟着走（不是写死的）',
      themeState.afterDark.pressed.length === 1 && themeState.afterDark.pressed[0] === 'dark',
      JSON.stringify(themeState.afterDark.pressed)
    )
    check(
      '同时设置了 color-scheme，让原生滚动条也跟随主题',
      themeState.afterDark.colorScheme === 'dark',
      String(themeState.afterDark.colorScheme)
    )

    // —— 抓取模式的按钮切换与面板侧 Esc（两个真机反馈）——
    //
    // 1. 进入抓取模式后按钮要变成「取消元素注释」—— 否则再点它只是重新 arm，
    //    用户以为在取消，实际没变化，会反复点。
    // 2. 点过面板按钮之后焦点在面板里，而拾取器的 Esc 挂在**页面**的 document 上
    //    —— 按键到不了页面，所以"有时候按 Esc 不退出"。面板必须自己也听一次。
    const grabStateResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__activeTabValid = true;
          window.__hostGranted = true;

          // 先把状态复位成"未开启"再测。
          // 上一条用例结束时面板处于"已开启"，不复位的话 labelIdle 会读到
          // 「取消元素注释」—— 那是测试前置条件的问题，不是按钮逻辑的问题。
          window.__grabArmed = false;
          window.__lastGrabCancel = false;
          window.chrome.runtime.__fireMessage({ type: 'grab.state', armed: false });
          await new Promise((r) => setTimeout(r, 100));

          const button = document.getElementById('start-element-note');
          // 读**文案 span**，不读按钮的 textContent。
          // 按钮里还有加号 SVG 与 HTML 注释，textContent 会带上换行缩进。
          // 而且读 span 本身就在证明"文案住在独立节点里"—— 文案一旦被写回按钮
          // 根节点（那会删掉图标），这里就会失败。
          const labelNode = document.getElementById('start-element-note-label');
          const labelIdle = labelNode.textContent;

          // 进入抓取模式
          button.click();
          await new Promise((r) => setTimeout(r, 250));
          const labelArmed = labelNode.textContent;
          // **另一个入口**在此时应当保持常态。
          //
          // 真机反馈："为什么我点击元素注释，同时出现了两个取消？不应该我当前
          // 操作的是哪个你就应该显示哪个取消吗？" —— 这条断言就是为它加的：
          // 只验自己那个按钮变了，抓不到"两个都变"。
          /*
           * 「悬停注释」按钮已按用户要求删除。
           *
           * 原来这里会读**另一个入口**，断言它保持常态 —— 那是为"两个按钮同时
           * 变成取消"那次真机反馈加的。现在只剩一个入口，那条断言换成
           * "这个按钮真的不在了"（见下面的 check）。
           */
          const hoverButtonGone = document.getElementById('start-hover-note') === null;
          const ariaArmed = button.getAttribute('aria-label');
          // 类名随按钮改名一起换成了 armed-note。（本段在模板字符串里，注释不能出现反引号。）
          //
          // 这里**同时**验类名与"确实有背景色"：光加 class 不写 CSS 不会报错、
          // 不会警告，只是看起来没变化 —— 而这个项目正好踩过那个坑
          // （primary-note / hover-note 两个类当初压根没定义，按钮发灰）。
          const styledArmed =
            button.classList.contains('armed-note') &&
            getComputedStyle(button).backgroundColor !== 'rgba(0, 0, 0, 0)';
          const focusedAfterClick = document.activeElement === button;

          // 面板侧按 Esc —— 应当发出 grab.cancel 并把按钮改回来
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await new Promise((r) => setTimeout(r, 250));
          const labelAfterEsc = labelNode.textContent;
          const cancelSent = window.__lastGrabCancel === true;

          // 再进入一次，然后模拟"内容脚本从页面里报了关闭"
          button.click();
          await new Promise((r) => setTimeout(r, 250));
          const labelRearmed = labelNode.textContent;
          window.chrome.runtime.__fireMessage({ type: 'grab.state', armed: false });
          await new Promise((r) => setTimeout(r, 100));
          const labelAfterPush = labelNode.textContent;

          return JSON.stringify({
            labelIdle,
            labelArmed,
            hoverButtonGone,
            ariaArmed,
            styledArmed,
            focusedAfterClick,
            labelAfterEsc,
            cancelSent,
            labelRearmed,
            labelAfterPush
          });
        })()`
      )
    )
    check(
      '进入抓取模式后按钮变成「取消注释」',
      grabStateResult.labelIdle === '元素注释' &&
        grabStateResult.labelArmed === '取消注释' &&
        grabStateResult.styledArmed === true,
      JSON.stringify(grabStateResult)
    )
    check(
      // 用户要求："现在元素注释我看也具备 悬停注释的功能了，
      // 我觉得可以直接去掉悬停注释这个按钮了。"
      //
      // 两个入口的行为本来就一样（都是左键点击才抓，悬停只用来高亮预览），
      // 留着一个点了没有任何额外效果的按钮只会让人以为是两种模式。
      //
      // 断言写成"**不存在**"才能挡住它被顺手加回来。
      '【用户要求】「悬停注释」按钮已删除（两个入口行为本来就一样）',
      grabStateResult.hoverButtonGone === true,
      JSON.stringify({ hoverButtonGone: grabStateResult.hoverButtonGone })
    )
    check(
      '「取消注释」的 aria-label 也说明了它是退出',
      typeof grabStateResult.ariaArmed === 'string' && grabStateResult.ariaArmed.includes('退出'),
      String(grabStateResult.ariaArmed)
    )

    // —— 「取消注释」悬停：只变淡，不换色（用户要求） ——
    //
    // 用户原话："取消注释 的按钮 hover 上去以后颜色变淡就可以了，不用改变颜色。"
    //
    // 这是一个**特异性**问题，读 CSS 文本看不出来：
    // `button.bar-btn:hover:not(:disabled)` 是 (0,3,1)，而 `.armed-note` 只有 (0,2,1)，
    // 于是悬停时深色底被浅灰 `--fill` 整个换掉。只有真的把鼠标移上去量一下才知道。
    //
    // 面板测试跑的是页面 JS，够不到 `:hover`，所以这里派发 **CDP 真实鼠标事件**。
    //
    // 先进入注释模式 —— 前面的用例结束时按了 Esc，按钮已经复位成「元素注释」。
    await evaluate(
      cdp,
      `(async () => {
        const button = document.getElementById('start-element-note');
        if (document.getElementById('start-element-note-label').textContent !== '取消注释') {
          button.click();
          await new Promise((r) => setTimeout(r, 300));
        }
        return true;
      })()`
    )
    const armedBox = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const button = document.getElementById('start-element-note');
          const cs = getComputedStyle(button);
          const r = button.getBoundingClientRect();
          return JSON.stringify({
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            label: document.getElementById('start-element-note-label').textContent,
            background: cs.backgroundColor
          });
        })()`
      )
    )
    check(
      '前置：「取消注释」处于激活态（深底）',
      armedBox.label === '取消注释' && armedBox.background === 'rgb(0, 0, 0)',
      JSON.stringify(armedBox)
    )

    // 先把鼠标放远处，量"未悬停"的基准值。
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 500 })
    await new Promise((r) => setTimeout(r, 150))
    const beforeHover = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const cs = getComputedStyle(document.getElementById('start-element-note'));
          return JSON.stringify({ background: cs.backgroundColor, opacity: cs.opacity });
        })()`
      )
    )

    // 移到按钮上 —— 触发真正的 :hover。
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: armedBox.x,
      y: armedBox.y
    })
    await new Promise((r) => setTimeout(r, 220))
    const duringHover = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const cs = getComputedStyle(document.getElementById('start-element-note'));
          return JSON.stringify({ background: cs.backgroundColor, opacity: cs.opacity });
        })()`
      )
    )

    // 收尾：把鼠标移开，别影响后面用例。
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 500 })

    check(
      '【用户要求】悬停「取消注释」时**底色不变**（不是换成另一种颜色）',
      duringHover.background === beforeHover.background,
      JSON.stringify({ before: beforeHover.background, during: duringHover.background })
    )
    check(
      '【用户要求】悬停「取消注释」时**变淡**（透明度下降）',
      Number(duringHover.opacity) < Number(beforeHover.opacity),
      JSON.stringify({ before: beforeHover.opacity, during: duringHover.opacity })
    )
    check(
      '点完按钮不把焦点留在按钮上（避免回车/空格误触发）',
      grabStateResult.focusedAfterClick === false,
      String(grabStateResult.focusedAfterClick)
    )
    check(
      '【真机反馈】焦点在面板时按 Esc 也能退出 —— 面板会发 grab.cancel 并复位按钮',
      grabStateResult.cancelSent === true && grabStateResult.labelAfterEsc === '元素注释',
      JSON.stringify(grabStateResult)
    )
    check(
      '页面里关掉抓取模式时按钮跟着变（推送，不靠轮询）',
      grabStateResult.labelRearmed === '取消注释' &&
        grabStateResult.labelAfterPush === '元素注释',
      JSON.stringify(grabStateResult)
    )

    /*
     * 这里原本有一整块「悬停模式不能点亮元素注释按钮（真机反馈的闪黑）」的测试。
     *
     * 它测的是**两个入口之间切换**时的状态推送：进入悬停 → 悬停命中（标志翻面）
     * → 退出，断言另一个按钮不闪。悬停入口按用户要求删除之后，那个前提消失了 ——
     * 只剩一个按钮，也就没有"另一个按钮会不会闪"这回事。
     */

    // —— 切换标签页后面板必须重新查一次状态（真机反馈） ——
    //
    // 用户原话："当我在页面A打开了元素注释，切换到页面B以后，此时右侧虽然显示的
    // 【取消注释】按钮（说明此时已经进入了元素的框选状态），但是实际没有显示框选的
    // 区域……我觉得像是之前切换页面后显示的取消注释的按钮实际上是新页面的打开注释
    // 的按钮。"
    //
    // 用户的判断是对的：那个按钮的状态是**页面 A 的残留**。
    // 面板只在 `window.focus` / `visibilitychange` 时刷新，而**切页这两个都不触发**
    // （侧边面板是独立文档，一直处于显示状态）。
    const tabSwitchState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const elementButton = document.getElementById('start-element-note');

          // 页面 A：已进入元素注释
          window.__grabArmed = true;
          window.__grabMode = 'click';
          window.chrome.runtime.__fireMessage({ type: 'grab.state', armed: true, mode: 'click' });
          await new Promise((r) => setTimeout(r, 80));
          const onPageA = {
            label: document.getElementById('start-element-note-label').textContent,
            styled: elementButton.classList.contains('armed-note')
          };

          // 切到页面 B —— B 上什么都没开
          window.__grabArmed = false;
          window.__grabMode = null;
          window.__stateQueries = 0;
          const listenerCount = window.chrome.tabs.__fireActivated(2);
          await new Promise((r) => setTimeout(r, 250));

          return JSON.stringify({
            onPageA,
            listenerCount,
            stateQueriesAfterSwitch: window.__stateQueries,
            afterSwitch: {
              label: document.getElementById('start-element-note-label').textContent,
              styled: elementButton.classList.contains('armed-note')
            }
          });
        })()`
      )
    )
    check(
      '前置：页面 A 上按钮确实是「取消注释」',
      tabSwitchState.onPageA.label === '取消注释' && tabSwitchState.onPageA.styled === true,
      JSON.stringify(tabSwitchState.onPageA)
    )
    check(
      '【真机反馈】切到页面 B 后，面板**重新查了一次** grab.state',
      tabSwitchState.stateQueriesAfterSwitch >= 1,
      JSON.stringify({
        listenerCount: tabSwitchState.listenerCount,
        queries: tabSwitchState.stateQueriesAfterSwitch
      })
    )
    check(
      '【真机反馈】切到未进入模式的页面 B 后，按钮回到「元素注释」',
      tabSwitchState.afterSwitch.label === '元素注释' &&
        tabSwitchState.afterSwitch.styled === false,
      JSON.stringify(tabSwitchState.afterSwitch)
    )

    // —— 点「元素注释」时必须**顺手申请 host 权限**（截图靠它）——
    //
    // 真机卡住的地方：`captureVisibleTab` 要 `<all_urls>` 或 `activeTab`，
    // 而授权只能由面板的点击来申请。我第一版把它做成"失败之后才出现按钮"，
    // 于是用户得先失败一次、再滚到面板顶部找那个按钮 —— 顺序把人绕晕了。
    // 现在改成一进抓取模式就申请。
    const prefetchPermission = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__activeTabValid = true;
          window.__hostGranted = false;
          window.__grabArmed = false;
          window.__permissionRequests = [];
          window.__gestureOpen = false;
          window.chrome.runtime.__fireMessage({ type: 'grab.state', armed: false });
          await new Promise((r) => setTimeout(r, 100));

          // 带手势点击（真实用户点按钮就是这个时机）
          window.__clickWithGesture(document.getElementById('start-element-note'));
          await new Promise((r) => setTimeout(r, 300));

          return JSON.stringify({
            requests: window.__permissionRequests,
            hostGranted: window.__hostGranted === true
          });
        })()`
      )
    )
    check(
      '点「元素注释」会顺手申请 host 权限（截图也需要它，一次授权覆盖两件事）',
      Array.isArray(prefetchPermission.requests) &&
        prefetchPermission.requests.length >= 1 &&
        prefetchPermission.requests[0].origins.includes('<all_urls>'),
      JSON.stringify(prefetchPermission)
    )
    check(
      '【手势窗口】这次申请也在用户手势内同步发起 —— 前面不能有 await',
      Array.isArray(prefetchPermission.requests) &&
        prefetchPermission.requests.some((r) => r.withinGesture === true),
      '申请落在手势窗口之外。检查 start-element-note 的 click handler 里，' +
        'permissions.request 之前是否有 await。' +
        JSON.stringify(prefetchPermission.requests)
    )

    // —— 编辑注释后滚动位置不能跳回顶部（真机反馈）——
    //
    // 两个成因叠加：`storage.onChanged` 自动刷新会触发整表重建，
    // 而 render() 开头那句 `recordsElement.textContent = ''` 让列表高度瞬间塌成 0
    // —— 浏览器把滚动位置夹到顶部，之后再填回内容也回不去。
    //
    // 这里必须**真的让页面可滚动**再测：3 条记录撑不满一屏，滚动位置恒为 0，
    // 那样断言永远通过、也永远测不出问题。所以先展开所有行把内容撑高。
    const scrollState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          // 关键：**记录要少**（就用夹具的三条），高度全靠"展开详情"撑起来。
          // 这才是真机场景（用户原话："展开以后就会，就几条"）。
          //
          // 我第一版加了 22 条记录想"让页面更可滚动"，结果把测试改坏了：
          // 二十多条即使详情区全空也比视口高，滚动永远夹不到顶部 —— 于是
          // 撤掉修复它照样绿，等于没测。**高度必须依赖详情区**，才测得出
          // "重建时详情区集体变空"这个塌缩。
          window.__extraRows = 0;
          // 详情走真实链路（面板 → worker → 存储）有延迟，这个中间态才是 bug 的温床。
          window.__detailDelayMs = 200;
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 600));

          // 展开全部行，把高度撑起来。
          const toggles = Array.from(document.querySelectorAll('#records .record .record-toggle'));
          for (const toggle of toggles) {
            if (toggle.textContent === '详情') {
              toggle.click();
              await new Promise((r) => setTimeout(r, 260));
            }
          }
          await new Promise((r) => setTimeout(r, 400));

          // 滚动容器现在是 .scroll-area，不是文档 —— 文档被设成了 overflow:hidden。
          const scroller = document.querySelector('.scroll-area');
          const maxScroll = scroller.scrollHeight - scroller.clientHeight;

          // 找一条**当前没有注释**的记录，写下注释 —— 这会让主行结构变化，
          // 正好走那条"替换整行"的路径。
          const boxes = Array.from(document.querySelectorAll('#records textarea.comment-input'));
          const target = boxes[boxes.length - 1];
          if (!target) return JSON.stringify({ error: '没有找到可编辑的评论框' });
          const recordId = target.dataset.recordId;

          // 先聚焦再取基准值：focus() 默认会把元素滚进视口，
          // 在聚焦前取值会把这次"滚到输入框"算进结果里 —— 那是测试的假象。
          target.focus();
          await new Promise((r) => setTimeout(r, 200));
          const before = scroller.scrollTop;

          target.value = '滚动位置测试';
          target.dispatchEvent(new Event('input', { bubbles: true }));
          // 失焦触发落库；之后 storage 变更还会触发一次自动刷新。
          target.blur();
          await new Promise((r) => setTimeout(r, 900));

          const after = scroller.scrollTop;
          return JSON.stringify({
            scrollable: maxScroll > 0,
            maxScroll,
            before,
            after,
            recordId,
            annotated: window.__lastAnnotate ? window.__lastAnnotate.comment : null,
            stillThere: Boolean(
              document.querySelector('.record[data-record-id="' + recordId + '"]')
            )
          });
        })()`
      )
    )

    check(
      '前置：展开后页面确实可滚动（否则这条断言没有鉴别力）',
      scrollState.scrollable === true && scrollState.before > 0,
      JSON.stringify(scrollState)
    )
    check(
      '【真机反馈】编辑注释并失焦后，滚动位置保持不动（不跳回顶部）',
      scrollState.after === scrollState.before,
      JSON.stringify({ before: scrollState.before, after: scrollState.after })
    )
    check(
      '注释确实落库了（滚动保持不是因为保存没发生）',
      typeof scrollState.annotated === 'string' &&
        scrollState.annotated.includes('滚动位置测试'),
      JSON.stringify(scrollState.annotated)
    )

    // —— 机制层面的断言：记录集合没变时**不该整表重建** ——
    //
    // 这是"编辑注释后滚动跳顶"的直接对策，而且它是**可测的**：
    // 整表重建会换掉所有行节点（旧节点被移除），就地更新则保留它们。
    // 我无法在 harness 里复现出滚动跳顶本身（试过三种配置都不跳），
    // 所以退一步锁住机制 —— "不重建"是能验证的那个部分，
    // 而塌缩只可能发生在重建里。
    const rebuildCheck = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const firstBefore = document.querySelector('#records .record');
          const detailBefore = document.querySelector('#records .record .record-body');

          // 触发一次自动刷新（模拟 storage.onChanged）
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 500));

          const firstAfter = document.querySelector('#records .record');
          const detailAfter = document.querySelector('#records .record .record-body');

          return JSON.stringify({
            sameRowNode: firstBefore === firstAfter,
            sameDetailNode: detailBefore === detailAfter,
            detailStillRendered: Boolean(detailAfter),
            recordCount: document.querySelectorAll('#records .record').length
          });
        })()`
      )
    )
    check(
      '记录集合没变时**不重建** DOM —— 详情区节点保持原样（滚动跳顶的根因就在重建里）',
      rebuildCheck.sameRowNode === true &&
        rebuildCheck.sameDetailNode === true &&
        rebuildCheck.detailStillRendered === true,
      JSON.stringify(rebuildCheck)
    )

    // —— 点缩略图看大图 ——
    // —— 点缩略图：直接在浏览器主区域开预览（用户要求） ——
    //
    // 用户原话："截图全屏展示应该是在左侧页面打开预览，而不是在侧板栏打开。"
    //
    // 我原来做的是"面板内浮层 + 一个新标签页按钮"—— 两步。浮层那一步是多余的
    // 中转：面板只有约 320px，一张 1000px 宽的截图在那里怎么放大都看不清。
    const screenshotOpen = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__createdTabs = [];
          const thumb = document.querySelector('img.record-thumb');
          if (!thumb) return JSON.stringify({ error: '没有可点的缩略图' });

          const cursor = getComputedStyle(thumb).cursor;
          const role = thumb.getAttribute('role');

          thumb.click();
          await new Promise((r) => setTimeout(r, 300));

          return JSON.stringify({
            cursor,
            role,
            created: window.__createdTabs || [],
            previewRequested: window.__lastPreviewRequest || null,
            // 不该在面板里留下任何浮层。
            lightboxLeftBehind: Boolean(document.getElementById('element-grab-lightbox'))
          });
        })()`
      )
    )
    check(
      '缩略图看起来可点（cursor: zoom-in + 可访问性语义）',
      screenshotOpen.cursor === 'zoom-in' && screenshotOpen.role === 'button',
      JSON.stringify(screenshotOpen)
    )
    check(
      // 用户最终要的是**当前页面里的浮层**：面板内浮层太小（约 320px）、
      // 新标签页会离开正在注释的页面。所以面板只发一个请求，由 worker
      // 把它送进当前页面。
      '【用户要求】点缩略图请求**在当前页面**弹预览浮层（不再开标签页）',
      Array.isArray(screenshotOpen.created) &&
        screenshotOpen.created.length === 0 &&
        Boolean(screenshotOpen.previewRequested),
      JSON.stringify({
        createdTabs: screenshotOpen.created,
        previewRequested: screenshotOpen.previewRequested
      })
    )
    check(
      '面板里不留下任何浮层（旧实现的痕迹要清干净）',
      screenshotOpen.lightboxLeftBehind === false,
      String(screenshotOpen.lightboxLeftBehind)
    )

    // —— 容量：可配置 + 在**选元素之前**就阻断 ——
    //
    // 用户要求默认 100 条 / 20 MB，并明确"不要等写完注释才阻断"。
    const capacityState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const MB = 1024 * 1024;
          window.__activeTabValid = true;
          window.__hostGranted = true;
          window.__grabArmed = false;
          window.__settings = { maxRecords: 100, maxBytes: 20 * MB };
          window.__capacityOverride = null;
          window.chrome.runtime.__fireMessage({ type: 'grab.state', armed: false });
          window.__fireStorageChange('settings');
          await new Promise((r) => setTimeout(r, 300));

          const recordsInput = document.getElementById('setting-max-records');
          const bytesInput = document.getElementById('setting-max-bytes');
          const defaults = { records: recordsInput.value, bytes: bytesInput.value };
          const capacityLine = document.getElementById('capacity-line').textContent;

          // 改成 5 条 / 50 MB
          recordsInput.value = '5';
          bytesInput.value = '50';
          document.getElementById('setting-save').click();
          await new Promise((r) => setTimeout(r, 350));
          const saved = window.__lastSettingsWrite;

          // 恢复默认按钮
          document.getElementById('setting-reset').click();
          await new Promise((r) => setTimeout(r, 350));
          const afterReset = window.__lastSettingsWrite;

          return JSON.stringify({
            defaults,
            capacityLine,
            saved,
            afterReset
          });
        })()`
      )
    )
    check(
      '容量设置默认是 100 条 / 20 MB',
      capacityState.defaults.records === '100' && capacityState.defaults.bytes === '20',
      JSON.stringify(capacityState.defaults)
    )
    check(
      '容量区显示当前占用与上限',
      typeof capacityState.capacityLine === 'string' &&
        capacityState.capacityLine.includes('100') &&
        capacityState.capacityLine.includes('MB'),
      String(capacityState.capacityLine)
    )
    check(
      '设置可保存，且输入按 MB 换算成字节',
      capacityState.saved &&
        capacityState.saved.maxRecords === 5 &&
        capacityState.saved.maxBytes === 50 * 1024 * 1024,
      JSON.stringify(capacityState.saved)
    )
    check(
      '「恢复默认」回到 100 条 / 20 MB',
      capacityState.afterReset &&
        capacityState.afterReset.maxRecords === 100 &&
        capacityState.afterReset.maxBytes === 20 * 1024 * 1024,
      JSON.stringify(capacityState.afterReset)
    )

    // 已满时：点「元素注释」应当**根本不进入抓取模式**
    const blockedState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__settings = { maxRecords: 3, maxBytes: 20 * 1024 * 1024 };
          window.__capacityOverride = {
            recordCount: 3,
            bytes: 4096,
            maxRecords: 3,
            maxBytes: 20 * 1024 * 1024,
            atLimit: true,
            reason: 'records'
          };
          window.__grabArmed = false;
          window.__shimCalls = [];
          window.chrome.runtime.__fireMessage({ type: 'grab.state', armed: false });
          await new Promise((r) => setTimeout(r, 150));

          const button = document.getElementById('start-element-note');
          button.click();
          await new Promise((r) => setTimeout(r, 400));

          const notice = document.getElementById('notice');
          const settingsOpen = document.querySelector('.settings') !== null;

          return JSON.stringify({
            label: document.getElementById('start-element-note-label').textContent,
            notice: notice ? notice.textContent : null,
            askedCapacity: window.__shimCalls.includes('history.capacity'),
            triedToArm: window.__shimCalls.includes('grab.manual.start'),
            settingsOpen
          });
        })()`
      )
    )
    check(
      '【用户要求】容量已满时点「元素注释」不会进入抓取模式（连模式都进不去）',
      blockedState.triedToArm === false && blockedState.label === '元素注释',
      JSON.stringify(blockedState)
    )
    check(
      '阻断前先查了容量（而不是靠写入失败兜底）',
      blockedState.askedCapacity === true,
      JSON.stringify(blockedState)
    )
    check(
      '阻断提示说清了现状与出路',
      typeof blockedState.notice === 'string' &&
        blockedState.notice.includes('上限') &&
        blockedState.notice.includes('容量设置'),
      String(blockedState.notice)
    )
    check(
      '被挡住时顺手展开容量设置区（不用用户自己去下面找）',
      blockedState.settingsOpen === true,
      String(blockedState.settingsOpen)
    )

    // 复位，免得影响后面的用例
    await evaluate(
      cdp,
      `(() => {
        window.__capacityOverride = null;
        window.__settings = { maxRecords: 100, maxBytes: 20 * 1024 * 1024 };
        return true;
      })()`
    )
    await new Promise((r) => setTimeout(r, 150))

    // —— 导出 / 清空：文案与语义随勾选状态切换 ——
    //
    // 用户要求：「导出所选」默认是「导出全部」，勾选后才变成「导出所选」；清空同样。
    // 「下载 .md」按钮已按用户要求删除（"导出全部就是下载 MD 的功能"），
    // 所以这里只剩两个按钮 —— 相关断言也一并去掉，不留对已删元素的引用。
    const semantics = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__activeTabValid = true;
          window.__hostGranted = true;
          window.__capacityOverride = null;
          window.__settings = { maxRecords: 100, maxBytes: 20 * 1024 * 1024 };
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 400));

          const box = document.getElementById('select-all');
          if (box.checked) {
            box.checked = false;
            box.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await new Promise((r) => setTimeout(r, 300));

          const read = () => ({
            export: document.getElementById('export-selected').textContent.trim(),
            clear: document.getElementById('clear-all').textContent.trim(),
            selectedLabel: document.getElementById('select-all-label').textContent.trim(),
            exportDisabled: document.getElementById('export-selected').disabled,
            clearDisabled: document.getElementById('clear-all').disabled
          });

          const none = read();

          const one = document.querySelector('#records .record input[type=checkbox]');
          if (one) {
            one.checked = true;
            one.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await new Promise((r) => setTimeout(r, 300));
          const some = read();

          document.getElementById('select-all').checked = true;
          document.getElementById('select-all').dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const all = read();

          document.getElementById('select-all').checked = false;
          document.getElementById('select-all').dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));

          // 没勾选时点导出：ids 应当留空（= 全部）
          window.__lastExportArgs = null;
          document.getElementById('export-selected').click();

          // 导出现在是两步确认：上面那一击只进「确认导出？」态，这一击才真的导出。
          await new Promise((r) => setTimeout(r, 130));
          document.getElementById('export-selected').click();
          await new Promise((r) => setTimeout(r, 350));
          const exportAllArgs = window.__lastExportArgs;

          // 勾一条后点清空（两步确认）：第二次点击才真的发，且带上那一条的 id
          const first = document.querySelector('#records .record input[type=checkbox]');
          first.checked = true;
          first.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          window.__lastClearArgs = null;
          const clearButton = document.getElementById('clear-all');
          const clearLabelBefore = clearButton.textContent.trim();
          clearButton.click();
          await new Promise((r) => setTimeout(r, 180));
          clearButton.click();
          await new Promise((r) => setTimeout(r, 400));

          return JSON.stringify({
            none,
            some,
            all,
            exportAllArgs,
            clearLabelBefore,
            clearArgs: window.__lastClearArgs
          });
        })()`
      )
    )

    check(
      '没勾选时：导出=「导出全部」、清空=「清空」，且有记录就可用',
      semantics.none.export === '导出全部' &&
        semantics.none.clear === '清空' &&
        semantics.none.exportDisabled === false &&
        semantics.none.clearDisabled === false,
      JSON.stringify(semantics.none)
    )
    check(
      '勾选一条后：两个按钮都变成「…所选」，文案里**不带数量**（用户要求）',
      semantics.some.export === '导出所选' && semantics.some.clear === '清空所选',
      JSON.stringify(semantics.some)
    )
    check(
      '全选后文案仍然是「…所选」—— 数量不该随选中数在按钮上跳动',
      semantics.all.export === '导出所选' && semantics.all.clear === '清空所选',
      JSON.stringify(semantics.all)
    )
    check(
      '数量信息**没有丢**：它仍在「已选 N / 总数」那一行',
      typeof semantics.all.selectedLabel === 'string' &&
        semantics.all.selectedLabel.includes('3'),
      JSON.stringify(semantics.all.selectedLabel)
    )
    check(
      '【用户要求】没勾选时导出真的导出全部（ids 留空，由 worker 展开）',
      semantics.exportAllArgs && semantics.exportAllArgs.ids === undefined,
      JSON.stringify(semantics.exportAllArgs)
    )
    check(
      '勾选后清空只删所选那一条（带上 id，而不是清空全部）',
      semantics.clearArgs &&
        Array.isArray(semantics.clearArgs.ids) &&
        semantics.clearArgs.ids.length === 1,
      JSON.stringify(semantics.clearArgs)
    )
    check(
      '清空按钮的文案在确认前就已经是「清空所选」',
      semantics.clearLabelBefore === '清空所选',
      String(semantics.clearLabelBefore)
    )

    // —— 设置区：快捷键与容量融合、常驻展开、位置在全选按钮上方、两栏一行 ——
    //
    // 用户要求："对快捷键触发设置、容量设置进行融合，放在全选按钮上面的位置"、
    // "配置项需要常驻展开"、"与顶部需要有一点间隙，不要紧贴顶部"、
    // "最多保存和最多占用放在一行，输入框不用那么长"。
    //
    // 位置用 DOM 顺序断言（compareDocumentPosition），不是靠"看起来在上面"：
    // 面板是纵向流式布局，文档顺序就是视觉顺序。
    const settingsLayout = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          // 先把滚动复位再量间距。
          //
          // 顶栏是固定的一项，而滚动发生在 .scroll-area 里 —— 不滚回顶部的话
          // 设置卡会滑到顶栏下面，量出来的间距是 0（第一版就是这样误判的）。
          const area = document.querySelector('.scroll-area');
          if (area) area.scrollTop = 0;
          window.scrollTo(0, 0);
          await new Promise((r) => requestAnimationFrame(() => r()));

          const settings = document.querySelector('.settings');
          const selectAll = document.getElementById('select-all-row');
          const records = document.getElementById('records');
          if (!settings) return JSON.stringify({ error: '没有设置区' });

          const inSettings = (id) => Boolean(settings.querySelector('#' + id));

          // DOCUMENT_POSITION_FOLLOWING === 4：settings 在 selectAll 之前
          const beforeSelectAll = Boolean(
            settings.compareDocumentPosition(selectAll) & Node.DOCUMENT_POSITION_FOLLOWING
          );
          const beforeRecords = Boolean(
            settings.compareDocumentPosition(records) & Node.DOCUMENT_POSITION_FOLLOWING
          );

          // 常驻展开：不该是 details（那就要点一下才展开），内容必须可见。
          const isDetails = settings.tagName.toLowerCase() === 'details';
          const recordsInput = document.getElementById('setting-max-records');
          const recordsRect = recordsInput.getBoundingClientRect();

          // 两个容量输入框是否在同一行：纵坐标差小于各自高度的一半
          const bytesInput = document.getElementById('setting-max-bytes');
          const bytesRect = bytesInput.getBoundingClientRect();
          const sameRow = Math.abs(recordsRect.top - bytesRect.top) < recordsRect.height / 2;

          // 输入框不该拉满整行
          const panelWidth = document.body.clientWidth;
          const inputWidth = recordsRect.width;

          // 设置区与顶部的间隙
          const settingsRect = settings.getBoundingClientRect();
          const barRect = document.querySelector('.bar').getBoundingClientRect();
          const topGap = Math.round(settingsRect.top - barRect.bottom);

          // 旧结构不该残留
          const settingsCount = document.querySelectorAll('.settings').length;
          const detailsCount = document.querySelectorAll('details.settings').length;

          return JSON.stringify({
            inSettings: {
              // 快捷键那几项已随功能删除，这里只留容量相关的。
              capacityLine: inSettings('capacity-line'),
              maxRecords: inSettings('setting-max-records'),
              maxBytes: inSettings('setting-max-bytes'),
              save: inSettings('setting-save'),
              reset: inSettings('setting-reset')
            },
            beforeSelectAll,
            beforeRecords,
            isDetails,
            summaryFontSize: getComputedStyle(settings.querySelector('summary')).fontSize,
            // 用量说明与「设置」标题的**矩形** —— 用来验它们在同一行且垂直居中。
            capacityRow: (() => {
              const titleNode = settings.querySelector('.settings-title');
              const lineNode = document.getElementById('capacity-line');
              const box = (node) => {
                if (!node) return null;
                const r = node.getBoundingClientRect();
                return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), left: Math.round(r.left) };
              };
              return { title: box(titleNode), line: box(lineNode) };
            })(),
            detailsOpen: settings.open === true,
            // 收起后卡片必须**确实变矮** —— 只转箭头而不隐藏内容是假收起。
            // 不去量正文容器的高度：不同 Chrome 版本对 details 内容的处理方式
            // 不一样（有的用 display:none，有的留在布局树里），
            // 量卡片总高度才是与实现无关、且正是用户能看到的效果。
            // （本段在模板字符串里，注释不能出现反引号。）
            collapseShrinks: await (async () => {
              const openHeight = settings.getBoundingClientRect().height;
              const wasOpen = settings.open;
              settings.open = false;
              await new Promise((r) => requestAnimationFrame(() => r()));
              await new Promise((r) => requestAnimationFrame(() => r()));
              const closedHeight = settings.getBoundingClientRect().height;
              settings.open = wasOpen;
              return { openHeight: Math.round(openHeight), closedHeight: Math.round(closedHeight) };
            })(),
            sameRow,
            panelWidth,
            inputWidth,
            topGap,
            settingsCount,
            detailsCount,
            maxRecordsAttr: recordsInput.getAttribute('max'),
            minRecordsAttr: recordsInput.getAttribute('min'),
            maxBytesAttr: bytesInput.getAttribute('max'),
            minBytesAttr: bytesInput.getAttribute('min'),
            // 当前已用量（下限的来源，见下面"调低上限"那组断言）
            usageRecords: document.querySelectorAll('#records .record').length
          });
        })()`
      )
    )
    check(
      // 需求变过一次：先要求"常驻展开"，后来要求"支持收起/展开"。
      // 现在的契约是**默认展开 + 可收起** —— 两者都要满足。
      '【用户要求】设置区可收起/展开，且**默认展开**',
      settingsLayout.isDetails === true &&
        settingsLayout.detailsCount === 1 &&
        settingsLayout.detailsOpen === true,
      JSON.stringify({
        isDetails: settingsLayout.isDetails,
        count: settingsLayout.detailsCount,
        open: settingsLayout.detailsOpen
      })
    )
    check(
      // 用户要求：「已用 11 / 100 条 · 2.0 / 20.0 MB」这个说明要和「设置」
      // 这个 title **水平对齐展示**。
      //
      // 只验"它在 summary 里"是不够的：搬进去了也可能因为 flex 换行掉到第二行，
      // 或者因为 margin 把它挤成单独一块。必须量**纵坐标**。
      '【用户要求】用量说明与「设置」标题在**同一行**且垂直居中',
      (() => {
        const title = settingsLayout.capacityRow && settingsLayout.capacityRow.title
        const line = settingsLayout.capacityRow && settingsLayout.capacityRow.line
        if (!title || !line) {
          return false
        }
        const titleCenter = title.top + title.height / 2
        const lineCenter = line.top + line.height / 2
        // 纵向中心差在 3px 以内 = 视觉上同一行、且对齐。
        // 同时确认它**在标题右侧**（不是被挤到下一行）。
        return Math.abs(titleCenter - lineCenter) <= 3 && line.top < title.bottom
      })(),
      JSON.stringify(settingsLayout.capacityRow)
    )
    check(
      '收起后卡片确实变矮（不是只转了个箭头）',
      settingsLayout.collapseShrinks.openHeight > settingsLayout.collapseShrinks.closedHeight,
      JSON.stringify(settingsLayout.collapseShrinks)
    )
    check(
      // 用户要求："设置两个字的字体可以稍微大一点。"
      // 顺带锁住一个更基本的规则：标题不该比正文小。
      // 原来它是 12px，而正文是 13px —— 那正是"看着不对但说不出哪里不对"的典型。
      '【用户要求】「设置」标题字号比正文大（原来 12px < 正文 13px）',
      Number.parseFloat(settingsLayout.summaryFontSize) >= 14,
      String(settingsLayout.summaryFontSize)
    )
    check(
      '【用户要求】设置区与顶部有间隙（不紧贴）',
      settingsLayout.topGap >= 6,
      String(settingsLayout.topGap)
    )
    check(
      '只有一处设置区（不留重复入口）',
      settingsLayout.settingsCount === 1,
      String(settingsLayout.settingsCount)
    )
    check(
      '【用户要求】条数与占用在**同一行**，且输入框不拉满整行',
      settingsLayout.sameRow === true &&
        settingsLayout.inputWidth < settingsLayout.panelWidth / 2,
      JSON.stringify({ sameRow: settingsLayout.sameRow, inputWidth: settingsLayout.inputWidth, panelWidth: settingsLayout.panelWidth })
    )
    check(
      '上限写进 input 属性：条数 max=1000、占用 max=512 MB',
      settingsLayout.maxRecordsAttr === '1000' && settingsLayout.maxBytesAttr === '512',
      JSON.stringify({
        records: [settingsLayout.minRecordsAttr, settingsLayout.maxRecordsAttr],
        bytes: [settingsLayout.minBytesAttr, settingsLayout.maxBytesAttr]
      })
    )
    check(
      // min 不再是 1，而是**当前已用量** —— 见后面的"调低上限"断言。
      '下限写进 input 属性，且等于当前已用量（不是 1）',
      settingsLayout.minRecordsAttr === String(settingsLayout.usageRecords) &&
        Number(settingsLayout.minRecordsAttr) > 1,
      JSON.stringify({
        min: settingsLayout.minRecordsAttr,
        usage: settingsLayout.usageRecords
      })
    )
    check(
      '常驻展开后占用信息直接可见（内容第一行就是容量）',
      (await evaluate(
        cdp,
        `document.getElementById('capacity-line').textContent.includes('已用')`
      )) === true,
      await evaluate(cdp, `document.getElementById('capacity-line').textContent`)
    )

    // —— 超限自动取最大值 ——
    //
    // 用户要求："超出上限以后应该自动将输入的内容转成最大值。"
    // 只靠 `<input max>` 不够：那玩意儿只在表单校验时生效，用户照样能敲出
    // 99999 并看着它留在框里，直到点保存才被后端收敛。
    const clampState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const records = document.getElementById('setting-max-records');
          const bytes = document.getElementById('setting-max-bytes');

          const type = (input, value) => {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          };

          type(records, '99999');
          const overMax = { value: records.value, marked: records.classList.contains('clamped') };

          type(records, '0');
          const belowMin = { value: records.value };

          type(records, '500');
          const inRange = { value: records.value, marked: records.classList.contains('clamped') };

          type(bytes, '9999');
          const bytesOverMax = { value: bytes.value };

          return JSON.stringify({ overMax, belowMin, inRange, bytesOverMax });
        })()`
      )
    )
    check(
      '【用户要求】条数超过上限 1000 时当场改成 1000（不是等点保存才收敛）',
      clampState.overMax.value === '1000',
      JSON.stringify(clampState.overMax)
    )
    check(
      '改成边界值时给出短暂视觉提示（用户知道系统改了他的输入）',
      clampState.overMax.marked === true,
      JSON.stringify(clampState.overMax)
    )
    check(
      // 下限现在是"当前已用量"，所以敲 0 会被收敛到用量而不是 1。
      '低于下限时被收敛到下限（不再固定是 1）',
      Number(clampState.belowMin.value) >= 1,
      JSON.stringify(clampState.belowMin)
    )
    check(
      '合法值不动它（收敛只在越界时发生）',
      clampState.inRange.value === '500' && clampState.inRange.marked === false,
      JSON.stringify(clampState.inRange)
    )
    check(
      '占用超过上限 512 时改成 512',
      clampState.bytesOverMax.value === '512',
      JSON.stringify(clampState.bytesOverMax)
    )

    // 用户明确要求删掉的那段提示，不该还在。
    const hintGone = await evaluate(
      cdp,
      `!document.body.textContent.includes('达到上限时会在') &&
       !document.body.textContent.includes('收紧上限会立刻按新上限回收')`
    )
    check('【用户要求】那段"选元素之前拦住你…"的提示已删除', hintGone === true, String(hintGone))


    // —— 「快捷键」与卡片顶边之间必须真的有间距 ——
    //
    // 这条断言是为一个真机反复出现的问题加的：用户多次说"快捷键和顶部预留一点间隙"，
    // 而我几次调大卡片的外边距都没有任何效果。
    //
    // 根因是 CSS 里有**两条** `.settings-body`：折叠版留下的旧规则
    // `padding: 0 12px 12px` 在新规则之后，同优先级 → 它赢 → 实际 padding-top 是 0。
    // 间距根本不存在，改外部数字当然没用。
    //
    // 所以这里断言的是**计算后的 padding-top**，而不是"我写了哪个数字" ——
    // 解析 CSS 文本只能证明我写了规则，计算样式才能证明浏览器真的应用了它。
    const settingsPadding = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const body = document.querySelector('.settings-body');
          const label = document.querySelector('.setting-label');
          const card = document.querySelector('.settings');
          const cs = getComputedStyle(body);
          const labelRect = label.getBoundingClientRect();
          const cardRect = card.getBoundingClientRect();

          return JSON.stringify({
            paddingTop: cs.paddingTop,
            paddingTopPx: parseFloat(cs.paddingTop),
            // 卡片顶边 → 「快捷键」文字顶边的实测距离
            measuredGap: Math.round(labelRect.top - cardRect.top)
          });
        })()`
      )
    )
    check(
      '【用户反馈】「快捷键」与卡片顶边之间有实际间距',
      // 间距的来源变了：现在由 `<summary>` 自己的内边距承担（顶部先经过标题行），
      // 所以量 `.settings-body` 的 padding-top 已经没有意义 —— 量**实测距离**才对。
      settingsPadding.measuredGap >= 14,
      JSON.stringify({
        measuredGap: settingsPadding.measuredGap,
        paddingTop: settingsPadding.paddingTop
      })
    )

    // —— 调低上限不得删除已有记录（真机反馈） ——
    //
    // 用户原话："用户当前设置的保存条数是 100，如果此时历史记录中已经存在 50 条了，
    // 但是用户此时又把这个额度调整成了 40 —— 现在的逻辑会把之前最早的 10 条删掉，
    // 这个逻辑是错误的。用户从大调小的时候，最低值必须与当前的使用量持平！"
    const floorState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          // 造出"已有 50 条"的局面：3 条基础 + 47 条补充。
          window.__extraRows = 47;
          window.__settings = { maxRecords: 100, maxBytes: 20 * 1024 * 1024 };
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 600));

          const records = document.getElementById('setting-max-records');
          const before = {
            rendered: document.querySelectorAll('#records .record').length,
            min: records.getAttribute('min'),
            value: records.value
          };

          // 试着调到 40 —— 应当被收敛到 50，而不是删掉 10 条
          records.value = '40';
          records.dispatchEvent(new Event('input', { bubbles: true }));
          const afterType = { value: records.value };

          document.getElementById('setting-save').click();
          await new Promise((r) => setTimeout(r, 700));

          return JSON.stringify({
            before,
            afterType,
            saved: window.__lastSettingsWrite,
            after: {
              rendered: document.querySelectorAll('#records .record').length,
              value: records.value,
              min: records.getAttribute('min')
            }
          });
        })()`
      )
    )
    check(
      '前置：夹具里确实有 50 条记录（否则这条断言没有鉴别力）',
      floorState.before.rendered === 50,
      JSON.stringify(floorState.before)
    )
    check(
      '【用户反馈】已有 50 条时输入 40，被当场收敛到 50（不是接受 40）',
      floorState.afterType.value === '50',
      JSON.stringify(floorState.afterType)
    )
    check(
      '【用户反馈】保存时上限被向上收敛到用量，**不**接受 40',
      floorState.saved && floorState.saved.maxRecords === 50,
      JSON.stringify(floorState.saved)
    )
    check(
      '【用户反馈】调低上限**没有删掉任何记录**（一条都不能少）',
      floorState.after.rendered === 50,
      JSON.stringify(floorState.after)
    )
    check(
      // 输入框的 min 跟着用量走 —— 用户敲之前就看得见"调不下去"，
      // 而不是敲完被静默改成别的数字。
      '输入框的 min 等于当前用量（50）',
      floorState.after.min === '50' && floorState.after.value === '50',
      JSON.stringify(floorState.after)
    )

    // 复位，免得影响后面的用例
    await evaluate(
      cdp,
      `(() => {
        window.__extraRows = 0;
        window.__settings = { maxRecords: 100, maxBytes: 20 * 1024 * 1024 };
        return true;
      })()`
    )
    await new Promise((r) => setTimeout(r, 300))

    // —— 搜索：按标题筛选 + 全选/导出/清空都作用于搜索结果 ——
    //
    // 用户要求："在全选按钮的右侧添加位置添加一个固定位置的搜索框，
    // 支持按照标题内容进行搜索，同时全选、导出、清空这块的按钮功能也需要
    // 支持对搜索结果的适配。"
    const searchState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__extraRows = 0;
          window.__settings = { maxRecords: 100, maxBytes: 20 * 1024 * 1024 };
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 500));

          const box = document.getElementById('record-search');
          const row = document.getElementById('select-all-row');
          if (!box) return JSON.stringify({ error: '没有搜索框' });

          // 位置：搜索框在同一行的右侧（左边缘应当在全选标签右边很远）
          const boxRect = box.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          const labelRect = document.querySelector('.select-all-hit').getBoundingClientRect();
          const onRight = boxRect.left > labelRect.right;
          const inSameRow =
            boxRect.top >= rowRect.top - 1 && boxRect.bottom <= rowRect.bottom + 1;

          const countVisible = () => document.querySelectorAll('#records .record').length;

          const all = { visible: countVisible() };

          // 搜「太淡」—— 只有 rec-2 的注释里含这两个字
          box.value = '太淡';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 250));

          // 筛选提示与它上方元素的实测间隙。
          // 量实测距离而不是读 CSS 数字：我有两次改了数字却被另一条同选择器的
          // 旧规则盖掉，只有量出来才知道浏览器真的应用了哪个。
          const note = document.getElementById('filter-note');
          const noteRect = note.getBoundingClientRect();
          const lastCard = document.querySelector('#records .record:last-of-type');
          const cardRect = lastCard ? lastCard.getBoundingClientRect() : null;
          const gapAboveNote = cardRect ? Math.round(noteRect.top - cardRect.bottom) : null;
          const filtered = {
            visible: countVisible(),
            labels: Array.from(document.querySelectorAll('.record-title')).map(
              (n) => n.textContent
            ),
            selectAllLabel: document.getElementById('select-all-label').textContent,
            exportLabel: document.getElementById('export-selected').textContent,
            filterNote: document.getElementById('filter-note').textContent,
            gapAboveNote: gapAboveNote,
            // **过滤之后**可见的 id —— 必须在筛选生效后取。
            // 在筛选前取会拿到 rec-1，而筛选后可见的是 rec-2，
            // 于是断言会误报（我的第一版就是这样）。
            visibleIds: Array.from(document.querySelectorAll('#records .record')).map(
              (n) => n.dataset.recordId
            )
          };

          // 全选 —— 只应当选中筛出来的那条
          window.__shimCalls = [];
          document.getElementById('select-all').checked = true;
          document.getElementById('select-all').dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 250));
          const afterSelectAll = {
            checkedRows: document.querySelectorAll('#records .record input[type=checkbox]:checked').length,
            // 选中集合里的具体 id —— 只看条数抓不到"勾错了对象"这类 bug。
            selectedIds: Array.from(document.querySelectorAll('#records .record input[type=checkbox]:checked'))
              .map((box) => {
                const item = box.closest('.record');
                return item ? item.dataset.recordId : null;
              }),
            label: document.getElementById('select-all-label').textContent
          };

          // 取消全选，回到"没勾选"—— 此时导出应当作用于**搜索结果**
          document.getElementById('select-all').checked = false;
          document.getElementById('select-all').dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 250));
          window.__lastExportArgs = null;
          document.getElementById('export-selected').click();

          // 导出现在是两步确认：上面那一击只进「确认导出？」态，这一击才真的导出。
          await new Promise((r) => setTimeout(r, 130));
          document.getElementById('export-selected').click();
          await new Promise((r) => setTimeout(r, 350));
          const exportArgs = window.__lastExportArgs;

          // 清空（两步确认）—— 同样只作用于搜索结果
          window.__lastClearArgs = null;
          const clearButton = document.getElementById('clear-all');
          clearButton.click();
          await new Promise((r) => setTimeout(r, 180));
          clearButton.click();
          await new Promise((r) => setTimeout(r, 400));
          const clearArgs = window.__lastClearArgs;

          // 搜一个不存在的词 —— 要给出"没有匹配"而不是"还没有记录"
          box.value = 'zzzz-不存在';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 250));
          const noMatch = {
            visible: countVisible(),
            noMatchShown: !document.getElementById('no-match').hidden,
            emptyShown: !document.getElementById('empty').hidden,
            exportDisabled: document.getElementById('export-selected').disabled
          };

          // 清空搜索恢复全部
          box.value = '';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 250));
          const restored = {
            visible: countVisible(),
            filterNoteHidden: document.getElementById('filter-note').hidden
          };

          // 把勾选清干净，别漏给后面的用例。
          // 显式遍历每个复选框，而不是只取消全选框 —— 部分选中时
          // 全选框的 checked 是 false，只看它会把残留的选择漏过去。
          // （本段在模板字符串里，注释不能出现反引号。）
          for (const box of document.querySelectorAll('#records .record input[type=checkbox]')) {
            if (box.checked) {
              box.checked = false;
              box.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          await new Promise((r) => setTimeout(r, 200));

          return JSON.stringify({
            onRight,
            inSameRow,
            searchWidth: Math.round(boxRect.width),
            // 筛出来的第一条的 id —— 全选断言要拿它比对"勾的是不是这一条"。
            firstVisibleId: (() => {
              const first = document.querySelector('#records .record');
              return first ? first.dataset.recordId : null;
            })(),
            all,
            filtered,
            afterSelectAll,
            exportArgs,
            clearArgs,
            noMatch,
            restored
          });
        })()`
      )
    )

    check(
      '【用户要求】搜索框在**全选行的右侧**（同一行、在全选文字之后）',
      searchState.onRight === true && searchState.inSameRow === true,
      JSON.stringify({ onRight: searchState.onRight, inSameRow: searchState.inSameRow })
    )
    check(
      // 用户要求"至少是现在宽度的 1 倍"。原来的固定宽度是 132px，
      // 所以下限按 132 * 2 = 264px 算。
      // 断言**实测宽度**：窄面板里它靠 flex-wrap 换到整行才够宽，
      // 只读 CSS 里的 flex-basis 是看不出来这件事的。
      '【用户要求】搜索框宽度至少是原来的 2 倍（≥264px）',
      typeof searchState.searchWidth === 'number' && searchState.searchWidth >= 264,
      String(searchState.searchWidth)
    )
    check(
      '【用户要求】按标题内容搜索：只有匹配的那条留在列表里',
      searchState.filtered.visible === 1 &&
        searchState.filtered.labels.length === 1 &&
        String(searchState.filtered.labels[0]).includes('太淡'),
      JSON.stringify(searchState.filtered)
    )
    check(
      '筛选时给出明确提示（用户不会以为记录丢了）',
      typeof searchState.filtered.filterNote === 'string' &&
        searchState.filtered.filterNote.includes('1 / 3'),
      String(searchState.filtered.filterNote)
    )
    check(
      '【用户反馈】筛选提示与上方的记录卡之间有实际间隙',
      searchState.filtered.gapAboveNote !== null && searchState.filtered.gapAboveNote >= 8,
      String(searchState.filtered.gapAboveNote)
    )

    // —— 滚动条不该挤压布局（真机反馈） ——
    //
    // 用户原话："由于我搜索出来的内容比较少，那个滚动条就会隐藏；当我删除内容
    // 以后，展示的内容就会变多，此时就会出现滚动条了，挤压元素，导致页面元素
    // 老是动态变化、跳来跳去的。"
    //
    // 对策是两层：滚动被关进固定高度的 `.scroll-area`（文档自己不滚），
    // 且它预留了 `scrollbar-gutter`。这里断言**内容宽度在有无滚动条时一致** ——
    // 那正是用户看到的"挤压"。
    const scrollSqueeze = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const area = document.querySelector('.scroll-area');
          if (!area) return JSON.stringify({ error: '没有滚动容器' });

          const listWidth = () => document.getElementById('records').getBoundingClientRect().width;

          // 造出"内容很少"的局面
          window.__extraRows = 0;
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 400));
          const box = document.getElementById('record-search');
          box.value = '太淡';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const few = {
            listWidth: listWidth(),
            scrollable: area.scrollHeight > area.clientHeight,
            docScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight
          };

          // 造出"内容很多"的局面
          box.value = '';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          window.__extraRows = 30;
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 700));
          const many = {
            listWidth: listWidth(),
            scrollable: area.scrollHeight > area.clientHeight
          };

          return JSON.stringify({ few, many });
        })()`
      )
    )
    check(
      '【用户反馈】内容由少变多时列表宽度**不变**（滚动条不再挤压布局）',
      scrollSqueeze.few && scrollSqueeze.many &&
        Math.abs(scrollSqueeze.few.listWidth - scrollSqueeze.many.listWidth) < 1,
      JSON.stringify(scrollSqueeze)
    )
    check(
      '【用户反馈】滚动发生在面板内部（文档本身不再滚动）',
      scrollSqueeze.few && scrollSqueeze.few.docScrolls === false,
      JSON.stringify(scrollSqueeze.few)
    )

    // 复位
    await evaluate(
      cdp,
      `(() => {
        window.__extraRows = 0;
        window.__fireStorageChange('records');
        return true;
      })()`
    )
    await new Promise((r) => setTimeout(r, 400))
    check(
      '【用户要求】全选只选中**搜索结果**里的记录',
      searchState.afterSelectAll.checkedRows === 1,
      JSON.stringify(searchState.afterSelectAll)
    )
    check(
      // 真机 bug："我对当前搜索出来的结果进行全选的操作的时候，会选到所有的历史记录。"
      //
      // 根因是**显示与动作用了两套判据**：`renderChrome` 的三态/计数早就按
      // `visibleRows()` 算，而全选的 change 处理函数还在遍历 `rows`（全部记录）。
      // 所以这条断言不能只看"勾了几条"，还要看**选中集合里到底是哪些 id** ——
      // 只看条数的话，筛出 1 条、结果勾了 3 条也能被抓到，但"筛出 2 条却勾了
      // 另外 2 条"这类就被漏掉了。
      '【用户反馈】全选作用于搜索结果：选中的 id 必须落在可见集合内',
      Array.isArray(searchState.afterSelectAll.selectedIds) &&
        searchState.afterSelectAll.selectedIds.length === 1 &&
        Array.isArray(searchState.filtered.visibleIds) &&
        searchState.filtered.visibleIds.length === 1 &&
        searchState.afterSelectAll.selectedIds[0] === searchState.filtered.visibleIds[0],
      JSON.stringify({
        selected: searchState.afterSelectAll.selectedIds,
        visible: searchState.filtered.visibleIds
      })
    )
    check(
      '【用户要求】筛选状态下「导出」作用于搜索结果（显式发送可见 id）',
      searchState.exportArgs &&
        Array.isArray(searchState.exportArgs.ids) &&
        searchState.exportArgs.ids.length === 1,
      JSON.stringify(searchState.exportArgs)
    )
    check(
      '【用户要求】筛选状态下「清空」同样只作用于搜索结果',
      searchState.clearArgs &&
        Array.isArray(searchState.clearArgs.ids) &&
        searchState.clearArgs.ids.length === 1,
      JSON.stringify(searchState.clearArgs)
    )
    check(
      '筛不出结果时给的是「没有匹配」而不是「还没有记录」（两种空态必须分开）',
      searchState.noMatch.visible === 0 &&
        searchState.noMatch.noMatchShown === true &&
        searchState.noMatch.emptyShown === false,
      JSON.stringify(searchState.noMatch)
    )
    check(
      '筛选无结果时导出/清空被禁用（没有对象可操作）',
      searchState.noMatch.exportDisabled === true,
      String(searchState.noMatch.exportDisabled)
    )
    check(
      '清空搜索词后列表恢复，筛选提示消失',
      searchState.restored.visible === 3 && searchState.restored.filterNoteHidden === true,
      JSON.stringify(searchState.restored)
    )

    // —— 提示位常驻 + 顶栏下方的统一间距 ——
    //
    // 用户要求："这个提示的地方常驻在前台，如果用户没有任何操作就显示 slogan"，
    // 并且"这个提示框也需要与顶部保持一定间隙"。
    const noticeState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const area = document.querySelector('.scroll-area');
          if (area) area.scrollTop = 0;
          await new Promise((r) => requestAnimationFrame(() => r()));

          const notice = document.getElementById('notice');
          const bar = document.querySelector('.bar');
          const barRect = bar.getBoundingClientRect();

          // 空闲态：先让面板回到"没有操作"的状态。
          const readState = () => {
            const cs = getComputedStyle(notice);
            return {
              hidden: notice.hidden,
              text: notice.textContent,
              muted: notice.classList.contains('muted'),
              gapFromBar: Math.round(notice.getBoundingClientRect().top - barRect.bottom),
              // 标语态也必须**在框里**（有底色），只是文字置灰。
              // 只量颜色是不够的：第一版把背景也去掉了，
              // 看起来就是框外的裸文字 —— 用户要的是"写在提示框里面"。
              background: cs.backgroundColor,
              hasBackground:
                cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent',
              color: cs.color
            };
          };

          // 触发一次操作，再看提示是否变成结果文案
          const exportButton = document.getElementById('export-selected');
          exportButton.click();

          // 导出现在是两步确认：上面那一击只进「确认导出？」态，这一击才真的导出。
          await new Promise((r) => setTimeout(r, 130));
          exportButton.click();
          await new Promise((r) => setTimeout(r, 350));
          const afterAction = readState();

          // 再回到空闲：用户没有后续操作时，反馈应当**自动回落**到标语。
          await new Promise((r) => setTimeout(r, 4500));
          const backToIdle = readState();

          return JSON.stringify({ afterAction, backToIdle });
        })()`
      )
    )
    check(
      '【用户要求】提示位**常驻在前台**（不再 hidden）',
      noticeState.afterAction.hidden === false && noticeState.backToIdle.hidden === false,
      JSON.stringify(noticeState)
    )
    check(
      '【用户要求】有操作时提示显示操作结果',
      typeof noticeState.afterAction.text === 'string' &&
        noticeState.afterAction.text.length > 0 &&
        noticeState.afterAction.muted === false,
      JSON.stringify(noticeState.afterAction)
    )
    check(
      '【用户要求】空闲时提示位显示 slogan（不是空白）',
      typeof noticeState.backToIdle.text === 'string' &&
        // 断言 slogan 的**关键短语**而不是整句：文案会调（已经改过两次），
        // 断整句会让每次改字都要动测试，而那不是它要防的东西。
        // 它要防的是"标语没了/变成空白"。
        noticeState.backToIdle.text.includes('直达 AI') &&
        noticeState.backToIdle.muted === true,
      JSON.stringify(noticeState.backToIdle)
    )
    check(
      // 用户要求："这句话要写在提示库里面啊，然后颜色置灰就好了。"
      // 两件事都要满足：**在框里**（有底色）+ **文字置灰**。
      // 只验颜色会漏掉"背景被去掉、变成框外裸文字"这个真实错误。
      '【用户要求】slogan 在提示框**里面**（有底色），只是文字置灰',
      noticeState.backToIdle.hasBackground === true &&
        noticeState.backToIdle.color !== noticeState.afterAction.color,
      JSON.stringify({
        background: noticeState.backToIdle.background,
        mutedColor: noticeState.backToIdle.color,
        actionColor: noticeState.afterAction.color
      })
    )
    check(
      // 这条是**通用规则**，不是针对提示框：顶栏下方第一块内容与顶栏之间
      // 必须有间距。间距在 `.scroll-area` 的 padding-top 上统一提供 ——
      // 用户为此提过三次（设置区、筛选提示、提示框），前两次我都是逐个元素打补丁。
      '【通用规则】顶栏下方的第一块内容与顶栏有间距（由容器统一提供）',
      noticeState.backToIdle.gapFromBar >= 8,
      JSON.stringify({ gap: noticeState.backToIdle.gapFromBar })
    )

    const selectAllWidths = JSON.parse(
      await evaluate(
        cdp,
        `(() => {
          const hit = document.querySelector('.select-all-hit');
          const label = document.getElementById('select-all-label');
          const original = label.textContent;
          const measure = (text) => {
            label.textContent = text;
            return Math.round(hit.getBoundingClientRect().width);
          };
          // 量的是**代码里真会出现的**四种文案，不是随便造的字符串。
          // 第一版量的是带空格的「已选 100 / 100」—— 那个形态代码里已经不用了，
          // 于是断言要求了一个并不存在的更宽情形，逼着 CSS 留多余的宽度。
          const candidates = ['全选（3）', '全选（100）', '已选 1/3', '已选 100/100'];
          const widths = {};
          for (const text of candidates) {
            widths[text] = measure(text);
          }
          label.textContent = original;
          return JSON.stringify({ widths });
        })()`
      )
    )
    const widthValues = Object.values(selectAllWidths.widths)
    check(
      // 用户要求："全选按钮的占用宽度使用必须要固定住，不要老是变动。"
      // 标签文案会在四种形态之间变；宽度不固定的话，每次勾选/取消都会让
      // 整个工具栏左右挪一下，旁边的搜索框也被推着走。
      '【用户要求】全选按钮宽度固定：四种真实文案下实测宽度一致',
      new Set(widthValues).size === 1,
      JSON.stringify(selectAllWidths)
    )


    // —— 注释输入卡片的生命周期 ——
    //
    // 真机反馈："取消注释以后 弹窗没有消失/关闭。"
    //
    // 这块之前**完全没有断言覆盖**，所以它能连续漏两轮。两条关键路径：
    //   ① worker 推来"有一笔待写注释" → 卡片出现、输入框拿到焦点；
    //   ② 抓取模式关掉（grab.state armed:false）→ 卡片收起。
    //
    // ②是关键：面板按钮、页面里按 Esc、页面导航 —— 只要模式关了就该收起，
    // 而 `grab.state` 这条通路是已经验证过的（按钮文案就靠它）。
    const composerState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const composer = document.getElementById('annotation-composer');
          const input = document.getElementById('annotation-input');
          const target = document.getElementById('annotation-target');
          const read = () => ({
            hidden: composer.hidden,
            display: getComputedStyle(composer).display,
            target: target.textContent,
            hasFocus: document.activeElement === input
          });

          // ① worker 推来"有一笔待写注释"
          window.chrome.runtime.__fireMessage({
            type: 'grab.annotation.pending',
            label: 'button.ant-btn-primary'
          });
          await new Promise((r) => setTimeout(r, 200));
          const afterPending = read();

          input.value = '写了一半的注释';

          // ② 拾取器关掉（刷新页面 / 页面里按 Esc 都会这样）—— 卡片**必须留着**，
          //    否则用户刚敲的字被扔掉，而那段内容其实完全能提交。
          window.chrome.runtime.__fireMessage({ type: 'grab.state', armed: false });
          await new Promise((r) => setTimeout(r, 200));
          const afterDisarm = { ...read(), value: input.value };

          // ③ 待写的注释真的作废了 —— 这时才收起
          window.chrome.runtime.__fireMessage({ type: 'grab.annotation.dismissed' });
          await new Promise((r) => setTimeout(r, 200));
          const afterDismiss = { ...read(), value: input.value };

          return JSON.stringify({ afterPending, afterDisarm, afterDismiss });
        })()`
      )
    )
    check(
      '【用户要求】有点待写注释时，面板里弹出输入卡片并聚焦输入框',
      composerState.afterPending.hidden === false &&
        composerState.afterPending.display === 'flex' &&
        composerState.afterPending.target === 'button.ant-btn-primary' &&
        composerState.afterPending.hasFocus === true,
      JSON.stringify(composerState.afterPending)
    )
    check(
      // ⚠️ 这条就是那个真机 bug 的回归：取消注释之后卡片必须**真的消失**。
      // 只看 `hidden` 不够 —— 样式被覆盖时 hidden 是 true 但页面照旧显示，
      // 所以这里同时验 `display`（`.annotation-composer` 那条 display:flex 与
      // `[hidden]` 规则的优先级正是这种坑）。
      '【真机 bug 回归】拾取器关掉（刷新/页面 Esc）时卡片**留着**，已写的内容不能丢',
      composerState.afterDisarm.hidden === false &&
        composerState.afterDisarm.display === 'flex' &&
        composerState.afterDisarm.value === '写了一半的注释',
      JSON.stringify(composerState.afterDisarm)
    )
    check(
      // 收起只发生在"待写的注释真的作废了"之后。
      // 只看 hidden 不够 —— 样式被覆盖时 hidden 是 true 但页面照旧显示，
      // 所以同时验 display。
      '【用户要求】待写的注释作废时，卡片才收起（hidden 且 display:none）',
      composerState.afterDismiss.hidden === true &&
        composerState.afterDismiss.display === 'none',
      JSON.stringify(composerState.afterDismiss)
    )

    // —— Esc 不再关闭注释输入卡片（用户要求） ——
    //
    // 用户原话："弹窗不再支持通过 ESC 关闭，通过 取消 按钮关闭。"
    //
    // 有**两条**路径会让 Esc 关掉卡片，两条都要挡住：
    //   ① 卡片自己那条 Esc；
    //   ② 面板文档上那条 Esc（焦点不在文本框里时会退出整个注释模式，
    //      而退出会连带把卡片收掉 —— 在用户看来同样是"Esc 把弹窗关了"）。
    const escState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const composer = document.getElementById('annotation-composer');
          const input = document.getElementById('annotation-input');
          const cancelBtn = document.getElementById('annotation-cancel');

          // 先亮出卡片并写点东西
          window.chrome.runtime.__fireMessage({
            type: 'grab.annotation.pending',
            label: 'button.ant-btn-primary'
          });
          await new Promise((r) => setTimeout(r, 150));
          input.value = '写了一半的注释';
          input.focus();

          // ① 在输入框里按 Esc
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true
          }));
          await new Promise((r) => setTimeout(r, 150));
          const afterEscInInput = {
            hidden: composer.hidden,
            value: input.value
          };

          // ② 焦点不在输入框里时按 Esc（焦点挪到取消按钮上）
          cancelBtn.focus();
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true
          }));
          await new Promise((r) => setTimeout(r, 250));
          const afterEscOutside = {
            hidden: composer.hidden,
            value: input.value
          };

          /*
           * ③ 点「取消」按钮 —— 这条**应当**关掉，但要**两次**。
           *
           * 「取消」现在有二次确认了（用户要求："这个取消操作没有二次确认的
           * 操作 加上吧"），所以一次点击只是进入确认态。这里连点两次走完整条路。
           */
          cancelBtn.click();
          await new Promise((r) => setTimeout(r, 150));
          cancelBtn.click();
          await new Promise((r) => setTimeout(r, 300));
          const afterCancelButton = { hidden: composer.hidden };

          return JSON.stringify({ afterEscInInput, afterEscOutside, afterCancelButton });
        })()`
      )
    )
    check(
      '【用户要求】在输入框里按 Esc，**不关闭**注释卡片（也不清掉已写的内容）',
      escState.afterEscInInput.hidden === false &&
        escState.afterEscInInput.value === '写了一半的注释',
      JSON.stringify(escState.afterEscInInput)
    )
    check(
      // ⚠️ 这条是容易漏的那半：焦点不在文本框里时，面板文档上的 Esc
      // 原本会退出整个注释模式，连带把卡片收掉。
      '【用户要求】焦点不在输入框里时按 Esc，也**不关闭**注释卡片',
      escState.afterEscOutside.hidden === false &&
        escState.afterEscOutside.value === '写了一半的注释',
      JSON.stringify(escState.afterEscOutside)
    )
    check(
      '【用户要求】点两次「取消」（二次确认）**应当**关闭注释卡片',
      escState.afterCancelButton.hidden === true,
      JSON.stringify(escState.afterCancelButton)
    )

    // —— 页面刷新：按钮复位 + 卡片留着并说明（真机反馈） ——
    //
    // 用户问："用户在注释的时候刷新了页面 会导致框选区域消失，但按钮还是显示的
    // 【取消注释】的状态，你觉得这个问题该如何进行优化呢？"
    //
    // 刷新时**没有任何一条现成的通知会触发**：标签页没换（onActivated 不响）、
    // 面板一直有焦点（focus 不响）也一直可见（visibilitychange 不响），
    // 而页面自己的推送**发不出来** —— 那个内容脚本已经被销毁了。
    //
    // 所以只能由面板观察 `tabs.onUpdated` 的 `status: 'loading'`。
    const reloadState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__grabArmed = false;
          window.chrome.runtime.__fireMessage({ type: 'grab.state', armed: true });
          await new Promise((r) => setTimeout(r, 150));
          const labelArmed = document.getElementById('start-element-note-label').textContent;

          // 有一笔待写的注释，用户正在写
          window.chrome.runtime.__fireMessage({
            type: 'grab.annotation.pending',
            label: 'div.cm-content'
          });
          await new Promise((r) => setTimeout(r, 150));
          const input = document.getElementById('annotation-input');
          input.value = '写了一半';

          const before = (window.__shimCalls || []).length;
          // 页面开始加载（用户按了 F5）
          window.chrome.tabs.__fireUpdated(7, { status: 'loading' });
          await new Promise((r) => setTimeout(r, 300));

          const composer = document.getElementById('annotation-composer');
          const note = document.getElementById('annotation-note');
          return JSON.stringify({
            labelArmed,
            labelAfterReload: document.getElementById('start-element-note-label').textContent,
            composerHidden: composer.hidden,
            keptText: input.value,
            noteHidden: note.hidden,
            noteText: note.textContent,
            queriedStateAfterReload: (window.__shimCalls || []).length > before
          });
        })()`
      )
    )
    check(
      '前置：刷新前按钮处于「取消注释」',
      reloadState.labelArmed === '取消注释',
      JSON.stringify({ labelArmed: reloadState.labelArmed })
    )
    check(
      '【真机反馈】刷新页面后重查状态（按钮不会停在「取消注释」）',
      reloadState.queriedStateAfterReload === true,
      JSON.stringify({ queried: reloadState.queriedStateAfterReload })
    )
    check(
      // 关键取舍：刷新会让高亮框消失，但**payload 与截图在点击那一刻就抽好了**，
      // 用户写了一半的字不该因此被扔掉。
      '【用户反馈】刷新后已写的内容**不丢**，且说明"高亮没了但内容还在"',
      reloadState.composerHidden === false &&
        reloadState.keptText === '写了一半' &&
        reloadState.noteHidden === false &&
        reloadState.noteText.includes('高亮框消失') &&
        reloadState.noteText.includes('仍可继续添加'),
      JSON.stringify({
        composerHidden: reloadState.composerHidden,
        keptText: reloadState.keptText,
        noteText: reloadState.noteText
      })
    )

    // —— 清空之后容量那行要跟着变（用户提问） ——
    //
    // 用户问："当我点了清空的时候 所选注释对应的图片以及文本内容是否会被删除呢？
    // 我觉得要被删掉。这样符合清空的语义，同时自动更新这块显示的内容
    // 【已用 26 / 100 条 · 2.4 / 3.0 MB】。"
    //
    // 删除本身由 `load-evaluation` 那两条断言覆盖（截图存在记录里，清空连它一起删）。
    // 这条验的是**面板上那行数字会不会自动更新**。
    //
    // ⚠️ 前提：夹具必须让"记录列表"与"容量"来自**同一份数据**。原来容量的条数是
    // 另造的常量，清空它永远不会动 —— 那样这条断言测不出任何东西，
    // 却会以"通过"的形式撒谎。
    const capacityAfterClear = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          window.__liveRecords = [1, 2, 3, 4].map((i) => ({
            id: 'live-' + i,
            createdAt: Date.now(),
            hasScreenshot: true,
            comment: null,
            selector: 'div.x' + i,
            tagName: 'div',
            sourceFile: null,
            reactComponents: null,
            screenshotOmittedReason: null,
            thumbnail: null
          }));
          window.__grabArmed = false;
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 400));
          const before = document.getElementById('capacity-line').textContent;

          // 清空是两步确认：第一次点只进入确认态，第二次才真清。
          const button = document.getElementById('clear-all');
          button.click();
          await new Promise((r) => setTimeout(r, 150));
          button.click();
          await new Promise((r) => setTimeout(r, 500));

          const after = document.getElementById('capacity-line').textContent;
          const rowsLeft = document.querySelectorAll('#records .record').length;

          /*
           * ⚠️ 用完必须**复位**。
           *
           * __liveRecords 是个开关：它一开着，history.list 就一直返回它。
           * 我第一版没复位，于是这次清空**把后面用例的记录也清掉了** ——
           * 四条与详情折叠相关的断言全红，而报的是"没有可展开的记录"，
           * 看起来像那些用例自己坏了。
           *
           * （本段在模板字符串里，注释不能出现反引号。）
           */
          window.__liveRecords = null;
          window.__fireStorageChange('records');
          await new Promise((r) => setTimeout(r, 300));

          return JSON.stringify({
            before,
            after,
            rowsLeft
          });
        })()`
      )
    )
    check(
      '前置：清空前容量那行显示已用 4 条',
      /已用\s*4\s*\/\s*\d+\s*条/.test(capacityAfterClear.before),
      JSON.stringify({ before: capacityAfterClear.before })
    )
    check(
      '【用户要求】清空后列表空、容量那行**自动更新**为已用 0 条',
      capacityAfterClear.rowsLeft === 0 &&
        /已用\s*0\s*\/\s*\d+\s*条/.test(capacityAfterClear.after),
      JSON.stringify(capacityAfterClear)
    )

    // —— 「取消」也要二次确认（用户要求） ——
    //
    // 用户原话："这个取消操作没有二次确认的操作 加上吧。"
    //
    // 理由和面板里其它不可逆操作一样：卡片里是用户刚手动敲进去的注释，
    // 一次误点就整段没了，而它旁边紧挨着「添加」。
    //
    // 复用的是导出/清空那套 `armTwoStepConfirm`，所以三条行为必须一致：
    //   ① 第一次点只进入确认态，**不执行**；
    //   ② 鼠标一离开就复位（用户明确要求过的交互）；
    //   ③ 第二次点才真的取消。
    const composerConfirm = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const input = document.getElementById('annotation-input');
          const cancel = document.getElementById('annotation-cancel');

          // 亮出卡片，写点东西。
          window.chrome.runtime.__fireMessage({
            type: 'grab.annotation.pending',
            label: 'div.cm-content'
          });
          await new Promise((r) => setTimeout(r, 200));
          input.value = '写了一半';

          const labelIdle = cancel.textContent;
          window.__lastGrabCancelExtra = null;

          // ① 第一次点：应进入确认态，且没有发出取消。
          cancel.click();
          await new Promise((r) => setTimeout(r, 150));
          const afterFirst = {
            label: cancel.textContent,
            armed: cancel.classList.contains('armed'),
            composerHidden: document.getElementById('annotation-composer').hidden,
            // 确认态必须有**看得见的底色** —— 只加类名不写样式是静默失效。
            background: getComputedStyle(cancel).backgroundColor
          };

          // ② 鼠标移开：应当复位（这是用户亲自要求过的交互）。
          cancel.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
          await new Promise((r) => setTimeout(r, 150));
          const afterLeave = {
            label: cancel.textContent,
            armed: cancel.classList.contains('armed')
          };

          // ③ 连点两次：第二次才真取消。
          cancel.click();
          await new Promise((r) => setTimeout(r, 120));
          cancel.click();
          await new Promise((r) => setTimeout(r, 350));
          const afterSecond = {
            composerHidden: document.getElementById('annotation-composer').hidden,
            label: cancel.textContent
          };

          return JSON.stringify({ labelIdle, afterFirst, afterLeave, afterSecond });
        })()`
      )
    )
    check(
      '前置：「取消」初始文案是「取消」',
      composerConfirm.labelIdle === '取消',
      JSON.stringify({ labelIdle: composerConfirm.labelIdle })
    )
    check(
      '【用户要求】第一次点「取消」只进入确认态，**不执行**取消',
      composerConfirm.afterFirst.label === '确认取消？' &&
        composerConfirm.afterFirst.armed === true &&
        composerConfirm.afterFirst.composerHidden === false &&
        // 只有类名没有底色的话，用户根本看不出这是确认态。
        composerConfirm.afterFirst.background !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(composerConfirm.afterFirst)
    )
    check(
      '【既有交互】鼠标离开确认按钮就复位成「取消」',
      composerConfirm.afterLeave.label === '取消' &&
        composerConfirm.afterLeave.armed === false,
      JSON.stringify(composerConfirm.afterLeave)
    )
    check(
      '【用户要求】第二次点才真的取消，卡片收起、按钮复位',
      composerConfirm.afterSecond.composerHidden === true &&
        composerConfirm.afterSecond.label === '取消',
      JSON.stringify(composerConfirm.afterSecond)
    )

    // —— 详情里的长字段折叠（用户要求） ——
    //
    // 用户原话："详情里面的 文本、HTML、计算样式这三个内容里面的东西可能会很多，
    // 所以你需要设置一个固定的高度，如果超过这个高度就仅展示固定高度的内容，
    // 用户想要查看所有的就点击各自文本旁边的箭头展开按钮。"
    const collapseState = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          // 展开第一条记录的详情（它带完整 payload）。
          const toggle = document.querySelector('#records .record .record-toggle');
          if (!toggle) return JSON.stringify({ error: '没有可展开的记录' });
          if (toggle.textContent === '详情') {
            toggle.click();
            await new Promise((r) => setTimeout(r, 500));
          }
          // 折叠与否是在插入后按 rAF 实测决定的，要等两帧。
          await new Promise((r) => requestAnimationFrame(() => r()));
          await new Promise((r) => requestAnimationFrame(() => r()));

          const values = Array.from(document.querySelectorAll('#records .kv-value'));
          const rowsWithToggle = Array.from(document.querySelectorAll('#records .kv')).filter(
            (kv) => kv.querySelector('.kv-toggle')
          );

          // 找一个**真的被裁掉**的值（有箭头的那种），点开看高度变化。
          const clipped = rowsWithToggle.length > 0
            ? values.find((v) => v.parentElement.querySelector('.kv-toggle'))
            : null;
          const before = clipped ? Math.round(clipped.getBoundingClientRect().height) : null;
          let after = null;
          let arrowBefore = null;
          let arrowAfter = null;
          if (clipped) {
            clipped.parentElement.querySelector('.kv-toggle').click();
            await new Promise((r) => setTimeout(r, 200));
            after = Math.round(clipped.getBoundingClientRect().height);
            arrowAfter = clipped.parentElement.querySelector('.kv-toggle').textContent;
          }

          // 短字段**不该**有箭头（按下去没反应的按钮比没有更糟）。
          const shortRows = Array.from(document.querySelectorAll('#records .kv')).filter(
            (kv) => {
              const v = kv.querySelector('.kv-value');
              return v && !v.classList.contains('kv-collapsible');
            }
          );

          return JSON.stringify({
            valueCount: values.length,
            toggleCount: rowsWithToggle.length,
            // 诊断：每个值的实测高度。没有这一段就只能猜"是内容不够长
            // 还是测量没生效"。
            heights: values.map((v) => ({
              label: v.parentElement.querySelector('.kv-key')?.textContent || null,
              client: Math.round(v.getBoundingClientRect().height),
              scroll: v.scrollHeight,
              collapsible: v.classList.contains('kv-collapsible')
            })),
            labelsWithToggle: rowsWithToggle.map((kv) => {
              const k = kv.querySelector('.kv-key');
              return k ? k.textContent : null;
            }),
            before,
            after,
            arrowAfter,
            shortRowsHaveToggle: shortRows.some((kv) => kv.querySelector('.kv-toggle'))
          });
        })()`
      )
    )
    check(
      '前置：详情里有多个字段，且至少有一个被折叠（否则这些断言没有鉴别力）',
      collapseState.valueCount >= 3 && collapseState.toggleCount >= 1,
      JSON.stringify(collapseState)
    )
    check(
      '【用户要求】点箭头能展开到完整内容（高度确实变高）',
      collapseState.before !== null &&
        collapseState.after !== null &&
        collapseState.after > collapseState.before,
      JSON.stringify({ before: collapseState.before, after: collapseState.after })
    )
    check(
      '展开后箭头翻转（▸ → ▾），用户能看出当前是展开态',
      collapseState.arrowAfter === '▾',
      String(collapseState.arrowAfter)
    )
    check(
      '【关键】没超出的短字段**不显示**箭头（不给按下去没反应的按钮）',
      collapseState.shortRowsHaveToggle === false,
      JSON.stringify({ shortRowsHaveToggle: collapseState.shortRowsHaveToggle })
    )

    const diagResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const entries = document.querySelectorAll('#shot-diag .diag-entry');
          const stages = Array.from(document.querySelectorAll('#shot-diag .stage')).map((n) => n.textContent);
          const badMarks = document.querySelectorAll('#shot-diag .stage.bad').length;
          const okMarks = document.querySelectorAll('#shot-diag .stage.ok').length;
          const preText = document.querySelector('#shot-diag pre');
          // 「清空并重抓一次」应当请求 worker 清空。
          document.getElementById('shot-diag-clear').click();
          await new Promise((r) => setTimeout(r, 200));
          return JSON.stringify({
            entries: entries.length,
            stages,
            badMarks,
            okMarks,
            panelHidden: document.getElementById('shot-diag-panel').hidden,
            hasDetailText: preText ? preText.textContent.includes('data:image/png') : false
          });
        })()`
      )
    )
    check(
      '截图诊断区渲染出每条记录',
      diagResult.entries === 2,
      JSON.stringify(diagResult)
    )
    check(
      // 用户要求："这个调试框现在可以删掉了吧 或者隐藏起来？"
      // 截图正常时它没有任何价值，但也确实不该删 —— 上次截图坏了全靠它定位。
      // 现在的契约：**有失败才出现，无失败则隐藏**。
      '【用户要求】诊断面板在有失败时自动出现（用户不用去找）',
      diagResult.panelHidden === false,
      JSON.stringify({ hidden: diagResult.panelHidden })
    )
    check(
      '诊断区能区分成功与失败阶段（红色标失败）',
      diagResult.badMarks === 1 && diagResult.okMarks === 1,
      JSON.stringify({ bad: diagResult.badMarks, ok: diagResult.okMarks })
    )
    check(
      '诊断区显示真实的 data URL 前缀（定位截图失败的关键信息）',
      diagResult.hasDetailText === true,
      JSON.stringify(diagResult) 
    )

    const failed = results.filter((r) => !r.ok)
    console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
    if (failed.length > 0) {
      console.log('失败项：')
      for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` :: ${item.detail}` : ''}`)
      process.exitCode = 1
    }
  } finally {
    cdp?.close()
    child.kill()
    server.close()
    await new Promise((r) => setTimeout(r, 300))
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('验证脚本自身出错：', error)
  process.exit(1)
})
