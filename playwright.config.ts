import { defineConfig, devices } from '@playwright/test'

// Tests run against the production build (vite build + vite preview), not the dev server.
// channel: 'chromium' = full Chromium in new headless mode: it uses the real GPU, while the
// default headless shell renders WebGL with SwiftShader (which the page treats as "software"
// and answers with the static backdrop — covered by its own test).
const PORT = 4173
// E2E_BASE_URL points the suite at a running site instead (the container, or production after a
// deploy); then nothing is built or served here.
const TARGET = process.env.E2E_BASE_URL

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  // Each worker is a real browser rendering WebGL (WebKit on Windows does it in software):
  // the default of half the cores froze a 16-thread desktop. Three is plenty for this suite,
  // and the WebKit project runs one page at a time (see its entry below).
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: TARGET ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: TARGET
    ? undefined
    : {
        command: 'npm run build && npm run preview',
        url: `http://localhost:${PORT}`,
        // Always test a fresh build: a preview left running would serve stale files.
        // If the port is taken, Playwright fails loudly instead.
        reuseExistingServer: false,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], channel: 'chromium' },
    },
    {
      name: 'iphone-webkit',
      // WebKit on Windows rasterises WebGL on the CPU (src/gl/core/quality.ts): one page at a time.
      workers: 1,
      use: { ...devices['iPhone 15'] },
    },
  ],
})
