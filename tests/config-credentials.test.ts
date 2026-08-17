import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  getApiKeyStatus,
  getDefaultModel,
  saveApiKey,
  saveDefaultModel,
  migrateLegacyPreferences
} from '../src/main/config'
import type { Preferences } from '../src/shared/ipc'

/**
 * 凭据文件读-改-写行为验证（对应评审修复：saveApiKey 单键合并）：
 * - 保留文件中其它键与注释（不得全量覆盖）；
 * - 坏 YAML 时从最小结构重建；
 * - 写入保持 0600 权限与原子性语义（临时文件 + rename 由实现保证）。
 *
 * 隔离方式：config.ts 经 dshHome() 每次实时读取 DSH_HOME 环境变量，
 * 用例内指向 mkdtemp 临时目录，绝不触碰真实 ~/.dsh。
 */

function freshDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cred-test-'))
  process.env.DSH_HOME = dir
  return dir
}

function cleanup(dir: string): void {
  delete process.env.DSH_HOME
  rmSync(dir, { recursive: true, force: true })
}

function credentialsFile(dir: string): string {
  return join(dir, '.credentials.yaml')
}

test('saveApiKey：文件不存在时创建并写入单键，权限 0600', async () => {
  const home = freshDshHome()
  try {
    const result = await saveApiKey('sk-test1234567890abcd')
    assert.equal(result.ok, true)

    const raw = readFileSync(credentialsFile(home), 'utf-8')
    const doc = parse(raw) as Record<string, string>
    assert.equal(doc['DEEPSEEK_API_KEY'], 'sk-test1234567890abcd')

    // 0600 权限（owner rw 仅）
    const mode = statSync(credentialsFile(home)).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    cleanup(home)
  }
})

test('saveApiKey：合并写入，保留其它键/键序/注释（不全量覆盖）', async () => {
  const home = freshDshHome()
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(
      credentialsFile(home),
      [
        '# 第三方服务凭据（与本应用无关，必须保留）',
        'OTHER_SERVICE_TOKEN: keep-me-please',
        'DEEPSEEK_API_KEY: sk-oldoldoldoldold',
        'ANOTHER_KEY: also-keep'
      ].join('\n'),
      'utf-8'
    )

    const result = await saveApiKey('sk-newnewnewnewnew')
    assert.equal(result.ok, true)

    const raw = readFileSync(credentialsFile(home), 'utf-8')
    const doc = parse(raw) as Record<string, string>
    assert.equal(doc['DEEPSEEK_API_KEY'], 'sk-newnewnewnewnew', '新值生效')
    assert.equal(doc['OTHER_SERVICE_TOKEN'], 'keep-me-please', '无关键保留')
    assert.equal(doc['ANOTHER_KEY'], 'also-keep', '无关键保留')
    assert.ok(raw.includes('# 第三方服务凭据'), '注释保留')
  } finally {
    cleanup(home)
  }
})

test('saveApiKey：坏 YAML（顶层非映射）时从最小结构重建', async () => {
  const home = freshDshHome()
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(credentialsFile(home), ':::not-a-valid-mapping\n', 'utf-8')

    const result = await saveApiKey('sk-rebuild1234567')
    assert.equal(result.ok, true)

    const doc = parse(readFileSync(credentialsFile(home), 'utf-8')) as Record<string, string>
    assert.equal(doc['DEEPSEEK_API_KEY'], 'sk-rebuild1234567')
  } finally {
    cleanup(home)
  }
})

test('saveApiKey：空串被拒绝且不写文件', async () => {
  const home = freshDshHome()
  try {
    const result = await saveApiKey('   ')
    assert.equal(result.ok, false)
    assert.ok(result.message?.includes('不能为空'))
    assert.ok(!existsFileSync(credentialsFile(home)))
  } finally {
    cleanup(home)
  }
})

test('getApiKeyStatus：掩码只保留头 3 位与末 4 位，不泄露明文', async () => {
  const home = freshDshHome()
  try {
    const key = 'sk-abcdefgh12345678'
    await saveApiKey(key)
    const status = await getApiKeyStatus()
    assert.equal(status.configured, true)
    assert.equal(status.masked, 'sk-***5678')
    assert.ok(!status.masked?.includes('abcdefgh'), '掩码不含中段明文')
  } finally {
    cleanup(home)
  }
})

test('saveDefaultModel：保留 settings.yaml 未知字段与注释', async () => {
  const home = freshDshHome()
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, 'settings.yaml'),
      [
        '# 用户自定义设置',
        'ui-theme: dark',
        'agent-default-model:',
        '  model: deepseek-chat'
      ].join('\n'),
      'utf-8'
    )

    const result = await saveDefaultModel('deepseek-reasoner')
    assert.equal(result.ok, true)

    const raw = readFileSync(join(home, 'settings.yaml'), 'utf-8')
    const doc = parse(raw) as Record<string, unknown>
    assert.equal(
      (doc['agent-default-model'] as { model: string }).model,
      'deepseek-reasoner',
      '模型更新'
    )
    assert.equal(doc['ui-theme'], 'dark', '未知字段保留')
    assert.ok(raw.includes('# 用户自定义设置'), '注释保留')

    assert.equal(await getDefaultModel(), 'deepseek-reasoner')
  } finally {
    cleanup(home)
  }
})

/** existsSync 的局部包装：避免与 node:fs 其它导入混排 */
function existsFileSync(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false }) !== undefined
}

test('migrateLegacyPreferences：旧占位仓库值迁移为真实仓库', () => {
  const legacy = {
    updateCheckEnabled: true,
    updateSnoozeUntil: null,
    lastCheck: null,
    lastKnownGoodDsh: null,
    bootFailCount: 0,
    updateRepo: 'owner/deepseek-harness-desktop'
  } satisfies Preferences
  const migrated = migrateLegacyPreferences(legacy)
  assert.equal(migrated.updateRepo, 'HongMing-Huang/deepseek-harness-desktop')
  assert.equal(migrated.updateCheckEnabled, true, '其余字段保持不变')

  const normal = { ...legacy, updateRepo: 'someone-else/deepseek-harness-desktop' }
  assert.equal(migrateLegacyPreferences(normal).updateRepo, 'someone-else/deepseek-harness-desktop', '非占位值不动')
})
