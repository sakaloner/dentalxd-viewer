import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

// dicom-parser's UMD bundle does require('zlib') at load time.
// The package.json browser field maps zlib→false but viteCommonjs bypasses
// esbuild's browser-field substitution. Stub it out explicitly.
function zlibStub() {
  return {
    name: 'zlib-stub',
    resolveId(id) {
      if (id === 'zlib') return '\0zlib-stub'
    },
    load(id) {
      if (id === '\0zlib-stub') return 'export default {}'
    },
  }
}

// Codec packages ship as IIFE globals with no ESM default export.
// Use the `load` hook (runs before cache) to inject `export default`.
function cornerstoneCodecFix() {
  return {
    name: 'cornerstone-codec-fix',
    enforce: 'pre',
    load(id) {
      // Strip Vite query params to get real path
      const cleanId = id.split('?')[0]
      if (!cleanId.includes('@cornerstonejs/codec')) return
      if (!cleanId.endsWith('.js')) return
      try {
        const code = readFileSync(cleanId, 'utf-8')
        if (code.includes('export default')) return code
        const match = code.match(/^var (\w+)\s*=\s*\(/m)
        if (match) {
          return `${code}\nexport default ${match[1]};`
        }
      } catch {
        // file not readable — let Vite handle it
      }
    },
  }
}

export default defineConfig({
  base: '/dentalxd/',
  plugins: [react(), zlibStub(), cornerstoneCodecFix()],
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    watch: {
      // public/dicom symlinks to the (huge) scan library — watching it is
      // wasted work and crashes the dev server with ELOOP if the library
      // contains a symlink cycle. Serving still works; only watching is off.
      ignored: ['**/public/dicom/**'],
    },
  },
})
