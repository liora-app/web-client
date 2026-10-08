// Dynamic strings of /chat/ (spec §9.1: static text lives in chat/index.html, the rest here).
// Every text the person sees for an error comes from this dictionary, chosen by the error code:
// the server's English `error.message` never reaches the page (spec §4.1).

import type { UiError } from '../core/errors'
import { maskPausedLine } from '../core/helplines'
import type { AuthCode, AuthNotice } from '../core/state'
import type { ScenarioId, ScenarioOut } from '../core/types'

/** Scenario descriptions (spec §3.6). The server's own `situation` text names a psychotherapy
 *  method, which must not stand next to «не терапія»; unknown ids fall back to the server text. */
const SCENARIO_ABOUT: Readonly<Record<string, string>> = {
  free: 'Будь-яка тема. Можна просто виговоритися, а AI ставитиме уточнювальні запитання.',
  situation: 'Що сталося, що ви подумали й відчули — і як ще можна на це подивитися. Вправа для роздумів, а не терапія.',
  day: 'Що сталося за день, що ви відчували і що з цього варте уваги.',
  revisit: 'Поверніться до теми зі свого щоденника: AI отримає тези, які ви оберете.',
}

export function scenarioAbout(scenario: ScenarioOut): string {
  return SCENARIO_ABOUT[scenario.id] ?? scenario.description
}

export const REVISIT_EMPTY =
  'Тут можна повернутися до тем зі щоденника. Поки що в ньому немає записів — вони зʼявляться, коли ви збережете тези після розмови.'
export const REVISIT_FAILED = 'Не вдалося завантажити збережені тези.'

const PLACEHOLDER: Readonly<Record<string, string>> = {
  free: 'Пишіть так, як думаєте…',
  situation: 'Що сталося?',
  day: 'Як минув день?',
  revisit: 'Що змінилося?',
}

export function placeholder(scenario: ScenarioId, firstMessage: boolean): string {
  if (!firstMessage) return 'Ваша відповідь…'
  return PLACEHOLDER[scenario] ?? PLACEHOLDER.free!
}

// ── Sign-in banner (§3.3) ────────────────────────────────────────────────────────────────────

const AUTH_TEXT: Readonly<Record<Exclude<AuthCode, 'not_invited'>, string>> = {
  access_denied: 'Вхід скасовано. Можна спробувати ще раз, коли будете готові.',
  state_mismatch:
    'Вхід не завершився. Так буває, якщо сторінку входу відкрили в іншій вкладці або повернулися кнопкою «Назад». Спробуйте ще раз.',
  expired: 'Сторінка входу була відкрита понад 10 хвилин і застаріла. Спробуйте ще раз.',
  server_error: 'Google або наш сервер відповіли не так, як треба. Спробуйте за хвилину.',
  auth_unavailable: 'Вхід тимчасово недоступний. Спробуйте пізніше — 112 і 103 працюють завжди.',
  unknown: 'Не вдалося увійти. Спробуйте ще раз.',
}

export type BannerText = Readonly<{ label: string | null; text: string }>

export function signInBanner(notice: AuthNotice): BannerText {
  switch (notice.kind) {
    case 'logged-out':
      return { label: null, text: 'Ви вийшли з акаунта на цьому пристрої.' }
    case 'delete-relogin':
      // No sign-in failed here: the session ended. The label belongs to a failed return from Google.
      return { label: null, text: 'Вхід завершився. Увійдіть, щоб видалити акаунт.' }
    case 'auth-error': {
      const code = notice.code === 'not_invited' ? 'unknown' : notice.code
      return { label: 'Вхід не відбувся', text: AUTH_TEXT[code] }
    }
  }
}

/** ?auth_error came, but the old session is alive (§3.3). */
export function stillSignedIn(code: AuthCode, email: string): string {
  if (code === 'not_invited') {
    return `Новий вхід не відбувся: Google не підтвердив адресу електронної пошти. Ви й далі в акаунті ${email}.`
  }
  return `Новий вхід не відбувся. Ви й далі в акаунті ${email}.`
}

// ── Errors (§4.2, §4.3): one dictionary, chosen by the code ──────────────────────────────────

/** For internal, http_error, bad_request, method_not_allowed, json_invalid and any unknown code. */
export const GENERIC = 'Щось пішло не так на нашому боці. Спробуйте ще раз.'
export const NO_CONNECTION = 'Не вдалося — немає зʼєднання. Спробуйте ще раз.'
export const SERVER_DOWN = 'Сервер зараз не відповідає. Спробуйте за хвилину.'
export const FORBIDDEN = 'Цю дію зараз виконати не можна.'
export const CSRF_FIRST = 'Не вдалося надіслати через технічну перевірку безпеки. Спробуйте ще раз.'
export const CSRF_RELOAD = 'Оновіть сторінку. Розмова при цьому зникне — спершу її можна скопіювати.'

export type ErrorText = Readonly<{
  why: string
  /** «Оновіть сторінку» instead of a retry (a repeated 403 csrf_failed). */
  reload: boolean
  /** Show «Код запиту» under the line. */
  showId: boolean
}>

const line = (why: string, showId = false): ErrorText => ({ why, reload: false, showId })

/** Codes the server sends with a 502/503 of its own; any other 502–504 (an empty body from Caddy,
 *  auth_unavailable, a code we do not know) reads as «Сервер зараз не відповідає» (§4.3). */
const OWN_GATEWAY_CODES: ReadonlySet<string> = new Set(['llm_busy', 'llm_failed'])

function gateway(error: UiError): boolean {
  if (error.code === 'upstream_unavailable') return true
  return error.status !== null && error.status >= 502 && error.status <= 504 && !OWN_GATEWAY_CODES.has(error.code)
}

/** What every request shares: the gateway, CSRF, a bare 403, and the codes that only mean «our
 *  bug» (404 is generic everywhere except a revisit turn). Null: the place decides. */
function shared(error: UiError, csrfFailures: number): ErrorText | null {
  if (gateway(error)) return line(SERVER_DOWN)
  switch (error.code) {
    case 'csrf_failed':
      return csrfFailures > 1 ? { why: CSRF_RELOAD, reload: true, showId: false } : line(CSRF_FIRST)
    case 'forbidden':
      return line(FORBIDDEN)
    case 'internal':
    case 'http_error':
    case 'bad_request':
    case 'method_not_allowed':
    case 'json_invalid':
    case 'not_found':
    case 'invalid_timezone':
      return line(GENERIC, true)
    default:
      return null
  }
}

/** Under the person's message in the conversation (§3.7.2, §4.3). */
export function turnError(error: UiError, csrfFailures: number, retryInSeconds: number | null, revisit = false): ErrorText {
  switch (error.code) {
    case 'network':
      return line('Немає зʼєднання.')
    case 'headers_timeout':
      return line('Відповідь не прийшла.')
    case 'truncated':
      return line('Зʼєднання обірвалося. Ваше повідомлення на місці.')
    case 'llm_failed':
      return line('AI не зміг відповісти. Ваше повідомлення на місці — спробуйте ще раз.')
    case 'empty_reply':
      return line('AI не зміг відповісти.')
    case 'llm_busy':
      return line('AI досі зайнятий. Спробуйте за хвилину — ваше повідомлення на місці.')
    case 'rate_limited':
      return line(
        retryInSeconds !== null && retryInSeconds > 0
          ? `За хвилину можна надіслати до 20 повідомлень разом із тезами. Надіслати знову можна через ${retryInSeconds} с.`
          : 'За хвилину можна надіслати до 20 повідомлень разом із тезами. Можна надіслати ще раз.',
      )
    case 'validation_error':
      return line('Повідомлення не пройшло перевірку. Спробуйте скоротити або змінити його.')
    case 'not_found':
      // Only a revisit turn has ids the server can miss; anywhere else a 404 is our bug.
      return revisit ? line('Одного з обраних записів уже немає в щоденнику.') : line(GENERIC, true)
    case 'payload_too_large':
      return line('Розмова стала задовгою, щоб надіслати її цілком.')
    default:
      return shared(error, csrfFailures) ?? line(GENERIC, true)
  }
}

/** The countdown of an automatic llm_busy retry (§4.3): what it is, then the seconds. */
export const BUSY_NOW = 'AI зараз зайнятий іншою розмовою.'
export function busyRetryIn(seconds: number): string {
  return `Пробуємо ще раз через ${Math.max(0, seconds)} с…`
}
export function busyWait(seconds: number): string {
  return `${BUSY_NOW} ${busyRetryIn(seconds)}`
}

/** The label in the AI's slot while the answer is on its way (§3.7.4). */
export function waitLabel(stage: 'headers' | 'meta', elapsedMs: number): string {
  if (stage === 'meta') return elapsedMs > 8_000 ? 'Думає довше, ніж зазвичай' : 'Думає'
  if (elapsedMs > 12_000) return 'Сервер AI зайнятий — чекаємо черги, до 20 с'
  if (elapsedMs > 6_000) return 'Думає довше, ніж зазвичай'
  return 'Думає'
}

// ── Composer notices and blocks (§3.6, §3.7.3, §3.7.7) ───────────────────────────────────────

export const NEED_RECORDS = 'Спершу оберіть записи, до яких повернутися.'
export const UNSENT = 'Спершу надішліть ще раз або змініть повідомлення, яке не надіслалося.'
export const LONG_CONVERSATION = 'Розмова вже довга. Ще кілька повідомлень — і її варто буде підсумувати.'
export const SERVER_TRIM = 'Розмова довга: найперші репліки AI вже може не враховувати.'
export const LIMIT_BLOCK = 'Ця розмова досягла межі довжини. Підсумуйте її — або завершіть і почніть нову.'
export const TOO_LARGE_BLOCK = 'Розмова стала задовгою, щоб надіслати її цілком. Підсумуйте її або почніть нову.'
export const REVISIT_GONE_BLOCK = 'Записів, до яких ви поверталися, у щоденнику вже немає.'
export const COOLDOWN_OVER = 'Можна надіслати ще раз.'

const groups = new Intl.NumberFormat('uk')

export function tooLong(length: number): string {
  return `Повідомлення задовге: ${groups.format(length)} із ${groups.format(4000)} символів. Розділіть його на два.`
}

export function counter(length: number, max: number): string {
  return `${groups.format(length)} / ${groups.format(max)}`
}

// ── Theses (§7.1–7.3) ────────────────────────────────────────────────────────────────────────

const RATE_LIMIT_NOTE = 'За хвилину можна надіслати до 20 повідомлень разом із тезами.'

/** The line on `summarizing` (§7.1, §4.3). `retryInSeconds`: what is left of a 429 countdown.
 *  The line is a live region, so the seconds never go into it: while the countdown runs it says
 *  only what happened, and summarizeRetryIn() writes the seconds beside it, outside the region —
 *  readable, never announced (§5.7). */
export function summarizeError(error: UiError, csrfFailures: number, retryInSeconds: number | null): ErrorText {
  switch (error.code) {
    case 'llm_busy':
      return line('AI досі зайнятий. Спробуйте за хвилину — розмова на місці.')
    case 'llm_failed':
    case 'timeout':
      return line('AI не зміг скласти тези. Спробуйте ще раз — розмова на місці.')
    case 'validation_error':
      return line('Не вдалося скласти тези з цієї розмови.')
    case 'payload_too_large':
      return line('Розмова завелика навіть для тез. Її можна лише завершити без тез.')
    case 'rate_limited':
      return line(
        retryInSeconds !== null && retryInSeconds > 0
          ? RATE_LIMIT_NOTE
          : `${RATE_LIMIT_NOTE} Можна скласти тези ще раз.`,
      )
    case 'network':
      return line(NO_CONNECTION)
    case 'aborted':
      // The page was hidden before the request (or its automatic retry) went: nothing failed here.
      return line('Тези ще не складено. Спробуйте ще раз — розмова на місці.')
    default:
      return shared(error, csrfFailures) ?? line(GENERIC, true)
  }
}

/** Beside the live line on `summarizing`, outside it: the seconds left of a 429 countdown. */
export function summarizeRetryIn(seconds: number): string {
  return `Скласти тези знову можна через ${seconds} с.`
}

/** Next to «Зберегти в щоденник» (§7.3). A 422 that maps to a field is shown on the field. */
export function saveError(error: UiError, csrfFailures: number): ErrorText {
  switch (error.code) {
    case 'save_unknown':
      return line('Не вдалося підтвердити збереження. Ваші правки на місці.')
    case 'network':
      return line(NO_CONNECTION)
    case 'rate_limited':
      return line('Забагато запитів поспіль. Спробуйте за хвилину — ваші правки на місці.')
    case 'validation_error':
      return line(GENERIC, true)
    default:
      return shared(error, csrfFailures) ?? line(GENERIC, true)
  }
}

export const DRAFT_TEXT: Readonly<Record<string, string>> = {
  'title-empty': 'Додайте коротку назву — так запис легше знайти в щоденнику.',
  'title-long': 'Назва: до 120 символів.',
  'title-nul': 'Назва: від 1 до 120 символів.',
  'title-invalid': 'Назва: від 1 до 120 символів.',
  'bullets-none': 'Потрібна хоча б одна теза.',
  'bullets-many': 'Не більше 5 тез.',
  'bullet-long': 'Теза: до 500 символів.',
  'bullet-nul': 'Теза: до 500 символів.',
  'bullet-invalid': 'Теза: до 500 символів.',
  'tags-many': 'Не більше 10 тегів.',
  'tag-empty': 'Тег: до 40 символів.',
  'tag-long': 'Тег задовгий: до 40 символів.',
  'tag-nul': 'Тег: до 40 символів.',
  'tag-dup': 'Такий тег уже є.',
  'tag-invalid': 'Тег: до 40 символів.',
}

// ── Consent and the account (§3.5, §8) ───────────────────────────────────────────────────────

export const CONSENT_UNCHECKED = 'Позначте всі три пункти — без них розмова з AI неможлива.'
export const CONSENT_SAVE_FAILED = 'Не вдалося зберегти згоду. Спробуйте ще раз.'
export const CONSENT_LOAD_FAILED = 'Не вдалося завантажити умови. Спробуйте ще раз.'

/** Under «Погоджуюся» (§3.5, §4.3). The unchecked boxes and a missing provider have their own
 *  places; a network failure says so; 5xx, 422 and the rest — «Не вдалося зберегти згоду». */
export function consentError(error: UiError, csrfFailures: number): ErrorText | null {
  switch (error.code) {
    case 'unchecked':
    case 'provider_missing':
      return null
    case 'consents_load_failed':
      return line(CONSENT_LOAD_FAILED)
    case 'network':
      return line(NO_CONNECTION)
    case 'csrf_failed':
    case 'forbidden':
      return shared(error, csrfFailures)
    default:
      return line(CONSENT_SAVE_FAILED)
  }
}

export type AccountOp = 'logout' | 'delete-account' | 'revoke'

/** In the dialog of the operation, or next to «Вийти» (§8.4–8.6, §4.3). */
export function accountOpError(name: AccountOp, error: UiError): ErrorText {
  if (name === 'logout') {
    return line(
      error.code === 'network'
        ? 'Не вдалося вийти — немає зʼєднання. Спробуйте ще раз.'
        : 'Не вдалося вийти. Оновіть сторінку й спробуйте ще раз.',
    )
  }
  if (name === 'delete-account') {
    // Network, our timeout, a gateway without a body: the account may be gone already, and a
    // repeat is safe (§8.5).
    if (error.code === 'delete_unknown') return line('Не вдалося підтвердити видалення. Спробуйте ще раз — повторний запит нічого не зламає.', true)
    if (error.code === 'network') return line(NO_CONNECTION)
    return shared(error, 0) ?? line(GENERIC, true)
  }
  if (error.code === 'network') return line(NO_CONNECTION)
  if (error.code === 'validation_error') return line(CONSENT_SAVE_FAILED)
  if (error.code === 'csrf_failed' || error.code === 'forbidden') return shared(error, 0)!
  return line('Не вдалося відкликати згоду. Спробуйте ще раз.')
}

export function requestIdLine(id: string | null): string | null {
  return id === null || id === '' ? null : `Код запиту: ${id}`
}

// ── Presence (§3.1 «Під кулею», §9.2) ────────────────────────────────────────────────────────

export type Presence = 'idle' | 'thinking' | 'speaking' | 'summary' | 'saved' | 'quiet'

export const PRESENCE_LABEL: Readonly<Record<Presence, string>> = {
  idle: 'Чекає на ваше повідомлення',
  thinking: 'Думає над відповіддю',
  speaking: 'Відповідає',
  summary: 'Складає тези',
  saved: 'Тези збережено',
  quiet: 'Розмову зупинено',
}

// ── Announcer (§5.7) ─────────────────────────────────────────────────────────────────────────

export const SAY_THINKING = 'AI думає над відповіддю'
export const SAY_STOPPED = 'Відповідь зупинено'
/** The answer read out once it is in — with the paused number masked, as on the screen. */
export const sayAnswer = (text: string): string => `Відповідь AI: ${maskPausedLine(text)}`
const plural = new Intl.PluralRules('uk')
const SECONDS: Readonly<Record<string, string>> = { one: 'секунду', few: 'секунди', many: 'секунд', other: 'секунди' }
/** «через 1 секунду», «через 3 секунди», «через 5 секунд», «через 22 секунди». */
export function secondsWord(n: number): string {
  return SECONDS[plural.select(n)] ?? 'секунд'
}
export const sayRetry = (seconds: number): string => `Пробуємо ще раз через ${seconds} ${secondsWord(seconds)}`
export const sayTheses = (n: number): string => `Тези готові: ${n}`
export const SAY_SAVED = 'Збережено в щоденник'

// ── Copying (§3.8) ───────────────────────────────────────────────────────────────────────────

export const COPIED = 'Скопійовано'
/** On the button for 2 s; copyFailed() is what the live region says. */
export const COPY_FAILED_LABEL = 'Не вдалося скопіювати'
export function copyFailed(kind: 'talk' | 'theses'): string {
  return kind === 'theses'
    ? 'Не вдалося скопіювати. Виділіть тези вручну.'
    : 'Не вдалося скопіювати. Виділіть текст розмови вручну.'
}

// ── Dates ────────────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** «6 жовтня 2026 р.» for a policy version that is a date; anything else as it is (§3.5). */
export function policyVersion(version: string): string {
  if (!ISO_DATE.test(version)) return version
  const date = new Date(`${version}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return version
  return new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
}

/** дд.мм.рррр */
export function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('uk', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

/** «7 жовтня 2026, 14:52» (Intl alone gives «7 жовтня 2026 р. о 14:52»). */
export function longDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'long', year: 'numeric' }).format(date).replace(/\s*р\.$/, '')
  const time = new Intl.DateTimeFormat('uk', { hour: '2-digit', minute: '2-digit' }).format(date)
  return `${day}, ${time}`
}

/** дд.мм */
export function dayMonth(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('uk', { day: '2-digit', month: '2-digit' }).format(date)
}

/** «7 жовтня 2026» — the first line of a copied conversation (§3.8). */
export function today(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'long', year: 'numeric' }).format(now).replace(/\s*р\.$/, '')
}
