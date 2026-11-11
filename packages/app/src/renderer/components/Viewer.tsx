import { type MouseEventHandler, type ReactNode, useEffect, useId, useRef } from 'react'
import { CloseIcon } from './icons.tsx'
import styles from './Viewer.module.css'

export function Viewer({
  title,
  wide = false,
  onClose,
  onClick,
  children,
}: {
  title: string
  wide?: boolean
  onClose: () => void
  onClick?: MouseEventHandler<HTMLDialogElement>
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: The native dialog handles Escape through onCancel.
    <dialog
      ref={dialog}
      className={wide ? `${styles.viewer} ${styles.wide}` : styles.viewer}
      aria-labelledby={headingId}
      onClick={onClick}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className={styles.viewerHead}>
        <h2 id={headingId} className={styles.viewerTitle}>
          {title}
        </h2>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {children}
    </dialog>
  )
}

export function ImageViewer({
  title,
  src,
  onClose,
}: {
  title: string
  src: string
  onClose: () => void
}) {
  const image = useRef<HTMLImageElement>(null)
  const dismissOutside: MouseEventHandler<HTMLDialogElement> = (event) => {
    if (event.target === event.currentTarget) {
      onClose()
      return
    }
    const element = image.current
    if (event.target !== element || !element || !element.naturalWidth || !element.naturalHeight)
      return
    const bounds = element.getBoundingClientRect()
    const scale = Math.min(
      bounds.width / element.naturalWidth,
      bounds.height / element.naturalHeight,
    )
    const width = element.naturalWidth * scale
    const height = element.naturalHeight * scale
    const left = bounds.left + (bounds.width - width) / 2
    const top = bounds.top + (bounds.height - height) / 2
    if (
      event.clientX < left ||
      event.clientX > left + width ||
      event.clientY < top ||
      event.clientY > top + height
    ) {
      onClose()
    }
  }
  return (
    <Viewer title={title} wide onClose={onClose} onClick={dismissOutside}>
      <img ref={image} className={styles.image} src={src} alt={title} />
    </Viewer>
  )
}
