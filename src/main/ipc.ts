import { BrowserWindow, ipcMain } from 'electron'
import {
  IpcChannels,
  type ConfigState,
  type DiagnosticsResult,
  type OpProgress,
  type Preferences,
  type RepairPortResult,
  type RuntimeStatus,
  type UpdaterCheckResult,
  type UpdaterStatusPayload
} from '../shared/ipc'

/**
 * 集中式 IPC registry：所有 handler 在此注册，
 * 通道名统一来自 shared/ipc.ts，避免散落字符串。
 * 依赖（supervisor / config / updater）经 IpcContext 构造注入，不做全局散落。
 */

export interface IpcContext {
  /* 运行时 */
  getRuntimeStatus(): RuntimeStatus
  restartRuntime(): Promise<RuntimeStatus>
  repairPort(port?: number): Promise<RepairPortResult>
  getDiagnostics(): Promise<DiagnosticsResult>
  openLogs(): { ok: boolean }

  /* 更新 */
  checkUpdater(): Promise<UpdaterCheckResult>
  applyUpdater(version?: string): Promise<{ ok: boolean; message?: string }>

  /* 配置 */
  getConfig(): Promise<ConfigState>
  saveApiKey(key: string): Promise<{ ok: boolean; message?: string }>
  saveDefaultModel(model: string): Promise<{ ok: boolean; message?: string }>
  savePreferences(patch: Partial<Preferences>): Promise<Preferences>
}

export function registerIpcHandlers(ctx: IpcContext): void {
  /* 运行时 */
  ipcMain.handle(IpcChannels.RuntimeGetStatus, () => ctx.getRuntimeStatus())
  ipcMain.handle(IpcChannels.RuntimeRestart, () => ctx.restartRuntime())
  ipcMain.handle(IpcChannels.RuntimeRepairPort, (_e, port?: number) => ctx.repairPort(port))
  ipcMain.handle(IpcChannels.RuntimeGetDiagnostics, () => ctx.getDiagnostics())
  ipcMain.handle(IpcChannels.RuntimeOpenLogs, () => ctx.openLogs())

  /* 更新 */
  ipcMain.handle(IpcChannels.UpdaterCheckNow, () => ctx.checkUpdater())
  ipcMain.handle(IpcChannels.UpdaterApply, (_e, version?: string) => ctx.applyUpdater(version))

  /* 配置 */
  ipcMain.handle(IpcChannels.ConfigGet, () => ctx.getConfig())
  ipcMain.handle(IpcChannels.ConfigSaveApiKey, (_e, key: string) => ctx.saveApiKey(key))
  ipcMain.handle(IpcChannels.ConfigSaveModel, (_e, model: string) => ctx.saveDefaultModel(model))
  ipcMain.handle(IpcChannels.ConfigSavePreferences, (_e, patch: Partial<Preferences>) =>
    ctx.savePreferences(patch)
  )

  // Plugins* / Token* 通道：shared 已登记、preload 已暴露，
  // handler 由后续「插件管理 / Token 图」阶段实现（当前 renderer 不调用）。
}

/* ── 事件广播：向所有窗口推送 ── */

function broadcast<T>(channel: string, payload: T): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/** 向所有窗口广播运行时状态 */
export function broadcastStatus(status: RuntimeStatus): void {
  broadcast(IpcChannels.RuntimeStatus, status)
}

/** 向所有窗口广播长操作进度 */
export function broadcastOpProgress(progress: OpProgress): void {
  broadcast(IpcChannels.OpProgress, progress)
}

/** 向所有窗口广播更新器状态 */
export function broadcastUpdaterStatus(status: UpdaterStatusPayload): void {
  broadcast(IpcChannels.UpdaterStatus, status)
}
