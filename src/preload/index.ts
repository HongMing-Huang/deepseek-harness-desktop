import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type DshDesktopApi, type RuntimeStatus } from '../shared/ipc'

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

contextBridge.exposeInMainWorld('api', api)
