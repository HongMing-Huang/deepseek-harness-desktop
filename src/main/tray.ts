import { app, Menu, nativeImage, Notification, Tray } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimePhase, UpdaterStatusPayload } from '../shared/ipc'
import { classifyStartupError } from './runtime/error-classifier'
import type { ProcessSupervisor } from './runtime/process-supervisor'
import { createNotificationGate, trayStatusText } from './notify-gate'
import { openPluginsWindow, openSettingsWindow } from './windows'
import { logger } from './logger'

/**
 * 托盘常驻 + 原生通知：
 * - 图标：whale-tray.png（黑色鲸鱼剪影透明底）；macOS 缩放 16/32 并
 *   setTemplateImage（自动适配菜单栏明暗），Linux/Windows 用普通 32px；
 * - 菜单：显示主窗口 / 插件市场 / 设置 / 检查更新 / 退出；
 * - 点击托盘：主窗口不存在则创建（并引导运行时），存在则显示+聚焦；
 * - 状态感知：订阅 supervisor 的 progress/error/ready/exit 与更新器状态，
 *   tooltip 附加「启动中/运行中/出错/更新中」；
 * - 原生通知：运行时启动失败（含分类器原因摘要）、发现 dsh 新版本、
 *   插件安装/卸载完成（成功与失败）；统一经 60s 去重门防刷屏，
 *   点击通知聚焦对应窗口；通知内容不含密钥/日志原文等敏感信息。
 */

export interface TrayDeps {
  /** 显示主窗口（不存在则创建并引导运行时；存在则显示+聚焦） */
  showMainWindow(): void
  /** 手动检查更新（复用更新器完整链路：发现新版弹窗引导） */
  checkUpdates(): void
  /** 运行时托管（订阅 progress/error/ready/exit 更新 tooltip 与失败通知） */
  supervisor: ProcessSupervisor
  /** 订阅更新器状态（available → 新版本通知；downloading → tooltip 更新中） */
  onUpdaterStatus(listener: (status: UpdaterStatusPayload) => void): () => void
}

/** 通知文案最大长度（超出截断，系统通知栏本身也会折叠） */
const NOTIFY_BODY_MAX = 120

export class TrayController {
  private tray: Tray | null = null
  private runtimePhase: RuntimePhase | null = null
  private updateBusy = false
  private readonly gate = createNotificationGate()
  private readonly detachSupervisor: () => void
  private detachUpdater: () => void = () => {}

  constructor(private readonly deps: TrayDeps) {
    this.detachSupervisor = this.attachSupervisor(deps.supervisor)
  }

  /** 创建托盘（图标缺失时记日志并降级为无托盘，不阻塞应用） */
  start(): void {
    const icon = loadTrayIcon()
    if (!icon) {
      logger.warn('托盘图标不可读（whale-tray.png 缺失），托盘未启用')
      return
    }
    this.tray = new Tray(icon)
    this.tray.setToolTip(this.tooltipText())
    this.tray.setContextMenu(this.buildMenu())
    // macOS：单击聚焦主窗口，右键/长按弹菜单；Windows/Linux：左键单击弹菜单前先聚焦
    this.tray.on('click', () => this.deps.showMainWindow())
    this.detachUpdater = this.deps.onUpdaterStatus((status) => {
      this.updateBusy = status.state === 'downloading'
      this.refreshTooltip()
      if (status.state === 'available' && status.latestDsh) {
        this.notify({
          key: `update-available:${status.latestDsh}`,
          title: '发现 dsh 新版本',
          body: `dsh ${status.latestDsh} 可用，可从托盘或设置中检查并更新。`,
          focus: 'main'
        })
      }
    })
    logger.info('托盘已启用')
  }

  /**
   * 插件操作结果通知（成功与失败均提示；并发锁拒绝除外——
   * 用户就在插件窗口内操作，被拒的操作无需系统级打扰）。
   */
  notifyPluginResult(
    action: 'install' | 'remove',
    name: string,
    ok: boolean,
    message?: string
  ): void {
    if (typeof message === 'string' && message.includes('已有插件操作进行中')) {
      return
    }
    const verb = action === 'install' ? '安装' : '卸载'
    this.notify({
      key: `plugin-${action}:${name}`,
      title: ok ? `插件已${verb}` : `插件${verb}失败`,
      body: ok ? `${name}（重启 dsh web 后生效）` : `${name}：${truncate(message ?? '未知原因', NOTIFY_BODY_MAX)}`,
      focus: 'plugins'
    })
  }

  /** 释放托盘与全部事件订阅（退出流程调用） */
  dispose(): void {
    this.detachSupervisor()
    this.detachUpdater()
    this.detachUpdater = () => {}
    this.tray?.destroy()
    this.tray = null
  }

  /* ── 内部实现 ── */

  private attachSupervisor(supervisor: ProcessSupervisor): () => void {
    const onProgress = (): void => this.setRuntimePhase('starting')
    const onReady = (): void => this.setRuntimePhase('ready')
    const onError = ({ message, stderrTail }: { message: string; stderrTail: string }): void => {
      this.setRuntimePhase('error')
      // 原因摘要来自纯函数分类器（处置建议），stderr 原文绝不进通知
      const { hint } = classifyStartupError({ message, stderrTail })
      this.notify({
        key: 'runtime-error',
        title: 'dsh web 启动失败',
        body: hint,
        focus: 'main'
      })
    }
    const onExit = (): void => {
      if (this.runtimePhase === 'ready') {
        this.setRuntimePhase('stopped')
      }
    }
    supervisor.on('progress', onProgress)
    supervisor.on('ready', onReady)
    supervisor.on('error', onError)
    supervisor.on('exit', onExit)
    return () => {
      supervisor.off('progress', onProgress)
      supervisor.off('ready', onReady)
      supervisor.off('error', onError)
      supervisor.off('exit', onExit)
    }
  }

  private setRuntimePhase(phase: RuntimePhase): void {
    this.runtimePhase = phase
    this.refreshTooltip()
  }

  private refreshTooltip(): void {
    this.tray?.setToolTip(this.tooltipText())
  }

  private tooltipText(): string {
    return `Deepseek — ${trayStatusText(this.runtimePhase, this.updateBusy)}`
  }

  private buildMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => this.deps.showMainWindow() },
      { type: 'separator' },
      { label: '插件市场', click: () => openPluginsWindow() },
      { label: '设置', click: () => openSettingsWindow() },
      { type: 'separator' },
      { label: '检查更新', click: () => this.deps.checkUpdates() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  }

  /** 原生通知（系统不支持或被去重门拒绝时静默跳过） */
  private notify(input: {
    key: string
    title: string
    body: string
    focus: 'main' | 'plugins'
  }): void {
    if (!Notification.isSupported()) {
      return
    }
    if (!this.gate.shouldEmit(input.key)) {
      return
    }
    const notification = new Notification({ title: input.title, body: input.body })
    notification.on('click', () => {
      if (input.focus === 'plugins') {
        openPluginsWindow()
      } else {
        this.deps.showMainWindow()
      }
    })
    notification.show()
  }
}

/**
 * 托盘图标加载：
 * - 构建期由 electron.vite.config.ts 复制到 out/main/whale-tray.png
 *   （打包态随 asar 分发），dev 态另有源码树回退路径；
 * - macOS：16px + 32px@2x 双表示，setTemplateImage 适配菜单栏明暗；
 * - Linux / Windows：普通 32px 彩色（黑剪影在浅色面板可辨认）。
 */
function loadTrayIcon(): Electron.NativeImage | null {
  const candidates = [
    join(__dirname, 'whale-tray.png'),
    join(__dirname, '../../src/renderer/assets/whale-tray.png')
  ]
  let raw: Buffer | null = null
  for (const file of candidates) {
    try {
      raw = readFileSync(file)
      break
    } catch {
      // 尝试下一候选路径
    }
  }
  if (!raw) {
    return null
  }
  const base = nativeImage.createFromBuffer(raw)
  if (base.isEmpty()) {
    return null
  }
  if (process.platform === 'darwin') {
    const icon = base.resize({ width: 16, height: 16 })
    const x2 = base.resize({ width: 32, height: 32 })
    icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: x2.toPNG() })
    icon.setTemplateImage(true)
    return icon
  }
  return base.resize({ width: 32, height: 32 })
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
