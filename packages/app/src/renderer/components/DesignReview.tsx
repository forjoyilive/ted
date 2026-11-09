import type { Attachment, DesignFile, DesignReview, SetupProposal } from '@ted/protocol'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { stageName } from '../list-view.ts'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import { useBytes } from './CommentFiles.tsx'
import styles from './DesignReview.module.css'
import { CloseIcon } from './icons.tsx'

const prototypeSrc = ({ hash, name }: DesignFile) =>
  `ted-prototype://file/${hash}/${encodeURIComponent(name)}`

const label = (file: DesignFile) => file.caption ?? file.name

function mediaTypeOf(file: DesignFile, files: readonly Attachment[], fallback: string): string {
  return files.find((a) => a.hash === file.hash && a.name === file.name)?.mediaType ?? fallback
}

function Viewer({
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
    dialog.current?.showModal()
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

function ScreenshotTile({ file, files }: { file: DesignFile; files: readonly Attachment[] }) {
  const { data, error } = useBytes({ hash: file.hash, name: file.name, size: 0, mediaType: '' })
  const [open, setOpen] = useState(false)
  const src =
    data === undefined ? undefined : `data:${mediaTypeOf(file, files, 'image/png')};base64,${data}`
  return (
    <>
      <button
        type="button"
        className={styles.tile}
        aria-label={`View ${label(file)}`}
        onClick={() => setOpen(true)}
      >
        {src !== undefined ? (
          <img className={styles.shot} src={src} alt={label(file)} />
        ) : (
          <span className={styles.loading}>{error ?? 'Loading…'}</span>
        )}
        <span className={styles.tileCaption}>{label(file)}</span>
      </button>
      {open && src !== undefined && (
        <Viewer title={label(file)} wide onClose={() => setOpen(false)}>
          <img className={styles.fullImage} src={src} alt={label(file)} />
        </Viewer>
      )}
    </>
  )
}

function useBlobUrl(data: string | undefined, mediaType: string): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (data === undefined) return
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const made = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [data, mediaType])
  return url
}

function VideoPlayer({ file, files }: { file: DesignFile; files: readonly Attachment[] }) {
  const { data, error } = useBytes({ hash: file.hash, name: file.name, size: 0, mediaType: '' })
  const src = useBlobUrl(data, mediaTypeOf(file, files, 'video/mp4'))
  if (src === undefined) return <p className={styles.loading}>{error ?? 'Loading…'}</p>
  return (
    <video className={styles.video} src={src} controls autoPlay>
      <track kind="captions" />
    </video>
  )
}

function VideoTile({ file, files }: { file: DesignFile; files: readonly Attachment[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={`${styles.tile} ${styles.videoTile}`}
        aria-label={`Play ${label(file)}`}
        onClick={() => setOpen(true)}
      >
        <span className={styles.play} aria-hidden>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />
          </svg>
        </span>
        <span className={`${styles.tileCaption} ${styles.videoCaption}`}>{label(file)}</span>
      </button>
      {open && (
        <Viewer title={label(file)} wide onClose={() => setOpen(false)}>
          <VideoPlayer file={file} files={files} />
        </Viewer>
      )}
    </>
  )
}

function Prototype({ file }: { file: DesignFile }) {
  const [loads, setLoads] = useState(0)
  const [full, setFull] = useState(false)
  return (
    <section className={styles.prototype} aria-label="Prototype">
      <header className={styles.prototypeHead}>
        <span className={styles.prototypeLabel}>Prototype</span>
        <span className={styles.meta}>{`${file.name} · interactive · sandboxed`}</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.link} onClick={() => setLoads(loads + 1)}>
          Restart
        </button>
        <button type="button" className={styles.link} onClick={() => setFull(true)}>
          Open full size ↗
        </button>
      </header>
      <iframe
        key={loads}
        className={styles.frame}
        title={file.name}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={prototypeSrc(file)}
      />
      {full && (
        <Viewer title={file.name} wide onClose={() => setFull(false)}>
          <iframe
            className={styles.fullFrame}
            title={file.name}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={prototypeSrc(file)}
          />
        </Viewer>
      )}
    </section>
  )
}

function FigmaRow({
  figma,
  taskId,
  commentId,
}: {
  figma: NonNullable<DesignReview['figma']>
  taskId: string
  commentId: string
}) {
  const [error, setError] = useState<string>()
  const where = new URL(figma.url)
  return (
    <fieldset className={styles.figma} aria-label="Figma">
      <span className={styles.figmaMark} aria-hidden>
        F
      </span>
      <span className={styles.figmaText}>
        <span className={styles.figmaName}>Figma</span>
        <span className={styles.meta} title={figma.url}>
          {figma.label ?? `${where.hostname}${where.pathname}`}
        </span>
        {error !== undefined && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </span>
      <Button
        size="small"
        onClick={() =>
          ted.openFigmaLink(taskId, commentId).then(
            () => setError(undefined),
            (failed: unknown) => setError(readableError(failed)),
          )
        }
      >
        Open ↗
      </Button>
    </fieldset>
  )
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const rest = seconds % 60
  return `${Math.floor(seconds / 60)}m ${rest.toString().padStart(2, '0')}s`
}

function Result({ passed }: { passed: boolean }) {
  return passed ? (
    <span className={styles.passed} role="img" aria-label="Passed">
      ✓
    </span>
  ) : (
    <span className={styles.failedMark} role="img" aria-label="Failed">
      ✕
    </span>
  )
}

function SetupSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className={styles.setupSection} aria-label={label}>
      <h3 className={styles.setupHeading}>{label}</h3>
      {children}
    </section>
  )
}

function SetupProposalView({ setup }: { setup: SetupProposal }) {
  return (
    <>
      {setup.workflow.length > 0 && (
        <SetupSection label="Workflow">
          <dl className={styles.setupStages}>
            {setup.workflow.map((line) => (
              <div key={line.stage} className={styles.setupStage}>
                <dt>{stageName(line.stage)}</dt>
                <dd className={line.setting === undefined ? styles.asDefault : undefined}>
                  {line.setting ?? 'As TED’s default'}
                </dd>
              </div>
            ))}
          </dl>
        </SetupSection>
      )}
      {setup.checks.length > 0 && (
        <SetupSection label="Checks · tried on main">
          <ul className={styles.setupRows}>
            {setup.checks.map((check) => (
              <li key={check.name} className={styles.checkRow}>
                <Result passed={check.passed} />
                <span className={styles.setupName}>{check.name}</span>
                <code className={styles.command}>{check.command}</code>
                <span className={styles.meta}>{check.repo ?? ''}</span>
                {check.passed ? (
                  <span className={styles.meta}>{duration(check.durationMs)}</span>
                ) : (
                  <span className={styles.leftOff}>{`${check.reason ?? 'Failed'} · left off`}</span>
                )}
              </li>
            ))}
          </ul>
        </SetupSection>
      )}
      {setup.apps.length > 0 && (
        <SetupSection label="Apps · started on main">
          <ul className={styles.setupRows}>
            {setup.apps.map((app) => (
              <li key={app.name} className={styles.appRow}>
                <Result passed={app.passed} />
                <span className={styles.setupName}>{app.name}</span>
                <span className={styles.meta}>{app.repo ?? ''}</span>
                {app.passed ? (
                  <span className={styles.appReady}>{`${app.kind} · ${app.ready}`}</span>
                ) : (
                  <span
                    className={styles.leftOff}
                  >{`${app.reason ?? 'Didn’t start'} · left off`}</span>
                )}
              </li>
            ))}
          </ul>
        </SetupSection>
      )}
      <SetupSection label="Files it will write">
        <ul className={styles.setupRows}>
          {setup.files.map((file) => (
            <li key={file.path} className={styles.fileRow}>
              <code className={styles.filePath}>{file.path}</code>
              <span className={styles.fileAbout}>{file.about}</span>
            </li>
          ))}
        </ul>
      </SetupSection>
      {setup.defaults !== undefined && <p className={styles.defaults}>{setup.defaults}</p>}
    </>
  )
}

export function DesignReviewContent({
  design,
  files,
  taskId,
  commentId,
}: {
  design: DesignReview
  files: readonly Attachment[]
  taskId: string
  commentId: string
}) {
  const shots = design.screenshots ?? []
  return (
    <div className={styles.review}>
      {design.summary !== undefined && <p className={styles.summary}>{design.summary}</p>}
      {(shots.length > 0 || design.video) && (
        <div className={styles.tiles}>
          {shots.map((shot) => (
            <ScreenshotTile key={`${shot.hash}:${shot.name}`} file={shot} files={files} />
          ))}
          {design.video && <VideoTile file={design.video} files={files} />}
        </div>
      )}
      {design.setup && <SetupProposalView setup={design.setup} />}
      {design.prototype && <Prototype file={design.prototype} />}
      {design.figma && <FigmaRow figma={design.figma} taskId={taskId} commentId={commentId} />}
      {design.worthYourEye && design.worthYourEye.length > 0 && (
        <section className={styles.worth} aria-label="Worth your eye">
          <h3 className={styles.worthHeading}>Worth your eye</h3>
          <ol className={styles.worthList}>
            {design.worthYourEye.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
