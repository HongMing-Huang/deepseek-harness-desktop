// Deepseek splash 逻辑：经 window.api（preload 白名单）订阅运行时状态与操作进度。
// 纯原生 JS，无框架依赖。
;(function () {
  'use strict'

  var els = {
    statusText: document.getElementById('statusText'),
    statusDot: document.getElementById('statusDot'),
    beam: document.getElementById('beam'),
    progressMeta: document.getElementById('progressMeta'),
    diagBox: document.getElementById('diagBox'),
    diagPre: document.getElementById('diagPre'),
    errorCard: document.getElementById('errorCard'),
    errorTitle: document.getElementById('errorTitle'),
    errorCause: document.getElementById('errorCause'),
    errorHint: document.getElementById('errorHint'),
    errorNote: document.getElementById('errorNote'),
    btnRetry: document.getElementById('btnRetry'),
    btnRepairPort: document.getElementById('btnRepairPort'),
    btnOpenLogs: document.getElementById('btnOpenLogs'),
    onboardCard: document.getElementById('onboardCard'),
    onboardFeedback: document.getElementById('onboardFeedback'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    onboardSave: document.getElementById('onboardSave'),
    onboardSkip: document.getElementById('onboardSkip')
  }

  /** boot 各阶段映射到进度百分比（与主进程广播的阶段一一对应） */
  var STAGE_PERCENT = {
    'resolve-runtime': 18,
    'allocate-port': 36,
    spawn: 60,
    'wait-ready': 82
  }

  var CAUSE_TITLE = {
    'runtime-missing': '运行时缺失',
    'port-in-use': '端口被占用',
    'eacces-or-quarantine': '系统权限或安全隔离',
    'ready-timeout': '启动超时',
    'credentials-missing': 'API 密钥未配置',
    'process-crash': '进程异常退出'
  }

  /* ── 进度条 ── */

  function setProgress(percent, label) {
    els.beam.classList.add('is-determinate')
    els.beam.style.width = percent + '%'
    els.progressMeta.textContent = label ? label + ' · ' + percent + '%' : percent + '%'
  }

  function resetProgress() {
    els.beam.classList.remove('is-determinate', 'is-error')
    els.beam.style.width = ''
    els.progressMeta.textContent = ''
  }

  /* ── 状态渲染 ── */

  function resetErrorUi() {
    els.errorCard.hidden = true
    els.statusDot.classList.remove('is-error')
    els.statusText.classList.remove('is-error')
    els.beam.classList.remove('is-error')
  }

  function render(status) {
    if (!status) return

    if (status.phase === 'starting') {
      resetErrorUi()
      resetProgress()
    }

    if (status.message) {
      els.statusText.textContent = status.message
    }

    if (status.phase === 'error') {
      els.statusDot.classList.add('is-error')
      els.statusText.classList.add('is-error')
      els.beam.classList.add('is-error')
      els.beam.classList.remove('is-determinate')
      if (status.stderrTail) {
        els.diagBox.hidden = false
        els.diagPre.textContent = status.stderrTail
      }
      showErrorCard(status.classification, status.message)
    } else if (status.phase === 'ready') {
      els.statusText.textContent = '即将进入 DeepSeek Harness…'
      setProgress(100, '就绪')
    }
  }

  /* ── 错误卡片 ── */

  function showErrorCard(classification, message) {
    if (!classification) {
      // 状态未附带分类时兜底拉取诊断
      if (window.api) {
        window.api
          .getDiagnostics()
          .then(function (d) {
            showErrorCard(d.classification, message)
          })
          .catch(function () {
            showErrorCard({ cause: 'process-crash', hint: '请查看日志获取详细错误。', actions: ['retry', 'open-logs'] }, message)
          })
      }
      return
    }

    els.errorTitle.textContent = '启动失败 · ' + (CAUSE_TITLE[classification.cause] || '未知原因')
    els.errorCause.textContent = message || ''
    els.errorHint.textContent = classification.hint || ''
    els.errorNote.hidden = true
    els.errorNote.textContent = ''

    var actions = classification.actions || []
    els.btnRetry.hidden = actions.indexOf('retry') === -1
    els.btnRepairPort.hidden = actions.indexOf('repair-port') === -1
    els.btnOpenLogs.hidden = actions.indexOf('open-logs') === -1
    els.errorCard.hidden = false
  }

  function setBusy(btn, busy, text) {
    if (busy) {
      btn.dataset.label = btn.textContent
      btn.textContent = text
      btn.disabled = true
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label
      btn.disabled = false
    }
  }

  /* ── 操作进度 ── */

  function handleOpProgress(progress) {
    if (!progress) return
    if (progress.op === 'boot') {
      if (progress.state === 'update' && typeof progress.percent === 'number') {
        setProgress(progress.percent, progress.message)
      } else if (progress.state === 'start') {
        resetErrorUi()
        resetProgress()
        if (progress.message) els.statusText.textContent = progress.message
      } else if (progress.state === 'done') {
        setProgress(100, progress.message || '就绪')
      }
      // error 态由 RuntimeStatus 驱动错误卡，这里不重复处理
    } else if (progress.op === 'credentials') {
      if (!els.onboardCard.hidden && progress.message) {
        els.onboardFeedback.textContent = progress.message
        els.onboardFeedback.classList.toggle('is-error', progress.state === 'error')
      }
    }
  }

  /* ── 首启引导（不阻塞启动流：dsh web 自带 onboarding 兜底） ── */

  function showOnboarding() {
    els.onboardCard.hidden = false
  }

  function dismissOnboarding() {
    els.onboardCard.hidden = true
  }

  function saveApiKey() {
    var key = (els.apiKeyInput.value || '').trim()
    if (!key) {
      els.onboardFeedback.textContent = '请先输入 API Key（或选择跳过）'
      els.onboardFeedback.classList.add('is-error')
      return
    }
    if (!window.api) return
    setBusy(els.onboardSave, true, '保存中…')
    window.api
      .saveApiKey(key)
      .then(function (result) {
        setBusy(els.onboardSave, false)
        if (result.ok) {
          els.onboardFeedback.textContent = '已保存，正在继续启动…'
          els.onboardFeedback.classList.remove('is-error')
          els.apiKeyInput.value = ''
          setTimeout(dismissOnboarding, 1200)
        } else {
          els.onboardFeedback.textContent = result.message || '保存失败，请重试'
          els.onboardFeedback.classList.add('is-error')
        }
      })
      .catch(function () {
        setBusy(els.onboardSave, false)
        els.onboardFeedback.textContent = '保存失败，请重试'
        els.onboardFeedback.classList.add('is-error')
      })
  }

  /* ── 事件绑定 ── */

  function bindActions(api) {
    els.btnRetry.addEventListener('click', function () {
      setBusy(els.btnRetry, true, '正在重启…')
      api
        .restartRuntime()
        .catch(function () {})
        .finally(function () {
          setBusy(els.btnRetry, false)
        })
    })

    els.btnRepairPort.addEventListener('click', function () {
      setBusy(els.btnRepairPort, true, '正在释放…')
      els.errorNote.hidden = false
      els.errorNote.textContent = '正在检查并释放端口…'
      api
        .repairPort()
        .then(function (result) {
          els.errorNote.textContent = result.message
          if (result.ok) {
            els.errorNote.classList.remove('is-error')
          } else {
            els.errorNote.classList.add('is-error')
            if (result.occupants && result.occupants.length > 0) {
              var lines = result.occupants.map(function (o) {
                return o.name + '（pid ' + o.pid + (o.user ? '，' + o.user : '') + '）'
              })
              els.errorNote.textContent = result.message + '\n占用详情：' + lines.join('；')
            }
          }
        })
        .catch(function () {
          els.errorNote.textContent = '端口修复请求失败，请查看日志。'
          els.errorNote.classList.add('is-error')
        })
        .finally(function () {
          setBusy(els.btnRepairPort, false)
        })
    })

    els.btnOpenLogs.addEventListener('click', function () {
      api.openLogs().catch(function () {})
    })

    els.onboardSave.addEventListener('click', saveApiKey)
    els.apiKeyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveApiKey()
    })
    els.onboardSkip.addEventListener('click', dismissOnboarding)
  }

  /* ── 启动 ── */

  if (window.api) {
    var api = window.api
    api.onStatus(render)
    api.onOpProgress(handleOpProgress)

    api
      .getStatus()
      .then(render)
      .catch(function () {
        /* preload 未就绪时保持默认文案 */
      })

    // 首启引导：未配置 API Key 时显示欢迎卡（不阻塞主进程启动流）
    api
      .getConfig()
      .then(function (state) {
        if (state && state.apiKey && !state.apiKey.configured) {
          showOnboarding()
        }
      })
      .catch(function () {
        /* 查询失败时静默：dsh web 自带 onboarding 兜底 */
      })

    bindActions(api)
  } else {
    // 无 preload（异常场景）：提示但不崩溃
    els.statusText.textContent = '等待主进程连接…'
  }
})()
