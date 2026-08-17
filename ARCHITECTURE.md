# 架构说明（Architecture）

Deepseek（仓库 `deepseek-harness-desktop`）是 DeepSeek Harness 官方 Web UI 的桌面壳。主界面不改动；插件市场通过官方提供的设置扩展槽位接入。本文档说明分层、数据流与关键决策。

## 分层总览

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程（src/main）                                  │
│  index.ts     生命周期 / 运行时引导 / IPC 上下文装配           │
│  windows.ts   主窗口（splash + dshWebView 子视图）             │
│  tray.ts      托盘常驻 + 原生通知（notify-gate.ts 去重）       │
│  runtime/     dsh 子进程托管 / 更新双轨 / 插件 / 市场 / 诊断    │
│  web-bridge.ts / official-web-extension.ts  市场桥接与登记     │
├─────────────────────────────────────────────────────────────┤
│ preload（src/preload/index.ts）                              │
│  contextBridge 白名单 window.api —— 唯一 IPC 出入口           │
├─────────────────────────────────────────────────────────────┤
│ 渲染进程（src/renderer，纯原生 JS 无框架）                     │
│  splash                                                       │
├─────────────────────────────────────────────────────────────┤
│ dshWebView（WebContentsView，无 preload、沙箱）               │
│  官方 DeepSeek Harness Web UI —— 主界面原样消费；市场使用官方 slot │
└─────────────────────────────────────────────────────────────┘
```

## 运行时引导（boot）

1. 主窗口加载 splash 页（本地 file: 页面，含首启引导与错误卡）；
2. `ProcessSupervisor` 分配空闲端口，spawn `node <dshBin> web --port <n>`（env 注入内嵌 Node/pnpm 与 `DSH_HOME`）；
3. HTTP 探活成功后，主窗口挂载 `dshWebView` 子视图加载 `http://127.0.0.1:<port>`；
4. 失败路径由 `error-classifier` 分类（缺件/端口占用/权限/超时/凭据缺失），splash 渲染对应动作按钮。

## 更新双轨

| 轨 | 载体 | 更新方式 |
| --- | --- | --- |
| 应用壳 | 自身安装包 | `updater.ts` 检查 GitHub Releases（仓库可配置），引导下载；版本仅经版本 PR bump |
| dsh 运行时 | 侧载目录 `<userData>/runtimes/dsh/<version>` | `dsh-installer.ts` 从 npm 官方源安装并热切换指针；`sync-upstream.yml` 每 6h 检查新版本开 PR，人工合并 |

侧载版本连续启动失败 2 次自动回退内嵌基线（`lastKnownGoodDsh` 保留回滚目标）。

## 插件市场（official-web-extension.ts / web-bridge.ts / dshfind.ts）

- **官方页面**：扩展注册在 `settings.plugins.tab`，不创建额外窗口，不覆盖官方布局；
- **dshfind 在线市场**：拉取 dshfind.com/zh/plugins 解析卡片并使用 userData 缓存；安装复用其官方命令 `github:<author>/<name>`；
- **受限桥接**：仅接受匹配 dsh origin 的 loopback 请求，提供市场搜索、已装插件和安装三个接口；
- **分发**：市场 client bundle 随内嵌运行时分发，并在 `$DSH_HOME/cordis.patch.yml` 中登记。

## 安全边界

- 远程内容（dsh web）与启动页严格隔离：仅启动页注入 preload，`window.api` 按来源守卫暴露；
- IPC 三处同步登记（shared → main → preload），renderer 无 Node 能力；
- 凭据只存 `~/.dsh`（dsh 管理），主进程仅读写掩码状态，日志/通知/错误文案不含密钥原文；
- 直装规格白名单 + allowBuilds 仅放行目标插件自身构建；
- 隐私扫描（`scripts/lint-privacy.mjs`）为 CI 门禁。

## 关键决策记录（ADR 摘要）

1. **官方主界面优先**：不增工具栏、会话或插件独立窗口；市场仅使用官方公开 slot，降低升级冲突。
2. **不自建文件管理**：官方工作区菜单没有扩展槽位，因此不使用 DOM 注入或伪造文件树。
3. **市场数据来自 dshfind**：保留搜索与安装的必要桥接能力，避免再维护第二套插件管理界面。
4. **原生 JS 渲染层**：仅启动页体量小，无框架依赖降低供应链风险与构建复杂度。
