import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // OG8: the Quick Box window gets its own reduced preload. Isolated entries: a sandboxed
      // preload cannot require a shared chunk, so each entry must be a standalone bundle.
      isolatedEntries: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          quickbox: resolve(__dirname, 'src/preload/quickbox.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})
