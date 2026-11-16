import type {
  BlockedChoice,
  ConfirmationChoices,
  ConfirmationTaskRef,
  CoordinatorConfirmation,
  CoordinatorConfirmationTask,
} from '@ted/protocol'
import { useState } from 'react'
import { clockTime } from '../requests.ts'
import { readableError, ted } from '../ted.ts'
import { stageName } from '../views/TaskViews.tsx'
import dialogs from './ArchiveDialogs.module.css'
import { Button } from './Button.tsx'
import styles from './ConfirmationCard.module.css'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function TaskList({ tasks }: { tasks: readonly ConfirmationTaskRef[] }) {
  return (
    <ul className={dialogs.blockedList}>
      {tasks.map((t) => (
        <li key={t.id} className={dialogs.blockedRow}>
          <span className={dialogs.blockedId}>{t.displayId}</span>
          <span className={dialogs.blockedTitle}>{t.title}</span>
        </li>
      ))}
    </ul>
  )
}

function Radio<T extends string>({
  name,
  value,
  chosen,
  label,
  help,
  disabled,
  onChoose,
}: {
  name: string
  value: T
  chosen: T
  label: string
  help: string
  disabled: boolean
  onChoose: (value: T) => void
}) {
  return (
    <label className={dialogs.choice}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={chosen === value}
        disabled={disabled}
        onChange={() => onChoose(value)}
      />
      <span>
        {label}
        <span className={dialogs.choiceHelp}>{help}</span>
      </span>
    </label>
  )
}

function CardTask({
  confirmationId,
  kind,
  task,
  choices,
  disabled,
  onChange,
}: {
  confirmationId: string
  kind: CoordinatorConfirmation['kind']
  task: CoordinatorConfirmationTask
  choices: ConfirmationChoices
  disabled: boolean
  onChange: (choices: ConfirmationChoices) => void
}) {
  const id = task.displayId
  const ending = kind === 'archive' ? 'archived' : 'deleted'
  const under = task.descendants.length
  const blocked = task.blockedTasks.length
  const together = kind === 'archive' ? 'archive' : 'delete'
  const apart = kind === 'archive' ? 'detach' : 'unparent'
  const children = choices.children ?? (kind === 'archive' ? 'archive' : 'unparent')
  const blockedChoice: BlockedChoice = choices.blocked ?? 'unblock'
  const prs = task.pullRequests.map((p) => `${p.repo} #${p.number}`).join(', ')
  return (
    <li className={styles.task} data-confirmation-task={task.id}>
      <div className={styles.taskRow}>
        <span className={styles.taskId}>{id}</span>
        <span className={styles.taskTitle}>{task.title}</span>
        <span className={styles.taskStage}>{stageName(task.stage)}</span>
      </div>
      {task.result ? (
        <p className={task.result.done ? styles.result : styles.refused}>{task.result.text}</p>
      ) : (
        (task.working || task.pullRequests.length > 0 || under > 0 || blocked > 0) && (
          <div className={styles.warn}>
            {task.working && (
              <p>{`${id}’s Task Lead is working. ${kind === 'archive' ? 'Archiving' : 'Deleting'} stops its Run.`}</p>
            )}
            {task.pullRequests.length > 0 && kind === 'delete' && (
              <p>{`${id} has ${task.pullRequests.length === 1 ? 'an open pull request' : 'open pull requests'}: ${prs}. Deleting leaves ${task.pullRequests.length === 1 ? 'it' : 'them'} open on GitHub.`}</p>
            )}
            {task.pullRequests.length > 0 && kind === 'archive' && (
              <label className={dialogs.check}>
                <input
                  type="checkbox"
                  checked={choices.closePullRequests === true}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...choices, closePullRequests: event.target.checked })
                  }
                />
                <span>
                  {task.pullRequests.length === 1
                    ? 'Close the pull request on GitHub'
                    : 'Close the pull requests on GitHub'}
                  <span className={dialogs.checkNote}>
                    {`${prs}. ${task.pullRequests.length === 1 ? 'It stays' : 'They stay'} open unless you tick this.`}
                  </span>
                </span>
              </label>
            )}
            {under > 0 && (
              <fieldset className={dialogs.blocked}>
                <legend className={dialogs.blockedHeading}>
                  {`${plural(under, 'Task is', 'Tasks are')} under ${id}`}
                </legend>
                <TaskList tasks={task.descendants} />
                <Radio
                  name={`${confirmationId}-${task.id}-children`}
                  value={together}
                  chosen={children}
                  label={`${kind === 'archive' ? 'Archive' : 'Delete'} them with ${id}`}
                  help={`Every Task under ${id} is ${ending} too.`}
                  disabled={disabled}
                  onChoose={(value) => onChange({ ...choices, children: value })}
                />
                <Radio
                  name={`${confirmationId}-${task.id}-children`}
                  value={apart}
                  chosen={children}
                  label="Detach them and keep them"
                  help={`The Tasks directly under ${id} lose their parent and carry on.`}
                  disabled={disabled}
                  onChoose={(value) => onChange({ ...choices, children: value })}
                />
              </fieldset>
            )}
            {blocked > 0 && (
              <fieldset className={dialogs.blocked}>
                <legend className={dialogs.blockedHeading}>
                  {`${plural(blocked, 'Task is', 'Tasks are')} blocked by ${id}`}
                </legend>
                <TaskList tasks={task.blockedTasks} />
                <Radio
                  name={`${confirmationId}-${task.id}-blocked`}
                  value="unblock"
                  chosen={blockedChoice}
                  label={blocked === 1 ? 'Unblock it' : 'Unblock them'}
                  help={`Removes ${id} from ${blocked === 1 ? 'its' : 'their'} Blocked by, so ${blocked === 1 ? 'it' : 'they'} can start.`}
                  disabled={disabled}
                  onChoose={(value) => onChange({ ...choices, blocked: value })}
                />
                <Radio
                  name={`${confirmationId}-${task.id}-blocked`}
                  value="keep"
                  chosen={blockedChoice}
                  label={blocked === 1 ? 'Keep it blocked' : 'Keep them blocked'}
                  help={`${blocked === 1 ? 'It stays' : 'They stay'} blocked and ${blocked === 1 ? 'shows' : 'show'} “Blocked by ${ending} ${id}”.`}
                  disabled={disabled}
                  onChoose={(value) => onChange({ ...choices, blocked: value })}
                />
              </fieldset>
            )}
          </div>
        )
      )}
    </li>
  )
}

export function confirmationCount(
  confirmation: CoordinatorConfirmation,
  choices: Record<string, ConfirmationChoices>,
): number {
  const ids = new Set<string>()
  for (const task of confirmation.tasks) {
    ids.add(task.id)
    const together = confirmation.kind === 'archive' ? 'archive' : 'delete'
    const chosen =
      choices[task.id]?.children ??
      task.children ??
      (confirmation.kind === 'archive' ? 'archive' : 'unparent')
    if (chosen === together) for (const d of task.descendants) ids.add(d.id)
  }
  return ids.size
}

export function ConfirmationCard({
  chatId,
  confirmation,
}: {
  chatId: string
  confirmation: CoordinatorConfirmation
}) {
  const [choices, setChoices] = useState<Record<string, ConfirmationChoices>>(() =>
    Object.fromEntries(
      confirmation.tasks.map((t) => [
        t.id,
        {
          ...(t.children !== undefined && { children: t.children }),
          ...(t.blocked !== undefined && { blocked: t.blocked }),
          ...(t.closePullRequests !== undefined && { closePullRequests: t.closePullRequests }),
        },
      ]),
    ),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const answered = confirmation.answer
  const deleting = confirmation.kind === 'delete'
  const count = confirmationCount(confirmation, choices)
  const noun = count === 1 ? confirmation.tasks[0]?.displayId : `${count} Tasks`
  const answer = async (decision: 'confirm' | 'cancel') => {
    setBusy(true)
    setError(undefined)
    try {
      await ted.answerCoordinatorConfirmation(chatId, confirmation.id, {
        decision,
        ...(decision === 'confirm' && { choices }),
      })
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setBusy(false)
    }
  }
  const heading = `${deleting ? 'Delete' : 'Archive'} ${
    confirmation.tasks.length === 1
      ? confirmation.tasks[0]?.displayId
      : `${confirmation.tasks.length} Tasks`
  }?`
  return (
    <section
      className={styles.card}
      aria-label={heading}
      data-confirmation={confirmation.id}
      data-answered={answered ? answered.decision : undefined}
    >
      <header className={styles.header}>
        <h3>{heading}</h3>
        <p
          className={styles.from}
        >{`Asked by the Coordinator · ${clockTime(confirmation.askedAt)}`}</p>
      </header>
      {!answered && (
        <p className={styles.body}>
          {deleting
            ? 'Deleting removes each Task with its Comments, brief, Conversations and worktree. This can’t be undone.'
            : 'Comments, the brief, Conversations and the branches are kept. You can unarchive later.'}
        </p>
      )}
      <ul className={styles.tasks}>
        {confirmation.tasks.map((task) => (
          <CardTask
            key={task.id}
            confirmationId={confirmation.id}
            kind={confirmation.kind}
            task={task}
            choices={choices[task.id] ?? {}}
            disabled={busy || answered !== undefined}
            onChange={(next) => setChoices((all) => ({ ...all, [task.id]: next }))}
          />
        ))}
      </ul>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {answered ? (
        <p className={styles.done}>
          {answered.decision === 'cancel'
            ? `Canceled at ${clockTime(answered.at)}. Nothing changed.`
            : `Confirmed at ${clockTime(answered.at)}.`}
        </p>
      ) : (
        <footer className={styles.footer}>
          <span className={styles.note}>Also waiting in your Inbox</span>
          <Button disabled={busy} onClick={() => answer('cancel')}>
            Cancel
          </Button>
          <Button
            variant={deleting ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => answer('confirm')}
          >
            {`${deleting ? 'Delete' : 'Archive'} ${noun}`}
          </Button>
        </footer>
      )}
    </section>
  )
}
