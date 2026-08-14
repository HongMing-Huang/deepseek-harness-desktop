import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PortInspectResult, PortOccupant, RepairPortResult } from '../../shared/ipc'
import { ProcessSupervisor } from './process-supervisor'
import { dshBinPath } from './paths'
import { logger } from '../logger'

/**
 * 端口占用诊断与安全释放：
 * - inspectPort：lsof 列出监听指定端口的进程；
 * - repairPort：仅当占用者确认为残留的 dsh web 进程（命令行包含
 *   dsh bin.js 完整路径；pid 命中 pid 文件仅作弱线索，必须叠加命令行
 *   校验防 pid 复用误杀）时才终止；其余占用者只报告不碰。
 */

/**
 * 占用者是否可安全终止：命令行包含 dsh bin.js 完整路径是唯一强证据；
 * pid 命中残留 pid 文件仅为弱线索（pid 可能被无关进程复用），不可单独采信。
 */
export function isDshOccupant(command: string, dshBin: string): boolean {
  return command.length > 0 && dshBin.length > 0 && command.includes(dshBin)
}

const execFileAsync = promisify(execFile)

/** lsof 列出监听端口的进程；lsof 无匹配（退出码 1）或不可用时视为无占用 */
export async function inspectPort(port: number): Promise<PortInspectResult> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      timeout: 5_000,
      encoding: 'utf-8'
    })
    const occupants: PortOccupant[] = []
    for (const line of stdout.split('\n').slice(1)) {
      if (line.trim().length === 0) continue
      // 列序：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      const cols = line.trim().split(/\s+/)
      if (cols.length < 3) continue
      const pid = Number(cols[1])
      if (!Number.isFinite(pid)) continue
      occupants.push({ pid, name: cols[0], user: cols[2] })
    }
    return { port, free: occupants.length === 0, occupants }
  } catch {
    return { port, free: true, occupants: [] }
  }
}

/**
 * 释放端口：只终止确认属于 dsh 的残留进程（pid 文件命中或命令行含 dsh bin.js 路径）；
 * 存在非 dsh 占用者时不做任何操作，返回占用者信息供用户手动处理。
 */
export async function repairPort(port: number): Promise<RepairPortResult> {
  const inspect = await inspectPort(port)
  if (inspect.free) {
    return { ok: true, message: `端口 ${port} 当前空闲` }
  }

  const stale = await ProcessSupervisor.readStalePid()
  const dshBin = dshBinPath()
  const dshOccupants: PortOccupant[] = []
  const manualOccupants: PortOccupant[] = []

  for (const occ of inspect.occupants) {
    const command = await psCommand(occ.pid)
    const staleHint = stale !== null && occ.pid === stale.pid
    if (isDshOccupant(command, dshBin)) {
      dshOccupants.push({ ...occ, command })
    } else {
      if (staleHint) {
        // pid 命中但命令行不含 dsh bin：大概率 pid 已被无关进程复用，绝不终止
        logger.warn(
          `pid ${occ.pid} 命中残留 pid 文件但命令行不含 dsh bin，按非 dsh 进程处理（疑似 pid 复用）`
        )
      }
      manualOccupants.push({ ...occ, command })
    }
  }

  if (manualOccupants.length > 0) {
    const who = manualOccupants.map((o) => `${o.name}（pid ${o.pid}）`).join('、')
    logger.warn(`端口 ${port} 被非 dsh 进程占用：${who}`)
    return {
      ok: false,
      message: `端口 ${port} 被 ${who} 占用，不属于 DSH Desktop，请手动处理后再试。`,
      occupants: manualOccupants
    }
  }

  for (const occ of dshOccupants) {
    logger.info(`端口修复：终止残留 dsh 进程 pid=${occ.pid} name=${occ.name}`)
    await terminatePid(occ.pid)
  }

  const after = await inspectPort(port)
  if (!after.free) {
    return {
      ok: false,
      message: `释放端口 ${port} 未完全成功，请手动检查后重试。`,
      occupants: after.occupants
    }
  }
  return { ok: true, message: `已释放端口 ${port}（终止 ${dshOccupants.length} 个 dsh 残留进程）` }
}

/** 查询进程完整命令行；失败返回空串 */
async function psCommand(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 5_000,
      encoding: 'utf-8'
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

/** SIGTERM → 1.5s 宽限 → SIGKILL */
async function terminatePid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  await sleep(1_500)
  try {
    process.kill(pid, 0) // 探活：已退出则不再强杀
  } catch {
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已退出
  }
  await sleep(300)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
