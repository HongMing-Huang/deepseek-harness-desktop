'use strict';

const DEFAULT_OWNER = 'HongMing-Huang';
const REPO_NAME = 'deepseek-harness-desktop';
const OWNER = new URLSearchParams(window.location.search).get('owner') || DEFAULT_OWNER;

const ASSETS = [
  { id: 'mac-arm64', os: 'mac', arch: 'arm64', ext: 'dmg', kind: 'dmg', label: 'macOS arm64 · dmg' },
  { id: 'linux-x64', os: 'linux', arch: 'amd64', ext: 'deb', kind: 'deb', label: 'Linux x64 · deb' }
];

function repoUrl() { return `https://github.com/${OWNER}/${REPO_NAME}`; }
function releasesUrl() { return `${repoUrl()}/releases`; }
function assetUrl(fileName) { return `${releasesUrl()}/latest/download/${fileName}`; }
function assetFileName(asset, version) { return `deepseek-harness-desktop-${version}-${asset.os}-${asset.arch}.${asset.ext}`; }

async function fetchLatestRelease() {
  try {
    const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO_NAME}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const release = await response.json();
    return typeof release.tag_name === 'string' ? release : null;
  } catch { return null; }
}

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(ua)) return { id: 'mac-arm64', label: 'macOS · Apple Silicon' };
  if (/Linux|X11|Ubuntu/i.test(ua) && !/Android/i.test(ua)) return { id: 'linux-x64', label: 'Linux · x64' };
  return null;
}

async function renderDownloads() {
  const primaryBox = document.getElementById('dl-primary');
  const othersBox = document.getElementById('dl-others');
  if (!primaryBox || !othersBox) return;
  const release = await fetchLatestRelease();
  const version = release?.tag_name.replace(/^v/, '');
  const current = detectPlatform();
  const ordered = [...ASSETS].sort((a, b) => (a.id === current?.id ? -1 : b.id === current?.id ? 1 : 0));

  for (const [index, asset] of ordered.entries()) {
    const link = document.createElement('a');
    link.className = index === 0 ? 'btn-dl btn-dl-main' : 'btn-dl';
    link.textContent = index === 0 && current ? `下载 for ${asset.label}` : asset.label;
    if (version) {
      const name = assetFileName(asset, version);
      link.href = assetUrl(name);
      link.setAttribute('download', name);
    } else {
      link.href = releasesUrl();
      link.target = '_blank';
      link.rel = 'noopener';
    }
    (index === 0 ? primaryBox : othersBox).appendChild(link);
  }
  const platformLabel = document.getElementById('detected-platform');
  if (platformLabel) platformLabel.textContent = current ? current.label : '选择你的平台';
}

function renderGitHubLinks() {
  document.querySelectorAll('[data-github-link]').forEach(link => { link.href = repoUrl(); });
  document.querySelectorAll('[data-github-releases]').forEach(link => { link.href = releasesUrl(); });
}

function bindOfficialHeroBackground() {
  const fluid = document.getElementById('fluid-field');
  const dots = document.getElementById('dot-field');
  if (!fluid || !dots || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const fluidContext = fluid.getContext('2d');
  const dotContext = dots.getContext('2d');
  if (!fluidContext || !dotContext) return;

  let width = 0;
  let height = 0;
  let lastFrame = 0;
  let particleList = [];
  const mouse = { x: .5, y: .5, smoothX: .5, smoothY: .5, vx: 0, vy: 0, inputVX: 0, inputVY: 0, active: false };

  function resize(canvas, context) {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function reset() {
    width = fluid.clientWidth;
    height = fluid.clientHeight;
    resize(fluid, fluidContext);
    resize(dots, dotContext);
    particleList = [];
    for (let y = height * .22; y < height * .72; y += 9) {
      for (let x = width * .34; x < width * .76; x += 9) {
        if (Math.random() > .33) particleList.push({ restX: x, restY: y, x, y, vx: 0, vy: 0 });
      }
    }
  }

  function drawFluid(time) {
    fluidContext.clearRect(0, 0, width, height);
    const x = mouse.smoothX * width;
    const y = mouse.smoothY * height;
    const velocity = Math.min(1, Math.hypot(mouse.vx, mouse.vy) * 1.8);
    const fields = [
      [width * .05 + Math.sin(time * .00018) * 45, height * .02, 310, 'rgba(255,247,209,.34)'],
      [width * .89 + Math.cos(time * .00016) * 50, height * .10, 350, 'rgba(255,247,209,.29)'],
      [width * .62, height * .64, 390, 'rgba(88,151,218,.28)'],
      [x - mouse.vx * 1.15, y - mouse.vy * 1.15, 210 + velocity * 165, 'rgba(229,245,255,.28)'],
      [x - mouse.vx * 2.8, y - mouse.vy * 2.8, 145 + velocity * 115, 'rgba(185,225,255,.16)'],
      [x - mouse.vx * 5.1, y - mouse.vy * 5.1, 85 + velocity * 75, 'rgba(174,220,255,.06)']
    ];
    for (const [fieldX, fieldY, radius, color] of fields) {
      const gradient = fluidContext.createRadialGradient(fieldX, fieldY, 0, fieldX, fieldY, radius);
      gradient.addColorStop(0, color);
      gradient.addColorStop(.48, 'rgba(190,222,255,.06)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      fluidContext.fillStyle = gradient;
      fluidContext.beginPath();
      fluidContext.ellipse(fieldX, fieldY, radius * 1.48, radius * .36, -.48, 0, Math.PI * 2);
      fluidContext.fill();
    }
  }

  function drawDots() {
    dotContext.clearRect(0, 0, width, height);
    const mouseX = mouse.smoothX * width;
    const mouseY = mouse.smoothY * height;
    for (const particle of particleList) {
      const dx = particle.x - mouseX;
      const dy = particle.y - mouseY;
      const distance = Math.hypot(dx, dy);
      if (mouse.active && distance < 220 && distance > .1) {
        const force = (1 - distance / 220) * (4 + Math.min(9, Math.hypot(mouse.vx, mouse.vy) * .22));
        particle.vx += (dx / distance) * force;
        particle.vy += (dy / distance) * force;
      }
      particle.vx += (particle.restX - particle.x) * .05;
      particle.vy += (particle.restY - particle.y) * .05;
      particle.vx *= .85;
      particle.vy *= .85;
      particle.x += particle.vx;
      particle.y += particle.vy;
      const speed = Math.abs(particle.vx) + Math.abs(particle.vy);
      dotContext.fillStyle = `rgba(226,241,255,${.17 + Math.min(speed, 1) * .56})`;
      const size = 1.3 + Math.min(speed, 1) * 2;
      dotContext.fillRect(particle.x - size / 2, particle.y - size / 2, size, size);
    }
  }

  function frame(time) {
    requestAnimationFrame(frame);
    if (time - lastFrame < 1000 / 30) return;
    lastFrame = time;
    mouse.smoothX += (mouse.x - mouse.smoothX) * .1;
    mouse.smoothY += (mouse.y - mouse.smoothY) * .1;
    mouse.vx += (mouse.inputVX - mouse.vx) * .18;
    mouse.vy += (mouse.inputVY - mouse.vy) * .18;
    mouse.inputVX *= .83;
    mouse.inputVY *= .83;
    drawFluid(time);
    drawDots();
  }

  window.addEventListener('pointermove', event => {
    const rect = fluid.getBoundingClientRect();
    const nextX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const nextY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    mouse.inputVX = (nextX - mouse.x) * width;
    mouse.inputVY = (nextY - mouse.y) * height;
    mouse.x = nextX;
    mouse.y = nextY;
    mouse.active = event.clientY >= rect.top && event.clientY <= rect.bottom;
  }, { passive: true });
  window.addEventListener('pointerleave', () => { mouse.active = false; });
  window.addEventListener('resize', reset, { passive: true });
  reset();
  requestAnimationFrame(frame);
}

renderGitHubLinks();
bindOfficialHeroBackground();
void renderDownloads();
