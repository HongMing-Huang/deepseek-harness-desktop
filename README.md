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
