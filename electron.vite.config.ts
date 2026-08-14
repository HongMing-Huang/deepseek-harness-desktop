import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * 把主进程静态资产随构建复制到 out/main/：
 * - plugin-catalog.json：插件目录（运行时另有源码树兜底）；
 * - whale-tray.png：托盘图标（源文件在 renderer/assets，未被页面引用，
 *   不会进入 vite 资产管线，需显式复制；主进程按 join(__dirname, ...) 读取）。
 * 零依赖（node:fs 直拷），保证 dev / build / 打包态均可读。
 */
function copyMainStaticAssets(): Plugin {
  return {
    name: 'copy-main-static-assets',
    closeBundle() {
      const items = [
        {
          src: resolve(__dirname, 'src/main/runtime/plugin-catalog.json'),
          dest: resolve(__dirname, 'out/main/plugin-catalog.json')
        },
        {
          src: resolve(__dirname, 'src/renderer/assets/whale-tray.png'),
          dest: resolve(__dirname, 'out/main/whale-tray.png')
        }
      ]
      for (const { src, dest } of items) {
        try {
          mkdirSync(dirname(dest), { recursive: true })
          copyFileSync(src, dest)
        } catch {
          // 复制失败不阻塞构建：运行时会回退源码树路径
        }
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMainStaticAssets()],
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
          plugins: resolve(__dirname, 'src/renderer/plugins.html'),
          sessions: resolve(__dirname, 'src/renderer/sessions.html')
        }
      }
    }
  }
})
