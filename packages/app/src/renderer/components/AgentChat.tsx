import type { AgentKind, AgentSummary, Coordinator, Plan } from '@ted/protocol'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ChatActionKind, ChatState } from '../agent-chats.ts'
import { readableError } from '../ted.ts'
import views from '../views/views.module.css'
import { ActionButton } from './ActionButton.tsx'
import {
  AgentAbout,
  AgentCommands,
  AgentPowers,
  AgentSource,
  shownCommands,
} from './AgentAbout.tsx'
import styles from './AgentChat.module.css'
import { Button } from './Button.tsx'
import { buttonPosition, contextMenu, type MenuPosition } from './ContextMenu.tsx'
import { OutsideCommandsSection } from './OutsideCommands.tsx'
import { DetailsPane } from './ResizableSidebar.tsx'
import { RunIcon, type RunIconState } from './RunIcon.tsx'
import { StatusChip, type StatusGlyph, type StatusTone } from './StatusChip.tsx'
import { MoreIcon } from './TaskActions.tsx'

export interface ChatControls {
  state: ChatState
  busy: boolean
  error: string | undefined
  renameSignal: number
  perform: (kind: ChatActionKind) => void
  openMenu: (at: MenuPosition) => void
}

export function AgentChat({
  label,
  title,
  onRename,
  chip,
  meta,
  alert,
  banner,
  controls,
  children,
  details,
}: {
  label: string
  title: string
  onRename: (title: string) => Promise<Coordinator | Plan>
  chip: { tone: StatusTone; glyph?: StatusGlyph | undefined; label: string }
  meta: ReactNode
  alert?: string | undefined
  banner?: string | undefined
  controls: ChatControls
  children: ReactNode
  details: ReactNode
}) {
  const { state, busy, perform, openMenu } = controls
  const shownAlert = controls.error ?? alert
  return (
    <>
      <section className={views.pane} aria-label={label}>
        <header className={styles.header} {...contextMenu(openMenu)}>
          <div className={styles.titleRow}>
            <TitleEditor current={title} renameSignal={controls.renameSignal} onRename={onRename} />
            <StatusChip tone={chip.tone} {...(chip.glyph && { glyph: chip.glyph })}>
              {chip.label}
            </StatusChip>
            <span className={styles.spacer} />
            {state.stoppable && (
              <Button disabled={busy} onClick={() => perform('stop')}>
                Stop
              </Button>
            )}
            {!state.archived && (
              <Button disabled={busy} onClick={() => perform('archive')}>
                Archive
              </Button>
            )}
            <ActionButton
              type="button"
              className={styles.more}
              aria-label="Chat actions"
              aria-haspopup="menu"
              onClick={(event) => openMenu(buttonPosition(event.currentTarget))}
            >
              <MoreIcon />
            </ActionButton>
          </div>
          <p className={styles.meta}>{meta}</p>
          {shownAlert !== undefined && (
            <p className={styles.error} role="alert">
              {shownAlert}
            </p>
          )}
        </header>
        {banner !== undefined && (
          <div className={styles.banner}>
            <span className={styles.spacer}>{banner}</span>
            {state.planMore && (
              <Button disabled={busy} onClick={() => perform('plan-more')}>
                Plan more from here…
              </Button>
            )}
            {state.archived ? (
              <>
                <Button disabled={busy} onClick={() => perform('delete')}>
                  Delete…
                </Button>
                <Button variant="primary" disabled={busy} onClick={() => perform('unarchive')}>
                  Unarchive
                </Button>
              </>
            ) : (
              state.restart !== undefined && (
                <Button variant="primary" disabled={busy} onClick={() => perform('restart')}>
                  {state.restart}
                </Button>
              )
            )}
          </div>
        )}
        {children}
      </section>
      {details}
    </>
  )
}

export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return <p className={styles.readOnly}>{children}</p>
}

export function AgentChatDetails({
  label,
  agent,
  removed = false,
  factoryId,
  provider,
  startedFrom,
  tasks,
  run,
  tokens,
}: {
  label: string
  agent: AgentSummary
  removed?: boolean
  factoryId: string | undefined
  provider: string | undefined
  startedFrom: ReactNode
  tasks?: { title: string; body: ReactNode } | undefined
  run?: { agent: AgentKind; state: RunIconState; name: string; line: string } | undefined
  tokens?: string | undefined
}) {
  const commands = shownCommands(agent)
  return (
    <DetailsPane className={views.detailsPane} aria-label={label}>
      <DetailSection title="Agent">
        <AgentAbout agent={agent} removed={removed} />
        <AgentSource source={agent.source} />
      </DetailSection>
      <DetailSection title="Powers">
        <AgentPowers powers={agent.powers} />
      </DetailSection>
      {commands.length > 0 && (
        <DetailSection title="Commands">
          <AgentCommands commands={commands} />
        </DetailSection>
      )}
      <OutsideCommandsSection factoryId={factoryId} agent={agent} className={styles.section} />
      {provider !== undefined && provider !== '' && (
        <DetailSection title="Provider">
          <p className={styles.text}>{provider}</p>
        </DetailSection>
      )}
      <DetailSection title="Started from">{startedFrom}</DetailSection>
      {tasks && <DetailSection title={tasks.title}>{tasks.body}</DetailSection>}
      {run && (
        <DetailSection title="Runs">
          <div className={styles.run}>
            <RunIcon agent={run.agent} state={run.state} />
            <span className={styles.runText}>
              <span className={styles.text}>{run.name}</span>
              <span className={styles.muted}>{run.line}</span>
            </span>
          </div>
        </DetailSection>
      )}
      {tokens !== undefined && (
        <DetailSection title="Tokens">
          <p className={styles.text}>{tokens}</p>
        </DetailSection>
      )}
    </DetailsPane>
  )
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

export function DetailText({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <p className={muted ? styles.muted : styles.text}>{children}</p>
}

export function TitleEditor({
  current,
  renameSignal = 0,
  onRename,
}: {
  current: string
  renameSignal?: number
  onRename: (title: string) => Promise<Coordinator | Plan>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const title = useRef(current)
  title.current = current

  useEffect(() => {
    if (renameSignal === 0) return
    setValue(title.current)
    setEditing(true)
  }, [renameSignal])

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  async function save() {
    const title = value.trim()
    if (title === '' || title === current) {
      setEditing(false)
      setValue(current)
      return
    }
    try {
      await onRename(title)
      setEditing(false)
      setError(undefined)
    } catch (failed) {
      setError(readableError(failed))
    }
  }

  if (!editing) {
    return (
      <h1 className={styles.title}>
        <ActionButton
          type="button"
          className={styles.titleButton}
          title="Rename"
          onClick={() => {
            setValue(current)
            setEditing(true)
          }}
        >
          {current}
        </ActionButton>
      </h1>
    )
  }
  return (
    <span className={styles.titleEdit}>
      <input
        ref={input}
        className={styles.titleInput}
        aria-label="Title"
        data-arrows
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => save()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') {
            setEditing(false)
            setValue(current)
          }
        }}
      />
      {error !== undefined && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
