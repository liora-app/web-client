import { defineConfig } from 'vite'

// Static landing (ADR-006): served at "/" by Caddy; "/api/*" belongs to the server.
export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    // No data: URIs, so a strict CSP (img-src/font-src 'self') works without exceptions.
    assetsInlineLimit: 0,
    // three.js lives in its own lazy chunk; keep the warning meaningful for the rest.
    chunkSizeWarningLimit: 700,
  },
})
