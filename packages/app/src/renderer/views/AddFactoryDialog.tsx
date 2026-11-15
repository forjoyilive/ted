import type { Factory, IntegrationsHealth, RepoCheck, RepoFix, RepoSource } from '@ted/protocol'
import { keyProblem, suggestFactoryName, suggestKey } from '@ted/protocol/factory'
import { type DragEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react'
import {
  footer,
  githubProblem,
  isFilled,
  moveRow,
  nameProblem,
  protectedFolderNote,
  type RepoRow,
  shortPath,
} from '../add-factory.ts'
import { ActionButton } from '../components/ActionButton.tsx'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { useEventValue } from '../data.ts'
import { ted } from '../ted.ts'
import styles from './AddFactoryDialog.module.css'
import { GitHubSetupForm } from './GitHubSetupForm.tsx'

const onMac = navigator.userAgent.includes('Mac')

interface AddFactoryDialogProps {
  factories: readonly Factory[]
  onClose: () => void
  onAdded: (factory: Factory) => void
  onOpenFactory: (factoryId: string) => void
  onOpenGitHubSettings: () => void
  steps?:
    | {
        indicator: ReactNode
        busy: boolean
        problem: string | undefined
        onBack: () => void
      }
    | undefined
}

let nextRow = 0
const emptyRow = (): RepoRow => ({
  id: `row-${nextRow++}`,
  text: '',
  name: '',
  nameEdited: false,
  checking: false,
})

export function AddFactoryDialog({
  factories,
  onClose,
  onAdded,
  onOpenFactory,
  onOpenGitHubSettings,
  steps,
}: AddFactoryDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const firstInput = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const first = useRef(factories.length === 0).current
  const [rows, setRows] = useState<RepoRow[]>(() => [emptyRow()])
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [key, setKey] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const { value: health } = useEventValue<IntegrationsHealth | undefined>({
    initial: undefined,
    load: ted.getIntegrations,
    event: (event) => (event.type === 'integrations-checked' ? () => event.health : undefined),
  })
  const [home, setHome] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [dragging, setDragging] = useState<number>()
  const requests = useRef(new Map<string, number>())

  useEffect(() => {
    dialog.current?.showModal()
    firstInput.current?.focus()
    void ted.homeFolder().then(setHome, () => undefined)
  }, [])

  const primary = rows[0]
  const primaryRepo = primary?.check?.repo
  useEffect(() => {
    if (nameEdited || primaryRepo === undefined) return
    setName(suggestFactoryName(primaryRepo))
  }, [primaryRepo, nameEdited])
  useEffect(() => {
    if (!keyEdited) setKey(suggestKey(name, factories))
  }, [name, keyEdited, factories])

  const update = (id: string, change: (row: RepoRow) => RepoRow) =>
    setRows((current) => current.map((row) => (row.id === id ? change(row) : row)))

  async function check(id: string, source: RepoSource, isPrimary: boolean) {
    const ticket = (requests.current.get(id) ?? 0) + 1
    requests.current.set(id, ticket)
    update(id, (row) => {
      const { check: _, ...rest } = row
      return { ...rest, source, checking: true }
    })
    let result: RepoCheck
    try {
      result = await ted.checkRepo({ source, primary: isPrimary })
    } catch (failure) {
      result = {
        ok: false,
        notes: [],
        problem: { kind: 'failed', text: readableError(failure), fixes: [{ kind: 'check-again' }] },
      }
    }
    if (requests.current.get(id) !== ticket) return
    update(id, (row) => ({
      ...row,
      check: result,
      checking: false,
      name: row.nameEdited ? row.name : (result.name ?? row.name),
    }))
  }

  const recheck = (row: RepoRow, index: number) => {
    if (row.source) return check(row.id, row.source, index === 0)
  }

  const primaryId = primary?.id
  const lastPrimary = useRef(primaryId)
  const latestRows = useRef(rows)
  latestRows.current = rows
  const latestCheck = useRef(check)
  latestCheck.current = check
  useEffect(() => {
    if (lastPrimary.current === primaryId) return
    lastPrimary.current = primaryId
    latestRows.current.forEach((row, i) => {
      if (row.source) void latestCheck.current(row.id, row.source, i === 0)
    })
  }, [primaryId])

  async function chooseFolder(row: RepoRow, index: number) {
    const folder = await ted.chooseFolder('Choose the repo’s folder')
    if (folder !== undefined) await check(row.id, { folder }, index === 0)
  }

  function submitRemote(row: RepoRow, index: number) {
    const text = row.text.trim()
    if (text !== '') void check(row.id, { remote: text }, index === 0)
  }

  function remove(row: RepoRow, index: number) {
    requests.current.delete(row.id)
    if (index === 0 && rows.length === 1) {
      setRows([emptyRow()])
      return
    }
    setRows((current) => current.filter((r) => r.id !== row.id))
  }

  function fix(row: RepoRow, index: number, chosen: RepoFix) {
    if (chosen.kind === 'open-factory') onOpenFactory(chosen.factoryId)
    else if (chosen.kind === 'github-settings') onOpenGitHubSettings()
    else if (chosen.kind === 'choose-folder') return chooseFolder(row, index)
    else return recheck(row, index)
  }

  function onDrop(event: DragEvent, to: number) {
    event.preventDefault()
    if (dragging !== undefined) setRows((current) => moveRow(current, dragging, to))
    setDragging(undefined)
  }

  const github = githubProblem(health)
  const keyError = keyProblem(key, factories)
  const shown = footer({ rows, name, key, keyProblem: keyError, github })
  const held = busy || (steps?.busy ?? false)
  const problem = error ?? steps?.problem
  const keyFormatOnly = keyError !== undefined && !factories.some((f) => f.key === key)

  async function add() {
    if (shown.blocked || held) return
    setBusy(true)
    setError(undefined)
    try {
      const added = await ted.createFactory({
        name: name.trim(),
        key,
        repos: rows.flatMap((row) =>
          row.source && row.check?.ok ? [{ source: row.source, name: row.name }] : [],
        ),
      })
      onAdded(added)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        if (!held) onClose()
      }}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          {first ? 'Add your first Factory' : 'Add Factory'}
        </h2>
        <Help>
          A Factory carries Tasks from creation to merge for one product. TED works in its own
          clones of these repos. It changes your folder only when you ask it to set up a GitHub
          repo.
        </Help>
      </header>

      <div className={styles.body}>
        <section className={styles.repos} aria-label="Repos">
          <span className={styles.label}>Repos</span>
          {github && (
            <div className={`${styles.row} ${styles.problemRow}`}>
              <div className={styles.rowHead}>
                <span className={styles.repo}>GitHub</span>
                <span className={styles.spacer} />
                <Button
                  size="small"
                  onClick={() =>
                    ted.runFix({
                      fix: github.fix,
                      ...(github.host !== undefined && { host: github.host }),
                    })
                  }
                >
                  {github.label}
                </Button>
              </div>
              <p className={styles.problem}>
                <span aria-hidden>✕</span> {github.text} · needed to add a Factory
              </p>
            </div>
          )}
          {rows.map((row, index) => (
            <RepoRowView
              key={row.id}
              row={row}
              rows={rows}
              index={index}
              inputRef={index === 0 ? firstInput : undefined}
              home={home}
              dragging={dragging}
              onDragStart={() => setDragging(index)}
              onDragEnd={() => setDragging(undefined)}
              onDrop={(event) => onDrop(event, index)}
              onText={(text) => update(row.id, (r) => ({ ...r, text }))}
              onSubmitRemote={() => submitRemote(row, index)}
              onChooseFolder={() => chooseFolder(row, index)}
              onName={(value) => update(row.id, (r) => ({ ...r, name: value, nameEdited: true }))}
              onRemove={() => remove(row, index)}
              onFix={(chosen) => fix(row, index, chosen)}
            />
          ))}
          <ActionButton
            type="button"
            className={styles.addRepo}
            onClick={() => setRows((current) => [...current, emptyRow()])}
          >
            + Add another repo
          </ActionButton>
        </section>

        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${headingId}-name`}>
              Name
            </label>
            <input
              id={`${headingId}-name`}
              className={styles.input}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameEdited(true)
              }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${headingId}-key`}>
              Key
            </label>
            <span className={styles.keyBox}>
              <input
                id={`${headingId}-key`}
                className={`${styles.input} ${keyError && key !== '' ? styles.invalid : ''}`}
                value={key}
                maxLength={5}
                aria-invalid={keyError !== undefined}
                aria-describedby={`${headingId}-key-note`}
                onChange={(event) => {
                  setKey(event.target.value.toUpperCase())
                  setKeyEdited(true)
                }}
              />
              {keyError === undefined && (
                <span className={styles.keyOk} aria-hidden>
                  ✓
                </span>
              )}
            </span>
            <span
              id={`${headingId}-key-note`}
              className={keyError && key !== '' ? styles.keyError : styles.hint}
            >
              {keyError && key !== '' ? (
                keyError
              ) : (
                <>
                  Task IDs look like {keyFormatOnly || key === '' ? 'NB' : key}-1.{' '}
                  <Help>Can’t be changed later.</Help>
                </>
              )}
            </span>
          </div>
        </div>
      </div>

      {problem !== undefined && (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
      <footer className={styles.footer}>
        {steps?.indicator}
        <span className={shown.problem ? styles.footerProblem : styles.footerNote}>
          {shown.text}
        </span>
        <span className={styles.spacer} />
        <Button variant={steps ? 'quiet' : 'secondary'} disabled={held} onClick={onClose}>
          {steps ? 'Skip' : 'Cancel'}
        </Button>
        {steps && (
          <Button disabled={held} onClick={steps.onBack}>
            Back
          </Button>
        )}
        <Button variant="primary" disabled={shown.blocked || held} onClick={() => add()}>
          Add Factory
        </Button>
      </footer>
    </dialog>
  )
}

export interface RepoRowViewProps {
  row: RepoRow
  rows: readonly RepoRow[]
  index: number
  inputRef?: Ref<HTMLInputElement> | undefined
  home: string | undefined
  dragging: number | undefined
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (event: DragEvent) => void
  onText: (text: string) => void
  onSubmitRemote: () => void
  onChooseFolder: () => void
  onName: (name: string) => void
  onRemove: () => void
  onFix: (fix: RepoFix) => void
}

export function RepoRowView({
  row,
  rows,
  index,
  inputRef,
  home,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onText,
  onSubmitRemote,
  onChooseFolder,
  onName,
  onRemove,
  onFix,
}: RepoRowViewProps) {
  const nameId = useId()
  const [settingUp, setSettingUp] = useState(false)
  const isPrimary = index === 0
  const filled = isFilled(row)
  const fromFolder = row.source !== undefined && 'folder' in row.source
  const folder =
    row.check?.folder ?? (row.source && 'folder' in row.source ? row.source.folder : undefined)
  const problem = row.checking ? undefined : row.check?.problem
  const showName = filled && row.check?.name !== undefined && problem?.kind !== 'primary-elsewhere'
  const badName = nameProblem(row, rows)
  const label = row.check?.repo ?? (fromFolder ? undefined : row.text.trim())
  const folderNote = folder === undefined ? undefined : protectedFolderNote(folder, home, onMac)
  const canDrop = !isPrimary && dragging !== undefined && dragging !== index

  return (
    <fieldset
      className={`${styles.row} ${problem ? styles.problemRow : ''}`}
      aria-label={isPrimary ? 'Primary repo' : `Repo ${index + 1}`}
      onDragOver={(event) => {
        if (canDrop) event.preventDefault()
      }}
      onDrop={(event) => canDrop && onDrop(event)}
    >
      <div className={styles.rowHead}>
        {isPrimary ? (
          <span className={styles.primary}>Primary</span>
        ) : (
          <span
            className={styles.handle}
            draggable
            role="img"
            aria-label="Drag to reorder"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              onDragStart()
            }}
            onDragEnd={onDragEnd}
          >
            ⠿
          </span>
        )}
        {filled && label !== undefined && label !== '' && (
          <span className={styles.repo}>{label}</span>
        )}
        {filled && folder !== undefined && (
          <span className={styles.folder}>{shortPath(folder, home)}</span>
        )}
        <span className={styles.spacer} />
        {filled && (
          <span className={styles.from}>{fromFolder ? 'from a folder' : 'from a URL'}</span>
        )}
        {(!isPrimary || filled) && (
          <ActionButton
            type="button"
            className={styles.remove}
            aria-label={isPrimary ? 'Clear the primary repo' : 'Remove this repo'}
            onClick={onRemove}
          >
            <CloseIcon size={12} />
          </ActionButton>
        )}
      </div>

      {!filled && (
        <div className={styles.source}>
          <Button onClick={onChooseFolder}>Choose folder…</Button>
          <span className={styles.or}>or</span>
          <input
            ref={inputRef}
            className={styles.input}
            aria-label="GitHub URL or owner/repo"
            placeholder="GitHub URL or owner/repo"
            value={row.text}
            onChange={(event) => onText(event.target.value)}
            onBlur={onSubmitRemote}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onSubmitRemote()
              }
            }}
          />
        </div>
      )}

      {showName && (
        <div className={styles.nameRow}>
          <label className={styles.nameLabel} htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            className={`${styles.input} ${styles.nameInput} ${badName ? styles.invalid : ''}`}
            value={row.name}
            onChange={(event) => onName(event.target.value)}
          />
          <Help>
            A short label for this repo, used for worktree folders and Checks. Lowercase letters,
            digits and -.
          </Help>
          {badName && <span className={styles.keyError}>{badName}</span>}
        </div>
      )}

      {filled && folderNote !== undefined && <p className={styles.note}>{folderNote}</p>}
      {filled && row.checking && <p className={styles.checking}>○ Checking access…</p>}
      {filled && !row.checking && row.check?.ok && (
        <p className={styles.ok}>
          <span aria-hidden>✓</span> Can push and open pull requests
        </p>
      )}
      {problem && (
        <>
          <p className={styles.problem}>
            <span aria-hidden>✕</span> {problem.text}
          </p>
          {problem.detail !== undefined && !settingUp && (
            <p className={styles.detail}>{problem.detail}</p>
          )}
          {settingUp && folder !== undefined ? (
            <GitHubSetupForm
              folder={folder}
              onCancel={() => setSettingUp(false)}
              onDone={() => {
                setSettingUp(false)
                onFix({ kind: 'check-again' })
              }}
            />
          ) : (
            problem.fixes.length > 0 && (
              <div className={styles.fixes}>
                {problem.fixes.map((f) => (
                  <Button
                    key={f.kind}
                    onClick={() => (f.kind === 'set-up-github' ? setSettingUp(true) : onFix(f))}
                  >
                    {fixLabel(f)}
                  </Button>
                ))}
              </div>
            )
          )}
        </>
      )}
      {filled &&
        !row.checking &&
        row.check?.ok &&
        row.check.notes.map((note) => (
          <p key={note} className={styles.note}>
            <span aria-hidden>ⓘ</span> {note}
          </p>
        ))}
    </fieldset>
  )
}

function fixLabel(fix: RepoFix): string {
  switch (fix.kind) {
    case 'open-factory':
      return `Open ${fix.factoryName}`
    case 'check-again':
      return 'Check again'
    case 'github-settings':
      return 'GitHub settings'
    case 'choose-folder':
      return 'Choose folder…'
    case 'set-up-github':
      return 'Set up a GitHub repo…'
  }
}

function readableError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
