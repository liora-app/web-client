import { expect, type Page } from '@playwright/test'
import type { SceneStats } from '../../src/gl/scene'

export type { SceneStats }

export const SECTION_IDS = ['hero', 'how', 'scenarios', 'diary', 'privacy', 'safety', 'faq', 'final'] as const

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
