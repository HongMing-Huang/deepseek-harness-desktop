import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type DshDesktopApi, type RuntimeStatus } from '../shared/ipc'

// preload 运行于渲染进程：tsconfig.node 无 DOM lib，此处补充 location 最小类型
declare const location: { readonly protocol: string; readonly href: string }

/**
 * contextBridge 白名单：renderer 只能访问这里显式暴露的能力，
 * 绝不透传 ipcRenderer 本身或 Node 能力。
 */
const api: DshDesktopApi = {
  getStatus: () => ipcRenderer.invoke(IpcChannels.RuntimeGetStatus) as Promise<RuntimeStatus>,

  onStatus: (listener: (status: RuntimeStatus) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: RuntimeStatus): void => {
      listener(status)
    }
    ipcRenderer.on(IpcChannels.RuntimeStatus, wrapped)
    return () => {
      ipcRenderer.removeListener(IpcChannels.RuntimeStatus, wrapped)
    }
  }
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
