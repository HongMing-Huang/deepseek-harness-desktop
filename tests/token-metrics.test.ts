/**
 * projcache 解析与分钟差分采样的逻辑单测（纯函数，无 Electron 依赖）。
 * 运行：npx node --import tsx --test tests/
 *
 * 隐私纪律：所有数据均为合成构造（假 session id、编造数值），
 * 严禁复制本机真实 ~/.dsh/storages/session_projcache.json 内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseProjCache,
  appendMinuteSample,
  pruneHistory,
  sliceHistory,
  totalTokensOf,
  minuteBucket,
  INITIAL_SAMPLING_STATE,
  HISTORY_RETENTION_MS,
  type HistoryPoint,
  type SamplingState,
  type TokenTotals
} from '../src/main/token-metrics.ts'

/* ── 合成数据构造 ── */

/** 伪造一个 projcache 原文：结构与真实 schema 同形，数值全部编造 */
function fakeCache(sessions: Record<string, unknown>, unit?: { name: string; version: number } | null): string {
  return JSON.stringify({
    unit: unit === undefined ? { name: 'session_projcache', version: 1 } : unit,
    global: {},
    tables: { sessions }
  })
}

interface FakeUsage {
  uncached?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

/** 伪造单个会话：rows 为按行键索引的投影字典（真实 schema 同形） */
function fakeSession(usage: FakeUsage, pressureSeq?: number): Record<string, unknown> {
  const rows: Record<string, unknown> = {
    tokenUsage: {
      ver: 1,
      seq: 1,
      val: {
        totals: {
          uncachedInputTokens: usage.uncached ?? 0,
          outputTokens: usage.output ?? 0,
          cacheReadTokens: usage.cacheRead ?? 0,
          cacheWriteTokens: usage.cacheWrite ?? 0
        }
      }
    }
  }
  if (pressureSeq !== undefined) {
    rows['contextPressure'] = {
      ver: 1,
      seq: pressureSeq,
      val: { pressureTokens: 12_000, contextWindow: 128_000, surfaceTokens: 15_000 }
    }
  }
  return { identity: { id: 'fake-session' }, rows }
}

const MIN = 60_000
const DAY = 24 * 60 * MIN

/* ── parseProjCache ── */

test('正常解析：多会话四桶求和、context 取 seq 最大者', () => {
  const raw = fakeCache({
    'fake-a': fakeSession({ uncached: 100, output: 200, cacheRead: 300, cacheWrite: 400 }, 5),
    'fake-b': fakeSession({ uncached: 1_000, output: 2_000, cacheRead: 3_000, cacheWrite: 4_000 }, 3)
  })
  const now = 1_700_000_000_000
  const result = parseProjCache(raw, now)
  assert.ok(result, '合法结构应解析成功')
  assert.equal(result.sessionCount, 2)
  assert.equal(result.aggregate.updatedAt, now)
  assert.deepEqual(result.aggregate.totals, {
    uncachedInput: 1_100,
    output: 2_200,
    cacheRead: 3_300,
    cacheWrite: 4_400
  })
  // seq 5 > 3：上下文压力应取 fake-a 的快照
  assert.deepEqual(result.aggregate.context, {
    pressureTokens: 12_000,
    contextWindow: 128_000,
    surfaceTokens: 15_000
  })
})

test('缺 unit.version：schema 不可识别 → null', () => {
  // unit 为空对象（version/name 均缺）
  assert.equal(parseProjCache(fakeCache({}, null)), null)
  // version 类型错误（字符串）：手工构造绕过 fakeCache 的类型约束
  assert.equal(
    parseProjCache(JSON.stringify({ unit: { name: 'session_projcache', version: '1' }, tables: {} })),
    null
  )
  // name 缺失（仅 version）：同样不可识别
  assert.equal(parseProjCache(JSON.stringify({ unit: { version: 1 }, tables: {} })), null)
})

test('坏 JSON / 非对象顶层 → null', () => {
  assert.equal(parseProjCache('{"broken": '), null)
  assert.equal(parseProjCache('null'), null)
  assert.equal(parseProjCache('"just a string"'), null)
})

test('空 sessions：合法空态（零聚合、sessionCount=0、context=null）', () => {
  for (const raw of [fakeCache({}), JSON.stringify({ unit: { name: 'session_projcache', version: 2 }, global: {} })]) {
    const result = parseProjCache(raw)
    assert.ok(result, '空 sessions 应是合法空态')
    assert.equal(result.sessionCount, 0)
    assert.deepEqual(result.aggregate.totals, { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(result.aggregate.context, null)
  }
})

test('脏数据防护：负数/非数按 0，坏行跳过不炸整体', () => {
  const raw = JSON.stringify({
    unit: { name: 'session_projcache', version: 1 },
    tables: {
      sessions: {
        'fake-dirty': {
          identity: {},
          rows: {
            tokenUsage: {
              ver: 1,
              seq: 1,
              val: { totals: { uncachedInputTokens: -50, outputTokens: 'x', cacheReadTokens: 7, cacheWriteTokens: Number.NaN } }
            }
          }
        },
        'fake-no-rows': { identity: {} },
        'fake-ok': fakeSession({ uncached: 10 }, 1)
      }
    }
  })
  const result = parseProjCache(raw)
  assert.ok(result)
  // 负数/字符串/NaN 均按 0，仅 7 + 10 计入
  assert.deepEqual(result.aggregate.totals, { uncachedInput: 10, output: 0, cacheRead: 7, cacheWrite: 0 })
  // rows 缺失的会话不参与计数
  assert.equal(result.sessionCount, 2)
})

/* ── appendMinuteSample：分钟差分采样 ── */

test('首次读数：只建基线不出样本', () => {
  const history: HistoryPoint[] = []
  const r = appendMinuteSample(history, INITIAL_SAMPLING_STATE, 5_000, 1_000_000)
  assert.equal(r.sampled, false)
  assert.deepEqual(r.state, { baselineTotal: 5_000 })
  assert.equal(r.history.length, 0)
})

test('正增量：按分钟桶追加样本点', () => {
  const t0 = 1_000_000_000
  const r = appendMinuteSample([], { baselineTotal: 1_000 }, 1_500, t0)
  assert.equal(r.sampled, true)
  assert.deepEqual(r.history, [{ t: minuteBucket(t0), tokens: 500 }])
  assert.deepEqual(r.state, { baselineTotal: 1_500 })
})

test('同一分钟桶：增量合并到末点（纯度：不改输入数组）', () => {
  const t0 = 1_000_000_000
  let r = appendMinuteSample([], { baselineTotal: 1_000 }, 1_500, t0)
  r = appendMinuteSample(r.history, r.state, 1_700, t0 + 10_000)
  assert.deepEqual(r.history, [{ t: minuteBucket(t0), tokens: 700 }])
})

test('跨分钟桶：追加新点', () => {
  const t0 = 1_000_000_000
  let r = appendMinuteSample([], { baselineTotal: 1_000 }, 1_500, t0)
  r = appendMinuteSample(r.history, r.state, 1_800, t0 + MIN + 5_000)
  assert.equal(r.history.length, 2)
  assert.deepEqual(r.history[1], { t: minuteBucket(t0 + MIN + 5_000), tokens: 300 })
})

test('零增量不出点、回落重置基线', () => {
  const t0 = 1_000_000_000
  let r = appendMinuteSample([], { baselineTotal: 1_000 }, 1_500, t0)
  const snapshot = r.history

  // 零增量：不出点、基线保持
  r = appendMinuteSample(r.history, r.state, 1_500, t0 + 1_000)
  assert.equal(r.sampled, false)
  assert.equal(r.history, snapshot, '零增量返回原引用')
  assert.deepEqual(r.state, { baselineTotal: 1_500 })

  // 回落（会话清理）：不出点、基线重置到新总量
  r = appendMinuteSample(r.history, r.state, 900, t0 + 2_000)
  assert.equal(r.sampled, false)
  assert.deepEqual(r.state, { baselineTotal: 900 })
  assert.equal(r.history.length, 1)
})

/* ── 30 天裁剪与区间查询 ── */

test('pruneHistory：30 天窗口外的样本被裁掉、边界保留', () => {
  const now = 10 * DAY
  const history: HistoryPoint[] = [
    { t: now - 31 * DAY, tokens: 1 }, // 超期 → 裁
    { t: now - 30 * DAY, tokens: 2 }, // 恰在边界（>= cutoff）→ 留
    { t: now - 29 * DAY, tokens: 3 }, // 留
    { t: now, tokens: 4 }
  ]
  assert.deepEqual(pruneHistory(history, now), history.slice(1))
  assert.equal(HISTORY_RETENTION_MS, 30 * DAY)
})

test('appendMinuteSample 追加后顺带裁剪超期样本', () => {
  const now = 100 * DAY
  const stale: HistoryPoint[] = [{ t: now - 40 * DAY, tokens: 999 }]
  const r = appendMinuteSample(stale, { baselineTotal: 100 }, 200, now)
  assert.equal(r.sampled, true)
  assert.deepEqual(r.history, [{ t: minuteBucket(now), tokens: 100 }], '40 天前的遗留点应被裁掉')
})

test('sliceHistory：按 rangeMs 过滤区间样本', () => {
  const now = 10 * DAY
  const history: HistoryPoint[] = [
    { t: now - 2 * DAY, tokens: 1 },
    { t: now - 30 * MIN, tokens: 2 },
    { t: now, tokens: 3 }
  ]
  assert.deepEqual(sliceHistory(history, now, 60 * MIN), history.slice(1))
  assert.deepEqual(sliceHistory(history, now, DAY), history.slice(1))
})

/* ── 辅助口径 ── */

test('totalTokensOf / minuteBucket 基础行为', () => {
  const totals: TokenTotals = { uncachedInput: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
  assert.equal(totalTokensOf(totals), 10)
  assert.equal(minuteBucket(61_000), 60_000)
  assert.equal(minuteBucket(119_999), 60_000)
})

test('采样状态流转：连续三次读数累计口径正确', () => {
  const t0 = 2_000_000_000
  let state: SamplingState = INITIAL_SAMPLING_STATE
  let history: HistoryPoint[] = []
  // 首读建基线
  let r = appendMinuteSample(history, state, 100, t0)
  state = r.state
  history = r.history
  // +50（桶 A）→ +30（桶 A）→ +80（桶 B）
  r = appendMinuteSample(history, state, 150, t0 + 5_000)
  state = r.state
  history = r.history
  r = appendMinuteSample(history, state, 180, t0 + 20_000)
  state = r.state
  history = r.history
  r = appendMinuteSample(history, state, 260, t0 + MIN + 3_000)
  history = r.history
  assert.deepEqual(history, [
    { t: minuteBucket(t0), tokens: 80 },
    { t: minuteBucket(t0 + MIN + 3_000), tokens: 80 }
  ])
})
