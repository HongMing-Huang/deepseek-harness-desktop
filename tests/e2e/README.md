# Deepseek E2E 验证

基于 **playwright-core + CDP** 的端到端驱动测试：真实启动 Electron 应用（生产形态，
页面读 `out/renderer`），通过 Chrome DevTools 协议连接后驱动七个场景并断言。

## 运行方式

```bash
# 前提：依赖已安装（含 devDependency playwright-core），
# 且已构建产物与运行时：
npm run build
npm run prepare:runtime   # 若 resources/runtime 缺失

# 执行 E2E（自动完成环境隔离、启动、断言、截图与清理）
node tests/e2e/run-e2e.mjs
```

退出码：全部断言通过 `0`，任一失败 `1`（失败时附带渲染层 console 错误与
Electron 进程输出尾部）。

## 数据隔离（隐私红线）

脚本启动 Electron 前会 `mkdtemp` 两个临时目录并注入环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `DSH_HOME` | dsh 数据目录（`.credentials.yaml` / `settings.yaml` / 插件 profile），主进程 `paths.ts` 优先读取该变量 |
| `HOME` | 重定向 Chromium 缓存等（注意：Electron 在 macOS 上忽略 HOME，见下） |
| `DSH_USER_DATA` | 显式覆盖 Electron `userData`（偏好 / 日志 / 单实例锁）。macOS 上 `app.getPath('home')` 恒为真实用户目录，必须经该变量隔离 |

**全程不读写真实 `~/.dsh`**；脚本结束时递归删除两个临时目录。
截图等证据落在 `tests/e2e/artifacts/`（已 gitignore，仅本地保留）。

## 覆盖场景

| 步骤 | 断言要点 | 截图 |
| --- | --- | --- |
| a 首启引导 | 全新 `DSH_HOME` 出现欢迎卡；保存 API Key 后 `.credentials.yaml` 存在、含该键、mode=0600 | `01-onboarding.png` |
| b 启动进度与进入 web | OpProgress(boot) 事件流（done；start/update/done 由 restart 轮完整验证）；dsh web 视图加载 127.0.0.1 内容 | `02-main-web.png` |
| c 凭据与模型 IPC | `getConfig` 掩码不回明文；`saveModel` 写入 `settings.yaml` 的 `agent-default-model`；`saveApiKey` 幂等且权限保持 0600 | `03-settings-ipc.png` |
| d 插件安装并发锁 | 全新环境 `listPlugins` 为空；非法直装规格被拒绝；并发第二个操作被「已有插件操作进行中」拒绝（探测包名不存在，不落任何真实插件） | 无 |
| e 更新检查降级 | `checkUpdater()` 不抛错、返回合法状态（占位仓库静默跳过）；主窗口仍存活 | 无 |
| f 官方页面内插件市场 | 运行时含市场 client bundle；官方启动图登记 bundle；「设置 → 插件 → 插件市场」可打开、加载可安装条目，且无市场客户端错误 | `04-plugin-market.png` |
| g 官方 Web 全屏 | 未加载自定义工具栏或独立业务窗口 | 无 |

注：原生应用菜单无法用 CDP 点击，交互通过页面内 `window.api`
（preload 白名单）evaluate 验证 IPC 畅通性。

## 已知时序说明

初次 boot 的 `start/update` 进度事件可能在 CDP listener 挂载前已广播完
（ipcRenderer 事件即发即弃）。脚本因此通过 `restartRuntime()` 触发第二轮
boot，此时 listener 早已就位，可完整断言 `start → update(18/36/60/82) → done`
事件流，同时顺带覆盖 restart IPC 与二次 ready 切换。
