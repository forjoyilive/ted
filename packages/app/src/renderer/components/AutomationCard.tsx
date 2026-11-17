import type { AutomationCard as Card } from '@ted/protocol'
import { automationCardHeadline } from '@ted/protocol/automation-card'
import { useId, useState } from 'react'
import { firingDate } from '../automations.ts'
import { clockTime } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import styles from './AutomationCard.module.css'
import { Button } from './Button.tsx'

const verbs = { create: 'Create', edit: 'Save', delete: 'Delete' } as const

function resultText(card: Card): string {
  const answer = card.answer
  if (!answer) return ''
  const at = clockTime(answer.at)
  if (answer.decision === 'cancel') return `Canceled at ${at}. Nothing changed.`
  if (answer.refused !== undefined) return `Not done: ${answer.refused}. Nothing changed.`
  const started = answer.startTasks ? ', with Start the Tasks it creates on' : ''
  if (card.kind === 'create') return `Created at ${at}${started}.`
  if (card.kind === 'edit') return `Saved at ${at}${started}.`
  return `Deleted at ${at}.`
}

export function AutomationCard({
  chatId,
  card,
  agentName,
  onOpenAutomation,
}: {
  chatId: string
  card: Card
  agentName: string
  onOpenAutomation: (id: string) => void
}) {
  const id = useId()
  const [startTasks, setStartTasks] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const answered = card.answer
  const heading = automationCardHeadline(card)
  const answer = async (decision: 'confirm' | 'cancel') => {
    setBusy(true)
    setError(undefined)
    try {
      await ted.answerAutomationCard(chatId, card.id, {
        decision,
        ...(decision === 'confirm' && card.offersStartTasks && { startTasks }),
      })
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setBusy(false)
    }
  }
  const changes = card.kind === 'edit'
  const opens =
    answered?.decision === 'confirm' &&
    answered.refused === undefined &&
    answered.automationId !== undefined
  return (
    <section
      className={styles.card}
      aria-label={heading}
      data-automation-card={card.id}
      data-answered={answered ? answered.decision : undefined}
    >
      <header className={styles.header}>
        <h3>{heading}</h3>
        <p className={styles.from}>{`Drafted by ${agentName} · ${clockTime(card.askedAt)}`}</p>
      </header>
      {!answered && card.kind === 'create' && (
        <p className={styles.body}>Nothing is saved until you click Create.</p>
      )}
      {!answered && card.kind === 'delete' && (
        <p className={styles.body}>
          Its history goes with it, and an open Run stops. Tasks it created stay. This can’t be
          undone.
        </p>
      )}
      {changes ? (
        <table className={styles.diff}>
          <thead>
            <tr>
              <th scope="col">
                <span className={styles.hidden}>Setting</span>
              </th>
              <th scope="col">Now</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {card.rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td className={styles.old}>
                  <span className={row.long ? styles.long : undefined}>{row.before}</span>
                </td>
                <td className={styles.new}>
                  <span className={row.long ? styles.long : undefined}>{row.value}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <dl className={styles.fields}>
          {card.rows.map((row) => (
            <div key={row.label} className={styles.field}>
              <dt>{row.label}</dt>
              <dd>
                <span className={row.long ? styles.long : undefined}>{row.value}</span>
                {row.label === 'Schedule' && card.nextFirings.length > 0 && (
                  <span className={styles.next}>
                    {`Next: ${card.nextFirings.map(firingDate).join(' · ')}`}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {changes && <p className={styles.note}>The settings not listed stay as they are.</p>}
      {!answered && card.offersStartTasks && (
        <label className={styles.check} htmlFor={`${id}-start-tasks`}>
          <input
            id={`${id}-start-tasks`}
            type="checkbox"
            checked={startTasks}
            disabled={busy}
            onChange={(event) => setStartTasks(event.target.checked)}
          />
          <span>
            Start the Tasks it creates
            <span className={styles.checkNote}>
              {`The check’s agent may start the Tasks it files; they wait for a free slot like any other Task. Only you can turn this on, not ${agentName}.`}
            </span>
          </span>
        </label>
      )}
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {answered ? (
        <p className={answered.refused === undefined ? styles.done : styles.refused}>
          {resultText(card)}
          {opens && (
            <>
              {' '}
              <Button
                size="small"
                onClick={() => answered.automationId && onOpenAutomation(answered.automationId)}
              >
                Open in Automations
              </Button>
            </>
          )}
        </p>
      ) : (
        <footer className={styles.footer}>
          <span className={styles.waiting}>Also waiting in your Inbox</span>
          <Button disabled={busy} onClick={() => answer('cancel')}>
            Cancel
          </Button>
          <Button
            variant={card.kind === 'delete' ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => answer('confirm')}
          >
            {verbs[card.kind]}
          </Button>
        </footer>
      )}
    </section>
  )
}
