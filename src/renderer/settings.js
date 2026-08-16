import { applyAccent } from './theme.js'
// Deepseek 设置窗口逻辑：经 window.api（preload 白名单）读写配置。
// 纯原生 JS，无框架依赖。
;(function () {
  'use strict'

  var els = {
    apiKeyState: document.getElementById('apiKeyState'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    apiKeySave: document.getElementById('apiKeySave'),
    apiKeyFeedback: document.getElementById('apiKeyFeedback'),
    modelInput: document.getElementById('modelInput'),
    modelSave: document.getElementById('modelSave'),
    modelFeedback: document.getElementById('modelFeedback'),
    updateCheckToggle: document.getElementById('updateCheckToggle'),
    updateRepoInput: document.getElementById('updateRepoInput'),
    updateRepoSave: document.getElementById('updateRepoSave'),
    updateRepoFeedback: document.getElementById('updateRepoFeedback'),
    accentRow: document.getElementById('accentRow'),
    accentFeedback: document.getElementById('accentFeedback'),
    appVersion: document.getElementById('appVersion'),
    dshVersion: document.getElementById('dshVersion'),
    checkNowBtn: document.getElementById('checkNowBtn'),
    updateFeedback: document.getElementById('updateFeedback')
  }

  function setFeedback(el, text, tone) {
    el.textContent = text
    el.classList.toggle('is-error', tone === 'error')
    el.classList.toggle('is-ok', tone === 'ok')
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

  /* ── 初始加载 ── */

  function applyState(state) {
    if (!state) return

    // 外观主题：选中对应色板并应用到本窗口
    var accent = state.preferences.accent || 'blue'
    applyAccent(accent)
    Array.prototype.forEach.call(els.accentRow.querySelectorAll('.swatch'), function (sw) {
      sw.classList.toggle('swatch--active', sw.dataset.accent === accent)
    })

    // API 密钥状态（仅掩码）
    if (state.apiKey.configured) {
      els.apiKeyState.replaceChildren(
        document.createTextNode('已配置（'),
        Object.assign(document.createElement('code'), {
          textContent: state.apiKey.masked || '***'
        }),
        document.createTextNode('） · 密钥保存在 dsh 本机凭据文件')
      )
    } else {
      els.apiKeyState.textContent = '尚未配置 API Key，填写后保存即可启用 DeepSeek 接口'
    }

    // 默认模型回显
    if (state.defaultModel) {
      els.modelInput.value = state.defaultModel
    }

    // 更新偏好与版本信息
    els.updateCheckToggle.checked = Boolean(state.preferences && state.preferences.updateCheckEnabled)
    // 壳更新仓库回显（占位值 owner/deepseek-harness-desktop 表示未配置，输入框留空提示格式）
    var repo = state.preferences && state.preferences.updateRepo
    if (repo && repo !== 'owner/deepseek-harness-desktop') {
      els.updateRepoInput.value = repo
    }
    els.appVersion.textContent = state.versions.app ? 'v' + state.versions.app : '-'
    if (state.versions.dsh) {
      els.dshVersion.textContent =
        'v' + state.versions.dsh + (state.versions.sideloaded ? ' · 已更新' : ' · 内嵌')
    } else {
      els.dshVersion.textContent = '未知'
    }
  }

  function load() {
    window.api
      .getConfig()
      .then(applyState)
      .catch(function () {
        setFeedback(els.updateFeedback, '配置读取失败', 'error')
      })
  }

  /* ── 保存动作 ── */

  function saveApiKey() {
    var key = (els.apiKeyInput.value || '').trim()
    if (!key) {
      setFeedback(els.apiKeyFeedback, '请先输入新密钥', 'error')
      return
    }
    setBusy(els.apiKeySave, true, '保存中…')
    window.api
      .saveApiKey(key)
      .then(function (result) {
        setBusy(els.apiKeySave, false)
        if (result.ok) {
          els.apiKeyInput.value = ''
          setFeedback(els.apiKeyFeedback, '密钥已更新', 'ok')
          load() // 刷新掩码显示
        } else {
          setFeedback(els.apiKeyFeedback, result.message || '保存失败', 'error')
        }
      })
      .catch(function () {
        setBusy(els.apiKeySave, false)
        setFeedback(els.apiKeyFeedback, '保存失败', 'error')
      })
  }

  function saveModel() {
    var model = (els.modelInput.value || '').trim()
    if (!model) {
      setFeedback(els.modelFeedback, '模型名不能为空', 'error')
      return
    }
    setBusy(els.modelSave, true, '保存中…')
    window.api
      .saveModel(model)
      .then(function (result) {
        setBusy(els.modelSave, false)
        if (result.ok) {
          setFeedback(els.modelFeedback, '默认模型已保存', 'ok')
        } else {
          setFeedback(els.modelFeedback, result.message || '保存失败', 'error')
        }
      })
      .catch(function () {
        setBusy(els.modelSave, false)
        setFeedback(els.modelFeedback, '保存失败', 'error')
      })
  }

  /* 壳更新仓库：格式 owner/repo（GitHub 限制的字符集），经 ConfigSavePreferences 持久化 */
  var REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/

  function saveUpdateRepo() {
    var repo = (els.updateRepoInput.value || '').trim()
    if (!REPO_RE.test(repo)) {
      setFeedback(els.updateRepoFeedback, '格式应为 owner/repo（仅字母、数字、点、连字符、下划线）', 'error')
      return
    }
    setBusy(els.updateRepoSave, true, '保存中…')
    window.api
      .savePreferences({ updateRepo: repo })
      .then(function () {
        setBusy(els.updateRepoSave, false)
        setFeedback(els.updateRepoFeedback, '壳更新仓库已保存：' + repo, 'ok')
      })
      .catch(function () {
        setBusy(els.updateRepoSave, false)
        setFeedback(els.updateRepoFeedback, '仓库保存失败', 'error')
      })
  }

  function toggleUpdateCheck(enabled) {
    window.api
      .savePreferences({ updateCheckEnabled: enabled })
      .then(function () {
        setFeedback(els.updateFeedback, enabled ? '已开启自动检查' : '已关闭自动检查', 'ok')
      })
      .catch(function () {
        els.updateCheckToggle.checked = !enabled
        setFeedback(els.updateFeedback, '偏好保存失败', 'error')
      })
  }

  function checkNow() {
    setBusy(els.checkNowBtn, true, '检查中…')
    setFeedback(els.updateFeedback, '正在检查更新…', null)
    window.api
      .checkUpdater()
      .then(function (result) {
        setBusy(els.checkNowBtn, false)
        if (result.state === 'available') {
          setFeedback(
            els.updateFeedback,
            '发现 dsh 新版本 v' + (result.latestDsh || '?') + '，可在弹出提示中选择立即更新'
          )
        } else if (result.state === 'up-to-date') {
          setFeedback(els.updateFeedback, '已是最新（当前 v' + (result.currentDsh || '?') + '）', 'ok')
        } else if (result.state === 'unavailable') {
          setFeedback(els.updateFeedback, result.message || '更新服务暂不可用')
        } else {
          setFeedback(els.updateFeedback, result.message || '检查失败，请稍后重试', 'error')
        }
      })
      .catch(function () {
        setBusy(els.checkNowBtn, false)
        setFeedback(els.updateFeedback, '检查请求失败', 'error')
      })
  }

  /* ── 事件订阅（OpProgress / UpdaterStatus） ── */

  function bindEvents(api) {
    els.apiKeySave.addEventListener('click', saveApiKey)
    els.apiKeyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveApiKey()
    })
    els.modelSave.addEventListener('click', saveModel)
    els.modelInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveModel()
    })
    els.updateCheckToggle.addEventListener('change', function () {
      toggleUpdateCheck(els.updateCheckToggle.checked)
    })
    els.updateRepoSave.addEventListener('click', saveUpdateRepo)
    els.updateRepoInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveUpdateRepo()
    })
    els.checkNowBtn.addEventListener('click', checkNow)

    api.onOpProgress(function (p) {
      if (!p) return
      if (p.op === 'credentials' && p.message) {
        setFeedback(els.apiKeyFeedback, p.message, p.state === 'error' ? 'error' : null)
      } else if (p.op === 'model' && p.message) {
        setFeedback(els.modelFeedback, p.message, p.state === 'error' ? 'error' : null)
      } else if (p.op === 'update' && p.message) {
        setFeedback(els.updateFeedback, p.message, p.state === 'error' ? 'error' : null)
      }
    })

    api.onUpdaterStatus(function (s) {
      if (!s) return
      if (s.state === 'installed') {
        setFeedback(els.updateFeedback, '已更新到 dsh v' + (s.currentDsh || '?'), 'ok')
        load() // 刷新版本显示
      }
    })
  }

  /* ── 启动 ── */

  if (window.api) {
    window.api.getConfig().then(function (c) {
      applyAccent(c.preferences.accent)
    }).catch(function () {})
    Array.prototype.forEach.call(els.accentRow.querySelectorAll('.swatch'), function (sw) {
      sw.addEventListener('click', function () {
        var accent = sw.dataset.accent
        setBusy(sw, true)
        window.api
          .savePreferences({ accent: accent })
          .then(function () {
            applyAccent(accent)
            Array.prototype.forEach.call(els.accentRow.querySelectorAll('.swatch'), function (s2) {
              s2.classList.toggle('swatch--active', s2.dataset.accent === accent)
            })
            setFeedback(els.accentFeedback, '外观已更新，全部自有界面即时生效', 'ok')
          })
          .catch(function () {
            setFeedback(els.accentFeedback, '保存失败', 'error')
          })
          .finally(function () {
            setBusy(sw, false)
          })
      })
    })
    bindEvents(window.api)
    load()
  } else {
    els.apiKeyState.textContent = '无法连接主进程（window.api 缺失）'
  }
})()
