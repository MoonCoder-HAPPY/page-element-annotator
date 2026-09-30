// @ts-check
/**
 * 截图查看页。
 *
 * 侧边面板约 320px 宽，在它里面做不出"全屏"——浮层再大也受面板宽度限制。
 * 所以真正的全屏查看放到这个普通标签页里：能填满窗口、能看原始尺寸、
 * 能进入系统全屏、能右键另存为。
 *
 * 用法：`src/preview/index.html?id=<记录 id>`
 * 通过 `history.screenshot` 向 service worker 要**完整截图**（不是缩略图）。
 */
;(function bootPreview() {
  'use strict'

  const toolbar = document.getElementById('toolbar')
  const meta = document.getElementById('meta')
  const stage = document.getElementById('stage')
  const zoomOutButton = document.getElementById('zoom-out')
  const zoomInButton = document.getElementById('zoom-in')
  const zoomFitButton = document.getElementById('zoom-fit')
  const zoom100Button = document.getElementById('zoom-100')
  const zoomLevel = document.getElementById('zoom-level')
  const saveButton = document.getElementById('save')
  const closeButton = document.getElementById('close')

  /** @type {{ dataUrl: string, width: number, height: number }|null} */
  let shot = null

  /**
   * 缩放倍率。`0` 是一个**哨兵值**，表示"适应窗口"。
   *
   * 为什么用哨兵而不是布尔量：用户会连续放大/缩小，需要一个"回到刚好装下"
   * 的状态；把它表达成一个倍率值，整套缩放逻辑就只有一条分支。
   * 截图往往很扁很宽，适应窗口下的实际倍率不是 1 —— 所以二者必须是两个状态。
   */
  let scale = 0

  /** 可选的缩放档位。步进式而不是连续：截图看的是像素，随手滑到 137% 没有意义。 */
  const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

  function currentIndex() {
    if (scale === 0) {
      return -1
    }
    let closest = 0
    let best = Infinity
    for (let i = 0; i < STEPS.length; i++) {
      const distance = Math.abs(STEPS[i] - scale)
      if (distance < best) {
        best = distance
        closest = i
      }
    }
    return closest
  }

  /**
   * @param {string} text
   */
  function showStatus(text) {
    stage.textContent = ''
    const node = document.createElement('p')
    node.className = 'status'
    node.textContent = text
    stage.appendChild(node)
  }

  function applyZoom() {
    const image = stage.querySelector('img')
    if (!image || !shot) {
      return
    }

    if (scale === 0) {
      // 适应窗口：交给 CSS，图片自己按可用空间缩。
      image.style.maxWidth = '100%'
      image.style.maxHeight = '100%'
      image.style.width = ''
      image.style.height = ''
      stage.classList.remove('plain')
      zoomLevel.textContent = '适应'
    } else {
      // 指定倍率：按**原始像素**算宽度，不受容器限制（超出就滚动）。
      image.style.maxWidth = 'none'
      image.style.maxHeight = 'none'
      image.style.width = Math.round(shot.width * scale) + 'px'
      image.style.height = 'auto'
      stage.classList.add('plain')
      zoomLevel.textContent = Math.round(scale * 100) + '%'
    }
    zoomInButton.disabled = scale !== 0 && currentIndex() >= STEPS.length - 1
    zoomOutButton.disabled = scale !== 0 && currentIndex() <= 0
  }

  /**
   * @param {number} direction +1 放大，-1 缩小
   */
  function stepZoom(direction) {
    const index = currentIndex()
    if (direction > 0) {
      // 从"适应"放大时，落到 100% —— "适应"的实际倍率因图而异，
      // 接着它的下一档会让用户觉得"按了没变化"。
      scale = index === -1 ? 1 : STEPS[Math.min(STEPS.length - 1, index + 1)]
    } else {
      scale = index === -1 ? 0.5 : STEPS[Math.max(0, index - 1)]
    }
    applyZoom()
  }

  /**
   * @param {{ dataUrl: string, width: number, height: number }} value
   */
  function render(value) {
    shot = value
    stage.textContent = ''

    const image = document.createElement('img')
    image.src = value.dataUrl
    image.alt = '元素截图'
    // 双击在"适应窗口"与"100%"之间来回 —— 看截图时最常用的两个状态。
    image.addEventListener('dblclick', function () {
      scale = scale === 0 ? 1 : 0
      applyZoom()
    })
    stage.appendChild(image)

    meta.textContent = `${value.width} × ${value.height} 像素 · 按 Esc 关闭`
    toolbar.hidden = false
    applyZoom()
  }

  /**
   * 全屏时把工具条藏起来 —— 全屏的意义就是"只留图"。
   * 用事件而不是轮询：进出全屏的路径不止按钮一条（Esc、系统手势都能触发）。
   */
  document.addEventListener('fullscreenchange', function () {
    toolbar.hidden = document.fullscreenElement === null && shot === null
  })

  zoomInButton.addEventListener('click', function () {
    stepZoom(1)
  })
  zoomOutButton.addEventListener('click', function () {
    stepZoom(-1)
  })
  zoomFitButton.addEventListener('click', function () {
    scale = 0
    applyZoom()
  })
  zoom100Button.addEventListener('click', function () {
    scale = 1
    applyZoom()
  })

  saveButton.addEventListener('click', function () {
    if (!shot) {
      return
    }
    // 用 <a download> 而不是 chrome.downloads：
    // 这样走的是浏览器自己的"另存为"路径，用户能看到文件名与保存位置。
    const link = document.createElement('a')
    link.href = shot.dataUrl
    link.download = 'element-shot-' + shot.width + 'x' + shot.height + '.png'
    document.body.appendChild(link)
    link.click()
    link.remove()
  })

  closeButton.addEventListener('click', function () {
    window.close()
  })

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !document.fullscreenElement) {
      window.close()
      return
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      stepZoom(1)
      return
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      stepZoom(-1)
      return
    }
    if (event.key === '0') {
      event.preventDefault()
      scale = 0
      applyZoom()
      return
    }
    if (event.key === '1') {
      event.preventDefault()
      scale = 1
      applyZoom()
    }
  })

  const id = new URLSearchParams(location.search).get('id')
  if (!id) {
    showStatus('缺少记录 id —— 请从侧边面板里点缩略图打开。')
    return
  }

  chrome.runtime.sendMessage({ type: 'history.screenshot', id }, function (response) {
    if (!response || response.ok !== true) {
      showStatus(
        '读不到这张截图。\n' +
          ((response && response.error && response.error.message) || '记录可能已被删除或清空。')
      )
      return
    }
    render(response.result)
  })
})()
