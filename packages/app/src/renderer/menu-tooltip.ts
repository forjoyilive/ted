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
