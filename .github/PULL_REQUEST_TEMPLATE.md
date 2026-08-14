## 动机

<!-- 这个 PR 解决什么问题 / 带来什么能力？ -->

## 行为变化

<!-- 用户可见的变化；无则写「无」 -->

## 验证方式

<!-- 单测 / E2E / 真机验证的结果；附命令或截图 -->

## 检查清单

- [ ] 代码注释与文档只写开发内容，无个人信息（`node scripts/lint-privacy.mjs` 通过）
- [ ] 新增 IPC 已在 `src/shared/ipc.ts` → `src/main/ipc.ts` → `src/preload/index.ts` 三处同步登记
- [ ] 纯函数/新逻辑配套单测（`npm run test` 通过）
- [ ] `npm run typecheck` 与 `npm run build` 通过
- [ ] 涉及运行时/窗口行为时 E2E 通过（`node tests/e2e/run-e2e.mjs`）
- [ ] 未改动 `src/shared/versions.ts` 与 `package.json` 的 version（版本纪律）
- [ ] 对 `~/.dsh` 的访问保持只读（会话中心）/ 写操作走官方 `dsh plugin` 命令
