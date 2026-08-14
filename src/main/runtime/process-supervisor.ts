import { EventEmitter } from 'node:events'
import { spawn, ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { app } from 'electron'
import { join } from 'node:path'
import http from 'node:http'
import { buildChildEnv, resolveRuntime, type RuntimeResolution } from './paths'

const DEFAULT_PORT = 3080
const READY_TIMEOUT_MS = 60_000
const READY_POLL_INTERVAL_MS = 200
const SIGTERM_GRACE_MS = 5_000
const TAIL_LINES = 200

/** 环形缓冲：只保留最后 N 行输出 */
class LineTail {
  private lines: string[] = []
  private partial = ''

  constructor(private readonly max: number) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/)
    this.partial = parts.pop() ?? ''
    for (const line of parts) {
      this.lines.push(line)
      if (this.lines.length > this.max) this.lines.shift()
    }
  }

  flush(): void {
    if (this.partial.length > 0) {
      this.lines.push(this.partial)
      if (this.lines.length > this.max) this.lines.shift()
      this.partial = ''
    }
  }

  toString(): string {
    return [...this.lines, ...(this.partial ? [this.partial] : [])].join('\n')
  }
}

/** 启动流程的阶段节点（供上层转换为 OpProgress 广播） */
export type BootStage = 'resolve-runtime' | 'allocate-port' | 'spawn' | 'wait-ready'

export interface SupervisorEvents {
  ready: (info: { port: number; url: string }) => void
  error: (info: { message: string; stderrTail: string; exitCode: number | null }) => void
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  progress: (info: { stage: BootStage; message: string }) => void
}

export declare interface ProcessSupervisor {
  on<E extends keyof SupervisorEvents>(event: E, listener: SupervisorEvents[E]): this
  once<E extends keyof SupervisorEvents>(event: E, listener: SupervisorEvents[E]): this
  emit<E extends keyof SupervisorEvents>(event: E, ...args: Parameters<SupervisorEvents[E]>): boolean
}

/**
 * dsh web 子进程托管：
 * - 从 3080 起探测空闲端口
 * - spawn 内嵌（或系统）node 运行 dsh web
 * - 200ms 轮询 HTTP 就绪（60s 超时）
 * - 优雅停止：SIGTERM → 5s → SIGKILL
 * - pid 文件落盘于 userData，用于孤儿进程诊断/清理
 */
export class ProcessSupervisor extends EventEmitter {
  private child: ChildProcess | null = null
  private stdoutTail = new LineTail(TAIL_LINES)
  private stderrTail = new LineTail(TAIL_LINES)
  private readyTimer: NodeJS.Timeout | null = null
  private stoppedByUser = false
  private resolution: RuntimeResolution | null = null

  private currentPhase: 'starting' | 'ready' | 'stopped' = 'stopped'
  private currentPort: number | null = null

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  get port(): number | null {
    return this.currentPort
  }

  /** 当前阶段（只读视图，不改变状态机） */
  get phase(): 'starting' | 'ready' | 'stopped' {
    return this.currentPhase
  }

  /** 就绪时返回 web 地址，否则 null（供上层复用已就绪进程） */
  get url(): string | null {
    return this.currentPhase === 'ready' && this.currentPort !== null
      ? `http://127.0.0.1:${this.currentPort}`
      : null
  }

  private get pidFilePath(): string {
    return join(app.getPath('userData'), 'dsh-web.pid')
  }

  /** 从 startPort 起找一个未被占用的端口 */
  private async findFreePort(startPort = DEFAULT_PORT): Promise<number> {
    for (let port = startPort; port < startPort + 100; port++) {
      if (await isPortFree(port)) return port
    }
    throw new Error(`在 ${startPort}-${startPort + 99} 范围内未找到可用端口`)
  }

  async start(): Promise<{ port: number }> {
    if (this.running) {
      return { port: this.currentPort as number }
    }
    this.stoppedByUser = false
    this.stdoutTail = new LineTail(TAIL_LINES)
    this.stderrTail = new LineTail(TAIL_LINES)

    this.emit('progress', { stage: 'resolve-runtime', message: '正在解析 dsh 运行时…' })
    this.resolution = resolveRuntime()

    this.emit('progress', { stage: 'allocate-port', message: '正在分配空闲端口…' })
    const port = await this.findFreePort()
    this.currentPort = port

    const { node, dshBin } = this.resolution
    this.emit('progress', { stage: 'spawn', message: `正在拉起 dsh web（端口 ${port}）…` })
    const child = spawn(node, [dshBin, 'web', '--port', String(port)], {
      env: buildChildEnv(this.resolution),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: app.getPath('home')
    })
    this.child = child

    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (d: string) => this.stdoutTail.push(d))
    child.stderr?.on('data', (d: string) => this.stderrTail.push(d))

    child.on('error', (err) => {
      this.clearReadyTimer()
      this.emit('error', {
        message: `无法启动 dsh web：${err.message}`,
        stderrTail: this.stderrTail.toString(),
        exitCode: null
      })
    })

    child.on('exit', (code, signal) => {
      this.clearReadyTimer()
      this.child = null
      void this.removePidFile()
      this.emit('exit', { code, signal })
      // 非主动停止且未成功就绪过 → 视为启动失败
      if (!this.stoppedByUser && this.currentPhase === 'starting') {
        this.stdoutTail.flush()
        this.stderrTail.flush()
        this.emit('error', {
          message: `dsh web 进程意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`,
          stderrTail: this.stderrTail.toString(),
          exitCode: code
        })
      }
    })

    this.currentPhase = 'starting'
    await this.writePidFile(child.pid)
    this.emit('progress', { stage: 'wait-ready', message: '正在等待 dsh web 就绪…' })
    this.pollUntilReady(port)

    return { port }
  }

  /** 200ms 间隔轮询 HTTP 就绪，60s 超时 */
  private pollUntilReady(port: number): void {
    const deadline = Date.now() + READY_TIMEOUT_MS
    const url = `http://127.0.0.1:${port}`

    const tick = async (): Promise<void> => {
      if (!this.running) return
      if (await probeHttp(port)) {
        this.currentPhase = 'ready'
        this.emit('ready', { port, url })
        return
      }
      if (Date.now() >= deadline) {
        this.stderrTail.flush()
        this.emit('error', {
          message: `等待 dsh web 就绪超时（${READY_TIMEOUT_MS / 1000}s，端口 ${port}）`,
          stderrTail: this.stderrTail.toString(),
          exitCode: null
        })
        await this.stop()
        return
      }
      this.readyTimer = setTimeout(() => void tick(), READY_POLL_INTERVAL_MS)
    }
    this.readyTimer = setTimeout(() => void tick(), READY_POLL_INTERVAL_MS)
  }

  /** 优雅停止：SIGTERM → 5s 宽限 → SIGKILL */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = null
      this.currentPhase = 'stopped'
      return
    }
    this.stoppedByUser = true
    this.currentPhase = 'stopped'
    this.clearReadyTimer()

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })

    try {
      child.kill('SIGTERM')
    } catch {
      // 进程可能已消失
    }

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), SIGTERM_GRACE_MS)
    )
    const winner = await Promise.race([exited.then(() => 'exited' as const), timeout])
    if (winner === 'timeout') {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      await exited
    }
    this.child = null
    await this.removePidFile()
  }

  getDiagnostics(): { stdoutTail: string; stderrTail: string } {
    return {
      stdoutTail: this.stdoutTail.toString(),
      stderrTail: this.stderrTail.toString()
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  private async writePidFile(pid: number | undefined): Promise<void> {
    if (pid === undefined) return
    try {
      await mkdir(app.getPath('userData'), { recursive: true })
      await writeFile(
        this.pidFilePath,
        JSON.stringify({ pid, port: this.currentPort, startedAt: new Date().toISOString() }, null, 2),
        'utf-8'
      )
    } catch {
      // pid 文件仅用于诊断，写入失败不阻塞启动
    }
  }

  private async removePidFile(): Promise<void> {
    try {
      await unlink(this.pidFilePath)
    } catch {
      // ignore
    }
  }

  /** 启动时读取上次残留的 pid 文件（供上层诊断/清理使用） */
  static async readStalePid(userDataDir?: string): Promise<{ pid: number; port: number } | null> {
    try {
      const dir = userDataDir ?? app.getPath('userData')
      const raw = await readFile(join(dir, 'dsh-web.pid'), 'utf-8')
      const parsed = JSON.parse(raw) as { pid?: number; port?: number }
      if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
        return { pid: parsed.pid, port: parsed.port }
      }
      return null
    } catch {
      return null
    }
  }
}

/** 端口是否空闲 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ host: '127.0.0.1', port })
    conn.once('connect', () => {
      conn.destroy()
      resolve(false)
    })
    conn.once('error', () => resolve(true))
  })
}

/** HTTP 探活：任意 2xx/3xx 响应即视为就绪 */
function probeHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: 1_500 },
      (res) => {
        res.resume()
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400)
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}
