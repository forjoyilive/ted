import type { Attachment } from '@ted/protocol'
import { useState } from 'react'
import { useBytes } from '../attachment-bytes.ts'
import { formatSize } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import styles from './CommentFiles.module.css'
import { Loading } from './Loading.tsx'
import { Markdown } from './Markdown.tsx'
import { ImageViewer, Viewer } from './Viewer.tsx'

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

export const showsInline = (a: Attachment) => imageTypes.has(a.mediaType)
export const isHtml = (a: Attachment) => a.mediaType === 'text/html'

function documentKind(a: Attachment): 'markdown' | 'text' | undefined {
  if (/\.(md|markdown)$/i.test(a.name) || a.mediaType === 'text/markdown') return 'markdown'
  if (a.mediaType.startsWith('text/') || /\.(txt|log|csv|json|ya?ml)$/i.test(a.name)) return 'text'
  return undefined
}

const folderLabel = navigator.userAgent.includes('Mac') ? 'Show in Finder' : 'Show in file manager'

function RevealFile({ attachment }: { attachment: Attachment }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <>
      <Button
        size="small"
        disabled={busy}
        aria-label={`${folderLabel}: ${attachment.name}`}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void ted.showAttachmentInFolder({ hash: attachment.hash, name: attachment.name }).then(
            () => setBusy(false),
            (failure: unknown) => {
              setBusy(false)
              setError(readableError(failure))
            },
          )
        }}
      >
        {busy ? 'Preparing file…' : folderLabel}
      </Button>
      {error !== undefined && <span role="alert">{error}</span>}
    </>
  )
}

function DocumentContent({ attachment }: { attachment: Attachment }) {
  const { data, error } = useBytes(attachment)
  if (error !== undefined) return <p role="alert">{error}</p>
  if (data === undefined) return <Loading label={`Loading ${attachment.name}…`} />
  if (data.length > Math.ceil((1024 * 1024) / 3) * 4) {
    return <p>This file is too large to preview. Use the file manager to read it.</p>
  }
  let text: string
  try {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
    if (bytes.length > 1024 * 1024) {
      return <p>This file is too large to preview. Use the file manager to read it.</p>
    }
    if (bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
      throw new Error('Binary content')
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return <p>This file cannot be previewed as text. Use the file manager to read it.</p>
  }
  if (text === '') return <p>This file is empty.</p>
  return documentKind(attachment) === 'markdown' ? (
    <Markdown text={text} />
  ) : (
    <pre className={styles.text}>{text}</pre>
  )
}

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
  const [document, setDocument] = useState<Attachment>()
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
      {document !== undefined && (
        <Viewer
          title={document.name}
          onClose={() => setDocument(undefined)}
          controls={<RevealFile attachment={document} />}
        >
          <div className={styles.document}>
            <DocumentContent key={`${document.hash}:${document.name}`} attachment={document} />
          </div>
        </Viewer>
      )}
      {others.length > 0 && (
        <ul className={styles.others}>
          {others.map((a) => (
            <li key={`${a.hash}:${a.name}`} className={styles.chip}>
              {a.name}
              <span className={styles.meta}>{formatSize(a.size)}</span>
              {documentKind(a) !== undefined ? (
                <Button
                  size="small"
                  aria-label={`Preview ${a.name}`}
                  onClick={() => setDocument(a)}
                >
                  Preview
                </Button>
              ) : (
                <RevealFile attachment={a} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
