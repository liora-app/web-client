// /chat/ against a mocked API (spec §11.4): page.route answers /api/v1/** with synthetic data, a fetch
// shim writes streamed turns chunk by chunk, page.clock drives the timers. Runs headless in CI on the
// desktop and mobile projects (no GPU: the page keeps its static light, see chat-fixtures.ts).
// Every test also passes the audit of chat-fixtures.ts: no CSP violation, no console problem, no
// paused hotline number and no server message in the DOM, no request to another origin.

import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { uiError } from '../../src/chat/core/errors'
import { FALLBACK_ABROAD, FALLBACK_MESSAGE, PAUSED_LINE_NOTE } from '../../src/chat/core/helplines'
import type { AuthCode } from '../../src/chat/core/state'
import {
  BUSY_NOW,
  CONSENT_UNCHECKED,
  COOLDOWN_OVER,
  COPY_FAILED_LABEL,
  CSRF_FIRST,
  CSRF_RELOAD,
  DRAFT_TEXT,
  GENERIC,
  LIMIT_BLOCK,
  LONG_CONVERSATION,
  NEED_RECORDS,
  REVISIT_EMPTY,
  REVISIT_GONE_BLOCK,
  SERVER_DOWN,
  TOO_LARGE_BLOCK,
  accountOpError,
  copyFailed,
  saveError,
  scenarioAbout,
  signInBanner,
  stillSignedIn,
  summarizeError,
  turnError,
} from '../../src/chat/ui/copy'
import {
  CONSENTS_NONE,
  CONSENTS_OK,
  DRAFT,
  EMAIL,
  FORBIDDEN,
  KINDS,
  ME,
  PAUSED,
  RAW_HELPLINES,
  REPLY,
  REPLY_TEXT,
  SAFE_LINES,
  SCENARIOS,
  VERSION,
  aiMessages,
  announced,
  answered,
  axe,
  beforeUnload,
  busyLog,
  clinicalOffenders,
  composer,
  confirmDialog,
  consents,
  crisis,
  diary,
  done,
  exchange,
  expect,
  fail,
  gate,
  html,
  lastUser,
  meta,
  onScreen,
  openChat,
  ping,
  record,
  reply,
  send,
  sendButton,
  sse,
  storageAudit,
  storedFrom,
  streamError,
  streamTurns,
  talk,
  test,
  toReview,
  token,
  userMessages,
} from './chat-fixtures'
import { cutOffAtEdges } from './helpers'

type Msg = { role: string; content: string }
type TurnBody = { scenario: string; messages: Msg[]; revisit_summary_ids?: string[] }

const USER = 'Синтетичне повідомлення: цього тижня я відкладаю одну розмову з колегою.'
const CRISIS_TEXT = 'Синтетична фраза, на яку сервер відповідає кризою.'
/** Words that must never reach the page once the turn ended in anything but `done` (I3). */
const PARTIAL = ['токен-альфа ', 'токен-бета ', 'токен-гамма ', 'токен-дельта ']
const RECORDS = [1, 2, 3, 4, 5, 6].map((i) => record(i))
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
/** details[].message of a mocked 422 (never shown either). */
const SERVER_MESSAGE_SHORT = 'Synthetic validation detail'
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
const GPU = { tag: '@gpu' }

/** The line under an unsent message for this error code (src/chat/ui/copy.ts). */
const why = (code: string, revisit = false): string => turnError(uiError(code), 0, null, revisit).why
const isDesktop = (testInfo: TestInfo): boolean => testInfo.project.name === 'desktop'
const turnBodies = (bodies: unknown[]): TurnBody[] => bodies as TurnBody[]
const firstMessage = (page: Page): Locator => aiMessages(page).first().locator('.said__text')
const announcer = (page: Page): Locator => page.locator('[data-announcer]')
const scenarioList = (page: Page): Locator => page.locator('[data-el="scenario-list"]')
const accountToggle = (page: Page): Locator => page.locator('.account-toggle')
const accountSheet = (page: Page): Locator => page.locator('#account-dialog')
const pickDialog = (page: Page): Locator => page.locator('#pick-dialog')
const markup = (page: Page): Promise<string> => page.evaluate(() => document.documentElement.outerHTML)

/** The two valid synthetic lines of RAW_HELPLINES, and nothing else. */
async function expectSafeLines(list: Locator): Promise<void> {
  await expect(list.locator('.line__name')).toHaveText(SAFE_LINES.map((line) => line.name))
  await expect(list.locator('.line__phone')).toHaveText(SAFE_LINES.map((line) => line.phone))
  for (const [i, line] of SAFE_LINES.entries()) await expect(list.locator('.line__phone').nth(i)).toHaveAttribute('href', line.tel)
  await expect(list.locator('.line__hours').first()).toContainText('безкоштовно')
  // free: null says nothing about cost.
  await expect(list.locator('.line__hours').nth(1)).not.toContainText('безкоштовно')
}

/** The crisis takeover (spec §6, tests #5, #6, #13). */
async function expectCrisis(page: Page, said: string | null, testInfo: TestInfo): Promise<void> {
  await onScreen(page, 'crisis')
  const screen = page.locator('section[data-screen="crisis"]')
  await expect(page.locator('textarea')).toHaveCount(0)
  await expect(page.locator('#crisis-title')).toBeFocused()
  await expect(screen.locator('a.help__number[href="tel:112"]')).toHaveCount(1)
  await expect(screen.locator('a.help__number[href="tel:103"]')).toHaveCount(1)
  await expect(screen.locator('a[href="https://howareu.com/hot-lines"]')).toHaveCount(1)
  await expect(screen.locator('a[href*="evil"]')).toHaveCount(0)
  await expect(page.locator('[data-el="crisis-lead"]')).toHaveText(FALLBACK_MESSAGE)
  await expect(page.locator('[data-el="crisis-abroad"]')).toHaveText(FALLBACK_ABROAD)
  await expectSafeLines(page.locator('[data-el="crisis-lines"]'))
  const details = page.locator('[data-el="crisis-details"]')
  await expect(details).not.toHaveAttribute('open')
  if (said !== null) await expect(details.locator('[data-el="crisis-talk"]')).toContainText(said)
  if (testInfo.project.name === 'mobile') {
    // 412 × 839: both numbers on the first screen, without scrolling.
    for (const number of ['112', '103']) await expect(screen.locator(`a.help__number[href="tel:${number}"]`)).toBeInViewport({ ratio: 1 })
  }
  await expect(page.locator('.presence')).toHaveAttribute('data-presence', 'quiet')
  await expect(html(page)).not.toHaveAttribute('data-sound', 'on')
}

/** A conversation in «Повернення до теми» with the given records chosen in the picker. */
async function chooseRecords(page: Page, indices: readonly number[]): Promise<void> {
  await scenarioList(page).getByRole('radio', { name: 'Повернення до теми' }).check()
  await page.locator('[data-el="revisit-open"]').click()
  const dialog = pickDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.pick__input')).not.toHaveCount(0)
  for (const i of indices) await dialog.locator('.pick__input').nth(i).check()
  await dialog.getByRole('button', { name: `Продовжити (${indices.length})` }).click()
  await expect(dialog).toBeHidden()
}

/** «Скопіювати текст розмови» puts the unsent message into the clipboard, marked (spec §3.8, #8b). */
async function expectCopied(page: Page, context: BrowserContext, button: Locator): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await button.click()
  await expect(button).toHaveText('Скопійовано')
  // A changed name of the focused button is not announced: the live region says it (WCAG 4.1.3).
  await expect(announcer(page)).toHaveText('Скопійовано')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`Ви (не надіслано): ${USER}`)
}

async function endWithoutTheses(page: Page): Promise<void> {
  await page.locator('[data-el="session-end"]').click()
  const confirm = confirmDialog(page)
  await confirm.getByRole('button', { name: 'Завершити без тез' }).click()
  await confirm.getByRole('button', { name: 'Завершити', exact: true }).click()
  await onScreen(page, 'ended')
}

// ── The turn and its stream ──────────────────────────────────────────────────────────────────

test.describe('turn', () => {
  test('#1 ★ a normal turn: the joined tokens, one announcement, the request body and headers', async ({ page, api, baseURL, consoleLines }, testInfo) => {
    await openChat(page)
    // Enter on a fine pointer (desktop); the button where Enter is a new line (phone).
    await send(page, USER, isDesktop(testInfo) ? 'enter' : 'button')
    await answered(page, 1)
    await expect(aiMessages(page).nth(1).locator('.said__text')).toHaveText(REPLY_TEXT)
    await expect(aiMessages(page).nth(1).locator('.said__who')).toHaveText('AI')

    expect(api.count('POST /chat/turn')).toBe(1)
    const [call] = api.of('POST /chat/turn')
    const body = call!.body as TurnBody
    // The scenario and the messages, nothing else: no timezone, no revisit ids outside revisit.
    expect(Object.keys(body).sort()).toEqual(['messages', 'scenario'])
    expect(body.scenario).toBe('free')
    expect(body.messages).toEqual([
      { role: 'assistant', content: SCENARIOS[0].opening_message },
      { role: 'user', content: USER },
    ])
    const headers = await call!.request.allHeaders()
    expect(headers['origin']).toBe(new URL(baseURL!).origin)
    expect(headers['content-type']).toBe('application/json')

    // The answer's slot is busy while it streams, then not.
    const busy = await busyLog(page)
    expect(busy[0]).toBe('true')
    expect(busy.at(-1)).toBe('false')
    // The live region says the answer once («AI думає…» may come first on a slow runner).
    const said = (await announced(page)).filter((text) => text !== '')
    expect(said.filter((text) => text === `Відповідь AI: ${REPLY_TEXT}`)).toHaveLength(1)
    expect(said.length).toBeLessThanOrEqual(2)

    if (isDesktop(testInfo)) await expect(composer(page)).toBeFocused()
    await storageAudit(page, USER, consoleLines)
  })

  test('#2b the paused number in a reply: masked while it streams split across tokens, in the history and in the live region', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    const reply = aiMessages(page).nth(1).locator('.said__text')
    // Two tokens in: three digits, which are not the number yet.
    await stream.write(meta() + token(`Можна подзвонити на ${PAUSED.slice(0, 1)}`) + token(`${PAUSED.slice(1, 2)} ${PAUSED.slice(2, 3)}`))
    await expect(reply).toHaveText(`Можна подзвонити на ${PAUSED.slice(0, 2)} ${PAUSED.slice(2, 3)}`)
    // The last digit comes in its own token: the answer so far is masked as a whole.
    await stream.write(token(`${PAUSED.slice(3)}, але найперше — 112.`))
    const masked = `Можна подзвонити на ${PAUSED_LINE_NOTE}, але найперше — 112.`
    await expect(reply).toHaveText(masked)
    expect((await markup(page)).includes(PAUSED)).toBe(false)
    await stream.write(done())
    await answered(page, 1)
    await expect(reply).toHaveText(masked)
    await expect.poll(async () => (await announced(page)).includes(`Відповідь AI: ${masked}`)).toBe(true)
    expect((await announced(page)).some((text) => text.includes(PAUSED))).toBe(false)
  })

  test('#2 ★ «: ping» before meta, between tokens and before done changes nothing', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: sse(ping(), meta(), ping(), token(REPLY[0]!), ping(), token(REPLY[1]!), token(REPLY[2]!), ping(), done()) })
    await openChat(page)
    await send(page, USER)
    await answered(page, 1)
    await expect(aiMessages(page).nth(1).locator('.said__text')).toHaveText(REPLY_TEXT)
    await expect(page.locator('body')).not.toContainText('ping')
  })

  test('#3 ★ frames cut between chunks: inside «event:», inside the JSON, inside a Cyrillic letter, between \\r and \\n', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)

    const text = sse(meta(), ...REPLY.map(token), done()).replace(/\n/g, '\r\n')
    const byteAt = (chars: number): number => new TextEncoder().encode(text.slice(0, chars)).length
    const firstToken = text.indexOf('event: token')
    const json = text.indexOf('"text"', firstToken)
    const letter = text.slice(json).search(/[А-Яа-яЄєІіЇїҐґ]/) + json
    const lineEnd = text.indexOf('\r\n', letter)
    const cuts = [byteAt(firstToken) + 3, byteAt(json) + 3, byteAt(letter) + 1, byteAt(lineEnd) + 1]
    expect([...cuts].sort((a, b) => a - b)).toEqual(cuts)
    const bytes = Array.from(new TextEncoder().encode(text))
    let from = 0
    for (const cut of [...cuts, bytes.length]) {
      await stream.bytes(bytes.slice(from, cut))
      from = cut
    }
    await answered(page, 1)
    await expect(aiMessages(page).nth(1).locator('.said__text')).toHaveText(REPLY_TEXT)
    expect(await stream.count()).toBe(1)
  })

  test('#4 ★ a stream that ends without a final event is retried exactly once, with the identical body', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: meta() + token(PARTIAL[0]!) }, { sse: reply() })
    await openChat(page)
    await send(page, USER)
    await answered(page, 1)
    await expect(aiMessages(page).nth(1).locator('.said__text')).toHaveText(REPLY_TEXT)
    const calls = api.of('POST /chat/turn')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.raw).toBe(calls[0]!.raw)
    expect((await markup(page)).includes('токен-')).toBe(false)
  })

  test('#4b cut twice: two requests, then «Зʼєднання обірвалося…» and «Надіслати ще раз»', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: meta() + token(PARTIAL[0]!) })
    await openChat(page)
    await send(page, USER)
    const unsent = lastUser(page)
    await expect(unsent.locator('.said__flag')).toHaveText('Не надіслано')
    await expect(unsent.locator('.said__why')).toHaveText(why('truncated'))
    await expect(unsent.getByRole('button', { name: 'Надіслати ще раз' })).toBeVisible()
    expect(api.count('POST /chat/turn')).toBe(2)
    expect((await markup(page)).includes('токен-')).toBe(false)
  })

  test('#7 ★ an error after tokens drops the partial answer and is not retried', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: meta() + PARTIAL.slice(0, 3).map(token).join('') + streamError('llm_failed') })
    await openChat(page)
    await send(page, USER)
    const unsent = lastUser(page)
    await expect(unsent.locator('.said__why')).toHaveText(why('llm_failed'))
    await expect(unsent.getByRole('button', { name: 'Надіслати ще раз' })).toBeVisible()
    await expect(unsent.getByRole('button', { name: 'Змінити' })).toBeVisible()
    await expect(talk(page)).not.toContainText('токен-')
    expect(api.count('POST /chat/turn')).toBe(1)
    await axe(page, 'conversation with an error line')
  })

  test('#18 ★ an empty 502 (and 504) from the gateway reads «Сервер зараз не відповідає…», without an exception', async ({ page, api }) => {
    api.on('POST /chat/turn', { status: 502, body: '' }, { status: 504, body: '' })
    await openChat(page)
    await send(page, USER)
    const unsent = lastUser(page)
    await expect(unsent.locator('.said__why')).toHaveText(SERVER_DOWN)
    await unsent.getByRole('button', { name: 'Надіслати ще раз' }).click()
    await expect.poll(() => api.count('POST /chat/turn')).toBe(2)
    await expect(unsent.locator('.said__why')).toHaveText(SERVER_DOWN)
    await expect(unsent.locator('.said__flag')).toHaveText('Не надіслано')
  })

  test('#18 ★ an empty 502 on GET /me at start: the «no connection» screen', async ({ page, api }) => {
    api.on('GET /me', { status: 502, body: '' })
    await openChat(page, '/chat/', 'fatal')
    await expect(page.locator('[data-el="fatal-online"]')).toBeVisible()
    await axe(page, 'fatal')
  })

  test('#18c «Спробувати ще раз» on the «no connection» screen: <main> holds the focus while it connects (I6)', async ({ page, api }) => {
    const wait = gate()
    api.on('GET /me', { status: 502, body: '' }, async () => {
      await wait.wait
      return { json: ME }
    })
    await openChat(page, '/chat/', 'fatal')
    await page.getByRole('button', { name: 'Спробувати ще раз' }).click()
    await onScreen(page, 'booting')
    await expect(page.locator('main')).toBeFocused()
    wait.open()
    await onScreen(page, 'chat')
  })

  test('#19 a 200 with text/html instead of the stream: the general error line', async ({ page, api }) => {
    api.on('POST /chat/turn', { contentType: 'text/html; charset=utf-8', body: '<!doctype html><p>proxy page</p>' })
    await openChat(page)
    await send(page, USER)
    await expect(lastUser(page).locator('.said__why')).toHaveText(GENERIC)
    expect((await markup(page)).includes('proxy page')).toBe(false)
  })

  test('#20 «Зупинити»: one abort, «Відповідь зупинено», the partial answer gone, no retry', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    await stream.write(meta() + token(PARTIAL[0]!) + token(PARTIAL[1]!))
    await expect(page.locator('.said--streaming')).toHaveCount(1)
    await page.getByRole('button', { name: 'Зупинити відповідь' }).click()
    await expect.poll(async () => (await stream.info()).aborted).toBe(true)
    expect((await stream.info()).reason).toBe('user')
    await expect(lastUser(page).locator('.said__flag')).toHaveText('Відповідь зупинено')
    await expect(lastUser(page).getByRole('button', { name: 'Надіслати ще раз' })).toBeVisible()
    await expect(talk(page)).not.toContainText('токен-')
    await expect(announcer(page)).toHaveText('Відповідь зупинено')
    expect(await stream.count()).toBe(1)
  })

  test('#21 pagehide in the middle of a stream aborts the request', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    await stream.write(meta() + token(PARTIAL[0]!))
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
    await expect.poll(async () => (await stream.info()).aborted).toBe(true)
    expect((await stream.info()).reason).toBe('pagehide')
    await expect(talk(page)).not.toContainText('токен-')
  })

  test('#22 45 s without a byte → one retry; a ping every 15 s keeps the stream alive', async ({ page }) => {
    await page.clock.install()
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    await stream.write(meta())
    for (let i = 0; i < 2; i++) {
      await page.clock.runFor(15_000)
      await stream.write(ping())
    }
    await page.clock.runFor(15_000)
    expect(await stream.count()).toBe(1)
    // 45 s after the last ping.
    await page.clock.runFor(30_000)
    await stream.requests(2)
    expect((await stream.info(1)).body).toBe((await stream.info(0)).body)
    await stream.write(reply())
    await answered(page, 1)
    await expect(aiMessages(page).nth(1).locator('.said__text')).toHaveText(REPLY_TEXT)
  })

  test('#22b a long answer (a token every 2 s for 40 s) is not cut by the 35 s headers timer', async ({ page }) => {
    await page.clock.install()
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    await stream.write(meta())
    const words = Array.from({ length: 20 }, (_, i) => `слово${i + 1} `)
    for (const word of words) {
      await stream.write(token(word))
      await page.clock.runFor(2_000)
    }
    await stream.write(done())
    await answered(page, 1)
    await expect(aiMessages(page).nth(1).locator('.said__text')).toHaveText(words.join(''))
    expect(await stream.count()).toBe(1)
    expect((await stream.info()).aborted).toBe(false)
  })

  test('#23 a second Enter while the answer comes sends nothing; Enter during IME composition does not send', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'Enter sends only on a fine pointer')
    const stream = await streamTurns(page)
    await openChat(page)
    await composer(page).fill('Перше синтетичне повідомлення.')
    await composer(page).press('Enter')
    await stream.requests(1)
    await composer(page).fill('Друге синтетичне повідомлення.')
    await composer(page).press('Enter')
    await expect(composer(page)).toHaveValue('Друге синтетичне повідомлення.')
    expect(await stream.count()).toBe(1)
    await stream.write(reply())
    await answered(page, 1)
    // An IME is still composing: its Enter picks a candidate, it does not send.
    await composer(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await expect(composer(page)).toHaveValue('Друге синтетичне повідомлення.')
    expect(await stream.count()).toBe(1)
  })

  test('#24 4000 code points: 4001 emoji are held back with a message, 4000 go, a 10 000-character paste is kept whole', async ({ page, api }) => {
    await openChat(page)
    const status = page.locator('[data-el="composer-status"]')
    const over = '😀'.repeat(4001)
    await composer(page).fill(over)
    // As inactive as it looks (§3.7.3); a press still reaches the page and gives the hint.
    await expect(sendButton(page)).toHaveAttribute('aria-disabled', 'true')
    await sendButton(page).click({ force: true })
    await expect(status).toHaveText(/Повідомлення задовге: 4\s001 із 4\s000 символів/)
    // A press again: the line is emptied first, so a screen reader hears the hint again.
    const emptied = await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-el="composer-send"]')!.click()
      return document.querySelector('[data-el="composer-status"]')!.textContent
    })
    expect(emptied).toBe('')
    await expect(status).toHaveText(/Повідомлення задовге: 4\s001 із 4\s000 символів/)
    await expect(composer(page)).toHaveValue(over)
    expect(api.count('POST /chat/turn')).toBe(0)

    const limit = '😀'.repeat(4000)
    await composer(page).fill(limit)
    await sendButton(page).click()
    await answered(page, 1)
    expect(turnBodies(api.bodies('POST /chat/turn'))[0]!.messages.at(-1)).toEqual({ role: 'user', content: limit })

    const pasted = 'я'.repeat(10_000)
    await composer(page).fill(pasted)
    expect((await composer(page).inputValue()).length).toBe(10_000)
    await sendButton(page).click({ force: true })
    await expect(status).toHaveText(/10\s000 із 4\s000/)
    expect(api.count('POST /chat/turn')).toBe(1)
  })

  test('#25 the 200-message limit: at 197 one more turn, then the block instead of the composer', async ({ page, api }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one project is enough for 99 turns')
    test.setTimeout(240_000)
    api.on('POST /chat/turn', { sse: reply(['Добре.']) })
    await openChat(page)
    // The opening message + 98 exchanges = 197 messages.
    for (let i = 0; i < 98; i++) {
      await send(page, `Так ${i + 1}.`, 'enter')
      await answered(page, i + 1)
    }
    await expect(page.locator('[data-el="chat-block"]')).toBeHidden()
    await expect(page.locator('[data-el="chat-line"]')).toHaveText(LONG_CONVERSATION)
    await send(page, 'Останнє.', 'enter')
    await answered(page, 99)
    const block = page.locator('[data-el="chat-block"]')
    await expect(block.locator('[data-el="chat-block-text"]')).toHaveText(LIMIT_BLOCK)
    await expect(block.getByRole('button', { name: 'Підсумувати' })).toBeVisible()
    await expect(composer(page)).toBeHidden()
    expect(api.count('POST /chat/turn')).toBe(99)
  })
})

// ── The crisis ───────────────────────────────────────────────────────────────────────────────

test.describe('crisis', () => {
  test('#5 ★ keyword crisis: no field, focus on h1, constant contacts, no paused number, the conversation under <details>', async ({ page, api, consoleLines }, testInfo) => {
    api.on('POST /chat/turn', { sse: meta() + crisis('keyword') })
    await openChat(page)
    // The field and its button, kept: the crisis takes them out of the document, listeners and all.
    await page.evaluate(() => {
      const w = window as unknown as { __kept: [HTMLTextAreaElement, HTMLButtonElement] }
      w.__kept = [document.querySelector<HTMLTextAreaElement>('#composer-input')!, document.querySelector<HTMLButtonElement>('[data-el="composer-send"]')!]
    })
    await send(page, CRISIS_TEXT)
    await expectCrisis(page, CRISIS_TEXT, testInfo)
    expect((await markup(page)).includes('evil.example')).toBe(false)
    // The conversation under <details> is a read-only copy: none of the live transcript's actions,
    // not even hidden ones, under any record.
    const stale = page.locator('[data-el="crisis-talk"]')
    await expect(stale.locator('li')).not.toHaveCount(0)
    for (const act of ['resend', 'edit', 'revisit-open', 'stop', 'copy', 'reload']) await expect(stale.locator(`[data-act="${act}"]`), act).toHaveCount(0)
    await expect(stale.locator('.said__status')).toHaveCount(0)
    await axe(page, 'crisis')
    // I5: nothing sends from here — not even the detached button pressed with text in the detached
    // field, nor Ctrl+Enter in it (both still reach the page's own handlers).
    const detached = await page.evaluate(() => {
      const [field, button] = (window as unknown as { __kept: [HTMLTextAreaElement, HTMLButtonElement] }).__kept
      field.value = 'Ще одне синтетичне повідомлення після кризи.'
      field.dispatchEvent(new Event('input'))
      button.click()
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      return !field.isConnected && !button.isConnected
    })
    expect(detached).toBe(true)
    await page.waitForTimeout(300)
    expect(api.count('POST /chat/turn')).toBe(1)
    await storageAudit(page, CRISIS_TEXT, consoleLines)
    // Leaving (pagehide): the contacts stay for «Назад», the conversation under <details> does not.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await expect(page.locator('[data-el="crisis-details"]')).toBeHidden()
    await expect(page.locator('[data-el="crisis-talk"] li')).toHaveCount(0)
    expect((await markup(page)).includes(CRISIS_TEXT)).toBe(false)
    await expect(page.locator('section[data-screen="crisis"] a.help__number[href="tel:112"]')).toBeVisible()
  })

  test('#6 ★ the model raises a crisis after four tokens: their text is nowhere', async ({ page, api }, testInfo) => {
    api.on('POST /chat/turn', { sse: meta() + PARTIAL.map(token).join('') + crisis('model') })
    await openChat(page)
    await send(page, CRISIS_TEXT)
    await expectCrisis(page, CRISIS_TEXT, testInfo)
    expect((await markup(page)).includes('токен-')).toBe(false)
  })

  test('#6b tokens and the crisis in one chunk: no deferred write after the final event', async ({ page }, testInfo) => {
    await page.clock.install()
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, CRISIS_TEXT)
    await stream.requests(1)
    await stream.write(meta() + PARTIAL.slice(0, 3).map(token).join('') + crisis('model'))
    await expectCrisis(page, CRISIS_TEXT, testInfo)
    await page.clock.runFor(1_000)
    await page.locator('[data-el="crisis-details"]').evaluate((details) => ((details as HTMLDetailsElement).open = true))
    await expect(page.locator('[data-el="crisis-talk"]')).not.toContainText('токен-')
    expect((await markup(page)).includes('токен-')).toBe(false)
  })

  test('#6b tokens and an error in one chunk: no deferred write after the error', async ({ page }) => {
    await page.clock.install()
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    await stream.write(meta() + PARTIAL.slice(0, 3).map(token).join('') + streamError('llm_failed'))
    await expect(lastUser(page).locator('.said__why')).toHaveText(why('llm_failed'))
    await page.clock.runFor(1_000)
    expect((await markup(page)).includes('токен-')).toBe(false)
  })

  test('#6b «Зупинити» right after tokens: the write waiting for its frame never comes', async ({ page }) => {
    await page.clock.install()
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    // Freeze time: the tokens wait for an animation frame that does not come before «Зупинити».
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000)
    await stream.write(meta() + PARTIAL.slice(0, 3).map(token).join(''))
    await expect(page.locator('.said--streaming')).toHaveCount(1)
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-el="composer-send"]')!.click())
    await page.clock.runFor(1_000)
    await expect(lastUser(page).locator('.said__flag')).toHaveText('Відповідь зупинено')
    expect((await markup(page)).includes('токен-')).toBe(false)
  })

  test('#13 ★ 409 crisis_stop on the theses: the crisis screen, no paused number', async ({ page, api }, testInfo) => {
    api.on('POST /chat/summarize', fail(409, 'crisis_stop', { helplines: RAW_HELPLINES }))
    await openChat(page)
    await exchange(page, USER)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await expectCrisis(page, USER, testInfo)
  })

  test('#13b text typed before the theses does not come back after a 409 crisis_stop and «Почати нову»', async ({ page, api }) => {
    api.on('POST /chat/summarize', fail(409, 'crisis_stop', { helplines: RAW_HELPLINES }))
    await openChat(page)
    await exchange(page, USER)
    // The field leaves the DOM on the theses with this text in it.
    await composer(page).fill('Синтетична чернетка, яку так і не надіслали.')
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'crisis')
    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    // «Текст цієї розмови зникне зі сторінки» — the unsent draft too.
    await confirmDialog(page).getByRole('button', { name: 'Почати нову' }).click()
    await onScreen(page, 'chat')
    await expect(composer(page)).toHaveValue('')
    await expect(sendButton(page)).toHaveAttribute('aria-disabled', 'true')
  })

  test('#51b a dialog open when the screen changes: closed, focus on the new h1 (help → crisis)', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, CRISIS_TEXT)
    await stream.requests(1)
    await stream.write(meta() + token(PARTIAL[0]!))
    await page.locator('.help-link').click()
    await expect(page.locator('#help-dialog')).toBeVisible()
    await stream.write(crisis('model'))
    await onScreen(page, 'crisis')
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(page.locator('#crisis-title')).toBeFocused()
  })
})

// ── HTTP errors of a turn ────────────────────────────────────────────────────────────────────

test.describe('errors', () => {
  test('#8 ★ 401 in the middle: session-expired with the conversation, no field; «Увійти знову» goes to Google', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply() }, fail(401, 'unauthenticated'))
    await openChat(page)
    await exchange(page, USER)
    await send(page, 'Друге синтетичне повідомлення.')
    await onScreen(page, 'session-expired')
    const stale = page.locator('[data-el="expired-talk"]')
    await expect(stale).toContainText(USER)
    await expect(stale).toContainText(REPLY_TEXT)
    await expect(stale).toContainText('Друге синтетичне повідомлення.')
    await expect(page.locator('textarea')).toHaveCount(0)
    await expect(page.locator('#expired-title')).toBeFocused()
    // The account menu needs a live session (§8.1).
    await expect(accountToggle(page)).toBeHidden()
    await axe(page, 'session-expired')

    await page.getByRole('button', { name: 'Увійти знову' }).click()
    const confirm = confirmDialog(page)
    await expect(confirm).toContainText('Увійти знову?')
    await axe(page, 'confirm relogin')
    await Promise.all([
      page.waitForURL(/\/api\/v1\/auth\/google\/start\?next=\/chat\/$/),
      confirm.getByRole('button', { name: 'Увійти', exact: true }).click(),
    ])
    expect(api.of('GET /auth/google/start')[0]!.query.get('next')).toBe('/chat/')
  })

  test('#8b 401 on the first turn: the unsent message stays, marked, and goes into the copy', async ({ page, api, context }, testInfo) => {
    api.on('POST /chat/turn', fail(401, 'unauthenticated'))
    await openChat(page)
    await send(page, USER)
    await onScreen(page, 'session-expired')
    const stale = page.locator('[data-el="expired-talk"]')
    await expect(stale).toContainText(USER)
    await expect(stale.locator('li.said--you .said__flag')).toHaveText('Не надіслано')
    // The clipboard is read in one project.
    if (isDesktop(testInfo)) {
      const button = page.locator('[data-el="expired-copy"]')
      // The browser refuses: not silent — the button and the live region say so.
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => Promise.reject(new Error('synthetic refusal'))
      })
      await button.click()
      await expect(button).toHaveText(COPY_FAILED_LABEL)
      await expect(announcer(page)).toHaveText(copyFailed('talk'))
      await page.evaluate(() => {
        delete (navigator.clipboard as unknown as { writeText?: unknown }).writeText
      })
      await expectCopied(page, context, button)
    }
  })

  test('#8b 403 not_invited on the first turn: the unsent message is under <details> and in the copy', async ({ page, api, context }, testInfo) => {
    api.on('POST /chat/turn', fail(403, 'not_invited'))
    await openChat(page)
    await send(page, USER)
    await onScreen(page, 'not-invited')
    const details = page.locator('[data-el="ni-details"]')
    await expect(details).toContainText(USER)
    await expect(details.locator('li.said--you .said__flag')).toHaveText('Не надіслано')
    if (isDesktop(testInfo)) await expectCopied(page, context, page.locator('[data-el="ni-copy"]'))
  })

  test('#9 ★ 403 not_invited with a session: the calm screen, downloads, the conversation kept', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply() }, fail(403, 'not_invited'))
    await openChat(page)
    await exchange(page, USER)
    await send(page, 'Друге синтетичне повідомлення.')
    await onScreen(page, 'not-invited')
    const screen = page.locator('section[data-screen="not-invited"]')
    await expect(screen.locator('[data-el="ni-member"]')).toBeVisible()
    await expect(screen.locator('[data-el="ni-guest"]')).toBeHidden()
    await expect(screen.locator('[data-el="ni-email"]')).toHaveText(EMAIL)
    const exports = screen.locator('a[href^="/api/v1/export"]')
    await expect(exports).toHaveCount(2)
    for (const link of await exports.all()) await expect(link).toHaveAttribute('download', '')
    await expect(screen.locator('[data-el="ni-details"]')).toContainText(USER)
    await expect(screen.locator('[data-el="ni-copy"]')).toBeVisible()
    await expect(screen).not.toContainText('помилка')
    await axe(page, 'not-invited with a session')
  })

  test('#10 ★ 403 consent_required: a fresh GET /consents, then the same turn again by itself', async ({ page, api }) => {
    api.on('GET /consents', { json: CONSENTS_OK }, { json: CONSENTS_NONE })
    api.on('POST /chat/turn', fail(403, 'consent_required', { missing: [...KINDS], policy_version: VERSION }), { sse: reply() })
    await openChat(page)
    await send(page, USER)
    await onScreen(page, 'consent')
    const resume = page.locator('[data-el="consent-resume"]')
    await expect(resume).toBeVisible()
    await expect(resume).toBeFocused()
    await expect.poll(() => api.count('GET /consents')).toBe(2)
    for (const kind of KINDS) await page.locator(`input[data-kind="${kind}"]`).check()
    await axe(page, 'consent (resume)')
    await page.getByRole('button', { name: 'Погоджуюся — продовжити' }).click()
    await onScreen(page, 'chat')
    await answered(page, 1)
    expect(api.bodies('POST /consents')).toEqual([{ policy_version: VERSION, kinds: [...KINDS] }])
    const turns = api.of('POST /chat/turn')
    expect(turns).toHaveLength(2)
    expect(turns[1]!.raw).toBe(turns[0]!.raw)
    await expect(lastUser(page)).toContainText(USER)
    await expect(aiMessages(page).nth(1)).toContainText(REPLY_TEXT)
  })

  test('#10b new terms in the middle: the consent is for version B, then the same turn goes again', async ({ page, api }) => {
    const B = '2026-10-20'
    api.on('GET /consents', { json: CONSENTS_OK }, { json: consents([...KINDS], B) })
    api.on('POST /chat/turn', fail(403, 'consent_required', { missing: [...KINDS], policy_version: B }), { sse: reply() })
    api.on('POST /consents', { json: consents([], B) })
    await openChat(page)
    await send(page, USER)
    await onScreen(page, 'consent')
    await expect(page.locator('[data-el="consent-changed"]')).toBeVisible()
    await expect(page.locator('[data-el="consent-resume"]')).toBeVisible()
    for (const kind of KINDS) await page.locator(`input[data-kind="${kind}"]`).check()
    await page.getByRole('button', { name: 'Погоджуюся — продовжити' }).click()
    await onScreen(page, 'chat')
    await answered(page, 1)
    expect(api.bodies('POST /consents')).toEqual([{ policy_version: B, kinds: [...KINDS] }])
    const turns = api.of('POST /chat/turn')
    expect(turns).toHaveLength(2)
    expect(turns[1]!.raw).toBe(turns[0]!.raw)
  })

  test('#10b a 409 inside the resume: new terms again, the mode stays resume, the turn still repeats', async ({ page, api }) => {
    const B = '2026-10-20'
    const C = '2026-10-21'
    api.on('GET /consents', { json: CONSENTS_OK }, { json: consents([...KINDS], B) }, { json: consents([...KINDS], C) })
    api.on('POST /consents', fail(409, 'policy_outdated', { policy_version: C }), { json: consents([], C) })
    api.on('POST /chat/turn', fail(403, 'consent_required', { missing: [...KINDS], policy_version: B }), { sse: reply() })
    await openChat(page)
    await send(page, USER)
    await onScreen(page, 'consent')
    for (const kind of KINDS) await page.locator(`input[data-kind="${kind}"]`).check()
    await page.getByRole('button', { name: 'Погоджуюся — продовжити' }).click()
    await expect.poll(() => api.count('GET /consents')).toBe(3)
    for (const kind of KINDS) await expect(page.locator(`input[data-kind="${kind}"]`)).not.toBeChecked()
    await expect(page.locator('[data-el="consent-changed"]')).toBeVisible()
    await expect(page.locator('[data-el="consent-resume"]')).toBeVisible()
    for (const kind of KINDS) await page.locator(`input[data-kind="${kind}"]`).check()
    await page.getByRole('button', { name: 'Погоджуюся — продовжити' }).click()
    await onScreen(page, 'chat')
    await answered(page, 1)
    expect(api.bodies('POST /consents')).toEqual([
      { policy_version: B, kinds: [...KINDS] },
      { policy_version: C, kinds: [...KINDS] },
    ])
    const turns = api.of('POST /chat/turn')
    expect(turns).toHaveLength(2)
    expect(turns[1]!.raw).toBe(turns[0]!.raw)
  })

  test('#11 ★ 403 csrf_failed: «Спробуйте ще раз» first, «Оновіть сторінку» with a copy the second time', async ({ page, api }) => {
    api.on('POST /chat/turn', fail(403, 'csrf_failed'))
    await openChat(page)
    await send(page, USER)
    const unsent = lastUser(page)
    await expect(unsent.locator('.said__why')).toHaveText(CSRF_FIRST)
    await unsent.getByRole('button', { name: 'Надіслати ще раз' }).click()
    await expect(unsent.locator('.said__why')).toHaveText(CSRF_RELOAD)
    await expect(unsent.getByRole('button', { name: 'Скопіювати текст розмови' })).toBeVisible()
    await expect(unsent.getByRole('button', { name: 'Оновити сторінку' })).toBeVisible()
    await expect(unsent.getByRole('button', { name: 'Надіслати ще раз' })).toBeHidden()
    expect(api.count('POST /chat/turn')).toBe(2)
  })

  test('#14 ★ 413 on a turn: the block with «Підсумувати» and «Завершити без тез», no composer', async ({ page, api }) => {
    api.on('POST /chat/turn', fail(413, 'payload_too_large'))
    await openChat(page)
    await send(page, USER)
    const block = page.locator('[data-el="chat-block"]')
    await expect(block.locator('[data-el="chat-block-text"]')).toHaveText(TOO_LARGE_BLOCK)
    await expect(block.getByRole('button', { name: 'Підсумувати' })).toBeVisible()
    await expect(block.getByRole('button', { name: 'Завершити без тез' })).toBeVisible()
    await expect(composer(page)).toBeHidden()
    await axe(page, 'conversation with the limit block')
  })

  test('#15 ★ 422 on a turn: the line and «Змінити» puts the text back', async ({ page, api }) => {
    api.on('POST /chat/turn', fail(422, 'validation_error', [{ field: 'messages.1.content', message: SERVER_MESSAGE_SHORT }]))
    await openChat(page)
    await send(page, USER)
    const unsent = lastUser(page)
    await expect(unsent.locator('.said__why')).toHaveText(why('validation_error'))
    await unsent.getByRole('button', { name: 'Змінити' }).click()
    await expect(composer(page)).toHaveValue(USER)
    await expect(page.locator('[data-el="talk"] > li.said--you')).toHaveCount(0)
  })

  test('#16 ★ 429 with Retry-After: 12: a countdown, no automatic request, the button comes back after 12 s', async ({ page, api }) => {
    await page.clock.install()
    api.on('POST /chat/turn', fail(429, 'rate_limited', undefined, { 'retry-after': '12' }))
    await openChat(page)
    await send(page, USER)
    const unsent = lastUser(page)
    const resend = unsent.getByRole('button', { name: 'Надіслати ще раз' })
    await expect(resend).toHaveAttribute('aria-disabled', 'true')
    await expect(unsent.locator('.said__why')).toContainText('Надіслати знову можна через')
    // Said once at the start, with the seconds, like the line: not «Можна надіслати ще раз» while
    // the button is still aria-disabled (WCAG 4.1.3). That comes only at the end.
    await expect.poll(async () => (await announced(page)).some((text) => /^Не надіслано\. .*Надіслати знову можна через 1[12] с\.$/.test(text))).toBe(true)
    expect((await announced(page)).filter((text) => text.includes(COOLDOWN_OVER))).toEqual([])
    await composer(page).fill('Ще одне синтетичне повідомлення.')
    await expect(sendButton(page)).toHaveAttribute('aria-disabled', 'true')
    await axe(page, 'conversation in the 429 countdown')
    await page.clock.runFor(12_000)
    await expect(resend).not.toHaveAttribute('aria-disabled', 'true')
    await expect(announcer(page)).toHaveText(COOLDOWN_OVER)
    expect(api.count('POST /chat/turn')).toBe(1)
  })

  test('#16b a 429 countdown: the theses and back keep it; its end is said only in its own conversation', async ({ page, api }) => {
    await page.clock.install()
    api.on('POST /chat/turn', { sse: reply() }, fail(429, 'rate_limited', undefined, { 'retry-after': '12' }))
    // The theses never come: «Скасувати» takes the person back while the countdown still runs.
    const never = gate()
    api.on('POST /chat/summarize', async () => {
      await never.wait
      return { json: DRAFT }
    })
    await openChat(page)
    await exchange(page, USER)
    await send(page, 'Друге синтетичне повідомлення.')
    const resend = lastUser(page).getByRole('button', { name: 'Надіслати ще раз' })
    await expect(resend).toHaveAttribute('aria-disabled', 'true')
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'summarizing')
    await page.getByRole('button', { name: 'Скасувати й повернутися до розмови' }).click()
    await onScreen(page, 'chat')
    await expect(resend).toHaveAttribute('aria-disabled', 'true')
    await endWithoutTheses(page)
    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    // The new conversation inherits no countdown: with text in the field «Надіслати» is ready now,
    // and the old countdown's end is not said here.
    await composer(page).fill('Синтетичне повідомлення в новій розмові.')
    await expect(sendButton(page)).not.toHaveAttribute('aria-disabled', 'true')
    const before = (await announced(page)).length
    await page.clock.runFor(12_000)
    await expect(sendButton(page)).not.toHaveAttribute('aria-disabled', 'true')
    expect((await announced(page)).slice(before)).not.toContain(COOLDOWN_OVER)
    never.open()
  })

  test('#17 ★ 503 llm_busy, 503, 200: three requests, a countdown between them', async ({ page, api }) => {
    await page.clock.install()
    const busy = fail(503, 'llm_busy', undefined, { 'retry-after': '5' })
    api.on('POST /chat/turn', busy, busy, { sse: reply() })
    await openChat(page)
    await send(page, USER)
    const wait = page.locator('.said--live .said__wait')
    await expect(wait).toContainText('Пробуємо ще раз через')
    await expect(lastUser(page).getByRole('button', { name: 'Скасувати' })).toBeVisible()
    await page.clock.runFor(5_000)
    await expect.poll(() => api.count('POST /chat/turn')).toBe(2)
    await expect(wait).toContainText('Пробуємо ще раз через')
    await page.clock.runFor(5_000)
    await answered(page, 1)
    expect(api.count('POST /chat/turn')).toBe(3)
    const turns = api.of('POST /chat/turn')
    expect(new Set(turns.map((call) => call.raw)).size).toBe(1)
  })

  test('#17 ★ 503 three times: after the third request only the manual button', async ({ page, api }) => {
    await page.clock.install()
    api.on('POST /chat/turn', fail(503, 'llm_busy', undefined, { 'retry-after': '5' }))
    await openChat(page)
    await send(page, USER)
    const wait = page.locator('.said--live .said__wait')
    for (let n = 2; n <= 3; n++) {
      await expect(wait).toContainText('Пробуємо ще раз через')
      await page.clock.runFor(5_000)
      await expect.poll(() => api.count('POST /chat/turn')).toBe(n)
    }
    const unsent = lastUser(page)
    await expect(unsent.locator('.said__why')).toHaveText(why('llm_busy'))
    await expect(unsent.getByRole('button', { name: 'Надіслати ще раз' })).toBeVisible()
    await page.clock.runFor(10_000)
    expect(api.count('POST /chat/turn')).toBe(3)
  })

  test('#17 ★ an SSE error llm_busy is retried like a 503', async ({ page, api }) => {
    await page.clock.install()
    api.on('POST /chat/turn', { sse: meta() + streamError('llm_busy') }, { sse: reply() })
    await openChat(page)
    await send(page, USER)
    await expect(page.locator('.said--live .said__wait')).toContainText('Пробуємо ще раз через')
    await page.clock.runFor(5_000)
    await answered(page, 1)
    expect(api.count('POST /chat/turn')).toBe(2)
  })

  test('#51b a dialog open when the screen changes: closed, focus on the new h1 (account → 401)', async ({ page, api }) => {
    const held = gate()
    api.on('POST /chat/turn', async () => {
      await held.wait
      return fail(401, 'unauthenticated')
    })
    await openChat(page)
    await send(page, USER)
    await expect.poll(() => api.count('POST /chat/turn')).toBe(1)
    await accountToggle(page).click()
    await expect(accountSheet(page)).toBeVisible()
    held.open()
    await onScreen(page, 'session-expired')
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(page.locator('#expired-title')).toBeFocused()
  })
})


// ── Sign-in, consent, scenarios ─────────────────────────────────────────────────────────────

test.describe('sign-in and consent', () => {
  test('#26 ?auth_error: each known code has its text, not_invited its screen, anything else the general text; the URL is cleaned', async ({ page, api }, testInfo) => {
    api.on('GET /me', fail(401, 'unauthenticated'))
    const codes: AuthCode[] = ['access_denied', 'state_mismatch', 'expired', 'server_error', 'auth_unavailable']
    for (const code of codes) {
      await openChat(page, `/chat/?auth_error=${code}`, 'signed-out')
      await expect(page.locator('[data-el="signin-banner-text"]')).toHaveText(signInBanner({ kind: 'auth-error', code }).text)
      await expect(page.locator('[data-el="signin-banner"]')).toBeFocused()
      await expect(page).toHaveURL(/\/chat\/$/)
    }
    // Focused by the page, like an h1: a calm line, not a card with a ring around it (§3.3).
    expect(await page.locator('[data-el="signin-banner"]').evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('none')
    // Nobody can write here: no «Чекає на ваше повідомлення» under the light (desktop shows it).
    if (isDesktop(testInfo)) await expect(page.locator('.presence__state')).toBeHidden()
    await openChat(page, '/chat/?auth_error=something_else', 'signed-out')
    await expect(page.locator('[data-el="signin-banner-text"]')).toHaveText(signInBanner({ kind: 'auth-error', code: 'unknown' }).text)
    await expect(page).toHaveURL(/\/chat\/$/)
    await openChat(page, '/chat/?auth_error=not_invited', 'not-invited')
    await expect(page.locator('[data-el="ni-guest"]')).toBeVisible()
    await expect(page.locator('[data-el="ni-member"]')).toBeHidden()
    // Only about this sign-in: a tester taken off the list still has an account and a diary (§3.4).
    await expect(page.locator('[data-el="ni-guest"] .prose')).toContainText('Новий акаунт не створено, і під час цього входу вашої адреси ми не записали.')
    await expect(page.locator('[data-el="ni-guest"] .prose')).not.toContainText('Акаунт не створено')
    await expect(page).toHaveURL(/\/chat\/$/)
    // The variant keeps the screen's rhythm: the heading, the text and the button do not touch.
    const gaps = await page.evaluate(() => {
      const part = document.querySelector('[data-el="ni-guest"]')!
      const box = (selector: string): DOMRect => part.querySelector(selector)!.getBoundingClientRect()
      return [box('.prose').top - box('h1').bottom, box('.screen__actions').top - box('.prose').bottom]
    })
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(12)
  })

  test('#26b ?auth_error with a live session: «Новий вхід не відбувся…» with the email, over the new screen, focused', async ({ page }, testInfo) => {
    for (const code of ['not_invited', 'expired'] as const) {
      await openChat(page, `/chat/?auth_error=${code}`)
      const banner = page.locator('[data-el="chat-auth"]')
      await expect(banner).toBeVisible()
      await expect(banner).toBeFocused()
      await expect(page.locator('[data-el="chat-auth-text"]')).toHaveText(stillSignedIn(code, EMAIL))
      const above = await page.evaluate(() => {
        const node = document.querySelector('[data-el="chat-auth"]')!
        const tag = document.querySelector('section[data-screen="chat"] .tag')!
        return (node.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      })
      expect(above).toBe(true)
      await expect(page).toHaveURL(/\/chat\/$/)
    }
    // The person can write here: the label under the light is shown (desktop).
    if (isDesktop(testInfo)) await expect(page.locator('.presence__state')).toBeVisible()
    await expect(page.locator('[data-el="chat-auth-text"]')).not.toContainText('списку тестувальників')
  })

  test('#27 the landing passes a sign-in error on to the chat, where its banner shows', async ({ page, api }) => {
    api.on('GET /me', fail(401, 'unauthenticated'))
    await page.goto('/?auth_error=expired', { waitUntil: 'commit' })
    await expect(page).toHaveURL(/\/chat\/$/)
    await onScreen(page, 'signed-out')
    await expect(page.locator('[data-el="signin-banner-text"]')).toHaveText(signInBanner({ kind: 'auth-error', code: 'expired' }).text)
  })

  test('#28 consent: the provider and its country, the version date, every box required, kinds = missing, «Не зараз»', async ({ page, api }) => {
    api.on('GET /consents', { json: consents(['llm_transfer', 'age_18']) })
    await openChat(page, '/chat/', 'consent')
    const screen = page.locator('section[data-screen="consent"]')
    await expect(screen.locator('[data-el="provider"]').first()).toHaveText('Ollama Cloud (Ollama Inc.)')
    await expect(screen.locator('[data-el="country"]').first()).toHaveText('США')
    await expect(screen.locator('[data-el="consent-version"]')).toHaveText('6 жовтня 2026 р.')
    await expect(screen).toContainText('Повного тексту розмови на сервері Liora немає')
    await expect(screen.locator('input[data-kind="data_processing"]')).toBeChecked()
    await expect(screen.locator('[data-granted="data_processing"]')).toHaveText('(ви вже погодилися 06.10.2026)')
    await expect(screen.locator('input[data-kind="llm_transfer"]')).not.toBeChecked()

    // Without every box: the alert on the first empty one, no request.
    await screen.getByRole('button', { name: 'Погоджуюся — почати' }).click()
    await expect(screen.locator('[data-el="consent-alert"]')).toHaveText(CONSENT_UNCHECKED)
    await expect(screen.locator('input[data-kind="llm_transfer"]')).toBeFocused()
    expect(api.count('POST /consents')).toBe(0)

    // «Не зараз» says honestly that the account exists already.
    const later = screen.getByRole('button', { name: 'Не зараз' })
    await later.click()
    await expect(later).toHaveAttribute('aria-expanded', 'true')
    await expect(screen.locator('#consent-later')).toContainText('ми вже створили акаунт')
    await expect(screen.locator('#consent-later').getByRole('button', { name: 'Видалити акаунт' })).toBeVisible()
    await axe(page, 'consent with «Не зараз» open')

    await screen.locator('input[data-kind="llm_transfer"]').check()
    await screen.locator('input[data-kind="age_18"]').check()
    await screen.getByRole('button', { name: 'Погоджуюся — почати' }).click()
    await onScreen(page, 'chat')
    expect(api.bodies('POST /consents')).toEqual([{ policy_version: VERSION, kinds: ['llm_transfer', 'age_18'] }])
  })

  test('#28 consent without a named provider: no boxes at all', async ({ page, api }) => {
    api.on('GET /consents', { json: consents([...KINDS], VERSION, null) })
    await openChat(page, '/chat/', 'consent')
    await expect(page.locator('[data-el="consent-no-provider"]')).toBeVisible()
    await expect(page.locator('[data-el="consent-no-country"]')).toBeHidden()
    await expect(page.locator('[data-el="consent-reload"]')).toBeVisible()
    await expect(page.locator('[data-el="consent-checks"]')).toBeHidden()
    await expect(page.locator('[data-el="consent-agree"]')).toBeHidden()
    expect(api.count('POST /consents')).toBe(0)
  })

  test('#28c a provider without a country, then without a name: no empty slot anywhere; only the consent needs both', async ({ page, api }) => {
    const NAME = 'Ollama Cloud (Ollama Inc.)'
    // The text without its [hidden] clauses (those wait for a missing value), as written: no CSS
    // case (the confirm's title is upper-case on the screen), and the same on every width.
    const text = (locator: Locator) =>
      locator.evaluate((node) => {
        const copy = node.cloneNode(true) as HTMLElement
        for (const hidden of Array.from(copy.querySelectorAll('[hidden]'))) hidden.remove()
        return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
      })
    const sheetAndConfirms = async (named: string, dative: string) => {
      await accountToggle(page).click()
      const sheet = accountSheet(page)
      expect(await text(sheet.locator('.grants__item', { has: page.locator('[data-kind="llm_transfer"]') }).locator('p'))).toBe(`Передача тексту ${dative} — надано 06.10.2026`)
      await sheet.locator('[data-act="revoke"][data-kind="llm_transfer"]').click()
      const confirm = confirmDialog(page)
      await expect(confirm).toBeVisible()
      expect(await text(confirm.locator('#confirm-title'))).toBe(`Відкликати згоду на передачу тексту ${dative}?`)
      await confirm.getByRole('button', { name: 'Скасувати' }).click()
      await sheet.locator('[data-act="delete-account"]').click()
      await expect(confirm).toBeVisible()
      expect(await text(confirm.locator('p', { hasText: 'зберігається за його умовами' }))).toBe(
        `Те, що під час розмов отримав ${named}, зберігається за його умовами — Liora видалити це не може.`,
      )
      await confirm.getByRole('button', { name: 'Скасувати' }).click()
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
    }
    const note = page.locator('#composer-note .wide-only')

    api.on('GET /consents', { json: consents([], VERSION, { name: NAME, country: '' }) })
    await openChat(page)
    await expect(note.locator('[data-el="provider"]')).toHaveText(NAME)
    await expect(note.locator('[data-provider="located"]')).toHaveAttribute('hidden', '')
    expect(await text(note)).toBe(`Liora не зберігає цю розмову: якщо закрити чи оновити сторінку, текст зникне. Текст обробляє ${NAME}.`)
    await sheetAndConfirms(`постачальник AI, ${NAME}`, NAME)

    api.on('GET /consents', { json: consents([], VERSION, null) })
    await page.reload()
    await onScreen(page, 'chat')
    await expect(note.locator('[data-provider="unnamed"]')).toHaveText('постачальник AI')
    expect(await text(note)).toBe('Liora не зберігає цю розмову: якщо закрити чи оновити сторінку, текст зникне. Текст обробляє постачальник AI.')
    await sheetAndConfirms('постачальник AI', 'постачальнику AI')

    // The consent itself still needs the country: no boxes to agree to. The data did load, so the
    // line says what is missing, and no «Спробувати ще раз»: a second GET would bring the same.
    api.on('GET /consents', { json: consents([...KINDS], VERSION, { name: NAME, country: '' }) })
    await page.reload()
    await onScreen(page, 'consent')
    await expect(page.locator('[data-el="consent-no-country"]')).toBeVisible()
    await expect(page.locator('[data-el="consent-no-provider"]')).toBeHidden()
    await expect(page.locator('[data-el="consent-reload"]')).toBeHidden()
    await expect(page.locator('[data-el="consent-checks"]')).toBeHidden()
    const lead = page.locator('section[data-screen="consent"] p', { hasText: 'Відповіді й тези створює' })
    expect(await text(lead)).toContain(`а постачальник AI — ${NAME}. Щоб AI міг відповідати`)
    expect(api.count('POST /consents')).toBe(0)
  })

  test('#12 ★ 409 policy_outdated: a second GET /consents, the boxes cleared, «Умови щойно оновилися…»', async ({ page, api }) => {
    const B = '2026-10-20'
    api.on('GET /consents', { json: CONSENTS_NONE }, { json: consents([...KINDS], B) })
    api.on('POST /consents', fail(409, 'policy_outdated', { policy_version: B }))
    await openChat(page, '/chat/', 'consent')
    await axe(page, 'consent (first)')
    for (const kind of KINDS) await page.locator(`input[data-kind="${kind}"]`).check()
    await page.getByRole('button', { name: 'Погоджуюся — почати' }).click()
    await expect.poll(() => api.count('GET /consents')).toBe(2)
    const changed = page.locator('[data-el="consent-changed"]')
    await expect(changed).toBeVisible()
    await expect(changed).toBeFocused()
    for (const kind of KINDS) await expect(page.locator(`input[data-kind="${kind}"]`)).not.toBeChecked()
    await expect(page.locator('[data-el="consent-version"]')).toHaveText('20 жовтня 2026 р.')
    await axe(page, 'consent (update)')
  })

  test('#29 scenarios: free first; a switch swaps the opening message; the page’s own description; revisit with an empty diary', async ({ page }) => {
    await openChat(page)
    await expect(scenarioList(page).getByRole('radio', { name: 'Вільна розмова' })).toBeChecked()
    await expect(firstMessage(page)).toHaveText(SCENARIOS[0].opening_message)
    await axe(page, 'new conversation (free)')

    await scenarioList(page).getByRole('radio', { name: 'Розбір ситуації' }).check()
    await expect(firstMessage(page)).toHaveText(SCENARIOS[1].opening_message)
    await expect(aiMessages(page)).toHaveCount(1)
    await expect(page.locator('[data-el="scenario-text"]')).toHaveText(scenarioAbout(SCENARIOS[1]))
    expect((await markup(page)).includes('КПТ')).toBe(false)

    await scenarioList(page).getByRole('radio', { name: 'Повернення до теми' }).check()
    await expect(page.locator('[data-el="scenario-text"]')).toHaveText(REVISIT_EMPTY)
    await expect(composer(page)).toBeHidden()
    await expect(page.locator('[data-el="revisit-free"]')).toBeVisible()
    // The field is gone, its disclosure is not: the screen still says what it talks to.
    const disclosure = page.locator('[data-el="chat-ai"]')
    await expect(disclosure).toBeVisible()
    await expect(disclosure).toHaveText('AI, не людина · може помилятися · не терапія')
    await expect(page.locator('.composer__ai')).toBeHidden()
    await axe(page, 'new conversation, revisit with an empty diary')
    await page.locator('[data-el="revisit-free"]').click()
    await expect(scenarioList(page).getByRole('radio', { name: 'Вільна розмова' })).toBeChecked()
    await expect(composer(page)).toBeVisible()
    await expect(page.locator('.composer__ai')).toBeVisible()
    await expect(disclosure).toBeHidden()
  })

  test('#29b GET /scenarios fails: the conversation opens only once it answered, with free alone and a retry', async ({ page, api }) => {
    const held = gate()
    api.on('GET /scenarios', async () => {
      await held.wait
      return { status: 502, body: '' }
    })
    await page.goto('/chat/')
    await expect.poll(() => api.count('GET /consents')).toBe(1)
    await page.waitForTimeout(400)
    await expect(html(page)).toHaveAttribute('data-screen', 'booting')
    held.open()
    await onScreen(page, 'chat')
    await expect(firstMessage(page)).toHaveText('Про що вам хочеться поговорити сьогодні?')
    await expect(page.locator('[data-el="scenarios"]')).toBeHidden()
    const failed = page.locator('[data-el="scenarios-failed"]')
    await expect(failed).toContainText('Інші сценарії зараз не завантажилися.')
    await expect(failed.getByRole('button', { name: 'Спробувати ще раз' })).toBeVisible()
    await exchange(page)
    expect(turnBodies(api.bodies('POST /chat/turn'))[0]!.scenario).toBe('free')
  })
})

// ── «Повернення до теми» ────────────────────────────────────────────────────────────────────

test.describe('revisit', () => {
  test.beforeEach(({ api }) => {
    api.on('GET /summaries', { json: diary(RECORDS) })
  })

  test('#30 choosing revisit by keyboard opens nothing; «Обрати записи» does; 1–5 records, the sixth disabled; the ids go with the turn', async ({ page, api }) => {
    await openChat(page)
    await scenarioList(page).getByRole('radio', { name: 'Вільна розмова' }).focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
    await expect(scenarioList(page).getByRole('radio', { name: 'Повернення до теми' })).toBeChecked()
    await expect(pickDialog(page)).toBeHidden()

    await page.locator('[data-el="revisit-open"]').click()
    const dialog = pickDialog(page)
    await expect(dialog).toBeVisible()
    const boxes = dialog.locator('.pick__input')
    await expect(boxes).toHaveCount(6)
    for (let i = 0; i < 5; i++) await boxes.nth(i).check()
    await expect(boxes.nth(5)).toBeDisabled()
    await expect(dialog.locator('[data-el="pick-count"]')).toHaveText('Обрано 5 з 5')
    await axe(page, 'record picker')
    await dialog.getByRole('button', { name: 'Продовжити (5)' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-el="revisit-names"]')).toContainText('Синтетичний запис 1')

    await exchange(page)
    const [body] = turnBodies(api.bodies('POST /chat/turn'))
    expect(body!.scenario).toBe('revisit')
    expect(body!.revisit_summary_ids).toEqual(RECORDS.slice(0, 5).map((r) => r.id))
  })

  test('#30 Esc with nothing chosen puts the previous scenario back; revisit never goes without ids', async ({ page, api }) => {
    await openChat(page)
    await scenarioList(page).getByRole('radio', { name: 'Розбір дня' }).check()
    await scenarioList(page).getByRole('radio', { name: 'Повернення до теми' }).check()
    await page.locator('[data-el="revisit-open"]').click()
    await expect(pickDialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pickDialog(page)).toBeHidden()
    await expect(scenarioList(page).getByRole('radio', { name: 'Розбір дня' })).toBeChecked()
    await expect(firstMessage(page)).toHaveText(SCENARIOS[2].opening_message)

    await scenarioList(page).getByRole('radio', { name: 'Повернення до теми' }).check()
    await send(page, 'Хочу повернутися до теми.')
    await expect(page.locator('[data-el="composer-status"]')).toHaveText(NEED_RECORDS)
    expect(api.count('POST /chat/turn')).toBe(0)
  })

  test('#30c the closed picker keeps no records; after «Вийти» neither the chosen names nor the email stay in the page', async ({ page, api }) => {
    await openChat(page)
    await chooseRecords(page, [0])
    await expect(page.locator('[data-el="revisit-names"]')).toHaveText(RECORDS[0]!.title)
    // Closed, the picker lets go of its list: titles, tags and first theses of the diary.
    await expect(pickDialog(page).locator('.pick')).toHaveCount(0)
    const closed = await markup(page)
    for (const r of RECORDS.slice(1)) expect(closed.includes(r.title), r.title).toBe(false)
    expect(closed.includes(RECORDS[0]!.bullets[0]!), 'a first thesis').toBe(false)
    // Opened again, it is filled again.
    await page.locator('[data-el="revisit-open"]').click()
    await expect(pickDialog(page).locator('.pick__input')).toHaveCount(RECORDS.length)
    await page.keyboard.press('Escape')
    await expect(pickDialog(page)).toBeHidden()

    await accountToggle(page).click()
    await expect(accountSheet(page).locator('[data-el="account-email"]')).toHaveText(EMAIL)
    await accountSheet(page).getByRole('button', { name: 'Вийти', exact: true }).click()
    await onScreen(page, 'signed-out')
    expect(api.count('POST /auth/logout')).toBe(1)
    const after = await markup(page)
    expect(after.includes(EMAIL), 'the email in the closed account sheet').toBe(false)
    for (const r of RECORDS) expect(after.includes(r.title), r.title).toBe(false)
  })

  test('#30 404 on a record: the picker opens again with the banner; a new choice sends the turn again', async ({ page, api }) => {
    api.on('POST /chat/turn', fail(404, 'not_found'), { sse: reply() })
    await openChat(page)
    await chooseRecords(page, [0])
    await send(page, USER)
    const dialog = pickDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-el="pick-gone"]')).toBeVisible()
    await dialog.locator('.pick__input').nth(1).check()
    await dialog.getByRole('button', { name: 'Продовжити (1)' }).click()
    await answered(page, 1)
    const bodies = turnBodies(api.bodies('POST /chat/turn'))
    expect(bodies.map((b) => b.revisit_summary_ids)).toEqual([[RECORDS[0]!.id], [RECORDS[1]!.id]])
    expect(bodies[1]!.messages).toEqual(bodies[0]!.messages)
  })

  test('#30 Esc after a 404: the scenario stays revisit, the message «Не надіслано» with «Обрати записи»', async ({ page, api }) => {
    api.on('POST /chat/turn', fail(404, 'not_found'))
    await openChat(page)
    await chooseRecords(page, [0])
    await send(page, USER)
    await expect(pickDialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pickDialog(page)).toBeHidden()
    await expect(page.locator('[data-el="session-title"]')).toHaveText('Повернення до теми')
    const unsent = lastUser(page)
    await expect(unsent.locator('.said__flag')).toHaveText('Не надіслано')
    await expect(unsent.locator('.said__why')).toHaveText(why('not_found', true))
    await expect(unsent.getByRole('button', { name: 'Обрати записи' })).toBeVisible()
    expect(api.count('POST /chat/turn')).toBe(1)
  })

  test('#30 404 and the diary is empty now: the block «Записів… уже немає» with «Завершити без тез»', async ({ page, api }) => {
    let gone = false
    api.on('GET /summaries', () => ({ json: diary(gone ? [] : RECORDS) }))
    api.on('POST /chat/turn', () => {
      gone = true
      return fail(404, 'not_found')
    })
    await openChat(page)
    await chooseRecords(page, [0])
    await send(page, USER)
    const block = page.locator('[data-el="chat-block"]')
    await expect(block.locator('[data-el="chat-block-text"]')).toHaveText(REVISIT_GONE_BLOCK)
    await expect(block.getByRole('button', { name: 'Завершити без тез' })).toBeVisible()
    await expect(pickDialog(page)).toBeHidden()
    await expect(composer(page)).toBeHidden()
  })

  test('#32b the theses get exactly {scenario, messages} — no revisit ids; a 422 is final', async ({ page, api }) => {
    api.on('POST /chat/summarize', fail(422, 'validation_error', [{ field: 'messages', message: SERVER_MESSAGE_SHORT }]))
    await openChat(page)
    await chooseRecords(page, [0])
    await exchange(page, USER)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'summarizing')
    await expect(page.locator('[data-el="sum-status"]')).toHaveText(summarizeError(uiError('validation_error', { status: 422 }), 0, null).why)
    await expect(page.locator('[data-el="sum-retry"]')).toBeHidden()
    const bodies = api.bodies('POST /chat/summarize') as TurnBody[]
    expect(bodies).toHaveLength(1)
    expect(Object.keys(bodies[0]!).sort()).toEqual(['messages', 'scenario'])
    expect(bodies[0]!.scenario).toBe('revisit')
    expect(bodies[0]!.messages.length).toBeLessThanOrEqual(200)
    expect(bodies[0]!.messages).toEqual([
      { role: 'assistant', content: SCENARIOS[3].opening_message },
      { role: 'user', content: USER },
      { role: 'assistant', content: REPLY_TEXT },
    ])
    await axe(page, 'summarizing with a final error')
  })
})

// ── Theses ───────────────────────────────────────────────────────────────────────────────────

test.describe('theses', () => {
  test('#31 theses edited in place and saved: a trimmed body, tag sources, the saved screen, the conversation gone', async ({ page, api, consoleLines }) => {
    await openChat(page)
    await exchange(page, USER)
    await toReview(page)
    await expect(page.locator('[data-el="review-title"]')).toHaveValue(DRAFT.title)
    await page.locator('[data-el="review-title"]').fill(`  ${DRAFT.title} — оновлено  `)
    await page.locator('#thesis-b0').fill(`  ${DRAFT.bullets[0]} Виправлено.  `)
    await page.locator('#review-tag-input').fill('ранок')
    await page.getByRole('button', { name: 'Додати', exact: true }).click()
    await expect(page.locator('.tagpill', { hasText: '#ранок' })).toBeVisible()
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    await onScreen(page, 'saved')

    expect(api.bodies('POST /summaries')).toEqual([
      {
        scenario: 'free',
        title: `${DRAFT.title} — оновлено`,
        bullets: [`${DRAFT.bullets[0]} Виправлено.`, ...DRAFT.bullets.slice(1)],
        tags: [
          { name: 'робота', source: 'ai' },
          { name: 'стосунки', source: 'ai' },
          { name: 'ранок', source: 'user' },
        ],
      },
    ])
    await expect(page.locator('[data-el="saved-title"]')).toHaveText(`${DRAFT.title} — оновлено`)
    await expect(page.locator('[data-el="saved-bullets"] li')).toHaveCount(4)
    const after = await markup(page)
    expect(after.includes(USER)).toBe(false)
    expect(after.includes(REPLY_TEXT)).toBe(false)
    expect(await beforeUnload(page)).toBe(0)
    // The region was emptied with the conversation; «Збережено в щоденник» may follow.
    await expect(announcer(page)).toHaveText(/^(Збережено в щоденник)?$/)
    await axe(page, 'saved')
    await storageAudit(page, USER, consoleLines)
  })

  test('#15 ★ 422 on the theses: the error on thesis 3 and the focus there', async ({ page, api }) => {
    await openChat(page)
    await exchange(page)
    await toReview(page)
    api.on('POST /summaries', fail(422, 'validation_error', [{ field: 'bullets.2', message: SERVER_MESSAGE_SHORT }]))
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    const field = page.locator('#thesis-b2')
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(field).toBeFocused()
    await expect(page.locator('#thesis-b2-error')).toHaveText(DRAFT_TEXT['bullet-invalid']!)
    await axe(page, 'review with an error on a field')
  })

  test('#15c no thesis left: «Потрібна хоча б одна теза.» is the description of the field that takes the focus', async ({ page, api }) => {
    await openChat(page)
    await exchange(page)
    await toReview(page)
    for (const field of await page.locator('.thesis__input').all()) await field.fill('')
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    const focused = page.locator('.thesis__input:focus')
    await expect(focused).toHaveCount(1)
    await expect(focused).toHaveAttribute('aria-invalid', 'true')
    await expect(focused).toHaveAccessibleDescription(/Потрібна хоча б одна теза/)
    expect(api.count('POST /summaries')).toBe(0)
    await page.locator('#thesis-b0').fill('Одна синтетична теза.')
    await expect(page.locator('#thesis-b0')).not.toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#thesis-b0')).not.toHaveAccessibleDescription(/Потрібна хоча б одна теза/)
  })

  test('#15b 422 after «Прибрати»: the error lands on the field the index came from, for theses and for tags', async ({ page, api }) => {
    await openChat(page)
    await exchange(page)
    await toReview(page)
    api.on(
      'POST /summaries',
      fail(422, 'validation_error', [{ field: 'bullets.1', message: SERVER_MESSAGE_SHORT }]),
      fail(422, 'validation_error', [{ field: 'tags.1.name', message: SERVER_MESSAGE_SHORT }]),
      fail(422, 'validation_error', [
        { field: 'tags.0.name', message: SERVER_MESSAGE_SHORT },
        { field: 'tags.1.name', message: SERVER_MESSAGE_SHORT },
      ]),
    )
    await page.getByRole('button', { name: 'Прибрати тезу 1' }).click()
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    // bullets.1 of the body is the original third thesis (the first was removed).
    const third = page.locator('#thesis-b2')
    await expect(third).toHaveValue(DRAFT.bullets[2]!)
    await expect(third).toHaveAttribute('aria-invalid', 'true')
    await expect(third).toBeFocused()
    await expect(page.locator('#thesis-b1')).not.toHaveAttribute('aria-invalid', 'true')
    expect((api.bodies('POST /summaries')[0] as { bullets: string[] }).bullets).toEqual(DRAFT.bullets.slice(1))

    await page.getByRole('button', { name: 'Прибрати тег «робота»' }).click()
    await page.locator('#review-tag-input').fill('ранок')
    await page.getByRole('button', { name: 'Додати', exact: true }).click()
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    const wrong = page.locator('.tagpill', { hasText: '#ранок' })
    await expect(wrong).toHaveClass(/tagpill--invalid/)
    await expect(page.locator('.tagpill', { hasText: '#стосунки' })).not.toHaveClass(/tagpill--invalid/)
    // Named in text, not only by colour (SC 1.4.1, 3.3.1): the line says which tag, the focus is on
    // that tag's «×», which the line describes; the border is dashed as well.
    await expect(page.locator('#review-tag-error')).toHaveText(`«#ранок»: ${DRAFT_TEXT['tag-invalid']}`)
    const remove = page.getByRole('button', { name: 'Прибрати тег «ранок»' })
    await expect(remove).toBeFocused()
    await expect(remove).toHaveAccessibleDescription(`«#ранок»: ${DRAFT_TEXT['tag-invalid']}`)
    expect(await wrong.evaluate((node) => getComputedStyle(node).borderTopStyle)).toBe('dashed')
    await expect(page.locator('#review-tag-input')).not.toBeFocused()
    // The next edit clears the issues, and the line with them.
    await page.locator('#thesis-b2').fill('Синтетична теза після правки.')
    await expect(page.locator('#review-tag-error')).toHaveText('')
    await expect(wrong).not.toHaveClass(/tagpill--invalid/)
    expect((api.bodies('POST /summaries')[1] as { tags: unknown[] }).tags).toEqual([
      { name: 'стосунки', source: 'ai' },
      { name: 'ранок', source: 'user' },
    ])

    // Two wrong tags at once: the line names both, and each «×» is described by all of it.
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    const both = `«#стосунки»: ${DRAFT_TEXT['tag-invalid']} «#ранок»: ${DRAFT_TEXT['tag-invalid']}`
    await expect(page.locator('#review-tag-error')).toHaveText(both)
    for (const name of ['стосунки', 'ранок']) {
      await expect(page.locator('.tagpill', { hasText: `#${name}` })).toHaveClass(/tagpill--invalid/)
      await expect(page.getByRole('button', { name: `Прибрати тег «${name}»` })).toHaveAccessibleDescription(both)
    }
    await expect(page.getByRole('button', { name: 'Прибрати тег «стосунки»' })).toBeFocused()
    expect(api.count('POST /summaries')).toBe(3)
  })

  test('#32 theses: a 502 offers «Скласти ще раз», and it works', async ({ page, api }) => {
    api.on('POST /chat/summarize', fail(502, 'llm_failed'), { json: DRAFT })
    await openChat(page)
    await exchange(page)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'summarizing')
    await expect(page.locator('[data-el="sum-status"]')).toHaveText(summarizeError(uiError('llm_failed', { status: 502 }), 0, null).why)
    await page.getByRole('button', { name: 'Скласти ще раз' }).click()
    await onScreen(page, 'review')
    expect(api.count('POST /chat/summarize')).toBe(2)
  })

  test('#32 theses: «Скасувати» while the AI drafts goes back to the same conversation', async ({ page, api }) => {
    const held = gate()
    api.on('POST /chat/summarize', async () => {
      await held.wait
      return { json: DRAFT }
    })
    await openChat(page)
    await exchange(page, USER)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'summarizing')
    await axe(page, 'summarizing')
    await page.getByRole('button', { name: 'Скасувати й повернутися до розмови' }).click()
    await onScreen(page, 'chat')
    await expect(lastUser(page)).toContainText(USER)
    await expect(aiMessages(page).nth(1)).toContainText(REPLY_TEXT)
    held.open()
  })

  test('#32c llm_busy on the theses: the countdown is said once, its seconds are not live; a pagehide cancels the retry for good and offers «Скласти ще раз»', async ({ page, api }) => {
    await page.clock.install()
    api.on('POST /chat/summarize', fail(503, 'llm_busy', undefined, { 'retry-after': '30' }), { json: DRAFT })
    await openChat(page)
    await exchange(page)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'summarizing')
    // The live part says what happened; the ticking seconds stand beside it, outside it (§5.7):
    // readable in browse mode (not aria-hidden), never announced.
    await expect(page.locator('[data-el="sum-status"]')).toHaveText(BUSY_NOW)
    const countdown = page.locator('[data-el="sum-countdown"]')
    await expect(countdown).toContainText('Пробуємо ще раз через')
    await expect(countdown).not.toHaveAttribute('aria-hidden', 'true')
    expect(await countdown.evaluate((node) => node.closest('[role="status"], [aria-live]') === null)).toBe(true)
    await expect(announcer(page)).toHaveText('Пробуємо ще раз через 30 секунд')
    // The page is hidden before the scheduled retry: it never goes, and the screen says so.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    const retry = page.getByRole('button', { name: 'Скласти ще раз' })
    await expect(retry).toBeVisible()
    await expect(countdown).toHaveText('')
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    // Past the moment the retry was due: still the one request.
    await page.clock.runFor(31_000)
    expect(api.count('POST /chat/summarize')).toBe(1)
    await retry.click()
    await onScreen(page, 'review')
    expect(api.count('POST /chat/summarize')).toBe(2)
  })

  test('#33 «Видалити тези»: a confirm, no POST, the ended screen', async ({ page, api }) => {
    await openChat(page)
    await exchange(page)
    await toReview(page)
    await page.getByRole('button', { name: 'Видалити тези' }).click()
    const confirm = confirmDialog(page)
    await expect(confirm).toContainText('Видалити тези?')
    await expect(confirm.getByRole('button', { name: 'Залишити' })).toBeFocused()
    await axe(page, 'confirm discard')
    await confirm.getByRole('button', { name: 'Видалити', exact: true }).click()
    await onScreen(page, 'ended')
    expect(api.count('POST /summaries')).toBe(0)
    await expect(announcer(page)).toHaveText('')
    await axe(page, 'ended')
  })

  test('#34 «Не зберігати»: no «Зберегти», «Готово» ends, nothing is posted', async ({ page, api }) => {
    await openChat(page)
    const toggle = page.getByRole('switch', { name: 'Не зберігати цю розмову' })
    await expect(page.locator('[data-el="nosave-state"]')).toHaveText('Вимкнено')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('[data-el="nosave-state"]')).toHaveText('Увімкнено')
    await exchange(page)
    await expect(page.locator('[data-el="session-nosave"]')).toBeVisible()
    await toReview(page)
    await expect(page.locator('[data-el="review-save"]')).toBeHidden()
    await expect(page.locator('[data-el="review-nosave"]')).toBeVisible()
    await axe(page, 'review in «не зберігати»')
    await page.getByRole('button', { name: 'Готово' }).click()
    await onScreen(page, 'ended')
    expect(api.count('POST /summaries')).toBe(0)
  })

  test('#35 the save failed on the network but the record exists: saved without a second POST', async ({ page, api }) => {
    const stored = storedFrom({ scenario: 'free', title: DRAFT.title, bullets: DRAFT.bullets, tags: DRAFT.tags.map((name) => ({ name, source: 'ai' })) })
    api.on('POST /summaries', { abort: true }, (call) => ({ status: 201, json: storedFrom(call.body) }))
    api.on('GET /summaries', (call) =>
      call.query.get('limit') === '1'
        ? { json: diary([{ ...stored, created_at: '2026-10-07T12:00:00Z' }]), headers: { date: 'Wed, 07 Oct 2026 12:00:30 GMT' } }
        : { json: diary() },
    )
    await openChat(page)
    await exchange(page)
    await toReview(page)
    const save = page.locator('[data-el="review-save"]')
    await save.click()
    await expect(page.locator('[data-el="review-error"]')).toHaveText(saveError(uiError('save_unknown'), 0).why)
    await expect(save).toHaveText('Спробувати ще раз')
    await save.click()
    await onScreen(page, 'saved')
    expect(api.count('POST /summaries')).toBe(1)
    expect(api.of('GET /summaries').some((call) => call.query.get('limit') === '1')).toBe(true)
  })

  test('#35 the newest record has the same title but other theses: the second POST goes', async ({ page, api }) => {
    const other = storedFrom({ scenario: 'free', title: DRAFT.title, bullets: ['Зовсім інша теза.'], tags: [] })
    api.on('POST /summaries', { abort: true }, (call) => ({ status: 201, json: storedFrom(call.body) }))
    api.on('GET /summaries', (call) =>
      call.query.get('limit') === '1' ? { json: diary([other]), headers: { date: 'Wed, 07 Oct 2026 12:00:30 GMT' } } : { json: diary() },
    )
    await openChat(page)
    await exchange(page)
    await toReview(page)
    const save = page.locator('[data-el="review-save"]')
    await save.click()
    await expect(save).toHaveText('Спробувати ще раз')
    await save.click()
    await onScreen(page, 'saved')
    expect(api.count('POST /summaries')).toBe(2)
    expect(api.of('POST /summaries')[1]!.raw).toBe(api.of('POST /summaries')[0]!.raw)
  })

  test('#35c the save was not confirmed, then «Видалити тези»: nothing claims the diary got nothing', async ({ page, api }) => {
    api.on('POST /summaries', { abort: true })
    await openChat(page)
    await exchange(page)
    await toReview(page)
    const save = page.locator('[data-el="review-save"]')
    await save.click()
    await expect(save).toHaveText('Спробувати ще раз')
    await page.getByRole('button', { name: 'Видалити тези' }).click()
    const confirm = confirmDialog(page)
    await expect(confirm.locator('[data-if="maybe-saved"]')).toBeVisible()
    // The draft on screen may never have gone out: only the conversation's theses may be there.
    await expect(confirm.locator('[data-if="maybe-saved"]')).toContainText('можливо, тези з цієї розмови вже є у вашому щоденнику')
    await expect(confirm.locator('[data-if="not-maybe-saved"]')).toBeHidden()
    await axe(page, 'confirm discard after an unconfirmed save')
    await confirm.getByRole('button', { name: 'Видалити', exact: true }).click()
    await onScreen(page, 'ended')
    await expect(page.locator('[data-el="ended-maybe"]')).toBeVisible()
    await expect(page.locator('[data-el="ended-none"]')).toBeHidden()
    await expect(page.locator('#ended-maybe-title')).toBeFocused()
    await expect(page.locator('section[data-screen="ended"]')).toHaveAttribute('aria-labelledby', 'ended-maybe-title')
    await axe(page, 'ended after an unconfirmed save')
    // A new conversation, ended without theses: «нічого не потрапило» is true again.
    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    await exchange(page)
    await endWithoutTheses(page)
    await expect(page.locator('[data-el="ended-none"]')).toBeVisible()
    await expect(page.locator('#ended-title')).toBeFocused()
  })
})

// ── The account ──────────────────────────────────────────────────────────────────────────────

test.describe('account', () => {
  test('#36 the account sheet: email, downloads, consents; Esc gives focus back; each stacked confirm returns focus inside the sheet', async ({ page }) => {
    await openChat(page)
    await exchange(page)
    const toggle = accountToggle(page)
    const sheet = accountSheet(page)
    await toggle.click()
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('[data-el="account-email"]')).toHaveText(EMAIL)
    const exports = sheet.locator('a[href^="/api/v1/export"]')
    await expect(exports).toHaveCount(2)
    for (const link of await exports.all()) await expect(link).toHaveAttribute('download', '')
    for (const kind of KINDS) await expect(sheet.locator(`[data-grant-date="${kind}"]`)).toHaveText('надано 06.10.2026')
    await axe(page, 'account sheet')
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(toggle).toBeFocused()

    const stacked: [Locator, string][] = [
      [sheet.getByRole('button', { name: 'Вийти', exact: true }), 'Вийти з акаунта?'],
      [sheet.getByRole('button', { name: 'Видалити акаунт…' }), 'Видалити акаунт назавжди?'],
      [sheet.locator('[data-act="revoke"][data-kind="data_processing"]'), 'Відкликати згоду на обробку даних?'],
    ]
    for (const [i, [opener, title]] of stacked.entries()) {
      await toggle.click()
      await expect(sheet).toBeVisible()
      await opener.click()
      const confirm = confirmDialog(page)
      await expect(confirm).toBeVisible()
      await expect(confirm).toContainText(title)
      await expect(sheet).toBeVisible()
      if (i === 0) await axe(page, 'account sheet with confirm(logout) over it')
      await confirm.getByRole('button', { name: 'Скасувати' }).click()
      await expect(confirm).toBeHidden()
      await expect(sheet).toBeVisible()
      await expect(opener).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
    }
  })

  test('#37 «Вийти» in the middle of a conversation: confirm, POST /auth/logout, «Ви вийшли…»', async ({ page, api }) => {
    await openChat(page)
    await exchange(page, USER)
    await accountToggle(page).click()
    await accountSheet(page).getByRole('button', { name: 'Вийти', exact: true }).click()
    await confirmDialog(page).getByRole('button', { name: 'Вийти', exact: true }).click()
    await onScreen(page, 'signed-out')
    await expect(page.locator('[data-el="signin-banner-text"]')).toHaveText(signInBanner({ kind: 'logged-out' }).text)
    expect(api.count('POST /auth/logout')).toBe(1)
    await expect(announcer(page)).toHaveText('')
    expect((await markup(page)).includes(USER)).toBe(false)
    await expect(accountToggle(page)).toBeHidden()
    await axe(page, 'signed-out after the logout')
  })

  test('#37b «Вийти» from «Збережено»: the saved record leaves the page with the session', async ({ page, api }) => {
    await openChat(page)
    await exchange(page)
    await toReview(page)
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    await onScreen(page, 'saved')
    await expect(page.locator('[data-el="saved-title"]')).toHaveText(DRAFT.title)
    await accountToggle(page).click()
    await accountSheet(page).getByRole('button', { name: 'Вийти', exact: true }).click()
    await onScreen(page, 'signed-out')
    expect(api.count('POST /auth/logout')).toBe(1)
    const after = await markup(page)
    for (const text of [DRAFT.title, ...DRAFT.bullets]) expect(after.includes(text), text).toBe(false)
    // The account sheet was opened for «Вийти»: closed, it keeps no email either.
    expect(after.includes(EMAIL), 'the email in the closed account sheet').toBe(false)
  })

  test('#38 delete the account: focus starts on «Скасувати»; 204 → account-deleted', async ({ page, api, consoleLines }) => {
    await openChat(page)
    await accountToggle(page).click()
    await accountSheet(page).getByRole('button', { name: 'Видалити акаунт…' }).click()
    const confirm = confirmDialog(page)
    await expect(confirm.getByRole('button', { name: 'Скасувати' })).toBeFocused()
    await expect(confirm).toContainText('Ollama Cloud (Ollama Inc.)')
    // The name already has its brackets: no «(Ollama Cloud (Ollama Inc.))».
    await expect(confirm).not.toContainText('(Ollama Cloud')
    await axe(page, 'confirm delete-account')
    await confirm.getByRole('button', { name: 'Так, видалити все' }).click()
    await onScreen(page, 'account-deleted')
    await expect(page.locator('[data-el="deleted-confirmed"]')).toBeVisible()
    await expect(page.locator('[data-el="deleted-presumed"]')).toBeHidden()
    expect(api.count('DELETE /me')).toBe(1)
    await expect(announcer(page)).toHaveText('')
    await axe(page, 'account-deleted')
    await storageAudit(page, null, consoleLines)
  })

  test('#38 delete: the network fails, the repeat gets 401 → «Схоже, акаунт уже видалено…», no sign-in banner', async ({ page, api }) => {
    api.on('DELETE /me', { abort: true }, fail(401, 'unauthenticated'))
    await openChat(page)
    await accountToggle(page).click()
    await accountSheet(page).getByRole('button', { name: 'Видалити акаунт…' }).click()
    const confirm = confirmDialog(page)
    const accept = confirm.getByRole('button', { name: 'Так, видалити все' })
    await accept.click()
    await expect(confirm.locator('[data-op-error]')).toHaveText(accountOpError('delete-account', uiError('delete_unknown')).why)
    await accept.click()
    await onScreen(page, 'account-deleted')
    await expect(page.locator('[data-el="deleted-presumed"]')).toBeVisible()
    await expect(page.locator('[data-el="deleted-confirmed"]')).toBeHidden()
    await expect(page.locator('body')).not.toContainText('Увійдіть, щоб видалити акаунт')
    expect(api.count('DELETE /me')).toBe(2)
  })

  test('#38 delete: 401 on the first attempt → sign in again to delete', async ({ page, api }) => {
    api.on('DELETE /me', fail(401, 'unauthenticated'))
    await openChat(page)
    await accountToggle(page).click()
    await accountSheet(page).getByRole('button', { name: 'Видалити акаунт…' }).click()
    await confirmDialog(page).getByRole('button', { name: 'Так, видалити все' }).click()
    await onScreen(page, 'signed-out')
    await expect(page.locator('[data-el="signin-banner-text"]')).toHaveText(signInBanner({ kind: 'delete-relogin' }).text)
    // No sign-in failed: the session ended. The label belongs to a failed return from Google.
    await expect(page.locator('[data-el="signin-banner-label"]')).toBeHidden()
  })

  test('#39 revoking data_processing warns about the diary, goes to the consent, and the diary is empty after it', async ({ page, api }) => {
    let revoked = false
    api.on('GET /summaries', () => ({ json: diary(revoked ? [] : RECORDS) }))
    api.on('DELETE /consents/data_processing', () => {
      revoked = true
      return { json: consents(['data_processing']) }
    })
    await openChat(page)
    await accountToggle(page).click()
    await accountSheet(page).locator('[data-act="revoke"][data-kind="data_processing"]').click()
    const confirm = confirmDialog(page)
    await expect(confirm).toContainText('одразу видалить увесь ваш щоденник')
    await axe(page, 'confirm revoke data_processing')
    await confirm.getByRole('button', { name: 'Відкликати й видалити щоденник' }).click()
    await onScreen(page, 'consent')
    expect(api.count('DELETE /consents/data_processing')).toBe(1)
    await expect(page.locator('input[data-kind="data_processing"]')).not.toBeChecked()
    await expect(page.locator('input[data-kind="llm_transfer"]')).toBeChecked()
    await page.locator('input[data-kind="data_processing"]').check()
    await page.getByRole('button', { name: 'Погоджуюся — почати' }).click()
    await onScreen(page, 'chat')
    expect(api.bodies('POST /consents')).toEqual([{ policy_version: VERSION, kinds: ['data_processing'] }])
    await scenarioList(page).getByRole('radio', { name: 'Повернення до теми' }).check()
    await expect(page.locator('[data-el="scenario-text"]')).toHaveText(REVISIT_EMPTY)
    await expect(page.locator('[data-el="revisit-open"]')).toBeHidden()
  })
})

// ── Page life ────────────────────────────────────────────────────────────────────────────────

test.describe('page life', () => {
  test('#40 beforeunload: not in a new conversation; from the first message on; gone after saved, ended and the crisis', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply() }, { sse: reply() }, { sse: meta() + crisis('keyword') })
    await openChat(page)
    expect(await beforeUnload(page)).toBe(0)
    await exchange(page)
    expect(await beforeUnload(page)).toBe(1)
    await toReview(page)
    expect(await beforeUnload(page)).toBe(1)
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    await onScreen(page, 'saved')
    expect(await beforeUnload(page)).toBe(0)

    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    expect(await beforeUnload(page)).toBe(0)
    await exchange(page)
    expect(await beforeUnload(page)).toBe(1)
    await endWithoutTheses(page)
    expect(await beforeUnload(page)).toBe(0)

    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    expect(await beforeUnload(page)).toBe(0)
  })

  test('#40b a tel: link in «Якщо важко» does not ask «Покинути сайт?»; the guard is back once the window has focus', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium fires beforeunload on tel:')
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.dismiss().catch(() => {})
    })
    await openChat(page)
    await exchange(page)
    expect(await beforeUnload(page)).toBe(1)
    await page.locator('.help-link').click()
    const help = page.locator('#help-dialog')
    await expect(help).toBeVisible()
    await help.locator('a[href="tel:112"]').click()
    await page.waitForTimeout(500)
    expect(dialogs).toEqual([])
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    expect(await beforeUnload(page)).toBe(1)
  })

  test('#40b a tel: link on not-invited with the conversation kept does not ask either', async ({ page, api, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium fires beforeunload on tel:')
    api.on('POST /chat/turn', fail(403, 'not_invited'))
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.dismiss().catch(() => {})
    })
    await openChat(page)
    await send(page, USER)
    await onScreen(page, 'not-invited')
    expect(await beforeUnload(page)).toBe(1)
    await page.locator('section[data-screen="not-invited"] .helpblock a[href="tel:112"]').click()
    await page.waitForTimeout(500)
    expect(dialogs).toEqual([])
  })

  test('#41 back from the bfcache after the session ended: the conversation and the live region are wiped', async ({ page, api }) => {
    await openChat(page)
    await exchange(page, USER)
    api.on('GET /me', fail(401, 'unauthenticated'))
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await onScreen(page, 'signed-out')
    await expect(talk(page).locator('li')).toHaveCount(0)
    const after = await markup(page)
    expect(after.includes(USER)).toBe(false)
    expect(after.includes(REPLY_TEXT)).toBe(false)
    await expect(announcer(page)).toHaveText('')
  })

  test('#41b «Піти»: the conversation is gone before the page is kept for «Назад»; the restored page starts clean', async ({ page, api }) => {
    // The landing answers 204, so the browser stays on this document: the test plays the pagehide
    // and the restore from the bfcache that «Піти» → «Назад» would give.
    await page.route((url) => url.pathname === '/', (route) => route.fulfill({ status: 204 }))
    await openChat(page)
    await exchange(page, USER)
    await page.locator('.chat-header .brand').click()
    const confirm = confirmDialog(page)
    await expect(confirm).toContainText('Піти з розмови?')
    await confirm.getByRole('button', { name: 'Піти', exact: true }).click()
    await expect(confirm).toBeHidden()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    const kept = await markup(page)
    expect(kept.includes(USER), 'the message in the page the bfcache keeps').toBe(false)
    expect(kept.includes(REPLY_TEXT), 'the answer in the page the bfcache keeps').toBe(false)
    await expect(announcer(page)).toHaveText('')
    // «Назад»: the session is alive, the page boots again — a new, empty conversation.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await onScreen(page, 'chat')
    await expect(userMessages(page)).toHaveCount(0)
    expect((await markup(page)).includes(USER)).toBe(false)
    expect(new URL(page.url()).pathname).toBe('/chat/')
    expect(api.count('GET /me')).toBe(2)
  })

  test('#41c «Піти» from the theses: the text left in the field goes with the conversation too', async ({ page }) => {
    await page.route((url) => url.pathname === '/', (route) => route.fulfill({ status: 204 }))
    await openChat(page)
    await exchange(page, USER)
    const draft = 'Синтетична чернетка, що лишилася в полі.'
    await composer(page).fill(draft)
    await toReview(page)
    await page.locator('.chat-header .brand').click()
    await confirmDialog(page).getByRole('button', { name: 'Піти', exact: true }).click()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await onScreen(page, 'chat')
    // «Як після першого завантаження, без … чернетки» (§5.6). outerHTML never holds a field's value,
    // so the field itself is asked.
    await expect(composer(page)).toHaveValue('')
  })

  test('#41d «Піти з розмови?» advises only what can be done: summarize in the conversation, save on the theses', async ({ page }) => {
    const confirm = confirmDialog(page)
    const brand = page.locator('.chat-header .brand')
    const summarizeLine = confirm.locator('p[data-if="can-summarize"]')
    const saveLine = confirm.locator('p[data-if="review-save"]')
    await openChat(page)
    await exchange(page)
    await brand.click()
    await expect(confirm).toContainText('Піти з розмови?')
    await expect(summarizeLine).toBeVisible()
    await expect(confirm.getByRole('button', { name: 'Підсумувати' })).toBeVisible()
    await expect(saveLine).toBeHidden()
    await confirm.getByRole('button', { name: 'Залишитися' }).click()
    // On the theses the way to keep them is the save, not a summary.
    await toReview(page)
    await brand.click()
    await expect(saveLine).toBeVisible()
    await expect(summarizeLine).toBeHidden()
    await expect(confirm.getByRole('button', { name: 'Підсумувати' })).toBeHidden()
    await confirm.getByRole('button', { name: 'Залишитися' }).click()
    // «Не зберігати»: neither piece of advice.
    await page.getByRole('button', { name: 'Повернутися до розмови' }).click()
    await endWithoutTheses(page)
    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    await page.getByRole('switch', { name: 'Не зберігати цю розмову' }).click()
    await exchange(page)
    await brand.click()
    await expect(confirm).toContainText('Піти з розмови?')
    await expect(summarizeLine).toBeHidden()
    await expect(saveLine).toBeHidden()
    await confirm.getByRole('button', { name: 'Залишитися' }).click()
    await toReview(page)
    await brand.click()
    await expect(saveLine).toBeHidden()
    await expect(summarizeLine).toBeHidden()
  })

  test('#42 the live region: at most two writes for a 50-token answer; empty 5 s after it and when the conversation ends', async ({ page, api }) => {
    await page.clock.install()
    const words = Array.from({ length: 50 }, (_, i) => `слово${i + 1} `)
    api.on('POST /chat/turn', { sse: reply(words) })
    await openChat(page)
    const before = (await announced(page)).length
    await exchange(page)
    const writes = (await announced(page)).slice(before).filter((text) => text !== '')
    expect(writes.length).toBeLessThanOrEqual(2)
    expect(writes.at(-1)).toBe(`Відповідь AI: ${words.join('')}`)
    await page.clock.runFor(5_000)
    await expect(announcer(page)).toHaveText('')
    await exchange(page)
    await expect(announcer(page)).not.toHaveText('')
    await endWithoutTheses(page)
    await expect(announcer(page)).toHaveText('')
  })

  test('#45 «Пауза»: nothing animates any more, the scene stays off', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    const running = (): Promise<number> =>
      page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSAnimation && a.playState === 'running').length)
    await expect.poll(running).toBeGreaterThan(0)
    await page.locator('[data-motion-toggle]').click()
    await expect(html(page)).toHaveAttribute('data-motion', 'off')
    await expect.poll(running).toBe(0)
    await expect(html(page)).toHaveAttribute('data-gl', 'off')
  })
})

// ── Help ─────────────────────────────────────────────────────────────────────────────────────

test.describe('help', () => {
  test('#51 «Якщо важко» opens over a running answer without cutting it; the lines come sanitized; the sound goes quiet', async ({ page, api, browserName }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    const sound = browserName === 'chromium'
    if (sound) {
      await page.locator('[data-sound-toggle]').click()
      await expect(html(page)).toHaveAttribute('data-sound', 'on')
    }
    await send(page, USER)
    await stream.requests(1)
    await stream.write(meta() + token(PARTIAL[0]!))
    await page.locator('.help-link').click()
    const help = page.locator('#help-dialog')
    await expect(help).toBeVisible()
    if (sound) await expect(html(page)).toHaveAttribute('data-sound', 'muted')
    await expectSafeLines(help.locator('[data-el="help-lines"]'))
    await expect(help.locator('[data-el="help-kept"]')).toBeVisible()
    await expect(help.locator('a[href="tel:112"]')).toHaveCount(1)
    await expect(help.locator('a[href="tel:103"]')).toHaveCount(1)
    expect(api.count('GET /helplines')).toBe(1)
    await axe(page, 'help dialog')
    expect((await stream.info()).aborted).toBe(false)
    await stream.write(token(PARTIAL[1]!) + done())
    // The page under a modal dialog is inert, and so would be a live region left there: the answer
    // is said from inside the dialog (WCAG 4.1.3).
    await expect(help.locator('[data-announcer]')).toHaveText(`Відповідь AI: ${PARTIAL.slice(0, 2).join('')}`)
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden()
    await expect(page.locator('body > [data-announcer]')).toHaveCount(1)
    await expect(page.locator('.help-link')).toBeFocused()
    await answered(page, 1)
    await expect(aiMessages(page).nth(1).locator('.said__text')).toHaveText(PARTIAL.slice(0, 2).join(''))
    if (sound) await expect(html(page)).toHaveAttribute('data-sound', 'on')
  })
})

// ── Layout ───────────────────────────────────────────────────────────────────────────────────

/** Which sticky layers the focused element's box overlaps, once scrolling has stopped: with motion
 *  allowed html scrolls smoothly, and the focus scroll may still be running when Tab returns. The
 *  geometry goes into the failure message. */
async function coveredBy(page: Page, layers: readonly string[]): Promise<Readonly<{ hits: string[]; geometry: string }>> {
  return page.evaluate(async (selectors) => {
    await new Promise<void>((resolve) => {
      const started = performance.now()
      let last = `${window.scrollX},${window.scrollY}`
      let still = 0
      const tick = (): void => {
        const now = `${window.scrollX},${window.scrollY}`
        still = now === last ? still + 1 : 0
        last = now
        if (still >= 5 || performance.now() - started > 2_000) resolve()
        else window.requestAnimationFrame(tick)
      }
      window.requestAnimationFrame(tick)
    })
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) return { hits: ['no focus'], geometry: '' }
    const box = focused.getBoundingClientRect()
    const css = getComputedStyle(document.documentElement)
    const span = (r: DOMRect): string => `${Math.round(r.top)}..${Math.round(r.bottom)}`
    const parts = [`scrollY ${Math.round(window.scrollY)}`, `viewport ${document.documentElement.clientHeight}`, `padding ${css.scrollPaddingTop}/${css.scrollPaddingBottom}`, `focus ${span(box)}`]
    const hits: string[] = []
    for (const selector of selectors) {
      const layer = document.querySelector<HTMLElement>(selector)
      if (!layer || !layer.isConnected || layer.closest('[hidden]') !== null || layer.contains(focused)) continue
      const r = layer.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      parts.push(`${selector} ${span(r)}`)
      if (box.left < r.right && r.left < box.right && box.top < r.bottom && r.top < box.bottom) hits.push(selector)
    }
    return { hits, geometry: parts.join('; ') }
  }, layers)
}

/** Moves focus with Tab from `from` (focused without scrolling) until `target` has it. */
async function tabTo(page: Page, from: Locator, target: Locator, key: 'Tab' | 'Shift+Tab' = 'Tab'): Promise<void> {
  await from.evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }))
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(key)
    if (await target.evaluate((node) => node === document.activeElement)) return
  }
  throw new Error('Tab never reached the target')
}

const LAYERS = ['.site-header', '[data-el="session"]', '[data-el="composer"]'] as const

test.describe('layout', () => {
  test('#43 the composer stays in view at 1440 × 900 and on a Pixel 7; «Надіслати» sits in the middle of a one-line field', async ({ page }, testInfo) => {
    await openChat(page)
    await expect(composer(page)).toBeInViewport()
    // 6 px above and below the 44 px button on a desktop, 4 px on the phone (§3.7.3).
    const send = await page.evaluate(() => {
      const field = document.querySelector('#composer-input')!.getBoundingClientRect()
      const button = document.querySelector('[data-el="composer-send"]')!.getBoundingClientRect()
      return { above: button.top - field.top, below: field.bottom - button.bottom }
    })
    expect(Math.abs(send.above - send.below), JSON.stringify(send)).toBeLessThanOrEqual(1)
    expect(send.below, JSON.stringify(send)).toBeGreaterThanOrEqual(3)
    if (isDesktop(testInfo)) {
      // A new conversation is one screen high: the column's top offset is subtracted once, and the
      // focus put into the field does not scroll the page (§3.6).
      const fit = await page.evaluate(() => ({ scrollY: window.scrollY, extra: document.documentElement.scrollHeight - window.innerHeight }))
      expect(fit.scrollY, JSON.stringify(fit)).toBe(0)
      expect(fit.extra, JSON.stringify(fit)).toBeLessThanOrEqual(1)
      await expect(composer(page)).toBeFocused()
    }
    await exchange(page)
    await exchange(page)
    await expect(composer(page)).toBeInViewport()
  })

  test('#43 Pixel 7 (412 × 839), a new conversation: «Не зберігати» is in view above the composer, not under its fade', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'a phone layout')
    await openChat(page)
    await page.evaluate(() => document.fonts.ready)
    const where = await page.evaluate(() => {
      const toggle = document.querySelector('.nosave .switch')!.getBoundingClientRect()
      const bar = document.querySelector('[data-el="composer"]')!.getBoundingClientRect()
      return { scrollY: window.scrollY, viewport: window.innerHeight, switchBottom: Math.round(toggle.bottom), composerTop: Math.round(bar.top) }
    })
    // The composer's fade reaches 32 px above its box.
    expect(where.switchBottom, JSON.stringify(where)).toBeLessThanOrEqual(where.composerTop - 32)
    expect(where.scrollY, JSON.stringify(where)).toBe(0)
  })

  test('#43 at 1024 × 768 and 1100 × 800 the light stays out of the text column', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'the two-column layout')
    for (const size of [
      { width: 1024, height: 768 },
      { width: 1100, height: 800 },
    ]) {
      await page.setViewportSize(size)
      await openChat(page)
      const overlap = await page.evaluate(() => {
        const text = document.querySelector('.chat__text')!.getBoundingClientRect()
        return ['.presence__canvas', '.presence .orb'].filter((selector) => {
          const r = document.querySelector(selector)!.getBoundingClientRect()
          return r.width > 0 && r.left < text.right && text.left < r.right && r.top < text.bottom && text.top < r.bottom
        })
      })
      expect(overlap, `${size.width} px`).toEqual([])
    }
  })

  test('#43 nothing is cut off at 320 px or at 200 % zoom: consent, chat, review, crisis', async ({ page, api }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'one engine is enough for reflow')
    api.on('GET /consents', { json: CONSENTS_NONE })
    api.on('POST /chat/turn', { sse: reply() }, { sse: meta() + crisis('keyword') })
    const check = async (label: string): Promise<void> => {
      for (const size of [
        { width: 320, height: 640 },
        { width: 720, height: 450 },
      ]) {
        await page.setViewportSize(size)
        await page.evaluate(() => document.fonts.ready)
        expect(await cutOffAtEdges(page), `${label} at ${size.width} px`).toEqual([])
        expect(await page.evaluate(() => window.innerWidth), `${label}: the layout viewport did not widen`).toBe(size.width)
      }
    }
    await openChat(page, '/chat/', 'consent')
    await check('consent')
    for (const kind of KINDS) await page.locator(`input[data-kind="${kind}"]`).check()
    await page.getByRole('button', { name: 'Погоджуюся — почати' }).click()
    await onScreen(page, 'chat')
    await check('new conversation')
    await exchange(page)
    await check('conversation')
    // ≈ 360 px: the disclosure under the field breaks only at «·» — «не терапія» stays whole.
    await page.setViewportSize({ width: 360, height: 640 })
    expect(await page.locator('.composer__ai span').evaluateAll((spans) => spans.map((span) => span.getClientRects().length))).toEqual([1, 1, 1])
    // The phone's column for «AI» / «Ви» (§3.7.2).
    expect(await aiMessages(page).first().evaluate((node) => getComputedStyle(node).columnGap)).toBe('10px')
    await toReview(page)
    // A 40-character tag without a space wraps inside its pill; «Прибрати тег» stays on the screen.
    await page.locator('#review-tag-input').fill('тег'.repeat(13) + 'и')
    await page.locator('#review-tag-input').press('Enter')
    await expect(page.locator('.tagpill')).toHaveCount(DRAFT.tags.length + 1)
    // The theses grow by themselves: no resize grip.
    expect(await page.locator('.thesis__input').first().evaluate((node) => getComputedStyle(node).resize)).toBe('none')
    await check('review')
    await page.getByRole('button', { name: 'Повернутися до розмови' }).click()
    await onScreen(page, 'chat')
    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    await check('crisis')
  })

  test('#43d at 320 px long words wrap on the saved record, in the record picker and in the chosen names', async ({ page, api }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'one engine is enough for reflow')
    // 40 characters without a space (the longest tag), a thesis and a title with one long word.
    const tag = 'тег'.repeat(13) + 'и'
    const word = 'Синтетичнийдовгийрядокбезжодногопробілу'.repeat(3)
    api.on('POST /chat/summarize', { json: { ...DRAFT, bullets: [word, ...DRAFT.bullets.slice(1)], tags: [tag] } })
    const long = record(1, { title: word, bullets: [word], tags: [{ id: '00000000-0000-4000-9000-000000000177', name: tag, source: 'ai' }] })
    api.on('GET /summaries', { json: diary([long, record(2)]) })
    await page.setViewportSize({ width: 320, height: 640 })
    await openChat(page)
    await exchange(page)
    await toReview(page)
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    await onScreen(page, 'saved')
    await expect(page.locator('[data-el="saved-tags"]')).toHaveText(`#${tag}`)
    await page.evaluate(() => document.fonts.ready)
    expect(await cutOffAtEdges(page), 'saved').toEqual([])
    expect(await page.evaluate(() => window.innerWidth), 'saved: the layout viewport did not widen').toBe(320)

    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    await scenarioList(page).getByRole('radio', { name: 'Повернення до теми' }).check()
    await page.locator('[data-el="revisit-open"]').click()
    const dialog = pickDialog(page)
    await expect(dialog.locator('.pick__input')).toHaveCount(2)
    // The picker scrolls down, never sideways.
    const box = await dialog.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }))
    expect(box.scroll, `picker: ${JSON.stringify(box)}`).toBeLessThanOrEqual(box.client)
    await dialog.locator('.pick__input').first().check()
    await dialog.getByRole('button', { name: 'Продовжити (1)' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-el="revisit-names"]')).toHaveText(word)
    expect(await cutOffAtEdges(page), 'the chosen names').toEqual([])
  })

  test('#43e the session row breaks only at «·»: «не терапія» and «Не зберігати» stay whole at 375 and 412 px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'a phone layout')
    await openChat(page)
    await scenarioList(page).getByRole('radio', { name: 'Розбір дня' }).check()
    await page.getByRole('switch', { name: 'Не зберігати цю розмову' }).click()
    await exchange(page)
    await expect(page.locator('[data-el="session-nosave"]')).toBeVisible()
    await expect(page.locator('[data-el="session-end"]')).toBeVisible()
    for (const width of [375, 412]) {
      await page.setViewportSize({ width, height: 800 })
      await page.evaluate(() => document.fonts.ready)
      const parts = await page.locator('.session .keep').evaluateAll((spans) => spans.map((span) => `${span.textContent}: ${span.getClientRects().length}`))
      expect(parts, `${width} px`).toEqual(['Не зберігати: 1', 'Не людина: 1', 'не терапія: 1'])
    }
  })

  test('#43 Tab never leaves the focus under the header, the session row or the composer', async ({ page, api }) => {
    const long = Array.from({ length: 12 }, (_, i) => `Абзац ${i + 1}: синтетична відповідь, досить довга, щоб сторінка прокручувалася.\n\n`)
    api.on('POST /chat/turn', { sse: reply(long) }, { sse: meta() + streamError('llm_failed') })
    await openChat(page)
    const h1 = page.locator('#chat-title')
    // A new conversation: the scenario pills and the switch.
    await tabTo(page, h1, scenarioList(page).locator('input:checked'))
    const pill = await coveredBy(page, LAYERS)
    expect(pill.hits, `scenario pill: ${pill.geometry}`).toEqual([])
    await tabTo(page, h1, page.getByRole('switch', { name: 'Не зберігати цю розмову' }))
    const toggle = await coveredBy(page, LAYERS)
    expect(toggle.hits, `switch: ${toggle.geometry}`).toEqual([])

    await exchange(page)
    await send(page, 'Друге синтетичне повідомлення.')
    const unsent = lastUser(page)
    await expect(unsent.locator('.said__why')).toHaveText(why('llm_failed'))
    for (const name of ['Надіслати ще раз', 'Змінити']) {
      await tabTo(page, h1, unsent.getByRole('button', { name }))
      const action = await coveredBy(page, LAYERS)
      expect(action.hits, `${name}: ${action.geometry}`).toEqual([])
    }

    // «↓ До кінця» shows while the end of the conversation is under the composer; it lives in the
    // composer, so only the header and the session row count for it.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    const jump = page.locator('[data-el="jump"]')
    await expect(jump).toBeVisible()
    await tabTo(page, composer(page), jump, 'Shift+Tab')
    const pillDown = await coveredBy(page, ['.site-header', '[data-el="session"]'])
    expect(pillDown.hits, `the «↓» pill: ${pillDown.geometry}`).toEqual([])
    // Its name is what it shows (WCAG 2.5.3): «натиснути До кінця» works by voice.
    await expect(jump).toHaveAccessibleName('До кінця')
    // Pressed from the keyboard with motion on (smooth scrolling): the page jumps at once, the pill
    // goes, the focus lands in the field — never on <body> (I6).
    await page.keyboard.press('Enter')
    await expect(jump).toBeHidden()
    await expect(composer(page)).toBeFocused()
  })

  test('#43b the /chat/ header fits at 320 px: wordmark, «Якщо важко», motion and sound, «Акаунт»', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'one engine is enough for the fit')
    await page.setViewportSize({ width: 320, height: 640 })
    await openChat(page)
    await page.evaluate(() => document.fonts.ready)
    await expect(accountToggle(page)).toBeVisible()
    for (const selector of ['.brand', '.help-link', '.media', '.account-toggle']) {
      const box = await page.locator(`.site-header ${selector}`).boundingBox()
      expect(box, selector).not.toBeNull()
      expect(box!.x + box!.width, selector).toBeLessThanOrEqual(320)
      expect(box!.x, selector).toBeGreaterThanOrEqual(0)
    }
  })

  test('#43c a phone on its side (839 × 200): the field and the last reply in view, nothing sticky but the composer', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'a phone layout')
    await page.setViewportSize({ width: 839, height: 200 })
    await openChat(page)
    await exchange(page)
    await expect(composer(page)).toBeInViewport()
    await expect(aiMessages(page).last()).toBeInViewport()
    expect(await page.locator('.chat-header').evaluate((node) => getComputedStyle(node).position)).toBe('absolute')
    expect(await page.locator('[data-el="session"]').evaluate((node) => getComputedStyle(node).position)).toBe('relative')
    await expect(page.locator('.composer__note')).toBeHidden()
    await expect(page.locator('.composer__ai')).toBeVisible()
  })

  test('#44 forced colors draw every control’s border; without them the fields’ borders are --color-text-dim', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough for computed styles')
    const DIM = 'rgb(132, 145, 141)'
    const border = (selector: string) =>
      page.locator(selector).first().evaluate((node) => {
        const style = getComputedStyle(node)
        return { style: style.borderTopStyle, width: parseFloat(style.borderTopWidth), color: style.borderTopColor }
      })
    await openChat(page)
    // A dialog stops the page's scrolling; the scrollbar's place stays, so nothing jumps sideways.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('scrollbar-gutter'))).toBe('stable')
    await page.emulateMedia({ forcedColors: 'active' })
    for (const selector of ['#composer-input', '[data-el="composer-send"]', '.pill', '.account-toggle', '.switch__track']) {
      const b = await border(selector)
      expect(b.style, selector).not.toBe('none')
      expect(b.width, selector).toBeGreaterThanOrEqual(1)
    }
    await page.emulateMedia({ forcedColors: 'none' })
    await composer(page).evaluate((node) => (node as HTMLElement).blur())
    expect((await border('#composer-input')).color).toBe(DIM)
    // The switch says its state in text, not only in colour.
    await expect(page.locator('[data-el="nosave-state"]')).toHaveText('Вимкнено')

    await exchange(page)
    await toReview(page)
    for (const selector of ['#review-title-input', '#thesis-b0', '#review-tag-input', '#pick-search-input']) {
      expect((await border(selector)).color, selector).toBe(DIM)
    }
  })

  test('#48 no <form> anywhere; every button is type="button"', async ({ page }) => {
    await openChat(page)
    await expect(page.locator('form')).toHaveCount(0)
    const found = await page.evaluate(() => {
      const roots: ParentNode[] = [document, ...Array.from(document.querySelectorAll('template')).map((t) => t.content)]
      const forms = roots.reduce((n, root) => n + root.querySelectorAll('form').length, 0)
      const buttons = roots.flatMap((root) => Array.from(root.querySelectorAll('button')))
      return { forms, untyped: buttons.filter((b) => b.getAttribute('type') !== 'button').map((b) => b.outerHTML.slice(0, 80)) }
    })
    expect(found).toEqual({ forms: 0, untyped: [] })
  })
})

// ── Headers, stop-list, accessibility ────────────────────────────────────────────────────────

test.describe('headers and copy', () => {
  test('#49 the preview sends production’s headers: the CSP, Permissions-Policy, no-store on /chat/ and a 308 for /chat', async ({ request }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'headers do not depend on the device')
    const chat = await request.get('/chat/')
    expect(chat.status()).toBe(200)
    expect(chat.headers()['content-security-policy']).toBe(CSP)
    expect(chat.headers()['permissions-policy']).toBe(PERMISSIONS)
    expect(chat.headers()['cache-control']).toBe('no-store')
    expect(await chat.text()).toContain('data-screen="chat"')
    const withQuery = await request.get('/chat/?auth_error=expired')
    expect(withQuery.headers()['cache-control']).toBe('no-store')
    const bare = await request.get('/chat', { maxRedirects: 0 })
    expect(bare.status()).toBe(308)
    expect(bare.headers()['location']).toBe('/chat/')
    expect(bare.headers()['cache-control']).toBe('no-store')
    const landing = await request.get('/')
    expect(landing.headers()['content-security-policy']).toBe(CSP)
    expect(landing.headers()['permissions-policy']).toBe(PERMISSIONS)
  })

  test('#50 the stop-list holds for every screen, dialog and confirm of /chat/', async ({ page }) => {
    await openChat(page)
    const text = await page.evaluate(() => {
      for (const section of Array.from(document.querySelectorAll<HTMLElement>('section[data-screen]'))) section.hidden = false
      for (const node of Array.from(document.querySelectorAll<HTMLElement>('main [hidden], dialog [hidden]'))) node.hidden = false
      for (const details of Array.from(document.querySelectorAll('details'))) details.open = true
      const holder = document.createElement('div')
      for (const tpl of Array.from(document.querySelectorAll<HTMLTemplateElement>('template[data-confirm]'))) holder.append(tpl.content.cloneNode(true))
      document.body.append(holder)
      for (const dialog of Array.from(document.querySelectorAll('dialog'))) if (!dialog.open) dialog.show()
      // Helpline names and the conversation are data, not our copy.
      for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-no-stoplist]'))) node.hidden = true
      const labels = Array.from(document.querySelectorAll('[aria-label], [title]')).map(
        (node) => `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`,
      )
      const description = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
      return [document.title, description, ...labels, document.body.innerText].join('\n').toLowerCase()
    })
    expect(text.length).toBeGreaterThan(5_000)
    for (const pattern of FORBIDDEN) expect(text, `forbidden phrase ${pattern}`).not.toMatch(pattern)
    expect(clinicalOffenders(text)).toEqual([])
  })
})

test.describe('accessibility', () => {
  test('#52 I6 within a screen: «Надіслати ще раз» and «Скасувати» hide once pressed and hand the focus on', async ({ page, api }, testInfo) => {
    await page.clock.install()
    api.on('POST /chat/turn', { sse: meta() + streamError('llm_failed') }, fail(503, 'llm_busy', undefined, { 'retry-after': '5' }))
    await openChat(page)
    // A desktop gets the field; a phone the screen's heading (the field would pop the keyboard).
    const next = isDesktop(testInfo) ? composer(page) : page.locator('#chat-title')
    await send(page, USER)
    const unsent = lastUser(page)
    const resend = unsent.getByRole('button', { name: 'Надіслати ще раз' })
    await expect(resend).toBeVisible()
    await resend.click()
    await expect(resend).toBeHidden()
    await expect(next).toBeFocused()
    const cancel = unsent.getByRole('button', { name: 'Скасувати' })
    await expect(cancel).toBeVisible()
    await cancel.click()
    await expect(unsent.locator('.said__flag')).toHaveText('Відповідь зупинено')
    await expect(cancel).toBeHidden()
    await expect(next).toBeFocused()
  })

  test('#53 the live lines of the screens are rendered while still empty: a region shown together with its text may go unheard (§5.7)', async ({ page, api }) => {
    const held = gate()
    api.on(
      'POST /chat/summarize',
      async () => {
        await held.wait
        return fail(502, 'llm_failed')
      },
      { json: DRAFT },
    )
    /** In the accessibility tree (a box, no [hidden] or display: none on the way up) and empty. */
    const empty = (selector: string) =>
      page.locator(selector).evaluate((node) => ({ rendered: node.getClientRects().length > 0 && node.closest('[hidden]') === null, text: node.textContent }))
    await openChat(page)
    for (const selector of ['[data-el="composer-status"]', '[data-el="chat-line"]']) expect(await empty(selector), selector).toEqual({ rendered: true, text: '' })
    await exchange(page)
    for (const selector of ['[data-el="composer-status"]', '[data-el="chat-line"]']) expect(await empty(selector), selector).toEqual({ rendered: true, text: '' })
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'summarizing')
    expect(await empty('[data-el="sum-status"]')).toEqual({ rendered: true, text: '' })
    held.open()
    const status = page.locator('[data-el="sum-status"]')
    await expect(status).toHaveText(summarizeError(uiError('llm_failed', { status: 502 }), 0, null).why)
    await expect(status).toBeVisible()
    await page.getByRole('button', { name: 'Скласти ще раз' }).click()
    await onScreen(page, 'review')
    expect(await empty('#review-tag-error')).toEqual({ rendered: true, text: '' })
    // Empty, they take no room: no gap of the screen opens around them.
    expect(await page.locator('#review-tag-error').evaluate((node) => getComputedStyle(node).position)).toBe('absolute')
  })

  test('axe: booting, signed-out with and without the banner, not-invited without a session', async ({ page, api }) => {
    const held = gate()
    api.on('GET /me', async () => {
      await held.wait
      return fail(401, 'unauthenticated')
    })
    await page.goto('/chat/')
    await expect(html(page)).toHaveAttribute('data-screen', 'booting')
    await axe(page, 'booting')
    held.open()
    await onScreen(page, 'signed-out')
    await expect(page.locator('[data-el="signin-banner"]')).toBeHidden()
    await axe(page, 'signed-out')
    await openChat(page, '/chat/?auth_error=expired', 'signed-out')
    await expect(page.locator('[data-el="signin-banner"]')).toBeVisible()
    await axe(page, 'signed-out with the banner')
    await openChat(page, '/chat/?auth_error=not_invited', 'not-invited')
    await axe(page, 'not-invited without a session')
  })

  test('axe: the conversation idle and while the answer streams', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    await stream.write(meta() + token(PARTIAL[0]!))
    await expect(page.locator('.said--streaming')).toHaveCount(1)
    await axe(page, 'conversation while the answer streams')
    await stream.write(token(PARTIAL[1]!) + done())
    await answered(page, 1)
    await axe(page, 'conversation idle')
  })

  test('axe: the confirms of the conversation and of the theses', async ({ page }) => {
    await openChat(page)
    await exchange(page)
    const confirm = confirmDialog(page)
    await page.locator('[data-el="session-end"]').click()
    await expect(confirm).toContainText('Завершити розмову?')
    await axe(page, 'confirm end')
    await confirm.getByRole('button', { name: 'Завершити без тез' }).click()
    await expect(confirm).toContainText('Завершити без тез?')
    await expect(confirm.getByRole('button', { name: 'Назад' })).toBeFocused()
    await axe(page, 'confirm end-no-theses')
    await confirm.getByRole('button', { name: 'Назад' }).click()
    await expect(confirm).toContainText('Завершити розмову?')
    await confirm.getByRole('button', { name: 'Повернутися до розмови' }).click()
    await expect(confirm).toBeHidden()

    // The wordmark with a conversation on the page asks first.
    await page.locator('.chat-header .brand').click()
    await expect(confirm).toContainText('Піти з розмови?')
    await axe(page, 'confirm leave')
    await confirm.getByRole('button', { name: 'Залишитися' }).click()
    await expect(confirm).toBeHidden()
    await expect(page).toHaveURL(/\/chat\/$/)

    await toReview(page)
    await page.getByRole('button', { name: 'Скласти заново' }).click()
    await expect(confirm).toContainText('Скласти тези заново?')
    await axe(page, 'confirm regenerate')
    await confirm.getByRole('button', { name: 'Скасувати' }).click()
    await expect(confirm).toBeHidden()
    await axe(page, 'review')
  })

  test('axe: the consent confirms in the sheet, the crisis restart, session-expired', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply() }, { sse: meta() + crisis('keyword') }, fail(401, 'unauthenticated'))
    await openChat(page)
    await exchange(page)
    const confirm = confirmDialog(page)
    for (const [kind, title] of [
      ['llm_transfer', 'Відкликати згоду на передачу тексту Ollama Cloud (Ollama Inc.)?'],
      ['age_18', 'Відкликати підтвердження віку?'],
    ] as const) {
      await accountToggle(page).click()
      await accountSheet(page).locator(`[data-act="revoke"][data-kind="${kind}"]`).click()
      await expect(confirm).toContainText(title)
      await axe(page, `confirm revoke ${kind}`)
      await confirm.getByRole('button', { name: 'Скасувати' }).click()
      await expect(confirm).toBeHidden()
      await page.keyboard.press('Escape')
      await expect(accountSheet(page)).toBeHidden()
    }

    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await expect(confirm).toContainText('Почати нову розмову?')
    await axe(page, 'confirm new-after-crisis')
    await confirm.getByRole('button', { name: 'Почати нову', exact: true }).click()
    await onScreen(page, 'chat')
    await expect(page.locator('[data-el="after-crisis"]')).toBeVisible()
    await expect(talk(page)).not.toContainText(CRISIS_TEXT)
    await axe(page, 'new conversation after the crisis')

    await send(page, USER)
    await onScreen(page, 'session-expired')
    await axe(page, 'session-expired with an unsent message')
  })

  test('axe: the sky presets «Сутінки» and «Світанок» on the conversation; the crisis keeps the night', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply() }, { sse: reply() }, { sse: meta() + crisis('keyword') })
    await openChat(page)
    for (const [label, value] of [
      ['Сутінки', 'dusk'],
      ['Світанок', 'dawn'],
    ] as const) {
      await accountToggle(page).click()
      await accountSheet(page).getByRole('radio', { name: label }).check()
      await expect(html(page)).toHaveAttribute('data-sky', value)
      await page.keyboard.press('Escape')
      await expect(accountSheet(page)).toBeHidden()
      await exchange(page)
      await axe(page, `conversation, sky ${value}`)
    }
    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    await expect(html(page)).not.toHaveAttribute('data-sky')
    await axe(page, 'crisis with the dawn preset chosen')
  })
})

// ── The light (needs WebGL: local only) ──────────────────────────────────────────────────────

test.describe('the light', () => {
  test.use({ webgl: true })

  test('the light runs in its slot, beside the text column', GPU, async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'the scene column of the wide layout')
    await openChat(page)
    await expect(html(page)).toHaveAttribute('data-gl', 'on', { timeout: 15_000 })
    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      return { canvas: rect('.presence__canvas'), slot: rect('[data-presence-slot]'), text: rect('.chat__text') }
    })
    expect(boxes.canvas.left).toBeGreaterThanOrEqual(boxes.text.right)
    expect(Math.abs(boxes.canvas.width - boxes.slot.width)).toBeLessThanOrEqual(1)
  })
})
