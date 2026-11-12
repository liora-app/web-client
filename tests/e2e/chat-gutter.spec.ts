// /chat/ with a classic scrollbar, against the same mocked API as chat.spec.ts (chat-fixtures.ts: no
// WebGL, the page keeps its static light; the same audit after every test). The page keeps its gutter
// (scrollbar-gutter: stable) — what a desktop browser in a half-screen window or at a 200 % zoom shows.
// Playwright starts a headless Chromium with --hide-scrollbars, yet Chromium 153 draws a classic
// scrollbar all the same: on Windows (probed, 15 px) and on CI's Linux (html[data-gutter] in a failed
// run's log), so chat.spec.ts's desktop tests take this branch too. This file leaves the flag out
// anyway: it stays a page with a gutter should a later Chromium honour the flag again. A launch option
// forces a worker of its own, so it lives in a file of its own (Playwright allows it only at the top
// level).

import type { Locator, Page, TestInfo } from '@playwright/test'
import { confirmDialog, expect, openChat, test } from './chat-fixtures'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

// ADR-013: the page stands on the sky (--color-bg: its top stop by day, the night), and a sheet that
// covers the window is opaque glass (--color-sheet-solid), no longer the page's own colour: the root
// takes the sheet's tone while it covers the window, the scrim's where the scrim is in view.
const SKY_TOP = 'rgb(126, 199, 185)' // --color-bg, light
const NIGHT = 'rgb(19, 36, 64)' // --color-bg, dark
const SHEET_L = 'rgb(255, 253, 245)' // --color-sheet-solid, light
const SHEET_D = 'rgb(19, 36, 64)' // --color-sheet-solid, dark
const isDesktop = (testInfo: TestInfo): boolean => testInfo.project.name === 'desktop'
const accountToggle = (page: Page): Locator => page.locator('.account-toggle')
const accountSheet = (page: Page): Locator => page.locator('#account-dialog')
const breatheDialog = (page: Page): Locator => page.locator('#breathe-dialog')

async function openTool(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Інструменти' }).click()
  const item = page.locator('#composer-tools').getByRole('button', { name })
  await expect(item).toBeVisible()
  await item.click()
}

test.describe('a classic scrollbar', () => {
  test('#129 the gutter takes the scrim’s colour only where the scrim is in view: beside a confirm, beside a centred sheet from 48em — not beside a sheet that covers the window', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'a phone has overlay scrollbars')
    const look = () =>
      page.evaluate(() => ({
        gutter: document.documentElement.hasAttribute('data-gutter'),
        root: getComputedStyle(document.documentElement).backgroundColor,
        bar: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content,
      }))
    const beside = (root: string) => ({ gutter: true, root, bar: root })
    const help = page.locator('#help-dialog')
    for (const scheme of ['dark', 'light'] as const) {
      const [own, sheet, scrim] = scheme === 'dark' ? [NIGHT, SHEET_D, 'rgb(8, 16, 27)'] : [SKY_TOP, SHEET_L, 'rgb(95, 156, 147)']
      await page.emulateMedia({ colorScheme: scheme })
      // Under 48em — a window on half a screen, a 200 % zoom: every sheet covers the window, its scrim
      // out of sight. The gutter kept the scrim's colour there: a strip down the window's right edge.
      await page.setViewportSize({ width: 720, height: 900 })
      await openChat(page)
      expect((await look()).gutter, 'a classic scrollbar keeps its gutter').toBe(true)
      await page.locator('.help-link').click()
      await expect(help).toBeVisible()
      await expect.poll(look).toEqual(beside(sheet))
      await page.keyboard.press('Escape')
      await expect(help).toBeHidden()
      await openTool(page, 'Подихати хвилину')
      await expect(breatheDialog(page)).toBeVisible()
      await expect.poll(look).toEqual(beside(sheet))
      await page.keyboard.press('Escape')
      await expect(breatheDialog(page)).toBeHidden()
      // «Акаунт» covers it too; a confirm over it, a bottom sheet here, leaves its scrim in view — and
      // the browser's bar follows the root there as well (it kept the sheet's colour).
      await accountToggle(page).click()
      await expect(accountSheet(page)).toBeVisible()
      await expect.poll(look).toEqual(beside(sheet))
      await accountSheet(page).getByRole('button', { name: 'Видалити акаунт…' }).click()
      await expect(confirmDialog(page)).toBeVisible()
      await expect.poll(look).toEqual(beside(scrim))
      await confirmDialog(page).getByRole('button', { name: 'Скасувати', exact: true }).click()
      await expect(confirmDialog(page)).toBeHidden()
      await expect.poll(look).toEqual(beside(sheet))
      await page.keyboard.press('Escape')
      await expect(accountSheet(page)).toBeHidden()
      await expect.poll(look).toEqual(beside(own))
      // From 48em «Якщо важко» is centred: the scrim beside it, and the gutter in its colour.
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.locator('.help-link').click()
      await expect(help).toBeVisible()
      await expect.poll(look).toEqual(beside(scrim))
      await page.keyboard.press('Escape')
      await expect(help).toBeHidden()
      await expect.poll(look).toEqual(beside(own))
    }
  })
})
