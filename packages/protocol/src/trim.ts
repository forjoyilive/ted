export function trimEndOf(text: string, characters: string): string {
  let end = text.length
  while (end > 0 && characters.includes(text.charAt(end - 1))) end -= 1
  return text.slice(0, end)
}

export function trimOf(text: string, characters: string): string {
  let start = 0
  while (start < text.length && characters.includes(text.charAt(start))) start += 1
  return trimEndOf(text.slice(start), characters)
}

export const urlTrailingPunctuation = '.,;:!?'
