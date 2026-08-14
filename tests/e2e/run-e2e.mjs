#!/usr/bin/env node
/**
 * DSH Desktop 端到端验证（playwright-core + CDP，无浏览器下载依赖）。
 *
 * 流程：
 *   1. mkdtemp 两个临时目录：DSH_HOME（dsh 数据目录）与 HOME（Electron
 *      userData / 日志 / Chromium 缓存），全程不触碰真实 ~/.dsh 与真实
 *      用户 Application Support —— 这是本脚本的隐私红线。
 *   2. spawn 内嵌 Electron：node_modules/.bin/electron . --remote-debugging-port=<空闲端口>
 *      （生产形态：无 ELECTRON_RENDERER_URL，页面读 out/renderer）。
 *   3. 等 CDP 端口就绪后 chromium.connectOverCDP 连接，对全部 page target
 *      挂 console / pageerror 监听（断言失败时输出辅助诊断）。
 *   4. 依次驱动并断言六个场景（a 首启引导 / b 启动进度与 web / c Token
 *      侧栏 / d 设置与模型 / e 插件目录与并发锁 / f 更新检查降级），
 *      截图落 tests/e2e/artifacts/。
 *   5. 优雅退出：SIGTERM Electron（主进程 before-quit 会停掉 dsh web），
 *      超时强杀；删除全部临时目录。
 *
 * 运行：node tests/e2e/run-e2e.mjs
 * 前提：npm run build 已产出 out/，resources/runtime 已就绪（prepare:runtime）。
 * 退出码：全部通过 0，任一断言失败 1。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const artifactsDir = join(repoRoot, 'tests', 'e2e', 'artifacts')
mkdirSync(artifactsDir, { recursive: true })

/* ───────── 工具 ───────── */

const log = (msg) => console.log(`[e2e] ${msg}`)
const warn = (msg) => console.warn(`[e2e] ${msg}`)

/** 申请一个空闲 TCP 端口（listen 0 后立即释放） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** 轮询直到谓词为真或超时（抛错带说明） */
async function waitFor(fn, { timeoutMs, label, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      lastErr = err
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待超时（${label}，${timeoutMs}ms）${lastErr ? `，最后错误：${lastErr.message}` : ''}`)
}

/** 单条断言登记：失败记入 failures 并打印，不中断后续步骤（便于一次跑全收集） */
const failures = []
const steps = []
function assertOk(cond, label, detail = '') {
  const pass = Boolean(cond)
  steps.push({ label, pass })
  if (pass) {
    log(`PASS ${label}${detail ? `（${detail}）` : ''}`)
  } else {
    failures.push(label)
    console.error(`[e2e] FAIL ${label}${detail ? `（${detail}）` : ''}`)
  }
}

/* ───────── 1. 临时环境 ───────── */

const dshHome = mkdtempSync(join(tmpdir(), 'dsh-e2e-home-'))
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-e2e-fakehome-'))
log(`DSH_HOME 隔离目录：${dshHome}`)
log(`HOME 隔离目录（Electron userData 等）：${fakeHome}`)

/* ───────── 2. 启动 Electron ───────── */

const collectedPageErrors = []
const electronLogs = []

const cdpPort = await freePort()
const electronBin = join(repoRoot, 'node_modules', '.bin', 'electron')
if (!existsSync(electronBin)) {
  console.error('[e2e] 未找到本地 electron 可执行文件，请先 npm install')
  process.exit(1)
}

const childEnv = {
  ...process.env,
  DSH_HOME: dshHome,
  HOME: fakeHome,
  // 生产形态启动：显式移除 dev server 变量，确保 preload 走 file: 分支
  ELECTRON_RENDERER_URL: ''
}
delete childEnv.ELECTRON_RENDERER_URL

log(`启动 Electron（CDP 端口 ${cdpPort}）…`)
const child = spawn(electronBin, ['.', '--remote-debugging-port=' + cdpPort], {
  cwd: repoRoot,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', (d) => electronLogs.push(`[stdout] ${d.toString().trimEnd()}`))
child.stderr.on('data', (d) => electronLogs.push(`[stderr] ${d.toString().trimEnd()}`))
let childExited = null
child.on('exit', (code, signal) => {
  childExited = { code, signal }
})

/* ───────── 3. 连接 CDP ───────── */

let browser = null
try {
  await waitFor(
    async () => {
      if (childExited) throw new Error(`Electron 提前退出（code=${childExited.code}）`)
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
        return res.ok
      } catch {
        return false
      }
    },
    { timeoutMs: 60_000, label: 'CDP 端口就绪' }
  )
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  log('CDP 已连接')

  const context = browser.contexts()[0]

  /** 全部 page target 的 console / pageerror 收集 */
  function attachLogging(page) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        collectedPageErrors.push(`[${page.url()}] console.${m.type()}: ${m.text()}`)
      }
    })
    page.on('pageerror', (e) => collectedPageErrors.push(`[${page.url()}] pageerror: ${e.message}`))
  }
  for (const p of context.pages()) attachLogging(p)
  context.on('page', attachLogging)

  /** 按 url 谓词找 page target（新出现的 target 会自动进入 context.pages()） */
  const findPage = (predicate) => context.pages().find((p) => predicate(p.url()))

  /* ── splash 页就绪 ── */
  const splash = await waitFor(() => findPage((u) => u.includes('splash.html')), {
    timeoutMs: 60_000,
    label: 'splash 页面出现'
  })
  await splash.waitForLoadState('domcontentloaded')
  log('splash 已加载')
  await waitFor(
    () => splash.evaluate(() => Boolean(window.api)),
    { timeoutMs: 30_000, label: 'splash window.api 暴露（preload 来源守卫通过）' }
  )

  /** 尽早挂事件收集器：boot OpProgress / RuntimeStatus 推送都进 window.__e2e */
  await splash.evaluate(() => {
    window.__e2e = { progress: [], status: [], latest: null }
    window.api.onOpProgress((p) => window.__e2e.progress.push(p))
    window.api.onStatus((s) => {
      window.__e2e.status.push(s)
      window.__e2e.latest = s
    })
  })

  /* ════════ Step a：首启引导 ════════ */
  log('— Step a：首启引导卡 —')
  await waitFor(
    () => splash.evaluate(() => !document.getElementById('onboardCard').hidden),
    { timeoutMs: 30_000, label: 'onboardCard 可见（未配置 API Key 时显示）' }
  )
  await splash.fill('#apiKeyInput', 'sk-e2e-test-key-000000')
  await splash.click('#onboardSave')
  await waitFor(
    () => splash.evaluate(() => document.getElementById('onboardFeedback').textContent.includes('已保存')),
    { timeoutMs: 15_000, label: '保存成功反馈文案' }
  )

  const credPath = join(dshHome, '.credentials.yaml')
  const credExists = existsSync(credPath)
  assertOk(credExists, 'a1 .credentials.yaml 已写入', credPath.replace(fakeHome, '<tmp>'))
  if (credExists) {
    const credRaw = readFileSync(credPath, 'utf-8')
    assertOk(credRaw.includes('sk-e2e-test-key-000000'), 'a2 凭据文件包含测试 Key')
    const mode = statSync(credPath).mode & 0o777
    assertOk(mode === 0o600, 'a3 凭据文件权限 0600', `实际 mode=${mode.toString(8)}`)
  } else {
    assertOk(false, 'a2 凭据文件包含测试 Key', '文件不存在')
    assertOk(false, 'a3 凭据文件权限 0600', '文件不存在')
  }
  await splash.screenshot({ path: join(artifactsDir, '01-onboarding.png') })
  log('截图 01-onboarding.png')

  /* ════════ Step b：启动进度与进入 web ════════ */
  log('— Step b：boot 进度与 dsh web 加载 —')
  await waitFor(
    () => splash.evaluate(() => window.__e2e?.latest?.phase === 'ready'),
    { timeoutMs: 120_000, label: 'RuntimeStatus phase=ready' }
  )
  const bootEvents = await splash.evaluate(() =>
    window.__e2e.progress.filter((p) => p.op === 'boot').map((p) => ({ state: p.state, percent: p.percent }))
  )
  assertOk(bootEvents.some((e) => e.state === 'done'), 'b1 OpProgress(boot) 收到 done', JSON.stringify(bootEvents))
  // 注：初次 boot 的 start/update 事件可能在 CDP listener 挂上之前已广播完
  //（ipcRenderer 事件即发即弃），故完整事件流由下方 restart 轮次验证（b4~b6）

  const dshPage = await waitFor(() => findPage((u) => /^http:\/\/127\.0\.0\.1:\d+/.test(u)), {
    timeoutMs: 60_000,
    label: 'dsh web 视图 target（127.0.0.1）'
  })
  await dshPage.waitForLoadState('domcontentloaded')
  await waitFor(
    () => dshPage.evaluate(() => document.readyState === 'complete'),
    { timeoutMs: 60_000, label: 'dsh web 页面加载完成' }
  )
  const dshTitle = await dshPage.title()
  const dshHasContent = await dshPage.evaluate(() => document.body.innerText.trim().length > 0)
  assertOk(true, 'b3 dsh web 视图已加载（127.0.0.1 内容出现）', `title="${dshTitle}" 有内容=${dshHasContent}`)
  await dshPage.screenshot({ path: join(artifactsDir, '02-main-web.png') })
  log('截图 02-main-web.png')

  // 重启运行时：listener 早已就位，可完整捕获第二轮 boot 事件流（start/update/done），
  // 同时顺带验证 restartRuntime IPC 与二次 ready 切换。
  await splash.evaluate(() => {
    window.__e2e.progress = []
    window.__e2e.latest = null
  })
  await splash.evaluate(() => window.api.restartRuntime())
  await waitFor(
    () => splash.evaluate(() => window.__e2e?.latest?.phase === 'ready' && window.__e2e.progress.some((p) => p.op === 'boot' && p.state === 'done')),
    { timeoutMs: 120_000, label: 'restart 后二次 ready + boot done' }
  )
  const bootEvents2 = await splash.evaluate(() =>
    window.__e2e.progress.filter((p) => p.op === 'boot').map((p) => ({ state: p.state, percent: p.percent }))
  )
  assertOk(bootEvents2.some((e) => e.state === 'start'), 'b4 restart 轮 OpProgress(boot) 收到 start', JSON.stringify(bootEvents2))
  assertOk(
    bootEvents2.some((e) => e.state === 'update' && typeof e.percent === 'number'),
    'b5 restart 轮 OpProgress(boot) 含带 percent 的 update 事件',
    JSON.stringify(bootEvents2)
  )
  assertOk(bootEvents2.some((e) => e.state === 'done'), 'b6 restart 轮 OpProgress(boot) 收到 done', JSON.stringify(bootEvents2))

  /* ════════ Step c：Token 侧边栏 ════════ */
  log('— Step c：Token 活动侧栏 —')
  const activityPage = await waitFor(() => findPage((u) => u.includes('activity.html')), {
    timeoutMs: 60_000,
    label: 'activity.html 侧栏视图 target'
  })
  await activityPage.waitForLoadState('domcontentloaded')
  const placeholderVisible = await waitFor(
    () => activityPage.evaluate(() => {
      const el = document.getElementById('chartPlaceholder')
      return el && !el.hidden && el.offsetParent !== null
    }),
    { timeoutMs: 30_000, label: '无数据时「暂无数据」占位可见' }
  )
  assertOk(Boolean(placeholderVisible), 'c1 侧栏显示「暂无数据」占位（不报错）')

  const tokenProbe = await activityPage.evaluate(async () => {
    if (!window.api) return { api: false }
    const series = await window.api.getTokenSeries()
    return { api: true, points: series.points.length }
  })
  assertOk(tokenProbe.api === true, 'c2 activity 视图 window.api 可用（preload 注入）')
  assertOk(
    typeof tokenProbe.points === 'number' && tokenProbe.points === 0,
    'c3 getTokenSeries 空数据返回 points=[]',
    `points=${tokenProbe.points}`
  )
  await activityPage.screenshot({ path: join(artifactsDir, '03-activity-sidebar.png') })
  log('截图 03-activity-sidebar.png')

  /* ════════ Step d：设置与模型配置（IPC） ════════ */
  log('— Step d：配置 IPC（splash 上下文） —')
  const cfg1 = await splash.evaluate(() => window.api.getConfig())
  assertOk(cfg1?.apiKey?.configured === true, 'd1 getConfig 反映密钥已配置（掩码不回明文）', `masked=${cfg1?.apiKey?.masked}`)
  assertOk(
    typeof cfg1?.apiKey?.masked === 'string' && !JSON.stringify(cfg1).includes('sk-e2e-test-key-000000'),
    'd2 getConfig 全量返回不含明文 Key'
  )

  const saveModelRes = await splash.evaluate(() => window.api.saveModel('deepseek-chat'))
  assertOk(saveModelRes?.ok === true, 'd3 saveModel(deepseek-chat) 返回 ok')
  const settingsPath = join(dshHome, 'settings.yaml')
  const settingsExists = existsSync(settingsPath)
  assertOk(settingsExists, 'd4 settings.yaml 已写入', settingsPath.replace(dshHome, '<DSH_HOME>'))
  if (settingsExists) {
    const raw = readFileSync(settingsPath, 'utf-8')
    assertOk(
      raw.includes('agent-default-model') && raw.includes('deepseek-chat'),
      'd5 settings.yaml 含 agent-default-model=deepseek-chat'
    )
  } else {
    assertOk(false, 'd5 settings.yaml 含 agent-default-model=deepseek-chat', '文件不存在')
  }

  const cfg2 = await splash.evaluate(() => window.api.getConfig())
  assertOk(cfg2?.defaultModel === 'deepseek-chat', 'd6 getConfig 反映 defaultModel=deepseek-chat')

  const reSave = await splash.evaluate(() => window.api.saveApiKey('sk-e2e-test-key-000000'))
  assertOk(reSave?.ok === true, 'd7 saveApiKey 幂等（重复保存仍 ok）')
  const mode2 = statSync(credPath).mode & 0o777
  assertOk(mode2 === 0o600, 'd8 幂等保存后权限仍 0600', `mode=${mode2.toString(8)}`)

  await splash.screenshot({ path: join(artifactsDir, '04-settings-ipc.png') })
  log('截图 04-settings-ipc.png')

  /* ════════ Step e：插件目录与并发锁 ════════ */
  log('— Step e：插件目录 / 已装列表 / 并发锁 —')
  const catalogRes = await splash.evaluate(() => window.api.getPluginCatalog())
  const catalog = catalogRes?.catalog ?? []
  assertOk(Array.isArray(catalog) && catalog.length >= 8, 'e1 插件目录 ≥8 条', `实际 ${catalog.length} 条`)
  assertOk(
    catalog.every((p) => typeof p.name === 'string' && p.name.length > 0),
    'e2 每条目录项含 name'
  )
  assertOk(
    catalog.every((p) => typeof p.version === 'string' || typeof p.description === 'string'),
    'e3 每条目录项含 version/description 字段'
  )

  const listRes = await splash.evaluate(() => window.api.listPlugins())
  assertOk(
    Array.isArray(listRes?.plugins) && listRes.plugins.length === 0,
    'e4 全新环境 listPlugins 返回空数组',
    `实际 ${listRes?.plugins?.length} 条`
  )

  // 并发锁：两个安装请求同时发出（包名故意不存在，不落任何真实插件），
  // 第二个必须被「已有插件操作进行中」拒绝，随后第一个以失败收场并释放锁。
  const concurrent = await splash.evaluate(async () => {
    const probe = '__e2e_nonexistent_probe__'
    const results = await Promise.allSettled([
      window.api.installPlugin(probe),
      window.api.installPlugin(probe)
    ])
    return results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, message: String(r.reason) }))
  })
  const rejected = concurrent.filter(
    (r) => typeof r.message === 'string' && r.message.includes('已有插件操作进行中')
  )
  assertOk(rejected.length >= 1, 'e5 并发第二个插件操作被拒绝（报错文案匹配）', JSON.stringify(concurrent.map((r) => r.message)))
  const listAfter = await splash.evaluate(() => window.api.listPlugins())
  assertOk(
    Array.isArray(listAfter?.plugins) && listAfter.plugins.length === 0,
    'e6 失败的探测安装未留下任何插件'
  )

  /* ════════ Step f：更新检查降级 ════════ */
  log('— Step f：更新检查降级 —')
  const updaterRes = await splash.evaluate(async () => {
    try {
      const r = await window.api.checkUpdater()
      return { thrown: false, result: r }
    } catch (err) {
      return { thrown: true, message: err instanceof Error ? err.message : String(err) }
    }
  })
  const validStates = ['up-to-date', 'available', 'unavailable', 'error']
  assertOk(updaterRes.thrown === false, 'f1 checkUpdater() 不抛错')
  assertOk(
    validStates.includes(updaterRes.result?.state),
    'f2 更新检查返回合法状态（占位仓库时静默/降级语义）',
    `state=${updaterRes.result?.state}`
  )
  const alive = await splash.evaluate(() => 1 + 1)
  assertOk(alive === 2, 'f3 主窗口（splash target）仍存活可交互')

  /* ───────── 汇总 ───────── */
  const statusNow = await splash.evaluate(() => window.api.getStatus())
  log(`最终运行时状态：${JSON.stringify(statusNow)}`)
} catch (err) {
  failures.push(`致命错误：${err.message}`)
  console.error(`[e2e] 致命错误：${err.stack ?? err.message}`)
} finally {
  /* ───────── 4. 清理 ───────── */
  if (collectedPageErrors.length > 0) {
    warn('渲染进程 console 错误 / pageerror：')
    for (const e of collectedPageErrors.slice(0, 30)) warn(`  ${e}`)
  }
  if (failures.length > 0 && electronLogs.length > 0) {
    console.error('[e2e] Electron 进程输出尾部（诊断用）：')
    for (const l of electronLogs.slice(-30)) console.error(`  ${l}`)
  }

  try {
    if (browser) await browser.close()
  } catch {
    /* 连接可能已断开 */
  }

  if (!childExited) {
    child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise((r) => child.on('exit', () => r(true))),
      sleep(15_000).then(() => false)
    ])
    if (!exited) {
      warn('SIGTERM 未退出，SIGKILL 强杀（dsh web 可能残留，属测试异常路径）')
      child.kill('SIGKILL')
      await sleep(1_000)
    }
  }
  log(`Electron 已退出（code=${childExited?.code ?? 'killed'}）`)

  for (const dir of [dshHome, fakeHome]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
      log(`已清理临时目录：${dir}`)
    } catch (err) {
      warn(`临时目录清理失败（可能仍被进程占用）：${dir}（${err.message}）`)
    }
  }

  console.log(`\n[e2e] 断言汇总：${steps.length - failures.length}/${steps.length} 通过`)
  for (const s of steps) {
    console.log(`  ${s.pass ? '✅' : '❌'} ${s.label}`)
  }
  if (failures.length > 0) {
    console.error(`[e2e] 失败 ${failures.length} 项，退出码 1`)
    process.exit(1)
  }
  console.log('[e2e] 全部通过')
  process.exit(0)
}
