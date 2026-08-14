/**
 * prepare-runtime：为 Deepseek 准备内嵌运行时。
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
 * dsh 官方来源校验：安装（含幂等跳过）后必验包名/钉死版本/repository 与
 * npm registry 维护者归属，防止本地拷贝或仿冒包混入内嵌运行时（详见
 * verifyDshProvenance）。
 *
 * 特性：幂等（已存在且平台标记一致则跳过）、下载带进度与重试、完整性校验
 * （Node tarball 对官方 SHASUMS256.txt，pnpm tgz 对 registry dist.integrity）。
 * 用法：
 *   npx tsx scripts/prepare-runtime.ts [--platform darwin|linux] [--arch arm64|x64] [--prune-others]
 *   --prune-others：删除非目标架构的 node/<other>/、pnpm/<other>/（dist 构建前瘦身）
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

// ── 平台元数据与完整性校验 ─────────────────────────────────────────

/** 平台标记文件名：防本地交叉打包时误用旧目标组合的产物 */
const PLATFORM_MARKER = '.platform'

function platformTag(plat: NodePlatform, arch: Arch): string {
  return `${plat}-${arch}`
}

/** 读取目录的平台标记（不存在/读取失败返回 null） */
async function readPlatformMarker(dir: string): Promise<string | null> {
  try {
    return (await readFile(join(dir, PLATFORM_MARKER), 'utf-8')).trim()
  } catch {
    return null
  }
}

/** 校验目录平台标记与目标一致；不一致（含缺失，如历史安装）时清空待重装 */
async function ensurePlatformDir(dir: string, tag: string, label: string): Promise<void> {
  if (!existsSync(dir)) return
  const current = await readPlatformMarker(dir)
  if (current === tag) return
  log(`⚠ ${label} 平台标记不匹配（现值：${current ?? '(缺失)'}，目标：${tag}），重新安装`)
  await rm(dir, { recursive: true, force: true })
}

async function writePlatformMarker(dir: string, tag: string): Promise<void> {
  await writeFile(join(dir, PLATFORM_MARKER), `${tag}\n`, 'utf-8')
}

/** 计算文件哈希（hex 小写） */
async function hashFile(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm)
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** 从官方 SHASUMS256.txt 中取指定文件的 sha256（未命中抛错） */
async function fetchNodeShasum(nodeVersion: string, tarName: string): Promise<string> {
  const res = await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`)
  if (!res.ok) throw new Error(`无法获取 SHASUMS256.txt：HTTP ${res.status}`)
  const text = await res.text()
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m && m[2] === tarName) return m[1]
  }
  throw new Error(`SHASUMS256.txt 中未找到 ${tarName}`)
}

/** 从 npm registry 元数据取 pnpm tgz 的 dist.integrity（sha512-<base64>），返回 hex */
async function fetchPnpmIntegrity(): Promise<string> {
  const res = await fetch(`${NPM_REGISTRY}/pnpm/${PNPM_VERSION}`)
  if (!res.ok) throw new Error(`无法获取 pnpm registry 元数据：HTTP ${res.status}`)
  const meta = (await res.json()) as { dist?: { integrity?: string } }
  const integrity = meta.dist?.integrity
  if (!integrity || !integrity.startsWith('sha512-')) {
    throw new Error('pnpm registry 元数据缺少 sha512 integrity')
  }
  return Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
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
  const tag = platformTag(plat, arch)

  // 幂等前提：平台标记一致（缺失/不一致则清空重装，防交叉打包嵌错二进制）
  await ensurePlatformDir(binDir, tag, `node/${arch}`)
  if (existsSync(binPath)) {
    log(`✓ node ${nodeVersion} (${plat}-${arch}) 已存在，跳过`)
    return
  }

  log(`↓ 下载 Node ${nodeVersion} (${plat}-${arch})…`)
  const tmpDir = await mkdtemp(join(tmpdir(), 'dsh-node-'))
  const tarPath = join(tmpDir, tarName)
  try {
    // 下载后按官方 SHASUMS256.txt 校验 sha256，失败即重试
    await withRetry(`Node ${plat}-${arch} 下载校验`, async () => {
      await downloadFile(url, tarPath)
      const expected = await fetchNodeShasum(nodeVersion, tarName)
      const actual = await hashFile(tarPath, 'sha256')
      if (actual !== expected) {
        throw new Error(
          `sha256 校验失败：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`
        )
      }
    })

    // 用系统 tar 解包（macOS/Linux 自带）
    const r = spawnSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`tar 解包失败：${tarName}`)

    await mkdir(binDir, { recursive: true })
    const extracted = join(tmpDir, `node-${nodeVersion}-${plat}-${arch}`, 'bin', 'node')
    await rename(extracted, binPath)
    await chmod(binPath, 0o755)
    await writePlatformMarker(binDir, tag)
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
  const tag = platformTag(plat, arch)

  // 幂等前提：平台标记一致（缺失/不一致则清空重装）
  await ensurePlatformDir(binDir, tag, `pnpm/${arch}`)
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
    await writePlatformMarker(binDir, tag)
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
  await writePlatformMarker(binDir, tag)
  log(`✓ pnpm ${PNPM_VERSION} (${plat}-${arch}) standalone 就绪：${entryPath}`)
}

/** 从 npm registry 下载 pnpm 包 tgz（按 dist.integrity 校验 sha512）并解出主程序 pnpm.cjs */
async function installPnpmFromTgz(cjsPath: string): Promise<void> {
  const url = `${NPM_REGISTRY}/pnpm/-/pnpm-${PNPM_VERSION}.tgz`
  const tmpDir = await mkdtemp(join(tmpdir(), 'dsh-pnpm-'))
  const tarPath = join(tmpDir, 'pnpm.tgz')
  try {
    await downloadFile(url, tarPath)
    // 完整性校验：registry 元数据 dist.integrity（sha512），失败抛错由外层重试
    const expected = await fetchPnpmIntegrity()
    const actual = await hashFile(tarPath, 'sha512')
    if (actual !== expected) {
      throw new Error(`pnpm tgz sha512 校验失败：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
    }
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

/** dsh 上游官方 GitHub 仓库（来源校验基准；与 sync-upstream 同源） */
const DSH_UPSTREAM_REPO = 'deepseek-ai/deepseek-harness'

/** npm registry 上该包维护者名单须含 deepseek-ai 官方发布者（个人账号名或邮箱域名带 deepseek 标识） */
const DSH_OFFICIAL_MAINTAINER_RE = /deepseek/i

/** dsh 安装产物 package.json 的最小结构（未知字段忽略） */
interface DshManifest {
  name?: unknown
  version?: unknown
  repository?: unknown
}

/** npm registry 完整元数据中维护者与版本表的最小结构 */
interface DshRegistryMeta {
  maintainers?: Array<{ name?: unknown; email?: unknown }>
  versions?: Record<string, { maintainers?: Array<{ name?: unknown; email?: unknown }> } | undefined>
}

/** 提取 repository 引用：兼容字符串简写与 { type, url } 对象两种写法 */
function repositoryRefOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') {
    return (value as { url: string }).url
  }
  return ''
}

/** 规范化 repository 引用：去 git+ / github: 前缀与 .git 后缀，便于包含匹配 */
function normalizeRepositoryRef(ref: string): string {
  return ref
    .replace(/^git\+/, '')
    .replace(/^github:/, '')
    .replace(/\.git$/i, '')
    .trim()
}

/**
 * dsh 官方来源校验（防本地拷贝/仿冒包混入内嵌运行时）：
 * 1. 安装产物 manifest：name === 钉死包名、version === 钉死版本、
 *    repository 指向上游官方仓库；
 * 2. npm registry 完整元数据（abbreviated 元数据不含 maintainers，故用完整 doc）：
 *    钉死版本的维护者中须有 deepseek-ai 官方发布者（个人发布者账号名或
 *    邮箱域名含 deepseek 标识，与官方组织发布实务一致）。
 * 任一不匹配 → 构建失败；幂等跳过安装时同样执行本校验。
 */
async function verifyDshProvenance(dshDir: string): Promise<void> {
  const manifestPath = join(dshDir, 'node_modules', DSH_PACKAGE, 'package.json')
  if (!existsSync(manifestPath)) {
    fail(`来源校验失败：未找到 dsh manifest：${manifestPath}`)
  }
  let manifest: DshManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as DshManifest
  } catch (err) {
    fail(`来源校验失败：dsh manifest 解析失败：${err instanceof Error ? err.message : String(err)}`)
  }

  if (manifest.name !== DSH_PACKAGE) {
    fail(`来源校验失败：包名应为 ${DSH_PACKAGE}，实际为 ${String(manifest.name)}`)
  }
  if (manifest.version !== DSH_VERSION) {
    fail(`来源校验失败：版本应为钉死的 ${DSH_VERSION}，实际为 ${String(manifest.version)}`)
  }
  const repoRef = normalizeRepositoryRef(repositoryRefOf(manifest.repository))
  if (!repoRef.includes(DSH_UPSTREAM_REPO)) {
    fail(
      `来源校验失败：repository 应指向 github.com/${DSH_UPSTREAM_REPO}，实际为「${repoRef || '(缺失)'}」`
    )
  }

  // registry 维护者归属：网络失败同样视为构建失败（无法证明来源）
  const meta = await withRetry('dsh registry 来源元数据', async () => {
    const res = await fetch(`${NPM_REGISTRY}/${DSH_PACKAGE}`)
    if (!res.ok) throw new Error(`HTTP ${res.status} ← ${NPM_REGISTRY}/${DSH_PACKAGE}`)
    return (await res.json()) as DshRegistryMeta
  })
  const maintainers = meta.versions?.[DSH_VERSION]?.maintainers ?? meta.maintainers ?? []
  const officialHit = maintainers.some((m) => {
    const name = typeof m?.name === 'string' ? m.name : ''
    const email = typeof m?.email === 'string' ? m.email : ''
    return DSH_OFFICIAL_MAINTAINER_RE.test(name) || DSH_OFFICIAL_MAINTAINER_RE.test(email)
  })
  if (!officialHit) {
    const roster = maintainers
      .map((m) => (typeof m?.name === 'string' ? m.name : '(未知)'))
      .join('、')
    fail(
      `来源校验失败：registry 中 ${DSH_PACKAGE}@${DSH_VERSION} 的维护者（${roster || '(无)'}）不含 deepseek-ai 官方发布者`
    )
  }

  log(
    `dsh source: ${DSH_PACKAGE}@${DSH_VERSION} from npm registry ` +
      `(official distribution of github.com/${DSH_UPSTREAM_REPO})`
  )
}

async function prepareDsh(): Promise<void> {
  const dshDir = join(RUNTIME_DIR, 'dsh')
  const versionFile = join(dshDir, 'version.json')
  const binPath = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  // 幂等：版本一致且 bin 存在则跳过安装（来源校验仍然执行）
  if (existsSync(binPath) && existsSync(versionFile)) {
    try {
      const { readFile } = await import('node:fs/promises')
      const v = JSON.parse(await readFile(versionFile, 'utf-8')) as { dsh?: string }
      if (v.dsh === DSH_VERSION) {
        log(`✓ ${DSH_PACKAGE}@${DSH_VERSION} 已安装，跳过安装（来源校验照常执行）`)
        await verifyDshProvenance(dshDir)
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

  await verifyDshProvenance(dshDir)

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
