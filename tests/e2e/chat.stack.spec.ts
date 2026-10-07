// /chat/ against the real stack (spec §11.8): the local compose stack of liora-app/devops with
// LLM_PROVIDER=fake, served at http://localhost:8088 (not 127.0.0.1: the CSRF check compares the
// origin verbatim). Never in CI and never against production: every test is tagged @stack and skips
// itself unless E2E_STACK=1 and the base URL is exactly http://localhost:8088.
//
//   PowerShell: $env:E2E_BASE_URL='http://localhost:8088'; $env:E2E_STACK='1'; npx playwright test tests/e2e/chat.stack.spec.ts --project=desktop --workers=1 --grep "@stack" --grep-invert "@gpu"
//   bash:       E2E_BASE_URL=http://localhost:8088 E2E_STACK=1 npx playwright test tests/e2e/chat.stack.spec.ts --project=desktop --workers=1 --grep @stack --grep-invert @gpu
//
// Sign-in: POST /api/v1/auth/dev with a fresh synthetic email per test (20 turns a minute per user,
// one LLM slot); page.request shares its cookie store with the page. The consent goes through the
// UI, so the page sets Origin itself. Synthetic data only.

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { NO_WEBGL2 } from './helpers'
import { PAUSED, aiMessages, answered, composer, onScreen, send, toReview } from './chat-fixtures'

// No @types/node in this repo (no new dependencies): only what this file reads.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> }

const STACK_URL = 'http://localhost:8088'
const STACK = { tag: '@stack' }
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
/** server/app/llm (LLM_PROVIDER=fake): the turn streams this sentence word by word. */
const FAKE_REPLY = 'Дякую, що поділилися. Що в цій ситуації зачепило вас найбільше?'
/** A synthetic phrase from server/tests/test_crisis.py: the keyword check stops the turn. */
const CRISIS_PHRASE = 'Я не хочу жити.'

test.describe.configure({ mode: 'serial' })
test.skip(
  ({ baseURL }) => process.env.E2E_STACK !== '1' || baseURL !== STACK_URL,
  'needs the local compose stack: E2E_STACK=1 and E2E_BASE_URL=http://localhost:8088',
)

/** CSP violations, collected from the first script on (no inline script: an init script). */
function cspProbe(): void {
  const seen: string[] = []
  ;(window as unknown as { __csp: string[] }).__csp = seen
  document.addEventListener('securitypolicyviolation', (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`))
}

async function signIn(page: Page, testInfo: TestInfo): Promise<string> {
  await page.addInitScript(NO_WEBGL2)
  await page.addInitScript(cspProbe)
  const email = `e2e-${testInfo.workerIndex}-${Date.now()}@example.com`
  const response = await page.request.post('/api/v1/auth/dev', { data: { email } })
  expect(response.status()).toBe(200)
  return email
}

/** The consent screen through the UI: the real provider and country, then all three boxes. */
async function consentThroughUi(page: Page): Promise<void> {
  const state = (await (await page.request.get('/api/v1/consents')).json()) as { llm_provider: { name: string } | null }
  await page.goto('/chat/')
  await onScreen(page, 'consent')
  expect(state.llm_provider).not.toBeNull()
  await expect(page.locator('[data-screen="consent"] [data-el="provider"]').first()).toHaveText(state.llm_provider!.name)
  await expect(page.locator('[data-screen="consent"] [data-el="country"]').first()).not.toHaveText('')
  for (const kind of ['data_processing', 'llm_transfer', 'age_18']) await page.locator(`input[data-kind="${kind}"]`).check()
  await page.getByRole('button', { name: 'Погоджуюся — почати' }).click()
  await onScreen(page, 'chat')
}

async function noViolations(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([])
}

test('S1 the happy path through the UI: consent, a streamed fake answer, theses edited and saved', STACK, async ({ page }, testInfo) => {
  await signIn(page, testInfo)
  await consentThroughUi(page)
  await send(page, 'Синтетичне повідомлення для перевірки стеку.')
  await answered(page, 1)
  await expect(aiMessages(page).nth(1).locator('.said__text')).toHaveText(FAKE_REPLY)
  await toReview(page)
  await expect(page.locator('[data-el="review-title"]')).toHaveValue('Розмова про день')
  await expect(page.locator('.thesis__input')).toHaveCount(3)
  const edited = 'Синтетична виправлена теза.'
  await page.locator('.thesis__input').first().fill(edited)
  await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
  await onScreen(page, 'saved')
  const saved = await (await page.request.get('/api/v1/summaries')).text()
  expect(saved).toContain(edited)
  await noViolations(page)
})

test('S2 a keyword crisis for real: the crisis screen, no field, no paused number', STACK, async ({ page }, testInfo) => {
  await signIn(page, testInfo)
  await consentThroughUi(page)
  await send(page, CRISIS_PHRASE)
  await onScreen(page, 'crisis')
  await expect(page.locator('textarea')).toHaveCount(0)
  expect((await page.evaluate(() => document.documentElement.outerHTML)).includes(PAUSED)).toBe(false)
  await noViolations(page)
})

test('S3 «Повернення до теми» with a saved record: the turn with the chosen record answers 200', STACK, async ({ page, baseURL }, testInfo) => {
  await signIn(page, testInfo)
  await consentThroughUi(page)
  // A record to return to, written the way the page would (Origin for the CSRF check).
  const created = await page.request.post('/api/v1/summaries', {
    headers: { Origin: baseURL! },
    data: { scenario: 'free', title: 'Синтетичний запис стеку', bullets: ['Синтетична теза.'], tags: [{ name: 'робота', source: 'user' }] },
  })
  expect(created.status()).toBe(201)
  await page.reload()
  await onScreen(page, 'chat')
  await page.locator('[data-el="scenario-list"]').getByRole('radio', { name: 'Повернення до теми' }).check()
  await page.locator('[data-el="revisit-open"]').click()
  const dialog = page.locator('#pick-dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('.pick__input').first().check()
  await dialog.getByRole('button', { name: 'Продовжити (1)' }).click()
  const turn = page.waitForResponse((response) => response.url().endsWith('/api/v1/chat/turn'))
  await send(page, 'Що змінилося відтоді?')
  expect((await turn).status()).toBe(200)
  await answered(page, 1)
  await noViolations(page)
})

test('S4 deleting the account through the UI ends the session', STACK, async ({ page }, testInfo) => {
  await signIn(page, testInfo)
  await consentThroughUi(page)
  await page.locator('.account-toggle').click()
  await page.locator('#account-dialog').getByRole('button', { name: 'Видалити акаунт…' }).click()
  await page.locator('#confirm-dialog').getByRole('button', { name: 'Так, видалити все' }).click()
  await onScreen(page, 'account-deleted')
  expect((await page.request.get('/api/v1/me')).status()).toBe(401)
  await expect(composer(page)).toHaveCount(0)
})

test('S5 live headers: the one CSP on / and /chat/, no-store on /chat/, Permissions-Policy, no violations', STACK, async ({ page, request }, testInfo) => {
  const chat = await request.get('/chat/')
  expect(chat.headers()['content-security-policy']).toBe(CSP)
  expect(chat.headers()['cache-control']).toBe('no-store')
  expect(chat.headers()['permissions-policy']).toBeTruthy()
  const landing = await request.get('/')
  expect(landing.headers()['content-security-policy']).toBe(CSP)
  expect(landing.headers()['permissions-policy']).toBeTruthy()
  await signIn(page, testInfo)
  // POST /consents from the page itself: it must not meet csrf_failed (consentThroughUi reaches chat).
  await consentThroughUi(page)
  await noViolations(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await noViolations(page)
})
