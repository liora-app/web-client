// Country name for `llm_provider.country` on the consent screen (spec §3.5).
//
// Intl is passed in, so the core keeps no locale state of its own:
//   countryName('US', new Intl.DisplayNames(['uk'], { type: 'region' }))
// The map comes first because Intl says «Сполучені Штати», while the landing says «США».

export type RegionNames = Readonly<{ of(code: string): string | undefined }>

const KNOWN: Readonly<Record<string, string>> = Object.freeze({ US: 'США' })

export function countryName(code: string, names: RegionNames | null): string {
  const key = code.trim().toUpperCase()
  if (key === '') return code
  const known = KNOWN[key]
  if (known !== undefined) return known
  if (names !== null) {
    try {
      const name = names.of(key)
      if (typeof name === 'string' && name.trim() !== '') return name
    } catch {
      // A malformed code makes Intl.DisplayNames throw a RangeError: fall back to the code.
    }
  }
  return key
}
