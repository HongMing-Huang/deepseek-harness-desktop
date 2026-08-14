/**
 * IPC 通道与载荷的集中定义，main / preload / renderer 共用。
 * 所有新增 IPC 都必须先在此登记，再在 main/ipc.ts 中注册处理器。
 */

export const IpcChannels = {
  /* ── renderer → main（invoke）── */
  /** 查询当前运行时状态 */
  RuntimeGetStatus: 'runtime:get-status',
  /** 停止并重新启动 dsh web */
  RuntimeRestart: 'runtime:restart',
  /** 检查并（在安全前提下）释放被占用的端口 */
  RuntimeRepairPort: 'runtime:repair-port',
  /** 获取诊断信息（stdout/stderr 尾部 + 错误分类 + 运行时版本） */
  RuntimeGetDiagnostics: 'runtime:get-diagnostics',
  /** 在系统文件管理器中定位日志文件 */
  RuntimeOpenLogs: 'runtime:open-logs',

  /** 更新：立即检查（绕过 24h 节流） */
  UpdaterCheckNow: 'updater:check-now',
  /** 更新：立即安装指定（或已发现的最新）dsh 版本 */
  UpdaterApply: 'updater:apply',

  /** 插件：列出已安装插件（handler 由插件管理阶段实现） */
  PluginsList: 'plugins:list',
  /** 插件：可用插件目录（handler 由插件管理阶段实现） */
  PluginsCatalog: 'plugins:catalog',
  /** 插件：安装（handler 由插件管理阶段实现） */
  PluginsInstall: 'plugins:install',
  /** 插件：卸载（handler 由插件管理阶段实现） */
  PluginsRemove: 'plugins:remove',
  /** 插件：健康检查（已装包完整性 / 版本可更新） */
  PluginsHealth: 'plugins:health',
  /** 插件：一键全量更新（pnpm update，逐个依赖刷新到兼容最新） */
  PluginsUpdateAll: 'plugins:update-all',
  /** 插件：dshfind 在线市场搜索 */
  PluginsMarketSearch: 'plugins:market-search',
  /** 插件：dshfind 在线市场强制刷新 */
  PluginsMarketRefresh: 'plugins:market-refresh',

  /** 会话：工作区列表（Trae Workspace 风格项目卡片） */
  SessionsWorkspaces: 'sessions:workspaces',
  /** 会话：指定（或全部）工作区的会话列表 */
  SessionsList: 'sessions:list',
  /** 会话：全文搜索（dsh web 就绪时走官方 session.search，否则本地元数据兜底） */
  SessionsSearch: 'sessions:search',
  /** 会话：导出（官方 zip 存档 / Markdown / JSONL） */
  SessionsExport: 'sessions:export',
  /** 会话：恢复（打开主窗口官方 Web 界面继续） */
  SessionsResume: 'sessions:resume',
  /** 会话：在系统文件管理器中打开工作区目录 */
  SessionsOpenFolder: 'sessions:open-folder',

  /** 配置：读取密钥状态 / 默认模型 / 偏好 / 版本信息 */
  ConfigGet: 'config:get',
  /** 配置：保存 API Key（原子写 ~/.dsh/.credentials.yaml） */
  ConfigSaveApiKey: 'config:save-api-key',
  /** 配置：保存默认模型（~/.dsh/settings.yaml 的 agent-default-model 段） */
  ConfigSaveModel: 'config:save-model',
  /** 配置：合并保存应用偏好（userData/preferences.json） */
  ConfigSavePreferences: 'config:save-preferences',

  /* ── main → renderer（event）── */
  /** 运行时状态推送 */
  RuntimeStatus: 'runtime:status',
  /** 长操作进度推送（boot/update/插件/密钥/模型） */
  OpProgress: 'op:progress',
  /** 更新器状态推送（设置窗口展示） */
  UpdaterStatus: 'updater:status'
} as const

/* ───────────────────────── 运行时 ───────────────────────── */

export type RuntimePhase =
  /** 正在准备运行时 / 拉起 dsh web */
  | 'starting'
  /** dsh web 已就绪，主窗口即将切换 */
  | 'ready'
  /** 启动失败 */
  | 'error'
  /** 进程已停止 */
  | 'stopped'

export interface RuntimeStatus {
  phase: RuntimePhase
  /** dsh web 监听端口（就绪后提供） */
  port?: number
  /** Web UI 地址（就绪后提供） */
  url?: string
  /** 人类可读的状态描述 / 错误摘要 */
  message?: string
  /** 失败时的 stderr 尾部（诊断用） */
  stderrTail?: string
  /** 失败时附带的错误分类（供 splash 渲染原因与按钮组） */
  classification?: StartupErrorClassification
}

export type StartupErrorCause =
  | 'runtime-missing'
  | 'port-in-use'
  | 'eacces-or-quarantine'
  | 'ready-timeout'
  | 'credentials-missing'
  | 'process-crash'

export type StartupErrorAction = 'retry' | 'repair-port' | 'open-logs'

export interface StartupErrorClassification {
  cause: StartupErrorCause
  /** 面向用户的中文提示（处置建议） */
  hint: string
  /** 错误卡片可执行的动作 */
  actions: StartupErrorAction[]
}

export interface PortOccupant {
  pid: number
  /** 进程名（lsof COMMAND 列） */
  name: string
  /** 运行用户（lsof USER 列） */
  user: string
  /** 完整命令行（ps 补充，可能为空） */
  command?: string
}

export interface PortInspectResult {
  port: number
  free: boolean
  occupants: PortOccupant[]
}

export interface RepairPortResult {
  ok: boolean
  message: string
  /** 未能自动释放的占用进程（供 UI 提示用户手动处理） */
  occupants?: PortOccupant[]
}

export interface DiagnosticsResult {
  stdoutTail: string
  stderrTail: string
  classification: StartupErrorClassification
  /** 当前运行时版本信息（解析失败为 null） */
  runtime: { dshVersion: string | null; usingSideload: boolean } | null
}

/* ───────────────────────── 操作进度 ───────────────────────── */

export type OpKind =
  | 'boot'
  | 'update'
  | 'plugin-install'
  | 'plugin-remove'
  | 'plugin-update'
  | 'credentials'
  | 'model'

export interface OpProgress {
  op: OpKind
  state: 'start' | 'update' | 'done' | 'error'
  /** 0-100，仅部分阶段提供 */
  percent?: number
  message?: string
}

/* ───────────────────────── 配置 ───────────────────────── */

export interface ApiKeyStatus {
  configured: boolean
  /** 掩码形式（如 sk-***abcd），绝不返回明文 */
  masked?: string
}

export interface Preferences {
  /** 是否启用自动更新检查 */
  updateCheckEnabled: boolean
  /** 「稍后提醒」豁免截止时间（ISO 8601，null 表示不豁免） */
  updateSnoozeUntil: string | null
  /** 上次自动检查时间（ISO 8601），24h 节流用 */
  lastCheck: string | null
  /** 最近一次确认可用的侧载 dsh 版本（回滚保留目标） */
  lastKnownGoodDsh: string | null
  /** 侧载运行时连续启动失败计数（达到 2 触发自动回退内嵌） */
  bootFailCount: number
  /** 应用壳更新检查的 GitHub 仓库（owner/repo，占位值时跳过检查） */
  updateRepo: string
}

export interface ConfigState {
  apiKey: ApiKeyStatus
  defaultModel: string | null
  preferences: Preferences
  versions: {
    /** 应用壳版本（app.getVersion） */
    app: string
    /** 内嵌 dsh 版本（打包清单） */
    bundled: string | null
    /** 实际生效的 dsh 运行时版本 */
    dsh: string | null
    /** 是否正在使用侧载（应用内更新）运行时 */
    sideloaded: boolean
  }
}

/* ───────────────────────── 更新 ───────────────────────── */

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'installed'
  | 'error'

export interface UpdaterStatusPayload {
  checking: boolean
  currentDsh: string | null
  latestDsh?: string
  state: UpdaterState
  message?: string
}

export interface UpdaterCheckResult {
  state: 'up-to-date' | 'available' | 'unavailable' | 'error'
  currentDsh: string | null
  latestDsh?: string
  /** 壳轨发现的新版本（dsh 轨无新版但壳有新版时仍会给出） */
  shellUpdate?: { version: string; url: string } | null
  message?: string
}

/* ───────────────────────── 插件 ───────────────────────── */

export interface PluginEntry {
  name: string
  version?: string
  enabled: boolean
  description?: string
}

/** 插件目录条目（renderer 视图：在 PluginEntry 基础上追加来源与分类元数据） */
export interface PluginCatalogEntry extends PluginEntry {
  /** 版本固定（pin），空串表示未锁定 */
  version: string
  /** 项目页 / npm 页 */
  repo?: string
  category?: string
  /** verified = npm 元数据可追溯仓库；community = 仅 npm 分发或仅源码 */
  compatibility?: 'verified' | 'community'
  /** 分发来源：npm（默认）= registry 安装；github = 仅源码，按 installSpec 直装 */
  source?: 'npm' | 'github'
  /** GitHub 直装规格（git+https URL，pin 到验证时提交；仅 source=github 时存在） */
  installSpec?: string
}

/* ───────────────────────── 会话中心 ───────────────────────── */

/** 工作区（Trae Workspace 风格项目卡片数据源，镜像官方 workspace.view 结构） */
export interface WorkspaceSummary {
  workspaceId: string
  /** 项目目录绝对路径 */
  path: string
  /** 项目名（官方标题，缺省回退路径 basename） */
  title: string
  /** 会话数（含已归档） */
  sessionCount: number
  createdAt: string
  updatedAt: string
}

/** 会话摘要（镜像官方 session.list 的 SessionSummary 投影） */
export interface SessionSummary {
  sessionId: string
  /** 归属工作区 id（本地兜底数据可能缺失） */
  workspaceId?: string
  /** 会话标题（无标题回退首提示摘要） */
  title: string
  /** 会话所在项目目录 */
  cwd?: string
  /** 子代理会话来源标记 */
  origin?: 'subagent'
  parentSessionId?: string
  /** 运行中 / 空白会话（官方字段，本地兜底时为 false） */
  running: boolean
  blank: boolean
  createdAt: number
  /** 最近活动时间（ms） */
  updatedAt: number
  /** 本地投影：轮数 / 步数（官方接口未返回时由本地缓存补充） */
  turns?: number
  steps?: number
}

export interface SessionsListResult {
  items: SessionSummary[]
  /** 官方 workspace.list 返回的已归档会话 id（本地兜底为空） */
  archivedSessionIds: string[]
  /** 数据来源：official = dsh web RPC；local = ~/.dsh 本地直读（web 未就绪） */
  source: 'official' | 'local'
}

export interface SessionsSearchItem {
  sessionId: string
  /** 命中片段（官方 session.search 提供；本地兜底为标题/路径匹配说明） */
  snippet: string
  title?: string
  cwd?: string
  updatedAt?: number
}

export interface SessionsSearchResult {
  items: SessionsSearchItem[]
  hasMore: boolean
  source: 'official' | 'local'
}

export type SessionExportFormat =
  /** 官方存档 zip（含子代理会话；经 dsh web /api/session.export） */
  | 'zip'
  /** 本地方案：zstd 会话日志渲染为可读 Markdown */
  | 'markdown'
  /** 本地方案：解压后的原始 JSONL（官方 session.jsonl 格式） */
  | 'jsonl'

export interface SessionsExportResult {
  ok: boolean
  /** 成功时的保存路径（取消保存时 ok=false 且无错误提示） */
  path?: string
  /** 用户可见错误 / 提示 */
  message?: string
  /** 用户取消了保存对话框 */
  cancelled?: boolean
}

export interface SessionsResumeResult {
  ok: boolean
  message?: string
}

/* ───────────────────────── 插件健康检查 ───────────────────────── */

export type PluginHealthState = 'healthy' | 'stale' | 'missing' | 'broken'

export interface PluginHealthItem {
  name: string
  state: PluginHealthState
  /** 当前安装版本（未安装 / 损坏时为空） */
  installedVersion?: string
  /** 目录 pin 的最新可用版本（无目录条目时为空） */
  catalogVersion?: string
  /** 健康检查说明（损坏原因 / 可更新提示） */
  detail?: string
}

export interface PluginHealthResult {
  items: PluginHealthItem[]
  /** 存在可更新插件 */
  updatableCount: number
  /** 存在异常插件（missing/broken） */
  brokenCount: number
}

/* ───────────────────────── dshfind 在线市场 ───────────────────────── */

export interface MarketPluginEntry {
  name: string
  /** 展示名（scoped 包等与仓库名不一致时给出，如 @author/name） */
  displayName?: string
  /** dshfind 展示的作者（GitHub 用户） */
  author: string
  description?: string
  /** 星数（解析自列表页，字符串形如 '12' / '1.2k'） */
  stars?: string
  /** 「更新于」信息（语言 · 日期） */
  updated?: string
  repoUrl?: string
  /** 安装规格 = github:<author>/<name>（与 dshfind 官方安装命令一致，走 GitHub 直装通道） */
  installSpec: string
}

export interface MarketSearchResult {
  items: MarketPluginEntry[]
  /** 过滤前命中总数 */
  total: number
  /** 市场数据抓取时间（ISO 8601；无缓存时 null） */
  fetchedAt: string | null
  /** cache = 本地缓存（TTL 内或网络失败回退）；network = 本次实时抓取 */
  source: 'cache' | 'network'
}

/* ───────────────────────── preload API 白名单 ───────────────────────── */

/** preload 通过 contextBridge 暴露给 renderer 的 API 白名单 */
export interface DeepseekApi {
  /* 运行时 */
  getStatus(): Promise<RuntimeStatus>
  restartRuntime(): Promise<RuntimeStatus>
  repairPort(port?: number): Promise<RepairPortResult>
  getDiagnostics(): Promise<DiagnosticsResult>
  openLogs(): Promise<{ ok: boolean }>

  /* 更新 */
  checkUpdater(): Promise<UpdaterCheckResult>
  applyUpdater(version?: string): Promise<{ ok: boolean; message?: string }>
  onUpdaterStatus(listener: (status: UpdaterStatusPayload) => void): () => void

  /* 插件（handler 由插件管理阶段实现） */
  listPlugins(): Promise<{ plugins: PluginEntry[] }>
  getPluginCatalog(): Promise<{ catalog: PluginCatalogEntry[] }>
  installPlugin(
    name: string,
    version?: string,
    spec?: string
  ): Promise<{ ok: boolean; message?: string }>
  removePlugin(name: string): Promise<{ ok: boolean; message?: string }>
  checkPluginsHealth(): Promise<PluginHealthResult>
  updateAllPlugins(): Promise<{ ok: boolean; message?: string }>
  searchMarket(query: string): Promise<MarketSearchResult>
  refreshMarket(): Promise<MarketSearchResult>

  /* 会话中心 */
  listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }>
  listSessions(workspaceId?: string): Promise<SessionsListResult>
  searchSessions(query: string): Promise<SessionsSearchResult>
  exportSession(
    sessionId: string,
    format: SessionExportFormat,
    includeDescendants?: boolean
  ): Promise<SessionsExportResult>
  resumeSession(sessionId: string): Promise<SessionsResumeResult>
  openWorkspaceFolder(path: string): Promise<{ ok: boolean; message?: string }>

  /* 配置 */
  getConfig(): Promise<ConfigState>
  saveApiKey(key: string): Promise<{ ok: boolean; message?: string }>
  saveModel(model: string): Promise<{ ok: boolean; message?: string }>
  savePreferences(patch: Partial<Preferences>): Promise<Preferences>

  /* 事件订阅（返回取消函数） */
  onStatus(listener: (status: RuntimeStatus) => void): () => void
  onOpProgress(listener: (progress: OpProgress) => void): () => void
}

declare global {
  interface Window {
    api?: DeepseekApi
  }
}
