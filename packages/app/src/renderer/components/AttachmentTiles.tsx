import type { Attachment } from '@ted/protocol'
import { type KeyboardEvent, useState } from 'react'
import { useBytes } from '../attachment-bytes.ts'
import { formatSize } from '../task-fields.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './AttachmentTiles.module.css'
import { showsInline } from './CommentFiles.tsx'
import { CloseIcon, FileIcon } from './icons.tsx'
import { Loading } from './Loading.tsx'
import { ImageViewer } from './Viewer.tsx'

const key = (a: Attachment) => `${a.hash}:${a.name}`

function extension(name: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name)
  return match?.[1]?.toUpperCase() ?? 'FILE'
}

function Thumbnail({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const { data, error } = useBytes(attachment)
  return (
    <ActionButton
      type="button"
      className={`${styles.face} ${styles.image}`}
      aria-label={`View ${attachment.name}`}
      data-tile-focus
      onClick={onOpen}
    >
      {data !== undefined ? (
        <img src={`data:${attachment.mediaType};base64,${data}`} alt={attachment.name} />
      ) : error !== undefined ? (
        <FileIcon />
      ) : (
        <Loading compact label={`Loading ${attachment.name}…`} />
      )}
    </ActionButton>
  )
}

function browse(event: KeyboardEvent<HTMLUListElement>) {
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
  const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
  if (step === 0 || !(event.target instanceof HTMLElement)) return
  const tile = event.target.closest('li')
  const tiles = [...event.currentTarget.querySelectorAll('li')]
  const next = tile ? tiles[tiles.indexOf(tile) + step] : undefined
  const target = next?.querySelector<HTMLElement>('[data-tile-focus]')
  if (!target) return
  event.preventDefault()
  target.focus()
}

export function AttachmentTiles({
  files,
  uploading,
  onRemove,
}: {
  files: readonly Attachment[]
  uploading: boolean
  onRemove: (attachment: Attachment) => void
}) {
  const [open, setOpen] = useState<number>()
  const images = files.filter(showsInline)
  if (files.length === 0 && !uploading) return null
  return (
    <>
      <ul className={styles.tiles} aria-label="Attached files" onKeyDown={browse}>
        {files.map((a) => {
          const image = images.indexOf(a)
          return (
            <li key={key(a)} className={styles.tile} data-attachment={a.name}>
              {image >= 0 ? (
                <Thumbnail attachment={a} onOpen={() => setOpen(image)} />
              ) : (
                <span className={`${styles.face} ${styles.file}`}>
                  <FileIcon />
                  <span className={styles.extension}>{extension(a.name)}</span>
                </span>
              )}
              <span className={styles.label} aria-hidden>
                {a.name}
                <span className={styles.size}>{formatSize(a.size)}</span>
              </span>
              <ActionButton
                type="button"
                className={styles.remove}
                aria-label={`Remove ${a.name}`}
                {...(image < 0 && { 'data-tile-focus': true })}
                onClick={() => onRemove(a)}
              >
                <CloseIcon size={9} />
              </ActionButton>
            </li>
          )
        })}
        {uploading && (
          <li className={styles.tile}>
            <span className={`${styles.face} ${styles.file}`}>
              <Loading compact label="Attaching…" />
            </span>
          </li>
        )}
      </ul>
      {open !== undefined && (
        <ImageViewer images={images} initialIndex={open} onClose={() => setOpen(undefined)} />
      )}
    </>
  )
}
