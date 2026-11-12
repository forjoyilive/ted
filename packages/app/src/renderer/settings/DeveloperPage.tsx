import type { Diagnostics, LogText, ProcessInfo } from '@ted/protocol'
import { profileSeconds } from '@ted/protocol/slow'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loading, LoadingError, Skeleton } from '../components/Loading.tsx'
import { readableError, ted } from '../ted.ts'
import { Button, Select, SettingRow, SettingsGroup, SettingsPage, Switch } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './settings.module.css'

const refreshMs = 2_000

function usePolled<T>(load: () => Promise<T>) {
  const [state, setState] = useState<{
    load: () => Promise<T>
    value?: T | undefined
    error?: string
  }>()
  const [attempt, setAttempt] = useState(0)
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
    void tick()
    const timer = setInterval(tick, refreshMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [load, attempt])
  return {
    value: state?.load === load ? state.value : undefined,
    error: state?.load === load ? state.error : undefined,
    retry: () => setAttempt((n) => n + 1),
  }
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`
const gigabytes = (bytes: number) => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
const tokens = (count: number) => count.toLocaleString('en-US')
const shortId = (id: string) => id.slice(0, 8)

function useCopyReport() {
  const [status, setStatus] = useState<string>()
  const copy = () => {
    setStatus(undefined)
    ted.copyReport().then(
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
    ted
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

  useEffect(() => {
    void ted.tedFolder().then(setFolder, (error: unknown) => setFolderProblem(readableError(error)))
  }, [])

  const fileManager = folder?.platform === 'darwin' ? 'Finder' : 'file manager'

  return (
    <SettingsPage title="Developer">
      <SettingsGroup>
        <SettingRow
          title="Developer mode"
          help="Shows a compact CPU and memory readout at the bottom left of the main screen, with detailed Run and daemon process readings and logs here. Readings refresh every two seconds while visible."
        >
          <Switch
            label="Developer mode"
            checked={settings.developerMode}
            onChange={(developerMode) => void ted.updateSettings({ developerMode })}
          />
        </SettingRow>
        <SettingRow
          title="TED’s folder"
          detail={
            folderProblem ?? folder?.path ?? <Loading compact label="Loading TED’s folder…" />
          }
        >
          <Button
            onClick={() => {
              setFolderProblem(undefined)
              ted.showTedFolder().catch((error: unknown) => {
                setFolderProblem(error instanceof Error ? error.message : String(error))
              })
            }}
          >
            {`Show in ${fileManager}`}
          </Button>
        </SettingRow>
        <SettingRow
          title="Copy report"
          help="Copies TED’s version, your Runs and the end of the daemon’s log to the clipboard, for you to paste into a bug report. Nothing is uploaded. TED sends no telemetry."
          {...(report.status !== undefined && { detail: report.status })}
        >
          <Button onClick={report.copy}>Copy report</Button>
        </SettingRow>
        <SettingRow
          title="Record a CPU profile"
          help={`Records where TED’s background process spends its time for ${profileSeconds.default} seconds and saves a .cpuprofile file in TED’s folder, under logs/profiles. Open it in Chrome DevTools or VS Code. The file lists TED’s own functions and file paths, with no Task content, prompts or tokens. TED keeps the newest five. Nothing is uploaded.`}
          {...(profile.status !== undefined && { detail: profile.status })}
        >
          <Button disabled={profile.recording} onClick={profile.record}>
            {profile.recording ? 'Recording…' : `Record ${profileSeconds.default} seconds`}
          </Button>
        </SettingRow>
      </SettingsGroup>

      {settings.developerMode && <DeveloperTools onCopyReport={report.copy} />}
    </SettingsPage>
  )
}

function DeveloperTools({ onCopyReport }: { onCopyReport: () => void }) {
  const resource = usePolled(ted.getDiagnostics)
  const diagnostics = resource.value
  return (
    <>
      {resource.error && <LoadingError error={resource.error} retry={resource.retry} />}
      {diagnostics === undefined ? (
        !resource.error && <Skeleton shape="settings" label="Loading diagnostics…" />
      ) : (
        <DiagnosticsView diagnostics={diagnostics} onCopyReport={onCopyReport} />
      )}
      <LogViewer runs={diagnostics?.runs.map((r) => r.runId) ?? []} />
    </>
  )
}

function owner(process: ProcessInfo): string {
  return process.owner === 'daemon' ? 'Daemon' : `Run ${shortId(process.owner.runId)}`
}

function DiagnosticsView({
  diagnostics,
  onCopyReport,
}: {
  diagnostics: Diagnostics | undefined
  onCopyReport: () => void
}) {
  const memory = diagnostics?.memory
  const used = memory ? memory.totalBytes - memory.availableBytes : 0
  const usedPercent = memory ? Math.round((used / memory.totalBytes) * 100) : 0

  return (
    <section className={styles.group} aria-label="Diagnostics">
      <div className={styles.groupHeader}>
        <h2 className={styles.groupLabel}>Diagnostics</h2>
        <Button onClick={onCopyReport}>Copy report</Button>
      </div>
      <div className={styles.box}>
        <SettingRow
          title="System memory usage"
          help="Memory in use across this computer, including other apps. This is separate from the memory used by TED’s processes below."
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
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Agent</th>
                  <th>State</th>
                  <th className={styles.number}>CPU</th>
                  <th className={styles.number}>Memory</th>
                  <th className={styles.number}>Tokens in</th>
                  <th className={styles.number}>Tokens out</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics?.runs.map((run) => (
                  <tr key={run.runId}>
                    <td className={styles.mono} title={run.runId}>
                      {shortId(run.runId)}
                    </td>
                    <td>{run.agent === 'claude' ? 'Claude Code' : 'Codex'}</td>
                    <td>{run.state}</td>
                    <td className={styles.number}>
                      {run.state === 'finished' ? '–' : `${run.cpuPercent}%`}
                    </td>
                    <td className={styles.number}>
                      {run.state === 'finished' ? '–' : megabytes(run.memoryBytes)}
                    </td>
                    <td className={styles.number}>{tokens(run.tokens.input)}</td>
                    <td className={styles.number}>{tokens(run.tokens.output)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className={styles.tableRow}>
          <h3 className={styles.tableTitle}>Processes</h3>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.number}>PID</th>
                <th>Command</th>
                <th>Belongs to</th>
                <th className={styles.number}>CPU</th>
                <th className={styles.number}>Memory</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics?.processes.map((process) => (
                <tr key={process.pid}>
                  <td className={`${styles.number} ${styles.mono}`}>{process.pid}</td>
                  <td className={styles.mono}>{process.command}</td>
                  <td>{owner(process)}</td>
                  <td className={styles.number}>{process.cpuPercent}%</td>
                  <td className={styles.number}>{megabytes(process.memoryBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
    ...runs.map((runId) => ({ value: runId, label: `Run ${shortId(runId)} raw output` })),
  ]

  return (
    <section className={styles.group} aria-label="Logs">
      <div className={styles.groupHeader}>
        <h2 className={styles.groupLabel}>
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
