import { effectiveTimeZone, requestSnoozePresets } from '@ted/protocol/time'
import { useContext, useEffect, useState } from 'react'
import { useSettings } from '../data.ts'
import {
  openSnoozeMenu,
  SnoozedContext,
  type SnoozeRequestDetail,
  snoozeRequestEvent,
  snoozeTime,
} from '../request-snooze.ts'
import { readableError, ted } from '../ted.ts'
import { timePreferences } from '../time.ts'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import { buttonPosition, useActionMenu } from './ContextMenu.tsx'
import styles from './RequestSnooze.module.css'
import dialog from './SnoozeTaskDialog.module.css'
import { SnoozeTimeFields, useSnoozeTime } from './SnoozeTimeFields.tsx'

export function RequestSnoozeHost() {
  const settings = useSettings()
  const zone = effectiveTimeZone(settings ?? timePreferences())
  const actions = useActionMenu()
  const [custom, setCustom] = useState<SnoozeRequestDetail>()
  const open = actions.open
  useEffect(() => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail = event.detail as SnoozeRequestDetail
      open(
        detail.at,
        `${detail.snoozedUntil ? 'Change snooze' : 'Snooze until'} · times in ${zone}`,
        [
          ...requestSnoozePresets(new Date(), zone).map((preset) => ({
            label: preset.label,
            hint: snoozeTime(preset.until),
            action: () => ted.snoozeRequest(detail.requestId, preset.until),
          })),
          { label: 'Custom…', hint: 'Pick a date and time', action: () => setCustom(detail) },
          ...(detail.snoozedUntil
            ? [{ label: 'Unsnooze', action: () => ted.snoozeRequest(detail.requestId, null) }]
            : []),
        ],
      )
    }
    window.addEventListener(snoozeRequestEvent, listener)
    return () => window.removeEventListener(snoozeRequestEvent, listener)
  }, [open, zone])
  return (
    <>
      {actions.menu}
      {custom && <SnoozeRequestDialog request={custom} onClose={() => setCustom(undefined)} />}
    </>
  )
}

function SnoozeRequestDialog({
  request,
  onClose,
}: {
  request: SnoozeRequestDetail
  onClose: () => void
}) {
  const when = useSnoozeTime(request.snoozedUntil)
  const { instant, invalid } = when
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const save = async () => {
    if (!instant || Date.parse(instant) <= Date.now()) {
      setError(invalid ?? 'Choose a future date and time')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await ted.snoozeRequest(request.requestId, instant)
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }
  return (
    <Dialog onClose={onClose}>
      {(heading) => (
        <>
          <h2 id={heading} className={dialog.heading}>
            {request.snoozedUntil ? 'Change snooze' : 'Snooze request'}
          </h2>
          <p className={dialog.note}>Hide this request from the Inbox until:</p>
          <SnoozeTimeFields value={when} onEdit={() => setError(undefined)} />
          {instant && <p className={dialog.note}>Returns {snoozeTime(instant)}</p>}
          <p className={dialog.note}>
            The Task keeps waiting for your answer. You can still answer the request from its
            thread.
          </p>
          {(error ?? invalid) && (
            <p className={dialog.error} role="alert">
              {error ?? invalid}
            </p>
          )}
          <div className={dialog.footer}>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy || !instant}>
              {busy ? 'Saving…' : request.snoozedUntil ? 'Save snooze' : 'Snooze'}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}

export function RequestSnoozeLine({ requestId }: { requestId: string }) {
  const snoozedUntil = useContext(SnoozedContext).get(requestId)
  const [error, setError] = useState<string>()
  const menu = (trigger: HTMLElement) =>
    openSnoozeMenu({ requestId, at: buttonPosition(trigger), snoozedUntil })
  if (snoozedUntil === undefined) {
    return (
      <div className={styles.line}>
        <Button size="small" variant="quiet" onClick={(event) => menu(event.currentTarget)}>
          Snooze…
        </Button>
      </div>
    )
  }
  return (
    <div className={`${styles.line} ${styles.snoozed}`}>
      <span className={styles.text}>
        Snoozed. Returns to the Inbox {snoozeTime(snoozedUntil)}. You can still answer it here.
      </span>
      <Button
        size="small"
        onClick={() =>
          ted
            .snoozeRequest(requestId, null)
            .catch((failure: unknown) => setError(readableError(failure)))
        }
      >
        Unsnooze
      </Button>
      <Button size="small" onClick={(event) => menu(event.currentTarget)}>
        Change snooze…
      </Button>
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
