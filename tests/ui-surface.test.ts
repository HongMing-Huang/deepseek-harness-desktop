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

test('设置窗口与入口已移除，会话和插件仍由原生菜单打开', () => {
  const windows = source('src/main/windows.ts')
  const tray = source('src/main/tray.ts')
  assert.doesNotMatch(windows, /openSettingsWindow/)
  assert.doesNotMatch(windows, /settings\.html/)
  assert.match(windows, /label: '会话中心…'/)
  assert.match(windows, /label: '插件…'/)
  assert.doesNotMatch(tray, /label: '设置'/)
  assert.doesNotMatch(tray, /label: '检查更新'/)
})

test('插件市场保留真实安装入口，但不显示全量更新按钮', () => {
  const plugins = source('src/renderer/plugins.html')
  assert.match(plugins, /id="tabMarket"/)
  assert.match(plugins, /id="catalogList"/)
  assert.doesNotMatch(plugins, /id="updateAllBtn"/)
  assert.doesNotMatch(plugins, /一键全量更新/)
})

test('插件窗口不向用户展示运行时堆栈', () => {
  const plugins = source('src/renderer/plugins.js')
  assert.match(plugins, /function displayPluginError/)
  assert.match(plugins, /操作失败，请检查网络或插件兼容性后重试。/)
})
