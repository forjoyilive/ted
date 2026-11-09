import { foldText } from '@ted/protocol/search'
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react'
import styles from './FindBar.module.css'

const allName = 'ted-find'
const currentName = 'ted-find-current'

function textNodes(root: Element): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest('[data-find-skip]')) return NodeFilter.FILTER_REJECT
      if (parent.closest('[hidden], script, style')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

export function findRanges(root: Element, query: string): Range[] {
  const needle = foldText(query)
  if (needle.trim() === '') return []
  const ranges: Range[] = []
  for (const node of textNodes(root)) {
    const text = node.data
    if (foldText(text).length !== text.length) {
      let at = text.toLowerCase().indexOf(query.toLowerCase())
      while (at >= 0) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + query.length)
        ranges.push(range)
        at = text.toLowerCase().indexOf(query.toLowerCase(), at + query.length)
      }
      continue
    }
    const folded = foldText(text)
    let at = folded.indexOf(needle)
    while (at >= 0) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
      at = folded.indexOf(needle, at + needle.length)
    }
  }
  return ranges.filter((range) => range.getClientRects().length > 0)
}

function clearHighlights() {
  CSS.highlights.delete(allName)
  CSS.highlights.delete(currentName)
}

export function FindBar({
  scope,
  onClose,
}: {
  scope: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    input.current?.focus()
    return clearHighlights
  }, [])

  useEffect(() => {
    const root = scope.current
    const found = root ? findRanges(root, query) : []
    setRanges(found)
    setCurrent(0)
  }, [query, scope])

  useEffect(() => {
    clearHighlights()
    if (ranges.length === 0) return
    CSS.highlights.set(allName, new Highlight(...ranges))
    const range = ranges[current]
    if (!range) return
    CSS.highlights.set(currentName, new Highlight(range))
    const element = range.startContainer.parentElement
    element?.scrollIntoView({ block: 'nearest' })
  }, [ranges, current])

  function step(by: number) {
    const root = scope.current
    const found = root ? findRanges(root, query) : []
    if (found.length !== ranges.length) {
      setRanges(found)
      setCurrent(0)
      return
    }
    if (found.length > 0) setCurrent((current + by + found.length) % found.length)
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    }
  }

  const count =
    query.trim() === ''
      ? ''
      : ranges.length === 0
        ? 'No matches'
        : `${current + 1} of ${ranges.length}`

  return (
    <search className={styles.bar} aria-label="Find in pane" data-find-skip>
      <input
        ref={input}
        className={styles.input}
        type="text"
        aria-label="Find"
        placeholder="Find"
        value={query}
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className={styles.count} aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className={styles.button}
        aria-label="Previous match"
        disabled={ranges.length === 0}
        onClick={() => step(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Next match"
        disabled={ranges.length === 0}
        onClick={() => step(1)}
      >
        ↓
      </button>
      <button type="button" className={styles.button} aria-label="Close find" onClick={onClose}>
        ×
      </button>
    </search>
  )
}
