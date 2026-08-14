import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'

/**
 * 窗口创建的单一职责小模块：
 * - 主窗口（splash 引导 → dsh web）；
 * - 设置窗口（单例，重复打开时聚焦）；
 * - 应用菜单（设置入口 Cmd/Ctrl+, 与基础编辑能力）。
 */

let settingsWindow: BrowserWindow | null = null

/** 渲染页面地址：dev 态走 renderer dev server，打包态读 out/renderer */
function pageUrl(page: string): string {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    return `${devServer}/${page}`
  }
  return join(__dirname, '../renderer', page)
}

async function loadWindowPage(win: BrowserWindow, page: string): Promise<void> {
  const url = pageUrl(page)
  if (url.startsWith('http')) {
    await win.loadURL(url)
  } else {
    await win.loadFile(url)
  }
}

/** 创建主窗口（加载 splash 页；ready 事件由调用方处理） */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'DSH Desktop',
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

  // 应用内导航拦截：仅允许本机 dsh web；外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  void loadWindowPage(win, 'splash.html')
  return win
}

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

  settingsWindow.on('ready-to-show', () => settingsWindow?.show())
  void loadWindowPage(settingsWindow, 'settings.html')
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

/** 应用菜单：设置入口 + 基础编辑能力（输入框复制粘贴必需） */
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
            { role: 'hide', label: '隐藏 DSH Desktop' },
            { role: 'unhide', label: '显示全部' },
            { type: 'separator' },
            { role: 'quit', label: '退出 DSH Desktop' }
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

  const viewMenu: MenuItemConstructorOptions = isDev
    ? {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' }
        ]
      }
    : {
        label: '视图',
        submenu: [{ role: 'toggleDevTools', label: '开发者工具' }]
      }

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
      viewMenu
    ])
  )
}
