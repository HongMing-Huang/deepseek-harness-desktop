import { app, BrowserWindow, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ProcessSupervisor } from './runtime/process-supervisor'
import { RuntimeUpdater } from './runtime/updater'
import {
  registerIpcHandlers,
  broadcastStatus,
  broadcastOpProgress,
  type IpcContext
} from './ipc'
import { classifyStartupError } from './runtime/error-classifier'
import { repairPort } from './runtime/port-doctor'
import {
  bundledDshVersion,
  cleanupSideloadRuntimes,
  readCurrentSideloadVersion,
  resolveRuntime
} from './runtime/paths'
import * as config from './config'
import { createMainWindow, setupAppMenu, showDshWebView, showRuntimeErrorOverlay } from './windows'
import { logger } from './logger'
import { TrayController } from './tray'
import * as plugins from './runtime/plugins'
import * as dshfind from './runtime/dshfind'
import * as sessions from './sessions'
import type {
  ConfigState,
  DiagnosticsResult,
  Preferences,
  RepairPortResult,
  RuntimeStatus,
  UpdaterCheckResult
} from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
const supervisor = new ProcessSupervisor()
let updater: RuntimeUpdater | null = null
let trayController: TrayController | null = null
let latestStatus: RuntimeStatus = { phase: 'starting', message: '正在初始化…' }
/** 退出流程已发起（before-quit 二次进入直接 app.exit，防死循环） */
let quitRequested = false
/** 预期内重启进行中（手动重启/端口修复）：exit 事件不作崩溃处理 */
let expectedRestart = false

/** boot 各阶段映射的进度百分比（与 supervisor progress 事件对应） */
const STAGE_PERCENT: Record<string, number> = {
  'resolve-runtime': 18,
  'allocate-port': 36,
  spawn: 60,
  'wait-ready': 82
}

/** 单实例锁：重复启动时聚焦已有窗口 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  showMainWindowFromTray()
})

/** 显示主窗口（托盘点击/二次激活共用）：存在则显示+聚焦，不存在则创建并引导运行时 */
function showMainWindowFromTray(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  mainWindow = createMainWindow()
  void bootstrapRuntime()
}

/** 会话中心「恢复」入口：窗口就绪 + 运行时保证在跑（可重复调用，幂等） */
function ensureMainWindowAndRuntime(): void {
  showMainWindowFromTray()
  if (!supervisor.running) {
    void bootstrapRuntime()
  }
}

function setStatus(status: RuntimeStatus): void {
  latestStatus = status
  broadcastStatus(status)
}

/**
 * supervisor 事件监听只在模块初始化时挂一次；
 * bootstrapRuntime 可安全重复调用（窗口重建 / activate 二次进入）。
 */
function attachSupervisorListeners(): void {
  supervisor.on('ready', ({ port, url }) => {
    expectedRestart = false
    logger.info(`dsh web 就绪：${url}`)
    setStatus({ phase: 'ready', port, url, message: 'dsh web 已就绪' })
    broadcastOpProgress({ op: 'boot', state: 'done', percent: 100, message: 'dsh web 已就绪' })
    if (updater) {
      void updater.noteBootSuccess()
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 就绪后切换 dsh web 全幅视图（无 preload，强隔离）
      showDshWebView(mainWindow, url)
    }
  })

  supervisor.on('progress', ({ stage, message }) => {
    // 阶段百分比由 index 统一映射，避免 renderer 重复维护
    broadcastOpProgress({
      op: 'boot',
      state: 'update',
      percent: STAGE_PERCENT[stage],
      message
    })
  })

  supervisor.on('error', ({ message, stderrTail }) => {
    expectedRestart = false
    logger.error(`dsh web 启动失败：${message}`)
    const classification = classifyStartupError({ message, stderrTail })
    setStatus({
      phase: 'error',
      message,
      stderrTail,
      port: supervisor.port ?? undefined,
      classification
    })
    broadcastOpProgress({ op: 'boot', state: 'error', message })
    // 侧载运行时连续失败计数 / 自动回退（回退成功时会自动重启，状态广播随之更新）
    if (updater) {
      void updater.noteBootFailure()
    }
  })

  supervisor.on('exit', ({ code, signal }) => {
    // 仅就绪后的意外退出才作崩溃处理（启动期退出已由 error 事件覆盖；
    // 更新热切换 / 手动重启 / 端口修复 / 退出流程中的 stop 属预期内停止）
    const expected =
      quitRequested || expectedRestart || Boolean(updater?.updating)
    if (latestStatus.phase === 'ready' && !expected) {
      const message = `dsh web 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`
      logger.warn(message)
      // 分类兑底为 process-crash：错误卡提供重试 / 查看日志动作
      const classification = classifyStartupError({ message })
      setStatus({
        phase: 'error',
        message,
        port: supervisor.port ?? undefined,
        classification
      })
      // 移除双子视图，露出主窗口 splash 错误卡（依赖广播可达）
      showRuntimeErrorOverlay()
    }
  })
}

attachSupervisorListeners()

async function bootstrapRuntime(): Promise<void> {
  // 已就绪的进程直接复用：避免对已 ready 的 supervisor 重复挂 once 监听（永不触发）导致卡 splash
  const url = supervisor.url
  if (supervisor.running && supervisor.phase === 'ready' && url) {
    logger.info(`复用已就绪的 dsh web：${url}`)
    setStatus({ phase: 'ready', port: supervisor.port ?? undefined, url, message: 'dsh web 已就绪' })
    if (mainWindow && !mainWindow.isDestroyed()) {
      showDshWebView(mainWindow, url)
    }
    return
  }

  setStatus({ phase: 'starting', message: '正在启动 DeepSeek Harness…' })
  broadcastOpProgress({ op: 'boot', state: 'start', message: '正在启动运行时' })

  try {
    const { port } = await supervisor.start()
    setStatus({
      phase: 'starting',
      port,
      message: `正在等待 dsh web 就绪（端口 ${port}）…`
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`运行时启动异常：${message}`)
    const classification = classifyStartupError({ message })
    setStatus({ phase: 'error', message, classification })
    broadcastOpProgress({ op: 'boot', state: 'error', message })
  }
}

/* ── IPC 上下文（构造注入：闭包引用 supervisor / config） ── */

async function getConfigState(): Promise<ConfigState> {
  const [apiKey, defaultModel, preferences] = await Promise.all([
    config.getApiKeyStatus(),
    config.getDefaultModel(),
    config.getPreferences()
  ])
  const bundled = bundledDshVersion()
  let dsh: string | null = bundled
  let sideloaded = false
  try {
    const resolution = resolveRuntime()
    dsh = resolution.dshVersion ?? bundled
    sideloaded = resolution.usingSideloadDsh
  } catch {
    // 运行时解析失败时回退展示内嵌版本信息
  }
  return { apiKey, defaultModel, preferences, versions: { app: app.getVersion(), bundled, dsh, sideloaded } }
}

async function getDiagnostics(): Promise<DiagnosticsResult> {
  const { stdoutTail, stderrTail } = supervisor.getDiagnostics()
  const lastError = latestStatus.phase === 'error' ? latestStatus : null
  const classification = classifyStartupError({
    message: lastError?.message ?? '',
    stderrTail: lastError?.stderrTail ?? stderrTail
  })
  let runtime: DiagnosticsResult['runtime'] = null
  try {
    const resolution = resolveRuntime()
    runtime = { dshVersion: resolution.dshVersion, usingSideload: resolution.usingSideloadDsh }
  } catch {
    runtime = null
  }
  return { stdoutTail, stderrTail, classification, runtime }
}

async function restartRuntime(): Promise<RuntimeStatus> {
  // 更新热切换进行中：重启会与指针切换竞态，拒绝并提示
  if (updater?.updating) {
    logger.warn('更新进行中，忽略手动重启请求')
    return { ...latestStatus, message: '更新进行中，请稍候' }
  }
  logger.info('手动重启 dsh web')
  expectedRestart = true
  await supervisor.stop()
  await bootstrapRuntime()
  return latestStatus
}

async function handleRepairPort(port?: number): Promise<RepairPortResult> {
  // 更新热切换进行中：修复会重启运行时，与指针切换竞态，拒绝并提示
  if (updater?.updating) {
    logger.warn('更新进行中，忽略端口修复请求')
    return { ok: false, message: '更新进行中，请稍候' }
  }
  const target = port ?? supervisor.port ?? latestStatus.port ?? 3080
  const result = await repairPort(target)
  if (result.ok) {
    logger.info(`端口修复成功：${result.message}`)
    // 修复成功后自动重启运行时（回到进度态）
    expectedRestart = true
    await supervisor.stop()
    void bootstrapRuntime()
  } else {
    logger.warn(`端口修复未完成：${result.message}`)
  }
  return result
}

function openLogsFolder(): { ok: boolean } {
  try {
    const logsDir = join(app.getPath('userData'), 'logs')
    mkdirSync(logsDir, { recursive: true })
    shell.showItemInFolder(join(logsDir, 'main.log'))
    return { ok: true }
  } catch (err) {
    logger.warn(`打开日志目录失败：${err instanceof Error ? err.message : String(err)}`)
    return { ok: false }
  }
}

function buildIpcContext(): IpcContext {
  return {
    getRuntimeStatus: () => latestStatus,
    restartRuntime,
    repairPort: (port?: number) => handleRepairPort(port),
    getDiagnostics,
    openLogs: openLogsFolder,
    getConfig: () => getConfigState(),

    saveApiKey: async (key: string) => {
      // OpProgress 反馈保存过程；日志与返回值均不含密钥明文
      broadcastOpProgress({ op: 'credentials', state: 'start', message: '正在保存 API Key…' })
      const result = await config.saveApiKey(key)
      broadcastOpProgress({
        op: 'credentials',
        state: result.ok ? 'done' : 'error',
        message: result.ok ? 'API Key 已保存' : result.message ?? '保存失败'
      })
      return result
    },

    saveDefaultModel: async (model: string) => {
      broadcastOpProgress({ op: 'model', state: 'start', message: '正在保存默认模型…' })
      const result = await config.saveDefaultModel(model)
      broadcastOpProgress({
        op: 'model',
        state: result.ok ? 'done' : 'error',
        message: result.ok ? '默认模型已保存' : result.message ?? '保存失败'
      })
      return result
    },

    savePreferences: (patch: Partial<Preferences>) => config.savePreferencesMerge(patch),

    /* 插件：runtime/plugins.ts 直通（安装/卸载内含 OpProgress 广播与并发锁）；
       结果同步给托盘发系统通知（并发锁拒绝除外） */
    listPlugins: () => plugins.listInstalledPlugins().then((items) => ({ plugins: items })),
    getPluginCatalog: () => plugins.getPluginCatalog().then((catalog) => ({ catalog })),
    installPlugin: async (name: string, version?: string, spec?: string) => {
      const result = await plugins.installPlugin(name, version, spec)
      trayController?.notifyPluginResult('install', name, result.ok, result.message)
      return result
    },
    removePlugin: async (name: string) => {
      const result = await plugins.removePlugin(name)
      trayController?.notifyPluginResult('remove', name, result.ok, result.message)
      return result
    },
    checkPluginsHealth: () => plugins.checkPluginsHealth(),
    updateAllPlugins: async () => {
      const result = await plugins.updateAllPlugins()
      if (result.ok) {
        trayController?.notifyPluginResult('update-all', '全部插件', true, result.message)
      } else if (!result.message?.includes('已有插件操作进行中')) {
        trayController?.notifyPluginResult('update-all', '全部插件', false, result.message)
      }
      return result
    },
    searchMarket: (query: string) => dshfind.searchMarket(query),
    refreshMarket: () => dshfind.refreshMarket(),

    checkUpdater: () =>
      updater ? updater.checkNow() : Promise.resolve({
        state: 'unavailable' as const,
        currentDsh: bundledDshVersion(),
        message: '更新服务尚未初始化'
      }),
    applyUpdater: (version?: string) =>
      updater
        ? updater.applyUpdate(version)
        : Promise.resolve({ ok: false, message: '更新服务尚未初始化' }),

    /* 会话中心：sessions.ts 直通（只读官方数据；恢复经主窗口官方 Web 续接） */
    listWorkspaces: () => sessions.listWorkspaces(),
    listSessions: (workspaceId?: string) => sessions.listSessions(workspaceId),
    searchSessions: (query: string) => sessions.searchSessions(query),
    exportSession: (sessionId, format, includeDescendants) =>
      sessions.exportSession(sessionId, format, includeDescendants ?? false),
    resumeSession: (sessionId: string) => Promise.resolve(sessions.resumeSession(sessionId)),
    openWorkspaceFolder: (path: string) => sessions.openWorkspaceFolder(path)
  }
}

/* ── 应用生命周期 ── */

app.whenReady().then(async () => {
  logger.info('应用启动，开始引导运行时')

  // 启动清理：侧载目录仅保留 current 指向版本 + lastKnownGoodDsh（回滚目标）
  const preferences = await config.getPreferences()
  const currentSideload = readCurrentSideloadVersion()
  const keep = [currentSideload, preferences.lastKnownGoodDsh].filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  )
  // 异步清理（不阻塞主进程启动），完成后记日志；失败不阻断引导
  void cleanupSideloadRuntimes(keep)
    .then((removed) => {
      if (removed > 0) logger.info(`启动清理：已移除 ${removed} 个过期侧载版本目录`)
    })
    .catch((err) =>
      logger.warn(`启动清理异常：${err instanceof Error ? err.message : String(err)}`)
    )

  // 更新器：晚于清理初始化，保证调度开始前目录已是受控状态
  updater = new RuntimeUpdater(supervisor)

  // 会话中心依赖注入：web 状态查询（官方 RPC 可用性）+ 恢复入口
  sessions.initSessions({
    getWebStatus: () => ({ phase: latestStatus.phase, port: latestStatus.port }),
    ensureMainWindow: ensureMainWindowAndRuntime
  })

  registerIpcHandlers(buildIpcContext())
  setupAppMenu()
  mainWindow = createMainWindow()
  void bootstrapRuntime()
  updater.start()

  // 托盘常驻：点击显示/创建主窗口；菜单含插件市场/设置/检查更新/退出；
  // 订阅 supervisor 与更新器状态（tooltip 附加运行状态，异常/新版本发原生通知）
  trayController = new TrayController({
    supervisor,
    showMainWindow: showMainWindowFromTray,
    checkUpdates: () => {
      void updater?.runManualCheck()
    },
    onUpdaterStatus: (listener) =>
      updater ? updater.onStatus(listener) : () => {}
  })
  trayController.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      void bootstrapRuntime()
    }
  })
})

app.on('window-all-closed', () => {
  // macOS：托盘/dock 常驻，关窗驻留（dock 或托盘可再拉起）；
  // 其余平台保持关窗即退出（桌面工具类应用惯例）
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

async function shutdown(): Promise<void> {
  logger.info('正在停止 dsh web 子进程…')
  // 托盘先释放（事件订阅与系统资源），避免退出过程中再弹通知/更新 tooltip
  trayController?.dispose()
  trayController = null
  // 插件操作进行中：先中止 pnpm 子进程，避免退出后残留
  if (plugins.hasActivePluginOperation()) {
    plugins.abortActivePluginOperation()
  }
  try {
    await supervisor.stop()
    logger.info('dsh web 已停止')
  } catch (err) {
    logger.warn(`停止 dsh web 异常：${err instanceof Error ? err.message : String(err)}`)
  }
}

app.on('before-quit', (event) => {
  // 二次进入（shutdown 完成后的 app.quit()）：直接退出，防死循环
  if (quitRequested) {
    app.exit(0)
    return
  }
  const updateInFlight = updater !== null && updater.updating
  if (supervisor.running || updateInFlight) {
    quitRequested = true
    event.preventDefault()
    // 更新中收到退出请求：取消安装并回退未验证指针，不阻塞退出
    void Promise.allSettled([shutdown(), updater ? updater.cancelForQuit() : Promise.resolve()]).finally(
      () => app.quit()
    )
  }
})

// 兜底：未捕获异常先记日志再优雅退出，并停掉 dsh 子进程
process.on('uncaughtException', (err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  logger.error(`未捕获异常：${detail}`)
  void shutdown().finally(() => process.exit(1))
})
