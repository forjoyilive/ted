const maxReposSection = 2000

export function reposSection(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined
  const lines = notes.split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s+Repos\s*$/i.test(line.trim()))
  if (start === -1) return undefined
  const level = lines[start]?.trim().match(/^#+/)?.[0].length ?? 1
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const heading = line.trim().match(/^(#{1,6})\s/)
    if (heading?.[1] !== undefined && heading[1].length <= level) break
    body.push(line)
  }
  const text = body.join('\n').trim()
  if (text === '') return undefined
  return text.length > maxReposSection ? `${text.slice(0, maxReposSection - 1)}…` : text
}
