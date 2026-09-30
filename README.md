# 页面元素注释（element-grab）

点选网页上的任意元素，**写下你要改什么**，插件把它的 HTML、计算样式、DOM 上下文、
可读选择器、源码位置**与你的注释**一起整理成可粘贴的上下文 —— 直接粘给你用的 AI 编程助手。

原生 Chrome MV3 扩展，**零构建**：没有打包步骤、没有依赖、没有网络请求。

---

## 安装

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录（`element-grab-extension/`）

Edge / Brave 等 Chromium 系浏览器同理。

## 用法

**点扩展图标 → 右侧打开侧边面板**（`sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`）。
面板会常驻在右侧，跨标签页保持，浏览器重启后还是开着的。

在面板顶栏点 **「元素注释」**（蓝色，带加号图标）→ 切到页面，光标变成十字 → 移动时有高亮框与元素标识。

> **如果点了没反应、提示说需要授权**：那是因为 Chrome 的临时授权（`activeTab`）
> 只在**点扩展图标**那一刻生效，而且**页面一导航就会被撤销**；面板是常驻的，
> 所以从面板点按钮时往往已经没有授权了。
> 点面板上出现的 **「授权访问所有网站」** 一次即可 —— 之后从面板就能直接进入抓取模式。

### 元素注释 · 悬停注释

两个入口都在面板顶栏，差别只在**什么时候算选中**：

| 按钮 | 怎么选中 |
|---|---|
| **元素注释**（蓝） | 点页面上的元素 |
| **悬停注释**（琥珀） | 鼠标**停在**元素上即可，不用点击 |

**悬停注释是为 hover 才出现的内容准备的**：下拉菜单、气泡提示、二级菜单。
点一下可能让浮层收掉、或触发页面跳转，而"停一下"不会。

停留 **400ms** 才算选中 —— 指针从 A 滑到 B 的途中会经过好几个元素，
"落上就抓"会一路弹出一串注释框。

**点一下目标元素 → 弹出注释框**：

```
┌──────────────────────────────────────────┐
│ button.relative.px-2                     │
│ button.relative.px-2:nth-of-type(4)      │
│ ┌──────────────────────────────────────┐ │
│ │ 描述这个元素应该改什么……              │ │
│ └──────────────────────────────────────┘ │
│                      [取消]  [添加 Ctrl↵] │
└──────────────────────────────────────────┘
```

点「添加」（或 `Ctrl+Enter`）→ 记录进入面板列表，底部提示"已添加"，**继续留在抓取模式**。
点「取消」/ `Esc` / 点空白处 → 什么都不做。

连续抓几个元素，每个都写清楚要改什么，然后回面板勾选 → **导出所选** → 粘给 AI。
粘出来的文本长这样，注释在最前面：

```
Attached browser context from https://example.com/

Requested change:          ← 你写的意图，放最前面给 AI 先看到
把这里的按钮改成主色

Selected element:
button
Accessible name: "Submit order"
...
```

### 侧边面板里有什么

| 区块 | 内容 |
|---|---|
| 顶部 | **元素注释**、**悬停注释**、导出全部、清空 |
| 全选 | 勾上即选中**当前搜索结果**（不是全部记录）；部分选中时显示半选与 `已选 N/M` |
| 列表 | 每条：缩略图、可读选择器、时间、**你写的注释** |
| 详情（展开） | 可读路径、源码位置、组件层级、class、文本、HTML、计算样式、祖先路径 |
| 每条动作 | 复制文本 / 复制截图 / 补评论 / 删除 |
| 评论 | **自动保存**：输入停顿 0.7 秒、失焦、或关闭面板时写入；复制/导出前也会先落库 |
| 底部 | **截图没成功？看诊断** —— 截图管道的逐阶段记录（见下） |

> **不可逆操作都要点两次**：「删除」与「清空」第一次点击只是把按钮变成
> 「确认删除？」/「确认清空？」，**再点一次**才真的执行。4 秒内没有第二次点击会自动复位——
> 否则一次误点会让按钮长期停在确认态，之后任何一次点击都会真的删掉，那比不确认更危险。

面板会**自动刷新**：在页面上抓到新元素后列表立刻更新，不需要重开面板。

历史只存在本机（`chrome.storage.local`），最多 200 条或 8 MiB，超出时从最旧开始回收。不参与任何同步。

### 截图没成功？看诊断

面板底部展开「截图没成功？看诊断」，点「清空并重抓一次」，然后抓一个元素、回来点「刷新」。
它会显示截图管道每一阶段的真实产物：

- `captureVisibleTab:ok` / `failed` —— 浏览器截图 API 到底返回了什么（data URL 前缀、长度）
- `extract:received` —— 内容脚本送来的截图长什么样
- `extract:sanitized` —— 净化后**有没有保留**、被拒的理由是什么

成功与失败的阶段用颜色区分。不用开控制台就能看出是哪一步把图弄丢了。

### 哪些页面能用

| 页面类型 | 能不能用 | 说明 |
|---|---|---|
| 普通网站（`http://` / `https://`） | ✅ | 主要场景 |
| **扩展自己的页面**（`chrome-extension://…`） | ✅ | 开发时用 `test/repro.html` 走这条（它只存在于仓库里，不随扩展发布） |
| 本地文件（双击打开的 `.html`） | ⚠️ 默认不行 | 需到 `chrome://extensions` 打开该扩展的**「允许访问文件网址」** |
| `chrome://` 开头的页面 | ❌ | Chrome 不允许任何扩展注入 |
| Chrome 应用商店 | ❌ | 同上 |

---

## 它抓什么

粘出来的文本长这样：

```
Attached browser context from https://example.com/cart

Selected element:
button
Accessible name: "Submit order"
Role: button
Selector: div.cart-actions > button#submit-order
Source: src/components/Cart.tsx:42:7
React: <CartPage> <CartActions> <SubmitButton>
Dimensions: 220x48

Text content:
Submit order

Nearby context:
- Order total: $128.40
- Estimated delivery: Mar 3

Computed styles:
  display: flex
  font-size: 15px
  color: rgb(255, 255, 255)
  background: rgb(37, 99, 235)

HTML:
<button id="submit-order" class="btn btn-primary" type="submit">Submit order</button>

Ancestor path: div.cart-actions > div#cart
Full DOM path: body > div.card > div.cart-actions > button#submit-order
```

几点说明：

- **选择器经过唯一性验证**：`Selector:` 的值在同一页面里执行 `querySelectorAll(...)`
  一定恰好命中一个元素（不唯一时会自动加 `:nth-of-type`）。可以直接拿去定位代码或写查询。
- **`Source:` 拿不到时会明确写 `(not available on this page)`**，而不是留空。
  见下面的"源码位置"一节。
- **截图是独立载荷**：文本走文本通道、图片走图片通道，你可以分别粘贴。
  元素不在视口内时会先自动滚动；滚动后仍不可达时会明确告诉你原因，而不是给一张残缺图。

## 源码位置（`Source:` 这一行）

按可靠性依次尝试三档，都不行就诚实说明拿不到：

| 档 | 来源 | 什么时候能用 |
|---|---|---|
| 1 | React fiber 的 `_debugSource` | **React 18 及更早的开发构建**（已实测：完整给出 `文件:行:列` 与组件层级） |
| 2 | Vue 的 `__file` | Vue 2/3 项目 |
| 3 | `data-v-inspector` / `data-source` / `data-source-file` | 项目主动配合时 |

实测结论（用 npm 上的真实构建产物统计）：

- `react-dom@18.3.1` 的开发构建含 `_debugSource`；**`react-dom@19.2.0` 已将其移除**
- 生产构建不写任何 debug 字段

所以：**React 19 及任何生产构建的站点上，这一行会是诚实缺省文案**，这是设计而非缺陷。
想要源文件位置，请用 React 18 及更早的 dev 构建，或者给元素加第 3 档的约定属性。

## 隐私

- **不发任何网络请求**。所有处理都在本地。
- **默认脱敏，不可关闭**：密码框与 hidden 输入框的 `value` 会被无条件剥离；
  URL 会去掉 query / fragment 与 `user:password@`；`access_token` / `api_key` / `secret`
  等模式命中的值会被替换成 `[redacted]`。
- 已知边界：Bearer / JWT / `ghp_` / `sk-` 这类**没有固定模式的高熵串不在模式表内**，
  不会被自动识别。粘贴前请自行确认内容不含敏感信息。
- 历史只在本机，提供一键清空。

## 权限说明

| 权限 | 用途 |
|---|---|
| `activeTab` | 点扩展图标时获得当前标签页的临时权限。**不需要**在安装时索要全站权限 |
| `scripting` | 按需注入拾取器脚本（不在所有页面默认注入） |
| `clipboardWrite` | 写文本与截图到剪贴板 |
| `storage` | 本机会话历史 |
| `sidePanel` | 侧边面板 |
| `downloads` | 「下载 .md」 |

不申请 `tabs`、`cookies`、`history`、`webNavigation`、`<all_urls>`。

---

## 打包

```bash
node tools/package.mjs        # → dist/页面元素注释-v<version>.zip
```

零依赖（这个项目本身零构建，没有 `package.json`）。ZIP 的写法**复用
`src/shared/zip.js`** —— 那一份已经被 `test/zip.test.mjs` 用**真实解压器**
验过，再写一份只会多出第二处可能出错、却没人验的容器实现。

包里只装**运行时需要**的东西：`manifest.json`、`icons/`、`src/`。
`test/`、`tools/`、`.spec-workflow/`、`README.md` 一律不进包。

这不只是省体积：`test/repro.html` 一度被写进 `web_accessible_resources`，
于是它跟着扩展一起发布了，**对所有网站可访问**。现在那条声明也删掉了 ——
没有任何运行时代码需要它（`getURL` 只用于诊断输出路径）。

`test/package.test.mjs` 用真实解压器打开产物逐项核对：manifest 指的文件、
`importScripts` 的目标、内容脚本清单里的每一个文件都在包里，
且**开发文件一个都没混进去**。

## 开发

无构建步骤。改完源码后在 `chrome://extensions` 里点该扩展的「重新加载」即可。

```
element-grab-extension/
  manifest.json
  icons/            图标（PNG）。由 tools/make-icons.mjs 生成，已提交
  src/
    background/     service worker：消息路由、安全边界、历史、截图采集
    content/        拾取器、抽取、选择器、源码定位、截图编排、注释框、页内提示
    shared/         跨上下文共用：预算常量、脱敏模式、格式化
    sidepanel/      侧边面板（含 theme.js 主题控制器）
  test/
    *.test.mjs              纯逻辑单测（node --test）
    fixture-page.html       金样例页面（手工验收用）
    repro.html              缺陷复现页
    verify-*.mjs            真浏览器验证（Chrome DevTools Protocol）
  tools/
    make-icons.mjs          零依赖 PNG 图标生成器（手写 PNG 编码 + 超采样）
```

### 重新生成图标

```bash
node tools/make-icons.mjs
```

图标是**位图**（Chrome 扩展不支持 SVG 图标），而本扩展没有依赖、没有打包器，
所以 `tools/make-icons.mjs` 里手写了一个最小 PNG 编码器（zlib 是 Node 内置的），
图形用 4 倍超采样再降采样得到干净的抗锯齿边缘。**扩展运行时不跑这个脚本**，
产物 `icons/*.png` 已提交 —— 这个脚本只是让图标可复现、可调整。

### 跑测试

```bash
# 纯逻辑单测（不需要浏览器）
node --test test/*.test.mjs

# 真浏览器端到端验证（需要本机装有 Chrome）
node test/verify-in-chrome.mjs
```

### 风险实测的两项

- **`_debugSource` 可用率**：`node test/risk-probe/run-debug-source-probe.mjs`
  （不需要扩展，结果写到 `.spec-workflow/element-grab-extension/verification/`）
- **`captureVisibleTab` 频率限制**：`test/risk-probe/capture-vt-probe-extension/`
  是一个**独立的一次性探针扩展**。按上面"安装"的步骤加载它，保持任意网页为当前标签页，
  点它的图标，它会自动跑 3 轮 × 12 次零间隔连发、下载一份 JSON，并打开结果页显示摘要。
  跑完可以直接移除。

## 已知限制

- **只在 Chromium 系浏览器可用**（Chrome / Edge / Brave）。Firefox 需要换工程形态。
- **不做截图标注**（在截图上画箭头/框）—— 截图原样进剪贴板。
- **没有快捷键**：所有入口都是面板里的按钮。
  （早先做过一套，包括 `chrome.commands` 与面板内录制，已按要求整体删除。）
- **`Source:` 在 React 19 与生产构建上不可用**（原因见上）。
- 不做跨设备同步；不做历史迁移（结构版本变化时会丢弃重建并告知一次）。
