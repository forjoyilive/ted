import type { Comment, RunSummary, Task } from '@ted/protocol'
import { useState } from 'react'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import { RequestCard } from './RequestCard.tsx'
import { RunChat } from './RunChat.tsx'
import { agentNames } from './RunIcon.tsx'
import styles from './TalkThrough.module.css'

function questionCount(request: Comment): string {
  const count = request.round?.questions.length ?? 0
  return `${count} ${count === 1 ? 'question' : 'questions'}`
}

function TalkHeader({
  run,
  request,
  task,
  onBack,
}: {
  run: RunSummary
  request: Comment
  task: Task
  onBack: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const done = request.talk?.doneAt !== undefined
  return (
    <header className={styles.header}>
      <div className={styles.crumbs}>
        <button type="button" className={styles.back} onClick={onBack}>
          ← Task Lead
        </button>
        <span className={styles.task}>{`${task.displayId} · ${task.title}`}</span>
      </div>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{`Talking through Round ${request.round?.number ?? ''}`}</h1>
        <Button
          size="small"
          disabled={busy || done}
          title={done ? 'The Task Lead is writing its summary' : undefined}
          onClick={() => {
            setBusy(true)
            setError(undefined)
            ted
              .doneTalking(request.id)
              .catch((failed: unknown) => setError(readableError(failed)))
              .finally(() => setBusy(false))
          }}
        >
          {done ? 'Writing the summary…' : 'Done talking'}
        </Button>
      </div>
      <p className={styles.meta}>
        {[run.name, agentNames[run.agent], run.model, run.effort && `${run.effort} effort`]
          .filter((part) => part !== undefined && part !== '')
          .join(' · ')}
      </p>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </header>
  )
}

function RoundStrip({ request, task }: { request: Comment; task: Task }) {
  const [showing, setShowing] = useState(false)
  return (
    <div className={styles.stripWrap}>
      <div className={styles.strip}>
        <span className={styles.kind}>Clarify round</span>
        <span className={styles.stripText}>
          {` · Round ${request.round?.number ?? ''} · ${questionCount(request)} · open while you talk`}
        </span>
        <button
          type="button"
          className={styles.show}
          aria-expanded={showing}
          onClick={() => setShowing(!showing)}
        >
          {showing ? 'Hide' : 'Show'}
        </button>
      </div>
      {showing && (
        <div className={styles.card}>
          <RequestCard request={request} task={task} />
        </div>
      )}
    </div>
  )
}

export function TalkThrough({
  request,
  task,
  onBack,
}: {
  request: Comment
  task: Task
  onBack: () => void
}) {
  const runId = request.talk?.runId ?? ''
  return (
    <RunChat
      key={runId}
      runId={runId}
      header={(run) => <TalkHeader run={run} request={request} task={task} onBack={onBack} />}
      pinned={<RoundStrip request={request} task={task} />}
      placeholder="Message the Task Lead…"
    />
  )
}
