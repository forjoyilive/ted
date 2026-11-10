import { type ReactNode, useEffect, useId, useRef } from 'react'
import { CloseIcon } from './icons.tsx'
import styles from './Viewer.module.css'

export function Viewer({
  title,
  wide = false,
  onClose,
  children,
}: {
  title: string
  wide?: boolean
  onClose: () => void
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
    <dialog
      ref={dialog}
      className={wide ? `${styles.viewer} ${styles.wide}` : styles.viewer}
      aria-labelledby={headingId}
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
  return (
    <Viewer title={title} wide onClose={onClose}>
      <img className={styles.image} src={src} alt={title} />
    </Viewer>
  )
}
