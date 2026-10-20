// data-presence ↔ the scene, the CSS orb, the label under the light and the sound (spec §9.2).
// One attribute on .presence drives all of them; without motion only the label tells the state.
// `listening` is the page's own: while the person types (and the AI is idle in the conversation)
// the light is a little more awake. It never reaches the state machine — a keystroke is not an
// action — and nothing is sent: the label says so («Ви пишете…»).

import type { GlControl } from '../../gl/core/boot'
import type { PresenceHandle } from '../../gl/presence'
import type { SoundControl } from '../../ui/sound'
import type { Model } from '../core/state'
import { PRESENCE_LABEL, type Presence } from './copy'
import { setAttr, setText } from './dom'

/** The landing's scene state each presence borrows its chord from (sound-engine moods). */
const MOOD: Readonly<Record<Presence, number>> = { idle: 0, listening: 0, thinking: 2, speaking: 2, summary: 3, saved: 5, quiet: 6 }

/** How long `listening` outlasts the last keystroke. */
const LISTEN_MS = 1600

export function presenceOf(model: Model): Presence {
  const { state } = model
  switch (state.s) {
    case 'chat':
      if (state.turn.p === 'streaming') return 'speaking'
      if (state.turn.p === 'waiting' || state.turn.p === 'busy-wait') return 'thinking'
      return 'idle'
    case 'summarizing':
      return 'summary'
    case 'saved':
      return 'saved'
    case 'crisis':
      return 'quiet'
    default:
      return 'idle'
  }
}

export type PresenceView = Readonly<{
  sync(model: Model, helpOpen: boolean): void
  pulse(): void
  /** The person typed in the field: `listening` for a moment, if the AI is idle in the conversation. */
  listen(): void
}>

export function createPresence(
  root: HTMLElement,
  gl: GlControl<PresenceHandle> | null,
  sound: SoundControl | null,
): PresenceView {
  const label = root.querySelector<HTMLElement>('[data-presence-label]')
  let current: Presence | null = null
  let booting = true
  let lastModel: Model | null = null
  let lastHelp = false
  let listening = false
  let listenTimer = 0
  // «Зʼєднуємося» only after 400 ms, so a fast boot does not flash it (§3.2).
  const bootTimer = window.setTimeout(() => {
    if (booting && label) label.classList.add('presence__state--on')
  }, 400)

  const apply = (model: Model, helpOpen: boolean): void => {
    const base = presenceOf(model)
    const next: Presence = listening && base === 'idle' && model.state.s === 'chat' ? 'listening' : base
    const isBooting = model.state.s === 'booting'
    if (!isBooting && booting) {
      booting = false
      window.clearTimeout(bootTimer)
      label?.classList.add('presence__state--on')
    }
    if (label) setText(label, isBooting ? 'Зʼєднуємося' : PRESENCE_LABEL[next])
    if (next !== current) {
      current = next
      setAttr(root, 'data-presence', next)
      gl?.handle()?.setPresence(next)
      sound?.setMood(MOOD[next])
    }
    // Silent in the crisis and while the help dialog is open (§3.11, §9.3).
    sound?.setQuiet(next === 'quiet' || helpOpen)
  }

  return {
    sync(model, helpOpen) {
      lastModel = model
      lastHelp = helpOpen
      // A new screen (the crisis above all) ends the typing at once.
      if (model.state.s !== 'chat' && listening) {
        listening = false
        window.clearTimeout(listenTimer)
      }
      apply(model, helpOpen)
    },
    pulse() {
      gl?.handle()?.pulse()
    },
    listen() {
      if (lastModel === null || lastModel.state.s !== 'chat') return
      window.clearTimeout(listenTimer)
      const was = listening
      listening = true
      listenTimer = window.setTimeout(() => {
        listening = false
        if (lastModel) apply(lastModel, lastHelp)
      }, LISTEN_MS)
      if (!was) apply(lastModel, lastHelp)
    },
  }
}

/** Applies the page's presence to a scene that has just started (bootGL onReady). */
export function applyPresence(handle: PresenceHandle, root: HTMLElement): void {
  const value = root.getAttribute('data-presence')
  if (value !== null && value in PRESENCE_LABEL) handle.setPresence(value as Presence)
}
