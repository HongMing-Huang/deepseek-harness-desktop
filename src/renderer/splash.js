// DSH Desktop splash 逻辑：经 window.api（preload 白名单）订阅运行时状态。
// 纯原生 JS，无框架依赖。
;(function () {
  'use strict'

  var statusText = document.getElementById('statusText')
  var statusDot = document.getElementById('statusDot')
  var beam = document.getElementById('beam')
  var diagBox = document.getElementById('diagBox')
  var diagPre = document.getElementById('diagPre')

  function render(status) {
    if (!status) return

    if (status.message) {
      statusText.textContent = status.message
    }

    if (status.phase === 'error') {
      statusDot.classList.add('is-error')
      statusText.classList.add('is-error')
      beam.classList.add('is-error')
      if (status.stderrTail) {
        diagBox.hidden = false
        diagPre.textContent = status.stderrTail
      }
    } else if (status.phase === 'ready') {
      statusText.textContent = '即将进入 DeepSeek Harness…'
    }
  }

  if (window.api) {
    window.api.onStatus(render)
    window.api
      .getStatus()
      .then(render)
      .catch(function () {
        /* preload 未就绪时保持默认文案 */
      })
  } else {
    // 无 preload（异常场景）：提示但不崩溃
    statusText.textContent = '等待主进程连接…'
  }
})()
