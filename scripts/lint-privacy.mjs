#!/usr/bin/env node
/**
 * 隐私合规检查（零依赖，Node 22 原生运行）。
 *
 * 用途：扫描仓库文本文件，拦截以下两类隐私泄露模式——
 *   1. 私有绝对路径（形如 /Users/<名字> 的 macOS 用户目录）；
 *   2. 个人邮箱（@gmail / @qq / @163 / @126 / @outlook / @hotmail / @foxmail 等常见个人域名）。
 *
 * 白名单：@users.noreply.github.com（GitHub 匿名提交邮箱形态，允许出现在
 * maintainer 字段与 git 提交配置中）。
 *
 * 命中即打印 文件:行号:摘要 并以退出码 1 失败；由 ci.yml 直接
 * `node scripts/lint-privacy.mjs` 调用（不注册 npm script）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 扫描范围：目录（递归）与根下散落文件 */
const SCAN_DIRS = ['src', 'scripts', 'site', '.github']
const SCAN_FILES = ['README.md', 'CHANGELOG.md']

/** 判定为文本文件的扩展名（其余扩展名一律视为二进制跳过） */
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.yml', '.yaml', '',
  '.html', '.css', '.md', '.txt', '.svg', '.sh'
])

/** 明确的二进制扩展名（双保险，命中直接跳过） */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns',
  '.zip', '.dmg', '.deb', '.appimage', '.node', '.wasm', '.lock'
])

/** 忽略的目录名（扫描范围内不应出现，但防御性排除） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'release', 'dist'])

/** 私有绝对路径：/Users/<用户名>（首段大写避开 /users.noreply 类域名） */
const PRIVATE_PATH_RE = /\/Users\/[A-Za-z0-9._-]+/

/** 个人邮箱：限定常见个人邮箱域 */
const PERSONAL_EMAIL_RE = /[A-Za-z0-9._%+-]+@(?:gmail|qq|163|126|outlook|hotmail|foxmail)\.(?:com|net)/i

/** 允许的匿名邮箱（命中前先从行中移除，避免误伤） */
const ALLOWED_EMAIL = '@users.noreply.github.com'

/** 收集文件：目录递归 + 根文件 */
function collectFiles() {
  const files = []
  for (const dir of SCAN_DIRS) {
    const abs = join(repoRoot, dir)
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      continue // 目录不存在则跳过
    }
    const walk = (dirAbs, dirents) => {
      for (const e of dirents) {
        if (e.name.startsWith('.DS_Store')) continue
        const p = join(dirAbs, e.name)
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue
          walk(p, readdirSync(p, { withFileTypes: true }))
        } else if (e.isFile()) {
          const ext = extname(e.name).toLowerCase()
          if (BINARY_EXTS.has(ext) || !TEXT_EXTS.has(ext)) continue
          files.push(p)
        }
      }
    }
    walk(abs, entries)
  }
  for (const f of SCAN_FILES) {
    const p = join(repoRoot, f)
    try {
      if (statSync(p).isFile()) files.push(p)
    } catch {
      // 文件不存在则跳过
    }
  }
  return files
}

/** 对单文件逐行检查，返回违规数组 */
function scanFile(absPath) {
  const violations = []
  let content
  try {
    content = readFileSync(absPath, 'utf8')
  } catch {
    return violations // 读取失败（如编码问题）不阻塞
  }
  const lines = content.split('\n')
  lines.forEach((rawLine, i) => {
    // 白名单先行：移除允许的匿名邮箱再匹配
    const line = rawLine.split(ALLOWED_EMAIL).join('')
    const rel = relative(repoRoot, absPath)
    const m1 = PRIVATE_PATH_RE.exec(line)
    if (m1) {
      violations.push({ file: rel, line: i + 1, kind: '私有绝对路径', hit: m1[0] })
    }
    const m2 = PERSONAL_EMAIL_RE.exec(line)
    if (m2) {
      violations.push({ file: rel, line: i + 1, kind: '个人邮箱', hit: m2[0] })
    }
  })
  return violations
}

// ---------- 主流程 ----------
const files = collectFiles()
const all = []
for (const f of files) all.push(...scanFile(f))

if (all.length > 0) {
  console.error(`\n[lint-privacy] 发现 ${all.length} 处疑似隐私泄露：\n`)
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  [${v.kind}]  ${v.hit}`)
  }
  console.error('\n请改为产品/开发信息：私有路径用相对路径占位，邮箱仅允许 @users.noreply.github.com。')
  process.exit(1)
}

console.log(`[lint-privacy] 通过：已扫描 ${files.length} 个文本文件，未发现隐私泄露。`)
