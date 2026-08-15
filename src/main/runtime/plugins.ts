import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import semver from 'semver'
import YAML from 'yaml'
import { buildChildEnv, dshHome, resolveRuntime } from './paths'
import { parsePluginProgressLine, splitProgressChunk } from './plugin-progress'
import { broadcastOpProgress } from '../ipc'
import { logger } from '../logger'
import type {
  PluginCatalogEntry,
  PluginEntry,
  PluginHealthItem,
  PluginHealthResult
} from '../../shared/ipc'

/**
 * dsh 插件管理（web profile）：
 * - 已装列表 = ~/.dsh/profiles/web/package.json 的 dependencies，
 *   描述从 node_modules/<pkg>/package.json 读取；
 * - 目录 = 随应用打包的 plugin-catalog.json（构建期由 electron.vite.config.ts 复制到 out/main）；
 * - 安装/卸载 = spawn `node dshBin plugin --profile web add|remove …`（转发给 profile 内 pnpm），
 *   全程 OpProgress 广播（op: plugin-install / plugin-remove），完成即提示重启生效；
 * - 并发保护：同一时刻仅允许一个插件操作，后来者直接拒绝。
 */

/** 目录条目类型与解析来源字段见 shared/ipc.ts 的 PluginCatalogEntry */

interface CatalogFile {
  plugins?: Array<{
    name?: unknown
    version?: unknown
    description?: unknown
    repo?: unknown
    category?: unknown
    compatibility?: unknown
    source?: unknown
    installSpec?: unknown
  }>
}

/** web profile 根目录（pnpm 工作区） */
function profileDir(): string {
  return join(dshHome(), 'profiles', 'web')
}

/** 已安装插件：读 profile 的 package.json dependencies（不存在返回空数组） */
export async function listInstalledPlugins(): Promise<PluginEntry[]> {
  let pkg: { dependencies?: Record<string, string> }
  try {
    const raw = await readFile(join(profileDir(), 'package.json'), 'utf-8')
    pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
  } catch {
    return []
  }
  const deps = pkg.dependencies ?? {}
  const entries: PluginEntry[] = []
  for (const [name, range] of Object.entries(deps)) {
    entries.push({
      name,
      // 展示时去掉 semeld 修饰符（^/~/>= 等）
      version: range.replace(/^[\^~>=<\s]+/, ''),
      enabled: true,
      description: await readPackageDescription(name)
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/** 读取已装包的 description（scoped 包走 @scope/name 两级目录；读不到返回空串，不阻塞列表） */
async function readPackageDescription(name: string): Promise<string> {
  try {
    const raw = await readFile(join(nodeModulesPackageDir(name), 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { description?: unknown }
    return typeof pkg.description === 'string' ? pkg.description : ''
  } catch {
    return ''
  }
}

/**
 * 读取插件目录：优先 out/main/plugin-catalog.json（构建期复制），
 * 开发/兜底回退源码树 src/main/runtime/plugin-catalog.json。
 */
export async function getPluginCatalog(): Promise<PluginCatalogEntry[]> {
  const candidates = [
    join(__dirname, 'plugin-catalog.json'),
    join(app.getAppPath(), 'src', 'main', 'runtime', 'plugin-catalog.json')
  ]
  for (const file of candidates) {
    try {
      const raw = await readFile(file, 'utf-8')
      const parsed = JSON.parse(raw) as CatalogFile
      if (!Array.isArray(parsed.plugins)) continue
      const entries: PluginCatalogEntry[] = []
      for (const p of parsed.plugins) {
        if (typeof p.name !== 'string' || p.name.length === 0) continue
        entries.push({
          name: p.name,
          version: typeof p.version === 'string' ? p.version : '',
          enabled: true,
          description: typeof p.description === 'string' ? p.description : '',
          repo: typeof p.repo === 'string' ? p.repo : undefined,
          category: typeof p.category === 'string' ? p.category : undefined,
          compatibility:
            p.compatibility === 'verified' || p.compatibility === 'community'
              ? p.compatibility
              : undefined,
          source: p.source === 'github' ? 'github' : 'npm',
          installSpec:
            p.source === 'github' && typeof p.installSpec === 'string' && p.installSpec.length > 0
              ? p.installSpec
              : undefined
        })
      }
      return entries
    } catch {
      // 尝试下一个候选路径
    }
  }
  logger.warn('插件目录不可读（plugin-catalog.json 缺失或损坏）')
  return []
}

/* ── 安装 / 卸载 ── */

/** 并发保护：正在进行的插件操作（同一时刻至多一个） */
let activeOperation: { kind: 'install' | 'remove' | 'update'; name: string } | null = null
let activeChild: ChildProcess | null = null

function ensureIdle(kind: 'install' | 'remove' | 'update', name: string): void {
  if (activeOperation) {
    throw new Error(
      `已有插件操作进行中（${activeOperation.kind === 'install' ? '安装' : activeOperation.kind === 'remove' ? '卸载' : '更新'} ${activeOperation.name}），请稍后再试`
    )
  }
  activeOperation = { kind, name }
}

function clearOperation(): void {
  activeOperation = null
  activeChild = null
}

/** 解析 version：空/未提供时安装 latest（裸名），否则 name@version 精确 pin */
function specFor(name: string, version?: string): string {
  const v = (version ?? '').trim()
  return v.length > 0 ? `${name}@${v}` : name
}

/**
 * 安装规格解析（纯函数，可单测）：
 * - spec 非空 = GitHub 直装：仅接受 `git+https://github.com/<owner>/<repo>.git` 或
 *   `github:<owner>/<repo>`（可带 `#<ref>` 提交/分支 pin），其余一律拒绝——
 *   spawn 参数不经 shell，但仍做白名单校验防目录注入与杂项 URL；
 * - spec 为空 = npm 语义（name@version 或裸名 latest）。
 */
export function resolveInstallSpec(name: string, version?: string, spec?: string): string {
  const trimmed = (spec ?? '').trim()
  if (trimmed.length === 0) {
    return specFor(name, version)
  }
  const gitSpecPattern = /^(git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git|github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(#[A-Za-z0-9][A-Za-z0-9_.~/-]*)?$/
  if (!gitSpecPattern.test(trimmed)) {
    throw new Error(`插件 ${name} 的 GitHub 直装规格无效（仅接受 github.com 的 git 规格）`)
  }
  return trimmed
}

/** node_modules 内包目录（scoped 包为 @scope/name 两级） */
function nodeModulesPackageDir(name: string): string {
  return join(profileDir(), 'node_modules', ...name.split('/'))
}

/** 从直装规格推导仓库名（github:owner/repo 或 git+https://…/repo.git#ref → repo；非法返回 null） */
export function specRepoName(spec: string): string | null {
  const match = /^(?:git\+https:\/\/github\.com\/|github:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#[A-Za-z0-9][A-Za-z0-9_.~/-]*)?$/.exec(
    spec.trim()
  )
  return match ? match[2] : null
}

/** YAML 键安全内联（普通包名无需引号；异常字符用 JSON 引号兜底） */
function yamlKey(name: string): string {
  return /^[A-Za-z0-9_@./-]+$/.test(name) ? name : JSON.stringify(name)
}

/* ── GitHub 直装：allowBuilds 预放行 ── */

/**
 * 把包名写入 profile 的 pnpm-workspace.yaml `allowBuilds`（pnpm 10 映射形态
 * `name: true`；存在旧版 pnpm 9 列表形态时自动迁移为映射），不存在则补键、已存在则幂等。
 * 官方要求：git 托管插件安装时 pnpm 默认拦截其 prepare 构建脚本（Ignored build scripts），
 * dsh 的指引即「把 pnpm 打印的 key 加入 allowBuilds 后重跑」——这里按官方指引自动化。
 * - 文件缺失：以 profile 模板最小形态创建；
 * - 解析失败：文本追加 allowBuilds 键（保持可恢复，不覆盖原文件）。
 */
export function ensureAllowBuilds(packageName: string): { ok: boolean; message?: string } {
  const file = join(profileDir(), 'pnpm-workspace.yaml')
  try {
    if (!existsSync(file)) {
      writeFileSync(
        file,
        `packages:\n  - .\n\nnodeLinker: hoisted\n\nallowBuilds:\n  ${yamlKey(packageName)}: true\n`,
        'utf-8'
      )
      return { ok: true }
    }
    const raw = readFileSync(file, 'utf-8')
    const doc = YAML.parse(raw) as Record<string, unknown> | null
    if (doc && typeof doc === 'object') {
      const current = doc['allowBuilds']
      let map: Record<string, boolean> = {}
      if (Array.isArray(current)) {
        // pnpm 9 旧式列表 → 迁移为 pnpm 10 映射
        for (const item of current) {
          if (typeof item === 'string') map[item] = true
        }
      } else if (current && typeof current === 'object') {
        map = { ...(current as Record<string, boolean>) }
      }
      map[packageName] = true
      doc['allowBuilds'] = map
      writeFileSync(file, YAML.stringify(doc), 'utf-8')
      return { ok: true }
    }
    writeFileSync(
      file,
      raw.replace(/\s*$/, '') + `\n\nallowBuilds:\n  ${yamlKey(packageName)}: true\n`,
      'utf-8'
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, message: `更新 allowBuilds 失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 从 pnpm 输出尾部提取被拦截构建的包名（"Ignored build scripts: a, b." → [a, b]） */
export function extractIgnoredBuildNames(output: string): string[] {
  const match = /Ignored build scripts:\s*([^.\n]+)\./.exec(output)
  if (!match) return []
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[@A-Za-z0-9_./-]+$/.test(s))
}

/**
 * 执行一次插件安装：全程 OpProgress 广播；
 * spec 提供时按 GitHub 直装规格（git+https…@pin）安装，否则 npm name@version；
 * 成功返回 {ok:true, message 含“重启生效”提示}。
 */
export async function installPlugin(
  name: string,
  version?: string,
  spec?: string
): Promise<{ ok: boolean; message?: string }> {
  let target: string
  try {
    target = resolveInstallSpec(name, version, spec)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  const op = 'plugin-install' as const
  try {
    ensureIdle('install', name)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }

  // GitHub 直装：官方要求先放行其 prepare 构建脚本（pnpm allowBuilds），否则必失败。
  // 包名可能与仓库名不一致（git 依赖的真实包名以仓库 manifest 为准）——两者都放行，
  // 安装失败且输出含 Ignored build scripts 时再按 pnpm 打印的精确 key 放行并重试一次。
  const isGitInstall = Boolean(spec && spec.trim().length > 0)
  if (isGitInstall) {
    const keys = [name]
    const repoName = specRepoName(target)
    if (repoName && repoName !== name) keys.push(repoName)
    for (const key of keys) {
      const allowed = ensureAllowBuilds(key)
      if (!allowed.ok) {
        clearOperation()
        return { ok: false, message: allowed.message }
      }
    }
  }

  logger.info(`插件安装开始：${target}`)
  broadcastOpProgress({ op, state: 'start', message: `正在安装 ${name}…` })
  try {
    await runPluginCommand('add', target, op)
    logger.info(`插件安装完成：${target}`)
    broadcastOpProgress({
      op,
      state: 'done',
      percent: 100,
      message: `${name} 安装完成，重启运行时后生效`
    })
    return { ok: true, message: `${name} 安装完成，重启运行时后生效` }
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err)
    logger.warn(`插件安装失败：${target}：${message}`)
    // 一次放行重试：按 pnpm 输出的精确包名补 allowBuilds（键名不匹配的兜底），随后原样重试
    if (isGitInstall && message.includes('Ignored build scripts')) {
      for (const key of extractIgnoredBuildNames(message)) {
        ensureAllowBuilds(key)
      }
      broadcastOpProgress({ op, state: 'update', message: `已放行构建脚本，正在重试安装 ${name}…` })
      try {
        await runPluginCommand('add', target, op)
        logger.info(`插件安装完成（放行重试）：${target}`)
        broadcastOpProgress({
          op,
          state: 'done',
          percent: 100,
          message: `${name} 安装完成，重启运行时后生效`
        })
        return { ok: true, message: `${name} 安装完成，重启运行时后生效` }
      } catch (retryErr) {
        message = retryErr instanceof Error ? retryErr.message : String(retryErr)
        logger.warn(`插件安装重试失败：${target}：${message}`)
      }
    }
    broadcastOpProgress({ op, state: 'error', message })
    return { ok: false, message }
  } finally {
    clearOperation()
  }
}

/** 执行一次插件卸载：流程与安装对称 */
export async function removePlugin(name: string): Promise<{ ok: boolean; message?: string }> {
  const op = 'plugin-remove' as const
  try {
    ensureIdle('remove', name)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }

  logger.info(`插件卸载开始：${name}`)
  broadcastOpProgress({ op, state: 'start', message: `正在卸载 ${name}…` })
  try {
    await runPluginCommand('remove', name, op)
    logger.info(`插件卸载完成：${name}`)
    broadcastOpProgress({
      op,
      state: 'done',
      percent: 100,
      message: `${name} 已卸载，重启运行时后生效`
    })
    return { ok: true, message: '卸载完成，重启运行时后生效' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`插件卸载失败：${name}：${message}`)
    broadcastOpProgress({ op, state: 'error', message })
    return { ok: false, message }
  } finally {
    clearOperation()
  }
}

/** 是否有插件操作正在进行（供退出前判断） */
export function hasActivePluginOperation(): boolean {
  return activeOperation !== null
}

/** 中止进行中的插件子进程（应用退出路径使用） */
export function abortActivePluginOperation(): void {
  if (activeChild && activeChild.exitCode === null) {
    try {
      activeChild.kill('SIGTERM')
    } catch {
      // 子进程可能已退出
    }
  }
}

/* ── 健康检查（插件市场 2.0） ── */

/**
 * 健康检查已装插件：
 * - missing：profile 登记了依赖但 node_modules 中无该包（安装中断/被外力删除）；
 * - broken：包元数据不可读或包名不匹配；
 * - stale：目录 pin 了更高版本（有可更新项）；
 * - healthy：其余（元数据可读且版本不低于目录 pin）。
 */
export async function checkPluginsHealth(): Promise<PluginHealthResult> {
  const installed = await listInstalledPlugins()
  const catalog = await getPluginCatalog()
  const byName = new Map(catalog.map((c) => [c.name, c]))

  const items: PluginHealthItem[] = []
  for (const plugin of installed) {
    let raw: string | null = null
    try {
      raw = await readFile(join(nodeModulesPackageDir(plugin.name), 'package.json'), 'utf-8')
    } catch {
      raw = null
    }
    if (!raw) {
      items.push({
        name: plugin.name,
        state: 'missing',
        detail: '已登记但未安装（node_modules 中缺少该包）'
      })
      continue
    }
    let pkg: { name?: unknown; version?: unknown } | null = null
    try {
      pkg = JSON.parse(raw) as { name?: unknown; version?: unknown }
    } catch {
      pkg = null
    }
    if (!pkg || typeof pkg.name !== 'string' || pkg.name !== plugin.name) {
      items.push({
        name: plugin.name,
        state: 'broken',
        detail: '包元数据损坏或名称不匹配'
      })
      continue
    }
    const installedVersion = typeof pkg.version === 'string' ? pkg.version : undefined
    const catalogVersion = byName.get(plugin.name)?.version
    let state: PluginHealthItem['state'] = 'healthy'
    let detail: string | undefined
    if (
      installedVersion &&
      catalogVersion &&
      semver.valid(installedVersion) &&
      semver.valid(catalogVersion) &&
      semver.gt(catalogVersion, installedVersion)
    ) {
      state = 'stale'
      detail = `目录已收录更新版本 v${catalogVersion}`
    }
    items.push({ name: plugin.name, state, installedVersion, catalogVersion, detail })
  }

  return {
    items,
    updatableCount: items.filter((i) => i.state === 'stale').length,
    brokenCount: items.filter((i) => i.state === 'missing' || i.state === 'broken').length
  }
}

/**
 * 一键全量更新：`dsh plugin --profile web update`（转发 pnpm update，
 * 按 profile 内依赖范围把全部插件刷新到兼容的最新版），
 * 全程 OpProgress 广播（op: plugin-update），完成需重启运行时生效。
 */
export async function updateAllPlugins(): Promise<{ ok: boolean; message?: string }> {
  const op = 'plugin-update' as const
  try {
    ensureIdle('update', '全部插件')
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }

  // git 直装插件在 update 时同样会被 pnpm 拦截构建：按两类来源统一预放行——
  // ①目录 source=github 的已装插件；②profile 依赖值为 git 规格的条目（dshfind 等外源直装）。
  try {
    const [installed, catalog] = await Promise.all([listInstalledPlugins(), getPluginCatalog()])
    const githubNames = new Set(
      catalog.filter((c) => c.source === 'github').map((c) => c.name)
    )
    const gitSpecDeps: string[] = []
    try {
      const raw = await readFile(join(profileDir(), 'package.json'), 'utf-8')
      const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
      for (const [depName, range] of Object.entries(pkg.dependencies ?? {})) {
        if (/^(github:|git\+https:)/.test(range ?? '')) gitSpecDeps.push(depName)
      }
    } catch {
      // profile 无依赖清单：仅按目录预放行
    }
    for (const plugin of installed) {
      if (githubNames.has(plugin.name) || gitSpecDeps.includes(plugin.name)) {
        const allowed = ensureAllowBuilds(plugin.name)
        if (!allowed.ok) {
          clearOperation()
          return { ok: false, message: allowed.message }
        }
      }
    }
  } catch (err) {
    clearOperation()
    return { ok: false, message: `预放行检查失败：${err instanceof Error ? err.message : String(err)}` }
  }

  logger.info('插件全量更新开始')
  broadcastOpProgress({ op, state: 'start', message: '正在全量更新插件…' })
  try {
    await runPluginCommand('update', '', op)
    logger.info('插件全量更新完成')
    broadcastOpProgress({
      op,
      state: 'done',
      percent: 100,
      message: '全部插件已更新到兼容最新版本，重启运行时后生效'
    })
    return { ok: true, message: '全部插件已更新，重启运行时后生效' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`插件全量更新失败：${message}`)
    broadcastOpProgress({ op, state: 'error', message })
    return { ok: false, message }
  } finally {
    clearOperation()
  }
}

/**
 * 运行 `dsh plugin --profile web <action> [target]`（update 无 target）：
 * - env 注入内嵌 node/pnpm 与 DSH_HOME（buildChildEnv），cwd 为用户 home；
 * - stdout/stderr 按行解析 pnpm 进度并广播（解析不到时广播不确定进度）；
 * - 退出码非 0 抛错（带输出尾部摘要，不含敏感信息）。
 */
function runPluginCommand(
  action: 'add' | 'remove' | 'update',
  target: string,
  op: 'plugin-install' | 'plugin-remove' | 'plugin-update'
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let resolution
    try {
      resolution = resolveRuntime()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const args =
      action === 'update'
        ? [resolution.dshBin, 'plugin', '--profile', 'web', 'update']
        : [resolution.dshBin, 'plugin', '--profile', 'web', action, target]
    const child = spawn(resolution.node, args, {
      env: buildChildEnv(resolution),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: homedir()
    })
    activeChild = child

    let tail = ''
    const feed = (d: string): void => {
      tail = (tail + d).slice(-3_000)
    }
    
    // 单调进度门：ticker 与解析行共用，仅广播更高的 percent，
    // 防止时间兑底 ticker 回退覆盖已广播的行进度（无 percent 的消息行照发）
    let lastPercent = 0
    const broadcastProgress = (percent: number | undefined, message: string): void => {
      if (percent !== undefined) {
        if (percent <= lastPercent) return
        lastPercent = percent
      }
      broadcastOpProgress({ op, state: 'update', percent, message })
    }
    
    // 时间驱动的平滑兑底进度（解析不到行进度时也能给 UI 反馈）：20% → 85%
    const verb = action === 'add' ? '安装' : action === 'remove' ? '卸载' : '更新'
    let fallbackPercent = 20
    const ticker = setInterval(() => {
      if (fallbackPercent < 85) {
        fallbackPercent += 1
        broadcastProgress(
          fallbackPercent,
          `${verb}进行中（pnpm 运行 ${fallbackPercent}%）`
        )
      }
    }, 1_200)
    
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    
    // 行缓冲 + 解析（\r\n 与 \r 均切分；解析成功才广播，行进度优先于时间兜底）
    let restOut = ''
    let restErr = ''
    child.stdout?.on('data', (d: string) => {
      feed(d)
      const { lines, rest } = splitProgressChunk(restOut + d)
      restOut = rest
      emitParsedLines(lines, broadcastProgress)
    })
    child.stderr?.on('data', (d: string) => {
      feed(d)
      const { lines, rest } = splitProgressChunk(restErr + d)
      restErr = rest
      emitParsedLines(lines, broadcastProgress)
    })

    const cleanup = (): void => clearInterval(ticker)

    child.on('error', (err) => {
      cleanup()
      reject(new Error(`无法启动插件命令：${err.message}`))
    })

    child.on('exit', (code) => {
      cleanup()
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`插件命令退出码 ${code}\n${summarizeTail(tail)}`))
      }
    })
  })
}

/** 逐行解析并广播（解析不到则静默，由时间兑底进度覆盖；经单调门控防回退） */
function emitParsedLines(
  lines: string[],
  broadcast: (percent: number | undefined, message: string) => void
): void {
  for (const line of lines) {
    const parsed = parsePluginProgressLine(line)
    if (parsed) {
      broadcast(parsed.percent, parsed.message)
    }
  }
}

/** 输出尾部摘要：截断为最后几行，避免把整个 pnpm 日志塞进 IPC 载荷 */
function summarizeTail(tail: string): string {
  const lines = tail
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines.slice(-6).join(' ｜ ')
}
