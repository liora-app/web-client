// Pointer position in normalized device coordinates (-1..1, y up), for fine pointers only.
// Touch input scrolls the page, so the scene does not react to it.

export class PointerTracker {
  readonly target = { x: 0, y: 0 }
  active = false
  private readonly enabled = window.matchMedia('(hover: hover) and (pointer: fine)').matches

  private readonly onMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    this.target.x = (event.clientX / window.innerWidth) * 2 - 1
    this.target.y = -((event.clientY / window.innerHeight) * 2 - 1)
    this.active = true
  }

  private readonly onLeave = (): void => {
    this.active = false
  }

  constructor() {
    if (!this.enabled) return
    window.addEventListener('pointermove', this.onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', this.onLeave)
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.onMove)
    document.documentElement.removeEventListener('pointerleave', this.onLeave)
  }
}
