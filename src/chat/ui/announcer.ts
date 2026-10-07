// The page's one polite live region (spec §5.7). It keeps the last announcement, which may be a
// whole AI reply, so it is emptied ≈ 5 s after each one and at once whenever the conversation is
// wiped. Emptying is silent and does not count against the two updates a turn may make.

const CLEAR_AFTER_MS = 5_000

export type Announcer = Readonly<{ say(text: string): void; clear(): void }>

export function createAnnouncer(region: HTMLElement | null): Announcer {
  let timer: number | null = null
  const clear = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    if (region && region.textContent !== '') region.textContent = ''
  }
  return {
    say(text) {
      if (!region) return
      if (timer !== null) window.clearTimeout(timer)
      region.textContent = text
      timer = window.setTimeout(clear, CLEAR_AFTER_MS)
    },
    clear,
  }
}
