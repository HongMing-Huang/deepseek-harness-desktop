import { app } from 'electron'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse, parseDocument, stringify, Document } from 'yaml'
import { dshHome } from './runtime/paths'
import type { ApiKeyStatus, Preferences } from '../shared/ipc'

/**
 * dsh 用户配置的受控读写：
 * - 凭据：~/.dsh/.credentials.yaml 单键 DEEPSEEK_API_KEY（0600，原子写）；
 * - 模型：~/.dsh/settings.yaml 的 agent-default-model 段（保留未知字段与注释回写）；
 * - 偏好：userData/preferences.json（应用壳自身状态，与 dsh 数据目录无关）。
 *
 * 安全纪律：任何路径都不返回 / 记录密钥明文，掩码仅保留头 3 位与末 4 位。
 */

const CREDENTIALS_KEY = 'DEEPSEEK_API_KEY'
const MODEL_SECTION = 'agent-default-model'

/** 占位仓库：值为该默认串时壳更新检查静默跳过 */
export const DEFAULT_UPDATE_REPO = 'owner/dsh-desktop'

export const DEFAULT_PREFERENCES: Preferences = {
  updateCheckEnabled: true,
  updateSnoozeUntil: null,
  lastCheck: null,
  lastKnownGoodDsh: null,
  bootFailCount: 0,
  updateRepo: DEFAULT_UPDATE_REPO
}

function credentialsPath(): string {
  return join(dshHome(), '.credentials.yaml')
}

function settingsPath(): string {
  return join(dshHome(), 'settings.yaml')
}

function preferencesPath(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

/** 临时文件 + rename 的原子写（失败时原文件保持不动） */
async function atomicWrite(file: string, data: string, mode?: number): Promise<void> {
  const tmp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, data, 'utf-8')
  if (mode !== undefined) {
    await chmod(tmp, mode)
  }
  await rename(tmp, file)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ── 凭据 ── */

/** 掩码：保留前 3 位与末 4 位（如 sk-***abcd），过短则整体打码 */
function maskSecret(key: string): string {
  if (key.length <= 8) {
    return '***'
  }
  return `${key.slice(0, 3)}***${key.slice(-4)}`
}

/** 查询密钥配置状态（绝不返回明文） */
export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
  try {
    const raw = await readFile(credentialsPath(), 'utf-8')
    const doc = parse(raw) as Record<string, unknown> | null
    const key = doc?.[CREDENTIALS_KEY]
    if (typeof key === 'string' && key.trim().length > 0) {
      return { configured: true, masked: maskSecret(key.trim()) }
    }
    return { configured: false }
  } catch {
    return { configured: false }
  }
}

/**
 * 保存 API Key：校验非空 → 临时文件 + rename 原子替换单键凭据文件（chmod 0600）。
 * 任一步失败时原文件保持不动。
 */
export async function saveApiKey(key: string): Promise<{ ok: boolean; message?: string }> {
  const trimmed = key.trim()
  if (trimmed.length === 0) {
    return { ok: false, message: 'API Key 不能为空' }
  }
  try {
    const body = stringify({ [CREDENTIALS_KEY]: trimmed })
    await atomicWrite(credentialsPath(), body, 0o600)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: `写入凭据失败：${errorMessage(err)}` }
  }
}

/* ── 默认模型 ── */

/** agent-default-model 段兼容两种取值：字符串本身 / { model: string } 映射 */
function extractModel(value: unknown): string | null {
  if (typeof value === 'string') {
    const v = value.trim()
    return v.length > 0 ? v : null
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const m = (value as Record<string, unknown>).model
    if (typeof m === 'string' && m.trim().length > 0) {
      return m.trim()
    }
  }
  return null
}

/** 读取默认模型；文件不存在或段缺失返回 null */
export async function getDefaultModel(): Promise<string | null> {
  try {
    const raw = await readFile(settingsPath(), 'utf-8')
    const doc = parse(raw) as Record<string, unknown> | null
    return extractModel(doc?.[MODEL_SECTION])
  } catch {
    return null
  }
}

/**
 * 保存默认模型到 settings.yaml 的 agent-default-model 段：
 * 使用 yaml Document 读写，保留未知字段、键序与注释；
 * 文件不存在时创建最小结构。
 */
export async function saveDefaultModel(model: string): Promise<{ ok: boolean; message?: string }> {
  const trimmed = model.trim()
  if (trimmed.length === 0) {
    return { ok: false, message: '模型名不能为空' }
  }
  let doc: Document
  try {
    const raw = await readFile(settingsPath(), 'utf-8')
    doc = parseDocument(raw)
  } catch {
    // 文件不存在或不可解析：从最小结构重建（原子写失败时原文件不动）
    doc = new Document()
  }
  try {
    const section = doc.get(MODEL_SECTION)
    if (section && typeof section === 'object') {
      doc.setIn([MODEL_SECTION, 'model'], trimmed)
    } else {
      doc.set(MODEL_SECTION, { model: trimmed })
    }
    await atomicWrite(settingsPath(), String(doc))
    return { ok: true }
  } catch (err) {
    return { ok: false, message: `写入默认模型失败：${errorMessage(err)}` }
  }
}

/* ── 应用偏好 ── */

/** 读取偏好（与默认值合并；文件不存在/损坏返回默认值） */
export async function getPreferences(): Promise<Preferences> {
  try {
    const raw = await readFile(preferencesPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Preferences>
    return { ...DEFAULT_PREFERENCES, ...parsed }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

/** 浅合并保存偏好字段（均为标量，一层 Object.assign 语义足够） */
export async function savePreferencesMerge(patch: Partial<Preferences>): Promise<Preferences> {
  const current = await getPreferences()
  const next: Preferences = { ...current, ...patch }
  await atomicWrite(preferencesPath(), JSON.stringify(next, null, 2))
  return next
}
