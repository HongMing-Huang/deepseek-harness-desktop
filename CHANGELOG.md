# Changelog

双轨版本说明：应用壳（Deepseek 本体，仓库 deepseek-harness-desktop）与内嵌 dsh 运行时各自独立演进，下方分两个小节记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 上游同步说明：`sync-upstream` 机器人检测到 `@deepseek-ai/dsh` 新版时，会在下方「dsh 运行时」小节顶部自动追加形如
> `### [新版本]` + `upstream-sync：<旧版本> → <新版本>（机器人自动提交，待人工验证后合并）` 的条目，
> 人工验证 PR 后才会进入正式发布；未验证的条目不代表已发布内容。

## 应用壳（Deepseek）

### [0.1.4] - 2026-08-18

#### 变更

- 官网内容与产品截图更新为官方「设置 → 插件 → 插件市场」的实际界面，移除已经下线的独立会话中心、独立插件窗口、精选目录、健康检查和全量更新描述。

### [0.1.3] - 2026-08-17

#### 变更

- 恢复官方 Web 为唯一业务界面：移除自定义工具栏、设置、会话中心、文件树和独立插件窗口；保留官方原生会话、工作区与插件管理。
- 插件市场改为官方「设置 → 插件」中的 `settings.plugins.tab` 扩展；市场 client bundle 随内嵌运行时分发，并经官方启动图登记。E2E 覆盖打开 Tab、加载市场卡片和客户端错误检查。
- 移除不再有界面的精选插件目录、插件健康检查、全量更新按钮和自定义主题偏好，避免与官方功能重复。

#### 修复

- 市场扩展改用受限 loopback 桥接：只接受当前 dsh Web origin 的请求，提供市场搜索、已安装列表与安装操作。

### [0.1.2] - 2026-08-16

#### 新增

- 主界面工具栏：主窗口顶部常驻按钮栏（会话中心 / 插件 / 设置 + 实时运行状态），官方 Web 视图下移排列，不注入官方页面。
- 会话中心：首页新增「全部会话」卡片（含无工作区归属的子代理会话）；工作区新增文件树（目录懒加载展开、点文件默认应用打开、git 变更四色标记 M/A/D/?、大小展示，全程只读）；刷新按钮与窗口聚焦自动刷新；macOS 应用菜单新增会话中心/插件入口与 `Cmd/Ctrl+Shift+S` 快捷键。
- 插件市场：精选目录新增分类 chips 组合过滤；搜索框 Enter 立即执行；市场安装成功后刷新「已安装」标记；GitHub 直装条目缺 installSpec 时明确报错。
- 统一设计系统：`theme.css` 收敛全部自有页面（启动/设置/插件/会话/工具栏）的颜色/字体/圆角令牌；设置新增「外观」卡，四套强调色主题（品牌蓝/松石绿/星云紫/琥珀金）即点即生效，官方 Web 界面不受影响。
- 更新闭环：应用内壳更新检查（24h 自动 + 托盘手动）发现新版本时弹窗引导下载。

#### 修复

- 插件名白名单校验（拒绝前导连字符/空白/路径穿越形状，防参数注入）。
- settings/plugins/sessions 窗口导航白名单收紧为自有页面精确地址（防本地文件读取）。
- E2E userData 隔离修复：Electron 在 macOS 忽略 HOME，新增 `DSH_USER_DATA` 显式覆盖，测试不再读写真实偏好目录。

### [0.1.1] - 2026-08-15

#### 变更

- macOS 产物改为 ad-hoc 签名（免费、无需开发者账号）：修复下载后 Gatekeeper 判「已损坏」直接移入废纸篓的问题——现在「右键 → 打开」即可放行；官网 FAQ 补充 `xattr -cr` 兜底指引。
- Release 资产精简：去除 zip 与全部无版本号副本，仅保留 6 个安装包（dmg×2 / deb×2 / AppImage×2）+ 合并 SHA256 清单 + latest.yml；官网下载链接改为按 releases/latest 动态解析版本号拼接。

### [未发布]

#### 移除

- 移除未能与官方 Web 稳定集成的独立会话中心、文件树和插件管理窗口，以及对应 IPC、预加载接口和 E2E 钩子；会话和工作区继续使用官方 Web 原生能力，插件市场改为官方「设置 → 插件」扩展槽位中的单一入口。

#### 新增

- `prepare-runtime` 新增 dsh 官方来源校验：安装（含幂等跳过）后验证包名/钉死版本/`repository` 指向 `deepseek-ai/deepseek-harness`，并核对 npm registry 元数据维护者属 deepseek-ai；任一不匹配即构建失败，安装日志打印来源声明。
- 托盘常驻（`tray`）：官方黑鲸剪影模板图标（macOS 16/32px template，Linux/Windows 32px）；菜单提供显示主窗口 / 会话中心 / 插件市场 / 设置 / 检查更新 / 退出；tooltip 附加运行状态（启动中/运行中/出错/更新中，订阅 supervisor 与更新器状态）。
- 原生通知：运行时启动失败（含分类器原因摘要）、发现 dsh 新版本、插件安装/卸载/全量更新完成（成功与失败）三类事件弹出系统通知，点击聚焦对应窗口；同 key 60s 去重去抖（纯函数去重器 + 单测），通知内容不含密钥与日志原文。
- 会话管理中心（`sessions`，对标 Claude Desktop / Codex 会话体验 + Trae Workspace 项目卡片）：工作区卡片首页（项目名/路径/会话数/最近活动，可在官方界面打开或在访达中定位目录）；工作区钻入浏览会话（标题/轮数/步数/最近活动，官方 `workspace.list`+`session.list` RPC 与 `~/.dsh` 本地直读双源合并去重，web 未就绪自动回退本地）；跨工作区全文搜索（官方 `session.search` RPC，部署关闭搜索时回退标题/路径元数据匹配）；恢复会话（打开主窗口官方 Web 界面续接，不注入、不改写官方 web 状态）；导出会话（官方 zip 存档含子代理会话经 `/api/session.export`；本地方案按官方 zstd 帧算法解码渲染 Markdown / 原始 JSONL，可离线导出）。全部只读，绝不改写 dsh 自身数据。
- 插件市场 2.0：已装插件健康检查（healthy/stale/missing/broken 四态徽章：包完整性、名称匹配、与目录 pin 版本比对）；一键全量更新（`dsh plugin update` 转发 pnpm update，复用进度管线 OpProgress 与并发锁，完成可一键重启运行时）；健康摘要与可更新计数，异常/可更新项徽章展示。
- 插件市场 2.0 之 GitHub 直装通道：目录新增 `source: github` 条目（仅源码分发的高星工作向插件：批注/GenUI/记忆进化/审批复核/审计索引等，`installSpec` 为 `git+https…@<验证时提交>` 精确 pin，scoped 包名原样支持）；直装规格经主进程白名单校验（仅接受 github.com git 规格）；安装与全量更新时按官方指引自动把包名写入 profile `pnpm-workspace.yaml` 的 `allowBuilds`（幂等、保留原键）放行其 prepare 构建脚本；目录另收录 3 个实际发布于 scoped npm 名下的高星插件（`dsh-better-sidebar` / `@zseven-w/dsh-openpencil` / `@linxin666/dsh-web-ui-all`）。
- 插件直装自检修复：`allowBuilds` 改为 pnpm 10 映射形态（`name: true`，旧 pnpm 9 列表自动迁移）；安装时同时放行传入包名与规格推导的仓库名，失败且输出含 `Ignored build scripts` 时按 pnpm 打印的精确 key 补放行并自动重试一次；全量更新预放行覆盖 profile 依赖值为 git 规格的外源直装插件。
- 会话「恢复」增强：恢复会话时打开主窗口官方 Web 界面的同时，在系统文件管理器中定位该会话所在项目目录（Trae 式工作区上下文）；定位失败不影响恢复本身。
- **dshfind 在线市场接入**（插件窗口新增「dshfind 市场」Tab）：主进程拉取 dshfind.com/zh/plugins 并解析卡片（1200+ 条目：名称/作者/描述/星数/更新信息/仓库链接），userData 缓存 24h 本地搜索，可强制刷新；安装复用 dshfind 官方命令 `github:<author>/<name>` 走 GitHub 直装通道；解析失败/网络失败均明确降级，不产出垃圾条目。
- 文档套件与体验打磨：补齐 `LICENSE`（MIT）并新增 `ARCHITECTURE.md` / `SECURITY.md` / `CONTRIBUTING.md` / PR 与 Issue 模板；README 新增「更新边界」「官方生态链接」「项目文档」小节；settings/plugins/sessions 三窗口统一外链守卫（https 转系统浏览器 + 导航拦截）；插件窗口目录与市场条目新增「仓库」外链与底部官方生态链接（插件管理文档/架构/Cordis/dshfind）；会话中心新增刷新按钮、聚焦自动刷新与 `Cmd/Ctrl+Shift+S` 菜单快捷键。
- 官网（`site/`）重设计：对齐官方 deepseek.com/harness 设计语言——深色页面、玻璃卡片、发丝描边、大写 mono kicker、红绿灯终端窗口；首页特性更新为六大已交付能力，插件预览替换为真实精选目录条目并新增 dshfind 入口，FAQ 补充会话中心只读说明。

#### 移除

- removed: token activity sidebar (use official web usage view)——下线 Token 活动侧栏全链路：`activity` 页面与样式脚本、`token-pipeline` 采样管线与 `token-metrics` 纯函数、`TokenGetSeries`/`TokenSample` IPC 通道与类型、应用菜单入口及对应单测/E2E 场景；用量统计请使用 dsh 官方 Web 自带视图。

#### 变更

- 品牌与命名统一：产品名 `Deepseek`，仓库名为 `deepseek-harness-desktop`；同步更新包名、appId（`com.deepseek.harness-desktop`）、窗口/菜单/页面标题、官网下载链接、发布流水线产物命名与文档（内嵌 dsh 运行时及 `~/.dsh` 数据目录等上游命名保持不变）。
- macOS 用户数据目录随 `productName` 变更为 `~/Library/Application Support/Deepseek/`（Linux 为 `~/.config/Deepseek/`），FAQ 与卸载残留说明已同步。
- macOS 关窗不再退出应用（驻留托盘/dock，可再拉起）；其余平台保持关窗即退出。托盘退出与菜单退出共用 `before-quit` 优雅关闭通道。

### [0.1.0] - 2026-08-14

#### 新增

- 初始骨架：Electron 三层结构（main / preload / renderer）、IPC 集中登记、splash 启动页。
- `ProcessSupervisor`：dsh web 子进程托管（空闲端口探测、HTTP 探活、优雅停止、pid 文件）。
- `prepare-runtime` 脚本：内嵌 Node / pnpm / dsh 运行时准备（幂等、重试、进度、平台元数据校验、下载完整性校验）。
- 主进程文件日志（`userData/logs/main.log`，超限自动截断）。
- preload 来源守卫：仅应用自有页面可获得 `window.api`。
- 运行时单架构瘦身（`--platform` / `--arch` / `--prune-others`），Linux 打包支持（deb + AppImage）。
- 应用图标与 splash 品牌区鲸鱼 logo。
- 首启引导：未配置 API Key 时 splash 页内联引导卡（0600 凭据写入、可跳过，dsh web 自带 onboarding 兜底）。
- 启动失败错误分类（`error-classifier`）：按错误类型给出重试 / 端口占用一键释放 / 凭据指引 / 查看日志等分类动作，就绪后意外退出也会回落到错误卡。
- 设置窗口（`settings`）：默认模型、API Key 管理（单键合并写入凭据文件，不覆盖其它键）、npm 镜像、壳更新仓库（`owner/repo` 格式校验）。
- 插件管理窗口（`plugins`）：安装（支持指定版本）/卸载/进度展示；遵循 pnpm 10 默认安全策略，不执行依赖包 install scripts。
- Token 活动侧栏（`activity`）：分钟采样本机会话投影缓存，累计/四分类（未缓存输入/输出/缓存读/缓存写）、上下文压力与 1 小时/今日/7 天趋势图。
- 双轨自动更新：应用壳 Release 检查（仓库可在设置中配置）+ dsh 侧载安装、校验失败自动回退内嵌版；更新热切换期间与手动重启/端口修复互斥。
- 官网（GitHub Pages）与四条 CI/CD 流水线：CI 门禁（typecheck + 单测 + build + 隐私合规）、四平台发布矩阵、上游 npm 版本同步机器人、Pages 自动部署。

#### 修复

- 二次激活（dock 重建窗口）时对已就绪进程重复注册一次性监听导致 splash 卡死的问题。
- 主进程广播改为覆盖全部自有 webContents，activity/settings/plugins 等 WebContentsView 页面不再漏收状态/进度/更新/Token 采样事件。
- dsh 子进程 spawn 失败（如 ENOENT）后 supervisor 状态不清理导致停止流程悬挂、应用无法退出的问题。
- 凭据文件改为单键合并写入，不再全量覆盖 `~/.dsh/.credentials.yaml` 中的其它键。
- 外链守卫改 URL 严格解析（hostname + 端口全等比对），杜绝前缀绕过。
- 端口占用清理增加进程命令行二次校验，避免 PID 复用误杀无关进程。
- 偏好保存串行化，避免并发读-改-写丢失字段。
- Token 采样对瞬态异常（目录未就绪/单次解析失败）改为重试，不再永久停用。

## dsh 运行时（@deepseek-ai/dsh）
### [0.1.1-rc.1]

- upstream-sync：`@deepseek-ai/dsh` 0.1.0-rc.6 → 0.1.1-rc.1（机器人自动提交，待人工验证后合并）。


### [0.1.0-rc.6]

- 当前钉死的内嵌版本；由 `npm run prepare:runtime` 安装于 `resources/runtime/dsh/`。
- 版本清单见 `resources/runtime/dsh/version.json`（含 dsh / pnpm / node 主版本）。
- 文档重写与配图：README 按大型项目格式重排（logo / 徽章 / 界面预览 / 特性 / 安装 / 功能详解 / 更新边界 / 未来方向 / 架构与安全 / CI 发布），移除同类项目对比等内容；新增应用实拍截图（启动引导 / 官方 Web / 会话中心，`site/assets/screenshots/`）并同步展示于 README 与官网「界面预览」区；E2E 新增第七场景（`DSH_E2E_WINDOW` 钩子打开会话中心窗口，验证 window.api 与页面渲染并产出截图）。
- 安全加固：settings/plugins/sessions 三窗口 `will-navigate` 白名单从宽泛的 `file:` 前缀收紧为三个自有页面的精确地址，杜绝任意本地文件经窗口导航被读取。
