// The self-help tools beside the conversation (spec §3.13; research selfhelp.md §3.1–3.6, §8):
// the paced breathing and the words of «Як ви зараз?». Pure: no DOM, no clock, no storage — the
// page measures the time and asks; a word the person picks lives only in the state, in this tab
// (I1). Nothing here is ever sent: no request carries a mood word or a breathing step.

/** The tools of «+ Інструменти», «Якщо важко» and the signed-out screen. */
export const TOOL_KINDS = ['breathe', 'ground', 'mood', 'shelter'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

export function isToolKind(value: string): value is ToolKind {
  return (TOOL_KINDS as readonly string[]).includes(value)
}

// ── «Подихати хвилину» ─────────────────────────────────────────────────────────────────────

export type BreathPattern = 'slow' | 'sigh'
/** `top`: the short second sip of the cyclic sigh. */
export type BreathPhase = 'in' | 'top' | 'out'
export type BreathStep = Readonly<{ phase: BreathPhase; ms: number }>

/** Slow breathing: in 4 s, out 6 s — six breaths a minute, no holds (selfhelp §3.1). The cyclic
 *  sigh: in through the nose, a short second sip, a long slow out (§3.2). */
const SLOW: readonly BreathStep[] = [
  { phase: 'in', ms: 4000 },
  { phase: 'out', ms: 6000 },
]
const SIGH: readonly BreathStep[] = [
  { phase: 'in', ms: 2000 },
  { phase: 'top', ms: 1000 },
  { phase: 'out', ms: 6000 },
]
export const BREATH_PATTERNS: Readonly<Record<BreathPattern, readonly BreathStep[]>> = Object.freeze({
  slow: Object.freeze(SLOW),
  sigh: Object.freeze(SIGH),
})

/** A minute by default, in whole breaths: 6 × 10 s, 7 × 9 s. */
export const BREATH_ROUNDS: Readonly<Record<BreathPattern, number>> = Object.freeze({ slow: 6, sigh: 7 })

export function breathCycleMs(pattern: BreathPattern): number {
  return BREATH_PATTERNS[pattern].reduce((sum, step) => sum + step.ms, 0)
}

export function breathTotalMs(pattern: BreathPattern): number {
  return breathCycleMs(pattern) * BREATH_ROUNDS[pattern]
}

export type BreathAt = Readonly<{
  /** The minute is over. */
  done: boolean
  /** 0-based breath. */
  round: number
  /** Index of the step within the pattern. */
  step: number
  phase: BreathPhase
  /** The step's length and how far into it the time is. */
  phaseMs: number
  intoMs: number
  /** Whole seconds left in this step, counted down 4 3 2 1 (never 0 while it runs). */
  left: number
}>

/** Where the exercise is `elapsedMs` after «Почати». Computed from the time, not from ticks: a
 *  throttled timer in a background tab cannot make it drift. */
export function breathAt(pattern: BreathPattern, elapsedMs: number): BreathAt {
  const steps = BREATH_PATTERNS[pattern]
  const cycle = breathCycleMs(pattern)
  const t = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0)
  if (t >= breathTotalMs(pattern)) {
    const last = steps[steps.length - 1]!
    return { done: true, round: BREATH_ROUNDS[pattern] - 1, step: steps.length - 1, phase: last.phase, phaseMs: last.ms, intoMs: last.ms, left: 0 }
  }
  const round = Math.floor(t / cycle)
  let into = t - round * cycle
  let step = 0
  while (step < steps.length - 1 && into >= steps[step]!.ms) {
    into -= steps[step]!.ms
    step++
  }
  const current = steps[step]!
  return {
    done: false,
    round,
    step,
    phase: current.phase,
    phaseMs: current.ms,
    intoMs: into,
    left: Math.max(1, Math.ceil((current.ms - into) / 1000)),
  }
}

/** Milliseconds until the count next changes (a new second or a new step): the page's next tick. */
export function breathNextChangeMs(at: BreathAt): number {
  if (at.done) return 0
  const toEnd = at.phaseMs - at.intoMs
  const toSecond = toEnd % 1000 === 0 ? 1000 : toEnd % 1000
  return Math.max(1, Math.min(toEnd, toSecond))
}

// ── «Як ви зараз?» ─────────────────────────────────────────────────────────────────────────

/** Energy × pleasantness, in the order of the 2 × 2 grid: the top row has more energy, the right
 *  column is pleasant (a circumplex of our own — not another product's words or colours). */
export const MOOD_QUADRANTS = ['high-unpleasant', 'high-pleasant', 'low-unpleasant', 'low-pleasant'] as const
export type MoodQuadrant = (typeof MOOD_QUADRANTS)[number]

/** Six words a quadrant, our own dictionary (selfhelp §3.6). None of them names a condition or
 *  sits on the stop-list: «неспокій» and «напруга», never the clinical word for worry. */
export const MOOD_WORDS: Readonly<Record<MoodQuadrant, readonly string[]>> = Object.freeze({
  'high-unpleasant': Object.freeze(['неспокій', 'роздратування', 'злість', 'напруга', 'страх', 'розгубленість']),
  'high-pleasant': Object.freeze(['натхнення', 'радість', 'азарт', 'піднесення', 'цікавість', 'гордість']),
  'low-unpleasant': Object.freeze(['втома', 'смуток', 'порожнеча', 'самотність', 'розчарування', 'байдужість']),
  'low-pleasant': Object.freeze(['спокій', 'вдячність', 'полегшення', 'затишок', 'задоволення', 'ніжність']),
})

export function isMoodWord(word: string): boolean {
  return MOOD_QUADRANTS.some((q) => MOOD_WORDS[q].includes(word))
}

/** The first check-in of a conversation and the one asked for at its end («А зараз?»): words the
 *  person chose, never scores, never sent, never a tag. */
export type MoodLog = Readonly<{ before: string | null; after: string | null }>

export const NO_MOOD: MoodLog = Object.freeze({ before: null, after: null })
