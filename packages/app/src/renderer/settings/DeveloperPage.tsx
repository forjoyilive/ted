import type { Diagnostics, LogText } from '@ted/protocol'
import {
  type DiagnosticsSort,
  isNumberColumn,
  nextSort,
  type ProcessSortColumn,
  providerName,
  type RunSortColumn,
  sortProcesses,
  sortRuns,
  type TableSort,
} from '@ted/protocol/diagnostics-sort'
import { memorySize, memorySummary, processName } from '@ted/protocol/memory'
import { shortReference } from '@ted/protocol/reference'
import { profileSeconds } from '@ted/protocol/slow'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Loading, LoadingError, Skeleton } from '../components/Loading.tsx'
import { useRefreshAction } from '../refresh-action.ts'
import { readableError, ted } from '../ted.ts'
import { Button, Select, SettingRow, SettingsGroup, SettingsPage, Switch } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './settings.module.css'

const refreshMs = 2_000
const processRefreshMs = 5_000

function usePolled<T>(load: () => Promise<T>, everyMs = refreshMs) {
  const [state, setState] = useState<{
    load: () => Promise<T>
    value?: T | undefined
    error?: string
  }>()
  const { revision: attempt, refresh: retry, settled } = useRefreshAction()
  useEffect(() => {
    void attempt
    let stopped = false
    let running = false
    setState((current) => (current?.load === load ? { load, value: current.value } : { load }))
    const tick = () => {
      if (running) return
      running = true
      return load()
        .then(
          (value) => {
            if (!stopped) setState({ load, value })
          },
          (error: unknown) => {
            if (!stopped) setState((current) => ({ ...current, load, error: readableError(error) }))
          },
        )
        .finally(() => {
          running = false
        })
    }
    void tick()?.finally(() => settled(attempt))
    const timer = setInterval(tick, everyMs)
    return () => {
      stopped = true
      settled(attempt)
      clearInterval(timer)
    }
  }, [load, everyMs, attempt, settled])
  return {
    value: state?.load === load ? state.value : undefined,
    error: state?.load === load ? state.error : undefined,
    retry,
  }
}

const gigabytes = (bytes: number) => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
const tokens = (count: number) => count.toLocaleString('en-US')

function useCopyReport() {
  const [status, setStatus] = useState<string>()
  const copy = () => {
    setStatus(undefined)
    return ted.copyReport().then(
      () => setStatus('Report copied.'),
      (error: unknown) =>
        setStatus(`Couldn’t copy the report: ${error instanceof Error ? error.message : error}`),
    )
  }
  return { status, copy }
}

function useProfile() {
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState<string>()
  const record = () => {
    setRecording(true)
    setStatus(undefined)
    return ted
      .recordProfile(profileSeconds.default)
      .then(
        ({ file }) => setStatus(`Saved to ${file}`),
        (error: unknown) => setStatus(`Couldn’t record a profile: ${readableError(error)}`),
      )
      .finally(() => setRecording(false))
  }
  return { recording, status, record }
}

export function DeveloperPage({ settings }: SettingsPageProps) {
  const [folder, setFolder] = useState<{ path: string; platform: string }>()
  const [folderProblem, setFolderProblem] = useState<string>()
  const report = useCopyReport()
  const profile = useProfile()
  const memory = usePolled(ted.memoryUse, processRefreshMs)

  useEffect(() => {
    void ted.tedFolder().then(setFolder, (error: unknown) => setFolderProblem(readableError(error)))
  }, [])

  const fileManager = folder?.platform === 'darwin' ? 'Finder' : 'file manager'

  return (
    <SettingsPage title="Developer">
      <SettingsGroup>
        <SettingRow setting="app.developer.mode">
          <Switch
            label="Developer mode"
            checked={settings.developerMode}
            onChange={(developerMode) => ted.updateSettings({ developerMode })}
          />
        </SettingRow>
        <SettingRow
          setting="app.developer.memory"
          detail={memory.value ? memorySummary(memory.value) : (memory.error ?? 'Reading…')}
        />
        <SettingRow
          setting="app.developer.folder"
          detail={
            folderProblem ?? folder?.path ?? <Loading compact label="Loading TED’s folder…" />
          }
        >
          <Button
            onClick={() => {
              setFolderProblem(undefined)
              return ted.showTedFolder().catch((error: unknown) => {
                setFolderProblem(error instanceof Error ? error.message : String(error))
              })
            }}
          >
            {`Show in ${fileManager}`}
          </Button>
        </SettingRow>
        <SettingRow
          setting="app.developer.report"
          {...(report.status !== undefined && { detail: report.status })}
        >
          <Button onClick={report.copy}>Copy report</Button>
        </SettingRow>
        <SettingRow
          setting="app.developer.profile"
          help={`Records where TED’s background process spends its time for ${profileSeconds.default} seconds and saves a .cpuprofile file in TED’s folder, under logs/profiles. Open it in Chrome DevTools or VS Code. The file lists TED’s own functions and file paths, with no Task content, prompts or tokens. TED keeps the newest five. Nothing is uploaded.`}
          {...(profile.status !== undefined && { detail: profile.status })}
        >
          <Button disabled={profile.recording} onClick={profile.record}>
            {profile.recording ? 'Recording…' : `Record ${profileSeconds.default} seconds`}
          </Button>
        </SettingRow>
      </SettingsGroup>

      {settings.developerMode && (
        <>
          <SettingsGroup>
            <SettingRow
              setting="app.developer.onboarding"
              {...(settings.onboardingOnNextOpen
                ? { detail: 'Onboarding will show the next time TED opens.' }
                : settings.guideNextFactory && {
                    detail: 'The next Factory you add gets the setup guide.',
                  })}
            >
              <Button
                onClick={() => {
                  const on = !(settings.onboardingOnNextOpen || settings.guideNextFactory)
                  return ted.updateSettings({ onboardingOnNextOpen: on, guideNextFactory: on })
                }}
              >
                {settings.onboardingOnNextOpen || settings.guideNextFactory
                  ? 'Undo'
                  : 'Show on next open'}
              </Button>
            </SettingRow>
          </SettingsGroup>
          <DeveloperTools sort={settings.diagnosticsSort} onCopyReport={report.copy} />
        </>
      )}
    </SettingsPage>
  )
}

function DeveloperTools({
  sort,
  onCopyReport,
}: {
  sort: DiagnosticsSort
  onCopyReport: () => void
}) {
  const resource = usePolled(loadDiagnostics, processRefreshMs)
  const diagnostics = resource.value
  return (
    <>
      {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
      {diagnostics === undefined ? (
        !resource.error && <Skeleton shape="settings" label="Loading diagnostics…" />
      ) : (
        <DiagnosticsView diagnostics={diagnostics} sort={sort} onCopyReport={onCopyReport} />
      )}
      <LogViewer runs={diagnostics?.runs.map((r) => r.runId) ?? []} />
    </>
  )
}

async function loadDiagnostics(): Promise<Diagnostics> {
  const [diagnostics, own] = await Promise.all([ted.getDiagnostics(), ted.appProcesses()])
  return { ...diagnostics, processes: [...diagnostics.processes, ...own] }
}

interface Column<Key extends string> {
  key: Key
  label: string
  width?: number
}

const runColumns: readonly Column<RunSortColumn>[] = [
  { key: 'run', label: 'Run', width: 88 },
  { key: 'provider', label: 'Provider', width: 120 },
  { key: 'state', label: 'State' },
  { key: 'cpu', label: 'CPU', width: 80 },
  { key: 'memory', label: 'Memory', width: 96 },
  { key: 'tokensIn', label: 'Tokens in', width: 120 },
  { key: 'tokensOut', label: 'Tokens out', width: 120 },
]

const processColumns: readonly Column<ProcessSortColumn>[] = [
  { key: 'pid', label: 'PID', width: 72 },
  { key: 'command', label: 'Command' },
  { key: 'name', label: 'What it is', width: 200 },
  { key: 'cpu', label: 'CPU', width: 80 },
  { key: 'memory', label: 'Memory', width: 96 },
]

function SortableTable<Key extends RunSortColumn | ProcessSortColumn>({
  label,
  columns,
  sort,
  onSort,
  children,
}: {
  label: string
  columns: readonly Column<Key>[]
  sort: TableSort<Key>
  onSort: (sort: TableSort<Key>) => void
  children: ReactNode
}) {
  return (
    <table className={styles.table} aria-label={label}>
      <colgroup>
        {columns.map((column) => (
          <col key={column.key} style={{ width: column.width }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((column) => {
            const active = sort.column === column.key
            return (
              <th
                key={column.key}
                className={isNumberColumn(column.key) ? styles.number : undefined}
                aria-sort={active ? sort.direction : undefined}
              >
                <button
                  type="button"
                  className={styles.sortButton}
                  onClick={() => onSort(nextSort(sort, column.key))}
                >
                  {column.label}
                  <span className={styles.sortArrow} aria-hidden="true">
                    {active && sort.direction === 'ascending' ? '▲' : '▼'}
                  </span>
                </button>
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

function Cell({
  text,
  title = text,
  number = false,
  mono = false,
}: {
  text: string
  title?: string
  number?: boolean
  mono?: boolean
}) {
  const classes = [number && styles.number, mono && styles.mono].filter(Boolean).join(' ')
  return (
    <td className={classes || undefined} title={title}>
      {text}
    </td>
  )
}

function DiagnosticsView({
  diagnostics,
  sort,
  onCopyReport,
}: {
  diagnostics: Diagnostics | undefined
  sort: DiagnosticsSort
  onCopyReport: () => void
}) {
  const memory = diagnostics?.memory
  const used = memory ? memory.totalBytes - memory.availableBytes : 0
  const usedPercent = memory ? Math.round((used / memory.totalBytes) * 100) : 0
  const [chosen, setChosen] = useState(sort)
  const saving = useRef(0)
  useEffect(() => {
    if (saving.current === 0) setChosen(sort)
  }, [sort])
  const saveSort = (change: Partial<DiagnosticsSort>) => {
    const next = { ...chosen, ...change }
    setChosen(next)
    saving.current += 1
    return ted.updateSettings({ diagnosticsSort: next }).finally(() => {
      saving.current -= 1
    })
  }

  return (
    <section className={`${styles.group} ${styles.wideGroup}`} aria-label="Diagnostics">
      <div className={styles.groupHeader}>
        <h2 className={styles.groupLabel} data-setting="app.developer.diagnostics">
          Diagnostics
        </h2>
        <Button onClick={onCopyReport}>Copy report</Button>
      </div>
      <div className={styles.box}>
        <SettingRow
          setting="app.developer.diagnostics.memory"
          detail={
            memory
              ? `${usedPercent}% in use · ${gigabytes(memory.availableBytes)} available of ${gigabytes(memory.totalBytes)}`
              : 'Reading…'
          }
        />
        <div className={styles.tableRow}>
          <h3 className={styles.tableTitle}>Runs</h3>
          {diagnostics && diagnostics.runs.length === 0 ? (
            <p className={styles.tableEmpty}>No Runs yet.</p>
          ) : (
            <SortableTable
              label="Runs"
              columns={runColumns}
              sort={chosen.runs}
              onSort={(runs) => saveSort({ runs })}
            >
              {sortRuns(diagnostics?.runs ?? [], chosen.runs).map((run) => {
                const live = run.state !== 'finished'
                return (
                  <tr key={run.runId}>
                    <Cell text={shortReference(run.runId)} title={run.runId} mono />
                    <Cell text={providerName(run)} />
                    <Cell text={run.state} />
                    <Cell text={live ? `${run.cpuPercent}%` : '–'} number />
                    <Cell text={live ? memorySize(run.memoryBytes) : '–'} number />
                    <Cell text={tokens(run.tokens.input)} number />
                    <Cell text={tokens(run.tokens.output)} number />
                  </tr>
                )
              })}
            </SortableTable>
          )}
        </div>
        <div className={styles.tableRow}>
          <h3 className={styles.tableTitle} data-setting="app.developer.processes">
            Processes
          </h3>
          <SortableTable
            label="Processes"
            columns={processColumns}
            sort={chosen.processes}
            onSort={(processes) => saveSort({ processes })}
          >
            {sortProcesses(diagnostics?.processes ?? [], chosen.processes).map((process) => (
              <tr key={process.pid}>
                <Cell text={String(process.pid)} number mono />
                <Cell text={process.command} mono />
                <Cell text={processName(process)} />
                <Cell text={`${process.cpuPercent}%`} number />
                <Cell text={memorySize(process.memoryBytes)} number />
              </tr>
            ))}
          </SortableTable>
        </div>
      </div>
    </section>
  )
}

const daemonLog = 'daemon'

function LogViewer({ runs }: { runs: string[] }) {
  const [source, setSource] = useState(daemonLog)
  const load = useCallback(
    () => (source === daemonLog ? ted.readDaemonLog() : ted.readRunOutput(source)),
    [source],
  )
  const resource = usePolled<LogText>(load)
  const log = resource.value
  const view = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  const text =
    log === undefined
      ? (resource.error ?? <Loading terminal label="Loading log…" />)
      : `${log.truncated ? '… earlier lines not shown\n' : ''}${log.text || 'Empty.'}`

  useEffect(() => {
    const element = view.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  })

  const options = [
    { value: daemonLog, label: 'Daemon log' },
    ...runs.map((runId) => ({ value: runId, label: `Run ${shortReference(runId)} raw output` })),
  ]

  return (
    <section className={styles.group} aria-label="Logs">
      <div className={styles.groupHeader}>
        <h2 className={styles.groupLabel} data-setting="app.developer.logs">
          <label htmlFor="log-source">Log</label>
        </h2>
        <Select id="log-source" value={source} options={options} onChange={setSource} width={260} />
      </div>
      {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
      <pre
        ref={view}
        className={styles.log}
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
      >
        {text}
      </pre>
    </section>
  )
}
