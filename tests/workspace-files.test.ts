import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGitPorcelainZ } from '../src/main/workspace-files'

/**
 * git status --porcelain -z 解析单测：
 * 普通变更 / 未跟踪 / 重命名（R + 旧路径 + NUL + 新路径）与容错。
 */

test('parseGitPorcelainZ：普通变更与未跟踪', () => {
  const out = 'M  src/main/index.ts\0A  new-file.md\0?? untracked.log\0'
  const changes = parseGitPorcelainZ(out)
  assert.deepEqual(changes, [
    { file: 'src/main/index.ts', code: 'M ' },
    { file: 'new-file.md', code: 'A ' },
    { file: 'untracked.log', code: '??' }
  ])
})

test('parseGitPorcelainZ：重命名条目取新路径', () => {
  const out = 'R  old-name.ts\0new-name.ts\0M  other.ts\0'
  const changes = parseGitPorcelainZ(out)
  assert.deepEqual(changes, [
    { file: 'new-name.ts', code: 'R ' },
    { file: 'other.ts', code: 'M ' }
  ])
})

test('parseGitPorcelainZ：空输出与畸形 token 容错', () => {
  assert.deepEqual(parseGitPorcelainZ(''), [])
  assert.deepEqual(parseGitPorcelainZ('ab\0'), [])
  assert.deepEqual(parseGitPorcelainZ('\0\0\0'), [])
})
