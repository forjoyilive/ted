import type {
  AgentStageId,
  ClarifyDepth,
  LibraryStageRow,
  LibraryView,
  StageId,
} from '@ted/protocol'
import { fileChange } from '@ted/protocol/diff'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { Skeleton } from '../components/Loading.tsx'
import { StageEffort } from '../components/StageEffort.tsx'
import { useConnection } from '../data.ts'
import { type SettingsDraft, type StageDraft, stageEdited } from '../factory-settings.ts'
import {
  libraryChanges,
  libraryDraft,
  libraryLine,
  unsavedLibrary,
  unsavedLibraryLine,
} from '../library.ts'
import { OvernightNotice } from '../overnight.tsx'
import { readableError, ted } from '../ted.ts'
import base from '../views/FactorySettings.module.css'
import sections from '../views/FactorySettingsSections.module.css'
import {
  DriftNotice,
  Edited,
  FromChip,
  InvalidNotice,
  Markdown,
  Toggle,
} from '../views/FactorySettingsSections.tsx'
import { FileDiff } from '../views/SaveSettingsDialog.tsx'
import { SettingsPage } from './controls.tsx'
import styles from './LibraryPage.module.css'
import type { SettingsPageProps } from './sections.tsx'

const depthNames: Record<ClarifyDepth, string> = {
  auto: 'Auto',
  none: 'None',
  few: 'Few',
  grilling: 'Grilling',
}

type EditorTab = 'edit' | 'preview' | 'compare'

function title(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

const isAgentStage = (id: StageId): id is AgentStageId => id !== 'backlog' && id !== 'done'

export function LibraryPage({ dispatch }: SettingsPageProps) {
  const [view, setView] = useState<LibraryView>()
  const [loaded, setLoaded] = useState<SettingsDraft>()
  const [draft, setDraft] = useState<SettingsDraft>()
  const [editing, setEditing] = useState<AgentStageId>()
  const [error, setError] = useState<string>()
  const [changedOnDisk, setChangedOnDisk] = useState(false)
  const [saving, setSaving] = useState(false)
  const { epoch } = useConnection()
  const count = draft && loaded ? unsavedLibrary(draft, loaded) : 0

  const show = useCallback((next: LibraryView) => {
    const fresh = libraryDraft(next)
    setView(next)
    setLoaded(fresh)
    setDraft(fresh)
    setChangedOnDisk(false)
  }, [])

  const shown = useRef({ count, version: view?.version })
  shown.current = { count, version: view?.version }

  useEffect(() => {
    void epoch
    let active = true
    const refresh = () =>
      ted.library().then(
        (next) => {
          if (!active || next.version === shown.current.version) return
          setError(undefined)
          if (shown.current.count === 0) show(next)
          else setChangedOnDisk(true)
        },
        (failure: unknown) => active && setError(readableError(failure)),
      )
    void refresh()
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'library-changed') void refresh()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [epoch, show])

  const setStage = (id: StageId, fields: Partial<StageDraft>) =>
    setDraft((d) => {
      const current = d?.stages[id]
      if (!d || !current) return d
      return { ...d, stages: { ...d.stages, [id]: { ...current, ...fields } } }
    })
  const setFile = (id: AgentStageId, text: string | null) =>
    setDraft((d) => d && { ...d, stageFiles: { ...d.stageFiles, [id]: text } })

  async function save() {
    if (!draft || !loaded || !view) return
    setSaving(true)
    setError(undefined)
    try {
      show(await ted.saveLibrary({ changes: libraryChanges(draft, loaded), version: view.version }))
      setEditing(undefined)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsPage
      title="Library"
      help={`Your own Workflow settings and Stage files, kept in ${view?.path ?? '~/.ted/library'}. Every Factory inherits them unless it overrides them in .ted/. Stage effort applies at Stage entry unless the Task has its own effort.`}
      subtitle={libraryLine}
    >
      {!view && !error && <Skeleton shape="settings" label="Loading Library…" />}
      <OvernightNotice />
      {view?.invalid && (
        <InvalidNotice invalid={{ ...view.invalid, file: `Library ${view.invalid.file}` }} />
      )}
      {changedOnDisk && (
        <p className={sections.warning} role="status">
          <span className={sections.warnMark} aria-hidden>
            ▲
          </span>{' '}
          The Library changed on disk. Discard your changes to see it.
        </p>
      )}
      {view && draft && loaded && (
        <>
          <section className={styles.group} aria-labelledby="library-workflow">
            <h2 id="library-workflow" className={styles.groupLabel}>
              Workflow
            </h2>
            <div className={`${sections.table} ${sections.workflowTable}`}>
              <div className={`${styles.row} ${sections.headRow}`}>
                <span>Stage</span>
                <span>On</span>
                <span className={sections.gateHeading}>
                  Sign-off
                  <Help>
                    When on, the Task waits for your approval at the end of this Stage before moving
                    on. If the Stage skips itself, its sign-off is skipped too.
                  </Help>
                </span>
                <span>Send-backs</span>
                <span>Clarify depth</span>
                <span>Task Lead effort</span>
                <span>Source</span>
                <span className={base.visuallyHidden}>Actions</span>
              </div>
              {view.stages.map((row) => (
                <StageLine
                  key={row.id}
                  row={row}
                  draft={draft}
                  edited={stageEdited(draft, loaded, row.id).size > 0}
                  onStage={(fields) => setStage(row.id, fields)}
                  onOverride={() => {
                    if (!isAgentStage(row.id)) return
                    setFile(row.id, row.defaultText ?? '')
                    setEditing(row.id)
                  }}
                  onReset={() => {
                    if (!isAgentStage(row.id)) return
                    setFile(row.id, null)
                    if (editing === row.id) setEditing(undefined)
                  }}
                  onKeep={() => {
                    if (!isAgentStage(row.id)) return
                    const id = row.id
                    setDraft(
                      (d) =>
                        d &&
                        (d.keepStageFiles.includes(id)
                          ? d
                          : { ...d, keepStageFiles: [...d.keepStageFiles, id] }),
                    )
                  }}
                />
              ))}
            </div>
          </section>

          <section className={styles.group} aria-labelledby="library-stage-files">
            <h2 id="library-stage-files" className={styles.groupLabel}>
              Stage files
            </h2>
            <div className={sections.table}>
              {view.stages.flatMap((row) =>
                isAgentStage(row.id)
                  ? [
                      <StageFile
                        key={row.id}
                        id={row.id}
                        row={row}
                        path={view.path}
                        text={draft.stageFiles[row.id] ?? null}
                        edited={
                          (draft.stageFiles[row.id] ?? null) !== (loaded.stageFiles[row.id] ?? null)
                        }
                        open={editing === row.id}
                        onOpen={(open) => setEditing(open ? (row.id as AgentStageId) : undefined)}
                        onText={(text) => setFile(row.id as AgentStageId, text)}
                      />,
                    ]
                  : [],
              )}
            </div>
          </section>

          <p className={styles.agentsLink}>
            <button
              type="button"
              className={base.link}
              onClick={() => dispatch({ type: 'open-settings', section: 'agents' })}
            >
              Task Lead, Reviewer and Planner are under Agents →
            </button>
            <Help>
              Permissions, Checks, Apps and repos belong to each Factory, so they aren’t in the
              Library.
            </Help>
          </p>
        </>
      )}
      {error !== undefined && (
        <p className={base.fieldError} role="alert">
          {error}
        </p>
      )}
      {count > 0 && view && loaded && (
        <footer className={styles.saveBar}>
          <span className={base.unsavedDot} aria-hidden />
          <span>{unsavedLibraryLine(count)}</span>
          <span className={base.spacer} />
          <Button
            size="small"
            disabled={saving}
            onClick={() => {
              setDraft(loaded)
              setEditing(undefined)
              setError(undefined)
              if (changedOnDisk) void ted.library().then(show)
            }}
          >
            Discard
          </Button>
          <Button size="small" variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </footer>
      )}
    </SettingsPage>
  )
}

function StageLine({
  row,
  draft,
  edited,
  onStage,
  onOverride,
  onReset,
  onKeep,
}: {
  row: LibraryStageRow
  draft: SettingsDraft
  edited: boolean
  onStage: (fields: Partial<StageDraft>) => void
  onOverride: () => void
  onReset: () => void
  onKeep: () => void
}) {
  const stage = draft.stages[row.id]
  const name = title(row.id)
  const agent = isAgentStage(row.id)
  const file = agent ? (draft.stageFiles[row.id as AgentStageId] ?? null) : null
  const holding = <span className={styles.holding}>holding</span>
  const dash = <span className={sections.dash}>—</span>
  const fixed = row.id === 'intake' || row.id === 'work'
  const drift =
    agent && file !== null && !draft.keepStageFiles.includes(row.id as AgentStageId)
      ? row.drift
      : undefined
  return (
    <div className={drift ? sections.stageDrift : undefined}>
      <div className={`${styles.row} ${styles.line}`}>
        <span className={sections.stageName}>
          {name}
          {drift && (
            <span className={sections.driftDot} role="img" aria-label="Default version changed" />
          )}{' '}
          <Edited when={edited} />
        </span>
        <span>
          {row.id === 'done' ? (
            holding
          ) : row.id === 'backlog' ? (
            <Toggle
              label="Backlog on"
              checked={stage?.enabled ?? row.enabled}
              onChange={(enabled) => onStage({ enabled })}
            />
          ) : (
            <Toggle
              label={`${name} on`}
              checked={stage?.enabled ?? row.enabled}
              disabled={fixed || !row.inOrder}
              {...(fixed && { title: `${name} can’t be turned off` })}
              onChange={(enabled) => onStage({ enabled })}
            />
          )}
        </span>
        <span>
          {agent ? (
            <Toggle
              label={`${name} sign-off`}
              checked={stage?.gate ?? row.gate}
              onChange={(gate) => onStage({ gate })}
            />
          ) : (
            dash
          )}
        </span>
        <span>
          {agent ? (
            <input
              aria-label={`${name} send-backs`}
              className={sections.numberInput}
              inputMode="numeric"
              value={stage?.maxBack ?? ''}
              placeholder="—"
              onChange={(event) => {
                const text = event.target.value.replace(/\D/g, '')
                if (text !== '') onStage({ maxBack: Number(text) })
              }}
            />
          ) : (
            dash
          )}
        </span>
        <span>
          {row.id === 'clarify' ? (
            <select
              aria-label="Clarify depth"
              className={sections.cellSelect}
              value={stage?.depth ?? 'auto'}
              onChange={(event) => onStage({ depth: event.target.value as ClarifyDepth })}
            >
              {Object.entries(depthNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            dash
          )}
        </span>
        <span>
          {agent ? (
            <StageEffort
              stage={name}
              value={stage?.effort}
              inherited={row.inheritedEffort}
              source={row.inheritedEffortFrom}
              onChange={(effort) => onStage({ effort })}
            />
          ) : (
            dash
          )}
        </span>
        <span>{agent && <FromChip layer={file !== null ? 'library' : 'ted'} />}</span>
        <span className={sections.actions}>
          {row.id === 'backlog' && <span className={sections.always}>Always first</span>}
          {row.id === 'done' && <span className={sections.always}>Always last</span>}
          {agent && file === null && (
            <Button size="small" onClick={onOverride}>
              Override in Library
            </Button>
          )}
          {agent && file !== null && (
            <Button size="small" onClick={onReset}>
              Reset to default
            </Button>
          )}
        </span>
      </div>
      {drift && (
        <DriftNotice
          stage={row.id as AgentStageId}
          drift={drift}
          label="Default"
          useLabel="Use default"
          onKeep={onKeep}
          onUse={onReset}
        />
      )}
    </div>
  )
}

function StageFile({
  id,
  row,
  path,
  text,
  edited,
  open,
  onOpen,
  onText,
}: {
  id: AgentStageId
  row: LibraryStageRow
  path: string
  text: string | null
  edited: boolean
  open: boolean
  onOpen: (open: boolean) => void
  onText: (text: string | null) => void
}) {
  const [tab, setTab] = useState<EditorTab>('edit')
  const name = `${id}.md`
  const shownPath = `${path.replace(/^\/(?:Users|home)\/[^/]+/, '~')}/stages/${name}`
  const tabs: [EditorTab, string][] = [
    ['edit', 'Edit'],
    ['preview', 'Preview'],
    ['compare', 'Compare with default'],
  ]
  return (
    <div className={open ? sections.stageOpen : styles.fileBlock}>
      <div className={styles.fileRow}>
        <span className={styles.fileName}>
          <span>
            <span className={styles.fileTitle}>{name}</span>{' '}
            <FromChip layer={text !== null ? 'library' : 'ted'} /> <Edited when={edited} />
          </span>
          <span className={styles.filePath}>{text !== null ? shownPath : 'TED’s default'}</span>
        </span>
        <span className={base.spacer} />
        {text === null ? (
          <Button
            size="small"
            onClick={() => {
              onText(row.defaultText ?? '')
              setTab('edit')
              onOpen(true)
            }}
          >
            Edit in Library
          </Button>
        ) : (
          <>
            <Button size="small" onClick={() => onOpen(!open)}>
              {open ? 'Close' : 'Edit'}
            </Button>
            <Button
              size="small"
              onClick={() => {
                onText(null)
                onOpen(false)
              }}
            >
              Reset to default
            </Button>
          </>
        )}
      </div>
      {open && text !== null && (
        <div className={sections.fileEditor}>
          <div className={sections.tabs} role="tablist" aria-label={`${name} view`}>
            {tabs.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={tab === value ? sections.tabOn : sections.tab}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'edit' && (
            <textarea
              aria-label={`${title(id)} Stage file`}
              className={sections.fileText}
              value={text}
              spellCheck={false}
              rows={Math.min(24, Math.max(8, text.split('\n').length + 1))}
              onChange={(event) => onText(event.target.value)}
            />
          )}
          {tab === 'preview' && (
            <div className={styles.preview}>
              {text.trim() === '' ? (
                <p className={base.caption}>This Stage file is empty.</p>
              ) : (
                <Markdown text={text} />
              )}
            </div>
          )}
          {tab === 'compare' &&
            (text === (row.defaultText ?? '') ? (
              <p className={base.caption}>Same as TED’s default.</p>
            ) : (
              <FileDiff
                file={fileChange(name, row.defaultText ?? '', text)}
                label={`${name} compared with TED’s default`}
              />
            ))}
        </div>
      )}
    </div>
  )
}
