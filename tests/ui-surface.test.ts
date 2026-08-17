import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')

function source(path: string): string {
  return readFileSync(join(root, path), 'utf-8')
}

test('主窗口不注入自定义工具栏，官方 Web 占满内容区', () => {
  const windows = source('src/main/windows.ts')
  assert.doesNotMatch(windows, /toolbarView/)
  assert.doesNotMatch(windows, /TOOLBAR_HEIGHT/)
  assert.match(windows, /dshWebView\.setBounds\(\{ x: 0, y: 0, width, height \}\)/)
})

test('业务界面只由官方 Web 承载，不保留会话、插件或设置独立窗口', () => {
  const windows = source('src/main/windows.ts')
  const tray = source('src/main/tray.ts')
  assert.doesNotMatch(windows, /openSettingsWindow/)
  assert.doesNotMatch(windows, /settings\.html/)
  assert.doesNotMatch(windows, /openSessionsWindow/)
  assert.doesNotMatch(windows, /openPluginsWindow/)
  assert.doesNotMatch(windows, /会话中心/)
  assert.doesNotMatch(windows, /插件…/)
  assert.doesNotMatch(tray, /插件市场/)
  assert.doesNotMatch(tray, /label: '设置'/)
  assert.doesNotMatch(tray, /label: '检查更新'/)
})

test('插件市场作为官方插件设置 slot 扩展，并只使用官方设计 token', () => {
  const extension = source('extensions/official-web/lib/client.js')
  const manifest = source('extensions/official-web/package.json')
  assert.match(manifest, /"dsh"/)
  assert.match(manifest, /"client"/)
  assert.match(extension, /settings\.plugins\.tab/)
  assert.match(extension, /id: 'market'/)
  assert.match(extension, /--dsw-alias-/)
  assert.doesNotMatch(extension, /#[0-9a-fA-F]{3,8}/)
  assert.doesNotMatch(extension, /一键全量更新/)
})

test('官方 Web 市场只通过受限 loopback 桥接访问客户端能力', () => {
  const bridge = source('src/main/web-bridge.ts')
  assert.match(bridge, /127\.0\.0\.1/)
  assert.match(bridge, /origin !== this\.dshOrigin/)
  assert.match(bridge, /searchMarket/)
  assert.match(bridge, /installPlugin/)
  assert.doesNotMatch(bridge, /dshDesktopToken/)
})
