import type { ChatItem } from '@ted/protocol'

export const carryOverLimit = 60_000

function block(item: ChatItem): string | undefined {
  switch (item.kind) {
    case 'human':
      return item.sent ? `The user: ${item.text.trim()}` : undefined
    case 'agent':
      return item.text.trim() === '' ? undefined : `Task Lead: ${item.text.trim()}`
    case 'tool':
      return `Ran: ${item.title.replace(/\s*\n\s*/g, ' ')}`
    case 'ted':
      return `Ted: ${item.title.replace(/\s*\n\s*/g, ' ')}`
    case 'interrupted':
      return '(The turn was interrupted.)'
    default:
      return undefined
  }
}

const marker = (count: number) =>
  count === 0
    ? '[Part of a long message was left out here]'
    : `[${count} ${count === 1 ? 'message' : 'messages'} left out here because the conversation was too long]`

export function conversationText(
  items: readonly ChatItem[],
  limit = carryOverLimit,
): { text: string; cut: boolean; leftOut: number } {
  const blocks = items.flatMap((item) => block(item) ?? [])
  const whole = blocks.join('\n\n')
  if (whole.length <= limit) return { text: whole, cut: false, leftOut: 0 }
  const headBudget = Math.floor(limit / 6)
  const head: string[] = []
  let used = 0
  let headCut = false
  for (const text of blocks) {
    if (used + text.length > headBudget) {
      if (head.length === 0) {
        head.push(`${text.slice(0, headBudget)} …`)
        headCut = true
      }
      break
    }
    head.push(text)
    used += text.length + 2
  }
  const tail: string[] = []
  let tailUsed = 0
  const tailBudget = limit - headBudget
  for (let i = blocks.length - 1; i >= (headCut ? 0 : head.length); i--) {
    const text = blocks[i] as string
    if (headCut && i === 0) {
      if (tail.length === 0)
        tail.unshift(`… ${text.slice(Math.max(headBudget, text.length - tailBudget))}`)
      break
    }
    if (tailUsed + text.length > tailBudget) {
      if (tail.length === 0) tail.unshift(`… ${text.slice(text.length - tailBudget)}`)
      break
    }
    tail.unshift(text)
    tailUsed += text.length + 2
  }
  const kept =
    head.length + tail.length - (headCut && tail.length > 0 && blocks.length === 1 ? 1 : 0)
  const leftOut = Math.max(0, blocks.length - kept)
  return { text: [...head, marker(leftOut), ...tail].join('\n\n'), cut: true, leftOut }
}
