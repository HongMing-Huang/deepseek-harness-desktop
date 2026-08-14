import { watch, type FSWatcher } from 'node:fs'
import { stat, readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { powerMonitor } from 'electron'
import { logger } from './logger'
import {
  appendMinuteSample,
  parseProjCache,
  sliceHistory,
  totalTokensOf,
  type HistoryPoint,
  type SamplingState,
  type TokenAggregate
} from './token-metrics'

/**
 * Token 用量管道：监听 dsh 的 session_projcache.json → 解析聚合 → 分钟差分采样
 * 落盘 userData/token-history.json → 节流广播 TokenSample 给活动侧栏。
 *
 * 生命周期：supervisor ready 后 start()，exit 后 stop()；
 * powerMonitor suspend 暂停 watch，resume 恢复并立即读一次。
 *
 * 健壮性纪律：
 * - storages 目录可能尚不存在：先 watch 其父目录（DSH_HOME）等创建事件，出现后切换；
 * - DSH_HOME 也不存在等挂载失败：定时重试（默认每 2s，最多 5 分钟），窗口耗尽才停用；
 * - 解析异常（坏 JSON / schema 不可识别）连续达到阈值才停用，单次失败保持监听
 *   （半写文件是瞬态的）；停用后 UI 显示占位，绝不报错弹窗；
 * - history 采用 临时文件 + rename 原子写，读取失败从空历史开始。
 */

export interface TokenSamplePayload {
  /** 管道是否仍在产出数据（停用时 UI 显示占位） */
  active: boolean
  aggregate: TokenAggregate | null
  /** 最近 24h 分钟样本（供侧栏即时绘图） */
  recent: HistoryPoint[]
}

export interface TokenPipelineOptions {
  /** projcache 文件绝对路径 */
  projCachePath: string
  /** 采样历史落盘路径（userData/token-history.json） */
  historyPath: string
  /** 采样广播回调（由 index.ts 接到 ipc 广播） */
  onSample: (payload: TokenSamplePayload) => void
}

const DEBOUNCE_MS = 500
const BROADCAST_THROTTLE_MS = 1_000
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
/** watch 挂载失败重试间隔（DSH_HOME 尚未创建等瞬态场景） */
const WATCH_RETRY_INTERVAL_MS = 2_000
/** watch 挂载重试窗口：窗口耗尽仍失败才停用管道 */
const WATCH_RETRY_WINDOW_MS = 5 * 60 * 1000

/** 连续解析失败达到该阈值才停用（单次失败保持监听：半写/坏块文件是瞬态的） */
export const PARSE_FAILURE_LIMIT = 5

/**
 * 解析失败后的动作：连续失败不足阈值保持监听（瞬态坏文件），
 * 达到阈值才停用（schema 漂移 / 持久损坏）。
 */
export function parseFailureAction(consecutiveFailures: number): 'keep-watching' | 'disable' {
  return consecutiveFailures >= PARSE_FAILURE_LIMIT ? 'disable' : 'keep-watching'
}

export class TokenPipeline {
  private readonly opts: TokenPipelineOptions
  private running = false
  private suspended = false
  private disabled = false
  private warnedOnce = false

  private watcher: FSWatcher | null = null
  /** storages 尚不存在时，暂挂 DSH_HOME 层级的 watcher */
  private bootstrapWatcher: FSWatcher | null = null

  private debounceTimer: NodeJS.Timeout | null = null
  private broadcastTimer: NodeJS.Timeout | null = null
  /** watch 挂载失败的重试定时器 */
  private retryTimer: NodeJS.Timeout | null = null
  /** 本次重试窗口的截止时间（0 = 尚无进行中的重试序列） */
  private attachAttemptDeadline = 0
  /** 连续解析失败计数（成功后清零） */
  private parseFailures = 0
  private lastMtimeMs = 0

  private history: HistoryPoint[] = []
  private sampling: SamplingState = { baselineTotal: null }
  private aggregate: TokenAggregate | null = null

  constructor(opts: TokenPipelineOptions) {
    this.opts = opts
  }

  /** 启动管道：读历史 → 立即采样一次 → 挂 watch */
  start(): void {
    if (this.running || this.disabled) return
    this.running = true
    this.suspended = false
    void this.loadHistory()
    void this.sampleNow()
    this.attachWatcher()
    powerMonitor.on('suspend', this.handleSuspend)
    powerMonitor.on('resume', this.handleResume)
    logger.info('Token 用量管道已启动')
  }

  /** 停止管道（supervisor exit / 应用退出） */
  stop(): void {
    this.running = false
    this.detachWatcher()
    this.clearTimers()
    powerMonitor.off('suspend', this.handleSuspend)
    powerMonitor.off('resume', this.handleResume)
    logger.info('Token 用量管道已停止')
  }

  /** 区间样本查询（TokenGetSeries） */
  getSeries(rangeMs: number): HistoryPoint[] {
    return sliceHistory(this.history, Date.now(), rangeMs)
  }

  /** 管道当前是否可用（未停用且已启动） */
  get available(): boolean {
    return this.running && !this.disabled
  }

  /** 当前最近样本快照（广播用） */
  private payload(active: boolean): TokenSamplePayload {
    return {
      active,
      aggregate: this.aggregate,
      recent: sliceHistory(this.history, Date.now(), RECENT_WINDOW_MS)
    }
  }

  /* ── watch 布线 ── */

  private attachWatcher(): void {
    this.detachWatcher()
    const storageDir = dirname(this.opts.projCachePath)
    try {
      this.watcher = watch(storageDir, { persistent: false }, () => this.scheduleRead())
      // 挂载成功：重置重试窗口
      this.attachAttemptDeadline = 0
    } catch {
      // storages 尚不存在：挂 DSH_HOME 层级，等目录创建事件
      const homeDir = dirname(storageDir)
      try {
        this.bootstrapWatcher = watch(homeDir, { persistent: false }, (event, filename) => {
          if (event === 'rename' && (filename === 'storages' || filename === '')) {
            // 目标目录可能已出现：切换到正式 watcher
            this.attachWatcher()
            if (this.watcher) {
              this.bootstrapWatcher?.close()
              this.bootstrapWatcher = null
              this.scheduleRead()
            }
          }
        })
      } catch (err) {
        // DSH_HOME 也无法监听（目录未创建等瞬态场景）：定时重试而非永久停用
        this.scheduleWatchRetry(`无法监听 DSH_HOME（${homeDir}）：${errorMessage(err)}`)
      }
    }
  }

  /** watch 挂载失败定时重试：窗口内反复尝试，窗口耗尽才停用管道 */
  private scheduleWatchRetry(reason: string): void {
    if (!this.running || this.disabled) return
    if (this.attachAttemptDeadline === 0) {
      this.attachAttemptDeadline = Date.now() + WATCH_RETRY_WINDOW_MS
    }
    if (Date.now() >= this.attachAttemptDeadline) {
      this.disableOnce(
        `${reason}，且重试窗口（${WATCH_RETRY_WINDOW_MS / 1000 / 60} 分钟）已耗尽，Token 管道停用`
      )
      return
    }
    logger.warn(`${reason}，${WATCH_RETRY_INTERVAL_MS / 1000}s 后重试挂载监听`)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.attachWatcher()
    }, WATCH_RETRY_INTERVAL_MS)
  }

  private detachWatcher(): void {
    this.watcher?.close()
    this.watcher = null
    this.bootstrapWatcher?.close()
    this.bootstrapWatcher = null
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /* ── 电源事件 ── */

  private handleSuspend = (): void => {
    if (!this.running) return
    this.suspended = true
    this.detachWatcher()
    this.clearTimers()
    logger.info('系统休眠：Token 管道暂停监听')
  }

  private handleResume = (): void => {
    if (!this.running || this.disabled) return
    this.suspended = false
    this.lastMtimeMs = 0 // 强制视为变更，恢复后立即读一次
    this.attachWatcher()
    void this.sampleNow()
    logger.info('系统唤醒：Token 管道恢复监听')
  }

  /* ── 采样链路 ── */

  /** mtime + 500ms 防抖读取 */
  private scheduleRead(): void {
    if (!this.running || this.disabled || this.suspended) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.sampleNow()
    }, DEBOUNCE_MS)
  }

  private async sampleNow(): Promise<void> {
    if (!this.running || this.disabled || this.suspended) return

    // mtime 比对：多个 watch 事件合并到同一次变更时避免重复解析
    try {
      const st = await stat(this.opts.projCachePath)
      if (st.mtimeMs === this.lastMtimeMs) return
      this.lastMtimeMs = st.mtimeMs
    } catch {
      // 文件尚不存在：正常等待态（dsh 尚未创建），静默保留监听
      return
    }

    let raw: string
    try {
      raw = await readFile(this.opts.projCachePath, 'utf-8')
    } catch {
      return
    }

    const result = parseProjCache(raw)
    if (result === null) {
      // 单次解析失败视为瞬态（半写文件）：保持监听等下次变更；
      // 连续达到阈值才判定 schema 漂移 / 持久损坏并停用
      this.parseFailures += 1
      if (parseFailureAction(this.parseFailures) === 'disable') {
        this.disableOnce(
          `session_projcache 连续 ${this.parseFailures} 次解析失败（schema 漂移或坏 JSON），Token 管道停用`
        )
        this.opts.onSample(this.payload(false))
      } else {
        logger.warn(
          `session_projcache 解析失败（连续 ${this.parseFailures}/${PARSE_FAILURE_LIMIT} 次），保持监听`
        )
      }
      return
    }
    this.parseFailures = 0

    this.aggregate = result.aggregate
    const total = totalTokensOf(result.aggregate.totals)
    const sample = appendMinuteSample(this.history, this.sampling, total, Date.now())
    this.sampling = sample.state
    this.history = sample.history
    if (sample.sampled) {
      await this.persistHistory()
    }
    this.throttledBroadcast()
  }

  /** 数据更新后 1s 节流广播（末次触发后必然补发一次） */
  private throttledBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.opts.onSample(this.payload(this.available))
    }, BROADCAST_THROTTLE_MS)
  }

  /* ── history 落盘 ── */

  private async loadHistory(): Promise<void> {
    try {
      const raw = await readFile(this.opts.historyPath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        this.history = parsed.filter(
          (p): p is HistoryPoint =>
            typeof p === 'object' &&
            p !== null &&
            typeof (p as HistoryPoint).t === 'number' &&
            typeof (p as HistoryPoint).tokens === 'number'
        )
      }
    } catch {
      this.history = []
    }
  }

  /** 临时文件 + rename 原子写 */
  private async persistHistory(): Promise<void> {
    try {
      const file = this.opts.historyPath
      await mkdir(dirname(file), { recursive: true })
      const tmp = join(dirname(file), `.token-history.tmp`)
      await writeFile(tmp, JSON.stringify(this.history), 'utf-8')
      await rename(tmp, file)
    } catch (err) {
      logger.warn(`Token 历史写入失败：${errorMessage(err)}`)
    }
  }

  /** 静默停用：只 warn 一次，后续不再解析 */
  private disableOnce(reason: string): void {
    if (this.disabled) return
    this.disabled = true
    if (!this.warnedOnce) {
      logger.warn(reason)
      this.warnedOnce = true
    }
    this.detachWatcher()
    this.clearTimers()
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
