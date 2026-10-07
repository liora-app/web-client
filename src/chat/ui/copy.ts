// Dynamic strings of /chat/ (spec §9.1: static text lives in chat/index.html, the rest here).
// Every text the person sees for an error comes from this dictionary, chosen by the error code:
// the server's English `error.message` never reaches the page (spec §4.1).

import type { UiError } from '../core/errors'
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
      return { label: 'Вхід не відбувся', text: 'Вхід завершився. Увійдіть, щоб видалити акаунт.' }
    case 'auth-error': {
      const code = notice.code === 'not_invited' ? 'unknown' : notice.code
      return { label: 'Вхід не відбувся', text: AUTH_TEXT[code] }
    }
  }
}

/** ?auth_error came, but the old session is alive (§3.3). */
export function stillSignedIn(code: AuthCode, email: string): string {
  if (code === 'not_invited') {
    return `Новий вхід не відбувся: тієї адреси немає в списку тестувальників, або Google не підтвердив її. Ви й далі в акаунті ${email}.`
  }
  return `Новий вхід не відбувся. Ви й далі в акаунті ${email}.`
}

// ── Turn errors under the person's message (§4.2, §4.3) ──────────────────────────────────────

export const GENERIC = 'Щось пішло не так на нашому боці. Спробуйте ще раз.'

export type TurnErrorText = Readonly<{
  why: string
  /** «Оновіть сторінку» instead of «Надіслати ще раз» (a repeated 403 csrf_failed). */
  reload: boolean
  /** Show «Код запиту» under the line. */
  showId: boolean
}>

export function turnError(error: UiError, csrfFailures: number, retryInSeconds: number | null): TurnErrorText {
  const line = (why: string, showId = false): TurnErrorText => ({ why, reload: false, showId })
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
    case 'csrf_failed':
      return csrfFailures > 1
        ? { why: 'Оновіть сторінку. Розмова при цьому зникне — спершу її можна скопіювати.', reload: true, showId: false }
        : line('Не вдалося надіслати через технічну перевірку безпеки. Спробуйте ще раз.')
    case 'forbidden':
      return line('Цю дію зараз виконати не можна.')
    case 'not_found':
      return line('Одного з обраних записів уже немає в щоденнику.')
    case 'payload_too_large':
      return line('Розмова стала задовгою, щоб надіслати її цілком.')
    case 'upstream_unavailable':
      return line('Сервер зараз не відповідає. Спробуйте за хвилину.')
    default:
      return line(GENERIC, true)
  }
}

/** The countdown of an automatic llm_busy retry (§4.3). */
export function busyWait(seconds: number): string {
  return `AI зараз зайнятий іншою розмовою. Пробуємо ще раз через ${Math.max(0, seconds)} с…`
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

export function summarizeError(error: UiError): string {
  switch (error.code) {
    case 'llm_busy':
      return 'AI досі зайнятий. Спробуйте за хвилину — розмова на місці.'
    case 'llm_failed':
    case 'timeout':
      return 'AI не зміг скласти тези. Спробуйте ще раз — розмова на місці.'
    case 'validation_error':
      return 'Не вдалося скласти тези з цієї розмови.'
    case 'payload_too_large':
      return 'Розмова завелика навіть для тез. Її можна лише завершити без тез.'
    case 'rate_limited':
      return 'За хвилину можна надіслати до 20 повідомлень разом із тезами. Скласти ще раз можна буде за хвилину.'
    case 'network':
      return 'Не вдалося — немає зʼєднання. Спробуйте ще раз.'
    case 'upstream_unavailable':
      return 'Сервер зараз не відповідає. Спробуйте за хвилину.'
    case 'csrf_failed':
      return 'Не вдалося надіслати через технічну перевірку безпеки. Спробуйте ще раз.'
    case 'forbidden':
      return 'Цю дію зараз виконати не можна.'
    default:
      return GENERIC
  }
}

export function saveError(error: UiError): string {
  switch (error.code) {
    case 'save_unknown':
      return 'Не вдалося підтвердити збереження. Ваші правки на місці.'
    case 'network':
      return 'Не вдалося — немає зʼєднання. Спробуйте ще раз.'
    case 'rate_limited':
      return 'Забагато запитів поспіль. Спробуйте за хвилину — ваші правки на місці.'
    case 'upstream_unavailable':
      return 'Сервер зараз не відповідає. Спробуйте за хвилину.'
    case 'csrf_failed':
      return 'Не вдалося надіслати через технічну перевірку безпеки. Спробуйте ще раз.'
    case 'forbidden':
      return 'Цю дію зараз виконати не можна.'
    default:
      return GENERIC
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

export function accountOpError(name: 'logout' | 'delete-account' | 'revoke', error: UiError): string {
  if (name === 'logout') {
    return error.code === 'network'
      ? 'Не вдалося вийти — немає зʼєднання. Спробуйте ще раз.'
      : 'Не вдалося вийти. Оновіть сторінку й спробуйте ще раз.'
  }
  if (name === 'delete-account') {
    if (error.code === 'delete_unknown') return 'Не вдалося підтвердити видалення. Спробуйте ще раз — повторний запит нічого не зламає.'
    if (error.code === 'network') return 'Не вдалося — немає зʼєднання. Спробуйте ще раз.'
    return GENERIC
  }
  return 'Не вдалося відкликати згоду. Спробуйте ще раз.'
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
export const sayAnswer = (text: string): string => `Відповідь AI: ${text}`
export const sayRetry = (seconds: number): string => `Пробуємо ще раз через ${seconds} секунд`
export const sayTheses = (n: number): string => `Тези готові: ${n}`
export const SAY_SAVED = 'Збережено в щоденник'

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

/** «7 жовтня 2026, 14:52» */
export function longDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
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
