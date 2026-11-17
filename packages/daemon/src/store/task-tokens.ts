export interface TokenRun {
  id: string
  state: string
}

export interface SavedUse {
  id: string
  input: number
  output: number
}

export function taskTokens(
  runs: readonly TokenRun[],
  saved: readonly SavedUse[],
  live: ReadonlyMap<string, number>,
): number {
  const savedTokens = new Map(saved.map((use) => [use.id, use.input + use.output]))
  let total = 0
  for (const run of runs) {
    const kept = savedTokens.get(run.id)
    const now = live.get(run.id)
    total += (run.state === 'finished' ? (kept ?? now) : (now ?? kept)) ?? 0
  }
  return total
}
