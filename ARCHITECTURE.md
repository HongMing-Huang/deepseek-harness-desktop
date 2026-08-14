# 架构说明（Architecture）

Deepseek（仓库 `deepseek-harness-desktop`）是 DeepSeek Harness 官方 Web UI 的桌面壳：**官方 dsh web 一律不改动、不注入**，全部差异化能力由桌面壳外挂实现。本文档说明分层、数据流与关键决策。

## 分层总览

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程（src/main）                                  │
│  index.ts     生命周期 / 运行时引导 / IPC 上下文装配           │
│  windows.ts   主窗口（splash + dshWebView 子视图）与           │
│               settings/plugins/sessions 三个自有窗口          │
│  tray.ts      托盘常驻 + 原生通知（notify-gate.ts 去重）       │
│  sessions.ts  会话中心（官方 RPC + ~/.dsh 双源只读）           │
│  runtime/     dsh 子进程托管 / 更新双轨 / 插件 / 市场 / 诊断    │
├─────────────────────────────────────────────────────────────┤
│ preload（src/preload/index.ts）                              │
│  contextBridge 白名单 window.api —— 唯一 IPC 出入口           │
├─────────────────────────────────────────────────────────────┤
│ 渲染进程（src/renderer，纯原生 JS 无框架）                     │
│  splash / settings / plugins（含 dshfind 市场）/ sessions     │
├─────────────────────────────────────────────────────────────┤
│ dshWebView（WebContentsView，无 preload、沙箱）               │
│  官方 DeepSeek Harness Web UI —— 只读消费，零注入             │
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

## 会话中心（sessions.ts）

双源合并、只读优先：

- **官方 RPC**：web 就绪时经 `http://127.0.0.1:<port>/api/<method>` 调用官方 `workspace.list` / `session.list` / `session.search`（POST JSON envelope `{type:"client-request",rpcId,method,payload}`；browser-trust 防线放行无 Origin 的本机主进程请求）；
- **本地直读**：web 未就绪时回退 `~/.dsh/storages/workspace.json` + `session_projcache.json` + 会话工件 mtime；两源按 sessionId 合并去重，标题/轮数/步数以本地投影缓存补充；
- **导出**：官方 zip 经 `GET /api/session.export`；Markdown/JSONL 由本地按官方 zstd 帧扫描算法解码渲染（离线可用）；
- **恢复**：打开主窗口官方 Web 界面 + 定位会话所在项目目录；会话选择仍由官方 UI 负责。

## 插件市场（plugins.ts / dshfind.ts）

- **精选目录**：`plugin-catalog.json`（29 条，npm/scoped 与 github 直装两类，pin 验证时版本/提交）；安装走官方 `dsh plugin --profile web add <spec>` 转发 pnpm；
- **dshfind 在线市场**：拉取 dshfind.com/zh/plugins 解析卡片（1200+），userData 缓存 24h 本地搜索；安装复用其官方命令 `github:<author>/<name>`；
- **GitHub 直装**：规格白名单（仅 github.com git 规格）；安装/全量更新前按官方指引把包名写入 profile `pnpm-workspace.yaml` `allowBuilds`（pnpm 10 映射形态），失败且命中 `Ignored build scripts` 时按精确 key 补放行并重试一次；
- **健康检查 / 一键全量更新**：包完整性四态徽章；`dsh plugin update` 转发 pnpm update，复用进度管线与并发锁。

## 安全边界

- 远程内容（dsh web）与自有页面严格隔离：自有页面才注入 preload，`window.api` 按来源守卫暴露；
- 自有窗口外链一律 `openExternal` 转系统浏览器 + 导航拦截（`applyOwnWindowLinkPolicy`）；
- IPC 三处同步登记（shared → main → preload），renderer 无 Node 能力；
- 凭据只存 `~/.dsh`（dsh 管理），主进程仅读写掩码状态，日志/通知/错误文案不含密钥原文；
- 直装规格白名单 + allowBuilds 仅放行目标插件自身构建；
- 隐私扫描（`scripts/lint-privacy.mjs`）为 CI 门禁。

## 关键决策记录（ADR 摘要）

1. **不动官方 web**：官方 UI 无会话深链、无外部激活接口，一切桌面差异化走外挂窗口与只读数据，保证 6h 跟版零冲突。
2. **会话中心只读**：写操作一律经官方 `dsh plugin` / 官方 RPC 语义，桌面壳绝不改写 `~/.dsh`。
3. **目录 pin 而非实时 npm 搜索**：可复现、可审计；dshfind 在线市场补足长尾发现需求。
4. **原生 JS 渲染层**：自有页面体量小，无框架依赖降低供应链风险与构建复杂度。
