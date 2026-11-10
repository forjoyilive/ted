import type { Attachment } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { formatSize } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import styles from './CommentFiles.module.css'
import { ImageViewer } from './Viewer.tsx'

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

export const showsInline = (a: Attachment) => imageTypes.has(a.mediaType)
export const isHtml = (a: Attachment) => a.mediaType === 'text/html'

export function useBytes({ hash, name }: Attachment): { data?: string; error?: string } {
  const [state, setState] = useState<{ data?: string; error?: string }>({})
  useEffect(() => {
    let current = true
    ted
      .readAttachment({ hash, name })
      .then(({ data }) => current && setState({ data }))
      .catch((failed: unknown) => current && setState({ error: readableError(failed) }))
    return () => {
      current = false
    }
  }, [hash, name])
  return state
}

function ImageFile({ attachment }: { attachment: Attachment }) {
  const { data, error } = useBytes(attachment)
  const [open, setOpen] = useState(false)
  const src = data === undefined ? undefined : `data:${attachment.mediaType};base64,${data}`
  return (
    <figure className={styles.image}>
      {src !== undefined ? (
        <button
          type="button"
          className={styles.thumbnail}
          aria-label={`View ${attachment.name}`}
          onClick={() => setOpen(true)}
        >
          <img src={src} alt={attachment.name} />
        </button>
      ) : (
        <div className={styles.placeholder}>{error ?? 'Loading…'}</div>
      )}
      <figcaption className={styles.caption}>{attachment.name}</figcaption>
      {open && src !== undefined && (
        <ImageViewer title={attachment.name} src={src} onClose={() => setOpen(false)} />
      )}
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
        <div className={styles.placeholder}>{error ?? 'Loading…'}</div>
      )}
    </section>
  )
}

export function CommentFiles({ files }: { files: readonly Attachment[] }) {
  const images = files.filter(showsInline)
  const pages = files.filter(isHtml)
  const others = files.filter((a) => !showsInline(a) && !isHtml(a))
  return (
    <div className={styles.files}>
      {images.length > 0 && (
        <div className={styles.images}>
          {images.map((a) => (
            <ImageFile key={`${a.hash}:${a.name}`} attachment={a} />
          ))}
        </div>
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
