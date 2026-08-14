/**
 * 托盘通知去重器与状态文案的逻辑单测（纯函数，无 Electron 依赖）。
 * 运行：npx node --import tsx --test tests/
 *
 * 用例重点：同 key 60s 内不重复放行、被拒绝的事件不推进时间戳、
 * 不同 key 互不影响、状态对象不可变、托盘状态文案优先级。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NOTIFICATION_DEDUPE_WINDOW_MS,
  createNotificationGate,
  decideNotification,
  trayStatusText
} from '../src/main/notify-gate.ts'

/* ── decideNotification：纯函数去重判定 ── */

test('首次事件放行，并记录时间戳', () => {
  const state = { lastEmittedAt: {} }
  const r = decideNotification(state, 'runtime-error', 1_000)
  assert.equal(r.emit, true)
  assert.equal(r.state.lastEmittedAt['runtime-error'], 1_000)
})

test('同一 key 在窗口内被拒绝（恰好差 1ms 也拒绝）', () => {
  const state = { lastEmittedAt: { 'runtime-error': 1_000 } }
  const inside = decideNotification(state, 'runtime-error', 1_000 + NOTIFICATION_DEDUPE_WINDOW_MS - 1)
  assert.equal(inside.emit, false)
})

test('同一 key 超出窗口后再次放行（含边界时刻）', () => {
  const state = { lastEmittedAt: { 'runtime-error': 1_000 } }
  const edge = decideNotification(state, 'runtime-error', 1_000 + NOTIFICATION_DEDUPE_WINDOW_MS)
  assert.equal(edge.emit, true)
  assert.equal(edge.state.lastEmittedAt['runtime-error'], 1_000 + NOTIFICATION_DEDUPE_WINDOW_MS)
})

test('被拒绝的事件不推进时间戳（重复失败不会无限续期去重窗口）', () => {
  let state = { lastEmittedAt: { 'runtime-error': 1_000 } }
  // 窗口内多次失败重试
  state = decideNotification(state, 'runtime-error', 5_000).state
  state = decideNotification(state, 'runtime-error', 30_000).state
  assert.equal(state.lastEmittedAt['runtime-error'], 1_000)
  // 仍以首次放行时刻计算窗口：60_001 时刻可再次放行
  const r = decideNotification(state, 'runtime-error', 61_000)
  assert.equal(r.emit, true)
})

test('不同 key 互不影响（启动失败与新版本通知独立去重）', () => {
  const state = { lastEmittedAt: { 'runtime-error': 1_000 } }
  const r = decideNotification(state, 'update-available:0.2.0', 2_000)
  assert.equal(r.emit, true)
  assert.equal(r.state.lastEmittedAt['runtime-error'], 1_000)
  assert.equal(r.state.lastEmittedAt['update-available:0.2.0'], 2_000)
})

test('同类型不同版本的更新通知可先后放行', () => {
  let state = { lastEmittedAt: { 'update-available:0.2.0': 1_000 } }
  state = decideNotification(state, 'update-available:0.3.0', 2_000).state
  const again = decideNotification(state, 'update-available:0.2.0', 3_000)
  assert.equal(again.emit, false)
})

test('纯函数：不修改入参状态（返回新对象）', () => {
  const state = { lastEmittedAt: { a: 1 } }
  decideNotification(state, 'b', 2)
  assert.deepEqual(state.lastEmittedAt, { a: 1 })
})

/* ── createNotificationGate：可变门（可注入时钟） ── */

test('可变门：同 key 序列按窗口放行/拒绝', () => {
  let now = 10_000
  const gate = createNotificationGate(() => now)
  assert.equal(gate.shouldEmit('plugin-install:foo'), true)
  now += 1_000
  assert.equal(gate.shouldEmit('plugin-install:foo'), false)
  now += NOTIFICATION_DEDUPE_WINDOW_MS
  assert.equal(gate.shouldEmit('plugin-install:foo'), true)
})

test('可变门：并发锁拒绝类消息由调用方过滤（门只管 key 与时间）', () => {
  let now = 0
  const gate = createNotificationGate(() => now)
  assert.equal(gate.shouldEmit('k'), true)
  now = 1
  assert.equal(gate.shouldEmit('k'), false)
  assert.equal(gate.shouldEmit('other'), true)
})

/* ── trayStatusText：托盘 tooltip 文案优先级 ── */

test('更新中优先级最高（即便运行时就绪）', () => {
  assert.equal(trayStatusText('ready', true), '更新中')
  assert.equal(trayStatusText('error', true), '更新中')
})

test('运行时各阶段映射到对应文案', () => {
  assert.equal(trayStatusText('starting', false), '启动中')
  assert.equal(trayStatusText('ready', false), '运行中')
  assert.equal(trayStatusText('error', false), '出错')
  assert.equal(trayStatusText('stopped', false), '已停止')
})

test('未知阶段（null）默认启动中', () => {
  assert.equal(trayStatusText(null, false), '启动中')
})
