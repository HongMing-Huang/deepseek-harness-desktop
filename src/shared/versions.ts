/**
 * 内嵌运行时版本集中钉死：scripts/prepare-runtime.ts 与主进程共用。
 * 升级运行时只改这里，避免版本号散落多处。
 */

/** 内嵌 dsh（DeepSeek Harness）版本 */
export const DSH_VERSION = '0.1.1-rc.2'
/** 内嵌 pnpm 版本 */
export const PNPM_VERSION = '10.30.2'
/** 内嵌 Node 主版本（取该主版本下最新 LTS 小版本） */
export const NODE_MAJOR = 'v24'
/** dsh 的 npm 包名 */
export const DSH_PACKAGE = '@deepseek-ai/dsh'
/** npm registry（pnpm tgz 瘦身下载源） */
export const NPM_REGISTRY = 'https://registry.npmjs.org'
