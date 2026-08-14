import { dialog, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'
import { logger } from './logger'
import { dshHome } from './runtime/paths'
import type {
  SessionExportFormat,
  SessionSummary,
  SessionsExportResult,
  SessionsListResult,
  SessionsResumeResult,
  SessionsSearchItem,
  SessionsSearchResult,
  WorkspaceSummary
} from '../shared/ipc'

/**
 * 会话管理中心（只读，绝不改写 dsh 自身数据）：
 * - 浏览/列表：官方 workspace.list + session.list RPC（web 就绪时）与
 *   ~/.dsh 本地直读（storages/workspace.json + session_projcache.json +
 *   sessions/<sid>/session.jsonl.zstd mtime）合并，按 id 去重，
 *   标题/轮数/步数等展示元数据以本地投影缓存为准；
 * - 全文搜索：官方 session.search RPC（web 就绪时）；离线兜底为标题/
 *   路径/工作区名的本地元数据匹配；
 * - 导出：zip 走官方 /api/session.export（含子代理会话，需 web 就绪）；
 *   markdown / jsonl 由本地 zstd 帧解码 + 渲染（无需 web，完全离线）；
 * - 恢复：打开主窗口官方 Web 界面（官方 UI 的侧栏即续接入口，
 *   本中心不注入、不改写官方 web 的任何状态）；
 * - 数据契约全部镜像官方 zod schema 形状，官方字段语义原样透传。
 */

/* ── 依赖注入（由 index.ts 提供运行态钩子） ── */

export interface SessionsDeps {
  /** 当前 web 运行状态（phase + 就绪端口；RPC 可用性判断） */
  getWebStatus(): { phase: string; port?: number }
  /** 打开主窗口并确保运行时在跑（恢复会话入口） */
  ensureMainWindow(): void
}

let deps: SessionsDeps | null = null

/** index.ts 在 app ready 时注入运行态钩子 */
export function initSessions(d: SessionsDeps): void {
  deps = d
}

/* ── 本地数据源（~/.dsh，只读） ── */

function sessionsRoot(): string {
  return join(dshHome(), 'sessions')
}

interface LocalWorkspaceRow {
  path?: unknown
  title?: unknown
  sessionIds?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

interface LocalWorkspaceStore {
  workspaces: Map<string, LocalWorkspaceRow>
  /** 官方展示顺序（workspaceIds） */
  order: string[]
  archivedSessionIds: string[]
}

interface LocalSessionRow {
  createdAt: number
  cwd?: string
  title?: string
  turns?: number
  steps?: number
}

/** 读取本地工作区存储（storages/workspace.json，损坏返回空 store） */
function readLocalWorkspaceStore(): LocalWorkspaceStore {
  const store: LocalWorkspaceStore = { workspaces: new Map(), order: [], archivedSessionIds: [] }
  try {
    const raw = JSON.parse(
      readFileSyncQuiet(join(dshHome(), 'storages', 'workspace.json')) ?? '{}'
    ) as {
      global?: { workspaceIds?: unknown; archivedSessionIds?: unknown }
      tables?: { workspaces?: Record<string, LocalWorkspaceRow> }
    }
    const ids = Array.isArray(raw.global?.workspaceIds)
      ? raw.global.workspaceIds.filter((v): v is string => typeof v === 'string')
      : []
    store.order = ids
    const archived = Array.isArray(raw.global?.archivedSessionIds)
      ? raw.global.archivedSessionIds.filter((v): v is string => typeof v === 'string')
      : []
    store.archivedSessionIds = archived
    const table = raw.tables?.workspaces
    if (table && typeof table === 'object') {
      for (const [id, row] of Object.entries(table)) {
        if (row && typeof row === 'object') store.workspaces.set(id, row)
      }
    }
  } catch {
    // 存储缺失/损坏：视为空（离线首启场景）
  }
  return store
}

/** 读取本地会话投影缓存（storages/session_projcache.json）：标题 / 轮数 / 步数 */
function readLocalSessionCache(): Map<string, LocalSessionRow> {
  const out = new Map<string, LocalSessionRow>()
  try {
    const raw = JSON.parse(
      readFileSyncQuiet(join(dshHome(), 'storages', 'session_projcache.json')) ?? '{}'
    ) as { tables?: { sessions?: Record<string, unknown> } }
    const table = raw.tables?.sessions
    if (!table || typeof table !== 'object') return out
    for (const [sid, entry] of Object.entries(table)) {
      if (!entry || typeof entry !== 'object') continue
      const identity = (entry as { identity?: unknown }).identity
      const rows = (entry as { rows?: Record<string, unknown> }).rows ?? {}
      const row: LocalSessionRow = { createdAt: 0 }
      if (identity && typeof identity === 'object') {
        const i = identity as { createdAt?: unknown; cwd?: unknown }
        if (typeof i.createdAt === 'number') row.createdAt = i.createdAt
        if (typeof i.cwd === 'string') row.cwd = i.cwd
      }
      const titleRow = rows['title'] as { val?: unknown } | undefined
      if (titleRow && typeof titleRow.val === 'string' && titleRow.val.length > 0) {
        row.title = titleRow.val
      }
      const statsRow = rows['sessionStats'] as { val?: unknown } | undefined
      if (statsRow && typeof statsRow.val === 'object' && statsRow.val !== null) {
        const stats = statsRow.val as Record<string, unknown>
        const num = (v: unknown): number | undefined =>
          typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : typeof v === 'number' ? v : undefined
        row.turns = num(stats['turns'])
        row.steps = num(stats['steps'])
      }
      out.set(sid, row)
    }
  } catch {
    // 缓存缺失/损坏：视为空
  }
  return out
}

/** 同步读取（小文件）；失败返回 null */
function readFileSyncQuiet(file: string): string | null {
  try {
    // 本地存储均为小 JSON，同步读保证列表接口的确定性
    return readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

/** 工件扫描（异步；用于 updatedAt 兜底与本地导出定位） */
async function scanLocalArtifacts(): Promise<
  Map<string, { path: string; mtimeMs: number; bytes: number }>
> {
  const out = new Map<string, { path: string; mtimeMs: number; bytes: number }>()
  const root = sessionsRoot()
  let workspaceDirs: string[] = []
  try {
    workspaceDirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name))
  } catch {
    return out
  }
  for (const wsDir of workspaceDirs) {
    try {
      const sessionDirs = (await readdir(wsDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => join(wsDir, d.name))
      for (const sDir of sessionDirs) {
        const file = join(sDir, 'session.jsonl.zstd')
        try {
          const st = await stat(file)
          out.set(basename(sDir), { path: file, mtimeMs: st.mtimeMs, bytes: st.size })
        } catch {
          // 无工件（空白会话）
        }
      }
    } catch {
      // 单个工作区目录读取失败不影响其余
    }
  }
  return out
}

/* ── 官方 RPC 桥（browser-trust fence 放行无 Origin 的本机主进程请求） ── */

interface RpcResult<T> {
  ok: true
  value: T
}

/** 调用官方 /api/<method>；web 未就绪或业务失败抛错（20s 超时防挂死） */
async function dshRpc<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const status = deps?.getWebStatus()
  const port = status?.port
  if (!port || status?.phase !== 'ready') {
    throw new Error('dsh web 未就绪，官方接口暂不可用')
  }
  const url = `http://127.0.0.1:${port}/api/${method}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      signal: AbortSignal.timeout(20_000)
    })
  } catch (err) {
    throw new Error(`官方接口不可达：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`官方接口返回 ${res.status}`)
  }
  const envelope = (await res.json()) as {
    result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
  }
  const result = envelope.result
  if (!result || result.ok !== true) {
    throw new Error(result?.error?.message ?? '官方接口返回业务失败')
  }
  return result.value as T
}

/* ── 工作区列表 ── */

export async function listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
  const local = readLocalWorkspaceStore()
  let official: WorkspaceSummary[] = []
  let officialOk = false
  try {
    const value = await dshRpc<{ items?: unknown[] }>('workspace.list', {})
    if (Array.isArray(value.items)) {
      official = value.items.map((item) => toWorkspaceSummary(item as Record<string, unknown>))
      officialOk = true
    }
  } catch (err) {
    logger.info(`会话中心：官方 workspace.list 不可用（${err instanceof Error ? err.message : String(err)}），回退本地存储`)
  }

  if (!officialOk) {
    // 本地兜底：order 优先，其余按 updatedAt 倒序
    const localList = [...local.workspaces.entries()].map(([id, row]) =>
      localWorkspaceToSummary(id, row)
    )
    const byId = new Map(localList.map((w) => [w.workspaceId, w]))
    const ordered = local.order
      .map((id) => byId.get(id))
      .filter((w): w is WorkspaceSummary => w !== undefined)
    const rest = localList
      .filter((w) => !ordered.some((o) => o.workspaceId === w.workspaceId))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return { workspaces: [...ordered, ...rest] }
  }

  // 官方为主，本地补充（sessionCount 用官方 sessionIds；本地无该工作区则直接透传）
  const localById = new Map([...local.workspaces.entries()])
  return {
    workspaces: official.map((w) => {
      const lr = localById.get(w.workspaceId)
      if (!lr) return w
      return { ...w, title: w.title || (typeof lr.title === 'string' ? lr.title : w.title) }
    })
  }
}

function toWorkspaceSummary(item: Record<string, unknown>): WorkspaceSummary {
  const sessionIds = Array.isArray(item['sessionIds']) ? item['sessionIds'].length : 0
  const path = typeof item['path'] === 'string' ? item['path'] : ''
  const title = typeof item['title'] === 'string' && item['title'].length > 0 ? item['title'] : basename(path)
  return {
    workspaceId: typeof item['workspaceId'] === 'string' ? item['workspaceId'] : '',
    path,
    title,
    sessionCount: sessionIds,
    createdAt: typeof item['createdAt'] === 'string' ? item['createdAt'] : '',
    updatedAt: typeof item['updatedAt'] === 'string' ? item['updatedAt'] : ''
  }
}

function localWorkspaceToSummary(id: string, row: LocalWorkspaceRow): WorkspaceSummary {
  const path = typeof row.path === 'string' ? row.path : ''
  const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : basename(path)
  const sessionIds = Array.isArray(row.sessionIds) ? row.sessionIds.length : 0
  return {
    workspaceId: id,
    path,
    title,
    sessionCount: sessionIds,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : ''
  }
}

/* ── 会话列表 ── */

export async function listSessions(workspaceId?: string): Promise<SessionsListResult> {
  const localCache = readLocalSessionCache()
  const localStore = readLocalWorkspaceStore()
  const artifacts = await scanLocalArtifacts()

  let officialItems: SessionSummary[] = []
  let source: SessionsListResult['source'] = 'local'
  try {
    const [wsValue, listValue] = await Promise.all([
      dshRpc<{ items?: unknown[]; archivedSessionIds?: unknown[] }>('workspace.list', {}),
      dshRpc<{ items?: unknown[] }>('session.list', {})
    ])
    const wsItems = (Array.isArray(wsValue.items) ? wsValue.items : []) as Array<
      Record<string, unknown>
    >
    const archived = Array.isArray(wsValue.archivedSessionIds)
      ? wsValue.archivedSessionIds.filter((v): v is string => typeof v === 'string')
      : []
    const wsSessionIds = new Map<string, string>()
    for (const ws of wsItems) {
      const wid = typeof ws['workspaceId'] === 'string' ? ws['workspaceId'] : ''
      const ids = Array.isArray(ws['sessionIds']) ? ws['sessionIds'] : []
      for (const sid of ids) {
        if (typeof sid === 'string') wsSessionIds.set(sid, wid)
      }
    }
    const rawItems = (Array.isArray(listValue.items) ? listValue.items : []) as Array<
      Record<string, unknown>
    >
    for (const item of rawItems) {
      const sid = typeof item['sessionId'] === 'string' ? item['sessionId'] : ''
      if (!sid) continue
      const summary = officialSessionToSummary(item)
      const wid = wsSessionIds.get(sid)
      if (wid) summary.workspaceId = wid
      const cached = localCache.get(sid)
      if (cached) {
        summary.title = cached.title ?? summary.title
        if (typeof cached.turns === 'number') summary.turns = cached.turns
        if (typeof cached.steps === 'number') summary.steps = cached.steps
        if (!summary.cwd && cached.cwd) summary.cwd = cached.cwd
      }
      const artifact = artifacts.get(sid)
      if (artifact) {
        if (!summary.updatedAt || artifact.mtimeMs > summary.updatedAt) {
          summary.updatedAt = artifact.mtimeMs
        }
        if (summary.createdAt === 0 && cached?.createdAt) summary.createdAt = cached.createdAt
      }
      officialItems.push(summary)
    }
    source = 'official'
    if (workspaceId) {
      officialItems = officialItems.filter((s) => s.workspaceId === workspaceId)
    }
    const merged = mergeSessions(officialItems, localStore, localCache, workspaceId)
    return { items: merged, archivedSessionIds: archived, source }
  } catch (err) {
    logger.info(`会话中心：官方会话列表不可用（${err instanceof Error ? err.message : String(err)}），回退本地数据`)
  }

  // 本地兜底：projcache（标题/轮数/步数）+ 工件 mtime + workspace 归属
  const items: SessionSummary[] = []
  const wsSessionMap = new Map<string, string>()
  for (const [wid, row] of localStore.workspaces.entries()) {
    const ids = Array.isArray(row.sessionIds) ? row.sessionIds : []
    for (const sid of ids) {
      if (typeof sid === 'string') wsSessionMap.set(sid, wid)
    }
  }
  for (const [sid, cached] of localCache.entries()) {
    const artifact = artifacts.get(sid)
    const item: SessionSummary = {
      sessionId: sid,
      workspaceId: wsSessionMap.get(sid),
      title: cached.title ?? '',
      cwd: cached.cwd,
      running: false,
      blank: false,
      createdAt: cached.createdAt,
      updatedAt: artifact?.mtimeMs ?? cached.createdAt,
      turns: cached.turns,
      steps: cached.steps
    }
    items.push(item)
  }
  // projcache 未收录但工件存在的会话（极少见）：以工件为准的骨架条目
  for (const [sid, artifact] of artifacts.entries()) {
    if (localCache.has(sid)) continue
    items.push({
      sessionId: sid,
      workspaceId: wsSessionMap.get(sid),
      title: '',
      running: false,
      blank: false,
      createdAt: artifact.mtimeMs,
      updatedAt: artifact.mtimeMs
    })
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt)
  const filtered = workspaceId ? items.filter((s) => s.workspaceId === workspaceId) : items
  return { items: filtered, archivedSessionIds: localStore.archivedSessionIds, source: 'local' }
}

function officialSessionToSummary(item: Record<string, unknown>): SessionSummary {
  return {
    sessionId: typeof item['sessionId'] === 'string' ? item['sessionId'] : '',
    title: '',
    cwd: typeof item['cwd'] === 'string' ? item['cwd'] : undefined,
    origin: item['origin'] === 'subagent' ? 'subagent' : undefined,
    parentSessionId: typeof item['parentSessionId'] === 'string' ? item['parentSessionId'] : undefined,
    running: item['running'] === true,
    blank: item['blank'] === true,
    createdAt: 0,
    updatedAt: typeof item['updatedAt'] === 'number' ? item['updatedAt'] : 0
  }
}

/** 官方列表与本地数据合并：官方条目为准，补本地元数据；本地独有条目兜底保留 */
function mergeSessions(
  official: SessionSummary[],
  localStore: LocalWorkspaceStore,
  localCache: Map<string, LocalSessionRow>,
  workspaceId?: string
): SessionSummary[] {
  const byId = new Map(official.map((s) => [s.sessionId, s]))
  const wsSessionMap = new Map<string, string>()
  for (const [wid, row] of localStore.workspaces.entries()) {
    const ids = Array.isArray(row.sessionIds) ? row.sessionIds : []
    for (const sid of ids) {
      if (typeof sid === 'string' && !wsSessionMap.has(sid)) wsSessionMap.set(sid, wid)
    }
  }
  for (const [sid, cached] of localCache.entries()) {
    const existing = byId.get(sid)
    if (existing) {
      if (!existing.title && cached.title) existing.title = cached.title
      if (typeof existing.turns !== 'number' && typeof cached.turns === 'number') {
        existing.turns = cached.turns
      }
      if (typeof existing.steps !== 'number' && typeof cached.steps === 'number') {
        existing.steps = cached.steps
      }
      if (!existing.workspaceId) existing.workspaceId = wsSessionMap.get(sid)
      continue
    }
    byId.set(sid, {
      sessionId: sid,
      workspaceId: wsSessionMap.get(sid),
      title: cached.title ?? '',
      cwd: cached.cwd,
      running: false,
      blank: false,
      createdAt: cached.createdAt,
      updatedAt: cached.createdAt,
      turns: cached.turns,
      steps: cached.steps
    })
  }
  const list = [...byId.values()]
    .filter((s) => (workspaceId ? s.workspaceId === workspaceId : true))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return list
}

/* ── 全文搜索 ── */

export async function searchSessions(query: string): Promise<SessionsSearchResult> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { items: [], hasMore: false, source: 'local' }

  // 官方 session.search（web 就绪时）：真实全文 + 片段
  try {
    const value = await dshRpc<{ items?: unknown[]; hasMore?: unknown }>('session.search', {
      query: trimmed
    })
    const cache = readLocalSessionCache()
    const items = (Array.isArray(value.items) ? value.items : []).map((raw) => {
      const item = raw as Record<string, unknown>
      const sid = typeof item['sessionId'] === 'string' ? item['sessionId'] : ''
      const cached = cache.get(sid)
      return {
        sessionId: sid,
        snippet: typeof item['snippet'] === 'string' ? item['snippet'] : '',
        title: cached?.title,
        cwd: cached?.cwd,
        updatedAt: cached?.createdAt
      } satisfies SessionsSearchItem
    })
    return { items, hasMore: value.hasMore === true, source: 'official' }
  } catch (err) {
    logger.info(`会话中心：官方 session.search 不可用（${err instanceof Error ? err.message : String(err)}），回退本地匹配`)
  }

  // 本地兜底：标题 / 路径 / 工作区名 元数据匹配
  const needle = trimmed.toLowerCase()
  const { items: all } = await listSessions()
  const workspaces = new Map((await listWorkspaces()).workspaces.map((w) => [w.workspaceId, w.title]))
  const matches: SessionsSearchItem[] = []
  for (const s of all) {
    const haystack = [s.title, s.cwd ?? '', workspaces.get(s.workspaceId ?? '') ?? '']
      .join(' ')
      .toLowerCase()
    if (haystack.includes(needle)) {
      matches.push({
        sessionId: s.sessionId,
        snippet: s.title || s.cwd || '未命名会话',
        title: s.title,
        cwd: s.cwd,
        updatedAt: s.updatedAt
      })
    }
  }
  matches.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return { items: matches.slice(0, 20), hasMore: matches.length > 20, source: 'local' }
}

/* ── 导出 ── */

export async function exportSession(
  sessionId: string,
  format: SessionExportFormat,
  includeDescendants: boolean
): Promise<SessionsExportResult> {
  if (format === 'zip') {
    return exportViaOfficialEndpoint(sessionId, includeDescendants)
  }
  return exportLocalRender(sessionId, format)
}

/** 官方 zip 存档：GET /api/session.export（含子代理会话，需 web 就绪） */
async function exportViaOfficialEndpoint(
  sessionId: string,
  includeDescendants: boolean
): Promise<SessionsExportResult> {
  const status = deps?.getWebStatus()
  const port = status?.port
  if (!port || status?.phase !== 'ready') {
    return {
      ok: false,
      message: '官方存档导出需要 dsh web 运行中，请先打开主窗口启动运行时'
    }
  }
  const url = `http://127.0.0.1:${port}/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=${includeDescendants ? 'true' : 'false'}`
  let res: Response
  try {
    res = await fetch(url, { method: 'GET' })
  } catch (err) {
    return { ok: false, message: `导出请求失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!res.ok) {
    return { ok: false, message: `导出失败（HTTP ${res.status}）：会话不存在或运行时不支持导出` }
  }
  const disposition = res.headers.get('content-disposition') ?? ''
  const filenameMatch = /filename="?([^";]+)"?/.exec(disposition)
  const defaultName = filenameMatch?.[1] ?? `session-${sessionId.slice(0, 8)}.zip`
  const saved = await saveViaDialog(defaultName, [{ name: 'ZIP 存档', extensions: ['zip'] }])
  if (!saved) return { ok: false, cancelled: true }
  try {
    if (!res.body) throw new Error('响应无内容流')
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(saved))
  } catch (err) {
    return { ok: false, message: `写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, path: saved }
}

/** 本地渲染导出：zstd 帧解码（官方帧扫描算法）+ markdown/jsonl 输出 */
async function exportLocalRender(
  sessionId: string,
  format: 'markdown' | 'jsonl'
): Promise<SessionsExportResult> {
  const artifact = await locateArtifact(sessionId)
  if (!artifact) {
    return { ok: false, message: '未找到该会话的本地记录（可能尚未持久化）' }
  }
  if (typeof (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync !== 'function') {
    return { ok: false, message: '当前运行时缺少 zstd 解压支持，无法本地导出' }
  }
  let lines: string[]
  try {
    lines = decompressSessionLines(artifact.path)
  } catch (err) {
    return { ok: false, message: `会话记录解析失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const ext = format === 'markdown' ? 'md' : 'jsonl'
  const defaultName = `${sanitizeFilename(sessionId)}.${ext}`
  const saved = await saveViaDialog(defaultName, [
    format === 'markdown'
      ? { name: 'Markdown 文档', extensions: ['md'] }
      : { name: 'JSONL 会话日志', extensions: ['jsonl'] }
  ])
  if (!saved) return { ok: false, cancelled: true }

  const content =
    format === 'markdown' ? renderMarkdown(lines) : `${lines.join('\n')}\n`
  try {
    await writeFile(saved, content, 'utf-8')
  } catch (err) {
    return { ok: false, message: `写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, path: saved }
}

async function locateArtifact(sessionId: string): Promise<{ path: string } | null> {
  const artifacts = await scanLocalArtifacts()
  const found = artifacts.get(sessionId)
  return found ? { path: found.path } : null
}

async function saveViaDialog(
  defaultName: string,
  filters: Electron.FileFilter[]
): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: '导出会话',
    defaultPath: defaultName,
    filters
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

/* ── zstd：官方帧扫描算法（与 dsh-session-persistence-jsonl 完全一致） ── */

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 little-endian

export function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`会话记录帧头损坏（字节 ${offset}）`)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`会话记录帧头包含保留位（字节 ${offset - 1}）`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`会话记录包含保留块类型（字节 ${offset - 3}）`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** 会话文件 → JSONL 行数组（每行一个 JSON 字符串；损坏行跳过并计数告警） */
export function decompressSessionLines(file: string): string[] {
  const raw = readFileSync(file)
  const zstdDecompressSync = (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer })
    .zstdDecompressSync
  const frames = scanZstdFrames(raw)
  if (frames.length === 0) {
    throw new Error('会话记录不含有效帧（空文件？）')
  }
  const lines: string[] = []
  let skipped = 0
  for (const { start, end } of frames) {
    let text: string
    try {
      text = zstdDecompressSync(raw.subarray(start, end)).toString('utf-8')
    } catch (err) {
      throw new Error(`解压帧失败（字节 ${start}）：${err instanceof Error ? err.message : String(err)}`)
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        JSON.parse(line)
        lines.push(line)
      } catch {
        skipped += 1
      }
    }
  }
  if (skipped > 0) {
    logger.warn(`会话导出：${skipped} 行非 JSON 记录已跳过`)
  }
  return lines
}

/* ── Markdown 渲染（事件 → 可读文档） ── */

/** 内容块 → 纯文本（text 块拼接；reasoning 块默认不导出） */
function textOfMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const message = (data as { message?: unknown }).message
  const content = message
    ? (message as { content?: unknown }).content
    : (data as { content?: unknown }).content
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return content
    return ''
  }
  const texts = content
    .filter(
      (b): b is { type: string; text?: unknown } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text'
    )
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter((t) => t.length > 0)
  return texts.join('\n\n')
}

/** 工具结果 → 展示摘要（取文本块，截断） */
function textOfToolResult(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const content = (data as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const inner = (block as { content?: unknown }).content
    if (!Array.isArray(inner)) continue
    for (const b of inner) {
      if (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text') {
        const t = (b as { text?: unknown }).text
        if (typeof t === 'string' && t.length > 0) parts.push(t)
      }
    }
  }
  return parts.join('\n\n')
}

function limitText(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…（截断）` : trimmed
}

export function renderMarkdown(lines: string[]): string {
  const parts: string[] = []
  for (const raw of lines) {
    let obj: { type?: unknown; id?: unknown; createdAt?: unknown; data?: unknown; seq?: unknown; time?: unknown }
    try {
      obj = JSON.parse(raw) as typeof obj
    } catch {
      continue
    }
    const type = typeof obj.type === 'string' ? obj.type : ''
    const data = obj.data
    switch (type) {
      case 'session': {
        const id = typeof obj.id === 'string' ? obj.id : ''
        const created = typeof obj.createdAt === 'number' ? new Date(obj.createdAt).toLocaleString() : ''
        parts.push(`# 会话${id ? ` ${id.slice(0, 8)}` : ''}${created ? `\n\n> 创建于 ${created}` : ''}\n\n`)
        break
      }
      case 'session/title': {
        const title = (data as { title?: unknown } | undefined)?.title
        if (typeof title === 'string' && title.length > 0) parts.push(`# ${title}\n\n`)
        break
      }
      case 'user/message': {
        const text = textOfMessage(data)
        if (text) parts.push(`## 用户\n\n${text}\n\n`)
        break
      }
      case 'assistant/message': {
        const text = textOfMessage(data)
        if (text) parts.push(`## DeepSeek\n\n${text}\n\n`)
        break
      }
      case 'tool/call': {
        const d = (data ?? {}) as Record<string, unknown>
        const name = typeof d['name'] === 'string' ? d['name'] : '未知工具'
        let argsText = ''
        try {
          argsText = JSON.stringify(d['arguments'] ?? d['args'] ?? {}, null, 2)
        } catch {
          argsText = ''
        }
        parts.push(`> 🔧 工具调用 \`${name}\`\n>\n> ${limitText(argsText, 400)}\n\n`)
        break
      }
      case 'tool/result': {
        const text = textOfToolResult(data)
        if (text) parts.push(`> 📥 工具结果\n>\n> ${limitText(text, 800)}\n\n`)
        break
      }
      default:
        break
    }
  }
  const out = parts.join('')
  return out.length > 0 ? out : '（无可渲染的对话内容）\n'
}

function sanitizeFilename(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 64)
  return clean.length > 0 ? clean : 'session'
}

/* ── 恢复 / 打开目录 ── */

export function resumeSession(sessionId: string): SessionsResumeResult {
  if (!deps) {
    return { ok: false, message: '会话服务尚未初始化' }
  }
  deps.ensureMainWindow()
  // 空 id = 仅打开官方界面（工作区卡片入口）；非空 = 恢复指定会话（官方侧栏续接）
  return sessionId
    ? { ok: true, message: '已打开官方 Web 界面，在会话侧栏中继续' }
    : { ok: true, message: '已打开官方 Web 界面' }
}

export async function openWorkspaceFolder(path: string): Promise<{ ok: boolean; message?: string }> {
  if (!path || path.length === 0) {
    return { ok: false, message: '工作区路径为空' }
  }
  const error = await shell.openPath(path)
  if (error) {
    logger.warn(`打开工作区目录失败：${error}`)
    return { ok: false, message: `无法打开目录：${error}` }
  }
  return { ok: true }
}
