/* ============================================================
   DSH Desktop 官网交互脚本（零依赖）
   职责：
   1. 按 navigator.userAgent 推荐下载平台（Mac arm64/x64、Linux x64/arm64）；
   2. 构建指向 GitHub Releases latest 无版本号副本资产的下载链接；
   3. 填充 GitHub 仓库/Releases 链接与页脚版本徽章（失败静默隐藏）。
   本地预览：直接用浏览器打开 index.html，可用 ?owner=<GitHub 用户名> 覆盖占位 owner。
   ============================================================ */

'use strict';

// 建仓后替换为真实 owner（GitHub 用户名或组织名）
// 提交官网上线前务必修改，否则下载链接与版本徽章无法工作
const OWNER_PLACEHOLDER = 'OWNER_PLACEHOLDER';

const REPO_NAME = 'dsh-desktop';

/* ---------- owner 解析：URL 参数 > 占位常量 ---------- */
const urlParams = new URLSearchParams(window.location.search);
const OWNER = urlParams.get('owner') || OWNER_PLACEHOLDER;
const isPlaceholderOwner = OWNER === OWNER_PLACEHOLDER;

/* ---------- 链接构建 ---------- */
function releaseAssetUrl(fileName) {
  return `https://github.com/${OWNER}/${REPO_NAME}/releases/latest/download/${fileName}`;
}
function repoUrl() {
  return `https://github.com/${OWNER}/${REPO_NAME}`;
}
function releasesUrl() {
  return `${repoUrl()}/releases`;
}

/* ---------- 平台检测 ----------
   说明：浏览器 UA 无法可靠区分 arm64/x64（Apple Silicon Safari UA 仍含
   "Intel Mac OS X" 兼容字样），因此按主流硬件给出推荐位，其余组合以
   小按钮平铺，用户可自行选择。 */
function detectPlatform() {
  const ua = navigator.userAgent;
  const isAndroid = /Android/i.test(ua);
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return { os: 'mac', arch: 'arm64', label: 'macOS · Apple Silicon' };
  }
  if (/Linux|X11|Ubuntu/i.test(ua) && !isAndroid) {
    return { os: 'linux', arch: 'x64', label: 'Linux · x64' };
  }
  return null;
}

/* ---------- 产物目录：与 electron-builder.yml artifactName 对齐 ---------- */
const ASSETS = [
  { id: 'mac-arm64',   os: 'mac',   arch: 'arm64', file: 'dsh-desktop-mac-arm64.dmg',     kind: 'dmg',      label: 'macOS arm64 · dmg' },
  { id: 'mac-x64',     os: 'mac',   arch: 'x64',   file: 'dsh-desktop-mac-x64.dmg',       kind: 'dmg',      label: 'macOS x64 · dmg' },
  { id: 'linux-x64',   os: 'linux', arch: 'x64',   file: 'dsh-desktop-linux-x64.deb',     kind: 'deb',      label: 'Linux x64 · deb' },
  { id: 'linux-x64-ai',os: 'linux', arch: 'x64',   file: 'dsh-desktop-linux-x64.AppImage',kind: 'AppImage', label: 'Linux x64 · AppImage' },
  { id: 'linux-arm64', os: 'linux', arch: 'arm64', file: 'dsh-desktop-linux-arm64.deb',   kind: 'deb',      label: 'Linux arm64 · deb' },
  { id: 'linux-arm64-ai',os:'linux',arch: 'arm64', file: 'dsh-desktop-linux-arm64.AppImage',kind:'AppImage', label: 'Linux arm64 · AppImage' }
];

/* ---------- SVG 图标 ---------- */
const ICONS = {
  apple: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path fill="currentColor" d="M16.7 12.9c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.1-2.8.9-3.5.9-.7 0-1.8-.9-3-.8-1.6 0-3 .9-3.8 2.3-1.6 2.8-.4 6.9 1.2 9.2.8 1.1 1.7 2.3 2.9 2.3 1.2 0 1.6-.7 3-.7 1.4 0 1.8.7 3 .7 1.2 0 2-1.1 2.8-2.2.9-1.3 1.3-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.5ZM14.4 5.6c.6-.8 1-1.8.9-2.9-.9.1-2 .6-2.7 1.4-.6.7-1.1 1.8-.9 2.8 1 .1 2.1-.5 2.7-1.3Z"/></svg>',
  linux: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path fill="currentColor" d="M12 2c-2 4.2-7 4.7-7 10.5a7 7 0 0 0 14 0C19 6.7 14 6.2 12 2Zm0 3.5c1.4 1.7 3.3 2.5 3.8 5H8.2c.5-2.5 2.4-3.3 3.8-5Zm0 14a4.5 4.5 0 0 1-4.4-3.6c.5.5 1.4 1.1 2.4 1.1.7 0 1.2-.9 2-1.2.8.3 1.4 1.2 2.1 1.2 1 0 1.8-.6 2.3-1.1A4.5 4.5 0 0 1 12 19.5Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>',
  package: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8ZM3.3 7 12 12l8.7-5M12 22V12"/></svg>'
};

function osIcon(os) {
  return os === 'mac' ? ICONS.apple : ICONS.linux;
}

/* 将静态 SVG 字符串解析为节点（内容均为本文件内写死的常量，无外部数据） */
function svgEl(svgString) {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  return doc.documentElement;
}

/* ---------- 渲染下载区 ---------- */
function renderDownloads() {
  const primaryBox = document.getElementById('dl-primary');
  const othersBox = document.getElementById('dl-others');
  if (!primaryBox || !othersBox) return;

  const current = detectPlatform();

  // 主按钮：推荐平台（Mac → dmg；Linux → deb）；未知平台 → macOS arm64 + 全量平铺
  const preferred = current
    ? ASSETS.find(a => a.os === current.os && a.arch === current.arch && a.kind !== 'AppImage')
    : null;

  if (preferred) {
    const a = document.createElement('a');
    a.className = 'btn-dl btn-dl-main';
    a.href = releaseAssetUrl(preferred.file);
    a.setAttribute('download', preferred.file);
    a.appendChild(svgEl(osIcon(preferred.os)));
    const label = document.createElement('span');
    label.textContent = `下载 for ${preferred.label}`;
    const kind = document.createElement('span');
    kind.className = 'btn-os';
    kind.textContent = preferred.kind;
    a.append(label, kind);
    primaryBox.appendChild(a);
  } else {
    const a = document.createElement('a');
    a.className = 'btn-dl btn-dl-main';
    a.href = releasesUrl();
    a.target = '_blank';
    a.rel = 'noopener';
    a.appendChild(svgEl(ICONS.package));
    const label = document.createElement('span');
    label.textContent = '前往 Releases 下载';
    a.appendChild(label);
    primaryBox.appendChild(a);
  }

  // 次按钮：非推荐平台的其余组合（去重：同 id 只保留一个）
  const others = ASSETS.filter(a => !(preferred && a.id === preferred.id));
  for (const asset of others) {
    const a = document.createElement('a');
    a.className = 'btn-dl';
    a.href = releaseAssetUrl(asset.file);
    a.setAttribute('download', asset.file);
    a.textContent = asset.label;
    othersBox.appendChild(a);
  }

  // 占位 owner 提示（预览模式）
  if (isPlaceholderOwner) {
    const hint = document.getElementById('dl-hint');
    if (hint) {
      hint.hidden = false;
      hint.textContent = '预览模式：owner 尚未配置，下载链接暂不可用。可追加 URL 参数 ?owner=<GitHub 用户名> 预览真实链接；上线前请替换 app.js 中的 OWNER_PLACEHOLDER。';
    }
  }
}

/* ---------- 填充 GitHub 链接 ---------- */
function renderGitHubLinks() {
  const links = document.querySelectorAll('[data-github-link]');
  for (const el of links) el.href = repoUrl();
  const rel = document.querySelectorAll('[data-github-releases]');
  for (const el of rel) el.href = releasesUrl();
}

/* ---------- 版本徽章：GitHub API，失败静默隐藏 ---------- */
async function renderVersionBadge() {
  const badge = document.getElementById('version-badge');
  if (!badge || isPlaceholderOwner) return;

  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO_NAME}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return;
    const release = await res.json();
    if (!release || !release.tag_name) return;

    document.getElementById('version-tag').textContent = release.tag_name;
    const dateEl = document.getElementById('version-date');
    if (release.published_at) {
      const d = new Date(release.published_at);
      dateEl.textContent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    badge.hidden = false;
  } catch {
    // 网络失败 / API 限流：保持隐藏即可，不打扰访客
  }
}

/* ---------- 入口 ---------- */
renderGitHubLinks();
renderDownloads();
renderVersionBadge();
