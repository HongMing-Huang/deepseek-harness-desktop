import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * 把插件目录随主进程构建复制到 out/main/plugin-catalog.json：
 * 零依赖（node:fs 直拷），保证 dev / build / 打包态均能以
 * join(__dirname, 'plugin-catalog.json') 读到（运行时另有源码树兜底）。
 */
function copyPluginCatalog(): Plugin {
  return {
    name: 'copy-plugin-catalog',
    closeBundle() {
      const src = resolve(__dirname, 'src/main/runtime/plugin-catalog.json')
      const dest = resolve(__dirname, 'out/main/plugin-catalog.json')
      try {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(src, dest)
      } catch {
        // 复制失败不阻塞构建：运行时会回退源码树路径
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyPluginCatalog()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          splash: resolve(__dirname, 'src/renderer/splash.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          plugins: resolve(__dirname, 'src/renderer/plugins.html')
        }
      }
    }
  }
})
