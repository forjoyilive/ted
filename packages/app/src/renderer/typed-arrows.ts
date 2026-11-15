const arrows: readonly (readonly [typed: string, arrow: string])[] = [
  ['<=>', '<=>'],
  ['←>', '↔'],
  ['⇐>', '<=>'],
  ['->', '→'],
  ['<-', '←'],
  ['=>', '⇒'],
  ['<=', '⇐'],
]

export type ArrowSwap = { start: number; end: number; arrow: string }

function insideCode(before: string): boolean {
  const fences = before.split('```').length - 1
  if (fences % 2 === 1) return true
  const fence = before.lastIndexOf('```')
  const afterFence = fence < 0 ? before : before.slice(fence + 3)
  const line = afterFence.slice(afterFence.lastIndexOf('\n') + 1)
  return (line.split('`').length - 1) % 2 === 1
}

export function arrowAt(text: string, caret: number): ArrowSwap | null {
  const before = text.slice(0, caret)
  for (const [typed, arrow] of arrows) {
    if (!before.endsWith(typed)) continue
    if (typed === arrow) return null
    if (insideCode(before.slice(0, -typed.length))) return null
    return { start: caret - typed.length, end: caret, arrow }
  }
  return null
}

function swapsArrows(target: EventTarget | null): target is HTMLTextAreaElement | HTMLInputElement {
  if (target instanceof HTMLTextAreaElement) return target.closest('.xterm') === null
  return target instanceof HTMLInputElement && target.hasAttribute('data-arrows')
}

export function watchTypedArrows(root: Document): void {
  root.addEventListener(
    'input',
    (event) => {
      if (!(event instanceof InputEvent) || event.inputType !== 'insertText') return
      const box = event.target
      if (!swapsArrows(box)) return
      const caret = box.selectionStart
      if (caret === null || caret !== box.selectionEnd) return
      const swap = arrowAt(box.value, caret)
      if (!swap) return
      box.setSelectionRange(swap.start, swap.end)
      // execCommand puts the swap in the browser's undo history, so ⌘Z brings back the typed characters.
      root.execCommand('insertText', false, swap.arrow)
    },
    true,
  )
}
