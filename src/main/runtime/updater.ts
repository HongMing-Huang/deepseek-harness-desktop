import { app, dialog, net, shell } from 'electron'
import semver from 'semver'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Preferences, UpdaterCheckResult, UpdaterStatusPayload, UpdaterState } from '../../shared/ipc'
import { ProcessSupervisor } from './process-supervisor'
import { InstallCancelledError, installDsh } from './dsh-installer'
import {
  bundledDshVersion,
  clearCurrentSideloadVersion,
  readCurrentSideloadVersion,
  resolveRuntime,
  sideloadRoot,
  writeCurrentSideloadVersion
} from './paths'
import { DEFAULT_UPDATE_REPO, getPreferences, savePreferencesMerge } from '../config'
import { broadcastOpProgress, broadcastUpdaterStatus } from '../ipc'
import { logger } from '../logger'

/**
 * 双轨自动更新：
 * - dsh 轨：npm registry latest 与当前运行版本 semver 比较 → 确认后侧载安装新版本，
 *   写 current.json 指针热切换（应用壳不重启）；失败保持旧版本可用；
 * - 壳轨：GitHub releases/latest 与 app.getVersion() 比较 → 弹窗引导前往下载页
 *   （占位仓库 / 404 时静默跳过）。
 *
 * 安全网：侧载运行时连续启动失败 2 次 → 自动回退内嵌基线并清理问题版本。
 */

const NPM_LATEST_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'
const GITHUB_API = 'https://api.github.com/repos'
const FIRST_CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const SNOOZE_MS = 24 * 60 * 60 * 1000
const READY_AFTER_SWITCH_TIMEOUT_MS = 60_000

export class RuntimeUpdater {
  private firstTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private etag: string | null = null
  private cachedLatest: string | null = null
  private latestDsh: string | null = null
  private applying = false
  private applyAbort: AbortController | null = null
  /** 指针已切换到新版本但尚未验证就绪（退出时需回退） */
  private pointerSwitched = false
  private disposed = false
  private readonly statusListeners = new Set<(status: UpdaterStatusPayload) => void>()

  constructor(private readonly supervisor: ProcessSupervisor) {}

  get updating(): boolean {
    return this.applying
  }

  /** 订阅更新器状态（托盘等主进程内部消费；返回取消函数） */
  onStatus(listener: (status: UpdaterStatusPayload) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /** 当前生效的 dsh 版本（解析失败回退内嵌清单，再失败为 null） */
  private currentDshVersion(): string | null {
    try {
      return resolveRuntime().dshVersion
    } catch {
      return bundledDshVersion()
    }
  }

  /** 调度：启动 30s 后首查，此后每 24h；受 updateCheckEnabled 与 lastCheck 节流 */
  start(): void {
    this.firstTimer = setTimeout(() => void this.autoCheck(), FIRST_CHECK_DELAY_MS)
    this.intervalTimer = setInterval(() => void this.autoCheck(), CHECK_INTERVAL_MS)
    logger.info('更新调度已启动（首次检查 30s 后，此后每 24h）')
  }

  dispose(): void {
    this.disposed = true
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.firstTimer = null
    this.intervalTimer = null
    this.statusListeners.clear()
  }

  private async autoCheck(): Promise<void> {
    if (this.disposed || this.applying) return
    const prefs = await getPreferences()
    if (!prefs.updateCheckEnabled) return
    // 24h 节流（lastCheck 由 checkNow 落盘）
    if (prefs.lastCheck && Date.now() - Date.parse(prefs.lastCheck) < CHECK_INTERVAL_MS) return

    const result = await this.checkNow()
    if (result.state === 'available' && result.latestDsh) {
      await this.promptUpdate(result.latestDsh, prefs)
    } else if (result.shellUpdate) {
      await this.promptShellUpdate(result.shellUpdate)
    }
  }

  /** 立即检查（手动触发绕过节流）；记录 lastCheck 并广播 UpdaterStatus */
  async checkNow(): Promise<UpdaterCheckResult> {
    const currentDsh = this.currentDshVersion()
    this.emitStatus({ state: 'checking', checking: true, currentDsh, message: '正在检查更新…' })
    await savePreferencesMerge({ lastCheck: new Date().toISOString() })

    /* dsh 轨：registry latest（If-None-Match ETag 复用上次结果） */
    let dshFetchFailed = false
    let latestDsh: string | null = null
    try {
      const headers: Record<string, string> = {}
      if (this.etag) headers['If-None-Match'] = this.etag
      const res = await net.fetch(NPM_LATEST_URL, { headers })
      if (res.status === 304) {
        latestDsh = this.cachedLatest
      } else if (res.ok) {
        this.etag = res.headers.get('etag')
        const data = (await res.json()) as { version?: string }
        latestDsh = typeof data.version === 'string' ? data.version : null
        this.cachedLatest = latestDsh
      } else {
        dshFetchFailed = true
        logger.warn(`dsh 更新检查失败：registry 返回 ${res.status}`)
      }
    } catch (err) {
      dshFetchFailed = true
      logger.warn(`dsh 更新检查网络异常：${errorMessage(err)}`)
    }

    // prerelease 语义由 semver 保证（0.1.0-rc.6 < 0.1.0-rc.7 < 0.1.0）
    const hasDshUpdate =
      Boolean(latestDsh) && currentDsh !== null && semver.gt(latestDsh as string, currentDsh)
    this.latestDsh = hasDshUpdate ? latestDsh : null

    /* 壳轨：GitHub releases/latest（占位仓库静默跳过） */
    const shellUpdate = await this.checkShellTrack()

    let state: UpdaterCheckResult['state']
    let message: string | undefined
    if (hasDshUpdate) {
      state = 'available'
      message = `发现 dsh 新版本 ${latestDsh}（当前 ${currentDsh}）`
    } else if (dshFetchFailed && !shellUpdate) {
      state = 'error'
      message = '更新检查失败：网络异常或 registry 不可达'
    } else {
      state = 'up-to-date'
      message = shellUpdate
        ? `dsh 已是最新；应用壳有新版本 ${shellUpdate.version}`
        : `dsh 已是最新（当前 ${currentDsh ?? '未知'}）`
    }

    this.emitStatus({
      state: hasDshUpdate ? 'available' : dshFetchFailed ? 'error' : 'up-to-date',
      checking: false,
      currentDsh,
      latestDsh: this.latestDsh ?? undefined,
      message
    })
    return { state, currentDsh, latestDsh: this.latestDsh ?? undefined, shellUpdate, message }
  }

  /** 壳轨检查：占位仓库 / 404 / 网络失败一律静默（仅日志） */
  private async checkShellTrack(): Promise<{ version: string; url: string } | null> {
    const prefs = await getPreferences()
    if (!prefs.updateRepo || prefs.updateRepo === DEFAULT_UPDATE_REPO) {
      logger.info('壳更新检查：updateRepo 为占位值，跳过')
      return null
    }
    try {
      const res = await net.fetch(`${GITHUB_API}/${prefs.updateRepo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'deepseek-harness-desktop' }
      })
      if (res.status === 404) {
        logger.info('壳更新检查：仓库不存在或无 release，跳过')
        return null
      }
      if (!res.ok) {
        logger.warn(`壳更新检查失败：GitHub 返回 ${res.status}`)
        return null
      }
      const data = (await res.json()) as { tag_name?: string; html_url?: string }
      const tag = (data.tag_name ?? '').replace(/^v/, '')
      if (!tag || !data.html_url) return null
      if (semver.valid(tag) && semver.gt(tag, app.getVersion())) {
        return { version: tag, url: data.html_url }
      }
      return null
    } catch (err) {
      logger.warn(`壳更新检查网络异常：${errorMessage(err)}`)
      return null
    }
  }

  /**
   * 手动检查（托盘/菜单入口）：立即检查并走完整引导链路——
   * 发现 dsh 新版弹窗（受「稍后提醒」豁免约束）、壳新版弹窗引导下载。
   */
  async runManualCheck(): Promise<void> {
    const result = await this.checkNow()
    if (this.disposed || this.applying) {
      return
    }
    if (result.state === 'available' && result.latestDsh) {
      await this.promptUpdate(result.latestDsh, await getPreferences())
    } else if (result.shellUpdate) {
      await this.promptShellUpdate(result.shellUpdate)
    }
  }

  /** dsh 新版本弹窗：立即更新 / 稍后提醒（豁免 24h） */
  private async promptUpdate(version: string, prefs: Preferences): Promise<void> {
    if (prefs.updateSnoozeUntil && Date.now() < Date.parse(prefs.updateSnoozeUntil)) {
      logger.info(`新版本 ${version} 待更新，处于「稍后提醒」豁免期`)
      return
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '发现 dsh 新版本',
      message: `发现 dsh 新版本 ${version}`,
      detail: `当前版本 ${this.currentDshVersion() ?? '未知'}。更新将下载新运行时并自动切换，应用无需重启。`,
      buttons: ['立即更新', '稍后提醒'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 1) {
      await savePreferencesMerge({ updateSnoozeUntil: new Date(Date.now() + SNOOZE_MS).toISOString() })
      return
    }
    void this.applyUpdate(version)
  }

  /** 壳新版本弹窗：前往下载 / 忽略 */
  private async promptShellUpdate(update: { version: string; url: string }): Promise<void> {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '发现应用新版本',
      message: `Deepseek ${update.version} 已发布`,
      detail: '将在浏览器中打开下载页面。',
      buttons: ['前往下载', '忽略'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) {
      await shell.openExternal(update.url)
    }
  }

  /**
   * 安装并热切换：stop → 侧载安装 → 写指针 → start（等就绪）。
   * 任一步失败：指针回退、恢复旧版本运行、弹窗告知；旧版本始终可用。
   */
  async applyUpdate(version?: string): Promise<{ ok: boolean; message?: string }> {
    if (this.applying) {
      return { ok: false, message: '已有更新正在进行' }
    }
    const target = version ?? this.latestDsh
    if (!target) {
      return { ok: false, message: '没有可安装的新版本' }
    }

    this.applying = true
    this.applyAbort = new AbortController()
    this.pointerSwitched = false
    broadcastOpProgress({ op: 'update', state: 'start', message: `开始更新 dsh ${target}` })
    this.emitStatus({
      state: 'downloading',
      currentDsh: this.currentDshVersion(),
      latestDsh: target,
      message: `正在下载并安装 dsh ${target}`
    })

    try {
      logger.info(`开始侧载更新 dsh → ${target}`)
      await this.supervisor.stop()
      await installDsh(
        {
          version: target,
          onProgress: (p) =>
            broadcastOpProgress({ op: 'update', state: 'update', percent: p.percent, message: p.message })
        },
        this.applyAbort.signal
      )
      if (this.disposed) {
        // 安装完成但应用正在退出：指针不切换，保持旧版本
        throw new InstallCancelledError()
      }

      // 切指针 → 热切换（start 会经侧载路径解析新版本）
      writeCurrentSideloadVersion(target)
      this.pointerSwitched = true
      broadcastOpProgress({ op: 'update', state: 'update', percent: 100, message: '正在切换运行时…' })

      // 写指针后强制幂等 stop：清掉可能残留的旧进程（与手动重启竞态时，
      // 旧进程存活会掩盖新版本未生效的事实，导致假更新成功）
      await this.supervisor.stop()
      await this.supervisor.start()
      await this.waitForReady(READY_AFTER_SWITCH_TIMEOUT_MS)
      this.pointerSwitched = false

      broadcastOpProgress({ op: 'update', state: 'done', message: `已更新到 dsh ${target}` })
      this.emitStatus({ state: 'installed', currentDsh: target, latestDsh: target, message: `已更新到 dsh ${target}` })
      this.latestDsh = null
      logger.info(`dsh 已热切换到 ${target}`)
      return { ok: true, message: `已更新到 dsh ${target}` }
    } catch (err) {
      const cancelled = err instanceof InstallCancelledError
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`dsh 更新失败：${message}`)

      // 指针已切换但未验证就绪：回退指针，保证旧版本可用
      if (this.pointerSwitched && readCurrentSideloadVersion() === target) {
        clearCurrentSideloadVersion()
        this.pointerSwitched = false
      }

      // 应用退出场景不再拉起进程 / 弹窗
      if (!this.disposed) {
        try {
          await this.supervisor.stop()
          await this.supervisor.start()
        } catch (restartErr) {
          logger.error(`更新失败后恢复旧版本异常：${errorMessage(restartErr)}`)
        }
        if (!cancelled) {
          void dialog.showMessageBox({
            type: 'warning',
            message: 'dsh 更新失败',
            detail: `${message}\n\n已保持旧版本可用。`
          })
        }
      }

      broadcastOpProgress({
        op: 'update',
        state: 'error',
        message: cancelled ? '更新已取消' : `更新失败：${message}`
      })
      this.emitStatus({ state: 'error', message: cancelled ? '更新已取消' : message })
      return { ok: false, message }
    } finally {
      this.applying = false
      this.applyAbort = null
    }
  }

  /** 启动成功：清零失败计数；侧载版本确认为 lastKnownGoodDsh */
  async noteBootSuccess(): Promise<void> {
    const patch: Partial<Preferences> = { bootFailCount: 0 }
    const sideload = readCurrentSideloadVersion()
    if (sideload && sideload === this.currentDshVersion()) {
      const prefs = await getPreferences()
      if (prefs.lastKnownGoodDsh !== sideload) {
        patch.lastKnownGoodDsh = sideload
      }
    }
    await savePreferencesMerge(patch)
  }

  /**
   * 启动失败：侧载运行时连续失败 2 次 → 删指针回退内嵌、清理问题版本、
   * 弹窗告知并自动以内嵌版本重启。内嵌运行时失败不触发回滚（由错误卡引导）。
   * 返回是否已触发回滚（调用方据此避免重复广播）。
   */
  async noteBootFailure(): Promise<boolean> {
    const sideload = readCurrentSideloadVersion()
    if (!sideload) {
      return false
    }
    const prefs = await getPreferences()
    const count = prefs.bootFailCount + 1
    if (count < 2) {
      await savePreferencesMerge({ bootFailCount: count })
      logger.warn(`侧载运行时启动失败 ${count}/2 次`)
      return false
    }

    logger.error(`侧载运行时连续启动失败 ${count} 次，自动回退内嵌版本`)
    clearCurrentSideloadVersion()
    await savePreferencesMerge({ bootFailCount: 0 })
    if (sideload !== prefs.lastKnownGoodDsh) {
      // 清理问题版本目录（lastKnownGood 版本保留作为回滚目标）
      try {
        rmSync(join(sideloadRoot(), sideload), { recursive: true, force: true })
      } catch {
        // 清理失败不影响回退
      }
    }

    if (!this.disposed) {
      void dialog.showMessageBox({
        type: 'warning',
        message: '已自动回退到内嵌版本',
        detail: `侧载的 dsh ${sideload} 连续启动失败，已切换回应用内嵌运行时。`
      })
      try {
        await this.supervisor.stop()
        await this.supervisor.start()
      } catch (err) {
        logger.error(`回退后重启异常：${errorMessage(err)}`)
      }
    }
    return true
  }

  /** 退出请求：取消进行中的更新（杀安装进程、回退未验证指针），不阻塞退出流程 */
  async cancelForQuit(): Promise<void> {
    if (!this.applying) {
      this.dispose()
      return
    }
    logger.info('退出请求：正在取消进行中的更新…')
    this.applyAbort?.abort()
    const deadline = Date.now() + 5_000
    while (this.applying && Date.now() < deadline) {
      await sleep(200)
    }
    if (this.applying) {
      // 兑底：更新流程未在期限内收敛（如停止序列卡死），强制复位，
      // 避免 before-quit 二次进入时被 updating 标志拖入死循环
      logger.error('取消更新超时，强制复位更新状态')
      this.applying = false
    }
    // 指针已切但未验证就绪：回退，保证下次启动用旧版本
    if (this.pointerSwitched) {
      clearCurrentSideloadVersion()
      this.pointerSwitched = false
    }
    this.applyAbort = null
    this.dispose()
  }

  /** 等待 supervisor 就绪（ready/error 双路出口 + 超时） */
  private waitForReady(timeoutMs: number): Promise<void> {
    if (this.supervisor.phase === 'ready') {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`新版本启动就绪超时（${timeoutMs / 1000}s）`))
      }, timeoutMs)
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const onError = (info: { message: string }): void => {
        cleanup()
        reject(new Error(info.message))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        this.supervisor.off('ready', onReady)
        this.supervisor.off('error', onError)
      }
      this.supervisor.once('ready', onReady)
      this.supervisor.once('error', onError)
    })
  }

  private emitStatus(
    patch: {
      state: UpdaterState
      checking?: boolean
      currentDsh?: string | null
      latestDsh?: string
      message?: string
    }
  ): void {
    const payload: UpdaterStatusPayload = {
      checking: patch.checking ?? false,
      currentDsh: patch.currentDsh ?? this.currentDshVersion(),
      latestDsh: patch.latestDsh,
      state: patch.state,
      message: patch.message
    }
    broadcastUpdaterStatus(payload)
    // 主进程内部订阅方（托盘）：异常不影响更新流程本身
    for (const listener of this.statusListeners) {
      try {
        listener(payload)
      } catch {
        // ignore
      }
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
