import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { NO_WEBGL2, animationsDone, centre, cutOffAtEdges, throttle, watchConsole } from './helpers'

// The landing's motion between chapters (spec §9.4 п. 8, ADR-012 «Рух»): the hero's cascade, the
// reveals of steps, privacy rows and FAQ answers, #mind's copy unfolding with the scroll and its
// CSS-only portrait, the sky's drifting lights, the FAQ's smooth opening. Progressive enhancement is
// the contract: with reduced motion, on «Пауза», without IntersectionObserver every block is on screen
// at rest and nothing shifts. Every test installs NO_WEBGL2 before navigation (locally the browser runs
// with E2E_NO_WEBGL=1 too): the static backdrop is what #mind's CSS fallback is about, and no GPU work.

test.beforeEach(async ({ page }) => {
  await throttle(page)
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

/** The stage's own pseudo-elements: the landing's drifting lights are gone (ADR-013). */
const stageLights = (page: Page): Promise<string[]> =>
  page.locator('.stage').evaluate((stage) => [getComputedStyle(stage, '::before').content, getComputedStyle(stage, '::after').content])

const SKIES = '.hero, .mind, #how, #scenarios, #diary, .night, #final'

/** The section skies: their animations, and whether every sky is the same image a frame apart. */
async function skies(page: Page): Promise<{ animations: number; still: boolean }> {
  const images = (): Promise<string[]> => page.locator(SKIES).evaluateAll((all) => all.map((node) => getComputedStyle(node).backgroundImage))
  const before = await images()
  await frames(page)
  await page.waitForTimeout(250)
  const after = await images()
  const animations = await page.locator(SKIES).evaluateAll((all) => all.flatMap((node) => node.getAnimations()).length)
  return { animations, still: JSON.stringify(before) === JSON.stringify(after) }
}

const opacity = (page: Page, selector: string): Promise<number> => page.locator(selector).evaluate((element) => Number(getComputedStyle(element).opacity))
const color = (page: Page, selector: string): Promise<string> => page.locator(selector).evaluate((element) => getComputedStyle(element).color)

/** A token's colour as the browser computes it here (a probe element, set through CSSOM). */
const ink = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement('span')
    probe.style.setProperty('color', `var(${name})`)
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, token)

/** #mind's copy: the texts its scroll timeline moves. */
const MIND_TEXT = ['.mind__copy .tag', '#mind-title', '#mind-title span', '.mind__note'] as const

/** «Пауза» in the header, then the pointer leaves it (its own hover colours are not motion): they
 *  ease out, and only then do the checks of what still runs look (400 ms of a timer did not always
 *  cover that on a slow runner). */
async function pause(page: Page): Promise<void> {
  const toggle = page.locator('[data-motion-toggle]')
  await toggle.click()
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off')
  await page.mouse.move(1, 300)
  await expect.poll(() => toggle.evaluate((node) => node.matches(':hover'))).toBe(false)
  await animationsDone(page.locator('.media'))
}

/** The hero's cascade is over: src/ui/intro.ts takes html.js-intro off once it is (600 ms + 100) —
 *  the state itself, where a 700 ms timer only guessed at it. */
async function cascadeOver(page: Page): Promise<void> {
  await expect(page.locator('html')).not.toHaveClass(/\bjs-intro\b/)
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
    // The sky stands without motion: the stage has no lights of its own (ADR-013), and the sections'
    // skies have no animation and do not move a frame apart.
    expect(await stageLights(page)).toEqual(['none', 'none'])
    expect(await skies(page)).toEqual({ animations: 0, still: true })
    expect(problems).toEqual([])
  })

  test('«Пауза»: nothing runs anywhere, every block stands at rest, the page does not jump', async ({ page }) => {
    await page.goto('/')
    await settled(page)
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
    await cascadeOver(page)

    // Paused half-way through #mind's pin: its height and the scroll position stay as they are.
    await pinAt(page, 0.15)
    const before = await page.evaluate(() => ({ mind: document.querySelector<HTMLElement>('.mind')!.offsetHeight, y: Math.round(window.scrollY) }))
    expect(await color(page, '.mind__note'), 'the note is still to come at this point: the dim ink').toBe(await ink(page, '--color-text-dim'))
    await pause(page)
    expect(await page.evaluate(() => ({ mind: document.querySelector<HTMLElement>('.mind')!.offsetHeight, y: Math.round(window.scrollY) }))).toEqual(before)
    expect(await color(page, '.mind__note'), 'on pause, its own ink').toBe(await ink(page, '--color-text'))
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
    expect(await stageLights(page)).toEqual(['none', 'none'])
    expect(await skies(page)).toEqual({ animations: 0, still: true })

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
      await cascadeOver(page)
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

/** [data-reveal] blocks with any part on screen that are not at rest (hidden, or still coming in). */
function blankOnScreen(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-reveal]'))
      .filter((element) => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && box.bottom > 0 && box.top < window.innerHeight
      })
      .filter((element) => getComputedStyle(element).opacity !== '1')
      .map((element) => `${element.id || element.className} @${Math.round(element.getBoundingClientRect().top)}/${window.innerHeight}`),
  )
}

// The observer's root ends 12 % above the bottom edge: a block whose top stops in that band is on
// screen but never "intersecting". Wherever the scroll comes to rest, what is on screen is shown
// (src/ui/reveal.ts), and only that.
test.describe('where the scroll comes to rest, what is on screen is shown', () => {
  for (const hash of ['#how', '#privacy', '#faq']) {
    test(`a deep link to ${hash} leaves no blank block on screen`, async ({ page }) => {
      await page.goto(`/${hash}`)
      await settled(page)
      await expect(page.locator('html')).toHaveClass(/\bjs-reveal\b/)
      // The fragment's scroll is smooth (base.css): wait for it to land, then for the blocks to settle.
      await expect.poll(() => page.locator(hash).evaluate((element) => Math.round(element.getBoundingClientRect().top)), { timeout: 5_000 }).toBeLessThan(120)
      await expect.poll(() => blankOnScreen(page), { timeout: 3_000 }).toEqual([])
    })
  }

  test('a stop with a row at the bottom edge shows it, and nothing below the fold', async ({ page }) => {
    await page.goto('/')
    await settled(page)
    await page.waitForTimeout(700)
    await expect(page.locator('html')).toHaveClass(/\bjs-reveal\b/)
    const rows = page.locator('.principles > [data-reveal="item"]')
    // The third row's top at 94 % of the screen: inside the band the observer never counts.
    await rows.nth(2).evaluate((element) => {
      const top = element.getBoundingClientRect().top + window.scrollY
      window.scrollTo({ top: top - window.innerHeight * 0.94, behavior: 'instant' })
    })
    await expect(rows.nth(2)).toHaveClass(/is-visible/)
    await expect(rows.nth(2)).toHaveCSS('opacity', '1')
    // The chapter title's own entrance (1.2 s) may still be under way: wait for it, not for a timer.
    await expect.poll(() => blankOnScreen(page), { timeout: 3_000 }).toEqual([])
    // Below the fold it still waits for the scroll.
    const below = await rows.evaluateAll((all) => all.filter((element) => element.getBoundingClientRect().top >= window.innerHeight).map((element) => element.classList.contains('is-visible')))
    expect(below.length).toBeGreaterThan(0)
    expect(below.every((visible) => !visible)).toBe(true)
  })
})

/** The hero's three parts the moment html.js-intro goes on (before any frame of the cascade). */
type IntroPart = { selector: string; count: number; end: number; properties: string[]; opacity: string; transform: string }
/** How often src/ui/intro.ts asked for the paint entries, and the cascade if the class ever went on. */
type IntroSeen = { asked: number; parts?: IntroPart[] }
const HERO = ['.hero__title', '.hero__aside', '.hero__links']

/** src/ui/intro.ts plays the cascade only over a page the browser has not painted yet. Whether the
 *  first paint lands before the module runs is a race the machine decides, so the test answers the
 *  module's question itself: `painted` is what performance.getEntriesByType('paint') returns (nothing,
 *  or one first-paint). Each branch then either does what it must or fails; neither is skipped. */
async function watchIntro(page: Page, painted: boolean): Promise<void> {
  await page.addInitScript(
    ([alreadyPainted, hero]) => {
      const seen: IntroSeen = { asked: 0 }
      ;(window as unknown as { __intro: IntroSeen }).__intro = seen
      const entries = performance.getEntriesByType.bind(performance)
      performance.getEntriesByType = ((type: string) => {
        if (type !== 'paint') return entries(type)
        seen.asked += 1
        return alreadyPainted ? [{ name: 'first-paint', entryType: 'paint', startTime: 1, duration: 0, toJSON: () => ({}) }] : []
      }) as typeof performance.getEntriesByType
      new MutationObserver(() => {
        if (!document.documentElement.classList.contains('js-intro') || seen.parts) return
        seen.parts = hero.map((selector) => {
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
    },
    [painted, HERO] as const,
  )
}

const introSeen = (page: Page): Promise<IntroSeen> => page.evaluate(() => (window as unknown as { __intro: IntroSeen }).__intro)

test.describe('motion', () => {
  test('the hero comes in once: within 600 ms, the headline by opacity alone, the rest rising 8 px', async ({ page }) => {
    await watchIntro(page, false)
    await page.goto('/')
    await settled(page)
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
    const intro = await introSeen(page)
    expect(intro.asked, 'src/ui/intro.ts asks whether the page was painted').toBeGreaterThan(0)
    expect(intro.parts, 'nothing painted yet, motion on: the cascade must start').toBeDefined()
    const [title, aside, links] = intro.parts!
    expect(title).toMatchObject({ count: 1, properties: ['opacity'], opacity: '0', transform: 'none' })
    for (const part of [aside, links]) expect(part).toMatchObject({ count: 1, properties: ['opacity', 'transform'], opacity: '0', transform: 'matrix(1, 0, 0, 1, 0, 8)' })
    expect(Math.max(title!.end, aside!.end, links!.end)).toBeLessThanOrEqual(600)

    // Over in under 700 ms, and the class goes with it.
    await expect(page.locator('html')).not.toHaveClass(/js-intro/, { timeout: 1_500 })
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    expect(await notAtRest(page, HERO)).toEqual([])
  })

  test('a hero the browser has already painted stays as it is: no cascade over text already seen', async ({ page }) => {
    await watchIntro(page, true)
    await page.goto('/')
    await settled(page)
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
    const intro = await introSeen(page)
    expect(intro.asked, 'src/ui/intro.ts asks whether the page was painted').toBeGreaterThan(0)
    expect(intro.parts, 'html.js-intro never goes on').toBeUndefined()
    expect(await page.locator(HERO.join(', ')).evaluateAll((all) => all.flatMap((element) => element.getAnimations()).length)).toBe(0)
    expect(await notAtRest(page, HERO)).toEqual([])
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

    // ADR-013: the muted tones are one (soft = muted = dim), so the copy's own ink is --color-text —
    // the tag, the second line and the note alike — and the dim ink before its turn stays distinct.
    const dim = await ink(page, '--color-text-dim')
    const own = {
      tag: await ink(page, '--color-text'),
      title: await ink(page, '--color-text'),
      soft: await ink(page, '--color-text'),
      note: await ink(page, '--color-text'),
    }
    expect(dim).not.toBe(own.note)
    expect(dim).not.toBe(own.tag)
    // The scroll can stop anywhere: the copy is never faded, only dimmer and lower before its turn.
    for (const at of [-0.3, -0.1, 0, 0.15, 0.36, 0.6, 1, 1.3]) {
      await pinAt(page, at)
      for (const text of MIND_TEXT) expect(await opacity(page, text), `${text} at ${at}`).toBe(1)
    }

    // The pin starts: «Ближче» is there in its own ink, «до себе.» and the note still dim.
    await pinAt(page, 0)
    expect(await color(page, '#mind-title')).toBe(own.title)
    expect(await color(page, '#mind-title span')).toBe(dim)
    expect(await color(page, '.mind__note')).toBe(dim)
    const turnAtStart = await page.locator('.mind__still').evaluate((element) => getComputedStyle(element).rotate)

    // A third in: «до себе.»; past the middle: the note; the copy has not drifted yet.
    await pinAt(page, 0.34)
    expect(await color(page, '#mind-title span')).toBe(own.soft)
    await pinAt(page, 0.6)
    expect(await notAtRest(page, ['.mind__copy', ...MIND_TEXT])).toEqual([])
    expect(await Promise.all(['.mind__copy .tag', '#mind-title', '#mind-title span', '.mind__note'].map((text) => color(page, text)))).toEqual([own.tag, own.title, own.soft, own.note])
    const turnInside = await page.locator('.mind__still').evaluate((element) => getComputedStyle(element).rotate)
    expect(turnInside).not.toBe(turnAtStart)
    await expect(page.locator('.mind__still')).toBeVisible()

    // The pin ends: the copy drifts up with the portrait turning away.
    await pinAt(page, 1)
    const drift = await page.locator('.mind__copy').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42)
    expect(drift).toBeLessThan(-10)
  })

  // Where a search lands (the match scrolled to the middle of the screen) and wherever the scroll
  // stops half-way through the timeline, the copy reads at ≥ 4.5:1 — in both themes.
  for (const scheme of ['dark', 'light'] as const) {
    test(`#mind half-way through its timeline passes axe, and a found line is readable (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto('/')
      test.skip(!(await page.evaluate(() => CSS.supports('animation-timeline', 'view()'))), 'scroll-driven animations only')
      await settled(page)
      const axe = async (label: string): Promise<void> => {
        await frames(page)
        const results = await new AxeBuilder({ page }).include('#mind').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
        const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
        expect(summary, label).toEqual([])
      }
      // The section's top at 70 % of the screen: the tag and «Ближче» on their way.
      await page.evaluate(() => {
        const mind = document.querySelector<HTMLElement>('.mind')!
        window.scrollTo({ top: mind.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.7, behavior: 'instant' })
      })
      await axe('entry')
      for (const at of [0.15, 0.4]) {
        await pinAt(page, at)
        await axe(`pin ${at}`)
      }
      // From the top of the page, as a find-in-page jump would land.
      for (const text of ['.mind__note', '#mind-title span']) {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
        await page.locator(text).evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
        await frames(page)
        expect(await opacity(page, text), text).toBe(1)
        await axe(`found ${text}`)
      }
    })
  }

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
    // Click from the page itself, then the first frame the height moves in: on its way, not there
    // yet. Two frames were not always enough — a transition waits a frame or more for its start
    // time, and under a slowed CPU the height still stood closed then.
    const open = (index: number): Promise<{ closed: number; early: number }> =>
      page.evaluate(async (at) => {
        const details = document.querySelectorAll('#faq details')[at]!
        const closed = details.getBoundingClientRect().height
        details.querySelector('summary')!.click()
        let early = closed
        for (let frame = 0; frame < 120 && early === closed; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          early = details.getBoundingClientRect().height
        }
        return { closed, early }
      }, index)
    const height = (index: number): Promise<number> => page.locator('#faq details').nth(index).evaluate((element) => element.getBoundingClientRect().height)
    /** The height a frame apart is the same: the opening is over (not a timer's guess at it). */
    const still = async (index: number): Promise<number> => {
      let last = -1
      await expect
        .poll(async () => {
          const now = await height(index)
          await frames(page)
          const after = await height(index)
          last = after
          return now === after
        })
        .toBe(true)
      return last
    }

    const smooth = await open(0)
    const full = await still(0)
    expect(smooth.early).toBeGreaterThan(smooth.closed)
    expect(smooth.early).toBeLessThan(full - 4)

    await pause(page)
    const instant = await open(1)
    await page.waitForTimeout(400)
    expect(instant.early).toBe(await height(1))
    expect(instant.early).toBeGreaterThan(instant.closed + 20)
  })

  // ADR-013: the aurora drifts in the sections' own skies (--drift inside the fields' positions), not
  // in two lights of the stage. Background only: the boxes and the text stay where they are.
  test('the sky drifts in the sections, goes quiet beside the crisis numbers, and stands on pause', async ({ page }) => {
    await page.goto('/')
    await settled(page)
    const night = page.locator('.night')
    const sky = (selector: string): Promise<{ image: string; animations: string[] }> =>
      page.locator(selector).first().evaluate((node) => ({
        image: getComputedStyle(node).backgroundImage,
        animations: node.getAnimations().map((animation) => (animation as Animation & { animationName?: string }).animationName ?? '?'),
      }))
    for (const where of ['#scenarios', '#faq']) {
      await centre(page, where)
      const section = where === '#faq' ? '.night' : where
      expect((await sky(section)).animations, where).toEqual(['sky-drift'])
      const first = (await sky(section)).image
      await expect.poll(async () => (await sky(section)).image, { message: `${where}: the fields move` }).not.toBe(first)
    }
    const size = (): Promise<number[]> => night.evaluate((node) => [(node as HTMLElement).offsetWidth, (node as HTMLElement).offsetHeight])
    const box = await size()

    // Beside the crisis contacts the decoration goes (ADR-011): the night's stops alone, no drift.
    await centre(page, '#safety')
    await expect(page.locator('.stage')).toHaveAttribute('data-quiet', '')
    await expect.poll(async () => (await sky('.night')).animations).toEqual([])
    expect((await sky('.night')).image).not.toMatch(/radial-gradient/)
    expect(await size(), 'the sky goes quiet, the box stays').toEqual(box)

    await pause(page)
    await centre(page, '#faq')
    await frames(page)
    expect(await skies(page)).toEqual({ animations: 0, still: true })
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
