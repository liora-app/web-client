// Small DOM helpers for the chat screens. Text goes in only through textContent (spec I8);
// markup comes only from chat/index.html and its <template>s.

export function byEl<T extends HTMLElement = HTMLElement>(name: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(`[data-el="${name}"]`)
  if (!found) throw new Error(`[liora] missing [data-el="${name}"]`)
  return found
}

export function allEl<T extends HTMLElement = HTMLElement>(name: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(`[data-el="${name}"]`))
}

export function screenOf(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-screen="${name}"]`)
  if (!found) throw new Error(`[liora] missing [data-screen="${name}"]`)
  return found
}

/** A fresh copy of a <template data-tpl="…">'s first element. */
export function fromTemplate<T extends HTMLElement = HTMLElement>(name: string): T {
  const tpl = document.querySelector<HTMLTemplateElement>(`template[data-tpl="${name}"]`)
  const first = tpl?.content.firstElementChild
  if (!first) throw new Error(`[liora] missing template ${name}`)
  return first.cloneNode(true) as T
}

export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

export function show(node: HTMLElement, visible: boolean): void {
  if (node.hidden === visible) node.hidden = !visible
}

export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name)
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value)
  }
}

/** The h1 of a screen that is actually shown (a screen may hold one per variant). */
export function headingOf(section: HTMLElement): HTMLElement | null {
  for (const h of Array.from(section.querySelectorAll<HTMLElement>('h1'))) {
    if (h.closest('[hidden]') === null) return h
  }
  return null
}

export const finePointer = (): boolean => window.matchMedia('(pointer: fine)').matches
