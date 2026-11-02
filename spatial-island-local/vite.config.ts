import { defineConfig, type Plugin } from 'vite'

// The island HTML holds a conversation in memory: no-store, as deploy/Caddyfile serves it (ADR-015 §4). The request is
// rewritten to /index.html so it goes through sirv, which keeps the header (the HTML fallback would set no-cache over
// it); the same pattern as the root vite.config.ts. Registered directly, so it runs before Vite's own middlewares.
function previewIslandNoStore(): Plugin {
  return {
    name: 'island-preview-no-store',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? '').split(/\?(.*)/s)
        if (path === '/' || path === '/index.html') {
          res.setHeader('Cache-Control', 'no-store')
          req.url = `/index.html${query ? `?${query}` : ''}`
        }
        next()
      })
    },
  }
}

// The production image serves the island under /island/ (web-client Dockerfile sets ISLAND_BASE); dev and preview stay on /.
export default defineConfig({
  base: process.env.ISLAND_BASE ?? '/',
  server: { host: '127.0.0.1', port: 8083, strictPort: true, watch: { usePolling: true, interval: 250 } },
  preview: { host: '127.0.0.1', port: 8084, strictPort: true,headers:{
    'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
  } },
  plugins: [previewIslandNoStore()],
  build: { assetsInlineLimit: 0, chunkSizeWarningLimit: 800 },
})
