// Quality tiers and a frame-time governor. The scene starts from a conservative guess and
// only steps down: resolution, the bokeh, particle count, and finally gives up (static backdrop).

export type TierName = 'high' | 'medium' | 'low'

export interface Tier {
  name: TierName
  particles: number
  /** Out-of-focus discs drifting past the camera (large points: fill-rate, not vertices). */
  bokeh: number
  dprCap: number
  /** Multisampling of the default framebuffer (core/renderer.ts). 0 on every tier for now: the
   *  landing smooths its edges in the shaders. 4 is for a scene with hard edges (phase 4). */
  msaa: 0 | 4
  /** Character mesh detail (phase 4; nothing reads it yet). */
  charLod: 'low' | 'high'
  /** Environment map size in pixels (phase 4; nothing reads it yet). */
  envSize: number
}

const TIERS: Record<TierName, Tier> = {
  high: { name: 'high', particles: 36000, bokeh: 240, dprCap: 1.75, msaa: 0, charLod: 'high', envSize: 256 },
  medium: { name: 'medium', particles: 22000, bokeh: 150, dprCap: 1.5, msaa: 0, charLod: 'high', envSize: 128 },
  low: { name: 'low', particles: 12000, bokeh: 80, dprCap: 1.25, msaa: 0, charLod: 'low', envSize: 64 },
}

export interface PickTierOptions {
  /** Set by the page that boots the scene (the chat: 'low'); wins over ?tier and the device. */
  force?: TierName
}

export function pickTier({ force }: PickTierOptions = {}): Tier {
  if (force) return TIERS[force]
  // ?tier=low|medium|high: a manual override for slow machines and for checking a tier by hand.
  const forced = new URLSearchParams(window.location.search).get('tier')
  if (forced === 'low' || forced === 'medium' || forced === 'high') return TIERS[forced]

  const nav = navigator as Navigator & { deviceMemory?: number }
  const cores = nav.hardwareConcurrency || 4
  const memory = nav.deviceMemory ?? 8
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 600

  if (memory <= 2 || cores <= 2) return TIERS.low
  if (coarse || smallScreen || memory <= 4 || cores <= 4) return TIERS.medium
  return TIERS.high
}

export type GovernorAction = 'lower-dpr' | 'fewer-bokeh' | 'fewer-particles' | 'give-up' | null

// What each step down does, in order: the cheapest to notice first.
const LADDER: GovernorAction[] = ['lower-dpr', 'fewer-bokeh', 'fewer-particles', 'lower-dpr', 'fewer-particles']

// Watches the median of 60 active frame times. Budget 40 ms: a browser that caps animation at
// 30 fps (iOS Low Power Mode, Chrome Energy Saver) delivers ~33 ms frames with a few missed vsyncs;
// a median over 40 ms on 60 Hz means more than half the frames took three vsyncs (≤ 20 fps).
const BUDGET_MS = 40
const HOPELESS_MS = 70
const MAX_STEPS = LADDER.length
// A single frame this long is a hitch (GC pause, shader compile, busy main thread) and is ignored;
// a run of them means the device cannot draw the scene at all (≥3 s below 4 fps).
const HITCH_MS = 250
const HITCH_RUN = 12
// Start-up check for renderers that hide what they are: WebKit reports "Apple GPU" even when it
// rasterises in software (Playwright's WebKit on Windows does ~0.5 fps here). Three slow frames
// among the first twelve — a long interval, or a long time spent inside render() itself — and the
// static page takes over within seconds instead of after a minute of a frozen main thread.
const STARTUP_FRAMES = 12
const STARTUP_STRIKES = 3
const STARTUP_INTERVAL_MS = 400
const STARTUP_RENDER_MS = 60

export class FrameGovernor {
  private samples: number[] = []
  private cooldown = 90 // frames to wait after start or after a step down
  private steps = 0
  private hitches = 0
  private seen = 0
  private strikes = 0
  private lastRenderMs = 0

  /** dtMs: time since the previous frame; renderMs: CPU time spent inside renderer.render(). */
  sample(dtMs: number, renderMs = 0): GovernorAction {
    // dtMs already contains the previous frame's render(): one stall must strike only once.
    const waitedMs = dtMs - this.lastRenderMs
    this.lastRenderMs = renderMs
    if (this.seen < STARTUP_FRAMES) {
      this.seen++
      if (waitedMs > STARTUP_INTERVAL_MS || renderMs > STARTUP_RENDER_MS) this.strikes++
      if (this.strikes >= STARTUP_STRIKES) return 'give-up'
    }
    if (dtMs > HITCH_MS) return ++this.hitches >= HITCH_RUN ? 'give-up' : null
    this.hitches = 0
    if (this.cooldown > 0) {
      this.cooldown--
      return null
    }
    this.samples.push(dtMs)
    if (this.samples.length < 60) return null

    const median = this.samples.sort((a, b) => a - b)[this.samples.length >> 1]
    this.samples = []
    if (median <= BUDGET_MS) return null

    this.cooldown = 120
    this.steps++
    if (this.steps > MAX_STEPS || (this.steps > 2 && median > HOPELESS_MS)) return 'give-up'
    return LADDER[this.steps - 1]
  }
}
