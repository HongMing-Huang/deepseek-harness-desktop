# DSH Desktop

DeepSeek Harness 桌面版：将 `@deepseek-ai/dsh`（DeepSeek 官方 CLI Harness）的 Web UI 打包为类 Codex 形态的 Electron 桌面应用。内嵌 Node / pnpm / dsh 运行时，开箱即用，无需用户预装任何命令行工具。

## 架构概览

标准 Electron 三层结构，IPC 通道集中登记：

```
src/
├── main/                      # 主进程
│   ├── index.ts               # 应用生命周期、窗口管理、运行时引导
│   ├── ipc.ts                 # IPC 集中注册表（handler 统一在此挂载）
│   ├── logger.ts              # 主进程文件日志（userData/logs/main.log）
│   └── runtime/
│       ├── paths.ts           # 内嵌运行时路径解析与子进程环境构建
│       └── process-supervisor.ts  # dsh web 子进程托管（端口探测/探活/优雅停止）
├── preload/                   # 预加载脚本
│   └── index.ts               # contextBridge 白名单（仅暴露 window.api）
├── renderer/                  # 渲染进程（纯原生 JS，无框架）
│   ├── splash.html/css/js     # 启动等待页（状态订阅 + 诊断信息）
│   └── assets/                # 静态资产（logo 等）
└── shared/
    └── ipc.ts                 # IPC 通道与载荷的集中定义（三层共用）
```

运行时布局（由 `scripts/prepare-runtime.ts` 产出，打包进 `extraResources`）：

```
resources/runtime/
├── node/<arch>/node       内嵌 Node 24.x 二进制
├── pnpm/<arch>/pnpm       pnpm 可执行入口（shim 或 standalone）
└── dsh/                   @deepseek-ai/dsh 及其依赖 + version.json
```

启动流程：主窗口先加载 splash → `ProcessSupervisor` 拉起 `dsh web --port <n>` → HTTP 探活就绪后窗口切换至 `http://127.0.0.1:<port>`。

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

1. 在 GitHub 上创建一个空仓库（不要初始化 README）。
2. 本地添加远端：`git remote add origin <你的仓库 URL>`。
3. 推送：`git push -u origin main`。

注意：`resources/runtime/`、`out/`、`release/`、`node_modules/` 均已被 `.gitignore` 排除，不会进入版本库；克隆后需重新执行 `npm install && npm run prepare:runtime`。

推送后还需完成两处占位符替换（详见 `.github/` 与 `site/` 内注释）：

- `site/assets/app.js` 顶部的 `OWNER_PLACEHOLDER` 替换为真实 GitHub 用户名/组织名（官网下载链接与版本徽章依赖它）；
- 仓库 Settings → Pages → Source 选择 "GitHub Actions"（启用官网自动部署）。

## CI/CD 与发布流程

流水线全部位于 `.github/workflows/`，四条职责分离：

| Workflow | 触发 | 职责 |
| --- | --- | --- |
| `ci.yml` | push / PR 到 main | `typecheck` → `build`（不依赖 runtime，不跑 `prepare:runtime`）→ 隐私合规检查 |
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
