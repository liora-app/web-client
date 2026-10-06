import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { centre } from './helpers'

// Counts AudioContexts the page creates: «Звук» must not touch audio before it is pressed.
const COUNT_AUDIO = `(() => {
  window.__audioContexts = 0;
  const Original = window.AudioContext;
  if (!Original) return;
  window.AudioContext = class extends Original {
    constructor(...args) { super(...args); window.__audioContexts++; }
  };
})();`

const audioContexts = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __audioContexts: number }).__audioContexts)

// The menu replaces the pill below 85em; on the desktop project (1440 px) look at a laptop width.
async function withMenu(page: Page, isMobile: boolean): Promise<void> {
  if (!isMobile) await page.setViewportSize({ width: 1180, height: 800 })
  await page.goto('/')
}

test.describe('header', () => {
  test('wide screens show the sections and «Звук» in the header, no menu', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the 1440 px layout')
    await page.goto('/')
    await expect(page.locator('.nav-pill')).toBeVisible()
    await expect(page.locator('.site-header [data-sound-toggle]')).toBeVisible()
    await expect(page.locator('[data-menu-open]')).toBeHidden()
    await expect(page.locator('.help-link__number')).toHaveText(/112/)
  })

  test('the menu lists every chapter, closes with Esc and gives focus back', async ({ page, isMobile }) => {
    await withMenu(page, isMobile)
    const opener = page.locator('[data-menu-open]')
    const menu = page.locator('[data-menu]')
    await expect(opener).toBeVisible()
    await expect(opener).toHaveAccessibleName('Меню')
    await expect(menu).toBeHidden()

    await opener.click()
    await expect(menu).toBeVisible()
    await expect(opener).toHaveAttribute('aria-expanded', 'true')
    await expect(menu.getByRole('link')).toHaveText([
      /Як це працює/,
      /Сценарії/,
      /Щоденник/,
      /Приватність/,
      /Запитання/,
      /Що далі/,
      /Якщо важко/,
    ])
    // «Звук» shows only where the browser has Web Audio (Playwright's WebKit on Windows does not).
    const audio = await page.evaluate(() => typeof window.AudioContext === 'function')
    if (audio) await expect(menu.locator('[data-sound-toggle]')).toBeVisible()
    else await expect(menu.locator('[data-sound-toggle]')).toBeHidden()

    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(opener).toHaveAttribute('aria-expanded', 'false')
    await expect(opener).toBeFocused()
  })

  test('a chapter in the menu takes you there and the menu gets out of the way', async ({ page, isMobile }) => {
    await withMenu(page, isMobile)
    await page.locator('[data-menu-open]').click()
    await page.locator('[data-menu]').getByRole('link', { name: /Приватність/ }).click()
    await expect(page.locator('[data-menu]')).toBeHidden()
    await expect(page.locator('#privacy')).toBeInViewport({ ratio: 0.2 })
    // The page is not inert any more: its links take clicks again.
    await page.locator('.site-header .help-link').click()
    await expect(page.locator('#safety')).toBeInViewport({ ratio: 0.2 })
  })

  test('axe finds nothing with the menu open', async ({ page, isMobile }) => {
    await withMenu(page, isMobile)
    await page.locator('[data-menu-open]').click()
    await expect(page.locator('[data-menu]')).toBeVisible()
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
    expect(summary).toEqual([])
  })

  test('the header fits at 320 px with the menu', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'one engine is enough for the fit')
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto('/')
    await page.evaluate(() => document.fonts.ready)
    for (const selector of ['.brand', '.help-link', '.motion-toggle', '[data-menu-open]']) {
      const box = await page.locator(selector).first().boundingBox()
      expect(box, selector).not.toBeNull()
      expect((box?.x ?? 0) + (box?.width ?? 0), selector).toBeLessThanOrEqual(320)
    }
  })

  test('the landing makes no request to the API', async ({ page }) => {
    const api: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url())
    })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(800)
    expect(api).toEqual([])
  })
})

test.describe('sound', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Web Audio is checked in Chromium')

  // Desktop: the button in the header; phones: the one in the menu.
  async function pressSound(page: Page, isMobile: boolean): Promise<void> {
    if (isMobile) {
      await page.locator('[data-menu-open]').click()
      await page.locator('[data-menu] [data-sound-toggle]').click()
      await page.keyboard.press('Escape')
    } else {
      await page.locator('.site-header [data-sound-toggle]').click()
    }
  }

  test('sound is off until pressed: no audio before the click, nothing remembered after a reload', async ({ page, isMobile }) => {
    await page.addInitScript(COUNT_AUDIO)
    await page.goto('/')
    const html = page.locator('html')
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(500)
    await page.evaluate(() => window.scrollTo(0, 0))
    expect(await audioContexts(page)).toBe(0)
    await expect(html).toHaveAttribute('data-sound', 'off')

    await pressSound(page, isMobile)
    await expect(html).toHaveAttribute('data-sound', 'on')
    expect(await audioContexts(page)).toBe(1)
    for (const button of await page.locator('[data-sound-toggle]').all()) await expect(button).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await expect(html).toHaveAttribute('data-sound', 'off')
    await expect(page.locator('[data-sound-toggle]').first()).toHaveAttribute('aria-pressed', 'false')
    expect(await audioContexts(page)).toBe(0)
  })

  test('sound goes quiet by the crisis contacts and on pause, then comes back', async ({ page, isMobile }) => {
    await page.goto('/')
    const html = page.locator('html')
    await pressSound(page, isMobile)
    await expect(html).toHaveAttribute('data-sound', 'on')

    await centre(page, '#safety')
    await expect(html).toHaveAttribute('data-sound', 'muted')
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await expect(html).toHaveAttribute('data-sound', 'on')

    await page.locator('[data-motion-toggle]').click()
    await expect(html).toHaveAttribute('data-sound', 'muted')
    await page.locator('[data-motion-toggle]').click()
    await expect(html).toHaveAttribute('data-sound', 'on')
  })
})
