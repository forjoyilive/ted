export function titleFromText(text: string): { title: string; description: string } {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() !== '')
  if (at === -1) return { title: '', description: text.trim() }
  return {
    title: lines[at]?.trim() ?? '',
    description: lines
      .slice(at + 1)
      .join('\n')
      .trim(),
  }
}
