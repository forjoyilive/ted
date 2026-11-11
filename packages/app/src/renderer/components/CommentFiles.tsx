import type { Attachment } from '@ted/protocol'
import { useState } from 'react'
import { useBytes } from '../attachment-bytes.ts'
import { formatSize } from '../task-fields.ts'
import styles from './CommentFiles.module.css'
import { Loading } from './Loading.tsx'
import { ImageViewer } from './Viewer.tsx'

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

export const showsInline = (a: Attachment) => imageTypes.has(a.mediaType)
export const isHtml = (a: Attachment) => a.mediaType === 'text/html'

function ImageFile({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const { data, error } = useBytes(attachment)
  const src = data === undefined ? undefined : `data:${attachment.mediaType};base64,${data}`
  return (
    <figure className={styles.image}>
      {src !== undefined ? (
        <button
          type="button"
          className={styles.thumbnail}
          aria-label={`View ${attachment.name}`}
          onClick={onOpen}
        >
          <img src={src} alt={attachment.name} />
        </button>
      ) : (
        <div className={styles.placeholder}>
          {error ?? <Loading compact label={`Loading ${attachment.name}…`} />}
        </div>
      )}
      <figcaption className={styles.caption}>{attachment.name}</figcaption>
    </figure>
  )
}

export function decode(data: string): string {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function HtmlFile({ attachment }: { attachment: Attachment }) {
  const { data, error } = useBytes(attachment)
  return (
    <section className={styles.frame} aria-label={attachment.name}>
      <header className={styles.frameHead}>
        <span className={styles.frameName}>{attachment.name}</span>
        <span className={styles.meta}>HTML · sandboxed</span>
      </header>
      {data !== undefined ? (
        <iframe
          className={styles.html}
          title={attachment.name}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={decode(data)}
        />
      ) : (
        <div className={styles.placeholder}>
          {error ?? <Loading compact label={`Loading ${attachment.name}…`} />}
        </div>
      )}
    </section>
  )
}

export function CommentFiles({ files }: { files: readonly Attachment[] }) {
  const [open, setOpen] = useState<number>()
  const images = files.filter(showsInline)
  const pages = files.filter(isHtml)
  const others = files.filter((a) => !showsInline(a) && !isHtml(a))
  return (
    <div className={styles.files}>
      {images.length > 0 && (
        <div className={styles.images}>
          {images.map((a, index) => (
            <ImageFile key={`${a.hash}:${a.name}`} attachment={a} onOpen={() => setOpen(index)} />
          ))}
        </div>
      )}
      {open !== undefined && (
        <ImageViewer images={images} initialIndex={open} onClose={() => setOpen(undefined)} />
      )}
      {pages.map((a) => (
        <HtmlFile key={`${a.hash}:${a.name}`} attachment={a} />
      ))}
      {others.length > 0 && (
        <ul className={styles.others}>
          {others.map((a) => (
            <li key={`${a.hash}:${a.name}`} className={styles.chip}>
              {a.name}
              <span className={styles.meta}>{formatSize(a.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
