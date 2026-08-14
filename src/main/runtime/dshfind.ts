import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger'
import type { MarketPluginEntry, MarketSearchResult } from '../../shared/ipc'

/**
 * dshfind.com 插件市场接入（在线搜索 + 一键安装）：
 * - 数据源：https://dshfind.com/zh/plugins 的服务端渲染卡片列表（全量 ~800+ 条目），
 *   主进程拉取一次并缓存（userData/market/dshfind.json，TTL 24h），搜索在本地进行；
 * - 安装规格：dshfind 官方安装命令 `dsh plugin add github:<author>/<name>`，
 *   与我们的 GitHub 直装通道（allowBuilds 预放行 + 白名单校验）完全复用；
 * - 页面结构变化时解析结果为空 → 报告「市场数据解析失败」，绝不静默产出垃圾条目；
 * - 网络失败 → 回退缓存（陈旧标注）；无缓存 → 明确报错，UI 可提示在浏览器打开。
 */

const MARKET_URL = 'https://dshfind.com/zh/plugins'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

interface MarketCache {
  fetchedAt: string
  entries: MarketPluginEntry[]
}

function cacheFile(): string {
  return join(app.getPath('userData'), 'market', 'dshfind.json')
}

function readCache(): MarketCache | null {
  try {
    const raw = readFileSync(cacheFile(), 'utf-8')
    const parsed = JSON.parse(raw) as MarketCache
    if (!Array.isArray(parsed.entries) || typeof parsed.fetchedAt !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(cache: MarketCache): void {
  try {
    mkdirSync(join(app.getPath('userData'), 'market'), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(cache), 'utf-8')
  } catch (err) {
    logger.warn(`市场缓存写入失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 拉取 dshfind 列表页并解析（网络失败抛错；解析为空返回空数组+网络来源） */
async function fetchMarket(): Promise<MarketCache> {
  const res = await fetch(MARKET_URL, {
    headers: {
      accept: 'text/html',
      'user-agent': 'Deepseek-Harness-Desktop/0.1 (+https://github.com/deepseek-harness-desktop)'
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) {
    throw new Error(`dshfind 返回 HTTP ${res.status}`)
  }
  const text = await res.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('dshfind 页面体积超限，放弃解析')
  }
  const entries = parseDshfindCards(text)
  if (entries.length === 0) {
    throw new Error('dshfind 页面结构变化，未能解析出任何插件条目')
  }
  return { fetchedAt: new Date().toISOString(), entries }
}

/* ── 卡片解析（纯函数，可单测） ── */

/**
 * 从 dshfind 列表页 HTML 解析插件卡片：
 * 卡片锚点 `/zh/plugins/<author>/<name>` → 窗口内提取描述（card-description）、
 * 星数（lucide-star）、更新信息（更新于）、仓库链接（github.com）。
 * 安装规格 = `github:<author>/<name>`（与 dshfind 官方安装命令一致）。
 */
export function parseDshfindCards(html: string): MarketPluginEntry[] {
  const anchorPattern = /href="\/zh\/plugins\/([A-Za-z0-9_.@-]+)\/([A-Za-z0-9_.@-]+)"[^>]*>([\s\S]{0,90}?)<\/a>/g
  const seen = new Set<string>()
  const entries: MarketPluginEntry[] = []
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html)) !== null) {
    const author = match[1]
    const name = match[2]
    const displayName = match[3]?.replace(/<!-- -->/g, '').trim() || name
    const key = `${author}/${name}`
    if (seen.has(key)) continue
    seen.add(key)
    // 卡片窗口：从锚点起至下一张卡片锚点（或 4000 字符上限），防止跨卡片误取字段
    const windowRaw = html.slice(match.index, match.index + 4000)
    const nextCard = windowRaw.indexOf('href="/zh/plugins/', 10)
    const window = nextCard > 0 ? windowRaw.slice(0, nextCard) : windowRaw
    const description = /data-slot="card-description"[^>]*>([^<]{1,300})</.exec(window)?.[1]?.trim()
    const stars = /lucide-star[^>]*>[\s\S]*?<\/svg>([0-9k.]+)/.exec(window)?.[1]?.trim()
    // 更新信息与仓库链接都含 HTML 注释/多链接，需去注释并取卡片内最后一个 github 链接（仓库按钮在作者链接之后）
    const updated = /title="更新于"[^>]*>([\s\S]{1,90}?)<\/span>/.exec(window)?.[1]
      ?.replace(/<!-- -->/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const repoLinks = [...window.matchAll(/href="(https:\/\/github\.com\/[^"]+)"/g)].map(
      (m) => m[1]
    )
    const repoUrl = repoLinks[repoLinks.length - 1]
    entries.push({
      name,
      displayName: displayName && displayName !== name ? displayName : undefined,
      author,
      description: description || undefined,
      stars: stars || undefined,
      updated: updated || undefined,
      repoUrl,
      installSpec: `github:${author}/${name}`
    })
  }
  // 按星数降序（解析值是字符串，数字优先于 'k' 等缩写；无星数排后）
  entries.sort((a, b) => {
    const rank = (s?: string): number => {
      if (!s) return -1
      const n = Number(s)
      if (Number.isFinite(n)) return n
      const km = /^([0-9.]+)k$/.exec(s.toLowerCase())
      return km ? Number(km[1]) * 1000 : 0
    }
    return rank(b.stars) - rank(a.stars)
  })
  return entries
}

/* ── 搜索入口（缓存优先 + TTL 刷新） ── */

/** 保证缓存就绪：缺失/过期则拉取；拉取失败回退陈旧缓存或抛错 */
async function ensureCache(force: boolean): Promise<{ cache: MarketCache; source: 'cache' | 'network' }> {
  const cached = readCache()
  const fresh =
    cached !== null && !force && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS
  if (fresh) {
    return { cache: cached, source: 'cache' }
  }
  try {
    const cache = await fetchMarket()
    writeCache(cache)
    return { cache, source: 'network' }
  } catch (err) {
    logger.warn(`dshfind 市场刷新失败：${err instanceof Error ? err.message : String(err)}`)
    if (cached) {
      return { cache: cached, source: 'cache' }
    }
    throw err
  }
}

export async function searchMarket(
  query: string,
  force = false
): Promise<MarketSearchResult> {
  const trimmed = (query ?? '').trim().toLowerCase()
  const { cache, source } = await ensureCache(force)
  let items = cache.entries
  if (trimmed.length > 0) {
    items = items.filter((entry) => {
      const haystack = [entry.name, entry.author, entry.description ?? '']
        .join(' ')
        .toLowerCase()
      return haystack.includes(trimmed)
    })
  }
  return {
    items: items.slice(0, 50),
    total: items.length,
    fetchedAt: cache.fetchedAt,
    source
  }
}

/** 强制刷新市场数据（用户点击刷新按钮） */
export async function refreshMarket(): Promise<MarketSearchResult> {
  return searchMarket('', true)
}
