export function besideMenu(
  item: { top: number },
  menu: { left: number; right: number },
  tip: { width: number; height: number },
  window: { width: number; height: number },
  gap = 10,
  margin = 8,
) {
  const before = menu.left - gap - tip.width
  const after = menu.right + gap
  const left =
    before >= margin || after + tip.width > window.width - margin ? Math.max(margin, before) : after
  const top = Math.max(margin, Math.min(item.top, window.height - tip.height - margin))
  return { left, top }
}

export function besideAnchor(
  anchor: { top: number; bottom: number; left: number; right: number },
  tip: { width: number; height: number },
  window: { width: number; height: number },
  align: 'start' | 'end' = 'start',
  gap = 6,
  margin = 8,
) {
  const below = anchor.bottom + gap
  const roomBelow = window.height - margin - below
  const roomAbove = anchor.top - gap - margin
  const side =
    tip.height <= roomBelow || roomBelow >= roomAbove ? below : anchor.top - gap - tip.height
  const top = Math.max(margin, Math.min(side, window.height - tip.height - margin))
  const wanted = align === 'end' ? anchor.right - tip.width : anchor.left - 10
  const left = Math.max(margin, Math.min(wanted, window.width - tip.width - margin))
  return { left, top }
}
