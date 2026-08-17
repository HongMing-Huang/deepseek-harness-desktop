import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import YAML from 'yaml'
import { dshHome, runtimeRoot } from './runtime/paths'
import { DSH_VERSION } from '../shared/versions'

const PACKAGE_NAME = '@deepseek-ai/dsh-desktop-market'

/**
 * 将随客户端分发的官方 Web 扩展登记到 dsh 的用户 patch 层。
 *
 * 扩展包随运行时一起交付，Loader 从运行时依赖树解析；不写 profile 的
 * node_modules，也不在用户启动时运行 npm/pnpm。这样 dsh 的 profile 重建、
 * 插件安装或升级都不会移除客户端扩展。
 */
export function ensureOfficialWebExtension(): boolean {
  const extensionDir = join(runtimeRoot(), 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-market')
  if (!existsSync(join(extensionDir, 'package.json')) || !existsSync(join(extensionDir, 'lib', 'client.js'))) {
    return false
  }
  if (!ensureProfileModuleFallback(extensionDir)) return false
  const patchPath = join(dshHome(), 'cordis.patch.yml')
  mkdirSync(dshHome(), { recursive: true })
  const rows = readPatch(patchPath)
  if (!rows.some(hasMarketRow)) {
    // cordis patch 只能通过 insert 新增 Loader entry；裸 id 仅用于覆盖已有行。
    rows.push({ insert: [{ id: 'dsh-desktop-market', name: PACKAGE_NAME }] })
    writeYamlAtomic(patchPath, rows)
  }
  return true
}

/**
 * dsh 的 Loader 以 profile 目录为 Node 解析锚点。官方启动时会维护
 * `$DSH_HOME/profiles/node_modules` 作为内置包的只读回退层；这里把随应用
 * 分发的市场包连接到同一层，避免 profile 的 pnpm 重建影响它。
 */
function ensureProfileModuleFallback(extensionDir: string): boolean {
  const linkPath = join(dshHome(), 'profiles', 'node_modules', '@deepseek-ai', 'dsh-desktop-market')
  try {
    const stat = lstatSync(linkPath)
    return stat.isSymbolicLink() && readlinkSync(linkPath) === extensionDir
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }

  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(extensionDir, linkPath, 'dir')
    return true
  } catch {
    return false
  }
}

function hasMarketRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false
  const insert = (row as { insert?: unknown }).insert
  return Array.isArray(insert) && insert.some((entry) =>
    entry && typeof entry === 'object' && (entry as { id?: unknown }).id === 'dsh-desktop-market'
  )
}

/** 当前包只针对同版本官方 Client ABI 启用。 */
export function supportsOfficialWebExtension(runtimeVersion: string | null): boolean {
  return runtimeVersion === DSH_VERSION
}

function readPatch(path: string): unknown[] {
  try {
    const value = YAML.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function writeYamlAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, YAML.stringify(value), 'utf-8')
  renameSync(tmp, path)
}
