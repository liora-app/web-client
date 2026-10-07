// Leaving the page (spec §2.6 I7, §3.11, §5.6).
//
// - beforeunload is registered exactly while something would be lost (I7: a message of the person,
//   sent or not, or a draft of theses not yet saved). Its text is the browser's own; browsers
//   ignore a page's text there.
// - tel: links are the exception (§3.11, test 40b): in Chromium a click on tel: fires beforeunload
//   and shows «Покинути сайт?», and «Скасувати» there drops the emergency call. A capture listener
//   lifts the guard for that click — before any other handler and before the navigation starts —
//   and puts it back on the first of: the window focused again, the tab visible again, ≈ 1 s.
// - pagehide → everything in flight is aborted with the reason 'pagehide' (the server frees the LLM
//   slot and keeps nothing). visibilitychange aborts nothing: a phone may just switch apps.
// - pageshow with persisted = true (the page came back from the bfcache) → GET /me; a 401 wipes the
//   conversation (the reducer), so «Назад» after a sign-out on a shared computer shows nothing.

export type LeaveGuard = Readonly<{
  set(wanted: boolean): void
  /** Before a navigation the page itself starts (sign-in, reload): no prompt. */
  drop(): void
}>

export type PageLife = Readonly<{
  /** pagehide: abort('pagehide') for everything in flight; let go of the answer in progress. */
  onPageHide(): void
  /** pageshow: a fresh abort scope; `persisted` (bfcache) also asks GET /me. */
  onPageShow(persisted: boolean): void
}>

/** How long the guard stays lifted after a tel: click if neither focus nor visibility comes back. */
export const TEL_GRACE_MS = 1000

export function createLeaveGuard(life: PageLife | null = null): LeaveGuard {
  let wanted = false
  let suspended = false
  let attached = false
  let restore: (() => void) | null = null

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault()
    // Older Chromium and WebKit still need returnValue to show the prompt.
    event.returnValue = ''
  }

  const apply = (): void => {
    const on = wanted && !suspended
    if (on && !attached) window.addEventListener('beforeunload', onBeforeUnload)
    else if (!on && attached) window.removeEventListener('beforeunload', onBeforeUnload)
    attached = on
  }

  document.addEventListener(
    'click',
    (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="tel:"]') : null
      if (link === null) return
      // A second tel: click while lifted: start the grace period over.
      restore?.()
      suspended = true
      apply()
      let timer = 0
      const back = (): void => {
        window.removeEventListener('focus', back)
        document.removeEventListener('visibilitychange', onVisible)
        window.clearTimeout(timer)
        restore = null
        suspended = false
        apply()
      }
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') back()
      }
      restore = (): void => {
        window.removeEventListener('focus', back)
        document.removeEventListener('visibilitychange', onVisible)
        window.clearTimeout(timer)
        restore = null
      }
      window.addEventListener('focus', back)
      document.addEventListener('visibilitychange', onVisible)
      timer = window.setTimeout(back, TEL_GRACE_MS)
    },
    true,
  )

  if (life !== null) {
    window.addEventListener('pagehide', () => life.onPageHide())
    window.addEventListener('pageshow', (event) => life.onPageShow(event.persisted))
  }

  return {
    set(next) {
      wanted = next
      apply()
    },
    drop() {
      wanted = false
      apply()
    },
  }
}
