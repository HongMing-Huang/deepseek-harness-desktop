import test from 'node:test'
import assert from 'node:assert/strict'
import { PARSE_FAILURE_LIMIT, parseFailureAction } from '../src/main/token-pipeline'

/**
 * 解析失败停用策略验证（对应评审修复：瞬态异常不再永久停用）：
 * - 单次（及少数几次）解析失败视为瞬态（半写文件），保持监听；
 * - 连续达到阈值才判定 schema 漂移 / 持久损坏并停用。
 */

test('PARSE_FAILURE_LIMIT：阈值为 5（连续 5 次失败停用）', () => {
  assert.equal(PARSE_FAILURE_LIMIT, 5)
})

test('parseFailureAction：阈值内保持监听（瞬态失败）', () => {
  for (let failures = 1; failures < PARSE_FAILURE_LIMIT; failures++) {
    assert.equal(
      parseFailureAction(failures),
      'keep-watching',
      `连续 ${failures} 次失败应保持监听`
    )
  }
})

test('parseFailureAction：达到与超过阈值判定停用（持久损坏）', () => {
  assert.equal(parseFailureAction(PARSE_FAILURE_LIMIT), 'disable')
  assert.equal(parseFailureAction(PARSE_FAILURE_LIMIT + 3), 'disable')
})

test('parseFailureAction：零次失败（成功后清零状态）保持监听', () => {
  assert.equal(parseFailureAction(0), 'keep-watching')
})
