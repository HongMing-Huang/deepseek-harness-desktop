# 参与贡献（Contributing）

感谢你考虑为 Deepseek（`deepseek-harness-desktop`）贡献代码。本文档说明本地开发、验证门禁与提交规范。

## 开发环境

- Node >= 22.19.0、npm（内嵌运行时由脚本自动准备，无需预装 dsh/pnpm）
- macOS / Linux（`prepare-runtime` 当前为 POSIX-only；Windows 支持见 README 路线图）

```bash
npm install                 # 安装开发依赖
npm run prepare:runtime     # 下载内嵌 node/pnpm 并安装官方 dsh（幂等，含来源校验）
npm run dev                 # electron-vite 开发模式
npm run typecheck           # main/preload/renderer 双 tsconfig 检查
npm run test                # node:test 单测
npm run build               # 构建 out/
node tests/e2e/run-e2e.mjs  # E2E（需先 build；自动隔离 DSH_HOME/HOME）
node scripts/lint-privacy.mjs # 隐私扫描（CI 门禁）
```

## 代码规范

- **语言**：注释与文档使用中文，只写开发内容；禁止个人信息（用户名、私有绝对路径、邮箱、主机名等），隐私扫描会拦截。
- **类型**：所有新增 IPC 通道与载荷必须先登记在 `src/shared/ipc.ts`，再在 `src/main/ipc.ts` 注册 handler，最后在 `src/preload/index.ts` 白名单暴露——三个文件必须同步修改，缺一不可。
- **安全**：renderer 只能经 `window.api` 白名单访问能力；不得透传 `ipcRenderer` 或 Node 能力；dsh web 视图保持无 preload、沙箱隔离，禁止向官方 web 注入任何脚本。
- **测试**：纯函数必须配套单测（现有：pnpm 进度解析、通知去重、zstd 帧扫描、安装规格白名单、allowBuilds、dshfind 解析）；行为变更尽量补 E2E 断言（`tests/e2e/run-e2e.mjs`）。
- **官方数据红线**：对 `~/.dsh` 的一切访问必须只读（会话中心）；需要写操作的插件安装/更新必须走官方 `dsh plugin` 命令，绝不直接改写官方存储。

## 提交规范

提交信息采用与仓库历史一致的格式：

```
<type>(<scope>): <一句话中文摘要>

<可选正文：动机 / 行为变化 / 验证方式>
```

`type`：`feat` 新功能 / `fix` 修复 / `chore` 维护（依赖、目录 pin 刷新）/ `docs` 文档 / `test` 测试 / `refactor` 重构。一个提交只做一件事；行为变化在正文写明验证方式（单测 / E2E / 真机）。

## PR 流程

1. 从 `main` 开分支；完成改动后本地过全部门禁：`npm run typecheck && npm run test && npm run build && node scripts/lint-privacy.mjs`，涉及运行时行为再跑 E2E；
2. PR 描述说明动机、行为变化与验证证据；CI（`ci.yml`）会自动重跑 typecheck / test / build / 隐私扫描；
3. **版本纪律**：应用壳 `version` 与 `DSH_VERSION` 只能经「版本 PR」与 `upstream-sync` 机器人 PR 更新，普通 PR 不要改动 `src/shared/versions.ts` 或 `package.json` 的 version；
4. 至少一名维护者 review 后合并；Release 只认 `vX.Y.Z` tag（见 README「CI/CD 与发布流程」）。

## 行为准则

对事不对人；讨论聚焦代码与设计；尊重官方上游（deepseek-ai/deepseek-harness）的许可与商标边界。
