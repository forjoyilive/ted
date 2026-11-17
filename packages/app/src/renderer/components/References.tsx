import type { FailureCase, TaskCommit, TaskFileRef, TaskFiles } from '@ted/protocol'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useConnection } from '../data.ts'
import {
  failureTarget,
  fileIndex,
  kindLabel,
  type LabelledKind,
  type Reference,
  references,
} from '../references.ts'
import { ted } from '../ted.ts'
import styles from './References.module.css'

export type LinkKind = LabelledKind | 'task' | 'file' | 'tracker'

export interface Link {
  kind: LinkKind
  go(): void
}

export interface ReferenceLinks {
  open(reference: Reference): Link | undefined
  wantFiles(): void
}

export type TaskTarget = { task: string } | { url: string }

const Links = createContext<ReferenceLinks | undefined>(undefined)

export const useReferenceLinks = (): boolean => useContext(Links) !== undefined

const lookupBatch = 50

function useLookup<T>(
  scope: string,
  load: (ids: string[]) => Promise<T[]>,
  idOf: (item: T) => string,
): (id: string) => T | undefined {
  const [known, setKnown] = useState<{
    scope: string
    items: ReadonlyMap<string, T | null>
  }>({ scope, items: new Map() })
  const items = known.scope === scope ? known.items : undefined
  const asked = useRef({ scope, ids: new Set<string>(), waiting: new Set<string>() })
  if (asked.current.scope !== scope) {
    asked.current = { scope, ids: new Set(), waiting: new Set() }
  }
  const loader = useRef({ load, idOf })
  loader.current = { load, idOf }
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return (id) => {
    const found = items?.get(id)
    if (found !== undefined) return found ?? undefined
    const batch = asked.current
    if (batch.ids.has(id)) return undefined
    batch.ids.add(id)
    if (batch.waiting.size === 0) {
      window.setTimeout(() => {
        const ids = [...batch.waiting]
        batch.waiting.clear()
        if (!mounted.current || asked.current !== batch) {
          for (const one of ids) batch.ids.delete(one)
          return
        }
        for (let at = 0; at < ids.length; at += lookupBatch) {
          const part = ids.slice(at, at + lookupBatch)
          void loader.current.load(part).then(
            (result) => {
              if (asked.current !== batch) return
              setKnown((before) => {
                const next = new Map(before.scope === scope ? before.items : [])
                for (const one of part) next.set(one, null)
                for (const item of result) next.set(loader.current.idOf(item), item)
                return { scope, items: next }
              })
            },
            () => {
              for (const one of part) batch.ids.delete(one)
            },
          )
        }
      }, 50)
    }
    batch.waiting.add(id)
    return undefined
  }
}

function shortLink(
  id: string,
  failures: readonly FailureCase[],
  runs: readonly { id: string }[],
  onOpenFailure: (target: string) => void,
  onOpenRun: (runId: string) => void,
): Link | undefined {
  const failed = failures.filter((failure) => failure.id.startsWith(id))
  const ran = runs.filter((run) => run.id.startsWith(id))
  if (failed.length + ran.length !== 1) return undefined
  const [failure] = failed
  if (failure) {
    const target = failureTarget(failure)
    return target === undefined ? undefined : { kind: 'failure', go: () => onOpenFailure(target) }
  }
  const [run] = ran
  return run && { kind: 'run', go: () => onOpenRun(run.id) }
}

export function TaskReferences({
  taskId,
  files,
  onWantFiles,
  taskFor,
  failures,
  runs,
  onOpenTask,
  onOpenFile,
  onOpenCommit,
  onOpenFailure,
  onOpenRun,
  onOpenUrl,
  children,
}: {
  taskId: string
  files: TaskFiles | undefined
  onWantFiles: () => void
  taskFor: (id: string) => TaskTarget | 'tracker' | undefined
  failures: readonly FailureCase[]
  runs: readonly { id: string }[]
  onOpenTask: (displayId: string) => void
  onOpenFile: (file: TaskFileRef, line: number | undefined) => void
  onOpenCommit: (commit: TaskCommit) => void
  onOpenFailure: (target: string) => void
  onOpenRun: (runId: string) => void
  onOpenUrl: (url: string) => void
  children: ReactNode
}) {
  const { epoch } = useConnection()
  const commit = useLookup(
    `${taskId}\0${epoch}`,
    (ids) => ted.taskCommits(taskId, ids),
    (found) => found.id,
  )
  const issue = useLookup(
    `${epoch}`,
    (ids) => ted.linearIssueLinks(ids),
    (found) => found.identifier,
  )
  const file = useMemo(() => fileIndex(files), [files])
  const links: ReferenceLinks = {
    wantFiles: onWantFiles,
    open(reference) {
      if (reference.kind === 'task') {
        const target = taskFor(reference.id)
        if (target === 'tracker') {
          const found = issue(reference.id)
          return found && { kind: 'tracker', go: () => onOpenUrl(found.url) }
        }
        if (target === undefined) return undefined
        return 'task' in target
          ? { kind: 'task', go: () => onOpenTask(target.task) }
          : { kind: 'tracker', go: () => onOpenUrl(target.url) }
      }
      if (reference.kind === 'commit') {
        const found = commit(reference.id)
        return found && { kind: 'commit', go: () => onOpenCommit(found) }
      }
      if (reference.kind === 'short') {
        return shortLink(reference.id, failures, runs, onOpenFailure, onOpenRun)
      }
      const found = file(reference.path)
      return found && { kind: 'file', go: () => onOpenFile(found, reference.line) }
    },
  }
  return <Links.Provider value={links}>{children}</Links.Provider>
}

const titles: Record<LinkKind, string> = {
  commit: 'Show commit',
  failure: 'Show failure',
  run: 'Open Run',
  task: 'Open Task',
  file: 'Open file',
  tracker: 'Open in the tracker',
}

const labelled = (kind: LinkKind): kind is LabelledKind =>
  kind === 'commit' || kind === 'failure' || kind === 'run'

export function ReferenceLink({
  reference,
  before = '',
  children,
}: {
  reference: Reference
  before?: string | undefined
  children: ReactNode
}) {
  const links = useContext(Links)
  const wantFiles = reference.kind === 'file' ? links?.wantFiles : undefined
  useEffect(() => wantFiles?.(), [wantFiles])
  const link = links?.open(reference)
  if (!link) return <>{children}</>
  const name = reference.kind === 'file' ? reference.path : reference.id
  const label = labelled(link.kind) ? kindLabel(link.kind, before) : undefined
  return (
    <>
      {label !== undefined && `${label} `}
      <button
        type="button"
        className={styles.link}
        data-reference={link.kind}
        title={`${titles[link.kind]} ${name}`}
        onClick={link.go}
      >
        {children}
        {link.kind === 'tracker' && (
          <span className={styles.out} aria-hidden="true">
            ↗
          </span>
        )}
      </button>
    </>
  )
}

export function ReferenceText({ text }: { text: string }) {
  const linked = useReferenceLinks()
  const pieces = useMemo(() => (linked ? references(text) : undefined), [linked, text])
  if (!pieces) return <>{text}</>
  let at = 0
  let last = ''
  return pieces.map((piece) => {
    const key = at
    at += piece.text.length
    const before = last
    last = piece.text
    return piece.reference ? (
      <ReferenceLink key={key} reference={piece.reference} before={before}>
        {piece.text}
      </ReferenceLink>
    ) : (
      piece.text
    )
  })
}
