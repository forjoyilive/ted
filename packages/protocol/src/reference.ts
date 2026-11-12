export const shortReference = (id: string): string => id.slice(0, 6)

export function matchReference(
  reference: string,
  ids: readonly string[],
): { kind: 'found'; id: string } | { kind: 'missing' } | { kind: 'ambiguous' } {
  if (ids.includes(reference)) return { kind: 'found', id: reference }
  if (reference.length < 6) return { kind: 'missing' }
  const matches = [...new Set(ids.filter((id) => id.startsWith(reference)))]
  if (matches.length > 1) return { kind: 'ambiguous' }
  const id = matches[0]
  return id === undefined ? { kind: 'missing' } : { kind: 'found', id }
}
