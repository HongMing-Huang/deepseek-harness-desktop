import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInstallSpec, ensureAllowBuilds } from '../src/main/runtime/plugins'

/**
 * 插件安装规格解析单测（GitHub 直装白名单校验）：
 * - npm 语义：裸名 / name@version（含 scoped 包）；
 * - github 直装：git+https://github.com/<owner>/<repo>.git 与 github:<owner>/<repo>，
 *   可带 #ref pin；其余 URL / 协议 / 注入形状一律拒绝。
 */

test('npm 语义：裸名与精确 pin（含 scoped 包）', () => {
  assert.equal(resolveInstallSpec('dsh-xxx'), 'dsh-xxx')
  assert.equal(resolveInstallSpec('dsh-xxx', '1.2.3'), 'dsh-xxx@1.2.3')
  assert.equal(resolveInstallSpec('@scope/dsh-xxx'), '@scope/dsh-xxx')
  assert.equal(resolveInstallSpec('@scope/dsh-xxx', '0.1.0-rc.1'), '@scope/dsh-xxx@0.1.0-rc.1')
})

test('版本字符串空白视为未提供（latest 裸名）', () => {
  assert.equal(resolveInstallSpec('dsh-xxx', '  '), 'dsh-xxx')
})

test('github 直装：git+https URL 与 github: 协议均放行，支持 #ref pin', () => {
  assert.equal(
    resolveInstallSpec('@omdsh-dev/dsh-annotation', '1.3.14', 'git+https://github.com/omdsh-dev/dsh-annotation.git#687f13dcf154'),
    'git+https://github.com/omdsh-dev/dsh-annotation.git#687f13dcf154'
  )
  assert.equal(
    resolveInstallSpec('dsh-auto-review', undefined, 'github:PerryLink/dsh-auto-review#main'),
    'github:PerryLink/dsh-auto-review#main'
  )
})

test('github 直装：非法规格一律拒绝', () => {
  const invalid = [
    'https://evil.com/x.git',
    'git+https://gitlab.com/o/r.git',
    'git+https://github.com.evil.com/o/r.git',
    'file:///etc/passwd',
    'o/r',
    'git+https://github.com/o/r.git#bad ref',
    'git+https://github.com/o/r.git#../../etc/passwd',
    'git+ssh://github.com/o/r.git'
  ]
  for (const spec of invalid) {
    assert.throws(
      () => resolveInstallSpec('dsh-xxx', undefined, spec),
      /直装规格无效/,
      `应拒绝：${spec}`
    )
  }
})

test('github 直装：spec 为空回退 npm 语义', () => {
  assert.equal(resolveInstallSpec('dsh-xxx', '2.0.0', ''), 'dsh-xxx@2.0.0')
  assert.equal(resolveInstallSpec('dsh-xxx', undefined, '   '), 'dsh-xxx')
})

/* ── allowBuilds 预放行（官方要求：git 托管插件先放行 prepare 构建脚本） ── */

const PROFILE_TEMPLATE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

function tempProfileHome(): { home: string; profileDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-test-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  process.env.DSH_HOME = home
  return { home, profileDir }
}

test('ensureAllowBuilds：profile 无 workspace 文件时创建最小形态并放行', () => {
  const { home, profileDir } = tempProfileHome()
  try {
    const result = ensureAllowBuilds('dsh-auto-review')
    assert.equal(result.ok, true)
    const raw = readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf-8')
    assert.ok(raw.includes('allowBuilds:'))
    assert.ok(raw.includes('dsh-auto-review'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureAllowBuilds：追加到已有模板并保留原键', () => {
  const { home, profileDir } = tempProfileHome()
  try {
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), PROFILE_TEMPLATE, 'utf-8')
    ensureAllowBuilds('dsh-auto-review')
    const raw = readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf-8')
    assert.ok(raw.includes('packages:'))
    assert.ok(raw.includes('nodeLinker: hoisted'))
    assert.ok(raw.includes('autoInstallPeers: false'))
    assert.ok(raw.includes('- dsh-auto-review'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureAllowBuilds：幂等（重复放行不产生重复条目）', () => {
  const { home, profileDir } = tempProfileHome()
  try {
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), PROFILE_TEMPLATE, 'utf-8')
    ensureAllowBuilds('dsh-auto-review')
    ensureAllowBuilds('dsh-auto-review')
    const raw = readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf-8')
    assert.equal((raw.match(/- dsh-auto-review/g) ?? []).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureAllowBuilds：scoped 包名原样写入', () => {
  const { home, profileDir } = tempProfileHome()
  try {
    ensureAllowBuilds('@omdsh-dev/dsh-annotation')
    const raw = readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf-8')
    assert.ok(raw.includes('- @omdsh-dev/dsh-annotation'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
