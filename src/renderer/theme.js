// Deepseek 统一主题应用（自有页面共用）：
// 把偏好里的强调色映射到 <html data-accent>，theme.css 据此切换 CSS 变量。
// 只影响 Deepseek 自有页面；官方 dsh web 不加载本模块。

export const ACCENTS = ['blue', 'green', 'violet', 'amber']

export function applyAccent(accent) {
  const value = ACCENTS.includes(accent) ? accent : 'blue'
  document.documentElement.dataset.accent = value
  return value
}
