// The page's one polite live region (spec §5.7): <div role="status" aria-live="polite" data-announcer>.
//
// - A turn writes to it at most twice: once while it runs («AI думає над відповіддю» after 700 ms
//   without a token, or «Пробуємо ще раз через {n} секунд» — whichever comes first) and once at its
//   end (the whole answer, the error line or «Відповідь зупинено»). Whatever else a turn would say
//   is dropped; the visible countdowns and labels stay, they are aria-hidden anyway.
// - Outside a turn each announcement is said once («Можна надіслати ще раз», «Тези готові: {n}»,
//   «Збережено в щоденник»).
// - It keeps the last announcement, which may be a whole AI reply, so it is emptied ≈ 5 s after each
//   one and at once whenever the conversation is wiped (saved, ended, crisis, signed out, account
//   deleted, pageshow → 401) and on pagehide. Emptying is silent and is not one of the two writes.

export const CLEAR_AFTER_MS = 5_000
/** The same text twice in a row: empty first, so a screen reader hears it again. */
export const REPEAT_GAP_MS = 100

export type Announcer = Readonly<{
  /** One announcement outside a turn. */
  say(text: string): void
  /** A turn starts: one write while it runs, one at its end. */
  turn(): void
  /** While the turn runs: said only if nothing was said for this turn yet. */
  progress(text: string): void
  /** How the turn ended: said once per turn. */
  final(text: string): void
  /** Empty the region now (silent; not counted). */
  clear(): void
}>

/** The live region as far as this module touches it (a plain object in the core tests). */
export type Region = { textContent: string | null }

export type Timers = Readonly<{
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(handle: number): void
}>

export function createAnnouncer(region: Region | null, timers: Timers = window): Announcer {
  let clearTimer: number | null = null
  let repeatTimer: number | null = null
  let progressLeft = 0
  let finalLeft = 0

  const stopTimers = (): void => {
    if (clearTimer !== null) timers.clearTimeout(clearTimer)
    if (repeatTimer !== null) timers.clearTimeout(repeatTimer)
    clearTimer = null
    repeatTimer = null
  }

  const clear = (): void => {
    stopTimers()
    if (region && region.textContent !== '') region.textContent = ''
  }

  const write = (text: string): void => {
    if (!region || text.trim() === '') return
    stopTimers()
    const put = (): void => {
      repeatTimer = null
      region.textContent = text
      clearTimer = timers.setTimeout(clear, CLEAR_AFTER_MS)
    }
    if (region.textContent === text) {
      region.textContent = ''
      repeatTimer = timers.setTimeout(put, REPEAT_GAP_MS)
    } else {
      put()
    }
  }

  return {
    say: write,
    turn() {
      progressLeft = 1
      finalLeft = 1
    },
    progress(text) {
      if (progressLeft === 0 || finalLeft === 0) return
      progressLeft = 0
      write(text)
    },
    final(text) {
      if (finalLeft === 0) return
      finalLeft = 0
      progressLeft = 0
      write(text)
    },
    clear,
  }
}
