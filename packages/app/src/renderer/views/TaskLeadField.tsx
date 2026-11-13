import type { AgentKind, Effort, Run, Task, TaskLead } from '@ted/protocol'
import { efforts } from '@ted/protocol/task'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { ModelSelect } from '../components/ModelSelect.tsx'
import { Select } from '../components/Select.tsx'
import { useEventValue } from '../data.ts'
import { usePendingAction } from '../pending-action.ts'
import { leadSummary } from '../task-fields.ts'
import { ted } from '../ted.ts'
import styles from './TaskLeadField.module.css'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function TaskLeadField({ task }: { task: Task }) {
  const id = useId()
  const activity = usePendingAction()
  const lead = task.lead
  const runId = task.leadRunId
  const { value: run } = useEventValue<Run | undefined>({
    initial: undefined,
    key: runId ?? '',
    enabled: runId !== undefined,
    load: () =>
      runId === undefined ? Promise.resolve(undefined) : ted.getRun(runId).then(({ run }) => run),
    event: (event) =>
      event.type === 'run-updated' && event.run.id === runId ? () => event.run : undefined,
  })
  const [agent, setAgent] = useState<AgentKind>(lead?.agent ?? 'claude')
  const [model, setModel] = useState(lead?.model ?? '')
  const [effort, setEffort] = useState<Effort | '' | 'stage'>(
    lead?.effortMode === 'stage' ? 'stage' : (lead?.effort ?? ''),
  )
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    setAgent(lead?.agent ?? 'claude')
    setModel(lead?.model ?? '')
    setEffort(lead?.effortMode === 'stage' ? 'stage' : (lead?.effort ?? ''))
  }, [lead?.agent, lead?.model, lead?.effort, lead?.effortMode])

  const save = (event: FormEvent) => {
    event.preventDefault()
    const choice: TaskLead = {
      agent,
      ...(model.trim() !== '' && { model: model.trim() }),
      ...(effort === 'stage'
        ? {
            effortMode: 'stage' as const,
            ...(lead?.effort !== undefined && { effort: lead.effort }),
          }
        : effort !== ''
          ? { effort }
          : {}),
    }
    return ted.setTaskLead(task.id, choice).then(
      () => setError(undefined),
      (e: unknown) => setError(errorText(e)),
    )
  }

  const { useDefaultModel: resetDefaultModel } = ted
  const pickDefaultModel = () => {
    return resetDefaultModel(task.id).then(
      () => setError(undefined),
      (e: unknown) => setError(errorText(e)),
    )
  }

  return (
    <div className={styles.field}>
      {lead && <span>{leadSummary(lead)}</span>}
      {lead?.effortMode === 'stage' && (
        <span>
          {task.stageEffort ?? lead.effort ?? 'CLI default'} effort ·{' '}
          {task.stageEffort ? 'Stage setting' : 'Task Lead default'}
        </span>
      )}
      {run &&
        run.effort !==
          (lead?.effortMode === 'stage' ? (task.stageEffort ?? lead.effort) : lead?.effort) && (
          <span>Effort changes at the next idle point</span>
        )}
      {run?.problem === 'model-unavailable' && (
        <div className={styles.problem}>
          <span>Model unavailable</span>
          <ActionButton type="button" className={styles.button} onClick={pickDefaultModel}>
            Use the default model
          </ActionButton>
        </div>
      )}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          activity.run(() => save(event))
        }}
      >
        <label className={styles.label} htmlFor={`${id}-agent`}>
          Agent
          <Select
            fullWidth
            id={`${id}-agent`}
            controlClassName={styles.control}
            value={agent}
            onChange={(e) => {
              setAgent(e.target.value as AgentKind)
              setModel('')
            }}
          >
            <AgentOptions current={agent} />
          </Select>
        </label>
        <label className={styles.label} htmlFor={`${id}-model`}>
          Model
          <ModelSelect
            fullWidth
            id={`${id}-model`}
            controlClassName={styles.control}
            inputClassName={styles.control}
            agent={agent}
            value={model}
            onChange={setModel}
          />
        </label>
        <label className={styles.label} htmlFor={`${id}-effort`}>
          Effort
          <Select
            fullWidth
            id={`${id}-effort`}
            controlClassName={styles.control}
            value={effort}
            onChange={(e) => setEffort(e.target.value as Effort | '' | 'stage')}
          >
            <option value="stage">Follow Stage settings</option>
            <option value="">CLI default · for this Task</option>
            {efforts.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </Select>
        </label>
        <ActionButton type="submit" className={styles.button} pending={activity.pending}>
          Save
        </ActionButton>
      </form>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  )
}
