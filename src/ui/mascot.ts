import layers from './mascot-layers.json'

interface Layer {
  tag: string
  className: string
  src?: string
  children?: Layer[]
}

// Static Figma geometry, assembled as DOM so the illustration has no frame background.
// The SVG files themselves are unmodified; no SVG paths or colors are generated here.
function createLayer(layer: Layer): HTMLElement {
  const element = document.createElement(layer.tag)
  element.className = layer.className
  if (element instanceof HTMLImageElement && layer.src) {
    element.src = layer.src
    element.alt = ''
    element.draggable = false
  }
  for (const child of layer.children ?? []) element.append(createLayer(child))
  return element
}

export function initMascots(): void {
  for (const slot of document.querySelectorAll<HTMLElement>('[data-mascot]')) {
    slot.classList.add('mascot')
    for (const theme of ['light', 'dark'] as const) {
      const art = document.createElement('div')
      art.className = `mascot__art mascot__art--${theme}`
      art.setAttribute('aria-hidden', 'true')
      art.append(createLayer(layers[theme]))
      slot.append(art)
    }
  }
}
