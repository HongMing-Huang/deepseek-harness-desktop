import { app } from 'electron'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, arch as osArch, platform } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * 内嵌运行时（Node / pnpm / dsh）的路径解析与子进程环境构建。
 *
 * 目录约定（由 scripts/prepare-runtime.ts 产出）：
 *   <runtimeRoot>/
 *     node/<arch>/node          内嵌 Node 可执行文件
 *     pnpm/<arch>/pnpm          pnpm 可执行入口（shim 或 standalone 二进制，同名二选一）
 *     pnpm/<arch>/pnpm.cjs      pnpm 主程序（shim 方案时存在）
 *     dsh/node_modules/@deepseek-ai/dsh/lib/bin.js   dsh CLI 入口
 *     dsh/version.json          版本清单
 *
 * - 打包后：process.resourcesPath/runtime（electron-builder extraResources）
 * - 开发时：项目根目录 resources/runtime
 */

export type RuntimeArch = 'arm64' | 'x64'

/** 当前宿主架构（arm64 / x64） */
export function runtimeArch(): RuntimeArch {
  return osArch() === 'arm64' ? 'arm64' : 'x64'
}

/** 运行时根目录：打包态用 resourcesPath，开发态用项目内 resources/runtime */
export function runtimeRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'runtime')
  }
  return join(app.getAppPath(), 'resources', 'runtime')
}

/** 内嵌 node 可执行文件路径（可能不存在，调用方需回退系统 node） */
export function bundledNodePath(): string {
  return join(runtimeRoot(), 'node', runtimeArch(), 'node')
}

/** dsh CLI 入口 bin.js */
export function dshBinPath(): string {
  return join(
    runtimeRoot(),
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js'
  )
}

/** 内嵌 pnpm 可执行入口路径（shim 与 standalone 同名，存在即用） */
export function bundledPnpmPath(): string {
  return join(runtimeRoot(), 'pnpm', runtimeArch(), 'pnpm')
}

/** dsh 数据目录（$DSH_HOME），默认 ~/.dsh，尊重用户已有环境变量 */
export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export interface RuntimeResolution {
  /** 实际用于 spawn 的 node 可执行文件 */
  node: string
  /** 是否使用了内嵌 node（false = 回退系统 node） */
  usingBundledNode: boolean
  dshBin: string
  pnpm: string | null
  dshHome: string
}

/**
 * 解析系统 PATH 中的 node，找不到返回 null。
 * 两段式：先 which（PATH 上优先，ENOENT 再试绝对路径）；
 * 均未命中时用登录 shell 兜底（覆盖非交互环境 PATH 未继承的场景）。
 */
function findSystemNode(): string | null {
  for (const whichBin of ['which', '/usr/bin/which']) {
    try {
      const r = spawnSync(whichBin, ['node'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      if (r.status === 0 && typeof r.stdout === 'string') {
        const p = r.stdout.trim()
        if (p.length > 0) return p
      }
    } catch {
      // which 本身不可用（如 ENOENT），尝试下一个候选
    }
  }
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v node'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const p = out.trim()
    return p.length > 0 ? p : null
  } catch {
    return null
  }
}

/**
 * 解析完整运行时：内嵌 node 缺失时回退系统 node；
 * dsh bin 缺失无法回退，抛出明确错误。
 */
export function resolveRuntime(): RuntimeResolution {
  const dshBin = dshBinPath()
  if (!existsSync(dshBin)) {
    throw new Error(
      `dsh 运行时缺失：${dshBin} 不存在，请先执行 npm run prepare:runtime`
    )
  }

  let node = bundledNodePath()
  let usingBundledNode = true
  if (!existsSync(node)) {
    const systemNode = findSystemNode()
    if (!systemNode) {
      throw new Error(
        `内嵌 Node 缺失（${node}）且系统 PATH 中未找到 node，请执行 npm run prepare:runtime`
      )
    }
    node = systemNode
    usingBundledNode = false
  }

  const pnpmCandidate = bundledPnpmPath()
  const pnpm = existsSync(pnpmCandidate) ? pnpmCandidate : null

  return { node, usingBundledNode, dshBin, pnpm, dshHome: dshHome() }
}

/**
 * 构建 dsh 子进程的环境变量：
 * - PATH 前缀注入内嵌 node / pnpm 所在目录，保证 `dsh plugin` 等子命令可找到 pnpm；
 * - 设置 DSH_HOME；
 * - 继承宿主其余环境。
 */
export function buildChildEnv(resolution?: RuntimeResolution): NodeJS.ProcessEnv {
  const r = resolution ?? resolveRuntime()
  const env: NodeJS.ProcessEnv = { ...process.env }

  const prefixes: string[] = []
  if (r.usingBundledNode) {
    prefixes.push(join(runtimeRoot(), 'node', runtimeArch()))
  }
  if (r.pnpm) {
    prefixes.push(join(runtimeRoot(), 'pnpm', runtimeArch()))
  }
  if (prefixes.length > 0) {
    env.PATH = [...prefixes, env.PATH ?? ''].filter(Boolean).join(delimiter)
  }
  env.DSH_HOME = r.dshHome
  return env
}

/** 平台自检（macOS / Linux 支持内嵌运行时） */
export function isSupportedPlatform(): boolean {
  return platform() === 'darwin' || platform() === 'linux'
}
