import type { AsanaChoicesPage, AsanaIntakeCheck, AsanaIntakeScope, AsanaRef } from '@ted/protocol'
import { memo, useCallback, useEffect, useId, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Select } from '../components/Select.tsx'
import { useConnection, useSettings } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import styles from './FactorySettings.module.css'
import { Toggle } from './FactorySettingsSections.tsx'

type Part = 'workspace' | 'project' | 'section'

interface Choice {
  on: boolean
  workspace?: AsanaRef
  project?: AsanaRef
  section?: AsanaRef
}

interface PagedList {
  items: AsanaRef[]
  nextOffset?: string
  loading: boolean
  error?: string
  more: () => void
}

function usePagedList(
  load: ((offset?: string) => Promise<AsanaChoicesPage>) | undefined,
  key: string,
): PagedList {
  const [state, setState] = useState<{
    key: string
    items: AsanaRef[]
    nextOffset?: string
    loading: boolean
    error?: string
  }>({ key: '', items: [], loading: false })
  const fetchPage = useCallback(
    (offset: string | undefined, items: AsanaRef[]) => {
      if (!load) return () => {}
      let live = true
      setState({ key, items, loading: true })
      load(offset).then(
        (page) => {
          if (!live) return
          const seen = new Set(items.map((item) => item.gid))
          setState({
            key,
            items: [...items, ...page.items.filter((item) => !seen.has(item.gid))],
            ...(page.nextOffset !== undefined && { nextOffset: page.nextOffset }),
            loading: false,
          })
        },
        (failure: unknown) => {
          if (live)
            setState({
              key,
              items,
              ...(offset !== undefined && { nextOffset: offset }),
              loading: false,
              error: readableError(failure),
            })
        },
      )
      return () => {
        live = false
      }
    },
    [load, key],
  )
  useEffect(() => fetchPage(undefined, []), [fetchPage])
  const current: Omit<PagedList, 'more'> =
    state.key === key ? state : { items: [], loading: !!load }
  return {
    ...current,
    more: () => {
      if (current.nextOffset !== undefined) fetchPage(current.nextOffset, current.items)
    },
  }
}

const fromScope = (scope: AsanaIntakeScope | undefined): Choice =>
  scope
    ? {
        on: true,
        workspace: scope.workspace,
        project: scope.project,
        ...(scope.section && { section: scope.section }),
      }
    : { on: false }

const sameChoice = (a: Choice, b: Choice) =>
  a.on === b.on &&
  (!a.on ||
    (a.workspace?.gid === b.workspace?.gid &&
      a.project?.gid === b.project?.gid &&
      a.section?.gid === b.section?.gid))

const staleIn = (choice: Choice, saved: Choice, part: Part) => {
  const parts: Part[] =
    part === 'workspace'
      ? ['workspace']
      : part === 'project'
        ? ['workspace', 'project']
        : ['workspace', 'project', 'section']
  return choice.on && parts.every((p) => choice[p]?.gid === saved[p]?.gid)
}

export const AsanaIntakeSection = memo(function AsanaIntakeSection({
  factoryId,
}: {
  factoryId: string
}) {
  const settings = useSettings()
  const scope = settings?.asanaIntakeScopes[factoryId]
  const saved = fromScope(scope)
  const [draft, setDraft] = useState<Choice>()
  const choice = draft ?? saved
  const [connected, setConnected] = useState<boolean>()
  const [check, setCheck] = useState<AsanaIntakeCheck>()
  const [saveError, setSaveError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  const { epoch } = useConnection()
  const id = useId()
  const scopeKey = JSON.stringify(scope ?? null)

  useEffect(() => {
    void epoch
    void retry
    void scopeKey
    let live = true
    setCheck(undefined)
    void ted
      .getAsana()
      .then(async (status) => {
        if (!live) return
        setConnected(status.state === 'connected')
        if (status.state !== 'connected') return
        const checked = await ted.checkFactoryAsanaIntake(factoryId)
        if (live) setCheck(checked)
      })
      .catch((failure: unknown) => {
        if (live) setCheck({ state: 'unreadable', reason: readableError(failure) })
      })
    return () => {
      live = false
    }
  }, [epoch, retry, scopeKey, factoryId])

  const listKey = `${epoch}:${retry}`
  const workspaceGid = choice.workspace?.gid
  const projectGid = choice.project?.gid
  const loadWorkspaces = useCallback((offset?: string) => ted.listAsanaWorkspaces(offset), [])
  const loadProjects = useCallback(
    (offset?: string) => ted.listAsanaProjects(workspaceGid ?? '', offset),
    [workspaceGid],
  )
  const loadSections = useCallback(
    (offset?: string) => ted.listAsanaSections(projectGid ?? '', offset),
    [projectGid],
  )
  const ready = connected === true && choice.on
  const workspaces = usePagedList(ready ? loadWorkspaces : undefined, listKey)
  const projects = usePagedList(
    ready && workspaceGid ? loadProjects : undefined,
    `${listKey}:${workspaceGid}`,
  )
  const sections = usePagedList(
    ready && projectGid ? loadSections : undefined,
    `${listKey}:${projectGid}`,
  )

  const stale = check?.state === 'stale' ? check : undefined
  const staleNow = stale !== undefined && staleIn(choice, saved, stale.part)
  const dirty = draft !== undefined && !sameChoice(draft, saved)
  const canSave =
    dirty && !saving && (!choice.on || (!!choice.workspace && !!choice.project && !staleNow))

  function edit(change: Partial<Choice>) {
    setSaveError(undefined)
    setDraft({ ...choice, ...change })
  }

  async function save() {
    setSaving(true)
    setSaveError(undefined)
    try {
      await ted.setFactoryAsanaIntake(
        factoryId,
        choice.on && choice.workspace && choice.project
          ? {
              workspace: choice.workspace,
              project: choice.project,
              ...(choice.section && { section: choice.section }),
            }
          : null,
      )
      setDraft(undefined)
    } catch (failure) {
      setSaveError(readableError(failure))
    } finally {
      setSaving(false)
    }
  }

  const savedLabel = scope
    ? `${scope.project.name}${scope.section ? ` › ${scope.section.name}` : ''} · ${scope.workspace.name}`
    : 'Off'
  const listError = workspaces.error ?? projects.error ?? sections.error
  const unreadable = check?.state === 'unreadable' ? check.reason : undefined

  function picker(
    part: Part,
    label: string,
    list: PagedList,
    plural: string,
    onPick: (ref: AsanaRef | undefined) => void,
    empty?: string,
  ) {
    const value = choice[part]
    const known = value && list.items.some((item) => item.gid === value.gid)
    const savedHere = value && saved[part]?.gid === value.gid
    const staleHere = savedHere && staleNow && stale?.part === part
    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-${part}`}>
          {label}
        </label>
        <Select
          fullWidth
          id={`${id}-${part}`}
          controlClassName={styles.select}
          disabled={saving || !!list.error || (list.loading && list.items.length === 0)}
          value={value?.gid ?? ''}
          onChange={(event) => {
            const gid = event.target.value
            onPick(gid === '' ? undefined : list.items.find((item) => item.gid === gid))
          }}
        >
          <option value="" disabled={empty === undefined}>
            {empty ?? `Choose a ${part}…`}
          </option>
          {value && !known && (
            <option value={value.gid} disabled={staleHere}>
              {value.name}
              {staleHere ? ' (saved; no longer in Asana)' : savedHere ? ' (saved)' : ''}
            </option>
          )}
          {list.items.map((item) => (
            <option key={item.gid} value={item.gid}>
              {item.name}
            </option>
          ))}
        </Select>
        {list.loading && <span className={styles.caption}>Loading {plural}…</span>}
        {!list.loading && list.nextOffset !== undefined && !list.error && (
          <div>
            <span className={styles.caption}>
              Showing {list.items.length} {plural}.{' '}
            </span>
            <Button size="small" variant="quiet" onClick={list.more}>
              Load more {plural}
            </Button>
          </div>
        )}
        {!list.loading && !list.error && list.items.length === 0 && (
          <span className={styles.caption}>No {plural} found.</span>
        )}
      </div>
    )
  }

  return (
    <section
      className={`${styles.section} ${styles.compactSection}`}
      aria-labelledby={`${id}-heading`}
    >
      <div className={styles.sectionHeading} id="asana-intake" data-setting="factory.asana-intake">
        <h2 id={`${id}-heading`} className={styles.sectionTitle}>
          Asana intake
        </h2>
        <span className={styles.machineChip}>
          Saved on {navigator.userAgent.includes('Mac') ? 'this Mac' : 'this computer'}
        </span>
      </div>
      <span className={styles.caption}>
        Choose which Asana tasks Automations can bring into this Factory.
      </span>
      {connected === false ? (
        <p className={styles.caption}>
          Connect Asana in App Settings → Integrations to choose a project.
          {scope ? ' The saved choice stays as it is.' : ''}
        </p>
      ) : (
        <div data-setting="factory.asana-intake.scope">
          <div className={styles.autoStartRow}>
            <span className={styles.label}>Import Asana work into this Factory</span>
            <Toggle
              label="Import Asana work into this Factory"
              checked={choice.on}
              disabled={!settings || saving}
              onChange={(on) => edit({ on })}
            />
          </div>
          {choice.on &&
            picker('workspace', 'Workspace', workspaces, 'workspaces', (workspace) =>
              setDraft({ on: true, ...(workspace && { workspace }) }),
            )}
          {choice.on &&
            choice.workspace &&
            picker('project', 'Project', projects, 'projects', (project) =>
              setDraft({
                on: true,
                ...(choice.workspace && { workspace: choice.workspace }),
                ...(project && { project }),
              }),
            )}
          {choice.on &&
            choice.workspace &&
            choice.project &&
            !(staleNow && stale?.part !== 'section') &&
            picker(
              'section',
              'Section (optional)',
              sections,
              'sections',
              (section) => {
                const { section: _, ...rest } = choice
                setSaveError(undefined)
                setDraft(section ? { ...rest, section } : rest)
              },
              'Whole project',
            )}
        </div>
      )}
      {staleNow && stale && (
        <p className={styles.fieldError} role="alert">
          The saved {stale.part} is out of date: {stale.reason}. Choose the {stale.part} again.
        </p>
      )}
      {(unreadable ?? listError) !== undefined && (
        <div>
          <p className={styles.fieldError} role="alert">
            Couldn’t read Asana: {unreadable ?? listError} The saved choice stays as it was.
          </p>
          <Button onClick={() => setRetry((value) => value + 1)}>Try again</Button>
        </div>
      )}
      {saveError && (
        <p className={styles.fieldError} role="alert">
          {saveError} The saved choice stays as it was.
        </p>
      )}
      {connected !== false && (
        <div className={styles.fieldRow}>
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            Save
          </Button>
          {dirty && (
            <Button
              disabled={saving}
              onClick={() => {
                setDraft(undefined)
                setSaveError(undefined)
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
      <span className={styles.caption} role="status">
        {saving ? 'Saving…' : settings ? `Saved: ${savedLabel}` : 'Loading saved choice…'}
      </span>
      <span className={styles.caption}>
        When its Automation runs, Asana intake imports unfinished tasks assigned to you in this
        project or section, with the tasks under them. Existing Tasks stay as they are.
      </span>
    </section>
  )
})
