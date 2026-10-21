import { expect, test, type Page } from '@playwright/test'
import { NO_WEBGL2, centre, cutOffAtEdges, watchConsole } from './helpers'

// The landing's motion between chapters (spec §9.4 п. 8, ADR-012 «Рух»): the hero's cascade, the
// reveals of steps, privacy rows and FAQ answers, #mind's copy unfolding with the scroll and its
// CSS-only portrait, the sky's drifting lights, the FAQ's smooth opening. Progressive enhancement is
// the contract: with reduced motion, on «Пауза», without IntersectionObserver every block is on screen
// at rest and nothing shifts. Every test installs NO_WEBGL2 before navigation (locally the browser runs
// with E2E_NO_WEBGL=1 too): the static backdrop is what #mind's CSS fallback is about, and no GPU work.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(NO_WEBGL2)
})

/** The blocks the motion touches; each must end at rest (opacity 1, no offset). */
const MOVING = ['.hero__title', '.hero__aside', '.hero__links', '.mind__copy', '.mind__copy .tag', '#mind-title', '#mind-title span', '.mind__note', '[data-reveal]']

const frames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

/** The static backdrop is up and the fonts are in (hero-light measures the title with them). */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-gl', 'off', { timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready)
}

/** Elements matching `selectors` (within `scope`) that are not at rest: opacity below 1 or moved. */
function notAtRest(page: Page, selectors: readonly string[] = MOVING, scope = 'body'): Promise<string[]> {
  return page.evaluate(
    ([list, root]) =>
      list.flatMap((selector) =>
        Array.from(document.querySelector(root)!.querySelectorAll(selector))
          .filter((element) => {
            const style = getComputedStyle(element)
            return style.opacity !== '1' || !['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(style.transform)
          })
          .map((element) => `${selector} → ${element.id || element.className} (${getComputedStyle(element).opacity}, ${getComputedStyle(element).transform})`),
      ),
    [selectors, scope] as const,
  )
}

/** Running animations and transitions anywhere in the document, pseudo-elements included. */
function running(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === 'running')
      .map((animation) => {
        const named = animation as Animation & { animationName?: string; transitionProperty?: string }
        const target = (animation.effect as KeyframeEffect | null)?.target
        return `${named.animationName ?? named.transitionProperty ?? '?'} on ${target?.className ?? '?'}`
      }),
  )
}

/** Scrolls #mind to a point of its pin: 0 = its top at the viewport's top (the pin starts), 1 = its
 *  bottom at the viewport's bottom (the pin ends). */
async function pinAt(page: Page, fraction: number): Promise<void> {
  await page.evaluate((at) => {
    const mind = document.querySelector<HTMLElement>('.mind')!
    const top = mind.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: top + (mind.offsetHeight - window.innerHeight) * at, behavior: 'instant' })
  }, fraction)
  await frames(page)
}

const opacity = (page: Page, selector: string): Promise<number> => page.locator(selector).evaluate((element) => Number(getComputedStyle(element).opacity))

/** «Пауза» in the header, then the pointer leaves it (its own hover colours are not motion). */
async function pause(page: Page): Promise<void> {
  await page.locator('[data-motion-toggle]').click()
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off')
  await page.mouse.move(1, 300)
  await page.waitForTimeout(400)
}

test.describe('without motion everything is there at once', () => {
  test('reduced motion: no block waits, nothing animates, #mind is not pinned', async ({ page }) => {
    const problems = watchConsole(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await settled(page)
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'off')
    await expect(page.locator('html')).toHaveAttribute('data-gl-reason', 'reduced-motion')
    await expect(page.locator('html')).not.toHaveClass(/js-intro/)
    expect(await notAtRest(page)).toEqual([])
    expect(await running(page)).toEqual([])

    // No pin to scroll through: the section is one screen of still art and text.
    const mind = await page.evaluate(() => document.querySelector<HTMLElement>('.mind')!.offsetHeight / window.innerHeight)
    expect(mind).toBeLessThan(1.5)
    for (const where of ['#mind', '#how', '#privacy', '#faq']) {
      await centre(page, where)
      await frames(page)
      expect(await notAtRest(page), where).toEqual([])
      expect(await running(page), where).toEqual([])
    }
    await page.locator('#faq summary').first().click()
    await frames(page)
    expect(await running(page), 'a FAQ answer opens at once').toEqual([])
    // The sky's lights do not exist without motion.
    expect(await page.locator('.stage').evaluate((stage) => [getComputedStyle(stage, '::before').opacity, getComputedStyle(stage, '::after').opacity])).toEqual(['0', '0'])
    expect(problems).toEqual([])
  })

  test('«Пауза»: nothing runs anywhere, every block stands at rest, the page does not jump', async ({ page }) => {
    await page.goto('/')
    await settled(page)
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
    await page.waitForTimeout(700) // the hero's cascade is over

    // Paused half-way through #mind's pin: its height and the scroll position stay as they are.
    await pinAt(page, 0.15)
    const before = await page.evaluate(() => ({ mind: document.querySelector<HTMLElement>('.mind')!.offsetHeight, y: Math.round(window.scrollY) }))
    expect(await opacity(page, '.mind__note'), 'the note is still to come at this point').toBeLessThan(1)
    await pause(page)
    expect(await page.evaluate(() => ({ mind: document.querySelector<HTMLElement>('.mind')!.offsetHeight, y: Math.round(window.scrollY) }))).toEqual(before)
    expect(await notAtRest(page)).toEqual([])
    expect(await running(page)).toEqual([])

    for (const where of ['#how', '#scenarios', '#privacy', '#safety', '#faq', '#final']) {
      await centre(page, where)
      await frames(page)
      expect(await notAtRest(page), where).toEqual([])
      expect(await running(page), where).toEqual([])
    }
    await centre(page, '#faq')
    const answer = page.locator('#faq details').nth(1)
    await answer.locator('summary').click()
    await frames(page)
    expect(await running(page), 'the answer opens at once, the «+» turns at once').toEqual([])
    await expect(answer).toHaveAttribute('open', '')
    expect(await page.locator('.stage').evaluate((stage) => [getComputedStyle(stage, '::before').opacity, getComputedStyle(stage, '::after').opacity])).toEqual(['0', '0'])

    // Play again: the hero's entrance does not replay.
    await page.locator('[data-motion-toggle]').click()
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
    expect(await page.locator('.hero__title, .hero__aside, .hero__links').evaluateAll((all) => all.flatMap((element) => element.getAnimations()).length)).toBe(0)
  })

  for (const kind of ['missing', 'silent'] as const) {
    test(`an IntersectionObserver that is ${kind} hides nothing, #mind's copy included`, async ({ page }) => {
      await page.addInitScript((variant) => {
        if (variant === 'missing') {
          delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
          return
        }
        window.IntersectionObserver = class {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
          takeRecords(): IntersectionObserverEntry[] {
            return []
          }
        } as unknown as typeof IntersectionObserver
      }, kind)
      await page.goto('/')
      await settled(page)
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
      await page.waitForTimeout(700)
      await expect(page.locator('html')).not.toHaveClass(/js-reveal/)
      expect(await notAtRest(page, ['[data-reveal]', '.hero__title', '.hero__aside', '.hero__links'])).toEqual([])
      for (const where of ['#how', '#privacy', '#faq', '#final']) {
        await centre(page, where)
        await frames(page)
        expect(await notAtRest(page, ['[data-reveal]']), where).toEqual([])
      }
      // #mind's copy follows the scroll, not the observer: all of it is there by the middle of the pin.
      await pinAt(page, 0.62)
      expect(await notAtRest(page, ['.mind__copy', '.mind__copy .tag', '#mind-title', '#mind-title span', '.mind__note'])).toEqual([])
    })
  }
})

test.describe('motion', () => {
  test('the hero comes in once: within 600 ms, the headline by opacity alone, the rest rising 8 px', async ({ page }) => {
    // What the cascade is at the moment src/ui/intro.ts switches it on (before any frame of it).
    await page.addInitScript(() => {
      const seen: Record<string, unknown> = {}
      ;(window as unknown as { __intro: Record<string, unknown> }).__intro = seen
      new MutationObserver(() => {
        const root = document.documentElement
        if (!root.classList.contains('js-intro') || seen.parts) return
        seen.paintedBefore = performance.getEntriesByType('paint').length
        seen.parts = ['.hero__title', '.hero__aside', '.hero__links'].map((selector) => {
          const element = document.querySelector(selector)!
          const animations = element.getAnimations()
          const style = getComputedStyle(element)
          return {
            selector,
            count: animations.length,
            end: Math.max(0, ...animations.map((animation) => Number(animation.effect?.getComputedTiming().endTime ?? 0))),
            properties: [...new Set(animations.flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame))))]
              .filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))
              .sort(),
            opacity: style.opacity,
            transform: style.transform,
          }
        })
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] })
    })
    await page.goto('/')
    await settled(page)
    const intro = await page.evaluate(() => (window as unknown as { __intro: { paintedBefore?: number; parts?: { selector: string; count: number; end: number; properties: string[]; opacity: string; transform: string }[] } }).__intro)
    // The cascade only plays over a page not painted yet; a page already on screen keeps its text.
    test.skip(!intro.parts, 'the page was painted before the module ran: no cascade, by design')
    expect(intro.paintedBefore).toBe(0)
    const [title, aside, links] = intro.parts!
    expect(title).toMatchObject({ count: 1, properties: ['opacity'], opacity: '0', transform: 'none' })
    for (const part of [aside, links]) expect(part).toMatchObject({ count: 1, properties: ['opacity', 'transform'], opacity: '0', transform: 'matrix(1, 0, 0, 1, 0, 8)' })
    expect(Math.max(title!.end, aside!.end, links!.end)).toBeLessThanOrEqual(600)

    // Over in under 700 ms, and the class goes with it.
    await expect(page.locator('html')).not.toHaveClass(/js-intro/, { timeout: 1_500 })
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    expect(await notAtRest(page, ['.hero__title', '.hero__aside', '.hero__links'])).toEqual([])
  })

  test('steps, privacy rows and FAQ answers come in once: 280 ms, 8 px, decelerate', async ({ page }) => {
    await page.goto('/')
    await settled(page)
    await expect(page.locator('.step[data-reveal="item"]')).toHaveCount(4)
    await expect(page.locator('.principles > [data-reveal="item"]')).toHaveCount(7)
    await expect(page.locator('.qa[data-reveal="item"]')).toHaveCount(7)
    await expect(page.locator('#privacy-title[data-reveal], #privacy .lead[data-reveal]')).toHaveCount(2)
    await expect(page.locator('html')).toHaveClass(/\bjs-reveal\b/)

    const last = page.locator('.qa').last()
    await expect(last).not.toHaveClass(/is-visible/)
    await expect(last).toHaveCSS('opacity', '0')
    await expect(last).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 8)')
    await expect(last).toHaveCSS('transition-duration', '0.28s, 0.28s')
    await expect(last).toHaveCSS('transition-timing-function', 'cubic-bezier(0.05, 0.7, 0.1, 1), cubic-bezier(0.05, 0.7, 0.1, 1)')

    await centre(page, '.faq__list')
    await last.scrollIntoViewIfNeeded()
    await expect(last).toHaveClass(/is-visible/)
    await expect(last).toHaveCSS('opacity', '1')
    await expect(last).toHaveCSS('transform', 'none')
    // Once: away and back, it stays.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await frames(page)
    await last.scrollIntoViewIfNeeded()
    await frames(page)
    await expect(last).toHaveCSS('opacity', '1')
    await expect(last).toHaveCSS('transform', 'none')
  })

  test('#mind without WebGL: the copy unfolds with the scroll, the portrait turns, the pin stays', async ({ page }) => {
    await page.addInitScript(() => {
      document.addEventListener(
        'DOMContentLoaded',
        () => ((window as unknown as { __mindAtDcl: number }).__mindAtDcl = document.querySelector<HTMLElement>('.mind')!.offsetHeight),
        { once: true },
      )
    })
    await page.goto('/')
    const supported = await page.evaluate(() => CSS.supports('animation-timeline', 'view()'))
    test.skip(!supported, 'scroll-driven animations: this engine takes the reveal instead')
    await settled(page)
    await expect(page.locator('html')).toHaveAttribute('data-gl-reason', 'no-webgl2')

    // The static backdrop keeps the pinned height: data-gl going loading → off moves nothing.
    const heights = await page.evaluate(() => ({ dcl: (window as unknown as { __mindAtDcl: number }).__mindAtDcl, now: document.querySelector<HTMLElement>('.mind')!.offsetHeight, screen: window.innerHeight }))
    expect(heights.now).toBe(heights.dcl)
    expect(heights.now / heights.screen).toBeGreaterThan(1.8)

    // The pin starts: «Ближче» is there, «до себе.» and the note are still to come.
    await pinAt(page, 0)
    expect(await opacity(page, '#mind-title')).toBeGreaterThan(0.95)
    expect(await opacity(page, '#mind-title span')).toBeLessThan(0.1)
    expect(await opacity(page, '.mind__note')).toBeLessThan(0.1)
    const turnAtStart = await page.locator('.mind__still').evaluate((element) => getComputedStyle(element).rotate)

    // A third in: «до себе.»; past the middle: the note; the copy has not drifted yet.
    await pinAt(page, 0.34)
    expect(await opacity(page, '#mind-title span')).toBe(1)
    await pinAt(page, 0.6)
    expect(await notAtRest(page, ['.mind__copy', '.mind__copy .tag', '#mind-title', '#mind-title span', '.mind__note'])).toEqual([])
    const turnInside = await page.locator('.mind__still').evaluate((element) => getComputedStyle(element).rotate)
    expect(turnInside).not.toBe(turnAtStart)
    await expect(page.locator('.mind__still')).toBeVisible()

    // The pin ends: the copy drifts up with the portrait turning away.
    await pinAt(page, 1)
    const drift = await page.locator('.mind__copy').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42)
    expect(drift).toBeLessThan(-10)
  })

  test('an engine without scroll-driven animations brings #mind’s copy in with the reveal', async ({ page }) => {
    // Chromium has them, so this only shows the module's branch: the steps join the reveal.
    await page.addInitScript(() => {
      const original = CSS.supports.bind(CSS)
      CSS.supports = ((...args: [string, string?]) => (args[0] === 'animation-timeline' ? false : original(...(args as [string, string])))) as typeof CSS.supports
    })
    await page.goto('/')
    await settled(page)
    await expect(page.locator('[data-mind-step][data-reveal="mind"]')).toHaveCount(3)
    await pinAt(page, 0.5)
    for (const step of ['1', '2', '3']) await expect(page.locator(`[data-mind-step="${step}"]`)).toHaveClass(/is-visible/)
  })

  test('a FAQ answer opens smoothly with motion and at once on pause', async ({ page }) => {
    await page.goto('/')
    await settled(page)
    const supported = await page.evaluate(() => CSS.supports('interpolate-size', 'allow-keywords'))
    test.skip(!supported, 'this engine opens <details> at once')
    await centre(page, '#faq')
    await page.waitForTimeout(500) // the answers' own reveal is over
    // Click from the page itself, then two frames: the height is on its way, not there yet.
    const open = (index: number): Promise<{ closed: number; early: number }> =>
      page.evaluate(async (at) => {
        const details = document.querySelectorAll('#faq details')[at]!
        const closed = details.getBoundingClientRect().height
        details.querySelector('summary')!.click()
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        return { closed, early: details.getBoundingClientRect().height }
      }, index)
    const height = (index: number): Promise<number> => page.locator('#faq details').nth(index).evaluate((element) => element.getBoundingClientRect().height)

    const smooth = await open(0)
    await page.waitForTimeout(600)
    const full = await height(0)
    expect(smooth.early).toBeGreaterThan(smooth.closed)
    expect(smooth.early).toBeLessThan(full - 4)

    await pause(page)
    const instant = await open(1)
    await page.waitForTimeout(400)
    expect(instant.early).toBe(await height(1))
    expect(instant.early).toBeGreaterThan(instant.closed + 20)
  })

  test('the sky drifts from #scenarios to #faq, goes out beside the crisis numbers, and stands on pause', async ({ page }) => {
    await page.goto('/')
    await settled(page)
    const lights = (): Promise<{ quiet: boolean; before: string[]; after: string[] }> =>
      page.locator('.stage').evaluate((stage) => {
        const before = getComputedStyle(stage, '::before')
        const after = getComputedStyle(stage, '::after')
        return { quiet: stage.hasAttribute('data-quiet'), before: [before.opacity, before.transform], after: [after.opacity, after.transform] }
      })
    await centre(page, '#scenarios')
    await expect.poll(async () => (await lights()).after[0]).toBe('1')
    const scenarios = await lights()
    await centre(page, '#faq')
    await expect.poll(async () => (await lights()).after[0]).toBe('1')
    const faq = await lights()
    expect(faq.after[1]).not.toBe(scenarios.after[1])
    expect(faq.before[1]).not.toBe(scenarios.before[1])
    // Transform only: the lights move, their boxes stay.
    expect(scenarios.after[1]).toMatch(/^matrix\(1, 0, 0, 1, /)

    // Beside the crisis contacts the decoration goes (ADR-011).
    await centre(page, '#safety')
    await expect.poll(async () => (await lights()).quiet).toBe(true)
    await expect.poll(async () => (await lights()).after[0]).toBe('0')
    await expect.poll(async () => (await lights()).before[0]).toBe('0')

    await pause(page)
    await centre(page, '#faq')
    await frames(page)
    expect(await lights()).toMatchObject({ before: ['0', 'none'], after: ['0', 'none'] })
  })
})

test.describe('reflow at 320 CSS px while things move (WCAG 1.4.10)', () => {
  test.use({ viewport: { width: 320, height: 640 } })

  test('no horizontal scroll and nothing cut off, through #mind and every moving chapter', async ({ page }) => {
    await page.goto('/')
    await settled(page)
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
    await page.waitForTimeout(700)
    const check = async (where: string): Promise<void> => {
      await frames(page)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, where).toBeLessThanOrEqual(0)
      expect(await cutOffAtEdges(page), where).toEqual([])
    }
    await check('top')
    for (const at of [-0.3, 0, 0.25, 0.5, 0.75, 1, 1.3]) {
      await pinAt(page, at)
      await check(`#mind ${at}`)
    }
    await page.evaluate(() => document.querySelectorAll('details').forEach((item) => ((item as HTMLDetailsElement).open = true)))
    for (const where of ['#how', '#scenarios', '#privacy', '#faq', '#final']) {
      await centre(page, where)
      await page.waitForTimeout(350)
      await check(where)
    }
  })
})
