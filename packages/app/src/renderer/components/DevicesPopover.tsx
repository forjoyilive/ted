import type { BootedSimulator, SimulatorSlots, WaitingDevice } from '@ted/protocol'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { deviceWaitText } from '../slots.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './DevicesPopover.module.css'
import { Help } from './Help.tsx'
import { OpenIcon, StopIcon } from './icons.tsx'
import { ordinal } from './TaskStatus.tsx'
import runs from './WorkingRuns.module.css'

const machine = navigator.userAgent.includes('Mac') ? 'this Mac' : 'this computer'

export interface DeviceRef {
  taskId: string
  repo: string
  app: string
}

const keyOf = (device: DeviceRef) => `${device.taskId}/${device.repo}/${device.app}`

function Group({
  label,
  count,
  help,
  children,
}: {
  label: string
  count?: number
  help?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className={runs.group} aria-labelledby={id}>
      <div className={runs.groupHeader}>
        <h3 className={runs.groupLabel} id={id}>
          {label}
        </h3>
        {help !== undefined && <Help>{help}</Help>}
        <span className={runs.spacer} />
        {count !== undefined && <span className={runs.groupCount}>{count}</span>}
      </div>
      <ul className={runs.rows}>{children}</ul>
    </section>
  )
}

export function DevicesPopover({
  slots,
  onOpenTask,
  onShow,
  onStop,
  onOpenLimits,
  onClose,
}: {
  slots: SimulatorSlots
  onOpenTask: (taskId: string) => void
  onShow: (device: DeviceRef) => Promise<void>
  onStop: (device: DeviceRef) => Promise<void>
  onOpenLimits: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [onClose])

  const stop = async (device: DeviceRef) => {
    const key = keyOf(device)
    setStopping((now) => new Set(now).add(key))
    try {
      await onStop(device)
    } finally {
      setStopping((now) => {
        const next = new Set(now)
        next.delete(key)
        return next
      })
    }
  }

  const stopButton = (device: DeviceRef) => (
    <ActionButton
      type="button"
      className={styles.action}
      aria-label={`Stop ${device.app}`}
      title="Stop"
      onClick={() => stop(device)}
    >
      <StopIcon />
    </ActionButton>
  )

  const openButton = (taskId: string, lead: ReactNode, title: string, detail: ReactNode) => (
    <button
      type="button"
      className={styles.open}
      onClick={() => {
        onOpenTask(taskId)
        onClose()
      }}
    >
      {lead}
      <span className={runs.text}>
        <span className={runs.title}>{title}</span>
        <span className={runs.detail}>{detail}</span>
      </span>
    </button>
  )

  const running = (device: BootedSimulator) => {
    const busy = stopping.has(keyOf(device))
    const kind = device.platform === 'android' ? 'emulator' : 'simulator'
    return (
      <li key={keyOf(device)} className={busy ? styles.stopping : styles.row}>
        {openButton(
          device.taskId,
          <span className={runs.lead}>{device.displayId}</span>,
          device.title,
          <>
            {busy ? 'Stopping…' : `${device.app} · ${device.device}`}
            {device.recording && !busy && <span className={styles.recording}>Recording</span>}
          </>,
        )}
        <span className={styles.actions}>
          <ActionButton
            type="button"
            className={styles.action}
            aria-label={`Show ${device.app}`}
            title={
              kind === 'emulator'
                ? 'Show the emulator (reopens it in a window if it has none)'
                : 'Show the simulator'
            }
            disabled={busy}
            onClick={() => onShow(device)}
          >
            <OpenIcon />
          </ActionButton>
          {stopButton(device)}
        </span>
      </li>
    )
  }

  const waiting = (device: WaitingDevice) => {
    const busy = stopping.has(keyOf(device))
    return (
      <li key={keyOf(device)} className={busy ? styles.stopping : styles.row}>
        {openButton(
          device.taskId,
          <span className={runs.place}>{ordinal(device.place)}</span>,
          `${device.displayId} · ${device.title}`,
          busy
            ? 'Stopping…'
            : `${device.app} · ${device.device} · ${deviceWaitText(device.waitingFor, machine)}`,
        )}
        <span className={styles.actions}>{stopButton(device)}</span>
      </li>
    )
  }

  const empty = slots.booted.length === 0 && slots.waiting.length === 0

  return (
    <div ref={ref} className={runs.popover} role="dialog" aria-labelledby={titleId}>
      <div className={runs.header}>
        <h2 className={runs.heading} id={titleId}>
          Simulators and emulators
        </h2>
        <span className={runs.spacer} />
        <span className={runs.slots}>
          {`${slots.booted.length} of ${slots.limit} running on ${machine}`}
        </span>
      </div>
      {empty ? (
        <p className={runs.empty}>No simulators or emulators running.</p>
      ) : (
        <div className={runs.body}>
          {slots.booted.length > 0 && <Group label="Running">{slots.booted.map(running)}</Group>}
          {slots.waiting.length > 0 && (
            <Group
              label="Waiting"
              count={slots.waiting.length}
              help="Apps start in the order they asked. With Build one simulator or emulator App at a time on, an App can wait while another builds, even when a device is free."
            >
              {slots.waiting.map(waiting)}
            </Group>
          )}
        </div>
      )}
      <div className={runs.footer}>
        <span className={styles.limit}>{`At most ${slots.limit} at once`}</span>
        <span className={runs.spacer} />
        <button
          type="button"
          className={runs.link}
          onClick={() => {
            onOpenLimits()
            onClose()
          }}
        >
          Change in Settings →
        </button>
      </div>
    </div>
  )
}
