import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { MarketSearchResult, PluginEntry } from '../shared/ipc'

export interface WebBridgeDeps {
  searchMarket(query: string): Promise<MarketSearchResult>
  listPlugins(): Promise<PluginEntry[]>
  installPlugin(name: string, version?: string, spec?: string): Promise<{ ok: boolean; message?: string }>
}

/**
 * 仅供官方 Web 扩展调用的本机桥接。
 *
 * 扩展仍在 dsh 的官方 Client slot 内渲染；桥接只把「市场检索 / 安装」这两项
 * 原生能力提供给该 slot。它绑定 loopback 并校验 dsh origin，
 * 不向网络页面或 Electron 的其他窗口暴露 IPC。
 */
export class OfficialWebBridge {
  private server: Server | null = null
  private port: number | null = null
  private dshOrigin: string | null = null

  constructor(private readonly deps: WebBridgeDeps) {}

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('本机 Web 桥接未获得端口')
    this.port = address.port
  }

  setDshUrl(url: string): void {
    const parsed = new URL(url)
    this.dshOrigin = parsed.origin
  }

  /** 只传递 loopback 端口；来源限制由 dsh Web 的精确 origin 承担。 */
  attach(url: string): string {
    if (this.port === null) return url
    const parsed = new URL(url)
    parsed.searchParams.set('dshDesktopBridge', `127.0.0.1:${this.port}`)
    return parsed.toString()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    this.dshOrigin = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin
    if (!this.dshOrigin || origin !== this.dshOrigin) {
      this.reply(res, 403, { ok: false, message: '请求未获授权' })
      return
    }
    this.cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://bridge.local')
    try {
      if (req.method === 'GET' && url.pathname === '/market') {
        const result = await this.deps.searchMarket(url.searchParams.get('q') ?? '')
        this.reply(res, 200, result)
        return
      }
      if (req.method === 'GET' && url.pathname === '/plugins') {
        this.reply(res, 200, { plugins: await this.deps.listPlugins() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/plugins/install') {
        const body = await readJson(req)
        if (!isInstallRequest(body)) {
          this.reply(res, 400, { ok: false, message: '插件参数无效' })
          return
        }
        this.reply(res, 200, await this.deps.installPlugin(body.name, body.version, body.spec))
        return
      }
      this.reply(res, 404, { ok: false, message: '接口不存在' })
    } catch {
      this.reply(res, 500, { ok: false, message: '操作失败，请稍后重试' })
    }
  }

  private cors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', this.dshOrigin ?? 'null')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Vary', 'Origin')
  }

  private reply(res: ServerResponse, status: number, payload: unknown): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.writeHead(status)
    res.end(JSON.stringify(payload))
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += String(chunk)
    if (raw.length > 16_384) throw new Error('请求过大')
  }
  return JSON.parse(raw)
}

function isInstallRequest(value: unknown): value is { name: string; version?: string; spec?: string } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.name === 'string' && candidate.name.length > 0 && candidate.name.length <= 200
    && (candidate.version === undefined || typeof candidate.version === 'string')
    && (candidate.spec === undefined || typeof candidate.spec === 'string')
}
