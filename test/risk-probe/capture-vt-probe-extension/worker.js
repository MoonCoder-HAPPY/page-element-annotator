/**
 * 探针扩展：测量 chrome.tabs.captureVisibleTab 的调用频率限制。
 *
 * ## 为什么必须是扩展
 *
 * `chrome.tabs.captureVisibleTab` 只存在于扩展上下文。普通页面（包括 file:// 打开的
 * HTML）无法调用它，因此这一项无法像其他验收那样在页面里测。
 *
 * ## 怎么用
 *
 * 1. 打开 `chrome://extensions`
 * 2. 右上角打开「开发者模式」
 * 3. 点「加载已解压的扩展程序」，选择这个目录（`capture-vt-probe-extension/`）
 * 4. 保持任意一个普通网页处于**当前标签页**（探针需要截它）
 * 5. 点击工具栏上刚出现的「captureVisibleTab 探针」图标
 * 6. 它会自动跑完三轮并**下载一个 JSON 文件**，同时在页面上显示摘要
 *
 * 全程约 5 秒。跑完可以直接点「移除」把扩展删掉。
 *
 * ## 它测什么
 *
 * 零间隔连发 12 次，连续三轮：
 * - 第一轮全绿 + 后面出现失败 → 存在"窗口型"配额，退避是必需的
 * - 第一轮就有失败 → 零间隔连发不可用，串行化 + 最小间隔是必需而非优化
 * - 三轮全绿 → 24 次零间隔未触及阈值（注意：这只说明阈值在我们没测到的更高处）
 */

/** 每轮连发次数。 */
const BURST_SIZE = 12
/** 轮数。多轮才能看出"窗口型"配额。 */
const BURST_ROUNDS = 3

globalThis.__egProbeState = { running: false, rounds: [], error: null }

/**
 * 跑一轮零间隔连发。刻意不加任何间隔——要测的就是"裸调用"的表现。
 */
globalThis.__egRunBurst = async function runBurst() {
  const results = []
  for (let index = 0; index < BURST_SIZE; index++) {
    const startedAt = Date.now()
    const outcome = await new Promise(function (resolve) {
      try {
        chrome.tabs.captureVisibleTab(undefined, { format: 'png' }, function (dataUrl) {
          const error = chrome.runtime.lastError
          resolve({
            index,
            elapsedMs: Date.now() - startedAt,
            ok: !error && typeof dataUrl === 'string' && dataUrl.length > 0,
            error: error ? error.message : null,
            dataUrlLength: typeof dataUrl === 'string' ? dataUrl.length : 0
          })
        })
      } catch (error) {
        resolve({
          index,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          error: String(error),
          dataUrlLength: 0
        })
      }
    })
    results.push(outcome)
  }
  return results
}

function summarize(results) {
  const succeeded = results.filter(function (r) {
    return r.ok
  }).length
  const failures = results.filter(function (r) {
    return !r.ok
  })
  const elapsed = results
    .map(function (r) {
      return r.elapsedMs
    })
    .sort(function (a, b) {
      return a - b
    })
  return {
    attempts: results.length,
    succeeded,
    failed: results.length - succeeded,
    failureRate: results.length === 0 ? null : Number(((results.length - succeeded) / results.length).toFixed(3)),
    medianElapsedMs: elapsed.length ? elapsed[Math.floor(elapsed.length / 2)] : null,
    maxElapsedMs: elapsed.length ? elapsed[elapsed.length - 1] : null,
    failedIndices: failures.map(function (r) {
      return r.index
    }),
    errorMessages: Array.from(
      new Set(
        failures
          .map(function (r) {
            return r.error
          })
          .filter(Boolean)
      )
    )
  }
}

async function runProbe() {
  const state = globalThis.__egProbeState
  if (state.running) {
    return
  }
  state.running = true
  state.rounds = []
  state.error = null

  try {
    for (let round = 0; round < BURST_ROUNDS; round++) {
      const raw = await globalThis.__egRunBurst()
      state.rounds.push({ round, summary: summarize(raw), raw })
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  } finally {
    state.running = false
    await finish()
  }
}

/**
 * 给出结论。措辞刻意保守——不到阈值就明说没测到，而不是假装测出了阈值。
 */
function buildReport() {
  const state = globalThis.__egProbeState
  const summaries = state.rounds.map(function (r) {
    return r.summary
  })
  const totals = summaries.reduce(
    function (acc, s) {
      acc.attempts += s.attempts
      acc.failed += s.failed
      return acc
    },
    { attempts: 0, failed: 0 }
  )

  let verdict
  let interpretation
  if (state.error) {
    verdict = 'probe_error'
    interpretation = `探针自身出错：${state.error}`
  } else if (totals.failed === 0) {
    verdict = 'no_throttle_observed'
    interpretation =
      `${totals.attempts} 次零间隔连发全部成功，未观察到限流。` +
      '说明实现里的 300ms 下限 + 串行化足够保守。' +
      '但也意味着**阈值未被触及，本次测量无法给出确切阈值**——这是本项的已知测量边界。'
  } else if (summaries[0].failed === 0) {
    verdict = 'throttle_observed_on_later_round'
    interpretation =
      '第一轮全绿、后续轮次出现失败 —— 存在**窗口型**配额。' +
      '实现的退避（失败后间隔翻倍、上限 2000ms）方向正确。'
  } else {
    verdict = 'throttle_observed_in_first_round'
    interpretation =
      '第一轮内即出现失败 —— 零间隔连发不可用。' +
      '串行化 + 最小间隔是必需而非优化。'
  }

  return {
    probe: 'captureVisibleTab-throughput',
    measuredAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    burstSize: BURST_SIZE,
    rounds: BURST_ROUNDS,
    intervalBetweenCallsMs: 0,
    implementationIntervalMs: 300,
    implementationIntervalAfterFailureMs: 2000,
    verdict,
    interpretation,
    totals,
    perRound: summaries
  }
}

async function finish() {
  const report = buildReport()

  // 结果同时给出三条出口：下载文件、页面可读文本、剪贴板。
  // 用户任选其一给我即可。
  try {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    await chrome.downloads.download({
      url,
      filename: 'capture-visible-tab-probe.json',
      saveAs: false
    })
    setTimeout(function () {
      URL.revokeObjectURL(url)
    }, 10000)
  } catch (error) {
    // 下载失败不影响页面上显示结果。
  }

  try {
    await chrome.storage.local.set({ lastReport: report })
  } catch (error) {
    // 同上。
  }

  // 打开一个结果页（扩展自己的页面），显示摘要并允许一键复制。
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') })
  } catch (error) {
    // 打开失败时用户仍可从下载的 JSON 拿到结果。
  }
}

chrome.action.onClicked.addListener(function () {
  void runProbe()
})
