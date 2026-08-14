/**
 * prepare-runtime：为 DSH Desktop 准备内嵌运行时。
 *
 * 产出（resources/runtime/）：
 *   node/<arch>/node            Node 24.x LTS 官方二进制（arm64 + x64）
 *   pnpm/<arch>/pnpm            pnpm 独立可执行文件（arm64 + x64）
 *   dsh/node_modules/...        npm install @deepseek-ai/dsh@<pin>
 *   dsh/version.json            版本清单
 *
 * 特性：幂等（已存在且校验通过则跳过）、下载带进度与重试。
 * 运行方式：npx tsx scripts/prepare-runtime.ts
 */

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// ── 版本钉死 ────────────────────────────────────────────────────────
const DSH_VERSION = '0.1.0-rc.6'
const PNPM_VERSION = '10.30.2'
/** 目标 Node 主版本：拉取 nodejs.org/dist 上该主版本的最新 LTS 小版本 */
const NODE_MAJOR = 'v24'

const ARCHS = ['arm64', 'x64'] as const
type Arch = (typeof ARCHS)[number]

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

// ── Node 24.x ──────────────────────────────────────────────────────

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

async function prepareNode(nodeVersion: string): Promise<void> {
  for (const arch of ARCHS) {
    const binDir = join(RUNTIME_DIR, 'node', arch)
    const binPath = join(binDir, 'node')
    const tarName = `node-${nodeVersion}-darwin-${arch}.tar.gz`
    const url = `https://nodejs.org/dist/${nodeVersion}/${tarName}`

    if (existsSync(binPath)) {
      log(`✓ node ${nodeVersion} (${arch}) 已存在，跳过`)
      continue
    }

    log(`↓ 下载 Node ${nodeVersion} (${arch})…`)
    const tmpDir = await mkdtemp(join(tmpdir(), 'dsh-node-'))
    const tarPath = join(tmpDir, tarName)
    try {
      await withRetry(`Node ${arch} 下载`, () => downloadFile(url, tarPath))

      // 用系统 tar 解包（macOS 自带 bsdtar）
      const r = spawnSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'inherit' })
      if (r.status !== 0) throw new Error(`tar 解包失败：${tarName}`)

      await mkdir(binDir, { recursive: true })
      const extracted = join(tmpDir, `node-${nodeVersion}-darwin-${arch}`, 'bin', 'node')
      await rename(extracted, binPath)
      await chmod(binPath, 0o755)
      log(`✓ Node ${nodeVersion} (${arch}) 就绪：${binPath}`)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }
}

// ── pnpm ────────────────────────────────────────────────────────────

async function preparePnpm(): Promise<void> {
  for (const arch of ARCHS) {
    const binDir = join(RUNTIME_DIR, 'pnpm', arch)
    const binPath = join(binDir, 'pnpm')
    // 10.x 系列发布资产命名：pnpm-macos-arm64 / pnpm-macos-x64
    const assetName = `pnpm-macos-${arch}`
    const url = `${PNPM_RELEASE_BASE}/v${PNPM_VERSION}/${assetName}`

    if (existsSync(binPath)) {
      log(`✓ pnpm ${PNPM_VERSION} (${arch}) 已存在，跳过`)
      continue
    }

    log(`↓ 下载 pnpm ${PNPM_VERSION} (${arch})…`)
    await mkdir(binDir, { recursive: true })
    await withRetry(`pnpm ${arch} 下载`, () => downloadFile(url, binPath))
    await chmod(binPath, 0o755)
    log(`✓ pnpm ${PNPM_VERSION} (${arch}) 就绪：${binPath}`)
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
        log(`✓ @deepseek-ai/dsh@${DSH_VERSION} 已安装，跳过`)
        return
      }
    } catch {
      // version.json 损坏 → 重装
    }
  }

  await mkdir(dshDir, { recursive: true })
  log(`↓ npm install @deepseek-ai/dsh@${DSH_VERSION} → ${dshDir}`)
  await withRetry('dsh npm install', async () => {
    const r = spawnSync(
      'npm',
      ['install', '--prefix', dshDir, `@deepseek-ai/dsh@${DSH_VERSION}`],
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

// ── 主流程 ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (platform() !== 'darwin') {
    fail('当前仅支持 macOS（darwin）运行时准备')
  }
  log(`运行时目录：${RUNTIME_DIR}`)
  await mkdir(RUNTIME_DIR, { recursive: true })

  const nodeVersion = await withRetry('Node 版本解析', resolveLatestNodeVersion)
  log(`目标 Node 版本：${nodeVersion}`)

  await prepareNode(nodeVersion)
  await preparePnpm()
  await prepareDsh()

  // 汇总校验
  const checks: Array<[string, string]> = [
    ['node (arm64)', join(RUNTIME_DIR, 'node/arm64/node')],
    ['node (x64)', join(RUNTIME_DIR, 'node/x64/node')],
    ['pnpm (arm64)', join(RUNTIME_DIR, 'pnpm/arm64/pnpm')],
    ['pnpm (x64)', join(RUNTIME_DIR, 'pnpm/x64/pnpm')],
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
