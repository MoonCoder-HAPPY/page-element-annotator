// @ts-check
/**
 * 外观主题控制器。
 *
 * ## 为什么单独一个文件、并且在 `<head>` 里同步加载
 *
 * 主题必须在**首屏绘制前**定下来，否则深色模式下会先闪一下白底 ——
 * 那一下就足以让人觉得"不精致"。所以这里：
 *
 * - 用 `localStorage` 而不是 `chrome.storage.local`：**同步**读取，
 *   没有 await 就没有闪烁窗口。它只是个界面偏好，不算用户数据，
 *   和 `chrome.storage` 里那些抓取记录不是一类东西，分开存是合理的。
 * - 在 `<head>` 里同步加载（不 defer），保证在任何内容绘制前设好 `data-resolved`。
 *
 * ## 三态
 *
 * `system` / `light` / `dark`。「跟随系统」是默认，也是 iOS 上最符合直觉的默认：
 * 用户把系统设成深色，就是希望所有应用跟着深。
 *
 * 解析结果写到 `documentElement.dataset.resolved`，CSS 只认这个属性
 * —— 单一真相来源，避免"媒体查询 + 属性"两套规则互相打架。
 */
;(function attachTheme(scope) {
  'use strict'

  const STORAGE_KEY = 'eg-theme'
  const VALUES = ['system', 'light', 'dark']
  /** 切换时给整个面板挂上过渡的时间，必须略大于 CSS 里的 transition 时长。 */
  const ANIMATION_MS = 360

  const root = scope.document.documentElement

  /** @type {(() => void)[]} */
  const listeners = []

  /**
   * 读偏好。localStorage 在少数环境下会抛（隐私模式、配额），所以兜底。
   * @returns {'system'|'light'|'dark'}
   */
  function readPreference() {
    try {
      const stored = scope.localStorage.getItem(STORAGE_KEY)
      if (stored && VALUES.indexOf(stored) !== -1) {
        return /** @type {any} */ (stored)
      }
    } catch (error) {
      // 读不到就用默认值，不影响使用。
    }
    return 'system'
  }

  /**
   * @param {'system'|'light'|'dark'} preference
   * @returns {'light'|'dark'}
   */
  function resolve(preference) {
    if (preference === 'light' || preference === 'dark') {
      return preference
    }
    try {
      return scope.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch (error) {
      return 'light'
    }
  }

  /**
   * 应用主题。
   *
   * @param {'system'|'light'|'dark'} preference
   * @param {{ animate?: boolean }} [options]
   */
  function apply(preference, options) {
    const resolved = resolve(preference)
    const previous = root.dataset.resolved

    root.dataset.theme = preference
    root.dataset.resolved = resolved
    // 让浏览器的原生控件（滚动条、表单控件）也跟着变 —— 不做这一步，
    // 深色模式下会出现一条亮色滚动条，很显眼。
    root.style.colorScheme = resolved

    if (options && options.animate && previous && previous !== resolved) {
      animateOnce()
    }
    for (const listener of listeners) {
      listener()
    }
  }

  /**
   * 只在**切换那一次**挂过渡，平时不挂。
   *
   * 全局常驻 transition 会带来两个问题：一是首屏渲染也会"淡入"，看着像在卡；
   * 二是它会和按钮自己的 hover 过渡抢时间轴。所以用一个临时类，切完就摘。
   */
  function animateOnce() {
    root.classList.add('theme-animating')
    scope.setTimeout(function () {
      root.classList.remove('theme-animating')
    }, ANIMATION_MS)
  }

  /** @param {'system'|'light'|'dark'} preference */
  function set(preference) {
    if (VALUES.indexOf(preference) === -1) {
      return
    }
    try {
      scope.localStorage.setItem(STORAGE_KEY, preference)
    } catch (error) {
      // 存不下来只影响"下次打开还记得"，本次仍然生效。
    }
    apply(preference, { animate: true })
  }

  /**
   * 跟随系统时要响应系统切换（用户可能在面板开着时改了系统主题）。
   */
  function watchSystem() {
    try {
      const query = scope.matchMedia('(prefers-color-scheme: dark)')
      const onChange = function () {
        if (readPreference() === 'system') {
          apply('system', { animate: true })
        }
      }
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', onChange)
      } else if (typeof query.addListener === 'function') {
        // 老签名，Safari 14 以前。
        query.addListener(onChange)
      }
    } catch (error) {
      // 没有 matchMedia 就只支持手动切换。
    }
  }

  /**
   * @param {() => void} listener
   */
  function subscribe(listener) {
    listeners.push(listener)
  }

  // —— 立即生效（同步，避免闪烁）——
  apply(readPreference())
  watchSystem()

  scope.__EG__ = scope.__EG__ || {}
  scope.__EG__.theme = {
    readPreference,
    resolve,
    set,
    apply,
    subscribe,
    VALUES
  }
})(globalThis)
