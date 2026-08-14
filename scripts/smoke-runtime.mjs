#!/usr/bin/env node
/**
 * 内嵌运行时冒烟测试（零依赖，macOS / Linux 通吃）。
 *
 * 用内嵌 Node 启动 `dsh web --port <n>`，轮询 http://127.0.0.1:<port> 探活，
 * 收到任意 HTTP 响应即视为运行时可用，随后优雅 SIGTERM 结束子进程。
 * 由 release.yml 在每个平台矩阵 job 的打包步骤后调用；也可本地执行
 * （前提：已跑过 npm run prepare:runtime）。
 *
 * 用法：node scripts/smoke-runtime.mjs [--port 3999] [--timeout-ms 45000]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { arch } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const runtimeRoot = join(repoRoot, 'resources', 'runtime')

/* ---------- 参数 ---------- */
function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}
const PORT = argValue('--port', 3999)
const TIMEOUT_MS = argValue('--timeout-ms', 45_000)
const GRACE_MS = 10_000

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
  env: { ...process.env }
})
console.log(`[smoke-runtime] 已启动 dsh web（pid ${child.pid}，端口 ${PORT}，内嵌 node: ${archDir}）`)

child.stdout.on('data', log)
child.stderr.on('data', log)

const startedAt = Date.now()
let childExit = null
child.on('exit', (code, signal) => {
  childExit = { code, signal }
})

/** 轮询探活：收到任意 HTTP 响应即成功 */
async function waitUntilReady() {
  const url = `http://127.0.0.1:${PORT}/`
  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (childExit) {
      throw new Error(`dsh web 提前退出（code=${childExit.code} signal=${childExit.signal}）`)
    }
    try {
      const res = await fetch(url, { redirect: 'manual' })
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
    if (childExit) return resolve()
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
  process.exit(exitCode)
}
