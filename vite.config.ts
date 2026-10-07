import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Two pages of one static build (ADR-006, ADR-007): the landing at "/" and the chat at "/chat/".
// Both are served by Caddy; "/api/*" belongs to the server.
export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
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
