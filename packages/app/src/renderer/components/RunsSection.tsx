import type { RunSummary } from '@ted/protocol'
import { useState } from 'react'
import { runStateWord, runsCollapsedSummary } from '../details.ts'
import { ago, useNow } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import { DetailsSection } from './DetailsSection.tsx'
import { ChevronIcon, RestartIcon, StopIcon } from './icons.tsx'
import { tokenCount } from './RunChat.tsx'
import { RunIcon, type RunIconState } from './RunIcon.tsx'
import styles from './RunsSection.module.css'

export function runIconState(run: RunSummary): RunIconState {
  if (run.failed) return 'failed'
  if (run.paused !== undefined && run.state !== 'finished') return 'paused'
  if (run.onSubAgents) return 'idle'
  if (run.state === 'working') return 'working'
  if (run.state === 'waiting') return 'waiting'
  return 'idle'
}

const shortAgentNames = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' } as const

function agentLine(run: RunSummary): string {
  return [
    shortAgentNames[run.agent],
    run.model ?? 'default model',
    run.effort ?? 'default effort',
  ].join(' · ')
}

export function dollars(amount: number): string {
  return `$${amount > 0 && amount < 0.01 ? amount.toFixed(3) : amount.toFixed(2)}`
}

export function usageLine(run: RunSummary): string | undefined {
  const parts = [
    run.credential,
    run.tokens !== undefined ? tokenCount(run.tokens) : undefined,
    run.cost !== undefined ? dollars(run.cost) : undefined,
  ]
  const shown = parts.filter((p) => p !== undefined)
  return shown.length > 0 ? shown.join(' · ') : undefined
}

export function runsTabSummary(runs: readonly RunSummary[]): string {
  const tokens = runs.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
  const keyed = runs.filter((r) => r.cost !== undefined)
  const cost = keyed.reduce((sum, r) => sum + (r.cost ?? 0), 0)
  return [
    runsCollapsedSummary(runs),
    ...(tokens > 0 ? [tokenCount(tokens)] : []),
    ...(keyed.length > 0 ? [`${dollars(cost)} on API key`] : []),
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

export function liveOrder(runs: readonly RunSummary[]): { run: RunSummary; nested: boolean }[] {
  const live = runs
    .filter((r) => r.state !== 'finished')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const leads = live.filter((r) => r.role !== 'sub-agent')
  const placed = new Set<string>()
  const rows: { run: RunSummary; nested: boolean }[] = []
  for (const lead of leads) {
    rows.push({ run: lead, nested: false })
    placed.add(lead.id)
    for (const sub of live.filter((r) => r.parentRunId === lead.id)) {
      rows.push({ run: sub, nested: true })
      placed.add(sub.id)
    }
  }
  for (const run of live) if (!placed.has(run.id)) rows.push({ run, nested: true })
  return rows
}

export function RunsSection({
  runs,
  onOpenRun,
}: {
  runs: readonly RunSummary[]
  onOpenRun: (runId: string) => void
}) {
  const [showStopped, setShowStopped] = useState(false)
  if (runs.length === 0) {
    return (
      <DetailsSection id="runs">
        <p className={styles.empty}>No Runs yet</p>
      </DetailsSection>
    )
  }
  const live = liveOrder(runs)
  const stopped = runs
    .filter((r) => r.state === 'finished')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return (
    <DetailsSection id="runs" summary={runsTabSummary(runs)}>
      <ul className={styles.list}>
        {live.map(({ run, nested }) => (
          <RunRow key={run.id} run={run} nested={nested} onOpen={() => onOpenRun(run.id)} />
        ))}
      </ul>
      {stopped.length > 0 && (
        <>
          <ActionButton
            type="button"
            className={styles.toggle}
            aria-expanded={showStopped}
            onClick={() => setShowStopped((shown) => !shown)}
          >
            <ChevronIcon open={showStopped} />
            {stopped.length === 1 ? '1 stopped Run' : `${stopped.length} stopped Runs`}
          </ActionButton>
          {showStopped && (
            <ul className={styles.list}>
              {stopped.map((run) => (
                <RunRow key={run.id} run={run} nested={false} onOpen={() => onOpenRun(run.id)} />
              ))}
            </ul>
          )}
        </>
      )}
    </DetailsSection>
  )
}

function RunRow({ run, nested, onOpen }: { run: RunSummary; nested: boolean; onOpen: () => void }) {
  const now = useNow()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const live = run.state !== 'finished'
  const isLead = run.role === 'lead' && run.current
  const usage = usageLine(run)
  const act = (request: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    return request()
      .catch((failed: unknown) => setError(readableError(failed)))
      .finally(() => setBusy(false))
  }
  return (
    <li className={nested ? `${styles.row} ${styles.nested}` : styles.row} data-run={run.id}>
      <ActionButton type="button" className={styles.open} onClick={onOpen}>
        <RunIcon agent={run.agent} state={runIconState(run)} />
        <span className={styles.text}>
          <span className={styles.top}>
            <span className={styles.name}>
              {run.role === 'lead' && !run.current ? 'Earlier conversation' : run.name}
            </span>
            {live ? (
              <span className={styles.state} data-state={runIconState(run)}>
                {runStateWord(run)}
              </span>
            ) : (
              <span className={styles.state} data-state={run.failed ? 'failed' : 'idle'}>
                {run.failed ? `failed · ${ago(run.startedAt, now)}` : ago(run.startedAt, now)}
              </span>
            )}
          </span>
          <span className={styles.meta}>{agentLine(run)}</span>
          {usage !== undefined && <span className={styles.meta}>{usage}</span>}
          {error !== undefined && (
            <span className={styles.error} role="alert">
              {error}
            </span>
          )}
        </span>
      </ActionButton>
      {live && !isLead && (
        <span className={styles.actions}>
          <ActionButton
            type="button"
            className={styles.action}
            aria-label="Restart"
            title={run.state === 'working' ? 'Restart works when the Run is idle' : 'Restart'}
            disabled={busy || run.state === 'working'}
            onClick={() => act(() => ted.restartRun(run.id))}
          >
            <RestartIcon />
          </ActionButton>
          <ActionButton
            type="button"
            className={styles.action}
            aria-label="Stop Run"
            title="Stop Run"
            disabled={busy}
            onClick={() => act(() => ted.stopRun(run.id))}
          >
            <StopIcon />
          </ActionButton>
        </span>
      )}
    </li>
  )
}
