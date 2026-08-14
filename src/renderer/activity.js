// Deepseek Token 活动侧栏逻辑：数字卡（TokenSample 推送）+ Canvas 趋势图。
// 纯原生 JS，无框架依赖。管道停用 / 无数据时显示占位，绝不报错弹窗。
;(function () {
  'use strict'

  var els = {
    updateHint: document.getElementById('updateHint'),
    totalTokens: document.getElementById('totalTokens'),
    tokensUncached: document.getElementById('tokensUncached'),
    tokensOutput: document.getElementById('tokensOutput'),
    tokensCacheRead: document.getElementById('tokensCacheRead'),
    tokensCacheWrite: document.getElementById('tokensCacheWrite'),
    pressureValue: document.getElementById('pressureValue'),
    pressureFill: document.getElementById('pressureFill'),
    pressureDetail: document.getElementById('pressureDetail'),
    canvas: document.getElementById('chartCanvas'),
    placeholder: document.getElementById('chartPlaceholder'),
    chartPeak: document.getElementById('chartPeak'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab'))
  }

  var api = window.api
  var currentRange = '1h'
  /** 当前区间样本缓存（OnTokenSample 的 recent / GetSeries 结果） */
  var series = []

  var RANGE_CONFIG = {
    '1h': { ms: 60 * 60 * 1000, bucketMs: 60 * 1000, label: '近 1 小时' },
    today: { ms: 0 /* 动态：今日零点至今 */, bucketMs: 5 * 60 * 1000, label: '今日' },
    '7d': { ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000, label: '近 7 天' }
  }

  function rangeMs(range) {
    if (range === 'today') {
      var now = new Date()
      var start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      return Math.max(60 * 1000, now.getTime() - start.getTime())
    }
    return RANGE_CONFIG[range].ms
  }

  /* ── 数字卡 ── */

  function fmt(n) {
    return Number(n || 0).toLocaleString('zh-CN')
  }

  function renderAggregate(aggregate) {
    if (!aggregate) {
      return
    }
    var t = aggregate.totals
    els.totalTokens.textContent = fmt(
      t.uncachedInput + t.output + t.cacheRead + t.cacheWrite
    )
    els.tokensUncached.textContent = fmt(t.uncachedInput)
    els.tokensOutput.textContent = fmt(t.output)
    els.tokensCacheRead.textContent = fmt(t.cacheRead)
    els.tokensCacheWrite.textContent = fmt(t.cacheWrite)

    var ctx = aggregate.context
    if (ctx && ctx.contextWindow > 0) {
      var pct = Math.min(100, (ctx.pressureTokens / ctx.contextWindow) * 100)
      var level = pct >= 85 ? 'high' : pct >= 60 ? 'warn' : ''
      els.pressureValue.textContent = pct.toFixed(1) + '%'
      els.pressureValue.className = 'pressure__value' + (level ? ' is-' + level : '')
      els.pressureFill.style.width = Math.max(1.5, pct) + '%'
      els.pressureFill.className = 'pressure__fill' + (level ? ' is-' + level : '')
      els.pressureDetail.textContent =
        fmt(ctx.pressureTokens) + ' / ' + fmt(ctx.contextWindow) + ' tokens'
    } else {
      els.pressureValue.textContent = '—'
      els.pressureValue.className = 'pressure__value'
      els.pressureFill.style.width = '0'
      els.pressureFill.className = 'pressure__fill'
      els.pressureDetail.textContent = '暂无上下文数据'
    }

    var updated = aggregate.updatedAt ? new Date(aggregate.updatedAt) : null
    els.updateHint.textContent = updated
      ? '更新于 ' + updated.toLocaleTimeString('zh-CN', { hour12: false })
      : '等待数据…'
  }

  /* ── 趋势图（Canvas，devicePixelRatio 适配） ── */

  function drawChart() {
    var wrap = els.canvas.parentElement
    var cssW = wrap.clientWidth || 1
    var cssH = wrap.clientHeight || 1
    var dpr = window.devicePixelRatio || 1

    if (els.canvas.width !== Math.round(cssW * dpr) || els.canvas.height !== Math.round(cssH * dpr)) {
      els.canvas.width = Math.round(cssW * dpr)
      els.canvas.height = Math.round(cssH * dpr)
    }

    var ctx = els.canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    var points = bucketize(series, currentRange, Date.now())
    var hasData = points.some(function (p) {
      return p.tokens > 0
    })
    els.placeholder.hidden = hasData
    els.chartPeak.textContent = ''
    if (!hasData) {
      return
    }

    var padL = 6
    var padR = 6
    var padT = 10
    var padB = 16
    var w = cssW - padL - padR
    var h = cssH - padT - padB

    var maxTokens = 1
    var peakIdx = 0
    for (var i = 0; i < points.length; i++) {
      if (points[i].tokens > maxTokens) {
        maxTokens = points[i].tokens
        peakIdx = i
      }
    }
    // y 轴留 12% 头部空间
    var yMax = maxTokens * 1.12
    var xFor = function (idx) {
      return padL + (points.length <= 1 ? 0 : (idx / (points.length - 1)) * w)
    }
    var yFor = function (v) {
      return padT + h - (v / yMax) * h
    }

    // 横向网格（三条基线：0 / 半值 / 峰值）
    ctx.strokeStyle = 'rgba(232, 234, 240, 0.06)'
    ctx.lineWidth = 1
    ;[0, 0.5, 1].forEach(function (frac) {
      var y = Math.round(yFor(maxTokens * frac)) + 0.5
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(cssW - padR, y)
      ctx.stroke()
    })

    // 面积 + 折线
    var lineGrad = ctx.createLinearGradient(0, padT, 0, padT + h)
    lineGrad.addColorStop(0, 'rgba(77, 107, 254, 0.85)')
    lineGrad.addColorStop(1, 'rgba(77, 107, 254, 0.35)')
    var areaGrad = ctx.createLinearGradient(0, padT, 0, padT + h)
    areaGrad.addColorStop(0, 'rgba(77, 107, 254, 0.30)')
    areaGrad.addColorStop(1, 'rgba(77, 107, 254, 0.02)')

    ctx.beginPath()
    points.forEach(function (p, idx) {
      var x = xFor(idx)
      var y = yFor(p.tokens)
      if (idx === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = lineGrad
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()

    ctx.lineTo(xFor(points.length - 1), padT + h)
    ctx.lineTo(xFor(0), padT + h)
    ctx.closePath()
    ctx.fillStyle = areaGrad
    ctx.fill()

    // 峰值点高亮
    var px = xFor(peakIdx)
    var py = yFor(points[peakIdx].tokens)
    ctx.beginPath()
    ctx.arc(px, py, 2.6, 0, Math.PI * 2)
    ctx.fillStyle = '#aab6ff'
    ctx.shadowColor = 'rgba(77, 107, 254, 0.8)'
    ctx.shadowBlur = 6
    ctx.fill()
    ctx.shadowBlur = 0

    // 峰值说明（图表下方一行）
    var peakPoint = points[peakIdx]
    var peakTime = new Date(peakPoint.t).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    })
    els.chartPeak.textContent =
      '峰值 ' + fmt(peakPoint.tokens) + ' tokens · ' + peakTime + '（' +
      RANGE_CONFIG[currentRange].label + '，每' + bucketLabel(currentRange) + '一格）'
  }

  /** 样本按绘制粒度重分桶求和 */
  function bucketize(points, range, now) {
    var cfg = RANGE_CONFIG[range]
    var bucketMs = cfg.bucketMs
    var cutoff = now - rangeMs(range)
    var start = Math.floor(cutoff / bucketMs) * bucketMs
    var end = Math.ceil(now / bucketMs) * bucketMs
    var count = Math.max(1, Math.round((end - start) / bucketMs))
    // 上限保护：窗口极端拉长时不逐桶展开
    if (count > 2000) {
      bucketMs = Math.ceil((end - start) / 2000 / bucketMs) * bucketMs
      count = Math.max(1, Math.round((end - start) / bucketMs))
    }
    var buckets = new Array(count)
    for (var i = 0; i < count; i++) buckets[i] = 0
    points.forEach(function (p) {
      if (p.t < cutoff) return
      var idx = Math.floor((p.t - start) / bucketMs)
      if (idx >= 0 && idx < count) buckets[idx] += Math.max(0, p.tokens)
    })
    return buckets.map(function (tokens, idx) {
      return { t: start + idx * bucketMs, tokens: tokens }
    })
  }

  function bucketLabel(range) {
    if (range === '1h') return '分钟'
    if (range === 'today') return '5 分钟'
    return '小时'
  }

  /* ── 数据加载与订阅 ── */

  function loadSeries() {
    if (!api) return
    api
      .getTokenSeries(currentRange)
      .then(function (result) {
        series = (result && result.points) || []
        drawChart()
      })
      .catch(function () {
        series = []
        drawChart()
      })
  }

  function bindEvents() {
    els.tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        els.tabs.forEach(function (t) {
          t.classList.toggle('is-active', t === tab)
        })
        currentRange = tab.dataset.range
        loadSeries()
      })
    })

    // 实时推送：更新数字卡；recent 仅覆盖最近 24h，1h/今日档可直接用，
    // 7 天档需重新拉取完整历史，避免短窗口覆盖长区间
    api.onTokenSample(function (payload) {
      if (!payload) return
      if (payload.active === false) {
        els.updateHint.textContent = '管道停用（数据源不可识别）'
      }
      renderAggregate(payload.aggregate)
      if (Array.isArray(payload.recent) && currentRange !== '7d') {
        series = payload.recent
        drawChart()
      } else {
        loadSeries()
      }
    })

    window.addEventListener('resize', drawChart)
  }

  /* ── 启动 ── */

  if (api) {
    bindEvents()
    loadSeries()
    drawChart()
  } else {
    els.updateHint.textContent = '无法连接主进程（window.api 缺失）'
  }
})()
