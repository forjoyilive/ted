export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
