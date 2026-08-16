import {
  app,
  BrowserWindow,
  Menu,
  shell,
  WebContentsView,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'node:path'

/**
 * 窗口与视图布局的单一职责小模块：
 * - 主窗口：splash 承载于窗口自身 webContents；运行时就绪后改为
 *   contentView 单子视图 —— dshWebView（全幅，加载 dsh web，无 preload）；
 * - 设置 / 插件窗口（单例，重复打开时聚焦）；
 * - 应用菜单（设置入口 Cmd/Ctrl+,、工具→插件…）。
 */

let settingsWindow: BrowserWindow | null = null
let pluginsWindow: BrowserWindow | null = null
let sessionsWindow: BrowserWindow | null = null

/* ── 主窗口子视图（模块级单例：应用仅一个主窗口，closed 时清理） ── */

let mainWindow: BrowserWindow | null = null
let dshWebView: WebContentsView | null = null
let toolbarView: WebContentsView | null = null
/** 主界面工具栏高度（按钮栏：会话中心 / 插件 / 设置 + 运行状态） */
const TOOLBAR_HEIGHT = 42
/** 当前 dsh web 监听端口（就绪后由 showDshWebView 解析；外链守卫比对用） */
let currentDshPort: number | null = null

/** 渲染页面地址：dev 态走 renderer dev server，打包态读 out/renderer */
function pageUrl(page: string): string {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    return `${devServer}/${page}`
  }
  return join(__dirname, '../renderer', page)
}

async function loadWindowPage(
  win: BrowserWindow | WebContentsView,
  page: string
): Promise<void> {
  const url = pageUrl(page)
  if (url.startsWith('http')) {
    await win.webContents.loadURL(url)
  } else {
    await win.webContents.loadFile(url)
  }
}

/**
 * 外链拦截：仅本机 dsh web（hostname 严格等于 127.0.0.1/localhost 且端口
 * 等于当前 dsh web 端口）放行；其余一律 openExternal + deny。
 * 主窗口（splash 期）与 dshWebView 共用策略。
 */
function applyExternalLinkPolicy(webContents: Electron.WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalDshWebUrl(url)) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

/** URL 解析判定：前缀 startsWith 可被 `http://127.0.0.1.evil.com` 绕过，必须解析后逐项比对 */
function isLocalDshWebUrl(url: string): boolean {
  if (currentDshPort === null) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:') return false
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false
    return parsed.port === String(currentDshPort)
  } catch {
    return false
  }
}

/**
 * 自有窗口（设置/插件/会话中心）外链策略：
 * - window.open / target=_blank：https 链接一律交给系统浏览器（openExternal）并 deny；
 * - 页面导航：仅允许回到本窗口自己的页面地址（三个自有页面的精确前缀），
 *   其余 will-navigate 阻止——防止任意 file:// 本地文件读取或远程跳转劫持。
 */
const OWN_PAGES = ['settings.html', 'plugins.html', 'sessions.html']

function ownPageUrls(): string[] {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    return OWN_PAGES.map((page) => `${devServer}/${page}`)
  }
  const rendererDir = join(__dirname, '../renderer')
  return OWN_PAGES.map((page) => join(rendererDir, page))
}

function applyOwnWindowLinkPolicy(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = ownPageUrls().some((own) => url.startsWith(own))
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url)
      }
    }
  })
}

/** 创建主窗口（加载 splash 页；ready 后由 showDshWebView 切换 dsh web 视图） */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Deepseek',
    backgroundColor: '#0d0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // splash 期（窗口自身 webContents）沿用同一外链策略
  applyExternalLinkPolicy(win.webContents)

  // 子视图随内容区尺寸重排（resize / 最大化 / 全屏均触发）
  win.on('resize', () => layoutMainViews())

  win.on('closed', () => {
    dshWebView = null
    toolbarView = null
    if (mainWindow === win) mainWindow = null
  })

  mainWindow = win
  void loadWindowPage(win, 'splash.html')
  return win
}

/**
 * 运行时就绪：创建（或复用）dsh web 全幅视图并加载 url。
 * dshWebView：远程内容，无 preload、强隔离、沙箱；沿用外链拦截策略；
 * 幂等：重复调用（重启运行时）只重载视图地址。
 */
export function showDshWebView(win: BrowserWindow, url: string): void {
  if (win.isDestroyed()) return
  mainWindow = win

  // 记录当前 dsh web 端口（外链守卫严格比对用；非法 URL 时视为未知）
  try {
    const port = new URL(url).port
    currentDshPort = port.length > 0 ? Number(port) : null
  } catch {
    currentDshPort = null
  }

  const content = win.contentView
  // 主界面工具栏（自有页面：按钮打开会话中心/插件/设置，右侧运行状态）
  if (!toolbarView) {
    toolbarView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: false
      }
    })
    void loadWindowPage(toolbarView, 'toolbar.html')
  }
  if (!content.children.includes(toolbarView)) {
    content.addChildView(toolbarView)
  }
  // 视图可能因崩溃错误页被移除（showRuntimeErrorOverlay）：重建挂载即可恢复
  if (!dshWebView) {
    dshWebView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
      }
    })
    applyExternalLinkPolicy(dshWebView.webContents)
  }
  if (!content.children.includes(dshWebView)) {
    content.addChildView(dshWebView)
  }

  void dshWebView.webContents.loadURL(url)
  layoutMainViews()
}

/**
 * 运行时就绪后意外退出：移除 dsh web 视图，露出主窗口自身 webContents
 * 的 splash 错误卡（依赖广播可达，渲染层展示重试按钮）。
 */
export function showRuntimeErrorOverlay(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const content = mainWindow.contentView
  if (dshWebView && content.children.includes(dshWebView)) {
    content.removeChildView(dshWebView)
  }
}

/** dsh web 视图铺满主窗口内容区（resize / 最大化 / 全屏均触发重排） */
function layoutMainViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [width, height] = mainWindow.getContentSize()
  if (toolbarView) {
    toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT })
  }
  if (dshWebView) {
    dshWebView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: height - TOOLBAR_HEIGHT })
  }
}

/* ── 设置窗口（单例） ── */

/** 打开设置窗口（单例：已存在则聚焦） */
export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 580,
    minWidth: 440,
    minHeight: 540,
    show: false,
    title: '设置',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false
    }
  })

  applyOwnWindowLinkPolicy(settingsWindow)
  settingsWindow.on('ready-to-show', () => settingsWindow?.show())
  void loadWindowPage(settingsWindow, 'settings.html')
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

/* ── 插件窗口（单例） ── */

/** 打开插件管理窗口（单例：已存在则聚焦） */
export function openPluginsWindow(): void {
  if (pluginsWindow && !pluginsWindow.isDestroyed()) {
    pluginsWindow.focus()
    return
  }
  pluginsWindow = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: '插件',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false
    }
  })

  applyOwnWindowLinkPolicy(pluginsWindow)
  pluginsWindow.on('ready-to-show', () => pluginsWindow?.show())
  void loadWindowPage(pluginsWindow, 'plugins.html')
  pluginsWindow.on('closed', () => {
    pluginsWindow = null
  })
}

/* ── 会话中心窗口（单例） ── */

/** 打开会话中心窗口（单例：已存在则聚焦） */
export function openSessionsWindow(): void {
  if (sessionsWindow && !sessionsWindow.isDestroyed()) {
    sessionsWindow.focus()
    return
  }
  sessionsWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: '会话',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false
    }
  })

  applyOwnWindowLinkPolicy(sessionsWindow)
  sessionsWindow.on('ready-to-show', () => sessionsWindow?.show())
  void loadWindowPage(sessionsWindow, 'sessions.html')
  sessionsWindow.on('closed', () => {
    sessionsWindow = null
  })
}

/* ── 应用菜单 ── */

/** 应用菜单：设置 / 插件入口 + 基础编辑能力（输入框复制粘贴必需） */
export function setupAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const isDev = Boolean(process.env['ELECTRON_RENDERER_URL'])

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.getName(),
          submenu: [
            { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
            { type: 'separator' },
            { label: '会话中心…', click: () => openSessionsWindow() },
            { label: '插件…', click: () => openPluginsWindow() },
            { type: 'separator' },
            { role: 'hide', label: '隐藏 Deepseek' },
            { role: 'unhide', label: '显示全部' },
            { type: 'separator' },
            { role: 'quit', label: '退出 Deepseek' }
          ]
        }
      ]
    : [
        {
          label: '文件',
          submenu: [
            { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
            { type: 'separator' },
            { role: 'quit', label: '退出' }
          ]
        }
      ]

  const toolsMenu: MenuItemConstructorOptions = {
    label: '工具',
    submenu: [
      {
        label: '会话中心…',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => openSessionsWindow()
      },
      { label: '插件…', click: () => openPluginsWindow() }
    ]
  }

  const viewItems: MenuItemConstructorOptions[] = []
  if (isDev) {
    viewItems.push({ role: 'reload', label: '重新加载' })
  }
  viewItems.push({ role: 'toggleDevTools', label: '开发者工具' })

  const viewMenu: MenuItemConstructorOptions = { label: '视图', submenu: viewItems }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...appMenu,
      {
        label: '编辑',
        submenu: [
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' }
        ]
      },
      viewMenu,
      toolsMenu
    ])
  )
}
