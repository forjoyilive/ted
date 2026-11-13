import type { Attachment } from '@ted/protocol'
import {
  type MouseEventHandler,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
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
  onClick,
  children,
}: {
  title: string
  wide?: boolean
  onClose: () => void
  controls?: ReactNode
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
        event.stopPropagation()
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

function ImageContent({
  image,
  imageRef,
}: {
  image: ViewerImage
  imageRef: Ref<HTMLImageElement>
}) {
  const { data, error } = useBytes(image)
  if (error !== undefined) return <p role="alert">{error}</p>
  if (data === undefined) return <Loading label={`Loading ${image.name}…`} />
  return (
    <img
      ref={imageRef}
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
  const imageElement = useRef<HTMLImageElement>(null)
  const image = images[index]
  if (image === undefined) return null
  const dismissOutside: MouseEventHandler<HTMLDialogElement> = (event) => {
    if (event.target === event.currentTarget) {
      onClose()
      return
    }
    const element = imageElement.current
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
  const move = (direction: number) =>
    setIndex((current) => (current + direction + images.length) % images.length)
  return (
    <Viewer
      title={image.caption ?? image.name}
      wide
      onClose={onClose}
      onClick={dismissOutside}
      controls={
        images.length > 1 && (
          <div className={styles.navigation}>
            <Button
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
      <ImageContent key={`${image.hash}:${image.name}`} image={image} imageRef={imageElement} />
    </Viewer>
  )
}
