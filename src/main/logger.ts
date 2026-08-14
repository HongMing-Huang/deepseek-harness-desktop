import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * 主进程简易文件日志：
 * - 落盘于 userData/logs/main.log，追加写；
 * - 单文件超 2MB 截断重开（避免无限增长）；
 * - 同步 IO 只在低频关键路径使用，日志失败绝不影响主流程。
 */

const MAX_LOG_BYTES = 2 * 1024 * 1024

function logFilePath(): string {
  return join(app.getPath('userData'), 'logs', 'main.log')
}

function write(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`
  try {
    const file = logFilePath()
    mkdirSync(dirname(file), { recursive: true })
    // 超限截断重开
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      writeFileSync(file, '')
    }
    appendFileSync(file, line)
  } catch {
    // 日志失败静默忽略
  }
  // 控制台镜像：便于开发调试
  if (level === 'ERROR') {
    process.stderr.write(`[main] ${msg}\n`)
  } else {
    process.stdout.write(`[main] ${msg}\n`)
  }
}

export const logger = {
  info: (msg: string): void => write('INFO', msg),
  warn: (msg: string): void => write('WARN', msg),
  error: (msg: string): void => write('ERROR', msg)
}
