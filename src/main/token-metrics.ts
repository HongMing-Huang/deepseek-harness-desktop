/**
 * dsh 会话投影缓存（session_projcache.json）的解析与用量聚合：纯函数、零依赖，
 * 不 import Electron / Node API，便于单测（tests/token-metrics.test.ts）。
 *
 * 源文件顶层结构（以本机真实 schema 核对，测试一律使用合成数据）：
 *   { unit: { name, version }, global, tables: { sessions: { <sessionId>: { identity, rows } } } }
 * rows 为按行键索引的投影字典，本模块关心两行：
 *   - tokenUsage：{ ver, seq, val: { totals: { uncachedInputTokens, outputTokens,
 *     cacheReadTokens, cacheWriteTokens }, last: { …buckets } } }
 *   - contextPressure：{ ver, seq, val: { pressureTokens, contextWindow, surfaceTokens } }
 */

export interface TokenTotals {
  uncachedInput: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ContextSnapshot {
  pressureTokens: number
  contextWindow: number
  surfaceTokens: number
}

export interface TokenAggregate {
  totals: TokenTotals
  /** 最近活跃会话（seq 最大者）的上下文压力快照；无有效数据为 null */
  context: ContextSnapshot | null
  /** 聚合发生的时刻（ms epoch） */
  updatedAt: number
}

export const EMPTY_TOTALS: TokenTotals = {
  uncachedInput: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0
}

/** 会话总数（聚合的辅助口径：非空会话数） */
export interface ParseResult {
  aggregate: TokenAggregate
  /** 参与聚合的会话数量 */
  sessionCount: number
}

/**
 * 解析 projcache 原文并聚合用量：
 * - JSON 解析失败 → null；
 * - 顶层 unit.version 缺失（schema 不可识别 / 尚未初始化）→ null；
 * - tables.sessions 缺失或为空 → 合法空态（零聚合，sessionCount = 0）；
 * - 单个会话的行结构异常 → 跳过该会话，不影响整体。
 */
export function parseProjCache(raw: string, now: number = Date.now()): ParseResult | null {
  let root: unknown
  try {
    root = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(root)) return null

  // 结构守卫：必须能识别出 dsh 的 projcache 单元标识
  const unit = root['unit']
  if (!isRecord(unit) || typeof unit['version'] !== 'number' || typeof unit['name'] !== 'string') {
    return null
  }

  const tables = root['tables']
  const sessions = isRecord(tables) ? tables['sessions'] : null
  const totals: TokenTotals = { ...EMPTY_TOTALS }
  let sessionCount = 0
  let context: ContextSnapshot | null = null
  let contextSeq = -1

  if (isRecord(sessions)) {
    for (const session of Object.values(sessions)) {
      if (!isRecord(session)) continue
      const rows = session['rows']
      if (!isRecord(rows)) continue
      sessionCount += 1

      const usageRow = rows['tokenUsage']
      if (isRecord(usageRow) && isRecord(usageRow['val'])) {
        const t = usageRow['val']['totals']
        if (isRecord(t)) {
          totals.uncachedInput += toCount(t['uncachedInputTokens'])
          totals.output += toCount(t['outputTokens'])
          totals.cacheRead += toCount(t['cacheReadTokens'])
          totals.cacheWrite += toCount(t['cacheWriteTokens'])
        }
      }

      const pressureRow = rows['contextPressure']
      if (isRecord(pressureRow) && isRecord(pressureRow['val'])) {
        const seq = typeof pressureRow['seq'] === 'number' ? pressureRow['seq'] : 0
        if (seq >= contextSeq) {
          contextSeq = seq
          const v = pressureRow['val']
          context = {
            pressureTokens: toCount(v['pressureTokens']),
            contextWindow: toCount(v['contextWindow']),
            surfaceTokens: toCount(v['surfaceTokens'])
          }
        }
      }
    }
  }

  return { aggregate: { totals, context, updatedAt: now }, sessionCount }
}

/* ── 分钟差分采样 ── */

/** 历史样本点：t 为分钟桶起点（ms epoch），tokens 为该分钟的净增 token 数 */
export interface HistoryPoint {
  t: number
  tokens: number
}

/** 采样状态：基线总量（null = 尚未建立，首次读数只建基线不出样本） */
export interface SamplingState {
  baselineTotal: number | null
}

export const INITIAL_SAMPLING_STATE: SamplingState = { baselineTotal: null }

/** 当前总量口径：四桶之和 */
export function totalTokensOf(totals: TokenTotals): number {
  return totals.uncachedInput + totals.output + totals.cacheRead + totals.cacheWrite
}

/** 分钟桶起点（对齐到整分钟） */
export function minuteBucket(now: number): number {
  return Math.floor(now / 60_000) * 60_000
}

export interface SampleResult {
  /** 新历史（含新样本；未产生样本时与输入相同引用或等价数组） */
  history: HistoryPoint[]
  state: SamplingState
  /** 本次是否产生了增量（0 增量也算“已消化”） */
  sampled: boolean
}

/**
 * 分钟差分采样（纯函数）：
 * - 无基线（应用刚启动 / 历史重置）：只建基线，不出样本（避免把历史存量当增量）；
 * - 总量下降（会话清理 / 缓存失效）：重置基线，不出样本；
 * - 同一分钟桶：增量累加到最后一个点；跨桶：追加新点；
 * - 追加后执行 30 天裁剪。
 */
export function appendMinuteSample(
  history: HistoryPoint[],
  state: SamplingState,
  totalTokens: number,
  now: number
): SampleResult {
  if (state.baselineTotal === null) {
    return { history, state: { baselineTotal: totalTokens }, sampled: false }
  }

  const delta = totalTokens - state.baselineTotal
  if (delta <= 0) {
    // 存量回落或零增量：零增量不出点（空桶由图表自行补零），回落视为基线漂移静默重置
    const nextBaseline = delta < 0 ? totalTokens : state.baselineTotal
    return { history, state: { baselineTotal: nextBaseline }, sampled: false }
  }

  const bucket = minuteBucket(now)
  let next: HistoryPoint[]
  const last = history[history.length - 1]
  if (last !== undefined && last.t === bucket) {
    // 同桶合并：替换末点（保持纯度，不改输入数组）
    next = [...history.slice(0, -1), { t: bucket, tokens: last.tokens + delta }]
  } else {
    next = [...history, { t: bucket, tokens: delta }]
  }

  return {
    history: pruneHistory(next, now),
    state: { baselineTotal: totalTokens },
    sampled: true
  }
}

/** 历史保留窗口（30 天） */
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** 裁剪超期样本（返回新数组；均已按时间升序写入） */
export function pruneHistory(history: HistoryPoint[], now: number): HistoryPoint[] {
  const cutoff = now - HISTORY_RETENTION_MS
  let firstKept = 0
  while (firstKept < history.length && history[firstKept].t < cutoff) {
    firstKept++
  }
  return firstKept === 0 ? history : history.slice(firstKept)
}

/** 查询区间样本（rangeMs 向过去回溯） */
export function sliceHistory(history: HistoryPoint[], now: number, rangeMs: number): HistoryPoint[] {
  const cutoff = now - rangeMs
  return history.filter((p) => p.t >= cutoff)
}

/* ── 内部工具 ── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 计数字段：负数/非数按 0 处理（防止脏数据放大） */
function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}
