import { type Task, type TaskApp, withOutsideSandboxApproval } from '@ted/protocol'
import { type ReactNode, useState } from 'react'
import { readableError, ted } from '../ted.ts'
import styles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'

export function useOutsideSandbox(
  task: Task,
  app: Pick<TaskApp, 'name' | 'confirmOutsideSandbox' | 'outsideSandboxApproval'>,
): { confirm: (run: () => unknown) => unknown; dialog: ReactNode } {
  const [pending, setPending] = useState<() => unknown>()
  const confirm = (run: () => unknown) => {
    if (app.confirmOutsideSandbox === true) setPending(() => run)
    else return run()
  }
  const dialog = pending && (
    <OutsideSandboxDialog
      task={task}
      app={app}
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
  app: Pick<TaskApp, 'name' | 'outsideSandboxApproval'>
  onRun: () => unknown
  onCancel: () => void
}) {
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { name, outsideSandboxApproval: approval } = app

  async function run() {
    setBusy(true)
    setError(undefined)
    try {
      if (always && approval !== undefined) {
        const { appsOutsideSandbox } = await ted.getSettings()
        await ted.updateSettings({
          appsOutsideSandbox: {
            ...appsOutsideSandbox,
            [task.factoryId]: withOutsideSandboxApproval(
              appsOutsideSandbox[task.factoryId],
              approval,
            ),
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
            {`Run ${name} outside the sandbox?`}
          </h2>
          <p className={styles.body}>
            {`${name} runs code from the Task’s branch on your Mac, outside the sandbox, like running it yourself in the Task’s shell.`}
          </p>
          {approval !== undefined && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={always}
                onChange={(event) => setAlways(event.target.checked)}
              />
              <span>{`Always for ${name} in this Factory, until its command changes`}</span>
            </label>
          )}
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
