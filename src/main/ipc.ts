import { ipcMain, webContents } from 'electron'
import {
  IpcChannels,
  type ConfigState,
  type DiagnosticsResult,
  type OpProgress,
  type PluginEntry,
  type PluginHealthResult,
  type Preferences,
  type RepairPortResult,
  type RuntimeStatus,
  type SessionExportFormat,
  type SessionsExportResult,
  type SessionsListResult,
  type SessionsResumeResult,
  type SessionsSearchResult,
  type UpdaterCheckResult,
  type UpdaterStatusPayload,
  type WorkspaceSummary
} from '../shared/ipc'
import type { PluginCatalogEntry } from './runtime/plugins'

/**
 * 集中式 IPC registry：所有 handler 在此注册，
 * 通道名统一来自 shared/ipc.ts，避免散落字符串。
 * 依赖（supervisor / config / updater / plugins）经 IpcContext 构造注入，不做全局散落。
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

  /* 插件（runtime/plugins.ts 实现） */
  listPlugins(): Promise<{ plugins: PluginEntry[] }>
  getPluginCatalog(): Promise<{ catalog: PluginCatalogEntry[] }>
  installPlugin(name: string, version?: string): Promise<{ ok: boolean; message?: string }>
  removePlugin(name: string): Promise<{ ok: boolean; message?: string }>
  checkPluginsHealth(): Promise<PluginHealthResult>
  updateAllPlugins(): Promise<{ ok: boolean; message?: string }>

  /* 会话中心（sessions.ts 实现） */
  listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }>
  listSessions(workspaceId?: string): Promise<SessionsListResult>
  searchSessions(query: string): Promise<SessionsSearchResult>
  exportSession(
    sessionId: string,
    format: SessionExportFormat,
    includeDescendants?: boolean
  ): Promise<SessionsExportResult>
  resumeSession(sessionId: string): Promise<SessionsResumeResult>
  openWorkspaceFolder(path: string): Promise<{ ok: boolean; message?: string }>

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

  /* 插件（runtime/plugins.ts） */
  ipcMain.handle(IpcChannels.PluginsList, () => ctx.listPlugins())
  ipcMain.handle(IpcChannels.PluginsCatalog, () => ctx.getPluginCatalog())
  ipcMain.handle(IpcChannels.PluginsInstall, (_e, name: string, version?: string) =>
    ctx.installPlugin(name, version)
  )
  ipcMain.handle(IpcChannels.PluginsRemove, (_e, name: string) => ctx.removePlugin(name))
  ipcMain.handle(IpcChannels.PluginsHealth, () => ctx.checkPluginsHealth())
  ipcMain.handle(IpcChannels.PluginsUpdateAll, () => ctx.updateAllPlugins())

  /* 会话中心（sessions.ts） */
  ipcMain.handle(IpcChannels.SessionsWorkspaces, () => ctx.listWorkspaces())
  ipcMain.handle(IpcChannels.SessionsList, (_e, workspaceId?: string) =>
    ctx.listSessions(workspaceId)
  )
  ipcMain.handle(IpcChannels.SessionsSearch, (_e, query: string) => ctx.searchSessions(query))
  ipcMain.handle(
    IpcChannels.SessionsExport,
    (_e, sessionId: string, format: SessionExportFormat, includeDescendants?: boolean) =>
      ctx.exportSession(sessionId, format, includeDescendants)
  )
  ipcMain.handle(IpcChannels.SessionsResume, (_e, sessionId: string) =>
    ctx.resumeSession(sessionId)
  )
  ipcMain.handle(IpcChannels.SessionsOpenFolder, (_e, path: string) =>
    ctx.openWorkspaceFolder(path)
  )
}

/* ── 事件广播：向所有应用自有页面推送 ── */

/**
 * 广播目标 = 全部应用自有页面的 webContents：
 * - BrowserWindow 页面（splash / settings / plugins）；
 * - 后续如新增 WebContentsView 页面同样被覆盖 ——
 *   BrowserWindow.getAllWindows() 遍历不到子视图，因此改用
 *   webContents.getAllWebContents() 按 URL 过滤：
 *   打包态 file: 协议自有页面 + dev 态本地 dev server 前缀；
 *   dsh web 视图（远程内容）与其它来源一律排除，避免向第三方页面泄漏事件。
 */
function broadcast<T>(channel: string, payload: T): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    const url = wc.getURL()
    const isOwnPage =
      url.startsWith('file:') ||
      (typeof devServer === 'string' && devServer.length > 0 && url.startsWith(devServer))
    if (!isOwnPage) continue
    wc.send(channel, payload)
  }
}

/** 向全部自有页面广播运行时状态 */
export function broadcastStatus(status: RuntimeStatus): void {
  broadcast(IpcChannels.RuntimeStatus, status)
}

/** 向全部自有页面广播长操作进度 */
export function broadcastOpProgress(progress: OpProgress): void {
  broadcast(IpcChannels.OpProgress, progress)
}

/** 向全部自有页面广播更新器状态 */
export function broadcastUpdaterStatus(status: UpdaterStatusPayload): void {
  broadcast(IpcChannels.UpdaterStatus, status)
}
