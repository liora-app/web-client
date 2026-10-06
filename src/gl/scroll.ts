// Maps native scroll to a continuous scene state. Sections declare data-gl-state="<n>".
// The state holds while a section owns the middle of the viewport and blends in the gaps
// between sections. No scroll-jacking: the browser scrolls, the scene follows with damping.
// Sections with data-gl-quiet="<0..1>" (default 0.85) ask the light to calm down while they
// hold the middle of the viewport — the crisis contacts are read in silence.
// The element with data-gl-decide marks the point from which the decision has been made (step 4:
// two theses are let go); everything below it keeps that decision.

interface Plateau {
  start: number
  end: number
  state: number
}

interface QuietZone {
  top: number
  bottom: number
  weight: number
}

export class ScrollStates {
  private plateaus: Plateau[] = []
  private quietZones: QuietZone[] = []
  private decideAt = Infinity
  private readonly sections: HTMLElement[]
  private readonly quietSections: HTMLElement[]
  private readonly decider: HTMLElement | null

  constructor(root: ParentNode = document) {
    this.sections = Array.from(root.querySelectorAll<HTMLElement>('[data-gl-state]'))
    this.quietSections = Array.from(root.querySelectorAll<HTMLElement>('[data-gl-quiet]'))
    this.decider = root.querySelector<HTMLElement>('[data-gl-decide]')
    this.measure()
  }

  measure(): void {
    const scrollY = window.scrollY
    this.plateaus = this.sections
      .map((section) => {
        const rect = section.getBoundingClientRect()
        const top = rect.top + scrollY
        const inset = Math.min(rect.height * 0.3, window.innerHeight * 0.35)
        return {
          start: top + inset,
          end: top + rect.height - inset,
          state: Number(section.dataset.glState) || 0,
        }
      })
      .sort((a, b) => a.start - b.start)

    this.quietZones = this.quietSections.map((section) => {
      const rect = section.getBoundingClientRect()
      const weight = Number(section.dataset.glQuiet)
      return {
        top: rect.top + scrollY,
        bottom: rect.bottom + scrollY,
        weight: Number.isFinite(weight) && weight > 0 ? Math.min(1, weight) : 0.85,
      }
    })

    if (this.decider) {
      const rect = this.decider.getBoundingClientRect()
      this.decideAt = rect.top + scrollY + rect.height * 0.3
    } else {
      this.decideAt = Infinity
    }
  }

  /** 1 once the middle of the viewport has passed the decision point, 0 before it. */
  decide(): number {
    return window.scrollY + window.innerHeight * 0.5 >= this.decideAt ? 1 : 0
  }

  target(): number {
    const plateaus = this.plateaus
    if (plateaus.length === 0) return 0
    const focus = window.scrollY + window.innerHeight * 0.5

    const first = plateaus[0]
    if (focus <= first.end) return first.state
    for (let i = 0; i < plateaus.length - 1; i++) {
      const current = plateaus[i]
      const next = plateaus[i + 1]
      if (focus <= current.end) return current.state
      if (focus < next.start) {
        const t = (focus - current.end) / Math.max(1, next.start - current.end)
        return current.state + (next.state - current.state) * smoothstep(t)
      }
    }
    return plateaus[plateaus.length - 1].state
  }

  /** 0..1: how much of the viewport's middle band (30–70 %) belongs to a quiet section. */
  quiet(): number {
    if (this.quietZones.length === 0) return 0
    const bandTop = window.scrollY + window.innerHeight * 0.3
    const bandBottom = window.scrollY + window.innerHeight * 0.7
    let quiet = 0
    for (const zone of this.quietZones) {
      const overlap = Math.max(0, Math.min(zone.bottom, bandBottom) - Math.max(zone.top, bandTop))
      quiet = Math.max(quiet, (overlap / (bandBottom - bandTop)) * zone.weight)
    }
    return quiet
  }
}

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

// Frame-rate independent exponential smoothing toward a target.
export function damp(current: number, target: number, lambda: number, dtSeconds: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dtSeconds))
}
