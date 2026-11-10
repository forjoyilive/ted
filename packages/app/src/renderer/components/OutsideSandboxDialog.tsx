import type { Task, TaskApp } from '@ted/protocol'
import { type ReactNode, useState } from 'react'
import { readableError, ted } from '../ted.ts'
import styles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'

export function useOutsideSandbox(
  task: Task,
  app: Pick<TaskApp, 'name' | 'confirmOutsideSandbox'>,
): { confirm: (run: () => void) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<() => void>()
  const confirm = (run: () => void) => {
    if (app.confirmOutsideSandbox === true) setPending(() => run)
    else run()
  }
  const dialog = pending && (
    <OutsideSandboxDialog
      task={task}
      app={app.name}
      onRun={() => {
        setPending(undefined)
        pending()
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
  onRun: () => void
  onCancel: () => void
}) {
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function run() {
    if (!always) return onRun()
    setBusy(true)
    setError(undefined)
    try {
      const { appsOutsideSandbox } = await ted.getSettings()
      const list = appsOutsideSandbox[task.factoryId] ?? []
      await ted.updateSettings({
        appsOutsideSandbox: {
          ...appsOutsideSandbox,
          [task.factoryId]: [...new Set([...list, app])],
        },
      })
      onRun()
    } catch (failure) {
      setError(readableError(failure))
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
            <Button variant="primary" disabled={busy} onClick={() => void run()}>
              Run
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
