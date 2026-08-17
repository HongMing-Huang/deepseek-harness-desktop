window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-desktop-market',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { IconSearchOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ns = 'settings.desktopMarket'
    const inject = ['slots', 'locale']
    const cssId = '@deepseek-ai/dsh-desktop-market/market.css'
    const css = `.dsm_section{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}.dsm_hint,.dsm_status{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.dsm_search{position:relative;display:flex;align-items:center;color:var(--dsw-alias-label-tertiary)}.dsm_search>svg{position:absolute;left:12px;pointer-events:none}.dsm_search input{box-sizing:border-box;width:100%;height:36px;padding:0 12px 0 36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dsm_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}.dsm_list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}.dsm_card{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-3)}.dsm_name{overflow:hidden;margin:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}.dsm_description{display:-webkit-box;overflow:hidden;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;-webkit-box-orient:vertical;-webkit-line-clamp:2}.dsm_footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsm_version{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.dsm_install{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}.dsm_install:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsm_install:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.dsm_install:disabled{cursor:default;opacity:.55}@media (width<=680px){.dsm_list{grid-template-columns:minmax(0,1fr)}}`
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${cssId}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@deepseek-ai/dsh-desktop-market'
      tag.dataset.pluginCss = cssId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    const dictionary = {
      zh: { tab: '插件市场', search: '搜索插件市场', hint: '浏览并安装来自 dshfind 的插件。', loading: '正在读取插件市场…', empty: '没有匹配的插件。', install: '安装', installing: '安装中…', installed: '已提交安装，请重启运行时后使用。', failed: '操作失败，请检查网络或插件兼容性后重试。' },
      en: { tab: 'Plugin market', search: 'Search plugin market', hint: 'Search and install from the configured plugin catalog.', loading: 'Loading plugin market…', empty: 'No matching plugins.', install: 'Install', installing: 'Installing…', installed: 'Install queued. Restart the runtime to use it.', failed: 'The operation failed. Check the network and plugin compatibility, then retry.' }
    }

    function bridge() {
      const params = new URLSearchParams(location.search)
      const address = params.get('dshDesktopBridge')
      if (!address) throw new Error('bridge unavailable')
      return { base: `http://${address}` }
    }
    async function request(path, options) {
      const config = bridge()
      const response = await fetch(`${config.base}${path}`, options)
      if (!response.ok) throw new Error('bridge request failed')
      return response.json()
    }
    function MarketTab({ t }) {
      const [query, setQuery] = React.useState('')
      const [state, setState] = React.useState({ phase: 'loading', entries: [] })
      const [installing, setInstalling] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      React.useEffect(() => {
        let active = true
        const timer = setTimeout(() => {
          request(`/market?q=${encodeURIComponent(query.trim())}`).then((result) => {
            if (active) setState({ phase: 'ready', entries: result.items || [] })
          }, () => { if (active) setState({ phase: 'error', entries: [] }) })
        }, 180)
        return () => { active = false; clearTimeout(timer) }
      }, [query])
      const install = async (entry) => {
        setInstalling(entry.name); setNotice('')
        try {
          const result = await request('/plugins/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: entry.name, spec: entry.installSpec }) })
          setNotice(result.ok ? t('installed') : t('failed'))
        } catch { setNotice(t('failed')) }
        finally { setInstalling(null) }
      }
      return jsx('div', { className: 'dsm_section', children: [jsx('p', { className: 'dsm_hint', children: t('hint') }), jsxs('label', { className: 'dsm_search', children: [jsx(IconSearchOutline16, { 'aria-hidden': true }), jsx('input', { type: 'search', value: query, placeholder: t('search'), 'aria-label': t('search'), onChange: (event) => setQuery(event.currentTarget.value) })] }), state.phase === 'loading' ? jsx('p', { className: 'dsm_status', children: t('loading') }) : null, state.phase === 'error' ? jsx('p', { className: 'dsm_status', role: 'alert', children: t('failed') }) : null, notice ? jsx('p', { className: 'dsm_status', role: 'status', children: notice }) : null, state.phase === 'ready' && state.entries.length === 0 ? jsx('p', { className: 'dsm_status', children: t('empty') }) : null, state.entries.length > 0 ? jsx('ul', { className: 'dsm_list', children: state.entries.map((entry) => jsxs('li', { className: 'dsm_card', children: [jsx('h3', { className: 'dsm_name', title: entry.name, children: entry.name }), jsx('p', { className: 'dsm_description', children: entry.description || entry.name }), jsxs('div', { className: 'dsm_footer', children: [jsx('span', { className: 'dsm_version', children: entry.author || '' }), jsx('button', { className: 'dsm_install', type: 'button', disabled: installing !== null, onClick: () => install(entry), children: installing === entry.name ? t('installing') : t('install') })] })] }, entry.name)) }) : null] })
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(ns, dictionary), 'dsh-desktop-market: dictionaries')
      const t = ctx.locale.bind(ns)
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'market', order: 20, label: () => t('tab'), locale: ns }, MarketTab))
    }
    return { apply, inject }
  }
})
