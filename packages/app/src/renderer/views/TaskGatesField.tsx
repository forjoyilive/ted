import type { Task, TaskGateOverrides, TaskGates } from '@ted/protocol'
import { useContext, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Loading } from '../components/Loading.tsx'
import { Select } from '../components/Select.tsx'
import { useEventValue } from '../data.ts'
import { stageName } from '../list-view.ts'
import { OvernightContext } from '../overnight.tsx'
import { ted } from '../ted.ts'
import styles from './TaskGatesField.module.css'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function TaskGatesField({
  taskId,
  factoryId,
  task,
}: {
  taskId: string
  factoryId: string
  task?: Task
}) {
  const { on } = useContext(OvernightContext)
  const automatic =
    task?.autopilot?.choice === 'on' || ((task?.autopilot?.choice ?? 'inherit') === 'inherit' && on)
  const [draft, setDraft] = useState<TaskGateOverrides>({})
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [changed, setChanged] = useState(false)
  const original = useRef<TaskGates | undefined>(undefined)

  const { value: data, update } = useEventValue<TaskGates | undefined>({
    initial: undefined,
    key: taskId,
    load: () => ted.taskGates(taskId),
    event: (event) =>
      (event.type === 'task-updated' && event.task.id === taskId) ||
      event.type === 'library-changed' ||
      (event.type === 'factory-updated' && event.factory.id === factoryId)
        ? 'reload'
        : undefined,
    changed: (next) => {
      if (original.current && original.current.revision !== next?.revision) setChanged(true)
    },
    error: (failure) => setError(errorText(failure)),
  })

  const edit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await ted.taskGates(taskId)
      original.current = next
      update(() => next)
      setDraft({ ...next.overrides })
      setChanged(false)
      setOpen(true)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!original.current) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await ted.setTaskGates(taskId, {
        overrides: draft,
        revision: original.current.revision,
      })
      original.current = undefined
      update(() => next)
      setOpen(false)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const editable = data?.rows.some((row) => !row.locked) ?? false
  const count = Object.keys(data?.overrides ?? {}).length
  return (
    <div className={styles.field}>
      <Button size="small" disabled={busy || (!data && !error)} onClick={() => void edit()}>
        {busy ? (
          <Loading compact label="Loading sign-offs…" />
        ) : data ? (
          `${count ? `${count} overridden` : 'Use Workflow'} · ${editable ? 'Edit' : 'View'}`
        ) : error ? (
          'Load sign-offs'
        ) : (
          <Loading compact label="Loading sign-offs…" />
        )}
      </Button>
      {open && data && (
        <section className={styles.editor} aria-label="Sign-offs for this Task">
          {automatic && (
            <p className={styles.note}>
              Autopilot is on. Ordinary sign-offs are off; your saved choices apply again when
              Autopilot is off. Required sign-offs still wait for you.
            </p>
          )}
          <p className={styles.note}>
            Choose where TED waits for your sign-off. Stage work stays the same.
          </p>
          {data.rows.map((row) => (
            <div key={row.stage} className={styles.row}>
              <label className={styles.label} htmlFor={`gate-${taskId}-${row.stage}`}>
                {stageName(row.stage)}
              </label>
              <Select
                fullWidth
                id={`gate-${taskId}-${row.stage}`}
                controlClassName={styles.select}
                disabled={busy || changed || !!row.locked}
                value={
                  row.required
                    ? 'required'
                    : draft[row.stage] === undefined
                      ? 'inherit'
                      : draft[row.stage]
                        ? 'on'
                        : 'off'
                }
                onChange={(event) => {
                  const value = event.target.value
                  setDraft((before) => {
                    const next = { ...before }
                    if (value === 'inherit') delete next[row.stage]
                    else next[row.stage] = value === 'on'
                    return next
                  })
                }}
              >
                {row.required && <option value="required">On · Required</option>}
                <option value="inherit">Use Workflow ({row.inherited ? 'On' : 'Off'})</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
              <p className={styles.rowNote}>
                {row.locked ?? `Workflow: ${row.inherited ? 'On' : 'Off'}`}
              </p>
              {row.required && row.override === false && (
                <p className={styles.rowNote}>
                  Your Off choice applies when this sign-off is optional.
                </p>
              )}
              {row.stage === 'merge' && (
                <p className={styles.mergeNote}>
                  Off lets TED merge automatically after its readiness checks pass.
                </p>
              )}
            </div>
          ))}
          {changed && (
            <p className={styles.note} role="status">
              The Task or Workflow changed. Reload sign-offs before saving.
            </p>
          )}
          <div className={styles.actions}>
            {changed ? (
              <Button size="small" disabled={busy} onClick={() => void edit()}>
                Reload sign-offs
              </Button>
            ) : (
              <Button
                size="small"
                disabled={busy || !editable}
                onClick={() =>
                  setDraft((before) => {
                    const next = { ...before }
                    for (const row of data.rows) if (!row.locked) delete next[row.stage]
                    return next
                  })
                }
              >
                Use Workflow
              </Button>
            )}
            <Button
              size="small"
              disabled={busy}
              onClick={() => {
                original.current = undefined
                setOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button
              size="small"
              disabled={busy || changed || !editable}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </section>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
