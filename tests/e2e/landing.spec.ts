import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { FORBIDDEN, clinicalOffenders } from './chat-fixtures'
import { NO_WEBGL2, SECTION_IDS, centre, cutOffAtEdges, watchConsole } from './helpers'

test.describe('content and structure', () => {
  test('renders the Ukrainian page without console problems', async ({ page }) => {
    const problems = watchConsole(page)
    await page.goto('/')

    await expect(page).toHaveTitle(/Liora/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('banner')).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('contentinfo')).toBeAttached()
    for (const id of SECTION_IDS) await expect(page.locator(`#${id}`)).toHaveCount(1)

    // Let the lazy scene chunk load and run for a moment before judging the console.
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)
    expect(problems).toEqual([])
  })

  test('has search and social metadata', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.{60,}/)
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Liora/)
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /.{40,}/)
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1)
    await expect(page.locator('link[rel="icon"]')).toHaveCount(1)
    // A shared link must say the same as the hero: an AI, not a person; not therapy.
    const og = ((await page.locator('meta[property="og:description"]').getAttribute('content')) ?? '').toLowerCase()
    expect(og).toMatch(/не з людиною/)
    expect(og).toMatch(/не терапі/)

    // The preview image: an absolute URL for crawlers, and the file itself ships with the site. The file is
    // fetched from the site under test, not from that URL (production may still serve an older build).
    const image = page.locator('meta[property="og:image"]')
    await expect(image).toHaveAttribute('content', /^https:\/\/[^/]+\/og\.jpg$/)
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image')
    await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', /.{20,}/)
    const file = await page.request.get('/og.jpg')
    expect(file.status()).toBe(200)
    expect(file.headers()['content-type']).toBe('image/jpeg')
  })

  test('crisis block lists 112, 103 and the hotline directory, never the paused 7333', async ({ page }) => {
    await page.goto('/')
    const safety = page.locator('#safety')
    await expect(safety).toContainText('112')
    await expect(safety).toContainText('103')
    await expect(safety.locator('a[href="https://howareu.com/hot-lines"]')).toHaveCount(1)
    await expect(page.locator('body')).not.toContainText('7333')
  })

  test('says it is AI and not therapy', async ({ page }) => {
    await page.goto('/')
    const text = (await page.locator('main').innerText()).toLowerCase()
    expect(text).toMatch(/\bai\b|штучн/)
    expect(text).toMatch(/не терапі|не замін|не психолог|не медичн/)
  })

  test('copy stays inside the product frame (stop-list)', async ({ page }) => {
    await page.goto('/')
    // innerText skips closed <details> (their content is display-locked): open every FAQ answer.
    await page.locator('details').evaluateAll((all) => all.forEach((item) => ((item as HTMLDetailsElement).open = true)))
    const attribute = async (selector: string, name: string): Promise<string> =>
      (await page.locator(selector).evaluateAll((nodes, key) => nodes.map((node) => node.getAttribute(key) ?? ''), name)).join('\n')
    const text = [
      await page.title(),
      await attribute('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]', 'content'),
      await attribute('[aria-label]', 'aria-label'), // screen readers announce these too
      await page.locator('body').innerText(),
    ]
      .join('\n')
      .toLowerCase()

    // One list for the landing and the chat (chat-fixtures.ts, spec §11.6).
    for (const pattern of FORBIDDEN) expect(text, `forbidden phrase ${pattern}`).not.toMatch(pattern)
    // Clinical words only negated or inside a question the page then answers.
    expect(clinicalOffenders(text)).toEqual([])
    // Age goes to the FAQ and the consent wording, never to a hero badge. Web-first: it waits out the decode.
    await expect(page.locator('#hero')).not.toContainText(/\b18\b|18\s*\+/)
  })

  test('collects nothing: no forms, no inputs, no third-party requests', async ({ page, baseURL }) => {
    const origins = new Set<string>()
    page.on('request', (request) => origins.add(new URL(request.url()).origin))
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Scroll to the end so anything lazy (scene chunk, fonts used further down) gets requested.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(1200)
    expect(await page.context().cookies()).toEqual([])

    await expect(page.locator('form, input, textarea, select')).toHaveCount(0)
    const own = new URL(baseURL ?? 'http://localhost:4173').origin
    const foreign = [...origins].filter((origin) => origin !== own && !origin.startsWith('data:'))
    expect(foreign).toEqual([])
  })

  test('the footer says which cookies exist once the chat signs in', async ({ page }) => {
    await page.goto('/')
    const note = page.locator('.site-footer__note')
    await expect(note).toContainText('Лендінг сам не ставить файли cookie і не має аналітики.')
    await expect(note).toContainText('браузер тримає файл cookie сесії, недоступний скриптам сторінки')
    await expect(note).toContainText('тимчасовий файл cookie входу')
    await expect(note).not.toContainText('не використовує файли cookie')
  })

  test('runs under the site CSP without a single violation', async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = []
      ;(window as unknown as { __csp: string[] }).__csp = seen
      document.addEventListener('securitypolicyviolation', (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`))
    })
    const response = await page.goto('/')
    // The same string as deploy/Caddyfile and vite.config.ts (ADR-007); without it this test proves nothing.
    expect(response?.headers()['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    await page.waitForLoadState('networkidle')
    // Everything lazy (the scene chunk, fonts used further down) gets its chance.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(1200)
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  })

  test('a sign-in error that lands on "/" moves to the chat, with a known code only', async ({ page }) => {
    // The chat page asks the API on load; keep it offline: this test is about the landing's hop.
    await page.route('**/api/**', (route) => route.abort())
    const pages: string[] = []
    page.on('request', (request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return
      const url = new URL(request.url())
      pages.push(url.pathname + url.search)
    })
    // Resolve on commit: the landing replaces itself while it is still loading.
    await page.goto('/?auth_error=expired', { waitUntil: 'commit' })
    await expect(page).toHaveURL(/\/chat\/(\?|$)/) // the chat then drops the query itself
    expect(pages).toEqual(['/?auth_error=expired', '/chat/?auth_error=expired'])

    pages.length = 0
    await page.goto('/?auth_error=%3Cscript%3E', { waitUntil: 'commit' })
    await expect(page).toHaveURL(/\/chat\/(\?|$)/)
    expect(pages).toEqual(['/?auth_error=%3Cscript%3E', '/chat/?auth_error=unknown'])
  })

  test('external links open safely', async ({ page }) => {
    await page.goto('/')
    const external = page.locator('a[href^="http"]')
    const count = await external.count()
    for (let i = 0; i < count; i++) {
      const link = external.nth(i)
      await expect(link).toHaveAttribute('rel', /noopener/)
    }
  })
})

test.describe('navigation and keyboard', () => {
  test('skip link is the first tab stop and moves focus to the main content', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard navigation is a desktop concern')
    await page.goto('/')
    await page.keyboard.press('Tab')
    const skip = page.locator('.skip-link')
    await expect(skip).toBeFocused()
    await expect(skip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#main$/)
  })

  test('header links reach their sections', async ({ page }, testInfo) => {
    await page.goto('/')
    // Phones show only «Якщо важко» in the header; wide screens show all four links.
    const links = page.locator('[data-nav-link]:visible')
    const count = await links.count()
    expect(count).toBeGreaterThanOrEqual(testInfo.project.name === 'desktop' ? 4 : 1)
    for (let i = 0; i < count; i++) {
      const link = links.nth(i)
      const hash = await link.getAttribute('href')
      await link.click()
      await expect(page.locator(hash ?? '#missing')).toBeInViewport({ ratio: 0.2 })
    }
  })

  test('«Якщо важко» lands on the emergency numbers, not only on a heading', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('banner').getByRole('link', { name: /^Якщо важко/ }).click()
    await expect(page).toHaveURL(/#safety$/)
    for (const number of ['112', '103']) {
      await expect(page.locator(`#safety a[href="tel:${number}"]`)).toBeInViewport({ ratio: 1 })
    }
  })

  test('«Якщо важко» lands on the numbers on a low laptop and a low phone too', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'one browser per form factor is enough')
    const low = testInfo.project.name === 'desktop' ? { width: 1366, height: 768 } : { width: 393, height: 659 }
    await page.setViewportSize(low)
    await page.goto('/')
    await page.getByRole('banner').getByRole('link', { name: /^Якщо важко/ }).click()
    for (const number of ['112', '103']) {
      await expect(page.locator(`#safety a[href="tel:${number}"]`)).toBeInViewport({ ratio: 1 })
    }
  })

  test('the chapter in the middle is marked in the header and in the HUD', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the pill and the HUD are wide-screen chrome')
    await page.goto('/')
    const chapters = [
      ['how', '01', 'Як це працює'],
      ['privacy', '04', 'Приватність'],
      ['safety', '05', 'Якщо важко'],
      ['faq', '06', 'Запитання'],
    ] as const
    for (const [id, index, name] of chapters) {
      await centre(page, `#${id}`)
      await expect(page.locator(`[data-nav-link][href="#${id}"]`)).toHaveAttribute('aria-current', 'location')
      await expect(page.locator('[data-nav-link][aria-current]')).toHaveCount(1)
      await expect(page.locator('[data-hud-index]')).toHaveText(index)
      await expect(page.locator('[data-hud-name]')).toHaveText(name) // retries past the decode
      // The crisis link is marked like the current nav item while its chapter is on screen.
      if (id === 'safety') await expect(page.locator('.site-header .help-link')).toHaveCSS('border-top-color', 'rgb(255, 197, 143)')
    }
    // A chapter without a header link clears the mark; the HUD still follows.
    await centre(page, '#diary')
    await expect(page.locator('[data-nav-link][aria-current]')).toHaveCount(0)
    await expect(page.locator('[data-hud-index]')).toHaveText('03')
    await expect(page.locator('[data-hud-name]')).toHaveText('Щоденник')
  })

  test('the example session follows the step in the middle of the screen', async ({ page, isMobile }) => {
    test.skip(isMobile, 'on one column the example comes after the steps and is not dimmed')
    await page.goto('/')
    const transcript = page.locator('[data-transcript]')
    const firstLine = transcript.locator('.said p').first() // data-for="1 2"
    const thesis = transcript.locator('.theses__list li').first() // data-for="3 4"
    const DIM = 'rgb(132, 145, 141)' // --color-text-dim #84918d
    const TEXT = 'rgb(238, 242, 238)' // --color-text #eef2ee
    const LIGHT = 'rgb(255, 197, 143)' // --color-light #ffc58f

    await centre(page, '[data-step="3"]')
    await expect(transcript).toHaveAttribute('data-active-step', '3')
    await expect(page.locator('[data-step][data-current]')).toHaveAttribute('data-step', '3')
    await expect(firstLine).toHaveCSS('color', DIM)
    await expect(thesis).toHaveCSS('color', TEXT)
    await expect(page.locator('[data-step="3"] .step__index')).toHaveCSS('color', LIGHT)
    await expect(page.locator('[data-step="1"] .step__index')).toHaveCSS('color', DIM)
    // Dimmed by colour, never by opacity (contrast stays measurable).
    await expect(transcript.locator('.said').first()).toHaveCSS('opacity', '1')

    await centre(page, '[data-step="1"]')
    await expect(transcript).toHaveAttribute('data-active-step', '1')
    await expect(firstLine).toHaveCSS('color', TEXT)
    await expect(thesis).toHaveCSS('color', DIM)
  })

  test('focus inside a reveal block shows it at once', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard navigation is a desktop concern')
    await page.goto('/')
    // preventScroll: the block stays out of view, so only the focus can reveal it.
    await page.locator('.final__meta .arrow-link').evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }))
    await expect(page.locator('.final__meta')).toHaveCSS('opacity', '1', { timeout: 300 })
  })

  // Progressive enhancement: the hidden start state comes with the observer's first answer, so an
  // observer that never answers (a frozen tab, a print layout, a broken engine) hides nothing.
  test('an IntersectionObserver that never answers hides nothing', async ({ page }) => {
    await page.addInitScript(NO_WEBGL2)
    await page.addInitScript(() => {
      window.IntersectionObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): IntersectionObserverEntry[] {
          return []
        }
      } as unknown as typeof IntersectionObserver
    })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.locator('html')).not.toHaveClass(/\bjs-reveal\b/)
    const waiting = await page.locator('[data-reveal]').evaluateAll((all) =>
      all.filter((element) => getComputedStyle(element).opacity !== '1' || getComputedStyle(element).transform !== 'none').map((element) => element.id || element.className),
    )
    expect(waiting).toEqual([])
  })

  test('once the observer answers, what is below the fold waits for the scroll (without fading out to it) and then comes in', async ({ page }) => {
    await page.addInitScript(NO_WEBGL2)
    // Every transition a reveal block starts: none before a scroll — the start state comes in one frame.
    await page.addInitScript(() => {
      const runs: string[] = []
      ;(window as unknown as { __runs: string[] }).__runs = runs
      document.addEventListener(
        'transitionrun',
        (event) => {
          if (event.target instanceof Element && event.target.matches('[data-reveal]')) runs.push(`${event.target.id || event.target.className}:${event.propertyName}`)
        },
        true,
      )
    })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on')
    await expect(page.locator('html')).toHaveClass(/\bjs-reveal\b/)
    await expect(page.locator('html')).not.toHaveClass(/js-reveal-start/)
    const title = page.locator('#faq-title')
    await expect(title).not.toHaveClass(/is-visible/)
    await expect(title).toHaveCSS('opacity', '0')
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as unknown as { __runs: string[] }).__runs)).toEqual([])
    await title.scrollIntoViewIfNeeded()
    await expect(title).toHaveClass(/is-visible/)
    await expect(title).toHaveCSS('opacity', '1')
  })

  test('faq answers open and close', async ({ page }) => {
    await page.goto('/')
    const first = page.locator('#faq details').first()
    await first.locator('summary').click()
    await expect(first).toHaveAttribute('open', '')
    await first.locator('summary').click()
    await expect(first).not.toHaveAttribute('open', '')
  })
})

test.describe('layout', () => {
  test('nothing runs past the screen edge at this viewport', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    expect(await cutOffAtEdges(page)).toEqual([])
  })

  test('the hero light stands beside the title, never on its letters', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the wide layout; one browser is enough')
    // The title lies under the WebGL canvas: light over its glyphs would take their contrast away.
    for (const [width, height] of [
      [1440, 900],
      [1366, 768],
      [1280, 720],
      [1024, 768],
      [1920, 1080],
    ]) {
      await page.setViewportSize({ width, height })
      await page.goto('/')
      await page.evaluate(() => document.fonts.ready)
      await expect
        .poll(() =>
          page.evaluate(() => {
            const range = document.createRange()
            let right = 0
            for (const line of Array.from(document.querySelectorAll('.hero__title .display__line'))) {
              range.selectNodeContents(line)
              right = Math.max(right, range.getBoundingClientRect().right)
            }
            const orb = document.querySelector('.hero__orb')!.getBoundingClientRect()
            return Math.round(orb.left - right)
          }),
        )
        .toBeGreaterThanOrEqual(16)
    }
  })

  test('the light opens the chat, out of the tab order and the accessibility tree', async ({ page }, testInfo) => {
    await page.goto('/')
    const link = page.locator('.hero a.hero__orb-link')
    await expect(link).toHaveCount(1)
    await expect(link).toHaveAttribute('href', '/chat/')
    await expect(link).toHaveAttribute('tabindex', '-1')
    await expect(link).toHaveAttribute('aria-hidden', 'true')
    // The same circle as the light (both read --light-x/-y/-d).
    await page.evaluate(() => document.fonts.ready)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const light = document.querySelector('.hero__orb')!.getBoundingClientRect()
          const hit = document.querySelector('.hero__orb-link')!.getBoundingClientRect()
          return Math.max(...(['left', 'top', 'width', 'height'] as const).map((side) => Math.abs(light[side] - hit[side])))
        }),
      )
      .toBeLessThanOrEqual(1)
    // On the wide layout the light stands clear of the text: its centre takes the click.
    if (testInfo.project.name !== 'desktop') return
    const target = await link.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('a')?.className ?? null
    })
    expect(target).toBe('hero__orb-link')
  })

  test('largest contentful paint is text, not the scene', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'LCP entries are Chromium-only')
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const lcp = await page.evaluate(
      () =>
        new Promise<{ tag: string; time: number }>((resolve) => {
          new PerformanceObserver((list) => {
            const entries = list.getEntries() as (PerformanceEntry & { element?: Element })[]
            const last = entries[entries.length - 1]
            resolve({ tag: last?.element?.tagName ?? 'none', time: last?.startTime ?? -1 })
          }).observe({ type: 'largest-contentful-paint', buffered: true })
        }),
    )
    expect(['H1', 'P', 'SPAN', 'DIV', 'STRONG', 'EM']).toContain(lcp.tag)
    expect(lcp.time).toBeLessThan(2500)
  })
})

test.describe('reflow at 320 CSS px (WCAG 1.4.10)', () => {
  test.use({ viewport: { width: 320, height: 640 } })

  test('nothing is cut off at 320 px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'one engine is enough for reflow')
    // The same layout as with motion (reveal and decode touch only opacity, transform and glyphs of
    // the same width), but without WebGL: one GPU page less in the suite.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await page.evaluate(async () => {
      document.querySelectorAll('details').forEach((item) => ((item as HTMLDetailsElement).open = true))
      await document.fonts.ready
    })
    expect(await cutOffAtEdges(page)).toEqual([])
    const toggle = await page.locator('.motion-toggle').boundingBox()
    expect((toggle?.x ?? 0) + (toggle?.width ?? 0)).toBeLessThanOrEqual(320)
  })
})

test.describe('layers', () => {
  test('paint order: hero title < light < vignette < reading text < chrome', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'same CSS as Chromium; WebKit here renders WebGL on the CPU')
    await page.goto('/')

    // Real hit testing first: the fade under the header must not swallow clicks just below it.
    const fadeIsClickThrough = await page.evaluate(() => {
      const bottom = document.querySelector('.site-header')!.getBoundingClientRect().bottom
      const hit = document.elementFromPoint(8, bottom + 12)
      return hit !== null && hit.closest('.site-header') === null
    })
    expect(fadeIsClickThrough).toBe(true)

    // elementsFromPoint skips pointer-events: none; let the decorative layers be hit in this test only.
    // Through CSSOM, not a <style> tag: the site CSP (style-src 'self') blocks inline style elements.
    await page
      .locator('.scene, .vignette')
      .evaluateAll((layers) => layers.forEach((layer) => (layer as HTMLElement).style.setProperty('pointer-events', 'auto', 'important')))
    const stackAt = (selector: string): Promise<{ target: number; canvas: number; vignette: number }> =>
      page
        .locator(selector)
        .first()
        .evaluate((target) => {
          target.scrollIntoView({ block: 'center', behavior: 'instant' })
          const box = target.getBoundingClientRect()
          const stack = document.elementsFromPoint(box.left + Math.min(box.width / 2, 24), box.top + box.height / 2)
          return {
            target: stack.findIndex((element) => target.contains(element)),
            canvas: stack.findIndex((element) => element.matches('.scene')),
            vignette: stack.findIndex((element) => element.matches('.vignette')),
          }
        })

    const title = await stackAt('#hero-title')
    expect(title.target).toBeGreaterThanOrEqual(0)
    expect(title.canvas).toBeGreaterThanOrEqual(0)
    expect(title.canvas).toBeLessThan(title.target) // the light is drawn over the hero title

    const reading = [
      '.hero__lead',
      ...SECTION_IDS.filter((id) => id !== 'hero').map((id) => `#${id}-title`), // every chapter
      '#how .lead',
      '#safety .help__number',
      '#faq summary',
      '.site-footer__note p',
      '.help-link',
    ]
    for (const selector of reading) {
      const at = await stackAt(selector)
      expect(at.target, selector).toBeGreaterThanOrEqual(0)
      expect(at.target, selector).toBeLessThan(at.vignette) // text over the vignette…
      expect(at.vignette, selector).toBeLessThan(at.canvas) // …which is over the light
    }
  })

  test('decoded labels end on their real text and keep it for screen readers', async ({ page }) => {
    await page.goto('/')
    const tag = page.locator('.hero__tag')
    const spoken = tag.locator('.visually-hidden')
    await expect(spoken).toHaveText('Саморефлексія з AI') // waits for the label to be split
    await expect(spoken).toHaveCount(1)
    await expect
      .poll(
        () =>
          tag.evaluate((node) =>
            Array.from(node.querySelectorAll('[aria-hidden="true"]'))
              .map((part) => part.textContent ?? '')
              .join('')
              .trim(),
          ),
        { timeout: 5_000 },
      )
      .toBe('Саморефлексія з AI')
  })

  test('with reduced motion labels are left as they are (no decode, no duplicates)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    // Two frames: an IntersectionObserver callback would have run by now.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const tag = page.locator('.hero__tag')
    await expect(tag.locator('.visually-hidden')).toHaveCount(0)
    await expect(tag).toHaveText('Саморефлексія з AI')
    // Nothing waits for a scroll to appear.
    const waiting = await page.locator('[data-reveal]').evaluateAll((all) => all.filter((element) => getComputedStyle(element).opacity !== '1').length)
    expect(waiting).toBe(0)
  })

  test('filled buttons stay sharp when the WebGL scene is on', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    // Exercise the GL-specific cascade without starting a GPU context.
    await page.evaluate(() => (document.documentElement.dataset.gl = 'on'))
    for (const selector of ['.hero .cta', '.final .cta', '.final .cta span', '.final__title']) {
      await expect(page.locator(selector)).toHaveCSS('text-shadow', 'none')
    }
    await expect(page.locator('.stage__haze--teal')).toBeHidden()
    await expect(page.locator('.stage__grain')).toBeHidden()
  })

  test('the pause button is visible and named on every screen', async ({ page }) => {
    await page.goto('/')
    const toggle = page.locator('[data-motion-toggle]')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAccessibleName('Пауза анімації')
  })

  test('the example session says who is speaking', async ({ page }) => {
    await page.goto('/')
    const speakers = await page.locator('.said__who').allTextContents()
    expect(speakers).toEqual(['Ви', 'AI', 'Ви', 'AI'])
  })
})

test.describe('accessibility', () => {
  test('axe finds no WCAG 2.2 AA violations', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Reveal-on-scroll content must be checked in its final state: show it and finish the fades.
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-reveal]'))
      items.forEach((element) => element.classList.add('is-visible'))
      for (const element of items) for (const animation of element.getAnimations()) animation.finish()
    })
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
    expect(summary).toEqual([])
  })
})
