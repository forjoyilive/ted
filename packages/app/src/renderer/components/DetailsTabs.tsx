import type { KeyboardEvent, ReactNode } from 'react'
import { type DetailsTabId, detailsTabNames, detailsTabs } from '../details.ts'
import { keysFor } from '../keymap.ts'
import styles from './DetailsTabs.module.css'
import {
  BranchIcon,
  ChangesIcon,
  DetailsIcon,
  FolderIcon,
  PulseIcon,
  WindowIcon,
} from './icons.tsx'

const icons: Record<DetailsTabId, ReactNode> = {
  details: <DetailsIcon />,
  code: <BranchIcon />,
  changes: <ChangesIcon />,
  files: <FolderIcon />,
  runs: <PulseIcon />,
  apps: <WindowIcon />,
}

export function detailsTabElementId(id: DetailsTabId): string {
  return `details-tab-${id}`
}

export function detailsPanelId(id: DetailsTabId): string {
  return `details-panel-${id}`
}

export function DetailsTabs({
  selected,
  onSelect,
  changeCount,
  runWorking,
}: {
  selected: DetailsTabId
  onSelect: (id: DetailsTabId) => void
  changeCount?: number | undefined
  runWorking?: boolean
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = detailsTabs.indexOf(selected)
    const next = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: detailsTabs.length - 1,
    }[event.key]
    if (next === undefined || event.altKey || event.metaKey || event.ctrlKey) return
    event.preventDefault()
    event.stopPropagation()
    const id = detailsTabs[(next + detailsTabs.length) % detailsTabs.length] ?? selected
    onSelect(id)
    document.getElementById(detailsTabElementId(id))?.focus()
  }
  return (
    <div className={styles.tabs} role="tablist" aria-label="Task details sections" onKeyDown={move}>
      {detailsTabs.map((id, index) => {
        const name = detailsTabNames[id]
        const shortcut = keysFor(`details-tab-${id}`)[0]
        const count = id === 'changes' && changeCount !== undefined && changeCount > 0
        const working = id === 'runs' && runWorking === true
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={detailsTabElementId(id)}
            className={styles.tab}
            data-first={index === 0 || undefined}
            aria-selected={id === selected}
            aria-controls={detailsPanelId(id)}
            aria-label={name}
            aria-description={
              [
                count ? `${changeCount === 1 ? '1 file' : `${changeCount} files`} changed` : '',
                working ? 'A Run is working' : '',
              ]
                .filter((part) => part !== '')
                .join('. ') || undefined
            }
            tabIndex={id === selected ? 0 : -1}
            onClick={() => onSelect(id)}
          >
            {icons[id]}
            {count && (
              <span className={styles.count} aria-hidden>
                {changeCount > 99 ? '99+' : changeCount}
              </span>
            )}
            {working && <span className={styles.working} aria-hidden />}
            <span className={styles.tip} aria-hidden>
              {name}
              {shortcut !== undefined && <span className={styles.shortcut}>{shortcut}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}
