import type { Task } from '@ted/protocol'
import { useState } from 'react'
import { ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './GitHubSourceField.module.css'

export function gitHubSourceFacts(github: NonNullable<Task['source']>['github'] & {}): string {
  const state = github.state === 'closed' ? 'Closed' : 'Open'
  const where = `${github.locked ? `${state} and locked` : state} on GitHub`
  const comments = `${github.comments} ${github.comments === 1 ? 'comment' : 'comments'}`
  const hidden =
    github.hiddenComments > 0 ? `, ${github.hiddenComments} hidden on GitHub left out` : ''
  const imported = formatDate(github.importedAt, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${where} · ${comments}${hidden} · imported ${imported}`
}

export function GitHubSourceField({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const github = task.source?.github
  if (!github) return null
  return (
    <span className={styles.field}>
      <ActionButton
        type="button"
        className={styles.link}
        onClick={() => void ted.openTaskSource(task.id)}
      >
        {`GitHub · ${github.repo}#${github.number} · ${github.title} ↗`}
      </ActionButton>
      <span className={styles.facts}>{gitHubSourceFacts(github)}</span>
      {github.outsiderText && (
        <span className={styles.outsider}>Includes text from people outside the repo</span>
      )}
      <ActionButton
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        {open ? 'Hide issue text' : 'Show issue text'}
      </ActionButton>
      {open && <pre className={styles.text}>{github.context}</pre>}
    </span>
  )
}
