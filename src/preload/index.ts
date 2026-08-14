import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type DeepseekApi,
  type OpProgress,
  type Preferences,
  type RuntimeStatus,
  type UpdaterStatusPayload
} from '../shared/ipc'

// preload 运行于渲染进程：tsconfig.node 无 DOM lib，此处补充 location 最小类型
declare const location: { readonly protocol: string; readonly href: string }

/** 事件订阅的统一封装：返回取消订阅函数 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

/**
 * contextBridge 白名单：renderer 只能访问这里显式暴露的能力，
 * 绝不透传 ipcRenderer 本身或 Node 能力。
 */
const api: DeepseekApi = {
  /* 运行时 */
  getStatus: () => ipcRenderer.invoke(IpcChannels.RuntimeGetStatus),
  restartRuntime: () => ipcRenderer.invoke(IpcChannels.RuntimeRestart),
  repairPort: (port?: number) => ipcRenderer.invoke(IpcChannels.RuntimeRepairPort, port),
  getDiagnostics: () => ipcRenderer.invoke(IpcChannels.RuntimeGetDiagnostics),
  openLogs: () => ipcRenderer.invoke(IpcChannels.RuntimeOpenLogs),

  /* 更新 */
  checkUpdater: () => ipcRenderer.invoke(IpcChannels.UpdaterCheckNow),
  applyUpdater: (version?: string) => ipcRenderer.invoke(IpcChannels.UpdaterApply, version),

  /* 插件：handler 由插件管理阶段实现 */
  listPlugins: () => ipcRenderer.invoke(IpcChannels.PluginsList),
  getPluginCatalog: () => ipcRenderer.invoke(IpcChannels.PluginsCatalog),
  installPlugin: (name: string, version?: string) =>
    ipcRenderer.invoke(IpcChannels.PluginsInstall, name, version),
  removePlugin: (name: string) => ipcRenderer.invoke(IpcChannels.PluginsRemove, name),

  /* 配置 */
  getConfig: () => ipcRenderer.invoke(IpcChannels.ConfigGet),
  saveApiKey: (key: string) => ipcRenderer.invoke(IpcChannels.ConfigSaveApiKey, key),
  saveModel: (model: string) => ipcRenderer.invoke(IpcChannels.ConfigSaveModel, model),
  savePreferences: (patch: Partial<Preferences>) =>
    ipcRenderer.invoke(IpcChannels.ConfigSavePreferences, patch),

  /* 事件订阅 */
  onStatus: (listener: (status: RuntimeStatus) => void) =>
    subscribe<RuntimeStatus>(IpcChannels.RuntimeStatus, listener),
  onOpProgress: (listener: (progress: OpProgress) => void) =>
    subscribe<OpProgress>(IpcChannels.OpProgress, listener),
  onUpdaterStatus: (listener: (status: UpdaterStatusPayload) => void) =>
    subscribe<UpdaterStatusPayload>(IpcChannels.UpdaterStatus, listener)
}

/**
 * 来源守卫：仅应用自有页面（打包态 file: 协议 / dev 态本地 dev server）
 * 才暴露 window.api；dsh web 页面及其第三方插件代码不可见。
 */
const devServerUrl = process.env.ELECTRON_RENDERER_URL
const fromDevServer =
  typeof devServerUrl === 'string' && devServerUrl.length > 0 && location.href.startsWith(devServerUrl)

if (location.protocol === 'file:' || fromDevServer) {
  contextBridge.exposeInMainWorld('api', api)
}
