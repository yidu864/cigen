import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * GitHub Pages needs a non-root base path for project sites
 * (`https://<user>.github.io/<repo>/`), while user/org sites
 * (`https://<user>.github.io/`) must keep the root base.
 *
 * Override manually with `VITE_BASE=/my-base/ npm run build`.
 */
function resolveBase(): string {
  const explicit = process.env.VITE_BASE
  if (explicit) {
    return explicit.endsWith('/') ? explicit : `${explicit}/`
  }
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  if (!repo || repo.endsWith('.github.io')) {
    return '/'
  }
  return `/${repo}/`
}

export default defineConfig({
  base: resolveBase(),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
  },
})
