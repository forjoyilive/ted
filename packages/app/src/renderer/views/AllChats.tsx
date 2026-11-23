import type { Factory } from '@ted/protocol'
import { type AgentChatRef, type AgentChatRow, splitArchived } from '../agent-chats.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { Button } from '../components/Button.tsx'
import { FactoryIcon, FactoryName } from '../components/FactoryIcon.tsx'
import { LoadingError, Skeleton } from '../components/Loading.tsx'
import { StatusChip } from '../components/StatusChip.tsx'
import { useAllChats } from '../data.ts'
import { when } from '../plans.ts'
import { age, useNow } from '../requests.ts'
import agentPicker from './AgentPicker.module.css'
import styles from './AllChats.module.css'
import inbox from './Inbox.module.css'
import { CheckItem, DisplayIcon, FilterIcon, MenuButton, RadioItem } from './TaskList.tsx'
import views from './views.module.css'

const groupings = ['None', 'Factory', 'Agent'] as const

export interface AllChatsView {
  grouping: (typeof groupings)[number]
  factory?: string
  agent?: string
  status?: string
  archived: boolean
}

type FilterKey = 'factory' | 'agent' | 'status'

function ChatColumns({ time }: { time: 'Updated' | 'Archived' }) {
  return (
    <div className={styles.columns}>
      <span>Chat</span>
      <span>Agent</span>
      <span>Factory</span>
      <span>Status</span>
      <span className={styles.time}>{time}</span>
    </div>
  )
}

function filterStatus(row: AgentChatRow) {
  return row.chip.label.split(' · ', 1)[0] ?? row.chip.label
}

export function AllChats({
  factories,
  factoriesLoaded,
  view,
  onView,
  onOpen,
  onNewChat,
}: {
  factories: readonly Factory[]
  factoriesLoaded: boolean
  view: AllChatsView
  onView: (view: AllChatsView) => void
  onOpen: (factoryId: string, ref: AgentChatRef) => void
  onNewChat: () => void
}) {
  const chats = useAllChats(factories)
  const now = useNow()
  const rows = chats.value?.rows ?? []
  const error = chats.error ?? chats.value?.error
  const loaded = factoriesLoaded && (chats.value !== undefined || error !== undefined)
  const filterCount = [view.factory, view.agent, view.status].filter(Boolean).length
  const { open, archived } = splitArchived(
    rows.filter(
      (row) =>
        (view.factory === undefined || row.factoryId === view.factory) &&
        (view.agent === undefined || row.agent === view.agent) &&
        (view.status === undefined || filterStatus(row) === view.status),
    ),
  )
  const showArchive = view.archived && archived.length > 0
  const factoryNames = new Map(factories.map((factory) => [factory.id, factory.name]))
  const grouped = new Map<string, AgentChatRow[]>()
  if (view.grouping !== 'None') {
    for (const row of open) {
      const key = view.grouping === 'Factory' ? row.factoryId : row.agent
      const group = grouped.get(key)
      if (group) group.push(row)
      else grouped.set(key, [row])
    }
  }
  const groupLabel = (key: string) =>
    view.grouping === 'Factory' ? (factoryNames.get(key) ?? key) : key
  const filter = (
    key: FilterKey,
    label: string,
    options: readonly { id: string; label: string }[],
  ) => {
    const select = (id?: string) => {
      const next = { ...view }
      if (id === undefined) delete next[key]
      else next[key] = id
      onView(next)
    }
    return (
      <>
        <div className={inbox.panelHeading}>{label}</div>
        <div className={inbox.chips}>
          <button
            type="button"
            aria-pressed={view[key] === undefined}
            className={inbox.chip}
            onClick={() => select()}
          >
            All
          </button>
          {options.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view[key] === id}
              className={inbox.chip}
              onClick={() => select(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </>
    )
  }
  const renderRow = (row: AgentChatRow) => {
    const at = row.archivedAt ?? row.lastAt
    return (
      <ActionButton
        key={`${row.ref.agent}:${row.ref.id}`}
        type="button"
        data-nav-item
        className={styles.row}
        onClick={() => onOpen(row.factoryId, row.ref)}
      >
        <span className={styles.title} title={row.title}>
          {row.title}
        </span>
        <span className={styles.agent} title={row.agent}>
          {row.agent}
        </span>
        <FactoryName factories={factories} factoryId={row.factoryId} />
        <span className={styles.status}>
          <StatusChip
            tone={row.chip.tone}
            title={row.chip.label}
            {...(row.chip.glyph && { glyph: row.chip.glyph })}
          >
            <span className={styles.statusLabel}>{row.chip.label}</span>
          </StatusChip>
        </span>
        {at !== '' && (
          <time className={styles.time} dateTime={at} title={when(at)}>
            {age(at, now)}
          </time>
        )}
      </ActionButton>
    )
  }
  const names = (values: readonly string[]) =>
    [...new Set(values)]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ id: name, label: name }))

  return (
    <section className={views.pane} aria-label="All Chats">
      <header className={`${views.header} ${styles.header}`}>
        <h1 className={views.title}>All Chats</h1>
        <span className={views.headerSpacer} />
        <MenuButton label="Filter" icon={<FilterIcon />} badge={filterCount}>
          {(close) => (
            <>
              {filter(
                'factory',
                'Factory',
                factories.map(({ id, name }) => ({ id, label: name })),
              )}
              {filter('agent', 'Agent', names(rows.map((row) => row.agent)))}
              {filter(
                'status',
                'Status',
                names(rows.filter((row) => !row.state.archived).map(filterStatus)),
              )}
              {filterCount > 0 && (
                <div className={styles.clear}>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      onView({ grouping: view.grouping, archived: view.archived })
                      close()
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
            </>
          )}
        </MenuButton>
        <MenuButton label="Display" icon={<DisplayIcon />}>
          {(close) => (
            <>
              <CheckItem
                label="Show archived chats"
                checked={view.archived}
                onChange={() => {
                  onView({ ...view, archived: !view.archived })
                  close()
                }}
              />
              <div className={inbox.panelHeading}>Group by</div>
              {groupings.map((grouping) => (
                <RadioItem
                  key={grouping}
                  label={grouping}
                  checked={view.grouping === grouping}
                  onChange={() => {
                    onView({ ...view, grouping })
                    close()
                  }}
                />
              ))}
            </>
          )}
        </MenuButton>
        <Button variant="primary" disabled={factories.length === 0} onClick={onNewChat}>
          New chat
        </Button>
      </header>
      <div className={views.body}>
        {!loaded && (
          <div className={styles.loading}>
            <Skeleton label="Loading chats…" />
          </div>
        )}
        {error !== undefined && <LoadingError error={error} retry={chats.retry} />}
        {(open.length > 0 || showArchive) && (
          <div className={styles.list}>
            {open.length > 0 && (
              <>
                <ChatColumns time="Updated" />
                {view.grouping === 'None'
                  ? open.map(renderRow)
                  : [...grouped]
                      .sort(([a], [b]) => groupLabel(a).localeCompare(groupLabel(b)))
                      .map(([key, group]) => (
                        <section key={key}>
                          <h2 className={styles.group}>
                            {groupLabel(key)} · {group.length}
                          </h2>
                          {group.map(renderRow)}
                        </section>
                      ))}
              </>
            )}
            {showArchive && (
              <section aria-label="Archived chats">
                <h2 className={styles.group}>Archived · {archived.length}</h2>
                <ChatColumns time="Archived" />
                {archived.map(renderRow)}
              </section>
            )}
          </div>
        )}
        {loaded && error === undefined && open.length === 0 && !showArchive && (
          <p className={views.empty}>
            {archived.length > 0
              ? 'No open chats.'
              : filterCount > 0
                ? 'No chats match these filters.'
                : 'No chats yet.'}
          </p>
        )}
      </div>
    </section>
  )
}

export function ChatFactoryPicker({
  factories,
  onBack,
  onChoose,
}: {
  factories: readonly Factory[]
  onBack: () => void
  onChoose: (factoryId: string) => void
}) {
  return (
    <section className={views.pane} aria-label="Choose a Factory">
      <header className={views.header}>
        <Button variant="quiet" onClick={onBack}>
          ← All Chats
        </Button>
        <h1 className={views.title}>New chat</h1>
      </header>
      <div className={views.body}>
        <div className={agentPicker.picker}>
          <h2 className={agentPicker.title}>Choose a Factory</h2>
          {factories.length === 0 ? (
            <p className={views.empty}>No Factories yet.</p>
          ) : (
            <ul className={agentPicker.grid} aria-label="Factories">
              {factories.map((factory) => (
                <li key={factory.id}>
                  <ActionButton
                    type="button"
                    data-nav-item
                    className={agentPicker.card}
                    onClick={() => onChoose(factory.id)}
                  >
                    <FactoryIcon factory={factory} size={24} />
                    <span className={agentPicker.name}>{factory.name}</span>
                  </ActionButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
