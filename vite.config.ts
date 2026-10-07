import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// The site's CSP (ADR-007, verbatim; deploy/Caddyfile sends the same string on every response).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// vite preview mirrors production, because the e2e suite in CI runs against it (ADR-007). One set
// for every response: preview.headers cannot depend on the path.
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  // In production the edge Caddy sends it. Without it CI would check the Origin the chat's requests
  // carry under other conditions than production (ADR-007: no-referrer and Origin: null).
  'Referrer-Policy': 'no-referrer',
}

/**
 * The chat's caching in preview, as deploy/Caddyfile does it (spec §10.4):
 * - "/chat" → 308 to "/chat/" (Caddy's file_server); preview alone would serve the landing there;
 * - "/chat/" and "/chat/index.html", with or without a query → Cache-Control: no-store.
 * The request is rewritten to /chat/index.html: that file goes through sirv, which keeps the header,
 * while "/chat/" would go through Vite's HTML fallback and send(), which sets no-cache over it.
 * Registered directly (not returned), so it runs before Vite's own middlewares.
 */
function previewChatNoStore(): Plugin {
  return {
    name: 'liora-preview-no-store',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? '').split(/\?(.*)/s)
        const search = query ? `?${query}` : ''
        if (path === '/chat') {
          res.statusCode = 308
          res.setHeader('Location', `/chat/${search}`)
          res.setHeader('Cache-Control', 'no-store')
          res.end()
          return
        }
        if (path === '/chat/' || path === '/chat/index.html') {
          res.setHeader('Cache-Control', 'no-store')
          req.url = `/chat/index.html${search}`
        }
        next()
      })
    },
  }
}

// Two pages of one static build (ADR-006, ADR-007): the landing at "/" and the chat at "/chat/".
// Both are served by Caddy; "/api/*" belongs to the server.
export default defineConfig({
  // No CSP on the dev server: Vite injects styles there through JS (<style> for HMR).
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true, headers: SECURITY_HEADERS },
  plugins: [previewChatNoStore()],
  build: {
    // No data: URIs, so a strict CSP (img-src/font-src 'self') works without exceptions.
    assetsInlineLimit: 0,
    // three.js lives in its own lazy chunk; keep the warning meaningful for the rest.
    chunkSizeWarningLimit: 700,
    // Vite 8: rollupOptions is the deprecated alias of rolldownOptions.
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        chat: fileURLToPath(new URL('./chat/index.html', import.meta.url)),
      },
    },
  },
})
