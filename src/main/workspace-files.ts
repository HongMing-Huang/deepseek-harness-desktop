import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from './logger'
import type {
  FileEntry,
  GitChangeEntry,
  WorkspaceGitStatusResult,
  WorkspaceListDirResult
} from '../shared/ipc'

/**
 * 工作区文件树（只读）：
 * - listDirectory：目录枚举（目录优先、字母序），单层最多 500 条目防失控；
 * - workspaceGitStatus：git -C <path> status --porcelain 解析为变更清单，
 *   非 git 仓库 / git 缺失 / 超时均降级为 repo:false 或明确错误，绝不抛到 UI。
 * 路径仅作读取，绝不写入工作区。
 */

const MAX_ENTRIES = 500
const GIT_TIMEOUT_MS = 5_000

export async function listDirectory(path: string): Promise<WorkspaceListDirResult> {
  const clean = (path ?? '').trim()
  if (!clean) {
    return { ok: false, path: '', entries: [], message: '路径为空' }
  }
  try {
    const st = await stat(clean)
    if (!st.isDirectory()) {
      return { ok: false, path: clean, entries: [], message: '路径不是目录' }
    }
  } catch {
    return { ok: false, path: clean, entries: [], message: '目录不存在或不可访问' }
  }

  try {
    const dirents = await readdir(clean, { withFileTypes: true })
    const entries: FileEntry[] = []
    for (const d of dirents) {
      if (entries.length >= MAX_ENTRIES) break
      const entry: FileEntry = { name: d.name, dir: d.isDirectory(), size: 0, mtimeMs: 0 }
      try {
        const st = await stat(join(clean, d.name))
        entry.size = st.isFile() ? st.size : 0
        entry.mtimeMs = st.mtimeMs
      } catch {
        // 条目被并发删除：保留骨架
      }
      entries.push(entry)
    }
    entries.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { ok: true, path: clean, entries }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`目录枚举失败：${clean}：${message}`)
    return { ok: false, path: clean, entries: [], message }
  }
}

export function workspaceGitStatus(path: string): Promise<WorkspaceGitStatusResult> {
  const clean = (path ?? '').trim()
  if (!clean) {
    return Promise.resolve({ repo: false, changes: [], message: '路径为空' })
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', clean, 'status', '--porcelain', '-z', '--untracked-files=normal'],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // 128 = 非 git 仓库；其余（git 缺失等）降级为无仓库，不打扰用户
          if (typeof (err as NodeJS.ErrnoException).code === 'number') {
            // spawn 错误（git 不存在）
            logger.info(`git 不可用：${String(err)}`)
            resolve({ repo: false, changes: [], message: 'git 不可用' })
            return
          }
          resolve({ repo: false, changes: [] })
          return
        }
        const changes: GitChangeEntry[] = parseGitPorcelainZ(stdout)
        resolve({ repo: true, changes })
      }
    )
  })
}

/** `git status --porcelain -z` 输出解析（纯函数，可单测） */
export function parseGitPorcelainZ(output: string): GitChangeEntry[] {
  const items: GitChangeEntry[] = []
  // -z 模式：条目以 NUL 结尾；重命名条目形如 "R  old\0new\0"
  const parts = output.split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i]
    if (token.length < 3) continue
    const code = token.slice(0, 2)
    const file = token.slice(3)
    if (code[0] === 'R' || code[1] === 'R') {
      // 重命名：下一 token 是新路径
      const next = parts[i + 1]
      if (next && next.length > 0) {
        items.push({ file: next, code })
        i += 1
      } else {
        items.push({ file, code })
      }
      continue
    }
    items.push({ file, code })
  }
  return items
}
