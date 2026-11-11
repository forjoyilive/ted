import type { AgentKind, Effort, Run, Task, TaskLead } from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { efforts } from '@ted/protocol/task'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { Select } from '../components/Select.tsx'
import { agentLabels, leadSummary } from '../task-fields.ts'
import { ted } from '../ted.ts'
import styles from './TaskLeadField.module.css'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function TaskLeadField({ task }: { task: Task }) {
  const id = useId()
  const lead = task.lead
  const [run, setRun] = useState<Run | undefined>()
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

  useEffect(() => {
    const runId = task.leadRunId
    if (runId === undefined) return setRun(undefined)
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'run-updated' && event.run.id === runId) setRun(event.run)
    })
    void ted.getRun(runId).then(({ run }) => setRun(run))
    return unsubscribe
  }, [task.leadRunId])

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
    ted.setTaskLead(task.id, choice).then(
      () => setError(undefined),
      (e: unknown) => setError(errorText(e)),
    )
  }

  const { useDefaultModel: resetDefaultModel } = ted
  const pickDefaultModel = () => {
    resetDefaultModel(task.id).then(
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
          <button type="button" className={styles.button} onClick={pickDefaultModel}>
            Use the default model
          </button>
        </div>
      )}
      <form className={styles.form} onSubmit={save}>
        <label className={styles.label} htmlFor={`${id}-agent`}>
          Agent
          <Select
            fullWidth
            id={`${id}-agent`}
            controlClassName={styles.control}
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentKind)}
          >
            {agentKinds.map((kind) => (
              <option key={kind} value={kind}>
                {agentLabels[kind]}
              </option>
            ))}
          </Select>
        </label>
        <label className={styles.label}>
          Model
          <input
            className={styles.control}
            value={model}
            placeholder="Default model"
            onChange={(e) => setModel(e.target.value)}
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
        <button type="submit" className={styles.button}>
          Save
        </button>
      </form>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  )
}
