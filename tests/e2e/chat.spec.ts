// /chat/ against a mocked API (spec §11.4): page.route answers /api/v1/** with synthetic data, a fetch
// shim writes streamed turns chunk by chunk, page.clock drives the timers. Runs headless in CI on the
// desktop and mobile projects (no GPU: the page keeps its static light, see chat-fixtures.ts).
// Every test also passes the audit of chat-fixtures.ts: no CSP violation, no console problem, no
// paused hotline number and no server message in the DOM, no request to another origin.

import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { uiError } from '../../src/chat/core/errors'
import { FALLBACK_ABROAD, FALLBACK_MESSAGE, PAUSED_LINE_NOTE, PAUSED_LINE_NOTE_SHORT } from '../../src/chat/core/helplines'
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
  JOURNAL_DELETED,
  JOURNAL_EMPTY,
  JOURNAL_FAILED,
  JOURNAL_SAVED,
  LIMIT_BLOCK,
  LONG_CONVERSATION,
  NEED_RECORDS,
  REVISIT_EMPTY,
  REVISIT_GONE_BLOCK,
  SAY_ALREADY,
  SAY_INSERTED,
  SERVER_DOWN,
  TOO_LARGE_BLOCK,
  WEEK_FAILED,
  accountOpError,
  copyFailed,
  journalNothing,
  saveError,
  scenarioAbout,
  placeholder,
  signInBanner,
  starters,
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
  type ApiCall,
  type MockApi,
  type Summary,
  type TagCount,
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
  themeId,
  toReview,
  token,
  userMessages,
  weekly,
} from './chat-fixtures'
import { cutOffAtEdges } from './helpers'

type Msg = { role: string; content: string }
type TurnBody = { scenario: string; messages: Msg[]; revisit_summary_ids?: string[] }

const USER = 'Синтетичне повідомлення: цього тижня я відкладаю одну розмову з колегою.'
const CRISIS_TEXT = 'Синтетична фраза, на яку сервер відповідає кризою.'
/** Words that must never reach the page once the turn ended in anything but `done` (I3). */
const PARTIAL = ['токен-альфа ', 'токен-бета ', 'токен-гамма ', 'токен-дельта ']
const RECORDS = [1, 2, 3, 4, 5, 6].map((i) => record(i))
/** An answer with the paused number split between two tokens, and the answer as the page shows it. */
const NUMBERED_REPLY = ['Можна подзвонити на ', PAUSED.slice(0, 2), PAUSED.slice(2), ' — або 112.']
const NUMBERED_SHOWN = `Можна подзвонити на ${PAUSED_LINE_NOTE} — або 112.`
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
    // Two tokens in: three digits, which are not the number yet — and digits at the end of the
    // stream are held back until something else follows them (§3.7.4), so none of them shows.
    await stream.write(meta() + token(`Можна подзвонити на ${PAUSED.slice(0, 1)}`) + token(`${PAUSED.slice(1, 2)} ${PAUSED.slice(2, 3)}`))
    await expect(reply).toHaveText(/^Можна подзвонити на\s*$/)
    expect((await markup(page)).includes(`${PAUSED.slice(0, 2)} ${PAUSED.slice(2, 3)}`)).toBe(false)
    // The last digit comes in its own token: the answer so far is masked as a whole.
    await stream.write(token(`${PAUSED.slice(3)}, але найперше — 112.`))
    const masked = `Можна подзвонити на ${PAUSED_LINE_NOTE}, але найперше — 112.`
    // «112.» at the very end may be a number still coming in too: it waits for `done`.
    await expect(reply).toHaveText(`Можна подзвонити на ${PAUSED_LINE_NOTE}, але найперше —`)
    expect((await markup(page)).includes(PAUSED)).toBe(false)
    await stream.write(done())
    await answered(page, 1)
    await expect(reply).toHaveText(masked)
    await expect.poll(async () => (await announced(page)).includes(`Відповідь AI: ${masked}`)).toBe(true)
    expect((await announced(page)).some((text) => text.includes(PAUSED))).toBe(false)
  })

  test('#2c a number still coming in waits whatever joins its digits: a dash, a dot, a Cyrillic «З», fullwidth digits', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    // Every state the answer's text passes through, as the screen shows it.
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { __seen: string[] }).__seen = seen
      const list = document.querySelector('[data-el="talk"]')!
      new MutationObserver(() => {
        // The answer of this turn: the last one written live (earlier answers keep the class).
        const live = Array.from(list.querySelectorAll('li.said--live .said__text')).at(-1)
        if (live) seen.push(live.textContent ?? '')
      }).observe(list, { subtree: true, childList: true, characterData: true })
    })
    const [a, b, c, d] = [...PAUSED]
    const wide = (digits: string): string => [...digits].map((digit) => String.fromCodePoint(0xff10 + Number(digit))).join('')
    const cases: readonly (readonly string[])[] = [
      [a!, `${b}–${c}`, d!],
      [`${a}${b}.`, `${c}${d}`],
      // A Cyrillic capital Ze, which the mask reads as a 3 among digits.
      [`${a}${b}`, String.fromCodePoint(0x0417), d!],
      [wide(a!), wide(`${b}${c}`), wide(d!)],
    ]
    const frames = (): Promise<unknown> => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    for (const [i, parts] of cases.entries()) {
      await send(page, `${USER} ${i + 1}`)
      await stream.requests(i + 1)
      await stream.write(meta() + token('Подзвоніть на '))
      for (const part of parts) {
        await stream.write(token(part))
        await frames()
      }
      await stream.write(token(' або 112.'))
      await frames()
      await stream.write(done())
      await answered(page, i + 1)
      await expect(aiMessages(page).nth(i + 1).locator('.said__text')).toHaveText(`Подзвоніть на ${PAUSED_LINE_NOTE} або 112.`)
    }
    // No digit of the number ever stood on the screen: only «112», after the number was masked.
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
    expect(seen.length).toBeGreaterThan(cases.length * 2)
    expect(seen.filter((text) => /\p{N}/u.test(text.replace(/112\.?$/u, '')))).toEqual([])
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
    for (const act of ['resend', 'edit', 'revisit-open', 'stop', 'copy', 'copy-reply', 'starter', 'tool', 'reload']) await expect(stale.locator(`[data-act="${act}"]`), act).toHaveCount(0)
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
    // The answer before it carries the number: the read-only copy under <details> masks it too.
    api.on('POST /chat/turn', { sse: reply(NUMBERED_REPLY) })
    await openChat(page)
    await exchange(page, USER)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await expectCrisis(page, USER, testInfo)
    await expect(page.locator('[data-el="crisis-talk"]')).toContainText(NUMBERED_SHOWN)
    expect((await markup(page)).includes(PAUSED)).toBe(false)
  })

  test('#13c a crisis after an llm_busy countdown on the theses: no interval of the wait outlives it', async ({ page, api }, testInfo) => {
    // Every interval the page starts and has not cleared, from its first script on.
    await page.addInitScript(() => {
      const live = new Set<number>()
      const set = window.setInterval.bind(window)
      const clear = window.clearInterval.bind(window)
      Object.defineProperty(window, '__intervals', { value: live })
      window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
        const id = set(handler, ms, ...args)
        live.add(id)
        return id
      }) as typeof window.setInterval
      window.clearInterval = ((id?: number) => {
        if (id !== undefined) live.delete(id)
        clear(id)
      }) as typeof window.clearInterval
    })
    const intervals = () => page.evaluate(() => (window as unknown as { __intervals: Set<number> }).__intervals.size)
    // The automatic retry after the countdown meets the crisis.
    api.on('POST /chat/summarize', fail(503, 'llm_busy', undefined, { 'retry-after': '2' }), fail(409, 'crisis_stop', { helplines: RAW_HELPLINES }))
    await openChat(page)
    await exchange(page, USER)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'summarizing')
    await expect(page.locator('[data-el="sum-countdown"]')).toContainText('Пробуємо ще раз через')
    expect(await intervals()).toBeGreaterThan(0)
    await expectCrisis(page, USER, testInfo)
    expect(api.count('POST /chat/summarize')).toBe(2)
    // The crisis screen has no timers (§6.7): the countdown stopped as the screen changed.
    expect(await intervals()).toBe(0)
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
    // The answer carries the paused number: the read-only copy masks it as the conversation did.
    api.on('POST /chat/turn', { sse: reply(NUMBERED_REPLY) }, fail(401, 'unauthenticated'))
    await openChat(page)
    await exchange(page, USER)
    await send(page, 'Друге синтетичне повідомлення.')
    await onScreen(page, 'session-expired')
    const stale = page.locator('[data-el="expired-talk"]')
    await expect(stale).toContainText(USER)
    await expect(stale).toContainText(NUMBERED_SHOWN)
    await expect(stale).toContainText('Друге синтетичне повідомлення.')
    expect((await markup(page)).includes(PAUSED)).toBe(false)
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
      page.waitForURL(/\/api\/v1\/auth\/google\/start\?next=\/$/),
      confirm.getByRole('button', { name: 'Увійти', exact: true }).click(),
    ])
    expect(api.of('GET /auth/google/start')[0]!.query.get('next')).toBe('/')
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
    await expect(page.locator('[data-el="ni-guest"] h1')).toHaveText('Google не підтвердив вашу адресу')
    await expect(page.locator('[data-el="ni-guest"]')).not.toContainText('списку тестувальників')
    await expect(page.locator('[data-el="ni-member"]')).toBeHidden()
    // Only about this sign-in: a previously created account and its diary may still exist.
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
        const tag = document.querySelector('section[data-screen="chat"] .scenarios__legend')!
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
    const note = page.locator('#composer-note')

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
    expect(await text(lead)).toBe(`Відповіді й тези створює не наш сервер, а постачальник AI — ${NAME}.`)
    // The details under the one-sentence row (§3.5): what exactly goes to the provider.
    const more = lead.locator('xpath=following-sibling::details[1]')
    await expect(more.locator('summary')).toHaveText('Що саме йому передається')
    await expect(more).toContainText('Щоб AI міг відповідати, йому щоразу передається текст усієї розмови.')
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

  test('#30d the paused number in a diary record and in an opening message: masked in the history, the picker and the chosen names', async ({ page, api }) => {
    const numbered = record(1, {
      title: `Дзвінок на ${PAUSED}`,
      bullets: [`Номер ${PAUSED} не відповів.`, 'Друга синтетична теза.'],
      tags: [{ id: '00000000-0000-4000-9000-000000000178', name: `лінія ${PAUSED}`, source: 'ai' }],
    })
    api.on('GET /summaries', { json: diary([numbered, record(2)]) })
    api.on('GET /scenarios', {
      json: SCENARIOS.map((s) => (s.id === 'revisit' ? { ...s, opening_message: `Про лінію ${PAUSED}: що змінилося відтоді?` } : s)),
    })
    await openChat(page)
    await scenarioList(page).getByRole('radio', { name: 'Повернення до теми' }).check()
    await expect(firstMessage(page)).toHaveText(`Про лінію ${PAUSED_LINE_NOTE}: що змінилося відтоді?`)
    await page.locator('[data-el="revisit-open"]').click()
    const dialog = pickDialog(page)
    await expect(dialog.locator('.pick__input')).toHaveCount(2)
    const first = dialog.locator('li.pick').first()
    await expect(first.locator('.pick__title')).toHaveText(`Дзвінок на ${PAUSED_LINE_NOTE}`)
    await expect(first.locator('.pick__first')).toHaveText(`Номер ${PAUSED_LINE_NOTE} не відповів.`)
    await expect(first.locator('.pick__meta')).toContainText(`#лінія ${PAUSED_LINE_NOTE}`)
    expect((await markup(page)).includes(PAUSED)).toBe(false)
    await first.locator('.pick__input').check()
    await dialog.getByRole('button', { name: 'Продовжити (1)' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-el="revisit-names"]')).toHaveText(`Дзвінок на ${PAUSED_LINE_NOTE}`)
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

  test('#31b the paused number in the theses: the draft and the POST carry the short note; a stored record that still has it is masked on «Збережено»', async ({ page, api }) => {
    const title = `Дзвінок на ${PAUSED}`
    const thesis = `Номер ${PAUSED} не відповів.`
    api.on('POST /chat/summarize', { json: { ...DRAFT, title, bullets: [thesis, ...DRAFT.bullets.slice(1)] } })
    // The server answers with a record that still spells the number (written before the mask).
    api.on('POST /summaries', (call) => {
      const stored = storedFrom(call.body)
      const tag = { id: '00000000-0000-4000-9000-000000000179', name: `лінія ${PAUSED}`, source: 'ai' }
      return { status: 201, json: { ...stored, title, bullets: [thesis, ...stored.bullets.slice(1)], tags: [...stored.tags, tag] } }
    })
    await openChat(page)
    await exchange(page, USER)
    await toReview(page)
    await expect(page.locator('[data-el="review-title"]')).toHaveValue(`Дзвінок на ${PAUSED_LINE_NOTE_SHORT}`)
    await expect(page.locator('#thesis-b0')).toHaveValue(`Номер ${PAUSED_LINE_NOTE_SHORT} не відповів.`)
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    await onScreen(page, 'saved')
    const [body] = api.bodies('POST /summaries') as { title: string; bullets: string[] }[]
    expect(body!.title).toBe(`Дзвінок на ${PAUSED_LINE_NOTE_SHORT}`)
    expect(body!.bullets[0]).toBe(`Номер ${PAUSED_LINE_NOTE_SHORT} не відповів.`)
    await expect(page.locator('[data-el="saved-title"]')).toHaveText(`Дзвінок на ${PAUSED_LINE_NOTE}`)
    await expect(page.locator('[data-el="saved-bullets"] li').first()).toContainText(`Номер ${PAUSED_LINE_NOTE} не відповів.`)
    await expect(page.locator('[data-el="saved-tags"]')).toContainText(`#лінія ${PAUSED_LINE_NOTE}`)
    expect((await markup(page)).includes(PAUSED)).toBe(false)
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
    // A reply on a phone (§3.7.2): the small light and «AI» on one row, the text from the column's edge.
    const answer = aiMessages(page).nth(1)
    const [mark, who, body] = await Promise.all(['.said__mark', '.said__who', '.said__body'].map((part) => answer.locator(part).boundingBox()))
    expect(Math.abs(mark!.y + mark!.height / 2 - (who!.y + who!.height / 2))).toBeLessThan(3)
    expect(Math.abs(body!.x - mark!.x)).toBeLessThan(1)
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

  test('#43e the session row breaks only at «·»: «AI, не людина» and «Не зберігати» stay whole at 375 and 412 px', async ({ page }, testInfo) => {
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
      expect(parts, `${width} px`).toEqual(['AI, не людина: 1', 'Не зберігати: 1'])
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

  test('#43b the /chat/ header fits at 320 px: wordmark, «Якщо важко», motion and sound, «Вигляд», «Акаунт»', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'one engine is enough for the fit')
    await page.setViewportSize({ width: 320, height: 640 })
    await openChat(page)
    await page.evaluate(() => document.fonts.ready)
    await expect(accountToggle(page)).toBeVisible()
    for (const selector of ['.brand', '.help-link', '.media', '.theme-toggle', '.account-toggle']) {
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

  test('#44 forced colors draw every control’s border; without them the fields’ borders are --color-field-border', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough for computed styles')
    // --color-field-border of the dark theme (#6f7c78, ≥ 3:1 on its surface and its sky).
    const FIELD_BORDER = 'rgb(111, 124, 120)'
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
    expect((await border('#composer-input')).color).toBe(FIELD_BORDER)
    // The switch says its state in text, not only in colour.
    await expect(page.locator('[data-el="nosave-state"]')).toHaveText('Вимкнено')

    await exchange(page)
    await toReview(page)
    for (const selector of ['#review-title-input', '#thesis-b0', '#review-tag-input', '#pick-search-input']) {
      expect((await border(selector)).color, selector).toBe(FIELD_BORDER)
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
      // The toggletips and the tools menu (§3.6, §3.7.3) are copy too.
      for (const tip of Array.from(document.querySelectorAll<HTMLElement>('[popover]'))) {
        tip.popover = 'manual'
        if (!tip.matches(':popover-open')) tip.showPopover()
      }
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
    // The scenario lines, the starters and the placeholders of every scenario the page knows,
    // including the ones this server does not offer yet.
    const ids = ['free', 'situation', 'day', 'revisit', 'worry', 'hard_talk', 'gratitude', 'evening'] as const
    const copy = ids
      .flatMap((id) => [scenarioAbout({ id, title: id, description: '', opening_message: '', needs_summaries: false }), ...starters(id), placeholder(id, true)])
      .join('\n')
      .toLowerCase()
    for (const id of ids) expect(starters(id), id).toHaveLength(3)
    for (const pattern of FORBIDDEN) expect(copy, `forbidden phrase ${pattern}`).not.toMatch(pattern)
    expect(clinicalOffenders(copy)).toEqual([])
  })
})

// ── Presentation (spec §3.6, §3.7.2–§3.7.4, §3.1 «Рух») ──────────────────────────────────────

test.describe('presentation', () => {
  test('#56 the person on the right in a bubble, every reply from the left under «AI»; a time under each message, none on the opening', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'the layout of one width; the phone has #43')
    await openChat(page)
    await exchange(page, USER)
    await exchange(page, 'Друге синтетичне повідомлення.')
    const column = (await talk(page).boundingBox())!
    for (const li of await userMessages(page).all()) {
      const bubble = li.locator('.said__text')
      const box = (await bubble.boundingBox())!
      expect(column.x + column.width - (box.x + box.width), 'the bubble ends at the column’s right edge').toBeLessThan(2)
      expect(box.x - column.x, 'the bubble does not start at the left').toBeGreaterThan(40)
      expect(await bubble.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
      await expect(li.locator('.said__time')).toHaveText(/^\d{2}:\d{2}$/)
      await expect(li.locator('[data-act="copy-reply"]')).toHaveCount(1)
      await expect(li.locator('[data-act="copy-reply"]')).toBeHidden()
    }
    const replies = aiMessages(page)
    await expect(replies).toHaveCount(3)
    // G2: «AI» on every reply, the opening one too — exactly that text.
    await expect(replies.locator('.said__who')).toHaveText(['AI', 'AI', 'AI'])
    for (const li of await replies.all()) {
      const body = (await li.locator('.said__body').boundingBox())!
      expect(Math.abs(body.x - column.x), 'a reply starts at the column’s left edge').toBeLessThan(2)
    }
    // The reply's text is in the page's own colour, not the AI's accent.
    const colours = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.setProperty('color', 'var(--color-text)')
      document.body.append(probe)
      const text = getComputedStyle(probe).color
      probe.remove()
      const p = document.querySelectorAll('[data-el="talk"] > li.said--ai .said__text p')[1]!
      return { text, reply: getComputedStyle(p).color }
    })
    expect(colours.reply).toBe(colours.text)
    await expect(replies.first().locator('.said__time')).toBeHidden()
    await expect(replies.first().locator('[data-act="copy-reply"]')).toBeHidden()
    await expect(replies.nth(1).locator('.said__time')).toHaveText(/^\d{2}:\d{2}$/)
    await expect(replies.nth(1).locator('.said__time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/)
  })

  test('#57 «Копіювати» under a reply copies that reply, the paused number masked; the read-only copies have none', async ({ page, api, context }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'the clipboard is read in one project')
    api.on('POST /chat/turn', { sse: reply(NUMBERED_REPLY) }, { sse: meta() + crisis('keyword') })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openChat(page)
    await exchange(page, USER)
    const answer = aiMessages(page).nth(1)
    await expect(answer.locator('.said__text')).toHaveText(NUMBERED_SHOWN)
    // Its name is its words, then which reply (§3.7.2): «Копіювати відповідь 1, HH:MM»; then
    // «Скопійовано» for 2 s (the live region says it too).
    const button = answer.locator('[data-act="copy-reply"]')
    await expect(button).toHaveAccessibleName(/^Копіювати відповідь 1, \d\d:\d\d$/)
    await button.click()
    await expect(button.locator('.said__copy-label')).toHaveText('Скопійовано')
    await expect(announcer(page)).toHaveText('Скопійовано')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(NUMBERED_SHOWN)
    await expect(button.locator('.said__copy-label')).toHaveText('Копіювати', { timeout: 4000 })
    await expect(button).toHaveAccessibleName(/^Копіювати відповідь 1, \d\d:\d\d$/)
    // The crisis keeps the conversation as a read-only copy: no «Копіювати» under any reply.
    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    await expect(page.locator('[data-el="crisis-talk"] li')).not.toHaveCount(0)
    await expect(page.locator('[data-el="crisis-talk"] [data-act="copy-reply"], [data-el="crisis-talk"] .said__meta')).toHaveCount(0)
  })

  test('#58 a starter puts its words into the field and sends nothing; each scenario has its own; gone after the first message', async ({ page, api }) => {
    await openChat(page)
    const box = page.locator('[data-el="starters"]')
    const chips = box.locator('button.starter')
    await expect(box).toHaveAttribute('role', 'group')
    await expect(chips).toHaveText([...starters('free')])
    await scenarioList(page).getByRole('radio', { name: 'Розбір дня' }).check()
    await expect(chips).toHaveText([...starters('day')])
    await chips.nth(1).click()
    await expect(composer(page)).toHaveValue(starters('day')[1]!)
    // A second chip adds its words after the first, with a space.
    await chips.nth(2).click()
    await expect(composer(page)).toHaveValue(`${starters('day')[1]} ${starters('day')[2]}`)
    await page.waitForTimeout(300)
    expect(api.count('POST /chat/turn')).toBe(0)
    await sendButton(page).click()
    await answered(page, 1)
    expect(api.count('POST /chat/turn')).toBe(1)
    await expect(box).toBeHidden()
  })

  test('#59 ⓘ beside «Не зберігати» and under the field: Enter opens the note, Esc closes it, the focus stays on ⓘ', async ({ page }) => {
    await openChat(page)
    const check = async (button: Locator, tip: Locator, words: string): Promise<void> => {
      await button.focus()
      await page.keyboard.press('Enter')
      await expect(tip).toBeVisible()
      expect(await tip.evaluate((node) => node.matches(':popover-open'))).toBe(true)
      await expect(tip).toContainText(words)
      await expect(button).toBeFocused()
      // Open, in the top layer: its text and its edge pass too, not only the closed page.
      await axe(page, `${words}: open`)
      await page.keyboard.press('Escape')
      await expect(tip).toBeHidden()
      await expect(button).toBeFocused()
    }
    await check(page.getByRole('button', { name: 'Що означає «Не зберігати»' }), page.locator('#nosave-tip'), 'Тези наприкінці можна буде переглянути')
    // «Інструменти» from the keyboard: Enter opens the menu, Tab walks its items, Esc brings the
    // focus back to its button.
    const tools = page.getByRole('button', { name: 'Інструменти' })
    await tools.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#composer-tools')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Подихати хвилину' })).toBeFocused()
    await axe(page, 'the tools menu: open')
    await page.keyboard.press('Escape')
    await expect(page.locator('#composer-tools')).toBeHidden()
    await expect(tools).toBeFocused()
    // The switch says the same without the tip: the hint is its description.
    await expect(page.getByRole('switch', { name: 'Не зберігати цю розмову' })).toHaveAccessibleDescription(/Тези наприкінці можна буде переглянути/)
    await exchange(page, USER)
    await check(page.getByRole('button', { name: 'Про цю розмову' }), page.locator('#composer-tip'), 'Liora не зберігає цю розмову')
    // The field's description is the same sentence, opened or not.
    await expect(composer(page)).toHaveAccessibleDescription(/Liora не зберігає цю розмову/)
  })

  test('#61 a toggletip left open closes with its part: «Не зберігати» after the first message, everything on the crisis', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply() }, { sse: meta() + crisis('keyword') })
    await openChat(page)
    const nosaveTip = page.locator('#nosave-tip')
    const open = (tip: Locator): Promise<boolean> => tip.evaluate((node) => node.matches(':popover-open'))
    // From the keyboard only: nothing outside is pressed, so no light dismiss closes it first.
    await page.getByRole('button', { name: 'Що означає «Не зберігати»' }).focus()
    await page.keyboard.press('Enter')
    await expect(nosaveTip).toBeVisible()
    await composer(page).focus()
    await page.keyboard.type(USER)
    expect(await open(nosaveTip)).toBe(true)
    await page.keyboard.press('Control+Enter')
    await answered(page, 1)
    expect(await open(nosaveTip)).toBe(false)
    // The note under the field, open when the crisis comes: the crisis closes it too.
    const composerTip = page.locator('#composer-tip')
    await page.getByRole('button', { name: 'Про цю розмову' }).focus()
    await page.keyboard.press('Enter')
    await expect(composerTip).toBeVisible()
    await composer(page).focus()
    await page.keyboard.type(CRISIS_TEXT)
    await page.keyboard.press('Control+Enter')
    await onScreen(page, 'crisis')
    const left = await page.evaluate(() => Array.from(document.querySelectorAll('[popover]')).filter((node) => node.matches(':popover-open')).map((node) => node.id))
    expect(left).toEqual([])
  })

  test('#62 the sky eases into the page colour at the right edge only where a scrollbar keeps a gutter', async ({ page }) => {
    await openChat(page)
    // A gutter: the fixed sky stops short of the window's right edge (the gutter shows the page's
    // background colour there).
    const edge = await page.evaluate(() => ({
      gutter: window.innerWidth - document.querySelector('.stage')!.getBoundingClientRect().right > 1,
      marked: document.documentElement.hasAttribute('data-gutter'),
      fade: getComputedStyle(document.querySelector('.stage')!, '::after').content,
    }))
    expect(edge.marked).toBe(edge.gutter)
    // Overlay scrollbars (the phone): no fade, so no darker band down the right edge.
    expect(edge.fade === 'none').toBe(!edge.gutter)
  })

  test('#60 a screen rises in only with motion; the crisis stands in one frame, motion or not', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply() }, { sse: meta() + crisis('keyword') })
    await openChat(page)
    const animation = (screen: string) => page.locator(`section[data-screen="${screen}"]`).evaluate((node) => getComputedStyle(node).animationName)
    await expect(html(page)).toHaveAttribute('data-motion', 'on')
    expect(await animation('chat')).toBe('rise-in')
    await exchange(page, USER)
    // The reply that came in live rises in; the read-only copies never do.
    await expect(aiMessages(page).nth(1)).toHaveClass(/\bsaid--in\b/)
    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    const still = await page.locator('section[data-screen="crisis"]').evaluate((node) => ({
      name: getComputedStyle(node).animationName,
      running: node.getAnimations({ subtree: true }).map((a) => (a as CSSAnimation).animationName ?? 'transition'),
      // No View Transition either: its pseudo-elements animate on the document.
      viewTransition: document.getAnimations().filter((a) => ((a.effect as KeyframeEffect | null)?.pseudoElement ?? '').includes('view-transition')).length,
    }))
    expect(still).toEqual({ name: 'none', running: [], viewTransition: 0 })
    // «Пауза»: a new conversation after the crisis stands still too.
    await page.locator('[data-motion-toggle]').click()
    await expect(html(page)).toHaveAttribute('data-motion', 'off')
    await page.locator('[data-act="new-after-crisis"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Почати нову', exact: true }).click()
    await onScreen(page, 'chat')
    expect(await animation('chat')).toBe('none')
    // Nothing moves: no animation, and no transition of a transform, scale, translate or opacity
    // (a button's colour may still settle after a press).
    const moving = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) => (a instanceof CSSTransition ? a.transitionProperty : a instanceof CSSAnimation ? `animation ${a.animationName}` : 'script'))
        .filter((what) => !/^(color|background-color|border-color|outline-color|box-shadow)$/.test(what)),
    )
    expect(moving).toEqual([])
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

// ── The theme (ADR-012): «Як у системі», «Світла», «Темна» ───────────────────────────────────

const PAPER = 'rgb(246, 241, 234)' // --color-bg, light: #f6f1ea
const LAMP = 'rgb(18, 26, 27)' // --color-bg, dark: #121a1b
const themeToggle = (page: Page): Locator => page.locator('[data-theme-toggle]')
const themeMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Вигляд' })
const themeItem = (page: Page, name: string): Locator => themeMenu(page).getByRole('menuitemradio', { name })
const storedTheme = (page: Page): Promise<string | null> => page.evaluate(() => localStorage.getItem('liora:theme'))
/** Every finite animation and transition is over (a theme cross-fade, a menu's entrance): axe
 *  measures the colours the page settles on, not a frame in between. The endless ones (the haze's
 *  drift, the light's breath) never finish and are left alone. */
const settled = (page: Page): Promise<unknown> =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
        .map((a) => a.finished.catch(() => null)),
    ),
  )

test.describe('theme', () => {
  test('#54 «Вигляд» in the header: the menu switches the theme; after a reload it is on <html> by DOMContentLoaded; «Як у системі» removes the key', async ({ page }) => {
    // What the page looked like when the parser finished — before any module ran.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const root = document.documentElement
        ;(window as unknown as { __atDcl: unknown }).__atDcl = { theme: root.getAttribute('data-theme'), bg: getComputedStyle(root).backgroundColor }
      })
    })
    const atDcl = (): Promise<unknown> => page.evaluate(() => (window as unknown as { __atDcl: unknown }).__atDcl)
    await openChat(page)
    const toggle = themeToggle(page)
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAccessibleName('Вигляд: як у системі')
    // The suite emulates a dark system: no choice, the evening.
    await expect(html(page)).not.toHaveAttribute('data-theme')
    await expect(html(page)).toHaveCSS('background-color', LAMP)
    expect(await storedTheme(page)).toBeNull()

    await toggle.click()
    await expect(themeMenu(page)).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(themeItem(page, 'Як у системі')).toHaveAttribute('aria-checked', 'true')
    await expect(themeItem(page, 'Як у системі')).toBeFocused()
    await themeItem(page, 'Світла').click()
    await expect(themeMenu(page)).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(html(page)).toHaveCSS('background-color', PAPER)
    await expect(toggle).toHaveAccessibleName('Вигляд: світла')
    expect(await storedTheme(page)).toBe('light')
    // One theme-color, following the page.
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1)
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', PAPER)

    await page.reload()
    await onScreen(page, 'chat')
    expect(await atDcl()).toEqual({ theme: 'light', bg: PAPER })

    // By keyboard (WAI-ARIA menu button): ↓ opens on the chosen item, End, Enter.
    await toggle.focus()
    await page.keyboard.press('ArrowDown')
    await expect(themeItem(page, 'Світла')).toBeFocused()
    await page.keyboard.press('End')
    await expect(themeItem(page, 'Темна')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(html(page)).toHaveCSS('background-color', LAMP)
    expect(await storedTheme(page)).toBe('dark')

    // «Як у системі» forgets the choice: no key, no attribute, the system decides (dark here).
    await toggle.click()
    await themeItem(page, 'Як у системі').click()
    await expect(html(page)).not.toHaveAttribute('data-theme')
    expect(await storedTheme(page)).toBeNull()
    await page.reload()
    await onScreen(page, 'chat')
    expect(await atDcl()).toEqual({ theme: null, bg: LAMP })
    await storageAudit(page)
  })

  test('#54b the menu and the sheet’s «Вигляд» show one choice; the menu closes on Esc, a click outside, Tab and the crisis, which keeps the theme', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    const toggle = themeToggle(page)
    const sheet = accountSheet(page)

    // The sheet → the header.
    await accountToggle(page).click()
    await expect(sheet.getByRole('radio', { name: 'Як у системі' })).toBeChecked()
    await sheet.getByRole('radio', { name: 'Темна' }).check()
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(sheet.locator('[data-theme-radios] .pill--on')).toHaveText('Темна')
    await expect(sheet.locator('#sky-note')).toHaveText('Вибір памʼятає цей браузер, на сервер він не потрапляє.')
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(toggle).toHaveAccessibleName('Вигляд: темна')
    // The header → the sheet.
    await toggle.click()
    await expect(themeItem(page, 'Темна')).toHaveAttribute('aria-checked', 'true')
    await themeItem(page, 'Світла').click()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await accountToggle(page).click()
    await expect(sheet.getByRole('radio', { name: 'Світла' })).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()

    // Esc gives the focus back to the button.
    await toggle.click()
    await expect(themeMenu(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(themeMenu(page)).toBeHidden()
    await expect(toggle).toBeFocused()
    // A click outside, on text that takes no focus.
    await toggle.click()
    await expect(themeMenu(page)).toBeVisible()
    await page.locator('[data-el="compose-head"] .scenarios__legend').click()
    await expect(themeMenu(page)).toBeHidden()
    // Tab moves on and closes it.
    await toggle.click()
    await expect(themeItem(page, 'Світла')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(themeMenu(page)).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // The crisis closes it in the same render and takes the focus; the theme stays, the preset and
    // the decoration go.
    await send(page, CRISIS_TEXT)
    await stream.requests(1)
    await toggle.click()
    await expect(themeMenu(page)).toBeVisible()
    await stream.write(meta() + crisis('keyword'))
    await onScreen(page, 'crisis')
    await expect(themeMenu(page)).toBeHidden()
    await expect(page.locator('#crisis-title')).toBeFocused()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(html(page)).toHaveCSS('background-color', PAPER)
    for (const decoration of ['.stage__haze--teal', '.stage__grain', '.vignette']) await expect(page.locator(decoration)).toBeHidden()
    await storageAudit(page)
  })
})

test.describe('theme: a light system', () => {
  test.use({ colorScheme: 'light' })

  test('#55b axe in the light theme with the toggletips and the tools menu open', async ({ page }) => {
    await openChat(page)
    for (const [name, panel] of [
      ['Що означає «Не зберігати»', '#nosave-tip'],
      ['Інструменти', '#composer-tools'],
    ] as const) {
      await page.getByRole('button', { name }).focus()
      await page.keyboard.press('Enter')
      await expect(page.locator(panel)).toBeVisible()
      await axe(page, `light: ${panel} open`)
      await page.keyboard.press('Escape')
      await expect(page.locator(panel)).toBeHidden()
    }
    await exchange(page, USER)
    await page.getByRole('button', { name: 'Про цю розмову' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#composer-tip')).toBeVisible()
    await axe(page, 'light: #composer-tip open')
  })

  test('#55 axe in the light theme the system chose: signed-out, consent, a conversation, the menu, the sheets, the crisis', async ({ page, api }) => {
    api.on('GET /me', fail(401, 'unauthenticated'))
    await openChat(page, '/chat/', 'signed-out')
    // No choice stored: the CSS follows the system.
    await expect(html(page)).not.toHaveAttribute('data-theme')
    await expect(html(page)).toHaveCSS('background-color', PAPER)
    await settled(page)
    await axe(page, 'light: signed-out')

    api.on('GET /me', { json: ME })
    api.on('GET /consents', { json: consents(['llm_transfer', 'age_18']) })
    await openChat(page, '/chat/', 'consent')
    await settled(page)
    await axe(page, 'light: consent')

    api.on('GET /consents', { json: CONSENTS_OK })
    api.on('POST /chat/turn', { sse: reply() }, { sse: reply() }, { sse: meta() + crisis('keyword') })
    await openChat(page)
    await settled(page)
    await axe(page, 'light: a new conversation')
    await exchange(page)
    await exchange(page, 'Друге синтетичне повідомлення.')
    await settled(page)
    await axe(page, 'light: a conversation with two exchanges')

    await themeToggle(page).click()
    await expect(themeMenu(page)).toBeVisible()
    await settled(page)
    await axe(page, 'light: the open «Вигляд» menu')
    await page.keyboard.press('Escape')

    await accountToggle(page).click()
    await expect(accountSheet(page)).toBeVisible()
    await settled(page)
    await axe(page, 'light: the account sheet')
    for (const [label, value] of [
      ['Вечір', 'dusk'],
      ['Ранок', 'dawn'],
    ] as const) {
      await accountSheet(page).getByRole('radio', { name: label }).check()
      await expect(html(page)).toHaveAttribute('data-sky', value)
      await settled(page)
      await axe(page, `light: the account sheet over the ${value} sky`)
    }
    await page.keyboard.press('Escape')
    await expect(accountSheet(page)).toBeHidden()
    await axe(page, 'light: a conversation, the dawn sky')

    await page.locator('.help-link').click()
    await expect(page.locator('#help-dialog')).toBeVisible()
    await settled(page)
    await axe(page, 'light: «Якщо важко»')
    await page.keyboard.press('Escape')

    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    await expect(html(page)).not.toHaveAttribute('data-sky')
    await expect(html(page)).toHaveCSS('background-color', PAPER)
    await settled(page)
    await axe(page, 'light: the crisis')
  })
})

// ── The diary page (spec §7.7) ───────────────────────────────────────────────────────────────

/** The Monday the server names as this week (its first answer), and the one before it. */
const THIS_WEEK = '2026-10-19'
const LAST_WEEK = '2026-10-12'
const WORK = { id: themeId(1), name: 'робота', source: 'ai' }
const SLEEP = { id: themeId(2), name: 'сон', source: 'ai' }
const MINE = { id: themeId(3), name: 'стосунки', source: 'user' }
const ENTRIES = [
  record(1, { title: 'Відкладена розмова з колегою', tags: [WORK, MINE], created_at: '2026-10-20T08:00:00Z' }),
  record(2, { title: 'Сон і ранки', tags: [SLEEP], created_at: '2026-10-16T08:00:00Z' }),
  record(3, { title: 'Тиждень без вихідних', tags: [WORK, SLEEP], created_at: '2026-10-14T08:00:00Z' }),
]
const THEMES: TagCount[] = [
  { id: WORK.id, name: 'робота', count: 2 },
  { id: SLEEP.id, name: 'сон', count: 2 },
  { id: MINE.id, name: 'стосунки', count: 1 },
]

const entries = (page: Page): Locator => page.locator('[data-el="journal-list"] > li.entry')
const entryTitled = (page: Page, title: string): Locator => entries(page).filter({ has: page.locator('.entry__title', { hasText: title }) })
const journalStatus = (page: Page): Locator => page.locator('[data-el="journal-status"]')
const listCalls = (api: MockApi): ApiCall[] => api.of('GET /summaries').filter((call) => call.query.has('q') || call.query.has('tag') || call.query.has('cursor'))

/** GET /summaries as the server filters it: the words of `q` anywhere in the record, AND the theme. */
function found(call: ApiCall, items: readonly Summary[] = ENTRIES): Summary[] {
  const q = call.query.get('q')?.toLowerCase() ?? ''
  const tag = call.query.get('tag')
  return items.filter((r) => (q === '' || `${r.title} ${r.bullets.join(' ')} ${r.tags.map((t) => t.name).join(' ')}`.toLowerCase().includes(q)) && (tag === null || r.tags.some((t) => t.id === tag)))
}

/** PATCH /summaries/{id} → 200: the record with the body applied and edited_at stamped. Without
 *  `tags` (the themes line was not changed) the stored tags stay, as on the server. */
function patched(base: Summary, body: unknown): Summary {
  const b = body as { title: string; bullets: string[]; tags?: { name: string; source: string }[] }
  const tags = b.tags === undefined ? base.tags : b.tags.map((t, i) => ({ id: themeId(40 + i), name: t.name, source: t.source }))
  return { ...base, title: b.title, bullets: b.bullets, tags, edited_at: '2026-10-21T08:00:00Z' }
}

/** From the account sheet (the header has no room for one more control at 320 px). */
async function openDiary(page: Page): Promise<void> {
  await accountToggle(page).click()
  await expect(accountSheet(page)).toBeVisible()
  await accountSheet(page).getByRole('button', { name: 'Відкрити щоденник' }).click()
  await onScreen(page, 'journal')
  await expect(accountSheet(page)).toBeHidden()
  await expect(page.locator('#journal-title')).toBeFocused()
}

test.describe('diary', () => {
  // A zone other than the server's default: the page sends its own (and Europe/Kyiv once refused).
  test.use({ timezoneId: 'Europe/Berlin' })

  test.beforeEach(({ api }) => {
    api.on('GET /summaries', (call) => ({ json: diary(found(call)) }))
    api.on('GET /tags', { json: THEMES })
    api.on('GET /reviews/weekly', (call) => ({ json: weekly(call.query.get('week_start') ?? THIS_WEEK, 2, ['робота', 'сон'], 'Europe/Berlin') }))
  })

  test('#63 ★ the diary asks for nothing until it opens; the week in words, the records; «До розмови» gives the conversation back as it was', async ({ page, api }) => {
    const typed = 'Синтетичний текст, ще не надісланий.'
    await openChat(page)
    await exchange(page, USER)
    await composer(page).fill(typed)
    // Lazily (§7.7): nothing of the diary page at the page's start, nor during a conversation.
    expect(api.count('GET /tags') + api.count('GET /reviews/weekly')).toBe(0)
    const before = api.count('GET /summaries')
    await openDiary(page)
    await expect(page.locator('[data-el="week-count"]')).toHaveText('2 збережені записи')
    expect(api.count('GET /reviews/weekly')).toBe(1)
    expect(api.count('GET /tags')).toBe(1)
    expect(api.count('GET /summaries')).toBe(before + 1)
    expect(api.of('GET /summaries').at(-1)!.query.toString()).toBe('limit=20')
    const [week] = api.of('GET /reviews/weekly')
    expect(week!.query.get('tz')).toBe('Europe/Berlin')
    expect(week!.query.has('week_start')).toBe(false)

    await expect(page.locator('[data-el="week-title"]')).toHaveText('Цей тиждень')
    await expect(page.locator('[data-el="week-themes"]')).toHaveText('Теми: робота, сон')
    await expect(page.locator('[data-el="week-next"]')).toHaveAttribute('aria-disabled', 'true')
    await expect(entries(page).locator('.entry__title')).toHaveText(ENTRIES.map((r) => r.title))
    const first = entries(page).first()
    await expect(first.locator('.entry__meta')).toHaveText('20 жовтня 2026')
    await expect(first.locator('.entry__bullets li')).toHaveText(['01Перша теза запису 1.', '02Друга теза запису 1.'])
    await expect(first.locator('.entry__themes')).toHaveText('#робота #стосунки')
    const themes = page.locator('[data-el="journal-themes"]')
    await expect(themes.getByRole('radio')).toHaveCount(4)
    await expect(themes.getByRole('radio', { name: 'Усі теми' })).toBeChecked()
    // Which record a button is about: its title names it.
    await expect(first.getByRole('button', { name: 'Редагувати' })).toHaveAccessibleDescription(ENTRIES[0]!.title)

    // The records' words live in the text only: every data-* of the list is an id or a hook.
    const data = await page
      .locator('[data-el="journal-list"]')
      .evaluate((list) => Array.from(list.querySelectorAll('*')).flatMap((node) => Array.from(node.attributes).filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`)))
    const hooks = /^data-(id=[0-9a-f-]{36}|act=entry-[a-z-]+|slot=(revisit|add)|err=(title|bullets|tags|edit)|for=(title|tags)|hint=tags)$/
    expect(data.filter((d) => !hooks.test(d)), 'data-* that are neither an id nor a hook').toEqual([])

    // The conversation waits under the diary: leaving the page still asks.
    expect(await beforeUnload(page)).toBe(1)
    await page.getByRole('button', { name: 'До розмови' }).click()
    await onScreen(page, 'chat')
    await expect(userMessages(page)).toHaveCount(1)
    await expect(lastUser(page)).toContainText(USER)
    await expect(aiMessages(page).nth(1)).toContainText(REPLY_TEXT)
    await expect(composer(page)).toHaveValue(typed)
    // The records left with the screen.
    await expect(page.locator('[data-el="journal-list"] li')).toHaveCount(0)
    expect(await markup(page)).not.toContain(ENTRIES[2]!.title)
    await storageAudit(page, ENTRIES[0]!.title)
  })

  test('#63b no way into the diary while an answer streams; from «Розмову завершено» it opens, unguarded, and leads to a new conversation', async ({ page, api }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    await send(page, USER)
    await stream.requests(1)
    await accountToggle(page).click()
    await expect(accountSheet(page)).toBeVisible()
    await expect(accountSheet(page).locator('[data-el="account-journal"]')).toBeHidden()
    await page.keyboard.press('Escape')
    await stream.write(reply())
    await stream.close()
    await answered(page, 1)

    await endWithoutTheses(page)
    await page.locator('section[data-screen="ended"]').getByRole('button', { name: 'Відкрити щоденник' }).click()
    await onScreen(page, 'journal')
    await expect(entries(page)).toHaveCount(3)
    expect(await beforeUnload(page)).toBe(0)
    const out = page.locator('[data-act="journal-back"]')
    await expect(out).toHaveText('Нова розмова')
    await out.click()
    await onScreen(page, 'chat')
    await expect(userMessages(page)).toHaveCount(0)
    expect(api.count('GET /reviews/weekly')).toBe(1)
  })

  test('#64 the week steps by its Monday and stops at this one; a zone the server refuses goes once more as Europe/Kyiv; a failed week has its own line', async ({ page, api }) => {
    api.on('GET /reviews/weekly', (call, index) => {
      if (index === 0) return fail(422, 'invalid_timezone')
      if (index === 3) return fail(500, 'internal')
      const start = call.query.get('week_start') ?? THIS_WEEK
      return { json: start === LAST_WEEK ? weekly(LAST_WEEK, 1, ['сон']) : weekly(THIS_WEEK, 2, ['робота', 'сон']) }
    })
    await openChat(page)
    await openDiary(page)
    const count = page.locator('[data-el="week-count"]')
    await expect(count).toHaveText('2 збережені записи')
    const calls = (): ApiCall[] => api.of('GET /reviews/weekly')
    expect(calls().map((c) => c.query.get('tz'))).toEqual(['Europe/Berlin', 'Europe/Kyiv'])
    expect(calls()[1]!.query.has('week_start')).toBe(false)

    // Back: the Monday before, by the zone the server took.
    await page.getByRole('button', { name: 'Попередній тиждень' }).click()
    await expect(page.locator('[data-el="week-title"]')).toHaveText('12–18 жовтня')
    await expect(count).toHaveText('1 збережений запис')
    await expect(page.locator('[data-el="week-themes"]')).toHaveText('Теми: сон')
    expect(calls()[2]!.query.get('week_start')).toBe(LAST_WEEK)
    expect(calls()[2]!.query.get('tz')).toBe('Europe/Kyiv')
    await expect(page.locator('[data-el="week-next"]')).not.toHaveAttribute('aria-disabled', 'true')

    // Forward again: this answer fails — a line of its own and «Спробувати ще раз»; the list stays.
    await page.getByRole('button', { name: 'Наступний тиждень' }).click()
    await expect(page.locator('[data-el="week-status"]')).toHaveText(WEEK_FAILED)
    await expect(page.locator('[data-el="week-title"]')).toHaveText('Цей тиждень')
    await expect(count).toHaveText('')
    await expect(entries(page)).toHaveCount(3)
    const retry = page.locator('[data-el="week-retry"]')
    await retry.getByRole('button', { name: 'Спробувати ще раз' }).click()
    await expect(count).toHaveText('2 збережені записи')
    await expect(page.locator('[data-el="week-status"]')).toHaveText('')
    await expect(retry).toBeHidden()
    expect(calls()[4]!.query.get('week_start')).toBe(THIS_WEEK)

    // This week is the last one: «Наступний тиждень» says so and asks for nothing.
    const next = page.getByRole('button', { name: 'Наступний тиждень' })
    await expect(next).toHaveAttribute('aria-disabled', 'true')
    // aria-disabled keeps it in the tab order (its name stays readable): pressed, it does nothing.
    await next.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-el="week-title"]')).toHaveText('Цей тиждень')
    await expect(count).toHaveText('2 збережені записи')
    expect(calls()).toHaveLength(5)
  })

  test('#65 the search goes 300 ms after the last key, Enter at once; a theme narrows it (AND); «Показати ще» keeps both; nothing found says so', async ({ page, api }) => {
    const LATER = record(7, { title: 'Ще один запис про сон', tags: [WORK, SLEEP] })
    api.on('GET /summaries', (call) => {
      if (call.query.get('cursor') === 'c-2') return { json: diary([LATER]) }
      const items = found(call)
      return { json: diary(items, call.query.has('q') && items.length > 0 ? 'c-2' : null) }
    })
    await page.clock.install({ time: new Date('2026-10-21T09:00:00Z') })
    await openChat(page)
    await openDiary(page)
    await expect(entries(page)).toHaveCount(3)
    await expect(page.locator('[data-el="journal-more"]')).toBeHidden()
    // From here on the page's timers move only when the test moves them.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)

    const search = page.getByRole('searchbox', { name: 'Пошук' })
    await search.pressSequentially('сон')
    await page.clock.runFor(299)
    expect(listCalls(api)).toHaveLength(0)
    await page.clock.runFor(1)
    await expect.poll(() => listCalls(api).length).toBe(1)
    expect(listCalls(api)[0]!.query.toString()).toBe(`limit=20&q=${encodeURIComponent('сон')}`)
    await expect(entries(page).locator('.entry__title')).toHaveText([ENTRIES[1]!.title, ENTRIES[2]!.title])

    // A theme and the words together.
    await page.locator('[data-el="journal-themes"]').getByRole('radio', { name: '#робота' }).check()
    await expect(entries(page).locator('.entry__title')).toHaveText([ENTRIES[2]!.title])
    expect(listCalls(api).at(-1)!.query.toString()).toBe(`limit=20&q=${encodeURIComponent('сон')}&tag=${WORK.id}`)
    await page.getByRole('button', { name: 'Показати ще' }).click()
    await expect(entries(page).locator('.entry__title')).toHaveText([ENTRIES[2]!.title, LATER.title])
    expect(listCalls(api).at(-1)!.query.toString()).toBe(`limit=20&cursor=c-2&q=${encodeURIComponent('сон')}&tag=${WORK.id}`)
    await expect(page.locator('[data-el="journal-more"]')).toBeHidden()
    // The last page took «Показати ще» away: the focus went on to the first record it brought.
    await expect(entryTitled(page, LATER.title).getByRole('button', { name: 'Редагувати' })).toBeFocused()

    // Enter goes at once; nothing found is one line, and the week and the tools stay. The line is
    // the live one that said «Завантажуємо записи…»: the answer is said too (WCAG 4.1.3).
    await search.fill('кава')
    await search.press('Enter')
    await expect(journalStatus(page)).toHaveText(journalNothing('кава'))
    await expect(journalStatus(page)).toHaveAttribute('role', 'status')
    await expect(entries(page)).toHaveCount(0)
    await expect(page.locator('[data-el="week"]')).toBeVisible()
    await expect(search).toBeVisible()
    // Nothing more goes once the timer the typing set would have run out.
    const sent = listCalls(api).length
    await page.clock.runFor(1000)
    expect(listCalls(api)).toHaveLength(sent)
    await page.locator('[data-el="journal-themes"]').getByRole('radio', { name: 'Усі теми' }).check()
    await expect(journalStatus(page)).toHaveText(journalNothing('кава'))
    expect(listCalls(api).at(-1)!.query.toString()).toBe(`limit=20&q=${encodeURIComponent('кава')}`)
  })

  test('#66 ★ a record is edited in place: the PATCH carries title, theses and themes (the AI’s keep «ai»); «змінено» after; unchanged, «Скасувати» and Esc send nothing', async ({ page, api }) => {
    const target = ENTRIES[0]!
    const key = `PATCH /summaries/${target.id}`
    api.on(key, (call) => ({ json: patched(target, call.body) }))
    await openChat(page)
    await openDiary(page)
    const row = entryTitled(page, target.title)
    const edit = row.getByRole('button', { name: 'Редагувати' })
    const title = row.getByRole('textbox', { name: 'Назва' })
    const tags = row.getByRole('textbox', { name: 'Теми' })

    // Opened: the record as it is, the focus in the title; one edit at a time.
    await edit.click()
    await expect(title).toBeFocused()
    await expect(title).toHaveValue(target.title)
    // The caret at the start: a long title shows its beginning, not its end.
    expect(await title.evaluate((field: HTMLInputElement) => [field.selectionStart, field.scrollLeft])).toEqual([0, 0])
    await expect(row.getByRole('textbox', { name: 'Теза 1' })).toHaveValue(target.bullets[0]!)
    await expect(tags).toHaveValue('робота, стосунки')
    await expect(entryTitled(page, ENTRIES[1]!.title).getByRole('button', { name: 'Редагувати' })).toHaveAttribute('aria-disabled', 'true')
    // Nothing changed: «Зберегти» closes the form without a PATCH (it would stamp «змінено»).
    await row.getByRole('button', { name: 'Зберегти' }).click()
    await expect(title).toBeHidden()
    await expect(edit).toBeFocused()
    // «Скасувати» and Esc give the record back as it was.
    await edit.click()
    await title.fill('Синтетична назва, яку скасують')
    await row.getByRole('button', { name: 'Скасувати' }).click()
    await expect(row.locator('.entry__title')).toHaveText(target.title)
    await edit.click()
    await title.fill('Синтетична назва, яку скасують')
    await page.keyboard.press('Escape')
    await expect(title).toBeHidden()
    await expect(edit).toBeFocused()
    expect(api.count(key)).toBe(0)

    await edit.click()
    await title.fill('Розмова з колегою відбулася')
    await row.getByRole('textbox', { name: 'Теза 2' }).fill('Синтетична нова друга теза.')
    await row.getByRole('button', { name: '+ Додати тезу' }).click()
    const third = row.getByRole('textbox', { name: 'Теза 3' })
    await expect(third).toBeFocused()
    await third.fill('Синтетична третя теза.')
    await tags.fill('робота, нова тема, Робота')
    const themesBefore = api.count('GET /tags')
    const weeksBefore = api.count('GET /reviews/weekly')
    const diaryBefore = api.count('GET /summaries')
    await row.getByRole('button', { name: 'Зберегти' }).click()
    await expect(journalStatus(page)).toHaveText(JOURNAL_SAVED)
    expect(api.bodies(key)).toEqual([
      {
        title: 'Розмова з колегою відбулася',
        bullets: ['Перша теза запису 1.', 'Синтетична нова друга теза.', 'Синтетична третя теза.'],
        tags: [
          { name: 'робота', source: 'ai' },
          { name: 'нова тема', source: 'user' },
        ],
      },
    ])
    const saved = entryTitled(page, 'Розмова з колегою відбулася')
    await expect(saved.locator('.entry__meta')).toHaveText('20 жовтня 2026 · змінено')
    await expect(saved.locator('.entry__bullets li')).toHaveCount(3)
    await expect(saved.locator('.entry__themes')).toHaveText('#робота #нова тема')
    await expect(saved.getByRole('button', { name: 'Редагувати' })).toBeFocused()
    // A theme may have gone, the week may count differently: both again. The page's diary (the
    // picker and «Ви повертаєтеся до:» read it) takes the new record in place, without a GET.
    await expect.poll(() => api.count('GET /tags')).toBe(themesBefore + 1)
    await expect.poll(() => api.count('GET /reviews/weekly')).toBe(weeksBefore + 1)
    expect(api.count('GET /summaries')).toBe(diaryBefore)
  })

  test('#67 403 consent_required on «Зберегти»: the consent says the changes wait; after it the same PATCH goes by itself and the diary comes back', async ({ page, api }) => {
    const target = ENTRIES[0]!
    const key = `PATCH /summaries/${target.id}`
    api.on('GET /consents', { json: CONSENTS_OK }, { json: CONSENTS_NONE })
    api.on(key, fail(403, 'consent_required', { missing: [...KINDS], policy_version: VERSION }), (call) => ({ json: patched(target, call.body) }))
    await openChat(page)
    await openDiary(page)
    const row = entryTitled(page, target.title)
    await row.getByRole('button', { name: 'Редагувати' }).click()
    await row.getByRole('textbox', { name: 'Назва' }).fill('Синтетична нова назва')
    await row.getByRole('button', { name: 'Зберегти' }).click()
    await onScreen(page, 'consent')
    await expect(page.locator('[data-el="consent-resume-patch"]')).toBeVisible()
    await expect(page.locator('[data-el="consent-resume-talk"]')).toBeHidden()
    // Not «Перед розмовою»: the person is editing a record, not starting a conversation.
    await expect(page.locator('[data-el="consent-tag"]')).toBeHidden()
    await expect.poll(() => api.count('GET /consents')).toBe(2)
    for (const kind of KINDS) await page.locator(`input[data-kind="${kind}"]`).check()
    await page.getByRole('button', { name: 'Погоджуюся — продовжити' }).click()
    await onScreen(page, 'journal')
    await expect(journalStatus(page)).toHaveText(JOURNAL_SAVED)
    const patches = api.of(key)
    expect(patches).toHaveLength(2)
    expect(patches[1]!.raw).toBe(patches[0]!.raw)
    await expect(entryTitled(page, 'Синтетична нова назва').locator('.entry__meta')).toHaveText('20 жовтня 2026 · змінено')
    await expect(page.getByRole('button', { name: 'До розмови' })).toBeVisible()
  })

  test('#68 «Видалити» asks first, the focus on «Залишити»; DELETE only after «Видалити»; the record leaves and the focus goes to the next one', async ({ page, api }) => {
    const target = ENTRIES[0]!
    const key = `DELETE /summaries/${target.id}`
    api.on(key, { status: 204 })
    await openChat(page)
    await openDiary(page)
    const row = entryTitled(page, target.title)
    const remove = row.getByRole('button', { name: 'Видалити' })
    const confirm = confirmDialog(page)
    await remove.click()
    await expect(confirm).toBeVisible()
    await expect(confirm.locator('#confirm-title')).toHaveText('Видалити запис?')
    await expect(confirm).toContainText('Повернути його не вийде.')
    await expect(confirm.getByRole('button', { name: 'Залишити' })).toBeFocused()
    await confirm.getByRole('button', { name: 'Залишити' }).click()
    await expect(confirm).toBeHidden()
    await expect(remove).toBeFocused()
    expect(api.count(key)).toBe(0)

    const themesBefore = api.count('GET /tags')
    await remove.click()
    await confirm.getByRole('button', { name: 'Видалити', exact: true }).click()
    await expect(journalStatus(page)).toHaveText(JOURNAL_DELETED)
    expect(api.count(key)).toBe(1)
    await expect(entries(page).locator('.entry__title')).toHaveText([ENTRIES[1]!.title, ENTRIES[2]!.title])
    await expect(entryTitled(page, ENTRIES[1]!.title).getByRole('button', { name: 'Редагувати' })).toBeFocused()
    await expect.poll(() => api.count('GET /tags')).toBe(themesBefore + 1)
  })

  test('#69 «Копіювати» puts one record into the clipboard as Markdown, the paused number masked as on the page', async ({ page, api, context }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'the clipboard is read in one project')
    const numbered = record(4, { title: 'Синтетичний запис із номером', bullets: [`Можна подзвонити на ${PAUSED} — або 112.`, 'Друга теза.'], tags: [WORK], created_at: '2026-10-07T10:00:00Z' })
    api.on('GET /summaries', { json: diary([numbered]) })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openChat(page)
    await openDiary(page)
    const row = entries(page).first()
    await expect(row.locator('.entry__bullets li').first()).toContainText(PAUSED_LINE_NOTE)
    // Its name turns into «Скопійовано» for 2 s: found by its hook, not by its name.
    const button = row.locator('[data-act="entry-copy"]')
    await expect(button).toHaveAccessibleName('Копіювати')
    await button.click()
    await expect(button).toHaveText('Скопійовано')
    await expect(announcer(page)).toHaveText('Скопійовано')
    // The Windows clipboard hands lines back with CRLF.
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(
      ['## Синтетичний запис із номером', '_7 жовтня 2026_', `- Можна подзвонити на ${PAUSED_LINE_NOTE} — або 112.\n- Друга теза.`, 'Теми: робота'].join('\n\n'),
    )
    await expect(button).toHaveText('Копіювати', { timeout: 4000 })
  })

  test('#70 «Повернутися до цього» starts a revisit with that record (one the page’s diary did not have yet); over a conversation it asks first', async ({ page, api }) => {
    // At the start the diary is empty; the diary page then finds the records.
    api.on('GET /summaries', { json: diary() }, (call) => ({ json: diary(found(call)) }))
    await openChat(page)
    await openDiary(page)
    await entryTitled(page, ENTRIES[1]!.title).getByRole('button', { name: 'Повернутися до цього' }).click()
    await onScreen(page, 'chat')
    await expect(scenarioList(page).getByRole('radio', { name: 'Повернення до теми' })).toBeChecked()
    await expect(page.locator('[data-el="revisit-names"]')).toHaveText(ENTRIES[1]!.title)
    await exchange(page)
    expect(turnBodies(api.bodies('POST /chat/turn')).at(-1)).toMatchObject({ scenario: 'revisit', revisit_summary_ids: [ENTRIES[1]!.id] })

    // Now a conversation is under way: a new one replaces it only after a confirm.
    await composer(page).fill('Синтетичний текст, ще не надісланий.')
    await openDiary(page)
    const back = entryTitled(page, ENTRIES[2]!.title).getByRole('button', { name: 'Повернутися до цього' })
    await back.click()
    const confirm = confirmDialog(page)
    await expect(confirm.locator('#confirm-title')).toHaveText('Почати нову розмову?')
    await expect(confirm.getByRole('button', { name: 'Скасувати' })).toBeFocused()
    await confirm.getByRole('button', { name: 'Скасувати' }).click()
    await expect(confirm).toBeHidden()
    await expect(back).toBeFocused()
    await onScreen(page, 'journal')
    await back.click()
    await confirm.getByRole('button', { name: 'Почати нову' }).click()
    await onScreen(page, 'chat')
    await expect(userMessages(page)).toHaveCount(0)
    await expect(composer(page)).toHaveValue('')
    await expect(page.locator('[data-el="revisit-names"]')).toHaveText(ENTRIES[2]!.title)
    expect(await beforeUnload(page)).toBe(0)
    await exchange(page)
    expect(turnBodies(api.bodies('POST /chat/turn')).at(-1)!.revisit_summary_ids).toEqual([ENTRIES[2]!.id])
  })

  test('#71 an empty diary is one line, without the week, the search or the themes; a list that fails says so and asks again', async ({ page, api }) => {
    api.on('GET /summaries', { json: diary() })
    api.on('GET /tags', { json: [] })
    api.on('GET /reviews/weekly', { json: weekly(THIS_WEEK) })
    await openChat(page)
    await openDiary(page)
    await expect(journalStatus(page)).toHaveText(JOURNAL_EMPTY)
    await expect(page.locator('[data-el="week"]')).toBeHidden()
    await expect(page.locator('[data-el="journal-tools"]')).toBeHidden()
    await expect(page.locator('[data-el="journal-themes"]')).toBeHidden()
    await expect(entries(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'До розмови' }).click()
    await onScreen(page, 'chat')

    let failing = true
    api.on('GET /summaries', (call) => {
      if (!failing) return { json: diary(found(call)) }
      failing = false
      return fail(500, 'internal')
    })
    api.on('GET /tags', { json: THEMES })
    await openDiary(page)
    await expect(journalStatus(page)).toHaveText(JOURNAL_FAILED)
    await page.locator('[data-el="journal-retry"]').getByRole('button', { name: 'Спробувати ще раз' }).click()
    await expect(entries(page)).toHaveCount(3)
    await expect(journalStatus(page)).toHaveText('')
    await expect(page.locator('[data-el="journal-retry"]')).toBeHidden()
  })

  test('#72 axe on the diary in both themes: the list, an edit with an empty title, the delete confirm', async ({ page, api }) => {
    await openChat(page)
    await openDiary(page)
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(html(page)).toHaveCSS('background-color', scheme === 'dark' ? LAMP : PAPER)
      await settled(page)
      await axe(page, `${scheme}: the diary`)
      const row = entries(page).first()
      await row.getByRole('button', { name: 'Редагувати' }).click()
      const title = row.getByRole('textbox', { name: 'Назва' })
      await title.fill('')
      await row.getByRole('button', { name: 'Зберегти' }).click()
      await expect(title).toHaveAttribute('aria-invalid', 'true')
      await expect(title).toBeFocused()
      await expect(row.locator('[data-err="title"]')).not.toHaveText('')
      await axe(page, `${scheme}: an edit with an empty title`)
      await row.getByRole('button', { name: 'Скасувати' }).click()
      await row.getByRole('button', { name: 'Видалити' }).click()
      await expect(confirmDialog(page)).toBeVisible()
      await axe(page, `${scheme}: the delete confirm`)
      await confirmDialog(page).getByRole('button', { name: 'Залишити' }).click()
      await expect(confirmDialog(page)).toBeHidden()
    }
    expect(api.count('PATCH /summaries/' + ENTRIES[0]!.id) + api.count('DELETE /summaries/' + ENTRIES[0]!.id)).toBe(0)
  })

  test('#73 at 320 px nothing of the diary leaves the screen: a 40-character theme, a long title, the edit form; the week’s arrows stay 44 px', async ({ page, api }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'one engine is enough for reflow')
    const tag = 'тег'.repeat(13) + 'и'
    const word = 'Синтетичнийдовгийрядокбезжодногопробілу'.repeat(3)
    const long = record(1, { title: word, bullets: [word], tags: [{ id: themeId(9), name: tag, source: 'ai' }] })
    api.on('GET /summaries', { json: diary([long, ENTRIES[1]!], 'c-2') })
    api.on('GET /tags', { json: [{ id: themeId(9), name: tag, count: 1 }, ...THEMES] })
    api.on('GET /reviews/weekly', (call) => ({ json: weekly(call.query.get('week_start') ?? '2026-10-05', 12, [tag, 'робота']) }))
    await page.setViewportSize({ width: 320, height: 640 })
    await openChat(page)
    await openDiary(page)
    await expect(entries(page)).toHaveCount(2)
    // «28 вересня – 4 жовтня»: a week over a month’s end, the longest kind of title.
    await page.getByRole('button', { name: 'Попередній тиждень' }).click()
    await expect(page.locator('[data-el="week-title"]')).toHaveText('28 вересня – 4 жовтня')
    await page.evaluate(() => document.fonts.ready)
    expect(await cutOffAtEdges(page), 'the diary').toEqual([])
    expect(await page.evaluate(() => window.innerWidth), 'the layout viewport did not widen').toBe(320)
    for (const name of ['Попередній тиждень', 'Наступний тиждень']) {
      const box = await page.getByRole('button', { name }).boundingBox()
      expect(Math.min(box!.width, box!.height), name).toBeGreaterThanOrEqual(44)
    }
    await entries(page).first().getByRole('button', { name: 'Редагувати' }).click()
    await expect(entries(page).first().getByRole('textbox', { name: 'Назва' })).toBeFocused()
    expect(await cutOffAtEdges(page), 'the edit form').toEqual([])
  })

  test('#74 a change on its way holds the page: «До розмови» and «Повернутися до цього» wait for its answer; an edit keeps its row through a search; the record goes back under its new name', async ({ page, api }) => {
    const target = ENTRIES[0]!
    const key = `PATCH /summaries/${target.id}`
    const held = gate()
    api.on(key, async (call) => {
      await held.wait
      return { json: patched(target, call.body) }
    })
    await openChat(page)
    await exchange(page, USER)
    await openDiary(page)
    const row = entryTitled(page, target.title)
    await row.getByRole('button', { name: 'Редагувати' }).click()
    const title = row.getByRole('textbox', { name: 'Назва' })
    await title.fill('Синтетична назва після правки')
    // A search that does not find the record under edit: its row and what was typed stay, first.
    const search = page.getByRole('searchbox', { name: 'Пошук' })
    await search.fill('сон')
    await search.press('Enter')
    await expect.poll(() => listCalls(api).length).toBe(1)
    await expect(entries(page)).toHaveCount(3)
    await expect(entries(page).first().getByRole('textbox', { name: 'Назва' })).toHaveValue('Синтетична назва після правки')
    await expect(entries(page).nth(1).locator('.entry__title')).toHaveText(ENTRIES[1]!.title)

    const pageDiary = (): number => api.of('GET /summaries').filter((call) => call.query.toString() === 'limit=20').length
    const before = pageDiary()
    await row.getByRole('button', { name: 'Зберегти' }).click()
    await expect.poll(() => api.count(key)).toBe(1)
    // On its way: the ways off the page say they wait, and pressed, they do nothing.
    const back = page.locator('[data-act="journal-back"]')
    const revisit = entryTitled(page, ENTRIES[1]!.title).getByRole('button', { name: 'Повернутися до цього' })
    await expect(back).toHaveAttribute('aria-disabled', 'true')
    await expect(revisit).toHaveAttribute('aria-disabled', 'true')
    for (const button of [back, revisit]) {
      await button.focus()
      await page.keyboard.press('Enter')
    }
    await expect(confirmDialog(page)).toBeHidden()
    await expect(page.locator('section[data-screen="journal"]')).toBeVisible()
    held.open()
    await expect(journalStatus(page)).toHaveText(JOURNAL_SAVED)
    await expect(back).not.toHaveAttribute('aria-disabled', 'true')
    await expect(revisit).not.toHaveAttribute('aria-disabled', 'true')
    expect(pageDiary()).toBe(before)

    // Taken back at once: the conversation under way goes after a confirm, the new name comes along.
    await entryTitled(page, 'Синтетична назва після правки').getByRole('button', { name: 'Повернутися до цього' }).click()
    await confirmDialog(page).getByRole('button', { name: 'Почати нову' }).click()
    await onScreen(page, 'chat')
    await expect(page.locator('[data-el="revisit-names"]')).toHaveText('Синтетична назва після правки')
  })

  test('#112 a theme without records says so in the live line that said «Завантажуємо записи…»', async ({ page, api }) => {
    await openChat(page)
    await openDiary(page)
    await expect(entries(page)).toHaveCount(3)
    api.on('GET /summaries', (call) => ({ json: diary(call.query.has('tag') ? [] : found(call)) }))
    await page.locator('[data-el="journal-themes"]').getByRole('radio', { name: '#робота' }).check()
    await expect(entries(page)).toHaveCount(0)
    await expect(journalStatus(page)).toHaveText(journalNothing(''))
    await expect(journalStatus(page)).toHaveAttribute('role', 'status')
    // Back to every record: the line goes quiet again.
    await page.locator('[data-el="journal-themes"]').getByRole('radio', { name: 'Усі теми' }).check()
    await expect(entries(page)).toHaveCount(3)
    await expect(journalStatus(page)).toHaveText('')
  })

  test('#113 an edit typed and not saved: «До розмови» and «Вийти» ask first, closing the tab too; «Редагувати далі» keeps the text, «Скасувати зміни» leaves without a PATCH', async ({ page, api }) => {
    const target = ENTRIES[0]!
    await openChat(page)
    await openDiary(page)
    const row = entryTitled(page, target.title)
    await row.getByRole('button', { name: 'Редагувати' }).click()
    const title = row.getByRole('textbox', { name: 'Назва' })
    // Opened, nothing typed: nothing would be lost.
    expect(await beforeUnload(page)).toBe(0)
    await title.fill('Синтетична назва, ще не збережена')
    expect(await beforeUnload(page)).toBe(1)

    const back = page.locator('[data-act="journal-back"]')
    const confirm = confirmDialog(page)
    await back.click()
    await expect(confirm).toContainText('Скасувати зміни?')
    await expect(confirm).toContainText('Зміни в записі ще не збережено.')
    await expect(confirm.getByRole('button', { name: 'Редагувати далі' })).toBeFocused()
    await axe(page, 'confirm discard-edit')
    await confirm.getByRole('button', { name: 'Редагувати далі' }).click()
    await expect(confirm).toBeHidden()
    await expect(page.locator('section[data-screen="journal"]')).toBeVisible()
    await expect(title).toHaveValue('Синтетична назва, ще не збережена')

    // «Вийти» asks as well, and names what goes: the edit (no conversation is under the diary).
    await accountToggle(page).click()
    await accountSheet(page).getByRole('button', { name: 'Вийти' }).click()
    await expect(confirm).toContainText('Вийти з акаунта?')
    await expect(confirm.getByText('Незбережені зміни в записі зникнуть.')).toBeVisible()
    await expect(confirm.getByText('Поточна розмова закриється', { exact: false })).toBeHidden()
    await confirm.getByRole('button', { name: 'Скасувати', exact: true }).click()
    await expect(confirm).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(accountSheet(page)).toBeHidden()
    await expect(title).toHaveValue('Синтетична назва, ще не збережена')

    await back.click()
    await confirm.getByRole('button', { name: 'Скасувати зміни' }).click()
    await onScreen(page, 'chat')
    expect(api.count(`PATCH /summaries/${target.id}`)).toBe(0)
    expect(await beforeUnload(page)).toBe(0)
  })

  test('#115 «До розмови» held by a change on its way: dim words on the page’s own surface, ≥ 4.5:1 in both themes whatever the sky', async ({ page, api }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'computed colours: one engine is enough')
    const target = ENTRIES[0]!
    const held = gate()
    api.on(`PATCH /summaries/${target.id}`, async (call) => {
      await held.wait
      return { json: patched(target, call.body) }
    })
    await openChat(page)
    await openDiary(page)
    const row = entryTitled(page, target.title)
    await row.getByRole('button', { name: 'Редагувати' }).click()
    await row.getByRole('textbox', { name: 'Назва' }).fill('Синтетична назва після правки')
    await row.getByRole('button', { name: 'Зберегти' }).click()
    const back = page.locator('[data-act="journal-back"]')
    await expect(back).toHaveAttribute('aria-disabled', 'true')
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await settled(page)
      const s = await back.evaluate((node) => {
        const style = getComputedStyle(node)
        return { fill: style.backgroundColor, image: style.backgroundImage, color: style.color }
      })
      // An opaque fill under the tint: the sky never shows through (it took the words to 4.33:1).
      expect(s.fill, scheme).toMatch(/^rgb\(/)
      const tint = /rgba?\([^)]*\)/.exec(s.image)
      expect(tint, s.image).not.toBeNull()
      const ground = over(tint![0], s.fill)
      expect(contrast(s.color, ground), `${scheme}: ${s.color} on ${ground}`).toBeGreaterThanOrEqual(4.5)
    }
    held.open()
    await expect(journalStatus(page)).toHaveText(JOURNAL_SAVED)
  })

  /** «Редагувати» on the first record, a new title, «Зберегти» (its PATCH answers 401). */
  async function saveEditInto401(page: Page, api: MockApi): Promise<void> {
    const target = ENTRIES[0]!
    api.on(`PATCH /summaries/${target.id}`, fail(401, 'unauthenticated'))
    const row = entryTitled(page, target.title)
    await row.getByRole('button', { name: 'Редагувати' }).click()
    await row.getByRole('textbox', { name: 'Назва' }).fill('Синтетична назва, що не збережеться')
    await row.getByRole('button', { name: 'Зберегти' }).click()
  }

  test('#120 a 401 on «Зберегти» of a record under a conversation: session-expired keeps the conversation and says the changes did not reach the diary', async ({ page, api }) => {
    await openChat(page)
    await exchange(page, USER)
    await openDiary(page)
    await saveEditInto401(page, api)
    await onScreen(page, 'session-expired')
    const lost = page.locator('[data-el="expired-edit"]')
    await expect(lost).toBeVisible()
    await expect(lost).toHaveText('Зміни в записі щоденника не збереглися: після входу їх треба буде внести ще раз.')
    await expect(page.locator('[data-el="expired-talk"]')).toContainText(USER)
    await axe(page, 'session-expired after a 401 on an edit of a record')
  })

  test('#120b a 401 on «Зберегти» of a record from «Розмову завершено»: the sign-in screen says the changes did not reach the diary, focused', async ({ page, api }) => {
    await openChat(page)
    await exchange(page, USER)
    await endWithoutTheses(page)
    await page.locator('section[data-screen="ended"]').getByRole('button', { name: 'Відкрити щоденник' }).click()
    await onScreen(page, 'journal')
    await saveEditInto401(page, api)
    await onScreen(page, 'signed-out')
    const banner = page.locator('[data-el="signin-banner"]')
    await expect(banner).toBeFocused()
    await expect(page.locator('[data-el="signin-banner-label"]')).toBeHidden()
    await expect(page.locator('[data-el="signin-banner-text"]')).toHaveText(signInBanner({ kind: 'edit-lost' }).text)
    await expect(page.locator('[data-el="signin-banner-text"]')).toHaveText('Вхід завершився, тож зміни в записі щоденника не збереглися. Увійдіть знову, щоб внести їх ще раз.')
  })
})

// ── The self-help tools (spec §3.13): breathing, grounding, the check-in, the shelter ─────────

const toolsButton = (page: Page): Locator => page.getByRole('button', { name: 'Інструменти' })
const breatheDialog = (page: Page): Locator => page.locator('#breathe-dialog')
const groundDialog = (page: Page): Locator => page.locator('#ground-dialog')
const moodDialog = (page: Page): Locator => page.locator('#mood-dialog')
const shelterDialog = (page: Page): Locator => page.locator('#shelter-dialog')
const presence = (page: Page): Locator => page.locator('.presence')

/** «+ Інструменти» → the item, from the keyboard: Enter opens the menu, the item takes Enter. */
async function openTool(page: Page, name: string): Promise<void> {
  await toolsButton(page).focus()
  await page.keyboard.press('Enter')
  const item = page.locator('#composer-tools').getByRole('button', { name })
  await expect(item).toBeVisible()
  await item.focus()
  await page.keyboard.press('Enter')
}

/** Every write to the browser's storage from now on, in the page's own words (an init script). */
async function watchStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __writes: string[] }
    w.__writes = []
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
      w.__writes.push(`${this === window.sessionStorage ? 'session' : 'local'}:${key}`)
      set.call(this, key, value)
    }
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = ((name: string, version?: number) => {
      w.__writes.push(`idb:${name}`)
      return open(name, version)
    }) as typeof indexedDB.open
    if ('caches' in window) {
      const cacheOpen = caches.open.bind(caches)
      caches.open = (name: string) => {
        w.__writes.push(`cache:${name}`)
        return cacheOpen(name)
      }
    }
  })
}
const storageWrites = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as { __writes: string[] }).__writes])

/** Requests the page makes from now on, fonts aside (part of the page, not data). */
function countRequests(page: Page): () => string[] {
  const seen: string[] = []
  const listener = (request: { url(): string }): void => {
    const url = request.url()
    if (!/\.woff2?(\?|$)/.test(url)) seen.push(url)
  }
  page.on('request', listener)
  return () => seen
}

test.describe('tools', () => {
  test('#75 ★ each tool opens from «+ Інструменти» by keyboard as a dialog; the focus stays inside; Esc closes it and gives the focus back to «Інструменти»', async ({ page }) => {
    await openChat(page)
    for (const [name, dialog, title] of [
      ['Подихати хвилину', breatheDialog(page), 'Подихати хвилину'],
      ['Заземлення 5-4-3-2-1', groundDialog(page), 'Заземлення 5-4-3-2-1'],
      ['Як ви зараз?', moodDialog(page), 'Як ви зараз?'],
      ['В укритті', shelterDialog(page), 'Спершу — безпека'],
    ] as const) {
      await openTool(page, name)
      await expect(dialog, name).toBeVisible()
      // A modal dialog with its name; the menu it came from is closed.
      expect(await dialog.evaluate((node) => (node as HTMLDialogElement).open && node.matches(':modal'))).toBe(true)
      await expect(page.getByRole('dialog', { name: title })).toBeVisible()
      await expect(page.locator('#composer-tools')).toBeHidden()
      // The focus starts inside, and Tab never reaches the page under it: past the last control a
      // native modal lets it out only to the browser's own UI (no element of the page), then back.
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
      let inside = 0
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab')
        const where = await dialog.evaluate((node) => (node.contains(document.activeElement) ? 'dialog' : document.activeElement === document.body ? 'browser' : 'page'))
        expect(where, `${name}: Tab ${i + 1}`).not.toBe('page')
        if (where === 'dialog') inside++
      }
      expect(inside, name).toBeGreaterThanOrEqual(6)
      await page.keyboard.press('Escape')
      await expect(dialog, name).toBeHidden()
      await expect(toolsButton(page), name).toBeFocused()
    }
    // Opened by pointer, «Закрити» closes it the same way.
    await toolsButton(page).click()
    await page.locator('#composer-tools').getByRole('button', { name: 'Заземлення 5-4-3-2-1' }).click()
    await expect(groundDialog(page)).toBeVisible()
    await expect(page.locator('#composer-tools')).toBeHidden()
    await groundDialog(page).getByRole('button', { name: 'Закрити' }).click()
    await expect(groundDialog(page)).toBeHidden()
    await expect(toolsButton(page)).toBeFocused()
  })

  test('#76 ★ «Подихати хвилину»: in 4 s, out 6 s, the step said once; a minute, then «Ще хвилину»; «Стоп» ends it; the light breathes with it; the cyclic sigh', async ({ page, api }) => {
    await page.clock.install()
    await openChat(page)
    const dialog = breatheDialog(page)
    await openTool(page, 'Подихати хвилину')
    const start = dialog.getByRole('button', { name: 'Почати' })
    await expect(start).toBeFocused()
    await expect(dialog).toContainText('Вдих на 4, видих на 6. Можна зупинитися будь-коли.')
    // The focus starts past the instruction: the dialog says it as its description.
    await expect(page.getByRole('dialog', { name: 'Подихати хвилину' })).toHaveAccessibleDescription('Вдих на 4, видих на 6. Можна зупинитися будь-коли.')
    await expect(presence(page)).toHaveAttribute('data-presence', 'breathing')
    await expect(page.locator('[data-presence-label]')).toHaveText('Дихальна вправа')
    const calls = api.calls.length
    await page.keyboard.press('Enter')
    const stop = dialog.getByRole('button', { name: 'Стоп' })
    await expect(stop).toBeFocused()
    const status = dialog.locator('[data-el="breathe-status"]')
    const count = dialog.locator('[data-el="breathe-count"]')
    await expect(status).toHaveText('Вдих')
    await expect(dialog.locator('[data-el="breathe-phase"]')).toHaveText('Вдих')
    await expect(count).toHaveText('4')
    // One pace on the screen: the light beside the dialog (the CSS orb, WebGL is off here) holds
    // still instead of breathing on a clock of its own, out of step with the circle.
    expect(await page.locator('.presence .orb').evaluate((node) => node.getAnimations().filter((a) => a instanceof CSSAnimation).length)).toBe(0)
    await status.evaluate((node) => {
      const w = window as unknown as { __said: string[] }
      w.__said = []
      new MutationObserver(() => w.__said.push(node.textContent ?? '')).observe(node, { childList: true, characterData: true, subtree: true })
    })
    await page.clock.runFor(1100)
    await expect(count).toHaveText('3')
    await page.clock.runFor(3000)
    await expect(status).toHaveText('Видих')
    await expect(count).toHaveText('6')
    await page.clock.runFor(6000)
    await expect(status).toHaveText('Вдих')
    // Said when the step changes, never every second (the seconds are not live).
    expect(await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).toEqual(['Видих', 'Вдих'])
    expect(await count.evaluate((node) => node.closest('[role="status"], [aria-live]'))).toBeNull()
    // The minute: six breaths, then a line and «Ще хвилину»; «Стоп» is «Закрити» again.
    await page.clock.runFor(50_000)
    await expect(dialog.locator('[data-el="breathe-done"]')).toBeVisible()
    await expect(dialog.locator('[data-el="breathe-done"] p').first()).toHaveText('Хвилина минула.')
    await expect(status).toHaveText('Хвилина минула.')
    await expect(dialog.getByRole('button', { name: 'Закрити' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Ще хвилину' }).click()
    await expect(stop).toBeFocused()
    await expect(status).toHaveText('Вдих')
    // «Стоп» ends the exercise: the dialog closes, the focus is back, the light idle again.
    await stop.click()
    await expect(dialog).toBeHidden()
    await expect(toolsButton(page)).toBeFocused()
    await expect(presence(page)).toHaveAttribute('data-presence', 'idle')
    expect(await dialog.evaluate((node) => node.hasAttribute('data-phase'))).toBe(false)
    // The cyclic sigh: in, a short second sip, a long out. Reopened, it starts over as slow breathing.
    await openTool(page, 'Подихати хвилину')
    const sigh = dialog.getByRole('switch', { name: 'Циклічне зітхання' })
    await expect(sigh).toHaveAttribute('aria-checked', 'false')
    await sigh.click()
    await expect(sigh).toHaveAttribute('aria-checked', 'true')
    await expect(dialog).toContainText('Вдих носом, ще короткий довдих — і довгий повільний видих.')
    await expect(page.getByRole('dialog', { name: 'Подихати хвилину' })).toHaveAccessibleDescription('Вдих носом, ще короткий довдих — і довгий повільний видих.')
    await expect(page.locator('[data-presence-label]')).toHaveText('Дихальна вправа')
    await start.click()
    await expect(status).toHaveText('Вдих')
    await page.clock.runFor(2100)
    await expect(status).toHaveText('Ще трохи')
    await page.clock.runFor(1000)
    await expect(status).toHaveText('Видих')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await openTool(page, 'Подихати хвилину')
    await expect(sigh).toHaveAttribute('aria-checked', 'false')
    await expect(start).toBeVisible()
    await page.keyboard.press('Escape')
    // Nothing asked of the server for any of it.
    expect(api.calls.length).toBe(calls)
  })

  test('#77 without motion the minute is a count: «Пауза» and prefers-reduced-motion; with motion the circle breathes and the count steps aside', async ({ page }) => {
    await openChat(page)
    const dialog = breatheDialog(page)
    const count = dialog.locator('[data-el="breathe-count"]')
    const circle = dialog.locator('.breathe__circle')
    const moving = (): Promise<{ transition: string; animations: number }> =>
      dialog.evaluate((node) => ({
        transition: getComputedStyle(node.querySelector('.breathe__circle')!).transitionProperty,
        animations: node.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
      }))
    const run = async (): Promise<void> => {
      await openTool(page, 'Подихати хвилину')
      await dialog.getByRole('button', { name: 'Почати' }).click()
      await expect(dialog.locator('[data-el="breathe-phase"]')).toHaveText('Вдих')
    }
    // Motion on: the circle grows on the in-breath, the count is not shown.
    await expect(html(page)).toHaveAttribute('data-motion', 'on')
    await run()
    await expect(count).toBeHidden()
    expect((await moving()).transition).toContain('scale')
    await expect.poll(() => circle.evaluate((node) => getComputedStyle(node).scale)).not.toBe('0.62')
    await page.keyboard.press('Escape')
    // «Пауза»: the count in words and numbers, nothing moves.
    await page.locator('[data-motion-toggle]').click()
    await expect(html(page)).toHaveAttribute('data-motion', 'off')
    await run()
    await expect(count).toBeVisible()
    await expect(count).toHaveText(/^[1-4]$/)
    expect(await moving()).toEqual({ transition: 'all', animations: 0 })
    expect(await circle.evaluate((node) => getComputedStyle(node).scale)).toBe('none')
    await page.keyboard.press('Escape')
    // Motion allowed on the page, but the system asks for less: the count again.
    await page.locator('[data-motion-toggle]').click()
    await expect(html(page)).toHaveAttribute('data-motion', 'on')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await run()
    await expect(count).toBeVisible()
    expect(await circle.evaluate((node) => getComputedStyle(node).scale)).toBe('none')
    expect((await moving()).animations).toBe(0)
    await page.keyboard.press('Escape')
  })

  test('#78 «Заземлення 5-4-3-2-1»: one step at a time, «Далі» and «Назад», no field to type in; the end offers «Готово» and «Ще раз»', async ({ page }) => {
    await openChat(page)
    const dialog = groundDialog(page)
    await openTool(page, 'Заземлення 5-4-3-2-1')
    await expect(dialog.locator('input, textarea, [contenteditable]')).toHaveCount(0)
    const next = dialog.getByRole('button', { name: 'Далі' })
    const back = dialog.getByRole('button', { name: 'Назад' })
    const status = dialog.locator('[data-el="ground-status"]')
    await expect(next).toBeFocused()
    await expect(back).toBeHidden()
    await expect(dialog.locator('[data-el="ground-progress"]')).toHaveText('Крок 1 з 6')
    await expect(dialog.locator('.ground__step:not([hidden]) .ground__text')).toHaveText('Повільно видихніть. Відчуйте ступні на підлозі.')
    // The focus starts on «Далі»: the step on screen is the dialog's description (the others are not).
    await expect(page.getByRole('dialog', { name: 'Заземлення 5-4-3-2-1' })).toHaveAccessibleDescription('Повільно видихніть. Відчуйте ступні на підлозі.')
    // The shelter first, in the words of the brief (never the stop-list word for an alert).
    await expect(dialog.locator('[data-el="ground-safety"]')).toHaveText('Якщо зараз повітряна небезпека — спершу в укриття. Вправу можна зробити там.')
    await page.keyboard.press('Enter')
    await expect(next).toBeFocused()
    await expect(dialog.locator('.ground__step:not([hidden]) .ground__num')).toHaveText('5')
    await expect(status).toHaveText('Крок 2 з 6. Знайдіть поглядом 5 речей довкола.')
    await expect(dialog.locator('[data-el="ground-safety"]')).toBeHidden()
    await back.click()
    await expect(dialog.locator('[data-el="ground-progress"]')).toHaveText('Крок 1 з 6')
    // «Назад» is gone on the first step: the focus goes to «Далі», not to <body>.
    await expect(next).toBeFocused()
    const numbers: string[] = []
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Enter')
      numbers.push((await dialog.locator('.ground__step:not([hidden]) .ground__num').textContent()) ?? '')
    }
    expect(numbers).toEqual(['5', '4', '3', '2', '1'])
    await page.keyboard.press('Enter')
    await expect(dialog.locator('.ground__step:not([hidden]) .ground__text')).toHaveText('Ви тут. Рухайтеся далі у своєму темпі.')
    await expect(status).toHaveText('Ви тут. Рухайтеся далі у своєму темпі.')
    await expect(dialog.getByRole('button', { name: 'Готово' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Ще раз' }).click()
    await expect(next).toBeFocused()
    await expect(dialog.locator('[data-el="ground-progress"]')).toHaveText('Крок 1 з 6')
    for (let i = 0; i < 6; i++) await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(toolsButton(page)).toBeFocused()
    // Opened again: from the first step.
    await openTool(page, 'Заземлення 5-4-3-2-1')
    await expect(dialog.locator('[data-el="ground-progress"]')).toHaveText('Крок 1 з 6')
    await expect(status).toHaveText('')
  })

  test('#79 ★ «Як ви зараз?»: a cell, then a word; «Додати до розмови» puts a sentence into the field and sends nothing; «А зараз?» on the theses and «Збережено» says before → after in words', async ({ page, api }) => {
    await watchStorage(page)
    await openChat(page)
    const dialog = moodDialog(page)
    // From the new conversation: the chip beside the starters.
    await page.locator('[data-el="starters"]').getByRole('button', { name: 'Як ви зараз?' }).click()
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Як ви зараз?' })).toBeVisible()
    const cells = dialog.locator('.mood__cell')
    await expect(cells).toHaveText(['Багато сил, неприємно', 'Багато сил, приємно', 'Мало сил, неприємно', 'Мало сил, приємно'])
    await expect(cells.first()).toBeFocused()
    await expect(dialog.locator('.mood__word:visible')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Готово' })).toBeHidden()
    await dialog.getByRole('radio', { name: 'Багато сил, неприємно' }).click()
    await expect(cells.first()).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.locator('.mood__word:visible')).toHaveText(['неспокій', 'роздратування', 'злість', 'напруга', 'страх', 'розгубленість'])
    await dialog.getByRole('radio', { name: 'напруга', exact: true }).click()
    await expect(dialog.getByRole('radio', { name: 'напруга', exact: true })).toHaveAttribute('aria-checked', 'true')
    await dialog.getByRole('button', { name: 'Додати до розмови' }).click()
    await expect(dialog).toBeHidden()
    await expect(composer(page)).toHaveValue('Зараз у мене — напруга.')
    await page.waitForTimeout(300)
    expect(api.count('POST /chat/turn')).toBe(0)
    // «Пропустити» and Esc record nothing (the first word stays «напруга» below).
    await openTool(page, 'Як ви зараз?')
    await dialog.getByRole('radio', { name: 'Мало сил, приємно' }).click()
    await dialog.getByRole('radio', { name: 'спокій', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    // The person sends what they chose to; the end of the conversation asks «А зараз?».
    await sendButton(page).click()
    await answered(page, 1)
    await toReview(page)
    const line = page.locator('section[data-screen="review"] [data-el="mood-line"]')
    await expect(line).toHaveText('Спершу — напруга.')
    const now = page.locator('section[data-screen="review"]').getByRole('button', { name: 'А зараз?' })
    await now.click()
    await expect(page.getByRole('dialog', { name: 'А зараз?' })).toBeVisible()
    // No field to add to here.
    await dialog.getByRole('radio', { name: 'Мало сил, приємно' }).click()
    await dialog.getByRole('radio', { name: 'спокій', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Додати до розмови' })).toBeHidden()
    await dialog.getByRole('button', { name: 'Готово' }).click()
    await expect(dialog).toBeHidden()
    await expect(now).toBeFocused()
    await expect(line).toHaveText('Спершу — напруга, зараз — спокій.')
    await expect(line).not.toHaveText(/\d|краще|гірше|%/)
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    await onScreen(page, 'saved')
    await expect(page.locator('section[data-screen="saved"] [data-el="mood-line"]')).toHaveText('Спершу — напруга, зараз — спокій.')
    // Never a tag, never in a body: the word of «А зараз?» went nowhere, and the record saved has
    // neither word (the first one reached the AI only inside the message the person sent).
    expect(JSON.stringify(api.calls.map((call) => call.body))).not.toContain('спокій')
    expect(JSON.stringify(api.bodies('POST /summaries'))).not.toContain('напруга')
    expect(await storageWrites(page)).toEqual([])
    // A new conversation starts without them.
    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    await expect(page.locator('[data-el="mood-after"]:visible')).toHaveCount(0)
    expect((await markup(page)).includes('напруга, зараз')).toBe(false)
  })

  test('#79b «Розмову завершено» after a check-in: «Спершу — …» and «А зараз?»; without a check-in there is neither', async ({ page }) => {
    await openChat(page)
    await exchange(page, USER)
    await endWithoutTheses(page)
    await expect(page.locator('[data-el="mood-after"]:visible')).toHaveCount(0)
    await page.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    await openTool(page, 'Як ви зараз?')
    await moodDialog(page).getByRole('radio', { name: 'Мало сил, неприємно' }).click()
    await moodDialog(page).getByRole('radio', { name: 'втома', exact: true }).click()
    await moodDialog(page).getByRole('button', { name: 'Готово' }).click()
    await expect(composer(page)).toHaveValue('')
    await exchange(page, USER)
    await endWithoutTheses(page)
    await expect(page.locator('section[data-screen="ended"] [data-el="mood-line"]')).toHaveText('Спершу — втома.')
    await expect(page.locator('section[data-screen="ended"]').getByRole('button', { name: 'А зараз?' })).toBeVisible()
  })

  test('#80 ★ the crisis closes each tool in the frame it comes — a running minute, grounding, the check-in, the shelter and breathing over it; no tool opens beside the contacts', async ({ page }) => {
    const stream = await streamTurns(page)
    await openChat(page)
    // What the page shows the moment the crisis screen is set: no dialog still open, in the same task.
    await page.evaluate(() => {
      const w = window as unknown as { __atCrisis: number[] }
      w.__atCrisis = []
      new MutationObserver(() => {
        if (document.documentElement.dataset.screen === 'crisis') w.__atCrisis.push(document.querySelectorAll('dialog[open]').length)
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-screen'] })
    })
    const cases: readonly (readonly string[])[] = [['Подихати хвилину'], ['Заземлення 5-4-3-2-1'], ['Як ви зараз?'], ['В укритті'], ['В укритті', 'Подихати хвилину']]
    for (const [i, steps] of cases.entries()) {
      await send(page, CRISIS_TEXT)
      await stream.requests(i + 1)
      await stream.write(meta())
      await openTool(page, steps[0]!)
      if (steps[1] !== undefined) {
        await shelterDialog(page).getByRole('button', { name: steps[1] }).click()
        await expect(page.locator('dialog[open]')).toHaveCount(2)
      }
      if (steps.at(-1) === 'Подихати хвилину') {
        await breatheDialog(page).getByRole('button', { name: 'Почати' }).click()
        await expect(breatheDialog(page).locator('[data-el="breathe-status"]')).toHaveText('Вдих')
        await expect(presence(page)).toHaveAttribute('data-presence', 'breathing')
      }
      await stream.write(crisis('model'))
      await onScreen(page, 'crisis')
      const label = steps.join(' → ')
      await expect(page.locator('dialog[open]'), label).toHaveCount(0)
      await expect(page.locator('#crisis-title'), label).toBeFocused()
      await expect(presence(page), label).toHaveAttribute('data-presence', 'quiet')
      expect(await page.evaluate(() => (window as unknown as { __atCrisis: number[] }).__atCrisis.at(-1)), label).toBe(0)
      // The minute's clock stopped with it: nothing is said or drawn after the dialog went.
      await page.waitForTimeout(1200)
      await expect(breatheDialog(page).locator('[data-el="breathe-status"]')).toHaveText('')
      expect(await breatheDialog(page).evaluate((node) => node.hasAttribute('data-phase'))).toBe(false)
      if (i === 0) {
        // «Якщо важко» in the crisis: the contacts, and no tools.
        await page.locator('.help-link').click()
        await expect(page.locator('#help-dialog')).toBeVisible()
        await expect(page.locator('[data-el="help-tools"]')).toBeHidden()
        await page.keyboard.press('Escape')
      }
      await page.locator('[data-act="new-after-crisis"]').click()
      await confirmDialog(page).getByRole('button', { name: 'Почати нову', exact: true }).click()
      await onScreen(page, 'chat')
    }
  })

  test('#81 «В укритті»: safety first, dark and silent in the light theme too, large controls; breathing and grounding over it come back to it on Esc', async ({ page, api }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await openChat(page)
    await expect(html(page)).toHaveCSS('background-color', PAPER)
    const dialog = shelterDialog(page)
    await openTool(page, 'В укритті')
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Спершу — безпека' })).toHaveAccessibleDescription('Якщо ви ще не в укритті — ідіть туди. Ця сторінка зачекає.')
    // The first words are about safety; the contacts are the page's own, not a request.
    const text = (await dialog.innerText()).toLowerCase()
    expect(text.indexOf('безпека')).toBeLessThan(text.indexOf('подихати'))
    expect(text).not.toMatch(/тривог/)
    await expect(dialog.locator('a[href="tel:112"]')).toBeVisible()
    await expect(dialog.locator('a[href="tel:103"]')).toBeVisible()
    await expect(dialog.locator('a[href="https://howareu.com/hot-lines"]')).toBeVisible()
    // Dark whatever the theme: the dark theme's background and text, and the gutter beside it.
    expect(await dialog.evaluate((node) => ({ bg: getComputedStyle(node).backgroundColor, text: getComputedStyle(node).color }))).toEqual({
      bg: LAMP,
      text: 'rgb(236, 241, 237)',
    })
    await expect(html(page)).toHaveCSS('background-color', LAMP)
    // The browser's own bar goes dark with it (the one theme-color, still theme.ts's).
    const themeColor = page.locator('meta[name="theme-color"]')
    await expect(themeColor).toHaveAttribute('content', LAMP)
    // Large controls: 64 px for the tools, 56 px for «Закрити».
    for (const button of await dialog.locator('.shelter__button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(63.5)
    expect((await dialog.getByRole('button', { name: 'Закрити' }).boundingBox())!.height).toBeGreaterThanOrEqual(55.5)
    // Silent: the sound stays off however it was set.
    await expect(html(page)).not.toHaveAttribute('data-sound', 'on')
    // Breathing over it keeps it dark; Esc gives the shelter back with the focus on its button.
    const breathe = dialog.getByRole('button', { name: 'Подихати хвилину' })
    await breathe.click()
    await expect(breatheDialog(page)).toBeVisible()
    await expect(breatheDialog(page)).toHaveAttribute('data-shelter', '')
    expect(await breatheDialog(page).evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(LAMP)
    await page.keyboard.press('Escape')
    await expect(breatheDialog(page)).toBeHidden()
    await expect(dialog).toBeVisible()
    await expect(breathe).toBeFocused()
    await dialog.getByRole('button', { name: 'Заземлення 5-4-3-2-1' }).click()
    // The shelter's own line about the shelter is not repeated there.
    await expect(groundDialog(page).locator('[data-el="ground-safety"]')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(dialog.getByRole('button', { name: 'Заземлення 5-4-3-2-1' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(toolsButton(page)).toBeFocused()
    await expect(html(page)).toHaveCSS('background-color', PAPER)
    await expect(themeColor).toHaveAttribute('content', PAPER)
    await expect(breatheDialog(page)).not.toHaveAttribute('data-shelter', '')
    expect(api.count('GET /helplines')).toBe(0)
  })

  test('#81b the shelter is the dark theme to the last edge: every colour inside it, and inside breathing and grounding over it, is the same in both themes', async ({ page }) => {
    // Computed colours of every node shown (and its ::before/::after): a token the shelter does not
    // restate would bring the light theme's value in (tokens.css resolves light-dark() on :root).
    const colours = (dialog: Locator): Promise<Record<string, string>> =>
      dialog.evaluate((root) => {
        const props = ['color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'boxShadow', 'fill', 'stroke', 'textDecorationColor', 'caretColor', 'accentColor'] as const
        const out: Record<string, string> = {}
        for (const [i, node] of [root, ...Array.from(root.querySelectorAll('*'))].entries()) {
          if (node.getClientRects().length === 0) continue
          for (const pseudo of [null, '::before', '::after']) {
            const style = getComputedStyle(node, pseudo)
            if (pseudo !== null && (style.content === 'none' || style.content === 'normal')) continue
            out[`${i} ${node.tagName.toLowerCase()}.${String(node.getAttribute('class') ?? '')}${pseudo ?? ''}`] = props.map((p) => style[p]).join(' | ')
          }
        }
        return out
      })
    const same = async (dialog: Locator, label: string): Promise<void> => {
      // No hover and no colour still easing: the pointer leaves, the transitions end.
      await page.mouse.move(1, 1)
      await dialog.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished)))
      // The page under it says which theme is on: its text is --color-text of that theme.
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(page.locator('body')).toHaveCSS('color', 'rgb(236, 241, 237)')
      const dark = await colours(dialog)
      await page.emulateMedia({ colorScheme: 'light' })
      await expect(page.locator('body')).toHaveCSS('color', 'rgb(28, 38, 38)')
      expect(await colours(dialog), label).toEqual(dark)
      expect(Object.keys(dark).length, label).toBeGreaterThan(8)
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await openChat(page)
    await openTool(page, 'В укритті')
    await same(shelterDialog(page), 'the shelter')
    // Breathing over it, before «Почати»: the switch, the open «Чому це може допомогти», a focus ring.
    await shelterDialog(page).getByRole('button', { name: 'Подихати хвилину' }).click()
    await breatheDialog(page).locator('summary').click()
    await breatheDialog(page).getByRole('switch').focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await same(breatheDialog(page), 'breathing, ready')
    await breatheDialog(page).getByRole('button', { name: 'Почати' }).click()
    await same(breatheDialog(page), 'breathing, running')
    await page.keyboard.press('Escape')
    await shelterDialog(page).getByRole('button', { name: 'Заземлення 5-4-3-2-1' }).click()
    await groundDialog(page).getByRole('button', { name: 'Далі' }).click()
    await same(groundDialog(page), 'grounding')
  })

  test('#82 ★ the kit without a conversation: from the signed-out screen and «Якщо важко», no request and no storage; the new conversation stays unstarted', async ({ page, api }) => {
    await watchStorage(page)
    api.on('GET /me', fail(401, 'unauthenticated'))
    await openChat(page, '/chat/', 'signed-out')
    await page.evaluate(() => document.fonts.ready)
    const calls = api.calls.length
    const requests = countRequests(page)
    const kit = page.locator('section[data-screen="signed-out"] .kit')
    for (const [name, dialog] of [
      ['Подихати хвилину', breatheDialog(page)],
      ['Заземлення 5-4-3-2-1', groundDialog(page)],
      ['В укритті', shelterDialog(page)],
    ] as const) {
      const button = kit.getByRole('button', { name })
      await button.click()
      await expect(dialog).toBeVisible()
      if (name === 'Подихати хвилину') {
        await dialog.getByRole('button', { name: 'Почати' }).click()
        await expect(dialog.locator('[data-el="breathe-status"]')).toHaveText('Вдих')
      }
      if (name === 'Заземлення 5-4-3-2-1') await dialog.getByRole('button', { name: 'Далі' }).click()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(button).toBeFocused()
    }
    expect(api.calls.length).toBe(calls)
    expect(requests()).toEqual([])
    expect(await storageWrites(page)).toEqual([])
    await expect(html(page)).toHaveAttribute('data-screen', 'signed-out')
  })

  test('#82b «Якщо важко» offers the tools under the contacts: the tool stands over it, Esc gives the contacts back; no request but its own GET /helplines', async ({ page, api }) => {
    await watchStorage(page)
    await openChat(page)
    await page.locator('.help-link').click()
    const help = page.locator('#help-dialog')
    await expect(help).toBeVisible()
    await expect(help.getByRole('list', { name: 'Вправи без розмови' }).getByRole('button')).toHaveText(['Подихати хвилину', 'Заземлення 5-4-3-2-1', 'В укритті'])
    await expect.poll(() => api.count('GET /helplines')).toBe(1)
    const calls = api.calls.length
    const ground = help.getByRole('button', { name: 'Заземлення 5-4-3-2-1' })
    await ground.click()
    await expect(groundDialog(page)).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(groundDialog(page)).toBeHidden()
    await expect(help).toBeVisible()
    await expect(ground).toBeFocused()
    await help.getByRole('button', { name: 'В укритті' }).click()
    await shelterDialog(page).getByRole('button', { name: 'Подихати хвилину' }).click()
    await expect(page.locator('dialog[open]')).toHaveCount(3)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(help).toBeVisible()
    await expect(help.getByRole('button', { name: 'В укритті' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('.help-link')).toBeFocused()
    expect(api.calls.length).toBe(calls)
    expect(await storageWrites(page)).toEqual([])
    // The conversation never started: no session, no turn.
    await expect(page.locator('[data-el="session"]')).toBeHidden()
    expect(api.count('POST /chat/turn')).toBe(0)
  })

  test('#83 axe on every tool in both themes: breathing ready and running, grounding, the check-in with a word, the shelter and breathing over it, «Якщо важко» with its tools', async ({ page }) => {
    await openChat(page)
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(html(page)).toHaveCSS('background-color', scheme === 'dark' ? LAMP : PAPER)
      await openTool(page, 'Подихати хвилину')
      await axe(page, `${scheme}: breathing, ready`)
      await breatheDialog(page).getByRole('button', { name: 'Почати' }).click()
      await axe(page, `${scheme}: breathing, running`)
      await page.keyboard.press('Escape')
      await openTool(page, 'Заземлення 5-4-3-2-1')
      await page.keyboard.press('Enter')
      await axe(page, `${scheme}: grounding, step 2`)
      await page.keyboard.press('Escape')
      await openTool(page, 'Як ви зараз?')
      await moodDialog(page).getByRole('radio', { name: 'Мало сил, приємно' }).click()
      await moodDialog(page).getByRole('radio', { name: 'затишок', exact: true }).click()
      await axe(page, `${scheme}: the check-in with a word`)
      await page.keyboard.press('Escape')
      await openTool(page, 'В укритті')
      await axe(page, `${scheme}: the shelter`)
      await shelterDialog(page).getByRole('button', { name: 'Подихати хвилину' }).click()
      await breatheDialog(page).getByRole('button', { name: 'Почати' }).click()
      await axe(page, `${scheme}: breathing in the shelter`)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.locator('.help-link').click()
      await expect(page.locator('[data-el="help-tools"]')).toBeVisible()
      await axe(page, `${scheme}: «Якщо важко» with the tools`)
      await page.keyboard.press('Escape')
    }
  })

  test('#84 axe in both themes: the kit on the signed-out screen, the check-in chip, «А зараз?» on the theses', async ({ page, api }) => {
    api.on('GET /me', fail(401, 'unauthenticated'), { json: ME })
    await openChat(page, '/chat/', 'signed-out')
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(page.locator('section[data-screen="signed-out"] .kit')).toBeVisible()
      await axe(page, `${scheme}: signed-out with the kit`)
    }
    await page.emulateMedia({ colorScheme: 'dark' })
    await openChat(page)
    await page.locator('[data-el="checkin"]').click()
    await moodDialog(page).getByRole('radio', { name: 'Багато сил, приємно' }).click()
    await moodDialog(page).getByRole('radio', { name: 'цікавість', exact: true }).click()
    await moodDialog(page).getByRole('button', { name: 'Готово' }).click()
    await exchange(page, USER)
    await toReview(page)
    await expect(page.locator('section[data-screen="review"] [data-el="mood-line"]')).toHaveText('Спершу — цікавість.')
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(html(page)).toHaveCSS('background-color', scheme === 'dark' ? LAMP : PAPER)
      await axe(page, `${scheme}: the theses with «А зараз?»`)
    }
  })

  test('#85 the tools fit: at 320 px nothing leaves the dialog; a phone on its side keeps «Стоп» in view', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'a phone layout')
    await page.setViewportSize({ width: 320, height: 640 })
    await openChat(page)
    const overflow = (dialog: Locator): Promise<string[]> =>
      dialog.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return Array.from(node.querySelectorAll<HTMLElement>('*'))
          .filter((el) => el.getClientRects().length > 0 && el.closest('.visually-hidden') === null)
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)
          })
          .map((el) => `<${el.tagName.toLowerCase()} class="${el.className}">`)
      })
    await openTool(page, 'Як ви зараз?')
    await moodDialog(page).getByRole('radio', { name: 'Багато сил, неприємно' }).click()
    await moodDialog(page).getByRole('radio', { name: 'розгубленість', exact: true }).click()
    expect(await overflow(moodDialog(page))).toEqual([])
    await page.keyboard.press('Escape')
    await openTool(page, 'В укритті')
    expect(await overflow(shelterDialog(page))).toEqual([])
    await shelterDialog(page).getByRole('button', { name: 'Подихати хвилину' }).click()
    await breatheDialog(page).getByRole('button', { name: 'Почати' }).click()
    expect(await overflow(breatheDialog(page))).toEqual([])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await openTool(page, 'Заземлення 5-4-3-2-1')
    expect(await overflow(groundDialog(page))).toEqual([])
    await page.keyboard.press('Escape')
    // 839 × 200: the body scrolls under the head; «Стоп» never leaves the screen.
    await page.setViewportSize({ width: 839, height: 200 })
    await openTool(page, 'Подихати хвилину')
    await breatheDialog(page).getByRole('button', { name: 'Почати' }).click()
    const stop = breatheDialog(page).getByRole('button', { name: 'Стоп' })
    await expect(stop).toBeInViewport({ ratio: 1 })
    await breatheDialog(page).locator('.tool__body').evaluate((node) => node.scrollTo({ top: node.scrollHeight }))
    await expect(stop).toBeInViewport({ ratio: 1 })
  })

  test('#86 ★ the tools hold still under the pointer: «Далі» in one place on every step and two presses go two steps on; the check-in and breathing keep their head where they opened', async ({ page }) => {
    await openChat(page)
    /** Where a control is once the dialog's entrance (a fade and a short rise) is over. */
    const at = async (dialog: Locator, control: Locator, edge: 'left' | 'right' = 'left'): Promise<{ x: number; y: number }> => {
      await dialog.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished)))
      const box = (await control.boundingBox())!
      return { x: Math.round(edge === 'left' ? box.x : box.x + box.width), y: Math.round(box.y) }
    }
    // Grounding: «Назад» comes after «Далі», never before it; the steps share one box as tall as the
    // tallest, so «Далі» stays where it was from the first step to the last.
    const ground = groundDialog(page)
    await openTool(page, 'Заземлення 5-4-3-2-1')
    const next = ground.getByRole('button', { name: 'Далі' })
    const progress = ground.locator('[data-el="ground-progress"]')
    const first = await at(ground, next)
    const box = (await next.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(progress).toHaveText('Крок 2 з 6')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(progress).toHaveText('Крок 3 з 6')
    for (let n = 3; n <= 6; n++) {
      await expect(progress).toHaveText(`Крок ${n} з 6`)
      expect(await at(ground, next), `«Далі» on step ${n}`).toEqual(first)
      if (n < 6) await next.click()
    }
    // The end: «Готово» where «Далі» was — a second press there ends, it never starts over.
    await next.click()
    const done = ground.getByRole('button', { name: 'Готово' })
    await expect(done).toBeVisible()
    expect(await at(ground, done)).toEqual(first)
    await done.click()
    await expect(ground).toBeHidden()
    // «Як ви зараз?»: the words appear under the cells; the cell just pressed and «Пропустити» stay.
    const mood = moodDialog(page)
    await openTool(page, 'Як ви зараз?')
    const cell = mood.getByRole('radio', { name: 'Мало сил, неприємно' })
    const skip = mood.getByRole('button', { name: 'Пропустити' })
    const cellAt = await at(mood, cell)
    const skipAt = await at(mood, skip)
    await cell.click()
    await expect(mood.locator('.mood__word:visible')).toHaveCount(6)
    expect(await at(mood, cell)).toEqual(cellAt)
    await mood.getByRole('radio', { name: 'втома', exact: true }).click()
    await expect(mood.getByRole('button', { name: 'Готово' })).toBeVisible()
    expect(await at(mood, cell)).toEqual(cellAt)
    expect(await at(mood, skip)).toEqual(skipAt)
    await page.keyboard.press('Escape')
    // Breathing: «Закрити» turns into «Стоп» in the same place (the head's right edge) when the
    // circle replaces «Почати».
    const breathe = breatheDialog(page)
    await openTool(page, 'Подихати хвилину')
    const head = breathe.locator('[data-el="breathe-close"]')
    const headAt = await at(breathe, head, 'right')
    await breathe.getByRole('button', { name: 'Почати' }).click()
    await expect(head).toHaveText('Стоп')
    expect(await at(breathe, head, 'right')).toEqual(headAt)
    await page.keyboard.press('Escape')
  })

  test('#87 «Як ви зараз?» before the first message in a scenario without starters of its own; «А зараз?» waits while the theses are being saved', async ({ page, api }) => {
    // A scenario a newer server adds: no starters here, the check-in still offered.
    api.on('GET /scenarios', {
      json: [...SCENARIOS, { id: 'synthetic_walk', title: 'Синтетична прогулянка', description: 'Синтетичний опис.', opening_message: 'Синтетичне перше питання?', needs_summaries: false }],
    })
    await openChat(page)
    await scenarioList(page).getByRole('radio', { name: 'Синтетична прогулянка' }).check()
    const box = page.locator('[data-el="starters"]')
    await expect(box).toBeVisible()
    await expect(box.locator('button.starter')).toHaveCount(0)
    await box.getByRole('button', { name: 'Як ви зараз?' }).click()
    await moodDialog(page).getByRole('radio', { name: 'Мало сил, приємно' }).click()
    await moodDialog(page).getByRole('radio', { name: 'спокій', exact: true }).click()
    await moodDialog(page).getByRole('button', { name: 'Готово' }).click()
    await expect(moodDialog(page)).toBeHidden()
    // The theses, saved slowly: «А зараз?» is aria-disabled and opens nothing until «Збережено».
    const held = gate()
    api.on('POST /summaries', async (call) => {
      await held.wait
      return { status: 201, json: storedFrom(call.body) }
    })
    await exchange(page, USER)
    await toReview(page)
    const now = page.locator('section[data-screen="review"]').getByRole('button', { name: 'А зараз?' })
    await expect(now).not.toHaveAttribute('aria-disabled', 'true')
    await page.getByRole('button', { name: 'Зберегти в щоденник' }).click()
    await expect(now).toHaveAttribute('aria-disabled', 'true')
    // Pressed anyway (aria-disabled keeps it focusable and clickable): nothing opens.
    await now.click({ force: true })
    await page.waitForTimeout(300)
    await expect(moodDialog(page)).toBeHidden()
    held.open()
    await onScreen(page, 'saved')
    const after = page.locator('section[data-screen="saved"]').getByRole('button', { name: 'А зараз?' })
    await expect(after).not.toHaveAttribute('aria-disabled', 'true')
    await after.click()
    await expect(page.getByRole('dialog', { name: 'А зараз?' })).toBeVisible()
  })
})

// ── «→ У тези», the reminder to pause, the soft end, and what reviewers found (phase C3) ──────

/** Which reply a per-reply action is about: its number among the AI's replies and its time. */
const which = async (li: Locator, n: number): Promise<string> => `відповідь ${n}, ${(await li.locator('.said__time').textContent())!.trim()}`
const keepOf = (li: Locator): Locator => li.locator('[data-act="keep-reply"]')
const pauseText = (page: Page): Locator => page.locator('[data-el="pause-text"]')
const pauseActions = (page: Page): Locator => page.locator('[data-el="pause-actions"]')
const candidates = (page: Page): Locator => page.locator('[data-el="candidates"]')
const SHARE = 'Можливо, варто поділитися цим із кимось близьким?'
const PRAISE = /Добре, що ви|молодець|чудово|пишаю/i

test.describe('highlights, the reminder to pause, the soft end', () => {
  test('#88 ★ «→ У тези» under a reply: a toggle whose name says which reply; marked replies wait on the theses screen; one becomes a thesis, is saved and is «Взяти з собою»', async ({ page, api }, testInfo) => {
    await openChat(page)
    await exchange(page, USER)
    await exchange(page, 'Друге синтетичне повідомлення.')
    const [first, second] = [aiMessages(page).nth(1), aiMessages(page).nth(2)]
    // Every action under a reply has a name of its own: the visible words, then which reply.
    await expect(keepOf(first)).toHaveAccessibleName(`У тези ${await which(first, 1)}`)
    await expect(first.locator('[data-act="copy-reply"]')).toHaveAccessibleName(`Копіювати ${await which(first, 1)}`)
    await expect(keepOf(second)).toHaveAccessibleName(`У тези ${await which(second, 2)}`)
    const names = await page.locator('[data-el="talk"] .said__act:not([hidden])').evaluateAll((nodes) => nodes.map((n) => n.textContent!.trim()))
    expect(names).toHaveLength(4)
    expect(new Set(names).size, names.join(' | ')).toBe(4)
    // The opening message is no reply: nothing under it.
    await expect(aiMessages(page).first().locator('.said__act:not([hidden])')).toHaveCount(0)
    await expect(keepOf(first)).toHaveAttribute('aria-pressed', 'false')
    const opacity = (l: Locator): Promise<string> => l.evaluate((n) => getComputedStyle(n).opacity)
    if (isDesktop(testInfo)) {
      // A mouse: the actions wait for the pointer or the focus.
      await page.mouse.move(2, 2)
      await expect.poll(() => opacity(keepOf(first))).toBe('0')
    } else {
      await expect(keepOf(first)).toBeVisible()
      expect(await opacity(keepOf(first))).toBe('1')
    }
    await keepOf(first).click()
    await expect(keepOf(first)).toHaveAttribute('aria-pressed', 'true')
    await expect(announcer(page)).toHaveText('Додано до тез · 1 з 5')
    // The words stay the same; pressed says the state (a tick beside them, not colour alone).
    await expect(keepOf(first)).toHaveAccessibleName(`У тези ${await which(first, 1)}`)
    if (isDesktop(testInfo)) {
      await page.mouse.move(2, 2)
      await expect.poll(() => opacity(keepOf(first))).toBe('1')
      await expect.poll(() => opacity(keepOf(second))).toBe('0')
    }
    await keepOf(first).click()
    await expect(keepOf(first)).toHaveAttribute('aria-pressed', 'false')
    await expect(announcer(page)).toHaveText('Прибрано з тез · 0 з 5')
    await keepOf(first).click()
    await keepOf(second).click()
    await expect(announcer(page)).toHaveText('Додано до тез · 2 з 5')
    // Nothing of it goes to the server with a turn.
    for (const body of turnBodies(api.bodies('POST /chat/turn'))) expect(Object.keys(body).sort()).toEqual(['messages', 'scenario'])

    await toReview(page)
    expect(Object.keys(api.bodies('POST /chat/summarize')[0] as object).sort()).toEqual(['messages', 'scenario'])
    await expect(candidates(page)).toBeVisible()
    await expect(candidates(page).getByRole('heading', { name: 'Позначене в розмові' })).toBeVisible()
    await expect(candidates(page).locator('.candidate__text')).toHaveText([REPLY_TEXT, REPLY_TEXT])
    await axe(page, 'the theses with two marked replies')
    // «Додати до тез»: a thesis (the draft had four; now five), the focus in it.
    await candidates(page).getByRole('button', { name: 'Додати до тез (позначене 1)' }).click()
    await expect(page.locator('#thesis-m2')).toBeFocused()
    await expect(page.locator('#thesis-m2')).toHaveValue(REPLY_TEXT)
    await expect(page.locator('.thesis:not(.thesis--removed)')).toHaveCount(5)
    // Five theses: the other one waits, and says why.
    const rest = candidates(page).getByRole('button', { name: 'Додати до тез (позначене 1)' })
    await expect(rest).toHaveAttribute('aria-disabled', 'true')
    await expect(rest).toHaveAccessibleDescription('Тез уже пʼять — щоб додати цю, приберіть одну з них.')
    // Pressed anyway (aria-disabled keeps it focusable and clickable): nothing comes in.
    await rest.click({ force: true })
    await expect(page.locator('.thesis:not(.thesis--removed)')).toHaveCount(5)
    // «Прибрати»: the candidate goes, the focus stays near (not at the top of the screen).
    await candidates(page).getByRole('button', { name: 'Прибрати (позначене 1)' }).click()
    await expect(candidates(page)).toBeHidden()
    await expect(page.locator('#review-title')).not.toBeFocused()
    await expect(page.locator('body')).not.toBeFocused()

    await page.locator('[data-el="review-save"]').click()
    await onScreen(page, 'saved')
    const saved = api.bodies('POST /summaries')[0] as { bullets: string[] }
    expect(saved.bullets).toEqual([...DRAFT.bullets, REPLY_TEXT])
    await expect(page.locator('[data-el="saved-keep"]')).toBeVisible()
    await expect(page.locator('[data-el="saved-keep"] .closing__label')).toHaveText('Взяти з собою')
    await expect(page.locator('[data-el="saved-keep-text"]')).toHaveText(REPLY_TEXT)
    await expect(page.locator('section[data-screen="saved"] .closing__share')).toHaveText(SHARE)
    await expect(page.locator('section[data-screen="saved"]')).not.toContainText(PRAISE)
    await axe(page, 'saved with a thought to take along')
  })

  test('#89 marks belong to the conversation: the theses and back keep them; five at most; the crisis has none and its copy no actions', async ({ page, api }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'state, not layout')
    api.on('POST /chat/turn', { sse: reply() }, { sse: reply() }, { sse: reply() }, { sse: reply() }, { sse: reply() }, { sse: reply() }, { sse: meta() + crisis('keyword') })
    await openChat(page)
    for (let i = 1; i <= 6; i++) await exchange(page, `Синтетичне повідомлення ${i}.`)
    for (let i = 1; i <= 5; i++) await keepOf(aiMessages(page).nth(i)).click()
    await expect(announcer(page)).toHaveText('Додано до тез · 5 з 5')
    // The sixth: nothing changes, and the live region says why.
    await keepOf(aiMessages(page).nth(6)).click()
    await expect(keepOf(aiMessages(page).nth(6))).toHaveAttribute('aria-pressed', 'false')
    await expect(announcer(page)).toHaveText('У тезах уже 5 з 5. Щоб додати цю, приберіть іншу.')
    await toReview(page)
    await expect(candidates(page).locator('.candidate')).toHaveCount(5)
    await page.getByRole('button', { name: 'Повернутися до розмови' }).click()
    await onScreen(page, 'chat')
    await expect(page.locator('[data-el="talk"] [data-act="keep-reply"][aria-pressed="true"]')).toHaveCount(5)
    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    await expect(page.locator('[data-el="crisis-talk"] li')).not.toHaveCount(0)
    await expect(page.locator('[data-el="crisis-talk"] [data-act="keep-reply"], [data-el="crisis-talk"] .said__meta')).toHaveCount(0)
    await expect(page.locator('[data-el="pause-text"]')).toHaveCount(0)
  })

  test('#90 ★ the reminder to pause (fake clock): one quiet line over the field 40 minutes after the first message; nothing blocked; «Сховати» for good', async ({ page }) => {
    await page.clock.install()
    await openChat(page)
    // A live line, there while empty (§5.7): no text, no buttons.
    await expect(pauseText(page)).toHaveAttribute('role', 'status')
    await expect(pauseText(page)).toHaveText('')
    await exchange(page, USER)
    await page.clock.fastForward('39:30')
    await expect(pauseActions(page)).toBeHidden()
    await expect(pauseText(page)).toHaveText('')
    await page.clock.fastForward('00:30')
    await expect(pauseText(page)).toHaveText('Ви тут уже 40 хвилин. Можна зробити паузу або зібрати тези.')
    await expect(pauseActions(page)).toBeVisible()
    // Never in the way: the focus stays, the field takes a message, the answer comes.
    await expect(page.locator('body')).not.toBeFocused()
    await exchange(page, 'Ще одне синтетичне повідомлення.')
    await expect(pauseText(page)).not.toHaveText('')
    await axe(page, 'the reminder to pause')
    await page.getByRole('button', { name: 'Сховати' }).click()
    await expect(pauseText(page)).toHaveText('')
    await expect(pauseActions(page)).toBeHidden()
    await expect(page.locator('body')).not.toBeFocused()
    // Once a conversation: not with time, not with an answer.
    await page.clock.fastForward('01:30:00')
    await exchange(page, 'І ще одне.')
    await expect(pauseText(page)).toHaveText('')
  })

  test('#91 the reminder’s timer goes with the screen and the conversation: back from the diary it comes once; «Зібрати тези» opens «Завершити розмову?»; none in or after the crisis', async ({ page, api }) => {
    api.on('GET /tags', { json: [] })
    api.on('GET /reviews/weekly', { json: weekly('2026-10-19') })
    api.on('POST /chat/turn', { sse: reply() }, { sse: meta() + crisis('keyword') }, { sse: reply() })
    await page.clock.install()
    await openChat(page)
    await exchange(page, USER)
    await page.clock.fastForward('30:00')
    await openDiary(page)
    // The diary has no composer and no reminder; time passes there.
    await page.clock.fastForward('15:00')
    await page.getByRole('button', { name: 'До розмови' }).click()
    await onScreen(page, 'chat')
    await expect(pauseText(page)).toHaveText('Ви тут уже 40 хвилин. Можна зробити паузу або зібрати тези.')
    // «Зібрати тези»: the confirm that says the text goes to the AI once more; the line is gone.
    await page.getByRole('button', { name: 'Зібрати тези' }).click()
    await expect(confirmDialog(page)).toBeVisible()
    await expect(confirmDialog(page).getByRole('heading', { name: 'Завершити розмову?' })).toBeVisible()
    await expect(pauseText(page)).toHaveText('')
    await page.keyboard.press('Escape')
    await expect(confirmDialog(page)).toBeHidden()
    await expect(page.locator('[data-el="session-end"]')).toBeFocused()
    // The crisis: no line now, none later, none in the next conversation before its own time.
    await send(page, CRISIS_TEXT)
    await onScreen(page, 'crisis')
    await page.clock.fastForward('02:00:00')
    await expect(page.locator('[data-el="pause-text"]')).toHaveCount(0)
    await page.locator('[data-act="new-after-crisis"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Почати нову', exact: true }).click()
    await onScreen(page, 'chat')
    await page.clock.fastForward('01:00:00')
    await expect(pauseText(page)).toHaveText('')
    // The new conversation counts its own 40 minutes, from its own first message: nothing at 39:30,
    // the line at 40:00 — the crisis took nothing of the reminder with it.
    await exchange(page, USER)
    await page.clock.fastForward('39:30')
    await expect(pauseText(page)).toHaveText('')
    await page.clock.fastForward('00:30')
    await expect(pauseText(page)).toHaveText('Ви тут уже 40 хвилин. Можна зробити паузу або зібрати тези.')
  })

  test('#121 the 40 minutes run out while an answer comes, and the answer ends without `done` («Зупинити»): the line comes then, not never', async ({ page, api }) => {
    const never = gate()
    api.on('POST /chat/turn', { sse: reply() }, async () => {
      await never.wait
      return { sse: reply() }
    })
    await page.clock.install()
    await openChat(page)
    await exchange(page, USER)
    await page.clock.fastForward('39:50')
    await send(page, 'Друге синтетичне повідомлення.')
    const stop = page.getByRole('button', { name: 'Зупинити відповідь' })
    await expect(stop).toBeVisible()
    // 40:10 — past the 40 minutes, under the 35 s headers timeout: nothing while the AI writes.
    await page.clock.fastForward('00:20')
    await expect(pauseText(page)).toHaveText('')
    await stop.click()
    await expect(lastUser(page).locator('.said__flag')).toHaveText('Відповідь зупинено')
    await expect(pauseText(page)).toHaveText('Ви тут уже 40 хвилин. Можна зробити паузу або зібрати тези.')
    await expect(pauseActions(page)).toBeVisible()
  })

  test('#92 a soft end: no praise and nothing that holds on; one line about people on «Збережено» and «Розмову завершено»; no thought to take along without a mark', async ({ page }) => {
    await openChat(page)
    await exchange(page, USER)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Завершити без тез' }).click()
    await confirmDialog(page).getByRole('button', { name: 'Завершити', exact: true }).click()
    await onScreen(page, 'ended')
    const ended = page.locator('section[data-screen="ended"]')
    await expect(ended.locator('.closing__share')).toHaveText(SHARE)
    await expect(ended).not.toContainText(PRAISE)
    await expect(ended.locator('a[href="tel:112"]')).toBeVisible()
    await axe(page, 'ended, the soft end')
    await ended.getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    await exchange(page, USER)
    await toReview(page)
    await expect(candidates(page)).toBeHidden()
    await page.locator('[data-el="review-save"]').click()
    await onScreen(page, 'saved')
    await expect(page.locator('[data-el="saved-keep"]')).toBeHidden()
    await expect(page.locator('section[data-screen="saved"] .closing__share')).toHaveText(SHARE)
    await expect(page.locator('section[data-screen="saved"]')).not.toContainText(PRAISE)
  })

})

test.describe('highlights and the reminder in the light theme', () => {
  test.use({ colorScheme: 'light' })

  test('#98 axe in the light theme: a marked reply, the reminder to pause, the candidates, «Взяти з собою»', async ({ page }) => {
    await page.clock.install()
    await openChat(page)
    await exchange(page, USER)
    await keepOf(aiMessages(page).nth(1)).click()
    await page.mouse.move(2, 2)
    await axe(page, 'light: a marked reply')
    await page.clock.fastForward('40:00')
    await expect(pauseText(page)).not.toHaveText('')
    await axe(page, 'light: the reminder to pause')
    await toReview(page)
    await expect(candidates(page)).toBeVisible()
    await axe(page, 'light: the candidates')
    await candidates(page).getByRole('button', { name: 'Додати до тез (позначене 1)' }).click()
    // DRAFT has four theses: the fifth fits.
    await page.locator('[data-el="review-save"]').click()
    await onScreen(page, 'saved')
    await expect(page.locator('[data-el="saved-keep"]')).toBeVisible()
    await axe(page, 'light: «Збережено» with a thought to take along')
    // «Розмову завершено» with its line about people, in the light theme too.
    await page.locator('section[data-screen="saved"]').getByRole('button', { name: 'Почати нову розмову' }).click()
    await onScreen(page, 'chat')
    await exchange(page, USER)
    await page.locator('[data-el="session-end"]').click()
    await confirmDialog(page).getByRole('button', { name: 'Завершити без тез' }).click()
    await confirmDialog(page).getByRole('button', { name: 'Завершити', exact: true }).click()
    await onScreen(page, 'ended')
    await expect(page.locator('section[data-screen="ended"] .closing__share')).toHaveText(SHARE)
    await axe(page, 'light: ended, the soft end')
  })
})

// ── What the review of phase B found: the bar, the Tab order, the edges, the names, 1.4.11 ───────

/** The top band's solid part ends under the session row; its fade is --fade-top tall. Every line of
 *  the transcript that lies partly inside the fade (rect of the words, not of a 44 px hit area). */
async function halfFaded(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const fade = getComputedStyle(document.documentElement).getPropertyValue('--fade-top').trim()
    const fadePx = fade.endsWith('rem') ? parseFloat(fade) * rem : parseFloat(fade) || 0
    const solid = document.querySelector('[data-el="session"]')!.getBoundingClientRect().bottom
    const hits: string[] = []
    const words = document.querySelectorAll('[data-el="talk"] :is(.said__time, .said__text p, .said__who, .said__copy-label, .said__keep-label)')
    for (const node of Array.from(words)) {
      if (node.closest('[hidden]') !== null || node.getClientRects().length === 0) continue
      for (const r of Array.from(node.getClientRects())) {
        if (r.bottom > solid + 0.5 && r.top < solid + fadePx - 0.5) hits.push(`${node.className || node.tagName}: ${Math.round(r.top)}..${Math.round(r.bottom)} in ${Math.round(solid)}..${Math.round(solid + fadePx)}`)
      }
    }
    return hits
  })
}

/** WCAG 1.4.11 on every operable control in view (the open modal's only, when one is open): a
 *  control drawn with a border under 3:1 must be named by visible words or an icon ≥ 3:1. Fields
 *  never count as identified by their words: their border is their shape. */
async function borderOnlyControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (c: string): number[] | null => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c)
      return m ? [+m[1]!, +m[2]!, +m[3]!, m[4] === undefined ? 1 : +m[4]] : null
    }
    const lin = (v: number): number => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    const lum = (c: number[]): number => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!)
    const ratio = (a: number[], b: number[]): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    const over = (fg: number[], bg: number[]): number[] => [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!)).concat(1)
    const page = parse(getComputedStyle(document.documentElement).backgroundColor)!
    const ground = (el: Element): number[] => {
      const layers: number[][] = []
      for (let n = el.parentElement; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c && c[3]! > 0) layers.push(c)
        if ((c && c[3] === 1) || n.tagName === 'DIALOG') break
      }
      return layers.reverse().reduce((base, c) => over(c, base), page)
    }
    const modal = Array.from(document.querySelectorAll('dialog[open]')).filter((d) => d.matches(':modal')).pop() ?? document
    const bad: string[] = []
    for (const el of Array.from(modal.querySelectorAll<HTMLElement>('button, a[href], input, textarea, [role="switch"], label.pill'))) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || el.closest('[hidden]') !== null || getComputedStyle(el).visibility === 'hidden') continue
      if ((el.tagName === 'INPUT' && el.closest('label.pill') !== null) || el.getAttribute('aria-disabled') === 'true') continue
      const cs = getComputedStyle(el)
      const g = ground(el)
      const own = parse(cs.backgroundColor)
      const fill = own && own[3]! > 0 ? over(own, g) : g
      let border = Infinity
      for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
        const b = parse(cs.getPropertyValue(`border-${side.toLowerCase()}-color`))
        if (parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) < 0.5 || !b || b[3] === 0) continue
        const seen = over(b, g)
        border = Math.min(border, ratio(seen, g), ratio(seen, fill))
      }
      if (border >= 3) continue
      let words = ''
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.parentElement!.closest('.visually-hidden') === null) words += t.textContent
      const color = parse(cs.color)!
      let icon = 0
      for (const svg of Array.from(el.querySelectorAll('svg'))) if (svg.getBoundingClientRect().width > 0) icon = Math.max(icon, ratio(over(parse(getComputedStyle(svg).color)!, fill), fill))
      const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
      const named = !field && ((words.trim() !== '' && ratio(over(color, fill), fill) >= 3) || icon >= 3)
      if (!named) bad.push(`${el.tagName.toLowerCase()}.${el.className} «${el.getAttribute('aria-label') ?? words.trim()}» border ${border.toFixed(2)}`)
    }
    return bad
  })
}

test.describe('review leftovers: the bar, the Tab order, the sky’s edges, the names, the borders', () => {
  test('#93 at rest no line of the conversation sits half under the top fade; the person’s bubble has its own edge; «+» comes before the field in Tab order', async ({ page }, testInfo) => {
    await openChat(page)
    // At rest also means with the page's own faces in: line heights are theirs.
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    for (const text of [USER, 'Друге синтетичне повідомлення.', 'Третє синтетичне повідомлення.']) {
      await exchange(page, text)
      // At rest: the send anchor's smooth scroll is over — the page has not moved for 400 ms (two
      // frames alike are not enough: a smooth scroll can hold a position for a frame or two).
      await expect
        .poll(async () => {
          const before = await page.evaluate(() => scrollY)
          await page.waitForTimeout(400)
          return Math.abs((await page.evaluate(() => scrollY)) - before)
        })
        .toBe(0)
      expect(await halfFaded(page), `after «${text}»`).toEqual([])
    }
    // The top fade is the gap above a sent message (1.75rem), the send anchor stops right under it.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fade-top').trim())).toBe('1.75rem')
    const bubble = lastUser(page).locator('.said__text')
    const look = await bubble.evaluate((node) => {
      const s = getComputedStyle(node)
      return { width: s.borderTopWidth, style: s.borderTopStyle, color: s.borderTopColor, fill: s.backgroundColor, page: getComputedStyle(document.documentElement).backgroundColor }
    })
    expect(look.width).toBe('1px')
    expect(look.style).toBe('solid')
    expect(look.color).not.toMatch(/rgba\(\d+, \d+, \d+, 0\)/)
    expect(look.fill).not.toBe(look.page)
    // «Інструменти» stands left of the field: before it in Tab order, its menu right after it.
    const order = await page.evaluate(() => {
      const tools = document.querySelector('[data-el="composer-tools"]')!
      const field = document.querySelector('#composer-input')!
      const menu = document.querySelector('#composer-tools')!
      return {
        toolsFirst: Boolean(tools.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING),
        menuNext: tools.nextElementSibling === menu,
        toolsLeft: tools.getBoundingClientRect().left < field.getBoundingClientRect().left + 20,
      }
    })
    expect(order).toEqual({ toolsFirst: true, menuNext: true, toolsLeft: true })
    if (isDesktop(testInfo)) {
      await composer(page).focus()
      await page.keyboard.press('Shift+Tab')
      await expect(page.locator('[data-el="composer-tools"]')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(composer(page)).toBeFocused()
    }
  })

  test('#93b without motion the first message lands where it should too: the anchor scrolls once the render is through, and the transcript’s size never transitions', async ({ page }) => {
    // prefers-reduced-motion: base.css gives every property a 0.01 ms transition and the scroll is
    // instant — the anchor used to land short on the first message, the opening line under the fade.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openChat(page)
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    await exchange(page, USER)
    expect(await halfFaded(page)).toEqual([])
    const placed = await lastUser(page).evaluate((li) => {
      const root = getComputedStyle(document.documentElement)
      return Math.round(li.getBoundingClientRect().top - parseFloat(root.scrollPaddingTop) - parseFloat(getComputedStyle(li).scrollMarginTop))
    })
    expect(placed).toBe(0)
  })

  test('#94 the session row says «AI, не людина» only where its small light is the light (the phone); the desktop has the big light’s label and the line under the field', async ({ page }, testInfo) => {
    await openChat(page)
    await exchange(page, USER)
    const row = page.locator('[data-el="session"] .session__ai')
    await expect(page.locator('.composer__ai')).toBeVisible()
    await expect(page.locator('.composer__ai')).toHaveText('AI, не людина · може помилятися · не терапія')
    await expect(aiMessages(page).nth(1).locator('.said__who')).toHaveText('AI')
    if (isDesktop(testInfo)) {
      await expect(row).toBeHidden()
      await expect(page.locator('.presence__ai')).toBeVisible()
      await expect(page.locator('.presence__ai')).toHaveText('AI · не людина')
      await expect(page.locator('[data-el="session"] .session__label')).toHaveText('Вільна розмова', { useInnerText: true })
    } else {
      await expect(row).toBeVisible()
      await expect(page.locator('.session .orb--mini')).toBeVisible()
    }
  })

  test('#95 the browser’s bar has the theme’s colour before any module runs (public/theme-init.js): the system’s, or the choice', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough')
    // The page's module never comes: what the bar shows is theme-init.js's doing alone.
    await page.route('**/assets/chat-*.js', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }))
    const themeColor = page.locator('meta[name="theme-color"]')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/chat/')
    await expect(themeColor).toHaveCount(1)
    await expect(themeColor).toHaveAttribute('content', PAPER)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.reload()
    await expect(themeColor).toHaveAttribute('content', LAMP)
    // A stored choice wins over the system.
    await page.evaluate(() => localStorage.setItem('liora:theme', 'light'))
    await page.reload()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(themeColor).toHaveAttribute('content', PAPER)
    await page.evaluate(() => localStorage.removeItem('liora:theme'))
  })

  test('#96 the sky presets are named for the theme (the values stay night / dusk / dawn); the sign-in note reads in the body face; a dialog’s scrim covers a scrollbar’s gutter too', async ({ page, api }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one layout is enough')
    api.on('GET /me', fail(401, 'unauthenticated'))
    await openChat(page, '/chat/', 'signed-out')
    const note = await page.locator('section[data-screen="signed-out"] .note').evaluate((n) => {
      const s = getComputedStyle(n)
      return { family: s.fontFamily, transform: s.textTransform }
    })
    expect(note.family).toMatch(/^"?Onest/)
    expect(note.transform).toBe('none')

    api.on('GET /me', { json: ME })
    await openChat(page)
    const names = async (): Promise<string[]> =>
      accountSheet(page).locator('[data-sky-pick] label.pill').evaluateAll((labels) => labels.map((l) => (l as HTMLElement).innerText.trim()))
    await accountToggle(page).click()
    await expect(accountSheet(page)).toBeVisible()
    expect(await names()).toEqual(['Ніч', 'Сутінки', 'Світанок'])
    await expect(accountSheet(page).getByRole('radio', { name: 'Сутінки' })).toHaveValue('dusk')
    // The gutter of a classic scrollbar under the scrim: the root takes the scrim over the page —
    // only where there is such a gutter (html[data-gutter]); overlay scrollbars keep the page's
    // colour, and so does a phone's bar under a full-screen sheet.
    const rootBg = (): Promise<string> => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
    const gutter = await page.evaluate(() => document.documentElement.hasAttribute('data-gutter'))
    // «Акаунт» is flush with the gutter: beside it the gutter is the sheet's colour (it was a strip of
    // the scrim's down the window's edge). A centred dialog leaves the scrim beside it.
    await expect.poll(rootBg).toBe(LAMP)
    await page.keyboard.press('Escape')
    await expect(accountSheet(page)).toBeHidden()
    await expect.poll(rootBg).toBe(LAMP)
    await page.locator('.help-link').click()
    await expect(page.locator('#help-dialog')).toBeVisible()
    await expect.poll(rootBg).toBe(gutter ? 'rgb(11, 16, 17)' : LAMP)
    await page.keyboard.press('Escape')
    await expect(page.locator('#help-dialog')).toBeHidden()
    await expect.poll(rootBg).toBe(LAMP)

    await page.emulateMedia({ colorScheme: 'light' })
    await accountToggle(page).click()
    await expect(accountSheet(page)).toBeVisible()
    expect(await names()).toEqual(['День', 'Вечір', 'Ранок'])
    await expect(accountSheet(page).getByRole('radio', { name: 'Вечір' })).toHaveValue('dusk')
    await expect(accountSheet(page).getByRole('radio', { name: 'Ранок' })).toHaveValue('dawn')
    await expect(accountSheet(page).getByRole('radio', { name: 'Сутінки' })).toHaveCount(0)
    await expect.poll(rootBg).toBe(PAPER)
    // A confirm stacked over the sheet scrims both: the gutter takes the scrim's colour again.
    await accountSheet(page).getByRole('button', { name: 'Видалити акаунт…' }).click()
    await expect(confirmDialog(page)).toBeVisible()
    await expect.poll(rootBg).toBe(gutter ? 'rgb(209, 202, 194)' : PAPER)
    await confirmDialog(page).getByRole('button', { name: 'Скасувати', exact: true }).click()
    await expect(confirmDialog(page)).toBeHidden()
    await expect.poll(rootBg).toBe(PAPER)
    // The scrollbar's thumb is its only shape: the fields' border colour, ≥ 3:1.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor)).toMatch(/^rgb\(120, 130, 127\) /)
  })

  test('#97 WCAG 1.4.11: no control relies on a border under 3:1 — in both themes, on the conversation, the theses, the sheets and the tools', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'computed colours: one engine is enough')
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await openChat(page)
      expect(await borderOnlyControls(page), `${scheme}: a new conversation`).toEqual([])
      await exchange(page, USER)
      await aiMessages(page).nth(1).hover()
      expect(await borderOnlyControls(page), `${scheme}: a conversation`).toEqual([])
      await accountToggle(page).click()
      await expect(accountSheet(page)).toBeVisible()
      expect(await borderOnlyControls(page), `${scheme}: the account sheet`).toEqual([])
      await page.keyboard.press('Escape')
      await keepOf(aiMessages(page).nth(1)).click()
      await toReview(page)
      expect(await borderOnlyControls(page), `${scheme}: the theses with a candidate`).toEqual([])
      await page.getByRole('button', { name: 'Повернутися до розмови' }).click()
      await onScreen(page, 'chat')
      await page.locator('.help-link').click()
      await expect(page.locator('#help-dialog')).toBeVisible()
      expect(await borderOnlyControls(page), `${scheme}: «Якщо важко»`).toEqual([])
      await page.keyboard.press('Escape')
    }
  })
})

// ── What the review of phase C3 found: the bar after a dialog, the line over the end, double presses ──

const themeColor = (page: Page): Promise<string> => page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content)
const pageEnd = (page: Page): Promise<{ end: number; field: number; y: number; pill: boolean }> =>
  page.evaluate(() => {
    const last = document.querySelector('[data-el="talk"]')!.lastElementChild!.querySelector('.said__body')!.getBoundingClientRect()
    return {
      end: last.bottom,
      field: document.querySelector('[data-el="composer"]')!.getBoundingClientRect().top,
      y: scrollY,
      pill: !document.querySelector<HTMLElement>('[data-el="jump"]')!.hidden,
    }
  })
/** A reply longer than a small phone's screen: at the end of the page it rests right above the field. */
const LONG_REPLY = ['Можна почати з одного речення. ', 'Яке слово тут найважливіше для вас? '.repeat(14), 'Яким воно було б?']

test.describe('what the review of phase C3 found', () => {
  test('#99 the browser’s bar comes back to the page’s colour when a dialog closes: a theme picked in «Акаунт», the shelter over «Якщо важко»', async ({ page }) => {
    await openChat(page)
    expect(await themeColor(page)).toBe(LAMP)
    await accountToggle(page).click()
    await expect(accountSheet(page)).toBeVisible()
    await accountSheet(page).getByRole('radio', { name: 'Світла' }).check()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await page.keyboard.press('Escape')
    await expect(accountSheet(page)).toBeHidden()
    // It used to keep the scrim's grey (rgb(209, 202, 194)) read under the open sheet.
    await expect.poll(() => themeColor(page)).toBe(PAPER)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(PAPER)
    // The shelter over «Якщо важко»: dark while it is open; the help under it, then nothing.
    await page.locator('.help-link').click()
    await expect(page.locator('#help-dialog')).toBeVisible()
    await page.locator('#help-dialog').getByRole('button', { name: 'В укритті' }).click()
    await expect(shelterDialog(page)).toBeVisible()
    await expect.poll(() => themeColor(page)).toBe(LAMP)
    await page.keyboard.press('Escape')
    await expect(shelterDialog(page)).toBeHidden()
    await expect(page.locator('#help-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#help-dialog')).toBeHidden()
    await expect.poll(() => themeColor(page)).toBe(PAPER)
    await page.evaluate(() => localStorage.removeItem('liora:theme'))
  })

  test('#100 the reminder to pause does not cover the end it lands on (320 × 640): the page moves up by the line, the focus stays', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply(LONG_REPLY) })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.clock.install()
    await openChat(page)
    await exchange(page, USER)
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
    // The «↓» pill looks again a frame after the scroll.
    await expect.poll(async () => (await pageEnd(page)).pill).toBe(false)
    const before = await pageEnd(page)
    expect(before.end).toBeLessThanOrEqual(before.field + 4)
    const focused = await page.evaluate(() => document.activeElement?.id ?? '')
    await page.clock.fastForward('40:00')
    await expect(pauseText(page)).not.toHaveText('')
    const after = await pageEnd(page)
    // The field grew by the line; the end is still above it, the gap it had kept, no «↓» pill.
    expect(after.field).toBeLessThan(before.field - 20)
    expect(after.end).toBeLessThanOrEqual(after.field + 4)
    expect(Math.abs(after.field - after.end - (before.field - before.end))).toBeLessThanOrEqual(1)
    expect(after.pill).toBe(false)
    expect(await page.evaluate(() => document.activeElement?.id ?? '')).toBe(focused)
  })

  test('#100b scrolled up, the reminder to pause moves nothing', async ({ page, api }) => {
    api.on('POST /chat/turn', { sse: reply(LONG_REPLY) })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.clock.install()
    await openChat(page)
    await exchange(page, USER)
    await exchange(page, 'Друге синтетичне повідомлення.')
    await page.evaluate(() => window.scrollTo({ top: 120, behavior: 'instant' }))
    const before = await pageEnd(page)
    await page.clock.fastForward('40:00')
    await expect(pauseText(page)).not.toHaveText('')
    expect((await pageEnd(page)).y).toBe(before.y)
  })

  test('#101 the second press of a double click is no press of what took the first one’s place: «Зібрати тези», «Прибрати», «Додати до тез»', async ({ page, api }) => {
    await page.clock.install()
    await openChat(page)
    for (const text of [USER, 'Друге синтетичне повідомлення.', 'Третє синтетичне повідомлення.']) await exchange(page, text)
    for (let i = 1; i <= 3; i++) await keepOf(aiMessages(page).nth(i)).click()
    await page.clock.fastForward('40:00')
    await expect(pauseActions(page)).toBeVisible()
    // On a phone the confirm's buttons stand where «Зібрати тези» was: the second press used to
    // switch it to «Завершити без тез?».
    await page.getByRole('button', { name: 'Зібрати тези' }).dblclick()
    await expect(confirmDialog(page)).toBeVisible()
    await expect(confirmDialog(page).getByRole('heading', { name: 'Завершити розмову?' })).toBeVisible()
    await confirmDialog(page).getByRole('button', { name: 'Підсумувати' }).click()
    await onScreen(page, 'review')
    const rows = candidates(page).locator('.candidate')
    await expect(rows).toHaveCount(3)
    // «Прибрати»: the next row's «Прибрати» slides under the pointer — one mark goes, not two.
    await rows.first().getByRole('button', { name: /^Прибрати/ }).dblclick()
    await expect(rows).toHaveCount(2)
    await expect(page.locator('[data-el="candidates-list"] [data-act="candidate-drop"]').first()).toBeFocused()
    // «Додати до тез»: one thesis comes in and keeps the focus.
    const theses = page.locator('.thesis:not(.thesis--removed)')
    const count = await theses.count()
    await rows.first().getByRole('button', { name: /^Додати до тез/ }).dblclick()
    await expect(theses).toHaveCount(count + 1)
    await expect(rows).toHaveCount(1)
    await expect(page.locator('textarea[id^="thesis-m"]')).toBeFocused()
    // Not a press of anything else either: nothing was sent.
    expect(api.count('POST /summaries')).toBe(0)
  })
})

// ── The light (needs WebGL: local only) ──────────────────────────────────────────────────────

/** A computed 'rgba(…)' laid over an opaque 'rgb(…)', as 'rgb(…)'. */
function over(top: string, ground: string): string {
  const [r, g, b, a = 1] = top.match(/[\d.]+/g)!.map(Number) as [number, number, number, number?]
  const [R, G, B] = ground.match(/[\d.]+/g)!.map(Number) as [number, number, number]
  const mix = (x: number, y: number): number => Math.round(x * a + y * (1 - a))
  return `rgb(${mix(r, R)}, ${mix(g, G)}, ${mix(b, B)})`
}

/** WCAG contrast of two computed colours ('rgb(…)' / 'rgba(…)', opaque). */
function contrast(a: string, b: string): number {
  const lum = (color: string): number => {
    const [r, g, b2] = color.match(/[\d.]+/g)!.slice(0, 3).map((v) => {
      const c = Number(v) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

test.describe('what the final review found', () => {
  test('#110 «Надіслати», ready: its focus ring stands out from its fill, hovered too, in both themes', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough for computed styles')
    await openChat(page)
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await composer(page).fill('Синтетичне повідомлення')
      await composer(page).focus()
      await page.keyboard.press('Tab')
      const send = sendButton(page)
      await expect(send).toBeFocused()
      await expect(send).toHaveAttribute('data-mode', 'ready')
      const ring = () =>
        send.evaluate((node) => {
          const style = getComputedStyle(node)
          return { visible: node.matches(':focus-visible'), style: style.outlineStyle, ring: style.outlineColor, fill: style.backgroundColor }
        })
      for (const hovered of [false, true]) {
        if (hovered) await send.hover()
        await settled(page)
        const r = await ring()
        expect(r.visible).toBe(true)
        expect(r.style).toBe('solid')
        // It used to be the accent on the accent: 1.00:1 (1.33 / 1.23 hovered).
        expect(contrast(r.ring, r.fill), `${scheme}${hovered ? ', hovered' : ''}: ${r.ring} on ${r.fill}`).toBeGreaterThanOrEqual(3)
      }
      await page.mouse.move(0, 0)
    }
  })

  test('#111 forced colours: the message field in focus has a Highlight ring, not just the caret', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough for computed styles')
    await openChat(page)
    await composer(page).focus()
    const ring = () =>
      composer(page).evaluate((node) => {
        const style = getComputedStyle(node)
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }
      })
    // Its own focus is a doubled border and a shadow: no ring.
    expect((await ring()).style).toBe('none')
    await page.emulateMedia({ forcedColors: 'active' })
    const forced = await ring()
    expect(forced.style).toBe('solid')
    expect(forced.width).toBeGreaterThanOrEqual(2)
    await page.emulateMedia({ forcedColors: 'none' })
  })

  test('#114 every screen but a running conversation stands on a solid band under the header (nothing of the text shows through), then a 12 px tail', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'computed styles: one engine is enough')
    const band = () =>
      page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('.chat-header')!, '::before')
        return { bottom: style.bottom, image: style.backgroundImage, root: getComputedStyle(document.documentElement).backgroundColor }
      })
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await openChat(page)
      // A new conversation: the page's own colour, opaque, as far as the header goes.
      let b = await band()
      expect(b.bottom).toBe('-12px')
      expect(b.image.startsWith(`linear-gradient(${b.root} calc(100% - 12px),`), b.image).toBe(true)
      // A running conversation: the band ends flat at the header's edge; the session row carries it on.
      await exchange(page)
      b = await band()
      expect(b.bottom).toBe('0px')
      // The theses: the solid band again.
      await toReview(page)
      b = await band()
      expect(b.image.startsWith(`linear-gradient(${b.root} calc(100% - 12px),`), b.image).toBe(true)
      // What the page scrolls to stops below the tail too.
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--header-tail').trim())).toBe('.75rem')
    }
  })

  test('#116 the search fields’ «×» is the page’s ink over a file of this origin, not the system’s blue', async ({ page, request }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough')
    await openChat(page)
    const rule = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        for (const r of Array.from(sheet.cssRules)) {
          if (r instanceof CSSStyleRule && r.selectorText.includes('::-webkit-search-cancel-button') && !r.selectorText.includes(':hover')) {
            return { selector: r.selectorText, appearance: r.style.getPropertyValue('appearance'), color: r.style.getPropertyValue('background-color'), mask: r.style.getPropertyValue('mask-image') }
          }
        }
      }
      return null
    })
    expect(rule).toMatchObject({ appearance: 'none', color: 'var(--color-text-soft)' })
    expect(rule!.selector).toContain("[type='search']".replace(/'/g, '"'))
    const url = /url\("?([^")]+)"?\)/.exec(rule!.mask)?.[1]
    expect(url, rule!.mask).toMatch(/\/assets\/clear-[\w-]+\.svg$/)
    const svg = await request.get(new URL(url!, page.url()).toString())
    expect(svg.status()).toBe(200)
    expect(svg.headers()['content-type']).toContain('image/svg+xml')
  })

  test('#116b in forced colours the search fields’ «×» keeps the system’s text colour (the mask over Canvas was gone)', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough')
    await page.emulateMedia({ forcedColors: 'active' })
    await openChat(page)
    // A pseudo-element of a search field has no computed style to read: the rules that apply to it
    // under forced colours, hovered or not, are read from the sheet.
    const rules = await page.evaluate(() => {
      const found: { selector: string; adjust: string; color: string }[] = []
      const walk = (list: CSSRuleList, forced: boolean): void => {
        for (const r of Array.from(list)) {
          if (r instanceof CSSMediaRule) walk(r.cssRules, forced || (r.conditionText.includes('forced-colors') && matchMedia(r.conditionText).matches))
          else if (r instanceof CSSStyleRule && forced && r.selectorText.includes('::-webkit-search-cancel-button')) {
            found.push({ selector: r.selectorText, adjust: r.style.getPropertyValue('forced-color-adjust'), color: r.style.getPropertyValue('background-color') })
          }
        }
      }
      for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, false)
      return found
    })
    expect(rules.length, 'a forced-colours rule for the «×»').toBeGreaterThan(0)
    const selectors = rules.flatMap((r) => r.selector.split(',').map((s) => s.trim()))
    expect(selectors.some((s) => s.endsWith('::-webkit-search-cancel-button'))).toBe(true)
    expect(selectors.some((s) => s.endsWith('::-webkit-search-cancel-button:hover'))).toBe(true)
    for (const r of rules) expect(r).toMatchObject({ adjust: 'none', color: expect.stringMatching(/^canvastext$/i) })
  })

  test('#117 «Якщо важко» on a wide screen stands under the header and scrolls inside itself: the pill that opened it stays in view', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'the centred dialog of the wide layout')
    await openChat(page)
    await page.locator('.help-link').click()
    const dialog = page.locator('#help-dialog')
    await expect(dialog).toBeVisible()
    await settled(page)
    const header = (await page.locator('.chat-header').boundingBox())!
    const box = (await dialog.boundingBox())!
    expect(box.y, 'under the header').toBeGreaterThanOrEqual(header.y + header.height)
    expect(box.y + box.height).toBeLessThanOrEqual(900)
    await expect(page.locator('.help-link')).toBeInViewport()
    expect(await dialog.evaluate((node) => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto')).toBe(true)
  })

  test('#118 320 × 640: a new conversation’s field is one line for every scenario, ⓘ beside the disclosure, a smaller light; «Вигляд» is one row', async ({ page, api }, testInfo) => {
    // A phone (touch, overlay scrollbars), as a 320 px screen is; the size is set here.
    test.skip(isDesktop(testInfo), 'a phone: the mobile project')
    const more = ['worry', 'hard_talk', 'gratitude', 'evening'].map((id) => ({ id, title: id, description: '', opening_message: 'Синтетичне перше питання.', needs_summaries: false }))
    api.on('GET /scenarios', { json: [...SCENARIOS, ...more] })
    await page.setViewportSize({ width: 320, height: 640 })
    await openChat(page)
    const oneLine = async (): Promise<number> => (await composer(page).boundingBox())!.height
    for (const id of ['free', 'situation', 'day', 'worry', 'hard_talk', 'gratitude', 'evening']) {
      await page.locator(`.scenarios__list input[value="${id}"]`).check()
      await expect(composer(page)).toHaveAttribute('placeholder', placeholder(id, true))
      expect(await oneLine(), `${id}: «${placeholder(id, true)}»`).toBeLessThanOrEqual(53)
    }
    const tip = (await page.locator('[data-el="composer-tip-button"]').boundingBox())!
    const line = (await page.locator('.composer__ai').boundingBox())!
    expect(tip.y, 'ⓘ on the line’s row, not under it').toBeLessThan(line.y + line.height)
    expect((await page.locator('.presence__slot').boundingBox())!.width).toBe(96)
    await accountToggle(page).click()
    await expect(accountSheet(page)).toBeVisible()
    const tops = await accountSheet(page)
      .locator('[data-theme-radios] label.pill')
      .evaluateAll((pills) => pills.map((p) => Math.round(p.getBoundingClientRect().top)))
    expect(new Set(tops).size, `rows: ${tops.join(', ')}`).toBe(1)
  })

  test('#119 the dark theme’s warm tint is warm: the chosen scenario, a chosen mood cell and the breathing circle are amber, not olive grey', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'computed colours: one engine is enough')
    await openChat(page)
    const pill = await page.locator('.pill--on').first().evaluate((node) => {
      const style = getComputedStyle(node)
      return { fill: style.backgroundColor, image: style.backgroundImage }
    })
    const tint = /rgba?\([^)]*\)/.exec(pill.image)![0]
    const [r, g, b] = over(tint, pill.fill).match(/\d+/g)!.map(Number) as [number, number, number]
    // It was rgb(53, 55, 49): green above red, an olive grey.
    expect(r - g, `${r}, ${g}, ${b}`).toBeGreaterThanOrEqual(5)
    expect(g - b, `${r}, ${g}, ${b}`).toBeGreaterThanOrEqual(5)
    // The light theme keeps its peach.
    await page.emulateMedia({ colorScheme: 'light' })
    await settled(page)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent-tint').trim())).toMatch(/181,? 83,? 42|b5532a/i)
  })
})

test.describe('what the accessibility review found', () => {
  /** The live region's non-empty writes since `from`. */
  const saidSince = async (page: Page, from: number): Promise<string[]> => (await announced(page)).slice(from).filter((text) => text !== '')
  const touch = (page: Page): Promise<boolean> => page.evaluate(() => !window.matchMedia('(pointer: fine)').matches)

  test('#122 a starter and «Додати до розмови» on a touch screen say where the words went; the same words twice go in once', async ({ page }) => {
    await openChat(page)
    const coarse = await touch(page)
    const chip = page.locator('[data-el="starters"] button.starter').first()
    const line = starters('free')[0]!
    const from = (await announced(page)).length
    await chip.click()
    await expect(composer(page)).toHaveValue(line)
    if (coarse) {
      // The focus stays on the chip (no keyboard over the page): the live region says it instead.
      await expect(composer(page)).not.toBeFocused()
      await expect.poll(() => saidSince(page, from)).toEqual([SAY_INSERTED])
    } else {
      // The focus follows the words; nothing to say.
      await expect(composer(page)).toBeFocused()
      expect(await saidSince(page, from)).toEqual([])
    }
    // Pressed again: the words end the field already, they are not put twice.
    await chip.click()
    await expect(composer(page)).toHaveValue(line)
    if (coarse) await expect.poll(() => saidSince(page, from)).toEqual([SAY_INSERTED, SAY_ALREADY])

    // «Додати до розмови»: the dialog closes, the focus goes back to «Інструменти», the sentence goes
    // into the field after what is there.
    await openTool(page, 'Як ви зараз?')
    await moodDialog(page).getByRole('radio', { name: 'Мало сил, приємно' }).click()
    await moodDialog(page).getByRole('radio', { name: 'спокій', exact: true }).click()
    const before = (await announced(page)).length
    await moodDialog(page).getByRole('button', { name: 'Додати до розмови' }).click()
    await expect(moodDialog(page)).toBeHidden()
    await expect(composer(page)).toHaveValue(`${line} Зараз у мене — спокій.`)
    if (coarse) {
      await expect(toolsButton(page)).toBeFocused()
      await expect.poll(() => saidSince(page, before)).toEqual([SAY_INSERTED])
    } else {
      await expect(composer(page)).toBeFocused()
      expect(await saidSince(page, before)).toEqual([])
    }
  })

  test('#123 another week of the diary is said: its range and its count; not on the way in, not when an edit asks for the same week again', async ({ page, api }) => {
    api.on('GET /summaries', (call) => ({ json: diary(found(call)) }))
    api.on('GET /tags', { json: THEMES })
    api.on('GET /reviews/weekly', (call) => {
      const start = call.query.get('week_start') ?? THIS_WEEK
      return { json: start === LAST_WEEK ? weekly(LAST_WEEK, 1, ['сон']) : weekly(THIS_WEEK, 2, ['робота', 'сон']) }
    })
    const target = ENTRIES[0]!
    api.on(`DELETE /summaries/${target.id}`, { status: 204 })
    await openChat(page)
    const from = (await announced(page)).length
    await openDiary(page)
    const count = page.locator('[data-el="week-count"]')
    await expect(count).toHaveText('2 збережені записи')
    expect(await saidSince(page, from)).toEqual([])

    const back = page.getByRole('button', { name: 'Попередній тиждень' })
    await back.click()
    await expect(count).toHaveText('1 збережений запис')
    await expect.poll(() => saidSince(page, from)).toEqual(['12–18 жовтня. 1 збережений запис'])
    // The person's themes stay on the page, not in the region; the focus stays on the button.
    await expect(page.locator('[data-el="week-themes"]')).toHaveText('Теми: сон')
    await expect(back).toBeFocused()
    await page.getByRole('button', { name: 'Наступний тиждень' }).click()
    await expect(count).toHaveText('2 збережені записи')
    await expect.poll(() => saidSince(page, from)).toEqual(['12–18 жовтня. 1 збережений запис', 'Цей тиждень. 2 збережені записи'])

    // A delete asks for the week shown once more: the same week, nothing said about it.
    const weeks = api.count('GET /reviews/weekly')
    await entryTitled(page, target.title).getByRole('button', { name: 'Видалити' }).click()
    await confirmDialog(page).getByRole('button', { name: 'Видалити', exact: true }).click()
    await expect(journalStatus(page)).toHaveText(JOURNAL_DELETED)
    await expect.poll(() => api.count('GET /reviews/weekly')).toBe(weeks + 1)
    await expect(count).toHaveText('2 збережені записи')
    await page.waitForTimeout(300)
    expect((await saidSince(page, from)).filter((text) => text.includes('тиждень') || text.includes('жовтня'))).toHaveLength(2)
  })

  test('#123b a step that failed, then a step back: the week shown again is said, though it is the one said before', async ({ page, api }) => {
    let lastWeekAsked = 0
    api.on('GET /summaries', (call) => ({ json: diary(found(call)) }))
    api.on('GET /tags', { json: THEMES })
    api.on('GET /reviews/weekly', (call) => {
      const start = call.query.get('week_start') ?? THIS_WEEK
      if (start === LAST_WEEK && lastWeekAsked++ === 0) return fail(500, 'internal')
      return { json: start === LAST_WEEK ? weekly(LAST_WEEK, 1, ['сон']) : weekly(THIS_WEEK, 2, ['робота', 'сон']) }
    })
    await openChat(page)
    const from = (await announced(page)).length
    await openDiary(page)
    const count = page.locator('[data-el="week-count"]')
    await expect(count).toHaveText('2 збережені записи')
    await page.getByRole('button', { name: 'Попередній тиждень' }).click()
    await expect(page.locator('[data-el="week-status"]')).toHaveText(WEEK_FAILED)
    await expect(page.locator('[data-el="week-title"]')).toHaveText('12–18 жовтня')
    await page.getByRole('button', { name: 'Наступний тиждень' }).click()
    await expect(count).toHaveText('2 збережені записи')
    await expect.poll(() => saidSince(page, from)).toEqual(['Цей тиждень. 2 збережені записи'])
  })

  test('#124 «Як ви зараз?»: the cells and the words are radio groups — one Tab stop each, the arrows move and choose, a second press keeps the choice', async ({ page }) => {
    await openChat(page)
    await openTool(page, 'Як ви зараз?')
    const mood = moodDialog(page)
    const grid = mood.getByRole('radiogroup', { name: 'Як ви зараз?', exact: true })
    const cells = grid.getByRole('radio')
    await expect(cells).toHaveText(['Багато сил, неприємно', 'Багато сил, приємно', 'Мало сил, неприємно', 'Мало сил, приємно'])
    await expect(grid).toHaveAccessibleDescription('Оберіть, що ближче.')
    // No toggle buttons left: a toggle promised that a second press lets go.
    await expect(mood.locator('[aria-pressed]')).toHaveCount(0)
    const stops = (group: Locator): Promise<(string | null)[]> => group.getByRole('radio').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('tabindex')))
    await expect(cells.first()).toBeFocused()
    expect(await stops(grid)).toEqual(['0', '-1', '-1', '-1'])

    // → takes the next one; ← round the start takes the last.
    await page.keyboard.press('ArrowRight')
    await expect(cells.nth(1)).toBeFocused()
    await expect(cells.nth(1)).toHaveAttribute('aria-checked', 'true')
    await expect(cells.nth(0)).toHaveAttribute('aria-checked', 'false')
    await expect(mood.getByRole('radiogroup', { name: 'Багато сил, приємно', exact: true }).getByRole('radio')).toHaveText(['натхнення', 'радість', 'азарт', 'піднесення', 'цікавість', 'гордість'])
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(cells.nth(3)).toBeFocused()
    await expect(cells.nth(3)).toHaveAttribute('aria-checked', 'true')
    expect(await stops(grid)).toEqual(['-1', '-1', '-1', '0'])
    // A second press (a click, Space) keeps the choice.
    await cells.nth(3).click()
    await page.keyboard.press('Space')
    await expect(cells.nth(3)).toHaveAttribute('aria-checked', 'true')

    // Tab: from the grid to the words, one stop; ↓ chooses the next word.
    const words = mood.getByRole('radiogroup', { name: 'Мало сил, приємно', exact: true })
    await page.keyboard.press('Tab')
    await expect(words.getByRole('radio').first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(words.getByRole('radio', { name: 'вдячність', exact: true })).toBeFocused()
    await expect(words.getByRole('radio', { name: 'вдячність', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Space')
    await expect(words.getByRole('radio', { name: 'вдячність', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Tab')
    await expect(mood.getByRole('button', { name: 'Готово' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(words.getByRole('radio', { name: 'вдячність', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(cells.nth(3)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(mood).toBeHidden()
    // The page's colour is read with no dialog open (under one the root takes the scrim's).
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(html(page)).toHaveCSS('background-color', scheme === 'dark' ? LAMP : PAPER)
      await openTool(page, 'Як ви зараз?')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Tab')
      await page.keyboard.press('ArrowRight')
      await expect(mood.locator('.mood__word[aria-checked="true"]')).toHaveText('радість')
      await axe(page, `${scheme}: the check-in as radio groups, a word chosen`)
      await page.keyboard.press('Escape')
      await expect(mood).toBeHidden()
    }
  })

  test('#125 the «Інструменти» menu is a group named «Інструменти», not a nameless box', async ({ page }) => {
    await openChat(page)
    await toolsButton(page).click()
    const group = page.getByRole('group', { name: 'Інструменти', exact: true })
    await expect(group).toBeVisible()
    await expect(group.getByRole('button')).toHaveText(['Подихати хвилину', 'Заземлення 5-4-3-2-1', 'Як ви зараз?', 'В укритті'])
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(html(page)).toHaveCSS('background-color', scheme === 'dark' ? LAMP : PAPER)
      await axe(page, `${scheme}: the tools menu, open`)
    }
  })

  test('#126 the labels under «Пауза», «Звук» and «Вигляд»: Esc hides one without moving the focus or the pointer; the pointer can move onto it', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'a pointer that hovers')
    await openChat(page)
    const label = (button: Locator): Promise<number> => button.evaluate((node) => Number(getComputedStyle(node, '::after').opacity))
    const hovered = (button: Locator): Promise<boolean> => button.evaluate((node) => node.matches(':hover'))
    const toggle = themeToggle(page)
    // From the keyboard: Tab onto «Вигляд» shows «Вигляд»; Esc hides it and nothing else moves.
    await toggle.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(toggle).toBeFocused()
    await expect.poll(() => label(toggle)).toBe(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => label(toggle)).toBe(0)
    await expect(toggle).toBeFocused()
    await expect(themeMenu(page)).toBeHidden()
    // The focus leaves and comes back: the label is there again.
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect.poll(() => label(toggle)).toBe(1)
    // The menu closed with Esc gives the focus back without the label popping up under it.
    await page.keyboard.press('Enter')
    await expect(themeMenu(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(themeMenu(page)).toBeHidden()
    await expect(toggle).toBeFocused()
    await expect.poll(() => label(toggle)).toBe(0)
    await composer(page).focus()

    // With the pointer: over «Пауза анімації», then straight down across the gap onto the label.
    const motion = page.locator('[data-motion-toggle]')
    await motion.hover()
    await expect.poll(() => label(motion)).toBe(1)
    const box = (await motion.boundingBox())!
    const x = box.x + box.width / 2
    const gap = box.y + box.height + 4
    const onLabel = box.y + box.height + 0.6 * 16 + 8
    await page.mouse.move(x, gap, { steps: 4 })
    expect(await hovered(motion), 'in the gap').toBe(true)
    await page.mouse.move(x, onLabel, { steps: 6 })
    expect(await hovered(motion), 'on the label').toBe(true)
    await page.waitForTimeout(400)
    expect(await label(motion)).toBe(1)
    // Esc with the pointer still there: gone, the pointer has not moved.
    await page.keyboard.press('Escape')
    await expect.poll(() => label(motion)).toBe(0)
    // Hidden, it takes no pointer: with the pointer still on it, what lies under it is what a click
    // there gets (the label takes the pointer only while it is shown: :not([data-tip='off'])).
    const takes = ([px, py]: number[]): boolean => document.elementFromPoint(px!, py!)?.closest('[data-motion-toggle]') != null
    expect(await page.evaluate(takes, [x, onLabel]), 'the hidden label under the pointer takes it').toBe(false)
    // The pointer moves away: the label stays hidden and takes nothing there either.
    await page.mouse.move(x, box.y + box.height + 120, { steps: 4 })
    await expect.poll(() => label(motion)).toBe(0)
    expect(await page.evaluate(takes, [x, onLabel]), 'the hidden label with the pointer gone').toBe(false)
    // Back over the button: shown again.
    await motion.hover()
    await expect.poll(() => label(motion)).toBe(1)
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(html(page)).toHaveCSS('background-color', scheme === 'dark' ? LAMP : PAPER)
      await expect.poll(() => label(motion)).toBe(1)
      await axe(page, `${scheme}: the header with a label shown`)
    }
  })

  test('#127 a confirm’s sentences are its description: «Видалити запис?» says «Повернути його не вийде.»; a line its condition hides is not read', async ({ page, api }) => {
    api.on('GET /summaries', (call) => ({ json: diary(found(call)) }))
    api.on('GET /tags', { json: THEMES })
    api.on('GET /reviews/weekly', { json: weekly(THIS_WEEK, 2, ['робота', 'сон']) })
    await openChat(page)
    await exchange(page, USER)
    const confirm = confirmDialog(page)
    // «Завершити розмову?» after one message: the short line is read, «не зберігати» (off) is not.
    await page.locator('[data-el="session-end"]').click()
    await expect(confirm.getByRole('button', { name: 'Підсумувати' })).toBeFocused()
    await expect(confirm).toHaveAccessibleDescription(/^AI запропонує 3–5 коротких тез\..* Розмова ще коротка, тож тези можуть вийти загальними\. Для тез текст розмови ще раз передається/)
    await expect(confirm).not.toHaveAccessibleDescription(/не зберігати/)
    // Switched in place: the new sentence is the description.
    await confirm.getByRole('button', { name: 'Завершити без тез' }).click()
    await expect(confirm).toHaveAccessibleDescription(/^Текст розмови зникне з цієї сторінки\. Ні тексту, ні тез у Liora не залишиться/)
    await expect(confirm).not.toHaveAccessibleDescription(/Збереження тез не підтвердилося/)
    await page.keyboard.press('Escape')
    await expect(confirm).toBeHidden()

    await openDiary(page)
    // The page's colour is read with no dialog open (under one the root takes the scrim's).
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(html(page)).toHaveCSS('background-color', scheme === 'dark' ? LAMP : PAPER)
      await entryTitled(page, ENTRIES[0]!.title).getByRole('button', { name: 'Видалити' }).click()
      await expect(confirm.getByRole('button', { name: 'Залишити' })).toBeFocused()
      await expect(confirm).toHaveAccessibleName('Видалити запис?')
      await expect(confirm).toHaveAccessibleDescription('Повернути його не вийде.')
      await axe(page, `${scheme}: «Видалити запис?»`)
      await page.keyboard.press('Escape')
      await expect(confirm).toBeHidden()
    }
  })
})

test.describe('what the theme and motion review found', () => {
  test('#128 an engine without light-dark() shows only the dark theme: the WebGL light hears «dark» too, whatever the system says', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough')
    // Safari < 17.5, Chrome < 123: CSS.supports() knows no light-dark(), and the CSS falls back to the
    // dark theme (tokens.css). This Chromium knows it, so the page's scripts are told it does not.
    await page.addInitScript(() => {
      const supports = CSS.supports.bind(CSS) as (...args: string[]) => boolean
      CSS.supports = ((...args: string[]) => (args.some((a) => String(a).includes('light-dark(')) ? false : supports(...args))) as typeof CSS.supports
      const heard: string[] = []
      ;(window as unknown as { __themes: string[] }).__themes = heard
      window.addEventListener('liora:theme', (event) => heard.push(String((event as CustomEvent).detail)))
    })
    const heard = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __themes: string[] }).__themes)
    await openChat(page)
    // Only the dark theme exists here: no «Вигляд».
    await expect(page.locator('[data-theme-toggle]')).toBeHidden()
    // The system turns light, dark, light. What the scene and the orb are told (scene.ts and
    // presence.ts take their palette from this event and from resolvedTheme()) stays the dark the CSS
    // shows — it was the day palette on the night.
    let n = 0
    for (const scheme of ['light', 'dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      n += 1
      await expect.poll(async () => (await heard()).length).toBe(n)
    }
    expect(await heard()).toEqual(['dark', 'dark', 'dark'])
  })

  test('#130 «Увімкнути анімацію» stored and the system reducing motion: the JS stays still as the CSS does — no cross-fade, no glide, no smooth scroll, no word fade', async ({ page }, testInfo) => {
    test.skip(!isDesktop(testInfo), 'one engine is enough')
    // What the page's scripts ask to move: a View Transition, Element.animate() on the transcript,
    // the behaviour of the send anchor's scroll; the stream's words come in through a held turn.
    const stream = await streamTurns(page)
    await page.addInitScript(() => {
      const moves: string[] = []
      ;(window as unknown as { __moves: string[] }).__moves = moves
      const start = document.startViewTransition?.bind(document)
      if (start) {
        document.startViewTransition = ((update?: () => void) => {
          moves.push('view-transition')
          return start(update)
        }) as typeof document.startViewTransition
      }
      const animate = Element.prototype.animate
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
        moves.push(`animate ${this.getAttribute('data-el') ?? this.tagName.toLowerCase()}`)
        return animate.apply(this, args)
      }
      const scrollIntoView = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
        if (typeof arg === 'object' && arg.behavior) moves.push(`scroll ${arg.behavior}`)
        return scrollIntoView.call(this, arg)
      }
    })
    const moves = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __moves: string[] }).__moves)
    const choose = async (name: string): Promise<void> => {
      await themeToggle(page).click()
      await themeItem(page, name).click()
      await expect(themeMenu(page)).toBeHidden()
    }
    /** The first message and its answer: how many of the streamed words fade in (span.w, §5.7). */
    const firstAnswer = async (): Promise<number> => {
      await send(page, 'Синтетичне повідомлення про робочий тиждень.')
      await stream.requests(1)
      await stream.write(meta() + token('Одне ') + token('слово за ') + token('словом.'))
      const live = page.locator('[data-el="talk"] > li[aria-busy="true"]')
      await expect(live).toContainText('словом.')
      const fading = await live.locator('.w').count()
      await stream.write(done())
      await answered(page, 1)
      return fading
    }

    // With motion, all of it moves: the control the rest of the test is measured against.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await openChat(page)
    await expect(html(page)).toHaveAttribute('data-motion', 'on')
    await choose('Світла')
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    expect(await firstAnswer()).toBeGreaterThan(0)
    expect(await moves()).toEqual(expect.arrayContaining(['view-transition', 'animate talk', 'scroll smooth']))

    // The system reduces motion; the visitor presses «Увімкнути анімацію» (liora:motion = on).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(html(page)).toHaveAttribute('data-motion', 'off')
    await page.locator('[data-motion-toggle]').click()
    await expect(html(page)).toHaveAttribute('data-motion', 'on')
    expect(await page.evaluate(() => localStorage.getItem('liora:motion'))).toBe('on')
    await page.reload()
    await onScreen(page, 'chat')
    await expect(html(page)).toHaveAttribute('data-motion', 'on')
    // The CSS stands still under reduce whatever data-motion says (base.css); so does the JS now.
    await choose('Темна')
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(html(page)).toHaveCSS('background-color', LAMP)
    // The words come as text, every 300 ms (§5.7), not as spans that fade.
    expect(await firstAnswer()).toBe(0)
    const still = await moves()
    expect(still.filter((m) => m === 'view-transition' || m === 'animate talk' || m === 'scroll smooth')).toEqual([])
    expect(still).toContain('scroll instant')
  })
})

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
