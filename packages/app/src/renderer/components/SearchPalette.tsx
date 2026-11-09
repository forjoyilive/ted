import type {
  CommentHit,
  Factory,
  FactoryHit,
  SearchField,
  SearchResults,
  TaskHit,
} from '@ted/protocol'
import { matchesTerms, searchTerms } from '@ted/protocol/search'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { availableCommands, type Command, type CommandContext } from '../commands.ts'
import { stageName } from '../list-view.ts'
import { ago } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { factoryName } from '../views/TaskViews.tsx'
import { SearchIcon } from './icons.tsx'
import styles from './SearchPalette.module.css'

interface Item {
  key: string
  group: string
  label: string
  content: ReactNode
  run: () => unknown
}

interface SearchPaletteProps {
  context: CommandContext
  factoryId: string | undefined
  onOpenTask: (taskId: string, factoryId: string) => void
  onOpenFactory: (factoryId: string) => void
  onClose: () => void
}

const fieldNotes: Record<SearchField, string | undefined> = {
  id: undefined,
  title: undefined,
  description: 'in description',
  'original-request': 'in Original request',
  brief: 'in brief',
}

const debounceMs = 80

function commandMatches(command: Command, terms: readonly string[]): boolean {
  return matchesTerms(terms, `${command.label} ${command.keywords ?? ''}`)
}

function Shortcut({ keys }: { keys: readonly string[] | undefined }) {
  if (!keys || keys.length === 0) return null
  return <span className={styles.shortcut}>{keys.join(' or ')}</span>
}

function StateChip({ state }: { state: TaskHit['state'] }) {
  if (state === 'open') return null
  return <span className={styles.chip}>{state === 'done' ? 'Done' : 'Archived'}</span>
}

function taskContent(hit: TaskHit, factories: readonly Factory[]) {
  const meta = [factoryName(factories, hit.factoryId)]
  if (hit.state === 'open') meta.push(stageName(hit.stage))
  const note = fieldNotes[hit.field]
  if (note !== undefined) meta.push(note)
  return (
    <>
      <span className={styles.ref}>{hit.displayId}</span>
      <span className={styles.main}>
        <span className={styles.title}>{hit.title}</span>
        {hit.snippet !== undefined && <span className={styles.snippet}>{hit.snippet}</span>}
      </span>
      <span className={styles.meta}>
        <StateChip state={hit.state} />
        {meta.join(' · ')}
      </span>
    </>
  )
}

function commentAuthor(hit: CommentHit): string {
  if (hit.author.kind === 'human') return 'You'
  if (hit.author.kind === 'ted') return 'TED'
  return hit.leadAuthor ? 'Task Lead' : 'Sub-agent'
}

function commentContent(hit: CommentHit, now: number) {
  return (
    <>
      <span className={styles.ref}>{hit.displayId}</span>
      <span className={styles.main}>
        <span className={styles.quote}>{`“${hit.snippet}”`}</span>
        <span className={styles.byline}>
          {`${commentAuthor(hit)} · ${hit.taskTitle} · ${ago(hit.createdAt, now)}`}
        </span>
      </span>
      <span className={styles.meta}>
        <StateChip state={hit.state} />
      </span>
    </>
  )
}

function factoryContent(hit: FactoryHit) {
  return (
    <>
      <span className={styles.ref}>Factory</span>
      <span className={styles.main}>
        <span className={styles.title}>{hit.name}</span>
      </span>
    </>
  )
}

function commandContent(command: Command, task: CommandContext['task']) {
  return (
    <>
      <span className={styles.main}>
        <span className={styles.title}>{command.label}</span>
      </span>
      <span className={styles.meta}>
        {command.scope === 'task' && task && <span>{task.displayId}</span>}
        <Shortcut keys={command.shortcuts} />
      </span>
    </>
  )
}

export function SearchPalette({
  context,
  factoryId,
  onOpenTask,
  onOpenFactory,
  onClose,
}: SearchPaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults>()
  const [selected, setSelected] = useState(0)
  const [choosing, setChoosing] = useState<Command>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const now = Date.now()

  useEffect(() => {
    dialog.current?.showModal()
    input.current?.focus()
  }, [])

  useEffect(() => {
    if (choosing || query.trim() === '') return
    let current = true
    const timer = setTimeout(() => {
      ted.search(query, factoryId).then(
        (found) => {
          if (current) setResults(found)
        },
        (failure: unknown) => {
          if (current) setError(readableError(failure))
        },
      )
    }, debounceMs)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, factoryId, choosing])

  const terms = searchTerms(query)
  const items: Item[] = []
  if (choosing) {
    for (const choice of choosing.choices?.(context) ?? []) {
      if (terms.length > 0 && !matchesTerms(terms, choice.label)) continue
      items.push({
        key: `choice:${choice.id}`,
        group: choosing.label.replace(/…$/, ''),
        label: choice.label,
        content: (
          <>
            <span className={styles.tick} aria-hidden>
              {choice.checked ? '✓' : ''}
            </span>
            <span className={styles.main}>
              <span className={styles.title}>{choice.label}</span>
            </span>
          </>
        ),
        run: choice.run,
      })
    }
  } else {
    const commands = availableCommands(context).filter(
      (command) => terms.length === 0 || commandMatches(command, terms),
    )
    for (const command of commands) {
      items.push({
        key: `command:${command.id}`,
        group: 'Commands',
        label: command.label,
        content: commandContent(command, context.task),
        run: () => {
          if (command.choices) {
            setChoosing(command)
            setQuery('')
            setSelected(0)
            return 'stay'
          }
          return command.run?.(context)
        },
      })
    }
    const found = terms.length > 0 && results?.query === query ? results : undefined
    for (const hit of found?.tasks ?? []) {
      items.push({
        key: `task:${hit.taskId}`,
        group: 'Tasks',
        label: `${hit.displayId} ${hit.title}`,
        content: taskContent(hit, context.factories),
        run: () => onOpenTask(hit.taskId, hit.factoryId),
      })
    }
    for (const hit of found?.comments ?? []) {
      items.push({
        key: `comment:${hit.commentId}`,
        group: 'Comments',
        label: `${hit.displayId} ${hit.snippet}`,
        content: commentContent(hit, now),
        run: () => onOpenTask(hit.taskId, hit.factoryId),
      })
    }
    for (const hit of found?.factories ?? []) {
      items.push({
        key: `factory:${hit.factoryId}`,
        group: 'Factories',
        label: hit.name,
        content: factoryContent(hit),
        run: () => onOpenFactory(hit.factoryId),
      })
    }
  }

  const searched = results !== undefined && results.query === query
  const nothing = !choosing && terms.length > 0 && searched && items.length === 0
  if (nothing) {
    const text = query.trim()
    items.push({
      key: 'create-task',
      group: '',
      label: `Create Task “${text}”`,
      content: (
        <>
          <span className={styles.plus} aria-hidden>
            +
          </span>
          <span className={styles.main}>
            <span className={styles.title}>{`Create Task “${text}”`}</span>
          </span>
        </>
      ),
      run: () => context.newTask(text),
    })
  }

  const active = Math.min(selected, Math.max(0, items.length - 1))
  const optionId = (index: number) => `${listId}-${index}`

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listId])

  async function choose(item: Item | undefined) {
    if (!item || busy) return
    setError(undefined)
    try {
      setBusy(true)
      const outcome = await item.run()
      if (outcome !== 'stay') onClose()
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault()
      setSelected((active + 1) % Math.max(1, items.length))
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault()
      setSelected((active - 1 + items.length) % Math.max(1, items.length))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void choose(items[active])
    } else if (event.key === 'Backspace' && query === '' && choosing) {
      event.preventDefault()
      setChoosing(undefined)
      setSelected(0)
    }
  }

  const groups: { name: string; items: { item: Item; index: number }[] }[] = []
  items.forEach((item, index) => {
    const last = groups.at(-1)
    if (last && last.name === item.group) last.items.push({ item, index })
    else groups.push({ name: item.group, items: [{ item, index }] })
  })

  return (
    <dialog
      ref={dialog}
      className={styles.palette}
      aria-label="Search and commands"
      onCancel={(event) => {
        event.preventDefault()
        if (choosing) {
          setChoosing(undefined)
          setQuery('')
          setSelected(0)
        } else onClose()
      }}
      onMouseDown={(event) => {
        if (event.target === dialog.current) onClose()
      }}
    >
      <div className={styles.inputRow}>
        <SearchIcon className={styles.icon} />
        {choosing && <span className={styles.crumb}>{choosing.label.replace(/…$/, '')}</span>}
        <input
          ref={input}
          className={styles.input}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length > 0 ? optionId(active) : undefined}
          aria-label={choosing ? choosing.label : 'Search or run a command'}
          placeholder={choosing ? 'Choose…' : 'Search Tasks, Comments and commands'}
          value={query}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
            setError(undefined)
          }}
          onKeyDown={onKeyDown}
        />
        {!choosing && <span className={styles.scope}>All Factories</span>}
      </div>
      {nothing && <p className={styles.none}>{`No results for ‘${query.trim()}’`}</p>}
      {choosing && items.length === 0 && <p className={styles.none}>No matches</p>}
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div id={listId} role="listbox" aria-label="Results" className={styles.list}>
        {groups.map((group) => {
          const options = group.items.map(({ item, index }) => (
            <button
              type="button"
              tabIndex={-1}
              key={item.key}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              aria-label={item.label}
              className={styles.option}
              onMouseMove={() => index !== active && setSelected(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void choose(item)}
            >
              {item.content}
              {index === active && (
                <span className={styles.enter} aria-hidden>
                  ↵
                </span>
              )}
            </button>
          ))
          if (group.name === '') return options
          return (
            <fieldset key={group.name} aria-label={group.name} className={styles.group}>
              <div className={styles.groupLabel} aria-hidden>
                {group.name}
              </div>
              {options}
            </fieldset>
          )
        })}
      </div>
      <footer className={styles.footer}>
        <span>↑↓ Move</span>
        <span>↵ Open</span>
        <span>esc Close</span>
      </footer>
    </dialog>
  )
}
