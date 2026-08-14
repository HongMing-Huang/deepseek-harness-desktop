import test from 'node:test'
import assert from 'node:assert/strict'
import { isDshOccupant } from '../src/main/runtime/port-doctor'

/**
 * 端口占用者判定验证（对应评审修复：PID 复用误杀）：
 * 命令行包含 dsh bin.js 完整路径是允许终止的唯一强证据；
 * pid 命中残留 pid 文件仅为弱线索（由调用方日志提示），不得进入本判定。
 */

const DSH_BIN = '/opt/runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

test('isDshOccupant：dsh web 启动形态的命令行判定为可终止', () => {
  const command = `/opt/runtimes/node/arm64/node ${DSH_BIN} web --port 3080`
  assert.equal(isDshOccupant(command, DSH_BIN), true)
})

test('isDshOccupant：无关进程命令行判定为不可终止', () => {
  assert.equal(isDshOccupant('/usr/local/bin/python3 -m http.server 3080', DSH_BIN), false)
  assert.equal(isDshOccupant('/Applications/SomeApp.app/Contents/MacOS/SomeApp', DSH_BIN), false)
  // 路径前缀相似但不完整（不含完整 bin.js 路径）
  assert.equal(isDshOccupant('/opt/runtimes/node/arm64/node /tmp/other-bin.js', DSH_BIN), false)
})

test('isDshOccupant：空命令行或空 dshBin 一律不可终止（防御）', () => {
  assert.equal(isDshOccupant('', DSH_BIN), false)
  assert.equal(isDshOccupant(DSH_BIN, ''), false)
  assert.equal(isDshOccupant('', ''), false)
})

test('isDshOccupant：pid 复用场景（命令行不含 dsh bin）绝不放行', () => {
  // pid 恰好命中残留 pid 文件、但该 pid 已被无关进程复用的典型形态：
  // 命令行与 dsh 毫无关系 → 即使调用方拿到 pid 弱线索也不允许终止
  const reusedProcessCommand = '/Applications/Safari.app/Contents/MacOS/Safari'
  assert.equal(isDshOccupant(reusedProcessCommand, DSH_BIN), false)
})
