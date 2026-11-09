import type { ArmAction } from './armed.ts'

export type Direction = 'next' | 'previous' | 'left' | 'right'

function visible(element: Element): boolean {
  return element instanceof HTMLElement && element.offsetParent !== null
}

function all(scope: ParentNode, selector: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(selector)].filter(visible)
}

function show(element: HTMLElement) {
  element.focus()
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function current(items: readonly HTMLElement[]): HTMLElement | undefined {
  const active = document.activeElement?.closest<HTMLElement>('[data-nav-item]')
  if (active && items.includes(active)) return active
  return items.find(
    (item) =>
      item.getAttribute('aria-current') === 'true' || item.getAttribute('aria-selected') === 'true',
  )
}

function columnOf(item: HTMLElement): HTMLElement | undefined {
  return item.closest<HTMLElement>('[data-nav-column]') ?? undefined
}

export function moveFocus(scope: ParentNode, direction: Direction): boolean {
  const items = all(scope, '[data-nav-item]')
  if (items.length === 0) return false
  const at = current(items)
  if (direction === 'next' || direction === 'previous') {
    if (!at) {
      const first = direction === 'next' ? items[0] : items.at(-1)
      if (first) show(first)
      return first !== undefined
    }
    const column = columnOf(at)
    const peers = column ? items.filter((item) => columnOf(item) === column) : items
    const next = peers[peers.indexOf(at) + (direction === 'next' ? 1 : -1)]
    if (next) show(next)
    return true
  }
  const columns = all(scope, '[data-nav-column]')
  if (columns.length === 0) return false
  const from = at ? columnOf(at) : undefined
  const index = from ? columns.indexOf(from) : -1
  const row = at && from ? all(from, '[data-nav-item]').indexOf(at) : 0
  const step = direction === 'right' ? 1 : -1
  for (let i = index + step; i >= 0 && i < columns.length; i += step) {
    const column = columns[i]
    const cards = column ? all(column, '[data-nav-item]') : []
    const target = cards[Math.min(row, cards.length - 1)]
    if (target) {
      show(target)
      return true
    }
  }
  return at !== undefined
}

export function focusedTaskRef(): string | undefined {
  const item = document.activeElement?.closest<HTMLElement>('[data-nav-item][data-task]')
  return item?.dataset.task
}

export function rankNeighbours(): { ref: string; order: string[] } | undefined {
  const item = document.activeElement?.closest<HTMLElement>('[data-nav-item][data-task]')
  if (!item?.dataset.task || !item.closest('[data-rank-order]')) return undefined
  const group = item.closest('[data-nav-column], tbody')
  if (!group) return undefined
  const order = all(group, '[data-nav-item][data-task]').flatMap((el) => el.dataset.task ?? [])
  return { ref: item.dataset.task, order }
}

export function focusFirst(scope: ParentNode, selector: string): boolean {
  const target = all(scope, selector)[0]
  if (!target) return false
  show(target)
  return true
}

export function armable(scope: ParentNode, action: ArmAction): HTMLButtonElement | undefined {
  return all(scope, `button[data-arm="${action}"]`).find(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement && !button.disabled,
  )
}

export function requestChangesBox(scope: ParentNode): HTMLElement | undefined {
  const button = all(scope, 'button[data-request-changes]')[0]
  const card = button?.closest('section')
  return card ? (all(card, 'textarea[data-answer-box]')[0] ?? undefined) : undefined
}

export function pressDialogPrimary(): boolean {
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1)
  if (!dialog) return false
  const primary = all(dialog, 'button[data-primary]')
    .filter((b): b is HTMLButtonElement => b instanceof HTMLButtonElement && !b.disabled)
    .at(-1)
  if (!primary) return false
  primary.click()
  return true
}
