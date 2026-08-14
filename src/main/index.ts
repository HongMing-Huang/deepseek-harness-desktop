import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { ProcessSupervisor } from './runtime/process-supervisor'
import { registerIpcHandlers, broadcastStatus } from './ipc'
import type { RuntimeStatus } from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
const supervisor = new ProcessSupervisor()
let latestStatus: RuntimeStatus = { phase: 'starting', message: '正在初始化…' }

/** 单实例锁：重复启动时聚焦已有窗口 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 应用内导航拦截：仅允许本机 dsh web；外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  void loadSplash()
}

function splashUrl(): string {
  // electron-vite dev 环境注入渲染进程 dev server 地址
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    return `${devServer}/splash.html`
  }
  return join(__dirname, '../renderer/splash.html')
}

async function loadSplash(): Promise<void> {
  if (!mainWindow) return
  const url = splashUrl()
  if (url.startsWith('http')) {
    await mainWindow.loadURL(url)
  } else {
    await mainWindow.loadFile(url)
  }
}

function setStatus(status: RuntimeStatus): void {
  latestStatus = status
  broadcastStatus(status)
}

async function bootstrapRuntime(): Promise<void> {
  setStatus({ phase: 'starting', message: '正在启动 DeepSeek Harness…' })

  supervisor.once('ready', ({ port, url }) => {
    setStatus({ phase: 'ready', port, url, message: 'dsh web 已就绪' })
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(url)
    }
  })

  supervisor.once('error', ({ message, stderrTail }) => {
    setStatus({
      phase: 'error',
      message,
      stderrTail,
      port: supervisor.port ?? undefined
    })
  })

  supervisor.on('exit', ({ code, signal }) => {
    // 仅在就绪后的意外退出时通知 UI（启动期退出已由 error 事件覆盖）
    if (latestStatus.phase === 'ready') {
      setStatus({
        phase: 'stopped',
        message: `dsh web 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`
      })
    }
  })

  try {
    const { port } = await supervisor.start()
    setStatus({
      phase: 'starting',
      port,
      message: `正在等待 dsh web 就绪（端口 ${port}）…`
    })
  } catch (err) {
    setStatus({
      phase: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

app.whenReady().then(() => {
  registerIpcHandlers({ getRuntimeStatus: () => latestStatus })
  createMainWindow()
  void bootstrapRuntime()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
      void bootstrapRuntime()
    }
  })
})

app.on('window-all-closed', () => {
  // macOS 惯例之外的简化：关闭窗口即退出（桌面工具类应用）
  app.quit()
})

async function shutdown(): Promise<void> {
  try {
    await supervisor.stop()
  } catch {
    // 退出路径尽力而为
  }
}

app.on('before-quit', (event) => {
  if (supervisor.running) {
    event.preventDefault()
    void shutdown().finally(() => app.quit())
  }
})

// 兜底：未捕获异常时也要尽量停掉 dsh 子进程
process.on('uncaughtException', () => {
  void shutdown().finally(() => process.exit(1))
})
