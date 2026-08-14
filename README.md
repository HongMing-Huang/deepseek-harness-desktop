# Deepseek

[![CI](./actions/workflows/ci.yml/badge.svg)](./actions/workflows/ci.yml) [![Release](./actions/workflows/release.yml/badge.svg)](./actions/workflows/release.yml)

Deepseek（GitHub 仓库：`deepseek-harness-desktop`）— DeepSeek Harness 桌面版：将 `@deepseek-ai/dsh`（DeepSeek 官方 CLI Harness）的 Web UI 打包为类 Codex 形态的 Electron 桌面应用。内嵌 Node / pnpm / dsh 运行时，开箱即用，无需用户预装任何命令行工具。

## 架构概览

标准 Electron 三层结构，IPC 通道集中登记：

```
src/
├── main/                      # 主进程
│   ├── index.ts               # 应用生命周期、窗口管理、运行时引导、退出清理
│   ├── ipc.ts                 # IPC 集中注册表（handler 统一挂载 + 广播覆盖全部自有 webContents）
│   ├── windows.ts             # 主窗口 / dsh web 全幅视图管理与外链守卫
│   ├── tray.ts                # 托盘常驻（状态感知 tooltip + 菜单 + 原生通知）
│   ├── notify-gate.ts         # 通知去重器与托盘状态文案（纯函数，可单测）
│   ├── sessions.ts            # 会话管理中心（官方 RPC 与 ~/.dsh 双源只读 + zstd 导出渲染）
│   ├── config.ts              # ~/.dsh 配置读写（凭据单键合并、偏好串行化）
│   ├── logger.ts              # 主进程文件日志（userData/logs/main.log）
│   └── runtime/
│       ├── paths.ts           # 内嵌运行时路径解析与子进程环境构建、侧载目录清理
│       ├── process-supervisor.ts  # dsh web 子进程托管（端口探测/探活/优雅停止）
│       ├── dsh-installer.ts   # dsh 侧载安装/校验/失败回退内嵌版
│       ├── port-doctor.ts     # 端口占用诊断与安全清理（命令行二次校验）
│       ├── plugins.ts         # dsh 插件安装/卸载/健康检查/一键全量更新/直装与进度广播
│       ├── plugin-progress.ts # pnpm 输出进度解析纯函数
│       ├── dshfind.ts         # dshfind.com 在线市场（拉取/卡片解析/缓存/搜索）
│       ├── updater.ts         # 双轨更新（壳 Release 检查 + dsh 热切换）
│       └── error-classifier.ts # 启动失败错误分类与动作建议
├── preload/                   # 预加载脚本
│   └── index.ts               # contextBridge 白名单（仅暴露 window.api）
├── renderer/                  # 渲染进程（纯原生 JS，无框架）
│   ├── splash.html/css/js     # 启动等待页（首启引导 + 状态订阅 + 错误分类卡 + 诊断信息）
│   ├── settings.html/js       # 设置窗口（默认模型/凭据/镜像/壳更新仓库）
│   ├── plugins.html/js        # 插件管理窗口（安装/卸载/健康徽章/一键全量更新/进度）
│   ├── sessions.html/css/js   # 会话中心（工作区卡片首页 + 会话浏览/搜索/恢复/导出）
│   └── assets/                # 静态资产（logo 等）
└── shared/
    ├── ipc.ts                 # IPC 通道与载荷的集中定义（三层共用）
    └── versions.ts            # 内嵌运行时版本清单（dsh / pnpm / node）

tests/
├── plugin-progress.test.ts    # pnpm 输出进度解析单测
├── tray-notify.test.ts        # 通知去重器与托盘状态文案单测
├── sessions.test.ts           # zstd 帧扫描 / 多帧解码 / Markdown 渲染单测
└── e2e/run-e2e.mjs            # E2E（playwright-core CDP，引导/进度/配置/插件/更新/会话/健康）
```

运行时布局（由 `scripts/prepare-runtime.ts` 产出，打包进 `extraResources`）：

```
resources/runtime/
├── node/<arch>/node       内嵌 Node 24.x 二进制
├── pnpm/<arch>/pnpm       pnpm 可执行入口（shim 或 standalone）
└── dsh/                   @deepseek-ai/dsh 及其依赖 + version.json
```

启动流程：主窗口先加载 splash → `ProcessSupervisor` 拉起 `dsh web --port <n>` → HTTP 探活就绪后窗口切换至 `http://127.0.0.1:<port>`。

### 会话中心与插件市场 2.0（贴合官方的差异化方向）

**红线**：官方 dsh web 一律不改动、不注入（`dshWebView` 无 preload、强沙箱），全部差异化能力由桌面壳外挂实现；dsh 运行时始终来自官方 npm 分发并 6 小时自动跟版。

- 会话中心（菜单「工具 → 会话中心」，托盘同级入口）为**只读**体验层：列表数据来自官方 `workspace.list` / `session.list` RPC（经 `http://127.0.0.1:<port>/api/<method>`，browser-trust 防线放行无 Origin 的本机主进程请求）与 `~/.dsh` 本地存储双源合并；web 未就绪时自动回退本地直读（`storages/workspace.json` + `session_projcache.json` + 会话工件 mtime）。全文搜索走官方 `session.search`，部署关闭搜索索引时回退标题/路径匹配。导出：官方 zip 存档经 `/api/session.export`（含子代理会话）；Markdown / JSONL 由本地方案按官方 zstd 帧算法解码渲染，离线可用。「恢复」即打开主窗口官方 Web 界面续接，并同步在系统文件管理器中定位该会话所在项目目录（Trae 式工作区上下文），会话选择仍由官方 UI 负责。
- 插件市场 2.0 在既有「目录搜索 + 安装/卸载」之上新增：健康检查（包完整性 / 名称匹配 / 与目录 pin 版本比对，四态徽章）与一键全量更新（`dsh plugin update` 转发 pnpm update，复用进度与并发锁）。目录条目分两种来源：`npm`（registry 分发，pin 精确版本；含 scoped 包）与 `github`（仅源码分发的高星工作向插件，如 `dsh-better-sidebar` 同源工作台、批注、GenUI、记忆进化等——按 `git+https…@<提交>` 直装，pin 到验证时提交；安装/全量更新时按官方指引自动把包名写入 profile `pnpm-workspace.yaml` 的 `allowBuilds`（pnpm 10 映射形态 `name: true`，幂等、旧列表自动迁移）放行其构建脚本）。直装规格经主进程白名单校验（仅接受 github.com 的 git 规格），其余 URL/协议一律拒绝。
- **dshfind 在线市场**（`dshfind.ts`）：应用内「插件 → dshfind 市场」Tab 接入 [dshfind.com/zh/plugins](https://dshfind.com/zh/plugins)——主进程拉取列表页并解析卡片（1200+ 条目，名称/作者/描述/星数/更新信息/仓库链接），缓存于 userData（TTL 24h）本地搜索；安装复用 dshfind 官方命令 `dsh plugin add github:<author>/<name>` 走 GitHub 直装通道；页面结构变化时明确报错、网络失败回退陈旧缓存，绝不静默产出垃圾条目。

### 与同类桌面项目的差异（对比 anywhere-labs/deepseek-harness-desktop 等）

已交付对方尚未发布或未规划的能力：会话管理中心（项目卡片/搜索/恢复/导出）、插件市场 2.0（精选目录 + dshfind 在线市场 + GitHub 直装 + 健康检查 + 一键全量更新）、原生通知、6 小时自动跟版与官方来源校验。

**路线图**（明确差距，未实现不冒充）：

| 方向 | 状态 | 说明 |
| --- | --- | --- |
| Windows 构建 | 未支持 | `prepare-runtime` 为 POSIX-only（darwin/linux）；需先完成 Node/pnpm 运行时准备与路径/环境变量的跨平台移植，再开 win32 构建矩阵 |
| 手机远程控制 | 未规划 | 对端 App 与鉴权面大，属独立项目 |
| IM Channels（微信/飞书/Discord） | 未规划 | 同上，依赖独立通道适配 |
| macOS 签名/公证 | 暂缓 | 按需排期（当前未签名构建，首启需放行） |

### dsh 来源说明（内嵌运行时的官方来源）

- 内嵌 dsh 运行时由 `npm run prepare:runtime` 执行 `scripts/prepare-runtime.ts`，从 npm 官方源（registry.npmjs.org）安装官方发布包 `@deepseek-ai/dsh@<DSH_VERSION>`（钉死版本，见 `src/shared/versions.ts`）——即上游官方 GitHub 仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的分发物，绝不使用本地拷贝或私有源。
- 安装完成后脚本会强制执行**来源校验**：包名、钉死版本、`repository` 字段必须指向上游官方仓库，且 npm registry 元数据中该版本的维护者须属 deepseek-ai 官方（个人发布者账号名或邮箱域名含 deepseek 标识）；任一不匹配即构建失败并给出明确报错（幂等重跑时同样校验）。安装日志会打印一行来源声明，例如：`dsh source: @deepseek-ai/dsh@0.1.0-rc.6 from npm registry (official distribution of github.com/deepseek-ai/deepseek-harness)`。
- 如需重建：删除 `resources/runtime/dsh/` 后重跑 `npm run prepare:runtime` 即可重新从官方源安装；`resources/runtime/` 不入版本库。
- 用户数据目录 `~/.dsh`（凭据、配置、会话、插件）属于 dsh 自身，与打包/分发无关，构建与安装过程永远不会触碰它。

## 构建步骤

前置：Node >= 22.19.0、npm。

```bash
npm install                # 安装开发依赖
npm run prepare:runtime    # 下载内嵌 node/pnpm 并安装 dsh（幂等）
npm run dev                # 本地开发运行
npm run typecheck          # TypeScript 检查
npm run build              # 构建 out/（main/preload/renderer）

# 打包（先按目标组合瘦身运行时，再构建 + electron-builder）
npm run dist:mac-arm64     # 本机默认
npm run dist:mac-x64
npm run dist:linux-x64
npm run dist:linux-arm64
```

产物输出至 `release/`，未签名（`identity: null`、`notarize: false`），首次启动需在系统设置中放行。

## 隐私与注释约定

注释与文档只写开发内容，禁止个人信息（用户名、私有绝对路径、邮箱、主机名等）。

## 推送到 GitHub（通用指引）

1. 在 GitHub 上创建一个空仓库，命名为 `deepseek-harness-desktop`（不要初始化 README）。
2. 本地添加远端并推送：

```bash
git remote add origin https://github.com/<owner>/deepseek-harness-desktop.git
git push -u origin main
```

克隆示例：`git clone https://github.com/<owner>/deepseek-harness-desktop.git`。

注意：`resources/runtime/`、`out/`、`release/`、`node_modules/` 均已被 `.gitignore` 排除，不会进入版本库；克隆后需重新执行 `npm install && npm run prepare:runtime`。

推送后还需完成三处占位符替换（详见 `.github/` 与 `site/` 内注释）：

- `site/assets/app.js` 顶部的 `OWNER_PLACEHOLDER` 替换为真实 GitHub 用户名/组织名（官网下载链接与版本徽章依赖它）；
- `src/main/config.ts` 中的 `DEFAULT_UPDATE_REPO`（占位值 `owner/deepseek-harness-desktop`）替换为真实仓库（`<owner>/deepseek-harness-desktop`），或在应用设置窗口「壳更新仓库」中配置（持久化于 preferences，优先于默认值）；
- 仓库 Settings → Pages → Source 选择 "GitHub Actions"（启用官网自动部署）。

## CI/CD 与发布流程

流水线全部位于 `.github/workflows/`，四条职责分离：

| Workflow | 触发 | 职责 |
| --- | --- | --- |
| `ci.yml` | push / PR 到 main | `typecheck` → `test`（单测门禁）→ `build`（不依赖 runtime，不跑 `prepare:runtime`）→ 隐私合规检查 |
| `sync-upstream.yml` | 每 6 小时 cron + 手动 | 检查 npm 上 `@deepseek-ai/dsh` 新版，有则更新 `DSH_VERSION` + CHANGELOG 并开 `upstream-sync` 标签 PR |
| `release.yml` | push tag `v*` | 校验 tag 与 package.json 一致 → 四平台矩阵构建（darwin/linux × arm64/x64）→ 冒烟测试 → SHA256 清单 → 创建 Release |
| `pages.yml` | main 上 `site/**`/README 变更、Release 发布 | 将 `site/` 原样部署到 GitHub Pages |

### 版本纪律（双轨制的边界）

- **应用壳版本**（`package.json` 的 `version`）：只经「版本 PR」人工 bump，绝不自动更新；
- **dsh 运行时版本**（`src/shared/versions.ts` 的 `DSH_VERSION`）：只由 `sync-upstream` 机器人 PR 更新，人工验证后合并；
- **Release 只认 `vX.Y.Z` tag**：`release.yml` 会强校验 tag 与 `package.json` version 一致，不一致直接失败；upstream-sync PR 合并只推 main，天然不会触发 Release；
- 机器人绝不自动合并、绝不自动发版。

### 发布步骤 checklist

1. 确认 main 上 CI 绿色，`DSH_VERSION` 为期望值（如需更新，先合并 upstream-sync PR）；
2. 走「版本 PR」bump 应用壳 `version`，同步补全 `CHANGELOG.md` 应用壳小节；
3. 合并后打 tag 并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`；
4. `release.yml` 自动完成：四平台构建 + 冒烟 + `SHASUMS256.txt` + 无版本号副本（官网 `releases/latest/download/` 稳定直链）+ `latest.yml` 占位（未来 electron-updater 预留）；
5. 核对 Release 附件齐全（dmg×2、zip×2、deb×2、AppImage×2 及各自无版本副本、两份清单），必要时手动编辑 Release notes；
6. Release published 会自动触发 `pages.yml` 刷新官网（页脚版本徽章随之更新）。

### 上游同步机制

`sync-upstream.yml` 每 6 小时通过 `scripts/check-upstream.mjs`（零依赖）查询 npm registry 的 `@deepseek-ai/dsh` `dist-tags.latest`，与 `DSH_VERSION` 做语义化比较（含 rc 等 prerelease 段）。检测到新版时自动更新 `versions.ts` 与 CHANGELOG，并以 `upstream-sync` 标签创建 PR（标题含新旧版本）；无新版则静默结束。注意：仓库长期无提交活动时 GitHub 会自动暂停 scheduled workflow，手动跑一次 workflow_dispatch 即可恢复。

### 卸载与回退残留位置

卸载应用或排查问题时，以下本机目录/文件不会随应用自动删除，可按需手动清理：

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| macOS `~/Library/Application Support/Deepseek/runtimes/`（Linux `~/.config/Deepseek/runtimes/`） | dsh 侧载更新目录 | 删除后下次启动自动回用内嵌版本 |
| `.../Deepseek/preferences.json` | 应用偏好（默认模型/镜像/更新仓库等） | 删除后恢复默认值 |
| `~/.dsh/` | dsh 自身配置（凭据 `.credentials.yaml` 等） | 由 dsh 管理，卸载应用不涉及 |
| `.../Deepseek/logs/main.log` | 主进程日志 | 排障时查看，可安全删除 |
