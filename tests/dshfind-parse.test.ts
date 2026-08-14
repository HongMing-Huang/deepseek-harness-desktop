import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDshfindCards } from '../src/main/runtime/dshfind'

/**
 * dshfind 列表页卡片解析单测：锚点提取 name/author，窗口内提取
 * 描述/星数/更新信息/仓库链接，并按 dshfind 官方安装命令生成 github: 规格。
 */

const CARD_A = `
<div data-slot="card" class="x"><div data-slot="card-header">
  <div class="flex items-start justify-between gap-2">
    <div data-slot="card-title" class="x">
      <a class="x" href="/zh/plugins/bill9109/dsh-101">dsh-101</a>
    </div>
    <span class="x">
      <svg class="lucide lucide-star size-3.5 fill-amber-400 text-amber-400" aria-hidden="true"><path d="M11.5"/></svg>42
    </span>
  </div>
  <div class="flex items-center gap-3">
    <a href="https://github.com/bill9109" class="x">@<!-- -->bill9109</a>
    <span title="贡献者" class="x"><svg class="lucide lucide-users"></svg>3</span>
  </div>
  <div data-slot="card-description" class="x">DSH 文档阅读模式</div>
</div>
<div data-slot="card-content" class="x">
  <div class="x">
    <span title="更新于" class="x">TypeScript<!-- --> · <!-- -->2026-08-14</span>
    <a href="https://github.com/bill9109/dsh-101" data-slot="button" class="x">查看</a>
  </div>
</div></div>
`

const CARD_B = `
<div data-slot="card" class="x"><div data-slot="card-header">
  <div class="flex items-start justify-between gap-2">
    <div data-slot="card-title" class="x">
      <a class="x" href="/zh/plugins/omdsh-dev/dsh-genui">@omdsh-dev/dsh-genui</a>
    </div>
    <span class="x">
      <svg class="lucide lucide-star size-3.5 fill-amber-400 text-amber-400" aria-hidden="true"><path d="M11.5"/></svg>1.2k
    </span>
  </div>
  <div class="flex items-center gap-3">
    <a href="https://github.com/omdsh-dev" class="x">@<!-- -->omdsh-dev</a>
  </div>
  <div data-slot="card-description" class="x">回复内渲染交互式 UI 组件</div>
</div>
<div data-slot="card-content" class="x">
  <div class="x">
    <span title="更新于" class="x">TypeScript<!-- --> · <!-- -->2026-08-10</span>
    <a href="https://github.com/omdsh-dev/dsh-genui" data-slot="button" class="x">查看</a>
  </div>
</div></div>
`

test('parseDshfindCards：两张卡片全字段解析', () => {
  const entries = parseDshfindCards(CARD_A + CARD_B)
  assert.equal(entries.length, 2)

  const a = entries.find((e) => e.name === 'dsh-101')
  assert.ok(a)
  assert.equal(a.author, 'bill9109')
  assert.equal(a.description, 'DSH 文档阅读模式')
  assert.equal(a.stars, '42')
  assert.ok(a.updated?.includes('2026-08-14'))
  assert.equal(a.repoUrl, 'https://github.com/bill9109/dsh-101')
  assert.equal(a.installSpec, 'github:bill9109/dsh-101')
  assert.equal(a.displayName, undefined, '与仓库同名时不设展示名')

  const b = entries.find((e) => e.name === 'dsh-genui')
  assert.ok(b)
  assert.equal(b.author, 'omdsh-dev')
  assert.equal(b.displayName, '@omdsh-dev/dsh-genui', 'scoped 展示名从标题文本提取')
  assert.equal(b.installSpec, 'github:omdsh-dev/dsh-genui')
  assert.equal(b.stars, '1.2k')
})

test('parseDshfindCards：星数降序排序（数字优先于 k 缩写，缺失排最后）', () => {
  const entries = parseDshfindCards(CARD_A + CARD_B)
  // 1.2k = 1200 > 42 → B 在前
  assert.equal(entries[0].name, 'dsh-genui')
  assert.equal(entries[1].name, 'dsh-101')
})

test('parseDshfindCards：重复锚点去重', () => {
  const html = CARD_A.replace('href="/zh/plugins/bill9109/dsh-101"', 'href="/zh/plugins/bill9109/dsh-101"').replace(
    '<div data-slot="card-description"',
    '<a href="/zh/plugins/bill9109/dsh-101">dup</a><div data-slot="card-description"'
  )
  const entries = parseDshfindCards(html)
  assert.equal(entries.length, 1)
})

test('parseDshfindCards：空/无关 HTML 返回空数组', () => {
  assert.deepEqual(parseDshfindCards(''), [])
  assert.deepEqual(parseDshfindCards('<html><body>没有插件</body></html>'), [])
})
