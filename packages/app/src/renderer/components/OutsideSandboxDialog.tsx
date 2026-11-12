import type { Task, TaskApp } from '@ted/protocol'
import { type ReactNode, useState } from 'react'
import { readableError, ted } from '../ted.ts'
import styles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'

export function useOutsideSandbox(
  task: Task,
  app: Pick<TaskApp, 'name' | 'confirmOutsideSandbox'>,
): { confirm: (run: () => unknown) => unknown; dialog: ReactNode } {
  const [pending, setPending] = useState<() => unknown>()
  const confirm = (run: () => unknown) => {
    if (app.confirmOutsideSandbox === true) setPending(() => run)
    else return run()
  }
  const dialog = pending && (
    <OutsideSandboxDialog
      task={task}
      app={app.name}
      onRun={() => {
        return Promise.resolve(pending()).then(() => setPending(undefined))
      }}
      onCancel={() => setPending(undefined)}
    />
  )
  return { confirm, dialog }
}

export function OutsideSandboxDialog({
  task,
  app,
  onRun,
  onCancel,
}: {
  task: Task
  app: string
  onRun: () => unknown
  onCancel: () => void
}) {
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function run() {
    setBusy(true)
    setError(undefined)
    try {
      if (always) {
        const { appsOutsideSandbox } = await ted.getSettings()
        const list = appsOutsideSandbox[task.factoryId] ?? []
        await ted.updateSettings({
          appsOutsideSandbox: {
            ...appsOutsideSandbox,
            [task.factoryId]: [...new Set([...list, app])],
          },
        })
      }
      await onRun()
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onClose={() => !busy && onCancel()}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>
            {`Run ${app} outside the sandbox?`}
          </h2>
          <p className={styles.body}>
            {`${app} runs code from the Task’s branch on your Mac, outside the sandbox, like running it yourself in the Task’s shell.`}
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={always}
              onChange={(event) => setAlways(event.target.checked)}
            />
            <span>{`Always for ${app} in this Factory`}</span>
          </label>
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => run()}>
              Run
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
