import type { TaskCommit, TaskFileRef, TaskFiles } from '@ted/protocol'
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
import { fileIndex, type Reference, references } from '../references.ts'
import { ted } from '../ted.ts'
import styles from './References.module.css'

export interface ReferenceLinks {
  open(reference: Reference): (() => void) | undefined
  wantFiles(): void
}

const Links = createContext<ReferenceLinks | undefined>(undefined)

export const useReferenceLinks = (): boolean => useContext(Links) !== undefined

const lookupBatch = 50

function useCommits(taskId: string): (id: string) => TaskCommit | undefined {
  const { epoch } = useConnection()
  const scope = `${taskId}\0${epoch}`
  const [known, setKnown] = useState<{
    scope: string
    commits: ReadonlyMap<string, TaskCommit | null>
  }>({ scope, commits: new Map() })
  const commits = known.scope === scope ? known.commits : undefined
  const asked = useRef({ scope, ids: new Set<string>(), waiting: new Set<string>() })
  if (asked.current.scope !== scope) {
    asked.current = { scope, ids: new Set(), waiting: new Set() }
  }
  return (id) => {
    const found = commits?.get(id)
    if (found !== undefined) return found ?? undefined
    const batch = asked.current
    if (batch.ids.has(id)) return undefined
    batch.ids.add(id)
    if (batch.waiting.size === 0) {
      window.setTimeout(() => {
        const ids = [...batch.waiting]
        batch.waiting.clear()
        for (let at = 0; at < ids.length; at += lookupBatch) {
          const part = ids.slice(at, at + lookupBatch)
          void ted.taskCommits(taskId, part).then(
            (result) => {
              if (asked.current !== batch) return
              setKnown((before) => {
                const next = new Map(before.scope === scope ? before.commits : [])
                for (const one of part) next.set(one, null)
                for (const commit of result) next.set(commit.id, commit)
                return { scope, commits: next }
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

export function TaskReferences({
  taskId,
  files,
  onWantFiles,
  hasTask,
  onOpenTask,
  onOpenFile,
  onOpenCommit,
  children,
}: {
  taskId: string
  files: TaskFiles | undefined
  onWantFiles: () => void
  hasTask: (displayId: string) => boolean
  onOpenTask: (displayId: string) => void
  onOpenFile: (file: TaskFileRef, line: number | undefined) => void
  onOpenCommit: (commit: TaskCommit) => void
  children: ReactNode
}) {
  const commit = useCommits(taskId)
  const file = useMemo(() => fileIndex(files), [files])
  const links: ReferenceLinks = {
    wantFiles: onWantFiles,
    open(reference) {
      if (reference.kind === 'task') {
        return hasTask(reference.id) ? () => onOpenTask(reference.id) : undefined
      }
      if (reference.kind === 'commit') {
        const found = commit(reference.id)
        return found && (() => onOpenCommit(found))
      }
      const found = file(reference.path)
      return found && (() => onOpenFile(found, reference.line))
    },
  }
  return <Links.Provider value={links}>{children}</Links.Provider>
}

const labels = { commit: 'Show commit', task: 'Open Task', file: 'Open file' } as const

export function ReferenceLink({
  reference,
  children,
}: {
  reference: Reference
  children: ReactNode
}) {
  const links = useContext(Links)
  const wantFiles = reference.kind === 'file' ? links?.wantFiles : undefined
  useEffect(() => wantFiles?.(), [wantFiles])
  const open = links?.open(reference)
  if (!open) return <>{children}</>
  const name = reference.kind === 'file' ? reference.path : reference.id
  return (
    <button
      type="button"
      className={styles.link}
      data-reference={reference.kind}
      title={`${labels[reference.kind]} ${name}`}
      onClick={open}
    >
      {children}
    </button>
  )
}

export function ReferenceText({ text }: { text: string }) {
  const linked = useReferenceLinks()
  const pieces = useMemo(() => (linked ? references(text) : undefined), [linked, text])
  if (!pieces) return <>{text}</>
  let at = 0
  return pieces.map((piece) => {
    const key = at
    at += piece.text.length
    return piece.reference ? (
      <ReferenceLink key={key} reference={piece.reference}>
        {piece.text}
      </ReferenceLink>
    ) : (
      piece.text
    )
  })
}
