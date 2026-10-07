// Sky presets for /chat/ (spec §8.3 «Вигляд», §9.2): «Ніч» (no attribute, the landing's only sky),
// «Сутінки» (html[data-sky="dusk"]) and «Світанок» (html[data-sky="dawn"]). stage.css holds the
// colours; a preset changes the --sky-* custom properties and nothing else.
//
// - liora:sky is read inside try: storage may be blocked, and the night is then the answer.
// - It is written only after an explicit choice in the radio group; «Ніч» removes the key. Nothing
//   is written on a visit that does not choose.
// - The crisis puts the night back for as long as it lasts (setSuppressed): the help contacts
//   always stand on the night sky. The choice itself is kept and comes back after.
// - The landing never imports this module: there the sky is always the night.
// A module script cannot set the attribute before the first frame (no inline script under the
// CSP), so a short frame of the night before a preset is expected.

export type Sky = 'night' | 'dusk' | 'dawn'

export const SKY_KEY = 'liora:sky'

/** Anything but a known preset is the night (an old or hand-edited value included). */
export function parseSky(value: unknown): Sky {
  return value === 'dusk' || value === 'dawn' ? value : 'night'
}

/** The attribute a sky puts on <html>: none for the night. */
export function skyAttribute(sky: Sky, suppressed: boolean): Exclude<Sky, 'night'> | null {
  return suppressed || sky === 'night' ? null : sky
}

function readSky(): Sky {
  try {
    return parseSky(localStorage.getItem(SKY_KEY))
  } catch {
    return 'night'
  }
}

function writeSky(sky: Sky): void {
  try {
    if (sky === 'night') localStorage.removeItem(SKY_KEY)
    else localStorage.setItem(SKY_KEY, sky)
  } catch {
    // Blocked storage: the choice holds for this page view only.
  }
}

export interface SkyControl {
  /** true: the night, whatever was chosen (the crisis); false: the choice again. */
  setSuppressed(suppressed: boolean): void
}

/** Wires the radio group (inputs name="sky", values night | dusk | dawn) and applies the stored
 *  choice. The radios' labels get `pill--on` while checked, like the scenario pills. */
export function initSky(group: HTMLElement | null): SkyControl {
  const root = document.documentElement
  const radios = group ? Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]')) : []
  let chosen = readSky()
  let suppressed = false

  const apply = (): void => {
    const value = skyAttribute(chosen, suppressed)
    if (value === null) delete root.dataset.sky
    else if (root.dataset.sky !== value) root.dataset.sky = value
  }

  const syncRadios = (): void => {
    for (const radio of radios) {
      const on = parseSky(radio.value) === chosen
      if (radio.checked !== on) radio.checked = on
      radio.closest('label')?.classList.toggle('pill--on', on)
    }
  }

  group?.addEventListener('change', (event) => {
    const radio = event.target
    if (!(radio instanceof HTMLInputElement) || radio.type !== 'radio' || !radio.checked) return
    chosen = parseSky(radio.value)
    writeSky(chosen)
    syncRadios()
    apply()
  })

  syncRadios()
  apply()

  return {
    setSuppressed(next) {
      if (next === suppressed) return
      suppressed = next
      apply()
    },
  }
}
