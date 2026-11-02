import { defineConfig } from 'vite'

// The production image serves the island under /island/ (web-client Dockerfile sets ISLAND_BASE); dev and preview stay on /.
export default defineConfig({
  base: process.env.ISLAND_BASE ?? '/',
  server: { host: '127.0.0.1', port: 8083, strictPort: true, watch: { usePolling: true, interval: 250 } },
  preview: { host: '127.0.0.1', port: 8084, strictPort: true,headers:{
    'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'Permissions-Policy':'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
    'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
  } },
  build: { assetsInlineLimit: 0, chunkSizeWarningLimit: 800 },
})
