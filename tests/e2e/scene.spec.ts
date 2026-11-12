import { expect, test } from '@playwright/test'
import { NO_WEBGL2, SLOW_DRAWS, SOFTWARE_RENDERER, centre, litSamples, sceneStats, waitForScene, watchConsole } from './helpers'

// Needs a working WebGL2 context (a real GPU here). CI runners have none, so CI runs the suite with
// --grep-invert @gpu (scripts/ci-e2e.sh); the full suite runs locally before a PR (README).
const GPU = { tag: '@gpu' }

// The GPU path is asserted in Chromium (channel: 'chromium' uses the real GPU, see config).
// WebKit on Windows rasterises WebGL on the CPU here, so it checks that the fallback is sane.

test.describe('WebGL scene', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'GPU path is asserted in Chromium')

  test('starts after the page and draws a non-blank frame', GPU, async ({ page }) => {
    const problems = watchConsole(page)
    await page.goto('/')
    await waitForScene(page)

    // Lazy scene (core/boot.ts afterFirstPaint): the chunk is requested only after the load event.
    const timing = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
      const chunk = performance.getEntriesByType('resource').find((entry) => /\/assets\/scene-[^/]+\.js$/.test(entry.name))
      return { loadEnd: navigation.loadEventEnd, chunkStart: chunk?.startTime ?? -1 }
    })
    expect(timing.loadEnd, 'the load event has finished').toBeGreaterThan(0)
    expect(timing.chunkStart, 'the scene is a separate lazy chunk').toBeGreaterThan(0)
    expect(timing.chunkStart, 'the scene chunk is requested only after load').toBeGreaterThanOrEqual(timing.loadEnd)

    // The hero is the DOM mascot; sample the decorative field in the final chapter.
    await centre(page, '#final')
    await expect.poll(() => litSamples(page), { timeout: 8_000 }).toBeGreaterThanOrEqual(2)
    // The animation loop itself runs (sample() draws its own frame, so check the counter).
    await expect.poll(async () => (await sceneStats(page)).frames, { timeout: 5_000 }).toBeGreaterThan(10)
    // WebGL never replaces or recolors the original Figma mascot.
    await expect(page.locator('.hero__orb')).toHaveCSS('opacity', '1')

    const stats = await sceneStats(page)
    expect(stats.pixelRatio).toBeLessThanOrEqual(2)
    expect(stats.particles).toBeGreaterThan(0)
    expect(stats.vertices).toBeGreaterThanOrEqual(20000)
    // Bounded geometry and five layers; no expensive post-processing passes.
    expect(stats.draws).toBeLessThanOrEqual(7)
    expect(stats.draws).toBeGreaterThan(0)
    expect(problems).toEqual([])
  })

  test('?tier=low starts the lightest tier', GPU, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one browser is enough for the override')
    await page.goto('/?tier=low')
    await waitForScene(page)
    const stats = await sceneStats(page)
    expect(stats.tier).toBe('low')
    expect(stats.vertices).toBeLessThan(30000)
    expect(stats.particles).toBeLessThan(1000)
  })

  test('canvas is decorative and never takes input', async ({ page }) => {
    await page.goto('/')
    const canvas = page.locator('canvas')
    await expect(canvas).toHaveCount(1)
    await expect(canvas).toHaveAttribute('aria-hidden', 'true')
    await expect(page.locator('.stage')).toHaveAttribute('aria-hidden', 'true')
    await expect(canvas).toHaveCSS('pointer-events', 'none')
    await expect(page.locator('.vignette')).toHaveCSS('pointer-events', 'none')
  })

  test('scrolling moves the scene through its states', GPU, async ({ page }) => {
    await page.goto('/')
    await waitForScene(page)
    expect((await sceneStats(page)).state).toBeLessThan(0.2)

    const targets = await page
      .locator('[data-gl-state]')
      .evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset.glState)))
    // Visit every distinct state: centre its first element and let the damping settle.
    const seen = new Set<number>()
    for (const state of targets) {
      if (seen.has(state)) continue
      seen.add(state)
      await centre(page, `[data-gl-state="${state}"]`)
      await expect.poll(async () => (await sceneStats(page)).state, { timeout: 6_000 }).toBeCloseTo(state, 0)
    }
    // ADR-013: the beads no longer carry states 1–3 (one row: their plateaus coincide); #how holds 1.
    expect(seen.size).toBe(7)
  })

  test('the scene follows the text layout, not the screen shape', GPU, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one browser is enough for the breakpoint')
    await page.goto('/')
    await waitForScene(page)
    expect((await sceneStats(page)).layout).toBe('wide')
    // Landscape, but one text column (below 64em): the light must not light up a side lane.
    await page.setViewportSize({ width: 960, height: 760 })
    await expect.poll(async () => (await sceneStats(page)).layout).toBe('column')
  })

  test('lost WebGL context shows the static backdrop and recovers', GPU, async ({ page }) => {
    await page.goto('/')
    const html = page.locator('html')
    await waitForScene(page)
    const orb = page.locator('.hero__orb')
    await expect(orb).toHaveCSS('opacity', '1')

    await page.evaluate(() => {
      const gl = document.querySelector('canvas')?.getContext('webgl2')
      ;(window as unknown as { __lose?: WEBGL_lose_context | null }).__lose = gl?.getExtension('WEBGL_lose_context')
      ;(window as unknown as { __lose?: WEBGL_lose_context | null }).__lose?.loseContext()
    })
    await expect(html).toHaveAttribute('data-gl', 'off')
    await expect(html).toHaveAttribute('data-gl-reason', 'context-lost')
    await expect(orb).toHaveCSS('opacity', '1')
    const framesWhileLost = (await sceneStats(page)).frames

    await page.evaluate(() => (window as unknown as { __lose?: WEBGL_lose_context | null }).__lose?.restoreContext())
    await expect(html).toHaveAttribute('data-gl', 'on', { timeout: 10_000 })
    // The loop runs again (not only the frame sample() draws itself)…
    await expect.poll(async () => (await sceneStats(page)).frames, { timeout: 5_000 }).toBeGreaterThan(framesWhileLost + 10)
    // The decorative field resumes in its chapter; the DOM mascot stays intact.
    await centre(page, '#final')
    await expect.poll(() => litSamples(page), { timeout: 8_000 }).toBeGreaterThanOrEqual(2)
    await expect(orb).toHaveCSS('opacity', '1')
  })

  test('pause button stops the animation and the choice survives a reload', GPU, async ({ page }) => {
    await page.goto('/')
    const html = page.locator('html')
    await waitForScene(page)

    const toggle = page.locator('[data-motion-toggle]')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(html).toHaveAttribute('data-gl', 'off')
    await expect(html).toHaveAttribute('data-gl-reason', 'user')
    // Paused looks paused: the button is lit and offers to play; smooth scrolling stops too.
    await expect(toggle).toHaveCSS('background-color', 'rgba(244, 250, 255, 0.14)')
    await expect(toggle.locator('.motion-toggle__play')).toBeVisible()
    await expect(html).toHaveCSS('scroll-behavior', 'auto')
    const frames = (await sceneStats(page)).frames
    await page.waitForTimeout(600)
    expect((await sceneStats(page)).frames).toBe(frames)

    await page.reload()
    await expect(html).toHaveAttribute('data-gl', 'off')
    await expect(page.locator('[data-motion-toggle]')).toHaveAttribute('aria-pressed', 'true')

    await page.locator('[data-motion-toggle]').click()
    await expect(html).toHaveAttribute('data-gl', 'on', { timeout: 15_000 })
  })

  test('the crisis section calms the scene while it is in the middle of the screen, then lets go', GPU, async ({ page }) => {
    await page.goto('/')
    await waitForScene(page)
    expect((await sceneStats(page)).quiet).toBeLessThan(0.05)
    expect((await sceneStats(page)).activity, 'the hero uses the DOM mascot').toBeLessThan(0.05)
    await centre(page, '#safety')
    await expect.poll(async () => (await sceneStats(page)).quiet, { timeout: 6_000 }).toBeGreaterThan(0.6)
    // By the crisis contacts the sculpture is hidden: nothing moves while someone reads the numbers.
    await expect.poll(async () => (await sceneStats(page)).activity, { timeout: 6_000 }).toBeLessThan(0.05)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await expect.poll(async () => (await sceneStats(page)).quiet, { timeout: 6_000 }).toBeLessThan(0.1)
    await expect.poll(async () => (await sceneStats(page)).activity, { timeout: 6_000 }).toBeLessThan(0.05)
    await centre(page, '#final')
    await expect.poll(async () => (await sceneStats(page)).activity, { timeout: 6_000 }).toBeGreaterThan(0.5)
  })

  test('high contrast mode pauses the scene and turning it off resumes it', GPU, async ({ page }) => {
    await page.goto('/')
    const html = page.locator('html')
    await waitForScene(page)

    await page.emulateMedia({ forcedColors: 'active' })
    await expect(html).toHaveAttribute('data-gl', 'off')
    await expect(html).toHaveAttribute('data-gl-reason', 'forced-colors')
    await expect(page.locator('.stage')).toBeHidden()
    await expect(page.locator('canvas')).toBeHidden()
    await expect(page.locator('.hero__orb')).toBeHidden()
    const frames = (await sceneStats(page)).frames
    await page.waitForTimeout(600)
    expect((await sceneStats(page)).frames).toBe(frames)

    await page.emulateMedia({ forcedColors: 'none' })
    await expect(html).toHaveAttribute('data-gl', 'on')
    await expect.poll(async () => (await sceneStats(page)).frames).toBeGreaterThan(frames)
  })

  test('a device too slow for the first frames gets the static page for the rest of the visit', GPU, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one project is enough for the governor path')
    await page.addInitScript(SLOW_DRAWS)
    await page.goto('/')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-gl-reason', 'slow', { timeout: 15_000 })
    await expect(html).toHaveAttribute('data-gl', 'off')
    await expect(page.locator('.hero__orb')).toHaveCSS('opacity', '1')
    expect(await page.evaluate(() => typeof window.__lioraScene)).toBe('undefined')

    // It gave up inside the start-up window (≤ 12 frames of 5 draws, plus warm-up), and the
    // loop really stopped: the main thread is free again.
    const draws = (): Promise<number> => page.evaluate(() => (window as unknown as { __draws: number }).__draws)
    const before = await draws()
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThanOrEqual(80)
    await page.waitForTimeout(600)
    expect(await draws()).toBe(before)

    // Terminal for the visit: pause + resume must not restart the scene. Read once, without
    // retrying: a restart would come back to 'slow' inside the retry window of toHaveAttribute.
    const toggle = page.locator('[data-motion-toggle]')
    await toggle.click()
    await toggle.click()
    expect(await html.getAttribute('data-gl')).toBe('off')
    expect(await html.getAttribute('data-gl-reason')).toBe('slow')
    expect(await draws()).toBe(before)
  })
})

test.describe('static backdrop', () => {
  test('reduced motion keeps the scene off until the visitor asks for it', GPU, async ({ page, browserName }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-gl', 'off')
    await expect(html).toHaveAttribute('data-gl-reason', 'reduced-motion')
    const orb = page.locator('.hero__orb')
    await expect(orb).toBeVisible()
    await expect(orb).toHaveCSS('opacity', '1')
    await page.waitForTimeout(1500)
    await expect(html).toHaveAttribute('data-gl', 'off')

    const toggle = page.locator('[data-motion-toggle]')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    if (browserName === 'chromium') {
      await toggle.click()
      await expect(html).toHaveAttribute('data-gl', 'on', { timeout: 15_000 })
    }
  })

  // «the static light follows data-gl» moved to landing.spec.ts (ADR-013): it needs no GPU, and there
  // it runs locally too.

  test('forced colours (high contrast) get the plain page', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/')
    const emulated = await page.evaluate(() => window.matchMedia('(forced-colors: active)').matches)
    test.skip(!emulated, 'this browser cannot emulate forced colours')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-gl', 'off')
    await expect(html).toHaveAttribute('data-gl-reason', 'forced-colors')
    await expect(page.locator('.stage')).toBeHidden()
    await expect(page.locator('.hero__orb')).toBeHidden()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('.mind__still')).toBeHidden()
    // The pause button keeps a visible icon: an SVG drawn in currentColor, which forced colours map
    // to the system button text (backgrounds would be forced to Canvas and vanish).
    await expect(page.locator('[data-motion-toggle] svg:visible')).toHaveCount(1)
    await expect(page.locator('[data-motion-toggle]')).toHaveAccessibleName('Пауза анімації')
    expect((await page.locator('.brand').boundingBox())?.width ?? 0).toBeGreaterThan(10)
  })

  test('without WebGL2 the page stays complete', async ({ page }) => {
    const problems = watchConsole(page)
    await page.addInitScript(NO_WEBGL2)
    await page.goto('/')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-gl', 'off', { timeout: 10_000 })
    await expect(html).toHaveAttribute('data-gl-reason', 'no-webgl2')
    const orb = page.locator('.hero__orb')
    await expect(orb).toBeVisible()
    await expect(orb).toHaveCSS('opacity', '1')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(problems).toEqual([])
    await expect(page.locator('#mind-title')).toHaveText(/Ближче.*до себе\./)
    await expect(page.locator('.mind__still')).toBeVisible()
  })

  test('if the scene chunk cannot load, the page is still complete', GPU, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit here renders WebGL on the CPU; one more software run adds cost, not coverage')
    await page.route(/\/assets\/scene-[^/]+\.js$/, (route) => route.abort())
    await page.goto('/')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-gl', 'off', { timeout: 15_000 })
    await expect(html).toHaveAttribute('data-gl-reason', 'error')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('.hero__lead')).toBeVisible()
    await expect(page.locator('.hero__orb')).toHaveCSS('opacity', '1')
  })

  test('a software renderer gets the static backdrop', GPU, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the renderer string override targets Chromium')
    await page.addInitScript(SOFTWARE_RENDERER)
    await page.goto('/')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-gl', 'off', { timeout: 10_000 })
    await expect(html).toHaveAttribute('data-gl-reason', 'software')
  })

  test('the scene settles: on, or off with a known reason, within seconds', async ({ page }) => {
    await page.goto('/')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-gl', /^(on|off)$/, { timeout: 20_000 })
    if ((await html.getAttribute('data-gl')) === 'off') {
      await expect(html).toHaveAttribute('data-gl-reason', /^(slow|software|no-webgl2|error)$/)
    }
  })

  test('with reduced motion the scene chunk is never fetched', async ({ page }) => {
    const early: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() === 'script') early.push(request.url())
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // With motion off the scene never loads: only the small entry script is fetched, plus the module
    // it shares with /chat/ (motion, sound, the GL boot) since the build has two pages (ADR-007),
    // and the tiny classic /theme-init.js that puts the theme on <html> before the first frame
    // (ADR-012).
    const modules = early.filter((url) => new URL(url).pathname !== '/theme-init.js')
    expect(early.length - modules.length).toBe(1)
    expect(modules.length).toBeGreaterThanOrEqual(1)
    expect(modules.length).toBeLessThanOrEqual(2)
    expect(early.filter((url) => /\/assets\/(scene|presence)-/.test(url))).toEqual([])
    const sizes = await page.evaluate(
      async (urls) => Promise.all(urls.map(async (url) => (await (await fetch(url)).arrayBuffer()).byteLength)),
      early,
    )
    // three.js alone is far over this: the scene's chunks were not fetched.
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(40_000)
  })
})
