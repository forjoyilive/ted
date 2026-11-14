import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('src/renderer', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('dist/renderer', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      onwarn(warning, warn) {
        // lucide-react starts every icon module with "use client", which only matters to React Server Components.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
        warn(warning)
      },
    },
  },
})
