// @ts-check
/**
 * 结果页：把探针跑出来的报告画成人能读的表格，并允许一键复制完整 JSON。
 *
 * 全部用 `textContent`——报告里有 userAgent 字符串，虽然来源可信，
 * 但没有理由为它开一个 `innerHTML` 的口子。
 */
;(function renderProbeResult() {
  'use strict'

  const statusElement = document.getElementById('status')
  const contentElement = document.getElementById('content')
  const verdictElement = document.getElementById('verdict')
  const interpElement = document.getElementById('interp')
  const rowsElement = document.getElementById('rows')
  const errorsElement = document.getElementById('errors')
  const jsonElement = document.getElementById('json')
  const copyButton = document.getElementById('copy')

  /** @type {any} */
  let report = null

  function text(tag, value) {
    const node = document.createElement(tag)
    node.textContent = value
    return node
  }

  function render() {
    if (!report) {
      statusElement.textContent = '没有找到结果。请回到任意网页，点一次工具栏上的探针图标。'
      statusElement.className = 'busy'
      return
    }

    statusElement.hidden = true
    contentElement.hidden = false

    verdictElement.textContent = report.verdict
    interpElement.textContent = report.interpretation

    rowsElement.textContent = ''
    let roundIndex = 0
    for (const round of report.perRound || []) {
      roundIndex += 1
      const row = document.createElement('tr')
      row.appendChild(text('td', `第 ${roundIndex} 轮`))
      row.appendChild(text('td', String(round.attempts)))
      row.appendChild(text('td', String(round.succeeded)))
      row.appendChild(text('td', String(round.failed)))
      row.appendChild(text('td', round.failureRate === null ? '-' : String(round.failureRate)))
      row.appendChild(
        text('td', round.medianElapsedMs === null ? '-' : `${round.medianElapsedMs} ms`)
      )
      row.appendChild(
        text(
          'td',
          round.failedIndices && round.failedIndices.length
            ? round.failedIndices.join(', ')
            : '（无失败）'
        )
      )
      rowsElement.appendChild(row)
    }

    const uniqueErrors = Array.from(
      new Set(
        (report.perRound || []).flatMap(function (round) {
          return round.errorMessages || []
        })
      )
    )
    errorsElement.textContent =
      uniqueErrors.length > 0 ? `错误信息：${uniqueErrors.join(' / ')}` : '错误信息：（无）'

    jsonElement.textContent = JSON.stringify(report, null, 2)
  }

  copyButton.addEventListener('click', function () {
    if (!report) {
      return
    }
    void navigator.clipboard
      .writeText(JSON.stringify(report, null, 2))
      .then(function () {
        copyButton.textContent = '已复制'
        setTimeout(function () {
          copyButton.textContent = '复制完整 JSON 到剪贴板'
        }, 2000)
      })
      .catch(function () {
        // 剪贴板被拒时把 JSON 直接显示出来，用户可以手动选。
        jsonElement.hidden = false
        copyButton.textContent = '剪贴板不可用，请手动复制下方内容'
      })
  })

  chrome.storage.local.get(['lastReport'], function (stored) {
    report = stored && stored.lastReport ? stored.lastReport : null
    render()
    if (!report) {
      // 结果还没落地（探针可能还在跑），两秒后重试一次。
      setTimeout(function () {
        chrome.storage.local.get(['lastReport'], function (retry) {
          report = retry && retry.lastReport ? retry.lastReport : null
          render()
        })
      }, 2000)
    }
  })
})()
