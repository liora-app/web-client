// A soft generative pad for «Звук»: a few detuned sine and triangle voices through a slowly
// breathing low-pass filter into a long synthetic reverb. Each chapter has its own chord and the
// voices glide between them. Quiet on purpose: a room tone, not music to listen to.
// Loaded on the first press of «Звук» (see sound.ts); the AudioContext comes from that click.

export interface Pad {
  /** The chapter's scene state (0–7, data-gl-state): sets the chord and how bright it is. */
  setMood(state: number): void
  /** 1 = playing, 0 = silent; fades either way. Silence suspends the context after the fade. */
  setLevel(level: number): void
}

// Hz, low to high. Neighbouring chords share tones, so the glides stay short.
const CHORDS: number[][] = [
  [110, 164.81, 277.18, 493.88], // 0 the light: A2 E3 C#4 B4
  [110, 155.56, 233.08, 349.23], // 1 noise: A2 D#3 A#3 F4, unsettled
  [146.83, 220, 277.18, 369.99], // 2 the chain: D3 A3 C#4 F#4
  [92.5, 138.59, 220, 329.63], // 3 theses: F#2 C#3 A3 E4
  [82.41, 123.47, 207.65, 311.13], // 4 the diary: E2 B2 G#3 D#4
  [110, 164.81, 220, 277.18], // 5 keep: A2 E3 A3 C#4
  [110, 164.81, 220, 329.63], // 6 release: open fifths
  [110, 164.81, 277.18, 329.63], // 7 sunrise: A2 E3 C#4 E4
]
// Low-pass cutoff per state (Hz): darker in the noise and the quiet chapters, open at sunrise.
const BRIGHTNESS = [1100, 650, 1000, 950, 1000, 900, 700, 1300]
const LEVEL = 0.07
const DETUNE = 1.0023 // the triangle twin of each voice, a few cents sharp: a slow beat

function impulse(context: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3)
  }
  return buffer
}

function lfo(context: AudioContext, hz: number, depth: number, target: AudioParam): void {
  const osc = context.createOscillator()
  const amount = context.createGain()
  osc.frequency.value = hz
  amount.gain.value = depth
  osc.connect(amount).connect(target)
  osc.start()
}

export function startPad(context: AudioContext): Pad {
  const master = context.createGain()
  master.gain.value = 0
  master.connect(context.destination)

  const reverb = context.createConvolver()
  reverb.buffer = impulse(context, 3.5)
  const wet = context.createGain()
  wet.gain.value = 0.6
  const dry = context.createGain()
  dry.gain.value = 0.45
  reverb.connect(wet).connect(master)
  dry.connect(master)

  const filter = context.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = BRIGHTNESS[0]
  filter.Q.value = 0.7
  filter.connect(dry)
  filter.connect(reverb)
  lfo(context, 0.05, 260, filter.frequency) // the pad breathes

  const voices = CHORDS[0].map((hz, i) => {
    const gain = context.createGain()
    gain.gain.value = 0.22
    gain.connect(filter)
    lfo(context, 0.03 + i * 0.013, 0.08, gain.gain) // each voice swells on its own
    const sine = context.createOscillator()
    sine.type = 'sine'
    sine.frequency.value = hz
    const triangle = context.createOscillator()
    triangle.type = 'triangle'
    triangle.frequency.value = hz * DETUNE
    sine.connect(gain)
    triangle.connect(gain)
    sine.start()
    triangle.start()
    return { sine, triangle }
  })

  let suspendTimer = 0
  return {
    setMood(state) {
      const s = Math.min(CHORDS.length - 1, Math.max(0, Math.round(state)))
      const now = context.currentTime
      voices.forEach((voice, i) => {
        voice.sine.frequency.setTargetAtTime(CHORDS[s][i], now, 1.2)
        voice.triangle.frequency.setTargetAtTime(CHORDS[s][i] * DETUNE, now, 1.2)
      })
      filter.frequency.setTargetAtTime(BRIGHTNESS[s], now, 1.5)
    },
    setLevel(level) {
      window.clearTimeout(suspendTimer)
      if (level > 0 && context.state === 'suspended') void context.resume()
      master.gain.setTargetAtTime(level * LEVEL, context.currentTime, 0.6)
      // After the fade (~3 time constants) nothing is audible: stop the audio thread too.
      if (level === 0) suspendTimer = window.setTimeout(() => void context.suspend(), 2500)
    },
  }
}
