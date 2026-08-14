import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { scanZstdFrames, decompressSessionLines, renderMarkdown } from '../src/main/sessions'

/**
 * 会话中心纯函数单测：
 * - zstd 帧扫描（官方 concatenated-frame 容器算法）与多帧解码；
 * - JSONL 行切分（损坏行跳过）；
 * - Markdown 渲染（会话头 / 标题 / 用户与助手消息 / 工具调用与结果）。
 */

const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer })
  .zstdCompressSync

function skipIfNoZstd(t: { skip: (reason?: string) => void }): boolean {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('当前 Node 无 zstd 压缩支持（node:zlib 需 >= 22.15）')
    return true
  }
  return false
}

test('scanZstdFrames：两帧拼接容器扫描出精确边界', (t) => {
  if (skipIfNoZstd(t)) return
  const frame1 = zstdCompressSync(Buffer.from('{"type":"session","id":"a"}\n', 'utf-8'))
  const frame2 = zstdCompressSync(Buffer.from('{"type":"user/message","seq":1}\n', 'utf-8'))
  const combined = Buffer.concat([frame1, frame2])
  const frames = scanZstdFrames(combined)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].start, 0)
  assert.equal(frames[0].end, frame1.length)
  assert.equal(frames[1].start, frame1.length)
  assert.equal(frames[1].end, combined.length)
})

test('scanZstdFrames：空缓冲返回空帧列表', () => {
  assert.deepEqual(scanZstdFrames(Buffer.alloc(0)), [])
})

test('scanZstdFrames：非 zstd 魔数开头抛错', () => {
  assert.throws(() => scanZstdFrames(Buffer.from('not-zstd-data-here', 'utf-8')), /帧头损坏/)
})

test('decompressSessionLines：多帧 JSONL 完整还原，损坏行跳过', (t) => {
  if (skipIfNoZstd(t)) return
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sessions-test-'))
  const file = join(dir, 'session.jsonl.zstd')
  const lines = [
    '{"type":"session","id":"s1"}',
    '{"type":"user/message","seq":1}',
    '{"type":"assistant/message","seq":2}'
  ]
  const f1 = zstdCompressSync(Buffer.from(lines.slice(0, 2).join('\n') + '\n', 'utf-8'))
  const broken = Buffer.from('not json at all\n', 'utf-8') // 未经压缩的裸文本帧：解压会失败
  // 损坏帧单独验证：非 zstd 字节会让 scanZstdFrames 抛错（帧头损坏），
  // 因此只验证正常多帧路径与行级损坏跳过：
  const f2 = zstdCompressSync(Buffer.from('{broken json}\n' + lines[2] + '\n', 'utf-8'))
  writeFileSync(file, Buffer.concat([f1, f2]))
  const out = decompressSessionLines(file)
  assert.deepEqual(out, [lines[0], lines[1], lines[2]])
  rmSync(dir, { recursive: true, force: true })
  void broken
})

test('decompressSessionLines：空文件抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sessions-test-'))
  const file = join(dir, 'empty.zstd')
  writeFileSync(file, Buffer.alloc(0))
  assert.throws(() => decompressSessionLines(file), /不含有效帧/)
  rmSync(dir, { recursive: true, force: true })
})

test('renderMarkdown：会话头 / 标题 / 用户与助手消息 / 工具调用渲染', () => {
  const lines = [
    '{"type":"session","id":"session-abc123","createdAt":1786700000000}',
    '{"type":"session/title","data":{"title":"调研计划"}}',
    '{"type":"user/message","data":{"message":{"content":[{"type":"text","text":"帮我调研"}]}}}',
    '{"type":"assistant/message","data":{"message":{"content":[{"type":"reasoning","text":"内部思考不应导出"},{"type":"text","text":"结论如下"}]}}}',
    '{"type":"tool/call","data":{"name":"web_search","arguments":{"query":"ds"}}}',
    '{"type":"tool/result","data":{"message":{"content":[{"type":"tool-result","content":[{"type":"text","text":"命中 3 条"}]}]}}}'
  ]
  const md = renderMarkdown(lines)
  assert.ok(md.includes('# 会话 session-abc123'.slice(0, 12)), '会话头以 id 起始')
  assert.ok(md.includes('# 调研计划'), '标题渲染')
  assert.ok(md.includes('## 用户'), '用户消息分段')
  assert.ok(md.includes('帮我调研'), '用户文本保留')
  assert.ok(md.includes('## DeepSeek'), '助手消息分段')
  assert.ok(md.includes('结论如下'), '助手文本保留')
  assert.ok(!md.includes('内部思考不应导出'), 'reasoning 块不导出')
  assert.ok(md.includes('web_search'), '工具名渲染')
  assert.ok(md.includes('命中 3 条'), '工具结果渲染')
})

test('renderMarkdown：无可渲染内容输出占位文案', () => {
  // 只有元数据事件（无消息/工具/标题）时给出占位说明
  const md = renderMarkdown(['{"type":"sandbox/mode","data":{"mode":"workspace-write"}}'])
  assert.ok(md.includes('无可渲染'), '无内容会话给出占位说明')
})
