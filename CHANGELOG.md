# Changelog

双轨版本说明：应用壳（Deepseek 本体，仓库 deepseek-harness-desktop）与内嵌 dsh 运行时各自独立演进，下方分两个小节记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 上游同步说明：`sync-upstream` 机器人检测到 `@deepseek-ai/dsh` 新版时，会在下方「dsh 运行时」小节顶部自动追加形如
> `### [新版本]` + `upstream-sync：<旧版本> → <新版本>（机器人自动提交，待人工验证后合并）` 的条目，
> 人工验证 PR 后才会进入正式发布；未验证的条目不代表已发布内容。

## 应用壳（Deepseek）

### [未发布]

#### 新增

- `prepare-runtime` 新增 dsh 官方来源校验：安装（含幂等跳过）后验证包名/钉死版本/`repository` 指向 `deepseek-ai/deepseek-harness`，并核对 npm registry 元数据维护者属 deepseek-ai；任一不匹配即构建失败，安装日志打印来源声明。

#### 移除

- removed: token activity sidebar (use official web usage view)——下线 Token 活动侧栏全链路：`activity` 页面与样式脚本、`token-pipeline` 采样管线与 `token-metrics` 纯函数、`TokenGetSeries`/`TokenSample` IPC 通道与类型、应用菜单入口及对应单测/E2E 场景；用量统计请使用 dsh 官方 Web 自带视图。

#### 变更

- 品牌与命名统一：产品名由 `DSH Desktop` 改为 `Deepseek`，仓库名由 `dsh-desktop` 改为 `deepseek-harness-desktop`；同步更新包名、appId（`com.deepseek.harness-desktop`）、窗口/菜单/页面标题、官网下载链接、发布流水线产物命名与文档（内嵌 dsh 运行时及 `~/.dsh` 数据目录等上游命名保持不变）。
- macOS 用户数据目录随 `productName` 变更为 `~/Library/Application Support/Deepseek/`（Linux 为 `~/.config/Deepseek/`），FAQ 与卸载残留说明已同步。

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

### [0.1.0-rc.6]

- 当前钉死的内嵌版本；由 `npm run prepare:runtime` 安装于 `resources/runtime/dsh/`。
- 版本清单见 `resources/runtime/dsh/version.json`（含 dsh / pnpm / node 主版本）。
