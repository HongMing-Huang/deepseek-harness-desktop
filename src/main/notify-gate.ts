/**
 * 托盘通知去重与状态文案的纯函数集合：
 * 不依赖 electron / 文件系统，便于 node:test 直接单测。
 *
 * 去重语义：同一 key 的事件在 windowMs 内只放行一次；
 * 被拒绝的事件不推进时间戳（避免重复失败刷屏无限续期）。
 */

/** 去重器状态：key → 上次放行时刻（epoch ms） */
export interface NotificationGateState {
  lastEmittedAt: Record<string, number>
}

/** 默认去重窗口：同一 key 60s 内不重复弹出 */
export const NOTIFICATION_DEDUPE_WINDOW_MS = 60_000

/**
 * 纯函数去重判定：返回是否放行与更新后的状态（新对象，不修改入参）。
 * 同 key 在窗口内的重复事件被拒绝，且不刷新其时间戳。
 */
export function decideNotification(
  state: NotificationGateState,
  key: string,
  now: number,
  windowMs: number = NOTIFICATION_DEDUPE_WINDOW_MS
): { emit: boolean; state: NotificationGateState } {
  const last = state.lastEmittedAt[key]
  if (typeof last === 'number' && now - last < windowMs) {
    return { emit: false, state }
  }
  return {
    emit: true,
    state: { lastEmittedAt: { ...state.lastEmittedAt, [key]: now } }
  }
}

/**
 * 可变去重门（主进程通知路径使用）：
 * 时间源可注入，默认 Date.now；测试可传受控时钟。
 */
export function createNotificationGate(now: () => number = Date.now): {
  shouldEmit(key: string): boolean
} {
  let state: NotificationGateState = { lastEmittedAt: {} }
  return {
    shouldEmit(key: string): boolean {
      const result = decideNotification(state, key, now())
      if (result.emit) {
        state = result.state
      }
      return result.emit
    }
  }
}

/**
 * 托盘 tooltip 状态文案（纯函数）：
 * 优先级：更新中 > 运行时出错 > 就绪（运行中）> 启动中 / 已停止。
 */
export function trayStatusText(
  runtimePhase: 'starting' | 'ready' | 'error' | 'stopped' | null,
  updateBusy: boolean
): string {
  if (updateBusy) {
    return '更新中'
  }
  switch (runtimePhase) {
    case 'ready':
      return '运行中'
    case 'error':
      return '出错'
    case 'stopped':
      return '已停止'
    case 'starting':
    default:
      return '启动中'
  }
}
