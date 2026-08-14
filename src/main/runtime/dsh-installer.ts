import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildChildEnv, resolveRuntime, sideloadRoot } from './paths'
import { DSH_PACKAGE } from '../../shared/versions'
import { logger } from '../logger'

/**
 * 侧载安装器：在 <userData>/runtimes/dsh/<version>/ 用内嵌 pnpm 安装指定版本 dsh。
 *
 * 与 scripts/prepare-runtime.ts 并行存在的原因：
 * - prepare-runtime 面向打包阶段（CI 用 npm 流程产出 resources/runtime，强调确定性，
 *   dist:* 脚本依赖其稳定性，保持现有流程不动）；
 * - 本模块面向应用内热更新（运行期用内嵌 pnpm 侧载新版本到 userData，
 *   由 current.json 指针选择生效版本，强调应用壳不重启即可切换）。
 * 两者互不影响：指针未指向侧载版本时一律回退内嵌基线。
 */

export interface InstallDshOptions {
  version: string
  /** 安装目标目录（默认 <userData>/runtimes/dsh/<version>） */
  targetDir?: string
  onProgress?: (info: { percent: number; message: string }) => void
}

export interface InstallDshResult {
  version: string
  targetDir: string
  binPath: string
}

/** 安装被中止（应用退出等），半成品目录由调用方决定去留 */
export class InstallCancelledError extends Error {
  constructor() {
    super('安装已被取消')
    this.name = 'InstallCancelledError'
  }
}

/** 侧载版本的 bin.js 路径 */
export function sideloadBinPath(version: string): string {
  return join(sideloadRoot(), version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * 安装指定版本 dsh 到目标目录：
 * 1. 准备最小 package.json（name: dsh-runtime, private: true）；
 * 2. `pnpm add @deepseek-ai/dsh@<version> --node-linker=hoisted --ignore-scripts=false`
 *    （使用 resolveRuntime 解析出的 node/pnpm，shim 与 standalone 均可）；
 * 3. 校验 lib/bin.js 存在；
 * 4. 写 version.json 清单。
 * 支持 AbortSignal 取消（应用退出时中止 pnpm 子进程）。
 */
export async function installDsh(
  opts: InstallDshOptions,
  signal?: AbortSignal
): Promise<InstallDshResult> {
  const targetDir = opts.targetDir ?? join(sideloadRoot(), opts.version)
  const progress = opts.onProgress ?? (() => {})

  progress({ percent: 5, message: '准备安装目录' })
  await mkdir(targetDir, { recursive: true })

  const pkgJsonPath = join(targetDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    await writeFile(pkgJsonPath, JSON.stringify({ name: 'dsh-runtime', private: true }, null, 2) + '\n')
  }

  const resolution = resolveRuntime()
  if (!resolution.pnpm) {
    throw new Error('内嵌 pnpm 不可用，无法侧载安装；请重新安装应用')
  }

  logger.info(`侧载安装 ${DSH_PACKAGE}@${opts.version} → ${targetDir}`)
  progress({ percent: 15, message: `正在下载并安装 dsh ${opts.version}` })

  const tail = await runPnpmAdd(
    resolution.pnpm,
    ['add', `${DSH_PACKAGE}@${opts.version}`, '--node-linker=hoisted', '--ignore-scripts=false'],
    targetDir,
    buildChildEnv(resolution),
    signal,
    (percent) => progress({ percent, message: `正在安装 dsh ${opts.version}（${percent}%）` })
  )

  progress({ percent: 92, message: '校验安装结果' })
  const binPath = join(targetDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binPath)) {
    throw new Error(`安装校验失败：${binPath} 不存在\n${tail}`)
  }

  progress({ percent: 97, message: '写入版本清单' })
  await writeFile(
    join(targetDir, 'version.json'),
    JSON.stringify({ dsh: opts.version, installedAt: new Date().toISOString() }, null, 2) + '\n'
  )

  progress({ percent: 100, message: `dsh ${opts.version} 安装完成` })
  logger.info(`侧载安装完成：${DSH_PACKAGE}@${opts.version}`)
  return { version: opts.version, targetDir, binPath }
}

/** 执行 pnpm add：时间驱动的平滑进度（25% → 88%），保留输出尾部用于失败诊断 */
function runPnpmAdd(
  pnpmPath: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  onPercent: (percent: number) => void
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InstallCancelledError())
      return
    }

    const child = spawn(pnpmPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })

    let tail = ''
    const feed = (d: string | Buffer): void => {
      tail = (tail + d.toString()).slice(-4_000)
    }
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)

    // 安装期进度：时间驱动平滑推进到 88%，真实完成由退出码决定
    let percent = 25
    onPercent(percent)
    const ticker = setInterval(() => {
      if (percent < 88) {
        percent += 1
        onPercent(percent)
      }
    }, 1_500)

    const onAbort = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        // 子进程可能已退出
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      clearInterval(ticker)
      signal?.removeEventListener('abort', onAbort)
    }

    child.on('error', (err) => {
      cleanup()
      reject(new Error(`pnpm 启动失败：${err.message}`))
    })

    child.on('exit', (code, signalName) => {
      cleanup()
      if (code === 0) {
        resolve(tail)
      } else if (signal?.aborted || signalName !== null) {
        reject(new InstallCancelledError())
      } else {
        reject(new Error(`pnpm add 退出码 ${code}\n${tail}`))
      }
    })
  })
}
