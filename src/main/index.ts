import { app, BrowserWindow, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ProcessSupervisor } from './runtime/process-supervisor'
import { registerIpcHandlers, broadcastStatus, broadcastOpProgress, type IpcContext } from './ipc'
import { classifyStartupError } from './runtime/error-classifier'
import { repairPort } from './runtime/port-doctor'
import { bundledDshVersion, resolveRuntime } from './runtime/paths'
import * as config from './config'
import { createMainWindow, setupAppMenu } from './windows'
import { logger } from './logger'
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
let latestStatus: RuntimeStatus = { phase: 'starting', message: '正在初始化…' }

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
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

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
    logger.info(`dsh web 就绪：${url}`)
    setStatus({ phase: 'ready', port, url, message: 'dsh web 已就绪' })
    broadcastOpProgress({ op: 'boot', state: 'done', percent: 100, message: 'dsh web 已就绪' })
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(url)
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
  })

  supervisor.on('exit', ({ code, signal }) => {
    // 仅在就绪后的意外退出时通知 UI（启动期退出已由 error 事件覆盖）
    if (latestStatus.phase === 'ready') {
      logger.warn(`dsh web 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
      setStatus({
        phase: 'stopped',
        message: `dsh web 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`
      })
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
      void mainWindow.loadURL(url)
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
  logger.info('手动重启 dsh web')
  await supervisor.stop()
  await bootstrapRuntime()
  return latestStatus
}

async function handleRepairPort(port?: number): Promise<RepairPortResult> {
  const target = port ?? supervisor.port ?? latestStatus.port ?? 3080
  const result = await repairPort(target)
  if (result.ok) {
    logger.info(`端口修复成功：${result.message}`)
    // 修复成功后自动重启运行时（回到进度态）
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

    // 更新通道：由 P3 的 RuntimeUpdater 提供；当前返回不可用状态避免死通道
    checkUpdater: async (): Promise<UpdaterCheckResult> => ({
      state: 'unavailable',
      currentDsh: bundledDshVersion(),
      message: '更新服务尚未初始化'
    }),
    applyUpdater: async () => ({ ok: false, message: '更新服务尚未初始化' })
  }
}

/* ── 应用生命周期 ── */

app.whenReady().then(() => {
  logger.info('应用启动，开始引导运行时')
  registerIpcHandlers(buildIpcContext())
  setupAppMenu()
  mainWindow = createMainWindow()
  void bootstrapRuntime()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      void bootstrapRuntime()
    }
  })
})

app.on('window-all-closed', () => {
  // macOS 惯例之外的简化：关闭窗口即退出（桌面工具类应用）
  app.quit()
})

async function shutdown(): Promise<void> {
  logger.info('正在停止 dsh web 子进程…')
  try {
    await supervisor.stop()
    logger.info('dsh web 已停止')
  } catch (err) {
    logger.warn(`停止 dsh web 异常：${err instanceof Error ? err.message : String(err)}`)
  }
}

app.on('before-quit', (event) => {
  if (supervisor.running) {
    event.preventDefault()
    void shutdown().finally(() => app.quit())
  }
})

// 兜底：未捕获异常先记日志再优雅退出，并停掉 dsh 子进程
process.on('uncaughtException', (err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  logger.error(`未捕获异常：${detail}`)
  void shutdown().finally(() => process.exit(1))
})
