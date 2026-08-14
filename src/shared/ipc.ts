/**
 * IPC 通道与载荷的集中定义，main / preload / renderer 共用。
 * 所有新增 IPC 都必须先在此登记，再在 main/ipc.ts 中注册处理器。
 */

export const IpcChannels = {
  /** renderer → main（invoke）：查询当前运行时状态 */
  RuntimeGetStatus: 'runtime:get-status',
  /** main → renderer（event）：运行时状态推送 */
  RuntimeStatus: 'runtime:status'
} as const

export type RuntimePhase =
  /** 正在准备运行时 / 拉起 dsh web */
  | 'starting'
  /** dsh web 已就绪，主窗口即将切换 */
  | 'ready'
  /** 启动失败 */
  | 'error'
  /** 进程已停止 */
  | 'stopped'

export interface RuntimeStatus {
  phase: RuntimePhase
  /** dsh web 监听端口（就绪后提供） */
  port?: number
  /** Web UI 地址（就绪后提供） */
  url?: string
  /** 人类可读的状态描述 / 错误摘要 */
  message?: string
  /** 失败时的 stderr 尾部（诊断用） */
  stderrTail?: string
}

/** preload 通过 contextBridge 暴露给 renderer 的 API 白名单 */
export interface DshDesktopApi {
  getStatus(): Promise<RuntimeStatus>
  onStatus(listener: (status: RuntimeStatus) => void): () => void
}

declare global {
  interface Window {
    api?: DshDesktopApi
  }
}
