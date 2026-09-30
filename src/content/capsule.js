// @ts-check
/**
 * 页内浮动提示（"胶囊"）。
 *
 * 为什么放在 closed shadow root 里：页面样式不能影响它，它也不污染页面样式。
 * 这是参考实现的做法，也是本案唯一的样式隔离手段。
 *
 * ticket 01 只做最简形态：一条文案 + 2 秒自动消失。
 * 动作按钮（只复制文本 / 只复制截图）与 `prefers-reduced-motion` 下的动效取消
 * 属于 ticket 02 与 ticket 04。
 */
;(function attachCapsule(scope) {
  'use strict'

  const ns = (scope.__EG__ = scope.__EG__ || {})

  const CAPSULE_HOST_ID = 'element-grab-capsule-host'
  const AUTO_DISMISS_MS = 2000

  /** @type {ReturnType<typeof setTimeout>|null} */
  let dismissTimer = null

  /**
   * 胶囊配色。刻意不读页面 CSS 变量：页面可以用任意主题变量把胶囊变成不可读。
   * @param {'success'|'error'|'info'} tone
   */
  function toneColors(tone) {
    if (tone === 'error') {
      return { background: '#7f1d1d', border: '#ef4444', text: '#fee2e2' }
    }
    if (tone === 'success') {
      return { background: '#14532d', border: '#22c55e', text: '#dcfce7' }
    }
    return { background: '#1e293b', border: '#64748b', text: '#e2e8f0' }
  }

  function removeCapsule() {
    const host = document.getElementById(CAPSULE_HOST_ID)
    if (host) {
      host.remove()
    }
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  /**
   * @param {string} message
   * @param {'success'|'error'|'info'} tone
   */
  function showCapsule(message, tone) {
    removeCapsule()

    const colors = toneColors(tone)
    const host = document.createElement('div')
    host.id = CAPSULE_HOST_ID
    // 容器本身不吃指针事件，避免遮住页面；内部胶囊再打开。
    host.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;left:0;right:0;bottom:24px;' +
      'display:flex;justify-content:center;pointer-events:none;'

    const shadow = host.attachShadow({ mode: 'closed' })

    const capsule = document.createElement('div')
    capsule.setAttribute('role', 'status')
    capsule.setAttribute('aria-live', 'polite')
    capsule.style.cssText = [
      'pointer-events:auto',
      'max-width:80vw',
      'padding:10px 16px',
      'border-radius:10px',
      'font:500 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif',
      'border:1px solid ' + colors.border,
      'background:' + colors.background,
      'color:' + colors.text,
      'box-shadow:0 6px 24px rgba(0,0,0,.35)',
      'white-space:pre-wrap',
      'word-break:break-word'
    ].join(';')
    capsule.textContent = message

    shadow.appendChild(capsule)
    document.documentElement.appendChild(host)

    dismissTimer = setTimeout(function () {
      removeCapsule()
    }, AUTO_DISMISS_MS)
  }

  ns.CAPSULE_HOST_ID = CAPSULE_HOST_ID
  ns.showCapsule = showCapsule
  ns.removeCapsule = removeCapsule
})(globalThis)
