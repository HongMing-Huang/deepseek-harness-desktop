/**
 * pnpm 进度行解析与 chunk 切分的逻辑单测（纯函数，无 Electron 依赖）。
 * 运行：npx node --import tsx --test tests/
 *
 * 用例重点：可量化行给 percent，识别不到时返回 null 由调用方
 * 降级为"不确定进度"（state:'update' 不带 percent），确保 UI 永不卡死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parsePluginProgressLine, splitProgressChunk } from '../src/main/runtime/plugin-progress.ts'

/* ── parsePluginProgressLine：确定性进度 ── */

test('Progress 汇总行：按 resolved 为分母折算 90 以内进度', () => {
  const r = parsePluginProgressLine('Progress: resolved 34, reused 10, downloaded 2, added 12')
  assert.ok(r)
  assert.equal(r.percent, 37) // (2+12)/34*90 ≈ 37.1
  assert.equal(r.message, '解析 34 · 下载 2 · 新增 12')
})

test('Progress 汇总行：覆盖满也封顶 99（100% 留给 done 事件）', () => {
  const r = parsePluginProgressLine('Progress: resolved 10, reused 0, downloaded 5, added 5')
  assert.ok(r)
  assert.equal(r.percent, 90) // 10/10*90
})

test('Progress 汇总行：resolved 为 0 时不给 percent（无法量化）', () => {
  const r = parsePluginProgressLine('Progress: resolved 0, reused 0, downloaded 5, added 5')
  assert.ok(r)
  assert.equal(r.percent, undefined)
  assert.ok(r.message.length > 0)
})

test('Progress 汇总行：兼容行尾 \\r 与前后空白', () => {
  const r = parsePluginProgressLine('  Progress: resolved 8, reused 1, downloaded 2, added 2\r')
  assert.ok(r)
  assert.equal(r.percent, 45) // (2+2)/8*90
})

/* ── parsePluginProgressLine：无 percent 的可识别行 ── */

test('Packages 计数行：新增/移除文案，不带 percent', () => {
  const add = parsePluginProgressLine('Packages: +12')
  assert.ok(add)
  assert.equal(add.percent, undefined)
  assert.equal(add.message, '即将新增 12 个包')

  const remove = parsePluginProgressLine('Packages: -3')
  assert.ok(remove)
  assert.equal(remove.message, '即将移除 3 个包')
})

test('下载完成行：提取包名与体积', () => {
  const r = parsePluginProgressLine('.../dsh-tool-git@0.1.2 12.4 kB 1.2s')
  assert.ok(r)
  assert.equal(r.percent, undefined)
  assert.equal(r.message, '已获取 dsh-tool-git@0.1.2（12.4kB）')
})

/* ── parsePluginProgressLine：百分比行 ── */

test('单一百分比行：透传 percent 与原文', () => {
  const r = parsePluginProgressLine('Resolving: 45%')
  assert.ok(r)
  assert.equal(r.percent, 45)
  assert.ok(r.message.includes('45%'))
})

test('多阶段百分比行：取最后一个百分数', () => {
  const r = parsePluginProgressLine('Downloading 10% extracting 80%')
  assert.ok(r)
  assert.equal(r.percent, 80)
})

/* ── parsePluginProgressLine：降级路径 ── */

test('不识别的行 → null（调用方降级为不确定进度）', () => {
  assert.equal(parsePluginProgressLine('Nothing to do here'), null)
  assert.equal(parsePluginProgressLine(''), null)
  assert.equal(parsePluginProgressLine('   \r  '), null)
})

test('超范围百分数被过滤：无法量化 → null', () => {
  // 150% 超出 0-100 被丢弃，且无其它可识别形态
  assert.equal(parsePluginProgressLine('garbled 150%'), null)
})

/* ── splitProgressChunk：行切分与残尾 ── */

test('按 \\n / \\r\\n / \\r 混合切分，残尾保留', () => {
  assert.deepEqual(splitProgressChunk('a\nb\nc'), { lines: ['a', 'b'], rest: 'c' })
  assert.deepEqual(splitProgressChunk('a\r\nb'), { lines: ['a'], rest: 'b' })
  assert.deepEqual(splitProgressChunk('a\rb\rc'), { lines: ['a', 'b'], rest: 'c' })
  assert.deepEqual(splitProgressChunk(''), { lines: [], rest: '' })
  assert.deepEqual(splitProgressChunk('no-terminator'), { lines: [], rest: 'no-terminator' })
})

test('残尾与下一段拼接后恢复完整行（流式语义）', () => {
  const first = splitProgressChunk('Progress: res')
  const second = splitProgressChunk(first.rest + 'olved 4, reused 0, downloaded 2, added 1\n')
  // 第二段切出完整行后应可解析
  assert.deepEqual(second.lines, ['Progress: resolved 4, reused 0, downloaded 2, added 1'])
  const parsed = parsePluginProgressLine(second.lines[0] ?? '')
  assert.ok(parsed)
  assert.equal(parsed.percent, 68) // (2+1)/4*90 = 67.5 → round 半数向上
})
