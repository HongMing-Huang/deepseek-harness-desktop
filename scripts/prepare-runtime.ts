/**
 * prepare-runtime：为 DSH Desktop 准备内嵌运行时。
 *
 * 产出（resources/runtime/，按 --platform/--arch 目标组合）：
 *   node/<arch>/node            Node LTS 官方二进制
 *   pnpm/<arch>/pnpm.cjs        pnpm 主程序（npm tgz 解出，约 10MB）
 *   pnpm/<arch>/pnpm            可执行 shim（#!/bin/sh，转发到内嵌 node）
 *   dsh/node_modules/...        npm install @deepseek-ai/dsh@<pin>
 *   dsh/version.json            版本清单
 *
 * pnpm 首选 tgz 瘦身方案；任一步失败自动整体回退为下载 standalone 二进制。
 *
 * 特性：幂等（已存在则跳过）、下载带进度与重试。
 * 用法：
 *   npx tsx scripts/prepare-runtime.ts [--platform darwin|linux] [--arch arm64|x64] [--prune-others]
 *   --prune-others：删除非目标架构的 node/<other>/、pnpm/<other>/（dist 构建前瘦身）
 */

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, arch as osArch, platform as osPlatform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  DSH_PACKAGE,
  DSH_VERSION,
  NODE_MAJOR,
  NPM_REGISTRY,
  PNPM_VERSION
} from '../src/shared/versions'

// ── 平台与架构 ──────────────────────────────────────────────────────

const PLATFORMS = ['darwin', 'linux'] as const
const ARCHS = ['arm64', 'x64'] as const
type NodePlatform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHS)[number]

/** CLI 参数（platform/arch 默认当前宿主组合） */
interface CliOptions {
  platform: NodePlatform
  arch: Arch
  pruneOthers: boolean
}

function parseArgs(): CliOptions {
  const argv = process.argv.slice(2)
  let plat: NodePlatform | undefined
  let arch: Arch | undefined
  let pruneOthers = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--platform') {
      const v = argv[++i]
      if (!PLATFORMS.includes(v as NodePlatform)) {
        fail(`--platform 仅支持 ${PLATFORMS.join('|')}，收到：${v ?? '(缺失)'}`)
      }
      plat = v as NodePlatform
    } else if (arg === '--arch') {
      const v = argv[++i]
      if (!ARCHS.includes(v as Arch)) {
        fail(`--arch 仅支持 ${ARCHS.join('|')}，收到：${v ?? '(缺失)'}`)
      }
      arch = v as Arch
    } else if (arg === '--prune-others') {
      pruneOthers = true
    } else {
      fail(`未知参数：${arg}`)
    }
  }

  if (!plat) {
    const host = osPlatform()
    if (host === 'darwin' || host === 'linux') {
      plat = host
    } else {
      fail(`宿主平台 ${host} 不受支持（POSIX only），请用 --platform darwin|linux 显式指定`)
    }
  }
  if (!arch) {
    arch = osArch() === 'arm64' ? 'arm64' : 'x64'
  }
  return { platform: plat, arch, pruneOthers }
}

const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const RUNTIME_DIR = join(PROJECT_ROOT, 'resources', 'runtime')

const NODE_DIST_INDEX = 'https://nodejs.org/dist/index.json'
const PNPM_RELEASE_BASE = 'https://github.com/pnpm/pnpm/releases/download'

const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1_500

// ── 小工具 ──────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(`[prepare-runtime] ${msg}\n`)
}

function fail(msg: string): never {
  process.stderr.write(`[prepare-runtime] ✖ ${msg}\n`)
  process.exit(1)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 带重试的执行器 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      log(`⚠ ${label} 第 ${attempt}/${MAX_RETRIES} 次失败：${msg}`)
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * attempt
        log(`  ${delay}ms 后重试…`)
        await sleep(delay)
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 下载文件，带进度输出（每 5% 打印一次） */
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} ← ${url}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastPct = -5

  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  const stream = Readable.fromWeb(res.body as never)
  stream.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) {
      const pct = Math.floor((received / total) * 100)
      if (pct - lastPct >= 5) {
        lastPct = pct
        log(`  ↓ ${basenameSafe(dest)} ${pct}% (${mb(received)} / ${mb(total)})`)
      }
    } else {
      log(`  ↓ ${basenameSafe(dest)} ${mb(received)}`)
    }
  })
  await pipeline(stream, createWriteStream(tmp))
  await rename(tmp, dest)
}

function basenameSafe(p: string): string {
  return p.split('/').pop() ?? p
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ── Node LTS ────────────────────────────────────────────────────────

interface NodeDistEntry {
  version: string
  files: string[]
}

async function resolveLatestNodeVersion(): Promise<string> {
  const res = await fetch(NODE_DIST_INDEX)
  if (!res.ok) throw new Error(`无法获取 Node 版本索引：HTTP ${res.status}`)
  const index = (await res.json()) as NodeDistEntry[]
  const hit = index.find((e) => e.version.startsWith(`${NODE_MAJOR}.`))
  if (!hit) throw new Error(`nodejs.org 索引中未找到 ${NODE_MAJOR}.x 版本`)
  return hit.version // e.g. v24.19.0
}

async function prepareNode(nodeVersion: string, opts: CliOptions): Promise<void> {
  const { platform: plat, arch } = opts
  const binDir = join(RUNTIME_DIR, 'node', arch)
  const binPath = join(binDir, 'node')
  const tarName = `node-${nodeVersion}-${plat}-${arch}.tar.gz`
  const url = `https://nodejs.org/dist/${nodeVersion}/${tarName}`

  if (existsSync(binPath)) {
    log(`✓ node ${nodeVersion} (${plat}-${arch}) 已存在，跳过`)
    return
  }

  log(`↓ 下载 Node ${nodeVersion} (${plat}-${arch})…`)
  const tmpDir = await mkdtemp(join(tmpdir(), 'dsh-node-'))
  const tarPath = join(tmpDir, tarName)
  try {
    await withRetry(`Node ${plat}-${arch} 下载`, () => downloadFile(url, tarPath))

    // 用系统 tar 解包（macOS/Linux 自带）
    const r = spawnSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`tar 解包失败：${tarName}`)

    await mkdir(binDir, { recursive: true })
    const extracted = join(tmpDir, `node-${nodeVersion}-${plat}-${arch}`, 'bin', 'node')
    await rename(extracted, binPath)
    await chmod(binPath, 0o755)
    log(`✓ Node ${nodeVersion} (${plat}-${arch}) 就绪：${binPath}`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── pnpm ────────────────────────────────────────────────────────────

/** pnpm shim：相对路径转发到同 runtime 下目标架构的内嵌 node，运行时无需预知安装位置 */
function pnpmShimContent(arch: Arch): string {
  return [
    '#!/bin/sh',
    `exec "$(dirname "$0")/../../node/${arch}/node" "$(dirname "$0")/pnpm.cjs" "$@"`,
    ''
  ].join('\n')
}

/** standalone 资产名（回退方案）：pnpm-macos-arm64 / pnpm-linux-x64 等 */
function pnpmStandaloneAsset(plat: NodePlatform, arch: Arch): string {
  return `pnpm-${plat === 'darwin' ? 'macos' : 'linux'}-${arch}`
}

async function preparePnpm(opts: CliOptions): Promise<void> {
  const { platform: plat, arch } = opts
  const binDir = join(RUNTIME_DIR, 'pnpm', arch)
  const cjsPath = join(binDir, 'pnpm.cjs')
  const entryPath = join(binDir, 'pnpm')

  // 幂等：入口（shim 或 standalone）与 pnpm.cjs 均在位即视为就绪
  if (existsSync(entryPath) && existsSync(cjsPath)) {
    log(`✓ pnpm ${PNPM_VERSION} (${plat}-${arch}) 已存在，跳过`)
    return
  }

  await mkdir(binDir, { recursive: true })

  // 首选：npm registry tgz 解出 pnpm.cjs（约 10MB，显著小于 standalone）
  try {
    await withRetry(`pnpm tgz 瘦身 (${arch})`, () => installPnpmFromTgz(cjsPath))
    // 覆盖同路径旧 standalone 二进制（同名文件，写入即完成替换）
    await writeFile(entryPath, pnpmShimContent(arch), 'utf-8')
    await chmod(entryPath, 0o755)
    log(`✓ pnpm ${PNPM_VERSION} (${plat}-${arch}) 瘦身就绪：shim + ${cjsPath}`)
    return
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`⚠ pnpm tgz 瘦身失败（${msg}），整体回退 standalone 二进制`)
  }

  // 回退：下载平台 standalone 可执行文件
  const assetName = pnpmStandaloneAsset(plat, arch)
  const url = `${PNPM_RELEASE_BASE}/v${PNPM_VERSION}/${assetName}`
  log(`↓ 下载 pnpm ${PNPM_VERSION} standalone (${plat}-${arch})…`)
  await withRetry(`pnpm ${plat}-${arch} standalone 下载`, () => downloadFile(url, entryPath))
  await chmod(entryPath, 0o755)
  log(`✓ pnpm ${PNPM_VERSION} (${plat}-${arch}) standalone 就绪：${entryPath}`)
}

/** 从 npm registry 下载 pnpm 包 tgz 并解出主程序 pnpm.cjs（dist/ 下，约 7-10MB） */
async function installPnpmFromTgz(cjsPath: string): Promise<void> {
  const url = `${NPM_REGISTRY}/pnpm/-/pnpm-${PNPM_VERSION}.tgz`
  const tmpDir = await mkdtemp(join(tmpdir(), 'dsh-pnpm-'))
  const tarPath = join(tmpDir, 'pnpm.tgz')
  try {
    await downloadFile(url, tarPath)
    const r = spawnSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('pnpm tgz 解包失败')
    // 10.x 包内主程序位于 package/dist/pnpm.cjs，兼容未来可能的 package/pnpm.cjs
    const extracted = join(tmpDir, 'package', 'dist', 'pnpm.cjs')
    const fallback = join(tmpDir, 'package', 'pnpm.cjs')
    if (!existsSync(extracted)) {
      if (!existsSync(fallback)) throw new Error('tgz 中未找到 package/dist/pnpm.cjs')
      await rename(fallback, cjsPath)
    } else {
      await rename(extracted, cjsPath)
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── dsh ─────────────────────────────────────────────────────────────

async function prepareDsh(): Promise<void> {
  const dshDir = join(RUNTIME_DIR, 'dsh')
  const versionFile = join(dshDir, 'version.json')
  const binPath = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  // 幂等：版本一致且 bin 存在则跳过
  if (existsSync(binPath) && existsSync(versionFile)) {
    try {
      const { readFile } = await import('node:fs/promises')
      const v = JSON.parse(await readFile(versionFile, 'utf-8')) as { dsh?: string }
      if (v.dsh === DSH_VERSION) {
        log(`✓ ${DSH_PACKAGE}@${DSH_VERSION} 已安装，跳过`)
        return
      }
    } catch {
      // version.json 损坏 → 重装
    }
  }

  await mkdir(dshDir, { recursive: true })
  log(`↓ npm install ${DSH_PACKAGE}@${DSH_VERSION} → ${dshDir}`)
  await withRetry('dsh npm install', async () => {
    const r = spawnSync(
      'npm',
      // --save-exact：向 dsh/package.json 写入精确版本，保证运行时可复现
      ['install', '--save-exact', '--prefix', dshDir, `${DSH_PACKAGE}@${DSH_VERSION}`],
      { stdio: 'inherit' }
    )
    if (r.status !== 0) throw new Error(`npm install 失败（exit ${r.status}）`)
  })

  if (!existsSync(binPath)) {
    fail(`安装完成但未找到 dsh bin：${binPath}`)
  }

  await writeFile(
    versionFile,
    JSON.stringify(
      {
        dsh: DSH_VERSION,
        pnpm: PNPM_VERSION,
        nodeMajor: NODE_MAJOR,
        installedAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf-8'
  )
  log(`✓ dsh 安装完成，版本清单：${versionFile}`)
}

// ── 瘦身 ────────────────────────────────────────────────────────────

/** 删除非目标架构的 node/<other>/、pnpm/<other>/（dist 前瘦身；CI 原生 runner 本就只备单架构） */
async function pruneOtherArchives(keepArch: Arch): Promise<void> {
  for (const other of ARCHS) {
    if (other === keepArch) continue
    for (const dir of ['node', 'pnpm']) {
      const target = join(RUNTIME_DIR, dir, other)
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true })
        log(`✂ 已删除非目标架构目录：${dir}/${other}/`)
      }
    }
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs()
  const { platform: plat, arch } = opts
  log(
    `运行时目录：${RUNTIME_DIR}（目标组合：${plat}-${arch}` +
      `${opts.pruneOthers ? '，prune 其它架构' : ''}）`
  )
  await mkdir(RUNTIME_DIR, { recursive: true })

  const nodeVersion = await withRetry('Node 版本解析', resolveLatestNodeVersion)
  log(`目标 Node 版本：${nodeVersion}`)

  await prepareNode(nodeVersion, opts)
  await preparePnpm(opts)
  await prepareDsh()

  if (opts.pruneOthers) {
    await pruneOtherArchives(arch)
  }

  // 汇总校验（按目标组合）
  const checks: Array<[string, string]> = [
    [`node (${plat}-${arch})`, join(RUNTIME_DIR, 'node', arch, 'node')],
    [`pnpm (${plat}-${arch})`, join(RUNTIME_DIR, 'pnpm', arch, 'pnpm')],
    ['dsh bin', join(RUNTIME_DIR, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')],
    ['version.json', join(RUNTIME_DIR, 'dsh/version.json')]
  ]
  for (const [label, p] of checks) {
    if (!existsSync(p)) fail(`产物缺失：${label} → ${p}`)
    const s = await stat(p)
    log(`✔ ${label}: ${mb(s.size)}`)
  }
  log('🎉 运行时准备完成')
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err))
})
