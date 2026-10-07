// beforeunload by I7 (spec §2.6): registered exactly while something would be lost. Its text is
// the browser's own; browsers ignore a page's text there.
//
// tel: links are the exception (§3.11): in Chromium a click on tel: fires beforeunload and shows
// «Покинути сайт?», and «Скасувати» there drops the emergency call. A capture listener lifts the
// guard for that click and puts it back on the first of: window focus, the tab visible again, ≈ 1 s.

export type LeaveGuard = Readonly<{
  set(wanted: boolean): void
  /** Before a navigation the page itself starts (sign-in, reload): no prompt. */
  drop(): void
}>

export function createLeaveGuard(): LeaveGuard {
  let wanted = false
  let suspended = false
  let attached = false

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
      const target = event.target instanceof Element ? event.target.closest('a[href^="tel:"]') : null
      if (target === null) return
      suspended = true
      apply()
      let timer = 0
      const back = (): void => {
        window.removeEventListener('focus', back)
        document.removeEventListener('visibilitychange', onVisible)
        window.clearTimeout(timer)
        suspended = false
        apply()
      }
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') back()
      }
      window.addEventListener('focus', back)
      document.addEventListener('visibilitychange', onVisible)
      timer = window.setTimeout(back, 1000)
    },
    true,
  )

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
