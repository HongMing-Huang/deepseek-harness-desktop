# 安全策略（Security）

## 报告漏洞

请通过 GitHub 私有安全通告（Security → Report a vulnerability）或仓库维护者渠道报告，不要在公开 Issue 中披露。我们将在 48 小时内确认、按影响定级修复并发布安全公告。

## 威胁模型与对策

| 威胁 | 对策 |
| --- | --- |
| dsh web 内容（含社区插件注入的页面代码）访问主进程能力 | dshWebView 无 preload、`sandbox: true`、`contextIsolation: true`；`window.api` 仅按来源（file:/dev server）暴露，远程内容不可见 |
| 恶意页面开窗/跳转劫持 | 主窗口与 dshWebView 共用外链守卫（仅放行本机 dsh web 端口，其余 openExternal） |
| IPC 载荷伪造 / 越权调用 | IPC 通道集中登记；renderer 无 `ipcRenderer`/Node 透传；所有 handler 参数在主进程校验 |
| 凭据泄露 | API Key 仅存 `~/.dsh/.credentials.yaml`（0600，dsh 管理）；主进程只返回掩码；日志、通知、错误文案与导出内容均不含密钥明文 |
| 插件供应链投毒 | 目录条目全部经 npm registry（存在性 + repository 指向）或 GitHub 仓库验证并 pin；直装规格白名单（仅 github.com git 规格）；`prepare-runtime` 对官方 dsh 做包名/版本/repository/维护者归属四重校验 |
| 恶意插件构建脚本 | pnpm 默认拦截全部构建脚本；仅对目录内 github 直装条目按官方指引写入 `allowBuilds` 放行，其余一律保持拦截 |
| 官方数据被改写 | 会话与配置由官方 Web / dsh 管理；插件安装走官方 `dsh plugin` 命令，桌面壳仅登记市场扩展所需 Cordis patch 与只读运行时包链接 |
| 隐私泄露入仓库 | `scripts/lint-privacy.mjs` 扫描全部文本文件（CI 门禁）：用户名、私有绝对路径、邮箱、主机名等一律拦截 |
| 本地 HTTP 接口被远端页面滥用 | 官方 browser-trust 防线负责（Host 回环校验 + Origin 同源校验）；桌面壳不扩大端口暴露面 |

## 构建与分发

- macOS 产物采用 ad-hoc 签名（`identity: '-'`，免费、无需开发者账号），避免 Gatekeeper 以「已损坏」直接拦截并移入废纸篓；正式签名与公证为后续任务；
- Release 只保留 6 个安装包 + 合并 SHA256 清单（SHASUMS256.txt）+ 更新元数据（latest.yml），无冗余副本；官网安装引导包含校验步骤；
- 内嵌运行时仅来自 npm 官方源，绝不含本地拷贝或私有源构建。

## 依赖策略

- 运行依赖最小化：`semver`、`yaml`；开发依赖含 electron / electron-builder / playwright-core / tsx；
- 渲染层零框架、零外部 CDN 资源（字体为系统字体回退；官网字体经 Google Fonts 仅为展示页面）。
