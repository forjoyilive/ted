import type { Attachment } from '@ted/protocol'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useBytes } from '../attachment-bytes.ts'
import { Button } from './Button.tsx'
import { ChevronIcon, CloseIcon } from './icons.tsx'
import { Loading } from './Loading.tsx'
import styles from './Viewer.module.css'

export function Viewer({
  title,
  wide = false,
  onClose,
  controls,
  children,
}: {
  title: string
  wide?: boolean
  onClose: () => void
  controls?: ReactNode
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
        {controls}
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {children}
    </dialog>
  )
}

type ViewerImage = Pick<Attachment, 'hash' | 'name' | 'mediaType'> & { caption?: string }

function ImageContent({ image }: { image: ViewerImage }) {
  const { data, error } = useBytes(image)
  if (error !== undefined) return <p role="alert">{error}</p>
  if (data === undefined) return <Loading label={`Loading ${image.name}…`} />
  return (
    <img
      className={styles.image}
      src={`data:${image.mediaType};base64,${data}`}
      alt={image.caption ?? image.name}
    />
  )
}

export function ImageViewer({
  images,
  initialIndex,
  onClose,
}: {
  images: readonly ViewerImage[]
  initialIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(initialIndex)
  const image = images[index]
  if (image === undefined) return null
  const move = (direction: number) =>
    setIndex((current) => (current + direction + images.length) % images.length)
  return (
    <Viewer
      title={image.caption ?? image.name}
      wide
      onClose={onClose}
      controls={
        images.length > 1 && (
          <div className={styles.navigation}>
            <Button
              size="small"
              aria-label="Previous image"
              title="Previous image (←)"
              data-image-direction="previous"
              onClick={() => move(-1)}
            >
              <ChevronIcon open={false} className={styles.previous} />
            </Button>
            <span className={styles.count} role="status" aria-atomic="true">
              {index + 1} of {images.length}
            </span>
            <Button
              size="small"
              aria-label="Next image"
              title="Next image (→)"
              data-image-direction="next"
              onClick={() => move(1)}
            >
              <ChevronIcon open={false} />
            </Button>
          </div>
        )
      }
    >
      <ImageContent key={`${image.hash}:${image.name}`} image={image} />
    </Viewer>
  )
}
