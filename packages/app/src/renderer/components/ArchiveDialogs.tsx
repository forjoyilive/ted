import type { Task, TaskHierarchyPreview, TaskMovePlan } from '@ted/protocol'
import { archiveChoice } from '@ted/protocol/task'
import { movePlanKey } from '@ted/protocol/task-move'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useFactories, useTaskRuns, useTasks } from '../data.ts'
import { childrenOf, isMerged } from '../hierarchy.ts'
import { useMessageDraft } from '../message-drafts.ts'
import { type MovePlanRow, movePlanKept, movePlanView, throwsAwayWork } from '../move-plan.ts'
import type { Stages } from '../stage-names.ts'
import { useStages } from '../stages.tsx'
import { readableError, ted } from '../ted.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './ArchiveDialogs.module.css'
import { Button } from './Button.tsx'
import { FactoryPicker } from './FactoryPicker.tsx'
import { Help } from './Help.tsx'
import grow from './TextGrow.module.css'

export const archiveTaskEvent = 'ted:archive-task'
export const deleteTaskEvent = 'ted:delete-task'
export const resetTaskEvent = 'ted:reset-task'
export const followUpTaskEvent = 'ted:follow-up-task'
export const unarchiveTaskEvent = 'ted:unarchive-task'
export const openMovedTaskEvent = 'ted:open-moved-task'

export function needsUnarchiveDialog(task: Task): boolean {
  return (task.parentId !== undefined && !isMerged(task)) || (task.childIds?.length ?? 0) > 0
}

export function unarchiveOrAsk(task: Task): Promise<unknown> | undefined {
  if (needsUnarchiveDialog(task)) {
    window.dispatchEvent(new CustomEvent(unarchiveTaskEvent, { detail: task.id }))
    return undefined
  }
  return ted.unarchiveTask(task.id)
}

function useHierarchyPreview(task: Task, wanted: boolean) {
  const [preview, setPreview] = useState<TaskHierarchyPreview>()
  const [failure, setFailure] = useState<string>()
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    if (!wanted) return
    let current = true
    void asked
    ted.taskHierarchyPreview(task.id).then(
      (next) => {
        if (current) setPreview(next)
      },
      (error: unknown) => {
        if (current) setFailure(readableError(error))
      },
    )
    return () => {
      current = false
    }
  }, [task.id, wanted, asked])
  return {
    preview: wanted ? preview : undefined,
    failure,
    ready: !wanted || preview !== undefined,
    reload: () => setAsked((n) => n + 1),
  }
}

function stateText(task: Task | undefined, stages: Stages): string {
  if (!task) return ''
  if (isMerged(task)) return 'Merged'
  if (task.archived) return 'Archived'
  return stages.name(task.stage, task.factoryId)
}

function TasksUnder({
  legend,
  ids,
  tasks,
  children,
}: {
  legend: string
  ids: readonly string[]
  tasks: readonly Task[]
  children?: ReactNode
}) {
  const stages = useStages()
  return (
    <fieldset className={styles.blocked}>
      <legend className={styles.blockedHeading}>{legend}</legend>
      {ids.length > 0 && (
        <ul className={styles.blockedList}>
          {ids.map((id) => {
            const t = tasks.find((task) => task.id === id)
            return (
              <li key={id} className={styles.blockedRow}>
                <span className={styles.blockedId}>{t?.displayId ?? 'A Task'}</span>
                <span className={styles.blockedTitle}>{t?.title ?? ''}</span>
                <span className={styles.blockedStage}>{stateText(t, stages)}</span>
              </li>
            )
          })}
        </ul>
      )}
      {children}
    </fieldset>
  )
}

function Choice<T extends string>({
  name,
  value,
  chosen,
  label,
  help,
  disabledBecause,
  onChoose,
}: {
  name: string
  value: T
  chosen: T | undefined
  label: string
  help: string
  disabledBecause?: string | undefined
  onChoose: (value: T) => void
}) {
  return (
    <label className={styles.choice} data-disabled={disabledBecause !== undefined || undefined}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={chosen === value}
        disabled={disabledBecause !== undefined}
        onChange={() => onChoose(value)}
      />
      <span>
        {label}
        <span className={styles.choiceHelp}>{disabledBecause ?? help}</span>
      </span>
    </label>
  )
}

function detachHelp(task: Task, tasks: readonly Task[], archivedToo: boolean): string {
  const direct = childrenOf(task, tasks).filter((t) => archivedToo || !t.archived).length
  return `The ${direct === 1 ? 'Task' : `${direct} Tasks`} directly under ${task.displayId} ${direct === 1 ? 'loses its' : 'lose their'} parent and carry on. Their own children stay under them.`
}

function parentWorking(parent: Task): boolean {
  const lead = parent.runs.find((run) => run.id === parent.leadRunId && run.role === 'lead')
  return lead !== undefined && lead.state !== 'finished'
}

function parentRefusal(task: Task, parent: Task): string | undefined {
  if (parent.archived)
    return `${parent.displayId} is archived. Unarchive ${parent.displayId} first to bring ${task.displayId} back as part of it.`
  if (parent.stage === 'done')
    return `${parent.displayId} is Done, so it can’t take ${task.displayId} back.`
  if (parentWorking(parent))
    return `${parent.displayId} is working, and TED doesn’t change a working Task’s children. Stop ${parent.displayId} first.`
  return undefined
}

function joinAnd(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

export function openPullRequests(task: Task) {
  return task.repos.flatMap((r) =>
    r.pullRequest && r.pullRequest.state !== 'closed' && r.pullRequest.state !== 'merged'
      ? [{ repo: r, pr: r.pullRequest }]
      : [],
  )
}

export function useBlocked(task: Task): Task[] {
  return useTasks().filter((t) => t.blockedBy.includes(task.id) && !t.archived)
}

export function Dialog({
  children,
  onClose,
  className,
}: {
  children: (headingId: string) => ReactNode
  onClose: () => void
  className?: string | undefined
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={className === undefined ? styles.dialog : `${styles.dialog} ${className}`}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      {children(headingId)}
    </dialog>
  )
}

export function unblockedBy(ids: readonly string[], all: readonly Task[]): Task[] {
  const removing = new Set(ids)
  return all.filter(
    (t) => !t.archived && !removing.has(t.id) && t.blockedBy.some((id) => removing.has(id)),
  )
}

export function UnblocksList({
  blocker,
  tasks,
}: {
  blocker: string
  tasks: readonly { id: string; displayId: string; title: string; stage?: string }[]
}) {
  const one = tasks.length === 1
  const heading = `Unblocks ${tasks.length} ${one ? 'Task' : 'Tasks'}`
  return (
    <section className={styles.blocked} aria-label={heading}>
      <h3 className={styles.unblocksHeading}>{heading}</h3>
      <ul className={styles.unblocksList}>
        {tasks.map((t) => (
          <li key={t.id} className={styles.blockedRow}>
            <span className={styles.blockedId}>{t.displayId}</span>
            <span className={styles.blockedTitle}>{t.title}</span>
            {t.stage !== undefined && <span className={styles.blockedStage}>{t.stage}</span>}
          </li>
        ))}
      </ul>
      <p className={styles.note}>
        {`TED removes ${blocker} from ${one ? 'its' : 'their'} Blocked by. ${one ? 'It doesn’t start on its' : 'They don’t start on their'} own.`}
      </p>
    </section>
  )
}

export function Unblocks({ blocker, tasks }: { blocker: string; tasks: readonly Task[] }) {
  const stages = useStages()
  if (tasks.length === 0) return null
  return (
    <UnblocksList
      blocker={blocker}
      tasks={tasks.map((t) => ({ ...t, stage: stages.name(t.stage, t.factoryId) }))}
    />
  )
}

function runsPhrase(runs: number): string {
  if (runs === 1) return 'the Task Lead’s Run'
  return `its ${runs} Runs`
}

export function ArchiveDialog({
  task,
  onClose,
  request,
}: {
  task: Task
  onClose: () => void
  request?: { id: string; closePullRequests: boolean; text?: string } | undefined
}) {
  const prs = openPullRequests(task)
  const [close, setClose] = useState(request?.closePullRequests ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const all = useTasks()
  const hasChildren = (task.childIds?.length ?? 0) > 0
  const hierarchy = useHierarchyPreview(task, hasChildren)
  const [family, setFamily] = useState<'together' | 'detach'>('together')
  const under = (hierarchy.preview?.descendants ?? [])
    .map((d) => d.id)
    .filter((id) => !all.find((t) => t.id === id)?.archived)
  const alreadyArchived = (hierarchy.preview?.descendants ?? []).filter(
    (d) => all.find((t) => t.id === d.id)?.archived,
  )
  const archiving = family === 'together' ? [task.id, ...under] : [task.id]
  const blocked = unblockedBy(archiving, all)
  const hasWorktree = task.repos.some((r) => !r.removed)
  const does = [
    ...(task.runs.length > 0 ? [`stops ${runsPhrase(task.runs.length)}`] : []),
    ...(hasWorktree ? ['removes the worktree'] : []),
  ]
  const action = does.length === 0 ? '' : ` TED ${does.join(' and ')}.`
  const kept =
    task.repos.length > 0
      ? 'Comments, the brief, Conversations and the branches are kept.'
      : 'Comments and the brief are kept.'

  async function archive() {
    setBusy(true)
    setError(undefined)
    try {
      const options = {
        closePullRequests: prs.length > 0 && close,
        ...(hierarchy.preview && {
          children: family === 'together' ? ('archive' as const) : ('detach' as const),
          hierarchyRevision: hierarchy.preview.revision,
        }),
      }
      if (request)
        await ted.answerRequest(request.id, {
          action: 'answer',
          choice: archiveChoice,
          ...(request.text !== undefined && { text: request.text }),
          archive: options,
        })
      else await ted.archiveTask(task.id, options)
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      hierarchy.reload()
      setBusy(false)
    }
  }

  return (
    <Dialog onClose={onClose}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>{`Archive ${task.displayId}?`}</h2>
          <p className={styles.body}>
            {`${task.title}.${action} ${kept} You can unarchive it later.`}
          </p>
          {hasChildren && (
            <TasksUnder
              legend={`${under.length} ${under.length === 1 ? 'Task is' : 'Tasks are'} under ${task.displayId}`}
              ids={under}
              tasks={all}
            >
              {alreadyArchived.length > 0 && (
                <p className={styles.note}>
                  {`${joinAnd(alreadyArchived.map((d) => d.displayId))} ${alreadyArchived.length === 1 ? 'is' : 'are'} already archived and won’t change.`}
                </p>
              )}
              <Choice
                name={`archive-${task.id}`}
                value="together"
                chosen={family}
                label={`Archive them with ${task.displayId}`}
                help={`Every Task under ${task.displayId} is archived too. Merged ones stay merged.`}
                onChoose={setFamily}
              />
              <Choice
                name={`archive-${task.id}`}
                value="detach"
                chosen={family}
                label="Detach them and keep them"
                help={detachHelp(task, all, false)}
                onChoose={setFamily}
              />
            </TasksUnder>
          )}
          {hierarchy.failure !== undefined && (
            <p className={styles.error} role="alert">
              {hierarchy.failure}
            </p>
          )}
          {prs.length > 0 && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={close}
                onChange={(event) => setClose(event.target.checked)}
              />
              <span>
                Close the pull requests on GitHub
                <span className={styles.checkNote}>
                  {`${joinAnd(prs.map(({ repo, pr }) => `${repo.name} #${pr.number}`))}.`}
                  <Help>Unarchive reopens them if their branches still exist.</Help>
                </span>
              </span>
            </label>
          )}
          <Unblocks
            blocker={
              archiving.length > 1 ? `${task.displayId} and the Tasks under it` : task.displayId
            }
            tasks={blocked}
          />
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy || !hierarchy.ready} onClick={() => archive()}>
              {!hasChildren
                ? 'Archive'
                : family === 'together' && under.length > 0
                  ? `Archive ${under.length + 1} Tasks`
                  : `Archive ${task.displayId}`}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

export function UnarchiveDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const all = useTasks()
  const parent = all.find((t) => t.id === task.parentId)
  const partOf = parent !== undefined && !isMerged(task)
  const refusal = partOf ? parentRefusal(task, parent) : undefined
  const working = partOf && parentWorking(parent)
  const [picked, setPlace] = useState<'together' | 'detach'>('together')
  const place = refusal === undefined ? picked : 'detach'
  const hasChildren = (task.childIds?.length ?? 0) > 0
  const hierarchy = useHierarchyPreview(task, partOf || hasChildren)
  const family = hierarchy.preview?.archivedWith ?? []
  const [withFamily, setWithFamily] = useState<'together' | 'detach'>('together')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const restoring = withFamily === 'together' ? family.length : 0

  async function unarchive() {
    setBusy(true)
    setError(undefined)
    try {
      await ted.unarchiveTask(task.id, {
        ...(partOf &&
          place === 'detach' && {
            unlinkParent: true,
            ...(hierarchy.preview && { hierarchyRevision: hierarchy.preview.revision }),
          }),
        ...(restoring > 0 && { children: 'restore' }),
      })
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      hierarchy.reload()
      setBusy(false)
    }
  }

  return (
    <Dialog onClose={onClose}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>{`Unarchive ${task.displayId}?`}</h2>
          <p className={styles.body}>
            {partOf
              ? `${task.title} is part of ${parent.displayId}.`
              : family.length > 0
                ? `${task.title}. ${family.length === 1 ? '1 Task under it was' : `${family.length} Tasks under it were`} archived with it.`
                : `${task.title}.`}
          </p>
          {partOf && (
            <TasksUnder legend="How should it come back?" ids={[]} tasks={all}>
              <Choice
                name={`place-${task.id}`}
                value="together"
                chosen={place}
                label={`Unarchive it as part of ${parent.displayId}`}
                help={`${parent.displayId} waits for ${task.displayId} to merge again.`}
                disabledBecause={refusal}
                onChoose={setPlace}
              />
              <Choice
                name={`place-${task.id}`}
                value="detach"
                chosen={place}
                label="Detach it and keep it"
                help={`${task.displayId} comes back without a parent. ${parent.displayId} isn’t affected.`}
                disabledBecause={working ? refusal : undefined}
                onChoose={setPlace}
              />
            </TasksUnder>
          )}
          {family.length > 0 && (
            <TasksUnder legend={`Archived with ${task.displayId}`} ids={family} tasks={all}>
              <Choice
                name={`family-${task.id}`}
                value="together"
                chosen={withFamily}
                label={`Unarchive them with ${task.displayId}`}
                help={`They come back under ${task.displayId}, and ${task.displayId} waits for the unmerged ones again.`}
                onChoose={setWithFamily}
              />
              <Choice
                name={`family-${task.id}`}
                value="detach"
                chosen={withFamily}
                label="Leave them archived"
                help={`Only ${task.displayId} comes back. Archived children don’t hold it, and they stay part of it.`}
                onChoose={setWithFamily}
              />
            </TasksUnder>
          )}
          {hierarchy.failure !== undefined && (
            <p className={styles.error} role="alert">
              {hierarchy.failure}
            </p>
          )}
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || !hierarchy.ready || working}
              onClick={() => unarchive()}
            >
              {restoring > 0 ? `Unarchive ${restoring + 1} Tasks` : `Unarchive ${task.displayId}`}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

export function DeleteDialog({
  task,
  onClose,
  onArchiveInstead,
}: {
  task: Task
  onClose: () => void
  onArchiveInstead: () => void
}) {
  const runs = useTaskRuns(task.id).length
  const prs = openPullRequests(task)
  const [busy, setBusy] = useState(false)
  const removing = useRef(false)
  const [error, setError] = useState<string>()
  const all = useTasks()
  const hasChildren = (task.childIds?.length ?? 0) > 0
  const hierarchy = useHierarchyPreview(task, hasChildren)
  const [family, setFamily] = useState<'together' | 'detach'>()
  const under = (hierarchy.preview?.descendants ?? []).map((d) => d.id)
  const deleting = family === 'together' ? [task.id, ...under] : [task.id]
  const blocked = unblockedBy(deleting, all)
  const removed = [
    'the Task',
    ...(runs > 0
      ? [
          `its ${runs === 1 ? 'Run with its Conversation' : `${runs} Runs with their Conversations`}`,
        ]
      : []),
    'its Comments',
    'its brief',
  ]

  async function remove() {
    if (removing.current) return
    removing.current = true
    setBusy(true)
    setError(undefined)
    try {
      await ted.deleteTask(task.id, {
        ...(hierarchy.preview && {
          children: family === 'together' ? 'delete' : 'unparent',
          hierarchyRevision: hierarchy.preview.revision,
        }),
      })
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      hierarchy.reload()
      setBusy(false)
    } finally {
      removing.current = false
    }
  }

  return (
    <Dialog onClose={() => !removing.current && !busy && onClose()}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>{`Delete ${task.displayId}?`}</h2>
          <p className={styles.body}>
            {`${task.title}. TED removes ${joinAnd(removed)}. This can’t be undone.`}
          </p>
          {hasChildren && (
            <TasksUnder
              legend={`${under.length} ${under.length === 1 ? 'Task is' : 'Tasks are'} under ${task.displayId}`}
              ids={under}
              tasks={all}
            >
              <Choice
                name={`delete-${task.id}`}
                value="together"
                chosen={family}
                label={`Delete them with ${task.displayId}`}
                help={`Every Task under ${task.displayId} is deleted too, with its history.`}
                onChoose={setFamily}
              />
              <Choice
                name={`delete-${task.id}`}
                value="detach"
                chosen={family}
                label="Detach them and keep them"
                help={detachHelp(task, all, true)}
                onChoose={setFamily}
              />
              <p className={styles.note}>
                Nothing is chosen for you here, because a delete can’t be undone.
              </p>
            </TasksUnder>
          )}
          {hierarchy.failure !== undefined && (
            <p className={styles.error} role="alert">
              {hierarchy.failure}
            </p>
          )}
          {prs.length > 0 && (
            <p className={styles.warning}>
              {`${prs.length === 1 ? 'Pull request' : 'Pull requests'} ${joinAnd(prs.map(({ pr }) => `#${pr.number}`))} stay open on GitHub, and the ${prs.length === 1 ? 'branch stays' : 'branches stay'}.${task.archived ? '' : ' Archive closes the pull requests and keeps the history.'}`}
            </p>
          )}
          <Unblocks
            blocker={
              deleting.length > 1 ? `${task.displayId} and the Tasks under it` : task.displayId
            }
            tasks={blocked}
          />
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            {!task.archived && (
              <ActionButton
                type="button"
                className={styles.instead}
                disabled={busy}
                onClick={onArchiveInstead}
              >
                Archive instead
              </ActionButton>
            )}
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy || !hierarchy.ready || (hasChildren && family === undefined)}
              onClick={() => remove()}
            >
              {busy
                ? 'Deleting…'
                : hasChildren && family === 'together'
                  ? `Delete ${under.length + 1} Tasks`
                  : `Delete ${task.displayId}`}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

export function ResetDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const runs = useTaskRuns(task.id).length
  const narrowed = useTasks().some((t) => t.splitFrom?.id === task.id)
  const prs = openPullRequests(task)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const resetting = useRef(false)
  const worktrees = task.repos.filter((r) => !r.removed)
  const branches = [...new Set(task.repos.map((r) => r.branch))]
  const thread = [
    'Comments',
    'questions and answers',
    'the Task brief',
    'Findings',
    ...(runs === 0
      ? []
      : [
          runs === 1
            ? 'the Run with its Conversation'
            : `its ${runs} Runs with their Conversations`,
        ]),
  ]
  const lost = [
    ...(worktrees.length > 0
      ? [
          `The ${worktrees.length === 1 ? 'worktree' : 'worktrees'} and any uncommitted work in ${worktrees.length === 1 ? 'it' : 'them'}`,
        ]
      : []),
    ...(branches.length > 0
      ? [
          `The ${branches.length === 1 ? 'branch' : 'branches'} ${joinAnd(branches)} and ${branches.length === 1 ? 'its' : 'their'} commits, here and on GitHub`,
        ]
      : []),
    ...(prs.length > 0
      ? [
          `${prs.length === 1 ? 'Pull request' : 'Pull requests'} ${joinAnd(prs.map(({ repo, pr }) => `${repo.name} #${pr.number}`))}, which TED closes on GitHub`,
        ]
      : []),
    `The thread: ${joinAnd(thread)}`,
    'Edits to the description, and files attached in Comments',
  ]
  const files =
    task.attachments.length === 0
      ? ''
      : ` and its ${task.attachments.length === 1 ? 'attachment' : `${task.attachments.length} attachments`}`

  async function reset() {
    if (resetting.current) return
    resetting.current = true
    setBusy(true)
    setError(undefined)
    try {
      await ted.resetTask(task.id)
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    } finally {
      resetting.current = false
    }
  }

  return (
    <Dialog onClose={() => !resetting.current && !busy && onClose()}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>{`Reset ${task.displayId}?`}</h2>
          <p className={styles.body}>
            {`${task.title}. TED throws away what this Task has done and starts it again from the first Stage with its original request. This can’t be undone.`}
          </p>
          <section className={styles.lost} aria-label="What is lost">
            <h3 className={styles.lostHeading}>What is lost</h3>
            <ul className={styles.lostList}>
              {lost.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          {narrowed && (
            <p className={styles.warning}>
              {`Split it narrowed this Task. A reset goes back to the request from before the split, so the new attempt covers the whole request again. The Tasks the split created stay as they are, and the title stays “${task.title}”.`}
            </p>
          )}
          <p className={styles.kept}>
            {`Kept: the Task ID, title, source link, priority, place in the list, blockers, and the original description${files}.`}
          </p>
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => reset()}>
              {busy ? 'Resetting…' : 'Reset Task'}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

function MovePlanRows({ rows }: { rows: readonly MovePlanRow[] }) {
  return (
    <ul className={styles.blockedList}>
      {rows.map((row) => (
        <li key={row.id} className={styles.blockedRow}>
          <span className={styles.blockedId}>{row.displayId}</span>
          <span className={styles.blockedTitle}>{row.title}</span>
          {row.note !== '' && <span className={styles.blockedStage}>{row.note}</span>}
        </li>
      ))}
    </ul>
  )
}

export function MovePlanDetails({
  plan,
  compact = false,
}: {
  plan: TaskMovePlan
  compact?: boolean
}) {
  const stages = useStages()
  if (plan.refusal !== undefined) {
    return (
      <p className={styles.refused} role="alert">
        {plan.refusal}
      </p>
    )
  }
  const view = movePlanView(plan, (stage) => stages.name(stage, plan.factoryId))
  if (!view) return null
  return (
    <div className={styles.plan}>
      <p className={styles.lands}>
        {view.landing.before}
        <b>{view.landing.newDisplayId}</b>
        {view.landing.after}
      </p>
      {view.movesWith.length > 0 && (
        <section className={styles.lost} aria-label="Moves with it">
          <h3 className={styles.lostHeading}>Moves with it</h3>
          <MovePlanRows rows={view.movesWith} />
        </section>
      )}
      {view.leavesParent !== undefined && <p className={styles.warning}>{view.leavesParent}</p>}
      {view.unlinked.length > 0 && (
        <section className={styles.lost} aria-label="Blocker links removed">
          <h3 className={styles.lostHeading}>Blocker links removed</h3>
          <MovePlanRows rows={view.unlinked} />
        </section>
      )}
      {(!compact || view.throwsAwayWork) && (
        <section className={styles.lost} aria-label={view.changesHeading}>
          <h3 className={styles.lostHeading}>{view.changesHeading}</h3>
          <ul className={styles.lostList}>
            {view.changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      <p className={styles.kept}>{movePlanKept}</p>
    </div>
  )
}

export function MoveToFactoryDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const factories = useFactories().filter((f) => f.id !== task.factoryId)
  const [factoryId, setFactoryId] = useState<string>()
  const [loaded, setLoaded] = useState<TaskMovePlan>()
  const [planError, setPlanError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const moving = useRef(false)
  useEffect(() => {
    if (factoryId === undefined) return
    let current = true
    setPlanError(undefined)
    ted.taskMovePlan(task.id, factoryId).then(
      (next) => {
        if (current) setLoaded(next)
      },
      (failure) => {
        if (current) setPlanError(readableError(failure))
      },
    )
    return () => {
      current = false
    }
  }, [task.id, factoryId])
  const plan = loaded?.factoryId === factoryId ? loaded : undefined
  const chosen = factories.find((f) => f.id === factoryId)

  async function move() {
    if (moving.current || factoryId === undefined || plan === undefined) return
    moving.current = true
    setBusy(true)
    setError(undefined)
    try {
      const moved = await ted.moveTaskToFactory(task.id, {
        factoryId,
        planKey: movePlanKey(plan),
      })
      onClose()
      window.dispatchEvent(new CustomEvent(openMovedTaskEvent, { detail: moved.task }))
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    } finally {
      moving.current = false
    }
  }

  return (
    <Dialog onClose={() => !moving.current && !busy && onClose()}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>
            {`Move ${task.displayId} to another Factory?`}
          </h2>
          <p className={styles.body}>
            {`${task.title}. It gets a new ID in the Factory you pick, and its thread comes with it.${
              task.stage === 'backlog'
                ? ''
                : ' What it has built so far is thrown away. This can’t be undone.'
            }`}
          </p>
          <div className={styles.field}>
            <span aria-hidden>Factory</span>
            <FactoryPicker
              factories={factories}
              value={factoryId}
              onChange={setFactoryId}
              disabled={busy}
              empty="Choose a Factory"
            />
          </div>
          {planError !== undefined && (
            <p className={styles.error} role="alert">
              {planError}
            </p>
          )}
          {plan && <MovePlanDetails plan={plan} />}
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={
                (plan ? throwsAwayWork(plan) : task.stage !== 'backlog') ? 'danger' : 'primary'
              }
              disabled={busy || !plan || plan.refusal !== undefined}
              onClick={() => move()}
            >
              {busy ? 'Moving…' : chosen ? `Move to ${chosen.name}` : 'Move'}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

export function FollowUpDialog({
  task,
  onClose,
  onCreated,
}: {
  task: Task
  onClose: () => void
  onCreated?: (created: Task) => void
}) {
  const draft = useMessageDraft({ kind: 'follow-up', id: task.id })
  const { text, setText } = draft
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [error, setError] = useState<string>()

  async function followUp() {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(undefined)
    try {
      const created = await ted.followUpTask(task.id, text.trim() === '' ? undefined : text)
      draft.clear()
      onClose()
      onCreated?.(created)
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    } finally {
      submitting.current = false
    }
  }

  return (
    <Dialog onClose={() => !submitting.current && !busy && onClose()}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>{`Follow-Up to ${task.displayId}?`}</h2>
          <p className={styles.body}>
            {`${task.title}. TED creates a new Task linked to ${task.displayId} that starts from its brief and pull requests. It skips Backlog and waits for a free Run slot. ${task.displayId} stays Done.`}
          </p>
          <textarea
            className={`${styles.text} ${grow.text}`}
            aria-label="What should the Follow-Up change?"
            placeholder="What should change?"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
              event.preventDefault()
              return followUp()
            }}
          />
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" pending={busy} disabled={busy} onClick={() => followUp()}>
              Follow-Up
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

export function ArchiveDoneDialog({
  factoryId,
  count,
  onClose,
}: {
  factoryId: string
  count: number
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const tasks = count === 1 ? '1 Done Task' : `${count} Done Tasks`

  async function archive() {
    setBusy(true)
    setError(undefined)
    try {
      await ted.archiveDone(factoryId)
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }

  return (
    <Dialog onClose={onClose}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>{`Archive ${tasks}?`}</h2>
          <p className={styles.body}>
            They leave the Board and the List. Comments, briefs and Conversations are kept, and you
            can unarchive any of them later.
          </p>
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => archive()}>
              {`Archive ${count}`}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
