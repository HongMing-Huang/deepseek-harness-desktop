// Deepseek 插件管理窗口逻辑：经 window.api（preload 白名单）读写插件状态。
// 纯原生 JS，无框架依赖。三区：已安装 / 目录搜索 / OpProgress 进度。
;(function () {
  'use strict'

  var els = {
    installedCount: document.getElementById('installedCount'),
    installedList: document.getElementById('installedList'),
    catalogCount: document.getElementById('catalogCount'),
    catalogSearch: document.getElementById('catalogSearch'),
    catalogList: document.getElementById('catalogList'),
    progressZone: document.getElementById('progressZone'),
    progressLabel: document.getElementById('progressLabel'),
    progressBeam: document.getElementById('progressBeam'),
    restartBtn: document.getElementById('restartBtn')
  }

  var api = window.api
  var installed = [] // 已装插件名集合（目录内标记状态用）
  var catalog = []
  var restartPending = false // 完成后等待一键重启

  /* ── 渲染 ── */

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function renderInstalled(list) {
    installed = list.map(function (p) {
      return p.name
    })
    els.installedCount.textContent = String(list.length)
    els.installedList.replaceChildren()

    if (list.length === 0) {
      els.installedList.appendChild(el('div', 'zone__empty', '尚未安装任何插件，可从下方目录安装'))
      return
    }

    list.forEach(function (plugin) {
      var item = el('div', 'item')
      item.setAttribute('role', 'listitem')

      var main = el('div', 'item__main')
      var nameRow = el('div', 'item__name-row')
      nameRow.appendChild(el('span', 'item__name', plugin.name))
      if (plugin.version) {
        nameRow.appendChild(el('span', 'item__version', 'v' + plugin.version))
      }
      main.appendChild(nameRow)
      if (plugin.description) {
        main.appendChild(el('div', 'item__desc', plugin.description))
      }
      item.appendChild(main)

      var btn = el('button', 'btn btn--danger', '卸载')
      btn.type = 'button'
      btn.addEventListener('click', function () {
        void doRemove(plugin.name)
      })
      item.appendChild(btn)
      els.installedList.appendChild(item)
    })
  }

  function renderCatalog() {
    var keyword = (els.catalogSearch.value || '').trim().toLowerCase()
    var visible = catalog.filter(function (p) {
      if (!keyword) return true
      return (
        p.name.toLowerCase().indexOf(keyword) >= 0 ||
        (p.description || '').toLowerCase().indexOf(keyword) >= 0 ||
        (p.category || '').toLowerCase().indexOf(keyword) >= 0
      )
    })

    els.catalogCount.textContent = String(visible.length)
    els.catalogList.replaceChildren()

    if (visible.length === 0) {
      els.catalogList.appendChild(el('div', 'zone__empty', '没有匹配的插件'))
      return
    }

    visible.forEach(function (plugin) {
      var item = el('div', 'item')
      item.setAttribute('role', 'listitem')

      var main = el('div', 'item__main')
      var nameRow = el('div', 'item__name-row')
      nameRow.appendChild(el('span', 'item__name', plugin.name))
      if (plugin.version) {
        // 版本 pin 展示（安装时按此精确版本）
        nameRow.appendChild(el('span', 'item__version', '@' + plugin.version))
      }
      main.appendChild(nameRow)
      if (plugin.description) {
        main.appendChild(el('div', 'item__desc', plugin.description))
      }

      var tags = el('div', 'item__tags')
      if (plugin.category) {
        tags.appendChild(el('span', 'tag tag--cat', plugin.category))
      }
      if (plugin.compatibility === 'verified') {
        tags.appendChild(el('span', 'tag tag--verified', '已验证'))
      } else if (plugin.compatibility === 'community') {
        tags.appendChild(el('span', 'tag tag--community', '社区'))
      }
      main.appendChild(tags)
      item.appendChild(main)

      var btn = el('button', 'btn', '安装')
      btn.type = 'button'
      if (installed.indexOf(plugin.name) >= 0) {
        btn.textContent = '已安装'
        btn.disabled = true
        btn.dataset.installed = '1'
      }
      btn.addEventListener('click', function () {
        void doInstall(plugin)
      })
      item.appendChild(btn)
      els.catalogList.appendChild(item)
    })
  }

  /* ── 数据加载 ── */

  function load() {
    if (!api) return
    Promise.all([api.listPlugins(), api.getPluginCatalog()])
      .then(function (results) {
        renderInstalled((results[0] && results[0].plugins) || [])
        catalog = (results[1] && results[1].catalog) || []
        renderCatalog()
      })
      .catch(function () {
        els.catalogList.replaceChildren(
          el('div', 'zone__empty', '插件数据读取失败，请稍后重试')
        )
      })
  }

  /* ── 安装 / 卸载 ── */

  function doInstall(plugin) {
    if (!api || restartPending) return
    setAllButtonsDisabled(true)
    // 进度区就位（等待 OpProgress 事件填充）
    showProgress('start', '正在提交安装请求…')
    api
      .installPlugin(plugin.name, plugin.version || undefined)
      .then(function (result) {
        setAllButtonsDisabled(false)
        if (!result.ok) {
          showProgress('error', result.message || '安装失败')
        }
        // 成功路径的 done 展示由 OpProgress 订阅处理
        void refreshLists()
      })
      .catch(function () {
        setAllButtonsDisabled(false)
        showProgress('error', '安装请求失败')
      })
  }

  function doRemove(name) {
    if (!api || restartPending) return
    setAllButtonsDisabled(true)
    showProgress('start', '正在提交卸载请求…')
    api
      .removePlugin(name)
      .then(function (result) {
        setAllButtonsDisabled(false)
        if (!result.ok) {
          showProgress('error', result.message || '卸载失败')
        }
        void refreshLists()
      })
      .catch(function () {
        setAllButtonsDisabled(false)
        showProgress('error', '卸载请求失败')
      })
  }

  function refreshLists() {
    return api
      .listPlugins()
      .then(function (result) {
        renderInstalled((result && result.plugins) || [])
        renderCatalog()
      })
      .catch(function () {
        /* 刷新失败保留旧视图 */
      })
  }

  function setAllButtonsDisabled(disabled) {
    var buttons = document.querySelectorAll('.item .btn')
    Array.prototype.forEach.call(buttons, function (btn) {
      if (btn.dataset.installed === '1') return // “已安装”占位按钮保持禁用
      btn.disabled = disabled
    })
  }

  /* ── 进度区（OpProgress：plugin-install / plugin-remove） ── */

  function showProgress(state, message) {
    els.progressZone.hidden = false
    els.progressLabel.textContent = message || ''
    els.progressLabel.classList.toggle('is-error', state === 'error')
    els.progressLabel.classList.toggle('is-ok', state === 'done')

    els.progressBeam.classList.remove('is-indeterminate', 'is-error')
    if (state === 'start') {
      els.progressBeam.classList.add('is-indeterminate')
      els.progressBeam.style.width = ''
    } else if (state === 'update') {
      els.progressBeam.style.width = ''
    } else if (state === 'error') {
      els.progressBeam.classList.add('is-error')
    }
    els.restartBtn.hidden = state !== 'done'
    restartPending = state === 'done'
  }

  function setProgressPercent(percent) {
    els.progressBeam.classList.remove('is-indeterminate')
    els.progressBeam.style.width = Math.max(0, Math.min(100, percent)) + '%'
  }

  function bindProgressEvents() {
    api.onOpProgress(function (p) {
      if (!p) return
      if (p.op !== 'plugin-install' && p.op !== 'plugin-remove') return

      var verb = p.op === 'plugin-install' ? '安装' : '卸载'
      if (p.state === 'start') {
        els.restartBtn.hidden = true
        restartPending = false
        showProgress('start', p.message || ('正在' + verb + '…'))
      } else if (p.state === 'update') {
        els.progressZone.hidden = false
        els.progressLabel.classList.remove('is-error', 'is-ok')
        els.progressLabel.textContent = p.message || verb + '进行中…'
        if (typeof p.percent === 'number') {
          setProgressPercent(p.percent)
        } else {
          // 解析不到精确进度：不确定进度
          els.progressBeam.style.width = ''
          els.progressBeam.classList.add('is-indeterminate')
        }
      } else if (p.state === 'done') {
        setProgressPercent(100)
        showProgress('done', p.message || verb + '完成')
      } else if (p.state === 'error') {
        showProgress('error', p.message || verb + '失败')
      }
    })
  }

  /* ── 一键重启（复用 RuntimeRestart） ── */

  function bindRestart() {
    els.restartBtn.addEventListener('click', function () {
      els.restartBtn.disabled = true
      els.restartBtn.textContent = '正在重启…'
      api
        .restartRuntime()
        .then(function () {
          els.restartBtn.textContent = '已重启'
          els.progressLabel.textContent = '运行时已重启，插件变更已生效'
          els.progressLabel.classList.add('is-ok')
        })
        .catch(function () {
          els.restartBtn.disabled = false
          els.restartBtn.textContent = '立即重启运行时'
          els.progressLabel.textContent = '重启失败，请稍后重试'
          els.progressLabel.classList.add('is-error')
        })
    })
  }

  /* ── 启动 ── */

  if (api) {
    els.catalogSearch.addEventListener('input', renderCatalog)
    bindProgressEvents()
    bindRestart()
    load()
  } else {
    els.installedList.replaceChildren(
      el('div', 'zone__empty', '无法连接主进程（window.api 缺失）')
    )
  }
})()
