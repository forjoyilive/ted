import type {
  PhoneChatDetailLine,
  PhoneChatFactory,
  PhoneChatItem,
  PhoneChatRow,
  PhoneCommentEntry,
  PhoneReplyBody,
  PhoneRequestSummary,
  PhoneTaskRow,
  PhoneTaskSection,
} from '@ted/protocol'

type Measured =
  | PhoneReplyBody
  | PhoneRequestSummary
  | PhoneTaskRow
  | PhoneTaskSection
  | readonly PhoneTaskSection[]
  | PhoneCommentEntry
  | PhoneChatRow
  | PhoneChatItem
  | PhoneChatDetailLine
  | readonly PhoneChatFactory[]
  | { factories: PhoneChatFactory[]; rows: PhoneChatRow[]; archivedCount: number; cursor: string }
  | { items: PhoneChatItem[]; cursor: string }
  | { lines: PhoneChatDetailLine[]; next: number }
  | string

export interface Fitted {
  text: string
  cut: boolean
}

export function cutChars(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

export function jsonBytes(value: Measured): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function textBytes(text: string): number {
  return jsonBytes(text) - 2
}

export function fitImagePrefix<T extends Measured>(
  total: number,
  room: number,
  withPrefix: (count: number) => T,
): T {
  const full = withPrefix(total)
  if (jsonBytes(full) <= room) return full
  let low = 0
  let high = total
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (jsonBytes(withPrefix(middle)) <= room) low = middle
    else high = middle
  }
  return withPrefix(low)
}

export function fitText(text: string, room: number): Fitted {
  if (textBytes(text) <= room) return { text, cut: false }
  const chars = [...text]
  let low = 0
  let high = chars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textBytes(chars.slice(0, middle).join('')) <= room) low = middle
    else high = middle - 1
  }
  return { text: chars.slice(0, low).join(''), cut: true }
}
