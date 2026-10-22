import { expect, type Locator, type Page } from '@playwright/test'
import type { SceneStats } from '../../src/gl/scene'

export type { SceneStats }

// The repo has no @types/node (node-builtins.d.ts): the one Node global read here.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> }

export const SECTION_IDS = ['hero', 'how', 'scenarios', 'diary', 'privacy', 'safety', 'faq', 'final'] as const

/** E2E_CPU_THROTTLE=<rate>, opt-in: slows this page's main thread `rate` times (CDP, Chromium
 *  only), to see locally what a CI runner sees — two workers on two vCPUs. Unset (CI, every
 *  ordinary run) it does nothing. One browser, --workers=1, as always on the owner's PC. */
export async function throttle(page: Page): Promise<void> {
  const rate = Number(process.env.E2E_CPU_THROTTLE ?? '')
  if (!Number.isFinite(rate) || rate <= 1) return
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
}

/** Waits until the finite animations and transitions that run now are over — in `scope`'s subtree,
 *  or the whole document for a page. A cancelled one counts as over: its `finished` rejects with an
 *  AbortError when a transition is retargeted or its element hidden (a slow runner sees that where a
 *  fast PC sees the end). Endless ones (a breath, a drift) never end and are left alone, and so are
 *  those on targets matching `except` (motion the caller does not read, such as the breathing
 *  circle's scale under a colour check). One pass: what starts after the call is not waited for.
 *  `cap` (ms, Node side — an in-page timer would stand still under page.clock) goes on after that
 *  long instead of waiting on; without it the test's own timeout is the bound. */
export async function animationsDone(scope: Page | Locator, options: { except?: string; cap?: number } = {}): Promise<void> {
  const target = 'goto' in scope ? scope.locator(':root') : scope
  const done = target.evaluate((root, except) => {
    const all = root === document.documentElement ? document.getAnimations() : root.getAnimations({ subtree: true })
    return Promise.all(
      all
        .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
        .filter((a) => {
          const on = (a.effect as KeyframeEffect | null)?.target
          return except === '' || !(on instanceof Element && on.matches(except))
        })
        .map((a) => a.finished.then(() => undefined, () => undefined)),
    ).then(() => undefined)
  }, options.except ?? '')
  if (options.cap === undefined) return done
  // Left behind past the cap, the wait may still reject (the page navigated): nobody listens then.
  done.catch(() => undefined)
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, options.cap))])
}

/** Collects console errors/warnings and uncaught exceptions for the whole test. */
export function watchConsole(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  return problems
}

/** Pretends the browser has no WebGL2 (old device, blocked GPU). */
export const NO_WEBGL2 = `(() => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (type === 'webgl2') return null;
    return original.call(this, type, ...rest);
  };
})();`

/** Pretends WebGL2 runs on a software rasterizer (SwiftShader). */
export const SOFTWARE_RENDERER = `(() => {
  const original = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (name) {
    if (name === 0x1f01 || name === 0x9246) return 'Google SwiftShader';
    return original.call(this, name);
  };
})();`

/** Every draw call costs 40 ms of main-thread time (CPU only, no GPU load) and is counted in
 *  window.__draws: a device that cannot keep up, without naming itself as one. */
export const SLOW_DRAWS = `(() => {
  window.__draws = 0;
  const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) {} };
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const original = WebGL2RenderingContext.prototype[name];
    WebGL2RenderingContext.prototype[name] = function (...args) { window.__draws++; busy(40); return original.apply(this, args); };
  }
})();`

export async function sceneStats(page: Page): Promise<SceneStats> {
  return page.evaluate(() => {
    const scene = window.__lioraScene
    if (!scene) throw new Error('scene is not running')
    return scene.stats()
  })
}

/** Lit points (luminance > 12) in the scene's 9×9 sample grid, or -1 while no scene is running. */
export async function litSamples(page: Page): Promise<number> {
  const luminance = await page.evaluate(() => window.__lioraScene?.sample() ?? [])
  return luminance.length === 81 ? luminance.filter((value) => value > 12).length : -1
}

/** Waits until the scene is on; on a machine without a usable GPU it fails at once with the reason. */
export async function waitForScene(page: Page): Promise<void> {
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-gl', /^(on|off)$/, { timeout: 15_000 })
  expect(await html.getAttribute('data-gl-reason'), 'the scene did not start here').toBeNull()
}

/** Scrolls so the element's centre (or the middle of its first screen, if it is taller) sits in the
 *  middle of the viewport. No smooth scrolling. */
export async function centre(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((node) => {
    const box = node.getBoundingClientRect()
    window.scrollTo({ top: window.scrollY + box.top + Math.min(box.height, window.innerHeight) / 2 - window.innerHeight / 2, behavior: 'instant' })
  })
}

/** Things drawn past the screen edge. body { overflow-x: clip } hides them instead of scrolling,
 *  so look at element boxes and at text runs (a block's own box never shows its overflowing words). */
export async function cutOffAtEdges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const out = (rect: DOMRect): boolean => rect.width > 0 && (rect.right > width + 1 || rect.left < -1)
    const skip = (element: Element | null): boolean => !element || element.closest('.visually-hidden, .brand__name') !== null
    const found: string[] = []
    const range = document.createRange()
    for (const root of Array.from(document.querySelectorAll('.site-header, main, .site-footer'))) {
      for (const element of Array.from(root.querySelectorAll('*'))) {
        if (!skip(element) && out(element.getBoundingClientRect())) found.push(`<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}">`)
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        if (!node.data.trim() || skip(node.parentElement)) continue
        range.selectNodeContents(node)
        if (Array.from(range.getClientRects()).some(out)) found.push(`"${node.data.trim().slice(0, 40)}"`)
      }
    }
    return found
  })
}
