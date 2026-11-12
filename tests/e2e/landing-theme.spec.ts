import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { NO_WEBGL2, animationsDone, throttle, watchConsole } from './helpers'

// The landing's two themes (ADR-012): «Вигляд» in the header (the chat's control, plain buttons —
// no inputs on this page), the choice on <html> before the first frame (public/theme-init.js), the
// light theme's static art. Every test installs NO_WEBGL2 before navigation: the page keeps its
// static backdrop (no GPU work here), which is also the state the art checks are about.

// ADR-013: one palette on both pages — the day's sky (its first stop) and the night.
const DAY = 'rgb(126, 199, 185)' // --color-bg, light (the day's sky, its first stop #7ec7b9)
const NIGHT = 'rgb(19, 36, 64)' // --color-bg, dark (the night #132440, now the chat's as well)
const STILL = /-still\.png/

test.beforeEach(async ({ page }) => {
  await throttle(page)
  await page.addInitScript(NO_WEBGL2)
})

const html = (page: Page): Locator => page.locator('html')
const toggle = (page: Page): Locator => page.locator('[data-theme-toggle]')
const menu = (page: Page): Locator => page.locator('[data-theme-menu]')
const item = (page: Page, name: string): Locator => menu(page).getByRole('menuitemradio', { name })
/** An item while the menu is closed (out of the accessibility tree then). */
const choice = (page: Page, value: 'system' | 'light' | 'dark'): Locator => menu(page).locator(`[data-theme-choice="${value}"]`)
const stored = (page: Page): Promise<string | null> => page.evaluate(() => localStorage.getItem('liora:theme'))
const rootBg = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
const themeColor = (page: Page): Promise<string | null> => page.locator('meta[name="theme-color"]').getAttribute('content')

/** The static backdrop is up: the scene never starts under NO_WEBGL2. */
async function staticPage(page: Page): Promise<void> {
  await expect(html(page)).toHaveAttribute('data-gl', 'off', { timeout: 15_000 })
}

/** Through the header's menu, by pointer. */
async function choose(page: Page, name: 'Як у системі' | 'Світла' | 'Темна'): Promise<void> {
  await toggle(page).click()
  await expect(menu(page)).toBeVisible()
  await item(page, name).click()
  await expect(menu(page)).toBeHidden()
}

test.describe('«Вигляд» on the landing', () => {
  test('the menu by keyboard: opens on the choice, arrows move, Enter and Space choose, Esc closes; the focus comes back', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard navigation is a desktop concern')
    await page.goto('/')
    await page.evaluate(() => {
      const heard: string[] = []
      ;(window as unknown as { __themes: string[] }).__themes = heard
      window.addEventListener('liora:theme', (event) => heard.push(String((event as CustomEvent).detail)))
    })
    await expect(toggle(page)).toBeVisible()
    // Outside the motion-and-sound group, a menu button with the choice in its name.
    await expect(page.locator('.media [data-theme-toggle]')).toHaveCount(0)
    await expect(toggle(page)).toHaveAttribute('aria-haspopup', 'menu')
    await expect(toggle(page)).toHaveAccessibleName('Вигляд: як у системі')
    await expect(menu(page).locator('button[role="menuitemradio"]')).toHaveCount(3)

    await toggle(page).focus()
    await page.keyboard.press('Enter')
    await expect(menu(page)).toBeVisible()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(item(page, 'Як у системі')).toBeFocused()
    await expect(item(page, 'Як у системі')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(item(page, 'Світла')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu(page)).toBeHidden()
    await expect(toggle(page)).toBeFocused()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(toggle(page)).toHaveAccessibleName('Вигляд: світла')
    await expect.poll(() => rootBg(page)).toBe(DAY)
    await expect.poll(() => themeColor(page)).toBe(DAY)
    expect(await stored(page)).toBe('light')

    // ↑ opens on the last item; Esc closes without a change and gives the focus back.
    await page.keyboard.press('ArrowUp')
    await expect(item(page, 'Темна')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu(page)).toBeHidden()
    await expect(toggle(page)).toBeFocused()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')

    // Home / End, and Space chooses too.
    await page.keyboard.press('Enter')
    await expect(item(page, 'Світла')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(item(page, 'Як у системі')).toBeFocused()
    await page.keyboard.press('End')
    await expect(item(page, 'Темна')).toBeFocused()
    await page.keyboard.press('Space')
    await expect(menu(page)).toBeHidden()
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect.poll(() => rootBg(page)).toBe(NIGHT)
    await expect.poll(() => themeColor(page)).toBe(NIGHT)
    expect(await stored(page)).toBe('dark')

    // Tab out of an open menu closes it and moves on.
    await page.keyboard.press('ArrowDown')
    await expect(menu(page)).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(menu(page)).toBeHidden()

    // The WebGL light hears each new theme (it swaps uniforms on this event).
    expect(await page.evaluate(() => (window as unknown as { __themes: string[] }).__themes)).toEqual(['light', 'dark'])
  })

  test('a choice survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await staticPage(page)
    await choose(page, 'Темна')
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await page.reload()
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(choice(page, 'dark')).toHaveAttribute('aria-checked', 'true')
    await expect(choice(page, 'system')).toHaveAttribute('aria-checked', 'false')
    await expect(toggle(page)).toHaveAttribute('data-choice', 'dark')
    expect(await rootBg(page)).toBe(NIGHT)

    await choose(page, 'Світла')
    await page.reload()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(choice(page, 'light')).toHaveAttribute('aria-checked', 'true')
    expect(await rootBg(page)).toBe(DAY)
  })

  test('the stored theme is on <html> at DOMContentLoaded, with the browser bar in its colour — public/theme-init.js alone', async ({ page }) => {
    await page.addInitScript(() => {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          ;(window as unknown as { __atDcl: unknown }).__atDcl = {
            theme: document.documentElement.getAttribute('data-theme'),
            bar: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
            bg: getComputedStyle(document.documentElement).backgroundColor,
          }
        },
        { once: true },
      )
    })
    // Stored once, then a fresh load (an init script would write it again on every load).
    await page.goto('/')
    await page.evaluate(() => localStorage.setItem('liora:theme', 'light'))
    await page.reload()
    expect(await page.evaluate(() => (window as unknown as { __atDcl: unknown }).__atDcl)).toEqual({ theme: 'light', bar: DAY, bg: DAY })
    // Without the page's module (and so without src/ui/theme.ts) the classic early script alone
    // puts the theme and the bar's colour in place.
    await page.route('**/assets/main-*.js', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }))
    await page.reload()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    expect(await themeColor(page)).toBe(DAY)
    expect(await rootBg(page)).toBe(DAY)
    await expect(toggle(page)).toBeHidden() // «Вигляд» needs the module: hidden without it
    await page.evaluate(() => localStorage.removeItem('liora:theme'))
  })

  test('the dark bar is the night from the early script on — never the chat’s lamp in between, with or without the page module', async ({ page }) => {
    // Every write to the one theme-color, in order: each attribute record's old value is the value
    // before that write, so the writes are the old values after the first, then the current value.
    await page.addInitScript(() => {
      const olds: (string | null)[] = []
      ;(window as unknown as { __olds: (string | null)[] }).__olds = olds
      new MutationObserver((records) => {
        for (const record of records) if (record.target instanceof HTMLMetaElement && record.target.name === 'theme-color') olds.push(record.oldValue)
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['content'], attributeOldValue: true })
    })
    const writes = async (): Promise<(string | null)[]> => {
      const olds = await page.evaluate(() => (window as unknown as { __olds: (string | null)[] }).__olds)
      expect(olds[0], 'the meta ships the night').toBe('#132440')
      return [...olds.slice(1), await themeColor(page)]
    }
    // The suite's dark system, no key: the early script writes the night, theme.ts has nothing to change.
    await page.goto('/')
    await staticPage(page)
    expect(await writes()).toEqual([NIGHT])
    // Without the page module the early script alone: the same night (the lamp before this fix).
    await page.route('**/assets/main-*.js', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }))
    await page.reload()
    await expect(toggle(page)).toBeHidden()
    expect(await writes()).toEqual([NIGHT])
    expect(await rootBg(page)).toBe(NIGHT)
    // A light system with «Темна» stored: the night too.
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(() => localStorage.setItem('liora:theme', 'dark'))
    await page.reload()
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    expect(await writes()).toEqual([NIGHT])
    expect(await rootBg(page)).toBe(NIGHT)
    await page.evaluate(() => localStorage.removeItem('liora:theme'))
  })

  test('«Як у системі» removes the key and follows the system again', async ({ page }) => {
    await page.goto('/')
    await staticPage(page)
    await choose(page, 'Світла')
    expect(await stored(page)).toBe('light')
    await expect.poll(() => rootBg(page)).toBe(DAY)

    await choose(page, 'Як у системі')
    expect(await stored(page)).toBeNull()
    await expect(html(page)).not.toHaveAttribute('data-theme')
    await expect(toggle(page)).toHaveAttribute('data-choice', 'system')
    // The suite emulates a dark system (playwright.config.ts): the night again.
    await expect.poll(() => rootBg(page)).toBe(NIGHT)
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
    // The system changes: the page follows, nothing is written.
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => rootBg(page)).toBe(DAY)
    await expect.poll(() => themeColor(page)).toBe(DAY)
    expect(await stored(page)).toBeNull()
  })
})

test.describe('the light theme without WebGL', () => {
  test.use({ colorScheme: 'light' })

  test('shows the original light mascot and never shows (nor loads) the dark stills', async ({ page }) => {
    const problems = watchConsole(page)
    const stills: string[] = []
    page.on('request', (request) => {
      if (STILL.test(request.url())) stills.push(new URL(request.url()).pathname)
    })
    await page.goto('/')
    await staticPage(page)
    await expect(html(page)).toHaveAttribute('data-gl-reason', 'no-webgl2')
    expect(await rootBg(page)).toBe(DAY)
    await expect(page.locator('.hero .mascot__art--light')).toBeVisible()
    await expect(page.locator('.hero .mascot__art--dark')).toBeHidden()
    // The remaining decorative scenes use CSS drawings in the light theme.
    const art = await page.evaluate(() =>
      (
        [
          // ADR-013: the conversation drawing and the diary's map are gone with their holders.
          ['.final__art', '::before'],
          ['.mind__still', null],
        ] as const
      ).map(([selector, pseudo]) => [selector + (pseudo ?? ''), getComputedStyle(document.querySelector(selector)!, pseudo).backgroundImage]),
    )
    for (const [holder, image] of art) {
      expect(image, holder).not.toMatch(STILL)
      expect(image, holder).toMatch(/gradient\(/)
    }
    // Down the whole page and back: nothing lazy brings a still in either.
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight) {
        window.scrollTo({ top: y, behavior: 'instant' })
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      }
    })
    await page.waitForLoadState('networkidle')
    expect(stills).toEqual([])
    expect(problems).toEqual([])

    // The dark theme keeps its stills: the night's art is the rendered one.
    await choose(page, 'Темна')
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.mind__still')!).backgroundImage))
      .toMatch(/portrait(-mobile)?-still\.png/)
  })

  test('axe finds no WCAG 2.2 AA violations on the light landing, with «Вигляд» open too', async ({ page }) => {
    await page.goto('/')
    await staticPage(page)
    expect(await rootBg(page)).toBe(DAY)
    await page.waitForLoadState('networkidle')
    // Reveal-on-scroll content in its final state, fades finished (as in landing.spec.ts).
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-reveal]'))
      items.forEach((element) => element.classList.add('is-visible'))
      for (const element of items) for (const animation of element.getAnimations()) animation.finish()
    })
    const run = async (label: string): Promise<void> => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
      expect(summary, label).toEqual([])
    }
    await run('the page')
    await toggle(page).click()
    await expect(menu(page)).toBeVisible()
    // Finite animations only (helpers.ts): a scroll-driven one (#mind) ends with the scroll, not with
    // time — its end is a percentage, not a number of ms — and would hold this wait for ever.
    await animationsDone(page)
    await run('the menu open')
  })
})

test.describe('the dark theme stays the landing’s night', () => {
  test('the night’s colours, the same as the chat’s', async ({ page }) => {
    await page.goto('/')
    await staticPage(page)
    expect(await rootBg(page)).toBe(NIGHT)
    await expect.poll(() => themeColor(page)).toBe(NIGHT)
    await expect(page.locator('h1')).toHaveCSS('color', 'rgb(244, 250, 255)') // --color-text #f4faff
    await expect(page.locator('.stage')).toHaveCSS('background-color', NIGHT) // the stage stands on --color-bg
  })
})
