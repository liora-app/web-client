import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { centre, cutOffAtEdges } from './helpers'

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

// The menu replaces the section links below 64em; on the desktop project look at a tablet width.
async function withMenu(page: Page, isMobile: boolean): Promise<void> {
  if (!isMobile) await page.setViewportSize({ width: 900, height: 800 })
  await page.goto('/')
}

test.describe('header', () => {
  test('wide screens show the sections in the header, no menu', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the 1440 px layout')
    await page.goto('/')
    await expect(page.locator('.site-nav')).toBeVisible()
    await expect(page.locator('[data-menu-open]')).toBeHidden()
  })

  test('wide screens lead to the chat: «Розмова з AI» after the motion and sound control', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the 1440 px layout')
    await page.goto('/')
    const cta = page.getByRole('banner').getByRole('link', { name: 'Розмова з AI', exact: true })
    await expect(cta).toBeVisible()
    await expect(cta).toHaveAttribute('href', '/chat/')
    const [media, link] = await Promise.all([page.locator('.site-header .media').boundingBox(), cta.boundingBox()])
    expect(link!.x).toBeGreaterThan(media!.x + media!.width)
    expect(Math.round(link!.height)).toBe(40)
  })

  test('the header holds the chat link at 1024 px: nothing cut off, nothing overlapping', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the narrowest wide layout; one engine is enough')
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/')
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('.site-header__cta')).toBeVisible()
    expect(await cutOffAtEdges(page)).toEqual([])
    // Left to right without overlaps: wordmark, sections, «Якщо важко», motion and sound, the chat.
    const boxes = await page
      .locator('.site-header .brand, .site-nav, .site-header .help-link, .site-header .media, .site-header__cta')
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect()).map(({ left, right }) => ({ left, right })))
    expect(boxes).toHaveLength(5)
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.left, `item ${i}`).toBeGreaterThanOrEqual(boxes[i - 1]!.right)
  })

  test('narrow screens put the chat first in the menu, as a full-width button', async ({ page, isMobile }) => {
    await withMenu(page, isMobile)
    await expect(page.locator('.site-header__cta')).toBeHidden()
    await page.locator('[data-menu-open]').click()
    const first = page.locator('[data-menu]').getByRole('link').first()
    await expect(first).toHaveAccessibleName('Розмова з AI')
    await expect(first).toHaveAttribute('href', '/chat/')
    const [link, list] = await Promise.all([first.boundingBox(), page.locator('.site-menu__list').boundingBox()])
    expect(Math.round(link!.width)).toBe(Math.round(list!.width))
  })

  test('motion and sound share one control, each button named and explained on hover', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Web Audio (and with it «Звук») is checked in Chromium')
    await page.goto('/')
    const media = page.getByRole('group', { name: 'Анімація і звук' })
    await expect(media).toBeVisible()
    await expect(media.getByRole('button')).toHaveCount(2)
    const sound = media.locator('[data-sound-toggle]')
    await expect(sound).toHaveAccessibleName('Звук')
    await sound.hover()
    await expect
      .poll(() => sound.evaluate((button) => getComputedStyle(button, '::after').content))
      .toBe('"Увімкнути звук"')
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
      /Розмова з AI/,
      /Як це працює/,
      /Сценарії/,
      /Щоденник/,
      /Приватність/,
      /Запитання/,
      /Що далі/,
      /Якщо важко/,
    ])

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
    for (const selector of ['.brand', '.help-link', '.motion-toggle', '.sound-toggle', '[data-menu-open]']) {
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

  const pressSound = (page: Page): Promise<void> => page.locator('[data-sound-toggle]').click()

  test('sound is off until pressed: no audio before the click, nothing remembered after a reload', async ({ page }) => {
    await page.addInitScript(COUNT_AUDIO)
    await page.goto('/')
    const html = page.locator('html')
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(500)
    await page.evaluate(() => window.scrollTo(0, 0))
    expect(await audioContexts(page)).toBe(0)
    await expect(html).toHaveAttribute('data-sound', 'off')

    await pressSound(page)
    await expect(html).toHaveAttribute('data-sound', 'on')
    expect(await audioContexts(page)).toBe(1)
    await expect(page.locator('[data-sound-toggle]')).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await expect(html).toHaveAttribute('data-sound', 'off')
    await expect(page.locator('[data-sound-toggle]')).toHaveAttribute('aria-pressed', 'false')
    expect(await audioContexts(page)).toBe(0)
  })

  test('sound goes quiet by the crisis contacts and on pause, then comes back', async ({ page }) => {
    await page.goto('/')
    const html = page.locator('html')
    await pressSound(page)
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
