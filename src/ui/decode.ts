// Mono labels "decode" into place once, when they come into view: random glyphs settle into the
// real text from left to right. Screen readers get the real text from a visually hidden copy; the
// animated parts are aria-hidden, so nobody hears the noise. Skipped entirely when motion is off.
// Calm noise: only letters flicker, and only into Cyrillic letters. Digits (chapter numbers),
// spaces and punctuation stay put.

import { motionAllowed } from './motion'

const GLYPHS = 'АБВГДЕЄЖЗИІЇКЛМНОПРСТУФХЦЧШЮЯ'
const LETTER = /\p{L}/u // no g flag: test() keeps no state between calls
const DURATION_MS = 900
const STEP_MS = 45

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
}

function textNodes(root: Node): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.data.trim()) nodes.push(node)
  }
  return nodes
}

/** Animates text nodes from noise to their final strings. Resolves when done. */
function play(nodes: Text[], finals: string[]): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now()
    let lastStep = 0
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - start) / DURATION_MS)
      if (now - lastStep >= STEP_MS || progress === 1) {
        lastStep = now
        nodes.forEach((node, index) => {
          const final = finals[index]
          const settled = Math.floor(progress * final.length * 1.15)
          let out = ''
          for (let i = 0; i < final.length; i++) {
            const char = final[i]
            out += i < settled || !LETTER.test(char) ? char : randomGlyph()
          }
          node.data = out
        })
      }
      if (progress < 1) requestAnimationFrame(tick)
      else {
        nodes.forEach((node, index) => (node.data = finals[index]))
        resolve()
      }
    }
    requestAnimationFrame(tick)
  })
}

// Splits a label into an aria-hidden visual part and a visually hidden spoken copy.
// Layout does not change: text runs were anonymous flex items already, and the absolutely
// positioned copy takes no part in flex layout.
function prepare(element: HTMLElement): Text[] {
  const spokenText = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!child.textContent?.trim()) continue
      const wrapper = document.createElement('span')
      wrapper.setAttribute('aria-hidden', 'true')
      child.replaceWith(wrapper)
      wrapper.append(child)
    } else if (child instanceof HTMLElement) {
      child.setAttribute('aria-hidden', 'true')
    }
  }
  const spoken = document.createElement('span')
  spoken.className = 'visually-hidden'
  spoken.textContent = spokenText
  const nodes = textNodes(element)
  element.append(spoken)
  return nodes
}

export function initDecode(): void {
  if (!motionAllowed() || !('IntersectionObserver' in window)) return
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-decode]'))
  if (items.length === 0) return

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer.unobserve(entry.target)
        if (!motionAllowed()) continue
        const nodes = prepare(entry.target as HTMLElement)
        void play(
          nodes,
          nodes.map((node) => node.data),
        )
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.6 },
  )
  for (const item of items) observer.observe(item)
}

/** Replaces an aria-hidden label's text with a short decode (used by the chapter HUD). */
export function decodeTo(element: HTMLElement, text: string): void {
  if (!motionAllowed()) {
    element.textContent = text
    return
  }
  element.textContent = text
  const node = element.firstChild
  if (node instanceof Text) void play([node], [text])
}
