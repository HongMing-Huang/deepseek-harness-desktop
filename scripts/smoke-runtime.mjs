#!/usr/bin/env node
/**
 * 内嵌运行时冒烟测试（零依赖，macOS / Linux 通吃）。
 *
 * 用内嵌 Node 启动 `dsh web --port <n>`，轮询 http://127.0.0.1:<port> 探活，
 * 收到任意 HTTP 响应即视为运行时可用，随后优雅 SIGTERM 结束子进程。
 * 由 release.yml 在每个平台矩阵 job 的打包步骤后调用；也可本地执行
 * （前提：已跑过 npm run prepare:runtime）。
 *
 * 用法：node scripts/smoke-runtime.mjs [--port 3999] [--timeout-ms 45000] [--dsh-home <dir>]
 * 默认使用 mkdtemp 隔离的 DSH_HOME（不污染真实 ~/.dsh，结束后删除）；
 * 显式传入 --dsh-home 时使用指定目录且不负责清理。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { arch, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const runtimeRoot = join(repoRoot, 'resources', 'runtime')

/* ---------- 参数 ---------- */
function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}
function argString(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && typeof process.argv[i + 1] === 'string' && process.argv[i + 1].length > 0
    ? process.argv[i + 1]
    : null
}
const PORT = argValue('--port', 3999)
const TIMEOUT_MS = argValue('--timeout-ms', 45_000)
const GRACE_MS = 10_000

/* DSH_HOME 隔离：默认 mkdtemp 临时目录；显式 --dsh-home 时不接管清理 */
const explicitHome = argString('--dsh-home')
const isolatedHome = explicitHome ?? mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
if (!explicitHome) {
  console.log(`[smoke-runtime] 使用隔离 DSH_HOME：${isolatedHome}`)
}

/* ---------- 路径解析（与 src/main/runtime/paths.ts 目录约定一致） ---------- */
const archDir = arch() === 'arm64' ? 'arm64' : 'x64'
const nodeBin = join(runtimeRoot, 'node', archDir, 'node')
const dshBin = join(runtimeRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

for (const p of [nodeBin, dshBin]) {
  if (!existsSync(p)) {
    console.error(`[smoke-runtime] 缺少文件：${p}`)
    console.error('[smoke-runtime] 请先执行 npm run prepare:runtime（CI 中由 release.yml 完成）')
    process.exit(1)
  }
}

/* ---------- 子进程日志（失败时输出尾部辅助诊断） ---------- */
const logTail = []
function log(line) {
  const text = line.toString().trimEnd()
  logTail.push(text)
  if (logTail.length > 40) logTail.shift()
  console.log(`[dsh] ${text}`)
}

/* ---------- 主流程 ---------- */
const child = spawn(nodeBin, [dshBin, 'web', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: isolatedHome }
})
console.log(`[smoke-runtime] 已启动 dsh web（pid ${child.pid}，端口 ${PORT}，内嵌 node: ${archDir}）`)

child.stdout.on('data', log)
child.stderr.on('data', log)

const startedAt = Date.now()
let childExit = null
let childError = null
child.on('exit', (code, signal) => {
  childExit = { code, signal }
})
child.on('error', (err) => {
  // spawn 失败（如 ENOENT/权限）不触发 exit：结构化记录，探活循环据此失败
  childError = err
})

/** 轮询探活：收到任意 HTTP 响应即成功（单次 fetch 3s 超时防悬挂） */
async function waitUntilReady() {
  const url = `http://127.0.0.1:${PORT}/`
  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (childError) {
      throw new Error(`dsh web 进程异常（spawn error）：${childError.message}`)
    }
    if (childExit) {
      throw new Error(`dsh web 提前退出（code=${childExit.code} signal=${childExit.signal}）`)
    }
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
      console.log(`[smoke-runtime] 探活成功：HTTP ${res.status}（${url}）`)
      return res.status
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error(`探活超时（${TIMEOUT_MS}ms 内未在 ${url} 收到响应）`)
}

/** 优雅停止：SIGTERM，超时强杀 */
function stopChild() {
  return new Promise((resolve) => {
    if (childExit || childError) return resolve()
    const killer = setTimeout(() => {
      console.warn('[smoke-runtime] 优雅退出超时，SIGKILL 强杀')
      child.kill('SIGKILL')
    }, GRACE_MS)
    child.on('exit', () => {
      clearTimeout(killer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

let exitCode = 0
try {
  await waitUntilReady()
  console.log('[smoke-runtime] 冒烟通过：内嵌 Node + dsh web 服务可正常启动')
} catch (err) {
  exitCode = 1
  console.error(`[smoke-runtime] 冒烟失败：${err.message}`)
  if (logTail.length > 0) {
    console.error('[smoke-runtime] dsh 输出尾部：')
    for (const line of logTail) console.error(`    ${line}`)
  }
} finally {
  await stopChild()
  console.log('[smoke-runtime] 子进程已停止')
  // 隔离目录清理（显式传入的 --dsh-home 不接管）
  if (!explicitHome) {
    try {
      rmSync(isolatedHome, { recursive: true, force: true })
    } catch {
      // 清理失败不影响冒烟结论
    }
  }
  process.exit(exitCode)
}
