// 主界面工具栏：按钮打开会话中心/插件/设置；右侧运行状态订阅。
// 仅经 window.api 白名单调用，无任何 Node 能力。
;(function () {
  'use strict'

  var els = {
    btnSessions: document.getElementById('btnSessions'),
    btnPlugins: document.getElementById('btnPlugins'),
    btnSettings: document.getElementById('btnSettings'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText')
  }

  var api = window.api
  if (!api) return

  els.btnSessions.addEventListener('click', function () {
    void api.openSessionsWindow()
  })
  els.btnPlugins.addEventListener('click', function () {
    void api.openPluginsWindow()
  })
  els.btnSettings.addEventListener('click', function () {
    void api.openSettingsWindow()
  })

  function renderStatus(status) {
    if (!status) return
    els.statusDot.dataset.phase = status.phase
    if (status.phase === 'ready') {
      els.statusText.textContent = '已就绪'
    } else if (status.phase === 'error') {
      els.statusText.textContent = status.classification
        ? status.classification.hint
        : '运行出错'
    } else if (status.phase === 'starting') {
      els.statusText.textContent = status.message || '启动中…'
    } else {
      els.statusText.textContent = '已停止'
    }
  }

  api.onStatus(renderStatus)
  api.getStatus().then(renderStatus).catch(function () {})
})()
