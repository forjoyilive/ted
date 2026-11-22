import type {
  AutomationHit,
  CommentHit,
  ConversationHit,
  Factory,
  FactoryHit,
  PlanHit,
  SearchField,
  SearchResults,
  TaskHit,
  TrackerKind,
} from '@ted/protocol'
import { matchesTerms, searchTerms } from '@ted/protocol/search'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { type Command, type CommandContext, paletteCommands } from '../commands.ts'
import { ago } from '../requests.ts'
import { openSetting } from '../setting-focus.ts'
import { findSettings, platformOf, searchFactory } from '../settings-search.ts'
import type { Stages } from '../stage-names.ts'
import { useStages } from '../stages.tsx'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import { ConversationSearchView } from './ConversationSearchView.tsx'
import { FactoryIcon, FactoryName } from './FactoryIcon.tsx'
import { SearchIcon } from './icons.tsx'
import styles from './SearchPalette.module.css'
import { MatchedName } from './SettingsSearch.tsx'

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
  choose?: Command | undefined
}

const fieldNotes: Record<SearchField, string | undefined> = {
  id: undefined,
  tracker: undefined,
  title: undefined,
  description: 'in description',
  'original-request': 'in Original request',
  brief: 'in brief',
}

const trackerNames: Record<TrackerKind, string> = {
  linear: 'Linear',
  github: 'GitHub',
  sentry: 'Sentry',
}

const debounceMs = 80
const settingsLimit = 8

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

function taskContent(hit: TaskHit, factories: readonly Factory[], stages: Stages) {
  const meta: string[] = []
  if (hit.state === 'open') meta.push(stages.name(hit.stage, hit.factoryId))
  const note = hit.tracker
    ? `${hit.tracker.id} (${trackerNames[hit.tracker.kind]})`
    : fieldNotes[hit.field]
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
        <FactoryName factories={factories} factoryId={hit.factoryId} />
        {meta.length > 0 && <span>{`· ${meta.join(' · ')}`}</span>}
      </span>
    </>
  )
}

function commentAuthor(hit: CommentHit): string {
  if (hit.author.kind === 'human') return 'You'
  if (hit.author.kind === 'ted') return 'Ted'
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

function automationContent(hit: AutomationHit, factories: readonly Factory[]) {
  return (
    <>
      <span className={styles.ref}>Automation</span>
      <span className={styles.main}>
        <span className={styles.title}>{hit.name}</span>
      </span>
      <span className={styles.meta}>
        <FactoryName factories={factories} factoryId={hit.factoryId} />
        {!hit.on && <span>Off</span>}
      </span>
    </>
  )
}

function planContent(hit: PlanHit, factories: readonly Factory[]) {
  return (
    <>
      <span className={styles.ref}>Plan</span>
      <span className={styles.main}>
        <span className={styles.title}>{hit.title}</span>
      </span>
      <span className={styles.meta}>
        <FactoryName factories={factories} factoryId={hit.factoryId} />
        {hit.ended && <span>Ended</span>}
      </span>
    </>
  )
}

function factoryContent(hit: FactoryHit, factories: readonly Factory[]) {
  const factory = factories.find((f) => f.id === hit.factoryId)
  return (
    <>
      <span className={styles.ref}>Factory</span>
      {factory && <FactoryIcon factory={factory} size={16} />}
      <span className={styles.main}>
        <span className={styles.title}>{hit.name}</span>
      </span>
    </>
  )
}

function commandContent(command: Command, task: CommandContext['task']) {
  return (
    <>
      {command.factory && <FactoryIcon factory={command.factory} size={16} />}
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
  choose: chosen,
}: SearchPaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const stages = useStages()
  const [query, setQuery] = useState('')
  const [conversation, setConversation] = useState<ConversationHit>()
  const [results, setResults] = useState<SearchResults>()
  const [conversationResults, setConversationResults] = useState<SearchResults>()
  const [selected, setSelected] = useState(0)
  const [choosing, setChoosing] = useState<Command | undefined>(chosen)
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
      const onError = (failure: unknown) => {
        if (current) setError(readableError(failure))
      }
      ted.search(query, factoryId, 'records').then((found) => {
        if (current) setResults(found)
      }, onError)
      ted.search(query, factoryId, 'conversations').then((found) => {
        if (current) setConversationResults(found)
      }, onError)
    }, debounceMs)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, factoryId, choosing])

  function backToResults() {
    setConversation(undefined)
    requestAnimationFrame(() => input.current?.focus())
  }

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
            {choice.factory && <FactoryIcon factory={choice.factory} size={16} />}
            <span className={styles.main}>
              <span className={styles.title}>{choice.label}</span>
            </span>
            <span className={styles.meta}>
              <Shortcut keys={choice.shortcut === undefined ? undefined : [choice.shortcut]} />
            </span>
          </>
        ),
        run: choice.run,
      })
    }
  } else {
    const commands = paletteCommands(context).filter(
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
    for (const hit of findSettings(query, {
      factory: searchFactory(context.factories, factoryId),
      platform: platformOf(navigator.userAgent),
      limit: settingsLimit,
    })) {
      items.push({
        key: `setting:${hit.id}`,
        group: 'Settings',
        label: `${hit.name}, ${hit.where}`,
        content: (
          <>
            <span className={styles.main}>
              <span className={styles.title}>
                <MatchedName name={hit.name} query={query} />
              </span>
            </span>
            <span className={styles.meta}>{hit.where}</span>
          </>
        ),
        run: () => openSetting(hit, context.dispatch),
      })
    }
    const found = terms.length > 0 && results?.query === query ? results : undefined
    for (const hit of found?.tasks ?? []) {
      items.push({
        key: `task:${hit.taskId}`,
        group: 'Tasks',
        label: `${hit.displayId} ${hit.title}`,
        content: taskContent(hit, context.factories, stages),
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
    for (const hit of found?.plans ?? []) {
      items.push({
        key: `plan:${hit.planId}`,
        group: 'Plans',
        label: hit.title,
        content: planContent(hit, context.factories),
        run: () =>
          context.dispatch({ type: 'open-plan', factoryId: hit.factoryId, planId: hit.planId }),
      })
    }
    for (const hit of found?.automations ?? []) {
      items.push({
        key: `automation:${hit.automationId}`,
        group: 'Automations',
        label: hit.name,
        content: automationContent(hit, context.factories),
        run: () =>
          context.dispatch({
            type: 'open',
            screen: { kind: 'factory', factoryId: hit.factoryId, view: 'automations' },
          }),
      })
    }
    for (const hit of found?.factories ?? []) {
      items.push({
        key: `factory:${hit.factoryId}`,
        group: 'Factories',
        label: hit.name,
        content: factoryContent(hit, context.factories),
        run: () => onOpenFactory(hit.factoryId),
      })
    }
    const conversations =
      conversationResults?.query === query ? conversationResults.conversations : []
    for (const hit of conversations) {
      items.push({
        key: `conversation:${hit.runId}:${hit.itemId}`,
        group: 'Conversations',
        label: `${hit.ref} ${hit.snippet}`,
        content: (
          <>
            <span className={styles.ref}>{hit.ref}</span>
            <span className={styles.main}>
              <span className={styles.quote}>{`“${hit.snippet}”`}</span>
              <span className={styles.byline}>
                <FactoryName factories={context.factories} factoryId={hit.factoryId} />
                {` · ${hit.title} · ${hit.runName} · ${hit.kind === 'human' ? 'You' : hit.kind === 'tool' ? 'Tool' : 'Agent message'} · ${ago(hit.at, now)}`}
              </span>
            </span>
          </>
        ),
        run: () => {
          setConversation(hit)
          return 'stay'
        },
      })
    }
  }

  const searched = results?.query === query && conversationResults?.query === query
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
    } else if (event.key === 'Backspace' && query === '' && choosing && !chosen) {
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
      className={`${styles.palette} ${conversation ? styles.viewer : ''}`}
      aria-label="Search and commands"
      onCancel={(event) => {
        event.preventDefault()
        if (conversation) backToResults()
        else if (choosing && !chosen) {
          setChoosing(undefined)
          setQuery('')
          setSelected(0)
        } else onClose()
      }}
      onMouseDown={(event) => {
        if (event.target === dialog.current) onClose()
      }}
    >
      {conversation ? (
        <ConversationSearchView
          key={`${conversation.runId}:${conversation.itemId}`}
          hit={conversation}
          onBack={backToResults}
        />
      ) : (
        <>
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
              placeholder={
                choosing ? 'Choose…' : 'Search Tasks, conversations, settings and commands'
              }
              value={query}
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value)
                setResults(undefined)
                setConversationResults(undefined)
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
                <ActionButton
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
                  onClick={() => choose(item)}
                >
                  {item.content}
                  {index === active && (
                    <span className={styles.enter} aria-hidden>
                      ↵
                    </span>
                  )}
                </ActionButton>
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
        </>
      )}
    </dialog>
  )
}
