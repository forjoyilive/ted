import type { Diagnostics, LogText, ProcessInfo } from '@ted/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ted } from '../ted.ts'
import { Button, Select, SettingRow, SettingsGroup, SettingsPage, Switch } from './controls.tsx'
import type { SettingsPageProps } from './sections.tsx'
import styles from './settings.module.css'

const refreshMs = 2_000

function usePolled<T>(load: () => Promise<T>): T | undefined {
  const [value, setValue] = useState<T>()

  useEffect(() => {
    let stopped = false
    setValue(undefined)
    const tick = () =>
      load().then(
        (next) => {
          if (!stopped) setValue(next)
        },
        () => {},
      )
    void tick()
    const timer = setInterval(tick, refreshMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [load])

  return value
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

export function DeveloperPage({ settings }: SettingsPageProps) {
  const [folder, setFolder] = useState<{ path: string; platform: string }>()
  const [folderProblem, setFolderProblem] = useState<string>()
  const report = useCopyReport()

  useEffect(() => {
    void ted.tedFolder().then(setFolder)
  }, [])

  const fileManager = folder?.platform === 'darwin' ? 'Finder' : 'file manager'

  return (
    <SettingsPage title="Developer">
      <SettingsGroup>
        <SettingRow
          title="Developer mode"
          help="Shows Diagnostics and a viewer for the daemon’s log and each Run’s raw output on this page."
        >
          <Switch
            label="Developer mode"
            checked={settings.developerMode}
            onChange={(developerMode) => void ted.updateSettings({ developerMode })}
          />
        </SettingRow>
        <SettingRow title="TED’s folder" detail={folderProblem ?? folder?.path ?? ' '}>
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
      </SettingsGroup>

      {settings.developerMode && <DeveloperTools onCopyReport={report.copy} />}
    </SettingsPage>
  )
}

function DeveloperTools({ onCopyReport }: { onCopyReport: () => void }) {
  const diagnostics = usePolled(ted.getDiagnostics)
  return (
    <>
      <DiagnosticsView diagnostics={diagnostics} onCopyReport={onCopyReport} />
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
  const pressure = memory ? Math.round((used / memory.totalBytes) * 100) : 0

  return (
    <section className={styles.group} aria-label="Diagnostics">
      <div className={styles.groupHeader}>
        <h2 className={styles.groupLabel}>Diagnostics</h2>
        <Button onClick={onCopyReport}>Copy report</Button>
      </div>
      <div className={styles.box}>
        <SettingRow
          title="Memory pressure"
          help="How much of this computer’s memory is in use. Above 90%, Runs slow down and the system may start to swap."
          detail={
            memory
              ? `${pressure}% in use · ${gigabytes(memory.availableBytes)} available of ${gigabytes(memory.totalBytes)}`
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
  const log = usePolled<LogText>(load)
  const view = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  const text =
    log === undefined
      ? 'Reading…'
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
