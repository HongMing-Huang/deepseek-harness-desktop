// Deepseek 插件管理窗口逻辑：经 window.api（preload 白名单）读写插件状态。
// 纯原生 JS，无框架依赖。三区：已安装 / 目录搜索 / OpProgress 进度。
;(function () {
  'use strict'

  var els = {
    installedCount: document.getElementById('installedCount'),
    installedList: document.getElementById('installedList'),
    healthSummary: document.getElementById('healthSummary'),
    healthBtn: document.getElementById('healthBtn'),
    updateAllBtn: document.getElementById('updateAllBtn'),
    tabCatalog: document.getElementById('tabCatalog'),
    tabMarket: document.getElementById('tabMarket'),
    marketMeta: document.getElementById('marketMeta'),
    marketRefreshBtn: document.getElementById('marketRefreshBtn'),
    catalogCount: document.getElementById('catalogCount'),
    catalogSearch: document.getElementById('catalogSearch'),
    catalogList: document.getElementById('catalogList'),
    marketSearch: document.getElementById('marketSearch'),
    marketList: document.getElementById('marketList'),
    progressZone: document.getElementById('progressZone'),
    progressLabel: document.getElementById('progressLabel'),
    progressBeam: document.getElementById('progressBeam'),
    restartBtn: document.getElementById('restartBtn')
  }

  var api = window.api
  var installed = [] // 已装插件名集合（目录内标记状态用）
  var installedFull = [] // 已装插件完整条目（健康检查后重渲染用）
  var catalog = []
  var health = [] // 健康检查结果（按 name 索引）
  var restartPending = false // 完成后等待一键重启
  var marketTabActive = false
  var marketItems = [] // 最近一次市场搜索结果
  var marketTimer = null

  /* ── 渲染 ── */

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function renderInstalled(list) {
    installedFull = list
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
      appendHealthBadge(nameRow, plugin.name)
      main.appendChild(nameRow)
      if (plugin.description) {
        main.appendChild(el('div', 'item__desc', plugin.description))
      }
      var h = findHealth(plugin.name)
      if (h && h.detail) {
        main.appendChild(el('div', 'item__desc item__desc--warn', h.detail))
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

  /* ── 健康徽章（插件市场 2.0：healthy / stale / missing / broken） ── */

  var HEALTH_LABELS = {
    healthy: { text: '健康', cls: 'badge--ok' },
    stale: { text: '可更新', cls: 'badge--warn' },
    missing: { text: '缺失', cls: 'badge--err' },
    broken: { text: '损坏', cls: 'badge--err' }
  }

  function findHealth(name) {
    for (var i = 0; i < health.length; i++) {
      if (health[i].name === name) return health[i]
    }
    return null
  }

  function appendHealthBadge(nameRow, name) {
    var h = findHealth(name)
    if (!h) return
    var conf = HEALTH_LABELS[h.state] || HEALTH_LABELS.healthy
    nameRow.appendChild(el('span', 'item__tag badge ' + conf.cls, conf.text))
  }

  function renderHealthSummary(result) {
    if (!result || !result.items || result.items.length === 0) {
      els.healthSummary.hidden = true
      return
    }
    var parts = []
    if (result.updatableCount > 0) {
      parts.push(result.updatableCount + ' 个可更新')
    }
    if (result.brokenCount > 0) {
      parts.push(result.brokenCount + ' 个异常')
    }
    if (parts.length === 0) {
      parts.push('全部健康')
    }
    els.healthSummary.hidden = false
    els.healthSummary.textContent = parts.join(' · ')
    els.healthSummary.className =
      'zone__health' + (result.updatableCount > 0 || result.brokenCount > 0 ? ' is-warn' : ' is-ok')
    els.updateAllBtn.disabled = result.updatableCount === 0
  }

  function refreshHealth() {
    if (!api) return Promise.resolve()
    els.healthBtn.disabled = true
    els.healthBtn.textContent = '检查中…'
    return api
      .checkPluginsHealth()
      .then(function (result) {
        health = (result && result.items) || []
        renderHealthSummary(result)
        renderInstalled(installedFull)
      })
      .catch(function () {
        els.healthBtn.textContent = '检查失败'
      })
      .finally(function () {
        els.healthBtn.disabled = false
        els.healthBtn.textContent = '检查健康'
      })
  }

  /* ── 一键全量更新（plugin-update 进度复用 OpProgress 区） ── */

  function doUpdateAll() {
    if (!api || restartPending) return
    setAllButtonsDisabled(true)
    els.updateAllBtn.disabled = true
    showProgress('start', '正在提交全量更新请求…')
    api
      .updateAllPlugins()
      .then(function (result) {
        setAllButtonsDisabled(false)
        if (!result.ok) {
          showProgress('error', result.message || '全量更新失败')
        }
        void refreshLists()
        void refreshHealth()
      })
      .catch(function () {
        setAllButtonsDisabled(false)
        showProgress('error', '全量更新请求失败')
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
        // 版本 pin 展示（npm 按此精确版本安装；github 为验证时仓库版本）
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
      if (plugin.source === 'github') {
        tags.appendChild(el('span', 'tag tag--github', 'GitHub 直装'))
      } else if (plugin.compatibility === 'verified') {
        tags.appendChild(el('span', 'tag tag--verified', '已验证'))
      } else if (plugin.compatibility === 'community') {
        tags.appendChild(el('span', 'tag tag--community', '社区'))
      }
      main.appendChild(tags)
      item.appendChild(main)

      var isGithub = plugin.source === 'github'
      var btn = el('button', 'btn', isGithub ? '安装（源码）' : '安装')
      btn.type = 'button'
      if (isGithub && plugin.installSpec) {
        btn.title = '源码直装：' + plugin.installSpec + '（将按官方指引自动放行其构建脚本）'
      }
      if (installed.indexOf(plugin.name) >= 0) {
        btn.textContent = '已安装'
        btn.disabled = true
        btn.dataset.installed = '1'
      }
      btn.addEventListener('click', function () {
        void doInstall(plugin)
      })

      var btns = el('div', 'item__btns')
      if (plugin.repo && /^https:\/\//.test(plugin.repo)) {
        var repoBtn = el('button', 'btn btn--mini', '仓库')
        repoBtn.type = 'button'
        repoBtn.title = '在浏览器打开：' + plugin.repo
        repoBtn.addEventListener('click', function () {
          openExternal(plugin.repo)
        })
        btns.appendChild(repoBtn)
      }
      btns.appendChild(btn)
      item.appendChild(btns)
      els.catalogList.appendChild(item)
    })
  }

  /* ── 官方生态外链（主进程外链守卫转系统浏览器） ── */

  function openExternal(url) {
    window.open(url, '_blank')
  }

  function bindEcosystemLinks() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ext]'), function (btn) {
      btn.addEventListener('click', function () {
        openExternal(btn.dataset.ext)
      })
    })
  }

  /* ── 区二切换：精选目录 / dshfind 在线市场 ── */

  function setCatalogTab(market) {
    marketTabActive = market
    els.tabCatalog.classList.toggle('tab--active', !market)
    els.tabMarket.classList.toggle('tab--active', market)
    els.catalogSearch.hidden = market
    els.marketSearch.hidden = !market
    els.catalogList.hidden = market
    els.marketList.hidden = !market
    els.marketRefreshBtn.hidden = !market
    if (market) {
      // 首次进入：加载市场（走缓存；过期/缺失时后台网络刷新）
      if (marketItems.length === 0) {
        void loadMarket('')
      }
    }
  }

  function renderMarket(items) {
    els.marketList.replaceChildren()
    if (items.length === 0) {
      els.marketList.appendChild(el('div', 'zone__empty', '没有匹配的插件，试试更换关键词'))
      return
    }
    items.forEach(function (plugin) {
      var item = el('div', 'item')
      item.setAttribute('role', 'listitem')

      var main = el('div', 'item__main')
      var nameRow = el('div', 'item__name-row')
      nameRow.appendChild(el('span', 'item__name', plugin.displayName || plugin.name))
      nameRow.appendChild(el('span', 'item__tag tag tag--github', '@' + plugin.author))
      if (plugin.stars) {
        nameRow.appendChild(el('span', 'item__tag badge badge--warn', '★ ' + plugin.stars))
      }
      main.appendChild(nameRow)
      if (plugin.description) {
        main.appendChild(el('div', 'item__desc', plugin.description))
      }
      var tags = el('div', 'item__tags')
      tags.appendChild(el('span', 'tag tag--cat', 'dshfind'))
      if (plugin.updated) {
        tags.appendChild(el('span', 'tag tag--cat', plugin.updated))
      }
      main.appendChild(tags)
      item.appendChild(main)

      var btn = el('button', 'btn', '安装（源码）')
      btn.type = 'button'
      btn.title = '按 dshfind 官方命令直装：dsh plugin add ' + plugin.installSpec
      if (installed.indexOf(plugin.name) >= 0) {
        btn.textContent = '已安装'
        btn.disabled = true
        btn.dataset.installed = '1'
      }
      btn.addEventListener('click', function () {
        void doMarketInstall(plugin)
      })

      var btns = el('div', 'item__btns')
      if (plugin.repoUrl && /^https:\/\//.test(plugin.repoUrl)) {
        var repoBtn = el('button', 'btn btn--mini', '仓库')
        repoBtn.type = 'button'
        repoBtn.title = '在浏览器打开：' + plugin.repoUrl
        repoBtn.addEventListener('click', function () {
          openExternal(plugin.repoUrl)
        })
        btns.appendChild(repoBtn)
      }
      btns.appendChild(btn)
      item.appendChild(btns)
      els.marketList.appendChild(item)
    })
  }

  function renderMarketMeta(result) {
    if (!result || !result.fetchedAt) {
      els.marketMeta.hidden = true
      return
    }
    els.marketMeta.hidden = false
    els.marketMeta.className =
      'zone__health ' + (result.source === 'network' ? 'is-ok' : 'is-warn')
    els.marketMeta.textContent =
      (result.source === 'network' ? '实时抓取' : '缓存') +
      ' · ' +
      new Date(result.fetchedAt).toLocaleString() +
      ' · ' +
      result.total +
      ' 个插件'
  }

  function loadMarket(query, force) {
    if (!api) return
    if (!force && marketItems.length === 0) {
      els.marketList.replaceChildren(el('div', 'zone__empty', '正在抓取 dshfind 市场数据…'))
    }
    els.marketRefreshBtn.disabled = true
    els.marketRefreshBtn.textContent = '刷新中…'
    var p = force ? api.refreshMarket() : api.searchMarket(query || '')
    p
      .then(function (result) {
        marketItems = result.items || []
        renderMarketMeta(result)
        renderMarket(marketItems)
        if (force) {
          els.marketSearch.value = ''
        }
      })
      .catch(function () {
        renderMarketMeta(null)
        var box = el('div', 'zone__empty', '市场数据不可用（网络失败或页面结构变化）')
        var linkBtn = el('button', 'btn btn--mini', '在浏览器打开 dshfind 市场')
        linkBtn.type = 'button'
        linkBtn.style.marginTop = '10px'
        linkBtn.addEventListener('click', function () {
          openExternal('https://dshfind.com/zh/plugins')
        })
        box.appendChild(linkBtn)
        els.marketList.replaceChildren(box)
      })
      .finally(function () {
        els.marketRefreshBtn.disabled = false
        els.marketRefreshBtn.textContent = '刷新市场'
      })
  }

  function scheduleMarketSearch() {
    var query = (els.marketSearch.value || '').trim()
    if (marketTimer) clearTimeout(marketTimer)
    marketTimer = setTimeout(function () {
      void loadMarket(query)
    }, 280)
  }

  function doMarketInstall(plugin) {
    if (!api || restartPending) return
    setAllButtonsDisabled(true)
    showProgress('start', '正在提交源码安装请求…')
    // dshfind 官方安装命令 = dsh plugin add github:<author>/<name>
    api
      .installPlugin(plugin.name, undefined, plugin.installSpec)
      .then(function (result) {
        setAllButtonsDisabled(false)
        if (!result.ok) {
          showProgress('error', result.message || '安装失败')
        }
        void refreshLists().then(function () {
          renderMarket(marketItems) // 重渲染市场列表，更新「已安装」标记
        })
      })
      .catch(function () {
        setAllButtonsDisabled(false)
        showProgress('error', '安装请求失败')
      })
  }

  /* ── 数据加载 ── */

  function load() {
    if (!api) return
    Promise.all([api.listPlugins(), api.getPluginCatalog(), api.checkPluginsHealth()])
      .then(function (results) {
        renderInstalled((results[0] && results[0].plugins) || [])
        catalog = (results[1] && results[1].catalog) || []
        health = (results[2] && results[2].items) || []
        renderHealthSummary(results[2])
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
    // GitHub 直装条目必须带 installSpec（git+https…@pin）：缺失时明确报错，
    // 绝不静默退化成 npm 裸名安装装错包
    if (plugin.source === 'github' && !plugin.installSpec) {
      showProgress('error', plugin.name + ' 的直装规格缺失（目录数据异常），请刷新后重试')
      return
    }
    setAllButtonsDisabled(true)
    // 进度区就位（等待 OpProgress 事件填充）
    showProgress('start', '正在提交安装请求…')
    // GitHub 直装条目：传 installSpec（git+https…@pin）代替 npm 版本 pin
    var spec = plugin.source === 'github' ? plugin.installSpec : undefined
    api
      .installPlugin(plugin.name, plugin.version || undefined, spec)
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
      if (p.op !== 'plugin-install' && p.op !== 'plugin-remove' && p.op !== 'plugin-update') return

      var verb = p.op === 'plugin-install' ? '安装' : p.op === 'plugin-remove' ? '卸载' : '更新'
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
    bindEcosystemLinks()
    els.catalogSearch.addEventListener('input', renderCatalog)
    els.marketSearch.addEventListener('input', scheduleMarketSearch)
    els.tabCatalog.addEventListener('click', function () {
      setCatalogTab(false)
    })
    els.tabMarket.addEventListener('click', function () {
      setCatalogTab(true)
    })
    els.marketRefreshBtn.addEventListener('click', function () {
      void loadMarket('', true)
    })
    els.healthBtn.addEventListener('click', function () {
      void refreshHealth()
    })
    els.updateAllBtn.addEventListener('click', function () {
      void doUpdateAll()
    })
    bindProgressEvents()
    bindRestart()
    load()
  } else {
    els.installedList.replaceChildren(
      el('div', 'zone__empty', '无法连接主进程（window.api 缺失）')
    )
  }
})()
