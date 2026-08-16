// Deepseek 会话中心窗口逻辑：经 window.api（preload 白名单）读写官方 dsh 数据。
// 纯原生 JS，无框架依赖。三视图：工作区卡片首页 / 工作区会话列表 / 全局搜索。
// 全部数据只读；恢复 = 打开官方 Web 界面续接；导出 = 官方 zip / 本地 Markdown / JSONL。
;(function () {
  'use strict'

  var els = {
    viewTitle: document.getElementById('viewTitle'),
    viewSub: document.getElementById('viewSub'),
    backBtn: document.getElementById('backBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    filesBtn: document.getElementById('filesBtn'),
    filesView: document.getElementById('filesView'),
    filesTree: document.getElementById('filesTree'),
    filesRootPath: document.getElementById('filesRootPath'),
    filesLegend: document.getElementById('filesLegend'),
    filesOpenBtn: document.getElementById('filesOpenBtn'),
    searchInput: document.getElementById('searchInput'),
    sourceBadge: document.getElementById('sourceBadge'),
    homeView: document.getElementById('homeView'),
    sessionsView: document.getElementById('sessionsView'),
    workspaceGrid: document.getElementById('workspaceGrid'),
    sessionList: document.getElementById('sessionList'),
    exportPopover: document.getElementById('exportPopover'),
    toast: document.getElementById('toast')
  }

  var api = window.api
  var workspaces = [] // 工作区缓存
  var currentWorkspace = null // 钻入的工作区
  var view = 'home' // home | workspace | search
  var searchTimer = null
  var toastTimer = null
  var pendingExport = null // { sessionId, title }

  /* ── 工作区文件树状态 ── */
  var fileTreeMode = false
  var fileRoot = '' // 当前文件树根目录
  var expandedDirs = {} // dirPath -> true
  var dirEntries = {} // dirPath -> entries[]
  var gitChanges = {} // 相对路径 -> 状态码（XY）
  var gitRepo = false

  /* ── 小工具 ── */

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function relativeTime(ms) {
    if (!ms) return ''
    var delta = Date.now() - ms
    if (delta < 0) delta = 0
    var minutes = Math.floor(delta / 60000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return minutes + ' 分钟前'
    var hours = Math.floor(minutes / 60)
    if (hours < 24) return hours + ' 小时前'
    var days = Math.floor(hours / 24)
    if (days < 30) return days + ' 天前'
    return new Date(ms).toLocaleDateString()
  }

  function showToast(message, kind) {
    els.toast.hidden = false
    els.toast.textContent = message
    els.toast.className = 'toast' + (kind ? ' is-' + kind : '')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      els.toast.hidden = true
    }, 3200)
  }

  function setView(next, title, sub) {
    view = next
    els.viewTitle.textContent = title
    els.viewSub.textContent = sub
    els.backBtn.hidden = next === 'home'
    els.homeView.hidden = next !== 'home'
    els.sessionsView.hidden = (next !== 'workspace' && next !== 'search') || fileTreeMode
    // 文件按钮：仅真实工作区视图可用（全部会话视图无目录树）
    els.filesBtn.hidden = !(
      next === 'workspace' &&
      currentWorkspace &&
      currentWorkspace.workspaceId !== null &&
      typeof currentWorkspace.path === 'string' &&
      currentWorkspace.path.length > 0
    )
    els.filesView.hidden = next !== 'workspace' || !fileTreeMode
    hidePopover()
  }

  function showSourceBadge(source) {
    els.sourceBadge.hidden = false
    els.sourceBadge.replaceChildren(
      el(
        'span',
        source === 'official' ? 'badge badge--ok' : 'badge badge--muted',
        source === 'official' ? '官方 dsh 接口' : '本地数据（web 未就绪）'
      )
    )
  }

  /* ── 视图一：工作区项目卡片 ── */

  function loadWorkspaces() {
    if (!api) return
    els.workspaceGrid.replaceChildren(el('div', 'empty', '加载中…'))
    api
      .listWorkspaces()
      .then(function (result) {
        workspaces = (result && result.workspaces) || []
        renderWorkspaces()
      })
      .catch(function () {
        els.workspaceGrid.replaceChildren(
          el('div', 'empty', '工作区数据读取失败，请稍后重试')
        )
      })
  }

  function renderWorkspaces() {
    els.workspaceGrid.replaceChildren()
    if (workspaces.length === 0) {
      var empty = el('div', 'empty', '还没有工作区')
      empty.appendChild(el('div', 'empty__hint', '在官方 Web 界面中打开一个项目目录，即会出现工作区卡片'))
      els.workspaceGrid.appendChild(empty)
      return
    }

    // 全部会话卡片：跨工作区查看（含无工作区归属的子代理会话）
    var allCard = el('div', 'card card--all')
    allCard.setAttribute('role', 'listitem')
    var allTop = el('div', 'card__top')
    allTop.appendChild(el('div', 'card__icon', '≡'))
    var allTitles = el('div', 'card__titles')
    allTitles.appendChild(el('div', 'card__name', '全部会话'))
    allTitles.appendChild(el('div', 'card__path', '跨工作区查看所有会话（含子代理）'))
    allTop.appendChild(allTitles)
    allCard.appendChild(allTop)
    var allMeta = el('div', 'card__meta')
    allMeta.appendChild(el('span', null, '浏览 / 搜索 / 恢复 / 导出'))
    allCard.appendChild(allMeta)
    allCard.addEventListener('click', function () {
      void drillWorkspace({ workspaceId: null, title: '全部会话', path: '', sessionCount: 0 })
    })
    els.workspaceGrid.appendChild(allCard)

    workspaces.forEach(function (ws) {
      var card = el('div', 'card')
      card.setAttribute('role', 'listitem')

      var top = el('div', 'card__top')
      var icon = el('div', 'card__icon', '▣')
      top.appendChild(icon)

      var titles = el('div', 'card__titles')
      titles.appendChild(el('div', 'card__name', ws.title || basenameOf(ws.path)))
      titles.appendChild(el('div', 'card__path', ws.path || ''))
      top.appendChild(titles)
      card.appendChild(top)

      var meta = el('div', 'card__meta')
      meta.appendChild(el('span', null, ws.sessionCount + ' 个会话'))
      if (ws.updatedAt) {
        meta.appendChild(el('span', null, '最近活动 ' + relativeTime(Date.parse(ws.updatedAt))))
      }
      card.appendChild(meta)

      var actions = el('div', 'card__actions')
      var resumeBtn = el('button', 'btn btn--primary btn--mini', '在官方界面打开')
      resumeBtn.type = 'button'
      resumeBtn.addEventListener('click', function (event) {
        event.stopPropagation()
        void doOpenWorkspace(ws)
      })
      actions.appendChild(resumeBtn)

      var folderBtn = el('button', 'btn btn--mini', '文件夹')
      folderBtn.type = 'button'
      folderBtn.title = '在文件管理器中打开项目目录'
      folderBtn.addEventListener('click', function (event) {
        event.stopPropagation()
        void doOpenFolder(ws.path)
      })
      actions.appendChild(folderBtn)
      card.appendChild(actions)

      card.addEventListener('click', function () {
        void drillWorkspace(ws)
      })
      els.workspaceGrid.appendChild(card)
    })
  }

  function basenameOf(path) {
    if (!path) return ''
    var parts = String(path).replace(/[\\/]+$/, '').split('/')
    return parts[parts.length - 1] || path
  }

  function doOpenWorkspace(ws) {
    if (!api) return
    api
      .resumeSession('')
      .then(function (result) {
        showToast((result && result.message) || '已打开官方 Web 界面', 'ok')
      })
      .catch(function () {
        showToast('打开主窗口失败', 'error')
      })
  }

  function doOpenFolder(path) {
    if (!api) return
    api
      .openWorkspaceFolder(path)
      .then(function (result) {
        if (result && !result.ok) showToast(result.message || '打开目录失败', 'error')
      })
      .catch(function () {
        showToast('打开目录失败', 'error')
      })
  }

  /* ── 视图二：工作区会话列表 ── */

  function drillWorkspace(ws) {
    currentWorkspace = ws
    var sub =
      ws.workspaceId === null
        ? '跨工作区全部会话（含子代理）'
        : (ws.path || '') + ' · ' + ws.sessionCount + ' 个会话'
    setView('workspace', ws.title || basenameOf(ws.path), sub)
    els.searchInput.value = ''
    els.sessionList.replaceChildren(el('div', 'empty', '加载中…'))
    if (!api) return
    api
      .listSessions(ws.workspaceId === null ? undefined : ws.workspaceId)
      .then(function (result) {
        showSourceBadge(result && result.source)
        renderSessions((result && result.items) || [])
      })
      .catch(function () {
        els.sessionList.replaceChildren(el('div', 'empty', '会话列表读取失败，请稍后重试'))
      })
  }

  function renderSessions(items) {
    els.sessionList.replaceChildren()
    if (items.length === 0) {
      els.sessionList.appendChild(el('div', 'empty', '该工作区暂无会话记录'))
      return
    }

    items.forEach(function (s) {
      var item = el('div', 'item')
      item.setAttribute('role', 'listitem')

      var main = el('div', 'item__main')
      var nameRow = el('div', 'item__name-row')
      nameRow.appendChild(el('span', 'item__name', s.title || '未命名会话'))
      if (s.origin === 'subagent') {
        nameRow.appendChild(el('span', 'item__tag badge badge--muted', '子代理'))
      }
      if (s.running) {
        nameRow.appendChild(el('span', 'item__tag badge badge--ok', '运行中'))
      }
      main.appendChild(nameRow)

      var metaParts = []
      if (typeof s.turns === 'number') metaParts.push(s.turns + ' 轮')
      if (typeof s.steps === 'number') metaParts.push(s.steps + ' 步')
      var relTime = relativeTime(s.updatedAt)
      if (relTime) metaParts.push(relTime)
      main.appendChild(el('div', 'item__desc', metaParts.join(' · ')))
      item.appendChild(main)

      var actions = el('div', 'item__actions')
      var resumeBtn = el('button', 'btn btn--primary btn--mini', '恢复')
      resumeBtn.type = 'button'
      resumeBtn.addEventListener('click', function () {
        void doResume(s)
      })
      actions.appendChild(resumeBtn)

      var exportBtn = el('button', 'btn btn--mini', '导出')
      exportBtn.type = 'button'
      exportBtn.addEventListener('click', function (event) {
        openExportPopover(s, exportBtn)
      })
      actions.appendChild(exportBtn)
      item.appendChild(actions)

      els.sessionList.appendChild(item)
    })
  }

  function doResume(session) {
    if (!api) return
    api
      .resumeSession(session.sessionId)
      .then(function (result) {
        if (result && !result.ok) {
          showToast(result.message || '恢复失败', 'error')
        } else {
          showToast('已打开官方 Web 界面，在会话侧栏中继续', 'ok')
        }
      })
      .catch(function () {
        showToast('恢复失败', 'error')
      })
  }

  /* ── 视图三：全局搜索 ── */

  function scheduleSearch() {
    var query = (els.searchInput.value || '').trim()
    if (!query) {
      if (view === 'search') {
        currentWorkspace ? drillWorkspace(currentWorkspace) : setView('home', '工作区', '项目卡片式会话概览（数据来自官方 dsh 存储，只读）')
      }
      return
    }
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(function () {
      void runSearch(query)
    }, 280)
  }

  function runSearch(query) {
    setView('search', '搜索：' + query, '跨工作区检索会话内容与标题')
    els.sessionList.replaceChildren(el('div', 'empty', '搜索中…'))
    if (!api) return
    api
      .searchSessions(query)
      .then(function (result) {
        showSourceBadge(result && result.source)
        renderSearchResults((result && result.items) || [], (result && result.hasMore) || false)
      })
      .catch(function () {
        els.sessionList.replaceChildren(el('div', 'empty', '搜索失败，请稍后重试'))
      })
  }

  function renderSearchResults(items, hasMore) {
    els.sessionList.replaceChildren()
    if (items.length === 0) {
      els.sessionList.appendChild(el('div', 'empty', '没有匹配的会话'))
      return
    }

    items.forEach(function (s) {
      var item = el('div', 'item')
      var main = el('div', 'item__main')
      var nameRow = el('div', 'item__name-row')
      nameRow.appendChild(el('span', 'item__name', s.title || '未命名会话'))
      if (s.updatedAt) {
        nameRow.appendChild(el('span', 'item__tag badge badge--muted', relativeTime(s.updatedAt)))
      }
      main.appendChild(nameRow)
      if (s.cwd) {
        main.appendChild(el('div', 'item__desc', s.cwd))
      }
      if (s.snippet) {
        main.appendChild(el('div', 'item__snippet', s.snippet))
      }
      item.appendChild(main)

      var actions = el('div', 'item__actions')
      var resumeBtn = el('button', 'btn btn--primary btn--mini', '恢复')
      resumeBtn.type = 'button'
      resumeBtn.addEventListener('click', function () {
        void doResume({ sessionId: s.sessionId })
      })
      actions.appendChild(resumeBtn)
      item.appendChild(actions)
      els.sessionList.appendChild(item)
    })

    if (hasMore) {
      els.sessionList.appendChild(el('div', 'empty', '结果过多，仅展示前 ' + items.length + ' 条，请细化关键词'))
    }
  }

  /* ── 导出浮层 ── */

  function openExportPopover(session, anchor) {
    pendingExport = session
    hidePopover()
    var rect = anchor.getBoundingClientRect()
    els.exportPopover.hidden = false
    // 浮层定位：按钮下方右对齐，超出窗口右侧时向左收
    var popWidth = 250
    var left = Math.min(rect.right - popWidth, window.innerWidth - popWidth - 12)
    els.exportPopover.style.left = Math.max(12, left) + 'px'
    els.exportPopover.style.top = rect.bottom + 6 + 'px'
  }

  function hidePopover() {
    els.exportPopover.hidden = true
    pendingExport = null
  }

  function doExport(format) {
    if (!pendingExport || !api) return
    var session = pendingExport
    var includeDescendants = format === 'zip'
    hidePopover()
    showToast('正在导出…')
    api
      .exportSession(session.sessionId, format, includeDescendants)
      .then(function (result) {
        if (!result) return
        if (result.cancelled) return
        if (result.ok) {
          showToast('已导出：' + result.path, 'ok')
        } else {
          showToast(result.message || '导出失败', 'error')
        }
      })
      .catch(function () {
        showToast('导出失败', 'error')
      })
  }

  /* ── 工作区文件树（只读；点击展开目录 / 点文件用默认应用打开 / git 变更标记） ── */

  function relPathOf(root, full) {
    if (!full || full.indexOf(root) !== 0) return ''
    var rel = full.slice(root.length).replace(/^\/+/, '')
    return rel
  }

  function gitMark(rel) {
    if (!gitRepo || !rel) return ''
    var code = gitChanges[rel]
    if (!code) return ''
    // 取工作区状态；未跟踪 ?? → ?
    var x = code[0]
    var y = code[1]
    var mark = y !== ' ' ? y : x
    if (mark === ' ') mark = x
    if (mark === '?' || mark === '!') return '?'
    return mark.toUpperCase()
  }

  function toggleFilesMode() {
    if (currentWorkspace && currentWorkspace.workspaceId === null) return // 全部会话视图无文件树
    fileTreeMode = !fileTreeMode
    if (fileTreeMode) {
      fileRoot = currentWorkspace.path || ''
      els.filesRootPath.textContent = fileRoot || '—'
      expandedDirs = {}
      dirEntries = {}
      gitChanges = {}
      gitRepo = false
      els.filesLegend.style.display = 'none'
      els.filesTree.replaceChildren(el('div', 'empty', '正在读取目录…'))
      setView(view, els.viewTitle.textContent, els.viewSub.textContent)
      void api
        .listDirectory(fileRoot)
        .then(function (result) {
          if (!result || !result.ok) {
            els.filesTree.replaceChildren(
              el('div', 'empty', (result && result.message) || '目录不可读')
            )
            return
          }
          dirEntries[fileRoot] = result.entries
          renderFileTree()
          void api.workspaceGitStatus(fileRoot).then(function (g) {
            if (!g || !g.repo) return
            gitRepo = true
            g.changes.forEach(function (c) {
              gitChanges[c.file] = c.code
            })
            els.filesLegend.style.display = ''
            renderFileTree()
          })
        })
        .catch(function () {
          els.filesTree.replaceChildren(el('div', 'empty', '目录读取失败'))
        })
    }
    setView(view, els.viewTitle.textContent, els.viewSub.textContent)
  }

  function toggleDir(dirPath, rowId) {
    if (expandedDirs[dirPath]) {
      delete expandedDirs[dirPath]
      var children = document.querySelectorAll('[data-parent="' + rowId + '"]')
      Array.prototype.forEach.call(children, function (node) {
        node.remove()
      })
      renderFileTree() // 刷新箭头
      return
    }
    expandedDirs[dirPath] = true
    renderFileTree() // 先渲染箭头与占位
    if (dirEntries[dirPath]) {
      renderFileTree()
      return
    }
    void api
      .listDirectory(dirPath)
      .then(function (result) {
        if (result && result.ok) {
          dirEntries[dirPath] = result.entries
        }
        renderFileTree()
      })
      .catch(function () {
        delete expandedDirs[dirPath]
        renderFileTree()
      })
  }

  function renderFileTree() {
    var rootEntries = dirEntries[fileRoot] || []
    els.filesTree.replaceChildren()
    if (rootEntries.length === 0) {
      els.filesTree.appendChild(el('div', 'empty', '目录为空'))
      return
    }
    renderTreeLevel(rootEntries, fileRoot, 0, els.filesTree, null)
  }

  function renderTreeLevel(entries, basePath, depth, container, parentId) {
    entries.forEach(function (entry, idx) {
      var full = basePath + '/' + entry.name
      var rowId = parentId ? parentId + '-' + idx : 'r' + idx
      var row = el('div', 'ft-row' + (entry.dir ? ' ft-row--dir' : ''))
      row.setAttribute('role', 'treeitem')
      row.style.paddingLeft = 8 + depth * 14 + 'px'
      if (parentId) row.dataset.parent = parentId
      row.dataset.row = rowId

      var arrow = el('span', 'ft-arrow', entry.dir ? (expandedDirs[full] ? '▾' : '▸') : ' ')
      row.appendChild(arrow)
      row.appendChild(el('span', 'ft-icon', entry.dir ? '▸▸' : ''))
      var name = el('span', 'ft-name', entry.name)
      row.appendChild(name)

      var mark = gitMark(relPathOf(fileRoot, full))
      if (mark) {
        var badge = el('span', 'git-mark git-mark-' + mark.toLowerCase(), mark)
        row.appendChild(badge)
      }
      if (!entry.dir && entry.size > 0) {
        row.appendChild(el('span', 'ft-size', formatSize(entry.size)))
      }

      if (entry.dir) {
        row.addEventListener('click', function () {
          toggleDir(full, rowId)
        })
      } else {
        row.title = full
        row.addEventListener('click', function () {
          void api.openWorkspaceFolder(full).catch(function () {
            showToast('打开文件失败', 'error')
          })
        })
      }
      container.appendChild(row)

      if (entry.dir && expandedDirs[full] && dirEntries[full]) {
        renderTreeLevel(dirEntries[full], full, depth + 1, container, rowId)
      }
    })
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  /* ── 事件绑定 ── */

  function bindEvents() {
    els.filesBtn.addEventListener('click', toggleFilesMode)
    els.filesOpenBtn.addEventListener('click', function () {
      if (fileRoot) {
        void api.openWorkspaceFolder(fileRoot).catch(function () {
          showToast('打开目录失败', 'error')
        })
      }
    })
    els.backBtn.addEventListener('click', function () {
      currentWorkspace = null
      els.searchInput.value = ''
      setView('home', '工作区', '项目卡片式会话概览（数据来自官方 dsh 存储，只读）')
      loadWorkspaces()
    })
    // 刷新当前视图（首页/工作区/搜索结果按视图重载）
    function refreshCurrent() {
      if (view === 'home') {
        loadWorkspaces()
      } else if (view === 'workspace' && currentWorkspace) {
        drillWorkspace(currentWorkspace)
      } else if (view === 'search') {
        var q = (els.searchInput.value || '').trim()
        if (q) {
          void runSearch(q)
        } else if (currentWorkspace) {
          drillWorkspace(currentWorkspace)
        } else {
          loadWorkspaces()
        }
      }
    }
    els.refreshBtn.addEventListener('click', refreshCurrent)
    // 窗口回到前台时自动刷新（节流 2s，防高频触发）
    var lastFocusRefresh = 0
    window.addEventListener('focus', function () {
      var now = Date.now()
      if (now - lastFocusRefresh < 2000) return
      lastFocusRefresh = now
      refreshCurrent()
    })
    els.searchInput.addEventListener('input', scheduleSearch)
    els.searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        els.searchInput.value = ''
        scheduleSearch()
      }
    })
    document.addEventListener('click', function (event) {
      if (els.exportPopover.hidden) return
      if (!els.exportPopover.contains(event.target)) hidePopover()
    })
    Array.prototype.forEach.call(
      els.exportPopover.querySelectorAll('.popover__item'),
      function (btn) {
        btn.addEventListener('click', function () {
          doExport(btn.dataset.format)
        })
      }
    )
  }

  /* ── 启动 ── */

  bindEvents()
  if (api) {
    setView('home', '工作区', '项目卡片式会话概览（数据来自官方 dsh 存储，只读）')
    loadWorkspaces()
  } else {
    els.workspaceGrid.replaceChildren(el('div', 'empty', '无法连接主进程（window.api 缺失）'))
  }
})()
