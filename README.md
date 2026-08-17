# Deepseek

<p align="center">
  <img src="site/assets/whale-hero.png" width="180" alt="Deepseek logo" />
</p>

<p align="center">
  <strong>DeepSeek Harness 的桌面形态</strong> —— 官方运行时，桌面体验。
</p>

<p align="center">
  <a href="https://github.com/HongMing-Huang/deepseek-harness-desktop/releases/latest"><img src="https://img.shields.io/badge/下载-Latest%20Release-4d6bfe?style=flat-square" alt="latest release"></a>
  <a href="https://hongming-huang.github.io/deepseek-harness-desktop/"><img src="https://img.shields.io/badge/官网-GitHub%20Pages-181717?style=flat-square" alt="website"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat-square" alt="MIT License"></a>
</p>

Deepseek（仓库 `deepseek-harness-desktop`）把官方 DeepSeek Harness 的本地 Web UI 打包为开箱即用的桌面应用：内嵌 Node / pnpm / dsh 运行时，零环境依赖；主窗口不覆盖工具栏。除插件市场使用官方提供的设置扩展槽位外，官方 Web 不改动。

## 界面预览

| 启动引导 | 官方 Web 界面 |
| --- | --- |
| <img src="site/assets/screenshots/splash-welcome.png" width="240" alt="启动引导"> | <img src="site/assets/screenshots/official-web.png" width="240" alt="官方 Web 界面"> |

## 它解决了什么

- **零门槛启动**：Node、pnpm、dsh 全部内置随包分发，不碰系统环境，删掉 App 即彻底卸载；
- **官方体验不打折**：原样内嵌官方 Web 界面，运行时来自官方 npm 分发并做来源校验，每 6 小时自动检查新版、人工验证后合并，不做静默升级；
- **官方会话能力原样保留**：会话、工作区和文件相关操作均由官方 Web 提供，桌面端不再维护额外会话页面；
- **插件装得省心**：dshfind 在线市场嵌入官方「设置 → 插件」页面，搜索与安装通过受限本机桥接完成；
- **出错有人管**：启动失败分类、端口占用清理、双轨更新失败自动回退，托盘通知随时送达。

## 安装

- **直接下载**：[Latest Release](https://github.com/HongMing-Huang/deepseek-harness-desktop/releases/latest)（macOS dmg，Linux deb / AppImage，附 SHA256 校验清单）
- **官网**：[hongming-huang.github.io/deepseek-harness-desktop](https://hongming-huang.github.io/deepseek-harness-desktop/)（平台推荐 + 安装引导 + FAQ）
- macOS 产物采用免费的 ad-hoc 签名（未公证，无需开发者账号）：首次打开请「右键 → 打开」放行，不会再被判为「已损坏」；如仍被拦截可执行 `xattr -cr /Applications/Deepseek.app`（官网 FAQ 有步骤）。

### 从源码构建

前置：Node >= 22.19.0、npm。

```bash
git clone https://github.com/HongMing-Huang/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install                # 安装开发依赖
npm run prepare:runtime    # 下载内嵌 node/pnpm 并安装官方 dsh（幂等，含来源校验）
npm run dev                # 本地开发运行
npm run typecheck && npm run test   # 类型检查 + 单测
npm run build              # 构建 out/（main/preload/renderer）

# 打包（按目标组合瘦身运行时，再 electron-builder）
npm run dist:mac-arm64     # 本机默认
npm run dist:linux-x64
```

官方完整源码以 Git 子模块固定在 `upstream/deepseek-harness`（当前锁定上游提交）；初始化检出使用 `git submodule update --init --recursive`。它用于审阅和后续原生客户端集成。当前稳定发行运行时仍采用官方 dsh 发布包；上游本身是 pnpm 工作区，因此不能将子模块误称为已经完成的无 Node/pnpm 构建替换。

产物输出至 `release/`；`resources/runtime/`、`out/`、`release/`、`node_modules/` 均不入版本库。

## 功能详解

**红线**：主窗口不注入 preload、保持强沙箱；插件市场仅通过官方 `settings.plugins.tab` 扩展槽位接入，dsh 运行时始终来自官方 npm 分发。

- **插件市场**：官方「设置 → 插件」中新增「插件市场」Tab；主进程拉取 dshfind.com 列表页并缓存，安装仍走官方插件命令。市场扩展包随运行时分发，并由启动图登记后加载。

## 更新边界

| 内容 | 更新方式 | 频率 |
| --- | --- | --- |
| dsh 运行时（`src/shared/versions.ts`） | `sync-upstream` 机器人检测 npm 新版本 → 开 PR → **人工验证合并** | 每 6 小时检查 |
| 应用壳版本（`package.json` version） | 「版本 PR」人工 bump，Release 认 `v*` tag | 按需 |
| 应用内 dsh 热更（侧载） | 应用内检查与安装，失败自动回退 | 24h 节流 / 手动 |
| dshfind 市场数据 | 应用内拉取缓存，TTL 24h | 每次搜索检查 |
| 官网 `site/` | 随 main 提交，`pages.yml` 自动部署 | 随提交 |
| 官方 dsh web | 不修改主界面；插件市场仅使用官方设置扩展槽位 | — |
| dsh 数据目录 | 凭据、会话与插件由 dsh 管理；桌面端为市场扩展登记 Cordis patch 与只读运行时包链接 | 启动时 |

## 架构与安全

标准 Electron 三层结构（main / preload / renderer），IPC 通道在 `src/shared/ipc.ts` → `src/main/ipc.ts` → `src/preload/index.ts` 三处集中登记。目录树、数据流与关键决策见 [ARCHITECTURE.md](ARCHITECTURE.md)；威胁模型、报告渠道与构建安全见 [SECURITY.md](SECURITY.md)；开发环境、代码规范与 PR 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```
src/
├── main/                      # 主进程
│   ├── index.ts               # 应用生命周期、窗口管理、运行时引导
│   ├── ipc.ts                 # IPC 集中注册表
│   ├── windows.ts             # 主窗口 / dsh web 视图 / 外链守卫
│   ├── tray.ts                # 托盘常驻 + 原生通知（notify-gate.ts 去重）
│   ├── official-web-extension.ts # 官方设置扩展槽位登记
│   ├── web-bridge.ts          # 市场的受限 loopback 桥接
│   ├── config.ts / logger.ts  # 配置读写 / 文件日志
│   └── runtime/
│       ├── paths.ts           # 内嵌运行时路径解析与子进程环境
│       ├── process-supervisor.ts  # dsh web 子进程托管
│       ├── dsh-installer.ts   # dsh 侧载安装/校验/失败回退
│       ├── port-doctor.ts     # 端口占用诊断与清理
│       ├── plugins.ts         # 插件安装/卸载/健康/直装
│       ├── plugin-progress.ts # pnpm 输出进度解析
│       ├── dshfind.ts         # dshfind 在线市场（拉取/解析/缓存/搜索）
│       ├── updater.ts         # 双轨更新（壳 Release + dsh 热切换）
│       └── error-classifier.ts # 启动失败分类与动作建议
├── preload/index.ts           # contextBridge 白名单（仅暴露 window.api）
├── renderer/                  # 渲染进程（仅启动引导页）
│   ├── splash
└── shared/                    # IPC 通道与载荷定义、运行时版本清单

tests/                         # node:test 单测 + playwright-core CDP E2E
```

## 官方生态链接

- 官方插件管理文档：[apps/cli/reference#plugin-management](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md#plugin-management)
- 官方架构说明：[docs/architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- Cordis 插件内核：[cordiverse/cordis](https://github.com/cordiverse/cordis)
- 社区插件市场：[dshfind.com/zh/plugins](https://dshfind.com/zh/plugins)（已接入应用内市场）
- 社区插件雷达：[awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)

## CI/CD 与发布

流水线位于 `.github/workflows/`：`ci.yml`（typecheck/test/build/隐私扫描门禁）、`sync-upstream.yml`（每 6h 检查官方 dsh 新版本开 PR）、`release.yml`（`v*` tag → 四平台矩阵构建 + 冒烟 + SHA256 清单 + 创建 Release）、`pages.yml`（官网自动部署）。

**发布步骤**：① main 上 CI 绿色 → ② 版本 PR bump `version` 并补 CHANGELOG → ③ `git tag vX.Y.Z && git push origin vX.Y.Z` → ④ Release 自动构建与发布。

## 隐私与注释约定

注释与文档只写开发内容，禁止个人信息（用户名、私有绝对路径、邮箱、主机名等）；`scripts/lint-privacy.mjs` 为 CI 门禁。凭据、配置、会话、插件均由 dsh 管理；桌面端只为内置市场登记扩展并调用官方插件命令。

## 卸载残留位置

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| macOS `~/Library/Application Support/Deepseek/runtimes/`（Linux `~/.config/Deepseek/runtimes/`） | dsh 侧载更新目录 | 删除后下次启动自动回用内嵌版本 |
| `.../Deepseek/preferences.json` | 应用偏好 | 删除后恢复默认值 |
| `~/.dsh/` | dsh 自身配置（凭据/会话/插件） | 由 dsh 管理，卸载应用不涉及 |
| `.../Deepseek/logs/main.log` | 主进程日志 | 排障用，可安全删除 |

## License

[MIT](LICENSE) © 2026 Deepseek Harness Desktop Contributors

> 本项目是基于 DeepSeek Harness 构建的桌面社区版，并非 DeepSeek 官方产品；DeepSeek 及相关标识归其权利人所有。
