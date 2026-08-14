# Changelog

双轨版本说明：应用壳（dsh-desktop 本体）与内嵌 dsh 运行时各自独立演进，下方分两个小节记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 应用壳（dsh-desktop）

### [0.1.0] - 2026-08-14

#### 新增

- 初始骨架：Electron 三层结构（main / preload / renderer）、IPC 集中登记、splash 启动页。
- `ProcessSupervisor`：dsh web 子进程托管（空闲端口探测、HTTP 探活、优雅停止、pid 文件）。
- `prepare-runtime` 脚本：内嵌 Node / pnpm / dsh 运行时准备（幂等、重试、进度）。
- 主进程文件日志（`userData/logs/main.log`，超限自动截断）。
- preload 来源守卫：仅应用自有页面可获得 `window.api`。
- 运行时单架构瘦身（`--platform` / `--arch` / `--prune-others`），Linux 打包支持（deb + AppImage）。
- 应用图标与 splash 品牌区鲸鱼 logo。

#### 修复

- 二次激活（dock 重建窗口）时对已就绪进程重复注册一次性监听导致 splash 卡死的问题。

## dsh 运行时（@deepseek-ai/dsh）

### [0.1.0-rc.6]

- 当前钉死的内嵌版本；由 `npm run prepare:runtime` 安装于 `resources/runtime/dsh/`。
- 版本清单见 `resources/runtime/dsh/version.json`（含 dsh / pnpm / node 主版本）。
