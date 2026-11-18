import {
  type PreviewSize,
  type PreviewZoom,
  previewDevices,
  previewSizeLabel,
  previewWidthLimits,
  previewZooms,
} from '@ted/protocol/preview-size'
import { useEffect, useRef, useState } from 'react'
import { Button } from './Button.tsx'
import { buttonPosition, type MenuAction, useActionMenu } from './ContextMenu.tsx'
import styles from './PreviewSizeMenu.module.css'

const zoomLabels: Record<PreviewZoom, string> = {
  fit: 'Fit',
  '50': '50%',
  '75': '75%',
  '100': '100%',
}

export function PreviewSizeMenu({
  scope,
  size,
  zoom,
  scale,
  disabled,
  onSize,
  onZoom,
}: {
  scope: string
  size: PreviewSize
  zoom: PreviewZoom
  scale: number
  disabled: boolean
  onSize: (size: PreviewSize) => Promise<void>
  onZoom: (zoom: PreviewZoom) => void
}) {
  const actions = useActionMenu(`preview-size:${scope}`)
  const [custom, setCustom] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const field = useRef<HTMLInputElement>(null)
  const editing = custom !== undefined
  useEffect(() => {
    if (editing) field.current?.select()
  }, [editing])
  const device = size.kind === 'tablet' || size.kind === 'mobile' ? size.kind : undefined
  const landscape = size.kind === 'tablet' || size.kind === 'mobile' ? size.landscape : undefined
  const items = (): MenuAction[] => [
    {
      label: 'Desktop',
      hint: 'Fills the pane',
      checked: size.kind === 'desktop',
      action: () => onSize({ kind: 'desktop' }),
    },
    ...(['tablet', 'mobile'] as const).map((kind) => ({
      label: previewDevices[kind].label,
      hint: `${previewDevices[kind].width} × ${previewDevices[kind].height}`,
      checked: size.kind === kind,
      action: () => onSize({ kind, landscape: device === kind && landscape === true }),
    })),
    {
      label: 'Custom width…',
      ...(size.kind === 'custom' && { hint: `${size.width} px` }),
      checked: size.kind === 'custom',
      action: () => setCustom(size.kind === 'custom' ? String(size.width) : '1280'),
    },
    {
      label: 'Portrait',
      divider: true,
      checked: landscape === false,
      disabled: device === undefined,
      action: () => (device ? onSize({ kind: device, landscape: false }) : undefined),
    },
    {
      label: 'Landscape',
      checked: landscape === true,
      disabled: device === undefined,
      action: () => (device ? onSize({ kind: device, landscape: true }) : undefined),
    },
    {
      label: 'Zoom',
      divider: true,
      hint: zoomLabels[zoom],
      disabled: size.kind === 'desktop',
      items: previewZooms.map((choice) => ({
        label: zoomLabels[choice],
        checked: zoom === choice,
        action: () => onZoom(choice),
      })),
    },
  ]
  const applyCustom = async () => {
    const width = Number(custom)
    const { min, max } = previewWidthLimits
    if (!Number.isInteger(width) || width < min || width > max) {
      setProblem(`Use ${min}–${max} px`)
      return
    }
    setProblem(undefined)
    setCustom(undefined)
    await onSize({ kind: 'custom', width })
  }
  const percent = Math.round(scale * 100)
  return (
    <>
      {custom !== undefined && (
        <span className={styles.custom}>
          <input
            aria-label="Custom width in pixels"
            className={styles.width}
            ref={field}
            inputMode="numeric"
            value={custom}
            aria-invalid={problem !== undefined}
            onChange={(event) => {
              setProblem(undefined)
              setCustom(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void applyCustom()
              }
              if (event.key === 'Escape') {
                setProblem(undefined)
                setCustom(undefined)
              }
            }}
          />
          {problem ? (
            <span role="alert" className={styles.problem}>
              {problem}
            </span>
          ) : (
            <span className={styles.unit}>px</span>
          )}
          <Button onClick={() => void applyCustom()}>Apply</Button>
          <Button
            onClick={() => {
              setProblem(undefined)
              setCustom(undefined)
            }}
          >
            Cancel
          </Button>
        </span>
      )}
      {custom === undefined && (
        <Button
          aria-haspopup="menu"
          aria-expanded={actions.isOpen}
          aria-label={`Preview size: ${previewSizeLabel(size)}`}
          disabled={disabled}
          onClick={(event) =>
            actions.open(buttonPosition(event.currentTarget), 'Preview size', items())
          }
        >
          {previewSizeLabel(size)}
          {size.kind !== 'desktop' && percent !== 100 ? ` · ${percent}%` : ''} ▾
        </Button>
      )}
      {actions.menu}
    </>
  )
}
