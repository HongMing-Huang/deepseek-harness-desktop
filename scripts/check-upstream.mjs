#!/usr/bin/env node
/**
 * 上游 dsh 版本同步检查（零依赖，Node 22 原生运行）。
 *
 * 用途：
 *   1. 解析 src/shared/versions.ts 中钉死的 DSH_VERSION；
 *   2. 查询 npm registry 上 @deepseek-ai/dsh 的 dist-tags.latest；
 *   3. 按 semver 规则（含 prerelease 段，如 rc.6 < rc.7 < 正式版）比较；
 *   4. 输出 GitHub Actions outputs（updated / current / latest）供
 *      sync-upstream.yml 决定是否开 PR。
 *
 * 用法：
 *   node scripts/check-upstream.mjs          # 仅检查（本地或 CI 均可）
 *   node scripts/check-upstream.mjs --apply  # 有新版时更新 versions.ts 与 CHANGELOG.md
 *
 * 说明：绝不自动合并、绝不自动 bump 应用壳版本——--apply 只写
 * DSH_VERSION 常量与 CHANGELOG「dsh 运行时」小节，变更需经人工 PR 审查。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const VERSIONS_FILE = join(repoRoot, 'src/shared/versions.ts')
const CHANGELOG_FILE = join(repoRoot, 'CHANGELOG.md')
const CHANGELOG_SECTION = '## dsh 运行时（@deepseek-ai/dsh）'
const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'

const APPLY = process.argv.includes('--apply')

/* ---------- versions.ts 解析 ---------- */
function readCurrentVersion() {
  const src = readFileSync(VERSIONS_FILE, 'utf8')
  const m = /export const DSH_VERSION = '([^']+)'/.exec(src)
  if (!m) {
    throw new Error(`未能从 ${VERSIONS_FILE} 解析 DSH_VERSION 常量`)
  }
  return m[1]
}

/* ---------- npm registry 查询 ---------- */
async function fetchLatestVersion() {
  const res = await fetch(REGISTRY_URL, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' }
  })
  if (!res.ok) {
    throw new Error(`registry 查询失败：HTTP ${res.status} ${REGISTRY_URL}`)
  }
  const data = await res.json()
  const latest = data && data['dist-tags'] && data['dist-tags'].latest
  if (typeof latest !== 'string' || latest.length === 0) {
    throw new Error('registry 响应中缺少 dist-tags.latest')
  }
  return latest
}

/* ---------- 最小 semver 实现（仅比较，无需解析 range） ---------- */
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/.exec(String(v).trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : null // null = 正式版（无 prerelease）
  }
}

/** @returns {number} 负数 a<b、0 相等、正数 a>b（不合法版本视为不可比较并抛错） */
function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) {
    throw new Error(`semver 解析失败：${!pa ? a : b}`)
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  // 主版本相同：正式版 > 预发布版
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  // 双方均为预发布：逐段比较（数字段按数值、字母段按字典序、数字段 < 字母段）
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // 段数少者小
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/* ---------- 变更落盘（--apply） ---------- */
function applyBump(current, latest) {
  // 1) versions.ts：仅替换 DSH_VERSION 字符串字面量
  const versionsSrc = readFileSync(VERSIONS_FILE, 'utf8')
  const re = /(export const DSH_VERSION = ')[^']+(')/
  if (!re.test(versionsSrc)) {
    throw new Error('versions.ts 中未找到 DSH_VERSION 赋值，中止更新')
  }
  writeFileSync(VERSIONS_FILE, versionsSrc.replace(re, `$1${latest}$2`))

  // 2) CHANGELOG.md：在「dsh 运行时」小节顶部插入新条目
  const changelog = readFileSync(CHANGELOG_FILE, 'utf8')
  if (!changelog.includes(CHANGELOG_SECTION)) {
    throw new Error(`CHANGELOG.md 中未找到小节「${CHANGELOG_SECTION}」，中止更新`)
  }
  const entry = [
    '',
    `### [${latest}]`,
    '',
    `- upstream-sync：\`@deepseek-ai/dsh\` ${current} → ${latest}（机器人自动提交，待人工验证后合并）。`,
    ''
  ].join('\n')
  writeFileSync(CHANGELOG_FILE, changelog.replace(CHANGELOG_SECTION, CHANGELOG_SECTION + '\n' + entry.trimStart()))
}

/* ---------- GitHub Actions outputs ---------- */
function setOutput(key, value) {
  const outFile = process.env.GITHUB_OUTPUT
  if (outFile) {
    appendFileSync(outFile, `${key}=${value}\n`)
  }
}

/* ---------- 主流程 ---------- */
const current = readCurrentVersion()
const latest = await fetchLatestVersion()
const isNewer = compareSemver(latest, current) > 0

setOutput('current', current)
setOutput('latest', latest)
setOutput('updated', isNewer ? 'true' : 'false')

console.log(`[check-upstream] 内嵌版本: ${current}`)
console.log(`[check-upstream] registry latest: ${latest}`)
console.log(`[check-upstream] ${isNewer ? '检测到新版本' : '已是最新，无需同步'}`)

if (isNewer && APPLY) {
  applyBump(current, latest)
  console.log(`[check-upstream] 已更新 ${VERSIONS_FILE} 与 CHANGELOG.md（DSH_VERSION: ${current} → ${latest}）`)
}
