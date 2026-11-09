export function inStage<T extends { createdAt: string }>(
  items: readonly T[],
  entries: readonly { stage: string; at: string }[],
  stage: string | undefined,
): readonly T[] {
  if (stage === undefined) return items
  const spans = entries.flatMap((entry, i) =>
    entry.stage === stage ? [{ from: entry.at, to: entries[i + 1]?.at }] : [],
  )
  return items.filter(({ createdAt }) =>
    spans.some(({ from, to }) => createdAt >= from && (to === undefined || createdAt < to)),
  )
}
