// «Персонаж»: whether the chat shows its character — the presence above the conversation, the WebGL
// light in its slot and the small orb of the session row (ADR-013 §6). On by default. The choice is
// remembered in this browser under liora:character, and this module is the only one that knows the
// key: «вимкнути» stores 'off', «увімкнути» removes the key (as «Як у системі» does for the theme).
// A visit without a choice writes nothing. Every access to storage is in try/catch: with blocked
// storage the choice holds for this page view only.
//
// The choice is on <html> as data-character="on|off" (the CSS hides the presence by it), and the
// button in the chat's header carries it as aria-pressed (true = the character is shown): a toggle
// with a fixed name, as «Звук» (APG). What the AI is stays said without the character: the chip
// «AI · не людина», «AI» beside every reply, the line under the field.

export type Character = 'on' | 'off'

export const CHARACTER_KEY = 'liora:character'

/** Anything but 'off' is on (a missing, old or hand-edited value included). */
export function parseCharacter(value: unknown): Character {
  return value === 'off' ? 'off' : 'on'
}

function read(): Character {
  try {
    return parseCharacter(window.localStorage.getItem(CHARACTER_KEY))
  } catch {
    return 'on'
  }
}

function write(character: Character): void {
  try {
    if (character === 'on') window.localStorage.removeItem(CHARACTER_KEY)
    else window.localStorage.setItem(CHARACTER_KEY, 'off')
  } catch {
    // Blocked storage: the choice holds for this page view only.
  }
}

export interface CharacterControl {
  /** The character is shown (the person did not hide it). */
  shown(): boolean
  /** Called after every change made with the button. */
  onChange(listener: (shown: boolean) => void): void
}

/** Puts the choice on <html> at once, wires the button (shown only with JS) and keeps its
 *  aria-pressed in step. */
export function initCharacter(button: HTMLButtonElement | null): CharacterControl {
  let current = read()
  const listeners = new Set<(shown: boolean) => void>()
  const render = (): void => {
    document.documentElement.dataset.character = current
    button?.setAttribute('aria-pressed', String(current === 'on'))
  }
  if (button) {
    button.hidden = false
    button.addEventListener('click', () => {
      current = current === 'on' ? 'off' : 'on'
      write(current)
      render()
      for (const listener of listeners) listener(current === 'on')
    })
  }
  render()
  return {
    shown: () => current === 'on',
    onChange: (listener) => {
      listeners.add(listener)
    },
  }
}
