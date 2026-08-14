import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannels, type RuntimeStatus } from '../shared/ipc'

/**
 * 集中式 IPC registry：所有 handler 在此注册，
 * 通道名统一来自 shared/ipc.ts，避免散落字符串。
 */

export interface IpcContext {
  getRuntimeStatus(): RuntimeStatus
}

export function registerIpcHandlers(ctx: IpcContext): void {
  ipcMain.handle(IpcChannels.RuntimeGetStatus, () => ctx.getRuntimeStatus())
}

/** 向所有窗口广播运行时状态 */
export function broadcastStatus(status: RuntimeStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannels.RuntimeStatus, status)
    }
  }
}
