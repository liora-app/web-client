import { expect, test } from '@playwright/test'
import { answered, MockApi, send } from './chat-fixtures'
import { NO_WEBGL2 } from './helpers'

const APP = 'https://app.tryliora.duckdns.org/'
const LANDING = 'https://tryliora.duckdns.org/'

test('the hosted chat logo reaches the landing both directly and after confirming exit', async ({ page, baseURL }) => {
  const api = new MockApi()
  await page.addInitScript(NO_WEBGL2)
  await page.route(`${APP}**`, async (route) => {
    const request = new URL(route.request().url())
    if (request.pathname.startsWith('/api/v1/')) return api.handle(route)

    // Reproduce the public routing on the local build. On the app host, / serves /chat/index.html.
    const asset = new URL(baseURL!)
    asset.pathname = request.pathname === '/' ? '/chat/' : request.pathname
    asset.search = request.search
    await route.fulfill({ response: await route.fetch({ url: asset.href }) })
  })
  await page.route(LANDING, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Liora</h1>' }))

  const logo = page.locator('.chat-header .brand')
  await page.goto(APP)
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'chat')
  await expect(logo).toHaveAttribute('href', LANDING)
  await logo.click()
  await expect(page).toHaveURL(LANDING)

  await page.goto(APP)
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'chat')
  await send(page, 'Синтетичне повідомлення для перевірки виходу.')
  await answered(page, 1)
  await logo.click()
  const confirmation = page.locator('dialog.confirm[open]')
  await expect(confirmation).toBeVisible()
  await expect(page).toHaveURL(APP)
  await confirmation.getByRole('button', { name: 'Піти', exact: true }).click()
  await expect(page).toHaveURL(LANDING)
  expect(api.unexpected).toEqual([])
})
