import { maxShellInputChars, type TaskShell as Shell, type ShellSize } from '@ted/protocol/shell'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { type ITheme, Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useConnection, useSettings } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import findStyles from './FindBar.module.css'
import styles from './TaskShell.module.css'

const pollWaitMs = 20_000
const retryMs = 1_000
const worktreeGone = /has no worktree|worktree for .* isn’t on disk/

function hex(colour: string): string {
  const parts = /(\d+)\D+(\d+)\D+(\d+)/.exec(colour)
  if (!parts) return colour
  const byte = (text: string | undefined) => Number(text).toString(16).padStart(2, '0')
  return `#${byte(parts[1])}${byte(parts[2])}${byte(parts[3])}`
}

function probe(host: HTMLElement, className: string | undefined): string {
  const element = document.createElement('span')
  element.className = className ?? ''
  host.append(element)
  const colour = hex(getComputedStyle(element).color)
  element.remove()
  return colour
}

function terminalTheme(host: HTMLElement): ITheme {
  const background = hex(getComputedStyle(host).backgroundColor)
  const foreground = hex(getComputedStyle(host).color)
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: probe(host, styles.selection),
  }
}

function searchOptions(host: HTMLElement | null) {
  const match = host ? probe(host, styles.match) : ''
  const active = host ? probe(host, styles.activeMatch) : ''
  return {
    decorations: {
      matchBackground: match,
      matchOverviewRuler: match,
      activeMatchBackground: active,
      activeMatchColorOverviewRuler: active,
    },
  }
}

function adoptInlineStyles(host: HTMLElement): () => void {
  const sheet = new CSSStyleSheet()
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  let last = ''
  const copy = () => {
    const text = [...host.querySelectorAll('style')].map((s) => s.textContent).join('\n')
    if (text === last) return
    last = text
    sheet.replaceSync(text)
  }
  const watcher = new MutationObserver(copy)
  watcher.observe(host, { childList: true, subtree: true, characterData: true })
  copy()
  return () => {
    watcher.disconnect()
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet)
  }
}

function sizeOf(terminal: Terminal): ShellSize {
  return { cols: Math.max(terminal.cols, 2), rows: Math.max(terminal.rows, 2) }
}

export function TaskShellPane({
  taskId,
  repo,
  shell: initialShell,
  number,
  active,
  canSplit,
  onFocus,
  onSplit,
  onClose,
  onRestart,
  onMissing,
}: {
  taskId: string
  repo: string
  shell: Shell
  number: number
  active: boolean
  canSplit: boolean
  onFocus: () => void
  onSplit: (direction: 'right' | 'below') => void
  onClose: () => void
  onRestart: () => void
  onMissing: () => void
}) {
  const settings = useSettings()
  const { epoch } = useConnection()
  const fontSize = settings?.terminalFontSize ?? 13
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const host = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(undefined)
  const fitRef = useRef<FitAddon>(undefined)
  const searchRef = useRef<SearchAddon>(undefined)
  const [ended, setEnded] = useState<{ exitCode?: number }>()
  const [problem, setProblem] = useState<string>()
  const [gone, setGone] = useState(false)
  const [finding, setFinding] = useState(false)
  const missingRef = useRef(onMissing)
  missingRef.current = onMissing
  const shellId = initialShell.id
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    void epoch
    const element = host.current
    if (!element) return
    const terminal = new Terminal({
      fontFamily: getComputedStyle(element).fontFamily,
      fontSize: fontSizeRef.current,
      theme: terminalTheme(element),
      scrollback: 10_000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    const unadopt = adoptInlineStyles(element)
    terminal.open(element)
    const updateTheme = () => {
      terminal.options.theme = terminalTheme(element)
    }
    const appearance = matchMedia('(prefers-color-scheme: dark)')
    appearance.addEventListener('change', updateTheme)
    const colours = new MutationObserver(updateTheme)
    colours.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    fit.fit()
    terminalRef.current = terminal
    fitRef.current = fit
    searchRef.current = search
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && event.key === 'f') {
        event.preventDefault()
        setFinding(true)
        return false
      }
      return !(event.metaKey && !event.ctrlKey)
    })

    let closed = false
    let generation = 0
    let from = 0
    const sending: string[] = []
    let flushing = false
    const flush = async () => {
      if (flushing) return
      flushing = true
      try {
        while (sending.length > 0 && !closed) {
          let data = ''
          while (
            sending.length > 0 &&
            data.length + (sending[0]?.length ?? 0) <= maxShellInputChars
          ) {
            data += sending.shift()
          }
          if (data === '') {
            const first = sending.shift() ?? ''
            sending.unshift(first.slice(maxShellInputChars))
            data = first.slice(0, maxShellInputChars)
          }
          await ted.writeShell(taskId, repo, data, shellId).catch((error: unknown) => {
            setProblem(readableError(error))
          })
        }
      } finally {
        flushing = false
      }
    }
    const input = terminal.onData((data) => {
      sending.push(data)
      void flush()
    })
    const resized = terminal.onResize(({ cols, rows }) => {
      void ted.resizeShell(taskId, repo, { cols, rows }, shellId).catch(() => undefined)
    })

    const read = async () => {
      while (!closed) {
        try {
          const out = await ted.readShell(
            taskId,
            repo,
            { generation, from, waitMs: pollWaitMs },
            shellId,
          )
          if (closed) return
          setProblem(undefined)
          if (out.reset || out.generation !== generation) terminal.reset()
          generation = out.generation
          if (out.data !== '') terminal.write(out.data)
          from = out.next
          setEnded(
            out.running
              ? undefined
              : { ...(out.exitCode !== undefined && { exitCode: out.exitCode }) },
          )
          if (!out.running && out.data === '') return
        } catch (error) {
          if (closed) return
          const message = readableError(error)
          if (/^No shell is open/.test(message)) {
            missingRef.current()
            return
          }
          if (worktreeGone.test(message)) {
            setGone(true)
            return
          }
          setProblem(message)
          await new Promise((resolve) => setTimeout(resolve, retryMs))
        }
      }
    }

    setEnded(undefined)
    setProblem(undefined)
    generation = initialShell.generation
    void ted.resizeShell(taskId, repo, sizeOf(terminal), shellId).catch(() => undefined)
    void read()
    if (activeRef.current) terminal.focus()

    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(element)
    return () => {
      closed = true
      observer.disconnect()
      appearance.removeEventListener('change', updateTheme)
      colours.disconnect()
      unadopt()
      input.dispose()
      resized.dispose()
      terminal.dispose()
      terminalRef.current = undefined
    }
  }, [taskId, repo, shellId, initialShell.generation, epoch])

  useEffect(() => {
    if (active) terminalRef.current?.focus()
  }, [active])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
    fitRef.current?.fit()
  }, [fontSize])

  return (
    <section
      className={`${styles.shellPane} ${active ? styles.focused : ''}`}
      aria-label={`Shell ${number}`}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
    >
      <header className={styles.paneHeader}>
        <strong className={styles.paneTitle}>Shell {number}</strong>
        <Button
          size="small"
          onClick={() => onSplit('right')}
          disabled={!canSplit || gone}
          title={
            canSplit
              ? 'Start a new shell to the right'
              : 'Up to 8 panes per repo. Close one to split again.'
          }
        >
          Split right
        </Button>
        <Button
          size="small"
          onClick={() => onSplit('below')}
          disabled={!canSplit || gone}
          title={
            canSplit
              ? 'Start a new shell below'
              : 'Up to 8 panes per repo. Close one to split again.'
          }
        >
          Split below
        </Button>
        <Button size="small" onClick={() => setFinding(true)}>
          Find
        </Button>
        <Button size="small" onClick={onRestart} disabled={gone}>
          Restart shell
        </Button>
        <Button size="small" onClick={onClose} aria-label={`Close Shell ${number}`}>
          ×
        </Button>
      </header>
      {(problem !== undefined || ended || gone) && (
        <p className={styles.notice} role="status">
          {gone
            ? 'The worktree was removed, so its shell ended.'
            : (problem ??
              (ended?.exitCode === undefined
                ? 'The shell ended.'
                : `The shell ended with code ${ended.exitCode}.`))}
        </p>
      )}
      <div className={styles.body} onKeyDownCapture={stopFind(finding, setFinding)}>
        {finding && (
          <ShellFind
            search={searchRef.current}
            host={host.current}
            onClose={() => {
              setFinding(false)
              terminalRef.current?.focus()
            }}
          />
        )}
        <div ref={host} className={styles.terminal} data-find-skip />
      </div>
    </section>
  )
}

function stopFind(finding: boolean, setFinding: (on: boolean) => void) {
  return (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      if (!finding) setFinding(true)
    }
  }
}

function ShellFind({
  search,
  host,
  onClose,
}: {
  search: SearchAddon | undefined
  host: HTMLElement | null
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number }>()

  useEffect(() => {
    input.current?.focus()
    const changed = search?.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    )
    return () => {
      changed?.dispose()
      search?.clearDecorations()
    }
  }, [search])

  const options = searchOptions(host)

  const step = (by: 1 | -1) => {
    if (query === '') return
    if (by === 1) search?.findNext(query, options)
    else search?.findPrevious(query, options)
  }

  const count =
    query === ''
      ? ''
      : !results || results.count === 0
        ? 'No matches'
        : `${results.index + 1} of ${results.count}`

  return (
    <search className={`${findStyles.bar} ${styles.find}`} aria-label="Find in shell">
      <input
        ref={input}
        className={findStyles.input}
        type="text"
        aria-label="Find"
        placeholder="Find"
        value={query}
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value)
          if (event.target.value === '') {
            search?.clearDecorations()
            setResults(undefined)
          } else search?.findNext(event.target.value, { ...options, incremental: true })
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className={findStyles.count} aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className={findStyles.button}
        aria-label="Previous match"
        disabled={!results?.count}
        onClick={() => step(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className={findStyles.button}
        aria-label="Next match"
        disabled={!results?.count}
        onClick={() => step(1)}
      >
        ↓
      </button>
      <button type="button" className={findStyles.button} aria-label="Close find" onClick={onClose}>
        ×
      </button>
    </search>
  )
}
