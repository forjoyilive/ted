import type { AgentKind, Effort, Run, Task, TaskLead } from '@ted/protocol'
import { efforts } from '@ted/protocol/task'
import { useEffect, useId, useRef, useState } from 'react'
import { ActionButton } from '../components/ActionButton.tsx'
import { AgentOptions } from '../components/AgentOptions.tsx'
import { ModelSelect } from '../components/ModelSelect.tsx'
import { Select } from '../components/Select.tsx'
import { useEventValue } from '../data.ts'
import { leadSummary } from '../task-fields.ts'
import { ted } from '../ted.ts'
import styles from './TaskLeadField.module.css'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function TaskLeadField({ task }: { task: Task }) {
  const id = useId()
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
  const savedAgent: AgentKind = lead?.agent ?? 'claude'
  const savedEffort: Effort | '' | 'stage' =
    lead?.effortMode === 'stage' ? 'stage' : (lead?.effort ?? '')
  const [agent, setAgent] = useState(savedAgent)
  const [model, setModel] = useState(lead?.model ?? '')
  const [effort, setEffort] = useState(savedEffort)
  const [error, setError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(0)
  const savingNow = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const latest = useRef({ agent: savedAgent, model: lead?.model ?? '', effort: savedEffort })
  latest.current = { agent: savedAgent, model: lead?.model ?? '', effort: savedEffort }

  useEffect(() => {
    if (savingNow.current > 0) return
    setAgent(savedAgent)
    setModel(lead?.model ?? '')
    setEffort(savedEffort)
  }, [savedAgent, lead?.model, savedEffort])

  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 1500)
    return () => clearTimeout(timer)
  }, [saved])

  const save = (change: { agent?: AgentKind; model?: string; effort?: Effort | '' | 'stage' }) => {
    const next = { agent, model, effort, ...change }
    if (change.agent !== undefined) setAgent(change.agent)
    if (change.model !== undefined) setModel(change.model)
    if (change.effort !== undefined) setEffort(change.effort)
    setSaved(false)
    const choice: TaskLead = {
      agent: next.agent,
      ...(next.model.trim() !== '' && { model: next.model.trim() }),
      ...(next.effort === 'stage'
        ? {
            effortMode: 'stage' as const,
            ...(lead?.effort !== undefined && { effort: lead.effort }),
          }
        : next.effort !== ''
          ? { effort: next.effort }
          : {}),
    }
    savingNow.current += 1
    setSaving((n) => n + 1)
    const sent = queue.current.then(() => ted.setTaskLead(task.id, choice))
    queue.current = sent.catch(() => {})
    void sent
      .finally(() => {
        savingNow.current -= 1
        setSaving((n) => n - 1)
      })
      .then(
        () => {
          setError(undefined)
          setSaved(true)
        },
        (e: unknown) => {
          setError(errorText(e))
          if (savingNow.current > 0) return
          setAgent(latest.current.agent)
          setModel(latest.current.model)
          setEffort(latest.current.effort)
        },
      )
  }

  const live =
    run && run.state !== 'finished' && task.stage !== 'backlog' && task.stage !== 'done'
      ? run
      : undefined
  const wantedEffort =
    lead?.effortMode === 'stage' ? (task.stageEffort ?? lead.effort) : lead?.effort
  const waiting =
    lead !== undefined &&
    live !== undefined &&
    (live.agent !== lead.agent || live.model !== lead.model || live.effort !== wantedEffort)

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
      {run?.problem === 'model-unavailable' && (
        <div className={styles.problem}>
          <span>Model unavailable</span>
          <ActionButton type="button" className={styles.button} onClick={pickDefaultModel}>
            Use the default model
          </ActionButton>
        </div>
      )}
      <div className={styles.form}>
        <label className={styles.label} htmlFor={`${id}-agent`}>
          Provider
          <Select
            fullWidth
            id={`${id}-agent`}
            controlClassName={styles.control}
            value={agent}
            onChange={(e) => save({ agent: e.target.value as AgentKind, model: '' })}
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
            onChange={(next) => save({ model: next })}
          />
        </label>
        <label className={styles.label} htmlFor={`${id}-effort`}>
          Effort
          <Select
            fullWidth
            id={`${id}-effort`}
            controlClassName={styles.control}
            value={effort}
            onChange={(e) => save({ effort: e.target.value as Effort | '' | 'stage' })}
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
        <span className={styles.saved} aria-live="polite">
          {saving > 0 ? 'Saving…' : saved ? 'Saved' : ''}
        </span>
      </div>
      {waiting && (
        <ActionButton
          type="button"
          className={styles.button}
          onClick={() => ted.restartTaskLead(task.id)}
        >
          Restart now to apply changes
        </ActionButton>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  )
}
