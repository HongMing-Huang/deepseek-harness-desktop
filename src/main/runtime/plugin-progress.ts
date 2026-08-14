/**
 * pnpm（经 dsh plugin 转发）输出行的进度解析：纯函数、零依赖、无 Electron import，
 * 便于单测（tests/plugin-progress.test.ts）与主进程复用。
 *
 * 识别的行形态（按优先级）：
 *  - `Progress: resolved 34, reused 10, downloaded 2, added 12`（pnpm 解析汇总）
 *  - `Packages: +12`（新增包计数）
 *  - `.../pkg@1.2.3 12.4 kB 1.2s`（下载完成行，pnpm v9+ 常见）
 *  - 含 `NN%` 的进度行（下载/解压百分比）
 * 解析不到时返回 null，由调用方降级为“不确定进度”（state:'update' 不带 percent）。
 */

export interface ParsedProgress {
  /** 0-100 的确定性进度；无法量化时缺省（调用方按不确定进度处理） */
  percent?: number
  /** 面向用户的中文进度文案 */
  message: string
}

/** 解析单行 pnpm 输出；不识别返回 null */
export function parsePluginProgressLine(line: string): ParsedProgress | null {
  const text = line.replace(/\r/g, '').trim()
  if (text.length === 0) return null

  // 1) 解析汇总行：Progress: resolved 34, reused 10, downloaded 2, added 12
  const summary = /^Progress:\s+resolved\s+(\d+),\s*reused\s+(\d+),\s*downloaded\s+(\d+),\s*added\s+(\d+)/i.exec(
    text
  )
  if (summary) {
    const resolved = Number(summary[1])
    const downloaded = Number(summary[3])
    const added = Number(summary[4])
    const done = downloaded + added
    // resolved 为分母的粗略确定性进度（downloaded+added 覆盖 resolved 视为 100%）
    const percent = resolved > 0 ? Math.min(99, Math.round((done / resolved) * 90)) : undefined
    return {
      percent,
      message: `解析 ${resolved} · 下载 ${downloaded} · 新增 ${added}`
    }
  }

  // 2) 新增包计数行：Packages: +12（-3 表示移除）
  const packages = /^Packages:\s*([+-]\d+)/i.exec(text)
  if (packages) {
    const delta = Number(packages[1])
    return {
      message: delta >= 0 ? `即将新增 ${delta} 个包` : `即将移除 ${-delta} 个包`
    }
  }

  // 3) 任意百分比行：取最后一个百分数（同一行可能有多个阶段）
  const percents = [...text.matchAll(/(\d{1,3})\s*%/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100)
  if (percents.length > 0) {
    return { percent: percents[percents.length - 1], message: text.slice(0, 80) }
  }

  // 4) 下载完成行：.../pkg@1.2.3 12.4 kB 1.2s（或 MB/GB/s 变体）
  const fetched = /([^\s/]+@[\w.\-+]*)\s+([\d.]+\s*[kMG]?B)\s+[\d.]+\s*s?\s*$/i.exec(text)
  if (fetched) {
    return { message: `已获取 ${fetched[1]}（${fetched[2].replace(/\s+/g, '')}）` }
  }

  return null
}

/**
 * 从原始 chunk 中切出完整行（保留残尾）：pnpm 混用 \n 与 \r（进度条覆盖），
 * 这里统一按 [\r\n] 切分，残尾交回调用方与下一段拼接。
 */
export function splitProgressChunk(chunk: string): { lines: string[]; rest: string } {
  const parts = chunk.split(/\r\n|\r|\n/)
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}
